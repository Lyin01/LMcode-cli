# LMCODE Desktop

LMCODE 的 Electron 桌面客户端。它复用 `@lmcode-cli/lmcode-sdk` 运行 Agent，会话、目标、审批、MCP、记忆和后台任务与 CLI/TUI 使用同一套核心能力。

## 当前能力

- 项目优先：通过系统目录选择器打开项目，会话按工作目录分组，不会自动创建无项目的空会话。
- 完整会话流：创建、恢复、重命名、删除、导出、历史重放、模型/思考等级/权限切换。
- 对话控制：消息排队、队列编辑与排序、运行中转向、取消生成、审批和结构化提问。
- 多模态附件：支持选择、拖放或直接粘贴截图；文本文件以附件卡片发送，PNG、JPEG、GIF、WebP 图片通过模型多模态输入发送。
- Agent 工作流：`/goal`、`/plan`、`/compact`、`/revoke` 等斜杠命令，实时子 Agent 状态、停止与转向，后台任务恢复。
- 项目工具：Codex 式代码审查（未暂存/已暂存范围、双侧行号、逐文件/逐 hunk 暂存与撤销、行内评论回填对话）、Git 提交、worktree 创建或接力、项目终端。
- 自动化：在当前会话中创建、查看和删除 Cron 任务；桌面端运行时会自动恢复包含计划任务的持久化会话。
- 生态能力：Skills、MCP、记忆浏览与搜索、系统托盘和桌面通知。
- 远程连接（0.6.8+）：设置 →「远程连接」开启后，手机/其他电脑/浏览器可通过配对令牌远程连接（对话、审批、提问、目标、自动化、任务、技能、MCP、配置与记忆）；支持局域网直连与 Tailscale/ngrok/frp 公网穿透。
- 秒退（0.3.4+）：退出时跳过逐会话的退出记忆提取（LLM 调用，单次最多 30s），关闭即时完成；记忆仍由压缩时提取和空闲 15 分钟提取保留。SDK 侧体现为 `LmcodeHarness.close({ extractMemories: false })`，CLI/TUI 的默认提取行为不变。

## 关键边界

- 渲染进程启用 Chromium sandbox 与 `contextIsolation`，不直接访问 Node.js；所有系统能力通过类型化 preload API 进入主进程。
- Git 命令使用参数数组执行，不经过 shell 拼接；worktree 接力只接受 Git 已登记的路径。
- 文本附件最大 256 KiB；图片附件单个最大 10 MiB，每条消息最多 8 个附件。凭据文件、未知二进制和非法 UTF-8 内容会被拒绝。
- 项目终端是会话级持久 PowerShell 进程，适合项目命令和连续工作流；它不是完整 PTY 终端模拟器。
- Cron 自动化依赖桌面应用正在运行，可以最小化到托盘；应用完全退出后不会在系统后台独立触发。
- 远程服务默认关闭，仅在设置中手动开启；令牌 32 字节随机、重新生成后旧令牌立即失效；远程暴露面刻意收窄（无文件读写、无项目终端、无 Git 写操作、无应用退出）。

## 远程连接（lmcode app）

1. 设置（`Ctrl+,`）→ **远程连接** → 打开「允许远程连接」。
2. 复制**配对令牌**，记下**局域网地址**（如 `http://192.168.1.100:37991`）。
3. 用手机/浏览器打开 lmcode-remote-app（见 `E:\project from lmcode\lmcode-remote-app\README.md`），填入地址与令牌；也可扫描面板二维码直达（含令牌）。
4. 外网连接：用 Tailscale / `ngrok http 37991` / frp 把端口映射到公网，客户端填对应的 wss/ws 地址。

远程服务层实现位于 `src/main/remote/`（`interaction-hub` / `remote-bridge` / `remote-manager` / `remote-server`），协议定义在 `src/shared/remote-types.ts`（与 lmcode-remote-app 的 `src/protocol/types.ts` 单点同步）。

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

`build` 会先生成主进程、preload 和渲染进程产物，并将运行时需要的 workspace 包复制到 `out/vendor`。源码修改应始终发生在 `src/` 或 workspace 包中。

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
