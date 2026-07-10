import { describe, expect, it } from 'vitest';

import { adaptSpawnCommandForWindows, platformFromOsKind } from '../../src/utils/spawn-command';

describe('adaptSpawnCommandForWindows', () => {
  it('wraps a .cmd/npx-style command in cmd.exe /c on Windows', () => {
    const out = adaptSpawnCommandForWindows('npx', ['-y', '@scope/server'], 'win32');
    expect(out.command.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(out.args).toEqual(['/c', 'npx', '-y', '@scope/server']);
  });

  it('wraps npm-shim language servers the same way', () => {
    const out = adaptSpawnCommandForWindows('typescript-language-server', ['--stdio'], 'win32');
    expect(out.command.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(out.args).toEqual(['/c', 'typescript-language-server', '--stdio']);
  });

  it('passes a direct .exe target through unchanged on Windows', () => {
    const out = adaptSpawnCommandForWindows('C:/tools/server.EXE', ['--stdio'], 'win32');
    expect(out).toEqual({ command: 'C:/tools/server.EXE', args: ['--stdio'] });
  });

  it('does not wrap on non-Windows platforms', () => {
    expect(adaptSpawnCommandForWindows('npx', ['-y', 'server'], 'linux')).toEqual({
      command: 'npx',
      args: ['-y', 'server'],
    });
  });

  it('tolerates undefined args', () => {
    expect(adaptSpawnCommandForWindows('npx', undefined, 'linux')).toEqual({
      command: 'npx',
      args: [],
    });
    expect(adaptSpawnCommandForWindows('npx', undefined, 'win32').args).toEqual(['/c', 'npx']);
  });
});

describe('platformFromOsKind', () => {
  it('maps a Windows jian host to win32', () => {
    expect(platformFromOsKind('Windows')).toBe('win32');
  });

  it('maps every non-Windows host to a POSIX platform', () => {
    expect(platformFromOsKind('Linux')).toBe('linux');
    expect(platformFromOsKind('macOS')).toBe('linux');
    expect(platformFromOsKind('freebsd')).toBe('linux');
  });
});
