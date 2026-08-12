const KEY = "trustid.rememberedAccount";

/** Local device hint only — TrustID + optional device label. No email/name PII. */
export type RememberedAccount = {
  trustId: string;
  displayName: string;
  deviceName?: string;
  updatedAt: string;
};

export function getRememberedAccount(): RememberedAccount | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RememberedAccount & {
      email?: string;
      phone?: string;
      firstName?: string;
    };
    const trustId =
      typeof parsed.trustId === "string" && parsed.trustId.trim()
        ? parsed.trustId.trim()
        : undefined;
    if (!trustId) return null;
    return {
      trustId,
      displayName: parsed.displayName || trustId,
      deviceName:
        typeof parsed.deviceName === "string" && parsed.deviceName.trim()
          ? parsed.deviceName.trim()
          : undefined,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveRememberedAccount(partial: {
  trustId: string;
  displayName?: string;
  deviceName?: string;
}) {
  try {
    const prev = getRememberedAccount();
    const next: RememberedAccount = {
      trustId: partial.trustId,
      displayName: partial.displayName || partial.trustId || prev?.displayName || "TrustID",
      deviceName: partial.deviceName ?? prev?.deviceName,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(KEY, JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

export function clearRememberedAccount() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Persist from a signed-in identity payload — trustId only. */
export function rememberFromIdentity(
  identity: {
    trustId: string;
    profile: { firstName: string; lastName: string; name: string } | null;
    contacts: { type: string; value: string }[];
  },
  deviceName?: string,
) {
  return saveRememberedAccount({
    trustId: identity.trustId,
    displayName: identity.trustId,
    deviceName,
  });
}
