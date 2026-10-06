import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
/** server/src → server/uploads（与 workshop.uploadsRoot 一致） */
const uploadsRoot = path.join(__dirname, "..", "uploads");

export type LaunchPlan = {
  kind: "static" | "bat" | "node";
  /** Relative to game dir */
  startScript?: string;
  /** Absolute cwd for the process */
  cwd: string;
  port?: number;
  /** Relative node entry, e.g. server/index.js */
  nodeEntry?: string;
  /** Absolute dir that has package.json for npm install */
  packageDir?: string;
};

type RuntimeState = {
  port: number;
  pid?: number;
  startedAt: number;
  kind: "bat" | "node";
};

export type EnsureRuntimeResult = {
  playUrl: string;
  started: boolean;
  mode: "static" | "bat" | "node";
  port?: number;
  openHow?: string;
  /** 独立端口后端：须顶层打开（许多游戏带 X-Frame-Options: DENY） */
  openExternal?: boolean;
};

const runtimes = new Map<string, RuntimeState>();
/** 同一游戏并发 ensure / 预装只跑一遍，避免重复 npm install */
const inflight = new Map<string, Promise<EnsureRuntimeResult>>();
const prepInflight = new Map<string, Promise<void>>();

const BAT_NAMES = [
  "start.bat",
  "start.cmd",
  "Start.bat",
  "启动.bat",
  "启动服务.bat",
  "启动网站.bat"
];

const RUNTIME_META = ".hub-ug-runtime.json";

/** 体积大或需本机工具链的依赖：缺失时不阻断启动 */
const OPTIONAL_NATIVE_DEPS = new Set(["sharp", "playwright", "playwright-core"]);

function gameDir(gameId: string) {
  return path.join(uploadsRoot, gameId);
}

function readTextIfExists(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function pickPort(...candidates: Array<number | null | undefined>): number | undefined {
  for (const n of candidates) {
    if (typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= 65535) return n;
  }
  return undefined;
}

function parsePortFromText(text: string | null): number | undefined {
  if (!text) return undefined;
  const patterns = [
    /process\.env\.PORT\)\s*\|\|\s*(\d{2,5})/,
    /PORT\s*=\s*Number\(\s*process\.env\.PORT\s*\)\s*\|\|\s*(\d{2,5})/,
    /(?:^|[\s"=])PORT\s*=\s*(\d{2,5})/im,
    /127\.0\.0\.1:(\d{2,5})/,
    /localhost:(\d{2,5})/i,
    /listen\(\s*(\d{2,5})\s*[,)]/,
    /:(\d{4,5})\b/
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1024 && n <= 65535) return n;
    }
  }
  return undefined;
}

function findStartBat(dir: string): string | null {
  for (const name of BAT_NAMES) {
    if (fs.existsSync(path.join(dir, name))) return name;
  }
  return null;
}

function looksLikeAppRoot(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "package.json")) ||
    findStartBat(dir) !== null ||
    fs.existsSync(path.join(dir, "server.js")) ||
    fs.existsSync(path.join(dir, "app.js")) ||
    fs.existsSync(path.join(dir, "index.js")) ||
    fs.existsSync(path.join(dir, "server", "index.js")) ||
    fs.existsSync(path.join(dir, "server", "package.json"))
  );
}

/** 展平失败残留、系统垃圾目录：计入「子目录数」会挡住剥外壳（曾导致整包被当成静态页）。 */
function isJunkDirName(name: string): boolean {
  if (name === "__MACOSX" || name === ".DS_Store" || name === ".git") return true;
  if (name.startsWith(".__flatten_")) return true;
  return false;
}

/** 外壳目录里可以放心随展平丢弃的说明文件 */
function isWrapperDocName(name: string): boolean {
  return /^(readme|license|licence|changelog)([._-].*)?\.(md|txt)$/i.test(name) || /^\.git(ignore|attributes)$/i.test(name);
}

/** 删掉历史上失败的 .__flatten_* 临时目录，避免永远无法 resolveGameRoot。 */
export function cleanupFlattenArtifacts(uploadDir: string) {
  if (!fs.existsSync(uploadDir)) return;
  let names: string[];
  try {
    names = fs.readdirSync(uploadDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(".__flatten_")) continue;
    try {
      fs.rmSync(path.join(uploadDir, name), { recursive: true, force: true });
    } catch {
      /* 可能仍被占用，下次再试 */
    }
  }
}

/**
 * 上传包常多包一层「源码包」目录；向内剥到真正含 package.json / server.js / start.bat 的根。
 */
export function resolveGameRoot(dir: string): string {
  if (!fs.existsSync(dir)) return dir;
  // 先清残留，否则 dirs.length!==1 会卡在外壳，后端游戏被误判为 static
  cleanupFlattenArtifacts(dir);
  let cur = dir;
  for (let depth = 0; depth < 5; depth++) {
    if (looksLikeAppRoot(cur)) return cur;
    let names: string[];
    try {
      names = fs.readdirSync(cur).filter((n) => !isJunkDirName(n));
    } catch {
      return cur;
    }
    const dirs: string[] = [];
    const files: string[] = [];
    for (const name of names) {
      try {
        if (fs.statSync(path.join(cur, name)).isDirectory()) dirs.push(name);
        else files.push(name);
      } catch {
        /* ignore */
      }
    }
    if (dirs.length !== 1) break;
    // 当前目录里有真实文件（如 index.html）时它本身就是游戏根；
    // 若继续下钻，展平会把根级文件当「外壳残留」删掉（曾导致静态包 index.html 被毁）。
    // 仅剩 README/LICENSE 等说明文件的外壳目录才允许继续剥。
    if (files.some((f) => !isWrapperDocName(f))) break;
    cur = path.join(cur, dirs[0]);
  }
  return cur;
}

function copyDirRecursive(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyDirRecursive(from, to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * 把「源码包/…」嵌套目录提升到 ug_xxx 根下，避免 /ug 路径与启动 cwd 不一致。
 * 仅在上传根下只有一层可剥外壳时移动。rename 失败时回退为 copy+删除。
 */
export function flattenNestedGameRoot(uploadDir: string): string {
  if (!fs.existsSync(uploadDir)) return uploadDir;
  cleanupFlattenArtifacts(uploadDir);
  const resolved = resolveGameRoot(uploadDir);
  if (resolved === uploadDir) return uploadDir;

  const rel = path.relative(uploadDir, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return uploadDir;

  // 只剥单链嵌套（a/ 或 a/b/），避免误伤多游戏目录
  const parts = rel.split(/[/\\]/).filter(Boolean);
  if (!parts.length || parts.length > 3) return uploadDir;

  const tmp = path.join(uploadDir, `.__flatten_${Date.now()}`);
  try {
    try {
      fs.renameSync(resolved, tmp);
    } catch {
      // Windows 下中文路径 / 文件锁时 rename 常失败：改为复制再删外壳
      copyDirRecursive(resolved, tmp);
      fs.rmSync(resolved, { recursive: true, force: true });
    }
    // 清掉空的中间外壳与其它残留（含更早失败留下的 .__flatten_*）
    for (const name of fs.readdirSync(uploadDir)) {
      const p = path.join(uploadDir, name);
      if (p === tmp) continue;
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    for (const name of fs.readdirSync(tmp)) {
      const from = path.join(tmp, name);
      const to = path.join(uploadDir, name);
      try {
        fs.renameSync(from, to);
      } catch {
        const st = fs.statSync(from);
        if (st.isDirectory()) copyDirRecursive(from, to);
        else fs.copyFileSync(from, to);
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (err) {
    console.warn("[hub] flattenNestedGameRoot failed:", err instanceof Error ? err.message : err);
    // 失败时：若原嵌套目录还在，丢掉临时目录，避免下次 dirs.length!==1
    try {
      if (fs.existsSync(resolved) && fs.existsSync(tmp)) {
        fs.rmSync(tmp, { recursive: true, force: true });
      } else if (fs.existsSync(tmp) && !fs.existsSync(resolved)) {
        fs.renameSync(tmp, resolved);
      }
    } catch {
      /* ignore */
    }
    cleanupFlattenArtifacts(uploadDir);
    return resolveGameRoot(uploadDir);
  }
  cleanupFlattenArtifacts(uploadDir);
  return uploadDir;
}


function pickRootNodeEntry(dir: string, pkgText: string | null): string | null {
  const candidates: string[] = [];
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { main?: string; scripts?: { start?: string } };
      if (pkg.main && /\.js$/i.test(pkg.main)) {
        candidates.push(String(pkg.main).replace(/^\.\//, "").replace(/\\/g, "/"));
      }
      const start = pkg.scripts?.start || "";
      const m = String(start).match(/\bnode\s+([.\w\\/-]+\.js)/i) || String(start).match(/([.\w\\/-]+\.js)/i);
      if (m) candidates.push(m[1].replace(/^\.\//, "").replace(/\\/g, "/"));
    } catch {
      /* ignore */
    }
  }
  candidates.push("server.js", "app.js", "index.js", "main.js");
  for (const rel of candidates) {
    if (!rel || rel.includes("..")) continue;
    if (fs.existsSync(path.join(dir, rel))) return rel;
  }
  return null;
}

/** Detect how an uploaded game folder should be launched. */
export function detectLaunchPlan(gameId: string): LaunchPlan {
  const uploadDir = gameDir(gameId);
  if (!fs.existsSync(uploadDir)) {
    return { kind: "static", cwd: uploadDir };
  }

  const dir = resolveGameRoot(uploadDir);
  const cwd = dir;

  const bat = findStartBat(dir);
  const serverPkg = path.join(dir, "server", "package.json");
  const rootPkg = path.join(dir, "package.json");
  const serverIndex = path.join(dir, "server", "index.js");
  const rootIndex = path.join(dir, "index.js");
  const rootServerJs = path.join(dir, "server.js");

  const batText = bat ? readTextIfExists(path.join(dir, bat)) : null;
  const serverIndexText = readTextIfExists(serverIndex);
  const rootIndexText = fs.existsSync(serverIndex) ? null : readTextIfExists(rootIndex);
  const rootServerText = readTextIfExists(rootServerJs);
  const serverPkgText = readTextIfExists(serverPkg);
  const rootPkgText = readTextIfExists(rootPkg);
  const rootNodeEntry = pickRootNodeEntry(dir, rootPkgText);

  const port = pickPort(
    parsePortFromText(batText),
    parsePortFromText(serverIndexText),
    parsePortFromText(rootServerText),
    parsePortFromText(rootIndexText),
    parsePortFromText(serverPkgText),
    parsePortFromText(rootPkgText)
  );

  const rootPackageDir = fs.existsSync(rootPkg) ? dir : undefined;
  const nestedServerPackageDir = fs.existsSync(serverPkg) ? path.join(dir, "server") : undefined;

  if (bat) {
    const nodeEntry = fs.existsSync(serverIndex)
      ? "server/index.js"
      : rootNodeEntry || undefined;
    const defaultPort = fs.existsSync(serverIndex) ? 8787 : rootNodeEntry ? 3000 : undefined;
    return {
      kind: "bat",
      startScript: bat,
      cwd,
      port: port || defaultPort,
      packageDir: nestedServerPackageDir || rootPackageDir,
      nodeEntry
    };
  }

  if (fs.existsSync(serverIndex) || (serverPkgText && /"start"\s*:/.test(serverPkgText))) {
    return {
      kind: "node",
      cwd: path.join(dir, "server"),
      port: port || 8787,
      nodeEntry: "index.js",
      packageDir: path.join(dir, "server")
    };
  }

  if (rootPkgText && /"start"\s*:/.test(rootPkgText) && rootNodeEntry) {
    return {
      kind: "node",
      cwd: dir,
      port: port || 3000,
      nodeEntry: rootNodeEntry,
      packageDir: dir
    };
  }

  // 无 package.json 的 start，但仍有根目录 server.js（部分源码包）
  if (rootNodeEntry && (rootNodeEntry === "server.js" || rootNodeEntry === "app.js")) {
    return {
      kind: "node",
      cwd: dir,
      port: port || 3000,
      nodeEntry: rootNodeEntry,
      packageDir: rootPackageDir || dir
    };
  }

  return { kind: "static", cwd };
}

export function userGameNeedsBackend(gameId: string): boolean {
  const plan = detectLaunchPlan(gameId);
  return plan.kind !== "static" && Boolean(plan.port);
}

function metaPath(cwd: string) {
  return path.join(cwd, RUNTIME_META);
}

function writeRuntimeMeta(cwd: string, gameId: string, port: number, pid?: number) {
  try {
    fs.writeFileSync(
      metaPath(cwd),
      JSON.stringify({ gameId, port, pid: pid || null, startedAt: Date.now() }),
      "utf8"
    );
  } catch {
    /* ignore */
  }
}

function readRuntimeMeta(cwd: string): { gameId?: string; port?: number; pid?: number } | null {
  try {
    const p = metaPath(cwd);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8")) as { gameId?: string; port?: number; pid?: number };
  } catch {
    return null;
  }
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        timeout: 1500
      },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** 确认端口上跑的是本游戏（避免误用桌面原版 / 其它占用 3000 的进程） */
async function isOurGameOnPort(gameId: string, cwd: string, port: number): Promise<boolean> {
  const st = runtimes.get(gameId);
  if (st && st.port === port) return isPortOpen(port);

  const meta = readRuntimeMeta(cwd);
  if (meta?.gameId === gameId && meta.port === port) {
    if (await isPortOpen(port)) return true;
  }

  // 无 meta 时：端口开着也不复用，防止连到「桌面源码包」等外来实例导致登录态/数据错乱
  return false;
}

function probePortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(preferred: number, gameId: string, cwd: string): Promise<number> {
  if (await isOurGameOnPort(gameId, cwd, preferred)) return preferred;
  if (await probePortFree(preferred)) return preferred;

  for (let delta = 1; delta <= 40; delta++) {
    const cand = preferred + delta;
    if (cand > 65535) break;
    if (await isOurGameOnPort(gameId, cwd, cand)) return cand;
    if (await probePortFree(cand)) return cand;
  }
  throw new Error(`端口 ${preferred} 及后续端口均被占用，请关闭占用进程后重试`);
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function readPackageDeps(packageDir: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(packageDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    return Object.keys(pkg.dependencies || {});
  } catch {
    return [];
  }
}

function depsSatisfied(packageDir: string): boolean {
  const deps = readPackageDeps(packageDir).filter((d) => !OPTIONAL_NATIVE_DEPS.has(d));
  if (!deps.length) return fs.existsSync(path.join(packageDir, "node_modules"));
  // 只要缺关键依赖就重装：仅判断 node_modules 是否存在会误判「已装好」
  return deps.every((name) => fs.existsSync(path.join(packageDir, "node_modules", name)));
}

/** npm 参数白名单：依赖名来自用户上传的 package.json，绝不能把 cmd 元字符带进命令行 */
const NPM_ARG_RE = /^[A-Za-z0-9@/._~+=:,-]+$/;

async function runNpmInstall(packageDir: string, extraArgs: string[] = []) {
  const args = ["install", "--no-fund", "--no-audit", ...extraArgs];
  for (const a of args) {
    if (!NPM_ARG_RE.test(a)) {
      throw new Error(`package.json 依赖名不合法，已拒绝安装：${a}`);
    }
  }
  if (process.platform === "win32") {
    await execFileAsync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", `npm ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`],
      {
        cwd: packageDir,
        windowsHide: true,
        timeout: 180000,
        maxBuffer: 8 * 1024 * 1024,
        env: process.env
      }
    );
    return;
  }
  await execFileAsync("npm", args, {
    cwd: packageDir,
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env
  });
}

async function ensureNpmDeps(packageDir: string) {
  const pkg = path.join(packageDir, "package.json");
  if (!fs.existsSync(pkg)) return;
  if (depsSatisfied(packageDir)) return;

  const allDeps = readPackageDeps(packageDir);
  const coreDeps = allDeps.filter((d) => !OPTIONAL_NATIVE_DEPS.has(d));
  const skipHeavy = coreDeps.length > 0 && coreDeps.length < allDeps.length;

  try {
    // 先跳过 playwright/sharp 等重依赖，避免首次打开卡死/超时
    if (skipHeavy) {
      await runNpmInstall(packageDir, ["--omit=dev", "--no-save", ...coreDeps]);
    } else {
      await runNpmInstall(packageDir, ["--omit=dev"]);
    }
  } catch (err) {
    // sharp / playwright 等原生或超大模块常失败：退化为只装 express 等核心包
    if (!coreDeps.length) throw err;
    await runNpmInstall(packageDir, ["--omit=dev", "--no-save", ...coreDeps]);
  }

  if (!depsSatisfied(packageDir)) {
    const missing = readPackageDeps(packageDir).filter(
      (name) => !fs.existsSync(path.join(packageDir, "node_modules", name))
    );
    // sharp / playwright 缺失通常仍可启动（相关功能降级）
    const critical = missing.filter((m) => !OPTIONAL_NATIVE_DEPS.has(m));
    if (critical.length) {
      throw new Error(`依赖不完整，缺少：${critical.join(", ")}`);
    }
  }
}

function spawnDetached(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: env || process.env,
    shell: false
  });
  child.unref();
  return child;
}

/** 子进程环境：固定 PORT，仅绑回环；局域网通过合集站 /ug 反代访问，避免和桌面原版抢 3000 直连。 */
function runtimeEnv(plan: LaunchPlan): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PORT: plan.port ? String(plan.port) : process.env.PORT,
    HOST: process.env.HUB_UG_HOST || "127.0.0.1",
    // 经合集站反代时识别 X-Forwarded-*，避免限流/会话 IP 异常
    TRUST_PROXY: process.env.TRUST_PROXY || "1",
    // 游戏内「测试连接」默认拒内网；合集站本地打开时放行自建 LLM
    ALLOW_LOCAL_AI: process.env.ALLOW_LOCAL_AI || "1"
  };
}

/** Spawn node with logged stderr so crash reasons aren't silent. */
function startNodeTracked(plan: LaunchPlan): { child: ReturnType<typeof spawn>; exitPromise: Promise<number | null> } {
  const entry = plan.nodeEntry || "index.js";
  const abs = path.join(plan.cwd, entry);
  if (!fs.existsSync(abs)) throw new Error(`未找到入口 ${entry}`);
  const outLog = path.join(plan.cwd, ".hub-runtime.log");
  const out = fs.openSync(outLog, "w");
  const child = spawn(process.execPath, [abs], {
    cwd: plan.cwd,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    env: runtimeEnv(plan),
    shell: false
  });
  child.unref();
  // 句柄已交给子进程，父进程必须关闭，否则每次启动泄漏一个 fd
  fs.closeSync(out);
  const exitPromise = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(1));
  });
  return { child, exitPromise };
}

function startBat(plan: LaunchPlan) {
  if (!plan.startScript) throw new Error("缺少 start.bat");
  const batAbs = path.join(plan.cwd, plan.startScript);
  if (!fs.existsSync(batAbs)) throw new Error(`未找到 ${plan.startScript}`);

  if (process.platform === "win32") {
    // /c 执行 bat；detached 后合集站不阻塞；windowsHide 避免弹出黑窗抢焦点
    return spawnDetached("cmd.exe", ["/c", batAbs], plan.cwd, runtimeEnv(plan));
  }
  return spawnDetached("bash", [batAbs], plan.cwd, runtimeEnv(plan));
}

function startNode(plan: LaunchPlan) {
  return startNodeTracked(plan).child;
}

function readRuntimeLog(cwd: string): string {
  try {
    const p = path.join(cwd, ".hub-runtime.log");
    if (!fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf8").trim().slice(-500);
  } catch {
    return "";
  }
}

async function waitForPortOrExit(
  port: number,
  timeoutMs: number,
  exitPromise?: Promise<number | null>
): Promise<{ ok: boolean; exitCode?: number | null }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(port)) return { ok: true };
    if (exitPromise) {
      const raced = await Promise.race([
        exitPromise.then((code) => ({ done: true as const, code })),
        new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), 400))
      ]);
      if (raced.done) return { ok: false, exitCode: raced.code };
    } else {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return { ok: false };
}

export function stopUserGameRuntime(gameId: string) {
  const st = runtimes.get(gameId);
  const plan = detectLaunchPlan(gameId);
  const meta = readRuntimeMeta(plan.cwd);
  const pid = st?.pid || meta?.pid;

  if (!pid) {
    runtimes.delete(gameId);
    try {
      fs.unlinkSync(metaPath(plan.cwd));
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      }).unref();
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    /* ignore */
  }
  runtimes.delete(gameId);
  try {
    fs.unlinkSync(metaPath(plan.cwd));
  } catch {
    /* ignore */
  }
}

export function hasUserGameRuntime(gameId: string): boolean {
  const st = runtimes.get(gameId);
  return Boolean(st?.pid);
}

/** Port of the spawned game process (memory, else .hub-ug-runtime.json). */
export function resolveUserGamePort(gameId: string): number | undefined {
  const st = runtimes.get(gameId);
  if (st?.port) return st.port;
  const plan = detectLaunchPlan(gameId);
  const meta = readRuntimeMeta(plan.cwd);
  if (meta?.gameId === gameId && meta.port) return meta.port;
  return undefined;
}

function pickHubEntry(cwd: string, entryFile: string): string {
  if (fs.existsSync(path.join(cwd, "login.html"))) return "login.html";
  const base = path.basename(entryFile || "index.html") || "index.html";
  if (fs.existsSync(path.join(cwd, base))) return base;
  if (fs.existsSync(path.join(cwd, "index.html"))) return "index.html";
  return base;
}

function hubPlayUrl(gameId: string, cwd: string, entryFile: string): string {
  const entry = pickHubEntry(cwd, entryFile);
  return `/ug/${gameId}/${entry}?v=${Date.now()}`;
}

function resolveEffectivePlan(plan: LaunchPlan): LaunchPlan {
  // Prefer Node over start.bat when possible:
  // bat 常会弹新浏览器、pause，甚至再次 npm install，拖垮合集站请求。
  if (plan.kind !== "bat" || !plan.packageDir) return plan;
  const pkgDir = plan.packageDir;

  let entryFile: string | null = null;
  if (plan.nodeEntry) {
    const asRelativeToPkg = plan.nodeEntry.replace(/^server\//, "");
    if (fs.existsSync(path.join(pkgDir, plan.nodeEntry))) {
      entryFile = plan.nodeEntry;
    } else if (fs.existsSync(path.join(pkgDir, asRelativeToPkg))) {
      entryFile = asRelativeToPkg;
    } else if (fs.existsSync(path.join(pkgDir, path.basename(plan.nodeEntry)))) {
      entryFile = path.basename(plan.nodeEntry);
    }
  }
  if (!entryFile) {
    for (const name of ["index.js", "server.js", "app.js"]) {
      if (fs.existsSync(path.join(pkgDir, name))) {
        entryFile = name;
        break;
      }
    }
  }
  if (!entryFile) return plan;
  return {
    ...plan,
    kind: "node",
    cwd: pkgDir,
    nodeEntry: entryFile
  };
}

/**
 * 上传后预装依赖（后台），避免玩家首次打开时卡在 npm install。
 */
/** 去掉合集站上传时注入的 GameHub SDK（后端游戏自有登录，注入会干扰 CSP/脚本）。 */
function stripInjectedHubSdk(cwd: string) {
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "node_modules" || name === ".git") continue;
      const abs = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.html?$/i.test(name)) continue;
      let html: string;
      try {
        html = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (!html.includes("window.GameHub")) continue;
      const cleaned = html.replace(
        /<script>\s*\(function \(\) \{\s*var user = null;[\s\S]*?window\.GameHub[\s\S]*?<\/script>\s*/m,
        ""
      );
      if (cleaned !== html) {
        try {
          fs.writeFileSync(abs, cleaned, "utf8");
        } catch {
          /* ignore locked files */
        }
      }
    }
  };
  walk(cwd);
}

export function prepareUserGameDeps(gameId: string): Promise<void> {
  const existing = prepInflight.get(gameId);
  if (existing) return existing;

  const job = (async () => {
    const plan = resolveEffectivePlan(detectLaunchPlan(gameId));
    if (!plan.packageDir) return;
    try {
      await ensureNpmDeps(plan.packageDir);
    } catch (err) {
      console.warn(
        `[hub] 预装依赖失败 ${gameId}:`,
        err instanceof Error ? err.message : err
      );
    }
  })().finally(() => {
    prepInflight.delete(gameId);
  });

  prepInflight.set(gameId, job);
  return job;
}

/**
 * Ensure backend (start.bat / node) is running, then return the URL to open.
 * @param host Hostname the browser used to reach the hub (so LAN clients get the right IP).
 */
export async function ensureUserGameRuntime(
  gameId: string,
  host = "127.0.0.1",
  entryFile = "index.html"
): Promise<EnsureRuntimeResult> {
  const existing = inflight.get(gameId);
  if (existing) return existing;

  const job = ensureUserGameRuntimeOnce(gameId, host, entryFile).finally(() => {
    inflight.delete(gameId);
  });
  inflight.set(gameId, job);
  return job;
}

async function ensureUserGameRuntimeOnce(
  gameId: string,
  host: string,
  entryFile: string
): Promise<EnsureRuntimeResult> {
  // 修复历史上未能展平的「源码包」嵌套，保证 /ug/id/login.html 与启动 cwd 一致
  const uploadDir = gameDir(gameId);
  if (fs.existsSync(uploadDir)) {
    cleanupFlattenArtifacts(uploadDir);
    if (resolveGameRoot(uploadDir) !== uploadDir) {
      try {
        stopUserGameRuntime(gameId);
        await new Promise((r) => setTimeout(r, 800));
        flattenNestedGameRoot(uploadDir);
      } catch (err) {
        console.warn(
          `[hub] 展平嵌套包失败 ${gameId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  const plan = detectLaunchPlan(gameId);
  const entryBase = path.basename(entryFile || "index.html") || "index.html";
  const staticUrl = `/ug/${gameId}/${entryBase}`;

  if (plan.kind === "static" || !plan.port) {
    return {
      playUrl: staticUrl,
      started: false,
      mode: "static",
      openHow: `浏览器打开 ${entryBase}`
    };
  }

  const preferredPort = plan.port;
  let effective = resolveEffectivePlan(plan);
  const port = await findAvailablePort(preferredPort, gameId, effective.cwd);
  effective = { ...effective, port };

  // 同源 /ug 反代：页面上的 /api/auth/login、/api/auth/demo 才会打到游戏后端，而不是合集站
  const playUrl = hubPlayUrl(gameId, effective.cwd, entryBase);

  if (await isOurGameOnPort(gameId, effective.cwd, effective.port!)) {
    runtimes.set(gameId, {
      port: effective.port!,
      pid: runtimes.get(gameId)?.pid ?? readRuntimeMeta(effective.cwd)?.pid,
      startedAt: runtimes.get(gameId)?.startedAt || Date.now(),
      kind: effective.kind === "bat" ? "bat" : "node"
    });
    return {
      playUrl,
      started: false,
      mode: effective.kind,
      port: effective.port,
      openExternal: false,
      openHow:
        effective.kind === "bat"
          ? `已运行 · ${effective.startScript}`
          : `已运行 · 后端端口 ${effective.port}`
    };
  }

  // 若上传后的预装还在跑，先等它完成，避免并发两次 npm install
  const prep = prepInflight.get(gameId);
  if (prep) {
    try {
      await prep;
    } catch {
      /* prepareUserGameDeps 已吞错；下面再试一次 */
    }
  }

  stripInjectedHubSdk(effective.cwd);

  // Prefer installing deps before bat/node so first launch succeeds
  if (effective.packageDir) {
    try {
      await ensureNpmDeps(effective.packageDir);
    } catch (err) {
      throw new Error(
        `依赖安装失败：${err instanceof Error ? err.message : String(err)}（请在游戏目录手动 npm install）`
      );
    }
  }

  let child: ReturnType<typeof spawn>;
  let exitPromise: Promise<number | null> | undefined;
  try {
    if (effective.kind === "bat") {
      child = startBat(effective);
    } else {
      const tracked = startNodeTracked(effective);
      child = tracked.child;
      exitPromise = tracked.exitPromise;
    }
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "启动游戏服务失败");
  }

  writeRuntimeMeta(effective.cwd, gameId, effective.port!, child.pid);
  runtimes.set(gameId, {
    port: effective.port!,
    pid: child.pid,
    startedAt: Date.now(),
    kind: effective.kind === "bat" ? "bat" : "node"
  });
  if (exitPromise) {
    void exitPromise.then(() => {
      // 进程已退出：清掉内存态，避免自检/复用把死进程当成仍在运行
      const cur = runtimes.get(gameId);
      if (cur && cur.pid === child.pid) runtimes.delete(gameId);
    });
  }

  let waited = await waitForPortOrExit(effective.port!, 60000, exitPromise);
  let ok = waited.ok;

  // Node 秒退：把日志带回给用户，避免干等两分钟
  if (!ok && effective.kind === "node" && waited.exitCode != null) {
    const log = readRuntimeLog(effective.cwd);
    throw new Error(
      log
        ? `游戏服务启动失败：\n${log}`
        : `游戏服务进程已退出（代码 ${waited.exitCode}），请检查该游戏依赖是否完整`
    );
  }

  // start.bat 异常时回退直启 Node（沿用已解析的 nodeEntry，勿写死 index.js）
  if (!ok && effective.kind === "bat" && effective.packageDir) {
    // 先终止仍在运行的 start.bat：它可能只是启动慢，
    // 若不杀掉，回退的 Node 与它稍后抢同一端口会出现双实例
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 500));
    try {
      const fallbackEntry =
        effective.nodeEntry && fs.existsSync(path.join(effective.packageDir, effective.nodeEntry))
          ? effective.nodeEntry
          : ["server.js", "index.js", "app.js"].find((n) =>
              fs.existsSync(path.join(effective.packageDir!, n))
            );
      if (!fallbackEntry) {
        throw new Error("未找到可回退的 Node 入口（server.js / index.js）");
      }
      const tracked = startNodeTracked({
        ...effective,
        kind: "node",
        cwd: effective.packageDir,
        nodeEntry: fallbackEntry
      });
      child = tracked.child;
      exitPromise = tracked.exitPromise;
      // meta 同时写进 Node 实际 cwd 与游戏根：重启合集站后读取方按游戏根查找
      writeRuntimeMeta(effective.packageDir, gameId, effective.port!, child.pid);
      writeRuntimeMeta(effective.cwd, gameId, effective.port!, child.pid);
      runtimes.set(gameId, {
        port: effective.port!,
        pid: child.pid,
        startedAt: Date.now(),
        kind: "node"
      });
      if (exitPromise) {
        void exitPromise.then(() => {
          const cur = runtimes.get(gameId);
          if (cur && cur.pid === child.pid) runtimes.delete(gameId);
        });
      }
      waited = await waitForPortOrExit(effective.port!, 45000, exitPromise);
      ok = waited.ok;
      if (!ok && waited.exitCode != null) {
        const log = readRuntimeLog(effective.packageDir);
        throw new Error(
          log ? `游戏服务启动失败：\n${log}` : `游戏服务进程已退出（代码 ${waited.exitCode}）`
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("游戏服务")) throw err;
    }
  }

  if (!ok) {
    throw new Error(
      effective.kind === "bat"
        ? `已执行 ${effective.startScript}，但端口 ${effective.port} 未在时限内就绪，请检查该游戏的 start.bat`
        : `已启动 Node 服务，但端口 ${effective.port} 未在时限内就绪`
    );
  }

  return {
    playUrl,
    started: true,
    mode: effective.kind,
    port: effective.port,
    openExternal: false,
    openHow:
      effective.kind === "bat"
        ? `自动运行 ${effective.startScript}`
        : `自动启动后端（端口 ${effective.port}）`
  };
}
