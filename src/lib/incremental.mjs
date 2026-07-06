// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Bogdan Marian Vasaiu
// #6 — incremental re-crawl: decide which baseline pages are still FRESH.
//
// The crawl itself is unchanged; this module only partitions a prior run's pages
// into "reuse as-is" vs "re-crawl", using the site's CURRENT sitemap <lastmod>.
// It is deliberately pure (no I/O) so the safety-critical decision is unit-tested.

import { normalizeUrl } from './url.mjs';

/**
 * Partition baseline pages by freshness against the current sitemap lastmods.
 *
 * CONSERVATIVE BY CONSTRUCTION (rule #1 — never lose content): a page is REUSED
 * only on positive evidence that it is unchanged — the stored lastmod and the
 * current lastmod are BOTH present and EQUAL. Every uncertain case (either side
 * missing/blank, or the URL absent from the current sitemap) goes to `recrawl`,
 * so a page that actually changed can never be skipped.
 *
 * @param {Array<{page:object, links?:string[]}>} baselineRecords journal records from the baseline run
 * @param {Map<string,string>} currentLastmod normalizedUrl -> current <lastmod>
 * @returns {{ reuse: Array, recrawl: Array }}
 */
export function planIncremental(baselineRecords, currentLastmod) {
  const map = currentLastmod instanceof Map ? currentLastmod : new Map();
  const reuse = [];
  const recrawl = [];
  for (const rec of baselineRecords || []) {
    const page = rec && rec.page;
    if (!page || !page.url) continue;
    const stored = page.meta && page.meta.lastmod;
    const current = map.get(normalizeUrl(page.url) || page.url);
    if (stored && current && String(stored) === String(current)) reuse.push(rec);
    else recrawl.push(rec);
  }
  return { reuse, recrawl };
}

/**
 * Is a page safe to shortcut on an HTTP 304? Only when its content came from a
 * SINGLE rendered state with nothing left hidden — then the served document IS the
 * page and a server 304 truly means unchanged. A multi-state reveal or leftover
 * hidden text means content is click/JS-driven, where a shell 304 does NOT prove
 * the content is unchanged — those are never trusted to a 304 (rule #1).
 */
export function isStaticSafe(page) {
  if (!page) return false;
  if (Array.isArray(page.states) && page.states.length > 1) return false;
  return ((page.meta && page.meta.revealResidualChars) || 0) === 0;
}

/** A page's stored HTTP validators ('' when absent). */
export function httpValidators(page) {
  const m = (page && page.meta) || {};
  return { etag: m.httpEtag || '', lastModified: m.httpLastModified || '' };
}

/**
 * Of the pages lastmod could NOT clear as fresh, which are ELIGIBLE for a 304
 * pre-check — static-safe AND carrying at least one stored validator. The rest are
 * always re-crawled. Pure: the network 304 check itself happens in the caller.
 * @param {Array<{page:object}>} recrawlRecords
 * @returns {{ eligible: Array, rest: Array }}
 */
export function planConditional(recrawlRecords) {
  const eligible = [];
  const rest = [];
  for (const rec of recrawlRecords || []) {
    const page = rec && rec.page;
    const v = httpValidators(page);
    if (page && isStaticSafe(page) && (v.etag || v.lastModified)) eligible.push(rec);
    else rest.push(rec);
  }
  return { eligible, rest };
}
