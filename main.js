/**
 * DSH Desktop —— DeepSeek Harness 的本地 Electron 封装
 *
 * 功能：
 *   1. 启动 App 时自动在后台拉起 `dsh web`（真实 DSH 服务，默认端口 3080）
 *   2. 服务就绪后，窗口加载 DSH 浏览器界面（原生标题栏：右上角最小化/最大化/关闭）
 *   3. 点关闭 = 结束 DSH 进程（连同其子进程树）并退出 App，不留后台残留
 *   4. 端口被占用时提示：可直接打开已有实例
 *   5. 启动后后台静默检查 DSH 内核更新；渲染进程崩溃自动重载
 *
 * 可覆盖项（config.json 或环境变量，环境变量优先）：
 *   DSH_DESKTOP_PORT     服务端口（默认 3080）
 *   DSH_DESKTOP_COMMAND  自定义启动命令（整条 shell 命令字符串）
 *   DSH_DESKTOP_USER_DATA  用户数据目录（测试用）
 *   DSH_DESKTOP_LOG      日志文件路径（默认 <userData>/dsh.log）
 */
'use strict';

const { app, BrowserWindow, WebContentsView, dialog, shell, Menu, ipcMain, nativeTheme } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');

const DEFAULT_PORT = 3080;
const APP_TITLE = 'DSH Desktop';
const TITLEBAR_HEIGHT = 36; // 自绘标题栏高度（px），与 titleBarOverlay 一致
const BOOT_TIMEOUT_MS = 5 * 60 * 1000; // 首次启动可能需安装插件，给 5 分钟

// App 自身版本（打包后从 asar 内 package.json 读取）
const APP_VERSION = (() => {
  try { return require('./package.json').version; } catch { return '0.0.0'; }
})();

let mainWindow = null; // 主窗口（titleBarOverlay 标题栏 + WebContentsView）
let dshView = null;    // DSH 页面视图
let dshProcess = null;
let ownedServer = false; // 是否由本 App 拉起的 DSH（决定关闭时要不要杀掉）
let quitting = false;
let helpMenuWin = null; // "?"帮助按钮的下拉菜单（独立子窗口，避免被 WebContentsView 遮挡）
const HELP_MENU_W = 190; // 菜单窗口宽（px，DIP）
const HELP_MENU_H = 78;  // 菜单窗口高（px，DIP）

// ---------------- 配置 ----------------
// 测试/自定义用户数据目录（必须在 app ready 之前设置）
if (process.env.DSH_DESKTOP_USER_DATA) {
  app.setPath('userData', process.env.DSH_DESKTOP_USER_DATA);
}
app.setAppUserModelId('com.local.dsh-desktop');

function loadConfig() {
  const base = { port: DEFAULT_PORT, dshCommand: null, dshArgs: [], bootTimeoutSec: 300, updateRepo: null };
  // 优先级：<userData>/config.json（打包后用户可改） > 应用目录 config.json（开发用）
  const candidates = [
    path.join(app.getPath('userData'), 'config.json'),
    path.join(__dirname, 'config.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return { ...base, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
    } catch (e) {
      console.error(`[dsh-desktop] config 读取失败 ${p}:`, e.message);
    }
  }
  return base;
}

const config = loadConfig();
const PORT = Number(process.env.DSH_DESKTOP_PORT || config.port) || DEFAULT_PORT;

const LOG_PATH = process.env.DSH_DESKTOP_LOG || path.join(app.getPath('userData'), 'dsh.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch { /* 忽略日志写入失败 */ }
  console.log(line.trimEnd());
}

// ---------------- dsh 可执行文件解析 ----------------
// 优先级：config.dshCommand 显式指定 > PATH 上的 dsh > npx 缓存里的 @deepseek-ai/dsh > npx 在线安装
function scanNpxCacheDsh() {
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm-cache', '_npx') : null,
  ].filter(Boolean);
  let best = null;
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      const pkgDir = path.join(root, entry, 'node_modules', '@deepseek-ai', 'dsh');
      const bin = path.join(pkgDir, 'lib', 'bin.js');
      if (fs.existsSync(bin)) {
        const mtime = fs.statSync(bin).mtimeMs;
        let version = null;
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
          version = pkg.version;
        } catch { /* 忽略 */ }
        if (!best || mtime > best.mtime) best = { bin, mtime, version };
      }
    }
  }
  return best ? best.bin : null;
}

/** 当前使用的 DSH 内核版本（解析自 npx 缓存；PATH/npx 兜底时可能未知） */
function getLocalDshVersion() {
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm-cache', '_npx') : null,
  ].filter(Boolean);
  let best = null;
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      const pkgPath = path.join(root, entry, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          const mtime = fs.statSync(pkgPath).mtimeMs;
          if (!best || mtime > best.mtime) best = { version: pkg.version || '未知', mtime };
        } catch { /* 忽略 */ }
      }
    }
  }
  return best ? best.version : null;
}

/** 简化 semver 比较：a>b 返回 1，a<b 返回 -1，相等返回 0（含 rc 预发布处理） */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v || '').trim());
    return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] } : null;
  };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  if (pa.pre && !pb.pre) return -1; // 预发布 < 正式版
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) {
    const sa = pa.pre.split('.'), sb = pb.pre.split('.');
    const len = Math.max(sa.length, sb.length);
    for (let i = 0; i < len; i++) {
      const x = sa[i], y = sb[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      if (x === y) continue;
      const nx = Number(x), ny = Number(y);
      if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx > ny ? 1 : -1;
      return x > y ? 1 : -1;
    }
    return 0;
  }
  return 0;
}

function whereOnPath(exe) {
  try {
    const r = spawnSync('where.exe', [exe], { stdio: 'ignore', windowsHide: true });
    return r.status === 0;
  } catch { return false; }
}

function buildDshSpawn() {
  // 1. 显式覆盖（整条命令）
  const override = process.env.DSH_DESKTOP_COMMAND || config.dshCommand;
  if (override) {
    return { command: override, args: [], shell: true, kind: 'override' };
  }
  // 2. PATH 上的 dsh
  if (whereOnPath('dsh')) {
    return { command: 'dsh', args: ['web', '--port', String(PORT)], shell: false, kind: 'dsh' };
  }
  // 3. npx 缓存（本机已有 @deepseek-ai/dsh 0.1.0-rc.6）
  const cachedBin = scanNpxCacheDsh();
  if (cachedBin) {
    return { command: 'node', args: [], shell: false, kind: 'cached', bin: cachedBin };
  }
  // 4. npx 在线兜底
  return { command: 'npx.cmd', args: ['--yes', '@deepseek-ai/dsh', 'web', '--port', String(PORT)], shell: true, kind: 'npx' };
}

// ---------------- 端口/服务检测 ----------------
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.setTimeout(1500);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
}

function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => {
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tick, 800);
      });
    };
    tick();
  });
}

// ---------------- 启动 / 停止 dsh ----------------
async function startDsh() {
  const plan = buildDshSpawn();
  log(`启动 DSH: kind=${plan.kind} command=${plan.command} args=${JSON.stringify(plan.args)} port=${PORT}`);

  let command = plan.command;
  let args = plan.args;
  if (plan.kind === 'cached') {
    command = process.env.DSH_DESKTOP_NODE || 'node'; // 用 node 运行缓存的 dsh bin.js
    args = [plan.bin, 'web', '--port', String(PORT)];
  }

  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const outFd = fs.openSync(LOG_PATH, 'a');
  const errFd = fs.openSync(LOG_PATH, 'a');

  dshProcess = spawn(command, args, {
    shell: !!plan.shell,
    windowsHide: true,
    env: { ...process.env },
    stdio: ['ignore', outFd, errFd],
  });
  ownedServer = true;

  dshProcess.on('error', (err) => {
    log(`dsh 进程启动失败: ${err.message}`);
    if (!quitting && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: APP_TITLE,
        message: '无法启动 DSH',
        detail: `启动命令: ${command}\n错误: ${err.message}\n\n日志: ${LOG_PATH}`,
        buttons: ['退出'],
      }).then(() => app.quit());
    }
  });

  dshProcess.on('exit', (code, signal) => {
    log(`dsh 进程退出 code=${code} signal=${signal} (owned=${ownedServer})`);
    if (!quitting && ownedServer && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: APP_TITLE,
        message: 'DSH 服务已退出',
        detail: `进程退出码: ${code}\n\n日志: ${LOG_PATH}`,
        buttons: ['重新启动', '退出'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) {
          log('用户选择重新启动');
          showLoading('正在重新启动 DSH…');
          startDsh();
        } else {
          app.quit();
        }
      });
    }
  });

  log('等待 DSH 服务就绪…');
  const ready = await waitForServer(PORT, BOOT_TIMEOUT_MS);
  if (ready) {
    log(`DSH 服务就绪: http://127.0.0.1:${PORT}`);
  } else {
    log('等待超时');
    if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: APP_TITLE,
        message: 'DSH 启动超时',
        detail: `首次启动需要安装插件，请稍等重试。\n端口: ${PORT}\n日志: ${LOG_PATH}`,
        buttons: ['退出'],
      }).then(() => app.quit());
    }
  }
  return ready;
}

// Windows 上连带子进程树一起结束
function killTree(pid) {
  try {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch (e) {
    log(`taskkill 失败: ${e.message}`);
  }
}

function stopDsh() {
  if (dshProcess && !dshProcess.killed) {
    log(`停止 DSH (pid=${dshProcess.pid})`);
    killTree(dshProcess.pid);
    try { dshProcess.kill(); } catch { /* 可能已退出 */ }
    dshProcess = null;
  }
}

// ---------------- 版本说明 / 更新 ----------------
function aboutDetail() {
  const dshVer = getLocalDshVersion();
  const lines = [
    `DSH 桌面版 v${APP_VERSION}`,
    `DSH 内核: ${dshVer || '未知（PATH/npx 方式启动）'}`,
    `服务地址: http://127.0.0.1:${PORT}`,
    `配置目录: ${app.getPath('userData')}`,
    `日志文件: ${LOG_PATH}`,
    '',
    'DSH 桌面版是 DeepSeek Harness (DSH) 的本地封装：',
    '双击启动 → 自动拉起 dsh web → 关闭窗口即停止服务。',
  ];
  return lines.join('\n');
}

function showAbout() {
  log(`showAbout 被调用 (mainWindow=${!!mainWindow})`);
  dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    title: `关于 ${APP_TITLE}`,
    message: `关于 ${APP_TITLE}`,
    detail: aboutDetail(),
    buttons: ['确定'],
  });
}

async function checkDshUpdate(manual = true) {
  const localVer = getLocalDshVersion();
  if (!localVer) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'info', title: '检查 DSH 更新',
      message: '无法确定本地 DSH 版本',
      detail: '当前 DSH 不是从 npm 缓存启动的，跳过在线检查。',
      buttons: ['确定'],
    });
    return;
  }
  try {
    const res = await fetch('https://registry.npmjs.org/@deepseek-ai/dsh/latest');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const latest = data.version;
    const cmp = compareVersions(latest, localVer);
    if (cmp > 0) {
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'info', title: '发现 DSH 新版本',
        message: `DSH 有新版本可用`,
        detail: `当前: ${localVer}\n最新: ${latest}\n\n升级方法（在终端执行）：\n  npm i -g @deepseek-ai/dsh\n\n下次启动桌面版会自动使用新版本。`,
        buttons: ['确定'],
      });
    } else if (cmp === 0) {
      if (manual) {
        dialog.showMessageBox(mainWindow || undefined, {
          type: 'info', title: '检查 DSH 更新',
          message: `已是最新版本 (${localVer})`, buttons: ['确定'],
        });
      }
    } else {
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'info', title: '检查 DSH 更新',
        message: `本地版本高于 npm 最新版`,
        detail: `当前: ${localVer}\nnpm 最新: ${latest}`, buttons: ['确定'],
      });
    }
  } catch (e) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'error', title: '检查 DSH 更新失败',
      message: '无法连接 npm registry',
      detail: String(e.message), buttons: ['确定'],
    });
  }
}

async function checkAppUpdate(manual = true) {
  const repo = process.env.DSH_DESKTOP_UPDATE_REPO || config.updateRepo;
  if (!repo) {
    if (manual) {
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'info', title: '检查桌面版更新',
        message: `当前 v${APP_VERSION}`,
        detail: '本构建未配置更新源（config.json 的 updateRepo 为空）。\n'
              + '如发布到 GitHub Releases，可设置 updateRepo: "用户名/仓库名" 开启检查。',
        buttons: ['确定'],
      });
    }
    return;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'dsh-desktop' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    const cmp = compareVersions(latest, APP_VERSION);
    if (cmp > 0) {
      const { response } = await dialog.showMessageBox(mainWindow || undefined, {
        type: 'info', title: '发现桌面版新版本',
        message: `DSH 桌面版 v${latest} 已发布`,
        detail: `当前: v${APP_VERSION}\n最新: v${latest}\n\n点击「打开下载页」跳转到 GitHub Releases。`,
        buttons: ['打开下载页', '关闭'],
        defaultId: 0, cancelId: 1,
      });
      if (response === 0 && rel.html_url) shell.openExternal(rel.html_url);
    } else if (manual) {
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'info', title: '检查桌面版更新',
        message: `已是最新版本 (v${APP_VERSION})`, buttons: ['确定'],
      });
    }
  } catch (e) {
    if (manual) {
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'error', title: '检查桌面版更新失败',
        message: '无法连接 GitHub API',
        detail: String(e.message), buttons: ['确定'],
      });
    }
  }
}

// 无菜单栏："帮助/更新/关于"入口改为 DSH 界面右上角悬浮按钮（见 preload.js）
Menu.setApplicationMenu(null);

// 标题栏"?"按钮 → 主进程（见 titlebar-preload.js 的 titlebarBridge）
// 菜单是独立子窗口（helpmenu.html）：titlebar 的 DOM 菜单会被其下的 WebContentsView 遮挡，
// 因此菜单由主进程用真实顶层窗口弹出，永远可见、可点击。
let helpReposTimer = null;

function getHelpBtnRect() {
  return mainWindow.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('btn-help');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  })()`).catch(() => null);
}

function helpMenuPos() {
  // 菜单左缘 = 按钮左缘，顶部 = 按钮下缘 + 4px（DIP 坐标，与 DOM rect 同一坐标系）
  return getHelpBtnRect().then((r) => {
    if (!r) return null;
    const cb = mainWindow.getContentBounds();
    return { x: Math.round(cb.x + r.left), y: Math.round(cb.y + r.bottom + 4) };
  });
}

function closeHelpMenu() {
  if (helpMenuWin && !helpMenuWin.isDestroyed()) {
    helpMenuWin.close();
  }
}

function repositionHelpMenu() {
  if (!helpMenuWin || helpMenuWin.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) return;
  helpMenuPos().then((p) => {
    if (p && helpMenuWin && !helpMenuWin.isDestroyed()) {
      const [cx, cy] = helpMenuWin.getPosition();
      if (cx !== p.x || cy !== p.y) helpMenuWin.setPosition(p.x, p.y);
    }
  });
}

function scheduleRepositionHelpMenu() {
  if (helpReposTimer) clearTimeout(helpReposTimer);
  helpReposTimer = setTimeout(repositionHelpMenu, 50);
}

function openHelpMenu() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (helpMenuWin && !helpMenuWin.isDestroyed()) { closeHelpMenu(); return; }
  helpMenuPos().then((p) => {
    if (!p) return;
    helpMenuWin = new BrowserWindow({
      x: p.x,
      y: p.y,
      width: HELP_MENU_W,
      height: HELP_MENU_H,
      useContentSize: true,
      parent: mainWindow,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      focusable: false, // 不抢主窗口焦点：菜单保持原生交互、无焦点闪烁
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'helpmenu-preload.js'),
      },
    });
    helpMenuWin.setMenu(null);
    helpMenuWin.loadFile(path.join(__dirname, 'helpmenu.html'));
    helpMenuWin.once('ready-to-show', () => {
      if (helpMenuWin && !helpMenuWin.isDestroyed()) helpMenuWin.show();
    });
    helpMenuWin.on('closed', () => { helpMenuWin = null; });
  });
}

function registerHelpIpc() {
  ipcMain.on('tb:help-toggle', () => {
    if (helpMenuWin && !helpMenuWin.isDestroyed()) closeHelpMenu();
    else openHelpMenu();
  });
  ipcMain.on('tb:help-close', () => closeHelpMenu());
  ipcMain.on('hm:action', (e, action) => {
    log(`帮助菜单动作: ${action}`);
    closeHelpMenu();
    if (action === 'check-dsh-update') checkDshUpdate(true);      // DSH 内核更新（npm）
    else if (action === 'check-app-update') checkAppUpdate(true); // 桌面版更新（GitHub Releases）
    else if (action === 'about') showAbout();
  });
  ipcMain.handle('tb:version', () => APP_VERSION);
  // 兼容（不再使用）
  ipcMain.handle('dsh-desktop:about', () => { showAbout(); return true; });
  ipcMain.handle('dsh-desktop:check-dsh-update', () => { checkDshUpdate(true); return true; });
  ipcMain.handle('dsh-desktop:check-app-update', () => { checkAppUpdate(true); return true; });
}

// ---------------- 窗口（titleBarOverlay：系统按钮 + 自绘标题栏 + WebContentsView） ----------------
function overlayThemeColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#0f1220', symbolColor: '#c7d0e2' }
    : { color: '#eef1f7', symbolColor: '#3a4256' };
}

function applyOverlayTheme() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitleBarOverlay({ ...overlayThemeColors(), height: TITLEBAR_HEIGHT });
}

function layout() {
  if (!mainWindow || !dshView || mainWindow.isDestroyed()) return;
  const [w, h] = mainWindow.getContentSize();
  dshView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width: w, height: Math.max(0, h - TITLEBAR_HEIGHT) });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: `${APP_TITLE} v${APP_VERSION}`,
    // 无系统标题栏：自绘标题栏（标题 + "?"帮助按钮），但保留系统原生最小化/最大化/关闭按钮
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...overlayThemeColors(), height: TITLEBAR_HEIGHT },
    backgroundColor: '#0f1220',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'titlebar-preload.js'),
    },
  });

  // 标题栏页面（左侧标题/版本 + 右侧"?"按钮；系统按钮在最右）
  mainWindow.loadFile(path.join(__dirname, 'titlebar.html'));

  // DSH 页面视图（标题栏下方）
  dshView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.contentView.addChildView(dshView);
  layout();
  mainWindow.on('resize', layout);
  // 窗口移动/缩放时菜单跟随按钮位置；最小化时关闭
  mainWindow.on('move', scheduleRepositionHelpMenu);
  mainWindow.on('resize', scheduleRepositionHelpMenu);
  mainWindow.on('minimize', closeHelpMenu);
  // 点击 DSH 页面任意处 / 按 Esc → 关闭菜单
  dshView.webContents.on('input-event', (event, input) => {
    if (input.type === 'mouseDown' || (input.type === 'keyDown' && input.key === 'Escape')) {
      closeHelpMenu();
    }
  });

  // 外部链接交给系统浏览器，不在 App 内开新窗口
  dshView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 渲染进程崩溃时自动重载（服务通常仍在，重载即可恢复界面）
  dshView.webContents.on('render-process-gone', (event, details) => {
    log(`渲染进程异常 (${details.reason})，尝试重载界面`);
    if (!quitting) {
      setTimeout(() => {
        if (dshView && !dshView.webContents.isDestroyed()) {
          dshView.webContents.loadURL(`http://127.0.0.1:${PORT}`);
        }
      }, 1500);
    }
  });

  // 系统深浅色主题切换 → 同步标题栏 overlay 颜色（标题栏文字由 CSS 自动跟随）
  nativeTheme.on('updated', applyOverlayTheme);

  mainWindow.on('close', () => {
    log('窗口关闭 → 退出 App 并停止 DSH');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    dshView = null;
  });

  return mainWindow;
}

function showLoading(text) {
  if (dshView && !dshView.webContents.isDestroyed()) {
    dshView.webContents.loadFile(path.join(__dirname, 'loading.html'), { query: { text: encodeURIComponent(text) } });
  }
}

function loadDshPage() {
  if (dshView && !dshView.webContents.isDestroyed()) {
    dshView.webContents.loadURL(`http://127.0.0.1:${PORT}`);
  }
}

async function boot(options = {}) {
  // 端口已被占用：可能是已有 DSH 实例（或上次没关干净）
  // skipPortCheck=true（如"重启服务"）时跳过检查，直接拉起自己的实例
  if (!options.skipPortCheck && await portInUse(PORT)) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: APP_TITLE,
      message: `端口 ${PORT} 已被占用`,
      detail: '可能已有 DSH 实例在运行。\n\n「直接打开」：加载现有实例（关闭窗口时不会结束它）。\n「退出」：先手动关掉占用端口的进程再重试。',
      buttons: ['直接打开', '退出'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      app.quit();
      return;
    }
    ownedServer = false;
    log(`端口 ${PORT} 已有服务，直接打开现有实例`);
    if (await waitForServer(PORT, 15000)) {
      loadDshPage();
    } else {
      dialog.showMessageBox(mainWindow, {
        type: 'error', title: APP_TITLE, message: '端口占用但服务无响应', detail: `日志: ${LOG_PATH}`,
        buttons: ['退出'],
      }).then(() => app.quit());
    }
    return;
  }

  showLoading('正在启动 DeepSeek Harness…');
  const ready = await startDsh();
  if (ready && mainWindow && !mainWindow.isDestroyed()) {
    loadDshPage();
    // 后台静默检查 DSH 内核更新：有新版本才提示
    checkDshUpdate(false).catch(() => {});
  }
}

// ---------------- 生命周期 ----------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerHelpIpc();
    createWindow();
    boot();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  app.quit(); // Windows：所有窗口关闭即退出（包括最小化到任务栏的情况由系统处理）
});

app.on('before-quit', () => {
  quitting = true;
  if (ownedServer) stopDsh();
});
