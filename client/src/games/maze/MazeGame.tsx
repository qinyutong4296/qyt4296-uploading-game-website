import { useEffect, useRef } from "react";
import { getAccessToken } from "../../api";
import type { GameProps } from "../types";
import styles from "../../styles/modules/group-2.module.css";

/** 投影回廊：全屏 iframe；把合集站令牌传给游戏以便同账号 / 绑定选择 */
export default function MazeGame(_props: GameProps) {
  const ref = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    function sendHubAuth() {
      const win = ref.current?.contentWindow;
      if (!win) return;
      const token = getAccessToken();
      if (!token) return;
      // 目标源固定为本站源：用 "*" 会把访问令牌泄露给任何能拿到引用的页面
      win.postMessage({ type: "hub:maze-auth", accessToken: token }, window.location.origin);
    }

    const onMsg = (e: MessageEvent) => {
      // 只接受自家 iframe 的消息
      if (e.source !== ref.current?.contentWindow) return;
      if (e.origin !== window.location.origin) return;
      const data = e.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "hub:maze-need-auth") sendHubAuth();
    };

    window.addEventListener("message", onMsg);
    const iframe = ref.current;
    if (iframe) {
      iframe.addEventListener("load", sendHubAuth);
      // 已加载完成时也补发一次
      try {
        if (iframe.contentDocument?.readyState === "complete") sendHubAuth();
      } catch {
        /* ignore */
      }
    }
    return () => {
      window.removeEventListener("message", onMsg);
      iframe?.removeEventListener("load", sendHubAuth);
    };
  }, []);

  return (
    <div className={styles.wrap}>
      <iframe
        ref={ref}
        className={styles.frame}
        title="投影回廊"
        src="/games/maze/index.html?hub=1"
        sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms"
        allow="autoplay; fullscreen; gamepad"
      />
    </div>
  );
}
