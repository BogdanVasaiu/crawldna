// #21a — the consent decision (engine/consent.mjs), pure and offline. The
// acceptance criterion from TODO.md: NON-ENGLISH banners get closed (fixture
// battery below), reject is preferred over accept, and a non-consent overlay
// never gets its primary action pressed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickConsent, CONSENT_TOPIC_RE } from '../src/engine/consent.mjs';

const ids = (picks) => picks.map((p) => p.id);

test('Italian banner: reject preferred over accept; policy links never clicked', () => {
  const overlayText = 'Questo sito utilizza cookie per migliorare la tua esperienza. Informativa privacy.';
  const picks = pickConsent([
    { id: 0, label: 'Accetta tutti', area: 9000, overlayText },
    { id: 1, label: 'Rifiuta tutti', area: 3000, overlayText },
    { id: 2, label: 'Personalizza', area: 3000, overlayText },
    { id: 3, label: 'Informativa sui cookie', area: 500, overlayText, href: '/privacy' },
  ]);
  assert.deepEqual(ids(picks), [1], 'Rifiuta tutti wins — more respectful, closes just the same');
});

test('German banner: Ablehnen over Alle akzeptieren', () => {
  const overlayText = 'Wir verwenden Cookies. Details in unserer Datenschutzerklärung (DSGVO).';
  const picks = pickConsent([
    { id: 0, label: 'Alle akzeptieren', area: 8000, overlayText },
    { id: 1, label: 'Ablehnen', area: 2500, overlayText },
  ]);
  assert.deepEqual(ids(picks), [1]);
});

test('French accept-only banner: Tout accepter is clicked (the banner must close)', () => {
  const overlayText = 'Nous utilisons des cookies pour personnaliser le contenu.';
  const picks = pickConsent([
    { id: 0, label: 'Tout accepter', area: 7000, overlayText },
    { id: 1, label: 'Paramétrer', area: 2000, overlayText },
  ]);
  assert.deepEqual(ids(picks), [0]);
});

test('Russian and Chinese banners are handled (the lexicon reads the banner, not the site)', () => {
  const ru = 'Мы используем cookie для улучшения сервиса.';
  assert.deepEqual(ids(pickConsent([
    { id: 0, label: 'Принять все', area: 6000, overlayText: ru },
    { id: 1, label: 'Отклонить', area: 2000, overlayText: ru },
  ])), [1]);
  const zh = '本网站使用 cookie 以提升体验。';
  assert.deepEqual(ids(pickConsent([
    { id: 0, label: '全部同意', area: 6000, overlayText: zh },
    { id: 1, label: '拒绝', area: 2000, overlayText: zh },
  ])), [1]);
});

test('legacy English banner still handled ("We use cookies" + Got it)', () => {
  const overlayText = 'We use cookies to improve your experience.';
  assert.deepEqual(ids(pickConsent([{ id: 0, label: 'Got it', area: 3000, overlayText }])), [0]);
});

test('consent banner with exotic wording: the PRIMARY button by geometry closes it', () => {
  const overlayText = 'Cookie usage on this site is described in our policy.';
  const picks = pickConsent([
    { id: 0, label: 'Va bene così', area: 9000, overlayText }, // no lexicon match, biggest
    { id: 1, label: 'Preferenze avanzate', area: 2000, overlayText },
  ]);
  assert.deepEqual(ids(picks), [0], 'geometry breaks the tie only INSIDE a consent overlay');
});

test('non-consent overlay (newsletter): dismiss only — the primary action is never pressed', () => {
  const overlayText = 'Join our newsletter for weekly updates!';
  const picks = pickConsent([
    { id: 0, label: 'Subscribe', area: 9000, overlayText },
    { id: 1, label: 'No thanks', area: 1500, overlayText },
  ]);
  assert.deepEqual(ids(picks), [1], 'No thanks, never Subscribe');
  // Same overlay without any dismiss wording: NOTHING is clicked (geometry is
  // consent-only — the biggest button of an arbitrary modal is Subscribe/Log in).
  assert.deepEqual(pickConsent([{ id: 0, label: 'Subscribe', area: 9000, overlayText }]), []);
});

test('two overlays at once: one pick each, in order', () => {
  const cookie = 'Diese Website verwendet Cookies.';
  const promo = 'Get the app!';
  const picks = pickConsent([
    { id: 0, label: 'Zustimmen', area: 5000, overlayText: cookie },
    { id: 1, label: 'Install app', area: 8000, overlayText: promo },
    { id: 2, label: 'Schließen', area: 900, overlayText: promo },
  ]);
  assert.deepEqual(ids(picks), [0, 2], 'the cookie banner is accepted, the promo just closed');
});

test('CONSENT_TOPIC_RE covers the quasi-universal stems and nothing generic', () => {
  for (const t of ['We use cookies', 'политика cookie', 'RGPD conforme', 'DSGVO-Hinweis', 'your privacy matters', 'gdpr consent']) {
    assert.ok(CONSENT_TOPIC_RE.test(t), `should be consent topic: ${t}`);
  }
  assert.ok(!CONSENT_TOPIC_RE.test('Join our newsletter for weekly updates'), 'a newsletter modal is not a consent banner');
});
