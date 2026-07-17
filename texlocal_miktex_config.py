"""Safe runtime configuration for TexLocal's bundled MiKTeX tree."""

from __future__ import annotations

import os
import hashlib
import json
import re
import subprocess
import tempfile


_CORE_SECTION_RE = re.compile(r"^\s*\[Core\]\s*$", re.IGNORECASE)
_ANY_SECTION_RE = re.compile(r"^\s*\[[^]]+\]\s*$")
_ALLOWED_COMMAND_RE = re.compile(
    r"^\s*AllowedShellCommands\[\]\s*=\s*(\S+)\s*$", re.IGNORECASE
)
_UNRESTRICTED_MODE_RE = re.compile(
    r"^(\s*ShellCommandMode\s*=\s*)Unrestricted(\s*)$",
    re.IGNORECASE,
)

# MiKTeX 25.12's trusted restricted-shell defaults. A user-level list replaces
# (rather than extends) these compiled defaults, so every baseline entry must be
# retained when TexLocal adds latexminted. The bundle is pinned to MiKTeX 25.12;
# update this tuple deliberately when the bundled distribution is upgraded.
_MIKTEX_25_12_RESTRICTED_DEFAULTS = (
    "miktex-bibtex",
    "miktex-bibtex8",
    "miktex-epstopdf",
    "miktex-gregorio",
    "miktex-kpsewhich",
    "miktex-makeindex",
    "bibtex",
    "bibtex8",
    "extractbb",
    "findtexmf",
    "gregorio",
    "kpsewhich",
    "l3sys-query",
    "makeindex",
    "memoize-extract.pl",
    "memoize-extract.py",
    "texosquery-jre8",
)
_TEXLOCAL_RESTRICTED_COMMANDS = (
    *_MIKTEX_25_12_RESTRICTED_DEFAULTS,
    "latexminted",
)


def _atomic_write(path: str, text: str) -> None:
    directory = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(
        prefix="miktex-config-", suffix=".tmp", dir=directory
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def ensure_portable_minted_restricted_shell(app_dir: str) -> str | None:
    """Allow only bundled ``latexminted`` in MiKTeX restricted shell mode.

    ``latexminted`` v3 is designed for restricted shell escape and is bundled
    inside TexLocal's portable MiKTeX tree. We never authorize a helper found
    elsewhere on PATH, and an accidentally unrestricted portable config is
    tightened back to ``Restricted`` while preserving every other setting.

    Returns the updated/no-op ``miktex.ini`` path, or ``None`` when the bundled
    portable tree/helper is unavailable.
    """

    texmfs = os.path.join(app_dir, "miktex", "texmfs")
    config_path = os.path.join(texmfs, "config", "miktex", "config", "miktex.ini")
    helper_path = os.path.join(
        texmfs, "install", "miktex", "bin", "x64", "latexminted.exe"
    )
    if not os.path.isfile(config_path) or not os.path.isfile(helper_path):
        return None

    with open(
        config_path, "r", encoding="utf-8-sig", errors="replace", newline=""
    ) as handle:
        original = handle.read()

    newline = "\r\n" if "\r\n" in original else "\n"
    trailing_newline = original.endswith(("\n", "\r"))
    lines = original.splitlines()

    # TexLocal never needs unrestricted shell execution. Tightening a portable
    # config here keeps the compile contract safe even if that file was edited.
    for index, line in enumerate(lines):
        lines[index] = _UNRESTRICTED_MODE_RE.sub(r"\1Restricted\2", line)

    core_index = next(
        (index for index, line in enumerate(lines) if _CORE_SECTION_RE.match(line)),
        None,
    )
    if core_index is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append("[Core]")
        lines.extend(
            f"AllowedShellCommands[] = {command}"
            for command in _TEXLOCAL_RESTRICTED_COMMANDS
        )
    else:
        section_end = core_index + 1
        while section_end < len(lines) and not _ANY_SECTION_RE.match(lines[section_end]):
            section_end += 1
        allowed_indices = [
            index
            for index in range(core_index + 1, section_end)
            if _ALLOWED_COMMAND_RE.match(lines[index])
        ]
        insert_at = allowed_indices[0] if allowed_indices else section_end
        for index in reversed(allowed_indices):
            del lines[index]
        desired = [
            f"AllowedShellCommands[] = {command}"
            for command in _TEXLOCAL_RESTRICTED_COMMANDS
        ]
        lines[insert_at:insert_at] = desired

    updated = newline.join(lines)
    if trailing_newline:
        updated += newline
    if updated != original:
        _atomic_write(config_path, updated)
    return config_path


def _bundle_fingerprint(paths) -> str:
    """Return a cheap install fingerprint without hashing large executables."""
    parts = []
    for path in paths:
        if not path or not os.path.isfile(path):
            continue
        stat = os.stat(path)
        parts.append(
            f"{os.path.normcase(os.path.realpath(path))}|"
            f"{stat.st_size}|{stat.st_mtime_ns}"
        )
    if not parts:
        return ""
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def ensure_portable_fndb_current(
    app_dir: str,
    *,
    environ=None,
    runtime_root: str | None = None,
    app_executable: str | None = None,
    runner=None,
    timeout: int = 45,
):
    """Refresh the bundled MiKTeX FNDB once per installed app build.

    Installer upgrades can replace MiKTeX's packaged file-name database while
    leaving generated PK fonts in the portable data tree.  MiKTeX then sees the
    physical font during generation but cannot resolve it through ``kpsewhich``.
    ``miktex fndb refresh`` safely reconciles those two views.

    The marker lives in writable LocalAppData, not beside the installed EXE.
    Both successful and failed attempts are recorded so a broken refresh never
    delays every application launch.  A changed app/MiKTeX executable produces
    a new fingerprint and permits one fresh attempt after the next upgrade.
    No administrator mode and no package installation are requested.
    """
    miktex_exe = os.path.join(
        app_dir,
        "miktex",
        "texmfs",
        "install",
        "miktex",
        "bin",
        "x64",
        "miktex.exe",
    )
    if not os.path.isfile(miktex_exe):
        return None

    env_source = os.environ if environ is None else environ
    if runtime_root is None:
        local_app_data = env_source.get("LOCALAPPDATA")
        if not local_app_data:
            return None
        runtime_root = os.path.join(local_app_data, "TexLocal", "runtime")
    os.makedirs(runtime_root, exist_ok=True)

    fingerprint = _bundle_fingerprint((miktex_exe, app_executable))
    if not fingerprint:
        return None
    marker_path = os.path.join(runtime_root, "miktex-fndb-bootstrap.json")
    try:
        with open(marker_path, "r", encoding="utf-8") as handle:
            existing = json.load(handle)
    except (OSError, ValueError, TypeError):
        existing = {}
    if existing.get("fingerprint") == fingerprint:
        return {
            "marker": marker_path,
            "attempted": False,
            "success": bool(existing.get("success")),
            "detail": existing.get("detail", ""),
        }

    command = [miktex_exe, "fndb", "refresh"]
    run = subprocess.run if runner is None else runner
    success = False
    detail = ""
    try:
        completed = run(
            command,
            cwd=app_dir,
            env=dict(env_source),
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        success = completed.returncode == 0
        detail = "\n".join(
            part.strip()
            for part in (completed.stdout or "", completed.stderr or "")
            if part.strip()
        )
        if not success and not detail:
            detail = f"miktex fndb refresh exited with code {completed.returncode}"
    except (OSError, subprocess.TimeoutExpired) as error:
        detail = f"{type(error).__name__}: {error}"

    # Keep support logs bounded; MiKTeX normally emits no output on success.
    detail = detail[:2000]
    record = {
        "schema": 1,
        "fingerprint": fingerprint,
        "success": success,
        "detail": detail,
    }
    _atomic_write(
        marker_path,
        json.dumps(record, ensure_ascii=False, indent=2) + "\n",
    )
    return {
        "marker": marker_path,
        "attempted": True,
        "success": success,
        "detail": detail,
    }
