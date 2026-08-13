/**
 * 测试用 mock DSH 服务器：模拟 dsh web 的启动行为
 *   - 监听 PORT（默认 3099）
 *   - 打印就绪日志
 *   - 收到 SIGTERM/taskkill 时打印退出
 */
'use strict';
const http = require('http');
const port = Number(process.env.PORT || 3099);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html><body style="background:#0f1220;color:#4cc2ff;font-family:monospace">mock dsh web: OK</body></html>');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock dsh web: http://127.0.0.1:${port}`);
});

process.on('SIGTERM', () => { console.log('mock: got SIGTERM'); process.exit(0); });
process.on('exit', (code) => console.log(`mock: exit ${code}`));
