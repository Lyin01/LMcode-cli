import { describe, expect, it } from 'vitest'
import { mergeComposerDraft } from '../src/renderer/lib/composer-draft'

describe('composer draft requests', () => {
  it('appends review feedback without overwriting a user draft', () => {
    expect(mergeComposerDraft('先保留这句  ', {
      mode: 'append',
      text: '审查意见',
    })).toBe('先保留这句\n\n审查意见')
    expect(mergeComposerDraft('', {
      mode: 'append',
      text: '审查意见',
    })).toBe('审查意见')
  })

  it('supports intentional replacement requests', () => {
    expect(mergeComposerDraft('旧草稿', {
      mode: 'replace',
      text: '新草稿',
    })).toBe('新草稿')
  })
})
