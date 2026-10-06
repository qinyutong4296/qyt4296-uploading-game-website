import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  BoardMessage,
  deleteMessage,
  listMessages,
  postMessage
} from "../api";
import { useAuth } from "../auth/AuthContext";
import { AvatarFace } from "../ui/Avatar";
import styles from "../styles/modules/group-3.module.css";

const MAX_CONTENT = 500;

function timeAgo(iso: string) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function BoardPage() {
  const { user } = useAuth();
  const [messages, setMessages] = useState<BoardMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    listMessages()
      .then((d) => {
        if (cancelled) return;
        setMessages(d.messages);
        setTotal(d.total);
        setLoaded(true);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "留言加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const remaining = MAX_CONTENT - content.length;
  const canSubmit = useMemo(() => content.trim().length > 0 && remaining >= 0 && !busy, [
    content,
    remaining,
    busy
  ]);

  async function reload() {
    const d = await listMessages();
    setMessages(d.messages);
    setTotal(d.total);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError("");
    setBusy(true);
    try {
      await postMessage(content.trim());
      setContent("");
      await reload();
      composerRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "留言失败");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(id: number) {
    setError("");
    try {
      await deleteMessage(id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div className={styles.kicker}>MESSAGE BOARD</div>
        <h1 className={styles.title}>留 言 板</h1>
        <p className="muted">路过请留爪印 · 已有 {total} 条留言</p>
      </div>

      {error && <div className="banner">{error}</div>}

      <form className={styles.composer} onSubmit={onSubmit}>
        <AvatarFace avatar={user?.avatar} name={user?.displayName} className={styles.composerAvatar} />
        <div className={styles.composerMain}>
          <textarea
            ref={composerRef}
            value={content}
            onChange={(e) => setContent(e.target.value.slice(0, MAX_CONTENT))}
            placeholder={user ? `说点什么吧，${user.displayName}…` : "说点什么吧…"}
            rows={3}
          />
          <div className={styles.composerBar}>
            <span className={`${styles.count} ${remaining < 50 ? styles.countLow : ""}`}>
              {remaining}
            </span>
            <button type="submit" disabled={!canSubmit}>
              {busy ? "正在落墨…" : "留下脚印"}
            </button>
          </div>
        </div>
      </form>

      {loaded && messages.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptySeal}>空</div>
          <p className="muted">墙上还没有字，第一句由你来写。</p>
        </div>
      ) : (
        <div className={styles.list}>
          {messages.map((m, i) => (
            <article key={m.id} className={styles.note} style={{ animationDelay: `${Math.min(i, 10) * 0.03}s` }}>
              <div className={styles.noteSide}>
                <AvatarFace avatar={m.author.avatar} name={m.author.displayName} className={styles.noteAvatar} />
              </div>
              <div className={styles.noteMain}>
                <header className={styles.noteHead}>
                  <span className={styles.noteName}>{m.author.displayName}</span>
                  {m.author.isAdmin && <span className={styles.noteAdmin}>管理员</span>}
                  <span className={styles.noteTime}>{timeAgo(m.createdAt)}</span>
                </header>
                <p className={styles.noteContent}>{m.content}</p>
              </div>
              {(m.mine || user?.isAdmin) && (
                <button
                  type="button"
                  className={styles.noteDelete}
                  onClick={() => onRemove(m.id)}
                  title={user?.isAdmin && !m.mine ? "管理员删除" : "删除"}
                >
                  删除
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
