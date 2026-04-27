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

SSE が途切れたら `POST /agent/run/stream/{runId}` でレジューム可能。

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

### plan → report の **連鎖 HITL**（要注意）

複雑なマルチステップ要求（「カテゴリ×列×国で網羅的に棚卸し」「指定マーカーで2ファイル分ける」「セクションごとに…」等）を投げると、**plan を確定した直後に今度は report までもう一段 HITL に入る**ことが頻繁にある。以下のパターンで詰まる:

1. 投稿 → `first-plan` 受信 → `/plan/confirm` で確定 → resume
2. resume 中に `first_report_structure` / `report-structure-draft-complete` が流れる
3. `/report/confirm` を叩かないと **最終本文が `complete` の `text` に載らない**（代わりに `report_section_*` と `report_complete` で配信される）
4. さらに resume するまで報告本文生成は始まらない

> 「complete イベントは来たが `text: ""`」という現象は、ほぼ report HITL 待ちで止まっているサイン。`GET /agent/run/{runId}/status` で `pendingReportDraft: true` を確認し、`/report/confirm` → resume をもう1巡する。

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
- 簡単: `snorbe-fast` / `snorbe-quality` を使えばワークスペース設定で自動選択

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
