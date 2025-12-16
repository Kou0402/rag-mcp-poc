# 注文管理システム（OrderHub）— アーキテクチャ

## 全体構成（コンポーネント）

* **Web Frontend（管理画面）**：社内利用、ブラウザからアクセス
* **BFF（Backend for Frontend）**：Web向けAPI。セッション管理・権限チェック
* **API Gateway**：外部APIの入口。OAuth検証・レート制限・ルーティング
* **Order Service**：注文ドメインの中核（作成、参照、ステータス更新）
* **PostgreSQL**：注文データの永続化（正）
* **Kafka**：注文イベント配信（order.created/paid/cancelled/shipped）
* **Redis**：短期キャッシュ（注文一覧の検索結果キャッシュなど）

## 認証・認可

### Web管理画面（社内向け）

* **OIDC（OpenID Connect）でSSO**し、BFFがセッションを管理する
* 画面操作はロール（OP/ADMIN）で制御する

### 外部API（連携向け）

* API GatewayでOAuth 2.0 Bearerトークンを検証する（詳細は docs/api.md）

## データ設計（概要）

### PostgreSQL

* `orders`：注文ヘッダ（orderId, customerId, status, totalAmount, currency, createdAt など）
* `order_items`：注文明細（orderId, sku, quantity, unitPrice）
* 冪等性のため、`idempotencyKey` を保持し重複作成を抑止する（Order Serviceで検証）

## イベント配信

### 注文イベント

* ステータス変更時に以下を発行：

  * `order.created`
  * `order.paid`
  * `order.cancelled`
  * `order.shipped`
* 配信は **at-least-once（少なくとも1回）**

  * 受信側は冪等に処理すること

## リトライ・バックオフ戦略（推奨）

### Exponential Backoff + Full Jitter

一時障害（ネットワークタイムアウト、`429`、`503`）に対して：

* 基本待機：200ms
* 係数：2.0倍
* 最大待機：5s
* Full jitter：0〜計算待機の範囲で乱数
* 最大試行回数：5回

## 監査ログ

### 対象操作（Web）

* キャンセル確定（ADMIN）
* 返金確定（ADMIN）
* 出荷更新（OP/ADMIN）
* 監査ログには `requestId`、操作者、操作内容、対象orderId、時刻を記録する

## 可観測性

* ログ：JSON構造化ログ。`requestId` を必ず含める
* トレーシング：OpenTelemetry（trace idはRequest-Idと紐付け）
* メトリクス：p95/p99 レイテンシ、4xx/5xx、Kafka publish失敗数
