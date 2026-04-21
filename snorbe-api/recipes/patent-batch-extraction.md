# 特許請求項の一括抽出レシピ

複数の特許公開番号から、Snorbe エージェントに `google-patents-search` オフィシャルスキルで全請求項（英語原文＋日本語訳）を JSON 取得してファイル保存する。browse（browser-use）より SerpApi 経由の方が安定・高速。

## シナリオ

- 入力: 特許公開番号のリスト（`WO2012014047A1` / `EP2342317A1` / `US20120149051A1` 等）
- 出力: 各特許ごとに `{patent_number}.json` ファイル。`claims[]` に全請求項が格納される
- 使うツール: `skill`（google-patents-search オフィシャルスキル）→ SerpApi 経由で構造化取得

## なぜ browse ではなく skill か

| 比較項目 | `skill`（google-patents-search） | `browse`（browser-use） |
|---------|------|-------|
| 取得方式 | SerpApi JSON API | ヘッドレスブラウザ操作 |
| 成功率 | 高（構造化データ） | 中（ページ構造依存、タイムアウトあり） |
| 所要時間 | 10〜30秒/件 | 30秒〜2分/件（タイムアウト5分） |
| 請求項抽出 | 安定（APIから直接） | 不安定（HTMLパース次第） |
| PDF URL | `pdf` フィールドに格納 | ページ内リンク探索 |

`browse` はログインが必要なサイトや UI 操作が必要な場合のみ使用。特許データの構造化取得には `skill` が適している。

## プロンプト設計

**推奨 prompt**（[prompting.md](../prompting.md) の原則に従う）:

````
google-patents-search スキルを使って、patent_id={公開番号} の全請求項を取得し、
以下の JSON 形式のみで出力せよ（他テキスト不要）:

```json
{
  "patent_number": "{公開番号}",
  "claims": [
    {
      "claim_number": 1,
      "type": "independent",
      "text_en": "原文",
      "text_ja": "日本語訳"
    }
  ]
}
```

type は independent または dependent。全請求項を漏れなく含めること。
````

**ポイント**:
- 「google-patents-search スキルを使って」→ `skill` を確実に誘導（`browse` に誤ルーティングされない）
- JSON スキーマ明示 + 「他テキスト不要」→ パースしやすい出力
- `type` の値を列挙 → enum 風に扱わせる
- 英日同時要求 → 追加の翻訳 run 不要

## 実装（Python + curl サブプロセス版）

> **なぜ `curl` か**: Python `requests` は `run_in_background` 実行で SSE を受信できない場合がある
> （[runtime-gotchas.md#sse-受信の落とし穴](../runtime-gotchas.md#sse-受信の落とし穴)）。`curl` は確実。

```python
#!/usr/bin/env python3
import subprocess, json, os, time
from pathlib import Path

API_KEY = os.environ["SNORBE_API_KEY"]
BASE = "https://app.snorbe.deskrex.ai/api/v1"
OUT_DIR = Path("/tmp/patent_claims")
OUT_DIR.mkdir(exist_ok=True)

LOG = open(OUT_DIR / "progress.log", "w", buffering=1)

def log(msg):
    print(msg, flush=True)
    LOG.write(msg + "\n"); LOG.flush()

PATENTS = [
    "WO2012014047A1",
    "WO2016166315A1",
    "WO2017001680A1",
    "WO2019008189A1",
    "WO2023089043A8",
    "WO2025073379A1",
    "EP2342317A1",
    "EP2440649A2",
    "US20120149051A1",
]

PROMPT = """google-patents-search スキルを使って、patent_id={pub} の全請求項を取得し、
以下の JSON 形式のみで出力せよ（他テキスト不要）:
```json
{{"patent_number":"{pub}","claims":[{{"claim_number":1,"type":"independent","text_en":"原文","text_ja":"日本語訳"}}]}}
```
type は independent または dependent。全請求項を漏れなく含めること。"""

def run_curl(pub):
    out_file = OUT_DIR / f"{pub}.json"
    if out_file.exists():
        log(f"[SKIP] {pub}")
        return json.loads(out_file.read_text())

    log(f"\n{'='*50}\n[START] {pub}")

    body = json.dumps({
        "modelName": "snorbe-fast",
        "inputText": PROMPT.format(pub=pub),
        "promptKey": "chat-routing",
        "locale": "ja",
    })

    cmd = [
        "curl", "-N", "-s",
        "-X", "POST", f"{BASE}/agent/run/stream",
        "-H", f"Authorization: Bearer {API_KEY}",
        "-H", "Content-Type: application/json",
        "-H", "Accept: text/event-stream",
        "-d", body,
        "--max-time", "300",
    ]

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    complete_text = ""
    run_id = None

    for raw in proc.stdout:
        line = raw.decode("utf-8", errors="replace").rstrip()
        if not line.startswith("data: "):
            continue
        try:
            ev = json.loads(line[6:])
        except:
            continue
        etype = ev.get("type")
        payload = ev.get("payload", {})

        if etype == "config":
            run_id = payload.get("runId")
            log(f"  runId: {run_id}")
        elif etype == "skill-delta":
            log(f"  [skill: working...]")
        elif etype == "skill-complete":
            log(f"  [skill: complete]")
        elif etype == "complete":
            complete_text = payload.get("text", "")
            log(f"  [DONE] len={len(complete_text)}")
            break
        elif etype == "error":
            log(f"  [ERROR] {payload.get('message')}")
            return None

    proc.wait()

    # JSON 抽出
    result = {"patent_number": pub, "raw": complete_text, "claims": []}
    if "```json" in complete_text:
        try:
            js = complete_text.split("```json")[1].split("```")[0].strip()
            result = json.loads(js)
            log(f"  [PARSED] {len(result.get('claims', []))} claims")
        except Exception as e:
            log(f"  [WARN] parse error: {e}")
    else:
        # skill 経由の場合、JSON がそのまま返るケースもある
        try:
            result = json.loads(complete_text)
            log(f"  [PARSED directly] {len(result.get('claims', []))} claims")
        except Exception:
            pass

    out_file.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    log(f"  [SAVED] {out_file}")
    return result

all_results = []
for pub in PATENTS:
    r = run_curl(pub)
    if r:
        all_results.append(r)
    time.sleep(2)  # レート制限対策

(OUT_DIR / "all_claims.json").write_text(json.dumps(all_results, ensure_ascii=False, indent=2))
log(f"\n=== ALL DONE: {len(all_results)} patents ===")
LOG.close()
```

## 実行

```bash
export SNORBE_API_KEY=snorbe_xxxxxxx
PYTHONUNBUFFERED=1 python3 extract_claims.py
```

長時間実行なので:
1. Claude Code で `run_in_background: true` で実行
2. 別ターミナル（または `Monitor` ツール）で `tail -f /tmp/patent_claims/progress.log`
3. 各特許 10〜30秒。9件で総計 2〜5 分

## CSV に集約する

```python
import json, csv
from pathlib import Path

OUT_DIR = Path("/tmp/patent_claims")
rows = []
for f in sorted(OUT_DIR.glob("*.json")):
    if f.name == "all_claims.json":
        continue
    data = json.loads(f.read_text())
    for claim in data.get("claims", []):
        rows.append({
            "patent_number": data["patent_number"],
            "claim_number": claim.get("claim_number"),
            "type": claim.get("type"),
            "text_en": claim.get("text_en", ""),
            "text_ja": claim.get("text_ja", ""),
        })

with open(OUT_DIR / "all_claims.csv", "w", newline="", encoding="utf-8-sig") as f:
    writer = csv.DictWriter(f, fieldnames=["patent_number","claim_number","type","text_en","text_ja"])
    writer.writeheader()
    writer.writerows(rows)
```

## 画像との紐付け（発展）

Google Patents の Description には `FIG. N` の参照と、各請求項に `(1)` `(50)` などの参照符号が入っている。画像と請求項の対応を取るには:

1. `google_patents_details` API の `figures` フィールドから画像 URL を取得
2. 各請求項の `text_en` から参照符号を正規表現で抽出（`\(\d+\)`）
3. Description の各 FIG 説明文に登場する参照符号と突き合わせ

プロンプト例:
````
google-patents-search スキルを使って、patent_id={公開番号} の figures 情報を取得し、
請求項と図面の対応を以下の JSON で返して:
```json
{
  "claim_refs": [
    { "claim_number": 1, "reference_numbers": ["1", "4", "5", "50"] }
  ],
  "figure_refs": [
    { "figure": "FIG. 1", "reference_numbers": ["1", "4"], "caption": "..." }
  ]
}
```
````

## 注意点

- **プロンプトに「google-patents-search スキルを使って」を明示**（`browse` に誤ルーティングされないように）
- **「他テキスト不要」を強く書く**（前置きが入ると JSON パース失敗）
- **レート制限**: SerpApi 無料枠は月100回。`detail_count` に注意
- **再実行性**: 成功したファイルは `if out_file.exists()` でスキップ
- **失敗時の回収**: `runId` をログに残しておけば `GET /chat/list` で事後回収可能

## トラブルシューティング

| 症状 | 原因・対処 |
|------|-----------|
| SSE が流れない | Python `requests` → `curl` サブプロセスに切り替え |
| `[WARN] parse error` | プロンプトを強化（「他テキスト不要」明示） |
| 請求項が空（`claims: []`） | SerpApi 側にデータがない可能性。`browse` で再試行 |
| 翻訳品質が低い | `modelName` を `snorbe-quality` または `claude-sonnet-4-6` に |
| 途中で切断 | `runId` を使って `/agent/run/stream/{runId}` でレジューム、または `/chat/list` で回収 |
| `skill` が発火せず `browse` になる | プロンプトの先頭に「google-patents-search スキルを使って」を追加 |
