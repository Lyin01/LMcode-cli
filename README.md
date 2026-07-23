<p align="center">
  <img width="112" height="112" alt="LMcode" src="assets/logo.svg" />
</p>

<h1 align="center">LMcode</h1>

<p align="center">
  一个运行在终端里的 AI Agent。我平时用它读代码、改文件、跑命令，也用它处理需要多轮推进的任务。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@liumir/lmcode"><img src="https://img.shields.io/npm/v/@liumir/lmcode?style=flat-square&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@liumir/lmcode"><img src="https://img.shields.io/npm/dm/@liumir/lmcode?style=flat-square&logo=npm&logoColor=white" alt="npm downloads"></a>
  <a href="https://github.com/Lyin01/LMcode-cli"><img src="https://img.shields.io/github/stars/Lyin01/LMcode-cli?style=flat-square" alt="GitHub stars"></a>
  <a href="https://github.com/Lyin01/LMcode-cli/commits/main"><img src="https://img.shields.io/github/last-commit/Lyin01/LMcode-cli?style=flat-square" alt="last commit"></a>
  <a href="https://github.com/Lyin01/LMcode-cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Lyin01/LMcode-cli?style=flat-square" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.19.0-green?style=flat-square&logo=node.js&logoColor=white" alt="node version"></a>
  <a href="https://github.com/Lyin01/LMcode-cli"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="platform"></a>
</p>

<p align="center">
  <a href="README.en.md">English</a> | <b>中文</b>
</p>

LMcode 的界面和默认交互以中文为主，模型服务可以自己配置，也可以在同一个 TUI 中切换。

这个项目目前是 `0.x`，由我个人维护。我会先拿它处理自己的项目，再决定哪些功能留下。版本升级时，配置格式和行为仍有可能调整。

## 安装

需要 [Node.js](https://nodejs.org/) `>= 22.19.0`。

```bash
npm install -g @liumir/lmcode
```

进入项目目录后运行：

```bash
cd your-project
lm
```

第一次启动后先运行 `/config`，选择模型服务和模型，再登录或填写 API Key。之后用 `/config` 增删配置，用 `/model` 切换模型。

## 怎么用

普通任务直接说清楚要改什么，以及完成后要跑哪些检查。例如：

```text
找出当前测试失败的原因，修好后运行相关测试。不要改无关文件。
```

LMcode 会在当前目录中读取文件、修改代码并执行命令。任务中途退出后，可以回到同一目录继续：

```bash
lm -C
```

也可以只跑一次，不进入交互界面：

```bash
lm "总结这个仓库的入口和模块边界"
lm -p "检查工作树里未提交的改动" --output-format stream-json
```

### 长任务和并行任务

`/goal` 适合需要连续跑多轮的工作。目标会保存在会话中，可以暂停、恢复或取消。

```text
/goal 修复影响发布的问题，补上必要测试并完成构建检查
```

`/wolfpack` 会让模型把适合并行的部分交给多个子 Agent。它对大范围搜索、交叉检查和互不依赖的修改比较有用；小任务通常没必要打开。

### 会话和记忆

每次交互都会保存为会话。`/sessions` 可以浏览和恢复历史会话，`/revoke` 可以撤回最近几轮。

Memory 记录的是做任务时留下的经验，例如走过的弯路、有效的做法和项目标签。用 `/memory` 查看现有记录；内置的 `/dream` Skill 用来整理长期积累的记忆。

### MCP、插件和 Skills

`/mcp` 管理 MCP Server，`/plugin` 管理插件。Skills 会从用户目录和项目目录中自动发现，也可以通过 `--skills-dir` 额外指定目录。

常用的 Skill 目录：

```text
~/.lmcode/skills
~/.agents/skills
<project>/.lmcode/skills
<project>/.agents/skills
```

## 常用入口

| 入口 | 用途 |
| --- | --- |
| `lm` | 打开交互界面 |
| `lm -C` | 继续当前目录最近一次会话 |
| `lm -S [id]` | 选择或直接恢复会话 |
| `lm --plan` | 以计划模式启动 |
| `lm --auto` | 自动批准普通操作，保留敏感路径保护 |
| `lm --yolo` | 显式使用 yolo 权限模式；当前版本启动时也默认使用该模式 |
| `/config` | 配置模型服务 |
| `/model` | 切换模型和思考强度 |
| `/permission` | 切换权限模式 |
| `/plan` | 开关计划模式 |
| `/goal` | 创建、查看、暂停或恢复目标 |
| `/wolfpack` | 开关多 Agent 并行模式 |
| `/sessions` | 浏览历史会话 |
| `/tasks` | 查看后台任务 |
| `/memory` | 搜索和注入记忆 |
| `/mcp` | 安装、停用或移除 MCP Server |
| `/plugin` | 浏览和管理插件 |
| `/help` | 查看完整命令和快捷键 |

命令行的完整选项以 `lm --help` 为准。

## 数据和权限

LMcode 不是离线工具。使用前需要知道数据会去哪里：

- 配置、会话、记忆和大部分运行记录默认保存在本机的 `~/.lmcode`；可以用 `LMCODE_HOME` 改到其他目录。
- 发给模型的提示、必要的文件内容和工具结果会进入你配置的模型服务。
- 调用联网搜索、URL 抓取、MCP 或 cc-connect 时，相关数据会发送给对应的外部服务。
- `manual` 按规则放行低风险操作，高风险或未命中规则的操作会询问确认；`auto` 自动批准未被前置规则拦截的调用，但敏感文件、Git 控制路径和当前目录外写入仍会询问；`yolo` 会绕过这些文件边界。
- 上述文件边界检查只覆盖声明了文件访问的内置文件工具（Read/Write/Edit/MultiEdit 等）。`Bash` 命令、MCP 工具和用户自定义工具不声明文件访问，`auto` 不会对其进行敏感路径/Git 控制路径/cwd 外写入检查——需要约束这些工具时，请使用 `manual` 或配置 deny 规则。

当前版本启动时默认是 `yolo`。希望保留更多确认时，进入 TUI 后先用 `/permission` 切到 `auto` 或 `manual`。

在重要仓库里使用前，建议先提交或暂存自己的改动。不要在不清楚任务内容时使用 `yolo`。

## 路线图

- **走向 v1.0**：稳定配置格式和公开的 CLI/SDK 接口。
- **v1.0 清理**：移除已弃用的 `migration-legacy` 包（该包 README 中有日落计划）。
- **桌面端**：`apps/lmcode-desktop` 已在 monorepo 中，正在开发。
- **生态**：覆盖更多模型服务，扩充插件和内置 Skills。

## 本地开发

仓库使用 pnpm workspace。开发环境需要 Git、Node.js `>= 22.19.0` 和 pnpm `>= 11.7.0 < 12`。

```bash
git clone https://github.com/Lyin01/LMcode-cli.git
cd LMcode-cli
corepack enable
pnpm install
pnpm run dev:cli
```

提交前常用的检查：

```bash
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
```

主要目录：

```text
apps/lmcode              CLI 和终端 UI，发布为 @liumir/lmcode
apps/lmcode-desktop      桌面端应用
packages/agent-core      Agent 运行时、工具、权限、会话、MCP 和目标循环
packages/ltod            多模型服务的流式客户端
packages/node-sdk        应用层使用的 TypeScript SDK
packages/jian            文件系统、进程和执行环境抽象
packages/memory          跨会话记忆存储与检索
packages/config          配置、身份标识和模型别名
```

代码约定和测试要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 项目来源

LMcode 最初从 [Scream Code](https://github.com/LIUTod/scream-code) 分支出来，现由 [Lyin01](https://github.com/Lyin01) 维护。感谢 [LIUTod](https://github.com/LIUTod) 的原始实现和开源工作。

## License

[MIT](LICENSE)
