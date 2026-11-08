---
description: "View or bind subagent models (one role, one model)"
argument-hint: "[角色名] [providerId/modelId]"
---

Subagent model viewing and binding. User argument: "$ARGUMENTS"
- Word 1 = role name: "$1"
- Word 2 = model id: "$2"

1. Route the argument: words 1 and 2 both empty -> step 2; either non-empty -> step 3.
2. No-argument branch: call `ListModels` to list available models; the two-track selection
   rules are authored solely by section 7 of `skills/agent-orchestrator/SKILL.md` - follow
   its text: the plain Agent track has three tiers (the Agent tool has no model parameter),
   the workflow track has three granularities with priorities; this command keeps no copy.
3. With-argument branch: call `ListModels` to validate word 2 ("$2").
   - Not found or ambiguous -> retry with the full providerId/modelId.
   - `disabledReason` non-empty -> tell the user and switch ids.
4. Output the three binding methods and let the user choose:
   - Role variant: call `mcp__plugin_agent-orchestrator_orch__spawn_agent` (name = word 1
     plus a short-label suffix, description = the original role description or newly written,
     model = word 2; overwrite=true when overwriting an existing variant).
   - Workflow run level: `CreateWorkflow`/`AmendWorkflow` pass subagent_model = word 2;
     settings-only changes = stop the old run and start a new one, only max_concurrency may
     be modified in place.
   - Per-subagent inside a workflow script: `agent(name, { model: "<providerId/modelId>" })`;
     or build a ModelRef table at the top of the script
     `const M = { strong: model("<providerId/modelId>") }` then `agent(name, { model: M.strong })`.
     - Model names must be compile-time literals (with an optional `$reasoningLevel` suffix)
       or ModelRefs returned by `model()`; dynamic name assembly raises diagnostic code 9010.
     - Resolution failure (not_found/ambiguous/disabled) raises 9011.
     - At startup, validated against the host model catalog and approved via the user
       confirmation window.
     - Changes go through `AmendWorkflow(path)` (replaces the old run, completed work is
       imported at zero cost; cached old prompts still return old-model results, only newly
       issued prompts run the new model).
