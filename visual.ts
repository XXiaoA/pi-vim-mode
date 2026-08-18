/**
 * visual.ts — Visual / Visual-line mode key handling.
 */
import { matchesKey } from "@earendil-works/pi-tui";
import type { Pos, VimMode, VimState } from "./state.ts";
import { resetPending } from "./state.ts";
import {
  charLeft,
  charRight,
  firstNonBlank,
  findCharBackward,
  findCharForward,
  goToLine,
  lineDown,
  lineEnd,
  lineStart,
  lineUp,
  matchingBracket,
  repeatFind,
  tillCharBackward,
  tillCharForward,
  wordBackward,
  wordEnd,
  wordForward,
  WORDBackward,
  WORDEnd,
  WORDForward,
  type MotionResult,
} from "./motions.ts";
import {
  applyOperator,
  extractText,
  indentRange,
  dedentRange,
  caseRange,
  type OperatorRange,
} from "./operators.ts";

export interface VisualModeContext {
  state: VimState;
  getText: () => string;
  getCursor: () => Pos;
  setText: (text: string) => void;
  moveCursorTo: (line: number, col: number) => void;
  submit: () => void;
  setMode: (mode: VimMode) => void;
}

/** Normalize the selection to a canonical operator range. */
function selectionRange(state: VimState, cursor: Pos, lines: string[]): OperatorRange {
  const anchor = state.visualAnchor!;
  const linewise = state.mode === "visual-line";
  let start = anchor;
  let end = cursor;
  if (cursor.line < anchor.line || (cursor.line === anchor.line && cursor.col < anchor.col)) {
    start = cursor;
    end = anchor;
  }
  if (linewise) {
    return {
      start: { line: start.line, col: 0 },
      end: { line: end.line, col: (lines[end.line] || "").length },
      linewise: true,
      inclusive: true,
    };
  }
  return { start, end, linewise: false, inclusive: true };
}

/** Leave visual mode, saving the selection for gv. */
function exitVisual(ctx: VisualModeContext): void {
  const { state } = ctx;
  if (state.visualAnchor) {
    state.lastVisual = {
      mode: state.mode === "visual-line" ? "visual-line" : "visual",
      anchor: { ...state.visualAnchor },
      cursor: ctx.getCursor(),
    };
  }
  state.visualAnchor = null;
  resetPending(state);
  ctx.setMode("normal");
}

/** Apply an operator to the selection, then exit visual. */
function applySelection(
  ctx: VisualModeContext,
  operator: string,
  enterInsert = false,
): void {
  const { state } = ctx;
  if (!state.visualAnchor) return;
  const lines = ctx.getText().split("\n");
  const cursor = ctx.getCursor();
  const range = selectionRange(state, cursor, lines);

  if (operator === "gu" || operator === "gU" || operator === "g~") {
    const kind = operator === "gu" ? "lower" : operator === "gU" ? "upper" : "toggle";
    const result = caseRange(lines, range, kind);
    if (result) {
      ctx.setText(result.newLines.join("\n"));
      ctx.moveCursorTo(result.cursor.line, result.cursor.col);
    }
  } else {
    const result = applyOperator(operator, lines, range);
    ctx.setText(result.newLines.join("\n"));
    ctx.moveCursorTo(result.cursor.line, result.cursor.col);
    if (result.yanked) state.reg = result.yanked;
  }

  exitVisual(ctx);
  if (enterInsert) ctx.setMode("insert");
}

/** Delete every touched line (D/X) or yank every touched line (Y). */
function applyTouchedLines(ctx: VisualModeContext, op: "d" | "y" | "c"): void {
  const { state } = ctx;
  if (!state.visualAnchor) return;
  const lines = ctx.getText().split("\n");
  const cursor = ctx.getCursor();
  const anchor = state.visualAnchor;
  const startLine = Math.min(anchor.line, cursor.line);
  const endLine = Math.max(anchor.line, cursor.line);
  const range: OperatorRange = {
    start: { line: startLine, col: 0 },
    end: { line: endLine, col: (lines[endLine] || "").length },
    linewise: true,
    inclusive: true,
  };
  const result = applyOperator(op, lines, range);
  ctx.setText(result.newLines.join("\n"));
  ctx.moveCursorTo(result.cursor.line, result.cursor.col);
  if (result.yanked) state.reg = result.yanked;
  exitVisual(ctx);
  if (op === "c") ctx.setMode("insert");
}

export function handleVisualMode(data: string, ctx: VisualModeContext): void {
  const { state } = ctx;
  const lines = ctx.getText().split("\n");
  const cursor = ctx.getCursor();

  // --- Escape / Ctrl-C: cancel selection. ---
  if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
    exitVisual(ctx);
    return;
  }

  // --- Enter: submit. ---
  if (matchesKey(data, "enter") || matchesKey(data, "return")) {
    exitVisual(ctx);
    ctx.submit();
    return;
  }

  // --- Pending replace/char-find input (after r / f / F / t / T). ---
  if (state.pendingChar) {
    const pc = state.pendingChar;
    state.pendingChar = null;
    const count = state.count || 1;
    state.count = 0;
    state.countStarted = false;

    if (pc === "r") {
      if (state.visualAnchor) {
        const range = selectionRange(state, ctx.getCursor(), lines);
        const text = extractText(lines, range);
        if (text.length > 0) {
          const newLines = [...lines];
          const replaced = text.replace(/[^\n]/g, data);
          if (range.linewise) {
            const parts = replaced.split("\n");
            for (let i = 0; i < parts.length; i++) {
              const li = range.start.line + i;
              if (li < newLines.length) newLines[li] = parts[i]!;
            }
          } else if (range.start.line === range.end.line) {
            const line = newLines[range.start.line] || "";
            newLines[range.start.line] =
              line.substring(0, range.start.col) + replaced + line.substring(range.end.col + 1);
          } else {
            const first = newLines[range.start.line] || "";
            const last = newLines[range.end.line] || "";
            const parts = replaced.split("\n");
            newLines[range.start.line] = first.substring(0, range.start.col) + (parts[0] || "");
            for (let i = 1; i < parts.length - 1; i++) {
              const li = range.start.line + i;
              if (li < newLines.length) newLines[li] = parts[i] || "";
            }
            newLines[range.end.line] = (parts[parts.length - 1] || "") + last.substring(range.end.col + 1);
          }
          ctx.setText(newLines.join("\n"));
          ctx.moveCursorTo(range.start.line, range.start.col);
        }
      }
      exitVisual(ctx);
      return;
    }

    // f/F/t/T — extend the selection to the found character.
    let motion: MotionResult | null = null;
    if (pc === "f") motion = findCharForward(data)(lines, cursor, count);
    else if (pc === "F") motion = findCharBackward(data)(lines, cursor, count);
    else if (pc === "t") motion = tillCharForward(data)(lines, cursor, count);
    else motion = tillCharBackward(data)(lines, cursor, count);
    if (motion) {
      state.lastFind = {
        char: data,
        forward: pc === "f" || pc === "t",
        inclusive: pc === "f" || pc === "F",
      };
      ctx.moveCursorTo(motion.position.line, motion.position.col);
    }
    return;
  }

  // --- Digits: count for motions. ---
  if (data >= "0" && data <= "9") {
    state.count = state.count * 10 + (data.charCodeAt(0) - 48);
    state.countStarted = true;
    return;
  }

  const mCount = state.count || 1;
  state.count = 0;
  state.countStarted = false;

  // --- Motions extend the selection. ---
  const move = (motion: MotionResult): void => {
    ctx.moveCursorTo(motion.position.line, motion.position.col);
  };

  switch (data) {
    case "h":
      move(charLeft(lines, cursor, mCount));
      return;
    case "j":
      move(lineDown(lines, cursor, mCount));
      return;
    case "k":
      move(lineUp(lines, cursor, mCount));
      return;
    case "l":
      move(charRight(lines, cursor, mCount));
      return;
    case "w":
      move(wordForward(lines, cursor, mCount));
      return;
    case "W":
      move(WORDForward(lines, cursor, mCount));
      return;
    case "b":
      move(wordBackward(lines, cursor, mCount));
      return;
    case "B":
      move(WORDBackward(lines, cursor, mCount));
      return;
    case "e":
      move(wordEnd(lines, cursor, mCount));
      return;
    case "E":
      move(WORDEnd(lines, cursor, mCount));
      return;
    case "0":
      move(lineStart(lines, cursor, 1));
      return;
    case "$":
      move(lineEnd(lines, cursor, mCount));
      return;
    case "^":
    case "_":
      move(firstNonBlank(lines, cursor, 1));
      return;
    case "g":
      move(goToLine(lines, cursor, mCount));
      return;
    case "G":
      move(goToLine(lines, cursor, lines.length));
      return;
    case "%":
      move(matchingBracket(lines, cursor, 1));
      return;
    case "f":
    case "F":
    case "t":
    case "T": {
      state.pendingChar = data as "f" | "F" | "t" | "T";
      return;
    }
    case ";": {
      const fn = repeatFind(state.lastFind, false);
      if (fn) move(fn(lines, cursor, mCount)!);
      return;
    }
    case ",": {
      const fn = repeatFind(state.lastFind, true);
      if (fn) move(fn(lines, cursor, mCount)!);
      return;
    }

    // --- Mode switching ---
    case "o":
    case "O": {
      if (state.visualAnchor) {
        const anchor = state.visualAnchor;
        state.visualAnchor = { ...cursor };
        ctx.moveCursorTo(anchor.line, anchor.col);
      }
      return;
    }
    case "v":
      if (state.mode === "visual-line") {
        state.mode = "visual";
      } else {
        exitVisual(ctx);
      }
      return;
    case "V":
      if (state.mode === "visual") {
        state.mode = "visual-line";
      } else {
        exitVisual(ctx);
      }
      return;

    // --- Edits ---
    case "d":
    case "x":
      applySelection(ctx, "d");
      return;
    case "y":
      applySelection(ctx, "y");
      return;
    case "c":
    case "s":
      // s = c in visual mode (vim semantics: delete selection, enter insert).
      applySelection(ctx, "c", true);
      return;
    case "r":
      state.pendingChar = "r";
      return;
    case "u":
      applySelection(ctx, "gu"); // lowercase
      return;
    case "U":
      applySelection(ctx, "gU");
      return;
    case "~":
      applySelection(ctx, "g~");
      return;
    case ">":
    case "<": {
      if (state.visualAnchor) {
        const range = selectionRange(state, cursor, lines);
        const result = data === ">" ? indentRange(lines, range) : dedentRange(lines, range);
        ctx.setText(result.newLines.join("\n"));
        ctx.moveCursorTo(result.cursor.line, result.cursor.col);
      }
      exitVisual(ctx);
      return;
    }
    case "J": {
      if (state.visualAnchor) {
        const anchor = state.visualAnchor;
        const startLine = Math.min(anchor.line, cursor.line);
        const endLine = Math.max(anchor.line, cursor.line);
        if (endLine > startLine) {
          const parts: string[] = [];
          for (let i = startLine; i <= endLine; i++) parts.push(lines[i] || "");
          const joined =
            parts[0]!.replace(/\s+$/, "") +
            " " +
            parts.slice(1).map((p) => p.replace(/^\s+/, "")).join(" ");
          const newLines = [...lines];
          newLines.splice(startLine, endLine - startLine + 1, joined);
          ctx.setText(newLines.join("\n"));
          ctx.moveCursorTo(startLine, Math.min(cursor.col, Math.max(0, joined.length - 1)));
        }
      }
      exitVisual(ctx);
      return;
    }
    case "p":
    case "P": {
      const reg = state.reg;
      if (reg && state.visualAnchor) {
        const range = selectionRange(state, cursor, lines);
        const newLines = [...lines];
        if (range.linewise || reg.linewise) {
          // Linewise: replace the selected lines with the register lines.
          const pasteLines = reg.linewise ? reg.text.split("\n") : [reg.text];
          newLines.splice(range.start.line, range.end.line - range.start.line + 1, ...pasteLines);
          ctx.setText(newLines.join("\n"));
          const target = Math.min(range.start.line, newLines.length - 1);
          const text = newLines[target] || "";
          const m = text.match(/^\s*/);
          ctx.moveCursorTo(target, m ? m[0].length : 0);
        } else {
          const first = newLines[range.start.line] || "";
          const last = newLines[range.end.line] || "";
          const merged = first.substring(0, range.start.col) + reg.text + last.substring(range.end.col + 1);
          newLines.splice(range.start.line, range.end.line - range.start.line + 1, merged);
          ctx.setText(newLines.join("\n"));
          ctx.moveCursorTo(range.start.line, range.start.col + reg.text.length - 1);
        }
      }
      exitVisual(ctx);
      return;
    }
    case "D":
    case "X":
      applyTouchedLines(ctx, "d");
      return;
    case "Y":
      applyTouchedLines(ctx, "y");
      return;
    case "C":
    case "S":
      applyTouchedLines(ctx, "c");
      return;

    default:
      // Unmapped keys are ignored in visual mode.
      return;
  }
}
