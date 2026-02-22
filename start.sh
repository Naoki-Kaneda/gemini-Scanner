#!/usr/bin/env bash
echo "=== Gemini Vision Scanner 起動 ==="

CERT_DIR="certs"
CERT_FILE="$CERT_DIR/server.crt"
KEY_FILE="$CERT_DIR/server.key"

# SSL証明書が未作成なら自動生成
if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
    echo "[SSL] 自己署名SSL証明書を生成します..."
    mkdir -p "$CERT_DIR"

    # サーバーのIPアドレスを取得
    SERVER_IP=$(hostname -I | awk '{print $1}')
    echo "[SSL] サーバーIP: ${SERVER_IP}"

    openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout "$KEY_FILE" -out "$CERT_FILE" \
        -days 365 -subj "/CN=Gemini Vision Scanner" \
        -addext "subjectAltName=IP:${SERVER_IP},IP:127.0.0.1,DNS:localhost"

    echo "[SSL] 証明書を生成しました: $CERT_FILE"
    echo ""
    echo "=================================================="
    echo "  クライアントPCの初回アクセス時、ブラウザが"
    echo "  「この接続ではプライバシーが保護されません」と"
    echo "  警告を表示します。「詳細設定」→「アクセスする」"
    echo "  をクリックして続行してください。"
    echo "=================================================="
    echo ""
fi

# SSLパスを環境変数に設定
export SSL_CERT_PATH="$CERT_FILE"
export SSL_KEY_PATH="$KEY_FILE"

# ポート5000を使用中のプロセスを確認・停止
PID=$(lsof -ti :5000 2>/dev/null)
if [ -n "$PID" ]; then
    echo "[!] ポート5000を使用中のプロセス(PID:${PID})を停止します..."
    kill -9 $PID 2>/dev/null
    sleep 1
fi

# サーバーIPを表示
SERVER_IP=$(hostname -I | awk '{print $1}')
echo "[OK] HTTPS モードで起動中..."
echo "     アクセスURL: https://${SERVER_IP}:5000"
python app.py
