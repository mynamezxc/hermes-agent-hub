# Agents Hub for Hermes Agent

A `/hub` page for [Hermes Agent](https://github.com/NousResearch/hermes-agent) Desktop to watch and chat with
every profile ("agent") of a multi-profile setup from one place.

## Features

- **Agents rail** with a distinct cartoon face per agent; the face shows the agent's mood: focused while
  running tools, thinking while reasoning, asking while waiting for a permission, happy after finishing, waiting
  when idle, asleep when offline (animated, respects reduced motion). Running-command badges for every agent.
- **Chat with any agent**: paste or drag images and files (thumbnails above the text, 10 shown then "+N"),
  slash commands, per-session model + reasoning picker, input grows up to 15 lines; older messages load as
  you scroll up.
- **Live turns as steps**: "Bước N · Working: <latest thought>" with that step's tools underneath; history
  folds the agent's self-narration and tool calls into one collapsible group per run.
- **Permission requests** inline: allow once, always allow in this goal (session scope), allow for 30
  minutes, or deny.
- **Edit an earlier message**: cut the session there and resend, optionally restoring the files the agent
  changed since (current content is backed up first).
- **Right bar**: goals (several, one current; add / edit / complete / delete; the agent keeps them current
  itself through a hidden `<hub-goals-update>{...}</hub-goals-update>` line), commands running now (visible
  vs. background, click to see the command or its output), changed files with approve all / per file,
  agents it works with (click opens that agent's chat, where its work in other sessions sits in the
  timeline at the time it happened), accessible folders.
- **Overview** with each agent's current goal and the goal history; **Schedules** (create cron jobs through
  Hermes's own cron backend); agent-to-agent conversations; kanban tasks; git changes with a diff viewer.

## Layout

- `dashboard/` — backend router (`plugin_api.py`), mounted at `/api/plugins/agents-hub`.
- `desktop/plugin.js` — the Desktop page (plain ESM against `@hermes/plugin-sdk`).
- `tests/` — backend tests: `python -m unittest discover -s tests` (needs a local Hermes install for the
  database schemas; `AGENTS_HUB_REAL_HOME`, `AGENTS_HUB_FIXTURE_DIR` override the paths).

## Install

1. Copy `dashboard/` to `<HERMES_HOME>/plugins/agents-hub/dashboard/`, add `agents-hub` to
   `plugins.enabled` in `config.yaml` and restart the gateway.
2. Copy `desktop/plugin.js` to `<HERMES_HOME>/desktop-plugins/agents-hub/plugin.js` and reload the app.

## Data and safety

- Profile databases are opened read-only. The Hub writes only its own state in
  `<HERMES_HOME>/agents-hub/` (goals, approved changes), new cron jobs (through Hermes's cron backend) and,
  on an explicit request, files restored to an earlier message (backed up first).
- Returned text is redacted; sensitive paths (`private/`, `*.dpapi`, `.env*`, `*token*`, `*secret*`,
  `*.pem`, `*.key`, `auth.json`, `credentials*`) are never read or diffed.
- Extra git repos for the "Thay đổi" tab: `<HERMES_HOME>/agents-hub.json` → `{"repos": ["/path"]}`, seeded
  from `AGENTS_HUB_EXTRA_REPOS` (os.pathsep-separated).
