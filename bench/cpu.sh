#!/bin/bash
# CPU cost of the spinner, measured live: for each arm, opens kitty, starts
# Claude (with the arm's plugin folder, or none for "vanilla"), picks the arm's
# style with /spinner when it names one (an arm with the mod and no style runs
# with nothing chosen: the default, off), sends one prompt that keeps it thinking,
# and reads the CPU seconds Claude and kitty spend over a WINDOW-second stretch
# of spinner. Arms interleave so drift hits all alike. The style kept in the
# store is put back at the end.
#
#   bench/cpu.sh 3 vanilla=- off=. temper=.:temper bloom=.:bloom   # REPS, then label=plugin-dir[:style]
set -u
REPS=$1; shift
WINDOW=${WINDOW:-20}
KITTY=/Applications/kitty.app/Contents/MacOS
PROMPT='Think very carefully and at length, then write a 900-word story about a lighthouse keeper. No tools.'

# The "style" key of each of the mod's store files, and putting it back: other
# sessions write the same files, so only that key is touched.
STORE=${STORE:-$HOME/.claude/plugins/store}
styles() {
  python3 -c 'import glob, json, sys
out = {}
for f in glob.glob(sys.argv[1] + "/rainbow-spinner_*.json"):
    try:
        data = json.load(open(f))
        out[f] = {"style": data["style"]} if "style" in data else {}
    except Exception: pass
print(json.dumps(out))' "$STORE"
}
restore() {
  python3 -c 'import glob, json, sys
saved = json.loads(sys.argv[1])
for f in glob.glob(sys.argv[2] + "/rainbow-spinner_*.json"):
    data = json.load(open(f))
    keep = saved.get(f, {})
    if data.get("style") == keep.get("style"): continue
    if "style" in keep: data["style"] = keep["style"]
    else: data.pop("style", None)
    open(f, "w").write(json.dumps(data, indent=2) + "\n")
    print(f"store restored: {f}: {keep}")' "$1" "$STORE"
}

clear_choice() {
  python3 -c 'import glob, json, sys
for f in glob.glob(sys.argv[1] + "/rainbow-spinner_*.json"):
    data = json.load(open(f))
    if "style" not in data: continue
    del data["style"]
    open(f, "w").write(json.dumps(data, indent=2) + "\n")' "$STORE"
}

desc() { for c in $(pgrep -P "$1"); do echo "$c"; desc "$c"; done; }
cpu() { ps -o cputime= -p "$1" | awk -F'[:.]' '{print $1*60+$2+("0."$3)}'; }

run() {
  local label=$1 dir=${2%%:*} style="" args=""
  [ "$dir" != "$2" ] && style=${2#*:}
  [ "$dir" != "-" ] && args="--plugin-dir $(cd "$dir" && pwd)"
  [ "$dir" != "-" ] && [ -z "$style" ] && clear_choice
  "$KITTY/kitty" --directory "$PWD" >/dev/null 2>&1 &
  local kp=$!
  for _ in $(seq 1 30); do [ -S "/tmp/kitty-$kp" ] && break; sleep 0.3; done
  local k="$KITTY/kitten @ --to unix:/tmp/kitty-$kp"
  $k send-text "command claude $args"; $k send-key enter; sleep 9
  if [ -n "$style" ]; then $k send-text "/spinner $style"; $k send-key enter; sleep 2; fi
  $k send-text "$PROMPT"; $k send-key enter; sleep 4
  local cp
  cp=$(for p in $(desc "$kp"); do ps -o pid=,comm= -p "$p"; done | awk '$2 ~ /claude/ {print $1; exit}')
  local c0 k0 c1 k1
  c0=$(cpu "$cp"); k0=$(cpu "$kp"); sleep "$WINDOW"; c1=$(cpu "$cp"); k1=$(cpu "$kp")
  local line
  line=$($k get-text | grep -E '\(([0-9]+m )?[0-9]+s' | tail -1)
  printf '%-10s claude %5.2fs  kitty %5.2fs  | %s\n' "$label" "$(echo "$c1-$c0" | bc)" "$(echo "$k1-$k0" | bc)" "$line"
  $k send-key ctrl+c; sleep 0.4; $k send-key ctrl+c; sleep 1
  kill -9 "$kp" 2>/dev/null
}

saved=$(styles)
trap 'restore "$saved"' EXIT
for _ in $(seq 1 "$REPS"); do
  for arm in "$@"; do run "${arm%%=*}" "${arm#*=}"; done
done
