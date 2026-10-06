import { useCallback, useEffect, useRef, useState } from "react";
import { GameHud } from "../shared/GameHud";
import { useGameSession } from "../shared/useGameSession";
import type { GameProps } from "../types";
import styles from "../../styles/modules/group-2.module.css";

const SIZE = 18;
const TICK = 110;
type Point = { x: number; y: number };

function eq(a: Point, b: Point) {
  return a.x === b.x && a.y === b.y;
}

function randomFood(snake: Point[]): Point {
  while (true) {
    const p = { x: Math.floor(Math.random() * SIZE), y: Math.floor(Math.random() * SIZE) };
    if (!snake.some((s) => eq(s, p))) return p;
  }
}

export default function SnakeGame({ gameId }: GameProps) {
  const session = useGameSession(gameId);
  const [snake, setSnake] = useState<Point[]>([{ x: 8, y: 8 }]);
  const [food, setFood] = useState<Point>({ x: 12, y: 8 });
  const [dir, setDir] = useState<Point>({ x: 1, y: 0 });
  const [score, setScore] = useState(0);
  const [dead, setDead] = useState(false);
  const [running, setRunning] = useState(false);
  const refs = useRef({ dir, snake, food, dead, score });
  refs.current = { dir, snake, food, dead, score };
  // 每 tick 最多缓存一次转向，且以「上一次实际移动方向」为基准校验反向：
  // 只对比「已按键方向」时，一个 tick 内连按两键可以原地掉头撞脖子自杀
  const pendingDirRef = useRef<Point | null>(null);
  const movedDirRef = useRef<Point>({ x: 1, y: 0 });

  const reset = useCallback(() => {
    const start = [{ x: 8, y: 8 }];
    setSnake(start);
    setFood(randomFood(start));
    setDir({ x: 1, y: 0 });
    setScore(0);
    setDead(false);
    setRunning(true);
    pendingDirRef.current = null;
    movedDirRef.current = { x: 1, y: 0 };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, Point> = {
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        w: { x: 0, y: -1 },
        s: { x: 0, y: 1 },
        a: { x: -1, y: 0 },
        d: { x: 1, y: 0 },
      };
      const next = map[e.key] || map[e.key.toLowerCase()];
      if (!next) return;
      e.preventDefault();
      const base = pendingDirRef.current ?? movedDirRef.current;
      if (base.x + next.x === 0 && base.y + next.y === 0) return;
      if (!pendingDirRef.current) pendingDirRef.current = next;
      if (!running && !refs.current.dead) setRunning(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running]);

  useEffect(() => {
    if (!running || dead) return;
    const id = window.setInterval(() => {
      const { snake: body, food: f, score: sc } = refs.current;
      const d = pendingDirRef.current ?? movedDirRef.current;
      pendingDirRef.current = null;
      const head = { x: body[0].x + d.x, y: body[0].y + d.y };
      const ate = eq(head, f);
      // 不吃食物时尾格与本 tick 同时让位（跟尾合法）；吃到时尾巴不动，尾格仍算占用
      const hitLen = ate ? body.length : body.length - 1;
      const hit =
        head.x < 0 ||
        head.y < 0 ||
        head.x >= SIZE ||
        head.y >= SIZE ||
        body.slice(0, hitLen).some((p) => eq(p, head));
      if (hit) {
        setDead(true);
        setRunning(false);
        void session.submitScore(sc);
        return;
      }
      movedDirRef.current = d;
      setDir(d);
      const next = [head, ...body];
      if (!ate) next.pop();
      else {
        const nextScore = sc + 10;
        setScore(nextScore);
        setFood(randomFood(next));
        if (session.highScore === null || nextScore > session.highScore) void session.submitScore(nextScore);
      }
      setSnake(next);
    }, TICK);
    return () => window.clearInterval(id);
  }, [running, dead, session]);

  return (
    <GameHud {...session}>
      <div className={styles.stage}>
        <p className="muted">方向键 / WASD · 本局 {score} {dead ? "· 结束" : running ? "· 进行中" : "· 按方向键开始"}</p>
        <div className={styles.grid}>
          {Array.from({ length: SIZE * SIZE }, (_, i) => {
            const x = i % SIZE;
            const y = Math.floor(i / SIZE);
            const isHead = eq(snake[0], { x, y });
            const isBody = snake.some((p, idx) => idx > 0 && eq(p, { x, y }));
            const isFood = eq(food, { x, y });
            return <div key={i} className={isHead ? styles.head : isBody ? styles.body : isFood ? styles.food : styles.cell} />;
          })}
        </div>
        <button type="button" onClick={reset} disabled={!session.player}>{dead ? "再来一局" : "开始"}</button>
      </div>
    </GameHud>
  );
}
