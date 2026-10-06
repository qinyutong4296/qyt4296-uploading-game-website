/* ============================================================
 * 投影回廊 · 账号与进度同步（前端）
 *
 *  · 启动先选画质（性能检测推荐，用户自选），再进入登录
 *  · 登录界面 UI 控制（登录 / 注册 / 游客 三种进入方式）
 *  · 进度双通道：登录用户 → 本地 + 服务器 双写（服务器故障自动降级本地）
 *  · 登录时合并本地与云端进度（章节取最大、星级取最高、步数取最少）
 *  · 注册的新账号从第一章空白开档，不继承本机游客进度
 *
 *  对 main.js 暴露 window.Auth：
 *    Auth.progress            当前生效进度 { unlocked, records, steles }
 *    Auth.user                当前用户（游客为 null）
 *    Auth.isOnline()          本地服务器是否可达
 *    Auth.isActive()          登录/画质选择界面是否正在显示（游戏中屏蔽按键）
 *    Auth.commit(fn)          修改进度并持久化（本地立即 / 云端防抖推送）
 *    Auth.onReady(cb)         进入游戏（登录/注册/游客/退出重进）时回调
 *    Auth.onProgress(cb)      进度变化时回调（刷新 HUD）
 *    Auth.logout()            退出登录回到登录界面
 * ============================================================ */
'use strict';

window.Auth = (function () {

  const PORT = 8940;
  const LS_TOKEN = 'pcorridor.token';
  const LS_USER = 'pcorridor.lastUser';             // 仅预填用户名，不再自动免密进游戏
  const LS_PROGRESS = 'pcorridor.progress';
  const LS_PROGRESS_GUEST = 'pcorridor.progress.guest'; // 注册时空档会话前备份本机游客档
  const LS_LEGACY_UNLOCKED = 'pcorridor.unlocked';   // 旧版本存档迁移
  const LS_API = 'pcorridor.api';                   // 其它电脑上填写的主机地址
  const LS_GFX = 'pcorridor.gfx';
  const GFX_LABELS = { low: '流畅', mid: '均衡', high: '高清' };

  function isLoopbackHost(h) {
    h = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
    return !h || h === 'localhost' || h === '127.0.0.1' || h === '::1';
  }
  function normalizeApi(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    try {
      const u = new URL(s);
      if (!u.hostname) return '';
      // 丢掉 /index.html 等路径，只保留协议+主机+端口（默认 8940）
      const port = u.port || String(PORT);
      return u.protocol + '//' + u.hostname + ':' + port;
    } catch (e) {
      return '';
    }
  }
  function savedRemoteApi() {
    try { return normalizeApi(localStorage.getItem(LS_API) || ''); } catch (e) { return ''; }
  }
  function persistRemoteApi(url) {
    try {
      if (url) localStorage.setItem(LS_API, url);
      else localStorage.removeItem(LS_API);
    } catch (e) { }
  }
  // 经 HTTP 打开时用同源（本机或局域网主机）；file:// 时用本机或手动填写的主机
  function resolveApiBase() {
    try {
      const q = new URLSearchParams(window.location.search).get('server');
      if (q) return normalizeApi(q);
    } catch (e) { }
    try {
      const loc = window.location;
      if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:')) {
        return loc.origin;
      }
    } catch (e) { }
    const saved = savedRemoteApi();
    if (saved) return saved;
    return 'http://127.0.0.1:' + PORT;
  }
  let API = resolveApiBase();

  const el = id => document.getElementById(id);
  let user = null;
  let token = null;
  let lastEnterMode = 'guest';   // 'register' | 'login' | 'auto' | 'guest'
  let progress = { unlocked: 0, records: {}, steles: {} };
  let online = null;              // null = 检测中
  let entered = false;            // 是否已进入游戏（登录界面已隐藏）
  let gfxPickDone = false;        // 本会话是否已确认画质
  let gfxPickSelected = 'mid';
  let gfxPickRecommend = 'mid';
  const readyCbs = [], progressCbs = [];
  let pushTimer = null, pushDirty = false, pushing = false;

  // ------------------------------------------------ 工具
  function fetchTimeout(url, opts, ms) {
    opts = opts || {};
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms || 4000);
    return fetch(url, Object.assign({}, opts, { signal: ac.signal }))
      .finally(() => clearTimeout(timer));
  }
  function apiUrl(path) {
    return API + path;
  }
  function localProgress() {
    try {
      const raw = localStorage.getItem(LS_PROGRESS);
      if (raw) return JSON.parse(raw);
    } catch (e) { }
    // 旧版本迁移：只有 pcorridor.unlocked 一个数字
    const legacy = parseInt(localStorage.getItem(LS_LEGACY_UNLOCKED) || '', 10);
    if (!isNaN(legacy)) return { unlocked: legacy, records: {}, steles: {} };
    return null;
  }
  function persistLocal() {
    try { localStorage.setItem(LS_PROGRESS, JSON.stringify(progress)); } catch (e) { }
  }
  // 合并两份进度：章节取最大；每章星级取最高、步数取最少、星屑取最多
  function mergeProgress(a, b) {
    a = a || { unlocked: 0, records: {}, steles: {} };
    b = b || { unlocked: 0, records: {}, steles: {} };
    const out = {
      unlocked: Math.max(a.unlocked || 0, b.unlocked || 0),
      records: {},
      steles: Object.assign({}, a.steles || {}, b.steles || {})
    };
    const keys = new Set(Object.keys(a.records || {}).concat(Object.keys(b.records || {})));
    keys.forEach(k => {
      const ra = (a.records || {})[k] || {}, rb = (b.records || {})[k] || {};
      out.records[k] = {
        stars: Math.max(ra.stars || 0, rb.stars || 0),
        switches: Math.min(ra.switches == null ? 1e9 : ra.switches, rb.switches == null ? 1e9 : rb.switches),
        keys: Math.max(ra.keys || 0, rb.keys || 0)
      };
      if (out.records[k].switches >= 1e9) out.records[k].switches = null;
    });
    return out;
  }

  // 启动时先载入本机进度，避免登录前 commit / ?level= 把存档冲成空档
  (() => {
    const local = localProgress();
    if (local) progress = mergeProgress(progress, local);
  })();

  // ------------------------------------------------ 服务器交互
  async function pingOnce(base) {
    const r = await fetchTimeout(base + '/api/ping', { method: 'GET' }, 2500);
    if (!r.ok) throw new Error('ping not ok');
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!data || data.ok !== true) throw new Error('bad ping payload');
    // PowerShell 离线游客服务也会响应 ping，但 mode=offline → 不算在线存档
    if (data.mode === 'offline') {
      const err = new Error('offline guest server');
      err.offlineGuest = true;
      throw err;
    }
    return true;
  }
  async function ping() {
    API = resolveApiBase();
    const candidates = [];
    const pushCand = (u) => { if (u != null && candidates.indexOf(u) < 0) candidates.push(u); };
    let onRemotePage = false;
    try {
      onRemotePage = (location.protocol === 'http:' || location.protocol === 'https:') &&
        !isLoopbackHost(location.hostname);
    } catch (e) { }
    try {
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        pushCand(location.origin);
      }
    } catch (e) { }
    // 本机独立启动：先探本机服务。合集站嵌入时不探 8940，避免误连桌面版后台。
    if (!onRemotePage && !isHubEmbed()) {
      pushCand('http://127.0.0.1:' + PORT);
      pushCand('http://localhost:' + PORT);
    }
    pushCand(API);
    online = false;
    let sawOfflineGuest = false;
    for (let attempt = 0; attempt < 4 && !online; attempt++) {
      for (let i = 0; i < candidates.length; i++) {
        try {
          await pingOnce(candidates[i]);
          API = candidates[i];
          online = true;
          break;
        } catch (e) {
          if (e && e.offlineGuest) sawOfflineGuest = true;
        }
      }
      if (!online && attempt < 3) {
        await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
      }
    }
    updateStatusUI();
    if (!online && sawOfflineGuest) {
      const txt = el('auth-status-text');
      if (txt) txt.textContent = '离线游客服务已连接 · 可玩，进度仅本机（不可注册登录）';
    }
    return online;
  }
  function pushRemote(immediate) {
    if (!token || !online) return;
    pushDirty = true;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(doPush, immediate ? 0 : 900);
  }
  async function doPush() {
    if (!token || !pushDirty || pushing) return;
    pushing = true; pushDirty = false;
    try {
      const r = await fetchTimeout(apiUrl('/api/progress'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ progress: progress })
      }, 5000);
      if (!r.ok) throw new Error('push failed');
    } catch (e) {
      pushDirty = true;            // 失败留下次再推
      // 短暂掉线：稍后重试；连续失败不永久卡死 pushing
      setTimeout(() => {
        pushing = false;
        if (token && pushDirty) pushRemote(true);
      }, 8000);
      return;
    }
    pushing = false;
  }

  // ------------------------------------------------ 进入 / 退出
  function enterGame(u, t, serverProgress, mode) {
    user = u || null;
    token = t || null;
    lastEnterMode = mode || 'guest';
    const local = localProgress();
    if (mode === 'register') {
      // 新账号会话从空档开始（不继承）；本机游客档备份到旁路 key，勿覆盖 pcorridor.progress
      if (local) {
        try { localStorage.setItem(LS_PROGRESS_GUEST, JSON.stringify(local)); } catch (e) { }
      }
      progress = { unlocked: 0, records: {}, steles: {} };
    } else if (t) {
      progress = mergeProgress(local, serverProgress);
    } else {
      progress = local || { unlocked: 0, records: {}, steles: {} };
    }
    if (t) {
      // 注册：跳过 persistLocal，避免把空档写进本机游客槽；登录仍双写本地
      if (mode !== 'register') persistLocal();
      try { localStorage.setItem(LS_TOKEN, t); } catch (e) { }
      try {
        if (u && u.username) localStorage.setItem(LS_USER, u.username);
      } catch (e) { }
      pushRemote(true);
    }
    hideAuthUI();
    entered = true;
    fireReady();
  }
  function fireReady() { readyCbs.forEach(cb => { try { cb(); } catch (e) { } }); }
  function fireProgress() { progressCbs.forEach(cb => { try { cb(); } catch (e) { } }); }

  // 回到登录界面（登录用户注销令牌；游客直接退出）
  async function logout() {
    const oldToken = token;
    // 先清本机会话，避免关窗口/刷新时仍带着令牌被误判为已登录
    token = null; user = null; entered = false;
    lastEnterMode = 'guest';
    try { localStorage.removeItem(LS_TOKEN); } catch (e) { }
    if (oldToken) {
      try {
        await fetchTimeout(apiUrl('/api/logout'), {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + oldToken }
        }, 2500);
      } catch (e) { }
    }
    // 注册时若备份过游客档，退出后写回本机槽，避免游客进度被账号会话冲掉
    try {
      const guestRaw = localStorage.getItem(LS_PROGRESS_GUEST);
      if (guestRaw) {
        localStorage.setItem(LS_PROGRESS, guestRaw);
        localStorage.removeItem(LS_PROGRESS_GUEST);
      }
    } catch (e) { }
    progress = localProgress() || { unlocked: 0, records: {}, steles: {} };
    const menu = el('player-menu');
    if (menu) menu.classList.remove('show');
    showAuthUI('login');
    // 回到登录页后重新探测，恢复局域网分享条
    ping().catch(() => { });
    // 不 fireReady：还在登录页，等再次进入游戏再通知
  }

  // 轻悬停音（登录按钮）；失败时静默，绝不打断 UI 绑定
  function bindAuthHoverSounds() {
    try {
      let lastHover = 0;
      const targets = [el('auth-submit'), el('auth-guest')].filter(Boolean)
        .concat(Array.from(document.querySelectorAll('.auth-tab')));
      targets.forEach(btn => {
        if (!btn) return;
        btn.addEventListener('mouseenter', () => {
          const now = Date.now();
          if (now - lastHover < 120) return;
          lastHover = now;
          try {
            if (window.sfx && typeof window.sfx.hover === 'function') window.sfx.hover();
          } catch (e) { }
        });
      });
    } catch (e) { }
  }

  // ------------------------------------------------ 登录氛围背景（本机种子 · 每台电脑不同 · 持续动态）
  const LS_MACHINE = 'pcorridor.machine';
  let authBgRaf = 0;
  let authBgParts = null;
  let authBgSeed = 0;

  function machineSeed() {
    try {
      let id = localStorage.getItem(LS_MACHINE);
      if (!id) {
        id = 'm:' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) +
          ':' + (screen.width | 0) + 'x' + (screen.height | 0);
        localStorage.setItem(LS_MACHINE, id);
      }
      let h = 2166136261;
      for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      // 混入分辨率，同账号拷到另一台显示器也会略有差异
      h ^= Math.imul(screen.width || 1, 2654435761);
      h ^= Math.imul(screen.height || 1, 1597334677);
      return h >>> 0;
    } catch (e) {
      return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    }
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hsl(h, s, l, a) {
    return 'hsla(' + (h % 360) + ',' + s + '%,' + l + '%,' + (a == null ? 1 : a) + ')';
  }
  function applyAuthTheme(rng) {
    const root = el('auth');
    if (!root) return;
    const hueBase = (rng() * 360) | 0;
    const cool = (hueBase + 160 + rng() * 40) % 360;
    const warm = (hueBase + 20 + rng() * 30) % 360;
    const gold = (hueBase + 45 + rng() * 25) % 360;
    const set = (k, v) => root.style.setProperty(k, v);
    set('--auth-sky-1', hsl(cool, 18, 22 + rng() * 8));
    set('--auth-sky-2', hsl(cool + 12, 20, 16 + rng() * 6));
    set('--auth-sky-3', hsl(cool + 24, 22, 11 + rng() * 5));
    set('--auth-sky-angle', (140 + rng() * 50) + 'deg');
    set('--auth-glow-warm', hsl(warm, 55, 82, 0.42 + rng() * 0.2));
    set('--auth-glow-cool', hsl(cool, 48, 52, 0.22 + rng() * 0.18));
    set('--auth-glow-gold', hsl(gold, 50, 58, 0.18 + rng() * 0.16));
    set('--auth-glow-x', (30 + rng() * 40) + '%');
    set('--auth-glow-y', (10 + rng() * 22) + '%');
    set('--auth-orb1-x', (55 + rng() * 35) + '%');
    set('--auth-orb1-y', (55 + rng() * 30) + '%');
    set('--auth-orb2-x', (5 + rng() * 30) + '%');
    set('--auth-orb2-y', (60 + rng() * 30) + '%');
    set('--auth-grid-size', (42 + rng() * 28) + 'px');
    set('--auth-grid-tilt', (54 + rng() * 16) + 'deg');
    set('--auth-persp', (420 + rng() * 220) + 'px');
    set('--auth-grid-speed', (18 + rng() * 22) + 's');
    set('--auth-grid-op', (0.45 + rng() * 0.4).toFixed(2));
    set('--auth-grid-line', 'rgba(255,248,236,' + (0.07 + rng() * 0.1).toFixed(2) + ')');
    set('--auth-path-rx', (50 + rng() * 16) + 'deg');
    set('--auth-path-rz', (-38 + rng() * 24) + 'deg');
    set('--auth-path-a', 'rgba(255,250,240,' + (0.22 + rng() * 0.25).toFixed(2) + ')');
    set('--auth-path-b', hsl(gold, 55, 55, 0.1 + rng() * 0.16));
    set('--auth-spark', hsl(gold, 70, 58));
    set('--auth-spark2', hsl(cool, 55, 48));
    set('--auth-spark-glow', hsl(gold, 70, 55, 0.45 + rng() * 0.25));
    set('--auth-float-y', (-8 - rng() * 14) + 'px');
    set('--auth-float-s', (6 + rng() * 6) + 's');
    set('--auth-pulse-s', (2.2 + rng() * 2) + 's');
    set('--auth-orb1-c', hsl(cool, 55, 55, 0.4 + rng() * 0.25));
    set('--auth-orb2-c', hsl(gold, 60, 55, 0.3 + rng() * 0.25));
    set('--auth-orb1-size', (200 + rng() * 160) + 'px');
    set('--auth-orb2-size', (220 + rng() * 180) + 'px');
    set('--auth-orb1-top', (2 + rng() * 18) + '%');
    set('--auth-orb1-left', (-8 + rng() * 14) + '%');
    set('--auth-orb2-bot', (0 + rng() * 12) + '%');
    set('--auth-orb2-right', (-10 + rng() * 16) + '%');
    set('--auth-orb-s', (9 + rng() * 10) + 's');
    set('--auth-orb2-s', (11 + rng() * 12) + 's');
    set('--auth-orb-dx', (10 + rng() * 24) + 'px');
    set('--auth-orb-dy', (-20 + rng() * 12) + 'px');
    set('--auth-ring1', (180 + rng() * 140) + 'px');
    set('--auth-ring2', (110 + rng() * 90) + 'px');
    set('--auth-ring1-top', (4 + rng() * 16) + '%');
    set('--auth-ring1-right', (2 + rng() * 14) + '%');
    set('--auth-ring2-bot', (6 + rng() * 16) + '%');
    set('--auth-ring2-left', (3 + rng() * 14) + '%');
    set('--auth-spin1', (28 + rng() * 40) + 's');
    set('--auth-spin2', (22 + rng() * 30) + 's');
    set('--auth-g1-top', (10 + rng() * 20) + '%');
    set('--auth-g1-left', (6 + rng() * 20) + '%');
    set('--auth-g2-bot', (12 + rng() * 22) + '%');
    set('--auth-g2-right', (8 + rng() * 20) + '%');
  }
  function buildAuthPaths(rng) {
    const box = el('auth-path');
    if (!box) return;
    box.innerHTML = '';
    const n = 4 + ((rng() * 4) | 0);
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span');
      s.className = 'ap';
      const w = 90 + rng() * 340;
      const h = 18 + rng() * 28;
      s.style.width = Math.min(w, window.innerWidth * (0.28 + rng() * 0.45)) + 'px';
      s.style.height = h + 'px';
      s.style.top = (32 + rng() * 40) + '%';
      s.style.left = (6 + rng() * 70) + '%';
      s.style.opacity = String(0.35 + rng() * 0.5);
      s.style.setProperty('--auth-float-d', (-rng() * 6).toFixed(2) + 's');
      s.style.animationDuration = (6 + rng() * 7).toFixed(2) + 's';
      if (rng() > 0.55) s.style.animationDirection = 'reverse';
      box.appendChild(s);
    }
    const spark = document.createElement('span');
    spark.className = 'ap is-spark';
    const sz = 12 + rng() * 14;
    spark.style.width = spark.style.height = sz + 'px';
    spark.style.top = (40 + rng() * 20) + '%';
    spark.style.left = (35 + rng() * 30) + '%';
    box.appendChild(spark);
  }
  function authPerfTier() {
    // 0=省电 1=中等 2=完整；与主游戏画质共用，默认偏省电（访客机）
    try {
      const pref = localStorage.getItem('pcorridor.gfx');
      if (pref === 'low') return 0;
      if (pref === 'mid') return 1;
      if (pref === 'high') return 2;
    } catch (e) { }
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
    } catch (e) { }
    const mem = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : 4;
    const cores = navigator.hardwareConcurrency || 4;
    const dpr = window.devicePixelRatio || 1;
    let gpuLow = false;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          const ren = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '').toLowerCase();
          if (/intel|uhd|iris|hd graphics|mali|adreno|apple gpu|swiftshader|llvmpipe|microsoft basic|radeon\(tm\) graphics|vega/.test(ren)) {
            gpuLow = true;
          }
        }
      }
    } catch (e) { }
    if (gpuLow || mem <= 8 || cores <= 8 || dpr >= 1.5) return 0;
    if (mem <= 16 || cores <= 12) return 1;
    return 2;
  }
  function makeAuthParticles(rng, w, h) {
    const list = [];
    const tier = authPerfTier();
    const count = tier === 0 ? 8 + ((rng() * 8) | 0)
      : tier === 1 ? 16 + ((rng() * 12) | 0)
      : 22 + ((rng() * 18) | 0);
    for (let i = 0; i < count; i++) {
      list.push({
        x: rng() * w,
        y: rng() * h,
        r: 0.6 + rng() * 2.4,
        vx: -0.15 + rng() * 0.3,
        vy: -0.35 - rng() * 0.55,
        a: 0.15 + rng() * 0.55,
        hue: (rng() * 360) | 0,
        tw: rng() * Math.PI * 2,
        ts: 0.8 + rng() * 1.8
      });
    }
    return list;
  }
  function stopAuthBackdrop() {
    if (authBgRaf) {
      cancelAnimationFrame(authBgRaf);
      authBgRaf = 0;
    }
  }
  function startAuthBackdrop() {
    stopAuthBackdrop();
    authBgSeed = machineSeed();
    const rng = mulberry32(authBgSeed);
    applyAuthTheme(rng);
    buildAuthPaths(mulberry32(authBgSeed ^ 0x9e3779b9));
    const canvas = el('auth-canvas');
    if (!canvas) return;
    const tier = authPerfTier();
    // 流畅/均衡：不跑 canvas 粒子（CSS 已静态化），少占访客机 CPU
    if (tier <= 1) {
      canvas.style.display = 'none';
      authBgParts = null;
      return;
    }
    canvas.style.display = '';
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    let w = 0, h = 0, dpr = 1;
    let frameSkip = 0;
    function resize() {
      // 登录装饰层不必跟系统 DPR 拉满，弱机限 1
      dpr = Math.min(window.devicePixelRatio || 1, tier === 0 ? 1 : 1.25);
      w = canvas.clientWidth || window.innerWidth;
      h = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.max(1, (w * dpr) | 0);
      canvas.height = Math.max(1, (h * dpr) | 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      authBgParts = makeAuthParticles(mulberry32(authBgSeed ^ 0x85ebca6b), w, h);
    }
    resize();
    const onResize = () => { if (!document.body.classList.contains('auth-open')) return; resize(); };
    window.removeEventListener('resize', onResize);
    window.addEventListener('resize', onResize);
    let t0 = performance.now();
    function frame(now) {
      if (!document.body.classList.contains('auth-open')) {
        authBgRaf = 0;
        return;
      }
      authBgRaf = requestAnimationFrame(frame);
      if (document.hidden) return;
      // 弱机约 30fps 画粒子，减轻与登录网络请求抢主线程
      if (tier === 0) {
        frameSkip ^= 1;
        if (frameSkip) return;
      }
      const dt = Math.min(0.05, (now - t0) / 1000);
      t0 = now;
      ctx.clearRect(0, 0, w, h);
      if (!authBgParts) return;
      for (let i = 0; i < authBgParts.length; i++) {
        const p = authBgParts[i];
        p.x += p.vx * 40 * dt;
        p.y += p.vy * 40 * dt;
        p.tw += dt * p.ts;
        if (p.y < -8) { p.y = h + 8; p.x = Math.random() * w; }
        if (p.x < -8) p.x = w + 8;
        if (p.x > w + 8) p.x = -8;
        const alpha = p.a * (0.55 + 0.45 * Math.sin(p.tw));
        ctx.beginPath();
        ctx.fillStyle = 'hsla(' + p.hue + ',55%,78%,' + alpha.toFixed(3) + ')';
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (tier === 0) return;
      // 缓慢扫过的光带
      const sweep = ((now * 0.00004) + (authBgSeed % 1000) * 0.001) % 1;
      const gx = sweep * (w + 200) - 100;
      const grad = ctx.createLinearGradient(gx - 80, 0, gx + 80, h);
      grad.addColorStop(0, 'rgba(255,248,236,0)');
      grad.addColorStop(0.5, 'rgba(255,248,236,0.06)');
      grad.addColorStop(1, 'rgba(255,248,236,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }
    authBgRaf = requestAnimationFrame(frame);
  }

  // ------------------------------------------------ 画质选择（启动第一步）
  function shortGpuName(raw) {
    let s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return '未知';
    s = s.replace(/ANGLE\s*\((?:[^,]+,\s*)?/i, '').replace(/\)$/, '');
    s = s.replace(/Direct3D.*$/i, '').replace(/OpenGL.*$/i, '').trim();
    if (s.length > 42) s = s.slice(0, 40) + '…';
    return s || '未知';
  }
  function probeHardware() {
    const reduced = (() => {
      try {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch (e) { return false; }
    })();
    const memKnown = typeof navigator.deviceMemory === 'number';
    const mem = memKnown ? navigator.deviceMemory : null;
    const cores = navigator.hardwareConcurrency || 4;
    const dpr = window.devicePixelRatio || 1;
    let gpu = '';
    let gpuLow = false;
    let gpuHigh = false;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          gpu = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
          const ren = gpu.toLowerCase();
          if (/nvidia|geforce|rtx|gtx|radeon rx|radeon pro|quadro|arc a|apple m[1-9]/.test(ren)) {
            gpuHigh = true;
          }
          if (/intel|uhd|iris|hd graphics|mali|adreno|apple gpu|swiftshader|llvmpipe|microsoft basic|radeon\(tm\) graphics|vega/.test(ren)) {
            gpuLow = true;
          }
          if (gpuHigh) gpuLow = false;
        }
      }
    } catch (e) { }
    return { reduced, mem, memKnown, cores, dpr, gpu, gpuLow, gpuHigh };
  }
  function measureDrawScore(ms) {
    ms = ms || 420;
    return new Promise(resolve => {
      try {
        const c = document.createElement('canvas');
        c.width = 512;
        c.height = 512;
        const gl = c.getContext('webgl', { antialias: false, powerPreference: 'high-performance' })
          || c.getContext('experimental-webgl');
        if (!gl) {
          resolve(null);
          return;
        }
        let frames = 0;
        const t0 = performance.now();
        function tick(now) {
          frames++;
          gl.viewport(0, 0, 512, 512);
          const t = (now - t0) * 0.001;
          gl.clearColor(0.15 + 0.1 * Math.sin(t * 3), 0.2, 0.25 + 0.1 * Math.cos(t * 2), 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          // 多轮 clear 加重一点填充，区分弱机
          for (let i = 0; i < 8; i++) {
            gl.clear(gl.COLOR_BUFFER_BIT);
          }
          if (now - t0 < ms) {
            requestAnimationFrame(tick);
          } else {
            const elapsed = Math.max(1, now - t0);
            resolve(Math.round(frames * 1000 / elapsed));
          }
        }
        requestAnimationFrame(tick);
      } catch (e) {
        resolve(null);
      }
    });
  }
  function recommendFromProbe(hw, drawFps) {
    // 分数越高越倾向高清；访客机 / 核显偏保守
    let score = 50;
    if (hw.reduced) score -= 35;
    if (hw.mem != null) {
      if (hw.mem <= 4) score -= 30;
      else if (hw.mem <= 8) score -= 18;
      else if (hw.mem >= 16) score += 12;
      else if (hw.mem >= 12) score += 6;
    } else {
      score -= 8; // 未暴露内存时略保守
    }
    if (hw.cores <= 4) score -= 18;
    else if (hw.cores <= 8) score -= 8;
    else if (hw.cores >= 12) score += 8;
    if (hw.dpr >= 2) score -= 14;
    else if (hw.dpr >= 1.5) score -= 8;
    if (hw.gpuLow) score -= 22;
    if (hw.gpuHigh) score += 18;
    if (typeof drawFps === 'number') {
      if (drawFps < 28) score -= 28;
      else if (drawFps < 40) score -= 14;
      else if (drawFps < 50) score -= 4;
      else if (drawFps >= 70) score += 14;
      else if (drawFps >= 55) score += 6;
    }
    if (score <= 38) return 'low';
    if (score >= 68) return 'high';
    return 'mid';
  }
  function formatProbeDetail(hw, drawFps, recommend) {
    const bits = [];
    if (hw.mem != null) bits.push('内存约 ' + hw.mem + ' GB');
    else bits.push('内存未暴露');
    bits.push((hw.cores || '?') + ' 核');
    bits.push('屏幕 ' + (Math.round(hw.dpr * 100) / 100) + 'x');
    if (hw.gpu) bits.push(shortGpuName(hw.gpu));
    if (typeof drawFps === 'number') bits.push('试绘约 ' + drawFps + ' fps');
    if (hw.reduced) bits.push('系统已开减少动态效果');
    return bits.join(' · ') + ' → 建议「' + (GFX_LABELS[recommend] || recommend) + '」';
  }
  function applyGfxChoice(pref) {
    try { localStorage.setItem(LS_GFX, pref); } catch (e) { }
    try {
      const root = document.documentElement;
      root.classList.remove('gfx-low', 'gfx-mid', 'gfx-high');
      root.classList.add(pref === 'high' ? 'gfx-high' : pref === 'mid' ? 'gfx-mid' : 'gfx-low');
    } catch (e) { }
    try {
      if (window.__game && typeof window.__game.setGfxQuality === 'function') {
        window.__game.setGfxQuality(pref, { silent: true, force: true });
      }
    } catch (e) { }
  }
  function syncGfxPickUi() {
    document.querySelectorAll('.gp-card').forEach(btn => {
      const v = btn.getAttribute('data-gfx');
      const on = v === gfxPickSelected;
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      const badge = btn.querySelector('.gp-badge');
      const isRec = v === gfxPickRecommend;
      btn.classList.toggle('is-recommend', isRec);
      if (badge) badge.hidden = !isRec;
    });
    const confirm = el('gp-confirm');
    if (confirm && !confirm.disabled) {
      const label = GFX_LABELS[gfxPickSelected] || gfxPickSelected;
      const tip = gfxPickSelected === gfxPickRecommend
        ? '以推荐画质「' + label + '」继续'
        : '以「' + label + '」继续';
      confirm.textContent = tip;
    }
  }
  function selectGfxPick(pref) {
    if (pref !== 'low' && pref !== 'mid' && pref !== 'high') return;
    gfxPickSelected = pref;
    syncGfxPickUi();
  }
  function showGfxPick() {
    const gp = el('gfx-pick');
    if (!gp) {
      gfxPickDone = true;
      afterGfxPick();
      return;
    }
    const a = el('auth');
    if (a) {
      a.classList.add('hidden');
      a.style.display = 'none';
    }
    document.body.classList.remove('auth-open');
    stopAuthBackdrop();
    gp.classList.remove('hidden');
    document.body.classList.add('gfx-pick-open');
    const status = el('gp-probe-status');
    const detail = el('gp-probe-detail');
    const confirm = el('gp-confirm');
    if (status) {
      status.textContent = '正在检测本机性能…';
      status.classList.remove('is-ready');
    }
    if (detail) detail.textContent = '读取 CPU / 内存 / 显卡，并做一次短暂试绘…';
    if (confirm) {
      confirm.disabled = true;
      confirm.textContent = '请稍候检测…';
    }
    document.querySelectorAll('.gp-card').forEach(btn => { btn.disabled = true; });
  }
  function hideGfxPick() {
    const gp = el('gfx-pick');
    if (gp) gp.classList.add('hidden');
    document.body.classList.remove('gfx-pick-open');
  }
  async function runGfxPickProbe() {
    const hw = probeHardware();
    const drawFps = await measureDrawScore(420);
    gfxPickRecommend = recommendFromProbe(hw, drawFps);
    // 默认选中推荐档，用户可改；若与上次存档不同会在说明里提示
    gfxPickSelected = gfxPickRecommend;
    let savedNote = '';
    try {
      const saved = localStorage.getItem(LS_GFX);
      if ((saved === 'low' || saved === 'mid' || saved === 'high') && saved !== gfxPickRecommend) {
        savedNote = '（上次选用「' + (GFX_LABELS[saved] || saved) + '」）';
      }
    } catch (e) { }
    const status = el('gp-probe-status');
    const detail = el('gp-probe-detail');
    const confirm = el('gp-confirm');
    if (status) {
      status.textContent = '检测完成 · 建议「' + (GFX_LABELS[gfxPickRecommend] || gfxPickRecommend) + '」';
      status.classList.add('is-ready');
    }
    if (detail) detail.textContent = formatProbeDetail(hw, drawFps, gfxPickRecommend) + savedNote;
    document.querySelectorAll('.gp-card').forEach(btn => { btn.disabled = false; });
    if (confirm) confirm.disabled = false;
    syncGfxPickUi();
  }
  function confirmGfxPick() {
    if (!gfxPickSelected) return;
    applyGfxChoice(gfxPickSelected);
    gfxPickDone = true;
    hideGfxPick();
    afterGfxPick();
  }

  let hubTokenOverride = '';

  function hubAccessToken() {
    if (hubTokenOverride) return hubTokenOverride;
    try { return localStorage.getItem('hub_access_token') || ''; } catch (e) { return ''; }
  }

  // 合集站父页通过 postMessage 注入令牌（与同源 localStorage 双通道）
  window.addEventListener('message', (e) => {
    const data = e && e.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'hub:maze-auth' && data.accessToken) {
      hubTokenOverride = String(data.accessToken);
    }
  });

  async function afterGfxPick() {
    if (!isHubEmbed()) {
      showAuthUI('login');
      return;
    }
    // 向父页索取合集站令牌（若尚未收到）
    if (!hubAccessToken()) {
      try { window.parent.postMessage({ type: 'hub:maze-need-auth' }, '*'); } catch (e) { }
      await new Promise(r => setTimeout(r, 200));
    }
    const ht = hubAccessToken();
    if (!ht) {
      showAuthUI('login');
      return;
    }
    try {
      const r = await fetchTimeout(apiUrl('/api/maze-hub/status'), {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + ht }
      }, 6000);
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        showAuthUI('login');
        return;
      }
      if (d.status === 'linked' && d.token) {
        enterGame(d.user, d.token, d.progress, 'login');
        return;
      }
      if (d.status === 'needs_choice') {
        showHubChoice(d);
        return;
      }
    } catch (e) { }
    showAuthUI('login');
  }

  let hubChoiceMode = 'use'; // 'use' | 'new'
  let hubChoiceMeta = null;

  function setHubChoiceError(msg) {
    const e = el('hub-choice-error');
    if (!e) return;
    e.textContent = msg || '';
    e.classList.toggle('show', !!msg);
  }

  function showHubChoice(meta) {
    hubChoiceMeta = meta || {};
    hideGfxPick();
    const a = el('auth');
    if (a) {
      a.style.display = '';
      void a.offsetHeight;
      a.classList.remove('hidden');
    }
    document.body.classList.add('auth-open');
    startAuthBackdrop();
    const classic = el('auth-classic');
    const choice = el('hub-choice');
    if (classic) classic.classList.add('hidden');
    if (choice) choice.classList.remove('hidden');
    const form = el('hub-choice-form');
    if (form) form.classList.add('hidden');
    const nameEl = el('hub-choice-name');
    if (nameEl) {
      nameEl.textContent = (meta.hubDisplayName || meta.hubUsername || '') +
        (meta.hubUsername ? ' (@' + meta.hubUsername + ')' : '');
    }
    // 恢复两个主按钮可见
    const useBtn = el('hub-choice-use');
    const newBtn = el('hub-choice-new');
    if (useBtn) useBtn.style.display = '';
    if (newBtn) newBtn.style.display = '';
    setHubChoiceError('');
  }

  function openHubChoiceForm(mode) {
    hubChoiceMode = mode;
    const form = el('hub-choice-form');
    const useBtn = el('hub-choice-use');
    const newBtn = el('hub-choice-new');
    if (useBtn) useBtn.style.display = 'none';
    if (newBtn) newBtn.style.display = 'none';
    if (form) form.classList.remove('hidden');
    const userIn = el('hub-choice-user');
    const passIn = el('hub-choice-pass');
    const userLabel = el('hub-choice-user-label');
    const passLabel = el('hub-choice-pass-label');
    const hint = el('hub-choice-hint');
    if (mode === 'use') {
      if (userLabel) userLabel.textContent = '回廊用户名（默认合集站用户名）';
      if (passLabel) passLabel.textContent = '合集站登录密码';
      if (userIn) {
        userIn.value = (hubChoiceMeta && (hubChoiceMeta.suggestedMazeUsername || hubChoiceMeta.hubUsername)) || '';
        userIn.readOnly = false;
      }
      if (passIn) {
        passIn.value = '';
        passIn.setAttribute('autocomplete', 'current-password');
      }
      if (hint) {
        hint.textContent = hubChoiceMeta && hubChoiceMeta.hubUsernameAvailable === false
          ? '合集站用户名在回廊侧已被占用，可改一个名称，或改用下方「自行注册」。'
          : '将用合集站账号在服务器创建回廊存档，之后换电脑也能继续。';
      }
    } else {
      if (userLabel) userLabel.textContent = '新回廊用户名';
      if (passLabel) passLabel.textContent = '新回廊密码（至少 4 位）';
      if (userIn) {
        userIn.value = '';
        userIn.readOnly = false;
      }
      if (passIn) {
        passIn.value = '';
        passIn.setAttribute('autocomplete', 'new-password');
      }
      if (hint) hint.textContent = '注册独立回廊账号，并绑定当前合集站登录，进度同样保存在服务器。';
    }
    setHubChoiceError('');
    setTimeout(() => {
      const focusEl = passIn || userIn;
      if (focusEl) focusEl.focus();
    }, 200);
  }

  function backHubChoice() {
    const form = el('hub-choice-form');
    if (form) form.classList.add('hidden');
    const useBtn = el('hub-choice-use');
    const newBtn = el('hub-choice-new');
    if (useBtn) useBtn.style.display = '';
    if (newBtn) newBtn.style.display = '';
    setHubChoiceError('');
  }

  async function submitHubChoice() {
    const ht = hubAccessToken();
    if (!ht) {
      setHubChoiceError('合集站登录已失效，请返回大厅重新进入');
      return;
    }
    const username = ((el('hub-choice-user') && el('hub-choice-user').value) || '').trim();
    const password = (el('hub-choice-pass') && el('hub-choice-pass').value) || '';
    if (!username || !password) {
      setHubChoiceError('请填写用户名和密码');
      return;
    }
    const submit = el('hub-choice-submit');
    if (submit) submit.disabled = true;
    setHubChoiceError('');
    try {
      const path = hubChoiceMode === 'use' ? '/api/maze-hub/use-hub' : '/api/maze-hub/register-new';
      const body = hubChoiceMode === 'use'
        ? { password: password, mazeUsername: username }
        : { username: username, password: password };
      const r = await fetchTimeout(apiUrl(path), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + ht
        },
        body: JSON.stringify(body)
      }, 8000);
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setHubChoiceError(d.error || '操作失败，请重试');
      } else if (d.token) {
        enterGame(d.user, d.token, d.progress, hubChoiceMode === 'use' ? 'login' : 'register');
      } else {
        setHubChoiceError('未获得登录令牌');
      }
    } catch (e) {
      setHubChoiceError('无法连接服务器');
    }
    if (submit) submit.disabled = false;
  }
  function bindGfxPickUI() {
    const cards = el('gp-cards');
    if (cards) {
      cards.addEventListener('click', e => {
        const btn = e.target.closest('.gp-card');
        if (!btn || btn.disabled) return;
        selectGfxPick(btn.getAttribute('data-gfx'));
      });
      cards.addEventListener('keydown', e => {
        const order = ['low', 'mid', 'high'];
        const i = order.indexOf(gfxPickSelected);
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          selectGfxPick(order[Math.min(order.length - 1, i + 1)]);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          selectGfxPick(order[Math.max(0, i - 1)]);
        } else if (e.key === 'Enter' || e.key === ' ') {
          const btn = e.target.closest('.gp-card');
          if (btn && !btn.disabled) {
            e.preventDefault();
            selectGfxPick(btn.getAttribute('data-gfx'));
          }
        }
      });
    }
    const confirm = el('gp-confirm');
    if (confirm) confirm.addEventListener('click', () => confirmGfxPick());
  }

  // ------------------------------------------------ 登录 UI
  let activeTab = 'login';
  let authHideTimer = null;
  function showAuthUI(tab) {
    clearTimeout(authHideTimer);
    activeTab = tab || activeTab;
    hideGfxPick();
    const mp = el('mode-pick');
    if (mp) {
      mp.classList.add('hidden');
      document.body.classList.remove('mode-pick-open');
    }
    const choice = el('hub-choice');
    const classic = el('auth-classic');
    if (choice) choice.classList.add('hidden');
    if (classic) classic.classList.remove('hidden');
    const a = el('auth');
    a.style.display = '';
    void a.offsetHeight;             // 恢复显示后再入场，保证过渡动画干净
    if (a) a.classList.remove('hidden');
    document.body.classList.add('auth-open');
    startAuthBackdrop();
    setTab(activeTab);
    setError('');
    const u = el('auth-user'), p = el('auth-pass');
    if (u && !u.value) {
      try {
        const remembered = localStorage.getItem(LS_USER) || '';
        if (remembered) u.value = remembered;
      } catch (e) { }
    }
    if (user && u) u.value = user.username;
    setTimeout(() => { (activeTab === 'register' ? p : u).focus(); }, 350);
  }
  function hideAuthUI() {
    const a = el('auth');
    if (a) a.classList.add('hidden');
    document.body.classList.remove('auth-open');
    stopAuthBackdrop();
    // 过渡结束后彻底移出渲染树，避免 backdrop-filter 层残影
    clearTimeout(authHideTimer);
    authHideTimer = setTimeout(() => { a.style.display = 'none'; }, 700);
  }
  function setTab(tab) {
    const btn = document.querySelector('.auth-tab[data-tab="' + tab + '"]');
    if (btn && btn.classList.contains('disabled')) return;
    activeTab = tab;
    document.querySelectorAll('.auth-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab));
    el('auth-submit').textContent = tab === 'login' ? '进入回廊' : '创建旅人';
    el('auth-pass').setAttribute('autocomplete', tab === 'login' ? 'current-password' : 'new-password');
    setError('');
  }
  function setError(msg) {
    const e = el('auth-error');
    e.textContent = msg || '';
    e.classList.toggle('show', !!msg);
  }
  function setBusy(busy) {
    const b = el('auth-submit');
    // 离线时保持不可登录，避免请求结束后误启用按钮
    b.disabled = !!busy || online === false;
    b.textContent = busy ? '···' : (activeTab === 'login' ? '进入回廊' : '创建旅人');
  }

  async function submitForm() {
    const username = el('auth-user').value.trim();
    const password = el('auth-pass').value;
    if (!username || !password) { setError('请输入用户名和密码'); return; }
    setBusy(true);
    setError('');
    try {
      const r = await fetchTimeout(apiUrl('/api/' + activeTab), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      }, 6000);
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setError(d.error || (online === false ? '无法连接本地服务器，请通过「启动游戏.bat」启动' : '登录失败，请重试'));
      } else {
        el('auth-pass').value = '';
        enterGame(d.user, d.token, d.progress, activeTab);
      }
    } catch (e) {
      setError('无法连接本地服务器，可先以游客身份进入');
    }
    setBusy(false);
  }

  function updateStatusUI() {
    const dot = document.querySelector('#auth-status .status-dot');
    const txt = el('auth-status-text');
    if (!dot || !txt) return;
    const reg = document.querySelector('.auth-tab[data-tab="register"]');
    const submit = el('auth-submit');
    if (online === null) {
      txt.textContent = '正在连接存档服务…';
      dot.className = 'status-dot waiting';
    } else if (online) {
      let where = '存档服务已连接 · 进度将同步';
      try {
        if (isHubEmbed()) {
          where = '合集站云存档已连接 · 进度保存在服务器（可换电脑继续）';
        } else {
          const onLanHostPage = !isLoopbackHost(location.hostname);
          if (API && (API.indexOf('127.0.0.1') >= 0 || API.indexOf('localhost') >= 0)) {
            where = '本机在线服务已连接 · 进度写入服务器数据库';
          } else if (onLanHostPage && API === location.origin) {
            where = '已作为局域网主机在线 · 其它电脑可打开本页地址';
          } else if (API) {
            where = '已连接主机 ' + API.replace(/^https?:\/\//, '') + ' · 进度将同步';
          }
        }
      } catch (e) { }
      txt.textContent = where;
      dot.className = 'status-dot ok';
      if (reg) reg.classList.remove('disabled');
      if (submit) {
        submit.classList.remove('disabled');
        submit.disabled = false;
      }
    } else {
      txt.textContent = '离线模式 · 可游客进入；在线请运行「启动游戏.bat」或填写主机 IP';
      dot.className = 'status-dot bad';
      if (reg) reg.classList.add('disabled');
      if (submit) {
        submit.classList.add('disabled');
        submit.disabled = true;
      }
    }
    refreshLanSharePanel();
  }

  let lanShareSeq = 0;
  async function refreshLanSharePanel() {
    const box = el('auth-share');
    const urlIn = el('auth-share-url');
    const more = el('auth-share-more');
    if (!box) return;
    // 连上在线服务即可展示分享地址（本机 127.0.0.1 或主机局域网 IP 打开都可）
    if (!online) {
      box.classList.add('hidden');
      return;
    }
    const seq = ++lanShareSeq;
    try {
      const r = await fetchTimeout(apiUrl('/api/lan'), { method: 'GET' }, 2500);
      if (seq !== lanShareSeq) return;
      if (!r.ok) throw new Error('lan');
      const d = await r.json();
      const prefer = (d && d.prefer) || '';
      if (!prefer) throw new Error('empty');
      if (urlIn) urlIn.value = prefer;
      if (more) {
        const rest = (d.urls || []).filter(u => u !== prefer).slice(0, 3);
        more.textContent = rest.length
          ? ('备用：' + rest.join('  ·  '))
          : '防火墙放行 TCP ' + (d.port || 8940) + '；访客与主机须同一 Wi-Fi';
      }
      box.classList.remove('hidden');
    } catch (e) {
      if (seq !== lanShareSeq) return;
      box.classList.add('hidden');
    }
  }

  // ------------------------------------------------ 事件绑定
  function bindUI() {
    document.querySelectorAll('.auth-tab').forEach(b =>
      b.addEventListener('click', () => setTab(b.dataset.tab)));
    el('auth-form').addEventListener('submit', e => { e.preventDefault(); if (online !== false) submitForm(); else setError('离线状态无法登录，请以游客身份进入'); });
    el('auth-guest').addEventListener('click', () => enterGame(null, null, null, 'guest'));
    el('auth-pass').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitForm(); } });

    const hubUse = el('hub-choice-use');
    const hubNew = el('hub-choice-new');
    const hubSubmit = el('hub-choice-submit');
    const hubBack = el('hub-choice-back');
    const hubPass = el('hub-choice-pass');
    if (hubUse) hubUse.addEventListener('click', () => openHubChoiceForm('use'));
    if (hubNew) hubNew.addEventListener('click', () => openHubChoiceForm('new'));
    if (hubSubmit) hubSubmit.addEventListener('click', () => submitHubChoice());
    if (hubBack) hubBack.addEventListener('click', () => backHubChoice());
    if (hubPass) hubPass.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitHubChoice(); } });

    const statusEl = el('auth-status');
    if (statusEl) {
      statusEl.style.cursor = 'pointer';
      statusEl.title = '点击重新检测服务器';
      statusEl.addEventListener('click', async () => {
        if (online === null) return;
        online = null;
        updateStatusUI();
        setError('');
        await ping();
        if (online) setError('');
        else setError('仍未连上。本机请运行「启动游戏.bat」；其它电脑请打开 http://主机IP:8940/ 或在下方填写主机地址。');
      });
    }
    const hostIn = el('auth-host');
    const hostGo = el('auth-host-go');
    if (hostIn) {
      try {
        const saved = localStorage.getItem(LS_API) || '';
        if (saved) hostIn.value = saved.replace(/^https?:\/\//, '');
      } catch (e) { }
    }
    async function connectHost() {
      const raw = hostIn ? hostIn.value : '';
      const url = normalizeApi(raw);
      if (!url) {
        persistRemoteApi('');
        API = resolveApiBase();
        online = null;
        updateStatusUI();
        await ping();
        return;
      }
      persistRemoteApi(url);
      API = url;
      online = null;
      updateStatusUI();
      setError('');
      try {
        await pingOnce(url);
        // 成功后整页跳到主机，保证静态资源与 API 同源
        try {
          const here = location.protocol + '//' + location.host;
          if (here !== url) {
            location.assign(url + '/' + (location.search || ''));
            return;
          }
        } catch (e) { }
        API = url;
        online = true;
        updateStatusUI();
        setError('');
      } catch (e) {
        online = false;
        updateStatusUI();
        if (e && e.offlineGuest) {
          setError('该地址是离线游客服务，不能注册登录。请让主机用「启动游戏.bat」开在线模式。');
        } else {
          setError('连不上该主机。确认对方已运行「启动游戏.bat」，防火墙放行 8940，地址形如 192.168.1.8');
        }
      }
    }
    if (hostGo) hostGo.addEventListener('click', () => { connectHost(); });
    if (hostIn) {
      hostIn.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); connectHost(); }
      });
    }
    const shareCopy = el('auth-share-copy');
    const shareUrl = el('auth-share-url');
    if (shareCopy && shareUrl) {
      shareCopy.addEventListener('click', async () => {
        const v = shareUrl.value || '';
        if (!v) return;
        let ok = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(v);
            ok = true;
          }
        } catch (e) { ok = false; }
        if (!ok) {
          try {
            shareUrl.focus();
            shareUrl.select();
            ok = document.execCommand('copy');
          } catch (e) { ok = false; }
        }
        shareCopy.textContent = ok ? '已复制' : '失败';
        shareCopy.classList.toggle('copied', ok);
        setTimeout(() => {
          shareCopy.textContent = '复制';
          shareCopy.classList.remove('copied');
        }, 1600);
        if (ok) setError('');
      });
    }

    // HUD 玩家徽章菜单（必须先绑，悬停音失败也不能挡退出）
    const chip = el('btn-player');
    const menu = el('player-menu');
    if (chip && menu) {
      chip.addEventListener('click', e => {
        e.stopPropagation();
        renderPlayerMenu();
        menu.classList.toggle('show');
      });
      document.addEventListener('click', e => {
        if (!menu.contains(e.target) && e.target !== chip && !chip.contains(e.target)) {
          menu.classList.remove('show');
        }
      });
    }
    document.querySelectorAll('.auth-panel-view').forEach(panel => {
      panel.addEventListener('click', e => {
        if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
        e.preventDefault();
        const open = panel.classList.toggle('is-open');
        document.querySelectorAll('.auth-panel-view').forEach(other => {
          if (other !== panel) other.classList.remove('is-open');
        });
        if (open) panel.focus({ preventScroll: true });
      });
    });
    bindAuthHoverSounds();
  }
  function renderPlayerMenu() {
    const menu = el('player-menu');
    if (!menu) return;
    const modeBtn = '<button type="button" id="pm-mode">重选游戏模式</button>';
    menu.innerHTML = user
      ? '<div class="pm-head">' + escapeHtml(user.username) + '</div>' +
        '<div class="pm-sub">' + (online ? '进度云端同步中' : '服务器离线 · 暂存本地') + '</div>' +
        modeBtn +
        '<button type="button" id="pm-logout">退出登录</button>'
      : '<div class="pm-head">游客模式</div>' +
        '<div class="pm-sub">进度仅保存在本机浏览器</div>' +
        modeBtn +
        '<button type="button" id="pm-logout">退出到登录</button>';
    const modeEl = el('pm-mode');
    if (modeEl) {
      modeEl.addEventListener('click', e => {
        e.stopPropagation();
        menu.classList.remove('show');
        if (typeof window.__showModePick === 'function') window.__showModePick();
      });
    }
    const btn = el('pm-logout');
    if (btn) {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        menu.classList.remove('show');
        logout();
      });
    }
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ------------------------------------------------ 启动流程
  async function boot() {
    bindUI();
    bindGfxPickUI();
    // 每次打开：先选画质 → 再登录（局域网多机共用时避免直接进模式选择）
    // 清掉旧自动登录令牌；用户名仍预填，需重新输入密码
    try { localStorage.removeItem(LS_TOKEN); } catch (e) { }
    showGfxPick();
    const probe = runGfxPickProbe();
    await Promise.all([ping(), probe]);
    cancelHostShutdown();
  }

  // 嵌入合集站 iframe / ?hub=1 时：不探本机 8940、不关页停服（由合集站托管）
  function isHubEmbed() {
    try {
      if (new URLSearchParams(location.search).get('hub') === '1') return true;
    } catch (e) { }
    try {
      if (window.parent && window.parent !== window) return true;
    } catch (e) {
      return true;
    }
    return false;
  }

  // 本机关页：约 1.4s 后启动「关闭游戏.bat」清后台；刷新会立刻取消。
  // 是否允许停服由服务器校验来源 IP（访客机关页会被 403，不影响主机）。
  function requestHostShutdownOnLeave() {
    if (isHubEmbed()) return;
    try {
      const url = apiUrl('/api/shutdown');
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(url);
      } else {
        fetch(url, { method: 'POST', keepalive: true }).catch(function () { });
      }
    } catch (e) { }
  }

  function cancelHostShutdown() {
    if (isHubEmbed()) return;
    try {
      fetch(apiUrl('/api/shutdown-cancel'), { method: 'POST', keepalive: true }).catch(function () { });
    } catch (e) { }
  }

  document.addEventListener('DOMContentLoaded', boot);

  // 关页时停粒子循环，避免标签页关闭后仍占主线程
  window.addEventListener('pagehide', () => {
    stopAuthBackdrop();
    requestHostShutdownOnLeave();
  });
  window.addEventListener('beforeunload', () => { stopAuthBackdrop(); });
  window.addEventListener('pageshow', () => { cancelHostShutdown(); });

  return {
    get progress() { return progress; },
    get user() { return user; },
    get enterMode() { return lastEnterMode; },
    isOnline: () => online === true,
    isActive: () => !entered,
    commit: function (fn) {
      if (!progress.records) progress.records = {};
      if (!progress.steles) progress.steles = {};
      fn(progress);
      persistLocal();
      pushRemote(false);
      fireProgress();
    },
    onReady: cb => readyCbs.push(cb),
    onProgress: cb => progressCbs.push(cb),
    logout: logout,
    refreshMenu: renderPlayerMenu,
    stopBackdrop: stopAuthBackdrop
  };
})();
