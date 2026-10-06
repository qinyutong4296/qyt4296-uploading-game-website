import type { ReactNode } from "react";
import type { PublicUser } from "../../api";
import type { LeaderRow } from "./useGameSession";
import styles from "../../styles/modules/group-3.module.css";

export function GameHud({
  player,
  highScore,
  restored,
  board,
  error,
  children,
}: {
  player: PublicUser | null;
  highScore: number | null;
  restored?: boolean;
  board: LeaderRow[];
  error: string | null;
  children: ReactNode;
  [extra: string]: unknown;
}) {
  if (error && !player) {
    return (
      <div className={styles.wrap}>
        <p className="banner">
          {error}。未授权，不能以游客模式继续玩。{" "}
          <a href="/login" target="_top">
            返回登录
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.identity}>
        <strong>玩家：{player?.displayName || "校验中…"}</strong>
        <span className="muted">@{player?.username} · 用户 ID {player?.id ?? "…"}</span>
        {highScore !== null && <span>最高分 {highScore}</span>}
      </div>
      {restored && <p className="ok-banner">已恢复你的进度</p>}
      {error && <p className="banner">{error}</p>}
      {children}
      <h3>本游戏排行榜</h3>
      <ol className={styles.board}>
        {board.length === 0 && <li className="muted">暂无记录</li>}
        {board.map((row) => (
          <li key={`${row.rank}-${row.username}`}>
            #{row.rank} {row.displayName} — {row.score}
          </li>
        ))}
      </ol>
    </div>
  );
}
