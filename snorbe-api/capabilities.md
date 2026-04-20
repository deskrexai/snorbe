# Snorbe エージェントの能力

エージェントは LLM（`modelName` で指定）が `chat-routing` プロンプトで判断し、以下のツール群から適切なものを呼び出す。呼び出し側は `inputText` を介して**どのツールを使わせたいかを誘導**する。

## ツール選択ロジック

ユーザー入力に含まれる文言で、LLM はおおむね以下のように分岐する:

| 入力に含まれるキーワード・要素 | 発火するツール |
|--------------------------------|----------------|
| 「最新の」「recent」「latest」など時系列要素＋単一調査対象 | `search`（Web 検索） |
| 「X で」「Twitter で」「SNS の反応」 | `x_search` |
| URL を含む / PDF や画像の処理要求 | `source_summary` |
| 「ブラウザで」「ログインして」「フォーム入力」 | `browse` |
| 「サイトマップ」「リンクを全部」 | `extract_related_urls` |
| 「過去の」「前回の」「ファクトチェック」 | `recall`（RAG 検索） |
| 「レポート作成」「報告書」「まとめて」 | `report`（HITL 構造確認） |
| 「比較表」「マトリクス」「表形式で」 | `matrix`（HITL 構造確認） |
| 複数ステップ・試行錯誤が要る複雑タスク | `plan`（HITL 確認） |
| `[AgentName](agent://agentId)` 形式の mention | `mention_agent` |
| `<matrix_selection>` コンテキストあり | `matrix` (mode="edit") 強制 |
| 上記いずれにも該当しない一般知識質問 | 直接応答（ツールなし） |

プロンプト設計で挙動を狙う方法は [prompting.md](prompting.md) 参照。

## ツール一覧（22種）

### 情報収集系（6種）

#### `search` — Web 検索
**トリガ**: 単一対象の調査、時系列要素（latest/recent）がある。
**内部動作**: `generate-search-queries` → SERP → `select-serp` → スクレイプ → 要約。
**関連 SSE イベント**:
```
search-query-generation-start / search-query-generated
search-results / search-image-results / search-selection
search-scraping / search-summary-start / search-summary-delta / search-summary-complete
```

#### `x_search` — X（Twitter）検索
**トリガ**: 「X で」「Twitter で」を明示。SNS 反応が必要な場合。
**入力**: `query`, `fromDate`, `toDate`, `xHandles`（指定アカウント）。
**関連 SSE**: `x-search-start` / `x-search-summary-delta` / `x-search-result`

#### `source_summary` — URL/ファイル要約
**トリガ**: `inputText` 中に URL。`fileUrls[]` にファイル指定あり。
**入力**: `urls[]`。キャッシュ状態・エラーも返す。
**関連 SSE**: `source-summary-start` / `source-summary-delta` / `source-summary-item` / `source-summary-complete`

#### `browse` — ブラウザ自動化
**トリガ**: ビジュアル確認が必要、ログイン、複雑な Web 操作。
**特徴**: スクリーンショット付き、ユーザーへの質問可能（`browse-ask-human`）。
**関連 SSE**:
```
browse-start（websocketInfo 含む）
browse-step（action・screenshot）
browse-ask-human（status:"pending", question）
browse-final（結果） / browse-end
```

`browse-ask-human` 受信時は `/browser/answer-question` に回答。その後レジューム不要。

#### `extract_related_urls` — サイト構造抽出
**トリガ**: 「サイトマップ」「リンク全部」等。
**入力**: `urls[]`。重複排除とトリミング適用。
**関連 SSE**: `extract-related-urls-start` / `extract-related-urls-progress` / `extract-related-urls-complete`

#### `recall` — RAG 検索（ワークスペース内）
**トリガ**: 「過去の」「前回の」「既存資料で」。
**モード**: `similarity` / `knowledge_gap` / `catalog`。`targetEntities[]` で絞り込み可能。
**関連 SSE**:
```
rag-keyword-extraction-start / rag-keyword-extraction-complete
rag-entity-search-progress
rag-knowledge-gap-start / rag-knowledge-gap-progress / rag-knowledge-gap-complete / rag-knowledge-gap-merge
rag-catalog-recall-start / rag-catalog-recall-progress / rag-catalog-recall-complete / rag-catalog-recall-merge
rag-source-pre-filter / rag-source-search-progress
rag-context-complete
```

### 複合調査・計画系（3種・HITL）

#### `plan` — リサーチ計画の HITL 確認
**トリガ**: 複数ステップ、試行錯誤が必要、検索+レポート組み合わせ。
**フロー**:
```
1. planTool → first-plan イベント（ドラフト + 質問）
2. ユーザー応答: regenerate_plan / confirm_plan / abort_plan
3. confirm 後、Plan Mode 起動（検索・ブラウズ許可）
```
**関連 SSE**: `first-plan` / `regenerated-plan` / `plan-confirmed` / `plan-rejected` / `user-answer` / `plan-draft-delta` / `plan-draft-complete`

#### `report` — 構造化レポートの HITL 生成
**トリガ**: 長文ドキュメント、報告書、原稿。
**フロー**:
```
1. reportTool → first_report_structure（セクション配列 + 質問）
2. regenerate / confirm / abort
3. confirm 後、各セクションを recall + generate_report_section で順次執筆
```
**関連 SSE**: `first_report_structure` / `regenerated_report_structure` / `report_structure_confirmed` / `report_structure_rejected` / `report-structure-draft-delta` / `report-structure-draft-complete` / `report-section-start` / `report-section-delta` / `report-section-complete`

#### `matrix` — マトリクス表の HITL 生成・編集
**トリガ**: 「比較表」「マトリクス」「表形式で」。
**モード**: `create` / `edit`（セル選択編集） / `continue`（行追加）
**フロー**:
```
1. matrixTool → first_matrix_structure（カラム定義・初期行 + 質問）
2. regenerate / confirm / abort
3. confirm 後、各行データを recall + search/browse で抽出
```
**関連 SSE**: `first_matrix_structure` / `regenerated_matrix_structure` / `matrix_structure_confirmed` / `matrix_structure_rejected` / `matrix-structure-draft-delta` / `matrix-structure-draft-complete` / `matrix-data-updated` / `matrix-data-preview` / `matrix-data-completed` / `matrix-generation-progress`

### HITL 操作ツール（6種・LLM が自己呼び出し）

| ツール名 | 用途 |
|----------|------|
| `confirm_plan` / `regenerate_plan` / `abort_plan` | plan 確認・再生成・キャンセル |
| `confirm_report_structure` / `regenerate_report_structure` / `abort_report` | report 構造確認・再生成・キャンセル |

※ マトリクスは外部から直接 `/agent/run/{runId}/matrix/answer` / `/confirm` を叩く必要がある（LLM 経由の専用ツールなし）。

### エージェント連携・特殊ツール（4種）

#### `mention_agent`
**トリガ**: `[AgentName](agent://agentId)` が `inputText` 内。
**動作**: 指名 Agent に引き継ぎ。親 run 完了後、子 run が自動起動。

#### `skill`
**トリガ**: ワークスペースで有効化したカスタムスキルを呼ぶ場合。
**関連 SSE**: `skill-delta` / `skill-complete` / `skill-error` / `skill-ask-secret` / `skill-session-start` / `skill-source-*`

#### `refresh_agent_memory`
**用途**: エージェントの durable 記憶を明示更新（会話から得た洞察を永続化）。

#### `extract_graph`
**トリガ**: ソース要約後に自動発火（明示呼び出しも可）。
**動作**: エンティティ・関係を抽出して永続化。`GET /graph/*` で取得可能に。
**関連 SSE**: `graph` / `graph-extraction-entity-delta`

### 内部ツール（3種・外部からは見えない）

`answer_browser_question` / `send_browser_instruction` / `select_serp` — それぞれ browse・search 内部の下請け。chat-routing からは直接呼ばれない。

## HITL 生成物の扱い方

`plan`・`report`・`matrix` は **ドラフト → ユーザー確認 → 本実行** の2段構え。

### HITL エンドポイント

| 目的 | エンドポイント |
|------|----------------|
| プラン質問に回答 | `POST /agent/run/{runId}/plan/answer` |
| プラン確定 | `POST /agent/run/{runId}/plan/confirm` |
| プランスキップ | `POST /agent/run/{runId}/plan/skip` |
| レポート質問に回答 | `POST /agent/run/{runId}/report/answer` |
| レポート確定 | `POST /agent/run/{runId}/report/confirm` |
| マトリクス質問に回答 | `POST /agent/run/{runId}/matrix/answer` |
| マトリクス確定 | `POST /agent/run/{runId}/matrix/confirm` |

確定後は `POST /agent/run/stream/{runId}` または `/agent/run/{runId}/resume` で本実行を再開。

### SSE で検知する方法

SSE 受信中に以下のパターンを見たら HITL 待ち:
- `step.pendingPlanDraft: true` → plan 待ち
- `step.pendingReportDraft: true` → report 待ち
- `step.pendingMatrixDraft: true` → matrix 待ち
- `first-plan` / `plan-draft-complete` → plan ドラフト完成
- `first_report_structure` / `report-structure-draft-complete` → report 構造完成
- `first_matrix_structure` / `matrix-structure-draft-complete` → matrix 構造完成

## promptKey（34種）

`inputText` と一緒に送る `promptKey` は原則 `"chat-routing"`（メインのツールルーティング）。
その他の promptKey は内部で各サブタスクから呼ばれるが、**API 呼び出し側が直接指定することはほぼ無い**:

| カテゴリ | promptKey |
|----------|-----------|
| メインルーティング | `chat-routing` ← 外部は原則これ |
| Plan | `plan-creation` / `plan-decision` / `plan-regeneration` / `plan-review` / `reflect-progress` |
| Report | `report-review` / `generate-report-structure` / `generate-report-section` |
| Matrix | `matrix-review` / `generate-matrix-structure` / `matrix-tool-loop` / `extract-matrix` / `reflect-matrix-progress` |
| Search | `generate-search-queries` / `summarize-source` / `answer-search-results` / `select-serp` |
| Graph/RAG | `extract-graph` / `extract-keywords` / `extract-catalog-recall-strategy` / `extract-knowledge-gap-strategy` / `merge-entity-descriptions` |
| Browse | `send-browser-instruction` / `answer-browser-question` / `browse-task` |
| その他 | `x-search` / `classify-feedback` / `classify-mention-dispatch` / `refresh-agent-memory` / `compaction-summary` / `analyze-dashboard` |

## 使えるモデル

`modelName` は以下から選ぶ。推奨は `snorbe-fast`（速さ重視）/ `snorbe-quality`（品質重視）— これらは内部で最適モデルに自動マッピング。

個別指定する場合:

| プロバイダ | モデル名例 |
|------------|------------|
| Anthropic Claude | `claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5` |
| OpenAI | `gpt-5-mini-2025-08-07` / `gpt-4o-2024-11-20` / `gpt-4o-mini` |
| Google Gemini | `gemini-3.1-pro` / `gemini-3.1-flash` / `gemini-2.5-pro` |
| DeepSeek | `deepseek-chat` / `deepseek-reasoner` |
| xAI Grok | `grok-4` / `grok-4-fast` / `grok-3` |
| Llama | `llama-3.3-70b` / `llama-3.1-8b` |
| Qwen | `qwen-2.5-72b` |

定義元: `snorbe-app/src/constants/llm-model.ts`

## 事後取得（ラン完了後の詳細データ）

エージェント実行後に詳細を回収する主要エンドポイントは `GET /chat/list`。

`chats[].agentRun` に以下が丸ごと入る:
- `process` — SSE イベントの永続化タイムライン全て
- `publicSourceAgentRuns` / `privateSourceAgentRuns` — 参照した URL ソース（`bodyLinks` メタ付き）
- `status` / `agent`

> `runId` を直接指定して取得するエンドポイントは未提供。特定の `runId` を探すには `/chat/list` を降順でページング。

軽量ステータスのみ欲しい場合は `GET /agent/run/{runId}/status`（`pending*Draft` フラグ + `status` のみ、`process` 含まず）。

## グラフ取得

実行のたびに `extract_graph` が自動でエンティティ・関係を抽出・永続化するので、`GET /graph/*` で参照できる:

- `GET /graph/workspace` — ワークスペース全体
- `GET /graph/entities` — エンティティ一覧（検索・フィルタ）
- `GET /graph/edges` — エッジ（リレーション）一覧
