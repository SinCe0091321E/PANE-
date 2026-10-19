'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lightbox', {
  save: (payload) => ipcRenderer.invoke('image:save', payload),
  close: () => ipcRenderer.send('lightbox:close')
});
