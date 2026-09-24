import { describe, expect, it } from 'vitest'

import {
  countMemoriesByKind,
  filterMemories,
  memoryDisplay,
  normalizeMemoryKind,
} from '../src/renderer/lib/memory-library'

const preference = {
  id: 'p1',
  userNeed: '所有会话',
  approach: '回复用中文，结论先行',
  outcome: '已记录为长期偏好',
  tags: ['偏好', '沟通'],
  kind: 'preference',
}

const task = {
  id: 't1',
  userNeed: '修复构建',
  approach: '升级依赖到最新版',
  outcome: '完成',
  tags: ['构建'],
  kind: 'task',
}

/** Records written before the kind field existed. */
const legacy = {
  id: 'l1',
  userNeed: '旧记录',
  approach: '没有 kind 字段',
}

describe('memory library filter', () => {
  it('returns every record when no filter is set', () => {
    expect(filterMemories([preference, task, legacy])).toHaveLength(3)
  })

  it('splits preferences from task experiences', () => {
    expect(filterMemories([preference, task, legacy], { kind: 'preference' })).toEqual([
      preference,
    ])
    expect(
      filterMemories([preference, task, legacy], { kind: 'task' }).map((m) => m.id),
    ).toEqual(['t1', 'l1'])
  })

  it('searches the rule text stored in approach', () => {
    // Regression: a preference's rule lives in `approach`; searching only
    // userNeed/outcome would silently hide it.
    expect(filterMemories([preference, task], { query: '结论先行' })).toEqual([preference])
  })

  it('matches tags case-insensitively and combines with the kind filter', () => {
    expect(filterMemories([preference, task], { query: '构建' }).map((m) => m.id)).toEqual(['t1'])
    expect(filterMemories([preference, task], { query: '构建', kind: 'preference' })).toEqual([])
  })
})

describe('memory library counts and labels', () => {
  it('counts each kind, treating legacy records as tasks', () => {
    expect(countMemoriesByKind([preference, task, legacy])).toEqual({
      all: 3,
      preference: 1,
      task: 2,
    })
  })

  it('normalizes unknown kinds to task', () => {
    expect(normalizeMemoryKind('preference')).toBe('preference')
    expect(normalizeMemoryKind('habit')).toBe('task')
    expect(normalizeMemoryKind(undefined)).toBe('task')
  })

  it('headlines the rule for preferences and the need for tasks', () => {
    expect(memoryDisplay(preference)).toEqual({
      title: '回复用中文，结论先行',
      detail: '适用：所有会话',
    })
    expect(memoryDisplay(task)).toEqual({ title: '修复构建', detail: '完成' })
    expect(memoryDisplay({ userNeed: '', approach: '' })).toEqual({ title: '通用经验' })
  })
})
