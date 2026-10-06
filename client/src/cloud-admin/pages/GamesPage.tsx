import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { cloud, db } from "../cloud";
import { errMsg, logAudit } from "../api";
import { fmtTime, type GameRow } from "../types";
import styles from "../../styles/modules/group-2.module.css";

const PAGE_SIZE = 10;

function useCoverUrls(games: GameRow[]) {
  const [urls, setUrls] = useState<Record<number, string>>({});
  useEffect(() => {
    let mounted = true;
    (async () => {
      const paths = games.filter((g) => g.cover_path).map((g) => g.cover_path as string);
      if (paths.length === 0) {
        setUrls({});
        return;
      }
      try {
        const res = await cloud.storage.createSignedUrls(paths, 600);
        const list = (res as { data?: { path: string; signedUrl?: string; url?: string }[] }).data ?? [];
        const map: Record<number, string> = {};
        for (const g of games) {
          const hit = list.find((x) => x.path === g.cover_path);
          const u = hit?.signedUrl ?? hit?.url;
          if (u) map[g.id] = u;
        }
        if (mounted) setUrls(map);
      } catch {
        /* 封面加载失败不阻塞列表 */
      }
    })();
    return () => {
      mounted = false;
    };
  }, [games]);
  return urls;
}

export default function GamesPage() {
  const [games, setGames] = useState<GameRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<"" | "published" | "hidden">("");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<GameRow | null>(null);
  const coverUrls = useCoverUrls(games);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let q = db
        .from("games")
        .select("*", { count: "exact" })
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
      if (keyword.trim()) q = q.ilike("title", `%${keyword.trim()}%`);
      if (status) q = q.eq("status", status);
      const { data, count, error } = await q;
      if (error) throw error;
      setGames((data ?? []) as GameRow[]);
      setTotal(count ?? 0);
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e, "游戏列表加载失败") });
    } finally {
      setLoading(false);
    }
  }, [page, keyword, status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleStatus(game: GameRow) {
    const next = game.status === "published" ? "hidden" : "published";
    const { data, error } = await db
      .from("games")
      .update({ status: next, updated_at: new Date().toISOString() })
      .eq("id", game.id)
      .select();
    if (error) {
      setMsg({ kind: "err", text: errMsg(error) });
      return;
    }
    if (!data || data.length === 0) {
      setMsg({ kind: "err", text: "没有权限修改该游戏" });
      return;
    }
    await logAudit(next === "hidden" ? "hide_game" : "publish_game", game.slug, { title: game.title });
    setMsg({ kind: "ok", text: `「${game.title}」已${next === "hidden" ? "下架" : "上架"}` });
    void load();
  }

  async function remove(game: GameRow) {
    const { data, error } = await db.from("games").delete().eq("id", game.id).select();
    setConfirmDel(null);
    if (error) {
      setMsg({ kind: "err", text: errMsg(error) });
      return;
    }
    if (!data || data.length === 0) {
      setMsg({ kind: "err", text: "没有权限删除该游戏" });
      return;
    }
    await logAudit("delete_game", game.slug, { title: game.title });
    setMsg({ kind: "ok", text: `「${game.title}」已删除` });
    void load();
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className={styles.toolbar}>
        <input
          placeholder="搜索游戏名称…"
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            setPage(1);
          }}
        />
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as typeof status);
            setPage(1);
          }}
        >
          <option value="">全部状态</option>
          <option value="published">已上架</option>
          <option value="hidden">已下架</option>
        </select>
        <Link to="/admin/games/new">
          <button className={styles.primaryBtn} style={{ width: "auto" }}>+ 新增游戏</button>
        </Link>
      </div>

      {msg && <p className={msg.kind === "ok" ? styles.okMsg : styles.errMsg}>{msg.text}</p>}

      {loading ? (
        <div className={styles.loading}>加载中…</div>
      ) : games.length === 0 ? (
        <div className={styles.empty}>没有符合条件的游戏</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>封面</th>
                <th>名称</th>
                <th>分类</th>
                <th>状态</th>
                <th>排序</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {games.map((g) => (
                <tr key={g.id}>
                  <td>
                    {coverUrls[g.id] ? (
                      <img className={styles.coverThumb} src={coverUrls[g.id]} alt="" />
                    ) : (
                      <span className={styles.coverPlaceholder}>{g.title.slice(0, 1)}</span>
                    )}
                  </td>
                  <td>
                    <div>{g.title}</div>
                    <div className={styles.muted} style={{ fontSize: 12 }}>{g.slug}</div>
                  </td>
                  <td>{g.category}</td>
                  <td>
                    <span className={`${styles.badge} ${g.status === "published" ? styles.badgeOk : styles.badgeMuted}`}>
                      {g.status === "published" ? "已上架" : "已下架"}
                    </span>
                  </td>
                  <td>{g.sort_order}</td>
                  <td>{fmtTime(g.updated_at)}</td>
                  <td>
                    <div className={styles.rowActions}>
                      <Link to={`/admin/games/${g.id}/edit`} className={styles.linkBtn}>编辑</Link>
                      <button className={styles.linkBtn} onClick={() => void toggleStatus(g)}>
                        {g.status === "published" ? "下架" : "上架"}
                      </button>
                      <button className={`${styles.linkBtn} ${styles.linkDanger}`} onClick={() => setConfirmDel(g)}>
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.pagination}>
        <button className={styles.ghostBtn} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          上一页
        </button>
        <span>
          第 {page} / {totalPages} 页 · 共 {total} 条
        </span>
        <button className={styles.ghostBtn} disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
          下一页
        </button>
      </div>

      {confirmDel && (
        <div className={styles.modalMask} onClick={() => setConfirmDel(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>确认删除</h3>
            <p className={styles.muted}>
              即将永久删除「{confirmDel.title}」及其关联积分记录,此操作不可恢复。
            </p>
            <div className={styles.formActions}>
              <button className={styles.dangerBtn} onClick={() => void remove(confirmDel)}>
                确认删除
              </button>
              <button className={styles.ghostBtn} onClick={() => setConfirmDel(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
