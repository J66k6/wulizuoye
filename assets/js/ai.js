/**
 * ai.js — 本地 AI 物理助教引擎
 *
 * 它不是“关键词自动回复”：每次回答都会读取实时仿真状态、实验数据、
 * 任务进度与测评掌握度，进行上下文计算；能识别常见迷思概念，按苏格拉底
 * 式提示引导，并生成可评分的随机变式题。
 *
 * 若用户在设置中填入兼容 OpenAI Chat Completions 的接口，则优先走云端
 * 大模型；网络或跨域失败时自动回退到本地引擎，保证离线可用。
 */

import { fmt, summarize } from './physics.js';

const CN = {
  definition: '概念理解',
  conservation: '守恒条件',
  quantitative: '定量计算',
  energy: '能量与功',
  collision: '碰撞',
  data: '实验与误差',
};

/* ------------------------------------------------------------------
   文本评分规则（用于任务 3 / 任务 5 / 学习反思）
   ------------------------------------------------------------------ */
export const RUBRICS = {
  task3: {
    title: '收臂过程中角动量与能量的关系',
    minLength: 30,
    items: [
      {
        label: '指出收臂时人对配重做正功',
        weight: 2,
        patterns: [/做功|做的功|作功/, /拉|收臂|手臂|向心|克服|人体|人/],
      },
      {
        label: '指出转动惯量 I 减小',
        weight: 1.5,
        patterns: [/转动惯量|惯性|I/],
      },
      {
        label: '说明角速度 ω 因此增大',
        weight: 1.5,
        patterns: [/角速度|ω|转速/],
      },
      {
        label: '说明角动量守恒（外力矩为零）',
        weight: 1.5,
        patterns: [/角动量|L/, /守恒|不变/],
      },
    ],
  },
  task5: {
    title: '碰撞中的角动量与能量',
    minLength: 30,
    items: [
      {
        label: '角动量守恒：mvd = Iω',
        weight: 2,
        patterns: [/角动量|mvd|Iω|Iω/],
      },
      {
        label: '支点冲力使线动量不守恒',
        weight: 1.5,
        patterns: [/线动量|冲力|支点|外力/],
      },
      {
        label: '机械能损失为内能/热/形变',
        weight: 2,
        patterns: [/内能|热|形变|声|非弹性|损失/],
      },
      {
        label: '说明碰撞是完全非弹性',
        weight: 1,
        patterns: [/非弹性|嵌入|粘|不分离/],
      },
    ],
  },
  reflection: {
    title: '学习反思',
    minLength: 60,
    items: [
      {
        label: '指出无外力矩（或外力矩可忽略）是守恒原因',
        weight: 1.5,
        patterns: [/外力矩|力矩|摩擦|忽略/],
      },
      {
        label: '说明 I 减小导致 ω 增大',
        weight: 1.5,
        patterns: [/转动惯量|I/, /角速度|ω|转速|增大|变大/],
      },
      {
        label: '说明动能增加来自人体做功',
        weight: 1.5,
        patterns: [/做功|拉力|手臂|人|能量/],
      },
      {
        label: '结合实验数据或误差讨论',
        weight: 1,
        patterns: [/数据|测量|误差|记录|L|偏差/],
      },
    ],
  },
};

/**
 * 按量规评估一段自由文本。
 * @returns {{score:number, covered:string[], missing:string[], feedback:string}}
 */
export function evaluateText(text, rubricKey) {
  const rubric = RUBRICS[rubricKey];
  const source = String(text || '').trim();
  if (!rubric || !source) {
    return { score: 0, covered: [], missing: [], feedback: '还没有内容可以评估。' };
  }
  const covered = [];
  const missing = [];
  let earned = 0;
  let total = 0;
  for (const item of rubric.items) {
    total += item.weight;
    const hit = item.patterns.every((re) => re.test(source));
    if (hit) {
      covered.push(item.label);
      earned += item.weight;
    } else {
      missing.push(item.label);
    }
  }
  let ratio = earned / total;
  const length = source.replace(/\s/g, '').length;
  if (length < rubric.minLength) {
    ratio *= 0.72;
  }
  if (/\d+(\.\d+)?/.test(source)) ratio += 0.04;
  ratio = Math.max(0, Math.min(1, ratio));

  const parts = [];
  if (covered.length) parts.push(`你已经讲清楚了：${covered.join('；')}。`);
  if (missing.length) parts.push(`还可以补充：${missing.join('；')}。`);
  if (length < rubric.minLength) parts.push(`篇幅偏短（${length} 字），建议展开因果链：条件 → I 变化 → ω 变化 → 能量来源。`);
  if (ratio >= 0.9) parts.push('概念覆盖完整，逻辑链清楚。');
  else if (ratio >= 0.6) parts.push('方向正确，把“为什么”再补一句会更完整。');

  return {
    score: Math.round(ratio * 100),
    covered,
    missing,
    feedback: parts.join(' '),
  };
}

/* ------------------------------------------------------------------
   工具
   ------------------------------------------------------------------ */
function firstNumber(text) {
  const match = String(text).match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function approx(value, digits = 2) {
  return fmt(value, digits);
}

function labTarget(ctx, targetRadius = 0.3) {
  const lab = ctx.lab || {};
  const I0 = lab.I0 ?? 0.6;
  const mass = lab.mass ?? 2;
  const inertia = I0 + 2 * mass * targetRadius * targetRadius;
  const omega = lab.L / Math.max(inertia, 1e-9);
  const energy = (lab.L * lab.L) / (2 * Math.max(inertia, 1e-9));
  return { inertia, omega, energy };
}

function dataStats(ctx) {
  const list = ctx.data || [];
  const Ls = list.map((d) => d.L);
  const stats = summarize(Ls);
  const maxDev = stats.mean > 0
    ? Math.max(...Ls.map((L) => (Math.abs(L - stats.mean) / stats.mean) * 100), 0)
    : 0;
  const radii = list.map((d) => d.radius);
  return {
    n: list.length,
    mean: stats.mean,
    std: stats.std,
    maxDev,
    rMin: radii.length ? Math.min(...radii) : null,
    rMax: radii.length ? Math.max(...radii) : null,
  };
}

function levelOf(dev) {
  if (dev <= 1) return '优秀';
  if (dev <= 3) return '良好';
  if (dev <= 5) return '可接受';
  return '偏大';
}

function labSentence(ctx) {
  const l = ctx.lab || {};
  return `你当前 I = ${approx(l.inertia)} kg·m²，ω = ${approx(l.omega)} rad/s，L = Iω = ${approx(l.L, 3)} kg·m²/s，Ek = ${approx(l.energy)} J。`;
}

/* ------------------------------------------------------------------
   主引擎
   ------------------------------------------------------------------ */
export class TutorEngine {
  constructor() {
    this.history = [];
    this.pendingProblem = null;
    this.problemAttempts = 0;
    this.llm = { enabled: false, endpoint: '', model: '', key: '' };
    this.lastSource = 'local';
  }

  configureLLM(config = {}) {
    this.llm = {
      enabled: Boolean(config.enabled),
      endpoint: String(config.endpoint || '').trim(),
      model: String(config.model || '').trim(),
      key: String(config.key || '').trim(),
    };
  }

  setHistory(messages) {
    this.history = (messages || [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.text)
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.text }));
  }

  get usingCloud() {
    return Boolean(this.llm.enabled && this.llm.endpoint && this.llm.key);
  }

  /**
   * 主入口。
   * @param {string} raw
   * @param {object} ctx 由 App 提供的实时上下文
   * @returns {Promise<{text:string, source:string, problem?:object}>}
   */
  async ask(raw, ctx) {
    const text = String(raw || '').trim();
    if (!text) return { text: '我在。你可以问我任何一个关于角动量的问题。', source: 'local' };

    this.history.push({ role: 'user', content: text });
    if (this.history.length > 16) this.history.splice(0, this.history.length - 16);

    const pendingReply = this.tryPendingProblem(text);
    if (pendingReply) {
      this.history.push({ role: 'assistant', content: pendingReply.text });
      return { ...pendingReply, source: 'local' };
    }

    let reply;
    if (this.usingCloud) {
      try {
        const cloud = await this.askCloud(text, ctx);
        reply = { text: cloud, source: 'cloud' };
        this.lastSource = 'cloud';
      } catch (error) {
        const local = this.localAnswer(text, ctx);
        reply = {
          text: `${local.text}\n\n> 云端模型暂时不可用（${this.friendlyError(error)}），已切换本地引擎。`,
          source: 'local',
        };
        this.lastSource = 'local';
      }
    } else {
      reply = { text: this.localAnswer(text, ctx).text, source: 'local' };
      this.lastSource = 'local';
    }

    if (reply.text.length > 2600) reply.text = `${reply.text.slice(0, 2600)}…`;
    this.history.push({ role: 'assistant', content: reply.text });
    return reply;
  }

  friendlyError(error) {
    if (!error) return '未知错误';
    if (error.name === 'AbortError') return '请求超时';
    if (/Failed to fetch|NetworkError|CORS/i.test(error.message || '')) return '网络或跨域限制';
    return String(error.message || error).slice(0, 60);
  }

  /* ------------------------- 本地回答 ------------------------- */

  localAnswer(raw, ctx) {
    const text = raw.trim();
    const lower = text.toLowerCase();

    if (/^(你好|您好|hi|hello|嗨|在吗|哈喽)/i.test(lower)) {
      return {
        text: [
          '你好！我是你的角动量实验助教。',
          `我正看着你的实验台：${labSentence(ctx)}`,
          '你可以让我解释现象、分析数据、出题考你，或者直接说“下一步”。',
        ].join('\n\n'),
      };
    }

    if (/谢谢|感谢|thx|thanks/.test(lower)) {
      return {
        text: '不客气。物理不是记住结论，而是能预测结果。要不要我出一个小题，检验一下你刚才的理解？',
      };
    }

    if (/(你能做什么|会什么|有什么功能|怎么帮我|能力)/.test(lower)) {
      return {
        text: [
          '我能做四件事，而且都基于你的实时实验状态：',
          '- **解释现象**：例如为什么收臂后转得更快，用你的 I、ω、L 算给你看；',
          '- **分析数据**：读取你记录的多组数据，判断 L 的偏差与可能原因；',
          '- **识别迷思**：你说出“角速度守恒”这类错误时，我会指出并纠正；',
          '- **出题与评估**：随机生成变式题，或按量规给任务 3/5 和学习反思评分。',
          '',
          '试试问我：“用我的数据解释一下”。',
        ].join('\n'),
      };
    }

    if (/(出题|考考|考我|来一道|测试一下|练习)/.test(lower)) {
      return { text: this.newProblem(ctx) };
    }

    if (/(怎么玩|怎么用|如何操作|教程|上手|怎么开始|第一次|新手)/.test(lower)) {
      return { text: this.howTo(ctx) };
    }

    if (/(下一步|现在做什么|该做什么|接下来|怎么学|帮我安排|计划)/.test(lower)) {
      return { text: this.nextStep(ctx) };
    }

    const misconception = this.detectMisconception(text, ctx);
    if (misconception) {
      return { text: misconception };
    }

    const intents = [
      { id: 'whySpeed', score: this.score(lower, ['为什么', '收臂', '半径', '变快', '转得', '角速度', '变大', '变小', '转速']) + (/(收臂|半径|变快|转得|转速)/.test(lower) ? 2 : 0) },
      { id: 'energy', score: this.score(lower, ['能量', '动能', '做功', '焦耳', '机械能', ' Ek', 'ek', '增加']) },
      { id: 'condition', score: this.score(lower, ['守恒条件', '什么时候守恒', '外力矩', '力矩为零', '为什么守恒', '守恒吗', '条件']) },
      { id: 'formula', score: this.score(lower, ['公式', '怎么算', '计算', '表达式', '推导', '关系式', '等于']) },
      { id: 'definition', score: this.score(lower, ['什么是', '定义', '角动量是', '转动惯量是', '概念', '含义', '解释']) },
      { id: 'collision', score: this.score(lower, ['碰撞', '子弹', '杆', '嵌入', '非弹性', '击', '冲量']) },
      { id: 'friction', score: this.score(lower, ['摩擦', '损耗', '误差', '精度', '偏差', '不准']) },
      { id: 'data', score: this.score(lower, ['数据', '记录', '分析', '测量', '拟合', '曲线', '结果']) + (/(分析|看看).{0,4}(数据|结果)/.test(lower) ? 2 : 0) },
      { id: 'units', score: this.score(lower, ['单位', '量纲']) },
      { id: 'report', score: this.score(lower, ['报告', '总结', '评价', '诊断', '表现']) },
      { id: 'vector', score: this.score(lower, ['方向', '右手', '矢量', '向量', '垂直']) },
      { id: 'reflection', score: this.score(lower, ['反思', '怎么写', '写作', '论述']) },
      { id: 'quizHelp', score: this.score(lower, ['测评', '题目', '答案', '选项', '错题']) },
    ].sort((a, b) => b.score - a.score);

    const best = intents[0];
    if (best && best.score >= 2) {
      switch (best.id) {
        case 'whySpeed': return { text: this.whySpeed(ctx) };
        case 'energy': return { text: this.explainEnergy(ctx) };
        case 'condition': return { text: this.explainCondition(ctx) };
        case 'formula': return { text: this.explainFormula(ctx) };
        case 'definition': return { text: this.explainDefinition(ctx) };
        case 'collision': return { text: this.explainCollision(ctx) };
        case 'friction': return { text: this.explainFriction(ctx) };
        case 'data': return { text: this.analyzeData(ctx) };
        case 'units': return { text: this.explainUnits() };
        case 'report': return { text: this.quickReport(ctx) };
        case 'vector': return { text: this.explainVector(ctx) };
        case 'reflection': return { text: this.reflectionGuide() };
        case 'quizHelp': return { text: this.quizHelp(ctx) };
        default: break;
      }
    }

    return { text: this.fallback(text, ctx) };
  }

  score(text, terms) {
    let score = 0;
    for (const term of terms) {
      if (text.includes(term.toLowerCase())) score += term.length > 2 ? 2 : 1;
    }
    return score;
  }

  detectMisconception(text, ctx) {
    const rules = [
      {
        re: /角速度.{0,6}(守恒|不变)/,
        body: [
          '**需要纠正**：在这个实验里守恒的是角动量 **L = Iω**，不是角速度 ω。',
          '收臂时 I 变小，为了保持 L 不变，ω 必须变大。你可以说“角速度保持不变”只适用于 I 不变的刚体定轴转动。',
          labSentence(ctx),
        ],
      },
      {
        re: /(机械能|能量).{0,6}(守恒|不变)/,
        body: [
          '**注意区分**：收臂过程中角动量守恒，但机械能**不守恒**。',
          '转动动能 Ek = L²/(2I)，I 减小时 Ek 增大。增加的能量来自人对配重做的功（内力做功），不是凭空产生的。',
          '碰撞实验里更明显：角动量守恒，但大量机械能转化为内能和热。',
        ],
      },
      {
        re: /(半径|r).{0,8}(越大|增大).{0,10}(角速度|转速|转得).{0,6}(越大|越快)/,
        body: [
          '**方向反了**：角动量守恒时 ω = L/I，半径增大 → I 增大 → ω 反而减小。',
          '花样滑冰收臂变快，正是因为半径减小、I 减小。',
          '你可以拖动配重试一下，观察 HUD 里的 I 和 ω。',
        ],
      },
      {
        re: /合外力.{0,6}为零.{0,12}(角动量|守恒)/,
        body: [
          '**这是一道经典陷阱**：合外力为零 ≠ 合外力矩为零。',
          '角动量守恒的条件是 **合外力矩为零**。例如一对力偶，合力为零但合力矩不为零，角动量会改变。',
          '所以判断顺序是：先选参考点 → 看外力对该点的力矩 → 再谈守恒。',
        ],
      },
      {
        re: /线动量.{0,8}守恒/,
        body: [
          '**在子弹击杆中，线动量并不守恒。**',
          '碰撞瞬间支点对杆有冲力，系统所受合外力不为零；但这个冲力通过支点，对支点的力矩为零，所以绕支点的角动量守恒。',
          '这正是为什么这类题要从角动量入手，而不是用 mv = (M+m)v′。',
        ],
      },
      {
        re: /离心力/,
        body: [
          '在**惯性系**里没有“离心力”这个真实力。配重做圆周运动需要指向圆心的向心力，由手臂的拉力提供。',
          '收臂时手臂对抗的是配重的惯性趋势，做正功，使系统转动动能增加。若在旋转参考系中引入离心力，那是惯性力，不改变角动量守恒的判断。',
        ],
      },
    ];
    for (const rule of rules) {
      if (rule.re.test(text)) {
        return rule.body.filter(Boolean).join('\n\n');
      }
    }
    return null;
  }

  whySpeed(ctx) {
    const target = labTarget(ctx, 0.3);
    const lab = ctx.lab || {};
    return [
      '**一句话：L 守恒，I 减小，所以 ω 增大。**',
      '',
      `无外力矩时 L = Iω 不变。${labSentence(ctx)}`,
      `如果收臂到 r = 0.30 m，I 会变为约 ${approx(target.inertia)} kg·m²，角速度预测为 ω = L/I ≈ ${approx(target.omega)} rad/s，约为现在的 ${approx(target.omega / Math.max(lab.omega, 1e-6), 1)} 倍。`,
      `此时转动动能会从 ${approx(lab.energy)} J 增加到约 ${approx(target.energy)} J——这部分能量来自你收臂时做的功，不是“无中生有”。`,
      '',
      '去实验台把 r 拖到 0.30 m，看看 HUD 里的 ω 是否吻合。',
    ].join('\n');
  }

  explainEnergy(ctx) {
    const lab = ctx.lab || {};
    const target = labTarget(ctx, 0.3);
    const delta = target.energy - lab.energy;
    return [
      '**角动量守恒 ≠ 能量守恒。**',
      `当前 Ek = L²/(2I) = ${approx(lab.energy)} J；收臂到 r = 0.30 m 后约 ${approx(target.energy)} J。`,
      `增加的 ${approx(Math.abs(delta))} J 来自**人对配重做的功**：手臂拉着配重向内，拉力方向与径向位移同向，做正功。`,
      '在子弹击杆中则相反：角动量守恒，但机械能大量损失，变成形变内能、热和声。',
      '',
      '所以判断能量是否变化，不能只看“守恒定律”的名字，要看有没有非保守内力做功。',
    ].join('\n');
  }

  explainCondition(ctx) {
    return [
      '**角动量守恒的条件：对所选参考点，合外力矩为零。**',
      '判断步骤：',
      '- 选定参考点（通常是转轴或支点）；',
      '- 列出所有外力对该点的力矩；',
      '- 若合力矩为零，则 L 守恒；否则 dL/dt = τ_ext。',
      '',
      `在转台实验中，重力与支持力过转轴，力矩为零；轴承摩擦会提供阻力矩，所以开启摩擦后 L 会衰减。`,
      ctx.lab?.friction
        ? '你现在开启了摩擦，HUD 里的 L 偏差会逐渐变大，这正是“外力矩破坏守恒”的直接证据。'
        : '你现在关闭了摩擦，L 的相对偏差应保持在很小范围内。',
    ].join('\n');
  }

  explainFormula(ctx) {
    return [
      '**核心公式**',
      '- 角动量：`L = Iω`（定轴转动）或 `L = r × p`（质点）；',
      '- 转动惯量：`I = Σmᵢrᵢ²`，本实验 `I = I₀ + 2mr²`；',
      '- 角动量定理：`dL/dt = τ_ext`；',
      '- 转动动能：`Ek = ½Iω² = L²/(2I)`。',
      '',
      `${labSentence(ctx)}`,
      '想知道某个具体数值，直接把题目参数发给我，我可以一步步代入。',
    ].join('\n');
  }

  explainDefinition(ctx) {
    return [
      '**角动量**描述“转动的运动量”，对定轴转动是 `L = Iω`；对质点则是 `L = r × p`，方向由右手螺旋定则确定，单位 kg·m²/s。',
      '**转动惯量** `I = Σmᵢrᵢ²` 描述质量相对转轴的分布：质量越靠外，I 越大，越难改变转动状态。',
      '',
      `${labSentence(ctx)}`,
      '把 L 想成“转动版的动量”，把 I 想成“转动版的质量”，就很容易理解为什么 I 变小时 ω 会变大。',
    ].join('\n');
  }

  explainCollision(ctx) {
    const c = ctx.collision || {};
    const lines = [
      '**碰撞瞬间，绕支点的角动量守恒：** `mvd = Iω`。',
      '其中 d 是子弹速度线到支点的垂直距离（力臂），I 是碰后“杆 + 子弹”绕支点的转动惯量。',
    ];
    if (c.solution) {
      lines.push(
        '',
        `你现在这组参数：m = ${c.mass * 1000} g，v = ${c.speed} m/s，d = ${c.offset} m；`,
        `L = mvd ≈ ${approx(c.solution.angularMomentum, 3)} kg·m²/s，I ≈ ${approx(c.solution.inertia, 4)} kg·m²，`,
        `所以碰后 ω ≈ ${approx(c.solution.omega)} rad/s，机械能损失约 ${(c.solution.energyLossFraction * 100).toFixed(1)}%。`
      );
    } else {
      lines.push('', '先在碰撞实验里提交你的预测，再发射，我们对比一下你的结果。');
    }
    lines.push('', '注意：支点有冲力，所以线动量不守恒；能量也大量损失。');
    return lines.join('\n');
  }

  explainFriction(ctx) {
    const lab = ctx.lab || {};
    const stats = dataStats(ctx);
    const lines = [
      '**摩擦会引入外力矩，角动量不再严格守恒。**',
      '轴承摩擦矩与转向相反，dL/dt < 0，所以 ω 会逐渐减小；如果同时改变半径，ω 的变化就是“守恒项 + 摩擦项”的叠加。',
    ];
    if (lab.friction) {
      lines.push(`你现在开启了摩擦，L 已从参考值 ${approx(lab.Lref, 3)} 变为 ${approx(lab.L, 3)} kg·m²/s（偏差 ${approx(lab.deltaL)}%）。`);
    } else {
      lines.push('当前摩擦关闭，是验证守恒的理想条件。');
    }
    if (stats.n >= 2) {
      lines.push(`你的 ${stats.n} 组数据中，L 的最大相对偏差为 ${approx(stats.maxDev)}%，属于“${levelOf(stats.maxDev)}”水平。`);
    }
    return lines.join('\n');
  }

  analyzeData(ctx) {
    const stats = dataStats(ctx);
    if (!stats.n) {
      return '你还没有记录数据。先在实验台转动平台，至少记录 3 组不同半径的数据，我才能分析 L 的稳定性。';
    }
    const lines = [
      `**你的 ${stats.n} 组数据**`,
      `- L 平均值：${approx(stats.mean, 3)} kg·m²/s，标准差 ${approx(stats.std, 3)}；`,
      `- 最大相对偏差：${approx(stats.maxDev)}%，评价为“${levelOf(stats.maxDev)}”；`,
      `- 半径范围：${approx(stats.rMin)} – ${approx(stats.rMax)} m。`,
    ];
    if (stats.n < 3) lines.push('', '只有 1–2 组数据还不足以验证守恒，再记录几组不同半径。');
    if (stats.rMax !== null && stats.rMax - stats.rMin < 0.2) {
      lines.push('', '半径跨度偏小，I 的变化不明显。试试从 0.60 m 收到 0.25 m 附近。');
    }
    if (ctx.lab?.friction) {
      lines.push('', '⚠️ 你开启了轴承摩擦，它属于外力矩，会让 L 系统性下降。验证守恒时应关闭摩擦。');
    } else if (stats.maxDev > 3) {
      lines.push('', '偏差偏大时，检查记录时机是否在半径稳定之后，以及是否误触了初始角速度。');
    } else {
      lines.push('', '数据落在 3% 以内，已经能支撑“L = Iω 守恒”的结论。可以去做任务 2 的定量预测。');
    }
    const trend = (ctx.data || []).length >= 3 && (ctx.data || []).every((d, i, arr) => i === 0 || d.L <= arr[i - 1].L + 1e-9);
    if (trend && (ctx.data || []).length >= 4) {
      lines.push('L 呈单调下降趋势，通常意味着存在持续的阻力矩（摩擦或空气阻力），而不是随机读数误差。');
    }
    return lines.join('\n');
  }

  nextStep(ctx) {
    const tasks = ctx.tasks || {};
    const stats = dataStats(ctx);
    const steps = [];
    if (!stats.n) {
      steps.push('先记录数据：点“开始/暂停”让平台转起来，拖动哑铃改变半径，再点“记录数据”。');
    } else if (!tasks.t1?.done) {
      steps.push(`完成任务 1：你已有 ${stats.n} 组数据，目标 3 组且半径跨度 ≥ 0.25 m，偏差 ≤ 2%。`);
    }
    if (!tasks.t2?.done) {
      const target = labTarget(ctx, 0.3);
      steps.push(`定量预测：在任务 2 里先写下 r = 0.30 m 时的 ω 预测值；参考值是 L/I ≈ ${approx(target.omega)} rad/s。`);
    }
    if (!tasks.t3?.done) {
      steps.push('解释能量：用 30 字以上回答“为什么收臂后动能增加、L 不变”，AI 会按量规评分。');
    }
    if (!ctx.quiz?.completed) {
      steps.push('智能测评：完成 8 道自适应题，AI 会定位你的薄弱概念。');
    } else if ((ctx.quiz.weak || []).length) {
      steps.push(`复习薄弱点：${ctx.quiz.weak.map((k) => CN[k] || k).join('、')}，可以让我针对性地讲。`);
    }
    if (!ctx.collision?.predicted) {
      steps.push('碰撞实验：切到“碰撞实验”，先提交预测，再发射子弹。');
    }

    if (steps.length === 0) {
      return '任务基本完成了。现在最值得做的是：写一段 80 字以上的学习反思（“为什么角动量守恒而动能增加”），然后查看学习报告，检查 AI 给出的能力雷达。';
    }
    if (steps.length === 1) {
      return `当前只剩一件事：${steps[0]}\n\n完成后记得写学习反思，并查看学习报告。`;
    }
    const numbered = steps.map((step, index) => `**${index + 1}.** ${step}`).join('\n\n');
    return `按下面的顺序做，学习效果最好：\n\n${numbered}\n\n完成后记得写学习反思。`;
  }

  howTo(ctx) {
    return [
      '**三步上手**',
      '1. **转起来**：点“开始/暂停”，平台开始旋转；',
      '2. **改变半径**：拖动两侧哑铃，或拉动“配重半径”滑块，观察 I、ω、L 的实时变化；',
      '3. **记录与验证**：点“记录数据”，至少记录 3 组不同半径，然后提交任务 1。',
      '',
      '接着完成任务 2（预测 ω）和任务 3（解释能量），再去“碰撞实验”和“智能测评”。',
      '有任何一步卡住，直接说“下一步”，我会根据你的进度给出具体指令。',
    ].join('\n');
  }

  explainUnits() {
    return [
      '**单位速查**',
      '- 角动量 L：kg·m²/s（等价于 J·s）；',
      '- 转动惯量 I：kg·m²；',
      '- 角速度 ω：rad/s；',
      '- 力矩 τ：N·m；',
      '- 转动动能 Ek：J。',
      '',
      '量纲检查是物理计算最便宜的纠错工具：如果算出来的 L 单位是 kg·m/s，那多半是把线动量当成了角动量。',
    ].join('\n');
  }

  explainVector(ctx) {
    return [
      '**方向判断用右手螺旋定则**：四指从 r 转向 p（或从转轴指向速度方向），拇指指向 L。',
      '本实验中平台绕竖直轴逆时针旋转，从上方看 L 竖直向上；碰撞实验从上方看，L 垂直纸面向里。',
      `在 HUD 里，L 是标量大小；方向不会改变“L = Iω”的数值关系，但在矢量题中必须写清楚。`,
      '如果题目要求用向量表示，L = r × p 的叉乘顺序不能反，反了方向就相反。',
    ].join('\n');
  }

  reflectionGuide() {
    return [
      '**反思写作提示**（80 字以上，按因果链展开）：',
      '- 条件：转轴方向合外力矩为零，因此 L 守恒；',
      '- 过程：收臂 → r 减小 → I 减小 → ω = L/I 增大；',
      '- 能量：Ek = L²/(2I) 增大，增加量来自人收臂时做的功；',
      '- 证据：引用你记录的数据，说明 L 的偏差在实验误差内。',
      '',
      '写好后到“学习报告”页点“AI 评分”，我会指出你遗漏的概念。',
    ].join('\n');
  }

  quickReport(ctx) {
    const stats = dataStats(ctx);
    const quiz = ctx.quiz || {};
    const tasksDone = Object.values(ctx.tasks || {}).filter((t) => t.done).length;
    return [
      '**快速诊断**',
      `- 实验：${stats.n} 组数据，L 最大偏差 ${approx(stats.maxDev)}%（${levelOf(stats.maxDev)}）；`,
      `- 任务：完成 ${tasksDone} / 5；`,
      `- 测评：${quiz.completed ? `最近得分 ${quiz.score} 分，薄弱点 ${(quiz.weak || []).map((k) => CN[k] || k).join('、') || '暂无'}` : '尚未完成'}。`,
      '',
      '完整的分数拆解、能力雷达与打印版报告在“学习报告”页。要我现在针对薄弱点讲一个概念吗？',
    ].join('\n');
  }

  quizHelp(ctx) {
    const quiz = ctx.quiz || {};
    const weak = (quiz.weak || []).map((k) => CN[k] || k);
    if (quiz.completed) {
      return [
        `你最近一次测评得分 **${quiz.score}** 分。`,
        weak.length ? `薄弱概念是：${weak.join('、')}。我可以先讲一个，再出两道变式题。` : '各概念表现比较均衡，可以挑战更高难度的变式题。',
        '',
        '测评时我不直接给答案，但可以给你提示或换一个角度解释。',
      ].join('\n');
    }
    return [
      '测评共 8 题，AI 会根据你的掌握度动态选题。答错后，每个干扰项都有对应的迷思解释，不会只告诉你“错了”。',
      '准备好了就点“开始智能测评”。如果你想先热身，我可以现在出一道题。',
    ].join('\n');
  }

  fallback(text, ctx) {
    const topic = text.length > 24 ? `${text.slice(0, 24)}…` : text;
    return [
      `关于“${topic}”，先回到守恒的框架来判断，会比背结论更可靠。`,
      labSentence(ctx),
      '你可以把问题拆成三问：**系统是什么？外力矩是否为零？要求的是 L、ω 还是 Ek？**',
      '如果你愿意，把具体数值或你的思路发给我，我可以逐步和你核对；也可以说“出题考考我”。',
    ].join('\n');
  }

  /* ------------------------- 出题与判题 ------------------------- */

  newProblem(ctx) {
    const inCollision = ctx.view === 'collision';
    const rng = Math.random;
    let problem;
    if (inCollision) {
      const m = [0.01, 0.02, 0.03][Math.floor(rng() * 3)];
      const v = [200, 300, 400][Math.floor(rng() * 3)];
      const d = [0.2, 0.25, 0.3][Math.floor(rng() * 3)];
      const Irod = (1 * 0.8 * 0.8) / 12;
      const I = Irod + m * d * d;
      const omega = (m * v * d) / I;
      problem = {
        question: `杆质量 M = 1 kg、长 0.8 m，可绕中心光滑支点转动。质量 m = ${m * 1000} g 的子弹以 v = ${v} m/s 击中距支点 d = ${d} m 处并嵌入。碰后角速度 ω 约为多少 rad/s？`,
        answer: omega,
        unit: 'rad/s',
        hint: '先求碰前角动量 mvd，再求碰后转动惯量 ML²/12 + md²，最后 ω = L/I。',
        solution: `ω = mvd / (ML²/12 + md²) = ${approx(omega)} rad/s`,
      };
    } else if (rng() > 0.42) {
      const I0 = 0.6;
      const m = 2;
      const r0 = 0.6;
      const r1 = 0.3;
      const w0 = 1.5;
      const i0 = I0 + 2 * m * r0 * r0;
      const i1 = I0 + 2 * m * r1 * r1;
      const answer = (i0 * w0) / i1;
      problem = {
        question: `转台系统的固有转动惯量为 0.6 kg·m²，两侧各有 2 kg 配重，初始半径 r₀ = 0.60 m，角速度 ω₀ = 1.5 rad/s。忽略摩擦，把配重收到 r₁ = 0.30 m 后，角速度约为多少 rad/s？`,
        answer,
        unit: 'rad/s',
        hint: 'I = 0.6 + 2×2×r²，角动量 L = I₀ω₀ 守恒。',
        solution: `I₀ = ${i0.toFixed(2)} kg·m²，L = ${(i0 * w0).toFixed(2)}；I₁ = ${i1.toFixed(2)}，ω₁ = L/I₁ ≈ ${answer.toFixed(2)} rad/s`,
      };
    } else {
      const I = [0.8, 1.2, 1.6][Math.floor(rng() * 3)];
      const w = [2, 2.5, 3][Math.floor(rng() * 3)];
      problem = {
        question: `某飞轮的转动惯量 I = ${I} kg·m²，以 ω = ${w} rad/s 匀速转动。它的角动量 L 是多少 kg·m²/s？`,
        answer: I * w,
        unit: 'kg·m²/s',
        hint: '定轴转动直接使用 L = Iω。',
        solution: `L = Iω = ${I} × ${w} = ${I * w} kg·m²/s`,
      };
    }

    this.pendingProblem = problem;
    this.problemAttempts = 0;
    return `来一道小题，直接用数字回复我（不用写单位）：\n\n${problem.question}\n\n> 如果卡住了，回复“提示”；想直接看解法，回复“答案”。`;
  }

  tryPendingProblem(text) {
    if (!this.pendingProblem) return null;
    if (/提示|怎么算|不会|卡住|hint/i.test(text)) {
      return {
        text: `提示：${this.pendingProblem.hint}\n\n仍然卡住的话，回复“答案”查看完整解法。`,
      };
    }
    if (/答案|解法|公布|告诉我结果/i.test(text)) {
      const p = this.pendingProblem;
      this.pendingProblem = null;
      return { text: `完整解法：\n\n${p.solution}\n\n自己再复算一遍，比看答案更有用。` };
    }
    const value = firstNumber(text);
    if (value === null) return null;

    const p = this.pendingProblem;
    const tolerance = Math.max(Math.abs(p.answer) * 0.05, 1e-9);
    if (Math.abs(value - p.answer) <= tolerance) {
      this.pendingProblem = null;
      return {
        text: `**正确。** ${p.solution}\n\n要不要再来一道？回复“出题”即可。`,
      };
    }

    this.problemAttempts += 1;
    if (this.problemAttempts >= 2) {
      this.pendingProblem = null;
      return {
        text: `差一点。你的答案是 ${approx(value)}，标准答案约为 ${approx(p.answer)} ${p.unit}。\n\n完整解法：${p.solution}\n\n注意检查：是否先算了总转动惯量，再代入 L = Iω。`,
      };
    }
    return {
      text: `这个数值还不对。你的答案 ${approx(value)}，再检查一下思路。\n\n提示：${p.hint}\n\n可以再试一次。`,
    };
  }

  /* ------------------------- 报告生成 ------------------------- */

  generateReportNarrative(ctx, summary) {
    const stats = dataStats(ctx);
    const strongest = Object.entries(ctx.quiz?.mastery || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([key]) => CN[key] || key);
    const weakest = Object.entries(ctx.quiz?.mastery || {})
      .sort((a, b) => a[1] - b[1])
      .slice(0, 2)
      .map(([key]) => CN[key] || key);
    const parts = [];
    parts.push(
      `本次综合得分 **${summary.total} / 100**（${summary.level}）。` +
        `实验操作 ${summary.parts.operation} / 30，碰撞 ${summary.parts.collision} / 20，测评 ${summary.parts.quiz} / 30，反思 ${summary.parts.reflection} / 20。`
    );

    if (stats.n >= 3) {
      parts.push(
        `你记录了 ${stats.n} 组数据，L 的平均值为 ${approx(stats.mean, 3)} kg·m²/s，最大相对偏差 ${approx(stats.maxDev)}%，达到“${levelOf(stats.maxDev)}”水平。` +
          (stats.maxDev <= 3
            ? '这组数据能够支持 L = Iω 的守恒结论。'
            : ctx.lab?.friction
              ? '偏差主要来自开启的轴承摩擦，它提供了持续的外力矩。'
              : '建议检查记录时机与半径读数，尽量在平台稳定后采样。')
      );
    } else {
      parts.push('实验数据还偏少，建议在实验台记录至少 3 组不同半径的数据，让结论更有说服力。');
    }

    if (summary.parts.quiz > 0) {
      if (summary.quizScore >= 85) {
        parts.push(
          `智能测评得分 ${summary.quizScore} 分，8 道自适应题表现稳定，各概念掌握较均衡。` +
            '可以尝试更高难度的变式题，或把实验数据导出后做一次误差分析。'
        );
      } else if (summary.quizScore >= 60) {
        parts.push(
          `智能测评得分 ${summary.quizScore} 分。` +
            (strongest.length ? `你相对擅长「${strongest.join('、')}」。` : '') +
            (weakest.length ? `「${weakest.join('、')}」仍有提升空间，可以回看对应实验现象。` : '')
        );
      } else {
        parts.push(
          `智能测评得分 ${summary.quizScore} 分，目前偏低。` +
            (weakest.length
              ? `建议先复习「${weakest.join('、')}」，再用实验台的实时 HUD 验证一遍公式。`
              : '建议重做一遍实验任务，再回来看题目。')
        );
      }
    } else {
      parts.push('还没有完成智能测评，建议用 5 分钟做一轮，AI 会据此更新你的薄弱概念。');
    }

    if (summary.parts.reflection > 0) {
      parts.push('学习反思提交成功，说明你能把“条件—过程—能量”串成完整的因果链。');
    } else {
      parts.push('别忘了写学习反思：解释“为什么角动量守恒而动能增加”，这是最能体现理解深度的一步。');
    }

    const steps = [];
    if (!ctx.tasks?.t1?.done) steps.push({ label: '补全 3 组实验数据', view: 'lab' });
    if (!ctx.tasks?.t2?.done) steps.push({ label: '完成定量预测任务', view: 'lab' });
    if (!ctx.collision?.predicted) steps.push({ label: '尝试碰撞预测', view: 'collision' });
    if (!ctx.quiz?.completed) steps.push({ label: '开始智能测评', view: 'quiz' });
    else if ((ctx.quiz.weak || []).length) steps.push({ label: '让 AI 讲薄弱概念', action: 'tutor-weak' });
    if (!summary.parts.reflection) steps.push({ label: '提交学习反思', view: 'report' });

    return { paragraphs: parts, steps: steps.slice(0, 3) };
  }

  /* ------------------------- 云端 LLM ------------------------- */

  contextSummary(ctx) {
    const l = ctx.lab || {};
    const stats = dataStats(ctx);
    const tasksDone = Object.values(ctx.tasks || {}).filter((t) => t.done).length;
    const c = ctx.collision || {};
    return [
      `界面:${ctx.view}`,
      `r=${approx(l.radius)}m,I=${approx(l.inertia)}kg·m2,w=${approx(l.omega)}rad/s,L=${approx(l.L, 2)},Ek=${approx(l.energy)}J,摩擦=${l.friction ? '开' : '关'},L偏差=${approx(l.deltaL)}%`,
      `数据组数:${stats.n},L最大偏差:${approx(stats.maxDev)}%`,
      `任务完成:${tasksDone}/5`,
      `测评:${ctx.quiz?.completed ? `${ctx.quiz.score}分` : '未完成'},薄弱:${(ctx.quiz?.weak || []).join(',') || '无'}`,
      c.solution
        ? `碰撞:L=${approx(c.solution.angularMomentum, 3)},w=${approx(c.solution.omega)}rad/s,能量损失=${(c.solution.energyLossFraction * 100).toFixed(1)}%`
        : `碰撞:未发射`,
    ].join(';');
  }

  async askCloud(text, ctx) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const system = [
        '你是一名大学物理助教，专长角动量守恒与刚体转动。',
        '请用简体中文回答，先给结论，再结合学生的实时实验数据解释；控制在 220 字以内。',
        '不要编造数据；如果学生答错，指出具体误区，并给出可检验的下一步。',
        '不要直接给出正在进行的测评题答案，用提示引导。',
        `学生实时状态：${this.contextSummary(ctx)}`,
      ].join('\n');

      const res = await fetch(this.llm.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.llm.key}`,
        },
        body: JSON.stringify({
          model: this.llm.model || 'deepseek-chat',
          messages: [
            { role: 'system', content: system },
            ...this.history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
          ],
          temperature: 0.35,
          max_tokens: 500,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content || !String(content).trim()) throw new Error('空回复');
      return String(content).trim();
    } finally {
      clearTimeout(timer);
    }
  }
}
