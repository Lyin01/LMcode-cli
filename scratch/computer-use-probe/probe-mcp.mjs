// Probe: spawn the installed `cua-driver mcp` over stdio and exercise the
// calls the computer-use provider depends on. Answers:
//   1. does `cua-driver mcp` work without a logon daemon on Windows?
//   2. do tool results carry image content blocks (screenshots) at all?
// The MCP SDK is resolved through the workspace package that depends on it,
// because this scratch script does not sit inside a package boundary.
import { createRequire } from 'node:module';

const require = createRequire('E:/lmcode-desktop-source/packages/agent-core/package.json');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const EXE = process.argv[2];
const args = process.argv.slice(3);

const transport = new StdioClientTransport({
  command: EXE,
  args,
  stderr: 'pipe',
  env: { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'], TEMP: process.env['TEMP'] },
});

const client = new Client({ name: 'lmcode-probe', version: '0.0.1' }, { capabilities: {} });

const started = Date.now();
await client.connect(transport);
console.log(`connected in ${Date.now() - started}ms  (args: ${args.join(' ')})`);

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
console.log(`tools: ${names.length}`);
for (const want of ['check_permissions', 'get_accessibility_tree', 'get_window_state', 'click', 'verify_state']) {
  console.log(`  ${names.includes(want) ? 'yes' : 'NO '} ${want}`);
}

const perms = await client.callTool({ name: 'check_permissions', arguments: {} });
console.log('check_permissions isError:', perms.isError ?? false);
console.log('  content kinds:', (perms.content ?? []).map((c) => c.type).join(','));
const firstText = (perms.content ?? []).find((c) => c.type === 'text');
if (firstText) console.log('  text head:', String(firstText.text).slice(0, 400).replace(/\s+/g, ' '));

const tree = await client.callTool({ name: 'get_accessibility_tree', arguments: {} });
const treeText = (tree.content ?? []).find((c) => c.type === 'text');
console.log(
  'get_accessibility_tree isError:',
  tree.isError ?? false,
  'chars:',
  treeText ? String(treeText.text).length : 0,
);

// Pick the first visible window and capture it — this is the call whose image
// block has to survive the whole attachment pipeline.
const structured = tree.structuredContent ?? {};
const windows = Array.isArray(structured.windows) ? structured.windows : [];
console.log('windows reported:', windows.length);
if (windows.length > 0) console.log('  sample window keys:', Object.keys(windows[0]).join(','));

const target = windows.find((w) => Number.isFinite(w?.pid) && Number.isFinite(w?.window_id));
if (target === undefined) {
  console.log('no window with pid/window_id found; structured sample:');
  console.log(JSON.stringify(structured).slice(0, 800));
} else {
  console.log(`capturing pid=${target.pid} window_id=${target.window_id} title=${JSON.stringify(target.title ?? target.name ?? '')}`);
  const state = await client.callTool({
    name: 'get_window_state',
    arguments: { pid: target.pid, window_id: target.window_id, max_dimension: 1024 },
  });
  console.log('get_window_state isError:', state.isError ?? false);
  const kinds = (state.content ?? []).map((c) =>
    c.type === 'image' ? `image(${c.mimeType},${c.data?.length ?? 0}b64)` : c.type,
  );
  console.log('  content kinds:', kinds.join(','));
  const sc = state.structuredContent ?? {};
  console.log('  structured keys:', Object.keys(sc).join(','));
  console.log('  elements:', Array.isArray(sc.elements) ? sc.elements.length : 'n/a');
  console.log('  first element keys:', Array.isArray(sc.elements) && sc.elements[0] ? Object.keys(sc.elements[0]).join(',') : 'n/a');
}

await client.close();
console.log('closed');
