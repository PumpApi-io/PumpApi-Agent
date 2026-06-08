#!/bin/sh
exec > /var/log/initscript.log 2>&1
set -x
export DEBIAN_FRONTEND=noninteractive

export AGENT_SOLANA_BASE58_PRIVATE_KEY="$1"
export AGENT_SOLANA_BASE58_PUBLIC_KEY="$2"
export PUMPAPI_API_KEY="$3"

apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list

apt-get update -y
apt-get -y \
  -o Dpkg::Options::="--force-confdef" \
  -o Dpkg::Options::="--force-confold" \
  upgrade

echo PUMPAPI_API_KEY=${PUMPAPI_API_KEY} >> /etc/environment
echo AGENT_SOLANA_BASE58_PRIVATE_KEY=${AGENT_SOLANA_BASE58_PRIVATE_KEY} >> /etc/environment
echo AGENT_SOLANA_BASE58_PUBLIC_KEY=${AGENT_SOLANA_BASE58_PUBLIC_KEY} >> /etc/environment
apt install nodejs npm -y
export PATH="/root/.local/bin:$PATH"
chmod +x /root/pumpapi-agent/scripts/update.sh
sudo apt-get install -y python3-venv
python3 -m venv /root/pumpapi-agent/venv
/root/pumpapi-agent/venv/bin/pip install -r /root/pumpapi-agent/install/backend_requirements.txt
curl -fsSL https://raw.githubusercontent.com/PumpApi-io/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup
hermes config set model.provider custom
hermes config set model.base_url https://api.pumpapi.ai/v1
hermes config set model.api_key $PUMPAPI_API_KEY
hermes config set model.default anthropic/claude-opus-4-8
hermes config set approvals.mode off
hermes config set browser.provider local
sudo tee /root/.hermes/.env > /dev/null <<EOF
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=61317
API_SERVER_KEY=$PUMPAPI_API_KEY
PUMPAPI_API_KEY=$PUMPAPI_API_KEY
EOF
sudo hermes gateway install --system --run-as-user root
sudo systemctl enable --now hermes-gateway
python3 /root/pumpapi-agent/scripts/update_hermes_soul_and_skills.py
export PYTHONPATH=/root/.hermes/skills/pumpapi-agent/notify-user/scripts:$PYTHONPATH
sudo tee /etc/systemd/system/pumpapi-agent.service > /dev/null <<'EOF'
[Unit]
Description=PumpApi Agent — web UI proxying chats to Hermes Agent api_server
After=network.target
Wants=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/pumpapi-agent
ExecStart=/root/pumpapi-agent/venv/bin/python /root/pumpapi-agent/backend/server.py
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
sudo systemctl enable --now pumpapi-agent.service

tee /etc/systemd/system/pumpapi-agent-update.service > /dev/null <<'EOF'
[Unit]
Description=PumpApi Agent auto-update

[Service]
Type=oneshot
ExecStart=/root/pumpapi-agent/scripts/update.sh
EOF

tee /etc/systemd/system/pumpapi-agent-update.timer > /dev/null <<'EOF'
[Unit]
Description=Run PumpApi Agent update every 30 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
Persistent=true
Unit=pumpapi-agent-update.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now pumpapi-agent-update.timer

ufw allow 80
ufw allow 443


sudo apt install caddy -y

PUBLIC_IP=$(hostname -I | awk '{print $1}')
sudo tee /etc/caddy/Caddyfile > /dev/null <<EOF
{
	auto_https disable_redirects

	cert_issuer acme {
		profile shortlived
	}
}

http://$PUBLIC_IP {
	reverse_proxy 127.0.0.1:61318
}

https://$PUBLIC_IP {
	reverse_proxy 127.0.0.1:61318
}
EOF
sudo systemctl restart caddy
sudo apt install screen -y
/root/pumpapi-agent/venv/bin/pip install -r /root/pumpapi-agent/install/hermes_pip_requirements.txt