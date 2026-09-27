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
  scripts/push.mjs  HTMLをサーバーへプッシュ（共有リンクを返す）
  scripts/relay.mjs トランスクリプトをtailしてコンソールをミラー
  scripts/restore.mjs  Hermes 等のローカル履歴からビューアを復元
hermes/             Hermes Agent 連携（Discord などから使う）
  hooks/agentcast/  ゲートウェイフック（依頼・ステップ・返答をミラー）
  skills/agentcast/ Hermes 用スキル（成果物を送り、返信にリンクを付ける）
  install.sh        ~/.hermes へシンボリックリンクを張る
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

## Hermes Agent（Discord）と使う

Discord は「指示と通知」、agentcast は「映像」という分担で使う。

- Discord で依頼すると、ビューアの上部に「Hermes（Discord）作業中 3ステップ目 terminal」のような表示が出て、左ペインに依頼・ツール・返答が流れる
- 成果物ができると Hermes が agentcast に送り、Discord の返信に `📺 ライブビュー: https://.../o/xxxx` を付ける。スマホでタップするとその成果物だけが全画面で開く
- Claude Code のミラーと同時に使える。左ペインの行には発信元（Claude Code / Discord）のバッジが付く

### 使い方の例

| 場面 | やり方 |
|---|---|
| 外出先から | Discord で「p5.jsで波紋のアニメーション作って」→ 返信のリンクをタップして確認 →「もっと遅く」と返す |
| ゼミ・授業 | プロジェクターに `https://<app>.onrender.com/?panes=output` を映し、学生が Discord で依頼する。成果物が届くたびに画面が切り替わる |
| 経過だけ見たい | `?panes=console` で依頼と作業ログだけを表示 |
| あとで見返す | 共有リンクはサーバーが休止しても、「ライブビュー復元」で同じURLのまま復活する |

### セットアップ

```bash
bash hermes/install.sh          # hook と skill を ~/.hermes にリンク
# ~/.config/live-view.json が未作成なら作る（Claude Code 側と共通）
# Hermes のゲートウェイを再起動し、ログに次の行が出ることを確認
#   [hooks] Loaded hook 'agentcast' for events: [...]
```

Discord から使えるコマンド（Hermes スキル）: 「ライブビュー」「ライブビュー復元」「ライブビュー オフ／オン」「プロジェクター用」。

### Codex ランタイムで使う場合

会話のミラー（ゲートウェイフック）はどのランタイムでも動く。成果物の送信は Hermes が `push.mjs` をシェルで実行するため、Codex のサンドボックスでネットワークが止められていると失敗する。その場合は `~/.codex/config.toml` で作業ディレクトリ書き込み時のネットワークを許可する:

```toml
[sandbox_workspace_write]
network_access = true
```

`~/.cache/live-view` への書き込みが拒否される場合は、環境変数 `AGENTCAST_CACHE_DIR` を書き込み可能な場所に向ける（フックと push.mjs の両方がこの変数を見る）。

## Render無料プランについて

無料プランは15分間アクセスがないとスピンダウンし（次回アクセス時に約30〜60秒のコールドスタート）、メモリ上の履歴も消える。本システムは**ローカルのトランスクリプトとHTMLキャッシュを正本**とし、リレーが（再）接続のたびに `reset` + 全セッションをリプレイしてサーバー状態を再構築するため、無料プランでも:

- セッション中: リレーが4分ごとに `/healthz` をpingするのでスピンダウンしない
- サーバーが再起動/復帰したら: リレーが自動で直近セッションを丸ごと復元
- リレーを起動していなかった場合: `relay.mjs --once`（「ライブビュー復元」）で復元

常時表示サイネージ用途など、コールドスタートすら避けたい場合のみ有料プラン（Starter）か外部からの定期pingを検討。

## API

- `POST /push` — `Authorization: Bearer <PUSH_TOKEN>`。body の `type` は次のいずれか。どれも任意で `source`（例: `claude-code`, `hermes:discord`）を付けられる
  - `{"type":"html","title":"...","content":"<html>...","key":"任意"}` → 応答に共有リンク `url`（`/o/<key>`）が入る。同じ `key` で再送すると置き換え
  - `{"type":"console","subtype":"user|assistant|tool_use|tool_result|info","text":"..."}`
  - `{"type":"activity","state":"working|idle","label":"...","detail":"..."}` → ヘッダーの作業中表示
  - `{"type":"reset","source":"..."}` → その source のコンソールと全HTMLを消す（直後に履歴を再送する前提）
- `GET /o/<key>` — 成果物1件の全画面ページ（Discord 等のリンクプレビュー対応）
- `GET /?panes=output|console` — 片方のペインだけ表示
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
