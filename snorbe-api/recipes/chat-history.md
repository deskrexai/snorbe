# チャット履歴の全件取得

## 基本的なページネーション

```bash
# 最初のページ
curl "https://app.snorbe.deskrex.ai/api/v1/chat/list?limit=50" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"

# 次のページ
curl "https://app.snorbe.deskrex.ai/api/v1/chat/list?limit=50&cursor=clxxx003" \
  -H "Authorization: Bearer snorbe_YOUR_KEY"
```

## 全件取得スクリプト

### TypeScript

```typescript
const BASE = "https://app.snorbe.deskrex.ai/api/v1/chat/list";
const headers = { Authorization: "Bearer snorbe_YOUR_KEY" };
let cursor: string | undefined;
const allChats: Chat[] = [];

do {
  const url = cursor
    ? `${BASE}?limit=50&cursor=${cursor}`
    : `${BASE}?limit=50`;
  const resp = await fetch(url, { headers });
  const data = await resp.json();

  for (const chat of data.chats) {
    allChats.push(chat);
    const prefix = chat.role === "user" ? "👤" : "🤖";
    const preview = chat.content.slice(0, 80).replace(/\n/g, " ");
    console.log(`${prefix} ${preview}`);

    if (chat.agentRun) {
      console.log(`  → AgentRun: ${chat.agentRun.status} (${chat.agentRun.id})`);
    }
  }

  cursor = data.nextCursor ?? undefined;
} while (cursor);

console.log(`Total: ${allChats.length} chats`);
```

### Python

```python
import requests

BASE = "https://app.snorbe.deskrex.ai/api/v1/chat/list"
headers = {"Authorization": "Bearer snorbe_YOUR_KEY"}
cursor = None
all_chats = []

while True:
    params = {"limit": 50}
    if cursor:
        params["cursor"] = cursor
    resp = requests.get(BASE, params=params, headers=headers)
    data = resp.json()

    for chat in data["chats"]:
        all_chats.append(chat)
        prefix = "👤" if chat["role"] == "user" else "🤖"
        preview = chat["content"][:80].replace("\n", " ")
        print(f"{prefix} {preview}")

        if chat.get("agentRun"):
            ar = chat["agentRun"]
            print(f"  → AgentRun: {ar['status']} ({ar['id']})")

    cursor = data.get("nextCursor")
    if not cursor:
        break

print(f"Total: {len(all_chats)} chats")
```

## ユースケース

### ユーザー質問の抽出

```python
user_chats = [c for c in all_chats if c["role"] == "user"]
for chat in user_chats:
    print(chat["content"])
```

### AgentRun成功/失敗の集計

```python
from collections import Counter

assistant_chats = [c for c in all_chats if c["role"] == "assistant" and c.get("agentRun")]
statuses = Counter(c["agentRun"]["status"] for c in assistant_chats)
print(f"Status breakdown: {dict(statuses)}")
```

### 特定期間のチャットを抽出

```python
from datetime import datetime

cutoff = datetime(2026, 4, 1)
recent = [
    c for c in all_chats
    if datetime.fromisoformat(c["createdAt"].replace("Z", "+00:00")) > cutoff
]
print(f"Chats since April 2026: {len(recent)}")
```
