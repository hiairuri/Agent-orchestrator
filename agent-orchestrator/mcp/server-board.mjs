// agent-orchestrator orch server — board store：ack/wake helpers + board.json 读写/合并/状态机/依赖图扫描（机械拆分自 server.mjs L1676-2325）
import fs from "node:fs";
import path from "node:path";
import {
  root, BOARD_VERSION, nowIso, atomicWriteFileSync, sleepMs, ToolError, log,
  truncateStr, depSatisfied, T1_HEAD_CAP, normalizePathList, safeSegment,
  stampMissionId,
} from "./server-core.mjs";
import { claimLeaseMinDefault } from "./server-boot.mjs";
import { countUnreadSafe } from "./server-stores.mjs";
/* ------------------------------------------------------------------ */
/* ack / suspected wake-failure helpers                                */
/* (kept verbatim-identical to the inline copies in hooks/*.mjs)        */
/* ------------------------------------------------------------------ */

const RESULT_STATUSES = ["done", "failed", "blocked", "question"];

function missionAck(m) {
  return m && m.ack && typeof m.ack === "object" ? m.ack : null;
}

function lastResultAt(m) {
  const timeline = m && Array.isArray(m.timeline) ? m.timeline : [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    if (
      entry &&
      typeof entry === "object" &&
      typeof entry.event === "string" &&
      entry.event.startsWith("report:")
    ) {
      if (entry.at != null) return String(entry.at);
    }
  }
  if (m && m.updated_at != null) return String(m.updated_at);
  return null;
}

/**
 * W1 status in RESULT_STATUSES; W2 dispatch.agent_id truthy; W3 not acked;
 * W4 dispatch.mode !== "workflow" (workflow-run missions never participate).
 */
function wakeFailureInfo(m) {
  const suspected = Boolean(
    m &&
      typeof m === "object" &&
      RESULT_STATUSES.includes(m.status) &&
      Boolean(m.dispatch && m.dispatch.agent_id) &&
      missionAck(m) === null &&
      (m.dispatch && m.dispatch.mode) !== "workflow",
  );
  if (!suspected) return { suspected: false, result_at: null, minutes: null };
  const resultAt = lastResultAt(m);
  const ms = resultAt == null ? NaN : Date.parse(resultAt);
  // B7: clock jumps must not produce negative ages.
  const minutes = Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 60000)) : null;
  return { suspected: true, result_at: resultAt == null ? null : resultAt, minutes };
}

function fmtAge(min) {
  if (min == null || !Number.isFinite(min)) return "";
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)}h ${min % 60}m ago`;
}

/**
 * T5 (v0.5): most recent report-class timeline event, scanned from the tail.
 * Report events are written by toolReport as `report:<kind>` (same family the
 * wake-failure check already greps). Zero new storage — the presentation field
 * is derived at read time (懒迁移: old 0.4.x missions simply have none).
 */
function lastReportEvent(m) {
  const tl = Array.isArray(m && m.timeline) ? m.timeline : [];
  for (let i = tl.length - 1; i >= 0; i--) {
    const e = tl[i];
    if (e && typeof e === "object" && String(e.event ?? "").startsWith("report:")) return e;
  }
  return null;
}

/**
 * T5 (v0.5): t1_head — head of the latest report summary (stored under the
 * existing 200-char cap), truncated to 160 chars (§9.1). A mission without
 * any report event presents null.
 */
function t1HeadOf(m) {
  const e = lastReportEvent(m);
  if (!e || e.summary == null) return null;
  return truncateStr(String(e.summary), T1_HEAD_CAP);
}

/**
 * Decorated read-only view: ack/wake_failure are computed, never written back.
 * v0.5 T5/E6 adds the S4 presentation fields (board get/list/upsert read
 * paths; the claim small object does not go through here). All are response
 * only — the stored mission keeps zero new default keys.
 */
function withComputed(m) {
  const w = wakeFailureInfo(m);
  // Same pending-question predicate as the close-over warning (v0.3.1 C6):
  // an answered question is no longer actionable for the coordinator.
  const pendingQuestion = Boolean(
    m.blocked && m.blocked.question && m.blocked.answered === false,
  );
  return {
    ...m,
    ack: missionAck(m), // P2-1: 旧记录缺失 ack（undefined）归一为 null，JSON 序列化不丢键
    wake_failure: w.suspected ? { result_at: w.result_at, minutes: w.minutes } : null,
    // T5: latest report summary head + count fields (无 report → null/0/false).
    t1_head: t1HeadOf(m),
    artifacts_n: Array.isArray(m.artifacts) ? m.artifacts.length : 0,
    output_files_n: Array.isArray(m.output_files) ? m.output_files.length : 0,
    has_question: pendingQuestion,
    // E6 (G-8/DA4-1 终裁): scope summary under the original storage key names.
    // Unregistered presents [] / false; scope_violations passes through the
    // spread only when present (有值自然透出).
    scope_paths: normalizePathList(m.scope_paths),
    strict_scope: m.strict_scope === true,
  };
}

/**
 * v1.1 W3 (A5-A, DESIGN §4.1): board list compact row — the default navigation
 * face. Whitelist only: id/title/status + the three derived flags
 * (question/unacked/unread) + the presentation counters and scope summary.
 * Internal state (claim/dispatch/pack/manifest/wake_failure/ack object),
 * timeline/original_prompt and the full blocked.question stay off the list
 * face; board get (default compact + view:"full") and probe carry the detail.
 * title is carried verbatim (裁的是字段非字符); data stays in board.json
 * unchanged (zero new storage keys).
 */
function compactMissionRow(m) {
  const row = {
    id: m.id,
    title: m.title ?? null,
    status: m.status,
    // Flag 1: pending question (same predicate as the close-over warning).
    question: Boolean(m.blocked && m.blocked.question && m.blocked.answered === false),
    // Flag 2: ack object → boolean (null = not yet acknowledged).
    unacked: missionAck(m) === null,
    // Flag 3: unread spool events (per-mission IO; board scale is tens).
    // v1.1 W6 (QA P2-b): legacy/hand-edited non-canonical ids must not take
    // the whole list down — the 1.0.0 list face was path-free and tolerated
    // them. Spool counting is best-effort: unusable id → 0.
    unread: countUnreadSafe(m.id),
    t1_head: t1HeadOf(m),
    artifacts_n: Array.isArray(m.artifacts) ? m.artifacts.length : 0,
    output_files_n: Array.isArray(m.output_files) ? m.output_files.length : 0,
    scope_paths: normalizePathList(m.scope_paths),
    strict_scope: m.strict_scope === true,
  };
  // Conditional key (有值自然透出), same semantics as the detail face.
  if (m.scope_violations !== undefined) row.scope_violations = m.scope_violations;
  return row;
}

/* ------------------------------------------------------------------ */
/* board.json                                                          */
/* ------------------------------------------------------------------ */

const boardFile = () => path.join(root, "board.json");

const emptyBoard = () => ({ version: 1, updated_at: nowIso(), missions: [] });

// v0.6 (V6-26): set when a corrupt board.json was quarantined; the FIRST board
// list response of this process carries board_degraded_from:<ts> (conditional
// key, consumed once) so the coordinator learns about the degradation.
let boardDegradedFrom = null;

/**
 * v0.6 (V6-26): a corrupt board.json used to brick every board tool with a
 * thrown error and zero self-recovery. Quarantine instead: rename the file to
 * board.json.corrupt-<ts> (evidence preserved, never deleted), rebuild an
 * empty board, warn on stderr, and remember the degradation. Only parse-shape
 * corruption lands here — read IO errors and the missing-file path do not.
 * Two servers racing on the same corrupt file: the loser's rename fails
 * (source already renamed away) and is tolerated — exactly one quarantined
 * copy survives and both proceed on an empty board.
 */
function quarantineCorruptBoard(file, why) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    fs.renameSync(file, `${file}.corrupt-${ts}`);
  } catch {
    /* another process already quarantined it — proceed on empty */
  }
  boardDegradedFrom = ts;
  log(`board.json corrupted (${why}) — quarantined as board.json.corrupt-${ts}, rebuilt an empty board`);
  return emptyBoard();
}

/**
 * v0.3.1 (A2): a "missing" board.json is re-checked 3 more times (50ms apart)
 * before an empty board is accepted. During the old unlink-then-rename fallback
 * there was a window where the file did not exist; a reader that mistook that
 * window for "no board yet" would later save an empty board over the real one.
 *
 * v0.6 (V6-48): before that empty fallback, a board.json.recovered (parked
 * there by the atomic-write last resort) is restored — the next access can no
 * longer silently zero the board. v0.6 (V6-26): parse-shape corruption is
 * quarantined (board.json.corrupt-<ts>) instead of throwing; an ENOENT mid
 * read-race is tolerated as "no board yet".
 */
function loadBoard() {
  const file = boardFile();
  let missing = true;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (fs.existsSync(file)) {
      missing = false;
      break;
    }
    if (attempt < 3) sleepMs(50);
  }
  if (missing) {
    try {
      const recovered = file + ".recovered";
      if (fs.existsSync(recovered)) {
        fs.renameSync(recovered, file);
        missing = false;
        log("board.json was missing — restored from board.json.recovered");
      }
    } catch {
      /* restore failed → empty-board fallback below */
    }
  }
  if (missing) return emptyBoard();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return emptyBoard(); // vanished mid race
    throw new ToolError("board.json unreadable: " + err.message);
  }
  if (!raw.trim()) return emptyBoard();
  // v0.6 (V6-27): strip a UTF-8 BOM before parsing — "记事本另存" writes one,
  // and JSON.parse chokes on it, which used to brick every board tool.
  raw = raw.replace(/^\uFEFF/, "");
  let board;
  try {
    board = JSON.parse(raw);
  } catch (err) {
    return quarantineCorruptBoard(file, "JSON.parse: " + err.message);
  }
  if (!board || typeof board !== "object" || Array.isArray(board)) {
    return quarantineCorruptBoard(file, "not an object");
  }
  if (!Array.isArray(board.missions)) board.missions = [];
  if (typeof board.version !== "number") board.version = 1;
  return board;
}

function saveBoard(board) {
  board.version = BOARD_VERSION;
  board.updated_at = nowIso();
  atomicWriteFileSync(boardFile(), JSON.stringify(board, null, 2) + "\n");
}

function findMission(board, id) {
  return board.missions.find((m) => m && m.id === id);
}

function newMission(id) {
  return {
    id,
    title: "",
    original_prompt: "",
    agent_type: "",
    model: null,
    status: "drafted",
    dispatch: {},
    pack: {},
    artifacts: [],
    output_files: [],
    blocked: {
      question: null,
      asked_at: null,
      answered: false,
      answer: null,
      answered_at: null,
    },
    ack: null,
    // v0.4 dependency graph / sandbox review defaults (lazy migration: old
    // missions without these keys are interpreted as no-dependency / unclaimed).
    blockedBy: [],
    owner: null,
    claim: null,
    qa: null,
    skippedReason: null,
    timeline: [],
  };
}

// Top-level keys whose object values are merged one level deep instead of replaced.
const ONE_LEVEL = new Set(["dispatch", "blocked", "pack", "qa"]);

// v0.4.1 merge whitelist (QA finding: upsert used to store unknown keys such as
// "timeline_note" verbatim — schema drift). Anything outside this set is dropped
// from the patch and reported back as ignored_keys. Read-only/owned keys (ack /
// owner / claim) are stripped earlier; id/timeline bookkeeping is handled by
// upsertMission itself.
const MERGEABLE_KEYS = new Set([
  "title",
  "original_prompt",
  "agent_type",
  "model",
  "status",
  "dispatch",
  "pack",
  "artifacts",
  "output_files",
  "blocked",
  "blockedBy",
  "qa",
  "skippedReason",
  "timeline",
  // v0.5 stage 2 (E2 registration): context_pack registers the normalized
  // write scope. Stage 3 (E4) completes the scope admission fields. None of
  // the four joins ONE_LEVEL: whole replacement IS the registration/audit
  // semantics (each upsert replaces the full list; scope_violations is
  // recomputed wholesale by the report close-out; the manifest pointer has
  // exactly one legitimate writer — the report close-out — and is stripped
  // from upsert input below).
  "scope_paths",
  "strict_scope",
  "scope_violations",
  "manifest",
]);

/** Unknown top-level patch keys (reported, not merged). */
function ignoredPatchKeys(patch) {
  return Object.keys(patch).filter((k) => k !== "id" && !MERGEABLE_KEYS.has(k));
}

// v0.6 (V6-20, SM-03/04/05): the transition whitelist — single source for which
// status changes an EXTERNAL board upsert may request (W-A1 §1 V6-20 表文逐条).
// Internal writers bypass the table via opts.internal=true: sweepGraph
// (unlock/skip/回收), board claim (→running), report (done/blocked/question),
// mailbox answer (→dispatched/ready), sandbox_apply (→closed 直改).
// Legs from the design table marked internal-only are deliberately absent
// here (their only writer bypasses the gate):
//   *→running   — claim only (F3c: the illegal-transition escape hatch is gone)
//   drafted→ready / running→ready — sweepGraph unlock / lease回收 only
// `closed` has NO departing legs: reopening a closed mission = new mission.
// {reopen:true} marks a terminal-revival leg: the call must carry
// reopen:true + note (reason), and a reopen timeline event is recorded.
// Reaching `closed` from outside additionally needs close_confirmed:true
// (V6-11 门 B) and drafted→closed is banned outright (never dispatched =
// nothing to archive).
const ALLOWED_TRANSITIONS = {
  drafted: { dispatched: {}, skipped: {} },
  dispatched: { drafted: {}, ready: {}, closed: {} },
  ready: { dispatched: {}, skipped: {}, closed: {} },
  running: { done: {}, blocked: {}, question: {}, failed: {}, dispatched: {} },
  blocked: { dispatched: {}, ready: {}, closed: {} },
  question: { dispatched: {}, ready: {}, closed: {} },
  done: { closed: {} },
  failed: { closed: {}, drafted: { reopen: true } },
  skipped: { closed: {}, drafted: { reopen: true } },
  resumed: { dispatched: {} },
  closed: {}, // 无离开路径（重开=新建 mission）
};

function mergeMission(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "id") continue;
    if (!MERGEABLE_KEYS.has(key)) continue; // whitelisted schema only
    if (ONE_LEVEL.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = { ...(base[key] || {}) };
      for (const [k2, v2] of Object.entries(value)) {
        if (v2 !== undefined) out[key][k2] = v2;
      }
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function upsertMission(patch, opts = {}) {
  const board = loadBoard();
  const id = safeSegment(patch.id || stampMissionId(), "mission id");
  const idx = board.missions.findIndex((m) => m && m.id === id);
  let mission;
  let prevStatus = null;
  if (idx >= 0) {
    mission = board.missions[idx];
    prevStatus = mission.status;
  } else {
    mission = newMission(id);
  }
  const merged = mergeMission(mission, patch);
  merged.updated_at = nowIso();
  // v0.6 (V6-20/V6-11): the transition gate — external upserts only
  // (opts.internal bypasses: sweep/claim/report/answer/sandbox_apply 各写点
  // 是白名单设计里的合法内部写者). Throws BEFORE any board mutation, so a
  // rejected transition leaves the board byte-identical (SM-03).
  let reopenEvent = null;
  if (!opts.internal) {
    const from = idx >= 0 ? prevStatus : "drafted"; // a new mission starts drafted
    if (from !== merged.status) {
      // V6-11 门 B (half 1): an archive that was never dispatched is a fake —
      // drafted→closed is banned even with close_confirmed.
      if (merged.status === "closed" && from === "drafted") {
        throw new ToolError(
          "drafted -> closed is forbidden directly: archiving without dispatch should use delete/void semantics, or go dispatched first then closed (board unchanged)",
        );
      }
      const leg = (ALLOWED_TRANSITIONS[from] || {})[merged.status];
      if (!leg) {
        const hint =
          from === "closed"
            ? "closed has no exit path: create a new mission to reopen"
            : from === "done" || from === "failed" || from === "skipped"
              ? "the terminal-revival leg is only failed/skipped -> drafted (requires reopen:true + note); archiving goes through closed"
              : "->running is reachable only via board claim; in-flight reclaim/unlock runs inside the sweep";
        throw new ToolError(
          `illegal state transition: ${from} -> ${merged.status} not in the allowlist (ALLOWED_TRANSITIONS; board unchanged). ${hint}`,
        );
      }
      // V6-11 门 B (half 2): closing from the outside requires the explicit
      // one-shot confirmation (transient key: consumed here, never stored).
      if (merged.status === "closed" && opts.closeConfirmed !== true) {
        throw new ToolError(
          'writing status:"closed" directly requires explicit close_confirmed:true (one-shot confirmation against accidental fake archiving; board unchanged)',
        );
      }
      // v0.6 (V6-20): terminal revival — the leg demands reopen:true + note,
      // and any explicit reopen on an accepted transition records its event
      // (reason mandatory in the note, SM-04).
      if (leg.reopen || opts.reopen === true) {
        const reason = String(opts.reopenReason ?? "").trim();
        if (opts.reopen !== true || !reason) {
          throw new ToolError(
            `leaving a terminal state (${from} -> ${merged.status}) requires explicit reopen:true and a note stating why (board unchanged)`,
          );
        }
        reopenEvent = { at: merged.updated_at, event: "reopen", summary: truncateStr(reason, 200) };
      }
    }
  }
  merged.timeline = Array.isArray(merged.timeline) ? merged.timeline : [];
  const statusNote = prevStatus
    ? prevStatus === merged.status
      ? `status ${merged.status} (unchanged)`
      : `status ${prevStatus} → ${merged.status}`
    : `created (status ${merged.status})`;
  merged.timeline.push({ at: merged.updated_at, event: "upsert", summary: statusNote });
  if (reopenEvent) merged.timeline.push(reopenEvent);
  // v0.6 (V6-20, SM-05): an ack never crosses a status transition — a stale
  // 签收 must not whitewash the post-transition state (the close auto-ack
  // below still lands on fresh closes; answer's opts.ack still lands).
  if (prevStatus !== null && prevStatus !== merged.status) merged.ack = null;
  // Auto-ack on close: a closed mission is handled by definition.
  if (merged.status === "closed" && !missionAck(merged)) {
    merged.ack = { at: merged.updated_at, by: "close", note: "auto: closed" };
  }
  // v0.3.1 (C1): a fresh blocked/question report must clear a stale ack, or the
  // old ack would whitewash the new question out of every wake-failure check.
  if (opts.clearAck) merged.ack = null;
  // Explicit ack request from an internal caller (e.g. mailbox answer).
  if (opts.ack && !missionAck(merged)) {
    merged.ack = { at: merged.updated_at, by: opts.ack.by, note: opts.ack.note ?? null };
  }
  if (idx >= 0) board.missions[idx] = merged;
  else board.missions.push(merged);
  // v0.4: the dependency graph is swept synchronously inside the same critical
  // section (every board write is a "done transaction"): unlock / cascade skip /
  // lease回收 / dangling cleanup. Empty graph cost = one O(N) pass.
  if (opts.sweep !== false) sweepGraph(board, merged.updated_at);
  // v0.4: worker reports renew an existing claim lease (same critical section).
  if (opts.renewClaim && merged.claim && typeof merged.claim === "object") {
    merged.claim.leaseUntil = opts.renewClaim.leaseUntil;
  }
  saveBoard(board);
  return merged;
}

/**
 * v0.4 dependency-graph sweep — fixpoint over the whole board. All mutations are
 * in place; every transition writes its own timeline entry. Returns
 * {unlocked, skipped, leaseExpired, leaseInvalid} for observability.
 *   - unlock: drafted + blockedBy all done/skipped/closed -> ready
 *   - cascade skip: drafted/ready + any upstream failed/skipped -> skipped
 *   - lease回收: any non-terminal status + expired claim -> owner/claim cleared
 *     (running/dispatched fall back to ready; blocked/question keep their
 *     status — an unanswered question must not zombie into a claimable one)
 *   - dangling: blockedBy entries pointing at missing missions are dropped once
 */
// v0.6 (V6-28): absolute backstop for malformed leases — a mission whose
// updated_at has been idle longer than this is recycled even when neither
// leaseUntil nor claimedAt parses (24h, aligned with the sentinel's crash
// judgement order of magnitude).
const LEASE_INVALID_HARD_CAP_MS = 24 * 60 * 60 * 1000;

// v0.6 (V6-21, SM-06): terminal statuses are exempt from lease recycling —
// their result stands regardless of a stale lease left behind.
const LEASE_RECYCLE_TERMINAL = new Set(["done", "failed", "skipped", "closed"]);

function sweepGraph(board, at) {
  const unlocked = [];
  const skipped = [];
  const leaseExpired = [];
  const leaseInvalid = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of board.missions) {
      if (!m) continue;
      // 租约回收: an expired lease releases the mission (no timer needed —
      // every write path sweeps, so the next touch after expiry recycles it).
      // v0.6 (V6-21, SM-06): the condition widens from "running with a claim"
      // to "ANY non-terminal status with a claim whose lease is up". A dead
      // owner on dispatched/blocked/question used to be uncleanable (no tool
      // strips owner/claim; the only escape was an illegal transition, which
      // the V6-20 whitelist now blocks). Disposition: running/dispatched fall
      // back to ready (re-claimable); blocked/question KEEP their status — an
      // unanswered question must not zombie into a claimable one (the answer
      // unlocks it, V6-21 answer联动). Terminal statuses are exempt entirely.
      // v0.6 (V6-28): a malformed leaseUntil used to short-circuit the expiry
      // check forever (`Number.isFinite(until) &&` NaN comparison) — the mission
      // stayed an unrecyclable zombie holder. Fallback chain: claimedAt +
      // 4× lease window (lease_minutes default 30), then the 24h updated_at
      // hard cap. The event is lease_invalid (distinct from lease_expired) so
      // the coordinator can tell data corruption from an ordinary timeout.
      if (m.claim && typeof m.claim === "object" && !LEASE_RECYCLE_TERMINAL.has(m.status)) {
        const until = Date.parse(String(m.claim.leaseUntil ?? ""));
        let force = Number.isFinite(until) && until < Date.now();
        let invalid = false;
        if (!Number.isFinite(until)) {
          invalid = true;
          const nowMs = Date.now();
          const claimedMs = Date.parse(String(m.claim.claimedAt ?? ""));
          const leaseMinRaw = Number(m.lease_minutes);
          const leaseMin = Number.isFinite(leaseMinRaw) && leaseMinRaw > 0 ? Math.floor(leaseMinRaw) : claimLeaseMinDefault;
          let deadline = Number.isFinite(claimedMs) ? claimedMs + leaseMin * 4 * 60000 : NaN;
          const updMs = Date.parse(String(m.updated_at ?? ""));
          const hardDeadline = Number.isFinite(updMs) ? updMs + LEASE_INVALID_HARD_CAP_MS : NaN;
          if (Number.isFinite(deadline) && Number.isFinite(hardDeadline)) deadline = Math.min(deadline, hardDeadline);
          else if (Number.isFinite(hardDeadline)) deadline = hardDeadline;
          force = Number.isFinite(deadline) && deadline < nowMs;
        }
        if (force) {
          const backToReady = m.status === "running" || m.status === "dispatched";
          m.owner = null;
          m.claim = null;
          if (backToReady) m.status = "ready";
          m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
          m.timeline.push(
            invalid
              ? {
                  at,
                  event: "lease_invalid",
                  summary: backToReady
                    ? "leaseUntil malformed/unparsable -> force-reclaimed by the fallback age, back to ready for re-claim"
                    : `leaseUntil malformed/unparsable -> force-reclaimed by the fallback age (status ${m.status} kept)`,
                }
              : {
                  at,
                  event: "lease_expired",
                  summary: backToReady
                    ? "lease expired without renewal -> back to ready for re-claim"
                    : `lease expired without renewal -> lease reclaimed (status ${m.status} kept; unlocks when an answer arrives)`,
                },
          );
          (invalid ? leaseInvalid : leaseExpired).push(m.id);
          changed = true;
        }
      }
      if (!Array.isArray(m.blockedBy) || !m.blockedBy.length) continue;
      // Dangling reference handling. Forward references are legal (§2.5: the
      // dependency may be created after the dependent), so the FIRST sweep that
      // sees a dangling id only marks it (danglingRefSince); the NEXT sweep
      // drops it with a timeline event (design case D4). Without the deferral a
      // forward-referenced cycle (D3) would be invisible to the cycle check.
      const before = m.blockedBy.length;
      const hasDangling = m.blockedBy.some((dep) => !board.missions.some((x) => x && x.id === dep));
      if (hasDangling) {
        if (!m.danglingRefSince) {
          m.danglingRefSince = at; // first sighting: keep forward references
        } else {
          // QA fix (v0.4.1): name the dropped ids explicitly — the old wording
          // ("N 项不存在") did not say WHICH references were removed.
          const droppedIds = m.blockedBy.filter((dep) => !board.missions.some((x) => x && x.id === dep));
          m.blockedBy = m.blockedBy.filter((dep) => board.missions.some((x) => x && x.id === dep));
          delete m.danglingRefSince;
          m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
          m.timeline.push({
            at,
            event: "dangling_dropped",
            summary:
              `cleaned ${before - m.blockedBy.length} dangling dependency references (${droppedIds.join(", ")} do not exist). ` +
              "forward references may land across one write transaction; if miswritten, fix blockedBy",
          });
          changed = true;
        }
      } else if (m.danglingRefSince) {
        delete m.danglingRefSince; // deps materialized before the drop deadline
      }
      const deps = m.blockedBy.map((dep) => board.missions.find((x) => x && x.id === dep));
      const failedDeps = deps.filter((d) => d && (d.status === "failed" || d.status === "skipped"));
      if (
        (m.status === "drafted" || m.status === "ready") &&
        failedDeps.length
      ) {
        m.status = "skipped";
        m.skippedReason = "upstream_failed";
        m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
        m.timeline.push({
          at,
          event: "skip:upstream_failed",
          summary: "upstream " + failedDeps.map((d) => d.id).join(","),
        });
        skipped.push(m.id);
        changed = true;
        continue;
      }
      if (
        m.status === "drafted" &&
        deps.length &&
        deps.every((d) => d && depSatisfied(d)) // v0.6 (V6-11): closed 上游须有绿档凭证
      ) {
        m.status = "ready";
        m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
        m.timeline.push({ at, event: "unlock", summary: "blockedBy all green -> ready for claim" });
        unlocked.push(m.id);
        changed = true;
      }
    }
  }
  return { unlocked, skipped, leaseExpired, leaseInvalid };
}

/**
 * v0.4 cycle detection for blockedBy changes. The graph view uses the NEW
 * blockedBy for `id` and the stored ones for everyone else; a cycle exists iff
 * `id` is reachable from one of its own (new) dependencies. Returns the path
 * from the dependency back to id (for the error message) or null.
 */
function detectCycle(board, id, blockedBy) {
  if (!Array.isArray(blockedBy)) return null;
  if (blockedBy.includes(id)) return [id]; // one-step self loop
  const depsOf = (mid) => {
    if (mid === id) return blockedBy;
    const m = board.missions.find((x) => x && x.id === mid);
    const list = m && Array.isArray(m.blockedBy) ? m.blockedBy : [];
    return list.filter((d) => d !== mid);
  };
  const seen = new Set();
  const stack = blockedBy.map((d) => ({ node: d, path: [d] }));
  while (stack.length) {
    const { node, path } = stack.pop();
    if (node === id) return path; // dep -> ... -> id
    if (seen.has(node)) continue;
    seen.add(node);
    for (const d of depsOf(node)) stack.push({ node: d, path: [...path, d] });
  }
  return null;
}

// 接线新增（拆分）：boardDegradedFrom 为本模块私有 let，tools-board 经此 accessor 读写（语义等价）
function getBoardDegradedFrom() {
  return boardDegradedFrom;
}

function setBoardDegradedFrom(value) {
  boardDegradedFrom = value;
}

/** Q2 归因字段值源（v1.2 M3-1）：派发时主控会话 id 锚 =
 *  <root>/sentinel/coord-session.txt（resume 通道刷新，bg-sentinel 同款消费面）。
 *  best-effort：缺文件/空内容 → null（W9 scoping 空值三段的「前向归因缺席」回落，
 *  消费端按缺席语义处理，此处不造值）。
 *  v1.6 W3a（design §2.7/impl-plan R6）：随 dispatchScopingAbsentCount 谓词自
 *  dispatch-core 下行迁入 server-board（板域谓词+归因锚同域；tool-pack/dispatch-core
 *  下行 import 合法——LAYER_OF server-board=1＜2，LM-06-DEP 零登记）。 */
function dispatchCoordSessionId() {
  try {
    const v = fs.readFileSync(path.join(root, "sentinel", "coord-session.txt"), "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

/** v1.2 M9-1（§6.2a 空值归因硬约束件·无条件）：组包尾块缺席计数——统计「哨兵本应产生
 * 盯守条件、但归因缺席将被 scoping 跳过」的在盯 mission 数。watchable 集合镜像
 * bg-sentinel classify 条件集（C1=终态+dispatch.agent_id+未签收+非 workflow；
 * C2/C3=在飞+dispatch.agent_id——均要求 agent_id，headless 在飞无 agent 本就不产条件）；
 * 归因=dispatch.session_id ∥ dispatch.spawned_by_session（W3 M3-1 前向归因字段）。
 * selfMissionId=本次派发的 mission：其 spawned_by_session 在同步段随 upsert 落盘，
 * 锚在场即有归因（不计入）；锚缺失则计入（如实呈现最坏面，不因组装时序低估）。
 * 板不可读 → 0（计数是呈现面非门禁，不阻塞派发）。
 * v1.6 W3a：自 dispatch-core 下行迁入（板域谓词）；消费面=tool-pack buildPackMarkdown
 * STATE 节 scoping 行（context_pack 物化时点快照，design §2.7 推翻③）。 */
function dispatchScopingAbsentCount(selfMissionId) {
  try {
    const board = JSON.parse(fs.readFileSync(path.join(root, "board.json"), "utf8"));
    const missions = board && Array.isArray(board.missions) ? board.missions : [];
    const anchor = dispatchCoordSessionId();
    const inFlight = (s) => s === "dispatched" || s === "running" || s === "resumed";
    const result = (s) => s === "done" || s === "failed" || s === "blocked" || s === "question";
    let n = 0;
    for (const m of missions) {
      if (!m || typeof m !== "object") continue;
      const d = m.dispatch && typeof m.dispatch === "object" ? m.dispatch : {};
      if (d.mode === "workflow") continue; // B4：workflow 由宿主通知，哨兵不盯守
      const status = String(m.status ?? "");
      const watchable =
        Boolean(d.agent_id) &&
        (inFlight(status) || (result(status) && !(m.ack && typeof m.ack === "object")));
      if (!watchable) continue;
      const sid = typeof d.session_id === "string" ? d.session_id.trim() : "";
      const spawned = typeof d.spawned_by_session === "string" ? d.spawned_by_session.trim() : "";
      if (sid || spawned) continue; // 有归因 → 等值判定照常，不计缺席
      if (selfMissionId != null && String(m.id) === String(selfMissionId)) {
        if (!anchor) n += 1; // 自 mission：锚缺失时同步段的 spawned_by_session 也将为 null
        continue;
      }
      n += 1;
    }
    return n;
  } catch {
    return 0; // 板不可读 → 0（呈现面非门禁）
  }
}

export {
  missionAck,
  wakeFailureInfo,
  t1HeadOf,
  withComputed,
  compactMissionRow,
  boardFile,
  loadBoard,
  saveBoard,
  findMission,
  ignoredPatchKeys,
  upsertMission,
  sweepGraph,
  detectCycle,
  getBoardDegradedFrom,
  setBoardDegradedFrom,
  dispatchCoordSessionId,
  dispatchScopingAbsentCount,
};
