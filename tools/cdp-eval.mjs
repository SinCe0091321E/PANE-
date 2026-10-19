import fs from 'node:fs';

const port = process.argv[2] || '9222';
const arg = process.argv[3] || '1';
const targetFilter = process.argv[4] || 'renderer/index.html';
const expression = arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg;

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => (t.type === 'page' || t.type === 'webview') && t.url.includes(targetFilter));
if (!page) {
  console.error('no matching target:', list.map((t) => `${t.type}:${t.url}`).join('\n'));
  process.exit(2);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
const result = await new Promise((resolve) => {
  ws.addEventListener('message', (event) => resolve(JSON.parse(event.data)), { once: true });
});
console.log(JSON.stringify(result.result?.result ?? result.result ?? result));
ws.close();
process.exit(0);
