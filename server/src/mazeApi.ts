/**
 * 投影回廊账号 / 存档 API
 * - 账号与进度存入合集站 SQLite（跨设备），并兼容迁移旧版 db.json
 * - 合集站已登录时：已绑定则自动发回廊令牌；未绑定则返回 needs_choice
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { findUserById, verifyPassword } from "./auth";
import { db } from "./db";
import { requireAuth } from "./middleware";

const router = Router();

const MAZE_ROOT = path.join(__dirname, "..", "public", "games", "maze");
const DB_JSON_PATH = path.join(MAZE_ROOT, "data", "db.json");

type Progress = {
  unlocked: number;
  records: Record<string, { stars: number; switches: number | null; keys: number }>;
  steles: Record<string, boolean>;
};

type MazeUserRow = {
  username: string;
  salt: string;
  password_hash: string;
  created_at: number;
  hub_user_id: number | null;
};

function emptyProgress(): Progress {
  return { unlocked: 0, records: {}, steles: {} };
}

function hashPassword(password: string, salt: string) {
  return crypto.scryptSync(String(password), salt, 32).toString("hex");
}

function sanitizeProgress(p: unknown): Progress {
  const out = emptyProgress();
  if (!p || typeof p !== "object") return out;
  const src = p as Record<string, unknown>;
  const un = parseInt(String(src.unlocked), 10);
  out.unlocked = Number.isNaN(un) ? 0 : Math.max(0, Math.min(un, 999));
  if (src.records && typeof src.records === "object") {
    for (const k of Object.keys(src.records as object)) {
      const r = (src.records as Record<string, Record<string, unknown>>)[k];
      if (!r || typeof r !== "object") continue;
      const st = parseInt(String(r.stars), 10);
      const sw = parseInt(String(r.switches), 10);
      const ky = parseInt(String(r.keys), 10);
      out.records[String(k).slice(0, 4)] = {
        stars: Number.isNaN(st) ? 0 : Math.max(0, Math.min(st, 3)),
        switches: Number.isNaN(sw) ? null : Math.max(0, Math.min(sw, 9999)),
        keys: Number.isNaN(ky) ? 0 : Math.max(0, Math.min(ky, 99))
      };
    }
  }
  if (src.steles && typeof src.steles === "object") {
    for (const k of Object.keys(src.steles as object)) {
      const id = String(k).slice(0, 32);
      if (!id) continue;
      if ((src.steles as Record<string, unknown>)[k]) out.steles[id] = true;
    }
  }
  return out;
}

function getMazeUser(username: string): MazeUserRow | undefined {
  return db.prepare("SELECT * FROM maze_users WHERE username = ?").get(username) as MazeUserRow | undefined;
}

function getMazeUserByHubId(hubUserId: number): MazeUserRow | undefined {
  return db.prepare("SELECT * FROM maze_users WHERE hub_user_id = ?").get(hubUserId) as MazeUserRow | undefined;
}

function getProgress(username: string): Progress {
  const row = db.prepare("SELECT data_json FROM maze_progress WHERE username = ?").get(username) as
    | { data_json: string }
    | undefined;
  if (!row) return emptyProgress();
  try {
    return sanitizeProgress(JSON.parse(row.data_json));
  } catch {
    return emptyProgress();
  }
}

function setProgress(username: string, progress: Progress) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO maze_progress (username, data_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
  ).run(username, JSON.stringify(progress), now);
}

function createMazeUser(username: string, password: string, hubUserId: number | null = null) {
  const salt = crypto.randomBytes(12).toString("hex");
  const created = Date.now();
  db.prepare(
    `INSERT INTO maze_users (username, salt, password_hash, created_at, hub_user_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(username, salt, hashPassword(password, salt), created, hubUserId);
  setProgress(username, emptyProgress());
  return getMazeUser(username)!;
}

function newToken(username: string) {
  const t = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  db.prepare("INSERT INTO maze_tokens (token, username, created_at) VALUES (?, ?, ?)").run(t, username, now);

  const mine = db
    .prepare("SELECT token FROM maze_tokens WHERE username = ? ORDER BY created_at DESC")
    .all(username) as { token: string }[];
  for (let i = 5; i < mine.length; i++) {
    db.prepare("DELETE FROM maze_tokens WHERE token = ?").run(mine[i].token);
  }
  const MAX_AGE = 30 * 24 * 3600 * 1000;
  db.prepare("DELETE FROM maze_tokens WHERE created_at < ?").run(now - MAX_AGE);
  return t;
}

function userByToken(req: Request) {
  const auth = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  const rec = db.prepare("SELECT username, token FROM maze_tokens WHERE token = ?").get(m[1]) as
    | { username: string; token: string }
    | undefined;
  return rec ? { username: rec.username, token: rec.token } : null;
}

function sessionPayload(username: string, token: string) {
  const u = getMazeUser(username);
  return {
    token,
    user: { username, created: u?.created_at || 0 },
    progress: getProgress(username)
  };
}

function lanIPv4() {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) out.push(item.address);
    }
  }
  return out;
}

function clientIp(req: Request) {
  let ip = req.socket.remoteAddress || "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip || "unknown";
}

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 10;
const rateBuckets = new Map<string, number[]>();

// 定期清理过期限流桶：公网扫描产生大量一次性 IP，不清会缓慢膨胀
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [key, stamps] of rateBuckets) {
    if (!stamps.length || stamps[stamps.length - 1] < cutoff) rateBuckets.delete(key);
  }
}, 5 * 60_000).unref?.();

function checkRateLimit(req: Request, routeKey: string) {
  const key = clientIp(req) + "|" + routeKey;
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  let stamps = rateBuckets.get(key) || [];
  stamps = stamps.filter((t) => t > cutoff);
  if (stamps.length >= RATE_MAX) {
    rateBuckets.set(key, stamps);
    const retryAfter = Math.max(1, Math.ceil((stamps[0] + RATE_WINDOW_MS - now) / 1000));
    return { limited: true as const, retryAfter };
  }
  stamps.push(now);
  rateBuckets.set(key, stamps);
  return { limited: false as const };
}

function sendRateLimited(res: Response, retryAfter: number) {
  res.setHeader("Retry-After", String(retryAfter));
  res.status(429).json({ ok: false, error: "请求过于频繁，请稍后再试" });
}

function validMazeUsername(username: string) {
  return /^[\u4e00-\u9fa5A-Za-z0-9_]{2,20}$/.test(username);
}

/** 把旧 db.json 迁入 SQLite（只迁一次：目标库尚无该用户时） */
export function migrateMazeJsonToSqlite() {
  try {
    if (!fs.existsSync(DB_JSON_PATH)) return;
    const raw = fs.readFileSync(DB_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw) as {
      users?: Record<string, { salt: string; hash: string; created: number }>;
      tokens?: Record<string, { user: string; created: number }>;
      progress?: Record<string, Progress>;
    };
    const users = parsed.users || {};
    for (const [username, u] of Object.entries(users)) {
      if (getMazeUser(username)) continue;
      db.prepare(
        `INSERT INTO maze_users (username, salt, password_hash, created_at, hub_user_id)
         VALUES (?, ?, ?, ?, NULL)`
      ).run(username, u.salt, u.hash, u.created || Date.now());
      const prog = sanitizeProgress(parsed.progress?.[username]);
      setProgress(username, prog);
    }
    for (const [token, rec] of Object.entries(parsed.tokens || {})) {
      if (!rec?.user || !getMazeUser(rec.user)) continue;
      const exists = db.prepare("SELECT token FROM maze_tokens WHERE token = ?").get(token);
      if (exists) continue;
      db.prepare("INSERT INTO maze_tokens (token, username, created_at) VALUES (?, ?, ?)").run(
        token,
        rec.user,
        rec.created || Date.now()
      );
    }
  } catch (e) {
    console.error("[maze-api] 迁移 db.json 失败:", e instanceof Error ? e.message : e);
  }
}

router.get("/ping", (_req, res) => {
  res.json({
    ok: true,
    server: "perspective-corridor",
    mode: "online",
    time: Date.now(),
    hub: true,
    storage: "sqlite"
  });
});

router.get("/lan", (_req, res) => {
  const ips = lanIPv4();
  const port = Number(process.env.PORT || 8080);
  res.json({
    ok: true,
    port,
    prefer: ips[0] ? `http://${ips[0]}:${port}/games/maze/index.html?hub=1` : "",
    urls: ips.map((ip) => `http://${ip}:${port}/games/maze/index.html?hub=1`)
  });
});

router.post("/register", (req, res) => {
  const rl = checkRateLimit(req, "register");
  if (rl.limited) return sendRateLimited(res, rl.retryAfter);
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!validMazeUsername(username)) {
    res.status(400).json({ ok: false, error: "用户名需为 2~20 位中文、字母、数字或下划线" });
    return;
  }
  if (password.length < 4 || password.length > 64) {
    res.status(400).json({ ok: false, error: "密码长度需在 4~64 位之间" });
    return;
  }
  if (getMazeUser(username)) {
    res.status(409).json({ ok: false, error: "用户名已被占用，换一个试试" });
    return;
  }
  createMazeUser(username, password, null);
  const token = newToken(username);
  res.json({ ok: true, ...sessionPayload(username, token) });
});

router.post("/login", (req, res) => {
  const rl = checkRateLimit(req, "login");
  if (rl.limited) return sendRateLimited(res, rl.retryAfter);
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const u = getMazeUser(username);
  if (!u) {
    res.status(401).json({ ok: false, error: "用户名或密码不正确" });
    return;
  }
  const hash = hashPassword(password, u.salt);
  const ok =
    hash.length === u.password_hash.length &&
    crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.password_hash));
  if (!ok) {
    res.status(401).json({ ok: false, error: "用户名或密码不正确" });
    return;
  }
  const token = newToken(username);
  res.json({ ok: true, ...sessionPayload(username, token) });
});

router.get("/me", (req, res) => {
  const t = userByToken(req);
  if (!t) {
    res.status(401).json({ ok: false, error: "登录态已失效" });
    return;
  }
  const u = getMazeUser(t.username);
  res.json({
    ok: true,
    user: { username: t.username, created: u ? u.created_at : 0 },
    progress: getProgress(t.username)
  });
});

router.get("/progress", (req, res) => {
  const t = userByToken(req);
  if (!t) {
    res.status(401).json({ ok: false, error: "登录态已失效" });
    return;
  }
  res.json({ ok: true, progress: getProgress(t.username) });
});

router.post("/progress", (req, res) => {
  const t = userByToken(req);
  if (!t) {
    res.status(401).json({ ok: false, error: "登录态已失效" });
    return;
  }
  setProgress(t.username, sanitizeProgress(req.body?.progress));
  res.json({ ok: true });
});

router.post("/logout", (req, res) => {
  const t = userByToken(req);
  if (t) {
    db.prepare("DELETE FROM maze_tokens WHERE token = ?").run(t.token);
  }
  res.json({ ok: true });
});

router.post("/shutdown", (_req, res) => {
  res.json({ ok: true, ignored: true, reason: "hub" });
});

router.post("/shutdown-cancel", (_req, res) => {
  res.json({ ok: true, cancelled: false, ignored: true, reason: "hub" });
});

/** 合集站会话：是否已绑定回廊账号 */
router.get("/maze-hub/status", requireAuth, (req, res) => {
  const hubId = req.userId!;
  const hub = req.user!;
  const linked = getMazeUserByHubId(hubId);
  if (linked) {
    const token = newToken(linked.username);
    res.json({
      ok: true,
      status: "linked",
      ...sessionPayload(linked.username, token),
      hubUsername: hub.username,
      hubDisplayName: hub.displayName
    });
    return;
  }
  const hubName = hub.username;
  const taken = Boolean(getMazeUser(hubName));
  res.json({
    ok: true,
    status: "needs_choice",
    hubUsername: hub.username,
    hubDisplayName: hub.displayName,
    suggestedMazeUsername: hubName,
    hubUsernameAvailable: !taken
  });
});

/**
 * 用合集站账号密码注册/绑定回廊账号
 * body: { password, mazeUsername? }
 */
router.post("/maze-hub/use-hub", requireAuth, (req, res) => {
  const rl = checkRateLimit(req, "maze-hub-use");
  if (rl.limited) return sendRateLimited(res, rl.retryAfter);

  const hubId = req.userId!;
  const hub = req.user!;
  const password = String(req.body?.password || "");
  const mazeUsername = String(req.body?.mazeUsername || hub.username).trim();

  if (password.length < 4) {
    res.status(400).json({ ok: false, error: "请输入合集站登录密码以完成绑定" });
    return;
  }

  const hubRow = findUserById(hubId);
  if (!hubRow || !verifyPassword(hubRow, password)) {
    res.status(401).json({ ok: false, error: "合集站密码不正确" });
    return;
  }

  const existingLink = getMazeUserByHubId(hubId);
  if (existingLink) {
    const token = newToken(existingLink.username);
    res.json({ ok: true, status: "linked", ...sessionPayload(existingLink.username, token) });
    return;
  }

  if (!validMazeUsername(mazeUsername)) {
    res.status(400).json({ ok: false, error: "回廊用户名需为 2~20 位中文、字母、数字或下划线" });
    return;
  }

  const occupied = getMazeUser(mazeUsername);
  if (occupied) {
    const hash = hashPassword(password, occupied.salt);
    const match =
      hash.length === occupied.password_hash.length &&
      crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(occupied.password_hash));
    if (match && occupied.hub_user_id == null) {
      db.prepare("UPDATE maze_users SET hub_user_id = ? WHERE username = ?").run(hubId, mazeUsername);
      const token = newToken(mazeUsername);
      res.json({ ok: true, status: "linked", ...sessionPayload(mazeUsername, token) });
      return;
    }
    if (occupied.hub_user_id != null && occupied.hub_user_id !== hubId) {
      res.status(409).json({ ok: false, error: "该回廊用户名已被其他合集站账号绑定，请另选名称" });
      return;
    }
    res.status(409).json({
      ok: false,
      error: "回廊用户名已被占用。可换一个名称，或改用「自行注册新账号」"
    });
    return;
  }

  createMazeUser(mazeUsername, password, hubId);
  const token = newToken(mazeUsername);
  res.json({ ok: true, status: "linked", ...sessionPayload(mazeUsername, token) });
});

/**
 * 自行输入账号密码注册回廊账号，并绑定当前合集站用户
 * body: { username, password }
 */
router.post("/maze-hub/register-new", requireAuth, (req, res) => {
  const rl = checkRateLimit(req, "maze-hub-reg");
  if (rl.limited) return sendRateLimited(res, rl.retryAfter);

  const hubId = req.userId!;
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (getMazeUserByHubId(hubId)) {
    res.status(409).json({ ok: false, error: "已绑定回廊账号，请直接进入" });
    return;
  }
  if (!validMazeUsername(username)) {
    res.status(400).json({ ok: false, error: "用户名需为 2~20 位中文、字母、数字或下划线" });
    return;
  }
  if (password.length < 4 || password.length > 64) {
    res.status(400).json({ ok: false, error: "密码长度需在 4~64 位之间" });
    return;
  }
  if (getMazeUser(username)) {
    res.status(409).json({ ok: false, error: "用户名已被占用，换一个试试" });
    return;
  }

  createMazeUser(username, password, hubId);
  const token = newToken(username);
  res.json({ ok: true, status: "linked", ...sessionPayload(username, token) });
});

export function mountMazeApi(app: import("express").Express) {
  app.use("/api", router);
}

export default router;
