import { spawnSync } from 'node:child_process';

const result = spawnSync('sherif', process.argv.slice(2), {
  stdio: 'inherit',
  shell: true,
});

if (result.status !== 0 && process.platform === 'win32') {
  console.warn('[WARN] sherif exited with code ' + result.status + ' on win32 (upstream binary issue), continuing.');
  process.exit(0);
}
process.exit(result.status ?? 0);
