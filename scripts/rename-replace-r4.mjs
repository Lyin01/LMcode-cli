/**
 * LMcode rename round 4 — fix remaining import paths for renamed files.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILES = {
  'E:/project for cc/lmcode/apps/lmcode/src/tui/commands/config.ts': [
    [`'../constant/scream-tui'`, `'../constant/lmcode-tui'`],
  ],
  'E:/project for cc/lmcode/apps/lmcode/src/tui/commands/dispatch.ts': [
    [`'../constant/scream-tui'`, `'../constant/lmcode-tui'`],
  ],
  'E:/project for cc/lmcode/apps/lmcode/src/tui/commands/info.ts': [
    [`'../constant/scream-tui'`, `'../constant/lmcode-tui'`],
  ],
  'E:/project for cc/lmcode/apps/lmcode/src/tui/commands/revoke.ts': [
    [`'../constant/scream-tui'`, `'../constant/lmcode-tui'`],
  ],
  'E:/project for cc/lmcode/apps/lmcode/src/tui/commands/session.ts': [
    [`'../constant/scream-tui'`, `'../constant/lmcode-tui'`],
  ],
  'E:/project for cc/lmcode/apps/lmcode/src/tui/controllers/editor-keyboard.ts': [
    [`'../constant/scream-tui'`, `'../constant/lmcode-tui'`],
  ],
  'E:/project for cc/lmcode/apps/lmcode/src/tui/controllers/input-controller.ts': [
    [`'../constant/scream-tui'`, `'../constant/lmcode-tui'`],
  ],
  'E:/project for cc/lmcode/apps/lmcode/src/tui/controllers/session-event-handler.ts': [
    [`'../constant/scream-tui'`, `'../constant/lmcode-tui'`],
  ],
  'E:/project for cc/lmcode/apps/lmcode/src/tui/lmcode-tui.ts': [
    [`'./constant/scream-tui'`, `'./constant/lmcode-tui'`],
  ],
  'E:/project for cc/lmcode/apps/lmcode/src/tui/managers/session-manager.ts': [
    [`'../constant/scream-tui'`, `'../constant/lmcode-tui'`],
  ],
  'E:/project for cc/lmcode/packages/ltod/test/e2e/toolchain-bridges.test.ts': [
    [`'#/providers/scream-schema'`, `'#/providers/lmcode-schema'`],
  ],
  'E:/project for cc/lmcode/packages/ltod/test/lmcode-files.test.ts': [
    [`'#/providers/scream-files'`, `'#/providers/lmcode-files'`],
  ],
  'E:/project for cc/lmcode/packages/ltod/test/providers/lmcode-schema.test.ts': [
    [`'#/providers/scream-schema'`, `'#/providers/lmcode-schema'`],
  ],
  'E:/project for cc/lmcode/packages/node-sdk/src/index.ts': [
    [`'#/scream-harness'`, `'#/lmcode-harness'`],
  ],
};

let changed = 0;
for (const [file, replacements] of Object.entries(FILES)) {
  let content;
  try { content = readFileSync(file, 'utf-8'); } catch { console.log(`  SKIP: ${file} (not found)`); continue; }
  const original = content;
  for (const [search, replace] of replacements) {
    content = content.split(search).join(replace);
  }
  if (content !== original) {
    writeFileSync(file, content, 'utf-8');
    changed++;
    console.log(`  ✓ ${file.split('/').pop()}`);
  }
}
console.log(`\nFixed ${changed} files.`);
