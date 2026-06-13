# agentcast

[English README is here](README.md)

AIコーディングエージェント（Claude Code / Codex 等）の出力をWebサイトにリアルタイム表示するシステム。

- **左ペイン**: コンソールミラー（会話・ツール実行をリアルタイム表示）
- **右ペイン**: エージェントがプッシュしたHTML成果物（タブで履歴切替）
- 各ペインは × で閉じられ、ヘッダーのボタンで再表示

## 構成

```
server/             Render にデプロイするサーバー (Express + ws)
  server.js         POST /push 受信 + WebSocket 配信 + 直近履歴のメモリ保持
  public/index.html 閲覧ページ（2ペインUI）
skill/live-view/    Claude Code スキル
  SKILL.md          スキル定義
  scripts/push.mjs  HTMLをサーバーへプッシュ
  scripts/relay.mjs トランスクリプトをtailしてコンソールをミラー
render.yaml         Render Blueprint
```

## デプロイ（Render）

1. このリポジトリをGitHubにpushし、Render で **New > Blueprint** から取り込む（`render.yaml` を自動検出、`PUSH_TOKEN` は自動生成）。
   または **New > Web Service** で Root Directory=`server`, Build=`npm install`, Start=`node server.js`, 環境変数 `PUSH_TOKEN` を手動設定。
2. デプロイ後、`https://<app>.onrender.com/` が閲覧ページ。

## ローカル設定（スキル側）

```bash
mkdir -p ~/.config
cat > ~/.config/live-view.json <<'EOF'
{ "url": "https://<app>.onrender.com", "token": "<PUSH_TOKEN>" }
EOF
ln -s "$(pwd)/skill/live-view" ~/.claude/skills/live-view
```

## 使い方

- Claude Code で「ライブビュー開始」→ 以後のセッションが左ペインにミラーされる
- エージェントがHTML成果物を作ると自動で右ペインにプッシュされる
- 手動プッシュ: `node skill/live-view/scripts/push.mjs --title "Report" out.html`
- 停止: 「ミラー停止」
- 表示が空のとき（サーバー再起動後など）: 「ライブビュー復元」→ 直近セッションを再送

## Render無料プランについて

無料プランは15分間アクセスがないとスピンダウンし（次回アクセス時に約30〜60秒のコールドスタート）、メモリ上の履歴も消える。本システムは**ローカルのトランスクリプトとHTMLキャッシュを正本**とし、リレーが（再）接続のたびに `reset` + 全セッションをリプレイしてサーバー状態を再構築するため、無料プランでも:

- セッション中: リレーが4分ごとに `/healthz` をpingするのでスピンダウンしない
- サーバーが再起動/復帰したら: リレーが自動で直近セッションを丸ごと復元
- リレーを起動していなかった場合: `relay.mjs --once`（「ライブビュー復元」）で復元

常時表示サイネージ用途など、コールドスタートすら避けたい場合のみ有料プラン（Starter）か外部からの定期pingを検討。

## API

- `POST /push` — `Authorization: Bearer <PUSH_TOKEN>`、body: `{"type":"html","title":"...","content":"<html>..."}` または `{"type":"console","subtype":"info","text":"..."}`
- `WS /ws?role=viewer` — 閲覧用（認証なし）。接続時に `{"type":"init",...}` で直近履歴を受信
- `WS /ws?role=producer&token=<PUSH_TOKEN>` — 送信用。`console`/`html`/`status` イベントをJSONで送る

## ローカル動作確認

```bash
cd server && npm install
PUSH_TOKEN=test node server.js
# 別ターミナル
echo '<h1>Hello</h1>' | LIVE_VIEW_URL=http://localhost:3000 LIVE_VIEW_TOKEN=test \
  node ../skill/live-view/scripts/push.mjs --title "Test"
open http://localhost:3000
```
