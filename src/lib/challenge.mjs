// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Bogdan Marian Vasaiu
// #14 — anti-bot / challenge-page detection. ALWAYS ON: this is a PRECISION
// guard, not a courtesy — when a site's defense serves a "checking your
// browser" interstitial or a CAPTCHA wall (often with HTTP 200), keeping it
// would put boilerplate in the output AS IF it were content, silently.
//
// Universality argument (same as the consent lexicon, #21a): we read the
// ARTEFACT OF THE DEFENSE, not the site. Challenge pages are produced by a
// handful of vendors (Cloudflare, hCaptcha, reCAPTCHA, DataDome, PerimeterX,
// AWS WAF) and look the same everywhere, so their MECHANICAL markers — widget
// script/iframe URLs, the cf-mitigated header, meta-refresh interstitials —
// are universal signals. A page that merely TALKS about captchas (docs, blog
// posts) has real text mass and no thin-page signal, so it never trips this.
//
// Policy on detection (enforced by the callers): NEVER kept as content, a loud
// `anti-bot` warning with the URL, ONE retry with backoff (honouring
// Retry-After), then a declared skip. NEVER bypassed — CAPTCHAs/challenges are
// out of scope forever (ARCHITECTURE §14): we signal, we don't break through.

// Vendor widget/iframe/script markers — mechanical evidence a challenge is
// being SERVED (not merely mentioned; these are resource URLs and internals).
const WIDGET_RE = new RegExp(
  [
    'challenges\\.cloudflare\\.com',
    'cdn-cgi/challenge-platform',
    '__cf_chl',
    'cf_chl_',
    'js\\.hcaptcha\\.com',
    'hcaptcha\\.com/1/api\\.js',
    'google\\.com/recaptcha/api',
    'gstatic\\.com/recaptcha',
    'recaptcha/api\\.js',
    'captcha-delivery\\.com',
    'geo\\.captcha-delivery\\.com',
    'datadome',
    'px-cdn\\.net',
    'px-cloud\\.net',
    '_pxhd',
    'awswaf\\.com',
    'amazonaws\\.com/captcha',
  ].join('|'),
  'i',
);

// Interstitial phrasing — meaningful only TOGETHER with a thin page AND a
// mechanical corroborator (blocked status / meta-refresh / widget), never alone.
const PHRASE_RE = new RegExp(
  [
    'checking your browser',
    'verify(?:ing)? (?:that )?you are (?:a )?human',
    'just a moment',
    'attention required',
    'enable javascript and cookies to continue',
    'unusual traffic',
    'are you a robot',
    'ddos protection by',
    'please stand by, while we are checking',
  ].join('|'),
  'i',
);

const META_REFRESH_RE = /<meta[^>]+http-equiv\s*=\s*["']?refresh/i;

// "Thin": challenge pages carry a sentence or two (~200–400 chars of real
// text); real content pages carry far more. The phrase/widget must ALSO match —
// thinness alone never flags anything (an empty page is just an empty page).
const THIN_CONTENT_CHARS = 800;

/**
 * Is this response a bot-defense challenge rather than content?
 *
 * @param {object} a
 * @param {number} [a.status]      HTTP status (challenges use 200/403/429/503)
 * @param {object} [a.headers]     response headers, lowercase keys
 * @param {string} [a.html]        the page HTML (widget markers live in markup)
 * @param {number} [a.contentLen]  chars of real (non-link) text on the page —
 *                                 the same metric as extract.contentWordLen
 * @returns {{ challenge: boolean, signal?: string }}
 */
export function detectChallenge({ status = 0, headers = {}, html = '', contentLen = 0 } = {}) {
  const hdr = (name) => String(headers[name] || headers[String(name).toLowerCase()] || '');
  // Cloudflare labels challenge responses explicitly — the strongest signal.
  if (/challenge/i.test(hdr('cf-mitigated'))) {
    return { challenge: true, signal: 'cf-mitigated: challenge response header' };
  }
  const h = String(html || '');
  const thin = contentLen < THIN_CONTENT_CHARS;
  const blocked = status === 403 || status === 429 || status === 503;
  if (thin && WIDGET_RE.test(h)) {
    return { challenge: true, signal: 'captcha/challenge widget on a near-empty page' + (blocked ? ` (HTTP ${status})` : '') };
  }
  if (thin && PHRASE_RE.test(h) && (blocked || META_REFRESH_RE.test(h))) {
    return { challenge: true, signal: 'challenge interstitial marker' + (blocked ? ` (HTTP ${status})` : ' (meta-refresh)') };
  }
  return { challenge: false };
}

/** The backoff before the single retry: honour Retry-After (seconds or an
 *  HTTP-date) when sane, else a fixed courtesy pause. Bounded. */
export function challengeBackoffMs(headers = {}) {
  const raw = String(headers['retry-after'] || headers['Retry-After'] || '').trim();
  if (raw) {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs > 0) return Math.min(15000, secs * 1000);
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return Math.min(15000, Math.max(0, at - Date.now()));
  }
  return 2500;
}
