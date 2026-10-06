import { useEffect, useRef, useState } from "react";
import { GameHud } from "../shared/GameHud";
import { useGameSession } from "../shared/useGameSession";
import type { GameProps } from "../types";
import styles from "../../styles/modules/group-4.module.css";

const W = 480;
const H = 320;

export default function BreakoutGame({ gameId }: GameProps) {
  const session = useGameSession(gameId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [over, setOver] = useState(false);
  const [won, setWon] = useState(false);
  const state = useRef({
    paddle: 200,
    ball: { x: 240, y: 250, vx: 3, vy: -3 },
    bricks: [] as { x: number; y: number; live: boolean }[],
    running: false,
    score: 0,
    lives: 3,
  });
  // 会话对象通过 ref 读取：highScore 一变就让游戏 effect 重跑会把砖墙整体复活
  const sessionRef = useRef(session);
  sessionRef.current = session;

  function setupBricks() {
    const bricks = [];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 8; c++) bricks.push({ x: 20 + c * 56, y: 30 + r * 22, live: true });
    }
    return bricks;
  }

  useEffect(() => {
    const s = state.current;
    s.bricks = setupBricks();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      s.paddle = Math.max(0, Math.min(W - 80, ((e.clientX - rect.left) / rect.width) * W - 40));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") s.paddle = Math.max(0, s.paddle - 24);
      if (e.key === "ArrowRight") s.paddle = Math.min(W - 80, s.paddle + 24);
    };
    canvas.addEventListener("mousemove", onMove);
    window.addEventListener("keydown", onKey);

    let raf = 0;
    const loop = () => {
      if (s.running) {
        s.ball.x += s.ball.vx;
        s.ball.y += s.ball.vy;
        if (s.ball.x < 6 || s.ball.x > W - 6) s.ball.vx *= -1;
        if (s.ball.y < 6) s.ball.vy *= -1;
        if (s.ball.y > H - 18 && s.ball.x > s.paddle && s.ball.x < s.paddle + 80) {
          s.ball.vy = -Math.abs(s.ball.vy);
          s.ball.vx += (s.ball.x - (s.paddle + 40)) / 20;
        }
        if (s.ball.y > H) {
          s.lives -= 1;
          setLives(s.lives);
          s.ball = { x: 240, y: 250, vx: 3, vy: -3 };
          if (s.lives <= 0) {
            s.running = false;
            setOver(true);
            void sessionRef.current.submitScore(s.score);
          }
        }
        for (const b of s.bricks) {
          if (!b.live) continue;
          if (s.ball.x > b.x && s.ball.x < b.x + 50 && s.ball.y > b.y && s.ball.y < b.y + 16) {
            b.live = false;
            s.ball.vy *= -1;
            s.score += 10;
            setScore(s.score);
            const hs = sessionRef.current.highScore;
            if (hs === null || s.score > hs) void sessionRef.current.submitScore(s.score);
          }
        }
        if (s.bricks.every((b) => !b.live)) {
          s.running = false;
          // 通关 +50 计入本局分数，保证 HUD 与排行榜一致
          s.score += 50;
          setScore(s.score);
          setWon(true);
          void sessionRef.current.submitScore(s.score);
        }
      }
      ctx.fillStyle = "#f3f0ea";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#141210";
      ctx.fillRect(s.paddle, H - 14, 80, 10);
      ctx.beginPath();
      ctx.fillStyle = "#3d5c48";
      ctx.arc(s.ball.x, s.ball.y, 6, 0, Math.PI * 2);
      ctx.fill();
      for (const b of s.bricks) {
        if (!b.live) continue;
        ctx.fillStyle = "#c3272b";
        ctx.fillRect(b.x, b.y, 50, 16);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("mousemove", onMove);
      window.removeEventListener("keydown", onKey);
    };
    // 挂载时初始化一次即可；依赖 session 会在新高分瞬间重建整个游戏（砖墙复活）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function start() {
    const s = state.current;
    s.bricks = setupBricks();
    s.ball = { x: 240, y: 250, vx: 3, vy: -3 };
    s.score = 0;
    s.lives = 3;
    s.running = true;
    setScore(0);
    setLives(3);
    setOver(false);
    setWon(false);
  }

  return (
    <GameHud {...session}>
      <div className={styles.stage}>
        <p className="muted">鼠标或方向键移动挡板 · 分数 {score} · 生命 {lives} {over ? "· 失败" : ""} {won ? "· 通关" : ""}</p>
        <canvas ref={canvasRef} width={W} height={H} className={styles.canvas} />
        <button type="button" onClick={start} disabled={!session.player}>{over || won ? "再来一局" : "开始"}</button>
      </div>
    </GameHud>
  );
}
