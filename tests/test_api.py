"""
Gemini Vision Scanner - APIエンドポイントのテスト。
正常系（OCR/物体検出）、不正入力、API失敗時、セキュリティ、エラーハンドラの6系統をカバー。
"""

import base64
from unittest.mock import patch

import pytest
from conftest import create_valid_image_base64, create_valid_png_base64


# ─── 正常系テスト ──────────────────────────────────
class TestTextDetection:
    """テキスト抽出（OCR）の正常系テスト。"""

    @patch("app.detect_content")
    def test_テキスト抽出が正常に動作する(self, mock_detect, client):
        """有効な画像とmode=textで正常レスポンスを返すこと。"""
        mock_detect.return_value = {
            "ok": True,
            "data": [
                {"label": "Hello World", "bounds": [[10, 20], [100, 20], [100, 40], [10, 40]]},
                {"label": "12345", "bounds": [[15, 50], [60, 50], [60, 70], [15, 70]]},
            ],
            "image_size": [768, 432],
            "error_code": None,
            "message": None,
        }

        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "text",
        })

        assert response.status_code == 200
        data = response.get_json()
        assert data["ok"] is True
        assert len(data["data"]) == 2
        assert data["data"][0]["label"] == "Hello World"


class TestObjectDetection:
    """物体検出の正常系テスト。"""

    @patch("app.detect_content")
    def test_物体検出が正常に動作する(self, mock_detect, client):
        """有効な画像とmode=objectで正常レスポンスを返すこと。"""
        mock_detect.return_value = {
            "ok": True,
            "data": [
                {"label": "Person（人）- 95%", "bounds": [[0.1, 0.1], [0.5, 0.1], [0.5, 0.8], [0.1, 0.8]]},
                {"label": "Laptop（ノートPC）- 88%", "bounds": [[0.4, 0.3], [0.9, 0.3], [0.9, 0.7], [0.4, 0.7]]},
            ],
            "image_size": None,
            "error_code": None,
            "message": None,
        }

        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "object",
        })

        assert response.status_code == 200
        data = response.get_json()
        assert data["ok"] is True
        assert len(data["data"]) == 2
        assert data["data"][0]["label"] == "Person（人）- 95%"


# ─── 新モードのスモークテスト ────────────────────────
class TestNewModes:
    """face/logo/classify/web/label の各モードがAPIエンドポイントで受け入れられること。"""

    @pytest.mark.parametrize("mode,mock_return", [
        ("face", {
            "ok": True,
            "data": [{"label": "顔1: 喜び=高い", "bounds": [[0.1, 0.1], [0.4, 0.1], [0.4, 0.5], [0.1, 0.5]]}],
            "image_size": [640, 480],
            "error_code": None,
            "message": None,
        }),
        ("logo", {
            "ok": True,
            "data": [{"label": "Google - 92%", "bounds": [[0.2, 0.3], [0.6, 0.3], [0.6, 0.5], [0.2, 0.5]]}],
            "image_size": [640, 480],
            "error_code": None,
            "message": None,
        }),
        ("classify", {
            "ok": True,
            "data": [{"label": "電子機器 - 95%"}, {"label": "ガジェット - 88%"}],
            "image_size": None,
            "error_code": None,
            "message": None,
        }),
    ])
    @patch("app.detect_content")
    def test_各モードを受け入れる(self, mock_detect, client, mode, mock_return):
        """face/logo/classifyモードで正常レスポンスを返すこと。"""
        mock_detect.return_value = mock_return
        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": mode,
        })
        assert response.status_code == 200
        assert response.get_json()["ok"] is True

    @patch("app.detect_content")
    def test_Web検索モードを受け入れる(self, mock_detect, client):
        """mode=webで正常レスポンスを返すこと（web_detailフィールドも含む）。"""
        mock_detect.return_value = {
            "ok": True,
            "data": [{"label": "ノートPC"}],
            "image_size": None,
            "error_code": None,
            "message": None,
            "web_detail": {
                "best_guess": "MacBook Pro",
                "entities": [{"name": "Laptop", "score": 0.9}],
                "pages": [],
                "similar_images": [],
            },
        }
        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "web",
        })
        assert response.status_code == 200
        data = response.get_json()
        assert data["ok"] is True
        # web_detail の必須キー4つが存在すること（レスポンス契約）
        assert "web_detail" in data
        wd = data["web_detail"]
        for key in ("best_guess", "entities", "pages", "similar_images"):
            assert key in wd, f"web_detail に必須キー '{key}' がありません"
        assert wd["best_guess"] == "MacBook Pro"

    @patch("app.detect_content")
    def test_ラベル検出モードを受け入れる(self, mock_detect, client):
        """mode=labelで正常レスポンスを返すこと（label_detected/label_reasonが必須）。"""
        mock_detect.return_value = {
            "ok": True,
            "data": [{"label": "ラベルあり"}],
            "image_size": None,
            "error_code": None,
            "message": None,
            "label_detected": True,
            "label_reason": "テキスト検出済み",
        }
        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "label",
        })
        assert response.status_code == 200
        data = response.get_json()
        assert data["ok"] is True
        # label_detected と label_reason の両方が必須（レスポンス契約）
        assert "label_detected" in data, "label_detected フィールドがありません"
        assert "label_reason" in data, "label_reason フィールドがありません"
        assert data["label_detected"] is True
        assert isinstance(data["label_reason"], str)
        assert len(data["label_reason"]) > 0


# ─── 不正入力テスト ──────────────────────────────
class TestInvalidInput:
    """不正な入力に対するバリデーションテスト。"""

    def test_JSONでないリクエストを拒否する(self, client):
        """Content-Typeがapplication/jsonでない場合は400を返すこと。"""
        response = client.post(
            "/api/analyze",
            data="not json",
            content_type="text/plain",
        )
        assert response.status_code == 400
        data = response.get_json()
        assert data["error_code"] == "INVALID_FORMAT"

    def test_画像データがないリクエストを拒否する(self, client):
        """imageフィールドがない場合は400を返すこと。"""
        response = client.post("/api/analyze", json={"mode": "text"})
        assert response.status_code == 400
        data = response.get_json()
        assert data["error_code"] == "MISSING_IMAGE"

    def test_不正なモードを拒否する(self, client):
        """mode が text/object 以外の場合は400を返すこと。"""
        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "invalid",
        })
        assert response.status_code == 400
        data = response.get_json()
        assert data["error_code"] == "INVALID_MODE"

    def test_不正なBase64を拒否する(self, client):
        """Base64デコードに失敗する文字列は400を返すこと。"""
        response = client.post("/api/analyze", json={
            "image": "!!!not-valid-base64!!!",
            "mode": "text",
        })
        assert response.status_code == 400
        data = response.get_json()
        assert data["error_code"] == "INVALID_BASE64"

    def test_大きすぎる画像を拒否する(self, client):
        """5MBを超える画像は400を返すこと。"""
        # 6MBのダミーデータ（JPEG magic byte + パディング）
        large_image = base64.b64encode(b"\xff\xd8\xff" + b"\x00" * (6 * 1024 * 1024)).decode("utf-8")
        response = client.post("/api/analyze", json={
            "image": large_image,
            "mode": "text",
        })
        assert response.status_code == 400
        data = response.get_json()
        assert data["error_code"] == "IMAGE_TOO_LARGE"

    def test_Nullの画像を拒否する(self, client):
        """imageフィールドがnullの場合は400を返すこと。"""
        response = client.post("/api/analyze", json={
            "image": None,
            "mode": "text",
        })
        assert response.status_code == 400
        assert response.get_json()["error_code"] == "MISSING_IMAGE"

    def test_空文字の画像を拒否する(self, client):
        """imageフィールドが空文字の場合は400を返すこと。"""
        response = client.post("/api/analyze", json={
            "image": "   ",
            "mode": "text",
        })
        assert response.status_code == 400
        assert response.get_json()["error_code"] == "MISSING_IMAGE"

    def test_JSONが配列のリクエストを拒否する(self, client):
        """JSONボディが配列（dict以外）の場合は400を返すこと。"""
        response = client.post(
            "/api/analyze",
            data="[1, 2, 3]",
            content_type="application/json",
        )
        assert response.status_code == 400
        assert response.get_json()["error_code"] == "INVALID_FORMAT"

    def test_壊れたJSONでもJSON形式のエラーを返す(self, client):
        """Content-Typeがapplication/jsonだが本文が不正JSONの場合、JSONエラーを返すこと。"""
        response = client.post(
            "/api/analyze",
            data="{broken json",
            content_type="application/json",
        )
        assert response.status_code == 400
        data = response.get_json()
        assert data["ok"] is False
        assert data["error_code"] == "INVALID_FORMAT"


# ─── 画像フォーマット検証テスト ────────────────────
class TestImageFormatValidation:
    """MIME magic byte によるフォーマット検証テスト。"""

    def test_不正なフォーマットを拒否する(self, client):
        """JPEG/PNG以外のバイナリは INVALID_IMAGE_FORMAT を返すこと。"""
        # GIF magic byte（許可されていない）
        gif_data = base64.b64encode(b"GIF89a" + b"\x00" * 100).decode("utf-8")
        response = client.post("/api/analyze", json={
            "image": gif_data,
            "mode": "text",
        })
        assert response.status_code == 400
        assert response.get_json()["error_code"] == "INVALID_IMAGE_FORMAT"

    @patch("app.detect_content")
    def test_JPEG画像を受け入れる(self, mock_detect, client):
        """JPEG画像は正常に受け入れられること。"""
        mock_detect.return_value = {
            "ok": True, "data": [], "image_size": None,
            "error_code": None, "message": None,
        }
        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "text",
        })
        assert response.status_code == 200

    @patch("app.detect_content")
    def test_PNG画像を受け入れる(self, mock_detect, client):
        """PNG画像は正常に受け入れられること。"""
        mock_detect.return_value = {
            "ok": True, "data": [], "image_size": None,
            "error_code": None, "message": None,
        }
        response = client.post("/api/analyze", json={
            "image": create_valid_png_base64(),
            "mode": "text",
        })
        assert response.status_code == 200

    def test_テキストデータを拒否する(self, client):
        """プレーンテキストのBase64は INVALID_IMAGE_FORMAT を返すこと。"""
        text_data = base64.b64encode(b"Hello, this is not an image").decode("utf-8")
        response = client.post("/api/analyze", json={
            "image": text_data,
            "mode": "text",
        })
        assert response.status_code == 400
        assert response.get_json()["error_code"] == "INVALID_IMAGE_FORMAT"


# ─── API失敗時テスト ──────────────────────────────
class TestApiFailure:
    """Gemini APIの障害時の動作テスト。"""

    @patch("app.detect_content")
    def test_API障害時にエラーレスポンスを返す(self, mock_detect, client):
        """detect_contentがエラーを返した場合、502を返すこと。"""
        mock_detect.return_value = {
            "ok": False,
            "data": [],
            "image_size": None,
            "error_code": "API_500",
            "message": "Gemini APIエラー",
        }

        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "text",
        })

        assert response.status_code == 502
        data = response.get_json()
        assert data["ok"] is False
        assert data["error_code"] == "API_500"

    @patch("app.detect_content")
    def test_サーバー例外時に500を返す(self, mock_detect, client):
        """予期しない例外発生時は500を返すこと。"""
        mock_detect.side_effect = RuntimeError("予期しないエラー")

        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "text",
        })

        assert response.status_code == 500
        data = response.get_json()
        assert data["ok"] is False
        assert data["error_code"] == "SERVER_ERROR"


# ─── セキュリティテスト ──────────────────────────
class TestProxySecurity:
    """プロキシAPI認証・情報漏えい防止のテスト。"""

    def test_プロキシGETにconfigured_urlが含まれない(self, client):
        """GETレスポンスに configured_url が存在しないこと（情報漏えい防止）。"""
        response = client.get("/api/config/proxy")
        assert response.status_code == 200
        data = response.get_json()
        assert "configured_url" not in data

    def test_認証なしのプロキシPOSTは403を返す(self, client):
        """X-Admin-Secretヘッダーなしの場合は403を返すこと。"""
        response = client.post("/api/config/proxy", json={"enabled": True})
        assert response.status_code == 403
        data = response.get_json()
        assert data["error_code"] == "UNAUTHORIZED"

    @patch("app.ADMIN_SECRET", "test-secret-123")
    def test_不正なシークレットでは403を返す(self, client):
        """不正なシークレットの場合は403を返すこと。"""
        response = client.post(
            "/api/config/proxy",
            json={"enabled": True},
            headers={"X-Admin-Secret": "wrong-secret"},
        )
        assert response.status_code == 403

    @patch("app.ADMIN_SECRET", "test-secret-123")
    def test_正しいシークレットでプロキシを更新できる(self, client):
        """正しいシークレットの場合はプロキシ設定を更新できること。"""
        response = client.post(
            "/api/config/proxy",
            json={"enabled": False},
            headers={"X-Admin-Secret": "test-secret-123"},
        )
        assert response.status_code == 200
        data = response.get_json()
        assert data["ok"] is True

    @patch("app.ADMIN_SECRET", "test-secret-123")
    def test_enabled文字列falseは型エラーを返す(self, client):
        """enabled が文字列 "false" の場合は400を返すこと（bool("false")==True バグの防止）。"""
        response = client.post(
            "/api/config/proxy",
            json={"enabled": "false"},
            headers={"X-Admin-Secret": "test-secret-123"},
        )
        assert response.status_code == 400
        data = response.get_json()
        assert data["error_code"] == "INVALID_TYPE"


class TestRateLimitAtomicity:
    """レート制限のアトミック性テスト。"""

    @staticmethod
    def _get_rate_key():
        """テストクライアントが使うレート制限キーを返す（デフォルトipモード）。"""
        return "127.0.0.1"

    @patch("app.detect_content")
    def test_API失敗時にレート制限カウントが戻る(self, mock_detect, client):
        """API失敗時は release_request により予約が取り消されること。"""
        from rate_limiter import get_daily_count

        mock_detect.return_value = {
            "ok": False,
            "data": [],
            "image_size": None,
            "error_code": "API_500",
            "message": "Gemini APIエラー",
        }

        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "text",
        })
        assert response.status_code == 502

        rate_key = self._get_rate_key()
        assert get_daily_count(rate_key) == 0

    @patch("app.detect_content")
    def test_例外発生時もレート制限カウントが戻る(self, mock_detect, client):
        """detect_content例外時もカウントが戻ること。"""
        from rate_limiter import get_daily_count

        mock_detect.side_effect = RuntimeError("テスト例外")

        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "text",
        })
        assert response.status_code == 500

        rate_key = self._get_rate_key()
        assert get_daily_count(rate_key) == 0


# ─── Geminiレート制限・分制限テスト ──────────────────
class TestGeminiRateLimitRelay:
    """Gemini API側のレート制限が正しくクライアントに中継されるかのテスト。"""

    @patch("app.detect_content")
    def test_Geminiレート制限時に429とRetryAfterを返す(self, mock_detect, client):
        """error_code=GEMINI_RATE_LIMITED の場合は429+Retry-After:30を返すこと。"""
        mock_detect.return_value = {
            "ok": False,
            "data": [],
            "image_size": None,
            "error_code": "GEMINI_RATE_LIMITED",
            "message": "Gemini APIレート制限中です。",
        }
        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "text",
        })
        assert response.status_code == 429
        assert response.headers.get("Retry-After") == "30"
        data = response.get_json()
        assert data["error_code"] == "GEMINI_RATE_LIMITED"

    @patch("app.detect_content")
    def test_ValueError発生時に汎用メッセージで400を返す(self, mock_detect, client):
        """detect_contentがValueErrorを投げた場合、内部パスを漏洩しない汎用400を返すこと。"""
        mock_detect.side_effect = ValueError("APIキーが未設定です。.envファイルに設定してください。")
        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "text",
        })
        assert response.status_code == 400
        data = response.get_json()
        assert data["error_code"] == "VALIDATION_ERROR"
        # 内部パス情報が漏洩していないことを検証
        assert ".env" not in data["message"]
        assert "リクエストの処理に失敗しました" in data["message"]


class TestMinuteRateLimit:
    """分制限超過のテスト。"""

    @patch("app.detect_content")
    @patch("app.RATE_LIMIT_PER_MINUTE", 1)
    @patch("rate_limiter.RATE_LIMIT_PER_MINUTE", 1)
    def test_分制限超過時に429を返す(self, mock_detect, client):
        """分制限を超えた場合に429+Retry-After+limit_type=minuteを返すこと。"""
        mock_detect.return_value = {
            "ok": True,
            "data": [],
            "image_size": None,
            "error_code": None,
            "message": None,
        }
        # 1回目: 通過
        resp1 = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "text",
        })
        assert resp1.status_code == 200

        # 2回目: 分制限超過
        resp2 = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "text",
        })
        assert resp2.status_code == 429
        data = resp2.get_json()
        assert data["error_code"] == "APP_RATE_LIMITED"
        assert data["limit_type"] == "minute"
        assert "Retry-After" in resp2.headers
        assert int(resp2.headers["Retry-After"]) > 0


# ─── エラーハンドラテスト ──────────────────────
class TestErrorHandlers:
    """Flask例外ハンドラのJSONレスポンステスト。"""

    def test_413エラーがJSONで返る(self, client):
        """MAX_CONTENT_LENGTH 超過時にJSON応答が返ること。"""
        huge_payload = "x" * (11 * 1024 * 1024)
        response = client.post(
            "/api/analyze",
            data=huge_payload,
            content_type="application/json",
        )
        assert response.status_code == 413
        data = response.get_json()
        assert data["ok"] is False
        assert data["error_code"] == "REQUEST_TOO_LARGE"


class TestErrorResponseFormat:
    """全エラーレスポンスが統一形式（request_id, retry_after）を含むことの検証。"""

    def test_400エラーにrequest_idとretry_afterが含まれる(self, client):
        """バリデーションエラー時に統一フィールドが返ること。"""
        response = client.post("/api/analyze", json={"mode": "text"})
        assert response.status_code == 400
        data = response.get_json()
        assert "request_id" in data
        assert isinstance(data["request_id"], str)
        assert len(data["request_id"]) == 16
        assert data["retry_after"] is None

    @patch("app.detect_content")
    def test_成功レスポンスにrequest_idが含まれる(self, mock_detect, client):
        """成功レスポンスにも request_id と retry_after が含まれること。"""
        mock_detect.return_value = {
            "ok": True, "data": [], "image_size": None,
            "error_code": None, "message": None,
        }
        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "text",
        })
        assert response.status_code == 200
        data = response.get_json()
        assert "request_id" in data
        assert len(data["request_id"]) == 16
        assert data["retry_after"] is None

    @patch("app.detect_content")
    def test_502エラーにrequest_idとretry_afterが含まれる(self, mock_detect, client):
        """Gemini APIエラー時にも統一フィールドが返ること。"""
        mock_detect.return_value = {
            "ok": False, "data": [], "image_size": None,
            "error_code": "API_500", "message": "APIエラー",
        }
        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "text",
        })
        assert response.status_code == 502
        data = response.get_json()
        assert "request_id" in data
        assert data["retry_after"] is None

    @patch("app.detect_content")
    def test_429エラーにretry_afterが数値で含まれる(self, mock_detect, client):
        """Geminiレート制限時に retry_after が数値として返ること。"""
        mock_detect.return_value = {
            "ok": False, "data": [], "image_size": None,
            "error_code": "GEMINI_RATE_LIMITED", "message": "レート制限中",
        }
        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "text",
        })
        assert response.status_code == 429
        data = response.get_json()
        assert "request_id" in data
        assert data["retry_after"] == 30


class TestProxyGetAuth:
    """プロキシGETの認証レベルテスト。"""

    def test_未認証GETではURL情報が含まれない(self, client):
        """認証なしGETでは enabled のみ返し、url は含まれないこと。"""
        response = client.get("/api/config/proxy")
        assert response.status_code == 200
        data = response.get_json()
        assert "enabled" in data
        assert "url" not in data

    @patch("app.ADMIN_SECRET", "test-secret-123")
    def test_認証済みGETではURL情報が含まれる(self, client):
        """認証ありGETでは url フィールドも返すこと。"""
        response = client.get(
            "/api/config/proxy",
            headers={"X-Admin-Secret": "test-secret-123"},
        )
        assert response.status_code == 200
        data = response.get_json()
        assert "enabled" in data
        assert "url" in data


class TestProxyMalformedInput:
    """プロキシPOSTの不正入力テスト。"""

    @patch("app.ADMIN_SECRET", "test-secret-123")
    def test_壊れたJSONでプロキシPOSTは400を返す(self, client):
        """壊れたJSONボディの場合は400を返すこと。"""
        response = client.post(
            "/api/config/proxy",
            data="{broken",
            content_type="application/json",
            headers={"X-Admin-Secret": "test-secret-123"},
        )
        assert response.status_code == 400
        data = response.get_json()
        assert data["error_code"] == "INVALID_FORMAT"

    @patch("app.ADMIN_SECRET", "test-secret-123")
    def test_enabledフィールド未送信は400を返す(self, client):
        """enabledフィールドがないJSONオブジェクトは400を返すこと。"""
        response = client.post(
            "/api/config/proxy",
            json={"some_other_field": True},
            headers={"X-Admin-Secret": "test-secret-123"},
        )
        assert response.status_code == 400
        data = response.get_json()
        assert data["error_code"] == "INVALID_FORMAT"

    @patch("app.ADMIN_SECRET", "test-secret-123")
    def test_enabled整数型は型エラーを返す(self, client):
        """enabledがinteger(1)の場合はINVALID_TYPEを返すこと。"""
        response = client.post(
            "/api/config/proxy",
            json={"enabled": 1},
            headers={"X-Admin-Secret": "test-secret-123"},
        )
        assert response.status_code == 400
        data = response.get_json()
        assert data["error_code"] == "INVALID_TYPE"

    @patch("app.ADMIN_SECRET", "test-secret-123")
    def test_JSON以外のContent_Typeは400を返す(self, client):
        """Content-Typeがapplication/jsonでない場合はINVALID_FORMATを返すこと。"""
        response = client.post(
            "/api/config/proxy",
            data="enabled=true",
            content_type="application/x-www-form-urlencoded",
            headers={"X-Admin-Secret": "test-secret-123"},
        )
        assert response.status_code == 400
        data = response.get_json()
        assert data["error_code"] == "INVALID_FORMAT"


# ─── セキュリティヘッダテスト ───────────────────
class TestSecurityHeaders:
    """セキュリティヘッダのテスト。"""

    def test_CSPヘッダが存在する(self, client):
        """レスポンスに Content-Security-Policy が含まれること。"""
        response = client.get("/")
        assert "Content-Security-Policy" in response.headers
        csp = response.headers["Content-Security-Policy"]
        assert "default-src 'self'" in csp

    def test_CSPにunsafe_inlineが含まれない(self, client):
        """CSPヘッダに 'unsafe-inline' が含まれないこと（nonce化済み）。"""
        response = client.get("/")
        csp = response.headers["Content-Security-Policy"]
        assert "'unsafe-inline'" not in csp

    def test_CSPにノンスが含まれる(self, client):
        """CSPのstyle-srcにnonce値が含まれること。"""
        response = client.get("/")
        csp = response.headers["Content-Security-Policy"]
        assert "nonce-" in csp

    def test_レガシーXSSヘッダが存在しない(self, client):
        """X-XSS-Protection ヘッダが含まれないこと。"""
        response = client.get("/")
        assert "X-XSS-Protection" not in response.headers


# ─── Cache-Control 回帰テスト ──────────────────────────
class TestCacheControl:
    """Cache-Control ポリシーの分離が維持されていることの回帰テスト。"""

    def test_APIレスポンスはno_storeである(self, client):
        """API（HTMLを含む非静的パス）は no-store でキャッシュ無効であること。"""
        response = client.get("/")
        cc = response.headers.get("Cache-Control", "")
        assert "no-store" in cc, f"HTMLレスポンスに no-store が含まれない: {cc}"

    def test_静的ファイルはimmutableでキャッシュされる(self, client):
        """/static/ パスは immutable + 長期キャッシュであること。"""
        # Flask テストクライアントでは /static/ が実在しなくても after_request は通る
        # 実際の静的ファイルでテスト
        response = client.get("/static/style.css")
        # 404でもafter_requestは実行されるためヘッダーは付与される
        cc = response.headers.get("Cache-Control", "")
        assert "immutable" in cc, f"静的ファイルに immutable が含まれない: {cc}"
        assert "max-age=31536000" in cc, f"静的ファイルに max-age=31536000 が含まれない: {cc}"


# ─── Request-ID テスト ──────────────────────────
class TestRequestId:
    """リクエスト相関IDのテスト。"""

    def test_レスポンスにX_Request_Idヘッダーが含まれる(self, client):
        """全レスポンスに X-Request-Id が付与されること。"""
        response = client.get("/")
        assert "X-Request-Id" in response.headers
        req_id = response.headers["X-Request-Id"]
        assert len(req_id) == 16  # token_hex(8) = 16文字

    def test_リクエストごとに異なるIDが生成される(self, client):
        """連続リクエストで異なるIDが割り当てられること。"""
        response1 = client.get("/")
        response2 = client.get("/")
        assert response1.headers["X-Request-Id"] != response2.headers["X-Request-Id"]

    @patch("app.detect_content")
    def test_APIレスポンスにもX_Request_Idが含まれる(self, mock_detect, client):
        """APIエンドポイントのレスポンスにもIDが含まれること。"""
        mock_detect.return_value = {
            "ok": True, "data": [], "image_size": None,
            "error_code": None, "message": None,
        }
        response = client.post("/api/analyze", json={
            "image": create_valid_image_base64(),
            "mode": "text",
        })
        assert "X-Request-Id" in response.headers


# ─── CORS テスト ─────────────────────────────────
class TestCors:
    """CORSヘッダーのテスト。"""

    def test_デフォルトではCORSヘッダーが付かない(self, client):
        """ALLOWED_ORIGINS 未設定時は Access-Control-Allow-Origin が付かないこと。"""
        response = client.get("/", headers={"Origin": "https://evil.example.com"})
        assert "Access-Control-Allow-Origin" not in response.headers

    @patch("app.ALLOWED_ORIGINS", ["https://trusted.example.com"])
    def test_許可されたOriginにCORSヘッダーが付く(self, client):
        """許可されたOriginにはCORSヘッダーが付与されること。"""
        response = client.get("/", headers={"Origin": "https://trusted.example.com"})
        assert response.headers.get("Access-Control-Allow-Origin") == "https://trusted.example.com"
        assert "Origin" in response.headers.get("Vary", "")

    @patch("app.ALLOWED_ORIGINS", ["https://trusted.example.com"])
    def test_許可されていないOriginにはCORSヘッダーが付かない(self, client):
        """許可されていないOriginにはCORSヘッダーが付与されないこと。"""
        response = client.get("/", headers={"Origin": "https://evil.example.com"})
        assert "Access-Control-Allow-Origin" not in response.headers

    @patch("app.ALLOWED_ORIGINS", ["https://trusted.example.com"])
    def test_OPTIONSプリフライトが204を返す(self, client):
        """許可されたOriginからのOPTIONSリクエストが204+CORSヘッダーを返すこと。"""
        response = client.options(
            "/api/analyze",
            headers={"Origin": "https://trusted.example.com"},
        )
        assert response.status_code == 204
        assert response.headers.get("Access-Control-Allow-Origin") == "https://trusted.example.com"
        assert "POST" in response.headers.get("Access-Control-Allow-Methods", "")
        assert "Content-Type" in response.headers.get("Access-Control-Allow-Headers", "")

    def test_ALLOWED_ORIGINS未設定のOPTIONSは204だがCORSヘッダーなし(self, client):
        """ALLOWED_ORIGINS未設定時はOPTIONSは204を返すがCORSヘッダーは付かないこと。"""
        response = client.options(
            "/api/analyze",
            headers={"Origin": "https://any.example.com"},
        )
        assert response.status_code == 204
        assert "Access-Control-Allow-Origin" not in response.headers

    @patch("app.ALLOWED_ORIGINS", ["https://trusted.example.com"])
    def test_プリフライトがAccess_Control_Request_Headersを受け入れる(self, client):
        """プリフライトでContent-Type要求ヘッダーを送ってもCORSが通ること。"""
        response = client.options(
            "/api/analyze",
            headers={
                "Origin": "https://trusted.example.com",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )
        assert response.status_code == 204
        assert response.headers.get("Access-Control-Allow-Origin") == "https://trusted.example.com"
        assert "Content-Type" in response.headers.get("Access-Control-Allow-Headers", "")

    @patch("app.ALLOWED_ORIGINS", ["https://trusted.example.com"])
    def test_許可されていないOriginのプリフライトにCORSヘッダーが付かない(self, client):
        """許可外OriginのOPTIONSは204を返すがCORSヘッダーは付与しないこと。"""
        response = client.options(
            "/api/analyze",
            headers={
                "Origin": "https://evil.example.com",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )
        assert response.status_code == 204
        assert "Access-Control-Allow-Origin" not in response.headers


# ─── レート制限設定API テスト ───────────────────────────
class TestRateLimitsConfig:
    """レート制限設定エンドポイントのテスト。"""

    def test_日次上限値が取得できる(self, client):
        """GET /api/config/limits がサーバーの日次上限値を返すこと。"""
        response = client.get("/api/config/limits")
        assert response.status_code == 200
        data = response.get_json()
        assert "daily_limit" in data
        assert isinstance(data["daily_limit"], int)
        assert data["daily_limit"] > 0

    @patch("app.RATE_LIMIT_DAILY", 50)
    def test_環境変数で変更した上限値が反映される(self, client):
        """RATE_LIMIT_DAILY を変更すると /api/config/limits にも反映されること。"""
        response = client.get("/api/config/limits")
        assert response.status_code == 200
        data = response.get_json()
        assert data["daily_limit"] == 50


# ─── ヘルスチェック テスト ─────────────────────────────
class TestHealthChecks:
    """ヘルスチェックエンドポイントのテスト。"""

    def test_healthzが200を返す(self, client):
        """GET /healthz が常に200を返すこと。"""
        response = client.get("/healthz")
        assert response.status_code == 200
        data = response.get_json()
        assert data["status"] == "ok"

    def test_readyz未認証はstatusのみ返す(self, client):
        """認証なしの /readyz はstatusのみ返しインフラ情報を公開しないこと。"""
        response = client.get("/readyz")
        assert response.status_code == 200
        data = response.get_json()
        assert data["status"] == "ok"
        # 認証なしでは checks/warnings を公開しない
        assert "checks" not in data
        assert "warnings" not in data

    @patch("app.ADMIN_SECRET", "test-secret-readyz")
    def test_readyz認証済みは詳細情報を返す(self, client):
        """認証ありの /readyz はchecksを含む詳細情報を返すこと。"""
        response = client.get("/readyz", headers={"X-Admin-Secret": "test-secret-readyz"})
        assert response.status_code == 200
        data = response.get_json()
        assert data["status"] == "ok"
        assert data["checks"]["api_key_configured"] is True
        assert data["checks"]["rate_limiter_backend"] in ("redis", "in_memory")
        assert data["checks"]["rate_limiter_ok"] is True

    @patch("app.API_KEY", "")
    def test_readyzがAPIキー未設定で503を返す(self, client):
        """API_KEYが空なら /readyz は503を返すこと。"""
        response = client.get("/readyz")
        assert response.status_code == 503
        data = response.get_json()
        assert data["status"] == "not_ready"

    @patch("app.ADMIN_SECRET", "test-secret-readyz")
    @patch("app.REDIS_URL", "redis://localhost:6379")
    @patch("app.get_backend_type", return_value="in_memory")
    def test_readyzがRedisフォールバック時に503を返す(self, _mock_backend, client):
        """REDIS_URL設定済みでインメモリフォールバック時は503+警告を返すこと（認証あり）。"""
        response = client.get("/readyz", headers={"X-Admin-Secret": "test-secret-readyz"})
        assert response.status_code == 503
        data = response.get_json()
        assert data["status"] == "not_ready"
        assert data["checks"]["rate_limiter_ok"] is False
        assert "warnings" in data
        assert len(data["warnings"]) > 0
        assert "Redis" in data["warnings"][0]

    @patch("app.ADMIN_SECRET", "test-secret-readyz")
    @patch("app.REDIS_URL", "")
    @patch("app.get_backend_type", return_value="in_memory")
    def test_readyzがRedis未設定のインメモリは正常扱い(self, _mock_backend, client):
        """REDIS_URL未設定でインメモリの場合は意図的なので200を返すこと（認証あり）。"""
        response = client.get("/readyz", headers={"X-Admin-Secret": "test-secret-readyz"})
        assert response.status_code == 200
        data = response.get_json()
        assert data["status"] == "ok"
        assert data["checks"]["rate_limiter_ok"] is True
        assert "warnings" not in data


# ─── ADMIN_SECRET 強度チェック テスト ──────────────────
class TestAdminSecretCheck:
    """起動時のADMIN_SECRET強度検証ロジックのテスト。"""

    def test_未設定は未設定警告のみ(self):
        """空文字の場合は「未設定」の警告1件のみ。"""
        from app import _check_admin_secret
        warnings = _check_admin_secret("")
        assert len(warnings) == 1
        assert "未設定" in warnings[0]

    def test_短すぎる値は長さ警告(self):
        """16文字未満は長さ警告が出ること。"""
        from app import _check_admin_secret
        warnings = _check_admin_secret("Abc123!@")  # 8文字・文字種は十分
        assert any("短すぎ" in w for w in warnings)

    def test_低エントロピー値はエントロピー警告(self):
        """文字種が2種以下の場合はエントロピー警告が出ること。"""
        from app import _check_admin_secret
        warnings = _check_admin_secret("abcdefghijklmnopqrst")  # 20文字・小文字のみ
        assert any("エントロピー" in w for w in warnings)

    def test_高エントロピー値は警告なし(self):
        """十分な長さ・文字種のランダム値は警告が出ないこと。"""
        import secrets
        from app import _check_admin_secret
        strong_secret = secrets.token_urlsafe(32)
        warnings = _check_admin_secret(strong_secret)
        assert len(warnings) == 0


# ─── data:image プレフィックス回帰テスト ──────────────────
class TestDataImagePrefix:
    """ブラウザが送信する data:image/...;base64, プレフィックスの処理テスト。"""

    @patch("app.detect_content")
    def test_dataURIプレフィックス付きJPEGを正常処理する(self, mock_detect, client):
        """data:image/jpeg;base64, プレフィックス付きの画像を受け入れること。"""
        mock_detect.return_value = {
            "ok": True, "data": [], "image_size": None,
            "error_code": None, "message": None,
        }
        raw_b64 = create_valid_image_base64()
        prefixed = f"data:image/jpeg;base64,{raw_b64}"
        response = client.post("/api/analyze", json={
            "image": prefixed,
            "mode": "text",
        })
        assert response.status_code == 200
        assert response.get_json()["ok"] is True

    @patch("app.detect_content")
    def test_dataURIプレフィックス付きPNGを正常処理する(self, mock_detect, client):
        """data:image/png;base64, プレフィックス付きの画像を受け入れること。"""
        mock_detect.return_value = {
            "ok": True, "data": [], "image_size": None,
            "error_code": None, "message": None,
        }
        raw_b64 = create_valid_png_base64()
        prefixed = f"data:image/png;base64,{raw_b64}"
        response = client.post("/api/analyze", json={
            "image": prefixed,
            "mode": "text",
        })
        assert response.status_code == 200
        assert response.get_json()["ok"] is True


# ─── 405エラーハンドラテスト ───────────────────────────
class TestMethodNotAllowed:
    """許可されていないHTTPメソッドのJSONレスポンステスト。"""

    def test_GETでanalyzeにアクセスすると405を返す(self, client):
        """GET /api/analyze は405+JSONレスポンスを返すこと。"""
        response = client.get("/api/analyze")
        assert response.status_code == 405
        data = response.get_json()
        assert data["ok"] is False
        assert data["error_code"] == "METHOD_NOT_ALLOWED"

    def test_PUTでanalyzeにアクセスすると405を返す(self, client):
        """PUT /api/analyze は405+JSONレスポンスを返すこと。"""
        response = client.put("/api/analyze", json={"image": "test"})
        assert response.status_code == 405
        data = response.get_json()
        assert data["ok"] is False
        assert data["error_code"] == "METHOD_NOT_ALLOWED"
