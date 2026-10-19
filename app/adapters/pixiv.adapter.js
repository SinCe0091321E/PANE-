'use strict';

/**
 * Pixiv 适配器（gallery 模式）
 * ---------------------------------------------------------------------------
 * 左键图片在窗口内全屏预览；右键菜单里有「系统全屏 / 保存图片 / 复制地址」。
 * 站点改版时改 selectors.galleryItem / hide 即可，或用设置里的元素拾取。
 */
module.exports = {
  id: 'pixiv',
  name: 'Pixiv',
  description: '图片浏览：关键词搜索、窗口内全屏看图、系统全屏与右键下载。',
  mode: 'gallery',
  match: [
    '*://www.pixiv.net/*',
    '*://pixiv.net/*'
  ],
  tools: ['search', 'zoom', 'open-external'],

  search: {
    url: 'https://www.pixiv.net/search.php?word={query}',
    placeholder: '搜索 Pixiv 插画关键词',
    label: '搜索'
  },

  hide: [
    'header',
    'footer',
    '.site-header',
    '.site-footer',
    '.ads',
    '[class*="advert"]',
    '[class*="footer"]',
    '[class*="cookie"]'
  ],

  selectors: {
    galleryItem: [
      'figure img',
      'a[href*="/artworks/"] img',
      '[class*="thumbnail"] img',
      'img'
    ]
  },

  crop: false,

  css: `
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-thumb { background: rgba(127,127,127,.35); border-radius: 99px; }
    ::-webkit-scrollbar-track { background: transparent; }

    img[data-fd-gallery] {
      cursor: zoom-in !important;
      border-radius: 8px;
      transition: transform .18s cubic-bezier(.22,1,.36,1), box-shadow .18s ease;
    }
    img[data-fd-gallery]:hover {
      transform: translateY(-1px);
      box-shadow: 0 10px 28px rgba(0,0,0,.16);
    }
  `,

  window: { width: 620, height: 780 }
};
