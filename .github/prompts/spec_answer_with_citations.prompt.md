---
name: spec
description: "仕様質問に対して、ragDocs を使って根拠IDつきで回答する"
agent: "agent"
tools: ["ragDocs/*"]
argument-hint: "question=..."
---

次の質問に答えてください: ${input:question}

手順（必須）:

1. #tool:rag_search を使い、topK=8 で関連 chunk を探す
2. 上位から「回答に必要な根拠」だけ 1〜3 件選び、#tool:rag_get_chunk で本文を取得して確認する
3. 回答は「結論 → 詳細 → 根拠（chunk id 一覧）」の順で出す
4. 根拠に無いことは「不明」と書く（推測しない）
