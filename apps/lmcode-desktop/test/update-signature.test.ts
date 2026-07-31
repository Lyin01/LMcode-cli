import { describe, expect, it } from 'vitest'
import {
  evaluateWindowsUpdateSignature,
  type WindowsUpdateSignatureInfo,
} from '../src/main/update-signature'

const updateFile = 'C:\\Users\\owner\\AppData\\Local\\Temp\\LMCODE-Setup-0.5.4.exe'
const pinnedThumbprint = '06A885AE9FB11F84060F989991188913711B4D88'

function signature(
  overrides: Partial<WindowsUpdateSignatureInfo> = {},
): WindowsUpdateSignatureInfo {
  return {
    path: updateFile,
    status: 1,
    statusName: 'UnknownError',
    statusMessage: 'A certificate chain processed, but terminated in an untrusted root certificate.',
    thumbprint: pinnedThumbprint,
    chainBuildsAllowUnknownCertificateAuthority: true,
    chainStatuses: ['UntrustedRoot'],
    ...overrides,
  }
}

describe('Windows update signature verification', () => {
  it('accepts the pinned self-signed certificate only when the file signature is intact', () => {
    expect(evaluateWindowsUpdateSignature(signature(), updateFile)).toBeNull()

    expect(
      evaluateWindowsUpdateSignature(
        signature({
          status: 3,
          statusName: 'HashMismatch',
          statusMessage: 'The contents of the file have been altered.',
          chainBuildsAllowUnknownCertificateAuthority: true,
          chainStatuses: ['UntrustedRoot'],
        }),
        updateFile,
      ),
    ).toContain('HashMismatch')
  })

  it('rejects an unpinned signer even when Windows trusts its certificate chain', () => {
    expect(
      evaluateWindowsUpdateSignature(
        signature({
          status: 0,
          statusName: 'Valid',
          statusMessage: 'Signature verified.',
          thumbprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          chainBuildsAllowUnknownCertificateAuthority: true,
          chainStatuses: [],
        }),
        updateFile,
      ),
    ).toContain('not pinned')
  })

  it('rejects path substitution and certificate errors beyond the pinned untrusted root', () => {
    expect(
      evaluateWindowsUpdateSignature(
        signature({ path: 'C:\\Users\\owner\\Downloads\\lookalike.exe' }),
        updateFile,
      ),
    ).toContain('different file path')

    expect(
      evaluateWindowsUpdateSignature(
        signature({ chainStatuses: ['UntrustedRoot', 'NotTimeValid'] }),
        updateFile,
      ),
    ).toContain('UnknownError')
  })
})
