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
#   navigate <url> [tabId]        Navigate to URL
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
#   ping [tabId]                  Ping browser agent
#
# Environment:
#   BROWSER_AGENT_URL   Server URL (default: https://pezant.ca/api/browser-agent)
#   BROWSER_AGENT_KEY   Auth key (default: browser-agent-key)
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

  ping)
    interactive "${1:-$DEFAULT_TAB}" '{"action":"ping"}'
    ;;

  help|--help|-h)
    head -45 "$0" | tail -43
    ;;

  *)
    echo "Unknown command: $cmd. Run '$0 help' for usage." >&2
    exit 1
    ;;
esac
