/**
 * tools/qa-llm.mjs — 验证可选云端 LLM 失败时的自动回退。
 * 使用一个必然连接失败的本地端口，确认不会卡死、不会抛异常。
 */

const CDP = 'http://127.0.0.1:9222';
const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) throw new Error('no page');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
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
  } else if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
  return response.result?.result?.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const click = async (selector) => {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await wait(180);
};
const setValue = async (selector, value) => {
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await wait(120);
};

await send('Runtime.enable');
await send('Page.reload');
await wait(2500);

await click('#btn-tutor');
await click('#btn-tutor-settings');
await click('#llm-toggle');
await setValue('#llm-endpoint', 'http://127.0.0.1:9/v1/chat/completions');
await setValue('#llm-model', 'test-model');
await setValue('#llm-key', 'sk-test');
await click('#btn-save-settings');
console.log('LABEL', await evaluate(`document.querySelector('#tutor-engine-label').textContent`));

await setValue('#chat-input', '测试云端失败回退');
await click('#btn-send');
await wait(3500);
const last = await evaluate(`document.querySelector('#chat-log .msg:last-child .msg-bubble')?.textContent || ''`);
console.log('LAST', last.slice(0, 180));
console.log('HAS_FALLBACK', /本地引擎|云端模型暂时不可用/.test(last));
console.log('EXCEPTIONS', JSON.stringify(exceptions));

// 清理云端配置
await click('#btn-tutor-settings');
await click('#llm-toggle');
await setValue('#llm-key', '');
await click('#btn-save-settings');
console.log('CLEANED', await evaluate(`document.querySelector('#tutor-engine-label').textContent`));
ws.close();
