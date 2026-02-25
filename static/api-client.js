// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Vision AI Scanner - API通信モジュール
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import {
    FETCH_TIMEOUT_MS,
    ENFORCE_CLIENT_DAILY_LIMIT,
    API_DAILY_LIMIT,
    setApiDailyLimit,
} from './constants.js';

import {
    updateApiCounter,
    updateProxyButton,
    disableScanButton,
    setStatusMessage,
} from './ui-manager.js';

// ─────────────────────────────────────────────
// モジュールスコープ変数
//   このファイル内でのみ管理し、外部からはゲッター経由で参照する
// ─────────────────────────────────────────────

/** 現在セッション内のAPI呼び出し累計カウント */
let apiCallCount = 0;

/** プロキシが現在有効かどうかのフラグ */
let currentProxyEnabled = false;

// ─────────────────────────────────────────────
// 1. タイムアウト付き AbortSignal
//    fetch のタイムアウトを一元管理する
// ─────────────────────────────────────────────

/**
 * 指定ミリ秒後に自動でタイムアウトする AbortSignal を返す
 * ブラウザが AbortSignal.timeout() に対応している場合はネイティブ実装を優先する
 *
 * @param {number} ms - タイムアウト時間（ミリ秒）。省略時は FETCH_TIMEOUT_MS を使用
 * @returns {AbortSignal} タイムアウト付き AbortSignal
 */
export function fetchSignal(ms = FETCH_TIMEOUT_MS) {
    // ネイティブ実装が利用可能な場合はそちらを優先（ブラウザ管理でより正確）
    if (typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(ms);
    }
    // フォールバック: setTimeout で手動アボート
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
}

// ─────────────────────────────────────────────
// 2. リトライ付き fetch
//    指数バックオフで通信エラーを自動リトライする
// ─────────────────────────────────────────────

/**
 * 通信エラー時に指数バックオフでリトライする fetch ラッパー
 * AbortError（タイムアウト含む）はリトライせずそのまま投げる
 * リトライ上限を超えた場合は err._retriesExhausted = true を付与して投げる
 *
 * @param {string} url              - リクエスト先 URL
 * @param {RequestInit} options     - fetch オプション（signal は上書きされる）
 * @param {number} maxRetries       - 最大リトライ回数（初回を除く）
 * @param {number} baseDelay        - 初回リトライ待機時間（ミリ秒）。以降は2倍ずつ増加
 * @returns {Promise<Response>}     - 成功した fetch レスポンス
 * @throws {Error}                  - 全リトライが失敗した場合、またはタイムアウト時
 */
export async function fetchWithRetry(url, options, maxRetries = 3, baseDelay = 2000) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // リクエストごとに新しい AbortSignal を付与する
            return await fetch(url, { ...options, signal: fetchSignal() });
        } catch (err) {
            lastError = err;

            // AbortError（タイムアウト・キャンセル）はリトライせず即座に投げる
            if (err.name === 'AbortError') throw err;

            // リトライ上限に達した場合はフラグを立てて投げる
            if (attempt >= maxRetries) {
                err._retriesExhausted = true;
                throw err;
            }

            // 指数バックオフ: baseDelay × 2^attempt
            const delay = baseDelay * Math.pow(2, attempt);

            // ユーザーにリトライ中であることを通知する
            setStatusMessage(`⚠ 通信エラー — 再試行中 (${attempt + 1}/${maxRetries})...`);
            console.warn(
                `通信エラー (試行 ${attempt + 1}/${maxRetries + 1}): ${err.message}。${delay}ms後に再試行`
            );

            // 次のリトライまで待機する
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}

// ─────────────────────────────────────────────
// 3. API呼び出しカウント管理
//    外部から apiCallCount を安全に参照・更新するためのゲッター/ミューテーター
// ─────────────────────────────────────────────

/**
 * 現在のAPI呼び出し累計カウントを返す
 * @returns {number} 累計API呼び出し回数
 */
export function getApiCallCount() {
    return apiCallCount;
}

/**
 * API呼び出しカウントを1増やす
 * API呼び出しが成功した直後に呼び出すこと
 */
export function incrementApiCallCount() {
    apiCallCount++;
}

// ─────────────────────────────────────────────
// 4. API使用量のローカルストレージ管理
//    日付をキーにして1日ごとにカウントをリセットする
// ─────────────────────────────────────────────

/**
 * ローカルストレージからAPI使用量を読み込む
 * 保存日が今日と異なる場合はカウントをリセットする
 * 読み込み後は UI カウンターを更新する
 */
export function loadApiUsage() {
    const today = new Date().toDateString();
    const saved = localStorage.getItem('visionApiUsage');

    if (saved) {
        try {
            const data = JSON.parse(saved);
            // 保存日が今日と一致する場合のみカウントを復元する
            apiCallCount = (data && data.date === today) ? (data.count || 0) : 0;
        } catch {
            // JSON パース失敗時はカウントをリセットし、壊れたデータを削除する
            apiCallCount = 0;
            localStorage.removeItem('visionApiUsage');
        }
    }

    updateApiCounter(apiCallCount, API_DAILY_LIMIT);
}

/**
 * 現在のAPI使用量をローカルストレージに保存する
 * 日付と件数をセットで保存し、翌日に自動リセットできるようにする
 * 保存後は UI カウンターを更新する
 */
export function saveApiUsage() {
    localStorage.setItem('visionApiUsage', JSON.stringify({
        date: new Date().toDateString(),
        count: apiCallCount,
    }));

    updateApiCounter(apiCallCount, API_DAILY_LIMIT);
}

// ─────────────────────────────────────────────
// 5. サーバー設定の同期
//    プロキシ設定・レート制限・使用量をサーバーから取得する
// ─────────────────────────────────────────────

/**
 * サーバーからプロキシ設定を取得し、UI のプロキシボタンを更新する
 * 取得に失敗した場合はエラーをログに記録するだけで処理を継続する
 */
export async function loadProxyConfig() {
    try {
        const res = await fetch('/api/config/proxy', { signal: fetchSignal() });
        if (res.ok) {
            const data = await res.json();
            // モジュールスコープ変数を更新し、ボタン表示に反映する
            currentProxyEnabled = data.enabled;
            updateProxyButton(data.enabled);
        }
    } catch (err) {
        console.error('プロキシ設定取得エラー:', err);
    }
}

/**
 * サーバーからレート制限設定を取得し、日次上限値と UI カウンターを更新する
 * サーバー側の日次上限が 0 より大きい場合のみ定数を上書きする
 * 取得に失敗した場合はエラーをログに記録するだけで処理を継続する
 */
export async function loadRateLimits() {
    try {
        const res = await fetch('/api/config/limits', { signal: fetchSignal() });
        if (res.ok) {
            const data = await res.json();
            if (data.daily_limit > 0) {
                // サーバー設定を最新値で上書きする（live binding 経由で全モジュールに反映）
                setApiDailyLimit(data.daily_limit);
                updateApiCounter(apiCallCount, data.daily_limit);
            }
        }
    } catch (err) {
        console.error('レート制限設定取得エラー:', err);
    }
}

/**
 * サーバー側の使用量カウントと同期し、クライアント側のカウントを補正する
 * サーバー値がクライアント値より大きい場合はサーバー値を採用する
 * 日次上限に達している場合はスキャンボタンを無効化する
 */
export async function syncApiUsage() {
    try {
        const res = await fetch('/api/config/usage', { signal: fetchSignal() });
        if (!res.ok) return;

        const data = await res.json();

        // サーバーから最新の日次上限が返ってきた場合は定数を更新する
        if (data.daily_limit > 0) setApiDailyLimit(data.daily_limit);

        // サーバー側のカウントがクライアントより多い場合は補正して保存する
        if (data.daily_count > apiCallCount) {
            apiCallCount = data.daily_count;
            saveApiUsage();
        }

        // 日次上限に達している場合はユーザーに通知してスキャンを無効化する
        if (data.daily_count >= data.daily_limit) {
            setStatusMessage('⚠ 本日のAPI上限に達しています');
            disableScanButton('本日の上限に到達');
        }

        // UI カウンターを最新の状態で描画する
        updateApiCounter(apiCallCount, data.daily_limit || API_DAILY_LIMIT);
    } catch (err) {
        console.error('API使用量同期エラー:', err);
    }
}

// ─────────────────────────────────────────────
// 6. 日次制限チェック（副作用なし）
//    スキャン開始前の事前チェックに使用する純粋な判定関数
// ─────────────────────────────────────────────

/**
 * クライアント側の日次制限に達しているかどうかを返す
 * ENFORCE_CLIENT_DAILY_LIMIT が false の場合は常に false を返す
 * この関数は副作用を持たず、状態変更を行わない
 *
 * @returns {boolean} 上限に達している場合 true
 */
export function isApiLimitReached() {
    return ENFORCE_CLIENT_DAILY_LIMIT && apiCallCount >= API_DAILY_LIMIT;
}
