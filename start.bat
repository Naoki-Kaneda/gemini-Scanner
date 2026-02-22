@echo off
echo === Gemini Vision Scanner 起動 ===

REM ポート5000を使用中のプロセスを確認・停止（安全確認付き）
set "FOUND="
set "PID_LIST="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5000 ^| findstr LISTENING') do (
    set "FOUND=1"
    set "PID_LIST=!PID_LIST! %%a"
)

setlocal enabledelayedexpansion
if defined FOUND (
    echo [!] ポート5000を使用中のプロセスが見つかりました:
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5000 ^| findstr LISTENING') do (
        for /f "tokens=1" %%b in ('tasklist /fi "PID eq %%a" /fo csv /nh 2^>nul') do (
            echo     PID: %%a  プロセス名: %%b
        )
    )
    set /p ANSWER="これらのプロセスを停止しますか？ (y/N): "
    if /i "!ANSWER!"=="y" (
        for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5000 ^| findstr LISTENING') do (
            taskkill /PID %%a >nul 2>&1
        )
        timeout /t 2 >nul
        REM 停止できなかった場合のみ強制終了
        for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5000 ^| findstr LISTENING') do (
            echo [!] graceful停止に失敗したプロセスを強制終了します...
            taskkill /PID %%a /F >nul 2>&1
        )
        timeout /t 1 >nul
        echo [OK] プロセスを停止しました。
    ) else (
        echo [中止] プロセスの停止をキャンセルしました。ポート5000が使用中のため起動できません。
        exit /b 1
    )
)
endlocal

echo [OK] Flask起動中...
python app.py
