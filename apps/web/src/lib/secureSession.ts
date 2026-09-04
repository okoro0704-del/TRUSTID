const TOKEN_KEY = "trustid.session.token";

/**
 * Persist session token in EncryptedSharedPreferences on native,
 * sessionStorage on web (HttpOnly cookie remains primary auth).
 */
export async function storeSessionTokenSecure(
  token: string | null | undefined,
): Promise<void> {
  if (!token) return;
  try {
    const gate = typeof window !== "undefined" ? window.TrustIdBiometricGate : undefined;
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

export async function readSessionTokenSecure(): Promise<string | null> {
  try {
    const gate = typeof window !== "undefined" ? window.TrustIdBiometricGate : undefined;
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
    const gate = typeof window !== "undefined" ? window.TrustIdBiometricGate : undefined;
    if (gate?.storeSecure) {
      await gate.storeSecure({ key: TOKEN_KEY, value: "" });
    }
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}
