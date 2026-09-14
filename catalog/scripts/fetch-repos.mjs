#!/usr/bin/env node
// Builds data/repos.json (grid index) + data/repos/<name>.json (detail pages)
// from the authenticated user's GitHub account.

import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'data');
const REPOS_PER_PAGE = 10;
const CONCURRENCY = 8;

// Repos that exist on the account but are not demos, so never belong in the catalog.
// Keep in sync with EXCLUDED in lib/data.js and streamlit_app.py.
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

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No credentials. Set GITHUB_TOKEN or run `gh auth login`.');
  }
}
const TOKEN = token();

const headers = {
  authorization: `bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'pj-project-catalog',
};

async function request(url, init = {}, attempt = 1) {
  const res = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
  if (res.status === 404) return null;
  if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt <= 5) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const waitForReset = reset ? reset * 1000 - Date.now() : 0;
    const delay = Math.max(waitForReset, 0) || 2 ** attempt * 500;
    console.warn(`  retry ${attempt} in ${Math.round(delay / 1000)}s -> ${res.status}`);
    await new Promise((r) => setTimeout(r, delay));
    return request(url, init, attempt + 1);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function graphql(query, variables) {
  const body = await request('https://api.github.com/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  if (body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`);
  return body.data;
}

// README filenames vary; ask for the common ones as aliases in one shot.
const README_ALIASES = [
  ['readmeMd', 'README.md'],
  ['readmeLower', 'readme.md'],
  ['readmeUpper', 'README.MD'],
  ['readmeMarkdown', 'README.markdown'],
  ['readmeTxt', 'README.txt'],
  ['readmeRst', 'README.rst'],
  ['readmePlain', 'README'],
]
  .map(([alias, file]) => `${alias}: object(expression: "HEAD:${file}") { ... on Blob { text } }`)
  .join('\n        ');

const QUERY = `
query($cursor: String, $count: Int!) {
  rateLimit { remaining }
  viewer {
    login
    repositories(first: $count, after: $cursor, ownerAffiliations: OWNER, orderBy: {field: PUSHED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
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
        ${README_ALIASES}
      }
    }
  }
}`;

function pickReadme(node) {
  for (const key of [
    'readmeMd',
    'readmeLower',
    'readmeUpper',
    'readmeMarkdown',
    'readmeTxt',
    'readmeRst',
    'readmePlain',
  ]) {
    const text = node[key]?.text;
    if (text && text.trim()) return text;
  }
  return null;
}

async function fetchAllRepos() {
  const repos = [];
  let cursor = null;
  let login = null;
  for (;;) {
    const data = await graphql(QUERY, { cursor, count: REPOS_PER_PAGE });
    login = data.viewer.login;
    const page = data.viewer.repositories;
    repos.push(...page.nodes);
    console.log(`  fetched ${repos.length} repos (rate limit left: ${data.rateLimit.remaining})`);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return { login, repos };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

async function fetchContributors(nameWithOwner) {
  const data = await request(
    `https://api.github.com/repos/${nameWithOwner}/contributors?per_page=10&anon=0`
  );
  if (!Array.isArray(data)) return [];
  return data.map((c) => ({
    login: c.login,
    avatarUrl: c.avatar_url,
    contributions: c.contributions,
    url: c.html_url,
  }));
}

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
    readme: pickReadme(node),
    hasReadme: Boolean(pickReadme(node)),
  };
}

async function main() {
  console.log('Fetching repositories...');
  const { login, repos: fetched } = await fetchAllRepos();

  // Forks are other people's projects and EXCLUDED names are not demos. Dropping
  // them here keeps them out of data/ entirely and saves the contributor calls below.
  const repos = fetched.filter((r) => !r.isFork && !EXCLUDED.has(r.name));
  if (repos.length !== fetched.length) {
    console.log(`  excluded ${fetched.length - repos.length} forks and non-demos`);
  }

  console.log(`Fetching contributors for ${repos.length} repos...`);
  const contributors = await mapLimit(repos, CONCURRENCY, (r) => fetchContributors(r.nameWithOwner));

  const shaped = repos.map((node, i) => shape(node, contributors[i]));

  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, 'repos'), { recursive: true });

  // Grid index: only the fields the card needs, so the first paint stays small.
  const index = shaped.map((r) => ({
    name: r.name,
    nameWithOwner: r.nameWithOwner,
    owner: r.owner,
    description: r.description,
    isPrivate: r.isPrivate,
    isArchived: r.isArchived,
    isFork: r.isFork,
    stars: r.stars,
    forks: r.forks,
    pushedAt: r.pushedAt,
    createdAt: r.createdAt,
    primaryLanguage: r.primaryLanguage,
    topics: r.topics,
  }));

  await writeFile(
    path.join(OUT, 'repos.json'),
    JSON.stringify({ login, generatedAt: new Date().toISOString(), repos: index }, null, 2)
  );
  await Promise.all(
    shaped.map((r) => writeFile(path.join(OUT, 'repos', `${r.name}.json`), JSON.stringify(r)))
  );

  const missingReadme = shaped.filter((r) => !r.hasReadme).length;
  console.log(`\nWrote ${shaped.length} repos to data/`);
  console.log(`  private: ${shaped.filter((r) => r.isPrivate).length}`);
  console.log(`  without README: ${missingReadme}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
