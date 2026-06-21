// Output layout — decide how the crawl's pages become .md files.
//
// The rule (set by the product): by DEFAULT everything lands in ONE .md file.
// The model only splits the content into several named files when the task
// asks for it ("extract drinks and pizzas separately" -> drinks.md + pizzas.md;
// "extract the menu prices" -> menu.md). Content is always kept VERBATIM — the
// model only chooses the grouping and the filenames, never rewrites text — and
// no section is ever dropped: anything the model fails to assign is folded into
// the first file so the output is always complete.

import { slug } from './url.mjs';
import { aiPlanLayout } from '../engine/decide.mjs';

// Above this many units we don't ask the model to group (the prompt would be
// huge and unreliable); we consolidate into a single file instead.
const UNIT_CAP = 150;

/** Split markdown into heading-delimited sections (verbatim text preserved). */
function splitSections(markdown) {
  const lines = String(markdown || '').split('\n');
  const sections = [];
  let cur = { heading: '', lines: [] };
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && line.match(/^(#{1,3})\s+(.*)/);
    if (h) {
      if (cur.lines.length) sections.push(cur);
      cur = { heading: h[2].trim().slice(0, 100), lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.lines.length) sections.push(cur);
  return sections
    .map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() }))
    .filter((s) => s.text);
}

/** Sanitise a model-proposed filename to a safe, unique `*.md` name. */
function sanitizeName(raw, used) {
  let base = slug(String(raw || '').replace(/\.md$/i, ''));
  if (!base) base = 'content';
  let name = `${base}.md`;
  let n = 2;
  while (used.has(name)) name = `${base}-${n++}.md`;
  used.add(name);
  return name;
}

/** Derive a fallback filename from the task (used only if the model fails). */
function taskToName(task) {
  const stop = new Set([
    'extract', 'get', 'the', 'a', 'an', 'of', 'all', 'from', 'and', 'to', 'for',
    'me', 'please', 'only', 'list', 'every', 'their', 'its', 'in', 'on', 'with',
  ]);
  const words = String(task || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !stop.has(w))
    .slice(0, 4);
  return words.join('-') || 'content';
}

/**
 * Derive a filename base from a page (its URL's last path/fragment segment, else
 * its title). This is COSMETIC output naming only — it makes no crawl decision,
 * so parsing the URL here does not violate the "no URL-shape rules" principle
 * that governs link-following (decide.mjs). Works for normal paths (/docs/intro
 * -> "intro") and SPA fragment routes (/#/about -> "about", /#/feature01 ->
 * "feature01"); the root (/#/) has no segment, so it becomes "home".
 */
function pageFileBase(page) {
  let seg = '';
  try {
    const u = new URL(page.url);
    const tail = (u.pathname + u.hash).split(/[/#!?]+/).filter(Boolean);
    seg = tail.length ? tail[tail.length - 1] : '';
  } catch {
    /* fall through to title */
  }
  // Note: slug('') returns its own fallback ('section'), so only slug a
  // non-empty source; the root page (no segment, no title) becomes "home".
  const raw = (seg || page.title || '').trim();
  return raw ? slug(raw) : 'home';
}

function deriveTitle(filename) {
  return filename
    .replace(/\.md$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function frontMatter({ task, sources, generatedAt }) {
  const lines = ['---', `task: ${JSON.stringify(task || '')}`, `generatedAt: ${generatedAt}`];
  if (sources && sources.length) {
    lines.push('sources:');
    for (const s of sources) lines.push(`  - ${s}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

/** Assemble one output file from a list of units (verbatim, original order). */
function makeFile(filename, task, units, generatedAt) {
  const sources = [];
  const seen = new Set();
  for (const u of units) {
    const url = u.page && u.page.url;
    if (url && !seen.has(url)) {
      seen.add(url);
      sources.push(url);
    }
  }
  const body = units.map((u) => u.text).join('\n\n').trim();
  const markdown = frontMatter({ task, sources, generatedAt }) + body + '\n';
  return {
    filename,
    title: deriveTitle(filename),
    markdown,
    bytes: Buffer.byteLength(markdown, 'utf8'),
    pages: sources,
  };
}

function singleFile(task, units, generatedAt) {
  const name = sanitizeName(taskToName(task), new Set());
  return makeFile(name, task, units, generatedAt);
}

/**
 * One output file per crawled page (the "by pages" layout). Groups units by
 * their source page in first-seen (crawl) order and names each file from the
 * page. Lossless — every unit belongs to exactly one page — so the model only
 * has to choose this layout, never enumerate the files.
 */
function filesPerPage(task, units, generatedAt) {
  const used = new Set();
  const order = [];
  const byPage = new Map();
  for (const u of units) {
    if (!byPage.has(u.page)) {
      byPage.set(u.page, []);
      order.push(u.page);
    }
    byPage.get(u.page).push(u);
  }
  return order.map((page) =>
    makeFile(sanitizeName(pageFileBase(page), used), task, byPage.get(page), generatedAt),
  );
}

/**
 * Plan and assemble the output files for a finished crawl.
 * @param {object} a
 * @param {string} a.model   Ollama model for the grouping decision
 * @param {string} a.task    the (primary) task driving the grouping
 * @param {Array}  a.pages   result.pages
 * @returns {Promise<Array<{ filename, title, markdown, bytes, pages: string[] }>>}
 */
export async function planFiles({ model, task, pages, host }) {
  const all = (pages || []).filter((p) => (p.markdown || '').trim());
  if (all.length === 0) return [];
  const generatedAt = new Date().toISOString();

  // Build the units the model will group. Prefer heading-level sections (so a
  // single menu page can split into drinks/pizzas); if that explodes, fall back
  // to page-level units; if still too many, consolidate without asking the model.
  let units = [];
  for (const p of all) {
    for (const sec of splitSections(p.markdown)) {
      units.push({ page: p, heading: sec.heading || p.title || p.url, text: sec.text });
    }
  }
  if (units.length === 0 || units.length > UNIT_CAP) {
    units = all.map((p) => ({ page: p, heading: p.title || p.url, text: (p.markdown || '').trim() }));
  }
  if (units.length === 0) return [];
  if (units.length > UNIT_CAP) return [singleFile(task, units, generatedAt)];

  let plan = null;
  try {
    plan = await aiPlanLayout({
      model,
      task,
      host,
      items: units.map((u, i) => ({
        index: i,
        source: u.page.title || u.page.url,
        heading: u.heading,
        preview: u.text.replace(/\s+/g, ' ').slice(0, 160),
      })),
    });
  } catch {
    plan = null;
  }

  // "by pages" — one lossless file per source page, built deterministically.
  if (plan && plan.perPage) return filesPerPage(task, units, generatedAt);

  if (!plan || !Array.isArray(plan.files) || plan.files.length === 0) {
    return [singleFile(task, units, generatedAt)];
  }

  // Sanitise each proposed file's item list, keeping the model's file order.
  const planned = plan.files
    .map((pf) => ({
      filename: pf.filename,
      items: (Array.isArray(pf.items) ? pf.items : [])
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0 && n < units.length),
    }))
    .filter((p) => p.items.length);
  if (planned.length === 0) return [singleFile(task, units, generatedAt)];

  // Assign each unit to exactly one file. Claim priority goes to the MOST
  // SPECIFIC file (fewest listed items) first, so a dedicated "faq.md" wins the
  // faq unit even when a catch-all file also (wrongly) lists it — a common model
  // slip that otherwise collapses the split back into one file.
  const assigned = new Set();
  for (const p of [...planned].sort((a, b) => a.items.length - b.items.length)) {
    p.claimed = p.items.filter((n) => !assigned.has(n));
    for (const n of p.claimed) assigned.add(n);
  }

  const used = new Set();
  const groups = planned
    .filter((p) => p.claimed.length)
    .map((p) => ({ name: sanitizeName(p.filename, used), idxs: p.claimed }));
  if (groups.length === 0) return [singleFile(task, units, generatedAt)];

  // Completeness: nothing the model left unplaced may be dropped. If those
  // leftovers outnumber the biggest named bucket, they ARE "the rest" — give
  // them their own file so a "separate X from the rest" split still produces the
  // rest (instead of being folded back into the special bucket and vanishing as
  // a separate file). Otherwise they're a stray miss from a catch-all/single
  // file, so fold them into the largest existing group.
  const leftover = [];
  for (let i = 0; i < units.length; i++) if (!assigned.has(i)) leftover.push(i);
  if (leftover.length) {
    const largest = groups.reduce((a, b) => (b.idxs.length > a.idxs.length ? b : a));
    if (largest.idxs.length >= leftover.length) largest.idxs = largest.idxs.concat(leftover);
    else groups.push({ name: sanitizeName('other', used), idxs: leftover });
  }

  return groups.map((g) => {
    const idxs = Array.from(new Set(g.idxs)).sort((a, b) => a - b);
    return makeFile(g.name, task, idxs.map((i) => units[i]), generatedAt);
  });
}
