export {
  assertLmcodeHostIdentity,
  createLmcodeDefaultHeaders,
  createLmcodeDeviceHeaders,
  createLmcodeDeviceId,
  createLmcodeUserAgent,
  LMCODE_PLATFORM,
} from './identity';
export type {
  DeviceHeaders,
  LmcodeHostIdentity,
  LmcodeIdentityOptions,
} from './identity';

export { isRecord } from './utils';
