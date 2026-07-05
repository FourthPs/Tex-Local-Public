import { CM, CM6_ENGINE, bibkeysCache, cmEditor, labelsCache } from "editor";

// static/linter.js — TexLocal Phase 3 module split (v5.0.0-beta.3.0)
// Cross-reference live linter (\cite/\ref markText underlines) + the stex syntax linter (registerHelper('lint','stex') + gutters/lint setOption).
// Interim shared-scope: a classic <script defer>, NOT an ES module — shares
// editor.js's global scope (module-level state + CM adapter facade + core
// state/helpers). Loads AFTER editor.js core and BEFORE boot.js. CM access is
// via the CM.* facade only (Phase 1 containment) — 0 raw cmEditor./CodeMirror.

// ── v3.2.3 — CROSS-REFERENCE LIVE LINTER ───────────────────────
// Walks the active document, finds every \cite{}, \ref{}, \eqref{},
// \autoref{}, \cref{}, \Cref{} call and underlines individual keys (split
// by comma) that aren't present in their respective caches.
//
// `markText` is the CodeMirror v5 API for inline highlights. We collect each
// returned handle so we can clear() them before re-running. Underline only
// the offending key, not the whole call, so a partially-wrong multi-cite
// still surfaces the exact bad key.
const _XREF_RE = /\\([a-zA-Z]*cite[a-zA-Z]*|ref|eqref|autoref|cref|Cref)\{([^}]+)\}/g;   // v4.9.7 (B3) — cite branch widened to any *cite* command (biblatex \parencite/\autocite/\textcite/\footcite/…) so the live linter matches backend _CITE_CMD_RE + the audit
let _xrefMarks = [];
let _xrefLintTimer = null;
export function lintCrossRefs() {
  if (typeof cmEditor === "undefined" || !cmEditor) return;
  // Clear old marks first — markText handles return objects with .clear()
  for (const m of _xrefMarks) {
    try { m.clear(); } catch (_) {}
  }
  _xrefMarks = [];
  // Skip when both caches are empty (project just loaded, before /cite-data
  // populates them). Otherwise every key would falsely flag as broken.
  if (!bibkeysCache.length && !labelsCache.length) return;
  const bibSet   = new Set(bibkeysCache.map(b => b.key));
  const labelSet = new Set(labelsCache.map(l => l.name));
  const totalLines = CM.lineCount();
  for (let lineNo = 0; lineNo < totalLines; lineNo++) {
    const text = CM.getLine(lineNo);
    if (!text) continue;
    if (text.indexOf("cite") < 0 && text.indexOf("\\ref") < 0
        && text.indexOf("\\eqref") < 0 && text.indexOf("\\autoref") < 0
        && text.indexOf("\\cref") < 0 && text.indexOf("\\Cref") < 0) continue;
    _XREF_RE.lastIndex = 0;
    let m;
    while ((m = _XREF_RE.exec(text)) !== null) {
      const cmd       = m[1];
      const inner     = m[2];
      const isCite    = cmd.includes("cite");   // v4.9.7 (B3) — any *cite* command → bib-scope (ref-family contains no "cite")
      const targetSet = isCite ? bibSet : labelSet;
      const innerStart = m.index + cmd.length + 2;   // "\<cmd>{"
      // Each key may be separated by comma + optional whitespace.
      let cursor = 0;
      for (const part of inner.split(",")) {
        const lead = part.match(/^\s*/)[0].length;
        const trimmed = part.trim();
        const keyStart = innerStart + cursor + lead;
        cursor += part.length + 1;             // +1 for comma
        if (!trimmed) continue;
        if (targetSet.has(trimmed)) continue;
        // Found a broken key — mark it with the wavy underline.
        const mark = CM.markText(
          { line: lineNo, ch: keyStart },
          { line: lineNo, ch: keyStart + trimmed.length },
          {
            className: "cm-xref-broken",
            title: isCite
              ? `Citation key not found: ${trimmed}`
              : `Label not found: ${trimmed}`,
          },
        );
        _xrefMarks.push(mark);
      }
    }
  }
}

export function scheduleCrossRefLint() {
  // Debounced so it doesn't run on every keystroke. 400ms is fast enough that
  // typing a citation key feels live but slow enough to skip the scan during
  // burst-edits.
  clearTimeout(_xrefLintTimer);
  _xrefLintTimer = setTimeout(lintCrossRefs, 400);
}

function _buildLatexSkipRanges(text) {
  const ranges = [];
  // \verb*?X...X  (any delimiter char)
  const verbRe = /\\verb\*?(.)/g;
  let m;
  while ((m = verbRe.exec(text)) !== null) {
    const delim = m[1];
    const start = m.index;
    const end   = text.indexOf(delim, m.index + m[0].length);
    if (end >= 0) ranges.push([start, end + 1]);
  }
  // \begin{verbatim}...\end{verbatim}
  const venvRe = /\\begin\{verbatim\*?\}[\s\S]*?\\end\{verbatim\*?\}/g;
  while ((m = venvRe.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  // % line comments — skip from % to end of line (but not \%)
  const commentRe = /(?<!\\)%[^\n]*/g;
  while ((m = commentRe.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function _latexInSkip(ranges, pos) {
  for (const [a, b] of ranges) { if (pos >= a && pos < b) return true; }
  return false;
}

function _latexOffsetToPos(text, offset) {
  const before = text.slice(0, offset);
  const lines  = before.split('\n');
  return { line: lines.length - 1, ch: lines[lines.length - 1].length };
}

export function _initLinter() {
CM.registerHelper('lint', 'stex', function(text) {
  const errors = [];
  const skip   = _buildLatexSkipRanges(text);

  // ── 1. Brace balance ────────────────────────────────────────
  const braceStack = [];
  for (let i = 0; i < text.length; i++) {
    if (_latexInSkip(skip, i)) continue;
    if (text[i] === '\\') { i++; continue; }   // skip escaped char
    if (text[i] === '{') {
      braceStack.push(i);
    } else if (text[i] === '}') {
      if (braceStack.length === 0) {
        const p = _latexOffsetToPos(text, i);
        errors.push({ from: p, to: { line: p.line, ch: p.ch + 1 },
          message: 'Unmatched }', severity: 'error' });
      } else { braceStack.pop(); }
    }
  }
  // Report only the last 3 unmatched opens to avoid flooding
  braceStack.slice(-3).forEach(idx => {
    const p = _latexOffsetToPos(text, idx);
    errors.push({ from: p, to: { line: p.line, ch: p.ch + 1 },
      message: 'Unmatched {', severity: 'error' });
  });

  // ── 2. \begin / \end environment matching ───────────────────
  const envStack = [];
  const envRe = /\\(begin|end)\{([^}]*)\}/g;
  let em;
  while ((em = envRe.exec(text)) !== null) {
    if (_latexInSkip(skip, em.index)) continue;
    const kind = em[1], env = em[2].trim();
    if (kind === 'begin') {
      envStack.push({ env, index: em.index, len: em[0].length });
    } else {
      if (envStack.length === 0) {
        const p = _latexOffsetToPos(text, em.index);
        errors.push({ from: p, to: { line: p.line, ch: p.ch + em[0].length },
          message: `\\end{${env}} without matching \\begin`, severity: 'error' });
      } else {
        const last = envStack[envStack.length - 1];
        if (last.env === env) { envStack.pop(); }
        else {
          const p = _latexOffsetToPos(text, em.index);
          errors.push({ from: p, to: { line: p.line, ch: p.ch + em[0].length },
            message: `\\end{${env}} but expected \\end{${last.env}}`, severity: 'warning' });
        }
      }
    }
  }
  envStack.slice(-3).forEach(({ env, index, len }) => {
    const p = _latexOffsetToPos(text, index);
    errors.push({ from: p, to: { line: p.line, ch: p.ch + len },
      message: `\\begin{${env}} never closed`, severity: 'warning' });
  });

  // ── 3. Unclosed $ (inline math) ─────────────────────────────
  // Walk the document, count unescaped single $ (not $$).
  // An odd total means one $ is unpaired; report at its position.
  let dollarCount = 0, lastDollarIdx = -1;
  for (let i = 0; i < text.length; i++) {
    if (_latexInSkip(skip, i)) continue;
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '$') {
      if (text[i + 1] === '$') { i++; continue; }  // skip $$
      dollarCount++;
      lastDollarIdx = i;
    }
  }
  if (dollarCount % 2 !== 0 && lastDollarIdx >= 0) {
    const p = _latexOffsetToPos(text, lastDollarIdx);
    errors.push({ from: p, to: { line: p.line, ch: p.ch + 1 },
      message: 'Unclosed $ — odd number of inline math delimiters in file', severity: 'warning' });
  }

  return errors;
});

// Enable lint gutter and linting on the editor.
// setOption after init avoids re-specifying the whole gutters array.
CM.setOption('gutters', [
  'CodeMirror-linenumbers', 'CodeMirror-foldgutter',
  'CodeMirror-lint-markers', 'cm-errors-gutter'
]);
CM.setOption('lint', { delay: 600 });   // 600ms after last keystroke

}