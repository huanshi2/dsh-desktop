/**
 * electron-builder afterPack 钩子：
 * 在 NSIS/便携外壳封装之前，给内部 exe 设置图标和版本信息。
 * 必须在打包前做——打包后再 rcedit 会破坏便携版外壳。
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const RCEDIT = path.join(__dirname, 'rcedit-x64.exe');
const ICO = path.join(__dirname, '..', 'build', 'icon.ico');

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const exeName = `${packager.appInfo.productFilename}.exe`;
  const exePath = path.join(appOutDir, exeName);

  if (!fs.existsSync(RCEDIT)) {
    console.warn('[afterPack] 未找到 rcedit，跳过图标设置:', RCEDIT);
    return;
  }
  if (!fs.existsSync(exePath)) {
    console.warn('[afterPack] 未找到 exe，跳过图标设置:', exePath);
    return;
  }

  const args = [
    exePath,
    '--set-icon', ICO,
    '--set-version-string', 'ProductName', 'DSH Desktop',
    '--set-version-string', 'FileDescription', 'DSH Desktop - DeepSeek Harness desktop app',
    '--set-version-string', 'CompanyName', 'local',
    '--set-file-version', '1.1.2.0',
    '--set-product-version', '1.1.2.0',
  ];
  const r = spawnSync(RCEDIT, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`[afterPack] rcedit 失败: ${r.status}`);
  }
  console.log('[afterPack] 图标/版本信息已写入:', exePath);
};








