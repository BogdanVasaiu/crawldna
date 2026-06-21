// MkDocs / Material for MkDocs: https://www.mkdocs.org
export default {
  name: 'mkdocs',
  match(root, html) {
    return (
      /mkdocs/i.test(html) ||
      !!root.querySelector('.md-content article') ||
      !!root.querySelector('[data-md-component]') ||
      !!root.querySelector('.md-content')
    );
  },
  contentSelector: ['.md-content article', '.md-content__inner', '[role=main]', 'article'],
  navSelector: ['.md-nav--primary', '.md-nav', 'nav.md-nav'],
};
