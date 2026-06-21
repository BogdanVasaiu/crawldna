// Documentation task profile (§4). For docs the priorities are completeness and
// precision, so:
//   1. /llms-full.txt — the publisher's own complete export; use it verbatim.
//   2. /sitemap.xml   — an authoritative page list; use it to SEED the engine.
//   3. otherwise      — let the engine crawl from the entry, discovering pages.
//
// Every page (except the llms-full shortcut) goes through the browser-first
// engine so dynamic/interaction-hidden docs (Firebase tabs, SPA nav, …) are
// fully revealed — not just statically scraped.

import { tryLlmsFull } from './docs/llms.mjs';
import { collectSitemapUrls } from './docs/sitemap.mjs';
import { normalizeUrl, inScope, pathOf } from '../lib/url.mjs';

const now = () => new Date().toISOString();
const bytes = (s) => Buffer.byteLength(s || '', 'utf8');

/**
 * The path prefix to constrain a docs crawl to. For "extract all documentation"
 * the user points at *a* doc page but wants the whole docs tree, so we scope to
 * the first path segment (the docs root: /docs, /en, /guide, …) rather than the
 * exact entry path. Narrow it with --include when you only want one section.
 */
function scopePrefixFor(baseUrl) {
  const p = pathOf(normalizeUrl(baseUrl) || baseUrl);
  if (!p || p === '/') return null;
  const segs = p.replace(/\/+$/, '').split('/').filter(Boolean);
  if (!segs.length) return null;
  return '/' + segs[0];
}

/** Keep same-site URLs under the docs path, honour include/exclude, dedupe. */
function filterDocUrls(urls, baseUrl, options, prefix) {
  const out = new Set();
  for (const u of urls) {
    const n = normalizeUrl(u, baseUrl);
    if (!n || !inScope(n, baseUrl, options)) continue;
    if (prefix) {
      const p = pathOf(n);
      if (!(p === prefix || p.startsWith(prefix + '/'))) continue;
    }
    out.add(n);
  }
  return [...out];
}

export async function runDocsProfile(target, ctx) {
  const { url, task } = target;

  // -- Tier 1: llms-full.txt (complete, verbatim, no browser) ---------------
  const llms = await tryLlmsFull(url).catch(() => null);
  if (llms && !ctx.shouldStop()) {
    ctx.emit({ type: 'strategy', url, strategy: 'docs:llms-full' });
    ctx.emit({ type: 'discover', url, count: llms.pages.length });
    ctx.setTotal(llms.pages.length);
    for (const p of llms.pages) {
      if (ctx.shouldStop()) break;
      ctx.addPage({
        url: p.url,
        task,
        title: p.title,
        markdown: p.markdown,
        meta: { strategy: 'docs:llms-full', source: llms.sourceUrl, fetchedAt: now(), bytes: bytes(p.markdown) },
      });
      ctx.markProcessed(); // bar advances per page handled (kept or deduped)
    }
    return;
  }

  const prefix = scopePrefixFor(url);

  // -- Tier 2: sitemap → seed the engine ------------------------------------
  const sitemap = await collectSitemapUrls(url, { shouldStop: ctx.shouldStop }).catch(() => []);
  const seeds = filterDocUrls(sitemap, url, ctx.options, prefix);

  if (seeds.length > 1 && !ctx.shouldStop()) {
    ctx.emit({ type: 'strategy', url, strategy: 'docs:sitemap' });
    ctx.emit({ type: 'discover', url, count: seeds.length });
    ctx.setTotal(seeds.length);
    await ctx.runEngine(target, { seeds, announce: false, scopePrefix: prefix });
    return;
  }

  // -- Tier 3: no page list → engine crawls from the entry and discovers ----
  ctx.emit({
    type: 'warn',
    url,
    reason: 'no-page-list',
    message:
      'No llms-full.txt or usable sitemap found; the engine will crawl from the entry page and ' +
      'discover pages as it goes. Completeness is not guaranteed.',
  });
  await ctx.runEngine(target, { announce: true, scopePrefix: prefix });
}
