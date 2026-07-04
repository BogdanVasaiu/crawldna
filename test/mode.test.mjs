// #20 — the explicit `mode` option (complete / targeted / auto), fully offline
// (local stub site + local OpenAI-compatible stub; no browser, no model, no
// external network). The acceptance criteria from TODO.md:
//   - complete (the DEFAULT since #23): docs shortcuts always tried, pages kept
//     WHOLE, ZERO link-gate calls even with AI on (works with noAi too);
//   - auto: identical to the historical behaviour (the task regex decides) —
//     reachable only BY NAME (old scripts, saved/resumed runs), never the default;
//   - targeted: the task-driven path regardless of the task's wording;
//     targeted + noAi is refused loudly, never silently;
//   - library contract: flat option, misuse fails fast.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { crawlDocs } from '../src/index.mjs';
import { modeBehavior } from '../src/lib/task.mjs';
import { decideFollow } from '../src/engine/crawl-page.mjs';

// --- unit: modeBehavior — the single mode→engine-switches translation --------

test('modeBehavior: auto keeps the historical mapping (the task regex decides)', () => {
  assert.deepEqual(modeBehavior('auto', 'Estrai tutta la documentazione'), {
    mode: 'auto', docsShortcuts: true, scopeSections: false, linkGate: true,
  });
  assert.deepEqual(modeBehavior('auto', 'Extract the full menu'), {
    mode: 'auto', docsShortcuts: false, scopeSections: true, linkGate: true,
  });
  // An absent mode (older library callers, saved runs) resolves to auto here;
  // crawlDocs validates explicit values loudly before this is ever consulted.
  assert.deepEqual(modeBehavior(undefined, 'Extract the docs'), modeBehavior('auto', 'Extract the docs'));
});

test('modeBehavior: complete = shortcuts + whole pages + no gate, whatever the task says', () => {
  for (const task of ['Extract the full menu', 'Estrai la documentazione', '']) {
    assert.deepEqual(modeBehavior('complete', task), {
      mode: 'complete', docsShortcuts: true, scopeSections: false, linkGate: false,
    });
  }
});

test('modeBehavior: targeted = gate + scoping, even for a docs-sounding task', () => {
  for (const task of ['Extract all documentation', 'the pizza menu']) {
    assert.deepEqual(modeBehavior('targeted', task), {
      mode: 'targeted', docsShortcuts: false, scopeSections: true, linkGate: true,
    });
  }
});

// --- library contract: misuse is refused FAST and LOUD -----------------------

test('targeted + noAi is refused synchronously with a clear reason (never silently)', () => {
  assert.throws(() => crawlDocs(['https://x.dev/'], { mode: 'targeted', noAi: true }), /needs AI/);
});

test('an unknown mode is rejected, not silently coerced', () => {
  assert.throws(() => crawlDocs(['https://x.dev/'], { mode: 'sideways' }), /Unknown mode/);
});

// --- the link gate: zero calls in complete, consulted in targeted/auto -------
// Local OpenAI-compatible stub whose verdict is always "follow NOTHING": if a
// gate call ever leaks through in complete mode, the result flips — the stub
// answers the OPPOSITE of what the mode must do.

let calls = 0;
const stubServer = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    calls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"follow":[]}' } }], usage: {} }));
  });
});

// Local stub SITE: an entry page (+ a menu page) and a publisher llms-full.txt
// export, so the docs profile's tier-1 shortcut can be observed offline.
const LLMS_FULL = [
  '# Antipasti',
  '',
  'Bruschetta al pomodoro — pane tostato, pomodorini, basilico fresco e olio del Garda.',
  'Tagliere misto — selezione di salumi e formaggi locali con mostarda di frutta.',
  '',
  '# Pizze',
  '',
  'Margherita — pomodoro San Marzano, fiordilatte, basilico. La classica di sempre.',
  'Diavola — pomodoro, mozzarella, spianata piccante calabrese e olio al peperoncino.',
  'Quattro stagioni — carciofi, prosciutto cotto, funghi champignon e olive nere.',
  '',
  '# Dolci',
  '',
  'Tiramisù della casa — savoiardi, mascarpone e caffè della moka, cacao amaro.',
  'Panna cotta — con coulis di frutti di bosco raccolti in altura.',
].join('\n');

const SITE_PAGES = {
  '/menu': `<html><head><title>Menu</title></head><body><main>
    <h1>Il menu</h1><p>La nostra cucina propone piatti della tradizione, preparati ogni
    giorno con ingredienti freschi di stagione e una selezione di vini del territorio.</p>
    <a href="/menu/pizze">Pizze</a></main></body></html>`,
  '/menu/pizze': `<html><head><title>Pizze</title></head><body><main>
    <h1>Pizze</h1><p>Margherita, Diavola e Quattro stagioni: impasto a lunga lievitazione,
    cottura nel forno a legna, pomodoro San Marzano e fiordilatte.</p></main></body></html>`,
};
const siteServer = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
  if (p === '/llms-full.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(LLMS_FULL);
  }
  const html = SITE_PAGES[p];
  if (!html) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});

let llm;
let site;
before(async () => {
  await new Promise((r) => stubServer.listen(0, '127.0.0.1', r));
  llm = { provider: 'openai', model: 'stub', baseUrl: `http://127.0.0.1:${stubServer.address().port}/v1`, apiKey: 'k' };
  await new Promise((r) => siteServer.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${siteServer.address().port}`;
});
after(() => {
  stubServer.close();
  siteServer.close();
});

const links = (n) => Array.from({ length: n }, (_, i) => ({ href: `https://s.it/p${i}`, label: `L${i}` }));

test('complete mode: every in-scope link followed with ZERO gate calls, AI on', async () => {
  calls = 0;
  const ctx = { currentScan: {}, options: { llm, mode: 'complete', minRelevance: 0 } };
  const keep = await decideFollow(ctx, 'Extract the full menu', links(5));
  assert.equal(keep.length, 5, 'no link gate: all candidates are followed');
  assert.equal(calls, 0, 'complete mode must never call the link gate');
});

test('complete mode: the explicit minRelevance opt-in still prunes, still zero calls', async () => {
  calls = 0;
  const cands = [
    { href: 'https://s.it/documentazione/intro', label: 'Documentazione' },
    { href: 'https://s.it/contatti', label: 'Contatti' },
  ];
  const ctx = { currentScan: {}, options: { llm, mode: 'complete', minRelevance: 0.5 } };
  const keep = await decideFollow(ctx, 'estrai la documentazione', cands);
  assert.deepEqual(keep, ['https://s.it/documentazione/intro']);
  assert.equal(calls, 0);
});

test('targeted mode: the gate is consulted and its verdict honoured', async () => {
  calls = 0;
  const ctx = { currentScan: {}, options: { llm, mode: 'targeted', minRelevance: 0 } };
  const keep = await decideFollow(ctx, 'Extract all documentation', links(3));
  assert.deepEqual(keep, [], 'the stub said follow NOTHING — targeted obeys');
  assert.ok(calls > 0, 'targeted mode consults the model');
});

test('auto mode (engine-level fallback): the gate runs exactly as before — regression guard', async () => {
  // A ctx WITHOUT a mode key resolves to 'auto' deep in the engine (saved runs,
  // direct engine callers). crawlDocs itself now always sets an explicit mode,
  // defaulting to 'complete' (#23) — that surface is covered below.
  calls = 0;
  const ctx = { currentScan: {}, options: { llm, minRelevance: 0 } }; // no mode set
  const keep = await decideFollow(ctx, 'Extract the full menu', links(3));
  assert.deepEqual(keep, [], 'historical behaviour: the AI verdict decides');
  assert.ok(calls > 0);
});

// --- strategy dispatch through the real crawlDocs (offline stub site) --------
// model '' fails the health check → heuristic judgments; browser 'never' → the
// static engine path. Neither affects WHICH strategy is dispatched — the thing
// under test.

async function strategiesFor(task, mode) {
  const events = [];
  const run = crawlDocs([{ url: `${site}/menu`, task }], {
    model: '', browser: 'never', concurrency: 1,
    ...(mode ? { mode } : {}),
    onEvent: (ev) => events.push(ev),
  });
  await run.result;
  return events.filter((e) => e.type === 'strategy').map((e) => e.strategy);
}

test('complete mode: the docs shortcuts are tried whatever the task — llms-full.txt wins', async () => {
  const strategies = await strategiesFor('Extract the full menu', 'complete');
  assert.deepEqual(strategies, ['docs:llms-full'], 'a menu task still gets the completeness shortcut');
});

test('auto mode (asked for by name): the same non-docs task takes the general crawl', async () => {
  const strategies = await strategiesFor('Extract the full menu', 'auto');
  assert.deepEqual(strategies, ['agent'], 'auto + non-docs task never touches the docs shortcuts');
});

test('no mode passed: the default is complete (#23) — the task wording changes nothing', async () => {
  const strategies = await strategiesFor('Extract the full menu', undefined);
  assert.deepEqual(strategies, ['docs:llms-full'], 'the default no longer sniffs the task');
});

test('targeted mode: a docs-sounding task no longer flips to the docs profile', async () => {
  const strategies = await strategiesFor('Extract all documentation', 'targeted');
  assert.deepEqual(strategies, ['agent'], 'targeted ignores the wording — the gate/scoping path runs');
});

test('complete + noAi: the allowed zero-token cell of the matrix — full result, no model', async () => {
  const events = [];
  const run = crawlDocs([{ url: `${site}/menu`, task: '' }], {
    noAi: true, mode: 'complete', browser: 'never', concurrency: 1,
    onEvent: (ev) => events.push(ev),
  });
  const result = await run.result;
  assert.ok(events.some((e) => e.type === 'warn' && e.reason === 'no-ai'), 'the no-AI trade-off is announced');
  assert.deepEqual(events.filter((e) => e.type === 'strategy').map((e) => e.strategy), ['docs:llms-full']);
  assert.ok(result.scans[0].pages.length >= 2, 'the publisher export is split into whole pages');
  assert.equal(result.stats.tokens.calls, 0, 'zero model calls — rule #6 is absolute');
});
