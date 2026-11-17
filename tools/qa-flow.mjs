/**
 * tools/qa-flow.mjs — 端到端功能验收
 *
 * 自动完成：记录数据 → 任务 1/2/3 → 碰撞预测 → 任务 4/5 →
 * 8 题测评 → 学习反思 → 报告 → AI 对话 → 刷新持久化。
 */

import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const URL = process.env.QA_URL || 'http://127.0.0.1:8080/';
const OUT = process.env.QA_OUT || path.resolve('qa');
fs.mkdirSync(OUT, { recursive: true });

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) throw new Error('没有找到可调试的页面');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
const exceptions = [];
const consoleErrors = [];

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
  }
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description || 'evaluate failed');
  }
  return response.result?.result?.value;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shot(name) {
  const response = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(response.result.data, 'base64'));
  console.log('SHOT', name);
}

async function click(selector) {
  const ok = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
  if (!ok) throw new Error(`找不到元素: ${selector}`);
  await wait(120);
}

async function setRange(selector, value) {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.value = ${JSON.stringify(String(value))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);
  await wait(80);
}

async function setValue(selector, value) {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function state() {
  await wait(550);
  const raw = await evaluate(`localStorage.getItem('amlab.state.v2')`);
  return raw ? JSON.parse(raw) : null;
}

async function text(selector) {
  return evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() || ''`);
}

async function load() {
  await send('Page.navigate', { url: URL });
  await wait(2600);
}

// 浏览器准备
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
await load();
await send('Page.navigate', { url: 'about:blank' });
await wait(300);
await send('Storage.clearDataForOrigin', {
  origin: 'http://127.0.0.1:8080',
  storageTypes: 'local_storage,session_storage',
});
await load();

// 1. 记录 3 组数据
await setRange('#r-range', 0.6);
await click('#btn-record');
await setRange('#r-range', 0.45);
await click('#btn-record');
await setRange('#r-range', 0.3);
await click('#btn-record');
let s = await state();
console.log('DATA', s.data.length, s.data.map((d) => `${d.radius}:${d.L.toFixed(3)}`).join(' '));

// 2. 任务 1
await click('.task[data-task="t1"]');
await click('#btn-check-t1');
s = await state();
console.log('T1', s.tasks.t1.done, Math.round(s.tasks.t1.score), s.tasks.t1.detail);

// 3. 任务 2：按 HUD 的 L 计算并预测
const prediction = await evaluate(`(() => {
  const L = Number(document.querySelector('#hud-L').textContent);
  return L / (0.6 + 2 * 2 * 0.3 * 0.3) * 0.985;
})()`);
await click('.task[data-task="t2"]');
await setValue('#t2-input', String(prediction));
await click('#btn-t2');
s = await state();
console.log('T2', s.tasks.t2.done, Math.round(s.tasks.t2.score), s.tasks.t2.detail);

// 4. 任务 3
await click('.task[data-task="t3"]');
await setValue(
  '#t3-input',
  '收臂时转轴方向合外力矩为零，所以角动量守恒。半径减小使转动惯量减小，由ω=L/I可知角速度增大。动能的增加来自人体拉配重向内做的功，不是无中生有。'
);
await click('#btn-t3');
s = await state();
console.log('T3', s.tasks.t3.done, Math.round(s.tasks.t3.score), s.tasks.t3.feedback);

// 5. 碰撞预测
await click('.tab[data-view="collision"]');
await wait(300);
const collision = await evaluate(`(() => {
  const m = Number(document.querySelector('#c-mass').value) / 1000;
  const v = Number(document.querySelector('#c-speed').value);
  const d = Number(document.querySelector('#c-offset').value);
  const I = 1 * 0.8 * 0.8 / 12 + m * d * d;
  return m * v * d / I * 1.01;
})()`);
await setValue('#predict-input', String(collision));
await click('#btn-predict');
await wait(200);
await click('#btn-fire');
await wait(2200);
s = await state();
console.log('T4', s.tasks.t4.done, Math.round(s.tasks.t4.score), s.tasks.t4.detail);
const collisionHud = await evaluate(`({
  phase: document.querySelector('#c-phase').textContent,
  w: document.querySelector('#c-hud-w').textContent,
  loss: document.querySelector('#c-hud-loss').textContent,
})`);
console.log('COLLISION_HUD', JSON.stringify(collisionHud));
await shot('flow-collision');

// 6. 任务 5
await setValue(
  '#t5-input',
  '碰撞瞬间，支点冲力对支点的力矩为零，所以绕支点的角动量守恒，满足mvd=Iω。但支点冲力使系统线动量不守恒；子弹嵌入杆是完全非弹性碰撞，机械能大量损失为内能和热。'
);
await click('#btn-t5');
s = await state();
console.log('T5', s.tasks.t5.done, Math.round(s.tasks.t5.score), s.tasks.t5.feedback);

// 7. 测评 8 题：每题选择第一个选项 / 输入 1
await click('.tab[data-view="quiz"]');
await click('#btn-quiz-start');
for (let i = 0; i < 8; i += 1) {
  const numeric = await evaluate(`!document.querySelector('#quiz-numeric').hidden`);
  if (numeric) {
    await setValue('#quiz-number', '1');
  } else {
    await evaluate(`document.querySelector('#quiz-options .option')?.click()`);
  }
  await click('#btn-quiz-submit');
  await wait(250);
  const nextVisible = await evaluate(`!document.querySelector('#btn-quiz-next').hidden`);
  if (!nextVisible) throw new Error(`第 ${i + 1} 题没有出现下一题按钮`);
  await click('#btn-quiz-next');
  await wait(250);
}
s = await state();
console.log('QUIZ', s.quiz.completed, s.quiz.score, s.quiz.summary?.weak);
console.log('QUIZ_DONE_VISIBLE', await evaluate(`!document.querySelector('#quiz-done').hidden`));
await shot('flow-quiz-done');

// 8. 学习反思
await click('.tab[data-view="report"]');
await wait(600);
await setValue(
  '#reflection-input',
  '收臂过程中，转轴方向合外力矩为零，因此角动量守恒；半径减小使转动惯量减小，角速度增大；动能增加来自人收臂时做的功。实验数据中L的偏差约为1%，在误差范围内。'
);
await click('#btn-reflection-score');
await wait(400);
s = await state();
console.log('REFLECTION', s.reflection.score, s.reflection.feedback);
console.log('REPORT_TOTAL', await text('#rep-total'), await text('#rep-level'));
await shot('flow-report');

// 9. AI 对话：迷思纠正 + 出题
await click('#btn-tutor');
await setValue('#chat-input', '角速度守恒吗？');
await click('#btn-send');
await wait(900);
const misconception = await evaluate(`document.querySelector('#chat-log .msg:last-child .msg-bubble')?.textContent || ''`);
console.log('AI_MISCONCEPTION', misconception.slice(0, 100));
await setValue('#chat-input', '出题考考我');
await click('#btn-send');
await wait(900);
const problem = await evaluate(`document.querySelector('#chat-log .msg:last-child .msg-bubble')?.textContent || ''`);
console.log('AI_PROBLEM', problem.slice(0, 100));
await setValue('#chat-input', '3.2');
await click('#btn-send');
await wait(700);
console.log('AI_CHECK', (await evaluate(`document.querySelector('#chat-log .msg:last-child .msg-bubble')?.textContent || ''`)).slice(0, 80));

await setValue('#chat-input', '下一步做什么？');
await click('#btn-send');
await wait(900);
const nextReply = await evaluate(`document.querySelector('#chat-log .msg:last-child .msg-bubble')?.textContent || ''`);
console.log('AI_NEXT', nextReply.slice(0, 100));
if (!/任务|测评|数据|复习|反思/.test(nextReply) || nextReply.includes('[object Object]')) {
  throw new Error('下一步回答异常');
}

await setValue('#chat-input', '帮我分析刚才的数据');
await click('#btn-send');
await wait(900);
const dataReply = await evaluate(`document.querySelector('#chat-log .msg:last-child .msg-bubble')?.textContent || ''`);
console.log('AI_DATA', dataReply.slice(0, 100));
if (!/L|偏差|数据/.test(dataReply) || dataReply.includes('[object Object]')) {
  throw new Error('数据分析回答异常');
}
await shot('flow-tutor');

// 10. 刷新持久化
await click('#tutor-close');
await send('Page.reload');
await wait(2600);
const afterReload = await state();
console.log('PERSIST', afterReload.tasks.t1.done, afterReload.tasks.t5.done, afterReload.quiz.score, afterReload.reflection.score);
console.log('REPORT_AFTER_RELOAD', await evaluate(`location.hash`), await text('#rep-total'));

console.log('EXCEPTIONS', JSON.stringify(exceptions));
console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrors));

ws.close();
