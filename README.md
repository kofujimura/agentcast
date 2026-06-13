# agentcast

[日本語版 README はこちら](README.ja.md)

Mirror your AI coding agent sessions (Claude Code, Codex, etc.) to a web page in realtime.

- **Left pane**: live console mirror (conversation and tool executions as they happen)
- **Right pane**: HTML artifacts pushed by the agent (reports, charts, tables), with tab history
- Each pane can be closed with ×, and reopened from the header buttons
- Built for "watch the site, not the terminal" workflows — leave the page open on another screen and see what your agent is doing

No MCP server required: the agent side is a plain Claude Code **skill** that pushes HTML over HTTP and mirrors the console by tailing the local session transcript.

## Architecture

```
server/             Server to deploy on Render (Express + ws)
  server.js         Receives POST /push, broadcasts over WebSocket, keeps recent history in memory
  public/index.html Viewer page (two-pane UI)
skill/live-view/    Claude Code skill
  SKILL.md          Skill definition
  scripts/push.mjs  Push an HTML artifact to the server
  scripts/relay.mjs Tail the session transcript and mirror the console
render.yaml         Render Blueprint
```

The local machine is the source of truth: on every (re)connect the relay sends a `reset` and replays the whole current session (plus the last 10 pushed HTML artifacts cached in `~/.cache/live-view/history`), so the server can be stateless and survive restarts.

## Deploy (Render)

1. Push this repository to GitHub and import it on Render via **New > Blueprint** (`render.yaml` is auto-detected and `PUSH_TOKEN` is auto-generated).
   Or create a **New > Web Service** manually: Root Directory=`server`, Build=`npm install`, Start=`node server.js`, and set the `PUSH_TOKEN` env var.
2. After deploying, `https://<app>.onrender.com/` is the viewer page.

## Local setup (skill side)

```bash
mkdir -p ~/.config
cat > ~/.config/live-view.json <<'EOF'
{ "url": "https://<app>.onrender.com", "token": "<PUSH_TOKEN>" }
EOF
ln -s "$(pwd)/skill/live-view" ~/.claude/skills/live-view
```

## Usage

- In Claude Code, say "ライブビュー開始" / "start live view" → the session is mirrored to the left pane
- When the agent produces an HTML artifact, it is pushed to the right pane automatically
- Manual push: `node skill/live-view/scripts/push.mjs --title "Report" out.html`
- Stop: "ミラー停止" / "stop live view"
- If the viewer is empty (e.g. after a server restart): "ライブビュー復元" / "restore live view" re-sends the last session

## Render free plan

The free plan spins down after 15 minutes without inbound traffic (cold start ~30–60s) and loses in-memory history. agentcast is designed around this:

- While a session is mirrored, the relay pings `/healthz` every 4 minutes so the service stays awake
- When the server comes back, the relay automatically replays the entire current session
- If no relay is running, `relay.mjs --once` ("restore live view") rebuilds the viewer from the local transcript and HTML cache

Consider a paid plan (or an external uptime pinger) only if you need an always-on signage display with no cold starts.

## API

- `POST /push` — `Authorization: Bearer <PUSH_TOKEN>`, body: `{"type":"html","title":"...","content":"<html>..."}` or `{"type":"console","subtype":"info","text":"..."}`
- `WS /ws?role=viewer` — for viewers (no auth). Receives `{"type":"init",...}` with recent history on connect
- `WS /ws?role=producer&token=<PUSH_TOKEN>` — for producers. Send `console` / `html` / `status` / `reset` events as JSON

## Local development

```bash
cd server && npm install
PUSH_TOKEN=test node server.js
# in another terminal
echo '<h1>Hello</h1>' | LIVE_VIEW_URL=http://localhost:3000 LIVE_VIEW_TOKEN=test \
  node ../skill/live-view/scripts/push.mjs --title "Test"
open http://localhost:3000
```

## Notes

- The console mirror is Claude Code-specific (it tails `~/.claude/projects/<project>/<session>.jsonl`). HTML push works from any agent that can run a command (Codex, etc.).
- The viewer page is public by default; pushing requires the token. Keep the URL private or put the service behind auth if your sessions are sensitive.
