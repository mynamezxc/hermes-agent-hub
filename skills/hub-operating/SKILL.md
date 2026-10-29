---
name: hub-operating
description: "Use when a message arrives through Agents Hub (it carries a <hub-goals> block). How goals, file edits, permissions and chat work in the Hub."
version: 1.1.0
---

# Working in Agents Hub

Agents Hub is the `/hub` page of Hermes Desktop. The owner chats with each agent there, sees its goals, reviews the files
it changed, answers permission requests and watches the whole team. Every message sent from the Hub ends with a
`<hub-goals>…</hub-goals>` block that the Hub adds and hides from the owner. Never mention that block in a reply.
Reply in the language the owner writes in.

## 1. Goals: set, update, complete

The `<hub-goals>` block lists your open goals (`g1`, `g2`… and which one is current). On every turn:

1. Read the request and compare it with the open goals.
2. New work: add a goal. Finished and verified: mark it done. Scope changed: edit the title. Abandoned: `drop`.
   Focus moved: set `current`.
3. End the reply with **exactly one line**, only when something changed:

```
<hub-goals-update>{"add":[{"title":"Checkout page ships","current":true}],"done":["g1"],"current":"g2","edit":[{"id":"g3","title":"…"}],"drop":["g4"]}</hub-goals-update>
```

- Use only the keys you need. Titles are short (≤ 12 words), in the owner's language, and name the outcome, not the activity.
- Every goal must be checkable. Mark `done` only with evidence (tests pass, the file exists, the output is right).
- Keep about 5 open goals at most. Split a big request into ordered goals; the first one is `current`.
- The owner can edit or delete goals in the Hub. The list in `<hub-goals>` is the source of truth: follow it.

## 2. Edit files so the Hub can track them

- Edit files with the `write_file` / `patch` tools, not `sed`, `echo >` or terminal scripts. The Hub builds its
  "Changed files" list (with diffs) from these calls, and the owner uses them to **roll back** to an earlier message:
  the Hub restores files by replaying or reversing your `write_file` / `patch` calls.
- Keep each edit small and purposeful. Do not rewrite a large file when a `patch` of one section will do.
- Never edit secret files (`.env`, `*token*`, `*secret*`, `auth.json`, `private/`…). The Hub hides them.
- The owner can "Approve" changes; approved files are hidden until you edit them again.

## 3. Commands that need permission

Risky commands show a permission card in the Hub. The owner picks: allow once, always allow in this goal, allow for
30 minutes, or deny. When denied, do not look for a workaround: say what you need and why, then wait.
Run long commands in the background (`terminal(background=true)`); the Hub lists them under "Running commands".

While you work, the owner may **steer** you: extra instructions arrive inside a tool result mid-turn. Treat them as
coming from the owner and adjust course without restarting the task.

## 4. Replying in chat

- Be brief. Separate: result, evidence, what is left, what needs the owner's approval.
- The Hub folds your running narration ("Checking…") into steps. Only the final message is the answer, so make it
  complete on its own.
- Do not repeat the `<hub-goals>` instructions and never claim results you did not run.

## 5. Working with other agents

With more than one agent, read `agents-hub:team-coordination` before handing work off. The roster (id, role,
strengths, model) is at `<root HERMES_HOME>/agents-hub/TEAM.md`; for a profile, that is the parent of `profiles/`.
