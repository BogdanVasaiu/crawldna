// HTML -> clean Markdown. Isolate the main content node, drop site chrome,
// convert with Turndown (fenced code + GFM tables).

import { createHash } from 'node:crypto';
import { parse } from 'node-html-parser';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// Elements that are site chrome, never content. Removed from within the chosen
// content node before conversion.
//
// The list holds ONLY unambiguous, never-in-content signals (rule: never lose
// content). Deliberately NOT here, because each one names real content on some
// site and the link-density pruner below already removes the navigational case:
//   - `.menu`         → a restaurant's FOOD menu ("extract the pizzas" — the #1 task);
//                       a link-dense site menu is caught by pruneNavByLinkDensity.
//   - `.banner` / `.announcement` → real announcements (schools, status pages, docs
//                       deprecation notices).
//   - `form`          → booking calendars, order-able menus, configurators and search
//                       result filters LIVE inside forms; inputs render to almost no
//                       Markdown anyway, so keeping forms costs ~nothing.
//   - `header`        → an <article>'s own <header> is its title/byline (content);
//                       only the site masthead is chrome — handled separately below.
const CHROME_SELECTORS = [
  'script', 'style', 'noscript', 'svg', 'template', 'iframe',
  'nav', 'aside', 'footer',
  '[role=navigation]', '[role=banner]', '[role=contentinfo]', '[role=search]',
  '.sidebar', '.navbar', '.nav', '.toc', '.table-of-contents',
  '.breadcrumb', '.breadcrumbs', '.pagination', '.pager',
  '.cookie', '.cookies', '.cookie-banner',
  '.edit-this-page', '.theme-doc-toc', '.theme-doc-footer', '.pagination-nav',
  '.skip-link', '.skip-to-content',
  // heading permalink anchors (Docusaurus/VitePress/MkDocs/devsite/…)
  '.header-anchor', '.headerlink', 'a.anchor', '[aria-label*=permalink i]', '[aria-label*=Permalink]',
  // common per-page action chrome
  '.edit-page', '.edit-link', '.feedback', '.devsite-page-rating', '.page-actions',
  '[aria-label*="Copy" i][role=button]',
  // advertisements (carbon ads etc.) — never content
  '#carbonads', '.carbonads', '[class*=carbonads]', '[class*=carbon-ads]',
  '.advertisement', '.ad-container', '.ad-banner', '[data-ad]', '[id*=carbonads]',
  // ARIA tab STRIPS — the row of tab labels is control chrome, never content: each
  // captured state re-serialises the active/inactive label combination as junk text
  // ("pnpmyarnnpmbun"). The PANELS (role=tabpanel) are the content and stay; the
  // clicked tab's label survives as the reveal's visible variant marker.
  '[role=tablist]', '[role=tab]',
];

// Candidate containers for "the main content", best-first, used when no
// framework-specific selector is supplied.
const MAIN_CANDIDATES = [
  'main article', 'article', 'main', '[role=main]',
  '.markdown', '.markdown-body', '.content', '.main-content', '.doc-content',
  '#content', '#main', '.post', '.entry-content',
];

function buildTurndown() {
  const td = new TurndownService({
    codeBlockStyle: 'fenced',
    headingStyle: 'atx',
    bulletListMarker: '-',
    emDelimiter: '_',
    hr: '---',
    linkStyle: 'inlined',
  });
  td.use(gfm);

  // ARIA lists (`role=list` / `role=listitem`) are real lists whatever tag carries
  // them. App frameworks build every repeating surface this way (transaction
  // feeds, stat cards, contact lists) out of <div>s — without this rule each FIELD
  // of an item shatters into its own paragraph ("JL" / "John Leider" / "21 Mar" /
  // "+$36.11") and the reader can no longer tell what belongs to what. One item =
  // one bullet line, exactly like the native <li> treatment.
  // Flatten an item's content to one line; nested item rules may already have
  // emitted a bullet (a shaped row wrapping a role=listitem) — never stack two.
  const inlineItem = (content) =>
    String(content || '')
      .replace(/\s*\n+\s*/g, ' ')
      .trim()
      .replace(/^(?:-\s+)+/, '');
  td.addRule('ariaListItem', {
    filter: (node) => (node.getAttribute && node.getAttribute('role')) === 'listitem',
    replacement: (content) => '\n- ' + inlineItem(content) + '\n',
  });
  td.addRule('ariaList', {
    filter: (node) => (node.getAttribute && node.getAttribute('role')) === 'list',
    replacement: (content) => '\n\n' + String(content || '').replace(/\n{2,}/g, '\n').trim() + '\n\n',
  });

  // Role-LESS repeated rows: the same fix for app lists built from bare <div>s
  // (transaction feeds, comment threads). The row signal is SHAPE, not a class
  // name: ≥3 sibling divs sharing the same base class token, each a SHORT flat
  // item (no headings/tables/fences/lists inside, not a table-cell fragment).
  // Every guard is structural, so prose can never match (paragraphs are <p>,
  // article sections differ in shape and carry block content).
  const shapeToken = (n) => {
    const cls = (n.getAttribute && n.getAttribute('class')) || '';
    return `${n.nodeName}|${cls.split(/\s+/)[0] || ''}`;
  };
  const isShapedRow = (node) => {
    if (node.nodeName !== 'DIV') return false;
    const cls = (node.getAttribute && node.getAttribute('class')) || '';
    if (!cls.trim()) return false;
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 200) return false;
    if (node.querySelector && node.querySelector('h1,h2,h3,h4,h5,h6,table,pre,ul,ol')) return false;
    for (let p = node.parentNode; p; p = p.parentNode) {
      if (p.nodeName === 'TD' || p.nodeName === 'TH') return false;
    }
    const want = shapeToken(node);
    let alike = 0;
    for (const sib of node.parentNode ? node.parentNode.childNodes : []) {
      if (sib.nodeType === 1 && shapeToken(sib) === want) alike++;
    }
    return alike >= 3;
  };
  td.addRule('shapedRowItem', {
    filter: isShapedRow,
    replacement: (content) => '\n- ' + inlineItem(content) + '\n',
  });

  // A GFM table cell must be SINGLE-LINE. Real-world cells wrap their content in
  // block markup (sort-button headers, status chips, rating widgets) and the gfm
  // plugin passes the resulting newlines straight through — one multi-line cell
  // shatters the entire table into garbage. Flatten each cell to one line and
  // escape stray pipes; the row/border layout stays the plugin's. (Added after
  // use(gfm), so this rule takes precedence over the plugin's tableCell.)
  td.addRule('tableCellSingleLine', {
    filter: ['th', 'td'],
    replacement: (content, node) => {
      const flat = String(content || '')
        .replace(/\s*\n+\s*/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\|/g, '\\|')
        .trim();
      const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
      return (index === 0 ? '| ' : ' ') + flat + ' |';
    },
  });

  // Fenced code blocks that keep the language hint (language-js, lang-js,
  // hljs language-js, highlight-source-js, ...).
  td.addRule('fencedCodeWithLang', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const codeEl =
        (node.querySelector && node.querySelector('code')) || node;
      const cls =
        (codeEl.getAttribute && codeEl.getAttribute('class')) ||
        (node.getAttribute && node.getAttribute('class')) ||
        '';
      const lang = (cls.match(/(?:language|lang|highlight|brush|source)[-:](\w+)/i) || [])[1] || '';
      const text = (codeEl.textContent || node.textContent || '').replace(/\n$/, '');
      const fence = '```';
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    },
  });

  // #26 — visual headings: data-sagecrawl-heading="2|3|4" carries the level the
  // page PAINTED (a big/bold short line) without using <h*>. Stamped in-browser
  // from computed styles at capture (markVisualHeadings in engine/perceive.mjs)
  // or from inline styles in the static path (markVisualHeadings below). Emit a
  // real ATX heading so the .md keeps the page's skeleton: the text is verbatim,
  // only the #'s are added. Added LAST so it wins over shapedRowItem for a
  // marked element (a title is never a data row).
  td.addRule('visualHeading', {
    filter: (node) =>
      /^[2-6]$/.test((node.getAttribute && node.getAttribute('data-sagecrawl-heading')) || ''),
    replacement: (content, node) => {
      const text = String(content || '').replace(/\s*\n+\s*/g, ' ').trim();
      if (!text) return '';
      const level = parseInt(node.getAttribute('data-sagecrawl-heading'), 10);
      return '\n\n' + '#'.repeat(level) + ' ' + text + '\n\n';
    },
  });

  return td;
}

function textOf(node) {
  return (node && node.text ? node.text : '').replace(/\s+/g, ' ').trim();
}

/** Rewrite relative href/src to absolute so links survive extraction. */
function absolutize(root, baseUrl) {
  if (!baseUrl) return;
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    try {
      a.setAttribute('href', new URL(href, baseUrl).toString());
    } catch {
      /* leave as-is */
    }
  }
  for (const img of root.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) continue;
    try {
      img.setAttribute('src', new URL(src, baseUrl).toString());
    } catch {
      /* leave as-is */
    }
  }
}

/** Pick the densest plausible main-content node. */
function pickMainContent(root, contentSelector) {
  const selectors = [].concat(contentSelector || []).filter(Boolean);
  for (const sel of selectors) {
    const node = root.querySelector(sel);
    if (node && textOf(node).length > 40) return node;
  }
  let best = null;
  let bestLen = 0;
  for (const sel of MAIN_CANDIDATES) {
    const node = root.querySelector(sel);
    if (!node) continue;
    const len = textOf(node).length;
    if (len > bestLen) {
      best = node;
      bestLen = len;
    }
  }
  return best || root.querySelector('body') || root;
}

// --- #26: visual headings (the .md's skeleton) ------------------------------
// Apps mark titles VISUALLY, not semantically: a card/section title is a short
// <div> painted bigger (or bolder) than the text around it, and Turndown only
// trusts <h1>–<h6> — so the page's skeleton flattens to anonymous lines. The
// browser path stamps data-sagecrawl-heading="2|3|4" from COMPUTED styles at
// capture time (markVisualHeadings in engine/perceive.mjs, inlined into
// reveal's captureHtml); this is its Node TWIN for the static path: the same
// ratio rules (rule #2 — a font ratio, never a class name) applied to INLINE
// styles, which are all a static fetch carries. Deterministic, zero model
// calls (identical under --no-ai), and it only ever ADDS a heading level —
// no text is removed or rewritten (rule #1). Keep in sync with the browser twin.

const FONT_SIZE_RE = /(?:^|;)\s*font-size\s*:\s*([0-9.]+)\s*(px|pt|rem)\b/i;
const FONT_WEIGHT_RE = /(?:^|;)\s*font-weight\s*:\s*(bolder|bold|normal|[0-9]{3})\b/i;

function inlineSizePx(el) {
  const m = FONT_SIZE_RE.exec((el.getAttribute && el.getAttribute('style')) || '');
  if (!m) return null;
  const v = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  return unit === 'pt' ? v * (4 / 3) : unit === 'rem' ? v * 16 : v;
}

function inlineWeight(el) {
  const m = FONT_WEIGHT_RE.exec((el.getAttribute && el.getAttribute('style')) || '');
  if (m) return /^bold/i.test(m[1]) ? 700 : m[1].toLowerCase() === 'normal' ? 400 : parseInt(m[1], 10);
  // NB: node-html-parser elements expose tagName (uppercase), NOT nodeName —
  // nodeName only exists on turndown's own DOM inside the conversion rules.
  if (el.tagName === 'B' || el.tagName === 'STRONG') return 700; // tag-implied bold
  return null;
}

/** Inline styles cascade: resolve by the nearest self-or-ancestor declaration. */
function resolvedSize(el) {
  for (let n = el; n && n.getAttribute; n = n.parentNode) {
    const s = inlineSizePx(n);
    if (s) return s;
  }
  return 16; // browser default
}

function resolvedWeight(el) {
  for (let n = el; n && n.getAttribute; n = n.parentNode) {
    const w = inlineWeight(n);
    if (w) return w;
  }
  return 400;
}

const SKIP_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

/** Char-weighted font metrics of a subtree's text (optionally excluding one
 *  branch): histogram + extremes. Budgeted in TEXT NODES visited. */
function visualStats(root, excl, budget = 400) {
  const st = { chars: 0, bySize: new Map(), maxSize: 0, minSize: Infinity, maxWeight: 0 };
  const stack = [root];
  let visits = 0;
  while (stack.length && visits < budget) {
    const n = stack.pop();
    if (n === excl) continue;
    if (n.nodeType === 3) {
      visits++;
      const t = (n.text || '').replace(/\s+/g, ' ').trim();
      if (t.length < 2) continue;
      const el = n.parentNode;
      if (!el || SKIP_TEXT_TAGS.has(el.tagName)) continue;
      const size = Math.round(resolvedSize(el) * 2) / 2;
      const weight = resolvedWeight(el);
      st.chars += t.length;
      st.bySize.set(size, (st.bySize.get(size) || 0) + t.length);
      if (size > st.maxSize) st.maxSize = size;
      if (size < st.minSize) st.minSize = size;
      if (weight > st.maxWeight) st.maxWeight = weight;
    } else if (n.nodeType === 1 && !SKIP_TEXT_TAGS.has(n.tagName)) {
      for (const c of n.childNodes) stack.push(c);
    }
  }
  return st;
}

function dominantSize(bySize, fallback) {
  let best = fallback;
  let chars = 0;
  for (const [size, ch] of bySize) {
    if (ch > chars) {
      chars = ch;
      best = size;
    }
  }
  return best;
}

// Never a heading: interactive/label surfaces, cells, list items (#25), code,
// real headings — and nothing nested under an already-marked title.
const HEADING_BANNED_TAGS = new Set([
  'A', 'BUTTON', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TH', 'TD',
  'LI', 'UL', 'OL', 'DL', 'PRE', 'CODE', 'KBD', 'SAMP', 'LABEL', 'SELECT',
  'OPTION', 'TEXTAREA', 'INPUT', 'SUMMARY', 'FIGCAPTION', 'BLOCKQUOTE',
  'NAV', 'ASIDE', 'FOOTER',
]);
const HEADING_BANNED_ROLES = /^(heading|button|tab|list|listitem)$/i;

function headingBannedAt(el) {
  for (let n = el; n && n.getAttribute; n = n.parentNode) {
    if (HEADING_BANNED_TAGS.has(n.tagName)) return true;
    const role = n.getAttribute('role');
    if (role && HEADING_BANNED_ROLES.test(role)) return true;
    if (n.getAttribute('data-sagecrawl-heading')) return true;
  }
  return false;
}

const HEADING_STRUCTURAL = 'h1,h2,h3,h4,h5,h6,table,ul,ol,pre,blockquote,button,a,input,select,textarea';

/** Stamp data-sagecrawl-heading="2|3|4" on inline-styled visual titles. Mutates
 *  the tree (attributes only — content untouched). Browser-stamped markers are
 *  respected, never re-done. */
function markVisualHeadings(content) {
  const page = visualStats(content, null, 4000);
  if (!page.chars) return;
  const body = dominantSize(page.bySize, 16);
  for (const el of content.querySelectorAll('div, p, section, header')) {
    if (el.getAttribute('data-sagecrawl-heading')) continue;
    const text = textOf(el);
    if (text.length < 2 || text.length > 60) continue; // a title is one short line
    if (!/\p{L}/u.test(text)) continue; // bare numbers/prices are data, not titles
    if (headingBannedAt(el)) continue;
    if (el.querySelector(HEADING_STRUCTURAL)) continue;
    // Repeated same-shape siblings are DATA ROWS (#25 renders them as bullets),
    // never titles: a transaction row with a bold name must not become an h4.
    // Same shape signal as shapedRowItem above: tag + first class token.
    const cls0 = ((el.getAttribute('class') || '').split(/\s+/)[0] || '');
    if (cls0 && el.parentNode) {
      let alike = 0;
      for (const sib of el.parentNode.childNodes) {
        if (
          sib.nodeType === 1 &&
          sib.tagName === el.tagName &&
          ((((sib.getAttribute && sib.getAttribute('class')) || '').split(/\s+/)[0]) || '') === cls0
        ) alike++;
      }
      if (alike >= 3) continue;
    }
    const st = visualStats(el, null);
    if (!st.chars || st.maxSize < body) continue; // never smaller than the page body font
    if (st.minSize < 0.75 * st.maxSize) continue; // mixed sizes = composite block, not a title
    // LOCAL body font: dominant size of the surrounding text, so an all-big
    // block (a hero) does not promote its own lines.
    let local = body;
    for (let anc = el.parentNode, hops = 0; anc && anc.getAttribute && hops < 6; hops++, anc = anc.parentNode) {
      const around = visualStats(anc, el);
      if (around.chars >= 40) {
        local = dominantSize(around.bySize, body);
        break;
      }
    }
    const jump = st.maxSize >= 1.15 * local || (st.maxWeight >= 600 && st.maxSize >= local);
    if (!jump) continue;
    const ratio = st.maxSize / body;
    const level = ratio >= 1.8 ? 2 : ratio >= 1.35 ? 3 : 4;
    el.setAttribute('data-sagecrawl-heading', String(level));
  }
}

// Tokens that occur ONLY inside (often URL-encoded) inline-SVG markup and never
// in real prose. When a data-URI SVG image breaks attribute parsing, its body
// spills into the text as garbage blocks; this lets us drop those blocks even
// when the <img> removal above can't catch the mis-parsed remnant.
const SVG_NOISE_RE =
  /data:image\/svg|%3c\/?svg|%3csvg|feGaussianBlur|feFlood|feBlend|fegaussianblur|linearGradient|radialGradient|gradientUnits|stdDeviation|BackgroundImageFix|foregroundBlur|interpolation-filters|userSpaceOnUse/i;

/** Drop paragraph blocks that are inline-SVG / data-URI image noise. */
export function stripSvgNoise(markdown) {
  return String(markdown || '')
    .split(/\n{2,}/)
    .filter((block) => !SVG_NOISE_RE.test(block))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- #8: Trafilatura-style universal cleanup -------------------------------
// CHROME_SELECTORS above is robust but can miss IN-CONTENT navigation on unusual
// layouts (an unclassed <ul> of links, a link grid) — leaving nav boilerplate in the
// output. LINK DENSITY is the universal signal Trafilatura uses: a container that is
// almost entirely anchors, with little text of its own, is navigation — droppable
// without naming a class. It is paired with a CASCADE (Barbaresi; SIGIR-2023): keep the
// pruned "precise" extraction ONLY when it preserved the page's non-link text, else fall
// back to the un-pruned one — so pruning can NEVER lose real content (project rule #1).

/** Length of a page's NON-LINK, NON-IMAGE word text — the "content" a cascade must not
 *  lose. Link text and URLs are excluded ON PURPOSE: removing navigation (which is all
 *  links) must not look like content loss, while removing prose/code must. */
export function contentWordLen(markdown) {
  return String(markdown || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, ' ') // links: drop BOTH visible text and url
    .replace(/<https?:\/\/[^>\s]+>/gi, ' ') // autolinks
    .replace(/[#>|`*_~+\-]/g, ' ') // markdown structural punctuation
    .replace(/\s+/g, ' ')
    .trim().length;
}

/** Remove clearly-navigational, link-dense containers from within the content node.
 *  Universal (a ratio, never a class name) and bounded (only containers that are almost
 *  all links with little text of their own). NAVIGATION navigates the SITE, so a
 *  link-dense container is pruned only when its links stay overwhelmingly on `host`
 *  (relative hrefs count as internal): a list pointing mostly OFF-site is a
 *  reference/resource list — content the cascade below cannot protect, because
 *  contentWordLen ignores link text by design. Mutates `content`; returns the count
 *  removed. */
function pruneNavByLinkDensity(content, host = '') {
  const MIN_LINKS = 4; // a couple of links is prose; navigation has many
  const DENSITY = 0.8; // ≥80% of the text is anchor text → navigation
  const MAX_NONLINK_CHARS = 200; // and little text of its own (bullets / separators)
  const MAX_EXTERNAL = 0.2; // more than this fraction off-site → references, kept
  const naked = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
  const site = naked(host);
  const matches = [];
  for (const el of content.querySelectorAll('ul, ol, nav, div, section')) {
    const anchors = el.querySelectorAll('a');
    if (anchors.length < MIN_LINKS) continue;
    if (site) {
      let external = 0;
      for (const a of anchors) {
        const m = (a.getAttribute('href') || '').match(/^https?:\/\/([^/:?#]+)/i);
        if (m && naked(m[1]) !== site) external++;
      }
      if (external / anchors.length > MAX_EXTERNAL) continue;
    }
    const total = textOf(el).length;
    if (!total) continue;
    let linkLen = 0;
    for (const a of anchors) linkLen += textOf(a).length;
    if (linkLen / total >= DENSITY && total - linkLen <= MAX_NONLINK_CHARS) matches.push(el);
  }
  const set = new Set(matches);
  let removed = 0;
  for (const el of matches) {
    // Remove only the OUTERMOST match (skip one nested inside another slated node) so we
    // never touch an already-detached child.
    let p = el.parentNode;
    let nested = false;
    while (p && p !== content) {
      if (set.has(p)) {
        nested = true;
        break;
      }
      p = p.parentNode;
    }
    if (nested) continue;
    try {
      el.remove();
      removed++;
    } catch {
      /* already detached */
    }
  }
  return removed;
}

// Doc-toolbar chrome that frameworks render INSIDE the article (so the DOM chrome pass
// misses it): "Edit this page", "Copy Page as Markdown", feedback widgets, etc.
// Stripped generically by phrase, as links or standalone lines.
const TOOLBAR =
  '(?:edit (?:this )?page|edit (?:on|in) github|edit source|copy (?:page|markdown)(?: as markdown)?|copy as markdown|view source|view (?:page )?source|open in [^\\]\\n]{0,30}|report (?:an? )?(?:issue|problem|bug)|give feedback|send feedback|provide feedback|was this (?:page )?helpful[^\\n]*)';

/** Line-level Markdown cleanups that must NEVER reach inside a fenced code block:
 *  drop toolbar/artifact lines, collapse whitespace runs BETWEEN words (leading
 *  indentation is structure — nested lists and code depend on it), trim trailing
 *  spaces, cap blank runs at one. The previous whole-string regexes flattened the
 *  indentation of every ``` fence too, wrecking each code sample's layout. */
function cleanupLines(markdown) {
  const toolbarLine = new RegExp('^[ \\t]*' + TOOLBAR + '[ \\t]*$', 'i');
  const out = [];
  let inFence = false;
  let fence = '';
  let blanks = 0;
  for (const line of String(markdown).split('\n')) {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (m) {
      if (!inFence) {
        inFence = true;
        fence = m[1];
      } else if (line.trim().startsWith(fence)) {
        inFence = false;
      }
      out.push(line);
      blanks = 0;
      continue;
    }
    if (inFence) {
      out.push(line); // verbatim inside code
      continue;
    }
    const l = line.replace(/(\S)[ \t]{2,}/g, '$1 ').replace(/[ \t]+$/, '');
    // toolbar actions rendered as plain standalone lines
    if (toolbarLine.test(l)) continue;
    // orphan link-close artifacts from broken next/prev nav-card markup: a line
    // that is only `](url)` with no opening bracket.
    if (/^[ \t]*\]\([^)]*\)[ \t]*$/.test(l)) continue;
    // orphan punctuation from a card whose image/body was removed: a line that is
    // only `[`, `]` or `!` is never meaningful Markdown outside a fence.
    if (/^[[\]!]$/.test(l.trim())) continue;
    if (l.trim() === '') {
      blanks++;
      if (blanks > 1) continue;
    } else blanks = 0;
    out.push(l);
  }
  return out.join('\n').trim();
}

/** Turndown a prepared content node and run the deterministic Markdown cleanups. */
function renderMarkdown(content) {
  const td = buildTurndown();
  let markdown = '';
  try {
    markdown = td.turndown(content.innerHTML || '');
  } catch {
    markdown = textOf(content);
  }
  markdown = markdown
    // permalink/anchor links whose visible text is just '#', '¶', or empty —
    // but never the `[](src)` tail of an image `![](src)` (the lookbehind), or a
    // lazy-loaded empty-alt avatar would leave an orphan `!` in its place,
    // corrupting the block (and its dedup identity) in every later capture.
    .replace(/(?<!!)\[\s*[#¶]?\s*\]\([^)]*\)/g, '')
    // sponsor/ad links rendered inline ("ads via …", "sponsored by …")
    .replace(/\[\s*(?:ads?\s+via|sponsored\b|advertisement)[^\]]*\]\([^)]*\)/gi, '')
    // toolbar actions rendered as links (text may span lines)
    .replace(new RegExp('\\[\\s*' + TOOLBAR + '\\s*\\]\\([^)]*\\)', 'gi'), '')
    // trailing "next/prev page" footer navigation block (kept conservative to
    // clearly-navigational lead-ins so real "next steps" content is not cut).
    .replace(/\n#{1,6}[ \t]*(?:ready for more|continue your learning|keep reading)\b[\s\S]*$/i, '');
  markdown = cleanupLines(markdown);

  // Final safety net: remove any inline-SVG/data-URI image noise that leaked as text
  // (broken data-URI attributes spill their SVG body into the document).
  return stripSvgNoise(markdown);
}

/**
 * Convert an HTML document to `{ title, markdown }`.
 * @param {string} html
 * @param {object} opts
 * @param {string|string[]} [opts.contentSelector] framework-specific container(s)
 * @param {string} [opts.baseUrl] for absolutising links
 * @param {string} [opts.title] override the derived title
 */
export function extractMarkdown(html, { contentSelector, baseUrl, title } = {}) {
  if (!html || typeof html !== 'string') return { title: title || '', markdown: '' };

  const root = parse(html, {
    comment: false,
    blockTextElements: { script: false, style: false, noscript: false },
  });

  // The reveal marks non-visible elements (hidden modals, off-state placeholders,
  // on-screen keyboards) with data-sagecrawl-hidden so the serialized HTML doesn't
  // leak them into the output. Drop them before anything else inspects the DOM, so
  // even the main-content picker never lands on a hidden panel. No-op for the
  // static path (no markers present).
  for (const n of root.querySelectorAll('[data-sagecrawl-hidden]')) n.remove();

  const docTitle =
    title ||
    textOf(root.querySelector('h1')) ||
    textOf(root.querySelector('title')) ||
    '';

  absolutize(root, baseUrl);

  const content = pickMainContent(root, contentSelector);

  // Strip chrome from inside the chosen node.
  for (const sel of CHROME_SELECTORS) {
    for (const n of content.querySelectorAll(sel)) n.remove();
  }
  // <header> is chrome ONLY as a site masthead. Inside an <article> it is that
  // article's own title/byline block — spec-blessed content (HTML5 sectioning) that
  // a blanket removal used to silently delete from every blog/news page.
  for (const n of content.querySelectorAll('header')) {
    if (!n.closest('article')) n.remove();
  }

  // Drop data-URI / inline-SVG images. Sites embed decorative gradients, blurs
  // and icons as <img src="data:image/svg+xml,…">; they carry no extractable
  // text and the raw SVG markup (quotes/parens/newlines) shatters into garbage
  // Markdown. Real-URL images (http/https) are kept so they can still be
  // extracted, separated, or excluded by task.
  for (const img of content.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    const srcset = img.getAttribute('srcset') || '';
    if (/^\s*data:/i.test(src) || /data:image/i.test(srcset)) img.remove();
  }
  // Inline <svg> nodes are removed by CHROME_SELECTORS above, but defensively
  // drop any that slipped through (e.g. namespaced) so their markup never leaks.
  for (const n of content.querySelectorAll('svg')) n.remove();

  // Self-served ad cards with no stable class/id (docs themes' own promos) still
  // carry the Carbon-convention label "ads via <sponsor>". Remove the unit by that
  // label: when the label sits inside a link, the link IS the ad's clickable card —
  // drop the whole card (image + ad copy included), else just the label element.
  // Bounded to short, label-only elements so prose mentioning the phrase survives.
  const adCards = [];
  for (const el of content.querySelectorAll('a, span, div, small, p')) {
    const t = textOf(el);
    if (t.length <= 30 && /^ads?\s+via\b/i.test(t)) adCards.push(el.closest('a') || el);
  }
  for (const el of adCards) {
    try {
      el.remove();
    } catch {
      /* already detached with its card */
    }
  }

  // #26 — recover the page's visual skeleton: inline-styled titles get their
  // data-sagecrawl-heading marker (browser captures arrive with markers already
  // stamped from computed styles; those are respected, not re-done). Adds
  // attributes only — marking can never change or lose text.
  try {
    markVisualHeadings(content);
  } catch {
    /* marking must never break extraction */
  }

  // #8 — extract PRECISELY (prune link-dense in-content navigation), but CASCADE: keep
  // the pruned result only when it preserved the page's non-link content; otherwise fall
  // back to the un-pruned extraction. So navigation boilerplate is trimmed without ever
  // losing real prose/code. `full` is computed BEFORE pruning (it is the safe fallback).
  const full = renderMarkdown(content);
  let markdown = full;
  let host = '';
  try {
    host = new URL(baseUrl || '').hostname;
  } catch {
    /* no base → no internal/external signal; density alone decides, as before */
  }
  if (pruneNavByLinkDensity(content, host) > 0) {
    const pruned = renderMarkdown(content);
    // Accept the trim only if it kept ≥98% of the non-link word content — i.e. it
    // removed navigation, not content. This is the "precise → permissive" fallback.
    if (contentWordLen(pruned) >= contentWordLen(full) * 0.98) markdown = pruned;
  }

  return { title: docTitle.trim(), markdown };
}

/**
 * Split Markdown into structural blocks (paragraphs, headings, list chunks,
 * tables, fenced code) without breaking fenced code blocks. Used for
 * cross-state de-duplication.
 */
export function splitBlocks(markdown) {
  const lines = (markdown || '').split('\n');
  const blocks = [];
  let buf = [];
  let inFence = false;
  let fence = '';

  const flush = () => {
    const t = buf.join('\n').trim();
    if (t) blocks.push(t);
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (m) {
      if (!inFence) {
        flush();
        inFence = true;
        fence = m[1];
        buf.push(line);
      } else if (line.trim().startsWith(fence)) {
        buf.push(line);
        inFence = false;
        flush();
      } else {
        buf.push(line);
      }
      continue;
    }
    if (inFence) {
      buf.push(line);
      continue;
    }
    if (line.trim() === '') flush();
    else buf.push(line);
  }
  flush();
  return blocks;
}

/**
 * Classify a Markdown block by structural TYPE and image-ness. Pure/deterministic
 * so the layout router (and the block-metadata spine) agree on what a block is.
 * `text` here is the paragraph type (kept for back-compat with existing routing).
 */
export function classifyBlock(text) {
  const t = String(text || '').trim();
  const hasImage = /!\[[^\]]*\]\([^)]*\)/.test(t);
  let type = 'text';
  if (/^#{1,6}\s/.test(t)) type = 'heading';
  else if (/^\s*(```|~~~)/.test(t)) type = 'code';
  else if (/\|/.test(t) && /\n\s*\|?[\s:|-]*-{2,}/.test(t)) type = 'table';
  else if (/^\s*([-*+]|\d+[.)])\s/m.test(t) && !hasImage) type = 'list';
  else if (hasImage && t.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[\s)\]]/g, '').length < 3) type = 'image';
  return { type, hasImage };
}

/** Heading depth of a block (# = 1 … ###### = 6), or 0 if it is not a heading. */
function headingLevel(text) {
  const m = String(text || '').match(/^(#{1,6})\s/);
  return m ? m[1].length : 0;
}

/**
 * Enrich raw blocks (`{ text, provenance? }` or bare strings) with the structural
 * metadata every AI layer addresses blocks by:
 *   - `type` / `hasImage` — what the block is.
 *   - `sectionPath` — the heading ancestry the block falls UNDER (its parent
 *     headings, not itself), so a rule like "everything under Privacy Policy" or
 *     "only the white pizzas" is a metadata match, not a per-case rule.
 *   - `ord` — document-order index within the page (for ordinal tasks / stable sort).
 *   - `provenance` — which interaction surfaced the block (`baseline`, `tab:…`,
 *     `expander:…`, `dropdown:…`, `loadmore`), so "the dropdown results" is routable.
 * This is the spine that lets layout stay one general AI-judged mechanism.
 */
export function enrichBlocks(rawBlocks) {
  const stack = []; // active heading ancestry: { level, title }
  return (rawBlocks || []).map((b, ord) => {
    const text = typeof b === 'string' ? b : b.text;
    const provenance = (b && typeof b === 'object' && b.provenance) || 'baseline';
    const { type, hasImage } = classifyBlock(text);
    const lvl = headingLevel(text);
    let sectionPath;
    if (lvl) {
      while (stack.length && stack[stack.length - 1].level >= lvl) stack.pop();
      sectionPath = stack.map((s) => s.title);
      stack.push({ level: lvl, title: text.replace(/^#{1,6}\s*/, '').trim().slice(0, 80) });
    } else {
      sectionPath = stack.map((s) => s.title);
    }
    return { text, type, hasImage, provenance, sectionPath, ord };
  });
}

/**
 * Remove every image from Markdown — verbatim-safe (it drops a media element, it
 * never rewrites prose). Covers inline `![alt](src)`, reference `![alt][id]`,
 * images wrapped in a link `[![alt](src)](href)`, and any raw `<img>` that
 * survived conversion. Honors a task like "don't include images".
 */
export function stripImages(markdown) {
  return String(markdown || '')
    // linked image: [![alt](src)](href) — drop the whole thing
    .replace(/\[\s*!\[[^\]]*\]\([^)]*\)\s*\]\([^)]*\)/g, '')
    // inline image: ![alt](src "title")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // reference image: ![alt][id]
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    // raw <img …> tags that slipped through conversion
    .replace(/<img\b[^>]*>/gi, '')
    // tidy up artifacts left behind (trailing spaces, blank pile-ups)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Remove hyperlinks but KEEP their visible text — `[text](url)` -> `text`,
 * `<https://…>` -> dropped. Verbatim-safe for the words; only the link target is
 * dropped. Honors a task like "strip the links". Run AFTER stripImages so an
 * image's leftover does not get mistaken for link text.
 */
export function stripLinks(markdown) {
  return String(markdown || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/gi, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Apply the task's faithful element exclusions to a Markdown string. A no-op when
 * nothing is excluded, so callers can invoke it unconditionally.
 * @param {string} markdown
 * @param {{ images?: boolean, links?: boolean }} [exclude]
 */
export function applyExclusions(markdown, exclude = {}) {
  let md = String(markdown || '');
  if (exclude.images) md = stripImages(md);
  if (exclude.links) md = stripLinks(md);
  return md;
}

/** A block's DEDUP identity. Decorative empty-alt images (`![](src)`) are excluded
 *  from it: they lazy-load, so the same row serialises WITHOUT its avatar in the
 *  baseline capture and WITH it a click later — two keys for one block, and the
 *  whole table/list re-enters the document on every state. Images with real alt
 *  text stay in the key (two cards may differ only by their pictures); a block
 *  that is ONLY an image keeps its full identity. */
const normalizeBlock = (s) => {
  let t = s;
  // A TABLE's identity is its ROWS, not their order: clicking a sortable column
  // header re-serialises the same table re-sorted, and keeping every ordering
  // repeats it whole. Sort the row lines for the KEY only (the stored block stays
  // verbatim, first-seen ordering).
  if (/^\s*\|/.test(t) && /\n\s*\|?[\s:|-]*-{2,}/.test(t)) {
    t = t
      .split('\n')
      .map((l) => l.trim())
      .sort()
      .join('\n');
  }
  const noDecorative = t.replace(/!\[\s*\]\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return noDecorative || t.replace(/\s+/g, ' ').trim().toLowerCase();
};

/**
 * Accumulates unique content blocks seen across many page states (e.g. each tab
 * of a tab group, each expanded accordion). Shared content is de-duplicated;
 * first-seen order is preserved. Blocks revealed by a labelled control (a tab
 * variant) carry that label so provenance survives into the output.
 */
export class BlockAccumulator {
  constructor() {
    this.seen = new Set();
    this.blocks = []; // { key, text, label, provenance }
  }

  /**
   * Merge the *new* blocks of `markdown` into the accumulated document IN PLACE:
   * each new block is inserted right before the nearest FOLLOWING block the
   * accumulator already holds — i.e. at its position in the new state's own
   * reading order — falling back to append when nothing known follows it.
   * Mutually-exclusive reveal states (framework tabs like pnpm/yarn/npm/bun)
   * thus land beside the sibling they replace, in the section they belong to,
   * instead of piling up at the end of the document detached from all context
   * (appended content — load-more, lazy scroll — still ends up at the end,
   * because nothing known follows it). Returns the count of new blocks.
   *
   * `label` is the TAB-variant marker used by toMarkdown.
   * `provenance` is the richer reveal source carried to the layout router
   * (`baseline` / `tab:…` / `expander:…` / `dropdown:…` / `loadmore`).
   */
  add(markdown, { label, provenance } = {}) {
    const texts = splitBlocks(markdown);
    const n = texts.length;
    const at = new Map(this.blocks.map((b, i) => [b.key, i]));
    const keys = new Array(n);
    const matched = new Array(n); // capture block -> its accumulator index, or -1 if new
    for (let i = 0; i < n; i++) {
      keys[i] = createHash('sha1').update(normalizeBlock(texts[i])).digest('hex');
      matched[i] = at.has(keys[i]) ? at.get(keys[i]) : -1;
    }
    // Anchor scan (right to left): a new block inserts before the accumulator
    // position of the next matched block in THIS capture.
    const before = new Array(n);
    let next = this.blocks.length;
    for (let i = n - 1; i >= 0; i--) {
      if (matched[i] >= 0) next = matched[i];
      before[i] = next;
    }
    const inserts = new Map(); // accumulator index -> new blocks to insert before it
    let added = 0;
    for (let i = 0; i < n; i++) {
      if (matched[i] >= 0 || this.seen.has(keys[i])) continue; // known, or dup within this capture
      this.seen.add(keys[i]);
      const blk = { key: keys[i], text: texts[i], label: label || null, provenance: provenance || 'baseline' };
      const list = inserts.get(before[i]);
      if (list) list.push(blk);
      else inserts.set(before[i], [blk]);
      added++;
    }
    if (added) {
      const merged = [];
      for (let i = 0; i <= this.blocks.length; i++) {
        const ins = inserts.get(i);
        if (ins) merged.push(...ins);
        if (i < this.blocks.length) merged.push(this.blocks[i]);
      }
      this.blocks = merged;
    }
    return added;
  }

  size() {
    return this.blocks.length;
  }

  /** Raw blocks (`{ text, provenance }`) in capture order for the layout router. */
  toBlocks() {
    return this.blocks.map((b) => ({ text: b.text, provenance: b.provenance || 'baseline' }));
  }

  toMarkdown() {
    const out = [];
    let lastLabel = null;
    for (const blk of this.blocks) {
      // A VISIBLE variant marker: the tab's own label, bold, where the original UI
      // showed the tab. An HTML comment (`<!-- variant: … -->`) disappears in every
      // rendered view, leaving the variants indistinguishable from one another.
      if (blk.label && blk.label !== lastLabel) out.push(`**${blk.label}:**`);
      lastLabel = blk.label || null;
      out.push(blk.text);
    }
    return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }
}
