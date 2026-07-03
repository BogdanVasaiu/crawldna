// Task-relevance scoring for discovered links — the universal, dependency-free core
// of "information foraging" (focused crawling). Given the user's TASK and a link
// (its URL + anchor label + nearby heading), it returns how related the link looks to
// the task, using only TEXT the user wrote and text on the page — never any per-site or
// per-framework URL-shape rule. The crawler uses this to:
//   - follow the most on-task links FIRST (best-first frontier), and
//   - OPTIONALLY prune clearly off-task links before the AI gate (focused mode, opt-in).
// It NEVER decides to drop a link on its own in the default configuration: scoring only
// reorders, and pruning happens only when the caller sets `minRelevance > 0`. The AI
// link gate stays the primary judge; this is a cheap signal that helps it, not replaces
// it. Aligned with: precision over speed (no drop by default), universal (no per-site
// rules), task-driven (the task is the query).

// Words that frame the REQUEST rather than name the TOPIC, plus URL noise. Kept
// deliberately small and conservative — we stop "extract"/"di"/"www", never topic nouns
// like "documentation", "menu", "prices", "auth". Multilingual (en + it) because tasks
// here are often Italian.
const STOP = new Set([
  // english articles / prepositions / aux
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'from', 'by',
  'as', 'at', 'is', 'are', 'be', 'this', 'that', 'these', 'those', 'all', 'any', 'it',
  'its', 'your', 'you', 'we', 'our', 'into',
  // italian articles / prepositions
  'di', 'la', 'il', 'lo', 'le', 'gli', 'un', 'una', 'uno', 'e', 'o', 'per', 'con', 'da',
  'del', 'della', 'dei', 'degli', 'delle', 'al', 'alla', 'allo', 'ai', 'agli', 'alle',
  'che', 'come', 'su', 'nel', 'nella', 'questo', 'questa', 'tutti', 'tutte', 'suo', 'sua',
  // request-framing verbs (asking, not topic)
  'extract', 'estrai', 'estrarre', 'get', 'find', 'fetch', 'scrape', 'use', 'usare',
  'using', 'give', 'list', 'crawl', 'collect', 'gather', 'complete', 'completa',
  'completo', 'completi', 'full', 'whole', 'entire', 'everything', 'tutto', 'tutta',
  // url / locale noise
  'www', 'http', 'https', 'com', 'org', 'net', 'html', 'htm', 'php', 'aspx', 'index',
  'en', 'us',
]);

// CJK scripts (Han + kana + Hangul) carry no word boundaries, so word-splitting
// alone yields one giant unusable token — those runs are emitted as character
// BIGRAMS instead, the standard boundary-free trick, so two texts about the same
// thing share tokens ("提取价格" and "价格表" meet on 价格).
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_SPLIT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/** Split arbitrary text into lowercased word tokens (camelCase-aware), minus stopwords,
 *  pure numbers and 1-char fragments. Pure/deterministic.
 *
 *  #22 (the one lexical upgrade kept — the n-gram/IDF rework was evaluated and
 *  REJECTED): Unicode-aware instead of ASCII-only. Accented words survive with
 *  their diacritics FOLDED (NFKD, combining marks stripped) so "menù"/"menu" and
 *  "documentación"/"documenta…" connect; Cyrillic/Greek tokenize as words; CJK
 *  runs become character bigrams. The old ASCII splitter silently DESTROYED all
 *  of these ("perché" → "perch", Cyrillic → nothing). Cross-language synonyms
 *  remain the semantic tier's job (lib/semantic.mjs) — this only stops the
 *  tokenizer from eating non-English text. */
export function tokenize(text) {
  const out = [];
  const raw = String(text || '')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2') // camelCase → camel Case
    .normalize('NFKD')
    .replace(/\p{M}+/gu, ''); // fold diacritics; leaves Cyrillic/Greek/CJK intact
  for (const tok of raw.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!tok) continue;
    if (CJK_RE.test(tok)) {
      for (const run of tok.match(CJK_SPLIT_RE) || []) {
        if (CJK_RE.test(run)) {
          if (run.length === 1) out.push(run);
          else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
        } else if (run.length >= 2 && !/^\d+$/.test(run) && !STOP.has(run)) {
          out.push(run);
        }
      }
      continue;
    }
    if (tok.length < 2) continue;
    if (/^\d+$/.test(tok)) continue; // version/page numbers are noise here
    if (STOP.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

/** Tokens mined from a URL: its path segments + query keys/values (host ignored — it's
 *  the same site, so it carries no discriminating signal). */
export function urlTokens(href) {
  try {
    const u = new URL(href);
    const q = [...u.searchParams.entries()].map(([k, v]) => `${k} ${v}`).join(' ');
    return tokenize(decodeURIComponent(u.pathname) + ' ' + q);
  } catch {
    return tokenize(href);
  }
}

/** The distinct topic terms of a task (the "query"). Empty when the task is purely
 *  generic ("extract everything") — callers treat that as "don't discriminate". */
export function taskTerms(task) {
  return [...new Set(tokenize(task))];
}

/** Does link-token `l` satisfy task-term `t`? Exact match, or a shared prefix for
 *  longer words so "price"/"prices" and "document"/"documentazione" still connect — a
 *  light, language-agnostic stemming with no per-language rules.
 *  (Exported for reuse by the reshape context retrieval, lib/retrieve.mjs.) */
export function termHit(t, l) {
  if (l === t) return true;
  return t.length >= 4 && l.length >= 4 && (l.startsWith(t) || t.startsWith(l));
}

/**
 * Score one link's relevance to the task in [0, 1].
 *   0   = shares no topic term with the task,
 *   0.5 = shares one,
 *   1   = shares two or more (saturates — one strong, on-topic match is enough).
 * When the task has NO topic terms (fully generic), returns 1 for everything so scoring
 * never disrupts a generic crawl.
 *
 * @param {string[]} terms  result of taskTerms(task) (precompute once per scan)
 * @param {{href?:string, label?:string, context?:string}} link
 * @returns {{ score:number, matched:number }}
 */
export function scoreLink(terms, link) {
  if (!terms || terms.length === 0) return { score: 1, matched: 0 };
  const toks = new Set([
    ...urlTokens(link.href || ''),
    ...tokenize(link.label || ''),
    ...tokenize(link.context || ''),
  ]);
  let matched = 0;
  for (const t of terms) {
    for (const l of toks) {
      if (termHit(t, l)) {
        matched++;
        break;
      }
    }
  }
  return { score: Math.min(1, matched / 2), matched };
}
