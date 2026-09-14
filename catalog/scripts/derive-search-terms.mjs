#!/usr/bin/env node
// Generates alternative phrasings per demo and writes data/search-terms.json, so
// the catalog's keyword search answers questions phrased in the reader's words
// rather than the demo's. Search ANDs every term against one haystack, so
// "churn european fibre" currently returns nothing unless all three words appear
// verbatim — this supplies the words that are implied but never written.
//
// The AI runs here, offline, not in the app. DASHBOARD_SHARING_RL owns the
// deployed Streamlit and cannot call AI functions at all, so anything at runtime
// would fail; baking the result into a JSON artifact also keeps the GitHub Pages
// front-end at parity, since it has no Snowflake connection either.
//
//   node scripts/derive-search-terms.mjs                 # every in-catalog demo
//   node scripts/derive-search-terms.mjs TeliaNO BT-NOC  # just these
//   node scripts/derive-search-terms.mjs --force          # re-do ones already done

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const CONNECTION = 'Snowhouse';
// The app's owner role has no AI access; these do. Nothing at runtime depends on
// this choice — the only output is a file.
const ROLE = 'SALES_ENGINEER';
const WAREHOUSE = 'SE_DASHBOARD_BIG_WH';
const MODEL = 'llama3.1-70b';
// Batched into one statement per chunk: 91 separate `snow sql` calls spend most of
// their time on CLI startup. Small enough that one malformed row can't cost much.
const BATCH = 12;
const MAX_TERMS = 20;
const MAX_TERM_WORDS = 3;

const EXCLUDED = new Set([
  'PJ', 'xoople', 'TELCO-REVENUE', 'test', 'SnowImpact_backup',
  'CMU-AI', 'snowflake', 'Snowtch', 'Flurry',
]);

const PROMPT = `You are building a search index for an internal demo catalog.
For the demo described below, list the words and short phrases someone would
plausibly type when hunting for it, concentrating on ones NOT already present in
its own text. Cover:
- geography implied by the market (continent, region, adjectives: european, nordic, latam, apac)
- industry and technology synonyms and both spellings (fibre/fiber, telco/telecom/carrier/operator, mobile/wireless)
- business outcome synonyms (churn/attrition/retention, upsell/cross-sell, opex/cost)
- the job titles likely to care

Rules: reply with ONE line only. Lowercase, comma-separated. No numbering, no
preamble, no explanation, no trailing full stop. At most ${MAX_TERMS} items. Each
item one to three words.

DEMO:
`;

/** Dollar-quoted so quotes and newlines in demo text need no escaping. */
const dollar = (s) => `$$${String(s ?? '').replaceAll('$$', '  ')}$$`;

function describe(repo, facet, features, detail) {
  const b = detail?.business || {};
  const parts = [
    `name: ${repo.name}`,
    repo.headline && `headline: ${repo.headline}`,
    facet.industry && `industry: ${facet.industry}`,
    facet.market && `market: ${facet.market}`,
    repo.audience && `audience: ${repo.audience}`,
    facet.personas?.length && `personas: ${facet.personas.join(', ')}`,
    facet.useCases?.length && `use cases: ${facet.useCases.join(', ')}`,
    features?.length && `snowflake capabilities: ${features.join(', ')}`,
    b.business_problem && `problem: ${String(b.business_problem).slice(0, 600)}`,
    b.solution && `solution: ${String(b.solution).slice(0, 600)}`,
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * Models like to prefix a list with "Here are the terms:". Anything before the
 * first comma that looks like a lead-in is dropped, then each item is validated
 * rather than trusted.
 */
function parseTerms(raw, name) {
  let line = String(raw ?? '')
    .replace(/```/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort((a, b) => b.split(',').length - a.split(',').length)[0] || '';

  const head = line.split(',')[0];
  if (head && head.includes(':')) line = line.slice(line.indexOf(':') + 1);

  const seen = new Set();
  const terms = [];
  for (const piece of line.split(',')) {
    const term = piece
      .trim()
      .toLowerCase()
      // A list marker, not a stray digit: a blanket \d strip turns "5g" into "g".
      .replace(/^(?:[-*\u2022]|\d+[.)])\s+/, '')
      .replace(/^["'`\s]+/, '')
      .replace(/["'`.\s]+$/, '')
      .trim();
    if (!term || term.length < 3 || term.length > 34) continue;
    // Prose, not a search term.
    if (term.split(/\s+/).length > MAX_TERM_WORDS) continue;
    if (/[:;()[\]{}<>|\\/]/.test(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  if (!terms.length) console.error(`  ${name} — no usable terms parsed`);
  return terms;
}

function runSql(sql) {
  return execFileSync(
    'snow',
    [
      'sql', '--connection', CONNECTION, '--format', 'JSON', '--stdin',
      // Without this the CLI treats `&` and `{{ }}` in the demo text as its own
      // variable syntax and fails with "SQL rendering error" — every headline
      // containing "Data & AI" broke the batch.
      '--enable-templating', 'NONE',
    ],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
}

/** `snow sql` emits one JSON array per statement; we only want the last one's rows. */
function lastResultSet(stdout) {
  const start = stdout.indexOf('[');
  if (start < 0) throw new Error(`no JSON in output: ${stdout.slice(0, 200)}`);
  const parsed = JSON.parse(stdout.slice(start));
  const sets = Array.isArray(parsed[0]) ? parsed : [parsed];
  return sets[sets.length - 1];
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const names = args.filter((a) => !a.startsWith('--'));

  const index = JSON.parse(await readFile('data/repos.json', 'utf8'));
  const facets = await readFile('data/facets.json', 'utf8').then(JSON.parse).catch(() => ({}));
  const tech = await readFile('data/tech.json', 'utf8').then(JSON.parse).catch(() => ({}));
  const existing = await readFile('data/search-terms.json', 'utf8')
    .then(JSON.parse)
    .catch(() => ({}));

  let targets = index.repos.filter((r) => !r.isFork && !EXCLUDED.has(r.name));
  if (names.length) targets = targets.filter((r) => names.includes(r.name));
  if (!force && !names.length) targets = targets.filter((r) => !existing[r.name]?.length);

  if (!targets.length) {
    console.log('Nothing to do. Pass --force to regenerate, or name specific demos.');
    return;
  }
  console.log(`Generating search terms for ${targets.length} demos on ${MODEL}…`);

  const out = {};
  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const rows = [];
    for (const repo of chunk) {
      const detail = await readFile(`data/repos/${repo.name}.json`, 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      const body = describe(repo, facets[repo.name] || {}, tech[repo.name], detail);
      rows.push(`(${dollar(repo.name)}, ${dollar(PROMPT + body)})`);
    }

    const sql = [
      `USE ROLE ${ROLE};`,
      `USE WAREHOUSE ${WAREHOUSE};`,
      `SELECT column1 AS name, AI_COMPLETE('${MODEL}', column2) AS terms`,
      `FROM VALUES\n${rows.join(',\n')};`,
    ].join('\n');

    let results;
    try {
      results = lastResultSet(runSql(sql));
    } catch (err) {
      // execFileSync's message is just the command line; the reason is on stderr.
      const why = String(err.stderr || err.stdout || err.message)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 4)
        .join(' | ');
      console.error(`  batch ${i / BATCH + 1} (${chunk.map((r) => r.name).join(', ')}) failed`);
      console.error(`    ${why}`);
      continue;
    }

    for (const row of results) {
      const name = row.NAME ?? row.name;
      const terms = parseTerms(row.TERMS ?? row.terms, name);
      out[name] = terms;
      console.log(`  ${name} — ${terms.length} terms: ${terms.slice(0, 6).join(', ')}…`);
    }
  }

  // Always merge, so a filtered run never drops other demos' results.
  const merged = { ...existing, ...out };
  const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
  await writeFile('data/search-terms.json', JSON.stringify(sorted, null, 2) + '\n');

  const counts = Object.values(sorted).map((v) => v.length);
  console.log(`\nWrote ${counts.length} entries to data/search-terms.json`);
  console.log(
    `  ${counts.reduce((a, b) => a + b, 0)} terms total, ` +
    `median ${counts.slice().sort((a, b) => a - b)[Math.floor(counts.length / 2)]} per demo`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
