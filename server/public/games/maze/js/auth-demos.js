/* 登录 GUIDE 标签悬停演示（对应第 0 关机能） */
(function () {
  const W = 320, H = 200;

  const demos = {
    space: {
      title: '空格 · 切换视角',
      sub: '第0关 · 青桥只在俯视实体',
      draw(ctx, t) {
        const top = Math.floor(t / 1.4) % 2 === 0;
        clear(ctx, top ? '#d8e6df' : '#c9d2dc');
        label(ctx, top ? '俯视 TOP-DOWN' : '等距 ISOMETRIC', top ? '#1d6f66' : '#5a6a78');
        // tiles
        const cells = [
          [40, 90], [90, 90], [140, 90], [190, 90], [240, 90]
        ];
        cells.forEach((p, i) => {
          const ghost = i === 2 || i === 3;
          if (ghost && !top) {
            roundRect(ctx, p[0], p[1], 42, 42, 8, 'rgba(120,160,150,.18)', 'rgba(80,120,110,.25)');
            return;
          }
          const fill = ghost ? '#7ec9b8' : '#f4f7f0';
          const stroke = ghost ? '#3fbfae' : '#9aa89c';
          roundRect(ctx, p[0], p[1], 42, 42, 8, fill, stroke);
        });
        // pawn walks only when bridge solid (top)
        const progress = (t % 1.4) / 1.4;
        let x;
        if (top) {
          x = 52 + progress * 200;
        } else {
          x = 52 + Math.min(progress, 0.38) * 200;
        }
        drawPawn(ctx, x, 111);
        // space hint
        badge(ctx, 12, H - 28, '空格');
        if (!top && progress > 0.38) {
          ctx.fillStyle = 'rgba(193,75,58,.85)';
          ctx.font = '12px sans-serif';
          ctx.fillText('桥消失 · 无法前进', 110, H - 16);
        }
      }
    },
    yaw: {
      title: 'Q / E · 转方位',
      sub: '第0关 · 甲向假台 / 乙向真路',
      draw(ctx, t) {
        clear(ctx, '#cfd6de');
        const phase = Math.floor(t / 1.6) % 2; // 0=甲 1=乙
        label(ctx, phase === 0 ? '方位甲 · 假对齐' : '方位乙 · 真通路', phase === 0 ? '#a06a20' : '#1d6f66');
        const ox = 160, oy = 118;
        const bricks = phase === 0
          ? [[-70, 20, false], [-30, 0, true], [10, -20, true], [50, -40, false]]
          : [[-70, 20, false], [-36, -4, false], [0, -28, false], [40, -50, false]];
        bricks.forEach((b, i) => {
          drawIso(ctx, ox + b[0], oy + b[1], b[2] ? '#c4a070' : '#eef2ea', b[2]);
        });
        drawPawn(ctx, ox + (phase === 0 ? -18 : 8), oy + (phase === 0 ? -8 : -36));
        badge(ctx, 12, H - 28, phase === 0 ? 'Q' : 'E');
        ctx.fillStyle = phase === 0 ? 'rgba(193,75,58,.9)' : 'rgba(29,111,102,.9)';
        ctx.font = '12px sans-serif';
        ctx.fillText(phase === 0 ? '诱入假台' : '浮砖接通', 70, H - 16);
      }
    },
    click: {
      title: '点地 · 寻路行走',
      sub: '第0关 · 点选地砖自动走过去',
      draw(ctx, t) {
        clear(ctx, '#d5ddd6');
        label(ctx, '点选目标地砖', '#2d2a33');
        const grid = [];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
          grid.push([48 + c * 56, 58 + r * 42]);
        }
        const target = 10;
        const path = [0, 1, 5, 6, 10];
        const step = Math.min(path.length - 1, Math.floor((t % 2.2) / 2.2 * path.length));
        grid.forEach((p, i) => {
          const onPath = path.indexOf(i) >= 0 && path.indexOf(i) <= step;
          const isTarget = i === target;
          roundRect(ctx, p[0], p[1], 48, 34, 7,
            isTarget ? '#e8b84b' : onPath ? 'rgba(63,191,174,.35)' : '#f4f7f0',
            isTarget ? '#b8860b' : '#9aa89c');
        });
        const cur = grid[path[step]];
        drawPawn(ctx, cur[0] + 24, cur[1] + 17);
        // cursor pulse on target
        const tg = grid[target];
        const pulse = 0.5 + 0.5 * Math.sin(t * 6);
        ctx.strokeStyle = `rgba(45,42,51,${0.35 + pulse * 0.45})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tg[0] + 40, tg[1] + 8);
        ctx.lineTo(tg[0] + 48, tg[1] + 20);
        ctx.lineTo(tg[0] + 56, tg[1] + 4);
        ctx.stroke();
        badge(ctx, 12, H - 28, '点击');
      }
    },
    gear: {
      title: '齿轮 · 改图',
      sub: '第0关 · 拖齿轮 / 转盘接通石桥',
      draw(ctx, t) {
        clear(ctx, '#d2d8d0');
        const ang = Math.min(1, (t % 2.4) / 1.6) * 90;
        label(ctx, ang >= 88 ? '石桥已平直' : '拖动齿轮…', ang >= 88 ? '#1d6f66' : '#2d2a33');
        // bridge tiles rotating around pivot
        const pivot = [170, 120];
        for (let i = -1; i <= 1; i++) {
          const rad = (ang - 90) * Math.PI / 180;
          const bx = pivot[0] + Math.cos(rad) * i * 48;
          const by = pivot[1] + Math.sin(rad) * i * 48;
          roundRect(ctx, bx - 20, by - 14, 40, 28, 6, '#eef2ea', '#8a9a8c');
        }
        // gear
        ctx.save();
        ctx.translate(78, 118);
        ctx.rotate((ang / 90) * Math.PI * 1.6);
        drawGear(ctx, 0, 0, 34, 12);
        ctx.restore();
        // dial
        ctx.save();
        ctx.translate(250, 70);
        ctx.rotate((ang / 90) * Math.PI / 2);
        ctx.fillStyle = '#e8b84b';
        ctx.beginPath();
        ctx.arc(0, 0, 18, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#9a6a10';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#2d2a33';
        ctx.fillRect(-2, -14, 4, 14);
        ctx.restore();
        badge(ctx, 12, H - 28, '齿轮');
      }
    }
  };

  function clear(ctx, bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
  }
  function label(ctx, text, color) {
    ctx.fillStyle = color || '#2d2a33';
    ctx.font = 'bold 12px "Segoe UI", sans-serif';
    ctx.fillText(text, 14, 24);
  }
  function badge(ctx, x, y, text) {
    roundRect(ctx, x, y, 44, 18, 9, 'rgba(29,111,102,.14)', 'rgba(29,111,102,.35)');
    ctx.fillStyle = '#1d6f66';
    ctx.font = '10px sans-serif';
    ctx.fillText(text, x + 8, y + 13);
  }
  function roundRect(ctx, x, y, w, h, r, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
  function drawPawn(ctx, x, y) {
    ctx.fillStyle = '#2a5f6a';
    ctx.beginPath();
    ctx.ellipse(x, y + 8, 9, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f4f0e6';
    ctx.beginPath();
    ctx.arc(x, y - 2, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a3d45';
    ctx.fillRect(x - 3, y + 4, 6, 10);
  }
  function drawIso(ctx, x, y, top, decoy) {
    ctx.fillStyle = top;
    ctx.beginPath();
    ctx.moveTo(x, y - 12);
    ctx.lineTo(x + 22, y);
    ctx.lineTo(x, y + 12);
    ctx.lineTo(x - 22, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = decoy ? 'rgba(160,110,40,.55)' : 'rgba(80,100,90,.55)';
    ctx.beginPath();
    ctx.moveTo(x - 22, y);
    ctx.lineTo(x, y + 12);
    ctx.lineTo(x, y + 28);
    ctx.lineTo(x - 22, y + 16);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = decoy ? 'rgba(120,80,30,.45)' : 'rgba(60,80,70,.45)';
    ctx.beginPath();
    ctx.moveTo(x + 22, y);
    ctx.lineTo(x, y + 12);
    ctx.lineTo(x, y + 28);
    ctx.lineTo(x + 22, y + 16);
    ctx.closePath();
    ctx.fill();
  }
  function drawGear(ctx, x, y, r, teeth) {
    ctx.fillStyle = '#c4a06a';
    ctx.beginPath();
    for (let i = 0; i < teeth; i++) {
      const a0 = (i / teeth) * Math.PI * 2;
      const a1 = ((i + 0.35) / teeth) * Math.PI * 2;
      const a2 = ((i + 0.5) / teeth) * Math.PI * 2;
      const a3 = ((i + 0.85) / teeth) * Math.PI * 2;
      ctx.lineTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r);
      ctx.lineTo(x + Math.cos(a1) * (r + 8), y + Math.sin(a1) * (r + 8));
      ctx.lineTo(x + Math.cos(a2) * (r + 8), y + Math.sin(a2) * (r + 8));
      ctx.lineTo(x + Math.cos(a3) * r, y + Math.sin(a3) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#8a6a30';
    ctx.stroke();
    ctx.fillStyle = '#f4f0e6';
    ctx.beginPath();
    ctx.arc(x, y, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }

  let raf = 0, start = 0, current = null;

  function ensureUI() {
    let root = document.getElementById('auth-demo');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'auth-demo';
    root.className = 'auth-demo hidden';
    root.innerHTML =
      '<div class="auth-demo-card">' +
        '<div class="auth-demo-head">' +
          '<span class="auth-demo-title"></span>' +
          '<span class="auth-demo-sub"></span>' +
        '</div>' +
        '<div class="auth-demo-foot">第 0 关机能试验场 · 循环演示</div>' +
        '<canvas width="' + W + '" height="' + H + '"></canvas>' +
      '</div>';
    const chips = document.querySelector('.auth-panel-guide .aw-chips');
    if (chips && chips.parentNode) chips.parentNode.appendChild(root);
    else {
      const auth = document.getElementById('auth');
      if (auth) auth.appendChild(root);
      else document.body.appendChild(root);
    }
    return root;
  }

  function show(key) {
    const demo = demos[key];
    if (!demo) return;
    const root = ensureUI();
    const canvas = root.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    root.querySelector('.auth-demo-title').textContent = demo.title;
    root.querySelector('.auth-demo-sub').textContent = demo.sub;
    root.classList.remove('hidden');
    current = key;
    start = performance.now();

    cancelAnimationFrame(raf);
    const tick = (now) => {
      if (current !== key) return;
      const t = (now - start) / 1000;
      demo.draw(ctx, t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function hide() {
    current = null;
    cancelAnimationFrame(raf);
    const root = document.getElementById('auth-demo');
    if (root) root.classList.add('hidden');
  }

  function bind() {
    let leaveTimer = 0;
    const cancelHide = () => clearTimeout(leaveTimer);
    const scheduleHide = () => {
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(hide, 200);
    };

    document.querySelectorAll('.aw-chips [data-demo]').forEach(chip => {
      const key = chip.getAttribute('data-demo');
      chip.addEventListener('mouseenter', () => {
        cancelHide();
        show(key);
      });
      chip.addEventListener('mouseleave', scheduleHide);
      chip.addEventListener('focus', () => {
        cancelHide();
        show(key);
      });
      chip.addEventListener('blur', scheduleHide);
      chip.addEventListener('click', e => {
        if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
        e.preventDefault();
        if (current === key) hide();
        else show(key);
      });
    });

    const root = ensureUI();
    const card = root.querySelector('.auth-demo-card');
    card.addEventListener('mouseenter', cancelHide);
    card.addEventListener('mouseleave', scheduleHide);
  }

  window.addEventListener('pagehide', hide);
  window.addEventListener('beforeunload', hide);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
