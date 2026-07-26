const ANSI_SEQUENCE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g

export function normalizeTerminalText(value: string): string {
  return value
    .replace(ANSI_SEQUENCE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replaceAll('\t', '    ')
    .replace(UNSAFE_CONTROL_CHARACTERS, '')
}
