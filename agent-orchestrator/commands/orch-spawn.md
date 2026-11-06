---
description: "Create a custom subagent role (written into the project agent directory)"
argument-hint: "<名称> <描述> [archetype] [model]"
---

Create a custom subagent role. Parse the "user argument" (split on whitespace; arguments may
be quoted to keep whitespace inside a token):

| Position | Meaning | Value |
|---|---|---|
| Word 1 | name (lowercase letters/digits/hyphens, first character limited to a-z0-9) | "$1" |
| Word 2 | description (>= 10 characters) | "$2" |
| Word 3 | archetype (worker\|scout\|reviewer, default worker) | "$3" |
| Word 4 | model (providerId/modelId, optional) | "$4" |

Steps:

1. Missing arguments -> ask the user for the missing items; do not invent the name or the
   description.
2. Word 4 non-empty -> call `ListModels` to validate the id: not found or ambiguous -> retry
   with the full providerId/modelId; `disabledReason` non-empty -> tell the user to switch
   ids.
3. Call `mcp__plugin_agent-orchestrator_orch__spawn_agent`: `name` = word 1, `description` =
   word 2; pass `archetype` only when word 3 is non-empty, pass `model` only when word 4 is
   non-empty; when a role with the same name already exists and the user confirms overwrite,
   add overwrite=true.
4. Show the user the returned write path and explain the two activation rules:
   - Project-level roles register and take effect in a new session.
   - To use it in the current session immediately -> inject the persona instead via
     `Agent(prompt=prototype body+system_prompt)` (the GP+persona rule: section 8 of
     `skills/agent-orchestrator/SKILL.md`).
