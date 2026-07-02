// Transient-failure retry in the OpenAI-compatible transport: 429/5xx (and network
// resets) are ROUTINE on a paid API under a crawl's call volume, and a failed
// judgment call triggers the "follow/keep everything" completeness fallback — so the
// transport must absorb transient errors instead of surfacing them. Local stub
// server scripts a response sequence — no external network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chat } from '../src/lib/llm.mjs';

let script = []; // each entry: { status, headers?, body? } — shifted per request
let hits = 0;
const ok = JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    hits++;
    const step = script.shift() || { status: 200 };
    res.writeHead(step.status, { 'content-type': 'application/json', ...(step.headers || {}) });
    res.end(step.body ?? (step.status === 200 ? ok : JSON.stringify({ error: 'nope' })));
  });
});

let llm;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  llm = { provider: 'openai', model: 'stub', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'k' };
});
after(() => server.close());

test('429 is retried (honouring Retry-After) and the call succeeds', async () => {
  script = [{ status: 429, headers: { 'retry-after': '0.01' } }];
  hits = 0;
  assert.equal(await chat(llm, 'sys', 'user'), 'ok');
  assert.equal(hits, 2, 'one retry after the 429');
});

test('5xx is retried with backoff up to twice, then succeeds', async () => {
  script = [{ status: 503 }, { status: 502, headers: { 'retry-after': '0.01' } }];
  hits = 0;
  assert.equal(await chat(llm, 'sys', 'user'), 'ok');
  assert.equal(hits, 3, 'two retries, third attempt wins');
});

test('a persistent 429 gives up after the retry budget and surfaces the error', async () => {
  script = [
    { status: 429, headers: { 'retry-after': '0.01' } },
    { status: 429, headers: { 'retry-after': '0.01' } },
    { status: 429, headers: { 'retry-after': '0.01' } },
  ];
  hits = 0;
  await assert.rejects(() => chat(llm, 'sys', 'user'), /LLM HTTP 429/);
  assert.equal(hits, 3, 'initial call + 2 retries, no more');
});

test('a non-transient error (401) is NOT retried', async () => {
  script = [{ status: 401 }];
  hits = 0;
  await assert.rejects(() => chat(llm, 'sys', 'user'), /LLM HTTP 401/);
  assert.equal(hits, 1);
});

test('schema rejection still degrades to no-response_format, and retry survives it', async () => {
  // 1st call (with response_format) → 400; immediate degrade-resend → 429; retried → 200.
  script = [{ status: 400 }, { status: 429, headers: { 'retry-after': '0.01' } }];
  hits = 0;
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  assert.equal(await chat(llm, 'sys', 'user', schema), 'ok');
  assert.equal(hits, 3);
});
