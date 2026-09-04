const TOKEN_KEY = "trustid.session.token";
const TRUST_ID_KEY = "TRUST_ID_KEY";
const IS_MASTER_KEY = "IS_MASTER_DEVICE";
const DEVICE_ID_KEY = "DEVICE_ID_KEY";

type SecureGate = {
  storeSecure?: (options: {
    key: string;
    value: string;
  }) => Promise<{ ok: boolean }>;
  getSecure?: (options: { key: string }) => Promise<{ value: string | null }>;
};

function gate(): SecureGate | undefined {
  if (typeof window === "undefined") return undefined;
  return window.TrustIdBiometricGate;
}

async function writeSecure(key: string, value: string) {
  try {
    const g = gate();
    if (g?.storeSecure) {
      await g.storeSecure({ key, value });
    }
  } catch {
    /* fall through */
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

async function readSecure(key: string): Promise<string | null> {
  try {
    const g = gate();
    if (g?.getSecure) {
      const row = await g.getSecure({ key });
      if (row?.value) return row.value;
    }
  } catch {
    /* fall through */
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Persist session token in EncryptedSharedPreferences on native,
 * sessionStorage on web (HttpOnly cookie remains primary auth).
 */
export async function storeSessionTokenSecure(
  token: string | null | undefined,
): Promise<void> {
  if (!token) return;
  try {
    const g = gate();
    if (g?.storeSecure) {
      await g.storeSecure({ key: TOKEN_KEY, value: token });
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}

/** Persist Trust ID + master/device flags for 1:1 fast-path + push binding. */
export async function storeMasterDeviceLocalState(input: {
  trustId: string;
  isMasterDevice?: boolean;
  deviceId?: string | null;
}): Promise<void> {
  await writeSecure(TRUST_ID_KEY, input.trustId);
  await writeSecure(
    IS_MASTER_KEY,
    input.isMasterDevice === false ? "false" : "true",
  );
  if (input.deviceId) {
    await writeSecure(DEVICE_ID_KEY, input.deviceId);
  }
}

export async function storeCachedTrustIdSecure(
  trustId: string | null | undefined,
): Promise<void> {
  if (!trustId) return;
  await storeMasterDeviceLocalState({ trustId, isMasterDevice: true });
}

export async function readCachedTrustIdSecure(): Promise<string | null> {
  return readSecure(TRUST_ID_KEY);
}

export async function readIsMasterDeviceSecure(): Promise<boolean> {
  const v = await readSecure(IS_MASTER_KEY);
  return v === "true" || v === "1";
}

export async function readDeviceIdSecure(): Promise<string | null> {
  return readSecure(DEVICE_ID_KEY);
}

/** Sync read for boot path. */
export function peekCachedTrustId(): string | null {
  try {
    return localStorage.getItem(TRUST_ID_KEY);
  } catch {
    return null;
  }
}

export async function readSessionTokenSecure(): Promise<string | null> {
  try {
    const g = gate();
    if (g?.getSecure) {
      const row = await g.getSecure({ key: TOKEN_KEY });
      if (row?.value) return row.value;
    }
  } catch {
    /* fall through */
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function clearSessionTokenSecure(): Promise<void> {
  try {
    const g = gate();
    if (g?.storeSecure) {
      await g.storeSecure({ key: TOKEN_KEY, value: "" });
      await g.storeSecure({ key: TRUST_ID_KEY, value: "" });
      await g.storeSecure({ key: IS_MASTER_KEY, value: "" });
      await g.storeSecure({ key: DEVICE_ID_KEY, value: "" });
    }
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TRUST_ID_KEY);
    localStorage.removeItem(IS_MASTER_KEY);
    localStorage.removeItem(DEVICE_ID_KEY);
  } catch {
    /* ignore */
  }
}
