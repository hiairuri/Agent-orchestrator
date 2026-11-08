// agent-orchestrator orch server — tool: spawn_agent（原型 persona 渲染/落盘；机械拆分自 server.mjs L5207-5412）
import fs from "node:fs";
import path from "node:path";
import {
  PREFIX, REPORT, projectDir, ToolError, truncateStr, assertInside, displayPath,
  atomicWriteFileSync,
} from "./server-core.mjs";
/* ------------------------------------------------------------------ */
/* tool: spawn_agent                                                   */
/* ------------------------------------------------------------------ */

const MCP_DISALLOWED = [
  PREFIX + "mailbox",
  PREFIX + "board",
  PREFIX + "spawn_agent",
  PREFIX + "context_pack",
  PREFIX + "resume",
  PREFIX + "lessons",
  PREFIX + "sandbox_apply",
  PREFIX + "sandbox_discard",
  PREFIX + "agent_harvest",
  // v1.1.1 W20: dispatch is coordinator-only (a worker must never spawn nested
  // sessions); it joins the existing disallowed face, not a new mechanism.
  PREFIX + "dispatch",
  // v1.6 W3b: trajectory (13th tool, v1.6 W-t) is coordinator-only — coordinator-declared
  // stage log writes must never be worker-reachable; joins the same disallowed face
  // (W-t review ISS-1 medium scheduled landing, coordinator supplement authorization).
  PREFIX + "trajectory",
];

const ARCHETYPES = {
  worker: {
    color: "cyan",
    label: "hands-on",
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", REPORT],
    extraDisallowed: [],
    duties: [
      "## Start-of-work protocol",
      "",
      "1. Read the task pack file the dispatch prompt names first; if missing or unreadable -> immediately report(kind=blocked, question=\"task pack missing: <path>\"); never start on guesses.",
      "2. Read the files listed in the pack's READ FIRST first; the CONTEXT section is upstream artifacts verbatim - treat it as established facts.",
      "",
      "## Four emergencies",
      "",
      "Acceptance criteria about to change / continuing is pointless / an irreversible operation is needed / blocked over 10 minutes - and the coordinator has messaged you before (the RespondToCoordinator tool is present) -> reach the coordinator directly with RespondToCoordinator; otherwise everything goes through report.",
    ].join("\n"),
  },
  scout: {
    color: "blue",
    label: "read-only research",
    tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", REPORT],
    extraDisallowed: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"],
    duties: [
      "## Research discipline",
      "",
      "- every conclusion carries an evidence citation (path:line or quotations); run no commands (for research that needs commands, have the coordinator dispatch a worker variant instead).",
      "- modify no files; send report(kind=milestone) for mid-course findings and report(kind=done, details=full conclusions, artifacts=[citation list or written report path]) for the final report.",
    ].join("\n"),
  },
  reviewer: {
    color: "yellow",
    label: "review",
    tools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", REPORT],
    extraDisallowed: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
    duties: [
      "## Review discipline",
      "",
      "- per-item format: {where, what, evidence, severity(low|medium|high)}; end with an overall verdict.",
      "- destructive defects first: report the broken surface and its consequences first (severity >= medium on top); style merits never form standalone items; deterministic checks that can run must actually run (Bash), and anything not run is marked unverified.",
      "- never modify files.",
    ].join("\n"),
  },
};

function escapeYamlDouble(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s*\n\s*/g, " ");
}

function renderPersonaFile({ name, description, archetypeKey, model, maxTurns, tools, disallowed, systemPrompt }) {
  const a = ARCHETYPES[archetypeKey];
  const fm = ["---"];
  fm.push(`name: ${name}`);
  fm.push(`description: "${escapeYamlDouble(description)}"`);
  fm.push(`color: ${a.color}`);
  if (model) fm.push(`model: ${model}`);
  if (Number.isFinite(maxTurns) && maxTurns > 0) fm.push(`maxTurns: ${Math.floor(maxTurns)}`);
  fm.push(`tools: [${tools.join(", ")}]`);
  fm.push(`disallowedTools: [${disallowed.join(", ")}]`);
  fm.push("---");

  const body = [];
  body.push(`# ${name} (${a.label} subagent)`);
  body.push("");
  body.push(
    `You are a ${a.label} subagent dispatched by the ZCode coordinator agent; your working context comes from ` +
      `the coordinator's task pack. Report exclusively via the ${REPORT} tool. Never call other subagents (star topology: talk only to the coordinator).`,
  );
  body.push("");
  body.push("## Contract (three-line contract; appears in the dispatch prompt tail block and the task pack CONTRACT section)");
  body.push("");
  body.push("```");
  body.push("[channel] <mission_id>");
  body.push(`[worker] <worker name, e.g. ${name}#1>`);
  body.push("[token] <token>");
  body.push("```");
  body.push("");
  body.push(
    `Report progress and results exclusively via ${REPORT}; kind in {milestone, blocked, question, done}; ` +
      "summary <= 200 chars; done requires artifact paths (question is required when kind=blocked/question).",
  );
  body.push(
    "On done, reusable pitfall/fix experience may be attached as lessons (up to 3, each {trigger, fix}); the coordinator distills and promotes them on ack.",
  );
  body.push("");
  body.push("## Reporting boundaries");
  body.push("");
  body.push("Beyond your ability / goal contradiction / unwinnable gate -> immediately report(kind=blocked, question=what the coordinator must decide).");
  body.push("At each verifiable unit -> report(kind=milestone); when everything is done -> report(kind=done, artifacts=[artifact paths...]).");
  body.push("");
  body.push(a.duties);
  body.push("");
  body.push("## Forbidden");
  body.push("");
  body.push(`- Task / Skill / AskUserQuestion; mailbox-consumer tools (${MCP_DISALLOWED.join(", ")}).`);
  body.push("- Calling other subagents; modifying files outside the pack's scope.");
  body.push("");
  body.push("## Return (final reply format)");
  body.push("");
  body.push("- What was done (3-6 items)");
  body.push("- Artifact/output file paths");
  body.push("- Leftovers and suggestions");
  if (systemPrompt && systemPrompt.trim()) {
    body.push("");
    body.push("## Role notes");
    body.push("");
    body.push(String(systemPrompt).trim());
  }
  return fm.join("\n") + "\n\n" + body.join("\n") + "\n";
}

function toolSpawnAgent(args) {
  const name = String(args.name ?? "");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new ToolError("spawn_agent name must match ^[a-z0-9][a-z0-9-]{0,63}$");
  }
  const description = String(args.description ?? "").trim();
  if (description.length < 10) {
    throw new ToolError("spawn_agent description must be at least 10 characters");
  }
  const archetypeKey = args.archetype == null ? "worker" : String(args.archetype);
  if (!ARCHETYPES[archetypeKey]) {
    throw new ToolError(
      `unknown archetype: ${JSON.stringify(archetypeKey)}; allowed: ${Object.keys(ARCHETYPES).join(", ")}`,
    );
  }
  // Sanitize: the model string is written verbatim into YAML frontmatter, so
  // newlines or colons could inject arbitrary keys. Reject anything outside the
  // plain-id shape instead of trying to escape it.
  let model = null;
  if (args.model != null && String(args.model).trim() !== "") {
    model = String(args.model).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._$\/-]*$/.test(model)) {
      throw new ToolError(
        `invalid model: ${JSON.stringify(truncateStr(model, 48))}; ` +
          `expected a plain model id like "my-provider/my-model" (optionally with a "$reasoningLevel" suffix, e.g. "GLM-5.3$high"); ` +
          `resolve the exact id via ListModels first`,
      );
    }
  }
  const maxTurns = args.max_turns == null ? null : Number(args.max_turns);

  const notes = [];
  let tools;
  if (Array.isArray(args.tools) && args.tools.length) {
    tools = args.tools.map(String);
    if (!tools.includes(REPORT)) {
      tools.push(REPORT);
      notes.push(`tools auto-appended ${REPORT} (the reporting channel must be kept)`);
    }
  } else {
    tools = ARCHETYPES[archetypeKey].tools.slice();
  }
  const disallowed = [
    "Task",
    "Skill",
    "AskUserQuestion",
    ...MCP_DISALLOWED,
    ...ARCHETYPES[archetypeKey].extraDisallowed,
  ].filter((t) => !tools.includes(t));

  const content = renderPersonaFile({
    name,
    description,
    archetypeKey,
    model,
    maxTurns,
    tools,
    disallowed,
    systemPrompt: args.system_prompt == null ? "" : String(args.system_prompt),
  });
  const target = path.join(projectDir, ".zcode", "agents", `${name}.md`);
  assertInside(projectDir, target);
  if (fs.existsSync(target) && !args.overwrite) {
    throw new ToolError(
      `${displayPath(target)} already exists; pass overwrite=true to replace it`,
    );
  }
  atomicWriteFileSync(target, content, projectDir);
  notes.push("the project-level agent registers in new sessions; for the current session, inject the persona via Agent(prompt=archetype body+system_prompt) instead");
  return {
    path: displayPath(target),
    registered_as: name,
    archetype: archetypeKey,
    ...(model ? { model } : {}),
    note: notes.join("; "),
  };
}

export {
  toolSpawnAgent,
};
