import { FormEvent, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { AvatarFace } from "../ui/Avatar";
import styles from "../styles/modules/group-4.module.css";

const DISCOVER = [
  { to: "/lobby", label: "大厅" },
  { to: "/workshop", label: "创意工坊" },
  { to: "/ranks", label: "排行榜" },
  { to: "/upload", label: "上传游戏" },
  { to: "/board", label: "留言板" }
];

function InkAtmosphere() {
  return (
    <div className={styles.atmosphere} aria-hidden="true">
      <div className={styles.quoteL}>
        <span className={styles.verse}>胜固欣然</span>
        <span className={styles.verse}>败亦可喜</span>
        <span className={styles.quoteSrc}>东坡 · 观棋</span>
        <span className={styles.quoteSeal}>弈</span>
      </div>
      <div className={styles.quoteR}>
        <span className={styles.verse}>行到水穷处</span>
        <span className={styles.verse}>坐看云起时</span>
        <span className={styles.quoteSrc}>摩诘 · 终南别业</span>
        <span className={styles.quoteSeal}>游</span>
      </div>
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const play = loc.pathname.startsWith("/play");
  const authPage = loc.pathname === "/login" || loc.pathname === "/register";
  const adminPage = loc.pathname.startsWith("/admin");
  const onProfile = loc.pathname === "/profile";
  const onFavorites = onProfile && new URLSearchParams(loc.search).get("tab") === "favorites";
  if (play || authPage || adminPage) return <>{children}</>;

  function onSearch(e: FormEvent) {
    e.preventDefault();
    navigate(`/lobby?q=${encodeURIComponent(q.trim())}`);
  }

  return (
    <div className={styles.shell}>
      <InkAtmosphere />
      <header className={styles.header}>
        <Link to="/lobby" className={styles.brand}>
          <span className={styles.logo}>玩</span>
          <span>
            <strong>小游戏网站</strong>
            <small>INK ARCADE</small>
          </span>
        </Link>
        <form className={styles.search} onSubmit={onSearch}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索游戏、创作者…"
            style={{ border: 0, background: "transparent", padding: 0 }}
          />
        </form>
        <div className={styles.headerRight}>
          {user ? (
            <>
              <Link to="/profile" className={styles.userChip}>
                <AvatarFace avatar={user.avatar} name={user.displayName} className={styles.userAvatar} />
                <span className="muted">{user.displayName}</span>
              </Link>
              <Link to="/upload"><button type="button" className="seal">发布</button></Link>
            </>
          ) : (
            <>
              <Link to="/login" className={styles.textLink}>登录</Link>
              <Link to="/register" className={styles.textLink}>注册</Link>
              <Link to="/login"><button type="button" className="seal">发布</button></Link>
            </>
          )}
        </div>
      </header>
      <div className={styles.body}>
        <aside className={styles.side}>
          <div className={styles.group}>发现</div>
          {DISCOVER.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ""}`}>
              {item.label}
            </NavLink>
          ))}
          <div className={styles.group}>社区</div>
          <NavLink to="/workshop" className={styles.navItem}>玩家作品</NavLink>
          <NavLink to="/ranks" className={styles.navItem}>分数榜</NavLink>
          <NavLink to="/board" className={styles.navItem}>留言板</NavLink>
          <div className={styles.group}>我的</div>
          <NavLink
            to="/profile"
            end
            className={() => `${styles.navItem} ${onProfile && !onFavorites ? styles.active : ""}`}
          >
            个人资料
          </NavLink>
          <NavLink
            to="/profile?tab=favorites"
            className={() => `${styles.navItem} ${onFavorites ? styles.active : ""}`}
          >
            收藏夹
          </NavLink>
          <NavLink to="/upload" className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ""}`}>上传游戏</NavLink>
          {user?.isAdmin ? (
            <>
              <div className={styles.group}>管理</div>
              <NavLink to="/admin" className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ""}`}>
                管理后台
              </NavLink>
            </>
          ) : null}
          {user ? (
            <button
              className="ghost"
              type="button"
              style={{ width: "100%", marginTop: 8 }}
              onClick={() => logout().then(() => navigate("/login"))}
            >
              退出登录
            </button>
          ) : null}
        </aside>
        <main className={styles.main}>{children}</main>
        <aside className={styles.rail}>
          <div className={styles.cta}>
            <h3>{user ? "创作并发布" : "加入小游戏网站"}</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              {user ? "上传整个游戏文件夹，立刻出现在工坊和大厅。" : "登录后即可游玩，并把你做的小游戏添加到网站里。"}
            </p>
            {user ? (
              <Link to="/upload"><button type="button" className="seal">上传游戏</button></Link>
            ) : (
              <Link to="/login"><button type="button" className="seal">登录</button></Link>
            )}
          </div>
          <div className={styles.cta}>
            <h3>快捷入口</h3>
            <div style={{ display: "grid", gap: 8 }}>
              <Link to="/profile">个人资料</Link>
              <Link to="/profile?tab=favorites">收藏夹</Link>
              <Link to="/ranks">排行榜</Link>
              <Link to="/board">留言板</Link>
              <a href="/sample-clicker.html" download="sample-clicker.html">下载示例游戏</a>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
