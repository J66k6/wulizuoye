/**
 * tools/cdp-eval.mjs — 在已运行的调试浏览器里执行一段表达式。
 * 用法：node tools/cdp-eval.mjs "localStorage.getItem('amlab.state.v2')"
 */

const CDP = 'http://127.0.0.1:9222';
const expression = process.argv.slice(2).join(' ') || 'document.title';

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

const result = await new Promise((resolve, reject) => {
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id === 1) {
      if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text));
      else resolve(message.result?.result?.value);
    }
  });
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
  }));
});

console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
ws.close();
