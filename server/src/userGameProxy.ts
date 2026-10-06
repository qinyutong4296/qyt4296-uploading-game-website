import http from "node:http";
import type { NextFunction, Request, Response } from "express";
import { resolveUserGamePort, userGameNeedsBackend } from "./userGameRuntime";

const UG_ID_RE = /\/ug\/(ug_[a-zA-Z0-9]+)(?=\/|$|\?|#)/i;
/** 粘性路由：iframe 内游戏发 /api 时若 Referer 被剥，仍能转到正确后端 */
export const UG_STICKY_COOKIE = "hub_ug";

const HUB_API_PREFIXES = [
  "/api/workshop",
  "/api/games",
  "/api/scores",
  "/api/saves",
  "/api/admin",
  "/api/profile",
  "/api/messages",
  "/api/hub-",
  "/api/health",
  "/api/lan",
  "/api/ping",
  "/api/login",
  "/api/register",
  "/api/progress",
  "/api/guest",
  // 合集站专用鉴权（游戏没有这些路径；勿转到游戏后端）
  "/api/auth/refresh",
  "/api/auth/verify",
  "/api/auth/exchange-ticket",
  "/api/auth/logout-on-leave",
  "/api/auth/logout-on-leave-cancel"
];

function gameIdFromReferer(referer: unknown): string | null {
  const m = String(referer || "").match(UG_ID_RE);
  return m ? m[1] : null;
}

function gameIdFromUgPath(urlPath: string): string | null {
  const m = urlPath.match(/^\/ug\/(ug_[a-zA-Z0-9]+)(?=\/|$)/i);
  return m ? m[1] : null;
}

function gameIdFromCookie(req: Request): string | null {
  const raw = String(req.headers.cookie || "");
  const m = raw.match(new RegExp(`(?:^|;\\s*)${UG_STICKY_COOKIE}=(ug_[a-zA-Z0-9]+)`));
  return m ? m[1] : null;
}

function hasBearerAuth(req: Request): boolean {
  return String(req.headers.authorization || "").startsWith("Bearer ");
}

function isHubExclusiveApi(urlPath: string): boolean {
  return HUB_API_PREFIXES.some((p) => urlPath === p || urlPath.startsWith(`${p}/`) || urlPath.startsWith(p));
}

function rewriteFramingHeaders(headers: http.IncomingHttpHeaders): http.IncomingHttpHeaders {
  const out: http.IncomingHttpHeaders = { ...headers };
  delete out["x-frame-options"];
  delete out["X-Frame-Options"];
  delete out["cross-origin-opener-policy"];
  delete out["Cross-Origin-Opener-Policy"];
  delete out["cross-origin-resource-policy"];
  delete out["Cross-Origin-Resource-Policy"];
  delete out["cross-origin-embedder-policy"];
  delete out["Cross-Origin-Embedder-Policy"];
  // 避免 iframe 内 fetch 因 Referrer-Policy 过严导致合集站丢 Referer（虽同站，仍统一放宽）
  delete out["referrer-policy"];
  delete out["Referrer-Policy"];
  const cspKey = out["content-security-policy"]
    ? "content-security-policy"
    : out["Content-Security-Policy"]
      ? "Content-Security-Policy"
      : null;
  if (cspKey) {
    const raw = String(out[cspKey] || "");
    out[cspKey] = raw
      .replace(/frame-ancestors\s+'none'/gi, "frame-ancestors 'self'")
      .replace(/frame-ancestors\s+[^;]+/gi, "frame-ancestors 'self'");
  }
  return out;
}

function appendSetCookie(headers: http.IncomingHttpHeaders, cookie: string): http.IncomingHttpHeaders {
  const out = { ...headers };
  const prev = out["set-cookie"];
  if (!prev) {
    out["set-cookie"] = [cookie];
  } else if (Array.isArray(prev)) {
    out["set-cookie"] = [...prev, cookie];
  } else {
    out["set-cookie"] = [String(prev), cookie];
  }
  return out;
}

function stickyCookieValue(gameId: string): string {
  return `${UG_STICKY_COOKIE}=${gameId}; Path=/; SameSite=Lax; Max-Age=86400`;
}

function targetPath(req: Request, gameId: string): string {
  const full = req.originalUrl || req.url || "/";
  const prefix = `/ug/${gameId}`;
  if (full === prefix || full.startsWith(`${prefix}/`) || full.startsWith(`${prefix}?`)) {
    const cut = full.slice(prefix.length) || "/";
    return cut.startsWith("/") ? cut : `/${cut}`;
  }
  return full;
}

/**
 * 决定是否把请求转到用户游戏后端。
 * - /ug/:id/*：始终代理（若该游戏需要后端）
 * - /api/*：优先用 Referer 里的 /ug/id；否则在「无 Bearer 且 Referer 不指向大厅页」时用粘性 cookie
 *   （游戏页不用合集站 JWT；大厅/登录页发出的请求 Referer 不含 /ug/，绝不能因 cookie 被转发）
 */
export function shouldProxyUserGame(req: Request): boolean {
  const urlPath = (req.originalUrl || req.url || "").split("?")[0];
  const fromPath = gameIdFromUgPath(urlPath);
  if (fromPath && userGameNeedsBackend(fromPath)) return true;
  if (!urlPath.startsWith("/api")) return false;
  if (isHubExclusiveApi(urlPath)) return false;

  const referer = String(req.headers.referer || "");
  const fromRef = gameIdFromReferer(referer);
  if (fromRef && userGameNeedsBackend(fromRef)) return true;

  // 粘性 cookie：仅当请求确实来自游戏页（Referer 指向 /ug/）或 Referer 被剥掉时启用。
  // 大厅退出再登录等不带 Bearer 的请求 Referer 是大厅页，走 cookie 兜底会被劫持到游戏后端。
  if (!hasBearerAuth(req) && (!referer || fromRef)) {
    const fromCookie = gameIdFromCookie(req);
    if (fromCookie && userGameNeedsBackend(fromCookie)) return true;
  }
  return false;
}

function proxyGameId(req: Request): string | null {
  const urlPath = (req.originalUrl || req.url || "").split("?")[0];
  const referer = String(req.headers.referer || "");
  const fromRef = gameIdFromReferer(referer);
  return (
    gameIdFromUgPath(urlPath) ||
    fromRef ||
    (!hasBearerAuth(req) && (!referer || fromRef) ? gameIdFromCookie(req) : null)
  );
}

export function proxyUserGame(req: Request, res: Response) {
  const gameId = proxyGameId(req);
  if (!gameId) {
    res.status(404).json({ error: "未找到该游戏" });
    return;
  }
  const port = resolveUserGamePort(gameId);
  if (!port) {
    res.status(503).json({ error: "游戏后端尚未启动，请返回大厅重新打开" });
    return;
  }

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  headers["x-forwarded-host"] = String(req.headers.host || "");
  headers["x-forwarded-proto"] = req.protocol || "http";

  const pReq = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: targetPath(req, gameId),
      method: req.method,
      headers,
      timeout: 120000
    },
    (pRes) => {
      let outHeaders = rewriteFramingHeaders(pRes.headers);
      // 访问 /ug 页面或游戏 API 时刷新粘性 cookie，保证后续 /api/auth/demo 等能路由到同一后端
      outHeaders = appendSetCookie(outHeaders, stickyCookieValue(gameId));
      res.writeHead(pRes.statusCode || 502, outHeaders as http.OutgoingHttpHeaders);
      pRes.pipe(res);
    }
  );
  pReq.on("timeout", () => {
    pReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: "游戏服务响应超时" });
    else res.destroy();
  });
  pReq.on("error", () => {
    // 响应已开始后再出错必须销毁连接，否则客户端请求永久挂起、socket 泄漏
    if (!res.headersSent) res.status(502).json({ error: "无法连接游戏后端，请返回大厅重新打开" });
    else res.destroy();
  });
  // 客户端提前断开：放弃上游请求，避免游戏后端继续处理已无人接收的响应
  req.on("close", () => {
    if (!res.writableEnded) pReq.destroy();
  });
  req.pipe(pReq);
}

/** Must run before express.json so POST bodies (login / demo) are forwarded intact. */
export function userGameProxyMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!shouldProxyUserGame(req)) {
    next();
    return;
  }
  proxyUserGame(req, res);
}
