// Minimal stand-in for the Cua Driver's stdio MCP endpoint, for computer-use
// provider tests. Exposes the three shapes the capability depends on:
//   - `check_permissions` -> text only
//   - `get_window_state`  -> text plus an image content block (a screenshot)
//   - `disconnect`         -> exits the server, to exercise a lost provider
//
// The image block matters: it is what proves a screenshot survives the path
// from the provider through the MCP result adapter to the model.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/** 1x1 transparent PNG. */
const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const server = new McpServer({ name: 'cua-driver-mock', version: '0.0.1' });

server.registerTool(
  'check_permissions',
  { description: 'Report desktop permissions without prompting.', inputSchema: {} },
  () => ({ content: [{ type: 'text', text: 'Windows requires no special permissions' }] }),
);

server.registerTool(
  'get_window_state',
  {
    description: 'Capture a window snapshot with its accessibility tree.',
    inputSchema: { pid: z.number(), window_id: z.number() },
  },
  () => ({
    content: [
      { type: 'text', text: '[element_index 0] button "OK"' },
      { type: 'image', data: PIXEL_PNG_BASE64, mimeType: 'image/png' },
    ],
  }),
);

server.registerTool(
  'disconnect',
  { description: 'Drop the connection, as when the driver dies.', inputSchema: {} },
  () => {
    setImmediate(() => {
      process.exit(0);
    });
    return { content: [{ type: 'text', text: 'closing' }] };
  },
);

await server.connect(new StdioServerTransport());
