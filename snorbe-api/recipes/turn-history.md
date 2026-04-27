# Turn 履歴の全件取得

## 基本的なページネーション

```bash
# 最初のページ
curl "https://app.snorbe.deskrex.ai/api/v1/turn/list?limit=50" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"

# 次のページ
curl "https://app.snorbe.deskrex.ai/api/v1/turn/list?limit=50&cursor=clxxx003" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

## 全件取得スクリプト

### TypeScript

```typescript
const BASE = "https://app.snorbe.deskrex.ai/api/v1/turn/list";
const headers = { Authorization: "Bearer snorbe_YOUR_KEY" };
let cursor: string | undefined;
const allTurns: Turn[] = [];

do {
  const url = cursor
    ? `${BASE}?limit=50&cursor=${cursor}`
    : `${BASE}?limit=50`;
  const resp = await fetch(url, { headers });
  const data = await resp.json();

  for (const turn of data.turns) {
    allTurns.push(turn);
    const prefix = turn.kind === "user" ? "👤" : "🤖";
    const preview = turn.content.slice(0, 80).replace(/\n/g, " ");
    console.log(`${prefix} ${preview}`);

    if (turn.agentRun) {
      console.log(`  → AgentRun: ${turn.agentRun.status} (${turn.agentRun.id})`);
    }
  }

  cursor = data.nextCursor ?? undefined;
} while (cursor);

console.log(`Total: ${allTurns.length} turns`);
```

### Python

```python
import requests

BASE = "https://app.snorbe.deskrex.ai/api/v1/turn/list"
headers = {"Authorization": "Bearer snorbe_YOUR_KEY"}
cursor = None
all_turns = []

while True:
    params = {"limit": 50}
    if cursor:
        params["cursor"] = cursor
    resp = requests.get(BASE, params=params, headers=headers)
    data = resp.json()

    for turn in data["turns"]:
        all_turns.append(turn)
        prefix = "👤" if turn["kind"] == "user" else "🤖"
        preview = turn["content"][:80].replace("\n", " ")
        print(f"{prefix} {preview}")

        if turn.get("agentRun"):
            ar = turn["agentRun"]
            print(f"  → AgentRun: {ar['status']} ({ar['id']})")

    cursor = data.get("nextCursor")
    if not cursor:
        break

print(f"Total: {len(all_turns)} turns")
```

## ユースケース

### ユーザー質問の抽出

```python
user_turns = [t for t in all_turns if t["kind"] == "user"]
for turn in user_turns:
    print(turn["content"])
```

### AgentRun成功/失敗の集計

```python
from collections import Counter

assistant_turns = [t for t in all_turns if t["kind"] == "assistant" and t.get("agentRun")]
statuses = Counter(t["agentRun"]["status"] for t in assistant_turns)
print(f"Status breakdown: {dict(statuses)}")
```

### 特定期間の Turn を抽出

```python
from datetime import datetime

cutoff = datetime(2026, 4, 1)
recent = [
    t for t in all_turns
    if datetime.fromisoformat(t["createdAt"].replace("Z", "+00:00")) > cutoff
]
print(f"Turns since April 2026: {len(recent)}")
```
