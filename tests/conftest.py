"""
テスト共通フィクスチャとヘルパー関数。
test_api.py / test_gemini_api.py の重複コードを一元管理する。
"""

import base64

import pytest
from unittest.mock import MagicMock

from app import app
from rate_limiter import reset_for_testing


# ─── 共有フィクスチャ ──────────────────────────────
@pytest.fixture
def client():
    """Flaskテストクライアントを作成する。テスト間でレート制限ステートをリセット。"""
    reset_for_testing()

    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


# ─── テスト用画像ヘルパー ──────────────────────────
def create_valid_image_base64():
    """テスト用の最小限の有効なJPEG画像をBase64で返す。"""
    # 最小限の有効なJPEGバイナリ（1x1ピクセル）
    jpeg_bytes = (
        b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01'
        b'\x00\x01\x00\x00\xff\xdb\x00C\x00\x08\x06\x06\x07\x06'
        b'\x05\x08\x07\x07\x07\t\t\x08\n\x0c\x14\r\x0c\x0b\x0b'
        b'\x0c\x19\x12\x13\x0f\x14\x1d\x1a\x1f\x1e\x1d\x1a\x1c'
        b'\x1c $.\' ",#\x1c\x1c(7),01444\x1f\'9=82<.342\xff\xc0'
        b'\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00\xff\xc4'
        b'\x00\x1f\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00'
        b'\x00\x00\x00\x00\x00\x00\x00\x01\x02\x03\x04\x05\x06'
        b'\x07\x08\t\n\x0b\xff\xc4\x00\xb5\x10\x00\x02\x01\x03'
        b'\x03\x02\x04\x03\x05\x05\x04\x04\x00\x00\x01}\x01\x02'
        b'\x03\x00\x04\x11\x05\x12!1A\x06\x13Qa\x07"q\x142\x81'
        b'\x91\xa1\x08#B\xb1\xc1\x15R\xd1\xf0$3br\x82\t\n\x16'
        b'\x17\x18\x19\x1a%&\'()*456789:CDEFGHIJSTUVWXYZcdefghij'
        b'stuvwxyz\x83\x84\x85\x86\x87\x88\x89\x8a\x92\x93\x94'
        b'\x95\x96\x97\x98\x99\x9a\xa2\xa3\xa4\xa5\xa6\xa7\xa8'
        b'\xa9\xaa\xb2\xb3\xb4\xb5\xb6\xb7\xb8\xb9\xba\xc2\xc3'
        b'\xc4\xc5\xc6\xc7\xc8\xc9\xca\xd2\xd3\xd4\xd5\xd6\xd7'
        b'\xd8\xd9\xda\xe1\xe2\xe3\xe4\xe5\xe6\xe7\xe8\xe9\xea'
        b'\xf1\xf2\xf3\xf4\xf5\xf6\xf7\xf8\xf9\xfa\xff\xda\x00'
        b'\x08\x01\x01\x00\x00?\x00T\xdb\xae\xa7\x1e\xf1R)l\xa8'
        b'\xab\xa1\xca\xff\xd9'
    )
    return base64.b64encode(jpeg_bytes).decode("utf-8")


def create_valid_png_base64():
    """テスト用の有効なPNG画像をBase64で返す（PILで開けることを保証）。"""
    from PIL import Image
    import io
    img = Image.new("RGB", (2, 2), color=(255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def make_b64(data=b"\xff\xd8\xff\xd9"):
    """最小限のBase64文字列を生成する。"""
    return base64.b64encode(data).decode()


def make_mock_response(status_code=200, json_data=None, content_type="application/json"):
    """requests.Responseのモックを作成する。"""
    mock = MagicMock()
    mock.status_code = status_code
    mock.json.return_value = json_data or {}
    mock.text = str(json_data)
    mock.headers = {"Content-Type": content_type}
    return mock
