import { useCallback, useEffect, useState } from "react";
import { db } from "../cloud";
import { errMsg, logAudit } from "../api";
import { fmtTime, shortId, type GameRow, type MemberRow, type ScoreRow } from "../types";
import styles from "../../styles/modules/group-2.module.css";

const PAGE_SIZE = 15;

export default function ScoresPage() {
  const [scores, setScores] = useState<ScoreRow[]>([]);
  const [games, setGames] = useState<GameRow[]>([]);
  const [memberMap, setMemberMap] = useState<Record<string, string>>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [gameId, setGameId] = useState<number | "">("");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [editing, setEditing] = useState<ScoreRow | null>(null);
  const [editValue, setEditValue] = useState("");

  useEffect(() => {
    void (async () => {
      const { data } = await db.from("games").select("id, title").order("sort_order");
      setGames((data ?? []) as GameRow[]);
    })();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let q = db
        .from("scores")
        .select("*", { count: "exact" })
        .order("score", { ascending: false })
        .order("created_at", { ascending: false })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
      if (gameId !== "") q = q.eq("game_id", gameId);
      const { data, count, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as ScoreRow[];
      setScores(rows);
      setTotal(count ?? 0);

      const ownerIds = [...new Set(rows.map((r) => r.owner_id))];
      if (ownerIds.length > 0) {
        const { data: ms } = await db
          .from("members")
          .select("owner_id, nickname")
          .in("owner_id", ownerIds);
        const map: Record<string, string> = {};
        for (const m of (ms ?? []) as Pick<MemberRow, "owner_id" | "nickname">[]) {
          map[m.owner_id] = m.nickname;
        }
        setMemberMap(map);
      } else {
        setMemberMap({});
      }
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e, "积分数据加载失败") });
    } finally {
      setLoading(false);
    }
  }, [page, gameId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveEdit() {
    if (!editing) return;
    const value = Number(editValue);
    if (!Number.isFinite(value) || value < 0) {
      setMsg({ kind: "err", text: "积分必须是不小于 0 的数字" });
      return;
    }
    const { data, error } = await db
      .from("scores")
      .update({ score: Math.round(value) })
      .eq("id", editing.id)
      .select();
    if (error) {
      setMsg({ kind: "err", text: errMsg(error) });
      return;
    }
    if (!data || data.length === 0) {
      setMsg({ kind: "err", text: "没有权限修正该记录" });
      return;
    }
    await logAudit("edit_score", `#${editing.id}`, { from: editing.score, to: Math.round(value) });
    setEditing(null);
    setMsg({ kind: "ok", text: "积分已修正" });
    void load();
  }

  async function remove(row: ScoreRow) {
    const { data, error } = await db.from("scores").delete().eq("id", row.id).select();
    if (error) {
      setMsg({ kind: "err", text: errMsg(error) });
      return;
    }
    if (!data || data.length === 0) {
      setMsg({ kind: "err", text: "没有权限删除该记录" });
      return;
    }
    await logAudit("delete_score", `#${row.id}`, { score: row.score });
    setMsg({ kind: "ok", text: "记录已删除" });
    void load();
  }

  const gameName = (id: number) => games.find((g) => g.id === id)?.title ?? `#${id}`;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className={styles.toolbar}>
        <select
          value={gameId}
          onChange={(e) => {
            setGameId(e.target.value === "" ? "" : Number(e.target.value));
            setPage(1);
          }}
        >
          <option value="">全部游戏</option>
          {games.map((g) => (
            <option key={g.id} value={g.id}>{g.title}</option>
          ))}
        </select>
      </div>

      {msg && <p className={msg.kind === "ok" ? styles.okMsg : styles.errMsg}>{msg.text}</p>}

      {loading ? (
        <div className={styles.loading}>加载中…</div>
      ) : scores.length === 0 ? (
        <div className={styles.empty}>暂无积分记录</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>#</th>
                <th>玩家</th>
                <th>游戏</th>
                <th>积分</th>
                <th>时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {scores.map((s, i) => (
                <tr key={s.id}>
                  <td>{(page - 1) * PAGE_SIZE + i + 1}</td>
                  <td>{memberMap[s.owner_id] || shortId(s.owner_id)}</td>
                  <td>{gameName(s.game_id)}</td>
                  <td style={{ fontWeight: 600 }}>{s.score}</td>
                  <td>{fmtTime(s.created_at)}</td>
                  <td>
                    <div className={styles.rowActions}>
                      <button
                        className={styles.linkBtn}
                        onClick={() => {
                          setEditing(s);
                          setEditValue(String(s.score));
                        }}
                      >
                        修正
                      </button>
                      <button className={`${styles.linkBtn} ${styles.linkDanger}`} onClick={() => void remove(s)}>
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

      {editing && (
        <div className={styles.modalMask} onClick={() => setEditing(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>修正积分</h3>
            <p className={styles.muted}>
              玩家 {memberMap[editing.owner_id] || shortId(editing.owner_id)} · {gameName(editing.game_id)}
            </p>
            <label className={styles.field}>
              <span>新积分</span>
              <input
                type="number"
                min={0}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                autoFocus
              />
            </label>
            <div className={styles.formActions}>
              <button className={styles.primaryBtn} onClick={() => void saveEdit()}>
                保存
              </button>
              <button className={styles.ghostBtn} onClick={() => setEditing(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
