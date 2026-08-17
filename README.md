# DSH Desktop（dsh-desktop）

![GitHub release](https://img.shields.io/github/v/release/huanshi2/dsh-desktop)
![GitHub Actions](https://img.shields.io/github/actions/workflow/status/huanshi2/dsh-desktop/release.yml?label=build)
![License](https://img.shields.io/github/license/huanshi2/dsh-desktop)
![Platform](https://img.shields.io/badge/platform-Windows-0078d6)

> DeepSeek Harness（DSH）的本地桌面封装套壳程序 —— **双击即开启，关窗即停止**。
>
> 源码仓库：[github.com/huanshi2/dsh-desktop](https://github.com/huanshi2/dsh-desktop) · 下载：[GitHub Releases](https://github.com/huanshi2/dsh-desktop/releases)

DSH（DeepSeek Harness）本身是一个命令行/服务程序：`dsh web` 会在本地启动 Web 服务（默认 http://127.0.0.1:3080），再在浏览器里打开界面。本套壳程序用 Electron 把它封装成普通桌面软件：

- 双击 App 图标 → 自动在后台拉起 `dsh web` → 窗口加载 DSH 界面
- 点右上角 **✕** → 连带结束 DSH 进程（含子进程树），不留后台残留
- **最小化 / 最大化 / 关闭** 均为系统原生窗口按钮

---

## 功能特性

| 功能 | 说明 |
|---|---|
| 一键开启 | 双击 exe 即启动，无需打开终端敲命令 |
| 原生窗口控制 | 右上角最小化/最大化/关闭，与普通软件一致 |
| 干净退出 | 关闭窗口自动 `taskkill /T /F` 结束 DSH 进程树 |
| 单实例锁 | 重复双击只会聚焦已有窗口，不会重复启动服务 |
| 端口冲突处理 | 端口被占用时弹窗询问「直接打开现有实例 / 退出」 |
| 启动引导页 | 服务就绪前显示加载页（首次启动需装插件，最长等待 5 分钟） |
| 自动解析 dsh | 依次尝试：`dsh` 命令 → npm 缓存 → `npx` 在线兜底 |
| 日志 | 运行日志写入 `%APPDATA%\DSH Desktop\dsh.log` |
| 版本说明 | 标题栏常驻显示版本号；「帮助 → 关于」查看详细信息 |
| 检查更新 | 启动后后台**静默检查** DSH 内核与桌面版更新；有新版本时**右上角弹非阻塞角标**（可「立即更新」或「忽略此版本」，不打断使用）；「帮助」菜单可手动检查并在 App 内直接更新 |
| 崩溃自愈 | 渲染进程崩溃自动重载；DSH 服务异常退出可一键「重新启动」 |
| 重启服务 | 「文件 → 重启服务」快速重启 DSH 进程 |
| 自动打包 | GitHub Actions：推送 `v*` 标签即自动构建 exe 并发布 Release |

## 版本说明（Changelog）

### v1.1.2（当前）
- **DSH 内核支持 App 内一键更新**：发现新版后点「立即更新」即可，App 把新内核安装到自管目录（`%APPDATA%\DSH Desktop\dsh`）并自动重启服务，无需终端（需本机有 npm）
- **桌面版支持 App 内自更新**：检查到新版后「立即更新」，自动下载、定位安装位置（桌面/开始菜单快捷方式）、替换 exe 并重启新版
- **更新提示改为非阻塞角标**：启动静默检查发现新版时，右上角弹出小卡片（不抢焦点、不挡使用），可「立即更新」或「忽略此版本」（该版本不再提示）
- 修复便携版下 npm 更新路径解析失败（绝对路径经 cmd 转发被截断）的问题
- 更新安装实时显示进度；后续增量更新复用 npm 缓存加速

### v1.1.0
- 产品名改为全英文 **DSH Desktop**（窗口标题 / exe 文件名 / 快捷方式 / 数据目录）
- 启动后自动静默检查 DSH 内核更新（仅在有新版时提示）
- 健壮性：DSH 服务异常退出时提供「重新启动」；渲染进程崩溃自动重载；「重启服务」不再误判端口占用
- 新增 GitHub Actions：推 `v*` 标签自动打包发布（无需手动构建）
- README 徽章与文档完善

### v1.0.0
- 首个可用版本：完整的启动/停止/窗口控制闭环
- 加载页、单实例锁、端口冲突弹窗、日志
- 关于对话框（App 版本 / DSH 内核版本 / 端口 / 配置与日志路径）
- 检查更新：DSH 内核（npm registry）与桌面版（GitHub Releases）
- 便携版单文件 exe（约 70 MB），图标与版本信息已内嵌

## 更新（Upgrade）

### 1. DSH 内核更新（重要）
DSH 本体由官方持续迭代，桌面版每次启动都会使用**当前缓存的最新内核**，并自动静默检查新版本。
更新内核最省事的方式是在 App 里点 **「帮助 → 检查并更新 DSH」**，发现有新版时点「立即更新」：
App 会把新版下载安装到自己的托管目录（`%APPDATA%\DSH Desktop\dsh`）并自动重启服务，无需终端。

> 前提：本机需已安装 Node.js（含 npm）。App 内更新仅影响托管副本，不会改动全局安装。

也可以在终端手动升级：

```bash
npm i -g @deepseek-ai/dsh        # 全局安装
# 或
npx --yes @deepseek-ai/dsh --version   # 验证
```

App 的 DSH 启动优先级：自定义命令（config）> **App 托管版** > 全局 `dsh` > npx 缓存 > npx 在线。App 内更新过之后，会一直优先使用托管版。

### 2. 桌面版自身更新
- **App 内直接更新**：点 **「帮助 → 检查桌面版更新」**，发现新版后点「立即更新」，App 会：
  1. 从 GitHub Releases 下载新 exe；
  2. 通过桌面/开始菜单快捷方式自动定位安装位置；
  3. 更新快捷方式指向、替换 exe，并自动重启新版。
- 若找不到快捷方式（未装快捷方式），则降级为下载到本地（`%APPDATA%\DSH Desktop\updates\`），提示手动替换。
- 也可从 [GitHub Releases](https://github.com/huanshi2/dsh-desktop/releases) 手动下载最新 exe 覆盖。
- 更新源：`config.json` 的 `updateRepo: "huanshi2/dsh-desktop"`（GitHub 最新 Release 的 tag 如 `v1.1.0`）。

### 3. 维护者发布新版本
推送标签即自动构建发布（GitHub Actions）：

```bash
git tag v1.2.0
git push origin v1.2.0
```

---

## 使用

1. 从 [Releases](https://github.com/huanshi2/dsh-desktop/releases) 下载 `DSH-Desktop-1.1.2.exe`（或按「构建」自己打包），双击运行。
2. 等待加载页结束，DSH 界面自动打开（默认 http://127.0.0.1:3080）。
3. 首次启动较慢（1~5 分钟）：DSH 需要初始化 profile 并安装插件，请耐心等待。
4. 用完点右上角 ✕ 关闭，DSH 服务随之停止。

> 提示：DSH 的配置（API Key、模型等）位于 `C:\Users\<你>\.dsh`，由内核统一管理，与本套壳无关。

## 配置

配置文件优先级：`%APPDATA%\DSH Desktop\config.json`（打包后）> 应用目录 `config.json`。

```jsonc
{
  "port": 3080,            // DSH 服务端口（如需与网页版并存，可改为 3090）
  "dshCommand": null,      // 自定义启动命令（整条 shell 命令），如 "dsh web --port 8080"
  "dshArgs": [],           // 附加参数
  "bootTimeoutSec": 300,   // 启动超时（秒）
  "updateRepo": "huanshi2/dsh-desktop"  // 桌面版更新源
}
```

环境变量（优先级最高）：`DSH_DESKTOP_PORT`、`DSH_DESKTOP_COMMAND`、`DSH_DESKTOP_LOG`、`DSH_DESKTOP_UPDATE_REPO`、`DSH_DESKTOP_USER_DATA`（测试用）。

## 开发

```bash
npm install          # 安装 electron / electron-builder
npm start            # 开发模式运行（默认端口 3080）
npm run icon         # 重新生成图标（纯 Node 绘制，无依赖）
npm run dist         # 打包便携版 exe → dist/DSH-Desktop-<版本>.exe
```

### 打包说明（踩坑记录）

- 必须用 `signAndEditExecutable: false`（本机无管理员权限，winCodeSign 包里的 macOS 符号链接解压会失败）。
- 图标/版本信息通过 `tools/after-pack.js`（electron-builder `afterPack` 钩子）写入**内层** exe —— 打包完成后再 rcedit 会破坏便携版 NSIS 外壳，导致运行时 "NSIS Error"。
- GitHub Actions 自动打包见 `.github/workflows/release.yml`，推送 `v*` 标签即触发。

## 目录结构

```
dsh-desktop/
├── main.js               # Electron 主进程：启停、窗口、菜单、更新检查
├── loading.html          # 启动加载页
├── config.json           # 默认配置
├── generate-icon.js      # 纯 Node 图标生成（build/icon.png）
├── .github/workflows/    # GitHub Actions 自动打包发布
├── tools/
│   ├── after-pack.js     # 打包钩子：写图标/版本信息
│   ├── png-to-ico.js     # PNG → ICO 转换
│   └── rcedit-x64.exe    # Windows 资源编辑器（图标/版本）
├── test/mock-server.js   # 测试用 mock DSH 服务
└── build/icon.png|ico    # 应用图标
```

## 常见问题

| 现象 | 处理 |
|---|---|
| 首次启动 1~5 分钟 | 正常：DSH 初始化 profile、安装插件 |
| 提示「端口已被占用」 | 已有 DSH 实例在运行：可「直接打开」复用；或先结束占用进程 |
| 「DSH 服务已退出 / 启动超时」 | 弹窗点「重新启动」重试；查看 `%APPDATA%\DSH Desktop\dsh.log` 定位原因 |
| 提示 DSH 内核有更新 | 右上角角标点「立即更新」在 App 内升级（需本机有 npm）；或「忽略此版本」不再提示该版本；也可终端执行 `npm i -g @deepseek-ai/dsh` |
| 关闭窗口后端口仍被占用 | 一般不会发生（进程树已杀）；若出现，`netstat -ano \| findstr 3080` 手动清理 |
| 与网页版并存 | 把端口配置为 3090（`%APPDATA%\DSH Desktop\config.json`），两个实例互不干扰 |

## 协议

MIT。本套壳非 DeepSeek 官方产品；DSH 本体为 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）。
