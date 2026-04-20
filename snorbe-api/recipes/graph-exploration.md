# グラフの探索とエンティティ分析

## 1. グラフ全体を取得（初期表示用）

PageRank上位のノードとエッジを一括取得:

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/graph/workspace?nodeLimit=50&edgeLimit=200" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

`totalEntityCount` と `nodeCount` を比較して、取得しきれなかったエンティティがあるか確認。

## 2. エンティティの検索・フィルタ

### キーワード検索

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/graph/entities?search=battery&limit=30" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

### カテゴリでフィルタ

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/graph/entities?category=Technology&limit=30" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

### コミュニティ（クラスタ）でフィルタ

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/graph/entities?communityId=3&limit=30" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

### 複合フィルタ

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/graph/entities?category=Technology&kind=battery&search=lithium&limit=20" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

## 3. 全エンティティのページネーション取得

```typescript
const BASE = "https://app.snorbe.deskrex.ai/api/v1/graph/entities";
const headers = { Authorization: "Bearer snorbe_YOUR_KEY" };
let cursor: string | undefined;
const allEntities: Entity[] = [];

do {
  const params = new URLSearchParams({ limit: "100" });
  if (cursor) params.set("cursor", cursor);
  const resp = await fetch(`${BASE}?${params}`, { headers });
  const data = await resp.json();
  allEntities.push(...data.entities);
  console.log(`Fetched ${allEntities.length} / ${data.totalCount}`);
  cursor = data.nextCursor ?? undefined;
} while (cursor);
```

## 4. エッジ（関係性）の取得

エンティティIDを指定して、繋がりを取得:

```bash
# 1エンティティの関係性
curl "https://app.snorbe.deskrex.ai/api/v1/graph/edges?entityIds=clxxx001" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"

# 複数エンティティの関係性
curl "https://app.snorbe.deskrex.ai/api/v1/graph/edges?entityIds=clxxx001,clxxx002,clxxx003" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"

# タイプで絞り込み
curl "https://app.snorbe.deskrex.ai/api/v1/graph/edges?entityIds=clxxx001&type=RELATED_TO" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

## 5. ワークフロー例: 特定テーマの深掘り

```
1. /graph/entities?search=lithium でキーワード検索
2. レスポンスの entities[].id を収集
3. /graph/edges?entityIds=<収集したID> で関係性を取得
4. エッジの targetEntityId/sourceEntityId から新しいエンティティを発見
5. 発見したエンティティIDで再度 /graph/edges を呼び出し、ネットワークを拡張
```

## 6. メタデータ検索

エンティティの metadata フィールド内をキーワード検索:

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/graph/entities?metadataKeyword=https://example.com&limit=10" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

メタデータ構造: `Record<string, { value: string, type: string, references?: string[] }>`
