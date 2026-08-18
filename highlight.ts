/**
 * highlight.ts — Pure selection-highlight rendering helpers (no editor access).
 *
 * The base editor wraps text lines with a word-aware algorithm (pi-tui's
 * `wordWrapLine`). This module mirrors that algorithm so the visual-mode
 * selection highlight lands on the exact rendered rows and cells — including
 * wrapped lines, wide (CJK) characters and scrolled documents. If pi-tui's
 * wrapping changes, the mirrored logic here must follow.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** CJK scripts allow line breaks between any adjacent characters (pi-tui's cjkBreakRegex). */
const CJK_BREAK = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

export interface WrapRow {
  /** Char offset of the row's first grapheme in the source line. */
  startChar: number;
  /** Cell offset of the row start within the line. */
  startCell: number;
  /** Cell offset of the row end (exclusive) within the line. */
  endCell: number;
}

/**
 * Compute the wrap rows of a text line, mirroring pi-tui's `wordWrapLine`:
 * break at whitespace / CJK opportunities, force-break long runs. The rows
 * tile the line's cell range [0, visibleWidth(line)) contiguously.
 *
 * One simplification: a single grapheme wider than a whole row (paste markers
 * in an extremely narrow terminal) gets its own row, where pi-tui splits it
 * across several; this only differs for terminal widths under ~10 columns.
 */
export function computeWrapRows(line: string, maxWidth: number): WrapRow[] {
  const lineCells = visibleWidth(line);
  if (maxWidth <= 0 || lineCells <= maxWidth) {
    return [{ startChar: 0, startCell: 0, endCell: lineCells }];
  }
  const segments = [...graphemeSegmenter.segment(line)];
  const rows: WrapRow[] = [];
  let currentWidth = 0; // cells consumed since the current row start
  let chunkStart = 0; // char offset of the current row start
  let chunkStartCell = 0; // cells before chunkStart
  let wrapOppIndex = -1; // char index where a break is allowed (after the last space / CJK boundary)
  let wrapOppWidth = 0; // cells consumed up to wrapOppIndex

  const pushRow = (endChar: number, endCell: number): void => {
    rows.push({ startChar: chunkStart, startCell: chunkStartCell, endCell });
    chunkStart = endChar;
    chunkStartCell = endCell;
  };

  for (let i = 0; i < segments.length; i++) {
    const grapheme = segments[i]!.segment;
    const charIndex = segments[i]!.index;
    const gWidth = visibleWidth(grapheme);
    const isWs = /^\s$/u.test(grapheme);

    if (currentWidth + gWidth > maxWidth) {
      if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
        // Backtrack to the last break opportunity (the remainder plus the
        // current grapheme still fits on one row).
        pushRow(wrapOppIndex, chunkStartCell + wrapOppWidth);
        currentWidth -= wrapOppWidth;
      } else if (chunkStart < charIndex) {
        // No viable opportunity: force-break before the current grapheme.
        pushRow(charIndex, chunkStartCell + currentWidth);
        currentWidth = 0;
      }
      wrapOppIndex = -1;
    }

    if (gWidth > maxWidth) {
      // Atomic grapheme wider than a whole row: it occupies its own row.
      pushRow(charIndex + grapheme.length, chunkStartCell + currentWidth + gWidth);
      currentWidth = 0;
      continue;
    }

    currentWidth += gWidth;
    const next = segments[i + 1];
    const nextIsWs = next ? /^\s$/u.test(next.segment) : false;
    if (isWs && next && !nextIsWs) {
      // Whitespace run: the break point is after the last space.
      wrapOppIndex = next.index;
      wrapOppWidth = currentWidth;
    } else if (!isWs && next && !nextIsWs && (CJK_BREAK.test(grapheme) || CJK_BREAK.test(next.segment))) {
      wrapOppIndex = next.index;
      wrapOppWidth = currentWidth;
    }
  }
  rows.push({ startChar: chunkStart, startCell: chunkStartCell, endCell: lineCells });
  return rows;
}

/** Detect an escape sequence at position `pos`. Handles CSI, OSC, APC. */
export function escapeSeqLength(str: string, pos: number): number {
  if (pos >= str.length || str[pos] !== "\x1b") return 0;
  const next = str[pos + 1];

  if (next === "[") {
    // CSI: parameters then a final byte in 0x40–0x7e.
    let j = pos + 2;
    while (j < str.length && !/[\x40-\x7e]/.test(str[j]!)) j++;
    if (j < str.length) return j + 1 - pos;
    return 0;
  }
  if (next === "]" || next === "_") {
    // OSC / APC (incl. the CURSOR_MARKER): terminated by BEL or ST.
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07") return j + 1 - pos;
      if (str[j] === "\x1b" && str[j + 1] === "\\") return j + 2 - pos;
      j++;
    }
    return 0;
  }
  return 0;
}

function isResetSequence(seq: string): boolean {
  return seq === "\x1b[0m" || seq === "\x1b[m";
}

/**
 * Resolve the selection-highlight style from `selectionColor`. The selection
 * is ALWAYS a background color (never reverse video — the caret is the
 * reverse-video cell).
 * - undefined | "theme" → pi's `selectedBg` theme background (auto-adapts to
 *   light/dark)
 * - `#rrggbb` or 0-255 index → a fixed background color
 * Invalid values fall back to the theme background when resolvable, else a
 * neutral dark background.
 */
export function resolveSelectionStyle(
  color: string | undefined,
  themeColor?: (name: string) => string | undefined,
): { start: string; end: string } {
  const themeBg = (): { start: string; end: string } | null => {
    const ansi = themeColor?.("selectedBg");
    if (ansi && ansi.includes("\x1b[")) return { start: ansi, end: "\x1b[49m" };
    if (ansi && /^#[0-9a-fA-F]{6}$/.test(ansi)) {
      const r = parseInt(ansi.slice(1, 3), 16);
      const g = parseInt(ansi.slice(3, 5), 16);
      const b = parseInt(ansi.slice(5, 7), 16);
      return { start: `\x1b[48;2;${r};${g};${b}m`, end: "\x1b[49m" };
    }
    return null;
  };

  if (!color || color === "theme") {
    return themeBg() ?? { start: "\x1b[48;5;238m", end: "\x1b[49m" };
  }
  const hex = color.match(/^#([0-9a-fA-F]{6})$/);
  if (hex) {
    const r = parseInt(hex[1]!.slice(0, 2), 16);
    const g = parseInt(hex[1]!.slice(2, 4), 16);
    const b = parseInt(hex[1]!.slice(4, 6), 16);
    return { start: `\x1b[48;2;${r};${g};${b}m`, end: "\x1b[49m" };
  }
  if (/^\d{1,3}$/.test(color)) {
    const n = Math.max(0, Math.min(255, parseInt(color, 10)));
    return { start: `\x1b[48;5;${n}m`, end: "\x1b[49m" };
  }
  return themeBg() ?? { start: "\x1b[48;5;238m", end: "\x1b[49m" };
}

/**
 * Insert the selection background style at visible cell columns
 * [startVisCol, endVisCol) of a rendered line, counting cells per grapheme
 * (wide CJK characters occupy 2 cells) exactly like the base renderer.
 */
export function highlightRenderedLine(
  line: string,
  startVisCol: number,
  endVisCol: number,
  styleStart: string,
  styleEnd: string,
): string {
  const out: string[] = [];
  let visCol = 0;
  let started = false;
  let ended = false;
  let i = 0;

  const maybeStart = (): void => {
    if (!started && visCol >= startVisCol) {
      out.push(styleStart);
      started = true;
    }
  };
  const maybeEnd = (): void => {
    if (started && !ended && visCol >= endVisCol) {
      out.push(styleEnd);
      ended = true;
    }
  };

  while (i < line.length) {
    const seqLen = escapeSeqLength(line, i);
    if (seqLen > 0) {
      maybeStart();
      maybeEnd();
      const seq = line.substring(i, i + seqLen);
      out.push(seq);
      // A reset inside the selection (e.g. after the reverse-video cursor
      // cell) would clear the highlight — re-apply it.
      if (started && !ended && isResetSequence(seq)) out.push(styleStart);
      i += seqLen;
      continue;
    }

    // Text run up to the next escape sequence: advance by grapheme widths.
    let runEnd = i;
    while (runEnd < line.length && escapeSeqLength(line, runEnd) === 0) runEnd++;
    for (const { segment } of graphemeSegmenter.segment(line.slice(i, runEnd))) {
      maybeStart();
      maybeEnd();
      out.push(segment);
      visCol += visibleWidth(segment);
    }
    i = runEnd;
  }

  if (started && !ended) out.push(styleEnd);
  return out.join("");
}
