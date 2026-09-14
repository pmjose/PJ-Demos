#!/usr/bin/env node
// Screenshots every repo's GitHub Pages site into public/shots/<name>.jpg
// and records which ones are gated behind an access code.

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT_DIR = path.join(process.cwd(), 'public', 'shots');
const CONCURRENCY = 4;
const VIEWPORT = { width: 1280, height: 800 };

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

// A gate page exists to collect one code, so it carries almost no other interactive
// surface. Measured across the catalogue: gate screens show 2-3 visible controls, fully
// rendered demos show 24-29. Eight sits in the middle of that gap, leaving room for a gate
// that also offers a language switch or a help link.
const GATE_MAX_CONTROLS = 8;

/**
 * A gate page has a visible password/code field and almost no other interactive surface.
 *
 * This used to key off word count (`words < 120`), which measured the wrong thing: two
 * gate screens are editorial, pairing the code box with a scrolling narrative, so at 177
 * and 233 words they read as ungated. Their access codes were then never collected, because
 * fetch-access-codes.mjs only scans demos this flag marks as gated.
 */
async function detectGate(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
    };
    const fields = [
      ...document.querySelectorAll(
        'input[type=password], input[name*=code i], input[placeholder*=code i], input[placeholder*=password i]'
      ),
    ].filter(visible);
    // Visible-only, so a login form inside a closed modal does not count as a gate.
    const controls = [
      ...document.querySelectorAll('button, a[href], select, textarea, input'),
    ].filter(visible).length;
    const text = (document.body?.innerText || '').trim();
    const words = text.split(/\s+/).filter(Boolean).length;
    return { hasCodeField: fields.length > 0, controls, words };
  });
}

/**
 * `networkidle` fires before a client-rendered app has painted, so a flat wait
 * produced near-blank captures. Poll the rendered text until it stops growing.
 */
async function settle(page, { minWords = 30, quietMs = 700, timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stableSince = 0;

  while (Date.now() < deadline) {
    const words = await page
      .evaluate(() => (document.body?.innerText || '').split(/\s+/).filter(Boolean).length)
      .catch(() => 0);

    if (words !== last) {
      last = words;
      stableSince = Date.now();
    } else {
      const quiet = Date.now() - stableSince;
      // Settled with real content, or quiet long enough that this is all there is.
      if ((words >= minWords && quiet >= quietMs) || quiet >= quietMs * 3) return words;
    }
    await page.waitForTimeout(250);
  }
  return last;
}

async function shoot(browser, repo) {
  const res = await gh(`https://api.github.com/repos/${repo.nameWithOwner}/pages`);
  if (!res.ok) return { name: repo.name, hasPage: false };
  const info = await res.json();
  const url = info.html_url;

  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    const status = resp?.status() ?? 0;
    if (status >= 400) {
      await context.close();
      return { name: repo.name, hasPage: true, url, ok: false, status };
    }

    // Let the app render, then entry animations and fonts settle.
    const words = await settle(page);
    await page.waitForTimeout(500);

    const title = await page.title();
    const gate = await detectGate(page);
    await page.screenshot({
      path: path.join(OUT_DIR, `${repo.name}.jpg`),
      type: 'jpeg',
      quality: 80,
    });

    await context.close();
    return {
      name: repo.name,
      hasPage: true,
      url,
      ok: true,
      status,
      title,
      gated: gate.hasCodeField && gate.controls <= GATE_MAX_CONTROLS,
      controls: gate.controls,
      words,
      shot: `shots/${repo.name}.jpg`,
    };
  } catch (err) {
    await context.close().catch(() => {});
    return { name: repo.name, hasPage: true, url, ok: false, error: err.message.split('\n')[0] };
  }
}

async function main() {
  const { repos } = JSON.parse(await readFile('data/repos.json', 'utf8'));
  await mkdir(OUT_DIR, { recursive: true });

  // Optional repo names re-shoot just those, e.g. `node scripts/screenshot-pages.mjs TeliaNO`.
  const only = process.argv.slice(2);
  const targets = only.length ? repos.filter((r) => only.includes(r.name)) : repos;
  if (only.length) {
    const found = targets.map((r) => r.name);
    const unknown = only.filter((n) => !found.includes(n));
    if (unknown.length) {
      console.error(`Unknown repo name(s): ${unknown.join(', ')}`);
      process.exit(1);
    }
    console.log(`Re-shooting ${targets.length} of ${repos.length}: ${found.join(', ')}`);
  }

  const browser = await chromium.launch();
  const results = new Array(targets.length);
  let i = 0;
  let done = 0;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < targets.length) {
        const idx = i++;
        results[idx] = await shoot(browser, targets[idx]);
        done++;
        const r = results[idx];
        const state = !r.hasPage ? 'no page' : r.ok ? (r.gated ? 'gated' : 'ok') : 'failed';
        console.log(`  [${done}/${targets.length}] ${r.name} — ${state}`);
      }
    })
  );
  await browser.close();

  // A filtered run must merge, not replace, or every other entry is lost.
  const existing = only.length
    ? JSON.parse(await readFile('data/shots.json', 'utf8').catch(() => '{}'))
    : {};
  const byName = { ...existing, ...Object.fromEntries(results.map((r) => [r.name, r])) };
  await writeFile('data/shots.json', JSON.stringify(byName, null, 1));

  const withPage = results.filter((r) => r.hasPage);
  console.log(`\nPages sites: ${withPage.length}`);
  console.log(`  captured:  ${results.filter((r) => r.ok).length}`);
  console.log(`  gated:     ${results.filter((r) => r.gated).length}`);
  console.log(`  failed:    ${withPage.filter((r) => !r.ok).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
