# Agents Hub for Hermes Agent

A `/hub` page for [Hermes Agent](https://github.com/NousResearch/hermes-agent) Desktop to watch, chat with and
coordinate every profile ("agent") of a multi-profile setup from one place. It ships with operating guides
(skills) so agents on a fresh install already know how the Hub works: goals, file changes, permissions and
teamwork.

## Features

- **Agents rail** with a distinct cartoon face per agent (random for new agents, re-rollable). The face shows the
  agent's mood: focused while running tools, thinking while reasoning, asking while waiting for a permission,
  happy after finishing, waiting when idle, asleep when offline (animated, respects reduced motion).
  Running-command badges for every agent.
- **Chat with any agent**: paste or drag images and files (thumbnails above the text, 10 shown then "+N"),
  slash commands, per-session model + reasoning picker, input grows up to 15 lines; older messages load as
  you scroll up.
- **Usage under the chat box**: Claude and Codex limits for the agent's login (5-hour session, weekly, …) as
  compact meters; hover for plan, reset times, token expiry and refresh. Cached for 10 minutes server-side,
  refreshed in the background; the last good numbers stay visible if a refresh fails.
- **Live turns as steps**: "Bước N · Working: <latest thought>" with that step's tools underneath; history
  folds the agent's self-narration and tool calls into one collapsible group per run.
- **Permission requests** inline: allow once, always allow in this goal (session scope), allow for 30
  minutes, or deny.
- **Edit an earlier message**: cut the session there and resend, optionally restoring the files the agent
  changed since (current content is backed up first).
- **Right bar**: goals (several, one current; add / edit / complete / delete; the agent keeps them current
  itself through a hidden `<hub-goals-update>{...}</hub-goals-update>` line), commands running now (visible
  vs. background, click to see the command or its output), changed files with approve all / per file,
  agents it works with, accessible folders.
- **Cấu hình (settings) tab**:
  - *Accounts*: per-agent login status for Codex and Claude, with log in / log in again through Hermes's own
    flows (Codex device code; Claude `hermes auth add anthropic` with the code pasted in the Hub; an existing
    Claude Code login is recognised). Other providers are listed with their status.
  - *Team*: name, role, who each agent reports to and what it is good at; create a new agent (a Hermes profile
    with a role `SOUL.md` and a random avatar); re-roll avatars; re-run setup.
- **Overview** with each agent's current goal and the goal history; **Schedules** (create cron jobs through
  Hermes's own cron backend); agent-to-agent conversations; kanban tasks; git changes with a diff viewer.

## How agents learn the Hub

- Every Hub message carries a small hidden `<hub-goals>` block: the open goals, the update format, and a
  pointer to the skills below (plus the team roster when there is more than one agent).
- Bundled skills, registered by the plugin as `agents-hub:<name>`:
  - `hub-operating`: goals (when to add / complete / drop, evidence before "done"), editing files with
    `write_file` / `patch` so diffs and rollback work, permissions, reply style.
  - `team-coordination`: read `TEAM.md`, pick members by role and capability, hand off with a prompt file,
    track hand-offs as goals, verify results, report.
  - `hub-setup`: install, first-run setup, creating agents, accounts and usage.
- First run (automatic when the Hub opens, or "Chạy lại khởi tạo"): builds `<HERMES_HOME>/agents-hub/team.json`
  from each profile's `profile.yaml` (existing entries are kept as edited) and writes `TEAM.md` for agents to
  read. Existing `SOUL.md` / `config.yaml` files are not touched.

## Layout

- `plugin.yaml`, `__init__.py`: agent half (registers the skills in `skills/`).
- `dashboard/`: backend router (`plugin_api.py`), mounted at `/api/plugins/agents-hub`.
- `desktop/plugin.js`: the Desktop page (plain ESM against `@hermes/plugin-sdk`).
- `tests/`: backend tests: `python -m unittest discover -s tests` (needs a local Hermes install for the
  database schemas; `AGENTS_HUB_REAL_HOME`, `AGENTS_HUB_FIXTURE_DIR` override the paths).

## Install

```
hermes plugins install mynamezxc/gaugau-agent --enable
```

Then restart the gateway (Desktop: Ctrl+K, "Restart gateway"), install or enable the desktop half in
Capabilities > Plugins (install from git with the same repo URL) and open `/hub`.

Manual install: copy the repo to `<HERMES_HOME>/plugins/agents-hub/`, add `agents-hub` to `plugins.enabled`
in `config.yaml`, copy `desktop/plugin.js` to `<HERMES_HOME>/desktop-plugins/agents-hub/plugin.js`, restart
the gateway and reload the app.

## Data and safety

- Profile databases are opened read-only. The Hub writes only its own state in
  `<HERMES_HOME>/agents-hub/` (team, goals, approved changes, setup marker), new cron jobs (through Hermes's
  cron backend), new profiles you create from the Hub and, on an explicit request, files restored to an
  earlier message (backed up first).
- Logins go through Hermes; tokens stay in Hermes's own stores. The Hub returns only status fields (logged
  in, expiry, refresh) and usage percentages; the pasted Claude code is passed straight to the waiting
  `hermes auth add` process and never stored or logged. Usage is read with Hermes's read-only usage
  fetchers (no token refresh).
- Returned text is redacted; sensitive paths (`private/`, `*.dpapi`, `.env*`, `*token*`, `*secret*`,
  `*.pem`, `*.key`, `auth.json`, `credentials*`) are never read or diffed.
- Extra git repos for the "Thay đổi" tab: `<HERMES_HOME>/agents-hub.json` with `{"repos": ["/path"]}`, seeded
  from `AGENTS_HUB_EXTRA_REPOS` (os.pathsep-separated).
