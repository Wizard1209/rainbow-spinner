# bench

Live measurements of the spinner line in real terminal windows: what the terminal shows of it, frame by frame, and what it costs in CPU.

## Requirements

- macOS: terminal windows are driven with `kitten @` (kitty) and `osascript` (iTerm2) and shot with `screencapture`.
- kitty in `/Applications`. iTerm2 only for the runs that use it.
- Screen Recording permission for the terminal the scripts are started from.
- [uv](https://docs.astral.sh/uv/) and a signed-in Claude Code.

## live-probe.sh

An arm is one way of starting Claude, in a window of its own: a style, the main screen or fullscreen mode, a tab opened over Claude's. The arm picks its style with `/spinner`, sends one prompt that thinks and then streams, and records the window several times a second, together with the screen as text and every byte Claude writes to the terminal.

```sh
bench/live-probe.sh smoke          # holo, bloom, temper in kitty, 12 s of thinking each
bench/live-probe.sh full           # every kitty arm, whole turns
bench/live-probe.sh iterm          # every iTerm2 arm; waits while iTerm2 is in front
bench/live-probe.sh holo holo-fs   # arms by name
bench/live-probe.sh swap           # kitty alone, without Claude
```

The run prints one row per arm: the `/spinner` reply, the share of shots with the word's picture and with the glyph drawn, and the CPU of Claude and of the terminal. An arm that fails prints `FAILED` with the reason, the other arms still run, and the run exits with 1.

Each arm's folder holds `report.txt`, `sheet.png`, `line.gif` and `reply.png`. `bench/live-probe.sh` without arguments lists the arms and options. `uv run bench/live_probe.py -h` describes every recorded file, and its `run` subcommand starts a window with an environment and styles of your choice.

- `kitty_swap.py` is what `swap` runs: it draws a picture in kitty and swaps its pixels in four ways, a row for each.
- `replay_bytes.py` is what `uv run bench/live_probe.py replay` runs: it plays recorded bytes back into kitty, without Claude.

| Variable | Sets |
|---|---|
| `PROBE_OUT` | where results go (default `$TMPDIR/rainbow-probe`) |
| `PROBE_MOD` | the mod folder to load, in place of this repository |
| `PROBE_CWD` | the folder Claude starts in, one it already trusts (default: the folder above the mod) |
| `PROBE_CLAUDE_ARGS` | extra arguments for Claude |

## cpu.sh

```sh
bench/cpu.sh 3 vanilla=- off=. temper=.:temper bloom=.:bloom   # repetitions, then label=plugin-dir[:style]
```

Opens a kitty window per arm and reads the CPU seconds Claude and kitty spend over 20 s of spinner (`WINDOW` sets the seconds). Its windows can take the keyboard focus, so do not type while it runs.

Both scripts put the style kept in the mod's store back when they finish.
