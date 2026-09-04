/**
 * Native / Capacitor bridges for heads-up approval banners and optional FCM tokens.
 */

type CapPlugin = {
  [method: string]: (opts?: unknown) => Promise<unknown>;
};

type CapacitorLike = {
  isNativePlatform?: () => boolean;
  registerPlugin?: (name: string) => CapPlugin;
  Plugins?: Record<string, CapPlugin>;
};

function getCap(): CapacitorLike | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { Capacitor?: CapacitorLike }).Capacitor;
}

function plugin(name: string): CapPlugin | undefined {
  const cap = getCap();
  if (!cap?.isNativePlatform?.()) return undefined;
  if (cap.Plugins?.[name]) return cap.Plugins[name];
  try {
    return cap.registerPlugin?.(name);
  } catch {
    return undefined;
  }
}

export async function ensureHeadsUpChannels(): Promise<void> {
  const heads = plugin("TrustIdHeadsUp");
  try {
    await heads?.ensureChannels?.();
  } catch {
    /* optional */
  }
}

/** Show OS heads-up banner for a Master Device approval request. */
export async function showApprovalHeadsUp(input: {
  title?: string;
  body: string;
  requestId: string;
}): Promise<boolean> {
  const heads = plugin("TrustIdHeadsUp");
  if (heads?.showApproval) {
    try {
      await heads.showApproval({
        title: input.title ?? "Login Approval Requested",
        body: input.body,
        requestId: input.requestId,
      });
      return true;
    } catch {
      /* fall through to web Notification */
    }
  }

  if (typeof Notification !== "undefined") {
    try {
      if (Notification.permission === "granted") {
        new Notification(input.title ?? "Login Approval Requested", {
          body: input.body,
          tag: input.requestId,
          requireInteraction: true,
        });
        return true;
      }
      if (Notification.permission === "default") {
        await Notification.requestPermission();
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Best-effort FCM / push token. Returns null until google-services.json + Push
 * Notifications plugin are configured on the APK.
 */
export async function getNativePushToken(): Promise<string | null> {
  const push = plugin("PushNotifications");
  if (!push) return null;
  try {
    await push.requestPermissions?.();
    await push.register?.();
    // Capacitor PushNotifications delivers token via 'registration' listener —
    // without a long-lived listener we can't await it here. Callers should
    // register via window hook when available.
    const cached = (window as Window & { __trustidFcmToken?: string })
      .__trustidFcmToken;
    return cached ?? null;
  } catch {
    return null;
  }
}

declare global {
  interface Window {
    __trustidFcmToken?: string;
    TrustIdHeadsUp?: {
      ensureChannels: () => Promise<{ ok: boolean }>;
      showApproval: (options: {
        title?: string;
        body: string;
        requestId: string;
      }) => Promise<{ ok: boolean }>;
    };
  }
}
