# エージェント実行結果のエクスポート（MD/PDF/JSON）

## POST /agent/run/{runId}/export

エージェント実行の最終結果を Markdown・PDF・JSON 形式でエクスポート。UI のコピー機能と完全に同じカスタマイズ性を提供し、どの情報を含めるかをきめ細かく選択可能。

### リクエスト

```bash
# Markdown（response + report のみ）
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/clxxx001/export" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
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
    "locale": "en",
    "filename": "research-result"
  }'

# PDF（全部選択、日本語）
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/clxxx001/export" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
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
    "locale": "ja",
    "filename": "完全な調査結果"
  }'

# JSON（LLM 後段処理用）
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/clxxx001/export" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "format": "json",
    "selections": {
      "response": true,
      "report": true,
      "images": true,
      "domainStatistics": false
    },
    "locale": "en"
  }'
```

### パラメータ

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| `format` | `"md" \| "pdf" \| "json"` | はい | 出力形式。`md` は `text/markdown`、`pdf` は `application/pdf`、`json` は構造化 JSON |
| `selections` | `Record<string, boolean>` | はい | 出力に含める情報を指定（下記参照） |
| `locale` | `"ja" \| "en"` | いいえ | 言語（デフォルト `"en"`）。日本語は `"ja"` |
| `filename` | `string \| null` | いいえ | ダウンロード時のファイル名（1-200 文字）。`.md`/`.pdf` 拡張子は自動補完。省略時は ISO タイムスタンプ |

### selections パラメータ（詳細）

#### 静的キー（すべての形式で利用可）

| キー | 説明 |
|------|------|
| `response` | エージェントの最終回答テキスト |
| `plan` | エージェント実行前に生成されたプラン（存在する場合） |
| `process` | ブラウズ手順・ツール呼び出し・RAG 検索など、処理タイムラインの要約 |
| `sourceTitles` | 参照ソースのタイトル一覧のみ |
| `sourceSummaries` | 参照ソースの要約テキスト |
| `sourceBodies` | 参照ソースの本文（構造化リンク `bodyLinks` を含む） |
| `reportStructure` | レポートドラフトの構造定義（見出し・セクション配置） |
| `report` | 確定後のレポート本文全体 |
| `reportSections` | レポート各セクションの詳細（見出し付き） |
| `reportCitations` | レポート内の引用・参照情報 |
| `images` | 処理中に収集した画像（SERP・スキル出力・ソース画像）の URL リスト |
| `domainStatistics` | ドメイン統計（エンティティ抽出、関係グラフ統計） |

#### 動的キー（個別レポートセクション指定）

レポートが複数セクション（`reportStructure` で定義）を持つ場合、セクション ID で個別選択可:

```json
{
  "selections": {
    "response": true,
    "report": true,
    "report_section:section_1": true,
    "report_section:section_2": false,
    "report_section:section_3": true
  }
}
```

キーは `"report_section:{sectionId}"` 形式。`report: true` を指定した場合、対応する動的キーが全て含まれた全体レポートが返される。個別キーは特定セクションのみを抽出したい場合に使用。

### レスポンス

#### `format=md` (200 OK)

```
Content-Type: text/markdown; charset=utf-8
Content-Disposition: attachment; filename="research-result.md"

# 調査テーマ

## 最終回答

実行したエージェントの回答...

## 参照ソース

...
```

ファイル名に `.md` 拡張子がない場合は自動補完される（`filename="result"` → `result.md`）。

#### `format=pdf` (200 OK)

```
Content-Type: application/pdf
Content-Disposition: attachment; filename="research-result.pdf"

<binary PDF data>
```

ファイル名に `.pdf` 拡張子がない場合は自動補完される。

**⚠️ 注意**: PDF は出力形式で埋め込む画像を Base64 エンコードするため、同等の Markdown よりレスポンス時間が **1.5〜3 倍かかる** 場合がある。大量の画像を含める場合は JSON または Markdown の使用を検討。

#### `format=json` (200 OK)

```json
{
  "runId": "clxxx001",
  "agent": {
    "id": "clzzz001",
    "name": "default-agent"
  },
  "locale": "en",
  "createdAtIso": "2026-04-16T10:30:00.000Z",
  "selections": {
    "response": true,
    "report": true,
    "images": true
  },
  "markdown": "# 調査テーマ\n\n## 最終回答\n...",
  "process": [
    { "type": "config", "runId": "clxxx001", "modelName": "...", "inputText": "..." },
    { "type": "browse-start", "websocketInfo": {...} },
    { "type": "browse-step", "action": "navigate", "url": "..." },
    { "type": "delta", "deltaText": "..." }
  ],
  "sources": [
    {
      "id": "src_001",
      "url": "https://example.com",
      "title": "Example Article",
      "summary": "Article about...",
      "bodyLinks": [{ "title": "...", "url": "...", "type": "link" }]
    }
  ],
  "images": [
    {
      "imageUrl": "https://example.com/image.jpg",
      "thumbnailUrl": "https://example.com/thumb.jpg",
      "title": "Image title"
    }
  ],
  "domainStatistics": {
    "totalEntities": 42,
    "totalRelations": 128,
    "topCommunities": [...]
  }
}
```

JSON レスポンスは以下をすべて含む:
- `markdown` — Markdown 形式の最終結果
- `process` — SSE イベントの永続化タイムライン（`selections` で `process: true` の場合）
- `sources` — 参照ソースの詳細
- `images` — 収集した画像
- `domainStatistics` — ドメイン統計

後段で LLM に処理させたい場合は、JSON の `markdown` フィールドを抽出して利用。

### ファイル名仕様

| 指定方法 | 動作 |
|---------|------|
| `filename: null` | デフォルト。`runId` と実行時刻から自動生成（例: `clxxx001-2026-04-16T10-30-00Z.md`） |
| `filename: "result"` | `.md` / `.pdf` 拡張子を自動補完 → `result.md` / `result.pdf` |
| `filename: "result.md"` | 明示的に拡張子を指定 → そのまま `result.md` |
| `filename: "my-research.pdf"` | 明示的に指定 → `my-research.pdf` |

長さ制限は 1〜200 文字。URL エンコード不要（Content-Disposition で自動処理）。

### エラー

| ステータス | コード | メッセージ | 対処 |
|-----------|--------|----------|------|
| 400 | `INVALID_FORMAT` | `format` が `"md"`/`"pdf"`/`"json"` 以外 | format を修正 |
| 400 | `INVALID_SELECTIONS` | `selections` に必須キーが不足 | パラメータ表を確認 |
| 400 | `INVALID_LOCALE` | `locale` が `"ja"`/`"en"` 以外 | locale を修正 |
| 400 | `FILENAME_TOO_LONG` | `filename` が 200 文字を超過 | 短縮する |
| 401 | `UNAUTHORIZED` | API キー不正 | API キーを確認 |
| 403 | `IP_RESTRICTED` | IP が許可リストにない | IP を登録（ワークスペース設定） |
| 404 | `RUN_NOT_FOUND` | `runId` が存在しない / workspace に属さない | runId を確認。`GET /turn/list` で確認可 |
| 429 | `TOO_MANY_REQUESTS` | レート制限超過 | リトライ（100 req/min） |
| 500 | `INTERNAL_ERROR` | サーバー内部エラー | support へ報告 |

### よくある質問

**Q. export を呼ぶのはいつ？**
A. 実行完了後。`GET /agent/run/{runId}/status` が `status: "completed"` になってから呼ぶ。

**Q. run が `pending*Draft` のまま確定していない場合は？**
A. `selections` の `report`/`reportStructure` 等のドラフト情報を指定していても、draft は返されない。必ず確定してから export を呼ぶ。

**Q. 同じ runId で複数フォーマットを取得可能？**
A. はい。`POST /agent/run/{runId}/export` を `format=md` で呼んだ後、同じ runId で `format=pdf` を呼ぶなど何度でも可。

**Q. JSON レスポンスの `markdown` フィールドは UI の表示と一致する？**
A. はい。UI のコピー機能と完全に同じ markdown レンダリングロジックを使用。

---

## TypeScript 実装例

```typescript
const runId = "clxxx001";
const apiKey = "snorbe_YOUR_KEY";

const resp = await fetch(
  `https://app.snorbe.deskrex.ai/api/v1/agent/run/${runId}/export`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      format: "md",
      selections: {
        response: true,
        report: true,
        images: false,
      },
      locale: "en",
      filename: "export",
    }),
  }
);

if (resp.ok) {
  if (resp.headers.get("content-type")?.includes("application/json")) {
    const data = await resp.json();
    console.log(data.markdown);
  } else {
    // Markdown or PDF binary
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = resp.headers.get("content-disposition")?.split("filename=")[1];
    a.click();
  }
} else {
  const error = await resp.json();
  console.error(`Export failed: ${error.message}`);
}
```

## Python 実装例

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
            "sources": True,
            "images": True,
        },
        "locale": "en",
    },
)

if resp.status_code == 200:
    content_type = resp.headers.get("content-type", "")
    
    if "application/json" in content_type:
        data = resp.json()
        print("Markdown output:")
        print(data["markdown"])
        print(f"\nFound {len(data['sources'])} sources")
        print(f"Found {len(data['images'])} images")
    else:
        # Save as file
        filename = resp.headers.get("content-disposition", "").split("filename=")[1]
        with open(filename, "wb") as f:
            f.write(resp.content)
        print(f"Saved as {filename}")
else:
    print(f"Error {resp.status_code}: {resp.text}")
```
