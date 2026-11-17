/**
 * main.js — 应用控制器
 *
 * 负责状态管理、视图切换、DOM 事件、动画循环，并把
 * physics / render / ai / quiz / sound 五个模块连接成完整体验。
 */

import {
  RotatingSystem,
  LAB_LIMITS,
  collisionSolution,
  linearMomentumMistake,
  relError,
  gradePrediction,
  summarize,
  fmt,
} from './physics.js';
import { LabScene, CollisionScene, MiniChart, RadarChart } from './render.js';
import { TutorEngine, evaluateText } from './ai.js';
import {
  CONCEPTS,
  CONCEPT_KEYS,
  defaultMastery,
  selectAdaptiveQuiz,
  gradeItem,
  updateMastery,
  summarizeQuiz,
} from './quiz.js';
import { Sound } from './sound.js';

/* =========================================================
   基础工具
   ========================================================= */

const STORAGE_KEY = 'amlab.state.v2';
const KEY_STORAGE = 'amlab.llm.key';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const ICONS = {
  play: '#i-play',
  pause: '#i-pause',
};

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function inlineMarkdown(escaped) {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** 极简 Markdown → HTML：只支持本应用用到的粗体、代码、列表与引用。 */
function renderMarkdown(text) {
  const lines = escapeHTML(text).split('\n');
  let html = '';
  let list = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html += `<p>${inlineMarkdown(paragraph.join(' '))}</p>`;
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      html += `<ul>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`;
      list = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      list.push(line.replace(/^[-*]\s+/, ''));
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushParagraph();
      flushList();
      html += `<p class="chat-note">${inlineMarkdown(line.replace(/^>\s?/, ''))}</p>`;
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return html;
}

function createDefaultState() {
  return {
    version: 2,
    startedAt: Date.now(),
    profile: { name: '' },
    lab: { radius: 0.6, omega0: 1.2, friction: false, L: null, Lref: null },
    data: [],
    tasks: {
      t1: { done: false, score: 0, detail: '' },
      t2: { done: false, score: 0, prediction: null, detail: '' },
      t3: { done: false, score: 0, text: '', feedback: '' },
      t4: { done: false, score: 0, prediction: null, detail: '' },
      t5: { done: false, score: 0, text: '', feedback: '' },
    },
    collision: { massG: 20, speed: 300, offset: 0.3, prediction: null, fired: false, lastResult: null },
    quiz: {
      active: false,
      completed: false,
      items: [],
      answers: [],
      index: 0,
      score: null,
      best: null,
      attempts: 0,
      mastery: defaultMastery(),
      summary: null,
      history: [],
    },
    reflection: { text: '', score: null, feedback: '' },
    chat: [],
    settings: {
      voice: false,
      sound: true,
      llm: {
        enabled: false,
        endpoint: 'https://api.deepseek.com/v1/chat/completions',
        model: 'deepseek-chat',
      },
    },
    flags: { welcomeDismissed: false, coachedCollision: false },
  };
}

function hydrateState(saved) {
  const base = createDefaultState();
  if (!saved || saved.version !== 2) return base;
  return {
    ...base,
    ...saved,
    profile: { ...base.profile, ...saved.profile },
    lab: { ...base.lab, ...saved.lab },
    tasks: Object.fromEntries(
      Object.keys(base.tasks).map((key) => [key, { ...base.tasks[key], ...(saved.tasks?.[key] || {}) }])
    ),
    collision: { ...base.collision, ...saved.collision },
    quiz: {
      ...base.quiz,
      ...saved.quiz,
      mastery: { ...base.quiz.mastery, ...(saved.quiz?.mastery || {}) },
    },
    reflection: { ...base.reflection, ...saved.reflection },
    settings: {
      ...base.settings,
      ...saved.settings,
      llm: { ...base.settings.llm, ...(saved.settings?.llm || {}) },
    },
    flags: { ...base.flags, ...saved.flags },
    data: Array.isArray(saved.data) ? saved.data.slice(-80) : [],
    chat: Array.isArray(saved.chat) ? saved.chat.slice(-40) : [],
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const state = hydrateState(raw ? JSON.parse(raw) : null);
    if (!Array.isArray(state.quiz.items)) state.quiz.items = [];
    if (!Array.isArray(state.quiz.answers)) state.quiz.answers = [];
    if (!Array.isArray(state.quiz.history)) state.quiz.history = [];
    return state;
  } catch {
    return createDefaultState();
  }
}

const state = loadState();
let saveTimer = 0;

function persistNow() {
  try {
    // 把运行时角动量一并保存，刷新后 HUD 与已记录数据保持一致
    state.lab.L = model.L;
    state.lab.Lref = model.Lref;
    state.lab.radius = Number(model.radius.toFixed(3));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, chat: state.chat.slice(-40) }));
  } catch {
    /* 存储空间不足时静默失败，不影响实验 */
  }
}

function saveSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(persistNow, 350);
}

function toast(message, type = 'info', duration = 3200) {
  const stack = $('#toast-stack');
  if (!stack) return;
  const node = document.createElement('div');
  node.className = `toast${type === 'info' ? '' : ` is-${type}`}`;
  node.textContent = message;
  stack.appendChild(node);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  window.setTimeout(() => {
    node.classList.add('is-leaving');
    window.setTimeout(() => node.remove(), 320);
  }, duration);
}

function download(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatDate(timestamp = Date.now()) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function nowClock() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function setText(el, value) {
  if (el && el.textContent !== String(value)) el.textContent = String(value);
}

/* =========================================================
   模型与场景
   ========================================================= */

const model = new RotatingSystem({
  I0: LAB_LIMITS.I0,
  mass: LAB_LIMITS.MASS,
  radius: state.lab.radius,
  omega: state.lab.omega0,
  friction: state.lab.friction,
});

// 恢复上次保存的角动量，确保刷新后 I、ω 与历史数据来自同一状态
if (state.lab.L !== null && state.lab.L !== undefined && Number.isFinite(Number(state.lab.L))) {
  model.L = Math.max(0, Number(state.lab.L));
  if (Number.isFinite(Number(state.lab.Lref))) model.Lref = Number(state.lab.Lref);
  else model.Lref = model.L;
}

let running = !model.stopped;
let activeView = 'lab';
let activeTask = 't1';
let armAnimation = null;
let lastRecordId = 0;
let quizLocked = false;
let pendingQuizResponse = null;
let clearArmed = false;
let resetArmed = false;
let unread = 0;

const audio = new Sound(state.settings.sound);

const labScene = new LabScene($('#lab-canvas'), model, {
  onRadiusChange: (radius) => applyRadius(radius, { fromDrag: true }),
});

const collisionParams = () => ({
  M: 1.0,
  rodLength: 0.8,
  projectileMass: state.collision.massG / 1000,
  speed: state.collision.speed,
  offset: state.collision.offset,
  pivot: 'center',
});

const collScene = new CollisionScene($('#collision-canvas'), {
  onImpact: (solution) => handleCollisionImpact(solution),
});

const tutor = new TutorEngine();
tutor.configureLLM({ ...state.settings.llm, key: sessionStorage.getItem(KEY_STORAGE) || '' });

const chart = new MiniChart($('#chart-canvas'), {
  getData: () => state.data,
  getTheoryL: () => {
    if (state.data.length >= 2) {
      return state.data.reduce((sum, item) => sum + item.L, 0) / state.data.length;
    }
    return model.Lref;
  },
  getCurrent: () => ({ I: model.momentOfInertia, w: model.omega }),
});

const radar = new RadarChart($('#radar-canvas'));

/* =========================================================
   视图切换
   ========================================================= */

function switchView(name, { updateHash = true } = {}) {
  const valid = ['lab', 'collision', 'quiz', 'report'];
  if (!valid.includes(name)) name = 'lab';
  activeView = name;

  $$('.view').forEach((view) => {
    view.classList.toggle('is-active', view.id === `view-${name}`);
  });
  $$('.tab').forEach((tab) => {
    const on = tab.dataset.view === name;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', String(on));
  });

  if (updateHash) {
    history.replaceState(null, '', `#${name}`);
  }

  if (name === 'lab') {
    labScene.measure();
    updateHUD(true);
    chart.draw();
  } else if (name === 'collision') {
    collScene.measure();
    updateCollisionReadouts();
    if (!state.flags.coachedCollision && !state.tasks.t4.done) {
      state.flags.coachedCollision = true;
      saveSoon();
      window.setTimeout(() => {
        tutorSay(
          '先别急着发射：用 m·v·d = I·ω 估一下碰后角速度，再填进“预测”框。AI 会在你发射后对比误差，并检查是否误用了线动量守恒。'
        );
        toast('AI 提示：先预测，再发射', 'info', 3800);
      }, 650);
    }
  } else if (name === 'quiz') {
    renderQuizState();
  } else if (name === 'report') {
    renderReport();
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
  saveSoon();
}

/* =========================================================
   实验台
   ========================================================= */

const targetInertia = () => LAB_LIMITS.I0 + 2 * LAB_LIMITS.MASS * 0.3 * 0.3;

function applyRadius(radius, { fromDrag = false, silent = false } = {}) {
  model.setRadius(radius);
  state.lab.radius = Number(model.radius.toFixed(3));
  const range = $('#r-range');
  if (range && Number(range.value) !== Number(model.radius.toFixed(2))) {
    range.value = String(model.radius.toFixed(2));
  }
  setText($('#r-value'), `${model.radius.toFixed(2)} m`);
  if (!silent) {
    updateHUD(true);
    chart.draw();
    saveSoon();
    if (!fromDrag) audio.click();
  }
}

function setInitialOmega(omega) {
  model.setOmega(omega);
  state.lab.omega0 = Number(omega.toFixed(2));
  setText($('#w-value'), `${model.omega.toFixed(2)} rad/s`);
  if (state.data.length) {
    state.data = [];
    state.tasks.t1 = { done: false, score: 0, detail: '' };
    state.tasks.t2 = { done: false, score: 0, prediction: null, detail: '' };
    renderData();
    renderTaskPanel();
    chart.draw();
    toast('初始角速度已改变，旧测量数据与任务 1/2 记录已清空', 'warn');
  }
  if (model.stopped) {
    running = false;
    syncSpinButton();
  }
  updateHUD(true);
  saveSoon();
}

function setFriction(on) {
  model.friction = Boolean(on);
  state.lab.friction = model.friction;
  const toggle = $('#friction-toggle');
  toggle?.setAttribute('aria-checked', String(model.friction));
  updateHUD(true);
  chart.draw();
  saveSoon();
  if (model.friction) {
    toast('已开启轴承摩擦：外力矩会让角动量逐渐衰减', 'warn', 4200);
    tutorSay(
      '你开启了轴承摩擦。摩擦矩与转动方向相反，属于外力矩，所以 dL/dt = τ_f ≠ 0，L 不再守恒。验证守恒时记得关掉它。'
    );
  } else {
    toast('摩擦已关闭，进入理想守恒条件', 'ok');
  }
  audio.click();
}

function syncSpinButton() {
  const btn = $('#btn-spin');
  if (!btn) return;
  const use = running ? ICONS.pause : ICONS.play;
  btn.querySelector('use')?.setAttribute('href', use);
  const label = btn.querySelector('span');
  if (label) label.textContent = running ? '暂停' : '开始';
  const pill = $('#spin-state');
  if (pill) {
    pill.textContent = model.stopped ? '已停止' : running ? '运行中' : '已暂停';
    pill.classList.toggle('is-paused', !running || model.stopped);
  }
}

function toggleSpin() {
  if (model.stopped) {
    toast('平台已停转：减少摩擦或复位实验后再开始', 'warn');
    return;
  }
  running = !running;
  syncSpinButton();
  audio.whoosh();
  if (running) toast('平台继续旋转', 'ok', 1600);
}

function resetLab() {
  model.reset({ radius: 0.6, omega: state.lab.omega0 });
  state.lab.radius = 0.6;
  running = true;
  applyRadius(0.6, { silent: true });
  syncSliders();
  syncSpinButton();
  updateHUD(true);
  chart.draw();
  saveSoon();
  toast('实验已复位，测量记录保留', 'ok');
  audio.click();
}

function startArmDemo() {
  if (model.radius <= 0.29) {
    toast('配重已经在内侧，先把半径拉到 0.5 m 以上再演示', 'warn');
    return;
  }
  if (model.stopped) {
    toast('平台还没有转动，先点“开始”', 'warn');
    return;
  }
  running = true;
  syncSpinButton();
  armAnimation = {
    from: model.radius,
    to: 0.25,
    elapsed: 0,
    duration: 1.4,
    startOmega: model.omega,
    startRadius: model.radius,
  };
  audio.whoosh();
  toast('收臂演示：注意观察 ω 与 Eₖ 的变化', 'info', 2200);
}

function recordData() {
  if (model.omega < 0.05) {
    toast('平台还没有转动，无法记录角速度', 'warn');
    return;
  }
  const item = {
    id: Date.now() + Math.random(),
    at: Date.now(),
    radius: Number(model.radius.toFixed(3)),
    inertia: model.momentOfInertia,
    omega: model.omega,
    L: model.L,
    energy: model.energy,
    deltaL: model.deltaL,
    friction: model.friction,
  };
  state.data.push(item);
  if (state.data.length > 80) state.data.shift();
  lastRecordId = item.id;
  labScene.flash();
  audio.record();
  renderData();
  chart.draw();
  saveSoon();
  const dev = Math.abs(item.deltaL);
  toast(
    `已记录第 ${state.data.length} 组：I = ${fmt(item.inertia)}，ω = ${fmt(item.omega)}，L = ${fmt(item.L, 3)}`,
    'ok'
  );
  if (state.data.length === 1) {
    tutorSay(
      `第 1 组数据已记录：I = ${fmt(item.inertia)} kg·m²，ω = ${fmt(item.omega)} rad/s，L = ${fmt(item.L, 3)} kg·m²/s。改变半径再记录两组，看看 L 是否变化。`
    );
  }
  if (dev > 3 && state.data.length <= 3) {
    toast('L 偏差偏大，检查是否开启了摩擦或刚调过初始角速度', 'warn', 4200);
  }
  renderTaskPanel();
}

function theoryL() {
  if (state.data.length >= 2) {
    return state.data.reduce((sum, item) => sum + item.L, 0) / state.data.length;
  }
  return model.Lref;
}

function updateHUD(force = false) {
  const snap = model.snapshot();
  setText($('#hud-I'), snap.inertia.toFixed(2));
  setText($('#hud-w'), snap.omega.toFixed(2));
  setText($('#hud-L'), snap.L.toFixed(3));
  setText($('#hud-E'), snap.energy.toFixed(2));
  setText($('#hud-dL'), `${snap.deltaL >= 0 ? '+' : ''}${snap.deltaL.toFixed(2)}%`);
  setText($('#lab-speed-badge'), `ω = ${snap.omega.toFixed(2)} rad/s`);

  const wrap = $('#hud-delta-wrap');
  const note = $('#hud-delta-note');
  const abs = Math.abs(snap.deltaL);
  wrap?.classList.toggle('is-warn', abs > 1 && abs <= 5);
  wrap?.classList.toggle('is-bad', abs > 5);
  setText(note, snap.friction ? (abs > 5 ? '摩擦损耗' : '摩擦中') : abs <= 1 ? '守恒' : '有偏差');

  syncSpinButton();
}

/* =========================================================
   数据表与 CSV
   ========================================================= */

function renderData() {
  const tbody = $('#data-tbody');
  if (!tbody) return;
  tbody.replaceChildren();
  if (!state.data.length) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = 7;
    td.textContent = '还没有数据。转动平台，拖动哑铃，然后点击「记录数据」。';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    state.data.slice().reverse().forEach((item, index) => {
      const tr = document.createElement('tr');
      if (item.id === lastRecordId) tr.classList.add('is-new');
      const deviation = item.deltaL;
      const cells = [
        String(state.data.length - index),
        item.radius.toFixed(2),
        item.inertia.toFixed(2),
        item.omega.toFixed(2),
        item.L.toFixed(3),
        item.energy.toFixed(2),
        `${deviation >= 0 ? '+' : ''}${deviation.toFixed(2)}%`,
      ];
      cells.forEach((text, cellIndex) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (cellIndex === 4) td.className = 'l-cell';
        if (cellIndex === 6) {
          td.className = 'dev-cell';
          const abs = Math.abs(deviation);
          if (abs > 5) td.classList.add('bad');
          else if (abs > 2) td.classList.add('warn');
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }
  setText($('#data-count'), state.data.length);
  $('#chart-empty')?.classList.toggle('is-hidden', state.data.length > 0);
  updateTaskProgress();
}

function clearData() {
  const btn = $('#btn-clear-data');
  if (!clearArmed) {
    clearArmed = true;
    if (btn) btn.textContent = '再点一次确认';
    window.setTimeout(() => {
      clearArmed = false;
      if (btn) btn.textContent = '清空';
    }, 2600);
    return;
  }
  clearArmed = false;
  if (btn) btn.textContent = '清空';
  state.data = [];
  state.tasks.t1 = { done: false, score: 0, detail: '' };
  lastRecordId = 0;
  renderData();
  chart.draw();
  renderTaskPanel();
  saveSoon();
  toast('测量记录与任务 1 成绩已清空', 'ok');
}

function exportCSV() {
  if (!state.data.length) {
    toast('还没有可导出的数据', 'warn');
    return;
  }
  const header = 'index,time,radius_m,inertia_kgm2,omega_rad_s,L_kgm2_s,Ek_J,deltaL_percent,friction';
  const rows = state.data.map((item, index) =>
    [
      index + 1,
      new Date(item.at).toISOString(),
      item.radius.toFixed(3),
      item.inertia.toFixed(4),
      item.omega.toFixed(4),
      item.L.toFixed(5),
      item.energy.toFixed(4),
      item.deltaL.toFixed(3),
      item.friction ? 1 : 0,
    ].join(',')
  );
  download(`角动量实验数据-${Date.now()}.csv`, [header, ...rows].join('\n'), 'text/csv;charset=utf-8');
  toast('CSV 已导出', 'ok');
}

/* =========================================================
   实验任务面板
   ========================================================= */

const TASK_META = {
  t1: { title: '观察守恒', max: 12 },
  t2: { title: '定量预测', max: 10 },
  t3: { title: '能量解释', max: 8 },
  t4: { title: '碰撞预测', max: 12 },
  t5: { title: '碰撞解释', max: 8 },
};

function taskDoneCount() {
  return ['t1', 't2', 't3'].filter((key) => state.tasks[key]?.done).length;
}

function updateTaskProgress() {
  setText($('#task-progress'), `${taskDoneCount()} / 3`);
  $$('.task').forEach((button) => {
    const key = button.dataset.task;
    const task = state.tasks[key];
    button.classList.toggle('is-done', Boolean(task?.done));
    button.classList.toggle('is-open', key === activeTask);
    const scoreEl = button.querySelector('.task-score');
    if (scoreEl) {
      scoreEl.textContent = task?.done
        ? `${Math.round(task.score)}/${TASK_META[key].max}`
        : task?.score > 0
          ? `${Math.round(task.score)}分`
          : '—';
    }
  });
}

function renderTasks() {
  updateTaskProgress();
  renderTaskPanel();
}

function renderTaskPanel() {
  const panel = $('#task-panel');
  if (!panel) return;

  if (activeTask === 't1') {
    panel.innerHTML = task1PanelHTML();
    $('#btn-check-t1')?.addEventListener('click', checkTask1);
    const result = $('#t1-result');
    if (result && state.tasks.t1.detail) {
      result.className = `task-result ${state.tasks.t1.done ? 'is-ok' : 'is-warn'}`;
      result.innerHTML = state.tasks.t1.detail;
    }
  } else if (activeTask === 't2') {
    panel.innerHTML = task2PanelHTML();
    $('#btn-t2')?.addEventListener('click', submitTask2);
    $('#btn-t2-verify')?.addEventListener('click', verifyTask2);
    const result = $('#t2-result');
    if (result && state.tasks.t2.detail) {
      result.className = `task-result ${state.tasks.t2.done ? 'is-ok' : 'is-warn'}`;
      result.innerHTML = state.tasks.t2.detail;
    }
  } else if (activeTask === 't3') {
    panel.innerHTML = task3PanelHTML();
    const textarea = $('#t3-input');
    if (textarea) {
      textarea.value = state.tasks.t3.text || '';
      textarea.addEventListener('input', () => {
        state.tasks.t3.text = textarea.value;
        saveSoon();
      });
    }
    $('#btn-t3')?.addEventListener('click', scoreTask3);
    const result = $('#t3-result');
    if (result && state.tasks.t3.feedback) {
      result.className = `task-result ${state.tasks.t3.done ? 'is-ok' : 'is-warn'}`;
      result.innerHTML = state.tasks.t3.feedback;
    }
  }
}

function task1PanelHTML() {
  const n = state.data.length;
  const radii = state.data.map((item) => item.radius);
  const span = radii.length ? Math.max(...radii) - Math.min(...radii) : 0;
  const Ls = state.data.map((item) => item.L);
  const stats = summarize(Ls);
  const maxDev = stats.mean > 0 ? Math.max(...Ls.map((L) => (Math.abs(L - stats.mean) / stats.mean) * 100), 0) : 0;
  return `
    <h4>01 · 观察守恒</h4>
    <p>在同一次转动中改变半径，记录至少 3 组数据。若 L = Iω 守恒，所有测量点应落在同一条双曲线上。</p>
    <ul class="task-criteria">
      <li>至少 3 组不同半径的数据</li>
      <li>半径跨度 ≥ 0.25 m，让 I 有明显变化</li>
      <li>L 的最大相对偏差 ≤ 2%，建议关闭摩擦</li>
    </ul>
    <div class="task-result ${n ? '' : 'is-warn'}">
      当前：<b>${n}</b> 组数据 · 半径跨度 <b>${span.toFixed(2)}</b> m · L 平均偏差 <b>${maxDev.toFixed(2)}%</b>
    </div>
    <div class="task-field" style="margin-top:10px">
      <button class="btn btn-primary btn-sm" id="btn-check-t1">检查我的数据</button>
      <button class="btn btn-ghost btn-sm" id="btn-t1-record">记录当前一组</button>
    </div>
    <div id="t1-result"></div>
  `;
}

function task2PanelHTML() {
  const prediction = state.tasks.t2.prediction;
  return `
    <h4>02 · 定量预测</h4>
    <p>保持当前转动状态，把配重收到 <b>r = 0.30 m</b>。先用 L = Iω 预测新的角速度，再操作验证。</p>
    <ul class="task-criteria">
      <li>I_target = I₀ + 2mr²，其中 I₀ = ${LAB_LIMITS.I0} kg·m²，m = ${LAB_LIMITS.MASS} kg</li>
      <li>角动量 L 保持不变，因此 ω_target = L / I_target</li>
      <li>允许 20% 误差，越接近得分越高（10 分）</li>
    </ul>
    <div class="task-field">
      <input id="t2-input" type="number" step="0.01" inputmode="decimal" placeholder="预测 ω / rad·s⁻¹" value="${prediction ?? ''}">
      <button class="btn btn-primary btn-sm" id="btn-t2">提交预测</button>
    </div>
    <div class="task-field">
      <button class="btn btn-ghost btn-sm" id="btn-t2-verify">我已调到 0.30 m，验证实际值</button>
    </div>
    <div id="t2-result"></div>
  `;
}

function task3PanelHTML() {
  const task = state.tasks.t3;
  return `
    <h4>03 · 能量解释</h4>
    <p>为什么收臂后 L 不变，ω 和 Eₖ 却增大？用 30 字以上解释，AI 会按“条件—过程—能量”量规评分。</p>
    <div class="task-field" style="flex-direction:column">
      <textarea id="t3-input" maxlength="500" placeholder="试着写出因果链：合外力矩… → I… → ω… → 动能来自…"></textarea>
    </div>
    <div class="task-field">
      <button class="btn btn-primary btn-sm" id="btn-t3">交给 AI 评分</button>
      <span class="task-result" style="flex:1;margin:0">${task.done ? `已完成 ${Math.round(task.score)} / 8` : '评分 ≥ 60 即完成（8 分）'}</span>
    </div>
    <div id="t3-result"></div>
  `;
}

function checkTask1() {
  if (state.data.length < 3) {
    toast('至少需要 3 组数据才能验证守恒', 'warn');
    return;
  }
  const radii = state.data.map((item) => item.radius);
  const span = Math.max(...radii) - Math.min(...radii);
  const Ls = state.data.map((item) => item.L);
  const stats = summarize(Ls);
  const maxDev = stats.mean > 0 ? Math.max(...Ls.map((L) => (Math.abs(L - stats.mean) / stats.mean) * 100), 0) : 0;
  const countRatio = Math.min(1, state.data.length / 3);
  const spanRatio = Math.min(1, span / 0.25);
  const devRatio = maxDev <= 1 ? 1 : maxDev <= 2 ? 0.9 : maxDev <= 3 ? 0.7 : maxDev <= 5 ? 0.4 : 0;
  const rawScore = 12 * (0.3 * countRatio + 0.2 * spanRatio + 0.5 * devRatio);
  const passed = state.data.length >= 3 && span >= 0.25 && maxDev <= 2;
  const task = state.tasks.t1;
  if (passed) {
    task.done = true;
    task.score = Math.max(task.score, rawScore);
    task.detail = `通过：${state.data.length} 组数据，半径跨度 ${span.toFixed(2)} m，L 最大偏差 ${maxDev.toFixed(2)}%。得分 ${rawScore.toFixed(1)} / 12。`;
    toast(`任务 1 通过！L 的最大偏差 ${maxDev.toFixed(2)}%`, 'ok');
    audio.success();
    labScene.flash();
    tutorSay(
      `任务 1 通过：${state.data.length} 组数据的 L 最大偏差仅 ${maxDev.toFixed(2)}%，落在实验误差范围内，支持角动量守恒。`
    );
  } else {
    const reasons = [];
    if (span < 0.25) reasons.push('半径跨度不足 0.25 m');
    if (maxDev > 2) reasons.push('L 偏差超过 2%，检查摩擦或读数时机');
    task.detail = `暂未通过：${reasons.join('；')}。已记录 ${state.data.length} 组，跨度 ${span.toFixed(2)} m，偏差 ${maxDev.toFixed(2)}%。`;
    toast(`暂未通过：${reasons[0]}`, 'warn', 4200);
    audio.error();
  }
  saveSoon();
  renderTasks();
}

function submitTask2() {
  const input = $('#t2-input');
  const predicted = Number(input?.value);
  if (!Number.isFinite(predicted) || predicted <= 0) {
    toast('请输入一个正数作为预测值', 'warn');
    return;
  }
  if (model.omega < 0.05) {
    toast('平台已停止转动，请先复位并让平台转起来', 'warn');
    return;
  }
  const actual = model.L / targetInertia();
  const grade = gradePrediction(predicted, actual);
  const points = 10 * grade.ratio;
  const passed = grade.error <= 20;
  const task = state.tasks.t2;
  task.prediction = predicted;
  if (passed) {
    task.done = true;
    task.score = Math.max(task.score, points);
    task.detail = `预测 ${predicted.toFixed(2)} rad/s，理论值 ${actual.toFixed(2)} rad/s，误差 ${grade.error.toFixed(1)}%。获得 ${points.toFixed(1)} / 10 分。`;
    toast(`预测通过，误差 ${grade.error.toFixed(1)}%`, 'ok');
    audio.success();
    tutorSay(
      `任务 2 通过：你预测 ${predicted.toFixed(2)} rad/s，理论值 ${actual.toFixed(2)} rad/s，误差 ${grade.error.toFixed(1)}%。现在可以把半径拖到 0.30 m 看看实际读数。`
    );
  } else {
    task.detail = `预测 ${predicted.toFixed(2)} rad/s，理论值 ${actual.toFixed(2)} rad/s，误差 ${grade.error.toFixed(1)}%，超过 20% 容差。提示：先用 I_target = I₀ + 2mr² 求新的转动惯量。`;
    toast(`误差 ${grade.error.toFixed(1)}%，再检查一下 I_target 的计算`, 'warn', 4200);
    audio.error();
  }
  saveSoon();
  renderTasks();
}

function verifyTask2() {
  if (Math.abs(model.radius - 0.3) > 0.02) {
    toast('请先把配重半径调到 0.30 m 附近再验证', 'warn');
    return;
  }
  const prediction = state.tasks.t2.prediction;
  if (!prediction) {
    toast('还没有提交预测，先写一个预测值', 'warn');
    return;
  }
  const error = relError(prediction, model.omega);
  const result = $('#t2-result');
  if (result) {
    result.className = `task-result ${error <= 10 ? 'is-ok' : 'is-warn'}`;
    result.innerHTML = `实验验证：实际 ω = <b>${model.omega.toFixed(2)}</b> rad/s，你的预测偏差 <b>${error.toFixed(1)}%</b>。${error <= 10 ? '预测与实验吻合，说明 L = Iω 的守恒成立。' : '偏差较大，检查半径是否真的调到 0.30 m，以及记录时 L 是否已受摩擦影响。'}`;
  }
  if (error <= 10) audio.success();
}

function scoreTask3() {
  const textarea = $('#t3-input');
  const text = textarea?.value.trim() || '';
  if (text.length < 15) {
    toast('请至少写 15 个字，AI 才能评估概念覆盖度', 'warn');
    return;
  }
  const result = evaluateText(text, 'task3');
  const task = state.tasks.t3;
  task.text = text;
  task.feedback = `AI 评分 <b>${result.score} / 100</b>。${result.feedback}`;
  const points = 8 * (result.score / 100);
  if (result.score >= 60) {
    task.done = true;
    task.score = Math.max(task.score, points);
    toast(`AI 评分 ${result.score}，任务 3 完成`, 'ok');
    audio.success();
    tutorSay(`任务 3 评分 ${result.score} / 100。${result.feedback}`);
  } else {
    toast(`AI 评分 ${result.score}，还差一点：${result.missing[0] || '补充因果链'}`, 'warn', 4500);
    audio.error();
  }
  saveSoon();
  renderTasks();
}

/* =========================================================
   碰撞实验
   ========================================================= */

function syncCollisionLabels() {
  setText($('#c-mass-value'), `${state.collision.massG} g`);
  setText($('#c-speed-value'), `${state.collision.speed} m/s`);
  setText($('#c-offset-value'), `${state.collision.offset.toFixed(2)} m`);
  const mass = state.collision.massG / 1000;
  setText($('#c-speed-badge'), `p = m·v = ${(mass * state.collision.speed).toFixed(2)} kg·m/s`);
}

function resetCollisionPrediction() {
  state.collision.prediction = null;
  const input = $('#predict-input');
  if (input) input.value = '';
  const feedback = $('#predict-feedback');
  if (feedback) {
    feedback.className = 'predict-feedback';
    feedback.textContent = '还没有提交预测。先算一算，再发射。';
  }
}

function setCollisionParam(key, value) {
  state.collision[key] = value;
  syncCollisionLabels();
  collScene.setParams(collisionParams());
  state.collision.fired = false;
  state.collision.lastResult = null;
  resetCollisionPrediction();
  updateCollisionReadouts();
  setText($('#c-phase'), '待发射');
  $('#c-phase')?.classList.remove('pill-amber');
  setEnergyBars(null);
  saveSoon();
}

function updateCollisionReadouts() {
  const result = state.collision.lastResult;
  if (result) {
    setText($('#c-hud-L'), result.angularMomentum.toFixed(3));
    setText($('#c-hud-I'), result.inertia.toFixed(4));
    setText($('#c-hud-w'), result.omega.toFixed(2));
    setText($('#c-hud-loss'), (result.energyLossFraction * 100).toFixed(1));
  } else {
    setText($('#c-hud-L'), '—');
    setText($('#c-hud-I'), '—');
    setText($('#c-hud-w'), '?');
    setText($('#c-hud-loss'), '—');
  }
}

function setEnergyBars(result) {
  const beforeBar = $('#energy-before-bar');
  const afterBar = $('#energy-after-bar');
  if (!result) {
    if (beforeBar) beforeBar.style.width = '0%';
    if (afterBar) afterBar.style.width = '0%';
    setText($('#energy-before'), '— J');
    setText($('#energy-after'), '— J');
    setText($('#energy-note'), '发射后显示能量对比。损失的能量转化为形变内能、热与声。');
    return;
  }
  const max = Math.max(result.energyBefore, result.energyAfter, 1);
  const width = (value) => (value / max) * 100;
  if (beforeBar) beforeBar.style.width = `${width(result.energyBefore)}%`;
  if (afterBar) afterBar.style.width = `${width(result.energyAfter)}%`;
  setText($('#energy-before'), `${result.energyBefore.toFixed(0)} J`);
  setText($('#energy-after'), `${result.energyAfter.toFixed(2)} J`);
  const note = $('#energy-note');
  if (note) {
    note.innerHTML = `碰撞损失 <b>${(result.energyLossFraction * 100).toFixed(1)}%</b> 的机械能，转化为内能与热。条形为线性刻度，碰后转动动能只剩下很小一截。`;
  }
}

function collisionHint(predicted, solution) {
  const params = collisionParams();
  const mistake = linearMomentumMistake(params);
  const candidates = [mistake.velocity, mistake.omegaIfLinear].filter((value) => value > 0);
  const looksLinear = candidates.some(
    (value) => Math.abs(predicted - value) / Math.max(value, 1e-9) < 0.2
  );
  if (looksLinear) {
    return `你的数值接近“线动量守恒”估算出的 ${mistake.omegaIfLinear.toFixed(1)} rad/s。但支点对杆有冲力，系统线动量不守恒；应改为绕支点的角动量守恒 mvd = Iω。`;
  }
  if (predicted < solution.omega * 0.5) {
    return '结果偏小：检查是否漏掉了力臂 d，或者把碰后转动惯量算大了。';
  }
  if (predicted > solution.omega * 2) {
    return '结果偏大：检查是否只算了杆的 ML²/12，而漏掉了子弹的 md²。';
  }
  return '检查 L = mvd 与 I = ML²/12 + md² 的单位和数量级，再复算一次。';
}

function fireCollision() {
  if (collScene.phase === 'flying') return;
  const solution = collisionSolution(collisionParams());
  collScene.reset();
  collScene.fire(solution);
  state.collision.fired = false;
  state.collision.lastResult = null;
  updateCollisionReadouts();
  setEnergyBars(null);
  const pill = $('#c-phase');
  if (pill) {
    pill.textContent = '飞行中';
    pill.classList.add('pill-amber');
  }
  const button = $('#btn-fire');
  if (button) button.disabled = true;
  audio.whoosh();
}

function handleCollisionImpact(solution) {
  const result = {
    ...solution,
    at: Date.now(),
  };
  state.collision.lastResult = result;
  state.collision.fired = true;
  updateCollisionReadouts();
  setEnergyBars(result);
  setText($('#c-hud-w'), solution.omega.toFixed(2));
  const pill = $('#c-phase');
  if (pill) {
    pill.textContent = '碰撞完成';
    pill.classList.remove('pill-amber');
  }
  setTimeout(() => {
    if (pill && collScene.phase === 'rotating') pill.textContent = '转动中';
  }, 1400);
  const button = $('#btn-fire');
  if (button) button.disabled = false;

  const prediction = state.collision.prediction;
  const feedback = $('#predict-feedback');
  if (prediction) {
    const grade = gradePrediction(prediction, solution.omega);
    const points = 12 * grade.ratio;
    const passed = grade.error <= 10;
    if (feedback) {
      feedback.className = `predict-feedback ${passed ? 'is-ok' : 'is-bad'}`;
      feedback.innerHTML = `预测 <b>${prediction.toFixed(2)}</b> rad/s，实测 <b>${solution.omega.toFixed(2)}</b> rad/s，误差 <b>${grade.error.toFixed(1)}%</b>。${passed ? '很好，角动量守恒预测成立。' : collisionHint(prediction, solution)}`;
    }
    if (passed) {
      const task = state.tasks.t4;
      task.done = true;
      task.prediction = prediction;
      task.score = Math.max(task.score, points);
      task.detail = `预测 ${prediction.toFixed(2)} rad/s，实测 ${solution.omega.toFixed(2)} rad/s，误差 ${grade.error.toFixed(1)}%。得分 ${points.toFixed(1)} / 12。`;
      toast(`碰撞预测通过，误差 ${grade.error.toFixed(1)}%`, 'ok');
      audio.success();
    } else {
      toast(`预测误差 ${grade.error.toFixed(1)}%，看看提示再试一次`, 'warn', 4000);
    }
  } else if (feedback) {
    feedback.className = 'predict-feedback';
    feedback.textContent = '这次没有预测就发射了。下次先算 mvd = Iω，再对比结果。';
  }

  audio.impact();
  tutorSay(
    `碰撞完成：L = mvd = ${solution.angularMomentum.toFixed(3)} kg·m²/s，碰后 I = ${solution.inertia.toFixed(4)} kg·m²，ω = ${solution.omega.toFixed(2)} rad/s；机械能损失 ${(solution.energyLossFraction * 100).toFixed(1)}%。`
  );
  saveSoon();
  refreshAllTaskUI();
}

function submitCollisionPrediction() {
  const input = $('#predict-input');
  const value = Number(input?.value);
  if (!Number.isFinite(value) || value <= 0) {
    toast('请输入一个正数作为预测值', 'warn');
    return;
  }
  const solution = collisionSolution(collisionParams());
  const grade = gradePrediction(value, solution.omega);
  state.collision.prediction = value;
  const feedback = $('#predict-feedback');
  const passed = grade.error <= 10;
  if (feedback) {
    feedback.className = `predict-feedback ${passed ? 'is-ok' : 'is-bad'}`;
    feedback.innerHTML = `你的预测 <b>${value.toFixed(2)}</b> rad/s，理论值 <b>${solution.omega.toFixed(2)}</b> rad/s，误差 <b>${grade.error.toFixed(1)}%</b>。${passed ? '进入 10% 容差范围，现在发射验证动画。' : `超出 10%：${collisionHint(value, solution)}`}`;
  }
  if (passed) {
    const points = 12 * grade.ratio;
    const task = state.tasks.t4;
    task.done = true;
    task.prediction = value;
    task.score = Math.max(task.score, points);
    task.detail = `预测 ${value.toFixed(2)} rad/s，理论值 ${solution.omega.toFixed(2)} rad/s，误差 ${grade.error.toFixed(1)}%。得分 ${points.toFixed(1)} / 12。`;
    toast(`预测进入容差范围（${grade.error.toFixed(1)}%）`, 'ok');
    audio.success();
  } else {
    toast(`误差 ${grade.error.toFixed(1)}%，再检查一下公式`, 'warn');
    audio.error();
  }
  saveSoon();
  refreshAllTaskUI();
}

function scoreTask5() {
  const textarea = $('#t5-input');
  const text = textarea?.value.trim() || '';
  if (text.length < 20) {
    toast('请至少写 20 个字，AI 才能按量规评估', 'warn');
    return;
  }
  const result = evaluateText(text, 'task5');
  const task = state.tasks.t5;
  task.text = text;
  task.feedback = `AI 评分 <b>${result.score} / 100</b>。${result.feedback}`;
  const feedback = $('#t5-feedback');
  if (feedback) {
    feedback.hidden = false;
    feedback.className = `reflection-feedback ${result.score >= 60 ? 'is-ok' : 'is-warn'}`;
    feedback.innerHTML = task.feedback;
  }
  const points = 8 * (result.score / 100);
  if (result.score >= 60) {
    task.done = true;
    task.score = Math.max(task.score, points);
    toast(`AI 评分 ${result.score}，任务 5 完成`, 'ok');
    audio.success();
  } else {
    toast(`AI 评分 ${result.score}，补充：${result.missing[0] || '能量去向'}`, 'warn', 4200);
    audio.error();
  }
  saveSoon();
  refreshAllTaskUI();
}

function resetCollision() {
  collScene.reset();
  state.collision.fired = false;
  state.collision.lastResult = null;
  updateCollisionReadouts();
  setEnergyBars(null);
  const pill = $('#c-phase');
  if (pill) {
    pill.textContent = '待发射';
    pill.classList.remove('pill-amber');
  }
  const button = $('#btn-fire');
  if (button) button.disabled = false;
  saveSoon();
}

/* =========================================================
   测评
   ========================================================= */

function masteryAverage() {
  const values = Object.values(state.quiz.mastery);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0.5;
}

function renderMasteryStrip() {
  const container = $('#quiz-mastery');
  if (!container) return;
  container.replaceChildren();
  for (const key of CONCEPT_KEYS) {
    const value = state.quiz.mastery[key] ?? 0.5;
    const chip = document.createElement('span');
    chip.className = 'mastery-chip';
    chip.innerHTML = `<span>${CONCEPTS[key].short}</span><span class="mastery-meter"><i style="width:${Math.round(value * 100)}%"></i></span><b>${Math.round(value * 100)}%</b>`;
    container.appendChild(chip);
  }
}

function renderQuizState() {
  renderMasteryStrip();
  const intro = $('#quiz-intro');
  const active = $('#quiz-active');
  const done = $('#quiz-done');

  const hasActive = state.quiz.active && state.quiz.items.length > 0;
  if (intro) intro.hidden = hasActive || state.quiz.completed;
  if (active) active.hidden = !hasActive;
  if (done) done.hidden = hasActive || !state.quiz.completed;

  setText($('#quiz-best'), state.quiz.best == null ? '—' : `${state.quiz.best}`);
  setText($('#quiz-attempts'), state.quiz.attempts || 0);
  setText($('#quiz-mastery-avg'), `${Math.round(masteryAverage() * 100)}%`);

  if (hasActive) {
    if (state.quiz.index >= state.quiz.items.length) {
      finishQuiz();
      return;
    }
    renderQuizQuestion();
  } else if (state.quiz.completed) {
    renderQuizDone();
  }
}

function startQuiz() {
  state.quiz.active = true;
  state.quiz.completed = false;
  state.quiz.items = selectAdaptiveQuiz(state.quiz.mastery, 8);
  state.quiz.answers = [];
  state.quiz.index = 0;
  state.quiz.score = null;
  state.quiz.summary = null;
  quizLocked = false;
  pendingQuizResponse = null;
  saveSoon();
  renderQuizState();
  audio.click();
}

function renderQuizQuestion() {
  const item = state.quiz.items[state.quiz.index];
  if (!item) return;
  const index = state.quiz.index;
  const total = state.quiz.items.length;
  const answered = state.quiz.answers[index];

  setText($('#quiz-step'), `第 ${index + 1} 题 / ${total}`);
  const progress = $('#quiz-progress-bar');
  if (progress) progress.style.width = `${(index / total) * 100}%`;
  setText($('#quiz-concept'), item.concepts.map((key) => CONCEPTS[key]?.label || key).join(' · '));
  setText($('#quiz-stem'), item.stem);
  setText($('#quiz-correct'), state.quiz.answers.filter((a) => a?.correct).length);
  setText($('#quiz-unit'), item.unit || '');

  const optionsBox = $('#quiz-options');
  const numericBox = $('#quiz-numeric');
  optionsBox.replaceChildren();
  if (item.type === 'mcq') {
    if (numericBox) numericBox.hidden = true;
    item.options.forEach((option, optionIndex) => {
      const button = document.createElement('button');
      button.className = 'option';
      button.type = 'button';
      button.dataset.index = String(optionIndex);
      button.innerHTML = `<span class="option-letter">${String.fromCharCode(65 + optionIndex)}</span><span>${escapeHTML(option.text)}</span>`;
      button.addEventListener('click', () => selectOption(optionIndex));
      optionsBox.appendChild(button);
    });
  } else {
    if (numericBox) numericBox.hidden = false;
    const input = $('#quiz-number');
    if (input) {
      input.value = '';
      input.disabled = false;
    }
    const hint = document.createElement('p');
    hint.className = 'quiz-hint';
    hint.textContent = '输入数值即可，允许 3%–5% 的数值误差。';
    optionsBox.appendChild(hint);
  }

  const feedback = $('#quiz-feedback');
  if (feedback) {
    feedback.hidden = true;
    feedback.className = 'quiz-feedback';
    feedback.innerHTML = '';
  }
  const submit = $('#btn-quiz-submit');
  const next = $('#btn-quiz-next');
  if (submit) {
    submit.hidden = false;
    submit.disabled = false;
  }
  if (next) next.hidden = true;
  quizLocked = false;
  pendingQuizResponse = null;

  if (answered) {
    // 恢复未完成视图时直接展示上一题的判定
    showQuizFeedback(item, answered, { restore: true });
  }
}

function selectOption(index) {
  if (quizLocked) return;
  pendingQuizResponse = { option: index };
  $$('#quiz-options .option').forEach((button, buttonIndex) => {
    button.classList.toggle('is-selected', buttonIndex === index);
  });
  audio.click();
}

function submitQuizAnswer() {
  if (quizLocked) return;
  const item = state.quiz.items[state.quiz.index];
  if (!item) return;
  let response = pendingQuizResponse;
  if (item.type === 'numeric') {
    const value = Number($('#quiz-number')?.value);
    if (!Number.isFinite(value)) {
      toast('请输入一个数值', 'warn');
      return;
    }
    response = { value };
  }
  if (!response) {
    toast('先选择一个选项', 'warn');
    return;
  }
  quizLocked = true;
  const grade = gradeItem(item, response);
  const answer = { ...response, correct: grade.correct };
  state.quiz.answers[state.quiz.index] = answer;
  state.quiz.mastery = updateMastery(state.quiz.mastery, item.concepts, grade.correct, item.difficulty);
  saveSoon();
  showQuizFeedback(item, answer, { grade });
  setText($('#quiz-correct'), state.quiz.answers.filter((a) => a?.correct).length);
  const submit = $('#btn-quiz-submit');
  const next = $('#btn-quiz-next');
  if (submit) submit.hidden = true;
  if (next) {
    next.hidden = false;
    next.textContent = state.quiz.index + 1 >= state.quiz.items.length ? '查看结果' : '下一题';
  }
  if (grade.correct) audio.success();
  else audio.error();
  renderMasteryStrip();
}

function showQuizFeedback(item, answer, { grade, restore = false } = {}) {
  const feedback = $('#quiz-feedback');
  if (!feedback) return;
  const verdict = grade || gradeItem(item, answer);
  feedback.hidden = false;
  feedback.className = `quiz-feedback ${verdict.correct ? 'is-ok' : 'is-bad'}`;
  feedback.innerHTML = `<strong>${escapeHTML(verdict.headline)}</strong><p>${renderMarkdown(verdict.body)}</p>`;

  if (item.type === 'mcq') {
    $$('#quiz-options .option').forEach((button, index) => {
      button.disabled = true;
      button.classList.remove('is-selected');
      if (index === item.answerIndex) button.classList.add('is-correct');
      if (answer.option === index && !verdict.correct) button.classList.add('is-wrong');
    });
  } else {
    const input = $('#quiz-number');
    if (input) input.disabled = true;
  }

  const submit = $('#btn-quiz-submit');
  const next = $('#btn-quiz-next');
  if (restore) {
    if (submit) submit.hidden = true;
    if (next) {
      next.hidden = false;
      next.textContent = state.quiz.index + 1 >= state.quiz.items.length ? '查看结果' : '下一题';
    }
    quizLocked = true;
  }
}

function nextQuizQuestion() {
  if (state.quiz.index + 1 >= state.quiz.items.length) {
    finishQuiz();
    return;
  }
  state.quiz.index += 1;
  saveSoon();
  renderQuizQuestion();
}

function finishQuiz() {
  const summary = summarizeQuiz(state.quiz.items, state.quiz.answers);
  state.quiz.summary = summary;
  state.quiz.score = summary.score;
  state.quiz.best = Math.max(state.quiz.best ?? 0, summary.score);
  state.quiz.attempts = (state.quiz.attempts || 0) + 1;
  state.quiz.completed = true;
  state.quiz.active = false;
  state.quiz.history = [...(state.quiz.history || []), { score: summary.score, at: Date.now(), correct: summary.correctCount, total: summary.total }].slice(-10);
  saveSoon();
  renderQuizState();
  audio.success();
  const weak = summary.weak.map((key) => CONCEPTS[key]?.label || key);
  tutorSay(
    `测评完成：${summary.correctCount} / ${summary.total} 题正确，得分 ${summary.score}。${weak.length ? `AI 判断你的薄弱概念是：${weak.join('、')}。` : '各概念表现均衡。'} 完整拆解在学习报告页。`
  );
}

function renderQuizDone() {
  const summary = state.quiz.summary;
  if (!summary) return;
  setText($('#quiz-final-score'), summary.score);
  const ring = $('#quiz-score-ring');
  if (ring) ring.style.setProperty('--score', summary.score);
  const title = summary.score >= 80 ? '掌握扎实' : summary.score >= 60 ? '基础过关' : '需要再练';
  setText($('#quiz-done-title'), `${title} · ${summary.score} 分`);
  setText($('#quiz-done-sub'), `答对 ${summary.correctCount} / ${summary.total} 题。AI 已根据作答更新概念掌握度。`);

  const box = $('#quiz-summary');
  box.replaceChildren();
  for (const [key, stat] of Object.entries(summary.byConcept)) {
    const row = document.createElement('div');
    row.className = 'quiz-summary-row';
    const percent = Math.round((stat.right / Math.max(stat.total, 1)) * 100);
    row.innerHTML = `<span>${CONCEPTS[key]?.label || key}</span><b class="${percent >= 60 ? 'ok' : 'no'}">${stat.right} / ${stat.total} · ${percent}%</b>`;
    box.appendChild(row);
  }
  if (summary.weak.length) {
    const row = document.createElement('div');
    row.className = 'quiz-summary-row';
    row.innerHTML = `<span>建议复习</span><b class="no">${summary.weak.map((key) => CONCEPTS[key]?.label || key).join('、')}</b>`;
    box.appendChild(row);
  }
}

/* =========================================================
   学习报告
   ========================================================= */

function computeSummary() {
  const t1 = state.tasks.t1.score || 0;
  const t2 = state.tasks.t2.score || 0;
  const t3 = state.tasks.t3.score || 0;
  const t4 = state.tasks.t4.score || 0;
  const t5 = state.tasks.t5.score || 0;
  const operation = Math.min(30, t1 + t2 + t3);
  const collision = Math.min(20, t4 + t5);
  const quiz = state.quiz.completed || state.quiz.score != null ? (state.quiz.score || 0) * 0.3 : 0;
  const reflection = state.reflection.score != null ? (state.reflection.score / 100) * 20 : 0;
  const total = Math.round(Math.max(0, Math.min(100, operation + collision + quiz + reflection)));
  let level = '待提升';
  if (total >= 90) level = '优秀';
  else if (total >= 80) level = '良好';
  else if (total >= 70) level = '中等';
  else if (total >= 60) level = '及格';
  const doneCount = Object.values(state.tasks).filter((task) => task.done).length;
  return {
    total,
    level,
    parts: { operation: Math.round(operation), collision: Math.round(collision), quiz: Math.round(quiz), reflection: Math.round(reflection) },
    quizScore: state.quiz.score || 0,
    doneCount,
  };
}

function dataQuality() {
  if (state.data.length < 3) return 0.15 + (state.data.length / 3) * 0.25;
  const stats = summarize(state.data.map((item) => item.L));
  const maxDev = stats.mean > 0 ? Math.max(...state.data.map((item) => (Math.abs(item.L - stats.mean) / stats.mean) * 100), 0) : 0;
  const devScore = maxDev <= 1 ? 1 : maxDev <= 2 ? 0.9 : maxDev <= 5 ? 0.65 : 0.35;
  return devScore;
}

function radarValues() {
  const mastery = state.quiz.mastery;
  const quizEvidence = state.quiz.completed ? (state.quiz.score || 0) / 100 : 0.5;
  const concept = Math.min(1, ((mastery.definition + mastery.conservation) / 2) * 0.6 + quizEvidence * 0.4);
  const quantitative = Math.min(1, mastery.quantitative * 0.6 + quizEvidence * 0.4);
  const operation = (Math.min(1, state.tasks.t1.score / 12) + Math.min(1, state.tasks.t2.score / 10)) / 2;
  const data = dataQuality() * 0.7 + mastery.data * 0.3;
  const explanation =
    (Math.min(1, state.tasks.t3.score / 8) +
      Math.min(1, state.tasks.t5.score / 8) +
      (state.reflection.score != null ? state.reflection.score / 100 : 0) +
      mastery.energy) /
    4;
  return [concept, quantitative, operation, data, explanation].map((value) => Math.max(0, Math.min(1, value)));
}

function renderReport() {
  const summary = computeSummary();
  setText($('#rep-total'), summary.total);
  const ring = $('#rep-ring');
  if (ring) ring.style.setProperty('--score', summary.total);
  const levelBadge = $('#rep-level');
  if (levelBadge) {
    levelBadge.textContent = summary.level;
    levelBadge.classList.toggle('is-good', summary.total >= 80);
    levelBadge.classList.toggle('is-warn', summary.total > 0 && summary.total < 60);
  }

  const verdicts = {
    优秀: '能稳定地用角动量守恒解释现象，并用数据支撑结论。',
    良好: '核心概念清楚，个别环节还可以更严谨。',
    中等: '已经抓住守恒的主线，建议补强能量与碰撞。',
    及格: '理解了基本现象，下一步要能独立完成定量推理。',
    待提升: '先完成实验与测评，AI 会定位你的起点并给出路径。',
  };
  setText($('#rep-verdict'), verdicts[summary.level]);

  const breakdown = $('#rep-breakdown');
  breakdown.replaceChildren();
  const parts = [
    ['实验操作', summary.parts.operation, 30],
    ['碰撞实验', summary.parts.collision, 20],
    ['智能测评', summary.parts.quiz, 30],
    ['学习反思', summary.parts.reflection, 20],
  ];
  for (const [label, value, max] of parts) {
    const row = document.createElement('div');
    row.className = 'breakdown-row';
    row.innerHTML = `<span>${label}</span><span class="breakdown-track"><i style="width:${(value / max) * 100}%"></i></span><b>${Math.round(value)}/${max}</b>`;
    breakdown.appendChild(row);
  }

  const ctx = buildContext();
  const narrative = tutor.generateReportNarrative(ctx, summary);
  const aiBox = $('#rep-ai');
  aiBox.innerHTML = narrative.paragraphs
    .map((paragraph) => `<p>${inlineMarkdown(escapeHTML(paragraph))}</p>`)
    .join('');
  const nextBox = $('#rep-next');
  nextBox.replaceChildren();
  for (const step of narrative.steps) {
    const button = document.createElement('button');
    button.className = 'next-step';
    button.textContent = step.label;
    if (step.view) button.dataset.view = step.view;
    if (step.action) button.dataset.action = step.action;
    nextBox.appendChild(button);
  }

  const values = radarValues();
  radar.setValues(values);
  if (radar.w < 10) radar.measure();
  radar.draw();
  const legend = $('#radar-legend');
  legend.replaceChildren();
  radar.labels.forEach((label, index) => {
    const span = document.createElement('span');
    span.innerHTML = `${label} <b>${Math.round(values[index] * 100)}%</b>`;
    legend.appendChild(span);
  });

  renderReportData();
  renderReportQuiz();
  renderReportTasks(summary);

  const nameInput = $('#report-name');
  if (nameInput && document.activeElement !== nameInput) nameInput.value = state.profile.name || '';
  const reflectionInput = $('#reflection-input');
  if (reflectionInput && document.activeElement !== reflectionInput) reflectionInput.value = state.reflection.text || '';
  setText($('#reflection-count'), `${(state.reflection.text || '').length} / 600`);
  const reflectionFeedback = $('#reflection-feedback');
  if (reflectionFeedback && state.reflection.feedback) {
    reflectionFeedback.hidden = false;
    reflectionFeedback.className = `reflection-feedback ${state.reflection.score >= 60 ? 'is-ok' : 'is-warn'}`;
    reflectionFeedback.innerHTML = `<b>AI 评分 ${state.reflection.score} / 100</b>。${state.reflection.feedback}`;
  }
  setText($('#rep-timestamp'), `生成于 ${formatDate()}`);
}

function renderReportData() {
  const box = $('#rep-data');
  const tag = $('#rep-data-tag');
  if (!state.data.length) {
    tag.textContent = '0 组';
    box.textContent = '尚未记录实验数据。前往实验台完成任务 1，数据会自动汇总到这里。';
    return;
  }
  tag.textContent = `${state.data.length} 组`;
  const stats = summarize(state.data.map((item) => item.L));
  const maxDev = stats.mean > 0 ? Math.max(...state.data.map((item) => (Math.abs(item.L - stats.mean) / stats.mean) * 100), 0) : 0;
  const radii = state.data.map((item) => item.radius);
  const rMin = Math.min(...radii);
  const rMax = Math.max(...radii);
  const devClass = maxDev <= 2 ? 'ok' : maxDev <= 5 ? 'warn' : 'bad';
  box.innerHTML = `
    <div class="summary-stat"><span>数据组数</span><b>${state.data.length}</b></div>
    <div class="summary-stat"><span>L 平均值</span><b>${stats.mean.toFixed(3)} kg·m²/s</b></div>
    <div class="summary-stat"><span>L 最大相对偏差</span><b class="${devClass}">${maxDev.toFixed(2)}%</b></div>
    <div class="summary-stat"><span>半径范围</span><b>${rMin.toFixed(2)} – ${rMax.toFixed(2)} m</b></div>
    <div class="summary-stat"><span>摩擦状态</span><b>${state.data.some((item) => item.friction) ? '部分数据开启摩擦' : '全程关闭'}</b></div>
  `;
}

function renderReportQuiz() {
  const box = $('#rep-quiz');
  const tag = $('#rep-quiz-tag');
  if (!state.quiz.completed || !state.quiz.summary) {
    tag.textContent = '未测评';
    box.textContent = '还没有完成智能测评。完成 8 道自适应题后，这里会显示正确率与薄弱概念。';
    return;
  }
  const summary = state.quiz.summary;
  tag.textContent = `${summary.score} 分`;
  const weak = summary.weak.map((key) => CONCEPTS[key]?.label || key);
  box.innerHTML = `
    <div class="recap-line"><span>最近得分</span><b>${summary.score} / 100</b></div>
    <div class="recap-line"><span>正确题数</span><b>${summary.correctCount} / ${summary.total}</b></div>
    <div class="recap-line"><span>测评次数</span><b>${state.quiz.attempts || 0}</b></div>
    <div class="recap-line"><span>历史最佳</span><b>${state.quiz.best ?? '—'} 分</b></div>
    <div class="recap-line"><span>薄弱概念</span><b>${weak.length ? weak.join('、') : '暂无'}</b></div>
  `;
}

function renderReportTasks(summary) {
  setText($('#rep-task-tag'), `${summary.doneCount} / 5`);
  const container = $('#rep-tasks');
  container.replaceChildren();
  const labels = {
    t1: '观察守恒',
    t2: '定量预测',
    t3: '能量解释',
    t4: '碰撞预测',
    t5: '碰撞解释',
  };
  for (const key of ['t1', 't2', 't3', 't4', 't5']) {
    const task = state.tasks[key];
    const node = document.createElement('div');
    node.className = `report-task${task.done ? ' is-done' : ''}`;
    node.innerHTML = `<strong><span class="dot"></span>${labels[key]}</strong><span>${task.done ? `${Math.round(task.score)} / ${TASK_META[key].max} 分` : '未完成'}</span>`;
    container.appendChild(node);
  }
}

function scoreReflection() {
  const input = $('#reflection-input');
  const text = input?.value.trim() || '';
  if (text.length < 30) {
    toast('至少写 30 个字，AI 才能评估概念覆盖度', 'warn');
    return;
  }
  const result = evaluateText(text, 'reflection');
  state.reflection.text = text;
  state.reflection.score = result.score;
  state.reflection.feedback = result.feedback;
  const feedback = $('#reflection-feedback');
  if (feedback) {
    feedback.hidden = false;
    feedback.className = `reflection-feedback ${result.score >= 60 ? 'is-ok' : 'is-warn'}`;
    feedback.innerHTML = `<b>AI 评分 ${result.score} / 100</b>。${result.feedback}`;
  }
  if (result.score >= 60) {
    toast(`反思评分 ${result.score}，已计入报告`, 'ok');
    audio.success();
    tutorSay(`学习反思评分 ${result.score} / 100。${result.feedback}`);
  } else {
    toast(`反思评分 ${result.score}，补充：${result.missing[0] || '因果链'}`, 'warn', 4500);
    audio.error();
  }
  saveSoon();
  renderReport();
}

function exportReportJSON() {
  const summary = computeSummary();
  const ctx = buildContext();
  const payload = {
    app: '角动量守恒 · 虚拟仿真实验室',
    exportedAt: new Date().toISOString(),
    student: state.profile.name || '匿名',
    summary,
    tasks: state.tasks,
    labData: state.data,
    collision: state.collision,
    quiz: {
      score: state.quiz.score,
      best: state.quiz.best,
      attempts: state.quiz.attempts,
      mastery: state.quiz.mastery,
      summary: state.quiz.summary,
    },
    reflection: state.reflection,
    aiNarrative: tutor.generateReportNarrative(ctx, summary),
  };
  download(`角动量守恒-学习档案-${Date.now()}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  toast('学习档案已导出', 'ok');
}

/* =========================================================
   AI 助教
   ========================================================= */

function buildContext() {
  return {
    view: activeView,
    lab: {
      ...model.snapshot(),
      I0: LAB_LIMITS.I0,
      mass: LAB_LIMITS.MASS,
    },
    data: state.data,
    tasks: state.tasks,
    collision: {
      mass: state.collision.massG / 1000,
      speed: state.collision.speed,
      offset: state.collision.offset,
      solution: state.collision.lastResult,
      predicted: state.collision.prediction,
    },
    quiz: {
      completed: state.quiz.completed,
      score: state.quiz.score,
      weak: state.quiz.summary?.weak || [],
      mastery: state.quiz.mastery,
    },
    reflection: state.reflection,
    name: state.profile.name,
  };
}

function updateTutorEngineLabel() {
  const label = $('#tutor-engine-label');
  if (!label) return;
  if (tutor.usingCloud) {
    label.textContent = `云端 ${state.settings.llm.model || 'LLM'} · 已配置`;
  } else if (state.settings.llm.enabled) {
    label.textContent = '本地引擎 · 云端未配置 Key';
  } else {
    label.textContent = '本地引擎 · 上下文感知';
  }
}

function messageMeta(message) {
  if (message.role === 'user') return nowClock();
  const prefix = message.proactive ? '主动提示' : message.source === 'cloud' ? '云端模型' : '本地引擎';
  return `${prefix} · ${nowClock()}`;
}

function createMessageNode(message) {
  const wrapper = document.createElement('div');
  wrapper.className = `msg ${message.role}`;
  const avatar = document.createElement('span');
  avatar.className = 'msg-avatar';
  avatar.textContent = message.role === 'user' ? '你' : 'AI';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = renderMarkdown(message.text);
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = messageMeta(message);
  bubble.appendChild(meta);
  wrapper.append(avatar, bubble);
  return wrapper;
}

function appendChat(message, { persist = true } = {}) {
  state.chat.push({ ...message, at: Date.now() });
  state.chat = state.chat.slice(-40);
  const log = $('#chat-log');
  if (log) {
    log.appendChild(createMessageNode(message));
    log.scrollTop = log.scrollHeight;
  }
  if (persist) saveSoon();
}

function ensureWelcomeMessage() {
  if (state.chat.length) return;
  state.chat.push({
    role: 'assistant',
    text:
      '你好，我是 AI 物理助教。我已经同步了你的实验状态，可以：\n' +
      '- 用你记录的数据解释 L = Iω；\n' +
      '- 指出“角速度守恒”“能量也守恒”这类常见误区；\n' +
      '- 根据任务进度告诉你下一步；\n' +
      '- 随机出题并按概念量规评分。\n\n' +
      '试试点下面的快捷问题，或直接问我。',
    source: 'local',
    at: Date.now(),
  });
}

function renderChat() {
  const log = $('#chat-log');
  if (!log) return;
  log.replaceChildren();
  ensureWelcomeMessage();
  for (const message of state.chat) {
    log.appendChild(createMessageNode(message));
  }
  log.scrollTop = log.scrollHeight;
}

function openTutor(prompt) {
  const drawer = $('#tutor-drawer');
  const scrim = $('#drawer-scrim');
  if (!drawer) return;
  ensureWelcomeMessage();
  renderChat();
  updateTutorEngineLabel();
  drawer.classList.add('is-open');
  drawer.setAttribute('aria-hidden', 'false');
  if (scrim) scrim.hidden = false;
  document.body.style.overflow = 'hidden';
  unread = 0;
  updateTutorBadge();
  if (prompt) {
    window.setTimeout(() => sendChatMessage(prompt), 120);
  } else {
    window.setTimeout(() => $('#chat-input')?.focus(), 250);
  }
}

function closeTutor() {
  const drawer = $('#tutor-drawer');
  const scrim = $('#drawer-scrim');
  drawer?.classList.remove('is-open');
  drawer?.setAttribute('aria-hidden', 'true');
  if (scrim) scrim.hidden = true;
  document.body.style.overflow = '';
  stopListening();
}

function updateTutorBadge() {
  const badge = $('#tutor-badge');
  if (!badge) return;
  if (unread > 0) {
    badge.hidden = false;
    badge.textContent = unread > 9 ? '9+' : String(unread);
  } else {
    badge.hidden = true;
  }
}

function tutorSay(text, { toastMessage = false } = {}) {
  appendChat({ role: 'assistant', text, source: 'local', proactive: true });
  const drawerOpen = $('#tutor-drawer')?.classList.contains('is-open');
  if (!drawerOpen) {
    unread += 1;
    updateTutorBadge();
    if (toastMessage) toast(text.replace(/\*\*/g, '').slice(0, 90), 'info', 4200);
  }
}

async function sendChatMessage(raw) {
  const input = $('#chat-input');
  const text = (raw ?? input?.value ?? '').trim();
  if (!text) return;
  if (input && !raw) {
    input.value = '';
    input.style.height = 'auto';
  }
  appendChat({ role: 'user', text, source: 'user' });
  const log = $('#chat-log');
  const typing = document.createElement('div');
  typing.className = 'msg assistant';
  typing.innerHTML = '<span class="msg-avatar">AI</span><div class="msg-bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
  log?.appendChild(typing);
  if (log) log.scrollTop = log.scrollHeight;

  const sendButton = $('#btn-send');
  if (sendButton) sendButton.disabled = true;
  try {
    const reply = await tutor.ask(text, buildContext());
    typing.remove();
    appendChat({ role: 'assistant', text: reply.text, source: reply.source });
    updateTutorEngineLabel();
    if (state.settings.voice) speakText(reply.text);
  } catch (error) {
    typing.remove();
    const fallback = '我这次没有连接成功。你可以先用本地实验台验证：改变半径，观察 HUD 中 L 是否保持不变。';
    appendChat({ role: 'assistant', text: fallback, source: 'local' });
  } finally {
    if (sendButton) sendButton.disabled = false;
    if (log) log.scrollTop = log.scrollHeight;
  }
}

function speakText(text) {
  if (!('speechSynthesis' in window)) return;
  const clean = text
    .replace(/\*\*|`|#|>/g, '')
    .replace(/[-*]\s+/g, '')
    .replace(/\n+/g, '。')
    .slice(0, 420);
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = 'zh-CN';
  utterance.rate = 1.03;
  utterance.pitch = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

let recognition = null;
let listening = false;

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $('#btn-mic');
  if (!SpeechRecognition || !mic) {
    mic?.classList.add('hidden');
    return;
  }
  recognition = new SpeechRecognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    listening = true;
    mic.classList.add('is-live');
    toast('正在听…请说出你的问题', 'info', 1800);
  };
  recognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript?.trim();
    if (transcript) {
      const input = $('#chat-input');
      if (input) input.value = transcript;
      sendChatMessage(transcript);
    }
  };
  recognition.onerror = (event) => {
    if (event.error !== 'aborted' && event.error !== 'no-speech') {
      toast('语音识别不可用，请使用键盘输入', 'warn');
    }
  };
  recognition.onend = () => {
    listening = false;
    mic.classList.remove('is-live');
  };
}

function stopListening() {
  if (recognition && listening) {
    try {
      recognition.stop();
    } catch {
      /* noop */
    }
  }
}

function toggleMic() {
  if (!recognition) {
    toast('当前浏览器不支持语音识别，请使用键盘输入', 'warn');
    return;
  }
  if (listening) {
    stopListening();
    return;
  }
  try {
    recognition.start();
  } catch {
    toast('语音识别启动失败，请稍后再试', 'warn');
  }
}

/* =========================================================
   设置 / 关于 / 帮助
   ========================================================= */

function setSwitch(el, on) {
  el?.setAttribute('aria-checked', String(Boolean(on)));
}

function syncSettingsUI() {
  setSwitch($('#voice-toggle'), state.settings.voice);
  setSwitch($('#sound-toggle'), state.settings.sound);
  setSwitch($('#llm-toggle'), state.settings.llm.enabled);
  $('#btn-speak')?.setAttribute('aria-pressed', String(state.settings.voice));
  const fields = $('#llm-fields');
  if (fields) fields.hidden = !state.settings.llm.enabled;
  const endpoint = $('#llm-endpoint');
  const modelInput = $('#llm-model');
  const keyInput = $('#llm-key');
  if (endpoint) endpoint.value = state.settings.llm.endpoint || '';
  if (modelInput) modelInput.value = state.settings.llm.model || '';
  if (keyInput) keyInput.value = sessionStorage.getItem(KEY_STORAGE) || '';
  updateTutorEngineLabel();
  audio.setEnabled(state.settings.sound);
}

function saveSettings() {
  state.settings.voice = $('#voice-toggle')?.getAttribute('aria-checked') === 'true';
  state.settings.sound = $('#sound-toggle')?.getAttribute('aria-checked') === 'true';
  state.settings.llm.enabled = $('#llm-toggle')?.getAttribute('aria-checked') === 'true';
  state.settings.llm.endpoint = $('#llm-endpoint')?.value.trim() || state.settings.llm.endpoint;
  state.settings.llm.model = $('#llm-model')?.value.trim() || state.settings.llm.model;
  const key = $('#llm-key')?.value.trim() || '';
  if (key) sessionStorage.setItem(KEY_STORAGE, key);
  else sessionStorage.removeItem(KEY_STORAGE);
  tutor.configureLLM({ ...state.settings.llm, key });
  audio.setEnabled(state.settings.sound);
  setSwitch($('#voice-toggle'), state.settings.voice);
  setSwitch($('#sound-toggle'), state.settings.sound);
  setSwitch($('#llm-toggle'), state.settings.llm.enabled);
  $('#btn-speak')?.setAttribute('aria-pressed', String(state.settings.voice));
  updateTutorEngineLabel();
  saveSoon();
  toast(
    tutor.usingCloud ? '已启用云端模型；若接口跨域受限会自动回退本地引擎' : '设置已保存，当前使用本地 AI 引擎',
    'ok',
    4200
  );
}

function openAbout() {
  const modal = $('#modal-about');
  if (!modal) return;
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  renderQR();
}

function closeAbout() {
  const modal = $('#modal-about');
  modal?.classList.remove('is-open');
  modal?.setAttribute('aria-hidden', 'true');
}

function renderQR() {
  const box = $('#about-qr');
  if (!box) return;
  const url = 'https://J66k6.github.io/wulizuoye/';
  if (typeof window.qrcode === 'function') {
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
      return;
    } catch {
      /* fall through */
    }
  }
  box.replaceChildren();
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;padding:4px';
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = '在手机上打开';
  link.style.cssText = 'color:#0b5c8a;font-size:11px;font-weight:600';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = '复制链接';
  copy.style.cssText = 'padding:6px 10px;border-radius:8px;background:#0b5c8a;color:#fff;font-size:11px;border:0;cursor:pointer';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('链接已复制，可在手机浏览器打开', 'ok');
    } catch {
      window.prompt('复制下面的链接', url);
    }
  });
  wrap.append(link, copy);
  box.appendChild(wrap);
}

function resetAllData() {
  const button = $('#btn-reset-all');
  if (!resetArmed) {
    resetArmed = true;
    if (button) button.textContent = '再点一次确认清除';
    window.setTimeout(() => {
      resetArmed = false;
      if (button) button.textContent = '清除本机学习数据';
    }, 3200);
    return;
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    /* noop */
  }
  location.hash = '#lab';
  location.reload();
}

/* =========================================================
   任务 UI 刷新
   ========================================================= */

function refreshAllTaskUI() {
  renderTasks();
  updateTaskProgress();
  if (activeView === 'report') renderReport();
}

/* =========================================================
   主循环与初始化
   ========================================================= */

let lastFrame = performance.now();
let hudClock = 0;
let chartClock = 0;

function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;

  if (!document.hidden) {
    if (activeView === 'lab') {
      if (armAnimation) {
        armAnimation.elapsed += dt;
        const progress = Math.min(1, armAnimation.elapsed / armAnimation.duration);
        const eased = 1 - (1 - progress) ** 3;
        const radius = armAnimation.from + (armAnimation.to - armAnimation.from) * eased;
        applyRadius(radius, { silent: true });
        if (progress >= 1) {
          const finalOmega = model.omega;
          const before = armAnimation.startOmega;
          const fromRadius = armAnimation.startRadius;
          armAnimation = null;
          chart.draw();
          saveSoon();
          audio.success();
          toast(
            `收臂完成：r ${fromRadius.toFixed(2)} → 0.25 m，ω ${before.toFixed(2)} → ${finalOmega.toFixed(2)} rad/s`,
            'ok',
            4200
          );
          tutorSay(
            `收臂演示：半径从 ${fromRadius.toFixed(2)} m 收到 0.25 m，角速度从 ${before.toFixed(2)} 增到 ${finalOmega.toFixed(2)} rad/s，而 L 保持在 ${model.L.toFixed(3)} kg·m²/s。`
          );
        }
      }
      if (running && !model.stopped) {
        model.step(dt);
        if (model.stopped) {
          running = false;
          syncSpinButton();
          toast('摩擦使平台停止转动', 'warn', 3200);
        }
      }
      labScene.update(dt);
      labScene.draw();
      hudClock += dt;
      if (hudClock > 0.08) {
        updateHUD();
        hudClock = 0;
      }
      chartClock += dt;
      if (chartClock > 0.16) {
        chart.draw();
        chartClock = 0;
      }
    } else if (activeView === 'collision') {
      collScene.update(dt);
      collScene.draw();
    }
  }
  requestAnimationFrame(frame);
}

function syncSliders() {
  const range = $('#r-range');
  if (range) range.value = String(model.radius.toFixed(2));
  const omegaRange = $('#w-range');
  if (omegaRange) omegaRange.value = String(state.lab.omega0);
  setText($('#r-value'), `${model.radius.toFixed(2)} m`);
  setText($('#w-value'), `${state.lab.omega0.toFixed(2)} rad/s`);
}

function initEvents() {
  // 视图切换
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });
  $$('[data-view-link]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      switchView(link.dataset.viewLink);
    });
  });
  window.addEventListener('hashchange', () => {
    const name = location.hash.replace('#', '');
    if (['lab', 'collision', 'quiz', 'report'].includes(name) && name !== activeView) switchView(name, { updateHash: false });
  });

  // 实验台
  $('#r-range')?.addEventListener('input', (event) => applyRadius(Number(event.target.value)));
  $('#w-range')?.addEventListener('input', (event) => setInitialOmega(Number(event.target.value)));
  $('#btn-spin')?.addEventListener('click', toggleSpin);
  $('#btn-reset')?.addEventListener('click', resetLab);
  $('#btn-arm')?.addEventListener('click', startArmDemo);
  $('#btn-record')?.addEventListener('click', recordData);
  $('#btn-quick-record')?.addEventListener('click', recordData);
  $('#btn-fullscreen')?.addEventListener('click', toggleFullscreen);
  $('#friction-toggle')?.addEventListener('click', () => setFriction(!model.friction));
  $('#btn-export-csv')?.addEventListener('click', exportCSV);
  $('#btn-clear-data')?.addEventListener('click', clearData);

  // 任务列表
  $$('.task').forEach((button) => {
    button.addEventListener('click', () => {
      activeTask = button.dataset.task;
      renderTasks();
      audio.click();
    });
  });
  $('#task-panel')?.addEventListener('click', (event) => {
    if (event.target.closest('#btn-t1-record')) recordData();
  });

  // 碰撞实验
  $('#c-mass')?.addEventListener('input', (event) => setCollisionParam('massG', Number(event.target.value)));
  $('#c-speed')?.addEventListener('input', (event) => setCollisionParam('speed', Number(event.target.value)));
  $('#c-offset')?.addEventListener('input', (event) => setCollisionParam('offset', Number(event.target.value)));
  $('#btn-fire')?.addEventListener('click', fireCollision);
  $('#btn-c-reset')?.addEventListener('click', resetCollision);
  $('#btn-predict')?.addEventListener('click', submitCollisionPrediction);
  $('#predict-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitCollisionPrediction();
  });
  $('#btn-collision-ai')?.addEventListener('click', () => {
    openTutor('用我的碰撞参数解释：为什么角动量守恒，而线动量和机械能都不守恒？');
  });
  $('#t5-input')?.addEventListener('input', (event) => {
    state.tasks.t5.text = event.target.value;
    setText($('#t5-count'), `${event.target.value.length} / 500`);
    saveSoon();
  });
  $('#btn-t5')?.addEventListener('click', scoreTask5);

  // 测评
  $('#btn-quiz-start')?.addEventListener('click', startQuiz);
  $('#btn-quiz-submit')?.addEventListener('click', submitQuizAnswer);
  $('#btn-quiz-next')?.addEventListener('click', nextQuizQuestion);
  $('#btn-quiz-retry')?.addEventListener('click', startQuiz);
  $('#btn-quiz-report')?.addEventListener('click', () => switchView('report'));
  $('#quiz-number')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitQuizAnswer();
  });

  // 报告
  $('#report-name')?.addEventListener('input', (event) => {
    state.profile.name = event.target.value;
    saveSoon();
  });
  $('#reflection-input')?.addEventListener('input', (event) => {
    state.reflection.text = event.target.value;
    setText($('#reflection-count'), `${event.target.value.length} / 600`);
    saveSoon();
  });
  $('#btn-reflection-score')?.addEventListener('click', scoreReflection);
  $('#btn-print')?.addEventListener('click', () => {
    if (!state.quiz.completed && !state.data.length) toast('报告还比较空，完成实验后打印效果更好', 'info');
    window.print();
  });
  $('#btn-export-json')?.addEventListener('click', exportReportJSON);
  $('#rep-next')?.addEventListener('click', (event) => {
    const button = event.target.closest('.next-step');
    if (!button) return;
    if (button.dataset.view) {
      switchView(button.dataset.view);
    } else if (button.dataset.action === 'tutor-weak') {
      openTutor('请针对我测评中的薄弱概念，用一个实验现象讲清楚，并出一道变式题。');
    }
  });

  // AI 助教
  $('#btn-tutor')?.addEventListener('click', () => openTutor());
  $('#tutor-close')?.addEventListener('click', closeTutor);
  $('#drawer-scrim')?.addEventListener('click', closeTutor);
  $('#btn-send')?.addEventListener('click', () => sendChatMessage());
  $('#chat-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage();
    }
  });
  $('#chat-input')?.addEventListener('input', (event) => {
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(110, event.target.scrollHeight)}px`;
  });
  $('#chat-chips')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-prompt]');
    if (button) sendChatMessage(button.dataset.prompt);
  });
  $('#btn-mic')?.addEventListener('click', toggleMic);
  $('#btn-speak')?.addEventListener('click', () => {
    state.settings.voice = !state.settings.voice;
    setSwitch($('#voice-toggle'), state.settings.voice);
    $('#btn-speak')?.setAttribute('aria-pressed', String(state.settings.voice));
    if (state.settings.voice) speakText('语音朗读已开启。');
    else window.speechSynthesis?.cancel();
    saveSoon();
  });

  // 设置
  $('#btn-tutor-settings')?.addEventListener('click', () => {
    const panel = $('#tutor-settings');
    if (panel) panel.hidden = !panel.hidden;
    syncSettingsUI();
  });
  $('#voice-toggle')?.addEventListener('click', () => {
    const on = $('#voice-toggle').getAttribute('aria-checked') !== 'true';
    setSwitch($('#voice-toggle'), on);
    if (on) speakText('语音朗读已开启。');
  });
  $('#sound-toggle')?.addEventListener('click', () => {
    const on = $('#sound-toggle').getAttribute('aria-checked') !== 'true';
    setSwitch($('#sound-toggle'), on);
    if (on) {
      audio.setEnabled(true);
      audio.click();
    } else {
      audio.setEnabled(false);
    }
  });
  $('#llm-toggle')?.addEventListener('click', () => {
    const on = $('#llm-toggle').getAttribute('aria-checked') !== 'true';
    setSwitch($('#llm-toggle'), on);
    const fields = $('#llm-fields');
    if (fields) fields.hidden = !on;
  });
  $('#btn-save-settings')?.addEventListener('click', saveSettings);

  // 关于
  $('#btn-help')?.addEventListener('click', openAbout);
  $('#btn-footer-about')?.addEventListener('click', openAbout);
  $('#about-close')?.addEventListener('click', closeAbout);
  $('#modal-about')?.addEventListener('click', (event) => {
    if (event.target.id === 'modal-about') closeAbout();
  });
  $('#btn-reset-all')?.addEventListener('click', resetAllData);

  // 欢迎
  $('#welcome-banner')?.classList.toggle('is-hidden', Boolean(state.flags.welcomeDismissed));
  $('#btn-welcome-close')?.addEventListener('click', () => {
    state.flags.welcomeDismissed = true;
    $('#welcome-banner')?.classList.add('is-hidden');
    saveSoon();
  });
  $('#btn-welcome-ai')?.addEventListener('click', () => {
    state.flags.welcomeDismissed = true;
    $('#welcome-banner')?.classList.add('is-hidden');
    saveSoon();
    openTutor('这个实验怎么玩？请用三步带我入门。');
  });

  // 全屏
  document.addEventListener('fullscreenchange', () => {
    const stage = $('#lab-stage');
    stage?.classList.toggle('is-fullscreen', Boolean(document.fullscreenElement));
    labScene.measure();
  });

  // 快捷键
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if ($('#modal-about')?.classList.contains('is-open')) closeAbout();
      else if ($('#tutor-drawer')?.classList.contains('is-open')) closeTutor();
      else if ($('#lab-stage')?.classList.contains('is-fullscreen')) {
        $('#lab-stage')?.classList.remove('is-fullscreen');
        labScene.measure();
      }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) persistNow();
  });
  window.addEventListener('beforeunload', persistNow);
}

function toggleFullscreen() {
  const stage = $('#lab-stage');
  if (!stage) return;
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
    return;
  }
  if (stage.requestFullscreen) {
    stage.requestFullscreen().catch(() => {
      stage.classList.add('is-fullscreen');
      labScene.measure();
    });
  } else {
    stage.classList.add('is-fullscreen');
    labScene.measure();
  }
}

function restoreUI() {
  syncSliders();
  setSwitch($('#friction-toggle'), model.friction);
  syncSpinButton();
  syncCollisionLabels();
  collScene.setParams(collisionParams());
  resetCollision();
  setText($('#t5-count'), `${(state.tasks.t5.text || '').length} / 500`);
  const t5 = $('#t5-input');
  if (t5) t5.value = state.tasks.t5.text || '';
  if (state.tasks.t5.feedback) {
    const feedback = $('#t5-feedback');
    if (feedback) {
      feedback.hidden = false;
      feedback.className = `reflection-feedback ${state.tasks.t5.done ? 'is-ok' : 'is-warn'}`;
      feedback.innerHTML = state.tasks.t5.feedback;
    }
  }
  if (state.tasks.t4.prediction) {
    const input = $('#predict-input');
    if (input) input.value = String(state.tasks.t4.prediction);
    state.collision.prediction = state.tasks.t4.prediction;
  }
  if (state.collision.prediction) {
    const input = $('#predict-input');
    if (input) input.value = String(state.collision.prediction);
  }
  updateHUD(true);
  renderData();
  renderTasks();
  renderMasteryStrip();
  updateTutorEngineLabel();
  syncSettingsUI();
  initSpeechRecognition();
  renderChat();
}

function init() {
  initEvents();
  restoreUI();
  if (state.quiz.active && state.quiz.items.length) {
    // 恢复中断的测评
    renderQuizState();
  }
  const hashView = location.hash.replace('#', '');
  switchView(['lab', 'collision', 'quiz', 'report'].includes(hashView) ? hashView : 'lab', { updateHash: false });
  updateTutorEngineLabel();
  requestAnimationFrame(frame);
  window.setTimeout(() => {
    $('#boot')?.classList.add('is-done');
    document.body.classList.add('is-ready');
    window.setTimeout(() => $('#boot')?.remove(), 800);
  }, 480);
}

init();

/* 页面隐藏时暂停动画节流 */
document.addEventListener('visibilitychange', () => {
  lastFrame = performance.now();
});
