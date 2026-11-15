import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { PermissionMode, PermissionPolicyContext } from '../../../src/agent/permission';
import { McpToolPolicyPermissionPolicy } from '../../../src/agent/permission/policies/mcp-tool-policy';
import type { McpToolPolicyResolution } from '../../../src/mcp/connection-manager';

function contextFor(toolName: string): PermissionPolicyContext {
  return { toolCall: { name: toolName } } as unknown as PermissionPolicyContext;
}

function policyAgent(options: {
  readonly mode?: PermissionMode;
  readonly planMode?: boolean;
  readonly resolution?: McpToolPolicyResolution | undefined;
} = {}): Agent {
  const resolution = options.resolution;
  return {
    permission: { mode: options.mode ?? 'manual' },
    planMode: { isActive: options.planMode ?? false },
    mcp: {
      resolveToolPolicy: () =>
        resolution === undefined || resolution === null ? undefined : resolution,
    },
  } as unknown as Agent;
}

function resolution(mode: McpToolPolicyResolution['mode']): McpToolPolicyResolution {
  return { serverName: 'github', toolName: 'create_issue', mode };
}

describe('McpToolPolicyPermissionPolicy', () => {
  it('ignores non-MCP tools', () => {
    const policy = new McpToolPolicyPermissionPolicy(
      policyAgent({ resolution: resolution('blocked') }),
    );

    expect(policy.evaluate(contextFor('Bash'))).toBeUndefined();
  });

  it('leaves tools of servers without a toolPolicy alone', () => {
    const policy = new McpToolPolicyPermissionPolicy(policyAgent());

    expect(policy.evaluate(contextFor('mcp__github__create_issue'))).toBeUndefined();
  });

  it('denies blocked tools in manual mode', () => {
    const policy = new McpToolPolicyPermissionPolicy(
      policyAgent({ mode: 'manual', resolution: resolution('blocked') }),
    );

    const result = policy.evaluate(contextFor('mcp__github__create_issue'));
    expect(result?.kind).toBe('deny');
  });

  it('keeps blocked tools blocked in yolo mode', () => {
    const policy = new McpToolPolicyPermissionPolicy(
      policyAgent({ mode: 'yolo', resolution: resolution('blocked') }),
    );

    const result = policy.evaluate(contextFor('mcp__github__create_issue'));
    expect(result?.kind).toBe('deny');
  });

  it('approves allow without prompting', () => {
    const policy = new McpToolPolicyPermissionPolicy(
      policyAgent({ mode: 'manual', resolution: resolution('allow') }),
    );

    const result = policy.evaluate(contextFor('mcp__github__create_issue'));
    expect(result?.kind).toBe('approve');
  });

  it('asks for an ask-policy tool in manual and auto modes', () => {
    for (const mode of ['manual', 'auto'] as const) {
      const policy = new McpToolPolicyPermissionPolicy(
        policyAgent({ mode, resolution: resolution('ask') }),
      );

      const result = policy.evaluate(contextFor('mcp__github__create_issue'));
      expect(result?.kind).toBe('ask');
    }
  });

  it('lets yolo approve ask-policy tools without a prompt', () => {
    const policy = new McpToolPolicyPermissionPolicy(
      policyAgent({ mode: 'yolo', resolution: resolution('ask') }),
    );

    expect(policy.evaluate(contextFor('mcp__github__create_issue'))).toBeUndefined();
  });

  it('leaves allow-policy tools to the plan-mode policies while planning', () => {
    const policy = new McpToolPolicyPermissionPolicy(
      policyAgent({ mode: 'manual', planMode: true, resolution: resolution('allow') }),
    );

    expect(policy.evaluate(contextFor('mcp__github__create_issue'))).toBeUndefined();
  });

  it('still denies blocked tools while planning', () => {
    const policy = new McpToolPolicyPermissionPolicy(
      policyAgent({ mode: 'manual', planMode: true, resolution: resolution('blocked') }),
    );

    expect(policy.evaluate(contextFor('mcp__github__create_issue'))?.kind).toBe('deny');
  });
});
