// Tier 1 of the documentation profile: /llms-full.txt.
//
// If a site publishes /llms-full.txt it already contains the entire docs set as
// clean Markdown. We split it by sections and we are done — no browser, no
// per-page fetching. /llms.txt (without -full) is only a curated index and is
// never treated as the complete page list.

import { fetchText } from '../../lib/fetcher.mjs';
import { originOf, slug } from '../../lib/url.mjs';

function looksLikeHtml(text) {
  return /^\s*<(?:!doctype|html|\?xml)/i.test(text);
}

/**
 * Find an *explicit* source URL declared for a section (a `Source:`/`URL:`
 * marker, optionally inside a blockquote, optionally as a markdown link).
 * We deliberately do NOT fall back to the first arbitrary link in the body —
 * that picks up unrelated outbound links and mislabels the page.
 */
function findSource(md) {
  // Only look near the top of the section.
  const head = md.split(/\r?\n/).slice(0, 6).join('\n');
  const m = head.match(/^\s*>?\s*(?:source|url|canonical)\s*[:=]\s*(?:\[[^\]]*\]\()?\s*<?(https?:\/\/[^\s)>]+)/im);
  return m ? m[1] : null;
}

/** Split a big markdown document on heading lines matching `re`. */
function splitOnHeading(text, re) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = re.exec(line);
    if (m) {
      if (cur) sections.push(cur);
      cur = { title: m[1].trim(), lines: [line] };
    } else {
      if (!cur) cur = { title: '', lines: [] };
      cur.lines.push(line);
    }
  }
  if (cur) sections.push(cur);
  return sections;
}

/**
 * Fetch and split /llms-full.txt.
 * @returns {Promise<null | { sourceUrl: string, pages: Array<{url,title,markdown}> }>}
 */
export async function tryLlmsFull(baseUrl) {
  const origin = originOf(baseUrl);
  if (!origin) return null;
  const sourceUrl = origin + '/llms-full.txt';

  const res = await fetchText(sourceUrl, { accept: 'text/plain, text/markdown, */*' });
  if (!res.ok || !res.text || res.text.length < 500) return null;
  if (looksLikeHtml(res.text)) return null; // a soft-404 served as HTML

  // Prefer H1 boundaries; if the doc is one big H1-less blob, fall back to H2.
  let sections = splitOnHeading(res.text, /^#\s+(.+)/);
  if (sections.length < 2) sections = splitOnHeading(res.text, /^##\s+(.+)/);

  const pages = sections
    .map((s, i) => {
      const markdown = s.lines.join('\n').trim();
      const title = s.title || `Section ${i + 1}`;
      const url = findSource(markdown) || `${origin}/#${slug(title)}`;
      return { url, title, markdown };
    })
    .filter((p) => p.markdown.length > 0);

  if (!pages.length) return null;
  return { sourceUrl, pages };
}
