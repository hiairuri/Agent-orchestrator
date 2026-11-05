// agent-orchestrator orch server — tool: resume（推荐动作/唤醒锚写面/哨兵补员建议；机械拆分自 server.mjs L8335-8592）
import fs from "node:fs";
import path from "node:path";
import {
  root, projectDir, T1_HEAD_CAP, SENTINEL_SCRIPT_DISPLAY, ToolError,
  atomicWriteFileSync, nowIso, truncateStr,
} from "./server-core.mjs";
import { loadBoard, missionAck, wakeFailureInfo, t1HeadOf } from "./server-board.mjs";
import { countUnread, listJournalFiles, readJournalRows, readJournalTail } from "./server-stores.mjs";
import { sentinelHealth } from "./server-sentinel.mjs";

/* v1.6 T-B 课题行读面（resume 简报尾部；与 hooks/session-start.mjs questBriefLine 同构副本，
 * 独立命名防 twin 表 site 计数漂移先例）：数据源=<存储根>/context/coord-tail-log.md 末块
 * project 字段——ORT v3 读面已存在零触；短形块缺省字段=不变（PL-10 ①），自末块向前扫至
 * 最近携 project 字段的块。fail-soft：无日志/读失败 → 无课题提示，绝不抛错。 */
function questBriefLine() {
  let project = "";
  try {
    const log = fs.readFileSync(path.join(root, "context", "coord-tail-log.md"), "utf8");
    const blocks = log.split("<!-- orch-tail v3");
    for (let i = blocks.length - 1; i >= 1; i--) {
      const m = blocks[i].match(/^project:[ \t]*(.+)$/m);
      if (m) {
        project = m[1].trim();
        break;
      }
    }
  } catch {
    /* 无日志/读失败 → 无课题 */
  }
  return `当前课题：${project || "无课题——候 OV-10 确认"}`;
}

/* ------------------------------------------------------------------ */
/* tool: resume                                                        */
/* ------------------------------------------------------------------ */

function recommendedAction(m, unread, sessionId) {
  const d = m.dispatch || {};
  const out = [];
  const wake = wakeFailureInfo(m);
  if (wake.suspected) {
    // Must come first: an unclaimed terminal result outranks every other step.
    out.push({
      priority: 0,
      action:
        `疑似唤醒失败：mailbox(read, mission_id="${m.id}") 接手结果 → 处置（answer/close 自动签收）` +
        `或 board(action="ack", mission_id="${m.id}", note="deferred by user")`,
    });
  }
  const blockedOpen = m.blocked && m.blocked.answered === false && m.blocked.question;
  if (blockedOpen) {
    out.push({
      priority: 0,
      action:
        `mailbox(read, mission_id="${m.id}") → mailbox(answer) → ` +
        `SendMessage(to=${d.agent_id || "新派发"})；跨会话/无 agentId 则 context_pack 重建后重派`,
    });
  }
  if (unread > 0) {
    out.push({
      priority: 1,
      action: `mailbox(read, mission_id="${m.id}") 消费 ${unread} 条未读事件`,
    });
  }
  if (m.status === "done") {
    out.push({
      priority: 1,
      action: `聚合产物 → board(upsert, mission={id:"${m.id}", status:"closed"})`,
    });
  }
  if (d.mode === "workflow" && d.run_id) {
    const state = m.workflow_state || (m.status === "failed" ? "errored" : "");
    if (state === "stopped") {
      out.push({ priority: 2, action: `ResumeWorkflowRun(run_id="${d.run_id}")` });
    } else if (state === "errored") {
      out.push({
        priority: 2,
        action: `AmendWorkflow(run_id="${d.run_id}", path=<由 GetWorkflowRun 得到的脚本文件路径>)，勿 CreateWorkflow 重写`,
      });
    } else {
      out.push({
        priority: 4,
        action: `GetWorkflowRun(run_id="${d.run_id}") 查询状态与 pendingQuestions`,
      });
    }
  } else if (d.mode === "agent") {
    const terminal = m.status === "done" || m.status === "failed";
    const sameSession = Boolean(d.session_id && sessionId && d.session_id === sessionId);
    if (terminal && sameSession && d.agent_id) {
      out.push({
        priority: 3,
        action: `SendMessage(to="${d.agent_id}", summary=…, message=…) 恢复续聊`,
      });
    } else if (terminal) {
      out.push({
        priority: 2,
        action: "跨会话恢复：context_pack 重建上下文 + 同类型角色重新派发（agentId 跨会话无效）",
      });
    } else if (sameSession) {
      out.push({
        priority: 5,
        action: d.agent_id
          ? `任务在飞：等完成通知；最老事件 >15 分钟则 SendMessage(to="${d.agent_id}") 询问进度`
          : "任务在飞：等待完成通知；若从未收到，用 TaskOutput(task_id) 或 ListWorkflowRuns 兜底",
      });
    } else {
      // In-flight but dispatched from another (or unknown) session: that task
      // died with its session, so rebuild and re-dispatch instead of waiting.
      out.push({
        priority: 2,
        action: "跨会话恢复：context_pack 重建上下文 + 同类型角色重新派发（agentId/后台任务跨会话无效）",
      });
    }
  } else if (m.status === "drafted") {
    out.push({
      priority: 2,
      action: `drafted 未派发：context_pack 生成任务包后 Agent(run_in_background=true) 派发，再 board(upsert) 记 dispatch`,
    });
  }
  // v0.4 dependency-graph branches: an unclaimed ready mission is nobody's
  // emergency (pool semantics); skipped is a terminal cascade outcome.
  if (m.status === "ready" && !m.owner) {
    out.push({
      priority: 9,
      action: "等待自领取或手动派发（第 13 章）：派池工 board(action=\"claim\")，或 board(upsert status=\"dispatched\") 走普通派发",
    });
  }
  if (m.status === "skipped") {
    out.push({
      priority: 2,
      action: `上游失败被跳过：复核后 board(upsert, mission={id:"${m.id}", status:"closed"}) 归档，或修订 blockedBy 后重置为 drafted 重规划`,
    });
  }
  if (!out.length) out.push({ priority: 9, action: "无需动作" });
  out.sort((a, b) => a.priority - b.priority);
  return { primary: out[0].action, actions: out };
}

function toolResume(args) {
  const sessionId = String(args.session_id ?? "");
  // v1.1 W2 (B1③)：toolResume 的 session_id 是唤醒锚写面（coord-session/coord-workspace）。
  // 子代理会话 id（sess_subagent_agent_<agentId>，EXP10-findings R6 锚劫持形态）调用 resume
  // 会把自己的短寿命会话写成主控唤醒目标 → 前置拒绝（fail-loud，零锚写）。守卫语义与
  // hooks/session-start.mjs G14 publishWakeAnchor 过滤同型（前缀形覆盖未来 sess_subagent_*）；
  // 错误串引导子代理走 report/mailbox 通道。
  if (sessionId.startsWith("sess_subagent")) {
    throw new ToolError(
      `resume: session_id "${sessionId}" 命中 sess_subagent 前缀（子代理短寿命会话，EXP10-findings R6 锚劫持形态）——` +
        "子代理会话不得刷新唤醒锚（零写 coord-session.txt/coord-workspace.txt）；请走 report/mailbox 通道向主控汇报，" +
        "锚只由主控会话（sess_<uuid>）经 SessionStart/toolResume 写入",
    );
  }
  // v0.4.1: publish the coordinator session id for the sentinel family (dual-
  // idle gate main signal + mailbox echo target). resume is the existing channel
  // that carries the caller's session id; best effort, never fatal.
  // v0.10 G4 (anchor trust root): alongside coord-session.txt write the
  // workspace anchor sentinel/coord-workspace.txt, which the watcher feeds to
  // openBridge as workspaceKeyHint. The key is derived from the same storage
  // root's project dir (projectDir = cwd; default root = <projectDir>/.zcode/
  // orchestrator) using the bridge-side rule workspaceIdentity.trim()||
  // workspacePath — the server has no identity face, so the project path is
  // the key. This removes the "first write trusts legacy workspaces[0]" drift
  // hazard (EXP10-findings R3-5 Txn4). Both files are atomic writes; if the
  // anchor write fails the session pointer still stands (best effort).
  if (sessionId) {
    try {
      fs.mkdirSync(path.join(root, "sentinel"), { recursive: true });
      atomicWriteFileSync(path.join(root, "sentinel", "coord-session.txt"), sessionId + "\n");
      atomicWriteFileSync(path.join(root, "sentinel", "coord-workspace.txt"), path.resolve(projectDir) + "\n");
    } catch {
      /* best effort */
    }
  }
  const board = loadBoard();
  const openMissions = board.missions.filter((m) => m && m.status !== "closed");
  const missionsOut = [];
  const actions = [];
  for (const m of openMissions) {
    const unread = countUnread(m.id);
    const rec = recommendedAction(m, unread, sessionId);
    const wake = wakeFailureInfo(m);
    // T6 (v0.5): blocked/question rows present only the ≤160-char question
    // head — the full text stays behind mailbox read (S4 matrix row 3); every
    // other row keeps the existing blocked shape untouched.
    const isQuestionRow = m.status === "blocked" || m.status === "question";
    const row = {
      id: m.id,
      title: m.title || "",
      status: m.status,
      agent_type: m.agent_type || "",
      model: m.model ?? null,
      mode: (m.dispatch && m.dispatch.mode) || null,
      agent_id: (m.dispatch && m.dispatch.agent_id) || null,
      run_id: (m.dispatch && m.dispatch.run_id) || null,
      session_id: (m.dispatch && m.dispatch.session_id) || null,
      unread,
      ack: missionAck(m),
      wake_failure: wake.suspected ? { result_at: wake.result_at, minutes: wake.minutes } : null,
      blocked: m.blocked
        ? {
            ...(isQuestionRow
              ? { question_head: truncateStr(String(m.blocked.question ?? ""), T1_HEAD_CAP) }
              : { question: m.blocked.question ?? null }),
            answered: m.blocked.answered === true,
            answer: m.blocked.answer ?? null,
          }
        : null,
      updated_at: m.updated_at || null,
      recommended_action: rec.primary,
    };
    // T6 (v0.5): done/failed rows still awaiting ack carry t1_head (already
    // acked rows do not — the coordinator has seen them). Optional key only;
    // no cap is added to the resume response.
    if ((m.status === "done" || m.status === "failed") && !missionAck(m)) {
      row.t1_head = t1HeadOf(m);
    }
    missionsOut.push(row);
    for (const a of rec.actions) actions.push({ mission_id: m.id, priority: a.priority, action: a.action });
  }
  // v0.4: pool missions waiting for a claim are surfaced here (not in the Stop
  // checklist / sentinel — ready is deliberately outside their open sets).
  const readyUnclaimedAll = openMissions.filter((m) => m.status === "ready" && !m.owner);
  if (readyUnclaimedAll.length) {
    actions.push({
      mission_id: null,
      priority: 2,
      action: `任务板有 ${readyUnclaimedAll.length} 项 ready 待领取：派池工自领取（第 13 章）或手动 board(upsert status=dispatched) 走普通派发`,
    });
  }
  // v0.4.1: sentinel family understaffed or an abandoned condition → refill /
  // takeover suggestion (priority 2, board-driven, no sentinel files written).
  const health = sentinelHealth();
  if (health.available) {
    const live = health.instances.filter((i) => i.on_duty).length;
    const understaffed = live < health.family_size;
    if ((understaffed || health.abandoned.length) && openMissions.some((m) => m.status !== "ready")) {
      actions.push({
        mission_id: null,
        priority: 2,
        action:
          `哨兵家族 ${live}/${health.family_size} 在岗、abandoned ${health.abandoned.length} 项：` +
          `Bash(command="node ${SENTINEL_SCRIPT_DISPLAY} --once", run_in_background=true) 补员（同命令连发至满编）；` +
          "abandoned 项按疑似唤醒失败接手。",
      });
    }
  }
  actions.sort((a, b) => a.priority - b.priority);

  // v0.3: recent-session context from the mirror journal (read-only tails).
  const prevSessions = listJournalFiles()
    .filter((f) => !sessionId || f.session_id !== sessionId)
    .slice(0, 3)
    .map((f) => {
      const rows = readJournalRows(f.file);
      return {
        session_id: f.session_id,
        entries: rows.length,
        last_at: rows.length && typeof rows[rows.length - 1].ts === "string" ? rows[rows.length - 1].ts : null,
        tail: readJournalTail(f.file, 5),
      };
    });
  // v1.6 T-B 课题行（主控补发件 tb-script-supplement.md §三2）：resume 简报尾部追加课题行——
  //   与 session-start 同数据源同格式（轨迹文件末块 project 字段；无课题=「无课题——候 OV-10 确认」）。
  //   research §5 候选 2 形制：contextHint 文案追加、条件性保持（prev_sessions 缺席则无尾句，
  //   课题确认由 SessionStart 简报课题行/OV-10 承载）；零新读面（仅读既有 ORT v3 格式）。
  const questHint = questBriefLine();
  const contextHint = prevSessions.length
    ? "附近现场摘要已内联在 prev_sessions.tail（上下文镜像，截断记录）；" +
      '要还原上一会话现场先读 tail，深挖再平台 ReadSessionContext(sessionId="…", strategy="handoff")。' +
      "不要要求全量转储。" +
      questHint
    : null;

  return {
    generated_at: nowIso(),
    session_id: sessionId || null,
    missions: missionsOut,
    // v0.3.1 (C4): same counting basis as the Stop hook — only open (non-closed)
    // missions count, so a closed mission's leftover events no longer inflate.
    unread_total: openMissions.reduce((n, m) => n + countUnread(m.id), 0),
    actions_top3: actions.slice(0, 3),
    // v0.4.1: full pool exposed so priority-2 suggestions (sentinel refill /
    // abandoned takeover) remain visible when higher-priority actions crowd top3.
    actions,
    // v0.4: ready missions with no owner (≤8 listed), count first.
    ready_unclaimed: readyUnclaimedAll.slice(0, 8).map((m) => ({
      id: m.id,
      title: m.title || "",
      blocked_by: Array.isArray(m.blockedBy) ? m.blockedBy : [],
    })),
    ready_unclaimed_count: readyUnclaimedAll.length,
    prev_sessions: prevSessions,
    context_hint: contextHint,
  };
}

export {
  toolResume,
};
