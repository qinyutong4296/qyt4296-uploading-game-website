import React, { useState } from "react";
import { db } from "./cloud";
import { errMsg, logAudit } from "./api";
import { useAdminAuth } from "./AdminAuth";
import AdminLoginPage from "./AdminLoginPage";
import styles from "../styles/modules/group-2.module.css";

/** 已登录但不是管理员:提供"认领首个管理员"引导(仅当系统尚无管理员时服务端才会放行) */
function ClaimAdmin() {
  const { user, refresh, signOut } = useAdminAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function claim() {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const { data, error } = await db.rpc("claim_admin");
      if (error) {
        setMsg(errMsg(error));
        return;
      }
      if (data === true) {
        await logAudit("claim_admin", user?.id);
        await refresh();
      } else {
        setMsg("认领失败:系统已有管理员,请联系现有管理员授权。");
      }
    } catch (e) {
      setMsg(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${styles.root} ${styles.loginWrap}`}>
      <div className={styles.loginCard}>
        <h1>暂无管理员权限</h1>
        <p className={styles.muted}>
          当前账号({user?.email || user?.phone || user?.id})还不是管理员。如果这是系统首次使用,可以认领为初始管理员。
        </p>
        <button className={styles.primaryBtn} onClick={claim} disabled={busy}>
          {busy ? "认领中…" : "认领为初始管理员"}
        </button>
        {msg && <p className={styles.errMsg}>{msg}</p>}
        <button className={styles.ghostBtn} style={{ marginTop: 12 }} onClick={() => void signOut()}>
          退出登录
        </button>
      </div>
    </div>
  );
}

export default function AdminGuard({ children }: { children: React.ReactNode }) {
  const { ready, user, isAdmin, refresh } = useAdminAuth();

  if (!ready) {
    return (
      <div className={`${styles.root} ${styles.loginWrap}`}>
        <p className={styles.muted}>正在校验登录状态…</p>
      </div>
    );
  }
  if (!user) return <AdminLoginPage onLoggedIn={() => void refresh()} />;
  if (!isAdmin) return <ClaimAdmin />;
  return <>{children}</>;
}
