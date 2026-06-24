# SSE ストリーミング実行と HITL

## トランスポート — Web UI (snorbe-app) と CLI / REST API の対応

snorbe-app の Web UI から起動するエージェントも、本 REST API から起動するエージェントも、**サーバー内部の実行関数 (`createAgentRunStream` / `createResumeAgentRunStream`) は完全に同一**。違いはトランスポート層と認証だけで、ビジネスロジック・HITL ルール・cancel-and-replace の挙動・`modelName` 必須・タイムアウト（30 分 idle で `failed`）はすべて共通する。

| 観点 | Web UI (snorbe-app) | CLI / 外部 REST API |
|------|---------------------|--------------------|
| 認証 | NextAuth セッション | Bearer API key |
| トランスポート | tRPC + JSONL streaming（`httpBatchStreamLink`, `trpc-accept: application/jsonl`） | REST + SSE（`text/event-stream`） |
| 起動エンドポイント | `agentRun.stream` (tRPC mutation) | `POST /api/v1/agent/run/stream` |
| 同期実行 | `agentRun.execute` | `POST /api/v1/agent/run` |
| resume | `agentRun.resumeStream` | `POST /api/v1/agent/run/stream/{runId}` |
| HITL confirm | tRPC `agentRun.confirmPlan` 等 | `POST /api/v1/agent/run/{runId}/{type}/confirm` |
| `entryPoint` | `"ui"` | `"external_api"` |
| HITL `*-draft-complete` 後の挙動 | クライアントが自動で resume を購読し直す | 呼び出し側が明示的に `/agent/run/stream/{runId}` を POST する必要がある |
| ストリーム終端の意味 | 同じ（HITL draft 完成または `complete` で終わる） | 同じ |

**示唆**:
- Web UI で発生するバグは CLI でも再現しうるし、その逆も成り立つ
- 「confirm 後 30 分 idle で `failed` 落ち」も両者共通の現象（[runtime-gotchas.md#️-planconfirm-後の-resume-忘れでも同じ30分で-failed事故が起きる](../runtime-gotchas.md) 参照）
- 認証経路が違うため、API key の権限制御は別経路でかかるが、エージェント本体の挙動は同じ

REST 互換レイヤーの実装根拠: `src/app/api/v1/agent/run/stream/route.ts` のヘッダコメント（trpc-to-openapi が streaming をサポートしないため REST 用の互換ルートを別途用意している）。

---

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
| ビジュアルマップ（HITL） | `visual_map_structure_draft_delta`・`visual_map_structure_draft_complete`・`visual_map_structure_confirmed`・`visual_map_structure_rejected`・`visual_map_metadata_filling_delta`・`visual_map_metadata_filled_per_entity`・`visual-map-data-completed` |
| ソース要約 | `source-summary-start`・`source-summary-delta`・`source-summary-item`・`source-summary-complete` |
| グラフ抽出 | `graph-start`・`graph`・`graph-extraction-entity-delta` |

> **完了後の取得**: SSE が途中で切れた場合や後追いで詳細を取得したい場合は、
> [`/turn/list`](turn.md) を使う。`turns[].agentRun.process` に上記イベントの
> 永続化タイムラインが、`publicSourceAgentRuns` / `privateSourceAgentRuns` に
> 参照ソースが入っている（直接 runId 指定の取得エンドポイントは未提供なので、
> `/turn/list` をページングして該当 runId を探す）。

### レジューム

```
POST /api/v1/agent/run/stream/{runId}
```

HITL 確認後にレジュームする際に使用。同じ SSE イベントが流れる。

**⚠️ body は必須**: 空 body (`-d ''`) は `{"error":"Invalid JSON body"}`、空オブジェクト (`-d '{}'`) は `{"error":"Invalid option: expected one of snorbe-fast|snorbe-medium|snorbe-quality|…"}` となり、起動しない。**`modelName` / `promptKey` / `locale` の3点を原 run と同じ値で投げる**のが確実:

```bash
curl -N -s -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/stream/$RUN_ID" \
  -H "Authorization: Bearer $SNORBE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  --max-time 1800 \
  -d '{"modelName":"snorbe-quality","promptKey":"chat-routing","locale":"ja"}'
```

**⚠️ resume は無条件に安全ではない。** SSE が切れても即座に再POST せず、必ず `GET /agent/run/{runId}/status` で状態を確認してから1回だけ POST する。

| `status` 値 | resume を叩いてよいか |
|---|---|
| `running` | **叩かない**。実行中の処理を中断させる（cancel-and-replace） |
| `pending` / `pendingPlanDraft:true` 等 | confirm/answer の後に1回だけ叩く |
| `completed` | resume 不要。`/turn/list` で結果を回収 |
| `error` | 原因確認後に再投入 |

**1 run に対して resume を同時並行で複数発行しない**（1 run 1 resume）。サーバは新しい resume が来ると進行中の旧実行を中断して差し替える（cancel-and-replace）。また、クライアントが切断した時点でその resume 実行は abort される。

`GET /agent/run/{runId}/status` が `pending*Draft: true` の場合は confirm → resume の手順を踏む（[runtime-gotchas.md#resume-多重起動を防ぐ手順重要](../runtime-gotchas.md#resume-多重起動を防ぐ手順重要) 参照）。

レジューム後は SSE が `run-start` / `step` / `rag-*` / `delta` / `complete` の順に再び流れる（step index が途中再生されることがある点に注意）。

### Agent 間メンション連鎖

`mentions` に他 Agent を含めた場合の挙動は `/agent/run`（非ストリーミング）と同じ:

- 1 体指名: primary 完了後、最終メッセージを入力として child の AgentRun が spawn
- 2 体以上: サーバ側 classifier が parallel / chain を判定
- `maxChainSteps`（1-50、default 10）で再帰深さを制限

ストリーミング特有の注意: **親 run の SSE `complete` イベントが流れた後に child run が起動する**。child 側のイベントは別の SSE ストリームで流れるわけではない。child の出力を追いたい場合は、`complete` 後に `/turn/list` または child の `runId` を使って個別に状態取得する。

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

### ビジュアルマップ確認フロー

```
1. ステータス確認 → pendingVisualMapDraft: true
2. 質問に回答: POST /agent/run/{runId}/visual-map/answer
3. ビジュアルマップ確定: POST /agent/run/{runId}/visual-map/confirm
```

`/visualmap` で起動した axis-map 構築フロー。 stage-1 LLM が 軸割り当て / 対象エンティティ / レイアウトを draft として提案 → 確定後に stage-2 LLM が各エンティティのメタデータを抽出して GraphView を保存する。 SSE では `visual_map_structure_draft_delta` → `visual_map_structure_draft_complete` （HITL ゲート） → confirm 後に `visual_map_structure_confirmed` → `visual_map_metadata_filling_delta` （per-entity × per-axis） → `visual_map_metadata_filled_per_entity` → `visual-map-data-completed` の順に流れる。

### HITL 共通パターン

状態ごとの操作:

| 状態 | 修正・回答 | 確定 | レジューム |
|---|---|---|---|
| `pendingPlanDraft: true` | `POST /agent/run/{runId}/plan/answer` | `POST /agent/run/{runId}/plan/confirm` または `POST /agent/run/{runId}/plan/skip` | `POST /agent/run/stream/{runId}` |
| `pendingReportDraft: true` | `POST /agent/run/{runId}/report/answer` | `POST /agent/run/{runId}/report/confirm` | `POST /agent/run/stream/{runId}` |
| `pendingMatrixDraft: true` | `POST /agent/run/{runId}/matrix/answer` | `POST /agent/run/{runId}/matrix/confirm` | `POST /agent/run/stream/{runId}` |
| `pendingVisualMapDraft: true` | `POST /agent/run/{runId}/visual-map/answer` | `POST /agent/run/{runId}/visual-map/confirm` | `POST /agent/run/stream/{runId}` |
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

`/answer` のボディは plan / report / matrix / visual-map で共通:

```json
{
  "runId": "clxxx001",
  "answer": "ドラフトに追加・修正してほしい内容を書く",
  "modelName": "gpt-5-mini-2025-08-07",
  "fileUrls": ["https://example.com/reference.pdf"]
}
```

**⚠️ `modelName` は必須**。欠落すると 400 で 150 個以上の有効 model 名を列挙する超長文 validation error が返る。**多くのクライアント実装はこのエラーを見逃して `/confirm` に進んでしまい、agent は HITL 回答待ちのまま30 分後に静かに `status: failed` に落ちる**（`/agent/run/{runId}` を取得しても `error` は空）。`modelName` は **`/agent/run/stream` で起動した原 run と同じ値**を使うのが確実。詳細と検知方法は [runtime-gotchas.md#️-answer-の-modelname-欠落で-run-が静かに-failed-になる事故](../runtime-gotchas.md) 参照。

成功時は `200 OK` で `{"message":"計画を改善しました（X回目の更新）。新しい質問に回答してください。","status":"drafting"}` が返る。**レスポンス body の `status` が `drafting` または `confirmed` であることを必ず確認してから次のステップに進む**こと。

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
