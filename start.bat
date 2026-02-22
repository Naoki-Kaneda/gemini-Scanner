@echo off
echo === Gemini Vision Scanner 起動 ===

REM ポート5000を使用中のプロセスを確認・停止
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5000 ^| findstr LISTENING') do (
    echo [!] ポート5000を使用中のプロセス(PID:%%a)を停止します...
    taskkill /PID %%a /F >nul 2>&1
    timeout /t 1 >nul
)

echo [OK] Flask起動中...
python app.py
