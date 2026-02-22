@echo off
setlocal enabledelayedexpansion
echo === Gemini Vision Scanner 起動 ===

REM ポート設定（環境変数 APP_PORT 未設定なら5000）
if not defined APP_PORT set APP_PORT=5000

REM 指定ポートを使用中のプロセスを確認・停止（安全確認付き）
set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%APP_PORT% ^| findstr LISTENING') do (
    set "FOUND=1"
)

if defined FOUND (
    echo [!] ポート%APP_PORT%を使用中のプロセスが見つかりました:
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%APP_PORT% ^| findstr LISTENING') do (
        for /f "tokens=1" %%b in ('tasklist /fi "PID eq %%a" /fo csv /nh 2^>nul') do (
            echo     PID: %%a  プロセス名: %%b
        )
    )
    set /p ANSWER="これらのプロセスを停止しますか？ (y/N): "
    if /i "!ANSWER!"=="y" (
        for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%APP_PORT% ^| findstr LISTENING') do (
            taskkill /PID %%a >nul 2>&1
        )
        timeout /t 2 >nul
        REM 停止できなかった場合のみ強制終了
        for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%APP_PORT% ^| findstr LISTENING') do (
            echo [!] graceful停止に失敗したプロセスを強制終了します...
            taskkill /PID %%a /F >nul 2>&1
        )
        timeout /t 1 >nul
        echo [OK] プロセスを停止しました。
    ) else (
        echo [中止] プロセスの停止をキャンセルしました。ポート%APP_PORT%が使用中のため起動できません。
        exit /b 1
    )
)

echo [OK] Flask起動中... (ポート: %APP_PORT%)
python app.py
