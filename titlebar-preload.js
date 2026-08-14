/**
 * 标题栏 preload：把帮助菜单等操作安全暴露给 titlebar.html
 * 注意：titlebar.html 与 preload 同处隔离世界（contextIsolation），
 * 通过 contextBridge 暴露的 titlebarBridge 直接可用。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('titlebarBridge', {
  menuAction: (action) => ipcRenderer.send('tb:menu-action', action),
  getVersion: () => ipcRenderer.invoke('tb:version'),
});
