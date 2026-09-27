// Shared helpers for agentcast producer scripts.
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Config: LIVE_VIEW_URL / LIVE_VIEW_TOKEN env vars, or ~/.config/live-view.json
export function loadConfig() {
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

// Local copies of pushed HTML are the source of truth (the server forgets on spin-down).
// AGENTCAST_CACHE_DIR lets sandboxed agents (e.g. Codex :workspace) use a writable path.
export const cacheRoot = process.env.AGENTCAST_CACHE_DIR || join(homedir(), '.cache', 'live-view');
export const htmlCacheDir = join(cacheRoot, 'history');
export const HTML_CACHE_MAX = 20;

export const newKey = () => Date.now().toString(36) + '-' + randomBytes(9).toString('base64url');

export function saveHtmlCache(entry) {
  mkdirSync(htmlCacheDir, { recursive: true });
  writeFileSync(join(htmlCacheDir, `${Date.now()}-${entry.key}.json`), JSON.stringify(entry));
  const files = readdirSync(htmlCacheDir).filter((f) => f.endsWith('.json')).sort();
  while (files.length > HTML_CACHE_MAX) unlinkSync(join(htmlCacheDir, files.shift()));
}

export function readHtmlCache() {
  if (!existsSync(htmlCacheDir)) return [];
  const out = [];
  for (const f of readdirSync(htmlCacheDir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const e = JSON.parse(readFileSync(join(htmlCacheDir, f), 'utf8'));
      // entries written by agentcast <=1.0 have no key: derive a stable one from the file name
      if (!e.key) e.key = 'legacy-' + f.replace(/\.json$/, '');
      out.push(e);
    } catch { /* skip corrupt entries */ }
  }
  return out;
}

export async function post(url, token, ev) {
  const res = await fetch(url + '/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ ts: Date.now(), ...ev }),
  });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
  return body;
}
