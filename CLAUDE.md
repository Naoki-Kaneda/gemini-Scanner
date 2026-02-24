# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Google Gemini APIを使ったリアルタイム画像解析Webアプリ「Gemini Vision Scanner」。Flask + Vanilla JS構成で、Webカメラ/ファイルアップロードから7種の画像解析（text, object, label, face, logo, classify, web）を実行する。

## よく使うコマンド

```bash
# 依存パッケージインストール
pip install -r requirements.txt          # 本番用
pip install -r requirements-dev.txt      # 開発用（テスト・リンター含む）

# ローカル起動（Windows）
start.bat                                # HTTP, localhost:5000

# テスト実行
python -m pytest tests/ -q -m "not e2e"  # E2Eを除外（通常使用）
python -m pytest tests/test_api.py -q    # Flask API統合テストのみ
python -m pytest tests/test_gemini_api.py -q  # Gemini API単体テストのみ
python -m pytest tests/test_api.py::TestAnalyzeEndpoint::test_missing_image -v  # 単一テスト

# リンター・セキュリティ
ruff check .                             # リンター
ruff format .                            # フォーマッター
bandit -r . --exclude ./tests            # セキュリティ監査

# 本番デプロイ（gunicorn）
gunicorn app:app --bind 0.0.0.0:5000 --workers 2 --timeout 60
```

## アーキテクチャ

### モジュール構成

```
app.py          → Flaskアプリ本体。全エンドポイント、セキュリティヘッダー、バリデーション
gemini_api.py   → Gemini API呼び出し。7モードの解析ロジック、リトライ、プロキシ対応
rate_limiter.py → 2段階レート制限（分/日）。Redis or インメモリの自動切替
translations.py → 英語→日本語翻訳辞書（物体名・感情・ラベル）

templates/index.html → メインUI（MD3ダークテーマ、CSP nonce付き）
static/script.js     → カメラ制御、フレーム差分検出、API通信、結果描画
static/style.css     → レスポンシブ/グラスモーフィズム
```

### リクエスト処理パイプライン（POST /api/analyze）

```
[1] set_request_context() → request-id・CSP nonce生成
[2] _validate_analyze_request() → JSON/Base64/サイズ/モード/マジックバイト検証
[3] try_consume_request() → レート制限チェック（予約方式）
[4] detect_content() → Gemini API呼び出し + 429リトライ
[5] 成功: 200 JSON / API失敗: release_request()でロールバック → 502
[6] add_security_headers() → CSP・CORS等のヘッダー付与
```

### Reserve-Release パターン（app.py ↔ rate_limiter.py）

レート制限は「予約方式」を採用。API呼び出し**前に**`try_consume_request()`でカウントを消費し`request_id`を発行。API失敗時のみ`release_request(rate_key, request_id)`で**そのIDのカウントだけ**をロールバックする。並行リクエストの他カウントには影響しない。

### Gemini API モード別ディスパッチ（gemini_api.py）

各モードは`MODE_PROMPTS`（プロンプト）、`MODE_SCHEMAS`（JSON Schema）、`_MODE_HANDLERS`（パーサー関数マッピング）の3つの辞書で定義される。新モード追加時はこの3箇所に定義を追加し、対応する`_parse_gemini_*_response()`関数を実装する。

`_dispatch_mode_handler()`がモードに応じてパーサーを選択し`_make_success()`で統一レスポンスを返す。label/webモードは戻り値が特殊（追加フィールドあり）。

### box_2d 座標系（重要）

Gemini APIが返す`box_2d`は`[ymin, xmin, ymax, xmax]`形式で**0〜1000スケール**。モードによって変換先が異なる:

- **ピクセル座標**（text/face/logo/label）: `_gemini_box_to_pixel_vertices()` — `needs_image_size: True`
- **正規化座標 0〜1**（object）: `_gemini_box_to_normalized_vertices()` — `needs_image_size: False`

`_sanitize_box_2d()`がクランプと反転ボックス修正を行う。

### Thinking戦略テーブル

`_THINKING_STRATEGY_TABLE`でモデル世代×タイプ（flash/pro）のthinkingConfigを制御。空辞書はペイロードから`thinkingConfig`キーごと除外される（APIデフォルト動作）。未知モデルは安全側に空辞書を返す。

### System Instruction

`_SYSTEM_INSTRUCTION`で全モード共通の制約（box_2d形式、score範囲、空配列ルール等）を定義。モード別プロンプト(`MODE_PROMPTS`)とは分離されている。

### 画像前処理（_ensure_jpeg）

全モード共通でJPEG統一変換。text/labelモードのみ`enhance=True`でコントラスト・シャープネスを1.5倍に強調（OCR精度向上）。

### レート制限の仕組み（rate_limiter.py）

- **2段階**: 分単位（60秒ローリングウィンドウ）+ 日次
- **バックエンド自動切替**: `REDIS_URL`設定時はRedis（Lua原子操作）、未設定はインメモリ（`threading.Lock`）
- **遅延初期化**: `_get_backend()`で最初のリクエスト時にバックエンドを決定
- **キー方式**: `ip_ua`（IP+SHA256(UserAgent[:64])[:8]）または`ip`（IPのみ）

### フロントエンド安定化パイプライン（script.js）

```
scanLoop() → requestAnimationFrame
  └── checkStabilityAndCapture()
        ├── 64×48pxキャンバスでフレーム差分計算
        ├── diff < 30 が 20フレーム連続 → captureAndAnalyze()
        └── captureAndAnalyze()
              ├── 8×8グレースケールハッシュで前回画像と比較（≥95%→APIスキップ）
              ├── fetchWithRetry('/api/analyze') → 指数バックオフ付きリトライ
              ├── computeResultFingerprint() → 重複検出（N回連続一致で一時停止）
              └── エラー時: scheduleRetry()で10秒後に自動復帰
```

### CSSレイアウト注意点

`.video-tools`はflexboxで`overflow-x: auto`。`.mode-switch-group`に`flex-shrink: 0`、`.mode-btn`に`white-space: nowrap`を設定してテキスト折り返しを防止している。カメラ切替ボタン（`#btn-flip-cam`）は`min-width: 5.5em`でテキスト変更時のレイアウト崩れを防止。

## テスト構成

- `tests/conftest.py` → 共有フィクスチャ（`client`、画像生成ヘルパー、モックファクトリ）
- `tests/test_api.py` → Flask APIエンドポイント統合テスト
- `tests/test_gemini_api.py` → Gemini API単体テスト（リトライ・パーサー・エラー処理）
- `tests/e2e/` → Playwright E2Eテスト（`@pytest.mark.e2e`で分離）

テスト用ヘルパー: `create_valid_image_base64()`, `create_valid_png_base64()`, `make_b64()`, `make_mock_response()`

`reset_for_testing()`でレート制限バックエンドをインメモリに強制リセット（conftest.pyの`client`フィクスチャ内で毎回呼ばれる）。

## 主要な環境変数

| 変数 | デフォルト | 説明 |
|------|---------|------|
| `GEMINI_API_KEY` | 必須 | Google Gemini APIキー |
| `GEMINI_MODEL` | gemini-2.5-flash | 使用モデル |
| `GEMINI_429_MAX_RETRIES` | 2 | 429リトライ回数 |
| `GEMINI_429_BACKOFF_BASE_SECONDS` | 1.5 | バックオフ基準秒（ジッター付き指数バックオフ） |
| `PROXY_URL` | 空 | HTTPプロキシ |
| `NO_PROXY_MODE` | false | プロキシ無視モード |
| `REDIS_URL` | 空 | Redis接続URL（マルチプロセス時必須） |
| `RATE_LIMIT_PER_MINUTE` | 20 | 分制限 |
| `RATE_LIMIT_DAILY` | 1000 | 日次制限 |
| `RATE_LIMIT_KEY_MODE` | ip_ua | レート制限キー方式（`ip_ua` or `ip`） |
| `ALLOWED_ORIGINS` | 空 | CORS許可Origin（カンマ区切り） |
| `ADMIN_SECRET` | 空 | 管理API認証用シークレット |
| `TRUST_PROXY` | false | X-Forwarded-For信頼（nginx配下で必須） |

## コミットメッセージ規約

`<type>: <日本語説明>` 形式。例: `feat: 新規解析モードの追加`, `fix: 429リトライの指数バックオフ修正`

## デプロイ構成

- **Render**: `render.yaml`（gunicorn + 環境変数）
- **Ubuntu**: `deploy/setup-ubuntu.sh`（nginx:8444 + gunicorn:8001 + systemd自動セットアップ）
- **Python**: 3.12.0（`runtime.txt`）

## 開発時の注意点

- Geminiレスポンスの`thought=True`パートはJSON本文に混ぜると解析が壊れるため`_extract_gemini_content()`で除外している
- `set_proxy_enabled()`は`_proxy_lock`でスレッド安全性を確保している
- `_warned_unknown_model` setで未知モデル警告ログの重複を抑制している
- CSPヘッダーはリクエストごとに`g.csp_nonce`を生成し`unsafe-inline`を完全排除
- `ADMIN_SECRET`認証は`secrets.compare_digest()`でタイミング攻撃を防止
