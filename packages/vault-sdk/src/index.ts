import type { BiometricGate } from "@trustid/device-security";
import { DakSession } from "./crypto/dak.js";
import { EncryptedSovereignFileSystem } from "./crypto/esfs.js";
import { AppLockRegistry } from "./applock/registry.js";
import { RouteGuard } from "./applock/guard.js";
import { DuressHandler, HttpElfComEmergencyBridge } from "./applock/duress.js";
import { StepUpController } from "./policy/step-up.js";
import {
  DEFAULT_APP_LOCK_CONFIG,
  DEFAULT_STEP_UP_POLICY,
  type AppLockConfig,
  type ElfComEmergencyBridge,
  type NativeDakBridge,
  type StepUpPolicy,
} from "./types.js";

export type SovereignVaultOptions = {
  gate: BiometricGate;
  nativeDak?: NativeDakBridge;
  elfcom?: ElfComEmergencyBridge;
  stepUpPolicy?: StepUpPolicy;
  storage?: Storage;
};

/**
 * Sovereign Vault & Privacy Shield  orchestrates DAK/eSFS, app lock registry,
 * risk-based step-up, and duress handling.
 */
export class SovereignVault {
  readonly dakSession: DakSession;
  readonly esfs: EncryptedSovereignFileSystem;
  readonly registry: AppLockRegistry;
  readonly stepUp: StepUpController;
  readonly routeGuard: RouteGuard;
  readonly duress: DuressHandler;

  constructor(private readonly opts: SovereignVaultOptions) {
    this.dakSession = new DakSession(opts.gate, opts.nativeDak);
    this.esfs = new EncryptedSovereignFileSystem(this.dakSession);
    this.registry = new AppLockRegistry(opts.storage);
    this.stepUp = new StepUpController(
      opts.gate,
      this.dakSession,
      opts.stepUpPolicy ?? DEFAULT_STEP_UP_POLICY,
    );
    this.duress = new DuressHandler(this.dakSession, this.registry, opts.elfcom);
    this.routeGuard = new RouteGuard(
      this.registry,
      opts.gate,
      this.dakSession,
      this.stepUp,
      () => this.registry.load(),
    );
  }

  async getAppLockConfig(): Promise<AppLockConfig> {
    return this.registry.load();
  }

  async saveAppLockConfig(config: AppLockConfig): Promise<void> {
    await this.registry.save(config);
  }

  lock(): void {
    this.dakSession.lock();
  }
}

export {
  EncryptedSovereignFileSystem,
  ESFS_MAGIC,
  DEFAULT_CHUNK_SIZE,
} from "./crypto/esfs.js";
export type { EsfsChunkRecord } from "./crypto/esfs.js";
export { DakSession } from "./crypto/dak.js";
export {
  aesGcmDecrypt,
  aesGcmEncrypt,
  hkdfSha256,
  importAes256Key,
  generateAes256Key,
} from "./crypto/aes-gcm.js";
export { AppLockRegistry } from "./applock/registry.js";
export { RouteGuard } from "./applock/guard.js";
export {
  DuressHandler,
  HttpElfComEmergencyBridge,
} from "./applock/duress.js";
export {
  computeRiskScore,
  evaluateStepUpRequired,
  evaluateStepUpTrigger,
} from "./policy/engine.js";
export { StepUpController } from "./policy/step-up.js";
export {
  DEFAULT_APP_LOCK_CONFIG,
  DEFAULT_STEP_UP_POLICY,
  type AppLockConfig,
  type BiometricAuthResult,
  type EmergencyAlertPayload,
  type ElfComEmergencyBridge,
  type EsfsManifest,
  type NativeDakBridge,
  type ProtectedAppEntry,
  type ProtectedRoute,
  type RiskContext,
  type RouteSensitivity,
  type StepUpPolicy,
} from "./types.js";

export { DEFAULT_APP_LOCK_CONFIG as DEFAULT_APP_LOCK_POLICY_VAULT };
