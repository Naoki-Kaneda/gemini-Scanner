#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Gemini Vision Scanner - Ubuntu セットアップスクリプト
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#
# 【使い方】
#   1. リポジトリをサーバーに配置
#      git clone https://github.com/Naoki-Kaneda/gemini-Scanner.git
#   2. sudo bash gemini-Scanner/deploy/setup-ubuntu.sh
#   3. プロンプトに従って GEMINI_API_KEY を入力
#   4. ブラウザで https://<サーバーIP>:8443 にアクセス
#
# 【構成】
#   nginx (HTTPS:8443) → gunicorn (localhost:8001) → Flask app
#   ※ ポート443/8000はVision AI Scannerが使用するため、8443/8001で共存
#   自己署名SSL証明書でHTTPS化（カメラ機能に必須）
#
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
set -euo pipefail

# ─── 設定 ────────────────────────────────────────────
APP_NAME="gemini-scanner"
APP_DIR="/opt/${APP_NAME}"
APP_USER="gemini"
SSL_DIR="/etc/nginx/ssl"
WORKERS=2
PORT=8001

# ─── 色付き出力 ──────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── root チェック ───────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    error "root権限が必要です。sudo bash deploy/setup-ubuntu.sh で実行してください。"
fi

# ─── スクリプトのあるディレクトリ（リポジトリのルート）を取得 ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

info "=== Gemini Vision Scanner セットアップ開始 ==="
info "リポジトリ: ${REPO_DIR}"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1. システムパッケージのインストール
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "1/7 システムパッケージをインストール中..."
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip nginx openssl > /dev/null

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 2. アプリケーションユーザー作成
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "2/7 アプリケーションユーザーを作成中..."
if ! id "$APP_USER" &>/dev/null; then
    useradd --system --shell /usr/sbin/nologin --home-dir "$APP_DIR" "$APP_USER"
    info "ユーザー '${APP_USER}' を作成しました。"
else
    info "ユーザー '${APP_USER}' は既に存在します。"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 3. アプリケーションの配置
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "3/7 アプリケーションを ${APP_DIR} に配置中..."
mkdir -p "$APP_DIR"
# リポジトリの中身をコピー（deploy/ と venv/ は除外）
rsync -a --exclude='deploy' --exclude='venv' --exclude='.venv' \
         --exclude='__pycache__' --exclude='.git' \
         "${REPO_DIR}/" "${APP_DIR}/"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 4. Python仮想環境と依存関係
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "4/7 Python仮想環境をセットアップ中..."
python3 -m venv "${APP_DIR}/venv"
"${APP_DIR}/venv/bin/pip" install --upgrade pip -q
"${APP_DIR}/venv/bin/pip" install -r "${APP_DIR}/requirements.txt" -q
info "依存パッケージのインストール完了。"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 5. 環境変数（.env）の設定
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "5/7 環境変数を設定中..."
ENV_FILE="${APP_DIR}/.env"

if [[ -f "$ENV_FILE" ]]; then
    warn ".env が既に存在します。上書きしません。"
else
    # GEMINI_API_KEY の入力を求める
    echo ""
    echo -e "${YELLOW}━━━ Google Gemini API キーの設定 ━━━${NC}"
    echo "Gemini API のキーを入力してください（後から ${ENV_FILE} で変更可能）:"
    read -r API_KEY

    if [[ -z "$API_KEY" ]]; then
        warn "APIキーが空です。後で ${ENV_FILE} に GEMINI_API_KEY を設定してください。"
        API_KEY="YOUR_API_KEY_HERE"
    fi

    # ADMIN_SECRET を自動生成（32文字のランダム文字列）
    ADMIN_SECRET=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)

    cat > "$ENV_FILE" << ENVEOF
# Gemini Vision Scanner 環境設定
GEMINI_API_KEY=${API_KEY}
GEMINI_MODEL=gemini-2.5-flash
APP_PORT=5000
FLASK_DEBUG=false
NO_PROXY_MODE=true
VERIFY_SSL=true
ADMIN_SECRET=${ADMIN_SECRET}
RATE_LIMIT_KEY_MODE=ip_ua
ENVEOF

    chmod 600 "$ENV_FILE"
    info ".env を作成しました。"
fi

# ファイルの所有者をアプリユーザーに設定
chown -R "${APP_USER}:${APP_USER}" "$APP_DIR"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 6. 自己署名SSL証明書の生成
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "6/7 自己署名SSL証明書を生成中..."
mkdir -p "$SSL_DIR"

if [[ -f "${SSL_DIR}/${APP_NAME}.crt" ]]; then
    warn "SSL証明書が既に存在します。上書きしません。"
else
    # サーバーのIPアドレスを取得（SAN に含める）
    SERVER_IP=$(hostname -I | awk '{print $1}')

    openssl req -x509 -nodes -days 3650 \
        -newkey rsa:2048 \
        -keyout "${SSL_DIR}/${APP_NAME}.key" \
        -out "${SSL_DIR}/${APP_NAME}.crt" \
        -subj "/C=JP/ST=Tokyo/O=GeminiScanner/CN=${SERVER_IP}" \
        -addext "subjectAltName=IP:${SERVER_IP},DNS:localhost" \
        2>/dev/null

    chmod 600 "${SSL_DIR}/${APP_NAME}.key"
    info "SSL証明書を生成しました（有効期限: 10年）"
    info "サーバーIP: ${SERVER_IP}"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 7. nginx / systemd の設定と起動
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "7/7 nginx と systemd を設定中..."

# nginx 設定ファイルをコピー
cp "${SCRIPT_DIR}/gemini-scanner.nginx" "/etc/nginx/sites-available/${APP_NAME}"

# 設定ファイル内のプレースホルダーを置換
sed -i "s|__SSL_DIR__|${SSL_DIR}|g" "/etc/nginx/sites-available/${APP_NAME}"
sed -i "s|__APP_NAME__|${APP_NAME}|g" "/etc/nginx/sites-available/${APP_NAME}"
sed -i "s|__PORT__|${PORT}|g" "/etc/nginx/sites-available/${APP_NAME}"
sed -i "s|__APP_DIR__|${APP_DIR}|g" "/etc/nginx/sites-available/${APP_NAME}"

# シンボリックリンクで有効化
ln -sf "/etc/nginx/sites-available/${APP_NAME}" "/etc/nginx/sites-enabled/${APP_NAME}"

# nginx 設定テスト
nginx -t 2>/dev/null || error "nginx 設定にエラーがあります。"

# systemd サービスファイルをコピー
cp "${SCRIPT_DIR}/gemini-scanner.service" "/etc/systemd/system/${APP_NAME}.service"

# サービスファイル内のプレースホルダーを置換
sed -i "s|__APP_DIR__|${APP_DIR}|g" "/etc/systemd/system/${APP_NAME}.service"
sed -i "s|__APP_USER__|${APP_USER}|g" "/etc/systemd/system/${APP_NAME}.service"
sed -i "s|__WORKERS__|${WORKERS}|g" "/etc/systemd/system/${APP_NAME}.service"
sed -i "s|__PORT__|${PORT}|g" "/etc/systemd/system/${APP_NAME}.service"

# サービスの有効化と起動
systemctl daemon-reload
systemctl enable "${APP_NAME}" --quiet
systemctl restart "${APP_NAME}"
systemctl restart nginx

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 完了メッセージ
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SERVER_IP=$(hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  セットアップ完了！${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  アクセスURL: https://${SERVER_IP}:8443"
echo ""
echo -e "  ${YELLOW}※ 自己署名証明書のため、ブラウザで警告が出ます。${NC}"
echo -e "  ${YELLOW}  「詳細設定」→「安全でないサイトに進む」で利用できます。${NC}"
echo ""
echo "  ─── よく使うコマンド ───"
echo "  状態確認:   sudo systemctl status ${APP_NAME}"
echo "  ログ確認:   sudo journalctl -u ${APP_NAME} -f"
echo "  再起動:     sudo systemctl restart ${APP_NAME}"
echo "  停止:       sudo systemctl stop ${APP_NAME}"
echo "  設定変更:   sudo nano ${APP_DIR}/.env"
echo ""
echo "  ─── 同一サーバーで Vision AI Scanner と共存 ───"
echo "  Vision AI Scanner: https://${SERVER_IP}     (ポート443)"
echo "  Gemini Scanner:    https://${SERVER_IP}:8443 (ポート8443)"
echo ""
