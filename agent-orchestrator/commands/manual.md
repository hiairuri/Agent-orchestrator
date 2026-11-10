---
name: manual
description: "Force the coordinator to fully read and follow the coordination manual (SKILL.md)"
---

Manual enforcement order. This command takes no arguments; the instructions below are
addressed to you (the coordinator), no negotiation, execute in order.

## 1. Iron rules at a glance (inline hard rules, effective with this command immediately)

Even if you skip the full read in step 2, the following 12 iron rules have already entered
your context with this command, in effect now:

| # | Iron rule | Source |
|---|---|---|
| 1 | Dispatch = three calls: `board upsert -> context_pack -> dispatch(mission_id)`, zero prompt assembly | Ch. 2 DP-3 |
| 2 | The task pack is the worker's only world: every instruction to the worker and every coordinator ruling goes into the pack via context_pack (rulings verbatim in the EXTRA section); the sole authority for the three-line contract = the pack's CONTRACT section | Ch. 2 DP-2, Ch. 3 |
| 3 | The only regular reporting channel for workers = the report tool (kind ∈ milestone/blocked/question/done; blocked/question must carry question, done must carry artifacts); the four urgent cases go straight to the coordinator via RespondToCoordinator; the coordinator receives via mailbox, ack = signed receipt | Ch. 5 CL-2/CL-3/CL-5, Ch. 14 TS-12 |
| 4 | Worker-type missions must register scope_paths before dispatch; out-of-scope writes are auditable | Ch. 8 RP-12 |
| 5 | Headless subagents = --mode yolo, all permissions, no interaction gate: pass the yolo gate before dispatch; high-risk write tasks go through the sandbox | Ch. 8 RP-12, Ch. 12 |
| 6 | grill#3 design confirmation defaults to ON; exemption requires an explicit statement "grill#3 skipped: <reason>", never a silent skip | Ch. 16 PL-6 |
| 7 | Aggregate results into files, bring only summaries into context; read-back and replay are the main cost battlefields | Ch. 2 DP-9, Ch. 15 CS-1 |
| 8 | SKILL is the sole authority for prompts and process; agents/*.md and commands/*.md keep only role specifics and command entries - all rules point to SKILL sections | Ch. 1 OV-3 |
| 9 | The coordinator does not read or write project files (hard rule): reading = dispatch a subagent to distill and return a summary with pointers, writing = dispatch an orch-worker; the coordinator writes only replies to the user / ruling text / grill questions / release records; violation = process defect, dispatch the fix first, then continue | Ch. 1 OV-4 |
| 10 | Tail-block contract: at the end of every dispatch round, the last assistant message carries the PL-10 tail block (full form on change rounds / short form on steady rounds); no tail block = the next dispatched subagent loses state | Ch. 1 OV-5, Ch. 16 PL-10 |
| 11 | Three pair loops as the default form: planning<->planning-QA / plan<->plan-QA / execution<->release-QA paired loops polished to the final version; QA opinions go to files handed to the counterpart, the coordinator only forwards pointers; between loops the grill gate defaults to ON + exemptions stated explicitly | Ch. 1 OV-6, Ch. 17 |
| 12 | No hot edits on the running face (hard rule): any loaded/running tree (plugin runtime, bot-loaded face, every live face) is never hot-edited - changes go through a worktree sandbox, merge after release-QA sign-off; unsigned iterations must not commit / switch branches / write files onto the running face; emergency fixes also go through sandbox fast-forward, never in-place hot patches | Ch. 1 OV-7, Ch. 12 SB-8 |

## 2. Blocking triple-file full read (the only action step of this command, blocking)

Immediately read three files in full: (1) `skills/agent-orchestrator/SKILL.md` in its entirety
(if not at the plugin root, locate the plugin root first); (2) `<storage root>/ORCH.md` in
its entirety (coordinator memory, the full content within the cap - since v1.6 the server
no longer pushes ORCH.md, so this step is the memory-load moment; a missing ORCH.md = empty
memory, continue as usual); (3) project-root `GOAL.md` in its entirety (the quest stack:
one entry per active/queued quest) - CONDITIONAL: present -> read it as the quest stack
before starting work; absent -> emit the one-line note
"GOAL.md absent - no quest stack on record" and continue (the plugin is generic; most
projects have no GOAL.md).
No excerpts, no skimming, no substituting memory for the text, no substituting a summary
for the original.
During this step, besides Read on SKILL.md, ORCH.md, and GOAL.md (when present), call no other tool,
do not continue the previous task, do not output any conclusion first - until the read
completes and passes the step-3 confirmation, all other work is blocked.

## 3. Provable reading confirmation (after the read, output three items in order; any missing item = not read)

1. Recap line: "Manual read: X chapters, Y rules in effect" (X = actual SKILL chapter count,
   Y = number of rules confirmed as followed; write the actual numbers).
2. Verbatim quote: copy one full hard-rule line from the SKILL original verbatim and state
   its chapter number - reciting from memory, paraphrasing, or summarizing does not count
   as a quote.
3. Fixed last line: "During this task SKILL is the task law; deviations will first be
   report(blocked) for a ruling."
   (The coordinator has no report tool: the way to honor that promise = on deviation, first
   ask the user explicitly and wait for a ruling; report(blocked) is the worker-side channel.
   Not declaring, not waiting for a ruling, or improvising a workaround lets the user hold
   you accountable via the traces of this step.)

Do not resume the previous task until all three items are complete; after all three are
complete, return to the task that was interrupted.

## 4. Constraints (from this command onward, in effect for the entire task)

- For the duration of this task, SKILL is the task law: when it conflicts with your past
  habits, memory, or any other source, SKILL prevails, always.
- Any deviation: stop first, state the clause deviated from, the reason, and the impact
  explicitly to the user, and do not continue before the user rules.
- Silent deviation = task failure: not declaring, not waiting for a ruling, or improvising
  a workaround counts as task failure, all of it.

## When to use

- The coordinator enters this project for the first time and orchestration discipline is
  not yet established.
- The coordinator is found violating orchestration discipline (skipping the seven dispatch
  steps, silent deviation, pack materialization missing rulings).
- The user manually corrects course: explicitly asks the coordinator to return to the
  manual track.
