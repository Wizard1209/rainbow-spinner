"""How kitty shows a picture whose pixels are swapped under unicode placeholders.

Runs inside a kitty window, without Claude. Draws a 7x1-cell picture the way
Claude Code draws an Image (a=T,U=1, the image id in the placeholders'
colour), then swaps its pixels every 40 ms, SECONDS per method, one row each.
Nothing else is written to a picture's row while it runs.

  T          a=T,U=1 again under the same id, all chunks at once
  T-slow     the same, the chunks spread over SPREAD_MS (as Claude Code's
             blits reach kitty: 30 chunks over ~135 ms)
  ids-slow   two ids in turn: the next frame goes, as slowly, to the id not
             on screen, then the placeholders are rewritten in its colour
  frame-slow a=f,r=1: the first frame's pixels edited in place, as slowly

The top line says which method runs ("running T-slow"), then "done".

    python3 kitty_swap.py [SECONDS] [SPREAD_MS] [LINGER_S]
"""

import base64
import math
import sys
import time

W, H, COLS = 175, 48, 7
DIAC = [0x0305, 0x030D, 0x030E, 0x0310, 0x0312, 0x033D, 0x033E, 0x033F]
NAMES = ["T", "T-slow", "ids-slow", "frame-slow"]
SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 else 3.0
SPREAD_MS = float(sys.argv[2]) if len(sys.argv) > 2 else 135.0
LINGER_S = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0
out = sys.stdout


def apc(ctrl: str, payload: bytes, spread_ms: float = 0.0) -> None:
    data = base64.b64encode(payload).decode()
    chunks = [data[i : i + 4096] for i in range(0, len(data), 4096)]
    for k, c in enumerate(chunks):
        more = 0 if k == len(chunks) - 1 else 1
        head = f"{ctrl},m={more}" if k == 0 else f"m={more},q=2"
        out.write(f"\x1b_G{head};{c}\x1b\\")
        if spread_ms:
            out.flush()
            time.sleep(spread_ms / 1000 / len(chunks))


def pixels(phase: float) -> bytes:
    """A bright hue ramp that moves with phase: never the background."""
    row = bytearray()
    for x in range(W):
        h = 6.283 * ((x / W + phase) % 1.0)
        row += bytes((int(127 + 127 * math.cos(h)), int(127 + 127 * math.cos(h - 2.094)), int(127 + 127 * math.cos(h - 4.189)), 255))
    return bytes(row) * H


def placeholders(iid: int) -> str:
    r, g, b = (iid >> 16) & 255, (iid >> 8) & 255, iid & 255
    cells = "".join("\U0010eeee" + chr(DIAC[0]) + chr(DIAC[k]) for k in range(COLS))
    return f"\x1b[38;2;{r};{g};{b}m{cells}\x1b[39m"


def at(row: int, col: int) -> str:
    return f"\x1b[{row};{col}H"


def place(iid: int, phase: float, spread_ms: float = 0.0) -> None:
    apc(f"a=T,U=1,q=2,f=32,s={W},v={H},i={iid},c={COLS},r=1", pixels(phase), spread_ms)


def run(name: str, row: int) -> None:
    iid = 0x10 + row
    spare = iid + 0x40
    out.write(at(row, 1) + f"{name:<11}")
    place(iid, 0.0)
    out.write(at(row, 12) + placeholders(iid))
    out.flush()
    shown = iid
    end = time.time() + SECONDS
    k = 0
    while time.time() < end:
        k += 1
        phase = k * 0.03
        if name == "T":
            place(iid, phase)
        elif name == "T-slow":
            place(iid, phase, SPREAD_MS)
        elif name == "ids-slow":
            nxt = spare if shown == iid else iid
            place(nxt, phase, SPREAD_MS)
            out.write(at(row, 12) + placeholders(nxt))
            shown = nxt
        elif name == "frame-slow":
            apc(f"a=f,r=1,q=2,f=32,s={W},v={H},i={iid}", pixels(phase), SPREAD_MS)
        # the frame count on the row below: the picture's row stays untouched
        out.write(at(row + 1, 12) + f"frame {k:4d}")
        out.flush()
        time.sleep(0.04)


out.write("\x1b[2J")
for i, name in enumerate(NAMES):
    out.write(at(1, 1) + f"running {name}        ")
    run(name, 3 + 2 * i)
out.write(at(1, 1) + "done               ")
out.flush()
time.sleep(LINGER_S)
