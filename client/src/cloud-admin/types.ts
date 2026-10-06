export type GameRow = {
  id: number;
  slug: string;
  title: string;
  description: string;
  category: string;
  cover_path: string | null;
  play_url: string | null;
  status: "published" | "hidden";
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type MemberRow = {
  id: number;
  owner_id: string;
  nickname: string;
  disabled: boolean;
  last_seen_at: string | null;
  created_at: string;
};

export type ScoreRow = {
  id: number;
  owner_id: string;
  game_id: number;
  score: number;
  created_at: string;
};

export type SessionRow = {
  id: number;
  owner_id: string;
  game_id: number | null;
  status: "active" | "ended";
  started_at: string;
  ended_at: string | null;
  meta: Record<string, unknown> | null;
};

export type AuditRow = {
  id: number;
  actor_id: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
};

export type CloudUser = {
  id: string;
  email?: string;
  phone?: string;
};

export function shortId(id: string | null | undefined): string {
  if (!id) return "-";
  return id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
