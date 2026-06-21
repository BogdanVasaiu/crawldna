// Lazy Playwright loader. Playwright is an optional dependency: nothing here
// imports it until a crawl actually needs the browser as an actuator.

let _pw = null;
let _imported = null; // null = unknown
let _browser = null;
let _error = null; // clean, user-facing reason when unavailable

async function importPlaywright() {
  if (_imported !== null) return _imported;
  try {
    _pw = await import('playwright');
    _imported = true;
  } catch {
    _imported = false;
    _error = 'Playwright is not installed. Run: npm install playwright && npx playwright install chromium';
  }
  return _imported;
}

function cleanLaunchError(err) {
  const msg = String((err && err.message) || err || '');
  if (/Executable doesn'?t exist|playwright install|Looks like Playwright/i.test(msg)) {
    return 'Chromium is not fully installed. Run: npx playwright install chromium';
  }
  return 'Browser launch failed: ' + msg.split('\n')[0];
}

/** A clean, user-facing reason the browser is unavailable, or null. */
export function browserError() {
  return _error;
}

/** Launch (once) and return a shared headless Chromium browser. Clean errors. */
export async function getBrowser() {
  if (_browser) return _browser;
  if (!(await importPlaywright())) throw new Error(_error);
  try {
    _browser = await _pw.chromium.launch({ headless: true });
  } catch (err) {
    _error = cleanLaunchError(err);
    throw new Error(_error);
  }
  return _browser;
}

/**
 * True if the browser can actually launch — verified once by a real launch
 * (the launched browser is cached for reuse), not just a module import. A
 * missing/partial browser binary therefore degrades cleanly instead of throwing
 * on every page mid-crawl. Never throws.
 */
export async function isBrowserAvailable() {
  if (_browser) return true; // already launched and cached
  if (!(await importPlaywright())) return false;
  try {
    await getBrowser();
    return true;
  } catch {
    // Do NOT cache a failure: the browser may be installed between crawls (e.g.
    // a long-running `serve`). Re-probe next time rather than staying stuck.
    return false;
  }
}

// Runs before any page script. Monkey-patches addEventListener so that ANY
// element which registers a click-like listener — however it was built, even a
// plain <div> with a JS handler — is tagged. This is how we spot non-obvious
// interactivity universally, without per-site selectors.
const SNIFFER = `(() => {
  try {
    const proto = EventTarget.prototype;
    const orig = proto.addEventListener;
    const INTERESTING = { click: 1, mousedown: 1, pointerdown: 1, keydown: 1, change: 1 };
    proto.addEventListener = function (type, listener, opts) {
      try {
        if (INTERESTING[type] && this && this.nodeType === 1) {
          this.setAttribute('data-docdna-listener', '1');
        }
      } catch (e) {}
      return orig.call(this, type, listener, opts);
    };
  } catch (e) {}
})();`;

/** A fresh page in its own context (isolated cookies/state) with the sniffer. */
export async function newPage() {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'docdna/0.1 (+https://github.com/docdna)',
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(SNIFFER);
  const page = await context.newPage();
  return { page, context };
}

/** Close the shared browser, if any. Safe to call multiple times. */
export async function closeBrowser() {
  if (_browser) {
    try {
      await _browser.close();
    } catch {
      /* ignore */
    }
    _browser = null;
  }
}

let _installTried = false;

/**
 * Make sure the browser can launch, installing Chromium once if it is missing.
 * Returns true when the browser is ready. Used at `serve` startup so the user
 * never hits a mid-crawl "browser not installed" error.
 */
export async function ensureBrowser({ log = () => {} } = {}) {
  if (await isBrowserAvailable()) return true;
  if (_installTried) return false;
  _installTried = true;

  log('Chromium not found — installing it once (this is a one-time ~150MB download)…');
  const { spawn } = await import('node:child_process');
  const ok = await new Promise((resolve) => {
    try {
      const child = spawn('npx', ['playwright', 'install', 'chromium', 'chromium-headless-shell'], {
        stdio: 'inherit',
        shell: true,
      });
      child.on('exit', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
  if (!ok) return false;
  return isBrowserAvailable();
}
