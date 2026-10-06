import { cloud, db } from "./cloud";

/** 把 { data, error } 信封转为 throw-on-error,调用点更干净 */
export function unwrap<T>(res: { data: T; error: unknown }): T {
  if (res.error) throw res.error;
  return res.data;
}

export function errMsg(error: unknown, fallback = "操作失败,请重试"): string {
  if (!error) return fallback;
  const e = error as { code?: string; message?: string; kind?: string };
  if (e.code === "23505") return "已存在相同记录,请勿重复提交";
  if (e.code === "42501") return "没有权限执行此操作";
  if (e.code === "42P01") return "数据表不存在,请联系开发者";
  if (e.kind === "network" || e.kind === "backend-unavailable") return "网络异常,请稍后重试";
  return e.message || fallback;
}

/** 写审计日志(尽力而为,不阻塞主流程) */
export async function logAudit(action: string, target?: string, detail?: Record<string, unknown>) {
  try {
    await db.from("audit_logs").insert({
      action,
      target: target ?? null,
      detail: detail ?? null,
    });
  } catch {
    /* 审计失败不影响业务操作 */
  }
}

/** 判断当前登录用户是否管理员(服务端 RLS 同源校验) */
export async function fetchIsAdmin(): Promise<boolean> {
  const { data, error } = await db.rpc("is_admin");
  if (error) return false;
  return Boolean(data);
}

/** 确保 members 表存在本人记录并刷新活跃时间 */
export async function touchMember(nickname?: string) {
  try {
    const { data: session } = await cloud.auth.getSession();
    if (!session) return;
    const { data: mine } = await db
      .from("members")
      .select("id")
      .eq("owner_id", session.user.id)
      .maybeSingle();
    if (!mine) {
      const { error } = await db.from("members").insert({ nickname: nickname || "管理员" });
      if (error && (error as { code?: string }).code !== "23505") return;
    } else {
      await db
        .from("members")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", (mine as { id: number }).id);
    }
  } catch {
    /* 忽略 */
  }
}
