# API 仕様書

**プロジェクト名**: Gemini Vision Scanner
**バージョン**: 2.1.0
**最終更新**: 2026-02-25

---

## 1. エンドポイント一覧

| メソッド | パス | 認証 | 説明 |
|----------|------|------|------|
| POST | `/api/analyze` | 不要 | 画像解析（メインAPI） |
| GET | `/api/config/proxy` | 不要/管理者 | プロキシ設定取得 |
| POST | `/api/config/proxy` | 管理者必須 | プロキシ設定変更 |
| GET | `/healthz` | 不要 | Liveness（起動確認） |
| GET | `/readyz` | 不要/管理者 | Readiness（依存確認） |

---

## 2. 統一レスポンス形式

**全エンドポイント（`/api/analyze`）** で以下のフィールドが保証されます。

### 成功時（200）

```json
{
    "ok": true,
    "data": [
        { "label": "Hello World", "bounds": [[10,20],[100,20],[100,40],[10,40]] }
    ],
    "image_size": [768, 432],
    "error_code": null,
    "message": null,
    "request_id": "a1b2c3d4e5f6g7h8",
    "retry_after": null
}
```

### エラー時（4xx / 5xx）

```json
{
    "ok": false,
    "data": [],
    "error_code": "MISSING_IMAGE",
    "message": "画像データがありません",
    "request_id": "a1b2c3d4e5f6g7h8",
    "retry_after": null
}
```

### レート制限時（429）

```json
{
    "ok": false,
    "data": [],
    "error_code": "APP_RATE_LIMITED",
    "message": "リクエスト頻度が高すぎます（上限: 20回/分）",
    "request_id": "a1b2c3d4e5f6g7h8",
    "retry_after": 12,
    "limit_type": "minute"
}
```

### フィールド定義

| フィールド | 型 | 説明 |
|-----------|------|------|
| `ok` | boolean | 成功=`true`、失敗=`false` |
| `data` | array | 検出結果の配列（エラー時は空配列） |
| `image_size` | [int, int] \| null | 解析に使用した画像サイズ `[width, height]`。座標変換の基準 |
| `error_code` | string \| null | エラーコード（成功時は`null`） |
| `message` | string \| null | 人間可読なメッセージ（成功時は`null`） |
| `request_id` | string | 16桁hexのリクエスト追跡ID。ログ照合に使用 |
| `retry_after` | int \| null | 429時のリトライ推奨秒数（それ以外は`null`） |
| `limit_type` | string | 429時のみ。`"minute"` or `"daily"` |

---

## 3. エラーコード一覧

### アプリ側（app.py）

| エラーコード | HTTP | 発生条件 |
|-------------|------|----------|
| `INVALID_FORMAT` | 400 | リクエストがJSON形式でない / パース失敗 |
| `MISSING_IMAGE` | 400 | `image` フィールドが未指定 |
| `INVALID_MODE` | 400 | `mode` が許可値以外 |
| `INVALID_BASE64` | 400 | Base64デコード失敗 |
| `IMAGE_TOO_LARGE` | 400 | デコード後の画像サイズが5MBを超過 |
| `INVALID_IMAGE_FORMAT` | 400 | JPEG/PNG以外のマジックバイト |
| `APP_RATE_LIMITED` | 429 | アプリ側レート制限（分 or 日次） |
| `VALIDATION_ERROR` | 400 | ValueError（内部パスは非公開） |
| `SERVER_ERROR` | 500 | 予期しない例外 |
| `REQUEST_TOO_LARGE` | 413 | リクエストボディが10MBを超過 |
| `BAD_REQUEST` | 400 | Flaskの汎用400エラー |
| `UNAUTHORIZED` | 403 | 管理API認証失敗 |
| `INVALID_TYPE` | 400 | フィールドの型が不正（例: booleanにstringを指定） |
| `METHOD_NOT_ALLOWED` | 405 | 許可されていないHTTPメソッド |

### Gemini API側（gemini_api.py → app.pyが502で中継）

| エラーコード | HTTP | 発生条件 |
|-------------|------|----------|
| `GEMINI_RATE_LIMITED` | 429 | Gemini APIの429（Retry-After: 30） |
| `API_{status}` | 502 | Gemini APIの非200応答（例: `API_400`, `API_500`） |
| `TIMEOUT` | 502 | APIリクエストタイムアウト |
| `CONNECTION_ERROR` | 502 | API接続失敗 |
| `REQUEST_ERROR` | 502 | リクエスト送信エラー |
| `PARSE_ERROR` | 502 | レスポンスJSON解析失敗 |
| `API_RESPONSE_NOT_JSON` | 502 | レスポンスがJSON形式でない |
| `SAFETY_BLOCKED` | 502 | 安全フィルターによるブロック |
| `INCOMPLETE_RESPONSE` | 502 | 応答が不完全（MAX_TOKENS等） |

---

## 4. POST /api/analyze

### リクエスト

```
Content-Type: application/json
```

```json
{
    "image": "data:image/jpeg;base64,/9j/4AAQ...",
    "mode": "text",
    "hint": "商品ラベル"
}
```

| フィールド | 型 | 必須 | 説明 |
|-----------|------|------|------|
| `image` | string | 必須 | Base64エンコード画像（`data:image/...;base64,`プレフィックス付き） |
| `mode` | string | 必須 | 解析モード（下記参照） |
| `hint` | string | 任意 | キーワードヒント（最大200文字） |

### 対応モード

| モード | 説明 | `data` 内容 | `image_size` |
|--------|------|-------------|--------------|
| `text` | テキスト検出（OCR） | `[{label, bounds}]` | あり（ピクセル座標基準） |
| `object` | 物体検出 | `[{label, score, bounds}]` | なし（正規化座標 0〜1） |
| `label` | ラベル検出 | `[{label, score, bounds}]` | あり |
| `face` | 顔検出 | `[{label, bounds, emotion, ...}]` | あり |
| `logo` | ロゴ検出 | `[{label, score, bounds}]` | あり |
| `classify` | 分類タグ | `[{label, score}]` | なし |
| `web` | Web類似検索 | `[{label, score}]` + `web_detail` | なし |

### レスポンス例（text モード・成功）

```json
{
    "ok": true,
    "data": [
        {
            "label": "Hello World",
            "bounds": [[10,20],[100,20],[100,40],[10,40]]
        },
        {
            "label": "12345",
            "bounds": [[15,50],[60,50],[60,70],[15,70]]
        }
    ],
    "image_size": [768, 432],
    "error_code": null,
    "message": null,
    "request_id": "f3a1b2c4d5e6f789",
    "retry_after": null
}
```

### バウンディングボックス座標系

- **text / face / logo / label**: `bounds` はピクセル座標 `[[x1,y1],[x2,y2],[x3,y3],[x4,y4]]`。`image_size` で正規化して描画する
- **object**: `bounds` は正規化座標（0〜1）。`image_size` は `null`

---

## 5. GET /healthz

Liveness プローブ用。依存先チェックなし、常に軽量。

```json
{ "status": "ok" }
```

| HTTP | 意味 |
|------|------|
| 200 | 起動中 |

---

## 6. GET /readyz

Readiness プローブ用。認証レベルで応答内容が変わる。

### 未認証

```json
{ "status": "ok" }
```

インフラ情報は公開しない。K8s Probe はこちらを使用。

### 管理者認証（`X-Admin-Secret` ヘッダー）

```json
{
    "status": "ok",
    "checks": {
        "api_key_configured": true,
        "rate_limiter_backend": "in_memory",
        "rate_limiter_ok": true
    },
    "warnings": []
}
```

クエリパラメータ `?check_api=true` で Gemini API の DNS 到達性も検査（管理者のみ）。

| HTTP | 意味 |
|------|------|
| 200 | 準備完了 |
| 503 | APIキー未設定 or Redis フォールバック |

---

## 7. レート制限

### 2段階制限

| 種別 | デフォルト | ウィンドウ | `limit_type` |
|------|-----------|-----------|--------------|
| 分制限 | 20回/分 | 60秒ローリング | `minute` |
| 日次制限 | 1000回/日 | 日付境界リセット | `daily` |

### 429 レスポンスの HTTPヘッダー

```
HTTP/1.1 429 Too Many Requests
Retry-After: 12
```

`Retry-After` ヘッダーとレスポンスボディの `retry_after` フィールドは同じ値。

### Reserve-Release パターン

API呼び出し**前に**カウントを消費（予約）し、API失敗時のみロールバック。成功時はカウントが残る。これにより、並行リクエストで他ユーザーのカウントに影響しない。

### キー方式

| 値 | キー構成 | 用途 |
|----|----------|------|
| `ip`（デフォルト） | IPアドレスのみ | UA偽装による回避を防止。大半の環境で推奨 |
| `ip_ua` | IP + SHA256(UserAgent[:64])[:8] | NAT配下で端末ごとに独立した制限が必要な場合 |

```bash
# .env での設定例
RATE_LIMIT_KEY_MODE=ip
```

---

## 8. 認証

管理API（プロキシ設定変更、readyz詳細）には `X-Admin-Secret` ヘッダーが必要。

```bash
curl -H "X-Admin-Secret: your-secret-here" https://example.com/readyz
```

未設定時は管理APIは常に403を返す。

---

## 9. セキュリティヘッダー

全レスポンスに以下のヘッダーが付与される:

| ヘッダー | 値 |
|----------|------|
| `Content-Security-Policy` | nonce ベース（`unsafe-inline` 排除） |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `X-Request-Id` | リクエスト追跡用16桁hex |

`X-Request-Id` はレスポンスボディの `request_id` と同値。ログ照合に使用。

---

## 10. クライアント実装ガイド

### エラーハンドリングのフローチャート

```
response = await fetch('/api/analyze', ...)

if (response.status === 429) {
    if (result.limit_type === 'daily') {
        // 日次制限: UIを無効化（翌日まで復旧しない）
    } else {
        // 分制限: result.retry_after 秒後にリトライ
    }
} else if (result.ok) {
    // 成功: result.data を描画
} else {
    // API失敗: result.error_code で分岐
    //   GEMINI_RATE_LIMITED → Retry-After に従う
    //   SAFETY_BLOCKED     → ユーザーに通知（リトライ不要）
    //   TIMEOUT / CONNECTION_ERROR → リトライ可能
    //   その他              → エラー表示
}
```

### リトライ戦略

| エラーコード | リトライ | 戦略 |
|-------------|---------|------|
| `APP_RATE_LIMITED` | `retry_after` 秒後 | サーバー指定の秒数を厳守 |
| `GEMINI_RATE_LIMITED` | 30秒後 | Retry-After ヘッダーに従う |
| `TIMEOUT` / `CONNECTION_ERROR` | 可 | 指数バックオフ（1s, 2s, 4s） |
| `SAFETY_BLOCKED` | 不可 | 同一画像では常に同じ結果 |
| `API_{4xx}` | 不可 | リクエスト自体に問題がある |
| `API_{5xx}` | 可 | 指数バックオフ |

---

## 11. 監視・ログ集計ガイド

### 構造化ログ形式

```
event=api_success request_id=a1b2c3d4e5f6g7h8 ip=192.168.1.1 mode=text items=3
event=rate_limited request_id=f9e8d7c6b5a49382 ip=192.168.1.1 reason=... limit_type=minute
event=api_failure request_id=c3d4e5f6a1b2g7h8 ip=192.168.1.1 mode=object error_code=API_500
event=server_error request_id=h8g7f6e5d4c3b2a1 ip=192.168.1.1 mode=text error=...
```

### 推奨アラート条件

| メトリクス | 条件 | 深刻度 |
|-----------|------|--------|
| `event=rate_limited` 発生率 | 5分間で10件超 | Warning |
| `event=api_failure` + `error_code=GEMINI_RATE_LIMITED` | 5分間で5件超 | Warning（APIクォータ逼迫） |
| `event=api_failure` + `error_code=API_500` | 1件でも | Critical（Gemini障害） |
| `event=server_error` | 1件でも | Critical（アプリバグ） |
| `/readyz` が503 | 1分間継続 | Critical（デプロイ不備） |

### request_id によるログ追跡

```bash
# 特定リクエストの全ログを抽出
sudo journalctl -u gemini-scanner | grep "request_id=a1b2c3d4e5f6g7h8"

# エラーコード別の集計（直近1時間）
sudo journalctl -u gemini-scanner --since "1 hour ago" | grep "event=api_failure" | grep -oP 'error_code=\S+' | sort | uniq -c | sort -rn

# レート制限の発生頻度
sudo journalctl -u gemini-scanner --since "1 hour ago" | grep "event=rate_limited" | wc -l
```
