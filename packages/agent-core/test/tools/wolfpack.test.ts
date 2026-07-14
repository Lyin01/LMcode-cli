import { describe, expect, it, vi } from 'vitest';

import type { SessionSubagentHost } from '../../src/session/subagent-host';
import {
  WOLFPACK_MAX_AGGREGATE_OUTPUT_CHARS,
  WOLFPACK_MAX_ITEM_RESULT_CHARS,
  WolfPackTool,
} from '../../src/tools/builtin/collaboration/wolfpack';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function mockSubagentHost(spawn: SessionSubagentHost['spawn']): SessionSubagentHost {
  return { spawn } as SessionSubagentHost;
}

describe('WolfPackTool', () => {
  it('returns every subagent summary with its item and agent id', async () => {
    const spawn = vi
      .fn<SessionSubagentHost['spawn']>()
      .mockResolvedValueOnce({
        agentId: 'agent-alpha',
        profileName: 'coder',
        resumed: false,
        completion: Promise.resolve({ result: 'Alpha found a path traversal flaw.' }),
      })
      .mockResolvedValueOnce({
        agentId: 'agent-beta',
        profileName: 'coder',
        resumed: false,
        completion: Promise.resolve({ result: 'Beta found a timer leak.' }),
      });
    const tool = new WolfPackTool(mockSubagentHost(spawn), () => true);

    const result = await executeTool(tool, {
      turnId: 'turn-1',
      toolCallId: 'call-wolfpack',
      signal,
      args: {
        description: 'Review modules',
        subagent_type: 'coder',
        prompt_template: 'Review {{item}} carefully',
        items: ['alpha', 'beta'],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Success: 2, Failed: 0, Total: 2');
    expect(result.output).toContain('## Agent manifest');
    expect(result.output).toContain('1. status=OK agent_id=agent-alpha item="alpha"');
    expect(result.output).toContain('2. status=OK agent_id=agent-beta item="beta"');
    expect(result.output).toContain('### alpha (OK)');
    expect(result.output).toContain('agent_id: agent-alpha');
    expect(result.output).toContain('Alpha found a path traversal flaw.');
    expect(result.output).toContain('### beta (OK)');
    expect(result.output).toContain('Beta found a timer leak.');
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      'coder',
      expect.objectContaining({ prompt: 'Review alpha carefully' }),
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      'coder',
      expect.objectContaining({ prompt: 'Review beta carefully' }),
    );
  });

  it('keeps the item and failure reason when spawning fails', async () => {
    const spawn = vi.fn<SessionSubagentHost['spawn']>().mockRejectedValue(new Error('at capacity'));
    const tool = new WolfPackTool(mockSubagentHost(spawn), () => true);

    const result = await executeTool(tool, {
      turnId: 'turn-1',
      toolCallId: 'call-wolfpack',
      signal,
      args: {
        description: 'Review modules',
        subagent_type: 'coder',
        prompt_template: 'Review {{item}}',
        items: ['alpha'],
      },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('status=FAILED agent_id=not-started item="alpha"');
    expect(result.output).toContain('### alpha (FAILED)');
    expect(result.output).toContain('Spawn failed: at capacity');
  });

  it('caps an individual subagent result and emits an explicit truncation marker', async () => {
    const longResult = `begin-${'x'.repeat(WOLFPACK_MAX_ITEM_RESULT_CHARS + 2_000)}-unreachable-tail`;
    const spawn = vi.fn<SessionSubagentHost['spawn']>().mockResolvedValue({
      agentId: 'agent-long-result',
      profileName: 'coder',
      resumed: false,
      completion: Promise.resolve({ result: longResult }),
    });
    const tool = new WolfPackTool(mockSubagentHost(spawn), () => true);

    const result = await executeTool(tool, {
      turnId: 'turn-1',
      toolCallId: 'call-wolfpack',
      signal,
      args: {
        description: 'Review module',
        subagent_type: 'coder',
        prompt_template: 'Review {{item}}',
        items: ['alpha'],
      },
    });

    expect(result.output.length).toBeLessThan(WOLFPACK_MAX_AGGREGATE_OUTPUT_CHARS);
    expect(result.output).toContain('agent_id=agent-long-result');
    expect(result.output).toContain(
      `WolfPack item output truncated: ${String(longResult.length)} chars exceeds ${String(
        WOLFPACK_MAX_ITEM_RESULT_CHARS,
      )}-char limit`,
    );
    expect(result.output).not.toContain('unreachable-tail');
  });

  it('keeps every started agent id and item status when aggregate output is truncated', async () => {
    const itemCount = 8;
    let spawnIndex = 0;
    const agentIds = Array.from(
      { length: itemCount },
      (_, index) => `agent-${String(index)}-${'complete-id-'.repeat(4)}`,
    );
    const spawn = vi.fn<SessionSubagentHost['spawn']>().mockImplementation(async () => {
      const index = spawnIndex++;
      const completion =
        index === itemCount - 1
          ? Promise.reject(new Error('final agent failed after producing output'))
          : Promise.resolve({
              result: `agent-${String(index)}-result\n${'r'.repeat(
                WOLFPACK_MAX_ITEM_RESULT_CHARS + 500,
              )}`,
            });
      return {
        agentId: agentIds[index]!,
        profileName: 'coder',
        resumed: false,
        completion,
      };
    });
    const tool = new WolfPackTool(mockSubagentHost(spawn), () => true);

    const result = await executeTool(tool, {
      turnId: 'turn-1',
      toolCallId: 'call-wolfpack',
      signal,
      args: {
        description: 'Review modules',
        subagent_type: 'coder',
        prompt_template: 'Review {{item}}',
        items: Array.from({ length: itemCount }, (_, index) => `module-${String(index)}`),
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.output.length).toBeLessThanOrEqual(WOLFPACK_MAX_AGGREGATE_OUTPUT_CHARS);
    expect(result.output).toContain('WolfPack aggregate output truncated:');
    expect(result.output).toContain('The agent manifest above is complete.');
    for (const [index, agentId] of agentIds.entries()) {
      const status = index === itemCount - 1 ? 'FAILED' : 'OK';
      expect(result.output).toContain(
        `${String(index + 1)}. status=${status} agent_id=${agentId} item="module-${String(index)}"`,
      );
    }
  });
});
