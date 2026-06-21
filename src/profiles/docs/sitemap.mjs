// Tier 2 of the documentation profile: sitemap enumeration.
//
// Follows sitemap indexes recursively, collects every <loc>, and also reads
// Sitemap: directives from robots.txt. Filtering to the docs section is done by
// the caller (it knows the base path).

import { fetchText } from '../../lib/fetcher.mjs';
import { XMLParser } from 'fast-xml-parser';
import { originOf } from '../../lib/url.mjs';

function toArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * Collect all page URLs reachable from a site's sitemaps.
 * @param {string} baseUrl
 * @param {object} [opts]
 * @param {() => boolean} [opts.shouldStop]
 * @param {number} [opts.maxDepth] sitemap-index recursion depth
 * @returns {Promise<string[]>}
 */
export async function collectSitemapUrls(baseUrl, { shouldStop, maxDepth = 4 } = {}) {
  const origin = originOf(baseUrl);
  if (!origin) return [];

  const candidates = [
    origin + '/sitemap.xml',
    origin + '/sitemap_index.xml',
    origin + '/sitemap-index.xml',
  ];

  // robots.txt may advertise sitemaps elsewhere.
  const robots = await fetchText(origin + '/robots.txt', { accept: 'text/plain, */*' });
  if (robots.ok && robots.text) {
    for (const m of robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
      candidates.push(m[1].trim());
    }
  }

  const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });
  const seen = new Set();
  const urls = new Set();

  async function walk(smUrl, depth) {
    if (depth > maxDepth || seen.has(smUrl)) return;
    if (shouldStop && shouldStop()) return;
    seen.add(smUrl);

    const res = await fetchText(smUrl, { accept: 'application/xml, text/xml, */*' });
    if (!res.ok || !res.text) return;

    let xml;
    try {
      xml = parser.parse(res.text);
    } catch {
      return;
    }

    if (xml.sitemapindex) {
      for (const sm of toArray(xml.sitemapindex.sitemap)) {
        if (sm && sm.loc) await walk(String(sm.loc).trim(), depth + 1);
      }
    } else if (xml.urlset) {
      for (const u of toArray(xml.urlset.url)) {
        if (u && u.loc) urls.add(String(u.loc).trim());
      }
    }
  }

  for (const c of [...new Set(candidates)]) {
    if (shouldStop && shouldStop()) break;
    await walk(c, 0);
  }

  return [...urls];
}
