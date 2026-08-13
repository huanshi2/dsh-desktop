/**
 * 把 build/icon.png 包装成 ICO（PNG 压缩条目，Windows Vista+ 支持）
 * 用法: node tools/png-to-ico.js <输入.png> <输出.ico>
 */
'use strict';
const fs = require('fs');

const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error('用法: node tools/png-to-ico.js <in.png> <out.ico>'); process.exit(1); }

const png = fs.readFileSync(input);
if (png[0] !== 0x89 || png[1] !== 0x50) { console.error('不是 PNG 文件'); process.exit(1); }

// 从 IHDR 读尺寸
const w = png.readUInt32BE(16);
const h = png.readUInt32BE(20);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // count

const entry = Buffer.alloc(16);
entry.writeUInt8(w >= 256 ? 0 : w, 0);
entry.writeUInt8(h >= 256 ? 0 : h, 1);
entry.writeUInt8(0, 2);  // palette
entry.writeUInt8(0, 3);  // reserved
entry.writeUInt16LE(1, 4);  // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12); // offset

fs.writeFileSync(output, Buffer.concat([header, entry, png]));
console.log(`ico written: ${output} (${w}x${h}, ${png.length} bytes png payload)`);
