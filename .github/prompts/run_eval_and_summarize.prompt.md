---
name: eval
description: "npm run eval を実行し、artifacts/eval_phase1.md を要約して改善案を出す"
agent: "agent"
argument-hint: "optional: focus=Q1-Q3"
---

目的:

- `npm run eval` を実行して結果を確認し、ズレている質問と改善方針をまとめる。

手順:

1. ターミナルで `npm run eval` を実行する
2. `artifacts/eval_phase1.md` を開いて、Top1 がズレている質問を列挙する
3. ズレの原因を「クエリ意図」「見出し」「用語（認証/OIDC/OAuth/冪等性など）」に分類する
4. 修正案を提示する（例：headingWeight 追加、質問リライト、topK 増加、RAG 回答の根拠制約強化）

出力フォーマット:

- 実行結果（成功/失敗、ログ要点）
- NG 一覧（Q 番号、期待、実際 Top1）
- 改善案（優先度順）
