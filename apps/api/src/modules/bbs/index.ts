export type {
  BbsStepUpProof,
  IBiometricBankingProvider,
  StepUpChallenge,
  StepUpChallengeStatus,
  StepUpInitiateContext,
  StepUpVerifyResult,
  TrustIdBbsClientConfig,
} from "@trustid/bbs-sdk";

export { TrustIdBbsHttpProvider } from "@trustid/bbs-sdk";

export {
  BBS_STEP_UP_STATUS,
  bbsConfirmSchema,
  bbsInitiateSchema,
  bbsVerifySchema,
} from "./schemas.js";
export type { BbsInitiateInput, BbsStepUpStatus, BbsVerifyInput } from "./schemas.js";

export {
  approveBbsStepUp,
  confirmBbsStepUp,
  expireBbsChallengeIfNeeded,
  getBbsChallengeStatus,
  initiateBbsStepUp,
  verifyBbsStepUpProof,
  BbsError,
} from "./service.js";
