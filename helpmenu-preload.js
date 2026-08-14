/**
 * 帮助菜单窗口 preload：菜单项点击 → 通知主进程执行对应动作。
 * 菜单是独立子窗口（无边框、透明、不可聚焦），避免被 WebContentsView 遮挡。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('helpMenuBridge', {
  menuAction: (action) => ipcRenderer.send('hm:action', action),
});
