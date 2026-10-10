# Rust 重写 — 模块与行为测试映射

本文件把 TS 侧（`packages/`、`apps/`）的公开功能模块映射到 Rust 实现
（`crates/`）及其行为测试，用于证明每个移植模块都有对应的验证。

测试运行方式（全部命令在仓库根执行）：

```bash
cargo test --workspace                                   # 全部 263 个测试 / 26 个 test target
cargo clippy --workspace --all-targets -- -D warnings    # 零警告门槛
cargo fmt --all --check                                  # 格式门槛
```

## provider 层（`lmcode-llm`）

| TS 源 | Rust 实现 | 行为测试 |
|---|---|---|
| `packages/liumir/src/providers/openai.ts` | `providers/openai.rs` | `tests/openai_e2e.rs`（流式 / 工具调用 / 错误 / 媒体数组）+ 3 单测 |
| `.../anthropic.ts` | `providers/anthropic.rs` | `tests/anthropic_e2e.rs`（3 个） |
| `.../openai-responses.ts` | `providers/responses.rs` | `tests/responses_e2e.rs`（2 个） |
| `.../google-genai.ts` | `providers/genai.rs` | `tests/genai_e2e.rs`（2 个）+ `convert_media_url`/请求体/媒体部件单测 |
| `.../vertex.ts`（服务账号 JWT） | `providers/vertex.rs` | `tests/vertex_e2e.rs`（api_key 模式 + **JWT 全链路**：签名断言→mock token 端点→Bearer→API）+ 4 单测（含 RS256 验签） |
| `.../lmcode.ts` + `lmcode-schema.ts` + `lmcode-files.ts` | `providers/lmcode.rs` | `tests/lmcode_e2e.rs`（请求规范化 / 视频 multipart 上传 / 拒绝路径）+ 7 单测（schema 规范化全表 + MIME） |
| 消息与流式模型 | `message.rs` / `generate.rs` / `sse.rs` / `usage.rs` | 各模块单测 |

## agent 运行时（`lmcode-core`）

| TS 源 | Rust 实现 | 行为测试 |
|---|---|---|
| `agent/turn` + `agent/index` | `agent.rs` | 单测 + `cli_e2e.rs`（**真实二进制完整 turn**） |
| `agent/compaction` | `compaction.rs` | 单测（micro/full/断路器） |
| `agent/goal` + `tools/builtin/goal` | `goal.rs` + `tools/goal.rs` + `grader.rs` | goal 6 单测 + 工具 2 单测 + grader 5 单测（PASS 矛盾/容错/证据提取）+ **真实 e2e**（CreateGoal→Bash 证据→grader PASS→complete 持久化） |
| `agent/cron` + `tools/cron` | `cron.rs` + `cron_expr.rs` + `tools/cron.rs` | 12 单测（解析/调度/stale/一次性/防重复）+ **winpty 真实触发**（ticker→注入→自动 turn→lastFiredAt） |
| `agent/plan` + `tools/builtin/planning` | `plan.rs` + `tools/planning.rs` | 4 单测（状态机/双进入/工具往返）+ **真实 e2e**（EnterPlanMode→文件创建→ExitPlanMode） |
| `agent/background` + `tools/builtin/shell` | `background.rs` + `tools/task_output.rs` | 5 单测（输出捕获/退出码/kill/顺序）+ **真实 e2e**（run_in_background→TaskOutput block） |
| `agent/wolfpack` + `tools/builtin/collaboration` | `subagent.rs` + `tools/collaboration.rs` | 3 单测（profile 过滤/无递归委托）+ **真实 e2e**（WolfPack 2 子代理并行聚合） |
| `agent/usage` | `usage.rs` | 单测 + **winpty 真实 `/usage`**（真实 token 统计） |
| `agent/session-memory` | `session_memory.rs` | 3 单测（注入一次/上限/截断） |
| `agent/injection/*`（goal/plan/cron） | `agent.rs` 的 `system_prompt_with_injections` + `queue_injection` | `goal_injection` / `render_cron_fire_xml` 单测 |
| `agent/permission` + policies | `permission.rs` | 单测（敏感路径硬边界 + 会话审批记忆） |
| `agent/skill` | `skill.rs` | 单测（扫描/解析/注入） |
| `agent/context` / `bootstrap` | `agent.rs` 组装 + `config.rs` | `config.rs` 单测 + `cli_e2e`（负输入：缺 config/坏 TOML/未知 provider → 非零退出） |

## 工具集（`lmcode-core/src/tools`）

| TS 源 | Rust 实现 | 行为测试 |
|---|---|---|
| `file/read|write|edit` | `read.rs` / `write.rs` / `edit.rs` | 单测 + `bash_tool.rs` 风格 e2e |
| `file/glob|grep` | `glob.rs` / `grep.rs`（原生 Rust 引擎） | 单测 |
| `shell/bash` | `bash.rs` | `tests/bash_tool.rs`（真实进程）+ `cli_e2e` |
| `lsp-tool` + `lsp/*` | `lsp/client.rs` + `lsp/registry.rs` + `tools/lsp.rs` | 5 单测（**mock LSP 服务器全协议 e2e**：分帧/请求关联/诊断/URI 转换）+ **真实 rust-analyzer 验证**（initialize→didOpen→definition 真实响应） |
| `web/*` | `tools/web.rs` | 3 单测（**mock HTTP e2e**：HTML 提取/404/非 http；搜索格式化/错误分类）+ **真实抓取 example.com** |
| `memory/*` | `tools/memory.rs` | memory crate 测试 |
| `state/*`（TaskOutput） | `tools/task_output.rs` | 单测 + 真实 e2e |

## 记忆系统（`lmcode-memory`）

| TS 源 | Rust 实现 | 行为测试 |
|---|---|---|
| `packages/memory`（SQLite 存储） | `store.rs` | 13 单测（CRUD/级联删除/**旧库列迁移**/embedding 回填）+ `tests/embeddings_e2e.rs` |
| 向量检索 + 混合评分 | `embeddings.rs` + `scoring.rs` | 单测（60/40 混合/降级）+ **真实模型下载 + ONNX 推理**（feature 门控） |
| 梦境合并 | `consolidator.rs` + `dream.rs` | 单测 + **真实 Plan→Apply 闭环** |

## MCP（`lmcode-mcp`）

| TS 源 | Rust 实现 | 行为测试 |
|---|---|---|
| `agent-core/src/mcp`（stdio） | `client.rs` + `config.rs` | `tests/` stdio 测试 + config 3 单测（卸载写回/malformed 保护） |
| Streamable HTTP + SSE | `http.rs` | `tests/http_e2e.rs`（JSON/SSE/Session-Id） |
| `/mcp` 面板运行时管理 | `mcp_manager.rs` | 2 单测（状态机/启动失败）+ **winpty 真实启停/卸载/推荐安装**（文件写回断言） |

## 界面层

| TS 源 | Rust 实现 | 行为测试 |
|---|---|---|
| `apps/lmcode/src/tui` | `lmcode-tui` | 11 快照测试（渲染/选择器/markdown/diff/@提及/MCP 面板）+ commands/picker/mentions/markdown/diff 单测 + **winpty 真实验证**（渲染/交互/ticker） |
| `apps/lmcode-desktop`（Electron+React） | `lmcode-desktop`（Tauri） | **CDP 真实验证**（DOM 断言 + 截图：侧边栏/会话/设置/记忆浏览/模型切换）+ `cli_e2e` 覆盖共享运行时 |

## 边界说明

- 桌面端其余 8 个 UI 面板（Git 审查 / 终端 / worktrees / 子代理 / 自动化 / 收件箱 /
  artifact / 远程连接）未移植——其底层能力（git/终端/子代理/cron）已在 Rust 运行时
  中可用；见 `AGENTS.md` 的"尚未移植"清单。
- `records/replay` 事件日志在 Rust 中用直接 JSON 持久化替代（goal/cron），语义等价。
- TS 源码保留在 `packages/`、`apps/` 作为参考实现与迁移期共存（未被删除——这是
  用户选定 monorepo 结构的一部分，Rust 实现为 `crates/` 下的新增工作区）。
