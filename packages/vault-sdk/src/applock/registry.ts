import {
  DEFAULT_APP_LOCK_CONFIG,
  type AppLockConfig,
  type ProtectedAppEntry,
  type ProtectedRoute,
} from "../types.js";

const STORAGE_KEY = "trustid.sovereign.app_lock_registry.v1";

export class AppLockRegistry {
  constructor(private readonly storage?: Storage) {}

  async load(): Promise<AppLockConfig> {
    const raw = this.storage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_APP_LOCK_CONFIG };
    try {
      return { ...DEFAULT_APP_LOCK_CONFIG, ...JSON.parse(raw) } as AppLockConfig;
    } catch {
      return { ...DEFAULT_APP_LOCK_CONFIG };
    }
  }

  async save(config: AppLockConfig): Promise<void> {
    this.storage?.setItem(STORAGE_KEY, JSON.stringify(config));
  }

  async addProtectedApp(app: Omit<ProtectedAppEntry, "addedAt">): Promise<AppLockConfig> {
    const config = await this.load();
    if (config.protectedApps.some((a) => a.appId === app.appId)) return config;
    const next: AppLockConfig = {
      ...config,
      protectedAppIds: [...new Set([...config.protectedAppIds, app.appId])],
      protectedApps: [
        ...config.protectedApps,
        { ...app, addedAt: new Date().toISOString() },
      ],
    };
    await this.save(next);
    return next;
  }

  async addProtectedRoute(route: ProtectedRoute): Promise<AppLockConfig> {
    const config = await this.load();
    if (config.protectedRoutes.some((r) => r.path === route.path)) return config;
    const next: AppLockConfig = {
      ...config,
      protectedRoutes: [...config.protectedRoutes, route],
    };
    await this.save(next);
    return next;
  }

  async addHiddenShortcut(appId: string): Promise<AppLockConfig> {
    const config = await this.load();
    const next: AppLockConfig = {
      ...config,
      hiddenAppShortcuts: [...new Set([...config.hiddenAppShortcuts, appId])],
    };
    await this.save(next);
    return next;
  }

  isRouteProtected(config: AppLockConfig, path: string): ProtectedRoute | null {
    return config.protectedRoutes.find((r) => path.startsWith(r.path)) ?? null;
  }

  isAppProtected(config: AppLockConfig, appId: string): boolean {
    return config.enabled && config.protectedAppIds.includes(appId);
  }
}
