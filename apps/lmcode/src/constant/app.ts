import type { ErrorCodes } from '@lmcode-cli/lmcode-sdk';

export const PRODUCT_NAME = 'LMcode';
export const CLI_COMMAND_NAME = 'lm';
// Product constants used in HTTP User-Agent headers.
export const CLI_USER_AGENT_PRODUCT = 'lmcode-cli';
export const CLI_UI_MODE = 'shell';
// Give graceful shutdown a short window without making CLI exit feel stuck.
export const CLI_SHUTDOWN_TIMEOUT_MS = 3000;

// App-owned data paths. SDK/core runtime config is intentionally not routed here.

export const LMCODE_HOME_ENV = 'LMCODE_HOME';
export const LMCODE_INSTALL_DIR_ENV = 'LMCODE_INSTALL_DIR';
export const LMCODE_DATA_DIR_NAME = '.lmcode';
export const LMCODE_LOG_DIR_NAME = 'logs';
export const LMCODE_UPDATE_DIR_NAME = 'updates';
export const LMCODE_UPDATE_STATE_FILE_NAME = 'latest.json';
export const LMCODE_INPUT_HISTORY_DIR_NAME = 'user-history';

// Managed LMcode auth provider key shared with OAuth/SDK config.
export const DEFAULT_OAUTH_PROVIDER_NAME = 'managed:lmcode';

// SDK/core error code that tells the TUI to show a login-required startup
// notice. Pinned as a literal but type-checked against the SDK's
// ErrorCodes: if core ever changes the code value, this line stops
// compiling. A value import here would put the ENTIRE SDK on the
// static graph of the app's most-imported constants module — and thus
// on the `lm --version` startup path (~4 MB of module init).
export const OAUTH_LOGIN_REQUIRED_CODE: (typeof ErrorCodes)['AUTH_LOGIN_REQUIRED'] =
  'auth.login_required';

export const FEEDBACK_ISSUE_URL = 'https://github.com/Lyin01/LMcode-cli/issues';

// Sent in the feedback `version` field so the backend can distinguish this
// TypeScript client from clients that send a bare version.
export const FEEDBACK_VERSION_PREFIX = 'lmcode-';


// GitHub — sole source of truth for the project.
export const LMCODE_GITHUB_REPO = 'https://github.com/Lyin01/LMcode-cli';
export const LMCODE_CDN_LATEST_URL =
  'https://api.github.com/repos/Lyin01/LMcode-cli/releases/latest';
export const LMCODE_PLUGIN_MARKETPLACE_URL =
  'https://raw.githubusercontent.com/Lyin01/LMcode-cli/main/plugins/marketplace.json';
export const LMCODE_PLUGIN_MARKETPLACE_URL_ENV = 'LMCODE_PLUGIN_MARKETPLACE_URL';
