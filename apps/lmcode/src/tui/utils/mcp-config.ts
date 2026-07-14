import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as util from 'node:util';

import { LMCODE_DATA_DIR_NAME } from '#/constant/app';
import {
  MCP_CONFIG_FILE_NAME,
  MCP_CONFIG_MAX_PARENT_WALK,
} from '#/tui/constant/lmcode-tui';

export type McpConfigScope = 'user' | 'project';

export interface McpConfigSource {
  readonly scope: McpConfigScope;
  readonly filePath: string;
}

export interface EffectiveMcpServerConfig {
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly source: McpConfigSource;
  readonly shadowedSources: readonly McpConfigSource[];
}

export interface McpConfigLocationInput {
  readonly dataDir: string;
  readonly workDir: string;
}

export interface RemoveEffectiveMcpServerResult {
  readonly removed: EffectiveMcpServerConfig | undefined;
  readonly next: EffectiveMcpServerConfig | undefined;
}

export interface RemoveEffectiveMcpServerExpectation {
  readonly filePath: string;
  readonly config: Readonly<Record<string, unknown>>;
}

interface McpConfigDocument {
  readonly data: Record<string, unknown>;
  readonly servers: Record<string, Record<string, unknown>>;
}

export class McpConfigFileError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'McpConfigFileError';
    this.filePath = filePath;
  }
}

export function resolveMcpConfigSources(
  input: McpConfigLocationInput,
): readonly McpConfigSource[] {
  const workDir = path.resolve(input.workDir);
  const parents: McpConfigSource[] = [];
  let dir = path.dirname(workDir);
  for (
    let index = 0;
    index < MCP_CONFIG_MAX_PARENT_WALK && dir !== path.dirname(dir);
    index++
  ) {
    parents.push({
      scope: 'project',
      filePath: path.join(dir, LMCODE_DATA_DIR_NAME, MCP_CONFIG_FILE_NAME),
    });
    dir = path.dirname(dir);
  }
  parents.reverse();

  return [
    {
      scope: 'user',
      filePath: path.join(input.dataDir, MCP_CONFIG_FILE_NAME),
    },
    ...parents,
    {
      scope: 'project',
      filePath: path.join(workDir, LMCODE_DATA_DIR_NAME, MCP_CONFIG_FILE_NAME),
    },
  ];
}

export async function loadEffectiveMcpServers(
  input: McpConfigLocationInput,
): Promise<ReadonlyMap<string, EffectiveMcpServerConfig>> {
  const effective = new Map<string, EffectiveMcpServerConfig>();
  for (const source of resolveMcpConfigSources(input)) {
    const document = await readMcpConfigDocument(source.filePath);
    if (document === undefined) continue;
    for (const [name, config] of Object.entries(document.servers)) {
      const previous = effective.get(name);
      effective.set(name, {
        name,
        config,
        source,
        shadowedSources:
          previous === undefined
            ? []
            : [...previous.shadowedSources, previous.source],
      });
    }
  }
  return effective;
}

export async function upsertUserMcpServer(
  input: McpConfigLocationInput,
  name: string,
  config: Readonly<Record<string, unknown>>,
): Promise<void> {
  const source = resolveMcpConfigSources(input)[0];
  if (source === undefined) throw new Error('User MCP config path is unavailable');
  const document = (await readMcpConfigDocument(source.filePath)) ?? {
    data: {},
    servers: {},
  };
  await writeMcpConfigDocument(source.filePath, {
    ...document.data,
    mcpServers: {
      ...document.servers,
      [name]: config,
    },
  });
}

export async function removeEffectiveMcpServer(
  input: McpConfigLocationInput,
  name: string,
  expected?: RemoveEffectiveMcpServerExpectation,
): Promise<RemoveEffectiveMcpServerResult> {
  const before = await loadEffectiveMcpServers(input);
  const removed = before.get(name);
  if (removed === undefined) return { removed: undefined, next: undefined };
  if (
    expected !== undefined &&
    path.resolve(removed.source.filePath) !== path.resolve(expected.filePath)
  ) {
    throw new McpConfigFileError(
      removed.source.filePath,
      `MCP server "${name}" changed configuration source before removal`,
    );
  }

  const document = await readMcpConfigDocument(removed.source.filePath);
  if (
    document === undefined ||
    !Object.hasOwn(document.servers, name)
  ) {
    throw new McpConfigFileError(
      removed.source.filePath,
      `MCP server "${name}" changed while it was being removed`,
    );
  }
  const currentConfig = document.servers[name];
  if (
    expected !== undefined &&
    !util.isDeepStrictEqual(currentConfig, expected.config)
  ) {
    throw new McpConfigFileError(
      removed.source.filePath,
      `MCP server "${name}" changed since the panel was opened; 请刷新 MCP 面板后重试`,
    );
  }
  const servers = { ...document.servers };
  delete servers[name];
  await writeMcpConfigDocument(removed.source.filePath, {
    ...document.data,
    mcpServers: servers,
  });

  const after = await loadEffectiveMcpServers(input);
  return { removed, next: after.get(name) };
}

async function readMcpConfigDocument(
  filePath: string,
): Promise<McpConfigDocument | undefined> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw new McpConfigFileError(filePath, 'Unable to read MCP config', error);
  }

  if (text.trim().length === 0) return { data: {}, servers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new McpConfigFileError(filePath, 'Invalid JSON in MCP config', error);
  }
  if (!isRecord(parsed)) {
    throw new McpConfigFileError(filePath, 'MCP config must be a JSON object');
  }

  const rawServers = parsed['mcpServers'];
  if (rawServers !== undefined && !isRecord(rawServers)) {
    throw new McpConfigFileError(filePath, 'MCP config mcpServers must be a JSON object');
  }
  const servers = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const [name, config] of Object.entries(rawServers ?? {})) {
    if (!isRecord(config)) {
      throw new McpConfigFileError(
        filePath,
        `MCP server "${name}" must be a JSON object`,
      );
    }
    servers[name] = config;
  }
  return { data: parsed, servers };
}

async function writeMcpConfigDocument(
  filePath: string,
  data: Readonly<Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const suffix = crypto.randomBytes(4).toString('hex');
  const tempPath = `${filePath}.tmp.${String(process.pid)}.${suffix}`;
  let renamed = false;
  try {
    const handle = await fs.open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await fs.unlink(tempPath).catch(() => {});
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
