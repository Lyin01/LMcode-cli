<p align="center">
  <img width="807" height="152" alt="LMcode" src="https://github.com/user-attachments/assets/b589a9a5-ad1e-420a-aee0-f86c7ee06873" />
</p>

<p align="center">
  <strong>LMcode — 你的本地 AI Agent 助手</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@liumir/lmcode"><img src="https://img.shields.io/npm/v/@liumir/lmcode?style=flat-square&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@liumir/lmcode"><img src="https://img.shields.io/npm/dm/@liumir/lmcode?style=flat-square&logo=npm&logoColor=white" alt="npm downloads"></a>
  <a href="https://github.com/Lyin01/LMcode-cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Lyin01/LMcode-cli?style=flat-square" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.19.0-green?style=flat-square&logo=node.js&logoColor=white" alt="node version"></a>
  <a href="https://github.com/Lyin01/LMcode-cli"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="platform"></a>
</p>

---

LMcode 是一款专注于中文场景的 AI Agent 助手。说人话，它做事——写代码、改文件、查资料、做研报、清理电脑、搜全网信息，你只管说需求，剩下的交给它。完全本地运行，数据不出门。

---

## 快速上手

### 安装

前置条件：**Node.js >= 22.19.0** 和 **Git**。

```bash
# npm 安装（全平台通用，推荐）
npm install -g @liumir/lmcode
```

macOS / Linux 也支持一键安装：

```bash
curl -fsSL https://raw.githubusercontent.com/Lyin01/LMcode-cli/main/install.sh | bash
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Lyin01/LMcode-cli/main/install.ps1 | iex
```

安装完成后，`lm` 命令自动加入 PATH。

### 首次启动

```bash
lm
```

首次启动会自动进入配置向导，选择模型商（DeepSeek、OpenAI、Anthropic、通义千问、硅基流动等）并输入 API Key 即可开始。支持随时添加多模型，用 `/model` 命令切换。

### 一次性使用

```bash
lm "用 Python 写一个 Markdown 转 HTML 的脚本"
lm -p "解释这段代码" --output-format stream-json
```

---

## 核心特性

| 特性 | 说明 |
|------|------|
| 🎯 **Goal 自主循环** | 设定目标后自动多轮迭代执行，内置裁判 Agent 独立裁决目标是否达成。支持轮次/Token/时间预算控制 |
| 🐺 **Wolfpack 群狼模式** | 无限并发多 Agent 协同，自动拆解任务并行执行。内置 coder / explore / plan / verify / writer 五类子 Agent |
| 🧠 **永久记忆** | 跨会话记忆系统，Tag 语义 + 向量双重检索，越用越懂你的项目上下文。支持 dream 自动整理 |
| 💭 **思考模式** | 完整的 Thinking 交互体验——独立渲染区域、流式打字、6 档思考强度、展开/折叠控制，支持 Anthropic Adaptive Thinking |
| 🔌 **MCP 扩展** | 内置浏览器自动化、桌面控制 MCP，支持自行添加任意 MCP Server |
| 🎨 **技能中心** | 可下载/安装技能（Skill），扩展 Agent 能力 |
| 📱 **cc-connect** | 打通微信、飞书、企微、钉钉、QQ、Telegram 等平台，远程聊天控制 LMcode |
| 🔒 **权限引擎** | 精细控制读/写/执行权限，敏感文件默认保护。支持 yolo / auto / manual 三种模式 |

### 内置工具一览

| 工具 | 说明 |
|------|------|
| `Read` | 读取文件内容，支持分页 |
| `Write` | 写入文件，自动创建父目录 |
| `Edit` | 精确字符串替换编辑 |
| `MultiEdit` | 同一文件批量原子替换，任一失败整批回滚 |
| `Glob` | 文件搜索，支持花括号展开 `*.{ts,tsx}` |
| `Grep` | 内容搜索，支持正则 |
| `Bash` | 执行命令，支持后台任务 |
| `WebSearch` / `FetchURL` | 联网搜索与页面抓取 |
| `Agent` | 启动子 Agent 处理子任务，支持并行和后台 |
| `WolfPack` | 批量并行启动多个子 Agent |

---

## 命令参考

```bash
lm [options] [command] [prompt...]

命令：
  export              导出 Markdown 格式的会话记录
  stream-json         以 JSON 流模式运行（适合程序化调用）
  cc-connect          配置远程聊天通道

选项：
  -V, --version       输出版本号
  -S, --session [id]  恢复会话。带 ID 直接恢复，不带 ID 交互选择
  -C, --continue      继续当前目录的上一个会话
  -y, --yolo          自动批准所有操作
  --auto              自动权限模式
  -m, --model <name>  指定模型别名
  -p, --prompt [text] 非交互模式，提示文本也可放在末尾位置参数
  --output-format <format>  输出格式：text | stream-json
  --skills-dir <dir>  加载指定目录的技能
  --plan              以计划模式启动
  -h, --help          显示帮助
```

---

## 斜杠命令

在交互模式下，输入 `/` 可执行以下命令：

| 命令 | 说明 |
|------|------|
| `/goal` | 开启自主目标循环 |
| `/model` | 切换模型 / 管理多模型 |
| `/config` | 修改配置 |
| `/memory` | 打开记忆备忘录 |
| `/dream` | 整理和归档记忆 |
| `/sessions` | 浏览和恢复历史会话 |
| `/skills` | 管理技能 |
| `/update` | 检查并安装更新 |
| `/mode` | 切换权限模式（yolo / auto / manual） |
| `/thinking` | 控制思考模式开关 |
| `/cc-connect` | 配置远程聊天通道 |
| `/new` | 创建新会话 |
| `/export` | 导出当前会话 |

---

## 更新日志

### 🚀 v0.7.0

**新功能**
- **MultiEdit 批量编辑工具** — 一次调用对同一文件做多处原子替换，任一失败整批回滚
- **Glob 花括号展开** — `*.{ts,tsx}`、`{src,test}/**/*.ts` 一次匹配多模式，支持嵌套与转义

**修复 / 体验优化**
- **Write 自动创建父目录** — 写入不存在的目录自动 mkdir，消除二次往返
- **`-p` 参数顺序不再敏感** — `lm -p --output-format stream-json "..."` 任意顺序正确解析；裸文本 `lm "..."` 也可作为一次性提示

### 🚀 v0.6.0

**修复**
- **135 个 Windows 测试失败全部修复** — 覆盖路径归一化、SQLite EBUSY 清理、Hook 子进程、yolo 权限迁移等 10 类问题
- **Hook 子进程弹窗** — `spawn()` 添加 `windowsHide: true`，根治每次跑 hook 弹 conhost 窗口
- **品牌重命名遗留引用** — 218 处 scream → lmcode 全面覆盖

**性能优化**
- **linkedom / nunjucks 懒加载** — 避免静态打包 2MB+ 依赖，降低启动时间
- **系统提示词精简** — AGENTS.md 改为路径列表按需读取，移除冗余通用指令
- **embedding 存储优化** — JSON 字符串改为二进制 Float32Array Buffer
- **FTS 空结果回退优化** — 先前缀通配符再全表扫描

**清理**
- 安装脚本 `scream` → `lm` 命令修正
- 移除 migration 残留代码
- 添加 `.nvmrc`，配置简单 git hooks

### 🚀 v0.5.15

- Ctrl+A 全选输入框内容
- ROLE_ADDITIONAL 移至 system 提示词末尾
- Windows 测试基础设施全面修复

---

## 项目说明

LMcode 是基于个人使用习惯和对 Agent 系统的理解，从零搭建的一套工具型 Agent 框架。经历 Rust 原型膨胀的教训后，彻底转向 TypeScript，核心聚焦三件事：**并行调度 + 状态机 + 记忆系统的收敛设计**。整体架构借鉴了 Agent harness 的思路，吸收了多个开源项目的设计取舍。

项目的演进方向是成为一个稳定、高效、轻量的 Agent 底座——不追求功能堆叠，而是让每个机制都能在实际使用中站住脚。

> LMcode 基于 [Scream Code](https://github.com/LIUTod/scream-code) 二次开发，感谢原作者 [LIUTod](https://github.com/LIUTod) 的开源工作。

---

## License

MIT
