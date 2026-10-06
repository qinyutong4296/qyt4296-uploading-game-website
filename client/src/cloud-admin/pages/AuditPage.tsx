import { useCallback, useEffect, useState } from "react";
import { db } from "../cloud";
import { errMsg } from "../api";
import { fmtTime, shortId, type AuditRow } from "../types";
import styles from "../../styles/modules/group-2.module.css";

const PAGE_SIZE = 20;

const ACTION_LABELS: Record<string, string> = {
  claim_admin: "认领管理员",
  create_game: "新增游戏",
  update_game: "编辑游戏",
  hide_game: "下架游戏",
  publish_game: "上架游戏",
  delete_game: "删除游戏",
  disable_member: "禁用用户",
  enable_member: "恢复用户",
  edit_score: "修正积分",
  delete_score: "删除积分",
  force_end_session: "强制结束会话",
};

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, count, error: err } = await db
        .from("audit_logs")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
      if (err) throw err;
      setLogs((data ?? []) as AuditRow[]);
      setTotal(count ?? 0);
    } catch (e) {
      setError(errMsg(e, "日志加载失败"));
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      {error && <p className={styles.errMsg}>{error}</p>}
      {loading ? (
        <div className={styles.loading}>加载中…</div>
      ) : logs.length === 0 ? (
        <div className={styles.empty}>暂无操作日志</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>时间</th>
                <th>操作人</th>
                <th>动作</th>
                <th>对象</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtTime(log.created_at)}</td>
                  <td className={styles.muted}>{shortId(log.actor_id)}</td>
                  <td>
                    <span className={`${styles.badge} ${styles.badgeWarn}`}>
                      {ACTION_LABELS[log.action] ?? log.action}
                    </span>
                  </td>
                  <td>{log.target ?? "-"}</td>
                  <td className={styles.muted} style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {log.detail ? JSON.stringify(log.detail) : "-"}
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
