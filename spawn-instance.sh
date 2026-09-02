#!/usr/bin/env bash
# spawn-instance.sh — launch an ISOLATED browser-agent instance from WSL.
#
# WHY: the relay routes commands per key to ONE browser profile's extension. Two
# jobs on the same profile contend (see ba-lock.sh). This spawns a SEPARATE
# Windows browser with its own persistent profile + the browser-agent extension,
# so it registers as its own relay lane and a job can drive it in true parallel
# isolation, never touching the main Chrome the user is working in.
#
# HARD LIMITS (read before relying on this):
#   1. A separate profile is a FRESH, LOGGED-OUT session. Any job that runs here
#      must log in itself. For sites with step-up auth (Staples OTP) that is a
#      real cost — this lane is best for logged-out or self-authenticating work.
#   2. The extension reads its key from chrome.storage.local, set via its popup,
#      and storage is per-profile. A brand-new profile has NO key, so the FIRST
#      launch needs a one-time popup bootstrap (below). After that the profile
#      dir persists the key across spawns.
#   3. The relay must accept this instance's key. agent-server.js takes extra
#      keys via BROWSER_AGENT_KEY_2 / _3 / BROWSER_AGENT_KEYS_EXTRA, but adding
#      one needs a relay redeploy+restart (deploy.sh) — schedule it for a window
#      when no other browser-agent session is mid-task.
#   4. Chrome may warn about / restrict --load-extension on very recent builds.
#      Brave (--browser brave) is the fallback isolated browser here.
#
# Usage:
#   spawn-instance.sh [--name NAME] [--browser chrome|brave] [--url URL] [--dry-run]
#
# Then, ONE TIME per new profile:
#   - a browser window opens; click the Browser Agent extension icon
#   - paste the instance key (the value you will set as BROWSER_AGENT_KEY_2)
#     and the relay apiUrl, Save
#   - on the relay host: add BROWSER_AGENT_KEY_2=<that value> to its .env and
#     redeploy/restart (deploy.sh), during an idle window
#   - verify:  BROWSER_AGENT_KEY=<that value> browser-cli ext-status  -> connected
#   - drive it: BROWSER_AGENT_KEY=<that value> browser-cli ensure <url>
set -euo pipefail

NAME="instance-2"; BROWSER="chrome"; URL="about:blank"; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --browser) BROWSER="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "spawn-instance: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

# Windows identity. Override via WIN_USER if the Windows account is not 'npeza'.
WIN_USER="${WIN_USER:-npeza}"
WSL_WINHOME="/mnt/c/Users/$WIN_USER"
WINHOME="C:\\Users\\$WIN_USER"

case "$BROWSER" in
  chrome) EXE="${CHROME_EXE:-/mnt/c/Program Files/Google/Chrome/Application/chrome.exe}" ;;
  brave)  EXE="${BRAVE_EXE:-/mnt/c/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe}" ;;
  *) echo "spawn-instance: --browser must be chrome|brave" >&2; exit 2 ;;
esac
[ -f "$EXE" ] || { echo "spawn-instance: browser exe not found: $EXE" >&2; exit 1; }

# Extension: the Windows checkout Chrome can read (NOT the WSL path).
EXT_WSL="$WSL_WINHOME/Documents/repos/browser-agent/extension"
EXT_WIN="$WINHOME\\Documents\\repos\\browser-agent\\extension"
[ -f "$EXT_WSL/manifest.json" ] || {
  echo "spawn-instance: extension not found at $EXT_WSL (pull the Windows checkout)" >&2; exit 1; }

# Persistent per-instance profile so the key + any login survive across spawns.
PROFILE_WSL="$WSL_WINHOME/browser-agent-profiles/$NAME"
PROFILE_WIN="$WINHOME\\browser-agent-profiles\\$NAME"
FIRST_RUN=0
[ -d "$PROFILE_WSL" ] || FIRST_RUN=1
mkdir -p "$PROFILE_WSL"

ARGS=(
  "--user-data-dir=$PROFILE_WIN"
  "--load-extension=$EXT_WIN"
  "--disable-extensions-except=$EXT_WIN"
  "--no-first-run"
  "--no-default-browser-check"
  "--new-window" "$URL"
)

if [ "$DRY" = "1" ]; then
  echo "[dry-run] would launch $BROWSER isolated instance '$NAME'"
  echo "  exe:     $EXE"
  echo "  profile: $PROFILE_WIN  (first-run: $([ "$FIRST_RUN" = 1 ] && echo yes || echo no))"
  echo "  ext:     $EXT_WIN"
  printf '  cmd:     "%s"' "$EXE"; printf ' %q' "${ARGS[@]}"; printf '\n'
  exit 0
fi

echo "spawn-instance: launching $BROWSER instance '$NAME' (profile $PROFILE_WIN)"
# Detach so the browser outlives this shell; WSL interop runs the Windows exe.
setsid nohup "$EXE" "${ARGS[@]}" >/dev/null 2>&1 < /dev/null &
disown || true
sleep 2
echo "spawn-instance: launched (pid $!)."
if [ "$FIRST_RUN" = "1" ]; then
  cat <<EOF

  FIRST RUN for profile '$NAME' — one-time key bootstrap:
    1. In the new window, open the Browser Agent extension popup.
    2. Paste the instance key + relay apiUrl, Save.
    3. Add BROWSER_AGENT_KEY_2=<that key> to the relay .env and redeploy
       (deploy.sh) during an idle window; the relay already accepts it.
    4. Verify:  BROWSER_AGENT_KEY=<that key> browser-cli ext-status
EOF
fi
