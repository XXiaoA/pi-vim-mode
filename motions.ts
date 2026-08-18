/**
 * motions.ts — Pure cursor-motion computations (no editor access).
 * Semantics follow Neovim's word/WORD/character classes.
 */
import type { Pos } from "./state.ts";

export interface MotionResult {
  position: Pos;
  /** Linewise motion (for operators) */
  linewise: boolean;
  /** Whether end position is included in operator ranges */
  inclusive: boolean;
}

export type MotionFn = (
  lines: string[],
  cursor: Pos,
  count: number,
) => MotionResult;

// --- Character classes ---

/** Word chars: Unicode letters/digits + underscore (includes CJK). */
export function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch);
}

export function isPunctuation(ch: string): boolean {
  return !isWordChar(ch) && ch !== " " && ch !== "\t" && ch !== "";
}

export function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t";
}

export function clampCol(line: string, col: number): number {
  if (!line || line.length === 0) return 0;
  return Math.max(0, Math.min(col, line.length - 1));
}

export function clampLine(lines: string[], line: number): number {
  return Math.max(0, Math.min(line, lines.length - 1));
}

// --- Character motions ---

/** `h` — left, never crosses line start. */
export const charLeft: MotionFn = (_lines, cursor, count) => ({
  position: { line: cursor.line, col: Math.max(0, cursor.col - count) },
  linewise: false,
  inclusive: false,
});

/** `l` — right, cursor cannot rest past the last char in normal mode. */
export const charRight: MotionFn = (lines, cursor, count) => ({
  position: {
    line: cursor.line,
    col: clampCol(lines[cursor.line] || "", cursor.col + count),
  },
  linewise: false,
  inclusive: false,
});

/** `j` — down one logical line (keeps column, clamped). */
export const lineDown: MotionFn = (lines, cursor, count) => {
  const line = clampLine(lines, cursor.line + count);
  const text = lines[line] || "";
  return {
    position: { line, col: Math.min(cursor.col, Math.max(0, text.length - 1)) },
    linewise: false,
    inclusive: false,
  };
};

/** `k` — up one logical line (keeps column, clamped). */
export const lineUp: MotionFn = (lines, cursor, count) => {
  const line = clampLine(lines, cursor.line - count);
  const text = lines[line] || "";
  return {
    position: { line, col: Math.min(cursor.col, Math.max(0, text.length - 1)) },
    linewise: false,
    inclusive: false,
  };
};

/** `0` — line start. */
export const lineStart: MotionFn = (_lines, cursor, _count) => ({
  position: { line: cursor.line, col: 0 },
  linewise: false,
  inclusive: false,
});

/** `$` — line end (count: down count-1 lines first). */
export const lineEnd: MotionFn = (lines, cursor, count) => {
  const targetLine = clampLine(lines, cursor.line + count - 1);
  const text = lines[targetLine] || "";
  return {
    position: { line: targetLine, col: Math.max(0, text.length - 1) },
    linewise: false,
    inclusive: true,
  };
};

/** `^` / `_` — first non-whitespace on line. */
export const firstNonBlank: MotionFn = (lines, cursor, _count) => {
  const text = lines[cursor.line] || "";
  const match = text.match(/^\s*/);
  return {
    position: { line: cursor.line, col: match ? match[0].length : 0 },
    linewise: false,
    inclusive: false,
  };
};

/** `gg` / `G` — absolute line (1-indexed). */
export function goToLine(lines: string[], cursor: Pos, lineNumber: number): MotionResult {
  const targetLine = clampLine(lines, lineNumber - 1);
  const text = lines[targetLine] || "";
  const match = text.match(/^\s*/);
  return {
    position: { line: targetLine, col: match ? match[0].length : 0 },
    linewise: true,
    inclusive: false,
  };
}

// --- Word motions (small word: word chars vs punctuation vs whitespace) ---

/** `w` — start of next word. */
export const wordForward: MotionFn = (lines, cursor, count) => {
  let { line, col } = cursor;
  for (let n = 0; n < count; n++) {
    const r = nextWordStart(lines, line, col);
    line = r.line;
    col = r.col;
  }
  return { position: { line, col }, linewise: false, inclusive: false };
};

function nextWordStart(lines: string[], line: number, col: number): Pos {
  if (lines.length === 0) return { line: 0, col: 0 };
  let text = lines[line] || "";

  if (line >= lines.length - 1 && col >= text.length - 1) {
    return { line, col: Math.max(0, text.length - 1) };
  }

  const ch = text[col] || "";
  // Skip the rest of the current run (word or punctuation).
  if (isWordChar(ch)) {
    while (col < text.length && isWordChar(text[col]!)) col++;
  } else if (isPunctuation(ch)) {
    while (col < text.length && isPunctuation(text[col]!)) col++;
  }

  // Skip whitespace (possibly across lines). Empty lines are word boundaries.
  while (true) {
    while (col < text.length && isWhitespace(text[col]!)) col++;
    if (col < text.length) break;
    line++;
    if (line >= lines.length) {
      line = lines.length - 1;
      return { line, col: Math.max(0, (lines[line] || "").length - 1) };
    }
    text = lines[line] || "";
    col = 0;
    if (text.length === 0) break;
  }
  return { line, col };
}

/** `b` — start of previous word. */
export const wordBackward: MotionFn = (lines, cursor, count) => {
  let { line, col } = cursor;
  for (let n = 0; n < count; n++) {
    const r = prevWordStart(lines, line, col);
    line = r.line;
    col = r.col;
  }
  return { position: { line, col }, linewise: false, inclusive: false };
};

function prevWordStart(lines: string[], line: number, col: number): Pos {
  if (lines.length === 0) return { line: 0, col: 0 };
  let text = lines[line] || "";
  col--;

  // Skip whitespace backwards (possibly across lines).
  while (true) {
    while (col >= 0 && isWhitespace(text[col]!)) col--;
    if (col >= 0) break;
    line--;
    if (line < 0) return { line: 0, col: 0 };
    text = lines[line] || "";
    col = text.length - 1;
  }

  // Skip back through the current run.
  if (col >= 0 && isWordChar(text[col]!)) {
    while (col > 0 && isWordChar(text[col - 1]!)) col--;
  } else if (col >= 0 && isPunctuation(text[col]!)) {
    while (col > 0 && isPunctuation(text[col - 1]!)) col--;
  }
  return { line, col: Math.max(0, col) };
}

/** `e` — end of current/next word. */
export const wordEnd: MotionFn = (lines, cursor, count) => {
  let { line, col } = cursor;
  for (let n = 0; n < count; n++) {
    const r = nextWordEnd(lines, line, col);
    line = r.line;
    col = r.col;
  }
  return { position: { line, col }, linewise: false, inclusive: true };
};

function nextWordEnd(lines: string[], line: number, col: number): Pos {
  if (lines.length === 0) return { line: 0, col: 0 };
  let text = lines[line] || "";
  col++;

  // Skip whitespace (possibly across lines).
  while (true) {
    while (col < text.length && isWhitespace(text[col]!)) col++;
    if (col < text.length) break;
    line++;
    if (line >= lines.length) {
      line = lines.length - 1;
      return { line, col: Math.max(0, (lines[line] || "").length - 1) };
    }
    text = lines[line] || "";
    col = 0;
  }

  // Move through the run.
  if (isWordChar(text[col]!)) {
    while (col < text.length - 1 && isWordChar(text[col + 1]!)) col++;
  } else if (isPunctuation(text[col]!)) {
    while (col < text.length - 1 && isPunctuation(text[col + 1]!)) col++;
  }
  return { line, col };
}

// --- WORD motions (whitespace-delimited) ---

/** `W` — start of next WORD. */
export const WORDForward: MotionFn = (lines, cursor, count) => {
  let { line, col } = cursor;
  for (let n = 0; n < count; n++) {
    const r = nextWORDStart(lines, line, col);
    line = r.line;
    col = r.col;
  }
  return { position: { line, col }, linewise: false, inclusive: false };
};

function nextWORDStart(lines: string[], line: number, col: number): Pos {
  if (lines.length === 0) return { line: 0, col: 0 };
  let text = lines[line] || "";

  while (col < text.length && !isWhitespace(text[col]!)) col++;

  while (true) {
    while (col < text.length && isWhitespace(text[col]!)) col++;
    if (col < text.length) break;
    line++;
    if (line >= lines.length) {
      line = lines.length - 1;
      return { line, col: Math.max(0, (lines[line] || "").length - 1) };
    }
    text = lines[line] || "";
    col = 0;
    if (text.length === 0) break;
  }
  return { line, col };
}

/** `B` — start of previous WORD. */
export const WORDBackward: MotionFn = (lines, cursor, count) => {
  let { line, col } = cursor;
  for (let n = 0; n < count; n++) {
    const r = prevWORDStart(lines, line, col);
    line = r.line;
    col = r.col;
  }
  return { position: { line, col }, linewise: false, inclusive: false };
};

function prevWORDStart(lines: string[], line: number, col: number): Pos {
  if (lines.length === 0) return { line: 0, col: 0 };
  let text = lines[line] || "";
  col--;

  while (true) {
    while (col >= 0 && isWhitespace(text[col]!)) col--;
    if (col >= 0) break;
    line--;
    if (line < 0) return { line: 0, col: 0 };
    text = lines[line] || "";
    col = text.length - 1;
  }
  while (col > 0 && !isWhitespace(text[col - 1]!)) col--;
  return { line, col: Math.max(0, col) };
}

/** `E` — end of current/next WORD. */
export const WORDEnd: MotionFn = (lines, cursor, count) => {
  let { line, col } = cursor;
  for (let n = 0; n < count; n++) {
    const r = nextWORDEnd(lines, line, col);
    line = r.line;
    col = r.col;
  }
  return { position: { line, col }, linewise: false, inclusive: true };
};

function nextWORDEnd(lines: string[], line: number, col: number): Pos {
  if (lines.length === 0) return { line: 0, col: 0 };
  let text = lines[line] || "";
  col++;

  while (true) {
    while (col < text.length && isWhitespace(text[col]!)) col++;
    if (col < text.length) break;
    line++;
    if (line >= lines.length) {
      line = lines.length - 1;
      return { line, col: Math.max(0, (lines[line] || "").length - 1) };
    }
    text = lines[line] || "";
    col = 0;
  }
  while (col < text.length - 1 && !isWhitespace(text[col + 1]!)) col++;
  return { line, col };
}

// --- Find char motions ---

/** `f{char}` — find char forward, inclusive. Returns null when not found. */
export function findCharForward(char: string): (
  lines: string[],
  cursor: Pos,
  count: number,
) => MotionResult | null {
  return (lines, cursor, count) => {
    const text = lines[cursor.line] || "";
    let col = cursor.col;
    for (let n = 0; n < count; n++) {
      col++;
      while (col < text.length && text[col] !== char) col++;
      if (col >= text.length) return null;
    }
    return { position: { line: cursor.line, col }, linewise: false, inclusive: true };
  };
}

/** `F{char}` — find char backward, inclusive. */
export function findCharBackward(char: string): (
  lines: string[],
  cursor: Pos,
  count: number,
) => MotionResult | null {
  return (lines, cursor, count) => {
    const text = lines[cursor.line] || "";
    let col = cursor.col;
    for (let n = 0; n < count; n++) {
      col--;
      while (col >= 0 && text[col] !== char) col--;
      if (col < 0) return null;
    }
    return { position: { line: cursor.line, col }, linewise: false, inclusive: true };
  };
}

/** `t{char}` — till char forward (one before char). */
export function tillCharForward(char: string): (
  lines: string[],
  cursor: Pos,
  count: number,
) => MotionResult | null {
  return (lines, cursor, count) => {
    const text = lines[cursor.line] || "";
    let col = cursor.col;
    for (let n = 0; n < count; n++) {
      col++;
      while (col < text.length && text[col] !== char) col++;
      if (col >= text.length) return null;
    }
    return { position: { line: cursor.line, col: col - 1 }, linewise: false, inclusive: true };
  };
}

/** `T{char}` — till char backward (one after char). */
export function tillCharBackward(char: string): (
  lines: string[],
  cursor: Pos,
  count: number,
) => MotionResult | null {
  return (lines, cursor, count) => {
    const text = lines[cursor.line] || "";
    let col = cursor.col;
    for (let n = 0; n < count; n++) {
      col--;
      while (col >= 0 && text[col] !== char) col--;
      if (col < 0) return null;
    }
    return { position: { line: cursor.line, col: col + 1 }, linewise: false, inclusive: true };
  };
}

/** Rebuild a find motion from saved state (`;` / `,`). */
export function repeatFind(
  last: { char: string; forward: boolean; inclusive: boolean } | null,
  reverse: boolean,
): ((lines: string[], cursor: Pos, count: number) => MotionResult | null) | null {
  if (!last) return null;
  const forward = reverse ? !last.forward : last.forward;
  if (forward) {
    return last.inclusive ? findCharForward(last.char) : tillCharForward(last.char);
  }
  return last.inclusive ? findCharBackward(last.char) : tillCharBackward(last.char);
}

// --- Matching bracket (`%`) ---

const BRACKET_PAIRS: Record<string, string> = {
  "(": ")",
  ")": "(",
  "[": "]",
  "]": "[",
  "{": "}",
  "}": "{",
};
const OPEN_BRACKETS = new Set(["(", "[", "{"]);

export const matchingBracket: MotionFn = (lines, cursor, _count) => {
  const text = lines[cursor.line] || "";

  let bracketCol = cursor.col;
  while (bracketCol < text.length && !BRACKET_PAIRS[text[bracketCol]!]) {
    bracketCol++;
  }
  if (bracketCol >= text.length) {
    return { position: cursor, linewise: false, inclusive: true };
  }

  const bracket = text[bracketCol]!;
  const match = BRACKET_PAIRS[bracket]!;
  const isOpen = OPEN_BRACKETS.has(bracket);
  let depth = 1;

  if (isOpen) {
    let line = cursor.line;
    let col = bracketCol + 1;
    while (line < lines.length) {
      const lineText = lines[line]!;
      while (col < lineText.length) {
        if (lineText[col] === bracket) depth++;
        else if (lineText[col] === match) depth--;
        if (depth === 0) return { position: { line, col }, linewise: false, inclusive: true };
        col++;
      }
      line++;
      col = 0;
    }
  } else {
    let line = cursor.line;
    let col = bracketCol - 1;
    while (line >= 0) {
      const lineText = lines[line]!;
      while (col >= 0) {
        if (lineText[col] === bracket) depth++;
        else if (lineText[col] === match) depth--;
        if (depth === 0) return { position: { line, col }, linewise: false, inclusive: true };
        col--;
      }
      line--;
      if (line >= 0) col = lines[line]!.length - 1;
    }
  }
  return { position: cursor, linewise: false, inclusive: true };
};
