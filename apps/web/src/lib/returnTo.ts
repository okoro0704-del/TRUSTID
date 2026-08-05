/** OAuth / cross-app return path after TrustID sign-in. */
const RETURN_TO_KEY = "trustid.returnTo";

export function setReturnTo(path: string) {
  sessionStorage.setItem(RETURN_TO_KEY, path);
}

export function peekReturnTo(): string | null {
  return sessionStorage.getItem(RETURN_TO_KEY);
}

export function consumeReturnTo(): string | null {
  const value = sessionStorage.getItem(RETURN_TO_KEY);
  if (value) sessionStorage.removeItem(RETURN_TO_KEY);
  return value;
}

/** Prefer OAuth return (e.g. LifeOS consent) over TrustID dashboard. */
export function postAuthDestination(fallback = "/dashboard"): string {
  return consumeReturnTo() ?? fallback;
}
