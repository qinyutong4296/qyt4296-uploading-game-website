import { useEffect, useState } from "react";
import { api, GameListItem } from "../api";
import styles from "../styles/modules/group-4.module.css";

type Row = { rank: number; displayName: string; username: string; score: number };

export default function RanksPage() {
  const [games, setGames] = useState<GameListItem[]>([]);
  const [gameId, setGameId] = useState("snake");
  const [board, setBoard] = useState<Row[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ games: GameListItem[] }>("/api/games")
      .then((d) => {
        setGames(d.games);
        if (d.games[0]) setGameId(d.games[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, []);

  useEffect(() => {
    if (!gameId) return;
    api<{ ranking: Row[] }>(`/api/scores/${gameId}`)
      .then((d) => setBoard(d.ranking || []))
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, [gameId]);

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.title}>
          <i />
          排行榜
        </div>
      </div>
      <div className={styles.inkLine} aria-hidden="true" />
      {error && <p className="banner">{error}</p>}
      <div className={styles.tabs}>
        {games.map((g) => (
          <button
            key={g.id}
            type="button"
            className={`${styles.tab} ${gameId === g.id ? styles.on : ""}`}
            onClick={() => setGameId(g.id)}
          >
            {g.name}
          </button>
        ))}
      </div>
      <ol style={{ paddingLeft: 20 }}>
        {board.map((r) => (
          <li key={`${r.rank}-${r.username}`} style={{ margin: "8px 0" }}>
            #{r.rank} {r.displayName} — {r.score}
          </li>
        ))}
      </ol>
      {board.length === 0 && <p className="muted">该游戏还没有成绩。</p>}
    </div>
  );
}
