import type { Response } from "express";

export type AdminEventType =
  | "session.upsert"
  | "session.leave"
  | "session.kick"
  | "game.changed"
  | "score.submitted"
  | "message.posted"
  | "stats"
  | "snapshot";

export type AdminEvent = {
  type: AdminEventType;
  at: string;
  data: unknown;
};

type Client = {
  id: number;
  res: Response;
};

let nextId = 1;
const clients = new Map<number, Client>();

export function publishAdminEvent(type: AdminEventType, data: unknown) {
  const event: AdminEvent = {
    type,
    at: new Date().toISOString(),
    data
  };
  const payload = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients.values()) {
    try {
      client.res.write(payload);
    } catch {
      clients.delete(client.id);
    }
  }
  return event;
}

export function addAdminSseClient(res: Response): () => void {
  const id = nextId++;
  clients.set(id, { id, res });
  return () => {
    clients.delete(id);
  };
}

export function adminClientCount() {
  return clients.size;
}
