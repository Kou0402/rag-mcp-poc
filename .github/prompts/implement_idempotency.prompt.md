---
name: impl-idempotency
description: "Idempotency-Key仕様に沿って、注文作成APIの実装とテストを作る（根拠chunk id必須）"
agent: "agent"
tools: ["ragDocs/*"]
argument-hint: "language=typescript framework=express|fastify storage=memory|postgres"
---

入力:

- language: ${input:language}
- framework: ${input:framework}
- storage: ${input:storage}

目的:

- POST /v1/orders の冪等性を Idempotency-Key で実装する。
- 仕様の根拠（chunk id）を必ず添える。

手順（必須）:

1. #tool:rag_search で「Idempotency-Key」「POST /v1/orders」「409」「IDEMPOTENCY_CONFLICT」を検索（topK=8）
2. 必要な chunk を 1〜4 件選び、#tool:rag_get_chunk で本文確認
3. 仕様を箇条書きで確定（各項目に根拠 chunk id）
4. 実装を提示：
   - API ハンドラ（POST /v1/orders）
   - Idempotency-Key 検証（必須/長さ/許可文字）
   - Idempotency ストア（storage に応じて in-memory または DB）
   - 同一キー＋同一ボディ → 同一結果を返す
   - 同一キー＋異なるボディ → 409 IDEMPOTENCY_CONFLICT
5. テスト（最低）：
   - キーなし → 400
   - 同一キー同一ボディを 2 回 → 2 回目も成功（同一結果）
   - 同一キー異なるボディ → 409
   - キー形式不正/長すぎ → 400

出力フォーマット（必須）:

- 仕様まとめ（根拠 id つき）
- 実装（${input:framework} / ${input:language}）
- テストケース（例コード）
- 根拠 id 一覧
