---
name: hub-setup
description: "Use when setting up Agents Hub on a new Hermes install, creating a new agent, or explaining how the Hub is wired (team roster, avatars, accounts, usage)."
version: 1.1.0
---

# Setting up Agents Hub and creating agents

## Install (once)

```
curl -fsSL https://raw.githubusercontent.com/mynamezxc/hermes-agent-hub/main/install.sh | bash      # macOS / Linux
irm https://raw.githubusercontent.com/mynamezxc/hermes-agent-hub/main/install.ps1 | iex             # Windows
# or: hermes plugins install mynamezxc/hermes-agent-hub --enable
```

The scripts check that Hermes is installed, install or update the plugin and enable its agent half. Then, once:
1. Restart the gateway (Desktop: Ctrl+K, "Restart gateway").
2. Turn on the desktop half: Hermes Desktop keeps a package's desktop half OFF until the owner enables it
   (`--enable` only covers the agent half). Settings > Plugins (or Capabilities > Plugins) > Agents Hub > Desktop on.
   If the owner says "Agents Hub is not in the sidebar" after installing, this is the cause; the plugin cannot and must
   not switch itself on.
3. Open Agents Hub from the sidebar (Ctrl+Alt+H). Still missing: Ctrl+K > Reload desktop plugins, and check that
   `<HERMES_HOME>/desktop-plugins/agents-hub/plugin.js` exists.

The first time the Hub opens it runs setup (or press "Re-run setup" in the Settings tab):
- `agents-hub/team.json`: every Hermes profile becomes a member: name from `display_name` in `profile.yaml`, role from
  `description`, reports to `default`, and a random avatar. Existing entries are kept as the owner edited them.
- `agents-hub/TEAM.md`: the same roster, written for agents to read when they coordinate.
- `agents-hub/setup.json`: the setup version marker.

The Hub never changes an existing profile's `SOUL.md` or `config.yaml`.

## Creating an agent

In the Hub: Settings tab, "New agent". Enter id, name, role, strengths, who it reports to and which agent to copy the
config from. The Hub calls `hermes_cli.profiles.create_profile(id, clone_from=…, clone_config=True)` so the new agent
shares the model login, writes `profile.yaml` (name, description), writes a role `SOUL.md` that points to
`agents-hub:hub-operating` and `TEAM.md`, adds the agent to the team with a random avatar and regenerates `TEAM.md`.

From a terminal works too; the Hub picks the new profile up next time it opens:
`hermes profile create <id> --clone`, then edit `profiles/<id>/SOUL.md`.

Avatars are cartoon faces generated from a seed: random for new agents, "New avatar" rolls another. The face follows
what the agent is doing: focused while running tools, thinking while reasoning, asking while waiting for a permission,
happy when done, waiting when idle, asleep when offline.

## Accounts and usage

The Settings tab uses Hermes's own login flows:
- Codex (ChatGPT): Hermes's device-code flow. The Hub shows the code and link; the owner confirms in the browser.
- Claude: runs `hermes [-p <id>] auth add anthropic`, opens the authorize link, the owner pastes the code into the Hub.
  An existing Claude Code login (`~/.claude`) is recognized too.

Under the chat box the Hub shows Claude and Codex usage: 5-hour session, weekly window, reset times, and when the
token expires or refreshes. It reads usage with Hermes's read-only usage fetchers, caches it for 10 minutes and always
keeps the last numbers on screen. Tokens are never printed, copied or sent; the Hub returns status and percentages only.
