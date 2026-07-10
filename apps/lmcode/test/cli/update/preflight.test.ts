import { describe, expect, it } from 'vitest';

import { manualUpdateCommand } from '#/cli/update/preflight';

describe('manualUpdateCommand', () => {
  it('points Windows users at install.ps1 (install.sh cannot run there)', () => {
    const cmd = manualUpdateCommand('win32');
    expect(cmd).toContain('install.ps1');
    expect(cmd).toContain('--upgrade');
    expect(cmd).not.toContain('install.sh');
  });

  it('points POSIX users at install.sh', () => {
    expect(manualUpdateCommand('linux')).toBe('cd ~/.lmcode && ./install.sh --upgrade');
    expect(manualUpdateCommand('darwin')).toBe('cd ~/.lmcode && ./install.sh --upgrade');
  });
});
