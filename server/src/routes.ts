/**
 * 全部 API 路由（原 src/routes/*.ts 合并而来，逻辑保持一致）。
 */

import AdmZip from "adm-zip";
import crypto from "node:crypto";
import fs from "node:fs";
import iconv from "iconv-lite";
import multer from "multer";
import path from "node:path";
import {
  AVATAR_PRESETS,
  REFRESH_COOKIE,
  consumeRefreshToken,
  createPlayTicket,
  exchangePlayTicket,
  findRefreshTokenUserId,
  findUserById,
  findUserByUsername,
  isImageAvatar,
  issueRefreshToken,
  normalizeAvatar,
  registerUser,
  revokeAllRefreshTokens,
  revokeRefreshToken,
  signAccessToken,
  toPublicUser,
  touchLogin,
  updateProfile,
  verifyAccessToken,
  verifyPassword
} from "./auth";
import {
  GAMES,
  auditUserGameTraces,
  findGame,
  getUserGame,
  hideGame,
  isKnownGame,
  isUserGameId,
  listAllGames,
  listAllGamesAdmin,
  purgeUserGame,
  purgeUserGameTraces,
  unhideGame
} from "./catalog";
import {
  cleanupFlattenArtifacts,
  detectLaunchPlan,
  ensureUserGameRuntime,
  flattenNestedGameRoot,
  prepareUserGameDeps,
  resolveGameRoot,
  userGameNeedsBackend
} from "./userGameRuntime";
import { NextFunction, Request, Response, Router } from "express";
import { addAdminSseClient, publishAdminEvent } from "./adminEvents";
import { db } from "./db";
import { getPresence, heartbeatPresence, kickPresence, leavePresence, listPresence, onlineCount, startPresence } from "./presence";
import { optionalAuth, requireAdmin, requireAuth } from "./middleware";

// ============================================================
// auth.ts
// ============================================================

const authRouter = Router();

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
/** 关页后延迟退出：刷新会在延迟内取消，真正关闭才会生效 */
const LEAVE_LOGOUT_DELAY_MS = 2500;
const pendingLeaveLogouts = new Map<number, ReturnType<typeof setTimeout>>();

function resolveUserIdFromRequest(req: import("express").Request): number | undefined {
  const cookieToken = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  let userId = cookieToken ? findRefreshTokenUserId(cookieToken) : undefined;

  const auth = String(req.headers.authorization || "");
  if (auth.startsWith("Bearer ")) {
    try {
      userId = verifyAccessToken(auth.slice(7)).userId;
    } catch {
      /* ignore */
    }
  }

  const bodyToken = req.body?.accessToken ? String(req.body.accessToken) : "";
  if (bodyToken) {
    try {
      userId = verifyAccessToken(bodyToken).userId;
    } catch {
      /* ignore */
    }
  }

  return userId;
}

function scheduleLeaveLogout(userId: number) {
  const prev = pendingLeaveLogouts.get(userId);
  if (prev) clearTimeout(prev);
  pendingLeaveLogouts.set(
    userId,
    setTimeout(() => {
      pendingLeaveLogouts.delete(userId);
      revokeAllRefreshTokens(userId);
    }, LEAVE_LOGOUT_DELAY_MS)
  );
}

function cancelLeaveLogout(userId: number): boolean {
  const timer = pendingLeaveLogouts.get(userId);
  if (!timer) return false;
  clearTimeout(timer);
  pendingLeaveLogouts.delete(userId);
  return true;
}

const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: false,
  path: "/"
};

function setRefreshCookie(res: import("express").Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    ...REFRESH_COOKIE_OPTS,
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function clearRefreshCookie(res: import("express").Response) {
  // 选项必须与 setCookie 一致，否则部分浏览器不会真正删掉 cookie
  res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTS);
}

authRouter.post("/register", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const displayName = req.body?.displayName ? String(req.body.displayName) : undefined;

  if (!USERNAME_RE.test(username)) {
    res.status(400).json({ error: "用户名需 3-20 位字母、数字或下划线" });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "密码至少 6 位" });
    return;
  }
  // 与 updateProfile 的昵称规则保持一致，避免注册时写入超长昵称
  if (displayName !== undefined && (displayName.trim().length < 1 || displayName.trim().length > 20)) {
    res.status(400).json({ error: "昵称需 1–20 个字" });
    return;
  }
  if (findUserByUsername(username)) {
    res.status(409).json({ error: "用户名已被占用" });
    return;
  }

  const user = registerUser(username, password, displayName);
  const row = findUserByUsername(username)!;
  touchLogin(row.id);
  const accessToken = signAccessToken(row);
  setRefreshCookie(res, issueRefreshToken(row.id));
  res.status(201).json({ user, accessToken });
});

authRouter.post("/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const row = findUserByUsername(username);
  if (!row || !verifyPassword(row, password)) {
    res.status(401).json({ error: "用户名或密码错误" });
    return;
  }
  touchLogin(row.id);
  const updated = findUserByUsername(username)!;
  const accessToken = signAccessToken(updated);
  setRefreshCookie(res, issueRefreshToken(updated.id));
  res.json({ user: toPublicUser(updated), accessToken });
});

authRouter.post("/logout", (req, res) => {
  const cookieToken = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  const userId = resolveUserIdFromRequest(req);
  if (userId != null) {
    cancelLeaveLogout(userId);
    revokeAllRefreshTokens(userId);
  } else if (cookieToken) {
    revokeRefreshToken(cookieToken);
  }

  clearRefreshCookie(res);
  res.json({ ok: true });
});

/** 关闭网页时调用（sendBeacon）：延迟撤销会话；刷新会走 cancel */
authRouter.post("/logout-on-leave", (req, res) => {
  const userId = resolveUserIdFromRequest(req);
  if (userId != null) scheduleLeaveLogout(userId);
  // 不在这里 clearCookie：刷新时 beacon 若清掉 cookie，新页无法续期
  res.json({ ok: true, scheduled: userId != null });
});

/** 刷新 / 其它标签页仍在时取消「关页退出」 */
authRouter.post("/logout-on-leave-cancel", (req, res) => {
  const userId = resolveUserIdFromRequest(req);
  const cancelled = userId != null ? cancelLeaveLogout(userId) : false;
  res.json({ ok: true, cancelled });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

authRouter.get("/verify", requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

authRouter.post("/verify", requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

authRouter.post("/refresh", (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) {
    res.status(401).json({ error: "未登录或登录已过期" });
    return;
  }
  const user = consumeRefreshToken(token);
  if (!user) {
    clearRefreshCookie(res);
    res.status(401).json({ error: "未登录或登录已过期" });
    return;
  }
  setRefreshCookie(res, issueRefreshToken(user.id));
  res.json({ user: toPublicUser(user), accessToken: signAccessToken(user) });
});

authRouter.post("/exchange-ticket", (req, res) => {
  const ticket = String(req.body?.ticket || "");
  if (!ticket) {
    res.status(400).json({ error: "缺少 ticket" });
    return;
  }
  const result = exchangePlayTicket(ticket);
  if (!result) {
    res.status(401).json({ error: "游戏会话无效或已过期" });
    return;
  }
  const accessToken = signAccessToken(result.user);
  res.json({
    user: toPublicUser(result.user),
    accessToken,
    gameId: result.gameId
  });
});



// ============================================================
// games.ts
// ============================================================

const gamesRouter = Router();

gamesRouter.get("/", optionalAuth, (req, res) => {
  const userId = req.userId;
  const scoreRows = userId
    ? (db.prepare("SELECT game_id, score FROM scores WHERE user_id = ?").all(userId) as {
        game_id: string;
        score: number;
      }[])
    : [];
  const saveRows = userId
    ? (db.prepare("SELECT game_id FROM saves WHERE user_id = ?").all(userId) as { game_id: string }[])
    : [];
  const favRows = userId
    ? (db.prepare("SELECT game_id FROM favorites WHERE user_id = ?").all(userId) as { game_id: string }[])
    : [];
  const scoreMap = new Map(scoreRows.map((r) => [r.game_id, r.score]));
  const saveSet = new Set(saveRows.map((r) => r.game_id));
  const favSet = new Set(favRows.map((r) => r.game_id));

  res.json({
    games: listAllGames().map((g) => ({
      ...g,
      summary: g.description,
      myHighScore: scoreMap.get(g.id) ?? null,
      hasSave: saveSet.has(g.id),
      favorited: favSet.has(g.id)
    }))
  });
});

gamesRouter.post("/:gameId/presence", requireAuth, (req, res) => {
  const gameId = String(req.params.gameId);
  const game = findGame(gameId);
  if (!game) {
    res.status(404).json({ error: "未知游戏" });
    return;
  }
  const session = startPresence({
    userId: req.userId!,
    username: req.user!.username,
    displayName: req.user!.displayName,
    gameId,
    gameName: game.name
  });
  res.json({ sessionId: session.sessionId, session });
});

gamesRouter.post("/presence/:sessionId/heartbeat", requireAuth, (req, res) => {
  const sessionId = String(req.params.sessionId);
  // 先校验归属再消费 kicked 标志：否则知道 sessionId 的第三方心跳会替本人「消耗」掉被踢状态
  const existing = getPresence(sessionId);
  if (existing && existing.userId !== req.userId) {
    res.status(403).json({ error: "无权操作该会话" });
    return;
  }
  const result = heartbeatPresence(sessionId);
  if (result === "kicked") {
    res.status(403).json({ error: "已被管理员结束本局", code: "kicked" });
    return;
  }
  if (!result) {
    res.status(404).json({ error: "会话不存在或已过期" });
    return;
  }
  res.json({ ok: true, session: result });
});

gamesRouter.delete("/presence/:sessionId", requireAuth, (req, res) => {
  const sessionId = String(req.params.sessionId);
  const existing = getPresence(sessionId);
  if (existing && existing.userId !== req.userId) {
    res.status(403).json({ error: "无权操作该会话" });
    return;
  }
  leavePresence(sessionId);
  res.json({ ok: true });
});

gamesRouter.get("/:gameId", optionalAuth, (req, res) => {
  const game = findGame(String(req.params.gameId));
  if (!game) {
    res.status(404).json({ error: "未知游戏" });
    return;
  }
  res.json({ game });
});

gamesRouter.post("/:gameId/session", requireAuth, (req, res) => {
  const gameId = String(req.params.gameId);
  if (!isKnownGame(gameId)) {
    res.status(404).json({ error: "未知游戏" });
    return;
  }
  const playTicket = createPlayTicket(req.userId!, gameId);
  res.json({ playTicket, gameId, expiresIn: 60 });
});



// ============================================================
// scores.ts
// ============================================================

const scoresRouter = Router();

scoresRouter.get("/:gameId", optionalAuth, (req, res) => {
  const gameId = String(req.params.gameId);
  if (!isKnownGame(gameId)) {
    res.status(404).json({ error: "未知游戏" });
    return;
  }
  const rows = db
    .prepare(
      `SELECT s.score, s.updated_at, u.username, u.display_name
       FROM scores s
       JOIN users u ON u.id = s.user_id
       WHERE s.game_id = ?
       ORDER BY s.score DESC, s.updated_at ASC
       LIMIT 20`
    )
    .all(gameId) as {
    score: number;
    updated_at: string;
    username: string;
    display_name: string | null;
  }[];

  const ranking = rows.map((r, i) => ({
    rank: i + 1,
    username: r.username,
    displayName: r.display_name || r.username,
    score: r.score,
    updatedAt: r.updated_at
  }));

  // 玩家本人的历史最佳：不能让客户端去 Top-20 里找自己（挤不进前 20 会误判为无成绩）
  let myScore: number | null = null;
  if (req.userId) {
    const mine = db
      .prepare("SELECT score FROM scores WHERE user_id = ? AND game_id = ?")
      .get(req.userId, gameId) as { score: number } | undefined;
    myScore = mine ? Number(mine.score) : null;
  }

  res.json({ gameId, ranking, leaderboard: ranking, myScore });
});

scoresRouter.post("/:gameId", requireAuth, (req, res) => {
  const gameId = String(req.params.gameId);
  if (!isKnownGame(gameId)) {
    res.status(404).json({ error: "未知游戏" });
    return;
  }
  const score = Number(req.body?.score);
  if (!Number.isFinite(score) || score < 0) {
    res.status(400).json({ error: "无效分数" });
    return;
  }

  const userId = req.userId!;
  const now = new Date().toISOString();
  // 比较与存储都必须用取整后的值：否则 100.5 > 100 成立但存进去还是 100，
  // 之后每次提交 100.0~100.9 都会误报「新纪录」并刷新排序时间戳
  const floored = Math.floor(score);
  const current = db
    .prepare("SELECT score FROM scores WHERE user_id = ? AND game_id = ?")
    .get(userId, gameId) as { score: number } | undefined;

  const isHigh = !current || floored > Number(current.score);
  if (isHigh) {
    db.prepare(
      `INSERT INTO scores (user_id, game_id, score, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, game_id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`
    ).run(userId, gameId, floored, now);
  }

  db.prepare(`INSERT INTO score_history (user_id, game_id, score, created_at) VALUES (?, ?, ?, ?)`).run(
    userId,
    gameId,
    floored,
    now
  );

  const extra = db
    .prepare(
      `SELECT id FROM score_history WHERE user_id = ? AND game_id = ? ORDER BY id DESC LIMIT -1 OFFSET 20`
    )
    .all(userId, gameId) as { id: number }[];
  if (extra.length) {
    const ids = extra.map((r) => r.id);
    db.prepare(`DELETE FROM score_history WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  }

  const best = db
    .prepare("SELECT score FROM scores WHERE user_id = ? AND game_id = ?")
    .get(userId, gameId) as { score: number } | undefined;

  publishAdminEvent("score.submitted", {
    userId,
    username: req.user?.username,
    displayName: req.user?.displayName,
    gameId,
    score: floored,
    isNewHigh: isHigh,
    at: now
  });

  res.json({ ok: true, highScore: best?.score ?? floored, isNewHigh: isHigh });
});



// ============================================================
// saves.ts
// ============================================================

const savesRouter = Router();
const MAX_BYTES = 64 * 1024;

savesRouter.get("/:gameId", requireAuth, (req, res) => {
  const gameId = String(req.params.gameId);
  if (!isKnownGame(gameId)) {
    res.status(404).json({ error: "未知游戏" });
    return;
  }
  const row = db
    .prepare("SELECT data_json, updated_at FROM saves WHERE user_id = ? AND game_id = ?")
    .get(req.userId, gameId) as { data_json: string; updated_at: string } | undefined;
  if (!row) {
    res.json({ save: null });
    return;
  }
  // 存档数据损坏时返回空档而不是 500：500 会让该游戏在此用户下永远无法进入
  let save: unknown = null;
  try {
    save = JSON.parse(row.data_json);
  } catch {
    console.warn(`[saves] 用户 ${req.userId} 的 ${gameId} 存档损坏，已按空档处理`);
  }
  res.json({ save, updatedAt: row.updated_at });
});

savesRouter.put("/:gameId", requireAuth, (req, res) => {
  const gameId = String(req.params.gameId);
  if (!isKnownGame(gameId)) {
    res.status(404).json({ error: "未知游戏" });
    return;
  }
  const data = req.body?.data;
  if (data === undefined) {
    res.status(400).json({ error: "缺少存档数据" });
    return;
  }
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json, "utf8") > MAX_BYTES) {
    res.status(413).json({ error: "存档超过 64KB 限制" });
    return;
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO saves (user_id, game_id, data_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, game_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
  ).run(req.userId, gameId, json, now);
  res.json({ ok: true, updatedAt: now });
});



// ============================================================
// workshop.ts
// ============================================================

const workshopRouter = Router();
/** Max files extracted from a zip / folder tree (not multipart parts). */
const MAX_FILES = 50000;
/** 单个上传文件上限：超大包请自行压缩；zip 解压总量另有上限 */
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
/** zip 解压后累计字节上限（防高压缩比 zip 炸弹把内存打爆） */
const MAX_EXTRACTED_BYTES = 800 * 1024 * 1024;
const tmpRoot = path.join(__dirname, "..", "uploads", "_tmp");

const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      fs.mkdirSync(tmpRoot, { recursive: true });
      cb(null, tmpRoot);
    },
    filename(_req, file, cb) {
      const safe = path.basename(file.originalname || "upload").replace(/[^\w.\u4e00-\u9fff-]+/g, "_").slice(0, 80);
      cb(null, `${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${safe}`);
    }
  }),
  // 文件先落磁盘再处理（不占请求内存），但仍需上限防磁盘被塞满
  limits: { files: 100, fileSize: MAX_UPLOAD_BYTES }
});

export const uploadsRoot = path.join(__dirname, "..", "uploads");

function readUploadedBytes(file: Express.Multer.File): Buffer {
  if (file.buffer?.length) return file.buffer;
  if (file.path && fs.existsSync(file.path)) return fs.readFileSync(file.path);
  return Buffer.alloc(0);
}

function cleanupUploaded(files: Express.Multer.File[]) {
  for (const f of files) {
    if (!f.path) continue;
    try {
      fs.unlinkSync(f.path);
    } catch {
      /* ignore */
    }
  }
}

const ALLOWED = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".json",
  ".mp3",
  ".wav",
  ".ogg",
  ".woff2",
  ".ttf",
  ".txt",
  ".ico",
  ".mjs",
  ".cjs",
  ".map",
  ".wasm",
  ".mp4",
  ".webm",
  ".woff",
  ".otf",
  ".glb",
  ".gltf",
  ".bin",
  // 保留启动脚本：主界面打开游戏时由合集站自动执行 start.bat
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  // 后端游戏常见数据/配置（不含可执行二进制）
  ".db",
  ".sqlite",
  ".sqlite3",
  ".db-shm",
  ".db-wal",
  ".py",
  ".md",
  ".csv",
  ".tsv",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini"
]);

const SDK_JS = fs.readFileSync(path.join(__dirname, "..", "public", "hub-sdk.js"), "utf8");
const SDK_TAG = `<script>${SDK_JS}</script>`;

/** Typical UTF-8 Chinese misread as GBK, then re-saved as UTF-8. */
const MOJIBAKE_HINT = /鐐瑰|鍒嗘|姝ｅ|鐜╁|鈥|寰楀|璇嗗|鏈/;

function looksLikeUtf8(buf: Buffer) {
  try {
    const t = buf.toString("utf8");
    return !t.includes("\uFFFD");
  } catch {
    return false;
  }
}

function chineseRatio(text: string) {
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const weird = (text.match(/[\u0080-\u00ff]/g) || []).length;
  return chinese - weird * 0.5;
}

/** Decode uploaded HTML text: UTF-8, GBK, or repair double-encoded mojibake. */
export function decodeUploadedText(buf: Buffer): string {
  let raw = buf;
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    raw = raw.subarray(3);
  }

  const asUtf8 = raw.toString("utf8");
  if (MOJIBAKE_HINT.test(asUtf8)) {
    try {
      const repaired = iconv.decode(iconv.encode(asUtf8, "gbk"), "utf8");
      if (!MOJIBAKE_HINT.test(repaired) && chineseRatio(repaired) >= chineseRatio(asUtf8)) {
        return repaired;
      }
    } catch {
      /* keep trying */
    }
  }

  if (looksLikeUtf8(raw) && !MOJIBAKE_HINT.test(asUtf8)) {
    return asUtf8;
  }

  const asGbk = iconv.decode(raw, "gbk");
  if (chineseRatio(asGbk) > chineseRatio(asUtf8)) return asGbk;
  return asUtf8;
}

function ensureUtf8Meta(html: string) {
  if (/<meta[^>]+charset\s*=/i.test(html)) {
    return html.replace(
      /<meta[^>]+charset\s*=\s*["']?[^"'\s>]+["']?[^>]*>/i,
      '<meta charset="UTF-8" />'
    );
  }
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n    <meta charset="UTF-8" />`);
  }
  return `<meta charset="UTF-8" />\n${html}`;
}

function safeRel(name: string) {
  const norm = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm.includes("..") || path.isAbsolute(name)) return null;
  if (norm.startsWith("__MACOSX/") || norm.endsWith(".DS_Store")) return null;
  if (norm.split("/").includes("node_modules") || norm.split("/").includes(".git")) return null;
  return norm;
}

function injectSdk(html: string) {
  let out = ensureUtf8Meta(html);
  if (out.includes("hub-sdk.js") || out.includes("GameHub")) return out;
  if (/<head[^>]*>/i.test(out)) return out.replace(/<head[^>]*>/i, (m) => `${m}\n${SDK_TAG}`);
  return `${SDK_TAG}\n${out}`;
}

function writeHtml(dir: string, filename: string, html: string) {
  fs.writeFileSync(path.join(dir, filename), injectSdk(html), { encoding: "utf8" });
}

function walkFiles(root: string, base = ""): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  for (const name of fs.readdirSync(root)) {
    const abs = path.join(root, name);
    const rel = base ? `${base}/${name}` : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".git" || name === "__MACOSX") continue;
      out.push(...walkFiles(abs, rel));
    } else {
      out.push(rel.replace(/\\/g, "/"));
    }
  }
  return out;
}

const ENTRY_NAMES = [
  "index.html",
  "index.htm",
  "main.html",
  "game.html",
  "play.html",
  "start.html",
  "home.html",
  "default.html"
];

/** Common build output folders that often hold the real entry page. */
const ENTRY_DIRS = ["dist", "build", "www", "public", "out", "web", "docs"];

const LAUNCH_NAME_RE = /打开|开始|启动|进入|首页|主页|index|main|game|play|start|home|default/i;

function scoreEntryCandidate(rel: string): number {
  const base = path.basename(rel);
  const lower = rel.toLowerCase();
  let score = 0;
  if (ENTRY_NAMES.includes(base.toLowerCase())) score += 80;
  if (LAUNCH_NAME_RE.test(base)) score += 40;
  if (!rel.includes("/")) score += 30;
  for (let i = 0; i < ENTRY_DIRS.length; i++) {
    if (lower.startsWith(`${ENTRY_DIRS[i]}/`)) {
      score += 25 - i;
      break;
    }
  }
  score -= rel.split("/").length * 3;
  return score;
}

/** Auto-detect how to open the uploaded game folder. */
export function detectEntryFile(dir: string): string {
  const files = walkFiles(dir);
  const htmls = files.filter((f) => /\.(html?|HTML?)$/.test(f));
  if (!htmls.length) throw new Error("文件夹里没有可打开的 .html 页面");

  const lowerMap = new Map(htmls.map((f) => [f.toLowerCase(), f]));

  // 带自有登录页的后端游戏：优先 login.html
  const hasBackendMarkers =
    fs.existsSync(path.join(dir, "package.json")) ||
    fs.existsSync(path.join(dir, "server.js")) ||
    fs.existsSync(path.join(dir, "start.bat")) ||
    fs.existsSync(path.join(dir, "start.cmd"));
  if (hasBackendMarkers) {
    const loginHit = lowerMap.get("login.html") || lowerMap.get("login.htm");
    if (loginHit) return loginHit;
  }

  for (const name of ENTRY_NAMES) {
    const hit = lowerMap.get(name);
    if (hit) return hit;
  }

  for (const folder of ENTRY_DIRS) {
    for (const name of ENTRY_NAMES) {
      const hit = lowerMap.get(`${folder}/${name}`);
      if (hit) return hit;
    }
  }

  const pkgPath = path.join(dir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        main?: string;
        browser?: string;
        start?: string;
        homepage?: string;
        scripts?: { start?: string };
      };
      for (const cand of [pkg.main, pkg.browser, pkg.start, pkg.homepage]) {
        if (!cand) continue;
        const rel = safeRel(String(cand).replace(/^\.\//, "").replace(/^\//, ""));
        if (!rel) continue;
        if (lowerMap.has(rel.toLowerCase())) return lowerMap.get(rel.toLowerCase())!;
        if (/\.html?$/i.test(rel) && fs.existsSync(path.join(dir, rel))) return rel;
      }
      const startScript = pkg.scripts?.start;
      if (startScript) {
        const m = String(startScript).match(/([\w./\\-]+\.html?)/i);
        if (m) {
          const rel = safeRel(m[1].replace(/^\.\//, ""));
          if (rel && lowerMap.has(rel.toLowerCase())) return lowerMap.get(rel.toLowerCase())!;
        }
      }
    } catch {
      /* ignore bad package.json */
    }
  }

  const ranked = [...htmls].sort(
    (a, b) => scoreEntryCandidate(b) - scoreEntryCandidate(a) || a.localeCompare(b)
  );
  return ranked[0];
}

function multerUpload(req: Request, res: Response, next: NextFunction) {
  upload.array("files", 100)(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      // 出错时 multer 不会自动清理已落盘的临时文件，必须手动清
      cleanupUploaded((req.files || []) as Express.Multer.File[]);
      if (err.code === "LIMIT_FILE_COUNT") {
        res.status(400).json({
          error: "文件过多。请选择整个游戏文件夹（网站会自动打包成 zip 再上传），或先自行打成 zip"
        });
        return;
      }
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(400).json({ error: `单个文件超过 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限` });
        return;
      }
      res.status(400).json({ error: `上传失败：${err.message}` });
      return;
    }
    if (err) {
      cleanupUploaded((req.files || []) as Express.Multer.File[]);
      res.status(400).json({ error: err instanceof Error ? err.message : "上传失败" });
      return;
    }
    next();
  });
}

function yieldEventLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** 从 zip 逐条解压并让出事件循环，避免大包卡住 /api/health 导致启动终端被误关。 */
async function extractZipEntries(zipPathOrBuf: string | Buffer): Promise<{ rel: string; data: Buffer }[]> {
  const zip = typeof zipPathOrBuf === "string" ? new AdmZip(zipPathOrBuf) : new AdmZip(zipPathOrBuf);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length > MAX_FILES) throw new Error(`文件过多（最多 ${MAX_FILES} 个）`);
  const out: { rel: string; data: Buffer }[] = [];
  let totalBytes = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const rel = safeRel(e.entryName);
    if (rel) {
      const data = e.getData();
      totalBytes += data.length;
      // 高压缩比 zip（zip 炸弹）解压后可能膨胀数十 GB，必须设总量上限
      if (totalBytes > MAX_EXTRACTED_BYTES) {
        throw new Error(`解压后的文件总体积超过 ${Math.floor(MAX_EXTRACTED_BYTES / 1024 / 1024)}MB 上限`);
      }
      out.push({ rel, data });
    }
    if ((i + 1) % 20 === 0) await yieldEventLoop();
  }
  return out;
}

async function persistTree(dir: string, items: { rel: string; data: Buffer }[]): Promise<string> {
  if (items.length === 0) throw new Error("文件夹是空的");
  if (items.length > MAX_FILES) throw new Error(`文件过多（最多 ${MAX_FILES} 个）`);
  const prefix = commonRoot(items.map((x) => x.rel));
  // 自带 Node 后端 / start.bat 的包：不要注入合集站 SDK（会干扰游戏内登录页 CSP）
  const looksBackend = items.some((item) => {
    const base = path.basename(prefix ? item.rel.slice(prefix.length) : item.rel).toLowerCase();
    return (
      base === "package.json" ||
      base === "server.js" ||
      base === "app.js" ||
      base === "start.bat" ||
      base === "start.cmd"
    );
  });
  let written = 0;
  for (const item of items) {
    const cut = prefix ? item.rel.slice(prefix.length) : item.rel;
    const finalRel = cut || path.basename(item.rel);
    const extName = path.extname(finalRel).toLowerCase();
    const baseName = path.basename(finalRel);
    const allowDotEnv = baseName === ".env" || baseName === ".env.example" || baseName === ".env.local";
    if (!ALLOWED.has(extName) && !allowDotEnv) continue;
    const dest = path.resolve(dir, finalRel);
    const relCheck = path.relative(path.resolve(dir), dest);
    if (!relCheck || relCheck.startsWith("..") || path.isAbsolute(relCheck)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (extName === ".html" || extName === ".htm") {
      const html = decodeUploadedText(item.data);
      fs.writeFileSync(dest, looksBackend ? ensureUtf8Meta(html) : injectSdk(html), "utf8");
    } else {
      fs.writeFileSync(dest, item.data);
    }
    written += 1;
    // 大文件夹写入时让出事件循环，避免 /api/health 长时间无响应导致启动终端误关
    if (written % 40 === 0) {
      await yieldEventLoop();
    }
  }
  // 剥掉残留的「源码包」单层外壳，保证启动 cwd 与入口路径一致
  flattenNestedGameRoot(dir);
  cleanupFlattenArtifacts(dir);
  // 展平后再探测入口，避免把「外壳/index.html」写进数据库
  const root = resolveGameRoot(dir);
  try {
    return detectEntryFile(root === dir ? dir : root);
  } catch {
    return detectEntryFile(dir);
  }
}


/** Repair already-saved workshop HTML that still shows GBK/UTF-8 mojibake. */
export function repairUploadedHtmlFiles() {
  if (!fs.existsSync(uploadsRoot)) return;
  for (const name of fs.readdirSync(uploadsRoot)) {
    const gameDir = path.join(uploadsRoot, name);
    if (!fs.statSync(gameDir).isDirectory()) continue;
    // 清掉失败展平残留，避免后端游戏被误判为 static
    cleanupFlattenArtifacts(gameDir);
    try {
      if (resolveGameRoot(gameDir) !== gameDir) flattenNestedGameRoot(gameDir);
    } catch {
      /* 展平失败不阻断启动 */
    }
    let entry = "index.html";
    try {
      entry = detectEntryFile(resolveGameRoot(gameDir));
    } catch {
      /* no html */
    }
    const candidates = new Set(["index.html", entry]);
    for (const rel of candidates) {
      const file = path.join(resolveGameRoot(gameDir), rel);
      if (!fs.existsSync(file)) continue;
      const buf = fs.readFileSync(file);
      const text = buf.toString("utf8");
      if (!MOJIBAKE_HINT.test(text)) continue;
      const fixed = decodeUploadedText(buf);
      if (fixed !== text && !MOJIBAKE_HINT.test(fixed)) {
        fs.writeFileSync(file, injectSdk(ensureUtf8Meta(fixed)), "utf8");
      }
    }
  }
}

workshopRouter.post("/", requireAuth, multerUpload, async (req, res) => {
  const title = String(req.body?.title || "").trim();
  const description = String(req.body?.description || "").trim() || "玩家上传的小游戏";
  const cover = String(req.body?.coverColor || "#3ec6ea").trim();
  if (title.length < 2 || title.length > 40) {
    cleanupUploaded((req.files || []) as Express.Multer.File[]);
    res.status(400).json({ error: "标题需 2-40 个字" });
    return;
  }
  const files = (req.files || []) as Express.Multer.File[];
  if (!files.length) {
    res.status(400).json({ error: "请选择包含游戏的整个文件夹" });
    return;
  }

  const id = `ug_${crypto.randomBytes(6).toString("hex")}`;
  const dir = path.join(uploadsRoot, id);
  fs.mkdirSync(dir, { recursive: true });

  try {
    let entryFile = "index.html";
    const only = files.length === 1 ? files[0] : null;
    const onlyExt = only ? path.extname(only.originalname || "").toLowerCase() : "";
    if (only && (onlyExt === ".html" || onlyExt === ".htm")) {
      writeHtml(dir, "index.html", decodeUploadedText(readUploadedBytes(only)));
      entryFile = "index.html";
    } else if (only && onlyExt === ".zip") {
      const zipItems = await extractZipEntries(only.path || readUploadedBytes(only));
      entryFile = await persistTree(dir, zipItems);
    } else {
      let paths = req.body?.paths as string | string[] | undefined;
      if (typeof paths === "string") paths = [paths];
      if (!Array.isArray(paths) || paths.length !== files.length) {
        throw new Error("文件夹路径不完整，请重新选择整个游戏文件夹");
      }
      const items: { rel: string; data: Buffer }[] = [];
      for (let i = 0; i < files.length; i++) {
        const rel = safeRel(String(paths[i] || files[i].originalname || ""));
        if (rel) items.push({ rel, data: readUploadedBytes(files[i]) });
        if ((i + 1) % 20 === 0) await yieldEventLoop();
      }
      entryFile = await persistTree(dir, items);
    }

    const plan = detectLaunchPlan(id);
    const needsBackend = userGameNeedsBackend(id);
    const playUrl = `/ug/${id}/${entryFile}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO user_games (id, owner_id, title, description, cover_color, entry_file, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, req.userId, title, description, cover, entryFile, now);

    publishAdminEvent("game.changed", {
      action: "upload",
      gameId: id,
      name: title,
      author: req.user?.displayName,
      ownerId: req.userId
    });

    const openHow = needsBackend
      ? plan.kind === "bat"
        ? `打开时自动运行 ${plan.startScript}（端口 ${plan.port}）`
        : `打开时自动启动后端服务（端口 ${plan.port}）`
      : `浏览器打开 ${entryFile}`;

    // 后台预装依赖，避免首次打开卡在 npm install（最长数分钟）
    if (needsBackend) {
      void prepareUserGameDeps(id);
    }

    res.status(201).json({
      game: {
        id,
        name: title,
        description,
        source: "user",
        author: req.user?.displayName,
        entryFile,
        playUrl,
        needsBackend,
        openHow
      }
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    res.status(400).json({ error: err instanceof Error ? err.message : "上传失败" });
  } finally {
    cleanupUploaded(files);
  }
});

workshopRouter.get("/mine", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      "SELECT id, title, description, cover_color, entry_file, created_at FROM user_games WHERE owner_id = ? ORDER BY created_at DESC"
    )
    .all(req.userId) as {
    id: string;
    title: string;
    description: string;
    cover_color: string;
    entry_file: string;
    created_at: string;
  }[];
  res.json({
    games: rows.map((r) => {
      const needsBackend = userGameNeedsBackend(r.id);
      const plan = needsBackend ? detectLaunchPlan(r.id) : null;
      return {
        id: r.id,
        name: r.title,
        description: r.description,
        cover: r.cover_color,
        entryFile: r.entry_file,
        playUrl: `/ug/${r.id}/${r.entry_file}`,
        needsBackend,
        createdAt: r.created_at,
        openHow: needsBackend
          ? plan?.kind === "bat"
            ? `打开时自动运行 ${plan.startScript}`
            : `打开时自动启动后端（端口 ${plan?.port}）`
          : `浏览器打开 ${r.entry_file}`
      };
    })
  });
});

/** 打开工坊游戏前：若有 start.bat / Node 后端则自动拉起，再返回可访问地址。
 *  必须鉴权：该端点会执行 npm install 并拉起用户上传的启动脚本/进程。 */
workshopRouter.post("/:id/ensure-runtime", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const row = getUserGame(id);
  if (!row) {
    res.status(404).json({ error: "未找到该游戏" });
    return;
  }
  const host = String(req.hostname || "127.0.0.1").replace(/^\[|\]$/g, "");
  try {
    const result = await ensureUserGameRuntime(id, host, row.entry_file || "index.html");

    // 展平后修正数据库里的嵌套入口路径，避免大厅仍跳到「外壳/index.html」
    try {
      const gamePath = path.join(uploadsRoot, id);
      if (fs.existsSync(gamePath)) {
        const freshEntry = detectEntryFile(resolveGameRoot(gamePath) === gamePath ? gamePath : resolveGameRoot(gamePath));
        const basing = path.basename(freshEntry);
        const preferred =
          userGameNeedsBackend(id) && fs.existsSync(path.join(resolveGameRoot(gamePath), "login.html"))
            ? "login.html"
            : basing.includes("/")
              ? path.basename(basing)
              : freshEntry.includes("/")
                ? path.basename(freshEntry)
                : freshEntry;
        if (preferred && preferred !== row.entry_file && !preferred.includes("..")) {
          db.prepare("UPDATE user_games SET entry_file = ? WHERE id = ?").run(preferred, id);
        }
      }
    } catch {
      /* 入口修正失败不影响打开 */
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "启动游戏服务失败"
    });
  }
});

workshopRouter.delete("/:id", requireAuth, (req, res) => {
  const id = String(req.params.id);
  const row = getUserGame(id);
  if (!row) {
    res.status(404).json({ error: "未找到该游戏" });
    return;
  }
  if (row.owner_id !== req.userId) {
    res.status(403).json({ error: "只能删除自己上传的游戏" });
    return;
  }
  purgeUserGame(id);
  publishAdminEvent("game.changed", {
    action: "delete",
    gameId: id,
    ownerId: row.owner_id
  });
  res.json({ ok: true });
});

function commonRoot(paths: string[]) {
  if (!paths.length) return "";
  let remaining = paths.map((p) => p.split("/").filter(Boolean));
  const prefix: string[] = [];
  // 连续剥掉「整包外面的单层文件夹」（源码包/源码包/...）
  while (remaining.length && remaining.every((p) => p.length > 1)) {
    const first = remaining[0][0];
    if (!first || !remaining.every((p) => p[0] === first)) break;
    prefix.push(first);
    remaining = remaining.map((p) => p.slice(1));
  }
  return prefix.length ? `${prefix.join("/")}/` : "";
}



// ============================================================
// admin.ts
// ============================================================

const adminRouter = Router();

function attachAdminFromQuery(req: import("express").Request): boolean {
  if (req.user?.isAdmin) return true;
  const token = String(req.query.access_token || "");
  if (!token) return false;
  try {
    const payload = verifyAccessToken(token);
    const row = findUserById(payload.userId);
    if (!row || Number(row.is_admin) !== 1) return false;
    req.userId = row.id;
    req.user = toPublicUser(row);
    return true;
  } catch {
    return false;
  }
}

function collectStats() {
  const users = (db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
  const userGames = (db.prepare("SELECT COUNT(*) AS c FROM user_games").get() as { c: number }).c;
  const hidden = (db.prepare("SELECT COUNT(*) AS c FROM hidden_games").get() as { c: number }).c;
  const today = new Date().toISOString().slice(0, 10);
  const scoresToday = (
    db
      .prepare("SELECT COUNT(*) AS c FROM score_history WHERE created_at LIKE ?")
      .get(`${today}%`) as { c: number }
  ).c;
  const recentScores = db
    .prepare(
      `SELECT h.game_id, h.score, h.created_at, u.username, u.display_name
       FROM score_history h
       JOIN users u ON u.id = h.user_id
       ORDER BY h.id DESC
       LIMIT 12`
    )
    .all() as {
    game_id: string;
    score: number;
    created_at: string;
    username: string;
    display_name: string | null;
  }[];
  const recentUploads = db
    .prepare(
      `SELECT g.id, g.title, g.created_at, u.username, u.display_name
       FROM user_games g
       JOIN users u ON u.id = g.owner_id
       ORDER BY g.created_at DESC
       LIMIT 8`
    )
    .all() as {
    id: string;
    title: string;
    created_at: string;
    username: string;
    display_name: string | null;
  }[];

  return {
    users,
    builtinGames: GAMES.length,
    userGames,
    totalGames: GAMES.length + userGames,
    hidden,
    online: onlineCount(),
    scoresToday,
    recentScores: recentScores.map((r) => ({
      gameId: r.game_id,
      score: r.score,
      at: r.created_at,
      username: r.username,
      displayName: r.display_name || r.username
    })),
    recentUploads: recentUploads.map((r) => ({
      gameId: r.id,
      name: r.title,
      at: r.created_at,
      username: r.username,
      displayName: r.display_name || r.username
    }))
  };
}

adminRouter.use((req, res, next) => {
  // SSE may auth via query token before requireAuth
  if (req.path === "/events" || req.path.endsWith("/events")) {
    next();
    return;
  }
  requireAuth(req, res, () => requireAdmin(req, res, next));
});

adminRouter.get("/stats", (_req, res) => {
  res.json({ stats: collectStats() });
});

adminRouter.get("/games", (_req, res) => {
  res.json({
    games: listAllGamesAdmin().map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      source: g.source,
      author: g.author,
      authorId: g.authorId,
      cover: g.cover,
      hidden: Boolean(g.hidden),
      createdAt: g.createdAt ?? null
    }))
  });
});

adminRouter.patch("/games/:id", (req, res) => {
  const id = String(req.params.id);
  const game = findGame(id, { includeHidden: true });
  if (!game) {
    res.status(404).json({ error: "未知游戏" });
    return;
  }
  if (game.source !== "user") {
    res.status(400).json({ error: "内置游戏只能隐藏/恢复，不能改标题" });
    return;
  }
  const title = req.body?.title != null ? String(req.body.title).trim() : undefined;
  const description = req.body?.description != null ? String(req.body.description).trim() : undefined;
  if (title !== undefined && (title.length < 2 || title.length > 40)) {
    res.status(400).json({ error: "标题需 2-40 个字" });
    return;
  }
  if (description !== undefined && description.length > 200) {
    res.status(400).json({ error: "简介过长" });
    return;
  }
  if (title !== undefined) {
    db.prepare("UPDATE user_games SET title = ? WHERE id = ?").run(title, id);
  }
  if (description !== undefined) {
    db.prepare("UPDATE user_games SET description = ? WHERE id = ?").run(description || "玩家上传的小游戏", id);
  }
  const updated = findGame(id, { includeHidden: true });
  publishAdminEvent("game.changed", { action: "update", gameId: id, game: updated });
  res.json({ game: updated });
});

adminRouter.post("/games/:id/hide", (req, res) => {
  const id = String(req.params.id);
  const game = findGame(id, { includeHidden: true });
  if (!game) {
    res.status(404).json({ error: "未知游戏" });
    return;
  }
  hideGame(id);
  publishAdminEvent("game.changed", { action: "hide", gameId: id });
  res.json({ ok: true, hidden: true });
});

adminRouter.post("/games/:id/unhide", (req, res) => {
  const id = String(req.params.id);
  const game = findGame(id, { includeHidden: true });
  if (!game) {
    res.status(404).json({ error: "未知游戏" });
    return;
  }
  unhideGame(id);
  publishAdminEvent("game.changed", { action: "unhide", gameId: id });
  res.json({ ok: true, hidden: false });
});

adminRouter.delete("/games/:id", (req, res) => {
  const id = String(req.params.id);
  const row = getUserGame(id);
  if (!row) {
    res.status(404).json({ error: "只能删除工坊游戏" });
    return;
  }
  purgeUserGame(id);
  publishAdminEvent("game.changed", { action: "delete", gameId: id, ownerId: row.owner_id });
  res.json({ ok: true, gameId: id, needAudit: true });
});

/** 删除后自检：扫描文件与数据库残留 */
adminRouter.get("/games/:id/leftover-check", (req, res) => {
  const id = String(req.params.id);
  if (!isUserGameId(id)) {
    res.status(400).json({ error: "无效的工坊游戏 ID" });
    return;
  }
  res.json(auditUserGameTraces(id));
});

/** 清理自检发现的残留并再次返回检查结果 */
adminRouter.post("/games/:id/purge-leftovers", (req, res) => {
  const id = String(req.params.id);
  if (!isUserGameId(id)) {
    res.status(400).json({ error: "无效的工坊游戏 ID" });
    return;
  }
  purgeUserGameTraces(id);
  publishAdminEvent("game.changed", { action: "purge-leftovers", gameId: id });
  res.json({ ok: true, audit: auditUserGameTraces(id) });
});

adminRouter.get("/sessions", (_req, res) => {
  res.json({ sessions: listPresence() });
});

adminRouter.post("/sessions/:id/kick", (req, res) => {
  const id = String(req.params.id);
  const session = kickPresence(id);
  if (!session) {
    res.status(404).json({ error: "会话不存在或已结束" });
    return;
  }
  res.json({ ok: true, session });
});

adminRouter.get("/events", (req, res) => {
  // Auth: Bearer via requireAuth path OR access_token query for EventSource
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (bearer) {
    try {
      const payload = verifyAccessToken(bearer);
      const row = findUserById(payload.userId);
      if (!row || Number(row.is_admin) !== 1) {
        res.status(403).json({ error: "需要管理员权限" });
        return;
      }
      req.userId = row.id;
      req.user = toPublicUser(row);
    } catch {
      res.status(401).json({ error: "未登录或登录已过期" });
      return;
    }
  } else if (!attachAdminFromQuery(req)) {
    res.status(401).json({ error: "未登录或登录已过期" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const remove = addAdminSseClient(res);
  const snapshot = {
    stats: collectStats(),
    sessions: listPresence(),
    games: listAllGamesAdmin().map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      source: g.source,
      author: g.author,
      authorId: g.authorId,
      cover: g.cover,
      hidden: Boolean(g.hidden),
      createdAt: g.createdAt ?? null
    }))
  };
  res.write(`event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", at: new Date().toISOString(), data: snapshot })}\n\n`);

  const ping = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      clearInterval(ping);
    }
  }, 20_000);

  req.on("close", () => {
    clearInterval(ping);
    remove();
  });
});



// ============================================================
// profile.ts
// ============================================================

const profileRouter = Router();

export const avatarsRoot = path.join(__dirname, "..", "uploads", "avatars");

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (/^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("仅支持 JPG、PNG、WEBP、GIF 图片"));
  }
});

function extForMime(mime: string) {
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  return ".jpg";
}

function removeOldAvatarFile(avatar: string | null | undefined) {
  if (!isImageAvatar(avatar)) return;
  const name = path.basename(String(avatar));
  const full = path.join(avatarsRoot, name);
  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch {
    /* ignore */
  }
}

function saveAvatarFile(userId: number, file: Express.Multer.File): string {
  fs.mkdirSync(avatarsRoot, { recursive: true });
  const ext = extForMime(file.mimetype);
  const filename = `u${userId}-${Date.now()}${ext}`;
  fs.writeFileSync(path.join(avatarsRoot, filename), file.buffer);
  return `/avatars/${filename}`;
}

function optionalAvatarUpload(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) {
  const ct = String(req.headers["content-type"] || "");
  if (!ct.includes("multipart/form-data")) {
    next();
    return;
  }
  avatarUpload.single("avatarFile")(req, res, (err) => {
    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "上传失败" });
      return;
    }
    next();
  });
}

function applyProfileUpdate(req: import("express").Request, res: import("express").Response) {
  try {
    const displayName = req.body?.displayName != null ? String(req.body.displayName) : undefined;
    let avatar = req.body?.avatar != null ? String(req.body.avatar) : undefined;
    const file = req.file;

    if (displayName === undefined && avatar === undefined && !file) {
      res.status(400).json({ error: "没有要更新的内容" });
      return;
    }

    // 旧头像文件必须在 updateProfile 校验通过之后再删：
    // 否则昵称非法返回 400 时头像已被物理删除，用户头像 404
    const currentRow = db.prepare("SELECT avatar FROM users WHERE id = ?").get(req.userId!) as
      | { avatar: string | null }
      | undefined;
    const oldAvatar = currentRow?.avatar ?? null;
    let newAvatarFile: string | null = null;

    if (file) {
      newAvatarFile = saveAvatarFile(req.userId!, file);
      avatar = newAvatarFile;
    }

    const user = updateProfile(req.userId!, { displayName, avatar });

    if (newAvatarFile) {
      removeOldAvatarFile(oldAvatar);
    } else if (avatar !== undefined && !isImageAvatar(avatar)) {
      if (isImageAvatar(oldAvatar) && normalizeAvatar(avatar) !== oldAvatar) {
        removeOldAvatarFile(oldAvatar);
      }
    }
    res.json({ user });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "更新失败" });
  }
}

profileRouter.get("/", requireAuth, (req, res) => {
  const userId = req.userId!;
  const scores = db
    .prepare("SELECT game_id, score, updated_at FROM scores WHERE user_id = ?")
    .all(userId) as { game_id: string; score: number; updated_at: string }[];
  const scoreMap = new Map(scores.map((s) => [s.game_id, s]));
  const favRows = db
    .prepare("SELECT game_id, created_at FROM favorites WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as { game_id: string; created_at: string }[];
  const all = listAllGames();
  const byId = new Map(all.map((g) => [g.id, g]));

  res.json({
    user: req.user,
    avatarPresets: AVATAR_PRESETS,
    games: all.map((g) => ({
      gameId: g.id,
      name: g.name,
      source: g.source,
      highScore: scoreMap.get(g.id)?.score ?? null,
      updatedAt: scoreMap.get(g.id)?.updated_at ?? null,
      favorited: favRows.some((f) => f.game_id === g.id)
    })),
    favorites: favRows
      .map((f) => {
        const g = byId.get(f.game_id);
        if (!g) return null;
        return {
          gameId: g.id,
          name: g.name,
          description: g.description,
          source: g.source,
          cover: g.cover,
          entryFile: g.entryFile,
          playUrl: g.playUrl,
          highScore: scoreMap.get(g.id)?.score ?? null,
          favoritedAt: f.created_at
        };
      })
      .filter(Boolean)
  });
});

profileRouter.patch("/", requireAuth, optionalAvatarUpload, applyProfileUpdate);
profileRouter.post("/", requireAuth, optionalAvatarUpload, applyProfileUpdate);

profileRouter.get("/favorites", requireAuth, (req, res) => {
  const userId = req.userId!;
  const favRows = db
    .prepare("SELECT game_id, created_at FROM favorites WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as { game_id: string; created_at: string }[];
  const scores = db
    .prepare("SELECT game_id, score FROM scores WHERE user_id = ?")
    .all(userId) as { game_id: string; score: number }[];
  const scoreMap = new Map(scores.map((s) => [s.game_id, s.score]));
  const all = listAllGames();
  const byId = new Map(all.map((g) => [g.id, g]));
  res.json({
    favorites: favRows
      .map((f) => {
        const g = byId.get(f.game_id);
        if (!g) return null;
        return {
          gameId: g.id,
          name: g.name,
          description: g.description,
          source: g.source,
          cover: g.cover,
          highScore: scoreMap.get(g.id) ?? null,
          favoritedAt: f.created_at
        };
      })
      .filter(Boolean)
  });
});

profileRouter.post("/favorites/:gameId", requireAuth, (req, res) => {
  const gameId = String(req.params.gameId);
  if (!isKnownGame(gameId) || !findGame(gameId)) {
    res.status(404).json({ error: "未知游戏" });
    return;
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO favorites (user_id, game_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, game_id) DO NOTHING`
  ).run(req.userId!, gameId, now);
  res.json({ ok: true, favorited: true, gameId });
});

profileRouter.delete("/favorites/:gameId", requireAuth, (req, res) => {
  const gameId = String(req.params.gameId);
  db.prepare("DELETE FROM favorites WHERE user_id = ? AND game_id = ?").run(req.userId!, gameId);
  res.json({ ok: true, favorited: false, gameId });
});



// ============================================================
// board.ts
// ============================================================

const boardRouter = Router();

const MAX_CONTENT = 500;
const MAX_LIMIT = 200;

type MessageRow = {
  id: number;
  user_id: number;
  content: string;
  created_at: string;
  username: string;
  display_name: string | null;
  avatar: string | null;
  is_admin: number;
};

type PublicMessage = {
  id: number;
  content: string;
  createdAt: string;
  author: {
    id: number;
    username: string;
    displayName: string;
    avatar: string | null;
    isAdmin: boolean;
  };
  mine: boolean;
};

function toPublic(row: MessageRow, viewerId?: number): PublicMessage {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    author: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name || row.username,
      avatar: row.avatar,
      isAdmin: !!row.is_admin
    },
    mine: viewerId === row.user_id
  };
}

boardRouter.get("/", optionalAuth, (req, res) => {
  // ?limit=（空串）应视为未提供，Number("")===0 会把默认 100 错变成 1
  const raw = req.query.limit;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  const limit = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 100, 1), MAX_LIMIT);
  const rows = db
    .prepare(
      `SELECT m.id, m.user_id, m.content, m.created_at,
              u.username, u.display_name, u.avatar, u.is_admin
       FROM messages m
       JOIN users u ON u.id = m.user_id
       ORDER BY m.id DESC
       LIMIT ?`
    )
    .all(limit) as MessageRow[];

  const total = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
  res.json({
    messages: rows.map((row) => toPublic(row, req.userId)),
    total: total.n
  });
});

boardRouter.post("/", requireAuth, (req, res) => {
  const content = String(req.body?.content || "").trim();
  if (!content) {
    res.status(400).json({ error: "留言不能为空" });
    return;
  }
  if (content.length > MAX_CONTENT) {
    res.status(400).json({ error: `留言最多 ${MAX_CONTENT} 字` });
    return;
  }

  const userId = req.userId!;
  const now = new Date().toISOString();
  const info = db
    .prepare("INSERT INTO messages (user_id, content, created_at) VALUES (?, ?, ?)")
    .run(userId, content, now);
  const id = Number(info.lastInsertRowid);

  publishAdminEvent("message.posted", {
    messageId: id,
    userId,
    username: req.user?.username,
    displayName: req.user?.displayName,
    preview: content.slice(0, 40),
    at: now
  });

  const created = db
    .prepare(
      `SELECT m.id, m.user_id, m.content, m.created_at,
              u.username, u.display_name, u.avatar, u.is_admin
       FROM messages m JOIN users u ON u.id = m.user_id
       WHERE m.id = ?`
    )
    .all(id)[0] as MessageRow;

  res.status(201).json({ ok: true, message: toPublic(created, userId) });
});

boardRouter.delete("/:id", requireAuth, (req, res) => {
  const parsed = Number(req.params.id);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    res.status(400).json({ error: "无效留言" });
    return;
  }
  const row = db
    .prepare("SELECT id, user_id FROM messages WHERE id = ?")
    .all(parsed)[0] as { id: number; user_id: number } | undefined;
  if (!row) {
    res.status(404).json({ error: "留言不存在或已删除" });
    return;
  }
  if (row.user_id !== req.userId && !req.user?.isAdmin) {
    res.status(403).json({ error: "只能删除自己的留言" });
    return;
  }
  db.prepare("DELETE FROM messages WHERE id = ?").run(parsed);
  res.json({ ok: true });
});



export {
  authRouter as authRoutes,
  gamesRouter as gamesRoutes,
  scoresRouter as scoresRoutes,
  savesRouter as savesRoutes,
  workshopRouter as workshopRoutes,
  adminRouter as adminRoutes,
  profileRouter as profileRoutes,
  boardRouter as boardRoutes,
};
