import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.js', '.mjs'];

/**
 * Resolve the repository's package-local `#/...` imports while running source
 * through tsx. Node 22 rejects `#/` before package.json imports can match it,
 * so resolution must happen relative to the importing workspace package.
 */
export async function resolve(specifier, context, nextResolve) {
  if (
    !specifier.startsWith('#/') ||
    context.parentURL === undefined ||
    !context.parentURL.startsWith('file:')
  ) {
    return nextResolve(specifier, context);
  }

  const relativePath = specifier.slice(2);
  if (relativePath.includes('\\')) return nextResolve(specifier, context);
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return nextResolve(specifier, context);
  }

  const packageRoot = findPackageRoot(dirname(fileURLToPath(context.parentURL)));
  if (packageRoot === undefined) return nextResolve(specifier, context);

  const sourceRoot = join(packageRoot, 'src');
  const sourceBase = resolvePath(sourceRoot, ...segments);
  const relativeToSource = relative(sourceRoot, sourceBase);
  if (
    relativeToSource === '..' ||
    relativeToSource.startsWith(`..${sep}`) ||
    isAbsolute(relativeToSource)
  ) {
    return nextResolve(specifier, context);
  }
  const candidates = [
    ...SOURCE_SUFFIXES.map((suffix) => `${sourceBase}${suffix}`),
    ...SOURCE_SUFFIXES.slice(1).map((suffix) => join(sourceBase, `index${suffix}`)),
  ];
  const match = candidates.find(isFile);
  if (match === undefined) return nextResolve(specifier, context);
  return { url: pathToFileURL(match).href, shortCircuit: true };
}

function findPackageRoot(startDir) {
  let current = startDir;
  while (true) {
    if (isFile(join(current, 'package.json')) && isDirectory(join(current, 'src'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
