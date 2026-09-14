#!/usr/bin/env node
// Extracts each gated demo's access code from its own source and writes
// data/access-codes.json. The gates are client-side, so the code is a literal in
// the repo (typically `const PASSWORD = '...'` in src/auth/AuthContext.tsx).
//
// Re-run after adding a gated demo:  node scripts/fetch-access-codes.mjs
// Limit to specific repos:           node scripts/fetch-access-codes.mjs TeliaNO BT-C360

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const CONCURRENCY = 6;

// Cheapest first: nearly every demo keeps the constant in the same place.
const KNOWN_PATHS = [
  'src/auth/AuthContext.tsx',
  'src/auth/AuthContext.ts',
  'src/context/AuthContext.tsx',
  'src/auth/auth.tsx',
  'src/App.tsx',
];

// `const PASSWORD = 'x'`, `ACCESS_CODE = "x"`, `passcode: 'x'`, etc.
const ASSIGN =
  /(?:const|let|var)?\s*(?:PASSWORD|PASSCODE|ACCESS_CODE|ACCESSCODE|ACCESS_KEY|ACCESSKEY|GATE_CODE|GATE_KEY|GATE_PASSPHRASE|CODE)\s*[:=]\s*['"`]([^'"`]{2,40})['"`]/;

// Identifier names are not consistent across demos (PASSWORD, CODIGO_ACCESO, ...),
// so prefer resolving whatever constant the gate actually compares against.
const COMPARED_IDENT = /[=!]==?\s*([A-Z][A-Z0-9_]{2,30})\b/g;
const COMPARED_LITERAL = /(?:\.trim\(\)\s*)?[=!]==?\s*['"`]([^'"`\s]{3,40})['"`]/;
const identAssign = (name) =>
  new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*['"\`]([^'"\`]{2,40})['"\`]`);

// `const X = process.env.FOO ?? "LITERAL"` — the literal is the shipped default.
const identEnvFallback = (name) =>
  new RegExp(
    `(?:const|let|var)\\s+${name}\\s*=\\s*process\\.env\\.[A-Z0-9_]+\\s*(?:\\?\\?|\\|\\|)\\s*['"\`]([^'"\`]{2,40})['"\`]`
  );
const ENV_FALLBACK =
  /process\.env\.[A-Z0-9_]*(?:CODE|PASS|GATE)[A-Z0-9_]*\s*(?:\?\?|\|\|)\s*['"`]([^'"`]{2,40})['"`]/;

// Where an identifier was imported from, so the constant can be chased across files.
const importOf = (name) =>
  new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`);

// Files worth opening at all.
const CANDIDATE_PATH = /(?:auth|gate|login|passcode|password|access|unlock|guard|secret|context|app)/i;
const CANDIDATE_EXT = /\.(tsx?|jsx?|svelte|vue|html)$/;
// Some demos commit node_modules, which would otherwise swamp the candidate list.
const VENDOR = /(?:^|\/)(?:node_modules|dist|build|out|\.next|vendor|coverage)\//;

// Literals that are control flow or state, never an access code.
const REJECT = new Set([
  'undefined', 'null', 'true', 'false', 'checking', 'idle', 'loading', 'pending',
  'error', 'success', 'authenticated', 'unauthenticated', 'password', 'text',
  'submit', 'button', 'string', 'number', 'object', 'function', 'dark', 'light',
  'granted', 'denied', 'default', 'production', 'development',
]);
const plausible = (v) => v && !REJECT.has(v.toLowerCase()) && v.length >= 4;

/** A file named Gate/Auth is far likelier to hold the code than a big App file. */
function pathScore(p) {
  const base = p.split('/').pop().toLowerCase();
  if (/(gate|passcode|access|unlock)/.test(base)) return 0;
  if (/(auth|login|password|guard|secret)/.test(base)) return 1;
  if (/context/.test(base)) return 2;
  return 3;
}

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

async function getFile(nameWithOwner, path) {
  const res = await gh(`https://api.github.com/repos/${nameWithOwner}/contents/${path}`);
  if (!res.ok) return null;
  const body = await res.json();
  if (!body.content) return null;
  return Buffer.from(body.content, 'base64').toString('utf8');
}

/** List plausible gate files. One trees call per repo, on the generous core quota. */
async function listCandidates(nameWithOwner) {
  const res = await gh(
    `https://api.github.com/repos/${nameWithOwner}/git/trees/HEAD?recursive=1`
  );
  if (!res.ok) return [];
  const body = await res.json();
  return (body.tree ?? [])
    .filter(
      (e) =>
        e.type === 'blob' &&
        !VENDOR.test(e.path) &&
        CANDIDATE_EXT.test(e.path) &&
        CANDIDATE_PATH.test(e.path)
    )
    .map((e) => e.path)
    // Gate/auth files first, then shortest, so App.jsx is a last resort.
    .sort((a, b) => pathScore(a) - pathScore(b) || a.length - b.length)
    .slice(0, 12);
}

/** Turn an import specifier into candidate repo paths. */
function resolveImport(spec, fromPath) {
  const dir = fromPath.split('/').slice(0, -1);
  let bases = [];

  if (spec.startsWith('.')) {
    const parts = [...dir];
    for (const seg of spec.split('/')) {
      if (seg === '.') continue;
      else if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    bases = [parts.join('/')];
  } else {
    // Alias like `@/lib/constants` — the root it points at varies by project.
    const rel = spec.replace(/^[^/]*\//, '');
    bases = [rel, `src/${rel}`, `app/${rel}`, `app/src/${rel}`];
  }

  const exts = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
  return bases.flatMap((b) => exts.map((e) => b + e));
}

/** Pull the code out of one file's source, trying the most precise signal first. */
async function extract(text, { nameWithOwner, path } = {}) {
  if (!text) return null;

  for (const m of text.matchAll(COMPARED_IDENT)) {
    const name = m[1];

    const local = text.match(identAssign(name));
    if (local && plausible(local[1])) return local[1];

    const envLocal = text.match(identEnvFallback(name));
    if (envLocal && plausible(envLocal[1])) return envLocal[1];

    // Defined in another module: follow the import.
    const imp = nameWithOwner && text.match(importOf(name));
    if (imp) {
      for (const candidate of resolveImport(imp[1], path)) {
        const src = await getFile(nameWithOwner, candidate);
        if (!src) continue;
        const hit = src.match(identAssign(name)) || src.match(identEnvFallback(name));
        if (hit && plausible(hit[1])) return hit[1];
        break; // the module resolved; no point trying more extensions
      }
    }
  }

  const named = text.match(ASSIGN);
  if (named && plausible(named[1])) return named[1];

  const env = text.match(ENV_FALLBACK);
  if (env && plausible(env[1])) return env[1];

  // Inline comparison against a literal, only in something gate-shaped.
  if (/type=["']password["']|access code|c\u00f3digo/i.test(text)) {
    for (const m of text.matchAll(new RegExp(COMPARED_LITERAL, 'g'))) {
      if (plausible(m[1])) return m[1];
    }
  }
  return null;
}

/** Every plausible source file, for the handful of repos whose gate is named oddly. */
async function listAllSource(nameWithOwner) {
  const res = await gh(
    `https://api.github.com/repos/${nameWithOwner}/git/trees/HEAD?recursive=1`
  );
  if (!res.ok) return [];
  const body = await res.json();
  return (body.tree ?? [])
    .filter((e) => e.type === 'blob' && !VENDOR.test(e.path) && CANDIDATE_EXT.test(e.path))
    .map((e) => e.path)
    .sort((a, b) => pathScore(a) - pathScore(b) || a.length - b.length)
    .slice(0, 50);
}

async function findCode(repo) {
  const tried = new Set();
  const owner = repo.nameWithOwner;

  for (const path of KNOWN_PATHS) {
    tried.add(path);
    const code = await extract(await getFile(owner, path), { nameWithOwner: owner, path });
    if (code) return { code, path };
  }

  for (const path of await listCandidates(owner)) {
    if (tried.has(path)) continue;
    tried.add(path);
    const code = await extract(await getFile(owner, path), { nameWithOwner: owner, path });
    if (code) return { code, path };
  }

  // Last resort: sweep the whole source tree. Only reached for repos whose gate
  // component is not named gate/auth/access, so it costs nothing for the rest.
  for (const path of await listAllSource(owner)) {
    if (tried.has(path)) continue;
    tried.add(path);
    const text = await getFile(owner, path);
    // Loose filter: some gates use a dynamic type for the show/hide eye toggle,
    // and names are localised. extract() is strict enough to absorb the noise.
    if (!text || !/password|senha|c\u00f3digo|passcode|passphrase|access\s*code/i.test(text)) continue;
    const code = await extract(text, { nameWithOwner: owner, path });
    if (code) return { code, path };
  }

  return null;
}

async function main() {
  const [{ repos }, shots] = await Promise.all([
    readFile('data/repos.json', 'utf8').then(JSON.parse),
    readFile('data/shots.json', 'utf8').then(JSON.parse),
  ]);

  const only = process.argv.slice(2);
  const targets = repos.filter((r) => {
    if (only.length) return only.includes(r.name);
    return shots[r.name]?.gated;
  });

  console.log(`Looking for access codes in ${targets.length} repos...`);

  const found = {};
  const missing = [];
  let i = 0;
  let done = 0;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < targets.length) {
        const repo = targets[i++];
        let hit = null;
        try {
          hit = await findCode(repo);
        } catch (err) {
          console.error(`  ${repo.name} — error: ${err.message.split('\n')[0]}`);
        }
        done++;
        if (hit) {
          found[repo.name] = hit.code;
          console.log(`  [${done}/${targets.length}] ${repo.name} — ${hit.code}`);
        } else {
          missing.push(repo.name);
          console.log(`  [${done}/${targets.length}] ${repo.name} — not found`);
        }
      }
    })
  );

  // Always merge. Codes added by hand (a demo whose source is not in its repo)
  // must survive a full re-run, and a miss should never silently drop a good code.
  const existing = await readFile('data/access-codes.json', 'utf8')
    .then(JSON.parse)
    .catch(() => ({}));
  const merged = { ...existing, ...found };
  const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
  await writeFile('data/access-codes.json', JSON.stringify(sorted, null, 2) + '\n');

  console.log(`\nWrote ${Object.keys(sorted).length} codes to data/access-codes.json`);
  if (missing.length) console.log(`  not found (${missing.length}): ${missing.join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
