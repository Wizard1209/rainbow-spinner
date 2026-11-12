#!/bin/bash
# What kitty or iTerm2 really shows of the spinner line, and what it costs.
# Each arm gets a window of its own (kitty: an instance of its own in the
# background; it-* arms: a new iTerm2 window) and one turn in it: /spinner
# <style>, one prompt that thinks and then streams, the window recorded several
# times a second; every step waits on what the screen shows. Every shot is
# sorted (word: picture / alt / text / blank; glyph; phase) into each arm's
# report.txt, sheet.png and line.gif, and the run prints one row per arm: the
# /spinner reply, picture and glyph shares, CPU.
# *-bg arms open another tab over Claude's once the prompt is sent. The style
# kept in the store is put back.
#
#   bench/live-probe.sh smoke               # holo bloom temper, kitty, 12 s of thinking each
#   bench/live-probe.sh full                # every kitty arm, whole turns
#   bench/live-probe.sh holo holo-fs        # arms by name
#   bench/live-probe.sh iterm               # the it-* arms (iTerm2 must not be in front)
#   bench/live-probe.sh swap                # kitty alone, no Claude
#   PROBE_OUT=/some/dir PROBE_MOD=/other/build bench/live-probe.sh temper
#   PROBE_CLAUDE_ARGS='--permission-mode default' bench/live-probe.sh holo   # extra arguments for Claude
#
# --capture thinking|turn overrides how long each turn is recorded; --reuse
# runs arms that start alike as turns of one window (/clear between): faster,
# but a later turn's CPU is lower than a first turn's, so for the screen only.
# Other windows (extra env, unset vars, several styles in one): bench/live_probe.py run -h
# Results go to $PROBE_OUT (default $TMPDIR/rainbow-probe), a folder per window, one inside it per arm.
set -u
here=$(cd "$(dirname "$0")" && pwd)
probe=(uv run --quiet "$here/live_probe.py")
if [ $# -eq 0 ]; then
  sed -n '2,24p' "$here/live-probe.sh"
  "${probe[@]}" arms -h | awk '/^positional/{p=1} /^options/{p=0} p'
  exit 1
fi
[ "$1" = swap ] && exec "${probe[@]}" swap
exec "${probe[@]}" arms "$@"
