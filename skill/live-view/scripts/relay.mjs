#!/usr/bin/env node
// Mirror a Claude Code session to the live-view server in realtime.
// Tails the session transcript (~/.claude/projects/<project>/<session>.jsonl)
// and streams console events over a producer WebSocket.
//
// The local transcript is the source of truth: on every (re)connect the relay
// sends a reset and replays the whole current session, so the server's
// in-memory buffer survives restarts/spin-downs (e.g. Render free plan).
//
// Usage: node relay.mjs [--cwd /path] [--file transcript.jsonl] [--once]
//   --once  replay the latest session once and exit (restore mode)
// Config: LIVE_VIEW_URL / LIVE_VIEW_TOKEN env vars, or ~/.config/live-view.json
import { readFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';

function loadConfig() {
  let url = process.env.LIVE_VIEW_URL;
  let token = process.env.LIVE_VIEW_TOKEN;
  const file = join(homedir(), '.config', 'live-view.json');
  if ((!url || !token) && existsSync(file)) {
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    url = url || cfg.url;
    token = token || cfg.token;
  }
  if (!url || !token) {
    console.error('Missing config. Set LIVE_VIEW_URL and LIVE_VIEW_TOKEN, or create ~/.config/live-view.json');
    process.exit(1);
  }
  return { url: url.replace(/\/$/, ''), token };
}

const args = process.argv.slice(2);
let cwd = process.cwd();
let fileOverride = null;
let once = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cwd') cwd = args[++i];
  else if (args[i] === '--file') fileOverride = args[++i];
  else if (args[i] === '--once') once = true;
}

const { url, token } = loadConfig();
const wsUrl = url.replace(/^http/, 'ws') + '/ws?role=producer&token=' + encodeURIComponent(token);
const projectDir = join(homedir(), '.claude', 'projects', resolve(cwd).replace(/[^A-Za-z0-9]/g, '-'));
const htmlCacheDir = join(homedir(), '.cache', 'live-view', 'history');

const PID_FILE = '/tmp/live-view-relay.pid';
if (!once) writeFileSync(PID_FILE, String(process.pid));
const cleanup = () => { if (!once) { try { unlinkSync(PID_FILE); } catch {} } process.exit(0); };
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// ---- websocket; full replay on every (re)connect makes a send queue unnecessary ----
let ws = null;
let wsOpen = false;
function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = async () => {
    wsOpen = true;
    console.log('[relay] connected to', url);
    replaySession();
    if (once) {
      while (ws.bufferedAmount > 0) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 500));
      console.log('[relay] restore complete');
      ws.close();
      cleanup();
    }
  };
  ws.onclose = (e) => {
    wsOpen = false;
    if (e.code === 4001) {
      console.error('[relay] server rejected token, exiting');
      cleanup();
    }
    if (!once) setTimeout(connect, 3000);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
function send(ev) {
  if (wsOpen && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ts: Date.now(), ...ev }));
  }
  // not connected: drop silently — the replay on reconnect restores everything
}
connect();

// ---- transcript parsing ----
const trunc = (s, n) => (s.length > n ? s.slice(0, n) + ' …' : s);

function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const candidates = [input.description, input.file_path, input.command, input.pattern,
    input.url, input.query, input.prompt, input.skill];
  for (const c of candidates) if (typeof c === 'string' && c) return trunc(c.replace(/\s+/g, ' '), 200);
  return '';
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  return '';
}

function handleLine(raw) {
  let line;
  try { line = JSON.parse(raw); } catch { return; }
  if (line.isMeta) return;
  const ts = Date.parse(line.timestamp) || Date.now();

  if (line.type === 'assistant' && line.message?.content) {
    for (const block of line.message.content) {
      if (block.type === 'text' && block.text?.trim()) {
        send({ type: 'console', subtype: 'assistant', text: trunc(block.text.trim(), 4000), ts });
      } else if (block.type === 'tool_use') {
        const detail = summarizeToolInput(block.name, block.input);
        send({ type: 'console', subtype: 'tool_use', text: block.name + (detail ? ': ' + detail : ''), ts });
      }
    }
  } else if (line.type === 'user' && line.message?.content) {
    const content = line.message.content;
    if (typeof content === 'string') {
      if (content.trim() && !/^<[a-z-]+>/.test(content.trim())) {
        send({ type: 'console', subtype: 'user', text: trunc(content.trim(), 2000), ts });
      }
      return;
    }
    for (const block of content) {
      if (block.type === 'text' && block.text?.trim()) {
        const t = block.text.trim();
        if (/^<[a-z-]+>/.test(t)) continue; // command/system wrapper messages
        send({ type: 'console', subtype: 'user', text: trunc(t, 2000), ts });
      } else if (block.type === 'tool_result') {
        const t = blockText(block.content).trim();
        if (t) send({ type: 'console', subtype: 'tool_result', text: trunc(t, 600), ts });
      }
    }
  }
}

// ---- session replay (rebuilds server state from local sources of truth) ----
let currentFile = null;
let offset = 0;
let remainder = '';

function replayHtmlCache() {
  if (!existsSync(htmlCacheDir)) return;
  const files = readdirSync(htmlCacheDir).filter((f) => f.endsWith('.json')).sort();
  for (const f of files) {
    try {
      const { title, content } = JSON.parse(readFileSync(join(htmlCacheDir, f), 'utf8'));
      send({ type: 'html', title, content });
    } catch { /* skip corrupt cache entries */ }
  }
}

function replaySession() {
  send({ type: 'reset' });
  if (currentFile && existsSync(currentFile)) {
    const data = readFileSync(currentFile, 'utf8');
    offset = Buffer.byteLength(data);
    remainder = '';
    for (const l of data.split('\n')) if (l.trim()) handleLine(l);
    console.log('[relay] replayed', basename(currentFile), `(${offset} bytes)`);
  }
  replayHtmlCache();
  send({ type: 'status', text: (once ? 'restored: ' : 'mirroring: ') + basename(cwd) });
}

// ---- live tailing ----
function newestTranscript() {
  if (fileOverride) return fileOverride;
  if (!existsSync(projectDir)) return null;
  let best = null;
  let bestM = 0;
  for (const f of readdirSync(projectDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const p = join(projectDir, f);
    const m = statSync(p).mtimeMs;
    if (m > bestM) { bestM = m; best = p; }
  }
  return best;
}

function poll() {
  const newest = newestTranscript();
  if (newest && newest !== currentFile) {
    currentFile = newest;
    if (wsOpen) replaySession();
    return;
  }
  if (!currentFile || !existsSync(currentFile)) return;

  const size = statSync(currentFile).size;
  if (size < offset) { offset = 0; remainder = ''; } // truncated/rotated
  if (size === offset) return;

  const fd = openSync(currentFile, 'r');
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  offset = size;

  const chunk = remainder + buf.toString('utf8');
  const lines = chunk.split('\n');
  remainder = lines.pop() ?? '';
  for (const l of lines) if (l.trim()) handleLine(l);
}

currentFile = newestTranscript();
if (!currentFile) console.log('[relay] no transcript yet in', projectDir, '- waiting');

if (!once) {
  setInterval(poll, 500);
  // Render free plan spins down after 15 min without inbound traffic;
  // ping while a session is being mirrored so it stays awake.
  setInterval(() => fetch(url + '/healthz').catch(() => {}), 4 * 60 * 1000);
  console.log('[relay] watching project dir:', projectDir);
}
