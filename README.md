# pi-vim-mode

Vim-style modal editing for the [Pi](https://pi.dev) prompt editor — INSERT / NORMAL / VISUAL / V-LINE modes, motions, operators, text objects, registers, IME-friendly mode switching, and theme-aware selection highlighting. Everything happens in place; your draft is never interrupted.

> Requires Pi ≥ 0.80 (with `CustomEditor` support and `@earendil-works/pi-tui`).

## Features

- **Modal editing** — INSERT / NORMAL / VISUAL / V-LINE, live mode indicator (mode, pending operator, cursor position) on the editor border
- **Vim register semantics** — `y`, `c` and `d` (incl. `x X s D C`) write the unnamed register; `p`/`P` paste from it
- **Visual selection** — theme background highlight (auto-adapts light/dark), `o` anchor swap, `gv` reselect
- **Pi-native INSERT** — autocomplete, paste, images, external editor keep working; `Esc` closes autocomplete first; `Ctrl+C` interrupts a running agent but enters NORMAL when idle
- **IME switching (fcitx5)** — built-in, auto-detected: the input method activates in INSERT and deactivates outside it, remembering the last state across INSERT exits
- **Paste safety** — `[paste #N]` markers survive vim edits; `/vimmode off` restores the default editor

## Install

```bash
git clone https://github.com/XXiaoA/pi-vim-mode ~/.pi/agent/extensions/vim-mode
```

The directory name (`vim-mode`) is an abbreviation of the plugin name; Pi discovers the extension by the `index.ts` inside it, not by the directory name. Then `/reload` in Pi (or restart) and verify with `/vimmode status`.

## Quick start

```text
Type normally…                    # INSERT mode (Pi-native input)
Esc (or Ctrl+[)                   # → NORMAL
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
| INSERT | (start) `i a I A o O`, after `c`/`s`/`C`/`S` | Pi-native: autocomplete, paste, image, external editor. `Enter` / `Ctrl+Enter` submits, `Shift+Enter` newline. `Esc` / `Ctrl+[` / `Ctrl+C` (idle) → NORMAL |
| NORMAL | `Esc`, `Ctrl+[`, `Ctrl+C` (idle) | `Enter` / `Ctrl+Enter` submits the prompt |
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
| Other | `gv` reselect last visual, `↑`/`↓` history navigation (like INSERT), `Enter` submit |

Counts work everywhere: `3w`, `2dd`, `d2f,`, `5~`, `10<C-a>`. `{count}gg` / `{count}G` jump to an absolute line. `cw`/`cW` behave like `ce`/`cE` (vim semantics), and a single `dw` on the last word of a line stays on that line.

### VISUAL / V-LINE mode

| Group | Keys |
|---|---|
| Extend | all NORMAL motions (with counts), `f F t T ; , %` |
| Modes | `o` swap anchor, `v` ↔ `V` |
| Edit | `d x y c s r{ch} u U ~ > < J p` |
| Lines | `D X Y C S` force whole-line operation |
| Other | `gv` (from NORMAL) reselect, `Esc` cancel |

### Text objects

`iw aw iW aW` · `i" a"` · `i' a'` · `` i` a` `` · `i( a(` `i[ a[` `i{ a{` (aliases `ib` `iB`). Counted word objects (`2iw`, `2aw`) work with `d`/`c` only (vim semantics); empty inner objects are safe — `di"` no-ops, `ci"` enters insert.

## Configuration

Optional `vimMode` key in `~/.pi/agent/settings.json` or project `.pi/settings.json`. Example (a sample, not the defaults — see the table below):

```json
{
  "vimMode": {
    "startMode": "normal",
    "insertExit": { "enabled": true, "timeout": 250, "keys": ["jj"] }
  }
}
```

IME switching needs no configuration: when `fcitx5-remote` is detected on PATH, the input method is activated on entering INSERT and deactivated on leaving, remembering the last state (a manual switch to English inside INSERT is restored on the next entry).

| Key | Default | Description |
|---|---|---|
| `vimMode.startMode` | `"insert"` | Mode for new prompts (and after submit): `"insert"` or `"normal"` |
| `vimMode.enabled` | `true` | `false` leaves the editor slot to other extensions (the `/vimmode on` command can still mount it later) |
| `vimMode.footerStatus` | `true` | Show the current mode in Pi's footer status area under the key `pi-vim-mode` |
| `vimMode.selectionColor` | `"theme"` | Visual-selection **background**: `"theme"` (Pi's `selectedBg`, auto-adapts light/dark), a `#rrggbb` hex, or a 0-255 ANSI index |
| `vimMode.ime` | `true` | Built-in fcitx5 IME switching: activates the input method in INSERT, deactivates outside it, remembering the last state; no effect when `fcitx5-remote` is not on PATH |
| `vimMode.insertExit.enabled` | `false` | Enable insert-mode exit sequences (e.g. `jj`): typing a sequence in INSERT leaves to NORMAL |
| `vimMode.insertExit.timeout` | `250` | Buffer window (ms) between sequence keys; a lone first key is inserted after it times out |
| `vimMode.insertExit.keys` | `["jj"]` | Exit sequences, each 2+ chars; any number allowed (e.g. `["jj", "jk"]`) |

IME switching (fcitx5) is built in and needs no configuration; it is active whenever `fcitx5-remote` is on PATH, and can be turned off with `vimMode.ime: false`.

## Commands

| Command | Action |
|---|---|
| `/vimmode` | Show status |
| `/vimmode on` | Mount the vim editor |
| `/vimmode off` | Restore Pi's default editor immediately |
| `/vimmode toggle` | Toggle |

## Integration with other extensions

### Mode events

Every mode transition is broadcast on Pi's extension event bus:

```ts
pi.events.on("pi-vim-mode:mode-change", (data) => {
  const { mode, previousMode } = data as { mode: string; previousMode: string };
  // mode: "insert" | "normal" | "visual" | "visual-line"
});
```

With `vimMode.footerStatus` enabled (default), the mode is also published to Pi's footer status area under the key `pi-vim-mode` (`ctx.ui.setStatus("pi-vim-mode", ...)`).

### Render hooks

Extensions that previously replaced the editor just to add rendering (a status line, a border tint) can keep that look without owning the editor slot. Register a decorator on the `globalThis` interop registry at module top level (before `session_start`); the vim editor applies all registered hooks to its rendered output:

```ts
(globalThis as any).__piVimModeRenderHooks ??= [];
(globalThis as any).__piVimModeRenderHooks.push({
  // Must run before rendering: Pi re-assigns editor.borderColor on every frame.
  beforeRender: (editor) => {
    const colors = { insert: "borderMuted", normal: "borderAccent", visual: "customMessageLabel", "visual-line": "customMessageLabel" };
    editor.borderColor = (s) => theme.fg(colors[editor.getMode()] ?? "border", s);
  },
  // lines: [top border, ...content, bottom border, ...autocomplete]
  afterRender: (lines, width, editor) => lines,
});
```

Hooks run regardless of extension load order (registered synchronously at load; the vim editor mounts one tick later). When the vim editor is disabled or absent, hooks are simply unused.

### Editor slot ownership

Pi exposes a **single** editor factory per session — the last extension to call `ctx.ui.setEditorComponent()` wins. This extension mounts one tick after `session_start`, so it wins deterministically over extensions that mount synchronously; if another extension's editor-side rendering disappears, that is the slot handover (its non-editor features are unaffected — convert its render work into a render hook). To leave the slot to another extension entirely, set `vimMode.enabled: false` (or `/vimmode off`).

## Development

```bash
npx tsc -p tsconfig.json       # type-check
node --test test/*.test.ts     # run the suite (60 tests; expected values verified against nvim --headless)
```

## Acknowledgments

Inspired by and referencing the Pi extension ecosystem (all MIT):

- Pi's official [`modal-editor.ts` example](https://github.com/earendil-works/pi) — the `CustomEditor` subclass pattern, insert-mode delegation, and border mode-label rendering.
- [pi-vim](https://github.com/burneikis/pi-vim) (burneikis) — writing the base editor's internal state for wrap-independent cursor positioning; `setText` paste-registry preservation; the render-time selection highlight algorithm with ANSI sequence handling.
- [pi-vim](https://github.com/lajarre/pi-vim) (lajarre) — IME mode-switch hooks; prompt state preserved around editor operations; Neovim-parity testing methodology for motions and text objects.
- [pi-vim-editor](https://github.com/annapurna-himal/pi-vim-editor) — `Ctrl+C`/`Ctrl+Enter` semantics and the lean single-file readability that this project mirrors in its mode files.
- [pi-vimmode](https://github.com/pekochan069/pi-vimmode) — word/WORD character classes, safe empty-range text objects, and autocomplete-aware `Esc` handling.

## License

MIT — see [LICENSE](LICENSE).
