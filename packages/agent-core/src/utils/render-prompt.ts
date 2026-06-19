// Lazy-loaded — see getEnv() below.
let _env: ReturnType<typeof createEnv> | undefined;

function createEnv() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nunjucks = require('nunjucks');
  return new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: true });
}

function getEnv(): ReturnType<typeof createEnv> {
  if (!_env) _env = createEnv();
  return _env;
}

export function renderPrompt(template: string, vars: Record<string, unknown>): string {
  return getEnv().renderString(template, vars);
}
