// Low-level page actuation via Playwright. Elements are targeted by the
// `data-sagecrawl-id` attribute that perceive() stamped on the live DOM.

const SETTLE_MS = 350;

/**
 * Wait for a click's effects to FULLY land before the caller captures, WITHOUT
 * over-waiting on clicks that do nothing. The hard case is a widget whose FIRST
 * interaction triggers a one-time cascade of lazy-loaded scripts (a booking
 * calendar pulls in pikaday / jquery-ui / sweetalert / recaptcha the first time
 * a day is picked) that delays the real content — the day's slot grid — by ~1s,
 * during which the visible TEXT sits on a flat plateau. A DOM-stability poll is
 * fooled by that plateau and snapshots the page without the slots; `networkidle`
 * with a fixed timeout either under- or over-waits and, when it over-waits,
 * desynchronises the click→reveal→restore rhythm so per-day panels are lost.
 *
 * The reliable signal is the RESPONSE STREAM: real content arrives on a network
 * response (the slot grid's `calendarform.php`), so we wait until a response has
 * come back AND the network has then been quiet for a short grace window, with
 * the DOM no longer changing. A click that fetches waits exactly as long as its
 * cascade runs; a click that fetches NOTHING (a no-op toggle) sees no response
 * and falls through after the same short grace — so no-ops stay cheap. Bounded
 * by maxMs so recaptcha/ads heartbeats can't stall the crawl. Generic — no
 * per-site assumptions.
 *
 * @param {import('playwright').Page} page
 */
async function settle(page, { maxMs = 4500, graceMs = 650, intervalMs = 120 } = {}) {
  const start = Date.now();
  let sawResponse = false;
  let lastResponse = start;
  const onResponse = () => {
    sawResponse = true;
    lastResponse = Date.now();
  };
  page.on('response', onResponse);
  try {
    let prevLen = -1;
    while (Date.now() - start < maxMs) {
      await page.waitForTimeout(intervalMs);
      let len;
      try {
        len = await page.evaluate(() => document.body.innerText.length);
      } catch {
        return;
      }
      // "Quiet" = the grace window has passed since the last response (or, if no
      // response ever came, since the click). Settled once it is quiet AND the
      // text has stopped changing — so a late render that trails the final
      // response still gets one more poll before we conclude.
      const since = sawResponse ? Date.now() - lastResponse : Date.now() - start;
      if (since >= graceMs && len === prevLen) return;
      prevLen = len;
    }
  } finally {
    page.off('response', onResponse);
  }
}

/**
 * Activate a revealer by id. Guards against navigation: if the click took us to
 * a new URL (the control was really a link), we record that URL and go back so
 * revealing continues on the original page.
 *
 * @returns {Promise<{ ok: boolean, navigatedTo?: string, note?: string }>}
 */
export async function clickRevealer(page, id) {
  const before = page.url();
  const loc = page.locator(`[data-sagecrawl-id="${id}"]`).first();
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
    await loc.click({ timeout: 4000 });
  } catch (err) {
    return { ok: false, note: String(err && err.message).slice(0, 120) };
  }
  // Wait for the click's async content (AJAX panels + any first-touch lazy-load
  // cascade) to finish before the caller captures. This is what reliably gets a
  // slow first reveal — e.g. the day-2 slot grid — that a single immediate
  // snapshot, or networkidle alone, can miss.
  await settle(page);

  const after = page.url();
  if (after !== before) {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    return { ok: true, navigatedTo: after };
  }
  return { ok: true };
}

/**
 * Scroll down one viewport to trigger lazy/infinite content.
 * @returns {Promise<boolean>} whether the document grew (more content loaded).
 */
export async function scrollStep(page) {
  try {
    const before = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9)));
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => document.body.scrollHeight);
    return after > before + 4;
  } catch {
    return false;
  }
}
