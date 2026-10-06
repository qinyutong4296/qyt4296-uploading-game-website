import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "./db";
import { JwtPayload, PublicUser } from "./types";

const ACCESS_SECRET = process.env.JWT_SECRET || "dev-access-secret-change-me";
const ACCESS_TTL = "15m";
const REFRESH_DAYS = 7;
const TICKET_TTL_MS = 60_000;

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  display_name: string | null;
  avatar: string | null;
  created_at: string;
  last_login_at: string | null;
  is_admin?: number;
};

export const AVATAR_PRESETS = ["玩", "墨", "游", "剑", "棋", "云", "山", "月", "鹤", "竹"] as const;

const AVATAR_PATH_RE = /^\/avatars\/[A-Za-z0-9._-]+$/;

export function isImageAvatar(raw?: string | null): boolean {
  return AVATAR_PATH_RE.test(String(raw || "").trim());
}

export function normalizeAvatar(raw?: string | null): string {
  const v = String(raw || "").trim();
  if (AVATAR_PATH_RE.test(v)) return v;
  // 预设与汉字正则都只匹配单字：必须先截首字，否则「月亮」这类多字输入永远回退「玩」
  const one = v.slice(0, 1);
  if (one && AVATAR_PRESETS.includes(one as (typeof AVATAR_PRESETS)[number])) return one;
  if (one && /^[\u4e00-\u9fff]$/.test(one)) return one;
  return "玩";
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    avatar: normalizeAvatar(row.avatar || (row.display_name || row.username).slice(0, 1)),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    isAdmin: Number(row.is_admin) === 1
  };
}

export function findUserByUsername(username: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
}

export function findUserById(id: number): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function registerUser(username: string, password: string, displayName?: string): PublicUser {
  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(password, 10);
  const name = displayName?.trim() || username;
  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, display_name, avatar, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(username, hash, name, normalizeAvatar(name.slice(0, 1)), now);
  const row = findUserById(Number(info.lastInsertRowid));
  if (!row) throw new Error("Failed to create user");
  return toPublicUser(row);
}

export function updateProfile(userId: number, patch: { displayName?: string; avatar?: string }): PublicUser {
  const row = findUserById(userId);
  if (!row) throw new Error("用户不存在");
  const displayName =
    patch.displayName !== undefined ? String(patch.displayName).trim() : row.display_name || row.username;
  if (displayName.length < 1 || displayName.length > 20) {
    throw new Error("昵称需 1–20 个字");
  }
  const avatar =
    patch.avatar !== undefined ? normalizeAvatar(patch.avatar) : normalizeAvatar(row.avatar);
  db.prepare("UPDATE users SET display_name = ?, avatar = ? WHERE id = ?").run(displayName, avatar, userId);
  const updated = findUserById(userId);
  if (!updated) throw new Error("更新失败");
  return toPublicUser(updated);
}

export function verifyPassword(user: UserRow, password: string): boolean {
  return bcrypt.compareSync(password, user.password_hash);
}

export function signAccessToken(user: UserRow): string {
  const payload: JwtPayload = { userId: user.id, username: user.username };
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}

export function verifyAccessToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, ACCESS_SECRET) as unknown as Partial<JwtPayload> & { sub?: number | string };
  const userId = Number(decoded.userId ?? decoded.sub);
  if (!Number.isFinite(userId) || !decoded.username) {
    throw new Error("invalid token");
  }
  return { userId, username: decoded.username };
}

export function issueRefreshToken(userId: number): string {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    expires
  );
  return token;
}

export function consumeRefreshToken(token: string): UserRow | undefined {
  const row = db
    .prepare("SELECT * FROM refresh_tokens WHERE token = ?")
    .get(token) as { token: string; user_id: number; expires_at: string } | undefined;
  if (!row) return undefined;
  db.prepare("DELETE FROM refresh_tokens WHERE token = ?").run(token);
  if (new Date(row.expires_at).getTime() < Date.now()) return undefined;
  return findUserById(row.user_id);
}

export function revokeRefreshToken(token: string) {
  db.prepare("DELETE FROM refresh_tokens WHERE token = ?").run(token);
}

export function revokeAllRefreshTokens(userId: number) {
  db.prepare("DELETE FROM refresh_tokens WHERE user_id = ?").run(userId);
}

/** 关站 / 重启时清空全部登录会话（刷新令牌、游戏票、迷宫令牌） */
export function revokeAllSessions() {
  db.prepare("DELETE FROM refresh_tokens").run();
  try {
    db.prepare("DELETE FROM play_tickets").run();
  } catch {
    /* ignore */
  }
  try {
    db.prepare("DELETE FROM maze_tokens").run();
  } catch {
    /* ignore */
  }
}

export function findRefreshTokenUserId(token: string): number | undefined {
  const row = db
    .prepare("SELECT user_id FROM refresh_tokens WHERE token = ?")
    .get(token) as { user_id: number } | undefined;
  return row?.user_id;
}

export function touchLogin(userId: number) {
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), userId);
}

export function createPlayTicket(userId: number, gameId: string): string {
  const ticket = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + TICKET_TTL_MS;
  db.prepare(
    `INSERT INTO play_tickets (ticket, user_id, game_id, expires_at, used) VALUES (?, ?, ?, ?, 0)`
  ).run(ticket, userId, gameId, expiresAt);
  return ticket;
}

export function exchangePlayTicket(ticket: string): { user: UserRow; gameId: string } | null {
  const row = db.prepare("SELECT * FROM play_tickets WHERE ticket = ?").get(ticket) as
    | { ticket: string; user_id: number; game_id: string; expires_at: number; used: number }
    | undefined;
  if (!row) return null;
  if (row.used) return null;
  if (row.expires_at < Date.now()) return null;
  db.prepare("UPDATE play_tickets SET used = 1 WHERE ticket = ?").run(ticket);
  const user = findUserById(row.user_id);
  if (!user) return null;
  return { user, gameId: row.game_id };
}

export const REFRESH_COOKIE = "refresh_token";
