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
  return `[goal] current goal: ${project || "none on record - ask the user for the current goal before starting"}`;
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
        `suspected wake failure: take over the result via mailbox(read, mission_id="${m.id}") -> dispose (answer/close auto-acks)` +
        `or board(action="ack", mission_id="${m.id}", note="deferred by user")`,
    });
  }
  const blockedOpen = m.blocked && m.blocked.answered === false && m.blocked.question;
  if (blockedOpen) {
    out.push({
      priority: 0,
      action:
        `mailbox(read, mission_id="${m.id}") → mailbox(answer) → ` +
        `SendMessage(to=${d.agent_id || "a fresh dispatch"}); cross-session/no agentId -> rebuild with context_pack and re-dispatch`,
    });
  }
  if (unread > 0) {
    out.push({
      priority: 1,
      action: `mailbox(read, mission_id="${m.id}") to consume ${unread} unread event(s)`,
    });
  }
  if (m.status === "done") {
    out.push({
      priority: 1,
      action: `consolidate the artifacts -> board(upsert, mission={id:"${m.id}", status:"closed"})`,
    });
  }
  if (d.mode === "workflow" && d.run_id) {
    const state = m.workflow_state || (m.status === "failed" ? "errored" : "");
    if (state === "stopped") {
      out.push({ priority: 2, action: `ResumeWorkflowRun(run_id="${d.run_id}")` });
    } else if (state === "errored") {
      out.push({
        priority: 2,
        action: `AmendWorkflow(run_id="${d.run_id}", path=<the script file path from GetWorkflowRun>); never rewrite via CreateWorkflow`,
      });
    } else {
      out.push({
        priority: 4,
        action: `GetWorkflowRun(run_id="${d.run_id}") to query status and pendingQuestions`,
      });
    }
  } else if (d.mode === "agent") {
    const terminal = m.status === "done" || m.status === "failed";
    const sameSession = Boolean(d.session_id && sessionId && d.session_id === sessionId);
    if (terminal && sameSession && d.agent_id) {
      out.push({
        priority: 3,
        action: `SendMessage(to="${d.agent_id}", summary=..., message=...) to resume the chat`,
      });
    } else if (terminal) {
      out.push({
        priority: 2,
        action: "cross-session resume: rebuild context via context_pack + re-dispatch the same role type (agentId is invalid across sessions)",
      });
    } else if (sameSession) {
      out.push({
        priority: 5,
        action: d.agent_id
          ? `in flight: wait for the completion notice; if the oldest event is >15 min old, SendMessage(to="${d.agent_id}") to ask for progress`
          : "in flight: wait for the completion notice; if it never arrives, fall back to TaskOutput(task_id) or ListWorkflowRuns",
      });
    } else {
      // In-flight but dispatched from another (or unknown) session: that task
      // died with its session, so rebuild and re-dispatch instead of waiting.
      out.push({
        priority: 2,
        action: "cross-session resume: rebuild context via context_pack + re-dispatch the same role type (agentId/background tasks are invalid across sessions)",
      });
    }
  } else if (m.status === "drafted") {
    out.push({
      priority: 2,
      action: `drafted not yet dispatched: generate the pack via context_pack, dispatch with Agent(run_in_background=true), then record the dispatch via board(upsert)`,
    });
  }
  // v0.4 dependency-graph branches: an unclaimed ready mission is nobody's
  // emergency (pool semantics); skipped is a terminal cascade outcome.
  if (m.status === "ready" && !m.owner) {
    out.push({
      priority: 9,
      action: "wait for a pool claim or dispatch manually: have a pool worker board(action=\"claim\"), or board(upsert status=\"dispatched\") for a normal dispatch",
    });
  }
  if (m.status === "skipped") {
    out.push({
      priority: 2,
      action: `an upstream failure caused the skip: after review board(upsert, mission={id:"${m.id}", status:"closed"}) to archive, or fix blockedBy and reset to drafted for replanning`,
    });
  }
  if (!out.length) out.push({ priority: 9, action: "no action needed" });
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
      `resume: session_id "${sessionId}" hits the sess_subagent prefix (short-lived subagent session, anchor-hijacking shape) - ` +
        "a subagent session must never refresh the wake anchor (zero writes to coord-session.txt/coord-workspace.txt); report back to the coordinator via the report/mailbox channels," +
        "anchors are written only by the coordinator session (sess_<uuid>) via SessionStart/toolResume",
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
      action: `the board has ${readyUnclaimedAll.length} ready unclaimed mission(s): let a pool worker self-claim, or dispatch manually via board(upsert status=dispatched)`,
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
          `sentinel family ${live}/${health.family_size} on duty, ${health.abandoned.length} abandoned mission(s): ` +
          `Bash(command="node ${SENTINEL_SCRIPT_DISPLAY} --once", run_in_background=true) to replenish (repeat the command until fully staffed); ` +
          "take over the abandoned items as suspected wake failures.",
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
    ? "the nearby-session digest is inlined in prev_sessions.tail (context mirror, truncated record); " +
      'restore the previous session by reading the tail first; dig deeper with ReadSessionContext(sessionId="...", strategy="handoff"). ' +
      "never request a full dump." +
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
