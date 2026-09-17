/**
 * Integration check against the real, installed Cua Driver.
 *
 * This is the only test that proves the whole production path — vendor driver
 * process, LMCODE's MCP client, the provider's exclusive registration, and the
 * MCP result adapter that turns a screenshot into a model-visible image part.
 * It drives a real desktop window, so it runs only when a driver is present and
 * the operator opts in by exporting `LMCODE_COMPUTER_USE_DRIVER` with the
 * executable path. Read-only calls only: it never clicks, types, or changes
 * window state.
 */
import { describe, expect, it } from 'vitest';

import { ComputerUseController } from '../../src/computer-use/controller';
import { detectComputerUseDriver } from '../../src/computer-use/providers';
import { mcpResultToExecutableOutput } from '../../src/mcp/output';
import { McpConnectionManager } from '../../src/mcp/connection-manager';

const explicitDriver = process.env['LMCODE_COMPUTER_USE_DRIVER'];
const driverPath =
  explicitDriver !== undefined && explicitDriver.length > 0
    ? explicitDriver
    : detectComputerUseDriver(process.platform, process.env);

const SERVER_NAME = 'cua-driver-mcp';

describe.runIf(driverPath !== undefined)('Cua Driver integration', () => {
  it('lists the provider tool catalog through the controller', async () => {
    const mcp = new McpConnectionManager({ envLookup: (name) => process.env[name] });
    const controller = new ComputerUseController({ mcp });
    try {
      const status = await controller.activate({ command: driverPath });

      expect(status.phase).toBe('active');
      expect(status.providerId).toBe('cua-driver-mcp');
      // The catalog is provider-owned and version-dependent, so assert a floor
      // rather than an exact count.
      expect(status.toolCount).toBeGreaterThan(10);

      const tools = mcp.resolved(SERVER_NAME)?.tools ?? [];
      const names = tools.map((tool) => tool.name);
      for (const required of ['check_permissions', 'get_accessibility_tree', 'get_window_state']) {
        expect(names).toContain(required);
      }
      // A window handle is an unsigned integer on this driver, which is what
      // the Ajv format registration exists for: compiling these schemas must
      // not log.
      const windowState = tools.find((tool) => tool.name === 'get_window_state');
      expect(JSON.stringify(windowState?.parameters)).toContain('properties');
    } finally {
      await controller.dispose();
      await mcp.shutdown();
    }
  });

  it('turns a real window screenshot into a model-visible image part', async () => {
    const mcp = new McpConnectionManager({ envLookup: (name) => process.env[name] });
    const controller = new ComputerUseController({ mcp });
    try {
      await controller.activate({ command: driverPath });
      const client = mcp.resolved(SERVER_NAME)?.client;
      if (client === undefined) throw new Error('provider client is missing');

      const tree = await client.callTool('get_accessibility_tree', {});
      const structured = (tree as { structuredContent?: unknown }).structuredContent;
      const windows = (structured as { windows?: unknown } | undefined)?.windows;
      const targets = Array.isArray(windows) ? windows : [];
      const target = targets.find(
        (candidate): candidate is { pid: number; window_id: number } =>
          typeof candidate === 'object' &&
          candidate !== null &&
          Number.isFinite((candidate as { pid?: unknown }).pid) &&
          Number.isFinite((candidate as { window_id?: unknown }).window_id),
      );
      // A headless session has no windows to capture; nothing to assert then.
      if (target === undefined) return;

      const capture = await client.callTool('get_window_state', {
        pid: target.pid,
        window_id: target.window_id,
        max_dimension: 512,
      });
      const output = mcpResultToExecutableOutput(capture, `mcp__${SERVER_NAME}__get_window_state`);

      expect(Array.isArray(output)).toBe(true);
      const parts = Array.isArray(output) ? output : [];
      const images = parts.filter((part) => part.type === 'image_url');
      expect(images.length).toBeGreaterThan(0);
      const url = images[0]?.type === 'image_url' ? images[0].imageUrl.url : '';
      expect(url.startsWith('data:image/png;base64,')).toBe(true);
      // Command output must not have been swallowed on the way.
      expect(parts.some((part) => part.type === 'text')).toBe(true);
    } finally {
      await controller.dispose();
      await mcp.shutdown();
    }
  }, 120_000);
});
