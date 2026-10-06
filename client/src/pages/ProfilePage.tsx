import { FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, openUserUploadedGame, PublicUser, toggleFavorite } from "../api";
import { useAuth } from "../auth/AuthContext";
import { AvatarFace, isImageAvatar } from "../ui/Avatar";
import styles from "../styles/modules/group-5.module.css";

type FavItem = {
  gameId: string;
  name: string;
  description?: string;
  source?: string;
  entryFile?: string;
  playUrl?: string;
  highScore: number | null;
  favoritedAt?: string;
};

type Profile = {
  user: PublicUser;
  avatarPresets: string[];
  games: {
    gameId: string;
    name: string;
    highScore: number | null;
    updatedAt: string | null;
    favorited: boolean;
  }[];
  favorites: FavItem[];
};

type Tab = "scores" | "favorites" | "edit";

export default function ProfilePage() {
  const { logout, expireSession, setUser } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: Tab = tabParam === "favorites" ? "favorites" : tabParam === "edit" ? "edit" : "scores";
  const fileRef = useRef<HTMLInputElement>(null);

  const [data, setData] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [avatar, setAvatar] = useState("玩");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  function setTab(next: Tab) {
    if (next === "scores") setParams({});
    else setParams({ tab: next });
  }

  async function load(opts?: { syncForm?: boolean }) {
    const syncForm = opts?.syncForm !== false;
    try {
      const profile = await api<Profile>("/api/profile");
      setData(profile);
      if (syncForm) {
        setDisplayName(profile.user.displayName);
        setAvatar(profile.user.avatar || "玩");
        setPendingFile(null);
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return null;
        });
      }
      setUser(profile.user);
    } catch (e) {
      const err = e as { status?: number; message: string };
      if (err.status === 401) {
        expireSession("登录已过期");
        navigate("/login", { replace: true });
        return;
      }
      setError(err.message);
    }
  }

  useEffect(() => {
    void load({ syncForm: true });
    // 只在进入页面时加载一次，避免 setUser 触发重复刷新把编辑内容冲掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function onPickFile(file: File | null) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (!file) {
      setPendingFile(null);
      setPreviewUrl(null);
      return;
    }
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type)) {
      setError("请选择 JPG / PNG / WEBP / GIF 图片");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("图片需小于 2MB");
      return;
    }
    setError("");
    setPendingFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  }

  function pickPreset(ch: string) {
    setAvatar(ch);
    onPickFile(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const form = new FormData();
      form.append("displayName", displayName.trim());
      if (pendingFile) {
        form.append("avatarFile", pendingFile);
      } else {
        form.append("avatar", avatar);
      }
      const res = await api<{ user: PublicUser }>("/api/profile", {
        method: "POST",
        body: form
      });
      setUser(res.user);
      setData((prev) => (prev ? { ...prev, user: res.user } : prev));
      setDisplayName(res.user.displayName);
      setAvatar(res.user.avatar || "玩");
      setPendingFile(null);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      if (fileRef.current) fileRef.current.value = "";
      setNotice("资料已保存");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function onToggleFavorite(gameId: string, favorited: boolean) {
    try {
      await toggleFavorite(gameId, favorited);
      await load({ syncForm: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    }
  }

  async function playGame(game: FavItem | { gameId: string; source?: string; playUrl?: string; entryFile?: string; needsBackend?: boolean }) {
    if (game.source === "user" || game.gameId.startsWith("ug_")) {
      try {
        await openUserUploadedGame(
          {
            id: game.gameId,
            playUrl: game.playUrl,
            entryFile: game.entryFile,
            needsBackend: "needsBackend" in game ? Boolean(game.needsBackend) : false
          },
          navigate
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "无法启动该游戏");
      }
      return;
    }
    try {
      const session = await api<{ playTicket: string }>(`/api/games/${game.gameId}/session`, { method: "POST" });
      navigate(`/play/${game.gameId}#ticket=${session.playTicket}`);
    } catch (err) {
      const e = err as { status?: number; message: string };
      if (e.status === 401) {
        expireSession("登录已过期");
        navigate("/login", { replace: true });
        return;
      }
      setError(e.message);
    }
  }

  const shownAvatar = previewUrl || avatar;
  const presetSelected = !pendingFile && !isImageAvatar(avatar);

  return (
    <div className={styles.page}>
      <div className={styles.top}>
        <div className={styles.identity}>
          <AvatarFace
            avatar={data?.user.avatar}
            name={data?.user.displayName}
            className={styles.avatar}
          />
          <div>
            <h1 style={{ margin: 0 }}>个人资料</h1>
            {data && (
              <p className="muted" style={{ margin: "6px 0 0" }}>
                {data.user.displayName}（@{data.user.username}） · 最近登录 {data.user.lastLoginAt || "—"}
              </p>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link to="/lobby">
            <button className="ghost" type="button">
              大厅
            </button>
          </Link>
          <button className="danger" type="button" onClick={() => logout().then(() => navigate("/login"))}>
            退出
          </button>
        </div>
      </div>

      <div className={styles.tabs}>
        <button type="button" className={`${styles.tab} ${tab === "scores" ? styles.on : ""}`} onClick={() => setTab("scores")}>
          分数记录
        </button>
        <button
          type="button"
          className={`${styles.tab} ${tab === "favorites" ? styles.on : ""}`}
          onClick={() => setTab("favorites")}
        >
          收藏夹{data ? ` (${data.favorites.length})` : ""}
        </button>
        <button type="button" className={`${styles.tab} ${tab === "edit" ? styles.on : ""}`} onClick={() => setTab("edit")}>
          编辑资料
        </button>
      </div>

      {error && <div className="banner">{error}</div>}
      {notice && <div className={styles.notice}>{notice}</div>}

      {tab === "edit" && data && (
        <form className={styles.edit} onSubmit={onSave}>
          <label className={styles.field}>
            <span>昵称</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={20}
              required
              placeholder="1–20 个字"
            />
          </label>

          <div className={styles.field}>
            <span>头像预览</span>
            <AvatarFace avatar={shownAvatar} name={displayName} className={styles.avatarPreview} />
          </div>

          <div className={styles.field}>
            <span>上传本地图片</span>
            <div className={styles.uploadRow}>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={(e) => onPickFile(e.target.files?.[0] || null)}
              />
              {pendingFile && (
                <button type="button" className="ghost" onClick={() => { onPickFile(null); if (fileRef.current) fileRef.current.value = ""; }}>
                  清除所选图片
                </button>
              )}
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              支持 JPG / PNG / WEBP / GIF，最大 2MB
            </p>
          </div>

          <div className={styles.field}>
            <span>或选择文字头像</span>
            <div className={styles.presets}>
              {(data.avatarPresets || []).map((ch) => (
                <button
                  key={ch}
                  type="button"
                  className={`${styles.preset} ${presetSelected && avatar === ch ? styles.presetOn : ""}`}
                  onClick={() => pickPreset(ch)}
                  aria-label={`选择头像 ${ch}`}
                >
                  {ch}
                </button>
              ))}
            </div>
          </div>

          <button type="submit" className="seal" disabled={saving}>
            {saving ? "保存中…" : "保存修改"}
          </button>
        </form>
      )}

      {tab === "favorites" && (
        <div className={styles.list}>
          {(data?.favorites || []).length === 0 && <p className="muted">还没有收藏，去大厅给喜欢的游戏点星吧。</p>}
          {data?.favorites.map((g) => (
            <div className={styles.row} key={g.gameId}>
              <div className={styles.rowMain}>
                <strong>{g.name}</strong>
                <span className="muted">最高分 {g.highScore ?? "—"}</span>
              </div>
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={`${styles.star} ${styles.starOn}`}
                  title="取消收藏"
                  onClick={() => onToggleFavorite(g.gameId, true)}
                >
                  ★
                </button>
                <button type="button" className="ghost" onClick={() => playGame(g)}>
                  游玩
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "scores" && (
        <div className={styles.list}>
          {data?.games.map((g) => (
            <div className={styles.row} key={g.gameId}>
              <div className={styles.rowMain}>
                <strong>{g.name}</strong>
                <span>最高分 {g.highScore ?? "—"}</span>
              </div>
              <button
                type="button"
                className={`${styles.star} ${g.favorited ? styles.starOn : ""}`}
                title={g.favorited ? "取消收藏" : "收藏"}
                onClick={() => onToggleFavorite(g.gameId, g.favorited)}
              >
                {g.favorited ? "★" : "☆"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
