"""Plays back the bytes Claude wrote to kitty (kitty --dump-bytes) into a kitty window.

The stream is cut at the end of each synchronized update (ESC[?2026l), and
the pieces go out FRAME_MS apart, so the terminal sees the same commands in
the same order as from Claude, without Claude. Optional edits to the stream
tell which part of it matters:

    python3 replay_bytes.py BYTES [FRAME_MS] [--no-sync] [--no-blit]

  --no-sync   drop the synchronized-update brackets (ESC[?2026h / l)
  --no-blit   drop every kitty graphics command after the first picture
"""

import re
import sys
import time

path = sys.argv[1]
frame_ms = float(next((a for a in sys.argv[2:] if not a.startswith("--")), "40"))
data = open(path, "rb").read()
# Kitty answers queries: the replay must not ask anything Claude asked.
data = re.sub(rb"\x1b\[[>?]?[0-9;]*[cn]|\x1b\[>0q|\x1b\[\?u|\x1b\[16t|\x1b\[\?[0-9]+\$p|\x1b_Gi=31,[^\x1b]*\x1b\\", b"", data)
if "--no-sync" in sys.argv:
    data = data.replace(b"\x1b[?2026h", b"").replace(b"\x1b[?2026l", b"")
if "--no-blit" in sys.argv:
    first = data.find(b"m=0")
    head, tail = data[: first + 3], data[first + 3 :]
    data = head + re.sub(rb"\x1b_G[^\x1b]*\x1b\\", b"", tail)
pieces = re.split(rb"(?<=\x1b\[\?2026l)", data) if "--no-sync" not in sys.argv else [data[i : i + 4096] for i in range(0, len(data), 4096)]
out = sys.stdout.buffer
for p in pieces:
    out.write(p)
    out.flush()
    time.sleep(frame_ms / 1000)
time.sleep(3)
