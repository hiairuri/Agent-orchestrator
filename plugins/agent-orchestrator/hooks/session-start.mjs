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
 * v0.10 G5 (anchor trust root trigger): every SessionStart republishes the
 * paired wake anchors <root>/sentinel/coord-session.txt (this session id) and
 * coord-workspace.txt (ZCODE_PROJECT_DIR) atomically, before the board check.
 * Rationale: resume-only dual-write left coord-workspace.txt missing after an
 * app restart (EXP10 R4), which made the watcher fall back to workspaces[0]
 * and let b2 self-heal hijack the session anchor. stdout/exit contract
 * unchanged (still silent when there is nothing to resume).
 *
 * Storage root discovery: <project>/.zcode/orchestrator/root.txt (pointer to a
 * custom root) if present, otherwise the default directory itself.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_OUTPUT_CHARS = 1500;
// v0.3.1 (C2): "resumed" joins the open set — a resumed mission whose worker
// died used to be missing from the resume briefing.
const OPEN_STATUSES = ["dispatched", "running", "blocked", "question", "resumed"];
const RESULT_STATUSES = ["done", "failed", "blocked", "question"];
const BRIEF_TOP_K = 3;
const BRIEF_MAX_CHARS = 300;

/* --- lessons digest（v0.8 起唯一副本：server.mjs 同名死码 topLessonsBrief 已删，
     v0.8-DESIGN §3.6；v0.6 V6-57 起本副本多做代理对回退） --- */

function truncateStr(value, max) {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  // v0.6 (V6-57): 切点落在高位代理（emoji 等前半）则回退一位，避免产出孤立代理。
  const cut =
    max > 0 && s.charCodeAt(max - 1) >= 0xd800 && s.charCodeAt(max - 1) <= 0xdbff
      ? max - 1
      : max;
  return s.slice(0, cut);
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
  // B7: clock jumps must not produce negative ages.
  const minutes = Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 60000)) : null;
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

/* --- root-id 契约校验定根（v0.6；verbatim twin：五脚本同文，行为由 tests/suites/root-contract.mjs
     矩阵锁定，零代码共享）---
   分代门：temp 拒绝（两代通用）→ v2 强校验（root-id 比对）/ v1 弱校验（存在即采信 + stderr 提示）
   → 任一失败回退默认根 + stderr 告警一行。hooks 不删指针（删除职责全归 server 自愈）。 */
function isTempLikeDir(p) {
  try {
    const tmp = path.resolve(os.tmpdir());
    const r = path.resolve(p);
    const rel = path.relative(tmp, r);
    return rel !== "" && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function rootIdOf(rootPath) {
  try {
    return fs.readFileSync(path.join(rootPath, "root-id"), "utf8").trim();
  } catch {
    return ""; // 无 root-id（≤v0.4.0 旧版 server 根 / 非存储目录）
  }
}

function rootContractStderr(msg) {
  try {
    process.stderr.write("[agent-orchestrator] " + msg + "\n");
  } catch {
    /* stderr 不可写也不阻塞 */
  }
}

/** 存储根发现：root.txt 指针优先，采信前过分代门；无指针（或空指针）→ 默认根静默；
 *  任一校验失败 → 回退默认根 + stderr 告警。不删指针。 */
function locateRoot(projectDir) {
  const defaultRoot = path.join(projectDir, ".zcode", "orchestrator");
  try {
    const pointer = path.join(defaultRoot, "root.txt");
    if (!fs.existsSync(pointer)) return defaultRoot;
    const lines = fs
      .readFileSync(pointer, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) return defaultRoot; // 空指针 ≈ 无指针（静默）
    const target = lines[0];
    if (isTempLikeDir(target)) {
      rootContractStderr("root.txt 指针未通过归属校验（目标位于临时目录），已回退默认根");
      return defaultRoot;
    }
    let live = false;
    try {
      live = fs.statSync(target).isDirectory();
    } catch {
      live = false; // 悬空指针
    }
    if (!live) {
      rootContractStderr("root.txt 指针未通过归属校验（指针目标不存在或不是目录），已回退默认根");
      return defaultRoot;
    }
    const rid = rootIdOf(target);
    if (lines.length >= 2) {
      // v2 强校验：目标存活 ∧ root-id 存在 ∧ 内容 === 指针内嵌 id
      if (!rid) {
        rootContractStderr("root.txt 指针未通过归属校验（目标根缺少 root-id），已回退默认根");
        return defaultRoot;
      }
      if (rid !== lines[1]) {
        rootContractStderr("root.txt 指针未通过归属校验（root-id 与指针内嵌 id 失配），已回退默认根");
        return defaultRoot;
      }
      return target;
    }
    // v1 弱校验（v0.4.1–v0.5.1 旧格式兼容）：目标存活 ∧ root-id 存在即采信（值不比对）
    if (!rid) {
      rootContractStderr("root.txt 指针未通过归属校验（旧格式指针且目标根无 root-id），已回退默认根");
      return defaultRoot;
    }
    rootContractStderr("root.txt 为旧格式指针（v1 弱校验已采信），重启 server 后自动升级");
    return target;
  } catch {
    return defaultRoot; // 任何意外 → 默认根（fail-open，不阻塞）
  }
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

/* --- v0.10 G5 锚互信根触发（session-start 面） -------------------------------
 * EXP10-findings R4：应用 12:31 重启后 coord-session.txt 在、coord-workspace.txt 缺失
 * （G4 的双写只挂在 resume 调用上，而 SessionStart 从不写锚）→ watcher 无锚盲取
 * workspaces[0] → b2 在错工作区建会话 → 回读刷新劫持 coord-session。
 * 修法：SessionStart 以自身 session_id + ZCODE_PROJECT_DIR 无条件重发布**成对**锚
 * （session+workspace 同源同刻，保持互信根一致；新启动的会话即最新唤醒目标）。
 * 写面纪律：best-effort 永不 fatal、原子 tmp+rename、不改变 hook 事件契约（stdin/stdout
 * 形状与退出码不变）。session_id 按 journal.mjs 同款字符集消毒（防路径/换行注入）。
 */
function safeSessionId(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 256);
}

function atomicWriteBestEffort(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch {
    /* best effort：锚写失败不阻塞会话启动 */
  }
}

function publishWakeAnchor(rootDir, projectDir, sessionId) {
  const sid = safeSessionId(sessionId);
  if (!sid) return;
  atomicWriteBestEffort(path.join(rootDir, "sentinel", "coord-session.txt"), sid + "\n");
  atomicWriteBestEffort(path.join(rootDir, "sentinel", "coord-workspace.txt"), path.resolve(projectDir) + "\n");
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
  // v0.10 G5：互信根触发先于板面判定——即使无板/无可恢复任务也要发布唤醒目标对
  // （watcher 无锚 fail-loud；锚缺失=唤醒链断点，见 publishWakeAnchor 注）。
  publishWakeAnchor(rootDir, projectDir, sessionId);
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
  if (text.length > MAX_OUTPUT_CHARS) text = truncateStr(text, MAX_OUTPUT_CHARS - 3) + "...";
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
