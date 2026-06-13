#!/usr/bin/env node
// Push an HTML file (or stdin) to the live-view server.
// Usage: node push.mjs [--title "Title"] [file.html]
// Config: LIVE_VIEW_URL / LIVE_VIEW_TOKEN env vars, or ~/.config/live-view.json
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
    console.error('Missing config. Set LIVE_VIEW_URL and LIVE_VIEW_TOKEN, or create ~/.config/live-view.json with {"url": "...", "token": "..."}');
    process.exit(1);
  }
  return { url: url.replace(/\/$/, ''), token };
}

const args = process.argv.slice(2);
let title = 'Output';
let file = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--title') title = args[++i];
  else file = args[i];
}

const content = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
const { url, token } = loadConfig();

// Keep a local copy so the relay can restore the right pane after the
// server's in-memory buffer is wiped (e.g. Render free-plan spin-down).
try {
  const cacheDir = join(homedir(), '.cache', 'live-view', 'history');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, `${Date.now()}.json`), JSON.stringify({ title, content }));
  const files = readdirSync(cacheDir).filter((f) => f.endsWith('.json')).sort();
  while (files.length > 10) unlinkSync(join(cacheDir, files.shift()));
} catch (e) {
  console.warn('cache save failed:', e.message);
}

const res = await fetch(url + '/push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ type: 'html', title, content }),
});
if (!res.ok) {
  console.error(`Push failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`Pushed "${title}" (${content.length} bytes) -> ${url}`);
