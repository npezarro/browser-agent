#!/usr/bin/env bash
# Deploy browser-agent to VM and install TM script + install page
set -euo pipefail

VM="deployuser@pezant.ca"
VM_KEY="$HOME/.ssh/vm_key"
VM_PATH="/home/deployuser/browser-agent"
SSH="ssh -i $VM_KEY $VM"

echo "=== Deploying browser-agent to VM ==="

# 1. Sync files to VM + ensure cowork sessions dir
$SSH "mkdir -p $VM_PATH/lib /home/deployuser/cowork-sessions"
scp -i "$VM_KEY" agent-server.js package.json ecosystem.config.js .env "$VM:$VM_PATH/" 2>/dev/null || \
scp -i "$VM_KEY" agent-server.js package.json ecosystem.config.js "$VM:$VM_PATH/"
scp -i "$VM_KEY" lib/core.js "$VM:$VM_PATH/lib/"

# 2. Install deps + restart PM2
$SSH "cd $VM_PATH && npm install --production && pm2 delete browser-agent 2>/dev/null; pm2 start ecosystem.config.js && pm2 save"

# 3. Deploy TM userscript + install page to web root (needs sudo)
scp -i "$VM_KEY" browser-agent.user.js install.html "$VM:/tmp/"
$SSH "sudo cp /tmp/browser-agent.user.js /var/www/html/browser-agent.user.js && \
      sudo cp /tmp/install.html /var/www/html/install.html && \
      sudo chown www-data:www-data /var/www/html/browser-agent.user.js /var/www/html/install.html"

# 4. Add Apache proxy if not already present
$SSH "grep -q 'browser-agent' /etc/apache2/sites-enabled/wordpress-https.conf 2>/dev/null || echo '
    # Browser Agent API
    ProxyPass /api/browser-agent/ http://127.0.0.1:3102/
    ProxyPassReverse /api/browser-agent/ http://127.0.0.1:3102/' | sudo tee -a /etc/apache2/sites-enabled/wordpress-https.conf > /dev/null && sudo systemctl reload apache2"

echo ""
echo "=== Deployed ==="
echo "Server:  PM2 process 'browser-agent' on port 3102"
echo "Script:  https://pezant.ca/browser-agent.user.js"
echo "Install: https://pezant.ca/install.html"
echo "API:     https://pezant.ca/api/browser-agent/"
