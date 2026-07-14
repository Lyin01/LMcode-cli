import { describe, expect, it } from 'vitest'
import {
  classifyNavigation,
  isTrustedIpcSender,
  isTrustedRendererUrl,
} from '../src/main/security'

describe('desktop navigation security', () => {
  it('only treats the packaged renderer file itself as local', () => {
    const rendererUrl = 'file:///C:/Program%20Files/LMCODE/resources/app.asar/out/renderer/index.html'

    expect(isTrustedRendererUrl(`${rendererUrl}#/session/1`, rendererUrl)).toBe(true)
    expect(
      isTrustedRendererUrl(
        'file:///C:/Program%20Files/LMCODE/resources/app.asar/out/renderer/other.html',
        rendererUrl,
      ),
    ).toBe(false)
    expect(classifyNavigation('file:///C:/Users/user/.ssh/id_rsa', rendererUrl)).toBe('deny')
  })

  it('allows the development origin and delegates only safe web URLs externally', () => {
    const rendererUrl = 'http://localhost:5173/'

    expect(classifyNavigation('http://localhost:5173/settings', rendererUrl)).toBe('allow-local')
    expect(classifyNavigation('https://example.com/docs', rendererUrl)).toBe('open-external')
    expect(classifyNavigation('http://example.com/docs', rendererUrl)).toBe('open-external')
    expect(classifyNavigation('https://user:secret@example.com/', rendererUrl)).toBe('deny')
    expect(classifyNavigation('javascript:alert(1)', rendererUrl)).toBe('deny')
    expect(classifyNavigation('custom-protocol://open', rendererUrl)).toBe('deny')
  })
})

describe('desktop IPC sender security', () => {
  it('accepts only the trusted WebContents on the configured renderer origin', () => {
    const rendererUrl = 'http://localhost:5173/'
    const trustedContents = {
      isDestroyed: () => false,
      getURL: () => 'http://localhost:5173/chat',
    }

    expect(
      isTrustedIpcSender(
        { sender: trustedContents, senderFrame: { url: 'http://localhost:5173/chat' } },
        trustedContents,
        rendererUrl,
      ),
    ).toBe(true)
    expect(
      isTrustedIpcSender(
        { sender: {}, senderFrame: { url: 'http://localhost:5173/chat' } },
        trustedContents,
        rendererUrl,
      ),
    ).toBe(false)
    expect(
      isTrustedIpcSender(
        { sender: trustedContents, senderFrame: { url: 'https://attacker.example/' } },
        trustedContents,
        rendererUrl,
      ),
    ).toBe(false)
  })

  it('rejects events after the trusted WebContents navigates or is destroyed', () => {
    const rendererUrl = 'file:///app/out/renderer/index.html'
    const navigatedContents = {
      isDestroyed: () => false,
      getURL: () => 'https://attacker.example/',
    }
    const destroyedContents = {
      isDestroyed: () => true,
      getURL: () => rendererUrl,
    }

    expect(
      isTrustedIpcSender(
        { sender: navigatedContents, senderFrame: { url: rendererUrl } },
        navigatedContents,
        rendererUrl,
      ),
    ).toBe(false)
    expect(
      isTrustedIpcSender(
        { sender: destroyedContents, senderFrame: { url: rendererUrl } },
        destroyedContents,
        rendererUrl,
      ),
    ).toBe(false)
  })
})
