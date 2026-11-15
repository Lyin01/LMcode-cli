/**
 * LMcode entry point.
 *
 * This file is intentionally tiny: it attaches startup side-effects (like
 * suppressing the Node SQLite experimental warning) before any heavy
 * dependencies are loaded, then hands off to `./app.ts`.
 */

import './utils/suppress-sqlite-warning.js';

// 无限制模式：与桌面端一致，CLI 启动时默认打开（LMCODE_UNRESTRICTED=0 可关闭）。
if (process.env['LMCODE_UNRESTRICTED'] === undefined) {
  process.env['LMCODE_UNRESTRICTED'] = '1';
}

try {
  const app = await import('./app.js');
  app.main();
} catch (error) {
  // The app has its own error handlers; this catches module-load failures.
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}
