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

## ツール一覧 API

実行時に最新のツール定義を取得するには `GET /agent/tools` を呼ぶ（認証不要）。
このドキュメントのハードコードされた一覧よりも **API の返値が正**。

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/agent/tools"
```

レスポンス（抜粋）:

```json
{
  "tools": [
    {
      "id": "search",
      "displayName": "Web Search",
      "category": "research",
      "description": "General web search with query generation, SERP selection, scraping, and summary."
    },
    {
      "id": "plan",
      "displayName": "Plan",
      "category": "generation",
      "description": "Draft a multi-step research plan for human review before executing the full workflow."
    }
  ]
}
```

`category` は `research` / `generation` / `hitl` / `agent_integration` / `internal` のいずれか。

ツールメタ（`displayName` / `category` / `description` / `trigger` / `flow` / `sseEvents` など）の正本は**各ツール実装ファイル側**。例: `search` なら `features/agent-run/api/tools/search-tool.ts` の `searchToolMeta`、`plan` なら `plan-tool.ts` の `planToolMeta`。`tool-catalog.ts` はこれらを `Record<ToolName, ToolCatalogEntry>` で集約するレジストリで、`TOOL_NAMES` に定義されたツールが全て揃っていないと型エラーになる。下記の「ツール一覧」セクションはこのレジストリから自動生成される。

## カスタムスキル一覧 API

ワークスペースで有効化（またはインストール）されているカスタムスキルを取得するには `GET /skill/list`（API キー必須）。

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/skill/list" \
  -H "Authorization: Bearer $SNORBE_API_KEY"
```

レスポンス例:

```json
[
  {
    "id": "cl123abc",
    "name": "Patent Search",
    "description": "Patent search workflow",
    "enabled": true,
    "isOfficial": false
  }
]
```

`storagePath` など内部実装の識別子はレスポンスに含まれない。エージェントに「どのスキルが使えるか」を事前に把握させたい場合や、UI にバッジを出したい場合に使う。

## ツール一覧（全 28 種）

下記はツール実装ファイル内の `xxxToolMeta` 定数から自動生成される。手動編集は不要で、各ツールファイル（例: `features/agent-run/api/tools/search-tool.ts`）の meta を更新し `pnpm gen:tool-list` を実行すれば再生成される。

<!-- AUTOGEN:tool-catalog:START -->
### research (7)

#### `search` — Web Search

General web search with query generation, SERP selection, scraping, and summary.

**Trigger**: Single-target investigation or queries that include a latest/recent time dimension.

**Flow**:
1. generate-search-queries
2. SERP
3. select-serp
4. scrape
5. summarize

**SSE events**:
`search-query-generation-start` / `search-query-generated` / `search-results` / `search-image-results` / `search-selection` / `search-scraping` / `search-summary-start` / `search-summary-delta` / `search-summary-complete`

#### `x_search` — X Search

Search posts on X (Twitter) with optional date range and account filters.

**Trigger**: 「X で」「Twitter で」を明示。SNS 反応が必要な場合。

**Inputs**: query, fromDate, toDate, xHandles (指定アカウント)

**SSE events**:
`x-search-start` / `x-search-summary-delta` / `x-search-result`

#### `browse` — Browser Automation

Automate a browser for logins, complex interactions, and screenshot-based verification.

**Trigger**: ビジュアル確認が必要、ログイン、複雑な Web 操作。

**SSE events**:
`browse-start` / `browse-step` / `browse-ask-human` / `browse-final` / `browse-end`

**Notes**: `browse-ask-human` 受信時は `/browser/answer-question` に回答。その後レジューム不要。スクリーンショット付き。

#### `browse_harness` — Browser Harness

Create or update reusable browser automation skills (harness). Live viewer available during execution.

**Trigger**: スキルとして保存、繰り返し自動化、Live viewer で確認したい。

**SSE events**:
`browse-harness-start` / `browse-harness-step` / `browse-harness-final` / `browse-harness-end`

**Notes**: browser-harness は bha-{host}-{slug} 形式でスキルを保存。done イベントで skill changes が DB に永続化される。

#### `source_summary` — Source Summary

Summarize one or more URLs or uploaded files with caching and error reporting.

**Trigger**: inputText 中に URL。fileUrls[] にファイル指定あり。

**Inputs**: urls[]。キャッシュ状態・エラーも返す。

**SSE events**:
`source-summary-start` / `source-summary-delta` / `source-summary-item` / `source-summary-complete`

#### `extract_related_urls` — Extract Related URLs

Discover related URLs from a site, deduplicated and trimmed.

**Trigger**: 「サイトマップ」「リンク全部」等。

**Inputs**: urls[]。重複排除とトリミング適用。

**SSE events**:
`extract-related-urls-start` / `extract-related-urls-progress` / `extract-related-urls-complete`

#### `recall` — Recall

Retrieve prior knowledge from the workspace via similarity, knowledge-gap, or catalog recall.

**Trigger**: 「過去の」「前回の」「既存資料で」。

**Inputs**: targetEntities[] で絞り込み可能。

**Modes**: `similarity` / `knowledge_gap` / `catalog`

**SSE events**:
`rag-keyword-extraction-start` / `rag-keyword-extraction-complete` / `rag-entity-search-progress` / `rag-knowledge-gap-start` / `rag-knowledge-gap-progress` / `rag-knowledge-gap-complete` / `rag-knowledge-gap-merge` / `rag-catalog-recall-start` / `rag-catalog-recall-progress` / `rag-catalog-recall-complete` / `rag-catalog-recall-merge` / `rag-source-pre-filter` / `rag-source-search-progress` / `rag-context-complete`

### generation (5)

#### `plan` — Plan

Draft a multi-step research plan for human review before executing the full workflow.

**Trigger**: 複数ステップ、試行錯誤が必要、検索+レポート組み合わせ。

**Flow**:
1. planTool → first-plan event (draft + questions)
2. user responds: regenerate_plan / confirm_plan / abort_plan
3. after confirm, Plan Mode starts (search/browse enabled)

**SSE events**:
`first-plan` / `regenerated-plan` / `plan-confirmed` / `plan-rejected` / `user-answer` / `plan-draft-delta` / `plan-draft-complete`

#### `report` — Report

Generate a structured long-form report through a draft → confirmation → section writing flow.

**Trigger**: 長文ドキュメント、報告書、原稿。

**Flow**:
1. reportTool → first_report_structure (sections + questions)
2. regenerate / confirm / abort
3. after confirm, each section is written via recall + generate_report_section

**SSE events**:
`first_report_structure` / `regenerated_report_structure` / `report_structure_confirmed` / `report_structure_rejected` / `report-structure-draft-delta` / `report-structure-draft-complete` / `report-section-start` / `report-section-delta` / `report-section-complete`

#### `generate_report_structure` — Generate Report Structure

Produce the initial section outline for a report.

#### `generate_report_section` — Generate Report Section

Write an individual report section after the structure is confirmed.

#### `matrix` — Matrix

Generate or edit a matrix-style comparison table through a draft → confirmation flow.

**Trigger**: 「比較表」「マトリクス」「表形式で」「CSVに追記」「表を埋める」「列を足す」。

**Modes**: `create` / `edit` / `continue`

**Flow**:
1. matrixTool → first_matrix_structure (columns + initial rows + questions)
2. regenerate / confirm / abort
3. after confirm, each row is populated via recall + search/browse

**SSE events**:
`first_matrix_structure` / `regenerated_matrix_structure` / `matrix_structure_confirmed` / `matrix_structure_rejected` / `matrix-structure-draft-delta` / `matrix-structure-draft-complete` / `matrix-data-updated` / `matrix-data-preview` / `matrix-data-completed` / `matrix-generation-progress`

**Notes**: 外部 HITL 操作は `/agent/run/{runId}/matrix/answer` / `/confirm` を直接叩く必要がある（LLM 経由の専用ツールなし）。

### hitl (12)

#### `regenerate_plan` — Regenerate Plan

Regenerate a plan draft with user feedback.

#### `confirm_plan` — Confirm Plan

Confirm a plan draft and start execution.

#### `confirm_plan_with_changes` — Confirm Plan with Changes

Apply minor changes and immediately start execution.

#### `abort_plan` — Abort Plan

Abort the current plan workflow.

#### `regenerate_report_structure` — Regenerate Report Structure

Regenerate the report outline with user feedback.

#### `confirm_report_structure` — Confirm Report Structure

Confirm the report outline and begin section-by-section writing.

#### `confirm_report_structure_with_changes` — Confirm Report Structure with Changes

Apply minor structural edits and immediately begin section writing.

#### `abort_report` — Abort Report

Abort the current report workflow.

#### `regenerate_matrix_structure` — Regenerate Matrix Structure

Regenerate the matrix column/row structure with user feedback.

#### `confirm_matrix_structure` — Confirm Matrix Structure

Confirm the matrix structure and begin populating cells.

#### `confirm_matrix_structure_with_changes` — Confirm Matrix Structure with Changes

Apply minor structural edits and immediately begin data extraction.

#### `abort_matrix` — Abort Matrix

Abort the current matrix workflow.

### agent_integration (3)

#### `refresh_agent_memory` — Refresh Agent Memory

Update the agent's durable memory with insights from the current conversation.

**Notes**: エージェントの durable 記憶を明示更新（会話から得た洞察を永続化）。

#### `mention_agent` — Mention Agent

Hand off work to another agent referenced in the input via agent:// mention.

**Trigger**: `[AgentName](agent://agentId)` が inputText 内に含まれる。

**Notes**: 指名 Agent に引き継ぎ。親 run 完了後、子 run が自動起動。

#### `skill` — Skill

Invoke a workspace-enabled custom skill to extend agent capabilities.

**Trigger**: ワークスペースで有効化したカスタムスキルを呼ぶ場合。

**SSE events**:
`skill-delta` / `skill-complete` / `skill-error` / `skill-ask-secret` / `skill-session-start` / `skill-source-*`

### internal (5)

#### `answer_browser_question` — Answer Browser Question

Respond to a browse tool question that pauses the browser session.

**Notes**: browse ツール内部の下請け。chat-routing からは直接呼ばれない。

#### `send_browser_instruction` — Send Browser Instruction

Send additional natural-language instructions into an ongoing browse session.

**Notes**: browse ツール内部の下請け。chat-routing からは直接呼ばれない。

#### `extract_graph` — Extract Graph

Extract entities and relationships from sources and persist them to the knowledge graph.

**Trigger**: ソース要約後に自動発火（明示呼び出しも可）。

**SSE events**:
`graph` / `graph-extraction-entity-delta`

**Notes**: エンティティ・関係を抽出して永続化。`GET /graph/*` で取得可能に。

#### `select_serp` — Select SERP

Internal helper used by search to pick the most relevant SERP entries.

**Notes**: search 内部の下請け（SERP 選別）。chat-routing からは直接呼ばれない。

#### `extract_matrix` — Extract Matrix

Internal helper that extracts cell data from retrieved sources for a matrix row.
<!-- AUTOGEN:tool-catalog:END -->

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

`modelName` は **必須**。以下から選ぶ。**API 経由では原則 `snorbe-fast`（速度重視・推奨デフォルト）または `snorbe-quality`（品質重視）を指定する。** これらはプロンプトごとに Snorbe 内部で最適プロバイダモデルへ自動マッピングされる。

最新の指定可能モデル ID と説明は API から取得できる（認証不要）:

```bash
curl "https://app.snorbe.deskrex.ai/api/v1/agent/models"
# => { defaultModel, recommendedModelIds, models: [{ id, displayName, provider, isRecommended, description }] }
```

個別指定する場合（特定プロバイダに固定する理由がある場合のみ）:

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

エージェント実行後に詳細を回収する主要エンドポイントは `GET /turn/list`。

`turns[].agentRun` に以下が丸ごと入る:
- `process` — SSE イベントの永続化タイムライン全て
- `publicSourceAgentRuns` / `privateSourceAgentRuns` — 参照した URL ソース（`bodyLinks` メタ付き）
- `status` / `agent`

> `runId` を直接指定して取得するには `GET /agent/run/{runId}` を使う。`process`・`linkedSources`・`linkedEntities` を返す。一覧から探す場合は `/turn/list` を降順でページング。

軽量ステータスのみ欲しい場合は `GET /agent/run/{runId}/status`（`pending*Draft` フラグ + `status` のみ、`process` 含まず）。

## グラフ取得

実行のたびに `extract_graph` が自動でエンティティ・関係を抽出・永続化するので、`GET /graph/*` で参照できる:

- `GET /graph/workspace` — ワークスペース全体
- `GET /graph/entities` — エンティティ一覧（検索・フィルタ）
- `GET /graph/edges` — エッジ（リレーション）一覧
- `GET /graph/entity/{entityId}` — エンティティ詳細（AgentRun・リンク先含む）
- `GET /graph/source/{sourceId}` — ソース詳細（本文・リンク・AgentRun・エンティティ含む）
