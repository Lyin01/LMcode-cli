import { describe, expect, it } from 'vitest'
import { buildPairingUrl, pairingQrUrl, readPairingToken } from '../src/shared/remote-pairing'

describe('buildPairingUrl', () => {
  it('appends the token as a URL fragment', () => {
    expect(buildPairingUrl('http://192.168.1.5:37991', 'a1b2')).toBe(
      'http://192.168.1.5:37991#token=a1b2',
    )
  })

  it('drops an existing query / fragment and trailing slashes', () => {
    expect(buildPairingUrl('http://192.168.1.5:37991/?from=old#x', 'a1b2')).toBe(
      'http://192.168.1.5:37991#token=a1b2',
    )
    expect(buildPairingUrl('https://tunnel.example.com/', 'a1b2')).toBe(
      'https://tunnel.example.com#token=a1b2',
    )
  })

  it('percent-encodes the token and round-trips through readPairingToken', () => {
    const url = buildPairingUrl('http://10.0.0.2:37991', 'a b/c?d')
    expect(readPairingToken(url.slice(url.indexOf('#')))).toBe('a b/c?d')
  })
})

describe('readPairingToken', () => {
  it('accepts the fragment with or without the leading hash', () => {
    expect(readPairingToken('#token=abc')).toBe('abc')
    expect(readPairingToken('token=abc')).toBe('abc')
  })

  it('returns null for missing, empty or unknown tokens', () => {
    expect(readPairingToken('')).toBeNull()
    expect(readPairingToken('#')).toBeNull()
    expect(readPairingToken('#token=')).toBeNull()
    expect(readPairingToken('#token=%20')).toBeNull()
    expect(readPairingToken('#other=abc')).toBeNull()
  })
})

describe('pairingQrUrl', () => {
  it('points the QR at the first LAN address with the token fragment', () => {
    expect(
      pairingQrUrl({
        enabled: true,
        lanUrls: ['http://192.168.1.5:37991', 'http://10.0.0.2:37991'],
        token: 'a1b2',
      }),
    ).toBe('http://192.168.1.5:37991#token=a1b2')
  })

  it('returns null while the service is off, has no address, or the address is empty', () => {
    expect(pairingQrUrl({ enabled: false, lanUrls: ['http://192.168.1.5:37991'], token: 'x' })).toBeNull()
    expect(pairingQrUrl({ enabled: true, lanUrls: [], token: 'x' })).toBeNull()
    expect(pairingQrUrl({ enabled: true, lanUrls: [''], token: 'x' })).toBeNull()
  })
})
