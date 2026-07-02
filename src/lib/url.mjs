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
 * - FRAGMENT policy: a plain id anchor (#install, #main-content, #step-3) just
 *   points at a SECTION of the SAME page — keeping it makes the crawler fetch one
 *   page many times over (the single biggest source of wasted work on docs sites,
 *   e.g. firebase get-started#add-sdk / #kotlin / #next-steps as "separate pages").
 *   A hash-ROUTE (#/contact, #!/features) IS a real separate page in a hash-routed
 *   SPA. So we keep only route-like fragments (`#/…` or `#!…`) and drop plain
 *   anchors, collapsing `page#a`, `page#b` and `page` to one. Content-dedup stays
 *   as a second safety net.
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
// Some trackers append DYNAMIC param names (Google Analytics linker `_gl`, the
// per-stream `_ga_XXXXXXX`, GA4 `_up`). Match these by PREFIX so a session id baked
// into the name can't dodge the filter and spawn a duplicate URL of the same page.
const STRIP_PARAM_PREFIXES = ['_ga', '_gl', '_up', 'utm_', 'mc_'];

export function normalizeUrl(input, base) {
  let u;
  try {
    u = new URL(input, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // A path that BEGINS with another absolute URL (`/https://other.site/…`) is the
  // signature of a broken join — an absolute href glued onto a base — never a real
  // route (seen live: https://0.vuetifyjs.com/https://v0play.vuetifyjs.com, a 404).
  // Only the path PREFIX is rejected: nested URLs deeper in the path (Wayback-style
  // /web/<ts>/https://…) or in the query (?redirect=https://…) are legitimate.
  let decodedPath = u.pathname;
  try {
    decodedPath = decodeURIComponent(decodedPath);
  } catch {
    /* malformed %-escape: judge the raw path */
  }
  if (/^\/https?:\//i.test(decodedPath)) return null;
  // Drop a plain in-page anchor; keep a hash ROUTE (#/… or #!…). See note above.
  if (u.hash && !/^#[!/]/.test(u.hash)) u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  for (const k of [...u.searchParams.keys()]) {
    const lk = k.toLowerCase();
    if (STRIP_PARAMS.has(lk) || STRIP_PARAM_PREFIXES.some((p) => lk.startsWith(p))) {
      u.searchParams.delete(k);
    }
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

/**
 * Key that groups URL-SIBLINGS: URLs whose path is the same once a leading
 * locale-like segment (`/en/x`, `/pt-br/x` → `/x`) is stripped — so the same
 * logical document reached via a mirror host (dev./staging./v2.), a UI-state
 * query variant (`?panel=settings`), a hash-route twin, or a locale twin all
 * share one key. Host and query are deliberately ignored: the frontier is
 * already confined to one site by `inScope`, so a same-key page on another
 * host is a same-site mirror, not a stranger. Sharing a key is only a HINT —
 * callers must also check content (SimHash) before treating two pages as
 * duplicates: e.g. `?version=1` vs `?version=2` share a key but genuinely
 * differ, and measured Hamming distances keep them apart (see mirrorHamming).
 */
export function siblingKey(u) {
  try {
    const p = new URL(u).pathname.replace(/\/+$/, '') || '/';
    return p.replace(/^\/[a-z]{2}(-[a-z0-9]{2,8})?(?=\/|$)/i, '') || '/';
  } catch {
    return '';
  }
}

/** A filesystem-safe slug derived from arbitrary text. */
export function slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'section';
}
