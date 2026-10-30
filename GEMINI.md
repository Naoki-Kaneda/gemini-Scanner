# Gemini Vision Scanner プロジェクト概要

このプロジェクトは、Google Gemini API を利用した画像解析Webアプリケーションです。ブラウザからWebカメラで撮影した画像やアップロードしたファイルを送信し、テキスト検出（OCR）、物体検出、顔検出、ロゴ検出、分類、AIによる類似画像・Webエンティティ識別などの解析結果をリアルタイムで取得できます。

## 主要技術スタック

*   **バックエンド:** Python (Flask)
*   **フロントエンド:** HTML, CSS, JavaScript
*   **AI/ML:** Google Gemini API
*   **レート制限:** Redis (またはインメモリ)
*   **デプロイ:** Gunicorn, Nginx, Systemd (Ubuntuサーバー), Render

## プロジェクトの目的と機能

*   **多様な画像解析モード:** `text`, `label`, `object`, `face`, `logo`, `classify`, `web` の7つのモードをサポートし、幅広い画像解析ニーズに対応します。
*   **リアルタイム処理:** Webカメラからの動画ストリームを安定化検出・差分検出を経て効率的にフレームキャプチャし、解析結果をリアルタイムにフィードバックします。
*   **堅牢なレート制限:** アプリケーション側のレート制限（分単位・日次）とGemini API側のレート制限に対するリトライ・バックオフ機構を実装し、安定したサービス運用をサポートします。
*   **セキュリティ:** CSP、Permissions-Policy、X-Content-Type-Optionsなどのセキュリティヘッダーを適用し、安全なWebアプリケーションを提供します。
*   **管理機能:** 管理APIを通じてプロキシ設定の有効/無効を切り替えることができます。

## 主要ファイル

*   `app.py`: Flaskアプリケーションのメインエントリポイント。ルーティング、リクエスト処理、レート制限の適用、セキュリティヘッダーの付与などを担当します。
*   `gemini_api.py`: Google Gemini APIとのインターフェース。画像の前処理、APIペイロードの構築、API呼び出し、レスポンスの解析、Gemini API側のレート制限処理などを実装します。
*   `rate_limiter.py`: アプリケーション独自のレート制限ロジックを実装。Redisまたはインメモリで動作し、分単位および日次の制限を管理します。
*   `static/*.js`: フロントエンドのJavaScript（ESモジュール6本）。`app.js`（エントリポイント）、`constants.js`（状態・設定定数）、`camera.js`（カメラ・ファイル入力）、`scanner.js`（スキャンループ・安定化検出・状態遷移）、`api-client.js`（API通信・リトライ）、`ui-manager.js`（結果の描画・UI同期）。新しいモジュールを足したら `app.py` の `_JS_MODULE_FILES` にも登録します。
*   `templates/index.html`: アプリケーションのメインHTMLテンプレート。
*   `requirements.txt`: プロジェクトのPython依存パッケージリスト。
*   `pyproject.toml`: pytest・ruff・mypy の設定。依存パッケージは `requirements.txt` / `requirements-dev.txt` にあります。
*   `deploy/`: Ubuntuサーバーへのデプロイ用のスクリプトと設定ファイル（nginx, systemd）。
*   `tests/`: テストコードを格納するディレクトリ。

## ビルドと実行

### ローカル開発環境でのセットアップ

1.  **依存パッケージのインストール:**
    ```bash
    pip install -r requirements.txt
    ```
2.  **環境変数の設定:**
    ```bash
    cp .env.example .env
    # .env ファイルを編集し、GEMINI_API_KEY を設定してください。
    ```
3.  **アプリケーションの起動:**
    *   **Windows:**
        ```bash
        start.bat
        ```
    *   **Linux / macOS:**
        ```bash
        chmod +x start.sh
        ./start.sh
        ```
    起動後、ブラウザで `http://localhost:5000`（Windows）または `https://<サーバーIP>:5000`（Linux）にアクセスしてください。

### テストの実行

1.  **開発用依存パッケージのインストール:**
    ```bash
    pip install -r requirements-dev.txt
    ```
2.  **テストの実行:**
    ```bash
    python -m pytest tests/ -q -m "not e2e"   # サーバー側（通常はこれ）
    python -m playwright install chromium     # 画面側E2Eの初回のみ
    python -m pytest tests/e2e -q -m e2e      # 画面側E2E（偽カメラ・偽APIで動き、APIキー不要）
    ```
3.  **リンター・型チェック:**
    ```bash
    ruff check .
    mypy
    npx -y -p typescript@7.0.2 tsc -p jsconfig.json
    ```

## 開発規約

*   **コーディングスタイル:** `ruff check` でリンターを通します。`ruff format` は使いません（コメント位置や辞書の列を手で揃えており、一括整形すると崩れるため）。書式の決まりは `.editorconfig` にあります。
*   **テスト:** `pytest`フレームワークを使用した単体テストおよび統合テストが`tests/`ディレクトリに格納されています。変更を加える際は、既存のテストを追加または更新することが推奨されます。
*   **コミットメッセージ:** プレフィックスと日本語の形式（例: `feat: 新規登録機能の追加`）を使用してください。
*   **エラーハンドリング:** エラーの根本原因を修正し、早期にエラーを検出し明確なメッセージを提供することを重視します。
*   **ドキュメンテーション:** `README.md`にプロジェクトの概要、セットアップ、使用方法が明確に記載されています。

## レート制限キー方式 (`RATE_LIMIT_KEY_MODE`)

環境変数 `RATE_LIMIT_KEY_MODE` により、レート制限のクライアント識別方法を切り替えられます。

*   `ip` (デフォルト): IPアドレスのみを使用。User-Agent の偽装による回避を防げます。NAT環境では複数端末が同一の制限枠を消費します。
*   `ip_ua`: IPアドレスとUser-Agentのハッシュを組み合わせた複合キーを使用。NAT/共有IP環境で端末ごとに制限したい場合に使います。

## デプロイ

### Ubuntuサーバーへのインストール

`deploy/setup-ubuntu.sh`スクリプトを使用して、nginx + gunicorn + systemd の本番構成を自動構築できます。

```bash
# 1. リポジトリをクローン
git clone https://github.com/Naoki-Kaneda/gemini-Scanner.git
cd gemini-Scanner

# 2. セットアップスクリプトを実行（root権限が必要）
sudo bash deploy/setup-ubuntu.sh
```

### Renderへのデプロイ

`render.yaml` に Render 向けの設定が含まれています。Render ダッシュボードで環境変数 `GEMINI_API_KEY` を設定してください。

---
