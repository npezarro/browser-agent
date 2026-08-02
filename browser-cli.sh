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
#
# Flags (append to click/click-any):
#   --nth N                       Click the Nth match (default: 1st)
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
  local t="${1:-}"
  if [ -z "$t" ]; then
    CDP_TAB="$DEFAULT_TAB"
  elif is_tab_id "$t"; then
    CDP_TAB="$t"
  else
    CDP_URL="$t"
  fi
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
    interactive "${1:-$DEFAULT_TAB}" '{"action":"closeTab"}'
    ;;

  focus)
    # Focus a tab by URL (requires extension)
    interactive "" "$(jq -nc --arg u "${1:?url required}" '{action:"focusTab", url:$u}')"
    ;;

  ext-status)
    # Check if companion extension is connected. `stale:true` means the browser is
    # running older code than this checkout ships — run `ext-reload`.
    curl -s "$API/ext/status" -H "$auth_header" | jq .
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
    local_url="${1:?url required}"
    local_wait="${2:-6}"
    # Check if any tab already has this URL (prefix match)
    existing=$(curl -s "$API/agent/tabs" -H "$auth_header" | jq -r --arg u "$local_url" \
      '[.tabs | to_entries[] | select(.value.url | startswith($u)) | .key] | first // empty')
    if [ -n "$existing" ]; then
      echo "{\"tabId\":\"$existing\",\"action\":\"reused\",\"url\":\"$local_url\"}"
    else
      # Open new tab (uses extension for background open if available, falls back to TM)
      interactive "" "$(jq -nc --arg u "$local_url" '{action:"openTabBackground", url:$u}')" > /dev/null 2>&1
      # Wait for the new tab to register
      for i in $(seq 1 "$local_wait"); do
        sleep 1
        found=$(curl -s "$API/agent/tabs" -H "$auth_header" | jq -r --arg u "$local_url" \
          '[.tabs | to_entries[] | select(.value.url | startswith($u)) | .key] | first // empty')
        if [ -n "$found" ]; then
          echo "{\"tabId\":\"$found\",\"action\":\"opened\",\"url\":\"$local_url\"}"
          exit 0
        fi
      done
      echo "{\"tabId\":null,\"action\":\"timeout\",\"url\":\"$local_url\"}" >&2
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
    # Usage: cdp-type <selector> <text> [tabUrl]
    split_target "${3:-}"
    interactive "$CDP_TAB" "$(jq -nc --arg s "${1:?selector required}" --arg t "${2:?text required}" --arg u "$CDP_URL" \
      'if $u != "" then {action:"cdpType", selector:$s, text:$t, url:$u} else {action:"cdpType", selector:$s, text:$t} end')"
    ;;

  cdp-click|cc)
    # Click via Chrome DevTools Protocol (trusted events)
    # Usage: cdp-click <selector> [tabUrl]
    split_target "${2:-}"
    interactive "$CDP_TAB" "$(jq -nc --arg s "${1:?selector required}" --arg u "$CDP_URL" \
      'if $u != "" then {action:"cdpClick", selector:$s, url:$u} else {action:"cdpClick", selector:$s} end')"
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
      '{action:"cdpEval", expression:$e, awaitPromise:$a, focus:$f, scroll:$s} + if $u != "" then {url:$u} else {} end')"
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
      '{action:"cdpEval", expression:$e, awaitPromise:true} + if $u != "" then {url:$u} else {} end')"
    ;;

  cdp-keys|ck)
    # Send special keystrokes via CDP (ArrowDown, Enter, Tab, Escape, etc.)
    # Usage: cdp-keys <keys-json> [tabUrl]
    # Example: cdp-keys '[{"key":"ArrowDown","code":"ArrowDown","keyCode":40},{"key":"Enter","code":"Enter","keyCode":13}]' facebook.com
    split_target "${2:-}"
    interactive "$CDP_TAB" "$(jq -nc --argjson k "${1:?keys json required}" --arg u "$CDP_URL" \
      'if $u != "" then {action:"cdpKeys", keys:$k, url:$u} else {action:"cdpKeys", keys:$k} end')"
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
    TIMEOUT=$((nc_timeout / 1000 + 15)) interactive "$CDP_TAB" "$(jq -nc --arg p "$local_pattern" --arg u "$CDP_URL" \
      --argjson t "$nc_timeout" --argjson m "$nc_maxlen" --argjson l "$nc_list" \
      '{action:"cdpNetworkCapture", urlPattern:$p, timeout:$t, maxLen:$m, listUrls:$l} + if $u != "" then {url:$u} else {} end')"
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
    TIMEOUT=70 interactive "$CDP_TAB" "$(jq -nc --arg u "$CDP_URL" --arg s "$ev_selector" --arg e "$ev_extract" \
      '{action:"extractVirtual"} + if $u != "" then {url:$u} else {} end + if $s != "" then {selector:$s} else {} end + if $e != "" then {extract:$e} else {} end')"
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
