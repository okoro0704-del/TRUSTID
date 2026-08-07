const KEY = "trustid.rememberedAccount";

export type RememberedAccount = {
  firstName: string;
  lastName?: string;
  displayName: string;
  email?: string;
  phone?: string;
  deviceName?: string;
  trustId?: string;
  updatedAt: string;
};

export function getRememberedAccount(): RememberedAccount | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RememberedAccount;
    if (!parsed?.displayName && !parsed?.firstName) return null;
    if (!parsed.email && !parsed.phone) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveRememberedAccount(
  partial: Omit<RememberedAccount, "updatedAt" | "displayName"> & {
    displayName?: string;
  },
) {
  try {
    const prev = getRememberedAccount();
    const firstName = partial.firstName || prev?.firstName || "";
    const lastName = partial.lastName ?? prev?.lastName;
    const displayName =
      partial.displayName ||
      [firstName, lastName].filter(Boolean).join(" ").trim() ||
      prev?.displayName ||
      "Trusted user";
    const next: RememberedAccount = {
      firstName,
      lastName,
      displayName,
      email: partial.email ?? prev?.email,
      phone: partial.phone ?? prev?.phone,
      deviceName: partial.deviceName ?? prev?.deviceName,
      trustId: partial.trustId ?? prev?.trustId,
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

/** Persist from a signed-in identity payload. */
export function rememberFromIdentity(
  identity: {
    trustId: string;
    profile: { firstName: string; lastName: string; name: string } | null;
    contacts: { type: string; value: string }[];
  },
  deviceName?: string,
) {
  const email = identity.contacts.find((c) => c.type === "email")?.value;
  const phone = identity.contacts.find((c) => c.type === "phone")?.value;
  return saveRememberedAccount({
    firstName: identity.profile?.firstName ?? "",
    lastName: identity.profile?.lastName,
    displayName: identity.profile?.name,
    email,
    phone,
    trustId: identity.trustId,
    deviceName,
  });
}
