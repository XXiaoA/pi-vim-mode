/**
 * state.ts — Vim state machine types and helpers.
 */
export type VimMode = "insert" | "normal" | "visual" | "visual-line";

type PendingOp = "d" | "c" | "y" | "gu" | "gU" | "g~" | ">" | "<";

export interface Pos {
  line: number;
  col: number;
}

export interface RegisterData {
  text: string;
  linewise: boolean;
}

interface VisualSelection {
  mode: "visual" | "visual-line";
  anchor: Pos;
  cursor: Pos;
}

export interface VimState {
  mode: VimMode;
  /** Numeric prefix accumulator (0 = none) */
  count: number;
  countStarted: boolean;
  /** Pending operator: d/c/y/gu/gU/g~/></ */
  pendingOp: PendingOp | null;
  /** Count supplied before the pending operator */
  pendingOpCount: number;
  /** Waiting for a character after f/F/t/T/r */
  pendingChar: "f" | "F" | "t" | "T" | "r" | null;
  /** Waiting for the second key after g */
  pendingG: boolean;
  /** Count held while waiting for the second key after g (e.g. 4gg). */
  pendingGCount: number;
  /** Waiting for a text-object key after i/a */
  pendingTextObj: "i" | "a" | null;
  /** Anchor for visual mode */
  visualAnchor: Pos | null;
  /** Last visual selection for gv */
  lastVisual: VisualSelection | null;
  /** Unnamed register (vim semantics: yank, change and delete all write it) */
  reg: RegisterData | null;
  /** Last f/F/t/T search for ; and , */
  lastFind: { char: string; forward: boolean; inclusive: boolean } | null;
  /** Insert-mode exit-sequence buffer (user-configured, e.g. jj) */
  exitBuf: string;
}

export function createInitialState(startMode: VimMode = "insert"): VimState {
  return {
    mode: startMode,
    count: 0,
    countStarted: false,
    pendingOp: null,
    pendingOpCount: 1,
    pendingChar: null,
    pendingG: false,
    pendingGCount: 1,
    pendingTextObj: null,
    visualAnchor: null,
    lastVisual: null,
    reg: null,
    lastFind: null,
    exitBuf: "",
  };
}

/** Clear all transient operator/count/pending state. */
export function resetPending(state: VimState): void {
  state.count = 0;
  state.countStarted = false;
  state.pendingOp = null;
  state.pendingOpCount = 1;
  state.pendingChar = null;
  state.pendingG = false;
  state.pendingGCount = 1;
  state.pendingTextObj = null;
}

export const MODE_LABELS: Record<VimMode, string> = {
  insert: "INSERT",
  normal: "NORMAL",
  visual: "VISUAL",
  "visual-line": "V-LINE",
};
