# @lmcode-cli/migration-legacy

> **已弃用（deprecated）— 将在 v1.0 移除。**

把旧版 lmcode-cli 的数据（`~/.lmcode/` 时代的会话、配置）迁移到 LMcode（`~/.lmcode/`）的一次性工具。由 `apps/lmcode/src/migration/` 在启动时检测并触发。

## 日落时间表

| 阶段 | 版本 | 状态 |
| ---- | ---- | ---- |
| 冻结：不再新增迁移逻辑 | 0.8.x | ✅ 已生效（见 AGENTS.md） |
| 维护：仅修复阻断性 bug | 0.8.x – 0.x 末期 | 当前阶段 |
| 移除：包及启动检测一并删除 | v1.0 | 计划中 |

## 对用户的影响

- **从 lmcode-cli 或 LMcode < 0.8 升级**：请先升级到任意 0.8.x – 0.x 版本完成数据迁移，再升级到 1.0+。
- **1.0+ 直接安装的新用户**：不受影响，此包与你无关。

## 对贡献者

不要在此包中添加任何新迁移逻辑；新的数据格式变更应通过 `packages/agent-core` 内的版本化存储升级路径处理。移除时需同步删除 `apps/lmcode/src/migration/` 的启动检测与 `@lmcode-cli/migration-legacy` 的 workspace 引用。
