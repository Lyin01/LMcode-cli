/**
 * Purge（dsh-purge 的 LMcode 适配版）共享类型。
 *
 * 主进程实现、preload 透传、渲染层消费都以此为准，避免三处定义漂移。
 */

export interface PurgeRule {
  readonly id: string
  readonly bytes: number
  readonly enabled: boolean
}

export interface PurgeSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly path: string
}

export interface PurgeStatus {
  readonly home: string
  readonly target: string
  readonly targetExists: boolean
  readonly promptPath: string
  readonly promptText: string
  readonly promptBytes: number
  readonly rules: readonly PurgeRule[]
  readonly enabledRules: readonly string[]
  readonly blockPresent: boolean
  readonly blockBytes: number
  readonly unterminated: boolean
  /** 配置与 AGENTS.md 的覆盖段不一致（需要 apply）。 */
  readonly drift: boolean
  /** prompt 与已启用规则都为空：apply 不会写入任何内容。 */
  readonly empty: boolean
  readonly appliedAt: string | null
  readonly backups: readonly string[]
  readonly skillsRoot: string
}

export interface PurgeApplyResult {
  readonly changed: boolean
  readonly message: string
  readonly backupPath?: string
  readonly status: PurgeStatus
}

export interface PurgeRevertInput {
  /** true：用最近备份整份还原；false：只移除覆盖段，保留用户自己的内容。 */
  readonly restore: boolean
}
