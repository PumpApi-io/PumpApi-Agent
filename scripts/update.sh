#!/bin/sh
set -e
cd /root/pumpapi-agent
git pull --ff-only
/root/pumpapi-agent/venv/bin/pip install -r backend/requirements.txt
systemctl restart pumpapi-agent.service
