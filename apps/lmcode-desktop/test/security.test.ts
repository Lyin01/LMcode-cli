import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyNavigation,
  createRendererContentSecurityPolicy,
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
    expect(classifyNavigation('http://example.com/docs', rendererUrl)).toBe('deny')
    expect(classifyNavigation('https://user:secret@example.com/', rendererUrl)).toBe('deny')
    expect(classifyNavigation('javascript:alert(1)', rendererUrl)).toBe('deny')
    expect(classifyNavigation('custom-protocol://open', rendererUrl)).toBe('deny')
  })
})

describe('desktop content security policy', () => {
  it('blocks production network access, executable injection, forms, and frames', () => {
    const policy = createRendererContentSecurityPolicy(
      'file:///C:/Program%20Files/LMCODE/out/renderer/index.html',
      false,
    )

    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("connect-src 'none'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("form-action 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).not.toContain("'unsafe-eval'")
  })

  it('allows development HMR only on the trusted renderer origin', () => {
    const policy = createRendererContentSecurityPolicy('http://localhost:5173/', true)

    expect(policy).toContain("connect-src 'self' ws://localhost:5173")
    expect(policy).not.toContain('ws://*')
  })

  it('keeps startup scripts external so production does not need unsafe-inline scripts', () => {
    const html = fs.readFileSync(
      path.join(import.meta.dirname, '../src/renderer/index.html'),
      'utf8',
    )

    expect(html).toContain('<script src="/theme-init.js"></script>')
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i)
    const policy = html.match(
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/,
    )?.[1]
    expect(policy).toBe(createRendererContentSecurityPolicy('file:///index.html', false))
  })

  it('disables non-essential animation when the operating system requests reduced motion', () => {
    const css = fs.readFileSync(
      path.join(import.meta.dirname, '../src/renderer/styles/globals.css'),
      'utf8',
    )

    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('animation-iteration-count: 1 !important')
  })

  it('forces code signing on the publish path while leaving local packaging available', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { readonly scripts: Record<string, string> }

    expect(packageJson.scripts.release).toContain('--config.forceCodeSigning=true')
    expect(packageJson.scripts['build:win']).not.toContain('--config.forceCodeSigning=true')

    const rootPackageJson = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, '../../../package.json'), 'utf8'),
    ) as { readonly scripts: Record<string, string> }
    expect(rootPackageJson.scripts.publish).toMatch(/^pnpm run security:secrets &&/)
  })

  it('does not report a successful PowerShell release after packaging or upload fails', () => {
    const releaseScript = fs.readFileSync(
      path.join(import.meta.dirname, '../scripts/release.ps1'),
      'utf8',
    )
    const publishCommand = releaseScript.indexOf('electron-builder --win --publish always')
    const exitCodeCheck = releaseScript.indexOf('if ($LASTEXITCODE -ne 0)', publishCommand)
    const successMessage = releaseScript.indexOf('发布完成', publishCommand)

    expect(publishCommand).toBeGreaterThanOrEqual(0)
    expect(exitCodeCheck).toBeGreaterThan(publishCommand)
    expect(successMessage).toBeGreaterThan(exitCodeCheck)
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
