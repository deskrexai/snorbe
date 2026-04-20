# ワークスペース・エージェント管理

## GET /workspace

API キーに紐づくワークスペース情報を取得。

### リクエスト

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/workspace" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

### レスポンス

```json
{
  "workspaceId": "clxxx001",
  "workspaceName": "My Research Workspace"
}
```

### ユースケース

- API キーがどのワークスペースに紐づいているか確認
- アプリケーションの初期化時にワークスペース名を表示

---

## GET /agent/list

API キーに紐づくエージェント一覧を取得。

### リクエスト

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/agent/list" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

### レスポンス

```json
[
  {
    "id": "clxxx001",
    "name": "agent",
    "isDefault": true,
    "createdAt": "2026-01-15T10:30:00.000Z",
    "updatedAt": "2026-03-20T14:22:00.000Z"
  },
  {
    "id": "clxxx002",
    "name": "research-agent",
    "isDefault": false,
    "createdAt": "2026-02-01T08:00:00.000Z",
    "updatedAt": "2026-03-15T16:30:00.000Z"
  }
]
```

### ユースケース

- エージェント選択UIの構築
- `agentId` を `/agent/run` のパラメータに渡す
- `isDefault: true` のエージェントをデフォルト選択

---

## GET /agent/{agentId}

指定したエージェントの詳細を取得。

### 主なレスポンスフィールド

- `identityMarkdown`
- `userMarkdown`
- `soulMarkdown`
- `memoryMarkdown`
- `isDefault`

---

## POST /agent

API キーに紐づくワークスペースにエージェントを新規作成。

### リクエスト例

```bash
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/agent" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "patent-analyst",
    "identityMarkdown": "# Identity\n特許調査を担当します"
  }'
```

### ポイント

- 1体目の Agent は自動で default になる
- `isDefault: true` を付けると既存 default を置き換える

---

## PATCH /agent/{agentId}

エージェントを部分更新。

### ポイント

- 送ったフィールドだけ更新
- `isDefault: true` で default を切り替え
- 現在の default に `isDefault: false` を直接送ることはできない

---

## DELETE /agent/{agentId}

エージェントを削除。

### ポイント

- 関連 `AgentRun` は cascade で削除
- default Agent を削除し、他に Agent が残っていれば最新更新の Agent が次の default になる

---

## 共通ポイント

### API キーとワークスペース

API キーは **特定のワークスペースに紐づいている**。そのため:

- `workspaceId` をリクエストパラメータに渡す必要はない
- すべてのエンドポイントは API キーのワークスペース配下のデータを返す
- 他のワークスペースのデータにはアクセスできない

### エージェントの選択

- `isDefault: true` のエージェントがデフォルト
- `/agent/run` で `agentId` を省略するとデフォルトエージェントが使用される
- カスタムエージェントを使う場合は `agentId` を明示的に指定
