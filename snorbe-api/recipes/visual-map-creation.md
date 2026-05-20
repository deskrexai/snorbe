# ビジュアルマップ（軸マップ）作成レシピ

ワークスペース内のエンティティを 2〜4 軸の散布図にプロットする `visualmap` HITL ツールの呼び出しレシピ。 stage-1 で軸構成のドラフト → ユーザー確認 → stage-2 で各エンティティのメタデータを抽出 → `GraphView` として保存される。

## シナリオ

- 入力: 自然言語で「何を軸にしてマップ化したいか」
- 出力: `GraphView` レコード（id, name, config）。 UI ではサイドバーの「カスタムビュー」ポップオーバーに表示され、 散布図キャンバスでドラッグ＆ドロップによる配置調整も可能になる
- 使うツール: `visualmap`（HITL 2段階）

## ステップ概要

```
1. POST /agent/run/stream で /visualmap 起動
2. SSE で visual_map_structure_draft_complete を受信（HITL ゲート）
3. ステータス確認 → pendingVisualMapDraft: true
4. （任意）軸構成を修正したければ POST /agent/run/{runId}/visual-map/answer
5. 確定: POST /agent/run/{runId}/visual-map/confirm
6. レジューム: POST /agent/run/stream/{runId}
7. SSE で visual_map_metadata_filling_delta（per-entity × per-axis 抽出進捗）
8. SSE で visual-map-data-completed → graphViewId 確定
```

## プロンプト設計

**最小**（軸を AI に提案させたい場合）:

```
/visualmap
ワークスペースの生成 AI スタートアップを散布図にマッピングしてください。
```

**詳細**（軸も色も自分で指定したい場合）:

```
/visualmap
ワークスペースの生成 AI スタートアップを
「成熟度（mature_level）×適用領域（domain）」の 2 軸マップに配置し、
「資金調達ラウンド（funding_round）」で色分けしてください。
対象は category=startup のエンティティすべて。
```

### CUID を書く必要は無い

`target.entityIds` は **server 側で DB lookup によって CUID に解決**される（[stage-1 LLM 出力の identity resolution](../reference/agent-streaming.md)）。 つまりプロンプトでは「ラベル」「名前」「期間/カテゴリでの絞り込み条件」のいずれで書いても、 最終的に保存される `GraphView.config.target.entityIds` は確実に DB の CUID 列が並ぶ。

LLM が（うっかり）label を id 扱いして提案してしまっても、 confirm 直後の resolve パスが workspace 内で id と label の両方を試して正しい CUID に書き換える。 そのため、 drag&drop や `graph.assignEntityToAxisCell` も成功する。

## SSE イベントの流れ

| 段階 | イベント | 何を意味するか |
|---|---|---|
| stage-1 | `visual_map_structure_draft_delta` | LLM が draft を生成中（漸進的） |
| stage-1 完了 | `visual_map_structure_draft_complete` | HITL 待ち。 ここで `pendingVisualMapDraft: true` |
| stage-1 確定 | `visual_map_structure_confirmed` | `/visual-map/confirm` を受け取った |
| stage-2 進捗 | `visual_map_metadata_filling_delta` | 1 entity × 1 axis の値が決まった |
| stage-2 まとめ | `visual_map_metadata_filled_per_entity` | 1 entity の全 axis が出揃った |
| 保存完了 | `visual-map-data-completed` | `GraphView` が DB に保存された。 `graphViewId` を payload に含む |

中断した場合: `GET /agent/run/{runId}/status` で `pendingVisualMapDraft` を見るのが最も簡単。 true なら未確定、 false なら stage-2 進行中もしくは完了。

## ステージ 2 の reflection

stage-2 は extract → reflect のループ。 反復回数は最大 5、 必要に応じて +3 まで延長（絶対上限 8）。 `gapsIdentified: []`（穴なし）を 1 度でも検知すれば即停止するので、 ほとんどのケースで 1〜3 回で収束する。 大量エンティティ × 多軸の場合のみ上限に近づく。

## API 呼び出し例（curl）

```bash
# 1. /visualmap 起動
RUN_ID=$(curl -N -X POST "$BASE/agent/run/stream" \
  -H "Authorization: Bearer $SNORBE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
    "modelName": "snorbe-fast",
    "inputText": "/visualmap 生成 AI スタートアップを成熟度×適用領域でマップ化",
    "promptKey": "chat-routing",
    "locale": "ja"
  }' \
  | tee /tmp/visualmap-sse.log \
  | grep -m1 '"type":"config"' \
  | python3 -c "import json,sys; print(json.loads(sys.stdin.read().split('data: ',1)[1])['payload']['runId'])")

# 2. SSE で visual_map_structure_draft_complete を待つ → 別ターミナルで監視
#    grep -m1 visual_map_structure_draft_complete /tmp/visualmap-sse.log

# 3. ステータス確認
curl -s "$BASE/agent/run/$RUN_ID/status" \
  -H "Authorization: Bearer $SNORBE_API_KEY" \
  | python3 -m json.tool

# 4. 軸構成をそのまま受け入れて確定
curl -X POST "$BASE/agent/run/$RUN_ID/visual-map/confirm" \
  -H "Authorization: Bearer $SNORBE_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"runId\":\"$RUN_ID\"}"

# 5. レジューム（stage-2 が走り出す）
curl -N -X POST "$BASE/agent/run/stream/$RUN_ID" \
  -H "Authorization: Bearer $SNORBE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"modelName":"snorbe-fast","promptKey":"chat-routing","locale":"ja"}'

# 6. SSE 末尾 (visual-map-data-completed) から graphViewId を回収
grep visual-map-data-completed /tmp/visualmap-sse.log \
  | tail -1 \
  | python3 -c "import json,sys; print(json.loads(sys.stdin.read().split('data: ',1)[1])['payload']['graphViewId'])"
```

## 軸構成を修正したいとき

`/visual-map/answer` に自然言語で書く（plan/report/matrix と同じ）:

```bash
curl -X POST "$BASE/agent/run/$RUN_ID/visual-map/answer" \
  -H "Authorization: Bearer $SNORBE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "runId": "'"$RUN_ID"'",
    "answer": "Z 軸に「設立年（founded_year）」を追加して 3D にしてください。 色は維持。"
  }'
```

LLM が再 draft を生成 → 再び `visual_map_structure_draft_complete` を待つ。 OK なら `/confirm`。

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| `pendingVisualMapDraft: true` のまま動かない | confirm 未送信 | `/visual-map/confirm` を叩く |
| `Visual map confirmed with empty target.entityIds; nothing to fill` | 候補エンティティが workspace に 1 つも存在しない | プロンプトの対象指定を見直す or RAG 用に事前に entity を投入 |
| 完成した GraphView の点が散布図に出ない | stage-2 が axis の値を null で返した（メタデータが見つからなかった） | reflection が補完を試みる。 それでも null なら未配置エンティティとして panel 右下に列挙される |
| drag&drop で `Entity not found: xxx` | 古いバージョン由来の壊れた GraphView | 同じワークスペースで `/visualmap` を再実行 → server 側 resolve で CUID が再正規化される |
