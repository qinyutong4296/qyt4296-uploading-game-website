import { useCallback, useEffect, useState } from "react";
import { GameHud } from "../shared/GameHud";
import { useGameSession } from "../shared/useGameSession";
import type { GameProps } from "../types";
import styles from "../../styles/modules/group-7.module.css";

type Save = { board: number[][]; score: number };
const SIZE = 4;

function emptyBoard(): number[][] {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
}

function addRandomTile(board: number[][]): number[][] {
  const next = board.map((r) => [...r]);
  const empty: [number, number][] = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (!next[y][x]) empty.push([y, x]);
  if (!empty.length) return next;
  const [y, x] = empty[Math.floor(Math.random() * empty.length)];
  next[y][x] = Math.random() < 0.9 ? 2 : 4;
  return next;
}

function slideRow(row: number[]): { row: number[]; gained: number } {
  const nums = row.filter((n) => n);
  const out: number[] = [];
  let gained = 0;
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] === nums[i + 1]) {
      const v = nums[i] * 2;
      out.push(v);
      gained += v;
      i++;
    } else out.push(nums[i]);
  }
  while (out.length < SIZE) out.push(0);
  return { row: out, gained };
}

function transpose(board: number[][]) {
  return board[0].map((_, i) => board.map((row) => row[i]));
}

function moveLeft(board: number[][]) {
  let gained = 0;
  const next = board.map((row) => {
    const r = slideRow(row);
    gained += r.gained;
    return r.row;
  });
  return { board: next, gained };
}

function move(board: number[][], dir: "L" | "R" | "U" | "D") {
  let work = board.map((r) => [...r]);
  if (dir === "R") work = work.map((r) => r.slice().reverse());
  if (dir === "U") work = transpose(work);
  if (dir === "D") work = transpose(work).map((r) => r.slice().reverse());
  const result = moveLeft(work);
  let next = result.board;
  if (dir === "R") next = next.map((r) => r.slice().reverse());
  if (dir === "U") next = transpose(next);
  if (dir === "D") next = transpose(next.map((r) => r.slice().reverse()));
  const moved = JSON.stringify(next) !== JSON.stringify(board);
  return { board: next, gained: result.gained, moved };
}

function canMove(board: number[][]) {
  if (board.some((r) => r.includes(0))) return true;
  for (const dir of ["L", "R", "U", "D"] as const) if (move(board, dir).moved) return true;
  return false;
}

export default function Game2048({ gameId }: GameProps) {
  const session = useGameSession<Save>(gameId);
  const [board, setBoard] = useState<number[][]>(() => addRandomTile(addRandomTile(emptyBoard())));
  const [score, setScore] = useState(0);
  const [over, setOver] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // 必须等存档请求落定（saveSettled）才能水合：player 先到、save 后到，
    // 提前置 hydrated 会让存档永远不被应用
    if (!session.player || !session.saveSettled || hydrated) return;
    if (session.save?.board) {
      setBoard(session.save.board);
      setScore(session.save.score || 0);
      setOver(!canMove(session.save.board));
    }
    setHydrated(true);
  }, [session.player, session.saveSettled, session.save, hydrated]);

  const applyMove = useCallback(
    (dir: "L" | "R" | "U" | "D") => {
      if (over || !session.player || !session.saveSettled) return;
      const result = move(board, dir);
      if (!result.moved) return;
      const nextBoard = addRandomTile(result.board);
      const nextScore = score + result.gained;
      setBoard(nextBoard);
      setScore(nextScore);
      void session.persistSave({ board: nextBoard, score: nextScore });
      // 终局只提交一次：旧逻辑「新高分提交一次 + 结束再提交一次」会同一步双发
      const isNewHigh = session.highScore === null || nextScore > session.highScore;
      if (!canMove(nextBoard)) {
        setOver(true);
        void session.submitScore(nextScore);
      } else if (isNewHigh) {
        void session.submitScore(nextScore);
      }
    },
    [board, over, score, session],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, "L" | "R" | "U" | "D"> = {
        ArrowLeft: "L",
        ArrowRight: "R",
        ArrowUp: "U",
        ArrowDown: "D",
      };
      const dir = map[e.key];
      if (!dir) return;
      e.preventDefault();
      applyMove(dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyMove]);

  function restart() {
    const next = addRandomTile(addRandomTile(emptyBoard()));
    setBoard(next);
    setScore(0);
    setOver(false);
    void session.persistSave({ board: next, score: 0 });
  }

  return (
    <GameHud {...session} restored={hydrated && session.restored}>
      <div className={styles.stage}>
        <p className="muted">方向键合并 · 本局 {score} {over ? "· 无法继续" : ""}</p>
        <div className={styles.grid}>
          {board.flatMap((row, y) =>
            row.map((n, x) => (
              <div key={`${y}-${x}`} className={styles.tile} data-v={n}>{n || ""}</div>
            )),
          )}
        </div>
        <button type="button" onClick={restart} disabled={!session.player}>重新开始</button>
      </div>
    </GameHud>
  );
}
