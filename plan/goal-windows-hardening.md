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
| 2 | `channel-setup.ts` 与 `tui/commands/cc-connect.ts` 的 detectLmcodePath 近重复、已发生分叉（正是 #1 根因） | 重复/防复发 | ✅ 已修 `0e294f5`：抽 `cli/lm-path.ts`（`lmPathLookupCommand` + `resolveLmOnPath`），两处共用，纯函数单测钉住 where/which 选择 |
| 3 | 全仓多处 `node:path` 直接导入（plugin/*、config/identity、node-sdk/catalog、apps/* 等） | 路径 | ✅ 已审，无额外确定 bug。plugin/* 的包含性检查用 `path.sep`/`path.relative` 一致（含 zip-slip 防护）；identity/catalog 键的是模型串非路径；`tool-call-format.ts` 甚至处理了 Windows 跨盘符 `relative()`。唯一真·混用 bug（原生 workDir vs `/` home）已作 #5 修复。self-healing 有 win32 分支。**结论：pathe/node:path 分工纪律良好** |
| 4 | `tools/builtin/shell/bash.ts` 跨平台命令构造（`type -P`、`/dev/null`、python 探测、`WINDOWS_NUL_REDIRECT`） | Shell | ✅ 已审，无确定 bug。Win 走 Git Bash（`jian/environment.ts` 全面探测：`LMCODE_SHELL_PATH` 覆盖→git.exe 推断→scoop walk-up→PATH bash.exe→知名安装根，找不到抛 `JianShellNotFoundError` 带安装提示）；`WINDOWS_NUL_REDIRECT` 转 `NUL`→`/dev/null`、`windowsPathToPosixPath` 转 cwd。测试充分（environment.test 29 处 win32 断言 + 专门的 bash-windows-kill.test） |
| 5 | `footer.ts` / `session-picker.ts` 用 `process.env.HOME`（Win 上 undefined）+ `/` 分隔符做 home 别名 → Win 上 `~` 与 footer 截断全失效，显示完整原生长路径 | 临时/home + 路径 | ✅ 已修 `2be80ed`：抽 `tui/utils/path-display.ts` 的 `aliasHome`（os.homedir + 正斜杠视图 + home 可注入），两处共用，10 用例。`/tmp` 扫描仅命中注释，无隐患 |
| 6 | 文件锁 EPERM/EBUSY：审计所有 rename/unlink 点 | 文件锁 | ✅ 已审，无确定 bug。`logging/sinks.ts` 日志轮转安全（每次 append 开/关文件，轮转时不持有句柄）；`memory/store.ts` rename 已 `.catch`。**潜在项**（非 bug）：`mcp/oauth/store.ts`、`plugin/store.ts` 各自实现"写 tmp→rename"原子写，但未带 `fs.ts atomicWrite` 的 Windows pre-unlink——因 Node `fs.rename` 在 Win 上会替换**已关闭**的目标（MoveFileEx），仅当目标被并发持有才失败。建议后续统一收敛到 `atomicWrite`；oauth 属安全敏感，不做自动 drive-by。 |

**已确认安全（无需动）**：
- `utils/workdir-slug.ts` + `session/store/workdir-key.ts`：保留名/尾点被 `wd_<slug>_<hash>` 包裹中和。
- `memory/extractor.ts` parseMemoryMemos：CRLF 实测通过（见 `extractor.test.ts`）。
- `utils/fs.ts` atomicWrite：Windows pre-unlink + MoveFileEx 语义已处理。

## 补充发现（首轮后继续挖到的真 bug）
- **plugin 子系统审计（2026-07-10）**：整体工程质量高——zip-slip 防护正确（`path.sep` 包含性检查）、staging 建在目标同目录（无 EXDEV）、tmpDir 清理在 finally、github-resolver 的 redirect/配额/ref 编码全部严谨。唯一真缺陷已修 `7dabac7`：`downloadZip` 的 `signal ?? timeout` 会在调用方传 signal 时**静默丢掉 10 分钟超时**（当前无生产调用传 signal，属潜在陷阱）；改用 `AbortSignal.any` 合并。**边缘子系统扫荡至此覆盖：MCP、LSP、update、plugin**。
- **自更新在 Windows 必坏且留撕裂状态 + LMCODE_HOME 目录错位**（`9d70566` 已修）：`installUpdate` 裸 spawn `pnpm`（.cmd shim → ENOENT，本机实证），且死在 `git pull` 成功**之后**——克隆目录留下"新源码+旧依赖/旧 dist"的半升级状态。修法：`cmd.exe /c` argv 包装（不用 `shell:true`，Node 已对 args 数组形式发 DEP0190 弃用警告，实测会打到用户终端）。第二个 bug：installDir 写死 `~/.lmcode` 而检测尊重 `LMCODE_HOME` → 检测说可更新、更新却跑错目录；抽 `resolveSourceInstallDir()` 作为唯一权威。顺带：Windows 手动升级提示从 `./install.sh` 改为 `install.ps1`。**规律确认**：这是同一 bug 类的第 3 例（MCP→LSP→update），全仓 spawn 点已扫尽。
- **LSP 语言服务器（TS/Python）在 Windows 全启不动**（`e34bf96` 已修，v0.9.8 后）：与 MCP 同类——`LspClient` 经 `jian.exec`（shell-less spawn）启动 `typescript-language-server`/`pyright-langserver`，它们是 npm `.cmd` shim → 裸名 ENOENT / 直接路径 EINVAL（Node CVE-2024-27980 防护）。rust-analyzer/gopls（真 .exe）不受影响。修法：MCP 适配器提升为共享 `utils/spawn-command.ts`（防两处分叉），LSP 按 `jian.osEnv.osKind`（而非本机 platform）判 Windows。本机实证：直 spawn `.cmd` → EINVAL；`cmd.exe /c` → exit 0。**审计余项**：全仓其余 `jian.exec`/spawn 调用方（git、rg、taskkill）都是真二进制，无同类隐患。
- **MCP stdio 服务在 Windows 全启不动**（`f867f8b` 已修）：MCP SDK 的 transport 用 `shell:false` spawn，Node 无法执行 `npx/npm/pnpm/yarn` 解析到的 `.cmd`/`.bat` shim（`spawn('npx')` → ENOENT，libuv 只补 `.exe` 不补 PATHEXT）。而绝大多数 MCP 服务都是 `npx -y @scope/server` 启动 → **Windows 主用户群的 MCP 功能静默失效**。修法：`client-stdio.ts` 加 `adaptStdioCommandForWindows`，非 `.exe` 命令包 `cmd.exe /c`；单测 + Windows-only 集成测试（真 `.cmd` shim 连通）。本机实测 `spawn('npx',{shell:false})` 复现 ENOENT。

## 进度日志
- **2026-07-06 · 建立 GOAL 追踪**（本文件）。修复 #1（channel-setup Windows PATH 解析）。下一步：#5/#6 快速扫（低风险、易验证），再啃 #2（抽 helper 防复发）与 #4（bash 工具审计）。
- **2026-07-07 · 修复 #5**（footer/session-picker 的 home 别名在 Windows 全失效）。同时消除了这两处 home-aliasing 的重复（抽 `aliasHome` 共享）——与 #2 同类的分叉隐患又少一处。
- **2026-07-07 · 审计 #6**（文件锁/rename）：无确定 bug；记下 oauth/store、plugin/store 未收敛到 `atomicWrite` 的潜在项。
- **2026-07-07 · 审计 #3 + 修复 #2**：#3（`node:path`）审计判定纪律良好、无额外确定 bug（详见表）。#2 收掉 detectLmcodePath 分叉——抽 `cli/lm-path.ts` 两处共用 + 纯函数单测。
- **2026-07-07 · 审计 #4，首轮全审计完成**：bash 工具/shell 探测成熟且测试充分，无确定 bug。

## 首轮全审计结论
所有方法论类别已覆盖：
- **修复 3 个真·Windows bug（均已测试）**：#1 channel-setup PATH 解析、#5 TUI home 别名、#2 PATH 解析分叉根因收敛。
- **审计判定已加固/无确定 bug**：#3 `node:path` 纪律、#4 bash 工具/Git Bash 探测、#6 文件锁。
- **潜在项（非 bug，留待考量）**：#6 的 `mcp/oauth/store.ts`、`plugin/store.ts` 未收敛到 `atomicWrite`（安全敏感，不做自动 drive-by）。

**净效果**：Windows（主用户群/红线）与 POSIX 行为一致性显著提升，无静默降级。分支 `auto/loop-iterations`，`main` 干净。后续若继续深挖，可从 #6 潜在项的 `atomicWrite` 收敛、或更细的 CRLF/长路径/大小写边角入手（均为收益递减项）。
