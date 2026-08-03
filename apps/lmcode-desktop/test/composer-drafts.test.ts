import { describe, expect, it } from 'vitest'
import {
  clearComposerDraft,
  getComposerDraft,
  saveComposerDraft,
} from '../src/renderer/lib/composer-drafts'

describe('per-session composer drafts', () => {
  it('restores a draft after switching away and back', () => {
    saveComposerDraft('draft-session-a', '写到一半的长消息')
    saveComposerDraft('draft-session-b', '别的会话')

    expect(getComposerDraft('draft-session-a')).toBe('写到一半的长消息')
  })

  it('isolates drafts between sessions', () => {
    saveComposerDraft('draft-session-a', 'A 的草稿')
    saveComposerDraft('draft-session-b', 'B 的草稿')

    expect(getComposerDraft('draft-session-a')).toBe('A 的草稿')
    expect(getComposerDraft('draft-session-b')).toBe('B 的草稿')
  })

  it('returns an empty draft for sessions that never typed', () => {
    expect(getComposerDraft('draft-session-never')).toBe('')
  })

  it('clears the draft after a successful send', () => {
    saveComposerDraft('draft-session-send', '待发送')
    clearComposerDraft('draft-session-send')

    expect(getComposerDraft('draft-session-send')).toBe('')
  })

  it('drops blank text instead of keeping an empty draft', () => {
    saveComposerDraft('draft-session-blank', '有内容')
    saveComposerDraft('draft-session-blank', '   ')

    expect(getComposerDraft('draft-session-blank')).toBe('')
  })
})
