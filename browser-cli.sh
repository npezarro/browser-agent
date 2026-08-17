#!/usr/bin/env bash
# browser-cli.sh — Synchronous CLI for controlling a remote browser via the browser-agent server.
#
# Usage:
#   browser-cli.sh <command> [args...]
#
# Commands:
#   tabs                          List active browser tabs
#   state [tabId]                 Get full page state (buttons, inputs, text)
#   text [tabId] [maxLen]         Get body text
#   html <selector> [tabId]       Get innerHTML of element
#   click <"text"|selector> [tabId]  Click a button/link
#   navigate <url> [tabId]        Navigate current tab to URL
#   open <url> [tabId]            Open URL in new tab
#   open --bg <url>              Open URL in background tab (extension required)
#   close [tabId]                 Close tab
#   focus <url>                   Focus tab by URL (extension required)
#   ext-status                    Check companion extension connection + version drift
#   ext-reload                    Reload the extension remotely (no chrome://extensions visit)
#   ensure <url> [wait_s]         Reuse or open tab for URL, return tabId
#   back [tabId]                  Go back
#   reload [tabId]                Reload page
#   eval <code> [tabId]           Execute JS in page context
#   query <selector> [tabId]      querySelector
#   queryall <selector> [tabId]   querySelectorAll
#   read <selector> [tabId]       Read element text
#   set-input <selector> <value> [tabId]  Set input value
#   type <selector> <text> [tabId]  Type text with keystrokes
#   fill <json> [tabId]           Fill form: {"#id": "value", ...}
#   select <selector> <value> [tabId]  Select dropdown option
#   wait <ms> [tabId]             Wait N milliseconds
#   wait-for <selector> [timeout] [tabId]  Wait for element
#   wait-text <text> [timeout] [tabId]  Wait for text to appear
#   assert-text <text> [tabId]    Assert text exists on page
#   assert-no-text <text> [tabId] Assert text does NOT exist
#   assert <selector> [tabId]     Assert element exists
#   assert-not <selector> [tabId] Assert element does NOT exist
#   console [count] [tabId]       Get console logs
#   errors [tabId]                Get network/console errors
#   logs [since]                  Get agent logs
#   health                        Server health check
#   network-capture <pattern> [tabUrl]  Capture XHR responses matching URL pattern
#   click-any <"text"> [tabId]       Click any element with matching text (wider than click)
#   upload <selector> <filepath> [tabId] [--drag-drop]  Upload file to input
#   ping [tabId]                  Ping browser agent
#   wait-render [minLen] [timeout] [tabId]  Wait for SPA body to hydrate
#   screenshot [out] [url] [--full] [--selector CSS] [--format png|jpeg|webp] [--quality N] [--blob]
#                                 Capture screenshot. --full = whole page (CDP), --selector = element only.
#                                 --blob returns a relay-hosted URL instead of writing to disk.
#   see "<question>" [url] [...]  Capture screenshot and ask Claude a question about it
#   fingerprint-audit [tabId]     Read-only report of how this browser looks to bot
#                                 mitigation, plus a `flags` array of inconsistencies.
#                                 Diagnoses; never spoofs. See the command for why.
#
# Flags (append to click/click-any):
#   --nth N                       Click the Nth match (default: 1st)
#
# Flags (append to cdp-click/cdp-type) — ext 2.12.0+:
#   --fast                        Skip humanized kinematics (old teleport/metronome
#                                 path). Faster and deterministic; use when the page
#                                 does no behavioural scoring.
#   --seed N                      Pin the RNG so an interaction replays exactly.
#   --delay MS                    cdp-type only: MEAN inter-key interval (def. 105).
#
# Cowork commands:
#   cowork-status                 Check if Cowork panel is active
#   cowork-attach                 Remote-attach debugger to Cowork panel
#   cowork-detach                 Remote-detach debugger
#   cowork-scrape                 Trigger immediate scrape
#   cowork-sessions [--today]     List captured Cowork sessions
#   cowork-read <session-id>      Read a specific session's content
#   cowork-start "goal" [--instructions file.md]  Queue a new Cowork session
#   cowork-export [session-id]    Export session to my-claude-cowork format
#   cowork-sync                   Sync all captured sessions to git + Discord
#
# Environment:
#   BROWSER_AGENT_URL   Server URL (default: https://pezant.ca/api/browser-agent)
#   BROWSER_AGENT_KEY   Auth key (required)
#   BROWSER_AGENT_TAB   Default tab ID (auto-detected if omitted)

set -euo pipefail

API="${BROWSER_AGENT_URL:-https://pezant.ca/api/browser-agent}"
KEY="${BROWSER_AGENT_KEY:?BROWSER_AGENT_KEY not set — add to ~/.bashrc or export it}"
DEFAULT_TAB="${BROWSER_AGENT_TAB:-}"
TIMEOUT=30

# ── Helpers ──

auth_header="Authorization: Bearer $KEY"

# A relay tab id, as minted by the content script and printed by `tabs`/`ensure`:
# <epoch_ms>-<4 random base36 chars>.
is_tab_id() {
  [[ "$1" =~ ^[0-9]{10,}-[A-Za-z0-9]{2,8}$ ]]
}

# The cdp-*/capture/extract commands take one optional target argument that may
# be either a relay tab id or a URL substring. Classify it into CDP_TAB / CDP_URL.
#
# This used to be read as a URL substring unconditionally, so passing a tab id
# sent `url:"<tab id>"`, which matched no tab. The extension then silently fell
# back to the focused tab, and the command ran against a page the caller never
# named — a cdp-eval aimed at one site could read whatever was focused,
# including a logged-in credential page. The extension now refuses that
# fallback; this makes the tab id actually reach it.
split_target() {
  CDP_TAB=""
  CDP_URL=""
  CDP_CHROME_TAB=""
  local t="${1:-}"
  if [ -z "$t" ]; then
    CDP_TAB="$DEFAULT_TAB"
  elif [[ "$t" =~ ^[0-9]+$ ]]; then
    # A bare integer is a CHROME tab id (what `open` and `tabs` return as
    # chromeTabId). Unambiguous against a relay tab id, which is always
    # `<epoch_ms>-<rand>` and therefore never all-digits. No digit cap: Chrome
    # tab ids routinely exceed 9 digits (seen 1400363481), and a cap silently
    # routed those to the URL-substring branch, where they matched nothing. This is the strongest targeting primitive the extension
    # accepts and, until 2.11.0, there was no way to send one -- so every
    # unattended command was forced onto the relay tab id, which lives in page
    # sessionStorage and therefore survives navigation. It is also the ONLY
    # usable primitive on origins excluded from the content script (the hotel
    # chains), where no relay tab id is ever minted.
    CDP_CHROME_TAB="$t"
  elif is_tab_id "$t"; then
    CDP_TAB="$t"
  else
    CDP_URL="$t"
  fi
}

# Extra JSON fields merged into an interactive command: the resolved Chrome tab
# id plus any caller-supplied origin containment. Emitted as a JSON OBJECT so it
# composes with the jq builders every command already uses.
#
#   BA_ALLOW_ORIGINS='["https://www.hyatt.com"]' browser-cli cdp-eval "expr" 12345
#
# BA_UNSAFE_ALLOW_SENSITIVE=1 opts into the hard-denied origins (bank/identity
# pages). The relay logs every use, so it can never be accidental.
target_json() {
  jq -nc \
    --arg ct "${CDP_CHROME_TAB:-}" \
    --arg ao "${BA_ALLOW_ORIGINS:-}" \
    --arg us "${BA_UNSAFE_ALLOW_SENSITIVE:-}" \
    '(if $ct != "" then {chromeTabId: ($ct|tonumber)} else {} end)
     + (if $ao != "" then {allowOrigins: ($ao|fromjson)} else {} end)
     + (if $us == "1" then {unsafeAllowSensitive: true} else {} end)'
}

# Synchronous command: POST to /agent/interactive, block for result
interactive() {
  local tab_id="${1:-}"
  local command_json="$2"
  local timeout="${3:-$TIMEOUT}"

  local body
  if [ -n "$tab_id" ]; then
    body=$(jq -nc --arg tid "$tab_id" --argjson cmd "$command_json" --argjson to "$((timeout * 1000))" \
      '{tabId: $tid, command: $cmd, timeout: $to}')
  else
    body=$(jq -nc --argjson cmd "$command_json" --argjson to "$((timeout * 1000))" \
      '{command: $cmd, timeout: $to}')
  fi

  local resp
  resp=$(curl -s -m "$((timeout + 5))" -X POST "$API/agent/interactive" \
    -H "Content-Type: application/json" \
    -H "$auth_header" \
    -d "$body")

  local ok
  ok=$(echo "$resp" | jq -r '.ok // false')
  if [ "$ok" = "true" ]; then
    echo "$resp" | jq -r '.result'
  else
    local err
    err=$(echo "$resp" | jq -r '.error // "Unknown error"')
    echo "ERROR: $err" >&2
    echo "$resp" | jq '.' 2>/dev/null || echo "$resp"
    return 1
  fi
}

# ── Commands ──

cmd="${1:-help}"
shift || true

case "$cmd" in

  tabs)
    curl -s "$API/agent/tabs" -H "$auth_header" | jq '{count, tabs: [.tabs | to_entries[] | {id: .key, url: .value.url, title: .value.title, age: (now - .value.receivedAt/1000 | floor | tostring + "s")}]}'
    ;;

  state)
    interactive "${1:-$DEFAULT_TAB}" '{"action":"getState"}'
    ;;

  text)
    local_tab="${1:-$DEFAULT_TAB}"
    local_max="${2:-5000}"
    interactive "$local_tab" "$(jq -nc --argjson m "$local_max" '{action:"getBodyText", maxLen:$m}')"
    ;;

  html)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" '{action:"getHtml", selector:$s}')"
    ;;

  click)
    local_target="${1:?text or selector required}"
    shift
    local_tab="$DEFAULT_TAB"
    local_nth=""
    # Parse remaining args: [tabId] [--nth N]
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --nth) local_nth="${2:?--nth requires a number}"; shift 2 ;;
        *) if [ -z "$local_tab" ] || [ "$local_tab" = "$DEFAULT_TAB" ]; then local_tab="$1"; fi; shift ;;
      esac
    done
    # If starts with . # or [ treat as selector, otherwise as text
    if [[ "$local_target" =~ ^[.#\[] ]]; then
      if [ -n "$local_nth" ]; then
        interactive "$local_tab" "$(jq -nc --arg s "$local_target" --argjson n "$local_nth" '{action:"click", selector:$s, nth:$n}')"
      else
        interactive "$local_tab" "$(jq -nc --arg s "$local_target" '{action:"click", selector:$s}')"
      fi
    else
      if [ -n "$local_nth" ]; then
        interactive "$local_tab" "$(jq -nc --arg t "$local_target" --argjson n "$local_nth" '{action:"click", text:$t, nth:$n}')"
      else
        interactive "$local_tab" "$(jq -nc --arg t "$local_target" '{action:"click", text:$t}')"
      fi
    fi
    ;;

  navigate|nav|goto)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg u "${1:?url required}" '{action:"navigate", url:$u}')"
    ;;

  open|open-tab)
    local_open_url="${1:?url required}"
    local_open_tab="${2:-$DEFAULT_TAB}"
    # --bg or --background flag opens tab without stealing focus (requires extension)
    if [[ "$1" == "--bg" || "$1" == "--background" ]]; then
      local_open_url="${2:?url required}"
      local_open_tab="${3:-$DEFAULT_TAB}"
      interactive "$local_open_tab" "$(jq -nc --arg u "$local_open_url" '{action:"openTabBackground", url:$u}')"
    elif [[ "${2:-}" == "--bg" || "${2:-}" == "--background" ]]; then
      interactive "$local_open_tab" "$(jq -nc --arg u "$local_open_url" '{action:"openTabBackground", url:$u}')"
    else
      interactive "$local_open_tab" "$(jq -nc --arg u "$local_open_url" '{action:"openTab", url:$u}')"
    fi
    ;;

  close|close-tab)
    split_target "${1:-}"
    interactive "$CDP_TAB" "$(jq -nc --arg u "$CDP_URL" --argjson t "$(target_json)" \
      '{action:"closeTab"} + $t + if $u != "" then {url:$u} else {} end')"
    ;;

  focus)
    # Focus a tab by chrome tab id, relay tab id, or URL substring.
    #
    # Previously URL-ONLY: a bare chromeTabId was sent as url:"<id>", matched no
    # tab, and returned "Target tab not found (url match ...)". Same incomplete
    # -plumbing class as the cdp-* verbs -- fixing split_target alone did not
    # reach the commands that build their own JSON.
    split_target "${1:?target required}"
    interactive "$CDP_TAB" "$(jq -nc --arg u "$CDP_URL" --argjson t "$(target_json)" \
      '{action:"focusTab"} + $t + if $u != "" then {url:$u} else {} end')"
    ;;

  ext-status)
    # Check if companion extension is connected. `stale:true` means the browser is
    # running older code than this checkout ships — run `ext-reload`.
    curl -s "$API/ext/status" -H "$auth_header" | jq .
    ;;

  ext-health)
    # Four-state liveness probe. `ext-status` alone is NOT sufficient: it proves
    # only that the background service worker is POLLING, and there are two
    # real states where it reports connected:true with a fresh heartbeat while
    # the browser is unusable for the thing you want to do.
    #
    #   green     everything works
    #   cdp-only  content script throttled (window minimised / occluded /
    #             display off). ping/state/text/eval/click all time out; cdp-*
    #             and the service worker keep working. THIS IS THE EXPECTED
    #             OVERNIGHT STATE -- proceed with cdp-* verbs, do not alert.
    #   red       browser genuinely unreachable
    #
    # Step 4 is the anti-regression gate for the 2026-07-30 wrong-tab bug: it
    # asserts a NAMED target resolves by chromeTabId/registry and lands on the
    # expected origin. An unattended job must run this before touching anything
    # sensitive, and abort if it ever reports resolvedBy=activeTab.
    probe_nonce="ba-$(date +%s)-$RANDOM"
    # Derived from the configured relay URL, never hardcoded: the probe must
    # land on whatever deployment this CLI actually talks to, and this file is
    # in a public repo.
    probe_origin="$(printf '%s' "$API" | sed -E 's#^(https?://[^/]+).*#\1#')"
    probe_url="${probe_origin}/travel/api/health?ba=${probe_nonce}"

    hs="$(curl -s -m 10 "$API/ext/status" -H "$auth_header")"
    bg_connected="$(echo "$hs" | jq -r '.connected // false')"
    ext_ver="$(echo "$hs" | jq -r '.version // "?"')"
    exp_ver="$(echo "$hs" | jq -r '.expectedVersion // "?"')"
    is_stale="$(echo "$hs" | jq -r '.stale // false')"

    background="down"; worker="down"; content="down"; cdp="down"; resolved_by=""
    [ "$bg_connected" = "true" ] && background="ok"

    if [ "$background" = "ok" ]; then
      # Does the worker actually EXECUTE, or does it merely poll? A fresh
      # heartbeat with a hung command loop is a real state ext-status cannot see.
      tabs_out="$(interactive "" '{"action":"queryTabs"}' 12 2>/dev/null)"
      echo "$tabs_out" | jq -e '.tabs' >/dev/null 2>&1 && worker="ok" || worker="timeout"
    fi

    if [ "$worker" = "ok" ]; then
      # Open OUR OWN origin with a nonce, so this can never collide with an
      # existing tab -- including one belonging to the other browser profile,
      # which `ensure` would happily return (both keys see the union of tabs).
      open_out="$(interactive "" "$(jq -nc --arg u "$probe_url" \
        '{action:"openTabBackground", url:$u}')" 20 2>/dev/null)"
      probe_tab="$(echo "$open_out" | jq -r '.chromeTabId // empty')"

      if [ -n "$probe_tab" ]; then
        sleep 2
        # Content script alive AND unthrottled?
        ping_out="$(interactive "" "$(jq -nc --argjson c "$probe_tab" \
          '{action:"ping", chromeTabId:$c}')" 10 2>/dev/null)"
        echo "$ping_out" | jq -e '.pong // .ok // .alive' >/dev/null 2>&1 \
          && content="ok" || content="throttled"

        # CDP path AND correct targeting.
        cdp_out="$(CDP_CHROME_TAB="$probe_tab" interactive "" "$(jq -nc --argjson c "$probe_tab" \
          '{action:"cdpEval", expression:"location.origin", awaitPromise:false, chromeTabId:$c}')" 25 2>/dev/null)"
        resolved_by="$(echo "$cdp_out" | jq -r '.resolvedBy // "?"')"
        cdp_origin="$(echo "$cdp_out" | jq -r '.value // ""')"
        if [ "$cdp_origin" = "$probe_origin" ] && [ "$resolved_by" != "activeTab" ]; then
          cdp="ok"
        elif [ -n "$cdp_origin" ]; then
          cdp="mistarget"
        fi
        interactive "" "$(jq -nc --argjson c "$probe_tab" '{action:"closeTab", chromeTabId:$c}')" 10 >/dev/null 2>&1
      fi
    fi

    verdict="red"
    if [ "$cdp" = "ok" ] && [ "$content" = "ok" ]; then verdict="green"
    elif [ "$cdp" = "ok" ]; then verdict="cdp-only"; fi
    # A mistarget is never "degraded" -- it means containment failed.
    [ "$cdp" = "mistarget" ] && verdict="red"

    jq -nc --arg b "$background" --arg w "$worker" --arg c "$content" \
      --arg d "$cdp" --arg v "$verdict" --arg ev "$ext_ver" --arg xv "$exp_ver" \
      --arg rb "$resolved_by" --argjson st "${is_stale:-false}" \
      '{background:$b, workerExec:$w, contentScript:$c, cdp:$d,
        extVersion:$ev, expectedVersion:$xv, stale:$st, resolvedBy:$rb, verdict:$v}'
    [ "$verdict" = "red" ] && exit 1 || exit 0
    ;;

  ext-reload)
    # Reload the extension remotely, so a deployed change takes effect without
    # anyone opening chrome://extensions. Pull the Windows checkout FIRST (Chrome
    # loads from there, not WSL) or this just reloads the same code.
    #
    # The browser is a SINGLETON: there is one extension, and two sessions reloading
    # it at once means each can tear down the other's service worker mid-verify and
    # then read the other's version back. Serialize on the shared resource lock when
    # it is available (agentGuidance may be absent on the VM, so this is optional).
    LOCK="$HOME/repos/agentGuidance/scripts/with-resource-lock.sh"
    if [ -x "$LOCK" ] && [ -z "${BROWSER_AGENT_NO_LOCK:-}" ]; then
      exec "$LOCK" browser-extension --timeout 180 -- \
        env BROWSER_AGENT_NO_LOCK=1 "$0" ext-reload "$@"
    fi
    interactive "" '{"action":"reloadExtension"}' 15 || true
    echo "Waiting for the extension to come back..." >&2
    for _ in $(seq 15); do
      sleep 2
      status=$(curl -s "$API/ext/status" -H "$auth_header")
      if [ "$(echo "$status" | jq -r '.connected')" = "true" ]; then
        echo "$status" | jq .
        # `stale` is tri-state: null means the extension is too old to report its
        # version, which after a reload means the reload did not take. Treat
        # anything that isn't an explicit `false` as a failure.
        case "$(echo "$status" | jq -r '.stale')" in
          false) exit 0 ;;
          true)  echo "ERROR: reloaded but still stale — pull the Windows checkout at /mnt/c/Users/npeza/Documents/repos/browser-agent" >&2; exit 1 ;;
          *)     echo "ERROR: extension did not report a version — it is still running pre-2.10.0 code; one manual chrome://extensions reload is needed to bootstrap" >&2; exit 1 ;;
        esac
      fi
    done
    echo "ERROR: extension did not reconnect within 30s" >&2
    exit 1
    ;;

  screenshot|capture)
    # Capture a tab as an image. Saves to file by default, or returns a blob URL.
    # Usage:
    #   browser-cli screenshot [output_path] [url_to_focus]
    #   browser-cli screenshot [output_path] [url] [--full] [--selector CSS] [--format png|jpeg|webp] [--quality N] [--blob]
    local_output=""
    local_focus_url=""
    local_full="false"
    local_selector=""
    local_format=""
    local_quality=""
    local_to_blob="false"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --full|--fullpage|--full-page) local_full="true"; shift ;;
        --selector) local_selector="${2:?--selector requires a CSS selector}"; shift 2 ;;
        --format) local_format="${2:?--format requires png|jpeg|webp}"; shift 2 ;;
        --quality) local_quality="${2:?--quality requires a number}"; shift 2 ;;
        --blob) local_to_blob="true"; shift ;;
        *)
          if [ -z "$local_output" ]; then local_output="$1"
          elif [ -z "$local_focus_url" ]; then local_focus_url="$1"
          fi
          shift ;;
      esac
    done

    # Default format: png unless format/blob specified
    if [ -z "$local_format" ]; then local_format="png"; fi

    # Default output path (only relevant if not --blob)
    if [ "$local_to_blob" != "true" ] && [ -z "$local_output" ]; then
      local_output="/tmp/screenshot-$(date +%s).${local_format}"
    fi

    # Choose action: fast captureTab for viewport+png; CDP captureAdvanced for everything else
    local_advanced="false"
    if [ "$local_full" = "true" ] || [ -n "$local_selector" ] || [ "$local_format" = "webp" ] || \
       { [ "$local_format" = "jpeg" ] && [ -n "$local_quality" ]; }; then
      local_advanced="true"
    fi

    if [ "$local_advanced" = "true" ]; then
      local_action="captureAdvanced"
    else
      local_action="captureTab"
    fi

    # The target argument may be a relay tab id or a URL substring; only the
    # latter belongs in the command's `url` field.
    split_target "$local_focus_url"

    # Build command JSON
    local_capture_args=$(jq -nc \
      --arg action "$local_action" \
      --arg url "$CDP_URL" \
      --arg fmt "$local_format" \
      --arg sel "$local_selector" \
      --argjson full "$local_full" \
      --arg q "$local_quality" \
      '{action:$action}
       + (if $url != "" then {url:$url} else {} end)
       + (if $sel != "" then {selector:$sel} else {} end)
       + (if $full then {fullPage:true} else {} end)
       + (if $fmt != "" then {format:$fmt} else {} end)
       + (if $q != "" then {quality:($q|tonumber)} else {} end)')

    result=$(interactive "$CDP_TAB" "$local_capture_args" 90)
    dataUrl=$(echo "$result" | jq -r '.result.dataUrl // .dataUrl // empty')
    if [ -z "$dataUrl" ]; then
      echo "ERROR: No screenshot data returned" >&2
      echo "$result" >&2
      exit 1
    fi

    if [ "$local_to_blob" = "true" ]; then
      # Strip data: prefix, send base64 to relay blob store, return retrieval URL
      b64=$(echo "$dataUrl" | sed 's/^data:image\/[a-z]*;base64,//')
      mime=$(echo "$dataUrl" | sed -n 's/^data:\(image\/[a-z]*\);base64,.*/\1/p')
      [ -z "$mime" ] && mime="image/png"
      blob_id="shot-$(date +%s)-$$"
      blob_resp=$(curl -s -m 30 -X POST "$API/agent/upload-blob" \
        -H "Content-Type: application/json" \
        -H "$auth_header" \
        -d "$(jq -nc --arg id "$blob_id" --arg b "$b64" --arg fn "${blob_id}.${local_format}" --arg mt "$mime" \
              '{blobId:$id, base64:$b, filename:$fn, mimetype:$mt}')")
      ok=$(echo "$blob_resp" | jq -r '.ok // false')
      if [ "$ok" != "true" ]; then
        echo "ERROR: Blob upload failed" >&2
        echo "$blob_resp" >&2
        exit 1
      fi
      jq -nc --arg id "$blob_id" --arg url "$API/agent/blob/$blob_id" \
        '{blobId:$id, url:$url, expiresInSec:300, note:"requires X-Agent-Secret header to fetch"}'
    else
      # Strip data: prefix, decode to file
      echo "$dataUrl" | sed 's/^data:image\/[a-z]*;base64,//' | base64 -d > "$local_output"
      size=$(stat -c%s "$local_output" 2>/dev/null || stat -f%z "$local_output" 2>/dev/null)
      jq -nc --arg path "$local_output" --argjson size "$size" --arg fmt "$local_format" \
        '{saved:$path, size:$size, format:$fmt}'
    fi
    ;;

  see|vision)
    # Capture a screenshot and ask Claude a question about it.
    # Usage: browser-cli see "<question>" [url_to_focus] [--full] [--selector CSS] [--format jpeg|png|webp] [--quality N]
    local_question="${1:?question required}"
    shift
    # Force jpeg unless overridden, for faster vision turnaround
    local_vision_fmt="${BROWSER_AGENT_VISION_FORMAT:-jpeg}"
    set -- "$@" --format "$local_vision_fmt"
    # The temp file extension must match the format. The vision step reads the
    # file with the Read tool, which only renders recognized image extensions;
    # a generic .img suffix comes back as raw bytes and the question fails.
    case "$local_vision_fmt" in
      jpeg|jpg) local_vision_ext="jpg" ;;
      *)        local_vision_ext="$local_vision_fmt" ;;
    esac
    tmp_shot="/tmp/see-$(date +%s)-$$.${local_vision_ext}"
    # Reuse screenshot logic by recursing into ourselves
    if ! "$0" screenshot "$tmp_shot" "$@" >/dev/null 2>&1; then
      "$0" screenshot "$tmp_shot" "$@" >&2 || exit 1
    fi
    if [ ! -s "$tmp_shot" ]; then
      echo "ERROR: capture produced empty file" >&2
      exit 1
    fi
    if ! command -v claude >/dev/null 2>&1; then
      echo "ERROR: 'claude' CLI not on PATH; cannot answer vision question" >&2
      echo "{\"capturedTo\":\"$tmp_shot\"}"
      exit 1
    fi
    # Hand the image to claude -p via the Read tool (matches fb-marketplace-poster pattern)
    claude -p --allowedTools Read <<EOF
Use the Read tool to view this image: $tmp_shot

Then answer this question about what you see, concisely (no preamble):

$local_question
EOF
    ;;

  ensure)
    # Open URL in a tab if no existing tab matches. Returns the tabId.
    # Usage: browser-cli ensure <url> [wait_seconds]
    #
    # /agent/tabs is a SINGLE un-keyed registry: every key sees the union of
    # tabs from BOTH browser profiles (main Chrome + alt Brave), while commands
    # are routed per key to one profile's extension. So a URL match is NOT proof
    # that the tab is ours to drive. Reusing a foreign tab returns an id that
    # every later read times out on, and a caller that treats "no text" as
    # benign then reports on a profile it never touched (2026-08: the alt
    # keepalive certified the MAIN profile's claude.ai session for six weeks
    # while the alt session aged out and logged itself out).
    #
    # Ownership is not knowable from the registry, so probe for it: a keyed
    # `ping` reaches our extension only. Timeout => the tab is another
    # profile's, so fall through and open our own.
    local_url="${1:?url required}"
    local_wait="${2:-6}"
    # Candidate tabs matching this URL (prefix match), newest first.
    candidates=$(curl -s "$API/agent/tabs" -H "$auth_header" | jq -r --arg u "$local_url" \
      '[.tabs | to_entries[] | select(.value.url | startswith($u)) | .key] | sort | reverse | .[]')
    existing=""
    for cand in $candidates; do
      if interactive "$cand" '{"action":"ping"}' 8 2>/dev/null \
           | jq -e '.pong // .ok // .alive' >/dev/null 2>&1; then
        existing="$cand"
        break
      fi
    done
    if [ -n "$existing" ]; then
      echo "{\"tabId\":\"$existing\",\"action\":\"reused\",\"ownership\":\"verified\",\"url\":\"$local_url\"}"
    else
      # Open new tab (uses extension for background open if available, falls back to TM)
      interactive "" "$(jq -nc --arg u "$local_url" '{action:"openTabBackground", url:$u}')" > /dev/null 2>&1
      # Wait for the new tab to register. Same ownership caveat: only accept a
      # tab our own extension answers for, else a foreign tab that happens to
      # match the URL wins the race and we hand back an undrivable id.
      for i in $(seq 1 "$local_wait"); do
        sleep 1
        found=$(curl -s "$API/agent/tabs" -H "$auth_header" | jq -r --arg u "$local_url" \
          '[.tabs | to_entries[] | select(.value.url | startswith($u)) | .key] | sort | reverse | .[]')
        for cand in $found; do
          if interactive "$cand" '{"action":"ping"}' 8 2>/dev/null \
               | jq -e '.pong // .ok // .alive' >/dev/null 2>&1; then
            echo "{\"tabId\":\"$cand\",\"action\":\"opened\",\"ownership\":\"verified\",\"url\":\"$local_url\"}"
            exit 0
          fi
        done
      done
      # Some origins (accounts.google.com, myaccount.google.com, chrome://)
      # refuse content scripts outright, so `ping` can NEVER answer there and
      # ownership is unknowable by design. Still hand back a matching tab: we
      # just opened one, and returning nothing would open another on every run
      # (the tab accumulation this verb exists to prevent). Flag it so callers
      # do not mistake "could not verify" for "verified healthy".
      unverified=$(curl -s "$API/agent/tabs" -H "$auth_header" | jq -r --arg u "$local_url" \
        '[.tabs | to_entries[] | select(.value.url | startswith($u)) | .key] | sort | reverse | first // empty')
      if [ -n "$unverified" ]; then
        echo "{\"tabId\":\"$unverified\",\"action\":\"opened\",\"ownership\":\"unverified\",\"url\":\"$local_url\"}"
        exit 0
      fi
      echo "{\"tabId\":null,\"action\":\"timeout\",\"ownership\":\"unverified\",\"url\":\"$local_url\"}" >&2
      exit 1
    fi
    ;;

  back)
    interactive "${1:-$DEFAULT_TAB}" '{"action":"back"}'
    ;;

  reload)
    interactive "${1:-$DEFAULT_TAB}" '{"action":"reload"}'
    ;;

  eval|js)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg c "${1:?code required}" '{action:"eval", code:$c}')"
    ;;

  query|qs)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" '{action:"querySelector", selector:$s}')"
    ;;

  queryall|qsa)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" '{action:"querySelectorAll", selector:$s}')"
    ;;

  read)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" '{action:"read", selector:$s}')"
    ;;

  set-input|input)
    interactive "${3:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" --arg v "${2:?value required}" '{action:"setInput", selector:$s, value:$v}')"
    ;;

  type)
    interactive "${3:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" --arg t "${2:?text required}" '{action:"type", selector:$s, text:$t}')"
    ;;

  fill)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --argjson f "${1:?json required}" '{action:"fillForm", fields:$f}')"
    ;;

  select)
    interactive "${3:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" --arg v "${2:?value required}" '{action:"selectOption", selector:$s, value:$v}')"
    ;;

  wait)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --argjson ms "${1:-1000}" '{action:"wait", ms:$ms}')"
    ;;

  wait-for|wf)
    local_timeout="${2:-10000}"
    interactive "${3:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" --argjson t "$local_timeout" '{action:"waitForSelector", selector:$s, timeout:$t}')" "$(( (local_timeout / 1000) + 5 ))"
    ;;

  wait-text|wt)
    local_timeout2="${2:-10000}"
    interactive "${3:-$DEFAULT_TAB}" "$(jq -nc --arg t "${1:?text required}" --argjson to "$local_timeout2" '{action:"waitForText", text:$t, timeout:$to}')" "$(( (local_timeout2 / 1000) + 5 ))"
    ;;

  assert-text|at)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg t "${1:?text required}" '{action:"assertText", text:$t}')"
    ;;

  assert-no-text|ant)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg t "${1:?text required}" '{action:"assertText", text:$t, negate:true}')"
    ;;

  assert)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" '{action:"assertSelector", selector:$s}')"
    ;;

  assert-not)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" '{action:"assertSelector", selector:$s, negate:true}')"
    ;;

  cdp-type|ct)
    # Type via Chrome DevTools Protocol (trusted events — works on React/FB)
    # Usage: cdp-type <selector> <text> [tabUrl] [--fast] [--seed N] [--delay MS]
    #
    # Humanized by default (ext 2.12.0+): correct event.code/keyCode per US
    # layout, lognormal inter-key intervals instead of a fixed 30ms metronome.
    # --delay sets the MEAN interval, not a constant. --fast restores the old
    # fixed-interval path for speed-critical callers (descriptors stay correct).
    # --seed pins the RNG so a failing interaction replays exactly.
    ct_sel="${1:?selector required}"; ct_text="${2:?text required}"; shift 2
    ct_target=""; ct_human="true"; ct_seed=""; ct_delay=""; ct_next=""
    for arg in "$@"; do
      if [ -n "$ct_next" ]; then eval "$ct_next=\$arg"; ct_next=""; continue; fi
      case "$arg" in
        --fast)  ct_human="false" ;;
        --seed)  ct_next="ct_seed" ;;
        --delay) ct_next="ct_delay" ;;
        *)       ct_target="$arg" ;;
      esac
    done
    split_target "$ct_target"
    interactive "$CDP_TAB" "$(jq -nc --arg s "$ct_sel" --arg t "$ct_text" --arg u "$CDP_URL" \
      --argjson h "$ct_human" --arg sd "$ct_seed" --arg dl "$ct_delay" --argjson tf "$(target_json)" \
      '{action:"cdpType", selector:$s, text:$t, humanize:$h}
       + $tf
       + (if $u  != "" then {url:$u}                else {} end)
       + (if $sd != "" then {seed:($sd|tonumber)}   else {} end)
       + (if $dl != "" then {delay:($dl|tonumber)}  else {} end)')"
    ;;

  cdp-click|cc)
    # Click via Chrome DevTools Protocol (trusted events)
    # Usage: cdp-click <selector> [tabUrl] [--fast] [--seed N]
    #
    # Humanized by default (ext 2.12.0+): the cursor travels a bowed path from
    # wherever it was last left in this tab, lands on an integral point scattered
    # inside the element (not its sub-pixel centroid), dwells, then holds the
    # button down for a real interval. --fast restores the old single-teleport
    # path when speed matters more than plausibility.
    cc_sel="${1:?selector required}"; shift
    cc_target=""; cc_human="true"; cc_seed=""; cc_next=""
    for arg in "$@"; do
      if [ -n "$cc_next" ]; then eval "$cc_next=\$arg"; cc_next=""; continue; fi
      case "$arg" in
        --fast) cc_human="false" ;;
        --seed) cc_next="cc_seed" ;;
        *)      cc_target="$arg" ;;
      esac
    done
    split_target "$cc_target"
    interactive "$CDP_TAB" "$(jq -nc --arg s "$cc_sel" --arg u "$CDP_URL" \
      --argjson h "$cc_human" --arg sd "$cc_seed" --argjson tf "$(target_json)" \
      '{action:"cdpClick", selector:$s, humanize:$h}
       + $tf
       + (if $u  != "" then {url:$u}              else {} end)
       + (if $sd != "" then {seed:($sd|tonumber)} else {} end)')"
    ;;

  cdp-eval|ce)
    # Evaluate JS via CDP Runtime.evaluate (bypasses CSP)
    # Usage: cdp-eval <expression> [tabUrl] [--await] [--focus] [--scroll]
    local_url3="" await_promise="false" focus_tab="false" scroll_page="false"
    eval_expr="${1:?expression required}"; shift
    for arg in "$@"; do
      case "$arg" in
        --await) await_promise="true" ;;
        --focus) focus_tab="true" ;;
        --scroll) scroll_page="true" ;;
        *) local_url3="$arg" ;;
      esac
    done
    split_target "$local_url3"
    interactive "$CDP_TAB" "$(jq -nc --arg e "$eval_expr" --arg u "$CDP_URL" \
      --argjson a "$await_promise" --argjson f "$focus_tab" --argjson s "$scroll_page" \
      --argjson t "$(target_json)" \
      '{action:"cdpEval", expression:$e, awaitPromise:$a, focus:$f, scroll:$s} + $t + if $u != "" then {url:$u} else {} end')"
    ;;

  fingerprint-audit|fpa)
    # Read-only audit of what this browser looks like to bot mitigation.
    # Usage: fingerprint-audit [tabIdOrUrl]
    #
    # This DIAGNOSES, it does not spoof. The premise of this whole agent is that
    # the hardware is real (real GPU, real display, real residential IP, real
    # profile), so the passive surfaces should already be coherent and the
    # correct action on a finding is to fix the cause, not to patch the getter.
    # Patching is itself a signal: `patchedNatives` below exists to catch a
    # previous well-meaning "stealth" fix having made things worse.
    #
    # Prints the probe object plus a `flags` array naming each inconsistency.
    read -r -d '' fpa_probe <<'FPAJS' || true
(async () => {
  const out = {}, flags = [], nav = navigator;

  out.webdriver = nav.webdriver === true;
  if (out.webdriver) flags.push('navigator.webdriver is true: this browser was launched with --enable-automation (ChromeDriver/Puppeteer). Extension + chrome.debugger control does NOT set it, so seeing it here means the wrong browser is being driven.');

  out.userAgent = nav.userAgent;
  out.platform = nav.platform;
  out.languages = nav.languages;
  out.language = nav.language;
  out.hardwareConcurrency = nav.hardwareConcurrency;
  out.deviceMemory = nav.deviceMemory === undefined ? null : nav.deviceMemory;
  out.maxTouchPoints = nav.maxTouchPoints;
  out.plugins = nav.plugins.length;
  out.mimeTypes = nav.mimeTypes.length;
  out.pdfViewerEnabled = nav.pdfViewerEnabled;

  if (nav.languages && nav.language && nav.languages[0] !== nav.language) flags.push('navigator.language does not match navigator.languages[0]: a classic sloppy-override signature.');
  if (nav.plugins.length === 0) flags.push('navigator.plugins is empty: normal for some configs but a headless correlate when combined with other flags.');

  try {
    const hi = nav.userAgentData ? await nav.userAgentData.getHighEntropyValues(['platform','platformVersion','architecture','model','uaFullVersion','bitness']) : null;
    out.uaData = hi;
    if (hi) {
      const uaWin = /Windows NT/.test(nav.userAgent);
      if (uaWin !== (hi.platform === 'Windows')) flags.push('UA string and UA-CH disagree on the OS (UA-CH says ' + hi.platform + '): the single most common spoofing tell.');
    }
  } catch (e) { out.uaData = 'error: ' + e.message; }

  out.screen = { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight, colorDepth: screen.colorDepth, dpr: devicePixelRatio };
  out.window = { innerW: innerWidth, innerH: innerHeight, outerW: outerWidth, outerH: outerHeight };
  out.browserChromeHeight = outerHeight - innerHeight;
  if (screen.width < innerWidth || screen.height < innerHeight) flags.push('the viewport is larger than the screen: impossible on real hardware.');
  if (outerHeight - innerHeight <= 0) flags.push('outerHeight <= innerHeight: no browser chrome at all, typical of headless.');
  if (screen.availWidth === screen.width && screen.availHeight === screen.height) flags.push('availWidth/Height exactly equal width/height: no OS taskbar, common on headless and on VMs.');

  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    out.webgl = dbg
      ? { vendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) }
      : (gl ? 'webgl present, no debug_renderer_info' : 'no webgl context');
    const r = (out.webgl && out.webgl.renderer) || '';
    if (/SwiftShader|llvmpipe|Software|Mesa OffScreen/i.test(r)) flags.push('WebGL renderer is a software rasteriser (' + r + '): no real GPU in use, a strong headless/VM signal.');
  } catch (e) { out.webgl = 'error: ' + e.message; }

  try {
    const st = (await nav.permissions.query({ name: 'notifications' })).state;
    out.permissions = { notificationsQuery: st, notificationPermission: Notification.permission };
    if (Notification.permission === 'denied' && st === 'prompt') flags.push('Notification.permission=denied while permissions.query reports prompt: the canonical headless Chrome mismatch.');
  } catch (e) { out.permissions = 'error: ' + e.message; }

  out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  out.timezoneOffsetMin = new Date().getTimezoneOffset();

  const patched = [];
  const natives = [
    ['HTMLCanvasElement.toDataURL', HTMLCanvasElement.prototype.toDataURL],
    ['HTMLCanvasElement.getContext', HTMLCanvasElement.prototype.getContext],
    ['WebGLRenderingContext.getParameter', window.WebGLRenderingContext && window.WebGLRenderingContext.prototype.getParameter],
    ['Date.getTimezoneOffset', Date.prototype.getTimezoneOffset],
    ['AudioBuffer.getChannelData', window.AudioBuffer && window.AudioBuffer.prototype.getChannelData],
    ['Permissions.query', nav.permissions && nav.permissions.query],
  ];
  for (const [name, fn] of natives) {
    try { if (fn && !/\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(fn))) patched.push(name); } catch (e) { /* inaccessible */ }
  }
  out.patchedNatives = patched;
  if (patched.length) flags.push('these built-ins are no longer native: ' + patched.join(', ') + '. On genuine hardware nothing needs patching, and a patch is more detectable than the value it hides. Find what installed them.');

  let cdpSeen = false;
  try {
    const err = new Error('probe');
    Object.defineProperty(err, 'stack', { configurable: true, get() { cdpSeen = true; return ''; } });
    console.debug(err);
  } catch (e) { /* ignore */ }
  out.cdpConsoleProbe = cdpSeen;
  if (cdpSeen) flags.push('the page can observe an attached debugger by watching console serialisation of Error.stack. NOTE: this probe necessarily runs WITH chrome.debugger attached, so it reports the CDP command window only, not idle browsing.');

  out.flags = flags;
  out.verdict = flags.length === 0 ? 'no inconsistencies detected' : flags.length + ' finding(s)';
  return JSON.stringify(out, null, 2);
})()
FPAJS
    split_target "${1:-}"
    fpa_out=$(interactive "$CDP_TAB" "$(jq -nc --arg e "$fpa_probe" --arg u "$CDP_URL" --argjson t "$(target_json)" \
      '{action:"cdpEval", expression:$e, awaitPromise:true} + $t + if $u != "" then {url:$u} else {} end')") || exit 1
    # cdpEval wraps the return in {value:...}; surface the probe object itself,
    # but never swallow an unexpected shape (a targeting error lives at the top
    # level and must stay visible).
    echo "$fpa_out" | jq -r 'if type=="object" and has("value") then .value else . end' 2>/dev/null || echo "$fpa_out"
    ;;

  form-fill|ff)
    # Atomically fill framework-controlled inputs (Vue v-model / React controlled)
    # and optionally click a submit button — all inside ONE CDP evaluation.
    #
    # Why this exists (learned on staples.com, 2026-08-01): setting a value in one
    # CLI call and submitting in the NEXT call fails on SPA forms. The framework
    # re-renders between calls and writes its own (empty) model back over the DOM
    # value, so the form submits blank and shows "This field is required".
    # `cdp-type` is no help either when the tab was opened in the background:
    # visibilityState is "hidden", nothing can hold focus, and the synthesised
    # keystrokes land nowhere (it still reports typed:true).
    #
    # Usage:
    #   browser-cli form-fill '{"#user":"bob","#pw":"s3cret"}' <tabIdOrUrl> \
    #     [--submit 'sign in'] [--settle MS] [--wait MS]
    #
    # --submit takes a case-insensitive regex matched against visible button text.
    # Returns {filled:{selector:length}, missing:[...], submitted:bool, url, body}.
    ff_fields="${1:?fields JSON object required}"; shift
    ff_target=""; ff_submit=""; ff_settle="700"; ff_wait="8000"
    while [ $# -gt 0 ]; do
      case "$1" in
        --submit) ff_submit="${2:?--submit requires a button text pattern}"; shift 2 ;;
        --settle) ff_settle="${2:?--settle requires milliseconds}"; shift 2 ;;
        --wait)   ff_wait="${2:?--wait requires milliseconds}"; shift 2 ;;
        *) ff_target="$1"; shift ;;
      esac
    done
    split_target "$ff_target"
    ff_js="$(FF_FIELDS="$ff_fields" FF_SUBMIT="$ff_submit" FF_SETTLE="$ff_settle" FF_WAIT="$ff_wait" python3 -c '
import json, os
fields = json.loads(os.environ["FF_FIELDS"])
submit, settle, wait = os.environ["FF_SUBMIT"], os.environ["FF_SETTLE"], os.environ["FF_WAIT"]
setter = ("var set=function(el,v){var s=Object.getOwnPropertyDescriptor("
          "window.HTMLInputElement.prototype,\"value\").set;s.call(el,v);"
          "el.dispatchEvent(new Event(\"input\",{bubbles:true}));"
          "el.dispatchEvent(new Event(\"change\",{bubbles:true}));};")
parts = ["(async()=>{", setter, "var filled={},missing=[];"]
for i, (sel, val) in enumerate(fields.items()):
    s, v = json.dumps(sel), json.dumps(str(val))
    parts.append("var e%d=document.querySelector(%s);"
                 "if(e%d){set(e%d,%s);filled[%s]=e%d.value.length;}else{missing.push(%s);}"
                 % (i, s, i, i, v, s, i, s))
parts.append("await new Promise(r=>setTimeout(r,%s));" % settle)
if submit:
    parts.append("var b=[].slice.call(document.querySelectorAll(\"button,input[type=submit]\"))"
                 ".filter(function(x){return new RegExp(%s,\"i\").test((x.innerText||x.value||\"\").trim())"
                 "&&x.offsetParent})[0];if(b)b.click();" % json.dumps(submit))
else:
    parts.append("var b=null;")
parts.append("await new Promise(r=>setTimeout(r,%s));" % wait)
parts.append("return JSON.stringify({filled:filled,missing:missing,submitted:!!b,"
             "url:location.href.slice(0,90),"
             "body:(document.body.innerText||\"\").replace(/\\s+/g,\" \").slice(0,600)});})()")
print("".join(parts))
')"
    interactive "$CDP_TAB" "$(jq -nc --arg e "$ff_js" --arg u "$CDP_URL" \
      --argjson t "$(target_json)" \
      '{action:"cdpEval", expression:$e, awaitPromise:true} + $t + if $u != "" then {url:$u} else {} end')"
    ;;

  cdp-keys|ck)
    # Send special keystrokes via CDP (ArrowDown, Enter, Tab, Escape, etc.)
    # Usage: cdp-keys <keys-json> [tabUrl]
    # Example: cdp-keys '[{"key":"ArrowDown","code":"ArrowDown","keyCode":40},{"key":"Enter","code":"Enter","keyCode":13}]' facebook.com
    split_target "${2:-}"
    interactive "$CDP_TAB" "$(jq -nc --argjson k "${1:?keys json required}" --arg u "$CDP_URL" --argjson tf "$(target_json)" \
      '$tf + if $u != "" then {action:"cdpKeys", keys:$k, url:$u} else {action:"cdpKeys", keys:$k} end')"
    ;;

  network-capture|nc)
    # Capture network responses matching a URL pattern via CDP
    # Usage: network-capture <urlPattern> [tabUrl] [--timeout N] [--max-len N] [--list]
    local_pattern="${1:?url pattern required}"; shift
    local_nc_url="" nc_timeout=30000 nc_maxlen=100000 nc_list="false"
    for arg in "$@"; do
      case "$arg" in
        --timeout) shift_next="timeout" ;;
        --max-len) shift_next="maxlen" ;;
        --list) nc_list="true" ;;
        *)
          if [ "${shift_next:-}" = "timeout" ]; then nc_timeout="$arg"; shift_next=""
          elif [ "${shift_next:-}" = "maxlen" ]; then nc_maxlen="$arg"; shift_next=""
          else local_nc_url="$arg"; fi ;;
      esac
    done
    split_target "$local_nc_url"
    TIMEOUT=$((nc_timeout / 1000 + 15)) interactive "$CDP_TAB" "$(jq -nc --arg p "$local_pattern" --arg u "$CDP_URL" --argjson tf "$(target_json)" \
      --argjson t "$nc_timeout" --argjson m "$nc_maxlen" --argjson l "$nc_list" \
      '{action:"cdpNetworkCapture", urlPattern:$p, timeout:$t, maxLen:$m, listUrls:$l} + $tf + if $u != "" then {url:$u} else {} end')"
    ;;

  extract-virtual|ev)
    # Extract data from virtually-rendered pages (tries 10 approaches)
    # Usage: extract-virtual [tabUrl] [--selector SEL] [--extract EXPR]
    local_ev_url="" ev_selector="" ev_extract=""
    for arg in "$@"; do
      case "$arg" in
        --selector) shift_next="selector" ;;
        --extract) shift_next="extract" ;;
        *)
          if [ "${shift_next:-}" = "selector" ]; then ev_selector="$arg"; shift_next=""
          elif [ "${shift_next:-}" = "extract" ]; then ev_extract="$arg"; shift_next=""
          else local_ev_url="$arg"; fi ;;
      esac
    done
    split_target "$local_ev_url"
    TIMEOUT=70 interactive "$CDP_TAB" "$(jq -nc --arg u "$CDP_URL" --arg s "$ev_selector" --arg e "$ev_extract" --argjson tf "$(target_json)" \
      '{action:"extractVirtual"} + $tf + if $u != "" then {url:$u} else {} end + if $s != "" then {selector:$s} else {} end + if $e != "" then {extract:$e} else {} end')"
    ;;

  console)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --argjson n "${1:-50}" '{action:"getConsoleLog", count:$n}')"
    ;;

  errors)
    interactive "${1:-$DEFAULT_TAB}" '{"action":"getNetworkErrors"}'
    ;;

  logs)
    curl -s "$API/agent/logs?since=${1:-0}" -H "$auth_header" | jq '.'
    ;;

  health|h)
    curl -s "$API/health" | jq '.'
    ;;

  click-any|ca)
    # Click any element with matching text (not just buttons — works for custom dropdowns)
    local_text="${1:?text required}"
    shift
    local_tab="$DEFAULT_TAB"
    local_nth=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --nth) local_nth="${2:?--nth requires a number}"; shift 2 ;;
        *) if [ -z "$local_tab" ] || [ "$local_tab" = "$DEFAULT_TAB" ]; then local_tab="$1"; fi; shift ;;
      esac
    done
    if [ -n "$local_nth" ]; then
      interactive "$local_tab" "$(jq -nc --arg t "$local_text" --argjson n "$local_nth" '{action:"clickAny", text:$t, nth:$n}')"
    else
      interactive "$local_tab" "$(jq -nc --arg t "$local_text" '{action:"clickAny", text:$t}')"
    fi
    ;;

  upload)
    # Upload a local file to a file input or drop zone in the browser
    local_selector="${1:?selector required}"
    local_filepath="${2:?filepath required}"
    local_tab="${3:-$DEFAULT_TAB}"
    local_dragdrop=false
    # Check for --drag-drop flag in any position
    for arg in "$@"; do
      if [ "$arg" = "--drag-drop" ]; then local_dragdrop=true; fi
    done

    if [ ! -f "$local_filepath" ]; then
      echo "ERROR: File not found: $local_filepath" >&2
      exit 1
    fi

    local_filename=$(basename "$local_filepath")
    local_mimetype=$(file -b --mime-type "$local_filepath" 2>/dev/null || echo "application/octet-stream")
    local_blobid="blob-$(date +%s)-$(head -c 4 /dev/urandom | xxd -p)"

    # Step 1: Upload blob to server (write to temp file to avoid arg-too-long)
    local_tmpfile=$(mktemp /tmp/browser-upload-XXXXXX.json)
    trap "rm -f '$local_tmpfile'" EXIT
    python3 -c "
import base64, json, sys
with open(sys.argv[1], 'rb') as f:
    b64 = base64.b64encode(f.read()).decode()
json.dump({'blobId': sys.argv[2], 'base64': b64, 'filename': sys.argv[3], 'mimetype': sys.argv[4]}, open(sys.argv[5], 'w'))
" "$local_filepath" "$local_blobid" "$local_filename" "$local_mimetype" "$local_tmpfile"

    local_upload_resp=$(curl -s -m 60 -X POST "$API/agent/upload-blob" \
      -H "Content-Type: application/json" \
      -H "$auth_header" \
      -d @"$local_tmpfile")
    rm -f "$local_tmpfile"

    local_upload_ok=$(echo "$local_upload_resp" | jq -r '.ok // false')
    if [ "$local_upload_ok" != "true" ]; then
      echo "ERROR: Failed to upload blob: $(echo "$local_upload_resp" | jq -r '.error // "unknown"')" >&2
      exit 1
    fi

    # Step 2: Send uploadFile command to browser (use TIMEOUT env var, default 120s for large files)
    interactive "$local_tab" "$(jq -nc \
      --arg s "$local_selector" \
      --arg bid "$local_blobid" \
      --argjson dd "$local_dragdrop" \
      '{action:"uploadFile", selector:$s, blobId:$bid, dragDrop:$dd}')" "${TIMEOUT:-120}"
    ;;

  wait-render|wr)
    # Wait for SPA to hydrate (body text reaches minLength characters)
    local_minlen="${1:-50}"
    local_timeout="${2:-15000}"
    local_tab="${3:-$DEFAULT_TAB}"
    interactive "$local_tab" "$(jq -nc --argjson m "$local_minlen" --argjson t "$local_timeout" '{action:"waitForRender", minLength:$m, timeout:$t}')" "$(( (local_timeout / 1000) + 5 ))"
    ;;

  ping)
    interactive "${1:-$DEFAULT_TAB}" '{"action":"ping"}'
    ;;

  # ── Cowork commands ──

  cowork-status|cws)
    curl -s "$API/cowork/status" -H "$auth_header" | jq '.'
    ;;

  cowork-capture|cwcap)
    # Run the PowerShell capture daemon (scrapes Cowork panel via CDP)
    local_ps_path="${COWORK_CAPTURE_PS1:-\\\\wsl.localhost\\Ubuntu\\$HOME/repos/cowork-bridge/capture-daemon.ps1}"
    case "${1:-}" in
      --watch|-w)
        powershell.exe -ExecutionPolicy Bypass -File "$local_ps_path" -Watch -Interval "${2:-30}"
        ;;
      --targets|-t)
        powershell.exe -ExecutionPolicy Bypass -File "$local_ps_path" -ListTargets
        ;;
      *)
        powershell.exe -ExecutionPolicy Bypass -File "$local_ps_path"
        ;;
    esac
    ;;

  cowork-attach|cwa)
    # Remote-attach: tells the extension to attach its debugger to the Cowork panel
    curl -s -X POST "$API/cowork/start" \
      -H "Content-Type: application/json" \
      -H "$auth_header" \
      -d '{"goal":"__attach__"}' | jq '.'
    echo "Sent attach command to extension. It will auto-attach on next poll (~10s)."
    ;;

  cowork-detach|cwd)
    curl -s -X POST "$API/cowork/start" \
      -H "Content-Type: application/json" \
      -H "$auth_header" \
      -d '{"goal":"__detach__"}' | jq '.'
    echo "Sent detach command to extension."
    ;;

  cowork-scrape|cwsc)
    curl -s -X POST "$API/cowork/start" \
      -H "Content-Type: application/json" \
      -H "$auth_header" \
      -d '{"goal":"__scrape__"}' | jq '.'
    echo "Sent scrape command to extension."
    ;;

  cowork-targets|cwt)
    # Debug: dump all debugger targets the extension can see
    curl -s -X POST "$API/cowork/start" \
      -H "Content-Type: application/json" \
      -H "$auth_header" \
      -d '{"goal":"__targets__"}' | jq '.'
    echo "Sent targets dump command. Check logs in ~10s: browser-cli logs"
    ;;

  cowork-sessions|cwl)
    local_date=""
    if [[ "${1:-}" == "--today" ]]; then
      local_date=$(date +%Y-%m-%d)
    elif [[ -n "${1:-}" ]]; then
      local_date="$1"
    fi
    if [ -n "$local_date" ]; then
      curl -s "$API/cowork/sessions?date=$local_date" -H "$auth_header" | jq '.sessions[] | {id, slug, goal, status, turnCount, startedAt}'
    else
      curl -s "$API/cowork/sessions" -H "$auth_header" | jq '.sessions[] | {id, slug, goal, status, turnCount, startedAt}'
    fi
    ;;

  cowork-read|cwr)
    local_sid="${1:?session-id required}"
    curl -s "$API/cowork/session/$local_sid" -H "$auth_header" | jq '.'
    ;;

  cowork-start|cwstart)
    local_goal="${1:?goal required}"
    local_instructions=""
    if [[ "${2:-}" == "--instructions" ]]; then
      local_file="${3:?instructions file required}"
      if [ ! -f "$local_file" ]; then
        echo "ERROR: File not found: $local_file" >&2
        exit 1
      fi
      local_instructions=$(cat "$local_file")
    fi
    curl -s -X POST "$API/cowork/start" \
      -H "Content-Type: application/json" \
      -H "$auth_header" \
      -d "$(jq -nc --arg g "$local_goal" --arg i "$local_instructions" '{goal: $g, instructions: $i}')" | jq '.'
    ;;

  cowork-export|cwx)
    local_sid="${1:-}"
    local_cowork_dir="$HOME/repos/my-claude-cowork/sessions"

    if [ -z "$local_sid" ]; then
      # Export all sessions from today
      local_today=$(date +%Y-%m-%d)
      local_sessions=$(curl -s "$API/cowork/sessions?date=$local_today" -H "$auth_header")
      local_count=$(echo "$local_sessions" | jq '.count')
      echo "Exporting $local_count sessions from $local_today..."

      echo "$local_sessions" | jq -r '.sessions[].id' | while read -r sid; do
        local_session=$(curl -s "$API/cowork/session/$sid" -H "$auth_header")
        local_slug=$(echo "$local_session" | jq -r '.session.slug')
        local_dir="$local_cowork_dir/$local_today"
        mkdir -p "$local_dir"
        echo "$local_session" | jq '.session' > "$local_dir/${local_slug}.json"
        echo "  Exported: $local_dir/${local_slug}.json"
      done
    else
      local_session=$(curl -s "$API/cowork/session/$local_sid" -H "$auth_header")
      local_slug=$(echo "$local_session" | jq -r '.session.slug')
      local_date=$(echo "$local_session" | jq -r '.session.startedAt' | cut -c1-10)
      local_dir="$local_cowork_dir/$local_date"
      mkdir -p "$local_dir"
      echo "$local_session" | jq '.session' > "$local_dir/${local_slug}.json"
      echo "Exported: $local_dir/${local_slug}.json"
    fi
    ;;

  cowork-sync|cwsync)
    echo "Syncing cowork sessions from VM..."
    local_cowork_dir="$HOME/repos/my-claude-cowork/sessions"
    local_today=$(date +%Y-%m-%d)
    mkdir -p "$local_cowork_dir/$local_today"

    # Pull markdown files from VM
    local vm="${BROWSER_AGENT_VM:?Set BROWSER_AGENT_VM}"
    local vm_key="${BROWSER_AGENT_VM_KEY:-$HOME/.ssh/vm_key}"
    local vm_user; vm_user=$(echo "$vm" | cut -d@ -f1)
    scp -i "$vm_key" \
      "$vm:/home/$vm_user/cowork-sessions/$local_today/*.md" \
      "$local_cowork_dir/$local_today/" 2>/dev/null || echo "No sessions to sync for $local_today"

    # Git commit if in repo
    if [ -d "$HOME/repos/my-claude-cowork/.git" ]; then
      cd "$HOME/repos/my-claude-cowork"
      if [ -n "$(git status --porcelain sessions/)" ]; then
        git add sessions/
        git commit -m "Auto-sync cowork sessions $local_today"
        git push origin main 2>/dev/null || git push origin master 2>/dev/null || true
        echo "Committed and pushed session logs"
      else
        echo "No new sessions to commit"
      fi
    fi
    ;;

  help|--help|-h)
    head -55 "$0" | tail -53
    ;;

  *)
    echo "Unknown command: $cmd. Run '$0 help' for usage." >&2
    exit 1
    ;;
esac
