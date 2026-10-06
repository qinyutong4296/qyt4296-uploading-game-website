const ACCESS_KEY = "hub_access_token";

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_KEY);
}

export function setAccessToken(token: string | null) {
  if (token) localStorage.setItem(ACCESS_KEY, token);
  else localStorage.removeItem(ACCESS_KEY);
}

export type ApiError = Error & { status?: number };

export type ApiInit = RequestInit & { skipAuth?: boolean; skipRefresh?: boolean };

async function parse(res: Response) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text };
  }
}

let refreshing: Promise<boolean> | null = null;

export async function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        setAccessToken(null);
        return false;
      }
      const data = await res.json();
      setAccessToken(data.accessToken);
      return true;
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

function networkErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err || "");
  if (/Failed to fetch|NetworkError|load failed|网络/i.test(msg) || err instanceof TypeError) {
    return "无法连接网站服务（服务可能已关闭，或启动游戏时被中断）。请确认网站窗口仍在运行后重试。";
  }
  return msg || "网络错误";
}

export async function api<T>(path: string, init: ApiInit = {}, retry = true): Promise<T> {
  const { skipAuth, skipRefresh, ...rest } = init;
  const headers = new Headers(rest.headers);
  const token = getAccessToken();
  if (token && !skipAuth) headers.set("Authorization", `Bearer ${token}`);
  if (rest.body && !(rest.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      headers,
      credentials: "include",
    });
  } catch (err) {
    const e: ApiError = new Error(networkErrorMessage(err));
    throw e;
  }

  const canRefresh =
    retry &&
    !skipRefresh &&
    !path.includes("/api/auth/refresh") &&
    !path.includes("/api/auth/login") &&
    !path.includes("/api/auth/exchange-ticket");

  if (res.status === 401 && canRefresh) {
    const ok = await refreshSession();
    if (ok) return api<T>(path, init, false);
    const err: ApiError = new Error("登录已过期");
    err.status = 401;
    sessionStorage.setItem("auth_notice", "登录已过期");
    setAccessToken(null);
    throw err;
  }

  const data = await parse(res);
  if (!res.ok) {
    const err: ApiError = new Error(data.error || "请求失败");
    err.status = res.status;
    throw err;
  }
  return data as T;
}

export type UploadProgress = {
  loaded: number;
  total: number;
  percent: number;
};

/** FormData upload with real upload progress (XHR). Mirrors api() auth / refresh. */
export async function apiUpload<T>(
  path: string,
  body: FormData,
  onProgress?: (p: UploadProgress) => void,
  retry = true
): Promise<T> {
  const token = getAccessToken();

  const run = () =>
    new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", path);
      xhr.withCredentials = true;
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.upload.onprogress = (e) => {
        if (!onProgress || !e.lengthComputable || e.total <= 0) return;
        onProgress({
          loaded: e.loaded,
          total: e.total,
          percent: Math.min(100, Math.round((e.loaded / e.total) * 100))
        });
      };
      xhr.onload = () => {
        let data: Record<string, unknown> = {};
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        } catch {
          data = { error: xhr.responseText || "请求失败" };
        }
        resolve({ status: xhr.status, data });
      };
      xhr.onerror = () => reject(new Error("网络错误，上传中断"));
      xhr.onabort = () => reject(new Error("上传已取消"));
      xhr.send(body);
    });

  let { status, data } = await run();

  if (status === 401 && retry) {
    const ok = await refreshSession();
    if (ok) return apiUpload<T>(path, body, onProgress, false);
    const err: ApiError = new Error("登录已过期");
    err.status = 401;
    sessionStorage.setItem("auth_notice", "登录已过期");
    setAccessToken(null);
    throw err;
  }

  if (status < 200 || status >= 300) {
    const err: ApiError = new Error(String(data.error || "请求失败"));
    err.status = status;
    throw err;
  }
  return data as T;
}

export type PublicUser = {
  id: number;
  username: string;
  displayName: string;
  avatar: string;
  createdAt: string;
  lastLoginAt: string | null;
  isAdmin?: boolean;
};

export type GameListItem = {
  id: string;
  name: string;
  description: string;
  summary?: string;
  source?: "builtin" | "user";
  author?: string;
  cover?: string;
  entryFile?: string;
  playUrl?: string;
  needsBackend?: boolean;
  openHow?: string;
  myHighScore: number | null;
  hasSave: boolean;
  favorited?: boolean;
};

const UG_RUNTIME_KEY = (id: string) => `hub.ug.runtime.${id}`;

/** 记住工坊游戏实际打开地址（可能是独立端口），供 /play/:id 内嵌使用 */
export function rememberUserGameRuntime(gameId: string, playUrl: string) {
  try {
    sessionStorage.setItem(UG_RUNTIME_KEY(gameId), playUrl);
  } catch {
    /* ignore */
  }
}

export function readUserGameRuntime(gameId: string): string | null {
  try {
    return sessionStorage.getItem(UG_RUNTIME_KEY(gameId));
  } catch {
    return null;
  }
}

/** 独立端口后端地址（http://host:port/...），不能 iframe 嵌合集站同源页 */
export function isExternalGameUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

/**
 * 启动工坊游戏后端（如有），再进入游玩页。
 * - 静态包：站内 iframe（同源 /ug/...）
 * - 独立后端：新标签顶层打开（许多游戏禁止被 iframe 嵌套）；合集站标签页保持心跳以免关服
 * 绝不对本标签 location.assign 到外站/独立端口，否则 pagehide 会把合集站关掉。
 */
export async function openUserUploadedGame(
  game: {
    id: string;
    playUrl?: string;
    entryFile?: string;
    needsBackend?: boolean;
  },
  navigate: (path: string) => void
) {
  const fallback = game.playUrl || `/ug/${game.id}/${game.entryFile || "index.html"}`;
  // 后端游戏含 npm install（≤3min）+ 端口等待；静态游戏会秒回，长超时无妨
  const timeoutMs = 240000;

  const data = await Promise.race([
    api<{ playUrl: string; openHow?: string; mode?: string; openExternal?: boolean }>(
      `/api/workshop/${game.id}/ensure-runtime`,
      {
        method: "POST"
        // 需要登录态：服务端会拉起进程/执行 npm install，绝不能裸调
      }
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ]);

  if (!data) {
    throw new Error(
      "游戏服务启动超时。若刚上传，请稍等依赖安装完成后再试；也可检查该游戏的 start.bat / 端口配置。"
    );
  }

  // needsBackend 的专用报错必须在「无 playUrl 就抛超时」之前判断，
  // 否则该分支不可达、静态包的 /ug 回退也永远用不上
  if (!data.playUrl) {
    if (game.needsBackend) {
      throw new Error(
        "该游戏需要独立后端服务，但未能启动。请稍后再试，或检查游戏目录的依赖是否安装完整。"
      );
    }
  }
  const playUrl = data.playUrl || fallback;
  rememberUserGameRuntime(game.id, playUrl);

  // 默认走合集站 /ug 反代（同源，登录 API 才能打到游戏后端）；仅服务端声明时才新窗口
  const external = data.openExternal === true;
  if (external) {
    // 先打开独立窗口，再进桥接页（弹窗被拦时桥接页仍可点开）
    try {
      window.open(playUrl, "_blank", "noopener,noreferrer");
    } catch {
      /* bridge page handles retry */
    }
  }
  navigate(`/play/${game.id}`);
}

export async function toggleFavorite(gameId: string, favorited: boolean) {
  if (favorited) {
    return api<{ ok: boolean; favorited: boolean; gameId: string }>(`/api/profile/favorites/${gameId}`, {
      method: "DELETE"
    });
  }
  return api<{ ok: boolean; favorited: boolean; gameId: string }>(`/api/profile/favorites/${gameId}`, {
    method: "POST"
  });
}

export type BoardMessage = {
  id: number;
  content: string;
  createdAt: string;
  author: {
    id: number;
    username: string;
    displayName: string;
    avatar: string | null;
    isAdmin: boolean;
  };
  mine: boolean;
};

export function listMessages(limit = 100) {
  return api<{ messages: BoardMessage[]; total: number }>(`/api/messages?limit=${limit}`);
}

export function postMessage(content: string) {
  return api<{ ok: boolean; message: BoardMessage }>("/api/messages", {
    method: "POST",
    body: JSON.stringify({ content })
  });
}

export function deleteMessage(id: number) {
  return api<{ ok: boolean }>(`/api/messages/${id}`, { method: "DELETE" });
}
