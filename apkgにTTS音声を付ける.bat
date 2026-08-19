@echo off
rem Launch the local TTS tool without a console window (pythonw).
rem To stop it, use the button at the bottom of the page in your browser.
cd /d %~dp0
start "" C:\Python314\pythonw.exe local_tts_server.py
