import type { Agent } from '../..';
import { isMcpToolName } from '../../../mcp/tool-naming';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * Applies the per-server `toolPolicy` an MCP declaration carries in
 * `mcp.json` (`allow` / `ask` / `blocked`). Runs before the mode-level
 * approve policies so a server can pin a tool to "always ask" without the
 * user having to remember to stay in `manual` mode:
 *
 *   - `blocked` denies in every mode, `yolo` included — it is a hard boundary
 *     like the file sandbox, not an approval preference.
 *   - `ask` asks in `manual` and `auto`; `yolo` means "approve everything",
 *     so it falls through instead of nagging on every call.
 *   - `allow` approves ahead of plan/tool allow-lists, which is what "I trust
 *     this server" is supposed to mean.
 *
 * Tools of servers without a `toolPolicy` keep the existing behaviour: the
 * policy returns `undefined` and the earlier defaults decide.
 */
export class McpToolPolicyPermissionPolicy implements PermissionPolicy {
  readonly name = 'mcp-tool-policy';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const toolName = context.toolCall.name;
    if (!isMcpToolName(toolName)) return undefined;

    const resolution = this.agent.mcp?.resolveToolPolicy(toolName);
    if (resolution === undefined) return undefined;

    const reason = {
      server: resolution.serverName,
      tool: resolution.toolName,
      policy: resolution.mode,
    };

    if (resolution.mode === 'blocked') {
      return {
        kind: 'deny',
        reason,
        message:
          `MCP 服务器 "${resolution.serverName}" 的 toolPolicy 将工具 "${resolution.toolName}" 标记为 blocked，` +
          '本次调用已阻止。把所有权的策略改为 ask 或 allow 后才能再次调用。',
      };
    }

    if (resolution.mode === 'allow') {
      // Plan mode is a read-only contract about *this* turn, not about the
      // server: fall through so the plan-mode policies keep deciding.
      if (this.agent.planMode?.isActive === true) return undefined;
      return { kind: 'approve', reason };
    }

    // mode === 'ask'
    if (this.agent.permission.mode === 'yolo') return undefined;
    return { kind: 'ask', reason };
  }
}
