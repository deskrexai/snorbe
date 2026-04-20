# SSE ストリーミング実行と HITL

## POST /agent/run/stream

SSE (Server-Sent Events) でエージェントをストリーミング実行。

### リクエスト

```bash
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/stream" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
    "modelName": "gpt-4o",
    "inputText": "最新のAI動向を調査して",
    "promptKey": "chat-routing",
    "locale": "ja"
  }'
```

### パラメータ

`/agent/run` と同じ。追加パラメータ:

| パラメータ | 型 | 説明 |
|-----------|------|------|
| `matrixEditContext` | `object` | マトリクス編集コンテキスト |
| `matrixContinueContext` | `object` | マトリクス継続コンテキスト |
| `matrixSelectionContent` | `string` | マトリクス選択XML |

### SSE イベント形式

各行は `data: {JSON}\n\n` 形式で送られる。`type` フィールドで種別判定。

```
data: {"type":"config","payload":{"runId":"clxxx001","modelName":"gpt-5-mini-2025-08-07","locale":"ja","inputText":"..."}}

data: {"type":"delta","payload":{"runId":"clxxx001","deltaText":"調査結果を","responseText":"...","stepIndex":0}}

data: {"type":"step","payload":{"runId":"clxxx001","stepIndex":0,"status":"complete","finishReason":"stop"}}

data: {"type":"complete","payload":{"runId":"clxxx001","text":"最終応答","finishReason":"stop","status":"completed"}}
```

**すべての内部イベントがSSEで流れる**（エージェントの処理を余すところなく観察可能）:

| カテゴリ | イベント種別 |
|---|---|
| 基本 | `config`・`delta`・`step`・`complete`・`error` |
| ブラウザ | `browse-start`・`browse-step`・`browse-ask-human`・`browse-final`・`browse-end` |
| プラン（HITL） | `plan`・`plan-draft-delta`・`plan-draft-complete`・`plan-confirmed`・`plan-rejected` |
| レポート（HITL） | `report-structure-draft-delta`・`report-structure-draft-complete`・`report_structure_confirmed`・`report_structure_rejected` |
| マトリクス（HITL） | `matrix-structure-draft-delta`・`matrix-structure-draft-complete`・`matrix-data-preview`・`matrix-data-updated`・`matrix_structure_confirmed`・`matrix_structure_rejected` |
| ソース要約 | `source-summary-start`・`source-summary-delta`・`source-summary-item`・`source-summary-complete` |
| グラフ抽出 | `graph-start`・`graph`・`graph-extraction-entity-delta` |

> **完了後の取得**: SSE が途中で切れた場合や後追いで詳細を取得したい場合は、
> [`/chat/list`](chat.md) を使う。`chats[].agentRun.process` に上記イベントの
> 永続化タイムラインが、`publicSourceAgentRuns` / `privateSourceAgentRuns` に
> 参照ソースが入っている（直接 runId 指定の取得エンドポイントは未提供なので、
> `/chat/list` をページングして該当 runId を探す）。

### レジューム

```
POST /api/v1/agent/run/stream/{runId}
```

HITL 確認後にレジュームする際に使用。同じ SSE イベントが流れる。

### Agent 間メンション連鎖

`mentions` に他 Agent を含めた場合の挙動は `/agent/run`（非ストリーミング）と同じ:

- 1 体指名: primary 完了後、最終メッセージを入力として child の AgentRun が spawn
- 2 体以上: サーバ側 classifier が parallel / chain を判定
- `maxChainSteps`（1-50、default 10）で再帰深さを制限

ストリーミング特有の注意: **親 run の SSE `complete` イベントが流れた後に child run が起動する**。child 側のイベントは別の SSE ストリームで流れるわけではない。child の出力を追いたい場合は、`complete` 後に `/chat/list` または child の `runId` を使って個別に状態取得する。

詳細は [rules/agent-execution.md](agent-execution.md#エージェント委譲メンション) を参照。

---

## HITL（Human-in-the-Loop）ワークフロー

エージェントがプラン・レポート・マトリクスの確認を求めた場合、ステータス取得で `pending*Draft` を確認し、対応するエンドポイントを呼ぶ。

### プラン確認フロー

```
1. ステータス確認 → pendingPlanDraft: true
2. 質問に回答: POST /agent/run/{runId}/plan/answer
3. プラン確定:  POST /agent/run/{runId}/plan/confirm
   またはスキップ: POST /agent/run/{runId}/plan/skip
```

### レポート確認フロー

```
1. ステータス確認 → pendingReportDraft: true
2. 質問に回答: POST /agent/run/{runId}/report/answer
3. レポート確定: POST /agent/run/{runId}/report/confirm
```

### マトリクス確認フロー

```
1. ステータス確認 → pendingMatrixDraft: true
2. 質問に回答: POST /agent/run/{runId}/matrix/answer
3. マトリクス確定: POST /agent/run/{runId}/matrix/confirm
```

### HITL 共通パターン

状態ごとの操作:

| 状態 | 修正・回答 | 確定 | レジューム |
|---|---|---|---|
| `pendingPlanDraft: true` | `POST /agent/run/{runId}/plan/answer` | `POST /agent/run/{runId}/plan/confirm` または `POST /agent/run/{runId}/plan/skip` | `POST /agent/run/stream/{runId}` |
| `pendingReportDraft: true` | `POST /agent/run/{runId}/report/answer` | `POST /agent/run/{runId}/report/confirm` | `POST /agent/run/stream/{runId}` |
| `pendingMatrixDraft: true` | `POST /agent/run/{runId}/matrix/answer` | `POST /agent/run/{runId}/matrix/confirm` | `POST /agent/run/stream/{runId}` |
| `skillState.pendingSecretKeys` あり | 不足キーを `POST /secret` で登録 | 不要 | 通常は不要 |

skill が secret を要求した場合:

```json
{
  "skillState": {
    "isRunningSkill": true,
    "skillName": "patent-search",
    "pendingSecretKeys": ["PATENT_API_KEY"]
  }
}
```

```bash
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/secret" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "PATENT_API_KEY",
    "value": "your-secret-value"
  }'
```

secret 登録は待機中の skill に通知されるため、通常は `/agent/run/stream/{runId}` を呼び直さない。

`/answer` のボディは plan / report / matrix で共通:

```json
{
  "runId": "clxxx001",
  "answer": "ドラフトに追加・修正してほしい内容を書く",
  "modelName": "gpt-5-mini-2025-08-07",
  "fileUrls": ["https://example.com/reference.pdf"]
}
```

`fileUrls` は任意。添付がない場合は省略する。

`/confirm` と `/skip` のボディ:

```json
{
  "runId": "clxxx001"
}
```

`plan/skip` は追加回答なしでプランを確定する操作。Report と Matrix に skip はない。

### TypeScript 実装例

```typescript
const resp = await fetch("https://app.snorbe.deskrex.ai/api/v1/agent/run/stream", {
  method: "POST",
  headers: {
    Authorization: "Bearer snorbe_YOUR_KEY",
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  },
  body: JSON.stringify({
    modelName: "gpt-4o",
    inputText: "調査テーマ",
    promptKey: "chat-routing",
    locale: "ja",
  }),
});

const reader = resp.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = JSON.parse(line.slice(6));
      if (data.text) process.stdout.write(data.text);
    }
  }
}
```

### Python 実装例

```python
import requests
import json

resp = requests.post(
    "https://app.snorbe.deskrex.ai/api/v1/agent/run/stream",
    headers={
        "Authorization": "Bearer snorbe_YOUR_KEY",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    },
    json={
        "modelName": "gpt-4o",
        "inputText": "調査テーマ",
        "promptKey": "chat-routing",
        "locale": "ja",
    },
    stream=True,
)

for line in resp.iter_lines(decode_unicode=True):
    if line and line.startswith("data: "):
        data = json.loads(line[6:])
        if "text" in data:
            print(data["text"], end="", flush=True)
```
