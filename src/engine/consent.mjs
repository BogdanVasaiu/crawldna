// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Bogdan Marian Vasaiu
// #21a — consent/overlay dismissal: the DECISION, kept pure and testable.
//
// perceive() MEASURES (a visible button-like element inside a true overlay —
// fixed/sticky/dialog/aria-modal — with its label, geometry and the overlay's
// text); THIS module DECIDES which of those buttons to click. The split is the
// whole point: the in-page code stays a thin sensor, the policy is unit-tested
// offline with multilingual fixtures.
//
// Universality argument (why a lexicon is allowed here at all): we never read
// the SITE — we read the ARTEFACT OF THE DEFENSE, the cookie/consent banner,
// which is the same everywhere because the law that mandates it is. The words
// on its buttons come from a tiny, closed vocabulary per language ("accept
// all" / "reject all" / "close"), so a micro-lexicon of ~40 stems covers the
// world's banners the way `documenta` covers the word "documentation" — it is
// the deterministic-backstop rule (#4), not a per-site rule.
//
// Policy, in order:
//   1. Overlay ABOUT consent (its text mentions cookie/consent/GDPR/privacy):
//      prefer a REJECT button (closes the banner just the same, and is the more
//      respectful default), then ACCEPT, then a plain dismiss (ok/close/…),
//      then — banners with exotic wording — the PRIMARY button by geometry
//      (largest visible button with a short label).
//   2. Any OTHER overlay (newsletter modal, app interstitial): only a plain
//      dismiss/close is ever clicked. Never accept/reject words out of context,
//      and NEVER geometry — the biggest button of an arbitrary dialog is
//      "Subscribe"/"Log in", exactly what must not be pressed.

/** Does the overlay's own text say it is a consent/cookie banner? These four
 * stems are quasi-universal: "cookie" is used verbatim in virtually every
 * language, "consent/GDPR/privacy" cover the legal phrasing. */
export const CONSENT_TOPIC_RE = /cookie|consent|gdpr|privacy|rgpd|dsgvo/i;

// The micro-lexicon. Stems, not full words, so inflections match; each entry
// reads the BANNER's button, never the site's content.
const REJECT_RE = new RegExp(
  [
    // en / it / de / fr / es / pt / nl / scandinavian / fi / pl / cs / hu / ro / ru / zh / ja / ko
    'reject', 'decline', 'refuse', 'deny', 'necessary only', 'only necessary',
    'rifiut', 'solo necessari',
    'ablehn', 'nur notwendige',
    'refuser', 'tout refuser',
    'rechaz', 'solo necesarias',
    'recus', 'rejeit',
    'weiger', 'alleen noodzakelijk',
    'avvisa', 'avslå', 'afvis', 'kun nødvendige',
    'hylkää', 'odrzuć', 'odmítn', 'elutasít', 'resping',
    'отклон', 'отказ',
    '拒绝', '全部拒绝', '拒否', '거부',
  ].join('|'),
  'i',
);
const ACCEPT_RE = new RegExp(
  [
    'accept', 'agree', 'allow', 'got it', 'i understand', 'understood',
    'accett', 'consent[io]', 'ho capito',
    'akzeptier', 'zustimm', 'einverstanden', 'verstanden',
    'accepter', "j'accepte", 'tout accepter',
    'acept', 'aceit', 'de acuerdo',
    'accepteer', 'akkoord',
    'acceptera', 'godkänn', 'godta', 'accepter alle', 'hyväksy',
    'akceptuj', 'zgadzam', 'přijm', 'souhlas', 'elfogad', 'accept toate',
    'принять', 'принима', 'соглас',
    '同意', '接受', '同意する', '승인', '동의',
  ].join('|'),
  'i',
);
const DISMISS_RE = new RegExp(
  [
    '^ok$', '^okay$', 'close', 'dismiss', 'continue', 'no,? thanks', 'not now', 'maybe later',
    'chiudi', 'schließen', 'weiter', 'fermer', 'continuer', 'cerrar',
    'continuar', 'fechar', 'sluiten', 'luk', 'stäng', 'lukk', 'sulje',
    'zamknij', 'zavří', 'bezár', 'închide', 'закрыть', 'продолжить',
    '关闭', '閉じる', '닫기', '^[×✕x]$',
  ].join('|'),
  'i',
);

/**
 * Pick which overlay buttons to dismiss, one per overlay.
 *
 * @param {Array<{ id:number, label:string, area:number, overlayText:string, href?:string }>} candidates
 *   measured by perceive(): every visible short-labelled button inside a true overlay.
 * @returns {Array<{ id:number, label:string }>} the buttons to click, in order.
 */
export function pickConsent(candidates = []) {
  // Group by overlay (candidates carry their overlay's text sample).
  const overlays = new Map();
  for (const c of candidates) {
    if (!c || !c.label) continue;
    const key = c.overlayText || '';
    if (!overlays.has(key)) overlays.set(key, []);
    overlays.get(key).push(c);
  }

  const picks = [];
  for (const [overlayText, group] of overlays) {
    const isConsent = CONSENT_TOPIC_RE.test(overlayText);
    // A policy/settings LINK ("Cookie policy", "Learn more") is never the way to
    // close a banner — buttons only. (An <a> used AS the button has no href.)
    const buttons = group.filter((c) => !c.href);
    const byLexicon = (re) => buttons.find((c) => re.test(c.label));

    let pick = null;
    if (isConsent) {
      pick =
        byLexicon(REJECT_RE) ||
        byLexicon(ACCEPT_RE) ||
        byLexicon(DISMISS_RE) ||
        // Exotic wording: the PRIMARY button by geometry — banners paint their
        // one-click exit as the biggest button. Short label only (a long label
        // is body text, not a button caption).
        [...buttons].filter((c) => c.label.length < 40).sort((a, b) => (b.area || 0) - (a.area || 0))[0] ||
        null;
    } else {
      // Not (visibly) a consent banner: only ever a plain dismiss. No accept/
      // reject out of context, no geometry — never press an arbitrary modal's
      // primary action.
      pick = byLexicon(DISMISS_RE) || null;
    }
    if (pick) picks.push({ id: pick.id, label: pick.label });
  }
  return picks;
}
