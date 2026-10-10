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
| `packages/liumir` | `crates/lmcode-llm` | 部分。六个 provider 都有流式实现和 e2e 测试。OpenAI Chat Completions 会把工具结果里的图片、音频、视频折成紧随其后的 user 消息。能力目录和 catalog 还没有 |
| `packages/agent-core` | `crates/lmcode-core` + `crates/lmcode-mcp` | 部分。轮次、会话、工具、权限链、电脑操作控制器、桌面可见的四条注入器在。插件、hooks、records 不在。OAuth 的存储、回调和授权 URL 事件在 `lmcode-mcp`；发现和换 token 的 HTTP 交换还不在 |
| `packages/memory` | `crates/lmcode-memory` | 部分。SQLite / 评分 / 向量 / 梦境 / 提取解析都在，压缩和退出会调用提取器。MemoryEdit 在 `lmcode-core` |
| `packages/config` | 没有独立 crate。身份头（device id、User-Agent）缺失。运行配置读在 `lmcode-core/src/config.rs` | 部分 |
| `packages/jian` | 没有 crate。Read / Write / Bash 直接打本机文件系统和进程 | 部分。没有可替换的执行环境。文件沙箱在 `permission_chain.rs` |
| `packages/node-sdk` | `crates/lmcode-app-server`，由 `lm app-server` 拉起 | 已有。Electron 主进程拉起这一个 stdio JSON-RPC 进程。会话、回合、审批、提问，以及 goal、cron、mcp、memory、config、computer use 走这个进程。渲染层仍是 `import type` |
| `packages/migration-legacy` | 无 | 不移植。包自己的 README 写了 v1.0 移除 |
| `packages/ltod` | 无 | 不移植。目录里只有 `dist/` 和 `node_modules/`，没有源码 |
| `apps/lmcode`（CLI / TUI） | `crates/lmcode-cli` + `crates/lmcode-tui` | 部分。CLI 选项面有契约测试；TUI 是另一套 ratatui，不是 TS 组件的逐个移植 |
| `apps/lmcode-desktop`（Electron + React，当前产品） | 不替换界面。主进程是 `lm app-server` 的客户端。`crates/lmcode-desktop` 仍是另一套 Tauri 壳 | 壳层。`package.json` 不再依赖 `@lmcode-cli/lmcode-sdk` 和 `@lmcode/memory` |

`crates/lmcode-desktop` 不能当成需求 3 的完成。需求 3 要留的是 `apps/lmcode-desktop` 的渲染层，主进程改成 JSON-RPC 客户端。

## `packages/liumir` → `lmcode-llm`

| TS | Rust | 状态 | 缺口 |
| --- | --- | --- | --- |
| `message.ts` / `generate.ts` / `provider.ts` / `tool.ts` / `usage.ts` / `sse`（在 provider 流里） | `message.rs` `generate.rs` `provider.rs` `tool.rs` `usage.rs` `sse.rs` | 已有 | 流式组装有单测 |
| `providers/openai.ts` + `openai-legacy.ts` + `chat-completions-stream.ts` | `providers/openai.rs` | 已有 | 文本、工具、媒体数组有测试。工具结果里的图片、音频、视频留在存储的 tool 消息上，写到请求里时文本仍挂在 `tool`，媒体折成该组工具消息之后的一条 user 消息 |
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
| `agent/turn` + `loop/run-turn.ts` `loop/turn-step.ts` | `agent.rs` 的 `run_turn` | 部分 | 有工具循环、取消、步数上限、用量累计、溢出后压缩、steer。没有 spec-critic、visual auditor、anchored bootstrap、工具去重。流式中途断开不重试 |
| `loop/retry.ts` | `retry.rs`，由 `generate_with_retry` 调用 | 已有 | 上下文溢出第一次就返回，轮次接着压缩；压不出安全切分时错误交回调用方。503 这类可重试错误会再试，`retry_after_ms` 为 0 时不等待。没有 TS 的随机抖动 |
| `agent/compaction/*` | `compaction.rs` | 部分 | micro + full 有单测。触发比例、工作集上限、阻塞压缩超时、连续失败断路器没有按 TS 的 50% / 75% / 85% 和 `loop_control` 配齐 |
| `agent/context/*`（media-budget、projector、tool-output-limits） | 压缩投影里有一块 | 部分 | 工具图数量上限、媒体预算没有独立实现 |
| `agent/session-memory.ts` | `session_memory.rs` | 已有 | 压缩后注入有单测 |
| `session/store/*` | `session.rs` | 部分 | create / load / latest / list / save / delete / rename / fork。rename 拒绝空白标题，并写 `isCustomTitle`，之后的 save 不再用第一条用户消息覆盖标题。fork 复制消息、换新 id、写 `forkedFrom`，源会话不动。`thinking`、`permission`、`planMode` 写在会话记录上。fork 的 `desktopWorktree`（`branch`、`path`、`sourceSessionId`）只写在新会话上。delete 对已经不存在的会话也成功。没有 lastPrompt、agents 元数据。undo 在 `agent.rs`：跳过 injection，停在 compaction summary，`user-slash` 的技能激活算一次用户提示。`thread/undo` 和 `thread/compact` 把变短后的历史存回会话 |
| `session/export/*` | `lmcode-app-server/src/export.rs` | 已有 | `lm export` 和 `session/export` 共用这一份 deflate ZIP。桌面 `exportSession` 返回 `zipPath`。字段是否与 legacy manifest 逐字节一致，以 `docs/CLI_PARITY.md` 为准，本清单没有复跑 |
| `session/hooks/*` `session/git-context.ts` `session/subagent-host.ts` | 无 | 缺失 | 用户 hooks、git 上下文注入、子代理宿主 |
| `agent/records/*` `agent/replay/*` | 无独立事件日志 | 不移植为原样 | 目标语义是会话 JSON 能恢复 goal / cron / 消息。TS 的 record migration v1.1–v1.3 没有 Rust 版 |
| `config/schema.ts` + `config/toml.ts` | `config.rs` 的 `RawConfig` | 部分 | 读写 providers、模型、`default_permission_mode`、`default_file_sandbox`、`permission`、`loop_control`、`computer_use`。`max_steps_per_run` 读入后写成 `max_steps_per_turn`。旧的 `[[permission.allow]]` 折成 `rules`。未知顶层表在 `save_config` 里保留。仍不读写：`utility_model`、`thinking`、`hooks`、`services`、`background`、`anchored_bootstrap`、`extra_skill_dirs`、`enable_spec_critic`、模型 capabilities / pricing |
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
| `agent/wolfpack/*` + Agent / WolfPack 工具 | `subagent.rs` `tools/collaboration.rs` | 部分 | profile 过滤、禁止再委托有单测。权限链在 wolfpack 激活时批准普通调用，且不绕过文件沙箱。模式开关本身还没有 |
| `agent/background/*` + TaskOutput | `background.rs` `tools/task_output.rs` `tools/task_list.rs` `tools/task_stop.rs` | 已有 | 输出捕获、列表、停止有单测 |
| `agent/permission/policies/*`（15 个策略） | `permission.rs` `permission_chain.rs` | 已有 | 链的顺序与 TS 一致，yolo 不绕过沙箱。敏感文件在工具层直接拒绝。路径里的 `.git` 段会询问。PreToolCallHook 是用户 hook，不在这条链里。分离式 gitdir 控制目录没有单独解析 |
| `agent/injection/*` | `injection.rs`，由 `Agent::apply_desktop_injections` 在每次模型请求前调用 | 部分 | 电脑操作契约、待办提醒、用户偏好、pending tasks 有契约测试。权限模式、近期会话、working set、插件 session-start 还没有 |
| `agent/usage/*` | `usage.rs` | 已有 | 按模型累计 |
| `skill/*` | `skill.rs` `tools/skill.rs` | 部分 | 扫描与注入有单测。没有 dream 内置技能的注册表对齐检查 |
| `plugin/*` | 无 | 缺失 | 安装、启停、从 GitHub 拉、插件自带 MCP。桌面 CoreAPI 有一整组 plugin 方法；当前 Electron 主进程的 IPC 列表里没有直接露出，CLI 会用到 |
| `computer-use/*` | `computer_use.rs` + `config.rs` 的 `[computer_use]` | 部分 | 独占注册槽、激活前占槽、启动失败回滚、掉线保留槽位、驱动路径和安装配方有单测。进程拉起走 `ComputerUseHost`，还没接到 `McpManager`。`Agent::set_computer_use_active` 是注入器读的开关。桌面 IPC `getComputerUseStatus` / `setComputerUseEnabled` / 安装驱动仍在 Electron 壳 |
| `lsp/*` + `lsp-tool` | `lsp/*` `tools/lsp.rs` | 已有 | mock 语言服务器有单测 |
| `mcp/*`（stdio、HTTP、命名） | `lmcode-mcp` + `mcp_manager.rs` + `tools/mcp.rs` | 部分 | stdio、Streamable HTTP、工具名前缀、配置写回有测试 |
| `mcp/oauth/*` | `lmcode-mcp` 的 `oauth.rs` | 部分 | 存储键、JSON 文件、回调服务器、授权 URL 只取一次、authenticate 工具的成功/已授权/失败输出有单测。RFC 9728/8414/7591 发现和 token 端点交换还不在 |
| `rpc/*`（CoreAPI / SDKAPI，进程内） | `lmcode-app-server`，子命令 `lm app-server` | 已有 | stdio JSONL：`initialize`，`thread/start\|resume\|list\|fork\|delete\|rename\|setModel\|setThinking\|setPermission\|setPlanMode\|undo\|compact\|status`，`session/export`，`skills/list\|activate`，`background/list\|output\|stop`，`turn/start\|steer\|interrupt`，审批与提问的反向请求，以及 `goal` / `cron` / `mcp` / `memory` / `config/read\|write\|get\|patch` / `computerUse`。`turn/start` 接受文字和图片。`thread/list` 不带 cwd 时列出全部会话。`thread/fork` 接受 `targetCwd`、`title` 和 `metadata.desktopWorktree`。`thread/status` 返回配置的上下文窗口和本进程记下的用量。当前线程大约每秒检查一次到点的 cron：空闲时注入 `<cron-fire>` 并开一轮，通知 `cron/fired`。第二次启动能恢复消息、goal、cron、会话控制和压缩后的历史。Electron 主进程已经改成这个客户端，整个桌面共用一个进程。MCP 方法只读写 `mcp.json`，不拉起服务器进程；电脑操作不启动驱动。Tauri 仍是进程内调用 |

### 工具

TS 注册表在 `tools/builtin/index.ts`。

| 工具 | Rust | 状态 |
| --- | --- | --- |
| Read Write Edit Glob Grep Bash | `tools/read.rs` `write.rs` `edit.rs` `glob.rs` `grep.rs` `bash.rs` | 已有。Glob/Grep 是原生实现，不调 `rg` 二进制 |
| MultiEdit ReadGroup ReadMediaFile | `tools/multi_edit.rs` `read_group.rs` `read_media.rs` | 已有。MultiEdit 整批原子替换并校验 anchor。ReadGroup 一次读 1–10 个文件，失败的文件标 `[ERROR]`。ReadMediaFile 把图片放进工具结果的 image part；没有 image/video 能力时不注册 |
| EnterPlanMode ExitPlanMode | `tools/planning.rs` | 已有 |
| CreateGoal GetGoal UpdateGoal SetGoalBudget WriteGoalNote | `tools/goal.rs` | 已有 |
| MemoryLookup MemoryWrite MemoryEdit MemoryConsolidatePlan MemoryConsolidateApply | `tools/memory.rs` | 已有。MemoryEdit 按 id 局部更新或删除，不需要审批；省略的字段保留，tags 走 normalize |
| Skill Agent WolfPack | `tools/skill.rs` `tools/collaboration.rs` | 已有 |
| AskUserQuestion | `tools/ask_user.rs` | 已有。1–4 个问题，每个 2–4 个选项；不需要审批；取消会中断本轮。CLI 把编号读成选项，其余文本当 Other。TUI、Tauri、stream-json 仍回复不支持 |
| TodoList TaskList TaskStop | `tools/todo.rs` `task_list.rs` `task_stop.rs` | 已有。清单里的 TodoWrite 就是 TS 的 TodoList。TaskList 默认只列未结束任务；TaskStop 记下原因，空原因写成 Stopped by TaskStop |
| FetchURL WebSearch | `tools/web.rs` | 部分。HTML 抽取和错误分类有 mock 测试。TS 的 DuckDuckGo / lmcode-cli / 缓存回退链没有按 `services` 配置接上 |
| CronCreate CronDelete CronList | `tools/cron.rs` | 已有 |
| TaskOutput | `tools/task_output.rs` | 已有 |
| LSP | `tools/lsp.rs` | 已有 |
| MCP 动态工具 | `tools/mcp.rs` | 已有 |

`tools/policies/sensitive.ts` 的敏感路径判断收进了 `permission.rs`。`tools/args-validator.ts` 对 MCP `uint32` / `uint64` 的格式注册没有 Rust 对应物（Rust 侧不走 Ajv）。

## `packages/jian`

不单建 crate。Read / Write / Edit / Glob / Grep / Bash 在工具里直接访问本机。TS 的 `Jian` 是为了换沙箱实现。文件沙箱（`read-only` / `workspace-write` / `full-access`）在 `permission_chain.rs`，yolo 也不绕过。

## `apps/lmcode` → `lmcode-cli` + `lmcode-tui`

| TS | Rust | 状态 | 缺口 |
| --- | --- | --- | --- |
| CLI 选项与冲突 | `lmcode-cli` + `tests/cli_surface.rs` | 已有 | `-p` `-m` `-y` `--auto` `-C` `-S` `-r` `--plan` `--skills-dir` `--output-format` `--config`，子命令 `export` / `channel setup` / `stream-json` |
| `/update` 与 npm 更新检查 | 无 | 不移植 | 源码编译的二进制没有 npm 发布通道。桌面更新走 electron-updater，留在壳里 |
| TUI 组件、斜杠命令、主题 | `lmcode-tui` | 部分 | markdown、diff、`@` 提及、选择器、一批斜杠命令有测试。不是 `apps/lmcode/src/tui` 的逐文件移植。本迁移不要求换掉 Electron 界面，TUI 只随核心走 |

## 桌面外壳：谁留在 Electron，谁进 Rust

`apps/lmcode-desktop/src/main/index.ts` 用 `RustHarness.start` 拉起 `lm app-server`。渲染进程仍只走 preload IPC。渲染层、preload 的频道名、git / 终端 / 远程这些壳功能保持不动。主进程里原先转调 `LmcodeHarness` 或 `MemoryMemoStore` 的调用，现在走 `src/main/rust-core/` 里的 JSON-RPC 客户端，通知会翻成渲染层已经在消费的 `Event`。

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
| `thread/start` `thread/resume` `thread/list` `thread/fork` `thread/delete` `thread/rename` | 会话。fork 接受 `targetCwd`、`title` 和 `metadata.desktopWorktree` | create / resume / list / delete / rename / fork |
| `thread/setModel` `thread/setThinking` `thread/setPermission` `thread/setPlanMode` | 模型、思考档、权限、计划模式，写进会话记录 | setModel / setThinking / setPermission / setPlanMode |
| `thread/undo` `thread/compact` | 撤销最后一条真实用户提示；手动压缩，并在结果前通知 `compaction/completed` | undoHistory / compactSession |
| `thread/status` | 配置的上下文窗口，以及本进程记下的用量 | getSessionStatus |
| `session/export` | 导出会话 ZIP | exportSession |
| `skills/list` `skills/activate` | 扫描磁盘上的技能文件并激活 | listSkills / activateSkill |
| `background/list` `background/output` `background/stop` | 本进程里的后台命令 | listBackgroundTasks / getTaskOutput / stopTask |
| `turn/start` `turn/steer` `turn/interrupt` | 一轮对话。`turn/start` 接受文字和图片 | send / steer / cancel |
| 通知 `turn/started` `item/agentMessage/delta` `item/reasoning/delta` `item/tool/started` `item/tool/completed` `turn/completed` | 流式事件 | `lmcode:sessionEvent` |
| 反向请求 `item/commandExecution/requestApproval` `item/tool/requestUserInput` | 审批和提问 | approval / question |
| `config/read` `config/write` `config/get` `config/patch` | 配置。`read`/`write` 是原始 TOML；设置面板走 camelCase 的 `get`/`patch` | getConfig / setConfig / removeProvider / removeModel |
| `goal/*` `cron/*` `mcp/*` `memory/*` `computerUse/*` | 面板 | 同名 IPC |

通知由客户端翻成渲染层已经在消费的 `Event`，preload 和 React store 不用改语义。桌面 `package.json` 已经去掉 `@lmcode-cli/lmcode-sdk` 和 `@lmcode/memory`。渲染层和主进程剩下的是 `import type`，vitest 用 `src/shims/` 里的类型重导出解析它们，不会加载 TS 核心的运行时。上面这张表里的方法返回真实结果。「有意留下」里的项仍然不做。

## 实施顺序

每一项完成的定义：Rust 行为与对应 TS 测试所保护的契约一致，有 Rust 单测，`cargo build` 和相关 `cargo test` 通过，桌面现有 vitest 通过（这一项没碰到前端时也要跑，确认没有被连带弄坏），然后单独提交。TS 源码保留。

1. 本清单。已写入。
2. `packages/memory/src/extractor.ts` → `lmcode-memory`。解析已移植。压缩和退出已调用它。
3. TodoList、TaskList、TaskStop、MultiEdit、ReadGroup、ReadMediaFile 已接到 CLI 和 Tauri。AskUserQuestion 已接到轮次循环和 CLI readline。TUI、Tauri、stream-json 的提问仍回复不支持，Electron 提问弹窗还没接上。模型能力位还没从配置读出，ReadMediaFile 默认只开图片。
4. 权限策略链和文件沙箱已接到轮次循环。`permission` / `loop_control` / `computer_use` 写回后再读是同一份。其余配置节仍会在整文件重写时留在 `extra` 里；没建模的字段不会变成类型化配置。
5. 轮次重试、溢出后压缩、steer、undo、会话 delete / rename / fork、OpenAI 工具结果图片折进下一条 user 消息。已接到轮次循环。spec-critic、visual auditor、anchored bootstrap、工具去重、流式中途重试仍然没有。
6. 电脑操作控制器的决策（占槽、失败回滚、驱动解析、安装配方）和 MCP OAuth 的存储、回调、授权 URL 事件已有契约测试。真实驱动进程还没接到 `McpManager`。授权服务器的 HTTP 发现和换 token 还不在。
7. 电脑操作契约、待办提醒、用户偏好、pending tasks 已在 `Agent::apply_desktop_injections` 里、每次模型请求前注入。权限模式、近期会话、working set、插件 session-start 还没有。
8. `lmcode-app-server` 已由 `lm app-server` 拉起。真实进程测试覆盖 thread、turn、审批、提问，以及 goal、cron、mcp、memory、config、computerUse，还有会话控制、undo、compact、技能、后台命令、导出、上下文用量和图片部分。到点的 cron 会在当前线程开一轮，并发出 `cron/fired`。第二次启动能恢复消息、goal、cron、会话控制和压缩后的历史。MCP 与驱动进程不在这个进程里拉起。
9. Electron 主进程已改走该客户端。渲染层不动。桌面 `package.json` 已去掉 `@lmcode-cli/lmcode-sdk` 和 `@lmcode/memory`。
10. 本文件把已完成的切换和有意留下的缺口分开写在下面。`packages/` 仍在树里。

不在这轮做的：删除 `packages/`、把 Electron 换成 Tauri、移植 `migration-legacy`、移植 npm `/update`。

## 已完成

Electron 主进程通过真实的 `lm app-server` 进程驱动 Rust 核心。一个进程服务整个桌面：空闲时先 `thread/resume` 再调用，已有回合在跑时第二次 `turn/start` 以 “a turn is already running” 拒绝。审批和提问的反向请求会等到桌面对话框回答，客户端等待上限是 600 秒。

渲染层能看到的会话、回合、审批、提问，以及 goal、cron、mcp、memory、config、computer use，都走这条协议。goal 和 cron 按会话文件存放，fork 会复制它们。`goal/create`、`goal/update`、`goal/cancel` 的结果会在会话事件流上变成 `goal.updated`，目标芯片不用等切换会话。cron 的 `humanSchedule` 就是原始表达式，同时带 `nextFireAt` 和 `stale`。当前线程大约每秒做一次 `due_fires`：到点的任务发 `cron/fired`（客户端翻成 `cron.fired`，自动化面板据此刷新），把 `<cron-fire>` 注入历史，并在空闲时开一轮去处理。已有回合在跑时这一拍跳过，任务留到下一拍。其它会话要等被 resume 成当前线程之后才会触发。mcp 列表只反映 `mcp.json`：有 url 视为 http，否则 stdio；禁用为 disabled，否则 pending，并说明进程没有拉起。computer use 的 `setEnabled(true)` 返回 phase `failed`，错误文本包含 “not launched”；`setEnabled(false)` 回到 idle。配置面板用 `config/get` 和 `config/patch`（camelCase，未知键进 extra，`null` 删除 provider 或 model）。`anchoredBootstrap` 没有单独建模，桌面启动时写入 extra，能随文件往返。`packages/` 下的 TypeScript 还在。`crates/lmcode-desktop` 没有被改成产品壳。

会话控制写在会话记录上。`thread/setModel`、`thread/setThinking`、`thread/setPermission`、`thread/setPlanMode` 之后，另一个 `lm app-server` 进程 resume 同一会话，读到的是同一组值。`thread/fork` 的 `metadata.desktopWorktree`（`branch`、`path`、`sourceSessionId`）只出现在新会话上。`thread/undo` 去掉最后一条真实用户提示和属于它的消息。`thread/compact` 留下更短的历史，并在 RPC 结果之前发出带 `threadId` 的 `compaction/completed`。`skills/list` 包含磁盘上的技能文件，`skills/activate` 用正文开一轮。`background/list`、`background/output`、`background/stop` 读写本进程里的后台命令；进程退出后这些任务不保留。`session/export` 写出的 ZIP 里有当时的用户文本。`thread/status` 的 `maxContextTokens` 来自模型别名的 `max_context_size`，`contextTokens` 和 `contextUsage` 来自这一进程记下的用量。带文字的图片部分在 resume 后仍是图片；只有图片、没有文字的提示存成图片，不会换成 “[image attachment]”。

## 有意留下

这些是不做的，不是忘了接：

- 删除 `packages/` 里的 TypeScript。
- 用 Tauri 换掉 Electron。`crates/lmcode-desktop` 继续做平行壳，进程内调 core。
- `packages/migration-legacy`。包自己的 README 写了 v1.0 移除。
- `packages/ltod`。目录里没有源码。
- npm `/update`。桌面更新仍走 electron-updater。
- 插件：安装、启停、从 GitHub 拉、插件自带 MCP。
- 用户 hooks，包括 PreToolCallHook。
- 把 `records/replay` 做成事件日志。会话 JSON 恢复消息、goal 和 cron 已经由 app-server 的进程测试覆盖。
- 从 app-server 拉起 MCP 服务器进程。`mcp/stop` 和 `mcp/reconnect` 只返回未连接。
- 从 app-server 拉起 cua-driver。驱动探测和安装配方留在 Electron 壳里。
- MCP OAuth 的授权服务器 HTTP 交换（RFC 9728 / 8414 / 7591 发现，以及 token 端点）。存储、回调和授权 URL 事件已经在 `lmcode-mcp`。

其它已经知道、但不挡这次切换的缺口：退出提取没有 `utility_model`；备忘录 `update` 不重写 FTS；`config/patch` 只保留建模过的 provider 字段，oauth 和 env 会丢掉；能力目录、catalog、实验 flag、spec-critic、visual auditor、anchored bootstrap 的回合行为都没有。identity 请求头没有。`packages/jian` 不单建可替换执行环境。Rust TUI 不把 TypeScript TUI 逐组件重建进来。AskUserQuestion 在这条桌面客户端上会弹提问；TUI、Tauri 和 stream-json 仍回复不支持。
