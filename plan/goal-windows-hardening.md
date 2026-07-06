# GOAL: Windows 兼容性加固

**模式**：GOAL 模式（`/loop` 自迭代驱动）。本文件是**唯一权威进度源**，跨轮次、跨上下文压缩持久化。每轮开始先读它，结束前更新它。

**目标**：系统性排查并消除 LMcode 全仓的跨平台隐患，让 Windows（主用户群、宪法红线）与 POSIX 行为一致、无静默降级。

**分支**：`auto/loop-iterations`（`main` 保持干净）。

## 护栏（不可违反）
- 主干常绿：每步都要 lint + typecheck/test 通过才提交。
- 每步一个聚焦、可验证的 commit；能在 Windows 上真实复现的 bug，必须先复现再修、修后再验证（用 cmd.exe / PowerShell 实测，而非空想）。
- 只改真实隐患；已被现有 win32 分支/前缀/哈希妥善处理的，不动、不制造伪问题。
- 改动我没写过的代码时，在汇报里显式标注可回滚。

## 方法论：审计类别
1. **Shell / 进程**：`execSync`/`spawn` 里的命令是否 POSIX-only（`which`/`/dev/null`/`&&`/引号/`type -P`）。
2. **路径**：`node:path`（OS 分隔符）vs `pathe`（恒 `/`）。路径当 **key/比较/持久化** 时用 OS 分隔符 = 隐患；纯 fs 操作则无碍。
3. **行尾**：解析文件/模型输出时对 `\n` 的硬假设（CRLF）。
4. **保留名 / 非法字符**：`CON`/`NUL`/尾点/`:` 等作为文件名。
5. **文件锁 / EPERM / EBUSY**：rename/unlink 前是否处理 Windows 独占句柄。
6. **临时目录 / home**：`/tmp`、`process.env.HOME`（Win 用 `USERPROFILE`）硬编码。
7. **可执行扩展名 / PATHEXT**：`.exe`/`.cmd`/`.ps1` 解析。
8. **大小写敏感**：路径比较。

## 发现与状态

| # | 位置 | 类别 | 状态 |
|---|------|------|------|
| 1 | `apps/lmcode/src/cli/channel-setup.ts` detectLmcodePath 用 `which lm 2>/dev/null` 无条件执行 → Win 上永远抛错、静默降级到裸 `lm` | Shell | ✅ 已修 `dec5d8c`（cmd.exe 实测复现+验证） |
| 2 | `channel-setup.ts` 与 `tui/commands/cc-connect.ts` 的 detectLmcodePath 近重复、已发生分叉（正是 #1 根因） | 重复/防复发 | ⬜ 待办：抽共享 PATH 解析 helper，两处共用 |
| 3 | 全仓多处 `node:path` 直接导入（plugin/*、config/identity、node-sdk/catalog、apps/* 等） | 路径 | ⬜ 待审：逐个分类"当 key/比较" vs "纯 fs 操作"，只修前者 |
| 4 | `tools/builtin/shell/bash.ts` 跨平台命令构造（`type -P`、`/dev/null`、python 探测、`WINDOWS_NUL_REDIRECT`） | Shell | ⬜ 待审：确认 Windows 下 bash 工具的 shell 选择与降级路径 |
| 5 | `footer.ts` / `session-picker.ts` 用 `process.env.HOME`（Win 上 undefined）+ `/` 分隔符做 home 别名 → Win 上 `~` 与 footer 截断全失效，显示完整原生长路径 | 临时/home + 路径 | ✅ 已修 `2be80ed`：抽 `tui/utils/path-display.ts` 的 `aliasHome`（os.homedir + 正斜杠视图 + home 可注入），两处共用，10 用例。`/tmp` 扫描仅命中注释，无隐患 |
| 6 | 文件锁 EPERM/EBUSY：审计所有 rename/unlink 点 | 文件锁 | ✅ 已审，无确定 bug。`logging/sinks.ts` 日志轮转安全（每次 append 开/关文件，轮转时不持有句柄）；`memory/store.ts` rename 已 `.catch`。**潜在项**（非 bug）：`mcp/oauth/store.ts`、`plugin/store.ts` 各自实现"写 tmp→rename"原子写，但未带 `fs.ts atomicWrite` 的 Windows pre-unlink——因 Node `fs.rename` 在 Win 上会替换**已关闭**的目标（MoveFileEx），仅当目标被并发持有才失败。建议后续统一收敛到 `atomicWrite`；oauth 属安全敏感，不做自动 drive-by。 |

**已确认安全（无需动）**：
- `utils/workdir-slug.ts` + `session/store/workdir-key.ts`：保留名/尾点被 `wd_<slug>_<hash>` 包裹中和。
- `memory/extractor.ts` parseMemoryMemos：CRLF 实测通过（见 `extractor.test.ts`）。
- `utils/fs.ts` atomicWrite：Windows pre-unlink + MoveFileEx 语义已处理。

## 进度日志
- **2026-07-06 · 建立 GOAL 追踪**（本文件）。修复 #1（channel-setup Windows PATH 解析）。下一步：#5/#6 快速扫（低风险、易验证），再啃 #2（抽 helper 防复发）与 #4（bash 工具审计）。
- **2026-07-07 · 修复 #5**（footer/session-picker 的 home 别名在 Windows 全失效）。同时消除了这两处 home-aliasing 的重复（抽 `aliasHome` 共享）——与 #2 同类的分叉隐患又少一处。
- **2026-07-07 · 审计 #6**（文件锁/rename）：无确定 bug；记下 oauth/store、plugin/store 未收敛到 `atomicWrite` 的潜在项。下一步：#3（`node:path` 逐个分类，最可能藏"路径当 key"的真 bug）、#4（bash 工具跨平台），以及 #2（抽共享 PATH 解析 helper 收掉 detectLmcodePath 分叉）。
