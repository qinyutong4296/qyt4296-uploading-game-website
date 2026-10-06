import { NextFunction, Request, Response } from "express";
import { findUserById, toPublicUser, verifyAccessToken } from "./auth";
import { PublicUser } from "./types";

declare global {
  namespace Express {
    interface Request {
      userId?: number;
      user?: PublicUser;
    }
  }
}

function attachUser(req: Request, token: string): boolean {
  try {
    const payload = verifyAccessToken(token);
    const row = findUserById(payload.userId);
    if (!row) return false;
    req.userId = row.id;
    req.user = toPublicUser(row);
    return true;
  } catch {
    return false;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !attachUser(req, token)) {
    res.status(401).json({ error: "未登录或登录已过期" });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: "需要管理员权限" });
    return;
  }
  next();
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token) attachUser(req, token);
  next();
}
