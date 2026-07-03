// #22 — the semantic relevance tier, fully offline (a local OpenAI-compatible
// stub serves both /embeddings and /chat/completions; no model, no browser).
// The acceptance criteria from TODO.md:
//   - cross-language fixture (Italian task, German site): correct ordering where
//     the lexical scorer gives 0 to everything;
//   - with `noAi` ZERO calls, embeddings included (rule #6);
//   - byKind meters the embedding cost under 'embed';
//   - nothing is dropped by default — embeddings order, minRelevance (opt-in)
//     is the only cut;
//   - the reshape retrieval picks the right sections cross-language;
//   - unreachable backend → ONE loud warning, lexical floor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { resolveLlm, embed } from '../src/lib/llm.mjs';
import { createScorer, cosine } from '../src/lib/semantic.mjs';
import { tokenize, scoreLink, taskTerms } from '../src/lib/relevance.mjs';
import { selectRelevant } from '../src/lib/retrieve.mjs';
import { decideFollow, budgetRoutes } from '../src/engine/crawl-page.mjs';

// --- local stub: keyword-mapped vectors + a follow-all link gate --------------
let embedCalls = 0;
let chatCalls = 0;
let failEmbeds = false;
const vecFor = (text) => {
  const t = String(text).toLowerCase();
  if (/preis|prezzi|price/.test(t)) return [1, 0];
  if (/kontakt|contact|contatt/.test(t)) return [0, 1];
  return [0.05, 0.05];
};
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const body = (() => {
      try {
        return JSON.parse(data);
      } catch {
        return {};
      }
    })();
    if (req.url.endsWith('/embeddings')) {
      embedCalls++;
      if (failEmbeds) {
        res.writeHead(500);
        return res.end('boom');
      }
      const input = Array.isArray(body.input) ? body.input : [body.input];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          data: input.map((t, index) => ({ index, embedding: vecFor(t) })),
          usage: { prompt_tokens: input.length * 5 },
        }),
      );
    }
    chatCalls++;
    // the link gate: follow EVERY listed destination
    const prompt = body.messages ? body.messages.at(-1).content : '';
    const n = (prompt.match(/^\d+: /gm) || []).length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ follow: Array.from({ length: n }, (_, i) => i) }) } }], usage: {} }));
  });
});

let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => server.close());

const mkLlm = (over = {}) => ({ provider: 'openai', model: 'stub', embedModel: 'emb', baseUrl: base, apiKey: 'k', ...over });
const reset = () => {
  embedCalls = 0;
  chatCalls = 0;
  failEmbeds = false;
};

// The cross-language fixture: Italian task, German link texts. The LEXICAL
// scorer is blind here — that blindness is exactly what the tier exists for.
const TASK_IT = 'estrai i prezzi';
const LINK_PREISE = { href: 'https://s.de/preise', label: 'Preise und Tarife' };
const LINK_KONTAKT = { href: 'https://s.de/kontakt', label: 'Kontakt' };

// --- transport -----------------------------------------------------------------

test('resolveLlm carries embedModel; noAi drops it (rule #6 by construction)', () => {
  assert.equal(resolveLlm({ model: 'm', embedModel: 'nomic-embed-text' }).embedModel, 'nomic-embed-text');
  const none = resolveLlm({ noAi: true, model: 'm', embedModel: 'nomic-embed-text' });
  assert.equal(none.provider, 'none');
  assert.ok(!none.embedModel, 'the no-AI descriptor carries NO embedModel');
});

test('embed(): vectors in input order, usage metered under byKind "embed"', async () => {
  reset();
  const usages = [];
  const llm = mkLlm({ __onUsage: (u) => usages.push(u) });
  const vecs = await embed(llm, ['Preise', 'Kontakt']);
  assert.deepEqual(vecs, [[1, 0], [0, 1]]);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].kind, 'embed');
  assert.equal(usages[0].inputTokens, 10);
  assert.equal(usages[0].outputTokens, 0, 'embeddings emit numbers, not tokens');
});

test('embed() refuses no-AI and missing embedModel — loudly, before any request', async () => {
  reset();
  await assert.rejects(() => embed({ provider: 'none' }, ['x']), /no-AI/);
  await assert.rejects(() => embed(mkLlm({ embedModel: '' }), ['x']), /no embedModel/);
  assert.equal(embedCalls, 0, 'the guard fires before the transport');
});

// --- the scorer ------------------------------------------------------------------

test('lexical scorer is blind on the cross-language fixture (the problem being solved)', () => {
  const terms = taskTerms(TASK_IT);
  assert.equal(scoreLink(terms, LINK_PREISE).score, 0);
  assert.equal(scoreLink(terms, LINK_KONTAKT).score, 0);
});

test('semantic scorer: Italian task ranks the German Preise page first', async () => {
  reset();
  const scorer = createScorer({ llm: mkLlm(), task: TASK_IT });
  const scores = await scorer.scoreAll([LINK_PREISE, LINK_KONTAKT]);
  assert.ok(scores.get(LINK_PREISE.href) > 0.9, 'on-task page scores high');
  assert.ok(scores.get(LINK_KONTAKT.href) < 0.1, 'off-task page scores low');
  // vectors are CACHED per scan: re-scoring the same links embeds nothing new
  const before = embedCalls;
  await scorer.scoreAll([LINK_PREISE, LINK_KONTAKT]);
  assert.equal(embedCalls, before, 'per-scan vector cache — a link is embedded once');
});

test('a generic task never discriminates — and never spends an embedding call', async () => {
  reset();
  const scorer = createScorer({ llm: mkLlm(), task: 'Extract everything' });
  const scores = await scorer.scoreAll([LINK_PREISE, LINK_KONTAKT]);
  assert.equal(scores.get(LINK_PREISE.href), 1);
  assert.equal(scores.get(LINK_KONTAKT.href), 1);
  assert.equal(embedCalls, 0, 'no topic terms = nothing to rank = zero calls');
});

test('noAi: the scorer stays lexical with ZERO embedding calls (rule #6)', async () => {
  reset();
  const scorer = createScorer({ llm: resolveLlm({ noAi: true, embedModel: 'emb' }), task: TASK_IT });
  const scores = await scorer.scoreAll([LINK_PREISE, LINK_KONTAKT]);
  assert.equal(embedCalls, 0, 'no-AI means zero calls to ANY model, embeddings included');
  assert.equal(scores.get(LINK_PREISE.href), 0, 'lexical floor (blind, but free and honest)');
});

test('backend failure: ONE loud warning, then the lexical floor — never silent', async () => {
  reset();
  failEmbeds = true;
  const warns = [];
  const scorer = createScorer({ llm: mkLlm(), task: TASK_IT, onWarn: (m) => warns.push(m) });
  const s1 = await scorer.scoreAll([LINK_PREISE]);
  const s2 = await scorer.scoreAll([LINK_KONTAKT]);
  assert.equal(s1.get(LINK_PREISE.href), 0, 'lexical fallback scores');
  assert.equal(s2.get(LINK_KONTAKT.href), 0);
  assert.equal(warns.length, 1, 'warned exactly once');
  assert.match(warns[0], /falling back to lexical/);
});

// --- integration: decideFollow + budgetRoutes -----------------------------------

test('decideFollow: semantic minRelevance prunes the off-task link BEFORE the gate', async () => {
  reset();
  const ctx = { currentScan: {}, options: { llm: mkLlm(), minRelevance: 0.5 }, emit: () => {} };
  const keep = await decideFollow(ctx, TASK_IT, [LINK_PREISE, LINK_KONTAKT]);
  assert.deepEqual(keep, [LINK_PREISE.href], 'Preise survives, Kontakt pruned semantically');
  assert.ok(chatCalls > 0, 'the AI gate still judges what survives the pruning');
});

test('decideFollow: without minRelevance nothing is dropped — embeddings only ORDER', async () => {
  reset();
  const ctx = { currentScan: {}, options: { llm: mkLlm(), minRelevance: 0 }, emit: () => {} };
  const keep = await decideFollow(ctx, TASK_IT, [LINK_KONTAKT, LINK_PREISE]); // off-task listed first
  assert.equal(keep.length, 2, 'default = no cut (the gate said follow both)');
  assert.equal(keep[0], LINK_PREISE.href, 'best-first: the on-task link leads the frontier');
});

test('budgetRoutes: an external score map (the semantic tier) drives the ranking', () => {
  const routes = ['https://s.de/preise/liste', 'https://s.de/static/chunk-1', 'https://s.de/static/chunk-2'];
  const scoreOf = new Map([
    [routes[0], 0.95],
    [routes[1], 0.02],
    [routes[2], 0.02],
  ]);
  const out = budgetRoutes(routes, taskTerms(TASK_IT), 1, scoreOf);
  assert.deepEqual(out.routes, [routes[0]]);
  assert.equal(out.cut, 2);
  // no variance → no cut, exactly as with lexical scores
  const flat = new Map(routes.map((r) => [r, 0.5]));
  assert.equal(budgetRoutes(routes, [], 1, flat).cut, 0);
});

// --- reshape retrieval ------------------------------------------------------------

test('selectRelevant + sectionScore: a cross-language ask pulls the right section', () => {
  const pricing = '# Pricing\n\nStandard plan 29 EUR, premium plan 59 EUR, enterprise on request.';
  const contact = '# Contact\n\nReach the sales office in Berlin by phone or email form.';
  const docs = [{ filename: 'site.md', content: `${pricing}\n\n${contact}\n\n${'filler '.repeat(50)}` }];
  const ask = 'dammi i prezzi'; // no lexical overlap with the English body
  // Lexical: nothing discriminates → the legacy head-slice.
  assert.equal(selectRelevant(docs, ask, 120).mode, 'head');
  // Semantic scorer (di, si, section) → cosine-like: pricing 0.9, the rest ~0.
  const sectionScore = (di, si, s) => (/pricing/i.test(s.heading) ? 0.9 : 0.05);
  const sel = selectRelevant(docs, ask, 120, sectionScore);
  assert.equal(sel.mode, 'retrieval');
  assert.ok(sel.docs[0].content.includes('29 EUR'), 'the pricing section reached the model');
  assert.ok(!sel.docs[0].content.includes('Berlin'), 'the contact section did not');
});

// --- the lexical floor's Unicode fix (the ONE lexical upgrade kept) ---------------

test('tokenize: diacritics folded, Cyrillic as words, CJK as bigrams; ASCII unchanged', () => {
  assert.deepEqual(tokenize('perché il menù'), ['perche', 'menu']);
  assert.deepEqual(tokenize('цены на услуги'), ['цены', 'на', 'услуги']);
  assert.deepEqual(tokenize('提取价格'), ['提取', '取价', '价格']);
  assert.deepEqual(tokenize('Estrai la documentazione web JavaScript'), ['documentazione', 'web', 'java', 'script']);
});

test('the fix connects accented families the old ASCII splitter destroyed', () => {
  // "menù" used to tokenize as nothing useful; now it meets "menu" head-on.
  assert.equal(scoreLink(taskTerms('estrai il menù'), { href: 'https://s.it/menu' }).matched, 1);
  // a Chinese task now discriminates lexically too (bigram overlap)
  assert.ok(scoreLink(taskTerms('提取价格'), { href: 'https://s.cn/x', label: '价格表' }).matched >= 1);
});

test('cosine: identical → 1, orthogonal → 0, clamped at 0', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0], [-1, 0]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});
