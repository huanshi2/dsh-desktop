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
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');
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
const HELP_MENU_H = 110; // 菜单窗口高（px，DIP），兜底值；加载后按内容自适应修正（3 项约需 96~100px）

// 更新提示角标（非阻塞、不抢焦点；忽略的版本不再提示）
let updateNotifyWin = null;
let pendingDshUpdate = null;  // 角标中待处理的 DSH 新版本
let pendingAppUpdate = null;  // 角标中待处理的桌面版新版本
const UPDATE_NOTIFY_W = 300;  // 角标宽（px，DIP）
const UPDATE_NOTIFY_H = 122;  // 角标高（px，DIP）

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
// 优先级：config.dshCommand 显式指定 > 应用托管安装 > PATH 上的 dsh > npx 缓存 > npx 在线安装
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

// ---------------- 应用托管 DSH 安装 ----------------
// App 在 <userData>/dsh 下托管一份 DSH 安装，可在 App 内用 npm 升级，
// 启动时优先使用它，避免依赖 npx 缓存（会被 npm 随时清理）或全局安装。
function managedDshDir() {
  return path.join(app.getPath('userData'), 'dsh');
}

function managedDshBin() {
  const bin = path.join(managedDshDir(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return fs.existsSync(bin) ? bin : null;
}

function getManagedDshVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(
      path.join(managedDshDir(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch { /* 未安装 */ }
  return null;
}

/** PATH 上全局安装的 dsh 版本（dsh --version） */
function getPathDshVersion() {
  if (!whereOnPath('dsh')) return null;
  try {
    const r = spawnSync('dsh', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000 });
    if (r.status === 0) {
      const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?)/.exec(String(r.stdout || ''));
      return m ? m[1] : null;
    }
  } catch { /* 忽略 */ }
  return null;
}

/** 当前将实际使用的 DSH 内核版本：应用托管 > PATH > npx 缓存 */
function getLocalDshVersion() {
  const managed = getManagedDshVersion();
  if (managed) return managed;
  const pathVer = getPathDshVersion();
  if (pathVer) return pathVer;
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
  // 2. 应用托管安装（App 内更新的版本，优先使用）
  const managedBin = managedDshBin();
  if (managedBin) {
    return { command: 'node', args: [], shell: false, kind: 'managed', bin: managedBin };
  }
  // 3. PATH 上的 dsh
  if (whereOnPath('dsh')) {
    return { command: 'dsh', args: ['web', '--port', String(PORT)], shell: false, kind: 'dsh' };
  }
  // 4. npx 缓存（本机已有 @deepseek-ai/dsh 0.1.0-rc.6）
  const cachedBin = scanNpxCacheDsh();
  if (cachedBin) {
    return { command: 'node', args: [], shell: false, kind: 'cached', bin: cachedBin };
  }
  // 5. npx 在线兜底
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
  if (plan.kind === 'cached' || plan.kind === 'managed') {
    command = process.env.DSH_DESKTOP_NODE || 'node'; // 用 node 运行托管/npx 缓存里的 dsh bin.js
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
    `DSH Desktop v${APP_VERSION}`,
    `DSH 内核: ${dshVer || '未知（PATH/npx 方式启动）'}`,
    '',
    'DSH Desktop 是 DeepSeek Harness (DSH) 的本地封装：',
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
      if (manual) {
        const { response } = await dialog.showMessageBox(mainWindow || undefined, {
          type: 'info', title: '发现 DSH 新版本',
          message: `DSH 有新版本可用`,
          detail: `当前: ${localVer}\n最新: ${latest}\n\n点击「立即更新」将在 App 内下载安装新版（需本机已安装 npm），完成后自动用新版本重启服务。`,
          buttons: ['立即更新', '稍后'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) await runDshUpdate(latest);
      } else {
        // 启动时静默检查：不弹模态框，用右上角角标提示（可选更新，不挡进入）
        if (ignoredDshVersion() === latest) {
          log(`已忽略 DSH ${latest} 的更新提示，跳过`);
        } else {
          pendingDshUpdate = { latest };
          showUpdateNotify({ cur: localVer, latest, kind: 'dsh' });
        }
      }
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

// 用 npm 把指定版本安装到应用托管目录（<userData>/dsh），返回 { ok, version?, error? }
// 注意：不能把绝对路径传给 --prefix —— 经 cmd 转发会丢失盘符/被截断（便携版 cwd 是临时目录），
// 这里改用 spawn 的 cwd 直接指定目录，并预写最小 package.json。
// --prefer-offline 让后续增量更新复用 npm 缓存，显著加快（首次全量安装仍需下载完整依赖树）。
function installDshUpdate(version) {
  const dir = managedDshDir();
  fs.mkdirSync(dir, { recursive: true });
  try {
    const pkgJson = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      fs.writeFileSync(pkgJson, JSON.stringify({ name: 'dsh-desktop-managed', private: true, version: '0.0.0' }, null, 2));
    }
  } catch (e) { log(`写入 package.json 失败: ${e.message}`); }
  const spec = version ? `@deepseek-ai/dsh@${version}` : '@deepseek-ai/dsh';
  log(`安装 DSH ${spec} → ${dir}`);
  return new Promise((resolve) => {
    const child = spawn('npm.cmd',
      ['install', '--prefer-offline', '--no-audit', '--no-fund', '--loglevel=error', spec],
      { cwd: dir, shell: true, windowsHide: true, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const progressLines = [];
    let dirty = false;
    const onData = (d) => {
      const s = String(d);
      output += s;
      log(`[npm] ${s.trim()}`);
      const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const l of lines) {
        if (progressLines.length >= 15) progressLines.shift();
        progressLines.push(l);
      }
      dirty = true;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setInterval(() => {
      if (dirty && progressLines.length) {
        dirty = false;
        pushLoadingProgress(progressLines.join('\n'));
      }
    }, 400);
    child.on('error', (err) => {
      clearInterval(timer);
      pushLoadingProgress(`安装进程启动失败: ${err.message}`);
      resolve({ ok: false, error: err.message, output });
    });
    child.on('close', (code) => {
      clearInterval(timer);
      if (code === 0) {
        pushLoadingProgress('安装完成，正在用新版本重启服务…');
        resolve({ ok: true, version: getManagedDshVersion(), output });
      } else {
        pushLoadingProgress(`安装失败（npm 退出码 ${code}），正在用原版本重启服务…`);
        resolve({ ok: false, code, output });
      }
    });
  });
}

// 执行"立即更新"：停止旧服务 → npm 安装新版 → 用新版重启服务
async function runDshUpdate(version) {
  if (!whereOnPath('npm')) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'error', title: 'DSH 更新',
      message: '未检测到 npm，无法在 App 内更新',
      detail: '请先安装 Node.js（含 npm）后重试。\n或在终端手动执行：npm i -g @deepseek-ai/dsh',
      buttons: ['确定'],
    });
    return;
  }
  const wasRunning = ownedServer && !!dshProcess;
  if (wasRunning) {
    ownedServer = false; // 避免 stopDsh 后 exit 处理器弹"服务已退出"
    stopDsh();
  }
  showLoading(
    `正在安装 DSH ${version}…`,
    '首次更新需下载完整依赖，约 1~3 分钟；下方为实时进度。窗口内可看到下载过程。'
  );

  const result = await installDshUpdate(version);
  if (result.ok && result.version) {
    log(`DSH 更新成功: ${result.version}`);
    if (wasRunning) {
      const ready = await startDsh();
      if (ready && mainWindow && !mainWindow.isDestroyed()) {
        loadDshPage();
        dialog.showMessageBox(mainWindow, {
          type: 'info', title: 'DSH 更新完成',
          message: `DSH 已更新到 v${result.version}`,
          detail: '服务已用新版本重启。',
          buttons: ['确定'],
        });
      } else {
        dialog.showMessageBox(mainWindow, {
          type: 'error', title: 'DSH 更新完成但启动失败',
          message: `DSH 已更新到 v${result.version}，但服务未能启动`,
          detail: `日志: ${LOG_PATH}`,
          buttons: ['确定'],
        });
      }
    } else {
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'info', title: 'DSH 更新完成',
        message: `DSH 已更新到 v${result.version}`,
        detail: '请重启桌面版以使用新版本。',
        buttons: ['确定'],
      });
    }
  } else {
    log(`DSH 更新失败: ${result.error || ('npm 退出码 ' + result.code)}`);
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'error', title: 'DSH 更新失败',
      message: '安装新版本失败',
      detail: `错误: ${result.error || ('npm 退出码 ' + result.code)}\n\n日志: ${LOG_PATH}`,
      buttons: ['确定'],
    });
    if (wasRunning && mainWindow && !mainWindow.isDestroyed()) {
      showLoading('正在重新启动 DSH…');
      startDsh();
    }
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
      if (manual) {
        const { response } = await dialog.showMessageBox(mainWindow || undefined, {
          type: 'info', title: '发现桌面版新版本',
          message: `DSH 桌面版 v${latest} 已发布`,
          detail: `当前: v${APP_VERSION}\n最新: v${latest}\n\n「立即更新」将下载新版并自动替换（通过桌面快捷方式定位安装位置）；也可打开 GitHub 下载页手动更新。`,
          buttons: ['立即更新', '打开下载页', '稍后'],
          defaultId: 0,
          cancelId: 2,
        });
        if (response === 0) await runAppUpdate(latest);
        else if (response === 1 && rel.html_url) shell.openExternal(rel.html_url);
      } else {
        // 启动时静默检查：右上角角标提示，可忽略（该版本不再提示）
        if (ignoredAppVersion() === latest) {
          log(`已忽略桌面版 v${latest} 的更新提示，跳过`);
        } else {
          pendingAppUpdate = { latest };
          showUpdateNotify({ cur: APP_VERSION, latest, kind: 'app' });
        }
      }
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
    // 按菜单内容自然高度自适应窗口：避免固定高度把最后一个菜单项裁掉一半
    helpMenuWin.webContents.once('did-finish-load', () => {
      helpMenuWin.webContents.executeJavaScript(`(() => {
        const menu = document.getElementById('menu');
        if (!menu) return null;
        const items = Array.from(menu.querySelectorAll('.item'));
        const cs = getComputedStyle(menu);
        const vPad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        const vBorder = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
        const itemH = items.reduce((s, el) => s + el.getBoundingClientRect().height, 0);
        return Math.ceil(itemH + vPad + vBorder);
      })()`).then((h) => {
        if (typeof h === 'number' && h > 0 && helpMenuWin && !helpMenuWin.isDestroyed()) {
          helpMenuWin.setContentSize(HELP_MENU_W, Math.max(h, 1));
        }
      }).catch(() => {});
    });
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
  // 更新角标按钮：update=立即更新，ignore=忽略此版本（该版本不再提示）
  ipcMain.on('un:action', (e, action) => {
    closeUpdateNotify();
    if (action === 'update') {
      const d = pendingDshUpdate;
      pendingDshUpdate = null;
      if (d) { runDshUpdate(d.latest); return; }
      const a = pendingAppUpdate;
      pendingAppUpdate = null;
      if (a) { runAppUpdate(a.latest); }
    } else if (action === 'ignore') {
      const d = pendingDshUpdate;
      pendingDshUpdate = null;
      if (d) ignoreDshVersion(d.latest);
      const a = pendingAppUpdate;
      pendingAppUpdate = null;
      if (a) ignoreAppVersion(a.latest);
    }
  });
}

// ---------------- 更新角标（非阻塞提示） ----------------
function closeUpdateNotify() {
  if (updateNotifyWin && !updateNotifyWin.isDestroyed()) updateNotifyWin.close();
}

function showUpdateNotify({ cur, latest, kind }) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (updateNotifyWin && !updateNotifyWin.isDestroyed()) return;
  const cb = mainWindow.getContentBounds();
  const x = Math.round(cb.x + cb.width - UPDATE_NOTIFY_W - 16);
  const y = Math.round(cb.y + TITLEBAR_HEIGHT + 12);
  updateNotifyWin = new BrowserWindow({
    x, y,
    width: UPDATE_NOTIFY_W,
    height: UPDATE_NOTIFY_H,
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
    focusable: false, // 不抢主窗口焦点：用户可继续正常使用
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'updatenotify-preload.js'),
    },
  });
  updateNotifyWin.setMenu(null);
  updateNotifyWin.loadFile(path.join(__dirname, 'updatenotify.html'), {
    query: { cur: encodeURIComponent(cur), latest: encodeURIComponent(latest), kind: kind || 'dsh' },
  });
  updateNotifyWin.once('ready-to-show', () => {
    if (updateNotifyWin && !updateNotifyWin.isDestroyed()) updateNotifyWin.show();
  });
  updateNotifyWin.on('closed', () => { updateNotifyWin = null; });
  // 90 秒后自动关闭，避免长时间挂着
  setTimeout(() => closeUpdateNotify(), 90000);
}

// ---------------- 更新状态持久化（忽略的版本） ----------------
function updateStatePath() {
  return path.join(app.getPath('userData'), 'update-state.json');
}

function readUpdateState() {
  try { return JSON.parse(fs.readFileSync(updateStatePath(), 'utf8')); } catch { return {}; }
}

function writeUpdateState(s) {
  try { fs.writeFileSync(updateStatePath(), JSON.stringify(s, null, 2)); } catch { /* 忽略 */ }
}

function ignoredDshVersion() {
  return readUpdateState().ignoredDshVersion || null;
}

function ignoreDshVersion(v) {
  const s = readUpdateState();
  s.ignoredDshVersion = v;
  writeUpdateState(s);
  log(`已忽略 DSH ${v} 的更新提示`);
}

function ignoredAppVersion() {
  return readUpdateState().ignoredAppVersion || null;
}

function ignoreAppVersion(v) {
  const s = readUpdateState();
  s.ignoredAppVersion = v;
  writeUpdateState(s);
  log(`已忽略桌面版 v${v} 的更新提示`);
}

// ---------------- 桌面版更新（便携版 exe 定位/替换） ----------------
// 便携版运行时进程在临时目录，无法直接得知原始安装路径。
// 通过桌面/开始菜单里的快捷方式（指向 DSH-Desktop-*.exe）反查安装目录。
function findInstalledExe() {
  const roots = [
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop') : null,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'OneDrive', 'Desktop') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
  ].filter(Boolean);
  const psScript = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$roots = @(${roots.map(r => `'${r.replace(/'/g, "''")}'`).join(',')})`,
    'foreach ($d in $roots) {',
    '  if (-not (Test-Path -LiteralPath $d)) { continue }',
    '  Get-ChildItem -LiteralPath $d -Filter *.lnk | ForEach-Object {',
    '    $s = (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName)',
    '    $t = $s.TargetPath',
    "    if ($t -match 'DSH-Desktop-\\d+\\.\\d+\\.\\d+\\.exe') { Write-Output ($_.FullName + '|' + $t) }",
    '  }',
    '}',
  ].join('\n');
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', psScript],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000, encoding: 'utf8' });
    if (r.status !== 0) return null;
    const line = String(r.stdout || '').split(/\r?\n/).map(l => l.trim()).find(l => l.includes('|'));
    if (!line) return null;
    const [lnkPath, exePath] = line.split('|');
    if (lnkPath && exePath && fs.existsSync(exePath)) {
      return { lnkPath, exePath, dir: path.dirname(exePath), exeName: path.basename(exePath) };
    }
  } catch { /* 忽略 */ }
  return null;
}

function updateShortcutTarget(lnkPath, newExePath) {
  try {
    const psScript = [
      `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}')`,
      `$s.TargetPath = '${newExePath.replace(/'/g, "''")}'`,
      `$s.WorkingDirectory = '${path.dirname(newExePath).replace(/'/g, "''")}'`,
      '$s.Save()',
    ].join('\n');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', psScript],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000 });
    return r.status === 0;
  } catch { return false; }
}

// 从 GitHub release 下载指定版本 exe，返回 { ok, dest?, error? }，进度推送到加载页
async function downloadReleaseAsset(url, dest) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  let total = 0, received = 0;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'dsh-desktop' }, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    total = Number(res.headers.get('content-length') || 0);
    const show = () => {
      if (total > 0) {
        const pct = (received / total * 100).toFixed(0);
        pushLoadingProgress(`正在下载 DSH 桌面版… ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB (${pct}%)`);
      } else {
        pushLoadingProgress(`正在下载 DSH 桌面版… ${(received / 1048576).toFixed(1)} MB`);
      }
    };
    const counter = new Transform({
      transform(chunk, enc, cb) {
        received += chunk.length;
        show();
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest));
    return { ok: true, dest, bytes: received };
  } catch (e) {
    try { fs.unlinkSync(dest); } catch { /* 忽略 */ }
    return { ok: false, error: String(e.message || e) };
  }
}

// 执行桌面版更新：下载 → 更新快捷方式 → 写替换脚本 → 退出并完成替换重启
async function runAppUpdate(latest) {
  const repo = process.env.DSH_DESKTOP_UPDATE_REPO || config.updateRepo;
  if (!repo) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'error', title: '桌面版更新',
      message: '未配置更新源（config.json 的 updateRepo 为空）',
      buttons: ['确定'],
    });
    return;
  }
  let assetUrl;
  try {
    assetUrl = await resolveReleaseAssetUrl(repo, latest);
  } catch (e) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'error', title: '桌面版更新失败',
      message: '无法获取新版下载地址',
      detail: String(e.message || e), buttons: ['确定'],
    }).then(() => loadDshPage());
    return;
  }
  const inst = findInstalledExe();
  if (!inst) {
    // 找不到快捷方式 → 降级为「下载到本地」
    const dest = path.join(app.getPath('userData'), 'updates', `DSH-Desktop-${latest}.exe`);
    showLoading(`正在下载 DSH 桌面版 v${latest}…`);
    const dl = await downloadReleaseAsset(assetUrl, dest);
    if (dl.ok) {
      dialog.showMessageBox(mainWindow, {
        type: 'info', title: '桌面版更新下载完成',
        message: `已下载到: ${dest}`,
        detail: '未找到桌面快捷方式，请关闭 App 后手动替换原 exe，或直接运行该文件。',
        buttons: ['确定'],
      }).then(() => loadDshPage());
    } else {
      dialog.showMessageBox(mainWindow, {
        type: 'error', title: '桌面版更新下载失败',
        message: dl.error, buttons: ['确定'],
      }).then(() => loadDshPage());
    }
    return;
  }
  const dest = path.join(inst.dir, `DSH-Desktop-${latest}.exe`);
  showLoading(`正在下载 DSH 桌面版 v${latest}…`);
  const dl = await downloadReleaseAsset(assetUrl, dest);
  if (!dl.ok) {
    dialog.showMessageBox(mainWindow, {
      type: 'error', title: '桌面版更新下载失败',
      message: dl.error, buttons: ['确定'],
    }).then(() => loadDshPage());
    return;
  }
  // 更新快捷方式指向新 exe（退出前完成，避免文件被占用）
  if (inst.lnkPath) {
    if (!updateShortcutTarget(inst.lnkPath, dest)) log(`快捷方式更新失败: ${inst.lnkPath}`);
    else log(`快捷方式已指向: ${dest}`);
  }
  // 写替换脚本：等待旧进程退出 → 删除旧 exe → 启动新 exe → 删除自身
  const oldName = inst.exeName;
  const batPath = path.join(app.getPath('userData'), 'selfupdate.bat');
  const bat = [
    '@echo off',
    `set "OLD=${oldName}"`,
    `set "DIR=${inst.dir}"`,
    `set "NEW=DSH-Desktop-${latest}.exe"`,
    ':WAIT',
    `tasklist /fi "imagename eq %OLD%" 2>nul | find /i "%OLD%" >nul`,
    'if %errorlevel%==0 ( timeout /t 1 /nobreak >nul & goto WAIT )',
    `del /f /q "%DIR%\\%OLD%"`,
    `start "" "%DIR%\\%NEW%"`,
    'del /f /q "%~f0"',
    'exit',
  ].join('\r\n');
  try { fs.writeFileSync(batPath, bat); } catch (e) {
    dialog.showMessageBox(mainWindow, {
      type: 'error', title: '桌面版更新失败',
      message: `无法写入替换脚本: ${e.message}`, buttons: ['确定'],
    }).then(() => loadDshPage());
    return;
  }
  log(`桌面版更新就绪，退出并替换: ${oldName} → DSH-Desktop-${latest}.exe`);
  dialog.showMessageBox(mainWindow, {
    type: 'info', title: '桌面版更新',
    message: `新版 v${latest} 已下载完成`,
    detail: '点击「确定」将关闭本 App 并自动完成替换，然后启动新版。',
    buttons: ['确定'],
  }).then(() => {
    try { spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* 忽略 */ }
    app.quit();
  });
}

// 解析 GitHub release 中对应版本的 exe 下载地址
async function resolveReleaseAssetUrl(repo, version) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'User-Agent': 'dsh-desktop' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rel = await res.json();
  const targetName = `DSH-Desktop-${version}.exe`;
  const assets = rel.assets || [];
  const hit = assets.find(a => a.name === targetName) || assets.find(a => /^DSH-Desktop-.*\.exe$/i.test(a.name));
  if (!hit) throw new Error(`Release 中未找到 ${targetName} 资产`);
  return hit.browser_download_url;
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
  mainWindow.on('move', closeUpdateNotify);
  mainWindow.on('resize', closeUpdateNotify);
  mainWindow.on('minimize', closeHelpMenu);
  mainWindow.on('minimize', closeUpdateNotify);
  // 点击 DSH 页面任意处 / 按 Esc → 关闭菜单与更新角标
  dshView.webContents.on('input-event', (event, input) => {
    if (input.type === 'mouseDown' || (input.type === 'keyDown' && input.key === 'Escape')) {
      closeHelpMenu();
      closeUpdateNotify();
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
    closeUpdateNotify();
  });

  return mainWindow;
}

function showLoading(text, hint) {
  if (dshView && !dshView.webContents.isDestroyed()) {
    dshView.webContents.loadFile(path.join(__dirname, 'loading.html'), {
      query: { text: encodeURIComponent(text), hint: hint ? encodeURIComponent(hint) : '' },
    });
  }
}

// 把实时进度文本推送到加载页（npm 输出等），失败静默忽略
function pushLoadingProgress(text) {
  if (dshView && !dshView.webContents.isDestroyed()) {
    dshView.webContents.executeJavaScript(
      `window.__setLoadProgress && window.__setLoadProgress(${JSON.stringify(text)})`
    ).catch(() => {});
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
    // 后台静默检查更新（角标提示，不挡使用）：DSH 内核 + 桌面版
    checkDshUpdate(false).catch(() => {});
    checkAppUpdate(false).catch(() => {});
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
  closeUpdateNotify();
  if (ownedServer) stopDsh();
});
