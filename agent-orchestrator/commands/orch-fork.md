---
description: "Fork one task into multiple parallel variants"
argument-hint: "<N> <任务描述>"
---

Fork parallel variants. User argument: "$ARGUMENTS"
- Word 1 = N (default 3, cap 8): "$1"
- The rest = task description: the remaining text after the first word

Steps:

1. Determine the variant axes variant_axes: if the task description already states the
   dimensions of difference, adopt them directly; if not, derive them along orthogonal
   dimensions (different approaches / different libraries / different styles); if still
   undeterminable, ask the user - do not invent.
2. Call `mcp__plugin_agent-orchestrator_orch__board` (action=upsert) to create the mission:
   title = a summary of the task description, original_prompt = the full task description,
   agent_type = orch-worker or orch-scout per the nature of the task.
3. Call `mcp__plugin_agent-orchestrator_orch__context_pack` (mission_id, title, task,
   variants=N, variant_axes; include upstream_context when upstream context exists) to
   obtain N task packs (receipt `{pack_paths, token, channel}`; prompt_template is no
   longer echoed).
4. In a single message, issue N `Agent` calls: subagent_type = the role chosen in step 2,
   run_in_background=true, prompt = the CONTRACT three lines of the corresponding task pack
   plus a one-line pointer sentence (Read the task pack <pack_path> first).
5. Call `board` (action=upsert) to record each dispatch's dispatch (mode=agent, agent_id,
   task_id, session_id) on the board.
6. Explain the waiting discipline to the user: no polling, no blocking; completion
   notifications are the arrival signal; when all have arrived, consume via `mailbox(read)`,
   compare the results (an orch-reviewer may be dispatched for a consolidated review),
   finally aggregate to disk and close each mission.
