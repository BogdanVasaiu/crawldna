// Docs-generator detection + dispatch. Each entry maps a framework to a
// content-container selector and a nav-tree selector. Detection is per
// framework, not per site (§11.2).

import { parse } from 'node-html-parser';
import docusaurus from './docusaurus.mjs';
import vitepress from './vitepress.mjs';
import mkdocs from './mkdocs.mjs';
import generic from './generic.mjs';
import { resolveUrl } from '../../../lib/url.mjs';

// Lighter-weight generators handled inline (same shape as the dedicated files).
const INLINE = [
  {
    name: 'nextra',
    match: (root, html) => /nextra/i.test(html) || !!root.querySelector('.nextra-content') || !!root.querySelector('main .nextra-body'),
    contentSelector: ['.nextra-content main', '.nextra-content', 'article', 'main'],
    navSelector: ['.nextra-nav-container', 'nav', 'aside'],
  },
  {
    name: 'starlight',
    match: (root, html) => /starlight/i.test(html) || !!root.querySelector('.sl-markdown-content') || !!root.querySelector('[data-page-title]'),
    contentSelector: ['.sl-markdown-content', 'main .content', 'main'],
    navSelector: ['nav.sidebar', '.sidebar-content', 'starlight-toc'],
  },
  {
    name: 'sphinx',
    match: (root, html) => /sphinx|readthedocs/i.test(html) || !!root.querySelector('div[role=main]') && !!root.querySelector('.sphinxsidebar, .wy-nav-side'),
    contentSelector: ['[role=main] .document', '[role=main]', '.document', '.rst-content', 'main'],
    navSelector: ['.wy-menu', '.sphinxsidebarwrapper', '.toctree-wrapper', 'nav'],
  },
  {
    name: 'mintlify',
    match: (root, html) => /mintlify/i.test(html) || !!root.querySelector('#content-area') || !!root.querySelector('[data-page]'),
    contentSelector: ['#content-area', 'article', 'main'],
    navSelector: ['#navigation-items', 'nav', 'aside'],
  },
  {
    name: 'gitbook',
    match: (root, html) => /gitbook/i.test(html) || !!root.querySelector('.book-body') || !!root.querySelector('[data-testid=page]'),
    contentSelector: ['.book-body .page-inner', '[data-testid=page] main', 'main'],
    navSelector: ['.book-summary', 'nav', 'aside'],
  },
  {
    name: 'fumadocs',
    match: (root, html) => /fumadocs/i.test(html) || !!root.querySelector('#nd-page') || !!root.querySelector('article[data-fd-page]'),
    contentSelector: ['#nd-page article', 'article', 'main'],
    navSelector: ['#nd-sidebar', 'nav', 'aside'],
  },
];

// Dedicated handlers take priority; generic is always last.
const FRAMEWORKS = [docusaurus, vitepress, mkdocs, ...INLINE];

/** Detect the docs generator from page HTML. Always returns a config. */
export function detectFramework(html) {
  let root;
  try {
    root = parse(html);
  } catch {
    return generic;
  }
  for (const fw of FRAMEWORKS) {
    try {
      if (fw.match(root, html)) return fw;
    } catch {
      /* ignore a bad matcher */
    }
  }
  return generic;
}

/**
 * Collect navigation links from the rendered nav tree as a second source of
 * the full page list. Returns absolute, deduped URLs.
 */
export function navLinks(html, baseUrl, fw) {
  let root;
  try {
    root = parse(html);
  } catch {
    return [];
  }
  const out = new Set();
  const navSelectors = [].concat((fw && fw.navSelector) || []).filter(Boolean);
  const containers = [];
  for (const sel of navSelectors) {
    for (const n of root.querySelectorAll(sel)) containers.push(n);
  }
  if (!containers.length) containers.push(root);

  for (const container of containers) {
    for (const a of container.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
      const abs = resolveUrl(href, baseUrl);
      if (abs) out.add(abs);
    }
  }
  return [...out];
}
