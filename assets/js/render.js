/**
 * render.js — 全部 Canvas 2D 渲染器
 *
 * 包含：
 *  - LabScene        旋转平台（俯视透视）实时仿真
 *  - CollisionScene  子弹击杆的俯视碰撞动画
 *  - MiniChart       I–ω 双曲线数据图（支持悬停提示）
 *  - RadarChart      五维能力雷达图
 *
 * 所有场景内部使用 CSS 像素坐标，适配 devicePixelRatio ≤ 2，
 * 在移动端保持 60fps 的绘制开销。
 */

const TAU = Math.PI * 2;
const SQUASH = 0.42; // 平台透视的纵向压缩比
const PLATFORM_R = 0.86; // 平台世界半径 / m

const COLORS = {
  cyan: '#4fe6ff',
  blue: '#4f8cff',
  violet: '#9d7bff',
  amber: '#ffb86b',
  green: '#5ef2b0',
  red: '#ff6b8a',
  text: '#e9f2ff',
  muted: '#8ea3c6',
  dim: '#61769a',
  line: 'rgba(126,182,255,0.16)',
};

const FONT = '"Inter","PingFang SC","Microsoft YaHei",system-ui,sans-serif';
const MONO = '"SF Mono","Cascadia Code",Consolas,monospace';

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function prepareCanvas(canvas, ctx, w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return dpr;
}

function ellipse(ctx, x, y, rx, ry, rotation = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rotation, 0, TAU);
}

function softGlow(ctx, color, blur) {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
}

function clearGlow(ctx) {
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
}

function arrow(ctx, x1, y1, x2, y2, color, width = 2, head = 7) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - Math.cos(angle - 0.42) * head,
    y2 - Math.sin(angle - 0.42) * head
  );
  ctx.lineTo(
    x2 - Math.cos(angle + 0.42) * head,
    y2 - Math.sin(angle + 0.42) * head
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function arcArrow(ctx, cx, cy, radius, start, end, color, width = 2, ry = radius) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.ellipse(cx, cy, radius, ry, 0, start, end);
  ctx.stroke();
  const x = cx + Math.cos(end) * radius;
  const y = cy + Math.sin(end) * ry;
  const tx = -Math.sin(end) * radius;
  const ty = Math.cos(end) * ry;
  const angle = Math.atan2(ty, tx);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(
    x - Math.cos(angle - 0.45) * 7,
    y - Math.sin(angle - 0.45) * 7
  );
  ctx.lineTo(
    x - Math.cos(angle + 0.45) * 7,
    y - Math.sin(angle + 0.45) * 7
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/* =========================================================
   旋转平台场景
   ========================================================= */

export class LabScene {
  constructor(canvas, model, { onRadiusChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.model = model;
    this.onRadiusChange = onRadiusChange || (() => {});
    this.showVectors = true;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.w = 0;
    this.h = 0;
    this.cx = 0;
    this.cy = 0;
    this.R = 0;
    this.pxPerM = 0;
    this.stars = [];
    this.bg = document.createElement('canvas');
    this.bgCtx = this.bg.getContext('2d');
    this.trails = [[], []];
    this.particles = [];
    this.dragging = false;
    this.hovering = false;
    this.activeMass = 0;
    this.trailClock = 0;
    this.time = 0;

    this._onDown = this.handleDown.bind(this);
    this._onMove = this.handleMove.bind(this);
    this._onUp = this.handleUp.bind(this);
    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onUp);
    canvas.addEventListener('pointerleave', () => {
      if (!this.dragging) {
        this.hovering = false;
        canvas.style.cursor = 'grab';
      }
    });

    this.resizeObserver = new ResizeObserver(() => this.measure());
    this.resizeObserver.observe(canvas.parentElement);
    this.measure();
  }

  measure() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    this.w = rect.width;
    this.h = rect.height;
    this.cx = this.w * 0.5;
    this.cy = this.h * 0.53;
    // 以世界半径 0.86 m 的平台为基准换算像素比例
    this.pxPerM = Math.min(this.w * 0.44, this.h * 0.7) / PLATFORM_R;
    this.R = this.pxPerM * PLATFORM_R;
    // 视野过大时略微收缩，给矢量标注留出边距
    if (this.R > this.w * 0.44) {
      this.R = this.w * 0.44;
      this.pxPerM = this.R / PLATFORM_R;
    }
    this.stars = this.makeStars();
    this.renderBackgroundCache();
  }

  renderBackgroundCache() {
    if (this.w < 2 || this.h < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.bg.width = Math.max(1, Math.round(this.w * dpr));
    this.bg.height = Math.max(1, Math.round(this.h * dpr));
    this.bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawBackground(this.bgCtx);
  }

  makeStars() {
    const rnd = mulberry32(20261117);
    const count = Math.round(clamp((this.w * this.h) / 14000, 18, 64));
    const stars = [];
    for (let i = 0; i < count; i += 1) {
      stars.push({
        x: rnd() * this.w,
        y: rnd() * this.h,
        r: 0.4 + rnd() * 1.2,
        a: 0.15 + rnd() * 0.4,
        p: rnd() * TAU,
      });
    }
    return stars;
  }

  /** 世界半径（米）→ 屏幕像素半径 */
  pxOf(worldR) {
    return worldR * this.pxPerM;
  }

  pointOf(worldR, theta) {
    const rp = this.pxOf(worldR);
    return {
      x: this.cx + Math.cos(theta) * rp,
      y: this.cy + Math.sin(theta) * rp * SQUASH,
    };
  }

  massScreen(index) {
    const theta = this.model.angle + (index === 1 ? Math.PI : 0);
    return this.pointOf(this.model.radius, theta);
  }

  handleDown(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    for (let i = 0; i < 2; i += 1) {
      const p = this.massScreen(i);
      if (Math.hypot(p.x - x, p.y - y) < 34) {
        this.dragging = true;
        this.activeMass = i;
        this.canvas.setPointerCapture?.(event.pointerId);
        this.canvas.style.cursor = 'grabbing';
        event.preventDefault();
        return;
      }
    }
  }

  handleMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (this.dragging) {
      const wx = (x - this.cx) / this.pxPerM;
      const wy = (y - this.cy) / (this.pxPerM * SQUASH);
      const worldR = clamp(Math.hypot(wx, wy), 0.15, 0.75);
      this.onRadiusChange(Math.round(worldR * 100) / 100);
      event.preventDefault();
      return;
    }
    let hovering = false;
    for (let i = 0; i < 2; i += 1) {
      const p = this.massScreen(i);
      if (Math.hypot(p.x - x, p.y - y) < 34) hovering = true;
    }
    if (hovering !== this.hovering) {
      this.hovering = hovering;
      this.canvas.style.cursor = hovering ? 'grab' : 'default';
    }
  }

  handleUp() {
    if (!this.dragging) return;
    this.dragging = false;
    this.canvas.style.cursor = 'grab';
  }

  flash() {
    for (let i = 0; i < 26; i += 1) {
      const side = i % 2;
      const p = this.massScreen(side);
      const angle = Math.random() * TAU;
      const speed = 35 + Math.random() * 120;
      this.particles.push({
        x: p.x,
        y: p.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        max: 0.5 + Math.random() * 0.5,
        size: 1 + Math.random() * 2.2,
        color: i % 3 === 0 ? COLORS.violet : COLORS.cyan,
      });
    }
  }

  update(dt) {
    this.time += dt;
    const model = this.model;
    const running = Math.abs(model.omega) > 0.02;
    this.trailClock += dt;
    if (running && this.trailClock > 0.035 && !this.reduced) {
      this.trailClock = 0;
      for (let i = 0; i < 2; i += 1) {
        const p = this.massScreen(i);
        const trail = this.trails[i];
        trail.push({ x: p.x, y: p.y, t: this.time });
        if (trail.length > 150) trail.shift();
      }
    }
    // 暂停时让轨迹慢慢淡出
    if (!running) {
      for (const trail of this.trails) {
        if (trail.length) trail.splice(0, Math.max(1, Math.round(trail.length * dt * 2.5)));
      }
    }
    for (const p of this.particles) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.97;
      p.vy = p.vy * 0.97 - 18 * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
  }

  draw() {
    const { ctx } = this;
    const { w, h } = this;
    if (w < 2) return;
    const dpr = prepareCanvas(this.canvas, ctx, w, h);
    if (this.bg.width !== Math.round(w * dpr) || this.bg.height !== Math.round(h * dpr)) {
      this.renderBackgroundCache();
    }
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.bg, 0, 0, w, h);
    this.drawPlatform(ctx);
    this.drawFigureAndMasses(ctx);
    this.drawTrails(ctx);
    this.drawVectors(ctx);
    this.drawParticles(ctx);
  }

  drawBackground(ctx) {
    const { w, h, cx, cy } = this;
    const bg = ctx.createRadialGradient(cx, cy * 0.55, 20, cx, cy, Math.max(w, h) * 0.78);
    bg.addColorStop(0, 'rgba(23,45,84,0.55)');
    bg.addColorStop(0.55, 'rgba(8,14,27,0.9)');
    bg.addColorStop(1, '#05080f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    for (const s of this.stars) {
      const tw = 0.55 + 0.45 * Math.sin(this.time * 1.4 + s.p);
      ctx.globalAlpha = s.a * tw;
      ctx.fillStyle = '#cfe8ff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 地面光晕
    const glow = ctx.createRadialGradient(cx, cy + this.R * 0.16, this.R * 0.2, cx, cy + this.R * 0.2, this.R * 1.35);
    glow.addColorStop(0, 'rgba(79,230,255,0.09)');
    glow.addColorStop(0.55, 'rgba(79,140,255,0.04)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // 远景轨道环
    ctx.save();
    ctx.strokeStyle = 'rgba(126,182,255,0.08)';
    ctx.lineWidth = 1;
    ellipse(ctx, cx, cy + this.R * 0.03, this.R * 1.23, this.R * 1.23 * SQUASH);
    ctx.stroke();
    ctx.setLineDash([2, 9]);
    ellipse(ctx, cx, cy + this.R * 0.03, this.R * 1.34, this.R * 1.34 * SQUASH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  drawPlatform(ctx) {
    const { cx, cy, R } = this;
    const omega = this.model.omega;
    const outer = R * 1.035;

    // 地面阴影（用分层透明椭圆代替昂贵的 canvas blur）
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.24)';
    ellipse(ctx, cx, cy + R * 0.1, outer * 1.05, outer * 1.05 * SQUASH);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ellipse(ctx, cx, cy + R * 0.085, outer * 1.01, outer * 1.01 * SQUASH);
    ctx.fill();
    ctx.restore();

    // 底座厚度：一圈厚描边形成圆柱侧壁
    ctx.save();
    ellipse(ctx, cx, cy + R * 0.032, outer, outer * SQUASH);
    const side = ctx.createLinearGradient(cx - outer, cy, cx + outer, cy);
    side.addColorStop(0, 'rgba(6,12,22,0.95)');
    side.addColorStop(0.5, 'rgba(22,40,66,0.95)');
    side.addColorStop(1, 'rgba(6,12,22,0.95)');
    ctx.strokeStyle = side;
    ctx.lineWidth = R * 0.055;
    ctx.stroke();
    ctx.restore();

    // 外圈金属台沿
    ellipse(ctx, cx, cy, outer, outer * SQUASH);
    const rim = ctx.createLinearGradient(cx - outer, cy, cx + outer, cy);
    rim.addColorStop(0, '#101c2e');
    rim.addColorStop(0.2, '#2c4767');
    rim.addColorStop(0.5, '#557496');
    rim.addColorStop(0.8, '#29405c');
    rim.addColorStop(1, '#0c1625');
    ctx.fillStyle = rim;
    ctx.fill();
    ctx.strokeStyle = 'rgba(150,195,240,0.35)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 台面
    ellipse(ctx, cx, cy, R * 0.955, R * 0.955 * SQUASH);
    const disc = ctx.createRadialGradient(
      cx - R * 0.3,
      cy - R * 0.16,
      R * 0.04,
      cx,
      cy,
      R * 0.98
    );
    disc.addColorStop(0, 'rgba(36,70,118,0.98)');
    disc.addColorStop(0.5, 'rgba(16,31,57,0.99)');
    disc.addColorStop(1, 'rgba(6,12,23,1)');
    ctx.fillStyle = disc;
    ctx.fill();
    ctx.strokeStyle = 'rgba(79,230,255,0.28)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 内圈轨道
    ctx.save();
    ctx.setLineDash([2, 8]);
    ctx.strokeStyle = 'rgba(126,182,255,0.14)';
    ctx.lineWidth = 1;
    ellipse(ctx, cx, cy, R * 0.62, R * 0.62 * SQUASH);
    ctx.stroke();
    ctx.restore();

    // 旋转刻度与辐条
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, SQUASH);
    ctx.rotate(this.model.angle);
    const tickCount = 48;
    for (let i = 0; i < tickCount; i += 1) {
      const a = (i / tickCount) * TAU;
      const long = i % 6 === 0;
      ctx.beginPath();
      ctx.strokeStyle = long ? 'rgba(126,208,255,0.42)' : 'rgba(126,182,255,0.15)';
      ctx.lineWidth = long ? 1.6 : 1;
      ctx.moveTo(
        Math.cos(a) * R * (long ? 0.88 : 0.918),
        Math.sin(a) * R * (long ? 0.88 : 0.918)
      );
      ctx.lineTo(Math.cos(a) * R * 0.946, Math.sin(a) * R * 0.946);
      ctx.stroke();
    }
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * TAU;
      const grad = ctx.createLinearGradient(0, 0, Math.cos(a) * R, Math.sin(a) * R);
      grad.addColorStop(0, 'rgba(79,230,255,0.01)');
      grad.addColorStop(0.7, 'rgba(79,230,255,0.1)');
      grad.addColorStop(1, 'rgba(79,230,255,0.02)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * R * 0.17, Math.sin(a) * R * 0.17);
      ctx.lineTo(Math.cos(a) * R * 0.86, Math.sin(a) * R * 0.86);
      ctx.stroke();
    }
    ctx.restore();

    // 台面反光
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const sheen = ctx.createLinearGradient(cx - R, cy - R * 0.4, cx + R * 0.4, cy + R * 0.2);
    sheen.addColorStop(0, 'rgba(120,190,255,0.06)');
    sheen.addColorStop(0.45, 'rgba(120,190,255,0.015)');
    sheen.addColorStop(1, 'rgba(120,190,255,0)');
    ctx.fillStyle = sheen;
    ellipse(ctx, cx, cy, R * 0.92, R * 0.92 * SQUASH);
    ctx.fill();
    ctx.restore();

    // 中心台座
    ellipse(ctx, cx, cy, R * 0.17, R * 0.17 * SQUASH);
    ctx.fillStyle = 'rgba(7,14,26,0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(79,230,255,0.22)';
    ctx.stroke();

    // 转速光环
    const speed = clamp(omega / 3.2, 0, 1);
    if (speed > 0.02) {
      ctx.save();
      arcArrow(
        ctx,
        cx,
        cy,
        R * 1.06,
        -0.38,
        -1.28,
        `rgba(79,230,255,${0.35 + speed * 0.5})`,
        1.8,
        R * 1.06 * SQUASH
      );
      ctx.font = `600 10px ${MONO}`;
      ctx.fillStyle = `rgba(79,230,255,${0.6 + speed * 0.3})`;
      ctx.fillText('ω', cx + R * 0.86, cy - R * 0.34);
      ctx.restore();
    }

    // 摩擦提示
    if (this.model.friction) {
      ctx.save();
      ctx.font = `600 9px ${FONT}`;
      ctx.fillStyle = 'rgba(255,184,107,0.85)';
      ctx.textAlign = 'center';
      ctx.fillText('轴承摩擦中 · L 不再守恒', cx, cy + R * SQUASH + 22);
      ctx.restore();
    }
  }

  drawFigureAndMasses(ctx) {
    const { cx, cy, R } = this;
    const model = this.model;
    const thetaA = model.angle;
    const thetaB = thetaA + Math.PI;
    const m1 = this.massScreen(0);
    const m2 = this.massScreen(1);
    const shoulderY = cy - R * 0.03;
    const hipY = cy + R * 0.135;
    const headR = clamp(R * 0.052, 10, 23);
    const headY = cy - R * 0.155;
    const shoulderX = R * 0.095;
    const hipX = R * 0.098;
    const masses = [
      { point: m1, theta: thetaA },
      { point: m2, theta: thetaB },
    ];
    const backMasses = masses.filter((item) => Math.sin(item.theta) < 0);
    const frontMasses = masses.filter((item) => Math.sin(item.theta) >= 0);

    // 地面投影
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ellipse(ctx, cx, hipY + R * 0.04, R * 0.17, R * 0.065);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.24)';
    ellipse(ctx, cx, hipY + R * 0.035, R * 0.13, R * 0.052);
    ctx.fill();
    ctx.restore();

    // 座椅
    ellipse(ctx, cx, hipY + R * 0.06, R * 0.11, R * 0.042);
    ctx.fillStyle = 'rgba(8,15,27,0.95)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(79,230,255,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ellipse(ctx, cx, hipY + R * 0.025, R * 0.083, R * 0.032);
    ctx.fillStyle = '#172941';
    ctx.fill();
    ctx.strokeStyle = 'rgba(126,182,255,0.18)';
    ctx.stroke();

    // 手臂：白大褂袖子，先画在躯干后面
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < 2; i += 1) {
      const sign = i === 0 ? 1 : -1;
      const mass = i === 0 ? m1 : m2;
      const theta = i === 0 ? thetaA : thetaB;
      const sx = cx + shoulderX * sign;
      const sy = shoulderY + R * 0.008;
      const hx = mass.x - Math.cos(theta) * R * 0.012;
      const hy = mass.y - Math.sin(theta) * R * 0.012 * SQUASH;
      const mx = (sx + hx) / 2 + sign * R * 0.012;
      const my = (sy + hy) / 2 + R * 0.028;
      const width = clamp(R * 0.021, 5.5, 9);

      // 描边与袖管
      ctx.strokeStyle = 'rgba(17,32,52,0.85)';
      ctx.lineWidth = width + 2.5;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(mx, my, hx, hy);
      ctx.stroke();

      const sleeve = ctx.createLinearGradient(sx, sy, hx, hy);
      sleeve.addColorStop(0, '#e8f4ff');
      sleeve.addColorStop(0.55, '#c4dcf1');
      sleeve.addColorStop(1, '#8dafcd');
      ctx.strokeStyle = sleeve;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(mx, my, hx, hy);
      ctx.stroke();

      // 袖子青色反光
      ctx.strokeStyle = 'rgba(79,230,255,0.32)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(mx, my - 1, hx, hy - 1);
      ctx.stroke();

      // 袖口
      const cuffT = 0.86;
      const cxp = (1 - cuffT) * (1 - cuffT) * sx + 2 * (1 - cuffT) * cuffT * mx + cuffT * cuffT * hx;
      const cyp = (1 - cuffT) * (1 - cuffT) * sy + 2 * (1 - cuffT) * cuffT * my + cuffT * cuffT * hy;
      ctx.fillStyle = '#244766';
      ctx.beginPath();
      ctx.arc(cxp, cyp, width * 0.56, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(79,230,255,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // 手
      ctx.fillStyle = '#e7bd9c';
      ctx.beginPath();
      ctx.arc(hx, hy, clamp(R * 0.013, 3.5, 6), 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(90,55,35,0.4)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
    ctx.restore();

    // 位于身体后方的哑铃先画，避免“压在头上”
    for (const item of backMasses) this.drawDumbbell(ctx, item.point, item.theta);

    // 白大褂阴影
    ctx.save();
    ctx.translate(0, R * 0.008);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    this.traceCoat(ctx, cx, shoulderY, hipY, shoulderX, hipX);
    ctx.fill();
    ctx.restore();

    // 白大褂主体
    const coat = ctx.createLinearGradient(cx - shoulderX, shoulderY, cx + hipX, hipY);
    coat.addColorStop(0, '#f2f9ff');
    coat.addColorStop(0.42, '#d7e8f8');
    coat.addColorStop(1, '#93b5d4');
    ctx.fillStyle = coat;
    this.traceCoat(ctx, cx, shoulderY, hipY, shoulderX, hipX);
    ctx.fill();
    ctx.strokeStyle = 'rgba(31,56,86,0.5)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 衣领
    ctx.fillStyle = '#1c3552';
    ctx.beginPath();
    ctx.moveTo(cx - R * 0.045, shoulderY - R * 0.012);
    ctx.lineTo(cx, shoulderY + R * 0.045);
    ctx.lineTo(cx + R * 0.045, shoulderY - R * 0.012);
    ctx.lineTo(cx + R * 0.03, shoulderY - R * 0.03);
    ctx.lineTo(cx, shoulderY + R * 0.005);
    ctx.lineTo(cx - R * 0.03, shoulderY - R * 0.03);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(79,230,255,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 门襟与腰带
    ctx.strokeStyle = 'rgba(79,230,255,0.32)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx, shoulderY + R * 0.03);
    ctx.lineTo(cx, hipY - R * 0.008);
    ctx.stroke();
    ctx.fillStyle = '#24425f';
    roundRect(ctx, cx - hipX * 0.82, hipY - R * 0.055, hipX * 1.64, R * 0.028, 3);
    ctx.fill();
    ctx.fillStyle = 'rgba(79,230,255,0.75)';
    ctx.beginPath();
    ctx.arc(cx, hipY - R * 0.041, 1.6, 0, TAU);
    ctx.fill();

    // 反光
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx - shoulderX * 0.66, shoulderY + R * 0.015);
    ctx.quadraticCurveTo(cx - shoulderX * 0.45, hipY - R * 0.03, cx - hipX * 0.5, hipY - R * 0.01);
    ctx.stroke();

    // 颈
    ctx.fillStyle = '#d2a07d';
    roundRect(ctx, cx - headR * 0.26, headY + headR * 0.62, headR * 0.52, headR * 0.72, headR * 0.16);
    ctx.fill();

    // 头
    const headGrad = ctx.createRadialGradient(
      cx - headR * 0.3,
      headY - headR * 0.35,
      headR * 0.1,
      cx,
      headY,
      headR
    );
    headGrad.addColorStop(0, '#f8ddc6');
    headGrad.addColorStop(0.55, '#e7b995');
    headGrad.addColorStop(1, '#c9946f');
    ctx.fillStyle = headGrad;
    ctx.beginPath();
    ctx.arc(cx, headY, headR, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(80,48,30,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 头发
    ctx.fillStyle = '#1b2438';
    ctx.beginPath();
    ctx.arc(cx, headY, headR * 1.01, Math.PI * 1.02, Math.PI * 1.98);
    ctx.quadraticCurveTo(cx + headR * 0.92, headY + headR * 0.06, cx, headY + headR * 0.02);
    ctx.quadraticCurveTo(cx - headR * 0.92, headY + headR * 0.06, cx - headR * 1.01, headY);
    ctx.fill();
    // 发丝高光
    ctx.strokeStyle = 'rgba(120,160,210,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, headY, headR * 0.82, Math.PI * 1.12, Math.PI * 1.78);
    ctx.stroke();

    // 护目镜 / 面罩
    ctx.fillStyle = 'rgba(79,230,255,0.18)';
    roundRect(ctx, cx - headR * 0.78, headY - headR * 0.08, headR * 1.56, headR * 0.34, headR * 0.16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(79,230,255,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(79,230,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(cx - headR * 0.78, headY + headR * 0.08);
    ctx.lineTo(cx + headR * 0.78, headY + headR * 0.08);
    ctx.stroke();

    // 耳麦指示灯
    ctx.fillStyle = 'rgba(79,230,255,0.9)';
    ctx.beginPath();
    ctx.arc(cx + headR * 0.95, headY + headR * 0.08, clamp(headR * 0.12, 1.5, 3), 0, TAU);
    ctx.fill();

    // 哑铃（身体前方）
    for (const item of frontMasses) this.drawDumbbell(ctx, item.point, item.theta);

    // 半径标注
    if (R > 200) {
      const mid = this.pointOf(this.model.radius * 0.52, thetaA);
      const end = this.pointOf(this.model.radius * 0.88, thetaA);
      ctx.save();
      ctx.setLineDash([2, 5]);
      ctx.strokeStyle = 'rgba(255,184,107,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.cx, this.cy);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `italic 600 10px ${MONO}`;
      ctx.fillStyle = 'rgba(255,190,120,0.8)';
      ctx.textAlign = 'center';
      ctx.fillText('r', mid.x + Math.cos(thetaA) * 7, mid.y + Math.sin(thetaA) * 7 - 4);
      ctx.restore();
    }

    this.drawAngularMomentum(ctx);
  }

  /** 白大褂轮廓 */
  traceCoat(ctx, cx, shoulderY, hipY, shoulderX, hipX) {
    const waistY = shoulderY + (hipY - shoulderY) * 0.55;
    ctx.beginPath();
    ctx.moveTo(cx - shoulderX, shoulderY + 2);
    ctx.quadraticCurveTo(cx - shoulderX * 1.04, shoulderY - 8, cx, shoulderY - 10);
    ctx.quadraticCurveTo(cx + shoulderX * 1.04, shoulderY - 8, cx + shoulderX, shoulderY + 2);
    ctx.quadraticCurveTo(cx + shoulderX * 0.82, waistY, cx + hipX * 0.92, hipY - 6);
    ctx.quadraticCurveTo(cx + hipX, hipY, cx, hipY + 2);
    ctx.quadraticCurveTo(cx - hipX, hipY, cx - hipX * 0.92, hipY - 6);
    ctx.quadraticCurveTo(cx - shoulderX * 0.82, waistY, cx - shoulderX, shoulderY + 2);
    ctx.closePath();
  }

  drawDumbbell(ctx, pos, theta) {
    const screenAngle = Math.atan2(Math.sin(theta) * SQUASH, Math.cos(theta));
    const tangent = screenAngle + Math.PI / 2;
    const size = clamp(this.R * 0.046, 9, 21);
    const depth = 0.72 + 0.28 * (Math.sin(theta) + 1) / 2;

    // 落在台面上的影子
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${0.3 * depth})`;
    ellipse(ctx, pos.x + 3, pos.y + 5, size * 1.25, size * 0.58);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(pos.x, pos.y);

    // 光晕
    const halo = ctx.createRadialGradient(0, 0, 1, 0, 0, size * 2.6);
    halo.addColorStop(0, `rgba(79,230,255,${0.22 * depth})`);
    halo.addColorStop(0.5, `rgba(79,140,255,${0.08 * depth})`);
    halo.addColorStop(1, 'rgba(79,230,255,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, size * 2.6, 0, TAU);
    ctx.fill();

    ctx.rotate(tangent);
    // 手柄
    ctx.strokeStyle = 'rgba(196,222,248,0.95)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-size * 0.72, 0);
    ctx.lineTo(size * 0.72, 0);
    ctx.stroke();
    // 手柄高光
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-size * 0.7, -0.8);
    ctx.lineTo(size * 0.7, -0.8);
    ctx.stroke();

    // 两侧配重
    for (const sign of [-1, 1]) {
      const x = sign * size * 0.92;
      const g = ctx.createRadialGradient(x - size * 0.22, -size * 0.3, 1, x, 0, size * 0.68);
      g.addColorStop(0, `rgba(230,252,255,${0.98 * depth})`);
      g.addColorStop(0.4, `rgba(79,230,255,${0.9 * depth})`);
      g.addColorStop(0.8, `rgba(26,84,140,${0.95 * depth})`);
      g.addColorStop(1, `rgba(10,38,68,${0.98 * depth})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, 0, size * 0.62, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = `rgba(180,245,255,${0.65 * depth})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // 配重中心高光
      ctx.fillStyle = `rgba(255,255,255,${0.55 * depth})`;
      ctx.beginPath();
      ctx.arc(x - size * 0.18, -size * 0.2, size * 0.16, 0, TAU);
      ctx.fill();
    }

    // 选中/悬停提示环
    if (this.dragging || this.hovering) {
      ctx.strokeStyle = 'rgba(255,184,107,0.75)';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, size * 1.55, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,184,107,0.9)';
      ctx.beginPath();
      ctx.arc(0, -size * 1.9, 2, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  drawAngularMomentum(ctx) {
    const { cx, cy, R } = this;
    if (this.model.L < 0.01) return;
    const x = cx - R * 0.6;
    const y0 = cy - R * 0.4;
    const len = clamp(R * 0.17, 36, 74);
    const y1 = y0 - len;

    ctx.save();
    // 矢量底部的旋转小轨道
    ctx.strokeStyle = 'rgba(79,230,255,0.32)';
    ctx.lineWidth = 1;
    ellipse(ctx, x, y0 + 2, 13, 4.5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(79,230,255,0.7)';
    ctx.beginPath();
    ctx.arc(x + 12, y0 + 4, 1.6, 0, TAU);
    ctx.fill();

    const grad = ctx.createLinearGradient(x, y0, x, y1);
    grad.addColorStop(0, 'rgba(79,230,255,0.25)');
    grad.addColorStop(0.55, 'rgba(79,230,255,0.95)');
    grad.addColorStop(1, 'rgba(157,123,255,1)');
    // 宽的半透明箭头模拟辉光，避免逐帧 shadowBlur 的开销
    ctx.save();
    ctx.globalAlpha = 0.16;
    arrow(ctx, x, y0, x, y1, grad, 7, 11);
    ctx.restore();
    arrow(ctx, x, y0, x, y1, grad, 2.4, 8);

    ctx.font = `700 ${clamp(R * 0.038, 11, 16)}px ${MONO}`;
    ctx.fillStyle = '#e6fdff';
    ctx.textAlign = 'left';
    ctx.fillText('L', x + 11, y1 + 7);
    ctx.font = `500 8.5px ${FONT}`;
    ctx.fillStyle = 'rgba(142,163,198,0.8)';
    ctx.fillText('角动量 ↑', x + 11, y1 + 20);
    ctx.restore();
  }

  drawTrails(ctx) {
    if (this.reduced) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let i = 0; i < this.trails.length; i += 1) {
      const trail = this.trails[i];
      if (trail.length < 2) continue;
      for (let j = 1; j < trail.length; j += 1) {
        const p0 = trail[j - 1];
        const p1 = trail[j];
        const alpha = (j / trail.length) * 0.35;
        ctx.strokeStyle = i === 0 ? `rgba(79,230,255,${alpha})` : `rgba(157,123,255,${alpha})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawVectors(ctx) {
    if (!this.showVectors) return;
    const omega = this.model.omega;
    if (omega < 0.05) return;
    for (let i = 0; i < 2; i += 1) {
      const theta = this.model.angle + (i === 1 ? Math.PI : 0);
      const p = this.massScreen(i);
      const speed = omega * this.model.radius;
      const len = clamp(speed * 22, 8, 58);
      const tx = -Math.sin(theta);
      const ty = Math.cos(theta) * SQUASH;
      const norm = Math.hypot(tx, ty) || 1;
      ctx.save();
      ctx.globalAlpha = 0.55;
      arrow(ctx, p.x, p.y, p.x + (tx / norm) * len, p.y + (ty / norm) * len, COLORS.amber, 1.4, 5);
      ctx.restore();
    }
    // 速度图例
    ctx.save();
    ctx.font = `500 9px ${FONT}`;
    ctx.fillStyle = 'rgba(255,184,107,0.75)';
    ctx.textAlign = 'right';
    ctx.fillText('黄色箭头：线速度 v = ωr', this.w - 18, this.h - 14);
    ctx.restore();
  }

  drawParticles(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const life = 1 - p.life / p.max;
      ctx.globalAlpha = life * 0.9;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * life, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this._onDown);
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerup', this._onUp);
    this.canvas.removeEventListener('pointercancel', this._onUp);
  }
}

/* =========================================================
   子弹击杆场景
   ========================================================= */

export class CollisionScene {
  constructor(canvas, { onImpact } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onImpact = onImpact || (() => {});
    this.params = { M: 1, rodLength: 0.8, projectileMass: 0.02, speed: 300, offset: 0.3 };
    this.solution = null;
    this.phase = 'idle';
    this.t = 0;
    this.flyTime = 0.55;
    this.angle = -Math.PI / 2;
    this.omega = 0;
    this.bulletTrail = [];
    this.rodTrail = [];
    this.particles = [];
    this.time = 0;
    this.trailClock = 0;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.shake = 0;
    this.flash = 0;
    this.slowMotion = 0.42;

    this.w = 0;
    this.h = 0;
    this.cx = 0;
    this.cy = 0;
    this.unit = 0;
    this.bg = document.createElement('canvas');
    this.bgCtx = this.bg.getContext('2d');

    this.resizeObserver = new ResizeObserver(() => this.measure());
    this.resizeObserver.observe(canvas.parentElement);
    this.measure();
  }

  measure() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2) return;
    this.w = rect.width;
    this.h = rect.height;
    this.cx = this.w * 0.5;
    this.cy = this.h * 0.54;
    this.unit = Math.min(this.w * 0.7, this.h * 0.62) / 0.8;
    this.renderTableCache();
  }

  renderTableCache() {
    if (this.w < 2 || this.h < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.bg.width = Math.max(1, Math.round(this.w * dpr));
    this.bg.height = Math.max(1, Math.round(this.h * dpr));
    this.bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawTable(this.bgCtx);
  }

  setParams(params) {
    this.params = { ...this.params, ...params };
    this.reset();
    this.renderTableCache();
  }

  reset() {
    this.phase = 'idle';
    this.t = 0;
    this.angle = -Math.PI / 2;
    this.omega = 0;
    this.bulletTrail = [];
    this.rodTrail = [];
    this.particles = [];
    this.shake = 0;
    this.flash = 0;
    this.solution = null;
  }

  fire(solution) {
    this.solution = solution;
    this.phase = 'flying';
    this.t = 0;
    this.angle = -Math.PI / 2;
    this.omega = 0;
    this.bulletTrail = [];
    this.rodTrail = [];
    this.particles = [];
    this.flyTime = clamp(200 / solution.params.v, 0.34, 0.8);
    this.travelFrom = this.w * 0.5 - this.unit * 0.55 - 70;
    this.travelTo = this.cx;
  }

  get impactPoint() {
    return { x: this.cx, y: this.cy - this.params.offset * this.unit };
  }

  update(dt) {
    this.time += dt;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2.4);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 8);

    if (this.phase === 'flying') {
      this.t += dt;
      const p = clamp(this.t / this.flyTime, 0, 1);
      const ease = p < 0.85 ? p : 0.85 + (p - 0.85) * 0.6;
      const x = this.travelFrom + (this.travelTo - this.travelFrom) * ease;
      const y = this.cy - this.params.offset * this.unit;
      this.bulletTrail.push({ x, y });
      if (this.bulletTrail.length > 16) this.bulletTrail.shift();
      if (p >= 1) {
        this.phase = 'rotating';
        this.omega = this.solution.omega;
        this.t = 0;
        this.flash = 1;
        this.shake = 1;
        this.spawnImpactParticles();
        this.onImpact(this.solution);
      }
    } else if (this.phase === 'rotating') {
      this.t += dt;
      this.trailClock += dt;
      this.angle += this.omega * this.slowMotion * dt;
      const tip = this.rodTip();
      if (!this.reduced && this.trailClock > 0.035) {
        this.trailClock = 0;
        this.rodTrail.push({ x: tip.x, y: tip.y });
        if (this.rodTrail.length > 90) this.rodTrail.shift();
      }
    }

    for (const p of this.particles) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      p.vy = p.vy * 0.96 + 30 * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
  }

  spawnImpactParticles() {
    const p = this.impactPoint;
    for (let i = 0; i < 28; i += 1) {
      const a = Math.random() * TAU;
      const s = 40 + Math.random() * 220;
      this.particles.push({
        x: p.x,
        y: p.y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: 0,
        max: 0.4 + Math.random() * 0.6,
        size: 1 + Math.random() * 2.4,
        color: i % 3 === 0 ? COLORS.amber : COLORS.cyan,
      });
    }
  }

  rodEnds() {
    const half = (this.params.rodLength / 2) * this.unit;
    const dx = Math.cos(this.angle) * half;
    const dy = Math.sin(this.angle) * half;
    return [
      { x: this.cx + dx, y: this.cy + dy },
      { x: this.cx - dx, y: this.cy - dy },
    ];
  }

  rodTip() {
    return this.rodEnds()[0];
  }

  bulletPos() {
    if (this.phase === 'idle') {
      return { x: this.w * 0.5 - this.unit * 0.55 - 70, y: this.cy - this.params.offset * this.unit };
    }
    if (this.phase === 'flying') {
      return this.bulletTrail[this.bulletTrail.length - 1] || {
        x: this.travelFrom,
        y: this.cy - this.params.offset * this.unit,
      };
    }
    const local = { x: 0, y: -this.params.offset * this.unit };
    return {
      x: this.cx + local.x * Math.cos(this.angle) - local.y * Math.sin(this.angle),
      y: this.cy + local.x * Math.sin(this.angle) + local.y * Math.cos(this.angle),
    };
  }

  draw() {
    const { ctx } = this;
    if (this.w < 2) return;
    const dpr = prepareCanvas(this.canvas, ctx, this.w, this.h);
    if (this.bg.width !== Math.round(this.w * dpr) || this.bg.height !== Math.round(this.h * dpr)) {
      this.renderTableCache();
    }
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.save();
    if (this.shake > 0) {
      ctx.translate((Math.random() - 0.5) * this.shake * 5, (Math.random() - 0.5) * this.shake * 5);
    }
    ctx.drawImage(this.bg, 0, 0, this.w, this.h);
    this.drawTrajectory(ctx);
    this.drawRod(ctx);
    this.drawBullet(ctx);
    this.drawParticles(ctx);
    this.drawVectors(ctx);
    ctx.restore();
    if (this.flash > 0) this.drawFlash(ctx);
  }

  drawTable(ctx) {
    const { w, h, cx, cy, unit } = this;
    const bg = ctx.createRadialGradient(cx, cy, 30, cx, cy, Math.max(w, h) * 0.75);
    bg.addColorStop(0, 'rgba(22,42,76,0.45)');
    bg.addColorStop(0.6, 'rgba(7,12,23,0.92)');
    bg.addColorStop(1, '#05080f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // 网格桌面
    ctx.save();
    ctx.strokeStyle = 'rgba(126,182,255,0.055)';
    ctx.lineWidth = 1;
    const step = clamp(unit * 0.1, 22, 46);
    for (let x = cx % step; x < w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = cy % step; y < h; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    // 桌面光圈
    const ring = ctx.createRadialGradient(cx, cy, unit * 0.1, cx, cy, unit * 0.62);
    ring.addColorStop(0, 'rgba(79,230,255,0.05)');
    ring.addColorStop(0.8, 'rgba(79,140,255,0.02)');
    ring.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = ring;
    ctx.beginPath();
    ctx.arc(cx, cy, unit * 0.62, 0, TAU);
    ctx.fill();
    ctx.restore();

    // 初始杆位虚影
    const half = (this.params.rodLength / 2) * unit;
    ctx.save();
    ctx.setLineDash([3, 6]);
    ctx.strokeStyle = 'rgba(126,182,255,0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - half);
    ctx.lineTo(cx, cy + half);
    ctx.stroke();
    ctx.restore();

    // 支点
    ctx.save();
    const base = ctx.createRadialGradient(cx, cy, 2, cx, cy, 20);
    base.addColorStop(0, '#b9e9ff');
    base.addColorStop(0.5, '#2f6c96');
    base.addColorStop(1, 'rgba(10,20,38,0.9)');
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.arc(cx, cy, 13, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(79,230,255,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = 'rgba(5,9,18,0.9)';
    ctx.beginPath();
    ctx.arc(cx, cy, 3.4, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  drawTrajectory(ctx) {
    if (this.phase !== 'idle' && this.phase !== 'flying') return;
    const y = this.cy - this.params.offset * this.unit;
    ctx.save();
    ctx.setLineDash([2, 7]);
    ctx.strokeStyle = 'rgba(255,184,107,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(this.w * 0.5 - this.unit * 0.55 - 70, y);
    ctx.lineTo(this.cx, y);
    ctx.stroke();
    ctx.restore();

    // 击点标注
    const p = this.impactPoint;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,184,107,0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = 'rgba(255,184,107,0.3)';
    ctx.beginPath();
    ctx.moveTo(this.cx, p.y);
    ctx.lineTo(this.cx + this.params.offset * this.unit * 0.9, p.y);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.font = `italic 600 10px ${MONO}`;
    ctx.fillStyle = 'rgba(255,184,107,0.8)';
    ctx.fillText('d', this.cx + this.params.offset * this.unit * 0.45, p.y - 6);
    ctx.restore();
  }

  drawRod(ctx) {
    const [a, b] = this.rodEnds();
    const { cx, cy } = this;

    // 轨迹
    if (this.rodTrail.length > 1) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 1; i < this.rodTrail.length; i += 1) {
        const alpha = (i / this.rodTrail.length) * 0.22;
        ctx.strokeStyle = `rgba(79,230,255,${alpha})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(this.rodTrail[i - 1].x, this.rodTrail[i - 1].y);
        ctx.lineTo(this.rodTrail[i].x, this.rodTrail[i].y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 杆影
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 16;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x + 4, a.y + 7);
    ctx.lineTo(b.x + 4, b.y + 7);
    ctx.stroke();
    ctx.restore();

    // 杆身
    ctx.save();
    const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    g.addColorStop(0, '#587497');
    g.addColorStop(0.28, '#c9dcf5');
    g.addColorStop(0.5, '#f2f8ff');
    g.addColorStop(0.72, '#a9c1de');
    g.addColorStop(1, '#40566f');
    ctx.strokeStyle = g;
    ctx.lineWidth = clamp(this.unit * 0.032, 8, 17);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    // 杆端
    for (const p of [a, b]) {
      ctx.fillStyle = '#dcecff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, clamp(this.unit * 0.018, 4, 9), 0, TAU);
      ctx.fill();
    }

    // 杆中心高光
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  drawBullet(ctx) {
    const p = this.bulletPos();
    ctx.save();
    for (let i = 0; i < this.bulletTrail.length; i += 1) {
      const t = this.bulletTrail[i];
      const alpha = (i / this.bulletTrail.length) * 0.5;
      ctx.fillStyle = `rgba(255,184,107,${alpha})`;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 1.5 + (i / this.bulletTrail.length) * 2.5, 0, TAU);
      ctx.fill();
    }
    const grad = ctx.createRadialGradient(p.x - 1, p.y - 1, 0.5, p.x, p.y, 6);
    grad.addColorStop(0, '#fff6e6');
    grad.addColorStop(0.5, '#ffc97f');
    grad.addColorStop(1, '#ff9a3c');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, TAU);
    ctx.fill();

    if (this.phase !== 'rotating') {
      ctx.font = `500 9px ${FONT}`;
      ctx.fillStyle = 'rgba(255,184,107,0.75)';
      ctx.fillText('子弹', p.x - 12, p.y + 20);
    }
    ctx.restore();
  }

  drawVectors(ctx) {
    const { cx, cy } = this;
    if (this.phase === 'rotating' && this.omega > 0.1) {
      ctx.save();
      arcArrow(ctx, cx, cy, 42, -0.6, 1.9, 'rgba(79,230,255,0.7)', 1.6);
      ctx.font = `600 10px ${MONO}`;
      ctx.fillStyle = 'rgba(79,230,255,0.85)';
      ctx.fillText('ω', cx + 30, cy + 62);
      ctx.restore();
    }
    // 角动量方向提示
    if (this.phase === 'flying' || this.phase === 'rotating') {
      ctx.save();
      ctx.font = `500 9px ${FONT}`;
      ctx.fillStyle = 'rgba(157,123,255,0.8)';
      ctx.textAlign = 'right';
      ctx.fillText('L 垂直纸面向里', this.w - 16, 24);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(142,163,198,0.5)';
      ctx.fillText('动画慢放 ×0.42', 16, 24);
      ctx.restore();
    }
  }

  drawParticles(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const life = 1 - p.life / p.max;
      ctx.globalAlpha = life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * life, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  drawFlash(ctx) {
    const p = this.impactPoint;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const r = 10 + (1 - this.flash) * 70;
    ctx.strokeStyle = `rgba(255,220,170,${this.flash * 0.65})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, TAU);
    ctx.stroke();
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 40);
    g.addColorStop(0, `rgba(255,240,210,${this.flash * 0.55})`);
    g.addColorStop(1, 'rgba(255,184,107,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 40, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  destroy() {
    this.resizeObserver.disconnect();
  }
}

/* =========================================================
   I–ω 数据图
   ========================================================= */

export class MiniChart {
  constructor(canvas, { getData, getTheoryL, getCurrent }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getData = getData;
    this.getTheoryL = getTheoryL;
    this.getCurrent = getCurrent || (() => null);
    this.hover = null;
    this.w = 0;
    this.h = 0;

    this.resizeObserver = new ResizeObserver(() => this.measure());
    this.resizeObserver.observe(canvas.parentElement);
    this.measure();
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
    });
  }

  measure() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
  }

  onMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const data = this.getData();
    const plot = this.plotBox();
    let best = null;
    let bestD = 20;
    for (const d of data) {
      const p = this.toScreen(plot, d.inertia, d.omega);
      const dist = Math.hypot(p.x - x, p.y - y);
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    this.hover = best;
  }

  plotBox() {
    return { left: 42, right: this.w - 18, top: 18, bottom: this.h - 34 };
  }

  domains() {
    const data = this.getData();
    const L = this.getTheoryL();
    const maxI = Math.max(3.0, ...data.map((d) => d.inertia));
    const maxW = Math.max(5.2, ...data.map((d) => d.omega), L / 0.6);
    return { iMin: 0.3, iMax: maxI * 1.05, wMax: Math.min(8, maxW * 1.08) };
  }

  toScreen(plot, I, w) {
    const { iMin, iMax, wMax } = this.domains();
    const x = plot.left + ((I - iMin) / (iMax - iMin)) * (plot.right - plot.left);
    const y = plot.bottom - (w / wMax) * (plot.bottom - plot.top);
    return { x, y };
  }

  draw() {
    const { ctx, w, h } = this;
    if (w < 10) return;
    prepareCanvas(this.canvas, ctx, w, h);
    ctx.clearRect(0, 0, w, h);
    const plot = this.plotBox();
    const { iMin, iMax, wMax } = this.domains();
    const data = this.getData();

    // 网格
    ctx.save();
    ctx.strokeStyle = 'rgba(126,182,255,0.09)';
    ctx.lineWidth = 1;
    ctx.font = `500 9px ${MONO}`;
    ctx.fillStyle = 'rgba(142,163,198,0.55)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const iTicks = 5;
    for (let i = 0; i <= iTicks; i += 1) {
      const I = iMin + ((iMax - iMin) * i) / iTicks;
      const x = plot.left + ((plot.right - plot.left) * i) / iTicks;
      ctx.beginPath();
      ctx.moveTo(x, plot.top);
      ctx.lineTo(x, plot.bottom);
      ctx.stroke();
      ctx.fillText(I.toFixed(1), x, plot.bottom + 12);
    }
    const wStep = wMax <= 6 ? 1 : 2;
    for (let wv = 0; wv <= wMax; wv += wStep) {
      const y = plot.bottom - (wv / wMax) * (plot.bottom - plot.top);
      ctx.beginPath();
      ctx.moveTo(plot.left, y);
      ctx.lineTo(plot.right, y);
      ctx.stroke();
      ctx.fillText(String(wv), plot.left - 8, y);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(142,163,198,0.7)';
    ctx.font = `500 9px ${FONT}`;
    ctx.fillText('ω / rad·s⁻¹', plot.left - 4, plot.top - 7);
    ctx.textAlign = 'right';
    ctx.fillText('I / kg·m²', plot.right, plot.bottom + 26);
    ctx.restore();

    // 理论曲线 ω = L / I
    const L = this.getTheoryL();
    if (L > 0.001) {
      ctx.save();
      ctx.beginPath();
      let started = false;
      for (let I = iMin; I <= iMax; I += 0.01) {
        const wv = L / I;
        if (wv > wMax * 1.02) continue;
        const p = this.toScreen(plot, I, wv);
        if (!started) {
          ctx.moveTo(p.x, p.y);
          started = true;
        } else {
          ctx.lineTo(p.x, p.y);
        }
      }
      ctx.strokeStyle = 'rgba(79,230,255,0.45)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      // 曲线下渐变
      const grad = ctx.createLinearGradient(0, plot.top, 0, plot.bottom);
      grad.addColorStop(0, 'rgba(79,230,255,0.13)');
      grad.addColorStop(1, 'rgba(79,230,255,0)');
      ctx.lineTo(plot.right, plot.bottom);
      ctx.lineTo(plot.left, plot.bottom);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    }

    // 数据点
    for (const d of data) {
      const p = this.toScreen(plot, d.inertia, d.omega);
      ctx.save();
      softGlow(ctx, 'rgba(255,184,107,0.6)', 8);
      ctx.fillStyle = '#ffd7a1';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.2, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,184,107,0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
      clearGlow(ctx);
      ctx.restore();
    }

    // 悬停提示
    if (this.hover) {
      const d = this.hover;
      const p = this.toScreen(plot, d.inertia, d.omega);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,184,107,0.45)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(p.x, plot.top);
      ctx.lineTo(p.x, plot.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      const lines = [`r = ${d.radius.toFixed(2)} m`, `I = ${d.inertia.toFixed(2)}`, `ω = ${d.omega.toFixed(2)}`, `L = ${d.L.toFixed(3)}`];
      const bw = 104;
      const bh = 64;
      let bx = p.x + 12;
      let by = p.y - bh - 8;
      if (bx + bw > w - 6) bx = p.x - bw - 12;
      if (by < 6) by = p.y + 12;
      ctx.fillStyle = 'rgba(8,15,30,0.95)';
      roundRect(ctx, bx, by, bw, bh, 7);
      ctx.fill();
      ctx.strokeStyle = 'rgba(126,182,255,0.25)';
      ctx.stroke();
      ctx.font = `500 9px ${MONO}`;
      ctx.fillStyle = '#dbeaff';
      for (let i = 0; i < lines.length; i += 1) {
        ctx.fillText(lines[i], bx + 9, by + 14 + i * 13);
      }
      ctx.restore();
    }

    // 当前点
    const cur = this.getCurrent();
    if (cur && cur.I > 0 && cur.w > 0) {
      const p = this.toScreen(plot, cur.I, cur.w);
      ctx.save();
      ctx.strokeStyle = 'rgba(79,230,255,0.7)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6.5, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = '#4fe6ff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.6, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  destroy() {
    this.resizeObserver.disconnect();
  }
}

/* =========================================================
   雷达图
   ========================================================= */

export class RadarChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.values = [0.5, 0.5, 0.5, 0.5, 0.5];
    this.labels = ['概念理解', '定量计算', '实验操作', '数据分析', '科学解释'];
    this.w = 0;
    this.h = 0;
    this.resizeObserver = new ResizeObserver(() => this.measure());
    this.resizeObserver.observe(canvas.parentElement);
    this.measure();
  }

  measure() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
  }

  setValues(values) {
    this.values = values.map((v) => clamp(v, 0, 1));
  }

  draw() {
    const { ctx, w, h } = this;
    if (w < 10) return;
    prepareCanvas(this.canvas, ctx, w, h);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2 + 2;
    const radius = Math.min(w * 0.34, h * 0.36);
    const n = this.values.length;
    const angles = Array.from({ length: n }, (_, i) => -Math.PI / 2 + (i / n) * TAU);

    // 同心多边形
    ctx.save();
    for (let ring = 1; ring <= 4; ring += 1) {
      const r = (radius * ring) / 4;
      ctx.beginPath();
      for (let i = 0; i < n; i += 1) {
        const x = cx + Math.cos(angles[i]) * r;
        const y = cy + Math.sin(angles[i]) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = ring === 4 ? 'rgba(126,182,255,0.22)' : 'rgba(126,182,255,0.09)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // 轴线
    for (let i = 0; i < n; i += 1) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angles[i]) * radius, cy + Math.sin(angles[i]) * radius);
      ctx.strokeStyle = 'rgba(126,182,255,0.09)';
      ctx.stroke();
    }
    ctx.restore();

    // 数据多边形
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < n; i += 1) {
      const r = radius * Math.max(0.03, this.values[i]);
      const x = cx + Math.cos(angles[i]) * r;
      const y = cy + Math.sin(angles[i]) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, radius);
    grad.addColorStop(0, 'rgba(79,230,255,0.4)');
    grad.addColorStop(1, 'rgba(79,140,255,0.08)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(79,230,255,0.85)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();

    // 顶点
    for (let i = 0; i < n; i += 1) {
      const r = radius * Math.max(0.03, this.values[i]);
      const x = cx + Math.cos(angles[i]) * r;
      const y = cy + Math.sin(angles[i]) * r;
      ctx.save();
      softGlow(ctx, 'rgba(79,230,255,0.8)', 8);
      ctx.fillStyle = '#bff7ff';
      ctx.beginPath();
      ctx.arc(x, y, 2.8, 0, TAU);
      ctx.fill();
      clearGlow(ctx);
      ctx.restore();
    }

    // 标签
    ctx.save();
    ctx.font = `500 9.5px ${FONT}`;
    ctx.fillStyle = 'rgba(190,210,235,0.75)';
    for (let i = 0; i < n; i += 1) {
      const r = radius + 20;
      const x = cx + Math.cos(angles[i]) * r;
      const y = cy + Math.sin(angles[i]) * r;
      ctx.textAlign = Math.abs(Math.cos(angles[i])) < 0.2 ? 'center' : Math.cos(angles[i]) > 0 ? 'left' : 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.labels[i], x, y);
    }
    ctx.restore();
  }

  destroy() {
    this.resizeObserver.disconnect();
  }
}
