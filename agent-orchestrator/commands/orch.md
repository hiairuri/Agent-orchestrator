---
description: "Mission console: one-screen survey of the board, the mailbox, and workflow pending questions"
argument-hint: "[mission_id]"
---

Console sweep. Output recommendations only - execute nothing until the user picks. User
argument: "$ARGUMENTS" (first word = optional mission_id; empty = all missions).

Steps:

1. Route the argument: non-empty -> call `mcp__plugin_agent-orchestrator_orch__board`
   (action=get, mission_id="$1"); empty -> call board (action=list) for all non-closed
   missions.
2. Call `mcp__plugin_agent-orchestrator_orch__mailbox` (action=peek) for unread events and
   each mission's oldest-event age.
3. For each mission carrying dispatch.run_id: call GetWorkflowRun(run_id=...) for run
   status and pendingQuestions.
4. Print a status table, one row per mission, fixed columns:
   id | status | agent_type/agent_id or run_id | unread | blocked question? | oldest event
   age (min) | unclaimed.
   - A5 view note: board(list) compact rows already strip internal-state fields; never
     read them from list rows.
   - Unclaimed column: for each mission in the table call board (action=get) and read wake_failure
     from the detail (compact keeps internal state; no view:"full" needed):
     non-empty -> `suspected(<status> at <age>, unclaimed)`; empty -> `-`.
5. For each row, match one recommended action from `skills/agent-orchestrator/SKILL.md`
   section 4 (the status->action decision table - the sole authority; this command does
   not restate it); this step outputs advice only, never state changes.
   Command-specific inputs: the unclaimed column reads wake_failure from the board(get)
   detail (compact keeps internal state); sentinel health reads the board(list) top-level
   sentinel_health.
6. After the table, list the numbered recommended actions and wait for the user's choice.
