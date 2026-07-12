<p align="center">
  <img width="112" height="112" alt="LMcode" src="https://raw.githubusercontent.com/Lyin01/LMcode-cli/main/assets/logo.svg" />
</p>

<h1 align="center">LMcode</h1>

<p align="center">
  一个运行在终端里的 AI Agent。用它读代码、改文件、跑命令，或者处理需要多轮推进的任务。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@liumir/lmcode"><img src="https://img.shields.io/npm/v/@liumir/lmcode?style=flat-square&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@liumir/lmcode"><img src="https://img.shields.io/npm/dm/@liumir/lmcode?style=flat-square&logo=npm&logoColor=white" alt="npm downloads"></a>
  <a href="https://github.com/Lyin01/LMcode-cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Lyin01/LMcode-cli?style=flat-square" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.19.0-green?style=flat-square&logo=node.js&logoColor=white" alt="node version"></a>
  <a href="https://github.com/Lyin01/LMcode-cli"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="platform"></a>
</p>

LMcode 的界面和默认交互以中文为主，模型服务可以自己配置。项目目前处于 `0.x`，由 [Lyin01](https://github.com/Lyin01) 个人维护。

## 安装

需要 [Node.js](https://nodejs.org/) `>= 22.19.0`。

```bash
npm install -g @liumir/lmcode
```

进入项目目录并启动：

```bash
cd your-project
lm
```

第一次启动后运行 `/config`，选择模型服务和模型，再登录或填写 API Key。之后用 `/model` 切换模型。

## 使用

交互界面里直接输入任务：

```text
找出当前测试失败的原因，修好后运行相关测试。不要改无关文件。
```

退出后可以继续当前目录最近一次会话：

```bash
lm -C
```

一次性运行：

```bash
lm "总结这个仓库的入口和模块边界"
lm -p "检查工作树里未提交的改动" --output-format stream-json
```

## 常用入口

| 入口 | 用途 |
| --- | --- |
| `/config` | 配置模型服务 |
| `/model` | 切换模型和思考强度 |
| `/permission` | 切换权限模式 |
| `/plan` | 开关计划模式 |
| `/goal` | 创建、查看、暂停或恢复长期目标 |
| `/wolfpack` | 开关多 Agent 并行模式 |
| `/sessions` | 浏览和恢复会话 |
| `/tasks` | 查看后台任务 |
| `/memory` | 搜索和注入任务记忆 |
| `/mcp` | 管理 MCP Server |
| `/plugin` | 浏览和管理插件 |
| `/help` | 查看完整命令和快捷键 |

`/goal` 用于连续推进多轮的任务，`/wolfpack` 用于可以并行拆分的工作。会话会保存在本机，`/sessions` 可以在之后恢复。Skills 会从 `~/.lmcode/skills`、`~/.agents/skills` 和项目内的同名目录自动发现。

## 数据和权限

LMcode 不是离线工具：

- 配置、会话、记忆和大部分运行记录默认保存在本机的 `~/.lmcode`；可以用 `LMCODE_HOME` 改到其他目录。
- 提示、必要的文件内容和工具结果会发送给你配置的模型服务。
- 联网搜索、URL 抓取、MCP 和 cc-connect 会把相关数据发送给对应的外部服务。
- `auto` 自动批准未被前置规则拦截的调用，但敏感文件、Git 控制路径和当前目录外写入仍会询问；`manual` 会保留更多确认；`yolo` 会绕过这些文件边界。

当前版本启动时默认是 `yolo`。希望保留更多确认时，进入 TUI 后先用 `/permission` 切到 `auto` 或 `manual`。在重要仓库里使用前，建议先提交或暂存自己的改动。

## 文档和源码

- [完整 README](https://github.com/Lyin01/LMcode-cli#readme)
- [源码](https://github.com/Lyin01/LMcode-cli)
- [问题反馈](https://github.com/Lyin01/LMcode-cli/issues)
- [参与开发](https://github.com/Lyin01/LMcode-cli/blob/main/CONTRIBUTING.md)

LMcode 最初从 [Scream Code](https://github.com/LIUTod/scream-code) 分支出来。感谢 [LIUTod](https://github.com/LIUTod) 的原始实现和开源工作。

## License

[MIT](https://github.com/Lyin01/LMcode-cli/blob/main/LICENSE)
