"""texlocal_helpers.py — pure, stdlib-only helpers extracted from texlocal.py.

Backend split increment 1 (2026-07-06). These have NO Flask/app-config
dependency (no PROJECTS_DIR, no jsonify), so they live here and are
re-imported into texlocal.py's namespace — every existing call site and the
unit tests that reference texlocal.<name> keep resolving unchanged.
Kept in texlocal.py: _safe_project (needs PROJECTS_DIR), _err (needs jsonify).
"""
import os, shutil, tempfile


class _PathError(ValueError):
    """Raised when a user-supplied path would escape its sandbox."""

# Windows reserved device names (case-insensitive, with or without an extension:
# both "CON" and "CON.tex" are refused by the OS). Rejecting them here turns a
# would-be os.makedirs 500 into a clean 400.
_WIN_RESERVED = {"CON", "PRN", "AUX", "NUL"} | \
                {f"COM{i}" for i in range(1, 10)} | \
                {f"LPT{i}" for i in range(1, 10)}
_MAX_PROJECT_NAME = 100

def _project_name_error(name):
    """Return a human-readable reason the project name is invalid, or None if OK.
    v5.0.1 — was only rejecting empty/NUL/dot/slash, so reserved device names,
    trailing dots/spaces, control chars, and `< > : " | ? *` reached os.makedirs
    and surfaced as an opaque 500 on Windows (and could flow into DOM/URLs on
    *nix). Single source of truth for name validity across create/rename/import."""
    if not name:
        return "Project name cannot be empty."
    if len(name) > _MAX_PROJECT_NAME:
        return f"Project name is too long (max {_MAX_PROJECT_NAME} characters)."
    if name in (".", ".."):
        return "Project name cannot be '.' or '..'."
    if "/" in name or "\\" in name:
        return "Project name cannot contain slashes."
    # Control characters (includes NUL) — never valid in a filename.
    if any(ord(ch) < 32 for ch in name):
        return "Project name cannot contain control characters."
    # Characters Windows forbids in filenames.
    if any(ch in name for ch in '<>:"|?*'):
        return 'Project name cannot contain any of: < > : " | ? *'
    # Windows strips trailing dots/spaces, so "foo." and "foo " collide with "foo".
    if name != name.rstrip(". "):
        return "Project name cannot end with a space or a dot."
    # Reserved device names, with or without an extension (CON, CON.tex, ...).
    if name.split(".")[0].upper() in _WIN_RESERVED:
        return "Project name is a reserved Windows device name."
    return None

def _is_safe_project_name(name):
    """Project names must be a single path segment with no traversal.
    Thin bool wrapper over _project_name_error for the many boolean call sites."""
    return _project_name_error(name) is None

def _safe_join(base_abs, *parts):
    """Join base_abs + parts and confirm result stays inside base_abs.
    `base_abs` MUST already be a realpath (e.g. from _safe_project)."""
    target = os.path.realpath(os.path.join(base_abs, *parts))
    if target == base_abs or target.startswith(base_abs + os.sep):
        return target
    raise _PathError("Path escapes project")

def _walk_visible(base):
    """os.walk over `base`, pruning hidden (dot-prefixed) directories in place.
    v4.7.5 — single source of the "skip .git / .texlocal-* / etc." rule that ~11
    endpoints each duplicated. Yields the same (root, dirs, files) tuples as
    os.walk, so call sites keep their loop body; only the header line changes."""
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        # v5.7.0p4 — hide live-preview artifacts (_tlpreview.pdf/.aux/.log/…)
        # everywhere _walk_visible feeds: file tree, export zip, bib/stats
        # scans. They're derived noise, not project content; the /pdf endpoint
        # serves _tlpreview.pdf by direct path so the viewer is unaffected.
        files = [f for f in files if not f.startswith("_tlpreview.")]
        yield root, dirs, files

def _rmtree_force(path):
    """shutil.rmtree that survives Windows read-only files. Git pack objects in
    .git/ are marked read-only, so a plain rmtree raises PermissionError on
    Windows — which broke deleting any project that contains a git repo (now
    common via GitHub import/backup). The handler clears the bit and retries."""
    def _fix(func, p, _exc):
        try:
            os.chmod(p, 0o700)
            func(p)
        except OSError:
            pass
    try:
        shutil.rmtree(path, onexc=_fix)          # Python 3.12+
    except TypeError:
        shutil.rmtree(path, onerror=_fix)        # older Pythons

# v4.3.1 — Atomic file writes. WHY: direct open(path,"w") truncates the
# target the instant it opens; a crash / power-loss / disk-full mid-write
# leaves a half-written (corrupted) source file with no recovery. Writing
# to a sibling .tmp then os.replace() makes the swap atomic on the same
# filesystem — the target is either the old bytes or the full new bytes,
# never a truncated middle. Same pattern already used for snippets/dict;
# this generalises it for the .tex source path (the file that matters most).
def _atomic_write_text(full, content, encoding="utf-8"):
    d = os.path.dirname(full) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".twr_", dir=d)
    try:
        with os.fdopen(fd, "w", encoding=encoding, newline="") as fh:
            fh.write(content)
        os.replace(tmp, full)
    except BaseException:
        try: os.remove(tmp)
        except OSError: pass
        raise

def _atomic_write_bytes(full, data):
    d = os.path.dirname(full) or "."
    fd, tmp = tempfile.mkstemp(prefix=".twr_", dir=d)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, full)
    except BaseException:
        try: os.remove(tmp)
        except OSError: pass
        raise
