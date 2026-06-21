// URL helpers: normalise, dedupe, scope. Pure, no dependencies.

/** Coerce a string|RegExp filter into a RegExp (or null). */
export function toRegExp(pattern) {
  if (!pattern) return null;
  if (pattern instanceof RegExp) return pattern;
  try {
    return new RegExp(String(pattern));
  } catch {
    return null;
  }
}

/**
 * Normalise a URL for dedup/comparison:
 * - resolve against `base` when relative
 * - KEEP the fragment as-is. We make NO assumptions about URL shape: for some
 *   sites the fragment is the page (hash-routed SPAs), for others it's an
 *   in-page anchor. Deciding which destinations are real pages is the AI gate's
 *   job (decide.mjs), with content-dedup as the safety net — the algorithm
 *   never pattern-matches `#/`, `?`, etc.
 * - lowercase the host
 * - strip a trailing slash (except the root path)
 * Returns null when the input cannot be parsed.
 */
// Query params that are tracking/analytics/locale noise — never select content.
// (Content-selecting params like `api`, `tab`, `version` are deliberately kept.)
const STRIP_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', '_ga', '_hsenc', '_hsmi',
  'ref', 'ref_src', 'igshid', 'hl', 'lang', 'locale',
]);

export function normalizeUrl(input, base) {
  let u;
  try {
    u = new URL(input, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // Fragment kept as-is (see note above) — no URL-shape assumptions.
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  for (const k of [...u.searchParams.keys()]) {
    if (STRIP_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
  }
  return u.toString();
}

export function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function originOf(u) {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
}

export function pathOf(u) {
  try {
    return new URL(u).pathname;
  } catch {
    return '';
  }
}

/** True when `url`'s host is the base host or a subdomain of it (not the parent). */
export function sameSite(url, baseUrl) {
  const a = hostOf(url);
  const b = hostOf(baseUrl);
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b);
}

/**
 * Decide whether `url` is in scope for a crawl rooted at `baseUrl`.
 * - `exclude` wins if it matches.
 * - if `include` is set, the URL must match it.
 * - otherwise default scope is the same site (host or subdomain).
 */
export function inScope(url, baseUrl, { include, exclude } = {}) {
  const exc = toRegExp(exclude);
  if (exc && exc.test(url)) return false;
  const inc = toRegExp(include);
  if (inc) return inc.test(url);
  return sameSite(url, baseUrl);
}

/** Resolve a possibly-relative href against a base URL; null if invalid. */
export function resolveUrl(href, base) {
  return normalizeUrl(href, base);
}

/** A filesystem-safe slug derived from arbitrary text. */
export function slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'section';
}
