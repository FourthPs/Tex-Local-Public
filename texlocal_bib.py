"""texlocal_bib.py — BibTeX + \\cite/label parsing helpers, extracted from texlocal.py.

Backend split increment 3 (2026-07-06). Pure text parsers (input str -> structured
data; no Flask, no file IO, no app config). Re-imported into texlocal.py so
texlocal.<name>, _build_cite_data (kept there), the bib routes, and tests/test_bib.py
all resolve unchanged. Covered by tests/test_bib.py.
Kept in texlocal.py: _build_cite_data (uses _walk_visible + caches), the mtime caches,
and _CITE_CMD_RE (used by the audit/remove-unused routes).
"""
import re


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
        # Skip TexLocal-disabled (commented) entries so they drop out of the
        # \cite{ autocomplete just like they drop out of the audit.
        if _bib_at_commented(text, at):
            i = j
            continue
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

def _strip_tex_comment(line):
    """Return `line` with any trailing TeX comment removed. A `%` counts as a
    comment start only when not escaped as `\%`."""
    i = 0
    while i < len(line):
        if line[i] == "\\" and i + 1 < len(line):
            i += 2
            continue
        if line[i] == "%":
            return line[:i]
        i += 1
    return line

def _iter_bib_keys_with_pos(text):
    """Yield (key, line_no) for every real @entry in a .bib string, skipping
    @string/@comment/@preamble. Mirrors _parse_bib_text's brace matching but
    keeps EVERY occurrence (no dedupe) so duplicate keys are visible, and
    reports the 1-based line of the `@`."""
    i, n = 0, len(text)
    while i < n:
        at = text.find('@', i)
        if at < 0:
            break
        ob = text.find('{', at)
        if ob < 0:
            break
        type_str = text[at + 1:ob].strip().lower()
        depth, j = 1, ob + 1
        while j < n and depth > 0:
            if   text[j] == '{': depth += 1
            elif text[j] == '}': depth -= 1
            j += 1
        if type_str in ('string', 'comment', 'preamble') or _bib_at_commented(text, at):
            i = j
            continue
        body = text[ob + 1:j - 1]
        comma = body.find(',')
        if comma >= 0:
            key = body[:comma].strip()
            if key:
                yield key, text.count('\n', 0, at) + 1
        i = j

def _bib_at_commented(text, at):
    """True if the `@` at offset `at` sits on a line whose first non-whitespace
    char is `%` — i.e. the entry has been commented out (TexLocal convention:
    unused entries are disabled by prefixing every line with `%`). Note BibTeX
    itself doesn't treat `%` as a comment, but disabled entries here are always
    uncited, so they never reach BibTeX output regardless; this keeps TexLocal's
    own autocomplete/audit consistent with what the user sees struck out."""
    ls = text.rfind("\n", 0, at) + 1
    return text[ls:at].lstrip().startswith("%")

def _iter_bib_entry_spans(text):
    """Yield (key, start, end, commented) for every real @entry, where
    start=offset of `@` and end=offset just past the entry's closing brace.
    Used by /bib-remove-unused to excise/comment exact byte ranges. Unlike
    _iter_bib_keys_with_pos this does NOT skip commented entries — the caller
    needs the flag to avoid re-commenting an already-disabled entry."""
    i, n = 0, len(text)
    while i < n:
        at = text.find('@', i)
        if at < 0:
            break
        ob = text.find('{', at)
        if ob < 0:
            break
        type_str = text[at + 1:ob].strip().lower()
        depth, j = 1, ob + 1
        while j < n and depth > 0:
            if   text[j] == '{': depth += 1
            elif text[j] == '}': depth -= 1
            j += 1
        if type_str not in ('string', 'comment', 'preamble'):
            body = text[ob + 1:j - 1]
            comma = body.find(',')
            if comma >= 0:
                key = body[:comma].strip()
                if key:
                    yield key, at, j, _bib_at_commented(text, at)
        i = j
