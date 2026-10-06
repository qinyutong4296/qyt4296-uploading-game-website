import { useState } from "react";
import { api } from "../api";
import { useAdminCtx } from "./AdminShell";
import styles from "../styles/modules/group-3.module.css";

function fmt(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function duration(startedAt: string) {
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}分${r}秒` : `${r}秒`;
}

export default function AdminSessionsPage() {
  const { sessions } = useAdminCtx();
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  async function kick(sessionId: string) {
    if (!confirm("强制结束该玩家的当前对局？")) return;
    setBusy(sessionId);
    setMsg("");
    try {
      await api(`/api/admin/sessions/${sessionId}/kick`, { method: "POST" });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "踢出失败");
    } finally {
      setBusy("");
    }
  }

  return (
    <div>
      <h1 className={styles.pageTitle}>在线对局</h1>
      <p className={styles.pageDesc}>实时查看谁在玩什么，可强制结束会话。</p>
      {msg ? <div className={styles.err}>{msg}</div> : null}
      <section className={styles.panel}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>玩家</th>
              <th>游戏</th>
              <th>开始时间</th>
              <th>时长</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.sessionId}>
                <td>
                  <strong>{s.displayName}</strong>
                  <div className="muted" style={{ fontSize: 12 }}>
                    @{s.username}
                  </div>
                </td>
                <td>
                  {s.gameName}
                  <div className="muted" style={{ fontSize: 12 }}>
                    {s.gameId}
                  </div>
                </td>
                <td>{fmt(s.startedAt)}</td>
                <td>{duration(s.startedAt)}</td>
                <td>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy === s.sessionId}
                    onClick={() => void kick(s.sessionId)}
                  >
                    强制结束
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!sessions.length ? <p className="muted">当前没有在线对局。</p> : null}
      </section>
    </div>
  );
}
