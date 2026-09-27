#!/usr/bin/env node
// Push an HTML file (or stdin) to the agentcast server and print its share link.
// Usage: node push.mjs [--title "Title"] [--source hermes:discord] [file.html]
//   --json   print {"key","url","viewer"} as JSON instead of text
// Config: LIVE_VIEW_URL / LIVE_VIEW_TOKEN env vars, or ~/.config/live-view.json
// Source default: $AGENTCAST_SOURCE, else "agent".
import { readFileSync } from 'node:fs';
import { loadConfig, newKey, saveHtmlCache, post } from './lib.mjs';

const args = process.argv.slice(2);
let title = 'Output';
let source = process.env.AGENTCAST_SOURCE || 'agent';
let file = null;
let asJson = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--title') title = args[++i];
  else if (args[i] === '--source') source = args[++i];
  else if (args[i] === '--json') asJson = true;
  else file = args[i];
}

const content = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
const { url, token } = loadConfig();
const key = newKey();
const ts = Date.now();

// Keep a local copy so a restore can rebuild the Output pane (and revive
// permalinks, since the key is stable) after the server's memory is wiped.
try {
  saveHtmlCache({ key, title, source, content, ts });
} catch (e) {
  console.warn('cache save failed (set AGENTCAST_CACHE_DIR to a writable dir):', e.message);
}

let body;
try {
  body = await post(url, token, { type: 'html', key, title, source, content, ts });
} catch (e) {
  console.error(`Push failed: ${e.message}`);
  process.exit(1);
}
const link = body.url || `${url}/o/${key}`;
if (asJson) {
  console.log(JSON.stringify({ key, url: link, viewer: body.viewer || `${url}/#o=${key}` }));
} else {
  console.log(`Pushed "${title}" (${content.length} bytes)`);
  console.log(`URL: ${link}`);
}
