import { CM, _spellHintTimer, _ssSpellHintTimer, bibkeysCache, customDict, labelsCache, spellChecker, spellSuggestEnabled, userCmdCache, userEnvCache } from "editor";
import { _buildSkipMask, _ensureSpellDict, _runSpellCheck, _suggestCache } from "spell";

// static/autocomplete.js — TexLocal Phase 3 module split (v5.0.0-beta.3.0)
// LaTeX command/env/cite/ref autocomplete (registerHelper('hint','latex')) + prose word suggestions (registerHelper('hint','proseword')).
// Interim shared-scope: a classic <script defer>, NOT an ES module — shares
// editor.js's global scope (module-level state + CM adapter facade + core
// state/helpers). Loads AFTER editor.js core and BEFORE boot.js. CM access is
// via the CM.* facade only (Phase 1 containment) — 0 raw cmEditor./CodeMirror.

// ── LATEX AUTOCOMPLETE ────────────────────────────────────────
// v4.4.0 — Scan the CURRENT buffer for command/environment definitions so a
// macro you just typed (\newcommand{\foo}) autocompletes immediately, before
// the project-wide cache (userCmdCache/userEnvCache) refreshes on next compile.
// Cached by changeGeneration so it only re-scans when the buffer changes.
let _bufDefs = { gen: null, cmds: [], envs: [] };
function _bufferDefs() {
  const gen = CM.changeGeneration();
  if (gen !== _bufDefs.gen) {
    const text = CM.getValue();
    const cmds = new Set(), envs = new Set();
    const cmdRe = /\\(?:newcommand|renewcommand|providecommand)\*?\s*\{?\\([a-zA-Z@]+)\}?|\\DeclareMathOperator\*?\s*\{\\([a-zA-Z@]+)\}|\\DeclarePairedDelimiter\*?\s*\{?\\([a-zA-Z@]+)\}?|\\(?:def|let)\s*\\([a-zA-Z@]+)/g;
    const envRe = /\\(?:re)?newenvironment\s*\{([^}]+)\}|\\newtheorem\*?\s*\{([^}]+)\}/g;
    let m;
    while ((m = cmdRe.exec(text))) { const n = m[1]||m[2]||m[3]||m[4]; if (n) cmds.add("\\"+n); }
    while ((m = envRe.exec(text))) { const e = (m[1]||m[2]||"").trim(); if (e) envs.add(e); }
    _bufDefs = { gen, cmds: [...cmds], envs: [...envs] };
  }
  return _bufDefs;
}

// v4.4.0 — Picking an environment from the \begin{…} autocomplete inserts the
// whole block: \begin{env} / indented body (cursor here) / \end{env}. List
// environments get an \item on the body line.
// v4.4.0 — Commands whose completion should append {} (cursor placed inside);
// _CMD_TWO_BRACE ones take two args → {}{}. Symbols/spacing/structure-only
// commands are NOT listed and insert as-is.
const _CMD_BRACE = new Set([
  "begin","end",
  "textbf","textit","texttt","textsc","textrm","textsf","emph","underline","footnote","text",
  "section","subsection","subsubsection","paragraph","subparagraph","chapter","part",
  "title","author","date","documentclass","usepackage","input","include",
  "label","caption","includegraphics","url","hspace","vspace",
  "cite","ref","pageref","eqref","autoref","cref","Cref","nameref",
  "bibliography","bibliographystyle","addbibresource",
  "sqrt","mathbb","mathcal","mathbf","hat","tilde","bar","vec","dot","ddot",
  "overline","overbrace","underbrace","widehat","widetilde","bm",
  "newcommand","renewcommand","providecommand","DeclareMathOperator",
]);
const _CMD_TWO_BRACE = new Set(["frac","dfrac","href"]);
// Commands whose {} content has its own autocomplete — after inserting the
// braces, reopen the dropdown so you can pick the env / cite key / ref.
const _CMD_OPEN_HINT = new Set([
  "begin","end","cite","ref","pageref","eqref","autoref","cref","Cref","nameref",
]);

// Insert "\cmd{}" (or "{}{}") replacing the typed token, cursor inside the
// first braces. If an argument brace already follows, just complete the name.
function _insertCmdWithBraces(cm, data, cmd, n) {
  const lineText = cm.getLine(data.from.line) || "";
  const alreadyBraced = lineText[data.to.ch] === "{";
  const text = alreadyBraced ? cmd : cmd + (n === 2 ? "{}{}" : "{}");
  cm.replaceRange(text, data.from, data.to);
  // cursor just inside the first "{"
  cm.setCursor({ line: data.from.line, ch: data.from.ch + cmd.length + 1 });
  cm.focus();
  // Chain: \begin{|} → env list, \cite{|} → bib keys, \ref{|} → labels.
  if (_CMD_OPEN_HINT.has(cmd.slice(1))) {
    setTimeout(() => cm.showHint({ hint: CM.hint.latex, completeSingle: false }), 0);
  }
}

const _LIST_ENVS = new Set(["itemize", "enumerate", "description"]);
// Per-environment skeletons. _CUR () marks where the cursor lands; it is
// stripped on insert. opt = text appended to the \begin{env} line (e.g. [H]).
// body = lines between \begin and \end (each gets the body indent prepended;
// deeper nesting carries explicit leading spaces). Envs with no template fall
// back to a single blank body line.
const _CUR = "@@CURSOR@@";
const _ENV_TEMPLATES = {
  figure: { opt: "[H]", body:
    "\\centering\n" +
    "\\includegraphics[width=0.8\\textwidth]{" + _CUR + "}\n" +
    "\\caption{}\n\\label{fig:}" },
  table: { opt: "[H]", body:
    "\\centering\n\\caption{" + _CUR + "}\n\\label{tab:}\n" +
    "\\begin{tabular}{|c|c|}\n  \\hline\n   &  \\\\\n  \\hline\n\\end{tabular}" },
  itemize:     { body: "\\item " + _CUR },
  enumerate:   { body: "\\item " + _CUR },
  description: { body: "\\item[" + _CUR + "] " },
  equation:    { body: _CUR + "\n\\label{eq:}" },
  align:       { body: _CUR + " &= \n\\label{eq:}" },
};
_ENV_TEMPLATES["figure*"] = _ENV_TEMPLATES.figure;
_ENV_TEMPLATES["table*"]  = _ENV_TEMPLATES.table;
_ENV_TEMPLATES["equation*"] = { body: _CUR };
_ENV_TEMPLATES["align*"]    = { body: _CUR + " &= " };

function _insertEnvBlock(cm, data, env) {
  const lineNo   = data.from.line;
  const lineText = cm.getLine(lineNo) || "";
  const beginStart = Math.max(0, data.from.ch - "\\begin{".length);  // back over "\begin{"
  let closeCh = data.to.ch;
  if (lineText[closeCh] === "}") closeCh++;            // consume the auto-closed "}"
  const indent = (lineText.match(/^[ \t]*/) || [""])[0];
  const unit   = cm.getOption("indentWithTabs") ? "\t" : " ".repeat(cm.getOption("indentUnit") || 2);
  const inner  = indent + unit;

  const tpl = _ENV_TEMPLATES[env];
  const opt = tpl && tpl.opt ? tpl.opt : "";
  let bodyRaw;
  if (tpl)                       bodyRaw = tpl.body;
  else if (_LIST_ENVS.has(env))  bodyRaw = "\\item " + _CUR;
  else                           bodyRaw = _CUR;            // blank body line
  const bodyLines = bodyRaw.split("\n").map(l => inner + l);

  let block = "\\begin{" + env + "}" + opt + "\n" + bodyLines.join("\n") +
              "\n" + indent + "\\end{" + env + "}";

  // Resolve the cursor marker → {line, ch}; strip it. Fall back to the first
  // body line if (somehow) absent.
  let curLine = lineNo + 1, curCh = inner.length;
  const idx = block.indexOf(_CUR);
  if (idx >= 0) {
    const before = block.slice(0, idx);
    const nl = (before.match(/\n/g) || []).length;
    curLine = lineNo + nl;
    curCh   = (nl === 0 ? beginStart : 0) + (idx - before.lastIndexOf("\n") - 1);
    block   = block.slice(0, idx) + block.slice(idx + _CUR.length);
  }

  cm.replaceRange(block, { line: lineNo, ch: beginStart }, { line: lineNo, ch: closeCh });
  cm.setCursor({ line: curLine, ch: curCh });
  cm.focus();
}

const LATEX_COMMANDS = [
  // document structure
  "\\documentclass","\\usepackage","\\begin","\\end","\\input","\\include",
  "\\title","\\author","\\date","\\maketitle","\\tableofcontents",
  "\\section","\\subsection","\\subsubsection","\\paragraph","\\subparagraph",
  "\\chapter","\\part","\\appendix","\\bibliography","\\bibliographystyle",
  "\\addbibresource","\\printbibliography","\\cite","\\ref","\\label","\\pageref",
  // text formatting
  "\\textbf","\\textit","\\texttt","\\textsc","\\textrm","\\textsf",
  "\\emph","\\underline","\\footnote","\\text",
  // math
  "\\frac","\\sqrt","\\sum","\\prod","\\int","\\oint","\\lim","\\infty",
  "\\alpha","\\beta","\\gamma","\\delta","\\epsilon","\\varepsilon",
  "\\zeta","\\eta","\\theta","\\vartheta","\\iota","\\kappa","\\lambda",
  "\\mu","\\nu","\\xi","\\pi","\\varpi","\\rho","\\varrho",
  "\\sigma","\\varsigma","\\tau","\\upsilon","\\phi","\\varphi","\\chi",
  "\\psi","\\omega","\\Gamma","\\Delta","\\Theta","\\Lambda","\\Xi",
  "\\Pi","\\Sigma","\\Upsilon","\\Phi","\\Psi","\\Omega",
  "\\forall","\\exists","\\nabla","\\partial","\\hbar","\\ell","\\Re","\\Im",
  "\\leq","\\geq","\\neq","\\approx","\\equiv","\\sim","\\simeq",
  "\\subset","\\supset","\\subseteq","\\supseteq","\\in","\\notin",
  "\\cup","\\cap","\\setminus","\\emptyset","\\mathbb","\\mathcal","\\mathbf",
  "\\left","\\right","\\big","\\Big","\\bigg","\\Bigg",
  "\\cdot","\\cdots","\\ldots","\\vdots","\\ddots","\\times","\\div","\\pm","\\mp",
  "\\to","\\rightarrow","\\leftarrow","\\Rightarrow","\\Leftarrow",
  "\\Leftrightarrow","\\leftrightarrow","\\mapsto",
  "\\hat","\\tilde","\\bar","\\vec","\\dot","\\ddot","\\overline","\\underline",
  "\\overbrace","\\underbrace","\\widehat","\\widetilde",
  // environments (for \begin{ autocomplete)
  "equation","equation*","align","align*","gather","gather*","multline",
  "itemize","enumerate","description","figure","table","tabular",
  "minipage","center","flushleft","flushright","verbatim","lstlisting",
  "theorem","lemma","proof","definition","remark","corollary","example",
  "abstract","titlepage","document",
  // spacing
  "\\hspace","\\vspace","\\hfill","\\vfill","\\newline","\\newpage","\\clearpage",
  "\\noindent","\\indent","\\quad","\\qquad","\\,","\\;","\\:",
  // misc
  "\\item","\\href","\\url","\\includegraphics","\\caption","\\label",
  "\\multicolumn","\\multirow","\\hline","\\cline","\\toprule","\\midrule","\\bottomrule",
  "\\newcommand","\\renewcommand","\\DeclareMathOperator",
];

// v3.2.2 — context regexes for \cite{ and \ref{ autocomplete.
//   _CITE_CTX matches the typed prefix of the LAST key inside any
//   `\xxxcite[...]{a, b, partia|}` (cite, citep, citet, nocite, textcite,
//   parencite, autocite, footcite, fullcite, etc.).
//   _REF_CTX  matches inside `\ref{`, `\eqref{`, `\autoref{`, `\cref{`,
//   `\Cref{`, `\nameref{`, `\vref{`, etc. — but NOT `\label{` (that's a
//   definition site, not a usage).
const _CITE_CTX = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{(?:[^}]*,\s*)?([^},\s]*)$/i;
const _REF_CTX  = /\\(?:ref|eqref|pageref|autoref|cref|Cref|nameref|vref|vpageref|crefrange|Crefrange|labelcref)\*?\{([^}]*?)$/;

// Custom renderer: bibkey/label in accent colour, dimmed metadata next to it.
// v3.2.3 — Now optionally renders a second row with the paper title when
// `item.title` is present (only set for \cite entries; label hints don't
// have a sensible title to show).
function _renderCiteHint(elt, _data, item) {
  const row1 = document.createElement("div");
  row1.className = "cite-hint-row1";
  const k = document.createElement("span");
  k.className   = "cite-hint-key";
  k.textContent = item.text;
  row1.appendChild(k);
  if (item.meta) {
    const m = document.createElement("span");
    m.className   = "cite-hint-meta";
    m.textContent = item.meta;
    row1.appendChild(m);
  }
  elt.appendChild(row1);
  if (item.title) {
    const t = document.createElement("span");
    t.className   = "cite-hint-title";
    t.textContent = item.title;
    // Native title on hover gives the full untruncated title if it overflows.
    t.title       = item.title;
    elt.appendChild(t);
  }
}

export function _initAutocomplete() {
CM.registerHelper("hint","latex", function(cm) {
  const cur  = cm.getCursor();
  const line = cm.getLine(cur.line);
  const end  = cur.ch;
  const pre  = line.slice(0, end);

  // ── \cite{...} context ───────────────────────────────────────────
  const mCite = _CITE_CTX.exec(pre);
  if (mCite) {
    const typed = mCite[1] || "";
    const tlow  = typed.toLowerCase();
    // v3.2.3 — Match against key OR title so typing "rydberg" surfaces
    // every paper with "Rydberg" in the title, not just those whose key
    // contains "rydberg".
    const list  = bibkeysCache
      .filter(b => !typed
                 || b.key.toLowerCase().includes(tlow)
                 || (b.title || "").toLowerCase().includes(tlow))
      .slice(0, 80)
      .map(b => ({
        text:        b.key,
        displayText: b.key,
        meta:        b.author
                       ? (b.author + (b.year ? ` (${b.year})` : ""))
                       : (b.year ? `(${b.year})` : ""),
        title:       b.title || "",
        render:      _renderCiteHint,
      }));
    if (list.length) {
      return { list,
               from: { line: cur.line, ch: end - typed.length },
               to:   cur };
    }
    // fallthrough to generic command hints if cache empty / no match
  }

  // ── \ref{...} context ────────────────────────────────────────────
  const mRef = _REF_CTX.exec(pre);
  if (mRef) {
    const typed = mRef[1] || "";
    const tlow  = typed.toLowerCase();
    const list  = labelsCache
      .filter(l => !typed || l.name.toLowerCase().includes(tlow))
      .slice(0, 80)
      .map(l => ({
        text:        l.name,
        displayText: l.name,
        meta:        `${l.file}:${l.line}`,
        render:      _renderCiteHint,
      }));
    if (list.length) {
      return { list,
               from: { line: cur.line, ch: end - typed.length },
               to:   cur };
    }
  }

  // ── \begin{...} / \end{...} environment autocomplete ─────────────
  // Detect this BEFORE the \cmd guard below: the typed env name has no leading
  // backslash, so the guard would otherwise return early and block it.
  const buf = _bufferDefs();
  const envMatch = pre.match(/\\(begin|end)\{([^}]*)$/);
  if (envMatch) {
    const which = envMatch[1];          // "begin" or "end"
    const typed = envMatch[2];
    // built-in envs + user-defined (project-wide + current buffer)
    const all  = [...new Set([
      ...LATEX_COMMANDS.filter(c => !c.startsWith("\\")),
      ...userEnvCache, ...buf.envs,
    ])];
    const names = all.filter(c => c.startsWith(typed));
    const from  = { line: cur.line, ch: end - typed.length };
    if (which === "end") {
      return { list: names, from, to: cur };   // \end{ → just complete the name
    }
    // \begin{ → insert the FULL block: \begin{env} … \end{env}
    const list = names.map(env => ({
      text: env,
      displayText: "\\begin{" + env + "}",
      hint: (cm, data) => _insertEnvBlock(cm, data, env),
    }));
    return { list, from, to: cur };
  }

  // ── \cmd autocomplete ────────────────────────────────────────────
  // ดึง token ปัจจุบันย้อนหลัง
  let start = end;
  while (start > 0 && /[\\\w*]/.test(line[start-1])) start--;
  const token = line.slice(start, end);
  if (!token.startsWith("\\") && !pre.match(/\\[a-zA-Z]*$/)) return;

  // suggest commands — built-ins + user-defined macros
  const cmdMatch = pre.match(/\\[a-zA-Z*]*$/);
  if (!cmdMatch) return;
  const typed = cmdMatch[0];
  const all   = [...new Set([
    ...LATEX_COMMANDS.filter(c => c.startsWith("\\")),
    ...userCmdCache, ...buf.cmds,
  ])];
  const from  = { line: cur.line, ch: end - typed.length };
  // Commands that take an argument get {} inserted with the cursor inside;
  // symbols (\alpha, \ldots, …) insert as-is.
  const list  = all.filter(c => c.startsWith(typed)).map(cmd => {
    const name = cmd.slice(1);
    const two  = _CMD_TWO_BRACE.has(name);
    if (!_CMD_BRACE.has(name) && !two) return cmd;  // symbol/no-arg → plain insert
    const n = two ? 2 : 1;
    return { text: cmd, displayText: cmd + (n === 2 ? "{}{}" : "{}"),
             hint: (cm, data) => _insertCmdWithBraces(cm, data, cmd, n) };
  });
  return { list, from, to: cur };
});

// Trigger autocomplete on backslash, on letters within \cmd, AND on `{` /
// letters inside \cite{...} or \ref{...} so the dropdown shows up the
// moment the user opens the brace or starts typing a key.
CM.on("keyup", (cm, e) => {
  if (!e.key) return;
  const cur = cm.getCursor();
  const pre = cm.getLine(cur.line).slice(0, cur.ch);
  const inCiteOrRef = _CITE_CTX.test(pre) || _REF_CTX.test(pre);
  // v4.4.0 — also pop the dropdown while typing the env name in \begin{…}/\end{…}
  const inEnv = /\\(?:begin|end)\{[^}]*$/.test(pre);

  // `{` is special: it TRANSITIONS context from \cmd → \cite{ / \ref{ / \begin{,
  // so we must force a fresh dropdown even if a stale completion is still
  // active. showHint replaces the active dropdown internally.
  if (e.key === "{" && (inCiteOrRef || inEnv)) {
    cm.showHint({ hint: CM.hint.latex, completeSingle: false });
    return;
  }

  if (cm.state.completionActive) return;

  // Inside a cite/ref/env brace — fire on any printable key (incl. comma for
  // multi-key `\cite{a, b, c|}`) or Backspace to refresh the filter.
  if ((inCiteOrRef || inEnv) && (e.key.length === 1 || e.key === "Backspace")) {
    cm.showHint({ hint: CM.hint.latex, completeSingle: false });
    return;
  }

  // \cmd context (existing behaviour)
  if (e.key === "\\" || (e.key.length === 1 && pre.match(/\\[a-zA-Z]{1,}$/))) {
    cm.showHint({ hint: CM.hint.latex, completeSingle: false });
  }
});

// ── PROSE WORD SUGGESTIONS (v4.4.0) ───────────────────────────
// One typing-time dropdown over plain prose that does two jobs:
//   1. AUTOCOMPLETE — as you type a word prefix, offer longer words that begin
//      with it, drawn from (a) words already in this document (domain terms
//      like "Rydberg", "polyglossia") and (b) the en_US dictionary. Tab OR
//      Enter inserts the highlighted word.
//   2. CORRECT — when there's nothing to complete AND the typed word is a
//      complete misspelling (e.g. "recieve"), fall back to spelling fixes (the
//      typing-time twin of the right-click "Replace with" menu).
// Both reuse the same dictionary the wavy-underline pass loads, and the same
// skip-mask, so the dropdown never fires inside \commands, math, comments, or
// citation braces. Gated on the "Word suggestions" toggle (spellSuggestEnabled).

// Walk back over letters/apostrophes to find the word ending at the cursor.
function _proseWordAt(cm, cur) {
  const line = cm.getLine(cur.line) || "";
  let start = cur.ch;
  while (start > 0 && /[A-Za-z']/.test(line[start - 1])) start--;
  return { word: line.slice(start, cur.ch), start, end: cur.ch, line };
}

// Sorted, lower-cased, de-duped dictionary word list — built once (lazily) from
// Typo's internal table so we can prefix-search by binary lower-bound. ~150k
// entries incl. inflections; the one-time filter+sort (~150ms) happens on the
// first completion, then it's cached for the session.
let _dictWords = null;
function _dictWordList() {
  if (_dictWords) return _dictWords;
  const table = spellChecker && spellChecker.dictionaryTable;
  if (!table) return null;
  const seen = new Set();
  for (const w of Object.keys(table)) {
    if (!/^[A-Za-z][A-Za-z']*$/.test(w)) continue;   // skip "0th", numbers, symbol-laced
    seen.add(w.toLowerCase());
  }
  _dictWords = Array.from(seen).sort();
  return _dictWords;
}

// Lower-bound binary search → contiguous run of words starting with `prefix`,
// strictly longer than it (a completion must add something). Sorted input.
function _dictPrefix(prefix, limit) {
  const words = _dictWordList();
  if (!words) return [];
  let lo = 0, hi = words.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (words[mid] < prefix) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let i = lo; i < words.length && out.length < limit; i++) {
    if (!words[i].startsWith(prefix)) break;
    if (words[i].length > prefix.length) out.push(words[i]);
  }
  return out;
}

// Document words, cached and rebuilt only when the buffer actually changes
// (cm.changeGeneration() bumps on every edit). Preserves original casing so
// "Rydberg" completes capitalised. Capped so a huge thesis file stays cheap.
let _docWordCache = { gen: null, words: [] };
function _docWords() {
  const gen = CM.changeGeneration();
  if (gen !== _docWordCache.gen) {
    const seen = new Map();   // lower → original (first-seen wins)
    const re = /[A-Za-z][A-Za-z']{1,}/g;
    const text = CM.getValue();
    let m;
    while ((m = re.exec(text))) {
      const lw = m[0].toLowerCase();
      if (!seen.has(lw)) seen.set(lw, m[0]);
      if (seen.size > 6000) break;
    }
    _docWordCache = { gen, words: Array.from(seen.values()) };
  }
  return _docWordCache.words;
}

CM.registerHelper("hint", "proseword", function(cm) {
  if (!spellSuggestEnabled || !spellChecker) return;
  const cur = cm.getCursor();
  const { word, start, end, line } = _proseWordAt(cm, cur);
  if (word.length < 2) return;                              // too short → noisy
  if (/'(?:s|t|re|ve|ll|d|m)$/i.test(word)) return;         // contraction/possessive
  // Don't fire inside math / comments / \command regions / citation braces.
  const mask = _buildSkipMask(line);
  for (let j = start; j < end; j++) if (mask[j]) return;

  const lw = word.toLowerCase();
  const upperFirst = /^[A-Z]/.test(word);
  const seen = new Set([lw]);
  const out = [];
  const cap = 9;

  // 1) AUTOCOMPLETE — document words first (most relevant), then dictionary.
  for (const dw of _docWords()) {
    if (out.length >= cap) break;
    const dlw = dw.toLowerCase();
    if (dlw.length > lw.length && dlw.startsWith(lw) && !seen.has(dlw)) {
      seen.add(dlw); out.push(dw);
    }
  }
  for (const m of _dictPrefix(lw, cap)) {
    if (out.length >= cap) break;
    if (!seen.has(m)) { seen.add(m); out.push(upperFirst ? m.charAt(0).toUpperCase() + m.slice(1) : m); }
  }

  // 2) CORRECT — only when there's nothing to complete AND the whole word is a
  //    misspelling (e.g. "recieve"): offer spelling fixes instead.
  if (!out.length) {
    if (word.length < 3) return;
    if (word.length <= 5 && word === word.toUpperCase()) return;   // acronym
    if (customDict.has(lw)) return;
    if (spellChecker.check(word)) return;                          // correct & complete → nothing to add
    let suggestions;
    if (_suggestCache.has(lw)) suggestions = _suggestCache.get(lw);
    else {
      try { suggestions = spellChecker.suggest(word, 7) || []; } catch (_) { suggestions = []; }
      _suggestCache.set(lw, suggestions);
    }
    // Drop the input echo and Typo.js's occasional digit-laced junk ("vegab02nd").
    suggestions = (suggestions || []).filter(s => s && s.toLowerCase() !== lw && !/\d/.test(s));
    for (const s of suggestions) {
      if (out.length >= cap) break;
      if (!seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
    }
  }

  if (!out.length) return;
  return {
    list: out.map(s => ({ text: s, displayText: s })),
    from: { line: cur.line, ch: start },
    to:   { line: cur.line, ch: end },
  };
});

// Tab (and the default Enter) insert the highlighted word. extraKeys here bind
// ONLY while the dropdown is open, so the editor's normal Tab (snippet expand /
// indent) is untouched whenever the dropdown isn't showing.
const _PROSE_HINT_OPTS = {
  hint: CM.hint.proseword,
  completeSingle: false,
  extraKeys: { Tab: (cm, h) => h.pick() },
};

// Trigger. Separate keyup listener so it can't perturb the LaTeX-autocomplete
// logic above. Lightly debounced.
CM.on("keyup", (cm, e) => {
  if (!spellSuggestEnabled) return;
  if (!e.key || cm.state.completionActive) return;   // a dropdown is already up
  // React only to prose typing / corrective backspace — not arrows, modifiers,
  // Enter, etc. (those would re-pop the menu the user just dismissed).
  const typing = (e.key.length === 1 && /[A-Za-z']/.test(e.key)) || e.key === "Backspace";
  if (!typing) return;
  const cur = cm.getCursor();
  const pre = cm.getLine(cur.line).slice(0, cur.ch);
  // Never compete with the LaTeX/cite/ref dropdowns — those own these contexts.
  if (_CITE_CTX.test(pre) || _REF_CTX.test(pre) || /\\[a-zA-Z]*$/.test(pre)) return;
  // Lazy-load the dictionary on first prose typing — no upfront 1.7MB for users
  // who only read or only write \commands. The load takes ~1-2s, by which time
  // the user has usually stopped typing, so we must re-fire the hint when it
  // resolves — otherwise the very FIRST word never gets a dropdown.
  if (!spellChecker) {
    _ensureSpellDict().then(d => {
      if (!d || !spellSuggestEnabled) return;
      _runSpellCheck();   // underline the wrong words now that the dict is here
      if (!cm.state.completionActive) cm.showHint(_PROSE_HINT_OPTS);
    });
    return;
  }
  clearTimeout(_spellHintTimer);
  const _sht = setTimeout(() => {
    if (cm.state.completionActive) return;
    // showHint quietly does nothing if the helper returns no list.
    cm.showHint(_PROSE_HINT_OPTS);
  }, 250);
  _ssSpellHintTimer(_sht);
});


}