// agent-orchestrator orch server — tool: board（upsert/ack/get/list/claim/p2p_ask/p2p_answer；机械拆分自 server.mjs L3855-4328）
import path from "node:path";
import {
  hex, nowIso, safeSegment, withRootLock, ToolError, log, STATUSES,
  normalizePathList, DETAILS_MAX_CHARS, depSatisfied,
} from "./server-core.mjs";
import { claimLeaseMinDefault, memoryRoot } from "./server-boot.mjs";
import {
  loadBoard, saveBoard, findMission, upsertMission, sweepGraph, detectCycle,
  missionAck, withComputed, compactMissionRow, ignoredPatchKeys,
  getBoardDegradedFrom, setBoardDegradedFrom,
} from "./server-board.mjs";
import { checkScopeConflicts, checkDuplicateMissions, collectScopeConflicts } from "./server-git.mjs";
import { countUnread } from "./server-stores.mjs";
import { sentinelHealth } from "./server-sentinel.mjs";
import {
  gcP2pFiles, countOpenP2p, loadP2pRecord, saveP2pRecord, appendP2pEcho,
  p2pEchoHead, p2pTokenGate, P2P_TERMINAL_STATUSES, P2P_ASK_PRECONDITION_STATUSES,
} from "./server-p2p.mjs";
import { gleanGateRead, readProjectDigest } from "./server-memory.mjs";
/* ------------------------------------------------------------------ */
/* tool: board                                                         */
/* ------------------------------------------------------------------ */

function toolBoard(args) {
  const action = args.action ?? "list";
  if (action === "upsert") {
    const patchRaw =
      args.mission && typeof args.mission === "object" && !Array.isArray(args.mission)
        ? args.mission
        : null;
    if (!patchRaw) throw new ToolError('board upsert requires "mission" object');
    // ack/owner/claim are read-only: ack is written by the ack action or the
    // auto-ack rules; owner/claim are owned by board claim / report renewal /
    // lease回收 (v0.4). All three are stripped from caller patches. manifest
    // joins them in v0.5 (E4④): a derived pointer whose only legitimate
    // writer is the report close-out.
    // v0.6 (V6-20/V6-11): reopen / note / close_confirmed are TRANSIENT gate
    // keys — consumed by the upsert transition gate, never stored (note is
    // the reopen reason; close_confirmed is the one-shot close confirmation).
    const {
      ack: _ignored,
      owner: _ownerIgnored,
      claim: _claimIgnored,
      manifest: _manifestIgnored,
      reopen: _reopenIn,
      note: _noteIn,
      close_confirmed: _closeConfirmedIn,
      ...patch
    } = patchRaw;
    if (patch.status !== undefined && !STATUSES.includes(patch.status)) {
      throw new ToolError(
        `invalid status: ${JSON.stringify(patch.status)}; allowed: ${STATUSES.join(", ")}`,
      );
    }
    if (
      patch.model !== undefined &&
      patch.model !== null &&
      typeof patch.model !== "string"
    ) {
      throw new ToolError("mission.model must be a string or null");
    }
    if (patch.skippedReason !== undefined && patch.skippedReason !== null) {
      if (typeof patch.skippedReason !== "string") {
        throw new ToolError("mission.skippedReason must be a string or null");
      }
    }
    // v0.5 E4②: scope admission shape gates (invalid-status precedent).
    // scope_paths must be a string array and enters the patch F1-normalized,
    // so storage only ever holds canonical paths. strict_scope must be
    // boolean; absent means false and writes no default key (lazy migration,
    // E4③: newMission stays untouched).
    if (patch.scope_paths !== undefined) {
      if (
        !Array.isArray(patch.scope_paths) ||
        patch.scope_paths.some((p) => typeof p !== "string")
      ) {
        throw new ToolError("mission.scope_paths must be an array of strings");
      }
      patch.scope_paths = normalizePathList(patch.scope_paths);
    }
    if (patch.strict_scope !== undefined && typeof patch.strict_scope !== "boolean") {
      throw new ToolError("mission.strict_scope must be a boolean");
    }
    const result = withRootLock(() => {
      // v0.4 (D3): reject dependency cycles BEFORE touching the board. An empty
      // array is an explicit clear and cannot cycle; a new mission with an
      // auto-generated id cannot reference itself either.
      if (patch.blockedBy !== undefined) {
        if (
          !Array.isArray(patch.blockedBy) ||
          patch.blockedBy.some((d) => typeof d !== "string" || !d.trim())
        ) {
          throw new ToolError("mission.blockedBy must be an array of mission ids");
        }
        if (patch.id != null) {
          const targetId = safeSegment(patch.id, "mission id");
          const cycle = detectCycle(loadBoard(), targetId, patch.blockedBy.map(String));
          if (cycle) {
            throw new ToolError(
              `blockedBy 构成环：<${[targetId, ...cycle].join(" → ")}>；依赖必须是 DAG（board 未改动）`,
            );
          }
        }
      }
      // v0.5 E5 (CR-05): scope conflict preflight — after the cycle gate,
      // before any board write. Default tier collects scope_warnings;
      // strict tier throws inside F3 (reject-before-write, board untouched).
      const liveBoard = loadBoard();
      const scopeWarnings = checkScopeConflicts(liveBoard, patch);
      // v0.10 (§6.1 P9): duplicate-mission preflight — same mechanism family,
      // same transaction point (after the cycle/scope gates, before write).
      // Empty results never surface (conditional-key precedent).
      const duplicateWarnings = checkDuplicateMissions(liveBoard, patch);
      return {
        mission: upsertMission(patch, {
          // v0.6 (V6-20/V6-11): transient gate inputs (see destructure above).
          closeConfirmed: _closeConfirmedIn === true,
          reopen: _reopenIn === true,
          reopenReason: typeof _noteIn === "string" ? _noteIn : "",
        }),
        scopeWarnings,
        duplicateWarnings,
      }; // v0.3.1 A1
    });
    const mission = result.mission;
    // v1.1 W3 (A5-B, DESIGN §4.2): minimal receipt — the coordinator wrote the
    // mission a moment ago, so the whole object echo is zero-gain. id/status
    // drive the next action; warning keys below stay (error-correction data).
    const out = { ok: true, id: mission.id, status: mission.status };
    // v0.5 E5 (§5.4): optional response key — omitted entirely when there is
    // no conflict; independent key, never folded into note/ignored_keys.
    if (result.scopeWarnings.length) out.scope_warnings = result.scopeWarnings;
    // v0.10 P9 (§6.1): optional duplicate_warning key — omitted entirely when
    // no drafted/{dispatched,running} duplicate pair exists (P9-01 后半句).
    if (result.duplicateWarnings.length) {
      out.duplicate_warning = result.duplicateWarnings;
    }
    // v0.4.1 merge whitelist: unknown keys are dropped, not stored.
    const ignoredKeys = ignoredPatchKeys(patch);
    if (ignoredKeys.length) {
      out.ignored_keys = ignoredKeys;
      out.note = `未知字段未入库（schema 白名单）：${ignoredKeys.join(", ")}`;
    }
    // v0.3.1 (C6): closing over an unread mailbox / pending question does not
    // block, but the coordinator must see it.
    if (mission.status === "closed") {
      const unreadLeft = countUnread(mission.id);
      const pendingQ = Boolean(
        mission.blocked && mission.blocked.answered === false && mission.blocked.question,
      );
      if (unreadLeft > 0 || pendingQ) {
        const parts = [];
        if (unreadLeft > 0) parts.push(`仍有 ${unreadLeft} 条未读事件`);
        if (pendingQ) parts.push("存在未答问题");
        out.warn = `关闭时${parts.join("且")}——已按关闭处理（不阻止）；如需处置先 mailbox(read, mission_id="${mission.id}")`;
      }
    }
    return out;
  }
  if (action === "ack") {
    if (args.mission_id == null) throw new ToolError('board ack requires "mission_id"');
    const id = safeSegment(args.mission_id, "mission_id");
    const note = args.note ? String(args.note).slice(0, 200) : null;
    const at = nowIso();
    const mission = withRootLock(() => {
      // v0.3.1 A1: the whole load→mutate→save section holds the root lock.
      const board = loadBoard();
      const m = findMission(board, id);
      if (!m) throw new ToolError(`mission not found: ${id}`);
      m.ack = { at, by: "coordinator", note };
      m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
      m.timeline.push({ at, event: "ack", summary: note || "ack" });
      m.updated_at = at;
      saveBoard(board);
      return m;
    });
    return { ok: true, id: mission.id, status: mission.status };
  }
  if (action === "get") {
    if (args.mission_id == null) throw new ToolError('board get requires "mission_id"');
    const id = safeSegment(args.mission_id, "mission_id");
    // v1.1 W3 (A5-D, DESIGN §4.4): default compact view cuts the archaeological
    // fields (timeline/original_prompt); internal state (claim/dispatch/manifest
    // pointer/wake_failure/ack) stays — get is an explicit named query, and 26
    // audit assertions consume it. view:"full" is the verbatim escape hatch.
    const view = args.view == null ? "compact" : String(args.view);
    if (view !== "compact" && view !== "full") {
      throw new ToolError('board get view must be "compact" or "full"');
    }
    const mission = findMission(loadBoard(), id);
    if (!mission) throw new ToolError(`mission not found: ${id}`);
    const row = withComputed(mission);
    if (view === "compact") {
      delete row.timeline;
      delete row.original_prompt;
    }
    return row;
  }
  if (action === "list") {
    const filter = Array.isArray(args.filter_status) ? args.filter_status.map(String) : null;
    gcP2pFiles(); // lazy TTL sweep keeps the open_p2p count honest (v0.7 V7-02)
    const board = loadBoard();
    let missions = board.missions.slice();
    if (filter) missions = missions.filter((m) => m && filter.includes(m.status));
    else missions = missions.filter((m) => m && m.status !== "closed");
    missions.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    // v1.1 W3 (A5-A): the list face is the compact navigation row (§4.1); the
    // top-level actionable keys below stay untouched. Detail = board get.
    const out = { missions: missions.map(compactMissionRow), sentinel_health: sentinelHealth() };
    // v0.7 (V7-02): open p2p record count rides on list too — the coordinator's
    // one-glance view of pending peer questions (answered/expired/closed excluded).
    out.open_p2p = countOpenP2p();
    // v0.6 (V6-26): a corrupt board was quarantined and rebuilt empty this
    // process — surface it once (conditional key, consumed by this response).
    const degradedFrom = getBoardDegradedFrom();
    if (degradedFrom) {
      out.board_degraded_from = degradedFrom;
      setBoardDegradedFrom(null);
    }
    // v0.5 E7: optional top-level key — the pairwise scope-conflict view over
    // the live layout (G-3 single-source predicate, ≤10 entries); omitted
    // entirely when clean.
    const scopeConflicts = collectScopeConflicts(board);
    if (scopeConflicts.length) out.scope_conflicts = scopeConflicts;
    // M10 (G12, v0.11): the glean due signal rides on list INSIDE the result
    // JSON — the top-level `orch_memory` attachment is dropped by the host
    // (top-level custom keys never reach the coordinator; G12 双实证), while
    // result-content keys do (duplicate_warning precedent, P9 same mechanism
    // position: conditional key, omitted entirely when the gate is not due —
    // zero-byte-diff default, P9-01 后半句). Read-only here: brief_path is the
    // deterministic path, and the brief itself is materialized by the per-call
    // orch_memory attachment of this same tools/call (handleToolsCall runs it
    // after the handler returns), so the file is fresh at response time.
    // Gate logic unchanged (gleanGateRead = gleanAttachment's verbatim read).
    // glean3 (v0.11): pack_path rides the same signal — the FIXED coordinator
    // pack (zero assembly, SKILL §10 MM-29) materialized by the same attachment.
    try {
      const { gate } = gleanGateRead();
      if (gate.due) {
        // v1.1 W3 §3.4 (G4): digest freshness subkey — three-state
        // stale/fresh/missing (read-only; never blocks the due signal).
        const digest = readProjectDigest();
        out.glean_due = {
          idle_h: gate.idleH === Number.POSITIVE_INFINITY ? null : Number(gate.idleH.toFixed(1)),
          events: gate.events,
          brief_path: path.join(memoryRoot, "glean-brief.json"),
          pack_path: path.join(memoryRoot, "glean-pack.md"),
          digest: { status: digest.status, generated_at: digest.generated_at },
        };
      }
    } catch (err) {
      log("glean_due signal failed (non-fatal):", (err && err.message) || String(err));
    }
    return out;
  }
  if (action === "claim") {
    // v0.4 self-claiming (CAS): a pool worker claims a ready/drafted mission.
    // Conditions: owner===null (or missing) && status ∈ {drafted, ready} &&
    // blockedBy all green. Success flips to running + writes the lease. The
    // whole CAS runs inside the root lock, so cross-process races resolve to
    // exactly one winner.
    if (args.mission_id == null) throw new ToolError('board claim requires "mission_id"');
    const id = safeSegment(args.mission_id, "mission_id");
    const worker = String(args.worker ?? "").trim();
    if (!worker) throw new ToolError('board claim requires "worker"');
    let leaseMinutes = claimLeaseMinDefault;
    if (args.lease_minutes != null) {
      const n = Math.floor(Number(args.lease_minutes));
      if (!Number.isFinite(n) || n < 1) throw new ToolError("lease_minutes must be a number >= 1");
      leaseMinutes = n;
    }
    return withRootLock(() => {
      const board = loadBoard();
      sweepGraph(board, nowIso()); // recycle expired leases before the CAS reads state
      const m = findMission(board, id);
      if (!m) throw new ToolError(`mission not found: ${id}`);
      if (m.owner) {
        throw new ToolError(`已被领取（owner=${m.owner}）：不可重复领取`);
      }
      if (m.status !== "drafted" && m.status !== "ready") {
        throw new ToolError(`状态不可领取（status=${m.status}）：仅 drafted/ready 可 claim`);
      }
      const deps = Array.isArray(m.blockedBy) ? m.blockedBy : [];
      const pending = deps.filter((d) => {
        const dm = findMission(board, d);
        return !dm || !depSatisfied(dm); // v0.6 (V6-11): closed 上游须有绿档凭证
      });
      if (pending.length) {
        throw new ToolError(`依赖未就绪：blockedBy 未绿项 ${pending.join(", ")}`);
      }
      const at = nowIso();
      // v0.6 (V6-14, AUTH-04/05): claim ALWAYS re-mints — the reuse branch is
      // gone. The token is a single-generation bearer credential (hex(16),
      // V6-09 entropy): overwriting dispatch.token here revokes the previous
      // holder's token immediately, closing the double-owner replay window
      // after lease recycle + re-claim.
      const token = hex(16);
      const leaseUntil = new Date(Date.parse(at) + leaseMinutes * 60000).toISOString();
      m.owner = worker;
      m.claim = { worker, token, claimedAt: at, leaseUntil };
      m.status = "running";
      m.dispatch = m.dispatch && typeof m.dispatch === "object" ? m.dispatch : {};
      m.dispatch.token = token; // report 校验依赖它；换发即吊销前任（V6-14）
      m.updated_at = at;
      m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
      m.timeline.push({
        at,
        event: "claim",
        summary: `${worker} 领取（租约至 ${leaseUntil}；token 已换发，旧 token 作废）`,
      });
      saveBoard(board);
      return {
        ok: true,
        mission_id: id,
        worker,
        token,
        pack_path: m.pack && m.pack.path ? m.pack.path : null,
        lease_until: leaseUntil,
        task: { title: m.title || "" },
        next_hint:
          "先 Read 任务包按 TASK/RULES 执行；期间每完成一步 report（自动续租）；完成后 report(kind=done)。" +
          "token 以本响应为准（若此前领过本任务，旧 token 已作废）。",
      };
    });
  }
  if (action === "p2p_ask") {
    // v0.7 (V7-02): ask a peer worker a directed question. The asker
    // authenticates with its OWN mission credentials (report-gate mirror); the
    // asker mission must sit in blocked/question (precondition ruling ③). The
    // target must exist, be non-terminal, and — when it has a current holder —
    // the designated to_worker must be that holder, so the ask cannot point at
    // a worker that could never legitimately answer. Target invalid → hard
    // error WITHOUT creating a record: P2P is an optimization channel, the
    // fallback (report(question)) is always available.
    const askerId = safeSegment(args.mission_id, "mission_id");
    const worker = String(args.worker ?? "").trim();
    if (!worker) throw new ToolError('board p2p_ask requires "worker"');
    const toMissionId = safeSegment(args.to_mission_id, "to_mission_id");
    const toWorker = String(args.to_worker ?? "").trim();
    if (!toWorker) throw new ToolError('board p2p_ask requires "to_worker"');
    const rawQuestion = args.question == null ? "" : String(args.question);
    if (!rawQuestion.trim()) throw new ToolError('board p2p_ask requires "question"');
    // v0.6 (V6-18) cap family: storage-side DETAILS_MAX_CHARS, response warn.
    const questionTruncated = rawQuestion.length > DETAILS_MAX_CHARS;
    const question = questionTruncated ? rawQuestion.slice(0, DETAILS_MAX_CHARS) : rawQuestion;
    return withRootLock(() => {
      gcP2pFiles(); // lazy TTL sweep (re-entrant lock)
      const board = loadBoard();
      const asker = findMission(board, askerId);
      if (!asker) throw new ToolError(`mission not found: ${askerId}`);
      const token = args.token == null ? null : String(args.token);
      // Boundary ①: own-mission report-gate auth; the token never leaves this call.
      p2pTokenGate(asker, askerId, worker, token);
      if (!P2P_ASK_PRECONDITION_STATUSES.includes(asker.status)) {
        throw new ToolError(
          `p2p_ask 前置态不满足：${askerId} status=${asker.status}（仅 blocked/question 可问；` +
            `主等待通道 report(blocked|question) 恒可用）`,
        );
      }
      const target = findMission(board, toMissionId);
      if (!target) {
        throw new ToolError(
          `p2p_ask target mission 不存在：${toMissionId}（不建档；降级 = report(question)）`,
        );
      }
      if (target.id === asker.id) {
        throw new ToolError("p2p_ask 不能自问自答（from 与 to 为同一 mission）");
      }
      if (P2P_TERMINAL_STATUSES.includes(target.status)) {
        throw new ToolError(
          `p2p_ask target mission 已终态（${target.status}）：${toMissionId}（不建档；降级 = report(question)）`,
        );
      }
      const holder = target.owner || (target.claim && target.claim.worker) || null;
      if (holder && holder !== toWorker) {
        throw new ToolError(
          `p2p_ask target worker 非该 mission 当前持有者：${toMissionId} holder=${holder}，` +
            `to_worker=${toWorker}（不建档，否则无人能合法应答）`,
        );
      }
      const at = nowIso();
      const p2pId = String(Date.now()).padStart(15, "0") + "-" + hex(4);
      const rec = {
        v: 1,
        id: p2pId,
        from: { mission_id: askerId, worker },
        to: { mission_id: toMissionId, worker: toWorker },
        question,
        status: "open",
        created_at: at,
        answered_at: null,
        answer: null,
        expired_at: null,
        // Echo markers (design sketch named *_event_id; timeline events here are
        // id-less, so the markers are the echo timestamps instead).
        echo: { ask: at, answer: null },
      };
      // Boundary ③: server-forced two-sided echo (truncated head + p2p pointer;
      // the full text stays in the record).
      const qHead = p2pEchoHead(question);
      appendP2pEcho(board, askerId, "p2p:ask", `P2P ask<${p2pId}> → ${toMissionId}/${toWorker}：${qHead}`, at);
      appendP2pEcho(board, toMissionId, "p2p:ask", `P2P ask<${p2pId}> ← ${askerId}/${worker}：${qHead}`, at);
      saveP2pRecord(rec);
      saveBoard(board);
      return {
        ok: true,
        p2p_id: p2pId,
        status: "open",
        created_at: at,
        from: { mission_id: askerId, worker },
        to: { mission_id: toMissionId, worker: toWorker },
        question_truncated: questionTruncated,
        hint:
          "等待对方 p2p_answer 直答（server 双向强制 echo，board get 回放双方 timeline）。" +
          "收到答案后自行消化并经自己的 report 入账——mission 状态演进仍只经 report，租约不因 p2p 续期。",
        next_hint: `对方应答：board(action="p2p_answer", mission_id="${toMissionId}", worker="${toWorker}", token=<对方 token>, p2p_id="${p2pId}", answer=…)`,
      };
    });
  }
  if (action === "p2p_answer") {
    // v0.7 (V7-02): the designated peer answers. The answerer authenticates
    // with its OWN mission credentials and must be the record's to side.
    // Boundary ②: this writes the p2p record + the forced echoes and NOTHING
    // else — the asker's status/fields/lease are zero-touch (only the timeline
    // gains the echo event, written by the server as neutral arbiter).
    const answererId = safeSegment(args.mission_id, "mission_id");
    const worker = String(args.worker ?? "").trim();
    if (!worker) throw new ToolError('board p2p_answer requires "worker"');
    const p2pId = safeSegment(args.p2p_id, "p2p_id");
    const rawAnswer = args.answer == null ? "" : String(args.answer);
    if (!rawAnswer.trim()) throw new ToolError('board p2p_answer requires "answer"');
    const answerTruncated = rawAnswer.length > DETAILS_MAX_CHARS;
    const answer = answerTruncated ? rawAnswer.slice(0, DETAILS_MAX_CHARS) : rawAnswer;
    return withRootLock(() => {
      gcP2pFiles(); // lazy TTL sweep (re-entrant lock)
      const board = loadBoard();
      const answerer = findMission(board, answererId);
      if (!answerer) throw new ToolError(`mission not found: ${answererId}`);
      const token = args.token == null ? null : String(args.token);
      // Boundary ①: own-mission report-gate auth first — no record facts leak
      // to a caller that cannot authenticate.
      p2pTokenGate(answerer, answererId, worker, token);
      const rec = loadP2pRecord(p2pId);
      if (!rec) throw new ToolError(`p2p 记录不存在：${p2pId}`);
      if (rec.status !== "open") {
        throw new ToolError(`p2p 记录非 open（status=${rec.status}）：${p2pId}`);
      }
      if (
        String(rec.to && rec.to.worker) !== worker ||
        String(rec.to && rec.to.mission_id) !== answererId
      ) {
        throw new ToolError(
          `p2p_answer 仅限记录 to 侧（${rec.to && rec.to.mission_id}/${rec.to && rec.to.worker}）：` +
            `调用方 ${answererId}/${worker} 非指定应答者`,
        );
      }
      const at = nowIso();
      rec.status = "answered";
      rec.answered_at = at;
      rec.answer = answer;
      rec.echo.answer = at;
      const aHead = p2pEchoHead(answer);
      appendP2pEcho(
        board,
        rec.to.mission_id,
        "p2p:answer",
        `P2P answer<${p2pId}> → ${rec.from.mission_id}/${rec.from.worker}：${aHead}`,
        at,
      );
      appendP2pEcho(
        board,
        rec.from.mission_id,
        "p2p:answer",
        `P2P answer<${p2pId}> ← ${rec.to.mission_id}/${rec.to.worker}：${aHead}`,
        at,
      );
      saveP2pRecord(rec);
      saveBoard(board);
      return {
        ok: true,
        p2p_id: p2pId,
        status: "answered",
        answered_at: at,
        answer_truncated: answerTruncated,
        hint:
          "双向 echo 已落（board get 回放双方 timeline）；提问方自行消化后经自己的 report 入账，" +
          "其 mission 状态/字段未被本调用触碰（p2p 不续租）。",
      };
    });
  }
  throw new ToolError(
    `unknown board action: ${JSON.stringify(action)} (use upsert|get|list|ack|claim|p2p_ask|p2p_answer)`,
  );
}

export {
  toolBoard,
};
