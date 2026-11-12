import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  PURGE_BEGIN,
  PURGE_END,
  PurgeService,
  findBlock,
  resolvePurgePaths,
  stripBlock,
  stripHtmlComments,
} from '../src/main/purge/service.js'

describe('purge service', () => {
  let root: string
  let home: string
  let skills: string
  let service: PurgeService

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lmcode-purge-test-'))
    home = join(root, 'home')
    skills = join(root, 'skills')
    await mkdir(home, { recursive: true })
    service = new PurgeService({ homeDir: home, skillsDir: skills })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('starts empty and apply writes nothing', async () => {
    const status = await service.status()
    expect(status.empty).toBe(true)
    expect(status.blockPresent).toBe(false)

    const result = await service.apply()
    expect(result.changed).toBe(false)
    expect(existsSync(join(home, 'AGENTS.md'))).toBe(false)
  })

  it('writes a marked block and is idempotent', async () => {
    await service.savePrompt('# 覆盖段\n\n正文\n')
    const first = await service.apply()
    expect(first.changed).toBe(true)

    const text = await readFile(join(home, 'AGENTS.md'), 'utf8')
    expect(text).toContain(PURGE_BEGIN)
    expect(text).toContain(PURGE_END)
    expect(text).toContain('正文')

    const backupsBefore = (await readdir(join(home, 'purge', 'backup'))).length
    const second = await service.apply()
    expect(second.changed).toBe(false)
    expect((await readdir(join(home, 'purge', 'backup'))).length).toBe(backupsBefore)
  })

  it('keeps user content outside the block', async () => {
    await writeFile(join(home, 'AGENTS.md'), '# 用户约定\n\n不要删我。\n', 'utf8')
    await service.savePrompt('注入内容\n')
    await service.apply()

    const text = await readFile(join(home, 'AGENTS.md'), 'utf8')
    expect(text.startsWith('# 用户约定')).toBe(true)
    expect(text).toContain('不要删我。')
    expect(text.split(PURGE_BEGIN)).toHaveLength(2)
  })

  it('merges enabled rules and drops them when disabled', async () => {
    await service.savePrompt('提示词正文\n')
    await service.saveRule('house', 'RULE-BODY\n\n- 条目\n')
    await service.setRuleEnabled('house', true)
    await service.apply()

    let text = await readFile(join(home, 'AGENTS.md'), 'utf8')
    expect(text).toContain('### 规则：house')
    expect(text).toContain('RULE-BODY')

    await service.setRuleEnabled('house', false)
    await service.apply()
    text = await readFile(join(home, 'AGENTS.md'), 'utf8')
    expect(text).not.toContain('RULE-BODY')
    expect(text).toContain('提示词正文')
  })

  it('revert removes only the block', async () => {
    await writeFile(join(home, 'AGENTS.md'), '# 用户约定\n\n保留我。\n', 'utf8')
    await service.savePrompt('临时内容\n')
    await service.apply()

    const result = await service.revert({ restore: false })
    expect(result.changed).toBe(true)
    const text = await readFile(join(home, 'AGENTS.md'), 'utf8')
    expect(text).not.toContain(PURGE_BEGIN)
    expect(text).toContain('保留我。')
  })

  it('revert --restore brings the latest backup back', async () => {
    await writeFile(join(home, 'AGENTS.md'), '# 原始\n', 'utf8')
    await service.savePrompt('新的\n')
    await service.apply()

    const result = await service.revert({ restore: true })
    expect(result.changed).toBe(true)
    const text = await readFile(join(home, 'AGENTS.md'), 'utf8')
    expect(text).toBe('# 原始\n')
  })

  it('revert --restore backs up what it overwrites', async () => {
    await writeFile(join(home, 'AGENTS.md'), '# 原始\n', 'utf8')
    await service.savePrompt('新的\n')
    await service.apply()
    const applied = await readFile(join(home, 'AGENTS.md'), 'utf8')

    const result = await service.revert({ restore: true })
    expect(result.backupPath).toBeDefined()
    expect(await readFile(result.backupPath ?? '', 'utf8')).toBe(applied)
  })

  it('revert --restore is a no-op when the file already matches the backup', async () => {
    await writeFile(join(home, 'AGENTS.md'), '# 原始\n', 'utf8')
    await service.savePrompt('新的\n')
    await service.apply()
    await writeFile(join(home, 'AGENTS.md'), '# 原始\n', 'utf8')

    const before = await readdir(join(home, 'purge', 'backup'))
    const result = await service.revert({ restore: true })
    expect(result.changed).toBe(false)
    expect(await readdir(join(home, 'purge', 'backup'))).toEqual(before)
  })

  it('does not clobber two backups written in the same second', async () => {
    await writeFile(join(home, 'AGENTS.md'), 'v1\n', 'utf8')
    await service.savePrompt('第一版\n')
    await service.apply()
    await service.savePrompt('第二版\n')
    await service.apply()

    const backups = await readdir(join(home, 'purge', 'backup'))
    expect(backups.length).toBe(2)
  })

  it('preserves CRLF line endings', async () => {
    await writeFile(join(home, 'AGENTS.md'), '# 用户\r\n\r\n', 'utf8')
    await service.savePrompt('CRLF-BODY\n')
    await service.apply()

    const raw = await readFile(join(home, 'AGENTS.md'), 'utf8')
    expect(raw).toContain('\r\n')
    expect(/[^\r]\n/.test(raw)).toBe(false)
    expect(raw).toContain('CRLF-BODY')
  })

  it('treats comment-only prompts as empty', async () => {
    await service.savePrompt('<!-- 只有注释 -->\n')
    const result = await service.apply()
    expect(result.changed).toBe(false)
    expect(existsSync(join(home, 'AGENTS.md'))).toBe(false)
  })

  it('rejects unsafe rule ids and skill paths', async () => {
    await expect(service.saveRule('../escape', 'x')).rejects.toThrow()
    await expect(service.deleteSkill('../../etc')).rejects.toThrow()
  })

  it('imports and deletes a skill folder', async () => {
    const source = join(root, 'demo-skill')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'SKILL.md'), '---\nname: demo\ndescription: 测试\n---\n\n# Demo\n', 'utf8')

    await service.importSkill(source)
    const skills = await service.listSkills()
    expect(skills.map((skill) => skill.id)).toEqual(['demo-skill'])
    expect(skills[0]?.name).toBe('demo')

    await service.deleteSkill('demo-skill')
    expect(await service.listSkills()).toEqual([])
  })

  it('refuses to import a skill that already lives in the skills root', async () => {
    const existing = join(skills, 'demo-skill')
    await mkdir(existing, { recursive: true })
    await writeFile(join(existing, 'SKILL.md'), '---\nname: demo\n---\n', 'utf8')

    await expect(service.importSkill(existing)).rejects.toThrow('无需导入')
    // The source must survive: importing used to delete it before copying.
    expect(existsSync(join(existing, 'SKILL.md'))).toBe(true)
  })

  it('refuses a source folder that contains the skills root', async () => {
    await writeFile(join(root, 'SKILL.md'), 'outer\n', 'utf8')
    const nested = new PurgeService({ homeDir: home, skillsDir: root })
    // dest would be <root>/<basename(root)>, i.e. inside the source itself.
    await expect(nested.importSkill(root)).rejects.toThrow('无需导入')
    expect(await readFile(join(root, 'SKILL.md'), 'utf8')).toBe('outer\n')
  })

  it('keeps non-ASCII skill names distinct and deletable', async () => {
    for (const name of ['命理解读师', '中文小说家']) {
      const source = join(root, 'incoming', name)
      await mkdir(source, { recursive: true })
      await writeFile(join(source, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8')
      await service.importSkill(source)
    }
    const listed = await service.listSkills()
    expect(listed.map((skill) => skill.id).toSorted()).toEqual(['中文小说家', '命理解读师'])

    await service.deleteSkill('命理解读师')
    expect((await service.listSkills()).map((skill) => skill.id)).toEqual(['中文小说家'])
  })

  it('rejects skill names that could escape or hide', async () => {
    for (const id of ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'con:', 'trailing.', 'tab\there']) {
      await expect(service.deleteSkill(id)).rejects.toThrow('非法技能名')
    }
  })
})

describe('purge paths', () => {
  it('defaults to ~/.lmcode, not the Electron userData dir', () => {
    const paths = resolvePurgePaths({})
    expect(paths.home).toBe(join(homedir(), '.lmcode'))
    expect(paths.target).toBe(join(homedir(), '.lmcode', 'AGENTS.md'))
  })

  it('honours an explicit home', () => {
    // Built from an absolute path of the current platform so the case holds
    // on the Linux CI leg as well as on Windows.
    const custom = resolve(tmpdir(), 'custom-home')
    const paths = resolvePurgePaths({ homeDir: custom })
    expect(paths.target).toBe(join(custom, 'AGENTS.md'))
  })
})

describe('purge block helpers', () => {
  it('finds and strips a terminated block', () => {
    const text = `before\n\n${PURGE_BEGIN}\nbody\n${PURGE_END}\n\nafter\n`
    expect(findBlock(text)?.unterminated).toBe(false)
    expect(stripBlock(text).text).toBe('before\n\nafter\n')
  })

  it('flags an unterminated block', () => {
    const text = `before\n${PURGE_BEGIN}\nbody\n`
    expect(findBlock(text)?.unterminated).toBe(true)
    expect(stripBlock(text).text).toBe('before\n')
  })

  it('ignores HTML comments when deciding if a prompt is meaningful', () => {
    expect(stripHtmlComments('<!-- x -->\n').trim()).toBe('')
    expect(stripHtmlComments('<!-- x -->\n正文\n').trim()).toBe('正文')
  })
})
