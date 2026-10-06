import { useCallback, useEffect, useState } from "react";
import { db } from "../cloud";
import { errMsg, logAudit } from "../api";
import { fmtTime, shortId, type MemberRow } from "../types";
import styles from "../../styles/modules/group-2.module.css";

const PAGE_SIZE = 10;

export default function MembersPage() {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let q = db
        .from("members")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
      if (keyword.trim()) q = q.ilike("nickname", `%${keyword.trim()}%`);
      const { data, count, error } = await q;
      if (error) throw error;
      setMembers((data ?? []) as MemberRow[]);
      setTotal(count ?? 0);
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e, "用户列表加载失败") });
    } finally {
      setLoading(false);
    }
  }, [page, keyword]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleDisabled(m: MemberRow) {
    const next = !m.disabled;
    const { data, error } = await db
      .from("members")
      .update({ disabled: next })
      .eq("id", m.id)
      .select();
    if (error) {
      setMsg({ kind: "err", text: errMsg(error) });
      return;
    }
    if (!data || data.length === 0) {
      setMsg({ kind: "err", text: "没有权限修改该用户" });
      return;
    }
    await logAudit(next ? "disable_member" : "enable_member", shortId(m.owner_id), { nickname: m.nickname });
    setMsg({ kind: "ok", text: `已${next ? "禁用" : "恢复"}「${m.nickname || shortId(m.owner_id)}」` });
    void load();
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className={styles.toolbar}>
        <input
          placeholder="搜索昵称…"
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            setPage(1);
          }}
        />
      </div>

      {msg && <p className={msg.kind === "ok" ? styles.okMsg : styles.errMsg}>{msg.text}</p>}

      {loading ? (
        <div className={styles.loading}>加载中…</div>
      ) : members.length === 0 ? (
        <div className={styles.empty}>暂无用户记录</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>昵称</th>
                <th>用户 ID</th>
                <th>状态</th>
                <th>最近活跃</th>
                <th>注册时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>{m.nickname || "-"}</td>
                  <td className={styles.muted}>{shortId(m.owner_id)}</td>
                  <td>
                    <span className={`${styles.badge} ${m.disabled ? styles.badgeDanger : styles.badgeOk}`}>
                      {m.disabled ? "已禁用" : "正常"}
                    </span>
                  </td>
                  <td>{fmtTime(m.last_seen_at)}</td>
                  <td>{fmtTime(m.created_at)}</td>
                  <td>
                    <button
                      className={`${styles.linkBtn} ${m.disabled ? "" : styles.linkDanger}`}
                      onClick={() => void toggleDisabled(m)}
                    >
                      {m.disabled ? "恢复" : "禁用"}
                    </button>
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
    </div>
  );
}
