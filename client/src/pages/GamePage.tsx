import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { getGame } from "../games/registry";
import { GameRuntimePage } from "./GameRuntimePage";
import styles from "../styles/modules/group-1.module.css";

export default function GamePage() {
  const { gameId = "" } = useParams();
  const meta = getGame(gameId);
  const title = meta?.name || (gameId.startsWith("ug_") ? "工坊游戏" : "");
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isMaze = gameId === "maze";

  if (!meta && !gameId.startsWith("ug_")) {
    return (
      <div className={styles.shell}>
        <header className={styles.bar}>未知游戏</header>
        <div className={styles.stage}>
          <Link to="/lobby">返回大厅</Link>
        </div>
      </div>
    );
  }

  const shown = title || "游戏";

  if (isMaze) {
    return (
      <div className={`${styles.shell} ${styles.immersive}`}>
        <button
          className={styles.floatBack}
          type="button"
          onClick={() => navigate("/lobby")}
          title="返回大厅"
        >
          ← 大厅
        </button>
        <div className={styles.immersiveStage}>
          <GameRuntimePage />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <div className={styles.left}>
          <span className={styles.name}>小游戏网站</span>
          <span className={styles.game}>{shown}</span>
          <span className="muted">当前用户：{user?.displayName}</span>
        </div>
        <div className={styles.right}>
          <button className="ghost" type="button" onClick={() => navigate("/lobby")}>
            返回大厅
          </button>
          <button className="danger" type="button" onClick={() => logout().then(() => navigate("/login"))}>
            退出登录
          </button>
        </div>
      </header>
      <div className={styles.stage}>
        <GameRuntimePage />
      </div>
    </div>
  );
}
