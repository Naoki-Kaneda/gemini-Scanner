"""
E2Eテスト共通フィクスチャ。

Flask アプリを別スレッドで起動し、Playwright の Chromium から画面を操作する。
/api/analyze はブラウザ側で偽の応答に差し替えるため、Gemini API は呼ばない。
カメラは Chromium の偽デバイスに、静止した縞模様の映像ファイルを流して代用する。
"""

import re
import threading

import pytest
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

from app import app
from rate_limiter import reset_for_testing

# 外部フォントの読み込みを止める（CI のネットワーク状態に結果を左右させない）
_EXTERNAL_FONTS = re.compile(r"^https://fonts\.(googleapis|gstatic)\.com/")


def _write_still_y4m(path, width=640, height=480, frames=30):
    """毎フレーム同一の縦縞映像を Y4M 形式で書き出す（安定化検出が必ず成立する）。"""
    row = bytes(220 if (col // 80) % 2 == 0 else 40 for col in range(width))
    y_plane = row * height
    uv_plane = bytes([128]) * ((width // 2) * (height // 2))
    with open(path, "wb") as f:
        f.write(f"YUV4MPEG2 W{width} H{height} F30:1 Ip A1:1 C420jpeg\n".encode("ascii"))
        for _ in range(frames):
            f.write(b"FRAME\n")
            f.write(y_plane)
            f.write(uv_plane)
            f.write(uv_plane)


@pytest.fixture(scope="session")
def server_url():
    """テスト用に Flask アプリを空いているポートで起動し、URL を返す。

    API キーは tests/conftest.py でダミーに置き換え済み。偽応答の差し替えが外れても、
    本物のキーで課金されることはない。
    """
    reset_for_testing()

    server = make_server("127.0.0.1", 0, app, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"

    server.shutdown()


@pytest.fixture(scope="session")
def browser(tmp_path_factory):
    """偽カメラ付きの Chromium を起動する。"""
    video_path = tmp_path_factory.mktemp("fake_camera") / "still.y4m"
    _write_still_y4m(video_path)
    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            f"--use-file-for-fake-video-capture={video_path}",
        ])
        yield browser
        browser.close()


class ScannerPage:
    """アプリを開いたページと、テストで使う操作をまとめたもの。

    transitions には scanner.js の transitionTo() が出すコンソール出力
    （例: "IDLE → SCANNING"）を順に集める。stopScanning() など
    transitionTo() を通らない IDLE への戻りは記録されないので、DOM で確かめる。
    """

    def __init__(self, page):
        self.page = page
        self.transitions = []
        page.on("console", self._on_console)

    def _on_console(self, msg):
        if msg.text.startswith("状態遷移: "):
            self.transitions.append(msg.text.removeprefix("状態遷移: "))

    def mock_analyze(self, status=200, body=None, abort=False, hang=False):
        """/api/analyze をブラウザ側で差し替え、送られたリクエスト本文の一覧を返す。

        abort=True は通信エラー、hang=True は応答が返らない状態を再現する。
        """
        sent = []

        def handler(route):
            sent.append(route.request.post_data_json)
            if hang:
                return
            if abort:
                route.abort()
                return
            headers = {}
            if body and body.get("retry_after") is not None:
                headers["Retry-After"] = str(body["retry_after"])
            route.fulfill(status=status, json=body, headers=headers)

        self.page.route("**/api/analyze", handler)
        return sent

    def wait_camera_ready(self):
        """偽カメラの映像が描画できる状態になるまで待つ。"""
        self.page.wait_for_function(
            "() => { const v = document.getElementById('video-feed');"
            " return v && v.readyState >= 2 && v.videoWidth > 0; }"
        )


@pytest.fixture
def scanner(browser, server_url):
    """カメラ権限付きの新しいコンテキストでアプリを開く（テストごとに localStorage も空）。"""
    # bypass_csp: アプリの CSP は unsafe-eval を許さず、Playwright の wait_for_function の
    # 繰り返し確認が止められるため。CSP ヘッダー自体は tests/test_api.py で確かめている
    context = browser.new_context(permissions=["camera"], base_url=server_url, bypass_csp=True)
    page = context.new_page()
    page.route(_EXTERNAL_FONTS, lambda route: route.abort())
    scanner_page = ScannerPage(page)
    page.goto("/")
    yield scanner_page
    context.close()
