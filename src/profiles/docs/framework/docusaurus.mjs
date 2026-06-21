// Docusaurus: https://docusaurus.io
export default {
  name: 'docusaurus',
  match(root, html) {
    return (
      /docusaurus/i.test(html) ||
      !!root.querySelector('.theme-doc-markdown') ||
      !!root.querySelector('[class*=docMainContainer]') ||
      !!root.querySelector('.menu__list')
    );
  },
  contentSelector: ['.theme-doc-markdown', 'article .markdown', 'main article', 'main'],
  navSelector: ['.theme-doc-sidebar-menu', 'nav.menu .menu__list', '.menu__list'],
};
