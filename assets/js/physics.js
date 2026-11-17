/**
 * physics.js — 角动量守恒虚拟实验的物理内核
 *
 * 设计原则：
 *  1. 不依赖 DOM，可在浏览器与 Node.js 中直接运行单元测试；
 *  2. 以角动量 L 为状态量做数值积分，半径变化时 L 严格不变，避免
 *     “边转边改 I 导致 L 漂移”的常见仿真错误；
 *  3. 所有对外单位均为国际单位制（kg、m、s、rad）。
 *
 * 主要模型
 *  A. 转台模型：I = I0 + 2 m r²，无外力矩时 L = Iω 为常量；
 *  B. 碰撞模型：子弹嵌入杆，绕支点角动量守恒，机械能不守恒。
 */

export const LAB_LIMITS = Object.freeze({
  I0: 0.6, // 转台 + 人体 的固有转动惯量 / (kg·m²)
  MASS: 2.0, // 每个配重质量 / kg
  R_MIN: 0.15,
  R_MAX: 0.75,
  OMEGA_MIN: 0.2,
  OMEGA_MAX: 3.0,
});

/** 将数值限制在闭区间内。 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 相对误差（百分比）；参考值接近 0 时返回 Infinity。 */
export function relError(measured, reference) {
  if (!Number.isFinite(measured) || !Number.isFinite(reference)) return Infinity;
  if (Math.abs(reference) < 1e-9) return Math.abs(measured) < 1e-9 ? 0 : Infinity;
  return Math.abs((measured - reference) / reference) * 100;
}

/** 固定小数位格式化，自动去除多余的 0。 */
export function fmt(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  const fixed = value.toFixed(digits);
  return fixed.replace(/\.?0+$/, '') || '0';
}

/** 带正负号的格式化。 */
export function fmtSigned(value, digits = 2) {
  const text = fmt(Math.abs(value), digits);
  return `${value < 0 ? '−' : '+'}${text}`;
}

/**
 * 旋转平台模型。
 *
 * 状态量只有 L（角动量）与转角 angle；ω、I、Ek 均由 L 与当前半径导出。
 * 这样无论用户怎样拖动配重，L 都天然守恒；开启轴承摩擦后，
 * 摩擦冲量矩直接作用于 L，符合 dL/dt = τ_ext 的定义。
 */
export class RotatingSystem {
  constructor({
    I0 = LAB_LIMITS.I0,
    mass = LAB_LIMITS.MASS,
    radius = 0.6,
    omega = 1.2,
    friction = false,
  } = {}) {
    this.I0 = I0;
    this.mass = mass;
    this.radius = clamp(radius, LAB_LIMITS.R_MIN, LAB_LIMITS.R_MAX);
    this.friction = Boolean(friction);
    this.angle = 0;
    this.time = 0;
    this.frictionLoss = 0;
    this.L = this.momentOfInertia * clamp(omega, 0.01, 10);
    this.Lref = this.L;
  }

  /** 总转动惯量 I = I0 + 2 m r²。 */
  get momentOfInertia() {
    return this.I0 + 2 * this.mass * this.radius * this.radius;
  }

  /** 角速度 ω = L / I。 */
  get omega() {
    return this.L / this.momentOfInertia;
  }

  /** 转动动能 Ek = L² / (2I)。 */
  get energy() {
    return (this.L * this.L) / (2 * this.momentOfInertia);
  }

  /** 相对初始角动量的偏差百分比。 */
  get deltaL() {
    return this.Lref > 0 ? ((this.L - this.Lref) / this.Lref) * 100 : 0;
  }

  /** 是否已静止。 */
  get stopped() {
    return this.L < 1e-6;
  }

  /**
   * 改变配重半径。半径变化是“内力做功”的过程：
   * L 保持不变，I 改变，于是 ω = L / I 随之改变。
   */
  setRadius(radius) {
    this.radius = clamp(radius, LAB_LIMITS.R_MIN, LAB_LIMITS.R_MAX);
    return this;
  }

  /** 直接设定初始角速度，并把当前 L 记为守恒判据的参考值。 */
  setOmega(omega) {
    this.L = this.momentOfInertia * clamp(omega, 0, 10);
    this.Lref = this.L;
    return this;
  }

  /** 施加一个瞬时角冲量（内部调试 / 碰撞演示用）。 */
  applyImpulse(angularImpulse) {
    this.L = Math.max(0, this.L + angularImpulse);
    return this;
  }

  /** 恢复初始状态，同时保留摩擦开关。 */
  reset({ radius = 0.6, omega = 1.2 } = {}) {
    this.radius = clamp(radius, LAB_LIMITS.R_MIN, LAB_LIMITS.R_MAX);
    this.angle = 0;
    this.time = 0;
    this.frictionLoss = 0;
    this.setOmega(omega);
    return this;
  }

  /**
   * 前进一步。
   * 轴承摩擦采用 τ = b·ω + τc（粘性 + 库仑），方向与转动相反。
   * 使用角冲量更新 L，避免显式求解 ω 造成的数值发散。
   */
  step(dt) {
    const h = clamp(dt, 0, 0.05);
    if (this.L > 1e-9) {
      if (this.friction) {
        const omega = this.omega;
        const torque = 0.025 * omega + 0.004;
        const before = this.energy;
        this.L = Math.max(0, this.L - torque * h);
        this.frictionLoss += Math.max(0, before - this.energy);
      }
      // 从上往下看，逆时针为正；屏幕坐标 y 向下，因此视觉转角取负
      this.angle -= this.omega * h;
      this.time += h;
    }
    return this;
  }

  /** 供 UI / AI / 报告使用的快照。 */
  snapshot() {
    return {
      radius: this.radius,
      inertia: this.momentOfInertia,
      omega: this.omega,
      L: this.L,
      Lref: this.Lref,
      deltaL: this.deltaL,
      energy: this.energy,
      friction: this.friction,
      frictionLoss: this.frictionLoss,
      stopped: this.stopped,
      time: this.time,
    };
  }
}

/**
 * 子弹嵌入杆的碰撞模型（绕杆中心 / 杆端的光滑支点）。
 *
 * 碰撞过程只有内力冲量，绕支点的角动量守恒：
 *      m v d = I_after ω
 * 而机械能不守恒，损失转化为形变、热与声。
 */
export function collisionSolution({
  M = 1.0, // 杆质量 / kg
  rodLength = 0.8, // 杆长 / m
  projectileMass = 0.02, // 子弹质量 / kg
  speed = 300, // 子弹速度 / m·s⁻¹
  offset = 0.3, // 击点到支点距离 / m
  pivot = 'center', // 'center' | 'end'
} = {}) {
  const m = Math.max(projectileMass, 1e-6);
  const v = Math.max(speed, 0);
  const d = clamp(offset, 0, rodLength / 2);
  const rodInertia =
    pivot === 'end' ? (M * rodLength * rodLength) / 3 : (M * rodLength * rodLength) / 12;
  const inertia = rodInertia + m * d * d;
  const angularMomentum = m * v * d;
  const omega = angularMomentum / inertia;
  const energyBefore = 0.5 * m * v * v;
  const energyAfter = 0.5 * inertia * omega * omega;
  const energyLoss = Math.max(0, energyBefore - energyAfter);

  return {
    rodInertia,
    inertia,
    angularMomentum,
    omega,
    energyBefore,
    energyAfter,
    energyLoss,
    energyLossFraction: energyBefore > 0 ? energyLoss / energyBefore : 0,
    // 从上往下看，子弹自左向右击中支点上方的杆：顺时针转动
    direction: -1,
    params: { M, rodLength, m, v, d, pivot },
  };
}

/**
 * 若学生误用“线动量守恒”处理碰撞，会得到什么错误答案？
 * 用于 AI 纠错时给出针对性的对照，而不是简单说“错了”。
 */
export function linearMomentumMistake({ M, projectileMass, speed, offset }) {
  const vAfter = (projectileMass * speed) / (M + projectileMass);
  return {
    velocity: vAfter,
    // 常见的第二种错误：把线速度直接当成角速度
    omegaIfLinear: vAfter / Math.max(offset, 1e-6),
  };
}

/** 平台实验的理论预测：半径改变后 ω 与 Ek 的倍率。 */
export function predictRadiusChange({ I0, mass, r0, r1 }) {
  const i0 = I0 + 2 * mass * r0 * r0;
  const i1 = I0 + 2 * mass * r1 * r1;
  return { i0, i1, omegaRatio: i0 / i1, energyRatio: i0 / i1 };
}

/** 一组实验数据的统计量：用于报告中的误差分析。 */
export function summarize(values) {
  const list = values.filter((v) => Number.isFinite(v));
  if (!list.length) return { n: 0, mean: 0, std: 0, min: 0, max: 0 };
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  const variance = list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length;
  return {
    n: list.length,
    mean,
    std: Math.sqrt(variance),
    min: Math.min(...list),
    max: Math.max(...list),
  };
}

/** 判断一次“预测”的准确度并给出等级（用于任务评分与 AI 反馈）。 */
export function gradePrediction(predicted, actual) {
  const error = relError(predicted, actual);
  let ratio;
  let level;
  if (error <= 5) {
    ratio = 1;
    level = 'excellent';
  } else if (error <= 10) {
    ratio = 0.9;
    level = 'good';
  } else if (error <= 20) {
    ratio = 0.65;
    level = 'fair';
  } else if (error <= 35) {
    ratio = 0.35;
    level = 'weak';
  } else {
    ratio = 0.1;
    level = 'poor';
  }
  return { error, ratio, level };
}
