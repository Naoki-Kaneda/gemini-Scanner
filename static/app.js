// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Vision AI Scanner - アプリケーションエントリポイント
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 定数・状態管理
import {
    initTargetBox,
    DUPLICATE_SKIP_COUNT,
    setDuplicateSkipCount,
    ScanState,
} from './constants.js';

// UI管理
import {
    initUI,
    getModeButtons,
    getBtnScan,
    setStatusMessage,
    updateMirrorState,
    clearResults,
} from './ui-manager.js';

// APIクライアント
import {
    loadApiUsage,
    loadRateLimits,
    loadProxyConfig,
    syncApiUsage,
} from './api-client.js';

// カメラ制御
import {
    initCamera,
    setupCamera,
    switchSource,
    switchCameraDevice,
    toggleFacingMode,
    toggleMirror,
    handleFileUpload,
    getCurrentSource,
    getCameraSelector,
} from './camera.js';

// スキャン制御
import {
    toggleScanning,
    toggleScanMode,
    setMode,
    stopScanning,
    getScanState,
    resetDuplicateState,
    restoreScanMode,
    getDuplicateCount,
    transitionTo,
} from './scanner.js';

/**
 * アプリケーション初期化関数
 * DOM参照の初期化、イベントリスナーの登録、起動時処理を行う
 */
function init() {
    // CSS変数からターゲットボックス寸法を読み取り
    initTargetBox();

    // 各モジュールのDOM参照を初期化
    initUI();
    initCamera();

    // 必須要素チェック
    const btnScan = getBtnScan();
    const video = document.getElementById('video-feed');
    if (!video || !btnScan) {
        console.error('[init] 致命的: video または btnScan が見つかりません。');
        return;
    }

    // ─── イベントリスナー登録 ──────────────────────────────────

    // 各ボタン要素の取得
    const btnCamera    = document.getElementById('btn-camera');
    const btnFile      = document.getElementById('btn-file');
    const fileInput    = document.getElementById('file-input');
    const btnFlipCam   = document.getElementById('btn-flip-cam');
    const btnScanMode  = document.getElementById('btn-scan-mode');
    const btnMirror    = document.getElementById('btn-mirror')
        || document.querySelector('.video-tools .tool-btn');
    const btnClear     = document.getElementById('btn-clear')
        || document.querySelector('.clear-btn');
    const cameraSelector = getCameraSelector();

    // ─── カメラ・ソース操作 ───────────────────────────────────

    // カメラソース切替ボタン
    if (btnCamera) {
        btnCamera.addEventListener('click', () => switchSource('camera'));
    }

    // カメラデバイス選択セレクター
    if (cameraSelector) {
        cameraSelector.addEventListener('change', (e) => switchCameraDevice(e.target.value));
    }

    // ファイル選択ボタン（input のクリックをトリガー）
    if (btnFile && fileInput) {
        btnFile.addEventListener('click', () => fileInput.click());
    }

    // ファイル入力変更時の処理
    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            // scanner依存を解消: IDLEでなければ停止してからファイル読み込み
            const state = getScanState();
            if (state !== ScanState.IDLE) stopScanning();
            // stopScanningは上で実行済みなのでコールバック引数はnullを渡す
            handleFileUpload(e, null);
        });
    }

    // フロント/バックカメラ切替ボタン
    if (btnFlipCam) {
        btnFlipCam.addEventListener('click', toggleFacingMode);
    }

    // スキャンモード（単発/連続）切替ボタン
    if (btnScanMode) {
        btnScanMode.addEventListener('click', toggleScanMode);
    }

    // ミラー表示切替ボタン
    if (btnMirror) {
        btnMirror.addEventListener('click', toggleMirror);
    }

    // ─── 解析モード切替ボタン ────────────────────────────────

    const modes = getModeButtons();
    Object.entries(modes).forEach(([key, btn]) => {
        if (btn) {
            btn.addEventListener('click', () => setMode(key));
        }
    });

    // ─── スキャン開始/停止ボタン ─────────────────────────────

    btnScan.addEventListener('click', toggleScanning);

    // ─── 結果クリアボタン ────────────────────────────────────

    if (btnClear) {
        btnClear.addEventListener('click', clearResults);
    }

    // ─── ヘルプポップアップ ──────────────────────────────────

    const btnHelp      = document.getElementById('btn-help');
    const helpPopup    = document.getElementById('help-popup');
    const btnHelpClose = document.getElementById('btn-help-close');

    if (btnHelp && helpPopup) {
        // ヘルプボタンでポップアップの表示/非表示を切替
        btnHelp.addEventListener('click', () => helpPopup.classList.toggle('hidden'));

        // 閉じるボタンでポップアップを非表示
        if (btnHelpClose) {
            btnHelpClose.addEventListener('click', () => helpPopup.classList.add('hidden'));
        }

        // ポップアップ外クリックで閉じる
        document.addEventListener('click', (e) => {
            if (
                !helpPopup.classList.contains('hidden')
                && !helpPopup.contains(e.target)
                && e.target !== btnHelp
            ) {
                helpPopup.classList.add('hidden');
            }
        });

        // Escapeキーでポップアップを閉じる
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !helpPopup.classList.contains('hidden')) {
                helpPopup.classList.add('hidden');
            }
        });
    }

    // ─── 重複スキップ回数スライダー ──────────────────────────

    const dupSlider = document.getElementById('duplicate-skip-count');
    const dupValue  = document.getElementById('duplicate-skip-value');

    if (dupSlider) {
        // localStorageから前回の設定値を復元
        const saved = localStorage.getItem('duplicateSkipCount');
        if (saved) {
            const parsed = parseInt(saved, 10);
            if (parsed >= 1 && parsed <= 5) {
                setDuplicateSkipCount(parsed);
                dupSlider.value = parsed;
            }
        }

        // スライダー横のラベルに現在値を表示
        if (dupValue) {
            dupValue.textContent = DUPLICATE_SKIP_COUNT + '回';
        }

        // スライダー操作時の処理
        dupSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            setDuplicateSkipCount(val);
            if (dupValue) dupValue.textContent = val + '回';
            localStorage.setItem('duplicateSkipCount', val);

            // 重複停止中ならスキャンを再開
            if (getScanState() === ScanState.PAUSED_DUPLICATE) {
                transitionTo(ScanState.SCANNING);
            }
            resetDuplicateState();
        });
    }

    // ─── 連続よみ設定の復元 ──────────────────────────────────

    // localStorageに保存されたスキャンモード（単発/連続）を復元
    restoreScanMode();

    // ─── 画面離脱/復帰ハンドラ ──────────────────────────────

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            // 画面が非表示になったらスキャンのみ停止（カメラは維持）
            if (getScanState() !== ScanState.IDLE) stopScanning();
        }
        // カメラストリームは停止しない — タブ復帰時の再起動も不要
    });

    // ─── 起動時の初期化 ──────────────────────────────────────

    // カメラストリームの起動
    setupCamera();

    // ミラー表示の初期値をfalse（通常表示）に設定
    updateMirrorState(false);

    // API使用量・レート制限・プロキシ設定の読み込み
    loadApiUsage();
    Promise.allSettled([loadRateLimits(), loadProxyConfig(), syncApiUsage()]);
}

// ─── DOMContentLoaded で確実に初期化 ────────────────────────────
// ES Module は <script type="module"> により自動的に defer されるため
// DOM解析完了後に実行されるが、DOMContentLoaded を念のため保険として使用
document.addEventListener('DOMContentLoaded', init);
