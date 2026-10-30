---
name: team-coordination
description: "Use when work needs more than one agent in an Agents Hub team, or when you pick up a Kanban card: roles, hand-off, talking on cards, shared memory and files, unblocking, token economy."
version: 2.0.0
---

# Working as an agent team

Each member is a real agent. It keeps its own identity (`SOUL.md`), its own memory and skills, and it builds its
own experience across tasks. The team works like co-workers on a shared board: everyone can see who is doing what
and how far they are, they talk on the work item itself, and they share one small team memory and a folder of files.
Nobody needs the whole context pasted into every message.

Use other members only when the work really needs them. If doing it yourself is faster, do it yourself.

## 1. Know the team and where things are

- `<root HERMES_HOME>/agents-hub/TEAM.md`: id, name, role, who they report to, model, strengths. The owner edits the
  roster in the Hub. Hand work down to people who report to you, report up to the one you report to.
- `<root HERMES_HOME>/agents-hub/shared/`: the **shared team space**.
  - `NOTES.md` is team memory: one dated line per durable fact (decision, convention, where something lives, who
    owns what).
  - `files/` holds files handed between members.
  - Read `NOTES.md` when you start a card (it is short on purpose).
- Your **own memory** is your experience: lessons, pitfalls, the owner's preferences for your kind of work, where your
  inputs live. The memory tool writes it into your profile and it loads into every one of your sessions.

## 2. Hand work off: one Kanban card per outcome

Hermes's dispatcher starts the assignee as a full worker under its own profile, soul, memory, skills, permissions and
approvals. Create cards with `kanban_create`:

- `assignee` (id from TEAM.md), `title` (the outcome, short), `parents` (cards that must finish first).
- **`body`: only what is specific to this card.** Goal, inputs (paths), output (path), acceptance criteria,
  deadline, who reviews.
  - Shared rules belong in the assignee's SOUL/memory or one rules file you point to (`Read <path> first`).
  - Do not paste the same rules into every card. Long repeated bodies cost tokens on every run and still get skimmed.
- Grant what the work needs **in the card**, explicitly. Example: "may write files in `<output dir>`", "may log in to the
  local test site with <how>". A worker that has to guess its permissions stops and asks.
- Never start another agent yourself with `hermes ... chat --oneshot`; for a small sub-task with no separate role, use
  `delegate_task`.

## 3. While you work a card: be visible

- `kanban_heartbeat` with a short note at each milestone ("3/8 articles written", "tests running"). The Hub shows it
  as "what X is doing now".
- Talk on the card with `kanban_comment`: questions to the card's creator, findings a reviewer needs, a hand-over note.
  Mention the other agent by id (`@qa`). Comments are the team's conversation, and the Hub lists them per card.
- Put large outputs in files (`shared/files/` or the card's output path) and **comment the path**, not the content.
- Use `kanban_show` only for what you need. The card body plus your memory should be enough to start.

## 4. When you are stuck: ask first, block last

1. Look for the answer in the card, its comments, `shared/NOTES.md`, your memory, and the rules file the card points to.
2. If an agent can answer (usually the card's creator), ask it on the card with a comment. Continue with the parts
   you can do.
3. Block (`kanban_block`) only when nothing else can move. Pick the right kind:
   - `needs_input`: the creator or the owner must decide.
   - `capability`: a hard wall only the owner can remove (access, money, credentials).
   - `dependency`: waiting on another card.
4. A block reason says what you need, from whom, and what is already done. The Hub shows it as "Waiting on …".
5. Never block on something already granted in the card, its rules file or your SOUL. Re-read before blocking.

Creators: check your cards that wait on you (Hub → Overview "Team now", Tasks → Blocked), answer on the card,
then `kanban_unblock`.

## 5. Finish: hand over and learn

- `kanban_complete` with a one-paragraph summary, `artifacts` (absolute paths) and machine-readable metadata.
- **Save experience before you finish**, 1–3 short items, only durable ones:
  - your **memory**: a pitfall, a working method, an owner preference for your kind of work;
  - your **skill**: a procedure you will repeat;
  - `shared/NOTES.md`: a fact the whole team needs, as one dated line with your id and the path or card.
- The reviewer of your work is another member. When your card comes back with comments, fix exactly those.

## 6. Follow up and accept (for the creator)

- Track each hand-off as one of your goals. Mark it `done` only after you checked the real output (files, tests,
  logs). Do not trust self-reports.
- Not good enough: comment specific fixes or create a follow-up card. Still failing after two rounds: tell the owner.

## 7. Token economy (why the rules above)

- Your system prompt (soul, memory, skills index) is the same in every session, so the model provider caches it.
  Do not change it mid-session. Keep memory entries short and few.
- Per-task context comes from the card and the files it points to. Read files on demand, the parts you need, instead
  of loading everything.
- Hand summaries and paths to each other, not transcripts.

## 8. Report to the owner

Result, evidence, blockers, what needs approval, and who did what. Anything that needs the owner's decision (cost,
publishing, access, deleting data) is always asked first, never done on your own.
