/**
 * quiz.js — 自适应测评引擎
 *
 * 设计要点：
 *  1. 题库由“工厂函数 + 随机参数”生成，避免背答案，同时保证每次数值可复算；
 *  2. 选题依据概念掌握度与题目难度，而非固定顺序；
 *  3. 每个错误选项都带有针对性的迷思解释，答错后 AI 能精确纠错；
 *  4. 纯函数式核心，便于测试与在浏览器中持久化。
 */

export const CONCEPTS = {
  definition: { label: '角动量与转动惯量', short: '概念' },
  conservation: { label: '守恒条件', short: '守恒' },
  quantitative: { label: '定量计算', short: '计算' },
  energy: { label: '能量与功', short: '能量' },
  collision: { label: '碰撞与角动量', short: '碰撞' },
  data: { label: '实验与误差', short: '数据' },
};

export const CONCEPT_KEYS = Object.keys(CONCEPTS);

export function defaultMastery() {
  return Object.fromEntries(CONCEPT_KEYS.map((key) => [key, 0.5]));
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

function shuffle(list, rng) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function round(value, digits = 2) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

/**
 * 生成带打乱选项的单选题。
 * @param {object} base 题目基础信息
 * @param {Array<{text:string, correct?:boolean, why?:string}>} options
 * @param {Function} rng
 */
function mcq(base, options, rng) {
  const shuffled = shuffle(options, rng);
  const answerIndex = shuffled.findIndex((o) => o.correct);
  const cleaned = shuffled.map(({ text, why }) => ({ text, why }));
  return {
    ...base,
    type: 'mcq',
    options: cleaned,
    answerIndex,
    explanation: base.explanation,
  };
}

/**
 * 题库工厂。每个工厂接收 rng，返回一个题目对象。
 * difficulty: 1 基础 / 2 应用 / 3 综合
 */
const FACTORIES = [
  // ---------- 概念定义 ----------
  (rng) => mcq(
    {
      id: `def-vector-${Math.floor(rng() * 1e6)}`,
      concepts: ['definition'],
      difficulty: 1,
      stem: '质点相对于某定点运动，角动量 L = r × p 的方向由什么确定？',
      explanation: '角动量是叉乘矢量，方向由右手螺旋定则确定：四指从 r 转向 p，拇指指向 L。',
    },
    [
      { text: '右手螺旋定则：四指由 r 转向 p，拇指指向 L', correct: true },
      { text: '与速度 v 的方向相同', why: '角动量与线动量不是同一个矢量，L = r × p 与 r、p 都垂直。' },
      { text: '沿半径 r 的方向', why: 'L 与 r 垂直，而不是沿 r 方向。' },
      { text: '与合外力 F 的方向相同', why: '力决定角动量的变化率，而不是角动量本身的方向。' },
    ],
    rng
  ),

  (rng) => mcq(
    {
      id: `def-rigid-${Math.floor(rng() * 1e6)}`,
      concepts: ['definition'],
      difficulty: 1,
      stem: '刚体绕固定轴转动时，角动量大小可以写成？',
      explanation: '定轴转动时 L = Iω，其中 I 是绕该轴的转动惯量，ω 是角速度。',
    },
    [
      { text: 'L = Iω', correct: true },
      { text: 'L = mv', why: 'mv 是线动量，不是角动量；角动量还要乘上力臂或对应转动惯量。' },
      { text: 'L = Iω²', why: 'Iω² 与转动动能有关（Ek = ½Iω²），量纲也不是角动量。' },
      { text: 'L = ½Iω²', why: '½Iω² 是转动动能，不是角动量。' },
    ],
    rng
  ),

  (rng) => mcq(
    {
      id: `def-torque-${Math.floor(rng() * 1e6)}`,
      concepts: ['definition', 'conservation'],
      difficulty: 2,
      stem: '角动量定理指出：系统角动量的变化率等于？',
      explanation: 'dL/dt = τ_ext，即角动量的变化率等于合外力矩；这是判断守恒的核心依据。',
    },
    [
      { text: '作用在系统上的合外力矩', correct: true },
      { text: '作用在系统上的合外力', why: '合外力改变的是线动量（dP/dt = F），不是角动量。' },
      { text: '系统的转动动能', why: '转动动能是标量，与角动量变化率没有这种直接关系。' },
      { text: '系统的转动惯量', why: '转动惯量描述质量分布，不决定角动量的变化率。' },
    ],
    rng
  ),

  (rng) => mcq(
    {
      id: `def-inertia-${Math.floor(rng() * 1e6)}`,
      concepts: ['definition'],
      difficulty: 1,
      stem: '关于转动惯量 I，下列说法正确的是？',
      explanation: 'I = Σmᵢrᵢ²，质量分布越远离转轴，转动惯量越大；同一物体绕不同轴的 I 不同。',
    },
    [
      { text: '质量分布越远离转轴，转动惯量越大', correct: true },
      { text: '转动惯量只由总质量决定，与分布无关', why: '同样质量的圆环与实心圆盘，转动惯量并不相同。' },
      { text: '转动惯量与转轴位置无关', why: '同一物体绕不同轴的转动惯量一般不同，平行轴定理正说明了这一点。' },
      { text: '转动惯量的单位是 kg·m/s', why: 'I 的单位是 kg·m²；kg·m/s 是线动量的单位。' },
    ],
    rng
  ),

  // ---------- 守恒条件 ----------
  (rng) => mcq(
    {
      id: `con-condition-${Math.floor(rng() * 1e6)}`,
      concepts: ['conservation'],
      difficulty: 1,
      stem: '下列哪种情况，系统对某定点的角动量一定守恒？',
      explanation: '角动量守恒的条件是合外力矩为零。合外力为零并不能保证合外力矩为零。',
    },
    [
      { text: '系统所受合外力矩为零', correct: true },
      { text: '系统所受合外力为零', why: '合外力为零时，力仍可能形成力偶矩，角动量不一定守恒。' },
      { text: '系统的动能保持不变', why: '动能不变与角动量是否守恒无必然联系。' },
      { text: '系统的角速度保持不变', why: '角速度不变只是一种运动状态，并不等价于角动量守恒条件。' },
    ],
    rng
  ),

  (rng) => mcq(
    {
      id: `con-trap-${Math.floor(rng() * 1e6)}`,
      concepts: ['conservation'],
      difficulty: 2,
      stem: '“系统所受合外力为零，则系统角动量一定守恒。”这句话正确吗？',
      explanation: '不正确。角动量守恒要求合外力矩为零；一对大小相等、方向相反但不在同一直线上的力（力偶）可以合力为零而合力矩不为零。',
    },
    [
      { text: '错误：还要求合外力矩为零', correct: true },
      { text: '正确：合外力为零就够了', why: '合力为零不代表合力矩为零，例如力偶。' },
      { text: '只对质点系成立', why: '无论质点系还是刚体，判据都是合外力矩为零。' },
      { text: '只对定轴转动成立', why: '角动量守恒是更普遍的规律，不限于定轴转动。' },
    ],
    rng
  ),

  (rng) => mcq(
    {
      id: `con-skater-${Math.floor(rng() * 1e6)}`,
      concepts: ['conservation', 'quantitative'],
      difficulty: 2,
      stem: '花样滑冰运动员在冰面上收臂旋转时越转越快，主要原因是？',
      explanation: '冰面摩擦与空气阻力对竖直轴的力矩近似为零，角动量 L 守恒；收臂使 I 减小，于是 ω = L/I 增大。',
    },
    [
      { text: '转动惯量减小，角动量守恒使角速度增大', correct: true },
      { text: '收臂产生了额外的外力矩', why: '收臂主要依靠内力，对竖直转轴的外力矩近似为零。' },
      { text: '转动动能守恒，所以角速度增大', why: '收臂时转动动能实际上增加，能量来自运动员做功，并非动能守恒。' },
      { text: '重力在收臂过程中做了正功', why: '重力沿竖直方向，对竖直转轴的力矩为零，不改变绕该轴的角动量。' },
    ],
    rng
  ),

  (rng) => mcq(
    {
      id: `con-friction-${Math.floor(rng() * 1e6)}`,
      concepts: ['conservation', 'data'],
      difficulty: 2,
      stem: '转台轴承存在摩擦时，转台系统的角动量将？',
      explanation: '轴承摩擦对转轴施加阻力矩，属于外力矩，因此 dL/dt = τ_f ≠ 0，角动量逐渐减小。',
    },
    [
      { text: '不守恒，因为摩擦提供了外力矩', correct: true },
      { text: '仍然守恒，摩擦是内力', why: '轴承摩擦来自转台外部支架，对转台系统而言是外力矩。' },
      { text: '保持不变但角速度减小', why: '若 L 不变而 I 不变，ω 也不会减小；两者矛盾。' },
      { text: '与是否摩擦无关', why: '摩擦矩直接改变角动量，不能忽略。' },
    ],
    rng
  ),

  (rng) => mcq(
    {
      id: `con-orbit-${Math.floor(rng() * 1e6)}`,
      concepts: ['conservation'],
      difficulty: 3,
      stem: '卫星沿椭圆轨道绕地球运动，对地心的角动量守恒。由此可以判断？',
      explanation: '万有引力始终指向地心，对地心力矩为零，所以角动量守恒；r 减小则速度增大，近日点速度最大。',
    },
    [
      { text: '卫星在近日点的速度最大', correct: true },
      { text: '卫星的速率始终不变', why: '速率会随轨道半径变化，只有角动量守恒，线速度大小并不守恒。' },
      { text: '卫星在远日点动能最大', why: '远日点半径大、速度小，动能反而较小。' },
      { text: '卫星的角速度始终不变', why: 'ω = v_⊥/r，会随位置变化。' },
    ],
    rng
  ),

  // ---------- 定量 ----------
  (rng) => mcq(
    {
      id: `quant-half-${Math.floor(rng() * 1e6)}`,
      concepts: ['quantitative', 'conservation'],
      difficulty: 1,
      stem: '在角动量守恒的前提下，若转动惯量变为原来的一半，角速度变为原来的？',
      explanation: 'L = Iω 不变，所以 ω 与 I 成反比。I 减半，ω 变为 2 倍。',
    },
    [
      { text: '2 倍', correct: true },
      { text: '4 倍', why: '4 倍对应 I 变为 1/4，而不是 1/2。' },
      { text: '一半', why: 'I 与 ω 成反比，I 减小则 ω 增大，不会减小。' },
      { text: '不变', why: 'I 改变而 L 不变时，ω 必须改变。' },
    ],
    rng
  ),

  (rng) => mcq(
    {
      id: `quant-energy-${Math.floor(rng() * 1e6)}`,
      concepts: ['energy', 'quantitative'],
      difficulty: 2,
      stem: '角动量守恒时，若转动惯量减半，转动动能变为原来的？',
      explanation: 'Ek = L²/(2I)。L 不变、I 减半，Ek 变为 2 倍。',
    },
    [
      { text: '2 倍', correct: true },
      { text: '4 倍', why: '若 I 变为 1/4，动能才变为 4 倍。' },
      { text: '一半', why: 'I 减小使动能增大，而不是减小。' },
      { text: '不变', why: '动能与 I 成反比；L 不变而 I 改变时动能会变化。' },
    ],
    rng
  ),

  (rng) => mcq(
    {
      id: `quant-unit-${Math.floor(rng() * 1e6)}`,
      concepts: ['quantitative', 'definition'],
      difficulty: 1,
      stem: '角动量的国际单位是？',
      explanation: 'L 的单位由 r × p 得到：m · kg·m/s = kg·m²/s，也可写为 J·s。',
    },
    [
      { text: 'kg·m²/s', correct: true },
      { text: 'kg·m/s', why: 'kg·m/s 是线动量的单位。' },
      { text: 'kg·m²/s²', why: 'kg·m²/s² 是能量（J）的单位。' },
      { text: 'N·m', why: 'N·m 是力矩或功的单位，不是角动量。' },
    ],
    rng
  ),

  // ---------- 碰撞 ----------
  (rng) => mcq(
    {
      id: `col-conserve-${Math.floor(rng() * 1e6)}`,
      concepts: ['collision', 'conservation'],
      difficulty: 2,
      stem: '子弹水平击中并嵌入竖直杆（杆可绕中心光滑支点转动）。碰撞瞬间，下列哪个量守恒？',
      explanation: '碰撞时间极短，支点冲力过支点、力矩为零，因此绕支点的角动量守恒；支点对系统有冲力，线动量不守恒。',
    },
    [
      { text: '绕支点的角动量', correct: true },
      { text: '系统的线动量', why: '支点对杆有冲力，系统所受合外力不为零，线动量不守恒。' },
      { text: '系统的机械能', why: '子弹嵌入杆是完全非弹性碰撞，机械能明显损失。' },
      { text: '子弹的速度', why: '子弹嵌入后随杆转动，速度大小和方向都改变。' },
    ],
    rng
  ),

  (rng) => mcq(
    {
      id: `col-energy-${Math.floor(rng() * 1e6)}`,
      concepts: ['collision', 'energy'],
      difficulty: 2,
      stem: '子弹嵌入杆的碰撞中，损失的机械能主要转化为？',
      explanation: '完全非弹性碰撞中，机械能转化为形变内能、热能及声能；角动量仍然守恒。',
    },
    [
      { text: '形变内能、热与声', correct: true },
      { text: '杆的角动量', why: '角动量不是能量，且碰撞中角动量守恒，不会“转化”为能量。' },
      { text: '系统的重力势能', why: '水平桌面上的碰撞几乎不改变重力势能。' },
      { text: '子弹的电场能', why: '此过程与电场无关。' },
    ],
    rng
  ),

  (rng) => mcq(
    {
      id: `col-d-${Math.floor(rng() * 1e6)}`,
      concepts: ['collision'],
      difficulty: 1,
      stem: '关系式 mvd = Iω 中，d 表示？',
      explanation: 'd 是子弹速度方向到支点的垂直距离（力臂），因此角动量为 mvd。',
    },
    [
      { text: '击点到支点的垂直距离', correct: true },
      { text: '杆的总长度', why: '杆长用于计算转动惯量，不是角动量中的力臂。' },
      { text: '子弹的直径', why: '子弹尺寸远小于力臂，可视为质点。' },
      { text: '杆转过的角度', why: 'd 是长度量，不是角度。' },
    ],
    rng
  ),

  (rng) => mcq(
    {
      id: `col-linear-${Math.floor(rng() * 1e6)}`,
      concepts: ['collision', 'conservation'],
      difficulty: 3,
      stem: '在子弹击杆实验中，为什么不能直接用线动量守恒求碰后速度？',
      explanation: '支点对杆施加了冲力，系统所受合外力不为零，因此线动量不守恒；但该冲力过支点，力矩为零，角动量守恒。',
    },
    [
      { text: '支点对杆有冲力，合外力不为零', correct: true },
      { text: '因为碰撞时间太短', why: '时间短正说明冲量有限、可忽略外力矩，并非线动量不守恒的原因。' },
      { text: '因为子弹质量太小', why: '质量小不影响守恒条件的判断。' },
      { text: '因为杆不是刚体', why: '题目默认杆为刚体；这不是原因。' },
    ],
    rng
  ),

  // ---------- 实验与误差 ----------
  (rng) => mcq(
    {
      id: `data-error-${Math.floor(rng() * 1e6)}`,
      concepts: ['data', 'conservation'],
      difficulty: 2,
      stem: '在转台实验中，多次测得 L = Iω 有约 1% 的波动，最合理的解释是？',
      explanation: '真实实验存在读数误差、轴承微摩擦、平台未完全水平等因素；1% 的波动属于正常误差范围，不能据此否定守恒定律。',
    },
    [
      { text: '存在读数误差与微小摩擦等实验误差', correct: true },
      { text: '角动量守恒定律不成立', why: '1% 的偏差远小于典型实验误差，不能据此否定物理规律。' },
      { text: 'L = Iω 公式错误', why: '公式在定轴转动中严格成立。' },
      { text: '角速度必须保持不变', why: '角速度会随转动惯量改变，守恒的是 L。' },
    ],
    rng
  ),

  (rng) => mcq(
    {
      id: `data-method-${Math.floor(rng() * 1e6)}`,
      concepts: ['data'],
      difficulty: 2,
      stem: '用转台实验验证角动量守恒，下列做法最合理的是？',
      explanation: '应在同一次转动中改变半径并记录多组 I、ω，计算 L 的偏差；改变初始角速度会引入新的初始条件。',
    },
    [
      { text: '同一次转动中改变半径，记录多组 I 与 ω', correct: true },
      { text: '每组数据都重新设定不同的初始角速度', why: '这样得到的 L 参考值不同，难以直接比较守恒性。' },
      { text: '只记录半径最大时的一组数据', why: '单组数据无法验证 L 是否保持不变。' },
      { text: '用手按住转台使其减速再记录', why: '手的外力会引入外力矩，破坏守恒条件。' },
    ],
    rng
  ),

  // ---------- 数值题 ----------
  (rng) => {
    const I0 = round(pick(rng, [0.4, 0.5, 0.6, 0.7]), 1);
    const m = pick(rng, [1, 1.5, 2]);
    const r0 = pick(rng, [0.5, 0.6]);
    const r1 = round(r0 / 2, 2);
    const w0 = pick(rng, [1, 1.2, 1.5, 2]);
    const i0 = I0 + 2 * m * r0 * r0;
    const i1 = I0 + 2 * m * r1 * r1;
    const w1 = (i0 * w0) / i1;
    return {
      id: `num-radius-${Math.floor(rng() * 1e6)}`,
      concepts: ['quantitative', 'conservation'],
      difficulty: 2,
      type: 'numeric',
      stem: `转台系统初始转动惯量 I₀ = ${I0} kg·m²，两侧各有一个 m = ${m} kg 的配重位于 r = ${r0} m 处，初始角速度 ω₀ = ${w0} rad/s。若把配重收到 r = ${r1} m，忽略摩擦，求新的角速度 ω₁（rad/s）。`,
      answer: w1,
      tolerance: 0.04,
      unit: 'rad/s',
      hint: '先算 I = I₀ + 2mr²，再利用 L = I₀ω₀ = I₁ω₁。',
      explanation: `I₀总 = ${I0} + 2×${m}×${r0}² = ${i0.toFixed(2)} kg·m²，L = ${(i0 * w0).toFixed(2)} kg·m²/s；I₁总 = ${i1.toFixed(2)} kg·m²，所以 ω₁ = L / I₁总 ≈ ${w1.toFixed(2)} rad/s。`,
      solution: `ω₁ = (I₀ + 2mr₀²)ω₀ / (I₀ + 2mr₁²) ≈ ${w1.toFixed(2)} rad/s`,
    };
  },

  (rng) => {
    const I0 = pick(rng, [0.5, 0.6]);
    const m = pick(rng, [1.5, 2]);
    const r0 = pick(rng, [0.5, 0.6]);
    const r1 = pick(rng, [0.2, 0.25, 0.3]);
    const w0 = pick(rng, [1.2, 1.5]);
    const i0 = I0 + 2 * m * r0 * r0;
    const i1 = I0 + 2 * m * r1 * r1;
    const e0 = 0.5 * i0 * w0 * w0;
    const e1 = (e0 * i0) / i1;
    return {
      id: `num-energy-${Math.floor(rng() * 1e6)}`,
      concepts: ['energy', 'quantitative'],
      difficulty: 3,
      type: 'numeric',
      stem: `系统初始转动惯量 ${i0.toFixed(2)} kg·m²，角速度 ${w0} rad/s。收臂后转动惯量变为 ${i1.toFixed(2)} kg·m²。若角动量守恒，收臂后转动动能约为多少焦耳（保留两位小数）？`,
      answer: e1,
      tolerance: 0.05,
      unit: 'J',
      hint: 'Ek = L²/(2I)，也可用 Ek = ½Iω²；先由 L = Iω 求 L。',
      explanation: `L = ${i0.toFixed(2)}×${w0} = ${(i0 * w0).toFixed(2)} kg·m²/s。收臂后 Ek = L²/(2I₁) = ${e1.toFixed(2)} J（约 ${(e1 / e0).toFixed(2)} 倍）。`,
      solution: `Ek₁ = L² / (2I₁) = ${e1.toFixed(2)} J`,
    };
  },

  (rng) => {
    const M = 1.0;
    const Lrod = 0.8;
    const m = round(pick(rng, [0.01, 0.015, 0.02, 0.025, 0.03]), 3);
    const v = pick(rng, [200, 250, 300, 350, 400]);
    const d = pick(rng, [0.2, 0.25, 0.3]);
    const Irod = (M * Lrod * Lrod) / 12;
    const I = Irod + m * d * d;
    const w = (m * v * d) / I;
    return {
      id: `num-collision-${Math.floor(rng() * 1e6)}`,
      concepts: ['collision', 'quantitative'],
      difficulty: 2,
      type: 'numeric',
      stem: `质量 M = ${M} kg、长 ${Lrod} m 的均匀杆可绕中心光滑支点转动。质量 m = ${m} kg 的子弹以 v = ${v} m/s 击中距支点 d = ${d} m 处并嵌入杆中。求碰后杆的角速度 ω（rad/s）。`,
      answer: w,
      tolerance: 0.04,
      unit: 'rad/s',
      hint: '碰前角动量 L = mvd；碰后 I = ML²/12 + md²；再用 ω = L/I。',
      explanation: `L = mvd = ${m}×${v}×${d} = ${(m * v * d).toFixed(3)} kg·m²/s；I = ML²/12 + md² = ${I.toFixed(4)} kg·m²；ω = L/I ≈ ${w.toFixed(2)} rad/s。`,
      solution: `ω = mvd / (ML²/12 + md²) ≈ ${w.toFixed(2)} rad/s`,
    };
  },

  (rng) => {
    const I = round(0.4 + rng() * 1.6, 2);
    const w = round(0.8 + rng() * 3.2, 2);
    const L = I * w;
    return {
      id: `num-L-${Math.floor(rng() * 1e6)}`,
      concepts: ['quantitative', 'definition'],
      difficulty: 1,
      type: 'numeric',
      stem: `某刚体绕固定轴转动，转动惯量 I = ${I} kg·m²，角速度 ω = ${w} rad/s。它的角动量 L 是多少 kg·m²/s？`,
      answer: L,
      tolerance: 0.03,
      unit: 'kg·m²/s',
      hint: '定轴转动直接用 L = Iω。',
      explanation: `L = Iω = ${I}×${w} = ${L.toFixed(2)} kg·m²/s。`,
      solution: `L = Iω = ${L.toFixed(2)} kg·m²/s`,
    };
  },
];

/** 生成题池：同一工厂多生成几次数值题，增加变式。 */
export function buildPool(seed = Date.now()) {
  const rng = mulberry32(seed);
  const pool = [];
  for (let roundIndex = 0; roundIndex < 2; roundIndex += 1) {
    for (const factory of FACTORIES) {
      pool.push(factory(rng));
    }
  }
  return pool;
}

function targetDifficulty(mastery) {
  if (mastery < 0.45) return 1;
  if (mastery < 0.72) return 2;
  return 3;
}

/**
 * 自适应选题：
 *  - 首题固定为概念定义基础题，第二题优先守恒条件；
 *  - 之后每轮选择掌握度最低的概念，再在候选题中挑难度最匹配者；
 *  - 保证至少覆盖 4 个概念。
 */
export function selectAdaptiveQuiz(mastery = defaultMastery(), count = 8, seed = Date.now()) {
  const rng = mulberry32(seed);
  const pool = buildPool(seed + 17);
  const used = new Set();
  const picks = [];

  const take = (item) => {
    if (!item || used.has(item.id)) return false;
    used.add(item.id);
    picks.push(item);
    return true;
  };

  const byConcept = (key) => pool.filter((item) => item.concepts.includes(key));
  const warmup = byConcept('definition').find((i) => i.difficulty === 1);
  take(warmup);
  const condition = byConcept('conservation').find((i) => i.difficulty === 1 || i.difficulty === 2);
  take(condition);

  while (picks.length < count) {
    const coverage = new Map();
    for (const item of picks) {
      for (const c of item.concepts) coverage.set(c, (coverage.get(c) || 0) + 1);
    }
    const ranked = CONCEPT_KEYS.map((key) => ({
      key,
      mastery: mastery[key] ?? 0.5,
      covered: coverage.get(key) || 0,
      jitter: rng() * 0.12,
    })).sort((a, b) => a.covered - b.covered || a.mastery + a.jitter - (b.mastery + b.jitter));

    let chosen = null;
    for (const { key, mastery: m } of ranked) {
      const diff = targetDifficulty(m);
      const candidates = pool.filter(
        (item) =>
          !used.has(item.id) &&
          item.concepts.includes(key) &&
          Math.abs(item.difficulty - diff) <= 1
      );
      if (candidates.length) {
        candidates.sort(
          (a, b) => Math.abs(a.difficulty - diff) - Math.abs(b.difficulty - diff)
        );
        const top = candidates.slice(0, 3);
        chosen = top[Math.floor(rng() * top.length)];
        break;
      }
    }
    if (!chosen) {
      const rest = pool.filter((item) => !used.has(item.id));
      if (!rest.length) break;
      chosen = rest[Math.floor(rng() * rest.length)];
    }
    take(chosen);
  }

  return picks;
}

function withinTolerance(value, answer, tolerance) {
  if (!Number.isFinite(value)) return false;
  return Math.abs(value - answer) <= Math.max(Math.abs(answer) * tolerance, 1e-9);
}

function numericDiagnosis(item, value) {
  const error = Math.abs(value - item.answer) / Math.max(Math.abs(item.answer), 1e-9);
  if (error < 0.15) {
    return {
      headline: '非常接近，但还差一点',
      body: `你的答案与标准值相差约 ${(error * 100).toFixed(1)}%，在 3% 容差之外。检查一下单位换算与有效数字：${item.solution}`,
    };
  }
  if (error > 0.4 && error < 0.7) {
    return {
      headline: '量级接近，可能漏掉了某个因子',
      body: `结果约为标准值的 ${(item.answer / Math.max(value, 1e-9)).toFixed(1)} 倍。${item.hint} 标准解法：${item.solution}`,
    };
  }
  return {
    headline: '思路需要调整',
    body: `${item.hint} 标准解法：${item.solution}`,
  };
}

/**
 * 判分并生成纠错反馈。
 * @param {object} item
 * @param {{option?:number, value?:number}} response
 */
export function gradeItem(item, response) {
  if (item.type === 'mcq') {
    const correct = response.option === item.answerIndex;
    const selected = item.options[response.option];
    const correctOption = item.options[item.answerIndex];
    return {
      correct,
      headline: correct ? '回答正确' : '这里有一个常见误区',
      body: correct
        ? item.explanation
        : `${selected?.why || '这个选项不正确。'} 正确答案是「${correctOption.text}」。${item.explanation}`,
      explanation: item.explanation,
    };
  }

  const value = Number(response.value);
  const correct = withinTolerance(value, item.answer, item.tolerance ?? 0.03);
  if (correct) {
    return {
      correct,
      headline: '计算正确',
      body: item.explanation,
      explanation: item.explanation,
    };
  }
  return {
    correct,
    headline: '数值未落在容差内',
    body: numericDiagnosis(item, value).body,
    explanation: item.explanation,
  };
}

/** 用答题结果更新概念掌握度。 */
export function updateMastery(mastery, concepts, correct, difficulty = 2) {
  const next = { ...mastery };
  const bonus = difficulty === 3 ? 1.15 : difficulty === 1 ? 0.9 : 1;
  for (const concept of concepts) {
    const current = next[concept] ?? 0.5;
    next[concept] = correct
      ? Math.min(1, current + (0.3 * bonus) * (1 - current))
      : Math.max(0.05, current - (0.2 * bonus) * current);
  }
  return next;
}

/** 汇总测评：正确率、各概念表现、薄弱点。 */
export function summarizeQuiz(items, answers) {
  let correctCount = 0;
  const byConcept = {};
  const weak = [];
  const details = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const answer = answers[i];
    const right = answer?.correct ?? false;
    if (right) correctCount += 1;
    for (const c of item.concepts) {
      if (!byConcept[c]) byConcept[c] = { right: 0, total: 0 };
      byConcept[c].total += 1;
      if (right) byConcept[c].right += 1;
    }
    details.push({
      id: item.id,
      stem: item.stem,
      correct: right,
      selected: answer?.option ?? null,
      value: answer?.value ?? null,
    });
  }

  for (const [key, stat] of Object.entries(byConcept)) {
    if (stat.right / stat.total < 0.6) weak.push(key);
  }

  return {
    score: Math.round((correctCount / Math.max(items.length, 1)) * 100),
    correctCount,
    total: items.length,
    byConcept,
    weak,
    details,
  };
}
