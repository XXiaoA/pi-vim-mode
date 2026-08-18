/**
 * Integration tests for mode handlers (normal/visual/ex) with a mock editor
 * context. Run: node --test test/modes.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, type VimState } from "../state.ts";
import { handleNormalMode } from "../normal.ts";
import { handleVisualMode } from "../visual.ts";

interface CallLog {
  setMode: string[];
  setText: string[];
  moveCursor: Array<[number, number]>;
  submit: number;
  undo: number;
  redo: number;
  superInput: string[];
}

function makeCtx(state: VimState, text = "foo bar\nbaz qux") {
  const log: CallLog = { setMode: [], setText: [], moveCursor: [], submit: 0, undo: 0, redo: 0, superInput: [] };
  let cursor = { line: 0, col: 0 };
  const ctx = {
    state,
    getText: () => text,
    getCursor: () => cursor,
    setText: (t: string) => { log.setText.push(t); text = t; },
    moveCursorTo: (line: number, col: number) => { log.moveCursor.push([line, col]); cursor = { line, col }; },
    undo: () => { log.undo++; },
    redo: () => { log.redo++; },
    submit: () => { log.submit++; },
    setMode: (m: string) => { log.setMode.push(m); state.mode = m as VimState["mode"]; },
    superHandleInput: (d: string) => { log.superInput.push(d); },
  };
  return { ctx, log };
}

test("normal: v enters visual with anchor at cursor", () => {
  const state = createInitialState("normal");
  const { ctx, log } = makeCtx(state);
  ctx.moveCursorTo(0, 4);
  handleNormalMode("v", ctx);
  assert.equal(state.mode, "visual");
  assert.deepEqual(state.visualAnchor, { line: 0, col: 4 });
  assert.deepEqual(log.setMode, ["visual"]);
});

test("normal: V enters visual-line", () => {
  const state = createInitialState("normal");
  const { ctx, log } = makeCtx(state);
  handleNormalMode("V", ctx);
  assert.equal(state.mode, "visual-line");
  assert.deepEqual(log.setMode, ["visual-line"]);
});

test("normal: Enter submits (not a newline)", () => {
  const state = createInitialState("normal");
  const { ctx, log } = makeCtx(state);
  handleNormalMode("\r", ctx);
  assert.equal(log.submit, 1);
});

test("normal: digits accumulate counts, then 2w moves twice", () => {
  const state = createInitialState("normal");
  const { ctx } = makeCtx(state, "one two three");
  ctx.moveCursorTo(0, 0);
  handleNormalMode("2", ctx);
  handleNormalMode("w", ctx);
  assert.deepEqual(ctx.getCursor(), { line: 0, col: 8 }); // start of "three"
});

test("normal: escape with pending operator cancels, not pass-through", () => {
  const state = createInitialState("normal");
  const { ctx, log } = makeCtx(state);
  handleNormalMode("d", ctx);
  assert.equal(state.pendingOp, "d");
  handleNormalMode("\x1b", ctx);
  assert.equal(state.pendingOp, null);
  assert.equal(log.superInput.length, 0);
});

test("normal: escape without pending passes through to Pi", () => {
  const state = createInitialState("normal");
  const { ctx, log } = makeCtx(state);
  handleNormalMode("\x1b", ctx);
  assert.equal(log.superInput.length, 1);
});

test("normal: up/down delegate to Pi (history navigation like insert)", () => {
  const state = createInitialState("normal");
  const { ctx, log } = makeCtx(state);
  handleNormalMode("\x1b[A", ctx); // up
  handleNormalMode("\x1b[B", ctx); // down
  assert.deepEqual(log.superInput, ["\x1b[A", "\x1b[B"]);
});

test("normal: up clears pending operator before delegating", () => {
  const state = createInitialState("normal");
  const { ctx, log } = makeCtx(state);
  handleNormalMode("d", ctx);
  assert.equal(state.pendingOp, "d");
  handleNormalMode("\x1b[A", ctx); // up
  assert.equal(state.pendingOp, null);
  assert.deepEqual(log.superInput, ["\x1b[A"]);
});

test("normal: unmapped printable keys are ignored", () => {
  const state = createInitialState("normal");
  const { ctx, log } = makeCtx(state);
  handleNormalMode("q", ctx); // not a vim key in this mapping
  assert.equal(log.superInput.length, 0);
  assert.equal(ctx.getText(), "foo bar\nbaz qux");
});

test("normal: dw deletes a word and writes the register (vim semantics)", () => {
  const state = createInitialState("normal");
  const { ctx, log } = makeCtx(state, "one two three");
  ctx.moveCursorTo(0, 0);
  state.reg = { text: "saved", linewise: false };
  handleNormalMode("d", ctx);
  handleNormalMode("w", ctx);
  assert.equal(ctx.getText(), "two three");
  assert.equal(state.reg!.text, "one "); // deletes clobber the register, like vim
  assert.ok(log.setText.length > 0);
});

test("normal: yy yanks line into register", () => {
  const state = createInitialState("normal");
  const { ctx } = makeCtx(state, "one\ntwo\nthree");
  handleNormalMode("y", ctx);
  handleNormalMode("y", ctx);
  assert.equal(state.reg?.text, "one");
  assert.equal(state.reg?.linewise, true);
});

test("normal: p pastes charwise register; x overwrites it (vim semantics)", () => {
  const state = createInitialState("normal");
  const { ctx } = makeCtx(state, "ab");
  ctx.moveCursorTo(0, 0);
  state.reg = { text: "X", linewise: false };
  handleNormalMode("p", ctx);
  assert.equal(ctx.getText(), "aXb");
  // x deletes into the register, clobbering "X".
  ctx.moveCursorTo(0, 2);
  handleNormalMode("x", ctx);
  assert.equal(state.reg!.text, "b");
});

test("normal: o opens a line below and enters insert", () => {
  const state = createInitialState("normal");
  const { ctx, log } = makeCtx(state, "ab");
  ctx.moveCursorTo(0, 1);
  handleNormalMode("o", ctx);
  assert.equal(ctx.getText(), "ab\n");
  assert.equal(state.mode, "insert");
  assert.deepEqual(ctx.getCursor(), { line: 1, col: 0 });
});

test("normal: r replaces the char under the cursor (and stays in normal)", () => {
  const state = createInitialState("normal");
  const { ctx } = makeCtx(state, "abc");
  ctx.moveCursorTo(0, 1);
  handleNormalMode("r", ctx);
  handleNormalMode("X", ctx);
  assert.equal(ctx.getText(), "aXc");
  assert.equal(state.mode, "normal");
  assert.deepEqual(ctx.getCursor(), { line: 0, col: 1 });
});

test("normal: gu/gU/g~ pending operators exist after g prefix", () => {
  const state = createInitialState("normal");
  const { ctx } = makeCtx(state);
  handleNormalMode("g", ctx);
  handleNormalMode("U", ctx);
  assert.equal(state.pendingOp, "gU");
});

test("visual: motions extend selection (cursor moves, anchor fixed)", () => {
  const state = createInitialState("normal");
  const { ctx } = makeCtx(state, "one two three");
  ctx.moveCursorTo(0, 0);
  handleNormalMode("v", ctx);
  handleVisualMode("l", ctx);
  handleVisualMode("l", ctx);
  assert.deepEqual(state.visualAnchor, { line: 0, col: 0 });
  assert.deepEqual(ctx.getCursor(), { line: 0, col: 2 });
});

test("visual: d deletes selection and returns to normal", () => {
  const state = createInitialState("normal");
  const { ctx } = makeCtx(state, "one two three");
  ctx.moveCursorTo(0, 0);
  handleNormalMode("v", ctx);
  handleVisualMode("e", ctx);
  handleVisualMode("d", ctx);
  assert.equal(ctx.getText(), " two three");
  assert.equal(state.mode, "normal");
  assert.equal(state.visualAnchor, null);
});

test("visual: y yanks selection into register", () => {
  const state = createInitialState("normal");
  const { ctx } = makeCtx(state, "one two");
  ctx.moveCursorTo(0, 0);
  handleNormalMode("v", ctx);
  handleVisualMode("e", ctx);
  handleVisualMode("y", ctx);
  assert.equal(state.reg?.text, "one");
  assert.equal(state.reg?.linewise, false);
  assert.equal(ctx.getText(), "one two");
});

test("visual: v toggles to line mode and back exits", () => {
  const state = createInitialState("normal");
  const { ctx } = makeCtx(state, "one\ntwo");
  ctx.moveCursorTo(0, 1);
  handleNormalMode("v", ctx);
  assert.equal(state.mode, "visual");
  handleVisualMode("V", ctx);
  assert.equal(state.mode, "visual-line");
  handleVisualMode("V", ctx);
  assert.equal(state.mode, "normal");
});

test("visual: Esc cancels and saves lastVisual for gv", () => {
  const state = createInitialState("normal");
  const { ctx } = makeCtx(state, "one two");
  ctx.moveCursorTo(0, 0);
  handleNormalMode("v", ctx);
  handleVisualMode("l", ctx);
  handleVisualMode("\x1b", ctx);
  assert.equal(state.mode, "normal");
  assert.deepEqual(state.lastVisual?.mode, "visual");
  assert.deepEqual(state.lastVisual?.anchor, { line: 0, col: 0 });
  // gv reselects
  handleNormalMode("g", ctx);
  handleNormalMode("v", ctx);
  assert.equal(state.mode, "visual");
  assert.deepEqual(state.visualAnchor, { line: 0, col: 0 });
});

test("visual: s behaves like c (delete selection, enter insert)", () => {
  const state = createInitialState("normal");
  const { ctx } = makeCtx(state, "ab");
  ctx.moveCursorTo(0, 0);
  handleNormalMode("v", ctx);
  handleVisualMode("l", ctx);
  handleVisualMode("s", ctx);
  assert.equal(ctx.getText(), "");
  assert.equal(state.mode, "insert");
});

test("visual: p overwrites selection with register", () => {
  const state = createInitialState("normal");
  const { ctx } = makeCtx(state, "abcdef");
  ctx.moveCursorTo(0, 1);
  state.reg = { text: "XY", linewise: false };
  handleNormalMode("v", ctx);
  handleVisualMode("l", ctx);
  handleVisualMode("p", ctx);
  assert.equal(ctx.getText(), "aXYdef");
  assert.equal(state.mode, "normal");
});
