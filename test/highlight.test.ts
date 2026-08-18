/**
 * Tests for the pure selection-highlight layer (highlight.ts): wrap-row
 * mapping, ANSI-aware rendering, grapheme cell accounting and the
 * config→style resolver. Run: node --test test/highlight.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeWrapRows,
  escapeSeqLength,
  highlightRenderedLine,
  resolveSelectionStyle,
} from "../highlight.ts";

// --- computeWrapRows ---

test("computeWrapRows: short line is one row", () => {
  assert.deepEqual(computeWrapRows("hello", 20), [{ startChar: 0, startCell: 0, endCell: 5 }]);
  assert.deepEqual(computeWrapRows("", 20), [{ startChar: 0, startCell: 0, endCell: 0 }]);
});

test("computeWrapRows: exact-fit line is one row", () => {
  assert.deepEqual(computeWrapRows("abcd", 4), [{ startChar: 0, startCell: 0, endCell: 4 }]);
});

test("computeWrapRows: breaks at the last whitespace, keeping it on the row", () => {
  // "aaaa bbbb cccc dddd" at width 12 → "aaaa bbbb " / "cccc dddd".
  assert.deepEqual(computeWrapRows("aaaa bbbb cccc dddd", 12), [
    { startChar: 0, startCell: 0, endCell: 10 },
    { startChar: 10, startCell: 10, endCell: 19 },
  ]);
});

test("computeWrapRows: CJK breaks between any adjacent characters (2 cells each)", () => {
  const rows = computeWrapRows("你好世界你好世界", 4); // 8 chars = 16 cells
  assert.deepEqual(rows, [
    { startChar: 0, startCell: 0, endCell: 4 },
    { startChar: 2, startCell: 4, endCell: 8 },
    { startChar: 4, startCell: 8, endCell: 12 },
    { startChar: 6, startCell: 12, endCell: 16 },
  ]);
});

test("computeWrapRows: long unbroken run force-breaks at the cell boundary", () => {
  assert.deepEqual(computeWrapRows("abcdefghij", 4), [
    { startChar: 0, startCell: 0, endCell: 4 },
    { startChar: 4, startCell: 4, endCell: 8 },
    { startChar: 8, startCell: 8, endCell: 10 },
  ]);
});

test("computeWrapRows: rows tile the line cell range contiguously", () => {
  const line = "one two three four five six seven eight";
  const rows = computeWrapRows(line, 9);
  assert.equal(rows[0]!.startCell, 0);
  assert.equal(rows[rows.length - 1]!.endCell, line.length);
  for (let i = 1; i < rows.length; i++) {
    assert.equal(rows[i]!.startCell, rows[i - 1]!.endCell);
  }
});

// --- escapeSeqLength ---

test("escapeSeqLength: CSI, OSC, APC, plain text", () => {
  assert.equal(escapeSeqLength("\x1b[31mred", 0), 5); // CSI SGR
  assert.equal(escapeSeqLength("\x1b[7m", 0), 4); // reverse video
  assert.equal(escapeSeqLength("\x1b]0;title\x07", 0), 10); // OSC (BEL terminator)
  assert.equal(escapeSeqLength("\x1b_pi:c\x07", 0), 7); // APC cursor marker
  assert.equal(escapeSeqLength("abc", 0), 0);
  assert.equal(escapeSeqLength("\x1b", 0), 0); // lone ESC
});

// --- highlightRenderedLine ---

test("highlightRenderedLine: plain ASCII range", () => {
  // Cells 1..2 (exclusive end 3) are highlighted: h[S]e l[E]l o.
  assert.equal(highlightRenderedLine("hello", 1, 3, "S", "E"), "hSelElo");
});

test("highlightRenderedLine: range to end of line", () => {
  assert.equal(highlightRenderedLine("hello", 2, 5, "S", "E"), "heSlloE");
});

test("highlightRenderedLine: keeps ANSI sequences intact", () => {
  assert.equal(highlightRenderedLine("\x1b[31mhello\x1b[0m", 1, 3, "S", "E"), "\x1b[31mhSelElo\x1b[0m");
});

test("highlightRenderedLine: wide (CJK) characters count 2 cells", () => {
  // 你=2 cells, 好=2, a/b/c=1 each. Highlight cells 2..6 → 好 + ab, c excluded.
  assert.equal(highlightRenderedLine("你好abc", 2, 6, "S", "E"), "你S好abEc");
});

test("highlightRenderedLine: zero-width APC cursor marker does not shift cells", () => {
  assert.equal(highlightRenderedLine("\x1b_pi:c\x07X", 0, 1, "S", "E"), "S\x1b_pi:c\x07XE");
});

test("highlightRenderedLine: re-applies style after a reset inside the range", () => {
  // Reverse-video cursor cell (marker + \x1b[7mX\x1b[0m) at cells 0..1:
  // the reset after X must not clear the selection background.
  const out = highlightRenderedLine("\x1b[7mX\x1b[0mrest", 0, 5, "S", "E");
  assert.equal(out, "S\x1b[7mX\x1b[0mSrestE");
});

// --- resolveSelectionStyle ---

test("resolveSelectionStyle: theme resolver returning ANSI", () => {
  const style = resolveSelectionStyle("theme", () => "\x1b[48;5;66m");
  assert.equal(style.start, "\x1b[48;5;66m");
  assert.equal(style.end, "\x1b[49m");
});

test("resolveSelectionStyle: theme resolver returning a hex", () => {
  const style = resolveSelectionStyle(undefined, () => "#3d3d5c");
  assert.equal(style.start, "\x1b[48;2;61;61;92m");
});

test("resolveSelectionStyle: fixed hex background", () => {
  const style = resolveSelectionStyle("#3d3d5c");
  assert.equal(style.start, "\x1b[48;2;61;61;92m");
  assert.equal(style.end, "\x1b[49m");
});

test("resolveSelectionStyle: fixed ANSI index", () => {
  const style = resolveSelectionStyle("238");
  assert.equal(style.start, "\x1b[48;5;238m");
  // Out-of-range indices clamp.
  assert.equal(resolveSelectionStyle("999").start, "\x1b[48;5;255m");
});

test("resolveSelectionStyle: unresolvable values fall back", () => {
  const neutral = "\x1b[48;5;238m";
  assert.equal(resolveSelectionStyle("not-a-color").start, neutral); // no resolver
  assert.equal(resolveSelectionStyle("not-a-color", () => undefined).start, neutral);
  assert.equal(resolveSelectionStyle("theme", () => undefined).start, neutral);
});
