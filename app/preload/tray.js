'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tray', {
  action: (action) => ipcRenderer.send('tray:action', action),
  close: () => ipcRenderer.send('tray:close')
});
