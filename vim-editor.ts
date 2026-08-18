/**
 * vim-editor.ts — VimEditor: the modal vim editor shell for Pi.
 *
 * Architecture:
 * - Extends CustomEditor (keeps app-level keybindings: Esc abort, Ctrl+D, model switching).
 * - Insert mode delegates to the base editor (autocomplete, paste, external editor).
 * - Normal/Visual modes are handled by modes/normal.ts and modes/visual.ts.
 * - Cursor positioning and text rewrites touch the base editor's internal state
 *   (same approach as pi-vim/burneikis: arrow-key emulation is wrong when lines wrap).
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI, EditorOptions, EditorTheme } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { createInitialState, MODE_LABELS, resetPending, type VimMode, type VimState } from "./state.ts";
import { computeWrapRows, highlightRenderedLine, resolveSelectionStyle } from "./highlight.ts";
import { handleNormalMode, type NormalModeContext } from "./modes/normal.ts";
import { handleVisualMode, type VisualModeContext } from "./modes/visual.ts";

export interface VimEditorOptions {
  startMode?: VimMode;
  /** True while the agent is running (Ctrl+C then means "interrupt", not "normal mode"). */
  isAgentBusy?: () => boolean;
  /** Called on every mode transition. */
  onModeChange?: (mode: VimMode, prevMode: VimMode) => void;
  /** Called with the current mode (null when the editor is detached). */
  statusFn?: (mode: VimMode | null) => void;
  /**
   * Optional render decorators, applied by the mounting extension:
   * - `beforeRender`: runs before the base editor renders (Pi resets
   *   `editor.borderColor` on every frame, so border tinting must happen
   *   before rendering, not after).
   * - `afterRender`: receives the rendered lines and may return modified ones.
   */
  renderHook?: {
    beforeRender?: (editor: VimEditor) => void;
    afterRender?: (lines: string[], width: number, editor: VimEditor) => string[];
  };
  /**
   * Visual-selection highlight style (always a background color).
   * - undefined / "theme": resolve Pi's `selectedBg` theme color (auto-adapts
   *   to light/dark theme)
   * - a `#rrggbb` hex or a 0-255 ANSI index: a fixed background color
   */
  selectionColor?: string;
  /** Resolver for theme colors, used by `selectionColor: "theme"`. */
  themeColor?: (name: string) => string | undefined;
}

interface EditorInternals {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  lastAction: unknown;
  preferredVisualCol?: number | null;
  /** Render scroll offset (rows scrolled off the top), kept by the base renderer. */
  scrollOffset?: number;
  setCursorCol?: (col: number) => void;
  pastes?: Map<number, string>;
  pasteCounter?: number;
  undoStack?: unknown[];
  undo?: () => void;
  isInPaste?: boolean;
  onChange?: (text: string) => void;
}

export class VimEditor extends CustomEditor {
  readonly vimState: VimState;
  private options: VimEditorOptions;
  private redoStack: Array<{ lines: string[]; cursorLine: number; cursorCol: number }> = [];
  private jjTimer: ReturnType<typeof setTimeout> | null = null;
  private selectionStyle: { start: string; end: string };

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    options: VimEditorOptions = {},
    editorOptions?: EditorOptions,
  ) {
    super(tui, theme, keybindings, editorOptions);
    this.options = options;
    this.selectionStyle = resolveSelectionStyle(options.selectionColor, options.themeColor);
    this.vimState = createInitialState(options.startMode ?? "insert");
    this.applyCursorShapeForMode(this.vimState.mode);
    this.options.statusFn?.(this.vimState.mode);
  }

  // ------------------------------------------------------------------
  // Public API for other extensions
  // ------------------------------------------------------------------

  /** Current vim mode: "insert" | "normal" | "visual" | "visual-line". */
  getMode(): VimMode {
    return this.vimState.mode;
  }

  // ------------------------------------------------------------------
  // Internal state access (documented private-surface usage, see README)
  // ------------------------------------------------------------------

  private internals(): EditorInternals {
    return this as unknown as EditorInternals;
  }

  /** Move cursor to an absolute logical position by writing editor state directly. */
  moveCursorTo(targetLine: number, targetCol: number): void {
    const editor = this.internals();
    const lines = editor.state?.lines ?? [""];
    const line = Math.max(0, Math.min(targetLine, lines.length - 1));
    const col = Math.max(0, Math.min(targetCol, (lines[line] ?? "").length));
    editor.lastAction = null;
    editor.state.cursorLine = line;
    if (typeof editor.setCursorCol === "function") {
      editor.setCursorCol(col);
    } else {
      editor.state.cursorCol = col;
      editor.preferredVisualCol = null;
    }
  }

  /**
   * setText override: preserve Pi's `[paste #N]` registry. Pi's setText clears
   * the paste registry (it assumes programmatic replacement discards markers);
   * vim rewrites the buffer for almost every edit, so without this the literal
   * marker text would be submitted instead of the pasted content.
   */
  override setText(text: string): void {
    const editor = this.internals();
    const saved: Map<number, string> | undefined =
      editor.pastes instanceof Map && editor.pastes.size > 0 ? new Map(editor.pastes) : undefined;
    const savedCounter = typeof editor.pasteCounter === "number" ? editor.pasteCounter : undefined;

    super.setText(text);

    if (!saved || !(editor.pastes instanceof Map)) return;
    const newText = this.getText();
    for (const [id, content] of saved) {
      if (editor.pastes.has(id)) continue;
      if (new RegExp(`\\[paste #${id}( (\\+\\d+ lines|\\d+ chars))?\\]`).test(newText)) {
        editor.pastes.set(id, content);
      }
    }
    if (savedCounter !== undefined && (editor.pasteCounter ?? 0) < savedCounter) {
      editor.pasteCounter = savedCounter;
    }
  }

  // ------------------------------------------------------------------
  // Undo / redo
  // ------------------------------------------------------------------

  /** `u` — delegate to Pi's native undo, keeping a mirror for redo. */
  vimUndo(): void {
    const editor = this.internals();
    if (!editor.undoStack || editor.undoStack.length === 0) return;
    this.redoStack.push(structuredClone(editor.state));
    editor.undo?.();
  }

  /** `<C-r>` — redo from the mirror stack. */
  vimRedo(): void {
    if (this.redoStack.length === 0) return;
    const editor = this.internals();
    const snapshot = this.redoStack.pop()!;
    editor.undoStack?.push(structuredClone(editor.state));
    Object.assign(editor.state, snapshot);
    editor.lastAction = null;
    editor.preferredVisualCol = null;
    if (editor.onChange) editor.onChange(this.getText());
  }

  // ------------------------------------------------------------------
  // Submit / EX command bridge
  // ------------------------------------------------------------------

  /** Submit the current prompt through Pi's full submit path (clears the editor). */
  submitPrompt(): void {
    if (this.disableSubmit) return;
    const editor = this.internals() as EditorInternals & { submitValue?: () => void };
    if (typeof editor.submitValue === "function") {
      // Pi's submitValue clears the buffer, paste registry and undo stack,
      // then calls onChange("") and onSubmit(trimmed).
      editor.submitValue();
    } else {
      const text = this.getText();
      this.onSubmit?.(text);
    }
    // Back to the configured start mode for the next prompt.
    const startMode = this.options.startMode ?? "insert";
    if (this.vimState.mode !== startMode) {
      this.setMode(startMode);
    }
  }

  // ------------------------------------------------------------------
  // Input routing
  // ------------------------------------------------------------------

  override handleInput(data: string): void {
    // Bracketed paste: the base editor buffers paste chunks itself and turns
    // large pastes into [paste #N] markers. Every chunk must reach the base
    // editor — if a vim mode handler sees a chunk, the payload gets interpreted
    // as vim commands and the paste is lost.
    if (this.internals().isInPaste || data.includes("\x1b[200~")) {
      super.handleInput(data);
      return;
    }

    // Ctrl+Enter: submit from ANY mode.
    if (matchesKey(data, "ctrl+enter")) {
      resetPending(this.vimState);
      this.submitPrompt();
      return;
    }

    // Ctrl+C: interrupt while the agent is busy; otherwise vim semantics.
    if (matchesKey(data, "ctrl+c") && this.options.isAgentBusy?.()) {
      super.handleInput(data);
      return;
    }

    const { vimState } = this;
    const modeBefore = vimState.mode;
    const textBefore = this.getText();
    const redoLenBefore = this.redoStack.length;

    switch (vimState.mode) {
        case "insert":
          this.handleInsert(data);
          break;
        case "normal":
          this.handleNormal(data);
          break;
        case "visual":
        case "visual-line":
          this.handleVisual(data);
          break;
        default:
          super.handleInput(data);
          break;
    }

    // A non-undo/redo action that changed the text invalidates the redo stack.
    if (this.redoStack.length === redoLenBefore && this.getText() !== textBefore) {
      this.redoStack.length = 0;
    }

    if (vimState.mode !== modeBefore) {
      this.applyCursorShapeForMode(vimState.mode);
      this.options.onModeChange?.(vimState.mode, modeBefore);
      this.options.statusFn?.(vimState.mode);
    }
  }

  private setMode(mode: VimMode): void {
    const prev = this.vimState.mode;
    if (prev === mode) return;
    this.vimState.mode = mode;
    this.applyCursorShapeForMode(mode);
    this.options.onModeChange?.(mode, prev);
    this.options.statusFn?.(mode);
  }

  // --- Insert ---

  private handleInsert(data: string): void {
    // Escape: close autocomplete first; otherwise enter normal mode.
    if (matchesKey(data, "escape")) {
      if (this.isShowingAutocomplete?.()) {
        super.handleInput(data);
        return;
      }
      this.setMode("normal");
      return;
    }
    // Ctrl+C: enter normal mode (when idle — busy is handled in handleInput).
    if (matchesKey(data, "ctrl+c")) {
      this.setMode("normal");
      return;
    }
    // Enter: submit (Pi-native).
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      super.handleInput(data);
      return;
    }
    // jj: escape alias with a short buffer window.
    if (data === "j") {
      if (this.vimState.jjPending) {
        this.vimState.jjPending = false;
        if (this.jjTimer) {
          clearTimeout(this.jjTimer);
          this.jjTimer = null;
        }
        this.setMode("normal");
        return;
      }
      this.vimState.jjPending = true;
      this.jjTimer = setTimeout(() => {
        this.jjTimer = null;
        if (this.vimState.jjPending) {
          this.vimState.jjPending = false;
          super.handleInput("j");
          this.tui.requestRender?.();
        }
      }, 250);
      return;
    }
    if (this.vimState.jjPending) {
      this.vimState.jjPending = false;
      if (this.jjTimer) {
        clearTimeout(this.jjTimer);
        this.jjTimer = null;
      }
      super.handleInput("j");
    }
    // Everything else (including Tab, autocomplete, paste, external editor).
    super.handleInput(data);
  }

  // --- Normal / Visual ---

  private handleNormal(data: string): void {
    const ctx: NormalModeContext = {
      state: this.vimState,
      getText: () => this.getText(),
      getCursor: () => this.getCursor(),
      setText: (text) => this.setText(text),
      moveCursorTo: (line, col) => this.moveCursorTo(line, col),
      undo: () => this.vimUndo(),
      redo: () => this.vimRedo(),
      submit: () => this.submitPrompt(),
      setMode: (mode) => this.setMode(mode),
      superHandleInput: (d) => super.handleInput(d),
    };
    handleNormalMode(data, ctx);
  }

  private handleVisual(data: string): void {
    const ctx: VisualModeContext = {
      state: this.vimState,
      getText: () => this.getText(),
      getCursor: () => this.getCursor(),
      setText: (text) => this.setText(text),
      moveCursorTo: (line, col) => this.moveCursorTo(line, col),
      submit: () => this.submitPrompt(),
      setMode: (mode) => this.setMode(mode),
    };
    handleVisualMode(data, ctx);
  }

  // ------------------------------------------------------------------
  // Cursor shape (DECSCUSR)
  // ------------------------------------------------------------------

  private applyCursorShapeForMode(mode: VimMode): void {
    const isInsert = mode === "insert";
    // Insert uses the terminal hardware bar cursor (Pi's software reverse-video
    // cursor is stripped). Normal and visual keep Pi's software reverse-video
    // cursor so the caret looks identical across modes; visual-mode deletes the
    // strip so the reverse-video caret is visible over the background-tinted
    // selection.
    const seq = isInsert ? "\x1b[6 q" : "\x1b[2 q"; // bar / block
    try {
      this.tui.setShowHardwareCursor?.(isInsert);
    } catch {
      // Older pi-tui without the hardware-cursor toggle.
    }
    try {
      this.tui.terminal?.write?.(seq);
    } catch {
      // Terminals that don't support DECSCUSR.
    }
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  override render(width: number): string[] {
    // Border tinting must run BEFORE the base render: Pi re-assigns
    // editor.borderColor (thinking level / bash mode) on every frame.
    this.options.renderHook?.beforeRender?.(this);

    let lines = super.render(width);
    if (lines.length === 0) return lines;

    // Insert mode strips the software reverse-video cursor so the terminal
    // hardware bar cursor is visible. Visual modes keep the software
    // reverse-video cursor, which stands out against the background-tinted
    // selection.
    if (this.vimState.mode === "insert") {
      for (let i = 0; i < lines.length; i++) {
        lines[i] = this.stripSoftCursorHighlight(lines[i]!);
      }
    }

    // Visual selection highlighting.
    const isVisual = this.vimState.mode === "visual" || this.vimState.mode === "visual-line";
    if (isVisual && this.vimState.visualAnchor) {
      this.applyVisualHighlight(lines, width);
    }

    const last = lines.length - 1;

    // Mode label + pending state + cursor position.
    const label = this.modeLabel();
    if (visibleWidth(lines[last]!) >= label.length) {
      lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
    }

    // External render decorators (interop protocol) run last.
    if (this.options.renderHook?.afterRender) {
      lines = this.options.renderHook.afterRender(lines, width, this);
    }
    return lines;
  }

  private modeLabel(): string {
    const { vimState: s } = this;
    const mode = MODE_LABELS[s.mode];
    let pending = "";
    if (s.pendingOp) {
      const op = s.pendingOp;
      pending = s.pendingOpCount > 1 ? `${s.pendingOpCount}${op}…` : `${op}…`;
    } else if (s.countStarted) {
      pending = String(s.count);
    } else if (s.pendingChar) {
      pending = `${s.pendingChar}…`;
    } else if (s.pendingG) {
      pending = "g…";
    } else if (s.pendingTextObj) {
      pending = `${s.pendingTextObj}…`;
    }
    const cursor = this.getCursor();
    const parts = [mode, pending, `${cursor.line + 1}:${cursor.col + 1}`].filter(Boolean);
    return ` ${parts.join(" ")} `;
  }

  private stripSoftCursorHighlight(line: string): string {
    const markerIndex = line.indexOf(CURSOR_MARKER);
    if (markerIndex === -1) return line;
    const markerEnd = markerIndex + CURSOR_MARKER.length;
    const before = line.slice(0, markerEnd);
    const after = line.slice(markerEnd);
    // Base editor emits the cursor as \x1b[7m<grapheme>\x1b[0m after the marker.
    const stripped = after.replace(/^\x1b\[7m([\s\S]*?)\x1b\[0m/, "$1");
    return before + stripped;
  }

  /**
   * Apply the selection background to the visual selection range in the
   * rendered output. The rendered output from super.render() is:
   *   [top border, ...content lines (with padding), bottom border, ...autocomplete]
   */
  private applyVisualHighlight(renderedLines: string[], width: number): void {
    const text = this.getText();
    const textLines = text.split("\n");
    const cursor = this.getCursor();
    const anchor = this.vimState.visualAnchor;
    if (!anchor) return;
    const linewise = this.vimState.mode === "visual-line";

    let startLine = anchor.line;
    let endLine = cursor.line;
    let startCol = anchor.col;
    let endCol = cursor.col;
    if (cursor.line < anchor.line || (cursor.line === anchor.line && cursor.col < anchor.col)) {
      startLine = cursor.line;
      endLine = anchor.line;
      startCol = cursor.col;
      endCol = anchor.col;
    }

    // Same geometry as the base renderer: clamped padding, content width, and
    // the wrap width passed to its word-aware wrap.
    const paddingX = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
    const contentWidth = Math.max(1, width - paddingX * 2);
    const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));
    const scrollOffset = this.internals().scrollOffset ?? 0;

    // Wrap rows per text line (mirroring pi-tui's wordWrapLine) and the
    // layout row index where each text line starts. Only lines up to the
    // selection end are needed for the mapping.
    const rowMaps: Array<ReturnType<typeof computeWrapRows>> = [];
    const textLineToRenderedStart: number[] = [];
    let layoutRow = 0;
    for (let i = 0; i <= endLine; i++) {
      rowMaps[i] = computeWrapRows(textLines[i] || "", layoutWidth);
      textLineToRenderedStart[i] = layoutRow;
      layoutRow += rowMaps[i]!.length;
    }

    const cellOf = (line: string, col: number): number => visibleWidth(line.slice(0, col));
    const last = renderedLines.length - 1; // bottom border; autocomplete rows follow it

    for (let textLine = startLine; textLine <= endLine; textLine++) {
      const lineText = textLines[textLine] || "";
      const rows = rowMaps[textLine]!;
      const layoutStart = textLineToRenderedStart[textLine]!;
      const lineCells = rows[rows.length - 1]!.endCell;

      // Selection bounds in absolute cells of this line.
      const selStartCell = linewise ? 0 : textLine === startLine ? cellOf(lineText, startCol) : 0;
      const selEndCell = linewise
        ? lineCells
        : textLine === endLine
          ? cellOf(lineText, endCol + 1)
          : lineCells;
      if (selStartCell >= selEndCell) continue;

      for (let r = 0; r < rows.length; r++) {
        const row = rows[r]!;
        const rIdx = 1 + layoutStart + r - scrollOffset;
        if (rIdx < 1 || rIdx >= last) continue;
        const hlStart = Math.max(selStartCell, row.startCell) - row.startCell;
        const hlEnd = Math.min(selEndCell, row.endCell) - row.startCell;
        if (hlStart >= hlEnd) continue;
        renderedLines[rIdx] = highlightRenderedLine(
          renderedLines[rIdx]!,
          paddingX + hlStart,
          paddingX + hlEnd,
          this.selectionStyle.start,
          this.selectionStyle.end,
        );
      }
    }
  }
}
