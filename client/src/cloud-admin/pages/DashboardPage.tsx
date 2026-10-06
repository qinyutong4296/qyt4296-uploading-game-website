import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { db } from "../cloud";
import { errMsg } from "../api";
import { fmtTime, shortId, type AuditRow } from "../types";
import styles from "../../styles/modules/group-2.module.css";

type Counts = {
  games: number;
  published: number;
  members: number;
  scores: number;
  activeSessions: number;
};

type DayBucket = { label: string; count: number };

export default function DashboardPage() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [week, setWeek] = useState<DayBucket[]>([]);
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const head = { count: "exact" as const, head: true };
        const [gamesAll, gamesPub, members, scores, sessions] = await Promise.all([
          db.from("games").select("*", head),
          db.from("games").select("*", head).eq("status", "published"),
          db.from("members").select("*", head),
          db.from("scores").select("*", head),
          db.from("game_sessions").select("*", head).eq("status", "active"),
        ]);
        for (const r of [gamesAll, gamesPub, members, scores, sessions]) {
          if (r.error) throw r.error;
        }
        if (!mounted) return;
        setCounts({
          games: gamesAll.count ?? 0,
          published: gamesPub.count ?? 0,
          members: members.count ?? 0,
          scores: scores.count ?? 0,
          activeSessions: sessions.count ?? 0,
        });

        // 近 7 天积分记录趋势
        const since = new Date();
        since.setHours(0, 0, 0, 0);
        since.setDate(since.getDate() - 6);
        const { data: recent, error: recentErr } = await db
          .from("scores")
          .select("created_at")
          .gte("created_at", since.toISOString())
          .limit(2000);
        if (recentErr) throw recentErr;
        const buckets: DayBucket[] = [];
        for (let i = 0; i < 7; i++) {
          const d = new Date(since);
          d.setDate(d.getDate() + i);
          buckets.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, count: 0 });
        }
        for (const row of (recent ?? []) as { created_at: string }[]) {
          const d = new Date(row.created_at);
          const label = `${d.getMonth() + 1}/${d.getDate()}`;
          const b = buckets.find((x) => x.label === label);
          if (b) b.count += 1;
        }
        if (mounted) setWeek(buckets);

        const { data: auditRows, error: auditErr } = await db
          .from("audit_logs")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(8);
        if (!auditErr && mounted) setLogs((auditRows ?? []) as AuditRow[]);
      } catch (e) {
        if (mounted) setError(errMsg(e, "看板数据加载失败"));
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const maxBar = Math.max(1, ...week.map((b) => b.count));

  return (
    <div>
      {error && <p className={styles.errMsg}>{error}</p>}
      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>游戏总数</div>
          <div className={styles.statValue}>{counts?.games ?? "…"}</div>
          <div className={styles.statExtra}>已上架 {counts?.published ?? "…"} 款</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>注册用户</div>
          <div className={styles.statValue}>{counts?.members ?? "…"}</div>
          <div className={styles.statExtra}>members 表记录</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>积分记录</div>
          <div className={styles.statValue}>{counts?.scores ?? "…"}</div>
          <div className={styles.statExtra}>累计产生的成绩</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>活跃对局</div>
          <div className={styles.statValue}>{counts?.activeSessions ?? "…"}</div>
          <div className={styles.statExtra}>
            <Link to="/admin/sessions" className={styles.linkBtn}>实时查看 →</Link>
          </div>
        </div>
      </div>

      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>近 7 天积分活跃度</h3>
        <div className={styles.barChart}>
          {week.map((b) => (
            <div key={b.label} className={styles.barItem}>
              <span className={styles.barValue}>{b.count || ""}</span>
              <div className={styles.bar} style={{ height: `${Math.round((b.count / maxBar) * 100)}%` }} />
              <span className={styles.barLabel}>{b.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>最近操作日志</h3>
        {logs.length === 0 ? (
          <div className={styles.empty}>暂无操作记录</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作人</th>
                  <th>动作</th>
                  <th>对象</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td>{fmtTime(log.created_at)}</td>
                    <td>{shortId(log.actor_id)}</td>
                    <td>{log.action}</td>
                    <td>{log.target ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
