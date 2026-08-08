import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

type PortraitView = {
  id: string;
  status: string;
  isVerifiedIdentityPortrait: boolean;
  mediaAccess?: { path: string; token: string; expiresAt: string };
};

type TrustLevel = {
  tier: number;
  stars: number;
  maxStars: number;
  label: string;
};

function mediaUrl(access: { path: string; token: string }) {
  return `${import.meta.env.VITE_API_URL ?? "/api"}${access.path}?token=${encodeURIComponent(access.token)}`;
}

/** Verified portrait URL + trust stars for chrome that Life OS mirrors. */
export function useTopbarIdentity() {
  const [portraitUrl, setPortraitUrl] = useState<string | null>(null);
  const [trust, setTrust] = useState<TrustLevel | null>(null);

  const load = useCallback(async () => {
    const [level, portrait] = await Promise.all([
      api<TrustLevel>("/trust/level").catch(() => null),
      api<PortraitView>("/identity/portrait").catch(() => null),
    ]);

    if (level) {
      setTrust({
        tier: level.tier,
        stars: level.stars ?? level.tier,
        maxStars: level.maxStars ?? 3,
        label: level.label,
      });
    }

    if (portrait?.isVerifiedIdentityPortrait && portrait.mediaAccess) {
      setPortraitUrl(mediaUrl(portrait.mediaAccess));
      return portrait.mediaAccess.expiresAt;
    }
    setPortraitUrl(null);
    return null as string | null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refresh() {
      try {
        const expiresAt = await load();
        if (cancelled) return;
        // Refresh media token ~20s before expiry (tokens last ~120s)
        const ms = expiresAt
          ? Math.max(15_000, new Date(expiresAt).getTime() - Date.now() - 20_000)
          : 90_000;
        timer = setTimeout(() => {
          void refresh();
        }, ms);
      } catch {
        if (!cancelled) {
          timer = setTimeout(() => {
            void refresh();
          }, 60_000);
        }
      }
    }

    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  return { portraitUrl, trust };
}
