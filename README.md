# DSH 桌面版（dsh-desktop）

> DeepSeek Harness（DSH）的本地桌面封装套壳程序 —— **双击即开启，关窗即停止**。

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
| 端口冲突处理 | 3080 被占用时弹窗询问「直接打开现有实例 / 退出」 |
| 启动引导页 | 服务就绪前显示加载页（首次启动需装插件，最长等待 5 分钟） |
| 自动解析 dsh | 依次尝试：`dsh` 命令 → npm 缓存 → `npx` 在线兜底 |
| 日志 | 运行日志写入 `%APPDATA%\DSH桌面版\dsh.log` |
| 版本说明 | 标题栏常驻显示版本号；「帮助 → 关于」查看详细信息 |
| 检查更新 | 「帮助」菜单可分别检查 **DSH 内核**（npm）与**桌面版自身**（GitHub Releases）更新 |
| 重启服务 | 「文件 → 重启服务」快速重启 DSH 进程 |

## 版本说明（Changelog）

### v1.0.0（当前）
- 首个可用版本：完整的启动/停止/窗口控制闭环
- 加载页、单实例锁、端口冲突弹窗、日志
- 关于对话框（App 版本 / DSH 内核版本 / 端口 / 配置与日志路径）
- 检查更新：DSH 内核（npm registry）与桌面版（GitHub Releases，需配置 `updateRepo`）
- 便携版单文件 exe（约 70 MB），图标与版本信息已内嵌

## 更新（Upgrade）

### 1. DSH 内核更新（重要）
DSH 本体由官方持续迭代，桌面版每次启动都会使用**当前缓存的最新内核**。
升级内核（在终端执行）：

```bash
npm i -g @deepseek-ai/dsh        # 全局安装
# 或
npx --yes @deepseek-ai/dsh --version   # 验证
```

升级后重新打开桌面版即生效。也可以在 App 里点 **「帮助 → 检查 DSH 更新」** 查看是否落后于 npm 最新版。

### 2. 桌面版自身更新
- 本地自用构建：无更新渠道，检查时会提示「未配置更新源」。
- 若发布到 GitHub Releases：在 `%APPDATA%\DSH桌面版\config.json` 里设置：

```json
{ "updateRepo": "用户名/仓库名" }
```

之后 **「帮助 → 检查桌面版更新」** 会比对 GitHub 最新 Release 并打开下载页。

---

## 使用

1. 下载或构建 `DSH桌面版-1.0.0.exe`（见下文「构建」），双击运行。
2. 等待加载页结束，DSH 界面自动打开（默认 http://127.0.0.1:3080）。
3. 首次启动较慢（1~5 分钟）：DSH 需要初始化 profile 并安装插件，请耐心等待。
4. 用完点右上角 ✕ 关闭，DSH 服务随之停止。

> 提示：DSH 的配置（API Key、模型等）位于 `C:\Users\<你>\.dsh`，由内核统一管理，与本套壳无关。

## 配置

配置文件优先级：`%APPDATA%\DSH桌面版\config.json`（打包后）> 应用目录 `config.json`。

```jsonc
{
  "port": 3080,            // DSH 服务端口
  "dshCommand": null,      // 自定义启动命令（整条 shell 命令），如 "dsh web --port 8080"
  "dshArgs": [],           // 附加参数
  "bootTimeoutSec": 300,   // 启动超时（秒）
  "updateRepo": null       // 桌面版更新源，如 "huanshi2/dsh-desktop"
}
```

环境变量（优先级最高）：`DSH_DESKTOP_PORT`、`DSH_DESKTOP_COMMAND`、`DSH_DESKTOP_LOG`、`DSH_DESKTOP_UPDATE_REPO`、`DSH_DESKTOP_USER_DATA`（测试用）。

## 开发

```bash
npm install          # 安装 electron / electron-builder
npm start            # 开发模式运行（默认端口 3080）
npm run icon         # 重新生成图标（纯 Node 绘制，无依赖）
npm run dist         # 打包便携版 exe → dist/DSH桌面版-<版本>.exe
```

### 打包说明（踩坑记录）

- 必须用 `signAndEditExecutable: false`（本机无管理员权限，winCodeSign 包里的 macOS 符号链接解压会失败）。
- 图标/版本信息通过 `tools/after-pack.js`（electron-builder `afterPack` 钩子）写入**内层** exe —— 打包完成后再 rcedit 会破坏便携版 NSIS 外壳，导致运行时 "NSIS Error"。

## 目录结构

```
dsh-desktop/
├── main.js               # Electron 主进程：启停、窗口、菜单、更新检查
├── loading.html          # 启动加载页
├── config.json           # 默认配置
├── generate-icon.js      # 纯 Node 图标生成（build/icon.png）
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
| 提示「端口 3080 已被占用」 | 已有 DSH 实例在运行：可「直接打开」复用；或先结束占用进程 |
| 「DSH 服务已退出 / 启动超时」 | 查看 `%APPDATA%\DSH桌面版\dsh.log` 定位原因 |
| 提示 DSH 内核有更新 | 终端执行 `npm i -g @deepseek-ai/dsh` 后重启桌面版 |
| 关闭窗口后端口仍被占用 | 一般不会发生（进程树已杀）；若出现，`netstat -ano \| findstr 3080` 手动清理 |

## 协议

MIT。本套壳非 DeepSeek 官方产品；DSH 本体为 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）。
