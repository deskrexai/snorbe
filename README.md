# Snorbe Agent Skills

[Snorbe](https://lp.snorbe.deskrex.ai/) の自律リサーチエージェントを Claude Code / Cursor / Codex などから呼び出すための Agent Skills。

## インストール

```bash
npx skills add deskrexai/snorbe
```

特定のスキルだけインストール:

```bash
npx skills add deskrexai/snorbe --skill snorbe-api
```

## 収録スキル

### `snorbe-api`

Snorbe REST API (`/api/v1`) を呼び出すスキル。エージェント実行・SSE ストリーミング・チャット履歴・グラフデータ・HITL（plan / report / matrix）などを扱う。

- **capabilities.md** — エージェントが持つ 22 ツール・HITL 生成物・使えるモデル一覧
- **prompting.md** — 効果的な `inputText` の書き方とツール誘導方法
- **runtime-gotchas.md** — SSE 受信・タイムアウト・バッファリング等の実装ハマりどころ
- **recipes/** — タスク別ワークフロー（基本リサーチ・特許請求項一括抽出・グラフ探索・マルチエージェント委譲など）
- **reference/** — API エンドポイントごとの詳細リファレンス

## 使い方

インストール後、API キーを環境変数に設定:

```bash
export SNORBE_API_KEY=snorbe_xxxxxxxxxxxxxxxxxxxx
```

API キーは Snorbe ダッシュボードの **API Keys** ページで作成します。

Claude Code などのエージェントでスキルを呼び出せば、Snorbe のエージェント実行・結果取得・グラフ操作などが指示ベースで行えます。

## ドキュメント

- [Snorbe 公式ドキュメント](https://docs.snorbe.com/)
- [API リファレンス](https://docs.snorbe.com/ja/api-reference/)

## ライセンス

MIT
