// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Bogdan Marian Vasaiu
// #16 — the relevance budget on JS-mined routes. budgetRoutes is pure: rank by
// scoreLink against the task terms, keep the top N — but ONLY when the scores
// actually discriminate among the routes (min < max). A generic task (everything
// scores 1) or an off-vocabulary one (everything 0) must cut NOTHING (rule #1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetRoutes } from '../src/engine/crawl-page.mjs';
import { taskTerms } from '../src/lib/relevance.mjs';

const DOCS_TERMS = taskTerms('Extract the web documentation'); // discriminating task
const GENERIC_TERMS = taskTerms('Extract everything'); // no topic terms → all score 1

const chunk = (i) => `https://ex.com/static/chunk-${String(i).padStart(3, '0')}`;
const NOISE = Array.from({ length: 30 }, (_, i) => chunk(i));
const REAL = ['https://ex.com/docs/web/setup', 'https://ex.com/docs/web/auth', 'https://ex.com/documentation/api'];

test('under budget: untouched, zero cut', () => {
  const { routes, cut } = budgetRoutes(NOISE, DOCS_TERMS, 200);
  assert.deepEqual(routes, NOISE);
  assert.equal(cut, 0);
});

test('over budget with a discriminating task: on-task routes ALL kept, noise absorbs the cut', () => {
  const mined = [...NOISE.slice(0, 15), ...REAL, ...NOISE.slice(15)]; // real ones buried mid-list
  const { routes, cut } = budgetRoutes(mined, DOCS_TERMS, 10);
  assert.equal(routes.length, 10);
  assert.equal(cut, mined.length - 10);
  for (const r of REAL) assert.ok(routes.includes(r), `${r} must survive the cut`);
  // Ties (all the 0-scored noise) keep mined order — deterministic.
  const keptNoise = routes.filter((r) => !REAL.includes(r));
  assert.deepEqual(keptNoise, NOISE.slice(0, keptNoise.length));
});

test('a generic task scores everything alike → cuts NOTHING even over budget (rule #1)', () => {
  const mined = [...NOISE, ...REAL];
  const { routes, cut } = budgetRoutes(mined, GENERIC_TERMS, 5);
  assert.deepEqual(routes, mined);
  assert.equal(cut, 0);
});

test('an off-vocabulary task (all routes score 0) also cuts nothing', () => {
  const { routes, cut } = budgetRoutes(NOISE, taskTerms('estrai il menù delle pizze'), 5);
  assert.deepEqual(routes, NOISE);
  assert.equal(cut, 0);
});

test('budget 0 = unlimited', () => {
  const mined = [...NOISE, ...REAL];
  const { routes, cut } = budgetRoutes(mined, DOCS_TERMS, 0);
  assert.deepEqual(routes, mined);
  assert.equal(cut, 0);
});
