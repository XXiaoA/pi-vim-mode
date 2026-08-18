/**
 * Quick logic tests for the pure-function layer (motions / text-objects /
 * operators). Run: node test/logic.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  wordForward,
  wordBackward,
  wordEnd,
  WORDForward,
  findCharForward,
  lineEnd,
  matchingBracket,
} from "../motions.ts";
import { innerWord, aWord, innerDoubleQuote, innerParen, resolveTextObject } from "../text-objects.ts";
import { deleteRange, applyOperator, extractText, incrementNumber, lineRange, motionToRange } from "../operators.ts";

const L = (s: string) => s.split("\n");

test("wordForward basic", () => {
  const lines = L("foo bar baz");
  assert.deepEqual(wordForward(lines, { line: 0, col: 0 }, 1).position, { line: 0, col: 4 });
  assert.deepEqual(wordForward(lines, { line: 0, col: 0 }, 2).position, { line: 0, col: 8 });
  // From inside a word: to next word start.
  assert.deepEqual(wordForward(lines, { line: 0, col: 2 }, 1).position, { line: 0, col: 4 });
});

test("wordForward punctuation and CJK", () => {
  const lines = L("foo.bar 你好世界");
  // vim: w from a word start stops at the next punctuation-run start.
  assert.deepEqual(wordForward(lines, { line: 0, col: 0 }, 1).position, { line: 0, col: 3 });
  assert.deepEqual(wordForward(lines, { line: 0, col: 3 }, 1).position, { line: 0, col: 4 });
  // From whitespace: next word start (CJK run is one word).
  assert.deepEqual(wordForward(lines, { line: 0, col: 7 }, 1).position, { line: 0, col: 8 });
  // From inside a CJK word (last word): end of that word (nvim-verified).
  assert.deepEqual(wordForward(lines, { line: 0, col: 9 }, 1).position, { line: 0, col: 11 });
  assert.deepEqual(wordForward(lines, { line: 0, col: 8 }, 1).position, { line: 0, col: 11 });
});

test("wordForward across lines", () => {
  const lines = L("one two\nthree four");
  assert.deepEqual(wordForward(lines, { line: 0, col: 4 }, 1).position, { line: 1, col: 0 });
  // From end of line: next line first word.
  const lines2 = L("one\n  two");
  assert.deepEqual(wordForward(lines2, { line: 0, col: 2 }, 1).position, { line: 1, col: 2 });
});

test("wordBackward", () => {
  const lines = L("foo bar baz");
  assert.deepEqual(wordBackward(lines, { line: 0, col: 8 }, 1).position, { line: 0, col: 4 });
  assert.deepEqual(wordBackward(lines, { line: 0, col: 4 }, 1).position, { line: 0, col: 0 });
});

test("wordEnd", () => {
  const lines = L("foo bar baz");
  assert.deepEqual(wordEnd(lines, { line: 0, col: 0 }, 1).position, { line: 0, col: 2 });
  assert.deepEqual(wordEnd(lines, { line: 0, col: 4 }, 1).position, { line: 0, col: 6 });
});

test("WORDForward whitespace-delimited", () => {
  const lines = L("a.b,c d.e");
  assert.deepEqual(WORDForward(lines, { line: 0, col: 0 }, 1).position, { line: 0, col: 6 });
});

test("findCharForward with count", () => {
  const lines = L("a,b,c,d");
  const r = findCharForward(",")(lines, { line: 0, col: 0 }, 2);
  assert.deepEqual(r?.position, { line: 0, col: 3 });
  const miss = findCharForward("x")(lines, { line: 0, col: 0 }, 1);
  assert.equal(miss, null);
});

test("lineEnd with count crosses lines", () => {
  const lines = L("ab\ncd\nef");
  assert.deepEqual(lineEnd(lines, { line: 0, col: 0 }, 2).position, { line: 1, col: 1 });
});

test("matchingBracket", () => {
  const lines = L("(a(b)c)");
  // From the open paren: matching close.
  assert.deepEqual(matchingBracket(lines, { line: 0, col: 0 }, 1).position, { line: 0, col: 6 });
  // From a non-bracket char: scan forward, match backward (vim: b -> open paren).
  assert.deepEqual(matchingBracket(lines, { line: 0, col: 3 }, 1).position, { line: 0, col: 2 });
  assert.deepEqual(matchingBracket(lines, { line: 0, col: 6 }, 1).position, { line: 0, col: 0 });
});

test("innerWord", () => {
  const lines = L("foo bar");
  assert.deepEqual(innerWord(lines, { line: 0, col: 1 }), { start: { line: 0, col: 0 }, end: { line: 0, col: 2 }, linewise: false });
  // Punctuation run
  const lines2 = L("foo...bar");
  const obj = innerWord(lines2, { line: 0, col: 4 })!;
  assert.equal(obj.start.col, 3);
  assert.equal(obj.end.col, 5);
});

test("aWord includes trailing whitespace", () => {
  const lines = L("foo bar");
  const obj = aWord(lines, { line: 0, col: 0 })!;
  assert.equal(obj.start.col, 0);
  assert.equal(obj.end.col, 3); // "foo " (trailing space)
});

test("quote object", () => {
  const lines = L('say "hello world" end');
  const inner = innerDoubleQuote(lines, { line: 0, col: 8 })!;
  assert.equal(inner.start.col, 5);
  assert.equal(inner.end.col, 15);
});

test("paren object nesting (nvim-verified)", () => {
  const lines = L("a(b(c)d)e");
  // Cursor on 'b': containing pair is the OUTER (b(c)d) — vim di( deletes it.
  const obj = innerParen(lines, { line: 0, col: 2 })!;
  assert.equal(obj.start.col, 2);
  assert.equal(obj.end.col, 6);
  // Cursor on 'c': containing pair is the inner (c).
  const obj2 = innerParen(lines, { line: 0, col: 4 })!;
  assert.equal(obj2.start.col, 4);
  assert.equal(obj2.end.col, 4);
});

test("resolveTextObject aliases", () => {
  assert.equal(resolveTextObject("i", "b"), resolveTextObject("i", "("));
  assert.equal(resolveTextObject("a", "B"), resolveTextObject("a", "{"));
  assert.equal(resolveTextObject("i", "x"), null);
});

test("deleteRange charwise", () => {
  const r = deleteRange(L("hello world"), { start: { line: 0, col: 5 }, end: { line: 0, col: 5 }, linewise: false, inclusive: true });
  assert.equal(r.newLines.join("\n"), "helloworld");
});

test("deleteRange linewise", () => {
  const r = deleteRange(L("a\nb\nc"), { start: { line: 0, col: 0 }, end: { line: 1, col: 1 }, linewise: true, inclusive: true });
  assert.equal(r.newLines.join("\n"), "c");
  assert.deepEqual(r.cursor, { line: 0, col: 0 });
});

test("deleteRange multi-line charwise", () => {
  const r = deleteRange(L("ab\ncd\nef"), { start: { line: 0, col: 1 }, end: { line: 2, col: 0 }, linewise: false, inclusive: true });
  assert.equal(r.newLines.join("\n"), "af");
});

test("applyOperator yank writes register data", () => {
  const res = applyOperator("y", L("foo bar"), { start: { line: 0, col: 0 }, end: { line: 0, col: 2 }, linewise: false, inclusive: true });
  assert.equal(res.yanked?.text, "foo");
  assert.equal(res.newLines.join("\n"), "foo bar");
});

test("applyOperator change linewise enters insert", () => {
  const res = applyOperator("c", L("a\nb"), lineRange(L("a\nb"), 0, 0));
  assert.equal(res.newLines.join("\n"), "\nb");
  assert.equal(res.enterInsert, true);
  assert.equal(res.yanked?.text, "a");
});

test("motionToRange backward", () => {
  const range = motionToRange({ line: 0, col: 5 }, { position: { line: 0, col: 2 }, linewise: false, inclusive: false });
  assert.deepEqual(range.start, { line: 0, col: 2 });
  assert.deepEqual(range.end, { line: 0, col: 5 });
});

test("incrementNumber", () => {
  const lines = L("count = 42");
  const r = incrementNumber(lines, { line: 0, col: 8 }, 1)!;
  assert.equal(r.newLines.join("\n"), "count = 43");
  // From inside the number.
  const r2 = incrementNumber(lines, { line: 0, col: 9 }, 10)!;
  assert.equal(r2.newLines.join("\n"), "count = 52");
  // Negative numbers.
  const r3 = incrementNumber(L("v = -5"), { line: 0, col: 5 }, 1)!;
  assert.equal(r3.newLines.join("\n"), "v = -4");
  // No number: null.
  assert.equal(incrementNumber(L("no digits"), { line: 0, col: 0 }, 1), null);
});

test("extractText linewise", () => {
  assert.equal(extractText(L("a\nb\nc"), lineRange(L("a\nb\nc"), 0, 1)), "a\nb");
});
