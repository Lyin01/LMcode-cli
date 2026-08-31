/**
 * Parse the desktop MCP add-form "启动命令" field into `{ command, args }`.
 *
 * The core stdio config is `command` plus an `args` array. Sending the whole
 * line as `command` (e.g. `npx -y @foo/mcp`) tries to spawn a binary whose
 * name contains spaces and fails. This tokenizer is not a shell: no pipes,
 * redirects, or env expansion — just whitespace splitting with double quotes
 * so Windows paths like `"C:\Program Files\node\npx.cmd" -y pkg` work.
 */

export interface ParsedStdioCommand {
  readonly command: string
  readonly args: readonly string[]
}

export function parseStdioCommandLine(input: string): ParsedStdioCommand {
  const tokens = tokenizeCommandLine(input)
  const command = tokens[0]
  if (command === undefined) {
    throw new Error('启动命令不能为空')
  }
  return { command, args: tokens.slice(1) }
}

export function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inQuote = false

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!
    if (inQuote) {
      if (ch === '\\' && input[i + 1] === '"') {
        current += '"'
        i += 1
        continue
      }
      if (ch === '"') {
        inQuote = false
        continue
      }
      current += ch
      continue
    }
    if (ch === '"') {
      inQuote = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }

  if (inQuote) {
    throw new Error('启动命令引号未闭合')
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}
