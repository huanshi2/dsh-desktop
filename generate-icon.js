/**
 * 生成 App 图标 build/icon.png（256x256，纯 Node 实现，无第三方依赖）
 * 画一个深色圆角方块 + 青色 ">_" 终端提示符
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;

// ---------- 纯 JS PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 绘制 ----------
const px = Buffer.alloc(SIZE * SIZE * 4);
function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}
function blend(x, y, r, g, b, a) {
  const i = (y * SIZE + x) * 4;
  const na = a / 255;
  const oa = px[i + 3] / 255;
  const outA = na + oa * (1 - na);
  if (outA <= 0) return;
  px[i] = Math.round((r * na + px[i] * oa * (1 - na)) / outA);
  px[i + 1] = Math.round((g * na + px[i + 1] * oa * (1 - na)) / outA);
  px[i + 2] = Math.round((b * na + px[i + 2] * oa * (1 - na)) / outA);
  px[i + 3] = Math.round(outA * 255);
}
function inRoundedRect(x, y, rx, ry, rw, rh, radius) {
  const cx = Math.max(rx + radius, Math.min(x, rx + rw - radius));
  const cy = Math.max(ry + radius, Math.min(y, ry + rh - radius));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}
function fillRoundedRect(rx, ry, rw, rh, radius, color) {
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      if (inRoundedRect(x, y, rx, ry, rw, rh, radius)) blend(x, y, ...color, 255);
    }
  }
}
function fillCircle(cx, cy, radius, color) {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) blend(x, y, ...color, 255);
    }
  }
}

// 背景：深色渐变圆角方块（上下渐变）
const M = 8; // margin
for (let y = M; y < SIZE - M; y++) {
  const t = (y - M) / (SIZE - 2 * M);
  const r = Math.round(26 + t * 8), g = Math.round(32 + t * 10), b = Math.round(58 + t * 12);
  for (let x = M; x < SIZE - M; x++) {
    if (inRoundedRect(x, y, M, M, SIZE - 2 * M, SIZE - 2 * M, 52)) setPx(x, y, r, g, b, 255);
  }
}
// 高光描边
for (let y = M; y < SIZE - M; y++) {
  for (let x = M; x < SIZE - M; x++) {
    if (inRoundedRect(x, y, M, M, SIZE - 2 * M, SIZE - 2 * M, 52) &&
        !inRoundedRect(x, y, M + 3, M + 3, SIZE - 2 * M - 6, SIZE - 2 * M - 6, 49)) {
      setPx(x, y, 90, 130, 200, 255);
    }
  }
}
// 青色 ">" 提示符
const cyan = [76, 194, 255];
const chevron = (() => {
  const pts = [];
  // 双线段 >_：左臂 (48,88)-(96,128) 和 (48,168)-(96,128)，下划线 (58,178)-(150,178)
  for (let t = 0; t <= 1; t += 0.004) {
    pts.push([48 + 48 * t, 88 + 40 * t]);   // 上臂
    pts.push([48 + 48 * t, 168 - 40 * t]);  // 下臂
  }
  return pts;
})();
for (const [x, y] of chevron) {
  fillCircle(Math.round(x), Math.round(y), 7, cyan);
}
for (let x = 58; x <= 150; x++) fillCircle(x, 178, 7, cyan);
// 光标方块 "_"
for (let y = 196; y < 216; y++) {
  for (let x = 66; x < 132; x++) blend(x, y, 76, 194, 255, 255);
}

const outDir = path.join(__dirname, 'build');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'icon.png');
fs.writeFileSync(outFile, encodePng(px, SIZE, SIZE));
console.log('icon written:', outFile, px.length, 'bytes');
