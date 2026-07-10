# ファイル 添付 で エージェント に 一次資料 を 渡す

## いつ 使うか

- 分析対象 が **手元 の ローカル ファイル** (PDF/CSV/Excel/画像/音声 等) で、Web からは 参照できない
- 分析対象 が Web 上 に あっても **URL 経由 の 取得 が 不安定** (Google Sheets の 制限公開、Notion の 認証壁、社内 Wiki 等)
- **同じ ファイル を 複数 の エージェント / 複数回 の 実行 で 使い回したい** (upload 済 URL を 使い回せる)

`inputText` に URL を 貼って エージェント の browser ツール で 開かせる より、**ローカル export → fileUrls に 添付** の方が 抽出品質・安定性 の 両面 で 圧倒的 に 有利。

## いつ 使わない か

- 対象 が 公開 Web ページ で、参照回数 が 少ない (URL を 直接 `inputText` に 貼れば OK)
- ファイル が エージェント の **ネイティブ サポート外** の 形式 (対応拡張子 は [reference/file-upload.md#対応-拡張子サイズ](../reference/file-upload.md#対応-拡張子サイズ) 参照)

## 全体 の 流れ

```
1. POST /file/upload/prepare  → signed upload URL + uploadId 取得
2. PUT <signedUploadUrl>       → ファイル 本体 を Supabase Storage に upload
3. POST /file/upload/commit    → temp → final path 移動 + 最終 URL 取得
4. POST /agent/run/stream       → fileUrls: [<最終URL>, ...] で 実行
```

## Bash + curl の 実装 (完成形)

```bash
#!/bin/bash
set -uo pipefail

API_BASE="https://app.snorbe.deskrex.ai/api/v1"
KEY="$SNORBE_API_KEY"
WORKSPACE_ID="cmXXXXXXX"   # /workspace で 取得
AGENT_ID="cmYYYYYYY"        # /agent/list で 取得 (省略可 = default)
MODEL="snorbe-quality"

FILE_PATH="./wave_patents.csv"
FILE_NAME=$(basename "$FILE_PATH")
FILE_SIZE=$(wc -c < "$FILE_PATH")
FILE_MIME=$(file --mime-type -b "$FILE_PATH")  # macOS: brew install file (通常入ってる)

# ---- Step 1: prepare ----
PREPARE_RESP=$(curl -s -X POST "$API_BASE/file/upload/prepare" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
        --arg ws "$WORKSPACE_ID" \
        --arg fn "$FILE_NAME" \
        --arg mt "$FILE_MIME" \
        --argjson sz "$FILE_SIZE" \
        '{workspaceId: $ws, files: [{fileName: $fn, mimeType: $mt, sizeBytes: $sz}]}')")

UPLOAD_ID=$(echo "$PREPARE_RESP"     | jq -r '.success[0].uploadId')
SIGNED_URL=$(echo "$PREPARE_RESP"    | jq -r '.success[0].signedUploadUrl')
TEMP_PATH=$(echo "$PREPARE_RESP"     | jq -r '.success[0].tempPath')
FINAL_PATH=$(echo "$PREPARE_RESP"    | jq -r '.success[0].finalPath')
BUCKET=$(echo "$PREPARE_RESP"        | jq -r '.success[0].bucketName')

echo "[prepare] uploadId=$UPLOAD_ID" >&2

# ---- Step 2: PUT to Supabase ----
curl -s -X PUT "$SIGNED_URL" \
  -H "Content-Type: $FILE_MIME" \
  --data-binary "@$FILE_PATH" > /dev/null
echo "[upload] $FILE_NAME uploaded" >&2

# ---- Step 3: commit ----
COMMIT_RESP=$(curl -s -X POST "$API_BASE/file/upload/commit" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
        --arg ws "$WORKSPACE_ID" \
        --arg uid "$UPLOAD_ID" \
        --arg fn "$FILE_NAME" \
        --arg mt "$FILE_MIME" \
        --argjson sz "$FILE_SIZE" \
        --arg bk "$BUCKET" \
        --arg tp "$TEMP_PATH" \
        --arg fp "$FINAL_PATH" \
        '{workspaceId: $ws, uploads: [{uploadId: $uid, fileName: $fn, mimeType: $mt, sizeBytes: $sz, bucketName: $bk, tempPath: $tp, finalPath: $fp}]}')")

FINAL_URL=$(echo "$COMMIT_RESP" | jq -r '.[0].url')
echo "[commit] $FINAL_URL" >&2

# ---- Step 4: エージェント 実行 (fileUrls 付き) ----
INPUT_JSON=$(jq -n \
  --arg ag "$AGENT_ID" \
  --arg it "添付 の CSV を 読み、列 の 分布 と 欠損値 を 要約 して。" \
  --arg mn "$MODEL" \
  --arg pk "chat-routing" \
  --arg lc "ja" \
  --arg url "$FINAL_URL" \
  '{agentId: $ag, inputText: $it, modelName: $mn, promptKey: $pk, locale: $lc, fileUrls: [$url]}')

curl -N -s -X POST "$API_BASE/agent/run/stream" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d "$INPUT_JSON" \
  | while IFS= read -r line; do
      [[ "$line" =~ ^data: ]] || continue
      echo "$line"
    done
```

## Python 実装 (拡張子 判定 込み)

```python
#!/usr/bin/env python3
import json, mimetypes, os, subprocess, sys
from pathlib import Path

API_BASE = "https://app.snorbe.deskrex.ai/api/v1"
API_KEY = os.environ["SNORBE_API_KEY"]
WORKSPACE_ID = "cmXXXXXXX"
AGENT_ID = "cmYYYYYYY"
MODEL = "snorbe-quality"

def upload_files(paths: list[Path]) -> list[str]:
    """複数 ファイル を prepare → PUT → commit で upload し、最終 URL の list を 返す."""
    import urllib.request

    # Step 1: prepare
    files_meta = []
    for p in paths:
        mime, _ = mimetypes.guess_type(p.name)
        files_meta.append({
            "fileName": p.name,
            "mimeType": mime or "application/octet-stream",
            "sizeBytes": p.stat().st_size,
        })
    prep = _post("/file/upload/prepare",
                 {"workspaceId": WORKSPACE_ID, "files": files_meta})
    successes = prep["success"]

    # Step 2: PUT each
    for path, meta in zip(paths, successes):
        with open(path, "rb") as f:
            req = urllib.request.Request(
                meta["signedUploadUrl"],
                data=f.read(),
                method="PUT",
                headers={"Content-Type": meta["mimeType"]},
            )
            urllib.request.urlopen(req).read()  # 200 で成功

    # Step 3: commit
    commit_payload = {
        "workspaceId": WORKSPACE_ID,
        "uploads": [
            {
                "uploadId": s["uploadId"],
                "fileName": s["fileName"],
                "mimeType": s["mimeType"],
                "sizeBytes": s["sizeBytes"],
                "bucketName": s["bucketName"],
                "tempPath": s["tempPath"],
                "finalPath": s["finalPath"],
            }
            for s in successes
        ],
    }
    committed = _post("/file/upload/commit", commit_payload)
    return [c["url"] for c in committed]


def _post(path: str, body: dict) -> dict:
    """gws-cli 依存 なし の 素朴 な POST (subprocess + curl)."""
    r = subprocess.run(
        ["curl", "-s", "-X", "POST", f"{API_BASE}{path}",
         "-H", f"Authorization: Bearer {API_KEY}",
         "-H", "Content-Type: application/json",
         "-d", json.dumps(body, ensure_ascii=False)],
        capture_output=True, text=True, check=True,
    )
    return json.loads(r.stdout)


def run_agent_with_files(text: str, file_paths: list[Path]) -> None:
    urls = upload_files(file_paths)
    print(f"[uploaded] {len(urls)} files", file=sys.stderr)

    payload = {
        "agentId": AGENT_ID,
        "inputText": text,
        "modelName": MODEL,
        "promptKey": "chat-routing",
        "locale": "ja",
        "fileUrls": urls,
    }
    # SSE は curl で 受信 (Python requests は 詰まる)
    proc = subprocess.Popen(
        ["curl", "-N", "-s", "-X", "POST",
         f"{API_BASE}/agent/run/stream",
         "-H", f"Authorization: Bearer {API_KEY}",
         "-H", "Content-Type: application/json",
         "-H", "Accept: text/event-stream",
         "-d", json.dumps(payload, ensure_ascii=False)],
        stdout=subprocess.PIPE, text=True,
    )
    for line in proc.stdout:
        if line.startswith("data:"):
            print(line.rstrip())


if __name__ == "__main__":
    run_agent_with_files(
        text="添付 3 ファイル (CSV + 画像 2枚) を 突き合わせて、CSV の どの WO 番号 が 図 の どの box に 対応 する か 一覧化 して。",
        file_paths=[
            Path("wave_patents.csv"),
            Path("figure_A_timeline.png"),
            Path("figure_B_strategy.png"),
        ],
    )
```

## 典型的 な 使い方 例

### 1. CSV を 添付 して 統計 分析
```
inputText: "添付 CSV の 各 列 の 分布 と、欠損値 の 多い 列 top 5 を 出して。"
fileUrls:  [<data.csv>]
```

### 2. PDF 論文 を 要約
```
inputText: "添付 論文 の method セクション と result の 主要 図表 を 3 段落 で 要約 して。"
fileUrls:  [<paper.pdf>]
```

### 3. 画像 + CSV の クロス 分析 (multi-modal)
```
inputText: "添付 CSV は 特許一覧、添付 PNG は 時系列 マップ。CSV の どの WO 番号 が map の どの box に 対応 する か 表形式 で 出して。"
fileUrls:  [<patents.csv>, <timeline_map.png>]
```

### 4. 音声 の 書き起こし + 分析
```
inputText: "添付 音声 (MTG 録音) を 書き起こし、決定事項 と ToDo に 整理 して。"
fileUrls:  [<meeting.mp3>]
```

## 落とし穴

- ❌ **`prepare` の レスポンス を そのまま `commit` に 渡し忘れる** — `bucketName` / `tempPath` / `finalPath` の 3 つ は 必須。省略 すると 400
- ❌ **PUT の `Content-Type` を 省略** — Supabase が MIME を 拒否 する ケース あり。prepare 時 の mimeType と 一致 させる
- ❌ **`inputText` を 空 に する** — バリデーション は `inputText.trim() || fileUrls.length > 0` なので OK だが、エージェント が 「何を したい か」不明 で 挙動 が ブレる。**最低限 の 指示** は 入れる
- ❌ **同じ ファイル を 毎回 upload** — commit 済 URL は 7 日 有効 なので DB or ローカル に キャッシュ して 使い回す
- ❌ **10 ファイル 超過** — `fileUrls.max(10)` で 400。それ 以上 は 複数 リクエスト に 分割 or `referencedPrivateSourceIds` (max 20) を 使う

## 関連 資料

- [reference/file-upload.md](../reference/file-upload.md) — API 仕様 詳細
- [capabilities.md#ファイル添付-fileurls](../capabilities.md) — 全体 位置づけ
- [recipes/basic-research.md](basic-research.md) — 添付 なし の 基本 リサーチ フロー
