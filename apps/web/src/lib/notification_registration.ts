/**
 * Registers the physical device FCM/APNs token with ElfCom Universal Push Primitive.
 * Capacitor / web  not React Native Firebase (TrustID ships as Capacitor APK).
 */
import { createTrustIdSdk } from "@trustid/sdk";

const APP_ID = "trust_id_app";

type CapPlugin = {
  [method: string]: (...args: unknown[]) => Promise<unknown>;
};

type CapacitorLike = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  registerPlugin?: (name: string) => CapPlugin;
  Plugins?: Record<string, CapPlugin>;
};

function getCap(): CapacitorLike | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { Capacitor?: CapacitorLike }).Capacitor;
}

function plugin(name: string): CapPlugin | undefined {
  const cap = getCap();
  if (!cap) return undefined;
  if (cap.Plugins?.[name]) return cap.Plugins[name];
  try {
    return cap.registerPlugin?.(name);
  } catch {
    return undefined;
  }
}

function platformForApi(): "ANDROID" | "IOS" | "WEB" {
  const p = getCap()?.getPlatform?.() ?? "web";
  if (p === "ios") return "IOS";
  if (p === "android") return "ANDROID";
  return "WEB";
}

function elfcomBaseFallback(): string {
  return (
    (import.meta.env.VITE_ELFCOM_BASE_URL as string | undefined)?.replace(
      /\/+$/,
      "",
    ) || "https://elfcomnode-production.up.railway.app"
  );
}

async function resolveDeviceId(trustId: string): Promise<string> {
  const device = plugin("Device");
  try {
    const id = (await device?.getId?.()) as { identifier?: string } | undefined;
    if (id?.identifier) return id.identifier;
  } catch {
    /* fall through */
  }
  const cached = (window as Window & { __trustidInstallId?: string })
    .__trustidInstallId;
  return cached || `web-${trustId.slice(0, 12)}`;
}

/**
 * Await FCM/APNs token from Capacitor PushNotifications (native only).
 */
export async function obtainNativePushToken(
  timeoutMs = 12_000,
): Promise<string | null> {
  const cached = (window as Window & { __trustidFcmToken?: string })
    .__trustidFcmToken;
  if (cached) return cached;

  const cap = getCap();
  if (!cap?.isNativePlatform?.()) return null;

  const push = plugin("PushNotifications");
  if (!push) return null;

  try {
    const perm = (await push.requestPermissions?.()) as
      | { receive?: string }
      | undefined;
    if (perm && perm.receive && perm.receive !== "granted") {
      console.warn("[Notification] Push notification permissions denied.");
      return null;
    }

    return await new Promise<string | null>((resolve) => {
      let settled = false;
      const done = (token: string | null) => {
        if (settled) return;
        settled = true;
        if (token) {
          (window as Window & { __trustidFcmToken?: string }).__trustidFcmToken =
            token;
        }
        resolve(token);
      };

      const timer = window.setTimeout(() => done(null), timeoutMs);

      void push
        .addListener?.("registration", (ev: unknown) => {
          const value =
            typeof ev === "object" &&
            ev &&
            "value" in ev &&
            typeof (ev as { value: unknown }).value === "string"
              ? (ev as { value: string }).value
              : null;
          window.clearTimeout(timer);
          done(value);
        })
        .catch?.(() => {
          /* listener may already exist */
        });

      void push.register?.().catch(() => {
        window.clearTimeout(timer);
        done(null);
      });
    });
  } catch (error) {
    console.error("[Notification] Error obtaining push token:", error);
    return null;
  }
}

/**
 * Registers device token with ElfCom (direct) and mirrors via TrustID API.
 */
export async function registerDeviceWithElfCom(
  trustId: string,
  apiBaseUrl: string,
): Promise<boolean> {
  try {
    const pushToken = await obtainNativePushToken();
    if (!pushToken) {
      console.warn("[Notification] No push token available yet.");
      return false;
    }

    const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
    const platform = platformForApi();
    const deviceId = await resolveDeviceId(trustId);

    // 1) TrustID session ? server mints capability JWT ? ElfCom /v1/devices/register
    try {
      await sdk.registerPushToken({
        token: pushToken,
        platform: platform === "IOS" ? "ios" : platform === "WEB" ? "web" : "android",
        deviceId,
        channelId: "trust_id_security_alerts",
      });
    } catch (err) {
      console.warn("[Notification] TrustID push-token mirror failed:", err);
    }

    // 2) Optional direct ElfCom register (matches Universal Push Primitive contract)
    const capRes = await fetch(`${apiBaseUrl}/v1/elfcom/capability-token`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
    });
    if (!capRes.ok) {
      console.warn(
        "[Notification] ElfCom capability token failed:",
        capRes.status,
      );
      return true; // server-side register may still have succeeded
    }

    const cap = (await capRes.json()) as {
      token?: string;
      elfcomBaseUrl?: string;
      appId?: string;
    };
    if (!cap.token) return true;

    const base = (cap.elfcomBaseUrl || elfcomBaseFallback()).replace(/\/+$/, "");
    const response = await fetch(`${base}/v1/devices/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cap.token}`,
      },
      body: JSON.stringify({
        trustId,
        appId: cap.appId || APP_ID,
        platform,
        pushToken,
        deviceId,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `ElfCom registration failed (${response.status}): ${errText}`,
      );
    }

    console.log(
      "[Notification] Device successfully registered with ElfCom Primitive.",
    );
    return true;
  } catch (error) {
    console.error(
      "[Notification] Error registering token with ElfCom:",
      error,
    );
    return false;
  }
}

/** Start listening for token refresh after login (native). */
export async function initElfComPushRegistration(
  trustId: string,
  apiBaseUrl: string,
): Promise<void> {
  void registerDeviceWithElfCom(trustId, apiBaseUrl);

  const push = plugin("PushNotifications");
  if (!push || !getCap()?.isNativePlatform?.()) return;

  try {
    await push.addListener?.("registration", (ev: unknown) => {
      const value =
        typeof ev === "object" &&
        ev &&
        "value" in ev &&
        typeof (ev as { value: unknown }).value === "string"
          ? (ev as { value: string }).value
          : null;
      if (value) {
        (window as Window & { __trustidFcmToken?: string }).__trustidFcmToken =
          value;
        void registerDeviceWithElfCom(trustId, apiBaseUrl);
      }
    });
  } catch {
    /* optional */
  }
}
