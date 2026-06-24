#!/bin/sh
set -e

cd /root/pumpapi-agent
before=$(git rev-parse HEAD)
# git fetch ; git reset --hard origin/main # discard local changes and sync
git pull --ff-only
after=$(git rev-parse HEAD)

if [ "$before" != "$after" ]; then
/root/pumpapi-agent/venv/bin/pip install -r install/backend_requirements.txt
systemctl restart pumpapi-agent.service
#hermes update -y
#systemctl restart hermes-gateway
python3 scripts/update_hermes_soul_and_skills.py
fi
