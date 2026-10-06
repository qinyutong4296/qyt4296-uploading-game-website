import { FormEvent, useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { api } from "../api";
import styles from "../styles/modules/group-1.module.css";

const GUEST_KEY = "hub_guest_creds";

type GuestCreds = { username: string; password: string };

function randomToken(len: number) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint32Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function loadGuestCreds(): GuestCreds | null {
  try {
    const raw = localStorage.getItem(GUEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GuestCreds;
    if (parsed?.username && parsed?.password) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

function makeGuestCreds(): GuestCreds {
  return { username: `guest_${randomToken(8)}`, password: `g${randomToken(10)}${randomToken(8)}` };
}

export default function LoginPage() {
  return <AuthBoard mode="login" />;
}

export function AuthBoard({ mode }: { mode: "login" | "register" }) {
  const { user, ready, login, register } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);

  const isLogin = mode === "login";

  useEffect(() => {
    const msg = sessionStorage.getItem("auth_notice");
    if (msg) {
      setNotice(msg);
      sessionStorage.removeItem("auth_notice");
    }
  }, []);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => setOnline(r.ok))
      .catch(() => setOnline(false));
    api<{ urls: string[] }>("/api/hub-addresses", { skipAuth: true, skipRefresh: true })
      .then((d) => setLanUrls(d.urls || []))
      .catch(() => setLanUrls([]));
  }, []);

  if (ready && user) return <Navigate to="/lobby" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      if (isLogin) {
        await login(username.trim(), password);
      } else {
        await register(username.trim(), password, displayName.trim() || undefined);
      }
      navigate("/lobby");
    } catch (err) {
      setError(err instanceof Error ? err.message : isLogin ? "登录失败" : "注册失败");
    } finally {
      setBusy(false);
    }
  }

  async function onGuest() {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      let creds = loadGuestCreds();
      if (creds) {
        try {
          await login(creds.username, creds.password);
        } catch {
          creds = null; // 本机游客账号已不在（如清库），换一个新游客
        }
      }
      if (!creds) {
        creds = makeGuestCreds();
        try {
          await register(creds.username, creds.password, `游客 ${creds.username.slice(6).toUpperCase()}`);
        } catch {
          await login(creds.username, creds.password);
        }
        localStorage.setItem(GUEST_KEY, JSON.stringify(creds));
      }
      navigate("/lobby");
    } catch (err) {
      setError(err instanceof Error ? err.message : "游客进入失败");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: "login" | "register") {
    if (next === mode) return;
    navigate(next === "login" ? "/login" : "/register", { replace: true });
    setError("");
  }

  async function copyAddress() {
    const text = window.location.origin;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const origin = window.location.origin;
  const spare = lanUrls.filter((u) => u !== origin).slice(0, 3);

  return (
    <div className={styles.page}>
      <div className={styles.atmosphere} aria-hidden="true">
        <div className={styles.quoteL}>
          <span className={styles.verse}>有朋自远方来</span>
          <span className={styles.verse}>不亦乐乎</span>
          <span className={styles.quoteSrc}>工坊 · 留言板</span>
          <span className={styles.quoteSeal}>社</span>
        </div>
        <div className={styles.quoteR}>
          <span className={styles.verse}>独乐乐</span>
          <span className={styles.verse}>不如众乐乐</span>
          <span className={styles.quoteSrc}>上传 · 分享</span>
          <span className={styles.quoteSeal}>创</span>
        </div>
        <div className={styles.decoRingL} />
        <div className={styles.decoRingR} />
        <div className={styles.inkBlobA} />
        <div className={styles.inkBlobB} />
        <div className={styles.inkBlobC} />
        <div className={styles.brushStrokeL} />
        <div className={styles.brushStrokeR} />
        <div className={styles.mountainBand} />
        <div className={styles.scrollBand} />
      </div>

      <div className={`${styles.col} ${styles.colA}`}>
        <div className={styles.viewCard}>
          <span className={styles.viewLabel}>VIEW · 01</span>
          <span className={styles.viewBig}>逛 大 厅</span>
          <span className={styles.viewSub}>悬停揭晓</span>
          <span className={styles.viewHint}>六款内置 · 即点即玩</span>
        </div>
      </div>

      <div className={`${styles.col} ${styles.colB}`}>
        <section className={styles.card}>
          <header className={styles.cardHead}>GUIDE</header>
          <div className={styles.box}>
            <div className={styles.boxLabel}>PREMISE</div>
            <h3 className={styles.boxTitle}>先逛后玩，登录更好玩</h3>
            <p className={styles.boxText}>
              游客也能逛大厅、玩全部游戏，进度记在本机临时账号名下；注册之后，分数与存档跟着账号走。
            </p>
          </div>
          <div className={styles.box}>
            <div className={styles.boxLabel}>WORKSHOP</div>
            <h3 className={styles.boxTitle}>工坊与上传</h3>
            <p className={styles.boxText}>
              登录后点「上传游戏」，选择整个游戏文件夹一键发布；作品会出现在工坊与大厅，其他玩家可以即点即玩。
            </p>
            <div className={styles.chips}>
              <span className={styles.chip}>选文件夹上传</span>
              <span className={styles.chip}>HTML 即玩</span>
              <span className={styles.chip}>bat 自启</span>
              <span className={styles.chip}>逛工坊</span>
            </div>
          </div>
          <div className={styles.box}>
            <div className={styles.boxLabel}>PHASE</div>
            <h3 className={styles.boxTitle}>留言板</h3>
            <p className={styles.boxText}>
              逛累了去留言板说一句，游客和玩家都能留言，路过请留爪印。
            </p>
          </div>
        </section>
      </div>

      <div className={`${styles.col} ${styles.colC}`}>
        <section className={styles.card}>
          <header className={styles.cardHead}>ABOUT</header>
          <div className={styles.diamond}>◈</div>
          <h1 className={styles.title}>小 游 戏 网 站</h1>
          <div className={styles.subtitle}>GAME WEBSITE</div>
          <div className={styles.tagline}>闲时一局 · 单机 ↔ 联机</div>
          <div className={styles.box}>
            <p className={styles.boxText}>
              一间开在自己电脑里的游戏厅。不用联网、不注册也能玩；同一 Wi-Fi 里的手机与电脑都能加入。
            </p>
            <div className={styles.rows}>
              <div className={styles.row}>
                <span className={styles.rowKey}>内置</span>
                <span className={styles.rowVal}>贪吃蛇、2048、俄罗斯方块、弹球、翻牌记忆</span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowKey}>工坊</span>
                <span className={styles.rowVal}>上传整个游戏文件夹，作品直达大厅</span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowKey}>排行</span>
                <span className={styles.rowVal}>每款游戏一张高分榜，记录你的巅峰</span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowKey}>留言</span>
                <span className={styles.rowVal}>留言板开放中，路过请留爪印</span>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.card}>
          <header className={styles.cardHead}>ACCOUNT</header>
          {notice && <div className="banner">{notice}</div>}
          {error && <div className="banner">{error}</div>}
          <div className={styles.tabs}>
            <button
              type="button"
              className={`${styles.tab} ${isLogin ? styles.tabActive : ""}`}
              onClick={() => switchMode("login")}
            >
              登 录
            </button>
            <button
              type="button"
              className={`${styles.tab} ${!isLogin ? styles.tabActive : ""}`}
              onClick={() => switchMode("register")}
            >
              注 册
            </button>
          </div>
          <form onSubmit={onSubmit} className={styles.form} autoComplete="off">
            <label className={styles.field}>
              <span className={styles.fieldLabel}>用 户 名</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="3 - 20 位字母 / 数字 / 下划线"
                autoComplete="off"
                name="hub-username"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            {!isLogin && (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>显示名（可选）</span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="留言与排行榜里展示的名字"
                  autoComplete="off"
                  name="hub-display-name"
                />
              </label>
            )}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>密 码</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isLogin ? "你的密码" : "至少 6 位"}
                autoComplete="new-password"
                name="hub-password"
              />
            </label>
            <button type="submit" className={styles.enter} disabled={busy}>
              {busy ? "请稍候…" : isLogin ? "进 入 游 戏" : "注 册 并 进 入"}
            </button>
          </form>
          <div className={styles.or}>
            <span>或</span>
          </div>
          <button type="button" className={styles.guest} onClick={onGuest} disabled={busy}>
            游客进入 · 进度保存在本机
          </button>
          <div className={styles.demo}>
            <Link to="/register">没有账号？</Link>
          </div>
        </section>
      </div>

      <div className={`${styles.col} ${styles.colD}`}>
        <section className={styles.card}>
          <header className={styles.cardHead}>JOURNEY</header>
          <div className={styles.box}>
            <div className={styles.boxLabel}>COMMUNITY</div>
            <h3 className={styles.boxTitle}>社区与互动</h3>
            <p className={styles.boxText}>
              留言板开放中，游客和玩家都能留爪印；工坊汇聚玩家自制作品，逛大厅、比高分、收藏喜欢的小游戏。
            </p>
          </div>
          <div className={styles.box}>
            <div className={styles.boxLabel}>UPLOAD</div>
            <h3 className={styles.boxTitle}>自主上传游戏</h3>
            <p className={styles.boxText}>
              登录后上传整个游戏文件夹，作品即刻出现在工坊与大厅；静态页即点即玩，带 start.bat 的后端会自动安装依赖并启动。
            </p>
          </div>
          <div className={styles.quote}>「做一款小游戏，放进大厅，让路过的人也能玩上一局。」</div>
        </section>

        <section className={styles.card}>
          <header className={styles.cardHead}>NETWORK</header>
          <div className={styles.box}>
            <div className={styles.boxLabel}>SAVE</div>
            <h3 className={styles.boxTitle}>账号与游客</h3>
            <p className={styles.boxText}>
              登录进度写入本机 data/hub.sqlite；游客进度只困在此浏览器。局域网内其它设备填主机 IP 即可加入。
            </p>
          </div>
          <div className={styles.share}>
            <div className={styles.shareTip}>把下面地址发给其它电脑（同一 Wi-Fi）</div>
            <div className={styles.shareRow}>
              <code className={styles.shareUrl}>{origin}</code>
              <button type="button" className={styles.copy} onClick={copyAddress}>
                {copied ? "已复制" : "复制"}
              </button>
            </div>
            {spare.length > 0 && (
              <div className={styles.spare}>备用：{spare.join(" · ")}</div>
            )}
          </div>
          <div className={styles.status}>
            <i className={`${styles.dot} ${online === false ? styles.dotOff : ""}`} />
            {online === false
              ? "在线服务未连接 · 请先运行 启动网站.bat"
              : "在线服务已连接 · 数据写入本机 server/data"}
          </div>
        </section>
      </div>

      <div className={`${styles.col} ${styles.colE}`}>
        <div className={styles.viewCard}>
          <span className={styles.viewLabel}>VIEW · 02</span>
          <span className={styles.viewBig}>写 留 言</span>
          <span className={styles.viewSub}>悬停揭晓</span>
          <span className={styles.viewHint}>留言板已开放 · 留下足迹</span>
        </div>
      </div>
    </div>
  );
}
