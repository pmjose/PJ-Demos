#!/usr/bin/env node
// Detects which Snowflake capabilities each demo actually uses and writes
// data/tech.json. The business summaries barely mention implementation (Cortex
// Analyst appeared in 3 of 91, Snowpark in 1), so this reads the repos themselves:
// the file tree, the README, and a bounded sample of SQL/Python files.
//
//   node scripts/derive-tech.mjs                 # all in-catalog demos
//   node scripts/derive-tech.mjs TeliaNO BT-NOC  # just these

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const CONCURRENCY = 4;
// Files opened per repo beyond the README. Enough to catch a setup script without
// pulling a whole demo.
const MAX_FILES = 8;
const MAX_BYTES = 400_000;

const VENDOR = /(?:^|\/)(?:node_modules|dist|build|out|\.next|vendor|coverage|\.git)\//;
// Agent scratch directories describe intent, not what was built — a plan file that
// mentions Snowpipe is not evidence the demo uses Snowpipe.
const SCRATCH = /(?:^|\/)(?:\.snowflake|\.claude|\.cortex|\.github)\//;
// Code and config only. Markdown is excluded deliberately: a README claim is not
// proof, and mixing the two produced confident-looking but unfounded detections.
const INTERESTING = /\.(sql|py|ipynb|ya?ml|toml|tsx?|jsx?)$/i;
const PRIORITY = /(setup|install|deploy|create|schema|seed|cortex|semantic|agent|snowflake|pipeline|dbt)/i;

// Detection is deliberately object-level: `CREATE SEMANTIC VIEW` is proof, whereas
// the words "semantic view" in prose are a claim. Markers are checked against file
// contents and the README; PATHS are checked against the file tree alone.
const FEATURES = [
  {
    name: 'Snowflake Intelligence & agents',
    markers: [/create\s+(or\s+replace\s+)?agent/i, /cortex[_\s]agent/i, /snowflake intelligence/i,
              /\/api\/v2\/(databases\/[^/]+\/schemas\/[^/]+\/)?agents/i],
  },
  {
    name: 'Cortex Analyst',
    markers: [/cortex[_\s]?analyst/i, /semantic_model_file/i, /\/api\/v2\/cortex\/analyst/i],
  },
  {
    name: 'Cortex Search',
    markers: [/create\s+(or\s+replace\s+)?cortex\s+search\s+service/i, /cortex[_\s]search/i],
  },
  {
    name: 'Cortex AI functions',
    markers: [/snowflake\.cortex\./i, /\bai_(complete|classify|extract|sentiment|agg|filter|summarize)\s*\(/i,
              /cortex\.(complete|sentiment|summarize|translate|extract_answer)\s*\(/i],
  },
  {
    name: 'Semantic views',
    markers: [/create\s+(or\s+replace\s+)?semantic\s+view/i, /semantic_view/i],
    paths: [/semantic[-_]?(model|view)s?.*\.ya?ml$/i],
  },
  {
    name: 'Streamlit in Snowflake',
    markers: [/create\s+(or\s+replace\s+)?streamlit/i, /^\s*import\s+streamlit/im,
              /st\.(connection|dataframe|sidebar)\s*\(/],
    paths: [/(^|\/)streamlit_app\.py$/i, /(^|\/)\.streamlit\//i],
  },
  {
    name: 'Native Apps',
    markers: [/create\s+application\s+package/i, /create\s+application\b/i],
    paths: [/(^|\/)manifest\.ya?ml$/i],
  },
  {
    name: 'Dynamic tables',
    markers: [/create\s+(or\s+replace\s+)?dynamic\s+table/i],
  },
  {
    name: 'Snowpark',
    markers: [/snowflake\.snowpark/i, /snowpark[-_]python/i],
  },
  {
    name: 'Snowflake ML & forecasting',
    markers: [/snowflake\.ml\./i, /snowflake[-_]ml[-_]python/i,
              /\b(forecast|anomaly_detection|classification)\s*\(\s*input_data/i,
              /create\s+(or\s+replace\s+)?snowflake\.ml\./i],
  },
  {
    name: 'Data sharing & listings',
    markers: [/create\s+(or\s+replace\s+)?share\b/i, /create\s+(or\s+replace\s+)?listing/i,
              /grant\s+.*\s+to\s+share/i, /organization\s+listing/i],
  },
  {
    name: 'Iceberg tables',
    markers: [/iceberg\s+table/i, /catalog_integration/i, /external_volume/i],
  },
  {
    name: 'Streams & tasks',
    markers: [/create\s+(or\s+replace\s+)?task\b/i, /create\s+(or\s+replace\s+)?stream\b/i,
              /system\$stream_has_data/i],
  },
  {
    name: 'Snowpipe & streaming',
    markers: [/create\s+(or\s+replace\s+)?pipe\b/i, /snowpipe/i, /auto_ingest/i],
  },
];

const TOKEN =
  process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();

const gh = (url) =>
  fetch(url, {
    headers: {
      authorization: `bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'pj-project-catalog',
    },
  });

async function tree(nameWithOwner) {
  const res = await gh(`https://api.github.com/repos/${nameWithOwner}/git/trees/HEAD?recursive=1`);
  if (!res.ok) return [];
  const body = await res.json();
  return (body.tree ?? []).filter(
    (e) => e.type === 'blob' && !VENDOR.test(e.path) && !SCRATCH.test(e.path)
  );
}

async function getFile(nameWithOwner, path) {
  const res = await gh(
    `https://api.github.com/repos/${nameWithOwner}/contents/${encodeURI(path)}`
  );
  if (!res.ok) return null;
  const body = await res.json();
  if (!body.content || body.size > MAX_BYTES) return null;
  return Buffer.from(body.content, 'base64').toString('utf8');
}

async function detect(repo) {
  const owner = repo.nameWithOwner;
  const blobs = await tree(owner);
  const paths = blobs.map((b) => b.path);

  // name -> { source, excerpt } so every detection can be audited with --explain.
  const found = new Map();

  // Filenames alone settle some features and cost nothing extra.
  for (const feature of FEATURES) {
    const hit = feature.paths && paths.find((p) => feature.paths.some((re) => re.test(p)));
    if (hit) found.set(feature.name, { source: hit, excerpt: 'matched by filename' });
  }

  // Read the README plus the most promising source files.
  const candidates = blobs
    .filter((b) => INTERESTING.test(b.path))
    .sort((a, b) => {
      const pa = PRIORITY.test(a.path) ? 0 : 1;
      const pb = PRIORITY.test(b.path) ? 0 : 1;
      // Prefer likely-relevant files, then larger ones (more object definitions).
      return pa - pb || (b.size ?? 0) - (a.size ?? 0);
    })
    .slice(0, MAX_FILES)
    .map((b) => b.path);

  const sources = [];
  for (const path of candidates) {
    const text = await getFile(owner, path);
    if (text) sources.push([path, text]);
  }

  for (const feature of FEATURES) {
    if (found.has(feature.name)) continue;
    for (const [source, text] of sources) {
      const marker = feature.markers.find((re) => re.test(text));
      if (marker) {
        const m = text.match(marker);
        found.set(feature.name, {
          source,
          excerpt: m ? m[0].replace(/\s+/g, ' ').slice(0, 60) : '',
        });
        break;
      }
    }
  }

  return found;
}

async function main() {
  const { repos } = JSON.parse(await readFile('data/repos.json', 'utf8'));

  const args = process.argv.slice(2);
  const explain = args.includes('--explain');
  const only = args.filter((a) => !a.startsWith('--'));
  const targets = only.length
    ? repos.filter((r) => only.includes(r.name))
    : repos.filter((r) => !r.isFork);

  console.log(`Scanning ${targets.length} repos for Snowflake capabilities...`);

  const out = {};
  let i = 0;
  let done = 0;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < targets.length) {
        const repo = targets[i++];
        let found = new Map();
        try {
          found = await detect(repo);
        } catch (err) {
          console.error(`  ${repo.name} — ${err.message.split('\n')[0]}`);
        }
        const features = [...found.keys()].sort();
        out[repo.name] = features;
        done++;
        console.log(
          `  [${done}/${targets.length}] ${repo.name} — ${features.length ? features.join(', ') : 'none detected'}`
        );
        if (explain) {
          for (const [name, ev] of found) {
            console.log(`        ${name}\n          via ${ev.source}${ev.excerpt ? ` :: "${ev.excerpt}"` : ''}`);
          }
        }
      }
    })
  );

  // Always merge, so a filtered run never drops other repos' results.
  const existing = await readFile('data/tech.json', 'utf8').then(JSON.parse).catch(() => ({}));
  const merged = { ...existing, ...out };
  const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
  await writeFile('data/tech.json', JSON.stringify(sorted, null, 2) + '\n');

  const all = new Set(Object.values(sorted).flat());
  const tagged = Object.values(out).filter((v) => v.length).length;
  console.log(`\nWrote ${Object.keys(sorted).length} entries to data/tech.json`);
  console.log(`  ${all.size} distinct capabilities, ${tagged}/${targets.length} repos with at least one`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
