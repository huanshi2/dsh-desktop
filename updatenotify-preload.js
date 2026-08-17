/**
 * 更新提示角标窗口 preload：按钮点击 → 通知主进程执行更新/忽略。
 * 与帮助菜单窗口一样，是独立子窗口（无边框、透明、不抢焦点），不打断正常使用。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updateNotifyBridge', {
  action: (a) => ipcRenderer.send('un:action', a),
});