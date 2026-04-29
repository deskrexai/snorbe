# 複数 Agent への委譲と連鎖

ワークスペースに複数の Agent が存在するとき、ユーザー入力で `@Agent` を使って指名すると、サーバが自動で対象 Agent に委譲・連鎖する。

## ⚠️ 起動前のアンチパターン（最重要）

**単一指名で済むケースに勝手にマルチ起動するな**。並列性とエージェント分散は別概念であり、bot 指名がない場合の既定値は「デフォルト 1 体に投げる」または「デフォルト 1 体に N 並列で投げる」である。複数 bot に分散させるのは、ユーザーが**明示的に bot 名を 2 つ以上挙げた場合のみ**:

| やってはいけない | なぜダメか | 正しい動作 |
|---|---|---|
| ユーザーが「並列で調査して」と言っただけで、ワークスペース内の複数 bot に分散 | 「並列性」と「エージェント分散」は独立。同じデフォルト bot に N 並列で投げれば結果は同じ | デフォルト 1 体に異なる `inputText` で N 並列 POST |
| ユーザーが「エージェントチームで」と言っただけで、別々の bot に振る | 「チーム」は多義語（並列・連鎖・複数視点・単純並列実行いずれも該当しうる） | `GET /agent/list` で候補を提示して**確認**してから動く |
| 単一 bot 指名のつもりで `[X](agent://...)` を `inputText` に書く | デフォルト入口が走ってから X に連鎖する**二重実行**になる | `agentId=X` を直接指定、`inputText` には書かない |
| bot 名が部分一致で複数候補に当たるまま投げる | 意図と違う bot に振り分けられる | 候補を列挙して**確認** |

**安全側に倒す原則**: 曖昧なら **確認**、明示なら **そのまま**。並列性が必要なら **同じ bot に N 並列** が既定値。

## 7パターンの判定表

| ユーザーの言い方 | 解釈 | 動作 |
|---|---|---|
| 「bot 名なし」 | デフォルト 1 体 | `agentId` 省略でそのまま実行 |
| 「X bot に聞いて」 | 単一 X | `agentId=X`、確認なし |
| 「A と B に聞いて」 | 並列 | `mentions` 並列、確認なし |
| 「A → B にレビューさせて」 | 連鎖 | `mentions` chain、確認なし |
| 「皆に」「複数人で」「いろんな視点で」「チームで」「並列で」 | **不確定** | `GET /agent/list` 後、確認 |
| 部分一致で ID 一意解決できない | **不確定** | 候補列挙して確認 |
| デフォルト 1 体で済む依頼 | デフォルト | デフォルト 1 体に投げる（勝手に mention 追加しない） |

詳細は [../prompting.md#エージェント指定の選び方-agentid-vs-mention_agent](../prompting.md#エージェント指定の選び方agentid-vs-mention_agent) と [SKILL.md](../../ja/snorbe-api/SKILL.md) も参照。

## 1. Agent 一覧取得

委譲先の Agent ID を特定:

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/agent/list" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

レスポンス例:

```json
[
  { "id": "a-id", "name": "agent-alpha", "isDefault": true, ... },
  { "id": "b-id", "name": "agent-beta",  "isDefault": false, ... },
  { "id": "c-id", "name": "agent-gamma", "isDefault": false, ... }
]
```

## 2. 1 体指名（1:1 委譲）

デフォルト Agent（alpha）から agent-beta に質問を委譲:

```bash
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "modelName": "snorbe-fast",
    "promptKey": "chat-routing",
    "locale": "ja",
    "inputText": "[agent-beta](agent://b-id) さんに「好きな色を一言で」と聞いて",
    "mentions": [
      { "id": "b-id", "type": "agent", "label": "agent-beta" }
    ]
  }'
```

起きること:
1. alpha の run が開始
2. alpha の LLM が `mentionAgent` tool を選択し、最終メッセージに `[@agent-beta](agent://b-id) 好きな色を一言で` を書く
3. alpha 完了後、サーバが自動で beta の新規 AgentRun を起動（入力 = alpha の最終メッセージ）
4. beta が独立 run として応答を生成、turn 履歴に積まれる

`/agent/run` のレスポンスは**親 run の runId のみ**を返す。child run の結果を取るには次項を参照。

## 3. 2 体以上指名（並列 vs 連鎖は自動判定）

2 体以上 mention するとサーバ側 classifier が文意を判定:

### 並列例（独立意見）

```json
{
  "inputText": "[agent-alpha](agent://a-id) と [agent-beta](agent://b-id) にそれぞれ独立に意見ください",
  "mentions": [
    { "id": "a-id", "type": "agent", "label": "agent-alpha" },
    { "id": "b-id", "type": "agent", "label": "agent-beta" }
  ]
}
```

→ classifier が `parallel` と判定 → 2 体が**同時に並列実行**。

### 連鎖例（順序依存）

```json
{
  "inputText": "[agent-alpha](agent://a-id) が企画を作って、それを [agent-beta](agent://b-id) がレビューして",
  "mentions": [
    { "id": "a-id", "type": "agent", "label": "agent-alpha" },
    { "id": "b-id", "type": "agent", "label": "agent-beta" }
  ]
}
```

→ classifier が `chain, primary=alpha` と判定 → alpha が**先行実行**し、alpha が `mentionAgent` で beta に委譲する流れになる。

## 4. child run の結果を追う

`/agent/run` は親の runId しか返さないので、child は別途取得:

### 方法 A: `/turn/list` で最新 Turn を走査

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/turn/list?limit=10" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

各 Turn の `agentRunId` と `kind` / `content` から child の応答を特定可能。

### 方法 B: 個別ステータス確認

child の runId が分かっていれば:

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/agent/run/{childRunId}/status" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

## 5. 連鎖深度の制限

再帰的な `mentionAgent` 発火が止まらない場合に備え、`maxChainSteps` で上限を設定可能（1-50、デフォルト 10）:

```json
{
  "inputText": "...",
  "mentions": [...],
  "maxChainSteps": 5
}
```

上限に達すると新規 spawn が打ち止められる（例外にはならず、警告ログだけ出て親の応答は正常に返る）。

## 6. ストリーミング版

`/agent/run/stream` でも `mentions` の挙動は同じ。親の `complete` イベント後に child が非同期起動する。child の SSE は別途張り直す必要はなく、`/turn/list` または `/status` で結果を取得する。

## ガード動作

- **self-loop**: agent-beta が自分自身を mention しても spawn されない（同一 agentId は skip）
- **child が error**: 親 run 自体はそのまま完了。child の失敗は親の結果に影響しない
- **個別の child が throw**: 他の siblings の spawn は続行される（エラー隔離）
