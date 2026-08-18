/**
 * normal.ts — Normal-mode key handling.
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
import { innerWord, resolveTextObject } from "./text-objects.ts";
import {
  applyOperator,
  deleteRange,
  incrementNumber,
  lineRange,
  motionToRange,
  type OperatorRange,
} from "./operators.ts";

export interface NormalModeContext {
  state: VimState;
  getText: () => string;
  getCursor: () => Pos;
  setText: (text: string) => void;
  moveCursorTo: (line: number, col: number) => void;
  undo: () => void;
  redo: () => void;
  submit: () => void;
  setMode: (mode: VimMode) => void;
  superHandleInput: (data: string) => void;
}

/** Apply a motion; if an operator is pending (or passed explicitly), apply it to the range. */
function executeMotion(
  ctx: NormalModeContext,
  motion: MotionResult | null,
  operator?: string | null,
): void {
  if (!motion) {
    resetPending(ctx.state);
    return;
  }
  const { state } = ctx;
  const pending = operator !== undefined ? operator : state.pendingOp;
  if (pending) {
    const lines = ctx.getText().split("\n");
    const cursor = ctx.getCursor();
    const range = motionToRange(cursor, motion);
    const result = applyOperator(pending, lines, range);
    applyResult(ctx, result.newLines, result.cursor, result.enterInsert, result.yanked);
  } else {
    ctx.moveCursorTo(motion.position.line, motion.position.col);
  }
}

/** Apply an operator result: write buffer, register, cursor, mode. */
function applyResult(
  ctx: NormalModeContext,
  newLines: string[],
  cursor: Pos,
  enterInsert: boolean,
  yanked: { text: string; linewise: boolean } | null,
): void {
  ctx.setText(newLines.join("\n"));
  ctx.moveCursorTo(cursor.line, cursor.col);
  if (yanked) ctx.state.reg = yanked; // vim semantics: y/c/d all write the register
  if (enterInsert) ctx.setMode("insert");
  resetPending(ctx.state);
}

/** Doubled-line operators: dd/cc/yy/>>/<</guu/gUgU/g~g~. */
function applyLinewise(ctx: NormalModeContext, operator: string, count: number): void {
  const lines = ctx.getText().split("\n");
  const cursor = ctx.getCursor();
  const endLine = Math.min(cursor.line + count - 1, lines.length - 1);
  const range = lineRange(lines, cursor.line, endLine);
  const result = applyOperator(operator, lines, range);
  applyResult(ctx, result.newLines, result.cursor, result.enterInsert, result.yanked);
}

/** Execute a word motion with vim's operator-specific rules (cw/dw). */
function executeWordMotion(
  ctx: NormalModeContext,
  motion: (lines: string[], cursor: Pos, count: number) => MotionResult,
  endMotion: (lines: string[], cursor: Pos, count: number) => MotionResult,
  count: number,
  operator: string,
): void {
  const lines = ctx.getText().split("\n");
  const cursor = ctx.getCursor();
  const currentChar = (lines[cursor.line] || "")[cursor.col] || "";

  // `cw`/`cW` behave like `ce`/`cE` when not started in whitespace.
  let result = operator === "c" && !/[ \t]/.test(currentChar)
    ? endMotion(lines, cursor, count)
    : motion(lines, cursor, count);

  // A single `dw`/`dW` on the last word of a line does not consume the newline.
  if (
    operator === "d" &&
    count === 1 &&
    result.position.line > cursor.line &&
    /\S/.test((lines[cursor.line] || "").slice(cursor.col))
  ) {
    result = {
      position: {
        line: cursor.line,
        col: Math.max(0, (lines[cursor.line] || "").length - 1),
      },
      linewise: false,
      inclusive: true,
    };
  }

  executeMotion(ctx, result, operator);
}

function toggleChar(ch: string): string {
  return ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
}

export function handleNormalMode(data: string, ctx: NormalModeContext): void {
  const { state } = ctx;

  // --- Escape / Ctrl+[ / Ctrl-C: cancel pending state, or pass through to Pi. ---
  if (matchesKey(data, "escape") || matchesKey(data, "ctrl+[") || matchesKey(data, "ctrl+c")) {
    if (
      state.pendingOp ||
      state.pendingChar ||
      state.pendingG ||
      state.pendingTextObj ||
      state.countStarted
    ) {
      resetPending(state);
      return;
    }
    ctx.superHandleInput(data);
    return;
  }

  // --- Arrow keys: delegate to Pi (history navigation + cursor movement,
  // --- exactly like INSERT mode). ---
  if (matchesKey(data, "up") || matchesKey(data, "down")) {
    resetPending(state);
    ctx.superHandleInput(data);
    return;
  }

  // --- Enter: submit. ---
  if (matchesKey(data, "enter") || matchesKey(data, "return")) {
    resetPending(state);
    ctx.submit();
    return;
  }

  // --- Ctrl-R: redo. ---
  if (matchesKey(data, "ctrl+r")) {
    resetPending(state);
    ctx.redo();
    return;
  }

  // --- Ctrl-A / Ctrl-X: increment / decrement number. ---
  if (matchesKey(data, "ctrl+a") || matchesKey(data, "ctrl+x")) {
    const delta = matchesKey(data, "ctrl+a") ? state.count || 1 : -(state.count || 1);
    const lines = ctx.getText().split("\n");
    const cursor = ctx.getCursor();
    const result = incrementNumber(lines, cursor, delta);
    resetPending(state);
    if (result) {
      ctx.setText(result.newLines.join("\n"));
      ctx.moveCursorTo(result.cursor.line, result.cursor.col);
    }
    return;
  }

  // --- Digits: count accumulation. ---
  if (data >= "0" && data <= "9") {
    if (state.count === 0 && !state.countStarted && data === "0") {
      // Bare `0`: line start (executeMotion honors a pending operator).
      executeMotion(ctx, lineStart(ctx.getText().split("\n"), ctx.getCursor(), 1));
      return;
    }
    state.count = state.count * 10 + (data.charCodeAt(0) - 48);
    state.countStarted = true;
    return;
  }

  const lines = ctx.getText().split("\n");
  const cursor = ctx.getCursor();

  // --- Pending character input (f/F/t/T/r). ---
  if (state.pendingChar) {
    const pc = state.pendingChar;
    state.pendingChar = null;
    const count = state.count || 1;
    state.count = 0;
    state.countStarted = false;

    if (pc === "r") {
      const line = lines[cursor.line] || "";
      const endCol = Math.min(cursor.col + count - 1, Math.max(0, line.length - 1));
      if (cursor.col <= endCol && endCol < line.length && line.length > 0) {
        const newLines = [...lines];
        newLines[cursor.line] =
          line.slice(0, cursor.col) + data.repeat(endCol - cursor.col + 1) + line.slice(endCol + 1);
        ctx.setText(newLines.join("\n"));
        ctx.moveCursorTo(cursor.line, cursor.col);
      }
      resetPending(state);
      return;
    }

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
    }
    executeMotion(ctx, motion, count);
    return;
  }

  // --- Pending g prefix. ---
  if (state.pendingG) {
    state.pendingG = false;
    switch (data) {
      case "g": {
        // gg — go to line (count or 1).
        executeMotion(ctx, goToLine(lines, cursor, state.pendingGCount));
        state.count = 0;
        state.countStarted = false;
        state.pendingGCount = 1;
        return;
      }
      case "u":
      case "U":
      case "~": {
        // gu/gU/g~ — case operator; doubled form (guu etc.) handled in pendingOp.
        state.pendingOp = data === "u" ? "gu" : data === "U" ? "gU" : "g~";
        state.pendingOpCount = state.count || 1;
        state.count = 0;
        state.countStarted = false;
        return;
      }
      case "J": {
        const c = state.count || 1;
        state.count = 0;
        state.countStarted = false;
        joinLines(ctx, lines, cursor, c, false);
        return;
      }
      case "v": {
        // gv — reselect last visual selection.
        const last = state.lastVisual;
        state.count = 0;
        state.countStarted = false;
        if (last) {
          state.mode = last.mode;
          state.visualAnchor = { ...last.anchor };
          ctx.moveCursorTo(last.cursor.line, last.cursor.col);
        }
        return;
      }
      default:
        resetPending(state);
        return;
    }
  }

  // --- Pending text object prefix (i/a after an operator). ---
  if (state.pendingTextObj && state.pendingOp) {
    const prefix = state.pendingTextObj;
    const op = state.pendingOp;
    state.pendingTextObj = null;
    state.pendingOp = null;
    const fn = resolveTextObject(prefix, data);
    if (fn) {
      const obj = fn(lines, cursor);
      if (obj) {
        const count = state.count || 1;
        state.count = 0;
        state.countStarted = false;
        // Counted word objects (2iw/2aw) extend over consecutive words —
        // delete/change only (vim semantics).
        if (count > 1 && (op === "d" || op === "c") && data === "w") {
          applyCountedWordObject(ctx, op, lines, obj, count, prefix === "a");
          return;
        }
        if (obj.start.line === obj.end.line && obj.start.col > obj.end.col) {
          // Empty inner object: delete no-ops; change enters insert.
          if (op === "c") {
            const result = applyOperator("c", lines, {
              start: obj.start,
              end: obj.end,
              linewise: false,
              inclusive: true,
            });
            applyResult(ctx, result.newLines, result.cursor, result.enterInsert, result.yanked);
            return;
          }
          resetPending(state);
          return;
        }
        const result = applyOperator(op, lines, {
          start: obj.start,
          end: obj.end,
          linewise: obj.linewise,
          inclusive: true,
        });
        applyResult(ctx, result.newLines, result.cursor, result.enterInsert, result.yanked);
        return;
      }
    }
    resetPending(state);
    return;
  }

  // --- Pending operator: expect a motion, doubled key, or text object. ---
  if (state.pendingOp) {
    const op = state.pendingOp;
    const opCount = state.pendingOpCount;
    const hasCount = state.count > 0;

    // Doubled operators: dd/cc/yy/>>/<< and guu/gUgU/g~g~.
    const doubled =
      !hasCount &&
      ((op === "d" && data === "d") ||
        (op === "c" && data === "c") ||
        (op === "y" && data === "y") ||
        (op === ">" && data === ">") ||
        (op === "<" && data === "<") ||
        ((op === "gu" || op === "gU" || op === "g~") && data === op[1]));
    if (doubled) {
      applyLinewise(ctx, op, opCount);
      return;
    }

    // Motion count: operator count × motion count.
    const mCount = (state.count || 1) * opCount;
    state.count = 0;
    state.countStarted = false;
    state.pendingOp = null;
    state.pendingOpCount = 1;

    switch (data) {
      case "h":
        executeMotion(ctx, charLeft(lines, cursor, mCount), op);
        return;
      case "j":
        executeMotion(ctx, lineDown(lines, cursor, mCount), op);
        return;
      case "k":
        executeMotion(ctx, lineUp(lines, cursor, mCount), op);
        return;
      case "l":
        executeMotion(ctx, charRight(lines, cursor, mCount), op);
        return;
      case "w":
        executeWordMotion(ctx, wordForward, wordEnd, mCount, op);
        return;
      case "W":
        executeWordMotion(ctx, WORDForward, WORDEnd, mCount, op);
        return;
      case "b":
        executeMotion(ctx, wordBackward(lines, cursor, mCount), op);
        return;
      case "B":
        executeMotion(ctx, WORDBackward(lines, cursor, mCount), op);
        return;
      case "e":
        executeMotion(ctx, wordEnd(lines, cursor, mCount), op);
        return;
      case "E":
        executeMotion(ctx, WORDEnd(lines, cursor, mCount), op);
        return;
      case "0":
        executeMotion(ctx, lineStart(lines, cursor, 1), op);
        return;
      case "^":
      case "_":
        executeMotion(ctx, firstNonBlank(lines, cursor, 1), op);
        return;
      case "$":
        executeMotion(ctx, lineEnd(lines, cursor, mCount), op);
        return;
      case "g":
        executeMotion(ctx, goToLine(lines, cursor, 1), op);
        return;
      case "G":
        executeMotion(ctx, goToLine(lines, cursor, lines.length), op);
        return;
      case "%":
        executeMotion(ctx, matchingBracket(lines, cursor, 1), op);
        return;
      case "f":
      case "F":
      case "t":
      case "T":
        state.pendingChar = data as "f" | "F" | "t" | "T";
        state.pendingOp = op; // re-pend the operator for after the char
        state.pendingOpCount = mCount;
        return;
      case ";": {
        const fn = repeatFind(state.lastFind, false);
        executeMotion(ctx, fn ? fn(lines, cursor, mCount) : null, op);
        return;
      }
      case ",": {
        const fn = repeatFind(state.lastFind, true);
        executeMotion(ctx, fn ? fn(lines, cursor, mCount) : null, op);
        return;
      }
      case "i":
      case "a":
        state.pendingTextObj = data;
        state.pendingOp = op;
        state.pendingOpCount = mCount;
        return;
      default:
        // Unsupported motion: clear the operator, ignore the key.
        return;
    }
  }

  // --- No pending state: motions (with count prefix). ---
  const hadCount = state.countStarted;
  const mCount = state.count || 1;
  state.count = 0;
  state.countStarted = false;

  switch (data) {
    case "h":
      executeMotion(ctx, charLeft(lines, cursor, mCount));
      return;
    case "j":
      executeMotion(ctx, lineDown(lines, cursor, mCount));
      return;
    case "k":
      executeMotion(ctx, lineUp(lines, cursor, mCount));
      return;
    case "l":
      executeMotion(ctx, charRight(lines, cursor, mCount));
      return;
    case "w":
      executeMotion(ctx, wordForward(lines, cursor, mCount));
      return;
    case "W":
      executeMotion(ctx, WORDForward(lines, cursor, mCount));
      return;
    case "b":
      executeMotion(ctx, wordBackward(lines, cursor, mCount));
      return;
    case "B":
      executeMotion(ctx, WORDBackward(lines, cursor, mCount));
      return;
    case "e":
      executeMotion(ctx, wordEnd(lines, cursor, mCount));
      return;
    case "E":
      executeMotion(ctx, WORDEnd(lines, cursor, mCount));
      return;
    case "0":
      executeMotion(ctx, lineStart(lines, cursor, 1));
      return;
    case "$":
      executeMotion(ctx, lineEnd(lines, cursor, mCount));
      return;
    case "^":
    case "_":
      executeMotion(ctx, firstNonBlank(lines, cursor, 1));
      return;
    case "g":
      state.pendingG = true;
      state.pendingGCount = hadCount ? mCount : 1;
      return;
    case "G":
      // G with no count goes to the LAST line; with a count, to that line.
      executeMotion(ctx, goToLine(lines, cursor, hadCount ? mCount : lines.length));
      return;
    case "%":
      executeMotion(ctx, matchingBracket(lines, cursor, 1));
      return;
    case "f":
    case "F":
    case "t":
    case "T":
    case "r":
      state.pendingChar = data as "f" | "F" | "t" | "T" | "r";
      return;
    case ";": {
      const fn = repeatFind(state.lastFind, false);
      executeMotion(ctx, fn ? fn(lines, cursor, mCount) : null);
      return;
    }
    case ",": {
      const fn = repeatFind(state.lastFind, true);
      executeMotion(ctx, fn ? fn(lines, cursor, mCount) : null);
      return;
    }
  }

  switch (data) {
    // --- Operators ---
    case "d":
    case "c":
    case "y":
    case ">":
    case "<":
      state.pendingOp = data as "d" | "c" | "y" | ">" | "<";
      state.pendingOpCount = mCount;
      return;

    // --- Enter insert ---
    case "i":
      ctx.setMode("insert");
      return;
    case "a": {
      const lineText = lines[cursor.line] || "";
      ctx.moveCursorTo(cursor.line, Math.min(cursor.col + 1, lineText.length));
      ctx.setMode("insert");
      return;
    }
    case "I": {
      const lineText = lines[cursor.line] || "";
      const m = lineText.match(/^\s*/);
      ctx.moveCursorTo(cursor.line, m ? m[0].length : 0);
      ctx.setMode("insert");
      return;
    }
    case "A":
      ctx.moveCursorTo(cursor.line, (lines[cursor.line] || "").length);
      ctx.setMode("insert");
      return;
    case "o": {
      const newLines = [...lines];
      newLines.splice(cursor.line + 1, 0, "");
      ctx.setText(newLines.join("\n"));
      ctx.moveCursorTo(cursor.line + 1, 0);
      ctx.setMode("insert");
      return;
    }
    case "O": {
      const newLines = [...lines];
      newLines.splice(cursor.line, 0, "");
      ctx.setText(newLines.join("\n"));
      ctx.moveCursorTo(cursor.line, 0);
      ctx.setMode("insert");
      return;
    }

    // --- Single-char edits ---
    case "x": {
      const lineText = lines[cursor.line] || "";
      const endCol = Math.min(cursor.col + mCount - 1, Math.max(0, lineText.length - 1));
      if (cursor.col <= endCol && lineText.length > 0) {
        state.reg = { text: lineText.slice(cursor.col, endCol + 1), linewise: false };
        const result = deleteRange(lines, {
          start: { line: cursor.line, col: cursor.col },
          end: { line: cursor.line, col: endCol },
          linewise: false,
          inclusive: true,
        });
        ctx.setText(result.newLines.join("\n"));
        ctx.moveCursorTo(result.cursor.line, result.cursor.col);
      }
      return;
    }
    case "X": {
      const startCol = Math.max(0, cursor.col - mCount);
      if (startCol < cursor.col) {
        state.reg = { text: (lines[cursor.line] || "").slice(startCol, cursor.col), linewise: false };
        const result = deleteRange(lines, {
          start: { line: cursor.line, col: startCol },
          end: { line: cursor.line, col: cursor.col - 1 },
          linewise: false,
          inclusive: true,
        });
        ctx.setText(result.newLines.join("\n"));
        ctx.moveCursorTo(result.cursor.line, result.cursor.col);
      }
      return;
    }
    case "s": {
      const lineText = lines[cursor.line] || "";
      const endCol = Math.min(cursor.col + mCount - 1, Math.max(0, lineText.length - 1));
      if (lineText.length > 0) {
        state.reg = { text: lineText.slice(cursor.col, endCol + 1), linewise: false };
        const result = deleteRange(lines, {
          start: { line: cursor.line, col: cursor.col },
          end: { line: cursor.line, col: endCol },
          linewise: false,
          inclusive: true,
        });
        ctx.setText(result.newLines.join("\n"));
      }
      ctx.moveCursorTo(cursor.line, cursor.col);
      ctx.setMode("insert");
      return;
    }
    case "S":
      applyLinewise(ctx, "c", mCount);
      return;
    case "D": {
      const lineText = lines[cursor.line] || "";
      state.reg = { text: lineText.slice(cursor.col), linewise: false };
      const result = deleteRange(lines, {
        start: { line: cursor.line, col: cursor.col },
        end: { line: cursor.line, col: Math.max(0, lineText.length - 1) },
        linewise: false,
        inclusive: true,
      });
      ctx.setText(result.newLines.join("\n"));
      ctx.moveCursorTo(cursor.line, Math.min(cursor.col, Math.max(0, (result.newLines[cursor.line] || "").length - 1)));
      return;
    }
    case "C": {
      const lineText = lines[cursor.line] || "";
      state.reg = { text: lineText.slice(cursor.col), linewise: false };
      const result = deleteRange(lines, {
        start: { line: cursor.line, col: cursor.col },
        end: { line: cursor.line, col: Math.max(0, lineText.length - 1) },
        linewise: false,
        inclusive: true,
      });
      ctx.setText(result.newLines.join("\n"));
      ctx.moveCursorTo(cursor.line, cursor.col);
      ctx.setMode("insert");
      return;
    }
    case "~": {
      const lineText = lines[cursor.line] || "";
      const chars: string[] = [];
      let i = cursor.col;
      while (chars.length < mCount && i < lineText.length) {
        chars.push(lineText[i]!);
        i++;
      }
      if (chars.length > 0) {
        const newLines = [...lines];
        newLines[cursor.line] =
          lineText.slice(0, cursor.col) +
          chars.map(toggleChar).join("") +
          lineText.slice(cursor.col + chars.length);
        ctx.setText(newLines.join("\n"));
        ctx.moveCursorTo(cursor.line, cursor.col);
      }
      return;
    }
    case "J":
      joinLines(ctx, lines, cursor, mCount, true);
      return;
    case "p":
    case "P": {
      const reg = state.reg;
      if (reg) putRegister(ctx, lines, cursor, reg, data === "P");
      return;
    }
    case "u":
      ctx.undo();
      return;

    // --- Visual mode ---
    case "v":
      state.visualAnchor = { ...cursor };
      ctx.setMode("visual");
      return;
    case "V":
      state.visualAnchor = { ...cursor };
      ctx.setMode("visual-line");
      return;

    default:
      // Unmapped printable keys are ignored in normal mode.
      return;
  }
}

/** Counted word object (2iw/2aw): extend over consecutive words (d/c only). */
function applyCountedWordObject(
  ctx: NormalModeContext,
  op: string,
  lines: string[],
  first: { start: Pos; end: Pos; linewise: boolean },
  count: number,
  around: boolean,
): void {
  let end = { ...first.end };
  let searchPos: Pos = { line: end.line, col: end.col + 1 };
  for (let n = 1; n < count; n++) {
    const next = innerWord(lines, searchPos);
    if (!next) break;
    end = { ...next.end };
    searchPos = { line: end.line, col: end.col + 1 };
  }
  const range: OperatorRange = {
    start: first.start,
    end,
    linewise: false,
    inclusive: true,
  };
  if (around) {
    // aw: include the trailing whitespace run after the last word.
    const lastLine = lines[end.line] || "";
    let c = end.col + 1;
    while (c < lastLine.length && /[ \t]/.test(lastLine[c]!)) c++;
    range.end = { line: end.line, col: c - 1 };
    range.inclusive = c - 1 >= end.col;
  }
  const result = applyOperator(op, lines, range);
  applyResult(ctx, result.newLines, result.cursor, result.enterInsert, result.yanked);
}

/** Join count+1 lines; normalize = J, raw = gJ. */
function joinLines(
  ctx: NormalModeContext,
  lines: string[],
  cursor: Pos,
  count: number,
  normalize: boolean,
): void {
  const endLine = Math.min(cursor.line + count, lines.length - 1);
  if (endLine <= cursor.line) return;
  const parts: string[] = [];
  for (let i = cursor.line; i <= endLine; i++) parts.push(lines[i] || "");
  const joined = normalize
    ? parts[0]!.replace(/\s+$/, "") + " " + parts.slice(1).map((p) => p.replace(/^\s+/, "")).join(" ")
    : parts.join("");
  const newLines = [...lines];
  newLines.splice(cursor.line, endLine - cursor.line + 1, joined);
  ctx.setText(newLines.join("\n"));
  ctx.moveCursorTo(cursor.line, Math.min(cursor.col, Math.max(0, joined.length - 1)));
}

/** Paste register content after (P=false) or before (P=true) the cursor. */
function putRegister(
  ctx: NormalModeContext,
  lines: string[],
  cursor: Pos,
  reg: { text: string; linewise: boolean },
  before: boolean,
): void {
  const newLines = [...lines];
  if (reg.linewise) {
    const pasteLines = reg.text.split("\n");
    const insertAt = before ? cursor.line : cursor.line + 1;
    newLines.splice(insertAt, 0, ...pasteLines);
    ctx.setText(newLines.join("\n"));
    const target = Math.min(insertAt, newLines.length - 1);
    const text = newLines[target] || "";
    const m = text.match(/^\s*/);
    ctx.moveCursorTo(target, m ? m[0].length : 0);
  } else {
    const line = lines[cursor.line] || "";
    const at = before ? cursor.col : Math.min(cursor.col + 1, line.length);
    newLines[cursor.line] = line.slice(0, at) + reg.text + line.slice(at);
    ctx.setText(newLines.join("\n"));
    ctx.moveCursorTo(cursor.line, at + reg.text.length - 1);
  }
}
