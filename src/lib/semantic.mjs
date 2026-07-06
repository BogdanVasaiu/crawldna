// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Bogdan Marian Vasaiu
// #22 — the semantic relevance tier: embeddings-backed task→link scoring.
//
// The lexical scorer (lib/relevance.mjs) is fast, free and deterministic, but
// blind across languages and synonyms: an Italian task ("estrai i prezzi") on a
// German site scores "Preise" 0. When the user configures an `embedModel`, this
// tier embeds the task once per scan and every unique link ONCE (cached, batch
// calls), and cosine similarity becomes the relevance score — multilingual by
// nature, and hallucination-free (embeddings emit numbers, not text).
//
// Precision rules (the item's contract):
//   - embeddings ORDER always, they CUT only through the explicit `minRelevance`
//     opt-in — exactly like the lexical scores they replace;
//   - the AI link gate stays the judge in targeted mode; this is the ranking
//     signal under it, not a replacement;
//   - a GENERIC task (no topic terms) never discriminates — everything scores 1,
//     same as lexical, so a "get everything" crawl is never reordered into a
//     preference it didn't express;
//   - no `embedModel`, no-AI mode, or a failing backend → the lexical floor,
//     with ONE loud warning (never a silent degrade);
//   - rule #6: in no-AI mode the descriptor carries no embedModel and embed()
//     refuses to run — zero model calls of ANY kind.

import { embed, llmDisabled } from './llm.mjs';
import { scoreLink, taskTerms } from './relevance.mjs';

const BATCH = 64; // texts per embed call — bounded requests, few round-trips

/** Cosine similarity clamped to [0, 1] (sentence embeddings sit ≥0 in practice;
 *  the clamp just keeps the score a valid relevance value). */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(na * nb)));
}

/** The text a link is embedded as: its human label + nearby heading + decoded
 *  URL path — the same signals the lexical scorer reads, as one string. */
function linkText(link) {
  let path = '';
  try {
    path = decodeURIComponent(new URL(link.href).pathname).replace(/[/_-]+/g, ' ').trim();
  } catch {
    path = String(link.href || '');
  }
  return [link.label, link.context, path].filter(Boolean).join(' — ').slice(0, 300);
}

/**
 * Per-scan relevance scorer. `scoreAll(candidates)` returns Map<href, score 0..1>,
 * semantic when an embedModel is configured and answering, lexical otherwise.
 * Create ONE per scan (the task is fixed there) and reuse it — the vector cache
 * and the one-time failure warning live on the instance.
 *
 * @param {object} a
 * @param {object} a.llm       the resolveLlm descriptor (reads .embedModel)
 * @param {string} a.task      the scan's task (the query)
 * @param {(msg:string)=>void} [a.onWarn]  called ONCE if the backend fails
 */
export function createScorer({ llm, task, onWarn } = {}) {
  const terms = taskTerms(task);
  // Semantic only when it can help AND is allowed: an embedModel is set, AI is
  // not disabled, and the task actually names a topic (a generic task must not
  // discriminate — same contract as the lexical scorer's all-1s).
  let semantic = !!(llm && !llmDisabled(llm) && llm.embedModel && terms.length);
  const cache = new Map(); // linkText -> vector, per scan
  let taskVec = null;

  const lexicalAll = (candidates) => {
    const out = new Map();
    for (const c of candidates) out.set(c.href, scoreLink(terms, c).score);
    return out;
  };

  async function vectorsFor(texts) {
    const missing = [...new Set(texts.filter((t) => !cache.has(t)))];
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const vecs = await embed(llm, batch);
      batch.forEach((t, j) => cache.set(t, vecs[j]));
    }
  }

  return {
    get semantic() {
      return semantic;
    },
    /** @param {Array<{href:string,label?:string,context?:string}>} candidates
     *  @returns {Promise<Map<string, number>>} href → relevance score in [0,1] */
    async scoreAll(candidates) {
      if (!semantic) return lexicalAll(candidates);
      try {
        if (!taskVec) {
          await vectorsFor([task]);
          taskVec = cache.get(task);
        }
        const texts = candidates.map(linkText);
        await vectorsFor(texts);
        const out = new Map();
        candidates.forEach((c, i) => out.set(c.href, cosine(taskVec, cache.get(texts[i]))));
        return out;
      } catch (err) {
        // ONE loud warning, then the lexical floor for the rest of the scan —
        // a broken embedding backend must never break (or silently skew) a crawl.
        semantic = false;
        if (onWarn) {
          try {
            onWarn(
              `Embedding model '${llm.embedModel}' failed (${String((err && err.message) || err).slice(0, 160)}) — ` +
                'falling back to lexical relevance for this scan.',
            );
          } catch {
            /* never break scoring over a warn */
          }
        }
        return lexicalAll(candidates);
      }
    },
  };
}

/**
 * #22 for the reshape retrieval (lib/retrieve.mjs): score every H1–H3 section of
 * every document against the instruction, semantically. Returns a lookup
 * `(di, si) => score in [0,1]`, or null when the semantic tier is off/failed —
 * the caller then keeps the lexical retrieval unchanged.
 *
 * Each section is embedded by its GIST (heading + first 300 chars), not its full
 * body — that bounds the cost to ~sections×75 tokens while still capturing what
 * the section is about (the standard head-window trick).
 *
 * @param {object} a
 * @param {object} a.llm
 * @param {string} a.instruction
 * @param {Array<Array<{heading:string,text:string}>>} a.docSections  sections per document,
 *        in the SAME order/indices the caller will use (sectionizeDoc output)
 * @returns {Promise<null | ((di:number, si:number) => number)>}
 */
export async function semanticSectionScores({ llm, instruction, docSections }) {
  if (!llm || llmDisabled(llm) || !llm.embedModel) return null;
  try {
    const gists = [];
    const keys = [];
    docSections.forEach((sections, di) => {
      sections.forEach((s, si) => {
        keys.push(`${di}:${si}`);
        gists.push(`${s.heading}\n${s.text.slice(0, 300)}`);
      });
    });
    if (!gists.length) return null;
    const [qv, ...rest] = await (async () => {
      const out = [];
      const all = [instruction, ...gists];
      for (let i = 0; i < all.length; i += BATCH) out.push(...(await embed(llm, all.slice(i, i + BATCH))));
      return out;
    })();
    const scores = new Map();
    keys.forEach((k, i) => scores.set(k, cosine(qv, rest[i])));
    return (di, si) => scores.get(`${di}:${si}`) ?? 0;
  } catch {
    return null; // lexical retrieval takes over — never break a reshape over ranking
  }
}
