import { useEffect, useState } from "react";
import { GameHud } from "../shared/GameHud";
import { useGameSession } from "../shared/useGameSession";
import type { GameProps } from "../types";
import styles from "../../styles/modules/group-5.module.css";

const ICONS = ["🦊", "🐸", "🐼", "🦁", "🦄", "🐙", "🐝", "🐧"];

type Card = { id: number; icon: string; flipped: boolean; matched: boolean };

function makeCards(): Card[] {
  const doubled = [...ICONS, ...ICONS].map((icon, id) => ({ id, icon, flipped: false, matched: false }));
  for (let i = doubled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [doubled[i], doubled[j]] = [doubled[j], doubled[i]];
  }
  return doubled;
}

function scoreFromMoves(m: number) {
  return Math.max(0, 800 - m * 20);
}

export default function MemoryGame({ gameId }: GameProps) {
  const session = useGameSession(gameId);
  const [cards, setCards] = useState<Card[]>(makeCards);
  const [open, setOpen] = useState<number[]>([]);
  const [moves, setMoves] = useState(0);
  const [locked, setLocked] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (open.length !== 2) return;
    const [a, b] = open;
    setLocked(true);
    const t = window.setTimeout(() => {
      // updater 必须保持纯函数：StrictMode 会双调 updater，把提交分数放进去会双发请求
      setCards((prev) => {
        const same = prev[a].icon === prev[b].icon;
        return prev.map((c, i) => {
          if (i === a || i === b) return { ...c, flipped: same, matched: c.matched || same };
          return c;
        });
      });
      setOpen([]);
      setLocked(false);
    }, 520);
    return () => window.clearTimeout(t);
  }, [open]);

  // 全部配对完成后提交一次（放在 effect 里，不放进 updater）
  useEffect(() => {
    if (done || !cards.length || !cards.every((c) => c.matched)) return;
    setDone(true);
    void session.submitScore(scoreFromMoves(moves));
  }, [cards, done, moves, session]);

  function flip(i: number) {
    if (!session.player || locked || done) return;
    const card = cards[i];
    if (card.flipped || card.matched || open.includes(i) || open.length >= 2) return;
    setCards((prev) => prev.map((c, idx) => (idx === i ? { ...c, flipped: true } : c)));
    const nextOpen = [...open, i];
    setOpen(nextOpen);
    if (nextOpen.length === 2) setMoves((m) => m + 1);
  }

  function restart() {
    setCards(makeCards());
    setOpen([]);
    setMoves(0);
    setLocked(false);
    setDone(false);
  }

  return (
    <GameHud {...session}>
      <div className={styles.stage}>
        <p className="muted">翻开两张配对 · 步数 {moves} · 预计得分 {scoreFromMoves(moves)} {done ? "· 完成" : ""}</p>
        <div className={styles.grid}>
          {cards.map((c, i) => (
            <button
              key={c.id}
              type="button"
              className={`${styles.card} ${c.flipped || c.matched ? styles.open : ""}`}
              onClick={() => flip(i)}
              disabled={!session.player}
            >
              {c.flipped || c.matched ? c.icon : "?"}
            </button>
          ))}
        </div>
        <button type="button" onClick={restart} disabled={!session.player}>重新开始</button>
      </div>
    </GameHud>
  );
}
