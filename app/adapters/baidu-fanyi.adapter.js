'use strict';

/**
 * 百度翻译适配器（translator 模式）
 * ---------------------------------------------------------------------------
 * 目标：只留下「原文 / 译文」两个功能区，并提供选择语言、朗读与聚焦裁剪。
 * 站点改版时，只需要修改下面的 selectors / hide 即可；
 * 也可以在「设置 → 接入网址 → 元素拾取」里用鼠标直接绑定，无需改代码。
 */
module.exports = {
  id: 'baidu-fanyi',
  name: '百度翻译',
  description: '沉浸式翻译：只保留原文与译文面板，支持朗读与语言切换。',
  mode: 'translate',
  engine: 'baidu',
  match: [
    '*://fanyi.baidu.com/*',
    '*://fanyi-api.baidu.com/*'
  ],
  tools: ['speak-source', 'speak-target', 'crop', 'zoom'],

  // 站点外壳：广告、导航、页脚、下载提示……
  hide: [
    'header',
    'footer',
    'nav',
    '.header',
    '.header-wrap',
    '[class*="header"]',
    '[id*="header"]',
    '.top-bar',
    '.topbar',
    '.nav',
    '.navbar',
    '.footer',
    '.footer-wrap',
    '.side',
    '.sidebar',
    '.ad',
    '.ads',
    '.advert',
    '.banner',
    '[class*="banner"]',
    '.download-app',
    '.app-download',
    '[class*="download-app"]',
    '[class*="footer"]',
    '[id*="footer"]',
    '[class*="cookie"]'
  ],

  // 选择器按优先级排列，命中第一个即可；全部落空时会自动走启发式识别。
  selectors: {
    source: [
      'textarea#srcText',
      'textarea[class*="source"]',
      '.op-source-text textarea',
      '[class*="source"] textarea',
      'textarea'
    ],
    result: [
      '.op-target-text',
      '#dstText',
      '[class*="target"] [class*="text"]',
      '[class*="target"]',
      '[class*="result"]',
      '[class*="dst"]'
    ],
    languageBar: [
      '[class*="language"]',
      '[class*="lang"]'
    ]
  },

  // 聚焦裁剪：自动只保留原文/译文所在的容器，把它之外的兄弟节点全部隐藏。
  crop: true,

  // 裁剪时额外保留的区域（站点语言栏常和内容平级，且类名是随机的）
  keep: ['[class*="lang"]', '[class*="select"]'],

  css: `
    html, body { background: var(--fd-page-bg, transparent) !important; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-thumb { background: rgba(127,127,127,.35); border-radius: 99px; }
    ::-webkit-scrollbar-track { background: transparent; }

    textarea,
    [contenteditable="true"],
    .op-target-text,
    [class*="target-text"],
    [class*="result-text"] {
      font-size: max(16px, 1.05rem) !important;
      line-height: 1.75 !important;
      letter-spacing: .01em;
    }
    textarea { resize: none !important; }

    /* 页面里常驻的浮层会挡住阅读，统一压低层级 */
    [class*="float-tool"], [class*="download-guide"] { display: none !important; }
  `,

  window: { width: 520, height: 760 }
};
