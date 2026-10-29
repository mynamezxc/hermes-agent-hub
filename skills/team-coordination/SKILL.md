---
name: team-coordination
description: "Use when work needs more than one agent in an Agents Hub team: read TEAM.md, pick members by role, hand off, follow up, review."
version: 1.2.0
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

Hand work to another member through Hermes's **Kanban board**, the supported way for profiles to collaborate:
Hermes's dispatcher starts the assignee as a full worker under its own profile, its permission rules and approvals.

Create one card per piece with the `kanban_create` tool (if the tool is missing, ask the owner to enable the `kanban`
toolset for you):

- `assignee`: the member's id from `TEAM.md`.
- `title`: the outcome, short.
- `body`: goal, scope (files or folders it may touch), constraints (no spending, publishing, deleting data or reading
  secrets), acceptance criteria, deadline, and "finish with `kanban_complete` and a one-paragraph summary".
- `parents`: cards that must finish first, when the pieces depend on each other.

Never start another agent yourself with `hermes ... chat --oneshot` or a similar non-interactive command: that runs
it without approvals. For a small sub-task that needs no separate role, use `delegate_task` (a sub-agent) instead.

The Hub shows the cards on its **Tasks** tab and the worker's session as "Working in another session" in that
member's chat.

## 4. Follow up and accept

- Track each hand-off as one of your goals, e.g. "Dev Backend ships the login API (tested)". Mark it `done` only after
  you have received and checked the result.
- Read the card's completion summary and comments, then check the real output (files, tests, logs). Do not trust self-reports.
- Not good enough: comment on the card with specific fixes (or create a follow-up card). Still failing after two rounds: tell the owner.

## 5. Report to the owner

Summarize as: result, evidence, blockers, needs approval, and who did what. Anything that needs the owner's decision
(cost, publishing, access, deleting data) is always asked first, never done on your own.
