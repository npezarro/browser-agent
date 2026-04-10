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
#   close [tabId]                 Close tab
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
#   upload <selector> <filepath> [tabId] [--drag-drop]  Upload file to input
#   ping [tabId]                  Ping browser agent
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
    local_tab="${2:-$DEFAULT_TAB}"
    # If starts with . # or [ treat as selector, otherwise as text
    if [[ "$local_target" =~ ^[.#\[] ]]; then
      interactive "$local_tab" "$(jq -nc --arg s "$local_target" '{action:"click", selector:$s}')"
    else
      interactive "$local_tab" "$(jq -nc --arg t "$local_target" '{action:"click", text:$t}')"
    fi
    ;;

  navigate|nav|goto)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg u "${1:?url required}" '{action:"navigate", url:$u}')"
    ;;

  open|open-tab)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg u "${1:?url required}" '{action:"openTab", url:$u}')"
    ;;

  close|close-tab)
    interactive "${1:-$DEFAULT_TAB}" '{"action":"closeTab"}'
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
      # Open new tab from the most recent existing tab
      interactive "" "$(jq -nc --arg u "$local_url" '{action:"openTab", url:$u}')" > /dev/null 2>&1
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

    # Step 2: Send uploadFile command to browser
    interactive "$local_tab" "$(jq -nc \
      --arg s "$local_selector" \
      --arg bid "$local_blobid" \
      --argjson dd "$local_dragdrop" \
      '{action:"uploadFile", selector:$s, blobId:$bid, dragDrop:$dd}')" 45
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
    local_ps_path='\\wsl.localhost\Ubuntu\home\npezarro\repos\cowork-bridge\capture-daemon.ps1'
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
    scp -i "$HOME/.ssh/vm_key" \
      "generatedByTermius@pezant.ca:/home/generatedByTermius/cowork-sessions/$local_today/*.md" \
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
