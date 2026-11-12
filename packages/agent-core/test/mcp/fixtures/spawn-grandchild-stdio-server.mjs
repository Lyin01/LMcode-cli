// MCP stdio fixture used to prove process-tree reclamation: the fixture
// spawns a long-lived grandchild that shares no stdio with it, so the
// grandchild can only disappear through a real tree kill. The grandchild's
// pid is written to the file named by LMCODE_TEST_GRANDCHILD_PID_FILE.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const pidFile = process.env['LMCODE_TEST_GRANDCHILD_PID_FILE'];
if (pidFile === undefined || pidFile === '') {
  throw new Error('LMCODE_TEST_GRANDCHILD_PID_FILE is required');
}

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true,
});
if (grandchild.pid === undefined) {
  throw new Error('failed to spawn the grandchild process');
}
// Spawn failures must not crash the fixture with an unhandled 'error' event.
grandchild.on('error', () => {});
writeFileSync(pidFile, String(grandchild.pid));

const server = new McpServer({ name: 'mock-stdio-grandchild', version: '0.0.1' });

server.registerTool(
  'ping',
  {
    description: 'Returns pong',
    inputSchema: {},
  },
  () => ({
    content: [{ type: 'text', text: 'pong' }],
  }),
);

await server.connect(new StdioServerTransport());
