@echo off
title PlayerNation AI - Local YOLOv8 Vision Backend
echo ============================================================
echo   Starting PlayerNation AI Local Vision Server
echo   Port: http://127.0.0.1:8000
echo   Model: models/yolov8n.pt (Ultralytics PyTorch)
echo ============================================================
echo.
python server/server.py
pause
