import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api, setSessionToken } from "./api";

export type Identity = {
  trustId: string;
  status: string;
  profile: { firstName: string; lastName: string; name: string } | null;
  contacts: { type: string; value: string; verified: boolean }[];
  identityVerification?: {
    status: string;
    provider: string | null;
    method: string | null;
    verifiedAt: string | null;
  };
};

type AuthState = {
  loading: boolean;
  identity: Identity | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  setIdentity: (identity: Identity | null) => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [identity, setIdentity] = useState<Identity | null>(null);

  const refresh = async () => {
    try {
      const data = await api<{ identity: Identity }>("/auth/session", {
        method: "POST",
      });
      setIdentity(data.identity);
    } catch {
      setIdentity(null);
    }
  };

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  const logout = async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      setSessionToken(null);
      setIdentity(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{ loading, identity, refresh, logout, setIdentity }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth requires AuthProvider");
  return ctx;
}
