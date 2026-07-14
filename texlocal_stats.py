"""texlocal_stats.py — Project statistics report (STATS.md) generator.

Pure helper (no Flask, no app config, no module-level file IO beyond reading the
project's own source files that the caller points it at). Given a project path
plus the app's own word-counter / directory-walker / \\cite regex injected from
texlocal.py, it produces the Markdown text that /export-zip embeds as STATS.md.

Why dependency injection instead of re-deriving the numbers here: the app already
has ONE word counter (`_word_count_tex`, behind the Goals panel) and ONE
visibility-aware walker (`_walk_visible`). Reusing them keeps STATS.md's figures
identical to what the user sees in the app and avoids introducing a divergent
"third word counter" (the code review already flagged dual counters as a smell).
Bibliography parsing reuses texlocal_bib's tolerant BibTeX reader.

Added 2026-07-06 (v5.1.0) for the STATS.md export feature (Wishlist §6).
Pure functions → unit-testable in isolation (see tests/, mirrors bib/synctex).
"""
import os
import re
import time

from texlocal_bib import _strip_tex_comment, _parse_bib_text

# All counting regexes run over COMMENT-STRIPPED text (see _strip_comments) so a
# commented-out \begin{figure} / \cite / \section never inflates the totals.
# The mandatory backslash prefix + \b means \section can't match inside
# \subsection or \subsubsection (the char before "section" there is a letter,
# not a backslash), so each heading level is counted exactly once.
_RE_CHAPTER   = re.compile(r'\\chapter\*?\b')
_RE_SECTION   = re.compile(r'\\section\*?\b')
_RE_SUBSEC    = re.compile(r'\\subsection\*?\b')
_RE_SUBSUBSEC = re.compile(r'\\subsubsection\*?\b')
_RE_FIGURE    = re.compile(r'\\begin\{figure\*?\}')
_RE_INCGRAPH  = re.compile(r'\\includegraphics\b')
_RE_TABLE     = re.compile(r'\\begin\{table\*?\}')
_RE_TABULAR   = re.compile(r'\\begin\{(?:tabular\*?|tabularx|longtable|supertabular)\}')
# Numbered / display math environments (amsmath + core). \displaymath and \[ … \]
# are display math too; inline $…$ is intentionally NOT counted (prose-level).
_RE_EQN_ENV   = re.compile(
    r'\\begin\{(?:equation\*?|align\*?|gather\*?|multline\*?|flalign\*?'
    r'|eqnarray\*?|displaymath|dmath\*?|alignat\*?)\}')
# v5.1.1 — (?<!\\) so the LaTeX linebreak-with-space form `\\[5pt]` no longer
# counts as display math (its second backslash + `[` used to match `\\\[`).
_RE_DISPLAY   = re.compile(r'(?<!\\)\\\[')              # \[ … \] display opener
_RE_LABEL     = re.compile(r'\\label\{')
_RE_REF       = re.compile(
    r'\\(?:ref|eqref|pageref|autoref|nameref|cref|Cref|vref|vpageref|labelcref)\b')


def _strip_comments(text):
    """Comment-strip every line (respecting \\%) and rejoin, so all regex passes
    below see only live LaTeX."""
    return "\n".join(_strip_tex_comment(ln) for ln in text.split("\n"))


def _read(full):
    try:
        with open(full, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


def build_stats_md(path, project, version, word_count_fn, walk_fn, cite_re):
    """Return the STATS.md Markdown text for the project rooted at `path`.

    Injected deps (kept single-source with the rest of the app):
      word_count_fn(text)->int : house Thai/Latin-aware counter (Goals panel)
      walk_fn(path)            : visibility-filtered os.walk (skips .git etc.)
      cite_re                  : compiled \\cite-family regex, group(1)=key list
    """
    tex_words = {}                          # rel path -> word count
    n_chapter = n_section = n_subsec = n_subsubsec = 0
    n_figure = n_incgraph = n_table = n_tabular = 0
    n_eqn = n_label = n_ref = 0
    cite_cmds = key_refs = 0
    cited_keys = set()
    bib_keys = set()
    n_bib_files = 0

    for root, dirs, files in walk_fn(path):
        for f in files:
            full = os.path.join(root, f)
            rel  = os.path.relpath(full, path).replace("\\", "/")
            ext  = os.path.splitext(f)[1].lower()

            if ext == ".tex":
                raw = _read(full)
                if raw is None:
                    continue
                tex_words[rel] = word_count_fn(raw)
                code = _strip_comments(raw)
                n_chapter   += len(_RE_CHAPTER.findall(code))
                n_section   += len(_RE_SECTION.findall(code))
                n_subsec    += len(_RE_SUBSEC.findall(code))
                n_subsubsec += len(_RE_SUBSUBSEC.findall(code))
                n_figure    += len(_RE_FIGURE.findall(code))
                n_incgraph  += len(_RE_INCGRAPH.findall(code))
                n_table     += len(_RE_TABLE.findall(code))
                n_tabular   += len(_RE_TABULAR.findall(code))
                n_eqn       += len(_RE_EQN_ENV.findall(code)) + len(_RE_DISPLAY.findall(code))
                n_label     += len(_RE_LABEL.findall(code))
                n_ref       += len(_RE_REF.findall(code))
                for m in cite_re.finditer(code):
                    cite_cmds += 1
                    for k in m.group(1).split(","):
                        k = k.strip()
                        if k:
                            key_refs += 1
                            cited_keys.add(k)

            elif ext == ".bib":
                raw = _read(full)
                if raw is None:
                    continue
                n_bib_files += 1
                for e in _parse_bib_text(raw):        # commented entries skipped
                    bib_keys.add(e["key"])

    total_words  = sum(tex_words.values())
    cited_in_bib = cited_keys & bib_keys
    unused       = bib_keys - cited_keys
    missing      = cited_keys - bib_keys              # cited but in no .bib

    def row(label, n):
        return f"| {label} | {n:,} |"

    L = []
    L.append(f"# {project} — Project Statistics")
    L.append("")
    L.append(f"_Generated {time.strftime('%Y-%m-%d %H:%M')} by TexLocal v{version}_")
    L.append("")
    L.append("> Word counts use TexLocal's own Thai/Latin-aware counter — the same one")
    L.append("> behind the Goals panel — so they match what you see in the app. LaTeX")
    L.append("> word counts are always approximate: macros and math are excluded, and")
    L.append("> counts include every .tex file whether or not it's `\\include`d in the build.")
    L.append("")

    L.append("## Summary")
    L.append("")
    L.append("| Metric | Count |")
    L.append("|--------|------:|")
    L.append(row("Words (total)", total_words))
    L.append(row(".tex files", len(tex_words)))
    L.append(row("Chapters", n_chapter))
    L.append(row("Sections", n_section))
    L.append(row("Figures", n_figure))
    L.append(row("Tables", n_table))
    L.append(row("Numbered/display equations", n_eqn))
    L.append(row("Unique citations used", len(cited_keys)))
    L.append(row("Bibliography entries", len(bib_keys)))
    L.append("")

    L.append("## Word count per file")
    L.append("")
    if tex_words:
        L.append("| File | Words |")
        L.append("|------|------:|")
        for rel in sorted(tex_words):
            L.append(f"| {rel} | {tex_words[rel]:,} |")
        L.append(f"| **Total** | **{total_words:,}** |")
    else:
        L.append("_No .tex files found._")
    L.append("")

    L.append("## Document structure")
    L.append("")
    L.append("| Level | Count |")
    L.append("|-------|------:|")
    L.append(row("Chapters (`\\chapter`)", n_chapter))
    L.append(row("Sections (`\\section`)", n_section))
    L.append(row("Subsections (`\\subsection`)", n_subsec))
    L.append(row("Subsubsections (`\\subsubsection`)", n_subsubsec))
    L.append("")

    L.append("## Figures, tables & math")
    L.append("")
    L.append("| Item | Count |")
    L.append("|------|------:|")
    L.append(row("Figure environments", n_figure))
    L.append(row("`\\includegraphics`", n_incgraph))
    L.append(row("Table environments", n_table))
    L.append(row("Tabular environments", n_tabular))
    L.append(row("Numbered/display equations", n_eqn))
    L.append(row("`\\label`s", n_label))
    L.append(row("Cross-references (`\\ref` family)", n_ref))
    L.append("")

    L.append("## Citations & bibliography")
    L.append("")
    L.append("| Metric | Count |")
    L.append("|--------|------:|")
    L.append(row("`\\cite` commands", cite_cmds))
    L.append(row("Key references (incl. multi-key)", key_refs))
    L.append(row("Unique keys cited", len(cited_keys)))
    L.append(row(".bib files", n_bib_files))
    L.append(row("Bibliography entries", len(bib_keys)))
    L.append(row("Entries actually cited", len(cited_in_bib)))
    L.append(row("Unused entries", len(unused)))
    L.append(row("Cited but missing from .bib", len(missing)))
    L.append("")

    L.append("---")
    L.append("_Generated by TexLocal. Delete this file if you don't want it in your export._")
    L.append("")
    return "\n".join(L)
