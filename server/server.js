const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const PUSH_TOKEN = process.env.PUSH_TOKEN || '';
// Public base URL used to build permalinks (e.g. https://agentcast.onrender.com).
// Falls back to the request's forwarded host when unset.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

if (!PUSH_TOKEN) {
  console.warn('[warn] PUSH_TOKEN is not set. All pushes will be rejected.');
}

const MAX_CONSOLE = 800;
const MAX_HTML = 30;
const consoleBuf = [];
const htmlBuf = [];
const activity = new Map(); // source -> {state, label, detail, ts}
let nextId = 1;

const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const cleanSource = (s) => String(s || 'agent').replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 48) || 'agent';
const newKey = () => Date.now().toString(36) + '-' + crypto.randomBytes(9).toString('base64url');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  if (!req) return '';
  return `${req.protocol}://${req.get('host')}`;
}

function broadcast(ev) {
  const msg = JSON.stringify(ev);
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN && c.role === 'viewer') c.send(msg);
  }
}

function snapshot() {
  return {
    type: 'init',
    console: consoleBuf,
    html: htmlBuf.map(({ content, ...meta }) => ({ ...meta, content })),
    activity: [...activity.entries()].map(([source, a]) => ({ source, ...a })),
  };
}

// Returns the accepted item (or true for non-item events), or null if rejected.
function acceptEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const source = cleanSource(ev.source);

  if (ev.type === 'console') {
    const item = {
      type: 'console',
      id: nextId++,
      source,
      subtype: String(ev.subtype || 'info').slice(0, 32),
      text: String(ev.text || '').slice(0, 8000),
      ts: Number(ev.ts) || Date.now(),
    };
    consoleBuf.push(item);
    if (consoleBuf.length > MAX_CONSOLE) consoleBuf.shift();
    broadcast(item);
    return item;
  }

  if (ev.type === 'html') {
    const key = KEY_RE.test(String(ev.key || '')) ? String(ev.key) : newKey();
    const item = {
      type: 'html',
      id: nextId++,
      key,
      source,
      title: String(ev.title || 'Untitled').slice(0, 200),
      content: String(ev.content || '').slice(0, 2 * 1024 * 1024),
      ts: Number(ev.ts) || Date.now(),
    };
    // same key = same artifact (e.g. replayed from a producer's cache): replace in place
    const existing = htmlBuf.findIndex((h) => h.key === key);
    if (existing >= 0) htmlBuf.splice(existing, 1);
    htmlBuf.push(item);
    while (htmlBuf.length > MAX_HTML) htmlBuf.shift();
    broadcast(item);
    return item;
  }

  if (ev.type === 'activity') {
    const state = ev.state === 'working' ? 'working' : 'idle';
    const a = {
      state,
      label: String(ev.label || '').slice(0, 80),
      detail: String(ev.detail || '').slice(0, 200),
      ts: Date.now(),
    };
    activity.set(source, a);
    broadcast({ type: 'activity', source, ...a });
    return true;
  }

  if (ev.type === 'status') {
    broadcast({ type: 'status', source, text: String(ev.text || '').slice(0, 500), ts: Date.now() });
    return true;
  }

  if (ev.type === 'reset') {
    // A producer is about to replay its local history.
    // With a source: drop only that source's console lines (other agents keep theirs).
    // HTML is always cleared, because every producer replays the shared local HTML cache.
    // Without a source (older relays): drop everything.
    if (ev.source) {
      for (let i = consoleBuf.length - 1; i >= 0; i--) if (consoleBuf[i].source === source) consoleBuf.splice(i, 1);
    } else {
      consoleBuf.length = 0;
      activity.clear();
    }
    htmlBuf.length = 0;
    broadcast(snapshot());
    return true;
  }
  return null;
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
    ws.send(JSON.stringify(snapshot()));
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

function authorized(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return PUSH_TOKEN && token === PUSH_TOKEN;
}

app.post('/push', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'invalid token' });
  const item = acceptEvent(req.body);
  if (!item) {
    return res.status(400).json({ error: 'invalid event: expected type console|html|activity|status|reset' });
  }
  if (item.type === 'html') {
    const base = baseUrl(req);
    return res.json({ ok: true, key: item.key, url: `${base}/o/${item.key}`, viewer: `${base}/#o=${item.key}` });
  }
  res.json({ ok: true });
});

// ---- permalinks: one pushed artifact, full screen, shareable (e.g. in Discord) ----
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function permalinkPage(req, key, item) {
  const base = baseUrl(req);
  const title = item ? item.title : 'agentcast';
  const when = item ? new Date(item.ts).toISOString() : '';
  const body = item
    ? `<iframe src="/o/${key}/raw" sandbox="allow-scripts allow-popups" title="${esc(title)}"></iframe>`
    : `<div class="wait"><p>この出力はまだサーバーに読み込まれていません。</p>
       <p class="sub">サーバーが休止から復帰した直後です。エージェント側で復元されるまで、このページは自動で再読み込みします。</p></div>
       <script>setTimeout(() => location.reload(), 5000)</script>`;
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} — agentcast</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="agentcast で生成された成果物${when ? '（' + esc(when.slice(0, 16).replace('T', ' ')) + ' UTC）' : ''}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(base)}/o/${esc(key)}">
<meta name="theme-color" content="#161b22">
<style>
  html,body{height:100%;margin:0;background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif}
  body{display:flex;flex-direction:column;padding-top:env(safe-area-inset-top,0px)}
  header{display:flex;align-items:center;gap:10px;padding:8px 14px;background:#161b22;border-bottom:1px solid #30363d;font-size:13px}
  header h1{font-size:14px;margin:0;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  header a{color:#58a6ff;text-decoration:none;white-space:nowrap}
  iframe{flex:1;border:0;width:100%;background:#fff}
  .wait{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center}
  .wait p{margin:4px 0}.wait .sub{color:#8b949e;font-size:13px;max-width:32em}
</style></head>
<body><header><h1>${esc(title)}</h1><a href="/#o=${esc(key)}">ライブビューで開く</a></header>${body}</body></html>`;
}

app.get('/o/:key', (req, res) => {
  const { key } = req.params;
  if (!KEY_RE.test(key)) return res.status(404).send('not found');
  const item = htmlBuf.find((h) => h.key === key);
  res.set('Cache-Control', 'no-store');
  res.status(item ? 200 : 404).type('html').send(permalinkPage(req, key, item));
});

app.get('/o/:key/raw', (req, res) => {
  const { key } = req.params;
  const item = KEY_RE.test(key) && htmlBuf.find((h) => h.key === key);
  if (!item) return res.status(404).send('not found');
  // Serve the agent's HTML in an opaque origin so it can't touch the viewer.
  res.set('Content-Security-Policy', 'sandbox allow-scripts allow-popups');
  res.set('Cache-Control', 'no-store');
  res.type('html').send(item.content);
});

const VERSION = require('./package.json').version;
app.get('/healthz', (_req, res) => res.json({
  ok: true,
  version: VERSION,
  viewers: [...wss.clients].filter((c) => c.role === 'viewer').length,
  outputs: htmlBuf.length,
}));

server.listen(PORT, () => console.log(`agentcast server listening on :${PORT}`));
