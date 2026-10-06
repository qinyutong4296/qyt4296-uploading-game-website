/* ============================================================
 * 投影回廊 · Perspective Corridor（第二章大改版）
 * 纪念碑谷式 2D↔3D 视角切换迷宫
 *
 * 核心规则（视角即规则，主角不能跳跃）：
 *   · 3D：顶面同色且四邻连成一片 = 同一平面，仅此平面内可自由走
 *          （同色但不相连的两片地不能直接到达；有侧面色差的高差不能爬）
 *   · 任意高差（|dy|≥1，侧面能看见墙色）：仅 2D 俯视可走（高度被压平）
 *   · 高墙 / 同列竖爬：仅 2D 俯视可走
 *   · 视错觉边 illusion：等距投影相接且中间无实体 —— 仅 3D 等距图可通行
 *     （中间已有砖的贴地高差不算错觉）
 *   · 星屑：集齐才解锁金环；石碑：剧情；转盘 / 齿轮：旋转机关
 *
 * 开源借鉴：valley-silent-spire（接口点寻路图 / 旋转=改图 / WebAudio 音阶）
 *          kvnloo/monument 研究指南（正交等轴相机 / 烘焙明暗 / 配色）
 * 渲染 Three.js r147 (UMD) · 动画 GSAP 3 —— 均已本地化。
 * ============================================================ */
'use strict';
(function () {

  // ------------------------------------------------ 基础场景
  const stage = document.getElementById('stage');
  const LS_GFX = 'pcorridor.gfx';
  // 画质档：分辨率可略高；静止锁帧省 CPU；走动时主循环会临时满帧防瞬移
  // 均衡：清晰度接近高清一半以上，但不开装饰循环 / 墙体半透（最吃 CPU）
  const GFX_PRESETS = {
    low:  { tier: 0, maxPR: 0.65, minMs: 40 },
    mid:  { tier: 1, maxPR: 1.0,  minMs: 33 },
    high: { tier: 2, maxPR: 1.25, minMs: 16 }
  };
  const GFX_LABELS = { auto: '自动', low: '流畅', mid: '均衡', high: '高清' };
  function detectGfxTier() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
    } catch (e) { }
    // deviceMemory 未暴露时按弱机估；核显 / 高 DPI / 常规笔记本默认流畅，少吃访客机 CPU
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
    if (mem <= 16 || cores <= 12 || dpr > 1.25) return 1;
    return 2;
  }
  // 装饰性循环动画：仅高清开；均衡/流畅关掉以省 CPU
  function allowDecorFx() { return gfxTier >= 2; }
  function allowIdleBob() { return gfxTier >= 1; }
  function decorTween(target, vars) {
    if (!allowDecorFx()) return null;
    return gsap.to(target, vars);
  }
  let gfxPref = 'auto';
  try {
    const saved = localStorage.getItem(LS_GFX);
    if (saved === 'auto' || saved === 'low' || saved === 'mid' || saved === 'high') gfxPref = saved;
  } catch (e) { }
  let gfxTier = 0;
  let maxPixelRatio = 1;
  let minFrameMs = 0;
  let autoDownscaleEnabled = true;
  function resolveGfxPreset() {
    if (gfxPref === 'auto') {
      const t = detectGfxTier();
      return t === 0 ? GFX_PRESETS.low : t === 1 ? GFX_PRESETS.mid : GFX_PRESETS.high;
    }
    return GFX_PRESETS[gfxPref] || GFX_PRESETS.mid;
  }
  function syncGfxClass() {
    try {
      const root = document.documentElement;
      root.classList.remove('gfx-low', 'gfx-mid', 'gfx-high');
      root.classList.add(gfxTier === 0 ? 'gfx-low' : gfxTier === 1 ? 'gfx-mid' : 'gfx-high');
    } catch (e) { }
  }
  function syncGfxUi() {
    const sel = document.getElementById('gfx-select');
    if (sel && document.activeElement !== sel) sel.value = gfxPref;
    const box = document.getElementById('gfx-control');
    if (box) {
      const tip = '画质 · ' + (GFX_LABELS[gfxPref] || gfxPref) +
        (gfxPref === 'auto' ? '（推荐「均衡」；卡顿再选「流畅」）'
          : gfxPref === 'mid' ? '（清晰 + 静止锁帧，走动仍平滑）'
          : '（可随时切换）');
      box.title = tip;
    }
  }
  let renderer = null;
  function applyGfxSettings() {
    const p = resolveGfxPreset();
    gfxTier = p.tier;
    maxPixelRatio = p.maxPR;
    minFrameMs = p.minMs;
    autoDownscaleEnabled = gfxPref === 'auto';
    syncGfxClass();
    syncGfxUi();
    if (renderer) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
      renderer.setSize(window.innerWidth, window.innerHeight, false);
    }
  }
  applyGfxSettings();
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,
      powerPreference: gfxTier === 0 ? 'low-power' : 'high-performance',
      stencil: false,
      depth: true
    });
  } catch (e) {
    stage.innerHTML = '<div id="webgl-error">你的浏览器不支持 WebGL，<br>请使用新版 Chrome / Edge 打开。</div>';
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.sortObjects = false;
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = null;

  const VIEW_D = 7.2;
  const CAM_DIST = 40;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 800);
  const camCenter = new THREE.Vector3(3, 1, 0);
  let camMode = '3d';
  let camTweens = [];
  // loadLevel 写入的关卡屏幕半宽/半高；resize 时按当前宽高比重算 zoom
  let levelFitHalfW = 1.2, levelFitHalfH = 1.2;

  function refitCameraZoom() {
    const aspect = window.innerWidth / Math.max(window.innerHeight, 1);
    const pad = 0.86;
    const fitZoom = Math.min(
      (VIEW_D * aspect * pad) / Math.max(levelFitHalfW, 1.2),
      (VIEW_D * pad) / Math.max(levelFitHalfH, 1.2)
    );
    camera.zoom = Math.min(1.05, Math.max(0.16, fitZoom));
  }

  function resize() {
    const a = window.innerWidth / Math.max(window.innerHeight, 1);
    camera.left = -VIEW_D * a; camera.right = VIEW_D * a;
    camera.top = VIEW_D; camera.bottom = -VIEW_D;
    refitCameraZoom();
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', resize);
  resize();

  // ------------------------------------------------ 材质（逐面烘焙明暗，无真实光照）
  const SHADE = [0.66, 0.58, 1.0, 0.5, 0.84, 0.72];
  const matCache = new Map();
  const geoCache = new Map();
  function markSharedMats(arr) {
    for (let i = 0; i < arr.length; i++) {
      if (!arr[i].userData) arr[i].userData = {};
      arr[i].userData.shared = true;
    }
    return arr;
  }
  function faceMats(hexStr) {
    if (matCache.has(hexStr)) return matCache.get(hexStr);
    const c = new THREE.Color(hexStr);
    const arr = markSharedMats(SHADE.map(f => new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(f) })));
    matCache.set(hexStr, arr);
    return arr;
  }
  function tileMats(y) {
    const pal = curLevel && curLevel.pal;
    const key = 'tile:' + (pal ? pal.top : 0) + ':' + (pal ? pal.side : 0) + ':' + y;
    if (matCache.has(key)) return matCache.get(key);
    const topC = new THREE.Color(topColorFor(y));
    const sideC = new THREE.Color(pal ? pal.side : 0x888888);
    const arr = markSharedMats([
      new THREE.MeshBasicMaterial({ color: sideC.clone().multiplyScalar(0.78) }),
      new THREE.MeshBasicMaterial({ color: sideC.clone().multiplyScalar(0.62) }),
      new THREE.MeshBasicMaterial({ color: topC }),
      new THREE.MeshBasicMaterial({ color: sideC.clone().multiplyScalar(0.42) }),
      new THREE.MeshBasicMaterial({ color: sideC.clone().multiplyScalar(0.88) }),
      new THREE.MeshBasicMaterial({ color: sideC.clone().multiplyScalar(0.70) })
    ]);
    matCache.set(key, arr);
    return arr;
  }
  // 普通地砖共用材质（少 state change）；需独立改透明的再 clone
  function makeTileMats(y, unique) {
    const base = tileMats(y);
    if (!unique) return base;
    return base.map(m => m.clone());
  }
  function boxGeo(w, h, d) {
    const key = w.toFixed(3) + 'x' + h.toFixed(3) + 'x' + d.toFixed(3);
    let g = geoCache.get(key);
    if (!g) {
      g = new THREE.BoxGeometry(w, h, d);
      geoCache.set(key, g);
    }
    return g;
  }
  function topColorFor(y) {
    const f = Math.max(0.7, 1 - 0.06 * y);   // 高度染色，保底 0.7 防止高塔变纯黑
    return '#' + new THREE.Color(curLevel.pal.top).multiplyScalar(f).getHexString();
  }
  const COL_ILLU = 0xe8b84b;   // 视错觉光带（3D 生效）
  const COL_STAIR = 0x2ea89a;  // 阶梯（2D 生效）

  // ------------------------------------------------ 音效（WebAudio：柔和滤波 + 总线，纪念碑谷式短句）
  let AC = null, master = null, masterLp = null, noiseBuf = null;
  let muted = false;
  let volume = 0.1; // 每次打开 / 每关默认 10
  const MASTER_GAIN = 0.62;
  try { muted = localStorage.getItem('pcorridor.muted') === '1'; } catch (e) { }
  // 音量不从本地恢复：每次进入页面与每关固定从 10 起

  function effectiveVolume() {
    return muted ? 0 : volume;
  }

  function applyMasterGain() {
    if (master) master.gain.value = MASTER_GAIN * effectiveVolume();
  }

  function initAudio() {
    if (!AC) {
      try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    }
    if (AC.state === 'suspended') {
      try {
        const p = AC.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) { }
    }
    if (!master) {
      master = AC.createGain();
      master.gain.value = MASTER_GAIN * effectiveVolume();
      masterLp = AC.createBiquadFilter();
      masterLp.type = 'lowpass';
      masterLp.frequency.value = 3800;
      masterLp.Q.value = 0.45;
      const comp = AC.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 10;
      comp.ratio.value = 2.6;
      comp.attack.value = 0.004;
      comp.release.value = 0.18;
      master.connect(masterLp);
      masterLp.connect(comp);
      comp.connect(AC.destination);
      noiseBuf = AC.createBuffer(1, Math.floor(AC.sampleRate * 0.5), AC.sampleRate);
      const ch = noiseBuf.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    } else {
      applyMasterGain();
    }
  }
  function outNode() { return master || AC.destination; }

  function playTone(opts) {
    if (!AC || effectiveVolume() <= 0) return;
    const t0 = AC.currentTime + (opts.delay || 0);
    const dur = opts.dur || 0.3;
    const atk = opts.atk == null ? 0.012 : opts.atk;
    const peak = Math.max(opts.gain || 0.04, 0.00012);
    const o = AC.createOscillator();
    o.type = opts.type || 'sine';
    o.frequency.setValueAtTime(opts.f, t0);
    if (opts.f2) o.frequency.exponentialRampToValueAtTime(Math.max(opts.f2, 20), t0 + dur);
    if (opts.detune) o.detune.setValueAtTime(opts.detune, t0);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = o;
    if (opts.lp) {
      const f = AC.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(opts.lp, t0);
      f.Q.value = opts.q == null ? 0.7 : opts.q;
      if (opts.lp2) f.frequency.exponentialRampToValueAtTime(Math.max(opts.lp2, 80), t0 + dur);
      o.connect(f); node = f;
    }
    if (opts.pan != null && AC.createStereoPanner) {
      const p = AC.createStereoPanner();
      p.pan.setValueAtTime(Math.max(-1, Math.min(1, opts.pan)), t0);
      node.connect(p); p.connect(g);
    } else {
      node.connect(g);
    }
    g.connect(outNode());
    o.start(t0);
    o.stop(t0 + dur + 0.04);
  }

  function playNoise(opts) {
    if (!AC || effectiveVolume() <= 0 || !noiseBuf) return;
    const t0 = AC.currentTime + (opts.delay || 0);
    const dur = opts.dur || 0.25;
    const src = AC.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const bp = AC.createBiquadFilter();
    bp.type = opts.kind || 'bandpass';
    bp.frequency.setValueAtTime(opts.f || 800, t0);
    bp.Q.value = opts.q == null ? 1.1 : opts.q;
    if (opts.f2) bp.frequency.exponentialRampToValueAtTime(Math.max(opts.f2, 60), t0 + dur);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(opts.gain || 0.04, 0.00012), t0 + (opts.atk || 0.02));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp); bp.connect(g); g.connect(outNode());
    src.start(t0); src.stop(t0 + dur + 0.02);
  }

  function chord(freqs, delay, dur, gain, type) {
    freqs.forEach((f, i) => playTone({
      f: f, delay: delay + i * 0.012, dur: dur, gain: gain * (1 - i * 0.08),
      type: type || 'sine', atk: 0.02, lp: 2200
    }));
  }

  function playPiano(f, delay, gain) {
    if (!AC || effectiveVolume() <= 0) return;
    const t0 = AC.currentTime + (delay || 0);
    const peak = Math.max(gain || 0.06, 0.00012);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(peak * 0.35, t0 + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.15);
    const lp = AC.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(4200, t0);
    lp.frequency.exponentialRampToValueAtTime(1100, t0 + 0.55);
    lp.Q.value = 0.55;
    const partials = [
      [1, 1, 0],
      [2.003, 0.42, 4],
      [3.006, 0.18, -3],
      [4.015, 0.09, 6],
      [5.02, 0.045, -5]
    ];
    for (let i = 0; i < partials.length; i++) {
      const o = AC.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f * partials[i][0], t0);
      o.detune.setValueAtTime(partials[i][2], t0);
      const pg = AC.createGain();
      const pPeak = Math.max(partials[i][1], 0.00012);
      pg.gain.setValueAtTime(0.0001, t0);
      pg.gain.exponentialRampToValueAtTime(pPeak, t0 + 0.005);
      pg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35 + (1 / (i + 1)) * 0.7);
      o.connect(pg); pg.connect(lp);
      o.start(t0); o.stop(t0 + 1.2);
    }
    lp.connect(g); g.connect(outNode());
    playNoise({ f: f * 4.5, dur: 0.035, gain: peak * 0.22, atk: 0.001, q: 1.4, delay: delay || 0 });
  }

  const WALK_NOTES = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25]; // C 大调五声，中音区钢琴

  const sfx = {
    step: function (i) {
      const f = WALK_NOTES[i % WALK_NOTES.length];
      const pan = ((i % 2) * 2 - 1) * 0.18;
      playPiano(f, 0, 0.055);
      playTone({ f: f * 2, dur: 0.45, gain: 0.012, type: 'sine', lp: 2800, atk: 0.008, pan: pan });
    },
    deny: function () {
      playTone({ f: 196, f2: 140, dur: 0.22, gain: 0.05, type: 'triangle', lp: 500 });
      playNoise({ f: 180, dur: 0.12, gain: 0.03, kind: 'lowpass' });
    },
    hint: function () {
      playTone({ f: 440, dur: 0.18, gain: 0.032, type: 'sine', lp: 1600 });
      playTone({ f: 659.25, delay: 0.05, dur: 0.22, gain: 0.026, type: 'triangle', lp: 2000 });
    },
    dial: function () {
      playTone({ f: 312, dur: 0.16, gain: 0.04, type: 'triangle', lp: 1400 });
      playTone({ f: 468, delay: 0.05, dur: 0.22, gain: 0.038, type: 'sine', lp: 1800 });
      playNoise({ f: 1800, dur: 0.08, gain: 0.016, q: 2.2 });
    },
    settle: function () {
      playTone({ f: 523.25, dur: 0.28, gain: 0.036, type: 'sine', lp: 1600, atk: 0.01 });
      playTone({ f: 784, delay: 0.04, dur: 0.22, gain: 0.022, type: 'sine', lp: 2000 });
    },
    toggle: function () {
      const to2d = camMode === '2d';
      playNoise({ f: to2d ? 1400 : 700, f2: to2d ? 2400 : 320, dur: 0.28, gain: 0.045, atk: 0.01, q: 0.7 });
      if (to2d) {
        playTone({ f: 392, dur: 0.22, gain: 0.04, type: 'sine', lp: 1800 });
        playTone({ f: 587.33, delay: 0.08, dur: 0.32, gain: 0.038, type: 'triangle', lp: 2400 });
      } else {
        playTone({ f: 329.63, dur: 0.26, gain: 0.042, type: 'sine', lp: 1400 });
        playTone({ f: 493.88, delay: 0.07, dur: 0.34, gain: 0.036, type: 'triangle', lp: 1800 });
      }
    },
    key: function () {
      playTone({ f: 783.99, dur: 0.45, gain: 0.05, type: 'sine', lp: 3200, atk: 0.008 });
      playTone({ f: 1174.7, delay: 0.04, dur: 0.55, gain: 0.032, type: 'sine', lp: 3600 });
      playTone({ f: 1568, delay: 0.1, dur: 0.4, gain: 0.018, type: 'triangle', lp: 4000 });
    },
    stele: function () {
      playTone({ f: 220, dur: 0.7, gain: 0.04, type: 'sine', lp: 900, atk: 0.04 });
      playTone({ f: 329.63, delay: 0.08, dur: 0.85, gain: 0.034, type: 'triangle', lp: 1400, atk: 0.05 });
      playTone({ f: 440, delay: 0.22, dur: 0.9, gain: 0.022, type: 'sine', lp: 1800, atk: 0.08 });
    },
    unlock: function () {
      [392, 523.25, 659.25, 784].forEach(function (f, i) {
        playTone({ f: f, delay: i * 0.08, dur: 0.5, gain: 0.04 - i * 0.004, type: 'sine', lp: 2600, atk: 0.015 });
      });
    },
    cross: function () {
      playNoise({ f: 900, f2: 1600, dur: 0.22, gain: 0.03, q: 0.8 });
      playTone({ f: 659.25, dur: 0.32, gain: 0.038, type: 'sine', lp: 2200 });
      playTone({ f: 987.77, delay: 0.07, dur: 0.4, gain: 0.028, type: 'triangle', lp: 2800 });
    },
    win: function () {
      chord([261.63, 329.63, 392, 523.25], 0, 1.15, 0.038, 'sine');
      [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
        playTone({ f: f, delay: 0.18 + i * 0.12, dur: 0.7, gain: 0.042, type: 'triangle', lp: 3000, atk: 0.02 });
      });
    },
    fall: function () {
      playNoise({ f: 1200, f2: 180, dur: 0.55, gain: 0.07, atk: 0.02, q: 0.6 });
      playTone({ f: 392, f2: 98, dur: 0.7, gain: 0.07, type: 'sine', lp: 900, lp2: 220, atk: 0.01 });
      playTone({ f: 196, f2: 70, delay: 0.12, dur: 0.75, gain: 0.05, type: 'triangle', lp: 400 });
    },
    swing: function () {
      playNoise({ f: 1800, f2: 500, dur: 0.14, gain: 0.045, atk: 0.005, q: 1.1 });
      playTone({ f: 240, f2: 120, dur: 0.16, gain: 0.03, type: 'sawtooth', lp: 900 });
    },
    hit: function () {
      playTone({ f: 150, f2: 80, dur: 0.18, gain: 0.05, type: 'square', lp: 480 });
      playNoise({ f: 380, dur: 0.1, gain: 0.032, kind: 'lowpass' });
    },
    foeDie: function () {
      playTone({ f: 280, f2: 70, dur: 0.32, gain: 0.04, type: 'triangle', lp: 700 });
    },
    hurt: function () {
      playTone({ f: 130, f2: 55, dur: 0.32, gain: 0.06, type: 'sawtooth', lp: 420 });
      playNoise({ f: 280, dur: 0.2, gain: 0.04, kind: 'lowpass' });
    },
    // 登录按钮悬停：短促柔和的钢琴点缀
    hover: function () {
      initAudio();
      playTone({ f: 659.25, dur: 0.14, gain: 0.018, type: 'sine', lp: 2400, atk: 0.008 });
      playTone({ f: 987.77, delay: 0.03, dur: 0.18, gain: 0.012, type: 'triangle', lp: 2800, atk: 0.01 });
    }
  };
  window.sfx = sfx;
  function unlockAudio() {
    initAudio();
    // 浏览器自动播放策略：首次手势后再拉起当前关 BGM
    if (bgmIdx >= 0 && bgmFront && bgmFront.paused && effectiveVolume() > 0) {
      bgmFront.play().catch(function () { });
      applyBgmVolume(true);
    }
  }
  document.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);

  function syncMuteUi() {
    const b = document.getElementById('btn-mute');
    const silent = muted || volume <= 0;
    let icon = '🔊';
    if (silent) icon = '🔇';
    else if (volume < 0.34) icon = '🔈';
    else if (volume < 0.67) icon = '🔉';
    if (b) {
      b.textContent = icon;
      b.title = muted ? '开启音效 (M)' : '静音 (M)';
    }
    const pct = Math.round(volume * 100);
    const sl = document.getElementById('vol-slider');
    if (sl && document.activeElement !== sl) sl.value = String(pct);
    const lab = document.getElementById('vol-value');
    if (lab) lab.textContent = String(pct);
  }

  function setVolume(v, opts) {
    const next = Math.max(0, Math.min(1, v));
    volume = next;
    try { localStorage.setItem('pcorridor.volume', String(volume)); } catch (e) { }
    if (opts && opts.unmute && volume > 0 && muted) {
      muted = false;
      try { localStorage.setItem('pcorridor.muted', '0'); } catch (e) { }
    }
    applyMasterGain();
    syncMuteUi();
    applyBgmVolume(opts && opts.instant);
  }

  function toggleMute() {
    muted = !muted;
    try { localStorage.setItem('pcorridor.muted', muted ? '1' : '0'); } catch (e) { }
    applyMasterGain();
    syncMuteUi();
    if (!muted) {
      initAudio();
      playTone({ f: 523.25, dur: 0.22, gain: 0.04, type: 'sine', lp: 2000 });
      playTone({ f: 783.99, delay: 0.06, dur: 0.28, gain: 0.03, type: 'triangle', lp: 2400 });
    }
    applyBgmVolume(false);
  }

  // 各关循环 BGM（音量按 RMS 对齐到约 0.12）
  const BGM_BASE = 0.2;
  const BGM_TRACKS = [
    { src: 'audio/bgm/01-blooming.wav', gain: 0.91 },
    { src: 'audio/bgm/02-hualin.wav', gain: 1.66 },
    { src: 'audio/bgm/03-kezhishaonv.wav', gain: 1.08 },
    { src: 'audio/bgm/04-old.wav', gain: 1.16 },
    { src: 'audio/bgm/05-sensation.wav', gain: 1.31 },
    { src: 'audio/bgm/06-lovesickness.wav', gain: 0.64 },
    { src: 'audio/bgm/07-25haodipian.wav', gain: 0.66 },
    { src: 'audio/bgm/08-yuzhongwu.wav', gain: 1.22 },
    { src: 'audio/bgm/09-xiatiandeyu.wav', gain: 1.19 },
    { src: 'audio/bgm/10-married.wav', gain: 1.24 }
  ];
  let bgmFront = null, bgmBack = null, bgmIdx = -1, bgmFadeTok = 0;

  function makeBgmEl() {
    const a = new Audio();
    a.loop = true;
    a.preload = 'auto';
    a.volume = 0;
    return a;
  }
  function fadeBgmEl(el, to, ms, done) {
    if (!el) { if (done) done(); return; }
    const tok = ++bgmFadeTok;
    const from = el.volume;
    const t0 = performance.now();
    (function tick(now) {
      if (tok !== bgmFadeTok && now - t0 > 20) { /* allow overlapping fades on the other el */ }
      const k = Math.min(1, (now - t0) / ms);
      const v = from + (to - from) * k;
      el.volume = Math.max(0, Math.min(1, v));
      if (k < 1) requestAnimationFrame(tick);
      else if (done) done();
    })(t0);
  }
  function playLevelBgm(levelIndex) {
    const i = ((levelIndex % BGM_TRACKS.length) + BGM_TRACKS.length) % BGM_TRACKS.length;
    const track = BGM_TRACKS[i];
    const targetVol = Math.min(1, BGM_BASE * track.gain * effectiveVolume());
    if (i === bgmIdx && bgmFront) {
      if (effectiveVolume() > 0 && bgmFront.paused) bgmFront.play().catch(function () { });
      fadeBgmEl(bgmFront, targetVol, 400);
      return;
    }
    if (!bgmFront) bgmFront = makeBgmEl();
    if (!bgmBack) bgmBack = makeBgmEl();
    const incoming = bgmBack;
    const outgoing = bgmFront;
    incoming.src = track.src;
    incoming.loop = true;
    incoming.volume = 0;
    incoming.play().catch(function () { });
    fadeBgmEl(incoming, targetVol, 900);
    fadeBgmEl(outgoing, 0, 800, function () {
      outgoing.pause();
      outgoing.removeAttribute('src');
      outgoing.load();
    });
    bgmFront = incoming;
    bgmBack = outgoing;
    bgmIdx = i;
  }
  function applyBgmVolume(instant) {
    if (!bgmFront) return;
    const track = BGM_TRACKS[Math.max(0, bgmIdx)] || BGM_TRACKS[0];
    const targetVol = Math.min(1, BGM_BASE * track.gain * effectiveVolume());
    if (effectiveVolume() <= 0) {
      if (instant) {
        bgmFront.volume = 0;
        bgmFront.pause();
      } else {
        fadeBgmEl(bgmFront, 0, 280, function () {
          if (effectiveVolume() <= 0 && bgmFront) bgmFront.pause();
        });
      }
      return;
    }
    bgmFront.play().catch(function () { });
    if (instant) bgmFront.volume = targetVol;
    else fadeBgmEl(bgmFront, targetVol, 400);
  }

  const MAX_LIVES = 3;
  let lives = MAX_LIVES;
  const state = {
    rotating: false, won: false, switchCount: 0, keys: 0, dying: false,
    hurtPause: false, attacking: false
  };
  let foes = [];
  // 游戏模式：null 未选 · tour 观光 · slaughter 屠戮
  let playMode = null;
  /** 操作方式：keyboard | mouse；登录后进关前选择 */
  const LS_CONTROL = 'pc-control-scheme';
  let controlScheme = null;
  try { controlScheme = localStorage.getItem(LS_CONTROL) || null; } catch (e) { controlScheme = null; }
  if (controlScheme !== 'keyboard' && controlScheme !== 'mouse') controlScheme = null;

  function isKeyboardPlay() { return controlScheme === 'keyboard'; }
  function isMousePlay() { return controlScheme === 'mouse'; }
  function setControlScheme(scheme) {
    if (scheme !== 'keyboard' && scheme !== 'mouse') return;
    controlScheme = scheme;
    try { localStorage.setItem(LS_CONTROL, scheme); } catch (e) { }
    // 切到鼠标时清掉可能还按着的 WASD，避免残留连走
    if (scheme === 'mouse' && typeof clearWasdKey === 'function') {
      try {
        for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) clearWasdKey(code);
      } catch (e) { }
    }
    syncControlUi();
    updateControlCredits();
  }
  function syncControlUi() {
    const kb = document.getElementById('mp-ctrl-kb');
    const ms = document.getElementById('mp-ctrl-mouse');
    if (kb) kb.setAttribute('aria-pressed', controlScheme === 'keyboard' ? 'true' : 'false');
    if (ms) ms.setAttribute('aria-pressed', controlScheme === 'mouse' ? 'true' : 'false');
  }
  function updateControlCredits() {
    const el = document.getElementById('credits');
    if (!el) return;
    if (controlScheme === 'keyboard') {
      el.innerHTML = '<kbd>WASD</kbd> A/D转向 · W/S进退　<kbd>空格</kbd> 视角　<kbd>Q</kbd>/<kbd>E</kbd> 转角　屠戮 <kbd>J</kbd> 攻击　<kbd>Esc</kbd> 停步　<kbd>R</kbd> 重玩 · 键盘模式';
    } else if (controlScheme === 'mouse') {
      el.innerHTML = '点地行走　拖齿轮/转盘　滚轮攻击　<kbd>空格</kbd> 视角　<kbd>Q</kbd>/<kbd>E</kbd> 转角　右键/<kbd>Esc</kbd> 停步　<kbd>R</kbd> 重玩 · 鼠标模式';
    } else {
      el.innerHTML = '<kbd>WASD</kbd> / 点地　<kbd>空格</kbd> 视角　<kbd>Q</kbd>/<kbd>E</kbd> 转角　屠戮 <kbd>J</kbd> / 滚轮攻击　右键/<kbd>Esc</kbd> 停步　<kbd>R</kbd> 重玩';
    }
  }
  const SLAUGHTER_LIMIT_MS = 5 * 60 * 1000;
  let slaughterEndsAt = 0;
  let slaughterTimerPaused = false;
  let slaughterPauseLeft = 0;
  let slaughterFailed = false;
  let slaughterFreezeAt = 0;
  const FOE_VISION = 5.5;
  const FOE_SPEED = 2.65 * 0.55; // 明显慢于主角，方便走位与挥砍
  const FOE_HP = 1;              // 一刀斩杀
  const FOE_CONTACT_CD = 2.0;   // 碰触扣血间隔（越大攻击越慢）
  const FOE_AI_STEP = 0.2;      // AI 决策间隔
  const FOE_LAYER_EPS = 0.45;   // 同层高度容差（防穿楼板攻击）
  const SWORD_RANGE = 2.15;     // 大剑攻击半径（格子尺度）
  const SWORD_FAN = Math.PI * 0.78; // 扇形张角，约 140°
  const SWORD_WINDUP = 0.08;
  const SWORD_ACTIVE = 0.12;
  const SWORD_RECOVERY = 0.18;
  // 后摇尚未结束即可移动/再挥，手感更连贯
  const SWORD_UNLOCK = 0.06;

  function isSlaughter() { return playMode === 'slaughter'; }
  /** 第 0 关试验场：观光亦可测剑 / 影怪 / 心 */
  function isSandboxNow() { return !!(curLevel && curLevel.sandbox); }
  function combatEnabled() { return isSlaughter() || isSandboxNow(); }
  function isTour() { return playMode === 'tour'; }
  function isModePickOpen() {
    const el = document.getElementById('mode-pick');
    return !!(el && !el.classList.contains('hidden'));
  }
  function isUiBlocking() {
    // 章节/关于/通关等遮罩打开时，禁止行走与按键（不含已单独用 slaughterFailed 处理的失败页）
    const ids = ['levels', 'about', 'win'];
    for (let i = 0; i < ids.length; i++) {
      const el = document.getElementById(ids[i]);
      if (el && !el.classList.contains('hidden')) return true;
    }
    return false;
  }
  function isGameInteractive() {
    return !Auth.isActive() && !!playMode && !isModePickOpen() && !slaughterFailed && !isUiBlocking();
  }

  // ------------------------------------------------ 寻路图（视角即规则：本视角里"看起来相邻"就能走）
  let nodes = [], rotors = [], dials = [];
  let gears = [], gearHits = [];
  let illuNodes = new Set(), stairNodes = new Set(), climbNodes = new Set();
  let prevIlluCount = null;
  let adjByMode = { '3d': new Map(), '2d': new Map() };
  let adjBySnap = {}; // 各 3D 方位各自的邻接表
  let adj = adjByMode['3d'];
  let startNode = null, goalNode = null, levelPar = 0;
  let viewSnap = 0; // 3D 方位 0..3（绕 Y 每 90°）
  const _v = new THREE.Vector3();

  /** 关卡允许的 3D 方位；默认仅甲向（与旧关兼容） */
  function levelViewSnaps() {
    const vs = curLevel && curLevel.viewSnaps;
    if (Array.isArray(vs) && vs.length) {
      const out = [];
      for (const v of vs) {
        const s = ((v % 4) + 4) % 4;
        if (out.indexOf(s) < 0) out.push(s);
      }
      return out.length ? out : [0];
    }
    return [0];
  }
  function levelHasMultiView() {
    return levelViewSnaps().length > 1;
  }
  /** 投影方向 (sx,1,sz)：等距相机从该卦限望入时，沿此向量的错觉对齐才成立 */
  function viewDirForSnap(snap) {
    const s = ((snap % 4) + 4) % 4;
    if (s === 0) return [1, 1];
    if (s === 1) return [-1, 1];
    if (s === 2) return [-1, -1];
    return [1, -1];
  }
  const VIEW_SNAP_NAME = ['甲', '乙', '丙', '丁'];

  // 相位节点在所属视角里才参与寻路
  function nodeOnWall(n) {
    const walls = (curLevel && curLevel.walls) || [];
    const x = Math.round(n.pos.x), y = Math.round(n.pos.y), z = Math.round(n.pos.z);
    for (const w of walls) {
      if (Math.round(w[0]) === x && Math.round(w[1]) === y && Math.round(w[2]) === z) return true;
    }
    return false;
  }
  /** 顶面颜色键：同色是划平面的必要条件，还须四邻连通 */
  function tileColorKey(n) {
    return topColorFor(n.pos.y);
  }

  function buildAdj(mode, snapOpt) {
    const m = new Map(nodes.map(n => [n, []]));
    const act = nodes.filter(n =>
      (!n.phase || n.phase === mode) && !nodeOnWall(n) && !(mode === '2d' && n.drop));
    const illu = new Set(), stair = new Set(), climb = new Set();
    if (mode === '2d') {
      // 2D 俯视：xz 脚印相邻即可走（高度被压平，含一切高差）；同列竖叠也可爬
      for (const n of act) n.planeId = -1;
      const cell = new Map();
      for (const n of act) {
        const k = Math.round(n.pos.x * 2) + ',' + Math.round(n.pos.z * 2);
        if (!cell.has(k)) cell.set(k, []);
        cell.get(k).push(n);
      }
      for (const n of act) {
        const cx = Math.round(n.pos.x * 2), cz = Math.round(n.pos.z * 2);
        const seen = new Set();
        const link = (nb) => {
          if (!nb || nb === n || seen.has(nb)) return;
          seen.add(nb);
          m.get(n).push(nb);
          if (Math.abs(nb.pos.y - n.pos.y) > 0.5) { stair.add(n); stair.add(nb); }
        };
        for (const dd of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
          for (const nb of (cell.get((cx + dd[0]) + ',' + (cz + dd[1])) || [])) link(nb);
        }
        for (const nb of (cell.get(cx + ',' + cz) || [])) link(nb);
      }
    } else {
      // 3D：同色 + 四邻连成一片 → 同一平面，仅平面内可自由走
      // 同色但不相连（两片孤岛）= 不同 planeId，不能直接走过去
      // 有侧面色差的高差（|dy|≥1）在 3D 不可爬，须切俯视
      // 另：投影错觉远跨（随 3D 方位 snap 改变投影向量）
      const snap = snapOpt != null ? snapOpt : viewSnap;
      const [sx, sz] = viewDirForSnap(snap);
      const maxK = (curLevel && curLevel.maxIllusionK != null) ? curLevel.maxIllusionK : 1;
      const pos = new Map();
      for (const n of act) {
        const k = Math.round(n.pos.x * 2) + ',' + Math.round(n.pos.y * 2) + ',' + Math.round(n.pos.z * 2);
        pos.set(k, n);
      }
      const occ = new Map();
      for (const n of nodes) {
        if (nodeOnWall(n)) continue;
        const k = Math.round(n.pos.x * 2) + ',' + Math.round(n.pos.y * 2) + ',' + Math.round(n.pos.z * 2);
        occ.set(k, n);
      }

      // 洪泛：必须「同色」且「四邻相连」才合并为同一平面
      let planeSeq = 0;
      for (const n of act) n.planeId = -1;
      for (const seed of act) {
        if (seed.planeId >= 0) continue;
        const ck = tileColorKey(seed);
        const q = [seed];
        seed.planeId = planeSeq;
        while (q.length) {
          const cur = q.shift();
          const cx = Math.round(cur.pos.x * 2), cy = Math.round(cur.pos.y * 2), cz = Math.round(cur.pos.z * 2);
          for (const d of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
            const nb = pos.get((cx + d[0]) + ',' + cy + ',' + (cz + d[1]));
            if (!nb || nb.planeId >= 0) continue;
            if (tileColorKey(nb) !== ck) continue; // 色差 → 不是同一平面
            nb.planeId = planeSeq;
            q.push(nb);
          }
        }
        planeSeq++;
      }

      const D4 = [[2, 0, 0], [-2, 0, 0], [0, 0, 2], [0, 0, -2]];
      for (const n of act) {
        const px = Math.round(n.pos.x * 2), py = Math.round(n.pos.y * 2), pz = Math.round(n.pos.z * 2);
        const linked = new Set();
        const link = (nb, asIllu) => {
          if (!nb || nb === n || linked.has(nb)) return;
          linked.add(nb);
          m.get(n).push(nb);
          if (asIllu) { illu.add(n); illu.add(nb); }
        };
        // 同一平面内：仅同高四邻，且必须同 planeId（同色且已连通）
        for (const d of D4) {
          const nb = pos.get((px + d[0]) + ',' + py + ',' + (pz + d[2]));
          if (!nb) continue;
          if (nb.planeId !== n.planeId) continue; // 同色孤岛 / 色差：不可直接连
          if (tileColorKey(nb) !== tileColorKey(n)) continue;
          link(nb, false);
        }
        // |dy|≥1 脚印邻接：侧面墙色打断平面，3D 不能爬，须切俯视
        for (const d of D4) {
          const up = pos.get((px + d[0]) + ',' + (py + 2) + ',' + (pz + d[2]));
          const dn = pos.get((px + d[0]) + ',' + (py - 2) + ',' + (pz + d[2]));
          if (up) { climb.add(n); climb.add(up); }
          if (dn) { climb.add(n); climb.add(dn); }
          // 视错觉远跨：B = A + 侧向一步 + k*(sx,1,sz)
          for (let k = -maxK; k <= maxK; k++) {
            if (k === 0) continue;
            const nb = pos.get((px + d[0] + 2 * k * sx) + ',' + (py + 2 * k) + ',' + (pz + d[2] + 2 * k * sz));
            if (!nb || nb === n) continue;
            const foot = Math.abs(nb.pos.x - n.pos.x) + Math.abs(nb.pos.z - n.pos.z);
            if (foot < 1.1) continue;
            const midFoot = occ.get((px + d[0]) + ',' + py + ',' + (pz + d[2]));
            const midRise = occ.get((px + 2 * k * sx) + ',' + (py + 2 * k) + ',' + (pz + 2 * k * sz));
            if (midFoot || midRise) continue;
            link(nb, true);
          }
        }
      }
      // 全局显式对齐对（任意方位）
      const pairs = (curLevel && curLevel.illusionPairs) || [];
      for (const pair of pairs) {
        if (!pair || pair.length < 2) continue;
        const a = nodeAt(pair[0][0], pair[0][1], pair[0][2]);
        const b = nodeAt(pair[1][0], pair[1][1], pair[1][2]);
        if (!a || !b || a === b) continue;
        if ((a.phase && a.phase !== mode) || (b.phase && b.phase !== mode)) continue;
        const la = m.get(a), lb = m.get(b);
        if (la && la.indexOf(b) < 0) la.push(b);
        if (lb && lb.indexOf(a) < 0) lb.push(a);
        illu.add(a); illu.add(b);
      }
      // 方位专属对齐对：illusionPairsAt: { 0: [[[a],[b]], ...], 2: [...] }
      const atMap = (curLevel && curLevel.illusionPairsAt) || null;
      if (atMap) {
        const atPairs = atMap[snap] || atMap[String(snap)] || [];
        for (const pair of atPairs) {
          if (!pair || pair.length < 2) continue;
          const a = nodeAt(pair[0][0], pair[0][1], pair[0][2]);
          const b = nodeAt(pair[1][0], pair[1][1], pair[1][2]);
          if (!a || !b || a === b) continue;
          if ((a.phase && a.phase !== mode) || (b.phase && b.phase !== mode)) continue;
          const la = m.get(a), lb = m.get(b);
          if (la && la.indexOf(b) < 0) la.push(b);
          if (lb && lb.indexOf(a) < 0) lb.push(a);
          illu.add(a); illu.add(b);
        }
      }
    }
    if (mode === '3d' && (snapOpt == null || snapOpt === viewSnap)) {
      illuNodes = illu; climbNodes = climb;
    }
    else if (mode === '2d') stairNodes = stair;
    return m;
  }

  function planeY(n) {
    return camMode === '2d' ? 0.04 : (n ? n.pos.y : 0);
  }

  function snapCharToNode(n) {
    if (!char.group || !n) return;
    char.group.position.x = n.pos.x;
    char.group.position.z = n.pos.z;
    char.group.position.y = planeY(n);
  }

  // 2D：每块砖的顶面都对齐到 y=0（盒子往下长），俯视就是一张平地图。
  // 角色始终在 y≈0 的 xz 上走，不会钻进高台盒子里被挡住。
  let planarMorphTween = null;
  function tileMeshTargetY(n, flat) {
    const h = n.mesh.geometry.parameters.height || 1;
    if (n.rotorRef && n.local) {
      return flat ? (-n.rotorRef.group.position.y - h / 2) : (n.local.y - h / 2);
    }
    return (flat ? 0 : n.pos.y) - h / 2;
  }
  /** 收集压平/还原的目标高度（不改场景，供插值用） */
  function collectPlanarMorphTargets(flat) {
    const items = [];
    function pushY(obj, to) {
      if (!obj) return;
      items.push({ obj: obj, from: obj.y, to: to });
    }
    for (const n of nodes) {
      if (!n.mesh) continue;
      pushY(n.mesh.position, tileMeshTargetY(n, flat));
      const top = flat ? 0 : n.pos.y;
      pushY(n.stelePed && n.stelePed.position, top);
      pushY(n.steleHalo && n.steleHalo.position, top + 0.03);
      if (n.steleGlyph) {
        const gy = n.steleGlyphY0 != null ? n.steleGlyphY0 : 1.06;
        // glyph 本地 y 相对 pedestal；保持设定值，不随压平改本地偏移
        pushY(n.steleGlyph.position, gy);
      }
      pushY(n.spawnPad && n.spawnPad.position, top + 0.028);
      pushY(n.spawnPadIn && n.spawnPadIn.position, top + 0.03);
    }
    for (const w of wallMeshes) {
      if (!w.mesh) continue;
      pushY(w.mesh.position, flat ? (-w.h / 2 + 0.02) : (w.y + w.h / 2 - 0.02));
    }
    for (const d of dials) {
      if (d.baseY == null || !d.group) continue;
      pushY(d.group.position, flat ? -d.baseY : 0);
    }
    for (const g of gears) {
      if (!g.root) continue;
      if (g.y0 == null) g.y0 = g.root.position.y;
      pushY(g.root.position, flat ? 0.22 : g.y0);
    }
    if (goalFx && goalNode) {
      const top = flat ? 0 : goalNode.pos.y;
      pushY(goalFx.ring.position, top + 0.05);
      pushY(goalFx.gem.position, top + 0.62);
    }
    // 角色高度不参与插值：由 settleAfterToggle / snap 立即落稳，避免与 morph 抢 Y
    return items;
  }
  function applyPlanarLayout() {
    const flat = camMode === '2d';
    if (planarMorphTween) {
      try { planarMorphTween.kill(); } catch (e) { }
      planarMorphTween = null;
    }
    for (const n of nodes) {
      if (!n.mesh) continue;
      n.mesh.scale.y = 1;
      n.mesh.position.y = tileMeshTargetY(n, flat);
      const top = flat ? 0 : n.pos.y;
      if (n.stelePed) n.stelePed.position.y = top;
      if (n.steleHalo) n.steleHalo.position.y = top + 0.03;
      if (n.steleGlyph) {
        gsap.killTweensOf(n.steleGlyph.position);
        n.steleGlyph.position.y = n.steleGlyphY0 != null ? n.steleGlyphY0 : 1.06;
        decorTween(n.steleGlyph.position, { y: '+=0.08', duration: 1.8, ease: 'sine.inOut', yoyo: true, repeat: -1 });
      }
      if (n.spawnPad) n.spawnPad.position.y = top + 0.028;
      if (n.spawnPadIn) n.spawnPadIn.position.y = top + 0.03;
    }
    for (const w of wallMeshes) {
      w.mesh.scale.y = 1;
      w.mesh.position.y = flat ? (-w.h / 2 + 0.02) : (w.y + w.h / 2 - 0.02);
    }
    for (const d of dials) {
      if (d.baseY == null) continue;
      d.group.position.y = flat ? -d.baseY : 0;
    }
    for (const g of gears) {
      if (g.y0 == null) g.y0 = g.root.position.y;
      g.root.position.y = flat ? 0.22 : g.y0;
    }
    if (goalFx && goalNode) {
      const top = flat ? 0 : goalNode.pos.y;
      goalFx.ring.position.y = top + 0.05;
      gsap.killTweensOf(goalFx.gem.position);
      gsap.killTweensOf(goalFx.gem.rotation);
      goalFx.gem.position.y = top + 0.62;
      decorTween(goalFx.gem.position, { y: '+=0.16', duration: 1.4, ease: 'sine.inOut', yoyo: true, repeat: -1 });
      decorTween(goalFx.gem.rotation, { y: Math.PI * 2, duration: 4, ease: 'none', repeat: -1 });
    }
    if (char.group) {
      syncCharDepthForMode(flat);
      if (char.node && !char.walking) snapCharToNode(char.node);
      else char.group.position.y = planeY(char.node);
    }
  }
  /**
   * 与镜头同步插值压平/还原（功能完整，只是把瞬时跳变改成过渡）。
   * animated=false 时等价于 applyPlanarLayout。
   */
  function morphPlanarLayout(animated) {
    const flat = camMode === '2d';
    // 深度测试与角色落点立即切换，避免半程穿模；砖块高度走插值
    if (char.group) {
      syncCharDepthForMode(flat);
      if (char.node && !char.walking) snapCharToNode(char.node);
      else if (char.node) char.group.position.y = planeY(char.node);
    }
    if (!animated) {
      applyPlanarLayout();
      return;
    }
    if (planarMorphTween) {
      try { planarMorphTween.kill(); } catch (e) { }
      planarMorphTween = null;
    }
    const items = collectPlanarMorphTargets(flat);
    if (!items.length) {
      applyPlanarLayout();
      return;
    }
    // 预停装饰循环，避免插值过程中 yoyo 抢高度
    for (const n of nodes) {
      if (n.steleGlyph) gsap.killTweensOf(n.steleGlyph.position);
    }
    if (goalFx && goalFx.gem) {
      gsap.killTweensOf(goalFx.gem.position);
      gsap.killTweensOf(goalFx.gem.rotation);
    }
    const dur = camAnimDuration();
    const ease = gfxTier <= 0 ? 'sine.inOut' : 'power2.inOut';
    const pr = { t: 0 };
    planarMorphTween = gsap.to(pr, {
      t: 1, duration: dur, ease: ease,
      onUpdate: () => {
        const t = pr.t;
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          it.obj.y = it.from + (it.to - it.from) * t;
        }
      },
      onComplete: () => {
        planarMorphTween = null;
        applyPlanarLayout(); // 落到精确值并恢复装饰循环
      }
    });
    try { scheduleAnimate(0); } catch (e) { }
  }
  /** 缓存角色材质，避免每次切视角 traverse 整棵角色树 */
  function syncCharDepthForMode(flat) {
    if (!char.group) return;
    const order = flat ? 8 : 0;
    const depth = !flat;
    if (!char.depthMats) {
      char.depthMats = [];
      char.group.traverse(o => {
        if (o.isMesh && o.material) char.depthMats.push(o);
      });
    }
    char.group.renderOrder = order;
    for (let i = 0; i < char.depthMats.length; i++) {
      const o = char.depthMats[i];
      o.renderOrder = order;
      if (o.material) o.material.depthTest = depth;
    }
  }

  function updateGraph() {
    for (const r of rotors) r.group.updateMatrixWorld(true);
    for (const n of nodes) {
      if (n.rotorRef) {
        _v.copy(n.local);
        n.rotorRef.group.localToWorld(_v);
        n.pos.set(Math.round(_v.x * 2) / 2, Math.round(_v.y * 2) / 2, Math.round(_v.z * 2) / 2);
      }
    }
    adjByMode['2d'] = buildAdj('2d');
    adjBySnap = {};
    for (const s of levelViewSnaps()) {
      adjBySnap[s] = buildAdj('3d', s);
    }
    if (!adjBySnap[viewSnap]) {
      viewSnap = levelViewSnaps()[0];
      adjBySnap[viewSnap] = buildAdj('3d', viewSnap);
    }
    adjByMode['3d'] = adjBySnap[viewSnap];
    adj = adjByMode[camMode];
    applyGlints();
    applyPlanarLayout();
    if (prevIlluCount == null) {
      prevIlluCount = illuNodes.size;
    } else if (illuNodes.size > prevIlluCount) {
      prevIlluCount = illuNodes.size;
      sfx.cross();
      toast('✧ 齿轮一转，远砖在画面上对齐了——路通了', 3200, 'good');
    } else if (illuNodes.size < prevIlluCount) {
      prevIlluCount = illuNodes.size;
      toast('错觉断开了……再转一转，或换个方位', 2600, 'warn');
    } else {
      prevIlluCount = illuNodes.size;
    }
  }

  // ------------------------------------------------ 同一视角 · 同一平面
  // 等距投影坐标（随当前 3D 方位）：用来判断「画面上是否在同一平面/相邻」
  function isoUV(n) {
    const x = n.pos.x, y = n.pos.y, z = n.pos.z;
    const [sx, sz] = viewDirForSnap(viewSnap);
    // 与视线 (sx,1,sz) 正交的水平轴：u = sz*x - sx*z
    return { u: sz * x - sx * z, v: (sx * x + y + sz * z) * Math.SQRT1_2 };
  }
  function isoDist(a, b) {
    const A = isoUV(a), B = isoUV(b);
    const du = A.u - B.u, dv = A.v - B.v;
    return Math.sqrt(du * du + dv * dv);
  }
  /** 同色且连通的平面内滑步（不含错觉远跨、不含台阶） */
  function isPlanarEdge(a, b, mode) {
    if (!a || !b) return false;
    if (mode === '2d') return true;
    return a.planeId >= 0 && a.planeId === b.planeId;
  }
  /**
   * 同视角走路代价：同色连通平面内优先；同色但不同 planeId（未相连）不会有平面边
   */
  function walkEdgeCost(a, b, mode, goal) {
    let c = 1;
    if (mode === '3d' && goal) {
      const samePlane = a.planeId >= 0 && a.planeId === b.planeId;
      const goalSame = goal.planeId >= 0 && a.planeId === goal.planeId;
      if (goalSame) {
        if (samePlane) c = 0.85;
        else c += 0.35;
      } else {
        const need = goal.pos.y - a.pos.y;
        const got = b.pos.y - a.pos.y;
        if (samePlane && Math.abs(need) > 0.25) c += 0.2;
        if (Math.abs(got) > 0.5 && Math.sign(got) === Math.sign(need)) c -= 0.1;
        else if (Math.abs(got) > 0.5 && Math.sign(got) !== Math.sign(need)) c += 0.35;
      }
    }
    c += isoDist(b, goal) * 0.001;
    return c;
  }

  // 视角切换次数最少的路线；同切换下按「同一平面」逻辑选路（少绕平地、少无意义换层）
  // 费用 = 切换次数 * TOGGLE_COST + 平面感知步代价
  // 多方位关：3D 内换甲乙丙丁也算一次切换
  const TOGGLE_COST = 10000;
  function adjForModeSnap(mode, snap) {
    if (mode === '2d') return adjByMode['2d'];
    return adjBySnap[snap] || adjByMode['3d'];
  }
  function planRoute(from, to) {
    if (from === to) return null;
    const snaps = levelViewSnaps();
    const key = (n, m, s) => n.idx + '|' + m + '|' + (m === '3d' ? s : '_');
    const dist = new Map(), prev = new Map();
    const s0 = viewSnap;
    const k0 = key(from, camMode, s0);
    dist.set(k0, 0);
    const pq = [[0, from, camMode, s0]];
    let endK = null;
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]);
      const [d, n, m, s] = pq.shift();
      const k = key(n, m, s);
      if (d > dist.get(k)) continue;
      if (n === to) { endK = k; break; }
      const relax = (nn, mm, ss, nd, viaToggle) => {
        const kk = key(nn, mm, ss);
        if (!dist.has(kk) || nd < dist.get(kk)) {
          dist.set(kk, nd);
          prev.set(kk, { n: n, m: m, s: s, viaToggle: viaToggle });
          pq.push([nd, nn, mm, ss]);
        }
      };
      const graph = adjForModeSnap(m, s);
      const nbs = (graph.get(n) || []).slice().sort((a, b) => isoDist(a, to) - isoDist(b, to));
      for (const nb of nbs) relax(nb, m, s, d + walkEdgeCost(n, nb, m, to), false);
      // 2D ↔ 3D
      relax(n, m === '3d' ? '2d' : '3d', s, d + TOGGLE_COST, true);
      // 3D 内换方位（仅多视角关）
      if (m === '3d' && snaps.length > 1) {
        for (const ns of snaps) {
          if (ns !== s) relax(n, '3d', ns, d + TOGGLE_COST, true);
        }
      }
    }
    if (!endK) return null;
    // 回溯状态链（终点 → 起点）
    const states = [];
    let k = endK;
    while (k) {
      const parts = k.split('|');
      states.unshift({ idx: +parts[0], m: parts[1], s: parts[2] === '_' ? s0 : +parts[2] });
      const p = prev.get(k);
      k = p ? key(p.n, p.m, p.s) : null;
    }
    const total = Math.floor(dist.get(endK) / TOGGLE_COST);
    // 第一段 = 当前视角+方位下、第一次切换之前可连续行走的节点序列
    const leg = [nodes[states[0].idx]];
    let needMode = null;
    let needSnap = null;
    for (let i = 1; i < states.length; i++) {
      const a = states[i - 1], b = states[i];
      if (b.m !== a.m || (b.m === '3d' && b.s !== a.s)) {
        needMode = b.m;
        needSnap = b.m === '3d' ? b.s : null;
        break;
      }
      leg.push(nodes[states[i].idx]);
    }
    return { leg: leg, needMode: needMode, needSnap: needSnap, total: total, steps: dist.get(endK) % TOGGLE_COST };
  }

  function popcount(mask) {
    let c = 0, x = mask | 0;
    while (x) { c += x & 1; x >>>= 1; }
    return c;
  }

  function levelKeyOrder() {
    return !!(curLevel && curLevel.keyOrder);
  }

  /** 序星关：下一枚应拾序号（已拾枚数 + 1）；非序星返回 null */
  function nextKeyOrd() {
    if (!levelKeyOrder()) return null;
    return state.keys + 1;
  }

  function canCollectKey(n, haveKeys) {
    if (!n || !n.key) return false;
    if (!levelKeyOrder()) return true;
    const want = (haveKeys != null ? haveKeys : state.keys) + 1;
    // 序星关必须显式编号；无序号不可拾（禁止绕过顺序）
    return n.keyOrd != null && n.keyOrd === want;
  }

  // 起点到终点的最少视角切换次数（含收集全部星屑；评级 + 调试）
  // 状态 = (节点, 视角, 方位, 星屑掩码)，星屑 ≤ 10 枚；keyOrder 时仅按序号吸收
  function minToggles(from, to) {
    const keyNodes = nodes.filter(n => n.key);
    if (keyNodes.length > 10) return planRoute(from, to) ? planRoute(from, to).total : Infinity;
    const keyIndex = new Map(keyNodes.map((k, i) => [k, i]));
    const ordered = levelKeyOrder();
    const full = (1 << keyNodes.length) - 1;
    const snaps = levelViewSnaps();
    const dist = new Map();
    const kk = (n, m, s, mask) => n.idx + '|' + m + '|' + (m === '3d' ? s : '_') + '|' + mask;
    const startMask = 0;
    dist.set(kk(from, camMode, viewSnap, startMask), 0);
    const pq = [[0, from, camMode, viewSnap, startMask]];
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]);
      const [d, n, m, s, mask] = pq.shift();
      const k = kk(n, m, s, mask);
      if (d > dist.get(k)) continue;
      if (n === to && mask === full) return d;
      const relax = (nn, mm, ss, nd, nmask) => {
        const k2 = kk(nn, mm, ss, nmask);
        if (!dist.has(k2) || nd < dist.get(k2)) { dist.set(k2, nd); pq.push([nd, nn, mm, ss, nmask]); }
      };
      const graph = adjForModeSnap(m, s);
      for (const nb of (graph.get(n) || [])) {
        let nm = mask;
        if (keyIndex.has(nb)) {
          const bit = keyIndex.get(nb);
          if (ordered) {
            const ord = keyNodes[bit].keyOrd;
            if (ord != null && ord === popcount(mask) + 1) nm = mask | (1 << bit);
          } else {
            nm = mask | (1 << bit);
          }
        }
        relax(nb, m, s, d, nm);
      }
      relax(n, m === '3d' ? '2d' : '3d', s, d + 1, mask);
      if (m === '3d' && snaps.length > 1) {
        for (const ns of snaps) {
          if (ns !== s) relax(n, '3d', ns, d + 1, mask);
        }
      }
    }
    return Infinity;
  }

  // ------------------------------------------------ 关卡搭建
  let curLevel = null, levelIdx = 0;
  let world = null, goalFx = null;
  let wallMeshes = [];
  let walkMeshes = [], dialHits = [], keyHits = [];
  let goalLockPulse = 0;
  let keysTotal = 0;

  function disposeWorld() {
    if (typeof abortGearDrag === 'function') abortGearDrag(true);
    if (!world) return;
    world.traverse(o => {
      if (o.geometry) {
        // 缓存的 BoxGeometry 跨关复用，不 dispose
        let cached = false;
        try {
          for (const g of geoCache.values()) { if (g === o.geometry) { cached = true; break; } }
        } catch (e) { }
        if (!cached) o.geometry.dispose();
      }
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (let i = 0; i < mats.length; i++) {
        const m = mats[i];
        if (!m || (m.userData && m.userData.shared)) continue;
        m.dispose();
      }
    });
    scene.remove(world);
    world = null;
  }

  function nodeAt(x, y, z) {
    return nodes.find(n => Math.round(n.pos.x * 2) === Math.round(x * 2) &&
      Math.round(n.pos.y * 2) === Math.round(y * 2) &&
      Math.round(n.pos.z * 2) === Math.round(z * 2)) || null;
  }

  function loadLevel(idx, opts) {
    levelIdx = idx;
    curLevel = LEVELS[idx];
    // 每一关进入时音量回到 10（静音状态保留）
    if (typeof setVolume === 'function') setVolume(0.1, { instant: true });
    disposeWorld();
    nodes = []; rotors = []; dials = [];
    gears = []; gearHits = [];
    walkMeshes = []; dialHits = []; keyHits = [];
    wallMeshes = [];
    clearFoes();
    prevIlluCount = null;
    goalFx = null; keysTotal = 0;
    keyHinted = null;
    gsap.globalTimeline.clear();
    gsap.globalTimeline.timeScale(1);
    state.won = false; state.switchCount = 0; state.keys = 0; state.rotating = false;
    state.dying = false; state.hurtPause = false; state.attacking = false;
    swordBuffered = false;
    if (typeof clearSwordFlash === 'function') clearSwordFlash();
    if (typeof stopTauntCycle === 'function') stopTauntCycle();
    if (typeof hurtTimer !== 'undefined' && hurtTimer) { clearTimeout(hurtTimer); hurtTimer = null; }
    if (typeof hurtDoneTimer !== 'undefined' && hurtDoneTimer) { clearTimeout(hurtDoneTimer); hurtDoneTimer = null; }
    const hurtFx = document.getElementById('hurt-fx');
    if (hurtFx) {
      hurtFx.hidden = true;
      hurtFx.classList.remove('show', 'out', 'empty');
    }
    document.body.classList.remove('hurt-shake');
    if (typeof wasdHeld !== 'undefined') {
      for (const code of [...wasdHeld]) clearWasdKey(code);
    }
    if (!opts || !opts.keepLives) lives = MAX_LIVES;
    
    document.getElementById('win').classList.add('hidden');
    if (marker) marker.visible = false;
    hideHover();
    hideArchitectNote();
    if (!opts || !opts.afterFall) {
      hideToast();
      hideLevelOpener();
    } else {
      hideLevelOpener();
    }

    world = new THREE.Group();
    scene.add(world);
    setSkyTheme(curLevel.bg);
    camMode = '3d';
    viewSnap = levelViewSnaps()[0];
    document.body.classList.remove('mode-2d');
    resetOrbitAngles();
    syncYawButtons();

    for (const rd of curLevel.rotors || []) {
      const group = new THREE.Group();
      group.position.set(rd.pivot[0], rd.pivot[1], rd.pivot[2]);
      group.rotation.y = (rd.angle0 || 0) * Math.PI / 180;
      world.add(group);
      rotors.push({ id: rd.id, group: group });
    }
    const rotorById = id => rotors.find(r => r.id === id);

    // --- 地砖节点（同位去重：显式瓦片与平台重叠时合并标记）
    const seenPos = new Map();
    const deduped = [];
    for (const nd of curLevel.nodes) {
      const k = Math.round(nd.x * 2) + ',' + Math.round(nd.y * 2) + ',' + Math.round(nd.z * 2);
      const ex = seenPos.get(k);
      if (ex) {
        if (nd.key) ex.key = true;
        if (nd.keyOrd != null) ex.keyOrd = nd.keyOrd;
        if (nd.stele) ex.stele = nd.stele;
        if (nd.goal) ex.goal = true;
        if (nd.phase) ex.phase = nd.phase;
        if (nd.decoy) ex.decoy = true;
        if (nd.drop) ex.drop = true;
        continue;
      }
      seenPos.set(k, nd);
      deduped.push(nd);
    }
    for (const nd of deduped) {
      const rotorRef = nd.rotor ? rotorById(nd.rotor) : null;
      // 旋转件节点：levels 里给的是绝对坐标，转成相对 pivot 的局部坐标
      const localPos = nd.rotor && rotorRef
        ? new THREE.Vector3(nd.x - rotorRef.group.position.x, nd.y - rotorRef.group.position.y, nd.z - rotorRef.group.position.z)
        : null;
      const n = {
        idx: nodes.length,
        rotorRef: rotorRef,
        local: localPos,
        pos: new THREE.Vector3(nd.x, nd.y, nd.z),
        phase: nd.phase || null,
        goal: !!nd.goal, key: !!nd.key,
        keyOrd: nd.keyOrd != null ? nd.keyOrd : null,
        stele: nd.stele || null,
        drop: !!nd.drop, decoy: !!nd.decoy,
        body: nd.body != null ? nd.body : 1.0
      };
      nodes.push(n);
      if (n.rotorRef) n.rotorRef.group.updateMatrixWorld(true);
      const mats = makeTileMats(nd.y, false);
      const h = 1 + n.body;
      const mesh = new THREE.Mesh(boxGeo(1, h, 1), mats);
      // 转子砖：局部 y = localPos.y - h/2（组原点在砖顶高度），否则砖会浮高 pivot.y
      if (n.rotorRef) mesh.position.set(localPos.x, localPos.y - h / 2, localPos.z);
      else mesh.position.set(nd.x, nd.y - h / 2, nd.z);
      mesh.userData.node = n;
      n.mesh = mesh;
      (n.rotorRef ? n.rotorRef.group : world).add(mesh);
      walkMeshes.push(mesh);
      if (n.phase) applyPhaseStyle(n);
      else if (n.drop) applyDropStyle(n);
    }
    nodes.forEach((n, i) => n.idx = i);

    // --- 起点 / 终点 / 门锁（屠戮模式：出生与终点对调）
    const rawStart = curLevel.start;
    const rawGoal = curLevel.goal;
    const effStart = isSlaughter() ? rawGoal : rawStart;
    const effGoal = isSlaughter() ? rawStart : rawGoal;
    startNode = nodeAt(effStart[0], effStart[1], effStart[2]);
    goalNode = nodeAt(effGoal[0], effGoal[1], effGoal[2]);
    if (goalNode) { goalNode.goal = true; goalNode.need = curLevel.goalNeed || 0; }

    // --- 目标金环（未解锁为灰色）
    if (goalNode) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.045, 10, 40),
        new THREE.MeshBasicMaterial({ color: 0x9a9aa2, transparent: true }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(goalNode.pos.x, goalNode.pos.y + 0.05, goalNode.pos.z);
      world.add(ring);
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.16),
        new THREE.MeshBasicMaterial({ color: curLevel.pal.goal }));
      gem.position.set(goalNode.pos.x, goalNode.pos.y + 0.62, goalNode.pos.z);
      world.add(gem);
      decorTween(gem.position, { y: '+=0.16', duration: 1.4, ease: 'sine.inOut', yoyo: true, repeat: -1 });
      decorTween(gem.rotation, { y: Math.PI * 2, duration: 4, ease: 'none', repeat: -1 });
      goalFx = { ring: ring, gem: gem };
      updateGoalLock();
    }

    // --- 起点落脚环（贴地、不挡视线；与石碑、角色错开）
    if (startNode) {
      const pad = new THREE.Mesh(new THREE.RingGeometry(0.30, 0.38, 32),
        new THREE.MeshBasicMaterial({
          color: 0xc9a24b, transparent: true, opacity: 0.55,
          side: THREE.DoubleSide, depthWrite: false
        }));
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(startNode.pos.x, startNode.pos.y + 0.028, startNode.pos.z);
      world.add(pad);
      startNode.spawnPad = pad;
      const padIn = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.16, 24),
        new THREE.MeshBasicMaterial({
          color: 0xe8c070, transparent: true, opacity: 0.4,
          side: THREE.DoubleSide, depthWrite: false
        }));
      padIn.rotation.x = -Math.PI / 2;
      padIn.position.copy(pad.position).y += 0.002;
      world.add(padIn);
      startNode.spawnPadIn = padIn;
    }

    // --- 石碑造型（碑身 + 鎏金符文 + 贴地拾光环）
    // 等距相机从 (+x,+z) 看入：优先放在远离石柱的角落，避免与角色、墙体重叠
    function steleOffsetFor(n) {
      const candidates = [
        { x: -0.40, z: -0.40 },
        { x: -0.40, z: 0.38 },
        { x: 0.38, z: -0.40 },
        { x: 0.36, z: 0.36 }
      ];
      const walls = (curLevel && curLevel.walls) || [];
      let best = candidates[0], bestScore = -1e9;
      for (const c of candidates) {
        const sx = n.pos.x + c.x, sz = n.pos.z + c.z;
        let minWall = 8;
        for (const w of walls) {
          if (Math.abs((w[1] || 0) - n.pos.y) > 0.8) continue;
          const d = Math.hypot(sx - w[0], sz - w[2]);
          if (d < minWall) minWall = d;
        }
        // 墙距优先；其次略偏远侧（-x-z），减少挡角色
        const score = minWall * 4 - (c.x + c.z) * 0.2;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      return best;
    }
    for (const n of nodes) {
      if (!n.stele) continue;
      const onStart = startNode && n === startNode;
      const g = new THREE.Group();
      const s = onStart ? 0.88 : 1.0;
      const off = steleOffsetFor(n);
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.38 * s, 0.08 * s, 0.24 * s),
        new THREE.MeshBasicMaterial({ color: 0x4a4652 }));
      base.position.set(0, 0.04 * s, 0);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(0.24 * s, 0.78 * s, 0.09 * s),
        new THREE.MeshBasicMaterial({ color: 0x6a6574 }));
      slab.position.set(0, 0.46 * s, 0);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.15 * s, 0.50 * s),
        new THREE.MeshBasicMaterial({ color: 0x3e3a46, transparent: true, opacity: 0.55 }));
      face.position.set(0, 0.48 * s, 0.05 * s);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.30 * s, 0.055 * s, 0.13 * s),
        new THREE.MeshBasicMaterial({ color: 0xb8923e }));
      cap.position.set(0, 0.88 * s, 0);
      const glyph = new THREE.Mesh(new THREE.OctahedronGeometry(0.07 * s),
        new THREE.MeshBasicMaterial({ color: 0xf5d78a }));
      glyph.position.set(0, 1.06 * s, 0);
      g.add(base); g.add(slab); g.add(face); g.add(cap); g.add(glyph);
      g.position.set(n.pos.x + off.x, n.pos.y, n.pos.z + off.z);
      g.rotation.y = Math.PI / 4;
      world.add(g);
      n.stelePed = g; n.steleGlyph = glyph;
      n.steleGlyphY0 = glyph.position.y;
      // 贴地拾光环：远看也能认出碑台
      const halo = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.44, 36),
        new THREE.MeshBasicMaterial({
          color: 0xd4a84a, transparent: true, opacity: 0.5,
          side: THREE.DoubleSide, depthWrite: false
        }));
      halo.rotation.x = -Math.PI / 2;
      halo.position.set(n.pos.x, n.pos.y + 0.03, n.pos.z);
      world.add(halo);
      n.steleHalo = halo;
      decorTween(glyph.position, { y: '+=0.08', duration: 1.8, ease: 'sine.inOut', yoyo: true, repeat: -1 });
      decorTween(glyph.rotation, { y: Math.PI * 2, duration: 5.5, ease: 'none', repeat: -1 });
      decorTween(halo.material, { opacity: 0.28, duration: 1.6, ease: 'sine.inOut', yoyo: true, repeat: -1 });
    }
    // --- 星屑造型（挂在砖块网格上：转子上的星屑会跟着平台一起转）
    for (const n of nodes) {
      if (!n.key) continue;
      keysTotal++;
      const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.18),
        new THREE.MeshBasicMaterial({ color: 0xfff0c0 }));
      shard.position.set(0, (n.mesh.geometry.parameters.height || 1) / 2 + 0.58, 0);
      // 扩大点击命中，避免被柱体挡住点不中
      const hit = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10),
        new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.copy(shard.position);
      hit.userData.node = n;
      n.mesh.add(shard);
      n.mesh.add(hit);
      n.keyMesh = shard;
      n.keyHit = hit;
      if (levelKeyOrder() && n.keyOrd != null) {
        const sp = makeKeyOrdSprite(n.keyOrd);
        sp.position.set(0, shard.position.y + 0.38, 0);
        n.mesh.add(sp);
        n.keyOrdSprite = sp;
      }
      keyHits.push(hit);
      decorTween(shard.position, { y: '+=0.14', duration: 1.1, ease: 'sine.inOut', yoyo: true, repeat: -1 });
      decorTween(shard.rotation, { y: Math.PI * 2, duration: 2.6, ease: 'none', repeat: -1 });
    }
    refreshKeyOrderVisuals();

    // --- 转盘
    for (const dd of (curLevel.dials || [])) {
      const rotorRef = rotorById(dd.rotor);
      const g = new THREE.Group();
      const Pp = new THREE.Vector3(dd.pos[0], dd.pos[1], dd.pos[2]);
      const accC = new THREE.Color(dd.color || curLevel.pal.accent);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.1, 24),
        new THREE.MeshBasicMaterial({ color: accC.clone().multiplyScalar(0.55) }));
      base.position.copy(Pp).y += 0.05;
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.32, 12),
        new THREE.MeshBasicMaterial({ color: accC.clone().multiplyScalar(0.75) }));
      pillar.position.copy(Pp).y += 0.24;
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.19, 18, 14),
        new THREE.MeshBasicMaterial({ color: accC }));
      knob.position.copy(Pp).y += 0.5;
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.15, 16),
        new THREE.MeshBasicMaterial({ color: accC, transparent: true, opacity: 0.22, depthWrite: false }));
      hit.position.copy(Pp).y += 0.55;
      g.add(base); g.add(pillar); g.add(knob); g.add(hit);
      world.add(g);
      const dial = { id: dd.id, rotorRef: rotorRef, group: g, knob: knob, hit: hit };
      hit.userData.dial = dial;
      dials.push(dial);
      dialHits.push(hit);
      decorTween(knob.position, { y: '+=0.06', duration: 1.6, ease: 'sine.inOut', yoyo: true, repeat: -1 });
    }

    // --- 齿轮（黄铜机关：驱动转子；咬合的齿轮按齿数比反向联动）
    for (const gd of (curLevel.gears || [])) buildGear(gd, rotorById(gd.rotor));
    const linkedPairs = new Set();
    for (const g of gears) {
      if (!g.def.meshWith) continue;
      const other = gears.find(o => o.def.id === g.def.meshWith);
      if (!other || other.rotorRef === g.rotorRef) continue;
      g.meshWith = other;
      const pairKey = [g.def.id, other.def.id].sort().join('|');
      if (!linkedPairs.has(pairKey)) {
        linkedPairs.add(pairKey);
        buildGearLink(g, other);
      }
    }
    // 错觉光带呼吸（loadLevel 清空时间线后重建；弱机固定半透明）
    if (!decorTween([glintGoldMat, glintTealMat], { opacity: 0.16, duration: 1.35, ease: 'sine.inOut', yoyo: true, repeat: -1 })) {
      glintGoldMat.opacity = 0.22;
      glintTealMat.opacity = 0.22;
    }

    // --- 墙体（与同格地砖重叠时挡寻路；空格上的墙需配合 room 挖空）
    for (const w of (curLevel.walls || [])) {
      const wh = w[3] || 1.3;
      const wm = new THREE.Mesh(boxGeo(0.94, wh, 0.94), makeTileMats(w[1], true));
      wm.position.set(w[0], w[1] + wh / 2 - 0.02, w[2]);
      world.add(wm);
      wallMeshes.push({ mesh: wm, x: w[0], y: w[1], z: w[2], h: wh });
    }

    // 先按 angle0 重算转子砖世界坐标并建邻接，再落人 / 刷怪 / 取景
    // （否则 n.pos 仍是旋转前坐标，取景框与影怪落点会偏）
    updateGraph();

    // --- 旅人
    buildChar();
    faceYaw = 0;
    if (faceTween) { faceTween.kill(); faceTween = null; }
    char.node = startNode;
    snapCharToNode(startNode);
    if (char.group) char.group.rotation.y = faceYaw;
    if (combatEnabled()) {
      const list = (typeof foesForRoute === 'function')
        ? foesForRoute(curLevel, effStart, effGoal, typeof FOES_PER_LEVEL === 'number' ? FOES_PER_LEVEL : 2)
        : (curLevel.foes || []);
      spawnFoes(list);
    } else {
      spawnFoes([]);
    }

    // --- 相机取景（屏幕空间精确居中）
    const box = new THREE.Box3();
    nodes.forEach(n => {
      const body = n.mesh ? (n.mesh.geometry.parameters.height || 1) : 1;
      box.expandByPoint(new THREE.Vector3(n.pos.x - 0.5, n.pos.y - body, n.pos.z - 0.5));
      box.expandByPoint(new THREE.Vector3(n.pos.x + 0.5, n.pos.y + 1.2, n.pos.z + 0.5));
    });
    for (const g of gears) {
      const r = g.radius + 0.25;
      box.expandByPoint(new THREE.Vector3(g.root.position.x - r, g.root.position.y - 0.9, g.root.position.z - r));
      box.expandByPoint(new THREE.Vector3(g.root.position.x + r, g.root.position.y + r, g.root.position.z + r));
    }
    const rightAx = new THREE.Vector3(1, 0, -1).normalize();
    const upAx = new THREE.Vector3(-1, 2, -1).normalize();
    let minSx = 1e9, maxSx = -1e9, minSy = 1e9, maxSy = -1e9;
    for (const X of [box.min.x, box.max.x])
      for (const Y of [box.min.y, box.max.y])
        for (const Z of [box.min.z, box.max.z]) {
          const sx = rightAx.x * X + rightAx.z * Z;
          const sy = upAx.x * X + upAx.y * Y + upAx.z * Z;
          minSx = Math.min(minSx, sx); maxSx = Math.max(maxSx, sx);
          minSy = Math.min(minSy, sy); maxSy = Math.max(maxSy, sy);
        }
    const halfW = (maxSx - minSx) / 2, halfH = (maxSy - minSy) / 2;
    const Sx = (maxSx + minSx) / 2, Sy = (maxSy + minSy) / 2;
    const Cy = (box.min.y + box.max.y) / 2;
    const Cx = (Sx * Math.SQRT2 + 2 * Cy - Sy * Math.sqrt(6)) / 2;
    const Cz = (2 * Cy - Sy * Math.sqrt(6) - Sx * Math.SQRT2) / 2;
    camCenter.set(Cx, Cy, Cz);
    levelFitHalfW = halfW;
    levelFitHalfH = halfH;
    updateModeButton();
    applyCam(false);
    resize();

    applyPhaseStyles();
    applyPlanarLayout();
    levelPar = (curLevel.par != null) ? curLevel.par : minToggles(startNode, goalNode);
    refreshHUD();
    playLevelBgm(levelIdx);
    hideArchitectNote();
    {
      const have = readSteleSet();
      for (const n of nodes) {
        if (n.stele && have[steleId(levelIdx, n.stele)]) n.steleRead = true;
      }
    }
    if (!opts || !opts.afterFall) showLevelOpener(curLevel);
    else pulseHudHearts();
    if (startNode) onArrive(startNode, { skipStele: true });
    requestAnimationFrame(() => {
      resize();
      if (renderer && scene && camera) renderer.render(scene, camera);
    });
    setTimeout(() => { resize(); }, 80);
  }

  // 相位节点：仅在所属视角实体化，另一视角呈半透明幽灵
  function applyPhaseStyle(n) {
    const active = n.phase === camMode;
    if (active) {
      n.mesh.material = makeTileMats(n.pos.y);
    } else {
      const c = n.phase === '2d' ? COL_STAIR : COL_ILLU;
      n.mesh.material = new THREE.MeshBasicMaterial({
        color: c, transparent: true, opacity: 0.16, depthWrite: false
      });
    }
  }
  function applyDropStyle(n) {
    if (!n.drop || !n.mesh) return;
    if (camMode === '2d') {
      n.mesh.material = new THREE.MeshBasicMaterial({
        color: 0x9aaeb4, transparent: true, opacity: 0.2, depthWrite: false
      });
    } else {
      n.mesh.material = makeTileMats(n.pos.y);
    }
  }
  function applyPhaseStyles() {
    nodes.forEach(n => {
      if (n.phase) applyPhaseStyle(n);
      else if (n.drop) applyDropStyle(n);
    });
  }

  function updateGoalLock() {
    if (!goalFx) return;
    const ok = state.keys >= (goalNode.need || 0);
    goalFx.ring.material.color.set(ok ? curLevel.pal.goal : 0x9a9aa2);
  }

  // ------------------------------------------------ 旅人
  const char = { node: null, group: null, inner: null, walking: false, cancelPending: false };
  let stepIdx = 0;
  const WALK_SPEED = 2.65;   // 恒定步速：格 / 秒（略慢更柔）
  const CHAR_SCALE = 1.18;

  function buildChar() {
    if (char.group) { char.group.parent && char.group.parent.remove(char.group); }
    const robe = 0x1a5f6e;
    const robeMid = 0x247a8c;
    const robeDark = 0x0f3d48;
    const cloak = 0xe24a2f;
    const cloakDark = 0xa8321c;
    const skin = 0xd4a07a;
    const hair = 0x1a1f28;
    const trim = 0xe8b84b;
    const g = new THREE.Group();
    const blob = new THREE.Mesh(new THREE.CircleGeometry(0.38, 24),
      new THREE.MeshBasicMaterial({ color: 0x0d1822, transparent: true, opacity: 0.32 }));
    blob.rotation.x = -Math.PI / 2; blob.position.y = 0.01;
    const inner = new THREE.Group();
    inner.scale.set(CHAR_SCALE, CHAR_SCALE, CHAR_SCALE);
    const coat = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.62, 20), new THREE.MeshBasicMaterial({ color: robeMid }));
    coat.position.y = 0.34;
    const coatShade = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.54, 16), new THREE.MeshBasicMaterial({ color: robeDark }));
    coatShade.position.set(0.03, 0.32, -0.03);
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 0.28, 16), new THREE.MeshBasicMaterial({ color: robe }));
    torso.position.y = 0.54;
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.155, 0.03, 8, 24), new THREE.MeshBasicMaterial({ color: trim }));
    belt.rotation.x = Math.PI / 2; belt.position.y = 0.44;
    const cape = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.52, 14, 1, true),
      new THREE.MeshBasicMaterial({ color: cloak, side: THREE.DoubleSide }));
    cape.position.set(0, 0.42, -0.12); cape.rotation.x = 0.45;
    const capeIn = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.4, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: cloakDark, side: THREE.DoubleSide }));
    capeIn.position.set(0, 0.40, -0.09); capeIn.rotation.x = 0.45;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.145, 18, 14), new THREE.MeshBasicMaterial({ color: skin }));
    head.position.y = 0.76;
    const hairMesh = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.6),
      new THREE.MeshBasicMaterial({ color: hair }));
    hairMesh.position.y = 0.80; hairMesh.rotation.x = -0.2;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.034, 20), new THREE.MeshBasicMaterial({ color: hair }));
    brim.position.y = 0.86;
    const hat = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.22, 16), new THREE.MeshBasicMaterial({ color: robeDark }));
    hat.position.y = 1.00;
    const hatBand = new THREE.Mesh(new THREE.TorusGeometry(0.095, 0.018, 8, 18), new THREE.MeshBasicMaterial({ color: cloak }));
    hatBand.rotation.x = Math.PI / 2; hatBand.position.y = 0.90;
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 8), new THREE.MeshBasicMaterial({ color: 0x141414 }));
    const eyeR = eyeL.clone();
    eyeL.position.set(-0.05, 0.77, 0.125);
    eyeR.position.set(0.05, 0.77, 0.125);
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.17, 0.1), new THREE.MeshBasicMaterial({ color: 0x3a2c22 }));
    pack.position.set(0, 0.52, -0.16);
    // 背上大剑（挂鞘）；挥砍时临时前移
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.92, 0.025), new THREE.MeshBasicMaterial({ color: 0xc8d0dc }));
    blade.position.set(0, 0.42, 0);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.88, 0.01), new THREE.MeshBasicMaterial({ color: 0xf2f6ff }));
    edge.position.set(0.02, 0.42, 0.01);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.14, 6), new THREE.MeshBasicMaterial({ color: 0xdde4ee }));
    tip.position.set(0, 0.94, 0);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, 0.06), new THREE.MeshBasicMaterial({ color: trim }));
    guard.position.set(0, 0.02, 0);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.22, 8), new THREE.MeshBasicMaterial({ color: 0x3a2418 }));
    grip.position.set(0, -0.12, 0);
    const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), new THREE.MeshBasicMaterial({ color: cloak }));
    pommel.position.set(0, -0.24, 0);
    const sword = new THREE.Group();
    sword.add(blade); sword.add(edge); sword.add(tip); sword.add(guard); sword.add(grip); sword.add(pommel);
    sword.position.set(-0.22, 0.55, -0.18);
    sword.rotation.set(0.15, 0.35, 0.85);
    sword.visible = combatEnabled();
    inner.add(coatShade); inner.add(coat); inner.add(torso); inner.add(belt);
    inner.add(capeIn); inner.add(cape);
    inner.add(head); inner.add(hairMesh); inner.add(brim); inner.add(hat); inner.add(hatBand);
    inner.add(eyeL); inner.add(eyeR); inner.add(pack); inner.add(sword);
    g.add(blob); g.add(inner);
    world.add(g);
    char.group = g; char.inner = inner; char.sword = sword;
    char.eyeL = eyeL; char.eyeR = eyeR;
    char.depthMats = null; // 下次切视角时重建材质缓存
    // 眼睛看向本地 +Z；用空物体标记视线前方，攻击扇形以此为准
    const gaze = new THREE.Object3D();
    gaze.position.set(0, 0.77, 0.125);
    inner.add(gaze);
    char.gaze = gaze;
    startIdle();
  }

  // 朝向平滑转身（不再瞬间硬切）；faceYaw 为权威面朝，攻击扇形以此为准
  let faceTween = null;
  let faceYaw = 0;
  function faceTowards(dx, dz, opts) {
    opts = opts || {};
    if (Math.abs(dx) + Math.abs(dz) < 0.001) return;
    const target = Math.atan2(dx, dz);
    faceYaw = target;
    if (!char.group) return;
    const cur = char.group.rotation.y;
    let delta = (target - cur) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    if (Math.abs(delta) < 0.02) {
      char.group.rotation.y = target;
      if (opts.fromWasdTurn && typeof wasdTurnWantsContinue === 'function' && wasdTurnWantsContinue()) {
        tryWasdTurn({ chain: true });
      }
      return;
    }
    if (faceTween) faceTween.kill();
    const turnDur = opts.fromWasdTurn
      ? Math.min(0.28, 0.12 + Math.abs(delta) * 0.14)
      : Math.min(0.42, 0.18 + Math.abs(delta) * 0.22);
    faceTween = gsap.to(char.group.rotation, {
      y: cur + delta, duration: turnDur, ease: 'sine.inOut',
      onComplete: () => {
        faceTween = null;
        if (char.group) char.group.rotation.y = faceYaw;
        // 长按 A/D：转完继续转
        if (opts.fromWasdTurn && typeof wasdTurnWantsContinue === 'function' && wasdTurnWantsContinue()) {
          tryWasdTurn({ chain: true });
        }
      }
    });
  }
  function snapFacing() {
    if (faceTween) { faceTween.kill(); faceTween = null; }
    if (char.group) char.group.rotation.y = faceYaw;
  }

  // 待机呼吸（无位移、无跳跃，只做轻微缩放）
  let idleTween = null;
  function startIdle() {
    stopWalkMotion(true);
    if (idleTween) idleTween.kill();
    if (!char.inner) return;
    gsap.killTweensOf(char.inner.scale);
    gsap.to(char.inner.scale, { x: CHAR_SCALE, y: CHAR_SCALE, z: CHAR_SCALE, duration: 0.28, ease: 'sine.out' });
    gsap.to(char.inner.position, { y: 0, duration: 0.28, ease: 'sine.out' });
    gsap.to(char.inner.rotation, { x: 0, z: 0, duration: 0.32, ease: 'sine.out' });
    if (!allowIdleBob()) return;
    idleTween = gsap.to(char.inner.scale, {
      y: CHAR_SCALE * 0.97, x: CHAR_SCALE * 1.012, z: CHAR_SCALE * 1.012,
      duration: 1.85, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 0.28
    });
  }
  function stopIdle() { if (idleTween) { idleTween.kill(); idleTween = null; } }

  // 连续步态：轻柔起伏与侧摆（贴地，不离地跳跃）
  let walkBobTween = null;
  function startWalkMotion() {
    stopWalkMotion(true);
    if (!char.inner) return;
    const bob = { t: 0 };
    walkBobTween = gsap.to(bob, {
      t: Math.PI * 2,
      duration: 0.52,
      ease: 'sine.inOut',
      repeat: -1,
      onUpdate: () => {
        if (!char.inner) return;
        const s = Math.sin(bob.t);
        const c = Math.cos(bob.t * 2);
        char.inner.position.y = 0.022 * (0.5 + 0.5 * Math.abs(s));
        char.inner.rotation.z = s * 0.055;
        char.inner.rotation.x = c * 0.022;
        const sc = CHAR_SCALE;
        char.inner.scale.set(
          sc * (1 + 0.028 * s),
          sc * (1 - 0.022 * Math.abs(s)),
          sc * (1 + 0.016 * s)
        );
      }
    });
  }
  function stopWalkMotion(instant) {
    if (walkBobTween) { walkBobTween.kill(); walkBobTween = null; }
    if (!char.inner) return;
    if (instant) {
      gsap.killTweensOf(char.inner.position);
      gsap.killTweensOf(char.inner.rotation);
      gsap.killTweensOf(char.inner.scale);
      char.inner.position.y = 0;
      char.inner.rotation.x = 0;
      char.inner.rotation.z = 0;
      char.inner.scale.set(CHAR_SCALE, CHAR_SCALE, CHAR_SCALE);
    }
  }

  function smoothstep01(t) { return t * t * (3 - 2 * t); }
  function smootherstep01(t) {
    // Ken Perlin：比 smoothstep 更柔的加减速
    return t * t * t * (t * (t * 6 - 15) + 10);
  }
  /** 单步水平插值：整段路径首尾柔启停，中间匀速连贯；视错觉长跨保持线性 */
  function stepHorizK(t, isFirst, isLast, isLong) {
    if (isLong) return t;
    if (isFirst && isLast) return smootherstep01(t);
    if (isFirst) {
      // 柔启动后很快进入匀速：前 55% 用 smoother，后半接线性
      if (t < 0.55) return smootherstep01(t / 0.55) * 0.55;
      return t;
    }
    if (isLast) {
      if (t < 0.45) return t;
      return 0.45 + smootherstep01((t - 0.45) / 0.55) * 0.55;
    }
    return t;
  }

  // 行走：全程贴地；同一视角里按「同一平面」滑步，绝不跳跃。
  //   · 同高 / 同色平面：投影直线滑过
  //   · 俯视翻高差：高度 smootherstep 缓上缓下
  //   · 错觉远跨：三轴线性，等距里像贴面直行
  //   · 右键 / Esc 取消：停在当前方块（迈过半程则落到目标格，否则退回起点格）
  //   · 行走中再点地砖：先停步，再改道前往新目标
  let walkTween = null;
  let walkProgress = 0;
  function cancelWalk(opts) {
    if (!char.walking && !char.cancelPending) return false;
    opts = opts || {};
    char.cancelPending = false;
    // 迈过半程：认作已站上目标格；否则退回出发格
    if (char.walkTarget && walkProgress >= 0.5) {
      char.node = char.walkTarget;
    }
    if (walkTween) { walkTween.kill(); walkTween = null; }
    walkProgress = 0;
    stopWalkMotion(true);
    char.walking = false;
    char.walkTarget = null;
    if (!opts.redirect) hideMarker();
    if (char.node) {
      // 改道：保持当前画面位置，由下一段路径滑过去，避免吸附格心瞬移
      if (!opts.redirect) snapCharToNode(char.node);
      if (!footingOK(char.node, camMode)) {
        fallToDeath();
        return true;
      }
      if (!opts.redirect) onArrive(char.node);
    }
    if (!opts.redirect) {
      startIdle();
      if (!opts.silent) toast('已停下', 1200);
    }
    return true;
  }

  function walkPath(path, opts) {
    opts = opts || {};
    const fromWasd = !!opts.fromWasd;
    const wasdChain = !!opts.wasdChain; // 长按连走：承接上一步，不停步态
    const fromVisual = !!opts.fromVisual; // 改道：第一段从当前世界坐标滑出
    char.walking = true;
    char.cancelPending = false;
    walkProgress = 0;
    if (wasdChain) {
      if (!walkBobTween) startWalkMotion();
    } else {
      stopIdle();
      startWalkMotion();
    }
    // 若正处于静止锁帧等待，立刻切回 RAF，避免起步卡一拍
    try { scheduleAnimate(0); } catch (e) { }
    let i = 0;
    const lastSeg = path.length - 2;
    const next = () => {
      if (i >= path.length - 1) {
        const last = path[path.length - 1];
        char.walking = false;
        char.walkTarget = null;
        walkTween = null;
        walkProgress = 0;
        onArrive(last);
        // 仅「长按确认」后才连走；点按走完一格即停。连走时跳过 idle，避免顿挫
        if (wasdWantsContinue() && tryWasdStep({ chain: true })) return;
        hideMarker();
        stopWalkMotion(true);
        startIdle();
        return;
      }
      const a = path[i], b = path[i + 1];
      char.walkTarget = b;
      walkProgress = 0;
      // 改道首段：从角色当前画面位置出发，避免先瞬移回格心
      const useVisual = fromVisual && i === 0 && char.group;
      const ax = useVisual ? char.group.position.x : a.pos.x;
      const az = useVisual ? char.group.position.z : a.pos.z;
      const ay = useVisual
        ? char.group.position.y
        : (camMode === '2d' ? 0.04 : a.pos.y);
      const by = camMode === '2d' ? 0.04 : b.pos.y;
      const dx = b.pos.x - ax, dz = b.pos.z - az, dy = by - ay;
      const horiz = Math.sqrt(dx * dx + dz * dz);
      // 同平面滑步（同色连通）：三轴线性
      // 俯视翻高差 / 非平面边：高度用 smootherstep
      const planar = isPlanarEdge(a, b, camMode);
      // WASD 格移全程匀速衔接；点地长路径仍首尾柔启停
      let isFirst = i === 0;
      let isLast = i === lastSeg;
      if (fromWasd) {
        isFirst = false;
        isLast = false;
      }
      faceTowards(dx, dz);
      const speed = fromWasd ? WALK_SPEED * 1.08 : WALK_SPEED;
      let dur = Math.max(fromWasd ? 0.22 : 0.26, Math.max(horiz, Math.abs(dy) * 0.55) / speed);
      if (!fromWasd) {
        if (isFirst || isLast) dur *= 1.08;
        if (isFirst && isLast) dur *= 1.06;
      }
      const pr = { t: 0 };
      walkTween = gsap.to(pr, {
        t: 1, duration: dur, ease: 'none',
        onUpdate: () => {
          const raw = pr.t;
          walkProgress = raw;
          const k = planar
            ? stepHorizK(raw, isFirst, isLast, true)   // 同平面：保持匀速投影直线
            : stepHorizK(raw, isFirst, isLast, false);
          char.group.position.x = ax + dx * k;
          char.group.position.z = az + dz * k;
          if (camMode === '2d') {
            char.group.position.y = 0.04;
          } else if (planar) {
            // 错觉同平面：高度也跟 k 线性，保证等距里看起来贴着平面滑
            char.group.position.y = ay + dy * k;
          } else {
            char.group.position.y = ay + dy * smootherstep01(raw);
          }
        },
        onComplete: () => {
          walkTween = null;
          walkProgress = 0;
          char.node = b;
          snapCharToNode(b);
          i++;
          if (char.cancelPending) {
            // 视角被打断：走完当前这一步后停下并落稳，绝不瞬移
            char.cancelPending = false;
            char.walking = false;
            char.walkTarget = null;
            hideMarker();
            stopWalkMotion(true);
            settleAfterToggle(b, a, { arrive: true });
            return;
          }
          if (!footingOK(b, camMode)) {
            char.walking = false;
            char.walkTarget = null;
            hideMarker();
            stopWalkMotion(true);
            fallToDeath();
            return;
          }
          next();
        }
      });
    };
    next();
  }

  function isSolidNode(n, mode) {
    return n && (!n.phase || n.phase === mode) && !nodeOnWall(n);
  }

  // 当前视角下这格踩得住：实体、相位对得上；俯视里 drop 高台没有地面
  function footingOK(n, mode) {
    if (!isSolidNode(n, mode)) return false;
    if (mode === '2d' && n.drop) return false;
    return true;
  }

  // 切视角后只认「同一落点」：同 x/z（3D 还要同高）。旁侧邻格不算脚下，否则会瞬移救命。
  function nodeAtFoot(n, mode) {
    if (!n) return null;
    if (footingOK(n, mode)) return n;
    for (const nb of nodes) {
      if (nb === n) continue;
      if (Math.abs(nb.pos.x - n.pos.x) > 0.15) continue;
      if (Math.abs(nb.pos.z - n.pos.z) > 0.15) continue;
      if (mode === '3d' && Math.abs(nb.pos.y - n.pos.y) > 0.35) continue;
      if (footingOK(nb, mode)) return nb;
    }
    return null;
  }

  function settleAfterToggle(n, prev, opts) {
    if (state.dying || state.won) return;
    if (!n) return;
    const target = nodeAtFoot(n, camMode);
    if (!target) {
      fallToDeath();
      return;
    }
    char.node = target;
    if (target !== n) {
      const shouldArrive = target !== n || (opts && opts.arrive);
      gsap.to(char.group.position, {
        x: target.pos.x, y: planeY(target), z: target.pos.z, duration: 0.18, ease: 'power1.inOut',
        onComplete: () => { if (shouldArrive && !state.dying) onArrive(target); }
      });
      startIdle();
      return;
    }
    snapCharToNode(target);
    if (opts && opts.arrive) onArrive(target);
    startIdle();
  }

  function fallToDeath() {
    if (state.dying || state.won) return;
    state.dying = true;
    char.walking = false;
    char.cancelPending = false;
    char.walkTarget = null;
    if (walkTween) { walkTween.kill(); walkTween = null; }
    walkProgress = 0;
    stopWalkMotion(true);
    hideMarker();
    hideHover();
    stopIdle();
    gsap.killTweensOf(char.group.position);
    gsap.killTweensOf(char.inner.scale);
    sfx.fall();
    // 观光正篇：坠落只回起点；屠戮 / 试验场：扣心 + 嘲讽
    if (combatEnabled()) {
      lives = Math.max(0, lives - 1);
      updateHUD();
      const roast = showLifeLoss(lives, { cause: 'fall', holdMs: lives <= 0 ? 2600 : 2400 });
      toast(roast || (lives > 0
        ? ('踏空了 · 还剩 ' + lives + ' 颗心 · 回到本章起点')
        : '三心耗尽 · 本章重新开始'), 3400, 'warn');
    } else {
      updateHUD();
      toast('踏空了 · 回到本章起点', 2800, 'warn');
    }
    const gy = char.group.position.y;
    gsap.to(char.inner.scale, { y: 1.2, x: 0.7, z: 0.7, duration: 0.18, ease: 'power2.in' });
    gsap.to(char.group.position, {
      y: gy - 10, duration: 0.72, ease: 'power2.in',
      onComplete: () => {
        if (combatEnabled()) {
          const refill = lives <= 0;
          if (refill) lives = MAX_LIVES;
          loadLevel(levelIdx, { keepLives: !refill, afterFall: true });
        } else {
          loadLevel(levelIdx, { keepLives: true, afterFall: true });
        }
      }
    });
  }

  // ============================================================ 小怪 · 大剑
  function clearFoes() {
    for (const f of foes) {
      if (f.group && f.group.parent) f.group.parent.remove(f.group);
      if (f.walkTween) f.walkTween.kill();
    }
    foes = [];
  }

  function buildFoeMesh() {
    const g = new THREE.Group();
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.32, 18),
      new THREE.MeshBasicMaterial({ color: 0x1a0808, transparent: true, opacity: 0.35 }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.01;
    // 警戒光环（发现主角时微亮，不画完整视野半径以免铺满画面）
    const vision = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.58, 28),
      new THREE.MeshBasicMaterial({ color: 0xff6a4a, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
    );
    vision.rotation.x = -Math.PI / 2; vision.position.y = 0.025;
    const inner = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.55, 8), new THREE.MeshBasicMaterial({ color: 0x5c2a3a }));
    body.position.y = 0.32;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), new THREE.MeshBasicMaterial({ color: 0x3a1520 }));
    head.position.y = 0.68;
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff6a4a }));
    const eyeR = eyeL.clone();
    eyeL.position.set(-0.06, 0.7, 0.13);
    eyeR.position.set(0.06, 0.7, 0.13);
    const hornL = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.16, 6), new THREE.MeshBasicMaterial({ color: 0x8a3040 }));
    const hornR = hornL.clone();
    hornL.position.set(-0.1, 0.82, 0); hornL.rotation.z = 0.4;
    hornR.position.set(0.1, 0.82, 0); hornR.rotation.z = -0.4;
    inner.add(body); inner.add(head); inner.add(eyeL); inner.add(eyeR); inner.add(hornL); inner.add(hornR);
    g.add(shadow); g.add(vision); g.add(inner);
    return { group: g, inner: inner, vision: vision };
  }

  function spawnFoes(list) {
    clearFoes();
    for (const p of list || []) {
      const node = nodeAt(p[0], p[1], p[2]);
      if (!node || !footingOK(node, camMode)) continue;
      const mesh = buildFoeMesh();
      world.add(mesh.group);
      const foe = {
        node: node, group: mesh.group, inner: mesh.inner, vision: mesh.vision,
        hp: FOE_HP, alive: true, walking: false, walkTween: null,
        spawn: [p[0], p[1], p[2]], hitFlash: 0, contactCd: 0, dodgeCd: 0
      };
      foe.group.position.set(node.pos.x, planeY(node), node.pos.z);
      foes.push(foe);
    }
  }

  function foeDistXZ(a, b) {
    if (!a || !b) return Infinity;
    return Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
  }

  /** 是否同一层楼板（顶高 + 3D 同色平面；防穿层碰伤 / 索敌） */
  function foeSameLayer(a, b) {
    if (!a || !b) return false;
    if (Math.abs(a.pos.y - b.pos.y) > FOE_LAYER_EPS) return false;
    // 3D：同高但不同连通色面（孤岛）也不算可攻击同层
    if (camMode === '3d' && a.planeId >= 0 && b.planeId >= 0 && a.planeId !== b.planeId) return false;
    return true;
  }

  /** 实时高度也接近（走路跨层途中不算同层） */
  function foeSameLayerLive(foe) {
    if (!foeSameLayer(foe.node, char.node)) return false;
    if (camMode === '3d' && foe.group && char.group) {
      if (Math.abs(foe.group.position.y - char.group.position.y) > FOE_LAYER_EPS + 0.2) return false;
    }
    return true;
  }

  function foeSeesPlayer(foe) {
    if (!char.node || !foe.node) return false;
    if (!foeSameLayer(foe.node, char.node)) return false;
    return foeDistXZ(foe.node, char.node) <= FOE_VISION;
  }

  function foeNeighbors(foe) {
    if (!foe.node) return [];
    return (adj.get(foe.node) || []).filter(n => footingOK(n, camMode));
  }

  function foePickSideApproach(foe) {
    const nbs = foeNeighbors(foe);
    if (!nbs.length || !char.node) return null;
    const face = eyeFacingYaw();
    const fwdX = Math.sin(face), fwdZ = Math.cos(face);
    let best = null, bestScore = -1e9;
    for (const nb of nbs) {
      // 追击只走仍与玩家同层的邻格，避免爬上/掉下后穿层咬人
      if (!foeSameLayer(nb, char.node)) continue;
      const dx = nb.pos.x - foe.node.pos.x, dz = nb.pos.z - foe.node.pos.z;
      const toPlayer = foeDistXZ(nb, char.node);
      const along = dx * fwdX + dz * fwdZ;
      const side = Math.abs(dx * (-fwdZ) + dz * fwdX);
      const score = -toPlayer * 2 + side * 1.4 - Math.max(0, along) * 0.8;
      if (score > bestScore) { bestScore = score; best = nb; }
    }
    return best;
  }

  function foePickDodge(foe) {
    const nbs = foeNeighbors(foe);
    if (!nbs.length || !char.group) return null;
    const face = eyeFacingYaw();
    const fx = Math.sin(face), fz = Math.cos(face);
    // 朝玩家眼睛朝向的侧向躲开扇形
    let best = null, bestScore = -1e9;
    for (const nb of nbs) {
      const dx = nb.pos.x - char.group.position.x, dz = nb.pos.z - char.group.position.z;
      const ang = Math.atan2(dx, dz);
      let dAng = Math.abs(((ang - face) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
      const side = Math.abs(dx * (-fz) + dz * fx);
      const score = dAng * 2 + side - foeDistXZ(nb, foe.node) * 0.2;
      if (score > bestScore) { bestScore = score; best = nb; }
    }
    return best;
  }

  function foeWalkTo(foe, target) {
    if (!foe.alive || !target || foe.walking || state.hurtPause) return;
    if (!footingOK(target, camMode)) return;
    const a = foe.node, b = target;
    const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, dy = b.pos.y - a.pos.y;
    const horiz = Math.sqrt(dx * dx + dz * dz);
    const dur = Math.max(0.28, Math.max(horiz, Math.abs(dy) * 0.5) / FOE_SPEED);
    foe.walking = true;
    const yaw = Math.atan2(dx, dz);
    gsap.to(foe.group.rotation, { y: yaw, duration: Math.min(0.25, dur * 0.6), ease: 'sine.out' });
    const pr = { t: 0 };
    foe.walkTween = gsap.to(pr, {
      t: 1, duration: dur, ease: 'none',
      onUpdate: () => {
        if (!foe.alive) return;
        const k = pr.t;
        foe.group.position.x = a.pos.x + dx * k;
        foe.group.position.z = a.pos.z + dz * k;
        foe.group.position.y = camMode === '2d' ? 0.04 : (a.pos.y + dy * k);
      },
      onComplete: () => {
        foe.walkTween = null;
        foe.walking = false;
        if (!foe.alive) return;
        foe.node = b;
        foe.group.position.set(b.pos.x, planeY(b), b.pos.z);
        if (!footingOK(b, camMode)) foeFall(foe);
      }
    });
  }

  function foeFall(foe) {
    if (!foe.alive) return;
    foe.alive = false;
    foe.walking = false;
    if (foe.walkTween) { foe.walkTween.kill(); foe.walkTween = null; }
    sfx.foeDie();
    const gy = foe.group.position.y;
    gsap.to(foe.inner.scale, { y: 1.3, x: 0.6, z: 0.6, duration: 0.2 });
    gsap.to(foe.group.position, {
      y: gy - 9, duration: 0.65, ease: 'power2.in',
      onComplete: () => {
        if (foe.group.parent) foe.group.parent.remove(foe.group);
      }
    });
  }

  function foeTakeHit(foe) {
    if (!foe.alive) return;
    foe.hp -= 1;
    sfx.hit();
    gsap.fromTo(foe.inner.scale, { x: 1.25, y: 0.75, z: 1.25 }, { x: 1, y: 1, z: 1, duration: 0.22 });
    if (foe.hp <= 0) {
      foe.alive = false;
      foe.walking = false;
      if (foe.walkTween) { foe.walkTween.kill(); foe.walkTween = null; }
      sfx.foeDie();
      gsap.to(foe.group.scale, {
        x: 0.01, y: 0.01, z: 0.01, duration: 0.28, ease: 'power2.in',
        onComplete: () => { if (foe.group.parent) foe.group.parent.remove(foe.group); }
      });
      toast('影怪消散', 1400, 'good');
    }
  }

  function settleFoesAfterToggle() {
    for (const foe of foes) {
      if (!foe.alive || !foe.node) continue;
      if (foe.walking) {
        if (foe.walkTween) foe.walkTween.kill();
        foe.walking = false;
        foe.walkTween = null;
      }
      const foot = nodeAtFoot(foe.node, camMode);
      if (!foot) { foeFall(foe); continue; }
      foe.node = foot;
      foe.group.position.set(foot.pos.x, planeY(foot), foot.pos.z);
    }
  }

  function snapAliveFoes() {
    for (const foe of foes) {
      if (!foe.alive || foe.walking || !foe.node) continue;
      if (!footingOK(foe.node, camMode)) { foeFall(foe); continue; }
      foe.group.position.set(foe.node.pos.x, planeY(foe.node), foe.node.pos.z);
    }
  }

  function hurtByFoe() {
    if (state.dying || state.won || state.hurtPause) return;
    lives = Math.max(0, lives - 1);
    updateHUD();
    sfx.hurt();
    state.hurtPause = true;
    // 先停住小怪与挥砍，再冻结时间线（扣血特效用 setTimeout/CSS，不受影响）
    for (const foe of foes) {
      if (foe.walkTween) { foe.walkTween.kill(); foe.walkTween = null; }
      foe.walking = false;
      if (foe.alive && foe.node) foe.group.position.set(foe.node.pos.x, planeY(foe.node), foe.node.pos.z);
    }
    // 主角受击僵直，不传送回出生点
    if (char.walking) cancelWalk({ silent: true });
    if (state.attacking) {
      state.attacking = false;
      swordBuffered = false;
      if (swordTween) { swordTween.kill(); swordTween = null; }
      if (typeof clearSwordFlash === 'function') clearSwordFlash();
      if (char.sword) {
        gsap.killTweensOf(char.sword.rotation);
        gsap.killTweensOf(char.sword.position);
        char.sword.position.set(SWORD_SHEATH_POS.x, SWORD_SHEATH_POS.y, SWORD_SHEATH_POS.z);
        char.sword.rotation.set(SWORD_SHEATH_ROT.x, SWORD_SHEATH_ROT.y, SWORD_SHEATH_ROT.z);
      }
      if (char.inner) {
        gsap.killTweensOf(char.inner.rotation);
        char.inner.rotation.y = 0;
      }
    }
    stopIdle();
    gsap.globalTimeline.timeScale(0);
    const roast = showLifeLoss(lives, {
      cause: 'foe',
      holdMs: lives <= 0 ? 2600 : 2400,
      onDone: () => {
        gsap.globalTimeline.timeScale(1);
        state.hurtPause = false;
        if (lives <= 0) {
          lives = MAX_LIVES;
          toast(roast || '三心耗尽 · 本章重新开始', 3000, 'warn');
          loadLevel(levelIdx);
        } else {
          toast(roast || ('被影怪咬伤 · 还剩 ' + lives + ' 颗心'), 2600, 'warn');
          if (!char.walking && !state.dying) startIdle();
        }
      }
    });
  }

  const _eyeFwd = new THREE.Vector3();
  const _eyeQuat = new THREE.Quaternion();
  /** 眼睛朝向（世界 XZ）：模型眼睛在本地 +Z */
  function eyeFacingYaw() {
    if (char.gaze) {
      char.gaze.updateWorldMatrix(true, false);
      char.gaze.getWorldQuaternion(_eyeQuat);
      _eyeFwd.set(0, 0, 1).applyQuaternion(_eyeQuat);
      if (_eyeFwd.x * _eyeFwd.x + _eyeFwd.z * _eyeFwd.z > 1e-6) {
        return Math.atan2(_eyeFwd.x, _eyeFwd.z);
      }
    }
    // 回退：group 面朝 + inner 偏转
    const gy = char.group ? char.group.rotation.y : faceYaw;
    const iy = char.inner ? char.inner.rotation.y : 0;
    return gy + iy;
  }

  function swordFacing() {
    return eyeFacingYaw();
  }

  function inSwordFan(foe, face) {
    if (!foe.alive || !char.group || !foe.node || !char.node) return false;
    // 大剑也不能穿楼板砍到不同层
    if (!foeSameLayerLive(foe)) return false;
    const dx = foe.group.position.x - char.group.position.x;
    const dz = foe.group.position.z - char.group.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > SWORD_RANGE) return false;
    // 贴身 / 同格：无方位可言，必中（旧逻辑 dist<0.05 直接判空，叠脚砍不到）
    if (dist < 0.12) return true;
    const ang = Math.atan2(dx, dz);
    let d = ((ang - face) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    return Math.abs(d) <= SWORD_FAN * 0.5;
  }

  /** 挥砍前：若近距有影怪，先转向最近的一只（站立时也能对上） */
  function faceNearestFoe(maxDist) {
    if (!char.group || !char.node) return;
    let best = null, bestD = maxDist != null ? maxDist : SWORD_RANGE + 0.35;
    for (const foe of foes) {
      if (!foe.alive || !foe.group || !foe.node) continue;
      if (!foeSameLayerLive(foe)) continue;
      const dx = foe.group.position.x - char.group.position.x;
      const dz = foe.group.position.z - char.group.position.z;
      const d = Math.hypot(dx, dz);
      if (d < bestD) { bestD = d; best = { dx, dz }; }
    }
    if (best && bestD >= 0.08) faceTowards(best.dx, best.dz);
  }

  /** 地面扇形：挂在角色身上，本地 +Z = 眼睛正前方（与模型眼睛一致） */
  function buildSwordFanMesh() {
    const half = SWORD_FAN * 0.5;
    const segs = 22;
    const r0 = 0.28, r1 = SWORD_RANGE;
    const pos = [];
    const idx = [];
    for (let i = 0; i <= segs; i++) {
      const a = -half + (SWORD_FAN * i) / segs;
      // 本地：a=0 → +Z（眼睛方向）；x=sin、z=cos
      const s = Math.sin(a), c = Math.cos(a);
      pos.push(s * r0, 0, c * r0);
      pos.push(s * r1, 0, c * r1);
    }
    for (let i = 0; i < segs; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe6a8, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = 0.06;
    // 边缘线
    const es = Math.sin(-half), ec = Math.cos(-half);
    const es2 = Math.sin(half), ec2 = Math.cos(half);
    const linePos = [
      es * r0, 0.01, ec * r0, es * r1, 0.01, ec * r1,
      es2 * r0, 0.01, ec2 * r0, es2 * r1, 0.01, ec2 * r1,
      0, 0.02, r0, 0, 0.02, r1 // 中线：眼睛正前
    ];
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
    const lineMat = new THREE.LineBasicMaterial({ color: 0xfff3c8, transparent: true, opacity: 0 });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    lines.position.y = 0.06;
    const root = new THREE.Group();
    root.add(mesh);
    root.add(lines);
    root.userData.fanMat = mat;
    root.userData.lineMat = lineMat;
    return root;
  }

  let swordTween = null;
  let swordFlash = null;
  let swordBuffered = false;
  const SWORD_SHEATH_POS = { x: -0.22, y: 0.55, z: -0.18 };
  const SWORD_SHEATH_ROT = { x: 0.15, y: 0.35, z: 0.85 };

  function clearSwordFlash() {
    if (swordFlash && swordFlash.parent) swordFlash.parent.remove(swordFlash);
    swordFlash = null;
  }

  function endSwordSwing(tl) {
    if (swordTween === tl) swordTween = null;
    // 仅清本刀扇形，避免连招时上一刀 onComplete 拆掉下一刀的闪光
    if (swordFlash && swordFlash.parent && swordFlash.userData && swordFlash.userData.swingTl === tl) {
      clearSwordFlash();
    }
    // 不在此处改 state.attacking：连招会 kill 上一刀时间轴，onInterrupt 若清掉
    // attacking，会在新一刀前摇中误解锁移动
  }

  function trySwordSwing(opts) {
    opts = opts || {};
    if (!combatEnabled()) return false;
    if (state.dying || state.won || state.hurtPause || state.rotating) return false;
    if (!isGameInteractive()) return false;
    // 攻击间隔内再次输入：直接作废，不缓冲、不叠特效（键盘 J / 滚轮相同）
    if (state.attacking) return false;
    swordBuffered = false;
    state.attacking = true;
    if (char.walking) cancelWalk({ silent: true });
    // 受击坠落等可能在 cancel 里置 dying；勿继续挥砍以免 attacking 卡死
    if (state.dying) {
      state.attacking = false;
      return false;
    }
    stopIdle();
    // 站立时自动转向近距影怪，否则只能朝上次走路方向空挥
    faceNearestFoe(SWORD_RANGE + 0.6);
    snapFacing();
    if (char.inner) {
      gsap.killTweensOf(char.inner.rotation);
      char.inner.rotation.set(0, 0, 0);
    }
    if (char.group) {
      char.group.rotation.y = faceYaw;
      char.group.updateMatrixWorld(true);
    }
    const face = faceYaw;
    const sword = char.sword;
    const hitSet = new Set();
    sfx.swing();

    if (swordTween) { swordTween.kill(); swordTween = null; }
    clearSwordFlash();
    if (sword) {
      gsap.killTweensOf(sword.rotation);
      gsap.killTweensOf(sword.position);
    }

    const flash = buildSwordFanMesh();
    swordFlash = flash;
    if (char.group) char.group.add(flash);
    else world.add(flash);
    const fanMat = flash.userData.fanMat;
    const lineMat = flash.userData.lineMat;

    const tRaise = SWORD_WINDUP;
    const tSlash = SWORD_WINDUP + SWORD_ACTIVE;
    const tUnlock = tSlash + SWORD_UNLOCK;
    // 侧闪推迟到判定之后：前摇立刻闪会导致贴身也砍空
    const tDodge = tRaise + SWORD_ACTIVE * 0.7;

    const tl = gsap.timeline({
      onComplete: () => endSwordSwing(tl),
      onInterrupt: () => endSwordSwing(tl)
    });
    flash.userData.swingTl = tl;
    swordTween = tl;

    tl.to(fanMat, { opacity: 0.32, duration: tRaise, ease: 'sine.out' }, 0);
    tl.to(lineMat, { opacity: 0.55, duration: tRaise, ease: 'sine.out' }, 0);
    tl.to(fanMat, { opacity: 0.58, duration: SWORD_ACTIVE * 0.35, ease: 'power1.out' }, tRaise);
    tl.to(lineMat, { opacity: 1, duration: SWORD_ACTIVE * 0.35, ease: 'power1.out' }, tRaise);
    tl.to(fanMat, { opacity: 0, duration: SWORD_RECOVERY, ease: 'power1.in' }, tSlash);
    tl.to(lineMat, { opacity: 0, duration: SWORD_RECOVERY, ease: 'power1.in' }, tSlash);

    if (sword) {
      // 从当前姿势平滑接上（连招时不必先回鞘）
      tl.to(sword.position, { x: 0.18, y: 0.72, z: 0.12, duration: tRaise, ease: 'power2.out' }, 0);
      tl.to(sword.rotation, { x: -0.85, y: 0.15, z: -0.55, duration: tRaise, ease: 'power2.out' }, 0);
      tl.to(sword.position, { x: 0.42, y: 0.36, z: 0.40, duration: SWORD_ACTIVE, ease: 'power2.inOut' }, tRaise);
      tl.to(sword.rotation, { x: 0.55, y: -0.4, z: 1.35, duration: SWORD_ACTIVE, ease: 'power2.inOut' }, tRaise);
      tl.to(sword.position, {
        x: SWORD_SHEATH_POS.x, y: SWORD_SHEATH_POS.y, z: SWORD_SHEATH_POS.z,
        duration: SWORD_RECOVERY, ease: 'power2.inOut'
      }, tSlash);
      tl.to(sword.rotation, {
        x: SWORD_SHEATH_ROT.x, y: SWORD_SHEATH_ROT.y, z: SWORD_SHEATH_ROT.z,
        duration: SWORD_RECOVERY, ease: 'power2.inOut'
      }, tSlash);
    }

    tl.call(() => {
      for (const foe of foes) {
        if (!foe.alive || hitSet.has(foe)) continue;
        if (inSwordFan(foe, face)) { hitSet.add(foe); foeTakeHit(foe); }
      }
    }, null, tRaise + SWORD_ACTIVE * 0.15);
    tl.call(() => {
      for (const foe of foes) {
        if (!foe.alive || hitSet.has(foe)) continue;
        if (inSwordFan(foe, face)) { hitSet.add(foe); foeTakeHit(foe); }
      }
    }, null, tRaise + SWORD_ACTIVE * 0.55);

    // 判定结束后再侧闪（且贴身不闪），避免「看得见扇形却砍不到」
    tl.call(() => {
      for (const foe of foes) {
        if (!foe.alive || foe.walking || hitSet.has(foe)) continue;
        const d = char.group
          ? Math.hypot(foe.group.position.x - char.group.position.x, foe.group.position.z - char.group.position.z)
          : foeDistXZ(foe.node, char.node);
        if (d < 0.55) continue;
        if (foeSeesPlayer(foe) && d < SWORD_RANGE + 1.2) {
          foe.dodgeCd = 0.35;
          const side = foePickDodge(foe);
          if (side && side !== foe.node) foeWalkTo(foe, side);
        }
      }
    }, null, tDodge);

    // 间隔结束才解锁；间隔内的多余攻击已作废，不在此连招
    tl.call(() => {
      state.attacking = false;
      swordBuffered = false;
      if (!char.walking && !state.dying) {
        startIdle();
      }
    }, null, tUnlock);

    return true;
  }

  let foeAiAcc = 0;
  function updateFoes(dt) {
    if (state.won || state.dying || state.hurtPause) return;
    foeAiAcc += dt;
    const step = foeAiAcc >= FOE_AI_STEP;
    if (step) foeAiAcc = 0;
    for (const foe of foes) {
      if (!foe.alive) continue;
      if (foe.contactCd > 0) foe.contactCd -= dt;
      if (foe.dodgeCd > 0) foe.dodgeCd -= dt;
      const sees = foeSeesPlayer(foe);
      if (foe.vision && foe.vision.material) {
        const want = sees ? 0.22 : 0;
        foe.vision.material.opacity += (want - foe.vision.material.opacity) * Math.min(1, dt * 6);
      }
      // 与主角接触扣血（须同层，防穿楼板）
      if (char.group && char.node && foe.node && foe.contactCd <= 0 && foeSameLayerLive(foe)) {
        const d = Math.hypot(
          foe.group.position.x - char.group.position.x,
          foe.group.position.z - char.group.position.z
        );
        if (d < 0.55) {
          foe.contactCd = FOE_CONTACT_CD;
          hurtByFoe();
          return;
        }
      }
      if (!step || foe.walking) continue;
      if (!foe.node || !footingOK(foe.node, camMode)) { foeFall(foe); continue; }
      if (!sees) continue;
      // 判定结束后才带 dodgeCd；贴身不闪，留给玩家反打
      if (state.attacking && foe.dodgeCd > 0 && char.group) {
        const dMelee = Math.hypot(
          foe.group.position.x - char.group.position.x,
          foe.group.position.z - char.group.position.z
        );
        if (dMelee >= 0.55) {
          const side = foePickDodge(foe);
          if (side && side !== foe.node) { foeWalkTo(foe, side); continue; }
        }
      }
      const next = foePickSideApproach(foe);
      if (next && next !== foe.node) foeWalkTo(foe, next);
    }
  }

  let keyHinted = null;
  function hintNearbyHighKey(from) {
    if (camMode !== '3d' || !from) return;
    for (const n of nodes) {
      if (!n.key) continue;
      const foot = Math.abs(n.pos.x - from.pos.x) + Math.abs(n.pos.z - from.pos.z);
      const dy = Math.abs(n.pos.y - from.pos.y);
      if (foot < 1.1 && dy > 0.5) {
        if (keyHinted === n) return;
        keyHinted = n;
        showMarker(n, 'mode:2d');
        toast('旁边高台上有星屑 · 侧面有色差 · 按空格切「俯视」再点它', 3200, 'good');
        sfx.hint();
        return;
      }
    }
  }

  function makeKeyOrdSprite(ord) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 64, 64);
    ctx.beginPath();
    ctx.arc(32, 32, 26, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20, 28, 36, 0.72)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 232, 176, 0.95)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#fff6d8';
    ctx.font = 'bold 30px "Segoe UI", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(ord), 32, 34);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(0.5, 0.5, 1);
    return sp;
  }

  function refreshKeyOrderVisuals() {
    if (!levelKeyOrder()) return;
    const want = nextKeyOrd();
    for (const n of nodes) {
      if (!n.key || !n.keyMesh) continue;
      const ready = n.keyOrd != null && n.keyOrd === want;
      const mat = n.keyMesh.material;
      if (mat) {
        mat.color.setHex(ready ? 0xfff0c0 : 0x8a8a96);
        mat.opacity = ready ? 1 : 0.45;
        mat.transparent = true;
      }
      if (n.keyOrdSprite && n.keyOrdSprite.material) {
        n.keyOrdSprite.material.opacity = ready ? 1 : 0.4;
        n.keyOrdSprite.scale.set(ready ? 0.55 : 0.42, ready ? 0.55 : 0.42, 1);
      }
    }
  }

  function onArrive(n, opts) {
    if (state.dying) return;
    if (!footingOK(n, camMode)) { fallToDeath(); return; }
    if (n.key && n.keyMesh) {
      if (!canCollectKey(n)) {
        const want = nextKeyOrd();
        toast('星屑须按序拾 · 下一枚是第 ' + want + ' 枚（看星上数字）', 2800);
        sfx.deny();
        hintNearbyHighKey(n);
      } else {
        state.keys++;
        sfx.key();
        const ordTag = (levelKeyOrder() && n.keyOrd != null) ? (' · 第 ' + n.keyOrd + ' 枚') : '';
        toast('✦ 拾起星屑 ' + state.keys + ' / ' + keysTotal + ordTag, 2200, 'good');
        const m = n.keyMesh;
        const hit = n.keyHit;
        const sp = n.keyOrdSprite;
        n.key = false; n.keyMesh = null; n.keyHit = null; n.keyOrdSprite = null;
        if (hit) {
          const i = keyHits.indexOf(hit);
          if (i >= 0) keyHits.splice(i, 1);
          if (hit.parent) hit.parent.remove(hit);
        }
        if (sp && sp.parent) sp.parent.remove(sp);
        gsap.to(m.position, { y: '+=0.6', duration: 0.5, ease: 'power2.out' });
        gsap.to(m.scale, { x: 0.01, y: 0.01, z: 0.01, duration: 0.5, ease: 'power2.in', onComplete: () => { if (m.parent) m.parent.remove(m); } });
        refreshKeyOrderVisuals();
        updateGoalLock();
        updateHUD();
        if (state.keys === keysTotal) {
          sfx.unlock();
          toast('✦ 星屑齐了 · 金环已开', 2800, 'good');
        }
      }
    } else {
      // 站在高台星屑旁时，轻声提醒切俯视
      hintNearbyHighKey(n);
    }
    if (n.stele) {
      if (opts && opts.skipStele) {
        // 开局站在石碑上：先出「本章要领」，留言等再踩时再读
      } else {
        if (!n.steleRead) {
          n.steleRead = true;
          markSteleRead(steleId(levelIdx, n.stele));
        }
        sfx.stele();
        hideLevelOpener();
        showArchitectNote(n.stele);
      }
    }
    if (n.goal) {
      const need = n.need || 0;
      if (state.keys < need) {
        toast('金环未开 · 还差 ' + (need - state.keys) + ' 枚星屑');
        sfx.deny();
      } else {
        onWin();
      }
    }
  }

  function requestWalk(target, opts) {
    opts = opts || {};
    if (state.dying || state.won || state.hurtPause || state.attacking) return;
    if (!isGameInteractive()) return;
    if (char.node && camMode === '2d' && char.node.drop) {
      fallToDeath();
      return;
    }
    if (camMode === '2d' && target.drop) {
      if (!opts.fromWasd) {
        toast('俯视里这里没有地面 · 切回 3D 再看');
        sfx.deny();
      }
      return;
    }
    if (state.rotating) { if (!opts.fromWasd) sfx.deny(); return; }
    let redirecting = false;
    if (char.walking) {
      // 行走中再点 / 改道：不停格心硬吸附，从当前位置滑向新目标
      cancelWalk({ silent: true, redirect: true });
      if (state.dying) return;
      redirecting = true;
    }
    if (target.goal && state.keys < (target.need || 0)) {
      if (!opts.fromWasd) {
        toast('金环未开 · 还差 ' + (target.need - state.keys) + ' 枚星屑（去找 ✦）');
        sfx.deny();
      }
      return;
    }
    const plan = planRoute(char.node, target);
    if (!plan || plan.leg.length < 2) {
      if (redirecting && char.node) {
        snapCharToNode(char.node);
        startIdle();
      }
      if (opts.fromWasd) return;
      const n = char.node;
      const dxz = Math.abs(target.pos.x - n.pos.x) + Math.abs(target.pos.z - n.pos.z);
      const dy = Math.abs(target.pos.y - n.pos.y);
      if (camMode === '3d' && n && tileColorKey(n) === tileColorKey(target) &&
          n.planeId >= 0 && target.planeId >= 0 && n.planeId !== target.planeId) {
        showMarker(target, false);
        toast('颜色相同，但没有连在一起 · 不能直接到达');
        sfx.deny();
        return;
      }
      if (camMode === '3d' && dxz < 1.1 && dy > 0.5) {
        showMarker(target, 'mode:2d');
        toast(target.key
          ? '星屑在高台上 · 侧面看得见色差 · 按空格切「俯视」再点它'
          : '侧面有色差，3D 里上不去 · 按空格切到「俯视」');
        sfx.deny();
        return;
      }
      // 当前视角走不动 —— 提示切换视角 / 方位，但不排队：切换后需重新点击
      if (plan && (plan.needMode || plan.needSnap != null)) {
        showMarker(target, plan.needMode ? ('mode:' + plan.needMode) : 'mode:3d');
        toast(hintForPlanToggle(plan), 2800, 'warn');
        sfx.hint();
      } else {
        showMarker(target, false);
        sfx.deny();
      }
      return;
    }
    stepIdx = 0;
    if (!opts.fromWasd) {
      showMarker(target, plan.needMode ? 'mode:' + plan.needMode : true);
      if (plan.needMode || plan.needSnap != null) {
        toast(hintForPlanToggle(plan, true), 2800);
      }
    } else {
      hideMarker();
    }
    walkPath(plan.leg, Object.assign({}, opts, {
      fromVisual: redirecting || !!opts.fromVisual,
      wasdChain: !!opts.wasdChain || redirecting
    }));
  }

  function hintForPlanToggle(plan, midLeg) {
    const prefix = midLeg ? '先走完这段，再' : '先';
    if (plan.needMode === '2d') return prefix + '按空格切到「俯视」' + (midLeg ? '继续' : '，再点这里');
    if (camMode === '3d' && plan.needMode === '3d' && plan.needSnap != null && plan.needSnap !== viewSnap) {
      return prefix + '按 Q/E 转到方位「' + VIEW_SNAP_NAME[plan.needSnap] + '」' + (midLeg ? '继续' : '，再点这里');
    }
    if (plan.needSnap != null && plan.needMode === '3d' && camMode === '2d') {
      return prefix + '按空格切回「3D」，再转到「' + VIEW_SNAP_NAME[plan.needSnap] + '」' + (midLeg ? '继续' : '');
    }
    return prefix + '按空格切回「3D」' + (midLeg ? '继续' : '，再点这里');
  }

  // ------------------------------------------------ 目标标记
  let marker = null;
  function ensureMarker() {
    if (marker) return marker;
    marker = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.04, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
    marker.rotation.x = -Math.PI / 2;
    marker.visible = false;
    scene.add(marker);
    return marker;
  }
  function showMarker(node, kind) {
    const m = ensureMarker();
    gsap.killTweensOf(m.material); gsap.killTweensOf(m.scale);
    m.material.opacity = 0.9;
    m.material.color.set(kind === true ? 0xe8b84b : kind === false ? 0x8a8a92
      : kind === 'mode:2d' ? 0x2ea89a : kind === 'mode:3d' ? 0xe8b84b : 0xe8b84b);
    m.position.set(node.pos.x, planeY(node) + 0.06, node.pos.z);
    m.visible = true;
    m.scale.set(1.4, 1.4, 1.4);
    gsap.to(m.scale, { x: 1, y: 1, z: 1, duration: 0.35, ease: 'power2.out' });
  }
  function hideMarker() {
    if (marker) {
      gsap.to(marker.material, { opacity: 0, duration: 0.4, onComplete: () => { marker.visible = false; marker.material.opacity = 0.9; } });
    }
  }

  // ------------------------------------------------ 旋转机关
  function rotateDial(dial) {
    if (state.rotating || char.walking || state.hurtPause || !isGameInteractive()) { sfx.deny(); return; }
    const rotor = dial.rotorRef;
    if (!rotor) return;
    state.rotating = true;
    sfx.dial();
    const target = rotor.group.rotation.y + Math.PI / 2;
    const ridingSet = new Set([rotor]);
    gsap.to(rotor.group.rotation, {
      y: target, duration: 1.0, ease: 'power2.inOut',
      onUpdate: () => {
        rotor.group.updateMatrixWorld(true);
        carryRiding(ridingSet);
      },
      onComplete: () => {
        rotor.group.rotation.y = target;
        updateGraph();
        carryRiding(ridingSet);
        if (char.node && char.node.rotorRef === rotor) snapCharToNode(char.node);
        snapAliveFoes();
        // 转完后若小怪脚下悬空 → 坠落死亡（不刷新）
        for (const foe of foes) {
          if (!foe.alive || !foe.node) continue;
          if (!footingOK(foe.node, camMode)) foeFall(foe);
        }
        state.rotating = false;
        sfx.settle();
      }
    });
    gsap.to(dial.knob.rotation, { y: target, duration: 1.0, ease: 'power2.inOut' });
  }

  // ------------------------------------------------ 齿轮机关（黄铜轮系）
  // 齿轮是独立的可点击/可拖拽物体，各自同步自己转子的角度；
  // 咬合的齿轮按齿数比反向联动，从而以不同转速驱动各自的转子。
  const glintGoldMat = new THREE.MeshBasicMaterial({
    color: 0xe8b84b, transparent: true, opacity: 0.14, depthWrite: false
  });
  const glintTealMat = new THREE.MeshBasicMaterial({
    color: 0x2ea89a, transparent: true, opacity: 0.16, depthWrite: false
  });
  glintGoldMat.userData.shared = true;
  glintTealMat.userData.shared = true;

  function buildGear(def, rotorRef) {
    if (!rotorRef) { console.warn('齿轮缺转子:', def.id); return; }
    const teeth = def.teeth || 12;
    const radius = 0.048 * teeth + 0.06;
    const pos = def.pos
      ? new THREE.Vector3(def.pos[0], def.pos[1], def.pos[2])
      : new THREE.Vector3(rotorRef.group.position.x, rotorRef.group.position.y + 1.5, rotorRef.group.position.z);
    const root = new THREE.Group();
    root.position.copy(pos);
    const spin = new THREE.Group();
    root.add(spin);
    const brassMat = new THREE.MeshBasicMaterial({ color: 0xd8a94e });
    const darkMat = new THREE.MeshBasicMaterial({ color: 0x7a5c22 });
    const capMat = new THREE.MeshBasicMaterial({ color: 0xe9c87e });
    spin.add(new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.09, 28), brassMat));
    spin.add(new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.92, radius * 0.92, 0.1, 28), capMat));
    for (let i = 0; i < teeth; i++) {
      const a = i / teeth * Math.PI * 2;
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.1), brassMat);
      tooth.position.set(Math.cos(a) * (radius + 0.04), 0, Math.sin(a) * (radius + 0.04));
      tooth.rotation.y = -a;
      spin.add(tooth);
    }
    spin.add(new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.28, radius * 0.28, 0.18, 16), darkMat));
    for (let i = 0; i < 3; i++) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(radius * 1.55, 0.05, 0.07), darkMat);
      sp.position.y = 0.02;
      sp.rotation.y = i / 3 * Math.PI * 2;
      spin.add(sp);
    }
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.62, 10), darkMat);
    pillar.position.y = -0.35;
    root.add(pillar);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.22, 0.08, 12), darkMat);
    base.position.y = -0.68;
    root.add(base);
    // 拾取代理（淡黄铜光晕，兼作可交互提示；略小于轮盘，避免吞掉旁边地砖的点击）
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(radius - 0.08, radius - 0.08, 0.4, 14),
      new THREE.MeshBasicMaterial({ color: 0xd8a94e, transparent: true, opacity: 0.1, depthWrite: false }));
    root.add(hit);
    world.add(root);
    const gear = { def: def, rotorRef: rotorRef, teeth: teeth, radius: radius, root: root, spin: spin, meshWith: null };
    hit.userData.gear = gear;
    gearHits.push(hit);
    gears.push(gear);
  }

  function buildGearLink(a, b) {
    const geo = new THREE.BufferGeometry().setFromPoints([a.root.position.clone(), b.root.position.clone()]);
    const mat = new THREE.LineDashedMaterial({ color: 0xd8a94e, dashSize: 0.16, gapSize: 0.14, transparent: true, opacity: 0.38 });
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    world.add(line);
  }

  // 从某个齿轮出发，收集整个啮合轮系：[{rotorRef, factor}]，driver 的 factor = 1
  function gearParts(gear) {
    const parts = [{ rotorRef: gear.rotorRef, factor: 1, gear: gear }];
    const seen = new Set([gear]);
    let frontier = [gear];
    while (frontier.length) {
      const next = [];
      for (const g of frontier) {
        const gFactor = parts.find(p => p.gear === g).factor;
        for (const o of gears) {
          if (seen.has(o) || !o.rotorRef) continue;
          if (o.meshWith === g || g.meshWith === o) {
            seen.add(o);
            parts.push({ rotorRef: o.rotorRef, factor: gFactor * (-g.teeth / o.teeth), gear: o });
            next.push(o);
          }
        }
      }
      frontier = next;
    }
    return parts;
  }

  function _gcdInt(a, b) {
    a = Math.abs(a | 0); b = Math.abs(b | 0);
    while (b) { const t = a % b; a = b; b = t; }
    return a || 1;
  }
  function _lcmInt(a, b) {
    return Math.abs((a / _gcdInt(a, b)) * b) || 1;
  }
  /** factor 写成最简分数时的分母（|f|·den ≈ 整数） */
  function _factorDenom(f) {
    const af = Math.abs(f);
    for (let d = 1; d <= 128; d++) {
      if (Math.abs(d * af - Math.round(d * af)) < 1e-8) return d;
    }
    return 1;
  }
  /**
   * 轮系公共角量子：使「每一个」转子的增量都是 90° 整数倍的最小驱动轮转角。
   * 例 12:6 点从动轮 → factor 含 1/2 → 量子 = 180°；点驱动轮 → 量子仍 90°（从动轮走 180°）。
   */
  function gearQuantum(parts) {
    let steps = 1;
    for (const p of parts) steps = _lcmInt(steps, _factorDenom(p.factor));
    return steps * (Math.PI / 2);
  }
  /** 把任意驱动轮增量对齐到最近的公共角量子（0 表示回弹到起点） */
  function alignGearDelta(parts, delta) {
    const q = gearQuantum(parts);
    return Math.round(delta / q) * q;
  }
  /** 点击一步：同向至少转一个公共角量子（12:6 点小轮 = 180°） */
  function gearClickDelta(parts, dir) {
    const q = gearQuantum(parts);
    const sign = dir < 0 ? -1 : 1;
    return sign * q;
  }

  function carryRiding(rotorSet) {
    if (char.node && char.node.rotorRef && rotorSet.has(char.node.rotorRef)) {
      _v.copy(char.node.local);
      char.node.rotorRef.group.localToWorld(_v);
      char.group.position.copy(_v);
      if (camMode === '2d') char.group.position.y = 0.04;
    }
    // 小怪同样受转子机关带动
    for (const foe of foes) {
      if (!foe.alive || foe.walking || !foe.node || !foe.node.local) continue;
      if (!foe.node.rotorRef || !rotorSet.has(foe.node.rotorRef)) continue;
      _v.copy(foe.node.local);
      foe.node.rotorRef.group.localToWorld(_v);
      foe.group.position.copy(_v);
      if (camMode === '2d') foe.group.position.y = 0.04;
    }
  }

  // 齿轮系联动旋转：driver 转动 delta（弧度），其余按齿数比反向跟随
  function tweenRotors(parts, delta, dur, done) {
    const start = parts.map(p => p.rotorRef.group.rotation.y);
    // delta 须已是公共角量子的整数倍，使每个 end 都落在 90° 网格上
    const end = parts.map((p, i) => start[i] + delta * p.factor);
    const riding = new Set(parts.map(p => p.rotorRef));
    const pr = { t: 0 };
    gsap.to(pr, {
      t: 1, duration: dur, ease: 'power2.inOut',
      onUpdate: () => {
        parts.forEach((p, i) => {
          p.rotorRef.group.rotation.y = start[i] + (end[i] - start[i]) * pr.t;
          p.rotorRef.group.updateMatrixWorld(true);
        });
        carryRiding(riding);
      },
      onComplete: () => {
        parts.forEach((p, i) => {
          p.rotorRef.group.rotation.y = end[i];
          p.rotorRef.group.updateMatrixWorld(true);
        });
        updateGraph();
        carryRiding(riding);
        if (char.node && riding.has(char.node.rotorRef)) snapCharToNode(char.node);
        snapAliveFoes();
        for (const foe of foes) {
          if (!foe.alive || !foe.node) continue;
          if (!footingOK(foe.node, camMode)) foeFall(foe);
        }
        state.rotating = false;
        if (done) done();
      }
    });
  }

  function rotateGearBy(gear, delta) {
    if (state.rotating || char.walking || state.hurtPause || !isGameInteractive()) { sfx.deny(); return; }
    const parts = gearParts(gear);
    if (!parts.length) return;
    // 将请求角对齐到公共量子（点击传入 ±90° 时，12:6 点小轮会升为 180°）
    let aligned = alignGearDelta(parts, delta);
    if (Math.abs(aligned) < 1e-8) aligned = gearClickDelta(parts, delta);
    state.rotating = true;
    sfx.dial();
    tweenRotors(parts, aligned, 0.95);
  }

  // 拖拽齿轮连续转动；松手按公共角量子吸附（全系转子均落在 90° 整数倍）；轻点则转一格量子
  let gearDrag = null;
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const dragPoint = new THREE.Vector3();

  function pointerAngle(e, gear) {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    ray.setFromCamera(mouse, camera);
    dragPlane.constant = -gear.root.position.y;
    if (!ray.ray.intersectPlane(dragPlane, dragPoint)) return null;
    return Math.atan2(-(dragPoint.z - gear.root.position.z), dragPoint.x - gear.root.position.x);
  }

  function abortGearDrag(silent) {
    window.removeEventListener('pointermove', onGearDragMove);
    window.removeEventListener('pointerup', onGearDragUp);
    window.removeEventListener('pointercancel', onGearDragUp);
    if (gearDrag) {
      gearDrag = null;
      if (!silent) state.rotating = false;
    }
  }

  function beginGearDrag(gear, e) {
    if (state.rotating || char.walking || state.hurtPause || !isGameInteractive()) { sfx.deny(); return; }
    const a0 = pointerAngle(e, gear);
    if (a0 == null) return;
    const parts = gearParts(gear);
    gearDrag = {
      gear: gear, parts: parts, moved: false,
      grab: a0, last: a0, accum: 0,
      startAngles: parts.map(p => p.rotorRef.group.rotation.y)
    };
    window.addEventListener('pointermove', onGearDragMove);
    window.addEventListener('pointerup', onGearDragUp);
    window.addEventListener('pointercancel', onGearDragUp);
  }

  function onGearDragMove(e) {
    if (!gearDrag) return;
    if (state.hurtPause || !isGameInteractive()) {
      abortGearDrag(false);
      return;
    }
    const a = pointerAngle(e, gearDrag.gear);
    if (a == null) return;
    let d = a - gearDrag.last;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    gearDrag.last = a;
    gearDrag.accum += d;
    if (!gearDrag.moved && Math.abs(gearDrag.accum) > 0.06) {
      gearDrag.moved = true;
      state.rotating = true;
      sfx.dial();
    }
    if (!gearDrag.moved) return;
    gearDrag.parts.forEach((p, i) => {
      p.rotorRef.group.rotation.y = gearDrag.startAngles[i] + gearDrag.accum * p.factor;
      p.rotorRef.group.updateMatrixWorld(true);
    });
    carryRiding(new Set(gearDrag.parts.map(p => p.rotorRef)));
  }

  function onGearDragUp() {
    window.removeEventListener('pointermove', onGearDragMove);
    window.removeEventListener('pointerup', onGearDragUp);
    window.removeEventListener('pointercancel', onGearDragUp);
    if (!gearDrag) return;
    const drag = gearDrag;
    gearDrag = null;
    if (!drag.moved) {
      state.rotating = false;
      rotateGearBy(drag.gear, gearClickDelta(drag.parts, 1));
      return;
    }
    // 按公共角量子吸附驱动轮增量；从动轮 = 起点 + totalDelta×factor（禁止对各轮独立 90° 量化）
    const totalDelta = alignGearDelta(drag.parts, drag.accum);
    const snapDelta = totalDelta - drag.accum;
    if (Math.abs(snapDelta) < 0.01) {
      drag.parts.forEach((p, i) => {
        p.rotorRef.group.rotation.y = drag.startAngles[i] + totalDelta * p.factor;
        p.rotorRef.group.updateMatrixWorld(true);
      });
      updateGraph();
      snapAliveFoes();
      for (const foe of foes) {
        if (!foe.alive || !foe.node) continue;
        if (!footingOK(foe.node, camMode)) foeFall(foe);
      }
      state.rotating = false;
      sfx.settle();
    } else {
      tweenRotors(drag.parts, snapDelta, 0.3, () => sfx.settle());
    }
  }

  // ------------------------------------------------ 错觉光带（视觉引导）
  // 3D：投影对齐 → 金色；侧面色差高差（须俯视）→ 青色
  // 2D：任意高差脚印边 → 青色
  // 共享几何 + 网格池：功能不变，切视角时避免反复 new TorusGeometry
  let glintSharedGeo = null;
  const glintPool = [];
  function getGlintGeo() {
    if (!glintSharedGeo) glintSharedGeo = new THREE.TorusGeometry(0.22, 0.014, 10, 36);
    return glintSharedGeo;
  }
  function acquireGlintMesh(mat) {
    let m = glintPool.pop();
    if (!m) {
      m = new THREE.Mesh(getGlintGeo(), mat);
      m.rotation.x = -Math.PI / 2;
      m.userData.pooledGlint = true;
    } else {
      m.material = mat;
      m.visible = true;
    }
    return m;
  }
  function releaseGlintMesh(m) {
    if (!m) return;
    if (m.parent) m.parent.remove(m);
    m.visible = false;
    if (m.userData.pooledGlint) glintPool.push(m);
  }
  function applyGlints() {
    for (const n of nodes) {
      if (!n.mesh) continue;
      let kind = null;
      if (camMode === '3d') {
        if (illuNodes.has(n)) {
          const nbrs = adjByMode['3d'].get(n) || [];
          let sameH = 0;
          for (let i = 0; i < nbrs.length; i++) {
            const nb = nbrs[i];
            const dy = Math.abs(nb.pos.y - n.pos.y);
            const foot = Math.abs(nb.pos.x - n.pos.x) + Math.abs(nb.pos.z - n.pos.z);
            if (dy < 0.01 && foot < 1.1) sameH++;
          }
          if (sameH < 2) kind = 'gold';
        }
        if (!kind && climbNodes.has(n)) kind = 'teal';
      } else if (camMode === '2d' && stairNodes.has(n)) {
        kind = 'teal';
      }
      if (kind && !n.glint) {
        const m = acquireGlintMesh(kind === 'gold' ? glintGoldMat : glintTealMat);
        m.position.y = (n.mesh.geometry.parameters.height || 1) / 2 + 0.02;
        n.mesh.add(m);
        n.glint = m;
      } else if (n.glint) {
        if (!kind) {
          releaseGlintMesh(n.glint);
          n.glint = null;
        } else {
          n.glint.visible = true;
          n.glint.material = kind === 'gold' ? glintGoldMat : glintTealMat;
        }
      }
    }
  }

  // ------------------------------------------------ 2D/3D 视角切换（视角即钥匙）
  // 3D 等距：四个卦限方位（甲乙丙丁），投影错觉随方位变
  const ORBIT_PHI0 = Math.acos(1 / Math.sqrt(3));
  const ORBIT_THETA0 = Math.PI / 4;
  let orbitTheta = ORBIT_THETA0;
  let orbitPhi = ORBIT_PHI0;

  function resetOrbitAngles() {
    orbitTheta = ORBIT_THETA0 + viewSnap * (Math.PI / 2);
    orbitPhi = ORBIT_PHI0;
  }

  function syncYawButtons() {
    // 多方位关：Q/E 始终占位，俯视时只淡化（仍可点出提示），避免切视角时工具栏挪位
    const multi = levelHasMultiView();
    const active = multi && camMode === '3d';
    const a = document.getElementById('btn-yaw-ccw');
    const b = document.getElementById('btn-yaw-cw');
    [a, b].forEach(btn => {
      if (!btn) return;
      if (!multi) {
        btn.hidden = true;
        btn.classList.remove('is-yaw-slot', 'is-yaw-disabled');
        btn.removeAttribute('aria-disabled');
        return;
      }
      btn.hidden = false;
      btn.classList.add('is-yaw-slot');
      btn.classList.toggle('is-yaw-disabled', !active);
      btn.setAttribute('aria-disabled', active ? 'false' : 'true');
    });
  }

  function rotateView(dir) {
    if (state.dying || state.won || state.hurtPause || state.attacking) return false;
    if (!isGameInteractive()) return false;
    if (camMode !== '3d') {
      toast('先切回 3D，再转方位对齐', null, 'warn');
      sfx.deny();
      return false;
    }
    if (!levelHasMultiView()) {
      toast('本章方位固定 · 只需切换俯视 / 3D', 2200, 'warn');
      sfx.deny();
      return false;
    }
    if (state.rotating) {
      toast('齿轮还在转 · 停稳后再转方位', null, 'warn');
      sfx.deny();
      return false;
    }
    const snaps = levelViewSnaps();
    let ix = snaps.indexOf(viewSnap);
    if (ix < 0) ix = 0;
    ix = (ix + (dir > 0 ? 1 : -1) + snaps.length * 8) % snaps.length;
    const next = snaps[ix];
    if (next === viewSnap) return false;
    viewSnap = next;
    resetOrbitAngles();
    adjByMode['3d'] = adjBySnap[viewSnap] || buildAdj('3d', viewSnap);
    adj = adjByMode['3d'];
    // 刷新当前方位下的 illu 标记
    buildAdj('3d', viewSnap);
    applyPlanarLayout();
    state.switchCount++;
    updateHUD();
    updateModeButton();
    applyCam(true);
    sfx.toggle();
    flash(getComputedStyle(document.documentElement).getPropertyValue('--ui-goal').trim() || '#fff7e0');
    // 光带完整刷新，挪到下一帧避免与镜头首帧抢主线程
    requestAnimationFrame(() => { if (camMode === '3d') applyGlints(); });
    toast('方位 · ' + VIEW_SNAP_NAME[viewSnap] + ' · 远砖对齐关系已改', 2400, 'good');
    if (char.walking) char.cancelPending = true;
    else if (char.node) settleAfterToggle(char.node, null, { arrive: false });
    settleFoesAfterToggle();
    return true;
  }

  function camPosFromOrbit() {
    if (camMode === '2d') return new THREE.Vector3(0, CAM_DIST, 0).add(camCenter);
    const sp = Math.sin(orbitPhi), cp = Math.cos(orbitPhi);
    return new THREE.Vector3(
      sp * Math.cos(orbitTheta),
      cp,
      sp * Math.sin(orbitTheta)
    ).multiplyScalar(CAM_DIST).add(camCenter);
  }

  function camUpFromOrbit() {
    if (camMode === '2d') return new THREE.Vector3(0, 0, -1);
    return new THREE.Vector3(0, 1, 0);
  }

  const _camFromPos = new THREE.Vector3();
  const _camFromUp = new THREE.Vector3();
  const _camLerpPos = new THREE.Vector3();
  const _camLerpUp = new THREE.Vector3();
  function camAnimDuration() {
    // 低画质略短，但与世界压平插值同步，观感仍完整
    if (gfxTier <= 0) return 0.42;
    if (gfxTier === 1) return 0.52;
    return 0.65;
  }
  function applyCam(animated) {
    const wantPos = camPosFromOrbit();
    const wantUp = camUpFromOrbit();
    camTweens.forEach(t => { try { t.kill(); } catch (e) { } });
    camTweens = [];
    if (animated) {
      const dur = camAnimDuration();
      const ease = gfxTier <= 0 ? 'sine.inOut' : 'power2.inOut';
      // 单 tween 插值 position+up，调度更稳；效果与双 tween 一致
      _camFromPos.copy(camera.position);
      _camFromUp.copy(camera.up);
      const pr = { t: 0 };
      camTweens = [gsap.to(pr, {
        t: 1, duration: dur, ease: ease,
        onUpdate: () => {
          const t = pr.t;
          _camLerpPos.lerpVectors(_camFromPos, wantPos, t);
          _camLerpUp.lerpVectors(_camFromUp, wantUp, t).normalize();
          camera.position.copy(_camLerpPos);
          camera.up.copy(_camLerpUp);
        },
        onComplete: () => {
          camera.position.copy(wantPos);
          camera.up.copy(wantUp);
          camTweens = [];
        }
      })];
      try { scheduleAnimate(0); } catch (e) { }
    } else {
      camera.position.copy(wantPos);
      camera.up.copy(wantUp);
    }
  }

  function toggleMode() {
    if (state.dying || state.won || state.hurtPause || state.attacking) return false;
    if (!isGameInteractive()) return false;
    if (state.rotating) {
      toast('齿轮还在转 · 停稳后再切换视角', null, 'warn');
      sfx.deny();
      return false;
    }
    camMode = camMode === '3d' ? '2d' : '3d';
    adj = adjByMode[camMode];
    document.body.classList.toggle('mode-2d', camMode === '2d');
    if (camMode === '3d') {
      resetOrbitAngles();
      // 优先复用已缓存邻接；仍调用 buildAdj 刷新 illu/climb 副作用
      if (adjBySnap[viewSnap]) {
        adjByMode['3d'] = adjBySnap[viewSnap];
        adj = adjByMode['3d'];
        buildAdj('3d', viewSnap);
      } else {
        adjBySnap[viewSnap] = buildAdj('3d', viewSnap);
        adjByMode['3d'] = adjBySnap[viewSnap];
        adj = adjByMode['3d'];
      }
    }
    applyPhaseStyles();
    // 世界压平与镜头同步插值（完整逻辑，只是不再瞬切高度）
    morphPlanarLayout(true);
    updateModeButton();
    syncYawButtons();
    state.switchCount++;
    updateHUD();
    applyCam(true);
    sfx.toggle();
    flash(camMode === '2d'
      ? (getComputedStyle(document.documentElement).getPropertyValue('--ui-accent').trim() || '#eafffa')
      : (getComputedStyle(document.documentElement).getPropertyValue('--ui-goal').trim() || '#fff7e0'));
    // 光带完整刷新（含新建），放到下一帧，与镜头首帧错开
    requestAnimationFrame(() => applyGlints());
    if (char.walking) char.cancelPending = true;
    else if (char.node) settleAfterToggle(char.node, null, { arrive: false });
    settleFoesAfterToggle();
    return true;
  }

  // 视角切换的全屏微闪光（2D 青调 / 3D 暖调），增强"世界观翻转"的反馈
  // 用双 rAF 重启 transition，避免 void offsetWidth 强制同步布局
  const flashEl = document.getElementById('flash');
  let flashClearTimer = null;
  let flashRaf = 0;
  function flash(color) {
    if (!flashEl) return;
    gsap.killTweensOf(flashEl);
    if (flashClearTimer) { clearTimeout(flashClearTimer); flashClearTimer = null; }
    if (flashRaf) { try { cancelAnimationFrame(flashRaf); } catch (e) { } flashRaf = 0; }
    const peak = 0.16;
    const fadeSec = gfxTier <= 0 ? 0.42 : 0.55;
    flashEl.style.transition = 'none';
    flashEl.style.background = color || '#fff';
    flashEl.style.opacity = String(peak);
    flashRaf = requestAnimationFrame(() => {
      flashRaf = requestAnimationFrame(() => {
        flashRaf = 0;
        flashEl.style.transition = 'opacity ' + fadeSec + 's ease-out';
        flashEl.style.opacity = '0';
        flashClearTimer = setTimeout(() => {
          flashEl.style.transition = 'none';
          flashClearTimer = null;
        }, (fadeSec * 1000 + 40) | 0);
      });
    });
  }

  function updateModeButton() {
    const label = document.getElementById('mode-label');
    const now = document.getElementById('mode-now');
    const icon = document.getElementById('mode-icon');
    const tag = document.getElementById('mode-tag');
    const btn = document.getElementById('btn-mode');
    if (camMode === '3d') {
      const yaw = levelHasMultiView() ? ('·' + VIEW_SNAP_NAME[viewSnap]) : '';
      if (now) now.textContent = '当前 3D' + yaw;
      label.textContent = '切到俯视'; icon.textContent = '⬢';
      if (tag) tag.textContent = '3D' + yaw;
      if (btn) btn.title = '切到俯视：翻过侧面色差高差与青色桥 (空格)' +
        (levelHasMultiView() ? ' · Q/E 转 3D 方位' : '');
    } else {
      if (now) now.textContent = '当前俯视';
      label.textContent = '切回 3D'; icon.textContent = '⬡';
      if (tag) tag.textContent = '俯视';
      if (btn) btn.title = '切回 3D：同色平面与金色对齐桥 (空格)';
    }
    syncYawButtons();
  }

  // ------------------------------------------------ 交互
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  function pick(e) {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    ray.setFromCamera(mouse, camera);
    const kh = ray.intersectObjects(keyHits, false);
    if (kh.length) {
      const n = kh[0].object.userData.node;
      if (n && n.key) return { node: n };
    }
    const gh = ray.intersectObjects(gearHits, false);
    if (gh.length) return { gear: gh[0].object.userData.gear };
    const dh = ray.intersectObjects(dialHits, false);
    if (dh.length) return { dial: dh[0].object.userData.dial };
    const hits = ray.intersectObjects(walkMeshes, false);
    let ghost = null;
    let best = null, bestScore = -1e9;
    for (const h of hits) {
      const n = h.object.userData.node;
      if (!n) continue;
      if (n.phase && n.phase !== camMode) { if (!ghost) ghost = n; continue; }
      // 俯视叠砖时优先点到星屑/终点/石碑，其次较高的一格
      let score = -h.distance;
      if (n.key) score += 100;
      if (n.goal) score += 80;
      if (n.stele && !n.steleRead) score += 60;
      score += n.pos.y * 2;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    if (best) return { node: best };
    if (ghost) return { node: ghost, ghost: true };
    return null;
  }

  // ------------------------------------------------ 悬停高亮（互动反馈）
  let hoverMesh = null, lastHoverNode = null;
  function ensureHover() {
    if (hoverMesh) return hoverMesh;
    hoverMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.96),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false }));
    hoverMesh.rotation.x = -Math.PI / 2;
    hoverMesh.visible = false;
    scene.add(hoverMesh);
    return hoverMesh;
  }
  function updateHover(e) {
    if (state.won || !isGameInteractive()) { hideHover(); return; }
    const hit = pick(e);
    const node = (hit && hit.node && !hit.ghost) ? hit.node : null;
    if (node && node !== lastHoverNode) {
      const m = ensureHover();
      m.position.set(node.pos.x, planeY(node) + 0.012, node.pos.z);
      m.visible = true;
    } else if (!node) {
      hideHover();
    }
    lastHoverNode = node;
    renderer.domElement.style.cursor = (hit && !isKeyboardPlay()) ? 'pointer' : 'default';
  }  function hideHover() {
    lastHoverNode = null;
    if (hoverMesh) hoverMesh.visible = false;
  }

  let evSawPointer = false, evSawMouse = false, evT0 = 0;

  function onCanvasDown(e, kind) {
    const now = performance.now();
    if (now - evT0 > 500) { evSawPointer = false; evSawMouse = false; }
    evT0 = now;
    if (kind === 'pointer') { evSawPointer = true; }
    else if (kind === 'mouse') { if (evSawPointer) return; evSawMouse = true; }
    else { if (evSawPointer || evSawMouse) return; }
    if (state.won || state.dying || state.hurtPause || !isGameInteractive() || !aboutEl.classList.contains('hidden')) return;

    // 键盘模式：禁止鼠标点地行走 / 右键停步；机关仍可用指针操作
    if (isKeyboardPlay()) {
      const hitK = pick(e);
      if (hitK && (hitK.gear || hitK.dial)) {
        if (hitK.gear) beginGearDrag(hitK.gear, e);
        else if (hitK.dial) rotateDial(hitK.dial);
        return;
      }
      return;
    }

    // 右键：取消当前行走，停在已站稳的格子
    if (e.button === 2) {
      e.preventDefault();
      if (char.walking || char.cancelPending) cancelWalk();
      return;
    }
    if (e.button !== 0 && e.button != null) return;
    if (state.attacking) return;

    const hit = pick(e);
    if (hit && hit.gear) {
      beginGearDrag(hit.gear, e);
      return;
    }
    if (hit && hit.dial) {
      rotateDial(hit.dial);
      return;
    }
    // 左键仅点地行走 / 拨齿轮；攻击用 J 或（鼠标模式）滚轮
    if (!hit || !hit.node) return;
    if (hit.ghost) {
      toast('此桥在当前视角不是实体 · 按空格换个看法');
      sfx.deny();
      return;
    }
    if (char.node && hit.node === char.node) return;
    requestWalk(hit.node);
  }

  function onCanvasMove(e) {
    if (isKeyboardPlay()) { hideHover(); return; }
    updateHover(e);
  }

  // ------------------------------------------------ WASD（坦克式）
  // A / D = 原地左转 / 右转 90°（不位移）
  // W / S = 沿当前面朝前进 / 后退一格
  // 点按一格或一转；长按连走 / 连转；行走中改 W/S = 停步改道
  const wasdHeld = new Set();
  const wasdHoldReady = new Set();
  const wasdHoldTimers = new Map();
  const WASD_HOLD_MS = 180;
  const WASD_TURN = Math.PI / 2;

  /** 面朝量化到最近 90° */
  function charMoveAxes() {
    const yaw = Math.round(faceYaw / WASD_TURN) * WASD_TURN;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    return { fx: fx, fz: fz, rx: rx, rz: rz, yaw: yaw };
  }
  /** 仅 W/S 合成前进方向（随当前面朝，不冻结） */
  function wasdDesiredDir() {
    const ax = charMoveAxes();
    let dx = 0, dz = 0;
    if (wasdHeld.has('KeyW')) { dx += ax.fx; dz += ax.fz; }
    if (wasdHeld.has('KeyS')) { dx -= ax.fx; dz -= ax.fz; }
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return null;
    return { dx: dx / len, dz: dz / len };
  }
  function wasdMoveWantsContinue() {
    if (wasdHeld.has('KeyW') && wasdHoldReady.has('KeyW')) return true;
    if (wasdHeld.has('KeyS') && wasdHoldReady.has('KeyS')) return true;
    return false;
  }
  function wasdTurnWantsContinue() {
    const a = wasdHeld.has('KeyA') && wasdHoldReady.has('KeyA');
    const d = wasdHeld.has('KeyD') && wasdHoldReady.has('KeyD');
    if (a && d) return false; // 对键抵消
    return a || d;
  }
  /** 连走仍用旧名，供 walkPath 调用 */
  function wasdWantsContinue() { return wasdMoveWantsContinue(); }
  function clearWasdKey(code) {
    wasdHeld.delete(code);
    wasdHoldReady.delete(code);
    const t = wasdHoldTimers.get(code);
    if (t) { clearTimeout(t); wasdHoldTimers.delete(code); }
  }
  function pickNeighborInDir(dx, dz) {
    if (!char.node) return null;
    const nbs = adj.get(char.node) || [];
    let best = null, bestScore = 0.42;
    for (const nb of nbs) {
      if (!footingOK(nb, camMode)) continue;
      const ex = nb.pos.x - char.node.pos.x;
      const ez = nb.pos.z - char.node.pos.z;
      const ey = nb.pos.y - char.node.pos.y;
      const el = Math.hypot(ex, ez);
      if (el < 0.01) continue;
      const dot = (ex * dx + ez * dz) / el;
      const score = dot - Math.abs(el - 1) * 0.1 - Math.abs(ey) * 0.06;
      if (score > bestScore) { bestScore = score; best = nb; }
    }
    return best;
  }
  function pickWasdNeighbor() {
    const dir = wasdDesiredDir();
    if (!dir) return null;
    return pickNeighborInDir(dir.dx, dir.dz);
  }
  /** A 左转 / D 右转（格点 90°） */
  function tryWasdTurn(opts) {
    opts = opts || {};
    if (isMousePlay()) return false;
    if (!isGameInteractive() || state.won || state.dying || state.hurtPause || state.attacking || state.rotating) return false;
    if (aboutEl && !aboutEl.classList.contains('hidden')) return false;
    if (levelsEl && !levelsEl.classList.contains('hidden')) return false;
    const a = wasdHeld.has('KeyA');
    const d = wasdHeld.has('KeyD');
    if (a === d) return false; // 无键或对键
    // 非连转时，转身动画未完不打断
    if (faceTween && !opts.chain) return false;
    const ax = charMoveAxes();
    // 俯视下左转 → 新面朝 = 旧右向；右转 → 旧左向
    if (a) faceTowards(ax.rx, ax.rz, { fromWasdTurn: true });
    else faceTowards(-ax.rx, -ax.rz, { fromWasdTurn: true });
    return true;
  }
  function tryWasdStep(opts) {
    opts = opts || {};
    if (isMousePlay()) return false;
    if (!isGameInteractive() || state.won || state.dying || state.hurtPause || state.attacking || state.rotating) return false;
    if (aboutEl && !aboutEl.classList.contains('hidden')) return false;
    if (levelsEl && !levelsEl.classList.contains('hidden')) return false;
    const next = pickWasdNeighbor();
    if (!next) return false;
    if (char.walking) {
      if (!opts.redirect) return false;
      if (char.walkTarget === next) return false;
      // 不在此处硬取消：交给 requestWalk 软改道，避免吸附格心瞬移
    }
    requestWalk(next, { fromWasd: true, wasdChain: !!opts.chain || !!opts.redirect });
    return true;
  }

  renderer.domElement.addEventListener('pointerdown', e => onCanvasDown(e, 'pointer'));
  renderer.domElement.addEventListener('mousedown', e => onCanvasDown(e, 'mouse'));
  renderer.domElement.addEventListener('pointermove', onCanvasMove);
  renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
  renderer.domElement.addEventListener('pointerleave', () => hideHover());

  renderer.domElement.addEventListener('wheel', e => {
    e.preventDefault();
    if (!isGameInteractive()) return;
    // 鼠标模式：滚轮上下均为攻击，间隔与按 J 相同
    if (isMousePlay()) {
      trySwordSwing();
      return;
    }
    // 键盘模式：不使用滚轮
    if (isKeyboardPlay()) return;
    camera.zoom = Math.min(2.4, Math.max(0.4, camera.zoom * (e.deltaY < 0 ? 1.08 : 0.925)));
    camera.updateProjectionMatrix();
  }, { passive: false });

  window.addEventListener('keydown', e => {
    if (!isGameInteractive()) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.code === 'Space') { e.preventDefault(); toggleMode(); }
    else if (e.code === 'KeyQ') { e.preventDefault(); rotateView(-1); }
    else if (e.code === 'KeyE') { e.preventDefault(); rotateView(1); }
    else if (e.code === 'KeyR') { restartLevel(); }
    else if (e.code === 'KeyM') { toggleMute(); }
    else if (e.code === 'KeyJ' || e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      trySwordSwing();
    }
    else if (e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyS' || e.code === 'KeyD') {
      // 鼠标模式关闭 WASD 移动，改用点地
      if (isMousePlay()) return;
      e.preventDefault();
      const isTurn = (e.code === 'KeyA' || e.code === 'KeyD');
      if (e.repeat) {
        wasdHeld.add(e.code);
        wasdHoldReady.add(e.code);
        if (isTurn && !faceTween) tryWasdTurn({ chain: true });
        return;
      }
      wasdHeld.add(e.code);
      wasdHoldReady.delete(e.code);
      const prev = wasdHoldTimers.get(e.code);
      if (prev) clearTimeout(prev);
      wasdHoldTimers.set(e.code, setTimeout(() => {
        wasdHoldTimers.delete(e.code);
        if (wasdHeld.has(e.code)) wasdHoldReady.add(e.code);
      }, WASD_HOLD_MS));
      if (isTurn) {
        tryWasdTurn();
      } else if (!char.walking) {
        tryWasdStep();
      } else {
        tryWasdStep({ redirect: true });
      }
    }
    else if (e.code === 'Escape') {
      if (char.walking || char.cancelPending) { e.preventDefault(); cancelWalk(); }
      else { hideAbout(); hideLevels(); }
    }
  });
  window.addEventListener('keyup', e => {
    if (e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyS' || e.code === 'KeyD') {
      clearWasdKey(e.code);
    }
  });
  window.addEventListener('blur', () => {
    for (const code of [...wasdHeld]) clearWasdKey(code);
    wasdHeld.clear();
    wasdHoldReady.clear();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      for (const code of [...wasdHeld]) clearWasdKey(code);
      wasdHeld.clear();
      wasdHoldReady.clear();
    }
  });

  // ------------------------------------------------ 通关
  function onWin() {
    if (state.won) return;
    state.won = true;
    pauseSlaughterTimer(true);
    sfx.win();
    if (goalFx) {
      gsap.to(goalFx.ring.scale, { x: 3.2, y: 3.2, z: 3.2, duration: 0.9, ease: 'power2.out' });
      gsap.to(goalFx.gem.position, { y: '+=1.2', duration: 0.9, ease: 'power2.out' });
    }
    const mainN = mainLevelCount();
    const lastMain = !curLevel.hidden && !curLevel.sandbox && levelIdx === lastStoryIdx();
    const firstStory = !curLevel.hidden && !curLevel.sandbox && levelIdx === firstStoryIdx();
    const slaughterClear = isSlaughter() && firstStory;
    const hiddenOpen = !isSlaughter() && lastMain && allMainStelesRead() && hiddenLevelIdx() >= 0;
    document.getElementById('win-title').textContent = slaughterClear
      ? '屠戮完成 · 回到起点'
      : (curLevel.name + ' · 完成');
    document.getElementById('win-sub').textContent = slaughterClear
      ? '倒行终了 · 五分钟内已归'
      : (curLevel.story || '');
    const M = state.switchCount;
    const hasPar = isFinite(levelPar) && levelPar > 0;
    const Pp = hasPar ? levelPar : (isFinite(levelPar) ? levelPar : M);
    let starNum;
    if (hasPar) {
      starNum = M <= Pp ? 3 : M <= Pp + 4 ? 2 : 1;
    } else {
      // par=0 / 未算出：不拿「最优 0」惩罚探索，改按切换次数宽松评级
      starNum = M <= 4 ? 3 : M <= 8 ? 2 : 1;
    }
    const starEl = document.getElementById('win-stars');
    if (starEl) {
      starEl.innerHTML = [0, 1, 2].map(i =>
        '<span class="' + (i < starNum ? 'on' : 'dim') + '">★</span>').join('');
    }
    let statsHtml = hasPar
      ? ('视角 <b>' + M + '</b> 次　最优 ' + Pp + '　·　星屑 <b>' + state.keys + '</b>/' + keysTotal)
      : ('视角 <b>' + M + '</b> 次　·　星屑 <b>' + state.keys + '</b>/' + keysTotal);
    if (isSlaughter() && slaughterEndsAt) {
      const left = Math.max(0, slaughterEndsAt - performance.now());
      statsHtml += '　·　⏱ 余 ' + formatTimer(left);
    }
    document.getElementById('win-stats').innerHTML = statsHtml;

    const st = steleStats();
    const steleEl = document.getElementById('win-steles');
    if (steleEl) {
      if (slaughterClear) steleEl.textContent = '屠戮通关 · 倒行全部章节完成';
      else if (isSlaughter()) steleEl.textContent = '倒行中 · 下一站更早的章节';
      else if (curLevel.hidden) steleEl.textContent = '碑录已齐 · 外章终了';
      else if (hiddenOpen) steleEl.textContent = '建筑师留言 ' + st.read + ' / ' + st.total + '　·　碑文齐备，隐藏回廊已启';
      else if (lastMain) steleEl.textContent = '建筑师留言 ' + st.read + ' / ' + st.total + '　·　寻齐碑文可开隐藏回廊';
      else steleEl.textContent = '建筑师留言 ' + st.read + ' / ' + st.total;
    }

    // 进度入账：观光正向解锁；屠戮也记星级，但不改正向解锁逻辑以外的章节
    const prev = (Auth.progress.records && Auth.progress.records[levelIdx]) || {};
    const hadRecord = (prev.stars || 0) > 0 || prev.switches != null || (prev.keys || 0) > 0;
    const improved = !hadRecord ||
      starNum > (prev.stars || 0) ||
      (prev.switches != null && M < prev.switches) ||
      ((prev.keys || 0) < state.keys);
    const hIdx = hiddenLevelIdx();
    Auth.commit(p => {
      if (!isSlaughter()) {
        if (curLevel.hidden) {
          p.unlocked = Math.max(p.unlocked || 0, LEVELS.length);
        } else {
          p.unlocked = Math.max(p.unlocked || 0, Math.min(levelIdx + 1, mainN));
          if (lastMain && allMainStelesRead() && hIdx >= 0) {
            p.unlocked = Math.max(p.unlocked, hIdx + 1);
          }
        }
      }
      const rec = p.records[levelIdx] || (p.records[levelIdx] = {});
      rec.stars = Math.max(rec.stars || 0, starNum);
      rec.switches = (rec.switches == null) ? M : Math.min(rec.switches, M);
      rec.keys = Math.max(rec.keys || 0, state.keys);
    });
    document.getElementById('win-record').textContent = improved
      ? '✦ 新纪录！已同步' + (Auth.isOnline() && Auth.user ? '到云端存档' : '到本机存档') : '';
    const nextBtn = document.getElementById('btn-next');
    if (slaughterClear) nextBtn.textContent = '重选模式';
    else if (isSlaughter()) nextBtn.textContent = '← 上一章';
    else if (curLevel.hidden) nextBtn.textContent = '回到试验场';
    else if (hiddenOpen) nextBtn.textContent = '进入隐藏回廊 →';
    else if (lastMain) nextBtn.textContent = '重新开始';
    else nextBtn.textContent = '下一章 →';
    setTimeout(() => {
      const winEl = document.getElementById('win');
      winEl.classList.remove('hidden');
      winEl.style.pointerEvents = 'none';
      setTimeout(() => { winEl.style.pointerEvents = ''; }, 700);
    }, 850);
  }

  // ------------------------------------------------ HUD
  const aboutEl = document.getElementById('about');
  const levelsEl = document.getElementById('levels');
  let toastTimer = null;
  let steleTimer = null;
  let levelOpenTimer = null;

  function parseArchitectNote(raw) {
    const m = String(raw || '').match(/^建筑师留言[·・‧.]?\s*([^：:]+)[：:]\s*(.+)$/);
    if (m) return { num: m[1].trim(), body: m[2].trim() };
    return { num: '', body: String(raw || '').trim() };
  }

  function hideLevelOpener() {
    clearTimeout(levelOpenTimer);
    const el = document.getElementById('level-open');
    if (!el) return;
    el.classList.remove('show');
    levelOpenTimer = setTimeout(() => {
      if (!el.classList.contains('show')) el.hidden = true;
    }, 500);
  }

  /** 每关开局展示通关要领（不进石碑留言） */
  function showLevelOpener(level, ms) {
    const el = document.getElementById('level-open');
    const titleEl = document.getElementById('lo-title');
    const bodyEl = document.getElementById('lo-body');
    const kickEl = el && el.querySelector('.lo-kicker');
    if (!el || !bodyEl || !level) return;
    hideArchitectNote();
    hideToast();
    if (titleEl) titleEl.textContent = level.name || '';
    if (kickEl) kickEl.textContent = level.sandbox ? '机能自检清单' : '本章要领';
    el.classList.toggle('sandbox-check', !!level.sandbox);
    if (level.sandbox) {
      bodyEl.textContent = [
        '① 空格切俯视过青桥 · ② 假台 3D 可站、俯视即坠',
        '③ 拖齿轮 / 点转盘接通石桥 · ④ 咬合短臂随主轮反转',
        '⑤ 序星须按 ①→② 拾 · ⑥ 金桥留 3D 通碑',
        '⑦ Q/E：甲向假对齐、乙向真路 · ⑧ 南侧高差俯视攀',
        '⑨ WASD：A/D 转向、W/S 进退 · ⑩ 影怪与大剑（J）· 心与坠落'
      ].join('\n');
      ms = ms || 7800;
    } else {
      bodyEl.textContent = level.hint || '';
    }
    el.hidden = false;
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(levelOpenTimer);
    levelOpenTimer = setTimeout(hideLevelOpener, ms || 5200);
  }

  function hideArchitectNote() {
    clearTimeout(steleTimer);
    const el = document.getElementById('stele-note');
    if (!el) return;
    el.classList.remove('show');
    steleTimer = setTimeout(() => {
      if (!el.classList.contains('show')) el.hidden = true;
    }, 650);
  }

  function showArchitectNote(raw, ms) {
    const el = document.getElementById('stele-note');
    const numEl = document.getElementById('stele-num');
    const bodyEl = document.getElementById('stele-body');
    if (!el || !bodyEl) {
      toast(raw, ms || 5600);
      return;
    }
    hideToast();
    hideLevelOpener();
    const parsed = parseArchitectNote(raw);
    if (numEl) numEl.textContent = parsed.num ? ('· ' + parsed.num + ' ·') : '';
    bodyEl.textContent = parsed.body;
    el.hidden = false;
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(steleTimer);
    steleTimer = setTimeout(hideArchitectNote, ms || 7200);
  }

  function toast(msg, ms, type) {
    hideArchitectNote();
    hideLevelOpener();
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('toast-good', 'toast-warn');
    if (type === 'good') el.classList.add('toast-good');
    if (type === 'warn') el.classList.add('toast-warn');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2600);
  }
  function hideToast() { clearTimeout(toastTimer); document.getElementById('toast').classList.remove('show'); }

  function getUnlocked() {
    return Math.min(Math.max((Auth.progress && Auth.progress.unlocked) || 0, 0), LEVELS.length);
  }
  function isSandboxLevel(L) {
    return !!(L && L.sandbox);
  }
  /** 正篇第一章下标（跳过第 0 关试验场） */
  function firstStoryIdx() {
    for (let i = 0; i < LEVELS.length; i++) {
      if (!LEVELS[i].hidden && !LEVELS[i].sandbox) return i;
    }
    return 0;
  }
  function lastStoryIdx() {
    let last = 0;
    for (let i = 0; i < LEVELS.length; i++) {
      if (!LEVELS[i].hidden && !LEVELS[i].sandbox) last = i;
    }
    return last;
  }
  /** HUD / 目录编号：试验场 00 · 正篇 01… · 外章「外」 */
  function levelDisplayNum(i) {
    const L = LEVELS[i];
    if (!L) return '--';
    if (L.hidden) return '外';
    if (L.sandbox) return '00';
    return String(i - firstStoryIdx() + 1).padStart(2, '0');
  }
  function mainLevelCount() {
    let n = 0;
    for (let i = 0; i < LEVELS.length; i++) if (!LEVELS[i].hidden) n++;
    return n;
  }
  function hiddenLevelIdx() {
    for (let i = 0; i < LEVELS.length; i++) if (LEVELS[i].hidden) return i;
    return -1;
  }
  function steleId(li, text) {
    const m = String(text || '').match(/留言[·・‧.]?\s*([^：:]+)/);
    return 'L' + li + ':' + (m ? m[1].trim() : String(text || 'x').slice(0, 12));
  }
  function catalogMainSteles() {
    const out = [];
    for (let i = 0; i < LEVELS.length; i++) {
      // 第 0 关试验场 / 外章不计入正篇碑录
      if (LEVELS[i].hidden || LEVELS[i].sandbox) continue;
      for (const nd of LEVELS[i].nodes || []) {
        if (!nd.stele) continue;
        out.push({ id: steleId(i, nd.stele), level: i, text: nd.stele, name: LEVELS[i].name });
      }
    }
    return out;
  }
  function readSteleSet() {
    return (Auth.progress && Auth.progress.steles) || {};
  }
  function steleStats() {
    const cat = catalogMainSteles();
    const have = readSteleSet();
    let n = 0;
    for (const s of cat) if (have[s.id]) n++;
    return { read: n, total: cat.length, cat: cat, have: have };
  }
  function allMainStelesRead() {
    const s = steleStats();
    return s.total > 0 && s.read >= s.total;
  }
  function canPlayHidden() {
    return hiddenLevelIdx() >= 0 && getUnlocked() >= mainLevelCount() && allMainStelesRead();
  }
  function maxPlayableIdx() {
    const mainN = mainLevelCount();
    if (isSlaughter()) return Math.max(0, mainN - 1);
    const h = hiddenLevelIdx();
    if (h >= 0 && canPlayHidden()) return h;
    return Math.min(getUnlocked(), mainN - 1);
  }
  function markSteleRead(id) {
    Auth.commit(p => {
      p.steles = p.steles || {};
      p.steles[id] = true;
      const mainN = mainLevelCount();
      const hIdx = hiddenLevelIdx();
      if (hIdx >= 0 && (p.unlocked || 0) >= mainN) {
        const cat = catalogMainSteles();
        let ok = cat.length > 0;
        for (const s of cat) if (!p.steles[s.id]) { ok = false; break; }
        if (ok) p.unlocked = Math.max(p.unlocked || 0, hIdx + 1);
      }
    });
  }

  function hexRgb(c) {
    return Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255);
  }

  /** 按关卡主题色同步 HUD / 石碑 / 开局要领配色 */
  function applyUiTheme(level) {
    if (!level) return;
    const bg = new THREE.Color(level.bg);
    const pal = level.pal || {};
    const side = new THREE.Color(pal.side != null ? pal.side : 0x888888);
    const top = new THREE.Color(pal.top != null ? pal.top : 0xf5f0e6);
    const accent = new THREE.Color(pal.accent != null ? pal.accent : 0x3fbfae);
    const goal = new THREE.Color(pal.goal != null ? pal.goal : 0xe8b84b);
    const lum = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b;
    const dark = lum < 0.45;

    const panel = bg.clone();
    if (dark) panel.lerp(side, 0.28).lerp(new THREE.Color(0x0a0e16), 0.32);
    else panel.lerp(new THREE.Color(0xffffff), 0.48).lerp(side, 0.16).lerp(top, 0.08);

    const panelHover = panel.clone();
    if (dark) panelHover.offsetHSL(0, 0.06, 0.12);
    else panelHover.lerp(new THREE.Color(0xffffff), 0.35);

    const stele = bg.clone();
    if (dark) stele.lerp(side, 0.3).lerp(new THREE.Color(0x12141c), 0.35);
    else stele.lerp(top, 0.42).lerp(side, 0.12).lerp(new THREE.Color(0xfffaf2), 0.2);

    const modeBtn = side.clone();
    if (dark) modeBtn.lerp(bg, 0.2).lerp(new THREE.Color(0x1a1c24), 0.18);
    else modeBtn.lerp(new THREE.Color(0x2a2620), 0.28);
    const modeLum = 0.2126 * modeBtn.r + 0.7152 * modeBtn.g + 0.0722 * modeBtn.b;
    const modeText = modeLum < 0.55 ? new THREE.Color(0xfdf8ec) : new THREE.Color(0x1c1a22);

    const text = dark ? new THREE.Color(0xf3efe6) : new THREE.Color(0x2d2a33);
    const muted = dark ? new THREE.Color(0xc9c3b6) : new THREE.Color(0x6b6455);

    const root = document.documentElement;
    const set = (k, v) => root.style.setProperty(k, v);
    const aPanel = dark ? 0.74 : 0.7;
    const aHover = dark ? 0.92 : 0.94;
    set('--ui-bg', '#' + bg.getHexString());
    set('--ui-side', '#' + side.getHexString());
    set('--ui-top', '#' + top.getHexString());
    set('--ui-accent', '#' + accent.getHexString());
    set('--ui-goal', '#' + goal.getHexString());
    set('--ui-panel', 'rgba(' + hexRgb(panel) + ',' + aPanel + ')');
    set('--ui-panel-hover', 'rgba(' + hexRgb(panelHover) + ',' + aHover + ')');
    set('--ui-panel-solid', '#' + stele.getHexString());
    set('--ui-border', 'rgba(' + hexRgb(side) + ',' + (dark ? 0.42 : 0.22) + ')');
    set('--ui-text', '#' + text.getHexString());
    set('--ui-muted', 'rgba(' + hexRgb(muted) + ',' + (dark ? 0.72 : 0.78) + ')');
    set('--ui-mode', '#' + modeBtn.getHexString());
    set('--ui-mode-text', '#' + modeText.getHexString());
    set('--ui-mode-2d', '#' + accent.getHexString());
    set('--ui-divider', 'rgba(' + hexRgb(side) + ',' + (dark ? 0.38 : 0.2) + ')');
    set('--ui-shadow', dark ? 'rgba(0,0,0,.28)' : 'rgba(20,15,35,.1)');
    set('--ui-stele-border', 'rgba(' + hexRgb(goal) + ',' + (dark ? 0.38 : 0.3) + ')');
    set('--ui-stele-accent', '#' + goal.getHexString());
    set('--ui-stele-kicker', 'rgba(' + hexRgb(goal) + ',.78)');
    set('--ui-focus', '#' + accent.getHexString());
    set('--ui-keys', '#' + goal.getHexString());
    set('--ui-overlay', dark ? 'rgba(8,10,16,.55)' : 'rgba(22,16,28,.38)');
    set('--ui-card', '#' + stele.getHexString());
    set('--ui-card-border', 'rgba(' + hexRgb(side) + ',' + (dark ? 0.35 : 0.16) + ')');
    set('--ui-primary', '#' + modeBtn.getHexString());
    set('--ui-primary-text', '#' + modeText.getHexString());

    document.body.classList.toggle('hud-dark', dark);
  }

  function applyHudTheme(bg) {
    // 兼容旧调用：仅切换明暗；完整主题走 applyUiTheme
    const c = new THREE.Color(bg);
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    document.body.classList.toggle('hud-dark', lum < 0.45);
  }

  /** 把关卡底色展开成缓动天空的多层配色，并同步 UI 主题 */
  function setSkyTheme(bg) {
    const base = new THREE.Color(bg);
    const hi = base.clone().offsetHSL(0.01, 0.06, 0.1);
    const deep = base.clone().offsetHSL(-0.02, 0.04, -0.1);
    const glow = base.clone().offsetHSL(0.04, 0.18, 0.16);
    const blush = base.clone().offsetHSL(-0.06, 0.14, 0.08);
    const mist = base.clone().offsetHSL(0.08, -0.05, 0.18);
    const lum = 0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b;
    const sky = document.getElementById('sky');
    if (sky) {
      sky.style.setProperty('--sky-base', '#' + base.getHexString());
      sky.style.setProperty('--sky-hi', '#' + hi.getHexString());
      sky.style.setProperty('--sky-deep', '#' + deep.getHexString());
      sky.style.setProperty('--sky-glow', 'rgba(' + Math.round(glow.r * 255) + ',' + Math.round(glow.g * 255) + ',' + Math.round(glow.b * 255) + ',' + (lum < 0.45 ? 0.38 : 0.55) + ')');
      sky.style.setProperty('--sky-blush', 'rgba(' + Math.round(blush.r * 255) + ',' + Math.round(blush.g * 255) + ',' + Math.round(blush.b * 255) + ',' + (lum < 0.45 ? 0.32 : 0.48) + ')');
      sky.style.setProperty('--sky-mist', 'rgba(' + Math.round(mist.r * 255) + ',' + Math.round(mist.g * 255) + ',' + Math.round(mist.b * 255) + ',' + (lum < 0.45 ? 0.28 : 0.4) + ')');
      sky.style.setProperty('--sky-veil', lum < 0.45 ? 'rgba(180,200,230,.18)' : 'rgba(255,255,255,.22)');
      sky.style.setProperty('--sky-spark', lum < 0.45 ? 'rgba(220,235,255,.65)' : 'rgba(255,255,255,.7)');
    }
    document.body.style.background = '#' + base.getHexString();
    if (curLevel) applyUiTheme(curLevel);
    else applyHudTheme(bg);
  }

  function refreshHUD() {
    document.getElementById('ch-name').textContent = curLevel.name;
    const sub = document.getElementById('ch-sub');
    if (sub) sub.textContent = curLevel.sub;
    const idxEl = document.getElementById('ch-index');
    if (idxEl) idxEl.textContent = levelDisplayNum(levelIdx);
    document.getElementById('hint').textContent = curLevel.hint;
    for (let y = 0; y <= 2; y++) {
      const el = document.getElementById('chip' + y);
      if (el) el.style.background = topColorFor(y);
    }
    const pmTag = document.getElementById('play-mode-tag');
    if (pmTag) {
      if (playMode) {
        pmTag.hidden = false;
        if (isSlaughter()) {
          pmTag.textContent = '屠戮';
          pmTag.classList.add('slaughter');
        } else if (isSandboxNow()) {
          pmTag.textContent = '试验';
          pmTag.classList.remove('slaughter');
        } else {
          pmTag.textContent = '观光';
          pmTag.classList.remove('slaughter');
        }
      } else {
        pmTag.hidden = true;
      }
    }
    updateHUD();
    renderDots();
    updateSlaughterTimerUi();
  }
  let hurtTimer = null;
  let hurtDoneTimer = null;
  let hurtTauntSeq = 0;
  let lastTauntLine = '';

  // ---------- 扣血嘲讽：按伤害档位拼句 · 每人种子不同 · 每次掉血只吐槽一句 ----------
  function playerCallName() {
    if (Auth.user && Auth.user.username) return Auth.user.username;
    try {
      let g = localStorage.getItem('pc_guest_nick');
      if (!g) {
        const tags = ['过客', '无名', '旅人', '影行人', '迷途者', '回廊客'];
        g = tags[(Math.random() * tags.length) | 0] + String(1000 + ((Math.random() * 9000) | 0));
        localStorage.setItem('pc_guest_nick', g);
      }
      return g;
    } catch (e) {
      return '旅人';
    }
  }
  function playerTauntSalt() {
    try {
      if (Auth.user && Auth.user.username) {
        const want = 'u:' + Auth.user.username;
        localStorage.setItem('pc_taunt_salt', want);
        return want;
      }
      let s = localStorage.getItem('pc_taunt_salt');
      if (!s || s.indexOf('u:') === 0) {
        s = 'g:' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        localStorage.setItem('pc_taunt_salt', s);
      }
      return s;
    } catch (e) {
      return 'g:anon';
    }
  }
  function hashStr(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pickArr(rng, arr) {
    return arr[(rng() * arr.length) | 0];
  }

  // 碎片库：按「扣完还剩几心」与死因拼装，组合空间大，热句不易撞车
  const TAUNT_BITS = {
    mid2: {
      open: [
        '{n}，', '喂，{n}，', '瞧，{n}——', '不好意思，{n}，',
        '回廊播报：{n}，', '影怪点评：{n}，', '真人秀开场：{n}，'
      ],
      foe: [
        '才掉一颗心就晃成这样？',
        '大剑是装饰品吗？',
        '第一滴血已经被人记住味道了。',
        '侧翼有影你看不见？观光的吧。',
        '恭喜开张：被走廊里的影子开学了。',
        '你的心比走位还软。',
        '影怪说：就这？再来。',
        '咬一口就退半步，表演欲挺强。',
        '血条才晃一下，表情先碎了。',
        '这口伤写着：新手欢迎礼。'
      ],
      fall: [
        '重力提醒你：脚下是空的。',
        '踏空了。视角切错还不承认？',
        '以为自己会飞？回廊不卖翅膀。',
        '地板拒绝了你的信任。',
        '下一脚请先看色差再跳。',
        '坠落成绩优秀，可以再来一次。',
        '与虚空握手了。亲切吗？',
        '这一脚，把自信也带下去了。',
        '空中姿态挺美，落地成绩为零。',
        '解谜还没开始，自由落体先打卡。'
      ],
      sting: [
        '还剩 {r} 颗心，别浪。',
        '−1，账记在你头上。',
        '伤害不大，羞辱刚好。',
        '热评：走位像观光团。',
        '实时吐槽已送达。'
      ]
    },
    mid1: {
      open: [
        '{n}，', '危，{n}——', '最后通牒：{n}，',
        '影怪低语：{n}，', '只剩一口气了，{n}，', '警告 {n}：'
      ],
      foe: [
        '只剩一颗心了——影怪在笑。',
        '两刀都砍不中，是来喂影的吗？',
        '再不挥剑，第三口就到餐点了。',
        '影怪已经把你当软柿子。',
        '血条在写遗书，你还在发呆？',
        '最后一颗心，别让它白亮着。',
        '再慢一点更好吃。',
        'J 键是不是坏了？还是胆子坏了？',
        '第二口下去，第三口在排队。',
        '你的剑光比你的借口还短。'
      ],
      fall: [
        '又摔？只剩一颗心，当蹦床呢？',
        '两连坠，回廊认证自由落体选手。',
        '俯视与 3D 不是用来跳水的。',
        '请珍惜脚下的实体。',
        '人生信条：先掉下去，再谈解谜。',
        '影都懒得追，你自己往下跳。佩服。',
        '第二颗心交给虚空了，还差一颗。',
        '落地前请确认：这是解谜，不是跳水。'
      ],
      sting: [
        '还剩 {r} 颗心——下一刀就是终章。',
        '−1，危险档。别再送。',
        '热评：血厚不如脑快。',
        '实时更新：濒死表演进行中。',
        '羞辱升级，伤害如实。'
      ]
    },
    empty: {
      open: [
        '{n}，', '寄了，{n}。', '零心通报：{n}，',
        '屠戮失败报告：{n}，', '回廊公告：{n}，', '影怪鼓掌：{n}，'
      ],
      foe: [
        '三心清空。影怪用餐结束，本章重开。',
        '影怪甚至没出全力。',
        '你的心脏订阅已到期——请重开本章。',
        '死因：嘴硬手慢。',
        '成为影怪的今日最佳饲料。',
        '回廊为你准备了「再来一次」。',
        '表演很完整：从满心到空心。',
        '三口咬完，连谢幕都省了。',
        '本章结算：影 1，你 0。'
      ],
      fall: [
        '摔没了三颗心。重力：MVP。',
        '空心了。本章重置——脚别再叛变。',
        '用坠落写完了三幕悲剧。重来吧。',
        '对虚空的爱太深了。',
        '解谜之前请先学会站稳。',
        '因连续踏空被请回起点。',
        '自由落体三连，成就解锁。',
        '地面已拉黑你的好友申请。'
      ],
      sting: [
        '伤害结算：三心归零。',
        '热评置顶：重开是礼貌。',
        '实时终章：下一局别再演。',
        '−3 累计完成，章节重置。',
        '嘲讽已送达，进度已清零。'
      ]
    }
  };

  function hurtTier(remain) {
    if (remain <= 0) return 'empty';
    if (remain === 1) return 'mid1';
    return 'mid2';
  }

  function makeTauntRng(remain, cause, tick) {
    const salt = playerTauntSalt();
    const seed = (
      hashStr(salt) ^
      Math.imul(hurtTauntSeq, 2654435761) ^
      Math.imul((tick | 0) + 1, 1597334677) ^
      Math.imul(remain + 5, 40503) ^
      (Date.now() & 0xfffffff) ^
      hashStr(cause || 'foe') ^
      hashStr(playerCallName())
    ) >>> 0;
    return mulberry32(seed);
  }

  function craftHurtTaunt(remain, cause, tick) {
    const tier = hurtTier(remain);
    const bits = TAUNT_BITS[tier] || TAUNT_BITS.mid2;
    const causePool = (cause === 'fall') ? bits.fall : bits.foe;
    const name = playerCallName();
    const salt = playerTauntSalt();
    const vibe = hashStr(salt + ':' + tier) % 5;
    const vibes = ['', '（专属吐槽已绑定账号）', '', '——写给你看的。', ''];
    let line = '';
    for (let attempt = 0; attempt < 6; attempt++) {
      const rng = makeTauntRng(remain, cause, (tick | 0) + attempt * 97);
      const style = (rng() * 3) | 0;
      if (style === 0) {
        line = pickArr(rng, bits.open) + pickArr(rng, causePool);
      } else if (style === 1) {
        line = pickArr(rng, causePool) + ' ' + pickArr(rng, bits.sting);
      } else {
        line = pickArr(rng, bits.open) + pickArr(rng, causePool) + ' ' + pickArr(rng, bits.sting);
      }
      if (vibes[vibe] && rng() > 0.55) line += vibes[vibe];
      line = line
        .split('{n}').join(name)
        .split('{r}').join(String(Math.max(0, remain)))
        .replace(/\s+/g, ' ')
        .trim();
      if (line !== lastTauntLine) break;
    }
    lastTauntLine = line;
    return line;
  }

  function stopTauntCycle() {
    /* 重置关卡时仍会调用；嘲讽已改为单次显示，无需清定时器 */
  }

  function paintTauntLine(el, text) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove('tick');
    void el.offsetWidth;
    el.classList.add('tick');
  }

  function startTauntHotline(remain, cause) {
    hurtTauntSeq++;
    const el = document.getElementById('hurt-taunt');
    const line = craftHurtTaunt(remain, cause, 0);
    paintTauntLine(el, line);
    return line;
  }

  function showLifeLoss(remain, opts) {
    opts = opts || {};
    const emptied = remain <= 0;
    const cause = opts.cause === 'fall' ? 'fall' : 'foe';
    const fx = document.getElementById('hurt-fx');
    const msg = document.getElementById('hurt-msg');
    const tauntEl = document.getElementById('hurt-taunt');
    const remainEl = document.getElementById('hurt-remain');
    const livesEl = document.getElementById('stat-lives');
    const lost = Math.max(1, (opts.damage != null ? opts.damage : 1) | 0);
    const headline = emptied
      ? '三心耗尽'
      : (cause === 'fall' ? ('踏空坠落 · −' + lost) : ('被影咬伤 · −' + lost));
    if (msg) msg.textContent = headline;
    const deltaEl = fx && fx.querySelector('.hurt-delta');
    if (deltaEl) deltaEl.textContent = '−' + lost;
    const firstTaunt = startTauntHotline(remain, cause);
    if (tauntEl && !firstTaunt) tauntEl.textContent = '';
    if (remainEl) {
      let h = '';
      const n = emptied ? 0 : remain;
      for (let i = 0; i < MAX_LIVES; i++) h += '<span class="' + (i < n ? 'on' : '') + '">♥</span>';
      remainEl.innerHTML = h;
    }
    if (livesEl) {
      livesEl.classList.remove('hurt');
      void livesEl.offsetWidth;
      livesEl.classList.add('hurt');
      const hs = livesEl.querySelectorAll('.heart');
      if (emptied) hs.forEach(el => el.classList.add('just-lost'));
      else if (hs[remain]) hs[remain].classList.add('just-lost');
    }
    if (fx) {
      fx.hidden = false;
      fx.classList.remove('show', 'out', 'empty');
      void fx.offsetWidth;
      fx.classList.add('show');
      if (emptied) fx.classList.add('empty');
    }
    flash(emptied ? '#4a0810' : '#c41e32');
    document.body.classList.remove('hurt-shake');
    void document.body.offsetWidth;
    document.body.classList.add('hurt-shake');
    clearTimeout(hurtTimer);
    clearTimeout(hurtDoneTimer);
    hurtDoneTimer = null;
    const hold = opts.holdMs != null ? opts.holdMs : (emptied ? 2800 : 2600);
    hurtTimer = setTimeout(() => {
      hurtTimer = null;
      stopTauntCycle();
      if (fx) {
        fx.classList.remove('show');
        fx.classList.add('out');
      }
      document.body.classList.remove('hurt-shake');
      hurtDoneTimer = setTimeout(() => {
        hurtDoneTimer = null;
        if (fx) { fx.hidden = true; fx.classList.remove('out', 'empty'); }
        if (livesEl) livesEl.classList.remove('hurt');
        if (opts.onDone) opts.onDone();
      }, 380);
    }, hold);
    return firstTaunt || '';
  }

  function pulseHudHearts() {
    const livesEl = document.getElementById('stat-lives');
    if (!livesEl) return;
    livesEl.classList.remove('hurt');
    void livesEl.offsetWidth;
    livesEl.classList.add('hurt');
    const hs = livesEl.querySelectorAll('.heart');
    if (lives <= 0) hs.forEach(el => el.classList.add('just-lost'));
    else if (hs[lives]) hs[lives].classList.add('just-lost');
  }

  function updateHUD() {
    document.getElementById('stat-switch').textContent = '↺ ' + state.switchCount;
    const livesEl = document.getElementById('stat-lives');
    if (livesEl) {
      const showLives = combatEnabled();
      livesEl.hidden = !showLives;
      const div = livesEl.nextElementSibling;
      if (div && div.classList.contains('stat-div')) div.hidden = !showLives;
      if (showLives) {
        let h = '';
        for (let i = 0; i < MAX_LIVES; i++) h += '<span class="heart' + (i < lives ? ' on' : '') + '">♥</span>';
        livesEl.innerHTML = h;
        livesEl.title = isSandboxNow() && !isSlaughter()
          ? '试验场：坠落/影怪扣心（等同屠戮机能）'
          : '生命（坠落会失去一条并重开本章）';
      } else {
        livesEl.innerHTML = '';
        livesEl.title = '观光模式无血量限制';
      }
    }
    document.getElementById('stat-keys').textContent = levelKeyOrder() && keysTotal
      ? ('序 ✦ ' + state.keys + '/' + keysTotal + (state.keys < keysTotal ? ' ·下一' + (state.keys + 1) : ''))
      : ('✦ ' + state.keys + '/' + keysTotal);
    document.getElementById('stat-keys').style.opacity = keysTotal ? 1 : 0.35;
    const stEl = document.getElementById('stat-steles');
    if (stEl) {
      const st = steleStats();
      stEl.textContent = '◈ ' + st.read + '/' + st.total;
      stEl.style.opacity = st.total ? 1 : 0.35;
    }
  }
  function renderDots() {
    const dots = document.getElementById('dots');
    dots.innerHTML = '';
    const unlocked = getUnlocked();
    const playable = maxPlayableIdx();
    const mainN = mainLevelCount();
    for (let i = 0; i < LEVELS.length; i++) {
      if (LEVELS[i].hidden && (isSlaughter() || !canPlayHidden())) continue;
      const d = document.createElement('div');
      const done = isSlaughter()
        ? i >= levelIdx
        : (LEVELS[i].hidden ? unlocked >= LEVELS.length : i < Math.min(unlocked, mainN));
      d.className = 'dot' + (i <= playable ? ' unlocked' : '') + (i === levelIdx ? ' current' : '') + (done ? ' done' : '') + (LEVELS[i].hidden ? ' secret' : '');
      const poem = levelPoem(LEVELS[i]);
      d.title = LEVELS[i].name + (poem ? '\n' + poem : '');
      if (i <= playable) d.addEventListener('click', () => loadLevel(i));
      dots.appendChild(d);
    }
  }

  // 章节目录面板
  function renderLevelPanel() {
    const grid = document.getElementById('levels-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const unlocked = getUnlocked();
    const playable = maxPlayableIdx();
    const records = (Auth.progress && Auth.progress.records) || {};
    const meta = document.getElementById('levels-meta');
    const mainN = mainLevelCount();
    const showHidden = !isSlaughter() && canPlayHidden();
    if (meta) {
      let cleared = 0;
      for (let i = 0; i < LEVELS.length; i++) {
        if (LEVELS[i].hidden || LEVELS[i].sandbox) continue;
        if ((records[i] || {}).stars) cleared++;
      }
      if (isSlaughter()) {
        meta.textContent = '屠戮倒行　本章 ' + levelDisplayNum(levelIdx) + ' / ' +
          String(lastStoryIdx() - firstStoryIdx() + 1).padStart(2, '0') +
          '　·　限时回到第一章（试验场不计入）';
      } else {
        const st = steleStats();
        const storyN = lastStoryIdx() - firstStoryIdx() + 1;
        const playStory = Math.max(0, Math.min(playable, lastStoryIdx()) - firstStoryIdx() + 1);
        meta.textContent = '正篇 ' + playStory + ' / ' + storyN +
          '　·　已通关 ' + cleared +
          '　·　留言 ' + st.read + ' / ' + st.total +
          '　·　含第 0 关试验场';
      }
    }
    const log = document.getElementById('stele-log');
    if (log) {
      if (isSlaughter()) {
        log.innerHTML = '<div class="sl-head">屠戮模式</div>' +
          '<div class="sl-row on">出生与终点对调 · 佩剑斩影</div>' +
          '<div class="sl-foot">全局限时 5 分钟回到并完成第一章</div>';
      } else {
        const st = steleStats();
        let html = '<div class="sl-head">建筑师留言　' + st.read + ' / ' + st.total + '</div>';
        for (const s of st.cat) {
          const ok = !!st.have[s.id];
          const parsed = parseArchitectNote(s.text);
          const title = (LEVELS[s.level].name || '').replace(/^第.+章 · /, '').replace(/^第零关 · /, '');
          const snippet = ok && parsed.body
            ? ('<div class="sl-quote">「' + parsed.body.slice(0, 28) + (parsed.body.length > 28 ? '…' : '') + '」</div>')
            : '';
          html += '<div class="sl-row' + (ok ? ' on' : '') + '">' +
            (ok ? '◈ ' : '◇ ') + title +
            (ok ? '' : '　未读') + snippet + '</div>';
        }
        if (showHidden) html += '<div class="sl-foot">碑文齐备 · 隐藏外章已开</div>';
        log.innerHTML = html;
      }
    }
    for (let i = 0; i < LEVELS.length; i++) {
      if (LEVELS[i].hidden && !showHidden) continue;
      const rec = records[i] || {};
      const item = document.createElement('div');
      const locked = i > playable;
      const stars = rec.stars || 0;
      item.className = 'lv-item' + (locked ? ' locked' : '') + (i === levelIdx ? ' current' : '') + (stars ? ' cleared' : '') + (LEVELS[i].hidden ? ' secret' : '') + (LEVELS[i].sandbox ? ' sandbox' : '');
      const short = LEVELS[i].hidden
        ? LEVELS[i].name
        : LEVELS[i].name.replace(/^第.+关 · /, '').replace(/^第.+章 · /, '');
      item.innerHTML =
        '<div class="lv-num">' + levelDisplayNum(i) + '</div>' +
        '<div class="lv-name">' + short + '</div>' +
        '<div class="lv-poem"><span>' + levelPoem(LEVELS[i]) + '</span></div>' +
        '<div class="lv-stars">' + (locked
          ? '<span class="lv-locked-txt">未解锁</span>'
          : [0, 1, 2].map(s => '<span class="' + (s < stars ? 'on' : 'dim') + '">★</span>').join('')) + '</div>' +
        (locked ? '<div class="lv-lock">🔒</div>' : '');
      item.title = LEVELS[i].name + '\n' + levelPoem(LEVELS[i]);
      if (i <= playable) item.addEventListener('click', () => { hideLevels(); loadLevel(i); });
      grid.appendChild(item);
    }
  }
  function showLevels() { renderLevelPanel(); levelsEl.classList.remove('hidden'); }
  function hideLevels() { levelsEl.classList.add('hidden'); }

  function restartLevel() {
    document.getElementById('win').classList.add('hidden');
    const sf = document.getElementById('slaughter-fail');
    if (sf) sf.classList.add('hidden');
    state.won = false;
    slaughterFailed = false;
    pauseSlaughterTimer(false);
    loadLevel(levelIdx);
  }
  function hideAbout() { aboutEl.classList.add('hidden'); }

  document.getElementById('btn-mode').addEventListener('click', () => toggleMode());
  const yawCcw = document.getElementById('btn-yaw-ccw');
  const yawCw = document.getElementById('btn-yaw-cw');
  if (yawCcw) yawCcw.addEventListener('click', () => rotateView(-1));
  if (yawCw) yawCw.addEventListener('click', () => rotateView(1));
  document.getElementById('btn-restart').addEventListener('click', restartLevel);
  document.getElementById('btn-about').addEventListener('click', () => aboutEl.classList.remove('hidden'));
  document.getElementById('btn-close-about').addEventListener('click', hideAbout);
  document.getElementById('btn-levels').addEventListener('click', showLevels);
  document.getElementById('btn-close-levels').addEventListener('click', hideLevels);
  document.getElementById('btn-mute').addEventListener('click', toggleMute);
  const volSlider = document.getElementById('vol-slider');
  if (volSlider) {
    volSlider.value = '10';
    const volLab = document.getElementById('vol-value');
    if (volLab) volLab.textContent = '10';
    const onVolInput = () => {
      initAudio();
      setVolume(parseInt(volSlider.value, 10) / 100, { unmute: true, instant: true });
    };
    volSlider.addEventListener('input', onVolInput);
    volSlider.addEventListener('change', onVolInput);
  }
  const gfxSelect = document.getElementById('gfx-select');
  if (gfxSelect) {
    gfxSelect.value = gfxPref;
    gfxSelect.addEventListener('change', () => setGfxQuality(gfxSelect.value));
  }
  syncGfxUi();
  syncMuteUi();
  document.getElementById('btn-again').addEventListener('click', restartLevel);
  document.getElementById('btn-next').addEventListener('click', () => {
    document.getElementById('win').classList.add('hidden');
    state.won = false;
    const mainN = mainLevelCount();
    const hIdx = hiddenLevelIdx();
    if (isSlaughter()) {
      if (levelIdx <= firstStoryIdx()) {
        showModePick();
        return;
      }
      pauseSlaughterTimer(false);
      loadLevel(levelIdx - 1);
      return;
    }
    let next;
    if (curLevel.hidden) next = 0;
    else if (levelIdx >= mainN - 1) next = (canPlayHidden() && hIdx >= 0) ? hIdx : 0;
    else next = levelIdx + 1;
    loadLevel(next);
  });
  const btnSfRetry = document.getElementById('btn-sf-retry');
  if (btnSfRetry) btnSfRetry.addEventListener('click', () => startSlaughterRun());
  const btnSfMode = document.getElementById('btn-sf-mode');
  if (btnSfMode) btnSfMode.addEventListener('click', () => {
    const sf = document.getElementById('slaughter-fail');
    if (sf) sf.classList.add('hidden');
    showModePick();
  });
  aboutEl.addEventListener('click', e => { if (e.target === aboutEl) hideAbout(); });
  levelsEl.addEventListener('click', e => { if (e.target === levelsEl) hideLevels(); });
  document.getElementById('win').addEventListener('click', e => {
    if (e.target === e.currentTarget) {
      e.currentTarget.classList.add('hidden');
      if (isSlaughter() && !slaughterFailed) pauseSlaughterTimer(false);
    }
  });
  try { syncMuteUi(); } catch (e) { }

  // ---------- 模式选择 / 屠戮计时 ----------
  function formatTimer(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ':' + String(r).padStart(2, '0');
  }
  function updateSlaughterTimerUi() {
    const el = document.getElementById('stat-timer');
    const div = document.getElementById('stat-timer-div');
    if (!el) return;
    if (!isSlaughter() || !slaughterEndsAt) {
      el.hidden = true;
      if (div) div.hidden = true;
      return;
    }
    el.hidden = false;
    if (div) div.hidden = false;
    let left;
    if (slaughterTimerPaused) left = slaughterPauseLeft;
    else if (slaughterFreezeAt) left = Math.max(0, slaughterEndsAt - slaughterFreezeAt);
    else left = Math.max(0, slaughterEndsAt - performance.now());
    el.textContent = '⏱ ' + formatTimer(left);
    el.classList.toggle('warn', left <= 60000 && left > 20000);
    el.classList.toggle('critical', left <= 20000);
  }
  function pauseSlaughterTimer(on) {
    if (!isSlaughter() || !slaughterEndsAt) return;
    if (on && !slaughterTimerPaused) {
      const now = slaughterFreezeAt || performance.now();
      slaughterPauseLeft = Math.max(0, slaughterEndsAt - now);
      slaughterTimerPaused = true;
      slaughterFreezeAt = 0;
    } else if (!on && slaughterTimerPaused) {
      slaughterEndsAt = performance.now() + slaughterPauseLeft;
      slaughterTimerPaused = false;
    }
    updateSlaughterTimerUi();
  }
  function tickSlaughterTimer() {
    if (!isSlaughter() || !slaughterEndsAt || slaughterFailed || state.won) return;
    const freeze = state.hurtPause || Auth.isActive() || isModePickOpen() || isUiBlocking();
    if (freeze) {
      if (!slaughterTimerPaused && !slaughterFreezeAt) slaughterFreezeAt = performance.now();
      updateSlaughterTimerUi();
      return;
    }
    if (slaughterFreezeAt) {
      slaughterEndsAt += performance.now() - slaughterFreezeAt;
      slaughterFreezeAt = 0;
    }
    if (slaughterTimerPaused) {
      updateSlaughterTimerUi();
      return;
    }
    const left = slaughterEndsAt - performance.now();
    updateSlaughterTimerUi();
    if (left <= 0) onSlaughterTimeout();
  }
  function onSlaughterTimeout() {
    if (slaughterFailed) return;
    slaughterFailed = true;
    slaughterEndsAt = 0;
    cancelWalk({ silent: true });
    document.getElementById('win').classList.add('hidden');
    const sf = document.getElementById('slaughter-fail');
    if (sf) sf.classList.remove('hidden');
    toast('时限已至', 2800, 'warn');
    sfx.deny();
    updateSlaughterTimerUi();
  }
  function levelPoem(L) {
    if (!L) return '';
    return L.poem || L.story || L.hint || '';
  }
  function fillModePalette() {
    const box = document.getElementById('mp-palette');
    const tip = document.getElementById('mp-tip');
    const tipNum = document.getElementById('mp-tip-num');
    const tipK = document.getElementById('mp-tip-kicker');
    const tipN = document.getElementById('mp-tip-name');
    const tipP = document.getElementById('mp-tip-poem');
    const tipCaret = document.getElementById('mp-tip-caret');
    if (!box) return;
    if (box.childElementCount) return;
    const mainN = mainLevelCount();
    const idle = {
      num: '◈',
      kicker: 'SPECTRUM',
      name: '各章天光',
      poem: '悬停色块，聆听一章的气息',
      accent: '#c4a484'
    };
    let hideTipTimer = null;
    let swapTimer = null;
    let activeIdx = -1;

    function setTipContent(pack) {
      if (tipNum) tipNum.textContent = pack.num;
      if (tipK) tipK.textContent = pack.kicker;
      if (tipN) tipN.textContent = pack.name;
      if (tipP) tipP.textContent = pack.poem;
      if (tip) tip.style.setProperty('--tip-accent', pack.accent);
    }

    function placeCaret(sw) {
      if (!tip || !tipCaret || !sw) return;
      const tr = tip.getBoundingClientRect();
      const sr = sw.getBoundingClientRect();
      tipCaret.style.left = (sr.left + sr.width / 2 - tr.left) + 'px';
    }

    function showTip(L, sw, idx) {
      if (!tip || !L) return;
      clearTimeout(hideTipTimer);
      clearTimeout(swapTimer);
      box.querySelectorAll('.mp-swatch.is-hot').forEach(el => el.classList.remove('is-hot'));
      if (sw) sw.classList.add('is-hot');
      const accent = '#' + new THREE.Color(L.pal.side).getHexString();
      const pack = {
        num: levelDisplayNum(idx),
        kicker: L.sub || '',
        name: L.name || '',
        poem: levelPoem(L),
        accent: accent
      };
      const same = activeIdx === idx;
      activeIdx = idx;
      tip.dataset.state = 'hot';
      placeCaret(sw);
      if (same) {
        setTipContent(pack);
        return;
      }
      tip.classList.add('is-swap');
      swapTimer = setTimeout(() => {
        setTipContent(pack);
        tip.classList.remove('is-swap');
      }, 140);
    }

    function hideTip() {
      hideTipTimer = setTimeout(() => {
        clearTimeout(swapTimer);
        box.querySelectorAll('.mp-swatch.is-hot').forEach(el => el.classList.remove('is-hot'));
        if (!tip) return;
        activeIdx = -1;
        tip.classList.add('is-swap');
        swapTimer = setTimeout(() => {
          tip.dataset.state = 'idle';
          setTipContent(idle);
          tip.classList.remove('is-swap');
          if (tipCaret) tipCaret.style.left = '50%';
        }, 140);
      }, 120);
    }

    for (let i = 0; i < mainN; i++) {
      const L = LEVELS[i];
      if (!L || !L.pal) continue;
      const sw = document.createElement('div');
      const idx = i;
      sw.className = 'mp-swatch';
      sw.style.background = '#' + new THREE.Color(L.pal.side).getHexString();
      sw.dataset.n = levelDisplayNum(i);
      sw.setAttribute('role', 'button');
      sw.setAttribute('tabindex', '0');
      sw.setAttribute('aria-label', (L.name || '') + '：' + levelPoem(L));
      sw.addEventListener('mouseenter', () => showTip(L, sw, idx));
      sw.addEventListener('mouseleave', hideTip);
      sw.addEventListener('focus', () => showTip(L, sw, idx));
      sw.addEventListener('blur', hideTip);
      box.appendChild(sw);
    }
    setTipContent(idle);
    window.addEventListener('resize', () => {
      const hot = box.querySelector('.mp-swatch.is-hot');
      if (hot) placeCaret(hot);
    });
  }
  function showModePick() {
    // 受击冻结中改模式：先解除 timeScale / 定时器，避免世界一直停住
    try { gsap.globalTimeline.timeScale(1); } catch (e) { }
    state.hurtPause = false;
    if (typeof abortGearDrag === 'function') abortGearDrag(true);
    state.rotating = false;
    if (typeof hurtTimer !== 'undefined' && hurtTimer) { clearTimeout(hurtTimer); hurtTimer = null; }
    if (typeof hurtDoneTimer !== 'undefined' && hurtDoneTimer) { clearTimeout(hurtDoneTimer); hurtDoneTimer = null; }
    const hurtFx = document.getElementById('hurt-fx');
    if (hurtFx) {
      hurtFx.hidden = true;
      hurtFx.classList.remove('show', 'out', 'empty');
    }
    document.body.classList.remove('hurt-shake');
    fillModePalette();
    playMode = null;
    slaughterEndsAt = 0;
    slaughterFailed = false;
    slaughterTimerPaused = false;
    slaughterFreezeAt = 0;
    const sf = document.getElementById('slaughter-fail');
    if (sf) sf.classList.add('hidden');
    document.getElementById('win').classList.add('hidden');
    hideLevels();
    hideAbout();
    const el = document.getElementById('mode-pick');
    if (el) el.classList.remove('hidden');
    document.body.classList.add('mode-pick-open');
    updateSlaughterTimerUi();
    const pmTag = document.getElementById('play-mode-tag');
    if (pmTag) pmTag.hidden = true;
    syncControlUi();
  }
  function hideModePick() {
    const el = document.getElementById('mode-pick');
    if (el) el.classList.add('hidden');
    document.body.classList.remove('mode-pick-open');
  }
  function startTourRun() {
    playMode = 'tour';
    slaughterEndsAt = 0;
    slaughterFailed = false;
    hideModePick();
    updateControlCredits();
    loadLevel(0);
    toast('观光模式 · 从第 0 关试验场启程', 2600, 'good');
  }
  function startSlaughterRun() {
    playMode = 'slaughter';
    slaughterFailed = false;
    slaughterTimerPaused = false;
    slaughterPauseLeft = 0;
    slaughterFreezeAt = 0;
    slaughterEndsAt = performance.now() + SLAUGHTER_LIMIT_MS;
    hideModePick();
    updateControlCredits();
    const sf = document.getElementById('slaughter-fail');
    if (sf) sf.classList.add('hidden');
    document.getElementById('win').classList.add('hidden');
    state.won = false;
    loadLevel(lastStoryIdx());
    toast('屠戮模式 · 从终章倒行回第一章 · 限时 5 分钟（试验场不计入）', 3200, 'warn');
    updateSlaughterTimerUi();
  }
  function selectPlayMode(mode) {
    if (!controlScheme) {
      toast('请先选择键盘或鼠标操作方式', 2200, 'warn');
      return;
    }
    initAudio();
    if (mode === 'slaughter') startSlaughterRun();
    else startTourRun();
    Auth.refreshMenu();
  }
  const mpTour = document.getElementById('mp-tour');
  const mpSlaughter = document.getElementById('mp-slaughter');
  if (mpTour) mpTour.addEventListener('click', () => selectPlayMode('tour'));
  if (mpSlaughter) mpSlaughter.addEventListener('click', () => selectPlayMode('slaughter'));
  const mpCtrlKb = document.getElementById('mp-ctrl-kb');
  const mpCtrlMouse = document.getElementById('mp-ctrl-mouse');
  if (mpCtrlKb) mpCtrlKb.addEventListener('click', () => setControlScheme('keyboard'));
  if (mpCtrlMouse) mpCtrlMouse.addEventListener('click', () => setControlScheme('mouse'));

  // 悬停 / 聚焦操作方式：放大展示对应按键
  const CTRL_GUIDE = {
    keyboard: {
      kicker: 'KEYBOARD',
      title: '键盘游玩 · 按键一览',
      note: '此模式下关闭鼠标点地与滚轮攻击；齿轮 / 转盘仍可用指针拖动。',
      html:
        '<div class="mp-cg-row">' +
          '<span class="mp-cg-row-label">移动</span>' +
          '<div class="mp-cg-wasd" aria-hidden="true">' +
            '<span class="mp-cg-key accent k-w">W</span>' +
            '<span class="mp-cg-key accent k-a">A</span>' +
            '<span class="mp-cg-key accent k-s">S</span>' +
            '<span class="mp-cg-key accent k-d">D</span>' +
          '</div>' +
          '<span class="mp-cg-hint">A / D 原地转向 · W / S 沿面朝进退</span>' +
        '</div>' +
        '<div class="mp-cg-row">' +
          '<span class="mp-cg-row-label">视角</span>' +
          '<div class="mp-cg-keys">' +
            '<span class="mp-cg-key wide accent">空 格</span>' +
            '<span class="mp-cg-plus">+</span>' +
            '<span class="mp-cg-key">Q</span>' +
            '<span class="mp-cg-key">E</span>' +
          '</div>' +
          '<span class="mp-cg-hint">空格切俯视 / 3D · Q/E 转卦限</span>' +
        '</div>' +
        '<div class="mp-cg-row">' +
          '<span class="mp-cg-row-label">战斗</span>' +
          '<div class="mp-cg-keys"><span class="mp-cg-key warn">J</span></div>' +
          '<span class="mp-cg-hint">屠戮模式挥剑（观光正篇不用）</span>' +
        '</div>' +
        '<div class="mp-cg-row">' +
          '<span class="mp-cg-row-label">其它</span>' +
          '<div class="mp-cg-keys">' +
            '<span class="mp-cg-key">Esc</span>' +
            '<span class="mp-cg-key">R</span>' +
          '</div>' +
          '<span class="mp-cg-hint">Esc 停步 · R 重玩本章</span>' +
        '</div>'
    },
    mouse: {
      kicker: 'MOUSE',
      title: '鼠标游玩 · 操作一览',
      note: '此模式下关闭 WASD；空格 / Q / E / R 等键盘快捷键仍可用。',
      html:
        '<div class="mp-cg-row">' +
          '<span class="mp-cg-row-label">行走</span>' +
          '<div class="mp-cg-keys">' +
            '<span class="mp-cg-mouse left" data-label="左键"></span>' +
          '</div>' +
          '<span class="mp-cg-hint">点选地砖，自动寻路走过去</span>' +
        '</div>' +
        '<div class="mp-cg-row">' +
          '<span class="mp-cg-row-label">机关</span>' +
          '<div class="mp-cg-keys">' +
            '<span class="mp-cg-mouse drag left" data-label="拖动"></span>' +
          '</div>' +
          '<span class="mp-cg-hint">拖齿轮 / 点转盘，石桥转到平直</span>' +
        '</div>' +
        '<div class="mp-cg-row">' +
          '<span class="mp-cg-row-label">攻击</span>' +
          '<div class="mp-cg-keys">' +
            '<span class="mp-cg-mouse scroll" data-label="滚轮"></span>' +
          '</div>' +
          '<span class="mp-cg-hint">滚轮上下均为攻击（屠戮）</span>' +
        '</div>' +
        '<div class="mp-cg-row">' +
          '<span class="mp-cg-row-label">视角</span>' +
          '<div class="mp-cg-keys">' +
            '<span class="mp-cg-key wide accent">空 格</span>' +
            '<span class="mp-cg-plus">+</span>' +
            '<span class="mp-cg-key">Q</span>' +
            '<span class="mp-cg-key">E</span>' +
          '</div>' +
          '<span class="mp-cg-hint">空格切视角 · Q/E 转卦限</span>' +
        '</div>' +
        '<div class="mp-cg-row">' +
          '<span class="mp-cg-row-label">其它</span>' +
          '<div class="mp-cg-keys">' +
            '<span class="mp-cg-mouse right" data-label="右键"></span>' +
            '<span class="mp-cg-plus">/</span>' +
            '<span class="mp-cg-key">Esc</span>' +
            '<span class="mp-cg-key">R</span>' +
          '</div>' +
          '<span class="mp-cg-hint">右键或 Esc 停步 · R 重玩</span>' +
        '</div>'
    }
  };
  const mpCtrlGuide = document.getElementById('mp-ctrl-guide');
  const mpCgKicker = document.getElementById('mp-cg-kicker');
  const mpCgTitle = document.getElementById('mp-cg-title');
  const mpCgBody = document.getElementById('mp-cg-body');
  const mpCgNote = document.getElementById('mp-cg-note');
  let mpGuideHideTimer = 0;
  function showCtrlGuide(scheme) {
    const g = CTRL_GUIDE[scheme];
    if (!g || !mpCtrlGuide || !mpCgBody) return;
    if (mpGuideHideTimer) { clearTimeout(mpGuideHideTimer); mpGuideHideTimer = 0; }
    const same = mpCtrlGuide.dataset.scheme === scheme && !mpCtrlGuide.hidden;
    mpCtrlGuide.dataset.scheme = scheme;
    if (mpCgKicker) mpCgKicker.textContent = g.kicker;
    if (mpCgTitle) mpCgTitle.textContent = g.title;
    if (mpCgNote) mpCgNote.textContent = g.note;
    if (!same) {
      mpCgBody.innerHTML = g.html;
      mpCtrlGuide.hidden = false;
      // 重触发入场动画
      mpCtrlGuide.style.animation = 'none';
      void mpCtrlGuide.offsetWidth;
      mpCtrlGuide.style.animation = '';
    }
  }
  function scheduleHideCtrlGuide() {
    if (mpGuideHideTimer) clearTimeout(mpGuideHideTimer);
    mpGuideHideTimer = setTimeout(() => {
      mpGuideHideTimer = 0;
      // 若焦点仍在操作按钮上则保留
      const ae = document.activeElement;
      if (ae && ae.classList && ae.classList.contains('mp-ctrl')) {
        const s = ae.getAttribute('data-ctrl');
        if (s === 'keyboard' || s === 'mouse') { showCtrlGuide(s); return; }
      }
      if (mpCtrlGuide) {
        mpCtrlGuide.hidden = true;
        mpCtrlGuide.dataset.scheme = '';
      }
    }, 120);
  }
  function bindCtrlGuide(btn) {
    if (!btn) return;
    const scheme = btn.getAttribute('data-ctrl');
    btn.addEventListener('mouseenter', () => showCtrlGuide(scheme));
    btn.addEventListener('mouseleave', scheduleHideCtrlGuide);
    btn.addEventListener('focus', () => showCtrlGuide(scheme));
    btn.addEventListener('blur', scheduleHideCtrlGuide);
  }
  bindCtrlGuide(mpCtrlKb);
  bindCtrlGuide(mpCtrlMouse);
  if (mpCtrlGuide) {
    mpCtrlGuide.addEventListener('mouseenter', () => {
      if (mpGuideHideTimer) { clearTimeout(mpGuideHideTimer); mpGuideHideTimer = 0; }
    });
    mpCtrlGuide.addEventListener('mouseleave', scheduleHideCtrlGuide);
  }

  syncControlUi();
  updateControlCredits();
  window.__showModePick = showModePick;

  // 进度变化（含云端同步回调）→ 刷新章节圆点与账号菜单
  Auth.onProgress(() => { renderDots(); updateHUD(); Auth.refreshMenu(); });

  // ------------------------------------------------ 主循环（RAF 饥饿兜底）
  gsap.ticker.sleep();
  // 用钳制后的逻辑时间推进 GSAP，避免掉帧/锁帧后按墙钟一次跳完一整步（看起来像瞬移）
  let gsapLogicT = 0;
  let lastFrameT = performance.now();
  function tickGsap(dt) {
    const step = Math.min(0.05, Math.max(0, dt == null ? 1 / 60 : dt));
    gsapLogicT += step;
    gsap.updateRoot(gsapLogicT);
  }
  /** 角色/镜头/压平插值在动时满帧绘制，静止才锁帧省 CPU */
  function needsSmoothMotion() {
    if (char.walking || faceTween || state.dying || state.attacking
      || state.rotating || state.hurtPause) return true;
    if (walkTween && typeof walkTween.isActive === 'function' && walkTween.isActive()) return true;
    if (planarMorphTween && typeof planarMorphTween.isActive === 'function' && planarMorphTween.isActive()) return true;
    if (camTweens && camTweens.some(t => t && typeof t.isActive === 'function' && t.isActive())) return true;
    try {
      if (char.group && gsap.isTweening(char.group.position)) return true;
      if (char.inner && gsap.isTweening(char.inner.position)) return true;
    } catch (e) { }
    return false;
  }
  // 挡在角色 / 石碑前的石柱半透，保证出生点与留言始终可读
  const _occCam = new THREE.Vector3();
  const _occPt = new THREE.Vector3();
  const _occWall = new THREE.Vector3();
  const _occRight = new THREE.Vector3(1, 0, -1).normalize();
  function setWallFade(mesh, faded) {
    if (!mesh) return;
    if (mesh.userData._faded === faded) return;
    mesh.userData._faded = faded;
    const mats = mesh.material;
    const list = Array.isArray(mats) ? mats : [mats];
    for (const mat of list) {
      if (!mat) continue;
      if (faded) {
        mat.transparent = true;
        mat.opacity = 0.2;
        mat.depthWrite = false;
      } else {
        mat.transparent = false;
        mat.opacity = 1;
        mat.depthWrite = true;
      }
    }
  }
  let occFrame = 0;
  const _focusA = new THREE.Vector3();
  const _focusB = new THREE.Vector3();
  function clearWallFades() {
    for (const w of wallMeshes) if (w.mesh) setWallFade(w.mesh, false);
  }
  function updateWallOcclusion() {
    if (!wallMeshes.length) return;
    // 流畅/均衡跳过墙体半透（材质改写很吃 CPU）
    if (gfxTier < 2) return;
    if (camMode === '2d' || !char.group) {
      clearWallFades();
      return;
    }
    occFrame++;
    if (occFrame & 1) return;
    camera.getWorldPosition(_occCam);
    char.group.getWorldPosition(_focusA);
    let nFocus = 1;
    if (char.node && char.node.stelePed) {
      char.node.stelePed.getWorldPosition(_focusB);
      nFocus = 2;
    }
    for (const w of wallMeshes) {
      if (!w.mesh) continue;
      if ((w.h || 0) < 0.55) { setWallFade(w.mesh, false); continue; }
      w.mesh.getWorldPosition(_occWall);
      const wallDist = _occCam.distanceToSquared(_occWall);
      const wallSx = _occWall.x * _occRight.x + _occWall.z * _occRight.z;
      let block = false;
      for (let fi = 0; fi < nFocus; fi++) {
        const pt = fi === 0 ? _focusA : _focusB;
        const ptDist = _occCam.distanceToSquared(pt);
        if (wallDist >= ptDist - 0.15) continue;
        const ptSx = pt.x * _occRight.x + pt.z * _occRight.z;
        if (Math.abs(wallSx - ptSx) < 0.95) { block = true; break; }
      }
      setWallFade(w.mesh, block);
    }
  }

  function syncSceneMotion() {
    for (const g of gears) {
      if (g.rotorRef) g.spin.rotation.y = g.rotorRef.group.rotation.y;
    }
    updateWallOcclusion();
    camera.lookAt(camCenter);
  }
  function renderFrame(dt) {
    tickGsap(dt);
    syncSceneMotion();
    renderer.render(scene, camera);
  }
  function isOverlayBlockingRender() {
    const b = document.body;
    return b.classList.contains('auth-open')
      || b.classList.contains('gfx-pick-open')
      || b.classList.contains('mode-pick-open');
  }
  let animRunning = true;
  let animRaf = 0;
  let lastDrawT = 0;
  let slowFrames = 0;
  function maybeAutoDownscale(frameMs) {
    // 仅「自动」档：掉帧时尽快压到流畅，避免访客机长时间高占用
    if (!autoDownscaleEnabled || gfxTier === 0) return;
    if (frameMs < 22) { slowFrames = Math.max(0, slowFrames - 1); return; }
    slowFrames++;
    if (slowFrames < 12) return;
    slowFrames = 0;
    gfxPref = 'auto';
    maxPixelRatio = GFX_PRESETS.low.maxPR;
    minFrameMs = GFX_PRESETS.low.minMs;
    gfxTier = 0;
    autoDownscaleEnabled = true;
    syncGfxClass();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    clearWallFades();
  }
  function killDecorLoops() {
    try {
      if (goalFx && goalFx.gem) {
        gsap.killTweensOf(goalFx.gem.position);
        gsap.killTweensOf(goalFx.gem.rotation);
      }
      for (const n of nodes) {
        if (n.steleGlyph) {
          gsap.killTweensOf(n.steleGlyph.position);
          gsap.killTweensOf(n.steleGlyph.rotation);
        }
        if (n.steleHalo && n.steleHalo.material) gsap.killTweensOf(n.steleHalo.material);
        if (n.keyMesh) {
          gsap.killTweensOf(n.keyMesh.position);
          gsap.killTweensOf(n.keyMesh.rotation);
        }
      }
      for (const d of dials) if (d.knob) gsap.killTweensOf(d.knob.position);
      gsap.killTweensOf(glintGoldMat);
      gsap.killTweensOf(glintTealMat);
      if (glintGoldMat) glintGoldMat.opacity = 0.22;
      if (glintTealMat) glintTealMat.opacity = 0.22;
      if (!allowIdleBob()) stopIdle();
    } catch (e) { }
  }
  function setGfxQuality(pref, opts) {
    if (pref !== 'auto' && pref !== 'low' && pref !== 'mid' && pref !== 'high') return;
    if (pref === gfxPref && !(opts && opts.force)) {
      syncGfxUi();
      return;
    }
    gfxPref = pref;
    try { localStorage.setItem(LS_GFX, pref); } catch (e) { }
    slowFrames = 0;
    applyGfxSettings();
    clearWallFades();
    if (!allowDecorFx()) killDecorLoops();
    scheduleAnimate();
    if (!(opts && opts.silent)) {
      toast('画质 · ' + (GFX_LABELS[pref] || pref), 1800, 'good');
    }
  }
  let animSleepTimer = 0;
  function scheduleAnimate(delayMs) {
    if (!animRunning) return;
    // 登录 / 切后台：用定时器，避免空转 RAF 占 CPU
    if (isOverlayBlockingRender() || document.hidden) {
      if (animRaf) { try { cancelAnimationFrame(animRaf); } catch (e) { } animRaf = 0; }
      if (animSleepTimer) return;
      animSleepTimer = setTimeout(() => {
        animSleepTimer = 0;
        scheduleAnimate();
      }, 280);
      return;
    }
    const wait = delayMs | 0;
    // 仅静止锁帧时用短延时；走动中走 RAF，避免一步被跳完
    if (wait > 0 && !needsSmoothMotion()) {
      if (animRaf) { try { cancelAnimationFrame(animRaf); } catch (e) { } animRaf = 0; }
      if (animSleepTimer) return;
      animSleepTimer = setTimeout(() => {
        animSleepTimer = 0;
        scheduleAnimate();
      }, wait);
      return;
    }
    if (animSleepTimer) { try { clearTimeout(animSleepTimer); } catch (e) { } animSleepTimer = 0; }
    if (animRaf) return;
    animRaf = requestAnimationFrame(animate);
  }
  function animate() {
    animRaf = 0;
    if (!animRunning) return;
    const now = performance.now();
    if (isOverlayBlockingRender() || document.hidden) {
      scheduleAnimate();
      return;
    }
    // 逻辑时间钳制：卡顿后最多追 50ms，防止一步走直接跳到终点
    const dt = Math.min(0.05, Math.max(0, (now - lastFrameT) / 1000));
    lastFrameT = now;
    lastDrawT = now;
    tickSlaughterTimer();
    if (combatEnabled()) updateFoes(dt);
    tickGsap(dt);
    syncSceneMotion();
    renderer.render(scene, camera);
    const moving = needsSmoothMotion();
    if (!moving) maybeAutoDownscale(dt * 1000);
    // 走动满帧；静止按画质锁帧
    scheduleAnimate(moving ? 0 : (minFrameMs || 0));
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && animRunning) scheduleAnimate();
  });
  const watchdog = setInterval(() => {
    if (!animRunning || isOverlayBlockingRender() || document.hidden) return;
    if (performance.now() - lastFrameT > 500) {
      lastFrameT = performance.now();
      lastDrawT = lastFrameT;
      renderFrame(1 / 60);
      scheduleAnimate();
    }
  }, 400);

  // 关页 / 刷新：停循环、释放 WebGL 与音频，避免浏览器进程占 GPU/内存
  let tornDown = false;
  function teardownGame() {
    if (tornDown) return;
    tornDown = true;
    animRunning = false;
    if (animRaf) { try { cancelAnimationFrame(animRaf); } catch (e) { } animRaf = 0; }
    if (animSleepTimer) { try { clearTimeout(animSleepTimer); } catch (e) { } animSleepTimer = 0; }
    try { clearInterval(watchdog); } catch (e) { }
    try { gsap.globalTimeline.clear(); } catch (e) { }
    try { disposeWorld(); } catch (e) { }
    try {
      if (renderer) {
        renderer.dispose();
        if (typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();
        const el = renderer.domElement;
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
    } catch (e) { }
    try { if (typeof AC !== 'undefined' && AC && typeof AC.close === 'function') AC.close(); } catch (e) { }
    try { if (window.Auth && typeof Auth.stopBackdrop === 'function') Auth.stopBackdrop(); } catch (e) { }
  }
  window.addEventListener('pagehide', teardownGame);
  window.addEventListener('beforeunload', teardownGame);

  // ------------------------------------------------ 启动
  // URL 参数 ?level=N（1 起）：等账号就绪后再合并解锁，避免冲掉本机存档
  const _qs = new URLSearchParams(location.search);
  const urlLevel = parseInt(_qs.get('level'), 10);
  function applyUrlLevelUnlock() {
    if (isNaN(urlLevel) || urlLevel < 1 || urlLevel > LEVELS.length) return;
    Auth.commit(p => {
      p.unlocked = Math.max(p.unlocked || 0, urlLevel - 1);
      if (!p.records) p.records = {};
      if (!p.steles) p.steles = {};
    });
  }
  // 登录 / 模式选择阶段不预建 3D（弱机与局域网访客卡顿主因）；选模式后再 loadLevel
  scheduleAnimate();

  Auth.onReady(() => {
    applyUrlLevelUnlock();
    const u = Auth.user;
    const nameEl = document.getElementById('player-name');
    if (nameEl) nameEl.textContent = u ? u.username : '游客';
    Auth.refreshMenu();
    // 登录后先选模式；关卡在选完后再载入
    showModePick();
    if (u) {
      const hello = Auth.enterMode === 'register' ? '欢迎加入投影回廊' : '欢迎回来';
      toast(hello + '，' + u.username + (Auth.isOnline() ? ' · 进度已同步' : ''), 3000, 'good');
    }
  });

  // 调试接口（供自动化测试 / 控制台使用）
  window.__game = {
    state: state, char: char,
    gfx: () => ({ pref: gfxPref, tier: gfxTier, maxPixelRatio, minFrameMs }),
    setGfxQuality: setGfxQuality,
    nodes: () => nodes, adj: () => adj,
    loadLevel: loadLevel, toggleMode: toggleMode,
    findPath: findPathBFS, planRoute: planRoute, minToggles: minToggles,
    goalNode: () => goalNode, startNode: () => startNode,
    levelPar: () => levelPar, maxIllusionK: () => (curLevel && curLevel.maxIllusionK != null) ? curLevel.maxIllusionK : 1,
    camera: camera, requestWalkTo: requestWalk, cancelWalk: cancelWalk,
    rotateDial: rotateDial, dials: () => dials,
    gears: () => gears, gearParts: gearParts, rotateGearBy: rotateGearBy,
    setRotorDeg: function (id, deg) {
      const r = rotors.find(x => x.id === id);
      if (!r) return;
      r.group.rotation.y = deg * Math.PI / 180;
      r.group.updateMatrixWorld(true);
      updateGraph();
    },
    illuEdges: function () {
      const out = [];
      for (const n of illuNodes) out.push([n.pos.x, n.pos.y, n.pos.z]);
      return out;
    },
    solveRotors: function () {
      for (const r of rotors) {
        r.group.rotation.y = Math.round(r.group.rotation.y / Math.PI) * Math.PI;
      }
      updateGraph();
    },
    curLevel: () => curLevel,
    playMode: () => playMode,
    foes: () => foes,
    trySwordSwing: trySwordSwing,
    LEVELS: LEVELS
  };

  // 简单 BFS（调试用，当前视角）
  function findPathBFS(from, to) {
    if (from === to) return null;
    const prev = new Map([[from, null]]);
    const q = [from];
    while (q.length) {
      const cur = q.shift();
      if (cur === to) {
        const path = [];
        for (let n = to; n; n = prev.get(n)) path.unshift(n);
        return path;
      }
      for (const nb of adj.get(cur)) {
        if (!prev.has(nb)) { prev.set(nb, cur); q.push(nb); }
      }
    }
    return null;
  }

})();
