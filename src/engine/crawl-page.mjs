// The general per-page engine (§3): browser-first render -> exhaustive reveal of
// hidden/dynamic content -> task-scoped verbatim extraction -> link discovery.
// Universal: no per-site logic. AI judges task relevance for non-doc tasks; the
// generic documentation task runs model-free (the reveal pass already handles
// dynamic content).

import { isBrowserAvailable, newPage, browserError } from '../lib/browser.mjs';
import { loadHtml } from '../lib/fetcher.mjs';
import { extractMarkdown, splitBlocks } from '../extract.mjs';
import { revealAll } from './reveal.mjs';
import { aiScopeContent, aiSelectLinks } from './decide.mjs';
import { isDocsTask } from '../lib/task.mjs';
import { normalizeUrl, inScope, resolveUrl } from '../lib/url.mjs';
import { taskTerms, scoreLink } from '../lib/relevance.mjs';

const now = () => new Date().toISOString();
const bytesOf = (s) => Buffer.byteLength(s || '', 'utf8');

/**
 * Decide which candidate links to follow, using AI relevance gating with a
 * per-scan cache (a link is judged once) and a completeness bias: on any model
 * failure we follow everything rather than risk dropping a page. The cache lives
 * on the current scan, not the run, so a link rejected for one link's task is
 * not wrongly skipped for another link with a different task.
 * (Exported for the test suite; the crawl only reaches it via crawlPageWithEngine.)
 */
export async function decideFollow(ctx, task, candidateObjs) {
  const cacheHost = ctx.currentScan || ctx;
  if (!cacheHost._followCache) cacheHost._followCache = new Map();
  const cache = cacheHost._followCache;
  // Task topic terms, computed once per scan (the task is fixed for a scan).
  if (!cacheHost._taskTerms) cacheHost._taskTerms = taskTerms(task);
  const terms = cacheHost._taskTerms;

  // Universal, task-driven relevance score per candidate (URL + label). Used to crawl
  // the most on-task links FIRST, and — only when asked — to prune clearly off-task ones
  // before the model. No per-site/URL-shape rule is involved; the task is the query.
  const scoreOf = new Map();
  for (const c of candidateObjs) scoreOf.set(c.href, scoreLink(terms, c).score);

  const keep = [];
  const unknown = [];
  for (const c of candidateObjs) {
    if (cache.has(c.href)) {
      if (cache.get(c.href)) keep.push(c.href);
    } else {
      unknown.push(c);
    }
  }

  // FOCUSED MODE (opt-in via `minRelevance` > 0): drop clearly off-task links before the
  // model ever sees them — but ONLY when the task actually discriminates among THIS
  // page's links (at least one reaches the threshold), so a generic task can never nuke
  // everything. DEFAULT is minRelevance = 0 → prune nothing: precision/completeness
  // first; scoring then only reorders, never drops.
  const minRel = Number(ctx.options.minRelevance) || 0;
  let toJudge = unknown;
  if (minRel > 0 && terms.length && unknown.some((c) => scoreOf.get(c.href) >= minRel)) {
    toJudge = [];
    for (const c of unknown) {
      if (scoreOf.get(c.href) >= minRel) toJudge.push(c);
      else cache.set(c.href, false); // pruned as off-task; not re-judged this scan
    }
  }

  if (toJudge.length) {
    // Rank by relevance so the MOST on-task links are judged first. Then judge EVERY
    // candidate in batches of aiSelectLinks' cap (160): a page can carry more links than
    // one call fits, and a candidate the model never saw must not be recorded as
    // rejected — that would silently drop its page for the whole scan (rule #1).
    const ranked = [...toJudge].sort((a, b) => scoreOf.get(b.href) - scoreOf.get(a.href));
    for (let i = 0; i < ranked.length; i += 160) {
      const batch = ranked.slice(i, i + 160);
      let chosen;
      try {
        chosen = await aiSelectLinks({ llm: ctx.options.llm, task, links: batch });
      } catch {
        chosen = batch.map((c) => c.href); // completeness bias on failure
      }
      const chosenSet = new Set(chosen);
      for (const c of batch) {
        const follow = chosenSet.has(c.href);
        cache.set(c.href, follow);
        if (follow) keep.push(c.href);
      }
    }
  }

  // Best-first: hand the frontier this page's chosen links most-on-task FIRST, so an
  // early Stop (or a maxPages cap) keeps what the task cares about most.
  keep.sort((a, b) => (scoreOf.get(b) || 0) - (scoreOf.get(a) || 0));
  return keep;
}

/** Dedupe + keep only in-scope http(s) URLs. */
function inScopeUnique(urls, baseUrl, options) {
  const out = new Map();
  for (const u of urls) {
    const n = normalizeUrl(u);
    if (!n) continue;
    if (!inScope(n, baseUrl, options)) continue;
    if (!out.has(n)) out.set(n, n);
  }
  return [...out.values()];
}

export async function crawlPageWithEngine(target, ctx) {
  const { url, task } = target;
  const browserMode = ctx.options.browser;

  if (browserMode === 'never' || !(await isBrowserAvailable())) {
    if (browserMode !== 'never' && !ctx._browserWarned) {
      ctx._browserWarned = true;
      ctx.emit({
        type: 'warn',
        url,
        reason: 'browser-missing',
        message:
          (browserError() || 'The engine needs a browser to render and reveal dynamic content.') +
          ' Falling back to static HTML — interaction-hidden content is likely missing; completeness is not guaranteed.',
      });
    }
    return staticFallback(target, ctx);
  }

  let pageCtx;
  try {
    pageCtx = await newPage();
  } catch (err) {
    if (!ctx._browserWarned) {
      ctx._browserWarned = true;
      ctx.emit({
        type: 'warn',
        url,
        reason: 'browser-missing',
        message:
          (browserError() || 'Browser launch failed: ' + (err && err.message)) +
          ' Falling back to static HTML.',
      });
    }
    return staticFallback(target, ctx);
  }

  const { page, release } = pageCtx;
  const popups = new Set();
  page.on('popup', (p) => {
    try {
      popups.add(p.url());
    } catch {
      /* ignore */
    }
    p.close().catch(() => {});
  });

  let revealed;
  try {
    let status = 0;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      status = resp ? resp.status() : 0;
    } catch {
      /* fall through to whatever rendered */
    }
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    // Give a client-rendered app a chance to paint real content before we look.
    await page
      .waitForFunction(
        () => {
          const m = document.querySelector('main,article,[role=main]') || document.body;
          return m && (m.innerText || '').trim().length > 150;
        },
        { timeout: 6000 },
      )
      .catch(() => {});
    await page.waitForTimeout(400);
    if (status >= 400) {
      ctx.emit({
        type: 'warn',
        url,
        reason: 'http-' + status,
        message: `Page returned HTTP ${status}; it may not exist or have moved. Trying to recover via site navigation.`,
      });
    }
    revealed = await revealAll(page, ctx, url, task);
  } catch (err) {
    ctx.emit({ type: 'error', url, message: 'render failed: ' + (err && err.message) });
    return staticFallback(target, ctx); // `release()` runs in finally before we return
  } finally {
    await release(); // close the page and return the context to the pool for reuse
  }

  if (revealed.hitCap) {
    ctx.emit({
      type: 'warn',
      url,
      reason: 'max-actions',
      message: `Reached the per-page reveal cap (${Math.max(8, ctx.options.maxActions || 40)}); some hidden content may remain. Raise --max-actions for full coverage.`,
    });
  }

  let markdown = revealed.markdown;
  let title = revealed.title;
  let relevant = true;
  // Raw { text, provenance } blocks from the reveal — the spine the layout router
  // addresses by metadata (provenance/section/ordinal). Null for the static path.
  let blocks = Array.isArray(revealed.blocks) ? revealed.blocks : null;

  // Assemble candidate links: in-content + nav (button-revealed) + popups + JS routes.
  const candidates = inScopeUnique(
    [
      ...revealed.links.map((l) => l.href),
      ...revealed.navLinks,
      ...popups,
      ...revealed.routes,
    ],
    url,
    ctx.options,
  );
  const candidateObjs = candidates.map((href) => {
    const found = revealed.links.find((l) => normalizeUrl(l.href) === href);
    return { href, label: found ? found.label : '' };
  });

  const docsTask = isDocsTask(task);

  // Crawl-time scoping keeps only task-relevant SECTIONS, VERBATIM (custom tasks
  // only; documentation pages are kept whole). This is the "stay focused" step —
  // it drops off-task chrome (landing/footer/pricing) but NEVER transforms content.
  // All task-driven filtering / reshaping / regrouping ("only the available slots",
  // "prices as a table") is Phase 2 — the user asks for it AFTER the crawl, over the
  // saved files, via aiReshape (see src/reshape.mjs). The crawl stays verbatim.
  if (markdown && !docsTask) {
    const scoped = await aiScopeContent({ llm: ctx.options.llm, task, title, markdown }).catch(() => null);
    if (scoped) {
      // Keep blocks in sync with the scoped markdown so reveal PROVENANCE survives
      // scoping: drop the blocks whose verbatim text the scope step removed.
      if (blocks && scoped.markdown !== markdown) {
        const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        const kept = new Set(splitBlocks(scoped.markdown).map(norm));
        blocks = blocks.filter((b) => kept.has(norm(b.text)));
      }
      markdown = scoped.markdown;
      relevant = scoped.relevant;
    }
  }

  // Which links to follow is ALWAYS an AI decision. That's the universal way to
  // catch non-obvious navigation — SPA fragment routes (#/contact), query routes
  // (?view=pricing), framework-specific pagination — without the algorithm
  // hard-coding any URL-shape rules. Per-run caching keeps it cheap: each href is
  // judged once, so homogeneous nav (a shared sidebar/footer) costs one call.
  const follow = await decideFollow(ctx, task, candidateObjs);

  if (!markdown || !relevant) return { page: null, links: follow };

  return {
    page: {
      url,
      task,
      title,
      markdown,
      blocks,
      meta: { strategy: 'agent', fetchedAt: now(), bytes: bytesOf(markdown) },
    },
    links: follow,
  };
}

/** No-browser path: plain fetch + static extraction (degraded; emits no reveal). */
async function staticFallback(target, ctx) {
  const { url, task } = target;
  const res = await loadHtml(url, { browserMode: ctx.options.browser, ctx });
  if (!res.html) return { page: null, links: [] };

  const { title, markdown } = extractMarkdown(res.html, { baseUrl: res.finalUrl });
  const links = new Set();
  for (const m of res.html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    const abs = resolveUrl(m[1], res.finalUrl);
    if (abs) links.add(abs);
  }

  if (!markdown) return { page: null, links: [...links] };
  return {
    page: {
      url,
      task,
      title,
      markdown,
      meta: { strategy: 'agent', fetchedAt: now(), bytes: bytesOf(markdown) },
    },
    links: [...links],
  };
}
