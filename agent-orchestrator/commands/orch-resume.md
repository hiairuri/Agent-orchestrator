---
description: "Resume interrupted work: continue this session, resume workflow runs, cross-session handover"
argument-hint: "[mission_id]"
---

Resume interrupted work. User argument: "$ARGUMENTS" (a single optional mission_id; empty =
resume all).

Steps:

1. Call `mcp__plugin_agent-orchestrator_orch__resume` (session_id = the current session id,
   pass it when known) to get the briefing.
   - "User argument" non-empty -> process only that mission (id = "$1").
   - "User argument" empty -> process all missions.
2. For each mission, read recommended_action and execute the matching action from this
   table:

|Condition|Action|
|---|---|
|mode=workflow and run stopped|`ResumeWorkflowRun(run_id)`; ask the user first if the user stopped it themselves|
|mode=workflow and run errored|read the error first, fix the script file, then `AmendWorkflow(run_id, path=script file)`; rewriting via CreateWorkflow is forbidden|
|mode=agent and dispatch.session_id=current session and terminal state|`SendMessage(to=agent_id, summary<=200, message=continue instruction)` to resume the conversation|
|cross-session or no agentId|rebuild context with `context_pack` (the board holds original_prompt and the pack path), then re-dispatch with the same role type; agentId is invalid across sessions|
|blocked unanswered|`mailbox(read)` to consume the question -> when uncertain dispatch orch-scout to verify -> `mailbox(answer)` and SendMessage per recommended_call|
|suspected wake failure (wake_failure non-empty)|`mailbox(read)` to take over -> answer/close auto-acks, or `board(action="ack", note="deferred by user")` to defer|
|status=done not closed|aggregate artifacts -> `board(upsert, status=closed)`|
|in-flight work and sentinel not started|`Bash(command="node <plugin root>/hooks/bg-sentinel.mjs --once", run_in_background=true)` to start the sentinel; on a sentinel alert handle per the "suspected wake failure" row; the sentinel may be restarted after handling|
|sentinel_health missing members or abandoned non-empty|replenish (re-issue the same command up to full strength) + take over abandoned unacked items|
|cross-session scene (prev_sessions.tail non-empty)|read the mirror tail digest first to restore the scene; for deep digging use `ReadSessionContext(sessionId="...", strategy="handoff")`|
|candidate lessons (this takeover's done/failed involved pitfalls)|`lessons(list, status="candidate")` -> promote or let gc retire; failed entries get an error-fix reflection|
|ready_unclaimed non-empty|dispatch a pool worker to claim, or dispatch manually|
|skipped|review then close, or revise blockedBy and re-plan|

3. After each item, call `mcp__plugin_agent-orchestrator_orch__board` (action=upsert) to
   update the status, and update dispatch.session_id to the current session id.
4. Report the disposition list to the user: what was resumed, what was skipped, and why.
