import os
import shutil

os.replace("/root/pumpapi-agent/scripts/SOUL.md", "/root/.hermes/SOUL.md")
shutil.copytree("/root/pumpapi-agent/scripts/pumpapi-agent", "/root/.hermes/skills/pumpapi-agent", dirs_exist_ok=True)
