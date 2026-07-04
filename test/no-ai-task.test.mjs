// #23 — with noAi the task has NO role at all (rule #6 to its end: the task
// speaks only to the AI, and there is no AI). Fully offline. The contract:
//   - an explicit task (shared option OR per-target) is refused synchronously;
//   - minRelevance > 0 is refused too (its score IS task-relevance);
//   - without a task the crawl runs and output files are named from the SITE;
//   - the default task never leaks into ordering or naming (it is dropped).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { crawlDocs } from '../src/index.mjs';
import { assembleScan, assemblePerDocument } from '../src/lib/layout.mjs';

// --- loud refusals (synchronous — no server, no browser) ---------------------

test('noAi + explicit shared task is refused with a clear reason', () => {
  assert.throws(
    () => crawlDocs(['https://x.dev/'], { noAi: true, task: 'Extract the prices' }),
    /task speaks only to the model/,
  );
});

test('noAi + per-target task is refused too — same contract, every shape', () => {
  assert.throws(
    () => crawlDocs([{ url: 'https://x.dev/', task: 'Extract the prices' }], { noAi: true }),
    /task speaks only to the model/,
  );
});

test('noAi + minRelevance is refused: its score IS task-relevance', () => {
  assert.throws(
    () => crawlDocs(['https://x.dev/'], { noAi: true, minRelevance: 0.5 }),
    /minRelevance scores links against the task/,
  );
});

test('noAi without a task (and minRelevance 0) is accepted', async () => {
  // Unreachable target on purpose: construction must NOT throw; the run itself
  // just produces an empty scan. stop() right away keeps it instant.
  const run = crawlDocs(['http://127.0.0.1:1/'], { noAi: true, browser: 'never' });
  run.stop();
  const result = await run.result;
  assert.equal(result.scans.length, 1);
});

// --- naming: a task-less scan is named from its site -------------------------

test('assembleScan without a task names the file from the host', () => {
  const files = assembleScan({
    task: '',
    pages: [{ url: 'https://docs.example.com/guide', title: 'Guide', markdown: 'Hello world.' }],
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'docs-example-com.md');
  assert.match(files[0].markdown, /task: ""/, 'front-matter stays honest: there was no task');
});

test('assembleScan with a task keeps the task-derived name (unchanged behaviour)', () => {
  const files = assembleScan({
    task: 'Extract the room prices',
    pages: [{ url: 'https://hotel.example/rooms', title: 'Rooms', markdown: 'From 90 EUR.' }],
  });
  assert.equal(files[0].filename, 'room-prices.md');
});

test('per-document index title falls back to the site when there is no task', () => {
  const { index } = assemblePerDocument({
    task: '',
    pages: [{ url: 'https://docs.example.com/guide', title: 'Guide', markdown: 'Hello world.' }],
  });
  assert.match(index.markdown.split('\n')[0], /^# Docs Example Com/);
});

// --- end to end: a no-AI crawl of a stub site works and is named by the site --

const PAGE = `<html><head><title>Listino</title></head><body><main>
  <h1>Listino prezzi</h1><p>Camera doppia 90 EUR a notte, colazione inclusa; la suite
  panoramica 150 EUR con vista lago e accesso alla spa dell'albergo.</p></main></body></html>`;

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/llms-full.txt' || p === '/sitemap.xml' || p === '/robots.txt') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('no');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});

let site;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('noAi end to end: zero model calls, file named from the site, content verbatim', async () => {
  const run = crawlDocs([`${site}/listino`], { noAi: true, browser: 'never', concurrency: 1 });
  const result = await run.result;
  const scan = result.scans[0];
  assert.equal(result.stats.tokens.calls, 0, 'rule #6 is absolute');
  assert.equal(scan.files.length, 1);
  assert.match(scan.files[0].filename, /^127-0-0-1/, 'named from the site, not from any task');
  assert.match(scan.files[0].markdown, /Camera doppia 90 EUR/, 'content stays verbatim');
});
