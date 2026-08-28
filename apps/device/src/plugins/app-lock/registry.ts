export type { SovereignAppLockPolicy, AppLockPlugin } from "../app-lock/index.js";
export { TrustIdAppLock } from "../app-lock/index.js";

import type { AppLockConfig, ProtectedAppEntry, ProtectedRoute } from "@trustid/vault-sdk";
import { AppLockRegistry, DEFAULT_APP_LOCK_CONFIG } from "@trustid/vault-sdk";

/** Client-side registry synced with native Accessibility policy on save. */
export class DeviceAppLockRegistry extends AppLockRegistry {
  constructor(storage?: Storage) {
    super(storage);
  }

  static defaultConfig(): AppLockConfig {
    return { ...DEFAULT_APP_LOCK_CONFIG };
  }

  async registerHiddenApp(app: Omit<ProtectedAppEntry, "addedAt">): Promise<AppLockConfig> {
    const config = await this.addProtectedApp({ ...app, hidden: true });
    return this.addHiddenShortcut(app.appId);
  }

  async registerMediaRoute(path: string): Promise<AppLockConfig> {
    return this.addProtectedRoute({
      path,
      sensitivity: "critical",
      hidden: true,
    } satisfies ProtectedRoute);
  }
}
