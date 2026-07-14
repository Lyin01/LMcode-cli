import type { Agent } from '../..';
import { isWithinDirectory } from '../../../tools/policies/path-access';
import { findGitWorkTreeMarker } from '../../../tools/support/git-worktree';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { resolvePermissionCwd, writeFileAccesses } from './file-access-ask';

export class GitCwdWriteApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'git-cwd-write-approve';

  constructor(private readonly agent: Agent) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return;
    if (this.agent.jian.pathClass() !== 'posix') return;

    const configuredCwd = this.agent.config.cwd;
    if (configuredCwd.length === 0) return;

    const writeAccesses = writeFileAccesses(context);
    if (writeAccesses.length === 0) return;
    const cwd = await resolvePermissionCwd(this.agent, configuredCwd);
    if (!writeAccesses.every((access) => isWithinDirectory(access.path, cwd, 'posix'))) {
      return;
    }

    const marker = await findGitWorkTreeMarker(this.agent.jian, cwd);
    if (marker === null) return;

    return {
      kind: 'approve',
    };
  }
}
