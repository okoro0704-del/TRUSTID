import { BIOMETRIC_ERROR_CODES, type BiometricErrorCode } from "@trustid/shared";

export class BiometricPipelineError extends Error {
  readonly code: BiometricErrorCode;

  constructor(code: BiometricErrorCode, message: string) {
    super(message);
    this.name = "BiometricPipelineError";
    this.code = code;
  }
}

export function biometricUnavailable(message: string): BiometricPipelineError {
  return new BiometricPipelineError(
    BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
    message,
  );
}

export function biometricFail(
  code: BiometricErrorCode,
  message: string,
): BiometricPipelineError {
  return new BiometricPipelineError(code, message);
}
