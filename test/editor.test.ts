/**
 * Headless routing tests for VimEditor with a fake TUI (no real terminal).
 * Run: node --test test/editor.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { VimEditor } from "../vim-editor.ts";

interface EditorSurface {
  handleInput(data: string): void;
  getMode(): string;
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  undoStack: unknown[];
  redoStack: unknown[];
  undo?: () => void;
  onChange?: () => void;
}

function makeEditor(startMode: "insert" | "normal" = "insert"): EditorSurface {
  const tui = {
    terminal: { write: () => {}, rows: 50, columns: 120 },
    requestRender: () => {},
    setShowHardwareCursor: () => {},
  };
  const theme = { borderColor: (s: string) => s, selectList: {} };
  const editor = new VimEditor(tui as never, theme as never, {} as never, { startMode });
  const surface = editor as unknown as EditorSurface;
  // Mirror the base editor's private internals the vim layer reads.
  surface.state = { lines: ["hello"], cursorLine: 0, cursorCol: 5 };
  surface.undoStack = [{ state: { lines: ["hello"], cursorLine: 0, cursorCol: 5 } }];
  return surface;
}

test("insert: ctrl+z delegates to Pi's native undo and mirrors the redo stack", () => {
  const ed = makeEditor("insert");
  let undoCalls = 0;
  ed.undo = () => {
    undoCalls++;
  };
  ed.handleInput("\x1a"); // ctrl+z
  assert.equal(undoCalls, 1, "undo must be invoked");
  assert.equal(ed.redoStack.length, 1, "undo snapshots the state for redo");
  assert.equal(ed.getMode(), "insert", "ctrl+z must not leave INSERT");
});

test("insert: ctrl+z with an empty undo stack is a no-op", () => {
  const ed = makeEditor("insert");
  ed.undoStack = [];
  let undoCalls = 0;
  ed.undo = () => {
    undoCalls++;
  };
  ed.handleInput("\x1a");
  assert.equal(undoCalls, 0);
  assert.equal(ed.redoStack.length, 0);
});

test("insert: ctrl+shift+z redoes from the mirror stack (CSI-u encoding)", () => {
  const ed = makeEditor("insert");
  ed.undoStack = [];
  ed.redoStack = [{ lines: ["hello redo"], cursorLine: 0, cursorCol: 10 }];
  let changes = 0;
  ed.undo = () => {};
  ed.onChange = () => {
    changes++;
  };
  ed.handleInput("\x1b[122;6u"); // ctrl+shift+z (kitty/CSI-u)
  assert.equal(changes, 1, "redo must fire onChange");
  assert.equal(ed.state.lines.join("\n"), "hello redo");
  assert.equal(ed.undoStack.length, 1, "redo pushes the pre-redo state for undo");
  assert.equal(ed.redoStack.length, 0);
  assert.equal(ed.getMode(), "insert");
});

test("insert: ctrl+shift+z with an empty redo stack is a no-op", () => {
  const ed = makeEditor("insert");
  ed.redoStack = [];
  let changes = 0;
  ed.onChange = () => {
    changes++;
  };
  ed.handleInput("\x1b[122;6u");
  assert.equal(changes, 0);
});

test("normal: ctrl+z does not undo (kept out of vim's NORMAL handling)", () => {
  const ed = makeEditor("normal");
  let undoCalls = 0;
  ed.undo = () => {
    undoCalls++;
  };
  ed.handleInput("\x1a"); // ctrl+z
  assert.equal(undoCalls, 0, "NORMAL mode must not claim ctrl+z as undo");
  assert.equal(ed.getMode(), "normal");
});
