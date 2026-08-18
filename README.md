# pi-vim-mode

Vim-style modal editing for the [Pi coding agent](https://pi.dev) prompt editor.

Replace Pi's default Emacs-flavored input with real modal editing — INSERT, NORMAL, VISUAL and V-LINE modes, operators, text objects, theme-aware selection highlighting, and IME-friendly mode switching. Everything happens in place; your draft is never interrupted.

## Features

- **Modal editing** — INSERT / NORMAL / VISUAL / V-LINE modes with a live mode indicator (mode, pending operator, cursor position) on the editor border
- **Full motion set** — `h j k l`, `w b e`, `W B E`, `0 $ ^ _`, `gg G` (count → absolute line), `f F t T ; ,`, `%`, counts
- **Operators** — `d c y` with motions and text objects, `dd cc yy`, `gu gU g~`, `> <`, operator counts (`3dw`, `d2f,`, `3dd`)
- **Text objects** — `iw aw iW aW`, quotes, brackets (nesting-aware), backticks; empty-object safety (`di"` never corrupts) and counted word objects
- **Vim register semantics** — `y`, `c` and `d` (including `x X s D C`) all write the unnamed register; `p`/`P` paste from it
- **Visual selection with live highlight** — extend with motions, `o` anchor swap, `v`/`V` switching, full edit set (`s` = `c`), `p` overwrite, `gv` reselect. The selection is a **theme background color** (auto-adapts light/dark) and the caret stays a distinct reverse-video cell. Highlighting follows pi-tui's word wrap exactly — wrapped lines, CJK/wide characters and scrolled documents stay aligned
- **Pi-native integration** — autocomplete, paste, image attachment, external editor and app shortcuts keep working in INSERT mode; `Esc` closes autocomplete before switching modes; `Ctrl+C` interrupts a running agent but enters NORMAL when idle
- **IME switching hooks** — run a shell command on mode transitions (e.g. `im-select`) so your input method follows the mode
- **Paste safety** — pasted content (`[paste #N]` markers) survives vim edits; `/vimmode off` restores the default editor instantly

## Installation

The extension lives in Pi's global extensions directory and is auto-discovered:

```bash
git clone https://github.com/XXiaoA/pi-vim-mode ~/.pi/agent/extensions/vim-mode
```

The directory name (`vim-mode`) is an abbreviation of the plugin name; Pi discovers the extension by the `index.ts` inside it, not by the directory name.

Then `/reload` in Pi (or restart). Verify with `/vimmode status`.

## Quick start

```text
Type normally…                    # INSERT mode (Pi-native input)
Esc                               # → NORMAL
jj                                # → NORMAL (insert-mode alias)
w b e 0 $ ^ gg G                  # move around
3G / 2gg                          # jump to a line
f{char} ; ,                       # find on line, repeat
dw ci" da( 2dd yyp                # operators + text objects
v V                               # select, edit, delete, yank
x X r{ch} ~ J gJ p P              # single-char edits
u <C-r>                           # undo / redo
Enter (or Ctrl+Enter)             # submit the prompt
```

## Keybindings

### Modes

| Mode | Enter with | Notes |
|---|---|---|
| INSERT | (start) `i a I A o O`, after `c`/`s`/`C`/`S` | Pi-native: autocomplete, paste, image, external editor. `Enter` / `Ctrl+Enter` submits. `Esc` / `jj` / `Ctrl+C` (idle) → NORMAL |
| NORMAL | `Esc`, `jj`, `Ctrl+C` (idle) | `Enter` / `Ctrl+Enter` submits the prompt |
| VISUAL | `v` | Character-wise selection, theme-background highlight |
| V-LINE | `V` | Line-wise selection |

`Esc` in NORMAL passes through to Pi (abort a running agent). `Esc` in VISUAL cancels the selection. While the agent is running, `Ctrl+C` always interrupts. `Ctrl+Enter` submits from **any** mode.

### NORMAL mode

| Group | Keys |
|---|---|
| Motion | `h j k l`, `0 $ ^ _`, `w b e W B E`, `gg G`, `%`, `f{ch} F{ch} t{ch} T{ch} ; ,` |
| Insert | `i a I A o O` |
| Edit | `x X s S D C r{ch} ~ J gJ >> << p P u Ctrl-R Ctrl-A Ctrl-X` |
| Operators | `d c y` + motion/text object; `dd cc yy`; `gu gU g~`; `> <` |
| Other | `gv` reselect last visual, `Enter` submit |

Counts work everywhere: `3w`, `2dd`, `d2f,`, `5~`, `10<C-a>`. `{count}gg` / `{count}G` jump to an absolute line. `cw`/`cW` behave like `ce`/`cE` (vim semantics), and a single `dw` on the last word of a line stays on that line.

The bottom editor border shows the mode, the pending operator/count (`3d…`, `g…`) and the cursor position (`12:4`).

### VISUAL / V-LINE mode

| Group | Keys |
|---|---|
| Extend | all NORMAL motions (with counts), `f F t T ; , %` |
| Modes | `o` swap anchor, `v` ↔ `V` |
| Edit | `d x y c s r{ch} u U ~ > < J p` |
| Lines | `D X Y C S` force whole-line operation |
| Other | `gv` (from NORMAL) reselect, `Esc` cancel |

The selection is drawn with a background color; the caret is the single reverse-video cell at the moving end, so it stays visible over the selection regardless of terminal cursor support.

### Text objects

`iw aw iW aW` · `i" a"` · `i' a'` · `` i` a` `` · `i( a(` `i[ a[` `i{ a{` (aliases `ib` `iB`). Counted word objects (`2iw`, `2aw`) work with `d`/`c` only (vim semantics); empty inner objects are safe — `di"` no-ops, `ci"` enters insert.

## Configuration

Optional `vimMode` key in `~/.pi/agent/settings.json` or project `.pi/settings.json`:

```json
{
  "vimMode": {
    "startMode": "normal",
    "enabled": true,
    "footerStatus": true,
    "selectionColor": "theme",
    "modeChange": {
      "insert": "im-select im.rime.inputmethod.Squirrel.Hans",
      "normal": "im-select com.apple.keylayout.ABC"
    }
  }
}
```

| Key | Default | Description |
|---|---|---|
| `vimMode.startMode` | `"insert"` | Mode for new prompts (and after submit): `"insert"` or `"normal"` |
| `vimMode.enabled` | `true` | `false` disables mounting entirely — the editor slot is left to other extensions (the `/vimmode on` command can still mount it later) |
| `vimMode.footerStatus` | `true` | Show the current mode in Pi's footer status area under the key `pi-vim-mode`; `false` hides it (the editor border label always shows the mode) |
| `vimMode.selectionColor` | `"theme"` | Visual-selection **background**. `"theme"` (default) uses Pi's `selectedBg` and **auto-adapts when you switch light/dark themes**; or a fixed background — a `#rrggbb` hex (e.g. `"#3d3d5c"`) or a 0-255 ANSI index (e.g. `"238"`). The selection is always a background color so the reverse-video caret stays distinct |
| `vimMode.modeChange.insert` | — | Shell command run on every transition **into** INSERT (IME on) |
| `vimMode.modeChange.normal` | — | Shell command run when leaving INSERT for a non-insert mode (IME off) |

## Commands

| Command | Action |
|---|---|
| `/vimmode` | Show status |
| `/vimmode on` | Mount the vim editor |
| `/vimmode off` | Restore Pi's default editor immediately |
| `/vimmode toggle` | Toggle |

## Architecture

```
index.ts          Extension entry: deferred editor mount, /vimmode command, IME hooks,
                  agent-busy tracking, pi-vim-mode:mode-change event-bus broadcast
vim-editor.ts     VimEditor (extends CustomEditor): input routing, rendering
                  (selection highlight, mode label), undo/redo, paste-registry
                  preservation
state.ts          Vim state machine (mode, counts, pending operators, registers)
motions.ts        Pure cursor-motion computations (word/WORD/char-find/bracket classes)
text-objects.ts   Pure text-object range computations
operators.ts      Pure range operations (delete/change/yank/case/indent/number)
highlight.ts      Pure selection-highlight rendering (word-wrap row mapping, ANSI-aware
                  cell highlighting, selection-style resolution)
modes/normal.ts   NORMAL-mode key handling
modes/visual.ts   VISUAL / V-LINE mode key handling
test/             Pure-function tests (node --test)
```

Design notes:

- **`CustomEditor` subclass** — app-level keybindings (Esc abort, `Ctrl+D` exit, model switching) keep working; INSERT mode delegates everything to the base editor.
- **Direct state writes** — cursor positioning and text rewrites touch the base editor's internal state (`state.lines` / `cursorLine` / `cursorCol` / `undoStack` / paste registry), following the approach validated by [pi-vim (burneikis)](https://github.com/burneikis/pi-vim) and [pi-vim (lajarre)](https://github.com/lajarre/pi-vim). Arrow-key emulation is wrong for absolute positioning because the base editor moves by *visual* (wrapped) rows.
- **Pure logic, thin shell** — motions, text objects and operators are pure functions over `(lines, cursor)`, unit-tested against real Neovim behavior; the editor shell only routes keys and applies results.
- **Register policy** — vim semantics: `y`, `c` and `d` (including `x X s D C`) all write the unnamed register; `p`/`P` paste from it.
- **Paste-registry preservation** — `setText` is overridden to snapshot and restore Pi's `[paste #N]` markers, so pasted content survives vim rewrites.
- **Single-owner editor slot** — Pi exposes one editor factory per session. Mounting is deferred to the next tick so this extension wins the slot deterministically regardless of load order.

## Integration with other extensions

### Mode events

Every mode transition is broadcast on Pi's extension event bus:

```ts
// In your own extension:
pi.events.on("pi-vim-mode:mode-change", (data) => {
  const { mode, previousMode } = data as { mode: string; previousMode: string };
  // mode: "insert" | "normal" | "visual" | "visual-line"
});
```

### Mode in the footer

With `vimMode.footerStatus` enabled (default), the current mode is published to Pi's footer status area under the key `pi-vim-mode` (`ctx.ui.setStatus("pi-vim-mode", ...)`). Other extensions can read or override it freely.

### Decorating the vim editor (render hooks)

Extensions that previously replaced the editor just to add rendering (a status line, an info row, a border tint) can keep that look without owning the editor slot. Register a render decorator on the `globalThis` interop registry before `session_start`; the vim editor applies all registered hooks to its rendered output:

```ts
// In your extension, at module top level (runs before session_start):
(globalThis as any).__piVimModeRenderHooks ??= [];

// After-render decoration (lines: [top border, ...content, bottom border, ...autocomplete]):
(globalThis as any).__piVimModeRenderHooks.push((lines, width, editor) => {
  // editor: the VimEditor instance (isShowingAutocomplete(), getMode() …)
  return lines; // return modified lines
});

// Or a two-phase decorator — border tinting MUST run before rendering,
// because Pi re-assigns editor.borderColor (thinking level / bash mode) on
// every frame:
(globalThis as any).__piVimModeRenderHooks.push({
  beforeRender: (editor) => { editor.borderColor = (s) => theme.fg("dim", s); },
  afterRender: (lines, width, editor) => lines,
});
```

This is an informal interop protocol — it works across extensions in the same Pi process regardless of load order (hooks are registered synchronously at load; the vim editor mounts one tick later and reads the registry). When the vim editor is disabled (`/vimmode off`) or absent, registered hooks are simply unused.

### Mode-aware decoration (border color per mode)

Hooks receive the live `VimEditor` instance, which exposes `getMode()` (and `isShowingAutocomplete()`). Because `beforeRender` runs on every frame, you can drive per-mode styling there:

```ts
(globalThis as any).__piVimModeRenderHooks ??= [];
(globalThis as any).__piVimModeRenderHooks.push({
  beforeRender: (editor) => {
    const colors = {
      insert: "borderMuted",
      normal: "borderAccent",
      visual: "customMessageLabel",
      "visual-line": "customMessageLabel",
    };
    editor.borderColor = (s) => theme.fg(colors[editor.getMode()] ?? "border", s);
  },
});
```

Use `beforeRender` for anything that must reflect the current mode **synchronously on every frame** (border colors, per-mode labels). Use the `pi-vim-mode:mode-change` event for one-shot reactions.

### Editor slot ownership

Pi exposes a **single** editor factory per session — the last extension to call `ctx.ui.setEditorComponent()` wins, and previous editors are destroyed. This extension mounts one tick after `session_start`, so it deterministically wins the slot over extensions that mount synchronously.

- If another extension's editor-side rendering disappears, that is the slot handover — its non-editor features (footer, widgets, events) are unaffected; convert its render work into a render hook to get it back.
- To leave the slot to another extension entirely, set `vimMode.enabled: false` (or `/vimmode off` at runtime).
- There is no supported way to compose two custom editors; Pi's API does not guarantee coexistence.

## Compatibility

- Requires a recent Pi with `CustomEditor` support and `@earendil-works/pi-tui` (tested against Pi ≥ 0.80).
- DECSCUSR cursor shapes (INSERT hardware bar) are best-effort; terminals without support fall back to Pi's software cursor.
- The internal-state dependency is stable across current Pi releases but is not a public API — Pi upgrades may require an update.

## Limitations

- **Undo granularity** — `u` delegates to Pi's native undo (one Pi edit step, not one vim change); `<C-r>` redo uses a linear mirror stack. No undo tree.
- **`jj` escape alias** — a 250 ms buffer window delays the `j` keypress in INSERT mode; pinyin double-pinyin input that types `jj` may trigger an accidental mode switch.
- **INSERT has no newline key** — `Enter` and `Ctrl+Enter` both submit (Pi-native). Multi-line input is done with `o` / `O` / `I` / `A` from NORMAL.
- **No search / marks / macros / visual-block / replace mode / EX command line** — intentionally out of scope; `%` bracket matching and `r{char}` are included.
- **Selection highlight is a background color** applied by render-time ANSI (`\x1b[48;**), distinct from the reverse-video caret. Row/column mapping mirrors pi-tui's word wrap, so wrapped lines, CJK characters and scrolled documents highlight accurately; only a grapheme wider than the whole editor (a paste marker in a very narrow window) is approximated.
- **Visual sub-mode switches (`v` ↔ `V`) bypass the status hooks** — footer status and `pi-vim-mode:mode-change` only fire on INSERT ↔ NORMAL ↔ VISUAL/V-LINE boundaries; toggling within visual emits nothing (the editor border label still updates).

## Development

```bash
# Type-check (requires typescript + @types/node)
npx tsc -p tsconfig.json

# Run the test suite (node >= 23.6 runs TS directly)
node --test test/*.test.ts
```

The suite (60 tests) covers motions, text objects, operators, mode handlers, selection-highlight rendering and config wiring, with expected values verified against real Neovim (`nvim --headless` probes).

## Acknowledgments

Inspired by and referencing the Pi extension ecosystem:

- Pi's official [`modal-editor.ts` example](https://github.com/earendil-works/pi) — the `CustomEditor` subclass pattern, insert-mode delegation, and border mode-label rendering.
- [pi-vim](https://github.com/burneikis/pi-vim) (burneikis) — writing the base editor's internal state for wrap-independent cursor positioning; `setText` paste-registry preservation; the render-time selection highlight algorithm with ANSI sequence handling.
- [pi-vim](https://github.com/lajarre/pi-vim) (lajarre) — IME mode-switch hooks; prompt state preserved around editor operations; Neovim-parity testing methodology for motions and text objects.
- [pi-vim-editor](https://github.com/annapurna-himal/pi-vim-editor) — `Ctrl+C`/`Ctrl+Enter` semantics and the lean single-file readability that this project mirrors in its mode files.
- [pi-vimmode](https://github.com/pekochan069/pi-vimmode) — word/WORD character classes, safe empty-range text objects, and autocomplete-aware `Esc` handling.

## License

MIT — see [LICENSE](LICENSE).
