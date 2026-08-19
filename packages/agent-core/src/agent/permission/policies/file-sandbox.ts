import type { Agent } from '../..';
import type { ToolFileAccess } from '../../../loop/tool-access';
import { isWithinDirectory } from '../../../tools/policies/path-access';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { hasUnrestrictedAccess, resolvePermissionCwd, writeFileAccesses } from './file-access-ask';

/**
 * Hard file-sandbox boundary, orthogonal to the approval mode.
 *
 * Unlike the `ask`-style file policies, this policy never opens an approval
 * prompt — it denies outright, and it applies in every permission mode
 * including `yolo`. It reads the session's configured {@link FileSandboxMode}:
 *
 *   - `read-only`       — deny every file write
 *   - `workspace-write` — deny writes whose target is outside the session cwd
 *   - `full-access`     — no-op (existing policies still apply)
 */
export class FileSandboxPermissionPolicy implements PermissionPolicy {
  readonly name = 'file-sandbox';

  constructor(private readonly agent: Agent) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const sandbox = this.agent.permission.fileSandbox;
    if (sandbox === 'full-access') return undefined;

    const writeAccesses = writeFileAccesses(context);
    const unrestricted = hasUnrestrictedAccess(context);
    if (writeAccesses.length === 0 && !unrestricted) return undefined;

    if (sandbox === 'read-only') {
      return {
        kind: 'deny',
        message: 'File writes are disabled by the read-only file sandbox.',
        reason: fileSandboxReason(writeAccesses[0], 'read-only'),
      };
    }

    // workspace-write: hard-deny writes outside the workspace root.
    const configuredCwd = this.agent.config.cwd;
    if (configuredCwd.length === 0) return undefined;
    const cwd = await resolvePermissionCwd(this.agent, configuredCwd);
    const pathClass = this.agent.jian.pathClass();
    const outside = writeAccesses.find((access) => !isWithinDirectory(access.path, cwd, pathClass));
    if (outside === undefined) return undefined;
    return {
      kind: 'deny',
      message: 'File writes outside the workspace are disabled by the workspace-write file sandbox.',
      reason: fileSandboxReason(outside, 'workspace-write'),
    };
  }
}

function fileSandboxReason(
  access: ToolFileAccess | undefined,
  sandbox: 'read-only' | 'workspace-write',
): { file_access_operation: string; recursive: boolean; sandbox: string } {
  return {
    file_access_operation: access?.operation ?? 'readwrite',
    recursive: access?.recursive === true || access === undefined,
    sandbox,
  };
}
