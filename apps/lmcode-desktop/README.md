# LMCODE Desktop

LMCODE 的桌面客户端 —— AI Agent 图形界面。

## 技术栈

- **桌面壳**: Electron 35+
- **前端**: React 19 + TypeScript + Tailwind CSS v4
- **状态管理**: Zustand
- **构建**: esbuild (主进程) + Vite (渲染进程)
- **图标**: Lucide React
- **UI**: Radix UI 原语组件

## 目录结构

```
apps/lmcode-desktop/
├── src/
│   ├── main/           # Electron 主进程
│   │   ├── index.ts    # 入口（窗口/托盘/快捷键/通知）
│   │   └── ipc/
│   │       └── handler.ts  # 所有 IPC 通道（20+ channel）
│   ├── preload/        # 预加载脚本
│   │   └── index.ts    # lmcodeAPI 安全桥接
│   └── renderer/       # React 前端
│       ├── components/ # UI 组件
│       │   ├── ChatPanel, MessageList, MessageItem, InputArea
│       │   ├── Sidebar, StatusBar, SettingsPanel
│       │   ├── ModelSwitcher, SlashCommandsDialog
│       │   ├── MemoryBrowser, TasksPanel
│       │   ├── ThinkingBlock, ToolCallBlock
│       │   └── dialogs/ (Approval, Question)
│       ├── stores/     # Zustand 状态 (session, config, task)
│       ├── hooks/      # 自定义 Hooks (useSession, useEvents)
│       ├── types/      # TypeScript 类型
│       └── styles/     # Tailwind + CSS 变量
├── out/                # 构建产出
├── vite.renderer.config.ts
├── electron-builder.yml
└── package.json
```

## 开发

### 首次运行

```bash
# 1. 从项目根目录安装依赖
cd E:\project for cc\lmcode
pnpm install

# 2. 构建所有 workspace 包
pnpm run build:packages

# 3. 构建 desktop 应用
cd apps/lmcode-desktop
pnpm run build

# 4. 启动
pnpm run start
```

> ⚠️ **注意**：workspace 包（`@lmcode-cli/*`）使用 TypeScript 源码 `#/` 路径导入，
> esbuild 构建时需通过 `--external` 外部化。运行时通过 pnpm workspace 解析。
> 确保先执行 `pnpm run build:packages` 编译 workspace 包为 JS。

### 构建命令

```bash
pnpm run build       # 完整构建（main + preload + renderer）
pnpm run start       # 启动 Electron
pnpm run build:win   # 打包为 Windows 安装程序 (.exe)
```

## IPC 通道列表

| Channel | 方向 | 用途 |
|---------|------|------|
| lmcode:createSession | invoke | 创建新会话 |
| lmcode:resumeSession | invoke | 恢复会话 |
| lmcode:renameSession | invoke | 重命名会话 |
| lmcode:deleteSession | invoke | 删除会话 |
| lmcode:listSessions | invoke | 列出所有会话 |
| lmcode:sendMessage | invoke | 发送消息 |
| lmcode:cancelResponse | invoke | 取消响应 |
| lmcode:setModel | invoke | 设置模型 |
| lmcode:setThinking | invoke | 设置思考级别 |
| lmcode:setPermission | invoke | 设置权限模式 |
| lmcode:closeSession | invoke | 关闭会话 |
| lmcode:getConfig | invoke | 获取配置 |
| lmcode:setConfig | invoke | 更新配置 |
| lmcode:getHomeDir | invoke | 获取家目录 |
| lmcode:listMemories | invoke | 列出记忆 |
| lmcode:searchMemories | invoke | 搜索记忆 |
| lmcode:deleteMemory | invoke | 删除记忆 |
| lmcode:exportSession | invoke | 导出会话 |
| lmcode:getVersion | invoke | 获取版本号 |
| lmcode:readFileContent | invoke | 读取文件内容 |
| lmcode:sessionEvent | send→on | 会话事件推送 |
| lmcode:approvalRequest | send→on | 审批请求 |
| lmcode:questionRequest | send→on | 提问请求 |
| lmcode:respondApproval | send | 审批响应 |
| lmcode:respondQuestion | send | 提问响应 |
| lmcode:quit | send | 退出应用 |

## 架构说明

### 进程模型
- **主进程**: 管理窗口、托盘、快捷键，运行 LmcodeHarness
- **渲染进程**: React UI，通过 contextBridge 安全 IPC 通信
- LMCODE 的 agent-core 包在主进程中运行，渲染进程零 Node.js 访问

### 事件驱动
agent-core 的 Event → 主进程 RPC → IPC 转发 → Zustand → React 渲染
