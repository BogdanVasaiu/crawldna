// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Bogdan Marian Vasaiu
// #6 slice 3 — the hash-net, fully offline. The stub site has NO sitemap and sends
// NO validators, so every page is always re-crawled (nothing can be skipped). The
// hash-net's only job is to report the TRUTH: of the pages we had to re-crawl, how
// many were unchanged (content hash matches the baseline) vs actually changed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { crawlDocs } from '../src/index.mjs';

const body = (h1, para) => `<html><head><title>${h1}</title></head><body><main>
  <h1>${h1}</h1><p>${para}</p>
  <a href="/docs/b">Setup</a> <a href="/docs/c">Usage</a></main></body></html>`;

let bodies; // mutable: edit a page to simulate a real content change
let base;
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
  const html = bodies[p];
  if (!html) {
    res.writeHead(404, { 'content-type': 'text/plain' }); // no sitemap, no robots
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': 'text/html' }); // NB: no ETag / Last-Modified
  res.end(html);
});

let tmp;
let envCacheDir;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  bodies = {
    '/docs': body('Guide', 'Alpha section: the guide explains the first feature in detail.'),
    '/docs/b': body('Setup', 'Bravo section: install the package and configure the basics.'),
    '/docs/c': body('Usage', 'Charlie section: run the tool against your project.'),
  };
  tmp = await mkdtemp(path.join(os.tmpdir(), 'crawldna-hash-test-'));
  envCacheDir = process.env.CRAWLDNA_CACHE_DIR;
  delete process.env.CRAWLDNA_CACHE_DIR;
});
after(async () => {
  server.close();
  if (envCacheDir !== undefined) process.env.CRAWLDNA_CACHE_DIR = envCacheDir;
  await rm(tmp, { recursive: true, force: true });
});

const OPTS = () => ({ model: '', browser: 'never', concurrency: 1, incremental: true, cacheDir: tmp });
const pageByUrl = (scan, suffix) => scan.pages.find((p) => p.url.endsWith(suffix));

async function crawl() {
  const events = [];
  const run = crawlDocs([{ url: `${base}/docs`, task: 'Extract the documentation' }], {
    ...OPTS(),
    onEvent: (ev) => events.push(ev),
  });
  const result = await run.result;
  return { result, events, done: events.find((e) => e.type === 'incremental' && e.phase === 'done') };
}

test('first crawl (no signals): full crawl, stamps a content hash per page', async () => {
  const { result, done } = await crawl();
  assert.equal(result.scans[0].pages.length, 3);
  assert.equal(done.reused, 0);
  assert.equal(done.recrawled, 3);
  for (const p of result.scans[0].pages) assert.ok(p.meta.contentHash, 'each page carries a content hash');
});

test('second crawl (nothing changed): all re-crawled, hash-net reports all unchanged', async () => {
  const { done } = await crawl();
  assert.equal(done.reused, 0, 'nothing can be skipped (no sitemap/validators)');
  assert.equal(done.recrawled, 3);
  assert.equal(done.unchangedByHash, 3, 'the hash-net confirms all three were identical to the baseline');
});

test('third crawl (one page edited): hash-net reports exactly one changed', async () => {
  bodies['/docs/b'] = body('Setup', 'Bravo section REWRITTEN: the setup steps changed materially this release.');
  const { result, done } = await crawl();
  assert.equal(done.recrawled, 3);
  assert.equal(done.unchangedByHash, 2, 'two unchanged, one genuinely changed');
  assert.ok(pageByUrl(result.scans[0], '/docs/b').markdown.includes('REWRITTEN'), 'the changed content is captured');
});
