// Phase 2 — "reshape" (chat with your extraction).
//
// The crawl (Phase 1) produces a faithful, VERBATIM extraction per link. This
// step reworks those SAVED files into whatever the user asks — a table, a split,
// a filtered subset, a regroup — on demand, as many times as they want, reusing
// the same extraction as context (like querying a knowledge base). The crawl's
// own files are never touched; every reshape output lands under <scan>/chat/ and
// the conversation is recorded in that scan's session. Value-faithful by design:
// aiReshape copies every kept value exactly and never invents one.

import {
  getRun,
  readRunFile,
  readChatFile,
  getChatSession,
  saveChatSession,
  writeChatFile,
} from './lib/runs.mjs';
import { aiReshape } from './engine/decide.mjs';
import { resolveLlm } from './lib/llm.mjs';
import { slug } from './lib/url.mjs';
import { verifyValues, fidelityBanner, stripFidelityBanner } from './lib/faithful.mjs';
import { simhash, hamming } from './lib/simhash.mjs';

// How many of the user's own prior chat outputs to surface back as context, so a
// follow-up like "redo the table you made" can reference them without flooding
// the prompt as the conversation grows.
const PRODUCED_CONTEXT = 6;

function stripFrontMatter(md) {
  const m = String(md || '').match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? String(md).slice(m[0].length) : String(md || '');
}

function ensureTrailingNewline(s) {
  const t = String(s || '');
  return t.endsWith('\n') ? t : t + '\n';
}

/** Sanitise a model-proposed filename to a safe, unique `*.md` name. */
function sanitizeChatName(raw, used) {
  const base = slug(String(raw || '').replace(/\.md$/i, '')) || 'reshaped';
  let name = `${base}.md`;
  let n = 2;
  while (used.has(name) || name === 'session.json') name = `${base}-${n++}.md`;
  used.add(name);
  return name;
}

/** Find a scan in a run manifest by id (''/undefined = the only/first scan). */
function findScan(manifest, scanId) {
  const scans = manifest.scans || [];
  const sid = String(scanId || '');
  return scans.find((s) => String(s.scanId || '') === sid) || (sid ? null : scans[0]) || null;
}

/**
 * Run one reshape turn over a saved scan's extraction.
 *
 * @param {object} a
 * @param {string} a.runId
 * @param {string} [a.scanId]   '' = the run's only/first scan
 * @param {string} a.message    the user's request
 * @param {string} a.model      model id/name
 * @param {string} [a.provider] 'ollama' (default) | 'openai'
 * @param {string} [a.host]     Ollama host override (provider 'ollama')
 * @param {string} [a.baseUrl]  OpenAI-compatible API base URL (provider 'openai')
 * @param {string} [a.apiKey]   API key (provider 'openai')
 * @param {string} [a.cacheDir] runs-cache override
 * @param {boolean} [a.verify]  #11 fidelity check (default true): value-like atoms of
 *                              every produced file are verified against the FULL crawled
 *                              sources; unverifiable ones are flagged with a warning
 *                              banner inside the file instead of served silently.
 * @returns {Promise<{ reply: string, files: Array<{ filename, bytes, at, fidelity? }>, truncated: boolean, contextMode?: string }>}
 */
export async function reshape({ runId, scanId = '', message, model, provider, host, baseUrl, apiKey, cacheDir, verify = true }) {
  if (!String(message || '').trim()) throw new Error('empty message');
  if (!model) throw new Error('no model selected');
  const llm = resolveLlm({ provider, model, ollamaHost: host, baseUrl, apiKey });
  const opts = cacheDir ? { cacheDir } : {};

  const { manifest } = await getRun(runId, opts);
  const scan = findScan(manifest, scanId);
  if (!scan) throw new Error('scan not found');
  const sid = String(scan.scanId || '');

  // The scan's ORIGINAL crawled files, each as an IDENTIFIABLE document (filename
  // + on-disk size + source URLs). Passing identity — not an anonymous blob — is
  // what lets the model honour references like "the original md" / "the 4574b
  // file" and treat these as the default thing to reshape.
  const documents = [];
  for (const f of scan.files || []) {
    try {
      const raw = await readRunFile(runId, sid, f.filename, opts);
      documents.push({
        filename: f.filename,
        title: f.title || '',
        bytes: typeof f.bytes === 'number' ? f.bytes : Buffer.byteLength(raw, 'utf8'),
        sources: Array.isArray(f.pages) && f.pages.length ? f.pages : scan.url ? [scan.url] : [],
        content: stripFrontMatter(raw),
      });
    } catch {
      /* skip an unreadable file rather than fail the whole turn */
    }
  }
  if (!documents.some((d) => d.content.trim())) throw new Error('no extracted content for this link');

  const session = await getChatSession(runId, sid, opts);

  // The user's own prior outputs from THIS chat, as clearly-separate context so a
  // follow-up can revise one ("redo the table you made") — never confused with
  // the originals.
  const produced = [];
  for (const f of (session.files || []).slice(-PRODUCED_CONTEXT)) {
    try {
      // Strip our own fidelity banner: it is a warning for the USER, not content the
      // model should iterate on (or copy into new files).
      produced.push({
        filename: f.filename,
        bytes: f.bytes,
        content: stripFidelityBanner(stripFrontMatter(await readChatFile(runId, sid, f.filename, opts))),
      });
    } catch {
      /* a derived file may have been removed — skip it */
    }
  }

  const { reply, files, truncated, contextMode } = await aiReshape({
    llm,
    documents,
    produced,
    instruction: message,
    history: (session.messages || []).map((m) => ({ role: m.role, content: m.content })),
  });

  // Deterministic guards on what the model produced, BEFORE anything is saved.
  //
  // (1) RE-EMISSION FILTER: models re-deliver earlier files under new names as the
  // conversation grows (observed live: three near-identical "pagination" docs in one
  // chat). A produced file whose SimHash is within Hamming 3 of a file already in this
  // chat (or of another file from this same turn) is skipped, with a note — never
  // silently.
  //
  // (2) FIDELITY CHECK (#11): every value-like atom (numbers, URLs, inline code, quoted
  // literals, code lines) of a kept file is verified against the FULL crawled sources —
  // not the model's context — plus the user's own instruction. Unverifiable values are
  // flagged with a clearly tool-generated banner INSIDE the file, and reported in the
  // result, instead of being served as if they were extracted facts.
  const sourceTexts = documents.map((d) => d.content);
  const priorHashes = produced.map((p) => simhash(p.content));
  const used = new Set((session.files || []).map((f) => f.filename));
  const savedFiles = [];
  const notes = [];
  for (const file of files) {
    const raw = String(file.content);
    const sh = simhash(raw);
    if (priorHashes.some((h) => hamming(sh, h) <= 3)) {
      notes.push(`(Skipped "${file.filename}" — near-identical to a file already produced in this chat.)`);
      continue;
    }
    priorHashes.push(sh);

    let fidelity = null;
    let content = raw;
    if (verify) {
      const v = verifyValues(raw, sourceTexts, { allow: message });
      fidelity = { checked: v.total, verified: v.verified, unverified: v.unverified.slice(0, 20) };
      if (v.unverified.length) content = fidelityBanner(v) + '\n\n' + raw;
    }

    const name = sanitizeChatName(file.filename, used);
    const body = ensureTrailingNewline(content);
    await writeChatFile(runId, sid, name, body, opts);
    savedFiles.push({
      filename: name,
      bytes: Buffer.byteLength(body, 'utf8'),
      at: new Date().toISOString(),
      ...(fidelity ? { fidelity } : {}),
    });
  }
  const replyOut = [reply, ...notes].filter(Boolean).join('\n\n');

  // Record the turn (user + assistant) and register the new files.
  const now = new Date().toISOString();
  session.messages = session.messages || [];
  session.messages.push({ role: 'user', content: String(message), at: now });
  session.messages.push({
    role: 'assistant',
    content: replyOut,
    files: savedFiles.map((f) => f.filename),
    at: now,
  });
  session.files = [...(session.files || []), ...savedFiles];
  await saveChatSession(runId, sid, session, opts);

  return { reply: replyOut, files: savedFiles, truncated, contextMode };
}

export default reshape;
