'use strict';

/**
 * YouTube 视频适配器（video 模式）
 * ---------------------------------------------------------------------------
 * 保留站点本身，用桌面壳自己的控制条驱动页面里的 <video>：
 * 播放/暂停、进度、音量、倍速，以及只在本次会话里存在的视频标记。
 */
module.exports = {
  id: 'youtube',
  name: 'YouTube 视频',
  description: '视频参考：自有控制条，支持进度、音量、倍速与临时标记。',
  mode: 'video',
  engine: 'video',
  match: [
    '*://*.youtube.com/watch*',
    '*://youtube.com/watch*',
    '*://youtu.be/*'
  ],
  tools: [],
  hide: [],
  selectors: {},
  crop: false
};
