#!/usr/bin/env bash
echo "=== Gemini Vision Scanner 起動 ==="

# .envからAPP_PORTを読み込み（未設定なら5000）
if [ -f .env ]; then
    APP_PORT=$(grep -E '^APP_PORT=' .env 2>/dev/null | cut -d= -f2)
fi
APP_PORT="${APP_PORT:-5000}"
export APP_PORT

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

# 指定ポートを使用中のプロセスを確認・停止（安全確認付き）
PIDS=$(lsof -ti :"$APP_PORT" 2>/dev/null)
if [ -n "$PIDS" ]; then
    echo "[!] ポート${APP_PORT}を使用中のプロセスが見つかりました:"
    for PID in $PIDS; do
        PROC_NAME=$(ps -p "$PID" -o comm= 2>/dev/null || echo "不明")
        echo "    PID: ${PID}  プロセス名: ${PROC_NAME}"
    done
    read -r -p "これらのプロセスを停止しますか？ (y/N): " ANSWER
    if [ "$ANSWER" = "y" ] || [ "$ANSWER" = "Y" ]; then
        for PID in $PIDS; do
            kill "$PID" 2>/dev/null
        done
        sleep 1
        # GRACEFULに停止できなかった場合のみ強制終了
        REMAINING=$(lsof -ti :"$APP_PORT" 2>/dev/null)
        if [ -n "$REMAINING" ]; then
            echo "[!] graceful停止に失敗したプロセスを強制終了します..."
            for PID in $REMAINING; do
                kill -9 "$PID" 2>/dev/null
            done
            sleep 1
        fi
        echo "[OK] プロセスを停止しました。"
    else
        echo "[中止] プロセスの停止をキャンセルしました。ポート${APP_PORT}が使用中のため起動できません。"
        exit 1
    fi
fi

# サーバーIPを表示
SERVER_IP=$(hostname -I | awk '{print $1}')
echo "[OK] HTTPS モードで起動中..."
echo "     アクセスURL: https://${SERVER_IP}:${APP_PORT}"
python app.py
