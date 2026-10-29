---
name: team-coordination
description: "Use when work needs more than one agent in an Agents Hub team: read TEAM.md, pick members by role, hand off, follow up, review."
version: 1.1.0
---

# Coordinating work across the agent team

Use this only when the work really needs someone else. If doing it yourself is faster, do it yourself.

## 1. Know the team

- Read `<root HERMES_HOME>/agents-hub/TEAM.md`: `id`, name, role, who they report to, model and strengths.
  The owner edits the roster in the Hub (Settings tab) and the Hub regenerates this file.
- "Reports to" is the line of work: hand work down to people who report to you, report up to the one you report to.
  Do not skip levels without a reason.

## 2. Pick people

1. Split the request into pieces with concrete outputs (files, test results, drafts, decisions).
2. For each piece, pick the member whose role and strengths fit best. If two fit, pick the one closer to you.
3. If nobody fits, do it yourself or tell the owner the team lacks that skill (the owner can create an agent in the Hub).
4. Important output gets a reviewer other than its author (for example a process or QA member).

## 3. Hand work off

Write the brief to a file (`<work folder>/<id>-<task>.prompt.md`): goal, scope (files or folders it may touch),
constraints (no spending, publishing, deleting data or reading secrets), acceptance criteria, deadline, and ask for a
**single JSON line** summarizing the result at the end.

Send it (in the background if it is long):

```
hermes -p <id> chat -Q --oneshot --source tool --query-file <prompt.md>
```

The Hub shows this as a conversation between the two agents, and the receiver shows "Working in another session".
For a small sub-task that needs no separate role, use `delegate_task` (a sub-agent) instead.

## 4. Follow up and accept

- Track each hand-off as one of your goals, e.g. "Dev Backend ships the login API (tested)". Mark it `done` only after
  you have received and checked the result.
- Read the final JSON line and check the real output (files, tests, logs). Do not trust self-reports.
- Not good enough: send it back with specific fixes. Still failing after two rounds: tell the owner.

## 5. Report to the owner

Summarize as: result, evidence, blockers, needs approval, and who did what. Anything that needs the owner's decision
(cost, publishing, access, deleting data) is always asked first, never done on your own.
