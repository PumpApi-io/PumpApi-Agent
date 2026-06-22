#!/bin/sh
set -e

cd /root/pumpapi-agent
before=$(git rev-parse HEAD)
git pull --ff-only
after=$(git rev-parse HEAD)

if [ "$before" != "$after" ]; then
/root/pumpapi-agent/venv/bin/pip install -r install/requirements.txt
systemctl restart pumpapi-agent.service
#hermes update -y
#systemctl restart hermes-gateway
python3 update_hermes_soul_and_skills.py
fi
