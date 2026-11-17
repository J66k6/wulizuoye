/**
 * tools/qa-fps.mjs — 粗略测量桌面端 / 移动端帧率与加载时间。
 * 需要先启动带 --remote-debugging-port=9222 的 Edge。
 */

const CDP = 'http://127.0.0.1:9222';
const URL = process.env.QA_URL || 'http://127.0.0.1:8080/';
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
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description);
  return response.result?.result?.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function measure(label) {
  const result = await evaluate(`new Promise(resolve => {
    let frames = 0;
    const start = performance.now();
    function tick(t) {
      frames++;
      if (t - start < 1600) requestAnimationFrame(tick);
      else {
        const nav = performance.getEntriesByType('navigation')[0];
        const resources = performance.getEntriesByType('resource');
        resolve({
          fps: Math.round(frames / ((t - start) / 1000)),
          domReady: Math.round(nav.domContentLoadedEventEnd),
          load: Math.round(nav.loadEventEnd),
          resources: resources.length,
          transferKB: Math.round(resources.reduce((a, r) => a + (r.transferSize || 0), 0) / 1024),
        });
      }
    }
    requestAnimationFrame(tick);
  })`);
  console.log(label, JSON.stringify(result));
}

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });
await wait(2600);
await measure('DESKTOP');

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL });
await wait(2600);
await measure('MOBILE');

ws.close();
