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
