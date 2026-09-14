#!/usr/bin/env node
// Finds the demos that duplicate each other and writes data/duplicates.json, so a
// reader lands on the current version of a demo rather than a 2024 draft of it.
//
// Two tiers, deliberately kept apart because they justify very different claims:
//
//   supersededBy — the names normalise to the same thing once version markers are
//     stripped ("MWC_Prodapt", "MWC_Prodapt-2026", "MWC_Prodapt-2026-v2"). String
//     evidence, no inference, so it is safe to state outright.
//   related — high embedding similarity between demos whose names differ. This is
//     a suggestion, not a fact: "MiFibra" and "MiFibra-Churn" are close in wording
//     but are genuinely different demos, so nothing here is ever called superseded.
//
// Nothing is auto-hidden. Clustering will have false positives, and wrongly hiding
// a demo is far worse than showing a note that a reader can ignore.
//
//   node scripts/derive-duplicates.mjs
//   node scripts/derive-duplicates.mjs --explain   # show the full similarity ranking

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const CONNECTION = 'Snowhouse';
const ROLE = 'SALES_ENGINEER';
const WAREHOUSE = 'SE_DASHBOARD_BIG_WH';
const EMBED_MODEL = 'snowflake-arctic-embed-m-v1.5';
const BATCH = 12;

// Tuned against the ranked pair list. Embedding similarity alone is a poor signal
// here: every telco C360 demo scores ~0.80 against every other, which the industry
// and use-case facets already say better. What actually marks a real relative is a
// shared *customer* in the name, so a distinctive shared token is required too and
// the cosine only has to clear a floor.
const RELATED_MIN = 0.78;
// A token in more than this many names is a topic ("c360", "vision"), not a brand.
const DISTINCTIVE_MAX = 2;
// Extra characters allowed when one name is a prefix of another, which catches the
// language variants (SnowCover / SnowCoverES) without pulling in MiFibra / MiFibra-Churn.
const SUFFIX_MAX = 3;
const MAX_RELATED = 3;

const EXCLUDED = new Set([
  'PJ', 'xoople', 'TELCO-REVENUE', 'test', 'SnowImpact_backup',
  'CMU-AI', 'snowflake', 'Snowtch', 'Flurry',
]);

const dollar = (s) => `$$${String(s ?? '').replaceAll('$$', '  ')}$$`;

/**
 * Collapse a name to its identity, ignoring version noise. Markers are stripped
 * repeatedly so "-2026-v2" reduces the same way "-v2" does.
 */
function normName(name) {
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let prev;
  do {
    prev = s;
    s = s.replace(/-(?:v\d+|20\d{2}|copy|backup|old|new|final|draft)$/, '');
  } while (s !== prev);
  return s.replace(/-/g, '');
}

function describe(repo, facet, detail) {
  const b = detail?.business || {};
  return [
    repo.headline || repo.name,
    facet.industry,
    facet.market,
    repo.audience,
    (facet.useCases || []).join(', '),
    String(b.business_problem || '').slice(0, 700),
    String(b.solution || '').slice(0, 700),
  ]
    .filter(Boolean)
    .join('\n');
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const tokens = (name) =>
  name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

/**
 * Whether two demos look like the same subject, and how strong that evidence is.
 * `name` needs no corroboration: one title being the other plus "es" is decisive on
 * its own. `token` is weaker — a shared word could be coincidence — so it is the
 * only tier that has to clear the similarity floor.
 */
function sameSubject(a, b, tokenFreq) {
  const [x, y] = [normName(a), normName(b)].sort((p, q) => p.length - q.length);
  if (y !== x && y.startsWith(x) && y.length - x.length <= SUFFIX_MAX) {
    return { kind: 'name', why: `${x} + "${y.slice(x.length)}"` };
  }

  const shared = tokens(a).filter(
    (t) => tokens(b).includes(t) && (tokenFreq.get(t) || 0) <= DISTINCTIVE_MAX
  );
  if (shared.length) return { kind: 'token', why: shared.join(', ') };

  return null;
}

function runSql(sql) {
  return execFileSync(
    'snow',
    [
      'sql', '--connection', CONNECTION, '--format', 'JSON', '--stdin',
      // `&` and `{{ }}` in demo text are otherwise read as the CLI's own variable
      // syntax and the statement dies with "SQL rendering error".
      '--enable-templating', 'NONE',
    ],
    { input: sql, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
}

function lastResultSet(stdout) {
  const start = stdout.indexOf('[');
  if (start < 0) throw new Error(`no JSON in output: ${stdout.slice(0, 200)}`);
  const parsed = JSON.parse(stdout.slice(start));
  const sets = Array.isArray(parsed[0]) ? parsed : [parsed];
  return sets[sets.length - 1];
}

async function main() {
  const explain = process.argv.includes('--explain');

  const index = JSON.parse(await readFile('data/repos.json', 'utf8'));
  const facets = await readFile('data/facets.json', 'utf8').then(JSON.parse).catch(() => ({}));
  const repos = index.repos.filter((r) => !r.isFork && !EXCLUDED.has(r.name));

  // ---- Tier 1: name families, no AI involved -------------------------------
  const families = new Map();
  for (const repo of repos) {
    const key = normName(repo.name);
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(repo);
  }

  const out = {};
  let supersededCount = 0;
  for (const [, members] of families) {
    if (members.length < 2) continue;
    // Newest push wins. Ties broken on name length so the more specific name is
    // treated as the later one.
    const ordered = [...members].sort(
      (a, b) =>
        new Date(b.pushedAt || 0) - new Date(a.pushedAt || 0) ||
        b.name.length - a.name.length
    );
    const current = ordered[0];
    for (const older of ordered.slice(1)) {
      out[older.name] = { ...(out[older.name] || {}), supersededBy: current.name };
      supersededCount++;
    }
    console.log(
      `  family ${members.map((m) => m.name).join(' , ')}  →  current: ${current.name}`
    );
  }
  console.log(`\n${supersededCount} demos superseded across ${
    [...families.values()].filter((m) => m.length > 1).length
  } name families`);

  // ---- Tier 2: embedding neighbours ---------------------------------------
  console.log(`\nEmbedding ${repos.length} demos on ${EMBED_MODEL}…`);
  const vectors = new Map();
  for (let i = 0; i < repos.length; i += BATCH) {
    const chunk = repos.slice(i, i + BATCH);
    const rows = [];
    for (const repo of chunk) {
      const detail = await readFile(`data/repos/${repo.name}.json`, 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      rows.push(
        `(${dollar(repo.name)}, ${dollar(describe(repo, facets[repo.name] || {}, detail))})`
      );
    }
    const sql = [
      `USE ROLE ${ROLE};`,
      `USE WAREHOUSE ${WAREHOUSE};`,
      `SELECT column1 AS name,`,
      `       AI_EMBED('${EMBED_MODEL}', column2)::ARRAY AS vec`,
      `FROM VALUES\n${rows.join(',\n')};`,
    ].join('\n');

    try {
      for (const row of lastResultSet(runSql(sql))) {
        const vec = typeof row.VEC === 'string' ? JSON.parse(row.VEC) : row.VEC;
        vectors.set(row.NAME ?? row.name, vec.map(Number));
      }
    } catch (err) {
      const why = String(err.stderr || err.message).split('\n').map((l) => l.trim())
        .filter(Boolean).slice(0, 3).join(' | ');
      console.error(`  batch ${i / BATCH + 1} failed: ${why}`);
    }
    process.stdout.write(`  ${vectors.size}/${repos.length}\r`);
  }
  console.log(`  embedded ${vectors.size}/${repos.length}`);

  const names = [...vectors.keys()];
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      pairs.push([names[i], names[j], cosine(vectors.get(names[i]), vectors.get(names[j]))]);
    }
  }
  pairs.sort((a, b) => b[2] - a[2]);

  if (explain) {
    console.log('\nTop 30 pairs by similarity:');
    for (const [a, b, s] of pairs.slice(0, 30)) {
      const same = normName(a) === normName(b) ? '  [same name family]' : '';
      console.log(`  ${s.toFixed(4)}  ${a}  ~  ${b}${same}`);
    }
  }

  const relatedCount = new Map();
  const tokenFreq = new Map();
  for (const repo of repos) {
    for (const t of new Set(tokens(repo.name))) {
      tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
    }
  }

  for (const [a, b, score] of pairs) {
    // A name family is already stated as supersession; repeating it as "related"
    // would be noise.
    if (normName(a) === normName(b)) continue;
    const match = sameSubject(a, b, tokenFreq);
    if (!match) continue;
    // Only the weaker token evidence needs the similarity floor.
    if (match.kind === 'token' && score < RELATED_MIN) continue;
    if (explain) {
      console.log(
        `  related ${score.toFixed(4)}  ${a} ~ ${b}  (${match.kind}: ${match.why})`
      );
    }
    for (const [x, y] of [[a, b], [b, a]]) {
      if ((relatedCount.get(x) || 0) >= MAX_RELATED) continue;
      out[x] = out[x] || {};
      out[x].related = out[x].related || [];
      out[x].related.push({ name: y, similarity: Number(score.toFixed(4)) });
      relatedCount.set(x, (relatedCount.get(x) || 0) + 1);
    }
  }

  const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  await writeFile('data/duplicates.json', JSON.stringify(sorted, null, 2) + '\n');

  const withRelated = Object.values(sorted).filter((v) => v.related?.length).length;
  console.log(`\nWrote ${Object.keys(sorted).length} entries to data/duplicates.json`);
  console.log(`  ${supersededCount} superseded, ${withRelated} with related demos`);
  console.log(
    `  related via a name prefix (any similarity) or a shared distinctive ` +
    `token with cosine >= ${RELATED_MIN}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
