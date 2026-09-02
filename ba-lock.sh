#!/usr/bin/env bash
# ba-lock.sh — advisory lock for a browser-agent profile lane.
#
# WHY: the relay routes commands per key to ONE browser profile's extension
# (keyIdx 0 = main Chrome, keyIdx 1 = alt Brave). Two processes driving the same
# lane at once interleave: the browser slows, page renders race (2026-09-01 the
# Staples buyer's cart gate tripped on a still-loading cart under a concurrent
# session), and a CDP debugger can be detached mid-command. The relay QUEUES
# commands per key so they do not corrupt each other, but it does not stop two
# callers from fighting over the same tabs.
#
# This is a COOPERATIVE, advisory lock: it only helps between callers that agree
# to take it. Money/irreversible jobs (staples, peloton-cancel, smbx-withdraw)
# should hold it while they drive; an interactive session can `status` before
# starting heavy browser work. It cannot stop a process that ignores it.
#
# The lock is per PROFILE (key index), not per tab. Atomic via mkdir. A holder
# whose PID is dead, or a lock older than its TTL, is stale and gets taken over.
#
# Usage:
#   ba-lock.sh acquire [--key N] [--owner LABEL] [--wait SECS] [--ttl SECS] [--pid PID]
#   ba-lock.sh release [--key N] [--owner LABEL] [--force]
#   ba-lock.sh status  [--key N] [--json]
#   ba-lock.sh with    [--key N] [--owner LABEL] [--wait SECS] [--ttl SECS] -- CMD [ARGS...]
#
# acquire exits 0 when held, 1 on timeout. `with` runs CMD under the lock and
# returns CMD's exit code (releasing even on crash via trap). status exits 0 if
# free/stale, 3 if a live lock is held by someone else.
set -euo pipefail

STATE_DIR="${BA_LOCK_DIR:-$HOME/.state}"
DEFAULT_TTL=900          # 15 min: a browser buy completes well inside this
DEFAULT_WAIT=0           # acquire returns immediately unless --wait given

KEY=0; OWNER="${BA_LOCK_OWNER:-$(basename "${0##*/}")-$$}"; WAIT=$DEFAULT_WAIT
TTL=$DEFAULT_TTL; FORCE=0; JSON=0; HOLDER_PID=$PPID

cmd="${1:?usage: acquire|release|status|with}"; shift || true

# Parse flags up to a bare `--` (which, for `with`, precedes the wrapped CMD).
CMDV=()
while [ $# -gt 0 ]; do
  case "$1" in
    --key)   KEY="$2"; shift 2 ;;
    --owner) OWNER="$2"; shift 2 ;;
    --wait)  WAIT="$2"; shift 2 ;;
    --ttl)   TTL="$2"; shift 2 ;;
    --pid)   HOLDER_PID="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --json)  JSON=1; shift ;;
    --)      shift; CMDV=("$@"); break ;;
    *)       echo "ba-lock: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

mkdir -p "$STATE_DIR"
LOCKDIR="$STATE_DIR/browser-agent-key${KEY}.lock.d"
META="$LOCKDIR/meta"

now() { date +%s; }

# Print meta fields: pid owner epoch host  (empty if no lock / unreadable).
read_meta() {
  [ -f "$META" ] && cat "$META" 2>/dev/null || true
}

pid_alive() { kill -0 "$1" 2>/dev/null; }

# Is the current lock stale (dead holder OR older than TTL)? echo 1/0.
is_stale() {
  local line pid epoch age
  line="$(read_meta)"; [ -z "$line" ] && { echo 1; return; }   # empty meta == stale
  pid="$(printf '%s' "$line"  | awk '{print $1}')"
  epoch="$(printf '%s' "$line"| awk '{print $3}')"
  [ -n "$pid" ] && pid_alive "$pid" || { echo 1; return; }
  age=$(( $(now) - ${epoch:-0} ))
  [ "$age" -ge "$TTL" ] && { echo 1; return; }
  echo 0
}

write_meta() { printf '%s %s %s %s\n' "$HOLDER_PID" "$OWNER" "$(now)" "$(hostname)" > "$META"; }

# Try once to take the lock atomically. 0 = got it, 1 = held by a live holder.
try_acquire() {
  if mkdir "$LOCKDIR" 2>/dev/null; then write_meta; return 0; fi
  if [ "$(is_stale)" = "1" ] || [ "$FORCE" = "1" ]; then
    rm -rf "$LOCKDIR" 2>/dev/null || true
    if mkdir "$LOCKDIR" 2>/dev/null; then write_meta; return 0; fi
  fi
  return 1
}

status_json() {
  local line pid owner epoch host age state="free"
  line="$(read_meta)"
  if [ -d "$LOCKDIR" ] && [ -n "$line" ]; then
    pid="$(printf '%s' "$line" | awk '{print $1}')"
    owner="$(printf '%s' "$line" | awk '{print $2}')"
    epoch="$(printf '%s' "$line" | awk '{print $3}')"
    host="$(printf '%s' "$line" | awk '{print $4}')"
    age=$(( $(now) - ${epoch:-0} ))
    if [ "$(is_stale)" = "1" ]; then state="stale"; else state="held"; fi
    printf '{"key":%s,"state":"%s","owner":"%s","pid":%s,"age":%s,"host":"%s"}\n' \
      "$KEY" "$state" "${owner:-?}" "${pid:-0}" "$age" "${host:-?}"
    [ "$state" = "held" ] && return 3 || return 0
  fi
  printf '{"key":%s,"state":"free"}\n' "$KEY"
  return 0
}

case "$cmd" in
  acquire)
    deadline=$(( $(now) + WAIT ))
    while :; do
      if try_acquire; then
        echo "$LOCKDIR"; exit 0
      fi
      [ "$(now)" -ge "$deadline" ] && break
      sleep 2
    done
    echo "ba-lock: key $KEY busy ($(read_meta))" >&2
    exit 1
    ;;

  release)
    line="$(read_meta)"
    holder_pid="$(printf '%s' "$line" | awk '{print $1}')"
    holder_owner="$(printf '%s' "$line" | awk '{print $2}')"
    if [ ! -d "$LOCKDIR" ]; then exit 0; fi
    if [ "$FORCE" = "1" ] || [ "$holder_owner" = "$OWNER" ] || [ "$holder_pid" = "$HOLDER_PID" ]; then
      rm -rf "$LOCKDIR" 2>/dev/null || true; exit 0
    fi
    echo "ba-lock: refuse to release key $KEY held by $holder_owner (pid $holder_pid); use --force" >&2
    exit 1
    ;;

  status)
    # status_json prints the JSON and returns 3 when a live lock is held. Guard
    # set -e so the non-zero return does not abort before we surface it, and so
    # the JSON is not swallowed exactly when a lock IS held.
    set +e; status_json; rc=$?; set -e
    exit $rc
    ;;

  with)
    [ "${#CMDV[@]}" -gt 0 ] || { echo "ba-lock with: need -- CMD" >&2; exit 2; }
    HOLDER_PID=$$
    deadline=$(( $(now) + WAIT ))
    got=0
    while :; do
      if try_acquire; then got=1; break; fi
      [ "$(now)" -ge "$deadline" ] && break
      sleep 2
    done
    if [ "$got" != "1" ]; then
      echo "ba-lock: key $KEY busy, not running '$OWNER' ($(read_meta))" >&2
      exit 1
    fi
    trap 'rm -rf "$LOCKDIR" 2>/dev/null || true' EXIT INT TERM
    # Guard set -e so a non-zero exit from the wrapped command is captured and
    # propagated cleanly (the trap still releases) instead of aborting here.
    set +e; "${CMDV[@]}"; rc=$?; set -e
    exit $rc
    ;;

  *)
    echo "ba-lock: unknown command '$cmd'" >&2; exit 2 ;;
esac
