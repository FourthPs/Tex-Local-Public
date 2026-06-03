"""
TexLocal - Desktop App Bootstrap (v4.1.0 Phase 3)

Entry point for "app mode": wraps the existing Flask backend in a PyWebView
window so it looks/feels like a native desktop application.

The original `python texlocal.py` (browser mode) is UNCHANGED - that path still
works exactly as before. This file is purely additive.

Architecture:
    1. Inject bundled MiKTeX bin/ into PATH if frozen + bundle present
    2. Import `app` (the Flask object) from texlocal.py
    3. Pick a free localhost port (NOT 5000, so browser-mode can coexist)
    4. Run app.run(...) in a daemon thread on that port
    5. Wait for the server to be reachable (HTTP 200 on /)
    6. Open a PyWebView window pointing at http://127.0.0.1:<port>
    7. When the window closes, the daemon Flask thread is auto-killed

Dependency: pip install pywebview
            (uses system WebView2 on Windows - no Chromium bundled.)
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
import urllib.request

# Signal to texlocal.py that we're running embedded.
os.environ["TEXLOCAL_EMBEDDED"] = "1"


# -- v4.1.0-phase3: Bundled MiKTeX PATH injection -----------------------
# When TexLocal is shipped as a frozen .exe with MiKTeX-portable bundled
# alongside it, we need to prepend MiKTeX's bin directory to PATH BEFORE
# any subprocess.run("pdflatex", ...) call happens. Otherwise the OS PATH
# lookup either (a) finds nothing and compile fails, or (b) finds a
# different system-installed TeX that may not match what we bundled.
#
# Expected layout when frozen + MiKTeX bundled:
#
#   TexLocal.exe                       <- sys.executable
#   miktex/
#     texmfs/install/miktex/bin/x64/
#       pdflatex.exe, xelatex.exe, biber.exe, synctex.exe, ...
#
# This path is the standard MiKTeX-portable layout (downloaded from
# miktex.org/portable). If the bundle isn't present (Phase 2 builds, or
# Phase 3 build without MiKTeX dropped in yet), we fall through silently
# - the subprocess will then use whatever pdflatex is on the system PATH,
# matching Phase 2 behavior. So this guard is a strict "additive" change:
# never breaks an existing install, only enriches it when the bundle exists.

def _inject_bundled_miktex() -> None:
    # v4.1.6-phase3 — silent by default. To collect a diagnostic log set the
    # env var TEXLOCAL_DEBUG=1 before launching (Start Menu has a "TexLocal
    # (Debug Mode)" shortcut that does this). Log goes to
    # {install_dir}/miktex-inject-debug.log and survives across launches.
    if not getattr(sys, "frozen", False):
        return  # source-mode dev: use Pol's normal MiKTeX setup
    app_dir = os.path.dirname(sys.executable)
    miktex_bin = os.path.join(
        app_dir, "miktex", "texmfs", "install", "miktex", "bin", "x64"
    )
    if not os.path.isdir(miktex_bin):
        # No bundle present -> fall through to system MiKTeX (Phase 2 behavior).
        return
    # Prepend, don't replace. If the user has a system MiKTeX too, ours wins
    # for `pdflatex` lookups but theirs is still available as fallback.
    os.environ["PATH"] = miktex_bin + os.pathsep + os.environ.get("PATH", "")
    # Mark for downstream code that may want to know which engine is active.
    os.environ["TEXLOCAL_MIKTEX_BUNDLED"] = miktex_bin

    # Diagnostic dump — opt-in via TEXLOCAL_DEBUG. The cost of always writing
    # is negligible, but a stray log file in users' install dirs is noise we
    # don't want by default. Debug Mode shortcut sets the env var for support
    # scenarios; ordinary launches stay silent.
    if os.environ.get("TEXLOCAL_DEBUG"):
        try:
            import shutil as _sh
            log_path = os.path.join(app_dir, "miktex-inject-debug.log")
            with open(log_path, "w", encoding="utf-8") as f:
                f.write("=== miktex-inject diagnostic (TEXLOCAL_DEBUG=1) ===\n")
                f.write(f"timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
                f.write(f"sys.executable = {sys.executable}\n")
                f.write(f"app_dir = {app_dir}\n")
                f.write(f"miktex_bin = {miktex_bin}\n")
                f.write(f"PATH (first 800):\n  {os.environ['PATH'][:800]}\n")
                f.write(f"TEXLOCAL_MIKTEX_BUNDLED = {miktex_bin}\n")
                f.write(f"shutil.which('pdflatex') = {_sh.which('pdflatex')}\n")
                f.write(f"shutil.which('xelatex')  = {_sh.which('xelatex')}\n")
                f.write("=== injection complete ===\n")
        except OSError:
            pass  # never crash over diagnostic write


_inject_bundled_miktex()

# Import AFTER env mutations so any module-level checks in texlocal see them.
from texlocal import app  # noqa: E402

try:
    import webview  # type: ignore
except ImportError:
    sys.stderr.write(
        "\n[texlocal_app] PyWebView is not installed.\n"
        "Install with:  pip install pywebview\n"
        "On Windows you may also need the WebView2 runtime "
        "(usually preinstalled on Win10/11).\n\n"
    )
    sys.exit(1)


# -- Helpers ----------------------------------------------------------

def _pick_free_port() -> int:
    """Ask the OS for an unused TCP port. Bind->getsockname->close is the
    canonical 'port lottery' trick - kernel won't reissue it until we
    bind to it again, which we do almost immediately."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_server(url: str, timeout: float = 8.0) -> bool:
    """Poll the Flask server until it answers, or give up.
    Flask's app.run() may take 200-800ms to bind; webview must not load
    the URL before then or it'll show an error page."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=0.5) as r:
                if r.status < 500:
                    return True
        except Exception:
            pass
        time.sleep(0.1)
    return False


def _run_flask(port: int) -> None:
    """Run Flask in this thread. debug=False + use_reloader=False are
    critical: the reloader would fork and break webview's IPC, and debug
    mode exposes the Werkzeug debugger to anyone on localhost."""
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)


# -- Main -------------------------------------------------------------

def main() -> None:
    port = _pick_free_port()
    url = f"http://127.0.0.1:{port}/"

    # Daemon=True so the thread dies when the main (webview) thread exits.
    # If we didn't set this, closing the window would leave a zombie Flask
    # process bound to the port until the user kills Python manually.
    server_thread = threading.Thread(
        target=_run_flask, args=(port,), daemon=True, name="texlocal-flask"
    )
    server_thread.start()

    if not _wait_for_server(url):
        sys.stderr.write(
            f"\n[texlocal_app] Flask did not come up at {url} within 8s.\n"
            "Check that texlocal.py imports cleanly and port "
            f"{port} is actually free.\n\n"
        )
        sys.exit(2)

    # Window sizing: 1400x900 fits a typical thesis workflow (file tree +
    # editor + PDF preview side-by-side) on a 1080p+ display. min_size
    # prevents a too-small window from breaking the responsive layout.
    webview.create_window(
        title="TexLocal",
        url=url,
        width=1400,
        height=900,
        min_size=(900, 600),
        confirm_close=False,  # PoL has Ctrl+S autosave habit; no nag needed
    )
    # Persist localStorage + cookies across app restarts. pywebview defaults to
    # private_mode=True (incognito), so every setting saved to localStorage —
    # per-project compiler choice (texlocal_compiler_<name>), theme, font size,
    # last file, \includeonly selection, compile history — is wiped on close.
    # Browser mode never hit this because the real browser persists localStorage.
    # A fixed storage_path + private_mode=False makes the WebView2 profile durable.
    _base = (os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
             or os.path.expanduser("~"))
    _storage = os.path.join(_base, "TexLocal", "webview")
    try:
        os.makedirs(_storage, exist_ok=True)
    except OSError:
        _storage = None
    # webview.start() blocks until the last window closes. The daemon
    # Flask thread is then garbage-collected with the process.
    webview.start(private_mode=False, storage_path=_storage)


if __name__ == "__main__":
    main()
