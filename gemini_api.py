"""
Gemini API モジュール。
Google Gemini APIを使用してテキスト抽出（OCR）と物体検出を行う。
"""

import os
import io
import json
import base64
import logging
import random
import time
from threading import Lock

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import urllib3
from dotenv import load_dotenv
from PIL import Image, ImageEnhance

from translations import (
    OBJECT_TRANSLATIONS,
    EMOTION_LIKELIHOOD,
    EMOTION_NAMES,
    LABEL_TRANSLATIONS,
)

# ─── 設定 ──────────────────────────────────────
# OS環境変数を優先し、未設定の場合のみ .env から読み込む（本番環境の安全性確保）
load_dotenv()

logger = logging.getLogger(__name__)

API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite")
API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models/"

# プロキシ設定（NO_PROXY_MODE=trueなら初期状態でプロキシを無視）
NO_PROXY_MODE = os.getenv("NO_PROXY_MODE", "false").lower() == "true"
_RAW_PROXY_URL = os.getenv("PROXY_URL", "")


def _get_active_proxy_config():
    """現在の設定に基づいてプロキシ辞書を生成する"""
    if NO_PROXY_MODE or not _RAW_PROXY_URL:
        return {}
    return {"http": _RAW_PROXY_URL, "https": _RAW_PROXY_URL}


def _mask_proxy_url(url):
    """プロキシURLの認証情報をマスクする（例: http://user:pass@host → http://***:***@host）"""
    if not url or "@" not in url:
        return url
    scheme_end = url.find("://")
    if scheme_end == -1:
        return "***"
    at_pos = url.index("@")
    return url[:scheme_end + 3] + "***:***" + url[at_pos:]


VERIFY_SSL = os.getenv("VERIFY_SSL", "true").lower() != "false"

# VALID_MODES: _MODE_HANDLERS から自動導出（ファイル末尾で定義）

# ─── Gemini API プロンプト設計 ─────────────────────────
MODE_PROMPTS = {
    "text": (
        "この画像からすべてのテキストを検出してください。"
        "各テキストブロックのテキスト内容とバウンディングボックスを返してください。"
    ),
    "object": (
        "この画像内のすべての物体を検出してください。"
        "各物体の英語名(name)、日本語名(name_ja)、確信度(score)、"
        "バウンディングボックス(box_2d)を返してください。"
        "最大10個まで検出してください。"
    ),
    "label": (
        "この画像にラベル、テキスト、ステッカー、バーコード、QRコードなどが存在するか判定してください。"
        "テキストが読み取れる場合はその内容とバウンディングボックスも返してください。"
        "label_detectedはラベルやテキストが存在すればtrue、なければfalseにしてください。"
        "reasonには判定理由を記述してください。"
    ),
    "face": (
        "この画像内のすべての顔を検出してください。"
        "各顔のバウンディングボックス(box_2d)、検出確信度(confidence)、感情分析を返してください。"
        "感情はjoy, sorrow, anger, surpriseの4種類で、"
        "各レベルはVERY_UNLIKELY, UNLIKELY, POSSIBLE, LIKELY, VERY_LIKELYのいずれかで表してください。"
    ),
    "logo": (
        "この画像内のすべてのブランドロゴを検出してください。"
        "各ロゴのブランド名(name)、確信度(score)、バウンディングボックス(box_2d)を返してください。"
    ),
    "classify": (
        "この画像を分析し、最も関連性の高い分類タグを最大10個返してください。"
        "各タグの英語名(name)、日本語名(name_ja)、確信度(score)を含めてください。"
    ),
    "web": (
        "この画像に映っている物や場所を詳しく識別してください。"
        "以下の情報を返してください："
        "1. best_guess: 画像の最も可能性の高い識別名（日本語）"
        "2. entities: 関連するキーワードやエンティティ（最大5個）"
        "3. description: 画像の詳細な説明（日本語）"
    ),
}

# ─── 感情レベル定義（JSON Schema enum制約用） ──────────────
EMOTION_LEVELS = ["VERY_UNLIKELY", "UNLIKELY", "POSSIBLE", "LIKELY", "VERY_LIKELY"]

MODE_SCHEMAS = {
    "text": {
        "type": "OBJECT",
        "properties": {
            "texts": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "text": {"type": "STRING"},
                        "box_2d": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                    },
                    "required": ["text", "box_2d"],
                },
            },
        },
        "required": ["texts"],
    },
    "object": {
        "type": "OBJECT",
        "properties": {
            "objects": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "name": {"type": "STRING"},
                        "name_ja": {"type": "STRING"},
                        "score": {"type": "NUMBER", "minimum": 0, "maximum": 1},
                        "box_2d": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                    },
                    "required": ["name", "score", "box_2d"],
                },
            },
        },
        "required": ["objects"],
    },
    "label": {
        "type": "OBJECT",
        "properties": {
            "label_detected": {"type": "BOOLEAN"},
            "reason": {"type": "STRING"},
            "texts": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "text": {"type": "STRING"},
                        "box_2d": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                    },
                    "required": ["text", "box_2d"],
                },
            },
        },
        "required": ["label_detected", "reason"],
    },
    "face": {
        "type": "OBJECT",
        "properties": {
            "faces": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "box_2d": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                        "confidence": {"type": "NUMBER", "minimum": 0, "maximum": 1},
                        "joy": {"type": "STRING", "enum": EMOTION_LEVELS},
                        "sorrow": {"type": "STRING", "enum": EMOTION_LEVELS},
                        "anger": {"type": "STRING", "enum": EMOTION_LEVELS},
                        "surprise": {"type": "STRING", "enum": EMOTION_LEVELS},
                    },
                    "required": ["box_2d", "confidence", "joy", "sorrow", "anger", "surprise"],
                },
            },
        },
        "required": ["faces"],
    },
    "logo": {
        "type": "OBJECT",
        "properties": {
            "logos": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "name": {"type": "STRING"},
                        "score": {"type": "NUMBER", "minimum": 0, "maximum": 1},
                        "box_2d": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                    },
                    "required": ["name", "score", "box_2d"],
                },
            },
        },
        "required": ["logos"],
    },
    "classify": {
        "type": "OBJECT",
        "properties": {
            "labels": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "name": {"type": "STRING"},
                        "name_ja": {"type": "STRING"},
                        "score": {"type": "NUMBER", "minimum": 0, "maximum": 1},
                    },
                    "required": ["name", "score"],
                },
            },
        },
        "required": ["labels"],
    },
    "web": {
        "type": "OBJECT",
        "properties": {
            "best_guess": {"type": "STRING"},
            "entities": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "name": {"type": "STRING"},
                        "score": {"type": "NUMBER", "minimum": 0, "maximum": 1},
                    },
                    "required": ["name", "score"],
                },
            },
            "description": {"type": "STRING"},
        },
        "required": ["best_guess", "entities"],
    },
}

API_TIMEOUT_SECONDS = 30  # Gemini 2.5-flash（思考モデル）は応答に時間がかかるため余裕を持たせる
GEMINI_429_MAX_RETRIES = max(0, int(os.getenv("GEMINI_429_MAX_RETRIES", "2")))  # 負値は0に正規化
GEMINI_429_BACKOFF_BASE_SECONDS = float(os.getenv("GEMINI_429_BACKOFF_BASE_SECONDS", "1.5"))

# ─── エラーコード定数（タイポ防止） ─────────────────────
ERR_TIMEOUT = "TIMEOUT"
ERR_CONNECTION_ERROR = "CONNECTION_ERROR"
ERR_REQUEST_ERROR = "REQUEST_ERROR"
ERR_PARSE_ERROR = "PARSE_ERROR"
ERR_API_RESPONSE_NOT_JSON = "API_RESPONSE_NOT_JSON"
ERR_SAFETY_BLOCKED = "SAFETY_BLOCKED"

# ─── 画像前処理パラメータ ───────────────────────────
MAX_IMAGE_PIXELS = 20_000_000  # 最大ピクセル数（約80MB RAM相当）
CONTRAST_FACTOR = 1.5          # コントラスト強調係数
SHARPNESS_FACTOR = 1.5         # シャープネス強調係数（文字の輪郭を明確に）
JPEG_QUALITY = 95              # JPEG保存品質
BOX_SCALE = 1000               # Gemini box_2d 座標の正規化スケール（0〜1000）
GENERATION_TEMPERATURE = 0.1   # 低温度で一貫した結果を得る
SIGNIFICANT_EMOTION_LEVELS = frozenset({"POSSIBLE", "LIKELY", "VERY_LIKELY"})

# ─── System Instruction（全モード共通制約） ──────────────
_SYSTEM_INSTRUCTION = (
    "あなたは画像解析AIです。以下の共通ルールに従ってJSON形式で応答してください。\n"
    "- バウンディングボックス(box_2d)は[ymin, xmin, ymax, xmax]形式で、値を0〜1000に正規化してください。\n"
    "- 確信度・関連度(score/confidence)は0.0〜1.0の範囲で返してください。\n"
    "- 該当データが見つからない場合は対応する配列を空で返してください。\n"
    "- 日本語での記述が求められるフィールドは自然な日本語で記述してください。"
)

# ─── Thinking戦略テーブル ────────────────────────────
# (世代プレフィックス, タイプキーワード) → thinkingConfig辞書
# 空辞書はペイロードからthinkingConfigキーごと除外される（＝APIデフォルトに委任）
_THINKING_STRATEGY_TABLE = {
    ("gemini-2", "flash"): {"thinkingBudget": 0},       # 思考無効化
    ("gemini-2", "pro"):   {},                           # 無効化不可 → 設定を送らない
    ("gemini-3", "flash"): {"thinkingLevel": "MINIMAL"}, # 最小思考
    ("gemini-3", "pro"):   {"thinkingLevel": "MINIMAL"}, # 最小思考（公式でMINIMAL対応確認済み）
}

_warned_unknown_model = set()  # 未知モデル警告の重複抑制


def _resolve_thinking_config():
    """モデルに応じた thinkingConfig を返す。

    _THINKING_STRATEGY_TABLE を参照し、世代×タイプで戦略を決定する。
    未知モデルは空辞書を返し、ペイロードからthinkingConfigを除外する（安全側）。

    Returns:
        dict: thinkingConfig辞書。空辞書の場合はペイロードからキーごと除外される。
    """
    model = GEMINI_MODEL.lower()

    for (gen_prefix, type_keyword), config in _THINKING_STRATEGY_TABLE.items():
        if model.startswith(gen_prefix) and type_keyword in model:
            return config

    # 未知モデル: 安全側に倒す（初回のみ警告ログ）
    if GEMINI_MODEL not in _warned_unknown_model:
        _warned_unknown_model.add(GEMINI_MODEL)
        logger.warning("未知モデル '%s' のthinking設定をスキップします", GEMINI_MODEL)
    return {}


# ─── レスポンスビルダー（辞書構築の一元化） ───────────────
def _make_success(data, image_size=None, **extra):
    """成功レスポンス辞書を生成する。"""
    return {"ok": True, "data": data, "image_size": image_size,
            "error_code": None, "message": None, **extra}


def _make_error(error_code, message):
    """失敗レスポンス辞書を生成する。"""
    return {"ok": False, "data": [], "image_size": None,
            "error_code": error_code, "message": message}


_MAX_RETRY_AFTER_SECONDS = 300  # Retry-After上限（ワーカースリープ防止）


def _get_retry_after_seconds(response, fallback_seconds):
    """Retry-After ヘッダーを秒に正規化して返す（不正値はフォールバック、上限300秒）。"""
    try:
        raw_value = response.headers.get("Retry-After", "")
        if not raw_value:
            return min(fallback_seconds, _MAX_RETRY_AFTER_SECONDS)
        seconds = float(raw_value)
        if seconds < 0:
            return min(fallback_seconds, _MAX_RETRY_AFTER_SECONDS)
        return min(seconds, _MAX_RETRY_AFTER_SECONDS)
    except Exception:
        return min(fallback_seconds, _MAX_RETRY_AFTER_SECONDS)


# SSL検証無効時のみ警告を抑制
if not VERIFY_SSL:
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    logger.warning("⚠ SSL検証が無効化されています。本番環境では VERIFY_SSL=true を推奨します。")

if NO_PROXY_MODE:
    logger.info("ℹ️ NO_PROXY_MODE: プロキシ設定を無視します。")

# ─── HTTPセッション（モジュールレベルで1回だけ作成） ──────
session = requests.Session()
# connectリトライ + HTTPエラーコードの再試行
retry_strategy = Retry(
    total=3,
    connect=3,
    backoff_factor=0.5,
    status_forcelist=[500, 502, 503, 504],  # 429はリトライせず即座に返す
    allowed_methods=["POST"],
)
adapter = HTTPAdapter(max_retries=retry_strategy)
session.mount("http://", adapter)
session.mount("https://", adapter)

# 初期プロキシ設定適用
session.proxies = _get_active_proxy_config()
if session.proxies:
    logger.info("プロキシ設定: %s", _mask_proxy_url(_RAW_PROXY_URL))


# ─── プロキシ設定API ─────────────────────────────
_proxy_lock = Lock()


def get_proxy_status():
    """現在のプロキシ設定状態を返す（認証情報はマスク）"""
    return {
        "enabled": not NO_PROXY_MODE and bool(_RAW_PROXY_URL),
        "url": _mask_proxy_url(_RAW_PROXY_URL) if not NO_PROXY_MODE else "",
    }


def set_proxy_enabled(enabled: bool):
    """
    プロキシの有効/無効を切り替える（スレッド安全）。
    変更はロックで保護され、グローバル状態とセッション設定を原子的に更新する。
    Args:
        enabled (bool): Trueならプロキシ有効（PROXY_URLを使用）、Falseなら無効
    """
    global NO_PROXY_MODE
    with _proxy_lock:
        NO_PROXY_MODE = not enabled
        session.proxies = _get_active_proxy_config()

    status = "有効" if enabled else "無効"
    logger.info("プロキシ設定を変更しました: %s", status)
    return get_proxy_status()

# SSL検証設定
session.verify = VERIFY_SSL


# ─── 座標変換ユーティリティ ─────────────────────────
def _clamp(value, min_val, max_val):
    """値を [min_val, max_val] の範囲にクランプする。"""
    return max(min_val, min(max_val, value))


def _sanitize_box_2d(box_2d):
    """box_2d を 0〜BOX_SCALE 範囲にクランプし、反転ボックスを修正する。"""
    if not box_2d or len(box_2d) != 4:
        return None
    try:
        coords = [float(v) for v in box_2d]  # 文字列/None を数値に変換（型安全化）
    except (TypeError, ValueError):
        return None
    y_min, x_min, y_max, x_max = [_clamp(v, 0, BOX_SCALE) for v in coords]
    # 反転ボックスの修正（Geminiが稀にmin/maxを逆に返す場合）
    if y_min > y_max:
        y_min, y_max = y_max, y_min
    if x_min > x_max:
        x_min, x_max = x_max, x_min
    return y_min, x_min, y_max, x_max


def _gemini_box_to_pixel_vertices(box_2d, img_width, img_height):
    """
    Gemini box_2d [y_min, x_min, y_max, x_max] (0〜BOX_SCALE) → ピクセル座標4頂点。

    Args:
        box_2d: [y_min, x_min, y_max, x_max] 0〜BOX_SCALEスケール
        img_width: 画像の幅（ピクセル）
        img_height: 画像の高さ（ピクセル）

    Returns:
        [[x1,y1], [x2,y2], [x3,y3], [x4,y4]] ピクセル座標（左上→右上→右下→左下）
    """
    sanitized = _sanitize_box_2d(box_2d)
    if not sanitized:
        return []
    y_min, x_min, y_max, x_max = sanitized
    px_x_min = int((x_min / BOX_SCALE) * img_width)
    px_y_min = int((y_min / BOX_SCALE) * img_height)
    px_x_max = int((x_max / BOX_SCALE) * img_width)
    px_y_max = int((y_max / BOX_SCALE) * img_height)
    return [
        [px_x_min, px_y_min],
        [px_x_max, px_y_min],
        [px_x_max, px_y_max],
        [px_x_min, px_y_max],
    ]


def _gemini_box_to_normalized_vertices(box_2d):
    """
    Gemini box_2d [y_min, x_min, y_max, x_max] (0〜BOX_SCALE) → 正規化座標(0-1) 4頂点。

    Args:
        box_2d: [y_min, x_min, y_max, x_max] 0〜BOX_SCALEスケール

    Returns:
        [[x1,y1], [x2,y2], [x3,y3], [x4,y4]] 正規化座標（左上→右上→右下→左下）
    """
    sanitized = _sanitize_box_2d(box_2d)
    if not sanitized:
        return []
    y_min, x_min, y_max, x_max = sanitized
    nx_min = x_min / BOX_SCALE
    ny_min = y_min / BOX_SCALE
    nx_max = x_max / BOX_SCALE
    ny_max = y_max / BOX_SCALE
    return [
        [nx_min, ny_min],
        [nx_max, ny_min],
        [nx_max, ny_max],
        [nx_min, ny_max],
    ]


def _resolve_pixel_bounds(box_2d, image_size):
    """box_2dとimage_sizeが有効な場合のみピクセル座標に変換する。

    Args:
        box_2d: [ymin, xmin, ymax, xmax] 0〜BOX_SCALE、または空リスト
        image_size: [width, height] または None

    Returns:
        [[x,y], ...] ピクセル座標4頂点、変換不可の場合は空リスト
    """
    if image_size and box_2d:
        return _gemini_box_to_pixel_vertices(box_2d, image_size[0], image_size[1])
    return []


def _build_translated_label(en_name, ja_name, score, translations):
    """英語名に日本語訳を付加したラベル文字列を構築する。

    ja_nameが空の場合はtranslations辞書でフォールバックする。
    翻訳が見つからない場合は英語名のみで表示する。

    Args:
        en_name: 英語名
        ja_name: Geminiが返した日本語名（空の場合あり）
        score: 確信度 (0.0〜1.0)
        translations: フォールバック用翻訳辞書

    Returns:
        str: "EnName（日本語名）- 95%" 形式のラベル文字列
    """
    if not ja_name:
        ja_name = translations.get(en_name.lower(), "")
    # score が文字列等の非数値型で渡される場合に備えた型安全変換
    try:
        score_val = float(score)
    except (TypeError, ValueError):
        score_val = 0.0
    if ja_name:
        return f"{en_name}（{ja_name}）- {score_val:.0%}"
    return f"{en_name} - {score_val:.0%}"


# ─── 画像共通処理 ─────────────────────────────────
def _open_image(image_b64):
    """
    Base64画像をデコードしてPIL Imageとして返す（サイズチェック付き）。
    呼び出し元で with 文を使い、使用後に確実にクローズすること。

    Args:
        image_b64: Base64エンコードされた画像文字列。

    Returns:
        PIL.Image.Image インスタンス。

    Raises:
        ValueError: 画像サイズが MAX_IMAGE_PIXELS を超える場合。
    """
    image_bytes = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(image_bytes))
    if img.width * img.height > MAX_IMAGE_PIXELS:
        w, h = img.width, img.height  # close前に値を保存（close後の参照は非推奨）
        img.close()
        raise ValueError(f"画像サイズが大きすぎます: {w}x{h}")
    return img


def _get_image_dimensions(image_b64):
    """
    Base64画像のピクセル寸法を取得する（デコードのみ、画像加工なし）。
    顔検出・ロゴ検出モードでバウンディングボックスの座標変換に使用。

    Args:
        image_b64: Base64エンコードされた画像文字列。

    Returns:
        [width, height] または None（取得失敗時）
    """
    try:
        with _open_image(image_b64) as img:
            return [img.width, img.height]
    except Exception:
        return None


def _ensure_jpeg(image_b64, enhance=False):
    """
    画像をJPEG形式に統一変換する。
    PNG等の非JPEG画像をJPEGに変換し、Gemini APIのmimeType: image/jpeg と整合させる。
    enhance=True の場合、コントラスト・シャープネスも強調する（OCR精度向上用）。

    Args:
        image_b64: Base64エンコードされた画像文字列。
        enhance: Trueならコントラスト・シャープネスを強調する（text/labelモード用）。

    Returns:
        JPEG形式のBase64エンコード画像文字列。

    Raises:
        ValueError: 画像サイズが MAX_IMAGE_PIXELS を超える場合。
    """
    with _open_image(image_b64) as img:
        # RGBA/CMYK等のモードをRGBに変換（JPEG保存に必要）
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")

        # OCRモード用: コントラスト・シャープネスを強調
        if enhance:
            img = ImageEnhance.Contrast(img).enhance(CONTRAST_FACTOR)
            img = ImageEnhance.Sharpness(img).enhance(SHARPNESS_FACTOR)

        # JPEG形式で高画質保存
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=JPEG_QUALITY)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


# ─── Gemini APIペイロード構築 ────────────────────────
def _build_gemini_payload(image_b64, mode, context_hint=""):
    """
    Gemini APIリクエスト用のペイロードを構築する。

    Args:
        image_b64: Base64エンコードされた画像文字列
        mode: 検出モード
        context_hint: ユーザーが入力した追加コンテキスト（任意）

    Returns:
        dict: Gemini API用のリクエストペイロード
    """
    # ヒントが提供されていればプロンプトの末尾に追加コンテキストとして連結
    prompt = MODE_PROMPTS[mode]
    if context_hint:
        prompt += f"\n\n追加コンテキスト: {context_hint}"

    payload = {
        "system_instruction": {
            "parts": [{"text": _SYSTEM_INSTRUCTION}],
        },
        "contents": [
            {
                "parts": [
                    {
                        "inlineData": {
                            "mimeType": "image/jpeg",
                            "data": image_b64,
                        }
                    },
                    {
                        "text": prompt,
                    },
                ]
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": MODE_SCHEMAS[mode],
            "temperature": GENERATION_TEMPERATURE,
        },
    }

    # モデル別thinking設定（空辞書の場合はキーごと除外して安全側に倒す）
    thinking_config = _resolve_thinking_config()
    if thinking_config:
        payload["generationConfig"]["thinkingConfig"] = thinking_config

    return payload


# ─── API呼び出し ──────────────────────────────────
def _send_gemini_request(api_url, payload, request_id, mode):
    """Gemini APIにリクエストを送信し、429リトライを処理する。

    Args:
        api_url: Gemini APIエンドポイントURL
        payload: リクエストペイロード辞書
        request_id: ログ追跡用リクエストID
        mode: 検出モード（ログ用）

    Returns:
        tuple: (response_json_dict, None) 成功時
               (None, error_response_dict) 失敗時
    """
    api_headers = {
        "x-goog-api-key": API_KEY,
        "Content-Type": "application/json",
    }
    response = None
    for attempt in range(GEMINI_429_MAX_RETRIES + 1):
        response = session.post(
            api_url, json=payload, headers=api_headers, timeout=API_TIMEOUT_SECONDS
        )
        if response.status_code != 429:
            break

        if attempt >= GEMINI_429_MAX_RETRIES:
            logger.warning(
                "[%s] レート制限 (mode=%s, attempts=%d): %.300s",
                request_id, mode, attempt + 1, response.text,
            )
            return None, _make_error(
                "GEMINI_RATE_LIMITED",
                "Gemini APIレート制限中です。しばらく待ってから再試行してください。",
            )

        base_wait = GEMINI_429_BACKOFF_BASE_SECONDS * (2 ** attempt)
        fallback_wait = base_wait + random.uniform(0, base_wait)
        sleep_seconds = _get_retry_after_seconds(response, fallback_wait)
        logger.info(
            "[%s] Gemini 429を受信したためリトライします (mode=%s, attempt=%d/%d, wait=%.2fs)",
            request_id, mode, attempt + 1, GEMINI_429_MAX_RETRIES + 1, sleep_seconds,
        )
        time.sleep(sleep_seconds)

    if response.status_code != 200:
        logger.error(
            "[%s] APIエラー (mode=%s, ステータス %d): %.500s",
            request_id, mode, response.status_code, response.text,
        )
        return None, _make_error(
            f"API_{response.status_code}",
            f"Gemini APIエラー (ステータス {response.status_code})",
        )

    try:
        result = response.json()
    except (ValueError, TypeError) as parse_err:
        content_type = response.headers.get("Content-Type", "不明")
        logger.error(
            "[%s] APIレスポンスのJSONパースに失敗 (mode=%s, content-type=%s): %s (先頭200文字: %.200s)",
            request_id, mode, content_type, parse_err, response.text,
        )
        error_code = ERR_API_RESPONSE_NOT_JSON if "json" not in content_type.lower() else ERR_PARSE_ERROR
        return None, _make_error(error_code, f"APIレスポンスの解析に失敗しました (Content-Type: {content_type})")

    return result, None


def _extract_gemini_content(api_result, request_id, mode):
    """Gemini APIレスポンスからコンテンツJSONを抽出する。

    candidates/finishReason/parts結合/JSONパースを処理する。

    Args:
        api_result: Gemini APIが返したレスポンス辞書
        request_id: ログ追跡用リクエストID
        mode: 検出モード（ログ用）

    Returns:
        tuple: (gemini_data_dict, None) 成功時
               (None, response_dict) 空データまたはエラー時
    """
    candidates = api_result.get("candidates", [])
    if not candidates:
        prompt_feedback = api_result.get("promptFeedback", {})
        block_reason = prompt_feedback.get("blockReason", "")
        if block_reason:
            logger.warning("[%s] Gemini: プロンプトがブロックされました (reason=%s)", request_id, block_reason)
            return None, _make_error(ERR_SAFETY_BLOCKED, f"画像が安全フィルターによりブロックされました ({block_reason})")
        return None, _make_success([])

    candidate = candidates[0]

    finish_reason = candidate.get("finishReason", "STOP")
    if finish_reason == "SAFETY":
        logger.warning("[%s] Gemini: 安全フィルターにより停止 (mode=%s)", request_id, mode)
        return None, _make_error(ERR_SAFETY_BLOCKED, "画像が安全フィルターによりブロックされました")
    if finish_reason in ("MAX_TOKENS", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT"):
        logger.warning("[%s] Gemini: 異常終了 finishReason=%s (mode=%s)", request_id, finish_reason, mode)
        return None, _make_error("INCOMPLETE_RESPONSE", f"応答が不完全です (理由: {finish_reason})")

    parts = candidate.get("content", {}).get("parts", [])
    if not parts:
        return None, _make_success([])

    # 複数partにテキストが分割される場合があるため全partを結合する
    # 除外対象:
    #   - thought=True のpart（思考過程テキスト。JSON本文に混ぜると解析が壊れる）
    #   - text が無いpart（functionCall等の非テキスト応答）
    raw_text = "".join(
        p.get("text", "") for p in parts
        if p.get("text") and not p.get("thought")
    )
    if not raw_text.strip():
        return None, _make_success([])

    try:
        gemini_data = json.loads(raw_text)
    except json.JSONDecodeError as e:
        logger.error("[%s] Gemini レスポンスのJSONパースに失敗 (mode=%s): %s (先頭200文字: %.200s)",
                     request_id, mode, e, raw_text)
        return None, _make_error(ERR_PARSE_ERROR, "Geminiレスポンスの解析に失敗しました")

    logger.info("Gemini API レスポンス keys: %s (mode=%s)", list(gemini_data.keys()), mode)
    return gemini_data, None


def detect_content(image_b64, mode="text", request_id="", context_hint=""):
    """
    Google Gemini APIで画像解析を行う。

    Args:
        image_b64: Base64エンコードされた画像文字列。
        mode: 検出モード。以下のいずれか:
            - 'text': テキスト抽出（OCR）
            - 'object': 物体検出（バウンディングボックス付き）
            - 'label': ラベル有無判定（テキスト＋物体検出の併用）
            - 'face': 顔検出・感情分析
            - 'logo': ロゴ（ブランド）検出
            - 'classify': 画像分類タグ
            - 'web': AI画像識別
        request_id: リクエスト相関ID（ログ追跡用、省略可）。
        context_hint: ユーザーが入力した追加コンテキスト（任意、省略可）。

    Returns:
        dict: {
            "ok": bool,
            "data": list[dict],
            "image_size": [w, h] | None,
            "error_code": str|None,
            "message": str|None,
            # モード固有フィールド:
            "label_detected": bool,  # labelモードのみ
            "label_reason": str,     # labelモードのみ
            "web_detail": dict,      # webモードのみ
        }

    Raises:
        ValueError: modeが不正な場合、またはAPIキー未設定の場合。
    """
    if not API_KEY:
        raise ValueError("APIキーが未設定です。.envファイルにGEMINI_API_KEYを設定してください。")

    if mode not in VALID_MODES:
        raise ValueError(f"不正なモード: '{mode}'。許可値: {VALID_MODES}")

    # 全モード共通: JPEG変換（MIME整合保証）。text/labelのみ画質強調も実施
    try:
        image_b64 = _ensure_jpeg(image_b64, enhance=_MODE_HANDLERS[mode]["enhance"])
    except ValueError:
        # 安全チェック違反（画像サイズ超過等）はスキップ不可 → 呼び出し元へ伝播
        raise
    except Exception as e:
        # フェイルクローズ: 前処理失敗時はAPI送信せずエラーを返す（安全チェックすり抜け防止）
        logger.error("画像前処理に失敗 (%s): %s", type(e).__name__, e)
        return _make_error(ERR_PARSE_ERROR, "画像の前処理に失敗しました")

    # Gemini APIリクエストペイロード構築
    payload = _build_gemini_payload(image_b64, mode, context_hint=context_hint)

    # Gemini APIエンドポイント
    api_url = f"{API_BASE_URL}{GEMINI_MODEL}:generateContent"

    try:
        # HTTP通信 + 429リトライ
        api_result, api_error = _send_gemini_request(api_url, payload, request_id, mode)
        if api_error:
            return api_error

        # Geminiレスポンスの解析（candidates/parts/JSONパース）
        gemini_data, parse_result = _extract_gemini_content(api_result, request_id, mode)
        if parse_result:
            return parse_result

        # モード別パーサーでレスポンスを変換
        return _dispatch_mode_handler(mode, gemini_data, image_b64)

    except requests.exceptions.Timeout:
        logger.error("[%s] Gemini API タイムアウト (mode=%s)", request_id, mode)
        return _make_error(ERR_TIMEOUT, "APIリクエストがタイムアウトしました")
    except requests.exceptions.ConnectionError as e:
        logger.error("[%s] Gemini API 接続エラー (mode=%s): %s", request_id, mode, e)
        return _make_error(ERR_CONNECTION_ERROR, "API接続に失敗しました")
    except requests.exceptions.RequestException as e:
        logger.error("[%s] Gemini API通信エラー (mode=%s): %s", request_id, mode, e)
        return _make_error(ERR_REQUEST_ERROR, str(e))
    except Exception as e:
        # パーサー内のTypeError/KeyError等をキャッチし、500直行を防止
        logger.error("[%s] 予期しないエラー (mode=%s): %s", request_id, mode, e, exc_info=True)
        return _make_error(ERR_PARSE_ERROR, "レスポンスの処理中にエラーが発生しました")


# ─── レスポンス解析（内部関数） ──────────────────────
def _parse_gemini_text_response(gemini_data, image_size):
    """
    Geminiテキスト検出レスポンスを解析する。
    各テキストブロックのラベルとバウンディングボックス座標を返す。

    Args:
        gemini_data: Geminiが返したJSON（{"texts": [...]})
        image_size: [width, height] または None

    Returns:
        list: [{"label": str, "bounds": [[x,y], ...]}, ...]
    """
    texts = gemini_data.get("texts", [])
    if not texts:
        return []

    results = []
    for item in texts:
        text = item.get("text", "").strip()
        if not text:
            continue
        bounds = _resolve_pixel_bounds(item.get("box_2d", []), image_size)
        results.append({"label": text, "bounds": bounds})

    return results


def _parse_gemini_label_response(gemini_data, image_size):
    """
    Geminiラベル検出レスポンスを解析する。
    テキストの有無とラベル判定結果を返す。

    Args:
        gemini_data: Geminiが返したJSON
        image_size: [width, height] または None

    Returns:
        tuple: (data_list, label_detected, label_reason)
    """
    label_detected = gemini_data.get("label_detected", False)
    reason = gemini_data.get("reason", "")

    texts = gemini_data.get("texts", [])
    results = []
    for item in texts:
        text = item.get("text", "").strip()
        if not text:
            continue
        bounds = _resolve_pixel_bounds(item.get("box_2d", []), image_size)
        results.append({"label": text, "bounds": bounds})

    if not reason:
        if label_detected:
            reason = "ラベルまたはテキストが検出されました"
        else:
            reason = "テキスト・ラベル関連の物体が検出されませんでした"

    return {"data": results, "label_detected": label_detected, "label_reason": reason}


def _parse_gemini_object_response(gemini_data):
    """
    Gemini物体検出レスポンスを解析する。
    各物体のラベルと正規化バウンディングボックス座標（0〜1）を返す。

    Args:
        gemini_data: Geminiが返したJSON（{"objects": [...]})

    Returns:
        list: [{"label": str, "bounds": [[x,y], ...]}, ...]
    """
    objects = gemini_data.get("objects", [])
    results = []
    for obj in objects:
        en_name = obj.get("name", "")
        score = obj.get("score", 0)
        ja_name = obj.get("name_ja", "")
        label = _build_translated_label(en_name, ja_name, score, OBJECT_TRANSLATIONS)

        # box_2d → 正規化座標（0-1）に変換
        box_2d = obj.get("box_2d", [])
        bounds = _gemini_box_to_normalized_vertices(box_2d)

        results.append({"label": label, "bounds": bounds})

    return results


def _parse_gemini_face_response(gemini_data, image_size):
    """
    Gemini顔検出レスポンスを解析する。
    各顔のバウンディングボックスと感情分析結果を返す。

    Args:
        gemini_data: Geminiが返したJSON（{"faces": [...]})
        image_size: [width, height] または None

    Returns:
        list: [{
            "label": str,
            "bounds": [[x,y], ...],  # ピクセル座標
            "emotions": dict,        # {"joy": "LIKELY", ...}
            "confidence": float,
        }, ...]
    """
    faces = gemini_data.get("faces", [])
    results = []
    for idx, face in enumerate(faces, 1):
        try:
            confidence = float(face.get("confidence", 0))
        except (TypeError, ValueError):
            confidence = 0.0

        # 感情データを構造化
        emotions = {
            "joy": face.get("joy", "UNKNOWN"),
            "sorrow": face.get("sorrow", "UNKNOWN"),
            "anger": face.get("anger", "UNKNOWN"),
            "surprise": face.get("surprise", "UNKNOWN"),
        }

        # POSSIBLE以上の感情のみラベルに含める
        significant_emotions = []
        for emo_key, emo_value in emotions.items():
            if emo_value in SIGNIFICANT_EMOTION_LEVELS:
                ja_name = EMOTION_NAMES.get(emo_key, emo_key)
                ja_level = EMOTION_LIKELIHOOD.get(emo_value, emo_value)
                significant_emotions.append(f"{ja_name}({ja_level})")

        emotion_text = ", ".join(significant_emotions) if significant_emotions else "表情なし"
        label = f"顔{idx}: {emotion_text} - {confidence:.0%}"

        # box_2d → ピクセル座標に変換
        bounds = _resolve_pixel_bounds(face.get("box_2d", []), image_size)

        results.append({
            "label": label,
            "bounds": bounds,
            "emotions": emotions,
            "confidence": confidence,
        })

    return results


def _parse_gemini_logo_response(gemini_data, image_size):
    """
    Geminiロゴ検出レスポンスを解析する。
    各ロゴのブランド名、スコア、バウンディングボックスを返す。

    Args:
        gemini_data: Geminiが返したJSON（{"logos": [...]})
        image_size: [width, height] または None

    Returns:
        list: [{"label": str, "bounds": [[x,y], ...]}, ...]
    """
    logos = gemini_data.get("logos", [])
    results = []
    for logo in logos:
        name = logo.get("name", "不明")
        try:
            score = float(logo.get("score", 0))
        except (TypeError, ValueError):
            score = 0.0
        label = f"{name} - {score:.0%}"

        # box_2d → ピクセル座標に変換
        bounds = _resolve_pixel_bounds(logo.get("box_2d", []), image_size)

        results.append({"label": label, "bounds": bounds})

    return results


def _parse_gemini_classify_response(gemini_data):
    """
    Gemini分類タグレスポンスを解析する。
    画像全体に対する分類ラベルとスコアを返す（座標なし）。

    Args:
        gemini_data: Geminiが返したJSON（{"labels": [...]})

    Returns:
        list: [{"label": str, "score": float}, ...]
    """
    labels = gemini_data.get("labels", [])
    results = []
    for item in labels:
        en_name = item.get("name", "")
        score = item.get("score", 0)
        ja_name = item.get("name_ja", "")
        label = _build_translated_label(en_name, ja_name, score, LABEL_TRANSLATIONS)

        results.append({"label": label, "score": score})

    return results


def _parse_gemini_web_response(gemini_data):
    """
    Gemini AI識別レスポンスを解析する。
    エンティティ情報と識別結果を返す。

    注意: Gemini APIではWeb検索は行えないため、
    pages と similar_images は常に空配列を返す。

    Args:
        gemini_data: Geminiが返したJSON

    Returns:
        tuple: (data_list, web_detail)
            data_list: 統一データ形式（推定ラベル等）
            web_detail: 構造化された識別結果（フロントエンド互換）
    """
    best_guess = gemini_data.get("best_guess", "")
    entities = gemini_data.get("entities", [])
    description = gemini_data.get("description", "")

    # 統一data形式（ラベルのみ、boundsなし）
    data = []
    if best_guess:
        data.append({"label": f"推定: {best_guess}"})
    for entity in entities:
        name = entity.get("name", "")
        try:
            score = float(entity.get("score", 0))
        except (TypeError, ValueError):
            score = 0.0
        if name:
            data.append({"label": f"{name} ({score:.0%})"})
    if description:
        data.append({"label": f"説明: {description}"})

    # フロントエンド互換のweb_detail構造
    web_detail = {
        "best_guess": best_guess,
        "entities": entities,
        "pages": [],           # Geminiではweb検索不可のため常に空
        "similar_images": [],  # Geminiではweb検索不可のため常に空
    }

    return {"data": data, "web_detail": web_detail}


# ─── モード別ディスパッチ ──────────────────────────
# 各モードのパーサー・image_size要否・ログラベルを一元管理
_MODE_HANDLERS = {
    "text":     {"parser": _parse_gemini_text_response,     "needs_image_size": True,  "enhance": True,  "log": "テキスト検出"},
    "object":   {"parser": _parse_gemini_object_response,   "needs_image_size": False, "enhance": False, "log": "物体検出"},
    "label":    {"parser": _parse_gemini_label_response,    "needs_image_size": True,  "enhance": True,  "log": "ラベル検出"},
    "face":     {"parser": _parse_gemini_face_response,     "needs_image_size": True,  "enhance": False, "log": "顔検出"},
    "logo":     {"parser": _parse_gemini_logo_response,     "needs_image_size": True,  "enhance": False, "log": "ロゴ検出"},
    "classify": {"parser": _parse_gemini_classify_response, "needs_image_size": False, "enhance": False, "log": "分類タグ"},
    "web":      {"parser": _parse_gemini_web_response,      "needs_image_size": False, "enhance": False, "log": "AI識別"},
}

# 許可モードは _MODE_HANDLERS のキーから自動導出（手動同期を排除）
VALID_MODES = frozenset(_MODE_HANDLERS.keys())


def _dispatch_mode_handler(mode, gemini_data, image_b64):
    """
    モードに応じたパーサーを呼び出し、統一された成功レスポンスを返す。

    パーサーは list（通常モード）または dict（追加フィールドありモード）を返す。
    dict の場合は "data" キーを取り出し、残りのキーは _make_success に展開される。

    Args:
        mode: 検出モード文字列。
        gemini_data: Geminiが返したJSON。
        image_b64: Base64エンコード済み画像（image_size取得用）。

    Returns:
        dict: _make_success() 形式のレスポンス辞書。
    """
    handler = _MODE_HANDLERS[mode]
    parser_func = handler["parser"]
    image_size = _get_image_dimensions(image_b64) if handler["needs_image_size"] else None

    # パーサー呼び出し（image_size が必要なモードのみ引数に追加）
    args = (gemini_data, image_size) if handler["needs_image_size"] else (gemini_data,)
    result = parser_func(*args)

    # パーサーの戻り値: dict → "data" + 追加フィールド, list → データのみ
    if isinstance(result, dict):
        data = result.pop("data")
        extra = result
    else:
        data = result
        extra = {}

    logger.info("%s結果: %d件", handler["log"], len(data))
    return _make_success(data, image_size, **extra)
