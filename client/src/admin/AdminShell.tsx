import { NavLink, Outlet, Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useAdminEvents } from "./useAdminEvents";
import styles from "../styles/modules/group-3.module.css";
import { createContext, useContext } from "react";

type AdminCtx = ReturnType<typeof useAdminEvents>;
const Ctx = createContext<AdminCtx | null>(null);

export function useAdminCtx() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAdminCtx outside AdminShell");
  return v;
}

export default function AdminShell() {
  const { user, logout } = useAuth();
  const admin = useAdminEvents();
  const navigate = useNavigate();

  return (
    <Ctx.Provider value={admin}>
      <div className={styles.shell}>
        <header className={styles.top}>
          <Link to="/admin" className={styles.brand}>
            管理后台
            <span>ADMIN · 小游戏网站</span>
          </Link>
          <div className={styles.topRight}>
            <span className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <i className={`${styles.dot} ${admin.connected ? styles.dotOn : ""}`} />
              {admin.connected ? "实时已连接" : "连接中…"}
            </span>
            <span className="muted">{user?.displayName}</span>
            <Link to="/lobby">
              <button type="button" className="ghost">
                返回站点
              </button>
            </Link>
            <button
              type="button"
              className="ghost"
              onClick={() => logout().then(() => navigate("/login"))}
            >
              退出
            </button>
          </div>
        </header>
        <div className={styles.body}>
          <nav className={styles.nav}>
            <NavLink to="/admin" end className={({ isActive }) => (isActive ? styles.active : undefined)}>
              概览
            </NavLink>
            <NavLink to="/admin/games" className={({ isActive }) => (isActive ? styles.active : undefined)}>
              游戏管理
            </NavLink>
            <NavLink to="/admin/sessions" className={({ isActive }) => (isActive ? styles.active : undefined)}>
              在线对局
            </NavLink>
          </nav>
          <main className={styles.main}>
            {admin.error ? <div className={styles.err}>{admin.error}</div> : null}
            <Outlet />
          </main>
        </div>
      </div>
    </Ctx.Provider>
  );
}
