import * as childProcess from 'node:child_process';

/**
 * Check whether a cc-connect process is running on the local machine.
 *
 * Detection strategy per platform:
 *   - macOS / Linux: pgrep -f cc-connect
 *   - Windows:        pm2 jlist (preferred) → Get-CimInstance (PowerShell)
 */

export function checkCcConnectActive(): Promise<boolean> {
  switch (process.platform) {
    case 'darwin':
    case 'linux':
      return checkPosixProcessCommandLine('cc-connect');
    case 'win32':
      return checkWindows();
    default:
      return Promise.resolve(false);
  }
}

// ── macOS / Linux ──────────────────────────────────────────────────────────

export function checkPosixProcessCommandLine(needle: string): Promise<boolean> {
  return new Promise((resolve) => {
    childProcess.execFile(
      'pgrep',
      ['-f', needle],
      { timeout: 3000 },
      (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        resolve(stdout.trim().length > 0);
      },
    );
  });
}

// ── Windows ────────────────────────────────────────────────────────────────

async function checkWindows(): Promise<boolean> {
  // 1. pm2 jlist — most reliable when cc-connect is managed by pm2
  const pm2Active = await checkPm2();
  if (pm2Active === true) return true;

  // 2. PowerShell Get-CimInstance — modern replacement for wmic
  const psActive = await checkWindowsProcessCommandLine('cc-connect');
  if (psActive !== undefined) return psActive;
  return false;
}

/** Query pm2's internal process list. Returns undefined if pm2 is not available. */
function checkPm2(): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    childProcess.exec(
      'pm2 jlist 2>nul',
      { timeout: 3000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        try {
          const list = JSON.parse(stdout.trim());
          if (!Array.isArray(list)) {
            resolve(undefined);
            return;
          }
          const cc = list.find(
            (p: { name?: string; pm2_env?: { status?: string } }) =>
              p.name === 'cc-connect',
          );
          resolve(cc !== undefined ? cc.pm2_env?.status === 'online' : false);
        } catch {
          resolve(undefined);
        }
      },
    );
  });
}

/** Query process command lines via PowerShell Get-CimInstance. Returns undefined if unavailable. */
export async function checkWindowsProcessCommandLine(
  needle: string,
): Promise<boolean | undefined> {
  for (const executable of ['powershell.exe', 'pwsh.exe']) {
    const active = await checkPowerShellExecutable(executable, needle);
    if (active !== undefined) return active;
  }
  return undefined;
}

function checkPowerShellExecutable(
  executable: string,
  needle: string,
): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      '$needle = $env:LMCODE_CC_STATUS_NEEDLE',
      'if ([string]::IsNullOrWhiteSpace($needle)) { exit 2 }',
      '$processes = @(Get-CimInstance -ClassName Win32_Process)',
      '$byPid = @{}',
      'foreach ($process in $processes) { $byPid[[uint32]$process.ProcessId] = $process }',
      '$excluded = @{}',
      '$ancestorPid = [uint32]$PID',
      'while ($ancestorPid -ne 0 -and -not $excluded.ContainsKey($ancestorPid)) {',
      '  $excluded[$ancestorPid] = $true',
      '  if (-not $byPid.ContainsKey($ancestorPid)) { break }',
      '  $ancestorPid = [uint32]$byPid[$ancestorPid].ParentProcessId',
      '}',
      '$matches = $processes | Where-Object {',
      '  $candidatePid = [uint32]$_.ProcessId',
      '  $commandLine = [string]$_.CommandLine',
      '  -not $excluded.ContainsKey($candidatePid) -and',
      '    $commandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0',
      '}',
      '@($matches).Count',
    ].join('\n');
    childProcess.execFile(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      {
        env: { ...process.env, LMCODE_CC_STATUS_NEEDLE: needle },
        timeout: 5000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const count = Number.parseInt(stdout.trim(), 10);
        if (Number.isNaN(count)) {
          resolve(undefined);
          return;
        }
        resolve(count > 0);
      },
    );
  });
}
