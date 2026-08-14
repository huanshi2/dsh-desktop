/**
 * 标题栏 preload：把帮助菜单等操作安全暴露给 titlebar.html
 * 注意：titlebar.html 与 preload 同处隔离世界（contextIsolation），
 * 通过 contextBridge 暴露的 titlebarBridge 直接可用。
 *
 * 帮助菜单说明：titlebar 自身 DOM 的下拉菜单会被 WebContentsView（DSH 页面）
 * 遮挡，因此按钮点击改为通知主进程，由主进程弹出独立的菜单子窗口（helpmenu.html）。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('titlebarBridge', {
  helpToggle: () => ipcRenderer.send('tb:help-toggle'),
  helpClose: () => ipcRenderer.send('tb:help-close'),
  getVersion: () => ipcRenderer.invoke('tb:version'),
});
