import fs from "node:fs";
import path from "node:path";
import { db } from "./db";
import { GAMES, GameMeta } from "./types";
import { clearPresenceByGame, listPresence } from "./presence";
import {
  detectLaunchPlan,
  hasUserGameRuntime,
  stopUserGameRuntime,
  userGameNeedsBackend
} from "./userGameRuntime";

const uploadsRoot = path.join(__dirname, "..", "uploads");

export function isUserGameId(gameId: string): boolean {
  return /^ug_[a-zA-Z0-9]+$/.test(gameId);
}

export type ListedGame = GameMeta & {
  source: "builtin" | "user";
  author?: string;
  authorId?: number;
  cover?: string;
  hidden?: boolean;
  createdAt?: string;
  entryFile?: string;
  playUrl?: string;
  needsBackend?: boolean;
  openHow?: string;
};

type UserGameRow = {
  id: string;
  owner_id: number;
  title: string;
  description: string;
  cover_color: string;
  entry_file: string;
  created_at: string;
  username?: string;
  display_name?: string | null;
};

function hiddenSet(): Set<string> {
  const rows = db.prepare("SELECT game_id FROM hidden_games").all() as { game_id: string }[];
  return new Set(rows.map((r) => r.game_id));
}

export function isGameHidden(gameId: string): boolean {
  const row = db.prepare("SELECT game_id FROM hidden_games WHERE game_id = ?").get(gameId) as
    | { game_id: string }
    | undefined;
  return Boolean(row);
}

export function hideGame(gameId: string) {
  db.prepare("INSERT OR IGNORE INTO hidden_games (game_id) VALUES (?)").run(gameId);
}

export function unhideGame(gameId: string) {
  db.prepare("DELETE FROM hidden_games WHERE game_id = ?").run(gameId);
}

export function listUserGames(): ListedGame[] {
  const rows = db
    .prepare(
      `SELECT g.*, u.username, u.display_name
       FROM user_games g
       JOIN users u ON u.id = g.owner_id
       ORDER BY g.created_at DESC`
    )
    .all() as UserGameRow[];
  return rows.map((r) => {
    const entryFile = r.entry_file || "index.html";
    const needsBackend = userGameNeedsBackend(r.id);
    const plan = needsBackend ? detectLaunchPlan(r.id) : null;
    return {
      id: r.id,
      name: r.title,
      description: r.description,
      source: "user" as const,
      author: r.display_name || r.username,
      authorId: r.owner_id,
      cover: r.cover_color,
      createdAt: r.created_at,
      entryFile,
      playUrl: `/ug/${r.id}/${entryFile}`,
      needsBackend,
      openHow: needsBackend
        ? plan?.kind === "bat"
          ? `打开时自动运行 ${plan.startScript}`
          : `打开时自动启动后端（端口 ${plan?.port}）`
        : `浏览器打开 ${entryFile}`
    };
  });
}

function withHiddenFlags(games: ListedGame[]): ListedGame[] {
  const hidden = hiddenSet();
  return games.map((g) => ({ ...g, hidden: hidden.has(g.id) }));
}

/** Public catalog: excludes hidden games */
export function listAllGames(): ListedGame[] {
  const builtin = GAMES.map((g) => ({ ...g, source: "builtin" as const, cover: undefined }));
  const all = withHiddenFlags([...builtin, ...listUserGames()]);
  return all.filter((g) => !g.hidden);
}

/** Admin catalog: includes hidden games */
export function listAllGamesAdmin(): ListedGame[] {
  const builtin = GAMES.map((g) => ({ ...g, source: "builtin" as const, cover: undefined }));
  return withHiddenFlags([...builtin, ...listUserGames()]);
}

export function findGame(gameId: string, opts?: { includeHidden?: boolean }): ListedGame | undefined {
  const list = opts?.includeHidden ? listAllGamesAdmin() : listAllGames();
  return list.find((g) => g.id === gameId);
}

export function isKnownGame(gameId: string, opts?: { includeHidden?: boolean }): boolean {
  return Boolean(findGame(gameId, opts));
}

export function getUserGame(gameId: string): UserGameRow | undefined {
  return db.prepare("SELECT * FROM user_games WHERE id = ?").get(gameId) as UserGameRow | undefined;
}

export type LeftoverCheckStep = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type LeftoverAuditResult = {
  gameId: string;
  clean: boolean;
  steps: LeftoverCheckStep[];
  leftoverCount: number;
};

function countByGame(table: string, gameId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE game_id = ?`).get(gameId) as
    | { c: number }
    | undefined;
  return Number(row?.c || 0);
}

/** 删除后自检：扫描文件与数据库是否仍有该游戏痕迹 */
export function auditUserGameTraces(gameId: string): LeftoverAuditResult {
  if (!isUserGameId(gameId)) {
    return {
      gameId,
      clean: false,
      leftoverCount: 1,
      steps: [{ id: "id", label: "游戏 ID", ok: false, detail: "无效的工坊游戏 ID" }]
    };
  }

  const steps: LeftoverCheckStep[] = [];

  const dir = path.join(uploadsRoot, gameId);
  const dirExists = fs.existsSync(dir);
  steps.push({
    id: "uploads",
    label: "上传文件目录",
    ok: !dirExists,
    detail: dirExists ? `仍存在目录 server/uploads/${gameId}` : "目录已清除"
  });

  const userGame = getUserGame(gameId);
  steps.push({
    id: "user_games",
    label: "游戏库记录",
    ok: !userGame,
    detail: userGame ? `user_games 仍有条目「${userGame.title}」` : "记录已清除"
  });

  const tables: { id: string; label: string; table: string }[] = [
    { id: "favorites", label: "收藏记录", table: "favorites" },
    { id: "scores", label: "积分记录", table: "scores" },
    { id: "score_history", label: "积分历史", table: "score_history" },
    { id: "saves", label: "存档数据", table: "saves" },
    { id: "play_tickets", label: "游玩票据", table: "play_tickets" },
    { id: "hidden_games", label: "隐藏状态", table: "hidden_games" }
  ];
  for (const t of tables) {
    const n = countByGame(t.table, gameId);
    steps.push({
      id: t.id,
      label: t.label,
      ok: n === 0,
      detail: n === 0 ? "无残留" : `仍有 ${n} 条`
    });
  }

  const runtimeAlive = hasUserGameRuntime(gameId);
  steps.push({
    id: "runtime",
    label: "游戏后台进程",
    ok: !runtimeAlive,
    detail: runtimeAlive ? "进程仍在运行" : "未在运行"
  });

  const presenceN = listPresence().filter((s) => s.gameId === gameId).length;
  steps.push({
    id: "presence",
    label: "在线对局会话",
    ok: presenceN === 0,
    detail: presenceN === 0 ? "无活跃会话" : `仍有 ${presenceN} 个会话`
  });

  const leftoverCount = steps.filter((s) => !s.ok).length;
  return { gameId, clean: leftoverCount === 0, steps, leftoverCount };
}

/** 清理残留痕迹（不要求游戏记录仍存在） */
export function purgeUserGameTraces(gameId: string): void {
  if (!isUserGameId(gameId)) return;
  stopUserGameRuntime(gameId);
  clearPresenceByGame(gameId);
  db.prepare("DELETE FROM favorites WHERE game_id = ?").run(gameId);
  db.prepare("DELETE FROM scores WHERE game_id = ?").run(gameId);
  db.prepare("DELETE FROM score_history WHERE game_id = ?").run(gameId);
  db.prepare("DELETE FROM saves WHERE game_id = ?").run(gameId);
  db.prepare("DELETE FROM play_tickets WHERE game_id = ?").run(gameId);
  db.prepare("DELETE FROM hidden_games WHERE game_id = ?").run(gameId);
  db.prepare("DELETE FROM user_games WHERE id = ?").run(gameId);
  fs.rmSync(path.join(uploadsRoot, gameId), { recursive: true, force: true });
}

/**
 * 彻底删除工坊游戏：停进程、清在线会话、删关联数据与上传目录。
 * @returns 是否找到并删除了该游戏记录
 */
export function purgeUserGame(gameId: string): boolean {
  const row = getUserGame(gameId);
  if (!row) return false;
  purgeUserGameTraces(gameId);
  return true;
}

export { GAMES, GAMES as GAME_CATALOG };
