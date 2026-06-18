export { LmcodeHarness } from '#/lmcode-harness';
export { Session } from '#/session';
export { LmcodeAuthFacade } from '#/auth';

export {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogCachePath,
  catalogModelToAlias,
  catalogProviderModels,
  CatalogFetchError,
  DEFAULT_CATALOG_URL,
  fetchCatalog,
  inferWireType,
  loadBuiltInCatalog,
  loadCatalogCache,
  saveCatalogCache,
} from '#/catalog';
export type {
  ApplyCatalogProviderOptions,
  Catalog,
  CatalogModel,
  CatalogProviderEntry,
} from '#/catalog';

export {
  ErrorCodes,
  LmcodeError,
  type LmcodeErrorCode,
  type LmcodeErrorInfo,
  type LmcodeErrorOptions,
  type LmcodeErrorPayload,
  SCREAM_ERROR_INFO,
  fromLmcodeErrorPayload,
  isLmcodeError,
  toLmcodeErrorPayload,
} from '@lmcode-cli/agent-core';

// Diagnostic logging — public surface only.
// RootLogger / getRootLogger / LoggingConfig stay inside agent-core.
export {
  flushDiagnosticLogs,
  log,
  redact,
  resolveGlobalLogPath,
  resolveLmcodeHome,
} from '@lmcode-cli/agent-core';
export type { LogContext, LogLevel, LogPayload, Logger } from '@lmcode-cli/agent-core';

// Experimental feature flags — types only. Resolved values come from
// `LmcodeHarness.getExperimentalFlags()` over RPC, not from a re-exported runtime value.
export type {
  ExperimentalFlagMap,
  FlagDefinition,
  FlagDefinitionInput,
  FlagId,
  FlagSurface,
} from '@lmcode-cli/agent-core';
export type { GoalSnapshotData } from '@lmcode-cli/agent-core';

export * from '#/events';
export type * from '#/types';
