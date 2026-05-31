@echo off
REM TexLocal — Debug Mode launcher (v4.1.6-phase3)
REM
REM Sets TEXLOCAL_DEBUG=1 then launches TexLocal.exe. The running app will
REM write diagnostic info to {install_dir}\miktex-inject-debug.log covering:
REM   * Startup: PATH/sys.frozen/miktex_bin resolution after _inject_bundled_miktex
REM   * Per compile: cmd / cwd / PATH / shutil.which() / any FileNotFoundError
REM
REM Send the resulting miktex-inject-debug.log file to support if compile
REM mysteriously fails. Ordinary Start Menu shortcut launches without debug.
REM
REM `start "" ...` so this .bat exits immediately and the cmd flash vanishes.

set TEXLOCAL_DEBUG=1
start "" "%~dp0TexLocal.exe"
