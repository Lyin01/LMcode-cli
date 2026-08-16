export type DeepSeekEditorCommand = 'view' | 'create' | 'str_replace' | 'insert';

export function canonicalDeepSeekAnchorToolName(toolName: string, args: unknown): string {
  if (toolName === 'bash') return 'Bash';
  if (toolName !== 'str_replace_editor') return toolName;

  const command =
    typeof args === 'object' && args !== null
      ? (args as { readonly command?: unknown }).command
      : undefined;
  switch (command) {
    case 'view':
      return 'Read';
    case 'create':
      return 'Write';
    case 'str_replace':
    case 'insert':
      return 'Edit';
    default:
      return toolName;
  }
}
