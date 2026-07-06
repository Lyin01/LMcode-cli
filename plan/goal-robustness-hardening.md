# GOAL: 错误处理 / 健壮性加固

**模式**：GOAL 模式（`/loop` 自迭代驱动）。本文件是**唯一权威进度源**，跨轮次、跨上下文压缩持久化。每轮开始先读它，结束前更新它。

**目标**：系统性发现并修复运行时路径上的真实健壮性漏洞——未处理的 promise rejection、错误路径上的资源泄漏、吞掉真实失败的 catch、边界失败模式。**只修真 bug**；本仓防御性写法成熟，大量"吞错"是**有意的 best-effort**，不得误伤。

**分支**：`auto/loop-iterations`（`main` 保持干净）。

**接续**：本目标承接已完成的 [[goal-windows-hardening]]（Windows 加固首轮 3 修复 + 全审计，见 `plan/goal-windows-hardening.md`）。

## 护栏（不可违反）
- 主干常绿：每步 lint + typecheck/test 通过才提交；每步一个聚焦、可验证的 commit。
- **区分有意吞错 vs bug**：best-effort 清理（`session.close().catch()`、`rm(...).catch()`、abort 时的 `cancelStream`）、ENOENT 忽略、controlled-promise 的 `void p.catch()` 防 unhandledRejection——这些是**对的**，不动。
- 修真 bug 优先能写出**失败测试**再修；改我没写过的代码时汇报里标注可回滚。

## 方法论：审计类别
1. **悬空 promise**：async 调用作为语句、无 `void`/`await`/`.catch` → 真正的 unhandledRejection 风险（进程级崩溃）。
2. **资源泄漏（错误路径）**：文件句柄 `open()` 未在 `finally` 里 `close()`；`setInterval`/`setTimeout` 出错未 `clear`；`addEventListener`/`.on()` 未移除；子进程未 kill。
3. **吞掉真实失败**：空 `catch {}` 掩盖用户需知道的错误（区别于 best-effort）。
4. **错误上下文丢失**：rethrow 不带 `cause`；泛化 catch 把可恢复与致命混为一谈。
5. **错误路径测试覆盖**：错误分支往往比 happy path 少测——补测即价值。

## 发现与状态

| # | 位置 | 类别 | 状态 |
|---|------|------|------|
| 0 | 首轮吞错扫描基线 | 审计 | ✅ 已审：`ltod/generate.ts` cancelStream 的空 catch、`loop/tool-scheduler.ts` 的 `void result.catch()`、`rpc`/`session-store`/`mcp/oauth` 的 `.close()/.rm().catch()` **均为有意 best-effort，非 bug**。防御纪律良好 |
| 1 | 悬空 promise | 悬空 promise | ✅ **结构性杜绝**：实测 `oxlint --type-aware` 默认启用 `no-floating-promises`（探针文件被拦），且全仓 lint 常绿（CI+pre-commit）→ 悬空 promise 不可能存在 |
| 2 | 资源泄漏：`open()` 句柄 / 定时器 / 监听器 | 资源泄漏 | ✅ 已审，无泄漏。所有 `open()/openSync()` 均 try/finally close（含 blobref/persistence/clock/oauth-store，clock 的 finally 在 catch 早返前执行）；cron scheduler `setInterval` 有 `clearInterval` on stop + `unref()`；TUI 定时器为私有字段随组件生命周期清理 |
| 3 | 空 `catch {}` 逐个判定：hooks/engine、hooks/runner、self-healing、rpc/core-impl、logging/sinks | 吞错 | ⬜ 待判：区分有意 vs 掩盖真实失败 |
| 4 | 关键错误分支的测试覆盖 | 错误路径覆盖 | 🔵 进行中——**主交付模式**（见下）。首个目标：compaction 熔断器（`compaction_circuit_open`，连续 3 次失败后本回合禁用自动压缩）未直接测；需非阻塞多步压缩失败的 harness 设置 |

## 进度日志
- **2026-07-07 · 建立 GOAL 追踪**（本文件），承接 Windows 加固。首轮吞错扫描基线（#0）：确认本仓防御纪律良好，采样到的吞错模式均为有意 best-effort。下一步：#1（悬空 promise，崩溃风险最高）→ #2（资源泄漏）。
- **2026-07-07 · 审计 #1 + #2，均结构性/纪律性干净**。#1：实测 lint 默认拦悬空 promise（探针验证），全仓常绿→不可能存在。#2：文件句柄全 try/finally、定时器全 clear+unref，无泄漏。**结论：本仓运行时健壮性工程本身已很优秀，bug-hunting 产出稀少。**因此本目标**主交付模式转为 #4 错误路径测试覆盖**——锁定"正确但少测"的错误处理，防回归。下一步（下一轮，需专注 harness）：给 compaction 熔断器补测——`testAgent` 多步回合 + 非阻塞压缩连续失败 3 次 → 断言 `compaction_circuit_open` 警告 + 后续自动压缩被跳过；成功/新回合应重置。参考现有 `compaction.test.ts:620`（单次阻塞失败）。
