import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  api,
  getAccessToken,
  setAccessToken,
  readUserGameRuntime,
  rememberUserGameRuntime,
  isExternalGameUrl,
  type ApiError,
  type PublicUser
} from "../api";
import { getGame } from "../games/registry";
import styles from "../styles/modules/group-3.module.css";

type RemoteGame = {
  id: string;
  name: string;
  source: "builtin" | "user";
  entryFile?: string;
  playUrl?: string;
  needsBackend?: boolean;
};

const HEARTBEAT_MS = 10_000;

function usePlayPresence(gameId: string, enabled: boolean) {
  const navigate = useNavigate();
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !gameId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function leave() {
      const sid = sessionRef.current;
      if (!sid) return;
      sessionRef.current = null;
      try {
        await api(`/api/games/presence/${sid}`, { method: "DELETE" });
      } catch {
        /* ignore */
      }
    }

    (async () => {
      try {
        const data = await api<{ sessionId: string }>(`/api/games/${gameId}/presence`, { method: "POST" });
        if (cancelled) {
          sessionRef.current = data.sessionId;
          await leave();
          return;
        }
        sessionRef.current = data.sessionId;
        timer = setInterval(() => {
          const sid = sessionRef.current;
          if (!sid) return;
          void api(`/api/games/presence/${sid}/heartbeat`, { method: "POST" }).catch((e: ApiError) => {
            if (e.status === 403) {
              if (timer) clearInterval(timer);
              sessionRef.current = null;
              window.alert("本局已被管理员结束");
              navigate("/lobby");
            }
          });
        }, HEARTBEAT_MS);
      } catch {
        /* presence is best-effort */
      }
    })();

    const onUnload = () => {
      const sid = sessionRef.current;
      if (!sid) return;
      const token = getAccessToken();
      void fetch(`/api/games/presence/${sid}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
        keepalive: true
      });
      sessionRef.current = null;
    };
    window.addEventListener("beforeunload", onUnload);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("beforeunload", onUnload);
      void leave();
    };
  }, [enabled, gameId, navigate]);
}

export function GameRuntimePage() {
  const { gameId = "" } = useParams();
  const location = useLocation();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [remote, setRemote] = useState<RemoteGame | null>(null);
  const [runtimeUrl, setRuntimeUrl] = useState<string | null>(() => readUserGameRuntime(gameId));
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const builtin = getGame(gameId);
  const isUserGame = gameId.startsWith("ug_");

  const ticket = useMemo(() => {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    return hash.get("ticket") || hash.get("t");
  }, [location.hash]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (isUserGame) {
          const data = await api<{ game: RemoteGame }>(`/api/games/${gameId}`);
          if (!cancelled) setRemote(data.game);
          // 刷新后 sessionStorage 可能丢失：再 ensure 一次，避免退回静态 /ug 导致游戏内登录失效
          setRuntimeBusy(true);
          try {
            const rt = await api<{ playUrl: string; openExternal?: boolean }>(
              `/api/workshop/${gameId}/ensure-runtime`,
              // 需要登录态：服务端会拉起进程/执行 npm install
              { method: "POST" }
            );
            if (!cancelled && rt.playUrl) {
              rememberUserGameRuntime(gameId, rt.playUrl);
              setRuntimeUrl(rt.playUrl);
            }
          } catch (re) {
            if (!cancelled) {
              const stored = readUserGameRuntime(gameId);
              if (stored) {
                setRuntimeUrl(stored);
              } else if (data.game.needsBackend) {
                throw re instanceof Error ? re : new Error("游戏服务启动失败");
              }
            }
          } finally {
            if (!cancelled) setRuntimeBusy(false);
          }
        }
        if (ticket) {
          try {
            const exchanged = await api<{ user: PublicUser; accessToken: string; gameId: string }>(
              "/api/auth/exchange-ticket",
              {
                method: "POST",
                body: JSON.stringify({ ticket }),
                skipAuth: true,
                skipRefresh: true
              }
            );
            if (exchanged.gameId !== gameId) throw new Error("票据与游戏不匹配");
            setAccessToken(exchanged.accessToken);
          } catch {
            if (!getAccessToken()) throw new Error("游戏会话无效或已过期");
          }
        }
        const me = await api<{ user: PublicUser }>("/api/auth/me");
        await api("/api/auth/verify");
        if (!cancelled) {
          setUser(me.user);
          setReady(true);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "未授权");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId, isUserGame, ticket]);

  usePlayPresence(gameId, ready && Boolean(user) && Boolean(builtin || isUserGame));

  if (!builtin && !isUserGame) return <Unauthorized message="未知游戏" />;
  if (error) return <Unauthorized message={error} />;
  if (!ready || !user || (isUserGame && runtimeBusy && !runtimeUrl)) {
    return (
      <p className={`muted ${styles.loading}`}>
        {isUserGame && runtimeBusy ? "正在启动游戏服务（首次安装依赖可能需要几分钟）…" : "正在校验本站登录身份…"}
      </p>
    );
  }

  if (isUserGame) {
    const entrySrc =
      runtimeUrl ||
      readUserGameRuntime(gameId) ||
      remote?.playUrl ||
      `/ug/${gameId}/${remote?.entryFile || "index.html"}`;
    if (remote?.needsBackend && !runtimeUrl && !readUserGameRuntime(gameId)) {
      return (
        <Unauthorized message="游戏后端尚未就绪，请返回大厅重新打开（首次需安装依赖，可能要等一两分钟）" />
      );
    }
    if (isExternalGameUrl(entrySrc)) {
      return <ExternalGameBridge user={user} title={remote?.name || "工坊游戏"} entrySrc={entrySrc} />;
    }
    return (
      <UploadedFrame
        gameId={gameId}
        user={user}
        title={remote?.name || "工坊游戏"}
        entrySrc={entrySrc}
      />
    );
  }

  const Game = builtin!.component;
  const immersive = builtin!.id === "maze";
  return (
    <div className={immersive ? styles.runtimePadImmersive : styles.runtimePad}>
      <Game gameId={builtin!.id} />
    </div>
  );
}

/** 独立后端游戏：禁止 iframe，须顶层新窗口；本页维持合集站心跳 */
function ExternalGameBridge({
  user,
  title,
  entrySrc
}: {
  user: PublicUser;
  title: string;
  entrySrc: string;
}) {
  const [opened, setOpened] = useState(false);
  // StrictMode 下 effect 会双跑：不加守卫会连开两个相同的游戏窗口
  const autoTriedRef = useRef(false);

  function openGame() {
    const win = window.open(entrySrc, "_blank", "noopener,noreferrer");
    setOpened(Boolean(win));
  }

  useEffect(() => {
    // 若 openUserUploadedGame 的弹窗被拦，这里再试一次（仅一次）
    if (autoTriedRef.current) return;
    autoTriedRef.current = true;
    const t = window.setTimeout(() => {
      const win = window.open(entrySrc, "_blank", "noopener,noreferrer");
      setOpened(Boolean(win));
    }, 80);
    return () => clearTimeout(t);
  }, [entrySrc]);

  return (
    <div className={styles.authBox}>
      <h2>{title}</h2>
      <p className={styles.frameMeta}>
        <strong>玩家：{user.displayName}</strong>
        <span className="muted"> · 该游戏自带后端与登录，需在独立窗口运行</span>
      </p>
      <p className="muted">
        {opened
          ? "已尝试在新标签打开。若浏览器拦截了弹窗，请点击下方按钮。"
          : "请点击下方按钮进入游戏（登录 / 一键体验请在游戏窗口内操作）。"}
      </p>
      <p className="muted" style={{ wordBreak: "break-all" }}>
        地址：{entrySrc}
      </p>
      <p style={{ marginTop: 20 }}>
        <button type="button" className={styles.openBtn} onClick={openGame}>
          打开游戏窗口
        </button>
        {" · "}
        <Link to="/lobby">返回大厅</Link>
      </p>
      <p className="muted" style={{ marginTop: 16 }}>
        请保持本页打开，关闭全部合集站标签会导致后台服务一并停止。
      </p>
    </div>
  );
}

function UploadedFrame({
  gameId,
  user,
  title,
  entrySrc
}: {
  gameId: string;
  user: PublicUser;
  title: string;
  entrySrc: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);

  function hello(win: Window | null) {
    if (!win) return;
    void api<{ save: unknown }>(`/api/saves/${gameId}`)
      .then((s) => {
        win.postMessage({ type: "hub:hello", user, save: s.save, gameId }, window.location.origin);
      })
      .catch(() => {
        win.postMessage({ type: "hub:hello", user, save: null, gameId }, window.location.origin);
      });
  }

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // 只接受自家 iframe 的消息：不校验来源的话，任何页面都能伪造分数/覆盖存档
      if (e.source !== ref.current?.contentWindow) return;
      if (e.origin !== window.location.origin) return;
      const data = e.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "hub:need-hello") hello(ref.current?.contentWindow || null);
      if (data.type === "hub:score") {
        const score = Number(data.score);
        if (!Number.isFinite(score) || score < 0) return;
        void api(`/api/scores/${gameId}`, { method: "POST", body: JSON.stringify({ score }) });
      }
      if (data.type === "hub:save") {
        void api(`/api/saves/${gameId}`, { method: "PUT", body: JSON.stringify({ data: data.data }) });
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [gameId, user]);

  return (
    <div className={styles.frameWrap}>
      <p className={styles.frameMeta}>
        <strong>玩家：{user.displayName}</strong>
        <span className="muted"> · {title} · 工坊游戏已绑定本站账号</span>
      </p>
      <iframe
        ref={ref}
        title={title}
        src={entrySrc}
        sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-popups allow-modals"
        allow="autoplay; fullscreen"
        onLoad={() => hello(ref.current?.contentWindow || null)}
        className={styles.frame}
      />
    </div>
  );
}

function Unauthorized({ message }: { message: string }) {
  return (
    <div className={styles.authBox}>
      <h2>未授权</h2>
      <p className="banner">{message}。不能以游客模式继续玩。</p>
      <a href="/login" target="_top">返回登录</a>
      <span> · </span>
      <Link to="/lobby" target="_top">返回大厅</Link>
    </div>
  );
}
