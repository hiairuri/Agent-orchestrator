// agent-orchestrator orch server — tool: mailbox（peek/read/answer/gc；机械拆分自 server.mjs L4875-5205）
import fs from "node:fs";
import path from "node:path";
import {
  root, hex, nowIso, safeSegment, withRootLock, ToolError, truncateStr,
  displayPath, atomicWriteFileSync, KINDS, REPORT, T1_HEAD_CAP,
} from "./server-core.mjs";
import { loadBoard, findMission, saveBoard, upsertMission } from "./server-board.mjs";
import {
  listSpoolMissions, listUnreadFiles, readEventFile, consumeEventFile,
  eventAgeMs, missionSpoolDir, unreadDirOf, readDirOf, contextDir, listJournalFiles,
} from "./server-stores.mjs";
import { loadLessons, saveLessons } from "./server-lessons.mjs";
/* ------------------------------------------------------------------ */
/* tool: mailbox                                                       */
/* ------------------------------------------------------------------ */

/**
 * v1.1 W3 (A5-E, DESIGN §4.5): mailbox read presents a POINTER, not the long
 * body. details_head ≤160 chars (T1_HEAD_CAP precedent) + details_path (the
 * consumed spool file, absolute-or-display path — the full evidence stays in
 * the spool, storage cap DETAILS_MAX_CHARS untouched) + a pointer-ized HINT
 * sentence (the artifacts advice survives). peek never carried details and
 * stays byte-for-byte as before.
 */
const DETAILS_POINTER_HINT = "full details at details_path (long content goes to files via artifacts; the mailbox carries summaries only)";

function presentMailboxDetails(details, spoolPath) {
  const s = String(details ?? "");
  if (!s) return null;
  return {
    details_head: truncateStr(s, T1_HEAD_CAP),
    details_path: displayPath(spoolPath),
    details_hint: DETAILS_POINTER_HINT,
  };
}

function toolMailbox(args) {
  const action = args.action ?? "peek";
  const kindFilter = args.kind;
  if (kindFilter !== undefined && kindFilter !== null && !KINDS.includes(kindFilter)) {
    throw new ToolError(`invalid kind filter: ${JSON.stringify(kindFilter)}`);
  }
  const limit = args.limit == null ? 20 : Math.max(0, Math.floor(Number(args.limit) || 0));
  const missionFilter = args.mission_id == null ? null : safeSegment(args.mission_id, "mission_id");

  if (action === "peek") {
    const missionIds = missionFilter ? [missionFilter] : listSpoolMissions();
    const events = [];
    const perMission = [];
    for (const mid of missionIds) {
      const rows = [];
      for (const file of listUnreadFiles(mid)) {
        const payload = readEventFile(file);
        if (!payload) continue;
        if (kindFilter && payload.kind !== kindFilter) continue;
        rows.push({ file, payload });
      }
      if (!rows.length) continue;
      const ages = rows.map((r) => eventAgeMs(r.payload));
      perMission.push({
        mission_id: mid,
        unread: rows.length,
        oldest_age_ms: Math.max(...ages),
      });
      for (const { file, payload } of rows) {
        events.push({
          event_id: payload.id || path.basename(file, ".json"),
          mission_id: mid,
          worker: payload.worker ?? "",
          kind: payload.kind ?? "",
          summary: payload.summary ?? "",
          age_ms: eventAgeMs(payload),
        });
      }
    }
    events.sort((a, b) => String(a.event_id).localeCompare(String(b.event_id)));
    perMission.sort((a, b) => b.oldest_age_ms - a.oldest_age_ms);
    return {
      total: events.length,
      events: events.slice(0, limit),
      per_mission: perMission,
    };
  }

  if (action === "read") {
    // v0.3.1: consuming mutates the spool — the whole read runs under the root
    // lock so concurrent readers can neither double-deliver an event nor trip
    // over each other's renames.
    return withRootLock(() => {
      const missionIds = missionFilter ? [missionFilter] : listSpoolMissions();
      const payloads = [];
      outer: for (const mid of missionIds) {
        for (const file of listUnreadFiles(mid)) {
          const payload = readEventFile(file);
          if (!payload) continue;
          if (kindFilter && payload.kind !== kindFilter) continue;
          let dst = null;
          try {
            dst = consumeEventFile(file, mid);
          } catch (err) {
            // v0.3.1 (B9): ENOENT on rename means a concurrent reader consumed
            // the event first — treat as consumed and move on instead of
            // erroring. "Unresolved" moves stay for the next read.
            if (err && (err.code === "ENOENT" || err.unresolved)) continue;
            throw err;
          }
          payloads.push({ payload, dst });
          if (payloads.length >= limit) break outer;
        }
      }
      payloads.sort((a, b) => String(a.payload.id || "").localeCompare(String(b.payload.id || "")));
      return {
        consumed: payloads.length,
        // v1.1 W3 (A5-E): pointer presentation on the read response — details
        // becomes {details_head, details_path, details_hint}; events without
        // details keep the pre-v1.1 shape. The spool files stay the evidence.
        events: payloads.map(({ payload, dst }) => {
          const { details, ...rest } = payload;
          const pointer = presentMailboxDetails(details, dst || "");
          return pointer ? { ...rest, ...pointer } : rest;
        }),
      };
    });
  }

  if (action === "answer") {
    if (!missionFilter) throw new ToolError('mailbox answer requires "mission_id"');
    const answer = String(args.answer ?? "");
    if (!answer.trim()) throw new ToolError('mailbox answer requires "answer"');
    // v0.3.1 (A1/A3): answer-file sequence allocation + wx write + board update
    // form one critical section under the root lock.
    return withRootLock(() => {
      const mission = findMission(loadBoard(), missionFilter);
      if (!mission) throw new ToolError(`mission not found: ${missionFilter}`);
      // v0.3.1 (C3): only blocked/question may flip back to dispatched; a
      // terminal result must never be washed back into an in-flight state.
      if (mission.status === "done" || mission.status === "failed" || mission.status === "closed") {
        throw new ToolError(
          `mission ${missionFilter} is already terminal (${mission.status}): answer refused (a terminal result cannot be washed back into running).` +
            `use board(action="ack", mission_id="${missionFilter}") to defer the ack instead, or keep it terminal and dispose directly`,
        );
      }
      const at = nowIso();
      const answersDir = path.join(missionSpoolDir(missionFilter), "answers");
      fs.mkdirSync(answersDir, { recursive: true });
      let seq = 1;
      for (const f of fs.readdirSync(answersDir)) {
        const m = /^(\d+)-answer\.json$/.exec(f);
        if (m) seq = Math.max(seq, Number(m[1]) + 1);
      }
      const answerDoc = {
        v: 1,
        at,
        mission_id: missionFilter,
        agent_id: (mission.dispatch && mission.dispatch.agent_id) || null,
        question: (mission.blocked && mission.blocked.question) || null,
        answer,
      };
      // A3: exclusive create — a concurrent writer can never overwrite an
      // existing answer; the sequence number just increments.
      let answerFile = null;
      for (;;) {
        const candidate = path.join(answersDir, `${String(seq).padStart(4, "0")}-answer.json`);
        try {
          fs.writeFileSync(candidate, JSON.stringify(answerDoc, null, 2) + "\n", { flag: "wx" });
          answerFile = candidate;
          break;
        } catch (err) {
          if (err && err.code === "EEXIST" && seq < 100000) {
            seq += 1;
            continue;
          }
          throw err;
        }
      }
      const wasBlocked = mission.status === "blocked" || mission.status === "question";
      // v0.6 (V6-21, SM-07): the post-answer flip is owner-aware. A mission
      // whose lease was recycled (owner/claim swept, status kept) has nobody
      // attached — the answer drops it straight to ready so the pool can
      // re-claim immediately (E4 "永久 dispatched" / E5 "claim 被拒" 双卡点
      // 消解). An attached owner keeps the classic dispatched flip (steer the
      // live worker). answer is an internal writer (V6-20 whitelist bypass).
      const wasOwned = Boolean(mission.owner);
      const updated = upsertMission(
        {
          id: missionFilter,
          ...(wasBlocked ? { status: wasOwned ? "dispatched" : "ready" } : {}), // C3: only blocked/question flip status
          blocked: { answer, answered: true, answered_at: at },
          timeline: [
            ...(Array.isArray(mission.timeline) ? mission.timeline : []),
            { at, event: "answer", summary: truncateStr(answer, 200) },
          ],
        },
        { internal: true, ack: { by: "answer", note: "auto: answered" } },
      );
      return {
        ok: true,
        answer_file: displayPath(answerFile),
        answer_seq: seq,
        status: updated.status,
        ack: { at, by: "answer", note: "auto: answered" },
        recommended_call: {
          tool: "SendMessage",
          to: (mission.dispatch && mission.dispatch.agent_id) || null,
          summary: truncateStr(answer, 200),
          message:
            answer +
            "\n\nContinue the pack's TASK/RULES per the answer above; when done, keep reporting via " +
            REPORT +
            " (kind=milestone/done; done requires artifact paths)." +
            "if the answer raises a new blocker, report(kind=blocked, question=...) again.",
        },
        note:
          "running = steer; terminal = resume the chat in the background; cross-session/no agentId = rebuild with context_pack and re-dispatch",
      };
    });
  }

  if (action === "gc") {
    return withRootLock(() => {
      const keepDays = args.keep_days == null ? 14 : Number(args.keep_days);
      const cutoff = Date.now() - keepDays * 86400000;
      let removed = 0;
      let archivedUnread = 0;
      for (const mid of listSpoolMissions()) {
        // v0.3.1 (C4): stale unread events are archived (moved to read/). The
        // read/ sweep runs FIRST with the same cutoff, so just-archived events
        // survive this pass and only age out on a later gc.
        const rdir = readDirOf(mid);
        let files = [];
        try {
          files = fs.readdirSync(rdir);
        } catch {
          files = [];
        }
        for (const f of files) {
          const full = path.join(rdir, f);
          try {
            if (fs.statSync(full).mtimeMs < cutoff) {
              fs.unlinkSync(full);
              removed += 1;
            }
          } catch {
            /* best effort */
          }
        }
        const udir = unreadDirOf(mid);
        let ufiles = [];
        try {
          ufiles = fs.readdirSync(udir).filter((f) => f.endsWith(".json"));
        } catch {
          /* no unread dir */
        }
        for (const f of ufiles) {
          const full = path.join(udir, f);
          try {
            if (fs.statSync(full).mtimeMs < cutoff) {
              consumeEventFile(full, mid);
              archivedUnread += 1;
            }
          } catch (err) {
            if (err && err.code === "ENOENT") continue; // consumed concurrently
            /* best effort */
          }
        }
      }
      const board = loadBoard();
      const closed = board.missions.filter((m) => m && m.status === "closed");
      let archiveFile = null;
      if (closed.length) {
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        const ts =
          `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
          `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
        const archiveDir = path.join(root, "archive");
        let candidate = path.join(archiveDir, `board-${ts}.json`);
        if (fs.existsSync(candidate)) candidate = path.join(archiveDir, `board-${ts}-${hex(2)}.json`);
        // Archive first; only then remove from the live board.
        atomicWriteFileSync(
          candidate,
          JSON.stringify({ archived_at: nowIso(), missions: closed }, null, 2) + "\n",
        );
        board.missions = board.missions.filter((m) => !(m && m.status === "closed"));
        saveBoard(board);
        archiveFile = candidate;
      }
      // v0.3 gc riders: stale lesson candidates -> retired; stale journal files -> deleted.
      let lessonsRetired = 0;
      const lessons = loadLessons();
      for (const l of lessons) {
        if (!l || typeof l !== "object" || l.status !== "candidate") continue;
        const ts = Date.parse(String(l.updated_at || ""));
        if (Number.isFinite(ts) && ts < cutoff) {
          l.status = "retired";
          l.note = "auto: gc";
          l.updated_at = nowIso();
          lessonsRetired += 1;
        }
      }
      if (lessonsRetired) saveLessons(lessons);
      let removedJournal = 0;
      for (const { file } of listJournalFiles()) {
        try {
          if (fs.statSync(file).mtimeMs < cutoff) {
            fs.unlinkSync(file);
            removedJournal += 1;
          }
        } catch {
          /* best effort */
        }
      }
      // v0.3.1 (A5 riders): rotated .old journals age out with the same cutoff.
      try {
        for (const name of fs.readdirSync(contextDir())) {
          if (!/^journal-.+\.jsonl\.old$/.test(name)) continue;
          const full = path.join(contextDir(), name);
          try {
            if (fs.statSync(full).mtimeMs < cutoff) {
              fs.unlinkSync(full);
              removedJournal += 1;
            }
          } catch {
            /* best effort */
          }
        }
      } catch {
        /* no context dir */
      }
      return {
        ok: true,
        removed_read_events: removed,
        archived_unread_events: archivedUnread,
        archived_missions: closed.length,
        archive_file: archiveFile ? displayPath(archiveFile) : null,
        lessons_retired: lessonsRetired,
        removed_journal_files: removedJournal,
      };
    });
  }

  throw new ToolError(`unknown mailbox action: ${JSON.stringify(action)} (use peek|read|answer|gc)`);
}

export {
  toolMailbox,
};
