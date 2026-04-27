# 会話ターン履歴の一覧取得

## GET /turn/list

Turn 履歴をカーソルベースのページネーションで取得。新しい順。

> **用途**: このエンドポイントは単なる会話ターン取得ではなく、
> **エージェントランの詳細結果を後から取得する主要な手段** でもある。
> `turns[].agentRun.process` に SSE イベントの永続化タイムラインが入っているため、
> ブラウズ手順・ツール呼び出し・プラン/レポート/マトリクスドラフト・グラフ抽出・
> ソース要約などの詳細を全部取得可能。`publicSourceAgentRuns` /
> `privateSourceAgentRuns` には参照した URL ソースが含まれる。
> （直接 runId を指定して取得するエンドポイントは提供されていないので、
> 目的の runId を探すには `/turn/list` をページングする必要がある）

### リクエスト

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/turn/list?limit=10" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

### パラメータ

| パラメータ | 型 | 必須 | デフォルト | 説明 |
|-----------|------|------|----------|------|
| `limit` | `integer` | いいえ | `10` | 1ページあたりの件数（1-50） |
| `cursor` | `string` | いいえ | - | 前ページの `nextCursor` |

### レスポンス

```json
{
  "turns": [
    {
      "id": "clxxx001",
      "kind": "user",
      "content": "最新のAI動向を調査して",
      "agentRunId": null,
      "createdAt": "2026-04-16T10:30:00.000Z",
      "agentRun": null
    },
    {
      "id": "clxxx002",
      "kind": "assistant",
      "content": "調査結果をお伝えします...",
      "agentRunId": "clyyy001",
      "createdAt": "2026-04-16T10:30:05.000Z",
      "agentRun": {
        "id": "clyyy001",
        "status": "completed",
        "process": [
          { "type": "config", "runId": "clyyy001", "modelName": "...", "inputText": "..." },
          { "type": "browse-start", "websocketInfo": {...} },
          { "type": "browse-step", "action": "click", "screenshot": "..." },
          { "type": "browse-final", "result": "..." },
          { "type": "delta", "deltaText": "..." },
          { "type": "step", "status": "complete", "finishReason": "stop" }
        ],
        "publicSourceAgentRuns": [
          {
            "publicSource": {
              "id": "src_...",
              "url": "https://example.com",
              "title": "...",
              "description": "...",
              "bodyLinks": [{ "title": "...", "url": "...", "type": "..." }]
            }
          }
        ],
        "privateSourceAgentRuns": [],
        "agent": { "id": "clzzz001", "name": "agent" }
      }
    }
  ],
  "nextCursor": "clxxx003"
}
```

`kind` の取りうる値: `"user"` / `"assistant"` / `"error"`

### agentRun.process に含まれるイベント

SSE で流れるイベント（`config`・`delta`・`step`・`browse-*`・`plan*`・
`report-structure-*`・`matrix-*`・`source-summary-*`・`graph-*` など）が
**全部永続化されて入っている**。SSE を途中で切った場合でも、この配列から
ブラウズ手順・ツール呼び出し・プラン/レポート/マトリクスドラフト・参照ソース・
グラフ抽出結果などを後から回収できる。

### 特定 runId の取得パターン

直接 runId 指定で取るエンドポイントは未提供。降順でページングして探す:

```python
import requests

BASE = "https://app.snorbe.deskrex.ai/api/v1/turn/list"
HEADERS = {"Authorization": "Bearer snorbe_YOUR_KEY"}
TARGET_RUN_ID = "cmo6zqh5g000os601l438gqh3"

cursor = None
while True:
    params = {"limit": 50}
    if cursor:
        params["cursor"] = cursor
    data = requests.get(BASE, params=params, headers=HEADERS).json()
    for turn in data["turns"]:
        run = turn.get("agentRun")
        if run and run["id"] == TARGET_RUN_ID:
            print(run["process"])  # 全イベント
            break
    cursor = data.get("nextCursor")
    if not cursor:
        break
```

### 全件取得パターン

```typescript
const baseUrl = "https://app.snorbe.deskrex.ai/api/v1/turn/list";
const headers = { Authorization: "Bearer snorbe_YOUR_KEY" };
let cursor: string | undefined;

do {
  const url = cursor
    ? `${baseUrl}?limit=50&cursor=${cursor}`
    : `${baseUrl}?limit=50`;
  const resp = await fetch(url, { headers });
  const data = await resp.json();
  for (const turn of data.turns) {
    console.log(`[${turn.kind}] ${turn.content.slice(0, 80)}`);
  }
  cursor = data.nextCursor ?? undefined;
} while (cursor);
```

```python
import requests

base_url = "https://app.snorbe.deskrex.ai/api/v1/turn/list"
headers = {"Authorization": "Bearer snorbe_YOUR_KEY"}
cursor = None

while True:
    params = {"limit": 50}
    if cursor:
        params["cursor"] = cursor
    resp = requests.get(base_url, params=params, headers=headers)
    data = resp.json()
    for turn in data["turns"]:
        print(f"[{turn['kind']}] {turn['content'][:80]}")
    cursor = data.get("nextCursor")
    if not cursor:
        break
```
