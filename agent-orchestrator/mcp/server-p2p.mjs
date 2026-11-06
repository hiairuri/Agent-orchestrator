// agent-orchestrator orch server — P2P 直通仲裁：记录文件/token 闸/TTL 清扫（机械拆分自 server.mjs L3658-3853；顶层 gcP2pFiles() 启动副作用保持）
import fs from "node:fs";
import path from "node:path";
import {
  root, safeSegment, nowIso, truncateStr, escapeDataLine, atomicWriteFileSync,
  withRootLock, ToolError,
} from "./server-core.mjs";
import { strictTokens, p2pTtlMinDefault } from "./server-boot.mjs";
import { loadBoard, saveBoard, findMission } from "./server-board.mjs";
/* ------------------------------------------------------------------ */
/* v0.7 (V7-02, W-A §3): P2P direct-channel arbitration                */
/*                                                                     */
/* Peer questions ride the board tool as actions p2p_ask/p2p_answer    */
/* (ruling ①: no 12th tool). Three frozen boundaries (W-A1 token-P2P)  */
/* are mechanized here:                                                */
/*   ① no credentials in transit — callers authenticate with THEIR OWN */
/*      mission's (mission_id, worker, token) via the report-gate      */
/*      mirror below; the token never enters the p2p record, any       */
/*      payload, or a response (record identity is mission_id+worker). */
/*   ② answer-only — p2p_answer writes the p2p record plus the forced  */
/*      echoes and NOTHING else; the asker's status/fields/lease are   */
/*      zero-touch (the Q&A result is advisory data the asker digests  */
/*      through its own report).                                       */
/*   ③ audit echo (ruling ②: server-forced, replacing the worker-      */
/*      voluntary report of the frozen text) — every ask/answer/expire */
/*      appends one echo event to BOTH missions' timelines, written by */
/*      the server as neutral arbiter; board get replays the trail,    */
/*      the full text lives in the p2p record.                         */
/* Records live at <root>/p2p/p2p-<id>.json (single-question file,     */
/* spool precedent) — never inside board.json (anti-giant-board).      */
/* Lease ruling (W-D dependency 2): p2p events NEVER renew a claim     */
/* lease (renewal stays exclusive to report, V6-17 undiluted);         */
/* liveness is unaffected — the sentinel's lastActivityMs counts ANY   */
/* timeline event, so the echoes count automatically. Sentinel side is */
/* zero-change by construction.                                        */
/* ------------------------------------------------------------------ */

const P2P_TERMINAL_STATUSES = ["done", "failed", "skipped", "closed"];
// Ask precondition (ruling ③): P2P is the alternate channel of the
// blocked/question wait — same semantics family as sentinel question_grace_min.
const P2P_ASK_PRECONDITION_STATUSES = ["blocked", "question"];
const P2P_ECHO_SUMMARY_CAP = 200;

const p2pDir = () => path.join(root, "p2p");
const P2P_FILE_RE = /^p2p-([A-Za-z0-9._-]+)\.json$/;

function p2pFilePath(id) {
  return path.join(p2pDir(), `p2p-${safeSegment(id, "p2p id")}.json`);
}

function loadP2pRecord(id) {
  let raw;
  try {
    raw = fs.readFileSync(p2pFilePath(id), "utf8");
  } catch {
    return null; // ENOENT / transient read race → "not found" to the caller
  }
  try {
    const rec = JSON.parse(raw);
    return rec && typeof rec === "object" && !Array.isArray(rec) ? rec : null;
  } catch {
    return null; // malformed file behaves as absent (no quarantine: p2p is advisory data)
  }
}

function saveP2pRecord(rec) {
  fs.mkdirSync(p2pDir(), { recursive: true });
  atomicWriteFileSync(p2pFilePath(rec.id), JSON.stringify(rec, null, 2) + "\n");
}

/**
 * Boundary ③ writer: append one echo event to a mission's timeline. The append
 * is the ONLY touch — status, updated_at and every other field stay verbatim
 * (an echo is an audit fact, not a state change; the sentinel reads timeline
 * event `at` directly, so liveness needs no updated_at bump). Missing mission
 * → skipped (false), never fatal: the p2p record remains the source of truth.
 */
function appendP2pEcho(board, missionId, event, summary, at) {
  const m = findMission(board, missionId);
  if (!m) return false;
  m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
  m.timeline.push({ at, event, summary });
  return true;
}

/** Echo summary head: control-escaped (V6-18 family) + capped. */
function p2pEchoHead(text) {
  return truncateStr(escapeDataLine(text), P2P_ECHO_SUMMARY_CAP);
}

/**
 * report-gate mirror (V6-09/17/19 semantics; message family aligned with
 * report's "missing token"/"token mismatch"): expectedToken present → the call
 * MUST carry the token and match exactly; --strict-tokens closes the no-token
 * face; a claim-holder mismatch rejects (paired auth). Unlike report there is
 * no archive-anyway fallback — p2p has no board write to withhold, so a
 * stranger gets a hard ToolError.
 */
function p2pTokenGate(mission, missionId, worker, token) {
  const expectedToken =
    mission.dispatch && mission.dispatch.token ? String(mission.dispatch.token) : null;
  if (expectedToken != null) {
    if (token == null || token === "") {
      throw new ToolError(
        `p2p missing token for mission ${missionId}: refusing ` +
          `(this mission already carries a dispatch token; the call must carry it; check the [token] line in the pack CONTRACT section)`,
      );
    }
    if (token !== expectedToken) {
      throw new ToolError(
        `p2p token mismatch for mission ${missionId}: refusing ` +
          `(check the [token] line in the pack CONTRACT section)`,
      );
    }
  } else if (strictTokens) {
    throw new ToolError(
      `p2p rejected for mission ${missionId}: calls without a dispatch token are not accepted in --strict-tokens mode`,
    );
  }
  const claimHolder =
    mission.claim && typeof mission.claim === "object" && mission.claim.worker != null
      ? String(mission.claim.worker)
      : null;
  if (claimHolder !== null && claimHolder !== worker) {
    throw new ToolError(
      `p2p pairwise auth failed: mission ${missionId} lease belongs to ${claimHolder}; caller worker=${worker} rejected`,
    );
  }
  return expectedToken;
}

/**
 * TTL sweep: open records past the TTL flip to expired, each with the two-sided
 * `p2p:expired` echo. Time-driven expiry has no ticker, so the sweep rides
 * startup + p2p_ask/p2p_answer + board list (sweepGraph-on-write philosophy).
 * Invalid/future created_at reads as NOT due (safe direction: keep open).
 */
function gcP2pFiles() {
  let names;
  try {
    names = fs.readdirSync(p2pDir());
  } catch {
    return 0; // no p2p dir → zero side effects
  }
  const cutoff = Date.now() - p2pTtlMinDefault * 60000;
  const due = [];
  for (const name of names) {
    const m = P2P_FILE_RE.exec(name);
    if (!m) continue;
    const rec = loadP2pRecord(m[1]);
    if (!rec || rec.status !== "open") continue;
    const created = Date.parse(String(rec.created_at ?? ""));
    if (!Number.isFinite(created) || created > cutoff) continue;
    due.push(rec);
  }
  if (!due.length) return 0;
  const at = nowIso();
  withRootLock(() => {
    const board = loadBoard();
    let touched = false;
    for (const rec of due) {
      rec.status = "expired";
      rec.expired_at = at;
      const head = p2pEchoHead(rec.question);
      touched =
        appendP2pEcho(
          board,
          rec.from && rec.from.mission_id,
          "p2p:expired",
          `P2P ask<${rec.id}> TTL expired unanswered (-> ${rec.to && rec.to.mission_id}/${rec.to && rec.to.worker}): ${head}`,
          at,
        ) || touched;
      touched =
        appendP2pEcho(
          board,
          rec.to && rec.to.mission_id,
          "p2p:expired",
          `P2P ask<${rec.id}> TTL expired unanswered (<- ${rec.from && rec.from.mission_id}/${rec.from && rec.from.worker}): ${head}`,
          at,
        ) || touched;
      saveP2pRecord(rec);
    }
    if (touched) saveBoard(board);
  });
  return due.length;
}
gcP2pFiles(); // once at startup

/** Open-record counter riding board list (gc first so the count is honest). */
function countOpenP2p() {
  let names;
  try {
    names = fs.readdirSync(p2pDir());
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    const m = P2P_FILE_RE.exec(name);
    if (!m) continue;
    const rec = loadP2pRecord(m[1]);
    if (rec && rec.status === "open") n += 1;
  }
  return n;
}

export {
  P2P_TERMINAL_STATUSES,
  P2P_ASK_PRECONDITION_STATUSES,
  loadP2pRecord,
  saveP2pRecord,
  appendP2pEcho,
  p2pEchoHead,
  p2pTokenGate,
  gcP2pFiles,
  countOpenP2p,
};
