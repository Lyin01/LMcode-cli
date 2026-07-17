/**
 * Path safety guards used by Read/Write/Edit/Grep/Glob.
 *
 * Lexical canonicalization mirrors `JianPath.canonical()` and keeps the
 * guard backend-aware. File tools additionally call
 * `resolveRealPathAccessPath()` so workspace and sensitive-file decisions
 * are made against the physical target after symbolic links are resolved.
 *
 * Callers should pass the active Jian path class so SSH paths stay POSIX
 * even when the host Node process is running on Windows.
 *
 * Shared-prefix escapes (a path like `/workspace-evil` passing a naive
 * `startswith('/workspace')` check) are blocked by requiring a path
 * separator (or exact equality) after the base prefix in
 * `isWithinDirectory`.
 */

import { basename, dirname, isAbsolute, join, normalize, resolve } from 'pathe';

import type { Jian } from '@lmcode-cli/jian';

import type { WorkspaceConfig } from '../support/workspace';
import { isSensitiveFile } from './sensitive';

export type PathClass = 'posix' | 'win32';
export type PathSecurityCode = 'PATH_OUTSIDE_WORKSPACE' | 'PATH_SENSITIVE' | 'PATH_INVALID';
export type PathAccessOperation = 'read' | 'write' | 'search';
export type WorkspaceGuardMode = 'strict' | 'absolute-outside-allowed' | 'disabled';

export interface WorkspaceAccessPolicy {
  readonly guardMode: WorkspaceGuardMode;
  readonly checkSensitive: boolean;
}

export const STRICT_WORKSPACE_ACCESS_POLICY: WorkspaceAccessPolicy = {
  guardMode: 'strict',
  checkSensitive: true,
};

export const DEFAULT_WORKSPACE_ACCESS_POLICY: WorkspaceAccessPolicy = {
  guardMode: 'absolute-outside-allowed',
  checkSensitive: true,
};

export interface PathAccess {
  readonly path: string;
  readonly outsideWorkspace: boolean;
}

export class PathSecurityError extends Error {
  readonly code: PathSecurityCode;
  readonly rawPath: string;
  readonly canonicalPath: string;

  constructor(code: PathSecurityCode, rawPath: string, canonicalPath: string, message: string) {
    super(message);
    this.name = 'PathSecurityError';
    this.code = code;
    this.rawPath = rawPath;
    this.canonicalPath = canonicalPath;
  }
}

const DEFAULT_PATH_CLASS: PathClass = process.platform === 'win32' ? 'win32' : 'posix';

function isWin32DriveRelative(path: string): boolean {
  return /^[A-Za-z]:(?:$|[^\\/])/.test(path);
}

export function normalizeUserPath(path: string, pathClass: PathClass = DEFAULT_PATH_CLASS): string {
  if (pathClass !== 'win32') return path;

  // A bare root slash stays forward so downstream pathe operations
  // treat it consistently. Matches the py helper's behavior.
  if (path === '/') return '/';

  if (path.startsWith('//')) {
    return path;
  }

  const cygdriveMatch = /^\/cygdrive\/([A-Za-z])(?:\/|$)/.exec(path);
  if (cygdriveMatch !== null) {
    const drive = cygdriveMatch[1]!.toUpperCase();
    const rest = path.slice(`/cygdrive/${cygdriveMatch[1]!}`.length);
    return `${drive}:${rest === '' ? '/' : rest}`;
  }

  const driveMatch = /^\/([A-Za-z])(?:\/|$)/.exec(path);
  if (driveMatch !== null) {
    const drive = driveMatch[1]!.toUpperCase();
    const rest = path.slice(2);
    return `${drive}:${rest === '' ? '/' : rest}`;
  }

  return path;
}

function expandUserPath(path: string, homeDir: string | undefined, pathClass: PathClass): string {
  if (homeDir === undefined) return path;
  if (path === '~') return homeDir;
  if (path.startsWith('~/') || (pathClass === 'win32' && path.startsWith('~\\'))) {
    return join(homeDir, path.slice(2));
  }
  return path;
}

/**
 * Lexical canonicalization: resolve relative → absolute against `cwd`,
 * then normalize `..` / `.` segments. No filesystem I/O.
 */
export function canonicalizePath(
  path: string,
  cwd: string,
  pathClass: PathClass = DEFAULT_PATH_CLASS,
): string {
  if (path === '') {
    throw new PathSecurityError('PATH_INVALID', path, path, 'Path cannot be empty');
  }
  const normalizedPath = normalizeUserPath(path, pathClass);
  if (pathClass === 'win32' && isWin32DriveRelative(normalizedPath)) {
    throw new PathSecurityError(
      'PATH_INVALID',
      path,
      normalizedPath,
      `"${path}" is a drive-relative Windows path. Use an absolute path like C:\\path or a path relative to the working directory.`,
    );
  }
  if (!isAbsolute(normalizedPath) && !isAbsolute(cwd)) {
    throw new PathSecurityError(
      'PATH_INVALID',
      path,
      normalizedPath,
      `Cannot resolve "${path}" against non-absolute cwd "${cwd}".`,
    );
  }
  const abs = isAbsolute(normalizedPath) ? normalizedPath : resolve(cwd, normalizedPath);
  return normalize(abs);
}

/**
 * True iff `candidate` is `base` itself or a descendant of it, compared
 * on path-component boundaries. Both arguments must already be canonical.
 */
export function isWithinDirectory(
  candidate: string,
  base: string,
  pathClass: PathClass = DEFAULT_PATH_CLASS,
): boolean {
  const nc = normalize(candidate);
  const nb = normalize(base);
  const comparableCandidate = pathClass === 'win32' ? nc.toLowerCase() : nc;
  const comparableBase = pathClass === 'win32' ? nb.toLowerCase() : nb;
  if (comparableCandidate === comparableBase) return true;
  const prefix = comparableBase.endsWith('/') ? comparableBase : comparableBase + '/';
  return comparableCandidate.startsWith(prefix);
}

/**
 * True iff `candidate` (already canonical) sits inside any of the workspace
 * roots listed in `config` (primary `workspaceDir` or any `additionalDirs`).
 */
export function isWithinWorkspace(
  candidate: string,
  config: WorkspaceConfig,
  pathClass: PathClass = DEFAULT_PATH_CLASS,
): boolean {
  if (isWithinDirectory(candidate, config.workspaceDir, pathClass)) return true;
  for (const dir of config.additionalDirs) {
    if (isWithinDirectory(candidate, dir, pathClass)) return true;
  }
  return false;
}

export interface AssertPathOptions {
  readonly mode: PathAccessOperation;
  /** When true (default), also reject paths matching a sensitive-file pattern. */
  readonly checkSensitive?: boolean | undefined;
  readonly pathClass?: PathClass | undefined;
}

export interface ResolvePathAccessOptions {
  readonly operation: PathAccessOperation;
  readonly policy?: WorkspaceAccessPolicy | undefined;
  readonly pathClass?: PathClass | undefined;
  readonly homeDir?: string;
}

export interface ResolvePathAccessPathOptions {
  readonly jian: Pick<Jian, 'pathClass' | 'gethome'>;
  readonly workspace: WorkspaceConfig;
  readonly operation: PathAccessOperation;
  readonly policy?: WorkspaceAccessPolicy;
  readonly expandHome?: boolean;
}

export interface ResolveRealPathAccessPathOptions {
  readonly jian: Pick<Jian, 'pathClass' | 'gethome' | 'realpath' | 'stat'>;
  readonly workspace: WorkspaceConfig;
  readonly operation: PathAccessOperation;
  readonly policy?: WorkspaceAccessPolicy;
  readonly expandHome?: boolean;
}

function outsideWorkspaceMessage(
  path: string,
  canonical: string,
  config: WorkspaceConfig,
  operation: PathAccessOperation,
): string {
  const allowed = [config.workspaceDir, ...config.additionalDirs].join(', ');
  const verb = operation === 'write' ? 'written' : operation === 'search' ? 'searched' : 'read';
  return (
    `"${path}" (canonical: "${canonical}") is outside the workspace ` +
    `and outside the working directory "${config.workspaceDir}". ` +
    `Cannot be ${verb}. Allowed roots: ${allowed}`
  );
}

function relativeOutsideMessage(path: string, operation: PathAccessOperation): string {
  const verb =
    operation === 'write'
      ? 'write or edit a file'
      : operation === 'search'
        ? 'search'
        : 'read a file';
  return (
    `"${path}" is not an absolute path. ` +
    `You must provide an absolute path to ${verb} outside the working directory.`
  );
}

export function resolvePathAccess(
  path: string,
  cwd: string,
  config: WorkspaceConfig,
  options: ResolvePathAccessOptions,
): PathAccess {
  const pathClass = options.pathClass ?? DEFAULT_PATH_CLASS;
  const normalizedPath = normalizeUserPath(path, pathClass);
  const expandedPath = expandUserPath(normalizedPath, options.homeDir, pathClass);
  const rawIsAbsolute = isAbsolute(expandedPath);
  const canonical = canonicalizePath(expandedPath, cwd, pathClass);
  const outsideWorkspace = !isWithinWorkspace(canonical, config, pathClass);
  const policy = options.policy ?? DEFAULT_WORKSPACE_ACCESS_POLICY;

  if (policy.checkSensitive && isSensitiveFile(canonical)) {
    throw new PathSecurityError(
      'PATH_SENSITIVE',
      path,
      canonical,
      `"${path}" matches a sensitive-file pattern (env / credential / SSH key). ` +
        `Access is blocked to protect secrets.`,
    );
  }

  // Strict mode requires the input itself to be absolute, even if it
  // would canonicalize to a path inside the workspace. The python Glob
  // contract is "directory must be an absolute path"; resolving a
  // relative argument against the workspace cwd silently re-targets the
  // search and is rejected outright in that contract.
  if (policy.guardMode === 'strict' && !rawIsAbsolute) {
    throw new PathSecurityError(
      'PATH_OUTSIDE_WORKSPACE',
      path,
      canonical,
      relativeOutsideMessage(path, options.operation),
    );
  }

  if (outsideWorkspace) {
    switch (policy.guardMode) {
      case 'strict':
        throw new PathSecurityError(
          'PATH_OUTSIDE_WORKSPACE',
          path,
          canonical,
          outsideWorkspaceMessage(path, canonical, config, options.operation),
        );
      case 'absolute-outside-allowed':
        if (!rawIsAbsolute) {
          throw new PathSecurityError(
            'PATH_OUTSIDE_WORKSPACE',
            path,
            canonical,
            relativeOutsideMessage(path, options.operation),
          );
        }
        break;
      case 'disabled':
        break;
    }
  }

  return { path: canonical, outsideWorkspace };
}

export function resolvePathAccessPath(
  path: string,
  options: ResolvePathAccessPathOptions,
): string {
  const { jian, workspace, operation, policy, expandHome = true } = options;
  return resolvePathAccess(path, workspace.workspaceDir, workspace, {
    operation,
    policy,
    pathClass: jian.pathClass(),
    homeDir: expandHome ? jian.gethome() : undefined,
  }).path;
}

function isPathNotFoundError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 2) return true;
  return error instanceof Error && error.name === 'JianFileNotFoundError';
}

/**
 * Resolve the deepest existing ancestor and preserve any not-yet-existing
 * suffix. The lstat-style probe distinguishes a genuinely missing component
 * from a dangling symlink, which must fail closed instead of being treated as
 * a creatable filename.
 */
async function resolvePhysicalPath(
  path: string,
  jian: Pick<Jian, 'realpath' | 'stat'>,
): Promise<string> {
  let candidate = path;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const physical = normalize(await jian.realpath(candidate));
      return missingSegments.length === 0 ? physical : join(physical, ...missingSegments);
    } catch (realpathError) {
      if (!isPathNotFoundError(realpathError)) throw realpathError;

      try {
        await jian.stat(candidate, { followSymlinks: false });
      } catch (statError) {
        if (!isPathNotFoundError(statError)) throw statError;

        const parent = dirname(candidate);
        if (parent === candidate) throw realpathError;
        missingSegments.unshift(basename(candidate));
        candidate = parent;
        continue;
      }

      throw new PathSecurityError(
        'PATH_INVALID',
        path,
        candidate,
        `Cannot resolve "${path}" because "${candidate}" is a dangling symbolic link.`,
      );
    }
  }
}

/**
 * Resolve a tool path to its physical target before producing permission
 * metadata or performing I/O. Workspace roots are physicalized as well so a
 * repository opened through a symlink remains a valid workspace.
 */
export async function resolveRealPathAccessPath(
  path: string,
  options: ResolveRealPathAccessPathOptions,
): Promise<string> {
  const { jian, workspace, operation, policy, expandHome = true } = options;
  const pathClass = jian.pathClass();
  const homeDir = expandHome ? jian.gethome() : undefined;
  const expandedInput = expandUserPath(normalizeUserPath(path, pathClass), homeDir, pathClass);
  const inputIsAbsolute = isAbsolute(expandedInput);
  const lexical = resolvePathAccess(path, workspace.workspaceDir, workspace, {
    operation,
    policy,
    pathClass,
    homeDir,
  });

  let physicalPath: string;
  let physicalWorkspace: WorkspaceConfig;
  try {
    const [resolvedPath, workspaceDir, ...additionalDirs] = await Promise.all([
      resolvePhysicalPath(lexical.path, jian),
      resolvePhysicalPath(workspace.workspaceDir, jian),
      ...workspace.additionalDirs.map((dir) => resolvePhysicalPath(dir, jian)),
    ]);
    physicalPath = resolvedPath;
    physicalWorkspace = { workspaceDir, additionalDirs };
  } catch (error) {
    if (error instanceof PathSecurityError) throw error;
    throw new PathSecurityError(
      'PATH_INVALID',
      path,
      lexical.path,
      `Cannot resolve the physical path for "${path}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const effectivePolicy = policy ?? DEFAULT_WORKSPACE_ACCESS_POLICY;
  if (
    effectivePolicy.guardMode === 'absolute-outside-allowed' &&
    !inputIsAbsolute &&
    !isWithinWorkspace(physicalPath, physicalWorkspace, pathClass)
  ) {
    throw new PathSecurityError(
      'PATH_OUTSIDE_WORKSPACE',
      path,
      physicalPath,
      relativeOutsideMessage(path, operation),
    );
  }

  return resolvePathAccess(physicalPath, physicalWorkspace.workspaceDir, physicalWorkspace, {
    operation,
    policy: effectivePolicy,
    pathClass,
  }).path;
}

/**
 * Ensure a physical target did not change between permission resolution and
 * execution. A changed target has not been authorized, even when both paths
 * would independently pass workspace policy.
 */
export async function revalidateRealPathAccessPath(
  path: string,
  approvedPath: string,
  options: ResolveRealPathAccessPathOptions,
): Promise<string> {
  const currentPath = await resolveRealPathAccessPath(path, options);
  const pathClass = options.jian.pathClass();
  const comparableApproved = pathClass === 'win32' ? approvedPath.toLowerCase() : approvedPath;
  const comparableCurrent = pathClass === 'win32' ? currentPath.toLowerCase() : currentPath;
  if (comparableCurrent !== comparableApproved) {
    throw new PathSecurityError(
      'PATH_INVALID',
      path,
      currentPath,
      `The physical target for "${path}" changed after access was approved. Retry the tool call.`,
    );
  }
  return approvedPath;
}

/**
 * Best-effort TOCTOU pin for file writes: immediately before writing to an
 * approved physical path, re-resolve the parent directory and confirm it is
 * still the directory the approval covered. A local adversary could
 * otherwise swap an intermediate directory for a symlink between
 * `revalidateRealPathAccessPath()` and the final write, redirecting the
 * write outside the approved target. Fails closed on drift; a failed
 * re-resolution (e.g. an environment without `realpath`) keeps the prior
 * behavior and lets the write surface any real I/O error.
 */
export async function pinPhysicalParentDirectory(
  safePath: string,
  options: { readonly jian: Pick<Jian, 'realpath' | 'pathClass'> },
): Promise<void> {
  const { jian } = options;
  const parent = dirname(safePath);
  let physicalParent: string;
  try {
    physicalParent = normalize(await jian.realpath(parent));
  } catch {
    return;
  }
  const pathClass = jian.pathClass();
  const expected = pathClass === 'win32' ? parent.toLowerCase() : parent;
  const actual = pathClass === 'win32' ? physicalParent.toLowerCase() : physicalParent;
  if (actual !== expected) {
    throw new PathSecurityError(
      'PATH_INVALID',
      safePath,
      physicalParent,
      `The parent directory for "${safePath}" changed after access was approved. Retry the tool call.`,
    );
  }
}

/**
 * Throw `PathSecurityError` if `path` is outside the workspace, a known
 * sensitive file, or an empty string. Returns the canonical absolute path
 * when the check passes.
 *
 * Note: this helper is purely lexical. File-system operations should use
 * `resolveRealPathAccessPath()` so symbolic links are resolved before access.
 */
export function assertPathAllowed(
  path: string,
  cwd: string,
  config: WorkspaceConfig,
  options: AssertPathOptions,
): string {
  return resolvePathAccess(path, cwd, config, {
    operation: options.mode,
    pathClass: options.pathClass,
    policy: {
      guardMode: 'strict',
      checkSensitive: options.checkSensitive ?? STRICT_WORKSPACE_ACCESS_POLICY.checkSensitive,
    },
  }).path;
}
