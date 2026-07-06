// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Bogdan Marian Vasaiu
// Mirror/variant dedup (mirrorHamming, default ON) + frontier feedback, fully
// offline (a local stub site, no browser, no model). What must hold:
//   - a locale twin (/docs vs /en/docs) and a UI-state query variant
//     (?panel=settings) of a kept page are DROPPED as mirrors;
//   - links found only on a dropped duplicate are NEVER followed (the mirror
//     cascade stops at its first page);
//   - sibling-SHAPED pages with genuinely different content (?v=1 vs ?v=2)
//     are BOTH kept — URL shape alone never drops anything;
//   - mirrorHamming: 0 restores the old keep-everything behaviour.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { crawlDocs } from '../src/index.mjs';

// ~90 words so a one-word edit lands within a small Hamming distance of the
// original (the property the mirror gate rests on — see simhash.test.mjs).
const TEXT_A =
  'The alpha guide describes the crawler in detail. It renders pages in a real browser, ' +
  'reveals hidden content behind tabs and accordions, and extracts the visible text verbatim ' +
  'into Markdown. The engine follows links inside the main content area, ranks them by task ' +
  'relevance, and asks the model which ones matter for the request. Every kept page is ' +
  'journaled to disk as soon as it is captured, so an interrupted run can be resumed later ' +
  'without re-rendering anything. Configuration lives in a single options object with ' +
  'conservative defaults chosen for precision over volume.';
const TEXT_A_TWIN = TEXT_A.replace('conservative defaults', 'careful defaults');
const TEXT_A_SETTINGS = TEXT_A + ' Settings panel: choose a theme, a language and a font size.';
const TEXT_B =
  'Setup is a different chapter entirely: install the package from the registry, create the ' +
  'configuration file, point it at your project and add the API key to the environment. The ' +
  'first run downloads the browser binaries and verifies the local model is reachable before ' +
  'any page is fetched. Troubleshooting starts with the health check command, which prints ' +
  'the provider, the model name and the round-trip latency for a tiny prompt.';
const TEXT_V1 =
  'Version one point zero shipped the initial engine: static extraction only, a single ' +
  'worker, no journal and no resume. Output was a flat text file and every crawl started ' +
  'from scratch. Known issues included duplicated navigation text on every page and missing ' +
  'content behind tabs, later fixed by the reveal loop introduced in the next release.';
const TEXT_V2 =
  'Version two point zero rewrote the frontier: parallel workers with their own browser ' +
  'contexts, an incremental journal for crash-safe persistence, resume of interrupted runs ' +
  'and an AI gate that decides which links matter for the task. The output became one ' +
  'consolidated Markdown file per link, with per-document packaging available on request.';

const TEXT_HOME =
  'Welcome to the project home page. Pick a chapter from the documentation below to get ' +
  'started, browse the release history, or read the setup instructions for your platform. ' +
  'This landing page carries its own short introduction so it is a page in its own right, ' +
  'not a duplicate of any chapter.';

const page = (title, text, links = []) =>
  `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${text}</p>
   ${links.map((l) => `<a href="${l}">${l}</a>`).join(' ')}</main></body></html>`;

// Keyed by pathname + search: the variant pages differ ONLY in the query string.
// The crawl enters at the ROOT (like a real "extract everything" run, where the
// docs profile applies no path prefix), so locale twins are inside the frontier.
const PAGES = {
  '/': page('Home', TEXT_HOME, [
    '/en/docs',
    '/docs',
    '/en/docs?panel=settings',
    '/en/docs/setup',
    '/en/docs/versions?v=1',
    '/en/docs/versions?v=2',
  ]),
  '/en/docs': page('Guide', TEXT_A),
  // locale twin of /en/docs (one-word difference → not an exact dup) + a trap link
  '/docs': page('Guide', TEXT_A_TWIN, ['/trap']),
  // UI-state variant of /en/docs (adds one sentence) + another trap link
  '/en/docs?panel=settings': page('Guide', TEXT_A_SETTINGS, ['/trap2']),
  '/en/docs/setup': page('Setup', TEXT_B),
  // sibling-SHAPED (same path, different query) but genuinely different content
  '/en/docs/versions?v=1': page('Versions v1', TEXT_V1),
  '/en/docs/versions?v=2': page('Versions v2', TEXT_V2),
  '/trap': page('Trap', 'Reachable only through a dropped duplicate. ' + TEXT_B),
  '/trap2': page('Trap 2', 'Reachable only through a dropped variant. ' + TEXT_V1),
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const key = (u.pathname.replace(/\/+$/, '') || '/') + u.search;
  const html = PAGES[key];
  if (!html) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});

let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// browser 'never' + model '' → static engine, heuristics, zero external network.
// Concurrency 1 keeps the visit order (and therefore who-dedups-whom) deterministic.
async function run(overrides = {}) {
  const events = [];
  const result = await crawlDocs([{ url: `${base}/`, task: 'Extract the documentation' }], {
    model: '',
    browser: 'never',
    concurrency: 1,
    onEvent: (ev) => events.push(ev),
    ...overrides,
  }).result;
  return { scan: result.scans[0], events, stats: result.stats };
}

test('mirror tier drops locale twin + query variant, keeps sibling-shaped real content', async () => {
  const { scan, events, stats } = await run();
  const kept = scan.pages.map((p) => p.url).sort();

  assert.deepEqual(kept, [
    `${base}/`,
    `${base}/en/docs`,
    `${base}/en/docs/setup`,
    `${base}/en/docs/versions?v=1`,
    `${base}/en/docs/versions?v=2`,
  ]);

  // both duplicates were dropped by the MIRROR tier (URL sibling + close content)…
  assert.equal(scan.stats.deduped.mirror, 2);
  assert.equal(stats.deduped.mirror, 2, 'run-level aggregation');
  const dedups = events.filter((e) => e.type === 'dedup');
  assert.deepEqual(dedups.map((e) => e.kind).sort(), ['mirror', 'mirror']);
  for (const e of dedups) assert.equal(e.of, `${base}/en/docs`);

  // …and their links were NOT followed: the traps were never even requested
  const touched = events.filter((e) => e.type === 'page').map((e) => e.url);
  assert.ok(!touched.some((u) => u.includes('/trap')), `traps must stay unvisited, saw: ${touched}`);
});

test('mirrorHamming: 0 turns the gate off — twins, variants and traps are all kept', async () => {
  const { scan } = await run({ mirrorHamming: 0 });
  const kept = scan.pages.map((p) => p.url);
  assert.ok(kept.includes(`${base}/docs`), 'locale twin kept when the gate is off');
  assert.ok(kept.includes(`${base}/en/docs?panel=settings`), 'query variant kept when the gate is off');
  assert.ok(kept.includes(`${base}/trap`), 'trap reached through the kept twin');
  assert.ok(kept.includes(`${base}/trap2`), 'trap2 reached through the kept variant');
  assert.equal(scan.stats.deduped.mirror, 0);
});
