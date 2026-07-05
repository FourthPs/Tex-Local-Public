// TexLocal CM6 vendor bundle — single ESM re-exporting everything the app needs.
export {EditorState, EditorSelection, StateField, StateEffect, Compartment, RangeSet, RangeSetBuilder, Prec, Facet} from "@codemirror/state";
export {EditorView, Decoration, WidgetType, keymap, lineNumbers, highlightActiveLine,
        highlightActiveLineGutter, gutter, GutterMarker, drawSelection, dropCursor,
        rectangularSelection, crosshairCursor, ViewPlugin, hoverTooltip, showTooltip} from "@codemirror/view";
export {defaultKeymap, history, historyKeymap, indentWithTab, undo, redo} from "@codemirror/commands";
export {StreamLanguage, LanguageSupport, syntaxTree, foldGutter, foldCode, foldEffect,
        unfoldCode, foldable, codeFolding, indentUnit, HighlightStyle, syntaxHighlighting,
        bracketMatching, foldService, toggleFold, foldAll, unfoldAll} from "@codemirror/language";
export {stex} from "@codemirror/legacy-modes/mode/stex";
export {autocompletion, completionKeymap, startCompletion, closeBrackets,
        closeBracketsKeymap, acceptCompletion, completionStatus, currentCompletions} from "@codemirror/autocomplete";
export {linter, lintGutter, setDiagnostics, forEachDiagnostic} from "@codemirror/lint";
export {searchKeymap, highlightSelectionMatches, search, openSearchPanel, closeSearchPanel, findNext, findPrevious} from "@codemirror/search";
export {tags} from "@lezer/highlight";
