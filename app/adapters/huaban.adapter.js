'use strict';

/**
 * 花瓣适配器（gallery 模式）
 * ---------------------------------------------------------------------------
 * 提供：关键词搜索、瀑布流浏览、左键全屏看图、右键保存图片。
 * 站点改版时修改 selectors.galleryItem / search.url 即可。
 */
module.exports = {
  id: 'huaban',
  name: '花瓣',
  description: '图片浏览：关键词搜索、全屏看图、右键下载。',
  mode: 'gallery',
  match: [
    '*://huaban.com/*',
    '*://*.huaban.com/*'
  ],
  tools: ['search', 'zoom', 'open-external'],

  search: {
    url: 'https://huaban.com/search?q={query}',
    placeholder: '搜索图片关键词',
    label: '搜索'
  },

  hide: [
    'header',
    'footer',
    '.header',
    '.top-bar',
    '.nav',
    '.footer',
    '.footer-wrap',
    '.ad',
    '.ads',
    '.banner',
    '[class*="download-app"]',
    '[class*="footer"]',
    '[class*="cookie"]'
  ],

  selectors: {
    galleryItem: [
      '[class*="pin"] img',
      '[class*="card"] img',
      'a img',
      'img'
    ]
  },

  crop: false,

  css: `
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-thumb { background: rgba(127,127,127,.35); border-radius: 99px; }
    ::-webkit-scrollbar-track { background: transparent; }

    /* 图片元素：统一圆角，鼠标反馈更明确 */
    img[data-fd-gallery] {
      border-radius: 10px;
      cursor: zoom-in !important;
      transition: transform .18s cubic-bezier(.22,1,.36,1), box-shadow .18s ease;
    }
    img[data-fd-gallery]:hover {
      transform: translateY(-1px);
      box-shadow: 0 10px 28px rgba(0,0,0,.16);
    }
  `,

  window: { width: 620, height: 780 }
};
