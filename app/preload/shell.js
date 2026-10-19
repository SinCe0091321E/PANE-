'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();

function on(channel, callback) {
  const handler = (event, ...args) => callback(...args);
  ipcRenderer.on(channel, handler);
  listeners.add(() => ipcRenderer.removeListener(channel, handler));
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('dock', {
  /* ---- 状态 ------------------------------------------------------------ */
  state: () => ipcRenderer.invoke('app:state'),
  preview: (patch) => ipcRenderer.invoke('config:preview', patch),
  apply: (patch) => ipcRenderer.invoke('config:apply', patch),
  cancel: () => ipcRenderer.invoke('config:cancel'),
  reset: () => ipcRenderer.invoke('config:reset'),
  onConfig: (cb) => on('config:changed', cb),

  /* ---- 窗口 ------------------------------------------------------------ */
  getBounds: () => ipcRenderer.invoke('window:bounds'),
  setBounds: (bounds) => ipcRenderer.send('window:set-bounds', bounds),
  pin: (value) => ipcRenderer.invoke('window:pin', value),
  onPinned: (cb) => on('state:pinned', cb),
  onFocus: (cb) => on('state:focus', cb),
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  newWindow: () => ipcRenderer.send('window:new'),
  show: () => ipcRenderer.send('window:show'),
  hide: () => ipcRenderer.send('window:hide'),

  /* ---- 设置 ------------------------------------------------------------ */
  openSettings: () => ipcRenderer.send('settings:open'),
  closeSettings: () => ipcRenderer.send('settings:close'),
  pick: (siteId) => ipcRenderer.send('settings:pick', { siteId }),
  pickDone: () => ipcRenderer.send('settings:pick-done'),
  sendPickResult: (payload) => ipcRenderer.send('picker:result', payload),
  cancelPick: () => ipcRenderer.send('picker:cancel'),
  onPickStart: (cb) => on('picker:start', cb),
  onPickResult: (cb) => on('picker:result', cb),
  onSettingsClosed: (cb) => on('settings:closed', cb),

  /* ---- 站点 ------------------------------------------------------------ */
  resolveAdapter: (url, adapterId, categoryId) => ipcRenderer.invoke('adapter:resolve', { url, adapterId, categoryId }),
  openExternal: (url) => ipcRenderer.send('open:external', url),

  /* ---- 图片 / 预览 ------------------------------------------------------ */
  lightbox: (payload) => ipcRenderer.send('lightbox:open', payload),
  closeLightbox: () => ipcRenderer.send('lightbox:close'),
  imageContext: (payload) => ipcRenderer.send('image:context', payload),
  onPreview: (cb) => on('preview:open', cb),
  saveImage: (payload) => ipcRenderer.invoke('image:save', payload),
  onDownloadDone: (cb) => on('download:done', cb),

  /* ---- 其它 ------------------------------------------------------------ */
  openDataDir: () => ipcRenderer.send('app:open-data'),
  openAdapters: () => ipcRenderer.send('app:open-adapters'),
  ttsSpeak: (payload) => ipcRenderer.send('tts:speak', payload),
  ttsStop: () => ipcRenderer.send('tts:stop'),
  onTtsDone: (cb) => on('state:tts-done', cb),
  translate: (payload) => ipcRenderer.invoke('translate:run', payload),
  ipa: (text) => ipcRenderer.invoke('phonetic:ipa', text),
  saveText: (payload) => ipcRenderer.invoke('reader:save', payload),
  pickLocal: (kind) => ipcRenderer.invoke('local:pick', kind),
  readTextFile: (filePath) => ipcRenderer.invoke('local:read-text', filePath),
  quit: () => ipcRenderer.send('app:quit'),
  relaunch: () => ipcRenderer.send('app:relaunch'),
  devtools: () => ipcRenderer.send('app:devtools')
});
