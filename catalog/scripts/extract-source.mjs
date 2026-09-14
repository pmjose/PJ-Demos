#!/usr/bin/env node
// Walks each repo's local working copy and extracts the human-facing content that
// actually says what the demo does: docs, page titles, dashboard labels, KPI strings,
// SQL object names. Output feeds the business-summary prompt.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SEARCH_ROOTS = ['/Users/pjose/Documents/01 - GitHub', '/tmp/clones'];

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', '.venv', 'venv',
  '__pycache__', '.cache', 'coverage', 'vendor', '.turbo', 'target',
  '.pytest_cache', 'site-packages', '.idea', '.vscode', 'assets',
]);

const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst']);
const CODE_EXT = new Set(['.tsx', '.jsx', '.ts', '.js', '.py', '.sql', '.ipynb', '.html', '.vue', '.svelte']);
const DATA_EXT = new Set(['.csv', '.tsv']);

const CAPS = {
  docChars: 14000,
  copyChars: 9000,
  htmlChars: 2500,
  dataChars: 2000,
  files: 90,
  maxFileBytes: 1_500_000,
};

async function walk(dir, depth = 0, acc = []) {
  if (depth > 4 || acc.length > 4000) return acc;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(full, depth + 1, acc);
    } else if (e.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

async function readCapped(file) {
  try {
    const s = await stat(file);
    if (s.size > CAPS.maxFileBytes) return null;
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Pull human-readable copy out of source: UI strings, headings, SQL comments. */
function extractCopy(text, ext) {
  const out = [];

  const htmlHeadings = () => {
    const title = text.match(/<title>([^<]+)<\/title>/i);
    if (title) out.push(`title: ${title[1].trim()}`);
    const desc = text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i);
    if (desc) out.push(`description: ${desc[1].trim()}`);
    for (const m of text.matchAll(/<h[1-3][^>]*>([^<]{4,140})<\/h[1-3]>/gi)) out.push(m[1].trim());
    for (const m of text.matchAll(/class="[^"]*(?:header|title|kpi|metric|label)[^"]*"[^>]*>([^<]{4,120})</gi))
      out.push(m[1].trim());
  };

  // Quoted UI strings — works for JS/TS/JSX and for Python f-string HTML blocks alike.
  const quotedStrings = () => {
    for (const m of text.matchAll(/>\s*([A-Z][^<>{}\n]{10,120}?)\s*</g)) out.push(m[1].trim());
    for (const m of text.matchAll(/["'`]([A-Z][A-Za-z0-9 ,.'%&()/–—:+-]{14,120})["'`]/g))
      out.push(m[1].trim());
  };

  if (ext === '.sql') {
    for (const m of text.matchAll(/--\s*(.{12,160})/g)) out.push(m[1].trim());
    for (const m of text.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|DYNAMIC TABLE)\s+([\w.$"]+)/gi))
      out.push(`object: ${m[1]}`);
    return out;
  }

  if (ext === '.ipynb') {
    try {
      const nb = JSON.parse(text);
      for (const cell of nb.cells || []) {
        if (cell.cell_type === 'markdown') out.push((cell.source || []).join('').slice(0, 600));
      }
    } catch {
      /* malformed notebook, skip */
    }
    return out;
  }

  if (ext === '.py') {
    // Streamlit apps often build copy with f-strings and inline HTML, so run all three.
    for (const m of text.matchAll(/st\.(?:title|header|subheader|markdown|caption|metric)\(\s*["'`]([^"'`]{6,200})/g))
      out.push(m[1]);
    for (const m of text.matchAll(/^\s*#\s*(.{15,140})$/gm)) out.push(m[1].trim());
    htmlHeadings();
    quotedStrings();
    return out;
  }

  if (ext === '.html') {
    htmlHeadings();
    return out;
  }

  quotedStrings();
  return out;
}

const NOISE =
  /^(import|export|function|const|return|className|http|https|www\.|\/|#|use |true|false|null)/i;

function dedupeCopy(lines, cap) {
  const seen = new Set();
  const kept = [];
  let size = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length < 8 || NOISE.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
    size += line.length + 1;
    if (size > cap) break;
  }
  return kept;
}

async function extractRepo(name, dir) {
  const files = await walk(dir);
  const rel = files.map((f) => path.relative(dir, f));

  // Docs first — richest business context, README last so docs/ gets a fair share.
  const docFiles = files
    .filter((f) => DOC_EXT.has(path.extname(f).toLowerCase()))
    .sort((a, b) => {
      const score = (f) => {
        const n = path.basename(f).toLowerCase();
        if (n.startsWith('readme')) return 0;
        if (/(overview|business|demo|guide|story|script|brief|value)/.test(n)) return 1;
        return 2;
      };
      return score(a) - score(b);
    })
    .slice(0, 12);

  let docs = '';
  for (const f of docFiles) {
    if (docs.length >= CAPS.docChars) break;
    const text = await readCapped(f);
    if (!text) continue;
    docs += `\n### ${path.relative(dir, f)}\n${text.slice(0, 6000)}\n`;
  }

  const copyLines = [];
  let htmlBlob = '';
  const codeFiles = files.filter((f) => CODE_EXT.has(path.extname(f).toLowerCase())).slice(0, 260);
  for (const f of codeFiles) {
    const ext = path.extname(f).toLowerCase();
    const text = await readCapped(f);
    if (!text) continue;
    if (ext === '.html' && htmlBlob.length < CAPS.htmlChars) {
      htmlBlob += text.replace(/<script[\s\S]*?<\/script>/gi, '').slice(0, 1200);
    }
    copyLines.push(...extractCopy(text, ext));
  }

  // Column headers say a lot about a data-only repo, so read just the first line.
  let dataShape = '';
  const dataFiles = files.filter((f) => DATA_EXT.has(path.extname(f).toLowerCase())).slice(0, 25);
  for (const f of dataFiles) {
    if (dataShape.length >= CAPS.dataChars) break;
    try {
      const handle = await readFile(f, { encoding: 'utf8', flag: 'r' });
      const header = handle.slice(0, handle.indexOf('\n') > 0 ? handle.indexOf('\n') : 400);
      dataShape += `${path.basename(f)}: ${header.trim().slice(0, 300)}\n`;
    } catch {
      /* unreadable, skip */
    }
  }

  return {
    name,
    localPath: dir,
    fileCount: files.length,
    structure: rel
      .filter((r) => r.split(path.sep).length <= 3)
      .slice(0, CAPS.files)
      .join('\n'),
    docs: docs.slice(0, CAPS.docChars),
    uiCopy: dedupeCopy(copyLines, CAPS.copyChars).join('\n'),
    dataShape: dataShape.slice(0, CAPS.dataChars),
  };
}

async function resolveDir(name) {
  for (const root of SEARCH_ROOTS) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const hit = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === name.toLowerCase());
    if (hit) return path.join(root, hit.name);
  }
  return null;
}

async function main() {
  const { repos } = JSON.parse(await readFile('data/repos.json', 'utf8'));
  const out = [];
  let withSource = 0;

  for (const r of repos) {
    const dir = await resolveDir(r.name);
    if (!dir) {
      out.push({ name: r.name, localPath: null, fileCount: 0, structure: '', docs: '', uiCopy: '', dataShape: '' });
      continue;
    }
    const rec = await extractRepo(r.name, dir);
    out.push(rec);
    withSource++;
    console.log(
      `  ${r.name}: ${rec.fileCount} files, docs ${rec.docs.length}c, copy ${rec.uiCopy.length}c`
    );
  }

  await writeFile('/tmp/source_context.ndjson', out.map((o) => JSON.stringify(o)).join('\n'));
  console.log(`\nrepos with local source: ${withSource} of ${repos.length}`);
  const thin = out.filter(
    (o) => o.localPath && o.docs.length < 200 && o.uiCopy.length < 200 && o.dataShape.length < 60
  );
  console.log(`still thin after extraction: ${thin.length}`, thin.map((t) => t.name).join(', '));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
