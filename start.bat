@echo off
start "" python app.py
timeout /t 2 /nobreak >nul
start http://localhost:5000
