# 実装上のハマりどころ（Runtime Gotchas）

Snorbe API は SSE とエージェントの長時間実行が絡むため、実装側で詰まりやすい箇所がある。今回の作業で実際に遭遇したものを優先的に記載する。

## SSE 受信の落とし穴

### 原則: `curl` は安定、`requests` は環境依存

**結論: Python で SSE を受ける場合、`curl` をサブプロセスで呼ぶのが最も確実。**

**遭遇した症状（2026-04-20）:**
- `python3 /script.py` を `run_in_background` 経由で起動
- SSE で HTTP 200 は返るが `config` / `delta` イベントが一切流れてこない
- 10 分以上待っても空のまま
- 同じコードを **foreground 実行**（`python3 -c "..."` 直接、または heredoc `<< 'EOF'`）なら動く
- 同じクエリを **`curl -N -s`** で叩くとストリームがサラサラ流れる

**確実に動くパターン（Python から SSE）:**

```python
import subprocess, json, os

cmd = [
    "curl", "-N", "-s",
    "-X", "POST", f"{BASE}/agent/run/stream",
    "-H", f"Authorization: Bearer {API_KEY}",
    "-H", "Content-Type: application/json",
    "-H", "Accept: text/event-stream",
    "-d", json.dumps({...}),
    "--max-time", "300",
]
proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
for raw in proc.stdout:
    line = raw.decode("utf-8", errors="replace").rstrip()
    if not line.startswith("data: "):
        continue
    event = json.loads(line[6:])
    # ... handle event
```

**`requests` を使う場合の予防策:**

```python
# 1. PYTHONUNBUFFERED=1 環境変数を設定
# 2. foreground 実行にする
# 3. session.get/post に stream=True を明示
# 4. iter_lines(decode_unicode=True, chunk_size=None) を試す
# 5. ダメなら subprocess + curl に切り替える
```

### バッファリング対策

Python の `print(flush=True)` でも background 実行では stdout が詰まる。
バックグラウンドで progress を取りたい場合は**ファイルに直接書く**:

```python
LOG = open("/tmp/progress.log", "w", buffering=1)  # 行バッファ

def log(msg):
    print(msg, flush=True)
    LOG.write(msg + "\n")
    LOG.flush()
```

`buffering=1` は line-buffered の指示。`flush()` の二重化で確実にディスクに降りる。

## タイムアウト設定

### `/agent/run`（非ストリーミング）

**エージェント実行は 10秒〜数分**。必ずクライアント側のタイムアウトを長めに:

```python
requests.post(url, json=body, timeout=600)  # 10分以上
```

または `curl --max-time 600`。

**短くすると起こること:**
- クライアントが切断しても**サーバーは最後まで走る**
- 結果は Turn 履歴に積まれる → `/turn/list` で回収可能
- 呼び出し元は切断された側として何も受け取れない

### `/agent/run/stream`（SSE）

SSE は逐次イベントが来るので、HTTP レベルで長時間コネクションを保つ:
- `curl --max-time 300` で明示的に指定（`0` で無制限だが推奨しない）
- Python `requests` の `timeout` は SSE では「次のバイトが来るまでのタイムアウト」として機能する

SSE が途切れたら再接続が必要になるが、**無条件に `POST /agent/run/stream/{runId}` を再POSTしてはいけない**（詳細は下記「resume 多重起動を防ぐ手順」）。

## レート制限（100 req/min）

バッチ処理では**各ラン呼び出しの間にスリープを入れる**:

```python
for patent in patents:
    run_agent(patent)
    time.sleep(2)  # 最低2秒、安全なら5秒
```

**実際の感覚**: 9件のエージェント実行を順次回すのに全体で数分〜10分程度。1件あたり 30秒〜2分が普通。

レート制限に当たったら `429` が返る → `retryDelayMs` で指数バックオフ。

## HITL フロー忘却

`plan` / `report` / `matrix` を誘発するクエリを投げた後、**確認エンドポイントを叩かずに放置**すると実行が進まない。

SSE 受信中に以下のイベントを見たら必ず対応:

| イベント | 対応 |
|----------|------|
| `first-plan` / `plan-draft-complete` | `/plan/confirm` or `/plan/answer` |
| `first_report_structure` / `report-structure-draft-complete` | `/report/confirm` or `/report/answer` |
| `first_matrix_structure` / `matrix-structure-draft-complete` | `/matrix/confirm` or `/matrix/answer` |

確認後、`/agent/run/stream/{runId}` でレジュームして本実行を走らせる。

### ⚠️ `/answer` の `modelName` 欠落で run が静かに `failed` になる事故

**症状**: `/plan/answer`（または `/report/answer` 等）を `modelName` 抜きで叩くと、レスポンスは 400 で巨大な validation error が返る（**150 個以上の有効な model 名を列挙する超長文エラー**）。

```bash
# ❌ NG: modelName を抜いた answer
curl -s -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/$RUN_ID/plan/answer" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"runId":"'$RUN_ID'","answer":"主読者は…"}'
# → 400 BAD_REQUEST: "modelName": ["Invalid option: expected one of \"snorbe-fast\"|\"snorbe-medium\"|..."]
```

ここで**多くのクライアント実装はエラーを見逃して `/plan/confirm` に進んでしまう**。confirm は `"status":"confirmed"` を返し、status は `running` に遷移するので、見かけ上は成功して見える。

**しかしユーザー回答は一切保存されておらず**、agent は HITL 回答待ちのまま延々と何もしない step を回し、最終的に **約30分後に何のエラーメッセージもないまま `status: "failed"` に遷移**する。`/agent/run/{runId}` を取得しても `error` / `errorMessage` / `failureReason` はすべて空。

**症状の特徴**:

- run は `failed` だが、`/agent/run/{runId}` の `process` には `config` → `first_plan` → `step (plan call)` → `plan_confirmed` → `step (empty)` の 5 件しか残らない
- `step` の `usage` は空、`text` も空、`toolCalls` には plan 確定の呼び出しだけが残る
- なぜ落ちたかが APIレスポンスからは判別不能

**正しい answer**:

```bash
# ✅ OK: modelName / runId / answer の3点を揃える
curl -s -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/$RUN_ID/plan/answer" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "runId": "'"$RUN_ID"'",
    "answer": "主読者は…（修正・追記内容）",
    "modelName": "snorbe-quality"
  }'
# → 200 OK: {"message":"計画を改善しました（1回目の更新）。新しい質問に回答してください。","status":"drafting"}
```

**modelName は原 run と同じ値**を渡す（`/agent/run/stream` 起動時に指定したもの）。値が違うと validation error。

**呼び出し側の対策**:

1. `/answer` / `/confirm` / `/skip` の各レスポンスを **必ず HTTP status と body の `status` 両方で判定**する。`"status":"drafting"` または `"status":"confirmed"` 以外は失敗扱い
2. 400 が返ったときは `confirm` に進む前にリトライ。`modelName` / `runId` 欠落を疑う
3. 回答テキストを `/plan/answer` で保存できたかは、レスポンスの `message` フィールドで「計画を改善しました」「新しい質問に〜」が来たことで確認する

### ⚠️ `/plan/confirm` 後の resume 忘れでも同じ「30分で `failed`」事故が起きる

`/plan/answer` が正常に保存できても、**`/plan/confirm` の後に SSE を resume せず放置すると同じ症状になる**。`status: running` で 30 分待つと `failed` に落ち、`process` には `config` / `first_plan` / `step (plan)` / `user_answer_for_plan` / `regenerated_plan` / `plan_confirmed` / `step (空)` の7件だけ残る。

**症状の見分け方** — process に `user_answer_for_plan` と `regenerated_plan` が含まれていれば answer は保存されている。それでも最後の step が空のままなら resume が叩かれていない。

**原因**: HITL の確認エンドポイント（`/confirm`）はあくまで HITL ゲートを開けるだけで、実行を再開する責任を負わない。実行は SSE 接続（`/agent/run/stream/{runId}`）でのみ流れる。確認直後に **SSE を貼り直さないと、サーバ側はクライアント切断扱いで idle のまま timeout → failed** になる。

**正しい流れ** (毎 HITL ごとに必須):

```
1. SSE drop → 2. status 確認 → 3. /plan/answer (modelName 必須) → 4. /plan/confirm
→ 5. /agent/run/stream/{runId} で resume (modelName/promptKey/locale 必須)
→ 6. 次の HITL or complete を SSE で待つ
```

**SSE を長時間生かす実装メモ**: Bash + curl で実装する場合、親シェルが先に exit すると `&` でバックグラウンド化した curl も SIGHUP で殺されることがある。`nohup curl ... < /dev/null > log 2> err &; disown` で完全に detach するか、`setsid` で新しいプロセスグループに分けると確実。`--max-time` を長めに（例 1800〜3600 秒）。

### resume 多重起動を防ぐ手順（重要）

**背景**: SSE が長い run で複数回切れ、その都度 resume を再POST すると、**サーバ側で同一 run の実行が並走**する。これにより finalize がレースし、`completed` が HITL の `pending` 状態を上書きしてレポート構成案ドラフトが確認されないまま孤立する障害が実際に発生した。

**サーバの現在の挙動（修正後）**:
- クライアント（curl）が切断すると、その resume 実行を **abort（中断）** する。
- 同一 run に新しい resume が来たら、**進行中の旧実行を中断してから差し替える（cancel-and-replace）**。
- finalize は DB の権威状態で `pending` を再判定するため、盲目的な並走が `completed` で上書きすることはできない。

ただし上記はあくまで「最悪の事態を防ぐ安全網」であり、呼び出し側も安全な手順を守ること。

**安全な resume 手順**:

1. **SSE が切れたらまず status を確認する**（resume は即座に叩かない）。

   ```bash
   curl "https://app.snorbe.deskrex.ai/api/v1/agent/run/$RUN_ID/status" \
     -H "Authorization: Bearer $KEY"
   ```

2. **status に応じて判断する**:

   | `status` 値 | 意味 | 対応 |
   |---|---|---|
   | `running` | サーバが実行継続中 | **resume を再POSTしない**。実行を中断させる恐れがある |
   | `pending` / `pendingPlanDraft:true` 等 | HITL 待ち | confirm/answer → resume の手順へ進む |
   | `completed` | 完了済み | resume 不要。`/turn/list` で結果を回収 |
   | `error` | エラー終了 | 原因を確認してから再投入 |

3. **1 run に対して resume を同時並行で複数発行しない**（1 run 1 resume を厳守）。

4. **report HITL 待ちのパターン**（`complete` イベントが来たが `text: ""`）:
   - `GET /agent/run/{runId}/status` で `pendingReportDraft: true` を確認
   - `/report/confirm` でレポート構成を確定
   - その後に resume を1回だけ POST

```bash
# ✅ 安全な resume の前に必ず status を確認
STATUS=$(curl -s "https://app.snorbe.deskrex.ai/api/v1/agent/run/$RUN_ID/status" \
  -H "Authorization: Bearer $KEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")

# running のまま → 再接続せず待つ
if [ "$STATUS" = "running" ]; then
  echo "サーバ実行中。再POSTしない。"
# pending 系 → confirm 後に resume
elif echo "$STATUS" | grep -qi "pending"; then
  echo "HITL 待ち。confirm → resume の手順へ。"
fi
```

> **注意**: resume を再POST すると、進行中の旧実行が中断される（cancel-and-replace）。`running` 中の resume 再POSTは作業の中断・やり直しを引き起こす。

### `failed` / `cancelled` からの resume は「動くが決定論ではない」

**実装事実**: `POST /agent/run/stream/{runId}` および `POST /agent/run/{runId}/resume` は **run の現在 status を一切チェックしない**。`failed` でも `cancelled` でも resume を叩けば実行される。サーバは以下を行う:

1. Turn テーブルから event を全 replay して process を復元
2. 過去の assistant 発話 + tool_result を全部 prompt に積み直す
3. `status: running` に強制上書き
4. LLM に「続きを打て」と促す

つまり resume は **「エラーの続きから resume」ではなく「エラー直前の状態を復元 → LLM に続きを判断させる」**。ここは決定論ではない:

- LLM は履歴を読み取り、`complete` で終わらせることも、別 tool を選び直すことも、同じ tool を再実行することもある
- 復活する保証はないが、event-sourced 設計なので進捗を失わずに済むケースが多い

**UI 側にはこの再開機能は露出していない**（Web UI の resume は HITL confirm 契機のみ）。API から使う場合の隠し機能に近い。

**`failed` から resume するときの判定手順**:

```bash
# 直近 event を見て orphan か hard error かを見分ける
curl -s ".../agent/run/$RUN_ID" -H "Authorization: Bearer $KEY" \
  | jq '.process.events[-5:] | map(.type)'
```

| 直近 event の型 | 意味 | 対応 |
|---|---|---|
| `step` / `tool_result` / `search_*` / `browse_*` / `report_*` 系 | 途中まで進んで silent timeout (orphan recovery) | resume で復活期待できる |
| `error` / `run-error` | ハードエラー（LLM auth・rate limit・provider outage 等） | resume しても同じ理由で落ちる可能性大。原因調査してから再投入 |
| `config` のみ（step 0 件） | 起動直後に落ちた | resume しても意味薄い。原因調査 |

**`cancelled` からの resume は原則 NG**:

- `cancelled` はユーザーが明示的に cancel mutation を叩いた結果
- resume で復活させるとユーザー意思の反映を破壊する
- 例外: cancel-and-replace のレースで意図せず `cancelled` に落ちたケースだけ、意図的に resume する

**resume で使うプロンプトの中身**（デバッグ時の参考）:

- `inputText` は元の user turn（config event に保存）
- 全 `step.text` + `step.toolCalls` が assistant message として順に再現
- 全 `step.invokedTools` が tool_result message として順に再現
- HITL confirm 済み情報（plan / report structure / matrix / visual map）は timeline から取り出して metadata に注入
- 直近に rejection があれば "fallback message" が末尾に追記される

**30 分 silent timeout の正体（重要な誤解を解く）**: サーバ側の `recoverOrphanedAgentRuns` は「`status=running` かつ 30 分以内に `agent-event` Turn が 0 件」の run を `failed` にマークするだけの background job。**エージェントが失敗したわけではなく、SSE 切断で idle 判定を食らっただけ**のケースが大半。だから resume で復帰することが多い。「30 分 failed = 実行不能」と早合点しない。

### plan → report の **連鎖 HITL**（要注意）

複雑なマルチステップ要求（「カテゴリ×列×国で網羅的に棚卸し」「指定マーカーで2ファイル分ける」「セクションごとに…」等）を投げると、**plan を確定した直後に今度は report までもう一段 HITL に入る**ことが頻繁にある。以下のパターンで詰まる:

1. 投稿 → `first-plan` 受信 → `/plan/confirm` で確定 → resume
2. resume 中に `first_report_structure` / `report-structure-draft-complete` が流れる
3. `/report/confirm` を叩かないと **最終本文が `complete` の `text` に載らない**（代わりに `report_section_*` と `report_complete` で配信される）
4. さらに resume するまで報告本文生成は始まらない

> 「complete イベントは来たが `text: ""`」という現象は、ほぼ report HITL 待ちで止まっているサイン。`GET /agent/run/{runId}/status` で `pendingReportDraft: true` を確認し、`/report/confirm` → resume をもう1巡する。**resume 前には必ず status が `pending` 系であることを確認してから1回だけ POST すること**（多重起動防止手順参照）。

**plan / report を一切使わせたくない場合**は、inputText から「レポート」「セクション構成」「棚卸し」のような HITL トリガー語を消し、「以下の形式のマークダウンだけを返してください。他の処理は不要」と直接的に書くと、chat-routing が直接応答ツール（delta のみ）を選びやすい。ただし厳密には防げないので、スクリプト側は plan / report の両方を検出・自動 confirm するロジックを入れておくのが無難。

### report モードの **SSE イベント名はアンダースコア**

ドキュメント上のイベント名は `report-section-complete` のようにハイフンで書かれている箇所があるが、**実配信はアンダースコア**:

| 実際に流れるイベント | payload の主なフィールド |
|----------------------|--------------------------|
| `report_section_start` | `reportTitle` / `totalSections` / `sections[{id,title}]` |
| `report_section_delta` | `sectionId` / `deltaText` |
| `report_section_complete` | `sectionId` / `sectionTitle` / **`content`**（セクション本文 Markdown） |
| `report_complete` | `reportTitle` / **`markdown`**（全セクション結合の統合 Markdown）/ `sections[{id,title,content}]` |

パース時は両表記を許容しておく（`report[_-]section[_-]complete` のような正規表現 / `replace("-","_")` でキー正規化）。**本文の取り出しは `report_section_complete.content` か `report_complete.markdown` / `.sections[].content` を見る**。通常の `complete.text` は report モードでは空になる。

### plan draft の構造

`first-plan` / `plan-draft-complete` の `payload.plan` には以下が入る:

- `goal` — 全体ゴール文（複数行 Markdown）
- `steps[]` — `{id, objective, status}` の配列（step ごとに objective は1文）
- `questions[]` — ユーザーへの質問（空配列なら無質問で `/plan/confirm` するだけで進む）
- `currentStepId` / `maxIterations` / `status`

Snorbe 側で `title` / `detail` というキーは無いので、step を表示したいときは `objective` を見る。

### **plan / matrix event 発火時の resume 手順 (HITL 再開 API)**

`first-plan` や `plan-draft-complete` / `first_matrix_structure` などの HITL event を受信したら、SSE は **その時点で stop** する (= curl 接続が閉じる)。続行するには明示的に resume API を叩く:

```bash
# 1. answer (optional): plan に追記・修正したい内容があれば渡す
curl -X POST "$BASE/agent/run/$RUN_ID/plan/answer" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"runId":"'$RUN_ID'","answer":"<plan に対する修正・追記>","modelName":"snorbe-fast"}'

# 2. confirm: plan を確定 (またはそのまま受諾)
curl -X POST "$BASE/agent/run/$RUN_ID/plan/confirm" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"runId":"'$RUN_ID'"}'

# 3. resume: 本実行を SSE で再開 (新 curl 接続)
curl -N -s -X POST "$BASE/agent/run/stream/$RUN_ID" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"modelName":"snorbe-fast","promptKey":"chat-routing","locale":"ja"}'
```

resume の body は **必須**: 空 `-d ''` は `Invalid JSON body`、空 `{}` は modelName 等の必須項目欠落で 400。**原 run と同じ modelName / promptKey / locale の 3 点を明示** ([reference/agent-streaming.md L73-85](reference/agent-streaming.md))。

`matrix` / `report` / `visual-map` も同形 (`/agent/run/$RUN_ID/{type}/answer` + `/confirm` → `/agent/run/stream/$RUN_ID` resume)。

### **plan event 非発火 + 「計画立てる」文言 stop 事故 (≠ HITL)**

これは上記 HITL とは**別物**。エージェントが reasoning 不足で「計画を立てる必要があります」「次にやるべきことは...」のテキストだけ返して complete し、実際のマトリクス出力をスキップする事故。

**症状**:
- `complete` event は来るが `text` が **200-500 字** (= 通常 3000+ 字の本文より明確に短い)
- ログ全体で `plan` 系 event は **0 件** (= HITL に分岐していない)
- text 末尾が「次にやるべきことは X です」「計画を立ててから進めましょう」等で中断

**原因**:
- 入力が大規模 (claim 細目 30+ × 候補 6 等) で fast モデルが reasoning 不足
- inputText が「計画を立ててから...」の語彙を誘発 (= chat-routing で「これは計画必要案件」と判定するが HITL までは行かない)

**対処** (優先順):
1. **snorbe-quality でリトライ** — reasoning model が 1-shot で完走する確率が高い (10-30 分かかる)
2. **inputText 冒頭に強制指示**:
   ```
   **強制指示**: 計画ツール (plan-creation) 発火禁止、HITL 質問返し禁止、
   ツール選択は 1-shot chat-routing 限定、最終応答は必ず <成果物> をその場で
   出力すること。「計画を立てる必要があります」「次にやるべきことは...」のような
   plan 文言で stop した場合は不適合とみなす。
   ```
3. **input 分割** — 30+ 細目を一気に投げず、3-5 グループに分割して個別ラン
4. **HITL 経由を強制** — `/plan` を明示誘発する語彙を inputText に入れて plan event 発火させる → 上記 HITL resume 手順で続行 (= 結果的に大規模タスクをこなせる場合がある)

**事例 (2026-05-21 WO2019/122291)**:
- snorbe-fast で claim 細目 47 個 (独立 10 件 × 平均 5 細目) を 1-shot 投入 → complete.text 211 字 (「計画立てる必要」) で stop、plan event 0 件
- snorbe-quality + 上記強制指示 で再ラン → 14.1MB ログ / delta 2639 件で完走、最終 text 5725 字 (6 候補 × 47 細目マトリクス完全)

## `maxBrowsingSteps` の実用値

デフォルトは低めに設定されがち。実用的には:

| 用途 | 推奨値 |
|------|--------|
| 単一 URL の要約 | 3 |
| 検索 + 1 ページ読み取り | 5 |
| Google Patents 等構造化ページからの抽出 | 8〜10 |
| 複数ページ遷移（ログイン後の操作等） | 15〜20 |
| 最大 | 100 |

多すぎると**コストと時間が爆発**するので、必要最小限。browse 不要なら指定しない（search だけで済む）。

## `run_in_background` 実行時の落とし穴（Claude Code）

Claude Code の `Bash` ツールで `run_in_background: true` を使う場合:

- stdout が `/private/tmp/claude-501/.../tasks/{taskId}.output` に redirect される
- **Python の stdout バッファリングが効く** → `print(flush=True)` でも詰まる場合あり
- 対策:
  - `PYTHONUNBUFFERED=1` を付ける
  - ログをファイルに直書き（`/tmp/progress.log`）
  - `Monitor` ツールで `tail -f <logfile>` して進捗ウォッチ

## `/turn/list` 経由の詳細取得

SSE が切れても、`turns[].agentRun.process` に**全イベントが永続化**される。

```python
import requests

resp = requests.get(
    f"{BASE}/turn/list?limit=20",
    headers={"Authorization": f"Bearer {API_KEY}"}
)
for turn in resp.json()["turns"]:
    run = turn.get("agentRun")
    if run and run["id"] == target_run_id:
        print(run["process"])           # 全SSEイベント
        print(run["publicSourceAgentRuns"])  # 参照ソース
```

**特定の `runId` を探すには降順ページング**（`?cursor=...` で次ページ）。直接指定エンドポイントは未提供。

## エクスポート（`/agent/run/{runId}/export`）の落とし穴

### ❌ `status: "running"` の途中で export を叩く

`process` がまだ DB に書ききっていない時点で export を叩くと、部分的な内容しか含まれない PDF / Markdown が返る。**`GET /agent/run/{runId}/status` で `completed` を確認してから export する**。SSE で `step.status === "complete"` を見ているなら、そのあと数百 ms 待ってから叩くのが安全（agent-event Turn の書き込みが非同期に走る）。

### PDF はサーバー側 base64 化のため `md` / `json` より重い

`format: "pdf"` のときだけ、サーバーは process から画像 URL を抽出して上限 50 枚まで fetch + base64 化する。1 リクエストあたり数秒〜十数秒かかる可能性。MD/JSON は base64 化を skip するので軽い。Cloud Run timeout（600s）の範囲内には収まるが、CI 等の短い timeout を持つクライアントから叩くときは余裕を取る。

### `filename` のヘッダ injection 対策はサーバー側で行う

`filename` パラメータに CRLF / `"` / `\` が混入していても、サーバーは `Content-Disposition` に書く前に sanitize する。クライアント側で escape する必要はない（が、安全のため動的入力に怪しい文字を含めない設計を推奨）。

### selections に何も `true` が無いと空 PDF/MD が返る

`selections: {}` で叩くと、選択セクションがゼロなので**空または最小のドキュメント**が返る。最低 1 つは `true` にする。何を選べば良いか分からないときは UI 互換のデフォルト `{"response": true, "report": true, "images": true, "domainStatistics": true}` を使う。

## JSON 抽出の堅牢化

エージェントが `\`\`\`json` ブロックで囲んだ出力を返すとき、たまにコードブロック外に前置きが入る。パースはこうする:

```python
import json, re

def extract_json(text: str):
    m = re.search(r"```json\s*(.*?)\s*```", text, re.DOTALL)
    if m:
        return json.loads(m.group(1))
    # フォールバック: 全体が JSON の場合
    return json.loads(text.strip())
```

## モデル選択の注意

- `modelName` は `AllModelNames` union 型で厳密。誤記（`gpt-4o` 単体など）は `400 BAD_REQUEST`
- 正しい指定例: `gpt-5-mini-2025-08-07` / `claude-sonnet-4-6` / `gemini-3.1-pro`
- 簡単: `snorbe-fast` / `snorbe-medium` / `snorbe-quality` を使えばワークスペース設定で自動選択

定義元: `snorbe-app/src/constants/llm-model.ts`

## 並列実行の注意

1 つの API キーで**同時に複数の `/agent/run/stream` を開く**ことは可能だが:

- レート制限（100 req/min）に注意
- ワークスペースの実行コスト（LLM token 消費）が膨らむ
- エージェントが browse を使うと**ブラウザセッション数の上限**に引っかかる場合あり

バッチ処理は**順次 + sleep(2-5)** が基本。並列化は本当に必要な場合だけ 3〜5 並列まで。

## デバッグ Tips

1. まず `curl` で疎通確認（Python より確実）
2. HTTP 200 が返るのに SSE が流れない → Python requests 疑い
3. `first-plan` 等の HITL イベントで停止 → confirm/answer 忘れ
4. 結果が JSON パースできない → プロンプトで「他テキスト不要」を強く明示
5. 途中で切断 → `runId` を保存、`/turn/list` で後日回収、または `/agent/run/stream/{runId}` でレジューム
