# エージェント実行結果のエクスポート

## ユースケース

エージェント実行を完了した後、結果を Markdown・PDF・JSON 形式でダウンロードまたは取得したい場合のワークフロー。UI のコピー/PDF ボタンと同じカスタマイズ性を API で実現。

---

## ステップ 1: エージェントを実行

まずエージェントを実行して `runId` を取得。以下は SSE ストリーミング例:

```python
import requests
import json

API_KEY = "snorbe_YOUR_KEY"
BASE = "https://app.snorbe.deskrex.ai/api/v1"

# SSE で実行
resp = requests.post(
    f"{BASE}/agent/run/stream",
    headers={
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    },
    json={
        "modelName": "snorbe-quality",
        "inputText": "電池技術の最新トレンドを調査して",
        "promptKey": "chat-routing",
        "locale": "ja",
    },
    stream=True,
    timeout=600,
)

run_id = None
for line in resp.iter_lines(decode_unicode=True):
    if not line or not line.startswith("data: "):
        continue
    event = json.loads(line[6:])
    
    if event.get("type") == "config":
        run_id = event["payload"]["runId"]
        print(f"Run started: {run_id}")
    elif event.get("type") == "complete":
        print(f"Run completed: {event['payload']['status']}")
        break
    elif event.get("type") == "error":
        print(f"Error: {event['payload']['message']}")
        break
```

## ステップ 2: ストリーミング完了後、export を呼び出す

実行完了後（`complete` イベントを確認後）、`runId` を使って export エンドポイントを呼ぶ。

### 例 1: Markdown ダウンロード（response + report のみ）

```bash
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/{runId}/export" \
  -H "Authorization: Bearer $SNORBE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "format": "md",
    "selections": {
      "response": true,
      "plan": false,
      "process": false,
      "sourceTitles": true,
      "sourceSummaries": false,
      "sourceBodies": false,
      "reportStructure": false,
      "report": true,
      "reportSections": true,
      "reportCitations": true,
      "images": false,
      "domainStatistics": false
    },
    "locale": "ja",
    "filename": "調査結果"
  }' \
  -o 調査結果.md
```

**含まれるもの:**
- エージェントの最終回答（`response`）
- レポート全体（`report` + `reportSections` + `reportCitations`）
- ソースのタイトルのみ（`sourceTitles`）

**含まれないもの:**
- ブラウズ手順などの処理タイムライン
- ソース本文
- 画像

### 例 2: PDF ダウンロード（全選択、日本語）

```bash
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/{runId}/export" \
  -H "Authorization: Bearer $SNORBE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "format": "pdf",
    "selections": {
      "response": true,
      "plan": true,
      "process": true,
      "sourceTitles": true,
      "sourceSummaries": true,
      "sourceBodies": true,
      "reportStructure": true,
      "report": true,
      "reportSections": true,
      "reportCitations": true,
      "images": true,
      "domainStatistics": true
    },
    "locale": "ja"
  }' \
  -o result.pdf
```

**含まれるもの:**
- すべて（実行プラン、最終回答、レポート全体、ソース、画像、統計）

**注意:** PDF は画像を Base64 埋め込みするためレスポンスが **1.5〜3 倍遅い** 場合がある。大量画像を含める場合は Markdown または JSON を検討。

### 例 3: JSON 取得（LLM 後段処理用）

```python
import requests
import json

runId = "clxxx001"
apiKey = "snorbe_YOUR_KEY"

resp = requests.post(
    f"https://app.snorbe.deskrex.ai/api/v1/agent/run/{runId}/export",
    headers={
        "Authorization": f"Bearer {apiKey}",
        "Content-Type": "application/json",
    },
    json={
        "format": "json",
        "selections": {
            "response": True,
            "report": True,
            "reportSections": True,
            "sources": True,
            "images": False,
            "domainStatistics": True,
        },
        "locale": "en",
    },
)

data = resp.json()
markdown = data["markdown"]
sources = data["sources"]
stats = data["domainStatistics"]

print("Markdown content:")
print(markdown[:500])  # 最初の500文字
print(f"\nFound {len(sources)} sources")
print(f"Total entities: {stats.get('totalEntities', 0)}")

# 後段の LLM に markdown を処理させる
# llm_response = await llm.process(markdown)
```

## ステップ 3: 落とし穴と回避方法

### ❌ run が `completed` になる前に export を叩く

```python
# Bad: complete イベントを待たずにいきなり export
run_id = event["payload"]["runId"]  # config イベントから
resp = requests.post(f"{BASE}/agent/run/{run_id}/export", ...)
```

**問題**: データが不完全（process イベントが DB に書き込まれていない）→ 出力がスカスカ

**正解**:

```python
# Good: complete イベントを確認してから export
if event.get("type") == "complete":
    run_id = event["payload"]["runId"]
    time.sleep(1)  # 念のため1秒待機（DB flush 待ち）
    # ここで export を呼ぶ
```

### ❌ selections を空オブジェクトで呼ぶ

```python
# Bad: 空の selections
resp = requests.post(
    f"{BASE}/agent/run/{runId}/export",
    json={
        "format": "md",
        "selections": {},  # ← 何も含まれない
    }
)
```

**問題**: エクスポート結果は空（あるいは最小限のみ）

**正解**: 必ず 1 つ以上のキーを `true` に設定

```python
# Good: 最低限 response は含める
"selections": {
    "response": True,
    "report": True,
}
```

### ❌ selections で指定したキーがドラフト状態のまま

run が `pendingReportDraft: true` など HITL ペンディング中に export を呼んだ場合、draft 情報は返されない。

**正解**: プラン / レポート / マトリクスをすべて confirm してから export

```bash
# HITL フロー（run 完了前）
curl -X POST "{BASE}/agent/run/{runId}/report/answer" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "runId": "{runId}",
    "answer": "追加調査要望..."
  }'

curl -X POST "{BASE}/agent/run/{runId}/report/confirm" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"runId": "{runId}"}'

# レジューム
curl -N -X POST "{BASE}/agent/run/stream/{runId}" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"modelName":"snorbe-quality","locale":"ja"}'

# 完了後に export
curl -X POST "{BASE}/agent/run/{runId}/export" ...
```

---

## バリエーション

### A. 複数フォーマットを順次取得

同じ `runId` に対して複数回 export を呼ぶことで、異なるフォーマットを取得可能:

```python
run_id = "clxxx001"

# Markdown で取得
resp_md = requests.post(f"{BASE}/agent/run/{run_id}/export", 
    json={"format": "md", "selections": {...}, "locale": "ja"})
md_content = await resp_md.text()

# JSON で取得
resp_json = requests.post(f"{BASE}/agent/run/{run_id}/export", 
    json={"format": "json", "selections": {...}, "locale": "en"})
json_data = resp_json.json()
```

### B. 個別レポートセクションのみを抽出

レポートが複数セクションを持つ場合、動的キーで個別抽出:

```python
resp = requests.post(f"{BASE}/agent/run/{run_id}/export",
    json={
        "format": "md",
        "selections": {
            "report_section:section_1": True,  # section_1 のみ
            "report_section:section_2": False,  # section_2 は除外
        },
        "locale": "ja"
    }
)
```

### C. 定期エクスポート（バッチ）

複数の run ID をまとめてエクスポート:

```python
run_ids = ["clxxx001", "clxxx002", "clxxx003"]

for rid in run_ids:
    resp = requests.post(f"{BASE}/agent/run/{rid}/export",
        json={
            "format": "pdf",
            "selections": {
                "response": True,
                "report": True,
                "images": True,
            },
            "locale": "ja",
            "filename": f"report-{rid}"
        }
    )
    
    if resp.ok:
        filename = resp.headers.get("content-disposition").split("filename=")[1]
        with open(filename, "wb") as f:
            f.write(resp.content)
        print(f"Saved: {filename}")
    else:
        print(f"Failed for {rid}: {resp.status_code}")
```

---

## レート制限と注意事項

- **レート制限**: API キーごと **100 req/min**
- **タイムアウト**: `format=pdf` は Markdown より遅い（1.5〜3 倍）→ client timeout を **30 秒以上** に設定
- **ファイル名**: 自動生成 or 明示指定。`.md`/`.pdf` 拡張子は自動補完

詳細は [reference/agent-export.md](../reference/agent-export.md) を参照。
