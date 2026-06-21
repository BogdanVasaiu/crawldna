// VitePress: https://vitepress.dev
export default {
  name: 'vitepress',
  match(root, html) {
    return (
      /vitepress/i.test(html) ||
      !!root.querySelector('.vp-doc') ||
      !!root.querySelector('.VPContent') ||
      !!root.querySelector('.VPDoc')
    );
  },
  contentSelector: ['.vp-doc', '.VPDoc .content-container', '.VPContent main', 'main'],
  navSelector: ['.VPSidebar', '.VPSidebarNav', 'aside.VPSidebar'],
};
