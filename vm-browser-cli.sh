#!/usr/bin/env bash
# vm-browser-cli.sh — VM-side wrapper for browser-cli.sh.
#
# The relay (agent-server.js, PM2 `browser-agent`) runs ON the VM, but commands
# execute in the HOME Chrome/Brave browser. This wrapper lets any VM process
# (autonomous agents, scrapers) drive that residential-IP browser, bypassing
# datacenter-IP bot blocks that hit the VM directly (e.g. eBay 403s the GCP IP).
#
# Install on the VM:  ln -sf ~/browser-agent/vm-browser-cli.sh ~/bin/browser-cli
# Usage:              browser-cli <command> [args]      (same interface as browser-cli.sh)
#   Default routes to MAIN Chrome profile (n.pezarro).
#   ALT (Brave) profile:  BROWSER_AGENT_PROFILE=alt browser-cli <command> [args]
#
# Notes:
#   - Use cdp-eval (not eval) on CSP-locked sites (eBay, Facebook, Google).
#   - Neither automation browser is logged into Discord; read Discord messages via
#     the bot token against discord.com/api/v10, not by scraping.
set -a; . "$HOME/browser-agent/.env"; set +a
export BROWSER_AGENT_URL="${BROWSER_AGENT_URL:-http://127.0.0.1:3102}"
if [ "$BROWSER_AGENT_PROFILE" = "alt" ]; then
  export BROWSER_AGENT_KEY="$BROWSER_AGENT_KEY_ALT"
fi
exec bash "$HOME/browser-agent/browser-cli.sh" "$@"
