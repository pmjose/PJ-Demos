#!/usr/bin/env node
// Projects the demo catalog from data/*.json into TEMP.PJOSE.CATALOG_DEMOS, which is
// what the Cortex Search service indexes — search services read tables and views, not
// files.
//
// The JSON files remain the source of truth. This table is a rebuildable projection,
// so the Streamlit app keeps working unchanged if it is missing or stale; only
// semantic search depends on it.
//
//   node scripts/load-demos.mjs
//   node scripts/load-demos.mjs --dry-run   # print the row count and first row, no writes

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const CONNECTION = 'Snowhouse';
const TABLE = 'TEMP.PJOSE.CATALOG_DEMOS';
// Rows per INSERT. Whole-file single statements risk one bad row losing everything.
const BATCH = 20;

const EXCLUDED = new Set([
  'PJ', 'xoople', 'TELCO-REVENUE', 'test', 'SnowImpact_backup',
  'CMU-AI', 'snowflake', 'Snowtch', 'Flurry',
]);

const dollar = (s) =>
  s === null || s === undefined || s === ''
    ? 'NULL'
    : `$$${String(s).replaceAll('$$', '  ')}$$`;

function runSql(sql) {
  return execFileSync(
    'snow',
    [
      'sql', '--connection', CONNECTION, '--format', 'JSON', '--stdin',
      // `&` and `{{ }}` in demo text are otherwise read as the CLI's own variable
      // syntax and the statement dies with a bare "SQL rendering error".
      '--enable-templating', 'NONE',
    ],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
}

/**
 * `snow sql` emits one JSON array per statement; only the last one is wanted.
 */
function lastResultSet(stdout) {
  const start = stdout.indexOf('[');
  if (start < 0) throw new Error(`no JSON in output: ${stdout.slice(0, 200)}`);
  const parsed = JSON.parse(stdout.slice(start));
  const sets = Array.isArray(parsed[0]) ? parsed : [parsed];
  return sets[sets.length - 1];
}

/**
 * The single column the service indexes. Everything a person might describe the demo
 * with goes in, including the inferred search terms, so semantic and keyword retrieval
 * draw on the same text.
 */
function searchBody(repo, facet, tech, terms, detail) {
  const b = detail?.business || {};
  return [
    repo.headline || repo.name,
    repo.name,
    facet.industry,
    facet.market,
    repo.audience,
    (facet.personas || []).join(', '),
    (facet.alsoFor || []).join(', '),
    (facet.useCases || []).join(', '),
    (tech || []).join(', '),
    b.business_problem,
    b.solution,
    (b.key_capabilities || []).join('. '),
    (b.business_value || []).join('. '),
    (terms || []).join(', '),
  ]
    .filter(Boolean)
    .join('\n');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const index = JSON.parse(await readFile('data/repos.json', 'utf8'));
  const [facets, tech, terms, dupes] = await Promise.all(
    ['facets', 'tech', 'search-terms', 'duplicates'].map((name) =>
      readFile(`data/${name}.json`, 'utf8').then(JSON.parse).catch(() => ({}))
    )
  );

  const repos = index.repos.filter((r) => !r.isFork && !EXCLUDED.has(r.name));
  const rows = [];
  for (const repo of repos) {
    const facet = facets[repo.name] || {};
    const detail = await readFile(`data/repos/${repo.name}.json`, 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    rows.push({
      NAME: repo.name,
      HEADLINE: repo.headline || repo.name,
      INDUSTRY: facet.industry || null,
      MARKET: facet.market || null,
      AUDIENCE: repo.audience || null,
      PERSONAS: [...(facet.personas || []), ...(facet.alsoFor || [])].join(', ') || null,
      USE_CASES: (facet.useCases || []).join(', ') || null,
      FEATURES: (tech[repo.name] || []).join(', ') || null,
      HAS_PAGE: repo.hasPage ? 'true' : 'false',
      PUSHED_AT: repo.pushedAt || null,
      SUPERSEDED_BY: dupes[repo.name]?.supersededBy || null,
      SEARCH_BODY: searchBody(repo, facet, tech[repo.name], terms[repo.name], detail),
    });
  }

  console.log(`Prepared ${rows.length} demo rows.`);
  if (dryRun) {
    console.log(JSON.stringify(rows[0], null, 2).slice(0, 1200));
    return;
  }

  // HAS_PAGE is text, not boolean: Cortex Search ATTRIBUTES columns must be
  // filterable scalars, and text equality filters are the reliable path.
  const ddl = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  NAME          STRING NOT NULL,
  HEADLINE      STRING,
  INDUSTRY      STRING,
  MARKET        STRING,
  AUDIENCE      STRING,
  PERSONAS      STRING,
  USE_CASES     STRING,
  FEATURES      STRING,
  HAS_PAGE      STRING,
  PUSHED_AT     STRING,
  SUPERSEDED_BY STRING,
  SEARCH_BODY   STRING
)
COMMENT = 'Projection of data/*.json, indexed by the CATALOG_SEARCH Cortex Search service. Rebuilt by scripts/load-demos.mjs; the JSON files are the source of truth.';`;

  const cols = Object.keys(rows[0]);
  const statements = [ddl, `TRUNCATE TABLE ${TABLE};`];
  for (let i = 0; i < rows.length; i += BATCH) {
    const values = rows
      .slice(i, i + BATCH)
      .map((r) => `(${cols.map((c) => dollar(r[c])).join(', ')})`)
      .join(',\n  ');
    statements.push(
      `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES\n  ${values};`
    );
  }

  try {
    runSql(statements.join('\n'));
  } catch (err) {
    const why = String(err.stderr || err.message)
      .split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 5).join(' | ');
    console.error(`Load failed: ${why}`);
    process.exit(1);
  }

  const summary = lastResultSet(
    runSql(
      `SELECT COUNT(*) AS N,
              COUNT(SUPERSEDED_BY) AS SUPERSEDED,
              ROUND(AVG(LENGTH(SEARCH_BODY))) AS AVG_BODY,
              SUM(IFF(HAS_PAGE = 'true', 1, 0)) AS LIVE
       FROM ${TABLE};`
    )
  )[0];
  console.log(
    `Loaded ${summary.N} rows into ${TABLE} ` +
    `(${summary.LIVE} live, ${summary.SUPERSEDED} superseded, ` +
    `avg indexed text ${summary.AVG_BODY} chars)`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
