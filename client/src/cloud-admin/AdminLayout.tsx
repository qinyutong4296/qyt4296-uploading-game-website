import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAdminAuth } from "./AdminAuth";
import styles from "../styles/modules/group-2.module.css";

const NAV = [
  { to: "/admin", label: "数据看板", icon: "📊", end: true },
  { to: "/admin/games", label: "游戏管理", icon: "🎮" },
  { to: "/admin/members", label: "用户管理", icon: "👤" },
  { to: "/admin/scores", label: "积分排行", icon: "🏆" },
  { to: "/admin/sessions", label: "对局会话", icon: "⚡" },
  { to: "/admin/audit", label: "操作日志", icon: "📜" },
];

const TITLES: [RegExp, string][] = [
  [/^\/admin\/?$/, "数据看板"],
  [/^\/admin\/games\/new/, "新增游戏"],
  [/^\/admin\/games\/\d+\/edit/, "编辑游戏"],
  [/^\/admin\/games/, "游戏管理"],
  [/^\/admin\/members/, "用户管理"],
  [/^\/admin\/scores/, "积分排行"],
  [/^\/admin\/sessions/, "对局会话"],
  [/^\/admin\/audit/, "操作日志"],
];

export default function AdminLayout() {
  const { user, signOut } = useAdminAuth();
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  const title = TITLES.find(([re]) => re.test(location.pathname))?.[1] ?? "管理后台";

  return (
    <div className={styles.root}>
      <div className={styles.layout}>
        {drawer && <div className={styles.drawerMask} onClick={() => setDrawer(false)} />}
        <aside className={`${styles.sidebar} ${drawer ? styles.sidebarOpen : ""}`}>
          <div className={styles.sideBrand}>
            <span className={styles.sideLogo}>游</span>
            <span>小游戏 · 云后台</span>
          </div>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `${styles.navItem} ${isActive ? styles.navItemActive : ""}`}
              onClick={() => setDrawer(false)}
            >
              <span className={styles.navIcon}>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
          <div className={styles.sideFooter}>
            <span>管理员:{user?.email || user?.phone || "已登录"}</span>
            <button className={styles.ghostBtn} onClick={() => void signOut()}>
              退出登录
            </button>
          </div>
        </aside>
        <main className={styles.main}>
          <div className={styles.topbar}>
            <button className={styles.menuBtn} onClick={() => setDrawer(true)} aria-label="打开菜单">
              ☰
            </button>
            <h2>{title}</h2>
          </div>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
