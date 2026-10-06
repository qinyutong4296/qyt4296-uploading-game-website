import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import cookieParser from "cookie-parser";
import express from "express";
import { db, waitForDb } from "./db";
import { revokeAllSessions } from "./auth";
import { clearAllPresence } from "./presence";
import {
  authRoutes,
  gamesRoutes,
  scoresRoutes,
  savesRoutes,
  workshopRoutes,
  uploadsRoot,
  repairUploadedHtmlFiles,
  adminRoutes,
  profileRoutes,
  avatarsRoot,
  boardRoutes,
} from "./routes";
import { mountMazeApi, migrateMazeJsonToSqlite } from "./mazeApi";
import { userGameProxyMiddleware } from "./userGameProxy";
import iconv from "iconv-lite";

const app = express();
const PORT = Number(process.env.PORT || 8080);
const ROOT = path.join(__dirname, "..", "..");

function socketIp(req: express.Request) {
  const raw = req.socket.remoteAddress || "";
  return raw.replace(/^::ffff:/i, "");
}

function isLocalMachineRequest(req: express.Request) {
  // 只信任 TCP 对端地址。X-Forwarded-For 是客户端可随意伪造的头，
  // 优先读它会让局域网/公网用户伪造「本机」身份调到关站等敏感端点。
  const ip = socketIp(req);
  if (!ip || ip === "unknown") return false;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  try {
    // 本机经局域网 IP 自访问（如用 http://192.168.x.x:8080 打开本机页面）
    if (lanAddresses().includes(ip)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** hub-* 端点只能由本机页面调用：浏览器跨站请求（CSRF）必须拒绝 */
function isSameSiteBrowserRequest(req: express.Request) {
  const origin = String(req.headers.origin || "");
  if (!origin) return true; // 非浏览器客户端（本机脚本 / curl）
  try {
    return new URL(origin).host === String(req.headers.host || "");
  } catch {
    return false;
  }
}

function guardLocalEndpoint(req: express.Request, res: express.Response): boolean {
  if (!isLocalMachineRequest(req) || !isSameSiteBrowserRequest(req)) {
    res.status(403).json({ ok: false, error: "仅本机页面可调用该接口" });
    return false;
  }
  return true;
}

let hubShutdownTimer: ReturnType<typeof setTimeout> | null = null;
const HUB_SHUTDOWN_DELAY_MS = 2500;
// 启动宽限期内忽略关页请求：此刻浏览器可能还没打开，而后台残留的旧标签页
// 一旦被关掉会发 beacon，把刚启动的服务自己杀掉（偶发双击打不开的元凶之一）。
const HUB_STARTUP_GRACE_MS = 12000;
const HUB_TAB_TTL_MS = 8000; // 心跳超过该时长视为标签页已不存在
const hubBootedAt = Date.now();
const hubLocalTabs = new Map<string, number>(); // tabId -> lastSeenMs（仅本机页面上报）

function pruneHubTabs(now: number) {
  for (const [id, t] of hubLocalTabs) {
    if (now - t > HUB_TAB_TTL_MS) hubLocalTabs.delete(id);
  }
}

function hubTabIdOf(req: express.Request): string {
  try {
    return String((req.query && req.query.tab) || "").slice(0, 64);
  } catch {
    return "";
  }
}

/** 关站前：退出全部用户、结束全部游戏会话 */
function prepareHubShutdown(reason = "shutdown") {
  try {
    const ended = clearAllPresence(reason);
    revokeAllSessions();
    console.log(`[hub] 已退出全部登录并结束游戏会话（${ended}）`);
  } catch (err) {
    console.warn("[hub] 清理登录/游戏会话失败:", err);
  }
}

function runCloseWebsiteBat() {
  const bat = path.join(ROOT, "关闭网站.bat");
  const ps1 = path.join(ROOT, "runtime", "hub-lifecycle.ps1");
  const vbs = path.join(ROOT, "runtime", "run-hidden.vbs");
  const env = Object.assign({}, process.env, {
    HUB_AUTO: "1",
    PORT: String(PORT)
  });
  const spawnOpts = {
    cwd: ROOT,
    detached: true,
    stdio: "ignore" as const,
    windowsHide: true,
    env
  };

  // 优先静默执行「关闭网站.bat」（与手动双击同一入口）；无窗口、无编码问题
  try {
    if (process.platform === "win32" && fs.existsSync(vbs) && fs.existsSync(bat)) {
      spawn("wscript.exe", ["//nologo", vbs, "cmd.exe", "/c", bat], spawnOpts).unref();
      return;
    }
  } catch {
    /* fall through */
  }

  // 回退：WScript → PowerShell（完全无窗口）
  try {
    if (process.platform === "win32" && fs.existsSync(vbs) && fs.existsSync(ps1)) {
      spawn(
        "wscript.exe",
        [
          "//nologo",
          vbs,
          "powershell.exe",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-WindowStyle",
          "Hidden",
          "-File",
          ps1,
          "-Action",
          "stop",
          "-Quiet",
          "-Port",
          String(PORT)
        ],
        spawnOpts
      ).unref();
      return;
    }
  } catch {
    /* fall through */
  }

  try {
    if (process.platform === "win32" && fs.existsSync(ps1)) {
      spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-WindowStyle",
          "Hidden",
          "-File",
          ps1,
          "-Action",
          "stop",
          "-Quiet",
          "-Port",
          String(PORT)
        ],
        spawnOpts
      ).unref();
      return;
    }
  } catch {
    /* fall through */
  }

  try {
    if (process.platform === "win32" && fs.existsSync(bat)) {
      spawn("cmd.exe", ["/c", bat], spawnOpts).unref();
      return;
    }
  } catch {
    process.exit(0);
  }
}

function scheduleHubShutdown() {
  if (hubShutdownTimer) return;
  const armedAt = Date.now();
  hubShutdownTimer = setTimeout(() => {
    hubShutdownTimer = null;
    const now = Date.now();
    pruneHubTabs(now);
    // armedAt 之后仍有心跳 → 另有标签页还开着（或刷新后复活），取消关服
    for (const t of hubLocalTabs.values()) {
      if (t > armedAt) {
        console.log("[hub] 检测到仍有本机页面在线，取消自动关服");
        return;
      }
    }
    console.log("[hub] 本机网页已关闭，正在清后台并关闭启动终端…");
    prepareHubShutdown("hub-auto-close");
    runCloseWebsiteBat();
    // 尽快退出，让启动器 Wait/健康检查立刻发现并关窗
    setTimeout(() => process.exit(0), 500).unref();
  }, HUB_SHUTDOWN_DELAY_MS);
}

function cancelHubShutdown() {
  if (!hubShutdownTimer) return false;
  clearTimeout(hubShutdownTimer);
  hubShutdownTimer = null;
  return true;
}

function lanAddresses() {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) out.push(item.address);
    }
  }
  return out;
}

function setUtf8HtmlHeaders(_req: express.Request, res: express.Response, next: express.NextFunction) {
  const original = res.type.bind(res);
  res.type = ((type: string) => {
    if (type === "html" || type === "text/html") {
      return original("text/html; charset=utf-8");
    }
    return original(type);
  }) as typeof res.type;
  next();
}

/** 同源 + 本机开发端口才放行 CORS。严禁反射任意 Origin：
 *  刷新令牌走 cookie（credentials: true），反射任意来源等于把会话送给任意第三方站。 */
app.use((req, res, next) => {
  const origin = String(req.headers.origin || "");
  if (origin) {
    let allowed = false;
    try {
      const o = new URL(origin);
      const hostHeader = String(req.headers.host || "");
      const hostName = hostHeader.split(":")[0];
      allowed =
        o.host === hostHeader ||
        o.hostname === hostName ||
        o.hostname === "localhost" ||
        o.hostname === "127.0.0.1" ||
        o.hostname === "[::1]" ||
        o.hostname === "::1";
    } catch {
      /* malformed origin */
    }
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }
  if (req.method === "OPTIONS") {
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      String(req.headers["access-control-request-headers"] || "Content-Type,Authorization")
    );
    res.status(204).end();
    return;
  }
  next();
});
// 工坊后端游戏：把 /ug/:id 与其页面发出的 /api 转到独立进程（须在 json 解析之前，否则登录 POST 体为空）
app.use(userGameProxyMiddleware);
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());
app.use(setUtf8HtmlHeaders);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/** 本机页面上报心跳：证明这个标签页还开着（多标签/刷新时避免误关服） */
app.post("/api/hub-alive", (req, res) => {
  if (!guardLocalEndpoint(req, res)) return;
  const tab = hubTabIdOf(req);
  if (tab) hubLocalTabs.set(tab, Date.now());
  res.json({ ok: true });
});

/** 本机关闭网页：延迟清后台并关掉启动终端；刷新会取消。局域网访客无效。 */
app.post("/api/hub-shutdown", (req, res) => {
  if (!guardLocalEndpoint(req, res)) return;
  const now = Date.now();
  if (now - hubBootedAt < HUB_STARTUP_GRACE_MS) {
    res.json({ ok: true, ignored: "startup-grace" });
    return;
  }
  const closingTab = hubTabIdOf(req);
  // 立刻去掉正在关闭的标签，避免残留心跳把「最后一页」误判成还有别人在线
  if (closingTab) hubLocalTabs.delete(closingTab);
  pruneHubTabs(now);
  // 是否真有其它标签仍开着，交给延迟回调里看「armedAt 之后是否还有心跳」
  // （不能用 TTL 内的旧心跳判断，否则连关多个标签会永远关不掉服务）
  scheduleHubShutdown();
  res.json({ ok: true, scheduled: true });
});

app.post("/api/hub-shutdown-cancel", (req, res) => {
  if (!guardLocalEndpoint(req, res)) return;
  const cancelled = cancelHubShutdown();
  res.json({ ok: true, cancelled });
});

/** 本机关站脚本在杀进程前调用：强制退出全部用户并结束游戏 */
app.post("/api/hub-force-logout", (req, res) => {
  if (!guardLocalEndpoint(req, res)) return;
  prepareHubShutdown("force-logout");
  res.json({ ok: true });
});
/** 迷宫旧版账号库 db.json 含全部账号的盐值与密码哈希，绝不能作为静态文件公开下载 */
app.use("/games/maze/data", (_req, res) => {
  res.status(404).type("html").end();
});

app.use(
  express.static(path.join(__dirname, "..", "public"), {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html") || filePath.endsWith(".htm")) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
      }
      if (filePath.endsWith(".js")) {
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      }
    }
  })
);

/** 投影回廊：/api/ping、login、progress 等与单机同源，iframe 内可正常注册登录存档 */
mountMazeApi(app);

app.use("/api/auth", authRoutes);
app.use("/api/games", gamesRoutes);
app.use("/api/scores", scoresRoutes);
app.use("/api/saves", savesRoutes);
app.use("/api/workshop", workshopRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/messages", boardRoutes);

/** 登录页「把地址发给其它电脑」用：本机局域网地址（/api/lan 已被投影回廊占用） */
app.get("/api/hub-addresses", (_req, res) => {
  res.json({
    urls: lanAddresses().map((ip) => `http://${ip}:${PORT}`)
  });
});

app.use(
  "/avatars",
  (req, res, next) => {
    if (req.path.includes("..")) {
      res.status(400).end();
      return;
    }
    next();
  },
  express.static(avatarsRoot, {
    maxAge: "7d",
    setHeaders(res, filePath) {
      if (/\.(png|jpe?g|gif|webp)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=604800");
      }
    }
  })
);

app.use(
  "/ug",
  (req, res, next) => {
    if (req.path.includes("..")) {
      res.status(400).end();
      return;
    }
    next();
  },
  express.static(uploadsRoot, {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html") || filePath.endsWith(".htm")) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
      }
      if (filePath.endsWith(".js")) {
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      }
      if (filePath.endsWith(".css")) {
        res.setHeader("Content-Type", "text/css; charset=utf-8");
      }
    }
  })
);

const clientDist = path.join(__dirname, "..", "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  // index.html 不缓存：构建产物带 hash 文件名，缓存 html 会导致浏览器继续加载旧资源
  app.use(
    express.static(clientDist, {
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
      },
    })
  );
}
app.get("*", (req, res, next) => {
  if (
    req.path.startsWith("/api") ||
    req.path.startsWith("/ug/") ||
    req.path.startsWith("/avatars/") ||
    req.path.startsWith("/games/")
  ) {
    next();
    return;
  }
  const index = path.join(clientDist, "index.html");
  if (!fs.existsSync(index)) {
    res
      .status(503)
      .type("html")
      .send(
        `<!doctype html><meta charset="utf-8"><title>小游戏网站</title><p>网站页面还没打包。请在项目根目录运行 <code>npm run web</code>，然后用浏览器打开本页。</p>`
      );
    return;
  }
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(index);
});

function repairMojibakeDbText(text: string) {
  if (!/[鐐瑰鍒嗘姝ｅ鐜╁鈥寰楀璇嗗鏈]/.test(text)) return text;
  try {
    const fixed = iconv.decode(iconv.encode(text, "gbk"), "utf8");
    if (fixed && !/[鐐瑰鍒嗘姝ｅ鐜╁鈥]/.test(fixed)) return fixed;
  } catch {
    /* ignore */
  }
  return text;
}

function repairUserGameTitles() {
  const rows = db
    .prepare("SELECT id, title, description FROM user_games")
    .all() as { id: string; title: string; description: string }[];
  const upd = db.prepare("UPDATE user_games SET title = ?, description = ? WHERE id = ?");
  for (const row of rows) {
    const title = repairMojibakeDbText(row.title);
    const description = repairMojibakeDbText(row.description);
    if (title !== row.title || description !== row.description) {
      upd.run(title, description, row.id);
    }
  }
}

waitForDb().then(() => {
  if (!process.env.JWT_SECRET) {
    console.warn(
      "[hub] 警告：未设置 JWT_SECRET 环境变量，正在使用内置默认密钥。仅限本机试用；局域网/公网部署前必须设置。"
    );
  }
  fs.mkdirSync(uploadsRoot, { recursive: true });
  fs.mkdirSync(avatarsRoot, { recursive: true });
  migrateMazeJsonToSqlite();
  repairUploadedHtmlFiles();
  repairUserGameTitles();
  // 每次启动清空上次残留登录态，避免关站后再次打开仍自动登录
  try {
    revokeAllSessions();
    console.log("[hub] 已清除上次残留的登录会话");
  } catch (err) {
    console.warn("[hub] 清除残留登录会话失败:", err);
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`网站已启动（任意浏览器可直接打开，不依赖 Cursor）`);
    console.log(`  本机：    http://localhost:${PORT}`);
    console.log(`  本机：    http://127.0.0.1:${PORT}`);
    for (const ip of lanAddresses()) {
      console.log(`  局域网：  http://${ip}:${PORT}`);
    }
  });
});
