/**
 * PurgeService —— dsh-purge「清洗」能力在 LMcode 桌面端的本地实现。
 *
 * dsh-purge 改的是 dsh 宿主包与 prompt-inject.md；LMcode 没有同构文件，等价
 * 注入点是用户级 `~/.lmcode/AGENTS.md`（每个会话自动读取）。本服务只维护该
 * 文件里的一段标记块：
 *
 *   <!-- lmd-purge:begin v1 --> … <!-- lmd-purge:end -->
 *
 * 块外内容一律不动；每次改动前备份到 `~/.lmcode/purge/backup/`。
 * 不触碰审批、沙箱、工具权限等宿主安全开关。
 */

import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

import type {
  PurgeApplyResult,
  PurgeRule,
  PurgeSkill,
  PurgeStatus,
} from '../../shared/purge-types.js'

export const PURGE_BEGIN = '<!-- lmd-purge:begin v1 -->'
export const PURGE_END = '<!-- lmd-purge:end -->'

const MARKER_TITLE = '## LMD Purge 覆盖段'
const MAX_BACKUPS = 5
const RULE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const SKILL_SCAN_LIMIT = 200

export interface PurgeServiceOptions {
  /**
   * LMcode 用户主目录。**不要**传桌面端的 harness.homeDir —— 那是 Electron
   * userData（AppData\Roaming\LMCODE），而 AGENTS.md 只在 `~/.lmcode` 被读取。
   * 缺省时按 `LMCODE_HOME` → `~/.lmcode` 解析，与 agent-core 一致。
   */
  readonly homeDir?: string
  /** 技能目录；默认 ~/.agents/skills（与 agent-core 的用户技能根一致）。 */
  readonly skillsDir?: string
  /** 测试注入时钟。 */
  readonly now?: () => Date
}

interface PurgePaths {
  readonly home: string
  readonly purge: string
  readonly prompt: string
  readonly rules: string
  readonly state: string
  readonly backup: string
  readonly target: string
  readonly skills: string
}

interface PurgeState {
  readonly version: 1
  readonly enabledRules: readonly string[]
  readonly appliedAt: string | null
  readonly appliedHash: string | null
  readonly blockBytes: number
}

const EMPTY_STATE: PurgeState = {
  version: 1,
  enabledRules: [],
  appliedAt: null,
  appliedHash: null,
  blockBytes: 0,
}

const PROMPT_TEMPLATE = [
  '<!--',
  '  会话覆盖段正文。只有正文（非注释部分）会被注入到 ~/.lmcode/AGENTS.md。',
  '  改完点「应用」或运行 node bin/lmd-purge.mjs apply。',
  '-->',
  '',
].join('\n')

export function resolvePurgePaths(options: PurgeServiceOptions): PurgePaths {
  const configured = (options.homeDir ?? '').trim()
  const fromEnv = (process.env['LMCODE_HOME'] ?? '').trim()
  const home = resolve(
    configured !== '' ? configured : fromEnv !== '' ? fromEnv : join(homedir(), '.lmcode'),
  )
  const purge = join(home, 'purge')
  const skills = resolve(
    options.skillsDir ?? join(homedir(), '.agents', 'skills'),
  )
  return {
    home,
    purge,
    prompt: join(purge, 'prompt.md'),
    rules: join(purge, 'rules'),
    state: join(purge, 'state.json'),
    backup: join(purge, 'backup'),
    target: join(home, 'AGENTS.md'),
    skills,
  }
}

export class PurgeService {
  private readonly options: PurgeServiceOptions

  constructor(options: PurgeServiceOptions) {
    this.options = options
  }

  private get paths(): PurgePaths {
    return resolvePurgePaths(this.options)
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  // ── 状态 ──────────────────────────────────────────────────────

  async status(): Promise<PurgeStatus> {
    const paths = this.paths
    const state = await this.readState()
    const promptText = await this.readPrompt()
    const current = await this.readTarget()
    const currentLf = toLf(current)
    const found = findBlock(currentLf)
    const block = await this.buildBlock()
    const rules = await this.listRules()
    const backups = await this.listBackups()

    const blockSlice = found === null ? '' : currentLf.slice(found.start, found.end)
    const drift =
      block === null ? found !== null : found === null || blockSlice !== block.trimEnd()

    return {
      home: paths.home,
      target: paths.target,
      targetExists: current.length > 0,
      promptPath: paths.prompt,
      promptText,
      promptBytes: Buffer.byteLength(promptText, 'utf8'),
      rules,
      enabledRules: state.enabledRules,
      blockPresent: found !== null,
      blockBytes: Buffer.byteLength(blockSlice, 'utf8'),
      unterminated: found?.unterminated ?? false,
      drift,
      empty: block === null,
      appliedAt: state.appliedAt,
      backups,
      skillsRoot: paths.skills,
    }
  }

  // ── 提示词 ────────────────────────────────────────────────────

  async readPrompt(): Promise<string> {
    return readTextOr(this.paths.prompt, '')
  }

  async savePrompt(text: string): Promise<PurgeStatus> {
    const paths = this.paths
    await mkdir(paths.purge, { recursive: true })
    await writeFileAtomic(paths.prompt, normaliseToLf(text))
    return this.status()
  }

  /** 重置为只带说明注释的模板（等价于清空）。 */
  async clearPrompt(): Promise<PurgeStatus> {
    return this.savePrompt(PROMPT_TEMPLATE)
  }

  // ── 应用 / 还原 ───────────────────────────────────────────────

  async apply(): Promise<PurgeApplyResult> {
    const paths = this.paths
    const state = await this.readState()
    const block = await this.buildBlock()
    const current = await this.readTarget()
    const eol = current.includes('\r\n') ? '\r\n' : '\n'
    const stripped = stripBlock(toLf(current))

    if (block === null) {
      if (!stripped.removed) {
        return {
          changed: false,
          message: '提示词与已启用规则都是空的，没有内容可注入。',
          status: await this.status(),
        }
      }
      const backupPath = await this.backup(current)
      await writeFileAtomic(paths.target, toEol(stripped.text, eol))
      await this.writeState({ ...state, appliedAt: null, appliedHash: null, blockBytes: 0 })
      return {
        changed: true,
        message: '内容为空，已移除覆盖段。',
        backupPath,
        status: await this.status(),
      }
    }

    const base = stripped.text.length > 0 ? `${stripped.text.replace(/\s*$/, '')}\n\n` : ''
    const next = toEol(`${base}${block}`, eol)

    if (next === current) {
      if (state.appliedAt === null) {
        await this.writeState({ ...state, appliedAt: this.now().toISOString() })
      }
      return {
        changed: false,
        message: '已是最新：AGENTS.md 的覆盖段与当前配置一致。',
        status: await this.status(),
      }
    }

    const backupPath = await this.backup(current)
    await writeFileAtomic(paths.target, next)
    await this.writeState({
      ...state,
      appliedAt: this.now().toISOString(),
      appliedHash: hash(block),
      blockBytes: Buffer.byteLength(block, 'utf8'),
    })
    return {
      changed: true,
      message: `已写入覆盖段（${Buffer.byteLength(block, 'utf8')} 字节）。新会话生效，无需重启。`,
      backupPath,
      status: await this.status(),
    }
  }

  async revert(input: { restore: boolean }): Promise<PurgeApplyResult> {
    const paths = this.paths
    const current = await this.readTarget()
    const eol = current.includes('\r\n') ? '\r\n' : '\n'

    if (input.restore) {
      const backups = await this.listBackups()
      const latest = backups[backups.length - 1]
      if (latest === undefined) {
        throw new Error('没有可用备份：请改用「移除覆盖段」。')
      }
      const content = await readFile(join(paths.backup, latest), 'utf8')
      await writeFileAtomic(paths.target, content)
      const state = await this.readState()
      await this.writeState({ ...EMPTY_STATE, enabledRules: state.enabledRules })
      return {
        changed: true,
        message: `已从备份还原：${latest}`,
        status: await this.status(),
      }
    }

    const stripped = stripBlock(toLf(current))
    if (!stripped.removed) {
      return {
        changed: false,
        message: '没有找到覆盖段，AGENTS.md 未改动。',
        status: await this.status(),
      }
    }

    const backupPath = await this.backup(current)
    await writeFileAtomic(paths.target, toEol(stripped.text, eol))
    const state = await this.readState()
    await this.writeState({ ...EMPTY_STATE, enabledRules: state.enabledRules })
    return {
      changed: true,
      message: stripped.unterminated
        ? '覆盖段缺少结束标记，已按"截到文件末尾"处理。'
        : '已移除覆盖段，你自己的内容保留。',
      backupPath,
      status: await this.status(),
    }
  }

  // ── 规则库 ────────────────────────────────────────────────────

  async listRules(): Promise<readonly PurgeRule[]> {
    const paths = this.paths
    if (!existsSync(paths.rules)) return []
    const state = await this.readState()
    const entries = await readdir(paths.rules, { withFileTypes: true })
    const rules: PurgeRule[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      const id = entry.name.slice(0, -3)
      const body = await readTextOr(join(paths.rules, entry.name), '')
      rules.push({
        id,
        bytes: Buffer.byteLength(body, 'utf8'),
        enabled: state.enabledRules.includes(id),
      })
    }
    return rules.sort((a, b) => a.id.localeCompare(b.id))
  }

  async saveRule(id: string, body: string): Promise<PurgeStatus> {
    assertRuleId(id)
    if (body.trim().length === 0) throw new Error('规则内容不能为空')
    const paths = this.paths
    await mkdir(paths.rules, { recursive: true })
    await writeFileAtomic(join(paths.rules, `${id}.md`), normaliseToLf(body))
    return this.status()
  }

  async setRuleEnabled(id: string, enabled: boolean): Promise<PurgeStatus> {
    assertRuleId(id)
    const paths = this.paths
    if (enabled && !existsSync(join(paths.rules, `${id}.md`))) {
      throw new Error(`规则 "${id}" 不存在`)
    }
    const state = await this.readState()
    const next = new Set(state.enabledRules)
    if (enabled) next.add(id)
    else next.delete(id)
    await this.writeState({ ...state, enabledRules: [...next].sort((a, b) => a.localeCompare(b)) })
    return this.status()
  }

  async deleteRule(id: string): Promise<PurgeStatus> {
    assertRuleId(id)
    const state = await this.readState()
    await rm(join(this.paths.rules, `${id}.md`), { force: true })
    await this.writeState({
      ...state,
      enabledRules: state.enabledRules.filter((rule) => rule !== id),
    })
    return this.status()
  }

  // ── 技能 ──────────────────────────────────────────────────────

  async listSkills(): Promise<readonly PurgeSkill[]> {
    return readSkillDirs(this.paths.skills)
  }

  async importSkill(sourceDir: string): Promise<PurgeStatus> {
    const paths = this.paths
    const source = resolve(sourceDir)
    const info = await stat(source)
    if (!info.isDirectory()) throw new Error(`不是目录：${source}`)
    if (!existsSync(join(source, 'SKILL.md'))) {
      throw new Error(`目录里没有 SKILL.md：${source}`)
    }
    const id = sanitiseSkillId(source.split(/[\\/]/).pop() ?? 'skill')
    const dest = join(paths.skills, id)
    assertInside(paths.skills, dest)
    await mkdir(paths.skills, { recursive: true })
    await rm(dest, { recursive: true, force: true })
    await cp(source, dest, { recursive: true })
    return this.status()
  }

  async deleteSkill(id: string): Promise<PurgeStatus> {
    const paths = this.paths
    const dest = join(paths.skills, sanitiseSkillId(id))
    assertInside(paths.skills, dest)
    if (!existsSync(dest)) throw new Error(`技能不存在：${id}`)
    await rm(dest, { recursive: true, force: true })
    return this.status()
  }

  // ── 内部 ──────────────────────────────────────────────────────

  private async readTarget(): Promise<string> {
    return readTextOr(this.paths.target, '')
  }

  private async readState(): Promise<PurgeState> {
    const raw = await readTextOr(this.paths.state, '')
    if (raw.trim() === '') return EMPTY_STATE
    try {
      const parsed = JSON.parse(raw) as Partial<PurgeState>
      return {
        version: 1,
        enabledRules: Array.isArray(parsed.enabledRules)
          ? parsed.enabledRules.filter((item): item is string => typeof item === 'string')
          : [],
        appliedAt: typeof parsed.appliedAt === 'string' ? parsed.appliedAt : null,
        appliedHash: typeof parsed.appliedHash === 'string' ? parsed.appliedHash : null,
        blockBytes: typeof parsed.blockBytes === 'number' ? parsed.blockBytes : 0,
      }
    } catch (error) {
      throw new Error(`state.json 不是合法 JSON：${(error as Error).message}`)
    }
  }

  private async writeState(state: PurgeState): Promise<void> {
    const paths = this.paths
    await mkdir(paths.purge, { recursive: true })
    await writeFileAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`)
  }

  private async buildBlock(): Promise<string | null> {
    const promptText = stripHtmlComments(await this.readPrompt()).trim()
    const state = await this.readState()
    const sections: string[] = []
    if (promptText.length > 0) sections.push(promptText)
    for (const id of state.enabledRules) {
      const body = (await readTextOr(join(this.paths.rules, `${id}.md`), '')).trim()
      if (body.length === 0) continue
      sections.push(`### 规则：${id}\n\n${body}`)
    }
    if (sections.length === 0) return null
    const header = [
      PURGE_BEGIN,
      MARKER_TITLE,
      '<!-- 本段由 LMD Purge 生成：在「清洗」里改提示词/规则后重新应用。手改会被覆盖。 -->',
    ].join('\n')
    return `${header}\n\n${sections.join('\n\n')}\n\n${PURGE_END}\n`
  }

  private async listBackups(): Promise<readonly string[]> {
    const dir = this.paths.backup
    if (!existsSync(dir)) return []
    return (await readdir(dir))
      .filter((name) => name.startsWith('AGENTS.md.') && name.endsWith('.bak'))
      .sort()
  }

  private async backup(content: string): Promise<string> {
    const dir = this.paths.backup
    await mkdir(dir, { recursive: true })
    const stamp = formatStamp(this.now())
    const file = join(dir, `AGENTS.md.${stamp}.bak`)
    await writeFile(file, content, 'utf8')
    const all = (await readdir(dir))
      .filter((name) => name.startsWith('AGENTS.md.') && name.endsWith('.bak'))
      .sort()
    for (const stale of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) {
      await rm(join(dir, stale), { force: true })
    }
    return file
  }
}

// ---------------------------------------------------------------------------
// 纯函数（导出供测试）
// ---------------------------------------------------------------------------

export function findBlock(text: string): { start: number; end: number; unterminated: boolean } | null {
  const start = text.indexOf(PURGE_BEGIN)
  if (start === -1) return null
  const endIndex = text.indexOf(PURGE_END, start)
  if (endIndex === -1) return { start, end: text.length, unterminated: true }
  return { start, end: endIndex + PURGE_END.length, unterminated: false }
}

export function stripBlock(text: string): {
  text: string
  removed: boolean
  unterminated: boolean
} {
  const found = findBlock(text)
  if (found === null) return { text, removed: false, unterminated: false }
  const before = text.slice(0, found.start).replace(/[ \t]+$/gm, '')
  const after = text.slice(found.end)
  let merged = `${before}${after}`
  merged = merged.replace(/\n{3,}/g, '\n\n')
  merged = merged.replace(/^\s*\n/, '')
  merged = merged.trimEnd()
  return {
    text: merged.length > 0 ? `${merged}\n` : '',
    removed: true,
    unterminated: found.unterminated,
  }
}

export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

function assertRuleId(id: string): void {
  if (!RULE_ID_PATTERN.test(id)) {
    throw new Error(`规则 id 只能包含字母、数字、点、下划线、短横线："${id}"`)
  }
}

function sanitiseSkillId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '-')
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    throw new Error(`非法技能名："${raw}"`)
  }
  return cleaned
}

function assertInside(root: string, candidate: string): void {
  const normalisedRoot = resolve(root)
  const normalised = resolve(candidate)
  if (normalised !== normalisedRoot && !normalised.startsWith(`${normalisedRoot}${sep}`)) {
    throw new Error(`路径越界：${candidate}`)
  }
}

function formatStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    '-',
    String(date.getMilliseconds()).padStart(3, '0'),
  ].join('')
}

function hash(text: string): string {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value.toString(16).padStart(8, '0')
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function toEol(text: string, eol: string): string {
  return eol === '\r\n' ? text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : toLf(text)
}

function normaliseToLf(text: string): string {
  return toLf(text)
}

async function readTextOr(file: string, fallback: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

async function writeFileAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
}

async function readSkillDirs(root: string): Promise<readonly PurgeSkill[]> {
  if (!existsSync(root)) return []
  const entries = await readdir(root, { withFileTypes: true })
  const skills: PurgeSkill[] = []
  for (const entry of entries.slice(0, SKILL_SCAN_LIMIT)) {
    if (!entry.isDirectory()) continue
    const skillMd = join(root, entry.name, 'SKILL.md')
    if (!existsSync(skillMd)) continue
    const head = (await readTextOr(skillMd, '')).slice(0, 4000)
    skills.push({
      id: entry.name,
      name: frontmatterValue(head, 'name') ?? entry.name,
      description: frontmatterValue(head, 'description') ?? '',
      path: join(root, entry.name),
    })
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id))
}

function frontmatterValue(text: string, key: string): string | undefined {
  const pattern = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm')
  const match = pattern.exec(text)
  const raw = match?.[1]?.trim()
  return raw === undefined || raw === '' ? undefined : raw
}
