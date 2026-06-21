// Fallback when no known docs generator is detected: readability-style main
// content plus a best-effort nav selector. The extractor's own heuristics do
// most of the work when contentSelector misses.
export default {
  name: 'generic',
  match() {
    return true;
  },
  contentSelector: [
    'main article', 'article', 'main', '[role=main]',
    '.markdown', '.markdown-body', '.content', '.doc-content', '#content',
  ],
  navSelector: ['nav', '[role=navigation]', '.sidebar', '.toc', 'aside'],
};
