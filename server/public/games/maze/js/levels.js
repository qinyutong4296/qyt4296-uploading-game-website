/* ============================================================
 * 投影回廊 · 关卡数据（第八版：分章独解 · 禁复读 · 三叉分化）
 *
 * 设计原则：少切换、多思考、大地图；每章一种主解法，禁止「青桥→攀高→对齐」通关复读。
 *   每张图约 2~6 次必要切换；非教学关不可 only2d / only3d 通关。
 * 三叉分化（每章只主打其一，勿叠成同套路）：
 *   · 序星 keyOrder     —— 星屑必须按序号拾取
 *   · 多方位 viewSnaps  —— 3D 甲乙丙丁换卦限，投影错觉错位解密（Q/E）
 *   · 多终径            —— 殊途同归，机制不同的两条以上抵达路线
 * 分章主解法（Q/E 转化视角从第 1 章贯穿至终章，难度递进）：
 *   0 沙盒 · 甲假乙真示范
 *   1 乙向软闸教学（无假台）         2 甲假乙真入门
 *   3 甲假乙真加长                   4 甲假乙真分叉（假路不接终点）
 *   5 齿轮 + 甲假乙真                6 环升 + 甲假乙真加长
 *   7 序星 + 甲假乙真加长            8 长谷 + 甲假乙真加长链
 *   9 甲乙丙三向加长（宽度峰值 · triLong）     10 序星双径 + 甲假乙真加长
 *   11 双轮 + 甲假乙真加长           12 咬合 + 甲乙丙三向加重
 *   13 咬合+序星+甲假乙真加长（综合） 外 碑后 · 甲假乙真回响
 *
 * 通路规则（与 main.js 同步）：
 *   2D 俯视：xz 脚印相邻即可走（含任何高差 + 同列竖叠）
 *   3D 等距：同色且四邻连通的顶面 = 同一平面（平面内可走）；
 *            有侧面色差的高差 |dy|≥1 不可爬（须切俯视）；
 *            投影对齐 B=A+(±1,0,0|0,0,±1)+k(sx,1,sz)，(sx,sz) 随方位变
 *            关卡可用 maxIllusionK / illusionPairs / illusionPairsAt / viewSnaps
 *   相位桥 phase:'2d'|'3d'：只在对应视角实体化
 *   drop:true：2D 里是悬崖（3D 可站），切回/踩上 2D 会坠落重开关
 *   齿轮 gears：驱动转子；meshWith 按齿数比反向联动
 *   元数据：tutorial / sandbox / gearGated / phaseOptional / keyOrder / viewSnaps / par
 *   建筑师留言：正篇每一章与外章各有一块碑；解法与主线错开
 *
 * 坐标：x/z 网格，y 为块顶面高度；rotor 砖为角度 0 时的位置。
 * ============================================================ */
'use strict';

function P(x, y, z, o) { const n = { x: x, y: y, z: z }; if (o) Object.assign(n, o); return n; }
function slab(x0, x1, z0, z1, y, o) {
  const out = [];
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) out.push(P(x, y, z, o));
  return out;
}
function room(x0, x1, z0, z1, y, blocks, o) {
  const bl = new Set((blocks || []).map(b => b[0] + ',' + b[1]));
  const out = [];
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    if (bl.has(x + ',' + z)) continue;
    out.push(P(x, y, z, o));
  }
  return out;
}
function flag(nodes, x, y, z, prop) {
  const n = nodes.find(n => n.x === x && n.y === y && n.z === z);
  if (n) n[prop] = true; else console.warn('flag 落空:', x, y, z, prop);
}
/** 星屑；ord 在 keyOrder 关卡中为必拾序号（从 1 起） */
function flagKey(nodes, x, y, z, ord) {
  const n = nodes.find(n => n.x === x && n.y === y && n.z === z);
  if (n) { n.key = true; if (ord != null) n.keyOrd = ord; }
  else console.warn('flagKey 落空:', x, y, z, ord);
}
function say(nodes, x, y, z, text) {
  const n = nodes.find(n => n.x === x && n.y === y && n.z === z);
  if (n) n.stele = text; else console.warn('stele 落空:', x, y, z);
}
/** 等距相机从 (+x,+z) 看入：在出生厅范围内取 x+z 最大的砖，避免被石柱挡住 */
function nearIn(nodes, x0, x1, z0, z1, y) {
  let best = null, score = -Infinity;
  for (const n of nodes) {
    if (n.y !== y) continue;
    if (n.x < x0 || n.x > x1 || n.z < z0 || n.z > z1) continue;
    if (n.phase || n.drop || n.rotor || n.decoy) continue;
    const s = n.x + n.z;
    if (s > score) { score = s; best = n; }
  }
  return best ? [best.x, best.y, best.z] : null;
}
function dirDelta(dir) {
  if (dir === 'n') return [0, -1];
  if (dir === 's') return [0, 1];
  if (dir === 'w') return [-1, 0];
  return [1, 0];
}
/**
 * Q/E 方位闸（渐进难度 · 脚印不相邻，防俯视/甲向几何绕过）
 *  mode 'soft'：仅乙向真路，甲向无桥（教学）
 *  mode 'jiaYi'：甲假乙真（假砖 drop）
 *  mode 'jiaYiLong'：甲假两段 + 乙真两段
 *  mode 'jiaYiFork'：甲假两段分叉 + 乙真一段（墙迷宫用）
 *  mode 'tri'：甲假 + 乙迁（死胡同）+ 丙真
 *  mode 'triLong'：甲假两段 + 乙迁两段 + 丙真两段（加重）
 *
 * 真/假/迁浮砖落在甲+(2,1,1) / 乙+(-1,1,2) / 丙+(-1,1,-2) 投影步进上（画面连续）。
 * 不靠 pairsAt 飞砖；可选 fx/tx/mx 覆盖。返回 { nodes, illusionPairsAt, viewSnaps, land }
 */
function qeGate(mode, a) {
  /**
   * 合理 Q/E：浮砖落在对应方位的投影几何步进上（画面上看着连着），
   * 不靠 illusionPairsAt 凭空飞砖。
   *   甲 snap0 (sx,sz)=(1,1)  升步 +(2,1,1)
   *   乙 snap1 (-1,1)         升步 +(-1,1,2)
   *   丙 snap2 (-1,-1)        升步 +(-1,1,-2)
   * 脚印 xz 正交不相邻 → 俯视无法竖叠/贴边绕过；错方位也几何连不上。
   * a: { ax,ay,az, lx?,ly?,lz?, 可选 fx/tx/mx / f2x/t2x/m2x 覆盖 }
   * 返回 { nodes, illusionPairsAt, viewSnaps, land:[x,y,z] }
   */
  const nodes = [];
  const push = (x, y, z, o) => { nodes.push(P(x, y, z, o)); return [x, y, z]; };
  const A = [a.ax, a.ay, a.az];
  const bodyOf = (y, custom) => (custom != null ? custom : Math.max(1.2, y));
  const add = (p, d) => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
  const JIA = [2, 1, 1], YI = [-1, 1, 2], BING = [-1, 1, -2];
  const def = (key, dx, dy, dz) => {
    if (a[key + 'x'] != null) return [a[key + 'x'], a[key + 'y'], a[key + 'z']];
    if (key.length === 2 && a[key[0] + 'x' + key[1]] != null) {
      const b = key[0], n = key[1];
      return [a[b + 'x' + n], a[b + 'y' + n], a[b + 'z' + n]];
    }
    return [a.ax + dx, a.ay + dy, a.az + dz];
  };
  // 调用方若给 lx，必须落在真路几何终点（或与其同高四邻）；否则用几何推算
  const landOf = (end) => (a.lx != null ? [a.lx, a.ly, a.lz] : end);

  if (mode === 'soft') {
    // 乙向一步真浮砖；甲向几何对不齐。落点再乙向一步（实心由调用方铺）
    const T = push(...def('t', YI[0], YI[1], YI[2]), { body: bodyOf(a.ay + YI[1], a.tbody) });
    const land = landOf(add(T, YI));
    return { nodes, illusionPairsAt: {}, viewSnaps: [0, 1], land };
  }
  if (mode === 'jiaYi' || mode === 'jiaYiLong' || mode === 'jiaYiFork') {
    // 甲假：甲向几何对齐的悬崖
    const F1 = push(...def('f', JIA[0], JIA[1], JIA[2]), {
      drop: true, decoy: true, body: a.fbody != null ? a.fbody : (a.ay + JIA[1] + 1)
    });
    let F2 = null;
    if (mode === 'jiaYiLong' || mode === 'jiaYiFork' || a.f2x != null || a.fx2 != null) {
      const f2d = mode === 'jiaYiFork' ? add(JIA, [3, 1, 2]) : add(JIA, JIA); // fork 再偏一格，躲开真路
      const f2p = def('f2', f2d[0], f2d[1], f2d[2]);
      F2 = push(f2p[0], f2p[1], f2p[2], {
        drop: true, decoy: true, body: a.fbody2 != null ? a.fbody2 : (f2p[1] + 1)
      });
    }
    // 乙真：乙向几何升步
    const T1 = push(...def('t', YI[0], YI[1], YI[2]), { body: bodyOf(a.ay + YI[1], a.tbody) });
    let T2 = null;
    let end = T1;
    if (mode === 'jiaYiLong' || a.t2x != null || a.tx2 != null) {
      const t2p = def('t2', YI[0] * 2, YI[1] * 2, YI[2] * 2);
      T2 = push(t2p[0], t2p[1], t2p[2], { body: bodyOf(t2p[1], a.tbody2) });
      end = T2;
    }
    const land = landOf(add(end, YI));
    return { nodes, illusionPairsAt: {}, viewSnaps: [0, 1], land, fakeEnd: F2 || F1, trueEnd: end };
  }
  if (mode === 'tri' || mode === 'triLong') {
    const F1 = push(...def('f', JIA[0], JIA[1], JIA[2]), {
      drop: true, decoy: true, body: a.fbody != null ? a.fbody : (a.ay + JIA[1] + 1)
    });
    if (mode === 'triLong' || a.f2x != null || a.fx2 != null) {
      const f2p = def('f2', JIA[0] * 2, JIA[1] * 2, JIA[2] * 2);
      push(f2p[0], f2p[1], f2p[2], {
        drop: true, decoy: true, body: a.fbody2 != null ? a.fbody2 : (f2p[1] + 1)
      });
    }
    // 乙迁：乙向对齐的死胡同（不接落点）
    const M1 = push(...def('m', YI[0], YI[1], YI[2]), { body: bodyOf(a.ay + YI[1], a.mbody) });
    if (mode === 'triLong' || a.m2x != null || a.mx2 != null) {
      const m2p = def('m2', YI[0] * 2, YI[1] * 2, YI[2] * 2);
      push(m2p[0], m2p[1], m2p[2], { body: bodyOf(m2p[1], a.mbody2) });
    }
    // 丙真：丙向几何升步
    const T1 = push(...def('t', BING[0], BING[1], BING[2]), { body: bodyOf(a.ay + BING[1], a.tbody) });
    let end = T1;
    if (mode === 'triLong' || a.t2x != null || a.tx2 != null) {
      const t2p = def('t2', BING[0] * 2, BING[1] * 2, BING[2] * 2);
      end = push(t2p[0], t2p[1], t2p[2], { body: bodyOf(t2p[1], a.tbody2) });
    }
    const land = landOf(add(end, BING));
    return { nodes, illusionPairsAt: {}, viewSnaps: [0, 1, 2], land, trueEnd: end };
  }
  return { nodes, illusionPairsAt: {}, viewSnaps: [0, 1], land: A };
}

function mergePairsAt(dst, src) {
  if (!src) return dst || {};
  const out = dst ? Object.assign({}, dst) : {};
  for (const k of Object.keys(src)) {
    const key = Number(k);
    out[key] = (out[key] || []).concat(src[k] || src[key] || []);
  }
  return out;
}
/**
 * 建筑师留言 = 关卡旁支小谜（不挡主线）：
 *   alcove2d  · 青色相位桥 → 碑台（须俯视）
 *   alcove3d  · 金色相位桥 → 碑台（须 3D）
 *   alcoveClimb · 侧面色差高台（须俯视攀）
 *   alcoveGear · 齿轮桥 0°不通 / 转 90°接通（与切视角主线错开）
 */
function alcove2d(nodes, ax, ay, az, dir, text, body) {
  const b = body != null ? body : 1.2;
  const [dx, dz] = dirDelta(dir);
  nodes.push(P(ax + dx, ay, az + dz, { phase: '2d', body: b }));
  nodes.push(P(ax + dx * 2, ay, az + dz * 2, { body: b }));
  say(nodes, ax + dx * 2, ay, az + dz * 2, text);
}
function alcove3d(nodes, ax, ay, az, dir, text, body) {
  const b = body != null ? body : 1.2;
  const [dx, dz] = dirDelta(dir);
  nodes.push(P(ax + dx, ay, az + dz, { phase: '3d', body: b }));
  nodes.push(P(ax + dx * 2, ay, az + dz * 2, { body: b }));
  say(nodes, ax + dx * 2, ay, az + dz * 2, text);
}
function alcoveClimb(nodes, ax, ay, az, dir, text, bodyLow, bodyHi) {
  const bl = bodyLow != null ? bodyLow : 1.2;
  const bh = bodyHi != null ? bodyHi : 2.4;
  const [dx, dz] = dirDelta(dir);
  nodes.push(P(ax + dx, ay, az + dz, { body: bl }));
  nodes.push(P(ax + dx * 2, ay + 1, az + dz * 2, { body: bh }));
  say(nodes, ax + dx * 2, ay + 1, az + dz * 2, text);
}
/**
 * 旁支齿轮桥：0°/180° 横摆不通；90°/270° 沿岔路接通引桥→碑台。
 * 静砖只放在扫掠格之外（引桥第 1 格、碑台第 5 格），避免与转子重叠。
 */
function alcoveGear(nodes, ax, ay, az, dir, text, opts) {
  opts = opts || {};
  const rid = opts.rotorId || 'rs';
  const gid = opts.gearId || 'gs';
  const body = opts.body != null ? opts.body : 1.2;
  const teeth = opts.teeth || 10;
  const [dx, dz] = dirDelta(dir);
  const px = -dz, pz = dx;
  const a1x = ax + dx, a1z = az + dz;
  const pivx = ax + dx * 3, pivz = az + dz * 3;
  const sx = ax + dx * 5, sz = az + dz * 5;
  nodes.push(P(a1x, ay, a1z, { body: body }));
  nodes.push(P(pivx + px, ay, pivz + pz, { rotor: rid, body: body }));
  nodes.push(P(pivx, ay, pivz, { rotor: rid, body: body }));
  nodes.push(P(pivx - px, ay, pivz - pz, { rotor: rid, body: body }));
  nodes.push(P(sx, ay, sz, { body: body }));
  say(nodes, sx, ay, sz, text);
  return {
    rotors: [{ id: rid, pivot: [pivx, ay, pivz], angle0: 0 }],
    gears: [{ id: gid, rotor: rid, teeth: teeth, pos: [a1x + px * 1.2, ay + 1.35, a1z + pz * 1.2] }]
  };
}
function takeGear(pack, rotors, gears) {
  if (!pack) return;
  for (const r of pack.rotors) rotors.push(r);
  for (const g of pack.gears) gears.push(g);
}

const LEVELS = [

  // ========== 0 机能试验场 · 全机制沙盒（不计入正篇碑录 / 屠戮倒行）=====###
  (function () {
    const nodes = [].concat(
      // 起点厅 · WASD / 点地
      room(0, 3, 0, 2, 0, [[1, 1]], { body: 1.2 }),
      // 青桥 phase 2d
      [P(4, 0, 1, { phase: '2d', body: 1.2 }), P(5, 0, 1, { phase: '2d', body: 1.2 })],
      // 中厅 A · 序星① · 假台 · 南攀
      // 中厅 A · 序星① · 南攀（假台改由末段 qeGate 甲向几何承担，不靠飞边）
      room(6, 9, 0, 2, 0, [[7, 1]], { body: 1.2 }),
      [P(8, 0, 3, { body: 1.2 }), P(8, 1, 4, { body: 2 }), P(9, 1, 4, { body: 2 })],
      // 齿轮桥（angle0=90 初始不通，须拖轮 / 转盘）
      [P(10, 0, 1, { rotor: 'r1', body: 1.2 }), P(11, 0, 1, { rotor: 'r1', body: 1.2 }), P(12, 0, 1, { rotor: 'r1', body: 1.2 })],
      // 中厅 B · 序星② · 咬合枢轴（只留 pivot 砖；臂尖 (15,0,4) 扫到 180° 会与厅砖 (15,0,2) 穿模）
      room(13, 16, 0, 2, 0, [[14, 1]], { body: 1.2 }),
      [P(15, 0, 3, { rotor: 'r2', body: 1.2 })],
      // 金桥 phase 3d → 碑台
      [P(13, 0, -1, { phase: '3d', body: 1.2 }), P(13, 0, -2, { phase: '3d', body: 1.2 })],
      [P(13, 0, -3, { body: 1.2 })],
      // Q/E 甲假乙真示范锚点（闸在下方 gate）
      [P(17, 0, 1, { body: 1.2 })]
    );
    const gate0 = qeGate('jiaYi', {
      ax: 17, ay: 0, az: 1
    });
    nodes.push.apply(nodes, gate0.nodes);
    nodes.push(P(15, 2, 5, { body: 2 }), P(14, 2, 5, { body: 2 }), P(14, 2, 6, { body: 2 }));
    const walls = [[1, 0, 1, 0.32], [7, 0, 1, 1.0], [14, 0, 1, 1.0]];
    const spawn = nearIn(nodes, 0, 3, 0, 2, 0) || [3, 0, 2];
    say(nodes, 13, 0, -3, '建筑师留言·零：廊未名，器先醒。桥可试，轮可转，星可拾，剑可试。诸械尚在，方可言诗。');
    flagKey(nodes, 9, 0, 0, 1);
    flagKey(nodes, 16, 0, 0, 2);
    return {
      name: '第零关 · 机能试验场', sub: 'SANDBOX LAB',
      hint: '第 0 关全机能试验（观光亦可试剑）：青桥俯视 · 金桥 3D · 假台勿踩 · 齿轮/转盘 · 咬合 · 序星①② · Q/E 甲假乙真 · 南侧攀高 · WASD · 影怪/J/心',
      bg: '#c5d4c8',
      pal: { top: 0xf4f7f0, side: 0x6a8f7a, goal: 0xe8b84b, accent: 0x3fbfae, char: 0xffffff },
      nodes: nodes, walls: walls,
      rotors: [
        { id: 'r1', pivot: [11, 0, 1], angle0: 90 },
        { id: 'r2', pivot: [15, 0, 3], angle0: 0 }
      ],
      gears: [
        { id: 'g1', rotor: 'r1', teeth: 12, pos: [10.2, 1.35, 2.15] },
        { id: 'g2', rotor: 'r2', teeth: 6, meshWith: 'g1', pos: [16.15, 1.35, 3.2] }
      ],
      dials: [{ id: 'd1', rotor: 'r1', pos: [11.8, 1.15, 2.25], color: 0xe8b84b }],
      start: spawn, goal: [14, 2, 6], goalNeed: 2,
      foes: [[8, 0, 2], [15, 0, 1]],
      sandbox: true,
      tutorial: true,
      keyOrder: true,
      gearGated: true,
      viewSnaps: gate0.viewSnaps,
      illusionPairsAt: gate0.illusionPairsAt,
      illusionPairs: [],
      par: 3,
      story: '机能自检 · 全功能测试',
      poem: '零章不问华丽，只问桥、轮、星、剑，是否仍肯应答。'
    };
  })(),

  // ========== 1 回廊初醒 · 主解：青桥+石桥 · 乙向软闸（Q/E 教学）=====###
  (function () {
    const nodes = [].concat(
      room(0, 4, 0, 3, 0, [[1, 1], [2, 2], [3, 1]], { body: 1.2 }),
      [P(5, 0, 1, { phase: '2d', body: 1.2 }), P(6, 0, 1, { phase: '2d', body: 1.2 }), P(7, 0, 1, { phase: '2d', body: 1.2 })],
      room(8, 11, 0, 3, 0, [[9, 1], [10, 2]], { body: 1.2 }),
      [P(12, 0, 1, { rotor: 'r1' }), P(13, 0, 1, { rotor: 'r1' }), P(14, 0, 1, { rotor: 'r1' })],
      room(15, 18, 0, 3, 0, [[16, 1], [17, 0]], { body: 1.2 }),
      // 南岔：殊途同归（教学可选第二路线，攀高汇入中厅南）
      slab(0, 3, 4, 5, 0, { body: 1.2 }),
      [P(4, 0, 5, { body: 1.2 }), P(5, 1, 5, { body: 2 }), P(6, 1, 5, { body: 2 })],
      [P(7, 1, 5, { body: 2 }), P(8, 1, 4, { body: 2 }), P(8, 1, 3, { body: 2 })],
      slab(15, 18, 4, 5, 1, { body: 2 }),
      slab(16, 18, 6, 8, 2, { body: 2 }),
      [P(19, 2, 7, { phase: '2d', body: 2 }), P(20, 2, 7, { phase: '2d', body: 2 })],
      room(21, 23, 6, 8, 2, [[22, 7]], { body: 2 }),
      // Q/E 软闸锚点用 slab 内 (22,3,10)；浮砖脚印不相邻，须转乙向
      slab(21, 23, 9, 10, 3, { body: 3 })
    );
    const gate = qeGate('soft', {
      ax: 22, ay: 3, az: 10,
      tbody: 4
    });
    nodes.push.apply(nodes, gate.nodes);
    nodes.push(P(20, 5, 14, { body: 5 }), P(19, 5, 14, { body: 5 }), P(19, 5, 15, { body: 5 }));
    const walls = [[2, 0, 2, 0.32], [9, 0, 1, 1.3], [10, 0, 2, 0.32], [16, 0, 1, 1.3], [22, 2, 7, 1.3]];
    const spawn = nearIn(nodes, 0, 4, 0, 3, 0) || [4, 0, 3];
    alcoveClimb(nodes, 0, 0, 0, 'n', '建筑师留言·一：晨光未满，廊影先醒。侧过身去，同一块砖，便换了一副眉目。');
    flagKey(nodes, 18, 0, 2, 1);
    flagKey(nodes, 20, 5, 14, 2);
    return {
      name: '第一章 · 回廊初醒', sub: 'FIRST LIGHT',
      hint: '教学：青桥俯视 · 石桥平直 · 南岔攀高亦可 · 星屑按①→②拾 · 终台前须 Q/E 转到乙向，浮砖才对齐 · 北侧高台有碑',
      bg: '#f0d9bd',
      pal: { top: 0xfbf4e6, side: 0xd99a72, goal: 0xe8b84b, accent: 0x3fbfae, char: 0xffffff },
      nodes: nodes, walls: walls,
      rotors: [{ id: 'r1', pivot: [13, 0, 1], angle0: 90 }],
      gears: [{ id: 'g1', rotor: 'r1', teeth: 12, pos: [12.2, 1.4, 2.2] }],
      dials: [],
      start: spawn, goal: [19, 5, 15], goalNeed: 2,
      keyOrder: true,
      tutorial: true,
      viewSnaps: gate.viewSnaps,
      illusionPairsAt: gate.illusionPairsAt,
      par: 3,
      story: '始识两见',
      poem: '晨光未满，廊影先醒。双目初开，世界便有了两面。'
    };
  })(),

  // ========== 2 双桥之惑 · 主解：假台诱饵链（独占；末段真假分叉）=====###
  (function () {
    const nodes = [].concat(
      room(0, 3, 0, 3, 0, [[1, 1], [2, 2]], { body: 1.2 }),
      [P(4, 0, 1, { phase: '2d', body: 1.2 }), P(5, 0, 1, { phase: '2d', body: 1.2 })],
      // 北假台链删除：旧飞边已废；末段真假由 qeGate 甲假乙真几何承担
      room(6, 9, 0, 3, 0, [[7, 1], [8, 2]], { body: 1.2 }),
      // 挖空 (9,5) 让墙体 [9,1,5] 落在空位（原 slab 多填了 room(8,11,4,6,1,[[9,5]]) 的挖空格）
      slab(6, 7, 4, 5, 1, { body: 2 }),
      room(8, 11, 4, 6, 1, [[9, 5]], { body: 2 }),
      [P(12, 1, 5, { phase: '2d', body: 2 }), P(13, 1, 5, { phase: '2d', body: 2 })],
      room(14, 17, 4, 6, 1, [[15, 5], [16, 4]], { body: 2 }),
      // 南实抬真路（北假捷径改由闸上甲向几何假砖）
      slab(15, 17, 7, 8, 2, { body: 2 }),
      // 挖 (18,11) 给甲假 midFoot 留空，使闸上假砖可走上去再坠
      room(15, 18, 9, 11, 3, [[18, 11]], { body: 3 })
    );
    const gate = qeGate('jiaYi', {
      ax: 17, ay: 3, az: 11
    });
    nodes.push.apply(nodes, gate.nodes);
    nodes.push(P(15, 5, 15, { body: 5 }), P(14, 5, 15, { body: 5 }), P(14, 5, 16, { body: 5 }));
    nodes.push.apply(nodes, slab(0, 2, 4, 5, 0, { body: 1.2 }));
    nodes.push(P(1, 1, 6, { body: 2 }), P(1, 2, 7, { body: 2 }));
    const walls = [[1, 0, 1, 0.32], [7, 0, 1, 1.3], [8, 0, 2, 0.32], [9, 1, 5, 1.3], [15, 1, 5, 1.3]];
    const spawn = nearIn(nodes, 0, 3, 0, 3, 0) || [3, 0, 3];
    const rotors = [], gears = [];
    takeGear(alcoveGear(nodes, 0, 0, 0, 'n', '建筑师留言·二：一桥渡水，一桥渡疑。亮处未必可托足；暗里一转，真假易位。', { rotorId: 'rs2', gearId: 'gs2' }), rotors, gears);
    flagKey(nodes, 9, 0, 0, 1);
    flagKey(nodes, 17, 1, 4, 2);
    return {
      name: '第二章 · 双桥之惑', sub: 'TWO BRIDGES',
      hint: '青桥进厅 · 北假台勿踩 · 末段北捷径仍假 · 星屑按①→②拾 · 终台前 Q/E：甲向假台、乙向真浮砖 · 北侧齿轮通碑',
      bg: '#a9cbd8',
      pal: { top: 0xf6f3ea, side: 0x5f9ea0, goal: 0xe8b84b, accent: 0x3fbfae, char: 0xffffff },
      nodes: nodes, walls: walls,
      rotors: rotors, gears: gears, dials: [],
      start: spawn, goal: [14, 5, 16], goalNeed: 2,
      keyOrder: true,
      tutorial: true,
      viewSnaps: gate.viewSnaps,
      illusionPairsAt: gate.illusionPairsAt,
      par: 3,
      illusionPairs: [],
      story: '虚台亦戒',
      poem: '一桥渡水，一桥渡疑。捷径愈亮，托力愈虚。'
    };
  })(),

  // ========== 3 明暗双城 · 主解：金青交替 + 序星 + 错色诱饵（独占）=====###
  (function () {
    const nodes = [].concat(
      room(0, 3, 0, 3, 0, [[1, 1], [2, 2]], { body: 1.2 }),
      [P(4, 0, 1, { phase: '3d', body: 1.2 }), P(5, 0, 1, { phase: '3d', body: 1.2 })],
      room(6, 9, 0, 3, 0, [[7, 1], [8, 2]], { body: 1.2 }),
      // 旧飞边假台已废；甲假改由末段 qeGate 几何承担
      slab(6, 9, 4, 5, 1, { body: 2 }),
      [P(10, 1, 4, { phase: '3d', body: 2 }), P(11, 1, 4, { phase: '3d', body: 2 })],
      room(12, 14, 3, 5, 1, [[13, 4]], { body: 2 }),
      [P(15, 1, 4, { rotor: 'r3' }), P(16, 1, 4, { rotor: 'r3' }), P(17, 1, 4, { rotor: 'r3' })],
      room(18, 21, 3, 5, 1, [[19, 4], [20, 3]], { body: 2 }),
      // 假「青桥」南向：3D 同高可走，切俯视即坠（真青桥在 x=18）
      [P(19, 1, 6, { drop: true, decoy: true, body: 2 }), P(19, 1, 7, { drop: true, decoy: true, body: 2 })],
      // 真青桥北拐
      [P(18, 1, 6, { phase: '2d', body: 2 }), P(18, 1, 7, { phase: '2d', body: 2 })],
      slab(17, 20, 8, 10, 1, { body: 2 }),
      slab(20, 23, 6, 8, 2, { body: 2 }),
      [P(22, 3, 9, { body: 3 })],
      // 末段假对齐台
      [P(23, 3, 8, { drop: true, decoy: true, body: 3 }), P(24, 4, 8, { drop: true, decoy: true, body: 4 })],
      // 挖空 (23,10) 让墙体 [23,4,10] 落在空位（原 slab 多填了 room(22,25,9,12,4,[[23,10]]) 的挖空格）
      slab(21, 21, 9, 11, 4, { body: 4 }),
      room(22, 25, 9, 12, 4, [[23, 10], [24, 11]], { body: 4 }),
      [P(24, 5, 11, { body: 5 })],
      [P(24, 5, 12, { body: 5 })]
    );
    const gate = qeGate('jiaYiLong', {
      ax: 24, ay: 5, az: 12
    });
    nodes.push.apply(nodes, gate.nodes);
    nodes.push(P(21, 8, 18, { body: 8 }), P(20, 8, 18, { body: 8 }), P(20, 8, 19, { body: 8 }));
    const walls = [
      [1, 0, 1, 0.32], [7, 0, 1, 1.3], [8, 0, 2, 0.32], [13, 1, 4, 1.3], [19, 1, 4, 1.3], [23, 4, 10, 1.3]
    ];
    const spawn = nearIn(nodes, 0, 3, 0, 3, 0) || [3, 0, 3];
    flagKey(nodes, 9, 0, 0, 1);
    flagKey(nodes, 19, 1, 9, 2);
    alcove2d(nodes, 0, 0, 0, 'n', '建筑师留言·三：金留其高，青请俯首。色同不必路同；见所未见，方是第三重影。');
    return {
      name: '第三章 · 明暗双城', sub: 'LIGHT AND SHADOW',
      hint: '金桥留 3D · 真青桥北拐 · 星屑按序 · 终台前 Q/E：甲向假链、乙向两段真浮砖 · 北侧青桥通碑',
      bg: '#c9b8d8',
      pal: { top: 0xf3eee9, side: 0x8a7ba6, goal: 0xe8b84b, accent: 0x3fbfae, char: 0xffffff },
      nodes: nodes, walls: walls,
      rotors: [{ id: 'r3', pivot: [16, 1, 4], angle0: 90 }],
      gears: [{ id: 'g3', rotor: 'r3', teeth: 12, pos: [15.2, 2.4, 5.2] }],
      dials: [],
      start: spawn, goal: [20, 8, 19], goalNeed: 2,
      keyOrder: true,
      gearGated: true,
      viewSnaps: gate.viewSnaps,
      illusionPairsAt: gate.illusionPairsAt,
      par: 5,
      illusionPairs: [],
      story: '色即门扉',
      poem: '色同不必路同。金青之外，还有第三重眉目。'
    };
  })(),

  // ========== 4 碑之谷 · 主解：墙迷宫 + 南北双谷汇合（独占；碑旁齿轮）=====###
  (function () {
    const nodes = [].concat(
      room(0, 4, 0, 3, 0, [[1, 1], [2, 2], [3, 1]], { body: 1.2 }),
      // 墙迷宫中庭（探索为主，仅一处青桥出谷）
      room(5, 10, 0, 4, 0, [[6, 1], [7, 2], [8, 1], [8, 3], [9, 2]], { body: 1.2 }),
      [P(11, 0, 2, { phase: '2d', body: 1.2 }), P(12, 0, 2, { phase: '2d', body: 1.2 })],
      room(13, 16, 1, 3, 0, [[14, 2]], { body: 1.2 }),
      // 南谷：低线墙隙绕行（无第二青桥）
      slab(5, 7, -2, -1, 0, { body: 1.2 }),
      room(8, 11, -3, -1, 0, [[9, -2], [10, -1]], { body: 1.2 }),
      // 假岔删除（旧飞边已废）；南谷仍汇入中庭
      [P(12, 0, -1, { body: 1.2 }), P(13, 1, 0, { body: 2 }), P(13, 1, 1, { body: 2 })],
      // 北抬台
      slab(6, 9, 5, 6, 1, { body: 2 }),
      room(10, 14, 5, 8, 2, [[11, 6], [12, 7], [13, 6]], { body: 2 }),
      // 南谷汇入中庭
      [P(13, 2, 3, { body: 2 }), P(13, 2, 4, { body: 2 })],
      // 东死廊：从中庭东缘探出，不通终点
      [P(17, 0, 2, { body: 1.2 }), P(18, 0, 2, { body: 1.2 }), P(19, 0, 2, { body: 1.2 }), P(19, 1, 2, { body: 2 })],
      slab(11, 14, 9, 11, 3, { body: 3 }),
      [P(14, 5, 11, { body: 4 })],
      slab(15, 18, 10, 13, 5, { body: 4 })
    );
    // Q/E 甲假乙真分叉：假二段落在南缘，不与终台邻接（防甲向假路直通）
    const gate = qeGate('jiaYiFork', {
      ax: 17, ay: 5, az: 12
    });
    nodes.push.apply(nodes, gate.nodes);
    nodes.push(P(15, 7, 16, { body: 7 }), P(14, 7, 16, { body: 7 }), P(14, 7, 17, { body: 7 }));
    const walls = [
      [1, 0, 1, 0.32], [2, 0, 2, 0.32], [6, 0, 1, 1.3], [7, 0, 2, 1.3], [8, 0, 1, 1.3], [8, 0, 3, 0.32],
      [9, 0, 2, 1.3], [14, 0, 2, 1.3], [11, 2, 6, 1.3], [12, 2, 7, 0.32], [13, 2, 6, 1.3]
    ];
    const spawn = nearIn(nodes, 0, 4, 0, 3, 0) || [4, 0, 3];
    const rotors = [], gears = [];
    takeGear(alcoveGear(nodes, 0, 0, 0, 'n', '建筑师留言·四：谷风过碑，字在风里。南谷可绕，中廊可穿；殊途之处，往往同归。', { rotorId: 'rs4', gearId: 'gs4' }), rotors, gears);
    flagKey(nodes, 16, 0, 1, 1);
    flagKey(nodes, 11, 3, 10, 2);
    return {
      name: '第四章 · 碑之谷', sub: 'THE STELES',
      hint: '墙迷宫穿行 · 谷口青桥或南谷低线绕行均可进中庭 · 星屑按①→②拾 · 南假岔切俯视会坠 · 东死廊不通终点 · 终台前 Q/E：甲向假分叉（南缘）/ 乙向真浮砖 · 北侧齿轮通碑',
      bg: '#d8c9a9',
      pal: { top: 0xf6f0e2, side: 0xa68b5f, goal: 0xe8b84b, accent: 0x3fbfae, char: 0xffffff },
      nodes: nodes, walls: walls,
      rotors: rotors, gears: gears, dials: [],
      start: spawn, goal: [14, 7, 17], goalNeed: 2,
      keyOrder: true,
      viewSnaps: gate.viewSnaps,
      illusionPairsAt: gate.illusionPairsAt,
      illusionPairs: [],
      par: 3,
      story: '碑指向光',
      poem: '谷中立碑，字比路短。双谷同归，死廊止步。'
    };
  })(),

  // ========== 5 长桥回转 · 主解：齿轮角门控（独占；错角死路 + 南绕长径）=====###
  (function () {
    const nodes = [].concat(
      room(0, 3, 0, 3, 0, [[1, 1], [2, 2]], { body: 1.2 }),
      // 入口改攀高（与青桥开局错开）
      [P(4, 0, 1, { body: 1.2 }), P(5, 1, 1, { body: 2.4 })],
      room(6, 9, 0, 3, 1, [[7, 1], [8, 2]], { body: 2 }),
      slab(7, 9, 4, 4, 2, { body: 2 }),
      [P(9, 2, 5, { body: 2 })],
      [P(10, 2, 5, { rotor: 'r1' }), P(11, 2, 5, { rotor: 'r1' }), P(12, 2, 5, { rotor: 'r1' })],
      // 错角死路岛：90°/270° 时转子扫到，但不通往终点
      [P(11, 2, 3, { body: 2 }), P(11, 2, 7, { body: 2 }),
       P(10, 2, 3, { drop: true, decoy: true, body: 3 }), P(12, 2, 7, { drop: true, decoy: true, body: 3 })],
      room(13, 16, 4, 7, 2, [[14, 5], [15, 6]], { body: 2 }),
      [P(17, 2, 5, { phase: '2d', body: 2 }), P(18, 2, 5, { phase: '2d', body: 2 })],
      room(19, 21, 4, 6, 2, [[20, 5]], { body: 2 }),
      slab(22, 24, 5, 7, 3, { body: 3 }),
      // 南绕长径：不转齿轮亦可抵达（更长、须多次切视角）—— 殊途同归
      slab(6, 8, -2, -1, 1, { body: 2 }),
      [P(9, 1, -1, { phase: '2d', body: 2 }), P(10, 1, -1, { phase: '2d', body: 2 })],
      room(11, 14, -2, 0, 1, [[12, -1]], { body: 2 }),
      [P(15, 2, -1, { body: 2 }), P(16, 2, 1, { body: 2 }), P(17, 2, 3, { body: 2 })],
      [P(18, 2, 4, { body: 2 })] // 邻接东厅 (19,2,4)
    );
    // Q/E 甲假乙真加长过谷：齿轮/南绕汇合后再转乙向
    const gate = qeGate('jiaYiLong', {
      ax: 24, ay: 3, az: 6
    });
    nodes.push.apply(nodes, gate.nodes);
    nodes.push(P(21, 6, 12, { body: 6 }), P(20, 6, 12, { body: 6 }), P(20, 6, 13, { body: 6 }));
    const walls = [
      [1, 0, 1, 0.32], [7, 1, 1, 1.3], [8, 1, 2, 0.32], [14, 2, 5, 1.3],
      [20, 2, 5, 1.3], [12, 1, -1, 1.3]
    ];
    const spawn = nearIn(nodes, 0, 3, 0, 3, 0) || [3, 0, 3];
    alcove3d(nodes, 0, 0, 0, 'n', '建筑师留言·五：石桥回旋如针。平直之时，深谷才肯让路；南径更长，亦是一条。');
    flagKey(nodes, 9, 1, 0, 1);
    flagKey(nodes, 16, 2, 4, 2);
    return {
      name: '第五章 · 长桥回转', sub: 'THE ROTOR',
      hint: '齿轮转到桥平（0°/180°）过谷，或南青桥长绕不转轮 · 星屑按①→②拾 · 错角只通死路/假台 · 终台前 Q/E 甲假乙真加长链 · 北侧金桥通碑',
      bg: '#4e5d6e',
      pal: { top: 0xefece2, side: 0x5a6b84, goal: 0xe8b84b, accent: 0xd8a94e, char: 0xffffff },
      nodes: nodes, walls: walls,
      rotors: [{ id: 'r1', pivot: [11, 2, 5], angle0: 90 }],
      gears: [{ id: 'g1', rotor: 'r1', teeth: 12 }],
      dials: [],
      start: spawn, goal: [20, 6, 13], goalNeed: 2,
      keyOrder: true,
      gearGated: true,
      viewSnaps: gate.viewSnaps,
      illusionPairsAt: gate.illusionPairsAt,
      illusionPairs: [],
      par: 3,
      story: '桥平路显',
      poem: '石桥回旋如针。平直之时，深谷才肯让路。南径更长，亦是一条。'
    };
  })(),

  // ========== 6 环之心 · 主解：环升双径（独占；无序星、无齿轮）=====###
  (function () {
    const nodes = [].concat(
      room(0, 3, 0, 3, 0, [[1, 1], [2, 2]], { body: 1.2 }),
      // 内环：顺时针攀升（主径）
      [P(4, 0, 1, { body: 1.2 })],
      room(5, 8, 0, 3, 1, [[6, 1], [7, 2]], { body: 2 }),
      slab(6, 8, 4, 4, 2, { body: 2 }),
      room(7, 10, 5, 8, 2, [[8, 6], [9, 7]], { body: 2 }),
      room(5, 9, 8, 11, 3, [[6, 9], [7, 10], [8, 9]], { body: 3 }),
      // 中段强制青桥（破纯攀）
      [P(4, 3, 9, { phase: '2d', body: 3 }), P(3, 3, 9, { phase: '2d', body: 3 })],
      // 挖空 (1,9) 让墙体 [1,3,9] 落在空位
      room(0, 2, 8, 11, 3, [[1, 9]], { body: 3 }),
      slab(0, 3, 11, 13, 4, { body: 4 }),
      slab(0, 2, 14, 15, 5, { body: 5 }),
      // 外环殊途：西向金桥捷径，跳过半圈攀升，汇入青桥西岸 slab(0,2,8,11,3)
      slab(-1, -1, 1, 2, 0, { body: 1.2 }),
      [P(-2, 0, 1, { phase: '3d', body: 1.2 }), P(-3, 0, 1, { phase: '3d', body: 1.2 })],
      room(-6, -4, 0, 3, 0, [[-5, 1]], { body: 1.2 }),
      [P(-5, 1, 3, { body: 2 }), P(-4, 2, 4, { body: 2 })],
      slab(-4, -1, 6, 8, 3, { body: 3 }),
      [P(-1, 3, 9, { body: 3 })], // 邻接主环 (0,3,9)
      // 假台诱饵：3D 像能抄近路上环顶，俯视即坠
      [P(8, 4, 7, { drop: true, decoy: true, body: 4 }),
       P(6, 5, 9, { drop: true, decoy: true, body: 5 }) // 假台(3D错觉)
      ]
    );
    // Q/E 甲假乙真加长外缘：环顶两段真浮砖登心
    const gate = qeGate('jiaYiLong', {
      ax: 1, ay: 5, az: 15
    });
    nodes.push.apply(nodes, gate.nodes);
    nodes.push(P(-2, 8, 21, { body: 8 }), P(-3, 8, 21, { body: 8 }), P(-3, 8, 22, { body: 8 }));
    const walls = [
      [1, 0, 1, 0.32], [6, 1, 1, 1.3], [7, 1, 2, 0.32], [8, 2, 6, 1.3],
      [6, 3, 9, 1.3], [1, 3, 9, 0.32], [-5, 0, 1, 1.3]
    ];
    const spawn = nearIn(nodes, 0, 3, 0, 3, 0) || [3, 0, 3];
    flagKey(nodes, 8, 1, 0, 1);
    flagKey(nodes, 1, 4, 12, 2);
    alcove3d(nodes, 0, 0, 0, 'n', '建筑师留言·六：环行不休，心在正中。外环看似捷径，走完仍是一圈。');
    return {
      name: '第六章 · 环之心', sub: 'THE RING HEART',
      hint: '内环攀升，或西金桥外环捷径，殊途同归 · 星屑按①→②拾 · 中段青桥须俯视 · 环顶 Q/E 甲假乙真加长链 · 北侧金桥通碑',
      bg: '#b8d0c0',
      pal: { top: 0xf2f0e6, side: 0x6f9b84, goal: 0xe8b84b, accent: 0x3fbfae, char: 0xffffff },
      nodes: nodes, walls: walls,
      rotors: [], gears: [], dials: [],
      start: spawn, goal: [-3, 8, 22], goalNeed: 2,
      keyOrder: true,
      viewSnaps: gate.viewSnaps,
      illusionPairsAt: gate.illusionPairsAt,
      illusionPairs: [],
      par: 3,
      story: '出环见心',
      poem: '环行不休，心在正中。外环捷径，仍是一圈。'
    };
  })(),

  // ========== 7 拾星 · 主解：三臂序星 + 假臂诱饵（独占）=====###
  (function () {
    const hub = room(0, 4, 0, 4, 0, [[1, 1], [2, 2], [3, 1]], { body: 1.2 });
    const east = [].concat(
      slab(5, 7, 0, 2, 1, { body: 2 }),
      [P(8, 1, 1, { phase: '2d', body: 2 }), P(9, 1, 1, { phase: '2d', body: 2 })],
      room(10, 13, 0, 2, 1, [[11, 1]], { body: 2 }),
      [P(12, 3, 3, { body: 3 })],
      // 东假臂：看起来像「更近的星」，实为悬崖
      [P(12, 2, -1, { drop: true, decoy: true, body: 3 }),
       P(13, 3, -2, { drop: true, decoy: true, body: 3 }) // 假台(3D错觉)
      ]
    );
    const south = [].concat(
      slab(0, 2, 5, 7, 1, { body: 2 }),
      [P(1, 1, 8, { body: 2 }), P(1, 2, 9, { body: 3 }), P(1, 2, 10, { body: 3 })],
      room(0, 2, 10, 12, 2, [[1, 11], [1, 10]], { body: 2 }),
      [P(3, 3, 12, { body: 3 })],
      // 南假臂：3D 对齐诱向死台
      [P(4, 3, 11, { drop: true, decoy: true, body: 3 }), // 假台(3D错觉)
       P(5, 4, 12, { drop: true, decoy: true, body: 4 }) // 假台(3D错觉)
      ]
    );
    const west = [].concat(
      slab(-3, -1, 0, 2, 1, { body: 2 }),
      [P(-4, 1, 1, { phase: '3d', body: 2 }), P(-5, 1, 1, { phase: '3d', body: 2 })],
      room(-8, -6, 0, 3, 1, [[-7, 1]], { body: 2 }),
      [P(-8, 3, 4, { body: 3 })],
      // 西北废臂：无星，仅石碑旁支感
      slab(-3, -1, 3, 5, 1, { body: 2 }),
      [P(-4, 2, 5, { body: 2 })]
    );
    const shrine = [].concat(
      [P(5, 0, 4, { phase: '3d', body: 1.2 }), P(6, 0, 4, { phase: '3d', body: 1.2 })],
      room(7, 11, 3, 6, 0, [[8, 4], [9, 3], [10, 5]], { body: 1.2 }),
      [P(9, 2, 5, { body: 2 }), P(10, 2, 5, { body: 2 }), P(11, 3, 5, { body: 3 })]
    );
    const nodes = [].concat(hub, east, south, west, shrine);
    // Q/E 甲假乙真加长接祭坛：聚星后再转乙向，两段真浮砖入金环
    const gate = qeGate('jiaYiLong', {
      ax: 11, ay: 3, az: 5
    });
    nodes.push.apply(nodes, gate.nodes);
    nodes.push(P(8, 6, 11, { body: 6 }), P(7, 6, 11, { body: 6 }), P(7, 6, 12, { body: 6 }));
    const walls = [
      [1, 0, 1, 0.32], [2, 0, 2, 0.32], [11, 1, 1, 1.3], [1, 2, 11, 1.3],
      [-7, 1, 1, 1.3], [8, 0, 4, 1.3], [10, 0, 5, 0.32]
    ];
    const spawn = nearIn(nodes, 0, 4, 0, 4, 0) || [4, 0, 4];
    say(nodes, -8, 3, 4, '建筑师留言·七：星散三野，聚则成辰。假臂徒伸，真星只认次序。');
    flagKey(nodes, 12, 3, 3, 1);
    flagKey(nodes, 3, 3, 12, 2);
    flagKey(nodes, -8, 3, 4, 3);
    return {
      name: '第七章 · 拾星', sub: 'THE GATHERING',
      hint: '三臂须按序：①东青桥 → ②南攀高 → ③西金桥 · 各臂旁假台/废臂无星 · 祭坛前 Q/E 甲假乙真加长链入金环',
      bg: '#e8d0c0',
      pal: { top: 0xfbf2e4, side: 0xc98a6a, goal: 0xe8b84b, accent: 0x3fbfae, char: 0xffffff },
      nodes: nodes, walls: walls,
      rotors: [], gears: [], dials: [],
      start: spawn, goal: [7, 6, 12], goalNeed: 3,
      keyOrder: true,
      viewSnaps: gate.viewSnaps,
      illusionPairsAt: gate.illusionPairsAt,
      illusionPairs: [],
      par: 7,
      story: '星归掌心',
      poem: '三臂伸向夜空。假臂诱人，真星只认次序。'
    };
  })(),

  // ========== 8 幻墙长谷 · 主解：金桥长谷 + 假台真假交替 + 双径（独占）=====###
  (function () {
    const nodes = [].concat(
      room(0, 4, 0, 3, 0, [[1, 1], [2, 2], [3, 1]], { body: 1.2 }),
      [P(5, 0, 1, { phase: '3d', body: 1.2 }), P(6, 0, 1, { phase: '3d', body: 1.2 })],
      room(7, 10, 0, 3, 0, [[8, 1], [9, 2]], { body: 1.2 }),
      // 假台段一
      [P(8, 2, -1, { drop: true, decoy: true, body: 3 }), P(9, 2, -1, { drop: true, decoy: true, body: 3 }),
       P(10, 3, -2, { drop: true, decoy: true, body: 3 }) // 假台(3D错觉)
      ],
      slab(7, 10, 4, 5, 1, { body: 2 }),
      [P(11, 1, 4, { phase: '3d', body: 2 }), P(12, 1, 4, { phase: '3d', body: 2 })],
      room(13, 16, 3, 5, 1, [[14, 4], [15, 3]], { body: 2 }),
      // 假台段二
      [P(14, 3, 2, { drop: true, decoy: true, body: 3 }), P(15, 3, 2, { drop: true, decoy: true, body: 3 })],
      // 南线：青桥低谷
      slab(0, 3, 4, 6, 0, { body: 1.2 }),
      [P(4, 0, 6, { phase: '2d', body: 1.2 }), P(5, 0, 6, { phase: '2d', body: 1.2 })],
      slab(6, 9, 5, 7, 0, { body: 1.2 }),
      [P(9, 1, 7, { body: 2 }), P(10, 1, 7, { body: 2 }), P(11, 1, 6, { body: 2 })],
      room(12, 16, 6, 9, 1, [[13, 7], [14, 8]], { body: 2 }),
      // 南线假抬：像能直通高台，实为崖
      [P(15, 3, 9, { drop: true, decoy: true, body: 3 }), P(16, 4, 10, { drop: true, decoy: true, body: 4 })],
      // 北线续抬
      [P(16, 2, 5, { body: 2 })],
      slab(16, 19, 6, 9, 3, { body: 3 }),
      room(20, 23, 7, 10, 4, [[21, 8], [22, 9]], { body: 4 }),
      // 假台段三：金桥旁「捷径」
      [P(23, 5, 6, { drop: true, decoy: true, body: 4 }), P(24, 6, 6, { drop: true, decoy: true, body: 5 })],
      [P(24, 4, 8, { phase: '3d', body: 4 }), P(25, 4, 8, { phase: '3d', body: 4 })],
      room(26, 29, 7, 11, 4, [[27, 9], [28, 8]], { body: 4 }),
      // 挖空 (28,13) 让墙体 [28,6,13] 落在空位（原 slab 多填了 room(27,30,12,14,6,[[28,13]]) 的挖空格）
      slab(26, 29, 10, 11, 6, { body: 5 }),
      room(27, 30, 12, 14, 6, [[28, 13]], { body: 5 })
    );
    // Q/E 甲假乙真加长链：长谷尽处两段真浮砖
    const gate = qeGate('jiaYiLong', {
      ax: 29, ay: 6, az: 14
    });
    nodes.push.apply(nodes, gate.nodes);
    nodes.push(P(26, 9, 20, { body: 9 }), P(25, 9, 20, { body: 9 }), P(25, 9, 21, { body: 9 }));
    const walls = [
      [1, 0, 1, 0.32], [8, 0, 1, 1.3], [9, 0, 2, 0.32], [14, 1, 4, 1.3],
      [13, 1, 7, 1.3], [21, 4, 8, 1.3], [22, 4, 9, 0.32], [28, 6, 13, 1.3]
    ];
    const spawn = nearIn(nodes, 0, 4, 0, 3, 0) || [4, 0, 3];
    flagKey(nodes, 10, 0, 0, 1);
    flagKey(nodes, 16, 3, 6, 2);
    alcoveClimb(nodes, 0, 0, 0, 'w', '建筑师留言·八：墙是影，影是墙。足下若虚，一步便成空；心若有定，长谷亦可渡。');
    return {
      name: '第八章 · 幻墙长谷', sub: 'THE LONG RIFT',
      hint: '北金桥或南青桥殊途 · 星屑按①→②拾 · 三段假台切俯视会坠 · 末段金桥回 3D · 终厅前 Q/E 甲假乙真加长链 · 西侧高台有碑',
      bg: '#8a9bb8',
      pal: { top: 0xeef0f2, side: 0x5a6b8c, goal: 0xe8b84b, accent: 0x3fbfae, char: 0xffffff },
      nodes: nodes, walls: walls,
      rotors: [], gears: [], dials: [],
      start: spawn, goal: [25, 9, 21], goalNeed: 2,
      keyOrder: true,
      viewSnaps: gate.viewSnaps,
      illusionPairsAt: gate.illusionPairsAt,
      par: 7,
      illusionPairs: [],
      story: '二者迭渡',
      poem: '三段假台，一步成空。心若有定，长谷亦可渡。'
    };
  })(),

  // ========== 9 方位之谜 · 主解：甲乙丙三向错位解密（独占 · triLong 宽度峰值）=====###
  (function () {
    // 前半：攀升 + 青桥进闸前厅；末段 qeGate(triLong) 强制甲假 / 乙迁 / 丙真。
    // 浮砖落在甲/乙/丙投影升步上（画面连续），不靠 pairsAt 飞砖。
    const nodes = [].concat(
      room(0, 4, 0, 3, 0, [[1, 1], [2, 2], [3, 1]], { body: 1.2 }),
      [P(5, 0, 1, { body: 1.2 }), P(6, 1, 1, { body: 2 })],
      room(7, 11, 0, 2, 1, [[8, 1], [9, 0]], { body: 2 }),
      // 金桥东延（须 3D）—— 杀纯 2D 直通
      [P(12, 1, 1, { phase: '3d', body: 2 }), P(13, 1, 1, { phase: '3d', body: 2 })],
      room(14, 17, 0, 2, 1, [[15, 1]], { body: 2 }),
      // 南折抬升至闸前（z 抬高，给丙真东南落脚留空）
      slab(15, 18, 3, 5, 2, { body: 2 }),
      [P(18, 3, 5, { body: 3 })],
      // [22,5] 挖空：否则占住 A→丙真T1 的 midFoot，错觉升步被挡
      room(19, 22, 4, 6, 4, [[20, 5], [22, 5]], { body: 3 }),
      // 诱饵：甲向几何诱入 / 南缘假台（贴 T1 旁，勿占 21,5,3 midFoot）
      [P(16, 3, 0, { drop: true, decoy: true, body: 3 }), // 假台(3D错觉)
       P(22, 5, 4, { drop: true, decoy: true, body: 4 }),
       P(23, 5, 5, { drop: true, decoy: true, body: 4 })]
    );
    const gate = qeGate('triLong', {
      ax: 22, ay: 4, az: 6
    });
    nodes.push.apply(nodes, gate.nodes);
    // 终点台：保留 gate.land (19,7,0)，向北延伸，避免与 y1 东厅脚印 (17,0) 在 2D 相邻直翻
    nodes.push(P(19, 7, 0, { body: 7 }), P(19, 7, -1, { body: 7 }), P(19, 7, -2, { body: 7 }));
    const walls = [
      [1, 0, 1, 0.32], [2, 0, 2, 0.32], [8, 1, 1, 1.3], [15, 1, 1, 1.3], [20, 4, 5, 1.3]
    ];
    const spawn = nearIn(nodes, 0, 4, 0, 3, 0) || [4, 0, 3];
    flagKey(nodes, 17, 1, 0, 1);
    flagKey(nodes, 22, 4, 4, 2);
    alcove2d(nodes, 0, 0, 0, 'n', '建筑师留言·九：三面同砖，各认各的路。所转即所通，所迷亦在转。');
    return {
      name: '第九章 · 方位之谜', sub: 'THE ASPECT RIDDLE',
      hint: '攀升过金桥至闸前（须 3D） · 星屑按①→②拾 · Q/E 甲假乙迁丙真加长链：甲向是影、乙向死胡同、丙向两段真浮砖才通 · 诱饵切俯视会坠 · 北侧青桥通碑 · 3D 错位方可抵达终点',
      bg: '#d8b8b0',
      pal: { top: 0xf8efe8, side: 0xb87a6a, goal: 0xe8b84b, accent: 0x3fbfae, char: 0xffffff },
      nodes: nodes, walls: walls,
      rotors: [], gears: [], dials: [],
      start: spawn, goal: [19, 7, -2], goalNeed: 2,
      keyOrder: true,
      viewSnaps: gate.viewSnaps,
      illusionPairsAt: gate.illusionPairsAt,
      illusionPairs: [],
      par: 3,
      story: '面面相觑',
      poem: '三面同砖，各认各的路。所转即所通，所迷亦在转。'
    };
  })(),

  // ========== 10 归途 · 灯塔 · 主解：序星 + 双终径 + 假灯廊（独占）=====###
  (function () {
    const nodes = [].concat(
      room(0, 4, 0, 3, 0, [[1, 1], [2, 2], [3, 1]], { body: 1.2 }),
      [P(5, 0, 1, { phase: '2d', body: 1.2 }), P(6, 0, 1, { phase: '2d', body: 1.2 })],
      room(7, 11, 0, 3, 0, [[8, 1], [9, 2], [10, 1]], { body: 1.2 }),
      slab(7, 11, 4, 5, 1, { body: 2 }),
      [P(12, 1, 4, { phase: '3d', body: 2 }), P(13, 1, 4, { phase: '3d', body: 2 })],
      room(14, 17, 3, 5, 1, [[15, 4], [16, 3]], { body: 2 }),
      slab(14, 17, 6, 7, 2, { body: 2 }),
      room(15, 19, 7, 10, 4, [[16, 8], [17, 9], [18, 8]], { body: 3 }),
      // 假灯廊北岔：像能抄近路，实为悬崖
      [P(18, 5, 6, { drop: true, decoy: true, body: 4 }),
       P(19, 6, 5, { drop: true, decoy: true, body: 4 }) // 假台(3D错觉)
      ],
      // 主径：青桥进灯廊
      [P(20, 4, 8, { phase: '2d', body: 4 }), P(21, 4, 8, { phase: '2d', body: 4 })],
      room(22, 25, 7, 10, 4, [[23, 8], [24, 9]], { body: 4 }),
      // 南岔终径：浮砖对齐捷径
      [P(19, 4, 11, { body: 3 }), P(21, 5, 12, { body: 4 }), P(23, 5, 13, { body: 4 })],
      // 南岔旁假台
      [P(22, 6, 14, { drop: true, decoy: true, body: 5 }) // 假台(3D错觉)
      ],
      // 挖空 (28,11) 让墙体 [28,5,11] 落在空位
      slab(26, 30, 8, 8, 5, { body: 5 }),
      slab(26, 26, 9, 12, 5, { body: 5 }),
      [P(30, 5, 10, { body: 5 })],
      room(27, 31, 9, 13, 5, [[28, 11], [30, 10]], { body: 5 }),
      [P(30, 6, 12, { body: 6 })],
      [P(30, 6, 13, { body: 6 })]
    );
    // Q/E 甲假乙真加长登灯：双终径汇合后再转乙向，两段真浮砖
    const gate = qeGate('jiaYiLong', {
      ax: 30, ay: 6, az: 13
    });
    nodes.push.apply(nodes, gate.nodes);
    nodes.push(P(27, 9, 19, { body: 9 }), P(26, 9, 19, { body: 9 }), P(26, 9, 20, { body: 9 }));
    const walls = [
      [1, 0, 1, 0.32], [8, 0, 1, 1.3], [9, 0, 2, 0.32], [10, 0, 1, 1.3],
      [15, 1, 4, 1.3], [16, 4, 8, 1.3], [23, 4, 8, 1.3], [28, 5, 11, 1.3]
    ];
    const spawn = nearIn(nodes, 0, 4, 0, 3, 0) || [4, 0, 3];
    flagKey(nodes, 11, 0, 0, 1);
    flagKey(nodes, 16, 1, 4, 2);
    flagKey(nodes, 19, 4, 7, 3);
    alcoveClimb(nodes, 22, 4, 7, 'n', '建筑师留言·十：灯燃之处，是来时的倒影。假廊愈亮，家门愈远；真途常在灯影之外。', 4, 5);
    return {
      name: '第十章 · 归途 · 灯塔', sub: 'THE LIGHTHOUSE',
      hint: '星屑按序 ①西厅→②中廊→③灯前 · 登灯走青桥主径或南浮砖捷径 · 灯顶 Q/E 甲假乙真加长链 · 灯旁高台有终碑',
      bg: '#3a4a5e',
      pal: { top: 0xefece2, side: 0x4a5a70, goal: 0xe8b84b, accent: 0x3fbfae, char: 0xffffff },
      nodes: nodes, walls: walls,
      rotors: [], gears: [], dials: [],
      start: spawn, goal: [26, 9, 20], goalNeed: 3,
      keyOrder: true,
      viewSnaps: gate.viewSnaps,
      illusionPairsAt: gate.illusionPairsAt,
      illusionPairs: [],
      par: 5,
      story: '灯燃归途',
      poem: '灯燃之处，是来时的倒影。假廊愈亮，家门愈远。'
    };
  })(),

  // ========== 11 齿轮之心 · 主解：独立双轮门控 + 北塔双径（独占；与十二布局错开）=====###
  (function () {
    const nodes = [].concat(
      room(0, 3, 0, 3, 0, [[1, 1], [2, 2]], { body: 1.2 }),
      [P(4, 0, 1, { body: 1.2 }), P(5, 1, 1, { body: 2.4 })],
      room(6, 8, 0, 3, 1, [[6, 1], [7, 2]], { body: 2 }),
      [P(9, 1, 1, { rotor: 'r1' }), P(10, 1, 1, { rotor: 'r1' }), P(11, 1, 1, { rotor: 'r1' })],
      room(12, 14, 0, 3, 1, [[13, 1]], { body: 2 }),
      // 折北：第二轮在北廊（与第十二「直线双轮」错开）
      slab(12, 14, 4, 5, 2, { body: 2 }),
      [P(13, 2, 6, { body: 2 })],
      [P(13, 2, 7, { rotor: 'r2' }), P(13, 2, 8, { rotor: 'r2' }), P(13, 2, 9, { rotor: 'r2' })],
      room(11, 15, 9, 12, 2, [[12, 10], [14, 11], [13, 9]], { body: 2 }),
      [P(15, 3, 11, { body: 3 })],
      slab(14, 17, 10, 13, 4, { body: 3 }),
      // 西岔殊途：绕开第二轮，青桥长绕进北厅（更远）
      slab(6, 8, 4, 6, 1, { body: 2 }),
      [P(7, 1, 7, { phase: '2d', body: 2 }), P(7, 1, 8, { phase: '2d', body: 2 })],
      room(6, 9, 9, 11, 1, [[7, 10]], { body: 2 }),
      [P(9, 2, 10, { body: 2 }), P(10, 2, 10, { body: 2 })]
    );
    // Q/E 甲假乙真加长进塔
    const gate = qeGate('jiaYiLong', {
      ax: 16, ay: 4, az: 12
    });
    nodes.push.apply(nodes, gate.nodes);
    nodes.push(P(13, 7, 18, { body: 7 }), P(12, 7, 18, { body: 7 }), P(12, 7, 19, { body: 7 }));
    const walls = [
      [1, 0, 1, 0.32], [6, 1, 1, 1.3], [13, 1, 1, 1.3], [12, 2, 10, 1.3], [14, 2, 11, 1.3], [7, 1, 10, 1.3]
    ];
    const spawn = nearIn(nodes, 0, 3, 0, 3, 0) || [3, 0, 3];
    flagKey(nodes, 14, 1, 0, 1);
    flagKey(nodes, 11, 2, 12, 2);
    alcoveClimb(nodes, 0, 0, 0, 'w', '建筑师留言·十一：齿动石让。一格一格咬合，北塔才肯开门；西绕虽远，亦通塔下。');
    return {
      name: '第十一章 · 齿轮之心', sub: 'THE GEAR HEART',
      hint: '两轮各自转到 0°/180° 北折进塔，或西青桥长绕过第二轮 · 星屑按①→②拾 · 塔前 Q/E 甲假乙真加长链 · 西侧高台有碑',
      bg: '#c7b489',
      pal: { top: 0xf6eedd, side: 0xb0905c, goal: 0xe8b84b, accent: 0xd8a94e, char: 0xffffff },
      nodes: nodes, walls: walls,
      rotors: [
        { id: 'r1', pivot: [10, 1, 1], angle0: 90 },
        { id: 'r2', pivot: [13, 2, 8], angle0: 90 }
      ],
      gears: [
        { id: 'g1', rotor: 'r1', teeth: 12 },
        { id: 'g2', rotor: 'r2', teeth: 12, pos: [14.2, 3.4, 8.2] }
      ],
      dials: [],
      start: spawn, goal: [12, 7, 19], goalNeed: 2,
      keyOrder: true,
      gearGated: true,
      viewSnaps: gate.viewSnaps,
      illusionPairsAt: gate.illusionPairsAt,
      par: 3,
      story: '齿动石让',
      poem: '齿动石让。一格一格咬合，北塔才肯开门。'
    };
  })(),

  // ========== 12 咬合双轮 · 主解：12:6 反向联动 + 多层诱饵（独占；与十一北折错开）=====###
  (function () {
    const nodes = [].concat(
      room(0, 3, 0, 3, 0, [[1, 1], [2, 2]], { body: 1.2 }),
      [P(4, 0, 1, { phase: '2d', body: 1.2 }), P(5, 0, 1, { phase: '2d', body: 1.2 })],
      room(6, 8, 0, 3, 0, [[7, 1]], { body: 1.2 }),
      [P(8, 1, 1, { body: 2 })],
      [P(9, 1, 1, { rotor: 'r1' }), P(10, 1, 1, { rotor: 'r1' }), P(11, 1, 1, { rotor: 'r1' }), P(10, 1, 0, { rotor: 'r1' })],
      room(12, 14, 0, 3, 1, [[13, 1]], { body: 2 }),
      [P(15, 1, 1, { body: 2 })],
      // 诱饵链一：可及死路（上有碑）
      [P(16, 2, 1, { body: 2, decoy: true }), P(17, 2, 0, { body: 2, decoy: true }),
       P(18, 3, 0, { drop: true, decoy: true, body: 3 })],
      // 真路：第二轮（angle0=180 / 90° 时臂端落到 (19,2,2)，故厅内挖空该格防穿模）
      [P(17, 2, 2, { rotor: 'r2' }), P(18, 2, 2, { rotor: 'r2' }), P(18, 2, 3, { rotor: 'r2' })],
      room(19, 22, 1, 4, 2, [[20, 2], [21, 3], [19, 2]], { body: 2 }),
      // 诱饵链二：错角时扫到的「假出口」高台
      [P(20, 3, 0, { drop: true, decoy: true, body: 3 }), P(21, 3, 0, { drop: true, decoy: true, body: 3 })],
      slab(20, 23, 1, 4, 4, { body: 3 }),
      // 末段再折：南廊高差（破「直线冲终点」）
      slab(22, 24, 5, 7, 4, { body: 3 }),
      room(21, 25, 7, 9, 5, [[22, 8], [24, 8]], { body: 4 })
    );
    // Q/E 甲乙丙三向加重：咬合之后丙向才通
    const gate = qeGate('triLong', {
      ax: 25, ay: 5, az: 8
    });
    nodes.push.apply(nodes, gate.nodes);
    nodes.push(P(22, 8, 2, { body: 8 }), P(21, 8, 2, { body: 8 }), P(21, 8, 1, { body: 8 }));
    const walls = [
      [1, 0, 1, 0.32], [7, 0, 1, 1.3], [13, 1, 1, 1.3], [20, 2, 2, 1.3], [22, 5, 8, 1.3]
    ];
    const spawn = nearIn(nodes, 0, 3, 0, 3, 0) || [3, 0, 3];
    alcove3d(nodes, 0, 0, 0, 'n', '建筑师留言·十二：可及之处，未必可往。反向转动，或同归一岸；合拍之外，皆是影。');
    flagKey(nodes, 14, 1, 0, 1);
    // 星屑②：原 (19,2,2) 已挖给 r2 扫掠，改挂邻格 (19,2,3)（静砖、主路）
    flagKey(nodes, 19, 2, 3, 2);
    return {
      name: '第十二章 · 咬合双轮', sub: 'THE MESHED PAIR',
      hint: '青桥进厅 · 12:6 反向联动，桥平且对齐才通 · 星屑按①→②拾 · 北孤砖链与错角假出口皆诱饵 · 末段 Q/E 甲乙丙三向加重（丙向真路）',
      bg: '#9aa8b8',
      pal: { top: 0xf2f0e8, side: 0x6a7a96, goal: 0xe8b84b, accent: 0xd8a94e, char: 0xffffff },
      nodes: nodes, walls: walls,
      rotors: [
        { id: 'r1', pivot: [10, 1, 1], angle0: 90 },
        { id: 'r2', pivot: [18, 2, 2], angle0: 180 }
      ],
      gears: [
        { id: 'g1', rotor: 'r1', teeth: 12 },
        { id: 'g2', rotor: 'r2', teeth: 6, meshWith: 'g1' }
      ],
      dials: [],
      start: spawn, goal: [21, 8, 1], goalNeed: 2,
      keyOrder: true,
      gearGated: true,
      viewSnaps: gate.viewSnaps,
      illusionPairsAt: gate.illusionPairsAt,
      illusionPairs: [],
      par: 3,
      story: '反向同归',
      poem: '反向转动，同归一岸。孤砖诱人，假口诱人，真路在合拍处。'
    };
  })(),

  // ========== 13 错位圣殿 · 主解：咬合 + 中段软闸 + 甲假乙真加长 + 序星（峰值综合）=====###
  (function () {
    const nodes = [].concat(
      room(0, 3, 0, 3, 0, [[1, 1], [2, 2]], { body: 1.2 }),
      [P(4, 0, 1, { phase: '3d', body: 1.2 }), P(5, 0, 1, { phase: '3d', body: 1.2 })],
      [P(5, 0, 2, { body: 1.2 }), P(6, 0, 2, { body: 1.2 }), P(7, 0, 2, { body: 1.2 })],
      [P(7, 1, 1, { body: 2 })],
      [P(8, 1, 1, { rotor: 'r1' }), P(9, 1, 1, { rotor: 'r1' }), P(10, 1, 1, { rotor: 'r1' }), P(9, 1, 0, { rotor: 'r1' })],
      room(11, 13, 0, 3, 1, [[12, 1]], { body: 2 }),
      [P(14, 1, 1, { body: 2 })],
      [P(16, 2, 2, { rotor: 'r2' }), P(17, 2, 2, { rotor: 'r2' })],
      // 挖掉 (20,4)：给软闸乙向 midFoot 留空，并防俯视竖爬绕过软闸上到 y=4 廊
      room(18, 20, 1, 4, 2, [[19, 2], [20, 4]], { body: 2 })
      // 中段软闸锚点：须先转乙向才上第三轮（与终段加长链形成两次 Q/E）—— (20,2,3) 由上方 room 产出
    );
    const mid = qeGate('soft', {
      ax: 20, ay: 2, az: 3,
      tbody: 3
    });
    nodes.push.apply(nodes, mid.nodes);
    // 软闸几何落点 (18,4,7) → 南折到 r3 → 东厅；东厅 z 止于 5，避免与终段浮砖脚印贴边被俯视爬上
    nodes.push(
      P(18, 4, 7, { body: 3 }),
      P(19, 4, 7, { body: 3 }),
      P(20, 4, 7, { body: 3 }),
      P(20, 4, 6, { body: 3 }),
      P(20, 4, 5, { body: 3 }),
      P(20, 4, 4, { rotor: 'r3', body: 3 }),
      P(19, 4, 4, { rotor: 'r3', body: 3 }),
      P(18, 4, 4, { rotor: 'r3', body: 3 }),
      P(21, 4, 4, { body: 3 })
    );
    // 东厅 z=3..5（不含 6，以免贴终段 T1 脚印）；挖手铺格与闸 midFoot (24,4,6)
    nodes.push.apply(nodes, room(21, 24, 3, 5, 4, [[21, 4], [22, 4]], { body: 3 }));
    // 终段加长链（锚用东厅已有的 (24,4,5)）
    const gate = qeGate('jiaYiLong', {
      ax: 24, ay: 4, az: 5
    });
    nodes.push.apply(nodes, gate.nodes);
    nodes.push(P(21, 7, 11, { body: 7 }), P(20, 7, 11, { body: 7 }), P(20, 7, 12, { body: 7 }));
    const walls = [[1, 0, 1, 0.32], [12, 1, 1, 1.3], [19, 2, 2, 1.3], [22, 4, 4, 1.3]];
    const spawn = nearIn(nodes, 0, 3, 0, 3, 0) || [3, 0, 3];
    alcove3d(nodes, 21, 4, 3, 'n', '建筑师留言·十三：错位亦是对齐。中段一转，殿前再转；星归其序，门才肯开。', 3);
    flagKey(nodes, 13, 1, 0, 1);
    flagKey(nodes, 18, 2, 2, 2);
    flagKey(nodes, 24, 4, 5, 3);
    return {
      name: '第十三章 · 错位圣殿', sub: 'THE ALIGNED SANCTUM',
      hint: '入口金桥 · 咬合接通 · 星屑按序 · 中段须 Q/E 乙向软闸上第三轮 · 殿前再甲假乙真加长链 · 殿北金桥有碑',
      bg: '#4e5d6e',
      pal: { top: 0xefece2, side: 0x5a6b84, goal: 0xe8b84b, accent: 0xd8a94e, char: 0xffffff },
      nodes: nodes, walls: walls,
      rotors: [
        { id: 'r1', pivot: [9, 1, 1], angle0: 90 },
        { id: 'r2', pivot: [16, 2, 2], angle0: 180 },
        { id: 'r3', pivot: [19, 4, 4], angle0: 90 }
      ],
      gears: [
        { id: 'g1', rotor: 'r1', teeth: 12 },
        { id: 'g2', rotor: 'r2', teeth: 6, meshWith: 'g1' },
        { id: 'g3', rotor: 'r3', teeth: 8 }
      ],
      dials: [],
      start: spawn, goal: [20, 7, 12], goalNeed: 3,
      keyOrder: true,
      gearGated: true,
      viewSnaps: [0, 1],
      illusionPairsAt: mergePairsAt(mid.illusionPairsAt, gate.illusionPairsAt),
      par: 3,
      story: '一合即殿',
      poem: '错位亦是对齐。中段一转，殿前再转，星归而门开。'
    };
  })(),

  // ========== 外章 · 碑后 · 短尾回响（金青错序 + 假台一瞥 + Q/E 甲假乙真）=====###
  (function () {
    const nodes = [].concat(
      room(0, 3, 0, 3, 0, [[1, 1], [2, 2]], { body: 1.2 }),
      [P(4, 0, 1, { phase: '2d', body: 1.2 }), P(5, 0, 1, { phase: '2d', body: 1.2 })],
      room(6, 7, 0, 3, 0, [], { body: 1.2 }),
      // 北假台改由末段 qeGate 甲向几何承担
      [P(7, 1, 1, { body: 2 }), P(8, 1, 1, { body: 2 })],
      [P(9, 1, 1, { rotor: 'rh' }), P(10, 1, 1, { rotor: 'rh' }), P(11, 1, 1, { rotor: 'rh' })],
      room(12, 14, 0, 3, 1, [[13, 1]], { body: 2 }),
      [P(15, 1, 1, { phase: '3d', body: 2 }), P(16, 1, 1, { phase: '3d', body: 2 })],
      room(17, 21, 0, 3, 1, [[18, 1], [19, 2]], { body: 2 }),
      slab(19, 22, 1, 3, 2, { body: 2 })
    );
    // 外章收束：再考一次甲假乙真
    const gate = qeGate('jiaYi', {
      ax: 22, ay: 2, az: 2
    });
    nodes.push.apply(nodes, gate.nodes);
    nodes.push(P(20, 4, 6, { body: 4 }), P(19, 4, 6, { body: 4 }), P(19, 4, 7, { body: 4 }));
    const spawn = nearIn(nodes, 0, 3, 0, 3, 0) || [3, 0, 3];
    alcoveClimb(nodes, 0, 0, 0, 'w', '建筑师留言·外：碑尽处，廊仍未尽。留言已尽，路仍向前；无字之碑，亦是一种回答。');
    flagKey(nodes, 14, 1, 0, 1);
    return {
      name: '外章 · 碑后', sub: 'AFTER THE STELES',
      hidden: true,
      hint: '青桥过谷 · 北假台勿踩 · 齿轮桥平 · 金桥回 3D · 星屑① · 末段 Q/E 甲假乙真',
      bg: '#2c2438',
      pal: { top: 0xeee8dc, side: 0x6b4a78, goal: 0xe8b84b, accent: 0xc9a0d8, char: 0xffffff },
      nodes: nodes, walls: [[1, 0, 1, 0.32], [13, 1, 1, 1.3], [19, 1, 2, 0.32]],
      rotors: [{ id: 'rh', pivot: [10, 1, 1], angle0: 90 }],
      gears: [{ id: 'gh', rotor: 'rh', teeth: 10, pos: [8.2, 2.4, 2.2] }],
      dials: [],
      start: spawn, goal: [19, 4, 7], goalNeed: 1,
      keyOrder: true,
      gearGated: true,
      viewSnaps: gate.viewSnaps,
      illusionPairsAt: gate.illusionPairsAt,
      illusionPairs: [],
      par: 5,
      story: '留言已尽，路仍向前',
      poem: '留言已尽，路仍向前。碑后无字，也是一句完整的话。'
    };
  })()
];

/** 自动布置小怪：固定坐标，脚印曼哈顿距离出生点 ≥4，避开星屑/终点/碑岔/相位/悬崖/转子；优先通往终点的主廊 */
function autoFoes(level, count) {
  if (!level || !level.nodes || !level.start || !level.goal) return;
  const sx = level.start[0], sy = level.start[1], sz = level.start[2];
  const gx = level.goal[0], gz = level.goal[2];
  const spawnToGoal = Math.abs(sx - gx) + Math.abs(sz - gz);
  const steleNear = new Set();
  for (const n of level.nodes) {
    if (!n.stele) continue;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (Math.abs(dx) + Math.abs(dz) <= 1) steleNear.add((n.x + dx) + ',' + (n.z + dz));
    }
  }
  const byXZ = new Map();
  for (const n of level.nodes) {
    const k = n.x + ',' + n.z;
    if (!byXZ.has(k)) byXZ.set(k, []);
    byXZ.get(k).push(n);
  }
  function degXZ(x, z) {
    let c = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (byXZ.has((x + dx) + ',' + (z + dz))) c++;
    }
    return c;
  }
  const reach = new Set();
  const q = [[sx, sz]];
  reach.add(sx + ',' + sz);
  while (q.length) {
    const [x, z] = q.shift();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz, k = nx + ',' + nz;
      if (reach.has(k) || !byXZ.has(k)) continue;
      reach.add(k);
      q.push([nx, nz]);
    }
  }
  const used = new Set();
  const cands = [];
  for (const n of level.nodes) {
    if (n.phase || n.drop || n.rotor || n.decoy || n.key || n.goal || n.stele) continue;
    if (steleNear.has(n.x + ',' + n.z)) continue;
    const md = Math.abs(n.x - sx) + Math.abs(n.z - sz);
    if (md < 4) continue;
    if (Math.abs(n.y - sy) > 3) continue;
    if (!reach.has(n.x + ',' + n.z)) continue;
    const toGoal = Math.abs(n.x - gx) + Math.abs(n.z - gz);
    const onWay = (md + toGoal) <= spawnToGoal + 5;
    const mid = Math.abs(md - 6);
    cands.push({
      n: n,
      score: (onWay ? 80 : 0) + degXZ(n.x, n.z) * 12 - mid + n.y * 0.15
    });
  }
  cands.sort((a, b) => b.score - a.score);
  const foes = [];
  for (const c of cands) {
    if (foes.length >= count) break;
    let ok = true;
    for (const f of foes) {
      if (Math.abs(c.n.x - f[0]) + Math.abs(c.n.z - f[2]) < 3) { ok = false; break; }
    }
    if (!ok) continue;
    const k = c.n.x + ',' + c.n.y + ',' + c.n.z;
    if (used.has(k)) continue;
    used.add(k);
    foes.push([c.n.x, c.n.y, c.n.z]);
  }
  if (foes.length < count) {
    for (const n of level.nodes) {
      if (foes.length >= count) break;
      if (n.phase || n.drop || n.rotor || n.decoy || n.key || n.goal || n.stele) continue;
      const md = Math.abs(n.x - sx) + Math.abs(n.z - sz);
      if (md < 4) continue;
      if (!reach.has(n.x + ',' + n.z)) continue;
      let ok = true;
      for (const f of foes) {
        if (Math.abs(n.x - f[0]) + Math.abs(n.z - f[2]) < 2) { ok = false; break; }
      }
      if (!ok) continue;
      const k = n.x + ',' + n.y + ',' + n.z;
      if (used.has(k)) continue;
      used.add(k);
      foes.push([n.x, n.y, n.z]);
    }
  }
  if (foes.length < count) {
    const rest = [];
    for (const n of level.nodes) {
      if (n.phase || n.drop || n.rotor || n.decoy || n.key || n.goal || n.stele) continue;
      const md = Math.abs(n.x - sx) + Math.abs(n.z - sz);
      if (md < 4) continue;
      const k = n.x + ',' + n.y + ',' + n.z;
      if (used.has(k)) continue;
      rest.push({ n: n, md: md });
    }
    rest.sort((a, b) => a.md - b.md);
    for (const c of rest) {
      if (foes.length >= count) break;
      let ok = true;
      for (const f of foes) {
        if (Math.abs(c.n.x - f[0]) + Math.abs(c.n.z - f[2]) < 2) { ok = false; break; }
      }
      if (!ok) continue;
      used.add(c.n.x + ',' + c.n.y + ',' + c.n.z);
      foes.push([c.n.x, c.n.y, c.n.z]);
    }
  }
  level.foes = foes;
  return foes;
}
/** 按指定出生/终点重算小怪（不改写关卡原始 start/goal） */
function foesForRoute(level, start, goal, count) {
  if (!level || !level.nodes || !start || !goal) return [];
  const proxy = { nodes: level.nodes, start: start, goal: goal };
  return autoFoes(proxy, count) || [];
}
const FOES_PER_LEVEL = 2;
for (let i = 0; i < LEVELS.length; i++) {
  const L = LEVELS[i];
  if (L.foes) continue;
  autoFoes(L, FOES_PER_LEVEL);
}
