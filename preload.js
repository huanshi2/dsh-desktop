/**
 * DSH 页面 preload：在 DSH 界面右上角注入"帮助"悬浮按钮 + 下拉菜单（检查更新 / 关于）
 *
 * 仅对 http://127.0.0.1:* 的 DSH 页面生效（本地 loading.html 为 file://，不注入）。
 * 纯 DOM/CSS 实现，不依赖系统标题栏，位置 100% 可控。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktopBridge', {
  showAbout: () => ipcRenderer.invoke('dsh-desktop:about'),
  checkDshUpdate: () => ipcRenderer.invoke('dsh-desktop:check-dsh-update'),
  checkAppUpdate: () => ipcRenderer.invoke('dsh-desktop:check-app-update'),
  getVersion: () => ipcRenderer.invoke('dsh-desktop:version'),
});

function injectHelpUI() {
  if (document.getElementById('dsh-desktop-help')) return; // 防重复注入

  // 深色/浅色跟随系统
  const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const C = dark
    ? { bg: 'rgba(20,26,46,.92)', border: 'rgba(76,194,255,.4)', fg: '#e8ecf4', hover: 'rgba(76,194,255,.2)', menuBg: '#151c33', shadow: 'rgba(0,0,0,.55)' }
    : { bg: 'rgba(255,255,255,.95)', border: 'rgba(37,99,235,.35)', fg: '#1a2030', hover: 'rgba(37,99,235,.12)', menuBg: '#ffffff', shadow: 'rgba(0,0,0,.2)' };

  const host = document.createElement('div');
  host.id = 'dsh-desktop-help';
  host.style.cssText = [
    'position:fixed', 'top:12px', 'right:12px', 'z-index:2147483647',
    'font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif',
    'user-select:none', 'color:' + C.fg,
  ].join(';');

  // 按钮
  const btn = document.createElement('button');
  btn.textContent = '?';
  btn.title = '帮助（检查更新 / 关于）';
  btn.style.cssText = [
    'width:28px','height:28px','border-radius:50%',
    'border:1px solid ' + C.border,
    'background:' + C.bg,
    'color:' + C.fg,
    'font-size:14px','font-weight:600','cursor:pointer',
    'display:flex','align-items:center','justify-content:center',
    'transition:background .15s','backdrop-filter:blur(4px)',
  ].join(';');
  btn.addEventListener('mouseenter', () => { btn.style.background = C.hover; });
  btn.addEventListener('mouseleave', () => { btn.style.background = C.bg; });

  // 菜单
  const menu = document.createElement('div');
  menu.style.cssText = [
    'display:none','position:absolute','top:36px','right:0','min-width:150px',
    'padding:4px','background:' + C.menuBg,'border:1px solid ' + C.border,
    'border-radius:8px','box-shadow:0 8px 24px ' + C.shadow,
  ].join(';');

  const itemStyle = (i) => {
    i.style.cssText = [
      'padding:7px 14px','border-radius:5px','cursor:pointer',
      'color:' + C.fg,'font-size:12px','white-space:nowrap','transition:background .1s',
    ].join(';');
    i.addEventListener('mouseenter', () => { i.style.background = C.hover; });
    i.addEventListener('mouseleave', () => { i.style.background = 'transparent'; });
  };

  const item1 = document.createElement('div');
  item1.textContent = '检查更新';
  itemStyle(item1);
  item1.addEventListener('click', () => { menu.style.display = 'none'; window.dshDesktopBridge && window.dshDesktopBridge.checkDshUpdate(); });

  const item2 = document.createElement('div');
  item2.textContent = '关于 DSH Desktop';
  itemStyle(item2);
  item2.addEventListener('click', () => { menu.style.display = 'none'; window.dshDesktopBridge && window.dshDesktopBridge.showAbout(); });

  menu.appendChild(item1);
  menu.appendChild(item2);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', () => { menu.style.display = 'none'; });

  host.appendChild(btn);
  host.appendChild(menu);
  document.body.appendChild(host);
}

// 仅 DSH 服务页面注入
if (window.location.protocol === 'http:' && /^127\.0\.0\.1(:\d+)?$/.test(window.location.host)) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectHelpUI);
  } else {
    injectHelpUI();
  }
}
