// Reshape context retrieval (#11 root cause): when sources exceed the budget, the
// sections RELEVANT to the instruction are selected — not the blind first N chars.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRelevant, sectionizeDoc } from '../src/lib/retrieve.mjs';

const FILLER = ('release notes text '.repeat(20) + '\n\n').repeat(60); // ~24k chars, no query terms

test('sectionizeDoc: H1–H3 split, fence-aware, intro captured', () => {
  const md = 'intro line\n\n# A\n\nbody\n\n```md\n# not a heading\n```\n\n## B\n\nmore';
  const secs = sectionizeDoc(md);
  assert.deepEqual(secs.map((s) => s.heading), ['(intro)', 'A', 'B']);
  assert.ok(secs[1].text.includes('# not a heading'), 'fence content stays in its section');
});

test('everything fits → mode full, untouched', () => {
  const docs = [{ filename: 'a.md', content: '# A\n\nshort' }];
  const r = selectRelevant(docs, 'anything at all', 60000);
  assert.equal(r.mode, 'full');
  assert.equal(r.truncated, false);
  assert.equal(r.docs[0].content, docs[0].content);
});

test('over budget + discriminating instruction → only the relevant section, verbatim', () => {
  const relevant =
    '# Alerts v-alert\n\nThe v-alert component props: `close-label` defaults to `\'$vuetify.close\'`.';
  const doc = { filename: 'docs.md', bytes: 999, content: `# Changelog\n\n${FILLER}\n\n${relevant}` };
  const r = selectRelevant([doc], 'dammi la documentazione del v-alert with its props', 5000);
  assert.equal(r.mode, 'retrieval');
  assert.equal(r.truncated, true);
  assert.equal(r.docs.length, 1);
  assert.ok(r.docs[0].partial, 'doc must be marked partial');
  assert.ok(r.docs[0].content.includes("'$vuetify.close'"), 'the deep on-topic section must be included');
  assert.ok(!r.docs[0].content.includes('release notes text'), 'off-topic filler must be omitted');
});

test('generic instruction (only stopwords) → head mode, docs untouched for legacy slicing', () => {
  const doc = { content: `# A\n\n${FILLER}\n\n# B\n\n${FILLER}` };
  const r = selectRelevant([doc], 'estrai tutto di tutte', 5000);
  assert.equal(r.mode, 'head');
  assert.equal(r.truncated, true);
  assert.equal(r.docs[0].content, doc.content);
});

test('a document named by FILENAME packs first, whole docs omitted are counted', () => {
  const menu = { filename: 'menu.md', content: '# Pizze\n\nmargherita 7,50\nmarinara 6,00' };
  const other = { filename: 'contatti.md', content: `# Recapiti\n\n${FILLER}` };
  const r = selectRelevant([other, menu], 'tidy menu.md into a table', 3000);
  assert.equal(r.mode, 'retrieval');
  const names = r.docs.map((d) => d.filename);
  assert.ok(names.includes('menu.md'), 'the referenced doc must be included');
  assert.ok(r.docs.find((d) => d.filename === 'menu.md').content.includes('margherita'));
  assert.equal(r.omittedDocs + r.docs.length, 2);
});

test('a document named by BYTE SIZE is recognised (the "2788831b" habit)', () => {
  const big = { filename: 'estrai-la-documentazione-di.md', bytes: 2788831, content: `# Guide\n\n${FILLER}` };
  const r = selectRelevant([big], 'redo the original 2788831b, order better the elements', 4000);
  assert.equal(r.mode, 'retrieval');
  assert.equal(r.docs.length, 1);
  assert.ok(r.docs[0].content.length <= 4200, 'stays within budget');
});

test('budget respected and document order restored across chosen sections', () => {
  const doc = {
    content: `# One menu\n\n${'alpha menu words '.repeat(50)}\n\n# Two\n\n${FILLER}\n\n# Three menu\n\n${'beta menu words '.repeat(50)}`,
  };
  const r = selectRelevant([doc], 'extract the menu', 3000);
  assert.equal(r.mode, 'retrieval');
  const c = r.docs[0].content;
  assert.ok(c.includes('alpha menu') && c.includes('beta menu'));
  assert.ok(c.indexOf('alpha menu') < c.indexOf('beta menu'), 'document order preserved');
  assert.ok(c.includes('[… sections not relevant'), 'omission is marked between gaps');
  assert.ok(c.length <= 3400, `content ${c.length} must respect the budget (+marker slack)`);
});
