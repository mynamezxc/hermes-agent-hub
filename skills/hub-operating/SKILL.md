---
name: hub-operating
description: "Use when a message arrives through Agents Hub (it carries a <hub-goals> block). How goals, file edits, permissions and chat work in the Hub."
version: 1.3.0
---

# Working in Agents Hub

Agents Hub is the `/hub` page of Hermes Desktop. The owner chats with each agent there, sees its goals, reviews the files
it changed, answers permission requests and watches the whole team. The Hub adds a short `<hub-goals>…</hub-goals>`
block to a message **only when your Hub state is new to this chat** (the first message of a session) **or has
changed** (a goal or saved tool was added, edited or closed). Most messages carry no block: the last block you saw
in this conversation is still current. The owner never sees the block; never mention it. Reply in the language the
owner writes in.

## 1. Goals: set, update, complete

The latest `<hub-goals>` block in the conversation lists your open goals (`g1`, `g2`… and which one is current). On every turn:

1. Read the request and compare it with the open goals.
2. A goal is an outcome that outlives this reply: a feature, a release, a step waiting on someone. Do **not** add a
   goal for a question, a chat, a small fix or anything you finish in this same reply; just answer.
   Prefer updating an existing goal over adding one. Finished and verified: mark it done. Scope changed: edit the
   title. Abandoned: `drop`. Focus moved: set `current`. Goals flagged `(idle Nd)` need a decision: done or drop.
3. End the reply with **exactly one line**, only when something changed:

```
<hub-goals-update>{"add":[{"title":"Checkout page ships","current":true}],"done":["g1"],"current":"g2","edit":[{"id":"g3","title":"…"}],"drop":["g4"]}</hub-goals-update>
```

- Use only the keys you need. Titles are short (≤ 12 words), in the owner's language, and name the outcome, not the activity.
- Every goal must be checkable. Mark `done` only with evidence (tests pass, the file exists, the output is right).
- At most one new goal per reply and about 5 open goals; the Hub ignores adds beyond 6 open goals, rewordings of
  an open goal and placeholder titles.
- The owner can edit or delete goals in the Hub. The newest `<hub-goals>` list is the source of truth: follow it.

## 1b. Saved tools

The block also lists **saved tools** (`t1 Name: target`): apps, dashboards and scripts you built that the owner
reopens by name. When the owner says "open X", open that target (browser URL, file, or run the command).
Save one only for a substantial tool/app the owner will come back to, or when asked to add it to the Hub; never
scratch files, one-off scripts or test output. Same one-line protocol, at the end of the reply:

```
<hub-tools-update>{"add":[{"name":"Invoice dashboard","open":"http://127.0.0.1:8050","note":"Dash app, start with run.bat"}],"remove":["t2"]}</hub-tools-update>
```

## 2. Edit files so the Hub can track them

- Edit files with the `write_file` / `patch` tools, not `sed`, `echo >` or terminal scripts. The Hub builds its
  "Changed files" list (with diffs) from these calls, and the owner uses them to **roll back** to an earlier message:
  the Hub restores files by replaying or reversing your `write_file` / `patch` calls.
- Keep each edit small and purposeful. Do not rewrite a large file when a `patch` of one section will do.
- Never edit secret files (`.env`, `*token*`, `*secret*`, `auth.json`, `private/`…). The Hub hides them.
- The owner can "Approve" changes; approved files are hidden until you edit them again.

## 3. Commands that need permission

Risky commands show a permission card in the Hub. The owner picks: allow once, always allow in this goal, always
allow, or deny. The Hub never answers for the owner. When denied, do not look for a workaround: say what you need and why, then wait.
Run long commands in the background (`terminal(background=true)`); the Hub lists them under "Running commands".

While you work, the owner may **steer** you: extra instructions arrive inside a tool result mid-turn. Treat them as
coming from the owner and adjust course without restarting the task.

## 4. Replying in chat

- Be brief. Separate: result, evidence, what is left, what needs the owner's approval.
- The Hub folds your running narration ("Checking…") into steps. Only the final message is the answer, so make it
  complete on its own.
- Do not repeat the `<hub-goals>` instructions and never claim results you did not run.

## 5. Working with other agents

With more than one agent, read `agents-hub:team-coordination` before handing work off or picking up a card. The roster
(id, role, strengths, model) is at `<root HERMES_HOME>/agents-hub/TEAM.md`; for a profile, that is the parent of
`profiles/`. The shared team space (team memory `NOTES.md` + `files/`) is `<root HERMES_HOME>/agents-hub/shared/`.
