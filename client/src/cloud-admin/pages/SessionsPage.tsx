import { useCallback, useEffect, useState } from "react";
import { db } from "../cloud";
import { errMsg, logAudit } from "../api";
import { fmtTime, shortId, type GameRow, type MemberRow, type SessionRow } from "../types";
import styles from "../../styles/modules/group-2.module.css";

const PAGE_SIZE = 15;

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [games, setGames] = useState<GameRow[]>([]);
  const [memberMap, setMemberMap] = useState<Record<string, string>>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"" | "active" | "ended">("active");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmEnd, setConfirmEnd] = useState<SessionRow | null>(null);

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
        .from("game_sessions")
        .select("*", { count: "exact" })
        .order("started_at", { ascending: false })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
      if (status) q = q.eq("status", status);
      const { data, count, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as SessionRow[];
      setSessions(rows);
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
      setMsg({ kind: "err", text: errMsg(e, "会话数据加载失败") });
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  async function forceEnd(row: SessionRow) {
    const { data, error } = await db
      .from("game_sessions")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "active")
      .select();
    setConfirmEnd(null);
    if (error) {
      setMsg({ kind: "err", text: errMsg(error) });
      return;
    }
    if (!data || data.length === 0) {
      setMsg({ kind: "err", text: "结束失败:会话可能已结束或没有权限" });
      return;
    }
    await logAudit("force_end_session", `#${row.id}`, { owner: shortId(row.owner_id) });
    setMsg({ kind: "ok", text: "会话已强制结束" });
    void load();
  }

  const gameName = (id: number | null) => (id == null ? "-" : games.find((g) => g.id === id)?.title ?? `#${id}`);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className={styles.toolbar}>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as typeof status);
            setPage(1);
          }}
        >
          <option value="active">进行中</option>
          <option value="ended">已结束</option>
          <option value="">全部</option>
        </select>
        <button className={styles.ghostBtn} onClick={() => void load()}>
          刷新
        </button>
        <span className={styles.muted} style={{ fontSize: 12 }}>每 30 秒自动刷新</span>
      </div>

      {msg && <p className={msg.kind === "ok" ? styles.okMsg : styles.errMsg}>{msg.text}</p>}

      {loading ? (
        <div className={styles.loading}>加载中…</div>
      ) : sessions.length === 0 ? (
        <div className={styles.empty}>暂无对局会话</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>ID</th>
                <th>玩家</th>
                <th>游戏</th>
                <th>状态</th>
                <th>开始时间</th>
                <th>结束时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>#{s.id}</td>
                  <td>{memberMap[s.owner_id] || shortId(s.owner_id)}</td>
                  <td>{gameName(s.game_id)}</td>
                  <td>
                    <span className={`${styles.badge} ${s.status === "active" ? styles.badgeOk : styles.badgeMuted}`}>
                      {s.status === "active" ? "进行中" : "已结束"}
                    </span>
                  </td>
                  <td>{fmtTime(s.started_at)}</td>
                  <td>{fmtTime(s.ended_at)}</td>
                  <td>
                    {s.status === "active" && (
                      <button className={`${styles.linkBtn} ${styles.linkDanger}`} onClick={() => setConfirmEnd(s)}>
                        强制结束
                      </button>
                    )}
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

      {confirmEnd && (
        <div className={styles.modalMask} onClick={() => setConfirmEnd(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>强制结束会话</h3>
            <p className={styles.muted}>
              将强制结束玩家 {memberMap[confirmEnd.owner_id] || shortId(confirmEnd.owner_id)} 在
              「{gameName(confirmEnd.game_id)}」的进行中会话。
            </p>
            <div className={styles.formActions}>
              <button className={styles.dangerBtn} onClick={() => void forceEnd(confirmEnd)}>
                确认结束
              </button>
              <button className={styles.ghostBtn} onClick={() => setConfirmEnd(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
