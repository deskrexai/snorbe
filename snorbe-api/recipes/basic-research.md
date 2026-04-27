# 基本的なリサーチ実行フロー

## なぜ SSE ストリーミングを第一推奨にするか

`/agent/run`（非ストリーミング）は **同期エンドポイント** で、`executeAgentRun` が
LLM 推論 + ツール実行 + RAG + グラフ抽出を完了するまで HTTP コネクションを保持する。
通常のエージェント実行は **10秒〜数分** かかるため、多くの HTTP クライアントで
デフォルトタイムアウト（30〜120秒）に抵触し接続が切れる。

切断されても **サーバー側は最後まで走り切る**（結果は `/turn/list` に残る）が、
呼び出し元には何も返らない。これを避けるため、**最初から SSE を使う** のが確実。

---

## 1. 事前確認

```bash
# ワークスペース確認
curl "https://app.snorbe.deskrex.ai/api/v1/workspace" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"

# エージェント一覧確認（カスタムエージェントを使う場合）
curl "https://app.snorbe.deskrex.ai/api/v1/agent/list" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

## 2. SSE ストリーミングでリサーチ実行（第一推奨）

最初のイベントで即 `runId` が返り、以降 `delta`/`step`/`complete` が逐次届く。
ネットワーク切断時は `runId` で再接続できる。

```python
import requests
import json

API_KEY = "snorbe_YOUR_KEY"
BASE = "https://app.snorbe.deskrex.ai/api/v1"

resp = requests.post(
    f"{BASE}/agent/run/stream",
    headers={
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    },
    json={
        "modelName": "gpt-5-mini-2025-08-07",
        "inputText": "電池技術の最新動向を調査して",
        "promptKey": "chat-routing",
        "locale": "ja",
        "maxBrowsingSteps": 10,  # ブラウジングする場合
    },
    stream=True,
    timeout=600,  # 全体は長めに。SSEなので読み取りは逐次
)

run_id = None
full_text = ""
for line in resp.iter_lines(decode_unicode=True):
    if not line or not line.startswith("data: "):
        continue
    event = json.loads(line[6:])
    etype = event.get("type")
    payload = event.get("payload", {})

    if etype == "config":
        run_id = payload.get("runId")
        print(f"\n=== Run ID: {run_id} ===\n")
    elif etype == "delta":
        print(payload.get("deltaText", ""), end="", flush=True)
    elif etype == "browse-start":
        print(f"\n[browse開始]")
    elif etype == "browse-step":
        print(f"\n[browse: {payload.get('action')}]")
    elif etype == "step":
        print(f"\n[Step] status={payload.get('status')}")
    elif etype == "complete":
        full_text = payload.get("text", "")
        print(f"\n\n=== Complete: {payload.get('status')} ===")
        break
    elif etype == "error":
        print(f"\nERROR: {payload.get('message')}")
        break
```

## 3. 切断時のレジューム

SSE が切断された場合、runId で再接続:

```bash
curl -N -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/stream/{runId}" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"modelName": "gpt-5-mini-2025-08-07"}'
```

## 4. HITL（プラン/レポート/マトリクス確認）

SSE 中に `step` イベントで `pendingPlanDraft: true` 等を検知したら対応エンドポイントへ:

```bash
# プランに回答
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/{runId}/plan/answer" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "runId": "{runId}",
    "answer": "競合比較と市場規模の確認も追加してください",
    "modelName": "gpt-5-mini-2025-08-07"
  }'

# プラン確定
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/{runId}/plan/confirm" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"runId": "{runId}"}'

# 再開
curl -N -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/stream/{runId}" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
  -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"modelName": "gpt-5-mini-2025-08-07"}'
```

Report は `/report/answer` → `/report/confirm`、Matrix は `/matrix/answer` → `/matrix/confirm` を使う。

---

## 非ストリーミング実行（単純なクエリのみ）

挨拶・要約など **ツール使用が明らかに無い短いクエリ** なら非ストリーミングでもOK。
ただし `timeout` を最低 **300秒** に設定すること。

```python
resp = requests.post(
    f"{BASE}/agent/run",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={
        "modelName": "gpt-5-mini-2025-08-07",
        "inputText": "ひとことで挨拶して",
        "promptKey": "chat-routing",
        "locale": "ja",
    },
    timeout=300,
)
data = resp.json()
print(data["text"])
```

## ラン完了後の詳細取得（`/turn/list`）

`/turn/list` は**ラン後の詳細データを取得する主要エンドポイント**。
`turns[].agentRun` に以下が丸ごと含まれる:

- `process` — ブラウズ手順・ツール呼び出し・プラン/レポート/マトリクスドラフト・
  グラフ抽出・ソース要約など、SSE で流れた **全イベントの永続化タイムライン**
- `publicSourceAgentRuns` / `privateSourceAgentRuns` — エージェントが参照した
  URL ソース（`bodyLinks` で構造化された内部リンク情報も含む）
- `status` / `agent` など

```python
import requests

BASE = "https://app.snorbe.deskrex.ai/api/v1"
HEADERS = {"Authorization": "Bearer snorbe_YOUR_KEY"}

# 直近のランを取得
resp = requests.get(f"{BASE}/turn/list?limit=20", headers=HEADERS)
data = resp.json()

for turn in data["turns"]:
    run = turn.get("agentRun")
    if not run or run["status"] != "completed":
        continue
    print(f"runId={run['id']}")
    print(f"  本文: {turn['content'][:80]}")
    # process から browse-step だけ拾う
    for ev in run["process"]:
        if ev.get("type") == "browse-step":
            print(f"  browse: {ev.get('action')}")
    # 参照ソース
    for s in run.get("publicSourceAgentRuns", []):
        print(f"  source: {s['publicSource']['url']}")
```

特定 `runId` を狙い撃ちしたい場合は `/turn/list` を **降順でページング** して
`turns[].agentRun.id === 目的のrunId` で探す（runId 直接取得のエンドポイントは未提供）。

### 軽量版: ステータスのみ

途中経過のフラグ（`pendingPlanDraft` 等）だけ欲しい場合は `/agent/run/{runId}/status`:

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/agent/run/{runId}/status" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

これは `process` を含まないので軽量。本文や詳細が必要なら `/turn/list` を使う。

## ステータスポーリング（runIdがある場合）

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/agent/run/{runId}/status" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

`status` が `completed` になるまでポーリング。`pending*Draft` が `true` になったら HITL フローへ。
