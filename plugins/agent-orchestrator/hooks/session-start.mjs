#!/usr/bin/env node
/**
 * agent-orchestrator SessionStart hook.
 *
 * stdin : JSON payload (hook_event_name, session_id, ...). ZCODE_PROJECT_DIR is in env.
 * stdout: nothing when there is nothing to resume; otherwise strict JSON
 *         {"additionalContext": "..."} (single line, <= 1500 chars).
 * exit  : always 0 (silence on any error; never blocks session start).
 *
 * v0.2: terminal missions (done/failed/blocked/question) whose result was never
 * claimed by the coordinator ("疑似唤醒失败") also re-enter the resume briefing,
 * flagged and with the result age appended; acked-deferred ones stay silent.
 *
 * v0.3: the briefing ends with a one-line lessons digest (global score top-3,
 * <= 300 chars; the whole line is dropped when over budget).
 *
 * Storage root discovery: <project>/.zcode/orchestrator/root.txt (pointer to a
 * custom root) if present, otherwise the default directory itself.
 */
import fs from "node:fs";
import path from "node:path";

const MAX_OUTPUT_CHARS = 1500;
const OPEN_STATUSES = ["dispatched", "running", "blocked", "question"];
const RESULT_STATUSES = ["done", "failed", "blocked", "question"];
const BRIEF_TOP_K = 3;
const BRIEF_MAX_CHARS = 300;

/* --- lessons digest (verbatim twin of server.mjs topLessonsBrief) --- */

function truncateStr(value, max) {
  const s = String(value ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

function loadLessons(rootDir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(rootDir, "memory", "lessons.jsonl"), "utf8");
  } catch {
    return [];
  }
  const list = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) list.push(obj);
    } catch {
      /* skip bad line */
    }
  }
  return list;
}

function lessonScore(l, now = Date.now()) {
  let conf = Number(l && l.confidence);
  if (!Number.isFinite(conf)) conf = 0;
  conf = Math.min(1, Math.max(0, conf));
  let hits = Number(l && l.hits);
  if (!Number.isFinite(hits) || hits < 1) hits = 1;
  const ts = Date.parse(String((l && l.updated_at) || ""));
  const days = Number.isFinite(ts) ? Math.max(0, (now - ts) / 86400000) : 0;
  return conf * (1 + Math.log(hits)) * Math.exp(-days / 30);
}

/** Global score top-3 active lessons as one line; "" when empty or over budget. */
function topLessonsBrief(rootDir) {
  const now = Date.now();
  const list = loadLessons(rootDir)
    .filter((l) => l && l.status === "active")
    .map((l) => ({ l, score: lessonScore(l, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, BRIEF_TOP_K);
  if (!list.length) return "";
  const body = list
    .map(({ l }) => `[${l.type}] ${truncateStr(String(l.trigger ?? ""), 40)}→${truncateStr(String(l.fix ?? ""), 60)}`)
    .join("；");
  const line = `相关教训：${body}。`;
  return line.length <= BRIEF_MAX_CHARS ? line : "";
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

function countUnread(rootDir, missionId) {
  try {
    return fs
      .readdirSync(path.join(rootDir, "spool", missionId, "unread"))
      .filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function main() {
  const input = readStdinJson();
  const projectDir = process.env.ZCODE_PROJECT_DIR || process.cwd();
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const rootDir = locateRoot(projectDir);
  const board = loadBoard(rootDir);
  if (!board) return;

  const isWakeFailure = (m) => wakeFailureInfo(m).suspected;
  const resumable = board.missions.filter((m) => {
    if (!m || typeof m !== "object") return false;
    if (m.status === "closed") return false;
    const open = OPEN_STATUSES.includes(m.status);
    // "Unanswered" only counts when a question was actually asked: fresh
    // missions default to blocked.answered === false without ever asking.
    const unanswered = Boolean(m.blocked && m.blocked.answered === false && m.blocked.question);
    // v0.2: terminal missions join only when their result looks unclaimed
    // (疑似唤醒失败); acked-deferred old dones do not disturb a new session.
    const unclaimedTerminal = RESULT_STATUSES.includes(m.status) && isWakeFailure(m);
    return open || unanswered || unclaimedTerminal;
  });
  if (!resumable.length) return;

  const lines = ["[agent-orchestrator] 检测到可恢复任务："];
  let totalUnread = 0;
  for (const m of resumable.slice(0, 8)) {
    const unread = countUnread(rootDir, m.id);
    totalUnread += unread;
    const seed = String(m.original_prompt || m.title || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    let line =
      `- [${m.id}] ${m.title || "(未命名)"}｜${m.status}｜${m.agent_type || "-"}` +
      `｜原任务：${seed ? seed + "…" : "（未记录）"}${unread ? `｜未读 ${unread} 条` : ""}`;
    if (isWakeFailure(m)) {
      const w = wakeFailureInfo(m);
      const age = fmtAge(w.minutes);
      line =
        `- 【疑似唤醒失败】${line.slice(2)}` +
        (age ? `｜${m.status} 于 ${age}，未签收` : `｜${m.status} 未签收`);
    }
    lines.push(line);
  }
  if (totalUnread > 0) lines.push(`未读邮箱事件 ${totalUnread} 条。`);
  // v0.3: one-line lessons digest; dropped entirely when over its own budget or
  // when it would push the briefing past the output cap.
  const lessonsLine = topLessonsBrief(rootDir);
  if (lessonsLine) {
    const projected = text0Length(lines) + 1 + lessonsLine.length;
    if (projected <= MAX_OUTPUT_CHARS) lines.push(lessonsLine);
  }
  lines.push(
    `本会话 session_id=${sessionId || "(未知)"}（派发时请记入 board）。` +
      "执行 /orch-resume 或调用 mcp__plugin_agent-orchestrator_orch__resume 获取接力计划。" +
      "终态未签收的结果先 mailbox(read) 接手再处置。",
  );

  let text = lines.join("\n");
  if (text.length > MAX_OUTPUT_CHARS) text = text.slice(0, MAX_OUTPUT_CHARS - 3) + "...";
  process.stdout.write(JSON.stringify({ additionalContext: text }));
}

function text0Length(lines) {
  return lines.join("\n").length;
}

try {
  main();
} catch {
  /* silence on any error: hooks must never block a session */
}
process.exit(0);
