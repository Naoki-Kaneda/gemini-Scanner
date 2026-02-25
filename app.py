"""
Gemini Vision Scanner - メインアプリケーション。
カメラ映像からテキスト抽出・物体検出を行うWebアプリケーション。
"""

from __future__ import annotations

import os
import base64
import hashlib
import logging
import secrets
import socket

from flask import Flask, render_template, request, jsonify, g
from flask.wrappers import Response
from werkzeug.middleware.proxy_fix import ProxyFix
from dotenv import load_dotenv
from gemini_api import detect_content, get_proxy_status, set_proxy_enabled, VALID_MODES, API_KEY
from rate_limiter import (
    try_consume_request, release_request, RATE_LIMIT_DAILY,
    RATE_LIMIT_PER_MINUTE, get_daily_count, get_backend_type, REDIS_URL,
)

# ─── 設定 ──────────────────────────────────────
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    force=True,  # 既存のハンドラを上書きして確実にログ出力
)
logger = logging.getLogger(__name__)
# werkzeug リクエストログを明示的に有効化
logging.getLogger("werkzeug").setLevel(logging.INFO)

APP_VERSION = "2.0.0"                     # テンプレートに自動注入される
FLASK_DEBUG = os.getenv("FLASK_DEBUG", "false").lower() == "true"
APP_PORT = int(os.getenv("APP_PORT", "5000"))  # 同一サーバー共存時に変更可能
MAX_IMAGE_SIZE = 5 * 1024 * 1024          # 5MB（Base64デコード後）
MAX_REQUEST_BODY = 10 * 1024 * 1024       # 10MB（Base64 + JSONオーバーヘッド）
ADMIN_SECRET = os.getenv("ADMIN_SECRET", "")  # 管理API認証用シークレット
# レート制限キー方式: "ip_ua"=IP+UserAgent複合キー, "ip"=IPのみ
_VALID_KEY_MODES = {"ip_ua", "ip"}
_raw_key_mode = os.getenv("RATE_LIMIT_KEY_MODE", "ip").lower()
if _raw_key_mode not in _VALID_KEY_MODES:
    logging.getLogger(__name__).warning(
        "RATE_LIMIT_KEY_MODE=%r は無効です（有効値: %s）。デフォルト ip を使用します。",
        _raw_key_mode, ", ".join(sorted(_VALID_KEY_MODES)),
    )
    _raw_key_mode = "ip"
RATE_LIMIT_KEY_MODE = _raw_key_mode

# ─── エラーコード定数（タイポ防止） ────────────────────
ERR_INVALID_FORMAT = "INVALID_FORMAT"
ERR_MISSING_IMAGE = "MISSING_IMAGE"
ERR_INVALID_MODE = "INVALID_MODE"
ERR_INVALID_BASE64 = "INVALID_BASE64"
ERR_IMAGE_TOO_LARGE = "IMAGE_TOO_LARGE"
ERR_INVALID_IMAGE_FORMAT = "INVALID_IMAGE_FORMAT"
ERR_RATE_LIMITED = "APP_RATE_LIMITED"  # アプリ側レート制限（Google側 RATE_LIMITED と区別）
ERR_VALIDATION_ERROR = "VALIDATION_ERROR"
ERR_SERVER_ERROR = "SERVER_ERROR"
ERR_REQUEST_TOO_LARGE = "REQUEST_TOO_LARGE"
ERR_BAD_REQUEST = "BAD_REQUEST"
ERR_UNAUTHORIZED = "UNAUTHORIZED"
ERR_INVALID_TYPE = "INVALID_TYPE"
ERR_METHOD_NOT_ALLOWED = "METHOD_NOT_ALLOWED"

# 起動時セキュリティチェック
def _check_admin_secret(secret: str) -> list[str]:
    """ADMIN_SECRETの強度を検証し、警告メッセージのリストを返す。"""
    warnings = []
    if not secret:
        warnings.append("ADMIN_SECRET が未設定です。管理API（プロキシ設定変更）は常に403を返します。")
        return warnings
    if len(secret) < 16:
        warnings.append("ADMIN_SECRET が短すぎます（16文字以上を推奨）。")
    # 高エントロピー判定: 最低3種類の文字種（大文字/小文字/数字/記号）を含むこと
    char_types = sum([
        any(c.isupper() for c in secret),
        any(c.islower() for c in secret),
        any(c.isdigit() for c in secret),
        any(not c.isalnum() for c in secret),
    ])
    if char_types < 3:
        warnings.append(
            "ADMIN_SECRET のエントロピーが低い可能性があります（文字種が少ない）。"
            " ランダム生成を推奨: python -c \"import secrets; print(secrets.token_urlsafe(32))\""
        )
    return warnings

for _warn in _check_admin_secret(ADMIN_SECRET):
    logger.warning(_warn)

# CORS: 許可するOrigin（カンマ区切り）。未設定 = 同一オリジンのみ（デフォルト安全）
ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()
]

# 画像フォーマット検証: 許可するMIMEタイプのマジックバイト
ALLOWED_IMAGE_MAGIC = {
    b"\xff\xd8\xff": "image/jpeg",
    b"\x89PNG\r\n\x1a\n": "image/png",
}


# ─── アプリケーション初期化 ─────────────────────
app = Flask(__name__)

# リクエストボディの最大サイズ（Base64画像の5MB + JSONオーバーヘッド）
app.config["MAX_CONTENT_LENGTH"] = MAX_REQUEST_BODY

# 静的ファイルのブラウザキャッシュを無効化（開発時のキャッシュ問題を防止）
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

# テンプレートをリクエストごとにディスクから再読み込み
app.config["TEMPLATES_AUTO_RELOAD"] = True

# 静的ファイルのハッシュキャッシュ（起動中はファイル変更時に自動更新）
_static_hash_cache = {}


def _static_file_hash(filename: str) -> str:
    """静的ファイルのMD5ハッシュ先頭8文字を返す（キャッシュバスティング用）。

    filename単位でキャッシュし、mtimeが変わったら上書きする。
    従来は filename:mtime をキーにしていたため更新のたびに辞書が肥大していた。
    """
    filepath = os.path.join(app.static_folder, filename)
    try:
        mtime = os.path.getmtime(filepath)
        cached = _static_hash_cache.get(filename)
        if cached and cached[0] == mtime:
            return cached[1]
        with open(filepath, "rb") as f:
            digest = hashlib.md5(f.read()).hexdigest()[:8]
        _static_hash_cache[filename] = (mtime, digest)
        return digest
    except OSError:
        return "0"


@app.context_processor
def inject_template_globals():
    """テンプレートに共通変数を注入する（キャッシュバスティング関数・バージョン）。"""
    return {"static_hash": _static_file_hash, "app_version": APP_VERSION}


# プロキシ配下でのIP取得を正しく行う（X-Forwarded-For対応）
TRUST_PROXY = os.getenv("TRUST_PROXY", "false").lower() == "true"
if TRUST_PROXY:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
    logger.info("TRUST_PROXY: X-Forwarded-For からクライアントIPを取得します")
else:
    # Render/nginx等のプロキシ環境を検出して警告
    _proxy_hints = [os.getenv("RENDER"), os.getenv("DYNO"), os.getenv("FLY_APP_NAME")]
    if any(_proxy_hints):
        logger.warning(
            "⚠ プロキシ環境を検出しましたが TRUST_PROXY=false です。"
            "全ユーザーが同一IPとして認識され、レート制限が偏る可能性があります。"
            "TRUST_PROXY=true の設定を推奨します。"
        )


# ─── リクエストコンテキスト（request-id / CSPノンス） ──
@app.before_request
def set_request_context():
    """リクエストごとに一意のIDとCSPノンスを生成する。"""
    g.request_id = secrets.token_hex(8)
    g.csp_nonce = secrets.token_urlsafe(16)


# ─── セキュリティヘッダー ─────────────────────────
@app.after_request
def add_security_headers(response):
    """全レスポンスにセキュリティヘッダーを付与する。"""
    nonce = getattr(g, "csp_nonce", "")
    req_id = getattr(g, "request_id", "")

    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

    # CSP: nonce化により unsafe-inline を完全排除
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        f"script-src 'self' 'nonce-{nonce}'; "
        f"style-src 'self' 'nonce-{nonce}' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' blob: data:; "
        "media-src 'self' blob: mediastream:; "
        "connect-src 'self'"
    )

    # カメラ・マイクのアクセスを同一オリジンに限定
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(self)"

    # キャッシュ制御: APIとHTMLは no-store、静的ファイルはハッシュ付きURLで長期キャッシュ
    if request.path.startswith("/static/"):
        # 静的ファイル: ハッシュ付きURLで配信しているためブラウザキャッシュを活用
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    else:
        # API・HTML: キャッシュ無効化（常に最新を返す）
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"

    # 相関IDをレスポンスヘッダーに付与（障害調査用）
    if req_id:
        response.headers["X-Request-Id"] = req_id

    # CORS: 明示的に許可されたOriginのみ
    if ALLOWED_ORIGINS:
        origin = request.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Headers"] = "Content-Type"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        # CDN/プロキシが異なるOrigin向けレスポンスを混在キャッシュしないよう Vary を付与
        # Werkzeug の HeaderSet で既存値を保持しつつ Origin を追記（重複自動排除）
        response.vary.add("Origin")

    return response


# ─── Flaskエラーハンドラ（統一JSONレスポンス） ─────
@app.errorhandler(413)
def handle_request_too_large(_e):
    """リクエストボディが MAX_CONTENT_LENGTH を超えた場合のJSONレスポンス。"""
    return _error_response(
        ERR_REQUEST_TOO_LARGE,
        f"リクエストサイズが上限({MAX_REQUEST_BODY // (1024*1024)}MB)を超えています",
        status_code=413,
    )


@app.errorhandler(400)
def handle_bad_request(_e):
    """Flaskが投げる400エラーのJSONレスポンス。"""
    return _error_response(ERR_BAD_REQUEST, "不正なリクエストです", status_code=400)


@app.errorhandler(405)
def handle_method_not_allowed(_e):
    """許可されていないHTTPメソッドのJSONレスポンス。"""
    return _error_response(ERR_METHOD_NOT_ALLOWED, "許可されていないHTTPメソッドです", status_code=405)


# ─── レートキー生成 ──────────────────────────────
def _build_rate_key() -> tuple[str, str]:
    """リクエストのIP（+UserAgent）からレート制限キーを生成する。"""
    client_ip = request.remote_addr or "unknown"
    if RATE_LIMIT_KEY_MODE == "ip_ua":
        ua_fragment = (request.headers.get("User-Agent", "") or "")[:64]
        return client_ip, f"{client_ip}:{hashlib.sha256(ua_fragment.encode()).hexdigest()[:8]}"
    return client_ip, client_ip


# ─── レスポンスヘルパー ────────────────────────────
def _is_admin_authenticated() -> bool:
    """リクエストのX-Admin-Secretヘッダーで管理者認証を検証する。

    Returns:
        bool: ADMIN_SECRETが設定済みかつヘッダー値が一致すればTrue
    """
    if not ADMIN_SECRET:
        return False
    auth_header = request.headers.get("X-Admin-Secret", "")
    return secrets.compare_digest(auth_header, ADMIN_SECRET)


def _error_response(
    error_code: str, message: str, status_code: int = 400,
    headers: dict[str, str] | None = None,
    retry_after: int | None = None,
) -> tuple[Response, int]:
    """標準化されたエラーレスポンスを生成する。

    全エラーレスポンスで統一形式を保証:
      ok, data, error_code, message, request_id, retry_after
    """
    response = jsonify({
        "ok": False,
        "data": [],
        "error_code": error_code,
        "message": message,
        "request_id": getattr(g, "request_id", ""),
        "retry_after": retry_after,
    })
    if headers:
        for key, value in headers.items():
            response.headers[key] = value
    return response, status_code


def _log(level: str, event: str, **kwargs: object) -> None:
    """構造化ログ出力（request-id自動付与）。"""
    req_id = getattr(g, "request_id", "-")
    parts = [f"event={event}", f"request_id={req_id}"]
    parts.extend(f"{k}={v}" for k, v in kwargs.items())
    getattr(logger, level)(" ".join(parts))


# ─── 画像フォーマット検証 ──────────────────────────
def _validate_image_format(decoded_bytes: bytes) -> bool:
    """
    デコード済みバイト列のマジックバイトを検査し、許可されたフォーマットか判定する。

    Returns:
        bool: JPEG/PNG なら True、それ以外は False
    """
    for magic_bytes in ALLOWED_IMAGE_MAGIC:
        if decoded_bytes[:len(magic_bytes)] == magic_bytes:
            return True
    return False


# ─── ヘルスチェック ──────────────────────────────
@app.route("/healthz")
def healthz():
    """Liveness: アプリケーションが起動しているか（依存なし）"""
    return jsonify({"status": "ok"})


@app.route("/readyz")
def readyz():
    """Readiness: リクエスト処理可能か（APIキー・バックエンド等の設定チェック）

    認証なし: status のみ返す（ヘルスチェックプローブ用）
    認証あり (X-Admin-Secret): checks・warnings 等の詳細情報を返す

    クエリパラメータ:
        check_api=true: Gemini APIエンドポイントへのDNS到達性も検査する（管理者のみ）
    """
    rate_backend = get_backend_type()

    # REDIS_URL が設定されているのにインメモリにフォールバックしている場合は警告
    redis_fallback = bool(REDIS_URL) and rate_backend == "in_memory"

    all_ok = bool(API_KEY) and not redis_fallback

    # 認証なし: status のみ（インフラ情報を公開しない）
    if not _is_admin_authenticated():
        return jsonify({"status": "ok" if all_ok else "not_ready"}), 200 if all_ok else 503

    # 認証あり: 詳細な診断情報を返す
    checks = {
        "api_key_configured": bool(API_KEY),
        "rate_limiter_backend": rate_backend,
        "rate_limiter_ok": not redis_fallback,
    }

    warnings_list = []
    if redis_fallback:
        warnings_list.append(
            "REDIS_URL が設定されていますが、Redis接続に失敗しインメモリにフォールバックしています"
        )

    # オプション: Gemini APIエンドポイントの到達性チェック（管理者のみ）
    if request.args.get("check_api", "").lower() == "true":
        try:
            socket.getaddrinfo("generativelanguage.googleapis.com", 443, socket.AF_UNSPEC, socket.SOCK_STREAM)
            checks["api_reachable"] = True
        except socket.gaierror:
            checks["api_reachable"] = False
            warnings_list.append("Gemini API (generativelanguage.googleapis.com) のDNS解決に失敗しました")

    response_data = {
        "status": "ok" if all_ok else "not_ready",
        "checks": checks,
    }
    if warnings_list:
        response_data["warnings"] = warnings_list

    return jsonify(response_data), 200 if all_ok else 503


# ─── ルーティング ────────────────────────────────
@app.route("/")
def index():
    """アプリケーションのメインページを表示する"""
    return render_template("index.html", csp_nonce=g.csp_nonce)


@app.route("/api/config/limits", methods=["GET"])
def get_rate_limits():
    """レート制限設定値をフロントエンドに返す"""
    return jsonify({"daily_limit": RATE_LIMIT_DAILY})


@app.route("/api/config/usage", methods=["GET"])
def get_usage():
    """
    現在のAPI使用量をサーバー側の実データから返す。

    フロントエンドの localStorage カウントはブラウザ・端末ごとに分断されるため、
    NAT環境やマルチデバイスで不整合が発生する。このエンドポイントで正確な値を提供する。

    レスポンスJSON:
        daily_count: 今日のAPI呼び出し回数（サーバー側カウント）
        daily_limit: 1日のAPI呼び出し上限
        per_minute_limit: 分あたりのAPI呼び出し上限
    """
    _client_ip, rate_key = _build_rate_key()
    count = get_daily_count(rate_key)
    return jsonify({
        "daily_count": count,
        "daily_limit": RATE_LIMIT_DAILY,
        "per_minute_limit": RATE_LIMIT_PER_MINUTE,
    })


@app.route("/api/config/proxy", methods=["GET"])
def get_proxy_config():
    """現在のプロキシ設定状態を返す（認証時はURL情報付き、未認証時はON/OFFのみ）"""
    status = get_proxy_status()
    if not _is_admin_authenticated():
        return jsonify({"enabled": status["enabled"]})
    return jsonify(status)


@app.route("/api/config/proxy", methods=["POST"])
def update_proxy_config():
    """プロキシ設定を更新する（認証必須）"""
    if not _is_admin_authenticated():
        return _error_response(ERR_UNAUTHORIZED, "管理APIへのアクセス権がありません", 403)

    if not request.is_json:
        return _error_response(ERR_INVALID_FORMAT, "リクエストはJSON形式である必要があります")

    data = request.get_json(silent=True)
    if not isinstance(data, dict) or "enabled" not in data:
        return _error_response(ERR_INVALID_FORMAT, "enabledフィールドを含むJSONオブジェクトが必要です")

    if not isinstance(data["enabled"], bool):
        return _error_response(ERR_INVALID_TYPE, "enabledフィールドはboolean型(true/false)である必要があります")

    new_status = set_proxy_enabled(data["enabled"])
    return jsonify({"ok": True, "status": new_status})


def _validate_analyze_request() -> tuple[str | None, str | None, str | None, tuple[Response, int] | None]:
    """
    /api/analyze のリクエストを検証し、画像データ・モード・ヒントを返す。

    Returns:
        tuple: (image_data, mode, hint, None) 成功時
               (None, None, None, error_response) 失敗時
    """
    if not request.is_json:
        return None, None, None, _error_response(ERR_INVALID_FORMAT, "リクエストはJSON形式である必要があります")

    data = request.get_json(silent=True)
    if data is None:
        return None, None, None, _error_response(ERR_INVALID_FORMAT, "JSONのパースに失敗しました")

    if not isinstance(data, dict):
        return None, None, None, _error_response(ERR_INVALID_FORMAT, "リクエストボディはJSONオブジェクトである必要があります")

    image_data = data.get("image")
    if not image_data or not isinstance(image_data, str) or not image_data.strip():
        return None, None, None, _error_response(ERR_MISSING_IMAGE, "画像データがありません")

    mode = data.get("mode", "text")
    if not isinstance(mode, str) or mode not in VALID_MODES:
        return None, None, None, _error_response(ERR_INVALID_MODE, f"不正なモード: '{mode}'。許可値: {list(VALID_MODES)}")

    # キーワードヒント（任意）: 制御文字を除去し200文字に制限
    hint = data.get("hint", "")
    if not isinstance(hint, str):
        hint = ""
    hint = "".join(c for c in hint if c.isprintable()).strip()[:200]

    # data:image/jpeg;base64, プレフィックスを除去
    if "," in image_data:
        image_data = image_data.split(",")[1]

    # Base64デコード検証 & サイズチェック & フォーマット検証
    try:
        decoded = base64.b64decode(image_data, validate=True)
        if len(decoded) > MAX_IMAGE_SIZE:
            return None, None, None, _error_response(
                ERR_IMAGE_TOO_LARGE,
                f"画像サイズが上限({MAX_IMAGE_SIZE // (1024*1024)}MB)を超えています",
            )
        # MIME magic byte 検証（JPEG/PNGのみ許可）
        if not _validate_image_format(decoded):
            return None, None, None, _error_response(
                ERR_INVALID_IMAGE_FORMAT,
                "許可されていない画像形式です（JPEG/PNGのみ対応）",
            )
    except Exception as e:
        logger.warning("Base64検証で想定外の例外 (%s): %s", type(e).__name__, e)
        return None, None, None, _error_response(ERR_INVALID_BASE64, "画像データのBase64デコードに失敗しました")

    return image_data, mode, hint, None


@app.route("/api/analyze", methods=["OPTIONS"])
def analyze_preflight():
    """CORSプリフライトリクエストを明示的に処理する。

    after_request でCORSヘッダーを付与しているが、OPTIONSを明示しないと
    一部のWSGIサーバー（gunicorn等）が405を返す環境差分がある。
    空の204レスポンスを返し、after_requestがCORSヘッダーを付与する。
    """
    return "", 204


@app.route("/api/analyze", methods=["POST"])
def analyze_endpoint():
    """
    画像を受け取り、Gemini APIで解析して結果を返す。

    リクエストJSON:
        image: Base64エンコードされた画像（data:image/jpeg;base64,...形式）
        mode: 'text'（OCR）または 'object'（物体検出）

    レスポンスJSON:
        ok: 成功/失敗
        data: 検出結果の文字列リスト
        error_code: エラーコード（エラー時のみ）
        message: エラーメッセージ（エラー時のみ）
    """
    # ─── リクエスト検証 ─────────────────
    image_data, mode, hint, validation_error = _validate_analyze_request()
    if validation_error:
        return validation_error

    # ─── レート制限チェック＆予約（原子的） ──
    client_ip, rate_key = _build_rate_key()
    limited, limit_message, payload = try_consume_request(rate_key)
    if limited:
        # payload=None は日次超過、payload=int は分制限超過（待機秒数）
        is_daily = payload is None
        _log("info", "rate_limited", ip=client_ip, reason=limit_message,
             limit_type="daily" if is_daily else "minute")
        # 日次制限は翌日まで復旧しないため長めに設定、分制限は計算された待機秒数を通知
        retry_after = str(payload) if not is_daily else "60"
        retry_after_int = int(retry_after)
        response = jsonify({
            "ok": False,
            "data": [],
            "error_code": ERR_RATE_LIMITED,
            "message": limit_message,
            "request_id": getattr(g, "request_id", ""),
            "retry_after": retry_after_int,
            "limit_type": "daily" if is_daily else "minute",
        })
        response.headers["Retry-After"] = retry_after
        return response, 429

    # ─── Gemini API呼び出し ─────────────
    request_id = payload  # 成功時は request_id が入っている
    try:
        result = detect_content(image_data, mode, request_id=g.request_id, context_hint=hint)

        # 統一形式: 全レスポンスに request_id を注入
        result["request_id"] = getattr(g, "request_id", "")

        if result["ok"]:
            result["retry_after"] = None
            _log("info", "api_success", ip=client_ip, mode=mode, items=len(result["data"]))
            return jsonify(result), 200

        release_request(rate_key, request_id)
        _log("warning", "api_failure", ip=client_ip, mode=mode, error_code=result["error_code"])
        if result.get("error_code") == "GEMINI_RATE_LIMITED":
            result["retry_after"] = 30
            response = jsonify(result)
            response.headers["Retry-After"] = "30"
            return response, 429
        result["retry_after"] = None
        return jsonify(result), 502

    except ValueError as e:
        release_request(rate_key, request_id)
        _log("warning", "validation_error", ip=client_ip, mode=mode, error=str(e))
        # 内部パス等の情報漏洩を防止するため、汎用メッセージをクライアントに返す
        return _error_response(ERR_VALIDATION_ERROR, "リクエストの処理に失敗しました")

    except Exception as e:
        release_request(rate_key, request_id)
        _log("error", "server_error", ip=client_ip, mode=mode, error=str(e))
        logger.exception("予期しない例外が発生しました (request_id=%s)", getattr(g, "request_id", "-"))
        return _error_response(ERR_SERVER_ERROR, "内部サーバーエラーが発生しました", 500)


if __name__ == "__main__":
    # 本番環境に近い状態（SSL設定あり等）でのデバッグモード誤有効化を防止
    is_debug = FLASK_DEBUG
    ssl_cert = os.environ.get("SSL_CERT_PATH")
    ssl_key = os.environ.get("SSL_KEY_PATH")

    if ssl_cert and ssl_key:
        logger.info("HTTPS モードで起動 (証明書: %s)", ssl_cert)
        app.run(debug=is_debug, host="0.0.0.0", port=APP_PORT,
                ssl_context=(ssl_cert, ssl_key))
    else:
        app.run(debug=is_debug, port=APP_PORT)
