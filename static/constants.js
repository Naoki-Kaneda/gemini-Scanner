// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Vision AI Scanner - 定数・設定モジュール
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ─────────────────────────────────────────────
// 1. 設定定数
//    アプリ全体で使用する数値・フラグの定義
// ─────────────────────────────────────────────

/** 1日あたりのAPI利用上限（サーバー側の設定と合わせること） */
export let API_DAILY_LIMIT = 1000;

/** 警告を表示するAPI使用率の閾値（例: 0.8 = 80%以上で警告） */
export const API_WARNING_RATIO = 0.8;

/** 「静止」と判断するまでに必要な連続安定フレーム数 */
export const STABILITY_THRESHOLD = 20;

/** フレーム差分がこの値を超えると「動きあり」と判定する閾値 */
export const MOTION_THRESHOLD = 30;

/** モーション検出用の縮小キャンバス幅（ピクセル） */
export const MOTION_CANVAS_WIDTH = 64;

/** モーション検出用の縮小キャンバス高さ（ピクセル） */
export const MOTION_CANVAS_HEIGHT = 48;

/** カメラ映像の要求解像度 - 幅（ピクセル） */
export const CAMERA_WIDTH = 1280;

/** カメラ映像の要求解像度 - 高さ（ピクセル） */
export const CAMERA_HEIGHT = 720;

/** 有効な解析結果と判断する最小文字数 */
export const MIN_RESULT_LENGTH = 5;

/** ラベル表示時の最大文字数（これを超えると切り詰める） */
export const LABEL_MAX_LENGTH = 25;

/** リトライ時の初回待機時間（ミリ秒） */
export const RETRY_BASE_DELAY_MS = 5000;

/** リトライ時の最大待機時間（ミリ秒） */
export const RETRY_MAX_DELAY_MS = 60000;

/** 解析完了後、次のキャプチャ開始までのリセット待機時間（ミリ秒） */
export const CAPTURE_RESET_DELAY_MS = 3000;

/** ラベルモード専用のキャプチャリセット待機時間（ミリ秒） */
export const LABEL_CAPTURE_RESET_DELAY_MS = 3000;

/** 連続スキャンモードでのAPIコール間隔（ミリ秒） */
export const CONTINUOUS_SCAN_INTERVAL_MS = 3000;

/** クライアント側で日次制限を強制するかどうか（true にすると制限を適用） */
export const ENFORCE_CLIENT_DAILY_LIMIT = false;

/** fetch リクエストのタイムアウト時間（ミリ秒） */
export const FETCH_TIMEOUT_MS = 60000;

/** 同一結果が何回連続したらスキップするかの閾値 */
export let DUPLICATE_SKIP_COUNT = 2;

/** 画像ハッシュ計算に使用するグリッドサイズ（N×N ピクセル） */
export const IMAGE_HASH_SIZE = 8;

/** 画像ハッシュの一致率がこの値以上なら「同一画像」と判定する閾値（0.0 〜 1.0） */
export const IMAGE_HASH_THRESHOLD = 0.95;

// ─────────────────────────────────────────────
// 2. let 定数のセッター関数
//    外部モジュールから設定値を動的に変更するための関数
// ─────────────────────────────────────────────

/**
 * API_DAILY_LIMIT を更新する
 * @param {number} val - 新しい日次上限値
 */
export function setApiDailyLimit(val) { API_DAILY_LIMIT = val; }

/**
 * DUPLICATE_SKIP_COUNT を更新する
 * @param {number} val - 新しい重複スキップ回数
 */
export function setDuplicateSkipCount(val) { DUPLICATE_SKIP_COUNT = val; }

// ─────────────────────────────────────────────
// 3. CSS変数読み取り関数とターゲットボックス設定
//    CSS カスタムプロパティから動的にレイアウト値を取得する
// ─────────────────────────────────────────────

/**
 * CSS カスタムプロパティをパーセント値として読み取り、0〜1 の小数に変換する
 * @param {string} prop     - CSS プロパティ名（例: '--target-box-width'）
 * @param {number} fallback - 読み取れなかった場合のデフォルト値（0〜1）
 * @returns {number} 0〜1 の小数値
 */
function _readCssPercent(prop, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n / 100 : fallback;
}

/** ターゲットボックスの幅の割合（0〜1）。initTargetBox() で更新される */
export let TARGET_BOX_RATIO = 0.98;

/** ターゲットボックスの上端位置の割合（0〜1）。initTargetBox() で更新される */
export let TARGET_BOX_TOP = 0.01;

/** ターゲットボックスの高さの割合（0〜1）。initTargetBox() で更新される */
export let TARGET_BOX_HEIGHT = 0.97;

/**
 * CSS カスタムプロパティからターゲットボックスの寸法を初期化する
 * DOM が準備できた後に呼び出すこと（DOMContentLoaded 以降を推奨）
 */
export function initTargetBox() {
    TARGET_BOX_RATIO  = _readCssPercent('--target-box-width',  0.98);
    TARGET_BOX_TOP    = _readCssPercent('--target-box-top',    0.01);
    TARGET_BOX_HEIGHT = _readCssPercent('--target-box-height', 0.97);
}

// ─────────────────────────────────────────────
// 4. モード別設定オブジェクト
//    各解析モードの画像キャプチャ・描画・UIのパラメーター
// ─────────────────────────────────────────────

/**
 * モード別の画像キャプチャ設定
 * - maxWidth: 送信前のリサイズ上限（null = オリジナルサイズ）
 * - quality:  JPEG圧縮品質（0.0 〜 1.0）
 */
export const MODE_IMAGE_CONFIG = {
    text:     { maxWidth: null, quality: 0.95 },
    label:    { maxWidth: null, quality: 0.95 },
    face:     { maxWidth: 800,  quality: 0.85 },
    logo:     { maxWidth: 800,  quality: 0.85 },
    object:   { maxWidth: 640,  quality: 0.80 },
    classify: { maxWidth: 640,  quality: 0.80 },
    web:      { maxWidth: 640,  quality: 0.80 },
};

/**
 * モード別のバウンディングボックス描画設定
 * - color:     ボックス枠線の色（CSS カラー文字列）
 * - bg:        ラベル背景色（rgba 推奨）
 * - showLabel: ラベルテキストをボックス上に表示するかどうか
 */
export const MODE_BOX_CONFIG = {
    text:     { color: '#00ff88', bg: 'rgba(0, 255, 136, 0.7)',   showLabel: false },
    object:   { color: '#ff3b3b', bg: 'rgba(255, 59, 59, 0.7)',   showLabel: true  },
    face:     { color: '#00bfff', bg: 'rgba(0, 191, 255, 0.7)',   showLabel: true  },
    logo:     { color: '#d4bee6', bg: 'rgba(212, 190, 230, 0.7)', showLabel: true  },
    label:    { color: '#00ff88', bg: 'rgba(0, 255, 136, 0.7)',   showLabel: false },
    classify: { color: null,      bg: null,                        showLabel: false },
    web:      { color: null,      bg: null,                        showLabel: false },
};

/**
 * モード別のヒント入力プレースホルダーテキスト
 * ユーザーにヒント入力欄の使い方を示す例文
 */
export const MODE_HINT_PLACEHOLDER = {
    text:     'ヒント例: 賞味期限を探して、英語を翻訳して',
    object:   'ヒント例: 食品だけ検出して、危険物を探して',
    label:    'ヒント例: バーコードを読み取って、商品名を特定して',
    face:     'ヒント例: 年齢も推定して、表情を詳しく分析して',
    logo:     'ヒント例: ブランド名を特定して',
    classify: 'ヒント例: 料理のジャンルを判定して',
    web:      'ヒント例: この建物は何？、この絵の作者は？',
};

// ─────────────────────────────────────────────
// 5. ScanState 列挙型と状態遷移テーブル
//    スキャン処理のライフサイクル管理に使用する
// ─────────────────────────────────────────────

/**
 * スキャン処理の状態を表す列挙型（イミュータブル）
 * - IDLE:             待機中（スキャン未開始）
 * - SCANNING:         カメラ映像を監視中・安定性チェック中
 * - ANALYZING:        APIリクエストを送信してレスポンス待ち
 * - PAUSED_ERROR:     エラー発生によるスキャン一時停止
 * - PAUSED_DUPLICATE: 重複結果検出によるスキャン一時停止
 * - COOLDOWN:         クールダウン期間中（連続スキャン抑制）
 */
export const ScanState = Object.freeze({
    IDLE:              'IDLE',
    SCANNING:          'SCANNING',
    ANALYZING:         'ANALYZING',
    PAUSED_ERROR:      'PAUSED_ERROR',
    PAUSED_DUPLICATE:  'PAUSED_DUPLICATE',
    COOLDOWN:          'COOLDOWN',
});

/**
 * 各状態から遷移可能な次の状態の一覧（許可された遷移のみ定義）
 * 不正な状態遷移の検出・防止に使用する
 */
export const SCAN_TRANSITIONS = Object.freeze({
    IDLE:              ['SCANNING'],
    SCANNING:          ['IDLE', 'ANALYZING', 'PAUSED_DUPLICATE'],
    ANALYZING:         ['IDLE', 'SCANNING', 'PAUSED_ERROR', 'PAUSED_DUPLICATE', 'COOLDOWN'],
    PAUSED_ERROR:      ['IDLE', 'SCANNING'],
    PAUSED_DUPLICATE:  ['IDLE', 'SCANNING'],
    COOLDOWN:          ['IDLE', 'SCANNING'],
});

// ─────────────────────────────────────────────
// 6. ネットワーク品質判定
//    Network Information API を利用して接続品質を評価し、
//    画像サイズ・品質のスケーリング係数を返す
// ─────────────────────────────────────────────

/**
 * 現在のネットワーク接続品質に基づいて画像スケーリング係数を返す
 * Network Information API 非対応ブラウザでは常に最高品質を返す
 *
 * @returns {{ widthMultiplier: number, qualityMultiplier: number }}
 *   - widthMultiplier:   画像幅に掛ける係数（0.0 〜 1.0）
 *   - qualityMultiplier: JPEG品質に掛ける係数（0.0 〜 1.0）
 */
export function getNetworkQualityMultiplier() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

    // Network Information API が利用できない場合は最高品質で返す
    if (!conn) return { widthMultiplier: 1.0, qualityMultiplier: 1.0 };

    // データセーバーモードが有効な場合は最低品質にする
    if (conn.saveData) return { widthMultiplier: 0.5, qualityMultiplier: 0.6 };

    // 実効的な接続タイプに応じて係数を決定する
    switch (conn.effectiveType) {
        case 'slow-2g':
        case '2g':
            // 低速回線: 最小限の画質で通信量を削減する
            return { widthMultiplier: 0.5, qualityMultiplier: 0.5 };
        case '3g':
            // 中速回線: 画質を抑えながらバランスを取る
            return { widthMultiplier: 0.7, qualityMultiplier: 0.7 };
        case '4g':
        default:
            // 高速回線または不明: 最高品質で送信する
            return { widthMultiplier: 1.0, qualityMultiplier: 1.0 };
    }
}
