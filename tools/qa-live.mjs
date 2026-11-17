/**
 * tools/qa-live.mjs — 线上 GitHub Pages 冒烟测试。
 * 通过本机 Edge 打开线上地址，确认 HTML/CSS/JS 实际加载、场景初始化无异常。
 */

import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const LIVE = process.env.LIVE_URL || 'https://J66k6.github.io/wulizuoye/?live=1';
const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) throw new Error('no page');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const exceptions = [];
const consoleErrors = [];
const failures = [];

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
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
  }
  if (message.method === 'Network.loadingFailed' && !message.params.canceled) {
    failures.push(`${message.params.errorText}`);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
  return response.result?.result?.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: LIVE });
await wait(6000);

const info = await evaluate(`({
  title: document.title,
  ready: document.body.classList.contains('is-ready'),
  hud: document.querySelector('#hud-L')?.textContent,
  canvasCss: (() => { const c = document.querySelector('#lab-canvas'); if (!c) return null; const r = c.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), c.width, c.height]; })(),
  view: document.querySelector('.view.is-active')?.id,
  nav: performance.getEntriesByType('navigation')[0]?.responseStatus,
})`);
console.log('LIVE', JSON.stringify(info, null, 2));
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.mkdirSync('qa', { recursive: true });
fs.writeFileSync(path.join('qa', 'live.png'), Buffer.from(shot.result.data, 'base64'));
console.log('EXCEPTIONS', JSON.stringify(exceptions));
console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrors));
console.log('NETWORK_FAILURES', JSON.stringify([...new Set(failures)]));
ws.close();
