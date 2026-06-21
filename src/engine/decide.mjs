// The AI judgment layer. Two jobs, both kept verbatim-safe:
//   - aiScopeContent: keep only the sections relevant to the task (e.g. drop a
//     marketing/landing/footer section when the task is "documentation"; keep
//     only the menu when the task is "the pizza menu"). Output is the ORIGINAL
//     text of the kept sections — the model never rewrites content.
//   - aiSelectLinks: pick which discovered links lead to more task-relevant
//     pages. Falls back to a deterministic scope heuristic on any failure.
//
// Both bias toward completeness: when the model is unsure or errors, keep.

import ollama, { Ollama } from 'ollama';

// Reuse one client per host so a custom Ollama host (chosen in the UI) is
// honoured without reconnecting on every call. No host → the package default
// (127.0.0.1:11434).
const _clients = new Map();
function clientFor(host) {
  if (!host) return ollama;
  let c = _clients.get(host);
  if (!c) {
    c = new Ollama({ host });
    _clients.set(host, c);
  }
  return c;
}

async function chat(model, system, user, host) {
  const res = await clientFor(host).chat({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    options: { temperature: 0 },
  });
  return res?.message?.content || '';
}

/** Pull the first JSON value out of a model reply. */
function parseJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const m = body.match(/[[{][\s\S]*[\]}]/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** Split markdown into heading-delimited sections (verbatim text preserved). */
function sectionize(markdown) {
  const lines = markdown.split('\n');
  const sections = [];
  let cur = { heading: '(intro)', lines: [] };
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && line.match(/^(#{1,3})\s+(.*)/);
    if (h) {
      if (cur.lines.length || sections.length === 0) sections.push(cur);
      cur = { heading: h[2].trim().slice(0, 100), lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  sections.push(cur);
  return sections.map((s, i) => ({ index: i, heading: s.heading, text: s.lines.join('\n').trim() }));
}

/**
 * Keep only task-relevant sections, verbatim.
 * @returns {Promise<{ markdown: string, relevant: boolean }>}
 */
export async function aiScopeContent({ model, task, title, markdown, host }) {
  if (!markdown || markdown.length < 1200) return { markdown, relevant: !!markdown };

  const sections = sectionize(markdown);
  if (sections.length <= 1) {
    // Single blob: ask only whether it is relevant at all.
    const ans = await chat(
      model,
      'You decide whether a web page is relevant to a user extraction task. Answer with JSON only.',
      `Task: "${task}"\nPage title: ${title || ''}\n\nContent (truncated):\n${markdown.slice(0, 2500)}\n\n` +
        'Reply with {"relevant": true|false}. Relevant means the page contains content the task asks for.',
      host,
    ).catch(() => '');
    const j = parseJson(ans);
    if (j && j.relevant === false) return { markdown: '', relevant: false };
    return { markdown, relevant: true };
  }

  const outline = sections
    .map((s) => `${s.index}: ${s.heading} — ${s.text.replace(/\s+/g, ' ').slice(0, 140)}`)
    .join('\n');

  const ans = await chat(
    model,
    'You select which sections of a page belong to a user extraction task. ' +
      'Keep every section that contains task-relevant content. Drop only clearly-irrelevant ' +
      'sections such as site navigation, footers, cookie/consent notices, marketing call-to-action, ' +
      'newsletter signups, "related/recommended" widgets, comments, or unrelated topics. ' +
      'When unsure, KEEP. Answer with JSON only.',
    `Task: "${task}"\nPage title: ${title || ''}\n\nSections (index: heading — preview):\n${outline}\n\n` +
      'Reply with {"keep": [list of section indexes to keep]}.',
    host,
  ).catch(() => '');

  const j = parseJson(ans);
  if (!j || !Array.isArray(j.keep)) return { markdown, relevant: true };

  const keep = new Set(j.keep.map(Number).filter((n) => Number.isInteger(n)));
  if (keep.size === 0) return { markdown, relevant: true }; // keep-bias on empty
  const kept = sections.filter((s) => keep.has(s.index)).map((s) => s.text).filter(Boolean);
  const out = kept.join('\n\n').trim();
  return { markdown: out || markdown, relevant: out.length > 0 };
}

/**
 * Choose which links to follow for the task.
 * @param {object} a
 * @param {Array<{href,label}>} a.links  in-scope candidates
 * @returns {Promise<string[]>} hrefs to enqueue
 */
export async function aiSelectLinks({ model, task, links, host }) {
  const capped = links.slice(0, 160);
  if (capped.length === 0) return [];

  const list = capped.map((l, i) => `${i}: ${l.label ? l.label.slice(0, 60) + ' — ' : ''}${l.href}`).join('\n');
  const ans = await chat(
    model,
    'You decide which links to follow while crawling to fulfil an extraction task. ' +
      'You are given raw destinations exactly as they appear on the page — the crawler makes NO ' +
      'assumptions about their shape, so YOU must recognise what is a real, separate page. A real ' +
      'page can be a normal URL, a single-page-app route carried in the URL fragment ' +
      '(e.g. #/contact, #!/features, #/products/42) or in the query string (e.g. ?view=pricing, ' +
      '?page=2), or any other site-specific routing/pagination scheme. Treat all of these as real ' +
      'pages. Do NOT follow: same-page anchors that merely jump within the CURRENT page ' +
      '(e.g. #overview, #section-3, #top — a fragment with no route-like path), links that clearly ' +
      'reload the current page, mailto/tel, or external sites. ' +
      'Among real pages, follow a link ONLY if its destination is the SAME KIND of content the task ' +
      'asks for. For a documentation task the right kind is reference / guide / tutorial / API / ' +
      'concept / configuration (incl. release notes / changelog); avoid blog/news, marketing/landing, ' +
      'pricing, about/team/careers, community/showcase, login/signup, legal. For any other task ' +
      '(a menu, prices, contact info, products, …) apply the same principle for that category. ' +
      'When unsure whether something is on-task, prefer to follow (completeness matters more than speed). ' +
      'Judge by the label and the whole destination string. Answer with JSON only.',
    `Task: "${task}"\n\nDestinations (index: label — href):\n${list}\n\n` +
      'Reply with {"follow": [indexes to follow]}. Include every real, on-task page; exclude same-page anchors and off-task links.',
    host,
  ).catch(() => '');

  const j = parseJson(ans);
  if (!j || !Array.isArray(j.follow)) return capped.map((l) => l.href); // follow all in-scope on failure
  const idx = new Set(j.follow.map(Number).filter((n) => Number.isInteger(n)));
  const chosen = capped.filter((_, i) => idx.has(i)).map((l) => l.href);
  return chosen.length ? chosen : capped.map((l) => l.href);
}

/**
 * Decide how the extracted content is grouped into output files. The model only
 * chooses the grouping; the text itself stays verbatim (assembled in
 * lib/layout.mjs). It picks ONE of three layouts:
 *   - SINGLE FILE  (the default) — everything in one .md.
 *   - PER PAGE     — one .md per crawled page/source ("by pages", "each page
 *     separately"). Returned as { perPage: true }; layout.mjs builds the files
 *     deterministically (lossless, named from each page), so the model never has
 *     to enumerate them.
 *   - CUSTOM GROUPS — split by category/topic ("drinks and pizzas separately").
 *     Returned as { files: [{ filename, items }] } over the given item indexes.
 *
 * @param {object} a
 * @param {string} a.model
 * @param {string} a.task
 * @param {Array<{index:number, source:string, heading:string, preview:string}>} a.items
 * @returns {Promise<{ perPage: true } | { files: Array<{ filename: string, items: number[] }> } | null>}
 */
export async function aiPlanLayout({ model, task, items, host }) {
  if (!items || items.length === 0) return null;

  const list = items
    .map(
      (it) =>
        `${it.index}: [${(it.source || '').slice(0, 80)}] ${(it.heading || '').slice(0, 80)}` +
        (it.preview ? ` — ${it.preview}` : ''),
    )
    .join('\n');

  const ans = await chat(
    model,
    'You organise already-extracted web content into output Markdown files for a user task. ' +
      'Choose EXACTLY ONE of three layouts:\n' +
      '1) SINGLE FILE — the DEFAULT. Put everything in one file. Use this unless the task clearly ' +
      'asks otherwise.\n' +
      '2) ONE FILE PER PAGE — when the task wants each crawled page kept separate, e.g. "by pages", ' +
      '"per page", "each page separately", "one file per page", "page by page", "split the pages", ' +
      '"a file for each page". In this case reply with {"perPage": true} and NOTHING else — the ' +
      'crawler will create one file per source page automatically (you must NOT enumerate them).\n' +
      '3) CUSTOM GROUPS — when the task asks to separate by CATEGORY/topic (e.g. "drinks and pizzas ' +
      'separately", "group by feature", "one file per product"), or to split ONE thing off "from ' +
      'the rest" (e.g. "separate the FAQ from the rest", "put the contact info in its own file"). ' +
      'Reply with {"files":[{"filename":"name.md","items":[indexes]}]}. You MUST cover ALL items: ' +
      'assign EVERY index to exactly ONE file (never list an index twice, never drop one). When the ' +
      'task pulls one thing out "from the rest", make a file for that thing AND a second file ' +
      'containing every remaining index (name it for what it holds, e.g. faq.md + other.md). Use ' +
      'short, lowercase, descriptive filenames ending in ".md" (e.g. menu.md, drinks.md, pizzas.md).\n' +
      'Answer with JSON only.',
    `Task: "${task}"\n\nItems (index: [source] heading — preview):\n${list}\n\n` +
      'Reply with ONE of: {"perPage": true}  |  {"files":[{"filename":"name.md","items":[indexes]}]}. ' +
      'For the default single-file case, return exactly one file whose items list every index.',
    host,
  ).catch(() => '');

  const j = parseJson(ans);
  if (!j) return null;
  if (j.perPage === true) return { perPage: true };
  if (Array.isArray(j.files)) return { files: j.files };
  return null;
}
