# DSH Desktop 迭代开发提示词模板

> 复制下方【提示词】块给 AI 使用，根据本次任务修改【本次任务】部分。

---

## 提示词（复制以下内容）

```
你正在维护 DSH Desktop —— DeepSeek Harness (DSH) 的 Windows 桌面封装项目，
源码在你的本地项目目录（下文以 `<项目目录>` 指代），已同步 GitHub（huanshi2/dsh-desktop）。

【本次任务】
（在这里写清楚要做什么，例如：给帮助菜单增加"重启服务"项）

━━━ 项目背景 ━━━
- Electron 33 + electron-builder（win portable 单文件 exe）
- 功能：双击启动自动拉起 `dsh web`（默认端口 3080，用户配置 3090），
  关窗即杀 dsh 进程树；单实例锁；端口冲突弹窗；静默检查 DSH 内核更新
- 关键文件：main.js（主进程）、titlebar.html + titlebar-preload.js
  （自绘标题栏：titleBarStyle:'hidden' + titleBarOverlay 保留系统最小化/最大化/关闭，
   "?"帮助按钮在系统按钮左侧）、helpmenu.html + helpmenu-preload.js
  （帮助菜单 = 独立无边框透明子窗口，菜单项经 ipcRenderer.send('hm:action') 触发主进程）、
  loading.html、config.json（port/dshCommand/updateRepo）、
  tools/after-pack.js（打包钩子 rcedit 图标/版本）、.github/workflows/release.yml（云构建）

━━━ 版本规则（用户规定，必须遵守）━━━
1. 小版本迭代：本地滚动更新，版本号 +0.0.1（如当前 1.1.1 → 1.1.2），
   **不发布 GitHub Release**，只提交代码到 main
2. 大版本（如 1.2.0）才发布 GitHub Release：推 tag（v1.2.0）触发 Actions 云构建，
   会自动打包 exe 并更新 Release
3. GitHub Releases 只保留两个：v1.1.0（初始版）+ v1.1.1（当前版）
4. 每次改版：package.json version + tools/after-pack.js 的版本字符串同步改

━━━ 安全红线（最重要，违反会毁掉用户正在进行的对话）━━━
1. 用户可能正在用 App 对话（运行中的实例进程名 DSH Desktop.exe /
   stub DSH-Desktop-1.1.1.exe）——【绝对禁止】按进程名/路径模式批量杀进程
2. 清理测试进程：只用启动时记录的精确 PID，或按"stub 名 + 解压目录"双重确认
3. 测试实例必须隔离：DSH_DESKTOP_PORT=31xx（避开用户端口）+ DSH_DESKTOP_USER_DATA=独立目录
4. 测试优先用 dev 模式（npx electron .，进程名 electron.exe，与用户 App 物理隔离）
5. 测试窗口启动后立即 MoveWindow 到主屏角落（如 40,40），避免与用户窗口重叠

━━━ 环境 ━━━
- Windows 11 双屏：主屏 3840x2160（150% 缩放，逻辑 2560x1440）；副屏 2560x1440
- 所有窗口坐标/DPI 换算注意 150% 缩放
- 用户实例占用 3090；网页版 3080（可能空闲）

━━━ 已验证的关键技术结论（不要再重复踩坑）━━━
1. 标题栏"?"按钮真实点击有效（titleBarOverlay + WebContentsView 方案没问题）
2. 验证"真实点击"必须用 CDP Input.dispatchMouseEvent
   （mouseMoved→mousePressed→mouseReleased），Runtime.evaluate 的 btn.click() 是合成事件不可靠；
   SetCursorPos+mouse_event 在后台会话不可靠；WM_NCHITTEST 查询要用屏幕坐标
3. contextIsolation 隔离世界：preload 代码里 window.xxxBridge 是 undefined！
   菜单项事件必须直接 ipcRenderer.send/invoke
4. HTML 下拉菜单会被祖先 overflow:hidden 裁剪（body 要 overflow:visible）
5. Menu.popup 的 x/y 单位是 DIP，不要乘 scaleFactor
6. 本地 electron-builder 打包偶发卡死（nsis 封装阶段，进程 CPU 0 即卡住）：
   杀掉重试；可靠替代 = 推 tag 触发 GitHub Actions 云构建后下载 exe
7. 帮助菜单是独立子窗口方案（helpmenu.html 无边框透明、不可聚焦、跟随"?"按钮定位），
   不要改回标题栏内 DOM 菜单（会被 WebContentsView 遮挡）
8. 关于对话框不要显示本机路径（用户要求：配置目录/日志路径不展示）

━━━ 交付前检查清单 ━━━
□ 用 CDP 截图确认 UI（无乱码、位置正确）
□ 帮助菜单功能链路：CDP Input 点击菜单项 → 主进程日志出现动作
□ 不碰用户运行中的实例；测试实例全部清理干净
□ 版本号一致（package.json / after-pack.js / 窗口标题）
□ 提交并推送 main；小版本不建 tag
```

---

## 使用说明

1. 复制上面整块提示词
2. 替换【本次任务】里的描述（一句话说清要改什么）
3. 发给 AI，让它按"交付前检查清单"完成后截图给你确认

## 常见任务速查

| 任务 | 一句话 |
|---|---|
| 加菜单项 | "帮助菜单 helpmenu.html 增加 X 项，main.js hm:action 加对应分支" |
| 改标题栏样式 | "titlebar.html 的 CSS 变量（深色/浅色两套），保持 36px 高度" |
| 发大版本 | "版本号改 1.2.0，commit 后 git tag v1.2.0 && git push origin v1.2.0，等 Actions 完成" |
| 本地小版本 | "版本号 +0.0.1，本地打包（卡住就杀进程重试或走 Actions），不建 tag 不发布" |
