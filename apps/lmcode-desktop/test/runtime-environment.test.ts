import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDesktopRuntimeEnvironment } from '../src/main/runtime-environment'

describe('desktop runtime environment isolation', () => {
  it('keeps production on its stable data directory and ignores debug environment variables', () => {
    const runtime = resolveDesktopRuntimeEnvironment({
      isPackaged: true,
      defaultUserDataDir: path.join('C:', 'Users', 'owner', 'AppData', 'LMCODE'),
      nodeEnv: 'development',
      rendererUrl: 'http://localhost:5173',
    })

    expect(runtime).toEqual({
      name: 'production',
      isDevelopment: false,
      userDataDir: path.join('C:', 'Users', 'owner', 'AppData', 'LMCODE'),
      configPath: path.join('C:', 'Users', 'owner', 'AppData', 'LMCODE', 'config.toml'),
      rendererUrl: undefined,
      devToolsEnabled: false,
    })
  })

  it('gives development its own database, configuration, logs, and loopback renderer', () => {
    const productionData = path.join('C:', 'Users', 'owner', 'AppData', 'LMCODE')
    const runtime = resolveDesktopRuntimeEnvironment({
      isPackaged: false,
      defaultUserDataDir: productionData,
      nodeEnv: 'development',
      rendererUrl: 'http://127.0.0.1:5173',
    })

    expect(runtime.userDataDir).toBe(`${productionData}-development`)
    expect(runtime.configPath).toBe(
      path.join(`${productionData}-development`, 'config.toml'),
    )
    expect(runtime.rendererUrl).toBe('http://127.0.0.1:5173/')
    expect(runtime.devToolsEnabled).toBe(true)
  })

  it('rejects a remote or credentialed development renderer', () => {
    const resolve = (rendererUrl: string): void => {
      resolveDesktopRuntimeEnvironment({
        isPackaged: false,
        defaultUserDataDir: '/var/lib/lmcode',
        nodeEnv: 'development',
        rendererUrl,
      })
    }

    expect(() => resolve('https://attacker.example/app')).toThrow('loopback HTTP')
    expect(() => resolve('http://user:password@localhost:5173')).toThrow(
      'without credentials',
    )
  })
})
