/**
 * tools/qa.mjs — 本地自动化验收脚本（开发工具，不参与页面运行）
 *
 * 通过 Chrome DevTools Protocol 打开页面，等待动画结束，
 * 采集控制台错误、布局指标，并生成桌面端 / 移动端截图。
 *
 * 使用前先启动 Edge：
 *   msedge --headless=new --remote-debugging-port=9222 --user-data-dir=...
 * 然后：node tools/qa.mjs
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
const errors = [];
const logs = [];
const exceptions = [];

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const resolver = pending.get(message.id);
    pending.delete(message.id);
    resolver?.(message);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const detail = message.params.exceptionDetails;
    exceptions.push(detail.exception?.description || detail.text);
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    logs.push(message.params.entry.text);
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

async function screenshot(name) {
  const response = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(response.result.data, 'base64'));
  console.log(`SHOT ${file}`);
}

async function load() {
  await send('Page.navigate', { url: URL });
  await wait(3200);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
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

const metrics = await evaluate(`(() => {
  const canvas = document.querySelector('#lab-canvas');
  const rect = canvas.getBoundingClientRect();
  return {
    title: document.title,
    bodyReady: document.body.classList.contains('is-ready'),
    shellOpacity: getComputedStyle(document.querySelector('.app-shell')).opacity,
    boot: !!document.querySelector('#boot'),
    canvasCss: [Math.round(rect.width), Math.round(rect.height)],
    canvasPixels: [canvas.width, canvas.height],
    hud: document.querySelector('#hud-L').textContent,
    view: document.querySelector('.view.is-active')?.id,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: innerWidth,
  };
})()`);
console.log('METRICS', JSON.stringify(metrics, null, 2));
await screenshot('desktop-lab');

await evaluate(`document.querySelector('.tab[data-view="collision"]').click()`);
await wait(900);
await screenshot('desktop-collision-idle');
const collisionBefore = await evaluate(`({
  phase: document.querySelector('#c-phase').textContent,
  hudW: document.querySelector('#c-hud-w').textContent,
})`);
console.log('COLLISION_BEFORE', JSON.stringify(collisionBefore));

await evaluate(`document.querySelector('#btn-fire').click()`);
await wait(2200);
const collisionAfter = await evaluate(`({
  phase: document.querySelector('#c-phase').textContent,
  hudW: document.querySelector('#c-hud-w').textContent,
  hudL: document.querySelector('#c-hud-L').textContent,
  hudLoss: document.querySelector('#c-hud-loss').textContent,
  afterBar: document.querySelector('#energy-after-bar').style.width,
})`);
console.log('COLLISION_AFTER', JSON.stringify(collisionAfter));
await screenshot('desktop-collision-after');

await evaluate(`document.querySelector('.tab[data-view="quiz"]').click()`);
await wait(400);
await evaluate(`document.querySelector('#btn-quiz-start').click()`);
await wait(500);
await screenshot('desktop-quiz-question');
const quizState = await evaluate(`({
  stem: document.querySelector('#quiz-stem').textContent,
  options: document.querySelectorAll('#quiz-options .option').length,
  active: !document.querySelector('#quiz-active').hidden,
  step: document.querySelector('#quiz-step').textContent,
})`);
console.log('QUIZ', JSON.stringify(quizState));

await evaluate(`document.querySelector('#quiz-options .option')?.click()`);
await evaluate(`document.querySelector('#btn-quiz-submit').click()`);
await wait(400);
const quizFeedback = await evaluate(`({
  feedback: document.querySelector('#quiz-feedback').textContent.slice(0, 120),
  nextVisible: !document.querySelector('#btn-quiz-next').hidden,
})`);
console.log('QUIZ_FEEDBACK', JSON.stringify(quizFeedback));
await screenshot('desktop-quiz-feedback');

await evaluate(`document.querySelector('.tab[data-view="report"]').click()`);
await wait(900);
await screenshot('desktop-report');
const report = await evaluate(`({
  total: document.querySelector('#rep-total').textContent,
  level: document.querySelector('#rep-level').textContent,
  radar: document.querySelector('#radar-canvas').width,
  ai: document.querySelector('#rep-ai').textContent.slice(0, 80),
})`);
console.log('REPORT', JSON.stringify(report));

// 打开 AI 助教并提问
await evaluate(`document.querySelector('#btn-tutor').click()`);
await wait(400);
await evaluate(`document.querySelector('#chat-input').value = '为什么收臂后角速度会变大？'; document.querySelector('#btn-send').click()`);
await wait(1200);
await screenshot('desktop-tutor');
const tutor = await evaluate(`({
  messages: document.querySelectorAll('#chat-log .msg').length,
  last: document.querySelector('#chat-log .msg:last-child .msg-bubble')?.textContent.slice(0, 140),
  open: document.querySelector('#tutor-drawer').classList.contains('is-open'),
})`);
console.log('TUTOR', JSON.stringify(tutor));

// 移动端
await evaluate(`document.querySelector('#tutor-close').click()`);
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});
await load();
await screenshot('mobile-lab');
const mobileMetrics = await evaluate(`({
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: innerWidth,
  canvas: (() => { const r = document.querySelector('#lab-canvas').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
  tabs: document.querySelectorAll('.tab').length,
})`);
console.log('MOBILE', JSON.stringify(mobileMetrics));

await evaluate(`document.querySelector('#btn-tutor').click()`);
await wait(500);
await screenshot('mobile-tutor');
await evaluate(`document.querySelector('#tutor-close').click()`);
await evaluate(`document.querySelector('.tab[data-view="quiz"]').click()`);
await wait(500);
await screenshot('mobile-quiz');

// 回到桌面端，检查关于弹窗（二维码）与实验台下半部分
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
await load();
await evaluate(`document.querySelector('#btn-help').click()`);
await wait(500);
await screenshot('desktop-about');
const qr = await evaluate(`({
  svg: !!document.querySelector('#about-qr svg'),
  size: Math.round(document.querySelector('#about-qr svg')?.getBoundingClientRect().width || 0),
})`);
console.log('QR', JSON.stringify(qr));
await evaluate(`document.querySelector('#about-close').click()`);
await evaluate(`window.scrollTo(0, 780)`);
await wait(500);
await screenshot('desktop-lab-lower');

console.log('EXCEPTIONS', JSON.stringify(exceptions, null, 2));
console.log('CONSOLE_ERRORS', JSON.stringify(errors, null, 2));
console.log('LOG_ERRORS', JSON.stringify(logs, null, 2));

ws.close();
