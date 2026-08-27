import type { Tool } from '@lmcode-cli/liumir';
import { describe, expect, it } from 'vitest';

import type { MCPClient } from '../../src/mcp/types';
import { qualifyMcpToolName } from '../../src/mcp/tool-naming';
import { VISUAL_FALLBACK_MCP_SERVER_NAME } from '../../src/mcp/vision-fallback';
import { testAgent } from './harness/agent';

const NO_VISION_CAPS = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 200000,
};

const VISION_CAPS = { ...NO_VISION_CAPS, image_in: true };

const ANALYZE_IMAGE_TOOL: Tool = {
  name: 'analyze_image',
  description: 'Analyze a local image file and return a text description.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

const PING_TOOL: Tool = {
  name: 'ping',
  description: 'No-op probe tool.',
  parameters: { type: 'object', properties: {} },
};

function fakeMcpClient(): MCPClient {
  return {
    listTools: async () => [],
    callTool: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }),
  };
}

function registerFakeServers(ctx: ReturnType<typeof testAgent>): void {
  const client = fakeMcpClient();
  ctx.agent.tools.registerMcpServer(VISUAL_FALLBACK_MCP_SERVER_NAME, client, [ANALYZE_IMAGE_TOOL]);
  ctx.agent.tools.registerMcpServer('grepish', client, [PING_TOOL]);
}

/**
 * 契约：visual-mcp 是「看图补位」通道，只应出现在无图像输入能力
 * （image_in=false）模型的工具集中；有视觉的模型原生即可读图，
 * 该入口必须被屏蔽，同时不影响其他 MCP 服务器的工具暴露。
 */
describe('visual fallback MCP gating by model vision capability', () => {
  it('hides visual-mcp tools from models with image input', () => {
    const ctx = testAgent();
    ctx.configure({ modelCapabilities: VISION_CAPS });
    ctx.agent.tools.setActiveTools(['mcp__*']);
    registerFakeServers(ctx);

    const names = ctx.agent.tools.loopTools.map((tool) => tool.name);
    expect(names).not.toContain(qualifyMcpToolName('visual-mcp', 'analyze_image'));
    // 对照组：同会话其他 MCP 工具不受影响
    expect(names).toContain(qualifyMcpToolName('grepish', 'ping'));

    const infos = ctx.agent.tools.data();
    const visualInfo = infos.find((info) => info.name === qualifyMcpToolName('visual-mcp', 'analyze_image'));
    expect(visualInfo?.active).toBe(false);
  });

  it('exposes visual-mcp tools to models without image input', () => {
    const ctx = testAgent();
    ctx.configure({ modelCapabilities: NO_VISION_CAPS });
    ctx.agent.tools.setActiveTools(['mcp__*']);
    registerFakeServers(ctx);

    const names = ctx.agent.tools.loopTools.map((tool) => tool.name);
    expect(names).toContain(qualifyMcpToolName('visual-mcp', 'analyze_image'));
    expect(names).toContain(qualifyMcpToolName('grepish', 'ping'));

    const infos = ctx.agent.tools.data();
    const visualInfo = infos.find((info) => info.name === qualifyMcpToolName('visual-mcp', 'analyze_image'));
    expect(visualInfo?.active).toBe(true);
  });
});
