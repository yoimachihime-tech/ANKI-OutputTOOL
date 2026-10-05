@echo off
rem Register the "ankitts:" URL scheme for this Windows user (HKCU, no admin rights).
rem After this, the "TTS" button on the web page can start the local TTS tool.
rem Run once per PC. To undo: C:\Python314\python.exe tools\register_local_tts_protocol.py --unregister
cd /d "%~dp0"
C:\Python314\python.exe tools\register_local_tts_protocol.py
echo.
pause
