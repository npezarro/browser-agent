#!/usr/bin/env bash
set -euo pipefail

VM="${BROWSER_AGENT_VM:?Set BROWSER_AGENT_VM (e.g. user@host)}"
VM_KEY="${BROWSER_AGENT_VM_KEY:-$HOME/.ssh/vm_key}"
SSH_CMD="ssh -i $VM_KEY $VM"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STAGING="/tmp/tm-scripts-staging"

VM_HOST=$(echo "$VM" | cut -d@ -f2)
echo "=== Syncing TM Scripts to $VM_HOST/tm-scripts/ ==="

rm -rf "$STAGING" && mkdir -p "$STAGING"

# Source map: deploy_name -> local_path
declare -A SOURCES=(
  ["browser-agent.user.js"]="$HOME/repos/browser-agent/browser-agent.user.js"
  ["phone-agent.user.js"]="$HOME/repos/phone-agent/phone-agent.user.js"
  ["remote-agent.user.js"]="$HOME/repos/freeGames/src/local-checkout/remote-agent.user.js"
  ["reddit-auto-hide.user.js"]="$HOME/repos/reddit-auto-hide/reddit-auto-hide.user.js"
  ["browser-logs.user.js"]="$HOME/repos/scripts/browser-logs.user.js"
  ["google-voice-enhanced.user.js"]="$HOME/repos/scripts/Google Voice Enhanced.user.js"
  ["humblechoice-oneclickclaim.user.js"]="$HOME/repos/humblechoice-oneclickclaim/humblechoice-oneclickclaim.user.js"
  ["launcher.user.js"]="$HOME/repos/scripts/launcher.user.js"
  ["auto-checkout.user.js"]="$HOME/repos/freeGames/src/local-checkout/auto-checkout.user.js"
  ["browser-state.user.js"]="$HOME/repos/freeGames/src/local-checkout/browser-state.user.js"
  ["tm-updater.user.js"]="$HOME/repos/freeGames/src/local-checkout/tm-updater.user.js"
)

# Scripts that also need ungated copies at /var/www/html/ root for @updateURL
UNGATED=(
  browser-agent.user.js
  phone-agent.user.js
  remote-agent.user.js
  auto-checkout.user.js
  browser-state.user.js
  tm-updater.user.js
)

echo ""
echo "Collecting scripts:"
for dest in "${!SOURCES[@]}"; do
  src="${SOURCES[$dest]}"
  if [[ -f "$src" ]]; then
    cp "$src" "$STAGING/$dest"
    version=$(grep -m1 '@version' "$src" | sed 's/.*@version\s*//' || true)
    echo "  $dest -> v${version:-unknown}"
  else
    echo "  WARN: $src not found, skipping $dest"
  fi
done

# Copy index.html
cp "$SCRIPT_DIR/tm-scripts/index.html" "$STAGING/index.html"
echo "  index.html"

# Upload to VM
echo ""
echo "Uploading to VM..."
$SSH_CMD "rm -rf /tmp/tm-scripts-upload && mkdir -p /tmp/tm-scripts-upload"
scp -i "$VM_KEY" "$STAGING"/* "$VM:/tmp/tm-scripts-upload/"

# Deploy to /var/www/html/tm-scripts/
echo "Deploying to /var/www/html/tm-scripts/..."
$SSH_CMD "sudo mkdir -p /var/www/html/tm-scripts && \
  sudo cp /tmp/tm-scripts-upload/* /var/www/html/tm-scripts/ && \
  sudo chown -R www-data:www-data /var/www/html/tm-scripts/"

# Deploy ungated copies to root for @updateURL
echo "Deploying ungated copies to /var/www/html/..."
for f in "${UNGATED[@]}"; do
  if $SSH_CMD "test -f /var/www/html/tm-scripts/$f"; then
    $SSH_CMD "sudo cp /var/www/html/tm-scripts/$f /var/www/html/$f && sudo chown www-data:www-data /var/www/html/$f"
    echo "  /var/www/html/$f"
  fi
done

# Cleanup
$SSH_CMD "rm -rf /tmp/tm-scripts-upload"
rm -rf "$STAGING"

echo ""
echo "=== Done! Visit https://$VM_HOST/tm-scripts/ ==="
