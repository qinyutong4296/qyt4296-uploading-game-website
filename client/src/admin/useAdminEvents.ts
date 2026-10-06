import { useCallback, useEffect, useRef, useState } from "react";
import { getAccessToken, refreshSession } from "../api";

export type AdminStats = {
  users: number;
  builtinGames: number;
  userGames: number;
  totalGames: number;
  hidden: number;
  online: number;
  scoresToday: number;
  recentScores: {
    gameId: string;
    score: number;
    at: string;
    username: string;
    displayName: string;
  }[];
  recentUploads: {
    gameId: string;
    name: string;
    at: string;
    username: string;
    displayName: string;
  }[];
};

export type AdminGame = {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "user";
  author?: string;
  authorId?: number;
  cover?: string;
  hidden: boolean;
  createdAt: string | null;
};

export type AdminSession = {
  sessionId: string;
  userId: number;
  username: string;
  displayName: string;
  gameId: string;
  gameName: string;
  startedAt: string;
  lastSeen: string;
};

export type AdminFeedItem = {
  id: string;
  type: string;
  at: string;
  text: string;
};

type Snapshot = {
  stats: AdminStats;
  sessions: AdminSession[];
  games: AdminGame[];
};

export function useAdminEvents() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [games, setGames] = useState<AdminGame[]>([]);
  const [feed, setFeed] = useState<AdminFeedItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const idRef = useRef(0);

  const pushFeed = useCallback((type: string, at: string, text: string) => {
    idRef.current += 1;
    setFeed((prev) => [{ id: String(idRef.current), type, at, text }, ...prev].slice(0, 40));
  }, []);

  useEffect(() => {
    let closed = false;
    let es: EventSource | null = null;
    let sawOpen = false;

    const bootstrap = () => {
      const token = getAccessToken();
      if (!token) {
        setError("未登录");
        return;
      }
      // REST bootstrap so the page is usable even if SSE is down
      void fetch("/api/admin/stats", {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include"
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(r)))
        .then((j) => {
          if (j.stats) setStats(j.stats);
        })
        .catch(() => undefined);
      void fetch("/api/admin/games", {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include"
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(r)))
        .then((j) => {
          if (j.games) setGames(j.games);
        })
        .catch(() => undefined);
      void fetch("/api/admin/sessions", {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include"
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(r)))
        .then((j) => {
          if (j.sessions) setSessions(j.sessions);
        })
        .catch(() => undefined);
    };

    const attachListeners = (source: EventSource) => {
      const onAny = (type: string, raw: MessageEvent) => {
        try {
          const evt = JSON.parse(raw.data) as { type: string; at: string; data: unknown };
          const at = evt.at || new Date().toISOString();
          const data = evt.data as Record<string, unknown>;

          if (type === "snapshot") {
            const snap = data as unknown as Snapshot;
            setStats(snap.stats);
            setSessions(snap.sessions || []);
            setGames(snap.games || []);
            setConnected(true);
            setError("");
            return;
          }
          if (type === "session.upsert") {
            const session = data.session as AdminSession;
            setSessions((prev) => {
              const rest = prev.filter((s) => s.sessionId !== session.sessionId && s.userId !== session.userId);
              return [session, ...rest];
            });
            pushFeed(type, at, `${session.displayName} 正在玩「${session.gameName}」`);
            return;
          }
          if (type === "session.leave" || type === "session.kick") {
            const sessionId = String(data.sessionId || "");
            const session = data.session as AdminSession | undefined;
            setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
            if (type === "session.kick" && session) {
              pushFeed(type, at, `已踢出 ${session.displayName}（${session.gameName}）`);
            } else if (session) {
              pushFeed(type, at, `${session.displayName} 结束了「${session.gameName}」`);
            }
            return;
          }
          if (type === "score.submitted") {
            const displayName = String(data.displayName || data.username || "玩家");
            const gameId = String(data.gameId || "");
            const score = Number(data.score) || 0;
            pushFeed(type, at, `${displayName} 在 ${gameId} 提交分数 ${score}`);
            setStats((s) =>
              s
                ? {
                    ...s,
                    scoresToday: s.scoresToday + 1,
                    recentScores: [
                      {
                        gameId,
                        score,
                        at,
                        username: String(data.username || ""),
                        displayName
                      },
                      ...s.recentScores
                    ].slice(0, 12)
                  }
                : s
            );
            return;
          }
          if (type === "game.changed") {
            const action = String(data.action || "update");
            pushFeed(type, at, `游戏变更：${action} ${String(data.gameId || data.name || "")}`);
            const token = getAccessToken();
            if (!token) return;
            void fetch("/api/admin/games", {
              headers: { Authorization: `Bearer ${token}` },
              credentials: "include"
            })
              .then((r) => r.json())
              .then((j) => {
                if (j.games) setGames(j.games);
              })
              .catch(() => undefined);
            void fetch("/api/admin/stats", {
              headers: { Authorization: `Bearer ${token}` },
              credentials: "include"
            })
              .then((r) => r.json())
              .then((j) => {
                if (j.stats) setStats(j.stats);
              })
              .catch(() => undefined);
          }
        } catch {
          /* ignore malformed */
        }
      };

      const types = [
        "snapshot",
        "session.upsert",
        "session.leave",
        "session.kick",
        "score.submitted",
        "game.changed",
        "stats"
      ];
      for (const t of types) {
        source.addEventListener(t, ((e: MessageEvent) => onAny(t, e)) as EventListener);
      }

      source.onopen = () => {
        if (!closed) {
          sawOpen = true;
          setConnected(true);
          setError("");
        }
      };
      source.onerror = () => {
        if (closed) return;
        setConnected(false);
        if (source.readyState === EventSource.CLOSED) {
          // 连接被服务端关闭（常见于 access_token 过期）：刷新令牌后用新 token 重建。
          // 只在 URL 里固化一次 token 的旧写法，15 分钟后重连永远 401，实时通道永久失联。
          setError("实时连接中断，正在重试…");
          window.setTimeout(async () => {
            if (closed) return;
            try {
              await refreshSession();
            } catch {
              /* 网络失败也继续用现有 token 重试 */
            }
            if (!closed) connect();
          }, 1000);
        } else if (sawOpen) {
          setError("实时连接中断，正在重试…");
        } else {
          setError("实时通道连接中…若长时间无数据，请确认网站服务已用最新代码重启");
        }
      };
    };

    const connect = () => {
      if (closed) return;
      const token = getAccessToken();
      if (!token) {
        setError("未登录");
        return;
      }
      es?.close();
      const url = `/api/admin/events?access_token=${encodeURIComponent(token)}`;
      es = new EventSource(url);
      attachListeners(es);
    };

    bootstrap();
    connect();

    return () => {
      closed = true;
      es?.close();
    };
  }, [pushFeed]);

  // Keep online count in sync with sessions length
  useEffect(() => {
    setStats((s) => (s ? { ...s, online: sessions.length } : s));
  }, [sessions.length]);

  return { stats, sessions, games, setGames, feed, connected, error };
}
