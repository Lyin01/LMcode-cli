declare const __LMCODE_VERSION__: string | undefined;
declare const __LMCODE_CHANNEL__: string | undefined;
declare const __LMCODE_COMMIT__: string | undefined;
declare const __LMCODE_BUILD_TARGET__: string | undefined;

export interface LmcodeBuildInfo {
  readonly version?: string;
  readonly channel?: string;
  readonly commit?: string;
  readonly buildTarget?: string;
}

function optionalBuildString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const LMCODE_BUILD_INFO: LmcodeBuildInfo = {
  version:
    typeof __LMCODE_VERSION__ === 'string'
      ? optionalBuildString(__LMCODE_VERSION__)
      : undefined,
  channel:
    typeof __LMCODE_CHANNEL__ === 'string'
      ? optionalBuildString(__LMCODE_CHANNEL__)
      : undefined,
  commit:
    typeof __LMCODE_COMMIT__ === 'string'
      ? optionalBuildString(__LMCODE_COMMIT__)
      : undefined,
  buildTarget:
    typeof __LMCODE_BUILD_TARGET__ === 'string'
      ? optionalBuildString(__LMCODE_BUILD_TARGET__)
      : undefined,
};
