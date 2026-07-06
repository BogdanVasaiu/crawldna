// #6 — incremental re-crawl: the freshness planner (never skip on uncertainty),
// sitemap <lastmod> extraction, and target-set matching for baseline discovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planIncremental, isStaticSafe, planConditional } from '../src/lib/incremental.mjs';
import { sitemapEntriesFromXml } from '../src/profiles/docs/sitemap.mjs';
import { targetsMatch } from '../src/lib/runs.mjs';
import { normalizeUrl } from '../src/lib/url.mjs';

const rec = (url, lastmod) => ({ page: { url, meta: lastmod === undefined ? {} : { lastmod } }, links: [] });
const lm = (pairs) => new Map(pairs.map(([u, v]) => [normalizeUrl(u) || u, v]));

test('planIncremental: reuse only pages whose lastmod is unchanged', () => {
  const baseline = [rec('https://x.dev/a', '2026-01-01'), rec('https://x.dev/b', '2026-01-01')];
  const current = lm([
    ['https://x.dev/a', '2026-01-01'], // unchanged → reuse
    ['https://x.dev/b', '2026-02-02'], // changed → recrawl
  ]);
  const { reuse, recrawl } = planIncremental(baseline, current);
  assert.deepEqual(reuse.map((r) => r.page.url), ['https://x.dev/a']);
  assert.deepEqual(recrawl.map((r) => r.page.url), ['https://x.dev/b']);
});

test('planIncremental: no stored lastmod → re-crawl (no false skip)', () => {
  const baseline = [rec('https://x.dev/a')]; // baseline page never carried a lastmod
  const current = lm([['https://x.dev/a', '2026-01-01']]);
  const { reuse, recrawl } = planIncremental(baseline, current);
  assert.equal(reuse.length, 0);
  assert.equal(recrawl.length, 1);
});

test('planIncremental: URL absent from current sitemap → re-crawl', () => {
  const baseline = [rec('https://x.dev/a', '2026-01-01')];
  const { reuse, recrawl } = planIncremental(baseline, lm([['https://x.dev/other', '2026-01-01']]));
  assert.equal(reuse.length, 0);
  assert.equal(recrawl.length, 1);
});

test('planIncremental: blank lastmod on either side never reuses', () => {
  const baseline = [rec('https://x.dev/a', ''), rec('https://x.dev/b', '2026-01-01')];
  const current = lm([['https://x.dev/a', '2026-01-01'], ['https://x.dev/b', '']]);
  const { reuse } = planIncremental(baseline, current);
  assert.equal(reuse.length, 0);
});

test('planIncremental: empty/absent baseline is safe', () => {
  assert.deepEqual(planIncremental([], lm([['https://x.dev/a', '1']])), { reuse: [], recrawl: [] });
  assert.deepEqual(planIncremental(undefined, undefined), { reuse: [], recrawl: [] });
});

test('planIncremental: matches across trailing-slash / normalization differences', () => {
  const baseline = [rec('https://x.dev/a/', '2026-01-01')];
  const current = lm([['https://x.dev/a', '2026-01-01']]); // normalizeUrl unifies these
  const { reuse } = planIncremental(baseline, current);
  assert.equal(reuse.length, 1);
});

test('sitemapEntriesFromXml: reads loc + lastmod, blank when omitted', () => {
  const xml = { urlset: { url: [
    { loc: 'https://x.dev/a', lastmod: '2026-01-01' },
    { loc: 'https://x.dev/b' },
  ] } };
  assert.deepEqual(sitemapEntriesFromXml(xml), [
    { url: 'https://x.dev/a', lastmod: '2026-01-01' },
    { url: 'https://x.dev/b', lastmod: '' },
  ]);
});

test('sitemapEntriesFromXml: single (non-array) url entry', () => {
  const xml = { urlset: { url: { loc: 'https://x.dev/only', lastmod: '2026-03-03' } } };
  assert.deepEqual(sitemapEntriesFromXml(xml), [{ url: 'https://x.dev/only', lastmod: '2026-03-03' }]);
});

test('sitemapEntriesFromXml: no urlset → empty', () => {
  assert.deepEqual(sitemapEntriesFromXml({ sitemapindex: {} }), []);
  assert.deepEqual(sitemapEntriesFromXml({}), []);
});

test('targetsMatch: same URL set (order-independent) matches', () => {
  const a = [{ url: 'https://x.dev/one' }, { url: 'https://x.dev/two' }];
  const b = [{ url: 'https://x.dev/two' }, { url: 'https://x.dev/one' }];
  assert.equal(targetsMatch(a, b), true);
});

test('targetsMatch: different sets and empties do not match', () => {
  assert.equal(targetsMatch([{ url: 'https://x.dev/a' }], [{ url: 'https://x.dev/b' }]), false);
  assert.equal(targetsMatch([{ url: 'https://x.dev/a' }], [{ url: 'https://x.dev/a' }, { url: 'https://x.dev/b' }]), false);
  assert.equal(targetsMatch([], []), false);
});

// --- 304 tier: only STATIC-SAFE pages may be shortcut on a shell 304 -----------
test('isStaticSafe: single-state, zero-residual page is safe', () => {
  assert.equal(isStaticSafe({ meta: { revealResidualChars: 0 } }), true);
  assert.equal(isStaticSafe({ meta: {} }), true); // static-path page (no residual field)
});

test('isStaticSafe: multi-state or leftover-hidden page is NOT safe', () => {
  assert.equal(isStaticSafe({ states: [{}, {}], meta: { revealResidualChars: 0 } }), false, 'multi-state → dynamic');
  assert.equal(isStaticSafe({ meta: { revealResidualChars: 120 } }), false, 'text still hidden → dynamic');
  assert.equal(isStaticSafe(null), false);
});

test('planConditional: eligible = static-safe AND has a validator; rest re-crawls', () => {
  const eligibleRec = { page: { url: 'https://x.dev/a', meta: { revealResidualChars: 0, httpEtag: '"v1"' } } };
  const noValidator = { page: { url: 'https://x.dev/b', meta: { revealResidualChars: 0 } } };
  const dynamic = { page: { url: 'https://x.dev/c', states: [{}, {}], meta: { httpEtag: '"v1"' } } };
  const { eligible, rest } = planConditional([eligibleRec, noValidator, dynamic]);
  assert.deepEqual(eligible.map((r) => r.page.url), ['https://x.dev/a']);
  assert.deepEqual(rest.map((r) => r.page.url).sort(), ['https://x.dev/b', 'https://x.dev/c']);
});
