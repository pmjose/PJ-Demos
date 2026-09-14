#!/usr/bin/env node
// Adds ONE demo to the catalog without rebuilding it.
//
// Why this exists rather than `npm run refresh`: fetch-repos.mjs starts by deleting the
// whole data/ directory, and it no longer writes several fields the app depends on
// (headline, industry, audience, grade, hasPage, shot, siteUrl, gated) or the AI-authored
// `business` block. data/ is untracked, so a refresh would destroy 117 business summaries
// with no way back. This script only ever reads and upserts.
//
// Usage:
//   node scripts/add-demo.mjs <RepoName> [--business <file.json>] [--project-only] [--dry-run]
//
//   --business <file>   JSON for the demo's business block (the card copy). Merged over
//                       anything already stored, so you can revise one field at a time.
//   --project-only      Skip the GitHub fetch and only re-project the index entry from
//                       shots.json / access-codes.json. Use for the second pass, after
//                       screenshots and gate codes exist.
//   --dry-run           Report the changes without writing.

import { execFileSync } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DATA = path.join(process.cwd(), 'data');

// Kept in sync with EXCLUDED in fetch-repos.mjs and streamlit_app.py.
const EXCLUDED = new Set([
  'PJ',
  'xoople',
  'TELCO-REVENUE',
  'test',
  'SnowImpact_backup',
  'CMU-AI',
  'snowflake',
  'Snowtch',
  'Flurry',
]);

// The card and the detail page both read these. A demo missing headline falls back to its
// repo name, which reads as unfinished next to 90 written ones.
const BUSINESS_KEYS = [
  'headline',
  'industry',
  'target_audience',
  'business_problem',
  'business_value',
  'solution',
  'key_capabilities',
  'evidence_grade',
];

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No credentials. Set GITHUB_TOKEN or run `gh auth login`.');
  }
}

const headers = () => ({
  authorization: `bearer ${token()}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'pj-project-catalog',
});

// Same field set as fetch-repos.mjs so the detail file stays shape-compatible, but keyed
// on one repository instead of paging the whole account.
const QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    name
    nameWithOwner
    description
    url
    homepageUrl
    isPrivate
    isArchived
    isFork
    diskUsage
    createdAt
    pushedAt
    stargazerCount
    forkCount
    primaryLanguage { name color }
    licenseInfo { spdxId name }
    repositoryTopics(first: 12) { nodes { topic { name } } }
    languages(first: 12, orderBy: {field: SIZE, direction: DESC}) {
      edges { size node { name color } }
    }
    defaultBranchRef {
      name
      target {
        ... on Commit {
          history(first: 20) {
            nodes {
              oid
              messageHeadline
              committedDate
              url
              author { name user { login } }
            }
          }
        }
      }
    }
    tree: object(expression: "HEAD:") {
      ... on Tree { entries { name type } }
    }
  }
}`;

async function graphql(variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query: QUERY, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) {
    const message = body.errors.map((e) => e.message).join('; ');
    // By far the most common failure: the skill was run in a folder that has not been
    // pushed yet. GitHub reports this as a GraphQL error rather than a null repository,
    // so the actionable wording has to be attached here.
    if (/Could not resolve to a Repository/i.test(message)) {
      throw new Error(
        `${variables.owner}/${variables.name} does not exist on GitHub. The catalog indexes ` +
          'GitHub rather than the local folder, so create the repo and push it first:\n' +
          `  gh repo create ${variables.name} --private --source . --push`
      );
    }
    throw new Error(message);
  }
  return body.data;
}

async function fetchContributors(nameWithOwner) {
  const res = await fetch(
    `https://api.github.com/repos/${nameWithOwner}/contributors?per_page=10&anon=0`,
    { headers: headers() }
  );
  if (!res.ok) return [];
  // GitHub answers 204 with an empty body for repos it has no contributor stats for, and
  // res.json() throws on empty input rather than returning null.
  const body = await res.text();
  if (!body.trim()) return [];
  const data = JSON.parse(body);
  if (!Array.isArray(data)) return [];
  return data.map((c) => ({
    login: c.login,
    avatarUrl: c.avatar_url,
    contributions: c.contributions,
    url: c.html_url,
  }));
}

// Mirrors shape() in fetch-repos.mjs. `readme` is deliberately dropped: nothing reads it
// and it dominates the file size.
function shape(node, contributors) {
  const langEdges = node.languages?.edges ?? [];
  const totalBytes = langEdges.reduce((sum, e) => sum + e.size, 0);
  const commits = node.defaultBranchRef?.target?.history?.nodes ?? [];
  const entries = node.tree?.entries ?? [];

  return {
    name: node.name,
    nameWithOwner: node.nameWithOwner,
    owner: node.nameWithOwner.split('/')[0],
    description: node.description,
    url: node.url,
    homepageUrl: node.homepageUrl || null,
    isPrivate: node.isPrivate,
    isArchived: node.isArchived,
    isFork: node.isFork,
    diskUsageKb: node.diskUsage ?? 0,
    createdAt: node.createdAt,
    pushedAt: node.pushedAt,
    stars: node.stargazerCount,
    forks: node.forkCount,
    primaryLanguage: node.primaryLanguage
      ? { name: node.primaryLanguage.name, color: node.primaryLanguage.color }
      : null,
    license: node.licenseInfo ? node.licenseInfo.spdxId || node.licenseInfo.name : null,
    topics: (node.repositoryTopics?.nodes ?? []).map((t) => t.topic.name),
    defaultBranch: node.defaultBranchRef?.name ?? null,
    languages: langEdges.map((e) => ({
      name: e.node.name,
      color: e.node.color,
      bytes: e.size,
      percent: totalBytes ? +((e.size / totalBytes) * 100).toFixed(1) : 0,
    })),
    tree: entries
      .map((e) => ({ name: e.name, type: e.type }))
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : 1
      ),
    commits: commits.map((c) => ({
      oid: c.oid.slice(0, 7),
      message: c.messageHeadline,
      date: c.committedDate,
      url: c.url,
      author: c.author?.user?.login || c.author?.name || 'unknown',
    })),
    contributors,
  };
}

const readJson = (file, fallback) =>
  readFile(path.join(DATA, file), 'utf8')
    .then(JSON.parse)
    .catch(() => fallback);

// Write via a temp file so an interrupted run cannot leave repos.json half-written — it is
// the one file with no backup and no generator that can rebuild it.
// `indent` matches what fetch-repos.mjs produced for each file: repos.json is pretty so it
// stays diffable, detail files are compact because all 123 of them ship in the app bundle.
async function writeAtomic(file, value, indent) {
  const target = path.join(DATA, file);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, indent) + (indent ? '\n' : ''));
  await rename(tmp, target);
}

// The live-site facts all originate in shots.json; access-codes.json is the fallback for
// `gated` because a code can be recorded before the next screenshot pass runs.
function siteBlock(detail, shot, hasCode) {
  if (!shot) {
    return detail.site ?? { hasPage: Boolean(detail.homepageUrl), url: detail.homepageUrl };
  }
  return {
    hasPage: shot.hasPage ?? false,
    url: shot.url ?? detail.homepageUrl ?? null,
    shot: shot.shot ?? null,
    gated: shot.gated ?? hasCode,
    title: shot.title ?? null,
  };
}

function indexEntry(detail, site) {
  const b = detail.business ?? {};
  return {
    name: detail.name,
    nameWithOwner: detail.nameWithOwner,
    owner: detail.owner,
    description: detail.description,
    isPrivate: detail.isPrivate,
    isArchived: detail.isArchived,
    isFork: detail.isFork,
    stars: detail.stars,
    forks: detail.forks,
    pushedAt: detail.pushedAt,
    createdAt: detail.createdAt,
    primaryLanguage: detail.primaryLanguage,
    topics: detail.topics,
    headline: b.headline ?? null,
    industry: b.industry ?? null,
    audience: b.target_audience ?? null,
    shot: site.shot ?? null,
    hasPage: site.hasPage ?? false,
    siteUrl: site.url ?? null,
    gated: site.gated ?? false,
    grade: b.evidence_grade ?? 'insufficient',
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const names = args.filter((a) => !a.startsWith('--'));
  const businessAt = args.indexOf('--business');
  const businessArg = businessAt >= 0 ? args[businessAt + 1] : null;
  const projectOnly = flags.has('--project-only');
  const dryRun = flags.has('--dry-run');

  // --business consumes the next token, which would otherwise look like the repo name.
  const name = names.filter((n) => n !== businessArg)[0];
  if (!name) throw new Error('Usage: node scripts/add-demo.mjs <RepoName> [--business file.json]');
  if (EXCLUDED.has(name)) {
    throw new Error(
      `${name} is in EXCLUDED, so the app would filter it straight back out. Remove it from ` +
        'EXCLUDED in add-demo.mjs, fetch-repos.mjs and streamlit_app.py first.'
    );
  }

  const index = await readJson('repos.json', null);
  if (!index?.repos) {
    throw new Error(
      `No data/repos.json under ${process.cwd()}. Run this from the catalog directory; ` +
        'refusing to create a new index because that would drop every existing demo.'
    );
  }

  const detailFile = path.join('repos', `${name}.json`);
  const existing = await readJson(detailFile, null);

  let detail;
  if (projectOnly) {
    if (!existing) throw new Error(`--project-only needs data/${detailFile} to exist already.`);
    detail = existing;
  } else {
    const owner = index.login ?? 'pmjose';
    const data = await graphql({ owner, name });
    if (!data.repository) {
      throw new Error(
        `${owner}/${name} not found on GitHub. Create the repo and push it first — the ` +
          'catalog indexes GitHub, not the local folder.'
      );
    }
    if (data.repository.isFork) {
      throw new Error(`${name} is a fork, and the app filters forks out of the grid.`);
    }
    const contributors = await fetchContributors(data.repository.nameWithOwner);
    detail = shape(data.repository, contributors);
    // Carry forward anything this script does not source from GitHub.
    if (existing?.business) detail.business = existing.business;
    if (existing?.site) detail.site = existing.site;
  }

  if (businessArg) {
    const incoming = JSON.parse(await readFile(businessArg, 'utf8'));
    detail.business = { ...(detail.business ?? {}), ...incoming };
  }

  const missing = BUSINESS_KEYS.filter((k) => {
    const v = detail.business?.[k];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  });

  const shots = await readJson('shots.json', {});
  const codes = await readJson('access-codes.json', {});
  const site = siteBlock(detail, shots[name], Boolean(codes[name]));
  detail.site = site;

  const entry = indexEntry(detail, site);
  const at = index.repos.findIndex((r) => r.name === name);
  const verb = at >= 0 ? 'Updated' : 'Added';
  const repos = [...index.repos];
  if (at >= 0) repos[at] = entry;
  else repos.push(entry);
  // PUSHED_AT descending, matching the order fetch-repos.mjs produces.
  repos.sort((a, b) => new Date(b.pushedAt) - new Date(a.pushedAt));

  console.log(`${dryRun ? '[dry run] ' : ''}${verb} ${name}`);
  console.log(`  headline : ${detail.business?.headline ?? '(none — card will show the repo name)'}`);
  console.log(`  industry : ${detail.business?.industry ?? '(none)'}`);
  console.log(`  grade    : ${entry.grade}`);
  console.log(`  live site: ${site.hasPage ? site.url : 'no'}`);
  console.log(`  shot     : ${site.shot ?? 'none yet — run `npm run shots -- ' + name + '`'}`);
  console.log(`  gated    : ${site.gated ? 'yes' : 'no'}`);
  console.log(`  catalog  : ${repos.length} demos in the index`);
  if (missing.length) console.log(`  INCOMPLETE business fields: ${missing.join(', ')}`);

  if (dryRun) return;

  await writeAtomic(detailFile, detail, 0);
  await writeAtomic(
    'repos.json',
    { ...index, generatedAt: new Date().toISOString(), repos },
    2
  );

  console.log('\nNext: npm run shots -- ' + name + ' (if it has a Pages site), then');
  console.log('      npm run codes -- ' + name + ', npm run tech -- ' + name + ',');
  console.log('      npm run search-terms -- ' + name + ', npm run facets,');
  console.log('      then re-run this with --project-only to pick up shot/gated.');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
