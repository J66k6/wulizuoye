/**
 * tools/qa-print.mjs — 验证打印报告能生成多页 PDF。
 */

import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) throw new Error('no page');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return response.result?.result?.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.reload');
await wait(2400);
await evaluate(`document.querySelector('.tab[data-view="report"]').click()`);
await wait(700);

const pdf = await send('Page.printToPDF', {
  printBackground: true,
  paperWidth: 8.27,
  paperHeight: 11.69,
  marginTop: 0.5,
  marginBottom: 0.5,
  marginLeft: 0.5,
  marginRight: 0.5,
  preferCSSPageSize: true,
});
const buffer = Buffer.from(pdf.result.data, 'base64');
fs.mkdirSync('qa', { recursive: true });
fs.writeFileSync(path.join('qa', 'report.pdf'), buffer);
const pages = (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
console.log(JSON.stringify({ bytes: buffer.length, pages }));
ws.close();
