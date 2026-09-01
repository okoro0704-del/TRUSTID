export { biometricMatcher, BiometricMatcherService } from "./matcher.js";
export type { BiometricMatchResult } from "./matcher.js";
export {
  registerMasterDevice,
  verifyMasterDeviceBinding,
  getMasterDeviceForUser,
} from "./master-device.js";
export {
  issueMasterChallenge,
  approveMasterChallenge,
  getMasterChallenge,
} from "./challenges.js";
export {
  validateBiometricIdentity,
  checkMasterDeviceBinding,
  verifyBiometricAndSession,
} from "./middleware.js";
export type { BiometricAuthContext } from "./middleware.js";
export * from "./schemas.js";
