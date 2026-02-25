// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Vision AI Scanner - カメラ制御モジュール
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 役割: カメラデバイスの起動・停止・切替、入力ソース管理
//       （カメラ/静止画/動画ファイル）を集約するモジュール。
// script.js からの ES Module 分割の一部として機能する。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { CAMERA_WIDTH, CAMERA_HEIGHT } from './constants.js';
import {
    setStatusMessage,
    updateSourceButtons,
    updateFlipButton,
    updateMirrorState,
    getVideoElement,
} from './ui-manager.js';

// ─────────────────────────────────────────────
// 1. モジュールスコープ変数
//    initCamera() 呼び出し後に有効になる
// ─────────────────────────────────────────────

/** 映像表示用 <video> 要素 */
let video;

/** キャプチャ用 <canvas> 要素 */
let canvas;

/** キャプチャ用 Canvas の 2D 描画コンテキスト */
let ctx;

/** 静止画表示用 <img> 要素 */
let imageFeed;

/** カメラ選択ドロップダウン要素 */
let cameraSelector;

/** カメラ前面/背面切替ボタン要素 */
let btnFlipCam;

/** 検出済みの映像入力デバイス一覧 */
let videoDevices = [];

/** 現在使用中のカメラ向き（'environment': 外カメ, 'user': インカメ） */
let currentFacingMode = 'environment';

/** 現在の入力ソース（'camera' / 'image' / 'file'） */
let currentSource = 'camera';

/** ミラー（左右反転）が有効かどうか */
let isMirrored = false;


// ─────────────────────────────────────────────
// 2. 初期化
// ─────────────────────────────────────────────

/**
 * DOM要素を取得してモジュールスコープ変数に格納する。
 * キャプチャ用 Canvas が HTML に存在しない場合は動的生成する。
 * DOMContentLoaded 以降、かつ他の関数を呼ぶ前に必ず実行すること。
 */
export function initCamera() {
    video         = document.getElementById('video-feed');
    imageFeed     = document.getElementById('image-feed');
    canvas        = document.getElementById('capture-canvas');
    cameraSelector = document.getElementById('camera-selector');
    btnFlipCam    = document.getElementById('btn-flip-cam');

    // 古いテンプレート互換: Canvas が存在しない場合は動的生成する
    const videoContainer = document.querySelector('.video-container');
    if (!canvas && videoContainer) {
        canvas        = document.createElement('canvas');
        canvas.id     = 'capture-canvas';
        canvas.className = 'hidden';
        videoContainer.appendChild(canvas);
    }

    ctx = canvas ? canvas.getContext('2d') : null;
}


// ─────────────────────────────────────────────
// 3. ゲッター関数
//    他モジュールが必要とする参照・状態値を公開する
// ─────────────────────────────────────────────

/** キャプチャ用 <video> 要素を返す */
export function getVideo() { return video; }

/** キャプチャ用 <canvas> 要素を返す */
export function getCanvas() { return canvas; }

/** キャプチャ用 Canvas の 2D 描画コンテキストを返す */
export function getCtx() { return ctx; }

/** 静止画表示用 <img> 要素を返す */
export function getImageFeed() { return imageFeed; }

/** カメラ選択ドロップダウン要素を返す */
export function getCameraSelector() { return cameraSelector; }

/** 現在の入力ソース（'camera' / 'image' / 'file'）を返す */
export function getCurrentSource() { return currentSource; }

/** ミラー（左右反転）が有効かどうかを返す */
export function isCameraMirrored() { return isMirrored; }

/**
 * 入力ソースを直接設定する。
 * @param {'camera'|'image'|'file'} src - 設定するソース名
 */
export function setCurrentSource(src) { currentSource = src; }


// ─────────────────────────────────────────────
// 4. カメラストリーム停止
// ─────────────────────────────────────────────

/**
 * 現在アクティブなカメラストリームの全トラックを停止する。
 * 別のカメラや入力ソースに切り替える前に必ず呼び出すこと。
 */
export function stopCameraStream() {
    if (video && video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    }
}


// ─────────────────────────────────────────────
// 5. カメラ起動
// ─────────────────────────────────────────────

/**
 * 指定デバイスまたはデフォルト条件でカメラを起動する。
 * 起動成功後に currentSource を 'camera' に設定し、UIを更新する。
 * 制約エラー時は最低限の条件でフォールバック再試行する。
 *
 * @param {string|null} deviceId - 使用するカメラのデバイスID（null でデフォルト）
 * @returns {Promise<void>}
 */
export async function setupCamera(deviceId = null) {
    try {
        // 希望解像度とカメラ向き（またはデバイスID）の制約を組み立てる
        const constraints = {
            video: deviceId
                ? {
                    deviceId: { exact: deviceId },
                    width:    { ideal: CAMERA_WIDTH },
                    height:   { ideal: CAMERA_HEIGHT },
                }
                : {
                    facingMode: { ideal: currentFacingMode },
                    width:      { ideal: CAMERA_WIDTH },
                    height:     { ideal: CAMERA_HEIGHT },
                },
        };

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (constraintErr) {
            // 指定条件での取得に失敗した場合は最低限の条件で再試行する
            console.warn('指定条件でのカメラ取得に失敗、フォールバック:', constraintErr.name);
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width:  { ideal: CAMERA_WIDTH },
                    height: { ideal: CAMERA_HEIGHT },
                },
            });
        }

        // 取得したストリームを <video> 要素にセットして再生する
        video.srcObject = stream;
        await video.play().catch((err) => {
            console.warn('映像再生の開始に失敗:', err.name);
            setStatusMessage('⚠ カメラ映像の再生に失敗しました');
        });

        currentSource = 'camera';
        updateSourceButtons(currentSource);

        // カメラ一覧を更新してセレクターに反映する
        await populateCameraSelector();

        // 実際に使用されているデバイスIDをセレクターに反映する
        const activeTrack = stream.getVideoTracks()[0];
        if (activeTrack && cameraSelector) {
            const settings = activeTrack.getSettings();
            if (settings.deviceId) {
                cameraSelector.value = settings.deviceId;
            }
        }

        // 前面/背面切替ボタンの表示可否を更新する
        updateFlipButtonVisibility();
    } catch (err) {
        console.error('カメラアクセスエラー:', err);
        alert('カメラへのアクセスが拒否されたか、カメラが見つかりません。');
    }
}


// ─────────────────────────────────────────────
// 6. カメラセレクター更新（内部関数）
// ─────────────────────────────────────────────

/**
 * 利用可能な映像入力デバイスを列挙してカメラセレクターを更新する。
 * デバイスが2台以上の場合のみセレクターを表示する。
 * この関数は setupCamera() からのみ呼ばれる内部関数であり、外部公開しない。
 *
 * @returns {Promise<void>}
 */
async function populateCameraSelector() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devices.filter(d => d.kind === 'videoinput');

    if (!cameraSelector) return;

    // 既存の選択肢を全て除去してから再描画する
    while (cameraSelector.firstChild) {
        cameraSelector.removeChild(cameraSelector.firstChild);
    }

    if (videoDevices.length > 1) {
        // 複数デバイスがある場合のみセレクターを表示する
        cameraSelector.classList.remove('hidden');

        videoDevices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value       = device.deviceId;
            option.textContent = device.label || `カメラ ${index + 1}`;
            cameraSelector.appendChild(option);
        });
    } else {
        // デバイスが1台以下の場合はセレクターを非表示にする
        cameraSelector.classList.add('hidden');
    }
}


// ─────────────────────────────────────────────
// 7. カメラデバイス切替
// ─────────────────────────────────────────────

/**
 * 指定デバイスIDのカメラに切り替える。
 * 現在のストリームを停止してから新しいカメラを起動する。
 *
 * @param {string} deviceId - 切り替え先のカメラデバイスID
 */
export function switchCameraDevice(deviceId) {
    stopCameraStream();
    setupCamera(deviceId);
}


// ─────────────────────────────────────────────
// 8. 前面/背面カメラ切替
// ─────────────────────────────────────────────

/**
 * 前面カメラと背面カメラを交互に切り替える。
 * インカメラ（user）に切替時は自動的にミラーを有効にする。
 * 外カメラ（environment）に切替時はミラーを無効にする。
 */
export function toggleFacingMode() {
    // 向きを反転する
    currentFacingMode = (currentFacingMode === 'environment') ? 'user' : 'environment';

    // インカメラの場合は自動的にミラーを有効にする
    isMirrored = (currentFacingMode === 'user');
    updateMirrorState(isMirrored);

    // ボタンテキストを新しい向きに合わせて更新する
    updateFlipButton(currentFacingMode);

    // ストリームを再起動する
    stopCameraStream();
    setupCamera();
}


// ─────────────────────────────────────────────
// 9. 前面/背面切替ボタンの表示制御（内部関数）
// ─────────────────────────────────────────────

/**
 * 前面/背面切替ボタン（btnFlipCam）の表示・非表示を判定して適用する。
 * デバイスが1台のみ、または前面・背面のどちらかしかない場合は非表示にする。
 * この関数は setupCamera() からのみ呼ばれる内部関数であり、外部公開しない。
 */
function updateFlipButtonVisibility() {
    if (!btnFlipCam) return;

    // デバイスが2台未満の場合はボタンを非表示にする
    if (videoDevices.length < 2) {
        btnFlipCam.classList.add('hidden');
        return;
    }

    let hasFront = false;
    let hasBack  = false;

    // まずアクティブなトラックの capabilities から向き情報を取得する
    if (video && video.srcObject) {
        const tracks = video.srcObject.getVideoTracks();
        for (const track of tracks) {
            if (typeof track.getCapabilities === 'function') {
                const caps = track.getCapabilities();
                if (caps.facingMode && caps.facingMode.length > 0) {
                    // facingMode の capabilities が存在すれば前面・背面両対応とみなす
                    hasFront = true;
                    hasBack  = true;
                    break;
                }
            }
        }
    }

    // capabilities で判定できなかった場合はデバイスラベルから推定する
    if (!hasFront && !hasBack) {
        for (const device of videoDevices) {
            const label = (device.label || '').toLowerCase();

            if (
                label.includes('front')         ||
                label.includes('user')          ||
                label.includes('facing front')  ||
                label.includes('前面')          ||
                label.includes('インカメ')
            ) {
                hasFront = true;
            }
            if (
                label.includes('back')          ||
                label.includes('rear')          ||
                label.includes('environment')   ||
                label.includes('facing back')   ||
                label.includes('背面')          ||
                label.includes('外')
            ) {
                hasBack = true;
            }
        }
    }

    // 前面・背面の両方が存在する場合のみボタンを表示する
    if (hasFront && hasBack) {
        btnFlipCam.classList.remove('hidden');
    } else {
        btnFlipCam.classList.add('hidden');
    }
}


// ─────────────────────────────────────────────
// 10. 入力ソース切替（カメラへ戻す）
// ─────────────────────────────────────────────

/**
 * 入力ソースを指定のソースに切り替える。
 * 現在は 'camera' への切替のみ実装。静止画ソースの Blob URL を解放する。
 *
 * @param {'camera'} source - 切り替え先のソース名
 */
export function switchSource(source) {
    if (source === 'camera') {
        // 静止画の Blob URL を解放してメモリリークを防止する
        if (imageFeed) {
            if (imageFeed.src && imageFeed.src.startsWith('blob:')) {
                URL.revokeObjectURL(imageFeed.src);
            }
            imageFeed.removeAttribute('src');
            imageFeed.classList.add('hidden');
        }

        // <video> 要素を表示してカメラを起動する
        if (video) video.classList.remove('hidden');
        currentSource = 'camera';
        updateSourceButtons(currentSource);
        setupCamera();
    }
}


// ─────────────────────────────────────────────
// 11. ミラー手動切替
// ─────────────────────────────────────────────

/**
 * ミラー（左右反転）の有効/無効を手動でトグルする。
 * カメラ向きの自動ミラーとは独立して機能する。
 */
export function toggleMirror() {
    isMirrored = !isMirrored;
    updateMirrorState(isMirrored);
}


// ─────────────────────────────────────────────
// 12. ファイルアップロード処理
// ─────────────────────────────────────────────

/**
 * ファイル入力要素の change イベントを処理する。
 * 画像ファイルは <img> 要素に表示し、動画ファイルは <video> 要素で再生する。
 * カメラストリームを停止してからファイルを読み込む。
 * scanner モジュールへの直接依存を避けるため、停止処理はコールバックで受け取る。
 *
 * @param {Event}         event          - input[type=file] の change イベント
 * @param {Function|null} stopScanningFn - スキャンループを停止するコールバック関数
 */
export function handleFileUpload(event, stopScanningFn) {
    const file = event.target.files[0];
    if (!file) return;

    // カメラストリームとスキャンを停止する
    stopCameraStream();
    if (stopScanningFn) stopScanningFn();

    // 既存の Blob URL を解放してメモリリークを防止する
    if (video && video.src && video.src.startsWith('blob:')) {
        URL.revokeObjectURL(video.src);
    }
    if (imageFeed && imageFeed.src && imageFeed.src.startsWith('blob:')) {
        URL.revokeObjectURL(imageFeed.src);
    }

    const isImage = file.type.startsWith('image/');

    if (isImage) {
        // 静止画ファイル: <img> 要素に表示して <video> を隠す
        const blobUrl = URL.createObjectURL(file);
        imageFeed.src = blobUrl;
        imageFeed.classList.remove('hidden');
        video.classList.add('hidden');
        video.pause();
        video.removeAttribute('src');
        currentSource = 'image';
    } else {
        // 動画ファイル: <video> 要素でループ再生する
        imageFeed.classList.add('hidden');
        imageFeed.removeAttribute('src');
        video.classList.remove('hidden');
        video.src  = URL.createObjectURL(file);
        video.loop = true;
        video.play();
        currentSource = 'file';
    }

    updateSourceButtons(currentSource);
}
