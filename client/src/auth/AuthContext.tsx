import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { api, getAccessToken, PublicUser, refreshSession, setAccessToken } from "../api";

type AuthState = {
  user: PublicUser | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
  expireSession: (message?: string) => void;
  setUser: (user: PublicUser | null) => void;
};

const AuthContext = createContext<AuthState | null>(null);

const ACCESS_KEY = "hub_access_token";

function clearLocalGameAuth() {
  try {
    localStorage.removeItem("pcorridor.token");
    localStorage.removeItem("pcorridor.lastUser");
  } catch {
    /* ignore */
  }
}

/** 取消「关页退出」定时器；刷新 / 其它标签页仍开着时调用 */
function cancelLeaveLogoutRequest() {
  const token = getAccessToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch("/api/auth/logout-on-leave-cancel", {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers,
    body: JSON.stringify(token ? { accessToken: token } : {})
  }).catch(() => undefined);
}

/** 关闭标签页时：sendBeacon 通知服务端延迟撤销会话 */
function requestLeaveLogout() {
  const token = getAccessToken();
  if (!token) return;
  try {
    const body = JSON.stringify({ accessToken: token });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon("/api/auth/logout-on-leave", new Blob([body], { type: "application/json" }));
    } else {
      fetch("/api/auth/logout-on-leave", {
        method: "POST",
        credentials: "include",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body
      }).catch(() => undefined);
    }
  } catch {
    /* ignore */
  }
  setAccessToken(null);
  clearLocalGameAuth();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 刷新进入时先取消关页退出，避免误登出
        await cancelLeaveLogoutRequest();
        // 每次打开都走 cookie 续期：关站后会话已清，续期失败则视为未登录
        // （不再信任本地残留的 access JWT，避免关站再开仍自动进同一账户）
        const ok = await refreshSession();
        if (!ok) {
          setAccessToken(null);
          clearLocalGameAuth();
          return;
        }
        const data = await api<{ user: PublicUser }>("/api/auth/me");
        if (!cancelled) setUser(data.user);
      } catch {
        setAccessToken(null);
        clearLocalGameAuth();
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 关页退出：pagehide 预约撤销；pageshow / 心跳 / 其它标签页取消
  useEffect(() => {
    const onPageHide = () => {
      requestLeaveLogout();
    };

    const onPageShow = () => {
      void (async () => {
        await cancelLeaveLogoutRequest();
        if (getAccessToken() || !user) return;
        // bfcache 恢复：本页内存仍有用户，但 pagehide 已清掉令牌
        const ok = await refreshSession();
        if (!ok) {
          setUser(null);
          return;
        }
        try {
          const data = await api<{ user: PublicUser }>("/api/auth/me");
          setUser(data.user);
        } catch {
          setUser(null);
        }
      })();
    };

    const onStorage = (e: StorageEvent) => {
      // 其它标签页关页清掉了共享的 access token；本页仍开着则取消退出并续上会话
      if (e.key !== ACCESS_KEY || e.newValue !== null || e.oldValue == null) return;
      void (async () => {
        await cancelLeaveLogoutRequest();
        const ok = await refreshSession();
        if (!ok) {
          setUser(null);
          return;
        }
        try {
          const data = await api<{ user: PublicUser }>("/api/auth/me");
          setUser(data.user);
        } catch {
          setUser(null);
        }
      })();
    };

    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("storage", onStorage);

    let beat = 0;
    if (user) {
      beat = window.setInterval(() => {
        void cancelLeaveLogoutRequest();
      }, 2000);
    }

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("storage", onStorage);
      if (beat) clearInterval(beat);
    };
  }, [user]);

  const login = useCallback(async (username: string, password: string) => {
    const data = await api<{ user: PublicUser; accessToken: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      skipAuth: true,
      skipRefresh: true
    });
    setAccessToken(data.accessToken);
    setUser(data.user);
  }, []);

  const register = useCallback(async (username: string, password: string, displayName?: string) => {
    const data = await api<{ user: PublicUser; accessToken: string }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password, displayName }),
      skipAuth: true,
      skipRefresh: true
    });
    setAccessToken(data.accessToken);
    setUser(data.user);
  }, []);

  const logout = useCallback(async () => {
    // 先通知服务端撤销当前账户的全部刷新令牌并清除 cookie
    await api("/api/auth/logout", { method: "POST", skipRefresh: true }).catch(() => undefined);
    setAccessToken(null);
    setUser(null);
    // 顺带清掉投影回廊（迷宫）在本机残留的登录态，避免枢纽已退、游戏里还挂着旧号
    clearLocalGameAuth();
  }, []);

  const expireSession = useCallback((message?: string) => {
    setAccessToken(null);
    setUser(null);
    if (message) sessionStorage.setItem("auth_notice", message);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      ready,
      login,
      register,
      logout,
      expireSession,
      setUser
    }),
    [user, ready, login, register, logout, expireSession]
  );

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
