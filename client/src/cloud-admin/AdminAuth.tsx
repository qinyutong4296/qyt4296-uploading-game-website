import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { cloud } from "./cloud";
import { fetchIsAdmin, touchMember } from "./api";
import type { CloudUser } from "./types";

type AdminAuthState = {
  ready: boolean;
  user: CloudUser | null;
  isAdmin: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AdminAuthState>({
  ready: false,
  user: null,
  isAdmin: false,
  refresh: async () => {},
  signOut: async () => {},
});

export function useAdminAuth() {
  return useContext(Ctx);
}

export function AdminAuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<CloudUser | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { data: session } = await cloud.auth.getSession();
      if (!session) {
        setUser(null);
        setIsAdmin(false);
        return;
      }
      const u = session.user as unknown as CloudUser;
      setUser({ id: u.id, email: u.email, phone: u.phone });
      const admin = await fetchIsAdmin();
      setIsAdmin(admin);
      if (admin) await touchMember(u.email?.split("@")[0]);
    } catch {
      setUser(null);
      setIsAdmin(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      await refresh();
      if (mounted) setReady(true);
    })();
    const unsub = cloud.auth.onAuthStateChange(() => {
      void refresh();
    });
    return () => {
      mounted = false;
      if (typeof unsub === "function") unsub();
      else if (unsub && typeof (unsub as { unsubscribe?: unknown }).unsubscribe === "function") {
        (unsub as { unsubscribe: () => void }).unsubscribe();
      }
    };
  }, [refresh]);

  const signOut = useCallback(async () => {
    await cloud.auth.signOut();
    setUser(null);
    setIsAdmin(false);
  }, []);

  return <Ctx.Provider value={{ ready, user, isAdmin, refresh, signOut }}>{children}</Ctx.Provider>;
}
