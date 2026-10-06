import crypto from "node:crypto";
import { publishAdminEvent } from "./adminEvents";

export type PresenceSession = {
  sessionId: string;
  userId: number;
  username: string;
  displayName: string;
  gameId: string;
  gameName: string;
  startedAt: string;
  lastSeen: string;
};

const STALE_MS = 30_000;
/** 被踢标记保留时长：超过后允许该 sessionId 重新开始对局（心跳早已过期） */
const KICKED_TTL_MS = 10 * 60_000;
const sessions = new Map<string, PresenceSession>();
const kicked = new Map<string, number>(); // sessionId -> kickedAt

function nowIso() {
  return new Date().toISOString();
}

function pruneStale() {
  const cutoff = Date.now() - STALE_MS;
  for (const [id, s] of sessions) {
    if (new Date(s.lastSeen).getTime() < cutoff) {
      sessions.delete(id);
      publishAdminEvent("session.leave", { sessionId: id, reason: "timeout", session: s });
    }
  }
  // kicked 若永不清理，频繁踢人时集合会无界增长
  const kickedCutoff = Date.now() - KICKED_TTL_MS;
  for (const [id, at] of kicked) {
    if (at < kickedCutoff) kicked.delete(id);
  }
}

setInterval(pruneStale, 10_000).unref?.();

export function startPresence(input: {
  userId: number;
  username: string;
  displayName: string;
  gameId: string;
  gameName: string;
}): PresenceSession {
  pruneStale();
  // One active session per user: replace older ones
  for (const [id, s] of sessions) {
    if (s.userId === input.userId) {
      sessions.delete(id);
      publishAdminEvent("session.leave", { sessionId: id, reason: "replaced", session: s });
    }
  }
  const sessionId = crypto.randomBytes(12).toString("hex");
  const t = nowIso();
  const session: PresenceSession = {
    sessionId,
    userId: input.userId,
    username: input.username,
    displayName: input.displayName,
    gameId: input.gameId,
    gameName: input.gameName,
    startedAt: t,
    lastSeen: t
  };
  sessions.set(sessionId, session);
  publishAdminEvent("session.upsert", { session });
  return session;
}

export function heartbeatPresence(sessionId: string): PresenceSession | "kicked" | null {
  pruneStale();
  if (kicked.has(sessionId)) {
    kicked.delete(sessionId);
    return "kicked";
  }  const s = sessions.get(sessionId);
  if (!s) return null;
  s.lastSeen = nowIso();
  sessions.set(sessionId, s);
  return s;
}

export function leavePresence(sessionId: string, reason = "leave"): PresenceSession | null {
  const s = sessions.get(sessionId);
  if (!s) {
    kicked.delete(sessionId);
    return null;
  }
  sessions.delete(sessionId);
  publishAdminEvent("session.leave", { sessionId, reason, session: s });
  return s;
}

export function getPresence(sessionId: string): PresenceSession | null {
  pruneStale();
  return sessions.get(sessionId) ?? null;
}

export function kickPresence(sessionId: string): PresenceSession | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  sessions.delete(sessionId);
  kicked.set(sessionId, Date.now());
  publishAdminEvent("session.kick", { sessionId, session: s });
  return s;
}

export function listPresence(): PresenceSession[] {
  pruneStale();
  return [...sessions.values()].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}

export function onlineCount() {
  pruneStale();
  return sessions.size;
}

/** 关站时结束全部游戏在线会话 */
export function clearAllPresence(reason = "shutdown") {
  const all = [...sessions.entries()];
  sessions.clear();
  kicked.clear();
  for (const [sessionId, session] of all) {
    publishAdminEvent("session.leave", { sessionId, reason, session });
  }
  return all.length;
}

/** 游戏被删除时结束该游戏的全部在线会话 */
export function clearPresenceByGame(gameId: string, reason = "game-deleted") {
  pruneStale();
  let n = 0;
  for (const [sessionId, session] of [...sessions.entries()]) {
    if (session.gameId !== gameId) continue;
    sessions.delete(sessionId);
    kicked.set(sessionId, Date.now());
    publishAdminEvent("session.leave", { sessionId, reason, session });
    n += 1;
  }
  return n;
}
