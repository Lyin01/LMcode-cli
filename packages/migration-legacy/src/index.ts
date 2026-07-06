// Public API surface for the lmcode-cli → lmcode migration tool.

export * from './types.js';
export { detectMigration } from './detect.js';
export { runMigration, type RunMigrationInput } from './run-migration.js';
export {
  resolveMigrationScope,
  type MigrationPromptResult,
  type AnyChoice,
  type Prompt1Choice,
  type Prompt2Choice,
} from './prompt.js';
