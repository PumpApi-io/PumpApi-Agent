---
name: notify-user
description: Use when you are writing code (a bot, monitor, long-running script, background task) that needs to push messages, status updates, stats, charts, or alerts back to the user in whatever chat / platform they originally messaged you from — Hermes API server, Telegram, Discord, etc. More flexible than cron — your code decides exactly when to send, no fixed schedule, no separate agent run, works on any platform Hermes supports.
---

# notify-user

Pythonic helper for sending messages from your own scripts back to the user, on the same platform and chat they wrote you from. Works for api_server (Hermes web UI), Telegram, Discord, and any other platform Hermes' `send_message_tool` supports.

## When to use this skill

Load this skill whenever you are writing code that must talk back to the user without being driven by a scheduled cron or by the user sending a new message. Typical cases:

- Trading / Solana / pump.fun bots that should report each confirmed buy/sell.
- Long-running scrapers, monitors, watchers (price, blocks, RSS, logs, etc.).
- Bots that send periodic balance / PnL / progress updates or matplotlib charts.
- Background jobs that finish later and need to announce completion.
- Any script that decides on its own "now is the time to message the user".

Do NOT use cron for this — cron only runs at fixed intervals, can only kick off a finished script or spin up an agent, and does not support the `api_server` platform. `notify` is the right tool.

## How it works

There is a tiny module `notify.py` shipped with this skill (see `scripts/notify.py`). It exposes one function:

```python
from notify import notify

notify(platform, chat_id, text, thread_id=None, image=None)
```

- For `platform == "api_server"` it appends an assistant message directly into the Hermes web chat DB and pings the SSE hook so the user's browser receives it in real time.
- For every other platform (`telegram`, `discord`, …) it routes the message through Hermes' internal `send_message_tool`, which uses the bot tokens configured in `~/.hermes/.env`.

`image` is optional — pass an absolute path (e.g. `/tmp/chart.png`) and it will be attached / inlined as a media reference.

## Setup (do this once per script)

### 1. Locate `notify.py`

`notify.py` is shipped inside THIS skill at `scripts/notify.py` — when you load the skill via `skill_view`, the response tells you the absolute skill directory; `notify.py` lives in its `scripts/` subfolder.

You already able to import notify because step with export PYTHONPATH=/root/.hermes/skills/pumpapi-agent/notify-user/scripts:$PYTHONPATH already done.

### 2. Find which `(platform, chat_id)` to send to

You MUST run this first, every time, before writing the script:

```bash
env | grep -i hermes_session
```

This prints env vars like `HERMES_SESSION_ID=...`, `HERMES_SESSION_PLATFORM=...`, `HERMES_SESSION_CHAT_ID=...`, `HERMES_SESSION_THREAD_ID=...`. They tell you which chat the user is actually writing from.

Two cases, handle them differently:

- **`platform == "api_server"`** (Hermes web UI):
  - `platform`: take from `HERMES_SESSION_PLATFORM` (or just hardcode `"api_server"` once you've confirmed it).
  - `chat_id`: do NOT use `HERMES_SESSION_ID` here. The real `chat_id` is in the system prompt's "Current Session Context" block (looks like `chat_id: 5efefd28fe1945c9a27476bbd765d8b8`). Copy it verbatim.
  - `thread_id`: not used.

- **Any other platform** (`telegram`, `discord`, `whatsapp`, …):
  - `platform`: from `HERMES_SESSION_PLATFORM`.
  - `chat_id`: from `HERMES_SESSION_CHAT_ID` (this is what `env | grep` is FOR — without running it you don't have the chat id for these platforms).
  - `thread_id`: from `HERMES_SESSION_THREAD_ID` if set (Telegram forum topic, Discord thread, etc.).

If `env | grep -i hermes_session` returns nothing, you are not inside a Hermes agent process and `notify` will not work — fix that first.

### 3. Hardcode the resolved values into your script

The background script does NOT inherit the agent's env, so bake `platform`, `chat_id`, and `thread_id` into the script as constants (or pass them via `argparse` / your own env vars).

## Minimal example

```python
from notify import notify

PLATFORM = "api_server"
CHAT_ID  = "5efefd28fe1945c9a27476bbd765d8b8"   # from system prompt

notify(PLATFORM, CHAT_ID, "Bot started.")
notify(PLATFORM, CHAT_ID, "Bought 1.2 SOL of $FOO at 0.0000034")
notify(PLATFORM, CHAT_ID, "Hourly balance chart", image="/tmp/balance.png")
```

For Telegram:

```python
notify("telegram", "-1001234567890", "Filled buy: 0.5 SOL → 12,345 $BAR")
# With a forum topic / thread:
notify("telegram", "-1001234567890", "ping", thread_id="42")
```

## Critical: run your script with the Hermes venv Python

You MUST launch the background script with the Hermes venv interpreter, otherwise `notify` cannot import Hermes internals and the message will never reach the user:

```bash
/usr/local/lib/hermes-agent/venv/bin/python3 /path/to/your_bot.py
```

Plain `python3`, `python`, or any other venv will fail with import errors for `hermes_cli` / `tools.send_message_tool`.

## Running in the background

Use `screen` (or `tmux`) so the script keeps running after the current agent turn ends:

```bash
screen -dmS mybot /usr/local/lib/hermes-agent/venv/bin/python3 /path/to/your_bot.py
```

Useful commands:

- List sessions: `screen -ls`
- Attach: `screen -r mybot`
- Detach again: Ctrl-A then D
- Kill: `screen -S mybot -X quit`

Also acceptable: `terminal(background=true, ...)` from inside the agent — that gives you a `session_id` for polling. For long-lived bots that should outlive the current turn, prefer `screen`.

## Pitfalls

- Wrong interpreter → import error, no message sent. Always `/usr/local/lib/hermes-agent/venv/bin/python3`.
- `image=` must be an absolute path that exists on disk when the function is called.
- For long-running loops, wrap each `notify(...)` in try/except so a transient send failure does not kill the bot.

## Related skills

- `solana-pumpapi-bots` — for Solana / pump.fun bots that use `notify` to report fills, balances, and hourly charts to the user.
