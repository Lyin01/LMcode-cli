<p align="center">
  <img width="112" height="112" alt="LMcode" src="assets/logo.svg" />
</p>

<h1 align="center">LMcode</h1>

<p align="center">
  面向中文工作流的终端 AI Agent。让模型真正进入你的项目：读代码、改文件、跑命令、查资料、拆任务，并把过程沉淀成可恢复的会话。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@liumir/lmcode"><img src="https://img.shields.io/npm/v/@liumir/lmcode?style=flat-square&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@liumir/lmcode"><img src="https://img.shields.io/npm/dm/@liumir/lmcode?style=flat-square&logo=npm&logoColor=white" alt="npm downloads"></a>
  <a href="https://github.com/Lyin01/LMcode-cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Lyin01/LMcode-cli?style=flat-square" alt="license"></a>
  <a href="https://github.com/Lyin01/LMcode-cli/stargazers"><img src="https://img.shields.io/github/stars/Lyin01/LMcode-cli?style=flat-square&logo=github" alt="stars"></a>
  <a href="https://github.com/Lyin01/LMcode-cli/issues"><img src="https://img.shields.io/github/issues/Lyin01/LMcode-cli?style=flat-square&logo=github" alt="issues"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.19.0-green?style=flat-square&logo=node.js&logoColor=white" alt="node version"></a>
  <a href="https://github.com/Lyin01/LMcode-cli"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="platform"></a>
</p>

---

## 为什么做 LMcode

很多 AI 编程工具把重点放在聊天框上，LMcode 更关心另一件事：**让一次需求变成一串可追踪、可中断、可继续、可验证的动作**。

它不是只会回答问题的助手，而是一个运行在你终端里的 Agent 运行时：

- 面向真实项目：能读取文件、编辑代码、执行命令、搜索内容、调用外部工具。
- 面向长任务：支持计划模式、目标循环、后台任务、子 Agent 并行和会话恢复。
- 面向个人工作流：支持中文提示、跨会话记忆、技能扩展、MCP 服务和多模型切换。
- 本地优先：工具执行、文件操作、会话记录默认在本机；远程模型、联网搜索和外部 MCP 会按你的配置向对应服务发起请求。

## 适合做什么

- 维护代码库：定位问题、补测试、重构模块、生成说明文档。
- 执行研究任务：查资料、整理来源、生成结构化报告。
- 处理本地文件：批量修改、格式转换、清理项目、生成脚本。
- 驱动复杂流程：把一个目标拆成多轮执行，让 Agent 自己推进、验证和收尾。
- 扩展到外部工具：通过 MCP、Skill 和 cc-connect 接入浏览器、桌面自动化或聊天平台。

## 快速开始

### 1. 安装

需要 **Node.js >= 22.19.0** 和 **Git**。

```bash
npm install -g @liumir/lmcode
```

macOS / Linux 也可以使用安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/Lyin01/LMcode-cli/main/install.sh | bash
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Lyin01/LMcode-cli/main/install.ps1 | iex
```

### 2. 启动

```bash
lm
```

首次启动会进入配置向导。选择模型提供商、填入 API Key 后即可开始；之后可以用 `/model` 随时切换模型。

### 3. 一次性运行

```bash
lm "帮我检查这个项目的主要风险"
lm -p "解释这段代码" --output-format stream-json
```

## 核心体验

### Goal：让任务自己往前走

用 `/goal` 设置一个明确目标后，LMcode 会持续推进多轮执行，并在完成前做独立检查。适合修复一批问题、整理一个项目、完成一个跨文件功能。

```text
/goal 修复当前项目里影响发布的主要风险，并运行必要验证
```

### Wolfpack：多 Agent 并行协作

`/wolfpack` 会开启多子 Agent 协作模式。它适合大范围搜索、方案对比、并行验证这类任务。普通工具可自动执行；敏感文件、Git 控制路径和 cwd 外写入仍会优先触发确认，除非你显式进入 yolo 模式。

### Memory：把经验留在项目里

记忆系统会记录“试过什么、哪里失败、什么有效”，并在后续相似任务里按项目、标签和相关度检索。`/memory` 可浏览和注入记忆，`/dream` 可整理长期积累的备忘录。

### Thinking：可控的思考强度

支持 `off / low / medium / high / xhigh / max` 多档思考强度。不同模型能力不同，LMcode 会根据模型能力展示可用选项，让复杂任务可以多想一点，简单任务也能保持轻快。

### MCP / Skills：把 Agent 接到你的工具链

LMcode 支持 MCP Server、项目技能和个人技能目录。你可以接入浏览器自动化、桌面控制、内部服务、知识库或自定义工作流。

## 常用命令

```text
/config       配置模型提供商
/model        切换模型和思考强度
/permission   切换权限模式
/goal         创建、暂停、恢复目标
/wolfpack     开启或关闭多 Agent 协作
/sessions     恢复历史会话
/memory       浏览和注入记忆
/dream        整理长期记忆
/mcp          管理 MCP 服务
/plugin       管理插件
/cc           管理 cc-connect 守护进程
/cc-connect   配置聊天平台通道
/export       导出当前会话
/update       更新 LMcode
```

## 权限与数据边界

LMcode 默认不会假装“完全离线”。更准确的边界是：

- 文件读写、命令执行、会话记录、记忆数据默认在本机。
- 调用 OpenAI、Anthropic、DeepSeek、Gemini 或 OpenAI 兼容服务时，请求内容会发送给你配置的模型服务商。
- 使用 WebSearch、FetchURL、MCP Server 或 cc-connect 时，相关数据会进入对应外部工具或平台。
- `manual` 模式逐项确认，`auto` 模式自动批准低风险操作，`yolo` 模式适合你明确愿意放开权限的场景。
- 敏感文件、Git 控制路径、cwd 外写入等操作在普通自动模式下会被额外保护。

## Monorepo 结构

```text
apps/lmcode              CLI 和终端 UI，发布为 @liumir/lmcode
apps/lmcode-desktop      桌面端应用
packages/agent-core      Agent 运行时、工具、权限、MCP、会话和目标循环
packages/ltod            多供应商 LLM 流式客户端
packages/node-sdk        面向应用层的 TypeScript SDK
packages/jian            文件系统、进程和执行环境抽象
packages/memory          跨会话记忆存储与评分
packages/config          配置、身份标识和模型别名
```

开发常用命令：

```bash
pnpm install
pnpm run dev:cli
pnpm run typecheck
pnpm run test
pnpm run build
```

## 致谢

LMcode 基于 [Scream Code](https://github.com/LIUTod/scream-code) 二次开发，感谢原作者 [LIUTod](https://github.com/LIUTod) 的开源工作。

## License

[MIT](LICENSE) © [Lyin01](https://github.com/Lyin01)
