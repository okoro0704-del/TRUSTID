/**
 * Whether biometric step-up may approve anything.
 *
 * TrustID's presentation-attack detection (liveness) is INCOMPLETE and the
 * biometric payload carries no server-verifiable liveness evidence, so a face
 * match alone cannot prove a live person is present. Until PAD is COMPLETE,
 * biometric step-up fails closed. There is deliberately no configuration
 * switch to bypass this.
 */
import { BIOMETRIC_PAD_STATUS } from "@trustid/shared";

export const SERVER_PAD_STATUS: string = BIOMETRIC_PAD_STATUS.INCOMPLETE;

export function biometricStepUpPadReady(): boolean {
  return SERVER_PAD_STATUS === BIOMETRIC_PAD_STATUS.COMPLETE;
}
