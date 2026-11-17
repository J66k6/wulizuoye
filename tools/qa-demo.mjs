/**
 * tools/qa-demo.mjs — 生成文档用「完整学习档案」截图。
 * 会在本地浏览器中完成全部任务、以正确答案完成 8 题测评，
 * 写入 docs/screenshots/（示例数据，不包含任何真实学生信息）。
 */

import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const URL = process.env.QA_URL || 'http://127.0.0.1:8080/';
const OUT = path.resolve('docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) throw new Error('没有找到可调试的页面');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
const exceptions = [];

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  }
});

const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
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
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const click = async (selector) => {
  const ok = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
  if (!ok) throw new Error(`找不到元素 ${selector}`);
  await wait(150);
};
const setValue = async (selector, value) => {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(100);
};
const setRange = async (selector, value) => {
  await setValue(selector, String(value));
};
const shot = async (name) => {
  const response = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(response.result.data, 'base64'));
  console.log('SHOT', name);
};
const readState = async () => {
  await wait(500);
  const raw = await evaluate(`localStorage.getItem('amlab.state.v2')`);
  return raw ? JSON.parse(raw) : null;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1100,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.navigate', { url: URL });
await wait(2200);
await send('Page.navigate', { url: 'about:blank' });
await wait(300);
await send('Storage.clearDataForOrigin', {
  origin: 'http://127.0.0.1:8080',
  storageTypes: 'local_storage,session_storage',
});
await send('Page.navigate', { url: URL });
await wait(2600);

// ---------- 实验台：记录 3 组数据 ----------
await setRange('#r-range', 0.6);
await click('#btn-record');
await setRange('#r-range', 0.45);
await click('#btn-record');
await setRange('#r-range', 0.3);
await click('#btn-record');
await click('.task[data-task="t1"]');
await click('#btn-check-t1');
await wait(600);

const prediction = await evaluate(`(() => {
  const L = Number(document.querySelector('#hud-L').textContent);
  return L / (0.6 + 2 * 2 * 0.3 * 0.3);
})()`);
await click('.task[data-task="t2"]');
await setValue('#t2-input', String(prediction));
await click('#btn-t2');
await wait(500);
await click('.task[data-task="t3"]');
await setValue(
  '#t3-input',
  '收臂时转轴方向合外力矩为零，所以角动量守恒。半径减小使转动惯量减小，由ω=L/I可知角速度增大。动能的增加来自人体拉配重向内做的功，不是无中生有。'
);
await click('#btn-t3');
await wait(3800);
await evaluate(`window.scrollTo(0, 0)`);
await wait(400);
await shot('lab');

await evaluate(`window.scrollTo(0, 760)`);
await wait(400);
await shot('lab-data');
await evaluate(`window.scrollTo(0, 0)`);

// ---------- 碰撞：预测 + 发射 ----------
await click('.tab[data-view="collision"]');
await wait(350);
const collisionPrediction = await evaluate(`(() => {
  const m = Number(document.querySelector('#c-mass').value) / 1000;
  const v = Number(document.querySelector('#c-speed').value);
  const d = Number(document.querySelector('#c-offset').value);
  const I = 1 * 0.8 * 0.8 / 12 + m * d * d;
  return m * v * d / I;
})()`);
await setValue('#predict-input', collisionPrediction.toFixed(2));
await click('#btn-predict');
await wait(400);
await click('#btn-fire');
await wait(4300);
await shot('collision');
await setValue(
  '#t5-input',
  '碰撞瞬间，支点冲力对支点的力矩为零，所以绕支点的角动量守恒，满足mvd=Iω。但支点冲力使系统线动量不守恒；子弹嵌入杆是完全非弹性碰撞，机械能大量损失为内能和热。'
);
await click('#btn-t5');
await wait(600);

// ---------- 测评：全部答对 ----------
await click('.tab[data-view="quiz"]');
await click('#btn-quiz-start');
await wait(700);
for (let i = 0; i < 8; i += 1) {
  const s = await readState();
  const item = s.quiz.items[s.quiz.index];
  if (!item) throw new Error('找不到当前题目');
  console.log(`Q${i + 1}`, item.type, item.concepts.join('/'));
  if (item.type === 'mcq') {
    await evaluate(`document.querySelectorAll('#quiz-options .option')[${item.answerIndex}]?.click()`);
  } else {
    await setValue('#quiz-number', String(item.answer));
  }
  await click('#btn-quiz-submit');
  await wait(500);
  await click('#btn-quiz-next');
  await wait(500);
}
const quizState = await readState();
console.log('QUIZ_SCORE', quizState.quiz.score);
await wait(400);
await shot('quiz');

// ---------- 报告 ----------
await click('.tab[data-view="report"]');
await wait(600);
await setValue(
  '#reflection-input',
  '收臂过程中，转轴方向合外力矩为零，因此角动量守恒；半径减小使转动惯量减小，角速度增大；动能增加来自人收臂时做的功。实验数据中L的偏差约为0%，在误差范围内。'
);
await click('#btn-reflection-score');
await wait(3800);
const finalState = await readState();
console.log('FINAL', finalState.tasks.t1.score, finalState.tasks.t2.score, finalState.tasks.t3.score, finalState.tasks.t4.score, finalState.tasks.t5.score, finalState.quiz.score, finalState.reflection.score);
await shot('report');

// ---------- AI 助教 ----------
await click('#btn-tutor');
await setValue('#chat-input', '为什么收臂后角速度会变大？');
await click('#btn-send');
await wait(1000);
await shot('tutor');
await click('#tutor-close');

// ---------- 移动端 ----------
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});
await send('Page.reload');
await wait(2600);
await evaluate(`document.querySelector('.tab[data-view="lab"]').click()`);
await wait(500);
await evaluate(`window.scrollTo(0, 0)`);
await wait(300);
await shot('mobile');

console.log('EXCEPTIONS', JSON.stringify(exceptions));
ws.close();
