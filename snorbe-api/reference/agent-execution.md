# エージェント実行（非ストリーミング）

## POST /agent/run

エージェントを同期的に実行し、完了後に結果を返す。

> ⚠️ **実行時間とクライアントタイムアウト**
>
> このエンドポイントは **agent runが完了するまでHTTPコネクションを保持** する。
> `executeAgentRun` は LLM 推論 → ツール実行（ブラウジング/検索）→ RAG → グラフ抽出 を
> すべて同期で走らせるため、リクエストの内容によって **10秒〜数分** かかる。
>
> クライアントのデフォルトタイムアウト（curl 0秒=無制限だが、多くの HTTP ライブラリは
> 30〜120秒）で切断された場合、**サーバー側は最後まで走り切るが、レスポンスは呼び出し元に
> 届かない**。結果は `/chat/list` に積まれるので後追いで取得できる。
>
> **推奨**:
> - 単純な Q&A 以外は **`/agent/run/stream`（SSEストリーミング）** を使う（最初のイベントで
>   即 `runId` が返り、切断しても `/agent/run/stream/{runId}` で再接続可能）
> - どうしても非ストリーミングで使う場合はクライアント側の timeout を **300秒以上** に設定

### リクエスト

```bash
# curl はデフォルトでタイムアウトしないが、python/fetch等はtimeoutを延ばすこと
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "modelName": "gpt-5-mini-2025-08-07",
    "inputText": "最新のAI動向を調査して",
    "promptKey": "chat-routing",
    "locale": "ja"
  }'
```

```python
# Python: timeoutを最低300秒に設定
import requests

resp = requests.post(
    "https://app.snorbe.deskrex.ai/api/v1/agent/run",
    headers={"Authorization": "Bearer snorbe_YOUR_KEY"},
    json={
        "modelName": "gpt-5-mini-2025-08-07",
        "inputText": "最新のAI動向を調査して",
        "promptKey": "chat-routing",
        "locale": "ja",
    },
    timeout=300,  # ブラウジング/ツール使用を想定して最低300秒
)
```

### パラメータ

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| `modelName` | `string` | はい | 使用するモデル名 |
| `inputText` | `string` | はい | エージェントへの入力テキスト |
| `promptKey` | `string` | はい | プロンプトキー（通常 `"chat-routing"`） |
| `locale` | `string` | はい | `"ja"` または `"en"` |
| `fileUrls` | `string[]` | いいえ | 添付ファイルURL（最大10件） |
| `agentId` | `string` | いいえ | エージェントID |
| `mentions` | `Mention[]` | いいえ | @メンション。`{ id, type, label }` の配列。`type` は `"agent" / "agent-run" / "entity" / "public-source" / "private-source"`。詳細は「エージェント委譲（メンション）」セクション |
| `maxBrowsingSteps` | `number` | いいえ | ブラウジング最大ステップ（1-100） |
| `maxChainSteps` | `number` | いいえ | Agent 間メンション連鎖の最大深さ（1-50、デフォルト 10）。これを超える再帰的 `mentionAgent` ファンアウトは打ち止められる |
| `maxRetries` | `number` | いいえ | リトライ回数（0-5） |
| `retryDelayMs` | `number` | いいえ | リトライ間隔ms（0-10000） |
| `includeOthersEntities` | `boolean` | いいえ | 他ユーザーのエンティティをRAG検索対象に（デフォルト: true） |
| `extendedContextEnabled` | `boolean` | いいえ | 拡張コンテキスト（デフォルト: false） |

### レスポンス

```json
{
  "text": "エージェントの応答テキスト",
  "finishReason": "stop",
  "model": { "name": "gpt-4o" },
  "runId": "clxxx001",
  "status": "completed",
  "assistantChatId": "clyyy001",
  "agentId": "clzzz001",
  "agentName": "agent"
}
```

### エラー

| ステータス | コード | 説明 |
|-----------|--------|------|
| 400 | `BAD_REQUEST` | 必須パラメータ不足・不正 |
| 401 | `UNAUTHORIZED` | API キー無効 |
| 429 | `TOO_MANY_REQUESTS` | レート制限超過 |
| 500 | `INTERNAL_ERROR` | サーバー内部エラー |

---

## GET /agent/run/{runId}/status

エージェント実行のステータスを取得。

### リクエスト

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/agent/run/clxxx001/status" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

### レスポンス

```json
{
  "id": "clxxx001",
  "status": "running",
  "createdAt": "2026-04-16T10:30:00.000Z",
  "updatedAt": "2026-04-16T10:30:05.000Z",
  "pendingPlanDraft": false,
  "pendingReportDraft": false,
  "pendingMatrixDraft": false,
  "skillState": {
    "isRunningSkill": true,
    "skillName": "patent-search",
    "pendingSecretKeys": ["PATENT_API_KEY"]
  }
}
```

### status の値

| 値 | 説明 |
|----|------|
| `running` | 実行中 |
| `completed` | 完了 |
| `failed` | 失敗 |
| `cancelled` | キャンセル |

`pending*Draft` が `true` の場合、HITL確認待ち。該当する確認エンドポイントを呼ぶ。

`skillState.pendingSecretKeys` に値がある場合、skill が secret 登録待ち。各キーを `/secret` に登録すると、待機中の skill 実行が再開できる。

```bash
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/secret" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "PATENT_API_KEY",
    "value": "your-secret-value"
  }'
```

---

## ラン完了後の詳細取得

`/agent/run/{runId}/status` は軽量（`status` + `pending*Draft` フラグのみ）。
**エージェントの詳細な実行履歴（ブラウズ手順・参照ソース・プラン/レポート/マトリクスの
ドラフト・グラフ抽出結果など）を取得するには `/chat/list` を使う。**

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/chat/list?limit=10" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

`chats[].agentRun` に以下が含まれる:

| フィールド | 内容 |
|---|---|
| `status` | 実行ステータス |
| `process` | **全イベントのタイムライン**（`config`・`delta`・`step`・`browse-*`・`plan`・`source-summary-*`・`graph-*` 等すべて） |
| `publicSourceAgentRuns` / `privateSourceAgentRuns` | エージェントが参照した URL ソース（bodyLinks 含む） |
| `agent` | エージェント情報 |

特定 runId を取りたい場合は `/chat/list` を降順でページングし、
`chats[].agentRun.id === 対象 runId` で探す（直接 runId 指定の取得エンドポイントは未提供）。

---

## POST /agent/run/{runId}/resume

非ストリーミングでエージェントをレジューム。パラメータ・レスポンスは `/agent/run` と同じ。

---

## エージェント委譲（メンション）

`mentions` に `type: "agent"` のエントリを含めると、呼び出し先エージェントが実行中に指名された他 Agent へ委譲できる。

### 1 体指名

```json
{
  "inputText": "[agent-beta](agent://agent-beta-id) さんに〜を聞いて",
  "mentions": [
    { "id": "agent-beta-id", "type": "agent", "label": "agent-beta" }
  ]
}
```

挙動:
1. デフォルト（または `agentId` で指定した）エージェントが run を開始
2. run 中に LLM が `mentionAgent` tool を選択 → 指名対象をメモ
3. run 完了後、サーバが **最終アシスタントメッセージ本文をそのまま入力** として agent-beta の新しい AgentRun を起動
4. 起動された child run は独立した run として完了し、chat 履歴に積まれる

### 2 体以上指名（並列 vs 連鎖）

```json
{
  "inputText": "[agent-alpha](agent://a-id) と [agent-beta](agent://b-id) にそれぞれ意見ください",
  "mentions": [
    { "id": "a-id", "type": "agent", "label": "agent-alpha" },
    { "id": "b-id", "type": "agent", "label": "agent-beta" }
  ]
}
```

サーバ側 LLM 分類器が `inputText` の文意を判定して動作が分岐:

- **parallel**（独立意見）: 全 mention Agent を**並列**実行。どの Agent も同じユーザー入力を受け取る
- **chain**（順序依存、例:「A が企画 → B がレビュー」）: **primary** が先行実行。他 mention は primary の履歴に残り、primary が `mentionAgent` で引き継ぐ

### ループ防御

- **self-loop**: target agentId が呼び出し元と同一なら spawn しない
- **depth**: 同 chainKey 内で再帰的に `mentionAgent` が発火し続けた場合、`maxChainSteps` に達した時点で打ち止め（警告ログ、例外は出さない）

### Resume 後の委譲

Plan/Report/Matrix 確定で resume された run が最終メッセージで `mentionAgent` を発火した場合も、通常 run と同じ仕様で child が spawn される。

### レスポンスに child run は含まれない

`/agent/run` のレスポンスは **親 run の** `runId` / `text` のみを返す。child run は非同期に DB に積まれるので、child 側の結果を追いたい場合は:

- `/chat/list?limit=N` で最新 chat を取得（各 chat は `agentRunId` を持つ）
- `/agent/run/{childRunId}/status` で個別ステータス確認
