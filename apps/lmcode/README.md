<img width="807" height="152" alt="image" src="https://github.com/user-attachments/assets/b589a9a5-ad1e-420a-aee0-f86c7ee06873" />


LMcode 是一款省心的中文 AI Agent 助手。无需硬记代码，完全本地部署运行，无任何远程行为，高安全，用户直接用中/英文下达指令，vibe coding、写代码、查论文、改文件、清理电脑、查资料、制作研报、搜全网信息……你动嘴，它动手！

---

## 三分钟上手

### 第一步：安装

前置条件：**Node.js >= 22.0.0** 和 **Git**。

> **国内用户**：安装过程需从 GitHub 下载，建议科学上网，如遇网络错误请多尝试几次。

**推荐：npm 安装（全平台通用）**

```bash
npm install -g @liumir/lmcode
```
**一键安装（macOS / Linux）**

```bash
curl -fsSL https://raw.githubusercontent.com/Lyin01/LMcode-cli/main/install.sh | bash
```

**Windows — PowerShell：**

```powershell
irm https://raw.githubusercontent.com/Lyin01/LMcode-cli/main/install.ps1 | iex
```

安装完成后，`lm` 命令自动加入 PATH。首次安装约需 2-5 分钟。

**升级到新版本**

```bash
cd ~/.lmcode && ./install.sh --upgrade
```

### 第二步：启动并配置 AI 服务

首次启动时，如果检测到没有配置模型，会自动进入交互式配置向导（`/config`）。按提示输入 API 地址、密钥、模型型号即可完成配置。

**支持多个模型**（配置好后可用 `/model` 随时切换）：

> 支持自定义 API（DeepSeek、OpenAI、Anthropic、MiniMax、通义千问、硅基流动等（`/config diy`）需要输入隐藏指令）。

配置完成后，在交互模式下输入 `/model` 即可切换模型或删除模型，无需重启。`/config` 支持追加配置。

### 审批面板

当它要修改文件或执行命令时，会弹出审批面板：

按数字键选择，回车确认。所有提示都是中文。

---

## 核心功能

- **对话式交互** —— 用自然语言描述需求，它自动写代码、改文件、跑命令
- **安全第一** —— 修改文件前必须征得同意，`.env` 等敏感文件默认禁止操作
- **权限引擎** —— 精细控制它能做什么（读取/写入/执行），防止误操作
- **状态机机制** —— 防漂移，强化任务颗粒度，不出错，任务完成度高，降低 Token 消耗
- **记忆备忘录** —— `/memory` 打开交互式记忆备忘录。定位为"任务经验记录"：记录用户需求、执行方案、最终结果、踩坑记录、成功经验。三种提取触发：压缩时自动提取、退出会话时提取、心跳自动沉淀。跨会话共享，知识库tag分级、Agent自行查阅，支持手动注入到当前会话。
- **dream** —— 输入`/dream` 定期整理重复和过时记录，注意，因记忆整理涉及删除，所以此功能在auto模式被设置为不可用，避免误删
- **目标系统** —— `/goal` 开启自主目标循环，设定目标后自动多轮迭代执行。支持 WriteGoalNote 工具，模型自主管理工作笔记（记录验证过的事实、踩过的坑、关键决策），笔记在每轮续跑时自动注入，跨轮不丢失，压缩不丢失。支持预算控制（轮次/Token/时间）
- **会话恢复** —— 随时中断，随时继续，对话历史自动保存，可通过 `/sessions` 浏览和恢复历史会话
- **多模式** —— 交互模式、静默模式、计划模式、后台任务模式，可选
- **MCP 扩展** —— 连接外部工具（数据库、浏览器、API 等）
- **多 Agent 并行模式** —— 复杂任务自动拆解为多个子 Agent 同时执行，内置 coder/explore/plan/verify/writer 五类子 Agent。支持多角度分析、对抗验证等并行编排模式。
- **技能中心** —— 内置多款技能可下载，用户也可以自行安装skill技能
- **MCP** —— 内置浏览器自动化MCP和电脑桌面自动化MCP（目前仅支持mac），另外可自行添加或下载使用自定MCP
- **wolfpack** —— 群狼模式，适合多文件多任务同时处理 拥有自动审批权限，建议执行审阅任务和协同工作时提前打开

---

## 🚀 v0.7.0 更新日志

### ✨ 新功能
- **MultiEdit 批量编辑工具** — 一次调用对同一文件做多处 find/replace，**原子生效**（任一处失败则整批不写、文件不动）。把原来 N 次 Edit 往返压成 1 次，明显提速并降低 token 消耗
- **Glob 支持花括号展开** — `*.{ts,tsx}`、`{src,test}/**/*.ts` 等一次调用即匹配所有分支（支持多组与嵌套、转义按字面），不再需要拆成多次调用

### 🐞 修复 / 体验
- **Write 自动创建父目录** — 写入到不存在的目录时自动 `mkdir -p`，消除「写入失败 → mkdir → 重写整个文件」的二次往返（大文件可省去约一倍输出 token）
- **`lm -p` 参数顺序不再敏感** — `--prompt` 改为可选值并支持末尾位置参数，`lm -p --output-format stream-json "..."` 等任意顺序都能正确解析；裸文本 `lm "..."` 也可作为一次性提示

---

## 🚀 v0.6.0 更新日志

### 🐞 修复
- **135 个 Windows 测试失败全部修复** — 覆盖路径归一化、SQLite EBUSY 清理、Hook 子进程、yolo 权限迁移、配置格式等 10 类问题
- **Hook 子进程在 Windows 上弹出 git 窗口** — `spawn()` 添加 `windowsHide: true`，根治每次跑 hook 弹 conhost 窗口
- **brand rename 遗留的 "scream" 引用** — 218 处 scream → lmcode 品牌重命名全覆盖

### ⚡ 性能优化
- **linkedom（2MB）和 nunjucks（1.8MB）懒加载** — 不再静态打包，仅在首次使用时动态 import，大幅降低启动时间
- **系统提示词精简** — AGENTS.md 改为路径列表按需读取（原 32KB 固定注入），移除冗余通用指令
- **embedding 存储优化** — JSON 字符串改为二进制 Float32Array Buffer
- **FTS 空结果回退优化** — 先尝试前缀通配符再全表扫描

### 🧹 清理
- **安装脚本修复** — `scream` → `lm` 命令创建正确
- **死代码清理** — 移除 migration 残留代码
- **CI 基础设施** — 添加 `.nvmrc`，配置简单 git hooks
- **文档修复** — tsconfig、README 等同步更新

### 🏗️ 架构
- **多注入器合并** — 所有 `beforeStep` 注入器合并为单条 `<system-reminder>` 复合消息
- **bundle 分割** — 移除 `alwaysBundle` 配置，产物自然分割（主入口仅 ~0.54kB）

---

## cc-connect 通过聊天远程控制 LMcode

- 支持微信、飞书、slack、钉钉、QQ、Telegram等，你可以在安装lmcode后一键安装cc-connect来控制你的 LMcode

###第一步：一键安装指令安装

```
# npm install -g cc-connect
```
###第二步：打开 LMcode，输入/cc-connect 按照提示选择你要接入的平台（配置完毕后不要再次配置，否则会覆盖原有配置）

###第三步：按照步骤完成配置与链接后，输入命令启动后台守护进程（关闭 LMcode 也可在后台聊天）

**提示：关于会话系统

- *远程聊天会话默认走cc标识注入会话管理系统，可通过斜杠命令进入进行管理和删除，也可以直接在电脑端直接继承会话继续让 LMcode 完成工作 

**提示：远程聊天快捷指令（已默认支持，飞书、微信等通道文件图片发送）

- /new             创建新会话
- /bind setup      开启文件传送功能，支持PDF、图片等
- /mode            查看可用模式
- /mode yolo       自动批准所有工具
- /mode default    每次工具调用前询问
---

## 🙏 致谢 Scream Code

**LMcode 是基于 [Scream Code](https://github.com/LIUTod/scream-code)（作者 [LIUTod](https://github.com/LIUTod)）的个人定制改版。** Scream Code 是一款出色的开源 AI Agent CLI，在此向 LIUTod 致以诚挚感谢。

### 与 Scream Code 的主要差异

| 项目 | Scream Code | LMcode |
|------|------------|--------|
| CLI 命令 | `scream` | `lm` |
| 默认权限 | `manual`（逐次审批） | `yolo`（自动批准） |
| 配置目录 | `~/.scream-code/` | `~/.lmcode/` |
| 品牌 | Scream Code | LMcode |

---

## 项目灵感与感谢支持

LMcode 是我基于自身使用习惯与对 Agent 系统的理解，从零重构的一套工具型 Agent 框架。最早用 Rust 写，架构膨胀得厉害，最后成屎山了。经历了教训之后，彻底转向 TypeScript，也顺便做了大量减法。
重构之后，我把精力集中在三件事上：并行调度和状态机 + 记忆系统的收敛设计 + 最大化释放模型本身的能力上。整体逻辑借鉴了 Agent harness 的思路，同时也参考了不少优秀开源项目的设计取舍与实现细节。现在的 LMcode 不再追求功能堆叠，而是一个能稳定、高效执行意图的轻量化 Agent 底座。

这个项目完全免费，开放使用，也欢迎反馈，并给出建议和改进。会持续根据实际使用场景继续打磨。

再次感谢其他优秀的项目给予灵感：gork codex、kimicli、Gemini、等优秀项目

---

## 入口

https://scream.chat

## Star History

<a href="https://www.star-history.com/?repos=Lyin01%2FLMcode-cli&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Lyin01/LMcode-cli&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Lyin01/LMcode-cli&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Lyin01/LMcode-cli&type=date&legend=top-left" />
 </picture>
</a>


## License

MIT
