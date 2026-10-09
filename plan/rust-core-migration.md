# Rust 核心迁移清单

日期：2026-10-09。对照时的提交是 `release/desktop-0.7.7` @ `0b0e158`。
`crates/`、根 `Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml` 当时都还是未跟踪文件。
本清单按源码逐项目录对照，不采用 `AGENTS.md` / `docs/RUST_TEST_MAPPING.md` 里「已经全部移植」的说法。那两份文档把子集实现写成了功能对齐。

目标：Rust 核心 + 现有 Electron 桌面界面做外壳。桌面通过稳定的 JSON-RPC 调用核心，方式参照 [Codex app-server](https://developers.openai.com/codex/app-server)（stdio 上的换行分隔 JSON，请求 / 响应 / 通知，审批走反向请求）。`packages/` 里的 TypeScript 在对应 Rust 路径通过测试并完成切换之前不删除。

状态词：

| 状态 | 含义 |
| --- | --- |
| 已有 | 工作区里有实现，并且旁边有针对该行为的 Rust 测试 |
| 部分 | 有代码，但相对 TS 缺行为、缺配置，或只覆盖一条窄路径 |
| 缺失 | `crates/` 里没有对应实现 |
| 壳层 | 留在 `apps/lmcode-desktop`，不进核心 |
| 不移植 | 有意留在 TS，或已弃用 |

本轮写清单时没有重跑 `cargo test --workspace`。下表里的「已有」只表示测试代码在树里，不表示本轮已经重新跑绿。

## 包到 crate

| TS | Rust | 总状态 |
| --- | --- | --- |
| `packages/liumir` | `crates/lmcode-llm` | 部分。六个 provider 都有流式实现和 e2e 测试，能力目录、catalog、工具结果里的图片折成下一条 user 消息还没有 |
| `packages/agent-core` | `crates/lmcode-core` + `crates/lmcode-mcp` | 部分。轮次、会话、一批工具在；权限链、注入器、电脑操作、插件、OAuth、hooks、records 不在 |
| `packages/memory` | `crates/lmcode-memory` | 部分。SQLite / 评分 / 向量 / 梦境 / 提取解析都在，压缩和退出会调用提取器。MemoryEdit 在 `lmcode-core` |
| `packages/config` | 没有独立 crate。身份头（device id、User-Agent）缺失。运行配置读在 `lmcode-core/src/config.rs` | 部分 |
| `packages/jian` | 没有 crate。Read / Write / Bash 直接打本机文件系统和进程 | 部分。没有可替换的执行环境，也没有沙箱实现 |
| `packages/node-sdk` | 没有。CLI 和 Tauri 直接链 `lmcode-core` | 缺失。这层就是要新做的 app-server |
| `packages/migration-legacy` | 无 | 不移植。包自己的 README 写了 v1.0 移除 |
| `packages/ltod` | 无 | 不移植。目录里只有 `dist/` 和 `node_modules/`，没有源码 |
| `apps/lmcode`（CLI / TUI） | `crates/lmcode-cli` + `crates/lmcode-tui` | 部分。CLI 选项面有契约测试；TUI 是另一套 ratatui，不是 TS 组件的逐个移植 |
| `apps/lmcode-desktop`（Electron + React，当前产品） | 不替换界面。`crates/lmcode-desktop` 是另一套 Tauri 壳，进程内调 core | 壳层仍绑着 `@lmcode-cli/lmcode-sdk` |

`crates/lmcode-desktop` 不能当成需求 3 的完成。需求 3 要留的是 `apps/lmcode-desktop` 的渲染层，主进程改成 JSON-RPC 客户端。

## `packages/liumir` → `lmcode-llm`

| TS | Rust | 状态 | 缺口 |
| --- | --- | --- | --- |
| `message.ts` / `generate.ts` / `provider.ts` / `tool.ts` / `usage.ts` / `sse`（在 provider 流里） | `message.rs` `generate.rs` `provider.rs` `tool.rs` `usage.rs` `sse.rs` | 已有 | 流式组装有单测 |
| `providers/openai.ts` + `openai-legacy.ts` + `chat-completions-stream.ts` | `providers/openai.rs` | 部分 | 文本、工具、媒体数组有测试。TS 会把 tool 消息里的图片折成紧随其后的 user 消息，否则 Chat Completions 会把截图降级成文本。Rust 这条路径没有 |
| `providers/anthropic.ts` | `providers/anthropic.rs` | 已有 | e2e |
| `providers/openai-responses.ts` | `providers/responses.rs` | 已有 | e2e |
| `providers/google-genai.ts` | `providers/genai.rs` | 已有 | thought / thoughtSignature、functionCall 有测试 |
| `providers/vertex.ts` | `providers/vertex.rs` | 已有 | 服务账号 JWT 有 e2e |
| `providers/lmcode.ts` + `lmcode-schema.ts` + `lmcode-files.ts` | `providers/lmcode.rs` | 已有 | schema 规范化与视频上传有测试 |
| `providers/capability-registry.ts` `capability.ts` `catalog.ts` `request-auth.ts` `tool-call-id.ts` | 无 | 缺失 | 模型能力声明、catalog 拉取在 `node-sdk/src/catalog.ts`，桌面设置面板在用 |
| `errors.ts` | `error.rs` | 部分 | 没有 TS 那套错误码表 |

## `packages/memory` → `lmcode-memory`

两边约定共用 `~/.lmcode/memory/memos.sqlite`。

| TS | Rust | 状态 | 缺口 |
| --- | --- | --- | --- |
| `models.ts` | `memo.rs` | 已有 | kind 三态、id 形状 |
| `store.ts` | `store.rs` | 已有 | CRUD（含按字段 `update`：只改给出的列，同一次事务删掉该条向量；FTS 仍由 TS 维护，Rust 更新后 TS 全文索引可能是旧文本）、列迁移、级联删除有单测 |
| `scoring.ts` | `scoring.rs` | 已有 | Jaccard + 衰减 + 项目 + 标签；有向量时 60/40 |
| `embeddings.ts` | `embeddings.rs` | 已有 | OpenAI 兼容接口默认；`local-embeddings` feature 才走 ONNX |
| `tags.ts` | `tags.rs` | 已有 | 小写、去重、上限 |
| `consolidator.ts` `dream.ts` | `consolidator.rs` `dream.rs` | 已有 | 计划与应用、DreamTracker |
| `extractor.ts` | `extractor.rs` | 已有 | 2026-10-09 移植并接到 Rust。全量压缩在摘要落盘后解析 `memory-memo`（来源保持 `compaction`，补上会话 id / 标题 / 项目目录；写入失败只发通知，不回滚摘要）。会话退出走 `extract_memories_on_exit`：短于 4 条跳过，快照指纹未变则跳过，采样最近 10 条加坑窗口，`extraction_source=exit`，只销掉本次提供且仍为 pending 的 id。缺省 tags 在内存里是空 `Vec`，写入 SQLite 时与 TS 的 `tags ?? []` 一样是 `[]`。没有 `utility_model`，退出提取用当前会话的 provider。没有 TS 那种飞行中合并；指纹代替 context revision |

## `packages/config`

| TS | Rust | 状态 | 缺口 |
| --- | --- | --- | --- |
| `identity.ts`（device id、默认头、User-Agent） | 无 | 缺失 | 桌面和网关请求在用 |
| `utils.ts` | 散落在各 crate | 部分 | 只有调用点需要的判断 |

运行时 `config.toml` 的读写在 agent-core，见下一节。磁盘格式是 snake_case，TS 读入后再转 camelCase。

## `packages/agent-core` → `lmcode-core` / `lmcode-mcp`

### 轮次、会话、配置

| TS | Rust | 状态 | 缺口 |
| --- | --- | --- | --- |
| `agent/turn` + `loop/run-turn.ts` `loop/turn-step.ts` | `agent.rs` 的 `run_turn` | 部分 | 有工具循环、取消、步数上限、用量累计。没有溢出后的 `chatWithRetry`、steer、spec-critic、visual auditor、anchored bootstrap、工具去重 |
| `loop/retry.ts` | 无 | 缺失 | 上下文溢出应立刻暴露给压缩，而不是重试三次 |
| `agent/compaction/*` | `compaction.rs` | 部分 | micro + full 有单测。触发比例、工作集上限、阻塞压缩超时、连续失败断路器没有按 TS 的 50% / 75% / 85% 和 `loop_control` 配齐 |
| `agent/context/*`（media-budget、projector、tool-output-limits） | 压缩投影里有一块 | 部分 | 工具图数量上限、媒体预算没有独立实现 |
| `agent/session-memory.ts` | `session_memory.rs` | 已有 | 压缩后注入有单测 |
| `session/store/*` | `session.rs` | 部分 | create / load / latest / list / save。没有 delete、rename、fork、metadata、undo |
| `session/export/*` | `lmcode-cli/src/export.rs` | 部分 | CLI 能打 ZIP。字段是否与 legacy manifest 逐字节一致，以 `docs/CLI_PARITY.md` 为准，本清单没有复跑 |
| `session/hooks/*` `session/git-context.ts` `session/subagent-host.ts` | 无 | 缺失 | 用户 hooks、git 上下文注入、子代理宿主 |
| `agent/records/*` `agent/replay/*` | 无独立事件日志 | 不移植为原样 | 目标语义是会话 JSON 能恢复 goal / cron / 消息。TS 的 record migration v1.1–v1.3 没有 Rust 版 |
| `config/schema.ts` + `config/toml.ts` | `config.rs` 的 `RawConfig` | 部分 | 只读 providers、default_provider、default_model、models、default_thinking，以及 Vertex 的 project / location / credentials。不读也不写：`utility_model`、`thinking`、`permission`、`hooks`、`services`、`loop_control`、`background`、`computer_use`、`anchored_bootstrap`、`extra_skill_dirs`、`enable_spec_critic`、模型的 capabilities / pricing / reasoning。没有写回 |
| `config/env-model.ts` | 无 | 缺失 | `LMCODE_MODEL_*` 合成模型 |
| `flags/*` | 无 | 缺失 | `getExperimentalFlags` |
| `logging/*` | 无 | 缺失 | 桌面 `log` 与诊断日志路径来自 SDK |
| `errors/*` | `error.rs` | 部分 | 没有可序列化的错误码，桌面按码分支会断 |
| `profile/*` | CLI/TUI/desktop 各有一份 `system.md` | 部分 | 没有 profile 加载器和会话上下文拼装 |
| `utils/spawn-command.ts` `spawn-env.ts` `self-healing.ts` | Bash 工具里直接起进程 | 部分 | 没有统一的 spawn 环境净化 |

### 模式与注入

| TS | Rust | 状态 | 缺口 |
| --- | --- | --- | --- |
| `agent/goal/*` + goal 工具 + grader | `goal.rs` `grader.rs` `tools/goal.rs` | 已有 | 创建、笔记上限、预算、持久化、注入、grader 解析有单测 |
| `agent/plan/*` + Enter/ExitPlanMode | `plan.rs` `tools/planning.rs` | 已有 | 状态机有单测 |
| `agent/cron/*` + cron 工具 | `cron.rs` `cron_expr.rs` `tools/cron.rs` | 已有 | 解析、调度、一次性、过期有单测 |
| `agent/wolfpack/*` + Agent / WolfPack 工具 | `subagent.rs` `tools/collaboration.rs` | 部分 | profile 过滤、禁止再委托有单测。没有 TS 那份 wolfpack 权限策略 |
| `agent/background/*` + TaskOutput | `background.rs` `tools/task_output.rs` | 部分 | 输出捕获有单测。TaskList / TaskStop 工具没有 |
| `agent/permission/policies/*`（15 个策略） | `permission.rs` | 部分 | 敏感路径（`.env`、密钥、`.git`）和会话内相同调用不再询问。没有：用户规则、plan 模式拒绝写、文件沙箱、auto / yolo 分层、wolfpack 自动批准、exit-plan 复查、pre-tool hook |
| `agent/injection/*` | `agent.rs` 的 `queue_injection` + goal/plan/cron 文本 | 部分 | 没有电脑操作契约、待办、权限模式、近期会话、用户偏好、working set、插件 session-start、pending tasks |
| `agent/usage/*` | `usage.rs` | 已有 | 按模型累计 |
| `skill/*` | `skill.rs` `tools/skill.rs` | 部分 | 扫描与注入有单测。没有 dream 内置技能的注册表对齐检查 |
| `plugin/*` | 无 | 缺失 | 安装、启停、从 GitHub 拉、插件自带 MCP。桌面 CoreAPI 有一整组 plugin 方法；当前 Electron 主进程的 IPC 列表里没有直接露出，CLI 会用到 |
| `computer-use/*` | 无 | 缺失 | 注册槽、激活失败回滚、驱动描述符、`[computer_use]` 配置。桌面有 `getComputerUseStatus` / `setComputerUseEnabled` / 安装驱动 |
| `lsp/*` + `lsp-tool` | `lsp/*` `tools/lsp.rs` | 已有 | mock 语言服务器有单测 |
| `mcp/*`（stdio、HTTP、命名） | `lmcode-mcp` + `mcp_manager.rs` + `tools/mcp.rs` | 部分 | stdio、Streamable HTTP、工具名前缀、配置写回有测试 |
| `mcp/oauth/*` | 无 | 缺失 | 回调服务器、token 存储、授权 URL 事件 |
| `rpc/*`（CoreAPI / SDKAPI，进程内） | 无 JSON-RPC 服务 | 缺失 | 见文末协议。Tauri 命令只覆盖桌面 IPC 的一个子集 |

### 工具

TS 注册表在 `tools/builtin/index.ts`。

| 工具 | Rust | 状态 |
| --- | --- | --- |
| Read Write Edit Glob Grep Bash | `tools/read.rs` `write.rs` `edit.rs` `glob.rs` `grep.rs` `bash.rs` | 已有。Glob/Grep 是原生实现，不调 `rg` 二进制 |
| MultiEdit ReadGroup ReadMedia | 无 | 缺失 |
| EnterPlanMode ExitPlanMode | `tools/planning.rs` | 已有 |
| CreateGoal GetGoal UpdateGoal SetGoalBudget WriteGoalNote | `tools/goal.rs` | 已有 |
| MemoryLookup MemoryWrite MemoryEdit MemoryConsolidatePlan MemoryConsolidateApply | `tools/memory.rs` | 已有。MemoryEdit 按 id 局部更新或删除，不需要审批；省略的字段保留，tags 走 normalize |
| Skill Agent WolfPack | `tools/skill.rs` `tools/collaboration.rs` | 已有 |
| AskUserQuestion | `tools/ask_user.rs` | 已有。1–4 个问题，每个 2–4 个选项；不需要审批；取消会中断本轮。CLI 把编号读成选项，其余文本当 Other。TUI、Tauri、stream-json 仍回复不支持 |
| TodoWrite | 无 | 缺失 |
| FetchURL WebSearch | `tools/web.rs` | 部分。HTML 抽取和错误分类有 mock 测试。TS 的 DuckDuckGo / lmcode-cli / 缓存回退链没有按 `services` 配置接上 |
| CronCreate CronDelete CronList | `tools/cron.rs` | 已有 |
| TaskOutput | `tools/task_output.rs` | 已有 |
| TaskList TaskStop | 无 | 缺失 |
| LSP | `tools/lsp.rs` | 已有 |
| MCP 动态工具 | `tools/mcp.rs` | 已有 |

`tools/policies/sensitive.ts` 的敏感路径判断收进了 `permission.rs`。`tools/args-validator.ts` 对 MCP `uint32` / `uint64` 的格式注册没有 Rust 对应物（Rust 侧不走 Ajv）。

## `packages/jian`

不单建 crate。Read / Write / Edit / Glob / Grep / Bash 在工具里直接访问本机。TS 的 `Jian` 是为了换沙箱实现。Rust 侧要补的是权限层里的文件沙箱（`read-only` / `workspace-write` / `full-access`），不是把每个 `fs` 调用再包一层。

## `apps/lmcode` → `lmcode-cli` + `lmcode-tui`

| TS | Rust | 状态 | 缺口 |
| --- | --- | --- | --- |
| CLI 选项与冲突 | `lmcode-cli` + `tests/cli_surface.rs` | 已有 | `-p` `-m` `-y` `--auto` `-C` `-S` `-r` `--plan` `--skills-dir` `--output-format` `--config`，子命令 `export` / `channel setup` / `stream-json` |
| `/update` 与 npm 更新检查 | 无 | 不移植 | 源码编译的二进制没有 npm 发布通道。桌面更新走 electron-updater，留在壳里 |
| TUI 组件、斜杠命令、主题 | `lmcode-tui` | 部分 | markdown、diff、`@` 提及、选择器、一批斜杠命令有测试。不是 `apps/lmcode/src/tui` 的逐文件移植。本迁移不要求换掉 Electron 界面，TUI 只随核心走 |

## 桌面外壳：谁留在 Electron，谁进 Rust

`apps/lmcode-desktop/src/main/index.ts` 今天 `new LmcodeHarness()`，渲染进程只走 preload IPC。切换时渲染层、preload 的频道名、git / 终端 / 远程这些壳功能保持不动。主进程里凡是转调 `LmcodeHarness` 或 `MemoryMemoStore` 的，改成 app-server 客户端。

留在壳里（已经不经过 agent-core，或只该留在 Electron）：

- 选目录、读写附件、打开路径、在资源管理器中显示、用 VS Code 打开、版本号、主目录、菜单、退出、系统通知
- Git 审查、worktree、提交（`src/main` 里的 git 模块）
- 集成终端
- 局域网远程服务、防火墙、配对 token（`src/main/remote`）。远程禁止打开 `computerUse` 的守卫留在壳里，核心只负责拒绝不该来的配置写入
- electron-updater
- 模型供应商用量查询里那些纯 HTTP 的额度接口，如果它们只读配置、不跑轮次，可以继续留在主进程，但配置的读必须改到核心，避免两份解析

必须改到 Rust 核心的 IPC（今天的实现在 `src/main/ipc/handler.ts`，底层是 CoreAPI）：

`createSession` `resumeSession` `deleteSession` `exportSession` `renameSession` `listSessions` `sendMessage` `steerMessage` `cancelResponse` `getSessionHistory` `getSessionStatus` `setModel` `setThinking` `setPermission` `createGoal` `getGoal` `updateGoalStatus` `cancelGoal` `setPlanMode` `compactSession` `undoHistory` `closeSession` `listCronJobs` `createCronJob` `deleteCronJob` `listBackgroundTasks` `stopTask` `getTaskOutput` `listSkills` `activateSkill` `listMcpServers` `reconnectMcpServer` `addMcpServer` `stopMcpServer` `removeMcpServer` `getComputerUseStatus` `setComputerUseEnabled` `getConfig` `setConfig` `removeProvider` `removeModel` `listMemories` `searchMemories` `deleteMemory`，以及审批 / 提问的往返。

Tauri 壳（`crates/lmcode-desktop/src/main.rs`）已经有 send、approve、会话列表、resume、设置、记忆、cron、MCP、终端、子代理、收件箱、远程的一部分命令。那是进程内调用，协议形状也和 Electron IPC 不同。它不作为桌面切换的接口。可以稍后改成同一个 app-server 的另一个客户端，避免两套核心调用。

## 目标接口（参照 Codex app-server）

新 crate：`crates/lmcode-app-server`。二进制由 `lmcode-cli` 增加子命令 `lm app-server` 拉起，桌面主进程 spawn 它。

传输：stdin / stdout 上每行一条 JSON。参照 Codex，这是双向 JSON-RPC：

- 客户端请求带 `id`、`method`、`params`，服务端回同一 `id` 的 `result` 或 `error`。
- 服务端通知没有 `id`，只有 `method` 和 `params`（助手增量、工具开始、回合结束）。
- 需要用户拍板时，服务端向客户端发带 `id` 的请求（审批、提问），客户端回响应。
- 首帧是 `initialize`，然后客户端发 `initialized` 通知。

方法名沿用 Codex 的线程模型，LMcode 多出来的面板用自己的前缀，避免把 goal / cron 塞进不存在的 Codex 方法里：

| 方法 | 作用 | 对应今天的 IPC |
| --- | --- | --- |
| `initialize` | 能力协商，返回核心版本 | `getVersion` 以外的协议握手 |
| `thread/start` `thread/resume` `thread/list` `thread/fork` `thread/delete` `thread/rename` | 会话 | create / resume / list / delete / rename |
| `turn/start` `turn/steer` `turn/interrupt` | 一轮对话 | send / steer / cancel |
| 通知 `turn/started` `item/agentMessage/delta` `item/reasoning/delta` `item/tool/started` `item/tool/completed` `turn/completed` | 流式事件 | `lmcode:sessionEvent` |
| 反向请求 `item/commandExecution/requestApproval` `item/tool/requestUserInput` | 审批和提问 | approval / question |
| `config/read` `config/write` | 配置 | getConfig / setConfig / removeProvider / removeModel |
| `goal/*` `cron/*` `mcp/*` `memory/*` `computerUse/*` | 面板 | 同名 IPC |

事件负载尽量沿用现在渲染层已经在消费的 `Event` 字段，这样 preload 和 React store 不用改语义。协议稳定之后，再删掉主进程对 `@lmcode-cli/lmcode-sdk` 和 `@lmcode/memory` 的依赖。渲染层里那些 `import type` 可以改成壳自己的类型副本，避免为了类型再拉起 TS 核心。

在上表里标成缺失的行为补上之前，不把桌面默认切到这个协议。切过去就等于把这些面板弄坏。

## 实施顺序

每一项完成的定义：Rust 行为与对应 TS 测试所保护的契约一致，有 Rust 单测，`cargo build` 和相关 `cargo test` 通过，桌面现有 vitest 通过（这一项没碰到前端时也要跑，确认没有被连带弄坏），然后单独提交。TS 源码保留。

1. 本清单。已写入。
2. `packages/memory/src/extractor.ts` → `lmcode-memory`。解析已移植。压缩和退出已调用它。
3. 补 TodoWrite、TaskList、TaskStop、MultiEdit、ReadGroup、ReadMedia。AskUserQuestion 已接到轮次循环和 CLI readline。TUI、Tauri、stream-json 仍回复不支持，Electron 提问弹窗还没接上。
4. 权限策略链和文件沙箱，加上 config 里 `permission` / `loop_control` / `computer_use` 的读写。不写回的字段，设置面板会丢。
5. 轮次缺口：重试与溢出、steer、undo、会话 delete / rename / fork。
6. 电脑操作控制器，以及 MCP OAuth。
7. 注入器里桌面会看见的那几条：电脑操作契约、待办、偏好、pending tasks。
8. `lmcode-app-server`：先覆盖 thread + turn + approval，再补 goal / cron / mcp / memory / config。
9. Electron 主进程改走该客户端。渲染层不动。依赖切完之后再从桌面 `package.json` 去掉 `@lmcode-cli/lmcode-sdk` 和 `@lmcode/memory`。
10. 回到本文件「剩余问题」，把没做完的和有意留下的分开写清。

不在这轮做的：删除 `packages/`、把 Electron 换成 Tauri、移植 `migration-legacy`、移植 npm `/update`。

## 剩余问题

写清单时就已经确定、还没动手的：

- 接到压缩和退出的提交把原先未跟踪的 `lmcode-core`、`lmcode-llm`、`lmcode-mcp`、`lmcode-cli`、`lmcode-tui`、`lmcode-desktop` 一并记下来。这些 crate 里的大部分代码是接线之前就在工作区里的，不是这次新移植的。没有跑过 `cargo test --workspace`。这次跑的是 `cargo test -p lmcode-memory -p lmcode-core`，以及 `cargo check -p lmcode-cli -p lmcode-tui -p lmcode-desktop`。
- 退出提取没有 `utility_model`，用的是当前会话 provider。没有把进行中的第二次提取并到同一次调用上。未变化判断用历史指纹，不是 TS 的 context revision。Rust `update` 不重写 FTS，TS 全文搜索在 Rust 改过一条备忘录后可能仍命中旧文本。
- `config.rs` 会静默丢掉设置面板在写的字段。这是已知的数据丢失，优先级高于新功能。
- OpenAI 兼容路径没有把工具结果里的图片折成 user 消息。电脑操作一旦接上，截图对 `type = "openai"` 的模型不可见。
- 桌面仍然进程内调用 TS 核心。`crates/lmcode-desktop` 是平行的 Tauri 程序，不是这条切换。
- `packages/ltod` 没有源码，不用迁。
- `records/replay` 不按原事件日志移植；会话 JSON 必须仍能恢复消息、goal 和 cron，这件事要用测试钉住，而不是写在注释里。
- AskUserQuestion 的 CLI 会真正提问。TUI、Tauri 桌面和 stream-json 还是「客户端不支持」，模型应改在正文里问。Electron 的提问弹窗没有接到这个工具。
