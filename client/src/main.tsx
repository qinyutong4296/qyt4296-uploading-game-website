import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import "./styles/global.css";

/** 本机关闭网页时请求停服；刷新会取消。局域网访客不会触发。 */
function isLocalBrowserHost() {
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

// 本标签页身份证：服务器据此区分「关掉的是最后一个标签页」和「旧标签页被顺手关掉」
const TAB_ID = (() => {
  try {
    let t = sessionStorage.getItem("hub.tab");
    if (!t) {
      t = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem("hub.tab", t);
    }
    return t;
  } catch {
    return "t0";
  }
})();

function requestHubShutdownOnLeave() {
  if (!isLocalBrowserHost()) return;
  try {
    const url = `/api/hub-shutdown?tab=${encodeURIComponent(TAB_ID)}`;
    // keepalive fetch + beacon 双保险，避免关标签页时请求丢失
    // → 服务端会调度执行「关闭网站.bat」清后台并关掉启动终端
    fetch(url, { method: "POST", keepalive: true }).catch(() => {});
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(url, new Blob([], { type: "application/json" }));
    }
  } catch {
    /* ignore */
  }
}

// 每 2 秒向服务上报「这个标签页还开着」，服务器据此避免把还开着的网站误关掉
let hubAliveTimer = 0;
function startHubHeartbeat() {
  if (!isLocalBrowserHost() || hubAliveTimer) return;
  const beat = () => {
    fetch(`/api/hub-alive?tab=${encodeURIComponent(TAB_ID)}`, { method: "POST", keepalive: true }).catch(() => {});
  };
  beat();
  hubAliveTimer = window.setInterval(beat, 2000);
}
startHubHeartbeat();

function cancelHubShutdown() {
  if (!isLocalBrowserHost()) return;
  try {
    fetch("/api/hub-shutdown-cancel", { method: "POST", keepalive: true }).catch(() => {});
    // 恢复时立刻补一次心跳，防止误关服
    fetch(`/api/hub-alive?tab=${encodeURIComponent(TAB_ID)}`, { method: "POST", keepalive: true }).catch(() => {});
  } catch {
    /* ignore */
  }
}

window.addEventListener("pagehide", () => {
  requestHubShutdownOnLeave();
});
window.addEventListener("beforeunload", () => {
  requestHubShutdownOnLeave();
});
window.addEventListener("pageshow", () => {
  cancelHubShutdown();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
