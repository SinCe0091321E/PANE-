'use strict';

/**
 * OALib 文献适配器（text 模式 / 阅读器）
 * ---------------------------------------------------------------------------
 * 目标：把论文/文献正文提取到自己的阅读面板里，支持标注、朗读与下载。
 * 正文容器优先用 selectors.content；找不到时由阅读器自动挑选正文区域。
 */
module.exports = {
  id: 'oalib',
  name: 'OALib 文献',
  description: '文本阅读：提取正文，支持高亮标注、朗读与下载。',
  mode: 'text',
  engine: 'reader',
  match: [
    '*://*.oalib.com/*'
  ],
  tools: [],
  hide: [],
  selectors: {
    content: '.contents, .article-body, .paper-body, article, .paper-content, #paper-content, .article-content, .fulltext, .content, #content, main',
    title: 'h1'
  },
  crop: false
};
