// #6 slice 2 — HTTP 304 tier of the incremental re-crawl, fully offline. The stub
// site has NO sitemap (so the lastmod tier does nothing) but serves ETags and
// honours If-None-Match. A re-crawl confirms unchanged pages with a conditional GET
// (a 304) and reuses them without rendering; a changed ETag forces a re-crawl.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { crawlDocs } from '../src/index.mjs';
import { conditionalGet } from '../src/lib/fetcher.mjs';

const PAGES = {
  '/docs': `<html><head><title>Guide</title></head><body><main>
    <h1>Guide</h1><p>Alpha section: the guide explains the first feature in detail.</p>
    <a href="/docs/b">Setup</a> <a href="/docs/c">Usage</a></main></body></html>`,
  '/docs/b': `<html><head><title>Setup</title></head><body><main>
    <h1>Setup</h1><p>Bravo section: install the package and configure the basics.</p>
    <a href="/docs/c">Usage</a></main></body></html>`,
  '/docs/c': `<html><head><title>Usage</title></head><body><main>
    <h1>Usage</h1><p>Charlie section: run the tool against your project.</p></main></body></html>`,
};

let etags; // mutable: flip one to simulate a page changing
let base;
let served; // request log for the current crawl: { full:[paths], notModified:[paths] }

const server = http.createServer((req, res) => {
  if (!served) served = { full: [], notModified: [] }; // requests can arrive before/between crawls
  const p = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
  const html = PAGES[p];
  if (!html) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found'); // no sitemap/robots → 404
  }
  const inm = req.headers['if-none-match'];
  if (inm && inm === etags[p]) {
    served.notModified.push(p);
    res.writeHead(304, { etag: etags[p] });
    return res.end();
  }
  served.full.push(p);
  res.writeHead(200, { 'content-type': 'text/html', etag: etags[p] });
  res.end(html);
});

let tmp;
let envCacheDir;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  etags = { '/docs': '"v1-docs"', '/docs/b': '"v1-b"', '/docs/c': '"v1-c"' };
  served = { full: [], notModified: [] };
  tmp = await mkdtemp(path.join(os.tmpdir(), 'crawldna-304-test-'));
  envCacheDir = process.env.CRAWLDNA_CACHE_DIR;
  delete process.env.CRAWLDNA_CACHE_DIR;
});
after(async () => {
  server.close();
  if (envCacheDir !== undefined) process.env.CRAWLDNA_CACHE_DIR = envCacheDir;
  await rm(tmp, { recursive: true, force: true });
});

const OPTS = () => ({ model: '', browser: 'never', concurrency: 1, incremental: true, cacheDir: tmp });
const sortedPages = (scan) =>
  scan.pages.map((p) => ({ url: p.url, markdown: p.markdown })).sort((a, b) => (a.url < b.url ? -1 : 1));

async function crawl() {
  served = { full: [], notModified: [] };
  const events = [];
  const run = crawlDocs([{ url: `${base}/docs`, task: 'Extract the documentation' }], {
    ...OPTS(),
    onEvent: (ev) => events.push(ev),
  });
  const result = await run.result;
  return { result, events, scanId: result.scans[0].scanId, served };
}

test('conditionalGet: matching ETag → 304 (unchanged); wrong/absent → not', async () => {
  const hit = await conditionalGet(`${base}/docs`, { etag: etags['/docs'] });
  assert.equal(hit.notModified, true);
  const miss = await conditionalGet(`${base}/docs`, { etag: '"stale"' });
  assert.equal(miss.notModified, false);
  assert.equal(miss.status, 200);
  const nothing = await conditionalGet(`${base}/docs`, {});
  assert.equal(nothing.notModified, false, 'no validators → nothing to ask');
});

let baselinePages;
test('first incremental crawl (no sitemap): full crawl, stamps ETags, retains journal', async () => {
  const { result, served: s } = await crawl();
  baselinePages = sortedPages(result.scans[0]);
  assert.equal(baselinePages.length, 3);
  for (const p of result.scans[0].pages) {
    assert.equal(p.meta.httpEtag, etags[new URL(p.url).pathname], 'each page carries its ETag');
  }
  assert.equal(s.notModified.length, 0, 'no conditional requests on the first run');
  await stat(path.join(tmp, result.run.id, result.scans[0].scanId, 'pages.jsonl')); // retained
});

test('second crawl (nothing changed): pages confirmed via 304, never re-served in full', async () => {
  const { result, events, served: s } = await crawl();
  const plan = events.find((e) => e.type === 'incremental' && e.phase === 'plan');
  assert.equal(plan.via304, 3, 'all three confirmed unchanged by a 304');
  assert.equal(plan.viaLastmod, 0, 'no sitemap lastmod in play');
  assert.deepEqual(sortedPages(result.scans[0]), baselinePages, 'reused output is identical');
  // The proof it was not re-rendered: the server answered 304, never a full body.
  assert.deepEqual(s.full.sort(), [], 'no page body was re-served');
  assert.equal(s.notModified.length, 3);
});

test('third crawl (one ETag changed): only that page is re-crawled', async () => {
  etags['/docs/b'] = '"v2-b"';
  const { result, events, served: s } = await crawl();
  const plan = events.find((e) => e.type === 'incremental' && e.phase === 'plan');
  assert.equal(plan.via304, 2, 'the two unchanged pages are reused via 304');
  // /docs/b is the ONLY page served in full (its conditional GET got a 200, then it was
  // re-crawled); /docs and /docs/c were never re-served.
  assert.deepEqual([...new Set(s.full)], ['/docs/b'], 'only the changed page was fetched in full');
  assert.deepEqual(sortedPages(result.scans[0]), baselinePages, 'full page set still present and identical');
});
