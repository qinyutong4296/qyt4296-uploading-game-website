import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GameHud } from "../shared/GameHud";
import { useGameSession } from "../shared/useGameSession";
import type { GameProps } from "../types";
import styles from "../../styles/modules/group-6.module.css";

const COLS = 10;
const ROWS = 20;
const TICK = 650;
type Cell = number;
type Piece = { shape: number[][]; x: number; y: number; id: number };
type Save = { grid: Cell[][]; current: Piece; score: number; over: boolean };

const SHAPES = [
  [[1, 1, 1, 1]],
  [[1, 1], [1, 1]],
  [[0, 1, 0], [1, 1, 1]],
  [[1, 0, 0], [1, 1, 1]],
  [[0, 0, 1], [1, 1, 1]],
  [[0, 1, 1], [1, 1, 0]],
  [[1, 1, 0], [0, 1, 1]],
];

function emptyGrid(): Cell[][] {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

function randPiece(): Piece {
  const id = 1 + Math.floor(Math.random() * SHAPES.length);
  return { shape: SHAPES[id - 1].map((r) => [...r]), x: 3, y: 0, id };
}

function rotate(shape: number[][]) {
  const h = shape.length;
  const w = shape[0].length;
  const next = Array.from({ length: w }, () => Array(h).fill(0));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) next[x][h - 1 - y] = shape[y][x];
  return next;
}

function collides(grid: Cell[][], piece: Piece) {
  for (let y = 0; y < piece.shape.length; y++) {
    for (let x = 0; x < piece.shape[y].length; x++) {
      if (!piece.shape[y][x]) continue;
      const gx = piece.x + x;
      const gy = piece.y + y;
      if (gx < 0 || gx >= COLS || gy >= ROWS) return true;
      if (gy >= 0 && grid[gy][gx]) return true;
    }
  }
  return false;
}

function merge(grid: Cell[][], piece: Piece) {
  const next = grid.map((r) => [...r]);
  for (let y = 0; y < piece.shape.length; y++) {
    for (let x = 0; x < piece.shape[y].length; x++) {
      if (!piece.shape[y][x]) continue;
      const gy = piece.y + y;
      const gx = piece.x + x;
      if (gy >= 0) next[gy][gx] = piece.id;
    }
  }
  return next;
}

function clearLines(grid: Cell[][]) {
  const kept = grid.filter((row) => row.some((c) => !c));
  const cleared = ROWS - kept.length;
  while (kept.length < ROWS) kept.unshift(Array(COLS).fill(0));
  return { grid: kept, cleared };
}

export default function TetrisGame({ gameId }: GameProps) {
  const session = useGameSession<Save>(gameId);
  const [grid, setGrid] = useState(emptyGrid);
  const [current, setCurrent] = useState<Piece>(randPiece);
  const [score, setScore] = useState(0);
  const [over, setOver] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const refs = useRef({ grid, current, score, over });
  refs.current = { grid, current, score, over };

  useEffect(() => {
    // 必须等存档请求落定（saveSettled）才能水合：player 先到、save 后到，
    // 提前置 hydrated 会让存档永远不被应用
    if (!session.player || !session.saveSettled || hydrated) return;
    if (session.save?.grid && session.save.current) {
      setGrid(session.save.grid);
      setCurrent(session.save.current);
      setScore(session.save.score || 0);
      setOver(Boolean(session.save.over));
    }
    setHydrated(true);
  }, [session.player, session.saveSettled, session.save, hydrated]);

  const persist = useCallback(
    (g: Cell[][], p: Piece, s: number, o: boolean) => {
      void session.persistSave({ grid: g, current: p, score: s, over: o });
    },
    [session],
  );

  const lockPiece = useCallback(() => {
    const { grid: g, current: p, score: s } = refs.current;
    const cleared = clearLines(merge(g, p));
    const nextScore = s + cleared.cleared * 100;
    const next = randPiece();
    const ended = collides(cleared.grid, next);
    setGrid(cleared.grid);
    setScore(nextScore);
    setCurrent(next);
    setOver(ended);
    persist(cleared.grid, next, nextScore, ended);
    if (ended || nextScore > (session.highScore ?? 0)) {
      void session.submitScore(nextScore);
    }
  }, [persist, session]);

  const tryMove = useCallback(
    (dx: number, dy: number, rot = false) => {
      // 存档未落定前不接受输入，避免先走几步又被到达的存档整体覆盖
      if (refs.current.over || !session.player || !session.saveSettled) return;
      const p = { ...refs.current.current, x: refs.current.current.x + dx, y: refs.current.current.y + dy };
      if (rot) p.shape = rotate(p.shape);
      if (collides(refs.current.grid, p)) {
        if (dy === 1 && !rot) lockPiece();
        return;
      }
      setCurrent(p);
    },
    [lockPiece, session.player],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, () => void> = {
        ArrowLeft: () => tryMove(-1, 0),
        ArrowRight: () => tryMove(1, 0),
        ArrowDown: () => tryMove(0, 1),
        ArrowUp: () => tryMove(0, 0, true),
      };
      if (!map[e.key]) return;
      e.preventDefault();
      map[e.key]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tryMove]);

  useEffect(() => {
    if (over || !hydrated) return;
    const id = window.setInterval(() => tryMove(0, 1), TICK);
    return () => window.clearInterval(id);
  }, [over, hydrated, tryMove]);

  useEffect(() => {
    if (!hydrated || over) return;
    const id = window.setInterval(() => {
      const s = refs.current;
      persist(s.grid, s.current, s.score, s.over);
    }, 4000);
    return () => window.clearInterval(id);
  }, [hydrated, over, persist]);

  const display = useMemo(() => merge(grid, current), [grid, current]);

  function restart() {
    const g = emptyGrid();
    const p = randPiece();
    setGrid(g);
    setCurrent(p);
    setScore(0);
    setOver(false);
    persist(g, p, 0, false);
  }

  return (
    <GameHud {...session} restored={hydrated && session.restored}>
      <div className={styles.stage}>
        <p className="muted">← → 移动 · ↑ 旋转 · ↓ 加速 · 本局 {score} {over ? "· 结束" : ""}</p>
        <div className={styles.grid}>
          {display.flatMap((row, y) =>
            row.map((cell, x) => <div key={`${y}-${x}`} className={cell ? styles.filled : styles.cell} data-id={cell} />),
          )}
        </div>
        <button type="button" onClick={restart} disabled={!session.player}>重新开始</button>
      </div>
    </GameHud>
  );
}
