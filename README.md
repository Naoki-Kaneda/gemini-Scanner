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

## セットアップ

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
