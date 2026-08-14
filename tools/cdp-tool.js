/**
 * CDP 工具：eval / 截图 / 真实鼠标点击（Input.dispatchMouseEvent）
 * 用法:
 *   node cdp-tool.js eval <port> <url子串> <expression>
 *   node cdp-tool.js shot <port> <out.png> [url子串]
 *   node cdp-tool.js click <port> <url子串> <x> <y>    （视口坐标，Chromium 内部真实鼠标事件）
 */
'use strict';
const fs = require('fs');

const mode = process.argv[2];
const port = Number(process.argv[3]);

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const pages = list.filter((t) => t.type === 'page');
  const target = (mode === 'eval' || mode === 'click') ? process.argv[4] : (process.argv[5] || '');
  const page = pages.find((p) => p.url.includes(target)) || pages[0];
  if (!page) { console.error('找不到页面'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise((r) => {
    const id = Math.floor(Math.random() * 1e9);
    const h = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener('message', h); r(m); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method, params }));
  });

  if (mode === 'eval') {
    const res = await send('Runtime.evaluate', { expression: process.argv[5], returnByValue: true });
    console.log(JSON.stringify(res.result || res));
  } else if (mode === 'shot') {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    if (!res.result || !res.result.data) { console.error('截图失败'); process.exit(1); }
    fs.writeFileSync(process.argv[4], Buffer.from(res.result.data, 'base64'));
    console.log('已保存:', process.argv[4]);
  } else if (mode === 'click') {
    const x = Number(process.argv[5]);
    const y = Number(process.argv[6]);
    // 真实鼠标事件链：move → pressed → released（Chromium 内部派发，绕过 Windows 鼠标系统）
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    console.log(`已点击 (${x}, ${y})`);
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
