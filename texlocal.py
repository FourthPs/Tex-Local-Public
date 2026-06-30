from flask import Flask, request, jsonify, send_file, render_template
import os, sys, subprocess, shutil, zipfile, io, re, gzip, json
import threading, urllib.request, urllib.error, urllib.parse, tempfile, time

# v4.2.0-phase4 — Single source of truth for the running version. Used by:
#   - the startup banner string (printed when running source mode)
#   - the /api/update/check endpoint (compared against GitHub Releases tag)
#   - the frontend update banner ("TexLocal vX.Y.Z available")
# The Inno installer keeps its own MyAppVersion in texlocal.iss; the two
# MUST be bumped together when cutting a release. Discipline reminder in
# HANDOFF section 1.
TEXLOCAL_VERSION = "4.7.10"

# GitHub release-check endpoint. Points to the public repo for update checks and About modal link.
TEXLOCAL_GITHUB_OWNER = "FourthPs"
TEXLOCAL_GITHUB_REPO  = "Tex-Local-Public"
TEXLOCAL_GITHUB_API   = f"https://api.github.com/repos/{TEXLOCAL_GITHUB_OWNER}/{TEXLOCAL_GITHUB_REPO}/releases/latest"
TEXLOCAL_GITHUB_RELEASES_PAGE = f"https://github.com/{TEXLOCAL_GITHUB_OWNER}/{TEXLOCAL_GITHUB_REPO}/releases/latest"

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024

# v4.2.3 - Expose the version constant + GitHub URLs to every Jinja template
# automatically, so dashboard.html / index.html can do {{ texlocal_version }}
# without us having to thread it through each render_template call. The
# repo page (releases/latest) is convenient for the About modal's GitHub
# link too. Context processors are evaluated per-request and very cheap.
@app.context_processor
def _inject_version():
    return {
        "texlocal_version":   TEXLOCAL_VERSION,
        "texlocal_repo_url":  f"https://github.com/{TEXLOCAL_GITHUB_OWNER}/{TEXLOCAL_GITHUB_REPO}",
        "texlocal_releases_url": TEXLOCAL_GITHUB_RELEASES_PAGE,
    }

# v4.0.0-phase2 - In PyInstaller-frozen mode, __file__ resolves into the
# temporary _MEIPASS extraction dir which is wiped between runs. Anchor
# user data (projects/) to sys.executable's dir instead, so it lives
# next to TexLocal.exe and persists. Browser-mode (python texlocal.py)
# behaviour is unchanged: sys.frozen is False, falls through to __file__.
if getattr(sys, "frozen", False):
    APP_BASE = os.path.dirname(sys.executable)
else:
    APP_BASE = os.path.dirname(os.path.abspath(__file__))
PROJECTS_DIR = os.path.join(APP_BASE, "projects")
os.makedirs(PROJECTS_DIR, exist_ok=True)
PROJECTS_DIR_REAL = os.path.realpath(PROJECTS_DIR)

# v4.0.1-phase2 - When TexLocal runs as a windowed (.exe console=False)
# PyInstaller bundle, child processes spawned via subprocess inherit no
# console - Windows then creates a fresh cmd window for each one, which
# flashes briefly on screen (visible during pdflatex/biber/synctex calls).
# CREATE_NO_WINDOW suppresses that. Constant is 0 on non-Windows so source
# mode + Linux/Mac stay unaffected.
SUBPROC_FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


# ── Path safety helpers ──────────────────────────────────────────────
# All user-supplied paths flow through these to prevent traversal attacks
# (e.g. `../../../Windows/System32`) and zip-slip during import.

class _PathError(ValueError):
    """Raised when a user-supplied path would escape its sandbox."""

def _is_safe_project_name(name):
    """Project names must be a single path segment with no traversal."""
    if not name:
        return False
    if "\x00" in name:
        return False
    if name in (".", ".."):
        return False
    # No path separators or parent-dir tokens in the project name itself.
    if "/" in name or "\\" in name:
        return False
    return True

def _safe_project(name):
    """Return absolute project dir path, or raise _PathError."""
    if not _is_safe_project_name(name):
        raise _PathError("Invalid project name")
    p = os.path.realpath(os.path.join(PROJECTS_DIR, name))
    # Must be a direct child of PROJECTS_DIR (allow == when name is exactly
    # rejected above, so this is just defence in depth).
    if not (p == PROJECTS_DIR_REAL or p.startswith(PROJECTS_DIR_REAL + os.sep)):
        raise _PathError("Invalid project name")
    return p

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
        yield root, dirs, files


def _err(msg, code=400):
    return jsonify({"error": msg}), code

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


# ── SyncTeX direct parser ─────────────────────────────────────────────
# MiKTeX's `synctex view` aggregates everything into the topmost vbox/hbox,
# which is too coarse for line-level highlighting. The .synctex(.gz) file
# itself contains per-line position records (h, x, g, k) that we can use
# directly. This parser reads the file once (cached by mtime) and returns
# an index { (input_tag, source_line): [{type, page, x, y, w, h}, ...] }.
#
# Coordinate conversion:
#   Numbers in the file are in scaled points (sp); 1 pt = 65536 sp.
#   We convert to pt to match `synctex view`'s text output and the existing
#   frontend expectations.
#   y is measured from the TOP of the page (TeX convention).

_SP_PER_PT  = 65536.0
_SX_REC_RE  = re.compile(
    r'^([\[\(hvxgk])'
    r'(\d+),(\d+)(?:,\d+)?'
    r':(-?\d+(?:\.\d+)?),'
    r'(-?\d+(?:\.\d+)?)'
    r'(?::(-?\d+(?:\.\d+)?),'
    r'(-?\d+(?:\.\d+)?)'
    r'(?:,-?\d+(?:\.\d+)?)?'    # depth — discarded
    r')?'
)
_synctex_parse_cache = {}   # path → (mtime, parsed)

def _synctex_load_text(synctex_path):
    if synctex_path.endswith(".gz"):
        with gzip.open(synctex_path, "rb") as fh:
            return fh.read().decode("utf-8", errors="replace")
    with open(synctex_path, "rb") as fh:
        return fh.read().decode("utf-8", errors="replace")

def _synctex_parse_per_line(synctex_path):
    """Return parsed = {
        'input_map': {tag(int): abs_path(str)},
        'line_records': {(tag, line): [ {type, page, x_pt, y_pt, w_pt?, h_pt?} ]},
        'page_count': int,
        'mag': float,   # magnification (default 1000 → 1.0 unit)
        'unit': float,
    }
    Cached by file mtime — reparse only when the file changes.
    """
    try:
        mtime = os.path.getmtime(synctex_path)
    except OSError:
        raise FileNotFoundError(synctex_path)

    cached = _synctex_parse_cache.get(synctex_path)
    if cached and cached[0] == mtime:
        return cached[1]

    text = _synctex_load_text(synctex_path)
    lines_iter = text.splitlines()

    input_map = {}
    mag  = 1000.0
    unit = 1.0
    in_content = False
    page = None
    page_count = 0
    line_records = {}

    # Magnification & Unit affect the conversion. Spec: pt = sp * mag/1000 * unit / 65536
    # SyncTeX content section markers (per the format spec):
    #   {<sheet>     — page (sheet) OPEN
    #   }            — page CLOSE
    #   [<tag>,<line>:<x>,<y>:<w>,<h>,<d>   — vbox OPEN  (NOT a page!)
    #   ]            — vbox CLOSE
    #   (<tag>,<line>:<x>,<y>:<w>,<h>,<d>   — hbox OPEN
    #   )            — hbox CLOSE
    #   h/v/x/g/k/etc — single-line content records
    for ln in lines_iter:
        if not in_content:
            if ln.startswith("Input:"):
                try:
                    _, tag_s, fpath = ln.split(":", 2)
                    input_map[int(tag_s)] = fpath
                except (ValueError, IndexError):
                    pass
            elif ln.startswith("Magnification:"):
                try: mag = float(ln.split(":", 1)[1].strip())
                except (ValueError, IndexError): pass
            elif ln.startswith("Unit:"):
                try: unit = float(ln.split(":", 1)[1].strip())
                except (ValueError, IndexError): pass
            elif ln.strip() == "Content:":
                in_content = True
            continue
        if not ln:
            continue
        # v4.4.1 — SyncTeX emits Input: declarations BOTH in the preamble AND
        # interleaved through the Content section: a file's Input record is
        # written when TeX first OPENS it, and \input-ed chapter files
        # (Content/01.tex, Appendix/A01.tex, ...) are opened mid-document.
        # The old parser stopped collecting Input lines at the "Content:"
        # marker, so every chapter file declared mid-content was missing from
        # input_map -> forward sync returned "not found in synctex Input map".
        # (MainPage.tex worked only because it's opened first, in the preamble.)
        # Keep harvesting Input lines here so all source files resolve.
        if ln.startswith("Input:"):
            try:
                _, tag_s, fpath = ln.split(":", 2)
                input_map[int(tag_s)] = fpath
            except (ValueError, IndexError):
                pass
            continue
        c0 = ln[0]
        # Page (sheet) tracking
        if c0 == "{":
            m = re.match(r'^\{(\d+)', ln)
            if m:
                page = int(m.group(1))
                page_count = max(page_count, page)
            continue
        if c0 == "}":
            page = None
            continue
        # [ ] and ( ) are vbox/hbox markers — they CAN carry tag/line info too,
        # so we let them flow into the regex below; do NOT confuse them with page.
        m = _SX_REC_RE.match(ln)
        if not m:
            continue
        rtype, tag_s, line_s, x_s, y_s, w_s, h_s = m.groups()
        try:
            tag      = int(tag_s)
            src_line = int(line_s)
            x_sp     = float(x_s)
            y_sp     = float(y_s)
        except ValueError:
            continue
        # Convert sp → pt with magnification/unit.
        # Practical: most files have mag=1000, unit=1 → divide by 65536.
        scale = (mag / 1000.0) * unit / _SP_PER_PT
        rec = {
            "type": rtype,
            "page": page,
            "x":    x_sp * scale,
            "y":    y_sp * scale,
        }
        if w_s is not None:
            try: rec["w"] = float(w_s) * scale
            except ValueError: pass
        if h_s is not None:
            try: rec["h"] = float(h_s) * scale
            except ValueError: pass
        line_records.setdefault((tag, src_line), []).append(rec)

    parsed = {
        "input_map":    input_map,
        "line_records": line_records,
        "page_count":   page_count,
        "mag":          mag,
        "unit":         unit,
    }
    _synctex_parse_cache[synctex_path] = (mtime, parsed)
    return parsed


def _synctex_resolve_tag(input_map, project_dir, file_rel):
    """Find the input tag matching file_rel (relative to project_dir).
    Falls back to basename match if absolute path doesn't match."""
    target_abs = os.path.normcase(os.path.normpath(os.path.join(project_dir, file_rel)))
    for tag, fpath in input_map.items():
        if os.path.normcase(os.path.normpath(fpath)) == target_abs:
            return tag
    bn = os.path.basename(file_rel).lower()
    for tag, fpath in input_map.items():
        if os.path.basename(fpath).lower() == bn:
            return tag
    return None

@app.route("/")
def dashboard():
    return render_template("dashboard.html")

@app.route("/editor")
def editor():
    return render_template("index.html")

@app.route("/api/projects", methods=["GET"])
def list_projects():
    projects = []
    for name in os.listdir(PROJECTS_DIR):
        path = os.path.join(PROJECTS_DIR, name)
        if not os.path.isdir(path):
            continue
        tex_count = 0
        try:
            for r, dirs, fs in _walk_visible(path):
                tex_count += sum(1 for f in fs if f.endswith(".tex"))
        except Exception:
            pass
        projects.append({
            "name": name,
            "modified": os.path.getmtime(path),
            "tex_files": tex_count
        })
    projects.sort(key=lambda x: x["modified"], reverse=True)
    return jsonify(projects)

TEMPLATES = {
    "article": (
        "\\documentclass[12pt]{article}\n"
        "\\usepackage[utf8]{inputenc}\n"
        "\\usepackage{amsmath,amssymb}\n"
        "\\usepackage{graphicx}\n"
        "\\title{My Document}\n"
        "\\author{Author}\n"
        "\\date{\\today}\n"
        "\\begin{document}\n"
        "\\maketitle\n"
        "\\section{Introduction}\n"
        "Hello, World!\n"
        "\\end{document}\n"
    ),
    "beamer": (
        "\\documentclass{beamer}\n"
        "\\usetheme{Madrid}\n"
        "\\title{Presentation Title}\n"
        "\\author{Author}\n"
        "\\date{\\today}\n"
        "\\begin{document}\n"
        "\\begin{frame}\n"
        "\\titlepage\n"
        "\\end{frame}\n\n"
        "\\begin{frame}{Outline}\n"
        "\\tableofcontents\n"
        "\\end{frame}\n\n"
        "\\section{Introduction}\n"
        "\\begin{frame}{Introduction}\n"
        "  \\begin{itemize}\n"
        "    \\item First point\n"
        "    \\item Second point\n"
        "  \\end{itemize}\n"
        "\\end{frame}\n\n"
        "\\end{document}\n"
    ),
    "thesis": (
        "\\documentclass[12pt,a4paper]{report}\n"
        "\\usepackage{fontspec}\n"
        "\\usepackage{polyglossia}\n"
        "\\setmainlanguage{thai}\n"
        "\\setotherlanguage{english}\n"
        "\\setmainfont{TH Sarabun New}\n"
        "\\usepackage{amsmath,amssymb}\n"
        "\\usepackage{graphicx}\n"
        "\\usepackage{hyperref}\n"
        "\\title{Thesis Title}\n"
        "\\author{Author}\n"
        "\\date{\\today}\n"
        "\\begin{document}\n"
        "\\maketitle\n"
        "\\tableofcontents\n"
        "\\chapter{Introduction}\n"
        "\\section{Background}\n"
        "\n"
        "\\chapter{Methodology}\n"
        "\n"
        "\\chapter{Results}\n"
        "\n"
        "\\chapter{Conclusion}\n"
        "\n"
        "\\end{document}\n"
    ),
    "blank": "",
}

@app.route("/api/projects", methods=["POST"])
def create_project():
    data = request.get_json(silent=True) or {}
    name     = data.get("name", "").strip()
    template = data.get("template", "article")
    if not name:
        return _err("Name required")
    if not _is_safe_project_name(name):
        return _err("Invalid project name (no slashes or `..`)")
    path = os.path.join(PROJECTS_DIR, name)
    if os.path.exists(path):
        return _err("Project exists")
    os.makedirs(path)
    content = TEMPLATES.get(template, TEMPLATES["article"])
    with open(os.path.join(path, "main.tex"), "w", encoding="utf-8") as f:
        f.write(content)
    return jsonify({"name": name})

@app.route("/api/projects/<name>", methods=["DELETE"])
def delete_project(name):
    try:
        path = _safe_project(name)
    except _PathError as e:
        return _err(str(e))
    if os.path.exists(path):
        _rmtree_force(path)
    return jsonify({"ok": True})

@app.route("/api/projects/<name>/rename", methods=["POST"])
def rename_project(name):
    new_name = (request.get_json(silent=True) or {}).get("name", "").strip()
    if not new_name:
        return _err("Name required")
    if not _is_safe_project_name(new_name):
        return _err("Invalid project name")
    try:
        src = _safe_project(name)
    except _PathError as e:
        return _err(str(e))
    dst = os.path.join(PROJECTS_DIR, new_name)
    if not os.path.exists(src):
        return _err("Project not found", 404)
    if os.path.exists(dst):
        return _err("Name already taken")
    os.rename(src, dst)
    return jsonify({"ok": True, "name": new_name})

@app.route("/api/projects/<name>/duplicate", methods=["POST"])
def duplicate_project(name):
    new_name = (request.get_json(silent=True) or {}).get("name", "").strip()
    if not new_name:
        new_name = name + "-copy"
    if not _is_safe_project_name(new_name):
        return _err("Invalid project name")
    try:
        src = _safe_project(name)
    except _PathError as e:
        return _err(str(e))
    dst = os.path.join(PROJECTS_DIR, new_name)
    if not os.path.exists(src):
        return _err("Project not found", 404)
    if os.path.exists(dst):
        return _err("Name already taken")
    shutil.copytree(src, dst)
    return jsonify({"ok": True, "name": new_name})

@app.route("/api/projects/<project>/files", methods=["GET"])
def list_files(project):
    try:
        path = _safe_project(project)
    except _PathError as e:
        return _err(str(e))
    files = []
    for root, dirs, filenames in _walk_visible(path):
        for f in filenames:
            rel = os.path.relpath(os.path.join(root, f), path)
            files.append(rel.replace("\\", "/"))
    files.sort()
    return jsonify(files)

@app.route("/api/projects/<project>/file", methods=["GET"])
def read_file(project):
    filepath = request.args.get("path", "")
    try:
        full = _safe_join(_safe_project(project), filepath)
    except _PathError as e:
        return _err(str(e))
    if not os.path.exists(full):
        return _err("Not found", 404)
    with open(full, "r", encoding="utf-8", errors="replace") as f:
        return jsonify({"content": f.read()})

@app.route("/api/projects/<project>/file", methods=["POST"])
def write_file(project):
    data = request.get_json(silent=True) or {}
    filepath = data.get("path", "")
    content  = data.get("content", "")
    try:
        full = _safe_join(_safe_project(project), filepath)
    except _PathError as e:
        return _err(str(e))
    # v4.3.1 — atomic write so a crash mid-save can't truncate the .tex source
    try:
        _atomic_write_text(full, content)
    except OSError as e:
        return _err(f"Could not save file: {e}", 500)
    return jsonify({"ok": True})

@app.route("/api/projects/<project>/file", methods=["DELETE"])
def delete_file(project):
    filepath = request.args.get("path", "")
    try:
        full = _safe_join(_safe_project(project), filepath)
    except _PathError as e:
        return _err(str(e))
    # v4.7.10 — os.remove() raises IsADirectoryError on a folder → unhandled 500.
    # Reject directories explicitly (folder deletion isn't this endpoint's job).
    if os.path.isdir(full):
        return _err("Path is a directory, not a file", 400)
    if os.path.exists(full):
        os.remove(full)
    return jsonify({"ok": True})

@app.route("/api/projects/<project>/movefile", methods=["POST"])
def move_file(project):
    data = request.get_json(silent=True) or {}
    src  = data.get("src", "").strip()
    dst  = data.get("dst", "").strip()
    if not src or not dst or src == dst:
        return _err("Invalid paths")
    try:
        proj = _safe_project(project)
        src_full = _safe_join(proj, src)
        dst_full = _safe_join(proj, dst)
    except _PathError as e:
        return _err(str(e))
    if not os.path.exists(src_full):
        return _err("Source not found", 404)
    # v4.3.1 — refuse to clobber an existing destination silently (was data loss)
    if os.path.exists(dst_full):
        return _err("Destination already exists", 409)
    dst_dir = os.path.dirname(dst_full)
    if dst_dir:
        os.makedirs(dst_dir, exist_ok=True)
    shutil.move(src_full, dst_full)
    return jsonify({"ok": True})

@app.route("/api/projects/<project>/upload", methods=["POST"])
def upload_files(project):
    try:
        project_path = _safe_project(project)
        target_dir_in = request.form.get("dir", "").strip()
        upload_dir = _safe_join(project_path, target_dir_in) if target_dir_in else project_path
    except _PathError as e:
        return _err(str(e))
    os.makedirs(upload_dir, exist_ok=True)
    saved = []
    skipped = []  # v4.3.1 — names that already existed and were not overwritten
    for f in request.files.getlist("files"):
        if not f.filename:
            continue
        # Strip any client-supplied path components — uploads land in upload_dir only
        filename = os.path.basename(f.filename)
        if not filename or filename in (".", ".."):
            continue
        try:
            dest = _safe_join(upload_dir, filename)
        except _PathError:
            continue
        # v4.3.1 — skip existing files instead of silently overwriting
        # (was data loss: re-uploading a same-named figure clobbered it).
        if os.path.exists(dest):
            skipped.append(os.path.relpath(dest, project_path).replace("\\", "/"))
            continue
        f.save(dest)
        rel = os.path.relpath(dest, project_path).replace("\\", "/")
        saved.append(rel)
    return jsonify({"ok": True, "files": saved, "skipped": skipped})

@app.route("/api/import-zip", methods=["POST"])
def import_zip():
    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400
    zf_upload = request.files["file"]
    name = request.form.get("name", "").strip()
    if not name:
        name = os.path.splitext(zf_upload.filename or "project")[0]
    name = "".join(c if c.isalnum() or c in "-_ " else "_" for c in name).strip() or "imported-project"
    if not _is_safe_project_name(name):
        return _err("Invalid project name")
    project_path = os.path.join(PROJECTS_DIR, name)
    if os.path.exists(project_path):
        return _err(f'Project "{name}" already exists')
    os.makedirs(project_path)
    project_real = os.path.realpath(project_path)
    try:
        with zipfile.ZipFile(zf_upload, "r") as zf:
            all_names = zf.namelist()
            non_dir   = [n for n in all_names if not n.endswith("/")]
            top_dirs  = {n.split("/")[0] for n in non_dir}
            root_files = [n for n in non_dir if "/" not in n]
            prefix = (list(top_dirs)[0] + "/") if len(top_dirs) == 1 and not root_files else ""
            for item in all_names:
                if item.endswith("/"):
                    continue
                rel = item[len(prefix):] if prefix and item.startswith(prefix) else item
                if not rel:
                    continue
                # ── Zip-slip protection ──────────────────────────────
                # Reject absolute paths and any entry that resolves outside
                # the project dir (e.g. `../../evil.exe` or `/etc/passwd`).
                if rel.startswith("/") or rel.startswith("\\") or (len(rel) > 1 and rel[1] == ":"):
                    raise ValueError(f"Zip entry has absolute path: {item}")
                target = os.path.realpath(os.path.join(project_path, rel))
                if not (target == project_real or target.startswith(project_real + os.sep)):
                    raise ValueError(f"Zip entry escapes project dir: {item}")
                os.makedirs(os.path.dirname(target) if os.path.dirname(target) else project_path, exist_ok=True)
                with zf.open(item) as src, open(target, "wb") as dst:
                    dst.write(src.read())
        return jsonify({"ok": True, "name": name})
    except Exception as e:
        shutil.rmtree(project_path, ignore_errors=True)
        return _err(str(e), 500)

@app.route("/api/projects/<project>/newfolder", methods=["POST"])
def new_folder(project):
    data   = request.get_json(silent=True) or {}
    folder = data.get("path", "").strip()
    if not folder:
        return _err("Path required")
    try:
        full = _safe_join(_safe_project(project), folder)
    except _PathError as e:
        return _err(str(e))
    os.makedirs(full, exist_ok=True)
    keep = os.path.join(full, ".keep")
    if not os.path.exists(keep):
        with open(keep, "w") as _:
            pass
    return jsonify({"ok": True})

@app.route("/api/projects/<project>/newfile", methods=["POST"])
def new_file(project):
    data     = request.get_json(silent=True) or {}
    filepath = data.get("path", "").strip()
    try:
        proj = _safe_project(project)
        full = _safe_join(proj, filepath)
    except _PathError as e:
        return _err(str(e))
    base_dir = os.path.dirname(full) or proj
    os.makedirs(base_dir, exist_ok=True)
    if not os.path.exists(full):
        with open(full, "w") as _:
            pass
    return jsonify({"ok": True})

@app.route("/api/projects/<project>/detect-main", methods=["GET"])
def detect_main(project):
    try:
        path = _safe_project(project)
    except _PathError as e:
        return _err(str(e))
    if not os.path.exists(path):
        return jsonify({"main": "main.tex"})
    tex_files = []
    for root, dirs, files in _walk_visible(path):
        for f in files:
            if f.endswith(".tex"):
                full = os.path.join(root, f)
                rel  = os.path.relpath(full, path).replace("\\", "/")
                tex_files.append((rel, full))
    tex_files.sort(key=lambda x: (0 if x[0] == "main.tex" else 1, x[0]))
    for rel, full in tex_files:
        try:
            with open(full, "rb") as fh:
                raw = fh.read(4096)
            text = raw.lstrip(b"\xef\xbb\xbf").decode("utf-8", errors="replace")
            if "\\documentclass" in text:
                return jsonify({"main": rel})
        except Exception:
            pass
    return jsonify({"main": "main.tex"})

@app.route("/api/projects/<project>/export-zip", methods=["GET"])
def export_zip(project):
    try:
        path = _safe_project(project)
    except _PathError:
        return "Invalid project name", 400
    if not os.path.exists(path):
        return "Project not found", 404
    buf = io.BytesIO()
    SKIP_EXTS  = {".aux",".log",".toc",".out",".bbl",".blg",".fls",".bcf",
                  ".lof",".lot",".nav",".snm",".vrb",".xdv",".gz",".fdb_latexmk"}
    SKIP_NAMES = {".keep"}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in _walk_visible(path):
            for fname in files:
                if fname in SKIP_NAMES or fname.endswith(".run.xml"):
                    continue
                if os.path.splitext(fname)[1].lower() in SKIP_EXTS:
                    continue
                full = os.path.join(root, fname)
                rel  = os.path.relpath(full, path).replace("\\", "/")
                zf.write(full, rel)
    buf.seek(0)
    return send_file(buf, mimetype="application/zip",
                     as_attachment=True, download_name=f"{project}.zip")

# ── GitHub integration (v4.4.0) ──────────────────────────────────────
# Per-project Backup (init/commit/create/push) + Import (clone) + a real
# in-app "Sign in with GitHub" via the OAuth device flow. Auth prefers an
# in-app OAuth token (no CLI needed); falls back to the gh CLI when present.

# A LaTeX-aware .gitignore so build artifacts (and the .aux_files cache) never
# get committed. Mirrors export-zip's SKIP_EXTS.
_GITIGNORE_TEX = (
    "# TexLocal — LaTeX build artifacts (auto-generated)\n"
    "*.aux\n*.log\n*.toc\n*.out\n*.bbl\n*.blg\n*.fls\n*.bcf\n"
    "*.lof\n*.lot\n*.nav\n*.snm\n*.vrb\n*.xdv\n*.fdb_latexmk\n"
    "*.synctex.gz\n*.run.xml\n.aux_files/\n"
)

def _run(cmd, cwd=None, timeout=60):
    """Run a subprocess; return (rc, stdout, stderr). Never raises."""
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                           timeout=timeout, stdin=subprocess.DEVNULL,
                           creationflags=SUBPROC_FLAGS)
        return r.returncode, (r.stdout or ""), (r.stderr or "")
    except FileNotFoundError:
        return 127, "", f"{cmd[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"{cmd[0]}: timed out after {timeout}s"

def _gh_available():
    rc, _out, _err = _run(["gh", "--version"], timeout=10)
    return rc == 0

# ── In-app GitHub OAuth (device flow) ────────────────────────────────
# Register an OAuth App at github.com/settings/developers (enable Device Flow);
# the client id is public (no secret), safe to ship. Override via env var.
GITHUB_CLIENT_ID = os.environ.get("TEXLOCAL_GITHUB_CLIENT_ID", "").strip() or "Ov23liYkjm4KmhEtKMHR"

def _config_dir():
    if os.name == "nt":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        d = os.path.join(base, "TexLocal")
    else:
        d = os.path.join(os.path.expanduser("~"), ".config", "texlocal")
    os.makedirs(d, exist_ok=True)
    return d

def _gh_token_path():
    return os.path.join(_config_dir(), "github-auth.json")

def _gh_token_load():
    try:
        with open(_gh_token_path(), encoding="utf-8") as f:
            d = json.load(f)
        return d if d.get("token") else None
    except (OSError, ValueError):
        return None

def _gh_token_save(token, account):
    try:
        with open(_gh_token_path(), "w", encoding="utf-8") as f:
            json.dump({"token": token, "account": account}, f)
    except OSError:
        pass

def _gh_token_clear():
    try:
        os.remove(_gh_token_path())
    except OSError:
        pass

def _gh_api(method, url, token=None, data=None):
    """Call the GitHub REST API. Returns (status_code, parsed_json_or_None)."""
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "TexLocal"}
    if token:
        headers["Authorization"] = "Bearer " + token
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        try:    return e.code, json.loads(e.read().decode() or "null")
        except Exception: return e.code, None
    except Exception as e:
        return 0, {"message": str(e)}

def _gh_oauth_post(url, fields):
    """Form-POST to GitHub's OAuth endpoints (Accept: json)."""
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Accept": "application/json",
                                          "User-Agent": "TexLocal"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        try:    return e.code, json.loads(e.read().decode() or "null")
        except Exception: return e.code, None
    except Exception as e:
        return 0, {"error": str(e)}

def _authed_clone_url(url, token):
    """https URL with the token embedded, for clone/push of private repos
    without a credential helper. Accepts a full github URL or owner/repo."""
    if re.match(r"^[\w.-]+/[\w.-]+$", url):
        owner_repo = url
    else:
        m = re.search(r"github\.com[/:]([\w.-]+/[\w.-]+?)(?:\.git)?/?$", url)
        owner_repo = m.group(1) if m else None
    if not owner_repo:
        return None
    return f"https://x-access-token:{token}@github.com/{owner_repo}.git"

def _gh_status():
    """{installed, logged_in, account, mode}. Prefers an in-app OAuth token;
    falls back to the gh CLI so pre-existing setups keep working."""
    tok = _gh_token_load()
    if tok:
        return {"installed": True, "logged_in": True,
                "account": tok.get("account"), "mode": "oauth"}
    if not _gh_available():
        return {"installed": False, "logged_in": False,
                "account": None, "mode": None}
    rc, out, err = _run(["gh", "auth", "status"], timeout=15)
    text = (out or "") + "\n" + (err or "")
    logged_in = ("Logged in to github.com" in text)
    m = (re.search(r"Logged in to github\.com account\s+(\S+)", text)
         or re.search(r"Logged in to github\.com as\s+(\S+)", text)
         or re.search(r"account\s+(\S+)", text))
    return {"installed": True, "logged_in": logged_in,
            "account": (m.group(1) if m else None), "mode": "gh"}

# In-memory pending device-flow state (single local user → module global).
_gh_device = {}

@app.route("/api/github/status", methods=["GET"])
def github_status():
    return jsonify(_gh_status())

@app.route("/api/github/login", methods=["POST"])
def github_login():
    """Start the OAuth device flow. Returns a user code + verification URL; the
    UI then polls /api/github/login/poll until the user authorises. Already-
    signed-in is a no-op."""
    st = _gh_status()
    if st["logged_in"]:
        return jsonify({"ok": True, "already": True, "account": st["account"]})
    if not GITHUB_CLIENT_ID:
        return _err("In-app GitHub sign-in isn't configured yet. Register a "
                    "GitHub OAuth App (enable Device Flow) and set its client "
                    "id in TEXLOCAL_GITHUB_CLIENT_ID.", 400)
    status, data = _gh_oauth_post(
        "https://github.com/login/device/code",
        {"client_id": GITHUB_CLIENT_ID, "scope": "repo read:user"})
    if status != 200 or not data or "device_code" not in data:
        return _err("Could not start GitHub sign-in: "
                    + (str(data) if data else "no response from GitHub"), 502)
    _gh_device.clear()
    _gh_device.update({
        "device_code": data["device_code"],
        "interval":    int(data.get("interval", 5)),
        "expires_at":  time.time() + int(data.get("expires_in", 900)),
    })
    return jsonify({
        "ok": True, "started": True,
        "user_code":        data.get("user_code"),
        "verification_uri": data.get("verification_uri", "https://github.com/login/device"),
        "interval":         _gh_device["interval"],
    })

@app.route("/api/github/login/poll", methods=["POST"])
def github_login_poll():
    """Poll GitHub for the device-flow token. On success, store it per-user."""
    if not _gh_device.get("device_code"):
        return jsonify({"status": "error", "error": "No sign-in in progress."})
    if time.time() > _gh_device.get("expires_at", 0):
        _gh_device.clear()
        return jsonify({"status": "error", "error": "Code expired — try again."})
    status, data = _gh_oauth_post(
        "https://github.com/login/oauth/access_token",
        {"client_id":  GITHUB_CLIENT_ID,
         "device_code": _gh_device["device_code"],
         "grant_type":  "urn:ietf:params:oauth:grant-type:device_code"})
    if not data:
        return jsonify({"status": "pending"})
    err = data.get("error")
    if err == "authorization_pending":
        return jsonify({"status": "pending"})
    if err == "slow_down":
        _gh_device["interval"] = int(data.get("interval", _gh_device.get("interval", 5) + 5))
        return jsonify({"status": "pending", "interval": _gh_device["interval"]})
    if err:
        _gh_device.clear()
        return jsonify({"status": "error", "error": data.get("error_description") or err})
    token = data.get("access_token")
    if not token:
        return jsonify({"status": "pending"})
    _, who = _gh_api("GET", "https://api.github.com/user", token=token)
    account = who.get("login") if isinstance(who, dict) else None
    _gh_token_save(token, account)
    _gh_device.clear()
    return jsonify({"status": "authorized", "account": account})

@app.route("/api/github/logout", methods=["POST"])
def github_logout():
    """Sign out: forget the stored OAuth token. (gh CLI sessions are managed
    by `gh auth logout`, not us.)"""
    had = _gh_token_load() is not None
    _gh_token_clear()
    _gh_device.clear()
    return jsonify({"ok": True, "was_oauth": had})

@app.route("/api/github/open-verify", methods=["POST"])
def github_open_verify():
    """Open the GitHub device-verification page in the user's SYSTEM browser.
    The WebView2 desktop build can't satisfy JS window.open() with a real
    browser tab (no popup/new-window host), so the frontend asks us to launch
    the OS browser instead. Restricted to GitHub's own login/device URLs so this
    can't be turned into an open-redirect / arbitrary-launcher."""
    import webbrowser
    url = (request.json or {}).get("url") or "https://github.com/login/device"
    if not re.match(r"^https://github\.com/login(/device)?([/?]|$)", url):
        url = "https://github.com/login/device"
    try:
        webbrowser.open(url, new=2)
        return jsonify({"ok": True})
    except Exception as e:
        return _err(f"Could not open the system browser: {e}", 500)

@app.route("/api/github/repos", methods=["GET"])
def github_repos():
    """List the signed-in user's repositories (newest first) for the import
    dialog's dropdown."""
    st = _gh_status()
    if not st["logged_in"]:
        return _err("Not signed in to GitHub.", 401)
    tok = _gh_token_load()
    if tok:                                            # OAuth → REST API
        repos = []
        for page in range(1, 6):                       # up to 500 repos
            code, data = _gh_api("GET",
                "https://api.github.com/user/repos"
                f"?per_page=100&sort=updated&affiliation=owner&page={page}",
                token=tok["token"])
            # v4.7.10 — _gh_api returns code 0 on network/timeout. Don't let
            # that masquerade as "no repos" (empty list, HTTP 200) — surface it
            # so the import dialog can say "couldn't reach GitHub".
            if code == 0 and page == 1:
                msg = data.get("message") if isinstance(data, dict) else "network error"
                return _err(f"Could not reach GitHub: {msg}", 502)
            if code != 200 or not isinstance(data, list) or not data:
                break
            for r in data:
                repos.append({
                    "nameWithOwner": r.get("full_name"),
                    "url":           r.get("html_url"),
                    "visibility":    "private" if r.get("private") else "public",
                    "description":   r.get("description"),
                    "updatedAt":     r.get("updated_at"),
                })
            if len(data) < 100:
                break
        return jsonify({"repos": repos, "account": st.get("account")})
    if not st["installed"]:                            # fallback → gh CLI
        return _err("GitHub CLI (gh) is not installed.", 400)
    rc, out, err = _run(
        ["gh", "repo", "list", "--no-archived", "--limit", "200", "--json",
         "nameWithOwner,url,visibility,description,updatedAt"], timeout=30)
    if rc != 0:
        return _err((err or out or "Failed to list repositories.").strip()[-400:], 500)
    try:
        repos = json.loads(out or "[]")
    except ValueError:
        repos = []
    repos.sort(key=lambda r: r.get("updatedAt") or "", reverse=True)
    return jsonify({"repos": repos, "account": st.get("account")})

@app.route("/api/github/import", methods=["POST"])
def github_import():
    """Clone a GitHub repo into projects/<name> as a new project."""
    data = request.json or {}
    url  = (data.get("url") or "").strip()
    if not url:
        return _err("Enter a GitHub repository URL.")
    if not (re.match(r"^https?://", url, re.I) or re.match(r"^[\w.-]+/[\w.-]+$", url)):
        return _err("Enter an https:// GitHub URL or owner/repo.")
    raw = (data.get("name") or "").strip()
    if not raw:
        raw = re.sub(r"\.git$", "", url.rstrip("/").split("/")[-1])
    name = re.sub(r"[^A-Za-z0-9_\- ]", "_", raw).strip() or "imported-repo"
    if not _is_safe_project_name(name):
        return _err("Invalid project name derived from the URL.")
    try:
        dest = _safe_project(name)
    except _PathError as e:
        return _err(str(e))
    if os.path.exists(dest):
        return _err(f'A project named "{name}" already exists.', 409)

    tok = _gh_token_load()
    if tok:
        authed = _authed_clone_url(url, tok["token"])
        if not authed:
            return _err("Could not parse that GitHub repository URL.")
        rc, out, err = _run(["git", "clone", authed, dest], timeout=300)
        if rc == 0:
            clean = _authed_clone_url(url, "").replace("x-access-token:@", "")
            if clean:
                _run(["git", "remote", "set-url", "origin", clean], cwd=dest)
    elif _gh_available():
        rc, out, err = _run(["gh", "repo", "clone", url, dest], timeout=300)
    else:
        rc, out, err = _run(["git", "clone", url, dest], timeout=300)
    if rc != 0:
        if os.path.isdir(dest):
            _rmtree_force(dest)
        emsg = (err or out or "clone failed").strip()[-600:]
        if tok:
            emsg = emsg.replace(tok["token"], "***")
        return jsonify({"ok": False, "error": emsg}), 500
    return jsonify({"ok": True, "name": name})

@app.route("/api/projects/<project>/github/backup", methods=["POST"])
def github_backup(project):
    try:
        path = _safe_project(project)
    except _PathError as e:
        return _err(str(e))
    if not os.path.isdir(path):
        return _err("Project not found", 404)

    data    = request.json or {}
    message = (data.get("message") or "").strip() or "Backup from TexLocal"
    repo    = (data.get("repo") or project).strip() or project
    private = data.get("private", True)
    vis     = "--private" if private else "--public"

    st = _gh_status()
    if not st["logged_in"]:
        return _err("Not signed in to GitHub. Use the Sign in button first.", 401)

    steps = []
    def step(label, rc, out, err):
        steps.append({"step": label, "ok": rc == 0,
                      "out": (out or "").strip()[-600:],
                      "err": (err or "").strip()[-600:]})
        return rc == 0

    if not os.path.isdir(os.path.join(path, ".git")):
        rc, out, err = _run(["git", "init", "-b", "main"], cwd=path)
        if rc != 0:
            # older git without -b: fall back to plain init + checkout
            rc, out, err = _run(["git", "init"], cwd=path)
            if rc == 0:
                _run(["git", "checkout", "-b", "main"], cwd=path)
        # v4.7.10 — report the REAL rc (was hardcoded 0). If git is missing
        # (rc 127) the old code claimed success then failed confusingly at
        # `git add`; now we surface it and bail with the actual error.
        if not step("git init", rc, out or "initialised empty repository", err):
            return jsonify({"ok": False, "steps": steps}), 500

    gi = os.path.join(path, ".gitignore")
    if not os.path.exists(gi):
        try:
            with open(gi, "w", encoding="utf-8") as f:
                f.write(_GITIGNORE_TEX)
        except OSError:
            pass

    rc, name_out, _ = _run(["git", "config", "user.name"], cwd=path)
    if rc != 0 or not name_out.strip():
        acct = st.get("account") or "TexLocal"
        _run(["git", "config", "user.name", acct], cwd=path)
        _run(["git", "config", "user.email",
              f"{acct}@users.noreply.github.com"], cwd=path)

    step("git add", *_run(["git", "add", "-A"], cwd=path))
    rc, out, err = _run(["git", "commit", "-m", message], cwd=path)
    nothing = "nothing to commit" in (out + err).lower()
    if rc != 0 and not nothing:
        step("git commit", rc, out, err)
        return jsonify({"ok": False, "steps": steps}), 500
    step("git commit", 0,
         "nothing to commit (already up to date)" if nothing else out, err)

    rc, remote_out, _ = _run(["git", "remote", "get-url", "origin"], cwd=path)
    has_remote = rc == 0 and remote_out.strip()
    tok = _gh_token_load()
    repo_url = ""
    if has_remote:
        repo_url = remote_out.strip()
        if tok:
            authed = _authed_clone_url(repo_url, tok["token"]) or repo_url
            ok = step("git push", *_run(["git", "push", authed, "HEAD:main"],
                                        cwd=path, timeout=180))
        else:
            ok = step("git push", *_run(["git", "push", "origin", "HEAD"],
                                        cwd=path, timeout=180))
    elif tok:
        code, data2 = _gh_api("POST", "https://api.github.com/user/repos",
                             token=tok["token"],
                             data={"name": repo, "private": bool(private)})
        if code not in (200, 201) or not isinstance(data2, dict) or not data2.get("clone_url"):
            step("create repo", 1, "", (data2 or {}).get("message", "could not create repository"))
            return jsonify({"ok": False, "steps": steps}), 500
        repo_url = data2.get("html_url", "")
        clean = data2["clone_url"]
        _run(["git", "remote", "add", "origin", clean], cwd=path)
        authed = _authed_clone_url(clean, tok["token"]) or clean
        ok = step("create repo + push",
                  *_run(["git", "push", "-u", authed, "HEAD:main"],
                        cwd=path, timeout=180))
    else:
        ok = step("gh repo create + push",
                  *_run(["gh", "repo", "create", repo, vis, "--source", ".",
                         "--remote", "origin", "--push"], cwd=path, timeout=180))
        rc2, url_out, _ = _run(["gh", "repo", "view", "--json", "url",
                                "-q", ".url"], cwd=path)
        repo_url = url_out.strip() if rc2 == 0 else ""

    if tok:                                   # never echo the token
        for s in steps:
            s["err"] = (s.get("err") or "").replace(tok["token"], "***")
            s["out"] = (s.get("out") or "").replace(tok["token"], "***")

    return jsonify({"ok": ok, "repo_url": repo_url,
                    "account": st.get("account"), "steps": steps}), \
           (200 if ok else 500)

def _git_remote_branch(path):
    """(remote_url, branch) for a project repo, or ('', '')."""
    rc, remote, _ = _run(["git", "remote", "get-url", "origin"], cwd=path)
    remote = remote.strip() if rc == 0 else ""
    rc2, br, _ = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=path)
    branch = (br.strip() if rc2 == 0 else "") or "main"
    return remote, branch

@app.route("/api/projects/<project>/github/sync", methods=["GET"])
def github_sync(project):
    """Fetch from origin and report how local compares to the remote:
    {repo, remote, branch, ahead, behind, dirty, fetched}."""
    try:
        path = _safe_project(project)
    except _PathError as e:
        return _err(str(e))
    if not os.path.isdir(os.path.join(path, ".git")):
        return jsonify({"repo": False})
    remote, branch = _git_remote_branch(path)
    if not remote:
        return jsonify({"repo": True, "remote": None})

    tok = _gh_token_load()
    fetch_target = (_authed_clone_url(remote, tok["token"]) or remote) if tok else "origin"
    rc, out, err = _run(["git", "fetch", fetch_target, branch], cwd=path, timeout=60)
    fetched = rc == 0
    ferr = ""
    if not fetched:
        ferr = (err or out).strip()
        if tok: ferr = ferr.replace(tok["token"], "***")
        ferr = ferr[-300:]

    behind = ahead = 0
    if fetched:
        rc2, c, _ = _run(["git", "rev-list", "--count", "HEAD..FETCH_HEAD"], cwd=path)
        if rc2 == 0: behind = int((c.strip() or "0"))
        rc3, c2, _ = _run(["git", "rev-list", "--count", "FETCH_HEAD..HEAD"], cwd=path)
        if rc3 == 0: ahead = int((c2.strip() or "0"))
    rc4, st, _ = _run(["git", "status", "--porcelain"], cwd=path)
    dirty = bool(st.strip())
    return jsonify({"repo": True, "remote": remote, "branch": branch,
                    "fetched": fetched, "ahead": ahead, "behind": behind,
                    "dirty": dirty, "fetch_error": ferr})

@app.route("/api/projects/<project>/github/pull", methods=["POST"])
def github_pull(project):
    """Pull (merge) the remote branch into the local one. Token-authed when
    signed in via OAuth; otherwise relies on gh's git credential helper."""
    try:
        path = _safe_project(project)
    except _PathError as e:
        return _err(str(e))
    if not os.path.isdir(os.path.join(path, ".git")):
        return _err("Not a git repository — back up first to connect a repo.", 400)
    remote, branch = _git_remote_branch(path)
    if not remote:
        return _err("No GitHub remote connected.", 400)
    tok = _gh_token_load()
    target = (_authed_clone_url(remote, tok["token"]) or remote) if tok else "origin"
    # --autostash: stash uncommitted local edits, merge, then re-apply them.
    # Without it, unsaved local changes (the common case — the editor autosaves
    # to disk) abort the pull with "would be overwritten by merge".
    rc, out, err = _run(["git", "pull", "--no-rebase", "--no-edit", "--autostash",
                         target, branch], cwd=path, timeout=120)
    text = ((out or "") + "\n" + (err or "")).strip()
    if tok: text = text.replace(tok["token"], "***")
    low = text.lower()
    # NB: `git pull --autostash` exits 0 even when re-applying the stash
    # conflicts (it prints "Applying autostash resulted in conflicts" and keeps
    # the stash) — so we must detect that case despite rc == 0.
    autostash_conflict = "autostash resulted in conflicts" in low
    conflict = autostash_conflict or ("automatic merge failed" in low) \
               or ("needs merge" in low) or ("unmerged" in low) \
               or ("conflict" in low and "resolv" not in low)
    blocked  = ("would be overwritten" in low) \
               or ("please commit your changes or stash" in low)
    if rc != 0 or conflict or blocked:
        return jsonify({"ok": False, "conflict": conflict, "blocked": blocked,
                        "error": text[-700:]}), (409 if (conflict or blocked) else 500)
    return jsonify({"ok": True, "out": text[-700:]})

# ── LaTeX package helper (v4.4.0) ────────────────────────────────────
# Check whether a package's .sty is present (kpsewhich). Installing is handed
# off to the system's own package manager GUI (MiKTeX Console / TeX Live) — we
# just launch it — rather than shelling mpm in-app. MiKTeX also auto-installs
# missing packages on compile by default.

def _pkg_manager():
    """Detect the available package-manager GUI. Returns (label, launch_cmd) or
    (None, None). Prefers MiKTeX Console, then TeX Live (tlshell / tlmgr gui)."""
    if shutil.which("miktex-console"):
        return "MiKTeX Console", ["miktex-console"]
    if shutil.which("tlshell"):
        return "TeX Live (tlshell)", ["tlshell"]
    if shutil.which("tlmgr"):
        return "TeX Live (tlmgr)", ["tlmgr", "gui"]
    return None, None

def _pkgs_installed(names):
    """Batch the lookup into ONE kpsewhich call — it accepts many filenames and
    prints the full path of each that's found. kpsewhich is slow to start on
    MiKTeX (~5s), so per-package calls would take minutes; one call is ~seconds.
    A name is 'installed' if a returned path's basename is <name>.sty."""
    names = [n for n in names if re.match(r"^[A-Za-z0-9._-]+$", n or "")]
    if not names:
        return {}
    rc, out, _err = _run(["kpsewhich", *[f"{n}.sty" for n in names]], timeout=60)
    found = set()
    for line in (out or "").splitlines():
        base = line.strip().replace("\\", "/").split("/")[-1]
        if base:
            found.add(base.lower())
    return {n: (f"{n}.sty".lower() in found) for n in names}

@app.route("/api/packages/status", methods=["POST"])
def packages_status():
    """Body {names:[...]} → {installed:{name:bool}, manager:str|null}."""
    data  = request.json or {}
    names = data.get("names") or []
    if not isinstance(names, list):
        names = []
    names = [n for n in names if isinstance(n, str)][:60]   # cap the work
    label, _cmd = _pkg_manager()
    return jsonify({"installed": _pkgs_installed(names), "manager": label})

@app.route("/api/packages/open-manager", methods=["POST"])
def packages_open_manager():
    """Launch the system's package-manager GUI (MiKTeX Console / TeX Live) so
    the user installs there. Local app: it opens on the user's screen."""
    label, cmd = _pkg_manager()
    if not cmd:
        return _err("No package manager found. Install MiKTeX (miktex.org) or "
                    "TeX Live, then reopen this.", 404)
    try:
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, creationflags=SUBPROC_FLAGS)
    except Exception as e:
        return _err(f"Couldn't launch {label}: {e}", 500)
    return jsonify({"ok": True, "manager": label})

@app.route("/api/projects/<project>/compile", methods=["POST"])
def compile_project(project):
    data     = request.json or {}
    main_tex = data.get("main", "main.tex")
    use_bib  = data.get("bibtex", False)
    draft    = bool(data.get("draft", False))   # v3.2.2 — draft mode (skip figures)
    # v3.2.2 — \includeonly chapter switcher. List of paths (no .tex
    # extension) to inject as `\includeonly{a,b,c}` ahead of the main
    # \input. Empty/missing → full compile (default behaviour).
    include_only = data.get("includeOnly") or []
    if not isinstance(include_only, list):
        include_only = []
    # Sanitise: keep only non-empty strings without braces, commas, or
    # newlines (those would break the inline \includeonly{...} syntax).
    include_only = [
        s.strip() for s in include_only
        if isinstance(s, str) and s.strip()
        and "}" not in s and "{" not in s and "," not in s and "\n" not in s
    ]
    compiler = data.get("compiler", "pdflatex")
    if compiler not in ("pdflatex", "xelatex", "lualatex"):
        compiler = "pdflatex"
    try:
        path = _safe_project(project)
        main_full = _safe_join(path, main_tex)
    except _PathError as e:
        return _err(str(e))
    # Resolve where the main file lives so pdflatex/bibtex run in the right cwd.
    # base       = filename stem WITHOUT subfolder prefix (e.g. "main", not "src/main")
    # main_dir   = absolute directory containing main.tex (cwd for compile)
    # rel_dir    = subfolder of main relative to project root ("" if at root)
    main_dir    = os.path.dirname(main_full) or path
    base        = os.path.splitext(os.path.basename(main_tex))[0]
    rel_dir     = os.path.dirname(main_tex).replace("\\", "/")
    pdf_rel     = (rel_dir + "/" + base + ".pdf") if rel_dir else (base + ".pdf")
    main_name   = os.path.basename(main_tex)
    log_lines = []

    # Strip UTF-8 BOM from all .tex files before compiling (silent — was logging
    # noise on every compile).
    for root, dirs, files in _walk_visible(path):
        for fname in files:
            if not fname.endswith(".tex"):
                continue
            fpath = os.path.join(root, fname)
            try:
                with open(fpath, "rb") as fh:
                    raw = fh.read()
                if raw.startswith(b"\xef\xbb\xbf"):
                    # v4.3.1 — atomic rewrite; compiling must never be able to
                    # truncate a source file as a side effect of BOM-stripping
                    _atomic_write_bytes(fpath, raw[3:])
            except Exception:
                pass

    # v4.4.0 — Make project-local .cls/.sty/.bst/.bib findable no matter where
    # the main file lives. pdflatex/bibtex already run with cwd = main_dir, so
    # files beside main.tex work; prepending the PROJECT ROOT (searched
    # recursively via the trailing `//`) also covers a .cls/.bst kept at the
    # root while main.tex sits in a subfolder. The trailing os.pathsep keeps the
    # TeX distribution's own default search paths intact.
    _texenv = os.environ.copy()
    _root_search = path.replace("\\", "/") + "//"
    for _var in ("TEXINPUTS", "BSTINPUTS", "BIBINPUTS"):
        _texenv[_var] = _root_search + os.pathsep + _texenv.get(_var, "")

    def run(cmd, cwd=None):
        # v4.1.6-phase3 — diagnostic now silent by default; set TEXLOCAL_DEBUG=1
        # to capture per-subprocess PATH/which lookups in miktex-inject-debug.log
        # (Start Menu "TexLocal (Debug Mode)" shortcut sets the env var).
        _debug = os.environ.get("TEXLOCAL_DEBUG")
        if _debug:
            try:
                import shutil as _sh
                _log = os.path.join(APP_BASE, "miktex-inject-debug.log")
                with open(_log, "a", encoding="utf-8") as _f:
                    _f.write("\n--- subprocess attempt ---\n")
                    _f.write(f"cmd = {cmd}\n")
                    _f.write(f"cwd = {cwd or main_dir}\n")
                    _f.write(f"PATH (first 500): {os.environ.get('PATH','')[:500]}\n")
                    _f.write(f"TEXLOCAL_MIKTEX_BUNDLED = {os.environ.get('TEXLOCAL_MIKTEX_BUNDLED','<unset>')}\n")
                    _f.write(f"shutil.which({cmd[0]!r}) = {_sh.which(cmd[0])}\n")
            except Exception:
                pass
        try:
            r = subprocess.run(cmd, cwd=cwd or main_dir, capture_output=True, text=True,
                               encoding="utf-8", errors="replace",
                               stdin=subprocess.DEVNULL, env=_texenv,
                               creationflags=SUBPROC_FLAGS)
        except FileNotFoundError as _fnf:
            if _debug:
                try:
                    with open(_log, "a", encoding="utf-8") as _f:
                        _f.write(f"FileNotFoundError raised: {_fnf}\n")
                except Exception:
                    pass
            raise
        log_lines.append("$ " + " ".join(cmd))
        log_lines.append(r.stdout)
        if r.stderr:
            log_lines.append(r.stderr)
        return r.returncode

    # ── Inline-command argument builder ──────────────────────────────
    # When draft mode and/or \includeonly are active, we inject TeX
    # commands BEFORE `\input{<main>}` via the command line — no source
    # file is modified. Both rely on the LaTeX format's global flags
    # being settable before `\documentclass`:
    #   - `\PassOptionsToPackage{draft}{graphicx,graphics}` — graphicx
    #     reads its registered options when loaded by the user's preamble.
    #   - `\includeonly{a,b,c}` — sets `@partsw=true` and `@partlist`,
    #     which `\include{}` checks at run time. The flags exist in the
    #     plain-LaTeX format kernel, so calling \includeonly before
    #     \documentclass is safe and well-precedented.
    # We target `graphicx` (rather than the document class) because it
    # leaves hyperref / cleveref active and avoids class-option clashes
    # (e.g. CMUThesis.cls).
    def main_arg(name):
        prefix_parts = []
        if draft:
            prefix_parts.append("\\PassOptionsToPackage{draft}{graphicx}")
            prefix_parts.append("\\PassOptionsToPackage{draft}{graphics}")
        if include_only:
            prefix_parts.append(
                "\\includeonly{" + ",".join(include_only) + "}"
            )
        if prefix_parts:
            return "".join(prefix_parts) + f"\\input{{{name}}}"
        return name

    # `is_inline` controls whether we need `-jobname=<base>`. When the
    # last argv element starts with a backslash, pdflatex's default
    # jobname is "texput" — we override so the .pdf/.aux/.synctex still
    # land at <base>.* in the project dir.
    is_inline = bool(draft or include_only)

    try:
        # ── Detect bib usage across ALL .tex files in the project ────────
        # (a sub-file may declare \addbibresource even if main only \input's it)
        # v4.7.10 — single pass: collect .bib files AND scan .tex for bib
        # commands together (was two full os.walks, each re-reading the tree).
        # The thesis has 50+ source files, so the duplicate walk + re-read was
        # pure per-compile overhead. Also uses _walk_visible for the dot-dir skip.
        bib_files = []
        has_bib_cmd = False
        needs_biber = False
        for r_, ds_, fs_ in _walk_visible(path):
            for f_ in fs_:
                if f_.endswith(".bib"):
                    bib_files.append(os.path.relpath(os.path.join(r_, f_), path))
                elif f_.endswith(".tex"):
                    try:
                        with open(os.path.join(r_, f_), "r", encoding="utf-8", errors="replace") as fh:
                            src = fh.read()
                    except Exception:
                        continue
                    if "\\addbibresource{" in src:
                        has_bib_cmd = True
                        needs_biber = True
                    elif "\\bibliography{" in src:
                        has_bib_cmd = True

        run_bib = use_bib or (bib_files and has_bib_cmd)
        if run_bib and not bib_files:
            log_lines.append("Warning: BibTeX requested but no .bib file found.")
        if draft:
            log_lines.append("[draft mode] graphicx/graphics → draft (figures skipped)")
        if include_only:
            log_lines.append(
                "[includeonly] " + ", ".join(include_only)
                + "  (other \\include'd files skipped — \\input still runs)"
            )

        # When draft or includeOnly is active the last argv element is a
        # TeX command (starts with `\`), not a plain filename. We force
        # `-jobname=<base>` so the output still lands at <base>.pdf
        # (otherwise pdflatex picks "texput" for inline input).
        def compile_argv():
            argv = [compiler, "--enable-installer", "-interaction=nonstopmode", "-synctex=1"]
            if is_inline:
                argv.append(f"-jobname={base}")
            argv.append(main_arg(main_name))
            return argv

        run(compile_argv())

        if run_bib and bib_files:
            # bibtex/biber must run in the same dir as the .aux file (= main_dir)
            bib_rc = run(["biber", base] if needs_biber else ["bibtex", base])
            if bib_rc != 0:
                log_lines.append(f"Warning: bib tool exited with code {bib_rc}")
            run(compile_argv())
            run(compile_argv())
        else:
            run(compile_argv())

        pdf_path = os.path.join(main_dir, base + ".pdf")
        if os.path.exists(pdf_path):
            return jsonify({"ok": True,  "log": "\n".join(log_lines), "pdf": pdf_rel})
        else:
            return jsonify({"ok": False, "log": "\n".join(log_lines)})

    except FileNotFoundError:
        return jsonify({"ok": False, "log": f"{compiler} not found. Install TeX Live or MiKTeX."})
    except Exception as e:
        return jsonify({"ok": False, "log": str(e)})

@app.route("/api/projects/<project>/synctex/forward", methods=["GET"])
def synctex_forward(project):
    """Forward search: source line → PDF page number."""
    file = request.args.get("file", "main.tex")
    line = request.args.get("line", "1")
    col  = request.args.get("col", "1")
    pdf  = request.args.get("pdf", "main.pdf")

    try:
        path     = _safe_project(project)
        pdf_path = _safe_join(path, pdf)
        # `file` is also a user-supplied path — sandbox it
        _safe_join(path, file)
    except _PathError as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    if not os.path.exists(pdf_path):
        return jsonify({"ok": False, "error": "PDF not found — compile first"}), 404

    pdf_stem = os.path.splitext(pdf_path)[0]
    synctex_file = pdf_stem + ".synctex.gz"
    if not os.path.exists(synctex_file):
        synctex_file = pdf_stem + ".synctex"
    if not os.path.exists(synctex_file):
        return jsonify({"ok": False, "error": "SyncTeX data not found — compile with -synctex=1"}), 404

    # ── Direct .synctex parser approach ─────────────────────────────────
    # Why not `synctex view`?  On MiKTeX it aggregates everything to the
    # topmost vbox (paragraph or whole section), losing line-level detail.
    # The .synctex file itself contains per-glyph/per-kern records tagged
    # with the source line, so we read it directly and build a bounding
    # box from all records belonging to the cursor's source line.
    try:
        parsed = _synctex_parse_per_line(synctex_file)
    except Exception as e:
        return jsonify({"ok": False, "error": f"Failed to parse synctex: {e}"}), 500

    input_map    = parsed["input_map"]
    line_records = parsed["line_records"]

    tag = _synctex_resolve_tag(input_map, path, file)
    if tag is None:
        return jsonify({"ok": False, "error": f"File '{file}' not found in synctex Input map"}), 404

    try:
        cursor_line = int(line)
    except (TypeError, ValueError):
        cursor_line = 1

    # Find records for cursor line; if absent, search nearby ±5
    recs = list(line_records.get((tag, cursor_line), []))
    matched_line = cursor_line
    if not recs:
        for delta in range(1, 6):
            for nearby in (cursor_line + delta, cursor_line - delta):
                if nearby < 1:
                    continue
                cand = line_records.get((tag, nearby), [])
                if cand:
                    recs = list(cand)
                    matched_line = nearby
                    break
            if recs:
                break

    if not recs:
        return jsonify({"ok": False,
                        "error": "No SyncTeX records near this line — recompile after editing?"})

    # Pick the page where MOST records cluster (handles edge case where a
    # source line spans a page break).
    pages = [r["page"] for r in recs if r.get("page") is not None]
    if not pages:
        return jsonify({"ok": False, "error": "Records have no page info"}), 500
    target_page = max(set(pages), key=pages.count)
    page_recs   = [r for r in recs if r.get("page") == target_page]

    # ── Choose record set for the bounding box ─────────────────────────
    # Section/subsection lines include vertical glue records that share the
    # source line but live FAR above the heading text (top of page or
    # previous page). Including their (x, y) inflates the bounding box and
    # makes the highlight jump to the wrong spot.
    #
    # Strategy: prefer "glyph-like" records (g, x, k, h) which sit at the
    # actual typeset character/kern positions. Fall back to ALL records
    # only if none of those exist.
    glyph_types = ("g", "x", "k", "h")
    bbox_recs   = [r for r in page_recs if r.get("type") in glyph_types]
    if not bbox_recs:
        bbox_recs = page_recs

    # Tighten further by clustering: drop outliers more than 60pt from the
    # median y — these are almost always pre-heading glue or floats.
    ys_all = sorted(r["y"] for r in bbox_recs if "y" in r)
    if len(ys_all) >= 4:
        y_med = ys_all[len(ys_all) // 2]
        bbox_recs = [r for r in bbox_recs if abs(r["y"] - y_med) <= 60.0]

    # ── Largest-gap split for \item lines ──────────────────────────────
    # When TeX hits "\item N+1", it CLOSES item N first, then opens N+1.
    # MiKTeX synctex tags some of those closing records with the source
    # line of \item N+1, which leaks the previous item's vertical extent
    # into our bounding box (item 2 ends up highlighting items 1+2, etc.).
    #
    # v4.4.2 — paragraph-safe rewrite. The previous heuristic split on ANY
    # inter-record gap > 14pt and kept the denser cluster. But normal
    # body-text leading in this thesis is ~20pt, so EVERY wrapped paragraph
    # tripped the split and its FIRST visual line (the smaller "top" cluster)
    # was discarded — the highlight started on line 2. Fix: cluster records
    # into visual lines, measure the document's OWN typical line spacing, and
    # split only when a gap is clearly larger than one line of leading (a real
    # blank gap from an \item's closing glue), not merely > a fixed constant.
    # A uniform wrapped paragraph has max_gap ≈ median leading → no split.
    GAP_PT = 14.0
    bbox_split_kept = None
    if len(bbox_recs) >= 4:
        # distinct visual-line baselines (round to 1pt to coalesce a line)
        line_ys = sorted({round(r["y"], 0) for r in bbox_recs})
        if len(line_ys) >= 3:
            line_gaps = [line_ys[i + 1] - line_ys[i]
                         for i in range(len(line_ys) - 1)]
            median_leading = sorted(line_gaps)[len(line_gaps) // 2]
            # "real" separation must clearly exceed one line of leading
            split_threshold = max(GAP_PT, median_leading * 1.8)
            max_gap = max(line_gaps)
            if max_gap > split_threshold:
                gi = line_gaps.index(max_gap)
                split_y = (line_ys[gi] + line_ys[gi + 1]) / 2.0
                top    = [r for r in bbox_recs if r["y"] <= split_y]
                bottom = [r for r in bbox_recs if r["y"] >  split_y]
                # Keep whichever cluster is denser; on ties, keep the BOTTOM
                # cluster (current item is below the previous item's closing).
                if len(top) > len(bottom):
                    bbox_recs = top
                    bbox_split_kept = "top"
                else:
                    bbox_recs = bottom
                    bbox_split_kept = "bottom"

    xs = [r["x"] for r in bbox_recs if "x" in r]
    ys = [r["y"] for r in bbox_recs if "y" in r]
    if not xs or not ys:
        return jsonify({"ok": False, "error": "Records lack coordinates"}), 500

    x_min = min(xs)
    x_max = max(xs)
    y_min = min(ys)   # baseline of the topmost visual line
    y_max = max(ys)   # baseline of the bottommost visual line

    # Convert baseline → top-of-glyph by subtracting an estimated ascent.
    # Body text is typically 10-12pt with ~75% ascent ≈ 9pt.
    # Section headings can be larger; if any record carries a real h, use it.
    h_records = [r for r in bbox_recs if r.get("h", 0) > 1.0]
    if h_records:
        # use the smallest meaningful h (most likely a single glyph height)
        glyph_h = min(r["h"] for r in h_records)
        # cap at sensible single-line range to handle vbox-style records
        if glyph_h > 30:
            glyph_h = 12.0
    else:
        # MiKTeX usually omits h on x/g/k records — use a reasonable default
        glyph_h = 12.0

    # Top-of-highlight = baseline of first line minus the glyph ascent
    y_top    = y_min - glyph_h
    # Bottom-of-highlight = baseline of last line (descent added in frontend)
    y_bot    = y_max
    width    = max(0.0, x_max - x_min)

    # debug payload to keep the existing status-bar diagnostic readable
    debug_payload = {
        "matched_line":   matched_line,
        "record_count":   len(bbox_recs),
        "raw_count":      len(page_recs),     # before glyph-only + cluster filtering
        "page":           target_page,
        "y_min":          round(y_min, 2),
        "y_max":          round(y_max, 2),
        "x_min":          round(x_min, 2),
        "x_max":          round(x_max, 2),
        "glyph_h":        round(glyph_h, 2),
        "tag":            tag,
        "h_records_used": len(h_records),
        "split_kept":     bbox_split_kept,    # "top"/"bottom"/None
    }

    return jsonify({
        "ok":      True,
        "page":    target_page,
        "x":       x_min,
        "y":      y_top,
        "y2":      y_bot,
        "w":       width,
        "h":       glyph_h,
        # Backward-compat fields the frontend already reads:
        "debug_heading": False,
        "debug_recs":    [{"h": round(r.get("h", 0), 1)} for r in page_recs[:8]],
        "debug":         debug_payload,
    })

@app.route("/api/projects/<project>/synctex/backward", methods=["GET"])
def synctex_backward(project):
    """Backward search: PDF click position → source file + line number."""
    page = request.args.get("page", "1")
    x    = request.args.get("x",    "0")
    y    = request.args.get("y",    "0")
    pdf  = request.args.get("pdf",  "main.pdf")

    try:
        path     = _safe_project(project)
        pdf_path = _safe_join(path, pdf)
    except _PathError as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    if not os.path.exists(pdf_path):
        return jsonify({"ok": False, "error": "PDF not found — compile first"}), 404

    pdf_stem = os.path.splitext(pdf_path)[0]
    synctex_file = pdf_stem + ".synctex.gz"
    if not os.path.exists(synctex_file):
        synctex_file = pdf_stem + ".synctex"
    if not os.path.exists(synctex_file):
        return jsonify({"ok": False, "error": "No SyncTeX data — compile with -synctex=1"}), 404

    try:
        # synctex edit -o "page:x:y:pdf"
        cmd = ["synctex", "edit", "-o", f"{page}:{x}:{y}:{pdf_path}"]
        r   = subprocess.run(cmd, cwd=path, capture_output=True, text=True, timeout=8,
                             encoding="utf-8", errors="replace",  # v4.7.10 — non-ASCII paths
                             creationflags=SUBPROC_FLAGS)  # v4.0.1-phase2

        src_file = None
        src_line = None
        for ln in r.stdout.splitlines():
            k, _, v = ln.partition(":")
            v = v.strip()
            if k == "Input":
                # may be absolute path — make relative to project dir
                src_file = os.path.relpath(v, path).replace("\\", "/")
            elif k == "Line":
                try: src_line = int(v)
                except ValueError: pass

        if src_file is None or src_line is None:
            return jsonify({"ok": False, "error": "No synctex match at this position"})

        return jsonify({"ok": True, "file": src_file, "line": src_line})

    except FileNotFoundError:
        return jsonify({"ok": False, "error": "synctex not found"}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "synctex timeout"}), 500
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/api/projects/<project>/synctex/dump", methods=["GET"])
def synctex_dump(project):
    """Deprecated diagnostic endpoint. The frontend debug button was removed
    in v3.2.1; /synctex/forward already returns the bounding-box info needed
    for production use. Kept only so old bookmarks return a clear status."""
    return jsonify({"ok": False, "error": "diagnostic endpoint disabled"}), 410


@app.route("/api/projects/<project>/search", methods=["GET"])
def search_project(project):
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"results": []})
    try:
        path = _safe_project(project)
    except _PathError:
        return jsonify({"results": []})
    if not os.path.exists(path):
        return jsonify({"results": []})
    results = []
    ql = query.lower()
    for root, dirs, files in _walk_visible(path):
        for fname in files:
            if not (fname.endswith(".tex") or fname.endswith(".bib")):
                continue
            fpath = os.path.join(root, fname)
            rel = os.path.relpath(fpath, path).replace("\\", "/")
            try:
                with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                    # v4.7.10 — 1-based to match /todos, /outline, and the gutter
                    for lineno, line in enumerate(f, start=1):
                        if ql in line.lower():
                            results.append({
                                "file": rel,
                                "line": lineno,
                                "text": line.rstrip()[:200]
                            })
                            if len(results) >= 200:
                                return jsonify({"results": results, "truncated": True})
            except Exception:
                pass
    return jsonify({"results": results})

# ── Citation / label autocomplete data ────────────────────────────────
# Cached aggregate of:
#   - all bibkeys from every .bib in the project (with author/year for display)
#   - all \label{...} occurrences from every .tex (with file + line for jump)
# Cached per-project, keyed by the latest mtime among the source files.
_cite_data_cache = {}   # project_dir → (max_mtime, parsed)

_BIB_FIELD_RE = re.compile(
    r'\b(?P<name>author|year|title|editor|journal|booktitle)\s*=\s*',
    re.IGNORECASE,
)
_LABEL_RE = re.compile(r'\\label\{([^}]+)\}')
# v4.4.0 — user-defined commands/environments for autocomplete. Covers
# \newcommand / \renewcommand / \providecommand (braced or bare), \def, \let,
# \DeclareMathOperator, \DeclarePairedDelimiter; and \newenvironment /
# \newtheorem for \begin{...} completion.
_CMD_DEF_RE = re.compile(
    r'\\(?:newcommand|renewcommand|providecommand)\*?\s*\{?\\([a-zA-Z@]+)\}?'
    r'|\\DeclareMathOperator\*?\s*\{\\([a-zA-Z@]+)\}'
    r'|\\DeclarePairedDelimiter\*?\s*\{?\\([a-zA-Z@]+)\}?'
    r'|\\(?:def|let)\s*\\([a-zA-Z@]+)')
_ENV_DEF_RE = re.compile(
    r'\\(?:re)?newenvironment\s*\{([^}]+)\}'
    r'|\\newtheorem\*?\s*\{([^}]+)\}')

def _bib_read_field(rest, start):
    """Read a brace-/quote-delimited or bare value starting at `start` in `rest`.
    Returns (value, end_index)."""
    if start >= len(rest):
        return "", start
    c = rest[start]
    if c == '{':
        depth, j = 1, start + 1
        while j < len(rest) and depth > 0:
            if   rest[j] == '{': depth += 1
            elif rest[j] == '}': depth -= 1
            j += 1
        return rest[start + 1:j - 1].strip(), j
    if c == '"':
        end = rest.find('"', start + 1)
        if end < 0:
            return rest[start + 1:].strip(), len(rest)
        return rest[start + 1:end].strip(), end + 1
    # bare value (e.g. @string macro or numeric year)
    j = start
    while j < len(rest) and rest[j] not in ',\n':
        j += 1
    return rest[start:j].strip(), j

def _bib_clean(s):
    """Strip TeX braces/escapes commonly found in bib fields for display only."""
    if not s: return s
    return (s.replace("{", "").replace("}", "")
             .replace("\\&", "&").replace("\\textendash", "–")
             .replace("--", "–").replace("~", " "))

def _parse_bib_text(text):
    """Yield {key, type, author, year, title} per entry. Tolerant of nested
    braces in titles, BibTeX `@string`/`@comment`/`@preamble` (skipped), and
    irregular whitespace. Not a full BibTeX parser — just enough for the
    autocomplete dropdown."""
    entries = []
    i, n = 0, len(text)
    while i < n:
        at = text.find('@', i)
        if at < 0: break
        ob = text.find('{', at)
        if ob < 0: break
        type_str = text[at + 1:ob].strip().lower()
        # Skip non-entry blocks
        if type_str in ('string', 'comment', 'preamble'):
            # advance past matching brace to avoid stalling
            depth, j = 1, ob + 1
            while j < n and depth > 0:
                if   text[j] == '{': depth += 1
                elif text[j] == '}': depth -= 1
                j += 1
            i = j
            continue
        # find matching closing brace of the entry
        depth, j = 1, ob + 1
        while j < n and depth > 0:
            if   text[j] == '{': depth += 1
            elif text[j] == '}': depth -= 1
            j += 1
        body = text[ob + 1:j - 1]
        comma = body.find(',')
        if comma < 0:
            i = j
            continue
        key = body[:comma].strip()
        if not key:
            i = j
            continue
        rest = body[comma + 1:]
        fields = {}
        for m in _BIB_FIELD_RE.finditer(rest):
            val, _end = _bib_read_field(rest, m.end())
            fields[m.group("name").lower()] = _bib_clean(val)
        entries.append({
            "key":    key,
            "type":   type_str,
            "author": fields.get("author", "")[:120],
            "year":   fields.get("year", "")[:8],
            "title":  fields.get("title", "")[:140],
        })
        i = j
    return entries

def _build_cite_data(path):
    """Return {bibkeys, labels, commands, environments} aggregated over all
    .bib and .tex files in path."""
    bibkeys = []
    labels  = []
    commands = []
    environments = []
    seen_keys   = set()
    seen_labels = set()
    seen_cmds   = set()
    seen_envs   = set()
    for root, dirs, files in _walk_visible(path):
        for f in files:
            full = os.path.join(root, f)
            if f.endswith(".bib"):
                try:
                    with open(full, "r", encoding="utf-8", errors="replace") as fh:
                        txt = fh.read()
                except Exception:
                    continue
                for e in _parse_bib_text(txt):
                    if e["key"] in seen_keys:
                        continue
                    seen_keys.add(e["key"])
                    bibkeys.append(e)
            elif f.endswith(".tex"):
                rel = os.path.relpath(full, path).replace("\\", "/")
                try:
                    with open(full, "r", encoding="utf-8", errors="replace") as fh:
                        for lineno, line in enumerate(fh, start=1):
                            for m in _LABEL_RE.finditer(line):
                                lab = m.group(1).strip()
                                if not lab or lab in seen_labels:
                                    continue
                                seen_labels.add(lab)
                                labels.append({
                                    "name": lab,
                                    "file": rel,
                                    "line": lineno,
                                })
                            for m in _CMD_DEF_RE.finditer(line):
                                name = next((g for g in m.groups() if g), None)
                                if name and name not in seen_cmds:
                                    seen_cmds.add(name)
                                    commands.append("\\" + name)
                            for m in _ENV_DEF_RE.finditer(line):
                                env = next((g for g in m.groups() if g), None)
                                if env:
                                    env = env.strip()
                                    if env and env not in seen_envs:
                                        seen_envs.add(env)
                                        environments.append(env)
                except Exception:
                    continue
    bibkeys.sort(key=lambda e: e["key"].lower())
    labels.sort(key=lambda e: e["name"].lower())
    commands.sort(key=str.lower)
    environments.sort(key=str.lower)
    return {"bibkeys": bibkeys, "labels": labels,
            "commands": commands, "environments": environments}

# ── \includeonly chapter list ─────────────────────────────────────────
# Scan a single main file for `\include{path}` directives so the frontend
# can render a checkbox list of "selectable" units. Notes:
#   - Lines whose first non-whitespace character is `%` are skipped
#     (commented-out includes, common in CMUThesis-style mains).
#   - `\input{...}` is intentionally NOT collected: \includeonly does not
#     control \input, so listing it would mislead the user.
#   - Order is preserved as it appears in the file (matches reading order
#     in the final PDF, which is what the user expects to see).
_INCLUDE_RE = re.compile(r'\\include\{([^}]+)\}')

def _scan_includes(main_full):
    """Return [{"path": str, "line": int}, ...] from main_full.
    Empty list if the file is missing or has no \\include{}."""
    out = []
    if not os.path.exists(main_full):
        return out
    try:
        with open(main_full, "r", encoding="utf-8", errors="replace") as fh:
            for lineno, line in enumerate(fh, start=1):
                stripped = line.lstrip()
                if stripped.startswith("%"):
                    continue          # commented out → skip
                # Strip trailing inline comment so a line like
                # `\include{foo} % some note` still parses correctly.
                code = stripped
                pct = -1
                # find % not preceded by \  (TeX comment, not literal %)
                i = 0
                while i < len(code):
                    if code[i] == "\\" and i + 1 < len(code):
                        i += 2; continue
                    if code[i] == "%":
                        pct = i; break
                    i += 1
                if pct >= 0:
                    code = code[:pct]
                for m in _INCLUDE_RE.finditer(code):
                    out.append({"path": m.group(1).strip(), "line": lineno})
    except Exception:
        pass
    return out

@app.route("/api/projects/<project>/includes", methods=["GET"])
def includes(project):
    """List of \\include{...} entries in the project's main file, in order.
    Frontend uses this to populate the \\includeonly chapter selector."""
    main_tex = request.args.get("main", "main.tex")
    try:
        path = _safe_project(project)
        main_full = _safe_join(path, main_tex)
    except _PathError as e:
        return _err(str(e))
    return jsonify({
        "main":     main_tex,
        "includes": _scan_includes(main_full),
    })

@app.route("/api/projects/<project>/cite-data", methods=["GET"])
def cite_data(project):
    """Aggregated autocomplete data for \\cite{...} and \\ref{...} hints.
    Cached by the max mtime among .bib + .tex files; reparses only when
    something changed since the last call."""
    try:
        path = _safe_project(project)
    except _PathError as e:
        return _err(str(e))
    if not os.path.exists(path):
        return jsonify({"bibkeys": [], "labels": []})
    # Cheapest refresh signal — walk once and take the max mtime
    latest = 0.0
    for root, dirs, files in _walk_visible(path):
        for f in files:
            if not (f.endswith(".bib") or f.endswith(".tex")):
                continue
            try:
                m = os.path.getmtime(os.path.join(root, f))
                if m > latest: latest = m
            except OSError:
                pass
    cached = _cite_data_cache.get(path)
    if cached and cached[0] == latest:
        return jsonify(cached[1])
    parsed = _build_cite_data(path)
    _cite_data_cache[path] = (latest, parsed)
    return jsonify(parsed)

# v3.2.2 — \todo / TODO / FIXME tracker
# Picks up three kinds of markers and reports each with file + line:
#   1. `\todo{...}` from the `todonotes` package — message is the brace arg
#   2. `% TODO ...` / `% FIXME ...` line comments — message is rest of line
#   3. `% XXX ...`                                — same
# Project-wide scan over .tex files. Cheap enough to run without caching.
_TODONOTE_RE = re.compile(r'\\todo\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}')
_COMMENT_TODO_RE = re.compile(
    r'%+\s*(TODO|FIXME|XXX)\b[:\s]*(.*)$',
    re.IGNORECASE,
)

# v4.4.0 — Document outline: scan all .tex files for section headings.
_SECTION_RE = re.compile(
    r'\\(chapter|section|subsection|subsubsection)\*?\s*\{([^}]*)\}'
)

@app.route("/api/projects/<project>/outline", methods=["GET"])
def project_outline(project):
    try:
        root = _safe_project(project)
    except _PathError as e:
        return _err(str(e))
    results = []
    # v4.7.10 — was raw os.walk (missed the v4.7.5 _walk_visible cleanup), so it
    # descended into .git/ etc. on every outline open. line base also normalised
    # to 1-based (enumerate start=1) to match /todos and the editor gutter.
    for dirpath, _dirs, filenames in _walk_visible(root):
        for fname in sorted(filenames):
            if not fname.endswith(".tex"):
                continue
            fpath = os.path.join(dirpath, fname)
            rel   = os.path.relpath(fpath, root).replace("\\", "/")
            try:
                with open(fpath, encoding="utf-8", errors="replace") as f:
                    for lineno, line in enumerate(f, start=1):
                        m = _SECTION_RE.search(line)
                        if m:
                            results.append({
                                "file": rel,
                                "line": lineno,
                                "level": m.group(1),
                                "title": m.group(2).strip(),
                            })
            except Exception:
                pass
    return jsonify(results)

@app.route("/api/projects/<project>/todos", methods=["GET"])
def list_todos(project):
    try:
        path = _safe_project(project)
    except _PathError as e:
        return _err(str(e))
    if not os.path.exists(path):
        return jsonify({"todos": []})
    out = []
    for root, dirs, files in _walk_visible(path):
        for f in files:
            if not f.endswith(".tex"):
                continue
            full = os.path.join(root, f)
            rel  = os.path.relpath(full, path).replace("\\", "/")
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as fh:
                    for lineno, line in enumerate(fh, start=1):
                        # \todo{...} can appear in code (not in a % comment)
                        # so we test the un-stripped form.
                        for m in _TODONOTE_RE.finditer(line):
                            out.append({
                                "kind": "todo",
                                "file": rel,
                                "line": lineno,
                                "text": m.group(1).strip()[:200],
                            })
                        # % TODO / % FIXME / % XXX — check we're past a `%`
                        # so that `something\%TODO` (escaped percent) isn't
                        # misclassified.
                        # Find first un-escaped %
                        i = 0
                        pct = -1
                        while i < len(line):
                            if line[i] == "\\" and i + 1 < len(line):
                                i += 2; continue
                            if line[i] == "%":
                                pct = i; break
                            i += 1
                        if pct < 0:
                            continue
                        m = _COMMENT_TODO_RE.search(line[pct:])
                        if not m:
                            continue
                        out.append({
                            "kind": m.group(1).upper(),
                            "file": rel,
                            "line": lineno,
                            "text": m.group(2).strip()[:200],
                        })
            except Exception:
                continue
    out.sort(key=lambda x: (x["file"], x["line"]))
    return jsonify({"todos": out})

# ── v3.2.3 — Word-count-per-chapter goals ───────────────────────────
# Each project may carry a `.texlocal-goals.json` at its root containing
# `{ "<rel_path.tex>": <target_word_count>, ... }`. The endpoint also
# computes current word counts for every .tex file in the project so the
# frontend can show progress without a separate call.
#
# Word-counter notes:
#   • Strips line comments respecting `\%` escapes.
#   • Drops command tokens (`\foo`, `\foo[bar]`) but keeps their {arg}
#     contents, since those are usually the prose worth counting.
#   • Counts contiguous letter runs in both Latin and Thai (U+0E00–0E7F)
#     so a mixed-language thesis is measured fairly.
_WORDCOUNT_CMD_RE = re.compile(r'\\[a-zA-Z]+\*?(?:\[[^\]]*\])?')
_WORDCOUNT_TOKEN_RE = re.compile(r'[A-Za-z฀-๿]+')

def _word_count_tex(text):
    if not text:
        return 0
    out_lines = []
    for line in text.split("\n"):
        i = 0
        cut = len(line)
        while i < len(line):
            if line[i] == "\\" and i + 1 < len(line):
                i += 2
                continue
            if line[i] == "%":
                cut = i
                break
            i += 1
        out_lines.append(line[:cut])
    stripped = "\n".join(out_lines)
    stripped = _WORDCOUNT_CMD_RE.sub(" ", stripped)
    stripped = stripped.replace("{", " ").replace("}", " ")
    return len(_WORDCOUNT_TOKEN_RE.findall(stripped))

@app.route("/api/projects/<project>/goals", methods=["GET", "POST"])
def project_goals(project):
    try:
        path = _safe_project(project)
    except _PathError as e:
        return _err(str(e))
    if not os.path.exists(path):
        return jsonify({"goals": {}, "counts": {}})
    goals_path = os.path.join(path, ".texlocal-goals.json")

    if request.method == "POST":
        data = request.json or {}
        goals = data.get("goals") or {}
        if not isinstance(goals, dict):
            return _err("goals must be a dict of path → target")
        clean = {}
        for k, v in goals.items():
            if not isinstance(k, str) or not k.strip():
                continue
            try:
                iv = int(v)
            except (TypeError, ValueError):
                continue
            if iv <= 0:
                # 0/negative removes the goal — drop the entry instead of saving
                continue
            clean[k.strip()] = iv
        try:
            with open(goals_path, "w", encoding="utf-8") as fh:
                json.dump(clean, fh, ensure_ascii=False, indent=2)
        except OSError as e:
            return _err(f"Could not write goals: {e}")
        return jsonify({"ok": True, "goals": clean})

    # GET — load saved goals + compute current word counts
    goals = {}
    if os.path.exists(goals_path):
        try:
            with open(goals_path, "r", encoding="utf-8") as fh:
                loaded = json.load(fh)
            if isinstance(loaded, dict):
                goals = {k: int(v) for k, v in loaded.items()
                         if isinstance(k, str) and isinstance(v, (int, float))}
        except Exception:
            goals = {}
    counts = {}
    for root, dirs, files in _walk_visible(path):
        for f in files:
            if not f.endswith(".tex"):
                continue
            full = os.path.join(root, f)
            rel  = os.path.relpath(full, path).replace("\\", "/")
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as fh:
                    counts[rel] = _word_count_tex(fh.read())
            except Exception:
                counts[rel] = 0
    return jsonify({"goals": goals, "counts": counts})

# ── v3.3.0 — Snippet library ──────────────────────────────────────────
# Per-project `.texlocal-snippets.json` at project root. Map of trigger →
# body. Frontend ships a baked-in default set; this endpoint stores the
# user's per-project overrides/additions. Storage is local file (not
# localStorage) so snippets travel with the project zip and survive a
# browser reset. Empty map / missing file is legal — frontend just uses
# defaults.
#
# Body syntax convention (parsed on the frontend):
#   ${1}, ${2}, ${0} (final cursor) — placeholders with Tab-cycle order.
#   ${1:default}    — placeholder with default text pre-selected.
@app.route("/api/projects/<project>/snippets", methods=["GET", "POST"])
def project_snippets(project):
    try:
        path = _safe_project(project)
    except _PathError as e:
        return _err(str(e))
    snippets_file = os.path.join(path, ".texlocal-snippets.json")

    if request.method == "POST":
        data = request.json or {}
        snips = data.get("snippets") or {}
        if not isinstance(snips, dict):
            return _err("snippets must be a dict of trigger → body")
        # Sanitise: trigger must be non-empty string, no whitespace (since
        # the frontend Tab-handler looks for `\w[\w*]*$` before the cursor —
        # spaces would never match). Body must be a string. Reject anything
        # else silently so a partly-malformed map still saves the good rows.
        clean = {}
        for k, v in snips.items():
            if not isinstance(k, str) or not k.strip():
                continue
            k = k.strip()
            if any(c.isspace() for c in k):
                continue
            if not isinstance(v, str):
                continue
            clean[k] = v
        try:
            # Atomic write — tmp + rename so a half-written file can't
            # leave the project with no snippets on a crash mid-write.
            tmp = snippets_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(clean, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, snippets_file)
        except OSError as e:
            return _err(f"Could not write snippets: {e}")
        return jsonify({"ok": True, "snippets": clean})

    # GET
    if not os.path.exists(snippets_file):
        return jsonify({"snippets": {}})
    try:
        with open(snippets_file, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
        if not isinstance(loaded, dict):
            return jsonify({"snippets": {}})
        return jsonify({"snippets": {k: v for k, v in loaded.items()
                                     if isinstance(k, str) and isinstance(v, str)}})
    except Exception as e:
        return jsonify({"snippets": {}, "warn": str(e)})

# v3.3.2 — Custom-dictionary endpoint for the English spell checker.
# Reads `.texlocal-dict.txt` at the project root. One word per line. Lines
# starting with `#` or `;` are comments. Empty lines ignored. Everything is
# normalised to lowercase on the frontend (case-insensitive lookup) so the
# file itself can use whatever case the author finds readable.
#
# GET only — adds happen by editing the file directly (cleaner audit trail,
# survives /export-zip, no risk of races between concurrent UI tabs).
#
# v3.3.3 — POST handler added for right-click "Add to dictionary". Appends
# atomically, dedupes case-insensitively, auto-creates the file with a header
# stub if it doesn't yet exist so Pol doesn't have to bootstrap by hand.
#
# Why a flat .txt instead of JSON: dict additions are one-per-line edits the
# user wants to do in any text editor. JSON forces quoting + comma discipline
# for what is naturally a word list.
_DICT_HEADER_STUB = (
    "# TexLocal custom dictionary (auto-created)\n"
    "# One word per line. Lines starting with `#` or `;` are comments.\n"
    "# Case is ignored (case-insensitive lookup on the frontend).\n"
    "# Added words appear at the bottom under \"# ── Added via right-click ──\".\n"
    "\n"
)
_DICT_RIGHTCLICK_MARKER = "# ── Added via right-click ──"

def _read_dict_words(dict_file):
    """Return (words_list, lowercase_set) from the dict file, or empty pair."""
    words, lc = [], set()
    if not os.path.exists(dict_file):
        return words, lc
    try:
        with open(dict_file, "r", encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or line.startswith(";"):
                    continue
                for tok in line.split():
                    if tok:
                        words.append(tok)
                        lc.add(tok.lower())
    except OSError:
        pass
    return words, lc

@app.route("/api/projects/<project>/dict", methods=["GET", "POST", "DELETE"])
def project_dict(project):
    try:
        path = _safe_project(project)
    except _PathError as e:
        return _err(str(e))
    dict_file = os.path.join(path, ".texlocal-dict.txt")

    # ── GET — return the current word list + mtime ───────────────────
    # v3.3.5 — mtime added so the frontend can cheaply detect external
    # edits (e.g. user edited `.texlocal-dict.txt` in VS Code) and hot-
    # reload customDict on window focus without reloading the page.
    # 0.0 when the file doesn't exist yet (no race vs a future creation —
    # the next focus tick will see a non-zero mtime and reload then).
    if request.method == "GET":
        words, _ = _read_dict_words(dict_file)
        try:
            mtime = os.path.getmtime(dict_file) if os.path.exists(dict_file) else 0.0
        except OSError:
            mtime = 0.0
        return jsonify({"words": words, "mtime": mtime})

    # ── DELETE — remove a word from the dict (case-insensitive) ──────
    # v3.3.5 — Powers the "Manage custom dictionary" modal's per-row ×
    # button. Strategy: read the file line-by-line, drop any line whose
    # single-token content matches the target word (lowercased), keep
    # comments and the rightclick marker untouched. Atomic write via
    # tmp + os.replace so a crash mid-write can't leave a half-empty
    # dict file.
    if request.method == "DELETE":
        data = request.json or {}
        word = (data.get("word") or "").strip()
        if not word:
            return _err("Word required")
        target = word.lower()
        if not os.path.exists(dict_file):
            return jsonify({"ok": True, "removed": False, "word": word,
                            "reason": "file_missing"})
        try:
            with open(dict_file, "r", encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()
        except OSError as e:
            return _err(f"Cannot read dict file: {e}")
        kept, removed = [], False
        for raw in lines:
            stripped = raw.strip()
            # Comments / marker / blank lines pass through untouched.
            if not stripped or stripped.startswith("#") or stripped.startswith(";"):
                kept.append(raw)
                continue
            # A dict line may carry multiple whitespace-separated tokens
            # (rare, but _read_dict_words supports it). Strip only matching
            # tokens; keep the rest. If the line becomes empty, drop it.
            toks = stripped.split()
            new_toks = [t for t in toks if t.lower() != target]
            if len(new_toks) != len(toks):
                removed = True
                if new_toks:
                    # Preserve the trailing newline style of the original
                    # line so the file's line endings stay consistent.
                    nl = "\n" if raw.endswith("\n") else ""
                    kept.append(" ".join(new_toks) + nl)
                # else: line dropped entirely
            else:
                kept.append(raw)
        if not removed:
            return jsonify({"ok": True, "removed": False, "word": word,
                            "reason": "not_found"})
        tmp = dict_file + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.writelines(kept)
            os.replace(tmp, dict_file)
        except OSError as e:
            return _err(f"Cannot write dict file: {e}")
        return jsonify({"ok": True, "removed": True, "word": word})

    # ── POST — append one word, dedupe, auto-create file if missing ──
    data = request.json or {}
    word = (data.get("word") or "").strip()
    if not word:
        return _err("Word required")
    # Defensive: only allow word-shaped tokens. No whitespace, no newlines,
    # no path separators. Allow apostrophe (don't, it's), hyphen (well-known),
    # Latin letters incl. accents. Cap length to keep dict files tidy.
    if len(word) > 64:
        return _err("Word too long (max 64 chars)")
    if any(c.isspace() or c in "\\/\x00" for c in word):
        return _err("Invalid characters in word")

    _, existing_lc = _read_dict_words(dict_file)
    if word.lower() in existing_lc:
        return jsonify({"ok": True, "added": False, "word": word, "reason": "duplicate"})

    # Append. Create file with header stub if missing.
    try:
        if not os.path.exists(dict_file):
            with open(dict_file, "w", encoding="utf-8") as fh:
                fh.write(_DICT_HEADER_STUB)
                fh.write(_DICT_RIGHTCLICK_MARKER + "\n")
                fh.write(word + "\n")
        else:
            # If the marker isn't there yet, add it once before the first
            # right-click addition so subsequent entries cluster together.
            with open(dict_file, "r", encoding="utf-8", errors="replace") as fh:
                content = fh.read()
            with open(dict_file, "a", encoding="utf-8") as fh:
                # Ensure a trailing newline before any appends.
                if content and not content.endswith("\n"):
                    fh.write("\n")
                if _DICT_RIGHTCLICK_MARKER not in content:
                    fh.write("\n" + _DICT_RIGHTCLICK_MARKER + "\n")
                fh.write(word + "\n")
    except OSError as e:
        return _err(f"Cannot write dict file: {e}")

    return jsonify({"ok": True, "added": True, "word": word})

@app.route("/api/projects/<project>/replace-all", methods=["POST"])
def replace_all(project):
    """v3.2.2 — Project-wide find & replace across .tex / .bib files.
    Body: { find: str, replace: str, regex?: bool, case?: bool, files?: [str] }
    Returns: { ok, total_replacements, files: [{path, count, preview}] }
    Atomic per-file: writes only if at least one replacement happened.
    """
    data = request.json or {}
    find    = data.get("find", "")
    repl    = data.get("replace", "")
    use_re  = bool(data.get("regex", False))
    case_s  = bool(data.get("case", False))
    files   = data.get("files") or None  # if provided, restrict to these
    if not find:
        return _err("Find pattern required")
    try:
        path = _safe_project(project)
    except _PathError as e:
        return _err(str(e))
    # Compile regex (or escape literal)
    flags = 0 if case_s else re.IGNORECASE
    try:
        pattern = re.compile(find if use_re else re.escape(find), flags)
    except re.error as e:
        return _err(f"Invalid regex: {e}")

    affected = []
    total = 0
    candidates = []
    if files:
        # Sandbox each requested path
        for rel in files:
            try:
                full = _safe_join(path, rel)
            except _PathError:
                continue
            if os.path.isfile(full):
                candidates.append((rel.replace("\\", "/"), full))
    else:
        for root, dirs, fs in _walk_visible(path):
            for f in fs:
                if not (f.endswith(".tex") or f.endswith(".bib")):
                    continue
                full = os.path.join(root, f)
                rel  = os.path.relpath(full, path).replace("\\", "/")
                candidates.append((rel, full))

    # v4.3.1 — two-phase: compute ALL replacements in memory first, then
    # write. WHY: the old loop wrote files one-by-one, so a failure on file
    # N left files 1..N-1 already modified and N..end untouched — a project
    # stuck half-replaced with no rollback. Now nothing is touched until
    # every new content is built; writes are atomic; and if any write fails
    # we report it without having partially-applied a confusing subset.
    pending = []  # (rel, full, new_src, n, first_line)
    for rel, full in candidates:
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as fh:
                src = fh.read()
        except Exception:
            continue
        new_src, n = pattern.subn(repl, src)
        if n == 0:
            continue
        first_line = ""
        for ln in src.splitlines():
            if pattern.search(ln):
                first_line = ln.strip()[:160]
                break
        pending.append((rel, full, new_src, n, first_line))

    written = []
    for rel, full, new_src, n, first_line in pending:
        try:
            _atomic_write_text(full, new_src)
        except Exception as e:
            # Atomic writes mean already-written files are intact whole files
            # (not corrupted); we just stop and report which ones did apply.
            return _err(
                f"Write failed for {rel}: {e}. "
                f"Applied to {len(written)} of {len(pending)} file(s) before stopping.",
                500)
        written.append(rel)
        affected.append({"path": rel, "count": n, "preview": first_line})
        total += n
    return jsonify({"ok": True, "total_replacements": total, "files": affected})

@app.route("/api/projects/<project>/raw", methods=["GET"])
def raw_file(project):
    filepath = request.args.get("path", "")
    try:
        full = _safe_join(_safe_project(project), filepath)
    except _PathError:
        return "Invalid path", 400
    if not os.path.exists(full):
        return "Not found", 404
    return send_file(full)

@app.route("/api/projects/<project>/pdf", methods=["GET"])
def get_pdf(project):
    filename = request.args.get("file", "main.pdf")
    try:
        full = _safe_join(_safe_project(project), filename)
    except _PathError:
        return "Invalid path", 400
    if not os.path.exists(full):
        return "PDF not found", 404
    return send_file(full, mimetype="application/pdf")


# ── Auto-update (v4.2.0-phase4) ──────────────────────────────────────
# Compares running TEXLOCAL_VERSION against GitHub Releases "latest" tag.
# Frontend banner polls /check on startup; if `available=True`, user can
# trigger /download → /progress polling → /apply (which launches the new
# installer in a detached process and exits TexLocal so Windows can
# replace TexLocal.exe).
#
# Single-user app, so the download state lives in a module-level dict.
# No locking — at most one update flow can be in progress per process.

_update_state = {
    "phase": "idle",       # idle | downloading | ready | error
    "downloaded": 0,
    "total": 0,
    "installer_path": None,
    "error": None,
}
_update_lock = threading.Lock()


def _parse_version(s: str):
    """Parse 'v4.2.0' / '4.2.0' / '4.2.0-phase4' into comparable tuple.
    Strips leading 'v' and trailing '-phaseN' / '-rc' / etc."""
    if not s:
        return (0, 0, 0)
    s = s.lstrip("vV").split("-", 1)[0].split("+", 1)[0]
    parts = []
    for x in s.split("."):
        try:
            parts.append(int(x))
        except ValueError:
            break
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


@app.route("/api/update/check", methods=["GET"])
def update_check():
    """Query GitHub Releases API for latest release. Compare with current
    version. Returns:
      {available: bool, current: str, latest: str|null,
       url: str|null, asset_url: str|null, asset_name: str|null,
       error: str|null}
    Network failure -> available=false + error filled. Frontend treats
    error case as silent (no banner)."""
    try:
        req = urllib.request.Request(
            TEXLOCAL_GITHUB_API,
            headers={"Accept": "application/vnd.github+json",
                     "User-Agent": f"TexLocal/{TEXLOCAL_VERSION}"},
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # v4.2.4 - classify common GitHub failures into user-friendly text.
        # 404 = repo missing OR no releases published yet (most common for
        # brand-new repo). 403 = rate limit. Others surface raw HTTP code.
        if e.code == 404:
            msg = "No releases published yet on the repo."
        elif e.code == 403:
            msg = "GitHub rate limit hit (60/hr unauthenticated). Try again later."
        else:
            msg = f"GitHub returned HTTP {e.code}."
        return jsonify({
            "available": False, "current": TEXLOCAL_VERSION,
            "latest": None, "url": None, "asset_url": None,
            "asset_name": None, "error": msg, "error_code": e.code,
        })
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        return jsonify({
            "available": False, "current": TEXLOCAL_VERSION,
            "latest": None, "url": None, "asset_url": None,
            "asset_name": None, "error": f"Network error: {e}", "error_code": 0,
        })

    tag = data.get("tag_name", "")
    latest = _parse_version(tag)
    current = _parse_version(TEXLOCAL_VERSION)

    # Pick the first .exe asset whose name contains "Setup" (matches
    # `TexLocal-Setup-X.Y.Z.exe` produced by texlocal.iss).
    asset_url = None
    asset_name = None
    for asset in data.get("assets", []):
        name = asset.get("name", "")
        if name.lower().endswith(".exe") and "setup" in name.lower():
            asset_url = asset.get("browser_download_url")
            asset_name = name
            break

    return jsonify({
        "available": latest > current,
        "current": TEXLOCAL_VERSION,
        "latest": tag,
        "url": data.get("html_url") or TEXLOCAL_GITHUB_RELEASES_PAGE,
        "asset_url": asset_url,
        "asset_name": asset_name,
        "error": None,
    })


def _download_installer(url: str, dest: str) -> None:
    """Background worker — stream installer to disk, update _update_state."""
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": f"TexLocal/{TEXLOCAL_VERSION}"})
        with urllib.request.urlopen(req, timeout=20) as r:
            total = int(r.headers.get("Content-Length", "0") or 0)
            with _update_lock:
                _update_state["total"] = total
            with open(dest, "wb") as f:
                while True:
                    chunk = r.read(64 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    with _update_lock:
                        _update_state["downloaded"] += len(chunk)
        with _update_lock:
            _update_state["phase"] = "ready"
            _update_state["installer_path"] = dest
    except Exception as e:
        with _update_lock:
            _update_state["phase"] = "error"
            _update_state["error"] = str(e)
        try:
            if os.path.exists(dest):
                os.remove(dest)  # don't leave partial .exe lying around
        except OSError:
            pass


@app.route("/api/update/download", methods=["POST"])
def update_download():
    """Start downloading the installer in a background thread.
    Body: {asset_url, asset_name}. Idempotent if already downloading."""
    body = request.get_json(silent=True) or {}
    asset_url = body.get("asset_url")
    asset_name = body.get("asset_name") or "TexLocal-Setup.exe"
    if not asset_url:
        return _err("asset_url required", 400)

    with _update_lock:
        if _update_state["phase"] in ("downloading", "ready"):
            return jsonify({"ok": True, "state": _update_state["phase"]})
        # Reset state for a fresh download
        _update_state.update({
            "phase": "downloading", "downloaded": 0, "total": 0,
            "installer_path": None, "error": None,
        })

    # Sanitise the filename — only the basename, no path traversal
    asset_name = os.path.basename(asset_name).replace("..", "_")
    dest = os.path.join(tempfile.gettempdir(), asset_name)

    t = threading.Thread(
        target=_download_installer, args=(asset_url, dest),
        daemon=True, name="texlocal-update-download",
    )
    t.start()
    return jsonify({"ok": True, "state": "downloading", "dest": dest})


@app.route("/api/update/progress", methods=["GET"])
def update_progress():
    """Polled by the frontend every ~500ms during download."""
    with _update_lock:
        return jsonify({
            "phase": _update_state["phase"],
            "downloaded": _update_state["downloaded"],
            "total": _update_state["total"],
            "installer_path": _update_state["installer_path"],
            "error": _update_state["error"],
        })


@app.route("/api/update/apply", methods=["POST"])
def update_apply():
    """Launch installer in a detached process, then exit TexLocal so the
    installer can replace TexLocal.exe.  Inno's CloseApplications=yes is
    belt-and-braces; the explicit os._exit here is what makes the timing
    reliable."""
    with _update_lock:
        if _update_state["phase"] != "ready":
            return _err(f"update not ready (phase={_update_state['phase']})", 400)
        installer_path = _update_state["installer_path"]

    if not installer_path or not os.path.exists(installer_path):
        return _err("installer file missing", 500)

    # Spawn detached so the installer survives TexLocal exit. On Windows we
    # need both DETACHED_PROCESS (no console inherit) and CREATE_BREAKAWAY
    # (no job-object inherit, otherwise child dies with parent in some
    # WebView2 / pywebview lifecycles).
    DETACHED_PROCESS = 0x00000008
    CREATE_BREAKAWAY_FROM_JOB = 0x01000000
    try:
        subprocess.Popen(
            [installer_path],
            close_fds=True,
            creationflags=DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB,
        )
    except OSError as e:
        return _err(f"failed to launch installer: {e}", 500)

    # Schedule a delayed os._exit so this HTTP response can still flush
    # back to the frontend before the process dies.
    def _shutdown():
        import time as _t
        _t.sleep(0.5)
        os._exit(0)
    threading.Thread(target=_shutdown, daemon=True).start()

    return jsonify({"ok": True, "exiting": True})


if __name__ == "__main__":
    print(f"\n  TeX Local v{TEXLOCAL_VERSION} (browser mode) running at http://localhost:5000\n")
    # v4.3.1 — debug=False: Werkzeug's debug=True exposes an interactive
    # code-execution console and an auto-reloader that can restart the server
    # mid-write. Neither is wanted in normal use. Bind explicitly to loopback.
    app.run(debug=False, host="127.0.0.1", port=5000)
