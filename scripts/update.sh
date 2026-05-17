#!/bin/sh
set -e

cd /root/pumpapi-agent
before=$(git rev-parse HEAD)
git pull --ff-only
after=$(git rev-parse HEAD)

if [ "$before" != "$after" ]; then
/root/pumpapi-agent/venv/bin/pip install -r backend/requirements.txt
systemctl restart pumpapi-agent.service
hermes update -y
systemctl restart hermes-gateway
fi
