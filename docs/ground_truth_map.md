|   # | 質問                   | 根拠（ファイル > 見出し）                                                                                     |
| --: | ---------------------- | ------------------------------------------------------------------------------------------------------------- |
|   1 | API の認証方式         | `docs/api.md` > `認証（API）` > `OAuth 2.0（Client Credentials）`                                             |
|   2 | Web 管理画面の認証方式 | `docs/architecture.md` > `認証・認可` > `Web管理画面（社内向け）`                                             |
|   3 | 冪等性の担保           | `docs/api.md` > `共通ヘッダ` > `Idempotency-Key（注文作成の冪等性）` ＋ `docs/overview.md` > `非機能（抜粋）` |
|   4 | 409 の意味             | `docs/api.md` > `POST /v1/orders` > `409 Conflict`                                                            |
|   5 | ステータス遷移         | `docs/api.md` > `PATCH /v1/orders/{orderId}` > `許可されるステータス遷移`                                     |
|   6 | レート制限             | `docs/api.md` > `レート制限`                                                                                  |
|   7 | DB（正）               | `docs/architecture.md` > `データ設計（概要）` > `PostgreSQL`                                                  |
|   8 | イベント基盤と保証     | `docs/architecture.md` > `イベント配信` > `注文イベント`                                                      |
|   9 | バックオフ戦略         | `docs/architecture.md` > `リトライ・バックオフ戦略（推奨）`                                                   |
|  10 | 返金確定できるロール   | `docs/overview.md` > `想定ユーザーと権限` > `権限の基本方針` ＋ `docs/faq.md` > `Q7`                          |
