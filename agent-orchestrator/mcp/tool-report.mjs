// agent-orchestrator orch server — wake-queue 生产者 + tool: report（机械拆分自 server.mjs L4330-4873）
import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  root, projectDir, hex, nowIso, safeSegment, withRootLock, ToolError,
  truncateStr, escapeDataLine, normalizePathList, displayPath, KINDS,
  DETAILS_MAX_CHARS, atomicWriteFileSync,
} from "./server-core.mjs";
import { strictTokens, claimLeaseMinDefault } from "./server-boot.mjs";
import { loadBoard, findMission, upsertMission } from "./server-board.mjs";
import { checkScopeAudit } from "./server-git.mjs";
import {
  loadLessons, saveLessons, newLessonId, LESSON_TYPES, RETIRE_SCORE,
  housekeepLessons,
} from "./server-lessons.mjs";
import { unreadDirOf } from "./server-stores.mjs";
import { closeOutManifest } from "./server-manifest.mjs";
/* ------------------------------------------------------------------ */
/* wake-queue（v1.1.1 W-B：完成即唤队列；hooks/dispatch-runner.mjs 同文  */
/* twin，零共享依赖纪律——跨进程文件协议沿 G14/root-contract 先例）      */
/* ------------------------------------------------------------------ */

function wakeQueueDirOf(resultDirPath) {
  return path.join(path.dirname(path.resolve(resultDirPath)), "wake-queue");
}

function wakeQueueProduce(opts) {
  const queueDir = opts.queueDir;
  fs.mkdirSync(queueDir, { recursive: true });
  try {
    fs.writeFileSync(
      path.join(queueDir, `${Date.now()}-${opts.missionId}.json`),
      JSON.stringify(
        {
          mission_id: opts.missionId,
          worker: opts.worker ?? null,
          session_id: opts.sessionId ?? null,
          result_path: opts.resultPath ?? null,
          // Q3b 死信摘要（v1.2 M3-1）：runner 出口传真值（result|error|timeout）；
          // server 生产者①（report done）不传 → null（加字段向后兼容，drain 消费面不改语义）。
          outcome: opts.outcome ?? null,
          timed_out: opts.timedOut ?? null,
          exit_code: opts.exitCode ?? null,
          created_at: new Date().toISOString(),
          source: opts.source,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  } catch (err) {
    if (err && err.code === "EEXIST") return false; // 他人已记（同毫秒同 mission），该方认领
    throw err;
  }
  let acquired = false;
  try {
    fs.writeFileSync(
      path.join(queueDir, "claim.json"),
      JSON.stringify({ acquired_at: new Date().toISOString(), source: opts.source }, null, 2) + "\n",
      { flag: "wx" },
    );
    acquired = true;
  } catch {
    acquired = false; // EEXIST=他者刚认领（静默，他者负责）或其他失败（保守不 spawn）
  }
  if (!acquired) return true;
  try {
    const kick = child_process.spawn(
      process.execPath,
      [opts.kickPath, "--root", path.dirname(path.dirname(queueDir))],
      { detached: true, stdio: "ignore", windowsHide: true, cwd: opts.cwdDir },
    );
    kick.on("error", () => {});
    kick.unref();
  } catch {
    /* spawn 构造失败罕见：finally 仍释放认领，事件留队待下一触发点 */
  } finally {
    try {
      fs.unlinkSync(path.join(queueDir, "claim.json"));
    } catch {
      /* 残留带 acquired_at 可识别，WB 波超龄回收 */
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* tool: report                                                        */
/* ------------------------------------------------------------------ */

function toolReport(args) {
  const missionId = safeSegment(args.mission_id, "mission_id");
  const worker = String(args.worker ?? "").trim();
  if (!worker) throw new ToolError('report requires "worker"');
  const kind = args.kind;
  if (!KINDS.includes(kind)) {
    throw new ToolError(`invalid kind: ${JSON.stringify(kind)}; allowed: ${KINDS.join(", ")}`);
  }
  let summary = String(args.summary ?? "");
  let truncatedNote = null;
  if (summary.length > 200) {
    summary = summary.slice(0, 200);
    truncatedNote = "summary exceeded 200 characters and was truncated";
  }
  if (!summary.trim()) throw new ToolError('report requires "summary"');
  const question = args.question == null ? null : String(args.question);
  if ((kind === "blocked" || kind === "question") && !(question && question.trim())) {
    throw new ToolError(`report kind=${kind} requires "question"`);
  }
  // v0.5 E8②: files_touched envelope field — array guard + per-item String +
  // F1 normalization (same family as artifacts). Every kind stores it in the
  // spool event verbatim (evidence); only milestone/done additionally feed
  // the scope audit (G-7: evidence is never dropped, only the audit skips).
  const filesTouched = normalizePathList(args.files_touched);

  // v0.6 (V6-18): storage-side details cap — the spool event is truncated to
  // DETAILS_MAX_CHARS (§2.7 single source) and the response carries a
  // truncation warn (INJ-04). Long payloads belong in files via artifacts.
  const rawDetails = args.details == null ? "" : String(args.details);
  const detailsTruncated = rawDetails.length > DETAILS_MAX_CHARS;
  const details = detailsTruncated ? rawDetails.slice(0, DETAILS_MAX_CHARS) : rawDetails;

  // v0.3.1 (A1): spool write + board update + lessons append are one critical
  // section under the root lock.
  const outcome = withRootLock(() => {
    const board = loadBoard();
    const mission = findMission(board, missionId);
    if (!mission) throw new ToolError(`mission not found: ${missionId}`);
    const token = args.token == null ? null : String(args.token);
    const expectedToken =
      mission.dispatch && mission.dispatch.token ? String(mission.dispatch.token) : null;
    // v0.6 (V6-09, AUTH-01): fail-closed token gate. The old `token &&`
    // short-circuit let missing/empty tokens through whenever the mission
    // carried one. Now: expectedToken present -> the report MUST carry it and
    // it must match exactly (missing / empty / wrong all reject). Missions
    // without dispatch.token (manual dispatch) keep the v0.5.1 behavior
    // (AUTH-03 baseline); --strict-tokens (V6-19A) can close that face too.
    if (expectedToken != null) {
      if (token == null || token === "") {
        throw new ToolError(
          `report missing token for mission ${missionId}: refusing to record ` +
            `(this mission already carries a dispatch token; the report must carry it; check the [token] line in the pack CONTRACT section)`,
        );
      }
      if (token !== expectedToken) {
        throw new ToolError(
          `report token mismatch for mission ${missionId}: refusing to record ` +
            `(check the [token] line in the pack CONTRACT section)`,
        );
      }
    } else if (strictTokens) {
      // v0.6 (V6-19A, AUTH-07): strict mode closes the no-token face as well.
      throw new ToolError(
        `report rejected for mission ${missionId}: reports without a dispatch token are not accepted in --strict-tokens mode ` +
          `(mint the token via context_pack first, then dispatch)`,
      );
    }

    const at = nowIso();
    const eventId = String(Date.now()).padStart(15, "0") + "-" + hex(4);
    const event = {
      v: 1,
      id: eventId,
      at,
      mission_id: missionId,
      worker,
      agent_id: (mission.dispatch && mission.dispatch.agent_id) || null,
      token,
      kind,
      summary,
      details,
      artifacts: Array.isArray(args.artifacts) ? args.artifacts.map(String) : [],
      files_touched: filesTouched,
      question,
      urgent: Boolean(args.urgent),
    };
    const spoolPath = path.join(unreadDirOf(missionId), `${eventId}.json`);
    atomicWriteFileSync(spoolPath, JSON.stringify(event, null, 2) + "\n");

    // v0.3.1 (C5): a closed mission rejects board-changing reports. The event
    // stays in the mailbox (already written); the board is left untouched.
    if (mission.status === "closed") {
      return {
        closed: true,
        eventId,
        spoolPath,
        status: mission.status,
        note: "mission already closed: the event went to the mailbox archive, board untouched (closed rejects board-changing reports)",
        lessonsRecorded: 0,
        lessonsNote: "mission already closed; attached lessons not recorded",
        expectedToken,
        token,
      };
    }

    // v0.6 (V6-09 改动三 + V6-17, AUTH-06): paired auth — board write rights
    // = token match (gate above) AND the reporting worker being the claim
    // holder. The worker name is a caller-supplied string; the token is the
    // credential. A name mismatch means the report only lands in the mailbox
    // (audit evidence preserved, per W-A1 方案 (a) rationale) while the board
    // — status, timeline, lessons and above all the LEASE — stays untouched:
    // a stranger must not renew (flip into a double owner) or flip statuses.
    const claimHolder =
      mission.claim && typeof mission.claim === "object" && mission.claim.worker != null
        ? String(mission.claim.worker)
        : null;
    if (claimHolder !== null && claimHolder !== worker) {
      return {
        foreignClaim: true,
        eventId,
        spoolPath,
        status: mission.status,
        claimHolder,
        claimWarn: `this mission lease belongs to ${claimHolder}; confirm you claimed this one`,
        note: `this mission lease belongs to ${claimHolder}: the event went to the mailbox archive, board untouched (pairwise auth failed: no lease renewal, no board change)`,
        lessonsRecorded: 0,
        lessonsNote: "pairwise auth failed; attached lessons not recorded",
        expectedToken,
        token,
      };
    }

    const patch = { id: missionId };
    if (kind === "done") patch.status = "done";
    if (kind === "blocked" || kind === "question") {
      patch.status = kind;
      // v0.3.1 (C1): reset the whole blocked sub-object — a stale answered=true
      // must not whitewash a fresh question.
      patch.blocked = { question, asked_at: at, answered: false, answer: null, answered_at: null };
    }
    patch.timeline = [
      ...(Array.isArray(mission.timeline) ? mission.timeline : []),
      { at, event: `report:${kind}`, summary },
    ];
    // v0.5 E8③④ (G-7): the files_touched audit runs for milestone/done
    // only — blocked/question keep the event as stored evidence but skip the
    // audit (the closed branch above likewise returns before this point, so
    // its board stays untouched). The baseline is the registration present
    // BEFORE this report (mission.scope_paths); violations land two ways:
    // a scope_violation audit event on the timeline (summary lists the
    // out-of-scope paths verbatim) and mission.scope_violations rewritten
    // wholesale (G-5: recompute-and-replace via the merge whitelist). The
    // field is only touched when there is something to write or prior
    // findings to clear, so clean missions carry no scope_violations key.
    // Advisory only — never an isError, the audit faces the coordinator.
    const scopeViolations =
      kind === "milestone" || kind === "done" ? checkScopeAudit(mission, filesTouched) : [];
    if (scopeViolations.length) {
      patch.scope_violations = scopeViolations;
      patch.timeline.push({
        at,
        event: "scope_violation",
        summary: `out-of-scope: ${scopeViolations.join("; ")}`,
      });
    } else if (
      Array.isArray(mission.scope_violations) &&
      mission.scope_violations.length &&
      (kind === "milestone" || kind === "done")
    ) {
      patch.scope_violations = []; // wholesale recompute: clean sweep clears old findings
    }
    // v0.5 T2: manifest close-out pipeline — done only (milestone never
    // writes a manifest; a condensation worker's done walks the same
    // pipeline), inside this same root-lock critical section. The pointer
    // rides the same board patch (manifest is merge-whitelisted, whole
    // replacement); the sidecar write is atomic and precedes the board
    // update. Response keys manifest_note/manifest_warnings are conditional
    // (omitted when empty).
    let manifestNote = null;
    let manifestWarnings = null;
    if (kind === "done") {
      // v0.5 QA fix: report artifacts are board material, not just mailbox
      // evidence. Without this write-back a `report(done, artifacts=[…])`
      // carrying zero manifest_entries left mission.artifacts empty, so the
      // T2 auto-stub found no outputs and downstream inputs pull mis-classed
      // the mission as L3 (zero-output). Append-only merge: prior entries stay
      // verbatim (string or {path,note}), report paths dedupe in; the patch
      // rides the existing whole-replacement artifacts whitelist row.
      const prevArts = Array.isArray(mission.artifacts) ? mission.artifacts : [];
      const reported = Array.isArray(args.artifacts)
        ? args.artifacts.map((p) => String(p ?? "").trim()).filter(Boolean)
        : [];
      const seenArts = new Set(
        prevArts.map((a) => (a && typeof a === "object" ? String(a.path ?? JSON.stringify(a)) : String(a))),
      );
      const freshArts = reported.filter((p) => !seenArts.has(p));
      const mergedMission = freshArts.length ? { ...mission, artifacts: [...prevArts, ...freshArts] } : mission;
      if (freshArts.length) patch.artifacts = mergedMission.artifacts;
      const mr = closeOutManifest(mergedMission, args.manifest_entries, at);
      if (mr.pointer) patch.manifest = mr.pointer;
      if (mr.note) manifestNote = mr.note;
      if (mr.warnings && mr.warnings.length) manifestWarnings = mr.warnings;
    }
    // v0.4: any report from the (lease-holding) worker renews the claim lease
    // in the same critical section.
    // v0.6 (V6-17, AUTH-06): renewal is PAIRED — only claim.worker === worker
    // renews. Named-holder mismatches were already archived board-untouched by
    // the foreign branch above; the explicit pair check remains the single
    // renewal gate (defense in depth, and covers the unnamed-holder edge).
    let claimWarn = null;
    const renewOpts = {};
    if (
      mission.claim &&
      typeof mission.claim === "object" &&
      mission.claim.worker === worker
    ) {
      renewOpts.renewClaim = {
        leaseUntil: new Date(Date.parse(at) + claimLeaseMinDefault * 60000).toISOString(),
      };
    } else if (mission.claim && typeof mission.claim === "object") {
      claimWarn = `this mission lease belongs to ${mission.claim.worker}; confirm you claimed this one`;
    }
    const updated = upsertMission(
      patch,
      // v0.6 (V6-20): report is a whitelisted internal writer (done/blocked/
      // question legs) — it bypasses the external transition table. The
      // drafted 直收 done warn below stays (W-A1 keeps it).
      {
        internal: true,
        ...(kind === "blocked" || kind === "question" ? { clearAck: true, ...renewOpts } : renewOpts),
      },
    );

    // v1.1.1 W-B（生产者①）：headless done → 完成即唤队列事件 + 认领 kick（grill#wake
    // Q1/Q3 裁定：闸=mission.dispatch.mode==="headless"（dispatch 时 server 自己写的，
    // 零新字段；stop-check :627 同款消费先例）。队列写在 withRootLock 内但轻（同步单小
    // 文件，与 spool 落盘 :4420 同型）；认领+detached spawn 同为毫秒级（dispatch 出货
    // 先例 :6669 非阻塞构造性质）。整段 best-effort：任何失败只 stderr 一行，绝不阻塞
    // report 主流程。执行器本体=wake-kick 桩（消费逻辑 WB 波落地）。
    if (kind === "done" && mission.dispatch && mission.dispatch.mode === "headless") {
      try {
        wakeQueueProduce({
          queueDir: path.join(root, "context", "wake-queue"),
          kickPath: path.join(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
            "hooks",
            "wake-kick.mjs",
          ),
          cwdDir: projectDir,
          source: "server",
          missionId,
          worker,
          sessionId: (mission.dispatch && mission.dispatch.session_id) || null,
          resultPath: null,
        });
      } catch (err) {
        try {
          process.stderr.write("[agent-orchestrator] wake-queue: " + (err && err.message ? err.message : err) + "\n");
        } catch {
          /* stderr 不可写也不阻塞 */
        }
      }
    }

    // v0.4: surface claimable work to pool workers (n>0 only).
    const readyToClaim = loadBoard().missions.filter(
      (x) => x && x.status === "ready" && !x.owner,
    ).length;

    // v0.3.1 (C5): a done report straight out of "drafted" is allowed but odd
    // enough to flag.
    const draftedWarn =
      mission.status === "drafted" && kind === "done"
        ? "done received while still drafted (no dispatch record seen before) - the coordinator should verify the dispatch chain"
        : null;

    // lessons candidates: kind=done only; cap 3; entries missing trigger/fix skipped.
    let lessonsRecorded = 0;
    let lessonsNote = null;
    if (kind === "done" && Array.isArray(args.lessons) && args.lessons.length) {
      if (args.lessons.length > 3) lessonsNote = "more than 3 lessons; only the first 3 recorded";
      const list = loadLessons();
      for (const raw of args.lessons.slice(0, 3)) {
        if (!raw || typeof raw !== "object") continue;
        // v0.6 (V6-18): escape before cap (same order as lessons add — the
        // lessons store stays single-lined regardless of the entry path).
        const trigger = truncateStr(escapeDataLine(raw.trigger), 120).trim();
        const fix = truncateStr(escapeDataLine(raw.fix), 200).trim();
        if (!trigger || !fix) {
          lessonsNote = lessonsNote ?? "a lesson missing trigger/fix was skipped";
          continue;
        }
        list.push({
          v: 1,
          id: newLessonId(),
          ts: at,
          updated_at: at,
          mission_id: missionId,
          worker,
          type: LESSON_TYPES.includes(raw.type) ? raw.type : "pitfall",
          trigger,
          lesson: truncateStr(escapeDataLine(raw.lesson ?? ""), 200),
          fix,
          confidence: 0,
          hits: 0,
          status: "candidate",
          refs: [eventId],
          superseded_by: null,
          counter_refs: [],
          note: null,
          // v0.8 (§3.5): same implied-scope / write-path provenance as add.
          scope: "project",
          source: "report",
        });
        lessonsRecorded += 1;
      }
      if (lessonsRecorded) saveLessons(list); // v0.3.1 (A4): under the root lock
    }

    // v0.8 (§3.4): blocked/question lesson feedback loop — lesson_refs lists
    // the pack LESSONS entry ids that proved ineffective/misleading/wrong for
    // this mission (the ids are rendered by v0.8 §3.3 lessonLine). Optional
    // parameter: absent / non-array is ignored as a whole (Array.isArray
    // guard, old workers unchanged); only meaningful for blocked/question.
    // Per referenced id (missing ids are skipped with a note, a bad ref must
    // not fail the blocked report itself):
    //   1. confidence = max(RETIRE_SCORE, confidence − 0.1) — the floor sits
    //      at the same water level as the housekeep threshold;
    //   2. counter_refs appends the mission_id (deduped — the "counter
    //      evidence" chain reuses the contradicts field, no new field);
    //   3. floor retirement rides the housekeepLessons pass right after
    //      (confidence at the floor + >= 2 distinct counter missions →
    //      retired "auto: lesson misses").
    let lessonsDemoted = 0;
    let lessonsRefsNote = null;
    let lessonsRetired = 0;
    if (
      (kind === "blocked" || kind === "question") &&
      Array.isArray(args.lesson_refs) &&
      args.lesson_refs.length
    ) {
      const list = loadLessons();
      const beforeStatuses = new Map(list.map((l) => [l && l.id, l && l.status]));
      const seenRefs = new Set();
      for (const raw of args.lesson_refs) {
        const id = raw == null ? "" : String(raw).trim();
        if (!id || seenRefs.has(id)) continue;
        seenRefs.add(id);
        const entry = list.find((l) => l && l.id === id);
        if (!entry) {
          lessonsRefsNote = lessonsRefsNote ?? `lesson_refs contains an unknown id, skipped: ${id}`;
          continue;
        }
        entry.confidence = Math.max(RETIRE_SCORE, (Number(entry.confidence) || 0) - 0.1);
        entry.counter_refs = Array.isArray(entry.counter_refs) ? entry.counter_refs : [];
        if (!entry.counter_refs.includes(missionId)) entry.counter_refs.push(missionId);
        entry.updated_at = at;
        lessonsDemoted += 1;
      }
      if (lessonsDemoted) {
        if (housekeepLessons(list)) {
          lessonsRetired = list.filter(
            (l) => l && l.status === "retired" && beforeStatuses.get(l.id) === "active",
          ).length;
        }
        saveLessons(list); // v0.3.1 (A4): under the root lock
      }
    }

    return {
      closed: false,
      eventId,
      spoolPath,
      status: updated.status,
      draftedWarn,
      detailsTruncated,
      lessonsRecorded,
      lessonsNote,
      lessonsDemoted,
      lessonsRefsNote,
      lessonsRetired,
      expectedToken,
      token,
      readyToClaim,
      claimWarn,
      scopeViolations,
      manifestNote,
      manifestWarnings,
    };
  });

  const readyToClaimExtras =
    outcome.readyToClaim > 0
      ? {
          ready_to_claim: outcome.readyToClaim,
          hint_claim: `the board has ${outcome.readyToClaim} ready mission(s) to claim: board(action="claim", mission_id=..., worker="<your name>")`,
        }
      : {};
  // v0.4.1 QA fix (distinct warn keys): the three warns used to share one `warn`
  // key, so a later warn silently overwrote an earlier one. Each keeps its own
  // key now; `warn` remains as the combined text for backward compatibility.
  const warnParts = [
    outcome.draftedWarn,
    outcome.claimWarn,
    // v0.6 (V6-09): the old "未携带 token" warn leg is gone — the fail-closed
    // gate rejects token-less reports outright, so it is unreachable here.
    // v0.5 E8⑤: the scope violations keep their own warn_scope key (distinct
    // keys so no warn can overwrite another — the 0.4.1 QA fix precedent)
    // and additionally join the combined warn line.
    outcome.scopeViolations && outcome.scopeViolations.length
      ? `out-of-scope: ${outcome.scopeViolations.join("; ")}`
      : null,
    // v0.6 (V6-18): details truncation keeps its own warn key (same precedent).
    outcome.detailsTruncated
      ? `details exceeded DETAILS_MAX_CHARS (${DETAILS_MAX_CHARS} chars), truncated into the box; put long content in files via artifacts`
      : null,
  ].filter(Boolean);
  return {
    ok: true,
    event_id: outcome.eventId,
    spool_path: displayPath(outcome.spoolPath),
    status: outcome.status,
    // v0.6 (V6-22, SM-08): machine-readable closed key — true means this report
    // was archived to the spool WITHOUT touching the board (mission already
    // closed). `ok` stays true either way (the event landed = call succeeded);
    // the closed reason rides closed_note instead of competing for `note`.
    closed: Boolean(outcome.closed),
    ...(outcome.closed && outcome.note ? { closed_note: outcome.note } : {}),
    hint:
      "The coordinator polls the mailbox to consume this event; only the four emergencies (acceptance criteria about to change / continuing is pointless / an irreversible operation is needed / blocked over 10 minutes)" +
      " with the RespondToCoordinator tool available go straight to the coordinator.",
    lessons_recorded: outcome.lessonsRecorded,
    ...(truncatedNote ? { note: truncatedNote } : {}),
    ...(outcome.lessonsNote ? { lessons_note: outcome.lessonsNote } : {}),
    // v0.8 (§3.4): lesson_refs feedback-loop response keys — omitted entirely
    // when nothing was demoted (CR-04 conditional-key discipline: absent keys
    // = old-worker responses unchanged byte-for-byte). The retire key is
    // `lessons_refs_retired` (not `lessons_retired`) — the latter already
    // belongs to the mailbox gc rider (gc-expired candidates).
    ...(outcome.lessonsDemoted ? { lessons_demoted: outcome.lessonsDemoted } : {}),
    ...(outcome.lessonsRetired ? { lessons_refs_retired: outcome.lessonsRetired } : {}),
    ...(outcome.lessonsRefsNote ? { lessons_refs_note: outcome.lessonsRefsNote } : {}),
    ...(outcome.draftedWarn ? { warn_drafted: outcome.draftedWarn } : {}),
    ...(outcome.claimWarn ? { warn_claim: outcome.claimWarn } : {}),
    // v0.6 (V6-09 改动三 + V6-17): machine-readable foreign-claim marker —
    // true means this report was archived to the spool WITHOUT touching the
    // board because the worker name is not the claim holder (paired auth).
    ...(outcome.foreignClaim ? { foreign_claim: true } : {}),
    ...(outcome.foreignClaim && outcome.note ? { foreign_note: outcome.note } : {}),
    // v0.5 E8⑤: warn_scope carries the out-of-scope paths verbatim (omitted
    // when the declaration is fully in scope or unaudited); never an isError
    // — the worker does not fail on its own declaration, the audit faces the
    // coordinator.
    ...(outcome.scopeViolations && outcome.scopeViolations.length
      ? { warn_scope: outcome.scopeViolations }
      : {}),
    // v0.6 (V6-18): details storage-cap truncation warn (distinct key, INJ-04).
    ...(outcome.detailsTruncated
      ? {
          warn_details: `details exceeded DETAILS_MAX_CHARS (${DETAILS_MAX_CHARS} chars), truncated into the box; put long content in files via artifacts`,
        }
      : {}),
    // v0.5 T2: manifest close-out response keys — conditional, omitted when
    // empty (caps inside limits / no assertion findings -> no keys).
    ...(outcome.manifestNote ? { manifest_note: outcome.manifestNote } : {}),
    ...(outcome.manifestWarnings ? { manifest_warnings: outcome.manifestWarnings } : {}),
    ...(warnParts.length ? { warn: warnParts.join(" ") } : {}),
    ...readyToClaimExtras,
  };
}

export {
  toolReport,
};
