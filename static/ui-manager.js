// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Vision AI Scanner - UI管理モジュール
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 役割: 全てのDOM操作・UI更新関数を集約するモジュール。
// script.js からの ES Module 分割の一部として機能し、
// DOM参照の取得から各種UI状態の更新まで一括管理する。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import {
    ScanState,
    MIN_RESULT_LENGTH,
    LABEL_MAX_LENGTH,
    API_WARNING_RATIO,
    ENFORCE_CLIENT_DAILY_LIMIT,
    MODE_BOX_CONFIG,
    TARGET_BOX_RATIO,
    TARGET_BOX_TOP,
    TARGET_BOX_HEIGHT,
} from './constants.js';

// ─────────────────────────────────────────────
// 1. モジュールスコープ変数（DOM参照）
//    initUI() 呼び出し後に有効になる
// ─────────────────────────────────────────────

/** 映像表示用 <video> 要素 */
let video;

/** バウンディングボックス描画用 <canvas> 要素 */
let overlayCanvas;

/** overlayCanvas の 2D 描画コンテキスト */
let overlayCtx;

/** 解析結果を一覧表示するリスト要素 */
let resultList;

/** スキャン開始/停止ボタン */
let btnScan;

/** ステータスインジケーターのドット要素 */
let statusDot;

/** ステータスメッセージのテキスト要素 */
let statusText;

/** 映像コンテナ（ミラー切替・scanning クラス制御に使用） */
let videoContainer;

/** 安定化バーのコンテナ要素 */
let stabilityBarContainer;

/** 安定化バーの塗りつぶし要素（幅とクラスで状態を表現） */
let stabilityBarFill;

/** プロキシ設定状態を示すバッジボタン */
let btnProxy;

/** API使用量カウンター表示要素 */
let apiCounter;

/** 重複スキップ状態バッジ */
let dupSkipBadge;

/** カメラ入力ソースボタン */
let btnCamera;

/** ファイル入力ソースボタン */
let btnFile;

/** カメラ前面/背面切替ボタン */
let btnFlipCam;

/** ワンショット/連続スキャン切替ボタン */
let btnScanMode;

/** テキスト認識モードボタン */
let modeText;

/** 物体検出モードボタン */
let modeObject;

/** ラベル検出モードボタン */
let modeLabel;

/** 顔検出モードボタン */
let modeFace;

/** ロゴ検出モードボタン */
let modeLogo;

/** 画像分類モードボタン */
let modeClassify;

/** Web類似検索モードボタン */
let modeWeb;


// ─────────────────────────────────────────────
// 2. 初期化・DOM参照取得
// ─────────────────────────────────────────────

/**
 * DOM要素を取得してモジュールスコープ変数に格納する。
 * DOMContentLoaded 以降、かつ他のUI関数を呼ぶ前に必ず実行すること。
 */
export function initUI() {
    videoContainer        = document.querySelector('.video-container');
    video                 = document.getElementById('video-feed');
    overlayCanvas         = document.getElementById('overlay-canvas');
    resultList            = document.getElementById('result-list');
    btnScan               = document.getElementById('btn-scan');
    statusDot             = document.getElementById('status-dot');
    statusText            = document.getElementById('status-text');
    stabilityBarContainer = document.getElementById('stability-bar-container');
    stabilityBarFill      = document.getElementById('stability-bar-fill');
    btnProxy              = document.getElementById('btn-proxy');
    apiCounter            = document.getElementById('api-counter');
    dupSkipBadge          = document.getElementById('dup-skip-badge');
    btnCamera             = document.getElementById('btn-camera');
    btnFile               = document.getElementById('btn-file');
    btnFlipCam            = document.getElementById('btn-flip-cam');
    btnScanMode           = document.getElementById('btn-scan-mode');
    modeText              = document.getElementById('mode-text');
    modeObject            = document.getElementById('mode-object');
    modeLabel             = document.getElementById('mode-label');
    modeFace              = document.getElementById('mode-face');
    modeLogo              = document.getElementById('mode-logo');
    modeClassify          = document.getElementById('mode-classify');
    modeWeb               = document.getElementById('mode-web');

    // オーバーレイ Canvas を動的生成（古いテンプレートとの互換性確保）
    if (!overlayCanvas && videoContainer) {
        overlayCanvas    = document.createElement('canvas');
        overlayCanvas.id = 'overlay-canvas';
        videoContainer.appendChild(overlayCanvas);
    }
    overlayCtx = overlayCanvas ? overlayCanvas.getContext('2d') : null;
}


// ─────────────────────────────────────────────
// 3. DOM参照ゲッター
//    他モジュールが必要とするDOM参照を公開する
// ─────────────────────────────────────────────

/** 映像 <video> 要素を返す */
export function getVideoElement() { return video; }

/** 映像コンテナ要素を返す */
export function getVideoContainer() { return videoContainer; }

/** スキャンボタン要素を返す */
export function getBtnScan() { return btnScan; }

/** カメラ前面/背面切替ボタン要素を返す */
export function getBtnFlipCam() { return btnFlipCam; }

/** カメラソースボタン要素を返す */
export function getBtnCamera() { return btnCamera; }

/** ファイルソースボタン要素を返す */
export function getBtnFile() { return btnFile; }


/** ステータスドット要素を返す */
export function getStatusDot() { return statusDot; }


// ─────────────────────────────────────────────
// 4. ステータスメッセージ
// ─────────────────────────────────────────────

/**
 * ステータステキストを更新する。
 * @param {string} text - 表示するメッセージ文字列
 */
export function setStatusMessage(text) {
    if (statusText) statusText.textContent = text;
}


// ─────────────────────────────────────────────
// 5. 安定化バーヘルパー
//    stabilityBarFill の width / classList を一括管理する
// ─────────────────────────────────────────────

/**
 * 安定化バーをリセットする（幅 0%・全状態クラス除去）。
 */
export function resetStabilityBar() {
    if (!stabilityBarFill) return;
    stabilityBarFill.style.width = '0%';
    stabilityBarFill.classList.remove('captured', 'cooldown', 'interval-wait', 'paused-duplicate');
}

/**
 * 安定化バーを特定の状態で表示する。
 * @param {'captured'|'cooldown'|'interval-wait'|'paused-duplicate'} state - 状態クラス名
 * @param {number} [widthPercent=100] - バーの幅（%）
 */
export function setStabilityBarState(state, widthPercent = 100) {
    if (!stabilityBarFill) return;
    stabilityBarFill.style.width = `${widthPercent}%`;
    stabilityBarFill.classList.remove('captured', 'cooldown', 'interval-wait', 'paused-duplicate');
    stabilityBarFill.classList.add(state);
}

/**
 * 安定化バーコンテナの表示/非表示を切り替える。
 * @param {boolean} visible - true で表示、false で非表示
 */
export function showStabilityBar(visible) {
    if (!stabilityBarContainer) return;
    stabilityBarContainer.classList.toggle('hidden', !visible);
}

/**
 * 安定化バーの幅をパーセントで設定する（進捗表示用）。
 * @param {number} percent - バー幅（0〜100）
 */
export function setStabilityBarProgress(percent) {
    if (!stabilityBarFill) return;
    stabilityBarFill.style.width = percent + '%';
}

/** 安定化バーの塗りつぶし要素を返す */
export function getStabilityBarFill() { return stabilityBarFill; }


// ─────────────────────────────────────────────
// 6. スキャンボタンUI
// ─────────────────────────────────────────────

/**
 * スキャンボタンの内容をDOM操作で安全に更新する（innerHTML不使用）。
 * アイコン <span> とラベル <span> を新規生成して差し替える。
 * @param {string} iconText  - アイコン文字列（例: '▶', '⏹'）
 * @param {string} labelText - ラベル文字列（例: 'スタート', 'ストップ'）
 */
export function setBtnScanContent(iconText, labelText) {
    if (!btnScan) return;

    // 既存の子要素を全て除去する
    while (btnScan.firstChild) btnScan.removeChild(btnScan.firstChild);

    const icon = document.createElement('span');
    icon.className = 'btn-icon';
    icon.textContent = iconText;

    const label = document.createElement('span');
    label.className = 'btn-label';
    label.textContent = labelText;

    btnScan.appendChild(icon);
    btnScan.appendChild(label);
}

/**
 * スキャンボタンを無効化する（API上限到達時などに使用）。
 * @param {string} message - ボタンに表示する理由メッセージ
 */
export function disableScanButton(message) {
    if (!btnScan) return;
    btnScan.disabled = true;
    setBtnScanContent('⚠', message);
    btnScan.style.opacity = '0.5';
    btnScan.style.cursor = 'not-allowed';
}


// ─────────────────────────────────────────────
// 7. APIカウンター表示
// ─────────────────────────────────────────────

/**
 * APIカウンター表示を更新する。
 * 使用量が警告閾値・上限に達した場合は色を変える。
 * circular dependency 回避のため、値は引数で受け取る方式を採用。
 *
 * @param {number} apiCallCount  - 現在のAPI呼び出し回数
 * @param {number} apiDailyLimit - 1日あたりの上限回数
 */
export function updateApiCounter(apiCallCount, apiDailyLimit) {
    if (!apiCounter) return;

    apiCounter.textContent = `API: ${apiCallCount}/${apiDailyLimit}`;

    if (apiCallCount >= apiDailyLimit) {
        // 上限到達: 赤色で警告
        apiCounter.style.color = '#ff3b3b';
    } else if (apiCallCount >= apiDailyLimit * API_WARNING_RATIO) {
        // 警告閾値超過: 橙色で注意喚起
        apiCounter.style.color = '#ffaa00';
    } else {
        // 通常状態: 色をリセット（日付リセット後の復帰にも対応）
        apiCounter.style.color = '';
    }

    // クライアント側強制制限が有効な場合のみボタンをロックする
    if (ENFORCE_CLIENT_DAILY_LIMIT && apiCallCount >= apiDailyLimit) {
        disableScanButton('API上限（本日分）');
    }
}


// ─────────────────────────────────────────────
// 8. プロキシボタン
// ─────────────────────────────────────────────

/**
 * プロキシ設定ボタンの表示を更新する（表示のみ、切替はCLI操作）。
 * @param {boolean} isEnabled - プロキシが有効な場合 true
 */
export function updateProxyButton(isEnabled) {
    if (!btnProxy) return;

    if (isEnabled) {
        btnProxy.textContent = 'Proxy設定: ON';
        btnProxy.className   = 'proxy-badge active';
    } else {
        btnProxy.textContent = 'Proxy設定: OFF';
        btnProxy.className   = 'proxy-badge inactive';
    }
}


// ─────────────────────────────────────────────
// 9. カメラ前面/背面切替ボタン
// ─────────────────────────────────────────────

/**
 * カメラ向きに応じて切替ボタンのテキストを更新する。
 * @param {'environment'|'user'} currentFacingMode - 現在のカメラ向き
 */
export function updateFlipButton(currentFacingMode) {
    if (!btnFlipCam) return;
    btnFlipCam.textContent = currentFacingMode === 'environment'
        ? '⟳ 外カメ'
        : '⟳ インカメ';
}


// ─────────────────────────────────────────────
// 10. 入力ソースボタン
// ─────────────────────────────────────────────

/**
 * 入力ソース（カメラ/ファイル）に応じてボタンのアクティブ状態を更新する。
 * スキャンモードボタンはカメラ入力時のみ表示する。
 * @param {'camera'|'file'|'image'} currentSource - 現在の入力ソース
 */
export function updateSourceButtons(currentSource) {
    if (btnCamera) btnCamera.classList.toggle('active', currentSource === 'camera');
    if (btnFile)   btnFile.classList.toggle('active', currentSource === 'file' || currentSource === 'image');
    // スキャンモードボタンはカメラ入力時のみ表示する
    if (btnScanMode) btnScanMode.classList.toggle('hidden', currentSource !== 'camera');
}


// ─────────────────────────────────────────────
// 11. スキャンモードボタン
// ─────────────────────────────────────────────

/**
 * スキャンモードボタンの表示をワンショット/連続スキャンで切り替える。
 * @param {boolean} isSingleShot - true: ワンショットモード、false: 連続スキャンモード
 */
export function updateScanModeButton(isSingleShot) {
    if (!btnScanMode) return;

    if (isSingleShot) {
        btnScanMode.textContent = '1x ワンショット';
        btnScanMode.title       = '連続よみに切替';
        btnScanMode.classList.remove('continuous-active');
    } else {
        btnScanMode.textContent = '∞ 連続よみ';
        btnScanMode.title       = 'ワンショットに切替';
        btnScanMode.classList.add('continuous-active');
    }
}


// ─────────────────────────────────────────────
// 12. ミラー（左右反転）状態
// ─────────────────────────────────────────────

/**
 * ミラー状態をDOMに反映する。
 * @param {boolean} isMirrored - true で左右反転を適用
 */
export function updateMirrorState(isMirrored) {
    if (videoContainer) videoContainer.classList.toggle('mirrored', isMirrored);
}


// ─────────────────────────────────────────────
// 13. 重複スキップバッジ
// ─────────────────────────────────────────────

/**
 * 重複スキップバッジの表示を更新する。
 * スキャン中のみ表示し、カウント中/一時停止中で見た目を切り替える。
 * circular dependency 回避のため、値は引数で受け取る方式を採用。
 *
 * @param {string} scanState         - 現在のスキャン状態（ScanState 値）
 * @param {number} duplicateCount    - 同じ結果の連続回数
 * @param {number} duplicateSkipCount - 一時停止するまでの閾値
 */
export function updateDupSkipBadge(scanState, duplicateCount, duplicateSkipCount) {
    if (!dupSkipBadge) return;

    const isActive = scanState === ScanState.SCANNING || scanState === ScanState.PAUSED_DUPLICATE;

    if (!isActive || duplicateCount === 0) {
        // スキャン停止中 または 初回検出前 → バッジを非表示にする
        dupSkipBadge.classList.add('hidden');
        dupSkipBadge.classList.remove('counting', 'paused');
        return;
    }

    dupSkipBadge.classList.remove('hidden');

    if (scanState === ScanState.PAUSED_DUPLICATE) {
        // 一時停止状態: 赤系パルスで警告表示する
        dupSkipBadge.classList.remove('counting');
        dupSkipBadge.classList.add('paused');
        dupSkipBadge.textContent = '重複停止中';
        dupSkipBadge.title       = `同じ内容を${duplicateCount}回連続検出 ― カメラを動かすと再開`;
    } else {
        // カウント中: グレー表示で進捗を示す
        dupSkipBadge.classList.remove('paused');
        dupSkipBadge.classList.add('counting');
        dupSkipBadge.textContent = `${duplicateCount}/${duplicateSkipCount}`;
        dupSkipBadge.title       = `同じ内容を${duplicateCount}回連続検出中（${duplicateSkipCount}回でスキップ）`;
    }
}


// ─────────────────────────────────────────────
// 14. モードボタン管理
// ─────────────────────────────────────────────

/**
 * 指定されたモードのボタンをアクティブ状態にし、他を非アクティブにする。
 * @param {'text'|'object'|'label'|'face'|'logo'|'classify'|'web'} activeMode - アクティブにするモード
 */
export function setModeButtons(activeMode) {
    const allModes = {
        text:     modeText,
        object:   modeObject,
        label:    modeLabel,
        face:     modeFace,
        logo:     modeLogo,
        classify: modeClassify,
        web:      modeWeb,
    };

    Object.entries(allModes).forEach(([key, btn]) => {
        if (btn) btn.classList.toggle('active', activeMode === key);
    });
}

/**
 * モードボタンのDOM参照辞書を返す。
 * イベントリスナーの登録など、外部から各ボタンに直接アクセスする際に使用する。
 * @returns {{ text: Element|null, object: Element|null, label: Element|null, face: Element|null, logo: Element|null, classify: Element|null, web: Element|null }}
 */
export function getModeButtons() {
    return {
        text:     modeText,
        object:   modeObject,
        label:    modeLabel,
        face:     modeFace,
        logo:     modeLogo,
        classify: modeClassify,
        web:      modeWeb,
    };
}


// ─────────────────────────────────────────────
// 15. オーバーレイCanvas操作
// ─────────────────────────────────────────────

/**
 * オーバーレイ Canvas をクリアする。
 * width を再代入することで全ピクセルをリセットする（ブラウザ標準の高速消去手法）。
 */
export function clearOverlay() {
    if (!overlayCanvas) return;
    // eslint-disable-next-line no-self-assign
    overlayCanvas.width = overlayCanvas.width;
}

/**
 * 解析結果のバウンディングボックスをオーバーレイ Canvas に描画する。
 * モードごとの色設定・ラベル表示/非表示を適用する。
 *
 * @param {Array}  data         - 描画するアイテム配列 [{label, bounds, ...}, ...]
 * @param {Array|null} imageSize - 元画像サイズ [width, height]（ピクセル座標変換用）
 * @param {string} currentMode  - 現在の解析モード（MODE_BOX_CONFIG のキー）
 * @param {boolean} isMirrored  - ミラー表示中の場合 true（X座標を反転する）
 */
export function drawBoundingBoxes(data, imageSize, currentMode, isMirrored) {
    clearOverlay();
    if (!videoContainer || !overlayCtx) return;

    // Canvas サイズをコンテナの実サイズに合わせる
    const rect           = videoContainer.getBoundingClientRect();
    overlayCanvas.width  = rect.width;
    overlayCanvas.height = rect.height;

    // ターゲットボックスの絶対座標を算出する（CSS変数由来の比率を使用）
    const targetX = rect.width  * (1 - TARGET_BOX_RATIO) / 2;
    const targetY = rect.height * TARGET_BOX_TOP;
    const targetW = rect.width  * TARGET_BOX_RATIO;
    const targetH = rect.height * TARGET_BOX_HEIGHT;

    // モード別描画設定を取得（未定義モードは object の設定にフォールバック）
    const config   = MODE_BOX_CONFIG[currentMode] || MODE_BOX_CONFIG.object;
    if (!config.color) return; // color が null のモード（classify/web）はボックス描画不要

    const boxColor = config.color;
    const bgColor  = config.bg;

    overlayCtx.lineWidth = 2;
    overlayCtx.font      = '11px "Inter", "Noto Sans JP", sans-serif';

    data.forEach(item => {
        if (!item.bounds || item.bounds.length < 4) return;

        // imageSize が有効な場合はピクセル座標→正規化座標に変換する
        let normBounds;
        if (imageSize && imageSize[0] > 0 && imageSize[1] > 0) {
            normBounds = item.bounds.map(([x, y]) => [
                x / imageSize[0],
                y / imageSize[1],
            ]);
        } else {
            // 既に正規化済みの場合はそのまま使用する
            normBounds = item.bounds;
        }

        // ミラー表示時は X 座標を左右反転する
        if (isMirrored) {
            normBounds = normBounds.map(([nx, ny]) => [1 - nx, ny]);
        }

        // 正規化座標をターゲットボックス内のキャンバス座標に変換する
        const pts = normBounds.map(([nx, ny]) => [
            targetX + nx * targetW,
            targetY + ny * targetH,
        ]);

        // バウンディングボックスを描画する
        overlayCtx.strokeStyle = boxColor;
        overlayCtx.beginPath();
        overlayCtx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
            overlayCtx.lineTo(pts[i][0], pts[i][1]);
        }
        overlayCtx.closePath();
        overlayCtx.stroke();

        // ラベルテキストを描画する（モード設定で有効な場合のみ）
        if (config.showLabel) {
            const labelText = item.label.length > LABEL_MAX_LENGTH
                ? item.label.substring(0, LABEL_MAX_LENGTH) + '…'
                : item.label;

            const metrics = overlayCtx.measureText(labelText);
            const labelX  = pts[0][0];
            const labelY  = pts[0][1] - 4;

            // ラベル背景を描画する（文字の視認性を確保）
            overlayCtx.fillStyle = bgColor;
            overlayCtx.fillRect(labelX, labelY - 13, metrics.width + 6, 16);

            // ラベルテキストを白色で描画する
            overlayCtx.fillStyle = '#fff';
            overlayCtx.fillText(labelText, labelX + 3, labelY);
        }
    });
}


// ─────────────────────────────────────────────
// 16. 結果表示フィルター
// ─────────────────────────────────────────────

/**
 * アイテムが有効な結果かどうかを判定するフィルター関数。
 * ノイズや短すぎる文字列、URLを除外する。
 *
 * @param {{ label: string }} item - 判定するアイテム
 * @param {string} currentMode    - 現在の解析モード
 * @returns {boolean} 有効な結果の場合 true
 */
export function isValidResult(item, currentMode) {
    const text    = item.label || '';
    const cleaned = text.trim();

    // スコア付きラベルのモードは最小文字数フィルターをスキップする
    if (['object', 'face', 'logo'].includes(currentMode)) return cleaned.length > 0;

    // 最小文字数チェック
    if (cleaned.length < MIN_RESULT_LENGTH) return false;

    // URL形式の文字列を除外する
    if (cleaned.startsWith('www.') || cleaned.startsWith('http')) return false;

    return true;
}


// ─────────────────────────────────────────────
// 17. 結果表示関数群
//    各モードに対応した結果カードをリストに追加する
// ─────────────────────────────────────────────

/**
 * 検出結果をタイムスタンプ付きで結果リストに追加する。
 * テキスト・物体・ロゴ等の汎用結果表示に使用する。
 * @param {{ label: string }} item - 表示するアイテム
 */
export function addResultItem(item) {
    const cleanText = (item.label || '').trim();
    if (!cleanText) return;

    const timeStr = new Date().toLocaleTimeString();

    // プレースホルダーが残っていれば除去する
    const placeholder = document.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.className = 'result-item';

    // XSS対策: innerHTML ではなく DOM操作でテキストを挿入する
    const timeSpan = document.createElement('span');
    timeSpan.className   = 'timestamp';
    timeSpan.textContent = `[${timeStr}]`;

    const textNode = document.createTextNode(` ${cleanText}`);

    div.appendChild(timeSpan);
    div.appendChild(textNode);
    resultList.prepend(div);
}

/**
 * ラベル検出の OK/NG 結果を結果リストに追加する。
 * @param {boolean} detected - ラベルが検出されたか
 * @param {string}  reason   - 判定理由テキスト
 */
export function addLabelResult(detected, reason) {
    const timeStr   = new Date().toLocaleTimeString();
    const status    = detected ? 'ok' : 'ng';
    const labelText = detected ? 'OK' : 'NG';

    // プレースホルダーが残っていれば除去する
    const placeholder = document.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    // XSS対策: DOM操作でテキストを挿入する
    const div = document.createElement('div');
    div.className = `label-result ${status}`;

    const badge = document.createElement('span');
    badge.className   = `label-badge ${status}`;
    badge.textContent = labelText;

    const detail = document.createElement('div');
    detail.className = 'label-detail';

    const timeSpan = document.createElement('span');
    timeSpan.className   = 'timestamp';
    timeSpan.textContent = `[${timeStr}]`;

    const reasonSpan = document.createElement('span');
    reasonSpan.className   = 'reason';
    reasonSpan.textContent = reason;

    detail.appendChild(timeSpan);
    detail.appendChild(reasonSpan);
    div.appendChild(badge);
    div.appendChild(detail);
    resultList.prepend(div);
}

/**
 * 顔検出結果を感情カード形式で結果リストに追加する。
 * @param {{ label: string, bounds: Array, emotions: Object, confidence: number }} item - 顔検出アイテム
 */
export function addFaceResult(item) {
    const timeStr = new Date().toLocaleTimeString();

    // プレースホルダーが残っていれば除去する
    const placeholder = document.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.className = 'face-result';

    // ヘッダー: タイムスタンプ + 確信度
    const header = document.createElement('div');
    header.className = 'face-header';

    const timeSpan = document.createElement('span');
    timeSpan.className   = 'timestamp';
    timeSpan.textContent = `[${timeStr}]`;

    const confSpan = document.createElement('span');
    confSpan.className   = 'face-confidence';
    confSpan.textContent = `確信度: ${(item.confidence * 100).toFixed(0)}%`;

    header.appendChild(timeSpan);
    header.appendChild(confSpan);

    // 感情グリッド（各感情の尤度を2列グリッドで表示）
    const grid = document.createElement('div');
    grid.className = 'emotion-grid';

    // 感情キーの日本語ラベル対応表
    const emotionLabels = {
        joy:      '喜び',
        sorrow:   '悲しみ',
        anger:    '怒り',
        surprise: '驚き',
    };

    // 尤度値の日本語ラベル対応表
    const likelihoodLabels = {
        VERY_UNLIKELY: '非常に低い',
        UNLIKELY:      '低い',
        POSSIBLE:      'あり得る',
        LIKELY:        '高い',
        VERY_LIKELY:   '非常に高い',
    };

    if (item.emotions) {
        Object.entries(item.emotions).forEach(([key, value]) => {
            const emoDiv = document.createElement('div');
            emoDiv.className = 'emotion-item';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = emotionLabels[key] || key;

            const levelSpan = document.createElement('span');
            levelSpan.className   = 'emotion-level';
            levelSpan.textContent = likelihoodLabels[value] || value;

            // 高尤度の場合は強調クラスを追加する
            if (value === 'LIKELY')      levelSpan.classList.add('high');
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
 * @param {Array<{ label: string, score: number }>} items - 分類アイテム配列
 */
export function addClassifyResult(items) {
    const timeStr = new Date().toLocaleTimeString();

    // プレースホルダーが残っていれば除去する
    const placeholder = document.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    const wrapper = document.createElement('div');
    wrapper.className = 'result-item';

    const timeSpan = document.createElement('span');
    timeSpan.className   = 'timestamp';
    timeSpan.textContent = `[${timeStr}]`;
    wrapper.appendChild(timeSpan);

    const tagContainer = document.createElement('div');
    tagContainer.className = 'classify-result';

    items.forEach(item => {
        const tag = document.createElement('span');
        tag.className = 'classify-tag';

        const nameSpan = document.createElement('span');
        // "Laptop（ノートPC）- 98%" → "Laptop（ノートPC）" 部分のみを表示する
        nameSpan.textContent = item.label.split(' - ')[0];

        const scoreSpan = document.createElement('span');
        scoreSpan.className   = 'tag-score';
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
 * @param {{ best_guess: string, entities: Array, pages: Array, similar_images: Array }} webDetail - Web検索詳細データ
 * @param {Array} data - 統一データ形式（フォールバック用）
 */
export function addWebResult(webDetail, data) {
    const timeStr = new Date().toLocaleTimeString();

    // プレースホルダーが残っていれば除去する
    const placeholder = document.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.className = 'web-result';

    const timeSpan = document.createElement('span');
    timeSpan.className   = 'timestamp';
    timeSpan.textContent = `[${timeStr}]`;
    div.appendChild(timeSpan);

    // ベストゲス（推定名）を表示する
    if (webDetail.best_guess) {
        const guess = document.createElement('div');
        guess.className   = 'web-best-guess';
        guess.textContent = `推定: ${webDetail.best_guess}`;
        div.appendChild(guess);
    }

    // 関連キーワード（エンティティ）を表示する
    if (webDetail.entities && webDetail.entities.length > 0) {
        const title = document.createElement('div');
        title.className   = 'web-section-title';
        title.textContent = '関連キーワード';
        div.appendChild(title);

        webDetail.entities.forEach(entity => {
            const entityDiv = document.createElement('div');
            entityDiv.className   = 'web-entity';
            entityDiv.textContent = `${entity.name} (${(entity.score * 100).toFixed(0)}%)`;
            div.appendChild(entityDiv);
        });
    }

    // 関連ページのリンクを表示する
    if (webDetail.pages && webDetail.pages.length > 0) {
        const title = document.createElement('div');
        title.className   = 'web-section-title';
        title.textContent = '関連ページ';
        div.appendChild(title);

        webDetail.pages.forEach(page => {
            const link = document.createElement('a');
            link.className   = 'web-link';
            link.href        = page.url;
            link.target      = '_blank';
            link.rel         = 'noopener noreferrer';
            link.textContent = page.title || page.url;
            link.title       = page.url;
            div.appendChild(link);
        });
    }

    // 類似画像URLのリンクを表示する
    if (webDetail.similar_images && webDetail.similar_images.length > 0) {
        const title = document.createElement('div');
        title.className   = 'web-section-title';
        title.textContent = '類似画像';
        div.appendChild(title);

        webDetail.similar_images.forEach(url => {
            const link = document.createElement('a');
            link.className   = 'web-link';
            link.href        = url;
            link.target      = '_blank';
            link.rel         = 'noopener noreferrer';
            link.textContent = url;
            div.appendChild(link);
        });
    }

    // 何も検出されなかった場合はフォールバックメッセージを表示する
    if (!webDetail.best_guess && (!webDetail.entities || webDetail.entities.length === 0)) {
        const empty = document.createElement('div');
        empty.className   = 'web-entity';
        empty.textContent = 'Web上で一致する情報が見つかりませんでした';
        div.appendChild(empty);
    }

    resultList.prepend(div);
}

/**
 * 結果なしメッセージを結果リストに追加する。
 * @param {string} message - 表示するメッセージ文字列
 */
export function addNoResultMessage(message) {
    // プレースホルダーが残っていれば除去する
    const placeholder = document.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.className = 'result-item';

    const timeStr = new Date().toLocaleTimeString();

    const timeSpan = document.createElement('span');
    timeSpan.className   = 'timestamp';
    timeSpan.textContent = `[${timeStr}]`;

    const textNode = document.createTextNode(` ${message}`);
    div.appendChild(timeSpan);
    div.appendChild(textNode);
    resultList.prepend(div);
}

/**
 * 結果リストをクリアし、初期プレースホルダーを表示する。
 * XSS対策ポリシーの統一として、innerHTML ではなく DOM API を使用する。
 */
export function clearResults() {
    // 既存の子要素を全て除去する
    while (resultList.firstChild) {
        resultList.removeChild(resultList.firstChild);
    }

    // 初期状態のプレースホルダーを生成して追加する
    const placeholder = document.createElement('div');
    placeholder.className   = 'placeholder-text';
    placeholder.textContent = 'スキャンして検出を開始...';
    resultList.appendChild(placeholder);
}


// ─────────────────────────────────────────────
// 18. スキャン状態のUI一括更新
// ─────────────────────────────────────────────

/**
 * スキャンのアクティブ/非アクティブ状態に応じてUIを一括更新する。
 * ボタン表示・scanning クラス・ステータスドットをまとめて切り替える。
 * @param {boolean} active - true でスキャン中UI、false で停止中UIに切り替える
 */
function setScanningUI(active) {
    if (active) {
        // スキャン中のUI状態に切り替える
        setBtnScanContent('⏹', 'ストップ');
        if (btnScan)        btnScan.classList.add('scanning');
        if (videoContainer) videoContainer.classList.add('scanning');
        if (statusDot)      statusDot.classList.add('active');
    } else {
        // 停止中のUI状態に切り替える
        setBtnScanContent('▶', 'スタート');
        if (btnScan)        btnScan.classList.remove('scanning');
        if (videoContainer) videoContainer.classList.remove('scanning');
        if (statusDot)      statusDot.classList.remove('active');
    }
}


// ─────────────────────────────────────────────
// 19. 状態ベース UI 同期
//     transitionTo() から自動的に呼ばれ、状態に応じた UI を一括適用する
// ─────────────────────────────────────────────

/**
 * スキャン状態に応じてUIを一括同期する。
 * transitionTo() の遷移成功時に自動的に呼ばれるため、
 * 個々の関数内でボタン状態やクラスを手動操作する必要がなくなる。
 *
 * 各状態の UI 定義:
 *   IDLE:             ▶ スタート, enabled, scanning OFF, bar hidden
 *   SCANNING:         ⏹ ストップ, enabled, scanning ON （bar はコンテキスト依存）
 *   ANALYZING:        ⏳ 解析中, disabled, scanning OFF, bar hidden
 *   PAUSED_ERROR:     ⏹ ストップ, enabled, scanning ON
 *   PAUSED_DUPLICATE: ⏹ ストップ, enabled, scanning ON, bar paused-duplicate
 *   COOLDOWN:         ⏳ 待機中, disabled + dimmed, scanning OFF, bar cooldown
 *
 * @param {string} state - ScanState 列挙値
 */
export function syncUI(state) {
    // ── COOLDOWN で付加された opacity/cursor をリセット ──
    if (btnScan) {
        btnScan.style.opacity = '';
        btnScan.style.cursor  = '';
    }

    switch (state) {
        case ScanState.IDLE:
            setScanningUI(false);
            if (btnScan) btnScan.disabled = false;
            showStabilityBar(false);
            resetStabilityBar();
            break;

        case ScanState.SCANNING:
            setScanningUI(true);
            if (btnScan) btnScan.disabled = false;
            // 安定化バーはコンテキスト依存（カメラ/静止画/連続スキャン）のため変更しない
            break;

        case ScanState.ANALYZING:
            setBtnScanContent('⏳', '解析中');
            if (btnScan)        { btnScan.disabled = true;  btnScan.classList.remove('scanning'); }
            if (videoContainer) videoContainer.classList.remove('scanning');
            if (statusDot)      statusDot.classList.remove('active');
            showStabilityBar(false);
            break;

        case ScanState.PAUSED_ERROR:
        case ScanState.PAUSED_DUPLICATE:
            // 一時停止中: ストップボタンを維持（ユーザーが手動停止できるように）
            setBtnScanContent('⏹', 'ストップ');
            if (btnScan) { btnScan.disabled = false; btnScan.classList.add('scanning'); }
            if (videoContainer) videoContainer.classList.add('scanning');
            if (statusDot)      statusDot.classList.add('active');
            if (state === ScanState.PAUSED_DUPLICATE) {
                showStabilityBar(true);
                setStabilityBarState('paused-duplicate');
            }
            break;

        case ScanState.COOLDOWN:
            setBtnScanContent('⏳', '待機中');
            if (btnScan) {
                btnScan.disabled      = true;
                btnScan.style.opacity = '0.5';
                btnScan.style.cursor  = 'not-allowed';
                btnScan.classList.remove('scanning');
            }
            if (videoContainer) videoContainer.classList.remove('scanning');
            if (statusDot)      statusDot.classList.remove('active');
            showStabilityBar(true);
            setStabilityBarState('cooldown');
            break;
    }
}
