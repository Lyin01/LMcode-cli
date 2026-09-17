// Compile every input schema the installed driver advertises with the exact
// Ajv configuration LMCODE uses, and report anything Ajv wants to log.
// Ajv logs through `console` by default; in the TUI that corrupts rendering,
// so a warning here is a real regression rather than cosmetic noise.
import { createRequire } from 'node:module';

const require = createRequire('E:/lmcode-desktop-source/packages/agent-core/package.json');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const logged = [];
const capture = (level) => (...args) => logged.push(`${level}: ${args.map(String).join(' ')}`);
const original = { warn: console.warn, error: console.error, log: console.log };
console.warn = capture('warn');
console.error = capture('error');

const EXE = process.argv[2];
const transport = new StdioClientTransport({ command: EXE, args: ['mcp'], stderr: 'ignore' });
const client = new Client({ name: 'lmcode-schema-probe', version: '0.0.1' }, { capabilities: {} });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

console.warn = original.warn;
console.error = original.error;

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

let compiled = 0;
const failures = [];
for (const tool of tools) {
  try {
    ajv.compile(tool.inputSchema);
    compiled += 1;
  } catch (error) {
    failures.push(`${tool.name}: ${error.message}`);
  }
}

console.log(`tools: ${tools.length}`);
console.log(`compiled: ${compiled}`);
console.log(`compile failures: ${failures.length}`);
for (const failure of failures.slice(0, 10)) console.log(`  ${failure}`);
console.log(`console output during compile: ${logged.length}`);
for (const line of logged.slice(0, 10)) console.log(`  ${line}`);
