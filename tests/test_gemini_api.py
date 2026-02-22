"""
gemini_api.py の単体テスト。
Gemini API固有のエラー（SAFETY等）・タイムアウト・接続失敗・モード不正・パーサー境界ケースをカバー。
"""

import json
import pytest
from unittest.mock import patch
from requests.exceptions import Timeout, ConnectionError as RequestsConnectionError, RequestException
from conftest import make_b64, make_mock_response, create_valid_png_base64


# ─── Geminiレスポンスモック生成ヘルパー ──────────────────
def make_gemini_response(gemini_json, status_code=200, finish_reason="STOP"):
    """Gemini APIレスポンスのモックを生成する。"""
    response_data = {
        "candidates": [{
            "content": {
                "parts": [{"text": json.dumps(gemini_json)}]
            },
            "finishReason": finish_reason,
        }]
    }
    return make_mock_response(status_code=status_code, json_data=response_data)


def make_gemini_empty_response(status_code=200):
    """candidatesが空のGemini APIレスポンスのモックを生成する。"""
    return make_mock_response(status_code=status_code, json_data={"candidates": []})


def make_gemini_blocked_response():
    """プロンプトがブロックされたGemini APIレスポンスのモックを生成する。"""
    return make_mock_response(status_code=200, json_data={
        "candidates": [],
        "promptFeedback": {"blockReason": "SAFETY"},
    })


# ─── detect_content: モード不正値 ─────────────────
class TestDetectContentValidation:
    """detect_content のバリデーションテスト。"""

    def test_不正なmodeはValueErrorを投げる(self):
        """mode が text/object 以外は ValueError が発生すること。"""
        from gemini_api import detect_content
        with pytest.raises(ValueError, match="不正なモード"):
            detect_content(make_b64(), mode="invalid")

    @patch.dict("os.environ", {"GEMINI_API_KEY": ""})
    def test_APIキー未設定はValueErrorを投げる(self):
        """GEMINI_API_KEY が未設定の場合は ValueError が発生すること。"""
        import gemini_api
        # APIキーをクリア
        original = gemini_api.API_KEY
        gemini_api.API_KEY = None
        try:
            with pytest.raises(ValueError, match="APIキーが未設定"):
                from gemini_api import detect_content
                detect_content(make_b64(), mode="text")
        finally:
            gemini_api.API_KEY = original


# ─── detect_content: HTTP エラー ──────────────────
class TestDetectContentHttpErrors:
    """HTTPレベルのエラーハンドリングテスト。"""

    @patch("gemini_api.session.post")
    def test_HTTP500はokFalseを返す(self, mock_post):
        """Gemini API が HTTP 500 を返した場合は ok=False を返すこと。"""
        mock_post.return_value = make_mock_response(status_code=500)
        from gemini_api import detect_content
        result = detect_content(make_b64(), mode="object")
        assert result["ok"] is False
        assert result["error_code"] == "API_500"

    @patch("gemini_api.time.sleep")
    @patch("gemini_api.session.post")
    def test_429後に成功した場合は再試行でokTrueを返す(self, mock_post, mock_sleep):
        """HTTP 429 の後に200が返れば、自動再試行で成功扱いになること。"""
        res_429 = make_mock_response(status_code=429)
        res_429.headers = {"Retry-After": "0"}
        mock_post.side_effect = [
            res_429,
            make_gemini_response({"objects": []}),
        ]
        from gemini_api import detect_content
        result = detect_content(make_b64(), mode="object")
        assert result["ok"] is True
        assert mock_post.call_count == 2
        mock_sleep.assert_called_once_with(0.0)

    @patch("gemini_api.session.post")
    def test_タイムアウトはokFalseを返す(self, mock_post):
        """タイムアウト発生時は ok=False, error_code=TIMEOUT を返すこと。"""
        mock_post.side_effect = Timeout()
        from gemini_api import detect_content
        result = detect_content(make_b64(), mode="text")
        assert result["ok"] is False
        assert result["error_code"] == "TIMEOUT"

    @patch("gemini_api.session.post")
    def test_接続エラーはokFalseを返す(self, mock_post):
        """接続失敗時は ok=False, error_code=CONNECTION_ERROR を返すこと。"""
        mock_post.side_effect = RequestsConnectionError()
        from gemini_api import detect_content
        result = detect_content(make_b64(), mode="text")
        assert result["ok"] is False
        assert result["error_code"] == "CONNECTION_ERROR"

    @patch("gemini_api.session.post")
    def test_その他通信エラーはokFalseを返す(self, mock_post):
        """RequestException 発生時は ok=False, error_code=REQUEST_ERROR を返すこと。"""
        mock_post.side_effect = RequestException("generic error")
        from gemini_api import detect_content
        result = detect_content(make_b64(), mode="text")
        assert result["ok"] is False
        assert result["error_code"] == "REQUEST_ERROR"

    @patch("gemini_api.session.post")
    def test_JSONパース失敗はPARSE_ERRORを返す(self, mock_post):
        """Content-Type=jsonだがパース失敗時は PARSE_ERROR を返すこと。"""
        mock_resp = make_mock_response(status_code=200, content_type="application/json")
        mock_resp.json.side_effect = ValueError("No JSON object could be decoded")
        mock_resp.text = "broken json {"
        mock_post.return_value = mock_resp
        from gemini_api import detect_content
        result = detect_content(make_b64(), mode="text")
        assert result["ok"] is False
        assert result["error_code"] == "PARSE_ERROR"
        assert "解析に失敗" in result["message"]

    @patch("gemini_api.session.post")
    def test_非JSONレスポンスはAPI_RESPONSE_NOT_JSONを返す(self, mock_post):
        """Content-TypeがHTMLなど非JSON時は API_RESPONSE_NOT_JSON を返すこと。"""
        mock_resp = make_mock_response(status_code=200, content_type="text/html; charset=utf-8")
        mock_resp.json.side_effect = ValueError("No JSON object could be decoded")
        mock_resp.text = "<html>Service Unavailable</html>"
        mock_post.return_value = mock_resp
        from gemini_api import detect_content
        result = detect_content(make_b64(), mode="text")
        assert result["ok"] is False
        assert result["error_code"] == "API_RESPONSE_NOT_JSON"
        assert "Content-Type" in result["message"]
        assert "text/html" in result["message"]


# ─── detect_content: Gemini API 固有エラー ─────────────
class TestDetectContentGeminiErrors:
    """Gemini API固有のエラーケースのテスト。"""

    @patch("gemini_api.session.post")
    def test_candidates空はokTrueの空データを返す(self, mock_post):
        """candidates が空の場合は ok=True, data=[] を返すこと。"""
        mock_post.return_value = make_gemini_empty_response()
        from gemini_api import detect_content
        result = detect_content(make_b64(), mode="text")
        assert result["ok"] is True
        assert result["data"] == []

    @patch("gemini_api.session.post")
    def test_SAFETYブロックはokFalseを返す(self, mock_post):
        """promptFeedback.blockReason=SAFETY の場合は ok=False を返すこと。"""
        mock_post.return_value = make_gemini_blocked_response()
        from gemini_api import detect_content
        result = detect_content(make_b64(), mode="text")
        assert result["ok"] is False
        assert result["error_code"] == "SAFETY_BLOCKED"

    @patch("gemini_api.session.post")
    def test_finishReasonSAFETYはokFalseを返す(self, mock_post):
        """finishReason=SAFETY の場合は ok=False を返すこと。"""
        mock_post.return_value = make_mock_response(status_code=200, json_data={
            "candidates": [{
                "content": {"parts": [{"text": "{}"}]},
                "finishReason": "SAFETY",
            }]
        })
        from gemini_api import detect_content
        result = detect_content(make_b64(), mode="text")
        assert result["ok"] is False
        assert result["error_code"] == "SAFETY_BLOCKED"

    @patch("gemini_api.session.post")
    def test_GeminiレスポンスのJSONパース失敗はPARSE_ERRORを返す(self, mock_post):
        """Geminiがスキーマに従わない不正なJSONを返した場合のテスト。"""
        mock_post.return_value = make_mock_response(status_code=200, json_data={
            "candidates": [{
                "content": {"parts": [{"text": "not valid json {{{"}]},
                "finishReason": "STOP",
            }]
        })
        from gemini_api import detect_content
        result = detect_content(make_b64(), mode="text")
        assert result["ok"] is False
        assert result["error_code"] == "PARSE_ERROR"


# ─── 座標変換テスト ──────────────────────────────
class TestCoordinateConversion:
    """_gemini_box_to_pixel_vertices / _gemini_box_to_normalized_vertices のテスト。"""

    def test_ピクセル座標変換(self):
        """box_2d [y_min, x_min, y_max, x_max] 0-1000 → ピクセル座標4頂点"""
        from gemini_api import _gemini_box_to_pixel_vertices
        result = _gemini_box_to_pixel_vertices([100, 200, 500, 800], 640, 480)
        # x_min = 200/1000*640 = 128, y_min = 100/1000*480 = 48
        # x_max = 800/1000*640 = 512, y_max = 500/1000*480 = 240
        assert result == [[128, 48], [512, 48], [512, 240], [128, 240]]

    def test_正規化座標変換(self):
        """box_2d [y_min, x_min, y_max, x_max] 0-1000 → 正規化座標(0-1) 4頂点"""
        from gemini_api import _gemini_box_to_normalized_vertices
        result = _gemini_box_to_normalized_vertices([100, 200, 500, 800])
        assert result == [[0.2, 0.1], [0.8, 0.1], [0.8, 0.5], [0.2, 0.5]]

    def test_空box_2dは空リストを返す(self):
        """空のbox_2dは空リストを返すこと。"""
        from gemini_api import _gemini_box_to_pixel_vertices, _gemini_box_to_normalized_vertices
        assert _gemini_box_to_pixel_vertices([], 640, 480) == []
        assert _gemini_box_to_pixel_vertices(None, 640, 480) == []
        assert _gemini_box_to_normalized_vertices([]) == []
        assert _gemini_box_to_normalized_vertices(None) == []

    def test_不正な長さのbox_2dは空リストを返す(self):
        """要素数が4でないbox_2dは空リストを返すこと。"""
        from gemini_api import _gemini_box_to_pixel_vertices
        assert _gemini_box_to_pixel_vertices([100, 200, 500], 640, 480) == []

    def test_全範囲座標変換(self):
        """box_2d [0, 0, 1000, 1000] → 画像全体"""
        from gemini_api import _gemini_box_to_pixel_vertices
        result = _gemini_box_to_pixel_vertices([0, 0, 1000, 1000], 640, 480)
        assert result == [[0, 0], [640, 0], [640, 480], [0, 480]]


# ─── パーサー境界ケース ───────────────────────────
class TestParsers:
    """Gemini用パーサーの境界ケース。"""

    def test_テキストレスポンスが空の場合空リストを返す(self):
        """texts が空の場合は空リストを返すこと。"""
        from gemini_api import _parse_gemini_text_response
        assert _parse_gemini_text_response({}, None) == []
        assert _parse_gemini_text_response({"texts": []}, [640, 480]) == []

    def test_テキストレスポンスを正しくパースする(self):
        """texts の各項目がラベルとピクセル座標で返されること。"""
        from gemini_api import _parse_gemini_text_response
        result = _parse_gemini_text_response({
            "texts": [
                {"text": "Hello", "box_2d": [100, 100, 200, 500]},
                {"text": "World", "box_2d": [300, 100, 400, 500]},
            ]
        }, [640, 480])
        assert len(result) == 2
        assert result[0]["label"] == "Hello"
        assert result[1]["label"] == "World"
        assert len(result[0]["bounds"]) == 4

    def test_テキストレスポンスが空文字を除外する(self):
        """空文字・空白のtextは除外されること。"""
        from gemini_api import _parse_gemini_text_response
        result = _parse_gemini_text_response({
            "texts": [
                {"text": "Hello", "box_2d": [100, 100, 200, 500]},
                {"text": "   ", "box_2d": [300, 100, 400, 500]},
                {"text": "", "box_2d": [500, 100, 600, 500]},
            ]
        }, [640, 480])
        assert len(result) == 1
        assert result[0]["label"] == "Hello"

    def test_物体レスポンスが空の場合空リストを返す(self):
        """objects が空の場合は空リストを返すこと。"""
        from gemini_api import _parse_gemini_object_response
        assert _parse_gemini_object_response({}) == []
        assert _parse_gemini_object_response({"objects": []}) == []

    def test_物体レスポンスを正規化座標でパースする(self):
        """objects の各項目が正規化座標(0-1)で返されること。"""
        from gemini_api import _parse_gemini_object_response
        result = _parse_gemini_object_response({
            "objects": [{
                "name": "Bottle",
                "name_ja": "ボトル",
                "score": 0.95,
                "box_2d": [100, 200, 500, 800],
            }]
        })
        assert len(result) == 1
        assert "Bottle" in result[0]["label"]
        assert "ボトル" in result[0]["label"]
        assert "95%" in result[0]["label"]
        assert len(result[0]["bounds"]) == 4
        # 正規化座標の検証
        assert result[0]["bounds"][0] == [0.2, 0.1]  # x_min, y_min

    def test_物体ラベルに日本語訳がない場合英語のみ表示(self):
        """name_jaもなく翻訳辞書にもないラベルは英語のみで表示すること。"""
        from gemini_api import _parse_gemini_object_response
        result = _parse_gemini_object_response({
            "objects": [{
                "name": "Quasar",
                "score": 0.99,
                "box_2d": [100, 200, 500, 800],
            }]
        })
        assert len(result) == 1
        assert "Quasar" in result[0]["label"]
        assert "（" not in result[0]["label"]


# ─── プロキシURLマスクテスト ────────────────────
class TestMaskProxyUrl:
    """_mask_proxy_url のユニットテスト。"""

    def test_認証情報付きURLがマスクされる(self):
        """user:pass@host 形式のURLで認証部分がマスクされること。"""
        from gemini_api import _mask_proxy_url
        result = _mask_proxy_url("http://user:pass@proxy.example.com:8080")
        assert "user" not in result
        assert "pass" not in result
        assert "***:***@proxy.example.com:8080" in result
        assert result.startswith("http://")

    def test_認証情報なしURLはそのまま返す(self):
        """認証情報がないURLはマスクせずそのまま返すこと。"""
        from gemini_api import _mask_proxy_url
        result = _mask_proxy_url("http://proxy.example.com:8080")
        assert result == "http://proxy.example.com:8080"

    def test_空文字はそのまま返す(self):
        """空文字はそのまま返すこと。"""
        from gemini_api import _mask_proxy_url
        assert _mask_proxy_url("") == ""

    def test_Noneはそのまま返す(self):
        """Noneはそのまま返すこと。"""
        from gemini_api import _mask_proxy_url
        assert _mask_proxy_url(None) is None


# ─── 画像安全チェックテスト ────────────────────
class TestImageSafetyCheck:
    """_ensure_jpeg の安全チェックがバイパスされないことのテスト。"""

    @patch("gemini_api.session.post")
    @patch("gemini_api._ensure_jpeg")
    def test_ValueError時はdetect_contentがValueErrorを伝播する(self, mock_ensure, mock_post):
        """_ensure_jpegがValueErrorを投げた場合、detect_contentも伝播すること。"""
        mock_ensure.side_effect = ValueError("画像サイズが大きすぎます")
        from gemini_api import detect_content
        with pytest.raises(ValueError, match="画像サイズが大きすぎます"):
            detect_content(make_b64(), mode="text")
        # APIは呼ばれないこと
        mock_post.assert_not_called()

    @patch("gemini_api.session.post")
    @patch("gemini_api._ensure_jpeg")
    def test_非ValueErrorの前処理エラーはフェイルクローズでエラーを返す(self, mock_ensure, mock_post):
        """前処理でValueError以外のエラーが出た場合はAPI送信せずエラーを返すこと（フェイルクローズ）。"""
        mock_ensure.side_effect = OSError("一時的なI/Oエラー")
        from gemini_api import detect_content
        result = detect_content(make_b64(), mode="text")
        assert result["ok"] is False
        assert result["error_code"] == "PARSE_ERROR"
        assert "前処理" in result["message"]
        # APIは呼ばれないこと（安全チェックすり抜け防止）
        mock_post.assert_not_called()


# ─── thinking戦略テスト ──────────────────────────────
class TestResolveThinkingConfig:
    """_resolve_thinking_config のモデル名別テーブルテスト。"""

    @pytest.mark.parametrize("model_name,expected", [
        # Gemini 2.x Flash系: thinkingBudget: 0 で思考を無効化
        ("gemini-2.5-flash", {"thinkingBudget": 0}),
        ("gemini-2.0-flash", {"thinkingBudget": 0}),
        ("gemini-2.5-flash-preview-05-20", {"thinkingBudget": 0}),
        # Gemini 2.x Pro系: thinking無効化不可 → 空辞書
        ("gemini-2.5-pro", {}),
        ("gemini-2.5-pro-preview-05-06", {}),
        # Gemini 3.x Flash系: thinkingLevel: MINIMAL
        ("gemini-3.0-flash", {"thinkingLevel": "MINIMAL"}),
        ("gemini-3-flash-preview", {"thinkingLevel": "MINIMAL"}),
        # Gemini 3.x Pro系: thinkingLevel: LOW（MINIMAL非対応）
        ("gemini-3.0-pro", {"thinkingLevel": "LOW"}),
        ("gemini-3-pro-preview", {"thinkingLevel": "LOW"}),
        # 未知モデル: 安全側 → 空辞書
        ("unknown-model", {}),
        ("gemini-4-ultra", {}),
    ])
    def test_モデル名に応じた正しいthinking設定を返す(self, model_name, expected):
        """各モデル名に対して仕様準拠のthinkingConfigが返ること。"""
        import gemini_api
        original = gemini_api.GEMINI_MODEL
        gemini_api.GEMINI_MODEL = model_name
        try:
            result = gemini_api._resolve_thinking_config()
            assert result == expected, f"モデル '{model_name}' の期待値 {expected} に対し {result} が返された"
        finally:
            gemini_api.GEMINI_MODEL = original

    def test_空辞書のときペイロードにthinkingConfigキーが含まれない(self):
        """thinking設定が空辞書の場合、ペイロードからthinkingConfigが除外されること。"""
        import gemini_api
        original = gemini_api.GEMINI_MODEL
        gemini_api.GEMINI_MODEL = "gemini-2.5-pro"  # 空辞書を返すモデル
        try:
            payload = gemini_api._build_gemini_payload(
                make_b64(), mode="text", context_hint=""
            )
            assert "thinkingConfig" not in payload["generationConfig"]
        finally:
            gemini_api.GEMINI_MODEL = original

    def test_非空辞書のときペイロードにthinkingConfigキーが含まれる(self):
        """thinking設定が非空の場合、ペイロードにthinkingConfigが含まれること。"""
        import gemini_api
        original = gemini_api.GEMINI_MODEL
        gemini_api.GEMINI_MODEL = "gemini-2.5-flash"  # thinkingBudget: 0 を返すモデル
        try:
            payload = gemini_api._build_gemini_payload(
                make_b64(), mode="text", context_hint=""
            )
            assert "thinkingConfig" in payload["generationConfig"]
            assert payload["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 0}
        finally:
            gemini_api.GEMINI_MODEL = original

    def test_未知モデルでペイロードにthinkingConfigキーが含まれない(self):
        """未知モデルの場合、ペイロードからthinkingConfigが除外されること。"""
        import gemini_api
        original = gemini_api.GEMINI_MODEL
        gemini_api.GEMINI_MODEL = "gemini-4-ultra"
        try:
            payload = gemini_api._build_gemini_payload(
                make_b64(), mode="text", context_hint=""
            )
            assert "thinkingConfig" not in payload["generationConfig"]
        finally:
            gemini_api.GEMINI_MODEL = original


# ─── parts結合テスト ───────────────────────────────
class TestPartsJoining:
    """レスポンスのparts結合でthought/非textパートが除外されることを検証する。"""

    @patch("gemini_api.session.post")
    def test_thoughtパートが結合から除外される(self, mock_post):
        """thought: true のpartはJSON結合に含まれないこと。"""
        response_data = {
            "candidates": [{
                "content": {
                    "parts": [
                        {"text": "thinking about this...", "thought": True},
                        {"text": '{"texts": [{"text": "Hello", "box_2d": [0,0,500,500]}]}'},
                    ]
                },
                "finishReason": "STOP",
            }]
        }
        mock_post.return_value = make_mock_response(status_code=200, json_data=response_data)
        from gemini_api import detect_content
        result = detect_content(make_b64(), mode="text")
        assert result["ok"] is True
        assert len(result["data"]) == 1
        assert result["data"][0]["label"] == "Hello"

    @patch("gemini_api.session.post")
    def test_text無しパートが結合から除外される(self, mock_post):
        """functionCall等のtext無しpartが無視されること。"""
        response_data = {
            "candidates": [{
                "content": {
                    "parts": [
                        {"functionCall": {"name": "some_func"}},
                        {"text": '{"texts": []}'},
                    ]
                },
                "finishReason": "STOP",
            }]
        }
        mock_post.return_value = make_mock_response(status_code=200, json_data=response_data)
        from gemini_api import detect_content
        result = detect_content(make_b64(), mode="text")
        assert result["ok"] is True


# ─── get_proxy_status: 4パターン回帰テスト ──────────────
class TestGetProxyStatus:
    """NO_PROXY_MODE と PROXY_URL の組み合わせ4パターンで get_proxy_status を検証する。"""

    @patch("gemini_api.NO_PROXY_MODE", False)
    @patch("gemini_api._RAW_PROXY_URL", "http://proxy.example.com:8080")
    def test_プロキシURL有りでNO_PROXY_MODE無効ならenabled(self):
        """PROXY_URL設定済み + NO_PROXY_MODE=false → enabled=True。"""
        from gemini_api import get_proxy_status
        status = get_proxy_status()
        assert status["enabled"] is True
        assert "proxy.example.com" in status["url"]

    @patch("gemini_api.NO_PROXY_MODE", True)
    @patch("gemini_api._RAW_PROXY_URL", "http://proxy.example.com:8080")
    def test_プロキシURL有りでNO_PROXY_MODE有効ならdisabled(self):
        """PROXY_URL設定済み + NO_PROXY_MODE=true → enabled=False。"""
        from gemini_api import get_proxy_status
        status = get_proxy_status()
        assert status["enabled"] is False
        assert status["url"] == ""

    @patch("gemini_api.NO_PROXY_MODE", False)
    @patch("gemini_api._RAW_PROXY_URL", "")
    def test_プロキシURL空でNO_PROXY_MODE無効ならdisabled(self):
        """PROXY_URL未設定 + NO_PROXY_MODE=false → enabled=False。"""
        from gemini_api import get_proxy_status
        status = get_proxy_status()
        assert status["enabled"] is False

    @patch("gemini_api.NO_PROXY_MODE", True)
    @patch("gemini_api._RAW_PROXY_URL", "")
    def test_プロキシURL空でNO_PROXY_MODE有効ならdisabled(self):
        """PROXY_URL未設定 + NO_PROXY_MODE=true → enabled=False。"""
        from gemini_api import get_proxy_status
        status = get_proxy_status()
        assert status["enabled"] is False
        assert status["url"] == ""

    @patch("gemini_api.NO_PROXY_MODE", False)
    @patch("gemini_api._RAW_PROXY_URL", "http://user:secret@proxy.example.com:8080")
    def test_認証情報付きURLはマスクされる(self):
        """認証情報付きのPROXY_URLが get_proxy_status で漏えいしないこと。"""
        from gemini_api import get_proxy_status
        status = get_proxy_status()
        assert status["enabled"] is True
        assert "secret" not in status["url"]
        assert "***:***" in status["url"]


# ─── 顔検出パーサーテスト ─────────────────────────────
class TestFaceParser:
    """_parse_gemini_face_response のテスト。"""

    def test_空レスポンスで空リストを返す(self):
        from gemini_api import _parse_gemini_face_response
        assert _parse_gemini_face_response({}, None) == []
        assert _parse_gemini_face_response({"faces": []}, [640, 480]) == []

    def test_感情付き顔を正しくパースする(self):
        from gemini_api import _parse_gemini_face_response
        result = _parse_gemini_face_response({
            "faces": [{
                "box_2d": [100, 100, 500, 500],
                "confidence": 0.95,
                "joy": "VERY_LIKELY",
                "sorrow": "VERY_UNLIKELY",
                "anger": "UNLIKELY",
                "surprise": "POSSIBLE",
            }]
        }, [640, 480])
        assert len(result) == 1
        assert "喜び" in result[0]["label"]
        assert result[0]["confidence"] == 0.95
        assert len(result[0]["bounds"]) == 4
        assert result[0]["emotions"]["joy"] == "VERY_LIKELY"


# ─── ロゴ検出パーサーテスト ────────────────────────────
class TestLogoParser:
    """_parse_gemini_logo_response のテスト。"""

    def test_空レスポンスで空リストを返す(self):
        from gemini_api import _parse_gemini_logo_response
        assert _parse_gemini_logo_response({}, None) == []

    def test_ロゴを正しくパースする(self):
        from gemini_api import _parse_gemini_logo_response
        result = _parse_gemini_logo_response({
            "logos": [{
                "name": "Google",
                "score": 0.95,
                "box_2d": [100, 100, 300, 400],
            }]
        }, [640, 480])
        assert len(result) == 1
        assert "Google" in result[0]["label"]
        assert "95%" in result[0]["label"]
        assert len(result[0]["bounds"]) == 4


# ─── 分類タグパーサーテスト ────────────────────────────
class TestClassifyParser:
    """_parse_gemini_classify_response のテスト。"""

    def test_空レスポンスで空リストを返す(self):
        from gemini_api import _parse_gemini_classify_response
        assert _parse_gemini_classify_response({}) == []

    def test_分類タグを正しくパースする(self):
        from gemini_api import _parse_gemini_classify_response
        result = _parse_gemini_classify_response({
            "labels": [
                {"name": "Laptop", "name_ja": "ノートPC", "score": 0.98},
                {"name": "Electronics", "name_ja": "電子機器", "score": 0.92},
            ]
        })
        assert len(result) == 2
        assert "Laptop" in result[0]["label"]
        assert "ノートPC" in result[0]["label"]
        assert result[0]["score"] == 0.98

    def test_翻訳辞書にフォールバックする(self):
        """name_jaが空で翻訳辞書にある場合、辞書の日本語が使われること。"""
        from gemini_api import _parse_gemini_classify_response
        result = _parse_gemini_classify_response({
            "labels": [
                {"name": "Laptop", "score": 0.98},
            ]
        })
        assert "ノートPC" in result[0]["label"]


# ─── AI識別（旧Web検索）パーサーテスト ────────────────────
class TestWebParser:
    """_parse_gemini_web_response のテスト。"""

    def test_空レスポンスで空を返す(self):
        from gemini_api import _parse_gemini_web_response
        data, detail = _parse_gemini_web_response({})
        assert data == []
        assert detail["best_guess"] == ""
        assert detail["entities"] == []
        assert detail["pages"] == []
        assert detail["similar_images"] == []

    def test_AI識別結果を正しくパースする(self):
        from gemini_api import _parse_gemini_web_response
        data, detail = _parse_gemini_web_response({
            "best_guess": "トルクレンチ",
            "entities": [
                {"name": "TOHNICHI", "score": 0.85},
                {"name": "Torque wrench", "score": 0.7},
            ],
            "description": "東日製作所のトルクレンチ",
        })
        assert detail["best_guess"] == "トルクレンチ"
        assert len(detail["entities"]) == 2
        assert detail["entities"][0]["name"] == "TOHNICHI"
        # Geminiバージョンではpages/similar_imagesは常に空
        assert detail["pages"] == []
        assert detail["similar_images"] == []
        assert any("トルクレンチ" in d["label"] for d in data)


# ─── ラベル判定パーサーテスト ─────────────────────────
class TestLabelParser:
    """_parse_gemini_label_response のテスト。"""

    def test_ラベル検出時はlabel_detectedがTrueになる(self):
        from gemini_api import _parse_gemini_label_response
        data, detected, reason = _parse_gemini_label_response({
            "label_detected": True,
            "reason": "テキスト検出: 「Product A」",
            "texts": [
                {"text": "Product A", "box_2d": [100, 100, 200, 400]},
            ],
        }, [640, 480])
        assert detected is True
        assert "テキスト検出" in reason
        assert len(data) == 1
        assert data[0]["label"] == "Product A"

    def test_ラベル未検出時はlabel_detectedがFalseになる(self):
        from gemini_api import _parse_gemini_label_response
        data, detected, reason = _parse_gemini_label_response({
            "label_detected": False,
            "reason": "テキスト・ラベル関連の物体が検出されませんでした",
        }, None)
        assert detected is False
        assert len(data) == 0


# ─── MIME整合テスト（PNG入力が全モードでJPEG変換されること） ──────
class TestMimeConsistency:
    """PNG画像入力時に全モードでJPEG変換が行われ、MIME不整合が発生しないことを検証する。"""

    @pytest.fixture
    def png_b64(self):
        """テスト用PNG画像のBase64文字列。"""
        return create_valid_png_base64()

    @patch("gemini_api.session.post")
    def test_objectモードでPNG入力がJPEG変換される(self, mock_post, png_b64):
        """objectモードでPNG画像を送ると_ensure_jpegでJPEG変換されること。"""
        mock_post.return_value = make_gemini_response({"objects": []})
        from gemini_api import detect_content
        result = detect_content(png_b64, mode="object")
        assert result["ok"] is True
        # API送信ペイロードのmimeTypeがimage/jpegであること
        call_kwargs = mock_post.call_args
        payload = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
        mime_type = payload["contents"][0]["parts"][0]["inlineData"]["mimeType"]
        assert mime_type == "image/jpeg"

    @patch("gemini_api.session.post")
    def test_faceモードでPNG入力がJPEG変換される(self, mock_post, png_b64):
        """faceモードでPNG画像を送ると_ensure_jpegでJPEG変換されること。"""
        mock_post.return_value = make_gemini_response({"faces": []})
        from gemini_api import detect_content
        result = detect_content(png_b64, mode="face")
        assert result["ok"] is True
        call_kwargs = mock_post.call_args
        payload = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
        sent_data = payload["contents"][0]["parts"][0]["inlineData"]["data"]
        # 変換後のデータがJPEGマジックバイトで始まること
        import base64
        decoded = base64.b64decode(sent_data)
        assert decoded[:3] == b'\xff\xd8\xff', "JPEG変換後のバイナリがJPEGヘッダーで始まること"

    @patch("gemini_api.session.post")
    def test_logoモードでPNG入力がJPEG変換される(self, mock_post, png_b64):
        """logoモードでPNG画像を送ると_ensure_jpegでJPEG変換されること。"""
        mock_post.return_value = make_gemini_response({"logos": []})
        from gemini_api import detect_content
        result = detect_content(png_b64, mode="logo")
        assert result["ok"] is True
        call_kwargs = mock_post.call_args
        payload = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
        sent_data = payload["contents"][0]["parts"][0]["inlineData"]["data"]
        import base64
        decoded = base64.b64decode(sent_data)
        assert decoded[:3] == b'\xff\xd8\xff'

    @patch("gemini_api.session.post")
    def test_classifyモードでPNG入力がJPEG変換される(self, mock_post, png_b64):
        """classifyモードでPNG画像を送ると_ensure_jpegでJPEG変換されること。"""
        mock_post.return_value = make_gemini_response({"labels": []})
        from gemini_api import detect_content
        result = detect_content(png_b64, mode="classify")
        assert result["ok"] is True
        call_kwargs = mock_post.call_args
        payload = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
        sent_data = payload["contents"][0]["parts"][0]["inlineData"]["data"]
        import base64
        decoded = base64.b64decode(sent_data)
        assert decoded[:3] == b'\xff\xd8\xff'

    @patch("gemini_api.session.post")
    def test_webモードでPNG入力がJPEG変換される(self, mock_post, png_b64):
        """webモードでPNG画像を送ると_ensure_jpegでJPEG変換されること。"""
        mock_post.return_value = make_gemini_response({
            "best_guess": "テスト", "entities": [],
        })
        from gemini_api import detect_content
        result = detect_content(png_b64, mode="web")
        assert result["ok"] is True
        call_kwargs = mock_post.call_args
        payload = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
        sent_data = payload["contents"][0]["parts"][0]["inlineData"]["data"]
        import base64
        decoded = base64.b64decode(sent_data)
        assert decoded[:3] == b'\xff\xd8\xff'


# ─── _ensure_jpeg 回帰テスト ────────────────────────
class TestEnsureJpeg:
    """_ensure_jpeg の入出力を直接検証する回帰テスト。"""

    def test_PNG入力がJPEGバイナリに変換される(self):
        """PNG Base64を渡すとJPEGヘッダー付きBase64が返ること。"""
        import base64
        from gemini_api import _ensure_jpeg
        png_b64 = create_valid_png_base64()
        result_b64 = _ensure_jpeg(png_b64, enhance=False)
        decoded = base64.b64decode(result_b64)
        # JPEG マジックバイト (FFD8FF)
        assert decoded[:3] == b'\xff\xd8\xff', "出力がJPEGフォーマットでない"

    def test_enhance有効時もJPEGバイナリが返る(self):
        """enhance=True（text/labelモード用）でもJPEG出力であること。"""
        import base64
        from gemini_api import _ensure_jpeg
        png_b64 = create_valid_png_base64()
        result_b64 = _ensure_jpeg(png_b64, enhance=True)
        decoded = base64.b64decode(result_b64)
        assert decoded[:3] == b'\xff\xd8\xff', "enhance=True時の出力がJPEGフォーマットでない"

    def test_JPEG入力もそのままJPEGで返る(self):
        """JPEG Base64を渡しても正常にJPEG出力されること（冪等性）。"""
        import base64
        from gemini_api import _ensure_jpeg
        png_b64 = create_valid_png_base64()
        # まずJPEGに変換
        jpeg_b64 = _ensure_jpeg(png_b64, enhance=False)
        # JPEG→JPEG（冪等性）
        result_b64 = _ensure_jpeg(jpeg_b64, enhance=False)
        decoded = base64.b64decode(result_b64)
        assert decoded[:3] == b'\xff\xd8\xff', "JPEG→JPEG変換で出力がJPEGでない"
