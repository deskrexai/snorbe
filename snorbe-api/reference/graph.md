# グラフデータ・エンティティ・エッジ

## GET /graph/workspace

ワークスペースのグラフ全体を一括取得。PageRank上位のノードとそれに接続するエッジを返す。

### リクエスト

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/graph/workspace?nodeLimit=50&edgeLimit=200" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

### パラメータ

| パラメータ | 型 | デフォルト | 説明 |
|-----------|------|----------|------|
| `includeOthersEntities` | `boolean` | `false` | 他ユーザーのエンティティを含める |
| `nodeLimit` | `integer` | `50` | ノード最大数（1-500） |
| `edgeLimit` | `integer` | `200` | エッジ最大数（1-1000） |

### レスポンス

```json
{
  "nodes": [
    {
      "id": "clxxx001",
      "label": "リチウムイオン電池",
      "category": "Technology",
      "kind": "battery",
      "description": "充電可能な二次電池",
      "communityId": 3,
      "pagerank": 0.045,
      "x": 1.23, "y": -0.45, "z": 0.89
    }
  ],
  "edges": [
    {
      "id": "e001",
      "source": "clxxx001",
      "target": "clxxx002",
      "type": "RELATED_TO",
      "weight": 0.85,
      "edgeType": "undirected"
    }
  ],
  "fetchedAt": "2026-04-16T12:00:00.000Z",
  "nodeCount": 50,
  "edgeCount": 200,
  "totalEntityCount": 1296
}
```

### ユースケース

- **グラフ初期表示**: `nodeLimit=50` でPageRank上位50ノードを表示
- **全体分析**: `nodeLimit=500&edgeLimit=1000` で大量データを取得
- **3D可視化**: `x, y, z` 座標が含まれているのでそのまま3Dレンダリング可能

---

## GET /graph/entities

エンティティをフィルタリング・検索・ページネーション取得。PageRank降順。

### リクエスト

```bash
# 全エンティティ（PageRank順）
curl "https://app.snorbe.deskrex.ai/api/v1/graph/entities?limit=30" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"

# カテゴリでフィルタ
curl "https://app.snorbe.deskrex.ai/api/v1/graph/entities?category=Technology&limit=30" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"

# キーワード検索
curl "https://app.snorbe.deskrex.ai/api/v1/graph/entities?search=battery&limit=10" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"

# コミュニティIDでフィルタ
curl "https://app.snorbe.deskrex.ai/api/v1/graph/entities?communityId=3&limit=30" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

### パラメータ

| パラメータ | 型 | デフォルト | 説明 |
|-----------|------|----------|------|
| `category` | `string` | - | カテゴリ完全一致 |
| `kind` | `string` | - | 種別完全一致 |
| `communityId` | `integer` | - | コミュニティID |
| `search` | `string` | - | ラベル・説明文のキーワード検索 |
| `metadataKeyword` | `string` | - | メタデータ内キーワード検索 |
| `includeOthersEntities` | `boolean` | `false` | 他メンバーのエンティティを含める |
| `limit` | `integer` | `30` | 1ページあたりの件数（1-100） |
| `cursor` | `string` | - | 前ページの `nextCursor` |

### レスポンス

```json
{
  "entities": [
    {
      "id": "clxxx001",
      "label": "リチウムイオン電池",
      "category": "Technology",
      "kind": "battery",
      "description": "充電可能な二次電池の一種",
      "metadata": { "url": { "value": "https://...", "type": "text" } },
      "pagerank": 0.045,
      "communityId": 3,
      "createdAt": "2026-01-15T10:30:00.000Z",
      "updatedAt": "2026-03-20T14:22:00.000Z"
    }
  ],
  "nextCursor": "clxxx031",
  "totalCount": 1296
}
```

### フィルタの組み合わせ

```bash
# カテゴリ + 種別 + キーワード
curl "https://app.snorbe.deskrex.ai/api/v1/graph/entities?category=Technology&kind=battery&search=lithium&limit=20" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

---

## GET /graph/edges

指定エンティティに接続するエッジを取得。

### リクエスト

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/graph/edges?entityIds=claaa001,clbbb001" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

### パラメータ

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| `entityIds` | `string` | はい | エンティティIDのカンマ区切り（1-100個） |
| `type` | `string` | いいえ | リレーションタイプでフィルタ |

### レスポンス

```json
{
  "edges": [
    {
      "id": "clxxx001",
      "sourceEntityId": "claaa001",
      "targetEntityId": "clbbb001",
      "type": "RELATED_TO",
      "weight": 0.85,
      "createdAt": "2026-01-15T10:30:00.000Z",
      "updatedAt": "2026-03-20T14:22:00.000Z"
    }
  ]
}
```

### エラー

| ステータス | コード | 説明 |
|-----------|--------|------|
| 400 | `BAD_REQUEST` | entityIds が空、または101個以上 |

### ユースケース

- **エンティティ詳細表示**: `/graph/entities` で取得したIDを指定して関連エッジを取得
- **関係性分析**: 複数エンティティのIDを指定して、それらの繋がりを可視化
- **タイプ絞り込み**: `type=RELATED_TO` で特定のリレーションタイプのみ取得

---

## GET /graph/entity/{entityId}

エンティティ詳細を取得。リンク先エンティティ、紐づくAgentRun（process全文含む）を返す。

### リクエスト

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/graph/entity/clxxx001" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

### パラメータ

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| `entityId` | `string`（path） | はい | エンティティID |

### レスポンス

```json
{
  "id": "clxxx001",
  "label": "リチウムイオン電池",
  "category": "Technology",
  "kind": "battery",
  "description": "充電可能な二次電池",
  "metadata": { "url": { "value": "https://...", "type": "text" } },
  "pagerank": 0.045,
  "communityId": 3,
  "createdAt": "2026-01-15T10:30:00.000Z",
  "updatedAt": "2026-03-20T14:22:00.000Z",
  "linkedEntities": [
    {
      "id": "clxxx002",
      "label": "ソリッドステート電池",
      "category": "Technology",
      "kind": "battery",
      "description": "固体電解質を使用する電池",
      "edgeType": "RELATED_TO"
    }
  ],
  "agentRuns": [
    {
      "id": "clrun001",
      "status": "completed",
      "process": [
        { "type": "config", "modelName": "gpt-4o", ... },
        { "type": "delta", "text": "..." },
        { "type": "step", "tool": "search", ... }
      ],
      "createdAt": "2026-04-01T09:00:00.000Z"
    }
  ]
}
```

### ユースケース

- **エンティティの深掘り**: 特定エンティティの詳細情報と、どのAgentRunで抽出・参照されたかを確認
- **知識の出所追跡**: `agentRuns[].process` からエンティティ抽出時の検索・要約の経緯を追う
- **関連エンティティの探索**: `linkedEntities` でリンク先のエンティティとリレーションタイプを確認

---

## GET /graph/source/{sourceId}

ソース（Public/Private）の詳細を取得。本文（body）、抽出リンク、紐づくAgentRun・エンティティを返す。

### リクエスト

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/graph/source/clsrc001?sourceType=public" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

### パラメータ

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| `sourceId` | `string`（path） | はい | ソースID |
| `sourceType` | `string`（query） | はい | `"public"` または `"private"` |

### レスポンス

```json
{
  "id": "clsrc001",
  "title": "2026年 バッテリ技術トレンド",
  "url": "https://example.com/battery-trends-2026",
  "body": "本文テキスト全文...",
  "bodyLinks": [
    { "url": "https://example.com/lithium-ion", "title": "リチウムイオン電池の最新動向" },
    { "url": "https://example.com/solid-state", "title": "ソリッドステート電池の展望" }
  ],
  "sourceType": "public",
  "agentRuns": [
    {
      "id": "clrun002",
      "status": "completed",
      "process": [
        { "type": "source-summary-start", ... },
        { "type": "source-summary-complete", ... }
      ],
      "createdAt": "2026-04-10T11:00:00.000Z"
    }
  ],
  "linkedEntities": [
    {
      "id": "clxxx001",
      "label": "リチウムイオン電池",
      "category": "Technology",
      "kind": "battery"
    }
  ],
  "createdAt": "2026-04-10T11:00:00.000Z"
}
```

### ユースケース

- **ソース内容の確認**: AgentRunで参照されたURLの本文全文を取得
- **リンク先の調査**: `bodyLinks` から抽出されたリンク先を確認
- **エンティティ紐付けの確認**: そのソースからどのエンティティが抽出されたかを確認
