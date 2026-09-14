#!/usr/bin/env node
// Captures four INTERIOR views per demo into public/shots/gallery/<name>-{1..4}.jpg and
// records them under `gallery` in data/shots.json.
//
// Why this is separate from screenshot-pages.mjs: that script owns the card image, the
// `gated` flag and the siteOk health check, and the card image is deliberately still the
// gate screen. This script only ever adds a `gallery` key to an existing entry.
//
// The point of it is that the catalogue could not previously photograph a gated demo:
// 51 of 53 live demos were represented by their access screen. With the codes in
// data/access-codes.json the gate can be opened and the product itself captured.
//
// Usage:
//   node scripts/screenshot-gallery.mjs                 # every live demo
//   node scripts/screenshot-gallery.mjs ChorusNZ SutelCR
//   node scripts/screenshot-gallery.mjs ChorusNZ --keep  # leave existing galleries alone

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT_DIR = path.join(process.cwd(), 'public', 'shots', 'gallery');
const CONCURRENCY = 4;
// The lightbox renders around 700-1000px wide, so 1280 is display size plus headroom.
// Measured on the pilot: 1600px/q78 averaged 157KB per dashboard screenshot, which across
// 53 demos would have added 32MB to the app bundle; 1280px/q72 averages 98KB for ~20MB.
const VIEWPORT = { width: 1280, height: 800 };
const SCALE = 1;
const QUALITY = 72;
const SHOTS_PER_DEMO = 4;
// A route that renders almost no text is a 404 or a dead client route, not a view. One demo
// answered every nav link with a blank page and produced four identical white frames.
const MIN_WORDS = 25;
// ...and the same demo also served pages whose text sat outside the viewport, so the frame
// was blank even though the document was not. Measured in characters visible on screen.
const MIN_INK = 40;

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

const CODE_FIELD =
  'input[type=password], input[name*=code i], input[placeholder*=code i], input[placeholder*=password i]';

// Kept identical to screenshot-pages.mjs so "is there still a gate?" means the same thing
// in both scripts.
const GATE_MAX_CONTROLS = 8;

async function detectGate(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      );
    };
    const fields = [
      ...document.querySelectorAll(
        'input[type=password], input[name*=code i], input[placeholder*=code i], input[placeholder*=password i]'
      ),
    ].filter(visible);
    const controls = [
      ...document.querySelectorAll('button, a[href], select, textarea, input'),
    ].filter(visible).length;
    return { hasCodeField: fields.length > 0, controls };
  });
}

const isGate = (g) => g.hasCodeField && g.controls <= GATE_MAX_CONTROLS;

/** Poll rendered text until it stops growing; `networkidle` fires before a SPA has painted. */
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
      if ((words >= minWords && quiet >= quietMs) || quiet >= quietMs * 3) return words;
    }
    await page.waitForTimeout(250);
  }
  return last;
}

/**
 * Type the code and submit. Enter alone opens every gate measured so far; the button click
 * is a fallback for a gate whose form does not submit on Enter.
 */
async function unlock(page, code) {
  const field = page.locator(CODE_FIELD).first();
  await field.fill(code, { timeout: 5000 });
  await field.press('Enter');
  await page.waitForTimeout(1500);
  if (!isGate(await detectGate(page))) return true;

  const button = page
    .locator('button[type=submit], form button, button:has-text("Enter"), button:has-text("Ingresar")')
    .first();
  if (await button.count()) {
    await button.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  return !isGate(await detectGate(page));
}

/**
 * Interior routes, read from the nav. No demo publishes a sitemap.xml (checked: they 404),
 * so the nav DOM is the only route index available. Nav links are preferred over every
 * anchor on the page because the latter picks up footer credits and external links.
 *
 * Distinct paths come first, then query/hash variants of those paths. Some demos route
 * sections by path (/dashboard, /campaign) and others by query or hash on a single page;
 * collapsing the latter treated a ten-section portal as one view and sent it to the
 * scroll fallback, so both are collected and paths simply rank higher.
 */
async function discoverRoutes(page, basePath) {
  return page.evaluate((base) => {
    const clean = (text) => (text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const collect = (selector) =>
      [...document.querySelectorAll(selector)]
        .filter((a) => {
          const rect = a.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((a) => ({ href: a.href, label: clean(a.innerText || a.textContent) }));

    let links = collect('nav a[href], header a[href], aside a[href], [role=navigation] a[href]');
    if (links.length < 2) links = collect('a[href]');

    const here = location.origin;
    const root = base.replace(/\/$/, '');
    const paths = [];
    const variants = [];
    const seenPath = new Set();
    const seenFull = new Set();

    for (const { href, label } of links) {
      let u;
      try {
        u = new URL(href);
      } catch {
        continue;
      }
      if (u.origin !== here) continue;
      const pathKey = u.pathname.replace(/\/$/, '');
      if (!pathKey.startsWith(root)) continue;
      const fullKey = pathKey + u.search + u.hash;
      if (seenFull.has(fullKey)) continue;
      seenFull.add(fullKey);
      const entry = { url: `${u.origin}${u.pathname}${u.search}${u.hash}`, label };
      const isRoot = pathKey === root;
      if (!seenPath.has(pathKey) && !isRoot) {
        seenPath.add(pathKey);
        paths.push(entry);
      } else if (u.search || u.hash) {
        variants.push(entry);
      }
    }
    return [...paths, ...variants];
  }, basePath);
}

/** The headings on screen: the page's own h1, and everything near the top of the viewport. */
async function headings(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      );
    };
    const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();
    // innerText for headings built from several spans: textContent concatenates them with no
    // separator, which produced labels like "Why SnowflakePlatform story".
    const label = (el) => clean(el.innerText || el.textContent);
    const all = [...document.querySelectorAll('h1, h2, h3')].filter(visible);
    const inView = all
      .map((h) => ({ h, top: h.getBoundingClientRect().top }))
      .filter((x) => x.top > -40 && x.top < window.innerHeight * 0.8)
      .sort((a, b) => a.top - b.top)
      .map((x) => label(x.h))
      .filter(Boolean);
    const h1 = all.find((h) => h.tagName === 'H1');
    return { h1: h1 ? label(h1) : '', inView };
  });
}

// Nav labels arrive decorated: a trailing arrow glyph, or a notification count glued to the
// last word ("Featured Summit demos10").
const sanitizeLabel = (text) =>
  (text || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u2192\u2197\u203a\u00bb>]+/g, '')
    .replace(/([A-Za-z])\d{1,3}$/, '$1')
    .trim();

// "Open the demo", "View Architecture" — link text written to be clicked, not to name a view.
const CTA = /^(open|view|go|see|launch|enter|explore|start|read|try|click)\b/i;

/**
 * The nav label is the author's own name for the view, so it wins by default. It loses when
 * it reads as a call to action, or is too long to sit under a thumbnail, in which case the
 * destination page's own h1 describes the view better — and failing that, the route itself
 * does. "/architecture" beats the link text "View Architecture" as a caption.
 */
function pickCandidate(navLabel, head, url) {
  const nav = sanitizeLabel(navLabel);
  const h1 = sanitizeLabel(head.h1 || head.inView[0]);
  if (nav && !CTA.test(nav) && nav.length <= 34) return nav;
  if (h1 && h1.length <= 34) return h1;
  const slug = fromPath(url);
  if (slug) return slug;
  return nav ? nav.slice(0, 34).trim() : '';
}

/** "/SnowTelco_Summit26/command-center" -> "Command center", "/SutelCR/#inicio" -> "Inicio".
 *  The fragment is preferred when there is one, because for a hash-routed section the path
 *  is just the demo root and would caption every section with the repo name. */
function fromPath(url) {
  try {
    const u = new URL(url);
    const segment = u.hash
      ? u.hash.replace(/^#/, '')
      : u.pathname.replace(/\/$/, '').split('/').pop() || '';
    // Hash routes are often written as "#/portal", so the slashes have to come off too.
    const words = decodeURIComponent(segment).replace(/^\/+|\/+$/g, '').replace(/[-_/]+/g, ' ').trim();
    if (!words || words.length > 34) return '';
    return words.charAt(0).toUpperCase() + words.slice(1);
  } catch {
    return '';
  }
}

/** A scrolled frame is captioned by a nearby heading, but only a short one: the long ones
 *  are body sentences, which read as noise under a thumbnail. */
const scrollCandidate = (head) =>
  head.inView.map(sanitizeLabel).find((t) => t && t.length <= 32) || '';

function uniqueLabel(candidate, index, used) {
  let label = candidate || `View ${index}`;
  if (used.has(label.toLowerCase())) label = 'Continued';
  let n = 2;
  while (used.has(label.toLowerCase())) label = `Continued ${n++}`;
  used.add(label.toLowerCase());
  return label;
}

/**
 * How much text is actually on screen right now.
 *
 * settle() counts the whole document, which says nothing about the frame being captured:
 * one demo answered its nav links with pages whose content sat outside the viewport, and a
 * scroll offset can land past the end of real content in a container taller than what it
 * holds. Both produced blank white screenshots that passed every document-level check.
 */
async function viewportInk(page) {
  return page
    .evaluate(() => {
      let chars = 0;
      for (const el of document.body.querySelectorAll('*')) {
        if (el.children.length) continue;
        const rect = el.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
        if (rect.width <= 0 || rect.height <= 0) continue;
        chars += (el.textContent || '').trim().length;
      }
      return chars;
    })
    .catch(() => 0);
}

/**
 * Screenshot to a buffer first, so a frame identical to one already taken for this demo can
 * be discarded and the next candidate tried instead.
 *
 * Without this the galleries contained repeats: some demos carry query-string nav links
 * their client ignores, so two routes paint the same pixels, and a page shorter than the
 * viewport cannot scroll, so every scrolled frame is the same picture.
 */
async function capture(page, name, index, seen) {
  const buffer = await page.screenshot({ type: 'jpeg', quality: QUALITY });
  const hash = createHash('md5').update(buffer).digest('hex');
  if (seen.has(hash)) return null;
  seen.add(hash);
  const file = `${name}-${index}.jpg`;
  await writeFile(path.join(OUT_DIR, file), buffer);
  return `shots/gallery/${file}`;
}

async function shootGallery(browser, repo, code) {
  const res = await gh(`https://api.github.com/repos/${repo.nameWithOwner}/pages`);
  if (!res.ok) return { name: repo.name, skipped: 'no pages site' };
  const info = await res.json();
  const url = info.html_url;
  const basePath = new URL(url).pathname;

  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  const page = await context.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    if ((resp?.status() ?? 0) >= 400) {
      await context.close();
      return { name: repo.name, skipped: `site returned ${resp?.status()}` };
    }
    await settle(page);

    let unlocked = null;
    if (isGate(await detectGate(page))) {
      if (!code) {
        await context.close();
        return { name: repo.name, skipped: 'gated and no code on file', unlocked: false };
      }
      unlocked = await unlock(page, code);
      if (!unlocked) {
        await context.close();
        return { name: repo.name, skipped: 'gate did not open', unlocked: false };
      }
      await settle(page);
    }

    const routes = await discoverRoutes(page, basePath);
    const gallery = [];
    const used = new Set();
    const seen = new Set();

    // Every route is a candidate, not just the first four: blank pages and repeats are
    // rejected below, so the list has to be longer than the number of slots.
    for (const route of routes) {
      if (gallery.length >= SHOTS_PER_DEMO) break;
      await page.goto(route.url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
      // A gate can reappear on a deep link if the unlock is per-tab; re-entering is cheap.
      if (isGate(await detectGate(page)) && code) await unlock(page, code);
      const words = await settle(page);
      if (words < MIN_WORDS) continue;
      await page.waitForTimeout(400);
      if ((await viewportInk(page)) < MIN_INK) continue;
      const index = gallery.length + 1;
      const file = await capture(page, repo.name, index, seen);
      if (!file) continue;
      const label = uniqueLabel(
        pickCandidate(route.label, await headings(page), route.url),
        index,
        used
      );
      gallery.push({ file, label, url: route.url });
    }

    // Single-page demos, and demos whose nav exposes fewer than four links, are topped up
    // with scrolled views of the main page. Four frames of one long page still shows the
    // product; three blanks would not.
    if (gallery.length < SHOTS_PER_DEMO) {
      const target = routes[0]?.url ?? url;
      await page.goto(target, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
      if (isGate(await detectGate(page)) && code) await unlock(page, code);
      await settle(page);
      const height = await page.evaluate(() => document.body.scrollHeight);
      const step = Math.max(600, Math.floor((height - VIEWPORT.height) / SHOTS_PER_DEMO));
      let offset = gallery.length ? step : 0;
      let attempts = 0;
      while (gallery.length < SHOTS_PER_DEMO && attempts < SHOTS_PER_DEMO * 3) {
        attempts++;
        const atTop = offset === 0;
        await page.evaluate((y) => window.scrollTo(0, y), offset);
        await page.waitForTimeout(600);
        offset += step;
        if ((await viewportInk(page)) < MIN_INK) {
          if (offset > height) break;
          continue;
        }
        const index = gallery.length + 1;
        const file = await capture(page, repo.name, index, seen);
        if (file) {
          // These frames are all one page, so when there is no heading to name them the
          // honest caption says where you are on it, not "View 3".
          const candidate =
            scrollCandidate(await headings(page)) || (atTop ? 'Overview' : 'Continued');
          gallery.push({ file, label: uniqueLabel(candidate, index, used), url: target });
        }
        if (offset > height) break;
      }
    }

    await context.close();
    return { name: repo.name, gallery, unlocked };
  } catch (err) {
    await context.close().catch(() => {});
    return { name: repo.name, skipped: err.message.split('\n')[0] };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes('--keep');
  const only = args.filter((a) => !a.startsWith('--'));

  const { repos } = JSON.parse(await readFile('data/repos.json', 'utf8'));
  const shots = JSON.parse(await readFile('data/shots.json', 'utf8'));
  const codes = JSON.parse(await readFile('data/access-codes.json', 'utf8').catch(() => '{}'));
  await mkdir(OUT_DIR, { recursive: true });

  let targets = repos.filter((r) => shots[r.name]?.hasPage && shots[r.name]?.ok);
  if (only.length) {
    targets = repos.filter((r) => only.includes(r.name));
    const unknown = only.filter((n) => !targets.some((t) => t.name === n));
    if (unknown.length) {
      console.error(`Unknown repo name(s): ${unknown.join(', ')}`);
      process.exit(1);
    }
  }
  if (keep) targets = targets.filter((r) => !shots[r.name]?.gallery?.length);

  console.log(`Capturing ${SHOTS_PER_DEMO} interior views for ${targets.length} demos...`);

  // A re-run has to be idempotent: clear this demo's old frames first, so a demo that now
  // yields three views does not keep a stale fourth file from a previous run.
  for (const repo of targets) {
    for (let i = 1; i <= SHOTS_PER_DEMO; i++) {
      await rm(path.join(OUT_DIR, `${repo.name}-${i}.jpg`), { force: true });
    }
  }

  const browser = await chromium.launch();
  const results = new Array(targets.length);
  let i = 0;
  let done = 0;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < targets.length) {
        const idx = i++;
        const repo = targets[idx];
        results[idx] = await shootGallery(browser, repo, codes[repo.name]);
        done++;
        const r = results[idx];
        const state = r.skipped ? `skipped — ${r.skipped}` : `${r.gallery.length} views`;
        console.log(`  [${done}/${targets.length}] ${r.name} — ${state}`);
      }
    })
  );
  await browser.close();

  // Merge at the entry level: every other field on a shots.json entry belongs to
  // screenshot-pages.mjs and must survive untouched. The old keys are dropped first so a
  // demo whose views all turned out to be blank stops advertising a gallery.
  const merged = { ...shots };
  for (const r of results) {
    if (!merged[r.name]) merged[r.name] = {};
    delete merged[r.name].gallery;
    delete merged[r.name].galleryUnlocked;
    if (!r.gallery?.length) continue;
    merged[r.name].gallery = r.gallery;
    if (r.unlocked !== null && r.unlocked !== undefined) merged[r.name].galleryUnlocked = r.unlocked;
  }
  await writeFile('data/shots.json', JSON.stringify(merged, null, 1));

  const ok = results.filter((r) => r.gallery?.length);
  const short = ok.filter((r) => r.gallery.length < SHOTS_PER_DEMO);
  const skipped = results.filter((r) => r.skipped);
  console.log(`\nGalleries written: ${ok.length}`);
  console.log(`  full ${SHOTS_PER_DEMO} views: ${ok.length - short.length}`);
  if (short.length) {
    console.log(`  fewer than ${SHOTS_PER_DEMO}: ${short.map((r) => `${r.name} (${r.gallery.length})`).join(', ')}`);
  }
  if (skipped.length) {
    console.log(`  skipped (${skipped.length}):`);
    for (const r of skipped) console.log(`    ${r.name} — ${r.skipped}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
