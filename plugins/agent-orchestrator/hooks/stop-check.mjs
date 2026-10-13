#!/usr/bin/env node
/**
 * agent-orchestrator Stop hook ("收工闸门").
 *
 * File events have no wake-up channel: Stop is the coordinator's only chance to
 * be pulled back and account for unfinished missions before ending the turn.
 *
 * v0.2: terminal (done/failed) missions now count as open, and missions whose
 * result is on disk but was never claimed by the coordinator are listed first
 * as "疑似唤醒失败" (suspected wake failure). ack via board/mailbox clears it.
 *
 * v0.3: also records the assistant-side context mirror entry (Stop stdin's
 * last_assistant_message) BEFORE the stop_hook_active short-circuit — the
 * mirror must capture even reminded stops. Recording is always silent.
 *
 * stdin : JSON payload containing stop_hook_active. ZCODE_PROJECT_DIR is in env.
 * stdout: nothing when stop_hook_active === true or nothing is pending; otherwise
 *         strict JSON {"hookSpecificOutput":{"hookEventName":"Stop",
 *         "additionalContext":"..."}} (single line, <= 1500 chars).
 * exit  : always 0.
 *
 * Storage root discovery mirrors hooks/session-start.mjs (root.txt pointer first).
 */
import fs from "node:fs";
import path from "node:path";

const MAX_OUTPUT_CHARS = 1500;
// v0.3.1 (C2): "resumed" joins the open set — a resumed mission whose worker
// died used to vanish from the stop-time accounting.
const OPEN_STATUSES = ["dispatched", "running", "blocked", "question", "resumed"];
const RESULT_STATUSES = ["done", "failed", "blocked", "question"];

/* --- context mirror recording (verbatim twin of hooks/journal.mjs) --- */

const MIRROR_MAX_BYTES = 2000000;

function mirrorParseArg(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1] ?? "";
    if (argv[i].startsWith(flag + "=")) return argv[i].slice(flag.length + 1);
  }
  return "";
}

function mirrorOnOff(raw, def) {
  const s = String(raw ?? "").trim();
  if (!s || s.startsWith("${")) return def;
  return s === "off" ? false : s === "on" ? true : def;
}

function mirrorMaxCharsPair(raw, defU, defA) {
  const parts = String(raw ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .map((n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0));
  const u = parts[0] || defU;
  const a = parts[1] || parts[0] || defA;
  return { user: u, assistant: a };
}

/** Last seq via a bounded tail read (never a full-file read). */
function mirrorLastSeqOf(file) {
  return mirrorLastSeqWindow(file, 8192);
}

/** Tail search with a growing window — handles lines longer than 8KB. */
function mirrorLastSeqDeep(file) {
  let size = 0;
  try {
    size = fs.fstatSync(fs.openSync(file, "r")).size;
  } catch {
    return 0;
  }
  let window = 8192;
  for (;;) {
    const seq = mirrorLastSeqWindow(file, window);
    if (seq > 0) return seq;
    if (window >= size) return 0;
    window = Math.min(window * 8, size);
  }
}

function mirrorLastSeqWindow(file, window) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return 0;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const chunk = Math.min(window, size);
    if (chunk <= 0) return 0;
    const buf = Buffer.alloc(chunk);
    fs.readSync(fd, buf, 0, chunk, size - chunk);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const seq = Number(JSON.parse(lines[i]).seq);
        if (Number.isFinite(seq)) return seq;
      } catch {
        /* skip bad tail line */
      }
    }
    return 0;
  } catch {
    return 0;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best effort */
    }
  }
}

function mirrorRecord(rootDir, sid, kind, text, cap, maxBytes = MIRROR_MAX_BYTES) {
  const dir = path.join(rootDir, "context");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `journal-${sid}.jsonl`);
  // Rotation decision first (approximate line size), so seq can be derived from
  // whichever file ends up holding the previous entries.
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* new file */
  }
  const roughLine = Buffer.byteLength(String(text ?? "").slice(0, cap), "utf8") + 200;
  const overLimit = size + roughLine > maxBytes;
  let prevSeq;
  if (overLimit && size > 0) {
    // v0.3.1 (A5): rotation = rename the over-limit file to .old and let the
    // append below open a fresh file; no whole-file read-modify-write anymore.
    try {
      fs.renameSync(file, `${file}.old`);
    } catch {
      /* raced or gone; append still proceeds */
    }
    prevSeq = mirrorLastSeqDeep(`${file}.old`);
  } else {
    prevSeq = mirrorLastSeqOf(file);
    if (prevSeq === 0 && size > 0) prevSeq = mirrorLastSeqDeep(file); // oversized lines
  }
  const entry = { ts: new Date().toISOString(), session_id: sid, kind, text: text.slice(0, cap), seq: prevSeq + 1 };
  const line = JSON.stringify(entry) + "\n";
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.appendFileSync(file, line);
      return;
    } catch (err) {
      lastErr = err;
      const end = Date.now() + 20;
      while (Date.now() < end) {
        /* 20ms spin */
      }
    }
  }
  throw lastErr;
}

/** kind=assistant mirror entry from Stop stdin; always silent, never blocks. */
function recordMirrorIfEnabled(input, argv) {
  try {
    if (!mirrorOnOff(mirrorParseArg(argv, "--mirror"), true)) return;
    const raw = input.last_assistant_message ?? input.last_message ?? input.assistant_message;
    if (typeof raw !== "string" || !raw.trim()) return;
    const caps = mirrorMaxCharsPair(mirrorParseArg(argv, "--max-chars"), 2000, 4000);
    const maxBytesRaw = Number(String(mirrorParseArg(argv, "--max-bytes") || "").trim());
    const maxBytes =
      Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? Math.floor(maxBytesRaw) : MIRROR_MAX_BYTES;
    const sid = String(input.session_id || "anon").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
    const projectDir = process.env.ZCODE_PROJECT_DIR || process.cwd();
    const defaultRoot = path.join(projectDir, ".zcode", "orchestrator");
    let rootDir = defaultRoot;
    try {
      const pointer = path.join(defaultRoot, "root.txt");
      if (fs.existsSync(pointer)) {
        const custom = fs.readFileSync(pointer, "utf8").trim();
        if (custom) rootDir = custom;
      }
    } catch {
      /* fall through */
    }
    mirrorRecord(rootDir, sid, "assistant", raw, caps.assistant, maxBytes);
  } catch {
    /* silence: mirror recording must never block the stop flow */
  }
}

/* --- ack / suspected wake-failure helpers (verbatim twin of server.mjs) --- */

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
  const minutes = Number.isFinite(ms) ? Math.floor((Date.now() - ms) / 60000) : null;
  return { suspected: true, result_at: resultAt == null ? null : resultAt, minutes };
}

function fmtAge(min) {
  if (min == null || !Number.isFinite(min)) return "";
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟前`;
}

/* -------------------------------------------------------------------------- */

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function locateRoot(projectDir) {
  const defaultRoot = path.join(projectDir, ".zcode", "orchestrator");
  try {
    const pointer = path.join(defaultRoot, "root.txt");
    if (fs.existsSync(pointer)) {
      const custom = fs.readFileSync(pointer, "utf8").trim();
      if (custom) return custom;
    }
  } catch {
    /* fall through to default */
  }
  return defaultRoot;
}

function loadBoard(rootDir) {
  const file = path.join(rootDir, "board.json");
  if (!fs.existsSync(file)) return null;
  try {
    const board = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!board || typeof board !== "object" || Array.isArray(board)) return null;
    if (!Array.isArray(board.missions)) return null;
    return board;
  } catch {
    return null;
  }
}

function listUnreadPayloads(rootDir, missionId) {
  const dir = path.join(rootDir, "spool", missionId, "unread");
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of entries.filter((e) => e.endsWith(".json")).sort()) {
    let at = null;
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (payload && typeof payload.at === "string") at = payload.at;
    } catch {
      /* unreadable file still counts as unread */
    }
    out.push({ at });
  }
  return out;
}

function parseMs(iso) {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? t : null;
}

function silenceMinutes(mission, oldestAt) {
  const baseline = parseMs(oldestAt) ?? parseMs(mission.updated_at);
  if (baseline == null) return null;
  // B7: clock jumps must not produce negative silences.
  return Math.max(0, Math.floor((Date.now() - baseline) / 60000));
}

function main() {
  const input = readStdinJson();
  // v0.3: mirror recording happens before the stop_hook_active short-circuit so
  // even reminded stops leave an assistant-side journal entry (always silent).
  recordMirrorIfEnabled(input, process.argv.slice(2));
  // Already reminded once: let the coordinator finish (platform re-prompts at
  // most ~3 times; respecting stop_hook_active avoids fighting that limit).
  if (input.stop_hook_active === true) return;

  const projectDir = process.env.ZCODE_PROJECT_DIR || process.cwd();
  const rootDir = locateRoot(projectDir);
  const board = loadBoard(rootDir);
  if (!board) return;

  const open = board.missions.filter((m) => {
    if (!m || typeof m !== "object") return false;
    if (m.status === "closed") return false;
    const openStatus = OPEN_STATUSES.includes(m.status);
    // "Unanswered" only counts when a question was actually asked: fresh
    // missions default to blocked.answered === false without ever asking.
    const unanswered = Boolean(m.blocked && m.blocked.answered === false && m.blocked.question);
    // v0.2: terminal results (done/failed) are open until the coordinator
    // claims and closes them — this was a v0.1 blind spot.
    const terminal = m.status === "done" || m.status === "failed";
    return openStatus || unanswered || terminal;
  });
  let unreadTotal = 0;
  const oldestUnreadAt = new Map(); // mission_id -> ISO of oldest unread event
  for (const m of open) {
    const events = listUnreadPayloads(rootDir, m.id);
    unreadTotal += events.length;
    if (events.length) {
      const times = events.map((e) => parseMs(e.at)).filter((t) => t != null);
      if (times.length) {
        oldestUnreadAt.set(m.id, new Date(Math.min(...times)).toISOString());
      }
    }
  }
  if (!open.length && unreadTotal === 0) return;

  const isWakeFailure = (m) => wakeFailureInfo(m).suspected;
  const suspected = open.filter(isWakeFailure);
  const normal = open.filter((m) => !isWakeFailure(m));

  const suspectedDetails = [];
  for (const m of suspected.slice(0, 4)) {
    const w = wakeFailureInfo(m);
    const age = fmtAge(w.minutes);
    // Suspected blocked missions keep their pending question visible so the
    // coordinator can answer right away (additive to the v0.2 item format).
    const pending =
      m.blocked && m.blocked.answered === false && m.blocked.question
        ? ` 待答：『${String(m.blocked.question).replace(/\s+/g, " ").trim().slice(0, 40)}』`
        : "";
    suspectedDetails.push(
      `[${m.id}] ${m.status}${pending}` +
        (age ? ` 于 ${age}，未签收` : ` 未签收`),
    );
  }
  const normalDetails = [];
  for (const m of normal.slice(0, 4)) {
    let seg = `[${m.id}] ${m.status}`;
    if (m.blocked && m.blocked.answered === false && m.blocked.question) {
      seg += ` 待答：『${String(m.blocked.question).replace(/\s+/g, " ").trim().slice(0, 40)}』`;
    }
    const minutes = silenceMinutes(m, oldestUnreadAt.get(m.id));
    if (minutes != null && minutes >= 1) seg += ` 沉默 ${minutes} 分钟`;
    normalDetails.push(seg);
  }

  const text =
    `[agent-orchestrator] 收工前清点：任务板尚有 ${open.length} 项未竟` +
    `${suspected.length ? `，其中 ${suspected.length} 项疑似唤醒失败（${suspectedDetails.join("；")}）` : ""}` +
    `${normal.length ? `；其余 ${normal.length} 项：${normalDetails.join("；")}` : ""}` +
    `，邮箱 ${unreadTotal} 条未读。` +
    "疑似唤醒失败=子代理结果已落盘但主控未被唤醒接手：先 mailbox(read) 接手，" +
    '处置时 answer/close 自动签收；暂缓用 board(action="ack", mission_id=…, note="deferred by user")。' +
    "能答的答、能关的关。详见 /orch。";
  const clipped = text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS - 3) + "..." : text;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: clipped } }),
  );
}

try {
  main();
} catch {
  /* silence on any error */
}
process.exit(0);
