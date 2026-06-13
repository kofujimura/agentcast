const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const PUSH_TOKEN = process.env.PUSH_TOKEN || '';

if (!PUSH_TOKEN) {
  console.warn('[warn] PUSH_TOKEN is not set. All pushes will be rejected.');
}

const MAX_CONSOLE = 500;
const MAX_HTML = 30;
const consoleBuf = [];
const htmlBuf = [];
let nextId = 1;

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(ev) {
  const msg = JSON.stringify(ev);
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN && c.role === 'viewer') c.send(msg);
  }
}

function acceptEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.type === 'console') {
    const item = {
      type: 'console',
      id: nextId++,
      subtype: String(ev.subtype || 'info').slice(0, 32),
      text: String(ev.text || '').slice(0, 8000),
      ts: Number(ev.ts) || Date.now(),
    };
    consoleBuf.push(item);
    if (consoleBuf.length > MAX_CONSOLE) consoleBuf.shift();
    broadcast(item);
    return true;
  }
  if (ev.type === 'html') {
    const item = {
      type: 'html',
      id: nextId++,
      title: String(ev.title || 'Untitled').slice(0, 200),
      content: String(ev.content || '').slice(0, 2 * 1024 * 1024),
      ts: Number(ev.ts) || Date.now(),
    };
    htmlBuf.push(item);
    if (htmlBuf.length > MAX_HTML) htmlBuf.shift();
    broadcast(item);
    return true;
  }
  if (ev.type === 'status') {
    broadcast({ type: 'status', text: String(ev.text || '').slice(0, 500), ts: Date.now() });
    return true;
  }
  if (ev.type === 'reset') {
    // producer is about to replay the full session: drop stale state
    consoleBuf.length = 0;
    htmlBuf.length = 0;
    broadcast({ type: 'reset' });
    return true;
  }
  return false;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const role = url.searchParams.get('role') || 'viewer';

  if (role === 'producer') {
    const token = url.searchParams.get('token') || '';
    if (!PUSH_TOKEN || token !== PUSH_TOKEN) {
      ws.close(4001, 'invalid token');
      return;
    }
    ws.role = 'producer';
    broadcast({ type: 'status', text: 'producer connected', ts: Date.now() });
    ws.on('message', (data) => {
      try {
        acceptEvent(JSON.parse(data.toString()));
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.on('close', () => broadcast({ type: 'status', text: 'producer disconnected', ts: Date.now() }));
  } else {
    ws.role = 'viewer';
    ws.send(JSON.stringify({ type: 'init', console: consoleBuf, html: htmlBuf }));
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Keep connections alive through proxies (Render idles silent connections)
setInterval(() => {
  for (const c of wss.clients) {
    if (!c.isAlive) { c.terminate(); continue; }
    c.isAlive = false;
    c.ping();
  }
}, 30000);

app.post('/push', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!PUSH_TOKEN || token !== PUSH_TOKEN) {
    return res.status(401).json({ error: 'invalid token' });
  }
  if (!acceptEvent(req.body)) {
    return res.status(400).json({ error: 'invalid event: expected type console|html|status' });
  }
  res.json({ ok: true });
});

const VERSION = require('./package.json').version;
app.get('/healthz', (_req, res) => res.json({ ok: true, version: VERSION, viewers: wss.clients.size }));

server.listen(PORT, () => console.log(`live-view server listening on :${PORT}`));
