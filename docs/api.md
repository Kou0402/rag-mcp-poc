# 注文管理システム（OrderHub）— API仕様

## ベースURL

* 本番：`https://api.orderhub.example`
* ステージング：`https://stg-api.orderhub.example`

## 認証（API）

### OAuth 2.0（Client Credentials）

* 連携システム（EC/倉庫/決済など）は **OAuth 2.0 Client Credentials** を使用する
* ヘッダ：`Authorization: Bearer <access_token>`
* 想定スコープ例：`orders:read`, `orders:write`

## 共通ヘッダ

### Idempotency-Key（注文作成の冪等性）

* 対象：`POST /v1/orders`
* 必須
* 仕様：

  * 最大64文字
  * 許可文字：`[A-Za-z0-9-_.]`
* 同じ `Idempotency-Key` で **異なるボディ**を送った場合は `409 IDEMPOTENCY_CONFLICT`

### Request-Id（相関ID）

* 任意（推奨）
* 未指定の場合はサーバ側で採番しレスポンスに返す

## エンドポイント

## POST /v1/orders

注文を新規作成する。

### リクエスト

Headers:

* `Authorization: Bearer …`
* `Idempotency-Key: <key>`

Body:

```json
{
  "customerId": "cus_123",
  "currency": "JPY",
  "items": [
    { "sku": "SKU-001", "quantity": 2, "unitPrice": 1200 }
  ]
}
```

### レスポンス

* `201 Created`

```json
{
  "orderId": "ord_abc",
  "status": "PENDING",
  "totalAmount": 2400,
  "currency": "JPY",
  "createdAt": "2025-12-01T10:00:00Z"
}
```

* `409 Conflict`（冪等性衝突）

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "同じIdempotency-Keyが異なるリクエストボディで再利用されました。"
  }
}
```

## GET /v1/orders/{orderId}

注文IDで注文を取得する。

### レスポンス

* `200 OK`
* `404 Not Found`

## PATCH /v1/orders/{orderId}

注文ステータスを更新する。

### リクエスト

```json
{ "status": "PAID" }
```

### 許可されるステータス遷移

* `PENDING -> PAID`
* `PENDING -> CANCELLED`
* `PAID -> SHIPPED`

### レスポンス

* `200 OK`
* `400 Bad Request`（不正な遷移）
* `404 Not Found`

## エラーモデル

全てのエラーは以下の形式：

```json
{
  "error": {
    "code": "SOME_CODE",
    "message": "人間が読める説明"
  }
}
```

## レート制限

* **クライアント単位で 100 リクエスト/分**
* ヘッダ：

  * `X-RateLimit-Limit`
  * `X-RateLimit-Remaining`
  * `X-RateLimit-Reset`（unix秒）

## リトライ方針（API利用者向け）

* `GET` は一時障害（ネットワークタイムアウト、`429`、`503`）時にリトライ可
* `POST /v1/orders` は **Idempotency-Key を付与している場合のみ**リトライ可
* バックオフ推奨：`docs/architecture.md` を参照
