# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10", "numpy>=1.26"]
# ///
"""Live probe of the spinner line in kitty or iTerm2: what the terminal really
shows, and what it costs.

A series = one window of its own (kitty: an instance of its own started in the
background; iTerm2, --term iterm: a new window, made only while iTerm2 is not
in front), focus handed back to the app that had it, one Claude session in it.
Each turn of the series picks a style with /spinner, sends one prompt that
thinks and then streams, and records the window; /clear separates the turns,
so the model sees each one as a first turn. Every step waits on what is on
the screen (prompt ready, the text typed, the /spinner reply, thinking, the
answer), not on fixed sleeps. `arms` gives each arm a window of its own,
because Claude itself costs less on each later turn of a session (and a
covered turn after another one finds it told it lost focus); --reuse puts arms
that start alike into one window, for checks of the screen only.

  --capture thinking   records until thinking has run --window seconds (or the
                       answer starts), then interrupts the turn with Esc
  --capture turn       records the whole turn, till 3 s after it ends

A turn records, in its own folder:

  shots/NNNN-<ms>.png  the window, several times a second (screencapture -l)
  text.jsonl           the screen as text with colours (kitten @ get-text --ansi)
  cpu.jsonl            CPU seconds of Claude and the terminal, once a second
                       (iTerm2's is the whole app, the user's windows too)
  reply.txt, reply.png the rows of the /spinner echo and its reply (or what
                       is drawn in its place), as text and as a crop of a shot

and the series folder holds what the window writes over all its turns:

  bytes.bin            every byte Claude wrote to kitty (--dump-bytes); each
                       turn keeps its byte range in turn.json
  kitty.log            what kitty parsed (--dump-commands), each line stamped
                       with the time it arrived; single-chunk graphics
                       commands are missing from it, bytes.bin has them all
  debug.log            Claude's --debug-file
  env.txt              the environment Claude started with (values of unrelated names hidden)

then each turn's shots are sorted (word: picture / alt / text / blank; glyph
drawn or not; phase thinking / streaming / done) into report.txt,
report.json, frames.json, sheet.png and line.gif, and the series writes
summary.txt, one row per turn. Besides the shots it measures, while thinking,
how long one picture takes to reach kitty and for what share of the time kitty
holds a whole one.

    uv run bench/live_probe.py arms smoke                   # named arms, or the sets smoke / full / iterm
    uv run bench/live_probe.py run x --styles holo,bloom --env TERM_PROGRAM=iTerm.app --unset KITTY_WINDOW_ID
    uv run bench/live_probe.py run vanilla --vanilla --render fullscreen
    uv run bench/live_probe.py replay again <series dir>/bytes.bin   # kitty alone, Claude's bytes
    uv run bench/live_probe.py swap                                  # kitty alone, kitty_swap.py
    uv run bench/live_probe.py analyse <turn dir>

Nothing is typed anywhere but into the series' own window, through its own
remote-control socket (iTerm2: its own session). The style the mod keeps in its
store is put back after every series, as it was before.
"""

from __future__ import annotations

import argparse
import colorsys
import glob
import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path

KITTY_APP = "/Applications/kitty.app"
KITTEN = f"{KITTY_APP}/Contents/MacOS/kitten"
HERE = Path(__file__).resolve().parent.parent
MOD = Path(os.environ.get("PROBE_MOD") or HERE)
# A folder Claude already trusts: in the mod's own folder the trust dialog
# comes up, and a keystroke into it ends Claude.
TRUSTED = Path(os.environ.get("PROBE_CWD") or MOD.parent)
STORE = Path.home() / ".claude/plugins/store"
# The key the mod keeps the /spinner choice under.
CHOICE_KEYS = ("style",)
CLAUDE = shutil.which("claude", path=f"{Path.home()}/.local/bin:/usr/local/bin:/opt/homebrew/bin") or "claude"
PROMPT = (
    "Think very carefully and at length about the structure first, then write a "
    "900-word story about a lighthouse keeper. No tools."
)
PROMPT_TAIL = "No tools."
COLS, LINES = 100, 30
PLACEHOLDER = "\U0010eeee"


# ---------------------------------------------------------------- what is asked


@dataclass(frozen=True)
class Launch:
    """What one window starts Claude with: every turn of a series shares it."""

    term: str = "kitty"  # kitty | iterm
    # normal: main screen forced through the env; main: main screen by
    # --settings tui=default, nothing forced; fullscreen; settings: settings.json's
    render: str = "normal"
    vanilla: bool = False  # no mod at all
    env: tuple[str, ...] = ()  # K=V set for Claude
    unset: tuple[str, ...] = ()  # names removed from Claude's environment; NAME* = every name it starts
    model: str = "haiku"


@dataclass
class Turn:
    label: str
    style: str | None = None  # the /spinner tag; None: no /spinner
    fresh: bool = False  # the choice is taken out of the mod's store first: the mod draws its default, off
    background: str = "none"  # none | tab | minimise: once the prompt is sent
    capture: str = "turn"  # turn | thinking
    window: float = 12.0  # thinking: seconds of thinking recorded
    seconds: float = 60.0  # the longest recording
    prompt: str = PROMPT


N, FS = Launch(), Launch(render="fullscreen")
NOID = ("KITTY_WINDOW_ID",)
# arm -> how its window starts, and its turn. Arms that start alike share a window.
ARMS: dict[str, tuple[Launch, dict]] = {
    "holo": (N, {"style": "holo"}),
    "bloom": (N, {"style": "bloom"}),
    "temper": (N, {"style": "temper"}),
    "holo-bg": (N, {"style": "holo", "background": "tab"}),
    "temper-bg": (N, {"style": "temper", "background": "tab"}),
    "holo-fs": (FS, {"style": "holo"}),
    "bloom-fs": (FS, {"style": "bloom"}),
    "temper-fs": (FS, {"style": "temper"}),
    # Without KITTY_WINDOW_ID: the plant as a picture.
    "bloom-img": (Launch(unset=NOID), {"style": "bloom"}),
    "bloom-img-fs": (Launch(render="fullscreen", unset=NOID), {"style": "bloom"}),
    "holo-blocking": (Launch(env=("CLAUDE_CODE_NONBLOCKING_STDOUT=0",)), {"style": "holo"}),
    "vanilla": (Launch(vanilla=True), {}),
    # The mod loaded with nothing chosen: it should cost what vanilla does.
    "off": (N, {"fresh": True}),
    "vanilla-bg": (Launch(vanilla=True), {"background": "tab"}),
    "vanilla-fs": (Launch(render="fullscreen", vanilla=True), {}),
    "it-holo-fs": (Launch(term="iterm", render="fullscreen"), {"style": "holo"}),
    "it-temper-fs": (Launch(term="iterm", render="fullscreen"), {"style": "temper"}),
    "it-holo-bg": (Launch(term="iterm", render="fullscreen"), {"style": "holo", "background": "tab"}),
    "it-holo": (Launch(term="iterm"), {"style": "holo"}),
    "it-holo-main": (Launch(term="iterm", render="main"), {"style": "holo"}),
    "it-bloom-fs": (Launch(term="iterm", render="fullscreen"), {"style": "bloom"}),
    "it-vanilla-fs": (Launch(term="iterm", render="fullscreen", vanilla=True), {}),
}
SETS = {
    # A minute or so: is each style's line what it should be, at what cost, and what /spinner answers.
    "smoke": (["holo", "bloom", "temper"], "thinking"),
    "full": ([a for a in ARMS if not a.startswith("it-")], "turn"),
    "iterm": ([a for a in ARMS if a.startswith("it-")], "turn"),
}


# ---------------------------------------------------------------- driving


def sh(*args: str, check: bool = True, timeout: float = 20) -> str:
    return subprocess.run(args, capture_output=True, text=True, check=check, timeout=timeout).stdout


@dataclass
class Window:
    sock: str
    match: str | None = None  # Claude's kitty window, once known: another tab may be active

    def kitten(self, *args: str, check: bool = True) -> str:
        return sh(KITTEN, "@", "--to", f"unix:{self.sock}", *args, check=check)

    def _m(self) -> list[str]:
        return ["--match", self.match] if self.match else []

    def text(self, ansi: bool = False) -> str:
        return self.kitten("get-text", *self._m(), *(["--ansi"] if ansi else []))

    def send(self, text: str) -> None:
        self.kitten("send-text", *self._m(), "--", text)

    def key(self, *keys: str) -> None:
        self.kitten("send-key", *self._m(), *keys)

    def ls(self) -> dict:
        return json.loads(self.kitten("ls"))[0]


ITERM = "com.googlecode.iterm2"
# Where iTerm2 puts the cells in a window shot (retina pixels), measured with
# coloured blocks at (0,0), (14,49), (29,99) under the default profile; a shot
# of another size means the profile changed and the numbers must be taken again.
ITERM_GEOM = {"x0": 10, "y0": 70, "cw": 24, "ch": 48, "shot": [2420, 1514]}
# iTerm2 shows its tab bar once a window has a second tab (a *-bg arm's
# cover) and grows the window by it, cells unchanged: a shot taller by up to
# this much has its grid that much lower.
ITERM_TAB_BAR_MAX = 120


def grid_origin(geom: dict, width: int, height: int) -> tuple[float, float]:
    """Where cell (0,0) starts in a shot of this size, by the measured geometry."""
    dy = height - geom["shot"][1]
    if width != geom["shot"][0] or not 0 <= dy <= ITERM_TAB_BAR_MAX:
        raise ValueError(f"shot is {width}x{height}, geometry was taken at {geom['shot']}: measure it again")
    return geom["x0"], geom["y0"] + dy


def osa(script: str, check: bool = True) -> str:
    return sh("osascript", "-e", script, check=check).strip()


def iterm_screen(contents: str, lines: int) -> str:
    """The window's rows from iTerm2's contents, each row ended by a newline:
    after a /clear on the main screen the contents start with rows scrolled
    off the top, and a row index must count from the window's first row."""
    end = "\n" if contents.endswith("\n") else ""
    rows = contents[: len(contents) - len(end)].split("\n")
    return "\n".join(rows[-lines:]) + end


@dataclass
class ITermWindow:
    """One iTerm2 window the probe made, driven through AppleScript only."""

    wid: int

    def _s(self, body: str, check: bool = True) -> str:
        # Claude's session is the first tab's: a tab opened over it is current.
        return osa(f'tell application "iTerm2" to tell session 1 of tab 1 of window id {self.wid} to {body}', check)

    def text(self, ansi: bool = False) -> str:
        # Unstripped: a blank first row must stay a row.
        out = sh("osascript", "-e", f'tell application "iTerm2" to tell session 1 of tab 1 of window id {self.wid} to get contents')
        return iterm_screen(out[:-1] if out.endswith("\n") else out, LINES)

    def send(self, text: str) -> None:
        q = text.replace("\\", "\\\\").replace('"', '\\"')
        self._s(f'write text "{q}" newline NO')

    def key(self, *keys: str, check: bool = True) -> None:
        code = {"enter": 13, "ctrl+c": 3, "escape": 27}
        for k in keys:
            self._s(f"write text (ASCII character {code[k]}) newline NO", check)

    def exists(self) -> bool:
        return osa(f'tell application "iTerm2" to exists window id {self.wid}', check=False) == "true"


def frontmost() -> str | None:
    try:
        return sh("osascript", "-e", 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true').strip() or None
    except Exception:
        return None


def give_focus_back(bundle: str | None) -> None:
    if bundle and "kitty" not in bundle:
        subprocess.run(["osascript", "-e", f'tell application id "{bundle}" to activate'], capture_output=True)


def store_styles() -> dict[str, dict[str, object]]:
    """The choice in each of the mod's store files, where it holds one."""
    out = {}
    for f in glob.glob(str(STORE / "rainbow-spinner_*.json")):
        try:
            data = json.loads(Path(f).read_text())
            out[f] = {k: data[k] for k in CHOICE_KEYS if k in data}
        except Exception:
            pass
    return out


def clear_styles() -> None:
    """Takes the choice out of each of the mod's store files."""
    for f in store_styles():
        data = json.loads(Path(f).read_text())
        if any(k in data for k in CHOICE_KEYS):
            for k in CHOICE_KEYS:
                data.pop(k, None)
            Path(f).write_text(json.dumps(data, indent=2) + "\n")


def restore_styles(saved: dict[str, dict[str, object]]) -> list[str]:
    """Puts back only the choice: other sessions write the same file."""
    changed = []
    for f, now in store_styles().items():
        keep = saved.get(f, {})
        if keep != now:
            data = json.loads(Path(f).read_text())
            for k in CHOICE_KEYS:
                if k in keep:
                    data[k] = keep[k]
                else:
                    data.pop(k, None)
            Path(f).write_text(json.dumps(data, indent=2) + "\n")
            changed.append(f"{Path(f).name}: {now} -> {keep}")
    return changed


def screen_text(win, ansi: bool = False) -> str:
    try:
        return win.text(ansi=ansi)
    except Exception:
        return ""


def wait_for(win, test, timeout: float, what: str, every: float = 0.1) -> str:
    """Polls the screen (with colours where the terminal gives them) until test passes."""
    end = time.time() + timeout
    screen = ""
    while time.time() < end:
        screen = screen_text(win, ansi=True)
        if test(screen):
            return screen
        time.sleep(every)
    raise TimeoutError(f"waiting for {what}; screen was:\n{strip_ansi(screen)}")


# What env.txt shows the value of: what the mod and the engine read of the terminal.
ENV_SHOWN = (
    "TERM COLORTERM TERM_PROGRAM TERM_PROGRAM_VERSION TERM_SESSION_ID TERM_FEATURES TERMINFO TERMINFO_DIRS "
    "LANG LC_ALL LC_CTYPE LC_TERMINAL LC_TERMINAL_VERSION HOME PATH SHELL TMUX TMUX_PANE WSLENV WT_SESSION WT_PROFILE_ID "
    "ITERM_PROFILE ITERM_SESSION_ID KITTY_WINDOW_ID KITTY_PID KITTY_INSTALLATION_DIR KITTY_LISTEN_ON"
).split()
SECRETISH = re.compile(r"KEY|TOKEN|SECRET|PASS|AUTH|CRED|COOKIE", re.I)
ENV_AWK = r'BEGIN { for (k in ENVIRON) { v = ENVIRON[k]; gsub(/\n/, "\\n", v); print k "=" (k ~ keep ? v : "(hidden)") } }'


def shown_names(env: dict[str, str]) -> str:
    """The awk pattern of names env.txt shows: the terminal's, and the Claude
    settings the probe itself sets (not one that looks like a credential)."""
    own = [k for k in env if k.startswith("CLAUDE_CODE_") and not SECRETISH.search(k)]
    return "^(" + "|".join(ENV_SHOWN + own) + ")$"


def launcher(out: Path, launch: Launch, plugin_dir: str | None, cmd: list[str] | None = None) -> Path:
    """The program the terminal runs: a clean environment, then Claude."""
    env = {
        "PATH": f"{Path.home()}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "LANG": "en_US.UTF-8",
    }
    if launch.render == "normal":
        # The user's settings may ask for fullscreen; these win over them.
        env |= {"CLAUDE_CODE_NO_FLICKER": "0", "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN": "1"}
    elif launch.render == "fullscreen":
        env |= {"CLAUDE_CODE_NO_FLICKER": "1"}
    env |= dict(kv.split("=", 1) for kv in launch.env)
    if cmd is None:
        cmd = [CLAUDE, "--model", launch.model, "--debug-file", str(out / "debug.log")]
        cmd += shlex.split(os.environ.get("PROBE_CLAUDE_ARGS", ""))  # extra arguments for Claude
        if plugin_dir and not launch.vanilla:
            cmd += ["--plugin-dir", str(Path(plugin_dir).resolve())]
        if launch.render == "main":
            # Over the user's "tui": "fullscreen"; /tui can still switch it.
            cmd += ["--settings", '{"tui":"default"}']
    q = lambda s: "'" + s.replace("'", "'\\''") + "'"
    leaks = r"CLAUDE[A-Z_]*|ITERM[A-Z_]*|TERM_PROGRAM[A-Z_]*|LC_TERMINAL[A-Z_]*|TERM_SESSION_ID|TERM_FEATURES|TERMINFO_DIRS|AI_AGENT|__CFBundleIdentifier"
    if launch.term == "iterm":
        # iTerm2 starts the command itself: its own ITERM_*, TERM_PROGRAM,
        # LC_TERMINAL are the terminal's and stay; only another session's go.
        leaks = r"CLAUDE[A-Z_]*|AI_AGENT|__CFBundleIdentifier|KITTY[A-Z_]*"
    script = out / "launch.sh"
    script.write_text(
        "#!/bin/sh\n"
        "# Drop what the starting shell leaks (another Claude session, another terminal).\n"
        f"for v in $(env | grep -oE '^({leaks})='); do unset \"${{v%=}}\"; done\n"
        + "".join(f"for v in $(env | grep -oE '^{k[:-1]}[A-Za-z0-9_]*='); do unset \"${{v%=}}\"; done\n" if k.endswith("*") else f"unset {k}\n" for k in launch.unset)
        + "".join(f"export {k}={q(v)}\n" for k, v in env.items())
        + f"cd {q(str(TRUSTED))}\n"
        # Values only for names on a list (exact names: a prefix would let
        # HOMEBREW_GITHUB_API_TOKEN through as HOME*); a value's newlines are
        # kept as \n, so no line of one stands as a line of its own.
        + f"awk -v keep={q(shown_names(env))} {q(ENV_AWK)} | sort > {q(str(out / 'env.txt'))}\n"
        + "exec " + " ".join(q(c) for c in cmd) + "\n"
    )
    script.chmod(0o755)
    return script


class KittyLog(threading.Thread):
    """Reads kitty's --dump-commands from a fifo and stamps every line."""

    def __init__(self, fifo: Path, out: Path):
        super().__init__(daemon=True)
        self.fifo, self.out = fifo, out

    def run(self) -> None:
        with open(self.fifo, "r", errors="replace") as src, open(self.out, "w") as dst:
            for line in src:
                dst.write(f"{time.time():.4f} {line}")


class KittyTerm:
    """kitty, an instance of its own in the background, driven through its socket."""

    name = "kitty"

    def __init__(self, out: Path, label: str, keep_focus: bool = False):
        self.out, self.label, self.keep_focus = out, label, keep_focus
        self.sock = f"{tempfile.gettempdir().rstrip('/')}/kp-{os.getpid()}-{time.time_ns() % 10**9}.sock"
        self.pids: list[str] = []
        self.cover_id: str | None = None
        self.reader: KittyLog | None = None

    def open(self, script: Path) -> Window:
        fifo = self.out / "kitty.fifo"
        os.mkfifo(fifo)
        self.reader = KittyLog(fifo, self.out / "kitty.log")
        self.reader.start()
        before = frontmost()
        sh(
            "open", "-g", "-n", "-a", KITTY_APP, "--stdout", str(fifo), "--stderr", str(self.out / "kitty.err"), "--args",
            "--dump-commands", f"--dump-bytes={self.out / 'bytes.bin'}", "--listen-on", f"unix:{self.sock}", "--title", f"probe-{self.label}",
            "-o", "allow_remote_control=socket-only", "-o", "hide_window_decorations=titlebar-only",
            "-o", "tab_bar_min_tabs=2", "-o", "window_padding_width=0", "-o", "remember_window_size=no",
            "-o", f"initial_window_width={COLS}c", "-o", f"initial_window_height={LINES}c",
            "-o", "macos_quit_when_last_window_closed=yes", "-o", "confirm_os_window_close=0",
            str(script),
        )
        for _ in range(200):
            if os.path.exists(self.sock):
                break
            time.sleep(0.05)
        if not self.keep_focus:
            give_focus_back(before)
        self.pids = sh("pgrep", "-f", re.escape(self.sock), check=False).split()
        win = Window(self.sock)
        info = win.ls()
        w = info["tabs"][0]["windows"][0]
        win.match = f"id:{w['id']}"
        self.wid = info["platform_window_id"]
        (self.out / "window.json").write_text(json.dumps({"platform_window_id": self.wid, "columns": w["columns"], "lines": w["lines"], "kitty_pids": self.pids}))
        return win

    def cover(self, win: Window, how: str) -> None:
        if how == "tab":
            # Another tab in front: Claude's is still there, just not shown.
            self.cover_id = win.kitten("launch", "--type=tab", "/bin/sleep", "600").strip()
        elif how == "minimise":
            win.kitten("action", "minimize_macos_window")

    def uncover(self, win: Window) -> None:
        if self.cover_id:
            win.kitten("close-window", "--match", f"id:{self.cover_id}", check=False)
            self.cover_id = None

    def bytes_at(self) -> int:
        try:
            return (self.out / "bytes.bin").stat().st_size
        except FileNotFoundError:
            return 0

    def close(self, win: Window | None) -> None:
        self.pids = self.pids or sh("pgrep", "-f", re.escape(self.sock), check=False).split()
        if win is not None and os.path.exists(self.sock):
            win.key("ctrl+c")
            time.sleep(0.3)
            win.key("ctrl+c")
            # Claude gone ends the window, and with it this kitty.
            end = time.time() + 3
            while time.time() < end and any(subprocess.run(["kill", "-0", p], capture_output=True).returncode == 0 for p in self.pids):
                time.sleep(0.1)
            Window(self.sock).kitten("close-window", check=False) if os.path.exists(self.sock) else None
        for pid in self.pids:
            subprocess.run(["kill", pid], capture_output=True)
        subprocess.run(["pkill", "-f", re.escape(str(self.out / "debug.log"))], capture_output=True)
        time.sleep(0.3)
        for pid in self.pids:
            subprocess.run(["kill", "-9", pid], capture_output=True)
        try:
            os.unlink(self.sock)
        except FileNotFoundError:
            pass
        if self.reader:
            self.reader.join(3)


class ITermTerm:
    """A new iTerm2 window of its own (never one of the user's): made through
    AppleScript, focus handed straight back, typed into only through its own
    session, closed at the end."""

    name = "iterm"

    def __init__(self, out: Path, label: str, keep_focus: bool = False):
        self.out, self.label = out, label
        self.sleeper = f"600.{os.getpid()}"
        self.theirs: set[str] = set()
        self.win: ITermWindow | None = None

    def open(self, script: Path) -> ITermWindow:
        # With iTerm2 in front on a full-screen window of the user's, a new
        # window opens full screen on a Space of its own, which cannot be shot:
        # wait till they are in another app.
        waited = time.time()
        while frontmost() == ITERM:
            if time.time() - waited > 1800:
                raise RuntimeError("iTerm2 stayed in front for 30 min")
            time.sleep(5)
        before = frontmost()
        before_win = osa('tell application "iTerm2" to if (count of windows) > 0 then get id of current window', check=False) if before == ITERM else ""
        self.theirs = set(osa('tell application "iTerm2" to get id of every window', check=False).replace(",", " ").split())
        wid = int(osa(
            'tell application "iTerm2"\n'
            f'  set w to (create window with default profile command "{script}")\n'
            f'  tell current session of w\n    set columns to {COLS}\n    set rows to {LINES}\n  end tell\n'
            '  return id of w\nend tell'))
        if str(wid) in self.theirs:
            raise RuntimeError(f"iTerm2 answered window {wid}, one that was already open")
        self.win = win = ITermWindow(wid)
        self.wid = wid
        if before == ITERM and before_win:
            osa(f'tell application "iTerm2" to select window id {before_win}', check=False)
        else:
            give_focus_back(before)
        # macOS can make the window something else (a tab of a full-screen
        # window, another Space): then it is not the size asked or cannot be
        # shot, and the series is not run.
        time.sleep(1.0)
        size = win._s("get {columns, rows}", check=False)
        probe = subprocess.run(["screencapture", "-l", str(wid), "-x", "-o", "-t", "png", str(self.out / "probe.png")], capture_output=True, text=True)
        if size.replace(" ", "") != f"{COLS},{LINES}" or probe.returncode != 0:
            raise RuntimeError(f"window {wid} is {size}, shot: {probe.returncode} {probe.stderr.strip()}")
        iterm_pid = [l.split()[0] for l in sh("ps", "-axo", "pid=,args=").splitlines() if l.split(None, 1)[1:] == ["/Applications/iTerm.app/Contents/MacOS/iTerm2"]][:1]
        (self.out / "window.json").write_text(json.dumps({"platform_window_id": wid, "columns": COLS, "lines": LINES, "term": "iterm", "term_pids": iterm_pid, "geom": ITERM_GEOM}))
        return win

    def cover(self, win: ITermWindow, how: str) -> None:
        if how == "tab":
            # A tab of a sleep in front of Claude's; ended by name in uncover.
            front = frontmost()
            osa(f'tell application "iTerm2" to tell window id {win.wid} to create tab with default profile command "/bin/sleep {self.sleeper}"')
            give_focus_back(front) if front != ITERM else None
        elif how == "minimise":
            osa(f'tell application "iTerm2" to set miniaturized of window id {win.wid} to true')

    def uncover(self, win: ITermWindow) -> None:
        subprocess.run(["pkill", "-f", re.escape(f"/bin/sleep {self.sleeper}")], capture_output=True)

    def bytes_at(self) -> int:
        return 0

    def close(self, win: ITermWindow | None) -> None:
        win = win or self.win  # open() may have made the window and then failed
        if win is not None and win.exists():
            # The window can outlive its session: then there is nothing to stop.
            win.key("ctrl+c", check=False)
            time.sleep(0.4)
            win.key("ctrl+c", check=False)
            time.sleep(1.5)
        subprocess.run(["pkill", "-f", re.escape(str(self.out / "debug.log"))], capture_output=True)
        subprocess.run(["pkill", "-f", re.escape(f"/bin/sleep {self.sleeper}")], capture_output=True)
        time.sleep(1.0)
        if win is not None and str(win.wid) not in self.theirs and win.exists():
            osa(f'tell application "iTerm2" to close window id {win.wid}', check=False)


# ---------------------------------------------------------------- the screen while driving

INPUT_RE = re.compile(r"^\s*❯ ?", re.M)
RULE_RE = re.compile(r"^\s*─{8,}")


def box_row(rows: list[str]) -> int | None:
    """The prompt box's first row: ❯ in the first column, right under a rule
    (the command menu under the box marks its pick with an indented ❯)."""
    return max((k for k in range(1, len(rows)) if rows[k].startswith("❯") and RULE_RE.match(rows[k - 1])), default=None)


def input_box(screen: str) -> str:
    """What is typed in the prompt box: the rows from the screen's last ❯ to
    the box's bottom rule, whitespace collapsed. A suggestion shown in an
    empty box is dim; iTerm2's text has no colours, so its "Try ..." is
    told by its words."""
    rows = screen.split("\n")
    first = box_row([strip_ansi(r) for r in rows])
    if first is None:
        return ""
    typed = []
    for k in range(first, len(rows)):
        if k > first and RULE_RE.match(strip_ansi(rows[k])):
            break
        typed.append("".join(c.ch for c in cells(rows[k]) if not c.dim))
    text = " ".join(" ".join(typed).replace("❯", " ", 1).split())
    return "" if re.fullmatch(r'Try ".*"', text) else text


def idle(screen: str) -> bool:
    """The prompt box is up and no turn is running."""
    plain = strip_ansi(screen)
    return box_row(plain.split("\n")) is not None and not any(SPIN_RE.search(l) for l in after_prompt(plain).splitlines())


def ready(screen: str) -> bool:
    """Idle, and nothing typed in the box."""
    return idle(screen) and input_box(screen) == ""


def first_prompt(screen: str) -> bool:
    """Ready, or stops at once on the trust-folder question: a keystroke
    into it ends Claude, and the series would only time out."""
    if "Yes, I trust this folder" in strip_ansi(screen):
        raise RuntimeError(f"Claude asks whether to trust {TRUSTED}; set PROBE_CWD to a folder it already trusts")
    return ready(screen)


def type_line(win, text: str, timeout: float = 10) -> None:
    """Types a line and sends it once the box shows it whole."""
    want = " ".join(text.split())
    win.send(text)
    wait_for(win, lambda s: input_box(s) == want, timeout, f"{text[:30]!r} in the prompt box", every=0.05)
    win.key("enter")


def spinner_reply(screen: str, style: str) -> tuple[int, list[str]] | None:
    """The echo row of `/spinner <style>` and the rows the reply takes under it
    (the engine's row, or whatever a hook draws in its place)."""
    rows = strip_ansi(screen).split("\n")
    last_input = box_row(rows)
    if last_input is None:
        return None
    echo = next((k for k in range(last_input - 1, -1, -1) if re.match(rf"^\s*❯ /spinner {re.escape(style)}\s*$", rows[k])), None)
    if echo is None:
        return None
    reply = []
    for r in rows[echo + 1 : last_input]:
        # The reply ends at the first blank row after it (fullscreen pads the
        # transcript with blank rows and puts the effort marker under them).
        if RULE_RE.match(r) or (not r.strip() and any(x.strip() for x in reply)):
            break
        reply.append(r.rstrip())
    return (echo, reply) if any(r.strip() for r in reply) else None


def wait_reply(win, style: str, timeout: float = 20) -> tuple[int, list[str]]:
    """The /spinner reply once it is drawn: the engine's row ("⎿ ...") or a
    box at once; anything else (in fullscreen a spinner row stands there while
    the command runs; a hook may draw an unbordered block) once it has stayed
    the same for 2 s."""
    seen, since = None, time.time()

    def test(screen: str) -> bool:
        nonlocal seen, since
        got = spinner_reply(screen, style) if ready(screen) else None
        if got != seen:
            seen, since = got, time.time()
        return got is not None and (any(re.match(r"^\s*[⎿╭]", r) for r in got[1]) or time.time() - since >= 2)

    wait_for(win, test, timeout, f"the /spinner {style} reply")
    return seen


def shoot(wid: int, path: Path) -> subprocess.CompletedProcess:
    return subprocess.run(["screencapture", "-l", str(wid), "-x", "-o", "-t", "png", str(path)], capture_output=True, text=True)


def crop_rows(shot: Path, out: Path, first: int, last: int, winfo: dict) -> None:
    from PIL import Image

    img = Image.open(shot)
    geom = winfo.get("geom")
    if geom:
        (x0, y0), ch = grid_origin(geom, img.width, img.height), geom["ch"]
    else:
        x0, y0, ch = 0, 0, img.height / winfo["lines"]
    img.crop((int(x0), int(y0 + first * ch), img.width, min(img.height, int(y0 + (last + 1) * ch)))).save(out)


def capture(win, out: Path, wid: int, t0: float, turn: Turn, pids: dict[str, list[str]], finished=None) -> None:
    """Shots, screen text and CPU until the turn has shown what it is recorded for."""
    shots = out / "shots"
    shots.mkdir(exist_ok=True)
    halt = threading.Event()
    latest = {"ansi": ""}

    def text_loop() -> None:
        with open(out / "text.jsonl", "w") as texts:
            while not halt.is_set():
                t = time.time()
                try:
                    body = win.text(ansi=True)
                except Exception as err:
                    body = f"<error {err}>"
                latest["ansi"] = body
                texts.write(json.dumps({"t": t, "ansi": body}, ensure_ascii=False) + "\n")
                texts.flush()
                time.sleep(max(0.0, 0.1 - (time.time() - t)))

    def cpu_loop() -> None:
        """CPU seconds of Claude and the terminal, once a second."""
        with open(out / "cpu.jsonl", "w") as f:
            while not halt.is_set():
                row = {"t": time.time()}
                for name, ps in pids.items():
                    if ps:
                        c = sh("ps", "-o", "cputime=", "-p", ps[0], check=False).strip()
                        m = re.match(r"(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)", c)
                        if m:
                            row[name] = int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
                f.write(json.dumps(row) + "\n")
                f.flush()
                halt.wait(1.0)

    th = threading.Thread(target=text_loop, daemon=True)
    th.start()
    threading.Thread(target=cpu_loop, daemon=True).start()
    n = 0
    thinking_at = done_at = None
    while time.time() - t0 < turn.seconds:
        t = time.time()
        cap = shoot(wid, shots / f"{n:04d}-{int((t - t0) * 1000):06d}.png")
        if cap.returncode != 0:
            with open(out / "shots.err", "a") as f:
                f.write(f"{t - t0:.2f} {cap.returncode} {cap.stderr.strip()}\n")
        n += 1
        plain = strip_ansi(latest["ansi"])
        if turn.capture == "thinking":
            if thinking_at is None and spinner_row(latest["ansi"]) is not None:
                thinking_at = time.time()
            if answering(plain) or turn_done(plain) or (thinking_at and time.time() - thinking_at >= turn.window):
                break
        else:
            if done_at is None and (finished or turn_done)(plain):
                done_at = time.time()
            if done_at and time.time() - done_at > 3:
                break
    halt.set()
    th.join(2)


@dataclass
class Series:
    label: str
    launch: Launch
    turns: list[Turn]
    plugin_dir: str | None = None
    keep_focus: bool = False
    out: Path | None = field(default=None)
    failed: list[str] = field(default_factory=list)  # "label: why", for each turn that did not come out


def run_series(s: Series, root: Path) -> list[Path]:
    """One window, one Claude, the turns one after another; then their analysis."""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = s.out = root / f"{s.label}-{stamp}"
    out.mkdir(parents=True)
    (out / "series.json").write_text(json.dumps({"launch": asdict(s.launch), "plugin_dir": s.plugin_dir, "turns": [asdict(t) for t in s.turns]}, indent=2))
    saved = store_styles()
    term = (ITermTerm if s.launch.term == "iterm" else KittyTerm)(out, s.label, s.keep_focus)
    script = launcher(out, s.launch, s.plugin_dir)
    print(f"[{s.label}] out: {out}", flush=True)
    done: list[Path] = []
    win = None
    started = time.time()
    k = -1
    try:
        win = term.open(script)
        winfo = json.loads((out / "window.json").read_text())
        wait_for(win, first_prompt, 60, "the prompt")
        claude = sh("pgrep", "-f", re.escape(str(out / "debug.log")), check=False).split()[:1]
        pids = {"claude": claude, term.name: winfo.get("term_pids", winfo.get("kitty_pids", []))[:1]}
        since = started
        for k, turn in enumerate(s.turns):
            if turn.background == "minimise" and k != len(s.turns) - 1:
                raise ValueError("a minimised turn must be the series' last: the window stays minimised")
            tdir = out / turn.label
            tdir.mkdir()
            meta: dict = {"series": str(out), "index": k, "turn": asdict(turn), "launch": asdict(s.launch), "plugin_dir": s.plugin_dir, "since": since}
            if k:
                type_line(win, "/clear")
                wait_for(win, lambda p: ready(p) and PROMPT_TAIL not in p and "/spinner" not in strip_ansi(p), 20, "/clear")
            if turn.fresh:
                clear_styles()
            if turn.style:
                type_line(win, f"/spinner {turn.style}")
                echo, rows = wait_reply(win, turn.style)
                (tdir / "reply.txt").write_text("\n".join(rows) + "\n")
                meta["reply"] = verdict(rows)
                shot = tdir / "reply-shot.png"
                if shoot(term.wid, shot).returncode == 0:
                    crop_rows(shot, tdir / "reply.png", echo, echo + len(rows), winfo)
                    shot.unlink()
            meta["bytes_from"] = term.bytes_at()
            t0 = time.time()
            (tdir / "t0").write_text(f"{t0:.4f}\n")
            type_line(win, turn.prompt)
            if turn.background != "none":
                term.cover(win, turn.background)
            capture(win, tdir, term.wid, t0, turn, pids)
            (tdir / "final.txt").write_text(screen_text(win))
            if turn.background != "none" and turn.background != "minimise":
                term.uncover(win)
            if not turn_done(screen_text(win)):
                win.key("escape")
            # A turn stopped before it answered puts its prompt back in the box: Ctrl+C empties it.
            if input_box(wait_for(win, idle, 20, "the turn to stop")):
                win.key("ctrl+c")
                wait_for(win, ready, 5, "an empty prompt box")
            since = time.time()
            meta["bytes_to"] = term.bytes_at()
            meta["t_end"] = since
            (tdir / "turn.json").write_text(json.dumps(meta, indent=2))
            (tdir / "window.json").write_text(json.dumps(winfo))
            done.append(tdir)
    except Exception as err:
        # The turn under way and the ones after it are lost; those done are analysed.
        why = f"{type(err).__name__}: {str(err).splitlines()[0] if str(err) else ''}"
        print(f"[{s.label}] FAILED: {type(err).__name__}: {err}", flush=True)
        s.failed += [f"{t.label}: {why if j == max(k, 0) else 'not run, the window failed before it'}" for j, t in enumerate(s.turns) if j >= max(k, 0)]
    finally:
        term.close(win)
        for line in restore_styles(saved):
            print(f"[{s.label}] store restored: {line}", flush=True)
        # Claude interrupted mid-turn runs its session-end hooks for a few seconds.
        end = time.time() + 8
        while (left := sh("pgrep", "-f", re.escape(str(out)), check=False).split()) and time.time() < end:
            time.sleep(0.25)
        if left:
            print(f"[{s.label}] WARNING processes left: {left}", flush=True)
        print(f"[{s.label}] window open {time.time() - started:.0f} s, {len(done)} of {len(s.turns)} turns", flush=True)
    lines = []
    with ProcessPoolExecutor(max_workers=min(4, max(1, len(done)))) as pool:
        for tdir, job in [(d, pool.submit(analyse_quiet, d)) for d in done]:
            try:
                lines.append(summary_line(job.result()))
            except Exception as err:
                why = f"analysis: {type(err).__name__}: {err}"
                s.failed.append(f"{tdir.name}: {why}")
                print(f"[{s.label}] {tdir.name} FAILED {why}", flush=True)
    lines += [f"{f.split(': ', 1)[0]:<14} FAILED {f.split(': ', 1)[1]}" for f in s.failed]
    (out / "summary.txt").write_text("\n".join(lines) + "\n")
    return done


def verdict(rows: list[str]) -> str:
    """The /spinner reply as one line: the engine's row without its marks, or
    the text of whatever is drawn in its place (a box: its rows joined)."""
    text = " ".join(re.sub(r"[⎿╭╮╰╯│─]", " ", r).strip() for r in rows)
    text = re.sub(r"^rainbow-spinner:\s*", "", " ".join(text.split()))
    return text


def run_plain(label: str, cmd: list[str], seconds: float, finished, keep_focus: bool) -> Path:
    """kitty alone running a program (no Claude): replay and swap."""
    root = Path(os.environ.get("PROBE_OUT") or Path(tempfile.gettempdir()) / "rainbow-probe").resolve()
    out = root / f"{label}-{time.strftime('%Y%m%d-%H%M%S')}"
    out.mkdir(parents=True)
    (out / "arm.json").write_text(json.dumps({"label": label, "cmd": cmd, "swap": label == "swap"}, indent=2))
    term = KittyTerm(out, label, keep_focus)
    script = launcher(out, Launch(), None, cmd)
    print(f"[{label}] out: {out}", flush=True)
    win = None
    try:
        win = term.open(script)
        winfo = json.loads((out / "window.json").read_text())
        t0 = time.time()
        (out / "t0").write_text(f"{t0:.4f}\n")
        capture(win, out, term.wid, t0, Turn(label, seconds=seconds), {"kitty": winfo["kitty_pids"][:1]}, finished)
    finally:
        term.close(None)
    return out
# ---------------------------------------------------------------- reading the screen

SGR = re.compile(r"\x1b\[([0-9;:]*)m")
OTHER = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-ln-z]")
# The spinner line's tail: "(12s · thinking)", "(3m 2s · ↓ 1.2k tokens)".
SPIN_RE = re.compile(r"\((?:\d+h )?(?:\d+m )?\d+s(?: ·|\))|esc to interrupt")
# The line that closes a turn: "✻ Brewed for 12s".
DONE_RE = re.compile(r"^\s*\S \w+ for (?:\d+h )?(?:\d+m )?\d+s\b", re.M)


def strip_ansi(s: str) -> str:
    return OTHER.sub("", SGR.sub("", s))


def after_prompt(plain: str) -> str:
    # Once the prompt has scrolled away, the whole screen is after it.
    i = plain.rfind(PROMPT_TAIL)
    return plain[i + len(PROMPT_TAIL) :] if i >= 0 else plain


ANSWER_RE = re.compile(r"^\s*⏺ (?!Thinking)\S", re.M)


def answering(plain: str) -> bool:
    """The answer has started: a "⏺" bullet followed by prose (not a thinking block)."""
    return bool(ANSWER_RE.search(after_prompt(plain)))


def turn_done(plain: str) -> bool:
    body = after_prompt(plain)
    return bool(DONE_RE.search(body)) and not any(SPIN_RE.search(l) for l in body.splitlines())


@dataclass
class Cell:
    ch: str
    fg: tuple | None
    dim: bool


def is_mark(ch: str) -> bool:
    return 0x0300 <= ord(ch) <= 0x036F or 0x0483 <= ord(ch) <= 0x0487 or 0x0591 <= ord(ch) <= 0x05C7 or 0x0610 <= ord(ch) <= 0x1DFF


def cells(line: str) -> list[Cell]:
    """One ANSI line from get-text into cells; a placeholder's diacritics stay on it."""
    out: list[Cell] = []
    fg, dim = None, False
    i = 0
    line = OTHER.sub("", line)
    while i < len(line):
        m = SGR.match(line, i)
        if m:
            ps = re.split(r"[;:]", m.group(1)) if m.group(1) else ["0"]
            j = 0
            while j < len(ps):
                p = ps[j] or "0"
                if p == "0":
                    fg, dim = None, False
                elif p == "2":
                    dim = True
                elif p == "22":
                    dim = False
                elif p == "39":
                    fg = None
                elif p == "38" and j + 1 < len(ps) and ps[j + 1] == "2":
                    fg = tuple(int(v or 0) for v in ps[j + 2 : j + 5])
                    j += 4
                elif p == "38" and j + 1 < len(ps) and ps[j + 1] == "5":
                    fg = ("idx", int(ps[j + 2] or 0))
                    j += 2
                elif p.isdigit() and (30 <= int(p) <= 37 or 90 <= int(p) <= 97):
                    fg = ("idx", int(p))
                elif p in ("48", "58") and j + 1 < len(ps):
                    j += 4 if ps[j + 1] == "2" else 2
                j += 1
            i = m.end()
            continue
        ch = line[i]
        i += 1
        if out and is_mark(ch):
            continue  # combining: a placeholder's row/column diacritics
        out.append(Cell(ch, fg, dim))
    return out


def spinner_row(ansi: str) -> tuple[int, list[Cell]] | None:
    rows = ansi.split("\n")
    for k in range(len(rows) - 1, -1, -1):
        plain = strip_ansi(rows[k])
        if SPIN_RE.search(plain) and not plain.lstrip().startswith(("❯", ">")):
            return k, cells(rows[k])
    return None


def describe_row(cs: list[Cell], blank_word: bool = False) -> dict:
    """Where the glyph and the word sit in the spinner row, and what fills them."""
    text = "".join(c.ch for c in cs)
    glyph_col = len(text) - len(text.lstrip())
    glyph_picture = blank_word and glyph_col + 1 < len(cs) and cs[glyph_col + 1].ch != " "
    if glyph_picture:
        # iTerm2's text leaves a picture glyph out with the space after it (bloom's
        # plant): two blank cells put the word back where it is on screen.
        cs = cs[:glyph_col] + [Cell(" ", None, False), Cell(" ", None, False)] + cs[glyph_col:]
        text = "".join(c.ch for c in cs)
    paren = text.find("(", glyph_col)
    word_from = glyph_col + 1
    while word_from < len(cs) and cs[word_from].ch == " ":
        word_from += 1
    word_to = paren if paren > word_from else len(cs)
    while word_to > word_from and cs[word_to - 1].ch == " ":
        word_to -= 1
    if blank_word and word_from >= paren:
        # iTerm2's text leaves a picture's cells out altogether, so where the
        # tail starts on screen is unknown: the word's first four cells are
        # judged (every spinner word is longer).
        word_from, word_to = glyph_col + 2, glyph_col + 6
        word = cs[word_from:word_to]
        return {
            "glyph_col": glyph_col, "glyph": "picture" if glyph_picture else cs[glyph_col].ch if glyph_col < len(cs) else "",
            "word_cols": [word_from, word_to], "word_text": "", "word_layer": "blank-cells",
            "word_colours": 0, "tail": text[paren:].strip(),
        }
    word = cs[word_from:word_to]
    ph = sum(c.ch == PLACEHOLDER for c in word)
    inked = [c for c in word if c.ch.strip()]
    if not word:
        layer = "none"
    elif ph >= max(1, len(word) // 2):
        layer = "placeholder"
    elif inked and all(c.dim for c in inked):
        layer = "alt"
    else:
        layer = "text"
    return {
        "glyph_col": glyph_col,
        "glyph": "picture" if glyph_picture else cs[glyph_col].ch.replace(PLACEHOLDER, "▒") if glyph_col < len(cs) else "",
        "word_cols": [word_from, word_to],
        "word_text": "".join(c.ch for c in word).replace(PLACEHOLDER, "▒"),
        "word_layer": layer,
        "word_colours": len({c.fg for c in inked}),
        "tail": text[paren:].strip() if paren >= 0 else "",
    }


# ---------------------------------------------------------------- analysis


def turn_meta(out: Path) -> dict:
    """turn.json of a series turn; a replay or swap folder has arm.json and its files itself."""
    if (out / "turn.json").exists():
        return json.loads((out / "turn.json").read_text())
    return {"series": str(out), "turn": json.loads((out / "arm.json").read_text())}


def series_file(out: Path, name: str) -> Path:
    return Path(turn_meta(out)["series"]) / name


def load_text(out: Path) -> list[dict]:
    frames = []
    with open(out / "text.jsonl") as f:
        for line in f:
            try:
                frames.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return frames


def phase_marks(frames: list[dict]) -> dict:
    """When the answer starts streaming and when the turn is done, from the text layer."""
    stream = done = None
    for fr in frames:
        if stream is None and answering(strip_ansi(fr["ansi"])):
            stream = fr["t"]
        if done is None and turn_done(strip_ansi(fr["ansi"])):
            done = fr["t"]
    return {"stream_from": stream, "done_at": done}


def phase_of(t: float, marks: dict) -> str:
    if marks["done_at"] and t >= marks["done_at"]:
        return "done"
    if marks["stream_from"] and t >= marks["stream_from"]:
        return "streaming"
    return "thinking"


def classify_pixels(img, row: int, d: dict, cell_w: float, cell_h: float, bg, ox: float = 0, oy: float = 0) -> dict:
    import numpy as np

    # Inset: the window's edge pixels put a row's neighbours a pixel off.
    y0, y1 = int(oy + row * cell_h) + 3, int(oy + (row + 1) * cell_h) - 3

    def region(c0: int, c1: int) -> dict:
        if c1 <= c0:
            return {"ink": 0.0, "chroma": 0.0, "hues": 0}
        a = np.asarray(img.crop((int(ox + c0 * cell_w), y0, int(ox + c1 * cell_w), y1)).convert("RGB")).astype(np.int16)
        diff = np.abs(a - np.array(bg, dtype=np.int16)).sum(axis=2)
        ink = a[diff > 60]
        if len(ink) == 0:
            return {"ink": 0.0, "chroma": 0.0, "hues": 0}
        mx, mn = ink.max(axis=1), ink.min(axis=1)
        coloured = ink[(mx - mn) > 40]
        hues = len({int(colorsys.rgb_to_hsv(*(p / 255.0))[0] * 12) for p in coloured[:: max(1, len(coloured) // 400)]}) if len(coloured) else 0
        return {"ink": float((diff > 60).mean()), "chroma": float((mx - mn).mean()), "hues": hues}

    w = region(*d["word_cols"])
    g = region(d["glyph_col"], d["glyph_col"] + 1)
    word = "blank" if w["ink"] < 0.01 else ("grey" if w["chroma"] < 25 else "colour")
    return {"word_px": word, "word_ink": round(w["ink"], 3), "word_chroma": round(w["chroma"], 1), "word_hues": w["hues"], "glyph_px": "drawn" if g["ink"] >= 0.01 else "blank"}


def word_state(d: dict, px: dict) -> str:
    """One label per shot: what the reader sees where the word belongs.

    picture        placeholder cells, coloured pixels: the picture is up
    picture-blank  placeholder cells, nothing on screen: kitty has no image for them
    alt            the dim alt text (the engine drew the Image's alt)
    text           the word as text (a text style, or the fallback)
    """
    layer = d["word_layer"]
    if layer in ("placeholder", "blank-cells"):
        return {"colour": "picture", "grey": "picture-grey"}.get(px["word_px"], "picture-blank")
    if layer == "alt":
        return "alt" if px["word_px"] != "blank" else "alt-blank"
    if layer == "text":
        return "text" if px["word_px"] != "blank" else "text-blank"
    return "none"


def graphics_stats(out: Path, t0: float, t_end: float, marks: dict) -> dict:
    """The kitty graphics commands Claude sent, from the raw bytes (kitty's
    --dump-commands leaves out single-chunk ones): pictures sent, their size,
    deletes; and per second of thinking, nearly all of them come then."""
    meta = turn_meta(out)
    try:
        with open(series_file(out, "bytes.bin"), "rb") as f:
            f.seek(meta.get("bytes_from", 0))
            data = f.read(meta["bytes_to"] - meta.get("bytes_from", 0)) if "bytes_to" in meta else f.read()
    except FileNotFoundError:
        return {}
    pictures, payload, size, kinds, ids = 0, 0, 0, {}, set()
    for m in re.finditer(rb"\x1b_G([^;\x1b]*);?([^\x1b]*)\x1b\\", data):
        ctrl = dict(kv.split(b"=", 1) for kv in m.group(1).split(b",") if b"=" in kv)
        act = ctrl.get(b"a", b"").decode()
        if act in ("T", "t"):
            size = len(m.group(2))
            ids.add(ctrl.get(b"i"))
        elif act == "":
            size += len(m.group(2))
        else:
            kinds[f"a={act}"] = kinds.get(f"a={act}", 0) + 1
        if act in ("T", "t", "") and ctrl.get(b"m", b"0") == b"0":
            pictures += 1
            payload += size
    thinking = (marks["stream_from"] or marks["done_at"] or t_end) - t0
    return {
        "pictures_sent": pictures,
        "pictures_per_s_of_thinking": round(pictures / max(0.1, thinking), 1),
        "base64_bytes_per_picture": payload // max(1, pictures),
        "base64_kb_per_s_of_thinking": round(payload / 1024 / max(0.1, thinking), 1),
        "other_commands": kinds,
        "image_ids": len(ids),
        "placeholder_cells_drawn": data.count("\U0010eeee".encode()),
    }


def cpu_stats(out: Path, marks: dict, t0: float) -> dict:
    """Share of one core Claude and kitty used while thinking."""
    try:
        rows = [json.loads(l) for l in open(out / "cpu.jsonl")]
    except FileNotFoundError:
        return {}
    end = (marks["stream_from"] or marks["done_at"] or rows[-1]["t"]) - 0.5
    span = [r for r in rows if t0 + 2 <= r["t"] <= end]
    res = {}
    for name in ("claude", "kitty", "iterm"):
        pts = [r for r in span if name in r]
        if len(pts) >= 2 and pts[-1]["t"] > pts[0]["t"]:
            res[name] = round(100 * (pts[-1][name] - pts[0][name]) / (pts[-1]["t"] - pts[0]["t"]), 1)
    return res


def upload_timing(out: Path, t0: float, marks: dict) -> dict:
    """While thinking: how long one picture's chunks take to reach kitty, how
    long kitty then has the whole picture before the next one starts, and the
    screen's frame rate (synchronized updates ended per second)."""
    first = last_end = None
    spans, idle, frames = [], [], []
    end = marks["stream_from"] or marks["done_at"] or turn_meta(out).get("t_end") or float("inf")
    try:
        src = open(series_file(out, "kitty.log"), errors="replace")
    except FileNotFoundError:
        return {}
    with src:
        for line in src:
            ts, _, rest = line.partition(" ")
            try:
                t = float(ts)
            except ValueError:
                continue
            if not (t0 + 2 <= t <= end):
                continue
            if rest.startswith("screen_reset_mode 2026"):
                frames.append(t)
            elif rest.startswith("graphics_command "):
                head = rest[: rest.find('"data_sz"')] if '"data_sz"' in rest else rest[:400]
                act = re.search(r'"action": "([^"]*)"', head)
                more = re.search(r'"more": (\d)', head)
                a = act.group(1).replace("\\u0000", "") if act else "?"
                if a == "T":
                    first = t
                elif a == "" and more and more.group(1) == "0" and first is not None:
                    spans.append((t - first) * 1000)
                    if last_end is not None:
                        idle.append((first - last_end) * 1000)
                    last_end, first = t, None
    med = lambda xs: round(sorted(xs)[len(xs) // 2], 1) if xs else None
    res = {"uploads": len(spans), "upload_ms_median": med(spans), "idle_ms_median": med(idle)}
    if spans and idle:
        res["picture_whole_share"] = round(sum(idle) / (sum(idle) + sum(spans)), 2)
    if len(frames) > 1:
        res["screen_frames_per_s"] = round((len(frames) - 1) / (frames[-1] - frames[0]), 1)
    return res


DEBUG_RE = re.compile(r"blit|deny|denied|refus|image|graphics|rainbow|spinner|plugin.*(error|fail)|\bERROR\b", re.I)


STAMP_RE = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)Z ")


def debug_digest(out: Path) -> dict:
    """The debug lines worth a look, counted; a series turn's own stretch only
    (from the end of the turn before, so its /clear and /spinner too)."""
    meta = turn_meta(out)
    try:
        lines = series_file(out, "debug.log").read_text(errors="replace").splitlines()
    except FileNotFoundError:
        return {}
    if "t_end" in meta:
        import calendar

        keep, inside = [], False
        for line in lines:
            m = STAMP_RE.match(line)
            if m:
                t = calendar.timegm(time.strptime(m.group(1).split(".")[0], "%Y-%m-%dT%H:%M:%S")) + float("0." + (m.group(1).split(".") + ["0"])[1])
                inside = meta["since"] <= t <= meta["t_end"]
            if inside:
                keep.append(line)
        lines = keep
    hits: dict[str, int] = {}
    samples: dict[str, str] = {}
    for line in lines:
        if not DEBUG_RE.search(line):
            continue
        body = re.sub(r"^\S+ ", "", line)
        key = re.sub(r"\d+", "#", body)[:160]
        hits[key] = hits.get(key, 0) + 1
        samples.setdefault(key, body[:400])
    top = sorted(hits.items(), key=lambda kv: -kv[1])[:40]
    return {"lines": len(lines), "matches": [{"n": n, "line": samples[k]} for k, n in top]}


def analyse(out: Path, quiet: bool = False) -> dict:
    from PIL import Image, ImageDraw

    win = json.loads((out / "window.json").read_text())
    cols, lines = win["columns"], win["lines"]
    geom = win.get("geom")
    frames = load_text(out)
    t0 = float((out / "t0").read_text()) if (out / "t0").exists() else frames[0]["t"]
    marks = phase_marks(frames)
    shots = sorted((out / "shots").glob("*.png"))
    rows: list[dict] = []
    strips = []
    cell_w = cell_h = None
    bg = None
    fi = 0
    for p in shots:
        ms = int(p.stem.split("-")[1])
        t = t0 + ms / 1000
        while fi + 1 < len(frames) and abs(frames[fi + 1]["t"] - t) <= abs(frames[fi]["t"] - t):
            fi += 1
        fr = frames[fi] if frames else None
        img = Image.open(p).convert("RGB")
        if geom:
            (x0, y0), cell_w, cell_h = grid_origin(geom, img.width, img.height), geom["cw"], geom["ch"]
        else:
            x0, y0, cell_w, cell_h = 0, 0, img.width / cols, img.height / lines
        if bg is None:
            bg = img.getpixel((img.width - 3, img.height // 3))
        rec = {"shot": p.name, "t": round(ms / 1000, 2), "phase": phase_of(t, marks), "text_dt": round(fr["t"] - t, 2) if fr else None}
        found = spinner_row(fr["ansi"]) if fr else None
        if found is None:
            rec |= {"spinner": False, "word": "no-spinner", "glyph_px": "-"}
            strips.append((rec, None))
        else:
            row, cs = found
            d = describe_row(cs, blank_word=geom is not None)
            px = classify_pixels(img, row, d, cell_w, cell_h, bg, x0, y0)
            rec |= {"spinner": True, "row": row} | d | px
            rec["word"] = word_state(d, px)
            ys = int(y0 + row * cell_h)
            strips.append((rec, img.crop((int(x0), ys, min(img.width, int(x0 + (d["word_cols"][1] + 36) * cell_w)), ys + int(cell_h)))))
        rows.append(rec)

    word_tab: dict[str, dict[str, int]] = {}
    glyph_tab: dict[str, dict[str, int]] = {}
    for r in rows:
        word_tab.setdefault(r["phase"], {}).setdefault(r["word"], 0)
        word_tab[r["phase"]][r["word"]] += 1
        glyph_tab.setdefault(r["phase"], {}).setdefault(r["glyph_px"], 0)
        glyph_tab[r["phase"]][r["glyph_px"]] += 1
    changes = sum(1 for a, b in zip(rows, rows[1:]) if a["word"] != b["word"] and a["phase"] == b["phase"] != "done")
    t_end = frames[-1]["t"] if frames else t0
    meta = turn_meta(out)
    report = {
        "arm": meta["turn"] | ({"launch": meta["launch"], "plugin_dir": meta["plugin_dir"]} if "launch" in meta else {}),
        "reply": meta.get("reply"),
        "turn_in_window": meta.get("index", 0) + 1,
        "dir": str(out),
        "shots": len(rows),
        "fps": round(len(rows) / max(0.1, rows[-1]["t"] - rows[0]["t"]), 1) if len(rows) > 1 else 0,
        "marks_s": {k: (round(v - t0, 2) if v else None) for k, v in marks.items()},
        "word_by_phase": word_tab,
        "glyph_by_phase": glyph_tab,
        "word_state_changes": changes,
        "graphics": graphics_stats(out, t0, t_end, marks),
        "uploads_while_thinking": upload_timing(out, t0, marks),
        "cpu_percent_while_thinking": cpu_stats(out, marks, t0),
        "debug": debug_digest(out),
    }
    (out / "frames.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False))
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))

    # Contact sheet: every shot's spinner line, labelled; and the same as a GIF.
    lh = int(cell_h or 48)
    lw = max((s.width for _, s in strips if s is not None), default=800)
    label_w = 560
    sheet = Image.new("RGB", (label_w + lw, lh * max(1, len(strips))), (24, 24, 24))
    dr = ImageDraw.Draw(sheet)
    tint = {"picture": (90, 210, 130), "alt": (230, 190, 70), "text": (130, 170, 255), "no-spinner": (220, 90, 90), "picture-blank": (255, 120, 60)}
    for i, (rec, s) in enumerate(strips):
        y = i * lh
        dr.text((6, y + 4), f"{rec['t']:6.2f}s  {rec['phase']:<9} {rec['word']:<14} glyph:{rec['glyph_px']}", fill=tint.get(rec["word"], (230, 230, 230)))
        dr.text((6, y + 22), f"{rec.get('word_text', '')[:28]}  {rec.get('tail', '')[:44]}", fill=(150, 150, 150))
        if s is not None:
            sheet.paste(s, (label_w, y))
    sheet.save(out / "sheet.png")
    if any(s is not None for _, s in strips):
        gif = []
        for rec, s in strips:
            c = Image.new("RGB", (lw, lh), bg or (0, 0, 0))
            if s is not None:
                c.paste(s, (0, 0))
            ImageDraw.Draw(c).text((lw - 200, 4), f"{rec['t']:.1f}s {rec['phase']}", fill=(200, 200, 200))
            gif.append(c.convert("P", palette=Image.ADAPTIVE))
        gif[0].save(out / "line.gif", save_all=True, append_images=gif[1:], duration=int(1000 / max(1, report["fps"])), loop=0)

    txt = [f"{report['arm']['label']}: {report['shots']} shots at {report['fps']}/s; answer streams from {report['marks_s']['stream_from']} s, turn done at {report['marks_s']['done_at']} s  ({out})"]
    for ph in ("thinking", "streaming", "done"):
        if ph in word_tab:
            txt.append(f"  {ph:<9} word {word_tab[ph]}  glyph {glyph_tab[ph]}")
    txt.append(f"  word state changes between shots (before done): {changes}")
    if report["reply"] is not None:
        txt.append(f"  /spinner reply: {report['reply']}")
    g = report["graphics"]
    if g:
        txt.append(f"  graphics: {g}")
    txt.append(f"  while thinking: {report['uploads_while_thinking']}  cpu% {report['cpu_percent_while_thinking']}")
    for m in report["debug"].get("matches", [])[:15]:
        txt.append(f"  debug x{m['n']}: {m['line'][:220]}")
    (out / "report.txt").write_text("\n".join(txt) + "\n")
    if not quiet:
        print("\n".join(txt), flush=True)
    return report


def analyse_quiet(out: Path) -> dict:
    return analyse(out, quiet=True)


def share(tab: dict, key: str, skip: str) -> str:
    n = sum(v for k, v in tab.items() if k != skip)
    return f"{100 * tab.get(key, 0) / n:3.0f}%" if n else "  - "


def summary_line(r: dict) -> str:
    """One row per turn: the /spinner reply, the share of thinking shots with
    the word as a picture and with the glyph drawn, CPU while thinking."""
    w = r["word_by_phase"].get("thinking", {})
    g = r["glyph_by_phase"].get("thinking", {})
    cpu = " ".join(f"{k} {v:4.1f}" for k, v in r["cpu_percent_while_thinking"].items())
    reply = r["reply"] if r["reply"] is not None else "(no /spinner)"
    n = sum(v for k, v in w.items() if k != "no-spinner")
    warm = f"turn {r.get('turn_in_window', 1)}" if r.get("turn_in_window", 1) > 1 else "fresh "
    return f"{r['arm']['label']:<14} {warm} {reply[:34]:<34} thinking {n:3d} shots: word picture {share(w, 'picture', 'no-spinner')} text {share(w, 'text', 'no-spinner')}  glyph {share(g, 'drawn', '-')}  cpu% {cpu}  {r['dir']}"


SWAP_METHODS = ["T", "T-slow", "ids-slow", "frame-slow"]


def analyse_swap(out: Path) -> dict:
    """kitty_swap.py's rows: in how many shots each method's picture is up while it runs."""
    import numpy as np
    from PIL import Image

    win = json.loads((out / "window.json").read_text())
    frames = load_text(out)
    t0 = float((out / "t0").read_text())
    seen: dict[str, list[int]] = {m: [0, 0] for m in SWAP_METHODS}
    fi = 0
    for p in sorted((out / "shots").glob("*.png")):
        t = t0 + int(p.stem.split("-")[1]) / 1000
        while fi + 1 < len(frames) and frames[fi + 1]["t"] <= t:
            fi += 1
        top = strip_ansi(frames[fi]["ansi"]).split("\n")[0].split() if frames else []
        if len(top) < 2 or top[0] != "running" or top[1] not in SWAP_METHODS:
            continue
        k = SWAP_METHODS.index(top[1])
        a = np.asarray(Image.open(p).convert("RGB")).astype(np.int16)
        cw, ch = a.shape[1] / win["columns"], a.shape[0] / win["lines"]
        row = 2 + 2 * k
        cell = a[int(row * ch) + 3 : int((row + 1) * ch) - 3, int(11 * cw) : int(18 * cw)]
        up = float(((cell.max(axis=2) - cell.min(axis=2)) > 60).mean()) > 0.5
        seen[top[1]][0] += up
        seen[top[1]][1] += 1
    report = {m: {"picture_up": v[0], "shots": v[1]} for m, v in seen.items()}
    (out / "report.json").write_text(json.dumps(report, indent=2))
    lines = [f"kitty, picture swapped every 40 ms under unicode placeholders ({out})"] + [f"  {m:<11} picture up in {v[0]:3d} of {v[1]:3d} shots" for m, v in seen.items()]
    (out / "report.txt").write_text("\n".join(lines) + "\n")
    print("\n".join(lines), flush=True)
    return report



def series_of(names: list[str], capture: str | None, plugin_dir: str | None, keep_focus: bool, reuse: bool) -> list[Series]:
    """Named arms into series: a window of its own per arm, or with reuse,
    arms that start their window alike share it, in the order first named,
    covered turns after the uncovered ones.

    A window of its own is what CPU numbers compare by: Claude costs less on
    each later turn of a session, and a covered turn after another one finds
    Claude told it lost focus, which a first turn never is (kitty sends focus-in
    when the cover closes and focus-out when the next one opens)."""
    groups: dict[object, list[Turn]] = {}
    for name in names:
        launch, turn = ARMS[name]
        groups.setdefault(launch if reuse else name, []).append(Turn(name, capture=capture or "turn", **turn))
    launches = {name: ARMS[name][0] for name in names}
    out = []
    for key, turns in groups.items():
        launch = launches[key] if isinstance(key, str) else key
        turns.sort(key=lambda t: t.background != "none")
        label = "_".join(t.label for t in turns) if len(turns) <= 3 else f"{turns[0].label}_{len(turns) - 1}-more"
        out.append(Series(label, launch, turns, None if launch.vanilla else plugin_dir, keep_focus))
    return out


def run_all(series: list[Series]) -> None:
    root = Path(os.environ.get("PROBE_OUT") or Path(tempfile.gettempdir()) / "rainbow-probe").resolve()
    started = time.time()
    lines = []
    for s in series:
        try:
            run_series(s, root)
        except Exception as err:  # one window failing does not stop the others
            print(f"[{s.label}] FAILED: {type(err).__name__}: {err}", flush=True)
            s.failed = s.failed or [f"{t.label}: {type(err).__name__}: {str(err).splitlines()[0] if str(err) else ''}" for t in s.turns]
            lines += [f"{f.split(': ', 1)[0]:<14} FAILED {f.split(': ', 1)[1]}" for f in s.failed]
            continue
        lines += (s.out / "summary.txt").read_text().splitlines()
    failed = sum(len(s.failed) for s in series)
    lines.append(f"{len(series)} windows, {sum(len(s.turns) for s in series)} turns, {failed} failed, {time.time() - started:.0f} s")
    print("\n".join(lines), flush=True)
    (root / f"summary-{time.strftime('%Y%m%d-%H%M%S')}.txt").write_text("\n".join(lines) + "\n")
    if failed:
        raise SystemExit(1)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("arms", help="named arms, or a set: " + ", ".join(f"{k} ({', '.join(v[0])})" for k, v in SETS.items()))
    a.add_argument("names", nargs="+", metavar="ARM", help="arms: " + " ".join(ARMS) + "; sets: smoke = " + " ".join(SETS["smoke"][0]) + " (thinking only), full = every kitty arm, iterm = every it-* arm")
    a.add_argument("--capture", choices=["turn", "thinking"], help="default: the set's (smoke: thinking), else turn")
    a.add_argument("--plugin-dir", default=str(MOD), help=f"mod folder (default {MOD})")
    a.add_argument("--keep-focus", action="store_true")
    a.add_argument("--reuse", action="store_true", help="arms that start alike share one window: faster, but CPU of a later turn is lower than a first turn's (screen checks only)")
    r = sub.add_parser("run", help="one window, one turn per style, as asked")
    r.add_argument("label")
    r.add_argument("--styles", "--style", default="", help="/spinner tags, one turn each: holo,bloom,temper (none: no /spinner)")
    r.add_argument("--render", choices=["normal", "main", "fullscreen", "settings"], default="normal", help="Claude's renderer: normal = main screen forced by env; main = main screen by --settings tui=default, not forced; settings = whatever settings.json says")
    r.add_argument("--plugin-dir", default=str(MOD), help=f"mod folder (default {MOD})")
    r.add_argument("--vanilla", action="store_true", help="no mod at all")
    r.add_argument("--env", action="append", default=[], metavar="K=V", help="set for Claude (repeatable)")
    r.add_argument("--unset", action="append", default=[], metavar="K", help="removed from Claude's environment (repeatable); 'KITTY*' removes every KITTY... name")
    r.add_argument("--no-kitty-id", action="store_true", help="= --unset KITTY_WINDOW_ID")
    r.add_argument("--term", choices=["kitty", "iterm"], default="kitty", help="the terminal: kitty (its own instance) or a new iTerm2 window")
    r.add_argument("--background", choices=["none", "tab", "minimise"], default="none", help="once the prompt is sent: another tab in front of Claude's, or the window minimised")
    r.add_argument("--capture", choices=["turn", "thinking"], default="turn")
    r.add_argument("--window", type=float, default=12.0, help="--capture thinking: seconds of thinking recorded")
    r.add_argument("--seconds", type=float, default=60, help="longest recording of a turn")
    r.add_argument("--model", default="haiku")
    r.add_argument("--prompt", default=PROMPT)
    r.add_argument("--keep-focus", action="store_true", help="leave the probe window focused (do not type meanwhile)")
    p = sub.add_parser("replay", help="kitty alone plays a recorded bytes.bin back")
    p.add_argument("label")
    p.add_argument("bytes")
    p.add_argument("--replay-args", default="", help="for replay_bytes.py: FRAME_MS, --no-sync, --no-blit")
    p.add_argument("--seconds", type=float, default=40)
    p.add_argument("--keep-focus", action="store_true")
    w = sub.add_parser("swap", help="kitty alone: how a picture swapped under placeholders shows (kitty_swap.py)")
    w.add_argument("--per-method", type=float, default=4.0, help="seconds per method")
    w.add_argument("--spread-ms", type=float, default=135.0, help="how long the slow methods take to send one picture")
    w.add_argument("--keep-focus", action="store_true")
    z = sub.add_parser("analyse", help="analyse a recorded turn again")
    z.add_argument("dir")
    args = ap.parse_args()

    if args.cmd == "analyse":
        d = Path(args.dir)
        arm = json.loads((d / "arm.json").read_text()) if (d / "arm.json").exists() else {}
        analyse_swap(d) if arm.get("swap") else analyse(d)
    elif args.cmd == "arms":
        names, capture = [], args.capture
        for n in args.names:
            if n in SETS:
                names += SETS[n][0]
                capture = capture or SETS[n][1]
            elif n in ARMS:
                names.append(n)
            else:
                raise SystemExit(f"no arm {n!r}; arms: {' '.join(ARMS)}; sets: {' '.join(SETS)}")
        run_all(series_of(list(dict.fromkeys(names)), capture, args.plugin_dir, args.keep_focus, args.reuse))
    elif args.cmd == "run":
        prompt = args.prompt if args.prompt == PROMPT or PROMPT_TAIL in args.prompt else f"{args.prompt} {PROMPT_TAIL}"
        styles = [m for m in args.styles.split(",") if m] or [None]
        unset = tuple(args.unset) + (("KITTY_WINDOW_ID",) if args.no_kitty_id else ())
        launch = Launch(args.term, args.render, args.vanilla, tuple(args.env), unset, args.model)
        names = [f"{args.label}-{m}" if m and len(styles) > 1 else args.label for m in styles]
        names = [f"{n}-{names[:k].count(n) + 1}" if names.count(n) > 1 else n for k, n in enumerate(names)]
        turns = [Turn(n, m, args.background, args.capture, args.window, args.seconds, prompt) for n, m in zip(names, styles)]
        run_all([Series(args.label, launch, turns, None if args.vanilla else args.plugin_dir, args.keep_focus)])
    elif args.cmd == "replay":
        cmd = ["/usr/bin/python3", str(Path(__file__).with_name("replay_bytes.py")), str(Path(args.bytes).resolve()), *args.replay_args.split()]
        out = run_plain(args.label, cmd, args.seconds, None, args.keep_focus)
        print(f"[{args.label}] recorded: {out}")
    elif args.cmd == "swap":
        cmd = ["/usr/bin/python3", str(Path(__file__).with_name("kitty_swap.py")), str(args.per_method), str(args.spread_ms), "30"]
        analyse_swap(run_plain("swap", cmd, 60, lambda plain: plain.lstrip().startswith("done"), args.keep_focus))


if __name__ == "__main__":
    main()
