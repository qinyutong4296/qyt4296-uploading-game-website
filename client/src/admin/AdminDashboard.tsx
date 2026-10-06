import { useAdminCtx } from "./AdminShell";
import styles from "../styles/modules/group-3.module.css";

function fmt(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function AdminDashboard() {
  const { stats, feed, sessions } = useAdminCtx();

  return (
    <div>
      <h1 className={styles.pageTitle}>运营概览</h1>
      <p className={styles.pageDesc}>实时监控在线对局、分数与工坊上传。</p>
      <div className={styles.cards}>
        <div className={styles.card}>
          <label>在线对局</label>
          <strong>{stats?.online ?? sessions.length}</strong>
        </div>
        <div className={styles.card}>
          <label>注册用户</label>
          <strong>{stats?.users ?? "—"}</strong>
        </div>
        <div className={styles.card}>
          <label>游戏总数</label>
          <strong>{stats?.totalGames ?? "—"}</strong>
        </div>
        <div className={styles.card}>
          <label>今日提交分数</label>
          <strong>{stats?.scoresToday ?? "—"}</strong>
        </div>
      </div>
      <div className={styles.grid2}>
        <section className={styles.panel}>
          <h3>实时事件</h3>
          {feed.length === 0 ? (
            <p className="muted">暂无事件，玩家开局或提交分数后会出现在这里。</p>
          ) : (
            <ul className={styles.feed}>
              {feed.map((f) => (
                <li key={f.id}>
                  <time>{fmt(f.at)}</time>
                  {f.text}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className={styles.panel}>
          <h3>最近分数</h3>
          {!stats?.recentScores?.length ? (
            <p className="muted">暂无记录</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>玩家</th>
                  <th>游戏</th>
                  <th>分数</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentScores.map((r, i) => (
                  <tr key={`${r.at}-${i}`}>
                    <td>{r.displayName}</td>
                    <td>{r.gameId}</td>
                    <td>{r.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3 style={{ marginTop: 18 }}>最近上传</h3>
          {!stats?.recentUploads?.length ? (
            <p className="muted">暂无上传</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>标题</th>
                  <th>作者</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentUploads.map((r) => (
                  <tr key={r.gameId}>
                    <td>{r.name}</td>
                    <td>{r.displayName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
