# プロンプト設計（inputText の書き方）

Snorbe の挙動は `inputText` の書き方でほぼ決まる。LLM が `chat-routing` プロンプトで**ツール選択**を行うため、**どのツールを使わせたいかを明示的に誘導**するのが最重要。

## 原則

1. **ツールを誘導するキーワードを入れる**（[capabilities.md](capabilities.md) の選択ロジック参照）
2. **出力形式を明示する**（自然文なら日本語/英語指定、構造化なら JSON Schema を示す）
3. **ソースを明示する**（「Google Patents で」「公式サイトで」）
4. **ユーザーが必要ない情報（思考過程・所感）は除外するよう指示**
5. **短すぎる `inputText` は避ける**（ツール選択がブレる）

## ツール別 inputText パターン

### Web 検索（`search`）

```
半導体の最新トレンドを調査してください。公開されている市場調査レポートを
主なソースとし、2024 年以降のデータに限定して日本語でまとめて。
```

誘導要素:
- 「最新」「2024 年以降」→ 時系列要素 → `search` 発火
- 「日本語でまとめて」→ 出力言語指定

### ブラウザ自動化（`browse`）

```
https://patents.google.com/patent/WO2012014047A1/en にブラウザでアクセスし、
「Claims」タブを展開して全請求項の英文テキストを取得して。
```

誘導要素:
- URL + 「ブラウザで」「タブを展開」→ `browse` 発火（`search` では取れない UI 要素が必要）

### 構造化 JSON 出力（推奨パターン）

構造化データを欲しい場合、**出力スキーマを明示**し、Markdown コードブロックで囲むよう指示する:

````
{patent_number} の全請求項を Google Patents から取得し、
以下の JSON 形式のみで出力してください（他のテキスト不要）:

```json
{
  "patent_number": "{patent_number}",
  "claims": [
    {
      "claim_number": 1,
      "type": "independent",
      "text_en": "英語原文",
      "text_ja": "日本語訳"
    }
  ]
}
```

type は independent または dependent。全請求項を漏れなく含めること。
````

ポイント:
- `\`\`\`json ... \`\`\`` で囲む → 受信側で `.split("\`\`\`json")[1].split("\`\`\`")[0]` して `json.loads()`
- 「他のテキスト不要」を明示 → 自由記述の雑音を減らす
- `type` の取りうる値を列挙 → enum 風に扱わせる

### レポート生成（`report` HITL）

```
日本の自動運転業界の 2024 年動向について、以下のセクション構成でレポートを作成して:
1. 市場規模と主要プレイヤー
2. 規制の動き
3. 技術トレンド
4. 今後の見通し
```

誘導要素:
- 「レポート作成」＋「セクション構成で」→ `report` 発火
- HITL: 構造確認 → 応答 or confirm → 各セクション順次生成

### マトリクス生成（`matrix` HITL）

```
InSphero 社の特許（WO2012014047A1, WO2016166315A1, WO2019008189A1）を
以下のカラムで比較マトリクスにしてください:
- 発明の名称
- 独立請求項の数
- 主要な技術要素
- 想定される差別化ポイント
```

誘導要素:
- 「マトリクス」「比較」「カラムで」→ `matrix` 発火
- 具体的なカラム名を列挙 → 構造確認がスムーズ

### RAG（`recall`）

```
ワークスペースに既に登録されている AI チップ関連のエンティティから、
電力効率に関する記述を持つものを列挙して。
```

誘導要素:
- 「ワークスペースに既に」「登録されている」→ `recall` 発火
- `targetEntities[]` や `mentions[]` で明示指定も可

### エージェント指定の選び方（`agentId` vs `mention_agent`）

ユーザーが「〇〇ボットに依頼して」「〇〇さん bot に聞いて」と言ったとき、**どの経路で呼ぶか**を取り違えない。原則は下表:

| ユーザーの言い方 | 解釈 | 正しい呼び方 / 動作 |
|---|---|---|
| 「bot 名なし」 | デフォルト 1 体 | `agentId` 省略（= デフォルトエージェント）、`mentions` なし。確認なし |
| 「X bot に聞いて」（単一明示） | 単一 X | `agentId: "<X の id>"` を直接指定、`inputText` に `[X](agent://...)` を**書かない**。確認なし |
| 「A と B に聞いて」（明示的に複数列挙） | 並列 | 入口はデフォルト（または primary）。`inputText` に `[A](agent://...)` `[B](agent://...)` 両方記載＋ `mentions` に両方。**確認なし** |
| 「A → B にレビューさせて」（順序動詞あり） | 連鎖 | 入口は A（`agentId=A`）。`inputText` に `[B](agent://Bid)` を書く＋ `mentions` に B。**確認なし** |
| 「皆に聞いて」「複数人で」「いろんな視点で」「チームで」「並列で」（曖昧） | **不確定** | `GET /agent/list` で候補一覧を取得し、**ユーザーに確認**。確認なしに分散させない |
| bot 名は出ているが ID 一意解決できない（部分一致複数） | **不確定** | 候補を列挙して**ユーザーに確認**してから投げる |
| デフォルト agent 1 体で済む依頼に複数指名 mention を勝手に足さない | デフォルト | デフォルト 1 体に投げる。mention 無 |

**判断の優先順位**:
1. 単一 bot を明示 (`X bot に`) → そのまま単一実行
2. 複数 bot を明示列挙 (`A と B`) → 並列 (`mentions` 配列)
3. 順序動詞あり (`→` `先に` `その結果を`) → 連鎖
4. **上記以外で「複数」「チーム」「皆」「並列」など曖昧** → 確認
5. ID が一意解決できない → 確認

#### 並列実行 vs エージェント分散（混同注意）

「並列実行」と「異なるエージェントへの分散」は**独立した概念**:

```
並列性          = 同時に複数 POST を投げるかどうか（HTTP リクエストの並行性）
エージェント分散 = どの bot に振り分けるかどうか（agentId が異なる）
```

組み合わせ:

| 並列性 | エージェント | 例 |
|---|---|---|
| 並列 ✓ | 単一bot | デフォルトbotに N個の独立ランを並列で投げる（**bot指名なしの既定値**） |
| 並列 ✓ | 複数bot | A/B/C bot にそれぞれ別タスクを並列で投げる（**明示指名がある場合のみ**） |
| 直列 | 単一bot | デフォルトbotに1ランずつ順番に投げる |
| 直列 | 複数bot（リレー） | A→B のリレー（`mention_agent`） |

「エージェントチームで」「並列で」と言われただけで、**確認なしに複数 bot へ分散させない**。bot 指名がないなら同じデフォルト bot で N 並列が既定値。曖昧なら `GET /agent/list` で利用可能な bot 一覧を提示し、(a)〜(c) のどれかを選んでもらう。

### ID が分からない場合の定石

ユーザーがエージェント名しか知らない／API クライアント側が ID を持っていない場合、**投稿前に必ず `GET /agent/list` を 1 回叩いて名前→ID 変換する**。毎リクエストではなく、必要時にだけ。

```bash
# 1. 一覧取得（認証必須）
curl -s "https://app.snorbe.deskrex.ai/api/v1/agent/list" \
  -H "Authorization: Bearer $SNORBE_API_KEY"
# => [{"id":"cmo...","name":"funaki_san_bot","isDefault":true}, {"id":"cmnu...","name":"itani_san_bot",...}, ...]

# 2. name が一致するエントリの id を取得
#   jq 例: jq -r '.[] | select(.name=="tanaka_san_bot") | .id'

# 3. 単一指名なら agentId に直接セット
curl -X POST "https://app.snorbe.deskrex.ai/api/v1/agent/run/stream" \
  -H "Authorization: Bearer $SNORBE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"agentId":"<解決したid>","modelName":"snorbe-fast","promptKey":"chat-routing","locale":"ja","inputText":"…"}'
```

**名前→ID 解決時の注意:**
- `name` は workspace 内で一意だが、表記ゆれ（大小文字、アンダースコア有無）に備えて完全一致→部分一致の順でマッチする
- 一意に解決できない場合は **ユーザーに確認** してから投げる（当て推量で投げない）
- `isDefault: true` のエージェントが「無指定時のデフォルト」。単に「bot で調査して」としか言われていなければ、これを使う（`agentId` 省略でも同じ挙動）

### マルチエージェント委譲（`mention_agent`）

**リレーが必要なときだけ**使う。単一 bot 指名では使わない。

```
[agent-legal](agent://ag_xxx) に契約条項のレビューを依頼し、
[agent-marketing](agent://ag_yyy) にその結果を受けた販促文章の草案作成を依頼してください。
```

誘導要素:
- `[name](agent://id)` 形式 → `mention_agent` 発火
- 2 体以上なら `parallel` / `chain` を LLM 分類器が判定
- `mentions: [{id, type:"agent", label}]` 配列も併記すると解釈が安定

**アンチパターン:**
- 単一 bot を指名したいだけなのに `[X](agent://...)` を書いてしまう → デフォルト入口が先に走って X に連鎖する二重実行になる。`agentId` 直指定に切り替える
- ユーザーが「並列で」「チームで」と言っただけで、**確認なしに異なる bot へ分散** → bot を分ける必然性がない場合、debug が無駄に煩雑になる。bot 指名がないなら**同じデフォルト bot で N 並列**が既定値
- 「エージェントチーム」を「複数の異なるエージェント」と短絡解釈する → 並列性は同じデフォルト bot で N 並列でも実現できる。曖昧なら**確認を取ってから**実行

## 避けるべき inputText パターン

### ❌ 曖昧すぎる

```
調べて                     ← ツール選択がブレる（search? recall? 判定不能）
まとめて                   ← 対象・出力形式不明
```

### ❌ 矛盾した指示

```
検索せずに最新情報を返して   ← 「検索せず」vs「最新」が矛盾
```

### ❌ ツール誘導が弱い

```
WO2012014047A1 について      ← 「何をするか」が無い（検索? 要約? 構造化?）
```

改善例:
```
WO2012014047A1 の全請求項を Google Patents から取得して JSON で返して
```

## 出力言語の制御

`locale` パラメータと合わせて明示的に書くと安定:

```
日本語で調査し、結論は英語で要約してください。
```

Snorbe の仕様:
- `locale: "ja"` → 日本語プロンプトベース（指示詳細が日本語）
- `locale: "en"` → 英語プロンプトベース
- ユーザーが「英語で」と書けばその通りに従う

## メンション（`mentions[]`）の活用

`inputText` に `@entity` や `@agent-run` を書いても LLM が解釈しないので、必ず `mentions[]` 配列に構造化して渡す:

```json
{
  "inputText": "[GPT-5](entity://e_abc) と類似する技術の特許を調べて",
  "mentions": [
    { "id": "e_abc", "type": "entity", "label": "GPT-5" }
  ]
}
```

`type` の取りうる値:
- `"entity"` — ワークスペース内のエンティティ
- `"agent-run"` — 過去の AgentRun
- `"public-source"` / `"private-source"` — ソース参照
- `"agent"` — 他の Agent（委譲用）

## HITL フローを前提にしたプロンプト

plan / report / matrix を使わせたい場合、**ユーザーが確認ステップに応答する前提**で書く:

```
プラン確認後、以下の順で実行してください:
1. XXX を調査
2. YYY をまとめる
3. ZZZ を比較
```

SSE 受信側は `first-plan` / `plan-draft-complete` を検知して `/plan/confirm` を叩けば先に進む。

## 特許情報抽出の実例

### 推奨: google-patents-search スキル経由（安定・高速）

SerpApi の Google Patents API を直接叩くため、browser-use のタイムアウトやページ構造変更の影響を受けない。

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

**機能する理由**:
- 「google-patents-search スキルを使って」→ `skill` を確実に誘導
- SerpApi 構造化データ → claims 抽出が安定（browser-use 比で大幅に失敗率が低い）
- JSON スキーマを明示 → 構造化パース可能
- 完成レシピ: [recipes/patent-batch-extraction.md](recipes/patent-batch-extraction.md)

### フォールバック: browse 経由

スキルで対応できない場合（画面操作が必要・PDFの画像解析等）のみ `browse` を使用:

````
Google Patents https://patents.google.com/patent/{公開番号}/en を browse し、
「Claims」セクションの全請求項テキストを取得して。
````

## デバッグ Tips

意図したツールが発火しない場合:

1. **`inputText` にキーワードを追加**（[capabilities.md#ツール選択ロジック](capabilities.md#ツール選択ロジック)）
2. **`maxBrowsingSteps` を増やす**（browse が必要な場合、デフォルトでは不十分）
3. **`GET /turn/list` で `agentRun.process` を見る** → どのツールが実際に呼ばれたか確認
4. **モデルを変える**（`snorbe-quality` は judgement が強い）
