# ファイル添付 (2-step signed URL upload)

エージェント実行 (`POST /agent/run/stream` / `POST /agent/run`) に **添付ファイル** を 渡す ため の 2-step API。ローカル ファイル (PDF/CSV/画像/音声 等) を Supabase Storage に upload し、返却された 署名済 URL を `fileUrls` として 実行 リクエスト に セット する。

Web UI (snorbe-app) の 「ファイル追加」ボタン と 同じ ストレージ を 共有 する ので、UI 経由 upload / API 経由 upload の 区別 なく エージェント から 参照 できる。

## 全体 フロー

```
[client]                                [snorbe API]           [Supabase Storage]
   │                                        │                        │
   │  POST /file/upload/prepare             │                        │
   │  {files: [{fileName, mimeType,         │                        │
   │           sizeBytes}, ...]}            │                        │
   │───────────────────────────────────────▶│                        │
   │                                        │  createSignedUploadUrl │
   │                                        │───────────────────────▶│
   │  [uploadId, signedUploadUrl,           │                        │
   │   tempPath, finalPath, expiresAt]      │                        │
   │◀───────────────────────────────────────│                        │
   │                                                                 │
   │  PUT <signedUploadUrl>                                          │
   │  (ファイル本体 バイナリ)                                          │
   │────────────────────────────────────────────────────────────────▶│
   │                                                                 │
   │  POST /file/upload/commit              │                        │
   │  {uploads: [{uploadId, tempPath,       │                        │
   │            finalPath, ...}, ...]}      │                        │
   │───────────────────────────────────────▶│                        │
   │                                        │  move temp→final       │
   │                                        │  createSignedUrl       │
   │                                        │───────────────────────▶│
   │  [{url, fileName, ...}]                │                        │
   │◀───────────────────────────────────────│                        │
   │                                                                 │
   │  POST /agent/run/stream                                         │
   │  {inputText, fileUrls: [<url1>, ...]}                           │
   │───────────────────────────────────────▶│                        │
```

## 対応 拡張子・サイズ

| カテゴリ | 拡張子 | 上限サイズ |
|---|---|---|
| ドキュメント | `.pdf` `.doc` `.docx` `.csv` `.xlsx` `.xls` `.ppt` `.pptx` | 50MB |
| プレーンテキスト | `.txt` `.html` `.md` `.xml` | 50MB |
| 画像 | `.jpg` `.jpeg` `.png` | 5MB |
| 音声 | `.webm` `.wav` `.mp3` `.m4a` `.opus` | 50MB |

- 1 リクエスト で **最大 10 ファイル**
- signed upload URL の 有効期限: **24 時間** (`PENDING_UPLOAD_TTL_MS`)
- 最終 download URL の 有効期限: **7 日** (`SIGNED_URL_EXPIRY_SECONDS`)
- 期限切れ の 未 commit upload は 定期 cleanup で 削除

## POST /file/upload/prepare

signed upload URL を 発行 する。ファイル 本体 は まだ upload されない。

### リクエスト

```bash
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/file/upload/prepare" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "cmXXXXXXX",
    "files": [
      {"fileName": "wave_patents.csv", "mimeType": "text/csv", "sizeBytes": 45678},
      {"fileName": "figure_A.png", "mimeType": "image/png", "sizeBytes": 320000}
    ]
  }'
```

### レスポンス

```json
{
  "success": [
    {
      "uploadId": "clxxx001",
      "fileName": "wave_patents.csv",
      "mimeType": "text/csv",
      "sizeBytes": 45678,
      "bucketName": "app-files",
      "signedUploadUrl": "https://xxxx.supabase.co/storage/v1/upload/sign/app-files/temp/...?token=...",
      "tempPath": "temp/clxxx001/wave_patents.csv",
      "finalPath": "workspaces/cmXXXXXXX/uploads/clxxx001/wave_patents.csv",
      "expiresAt": "2026-07-11T12:00:00Z"
    },
    { "...": "..." }
  ],
  "failed": []
}
```

- `workspaceId` は 必須。API キー の workspace と 一致 しない と 403
- 拡張子 が サポート外 だと 400 (エラーメッセージ に 対応 拡張子 一覧 が 入る)
- サイズ 上限 超過 だと 400 (画像 5MB / 他 50MB)

## PUT <signedUploadUrl>

Supabase Storage に **直接** ファイル 本体 を upload。snorbe バックエンド は 経由しない (帯域節約)。

```bash
curl -X PUT "<signedUploadUrl 上記レスポンス>" \
  -H "Content-Type: text/csv" \
  --data-binary "@wave_patents.csv"
```

- HTTP 200 で 成功、他 は Supabase の エラー
- Content-Type ヘッダ は prepare 時 の mimeType と 一致 させる
- 大きい ファイル は chunk 分割 不要 (単一 PUT で OK)

## POST /file/upload/commit

upload 済 の temp ファイル を final path に 移動し、agent-run で 参照 できる URL を 返却。

### リクエスト

```bash
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/file/upload/commit" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "cmXXXXXXX",
    "uploads": [
      {
        "uploadId": "clxxx001",
        "fileName": "wave_patents.csv",
        "mimeType": "text/csv",
        "sizeBytes": 45678,
        "bucketName": "app-files",
        "tempPath": "temp/clxxx001/wave_patents.csv",
        "finalPath": "workspaces/cmXXXXXXX/uploads/clxxx001/wave_patents.csv"
      }
    ]
  }'
```

`prepare` の レスポンス を そのまま `uploads` に 詰める。

### レスポンス

```json
[
  {
    "uploadId": "clxxx001",
    "fileName": "wave_patents.csv",
    "url": "https://xxxx.supabase.co/storage/v1/object/sign/app-files/workspaces/cmXXXXXXX/uploads/clxxx001/wave_patents.csv?token=..."
  }
]
```

- 返された `url` を `POST /agent/run/stream` の `fileUrls: [url]` に セット
- URL 有効期限 は 7 日、期限切れ 後 は 再 commit or refresh 必要 (`referencedFileUrls` 経由 なら 自動 refresh される)
- commit 失敗 は 主に「upload 未完了」or「tempPath に ファイル 無し」= 事前 に PUT が 200 で 完了 している ことを 確認

## POST /agent/run/stream (fileUrls 付き)

上記 で 得た URL を エージェント 実行 に セット する 完成 形。

```bash
curl -N -s -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/stream" \
  -H "Authorization: Bearer snorbe_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
    "inputText": "添付 CSV の 列構成 を 要約 し、欠損値 の 多い 列 を リスト して。",
    "modelName": "snorbe-quality",
    "promptKey": "chat-routing",
    "locale": "ja",
    "fileUrls": [
      "https://xxxx.supabase.co/storage/v1/object/sign/app-files/.../wave_patents.csv?token=..."
    ]
  }'
```

- `fileUrls` は 最大 10 個
- `inputText` は 空 でも OK (ファイル だけ 渡して 「これ 何?」と 聞く場合)。ただし `inputText.trim() || fileUrls.length > 0` が バリデーション 条件 なので どちらか は 必要
- エージェント は ファイル を 開いて `inputText` の 指示 と 突き合わせて 分析 する

## エラー

| ステータス | 原因 | 対処 |
|---|---|---|
| 400 | 拡張子 サポート外 / サイズ 超過 / ファイル数 超過 | エラーメッセージ 見て 対応 |
| 401 | API キー 無効 | `Authorization` ヘッダ 確認 |
| 403 | workspaceId が API キー の workspace と 不一致 | 正しい workspaceId を セット |
| 429 | レート制限 (100 req/min) | back off + retry |

## クリーンアップ (定期実行)

commit されずに 24 時間 経過 した pending upload は 自動 クリーンアップ される (`cleanupExpiredUploadsScheduled`)。手動 で cleanup を trigger する 場合 は `automationApiKeyProcedure` 経由 (通常 不要)。

## 関連 資料

- [capabilities.md#ファイル添付-fileurls](../capabilities.md) — 全体 位置づけ
- [recipes/attach-files-to-agent.md](../recipes/attach-files-to-agent.md) — 完成 ワークフロー (シェル + Python の 実例)
- [reference/agent-streaming.md](agent-streaming.md) — `fileUrls` を 受け取る 実行 API 本体
