#!/usr/bin/env bash
# Deploy browser-agent to VM and install TM script
set -euo pipefail

VM="deployuser@pezant.ca"
VM_KEY="$HOME/.ssh/vm_key"
VM_PATH="/home/deployuser/browser-agent"
SSH="ssh -i $VM_KEY $VM"

echo "=== Deploying browser-agent to VM ==="

# 1. Sync files to VM
$SSH "mkdir -p $VM_PATH"
scp -i "$VM_KEY" agent-server.js package.json ecosystem.config.js .env "$VM:$VM_PATH/" 2>/dev/null || \
scp -i "$VM_KEY" agent-server.js package.json ecosystem.config.js "$VM:$VM_PATH/"

# 2. Install deps + restart PM2
$SSH "cd $VM_PATH && npm install --production && pm2 delete browser-agent 2>/dev/null; pm2 start ecosystem.config.js && pm2 save"

# 3. Deploy TM userscript to web root
scp -i "$VM_KEY" browser-agent.user.js "$VM:/var/www/html/browser-agent.user.js"

# 4. Add Apache proxy if not already present
$SSH "grep -q 'browser-agent' /etc/apache2/sites-enabled/wordpress-https.conf 2>/dev/null || echo '
    # Browser Agent API
    ProxyPass /api/browser-agent/ http://127.0.0.1:3102/
    ProxyPassReverse /api/browser-agent/ http://127.0.0.1:3102/' | sudo tee -a /etc/apache2/sites-enabled/wordpress-https.conf > /dev/null && sudo systemctl reload apache2"

echo ""
echo "=== Deployed ==="
echo "Server:  PM2 process 'browser-agent' on port 3102"
echo "Script:  https://pezant.ca/browser-agent.user.js"
echo "API:     https://pezant.ca/api/browser-agent/"
echo ""
echo "Install TM script: open https://pezant.ca/browser-agent.user.js in Edge"
