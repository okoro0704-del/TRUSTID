const TOKEN_KEY = "trustid.session.token";
const TRUST_ID_KEY = "TRUST_ID_KEY";

/**
 * Persist session token in EncryptedSharedPreferences on native,
 * sessionStorage on web (HttpOnly cookie remains primary auth).
 */
export async function storeSessionTokenSecure(
  token: string | null | undefined,
): Promise<void> {
  if (!token) return;
  try {
    const gate =
      typeof window !== "undefined" ? window.TrustIdBiometricGate : undefined;
    if (gate?.storeSecure) {
      await gate.storeSecure({ key: TOKEN_KEY, value: token });
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

/** Persist Trust ID for Path A 1:1 verification on next launch. */
export async function storeCachedTrustIdSecure(
  trustId: string | null | undefined,
): Promise<void> {
  if (!trustId) return;
  try {
    const gate =
      typeof window !== "undefined" ? window.TrustIdBiometricGate : undefined;
    if (gate?.storeSecure) {
      await gate.storeSecure({ key: TRUST_ID_KEY, value: trustId });
    }
  } catch {
    /* fall through */
  }
  try {
    localStorage.setItem(TRUST_ID_KEY, trustId);
  } catch {
    /* ignore */
  }
}

export async function readCachedTrustIdSecure(): Promise<string | null> {
  try {
    const gate =
      typeof window !== "undefined" ? window.TrustIdBiometricGate : undefined;
    if (gate?.getSecure) {
      const row = await gate.getSecure({ key: TRUST_ID_KEY });
      if (row?.value) return row.value;
    }
  } catch {
    /* fall through */
  }
  try {
    return localStorage.getItem(TRUST_ID_KEY);
  } catch {
    return null;
  }
}

/** Sync read for boot path (localStorage / remembered). */
export function peekCachedTrustId(): string | null {
  try {
    return localStorage.getItem(TRUST_ID_KEY);
  } catch {
    return null;
  }
}

export async function readSessionTokenSecure(): Promise<string | null> {
  try {
    const gate =
      typeof window !== "undefined" ? window.TrustIdBiometricGate : undefined;
    if (gate?.getSecure) {
      const row = await gate.getSecure({ key: TOKEN_KEY });
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
    const gate =
      typeof window !== "undefined" ? window.TrustIdBiometricGate : undefined;
    if (gate?.storeSecure) {
      await gate.storeSecure({ key: TOKEN_KEY, value: "" });
      await gate.storeSecure({ key: TRUST_ID_KEY, value: "" });
    }
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TRUST_ID_KEY);
  } catch {
    /* ignore */
  }
}
