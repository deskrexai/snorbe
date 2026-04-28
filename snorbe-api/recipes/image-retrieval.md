# 画像データの取得と活用

## 概要

エージェント実行の結果には、自動収集された画像情報が含まれる。Web 検索の画像 SERP・スキル（Tool）の成果物ファイル・ソース要約の bodyLinks に含まれる画像が、重複排除されて flat 配列で返される。

## どのエンドポイントが画像を返すか

### `GET /turn/list` — 複数ラン横断で画像を取得

実行履歴から直近 N 件のラン結果を取得し、各ラン内の画像をまとめて回収:

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/turn/list?limit=20" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

レスポンス:

```json
{
  "turns": [
    {
      "id": "turn_xxx001",
      "agentRun": {
        "id": "run_xxx001",
        "images": [
          {
            "imageUrl": "https://example.com/img1.jpg",
            "thumbnailUrl": "https://example.com/img1_thumb.jpg",
            "title": "Battery Technology 2024",
            "link": "https://example.com/article"
          },
          {
            "imageUrl": "https://cdn.example.com/battery-chart.png",
            "title": "Lithium-ion vs Solid-state"
          }
        ]
      }
    }
  ]
}
```

### `GET /agent/run/{runId}` — 特定ランの詳細取得

runId を指定して、そのラン専用の画像と詳細データを取得:

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/agent/run/{runId}" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

レスポンス:

```json
{
  "id": "run_xxx001",
  "status": "completed",
  "agentId": "agent_xxx001",
  "agentName": "Default Agent",
  "createdAt": "2026-04-01T00:00:00.000Z",
  "updatedAt": "2026-04-01T00:05:00.000Z",
  "process": [ ... ],
  "images": [
    {
      "imageUrl": "https://example.com/img1.jpg",
      "thumbnailUrl": "https://example.com/img1_thumb.jpg",
      "title": "Battery specifications",
      "link": "https://example.com/spec-page"
    }
  ],
  "linkedSources": [ ... ],
  "linkedEntityIds": [ ... ],
  "linkedEntities": [ ... ]
}
```

## `SearchImageItem` 型

各画像オブジェクトの構造:

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `imageUrl` | string | 画像の本体 URL（外部サーバー） |
| `thumbnailUrl` | string \| undefined | サムネイル URL（オプション） |
| `title` | string \| undefined | 画像のタイトルやキャプション（オプション） |
| `link` | string \| undefined | 画像が掲載されていたページの URL（オプション） |

## 画像の出所（5経路）

返された flat 配列内の画像は、以下のいずれかの経路から抽出されている。**レスポンスには出所情報は含まれない** ため、必要に応じて `process` イベントを手動で辿る:

1. **`search-image-results` イベント** — Web 検索の画像 SERP 結果
2. **`skill-complete.outputFiles`** — スキル実行の成果物ファイル（`mimeType: image/*`）
3. **`search-summary-complete.bodyLinks`** — Web 検索後の サマリーに含まれるリンク（`type: "image"`）
4. **`source-summary-complete.results[].bodyLinks`** — ソース要約結果に含まれるリンク（`type: "image"`）
5. **`rag-context-complete.sources[].bodyLinks`** — recall（RAG）でヒットしたソースの bodyLinks（chunk 位置に応じて 1 ソース最大 6 件 pick・URL 重複排除済み）

## 典型的なワークフロー

### 例 1: リサーチ実行直後に画像を取得

```bash
# 1. エージェント実行（SSE）
curl -N -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/stream" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
  -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{
    "modelName": "snorbe-fast",
    "inputText": "太陽電池の最新技術を調査して、図解もあれば集めて",
    "promptKey": "chat-routing",
    "locale": "ja"
  }' | grep -oP '"runId":"[^"]*"' | head -1

# 上記で runId=run_xxxyyy を取得したら
# 2. ラン詳細から画像を取得
curl "https://app.snorbe.deskrex.ai/api/v1/agent/run/run_xxxyyy" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" | jq '.images[]'
```

### 例 2: Python で画像 URL リストを抽出

```python
import requests
import json

API_KEY = "snorbe_YOUR_KEY"
BASE = "https://app.snorbe.deskrex.ai/api/v1"

# リサーチ実行
run_data = requests.post(
    f"{BASE}/agent/run",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={
        "modelName": "snorbe-fast",
        "inputText": "太陽電池技術の比較画像を集めて",
        "promptKey": "chat-routing",
        "locale": "ja",
    },
    timeout=300,
).json()

run_id = run_data["id"]

# 画像データを取得
detailed = requests.get(
    f"{BASE}/agent/run/{run_id}",
    headers={"Authorization": f"Bearer {API_KEY}"},
).json()

# 画像 URL リストを抽出
for img in detailed.get("images", []):
    print(f"URL: {img['imageUrl']}")
    if img.get("title"):
        print(f"  Title: {img['title']}")
    if img.get("link"):
        print(f"  Link: {img['link']}")
    print()
```

## 注意点

### 外部 URL の失効リスク

- `imageUrl` は外部サーバー起源で**署名付き URL ではない**。時間経過で 404 になりうる
- スキル成果物の `outputFiles[].signedUrl` は **短期失効**（参照後は速やかに利用すること）
- 重要な画像は **速やかにダウンロードしてローカル保存** することを推奨

### 画像の出所確認が必要な場合

どのツール・イベントから由来したのかを特定する場合は、`GET /agent/run/{runId}` の `process` イベント群を辿る:

```python
detailed = requests.get(
    f"{BASE}/agent/run/{run_id}",
    headers={"Authorization": f"Bearer {API_KEY}"},
).json()

# process から画像関連イベントを拾う
for event in detailed.get("process", []):
    if event["type"] == "search-image-results":
        for img in event.get("images", []):
            print(f"Search Image: {img.get('imageUrl')}")
    elif event["type"] == "skill-complete":
        for f in event.get("outputFiles", []):
            if "image" in f.get("mimeType", "").lower():
                print(f"Skill output: {f['signedUrl']}")
```

## 複数ラン横断での画像集約

複数実行の結果を一度に集約する場合は `/turn/list` を活用:

```python
import requests

API_KEY = "snorbe_YOUR_KEY"
BASE = "https://app.snorbe.deskrex.ai/api/v1"

resp = requests.get(
    f"{BASE}/turn/list?limit=50",
    headers={"Authorization": f"Bearer {API_KEY}"},
)
data = resp.json()

all_images = []
for turn in data["turns"]:
    run = turn.get("agentRun")
    if run:
        all_images.extend(run.get("images", []))

print(f"Total images: {len(all_images)}")
for img in all_images:
    print(f"- {img['imageUrl']}")
```
