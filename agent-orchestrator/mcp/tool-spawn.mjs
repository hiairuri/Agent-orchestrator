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
    label: "执行型",
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", REPORT],
    extraDisallowed: [],
    duties: [
      "## 开工协议",
      "",
      "1. 先 Read 派发 prompt 指向的任务包文件；缺包/读不到 → 立即 report(kind=blocked, question=\"任务包缺失：<路径>\")，不要凭猜开工。",
      "2. 包内 READ FIRST 列出的文件先读；CONTEXT 节是上游产物逐字内容，视作既定事实。",
      "",
      "## 紧急四情形",
      "",
      "验收标准要变 / 继续做已无意义 / 需不可逆操作 / 阻塞超 10 分钟——且主控曾发来消息（RespondToCoordinator 工具出现时）→ 用 RespondToCoordinator 直达主控；否则一律走 report。",
    ].join("\n"),
  },
  scout: {
    color: "blue",
    label: "只读调研型",
    tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", REPORT],
    extraDisallowed: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"],
    duties: [
      "## 调研纪律",
      "",
      "- 结论必须带证据引用（path:line 或原文引用）；不跑命令（需要跑命令的调研请主控改派 worker 变体）。",
      "- 不修改任何文件；中期发现发 report(kind=milestone)，最终报告发 report(kind=done, details=结论全文, artifacts=引用清单或落盘报告路径)。",
    ].join("\n"),
  },
  reviewer: {
    color: "yellow",
    label: "评审型",
    tools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", REPORT],
    extraDisallowed: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
    duties: [
      "## 评审纪律",
      "",
      "- 逐条问题格式：{where, what, evidence, severity(low|medium|high)}；最后给总体 verdict。",
      "- 评审以破坏性缺陷优先：先报会破坏的面与后果（severity≥medium 置顶），风格优劣不单独成条；能跑的确定性检查必须真跑（Bash），没跑的标 unverified。",
      "- 绝不修改文件。",
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
  body.push(`# ${name}（${a.label}子代理）`);
  body.push("");
  body.push(
    `你是 ZCode 主控 agent 派发的${a.label}子代理。工作上下文来自主控派发的任务包；` +
      `上报一律走 ${REPORT} 工具。禁止与其他子代理互调（星型拓扑：只与主控通信）。`,
  );
  body.push("");
  body.push("## 协议（三行契约，出现在派发 prompt 尾块与任务包 CONTRACT 节）");
  body.push("");
  body.push("```");
  body.push("[channel] <mission_id>");
  body.push(`[worker] <worker 名，如 ${name}#1>`);
  body.push("[token] <token>");
  body.push("```");
  body.push("");
  body.push(
    `进度与结果一律用 ${REPORT} 上报；kind ∈ {milestone, blocked, question, done}；` +
      "summary ≤ 200 字；done 必带 artifacts 路径（kind=blocked/question 时 question 必填）。",
  );
  body.push(
    "done 时如有可复用的踩坑/修复经验，可附 lessons（≤3 条，每条 {trigger, fix}），由主控签收时提炼晋升。",
  );
  body.push("");
  body.push("## 上报边界");
  body.push("");
  body.push("超出能力范围 / 目标矛盾 / 必败门禁 → 立即 report(kind=blocked, question=需要主控决策的事项)。");
  body.push("每完成一个可验收单元 → report(kind=milestone)；全部完成 → report(kind=done, artifacts=[产物路径...])。");
  body.push("");
  body.push(a.duties);
  body.push("");
  body.push("## 禁止");
  body.push("");
  body.push(`- Task / Skill / AskUserQuestion；邮箱消费类工具（${MCP_DISALLOWED.join("、")}）。`);
  body.push("- 与其他子代理互调；修改任务包范围外的文件。");
  body.push("");
  body.push("## Return（最终回复格式）");
  body.push("");
  body.push("- 做了什么（3–6 条）");
  body.push("- 产物/输出文件路径");
  body.push("- 遗留问题与建议");
  if (systemPrompt && systemPrompt.trim()) {
    body.push("");
    body.push("## 角色专述");
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
      notes.push(`tools 已自动补上 ${REPORT}（上报通道必须保留）`);
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
  notes.push("项目级 agent 在新会话注册；当前会话请用 Agent(prompt=原型正文+system_prompt) 注入 persona 替代");
  return {
    path: displayPath(target),
    registered_as: name,
    archetype: archetypeKey,
    ...(model ? { model } : {}),
    note: notes.join("；"),
  };
}

export {
  toolSpawnAgent,
};
