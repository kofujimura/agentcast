"""agentcast mirror for Hermes Agent gateway sessions.

Streams each chat turn (the request, every tool-loop step, the final reply)
to an agentcast server so the work can be watched live next to the HTML the
agent pushes. Works with both the default Hermes runtime and the Codex
app-server runtime, because it only relies on gateway lifecycle events.

Config (same as the agentcast skill):
  LIVE_VIEW_URL / LIVE_VIEW_TOKEN env vars, or ~/.config/live-view.json
Switch off without restarting the gateway:
  touch ~/.cache/live-view/hermes-off   (remove the file to switch back on)

The hook never blocks the agent: events go through a queue drained by one
background thread, so a sleeping Render instance can't stall a Discord reply.
"""
import json
import os
import queue
import threading
import time
import urllib.request
from pathlib import Path

CACHE_ROOT = Path(os.environ.get("AGENTCAST_CACHE_DIR") or Path.home() / ".cache" / "live-view")
OFF_FLAG = CACHE_ROOT / "hermes-off"
LOG_FILE = CACHE_ROOT / "hermes-console.jsonl"
LOG_MAX_LINES = 600

_q: "queue.Queue[dict]" = queue.Queue(maxsize=2000)
_worker = None
_lock = threading.Lock()
_turns: dict = {}  # session_id -> {"source": ..., "started": ...}


def _config():
    url = os.environ.get("LIVE_VIEW_URL")
    token = os.environ.get("LIVE_VIEW_TOKEN")
    cfg_file = Path.home() / ".config" / "live-view.json"
    if (not url or not token) and cfg_file.exists():
        try:
            cfg = json.loads(cfg_file.read_text())
            url = url or cfg.get("url")
            token = token or cfg.get("token")
        except Exception:
            pass
    if not url or not token:
        return None
    return url.rstrip("/"), token


def _post(url, token, ev, timeout):
    req = urllib.request.Request(
        url + "/push",
        data=json.dumps(ev).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        r.read()


def _run():
    awake_until = 0.0
    while True:
        ev = _q.get()
        cfg = _config()
        if not cfg:
            continue
        url, token = cfg
        # first event after a quiet spell may hit a cold start (~50s on Render free)
        timeout = 8 if time.time() < awake_until else 75
        for attempt in range(2):
            try:
                _post(url, token, ev, timeout)
                awake_until = time.time() + 10 * 60
                break
            except Exception as e:  # network down, 401, cold start...
                if attempt == 0:
                    timeout = 75
                    time.sleep(2)
                else:
                    print(f"[agentcast] push failed: {e}", flush=True)


def _ensure_worker():
    global _worker
    with _lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run, name="agentcast-push", daemon=True)
            _worker.start()


def _log_local(ev):
    """Keep console events locally so `restore.mjs` can rebuild the viewer."""
    try:
        CACHE_ROOT.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(ev, ensure_ascii=False) + "\n")
        if LOG_FILE.stat().st_size > 400_000:
            lines = LOG_FILE.read_text(encoding="utf-8").splitlines()[-LOG_MAX_LINES:]
            LOG_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except Exception:
        pass


def _emit(ev, keep=True):
    ev.setdefault("ts", int(time.time() * 1000))
    if keep and ev.get("type") == "console":
        _log_local(ev)
    _ensure_worker()
    try:
        _q.put_nowait(ev)
    except queue.Full:
        pass


def _source(ctx):
    platform = str(ctx.get("platform") or "chat").lower()
    return f"hermes:{platform}"


def _label(platform):
    names = {"discord": "Discord", "slack": "Slack", "telegram": "Telegram", "cli": "CLI"}
    p = str(platform or "").lower()
    return f"Hermes（{names.get(p, p or 'chat')}）"


def _clip(s, n):
    s = str(s or "").strip()
    return s if len(s) <= n else s[:n] + " …"


def handle(event_type: str, context: dict):
    if OFF_FLAG.exists() or not _config():
        return
    ctx = context or {}
    src = _source(ctx)
    sid = str(ctx.get("session_id") or ctx.get("session_key") or "")

    if event_type == "agent:start":
        _turns[sid] = {"source": src, "started": time.time()}
        chat = "DM" if ctx.get("chat_type") == "dm" else ""
        _emit({"type": "activity", "source": src, "state": "working",
               "label": _label(ctx.get("platform")), "detail": _clip(ctx.get("message"), 60)}, keep=False)
        text = _clip(ctx.get("message"), 2000)
        _emit({"type": "console", "source": src, "subtype": "user",
               "text": f"{text}" + (f"  ({chat})" if chat else "")})

    elif event_type == "agent:step":
        tools = [str(t) for t in (ctx.get("tool_names") or [])]
        it = ctx.get("iteration")
        detail = f"{it}ステップ目" + (f" {', '.join(tools)}" if tools else "")
        _emit({"type": "activity", "source": src, "state": "working",
               "label": _label(ctx.get("platform")), "detail": detail}, keep=False)
        if tools:
            _emit({"type": "console", "source": src, "subtype": "tool_use",
                   "text": f"[{it}] " + ", ".join(tools)})

    elif event_type == "agent:end":
        turn = _turns.pop(sid, None)
        took = f"  ({int(time.time() - turn['started'])}秒)" if turn else ""
        reply = _clip(ctx.get("response"), 4000)
        if reply:
            _emit({"type": "console", "source": src, "subtype": "assistant", "text": reply + took})
        _emit({"type": "activity", "source": src, "state": "idle"}, keep=False)

    elif event_type == "session:reset":
        _emit({"type": "console", "source": src, "subtype": "status", "text": "— 新しいセッション —"})
