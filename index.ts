/**
 * index.ts — pi-vim-mode extension entry point.
 *
 * Mounts the VimEditor on session_start (deferred to the next tick so it wins
 * the single editor slot regardless of extension load order), provides
 * `/vimmode on|off|toggle|status`, IME mode-change hooks, agent-busy tracking
 * and a `pi-vim-mode:mode-change` event-bus broadcast.
 *
 * Optional settings (settings.json, global or project):
 * ```json
 * { "vimMode": {
 *     "startMode": "normal",            // "insert" (default) | "normal"
 *     "modeChange": {
 *       "insert": "im-select im.rime.inputmethod.Squirrel.Hans",
 *       "normal": "im-select com.apple.keylayout.ABC"
 *     }
 * } }
 * ```
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VimEditor, type VimEditorOptions } from "./vim-editor.ts";
import type { VimMode } from "./state.ts";

interface VimModeConfig {
  startMode?: "insert" | "normal";
  modeChange?: { insert?: string; normal?: string; query?: string };
  /** Mount the vim editor at all (default true). */
  enabled?: boolean;
  /** Show the current mode in Pi's footer status area (default true). */
  footerStatus?: boolean;
  /** Visual-selection background: "theme" (default), a #rrggbb hex, or a 0-255 index. */
  selectionColor?: string;
  /**
   * Insert-mode exit sequences (e.g. jj), off by default:
   * `{ "enabled": true, "timeout": 250, "keys": ["jj"] }`
   */
  insertExit?: { enabled?: boolean; timeout?: number; keys?: string[] };
}

function loadConfig(): VimModeConfig {
  const cfg: VimModeConfig = {};
  const files = [
    path.join(os.homedir(), ".pi", "agent", "settings.json"),
    path.join(process.cwd(), ".pi", "settings.json"),
  ];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { vimMode?: VimModeConfig };
      if (!parsed.vimMode) continue;
      if (parsed.vimMode.startMode === "normal") cfg.startMode = "normal";
      if (parsed.vimMode.modeChange?.insert || parsed.vimMode.modeChange?.normal || parsed.vimMode.modeChange?.query) {
        cfg.modeChange = {
          insert: parsed.vimMode.modeChange?.insert,
          normal: parsed.vimMode.modeChange?.normal,
          query: parsed.vimMode.modeChange?.query,
        };
      }
      if (typeof parsed.vimMode.enabled === "boolean") cfg.enabled = parsed.vimMode.enabled;
      if (typeof parsed.vimMode.footerStatus === "boolean") {
        cfg.footerStatus = parsed.vimMode.footerStatus;
      }
      if (typeof parsed.vimMode.selectionColor === "string") {
        cfg.selectionColor = parsed.vimMode.selectionColor;
      }
      if (parsed.vimMode.insertExit && typeof parsed.vimMode.insertExit === "object") {
        const ie = parsed.vimMode.insertExit;
        cfg.insertExit = {
          enabled: ie.enabled === true,
          timeout: typeof ie.timeout === "number" ? ie.timeout : undefined,
          keys: Array.isArray(ie.keys) ? ie.keys : undefined,
        };
      }
    } catch {
      // Ignore malformed settings files.
    }
  }
  return cfg;
}

function runHook(command: string | undefined): void {
  if (!command) return;
  try {
    exec(command, { timeout: 3000 }, () => {
      /* fire and forget; failures are silenced */
    });
  } catch {
    // Ignore.
  }
}

/**
 * Interop protocol: other extensions (e.g. a custom editor UI tweak) can
 * register render decorators here BEFORE session_start (synchronously), and
 * they are applied to the vim editor's rendered output. Each entry is either
 * a function `(lines, width, editor) => lines` (after-render decoration) or
 * an object `{ beforeRender?, afterRender? }`.
 *
 * ```ts
 * // In another extension, at module top level:
 * (globalThis as any).__piVimModeRenderHooks ??= [];
 * (globalThis as any).__piVimModeRenderHooks.push((lines, width, editor) => lines);
 * // or:
 * (globalThis as any).__piVimModeRenderHooks.push({
 *   beforeRender: (editor) => { editor.borderColor = (s) => "..."; },
 *   afterRender: (lines, width, editor) => lines,
 * });
 * ```
 *
 * `beforeRender` runs before the base editor renders — Pi reassigns
 * `editor.borderColor` (thinking level / bash mode) on every frame, so border
 * tinting must happen there to take effect on the same frame.
 */
type RenderHookEntry =
  | ((lines: string[], width: number, editor: VimEditor) => string[])
  | {
      beforeRender?: (editor: VimEditor) => void;
      afterRender?: (lines: string[], width: number, editor: VimEditor) => string[];
    };

function collectRenderHooks(): VimEditorOptions["renderHook"] | undefined {
  const hooks = (globalThis as { __piVimModeRenderHooks?: RenderHookEntry[] }).__piVimModeRenderHooks;
  if (!hooks || hooks.length === 0) return undefined;
  const before: Array<(editor: VimEditor) => void> = [];
  const after: Array<(lines: string[], width: number, editor: VimEditor) => string[]> = [];
  for (const hook of hooks) {
    if (typeof hook === "function") {
      after.push(hook);
    } else {
      if (hook.beforeRender) before.push(hook.beforeRender);
      if (hook.afterRender) after.push(hook.afterRender);
    }
  }
  return {
    beforeRender: before.length > 0
      ? (editor) => { for (const h of before) h(editor); }
      : undefined,
    afterRender: after.length > 0
      ? (lines, width, editor) => {
          let out = lines;
          for (const h of after) out = h(out, width, editor);
          return out;
        }
      : undefined,
  };
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  let busy = false;
  let enabled = true;
  let editor: VimEditor | undefined;
  let sessionCtx: ExtensionContext | undefined;

  // --- Agent busy tracking (Ctrl+C means interrupt while busy). ---
  pi.on("agent_start", () => {
    busy = true;
  });
  pi.on("agent_end", () => {
    busy = false;
  });

  // --- Mode-change hook: IME switching + event-bus broadcast. ---
  // With `modeChange.query`, the IME state when leaving INSERT is remembered
  // and restored on the next entry: entering INSERT only runs the insert
  // command if the IME was active (or never recorded); otherwise it stays off.
  // Without a query command, behavior is the plain forced one (always run).
  let imActive: boolean | undefined;
  const onModeChange = (mode: VimMode, previousMode: VimMode): void => {
    const mc = config.modeChange;
    if (mode === "insert") {
      if (imActive !== false) runHook(mc?.insert);
    } else if (previousMode === "insert") {
      if (mc?.query) {
        try {
          exec(mc.query, { timeout: 1000 }, (_err, stdout) => {
            // fcitx5-remote prints the state to stdout: 1 = inactive, 2 = active.
            imActive = String(stdout ?? "").trim() === "2";
          });
        } catch {
          // Ignore.
        }
      }
      runHook(mc?.normal);
    }
    pi.events.emit("pi-vim-mode:mode-change", { mode, previousMode });
  };

  const editorOptions = (): VimEditorOptions => ({
    startMode: config.startMode ?? "insert",
    isAgentBusy: () => busy,
    onModeChange,
    selectionColor: config.selectionColor,
    insertExit: config.insertExit,
    themeColor: (name) => {
      // Resolve a named theme color (pi's `getBgAnsi` returns an ANSI sequence
      // for the *active* theme, so it auto-adapts when you switch themes).
      try {
        const theme = (sessionCtx?.ui as unknown as { theme?: unknown })?.theme as
          | { getBgAnsi?: (name: string) => string }
          | undefined;
        return theme?.getBgAnsi?.(name);
      } catch {
        return undefined;
      }
    },
    renderHook: collectRenderHooks(),
    // Expose the current mode in Pi's footer status area (configurable).
    statusFn: config.footerStatus === false
      ? undefined
      : (mode) => {
          try {
            sessionCtx?.ui.setStatus("pi-vim-mode", mode === null ? undefined : mode.toUpperCase());
          } catch {
            // Ignore.
          }
        },
  });

  pi.on("session_start", (_event, ctx) => {
    sessionCtx = ctx;

    // Defer mounting to the next tick so we win the single editor slot even
    // when another extension (e.g. ui.ts) sets its editor synchronously.
    setTimeout(() => {
      if (ctx.mode !== "tui") return;
      if (config.enabled === false) {
        // vimMode.enabled: false — do not mount; keep the event hooks alive.
        return;
      }
      if (!enabled) return;
      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        editor = new VimEditor(tui, theme, keybindings, editorOptions());
        return editor;
      });
    }, 0);
  });

  // --- /vimmode on|off|toggle|status ---
  pi.registerCommand("vimmode", {
    description: "Vim mode: on/off/toggle/status",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
      const mount = (): void => {
        ctx.ui.setEditorComponent((tui, theme, keybindings) => {
          editor = new VimEditor(tui, theme, keybindings, editorOptions());
          return editor;
        });
      };
      const setEnabled = (value: boolean): void => {
        enabled = value;
        if (ctx.hasUI) {
          if (value) mount();
          else {
            ctx.ui.setEditorComponent(undefined);
            try {
              ctx.ui.setStatus("pi-vim-mode", undefined);
            } catch {
              // Ignore.
            }
          }
        }
        ctx.ui.notify(value ? "vim mode on" : "vim mode off (default editor restored)", "info");
      };

      switch (arg) {
        case "on":
          setEnabled(true);
          break;
        case "off":
          setEnabled(false);
          break;
        case "toggle":
          setEnabled(!enabled);
          break;
        case "status":
        case "":
          ctx.ui.notify(enabled ? "vim mode: on" : "vim mode: off", "info");
          break;
        default:
          ctx.ui.notify("Usage: /vimmode [on|off|toggle|status]", "warning");
          break;
      }
    },
  });
}
