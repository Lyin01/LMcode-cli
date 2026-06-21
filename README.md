<p align="center">
  <img width="120" height="120" alt="LMcode" src="assets/logo.svg" />
</p>

<p align="center">
  <strong>LMcode — 你的本地 AI Agent 助手</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@liumir/lmcode"><img src="https://img.shields.io/npm/v/@liumir/lmcode?style=flat-square&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@liumir/lmcode"><img src="https://img.shields.io/npm/dm/@liumir/lmcode?style=flat-square&logo=npm&logoColor=white" alt="npm downloads"></a>
  <a href="https://github.com/Lyin01/LMcode-cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Lyin01/LMcode-cli?style=flat-square" alt="license"></a>
  <a href="https://github.com/Lyin01/LMcode-cli/stargazers"><img src="https://img.shields.io/github/stars/Lyin01/LMcode-cli?style=flat-square&logo=github" alt="stars"></a>
  <a href="https://github.com/Lyin01/LMcode-cli/network/members"><img src="https://img.shields.io/github/forks/Lyin01/LMcode-cli?style=flat-square&logo=github" alt="forks"></a>
  <a href="https://github.com/Lyin01/LMcode-cli/issues"><img src="https://img.shields.io/github/issues/Lyin01/LMcode-cli?style=flat-square&logo=github" alt="issues"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.19.0-green?style=flat-square&logo=node.js&logoColor=white" alt="node version"></a>
  <a href="https://github.com/Lyin01/LMcode-cli"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="platform"></a>
</p>

---

说人话，它做事。LMcode 是一款专注于中文场景的 AI Agent 助手——写代码、改文件、查资料、做研报、清理电脑、搜全网信息，你只管说需求，剩下的交给它。完全本地运行，数据不出门。

---

## 核心特性

<table>
  <tr>
    <td width="50%">
      <h3>🎯 Goal 自主循环</h3>
      <p>设定目标后自动多轮迭代执行，内置裁判 Agent 独立裁决目标是否达成。支持轮次/Token/时间预算控制。</p>
    </td>
    <td width="50%">
      <h3>🐺 Wolfpack 群狼模式</h3>
      <p>无限并发多 Agent 协同，自动拆解任务并行执行。内置 coder / explore / plan / verify / writer 五类子 Agent。</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🧠 永久记忆</h3>
      <p>跨会话记忆系统，Tag 语义 + 向量双重检索，越用越懂你的项目上下文。支持 dream 自动整理归档。</p>
    </td>
    <td width="50%">
      <h3>💭 思考模式</h3>
      <p>完整的 Thinking 交互体验——独立渲染区域、流式打字、6 档思考强度、展开/折叠控制，支持 Anthropic Adaptive Thinking。</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🔌 无限拓展</h3>
      <p>MCP Server / Skill 技能 / 模型商全部自由定义。内置浏览器自动化、桌面控制 MCP。支持 DeepSeek、OpenAI、Anthropic 等。</p>
    </td>
    <td width="50%">
      <h3>📱 多渠道互联</h3>
      <p>通过 cc-connect 打通微信、飞书、企微、钉钉、QQ、Telegram 等平台，远程聊天控制 LMcode。</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🛡️ 权限引擎</h3>
      <p>精细控制读/写/执行权限，敏感文件默认保护。支持 yolo / auto / manual 三种模式自由切换。</p>
    </td>
    <td width="50%">
      <h3>🔄 会话恢复</h3>
      <p>随时中断随时继续，对话历史自动保存。<code>/sessions</code> 浏览恢复历史会话，上下文不丢失。</p>
    </td>
  </tr>
</table>

---

## 快速上手

### 安装

前置条件：**Node.js >= 22.19.0** 和 **Git**。

```bash
# npm 安装（全平台通用，推荐）
npm install -g @liumir/lmcode
```

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/Lyin01/LMcode-cli/main/install.sh | bash
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Lyin01/LMcode-cli/main/install.ps1 | iex
```

### 启动

```bash
lm
```

首次启动自动进入配置向导，选择模型商并输入 API Key 即可开始。支持随时添加多模型，用 `/model` 命令切换。

### 一次性使用

```bash
lm "用 Python 写一个 Markdown 转 HTML 的脚本"
lm -p "解释这段代码" --output-format stream-json
```

---

## 思考模式

LMcode 的思考模式让模型在给出最终回答前先进行内部推理，大幅提升复杂任务的准确率。

在 `/model` 面板中用 **← → 键**循环切换 `off / low / medium / high / xhigh / max` 六档强度。思考过程独立渲染、实时流式打字、可展开/折叠，体验远优于基础透传方案。

---

## 内置工具

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
| `Agent` | 启动子 Agent，支持并行和后台 |
| `WolfPack` | 批量并行启动多个子 Agent |

---

## 斜杠命令

| 命令 | 说明 |
|------|------|
| `/goal` | 开启自主目标循环 |
| `/model` | 切换/管理多模型 |
| `/config` | 修改配置 |
| `/memory` | 打开记忆备忘录 |
| `/dream` | 整理归档记忆 |
| `/sessions` | 浏览恢复历史会话 |
| `/skills` | 管理技能 |
| `/mode` | 切换权限模式 |
| `/cc-connect` | 配置远程聊天通道 |
| `/update` | 检查安装更新 |
| `/export` | 导出会话 |

---

## 致谢

LMcode 基于 [Scream Code](https://github.com/LIUTod/scream-code) 二次开发，感谢原作者 [LIUTod](https://github.com/LIUTod) 的开源工作。

---

## 项目说明

最早用 Rust 写过一个原型，架构膨胀后彻底转向 TypeScript 重写。核心聚焦三件事：并行调度 + 状态机 + 记忆系统的收敛设计。整体架构借鉴了 Agent harness 的思路，吸收了多个开源项目的设计取舍。

项目的演进方向是成为一个稳定、高效、轻量的 Agent 底座——不追求功能堆叠，而是让每个机制都能在实际使用中站住脚。

---

## License

[MIT](LICENSE) © [Lyin01](https://github.com/Lyin01)
