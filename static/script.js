// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Vision AI Scanner - フロントエンドスクリプト
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ─── 定数・設定 ──────────────────────────────────
let API_DAILY_LIMIT = 1000;           // 1日のAPI呼び出し上限（サーバーから動的取得）
const API_WARNING_RATIO = 0.8;       // API上限の警告表示閾値（80%で黄色）
// ターゲットボックス寸法: CSS変数（:root）から読み取り、CSSと二重管理しない
function _readCssPercent(prop, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n / 100 : fallback;
}
let TARGET_BOX_RATIO, TARGET_BOX_TOP, TARGET_BOX_HEIGHT;
document.addEventListener('DOMContentLoaded', () => {
    TARGET_BOX_RATIO  = _readCssPercent('--target-box-width',  0.98);
    TARGET_BOX_TOP    = _readCssPercent('--target-box-top',    0.01);
    TARGET_BOX_HEIGHT = _readCssPercent('--target-box-height', 0.97);
});
const STABILITY_THRESHOLD = 20;      // 安定判定フレーム数（約0.6秒@30fps） - 応答性向上のため短縮
const MOTION_THRESHOLD = 30;         // フレーム間差分の閾値（カメラノイズ耐性を確保）
const MOTION_CANVAS_WIDTH = 64;      // モーション検出用キャンバス幅
const MOTION_CANVAS_HEIGHT = 48;     // モーション検出用キャンバス高さ
const CAMERA_WIDTH = 1280;           // カメラ解像度（幅）
const CAMERA_HEIGHT = 720;           // カメラ解像度（高さ）
const JPEG_QUALITY = 0.95;           // キャプチャ画質（デフォルト、モード別設定で上書き）

// モード別の送信画像設定（解像度とJPEG品質）
// maxWidth: 送信画像の最大幅（px）。元画像がこれ以下なら縮小しない
// quality: JPEG品質（0.0〜1.0）。低いほどファイルサイズ小
const MODE_IMAGE_CONFIG = {
    text:     { maxWidth: null, quality: 0.95 },  // OCR: 高解像度・高品質を維持
    label:    { maxWidth: null, quality: 0.95 },  // ラベル検出: テキスト読み取りに高解像度必要
    face:     { maxWidth: 800,  quality: 0.85 },  // 顔検出: 中解像度で十分
    logo:     { maxWidth: 800,  quality: 0.85 },  // ロゴ検出: 中解像度で十分
    object:   { maxWidth: 640,  quality: 0.80 },  // 物体検出: 低解像度で十分
    classify: { maxWidth: 640,  quality: 0.80 },  // 分類: 低解像度で十分
    web:      { maxWidth: 640,  quality: 0.80 },  // Web検索: 低解像度で十分
};

/**
 * ネットワーク品質に基づいて画像リサイズの倍率を返す。
 * Network Information API で接続状態を判定し、低速回線時は画像サイズ・品質を下げる。
 * API非対応ブラウザ（Safari/Firefox）では倍率1.0を返す（プログレッシブエンハンスメント）。
 */
function getNetworkQualityMultiplier() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn) return { widthMultiplier: 1.0, qualityMultiplier: 1.0 };

    // save-data が有効 → ユーザーが明示的にデータ節約を要求
    if (conn.saveData) return { widthMultiplier: 0.5, qualityMultiplier: 0.6 };

    // effectiveType に基づく段階的な品質調整
    switch (conn.effectiveType) {
        case 'slow-2g':
        case '2g':
            return { widthMultiplier: 0.5, qualityMultiplier: 0.5 };
        case '3g':
            return { widthMultiplier: 0.7, qualityMultiplier: 0.7 };
        case '4g':
        default:
            return { widthMultiplier: 1.0, qualityMultiplier: 1.0 };
    }
}

const MIN_RESULT_LENGTH = 5;         // 結果フィルター: 最小文字数
const LABEL_MAX_LENGTH = 25;         // バウンディングボックスのラベル最大文字数
const RETRY_DELAY_MS = 10000;        // エラー後の再試行待機時間（ミリ秒）
const CAPTURE_RESET_DELAY_MS = 3000;       // 撮影完了後の次スキャンまでの待機（ミリ秒） - 短縮
const LABEL_CAPTURE_RESET_DELAY_MS = 3000; // ラベルモード: 次のスキャンまでの待機（ミリ秒） - 短縮
// true にするとクライアント側でも日次上限を強制。既定は false（サーバー側429に委譲）
const ENFORCE_CLIENT_DAILY_LIMIT = false;
const FETCH_TIMEOUT_MS = 60000;      // fetch タイムアウト（Gemini API 30秒×リトライ＋余裕）
let DUPLICATE_SKIP_COUNT = 2;        // 同じ結果がN回連続したらカメラ移動まで一時停止（UI設定で変更可）

// 画像ハッシュ比較: API送信前に前回送信画像との類似度を判定
const IMAGE_HASH_SIZE = 8;           // ハッシュ用縮小画像サイズ（8x8=64ピクセル）
const IMAGE_HASH_THRESHOLD = 0.95;   // 類似度の閾値（0.95=95%一致でスキップ）

// モードごとのバウンディングボックス色設定
const MODE_BOX_CONFIG = {
    text:     { color: '#00ff88', bg: 'rgba(0, 255, 136, 0.7)',   showLabel: false },
    object:   { color: '#ff3b3b', bg: 'rgba(255, 59, 59, 0.7)',   showLabel: true },
    face:     { color: '#00bfff', bg: 'rgba(0, 191, 255, 0.7)',   showLabel: true },
    logo:     { color: '#d4bee6', bg: 'rgba(212, 190, 230, 0.7)', showLabel: true },
    label:    { color: '#00ff88', bg: 'rgba(0, 255, 136, 0.7)',   showLabel: false },
    classify: { color: null,      bg: null,                        showLabel: false },
    web:      { color: null,      bg: null,                        showLabel: false },
};

/** モード別のヒント入力欄 placeholder テキスト */
const MODE_HINT_PLACEHOLDER = {
    text:     'ヒント例: 賞味期限を探して、英語を翻訳して',
    object:   'ヒント例: 食品だけ検出して、危険物を探して',
    label:    'ヒント例: バーコードを読み取って、商品名を特定して',
    face:     'ヒント例: 年齢も推定して、表情を詳しく分析して',
    logo:     'ヒント例: ブランド名を特定して',
    classify: 'ヒント例: 料理のジャンルを判定して',
    web:      'ヒント例: この建物は何？、この絵の作者は？',
};

/** タイムアウト付き fetch のシグナルを生成する。
 *  AbortSignal.timeout() 非対応ブラウザ（Safari 15以前等）では
 *  AbortController + setTimeout でフォールバックする。 */
function fetchSignal(ms = FETCH_TIMEOUT_MS) {
    if (typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(ms);
    }
    // フォールバック: 手動タイムアウト
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
}

/**
 * リトライ付き fetch。ネットワークエラー時に指数バックオフで再試行する。
 * - AbortError（タイムアウト）は再試行せず即座にスロー
 * - HTTPレスポンス（429含む）は成功扱いで返却（呼び出し元で処理）
 * - 各試行で新しいAbortSignalを生成（前回のタイムアウト残留を防止）
 */
async function fetchWithRetry(url, options, maxRetries = 3, baseDelay = 2000) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fetch(url, { ...options, signal: fetchSignal() });
        } catch (err) {
            lastError = err;
            // タイムアウトは再試行しない
            if (err.name === 'AbortError') throw err;
            // 最終試行なら諦めてスロー
            if (attempt >= maxRetries) {
                err._retriesExhausted = true;
                throw err;
            }
            // 指数バックオフ: 2s → 4s → 8s
            const delay = baseDelay * Math.pow(2, attempt);
            if (statusText) {
                statusText.textContent = `⚠ 通信エラー — 再試行中 (${attempt + 1}/${maxRetries})...`;
            }
            console.warn(`通信エラー (試行 ${attempt + 1}/${maxRetries + 1}): ${err.message}。${delay}ms後に再試行`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

// ─── DOM要素の参照（init() で DOMContentLoaded 後に取得） ────
let video, canvas, ctx, overlayCanvas, overlayCtx;
let imageFeed;  // 静止画表示用 <img> 要素
let resultList, btnScan, statusDot, statusText;
let videoContainer, stabilityBarContainer, stabilityBarFill;
let btnProxy, apiCounter, dupSkipBadge, cameraSelector;
let btnCamera, btnFile, btnFlipCam;
let modeText, modeObject, modeLabel, modeFace, modeLogo, modeClassify, modeWeb;

// ─── アプリケーション状態 ──────────────────────────
let isScanning = false;
let currentSource = 'camera';
let currentMode = 'text';
let isMirrored = false;
let isPausedByError = false;  // エラーによる一時停止状態
let retryTimerId = null;      // 再試行用タイマーID
let cooldownTimerId = null;   // レート制限クールダウンタイマーID
let cooldownRemaining = 0;    // クールダウン残り秒数（0 = クールダウン中でない）
let isAnalyzing = false;      // API呼び出し中フラグ（並行呼び出し防止）
let shouldRestartAfterCooldown = false; // クールダウン終了後に自動的にスキャンを開始するか
let lastSentImageHash = null; // 前回送信した画像のハッシュ値（重複送信防止用）
let lastResultFingerprint = null;    // 直前のAPI結果の指紋（重複検出用）
let duplicateCount = 0;              // 同じ結果の連続回数
let isDuplicatePaused = false;       // 重複検出による一時停止状態
let apiCallCount = 0;
let videoDevices = [];
let currentFacingMode = 'environment';  // 'environment'=外カメ, 'user'=インカメ
let lastFrameData = null;
let stabilityCounter = 0;

// 差分検出用キャンバス（毎フレーム生成せず再利用）
const motionCanvas = document.createElement('canvas');
motionCanvas.width = MOTION_CANVAS_WIDTH;
motionCanvas.height = MOTION_CANVAS_HEIGHT;
const motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });

// 画像ハッシュ比較用キャンバス（8x8グレースケール）
const hashCanvas = document.createElement('canvas');
hashCanvas.width = IMAGE_HASH_SIZE;
hashCanvas.height = IMAGE_HASH_SIZE;
const hashCtx = hashCanvas.getContext('2d', { willReadFrequently: true });

/**
 * Canvas上の画像から8x8グレースケールハッシュを生成する。
 * drawImage済みのcanvasを引数に取り、8x8に縮小してグレースケール値の配列を返す。
 * @param {HTMLCanvasElement} srcCanvas - 描画済みのキャプチャキャンバス
 * @returns {Uint8Array} 64要素のグレースケール値配列（0〜255）
 */
function computeImageHash(srcCanvas) {
    hashCtx.drawImage(srcCanvas, 0, 0, IMAGE_HASH_SIZE, IMAGE_HASH_SIZE);
    const pixels = hashCtx.getImageData(0, 0, IMAGE_HASH_SIZE, IMAGE_HASH_SIZE).data;
    const gray = new Uint8Array(IMAGE_HASH_SIZE * IMAGE_HASH_SIZE);
    for (let i = 0; i < gray.length; i++) {
        // ITU-R BT.601 輝度変換: 0.299R + 0.587G + 0.114B
        gray[i] = Math.round(pixels[i * 4] * 0.299 + pixels[i * 4 + 1] * 0.587 + pixels[i * 4 + 2] * 0.114);
    }
    return gray;
}

/**
 * 2つの画像ハッシュの類似度を計算する（0.0〜1.0）。
 * 各ピクセルの差分の平均を255で正規化し、1から引いて類似度に変換。
 * @param {Uint8Array} hashA - 比較元ハッシュ
 * @param {Uint8Array} hashB - 比較先ハッシュ
 * @returns {number} 類似度（1.0 = 完全一致、0.0 = 完全不一致）
 */
function compareImageHash(hashA, hashB) {
    if (!hashA || !hashB || hashA.length !== hashB.length) return 0;
    let totalDiff = 0;
    for (let i = 0; i < hashA.length; i++) {
        totalDiff += Math.abs(hashA[i] - hashB[i]);
    }
    const avgDiff = totalDiff / (hashA.length * 255);
    return 1 - avgDiff;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API使用量管理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** localStorage からAPI使用量を読み込む。日付が変わったらリセット。 */
function loadApiUsage() {
    const today = new Date().toDateString();
    const saved = localStorage.getItem('visionApiUsage');
    if (saved) {
        try {
            const data = JSON.parse(saved);
            apiCallCount = (data && data.date === today) ? (data.count || 0) : 0;
        } catch {
            // localStorageが壊れている場合はリセット
            apiCallCount = 0;
            localStorage.removeItem('visionApiUsage');
        }
    }
    updateApiCounter();
}

/** API使用量を localStorage に保存する。 */
function saveApiUsage() {
    localStorage.setItem('visionApiUsage', JSON.stringify({
        date: new Date().toDateString(),
        count: apiCallCount,
    }));
    updateApiCounter();
}

// ─── プロキシ設定制御 ──────────────────────────────
let currentProxyEnabled = false;

async function loadProxyConfig() {
    try {
        const res = await fetch('/api/config/proxy', { signal: fetchSignal() });
        if (res.ok) {
            const data = await res.json();
            updateProxyButton(data.enabled);
        }
    } catch (err) {
        console.error('プロキシ設定取得エラー:', err);
        if (btnProxy) btnProxy.title = '設定取得に失敗しました';
    }
}

/** プロキシ状態の表示を更新する（表示のみ、切替はCLI操作）。 */
function updateProxyButton(isEnabled) {
    currentProxyEnabled = isEnabled;
    if (!btnProxy) return;

    if (isEnabled) {
        btnProxy.textContent = 'Proxy設定: ON';
        btnProxy.className = 'proxy-badge active';
    } else {
        btnProxy.textContent = 'Proxy設定: OFF';
        btnProxy.className = 'proxy-badge inactive';
    }
}

/** サーバーからレート制限設定を取得し、フロントの上限表示に反映する。 */
async function loadRateLimits() {
    try {
        const res = await fetch('/api/config/limits', { signal: fetchSignal() });
        if (res.ok) {
            const data = await res.json();
            if (data.daily_limit > 0) {
                API_DAILY_LIMIT = data.daily_limit;
                updateApiCounter();
            }
        }
    } catch (err) {
        console.error('レート制限設定取得エラー:', err);
        if (apiCounter) apiCounter.title = '設定取得に失敗しました';
    }
}

/**
 * サーバーからAPI使用量を取得し、ローカルカウントを同期する。
 * NAT/マルチデバイス環境でlocalStorageの値とサーバー側の値が乖離する問題を解消する。
 * サーバー値がローカル値より大きい場合のみ上書きする（他端末の消費を反映）。
 */
async function syncApiUsage() {
    try {
        const res = await fetch('/api/config/usage', { signal: fetchSignal() });
        if (!res.ok) return;
        const data = await res.json();

        // サーバー側の上限設定も同期
        if (data.daily_limit > 0) API_DAILY_LIMIT = data.daily_limit;

        // サーバー値がローカルより大きい場合のみ上書き（他端末の消費を反映）
        if (data.daily_count > apiCallCount) {
            apiCallCount = data.daily_count;
            saveApiUsage();
        }

        // サーバー側で既に日次上限に達していればボタンを無効化
        if (data.daily_count >= data.daily_limit) {
            if (statusText) statusText.textContent = '⚠ 本日のAPI上限に達しています';
            disableScanButton('本日の上限に到達');
        }

        updateApiCounter();
    } catch (err) {
        console.error('API使用量同期エラー:', err);
    }
}

/** スキャンボタンの内容をDOM操作で安全に更新する（innerHTML不使用）。 */
function _setBtnScanContent(iconText, labelText) {
    if (!btnScan) return;
    while (btnScan.firstChild) btnScan.removeChild(btnScan.firstChild);
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = iconText;
    btnScan.appendChild(icon);
    btnScan.appendChild(document.createTextNode(' ' + labelText));
}

/** スキャンボタンを無効化する（API上限到達時）。 */
function disableScanButton(message) {
    if (!btnScan) return;
    btnScan.disabled = true;
    _setBtnScanContent('⚠', message);
    btnScan.style.opacity = '0.5';
    btnScan.style.cursor = 'not-allowed';
}

/** ヘッダーのAPIカウンター表示を更新する。 */
function updateApiCounter() {
    if (!apiCounter) return;

    apiCounter.textContent = `API: ${apiCallCount}/${API_DAILY_LIMIT}`;
    if (apiCallCount >= API_DAILY_LIMIT) {
        apiCounter.style.color = '#ff3b3b';
    } else if (apiCallCount >= API_DAILY_LIMIT * API_WARNING_RATIO) {
        apiCounter.style.color = '#ffaa00';
    } else {
        // 日付リセット後に色を復帰
        apiCounter.style.color = '';
    }

    // 既定ではボタンロックを行わない（サーバー側のレート制限を信頼）
    if (ENFORCE_CLIENT_DAILY_LIMIT && apiCallCount >= API_DAILY_LIMIT) {
        disableScanButton('API上限（本日分）');
    } else if (btnScan && !isAnalyzing) {
        // 解析中（API応答待ち）はdisabled状態を維持する
        btnScan.disabled = false;
        btnScan.style.opacity = '';
        btnScan.style.cursor = '';
    }
}

/** API上限に達しているか判定する。達している場合はスキャンを停止。 */
function isApiLimitReached() {
    if (ENFORCE_CLIENT_DAILY_LIMIT && apiCallCount >= API_DAILY_LIMIT) {
        statusText.textContent = '⚠ API上限に達しました（本日分）';
        stopScanning();
        disableScanButton('API上限（本日分）');
        return true;
    }
    return false;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// カメラ制御
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


/** カメラストリームを停止する。 */
function stopCameraStream() {
    if (video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    }
}

/**
 * カメラを初期化してHD映像を取得する。
 * deviceId が指定されていればそのカメラを、未指定なら背面カメラ（environment）を優先する。
 * @param {string|null} deviceId - 使用するカメラのデバイスID（nullで自動選択）
 */
async function setupCamera(deviceId = null) {
    try {
        // カメラ権限を取得するため、まずストリームを開く
        // deviceId指定時はそのカメラを、未指定時は currentFacingMode で向きを指定
        const constraints = {
            video: deviceId
                ? { deviceId: { exact: deviceId }, width: { ideal: CAMERA_WIDTH }, height: { ideal: CAMERA_HEIGHT } }
                : { facingMode: { ideal: currentFacingMode }, width: { ideal: CAMERA_WIDTH }, height: { ideal: CAMERA_HEIGHT } },
        };

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (constraintErr) {
            // 指定カメラや背面カメラで失敗した場合、制約なしでリトライ
            console.warn('指定条件でのカメラ取得に失敗、フォールバック:', constraintErr.name);
            stream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: CAMERA_WIDTH }, height: { ideal: CAMERA_HEIGHT } },
            });
        }

        video.srcObject = stream;
        await video.play().catch((err) => {
            console.warn('映像再生の開始に失敗:', err.name);
            if (statusText) statusText.textContent = '⚠ カメラ映像の再生に失敗しました';
        });
        currentSource = 'camera';
        updateSourceButtons();

        // 権限付与後にデバイスリストを更新（labelが取得可能になる）
        await populateCameraSelector();

        // 現在使用中のカメラをドロップダウンで選択状態にする
        const activeTrack = stream.getVideoTracks()[0];
        if (activeTrack && cameraSelector) {
            const settings = activeTrack.getSettings();
            if (settings.deviceId) {
                cameraSelector.value = settings.deviceId;
            }
        }

        // インカメ/外カメ切替ボタンの表示制御
        // facingMode をサポートするカメラが前面・背面の両方あるときだけ表示
        updateFlipButtonVisibility();
    } catch (err) {
        console.error('カメラアクセスエラー:', err);
        alert('カメラへのアクセスが拒否されたか、カメラが見つかりません。');
    }
}

/**
 * カメラ選択ドロップダウンにデバイス一覧を表示する。
 * カメラが2台以上あればドロップダウンを表示、1台以下なら非表示。
 */
async function populateCameraSelector() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devices.filter(d => d.kind === 'videoinput');

    if (!cameraSelector) return;

    // 既存の選択肢をクリア
    while (cameraSelector.firstChild) {
        cameraSelector.removeChild(cameraSelector.firstChild);
    }

    if (videoDevices.length > 1) {
        cameraSelector.classList.remove('hidden');

        videoDevices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            // ラベルがない場合（権限未付与時など）は番号で表示
            option.textContent = device.label || `カメラ ${index + 1}`;
            cameraSelector.appendChild(option);
        });
    } else {
        cameraSelector.classList.add('hidden');
    }
}

/** ドロップダウンで選択されたカメラに切り替える。 */
function switchCameraDevice(deviceId) {
    stopCameraStream();
    setupCamera(deviceId);
}

/**
 * インカメ ⇔ 外カメを切り替える。
 * facingMode を反転させて、deviceIdなし（=facingModeで自動選択）でカメラを再起動する。
 */
function toggleFacingMode() {
    currentFacingMode = (currentFacingMode === 'environment') ? 'user' : 'environment';
    updateFlipButton();
    stopCameraStream();
    setupCamera();  // deviceIdなし → currentFacingMode で自動選択
}

/** カメラ反転ボタンのラベルを現在の向きに合わせて更新する。 */
function updateFlipButton() {
    if (!btnFlipCam) return;
    btnFlipCam.textContent = currentFacingMode === 'environment'
        ? '⟳ 外カメ'
        : '⟳ インカメ';
}

/**
 * インカメ/外カメ切替ボタンの表示を制御する。
 * デバイスラベルから前面・背面カメラの両方が存在するか判定し、
 * 片方しかない場合（PCなど）はボタンを非表示にする。
 */
function updateFlipButtonVisibility() {
    if (!btnFlipCam) return;

    // カメラが1台以下なら切替不要
    if (videoDevices.length < 2) {
        btnFlipCam.classList.add('hidden');
        return;
    }

    // 各カメラの facingMode を取得して前面・背面が両方あるか確認
    // getCapabilities() が使えるブラウザでは正確に判定できる
    let hasFront = false;
    let hasBack = false;

    // 現在のストリームのトラックから判定を試みる
    if (video.srcObject) {
        const tracks = video.srcObject.getVideoTracks();
        for (const track of tracks) {
            if (typeof track.getCapabilities === 'function') {
                const caps = track.getCapabilities();
                if (caps.facingMode && caps.facingMode.length > 0) {
                    // facingMode をサポートするカメラがある → モバイルデバイスの可能性大
                    hasFront = true;
                    hasBack = true;
                    break;
                }
            }
        }
    }

    // getCapabilities で判定できなかった場合、ラベルから推定
    if (!hasFront && !hasBack) {
        for (const device of videoDevices) {
            const label = (device.label || '').toLowerCase();
            if (label.includes('front') || label.includes('user') || label.includes('facing front')
                || label.includes('前面') || label.includes('インカメ')) {
                hasFront = true;
            }
            if (label.includes('back') || label.includes('rear') || label.includes('environment')
                || label.includes('facing back') || label.includes('背面') || label.includes('外')) {
                hasBack = true;
            }
        }
    }

    // 前面・背面の両方が確認できた場合のみボタンを表示
    if (hasFront && hasBack) {
        btnFlipCam.classList.remove('hidden');
    } else {
        btnFlipCam.classList.add('hidden');
    }
}

/** ファイル（動画または静止画）をアップロードして表示する。 */
function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    stopCameraStream();
    // スキャン中なら停止
    if (isScanning) stopScanning();

    // 前のBlob URLがあればリボークしてメモリリークを防止
    if (video.src && video.src.startsWith('blob:')) {
        URL.revokeObjectURL(video.src);
    }
    if (imageFeed && imageFeed.src && imageFeed.src.startsWith('blob:')) {
        URL.revokeObjectURL(imageFeed.src);
    }

    const isImage = file.type.startsWith('image/');

    if (isImage) {
        // 静止画: <img> 要素に表示、<video> を非表示
        const blobUrl = URL.createObjectURL(file);
        imageFeed.src = blobUrl;
        imageFeed.classList.remove('hidden');
        video.classList.add('hidden');
        video.pause();
        video.removeAttribute('src');
        currentSource = 'image';
    } else {
        // 動画: <video> 要素で再生、<img> を非表示
        imageFeed.classList.add('hidden');
        imageFeed.removeAttribute('src');
        video.classList.remove('hidden');
        video.src = URL.createObjectURL(file);
        video.loop = true;
        video.play();
        currentSource = 'file';
    }
    updateSourceButtons();
}

/** 入力ソースをカメラに切り替える。 */
function switchSource(source) {
    if (source === 'camera') {
        // 静止画表示をリセット
        if (imageFeed) {
            if (imageFeed.src && imageFeed.src.startsWith('blob:')) {
                URL.revokeObjectURL(imageFeed.src);
            }
            imageFeed.removeAttribute('src');
            imageFeed.classList.add('hidden');
        }
        video.classList.remove('hidden');
        setupCamera();
    }
}

/** Camera / File ボタンのアクティブ状態を更新する。 */
function updateSourceButtons() {
    if (btnCamera) btnCamera.classList.toggle('active', currentSource === 'camera');
    // 'file'（動画）と 'image'（静止画）の両方でファイルボタンをアクティブに
    if (btnFile) btnFile.classList.toggle('active', currentSource === 'file' || currentSource === 'image');
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// スキャン・安定化検出
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 重複検出状態をリセットする。 */
function resetDuplicateState() {
    isDuplicatePaused = false;
    duplicateCount = 0;
    lastResultFingerprint = null;
}

/** スキャンの開始/停止を切り替える（チャタリング防止: タイムスタンプガード）。 */
let lastToggleTime = 0;
function toggleScanning() {
    const now = Date.now();
    if (now - lastToggleTime < 800) return;
    if (isAnalyzing) return; // 解析中（API応答待ち）はトグル無効
    // クールダウン中: ボタンを押してもスキャン開始せず、残り秒数をフィードバック
    if (cooldownRemaining > 0) {
        shouldRestartAfterCooldown = true;
        if (statusText) {
            statusText.textContent = `⏳ 解除まであと${cooldownRemaining}秒 — 解除後に自動スキャン開始します`;
        }
        return;
    }
    lastToggleTime = now;
    // isScanning または isPausedByError（エラー再試行待ち）なら停止
    (isScanning || isPausedByError) ? stopScanning() : startScanning();
}

/** スキャンを開始し、安定化検出ループを起動する。 */
function startScanning() {
    // エラー再試行タイマーが残っていればクリア（2重ループ防止）
    isPausedByError = false;
    if (retryTimerId) {
        clearTimeout(retryTimerId);
        retryTimerId = null;
    }

    isScanning = true;
    // XSS対策: DOM操作でボタン内容を更新（innerHTML不使用）
    _setBtnScanContent('■', 'ストップ');
    btnScan.classList.add('scanning');
    if (videoContainer) videoContainer.classList.add('scanning');
    if (statusDot) statusDot.classList.add('active');
    if (statusText) statusText.textContent = 'スキャン中';

    // 安定化状態をリセット（前回停止時のフレームデータが残ると復帰直後に誤判定する）
    lastFrameData = null;
    stabilityCounter = 0;
    // 重複検出状態もリセット
    isDuplicatePaused = false;
    duplicateCount = 0;
    lastResultFingerprint = null;

    // 静止画モード: 安定化検出不要 → 即座に解析を実行
    if (currentSource === 'image') {
        if (stabilityBarContainer) stabilityBarContainer.classList.add('hidden');
        if (statusText) statusText.textContent = '解析中...';
        captureAndAnalyze();
        return;
    }

    // 動画/カメラモード: 安定化バーを表示してスキャンループ開始
    if (stabilityBarContainer) stabilityBarContainer.classList.remove('hidden');
    if (stabilityBarFill) stabilityBarFill.style.width = '0%';

    scanFrameCount = 0;
    requestAnimationFrame(scanLoop);
}

/** スキャンを停止してUIをリセットする。 */
function stopScanning() {
    isScanning = false;
    isPausedByError = false;
    if (retryTimerId) {
        clearTimeout(retryTimerId);
        retryTimerId = null;
    }
    // レート制限クールダウン中なら停止（ボタンやバーの復帰も含む）
    stopCooldownCountdown();
    clearOverlay();
    // XSS対策: DOM操作でボタン内容を更新（innerHTML不使用）
    _setBtnScanContent('▶', 'スタート');
    btnScan.classList.remove('scanning');
    if (videoContainer) videoContainer.classList.remove('scanning');
    if (statusDot) statusDot.classList.remove('active');
    if (statusText) statusText.textContent = '準備完了';

    // 安定化状態をリセット
    lastFrameData = null;
    stabilityCounter = 0;
    // 重複検出状態もリセット
    isDuplicatePaused = false;
    duplicateCount = 0;
    lastResultFingerprint = null;
    updateDupSkipBadge();

    // 安定化バーを非表示
    if (stabilityBarContainer) stabilityBarContainer.classList.add('hidden');
}

/** requestAnimationFrameベースのスキャンループ。 */
let scanFrameCount = 0;
function scanLoop() {
    if (!isScanning) return;
    scanFrameCount++;
    checkStabilityAndCapture();
    requestAnimationFrame(scanLoop);
}

/**
 * フレーム間差分で安定状態を検出し、安定したらキャプチャする。
 * statusText は状態遷移時のみ更新（チラつき防止）。進捗はプログレスバーのみ。
 */
let lastStabilityState = 'idle'; // idle | stabilizing | captured | moving
function checkStabilityAndCapture() {
    if (!video.videoWidth) return;

    // 再利用キャンバスでフレーム差分を計算
    motionCtx.drawImage(video, 0, 0, motionCanvas.width, motionCanvas.height);

    const currentFrameData = motionCtx.getImageData(0, 0, motionCanvas.width, motionCanvas.height).data;

    if (lastFrameData) {
        let diff = 0;
        for (let i = 0; i < currentFrameData.length; i += 4) {
            diff += Math.abs(currentFrameData[i] - lastFrameData[i]);
            diff += Math.abs(currentFrameData[i + 1] - lastFrameData[i + 1]);
            diff += Math.abs(currentFrameData[i + 2] - lastFrameData[i + 2]);
        }
        const avgDiff = diff / (motionCanvas.width * motionCanvas.height);

        if (avgDiff < MOTION_THRESHOLD) {
            // 安定状態
            stabilityCounter++;
            const progress = Math.min((stabilityCounter / STABILITY_THRESHOLD) * 100, 100);
            if (stabilityBarFill) {
                stabilityBarFill.style.width = progress + '%';
                stabilityBarFill.classList.remove('captured');
            }
            // テキストは変更しない（プログレスバーのみで進捗を表示）
            lastStabilityState = 'stabilizing';

            if (stabilityCounter >= STABILITY_THRESHOLD) {
                // 重複一時停止中はキャプチャをスキップ（バーは100%で待機）
                if (isDuplicatePaused) {
                    stabilityCounter = STABILITY_THRESHOLD; // カウンターを維持
                    return;
                }
                // 安定完了 → キャプチャ実行
                lastStabilityState = 'captured';
                if (stabilityBarFill) {
                    stabilityBarFill.style.width = '100%';
                    stabilityBarFill.classList.add('captured');
                }
                if (statusText) statusText.textContent = '解析中...';
                captureAndAnalyze();
                stabilityCounter = 0;

                // モードに応じた遅延後にバーをリセット
                // ラベルモード: 結果確認＋品物入替の時間を確保（5秒）
                const resetDelay = ['label', 'web'].includes(currentMode)
                    ? LABEL_CAPTURE_RESET_DELAY_MS
                    : CAPTURE_RESET_DELAY_MS;
                const capturedMode = currentMode;
                setTimeout(() => {
                    // モード変更された場合はリセットをスキップ（新モードの状態を壊さない）
                    if (isScanning && currentMode === capturedMode) {
                        lastStabilityState = 'idle';
                        if (stabilityBarFill) {
                            stabilityBarFill.style.width = '0%';
                            stabilityBarFill.classList.remove('captured');
                        }
                        if (statusText) statusText.textContent = 'スキャン中';
                    }
                }, resetDelay);
            }
        } else {
            // 動きを検出 → カウンターリセット
            stabilityCounter = 0;
            // 重複一時停止中にカメラが動いたら解除
            if (isDuplicatePaused || duplicateCount > 0) {
                isDuplicatePaused = false;
                duplicateCount = 0;
                lastResultFingerprint = null;
                if (statusText) statusText.textContent = 'スキャン中';
                updateDupSkipBadge();
            }
            if (stabilityBarFill) {
                stabilityBarFill.style.width = '0%';
                stabilityBarFill.classList.remove('captured');
            }
            // テキストは変更しない（バーが0%に戻ることで動き検出を表現）
            lastStabilityState = 'moving';
        }
    }

    lastFrameData = currentFrameData;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// バウンディングボックス描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** オーバーレイCanvasをクリアする。 */
function clearOverlay() {
    if (!overlayCanvas) return;
    overlayCanvas.width = overlayCanvas.width;
}

/**
 * 検出結果のバウンディングボックスをオーバーレイCanvasに描画する。
 * テキストモード: 緑色の枠線（ラベル非表示）
 * 物体モード: 赤色の枠線＋ラベル表示
 *
 * @param {Array} data - [{label, bounds}, ...] 検出結果
 * @param {Array|null} imageSize - [width, height] テキストモードのピクセル基準サイズ
 */
function drawBoundingBoxes(data, imageSize) {
    clearOverlay();
    if (!videoContainer || !overlayCtx) return;

    const rect = videoContainer.getBoundingClientRect();
    overlayCanvas.width = rect.width;
    overlayCanvas.height = rect.height;

    // ターゲットボックスの表示領域（コンテナ基準、CSSの.target-boxと同期）
    const targetX = rect.width * (1 - TARGET_BOX_RATIO) / 2;  // 横: 中央寄せ
    const targetY = rect.height * TARGET_BOX_TOP;               // 縦: 上端10%
    const targetW = rect.width * TARGET_BOX_RATIO;
    const targetH = rect.height * TARGET_BOX_HEIGHT;

    const config = MODE_BOX_CONFIG[currentMode] || MODE_BOX_CONFIG.object;
    if (!config.color) return; // classify/webモードはバウンディングボックス描画なし
    const boxColor = config.color;
    const bgColor = config.bg;

    overlayCtx.lineWidth = 2;
    overlayCtx.font = '11px "Inter", "Noto Sans JP", sans-serif';

    data.forEach(item => {
        if (!item.bounds || item.bounds.length < 4) return;

        // 正規化座標（0〜1）に変換
        let normBounds;
        if (imageSize && imageSize[0] > 0 && imageSize[1] > 0) {
            // ピクセル座標 → 正規化座標（text, face, logo, label）
            normBounds = item.bounds.map(([x, y]) => [
                x / imageSize[0],
                y / imageSize[1],
            ]);
        } else {
            // 既に正規化座標（0〜1）（object）
            normBounds = item.bounds;
        }

        // ミラー反転時はX座標を反転
        if (isMirrored) {
            normBounds = normBounds.map(([nx, ny]) => [1 - nx, ny]);
        }

        // ターゲットボックス内のCanvas座標に変換
        const pts = normBounds.map(([nx, ny]) => [
            targetX + nx * targetW,
            targetY + ny * targetH,
        ]);

        // 矩形を描画
        overlayCtx.strokeStyle = boxColor;
        overlayCtx.beginPath();
        overlayCtx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
            overlayCtx.lineTo(pts[i][0], pts[i][1]);
        }
        overlayCtx.closePath();
        overlayCtx.stroke();

        // ラベル表示が有効なモードのみ（テキストモードは枠だけで十分）
        if (config.showLabel) {
            const labelText = item.label.length > LABEL_MAX_LENGTH
                ? item.label.substring(0, LABEL_MAX_LENGTH) + '…'
                : item.label;
            const metrics = overlayCtx.measureText(labelText);
            const labelX = pts[0][0];
            const labelY = pts[0][1] - 4;

            // ラベル背景
            overlayCtx.fillStyle = bgColor;
            overlayCtx.fillRect(labelX, labelY - 13, metrics.width + 6, 16);

            // ラベルテキスト
            overlayCtx.fillStyle = '#fff';
            overlayCtx.fillText(labelText, labelX + 3, labelY);
        }
    });
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 画像キャプチャ・API解析
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ターゲットボックス内の映像（または静止画）をキャプチャしてAPIに送信する。 */
async function captureAndAnalyze() {
    // 静止画モード: imageFeed の naturalWidth を使用、動画モード: video.videoWidth を使用
    const isImageSource = currentSource === 'image';
    const sourceEl = isImageSource ? imageFeed : video;
    const sourceW = isImageSource ? imageFeed.naturalWidth : video.videoWidth;
    const sourceH = isImageSource ? imageFeed.naturalHeight : video.videoHeight;

    if (!sourceW || isAnalyzing || isApiLimitReached()) return;
    isAnalyzing = true;
    clearOverlay();

    // ターゲットボックス内のみをクロップして送信（CSSの.target-boxと同期）
    const srcX = sourceW * (1 - TARGET_BOX_RATIO) / 2;  // 横: 中央寄せ
    const srcY = sourceH * TARGET_BOX_TOP;                // 縦: 上端10%
    const srcW = sourceW * TARGET_BOX_RATIO;
    const srcH = sourceH * TARGET_BOX_HEIGHT;

    // モード別に送信画像をリサイズ（通信量・トークン消費削減）
    const imgConfig = MODE_IMAGE_CONFIG[currentMode] || MODE_IMAGE_CONFIG.text;
    const netQ = getNetworkQualityMultiplier();

    // ネットワーク品質に応じた実効maxWidthを計算
    let effectiveMaxWidth = imgConfig.maxWidth;
    if (netQ.widthMultiplier < 1.0) {
        effectiveMaxWidth = effectiveMaxWidth
            ? Math.round(effectiveMaxWidth * netQ.widthMultiplier)   // 既存上限にネットワーク倍率を適用
            : Math.round(srcW * netQ.widthMultiplier);               // text/label: 低速時のみ元幅の倍率分に制限
    }

    let dstW = srcW;
    let dstH = srcH;
    if (effectiveMaxWidth && srcW > effectiveMaxWidth) {
        const scale = effectiveMaxWidth / srcW;
        dstW = Math.round(srcW * scale);
        dstH = Math.round(srcH * scale);
    }

    canvas.width = dstW;
    canvas.height = dstH;
    ctx.drawImage(sourceEl, srcX, srcY, srcW, srcH, 0, 0, dstW, dstH);

    // 画像ハッシュ比較: 前回送信した画像とほぼ同一ならAPI呼び出しをスキップ
    const currentHash = computeImageHash(canvas);
    if (lastSentImageHash) {
        const similarity = compareImageHash(currentHash, lastSentImageHash);
        if (similarity >= IMAGE_HASH_THRESHOLD) {
            console.log(`画像ハッシュ一致 (類似度: ${(similarity * 100).toFixed(1)}%) — API送信スキップ`);
            if (statusText) statusText.textContent = '前回と同じ画像のためスキップしました';
            isScanning = false;
            if (stabilityBarContainer) stabilityBarContainer.classList.add('hidden');
            _setBtnScanContent('📷', 'スタート');
            btnScan.disabled = false;
            if (videoContainer) videoContainer.classList.remove('scanning');
            if (statusDot) statusDot.classList.remove('active');
            return;
        }
    }

    const effectiveQuality = Math.max(0.3, imgConfig.quality * netQ.qualityMultiplier);
    const imageData = canvas.toDataURL('image/jpeg', effectiveQuality);

    // シングルショット: キャプチャ完了後、スキャンループを停止して解析待機状態に遷移
    isScanning = false;
    if (stabilityBarContainer) stabilityBarContainer.classList.add('hidden');
    _setBtnScanContent('⏳', '解析中');
    btnScan.disabled = true;
    if (videoContainer) videoContainer.classList.remove('scanning');
    if (statusDot) statusDot.classList.remove('active');

    let succeeded = false;

    try {
        // キーワードヒント: 入力欄の値をAPIリクエストに含める（空なら省略）
        const hintEl = document.getElementById('context-hint');
        const hint = hintEl ? hintEl.value.trim().slice(0, 200) : '';
        const response = await fetchWithRetry('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image: imageData,
                mode: currentMode,
                ...(hint && { hint }),
            }),
        });

        // JSONパース失敗に備えた安全なパース（413等でHTML応答の場合）
        let result;
        try {
            result = await response.json();
        } catch {
            if (statusText) statusText.textContent = `⚠ サーバーエラー (${response.status})`;
            return;
        }

        // サーバー側レート制限: 種別に応じたUI制御
        if (response.status === 429) {
            if (result.limit_type === 'daily') {
                // RPD（日次制限）: 翌日まで復旧しないためボタンを永続無効化
                if (statusText) statusText.textContent = `⚠ ${result.message || '本日のAPI上限に達しました'}`;
                disableScanButton('本日の上限に到達');
                return;
            }
            // RPM（分制限）: クールダウン後に自動復帰
            // サーバーから渡された具体的な待機秒数を使用（デフォルト10秒）
            const retryAfter = parseInt(result.retry_after || response.headers.get('Retry-After') || '10', 10);
            if (statusText) statusText.textContent = `⚠ ${result.message || 'リクエスト制限中'}`;
            startCooldownCountdown(retryAfter);
            return;
        }

        // 成功時のみカウント加算（失敗時はAPI消費しない）
        if (result.ok) {
            succeeded = true;
            lastSentImageHash = currentHash; // 成功時のみハッシュを保存（失敗時は再試行可能）
            apiCallCount++;
            saveApiUsage();

            // 重複検出: 同じ結果が連続したらカメラ移動まで一時停止
            const fingerprint = computeResultFingerprint(result);
            if (fingerprint && fingerprint === lastResultFingerprint) {
                duplicateCount++;
                if (duplicateCount >= DUPLICATE_SKIP_COUNT) {
                    isDuplicatePaused = true;
                    if (statusText) statusText.textContent = '同じ内容を検出済み ― カメラを動かしてください';
                }
            } else {
                // 新しい結果 → カウントリセット（初回を1としてカウント）
                duplicateCount = fingerprint ? 1 : 0;
            }
            if (fingerprint) lastResultFingerprint = fingerprint;
            updateDupSkipBadge();
        }

        // ラベルモード: OK/NG 判定結果を表示
        if (result.ok && currentMode === 'label') {
            const detected = result.label_detected;
            const reason = result.label_reason || '';
            addLabelResult(detected, reason);
            if (result.data && result.data.length > 0) {
                drawBoundingBoxes(result.data, result.image_size);
            }
        // 顔検出モード: 感情カード表示
        } else if (result.ok && currentMode === 'face') {
            if (result.data && result.data.length > 0) {
                drawBoundingBoxes(result.data, result.image_size);
                result.data.forEach(item => addFaceResult(item));
            } else {
                addNoResultMessage('顔が検出されませんでした');
            }
        // 分類タグモード: タグバッジ表示
        } else if (result.ok && currentMode === 'classify') {
            if (result.data && result.data.length > 0) {
                addClassifyResult(result.data);
            } else {
                addNoResultMessage('分類タグが検出されませんでした');
            }
        // Web類似検索モード: カード表示
        } else if (result.ok && currentMode === 'web') {
            addWebResult(result.web_detail || {}, result.data || []);
        // テキスト・物体・ロゴモード: 通常の結果表示
        } else if (result.ok && result.data && result.data.length > 0) {
            drawBoundingBoxes(result.data, result.image_size);
            result.data
                .filter(isValidResult)
                .forEach(addResultItem);
        } else if (!result.ok) {
            const errorMsg = result.message || `サーバーエラー (${result.error_code})`;
            if (statusText) statusText.textContent = `⚠ ${errorMsg}`;
            console.error(`APIエラー [${result.error_code}]:`, result.message);
        }
    } catch (err) {
        if (statusText) {
            if (err.name === 'AbortError') {
                statusText.textContent = '⚠ タイムアウト（応答に時間がかかりすぎました）';
            } else if (err._retriesExhausted) {
                statusText.textContent = '⚠ 通信エラー（再試行失敗 — ネットワークを確認してください）';
            } else {
                statusText.textContent = '⚠ 通信エラー';
            }
        }
        console.error('通信エラー:', err);
    } finally {
        isAnalyzing = false;
        // シングルショット: 解析完了、ボタンをスタートに戻す
        btnScan.disabled = false;
        _setBtnScanContent('▶', 'スタート');
        btnScan.classList.remove('scanning');
        if (succeeded && statusText) {
            statusText.textContent = '完了 ― スタートで再スキャン';
        }
    }
}

/**
 * エラー発生時の再試行スケジュール
 */
function scheduleRetry() {
    if (!isScanning && !isPausedByError) return; // 手動停止済みななら何もしない

    isScanning = false;
    isPausedByError = true;

    if (retryTimerId) clearTimeout(retryTimerId);

    retryTimerId = setTimeout(() => {
        retryTimerId = null;
        // まだエラー停止状態かつ手動停止されていなければ再開
        if (isPausedByError) {
            isScanning = true;
            isPausedByError = false;
            if (statusText) statusText.textContent = 'スキャン中';
            requestAnimationFrame(scanLoop);
        }
    }, RETRY_DELAY_MS);
}

/**
 * レート制限クールダウンのカウントダウンを表示する。
 * スキャンボタンを無効化し、安定化バーで残り時間を可視化する。
 * @param {number} seconds - クールダウン秒数（Retry-After ヘッダー値）
 */
function startCooldownCountdown(seconds) {
    // 既存のカウントダウンがあればクリア（連続429対応）
    stopCooldownCountdown();

    const totalSeconds = seconds;
    cooldownRemaining = seconds;

    // スキャンボタンを無効化してクールダウン中を明示
    if (btnScan) {
        btnScan.disabled = true;
        btnScan.style.opacity = '0.5';
        btnScan.style.cursor = 'not-allowed';
    }

    // 安定化バーをクールダウン進捗に転用（オレンジ色で100%→0%）
    if (stabilityBarContainer) stabilityBarContainer.classList.remove('hidden');
    if (stabilityBarFill) {
        stabilityBarFill.classList.remove('captured');
        stabilityBarFill.classList.add('cooldown');
        stabilityBarFill.style.width = '100%';
    }

    cooldownTimerId = setInterval(() => {
        cooldownRemaining--;
        if (cooldownRemaining <= 0) {
            stopCooldownCountdown();
            if (statusText) statusText.textContent = '準備完了 ― スタートで再スキャン';
        } else {
            // 進捗バーを減少（100% → 0%）
            const progress = (cooldownRemaining / totalSeconds) * 100;
            if (stabilityBarFill) stabilityBarFill.style.width = progress + '%';
            if (statusText) statusText.textContent = `⏳ リクエスト制限中... あと${cooldownRemaining}秒`;
        }
    }, 1000);
}

/** クールダウンカウントダウンを停止し、UIを復帰する。 */
function stopCooldownCountdown() {
    if (cooldownTimerId) {
        clearInterval(cooldownTimerId);
        cooldownTimerId = null;
    }
    cooldownRemaining = 0;

    // スキャンボタンを復帰
    if (btnScan) {
        btnScan.disabled = false;
        btnScan.style.opacity = '';
        btnScan.style.cursor = '';
    }

    // 安定化バーをリセット
    if (stabilityBarContainer) stabilityBarContainer.classList.add('hidden');
    if (stabilityBarFill) {
        stabilityBarFill.classList.remove('cooldown');
        stabilityBarFill.style.width = '0%';
    }

    // クールダウン中にボタンが押されていた場合は、自動的にスキャンを開始する
    if (shouldRestartAfterCooldown) {
        shouldRestartAfterCooldown = false;
        startScanning();
    }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 重複結果検出
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * API結果の「指紋」を生成する。同じ被写体なら同じ文字列を返す。
 * 結果が空やエラーの場合は null を返す（重複カウントしない）。
 * @param {Object} result - APIレスポンス
 * @returns {string|null} 結果の指紋文字列
 */
function computeResultFingerprint(result) {
    if (!result.ok) return null;

    // Web検索モード: best_guess をキーにする
    if (currentMode === 'web') {
        const detail = result.web_detail || {};
        return detail.best_guess || null;
    }

    // ラベル判定モード: OK/NG + 理由
    if (currentMode === 'label') {
        return `label:${result.label_detected}:${result.label_reason || ''}`;
    }

    // 共通: data 配列からラベルを抽出してソート結合
    if (!result.data || result.data.length === 0) return null;
    const labels = result.data
        .map(item => (item.label || '').trim())
        .filter(l => l.length > 0)
        .sort();
    return labels.length > 0 ? labels.join('|') : null;
}

/**
 * 重複スキップバッジの表示を更新する。
 * スキャン中のみ表示し、カウント中/一時停止中で見た目を切り替える。
 */
function updateDupSkipBadge() {
    if (!dupSkipBadge) return;

    if (!isScanning || duplicateCount === 0) {
        // スキャン停止中 or 初回 → 非表示
        dupSkipBadge.classList.add('hidden');
        dupSkipBadge.classList.remove('counting', 'paused');
        return;
    }

    dupSkipBadge.classList.remove('hidden');

    if (isDuplicatePaused) {
        // 一時停止中 → 赤系パルス
        dupSkipBadge.classList.remove('counting');
        dupSkipBadge.classList.add('paused');
        dupSkipBadge.textContent = '重複停止中';
        dupSkipBadge.title = `同じ内容を${duplicateCount}回連続検出 ― カメラを動かすと再開`;
    } else {
        // カウント中 → グレー表示
        dupSkipBadge.classList.remove('paused');
        dupSkipBadge.classList.add('counting');
        dupSkipBadge.textContent = `${duplicateCount}/${DUPLICATE_SKIP_COUNT}`;
        dupSkipBadge.title = `同じ内容を${duplicateCount}回連続検出中（${DUPLICATE_SKIP_COUNT}回でスキップ）`;
    }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 結果表示・フィルター
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ノイズや短すぎる結果を除外するフィルター。 */
function isValidResult(item) {
    const text = item.label || '';
    const cleaned = text.trim();
    // スコア付きラベルのモードは最小文字数フィルターをスキップ
    if (['object', 'face', 'logo'].includes(currentMode)) return cleaned.length > 0;
    if (cleaned.length < MIN_RESULT_LENGTH) return false;
    if (cleaned.startsWith('www.') || cleaned.startsWith('http')) return false;
    return true;
}

/** 検出結果をタイムスタンプ付きで結果リストに追加する。 */
function addResultItem(item) {
    const cleanText = (item.label || '').trim();
    if (!cleanText) return;

    const timeStr = new Date().toLocaleTimeString();

    // プレースホルダーを除去
    const placeholder = document.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.className = 'result-item';

    // XSS対策: innerHTML ではなく DOM操作でテキストを挿入する
    const timeSpan = document.createElement('span');
    timeSpan.className = 'timestamp';
    timeSpan.textContent = `[${timeStr}]`;

    const textNode = document.createTextNode(` ${cleanText}`);

    div.appendChild(timeSpan);
    div.appendChild(textNode);
    resultList.prepend(div);
}

/**
 * ラベル検出の OK/NG 結果を結果リストに追加する。
 * @param {boolean} detected - ラベルが検出されたか
 * @param {string} reason - 判定理由
 */
function addLabelResult(detected, reason) {
    const timeStr = new Date().toLocaleTimeString();
    const status = detected ? 'ok' : 'ng';
    const labelText = detected ? 'OK' : 'NG';

    // プレースホルダーを除去
    const placeholder = document.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    // XSS対策: DOM操作でテキストを挿入
    const div = document.createElement('div');
    div.className = `label-result ${status}`;

    const badge = document.createElement('span');
    badge.className = `label-badge ${status}`;
    badge.textContent = labelText;

    const detail = document.createElement('div');
    detail.className = 'label-detail';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'timestamp';
    timeSpan.textContent = `[${timeStr}]`;

    const reasonSpan = document.createElement('span');
    reasonSpan.className = 'reason';
    reasonSpan.textContent = reason;

    detail.appendChild(timeSpan);
    detail.appendChild(reasonSpan);
    div.appendChild(badge);
    div.appendChild(detail);
    resultList.prepend(div);
}

/**
 * 顔検出結果を結果リストに追加する（感情カード形式）。
 * @param {Object} item - {label, bounds, emotions, confidence}
 */
function addFaceResult(item) {
    const timeStr = new Date().toLocaleTimeString();
    const placeholder = document.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.className = 'face-result';

    // ヘッダー: タイムスタンプ + 確信度
    const header = document.createElement('div');
    header.className = 'face-header';
    const timeSpan = document.createElement('span');
    timeSpan.className = 'timestamp';
    timeSpan.textContent = `[${timeStr}]`;
    const confSpan = document.createElement('span');
    confSpan.className = 'face-confidence';
    confSpan.textContent = `確信度: ${(item.confidence * 100).toFixed(0)}%`;
    header.appendChild(timeSpan);
    header.appendChild(confSpan);

    // 感情グリッド（2x2）
    const grid = document.createElement('div');
    grid.className = 'emotion-grid';

    const emotionLabels = {
        joy: '喜び', sorrow: '悲しみ', anger: '怒り', surprise: '驚き',
    };
    const likelihoodLabels = {
        VERY_UNLIKELY: '非常に低い', UNLIKELY: '低い', POSSIBLE: 'あり得る',
        LIKELY: '高い', VERY_LIKELY: '非常に高い',
    };

    if (item.emotions) {
        Object.entries(item.emotions).forEach(([key, value]) => {
            const emoDiv = document.createElement('div');
            emoDiv.className = 'emotion-item';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = emotionLabels[key] || key;

            const levelSpan = document.createElement('span');
            levelSpan.className = 'emotion-level';
            levelSpan.textContent = likelihoodLabels[value] || value;
            if (value === 'LIKELY') levelSpan.classList.add('high');
            if (value === 'VERY_LIKELY') levelSpan.classList.add('very-high');

            emoDiv.appendChild(nameSpan);
            emoDiv.appendChild(levelSpan);
            grid.appendChild(emoDiv);
        });
    }

    div.appendChild(header);
    div.appendChild(grid);
    resultList.prepend(div);
}

/**
 * 分類タグ結果をタグバッジ形式で結果リストに追加する。
 * @param {Array} items - [{label, score}, ...]
 */
function addClassifyResult(items) {
    const timeStr = new Date().toLocaleTimeString();
    const placeholder = document.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    const wrapper = document.createElement('div');
    wrapper.className = 'result-item';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'timestamp';
    timeSpan.textContent = `[${timeStr}]`;
    wrapper.appendChild(timeSpan);

    const tagContainer = document.createElement('div');
    tagContainer.className = 'classify-result';

    items.forEach(item => {
        const tag = document.createElement('span');
        tag.className = 'classify-tag';

        const nameSpan = document.createElement('span');
        // "Laptop（ノートPC）- 98%" → "Laptop（ノートPC）" 部分のみ
        nameSpan.textContent = item.label.split(' - ')[0];

        const scoreSpan = document.createElement('span');
        scoreSpan.className = 'tag-score';
        scoreSpan.textContent = item.score ? `${(item.score * 100).toFixed(0)}%` : '';

        tag.appendChild(nameSpan);
        if (scoreSpan.textContent) tag.appendChild(scoreSpan);
        tagContainer.appendChild(tag);
    });

    wrapper.appendChild(tagContainer);
    resultList.prepend(wrapper);
}

/**
 * Web類似検索結果を結果リストに追加する。
 * @param {Object} webDetail - {best_guess, entities, pages, similar_images}
 * @param {Array} data - 統一データ形式（フォールバック用）
 */
function addWebResult(webDetail, data) {
    const timeStr = new Date().toLocaleTimeString();
    const placeholder = document.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.className = 'web-result';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'timestamp';
    timeSpan.textContent = `[${timeStr}]`;
    div.appendChild(timeSpan);

    // ベストゲス（推定名）
    if (webDetail.best_guess) {
        const guess = document.createElement('div');
        guess.className = 'web-best-guess';
        guess.textContent = `推定: ${webDetail.best_guess}`;
        div.appendChild(guess);
    }

    // エンティティ
    if (webDetail.entities && webDetail.entities.length > 0) {
        const title = document.createElement('div');
        title.className = 'web-section-title';
        title.textContent = '関連キーワード';
        div.appendChild(title);

        webDetail.entities.forEach(entity => {
            const entityDiv = document.createElement('div');
            entityDiv.className = 'web-entity';
            entityDiv.textContent = `${entity.name} (${(entity.score * 100).toFixed(0)}%)`;
            div.appendChild(entityDiv);
        });
    }

    // 関連ページ
    if (webDetail.pages && webDetail.pages.length > 0) {
        const title = document.createElement('div');
        title.className = 'web-section-title';
        title.textContent = '関連ページ';
        div.appendChild(title);

        webDetail.pages.forEach(page => {
            const link = document.createElement('a');
            link.className = 'web-link';
            link.href = page.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = page.title || page.url;
            link.title = page.url;
            div.appendChild(link);
        });
    }

    // 類似画像URL
    if (webDetail.similar_images && webDetail.similar_images.length > 0) {
        const title = document.createElement('div');
        title.className = 'web-section-title';
        title.textContent = '類似画像';
        div.appendChild(title);

        webDetail.similar_images.forEach(url => {
            const link = document.createElement('a');
            link.className = 'web-link';
            link.href = url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = url;
            div.appendChild(link);
        });
    }

    // 何も検出されなかった場合
    if (!webDetail.best_guess && (!webDetail.entities || webDetail.entities.length === 0)) {
        const empty = document.createElement('div');
        empty.className = 'web-entity';
        empty.textContent = 'Web上で一致する情報が見つかりませんでした';
        div.appendChild(empty);
    }

    resultList.prepend(div);
}

/**
 * 結果なしメッセージを表示する。
 * @param {string} message - 表示するメッセージ
 */
function addNoResultMessage(message) {
    const placeholder = document.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.className = 'result-item';
    const timeStr = new Date().toLocaleTimeString();

    const timeSpan = document.createElement('span');
    timeSpan.className = 'timestamp';
    timeSpan.textContent = `[${timeStr}]`;

    const textNode = document.createTextNode(` ${message}`);
    div.appendChild(timeSpan);
    div.appendChild(textNode);
    resultList.prepend(div);
}

/** 結果リストをクリアする。 */
function clearResults() {
    // XSS対策ポリシーの統一: innerHTML ではなく DOM API を使用
    while (resultList.firstChild) {
        resultList.removeChild(resultList.firstChild);
    }
    const placeholder = document.createElement('div');
    placeholder.className = 'placeholder-text';
    placeholder.textContent = 'スキャンして検出を開始...';
    resultList.appendChild(placeholder);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UI制御（ミラー・モード切替）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ミラー（左右反転）の状態をDOMに反映する。 */
function updateMirrorState() {
    if (videoContainer) videoContainer.classList.toggle('mirrored', isMirrored);
}

/** ミラー（左右反転）を切り替える。 */
function toggleMirror() {
    isMirrored = !isMirrored;
    updateMirrorState();
}

/** 検出モードを切り替える。 */
function setMode(mode) {
    currentMode = mode;
    // モード変更時に重複検出状態をリセット（新モードでは別の結果が返る）
    isDuplicatePaused = false;
    duplicateCount = 0;
    lastResultFingerprint = null;
    const allModes = {
        text: modeText, object: modeObject, label: modeLabel,
        face: modeFace, logo: modeLogo, classify: modeClassify, web: modeWeb,
    };
    Object.entries(allModes).forEach(([key, btn]) => {
        if (btn) btn.classList.toggle('active', mode === key);
    });
    clearResults();
    clearOverlay();
    // ヒント入力欄の placeholder をモードに合わせて切り替え
    const hintEl = document.getElementById('context-hint');
    if (hintEl) {
        hintEl.placeholder = MODE_HINT_PLACEHOLDER[mode] || MODE_HINT_PLACEHOLDER.text;
    }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 初期化
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** アプリケーションを初期化する。 */
function init() {
    // ─── DOM要素の取得（DOMContentLoaded 保証下で安全に取得） ──
    videoContainer = document.querySelector('.video-container');
    video = document.getElementById('video-feed');
    imageFeed = document.getElementById('image-feed');
    canvas = document.getElementById('capture-canvas');
    overlayCanvas = document.getElementById('overlay-canvas');
    resultList = document.getElementById('result-list');
    btnScan = document.getElementById('btn-scan');
    statusDot = document.getElementById('status-dot');
    statusText = document.getElementById('status-text');
    stabilityBarContainer = document.getElementById('stability-bar-container');
    stabilityBarFill = document.getElementById('stability-bar-fill');
    btnProxy = document.getElementById('btn-proxy');
    apiCounter = document.getElementById('api-counter');
    dupSkipBadge = document.getElementById('dup-skip-badge');
    cameraSelector = document.getElementById('camera-selector');
    btnCamera = document.getElementById('btn-camera');
    btnFile = document.getElementById('btn-file');
    btnFlipCam = document.getElementById('btn-flip-cam');
    modeText = document.getElementById('mode-text');
    modeObject = document.getElementById('mode-object');
    modeLabel = document.getElementById('mode-label');
    modeFace = document.getElementById('mode-face');
    modeLogo = document.getElementById('mode-logo');
    modeClassify = document.getElementById('mode-classify');
    modeWeb = document.getElementById('mode-web');
    const fileInput = document.getElementById('file-input');
    // 旧テンプレート互換: idが無い場合は既存クラスから取得
    const btnMirror = document.getElementById('btn-mirror')
        || document.querySelector('.video-tools .tool-btn');
    const btnClear = document.getElementById('btn-clear')
        || document.querySelector('.clear-btn');

    // 古いテンプレート/キャッシュ混在時のクラッシュ防止
    if (!canvas && videoContainer) {
        canvas = document.createElement('canvas');
        canvas.id = 'capture-canvas';
        canvas.className = 'hidden';
        videoContainer.appendChild(canvas);
    }
    if (!overlayCanvas && videoContainer) {
        overlayCanvas = document.createElement('canvas');
        overlayCanvas.id = 'overlay-canvas';
        videoContainer.appendChild(overlayCanvas);
    }

    ctx = canvas ? canvas.getContext('2d') : null;
    overlayCtx = overlayCanvas ? overlayCanvas.getContext('2d') : null;

    // ─── 必須要素チェック（video / btnScan のみ致命的） ──
    if (!video || !btnScan) {
        console.error('[init] 致命的: video または btnScan が見つかりません。');
        return;
    }

    // ─── イベントリスナー登録（全要素にnullガード付き） ──
    if (btnCamera) btnCamera.addEventListener('click', () => switchSource('camera'));
    if (cameraSelector) cameraSelector.addEventListener('change', (e) => switchCameraDevice(e.target.value));
    if (btnFile && fileInput) btnFile.addEventListener('click', () => fileInput.click());
    if (fileInput) fileInput.addEventListener('change', handleFileUpload);
    if (btnFlipCam) btnFlipCam.addEventListener('click', toggleFacingMode);
    if (btnMirror) btnMirror.addEventListener('click', toggleMirror);
    if (modeText) modeText.addEventListener('click', () => setMode('text'));
    if (modeObject) modeObject.addEventListener('click', () => setMode('object'));
    if (modeLabel) modeLabel.addEventListener('click', () => setMode('label'));
    if (modeFace) modeFace.addEventListener('click', () => setMode('face'));
    if (modeLogo) modeLogo.addEventListener('click', () => setMode('logo'));
    if (modeClassify) modeClassify.addEventListener('click', () => setMode('classify'));
    if (modeWeb) modeWeb.addEventListener('click', () => setMode('web'));
    btnScan.addEventListener('click', toggleScanning);
    if (btnClear) btnClear.addEventListener('click', clearResults);

    // ヘルプポップアップの開閉
    const btnHelp = document.getElementById('btn-help');
    const helpPopup = document.getElementById('help-popup');
    const btnHelpClose = document.getElementById('btn-help-close');
    if (btnHelp && helpPopup) {
        btnHelp.addEventListener('click', () => helpPopup.classList.toggle('hidden'));
        if (btnHelpClose) btnHelpClose.addEventListener('click', () => helpPopup.classList.add('hidden'));
        // ポップアップ外をクリックで閉じる
        document.addEventListener('click', (e) => {
            if (!helpPopup.classList.contains('hidden')
                && !helpPopup.contains(e.target)
                && e.target !== btnHelp) {
                helpPopup.classList.add('hidden');
            }
        });
        // Escキーで閉じる
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !helpPopup.classList.contains('hidden')) {
                helpPopup.classList.add('hidden');
            }
        });
    }

    // 重複スキップ回数スライダー
    const dupSlider = document.getElementById('duplicate-skip-count');
    const dupValue = document.getElementById('duplicate-skip-value');
    if (dupSlider) {
        // localStorageから保存値を復元
        const saved = localStorage.getItem('duplicateSkipCount');
        if (saved) {
            const parsed = parseInt(saved, 10);
            if (parsed >= 1 && parsed <= 5) {
                DUPLICATE_SKIP_COUNT = parsed;
                dupSlider.value = parsed;
            }
        }
        if (dupValue) dupValue.textContent = DUPLICATE_SKIP_COUNT + '回';

        dupSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            DUPLICATE_SKIP_COUNT = val;
            if (dupValue) dupValue.textContent = val + '回';
            localStorage.setItem('duplicateSkipCount', val);
            // 変更時に重複状態をリセット（新しい閾値を即座に反映）
            isDuplicatePaused = false;
            duplicateCount = 0;
        });
    }

    // 画面離脱時にカメラとスキャンを停止（LED点灯残り + API誤発火防止）
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (isScanning) stopScanning();
            stopCameraStream();
        }
    });

    setupCamera();
    updateMirrorState();
    loadApiUsage();
    // 初期設定を並列取得（片方が失敗しても他方に影響しない）
    // syncApiUsage: サーバーの実カウントでlocalStorage値を補正（NAT/マルチデバイス対応）
    Promise.allSettled([loadRateLimits(), loadProxyConfig(), syncApiUsage()]);
}

document.addEventListener('DOMContentLoaded', init);
