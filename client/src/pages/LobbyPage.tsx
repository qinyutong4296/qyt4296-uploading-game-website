import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, GameListItem, openUserUploadedGame, toggleFavorite } from "../api";
import { useAuth } from "../auth/AuthContext";
import { GAMES } from "../games/registry";
import styles from "../styles/modules/group-4.module.css";

type Tab = "all" | "builtin" | "user";

export default function LobbyPage({ mode = "lobby" }: { mode?: "lobby" | "workshop" }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const q = (params.get("q") || "").trim().toLowerCase();
  const [games, setGames] = useState<GameListItem[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>(mode === "workshop" ? "user" : "all");
  const [favBusy, setFavBusy] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    api<{ games: GameListItem[] }>("/api/games")
      .then((d) => setGames(d.games))
      .catch((e) => setError(e.message))
      .finally(() => setLoaded(true));
  }, []);

  const covers = useMemo(() => Object.fromEntries(GAMES.map((g) => [g.id, g.cover])), []);

  const filtered = games.filter((g) => {
    if (tab === "builtin" && g.source === "user") return false;
    if (tab === "user" && g.source !== "user") return false;
    if (!q) return true;
    return `${g.name} ${g.description} ${g.author || ""} ${g.entryFile || ""}`.toLowerCase().includes(q);
  });

  async function openGame(game: GameListItem) {
    // 玩家上传：有 start.bat / 独立后端时先自动拉起，再打开游戏页
    if (game.source === "user") {
      try {
        setError("");
        setOpeningId(game.id);
        await openUserUploadedGame(
          {
            id: game.id,
            playUrl: game.playUrl,
            entryFile: game.entryFile,
            needsBackend: game.needsBackend
          },
          navigate
        );
        setOpeningId(null);
      } catch (e) {
        setError((e as { message?: string }).message || "无法启动该游戏");
        setOpeningId(null);
      }
      return;
    }
    if (!user) {
      navigate("/login", { state: { from: `/play/${game.id}` } });
      return;
    }
    try {
      const data = await api<{ playTicket: string }>(`/api/games/${game.id}/session`, { method: "POST" });
      navigate(`/play/${game.id}#ticket=${data.playTicket}`);
    } catch (e) {
      const err = e as { status?: number; message: string };
      if (err.status === 401) {
        navigate("/login");
        return;
      }
      setError(err.message);
    }
  }

  async function onFavorite(e: React.MouseEvent, game: GameListItem) {
    e.stopPropagation();
    e.preventDefault();
    if (!user) {
      navigate("/login", { state: { from: mode === "workshop" ? "/workshop" : "/lobby" } });
      return;
    }
    if (favBusy) return;
    setFavBusy(game.id);
    const prev = !!game.favorited;
    setGames((list) => list.map((g) => (g.id === game.id ? { ...g, favorited: !prev } : g)));
    try {
      await toggleFavorite(game.id, prev);
    } catch (err) {
      setGames((list) => list.map((g) => (g.id === game.id ? { ...g, favorited: prev } : g)));
      const e2 = err as { status?: number; message: string };
      if (e2.status === 401) {
        navigate("/login");
        return;
      }
      setError(e2.message);
    } finally {
      setFavBusy(null);
    }
  }

  return (
    <div className={styles.panel}>
      {mode === "lobby" && (
        <div className={styles.features}>
          <Link className={styles.feat} to="/ranks">
            <div className={styles.icon}>榜</div>
            <div>
              <b>排行榜</b>
              <span>各游戏最高分</span>
            </div>
          </Link>
          <Link className={styles.feat} to="/workshop">
            <div className={styles.icon}>坊</div>
            <div>
              <b>工坊</b>
              <span>玩家上传作品</span>
            </div>
          </Link>
          <Link className={styles.feat} to="/upload">
            <div className={styles.icon}>传</div>
            <div>
              <b>上传</b>
              <span>发布你的小游戏</span>
            </div>
          </Link>
          <Link className={styles.feat} to="/profile?tab=favorites">
            <div className={styles.icon}>藏</div>
            <div>
              <b>收藏</b>
              <span>我的收藏夹</span>
            </div>
          </Link>
        </div>
      )}
      <div className={styles.head}>
        <div className={styles.title}>
          <i />
          {mode === "workshop" ? "创意工坊" : "游戏大厅"}
        </div>
        <span className="muted">{filtered.length} 款</span>
      </div>
      <div className={styles.inkLine} aria-hidden="true" />
      <div className={styles.tabs}>
        {(
          [
            ["all", "全部"],
            ["builtin", "官方"],
            ["user", "玩家上传"]
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`${styles.tab} ${tab === id ? styles.on : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <div className="banner">{error}</div>}
      {openingId && (
        <div className="banner">
          {games.find((g) => g.id === openingId)?.needsBackend
            ? "正在启动游戏服务（首次可能需安装依赖，约 1–3 分钟），请稍候…"
            : "正在打开游戏，请稍候…"}
        </div>
      )}
      {!user && <p className="muted">可以先逛逛，游玩和上传需要登录。</p>}
      <div className={styles.grid}>
        {filtered.map((g) => (
          <div
            key={g.id}
            className={styles.card}
            role="button"
            tabIndex={0}
            onClick={() => openGame(g)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openGame(g);
              }
            }}
          >
            <div className={styles.cardTop}>
              <div className={styles.icon} style={{ background: g.cover || covers[g.id] || "#4a4741" }}>
                {g.name.slice(0, 1)}
              </div>
              <button
                type="button"
                className={`${styles.fav} ${g.favorited ? styles.favOn : ""}`}
                title={g.favorited ? "取消收藏" : "收藏"}
                aria-label={g.favorited ? "取消收藏" : "收藏"}
                disabled={favBusy === g.id}
                onClick={(e) => onFavorite(e, g)}
              >
                {g.favorited ? "★" : "☆"}
              </button>
            </div>
            <h2>{g.name}</h2>
            <p className="muted" style={{ margin: 0, minHeight: 40 }}>
              {g.description}
            </p>
            <div className={styles.tag}>
              {g.source === "user" ? `工坊 · ${g.author || "玩家"}` : "官方"}
            </div>
            {g.source === "user" && (
              <div className={styles.openHow} title={g.openHow || g.playUrl || g.entryFile}>
                打开方式：{g.openHow || g.entryFile || "index.html"}
              </div>
            )}
            <div className={styles.score}>
              我的最高分：{g.myHighScore ?? "—"}
              {g.hasSave ? " · 有存档" : ""}
            </div>
          </div>
        ))}
      </div>
      {loaded && filtered.length === 0 && <p className="muted">这里还没有游戏，去上传一个吧。</p>}
    </div>
  );
}
