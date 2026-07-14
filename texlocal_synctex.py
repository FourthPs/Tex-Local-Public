"""texlocal_synctex.py — direct SyncTeX(.gz) parser, extracted from texlocal.py.

Backend split increment 2 (2026-07-06). Pure stdlib parser (no Flask/app config):
reads a .synctex file and builds the per-line position index used by forward sync.
Re-imported into texlocal.py so texlocal.<name>, the /synctex/forward route, and
tests/test_synctex.py resolve unchanged. Covered by tests/test_synctex.py.
"""
import os, re, gzip


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
