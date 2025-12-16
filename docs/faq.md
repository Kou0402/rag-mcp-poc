# 注文管理システム（OrderHub）— FAQ

## Q1. APIの認証方式は？

A. OAuth 2.0 Client Credentials を使用し、Bearerトークンを送信します。詳細は docs/api.md を参照。

## Q2. Web管理画面の認証方式は？

A. OIDC（SSO）でログインし、BFFがセッションを管理します（docs/architecture.md 参照）。

## Q3. 注文作成をリトライしても大丈夫？

A. `POST /v1/orders` は **Idempotency-Key がある場合のみ**安全にリトライできます。
同じキーで**同じリクエストボディ**なら重複作成を防げます。

## Q4. 409 IDEMPOTENCY_CONFLICT とは？

A. 同じ Idempotency-Key を、**異なるリクエストボディ**で再利用したときに返ります。新しい注文として扱うなら新しいキーを使ってください。

## Q5. データの正（System of Record）は何？

A. 注文の正は PostgreSQL です。Kafka はイベント配信であり正ではありません。

## Q6. 注文ステータスの遷移ルールは？

A. 許可される遷移は以下です：

* `PENDING -> PAID`
* `PENDING -> CANCELLED`
* `PAID -> SHIPPED`

## Q7. Web管理画面で誰が返金確定できる？

A. 返金確定は ADMIN のみです（監査対象）。

## Q8. レート制限はある？

A. クライアント単位で 100リクエスト/分です（docs/api.md 参照）。

## Q9. Kafkaはどんな保証？

A. at-least-once です。受信側は冪等に実装してください。

## Q10. 監査ログの対象は？

A. キャンセル確定・返金確定・出荷更新などの重要操作です（docs/architecture.md 参照）。
