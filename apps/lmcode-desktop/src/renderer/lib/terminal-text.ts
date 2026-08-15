const ANSI_SEQUENCE = new RegExp(
  String.raw`\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))`,
  'g',
)
const UNSAFE_CONTROL_CHARACTERS = new RegExp(
  String.raw`[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]`,
  'g',
)

export function normalizeTerminalText(value: string): string {
  return value
    .replace(ANSI_SEQUENCE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replaceAll('\t', '    ')
    .replace(UNSAFE_CONTROL_CHARACTERS, '')
}
