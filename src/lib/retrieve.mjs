// Context retrieval for reshape (#11, root cause): when the crawled sources exceed
// the model budget, choose WHICH verbatim slices fill it — instead of blindly sending
// the first N characters and letting the model "answer" the rest from its own memory
// (observed live: a 2.7MB Vuetify extraction, "v-alert props" past the cap → the model
// fabricated a plausible props table with wrong defaults, silently).
//
// Universal and deterministic: sections are scored against the USER'S INSTRUCTION with
// the same task-tokenisation the crawler uses for link relevance (no per-site rules,
// no embeddings, no dependencies). The AI stays the judge of the ANSWER; this only
// decides what it gets to read. Content is never rewritten — sections are passed
// verbatim, in document order, with omissions marked.

import { tokenize, termHit } from './relevance.mjs';

const norm = (s) => String(s || '').toLowerCase();

/** Split Markdown into H1–H3 sections (fence-aware). Each section's `text` is the
 *  verbatim slice including its heading line; content before the first heading becomes
 *  an "(intro)" section. Mirrors the crawl's scoping granularity. */
export function sectionizeDoc(markdown) {
  const lines = String(markdown || '').split('\n');
  const sections = [];
  let cur = { heading: '(intro)', lines: [] };
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && line.match(/^(#{1,3})\s+(.*)/);
    if (h) {
      if (cur.lines.length || sections.length === 0) sections.push(cur);
      cur = { heading: h[2].trim().slice(0, 120), lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  sections.push(cur);
  return sections
    .map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() }))
    .filter((s) => s.text);
}

/** How relevant one section is to the query terms: heading hits weigh most (a section
 *  ABOUT the topic), body occurrences add up (capped, so a long page can't drown a
 *  focused one). 0 = shares nothing with the request. */
function scoreSection(section, terms, headTokens) {
  let score = 0;
  const bodyLC = norm(section.text);
  for (const t of terms) {
    if (headTokens.some((k) => termHit(t, k))) score += 3;
    let count = 0;
    let idx = 0;
    while (count < 5 && (idx = bodyLC.indexOf(t, idx)) !== -1) {
      count++;
      idx += t.length;
    }
    score += count;
  }
  return score;
}

/**
 * Choose the source content that fits a character budget, most-relevant first.
 *
 * @param {Array<{filename?:string, bytes?:number, content:string}>} documents
 * @param {string} instruction  the user's request (the query)
 * @param {number} budget       character budget for the combined content
 * @returns {{
 *   docs: Array<object>,   the documents to show (content possibly a verbatim subset;
 *                          `partial: true` marks a doc whose sections were omitted)
 *   truncated: boolean,    whether ANYTHING had to be left out
 *   mode: 'full'|'retrieval'|'head',
 *   omittedDocs: number    documents left out entirely (nothing relevant in them)
 * }}
 *
 * Modes: 'full' = everything fits, untouched. 'retrieval' = the instruction's terms
 * (or an explicit document reference by filename/byte size) selected the sections.
 * 'head' = nothing to discriminate by — the caller keeps the legacy head-slice.
 */
export function selectRelevant(documents, instruction, budget) {
  const docs = (documents || []).map((d) => ({ ...d }));
  const total = docs.reduce((n, d) => n + String(d.content || '').length, 0);
  if (total <= budget) return { docs, truncated: false, mode: 'full', omittedDocs: 0 };

  const terms = tokenize(instruction);
  // A document the user names explicitly — by filename or by its byte size (people do:
  // "the original 2788831b") — is wanted regardless of term overlap: boost all of it.
  const instrLC = norm(instruction);
  const referenced = new Set();
  docs.forEach((d, i) => {
    if (d.filename && instrLC.includes(norm(d.filename))) referenced.add(i);
    else if (d.bytes && instrLC.includes(String(d.bytes))) referenced.add(i);
  });

  if (!terms.length && referenced.size === 0) {
    return { docs, truncated: true, mode: 'head', omittedDocs: 0 };
  }

  // Score every section of every document against the instruction.
  const pool = [];
  const perDocCount = new Array(docs.length).fill(0);
  docs.forEach((d, di) => {
    for (const [si, s] of sectionizeDoc(d.content).entries()) {
      perDocCount[di]++;
      const base = referenced.has(di) ? 100 : 0; // a named doc packs first, in order
      const score = base + (terms.length ? scoreSection(s, terms, tokenize(s.heading)) : 0);
      pool.push({ di, si, score, text: s.text });
    }
  });
  const scored = pool.filter((p) => p.score > 0);
  if (!scored.length) return { docs, truncated: true, mode: 'head', omittedDocs: 0 };

  // Greedy pack by score; ties resolve to document order so the result is stable.
  scored.sort((a, b) => b.score - a.score || a.di - b.di || a.si - b.si);
  let remaining = budget;
  const chosen = [];
  for (const p of scored) {
    const size = p.text.length;
    if (size <= remaining) {
      chosen.push(p);
      remaining -= size;
    } else if (chosen.length === 0) {
      // The single most relevant section alone exceeds the budget: take its head so
      // the model always gets SOMETHING on-topic rather than nothing.
      chosen.push({ ...p, text: p.text.slice(0, remaining) });
      remaining = 0;
    }
    if (remaining < 200) break;
  }

  // Reassemble each document's chosen sections in DOCUMENT order, with omissions
  // marked, so the model reads coherent (if abridged) documents.
  const out = [];
  docs.forEach((d, di) => {
    const mine = chosen.filter((p) => p.di === di).sort((a, b) => a.si - b.si);
    if (!mine.length) return;
    const partial = mine.length < perDocCount[di];
    out.push({
      ...d,
      content: mine.map((p) => p.text).join('\n\n[… sections not relevant to this request were omitted …]\n\n'),
      partial,
    });
  });
  return {
    docs: out,
    truncated: out.length < docs.length || out.some((d) => d.partial),
    mode: 'retrieval',
    omittedDocs: docs.length - out.length,
  };
}
