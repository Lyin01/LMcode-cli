# LMCODE Desktop

LMCODE 的 Electron 桌面客户端。它复用 `@lmcode-cli/lmcode-sdk` 运行 Agent，会话、目标、审批、MCP、记忆和后台任务与 CLI/TUI 使用同一套核心能力。

## 当前能力

- 项目优先：通过系统目录选择器打开项目，会话按工作目录分组，不会自动创建无项目的空会话。
- 完整会话流：创建、恢复、重命名、删除、导出、历史重放、模型/思考等级/权限切换。
- 对话控制：消息排队、队列编辑与排序、运行中转向、取消生成、审批和结构化提问。
- Agent 工作流：`/goal`、`/plan`、`/compact`、`/revoke` 等斜杠命令，实时子 Agent 状态、停止与转向，后台任务恢复。
- 项目工具：Git 变更与 diff、暂存/取消暂存/提交、worktree 创建或接力、项目终端。
- 自动化：在当前会话中创建、查看和删除 Cron 任务；桌面端运行时会自动恢复包含计划任务的持久化会话。
- 生态能力：Skills、MCP、记忆浏览与搜索、系统托盘和桌面通知。

## 关键边界

- 渲染进程启用 Chromium sandbox 与 `contextIsolation`，不直接访问 Node.js；所有系统能力通过类型化 preload API 进入主进程。
- Git 命令使用参数数组执行，不经过 shell 拼接；worktree 接力只接受 Git 已登记的路径。
- 文本附件最大 256 KiB，并拒绝二进制或非法 UTF-8 内容。
- 项目终端是会话级持久 PowerShell 进程，适合项目命令和连续工作流；它不是完整 PTY 终端模拟器。
- Cron 自动化依赖桌面应用正在运行，可以最小化到托盘；应用完全退出后不会在系统后台独立触发。

## 技术栈

- Electron 39
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
