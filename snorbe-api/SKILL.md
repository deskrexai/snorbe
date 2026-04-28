---
name: snorbe-api
description: "Snorbe（自律リサーチエージェントサービス）の REST API を呼び出すスキル。エージェントは Web 検索・X 検索・browse（ブラウザ自動化）・RAG 記憶・マトリクス/レポート/プラン生成・他 Agent への委譲などを内部ツールとして持つ。このスキルは『エージェントに何を頼めるか』と『どう頼むか（inputText 設計）』と『API 経由で結果を受ける実装上の注意』を扱う。"
metadata:
  tags: snorbe, api, research-agent, rest-api, sse-streaming
---

# Snorbe API スキル

## Snorbe とは

ナレッジグラフベースの自律リサーチエージェントサービス。API 経由で `inputText` を送ると、エージェントが **内部で最適なツールを選んで実行** し、結果を返す。呼び出し側が指定するのは「何をして欲しいか」であって「どうやってやるか」ではない。

ツールは LLM が `chat-routing` プロンプトで分岐判定する（[capabilities.md#ツール選択ロジック](capabilities.md#ツール選択ロジック)）。したがって **`inputText` の書き方で挙動が大きく変わる**。

## このスキルの構成

目的別に参照先が分かれている。迷ったらこの順で読む:

1. **[capabilities.md](capabilities.md)** — エージェントが持つツール一覧・HITL 生成物（plan/report/matrix）・promptKey・モデル一覧。**最初に必ず読む**
2. **[prompting.md](prompting.md)** — `inputText` の効果的な書き方（どう書けば期待したツールが発火するか）
3. **[runtime-gotchas.md](runtime-gotchas.md)** — 実装上のハマりどころ（SSE 受信、タイムアウト、バッファリング、レート制限）
4. **[recipes/](recipes/)** — タスク別の完成ワークフロー（基本リサーチ・特許請求項一括抽出・グラフ探索・マルチエージェント委譲など）
5. **[reference/](reference/)** — API エンドポイントごとのリファレンス（詳細パラメータ・レスポンス・コード例）

## クイック導入

```bash
# 認証確認
curl "https://app.snorbe.deskrex.ai/api/v1/workspace" \
  -H "Authorization: Bearer $SNORBE_API_KEY"

# 利用可能なエージェント一覧（名前→ID 解決はここから）
curl "https://app.snorbe.deskrex.ai/api/v1/agent/list" \
  -H "Authorization: Bearer $SNORBE_API_KEY"
```

- **ベース URL**: `https://app.snorbe.deskrex.ai/api/v1`
- **認証**: `Authorization: Bearer snorbe_xxxxxxxx...`
- **レート制限**: API キーごとに **100 req/min**
- **OpenAPI 仕様**: `GET /openapi.json` で機械可読

### どのエージェントで走らせるか（指名の原則）

ユーザーが特定の bot を指名した場合は、**まず `GET /agent/list` で名前→ID を解決してから** `agentId` に直接入れる（`[X](agent://...)` のメンション構文は A→B リレー時以外では使わない）。指名がなければデフォルトエージェントにそのまま投げる。詳細は [prompting.md#エージェント指定の選び方-agentid-vs-mention_agent](prompting.md#エージェント指定の選び方agentid-vs-mention_agent) 参照。

## ワークフローの基本形（SSE ストリーミング）

```
1. POST /agent/run/stream に inputText を投げる
2. SSE で config / step / delta / browse-* / plan-* / complete イベントを受信
3. complete イベントで最終テキストと runId を取得
4. 詳細が必要なら GET /turn/list で agentRun.process と sources を回収
```

**重要**: SSE は `curl` で安定受信できるが、Python `requests.iter_lines` は
環境によって詰まる（[runtime-gotchas.md#sse-受信の落とし穴](runtime-gotchas.md#sse-受信の落とし穴)）。

## エンドポイント早見表

| 目的 | エンドポイント | 詳細 |
|------|----------------|------|
| エージェント実行（推奨） | `POST /agent/run/stream` | [reference/agent-streaming.md](reference/agent-streaming.md) |
| エージェント実行（同期） | `POST /agent/run` | [reference/agent-execution.md](reference/agent-execution.md) |
| 実行履歴取得（詳細含む） | `GET /turn/list` | [reference/turn.md](reference/turn.md) |
| ステータス確認（軽量） | `GET /agent/run/{runId}/status` | [reference/agent-execution.md](reference/agent-execution.md) |
| ラン詳細取得 | `GET /agent/run/{runId}` | [reference/agent-execution.md](reference/agent-execution.md) |
| レジューム | `POST /agent/run/stream/{runId}` | [reference/agent-streaming.md](reference/agent-streaming.md) |
| HITL 応答（plan/report/matrix） | `POST /agent/run/{runId}/{plan\|report\|matrix}/{answer\|confirm}` | [reference/agent-streaming.md](reference/agent-streaming.md) |
| 利用可能なモデル一覧 | `GET /agent/models` | [モデル選択](#モデル選択) |
| 利用可能なツール一覧 | `GET /agent/tools` | [capabilities.md#ツール一覧-api](capabilities.md#ツール一覧-api) |
| 有効化済みカスタムスキル一覧 | `GET /skill/list` | [capabilities.md#カスタムスキル一覧-api](capabilities.md#カスタムスキル一覧-api) |
| ワークスペース | `GET /workspace` | [reference/workspace.md](reference/workspace.md) |
| エージェント管理 | `GET/POST/PATCH/DELETE /agent[/{id}]` | [reference/workspace.md](reference/workspace.md) |
| グラフ取得 | `GET /graph/*` | [reference/graph.md](reference/graph.md) |
| エンティティ詳細 | `GET /graph/entity/{entityId}` | [reference/graph.md](reference/graph.md) |
| ソース詳細 | `GET /graph/source/{sourceId}` | [reference/graph.md](reference/graph.md) |

### 画像データの取得

`/turn/list` と `/agent/run/{runId}` の返値には `images: SearchImageItem[]` が含まれ、エージェント実行で収集した画像（検索画像 SERP・スキル成果物・ソース要約の bodyLinks）にアクセスできる。詳細は [recipes/image-retrieval.md](recipes/image-retrieval.md) を参照。

## モデル選択

`POST /agent/run` / `POST /agent/run/stream` の `modelName` は **必須**。原則 **推奨モデル** を明示指定する。

| 推奨モデル | 用途 |
|------------|------|
| `snorbe-fast` | 標準。速度・コスト重視。API クライアントの推奨デフォルト値 |
| `snorbe-quality` | 難易度が高いリサーチ / 品質重視。内部で強力なプロバイダモデルに自動マッピング |

- 推奨モデルは Snorbe 内部で**プロンプトごとに最適なプロバイダモデル**（Claude / GPT / Gemini 等）へ自動ルーティングされる。個別プロバイダモデル名の指定よりも、こちらを優先する
- 個別モデル（`claude-opus-4-7`, `gpt-5-mini-2025-08-07` 等）も指定可能だが、特定プロバイダに固定する明確な理由がある場合のみ
- 指定可能なモデル ID と説明は **`GET /agent/models`** で取得できる（認証不要。`defaultModel` / `recommendedModelIds` / `models[]` を返す）。`defaultModel` は API 側の自動デフォルトではなく、クライアントが選ぶ際の推奨値

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/agent/models"
```

レスポンス例:

```json
{
  "defaultModel": "snorbe-fast",
  "recommendedModelIds": ["snorbe-fast", "snorbe-quality"],
  "models": [
    {
      "id": "snorbe-fast",
      "displayName": "Snorbe-Fast",
      "provider": "snorbe",
      "isRecommended": true,
      "description": "Recommended default for Agent API usage..."
    }
  ]
}
```

詳細な個別モデル一覧は [capabilities.md#使えるモデル](capabilities.md#使えるモデル) 参照。

## 共通エラー

| ステータス | コード | 対処 |
|-----------|--------|------|
| 401 | `UNAUTHORIZED` | API キーを確認 |
| 429 | `TOO_MANY_REQUESTS` | リトライ（`retryDelayMs` 付与）。レート制限 100 req/min |
| 404 | - | `runId` 不在（レジューム時） |

## 典型的な失敗パターン

- ❌ `inputText: "調べて"` のような曖昧な入力 → ツール選択がブレる
- ❌ Python `requests` で SSE 受信（background 実行で詰まる）
- ❌ client timeout 短い設定での `/agent/run` 呼び出し → client 切断、結果は `/turn/list` 回収
- ❌ HITL（plan/report/matrix）を無視 → draft のまま stuck

各対処は [prompting.md](prompting.md) / [runtime-gotchas.md](runtime-gotchas.md) 参照。
