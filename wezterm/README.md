# The WezTerm module

WezTerm does not show the pictures Claude Code sends, so there `holo` is drawn as `temper` unless WezTerm runs this module. With it, the mod leaves blank cells where the word goes and writes the word's frames to a file, and the module, inside WezTerm, places the running frame over those cells; Claude Code's own output stays as it is. The module is tested with WezTerm 20240203 and with nightly builds.

## Set up

With the mod installed, run `/spinner holo` in WezTerm and ask Claude to set the module up: the reply tells Claude where the file is. By hand:

1. Copy `rainbow-spinner.lua` from this folder next to your `wezterm.lua`.
2. In `wezterm.lua`, before `return config`:

   ```lua
   dofile(wezterm.config_dir .. '/rainbow-spinner.lua').apply(config)
   ```

3. In a WezTerm pane opened after that, start Claude Code and run `/spinner holo`: the reply is `rainbow-spinner: spinner: holo`.

Taking the line out of `wezterm.lua` again stops the module only when WezTerm restarts; a reload leaves it running.

`apply` tells the programs WezTerm starts where the module's folder is, `~/.cache/rainbow-spinner/wezterm`, and on Windows passes the folder and the pane into WSL through `WSLENV`. The folder keeps one PNG for each of a pane's last two words (16–20 KB a letter), and two small files for each pane. Another folder goes in as `apply(config, { dir = '/some/folder' })`; it must not be the folder of `wezterm.lua` or one directly inside it, because WezTerm reloads its config when files are created there.

## Cost

CPU the module adds while Claude works, in per cent of one core, over the line drawn as `temper`:

| | Claude Code | WezTerm |
|---|---|---|
| macOS (Apple M-series) | 7–8 | 5–6 |
| Windows (WSL pane) | 5 | up to 6 |

While no line is drawn, the module looks into its folder every half second, which costs WezTerm 0.1–0.2% of a core.

## Limits

- The word's cells hold blank braille (U+2800), so text copied from the spinner line has those in place of the word.
- A word is text for about half a second before its picture comes.
- Each time Claude Code redraws the line's row, as when the line moves or the rows above it change, the word can go blank for a moment: on macOS for 33–100 ms, 1–3% of the time.
- Two WezTerm processes number their panes alike, so on one folder each can draw the other's word: run one process.
