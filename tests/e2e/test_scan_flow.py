"""
画面側（static/*.js）のスキャン状態遷移を、ブラウザ上で確かめるE2Eテスト。

実行: python -m playwright install chromium（初回のみ）
      python -m pytest tests/e2e -q -m e2e
"""

import re

import pytest
from PIL import Image, ImageDraw
from playwright.sync_api import expect

pytestmark = pytest.mark.e2e

# API仕様書（docs/api-spec.md）の text モード成功応答と同じ形
TEXT_SUCCESS = {
    "ok": True,
    "data": [{"label": "Hello World", "bounds": [[10, 20], [100, 20], [100, 40], [10, 40]]}],
    "image_size": [640, 480],
    "error_code": None,
    "message": None,
    "request_id": "e2e0000000000001",
    "retry_after": None,
}

# 分単位のレート制限（app.py の 429 応答と同じ形）
MINUTE_RATE_LIMITED = {
    "ok": False,
    "data": [],
    "error_code": "RATE_LIMITED",
    "message": "リクエストが多すぎます",
    "request_id": "e2e0000000000002",
    # 「待機中」の確認から無効化の確認までに COOLDOWN が終わらないよう、数秒の余裕を持たせる
    "retry_after": 3,
    "limit_type": "minute",
}


def _make_sample_png(tmp_path):
    """白地に黒い四角の静止画を作り、そのパスを返す。"""
    image_path = tmp_path / "sample.png"
    image = Image.new("RGB", (320, 240), "white")
    ImageDraw.Draw(image).rectangle([40, 60, 280, 180], fill="black")
    image.save(image_path)
    return image_path


def test_image_upload_sends_and_shows_result(scanner, tmp_path):
    """静止画をアップロードしてスタートすると、解析結果が一覧に出てIDLEに戻る。"""
    page = scanner.page
    sent = scanner.mock_analyze(body=TEXT_SUCCESS)
    scanner.wait_camera_ready()

    page.set_input_files("#file-input", str(_make_sample_png(tmp_path)))
    page.wait_for_function("() => document.getElementById('image-feed').naturalWidth > 0")
    page.click("#btn-scan")

    expect(page.locator("#result-list .result-item")).to_contain_text("Hello World")
    expect(page.locator("#status-text")).to_have_text("完了 ― スタートで再スキャン")
    expect(page.locator("#btn-scan")).to_contain_text("スタート")
    assert len(sent) == 1
    assert sent[0]["mode"] == "text"
    assert sent[0]["image"].startswith("data:image/jpeg;base64,")


def test_image_upload_during_camera_startup_keeps_image(scanner_camera_held, tmp_path):
    """起動時のカメラ取得を待つ間に静止画を選んでも、遅れて届いたカメラ映像で上書きされない。"""
    scanner = scanner_camera_held
    page = scanner.page
    sent = scanner.mock_analyze(body=TEXT_SUCCESS)

    page.set_input_files("#file-input", str(_make_sample_png(tmp_path)))
    page.wait_for_function("() => document.getElementById('image-feed').naturalWidth > 0")

    # 静止画を選んだあとでカメラの取得を完了させる
    page.evaluate("() => window.__releaseCamera()")
    page.wait_for_function("() => window.__cameraDelivered === true")

    expect(page.locator("#image-feed")).to_be_visible()
    camera_attached = page.evaluate("() => document.getElementById('video-feed').srcObject !== null")
    assert not camera_attached

    page.click("#btn-scan")
    expect(page.locator("#status-text")).to_have_text("完了 ― スタートで再スキャン")
    assert len(sent) == 1


def test_camera_one_shot_goes_through_analyzing(scanner):
    """カメラ映像が静止すると自動で解析し、ワンショットなのでIDLEに戻る。"""
    page = scanner.page
    sent = scanner.mock_analyze(body=TEXT_SUCCESS)
    scanner.wait_camera_ready()

    page.click("#btn-scan")

    expect(page.locator("#status-text")).to_have_text("完了 ― スタートで再スキャン", timeout=15_000)
    assert scanner.transitions == ["IDLE → SCANNING", "SCANNING → ANALYZING", "ANALYZING → IDLE"]
    assert len(sent) == 1
    expect(page.locator("#result-list .result-item")).to_contain_text("Hello World")


def test_rate_limit_enters_cooldown_then_returns_to_idle(scanner):
    """分単位の429でCOOLDOWNになりボタンが止まり、retry_after 秒後に操作できる状態へ戻る。"""
    page = scanner.page
    scanner.mock_analyze(status=429, body=MINUTE_RATE_LIMITED)
    scanner.wait_camera_ready()

    page.click("#btn-scan")

    btn_scan = page.locator("#btn-scan")
    expect(btn_scan).to_contain_text("待機中", timeout=15_000)
    expect(btn_scan).to_be_disabled()
    assert "ANALYZING → COOLDOWN" in scanner.transitions

    # COOLDOWN → IDLE は transitionTo() を通らないため DOM で確かめる
    expect(page.locator("#status-text")).to_have_text("準備完了 ― スタートで再スキャン", timeout=10_000)
    expect(btn_scan).to_be_enabled()
    expect(btn_scan).to_contain_text("スタート")


def test_hidden_tab_stops_scan_but_keeps_camera(scanner):
    """タブが隠れるとスキャンは止まるが、カメラの映像は止めない（69af312 の回帰防止）。"""
    page = scanner.page
    # 応答を返さないことで、隠れた時点がSCANNING・ANALYZINGのどちらでも結果を同じにする
    scanner.mock_analyze(hang=True)
    scanner.wait_camera_ready()

    page.click("#btn-scan")
    expect(page.locator("#btn-scan")).not_to_contain_text("スタート")

    page.evaluate("""() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
    }""")

    expect(page.locator("#btn-scan")).to_contain_text("スタート")
    expect(page.locator("#status-text")).to_have_text("準備完了")
    camera_live = page.evaluate("""() => {
        const stream = document.getElementById('video-feed').srcObject;
        return !!stream && stream.getVideoTracks().every(t => t.readyState === 'live');
    }""")
    assert camera_live


def test_network_error_pauses_and_schedules_retry(scanner):
    """通信エラーが再試行（2+4+8秒）でも続くと、PAUSED_ERROR になり自動再試行を予約する。"""
    page = scanner.page
    sent = scanner.mock_analyze(abort=True)
    scanner.wait_camera_ready()

    page.click("#btn-scan")

    expect(page.locator("#status-text")).to_have_text(re.compile(r"^⚠ エラー ― \d+秒後に再試行$"), timeout=25_000)
    assert "ANALYZING → PAUSED_ERROR" in scanner.transitions
    assert len(sent) == 4  # 初回 + fetchWithRetry の再試行3回
    expect(page.locator("#btn-scan")).to_contain_text("ストップ")

    # 手動停止で予約済みの再試行も取り消される
    page.click("#btn-scan")
    expect(page.locator("#btn-scan")).to_contain_text("スタート")
