// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Bogdan Marian Vasaiu
// Task classification shared by the orchestrator and the engine.

/** The valid values of the `mode` option (#20). */
export const MODES = ['auto', 'complete', 'targeted'];

/**
 * #20 — resolve the EXPLICIT `mode` option into the three engine switches it
 * controls. This is the single place where "what kind of crawl is this?" is
 * decided, so the engine never re-derives it (and never sniffs the task prose
 * outside of 'auto'):
 *
 *   - `docsShortcuts`: try the completeness shortcuts first (llms-full.txt /
 *     sitemap seeding via the docs profile) instead of pure discovery crawling.
 *   - `scopeSections`: run aiScopeContent per page (keep only task-relevant
 *     sections, verbatim). Off = pages are always kept WHOLE.
 *   - `linkGate`: send discovered links to the AI link gate (aiSelectLinks).
 *     Off = every in-scope link is followed, ZERO gate calls — keep/drop has no
 *     meaning when the user asked for everything, and the mirror/variant dedup
 *     (default-on) is what keeps follow-everything contained.
 *
 * `complete` = "the whole site": shortcuts on, pages whole, no gate — AI (when
 * enabled) still drives reveal + nav-plan, the jobs that find hidden content.
 * `targeted` = "only what the task asks": gate + scoping on, regardless of how
 * the task is phrased. Requires AI (refused with `noAi` — enforced upstream in
 * crawlDocs, never silently).
 * `auto` = the historical behaviour, kept ONLY for backward compatibility
 * (library callers, saved runs, resume): the isDocsTask regex below decides.
 * Anything unrecognised resolves to 'auto' here; crawlDocs validates first and
 * rejects unknown values loudly.
 */
export function modeBehavior(mode, task) {
  const m = mode === 'complete' || mode === 'targeted' ? mode : 'auto';
  if (m === 'complete') return { mode: m, docsShortcuts: true, scopeSections: false, linkGate: false };
  if (m === 'targeted') return { mode: m, docsShortcuts: false, scopeSections: true, linkGate: true };
  const docs = isDocsTask(task);
  return { mode: 'auto', docsShortcuts: docs, scopeSections: !docs, linkGate: true };
}

/**
 * Does the task ask for a software/product DOCUMENTATION site (developer docs, API/SDK
 * reference, guides) — the completeness-first docs path — versus a specific data task
 * (a menu, prices, a list)? This is a deterministic backstop that reads the USER'S
 * INSTRUCTION, never the website, so it stays universal (no per-site rules).
 *
 * #20: since the explicit `mode` option exists, this regex is consulted ONLY by
 * `modeBehavior('auto', …)` — the backward-compatibility path. New callers (and
 * the UI) pass mode 'complete' or 'targeted' and never reach it.
 *
 * It is MULTILINGUAL by design: it matches the documentation STEM rather than one
 * language's spelling, so it works whatever language the task is written in (Latin
 * script). `documenta` covers documentation / documentazione / documentación /
 * documentação / documentatie; `dokumenta` covers German/Nordic (Dokumentation); plus
 * `docs`, `api reference`, and `sdk`. The stem (not a bare "document") avoids false
 * positives on data tasks like "extract the documents list".
 *
 * Why it matters: a true verdict (a) picks the docs profile (llms-full.txt / sitemap →
 * complete, fast) and (b) keeps pages WHOLE (skips the per-section scoping meant for
 * specific tasks). A non-English task wrongly read as "not docs" loses both — it was the
 * bug where an Italian "documentazione" crawl explored blindly and trimmed sections.
 */
export function isDocsTask(task) {
  return /\bdocs?\b|documenta|dokumenta|api[\s_-]*reference|\bsdk\b/i.test(task || '');
}
