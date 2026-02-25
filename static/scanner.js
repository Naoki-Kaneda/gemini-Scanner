// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Vision AI Scanner - スキャン制御モジュール
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 役割: スキャン状態機械・安定化検出・API解析呼び出しを集約するモジュール。
// script.js からの ES Module 分割の一部として機能し、
// カメラ映像の安定化判定から Gemini API への画像送信・結果表示処理までを担う。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import {
    ScanState, SCAN_TRANSITIONS,
    STABILITY_THRESHOLD, MOTION_THRESHOLD, MOTION_CANVAS_WIDTH, MOTION_CANVAS_HEIGHT,
    IMAGE_HASH_SIZE, IMAGE_HASH_THRESHOLD,
    RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS,
    CAPTURE_RESET_DELAY_MS, LABEL_CAPTURE_RESET_DELAY_MS,
    CONTINUOUS_SCAN_INTERVAL_MS,
    MODE_IMAGE_CONFIG, MODE_HINT_PLACEHOLDER,
    DUPLICATE_SKIP_COUNT,
    TARGET_BOX_RATIO, TARGET_BOX_TOP, TARGET_BOX_HEIGHT,
    getNetworkQualityMultiplier,
} from './constants.js';

import {
    syncUI,
    setStatusMessage, resetStabilityBar, setStabilityBarState,
    showStabilityBar, setStabilityBarProgress, getStabilityBarFill,
    disableScanButton, clearOverlay, drawBoundingBoxes,
    updateDupSkipBadge, updateScanModeButton,
    isValidResult, addResultItem, addLabelResult, addFaceResult,
    addClassifyResult, addWebResult, addNoResultMessage, clearResults,
    setModeButtons,
} from './ui-manager.js';

import {
    fetchWithRetry, saveApiUsage, isApiLimitReached,
    incrementApiCallCount,
} from './api-client.js';

import {
    getVideo, getCanvas, getCtx, getImageFeed,
    getCurrentSource, isCameraMirrored,
} from './camera.js';


// ─────────────────────────────────────────────
// 1. モジュールスコープ変数
//    スキャン処理全体の状態を管理する変数群
// ─────────────────────────────────────────────

/** 現在のスキャン状態（ScanState 列挙値） */
let scanState = ScanState.IDLE;

/** 現在の解析モード（'text' / 'object' / 'label' / 'face' / 'logo' / 'classify' / 'web'） */
let currentMode = 'text';

/** ワンショットモードか連続スキャンモードか（true: ワンショット） */
let isSingleShot = true;

/** エラー発生時の自動再試行タイマーID */
let retryTimerId = null;

/** 連続エラー回数（指数バックオフの指数として使用） */
let consecutiveErrorCount = 0;

/** 連続スキャンのインターバル待機タイマーID */
let continuousDelayTimerId = null;

/** レート制限クールダウンタイマーID */
let cooldownTimerId = null;

/** クールダウン残り秒数（0 の場合はクールダウン中でない） */
let cooldownRemaining = 0;

/** クールダウン終了後に自動的にスキャンを再開するかどうか */
let shouldRestartAfterCooldown = false;

/** 前回 API に送信した画像のグレースケールハッシュ（重複送信防止用） */
let lastSentImageHash = null;

/** 直前の API 結果の指紋文字列（重複検出用） */
let lastResultFingerprint = null;

/** 同じ結果の連続回数 */
let duplicateCount = 0;

/** 前フレームのピクセルデータ（フレーム差分計算用） */
let lastFrameData = null;

/** 安定状態の連続フレームカウンター */
let stabilityCounter = 0;

/** トグル操作のチャタリング防止用タイムスタンプ */
let lastToggleTime = 0;

/** スキャンループのフレームカウンター（間引き処理に使用） */
let scanFrameCount = 0;

/** requestAnimationFrame のID（cancelAnimationFrame 用） */
let scanRafId = null;

/** 安定化バーの状態追跡（チラつき防止のため状態変更時のみ更新） */
let lastStabilityState = 'idle'; // 'idle' | 'stabilizing' | 'captured' | 'moving'

// ─── 差分検出用キャンバス（毎フレーム生成せず再利用してGC負荷を抑制） ───
const motionCanvas = document.createElement('canvas');
motionCanvas.width  = MOTION_CANVAS_WIDTH;
motionCanvas.height = MOTION_CANVAS_HEIGHT;
const motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });

// ─── 画像ハッシュ比較用キャンバス（8×8グレースケールに縮小して高速比較） ───
const hashCanvas = document.createElement('canvas');
hashCanvas.width  = IMAGE_HASH_SIZE;
hashCanvas.height = IMAGE_HASH_SIZE;
const hashCtx = hashCanvas.getContext('2d', { willReadFrequently: true });


// ─────────────────────────────────────────────
// 2. ゲッター関数
//    外部モジュールがスキャン状態を参照するためのアクセサー
// ─────────────────────────────────────────────

/**
 * 現在のスキャン状態を返す
 * @returns {string} ScanState 列挙値
 */
export function getScanState() { return scanState; }

/**
 * 現在の解析モードを返す
 * @returns {string} モード文字列（例: 'text', 'label'）
 */
export function getCurrentMode() { return currentMode; }

/**
 * ワンショットモードかどうかを返す
 * @returns {boolean} true: ワンショット、false: 連続スキャン
 */
export function getIsSingleShot() { return isSingleShot; }

/**
 * 現在の重複検出カウントを返す
 * @returns {number} 同じ結果の連続回数
 */
export function getDuplicateCount() { return duplicateCount; }


// ─────────────────────────────────────────────
// 3. 状態遷移
//    不正な遷移を検出・防止する状態機械の中核
// ─────────────────────────────────────────────

/**
 * スキャン状態を遷移させる。
 * SCAN_TRANSITIONS テーブルに定義されていない遷移は警告を出して拒否する。
 *
 * @param {string} newState - 遷移先の ScanState 値
 * @returns {boolean} 遷移に成功した場合 true、拒否された場合 false
 */
export function transitionTo(newState) {
    // 同一状態への遷移は冪等（エラーにしない）
    if (scanState === newState) return true;

    const allowed = SCAN_TRANSITIONS[scanState];
    if (!allowed || !allowed.includes(newState)) {
        console.warn(`不正な状態遷移: ${scanState} → ${newState}`);
        return false;
    }

    const prev = scanState;
    scanState  = newState;
    console.log(`状態遷移: ${prev} → ${newState}`);

    // 状態に応じた UI を一括同期する（ボタン・クラス・安定化バー）
    syncUI(newState);
    return true;
}


// ─────────────────────────────────────────────
// 4. 画像ハッシュ計算・比較（内部関数）
//    API 送信前に前回画像との類似度を比較して重複送信を防止する
// ─────────────────────────────────────────────

/**
 * Canvas 上の画像から 8×8 グレースケールハッシュを生成する。
 * ITU-R BT.601 輝度変換（0.299R + 0.587G + 0.114B）を適用する。
 *
 * @param {HTMLCanvasElement} srcCanvas - 描画済みのキャプチャキャンバス
 * @returns {Uint8Array} 64要素のグレースケール値配列（0〜255）
 */
function computeImageHash(srcCanvas) {
    hashCtx.drawImage(srcCanvas, 0, 0, IMAGE_HASH_SIZE, IMAGE_HASH_SIZE);
    const pixels = hashCtx.getImageData(0, 0, IMAGE_HASH_SIZE, IMAGE_HASH_SIZE).data;
    const gray   = new Uint8Array(IMAGE_HASH_SIZE * IMAGE_HASH_SIZE);

    for (let i = 0; i < gray.length; i++) {
        // ITU-R BT.601 輝度変換: 0.299R + 0.587G + 0.114B
        gray[i] = Math.round(
            pixels[i * 4]     * 0.299 +
            pixels[i * 4 + 1] * 0.587 +
            pixels[i * 4 + 2] * 0.114
        );
    }
    return gray;
}

/**
 * 2つの画像ハッシュの類似度を計算する（0.0〜1.0）。
 * 各ピクセルの差分の平均を 255 で正規化し、1 から引いて類似度に変換する。
 *
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


// ─────────────────────────────────────────────
// 5. 重複検出状態管理
// ─────────────────────────────────────────────

/**
 * 重複検出の状態をリセットする。
 * モード変更時やスキャン停止時に呼び出す。
 */
export function resetDuplicateState() {
    duplicateCount        = 0;
    lastResultFingerprint = null;
    updateDupSkipBadge(scanState, duplicateCount, DUPLICATE_SKIP_COUNT);
}


// ─────────────────────────────────────────────
// 6. スキャンモード切替
// ─────────────────────────────────────────────

/**
 * ワンショット/連続スキャンモードを切り替え、localStorage に保存する。
 */
export function toggleScanMode() {
    isSingleShot = !isSingleShot;
    localStorage.setItem('isSingleShot', isSingleShot ? '1' : '0');
    updateScanModeButton(isSingleShot);
}

/**
 * localStorage から保存済みのスキャンモードを復元してボタン表示に反映する。
 * DOMContentLoaded 後に一度呼び出すこと。
 */
export function restoreScanMode() {
    const saved = localStorage.getItem('isSingleShot');
    if (saved !== null) {
        // '0' のみ連続スキャン（false）、それ以外はワンショット（true）
        isSingleShot = saved !== '0';
    }
    updateScanModeButton(isSingleShot);
}


// ─────────────────────────────────────────────
// 7. スキャン開始/停止トグル
// ─────────────────────────────────────────────

/**
 * スキャンの開始/停止をトグルする。
 * チャタリング防止（300ms 未満の連打を無視）、解析中は無効化する。
 * クールダウン中にボタンが押された場合は終了後に自動開始するフラグを立てる。
 */
export function toggleScanning() {
    const now = Date.now();
    if (now - lastToggleTime < 300) return;
    lastToggleTime = now;

    // API 応答待ち中はトグル無効
    if (scanState === ScanState.ANALYZING) return;

    // クールダウン中: ボタン押下を記録して終了後に自動開始
    if (scanState === ScanState.COOLDOWN) {
        shouldRestartAfterCooldown = true;
        setStatusMessage('クールダウン終了後にスキャンを開始します');
        return;
    }

    // IDLE 以外（SCANNING / PAUSED_ERROR / PAUSED_DUPLICATE）なら停止
    if (scanState !== ScanState.IDLE) {
        stopScanning();
    } else {
        startScanning();
    }
}


// ─────────────────────────────────────────────
// 8. スキャン開始
// ─────────────────────────────────────────────

/**
 * スキャンを開始し、安定化検出ループを起動する。
 * API 日次上限に達している場合はボタンを無効化して終了する。
 * 静止画ソースの場合は安定化検出をスキップして即座に解析を実行する。
 */
export function startScanning() {
    // クライアント側の日次上限チェック
    if (isApiLimitReached()) {
        setStatusMessage('⚠ API上限に達しました（本日分）');
        disableScanButton('API上限（本日分）');
        return;
    }

    // IDLE → SCANNING（syncUI が自動でボタン・クラスを更新）
    if (!transitionTo(ScanState.SCANNING)) return;

    // 新規スキャン開始時に各カウンターをリセットする
    consecutiveErrorCount = 0;
    lastSentImageHash     = null;
    setStatusMessage('スキャン中');

    // 静止画モード: 安定化検出は不要 → 即座に解析を実行する
    const currentSource = getCurrentSource();
    if (currentSource === 'image') {
        showStabilityBar(false);
        setStatusMessage('解析中...');
        captureAndAnalyze();
        return;
    }

    // 動画・カメラモード: 安定化バーを表示してスキャンループを開始する
    showStabilityBar(true);
    resetStabilityBar();

    // フレームデータと安定性カウンターをリセットする（復帰直後の誤判定防止）
    scanFrameCount = 0;
    if (scanRafId) cancelAnimationFrame(scanRafId);
    scanRafId = requestAnimationFrame(scanLoop);
}


// ─────────────────────────────────────────────
// 9. スキャン停止
// ─────────────────────────────────────────────

/**
 * スキャンを即座に停止し、UIと内部状態を初期状態に戻す。
 * どの状態からでも呼び出し可能（強制 IDLE 遷移）。
 */
export function stopScanning() {
    // 強制リセット: どの状態からでも IDLE に戻す（通常の遷移制限を適用しない）
    scanState = ScanState.IDLE;
    syncUI(ScanState.IDLE);  // ボタン・バー・クラスを一括リセット

    // スキャンループを即座に停止する（次フレームの実行を防ぐ）
    if (scanRafId) {
        cancelAnimationFrame(scanRafId);
        scanRafId = null;
    }

    // 各タイマーをキャンセルする
    if (retryTimerId) {
        clearTimeout(retryTimerId);
        retryTimerId = null;
    }
    if (continuousDelayTimerId) {
        clearTimeout(continuousDelayTimerId);
        continuousDelayTimerId = null;
    }

    // クールダウンタイマーをキャンセルする
    stopCooldownCountdown();

    // オーバーレイのクリアとステータスメッセージ（コンテキスト固有）
    clearOverlay();
    setStatusMessage('準備完了');

    // 安定化関連の状態をリセットする
    lastFrameData    = null;
    stabilityCounter = 0;

    // 重複検出状態もリセットする
    duplicateCount        = 0;
    lastResultFingerprint = null;
    updateDupSkipBadge(scanState, duplicateCount, DUPLICATE_SKIP_COUNT);
}


// ─────────────────────────────────────────────
// 10. スキャンループ（requestAnimationFrame ベース）
// ─────────────────────────────────────────────

/**
 * requestAnimationFrame ベースのスキャンループ。
 * SCANNING または PAUSED_DUPLICATE 状態のときのみ動作する。
 * PAUSED_DUPLICATE 状態では 15フレームに1回に間引いてCPU負荷を軽減する。
 */
function scanLoop() {
    // SCANNING または PAUSED_DUPLICATE 以外なら即座にループを終了する
    if (scanState !== ScanState.SCANNING && scanState !== ScanState.PAUSED_DUPLICATE) {
        return;
    }

    scanFrameCount++;

    // PAUSED_DUPLICATE: 動き検出のみが必要、毎フレームは過剰なので間引く（約2fps@30fps）
    if (scanState === ScanState.PAUSED_DUPLICATE && scanFrameCount % 15 !== 0) {
        scanRafId = requestAnimationFrame(scanLoop);
        return;
    }

    checkStabilityAndCapture();
    scanRafId = requestAnimationFrame(scanLoop);
}


// ─────────────────────────────────────────────
// 11. フレーム安定化検出とキャプチャ
// ─────────────────────────────────────────────

/**
 * フレーム間の差分を計算して映像の安定状態を検出する。
 * 安定が一定フレーム数継続したらキャプチャ・解析を開始する。
 * 動き検出時は重複停止状態を解除してスキャンを再開する。
 *
 * statusText は状態変化のタイミングのみ更新する（チラつき防止）。
 * 進捗は安定化バーの幅でのみ表現する。
 */
function checkStabilityAndCapture() {
    const video = getVideo();
    // 映像が準備できていない場合はスキップする
    if (!video || video.readyState < video.HAVE_CURRENT_DATA) return;

    // 再利用キャンバスにフレームを縮小描画して差分計算コストを下げる
    motionCtx.drawImage(video, 0, 0, motionCanvas.width, motionCanvas.height);
    const currentFrameData = motionCtx.getImageData(
        0, 0, motionCanvas.width, motionCanvas.height
    ).data;

    if (lastFrameData) {
        // RGB 各チャンネルの差分を累積する（アルファチャンネルはスキップ）
        let diff = 0;
        for (let i = 0; i < currentFrameData.length; i += 4) {
            diff += Math.abs(currentFrameData[i]     - lastFrameData[i]);
            diff += Math.abs(currentFrameData[i + 1] - lastFrameData[i + 1]);
            diff += Math.abs(currentFrameData[i + 2] - lastFrameData[i + 2]);
        }
        const avgDiff = diff / (motionCanvas.width * motionCanvas.height);

        if (avgDiff < MOTION_THRESHOLD) {
            // 安定状態: カウンターを増やしてプログレスバーを更新する
            stabilityCounter++;
            const progress = Math.min((stabilityCounter / STABILITY_THRESHOLD) * 100, 100);

            // 安定化バーを更新する（captured クラスを除去して純粋な進捗として表示）
            const barFill = getStabilityBarFill();
            if (barFill) {
                barFill.style.width = progress + '%';
                barFill.classList.remove('captured');
            }
            lastStabilityState = 'stabilizing';

            if (stabilityCounter >= STABILITY_THRESHOLD) {
                // 重複一時停止中はキャプチャをスキップしてバーを100%で待機させる
                if (scanState === ScanState.PAUSED_DUPLICATE) {
                    stabilityCounter = STABILITY_THRESHOLD; // カウンターを最大値で固定する
                    return;
                }

                // 安定完了: キャプチャ・解析を開始する
                lastStabilityState = 'captured';
                setStabilityBarState('captured');
                setStatusMessage('解析中...');
                captureAndAnalyze();
                stabilityCounter = 0;

                // モードに応じた遅延後に安定化バーをリセットして次のスキャンに備える
                // label/web モードは結果確認と被写体入替の時間を多めに取る
                const resetDelay = ['label', 'web'].includes(currentMode)
                    ? LABEL_CAPTURE_RESET_DELAY_MS
                    : CAPTURE_RESET_DELAY_MS;
                const capturedMode = currentMode;

                setTimeout(() => {
                    // モードが変更されている場合はリセットしない（新モードの状態を壊さない）
                    if (scanState === ScanState.SCANNING && currentMode === capturedMode) {
                        lastStabilityState = 'idle';
                        resetStabilityBar();
                        setStatusMessage('スキャン中');
                    }
                }, resetDelay);
            }
        } else {
            // 動きを検出: カウンターをリセットしてバーを0%に戻す
            stabilityCounter = 0;

            // 重複一時停止中にカメラが動いた場合は停止状態を解除する
            if (scanState === ScanState.PAUSED_DUPLICATE || duplicateCount > 0) {
                if (scanState === ScanState.PAUSED_DUPLICATE) {
                    transitionTo(ScanState.SCANNING);
                }
                duplicateCount        = 0;
                lastResultFingerprint = null;
                setStatusMessage('スキャン中');
                updateDupSkipBadge(scanState, duplicateCount, DUPLICATE_SKIP_COUNT);
            }

            resetStabilityBar();
            lastStabilityState = 'moving';
        }
    }

    // 現在フレームを次回の比較基準として保持する
    lastFrameData = currentFrameData;
}


// ─────────────────────────────────────────────
// 12. 画像キャプチャと API 解析
// ─────────────────────────────────────────────

/**
 * ターゲットボックス内の映像（または静止画）をキャプチャして Gemini API に送信する。
 * 画像ハッシュ比較で前回と同一の画像はスキップする。
 * 成功時は結果を表示し、エラー時は自動再試行を予約する。
 *
 * finally ブロックの3分岐:
 *   1. 重複停止: _pendingDuplicatePause が true → PAUSED_DUPLICATE に遷移してループ継続
 *   2. 連続よみ: !isSingleShot && wasStreamingScan → SCANNING に遷移してインターバル後にループ再開
 *   3. ワンショット/静止画: IDLE に遷移してスキャン停止
 */
async function captureAndAnalyze() {
    // ─── ソース要素の取得と有効性チェック ───
    const isImageSource = getCurrentSource() === 'image';
    const imageEl  = getImageFeed();
    const videoEl  = getVideo();
    const sourceEl = isImageSource ? imageEl : videoEl;
    const sourceW  = isImageSource ? (imageEl ? imageEl.naturalWidth  : 0) : (videoEl ? videoEl.videoWidth  : 0);
    const sourceH  = isImageSource ? (imageEl ? imageEl.naturalHeight : 0) : (videoEl ? videoEl.videoHeight : 0);

    // 映像が準備できていない場合、解析中の場合、API上限の場合は即座に戻る
    if (!sourceW || scanState === ScanState.ANALYZING || isApiLimitReached()) return;

    // ANALYZING 状態に遷移してオーバーレイをクリアする
    transitionTo(ScanState.ANALYZING);
    clearOverlay();

    // ─── ターゲットボックス内のみをクロップして送信（CSSの .target-box と同期） ───
    // 横: 中央寄せ、縦: 上端から TARGET_BOX_TOP の位置から TARGET_BOX_HEIGHT の範囲
    const srcX = sourceW * (1 - TARGET_BOX_RATIO) / 2;
    const srcY = sourceH * TARGET_BOX_TOP;
    const srcW = sourceW * TARGET_BOX_RATIO;
    const srcH = sourceH * TARGET_BOX_HEIGHT;

    // ─── モード別・ネットワーク品質に応じたリサイズ処理 ───
    const imgConfig = MODE_IMAGE_CONFIG[currentMode] || MODE_IMAGE_CONFIG.text;
    const netQ      = getNetworkQualityMultiplier();

    // ネットワーク品質を考慮した実効最大幅を計算する
    let effectiveMaxWidth = imgConfig.maxWidth;
    if (netQ.widthMultiplier < 1.0) {
        // 既存の最大幅にネットワーク倍率を適用する、未設定なら元幅に倍率をかけて制限する
        effectiveMaxWidth = effectiveMaxWidth
            ? Math.round(effectiveMaxWidth * netQ.widthMultiplier)
            : Math.round(srcW * netQ.widthMultiplier);
    }

    let dstW = srcW;
    let dstH = srcH;
    if (effectiveMaxWidth && srcW > effectiveMaxWidth) {
        const scale = effectiveMaxWidth / srcW;
        dstW = Math.round(srcW * scale);
        dstH = Math.round(srcH * scale);
    }

    // キャンバスにクロップ＆リサイズして描画する
    const canvas = getCanvas();
    const ctx    = getCtx();
    canvas.width  = dstW;
    canvas.height = dstH;
    ctx.drawImage(sourceEl, srcX, srcY, srcW, srcH, 0, 0, dstW, dstH);

    // ─── 画像ハッシュ比較: 前回送信と同一ならスキップ ───
    const currentHash = computeImageHash(canvas);
    if (lastSentImageHash) {
        const similarity = compareImageHash(currentHash, lastSentImageHash);
        if (similarity >= IMAGE_HASH_THRESHOLD) {
            console.log(`画像ハッシュ一致 (類似度: ${(similarity * 100).toFixed(1)}%) — API送信スキップ`);
            setStatusMessage('前回と同じ画像のためスキップしました');

            // 連続よみモードのカメラスキャン: 停止せず被写体の変化を待つ
            if (!isSingleShot && getCurrentSource() === 'camera') {
                transitionTo(ScanState.SCANNING);
                stabilityCounter = 0;
                lastFrameData    = null;
                showStabilityBar(true);
                resetStabilityBar();
                scanRafId = requestAnimationFrame(scanLoop);
                return;
            }
            // ワンショットモード: 停止してUIをリセットする
            stopScanning();
            return;
        }
    }

    // ─── JPEG エンコードして送信準備 ───
    const effectiveQuality = Math.max(0.3, imgConfig.quality * netQ.qualityMultiplier);
    const imageData = canvas.toDataURL('image/jpeg', effectiveQuality);

    // カメラストリームからのスキャンだったかを記録する（エラー時の自動復帰判定用）
    const wasStreamingScan = (getCurrentSource() === 'camera');

    // ANALYZING 状態ではスキャンループは scanLoop() のガードで自動停止するため
    // ここで明示的にキャンセルして二重実行を防止する
    if (scanRafId) {
        cancelAnimationFrame(scanRafId);
        scanRafId = null;
    }

    // ボタン・安定化バー・scanning クラスは syncUI(ANALYZING) で設定済み

    /** API 成功フラグ（finally での完了メッセージ表示に使用） */
    let succeeded = false;
    /** finally で PAUSED_DUPLICATE に遷移するかどうかのフラグ */
    let _pendingDuplicatePause = false;

    try {
        // ─── キーワードヒントの取得（入力欄が空なら省略） ───
        const hintEl = document.getElementById('context-hint');
        const hint   = hintEl ? hintEl.value.trim().slice(0, 200) : '';

        // ─── API リクエスト送信（指数バックオフ付きリトライ） ───
        const response = await fetchWithRetry('/api/analyze', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image: imageData,
                mode:  currentMode,
                ...(hint && { hint }),
            }),
        });

        // ─── JSON パース（413等でHTML応答の場合に備えて安全にパースする） ───
        let result;
        try {
            result = await response.json();
        } catch {
            setStatusMessage(`⚠ サーバーエラー (${response.status})`);
            return;
        }

        // ─── サーバー側レート制限（429）の処理 ───
        if (response.status === 429) {
            if (result.limit_type === 'daily') {
                // RPD（日次制限）: 翌日まで復旧しないためボタンを永続無効化する
                setStatusMessage(`⚠ ${result.message || '本日のAPI上限に達しました'}`);
                disableScanButton('本日の上限に到達');
                return;
            }
            // RPM（分制限）: COOLDOWN 状態に遷移してカウントダウン後に自動復帰する
            const retryAfter = parseInt(
                result.retry_after || response.headers.get('Retry-After') || '10',
                10
            );
            setStatusMessage(`⚠ ${result.message || 'リクエスト制限中'}`);
            transitionTo(ScanState.COOLDOWN);
            startCooldownCountdown(retryAfter);
            return;
        }

        // ─── 成功時のカウント加算・重複検出処理 ───
        if (result.ok) {
            succeeded              = true;
            consecutiveErrorCount  = 0;       // 成功でエラーカウントをリセットする
            lastSentImageHash      = currentHash; // 成功時のみハッシュを保存（失敗時は再送可能）
            incrementApiCallCount();
            saveApiUsage();

            // 重複検出: 同じ結果が連続した場合は一時停止を予約する
            const fingerprint = computeResultFingerprint(result);
            if (fingerprint && fingerprint === lastResultFingerprint) {
                duplicateCount++;
                if (duplicateCount >= DUPLICATE_SKIP_COUNT) {
                    // finally での状態遷移をフラグで予約する（ANALYZING から直接 PAUSED_DUPLICATE に遷移できないため）
                    _pendingDuplicatePause = true;
                    setStatusMessage('同じ内容を検出済み ― カメラを動かしてください');
                }
            } else {
                // 新しい結果: カウントをリセット（初回検出を 1 としてカウント開始）
                duplicateCount = fingerprint ? 1 : 0;
            }
            if (fingerprint) lastResultFingerprint = fingerprint;
            updateDupSkipBadge(scanState, duplicateCount, DUPLICATE_SKIP_COUNT);
        }

        // ─── モード別の結果表示 ───

        // ラベルモード: OK/NG 判定結果とバウンディングボックスを表示する
        if (result.ok && currentMode === 'label') {
            const detected = result.label_detected;
            const reason   = result.label_reason || '';
            addLabelResult(detected, reason);
            if (result.data && result.data.length > 0) {
                drawBoundingBoxes(result.data, result.image_size, currentMode, isCameraMirrored());
            }

        // 顔検出モード: バウンディングボックスと感情カードを表示する
        } else if (result.ok && currentMode === 'face') {
            if (result.data && result.data.length > 0) {
                drawBoundingBoxes(result.data, result.image_size, currentMode, isCameraMirrored());
                result.data.forEach(item => addFaceResult(item));
            } else {
                addNoResultMessage('顔が検出されませんでした');
            }

        // 分類タグモード: タグバッジを表示する
        } else if (result.ok && currentMode === 'classify') {
            if (result.data && result.data.length > 0) {
                addClassifyResult(result.data);
            } else {
                addNoResultMessage('分類タグが検出されませんでした');
            }

        // Web 類似検索モード: 検索結果カードを表示する
        } else if (result.ok && currentMode === 'web') {
            addWebResult(result.web_detail || {}, result.data || []);

        // テキスト・物体・ロゴモード: バウンディングボックスと結果リストを表示する
        } else if (result.ok && result.data && result.data.length > 0) {
            drawBoundingBoxes(result.data, result.image_size, currentMode, isCameraMirrored());
            result.data
                .filter(item => isValidResult(item, currentMode))
                .forEach(addResultItem);

        // API エラー: エラーメッセージを表示する
        } else if (!result.ok) {
            const errorMsg = result.message || `サーバーエラー (${result.error_code})`;
            setStatusMessage(`⚠ ${errorMsg}`);
            console.error(`APIエラー [${result.error_code}]:`, result.message);
        }

    } catch (err) {
        // ─── 通信エラー処理 ───
        if (err.name === 'AbortError') {
            setStatusMessage('⚠ タイムアウト（応答に時間がかかりすぎました）');
        } else if (err._retriesExhausted) {
            setStatusMessage('⚠ 通信エラー（再試行失敗 — ネットワークを確認してください）');
        } else {
            setStatusMessage('⚠ 通信エラー');
        }
        console.error('通信エラー:', err);

        // カメラスキャン中のエラー: PAUSED_ERROR に遷移して自動復帰を予約する
        if (wasStreamingScan) {
            _pendingDuplicatePause = false; // エラー時は重複停止より復帰を優先する
            transitionTo(ScanState.PAUSED_ERROR);
            scheduleRetry();
        }

    } finally {
        // ─── finally: 次の状態への遷移処理（3分岐） ───
        // PAUSED_ERROR や COOLDOWN に遷移済みの場合はそのまま維持する
        // 各 transitionTo() が syncUI() を自動呼び出しするため、手動 UI 操作は不要
        if (scanState === ScanState.ANALYZING) {

            if (_pendingDuplicatePause && wasStreamingScan) {
                // 【分岐1】重複停止:
                // SCANNING 経由で PAUSED_DUPLICATE に遷移し、スキャンループを再開する
                // syncUI(PAUSED_DUPLICATE) が安定化バーの paused-duplicate 表示を自動設定
                transitionTo(ScanState.SCANNING);
                transitionTo(ScanState.PAUSED_DUPLICATE);
                scanRafId = requestAnimationFrame(scanLoop);

            } else if (!isSingleShot && wasStreamingScan) {
                // 【分岐2】連続よみモード:
                // SCANNING に遷移してインターバル後にスキャンループを再開する
                // syncUI(SCANNING) がボタンを「ストップ」に設定済み
                transitionTo(ScanState.SCANNING);
                // 安定化バーを「待機中」表示（青: インターバル中を視覚化）にする
                showStabilityBar(true);
                setStabilityBarState('interval-wait');
                setStatusMessage('完了 ― 次のスキャンまで待機中...');

                // インターバル後にループを再開する（手動停止でキャンセル可能）
                continuousDelayTimerId = setTimeout(() => {
                    continuousDelayTimerId = null;
                    // 手動停止済みの場合はループを再開しない
                    if (scanState !== ScanState.SCANNING) return;
                    resetStabilityBar();
                    stabilityCounter   = 0;
                    lastStabilityState = 'idle';
                    setStatusMessage('スキャン中');
                    scanRafId = requestAnimationFrame(scanLoop);
                }, CONTINUOUS_SCAN_INTERVAL_MS);

            } else {
                // 【分岐3】ワンショット / 静止画:
                // IDLE に遷移してスキャンを完全停止する（syncUI(IDLE) で自動 UI リセット）
                transitionTo(ScanState.IDLE);
            }
        }

        // 成功して IDLE に戻った場合は完了メッセージを表示する（コンテキスト固有）
        if (succeeded && scanState === ScanState.IDLE) {
            setStatusMessage('完了 ― スタートで再スキャン');
        }
    }
}


// ─────────────────────────────────────────────
// 13. エラー時の自動再試行スケジュール
// ─────────────────────────────────────────────

/**
 * PAUSED_ERROR 状態から自動復帰するタイマーをセットする。
 * 指数バックオフ + ジッターで連続エラー時のリトライ間隔を段階的に延ばす。
 * サンダリングハード問題を避けるためにジッター（0.75〜1.25）を付加する。
 */
function scheduleRetry() {
    // PAUSED_ERROR 状態でなければ何もしない（手動停止済み等のケース）
    if (scanState !== ScanState.PAUSED_ERROR) return;

    if (retryTimerId) clearTimeout(retryTimerId);

    consecutiveErrorCount++;
    // 指数バックオフ + ジッター: RETRY_BASE_DELAY × 2^(n-1) × [0.75, 1.25]
    const jitter = 0.75 + Math.random() * 0.5;
    const delay  = Math.min(
        RETRY_BASE_DELAY_MS * Math.pow(2, consecutiveErrorCount - 1) * jitter,
        RETRY_MAX_DELAY_MS
    );
    const delaySec = Math.ceil(delay / 1000);

    setStatusMessage(`⚠ エラー ― ${delaySec}秒後に再試行`);

    retryTimerId = setTimeout(() => {
        retryTimerId = null;
        // まだ PAUSED_ERROR 状態の場合のみ SCANNING に遷移してループを再開する
        if (scanState === ScanState.PAUSED_ERROR) {
            transitionTo(ScanState.SCANNING);
            setStatusMessage('スキャン中');
            if (scanRafId) cancelAnimationFrame(scanRafId);
            scanRafId = requestAnimationFrame(scanLoop);
        }
    }, delay);
}


// ─────────────────────────────────────────────
// 14. レート制限クールダウン表示
// ─────────────────────────────────────────────

/**
 * レート制限クールダウンのカウントダウンを開始する。
 * スキャンボタンを無効化し、安定化バーで残り時間を可視化する（100%→0%）。
 *
 * @param {number} seconds - クールダウン秒数（Retry-After ヘッダー値）
 */
function startCooldownCountdown(seconds) {
    // 既存のカウントダウンがあればクリアする（連続429対応）
    stopCooldownCountdown();

    const totalSeconds = seconds;
    cooldownRemaining  = seconds;

    // ボタン（disabled + dimmed）・安定化バー（cooldown 表示）は
    // transitionTo(COOLDOWN) → syncUI(COOLDOWN) で設定済み

    // 1秒ごとにカウントダウンして残り時間を更新する
    cooldownTimerId = setInterval(() => {
        cooldownRemaining--;
        if (cooldownRemaining <= 0) {
            stopCooldownCountdown();
            setStatusMessage('準備完了 ― スタートで再スキャン');
        } else {
            // バーの幅を残り時間に比例して減少させる
            const progress = (cooldownRemaining / totalSeconds) * 100;
            setStabilityBarProgress(progress);
            setStatusMessage(`⏳ リクエスト制限中... あと${cooldownRemaining}秒`);
        }
    }, 1000);
}

/**
 * クールダウンカウントダウンを停止してUIを復帰させる。
 * COOLDOWN 状態の場合は IDLE に遷移する。
 * クールダウン中にスタートが押されていた場合は自動的にスキャンを開始する。
 */
function stopCooldownCountdown() {
    const wasActive = cooldownTimerId !== null;

    if (cooldownTimerId) {
        clearInterval(cooldownTimerId);
        cooldownTimerId = null;
    }
    cooldownRemaining = 0;

    // 実際にカウントダウン中だった場合のみ IDLE に遷移する
    // （stopScanning() から呼ばれた場合は既に IDLE + syncUI 済みなので不要）
    if (wasActive && scanState === ScanState.COOLDOWN) {
        scanState = ScanState.IDLE;
        syncUI(ScanState.IDLE);
    }

    // クールダウン中にボタンが押されていた場合は自動的にスキャンを開始する
    if (shouldRestartAfterCooldown) {
        shouldRestartAfterCooldown = false;
        startScanning();
    }
}


// ─────────────────────────────────────────────
// 15. 結果指紋の計算（重複検出用）
// ─────────────────────────────────────────────

/**
 * API 結果の「指紋」文字列を生成する。
 * 同じ被写体なら同じ文字列を返す設計にすることで、連続スキャンでの重複を検出する。
 * 結果が空またはエラーの場合は null を返す（重複カウントしない）。
 *
 * @param {Object} result - API レスポンスオブジェクト
 * @returns {string|null} 指紋文字列（同じ内容なら同じ文字列）
 */
function computeResultFingerprint(result) {
    if (!result.ok) return null;

    // Web 検索モード: best_guess をキーにする（推定名が変わった場合のみ新規とみなす）
    if (currentMode === 'web') {
        const detail = result.web_detail || {};
        return detail.best_guess || null;
    }

    // ラベル判定モード: OK/NG + 判定理由を組み合わせる
    if (currentMode === 'label') {
        return `label:${result.label_detected}:${result.label_reason || ''}`;
    }

    // 共通: data 配列からラベルを抽出してソート結合する
    // 確信度（例: "- 95%"）を除去して名前のみで比較する
    // 検出数をプレフィックスに含めて、被写体が増減した場合を区別する
    if (!result.data || result.data.length === 0) return null;

    const labels = result.data
        .map(item => {
            let label = (item.label || '').trim();
            // "Apple - 95%" や "りんご（Apple）- 95%" の確信度部分を除去する
            label = label.replace(/\s*[-–]\s*\d+%\s*$/, '');
            return label.toLowerCase();
        })
        .filter(l => l.length > 0)
        .sort();

    if (labels.length === 0) return null;

    // 検出数プレフィックス + ラベル一覧で指紋を構成する
    return `n${labels.length}:${labels.join('|')}`;
}


// ─────────────────────────────────────────────
// 16. 解析モード切替
// ─────────────────────────────────────────────

/**
 * 解析モードを切り替えて関連UIを更新する。
 * モード変更時は重複検出状態とオーバーレイをリセットする。
 * PAUSED_DUPLICATE 状態の場合は SCANNING に戻す。
 *
 * @param {'text'|'object'|'label'|'face'|'logo'|'classify'|'web'} mode - 切り替え先のモード
 */
export function setMode(mode) {
    currentMode = mode;

    // モード変更時に重複停止状態を解除する（新モードでは別の結果が返るため）
    if (scanState === ScanState.PAUSED_DUPLICATE) {
        transitionTo(ScanState.SCANNING);
    }

    // 重複検出カウンターをリセットする
    duplicateCount        = 0;
    lastResultFingerprint = null;

    // モードボタンのアクティブ状態を更新する
    setModeButtons(mode);

    // 結果リストとオーバーレイをクリアする
    clearResults();
    clearOverlay();

    // ヒント入力欄の placeholder をモードに合わせて切り替える
    const hintEl = document.getElementById('context-hint');
    if (hintEl) {
        hintEl.placeholder = MODE_HINT_PLACEHOLDER[mode] || MODE_HINT_PLACEHOLDER.text;
    }
}
