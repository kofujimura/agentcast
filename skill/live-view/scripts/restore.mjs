#!/usr/bin/env node
// Rebuild the viewer from local history for a non-Claude-Code agent (e.g. Hermes).
// Replays that source's console log (written by the Hermes gateway hook) and the
// shared HTML cache, so permalinks posted to chat work again after a spin-down.
// Usage: node restore.mjs [--source hermes]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, readHtmlCache, cacheRoot, post } from './lib.mjs';

const args = process.argv.slice(2);
let source = 'hermes';
for (let i = 0; i < args.length; i++) if (args[i] === '--source') source = args[++i];

const { url, token } = loadConfig();

// wake the server first (Render free plan cold start can take ~50s)
for (let i = 0; i < 12; i++) {
  try { if ((await fetch(url + '/healthz')).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 5000));
}

await post(url, token, { type: 'reset', source });

let lines = 0;
const logFile = join(cacheRoot, `${source.split(':')[0]}-console.jsonl`);
if (existsSync(logFile)) {
  for (const l of readFileSync(logFile, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { await post(url, token, JSON.parse(l)); lines++; } catch { /* skip */ }
  }
}
let outputs = 0;
for (const { key, title, content, source: s, ts } of readHtmlCache()) {
  await post(url, token, { type: 'html', key, title, content, source: s || 'agent', ts });
  outputs++;
}
await post(url, token, { type: 'status', source, text: `restored: ${lines} lines, ${outputs} outputs` });
console.log(`Restored ${lines} console lines and ${outputs} outputs -> ${url}`);
