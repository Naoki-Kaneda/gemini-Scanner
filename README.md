# Gemini Vision Scanner

Google Gemini API を利用した画像解析 Web アプリケーションです。
ブラウザからカメラ撮影またはファイルアップロードで画像を送信し、テキスト検出・物体検出・顔検出・ロゴ検出・分類・AI識別などの解析結果を取得できます。

## 対応モード

| モード | 説明 |
|--------|------|
| `text` | 画像内テキストの検出（OCR） |
| `label` | ラベル・タグの検出 |
| `object` | 物体検出（バウンディングボックス付き） |
| `face` | 顔検出 |
| `logo` | ロゴ検出 |
| `classify` | 分類タグの推定 |
| `web` | AI による類似画像・Web エンティティ識別 |

## セットアップ（ローカル開発）

### 1. 依存パッケージのインストール

```bash
pip install -r requirements.txt
```

### 2. 環境変数の設定

```bash
cp .env.example .env
# .env を編集して GEMINI_API_KEY を設定
```

### 3. 起動

```bash
# Windows
start.bat

# Linux / macOS（HTTPS 自動設定付き）
chmod +x start.sh
./start.sh
```

ブラウザで `http://localhost:5000`（Windows）または `https://<サーバーIP>:5000`（Linux）にアクセスしてください。

## Ubuntu サーバーへのインストール

セットアップスクリプトで nginx + gunicorn + systemd の本番構成を自動構築できます。

### 構成図

```
ブラウザ → nginx (HTTPS:8443) → gunicorn (localhost:8001) → Flask app
```

### インストール手順

```bash
# 1. リポジトリをクローン
git clone https://github.com/Naoki-Kaneda/gemini-Scanner.git
cd gemini-Scanner

# 2. セットアップスクリプトを実行（root権限が必要）
sudo bash deploy/setup-ubuntu.sh
```

スクリプトが以下を自動で行います:

1. システムパッケージのインストール（Python3, nginx, openssl）
2. アプリケーション専用ユーザー（`gemini`）の作成
3. `/opt/gemini-scanner/` へのアプリ配置
4. Python 仮想環境の構築と依存パッケージのインストール
5. `.env` ファイルの作成（Gemini API キーの入力プロンプト）
6. 自己署名 SSL 証明書の生成（有効期限10年）
7. nginx / systemd の設定と自動起動

完了後、`https://<サーバーIP>:8443` でアクセスできます。

### Vision AI Scanner との共存

同一サーバーで Vision AI Scanner と同時運行できます。

| アプリ | アクセスURL | nginx ポート | gunicorn ポート |
|--------|-----------|-------------|----------------|
| Vision AI Scanner | `https://<IP>` | 443 | 8000 |
| Gemini Vision Scanner | `https://<IP>:8443` | 8443 | 8001 |

### よく使うコマンド

```bash
# 状態確認
sudo systemctl status gemini-scanner

# ログ確認（リアルタイム）
sudo journalctl -u gemini-scanner -f

# 再起動
sudo systemctl restart gemini-scanner

# 停止
sudo systemctl stop gemini-scanner

# 設定変更
sudo nano /opt/gemini-scanner/.env
sudo systemctl restart gemini-scanner
```

## レート制限キー方式（`RATE_LIMIT_KEY_MODE`）

レート制限のクライアント識別に使用するキー方式を環境変数で切り替えられます。

| 値 | キー構成 | 用途 |
|----|----------|------|
| `ip_ua`（デフォルト） | IP + User-Agent ハッシュ | NAT 配下で複数端末が同一 IP を共有する環境向け。端末ごとに独立したレート制限が適用されるため、他ユーザーの干渉を軽減できます。 |
| `ip` | IP アドレスのみ | デバッグや調査時にシンプルなキーで動作を確認したい場合に使用します。NAT 環境では複数端末が同一枠を消費する点に注意してください。 |

```bash
# .env での設定例
RATE_LIMIT_KEY_MODE=ip_ua
```

不正な値を設定した場合は起動時に警告ログが出力され、自動的に `ip_ua` にフォールバックします。

## テスト

```bash
pip install -r requirements-dev.txt
python -m pytest tests/ -q
```

## 本番デプロイ（Render）

`render.yaml` に Render 向けの設定が含まれています。
環境変数 `GEMINI_API_KEY` を Render ダッシュボードで設定してください。

## ライセンス

MIT
