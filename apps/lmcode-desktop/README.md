# LMCODE Desktop

LMCODE 的 Electron 桌面客户端。它复用 `@lmcode-cli/lmcode-sdk` 运行 Agent，会话、目标、审批、MCP、记忆和后台任务与 CLI/TUI 使用同一套核心能力。

## 0.7.19

手机扫码直连：顶栏新增二维码按钮（菜单 **文件 → 远程连接（手机扫码）…**），点开即弹配对二维码，服务未开启时在弹窗里一步启用。扫码打开的是桌面端内置的远程页面（纯静态资源，构建到 `out/remote-app`，由远程服务以 CSP + no-store 托管），无需安装任何 App：手机可浏览会话、查看流式输出、发送消息与运行中转向、停止生成、审批工具调用、回答结构化提问，断线自动重连并在重连后重新同步会话与对话。配对二维码与地址列表改为优先真实局域网网卡——VPN 等虚拟网卡（如 aTrust 的 `2.0.0.1`）不再抢占第一地址；端口、令牌轮换与开关仍在设置 →「局域网远程」中管理。

## 0.7.18

审查修复：远程 MCP 不再允许读取主机环境变量；修改 provider/服务 baseUrl 时不再静默复用已存密钥，需重新输入凭据；没有可压缩前缀的阻塞压缩不再失败整轮请求；无扩展名路径不再能被 `openPath` 一键执行；IPC 监听器与主进程补上异常兜底；停用 MCP 服务器不再被在途启动覆盖状态；崩溃恢复不再丢弃未消费的 steer；流式重试时 TUI/桌面不再叠加两次尝试的文本。

## 0.7.17

GLM-5.3-flash 思考过长修复：默认不再把「中」打成 GLM 的 high/max，思考把输出预算吃光时会续跑一次写出答案或工具调用，而不是红字「回合失败」。

## 0.7.16

审查修复：FetchURL 不再把 `fda.gov` 当成内网，并拦截 IPv4-mapped 回环/元数据。blobref 只接受 64 位 hex。`workspace-write` 会拒绝 Bash/WolfPack。Windows Glob 大小写不敏感；LSP/MCP 子进程不再继承 API Key。远程 WS 校验 JSON、按 IP 限流，并拒绝环回/私网 MCP。关闭中的 Session 不会被 resume 复用；窗口关掉也不拆远程还在用的审批 handler。删掉的会话不会被过期的 `listSessions` 救活。对话超过 60 条会钉在底部虚拟化；历史加载不再闪欢迎页。Windows 上 `C:\` 与 `C:/` 视为同一项目，Markdown 盘符/`file:` 链接可以打开。

## 0.7.14

审查修复：扩展里的 stdio MCP 会按空格拆命令和参数，不再把 `npx -y @foo/mcp` 当成一个可执行文件。流式工具参数与文本一样批处理；停止后队列不再假装会自动发送；重新生成会带上附件。远程未鉴权帧有大小上限，关闭时拆掉残留连接。Git 丢弃不再跟着仓库外的 symlink，选文件夹/另存为也不再吃 UNC。剩余写操作 IPC 补上 schema。

## 0.7.13

审查修复 + 回合失败：对话里的 `.js` / `.url` / UNC 不再一键执行；外链只走无凭据的 HTTPS。远程换令牌会踢掉旧连接，新建会话强制手动权限，不能再改 providers。压缩或流式丢了 `step.begin` 时不再把整轮打成「Received content_part for unknown step_uuid」。扩展加载失败、历史加载失败、停止后队列和斜杠全局 Enter 也一起收了。

## 0.7.12

第四轮运行时自迭代：给剩余写操作 IPC 补上 schema（整库暂存的布尔、undo 计数、setConfig、终端写入等）。Git 审查把「找不到 Git」和 diff 失败从干净/非仓库空态里拆出来。设置里 MCP/记忆加载失败不再画成「暂无」。资源管理器复制文件不再把路径再贴进输入框。连续 `turn.started` 不再堆空气泡。项目终端去掉 `powershell -Command -`。

## 0.7.11

第三轮运行时自迭代：斜杠面板确认拼音不再误跑命令；审批/提问只跟当前会话；停止/删除/关闭期间禁止再 resume，未激活会话的停止是空操作。Composer 和排队发送共用一把锁。空 API key 不再覆盖已存密钥。带 cron 的会话启动会重试，未知会话事件先停在后台。Windows 设置 AUMID，没有托盘图标时不再空托盘驻留。

## 0.7.10

第二轮运行时自迭代：远程配对令牌不能再通过 `sessions.create` 选任意目录、`mcp.add` stdio、`config.set` hooks/yolo 或远程 `yolo` 权限变成本机执行面。对话里的可执行/脚本路径不再走 `shell.openPath`；`e.g.` 一类缩写不再被当成文件芯片。停止生成会停住排队消息而不是立刻发下一条；流式过程中的 `/compact` `/revoke` 等会先被拦住。历史回填与实时消息按内容重叠去重，卡顿心跳接到对话区，其余输入框补上输入法确认键保护。

## 0.7.9

设置页自迭代：远程连接接回真实配对面板（令牌 / 局域网地址 / 二维码 / 端口），扩展页展示真实 MCP 状态与技能并入口到扩展管理，权限模式写入应用级偏好，IPC 参数 schema 真正接到主进程边界。去掉过期的 `v0.6.13` / Enterprise 文案。同时修了中文输入法误发送、停止/关闭与会话恢复竞态、未鉴权远程套接字旁路、Git 状态失败被画成干净工作区、以及 Task 工具被标成 Todo 的问题。

## 当前能力

- 项目优先：通过系统目录选择器打开项目，会话按工作目录分组，不会自动创建无项目的空会话。
- 完整会话流：创建、恢复、重命名、删除、导出、历史重放、模型/思考等级/权限切换。
- 对话控制：消息排队、队列编辑与排序、运行中转向、取消生成、审批和结构化提问。
- 多模态附件：支持选择、拖放或直接粘贴截图；文本文件以附件卡片发送，PNG、JPEG、GIF、WebP 图片通过模型多模态输入发送。
- Agent 工作流：`/goal`、`/plan`、`/compact`、`/revoke` 等斜杠命令，实时子 Agent 状态、停止与转向，后台任务恢复。
- 项目工具：Codex 式代码审查（未暂存/已暂存范围、双侧行号、逐文件/逐 hunk 暂存与撤销、行内评论回填对话）、Git 提交、worktree 创建或接力、项目终端。
- 自动化：在当前会话中创建、查看和删除 Cron 任务；桌面端运行时会自动恢复包含计划任务的持久化会话。
- 生态能力：Skills、MCP、记忆浏览与搜索、系统托盘和桌面通知。
- 远程连接：顶栏**二维码图标**（或菜单 **文件 → 远程连接（手机扫码）…**）一键弹出配对二维码，手机扫码即连——页面由桌面端自身通过 HTTP 托管，打开后自动配对，无需安装任何 App；支持局域网直连与 Tailscale/ngrok/frp 公网穿透。手机端可浏览会话、对话与转向、停止生成、审批工具调用、回答结构化提问；远程暴露面刻意收窄（无文件读写、无项目终端、无 Git 写操作、无应用退出）。
- 秒退（0.3.4+）：退出时跳过逐会话的退出记忆提取（LLM 调用，单次最多 30s），关闭即时完成；记忆仍由压缩时提取和空闲 15 分钟提取保留。SDK 侧体现为 `LmcodeHarness.close({ extractMemories: false })`，CLI/TUI 的默认提取行为不变。

## 关键边界

- 渲染进程启用 Chromium sandbox 与 `contextIsolation`，不直接访问 Node.js；所有系统能力通过类型化 preload API 进入主进程。
- Git 命令使用参数数组执行，不经过 shell 拼接；worktree 接力只接受 Git 已登记的路径。
- 文本附件最大 256 KiB；图片附件单个最大 10 MiB，每条消息最多 8 个附件。凭据文件、未知二进制和非法 UTF-8 内容会被拒绝。
- 项目终端是会话级持久 PowerShell 进程，适合项目命令和连续工作流；它不是完整 PTY 终端模拟器。
- Cron 自动化依赖桌面应用正在运行，可以最小化到托盘；应用完全退出后不会在系统后台独立触发。
- 远程服务默认关闭，仅在设置中手动开启；令牌 32 字节随机、重新生成后旧令牌立即失效；手机页面是纯静态资源（不含任何机密，令牌只经 URL fragment / 本地存储传递），静态响应带 `no-store` 与 CSP，且服务只读取构建目录内的文件。远程暴露面刻意收窄（无文件读写、无项目终端、无 Git 写操作、无应用退出）。

## 远程连接（手机扫码）

1. 点击顶栏的**二维码图标**（或菜单 **文件 → 远程连接（手机扫码）…**）：弹窗直接显示配对二维码；若服务尚未开启，点一次「开启并显示二维码」即可。
2. 用手机相机扫描二维码：页面由桌面端自身提供（`http://<局域网IP>:端口/#token=…`），打开后**自动配对**，无需安装任何 App。
3. 扫码不便时：在手机浏览器打开**局域网地址**，把**配对令牌**粘贴到页面里即可。令牌只保存在手机本地，页面打开后地址栏里的 `#token` 会立即被抹掉。
4. 外网连接：用 Tailscale / `ngrok http 37991` / frp 把端口映射到公网，再用手机打开映射后的地址（把带 `#token` 的链接换成对应域名即可自动配对）。

手机端可以浏览会话（按项目分组、新建会话）、查看历史与流式输出、发送消息与运行中转向、停止生成、审批工具调用、回答结构化提问；断线会自动重连，重连后重新拉取会话与当前对话。端口、令牌轮换与开关的完整管理在 **设置 → 局域网远程**。

实现：远程服务层位于 `src/main/remote/`（`interaction-hub` / `remote-bridge` / `remote-manager` / `remote-server` / `remote-web`），协议定义在 `src/shared/remote-types.ts`。手机页面源码在 `src/remote-app/`，构建时打包到 `out/remote-app/`（`app.js` + `index.html` + `app.css`），由 `RemoteServer` 在 `/` 上托管（`no-store`、CSP、路径越界防护）。

协议是纯 WebSocket JSON：第三方客户端只要实现 `auth` → `request/response` → `event/approval/question` 即可接入，桌面端不依赖任何外部客户端。

## 技术栈

- Electron 43
- React 19、TypeScript、Tailwind CSS v4
- Zustand
- esbuild（主进程与 preload）+ Vite（渲染进程）
- Vitest

## 目录结构

```text
apps/lmcode-desktop/
├── scripts/                 # 构建脚本
├── src/
│   ├── main/                # 窗口、托盘、SDK 生命周期和系统能力
│   │   └── ipc/handler.ts   # 类型化 IPC 处理器
│   ├── preload/             # contextBridge 安全桥
│   ├── renderer/            # React UI、hooks 和 Zustand stores
│   ├── remote-app/          # 内置手机页面（由远程服务托管，构建到 out/remote-app）
│   └── shared/              # 主进程/渲染进程共享协议类型
├── test/                    # IPC、状态转换和安全边界测试
├── out/                     # 生成的构建产物，请勿手工修改
└── vite.renderer.config.ts
```

## 开发与验证

从仓库根目录安装依赖并先构建 workspace 包：

```powershell
pnpm install
pnpm run build:packages
pnpm --dir apps/lmcode-desktop run build
pnpm --dir apps/lmcode-desktop run start
```

集中验证桌面端：

```powershell
pnpm --dir apps/lmcode-desktop run typecheck
pnpm --dir apps/lmcode-desktop run test
pnpm --dir apps/lmcode-desktop run build
```

Windows 安装包：

```powershell
pnpm --dir apps/lmcode-desktop run build:win
```

## 发布

安装包与 `latest.yml` 发布到独立的 `Lyin01/LMcode-desktop` 仓库（与 CLI 发布线隔离，auto-updater 从该仓库的 latest release 拉取更新）。该仓库仅托管构建产物，其 tag 均指向同一占位提交，不与源码仓库的提交对应。

```powershell
# 交互式输入 GitHub Token 后打包发布（token 不落盘）
apps/lmcode-desktop/发布.bat
```

已知问题：electron-builder 在上传资产之间可能重复创建 release 并因 422 `already_exists` 中断，导致资产不全。此时删除残缺 release（`gh release delete <tag> --repo Lyin01/LMcode-desktop --cleanup-tag`）重跑，或用 `gh release upload` 手动补齐缺失资产——注意 `latest.yml` 必须与本次安装包的 sha512 / size 一致。

`build` 会先生成主进程、preload、渲染进程和内置手机页面（`out/remote-app`）产物，并将运行时需要的 workspace 包复制到 `out/vendor`。源码修改应始终发生在 `src/` 或 workspace 包中。

## 架构

```text
React renderer
      │ typed contextBridge API
      ▼
Electron main ── @lmcode-cli/lmcode-sdk ── agent-core
      │                                      │
      ├─ Git / worktree / terminal           ├─ sessions / goals / compaction
      └─ tray / notifications / files        └─ tools / MCP / memory / cron
```

主进程持有 `LmcodeHarness` 和活动 `Session`；核心事件经 IPC 投影到 Zustand，再由 React 渲染。恢复会话和切换项目会重新同步状态、历史、后台任务与子 Agent，而不是依赖渲染进程的临时缓存。
