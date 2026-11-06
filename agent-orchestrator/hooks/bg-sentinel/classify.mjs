/**
 * bg-sentinel/classify.mjs —— 条件分级判定（C3 > C1 > C2，每 mission 至多一条）
 * + scoping 留痕 + 双空闲门判定 + 告警汇总文案。
 * 自 bg-sentinel.mjs 机械拆分（纯搬运 + import/export 接线，零行为变更）。
 */
import {
  BOARD_BAD_TICKS_LIMIT,
  IN_FLIGHT_STATUSES,
  RESULT_STATUSES,
  SQLITE,
  fmtAge,
  lastActivityMs,
  missionAttributionId,
  resultTimeMs,
  wakeFailureInfo,
} from "./core.mjs";
import { coordBusy, coordSessionId, rolloutHeartbeatMs, toolUsageHasRunning } from "./signals.mjs";
import { appendEcho } from "./echo.mjs";

// v1.2 M9-1 scoping（W9 阶段 a）：归属判定留痕去重（每 mission×category 至多一条回声，
// FIFO 帽防跨代累积）。归因补齐/锚恢复 → owned 时移除键，此后再缺席可重留痕。
const SCOPING_TRACE_CAP = 400;
const scopingTraced = new Map();

/** v1.2 M9-1 scoping 留痕（echo.jsonl 单写方，复用 appendEcho；非开枪——final 恒
 * false、零 fired 零退出零 board 写）。每 mission×category 去重（内存 Map+FIFO 帽），
 * 留痕失败绝不拖垮判定（appendEcho 内部全 catch，此处再兜一层）。 */
export function scopingSkipTrace(rootDir, missionId, category, summary) {
  const key = String(missionId);
  if (scopingTraced.get(key) === category) return;
  if (scopingTraced.size >= SCOPING_TRACE_CAP) {
    const first = scopingTraced.keys().next().value;
    if (first !== undefined) scopingTraced.delete(first);
  }
  scopingTraced.set(key, category);
  try {
    appendEcho(rootDir, [{ key, category, final: false }], summary, {});
  } catch {
    /* 留痕失败不影响主路径 */
  }
}

/* ================================================================== */
/* 条件分类 classify（§4.1：每 mission 至多一条，C3 > C1 > C2）           */
/* ================================================================== */

export function classify(board, boardMtimeMs, cfg, rootDir, signals) {
  const conds = [];
  const missions = Array.isArray(board.missions) ? board.missions : [];
  const isWorkflow = (m) => (m.dispatch && m.dispatch.mode) === "workflow";
  const now = Date.now();
  // v1.2 M9-1 scoping：本哨兵所守会话锚（coord-session.txt），归属等值判定的本侧。
  const ownId = coordSessionId(rootDir, signals);
  for (const m of missions) {
    if (!m || typeof m !== "object") continue;
    if (!IN_FLIGHT_STATUSES.includes(m.status) && !RESULT_STATUSES.includes(m.status)) continue; // ready/drafted/skipped/closed 不产生条件
    if (isWorkflow(m)) continue; // B4：workflow 由宿主通知
    // v1.2 M9-1 scoping 闸（MOD3a-QA 三枪全丢误报靶心）：开枪前判 mission 归属——
    // 有归因（dispatch.session_id / spawned_by_session 任一在）按与本哨兵锚等值判定；
    // 等值不成立（他会话）或无法成立（归因缺席/锚缺失）一律零开枪，转留痕可见
    // （空值三段第 3 段=漏报可见硬约束：scoping-skipped 留痕 + server 组包尾块缺席
    // 计数；fail-open 与纯 fail-closed 均已否决）。本闸每 tick 重判——归因补齐即自动
    // 恢复盯守。不对称原则：误判他会话=静默留痕低害，漏枪由 session-start 回归简报兜住。
    const mid = String(m.id);
    const attr = missionAttributionId(m);
    if (!attr || ownId == null || attr !== ownId) {
      const foreign = Boolean(attr) && ownId != null;
      scopingSkipTrace(
        rootDir,
        mid,
        foreign ? "scoping-foreign" : "scoping-skipped",
        foreign
          ? `scoping-foreign: mission ${mid} belongs to ${attr} != this sentinel anchor - no shots, silently recorded (other-session completion still lands on the board+spool as usual; the session-start brief catches up on return)`
          : !attr
            ? `scoping-skipped: mission ${mid} has no attribution (both dispatch.session_id/spawned_by_session absent) - not watched until backfilled (visible in the pack tail-block absence count; recovers automatically once backfilled)`
            : `scoping-skipped: mission ${mid} attribution ${attr} cannot be compared (this sentinel anchor is missing) - not watched until the anchor is re-published`,
      );
      continue;
    }
    scopingTraced.delete(mid); // 恢复盯守：清留痕去重键（此后再缺席/转他会话可重留痕）
    const agentId = (m.dispatch && m.dispatch.agent_id) || null;
    const inFlight = IN_FLIGHT_STATUSES.includes(m.status);
    const title = String(m.title || "(untitled)").replace(/\s+/g, " ").slice(0, 30);

    // C3 崩溃实锤（仅 agent 模式在飞；绕过双空闲门）
    if (inFlight && agentId) {
      const hb = rolloutHeartbeatMs(signals.rolloutDir, `sess_subagent_agent_${agentId}`);
      if (hb != null) {
        const ageMs = Math.max(0, now - hb); // B7
        const running = SQLITE ? toolUsageHasRunning(signals.toolUsageDb, `sess_subagent_agent_${agentId}`) : null;
        // 佐证无 running 行 → 实锤宽限；有行（可能长工具）或佐证不可用 → 保守档 ×3
        const thresholdMs = running === false ? cfg.crashGraceMs : cfg.crashGraceMs * 3;
        if (ageMs >= thresholdMs) {
          // V6-32 板面龄期反证：lastActivity 与 board mtime 双陈旧（板面全死）时
          // C3 降级 C2 受双空闲门，避免对整块陈旧板面绕门开枪；活板真崩溃照旧绕门。
          // 与 v2.1 待命制正交（待命制管全清、本条管有在飞但全陈旧）。
          let la = lastActivityMs(m);
          if (la == null && Number.isFinite(boardMtimeMs)) la = boardMtimeMs; // 与 C2 同备链
          const laStale = la != null && Math.max(0, now - la) >= Math.max(cfg.stallGraceMs, cfg.crashGraceMs * 3);
          const boardStale = Number.isFinite(boardMtimeMs) && Math.max(0, now - boardMtimeMs) >= cfg.crashGraceMs * 3;
          if (!(laStale && boardStale)) {
            conds.push({
              key: String(m.id),
              category: "crash",
              mission: m,
              title,
              status: m.status,
              anchorMs: hb,
              graceMs: cfg.crashGraceMs,
              ageMs,
              bypassGate: true,
            });
            continue; // 一 mission 一条件（取最严）
          }
          // 反证成立 → 不在此开枪，落下方 C2 inflight_stall（受双空闲门）
        }
      }
      // rollout 缺失/未到期/反证成立 → 本 mission 落 C2（降级链终端，绝不告警"找不到心跳文件"）
    }

    // C1 未签收终态（board 正据，沿用 wakeFailureInfo 口径）
    const wake = wakeFailureInfo(m);
    if (wake.suspected) {
      const isAnswer = m.status === "blocked" || m.status === "question";
      const graceMs = isAnswer ? cfg.answerGraceMs : cfg.wakeGraceMs;
      const t = resultTimeMs(m, boardMtimeMs);
      // B5：null（时间完全不可考）→ 直接到期
      const anchorMs = t == null ? now - graceMs : t;
      conds.push({
        key: String(m.id),
        category: isAnswer ? "unclaimed_answer" : "unclaimed_terminal",
        mission: m,
        title,
        status: m.status,
        anchorMs,
        graceMs,
        resultAt: wake.result_at,
        resultAgeMin: Number.isFinite(anchorMs) ? Math.floor((now - anchorMs) / 60000) : null,
        bypassGate: false,
      });
      continue;
    }

    // C2 在飞失联（仅 agent 模式；池工无 dispatch 的兜底是租约回收）
    if (inFlight && agentId) {
      let la = lastActivityMs(m);
      if (la == null && Number.isFinite(boardMtimeMs)) la = boardMtimeMs; // 备：board mtime
      if (la == null) continue; // 均无 → 不判（不误报）
      conds.push({
        key: String(m.id),
        category: "inflight_stall",
        mission: m,
        title,
        status: m.status,
        anchorMs: la,
        graceMs: cfg.stallGraceMs,
        stallAgeMin: Math.floor(Math.max(0, now - la) / 60000),
        bypassGate: false,
      });
    }
  }
  return conds;
}

export function matured(c) {
  return Math.max(0, Date.now() - c.anchorMs) >= c.graceMs; // B7
}

export function gateOpen(rootDir, c, signals, boardMtimeMs, cfg) {
  if (c.bypassGate) return true; // C3/C0 恒 true
  return !coordBusy(rootDir, signals, boardMtimeMs, cfg.coordIdleMs);
}

export function escaped(c) {
  return Math.max(0, Date.now() - c.anchorMs) >= 2 * c.graceMs; // 无条件开枪的逃逸口
}

/* ================================================================== */
/* 告警汇总（四类文案分组；v0.3.1 骨架沿用 + "疑似崩溃"/"放弃通告" 两段）  */
/* ================================================================== */

export function buildSummary(claims, cfg) {
  let summary = "";
  const rowsOf = (cat) =>
    claims
      .filter((c) => c.category === cat)
      .slice(0, 5)
      .map((c) => `- [${c.key}] ${c.title} | ${c.status}${c.resultAt ? ` | result ${fmtAge(c.resultAgeMin)} ago` : ""} | unclaimed`);

  const terminalRows = [...rowsOf("unclaimed_terminal"), ...rowsOf("unclaimed_answer")];
  if (terminalRows.length) {
    summary +=
      "[orch-sentinel] wake failure alert: the following mission results are on disk but unacked by the coordinator" +
      " (graded grace exceeded: done 5 min / blocked-question 3 min)." +
      " Take over via mailbox(read) immediately and answer/close (auto-acks);" +
      " replenish commands and watch rules per the orchestration manual:\n" +
      terminalRows.join("\n");
  }

  const stallRows = claims
    .filter((c) => c.category === "inflight_stall")
    .slice(0, 5)
    .map(
      (c) =>
        `- [${c.key}] ${c.title} | ${c.status} | no events for ${fmtAge(c.stallAgeMin)} | in flight`,
    );
  if (stallRows.length) {
    summary +=
      (summary ? "\n\n" : "") +
      `[orch-sentinel] in-flight age alert: the following missions have had no events at all` +
      ` (no events for >= stall_grace_min=${Math.round(cfg.stallGraceMs / 60000)} min; any worker report renews it).` +
      " Check via TaskOutput(task_id)/ListWorkflowRuns; if confirmed dead, set the board to failed and re-dispatch:\n" +
      stallRows.join("\n");
  }

  const crashRows = claims
    .filter((c) => c.category === "crash")
    .slice(0, 5)
    .map(
      (c) =>
        `- [${c.key}] ${c.title} | ${c.status} | heartbeat stale ${fmtAge(Math.floor(c.ageMs / 60000))} | in flight`,
    );
  if (crashRows.length) {
    summary +=
      (summary ? "\n\n" : "") +
      `[orch-sentinel] suspected crash alert: the following in-flight missions rollout heartbeats went stale` +
      ` (no API calls for >= ${Math.round(cfg.crashGraceMs / 60000)} min on model-io; x3 conservative tier when tool_usage corroboration is missing),` +
      " the subagent process is suspected dead. Check via TaskOutput(task_id)/ListWorkflowRuns; if confirmed dead, set the board to failed and re-dispatch:\n" +
      crashRows.join("\n");
  }

  const boardRows = claims.filter((c) => c.category === "board_unreadable");
  if (boardRows.length) {
    summary +=
      (summary ? "\n\n" : "") +
      `[orch-sentinel] board unreadable alert: reading board.json failed for ${BOARD_BAD_TICKS_LIMIT} consecutive polls` +
      ` (missing/corrupted). Check the board.json under the storage root; the sentinel cannot watch until it is fixed.`;
  }

  if (claims.some((c) => c.final)) {
    summary +=
      (summary ? "\n\n" : "") +
      `[orch-sentinel] abandon notice: the conditions above have fired ${cfg.cap} shots without disposal; the sentinel stops re-alerting (abandoned; see board list sentinel_health).` +
      " Losing all shots most likely means a platform completion-notice fault - check the notification chain and take over every unacked item as suspected wake failures.";
  }
  return summary;
}
