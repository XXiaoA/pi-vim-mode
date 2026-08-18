/**
 * operators.ts — Operator application over ranges (pure functions).
 */
import type { Pos, RegisterData } from "./state.ts";
import type { MotionResult } from "./motions.ts";

export interface OperatorRange {
  start: Pos;
  end: Pos;
  linewise: boolean;
  /** Whether the end position is included */
  inclusive: boolean;
}

export function motionToRange(cursor: Pos, motion: MotionResult): OperatorRange {
  const p = motion.position;
  const backward = p.line < cursor.line || (p.line === cursor.line && p.col < cursor.col);
  return backward
    ? { start: p, end: cursor, linewise: motion.linewise, inclusive: motion.inclusive }
    : { start: cursor, end: p, linewise: motion.linewise, inclusive: motion.inclusive };
}

/** Build a linewise range from startLine..endLine. */
export function lineRange(lines: string[], startLine: number, endLine: number): OperatorRange {
  return {
    start: { line: startLine, col: 0 },
    end: { line: endLine, col: (lines[endLine] || "").length },
    linewise: true,
    inclusive: true,
  };
}

export function extractText(lines: string[], range: OperatorRange): string {
  if (range.linewise) {
    return lines.slice(range.start.line, range.end.line + 1).join("\n");
  }
  if (range.start.line === range.end.line) {
    const line = lines[range.start.line] || "";
    const endCol = range.inclusive ? range.end.col + 1 : range.end.col;
    return line.substring(range.start.col, endCol);
  }
  const result: string[] = [];
  const firstLine = lines[range.start.line] || "";
  result.push(firstLine.substring(range.start.col));
  for (let i = range.start.line + 1; i < range.end.line; i++) {
    result.push(lines[i] || "");
  }
  const lastLine = lines[range.end.line] || "";
  const endCol = range.inclusive ? range.end.col + 1 : range.end.col;
  result.push(lastLine.substring(0, endCol));
  return result.join("\n");
}

export function deleteRange(
  lines: string[],
  range: OperatorRange,
): { newLines: string[]; cursor: Pos } {
  const newLines = [...lines];

  if (range.linewise) {
    const startLine = range.start.line;
    const endLine = range.end.line;
    newLines.splice(startLine, endLine - startLine + 1);
    if (newLines.length === 0) newLines.push("");
    const cursorLine = Math.min(startLine, newLines.length - 1);
    const text = newLines[cursorLine] || "";
    const match = text.match(/^\s*/);
    return { newLines, cursor: { line: cursorLine, col: match ? match[0].length : 0 } };
  }

  if (range.start.line === range.end.line) {
    const line = newLines[range.start.line] || "";
    const endCol = range.inclusive ? range.end.col + 1 : range.end.col;
    newLines[range.start.line] = line.substring(0, range.start.col) + line.substring(endCol);
    const resultLine = newLines[range.start.line] || "";
    return {
      newLines,
      cursor: { line: range.start.line, col: Math.min(range.start.col, Math.max(0, resultLine.length - 1)) },
    };
  }

  const firstLine = newLines[range.start.line] || "";
  const lastLine = newLines[range.end.line] || "";
  const endCol = range.inclusive ? range.end.col + 1 : range.end.col;
  const merged = firstLine.substring(0, range.start.col) + lastLine.substring(endCol);
  newLines.splice(range.start.line, range.end.line - range.start.line + 1, merged);
  if (newLines.length === 0) newLines.push("");
  const resultLine = newLines[range.start.line] || "";
  return {
    newLines,
    cursor: { line: range.start.line, col: Math.min(range.start.col, Math.max(0, resultLine.length - 1)) },
  };
}

export function indentRange(
  lines: string[],
  range: OperatorRange,
  shiftWidth = 2,
): { newLines: string[]; cursor: Pos } {
  const newLines = [...lines];
  for (let i = range.start.line; i <= range.end.line; i++) {
    const text = newLines[i] || "";
    if (text.length > 0) newLines[i] = " ".repeat(shiftWidth) + text;
  }
  const text = newLines[range.start.line] || "";
  const match = text.match(/^\s*/);
  return {
    newLines,
    cursor: { line: range.start.line, col: match ? match[0].length : 0 },
  };
}

export function dedentRange(
  lines: string[],
  range: OperatorRange,
): { newLines: string[]; cursor: Pos } {
  const newLines = [...lines];
  for (let i = range.start.line; i <= range.end.line; i++) {
    const text = newLines[i] || "";
    // Remove at most one tab, two spaces, or one space (VIM semantics).
    const match = text.match(/^( {1,2}|\t)/);
    if (match) newLines[i] = text.slice(match[0].length);
  }
  const text = newLines[range.start.line] || "";
  const m = text.match(/^\s*/);
  return {
    newLines,
    cursor: { line: range.start.line, col: m ? m[0].length : 0 },
  };
}

/** Apply a case transform over a range. Returns null for an empty/no-op range. */
export function caseRange(
  lines: string[],
  range: OperatorRange,
  kind: "lower" | "upper" | "toggle",
): { newLines: string[]; cursor: Pos } | null {
  const text = extractText(lines, range);
  if (text.length === 0) return null;

  let transformed: string;
  if (kind === "lower") transformed = text.toLowerCase();
  else if (kind === "upper") transformed = text.toUpperCase();
  else {
    transformed = text.replace(/\p{L}/gu, (ch) =>
      ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(),
    );
  }

  const newLines = [...lines];
  if (range.linewise) {
    const parts = transformed.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const li = range.start.line + i;
      if (li < newLines.length) newLines[li] = parts[i]!;
    }
  } else if (range.start.line === range.end.line) {
    const line = newLines[range.start.line] || "";
    const endCol = range.inclusive ? range.end.col + 1 : range.end.col;
    newLines[range.start.line] =
      line.substring(0, range.start.col) + transformed + line.substring(endCol);
  } else {
    const first = newLines[range.start.line] || "";
    const last = newLines[range.end.line] || "";
    const endCol = range.inclusive ? range.end.col + 1 : range.end.col;
    const parts = transformed.split("\n");
    newLines[range.start.line] = first.substring(0, range.start.col) + (parts[0] || "");
    for (let i = 1; i < parts.length - 1; i++) {
      const li = range.start.line + i;
      if (li < newLines.length) newLines[li] = parts[i] || "";
    }
    newLines[range.end.line] = (parts[parts.length - 1] || "") + last.substring(endCol);
  }

  return { newLines, cursor: range.start };
}

/** Apply a vim operator over a range. yanked is produced by c/y only. */
export function applyOperator(
  operator: string,
  lines: string[],
  range: OperatorRange,
): {
  newLines: string[];
  cursor: Pos;
  enterInsert: boolean;
  yanked: RegisterData | null;
} {
  switch (operator) {
    case "d": {
      // Vim semantics: deletes write the unnamed register.
      const result = deleteRange(lines, range);
      return {
        ...result,
        enterInsert: false,
        yanked: { text: extractText(lines, range), linewise: range.linewise },
      };
    }
    case "c": {
      const yanked = { text: extractText(lines, range), linewise: range.linewise };
      if (range.linewise) {
        const newLines = [...lines];
        const startLine = range.start.line;
        const endLine = range.end.line;
        newLines.splice(startLine, endLine - startLine + 1, "");
        return {
          newLines,
          cursor: { line: startLine, col: 0 },
          enterInsert: true,
          yanked,
        };
      }
      const result = deleteRange(lines, range);
      return {
        newLines: result.newLines,
        cursor: { line: range.start.line, col: range.start.col },
        enterInsert: true,
        yanked,
      };
    }
    case "y": {
      return {
        newLines: [...lines],
        cursor: { line: range.start.line, col: range.start.col },
        enterInsert: false,
        yanked: { text: extractText(lines, range), linewise: range.linewise },
      };
    }
    case ">": {
      const result = indentRange(lines, range);
      return { ...result, enterInsert: false, yanked: null };
    }
    case "<": {
      const result = dedentRange(lines, range);
      return { ...result, enterInsert: false, yanked: null };
    }
    case "gu":
    case "gU":
    case "g~": {
      const kind = operator === "gu" ? "lower" : operator === "gU" ? "upper" : "toggle";
      const result = caseRange(lines, range, kind);
      if (!result) return { newLines: lines, cursor: range.start, enterInsert: false, yanked: null };
      return { ...result, enterInsert: false, yanked: null };
    }
    default:
      return { newLines: [...lines], cursor: range.start, enterInsert: false, yanked: null };
  }
}

/**
 * `Ctrl-A` / `Ctrl-X` — increment/decrement the signed integer under or after
 * the cursor. Returns null when no number is found.
 */
export function incrementNumber(
  lines: string[],
  cursor: Pos,
  delta: number,
): { newLines: string[]; cursor: Pos } | null {
  const line = lines[cursor.line] || "";
  let start: number;
  if (/\d/.test(line[cursor.col] ?? "")) {
    // Cursor is on a digit: rewind to the start of the number run.
    start = cursor.col;
    while (start > 0 && /\d/.test(line[start - 1]!)) start--;
    if (start > 0 && line[start - 1] === "-") start--;
  } else {
    // Scan forward for the first digit.
    start = cursor.col;
    while (start < line.length && !/\d/.test(line[start]!)) start++;
    if (start >= line.length) return null;
    // Include an adjacent negative sign as part of the number.
    if (start > 0 && line[start - 1] === "-") start--;
  }
  const m = line.slice(start).match(/^[-+]?\d+/);
  if (!m) return null;
  const value = parseInt(m[0], 10);
  if (Number.isNaN(value)) return null;
  const newStr = String(value + delta);
  const newLines = [...lines];
  newLines[cursor.line] = line.slice(0, start) + newStr + line.slice(start + m[0].length);
  return { newLines, cursor: { line: cursor.line, col: start + newStr.length - 1 } };
}
