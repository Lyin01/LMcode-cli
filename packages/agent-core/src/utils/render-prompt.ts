import * as nunjucks from 'nunjucks';

let environment: nunjucks.Environment | undefined;

function createEnv(): nunjucks.Environment {
  return new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: true });
}

function getEnv(): nunjucks.Environment {
  environment ??= createEnv();
  return environment;
}

export function renderPrompt(template: string, vars: Record<string, unknown>): string {
  return getEnv().renderString(template, vars);
}
