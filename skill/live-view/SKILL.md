---
name: live-view
description: AIコーディングセッションをWebサイトにリアルタイム表示する。コンソールのミラー（live-view start）と、HTML成果物のプッシュ（live-view push）に対応。「ライブビュー」「Webビューアに表示」「画面にプッシュ」「ミラー開始/停止」などと言われたら使う。
---

# Live View

セッションの様子とHTML成果物を、デプロイ済みのビューアサイトにリアルタイム表示するスキル。
ビューアは2ペイン構成: 左=コンソールミラー、右=プッシュされたHTML。

## 設定

サーバーURLとトークンが必要。優先順: 環境変数 `LIVE_VIEW_URL` / `LIVE_VIEW_TOKEN` → `~/.config/live-view.json`（`{"url": "https://...", "token": "..."}`）。
どちらも無ければユーザーに設定を依頼すること。

以下、`$SKILL_DIR` はこの SKILL.md があるディレクトリを指す。

## コマンド

### ミラー開始（start）

ユーザーが「ミラー開始」「ライブビュー開始」と言ったら、リレーをバックグラウンドで起動する:

```bash
nohup node "$SKILL_DIR/scripts/relay.mjs" --cwd "$(pwd)" > /tmp/live-view-relay.log 2>&1 &
```

起動後 `sleep 1 && head -5 /tmp/live-view-relay.log` で接続を確認し、ユーザーにビューアURL（設定の `url`）を伝える。
リレーは現在のプロジェクトのトランスクリプトをtailし、以後の会話・ツール実行を自動でミラーする。

### ミラー停止（stop）

```bash
kill "$(cat /tmp/live-view-relay.pid)" 2>/dev/null && echo stopped || echo "not running"
```

### HTMLをプッシュ（push）

成果物（レポート、グラフ、テーブルなど）をビューアの右ペインに表示する:

```bash
node "$SKILL_DIR/scripts/push.mjs" --title "タイトル" path/to/output.html
```

stdinからも可: `echo "<h1>Hi</h1>" | node "$SKILL_DIR/scripts/push.mjs" --title "Quick"`

### 最後のセッションを復元（restore）

ミラーを起動していなかった／サーバーが再起動して表示が空になったとき、直近セッションの内容をビューアに復元する:

```bash
node "$SKILL_DIR/scripts/relay.mjs" --once --cwd "$(pwd)"
```

直近のトランスクリプト全体と、過去にpushしたHTML（ローカルキャッシュ ~/.cache/live-view/history、最新10件）を再送する。

### 状態確認（status）

```bash
[ -f /tmp/live-view-relay.pid ] && ps -p "$(cat /tmp/live-view-relay.pid)" > /dev/null && echo "relay running (pid $(cat /tmp/live-view-relay.pid))" || echo "relay not running"
tail -5 /tmp/live-view-relay.log 2>/dev/null
```

## 振る舞いのルール

- このスキルが有効化されたセッションでは、**視覚的な成果物（HTML・グラフ・レポート・比較表など）を生成したら、ユーザーに聞かずに毎回 push する**。タイトルは内容がわかる日本語で付ける。
- HTMLは自己完結（インラインCSS/JS、外部CDN可）にする。ビューアは sandbox 付き iframe（allow-scripts）で描画するため、外部リソースはhttpsで読み込めるものに限る。
- push が 401 を返したらトークン設定をユーザーに確認。接続エラーならサーバーURLとデプロイ状態を確認。
- ミラーはClaude Code専用（トランスクリプトをtailするため）。push は Codex 等どのエージェントからでも使える。
