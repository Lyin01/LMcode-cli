import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import type { BashTool } from '../shell/bash';
import DESCRIPTION from './bash.md';

export interface DeepSeekAnchorBashInput {
  readonly command: string;
}

export class DeepSeekAnchorBashTool implements BuiltinTool<DeepSeekAnchorBashInput> {
  readonly name = 'bash' as const;
  readonly description = DESCRIPTION.trim();
  readonly parameters: Record<string, unknown> = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to run. Relative path is preferred in the command.',
      },
    },
    required: ['command'],
  };

  constructor(private readonly bash: BashTool) {}

  resolveExecution(args: DeepSeekAnchorBashInput): ToolExecution {
    return this.bash.resolveExecution({ command: args.command });
  }
}
