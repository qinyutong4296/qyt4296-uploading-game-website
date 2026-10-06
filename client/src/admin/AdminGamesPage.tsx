import { FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAdminCtx } from "./AdminShell";
import type { AdminGame } from "./useAdminEvents";
import styles from "../styles/modules/group-3.module.css";

type AuditStep = { id: string; label: string; ok: boolean; detail: string };
type AuditResult = {
  gameId: string;
  clean: boolean;
  steps: AuditStep[];
  leftoverCount: number;
};

type AuditUi = {
  gameId: string;
  gameName: string;
  phase: "loading" | "running" | "done";
  percent: number;
  currentLabel: string;
  revealed: AuditStep[];
  result: AuditResult | null;
  error: string;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export default function AdminGamesPage() {
  const { games, setGames } = useAdminCtx();
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [audit, setAudit] = useState<AuditUi | null>(null);
  const auditGen = useRef(0);

  async function refresh() {
    const data = await api<{ games: AdminGame[] }>("/api/admin/games");
    setGames(data.games);
  }

  async function hide(id: string, hidden: boolean) {
    setBusy(id);
    setMsg("");
    try {
      await api(`/api/admin/games/${id}/${hidden ? "unhide" : "hide"}`, { method: "POST" });
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy("");
    }
  }

  async function playAudit(gameId: string, gameName: string, result: AuditResult) {
    const gen = ++auditGen.current;
    const total = Math.max(1, result.steps.length);
    setAudit({
      gameId,
      gameName,
      phase: "running",
      percent: 0,
      currentLabel: "开始扫描…",
      revealed: [],
      result: null,
      error: ""
    });

    const revealed: AuditStep[] = [];
    for (let i = 0; i < result.steps.length; i++) {
      if (auditGen.current !== gen) return;
      const step = result.steps[i];
      revealed.push(step);
      const percent = Math.round(((i + 1) / total) * 100);
      setAudit({
        gameId,
        gameName,
        phase: "running",
        percent,
        currentLabel: `正在检查：${step.label}`,
        revealed: [...revealed],
        result: null,
        error: ""
      });
      await sleep(220);
    }

    if (auditGen.current !== gen) return;
    setAudit({
      gameId,
      gameName,
      phase: "done",
      percent: 100,
      currentLabel: result.clean ? "自检通过，无残留" : `发现 ${result.leftoverCount} 项残留`,
      revealed: result.steps,
      result,
      error: ""
    });
  }

  async function runLeftoverCheck(gameId: string, gameName: string) {
    const gen = ++auditGen.current;
    setAudit({
      gameId,
      gameName,
      phase: "loading",
      percent: 0,
      currentLabel: "正在连接自检服务…",
      revealed: [],
      result: null,
      error: ""
    });
    try {
      const result = await api<AuditResult>(`/api/admin/games/${gameId}/leftover-check`);
      if (auditGen.current !== gen) return;
      await playAudit(gameId, gameName, result);
    } catch (e) {
      if (auditGen.current !== gen) return;
      setAudit({
        gameId,
        gameName,
        phase: "done",
        percent: 0,
        currentLabel: "自检失败",
        revealed: [],
        result: null,
        error: e instanceof Error ? e.message : "自检失败"
      });
    }
  }

  async function purgeLeftovers() {
    if (!audit) return;
    const { gameId, gameName } = audit;
    setBusy(gameId);
    setAudit((a) =>
      a
        ? {
            ...a,
            phase: "loading",
            percent: 0,
            currentLabel: "正在清理残留…",
            revealed: [],
            result: null,
            error: ""
          }
        : a
    );
    try {
      const data = await api<{ ok: boolean; audit: AuditResult }>(
        `/api/admin/games/${gameId}/purge-leftovers`,
        { method: "POST" }
      );
      await playAudit(gameId, gameName, data.audit);
      await refresh();
    } catch (e) {
      setAudit((a) =>
        a
          ? {
              ...a,
              phase: "done",
              currentLabel: "清理失败",
              error: e instanceof Error ? e.message : "清理失败"
            }
          : a
      );
    } finally {
      setBusy("");
    }
  }

  async function remove(id: string, name: string) {
    if (!confirm("确定永久删除该工坊游戏？将清除全部文件、收藏、存档、积分及相关痕迹，不可恢复。")) return;
    setBusy(id);
    setMsg("");
    try {
      await api(`/api/admin/games/${id}`, { method: "DELETE" });
      await refresh();
      await runLeftoverCheck(id, name);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy("");
    }
  }

  function startEdit(g: AdminGame) {
    setEditing(g.id);
    setTitle(g.name);
    setDescription(g.description);
  }

  async function saveEdit(e: FormEvent, id: string) {
    e.preventDefault();
    setBusy(id);
    setMsg("");
    try {
      await api(`/api/admin/games/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ title, description })
      });
      setEditing(null);
      await refresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy("");
    }
  }

  useEffect(() => {
    return () => {
      auditGen.current += 1;
    };
  }, []);

  const auditBusy = audit?.phase === "loading" || audit?.phase === "running";

  return (
    <div>
      <h1 className={styles.pageTitle}>游戏管理</h1>
      <p className={styles.pageDesc}>隐藏/恢复游戏，编辑或删除工坊作品。隐藏后大厅不可见。删除后会自动自检残留文件。</p>
      {msg ? <div className={styles.err}>{msg}</div> : null}
      <section className={styles.panel}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>名称</th>
              <th>来源</th>
              <th>作者</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {games.map((g) => (
              <tr key={g.id}>
                <td>
                  <div>
                    <strong>{g.name}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {g.id}
                    </div>
                  </div>
                  {editing === g.id ? (
                    <form className={styles.editBox} onSubmit={(e) => void saveEdit(e, g.id)}>
                      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题" />
                      <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={2}
                        placeholder="简介"
                      />
                      <div className={styles.actions}>
                        <button type="submit" disabled={busy === g.id}>
                          保存
                        </button>
                        <button type="button" className="ghost" onClick={() => setEditing(null)}>
                          取消
                        </button>
                      </div>
                    </form>
                  ) : null}
                </td>
                <td>
                  <span className={`${styles.badge} ${g.source === "user" ? styles.badgeUser : styles.badgeBuiltin}`}>
                    {g.source === "user" ? "工坊" : "内置"}
                  </span>
                </td>
                <td>{g.author || "—"}</td>
                <td>
                  {g.hidden ? <span className={`${styles.badge} ${styles.badgeHidden}`}>已隐藏</span> : "上架"}
                </td>
                <td>
                  <div className={styles.actions}>
                    <button type="button" className="ghost" disabled={busy === g.id} onClick={() => void hide(g.id, g.hidden)}>
                      {g.hidden ? "恢复" : "隐藏"}
                    </button>
                    {g.source === "user" ? (
                      <>
                        <button type="button" className="ghost" onClick={() => startEdit(g)}>
                          编辑
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={busy === g.id}
                          onClick={() => void remove(g.id, g.name)}
                        >
                          删除
                        </button>
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!games.length ? <p className="muted">暂无游戏数据，等待实时连接…</p> : null}
      </section>

      {audit ? (
        <div className={styles.auditMask} role="dialog" aria-modal="true" aria-labelledby="audit-title">
          <div className={styles.auditCard}>
            <h2 id="audit-title" className={styles.auditTitle}>
              删除后自检
            </h2>
            <p className={styles.auditSub}>
              「{audit.gameName}」· <code>{audit.gameId}</code>
            </p>

            <div className={styles.progressWrap} aria-valuemin={0} aria-valuemax={100} aria-valuenow={audit.percent}>
              <div className={styles.progressTrack}>
                <div
                  className={`${styles.progressBar} ${audit.phase === "running" ? styles.progressPulse : ""}`}
                  style={{ width: `${audit.percent}%` }}
                />
              </div>
              <div className={styles.progressMeta}>
                <span>{audit.currentLabel}</span>
                <strong>{audit.percent}%</strong>
              </div>
            </div>

            {audit.error ? <div className={styles.err}>{audit.error}</div> : null}

            {audit.revealed.length ? (
              <ul className={styles.auditList}>
                {audit.revealed.map((s) => (
                  <li key={s.id} className={s.ok ? styles.auditOk : styles.auditBad}>
                    <span className={styles.auditMark}>{s.ok ? "✓" : "!"}</span>
                    <div>
                      <strong>{s.label}</strong>
                      <div className="muted">{s.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted" style={{ margin: "12px 0 0" }}>
                {auditBusy ? "正在扫描文件与数据库…" : "暂无检查项"}
              </p>
            )}

            {audit.phase === "done" && audit.result ? (
              <div className={audit.result.clean ? styles.auditSummaryOk : styles.auditSummaryBad}>
                {audit.result.clean
                  ? "全部检查通过，未发现遗漏文件或数据痕迹。"
                  : `仍有 ${audit.result.leftoverCount} 项残留，可一键清理后再次自检。`}
              </div>
            ) : null}

            <div className={styles.auditActions}>
              {audit.phase === "done" && audit.result && !audit.result.clean ? (
                <button type="button" className="danger" disabled={Boolean(busy)} onClick={() => void purgeLeftovers()}>
                  一键清理残留
                </button>
              ) : null}
              {audit.phase === "done" ? (
                <button
                  type="button"
                  className="ghost"
                  disabled={Boolean(busy)}
                  onClick={() => void runLeftoverCheck(audit.gameId, audit.gameName)}
                >
                  重新自检
                </button>
              ) : null}
              <button
                type="button"
                disabled={auditBusy}
                onClick={() => {
                  auditGen.current += 1;
                  setAudit(null);
                }}
              >
                {audit.phase === "done" ? "关闭" : "检查中…"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
