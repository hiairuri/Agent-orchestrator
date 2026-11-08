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
import os from "node:os";
import path from "node:path";

const MAX_OUTPUT_CHARS = 1500;
// v0.3.1 (C2): "resumed" joins the open set — a resumed mission whose worker
// died used to vanish from the stop-time accounting.
// v0.4 口径：ready（无人领取的池任务）不算未竟——不进 OPEN 集合，领取成功即 running 才计入。
const OPEN_STATUSES = ["dispatched", "running", "blocked", "question", "resumed"];
const RESULT_STATUSES = ["done", "failed", "blocked", "question"];

/* --- v0.6 (V6-57) 截断代理对回退（verbatim twin of session-start.mjs truncateStr）--- */
function truncateStr(value, max) {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  // 切点落在高位代理（emoji 等前半）则回退一位，避免产出孤立代理。
  const cut =
    max > 0 && s.charCodeAt(max - 1) >= 0xd800 && s.charCodeAt(max - 1) <= 0xdbff
      ? max - 1
      : max;
  return s.slice(0, cut);
}

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
    // v0.6 root-id 契约：第六处指针跟随（原内联镜像副本）收敛到本文件唯一 locateRoot——
    // 与主流程同过分代门（temp 拒绝 / v2 强校验 / v1 弱校验 / 失败回退告警），见下方同文实现。
    const rootDir = locateRoot(projectDir);
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
  const minutes = Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 60000)) : null;
  return { suspected: true, result_at: resultAt == null ? null : resultAt, minutes };
}

function fmtAge(min) {
  if (min == null || !Number.isFinite(min)) return "";
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)}h ${min % 60}m ago`;
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
   → 任一失败回退默认根 + stderr 告警一行。hooks 不删指针（删除职责全归 server 自愈）。
   本函数为各脚本内定根唯一副本（stop-check 主清点与镜像记录两条路径共用）。
   v1.1.1 (W20/W22) 祖先回退：默认根既无 board.json 也无 root-id（无指针/空指针/校验失败回退）时，
   自 projectDir 向上逐级找最近祖先目录，其 .zcode/orchestrator 同时存在 board.json 与 root-id
   即采用（stderr 一行告知解析根）；找不到则静默默认根。root.txt 指针优先级不变。
   v1.4 (F1 腿 B) board.json 存在性校验：指针目标自洽≠目标合法——采信前先验目标 board.json，
   目标缺而默认根有 → 回退默认根 + stderr 告警一行（混配=误配置 G1-4，本根优先）；默认根
   亦无 → 现行为不变（祖先回退链 W22-RC1..RC8 不动）。删除面对称腿=server 自愈（server-core）。 */
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

/** 祖先回退判定（v1.1.1 W20/W22；五处 twin 同文）：默认根自身合法（board.json 或 root-id 任一存在）
 *  → 默认根；否则自 projectDir 向上找最近祖先的 .zcode/orchestrator（须同时有 board.json 与
 *  root-id）。命中 → stderr 一行（含解析根路径）后采用；未命中 → 默认根（静默）。cwd 漂移防护。 */
function ancestorRoot(projectDir, defaultRoot) {
  try {
    if (
      fs.existsSync(path.join(defaultRoot, "board.json")) ||
      fs.existsSync(path.join(defaultRoot, "root-id"))
    ) {
      return defaultRoot; // 默认根合法（新项目即便还没板，只要有 root-id 也不回退）
    }
    let dir = path.dirname(path.resolve(projectDir));
    for (;;) {
      const candidate = path.join(dir, ".zcode", "orchestrator");
      if (
        fs.existsSync(path.join(candidate, "board.json")) &&
        fs.existsSync(path.join(candidate, "root-id"))
      ) {
        rootContractStderr("定根回退：采用祖先根 " + candidate);
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return defaultRoot; // 已到文件系统根仍无命中
      dir = parent;
    }
  } catch {
    return defaultRoot; // 任何意外 → 默认根（fail-open，不阻塞）
  }
}

/** 存储根发现：root.txt 指针优先，采信前过分代门 + board.json 存在性校验（F1 腿 B：目标
 *  缺板而默认根有板 → 回退默认根 + 告警）；无指针（或空指针）→ 默认根（先做祖先
 *  回退判定）；任一校验失败 → 回退默认根 + stderr 告警（同样做祖先回退判定）。不删指针。 */
function locateRoot(projectDir) {
  const defaultRoot = path.join(projectDir, ".zcode", "orchestrator");
  const fallbackRoot = () => ancestorRoot(projectDir, defaultRoot);
  try {
    const pointer = path.join(defaultRoot, "root.txt");
    if (!fs.existsSync(pointer)) return fallbackRoot();
    const lines = fs
      .readFileSync(pointer, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) return fallbackRoot(); // 空指针 ≈ 无指针
    const target = lines[0];
    if (isTempLikeDir(target)) {
      rootContractStderr("root.txt 指针未通过归属校验（目标位于临时目录），已回退默认根");
      return fallbackRoot();
    }
    let live = false;
    try {
      live = fs.statSync(target).isDirectory();
    } catch {
      live = false; // 悬空指针
    }
    if (!live) {
      rootContractStderr("root.txt 指针未通过归属校验（指针目标不存在或不是目录），已回退默认根");
      return fallbackRoot();
    }
    // v1.4 F1 腿 B（五处 twin 同文）：board.json 存在性校验——目标自洽≠目标合法（根唯一性
    // 仲裁删除面归 server 自愈腿，钩子侧只修根解析输入）。指针目标缺 board.json ∧ 默认根有
    // board.json → 回退默认根 + stderr 告警一行（劈叉失明面补告警；G1-4 混配=误配置非支持
    // 面，本根优先）。默认根亦无 board.json → 现行为（祖先回退链 W22-RC1..RC8 不动）。
    if (
      !fs.existsSync(path.join(target, "board.json")) &&
      fs.existsSync(path.join(defaultRoot, "board.json"))
    ) {
      rootContractStderr("[orch-root-contract] root.txt target lacks board.json; falling back to default root");
      return fallbackRoot();
    }
    const rid = rootIdOf(target);
    if (lines.length >= 2) {
      // v2 强校验：目标存活 ∧ root-id 存在 ∧ 内容 === 指针内嵌 id
      if (!rid) {
        rootContractStderr("root.txt 指针未通过归属校验（目标根缺少 root-id），已回退默认根");
        return fallbackRoot();
      }
      if (rid !== lines[1]) {
        rootContractStderr("root.txt 指针未通过归属校验（root-id 与指针内嵌 id 失配），已回退默认根");
        return fallbackRoot();
      }
      return target;
    }
    // v1 弱校验（v0.4.1–v0.5.1 旧格式兼容）：目标存活 ∧ root-id 存在即采信（值不比对）
    if (!rid) {
      rootContractStderr("root.txt 指针未通过归属校验（旧格式指针且目标根无 root-id），已回退默认根");
      return fallbackRoot();
    }
    rootContractStderr("root.txt 为旧格式指针（v1 弱校验已采信），重启 server 后自动升级");
    return target;
  } catch {
    return fallbackRoot(); // 任何意外 → 默认根（fail-open，不阻塞）
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
        ? ` pending answer: "${String(m.blocked.question).replace(/\s+/g, " ").trim().slice(0, 40)}"`
        : "";
    suspectedDetails.push(
      `[${m.id}] ${m.status}${pending}` +
        (age ? ` for ${age}, unclaimed` : ` unclaimed`),
    );
  }
  const normalDetails = [];
  for (const m of normal.slice(0, 4)) {
    let seg = `[${m.id}] ${m.status}`;
    if (m.blocked && m.blocked.answered === false && m.blocked.question) {
      seg += ` pending answer: "${String(m.blocked.question).replace(/\s+/g, " ").trim().slice(0, 40)}"`;
    }
    const minutes = silenceMinutes(m, oldestUnreadAt.get(m.id));
    if (minutes != null && minutes >= 1) seg += ` silent for ${minutes} min`;
    normalDetails.push(seg);
  }

  const text =
    `[agent-orchestrator] shutdown sweep: the board still has ${open.length} unfinished missions` +
    `${suspected.length ? `, of which ${suspected.length} are suspected wake failures (${suspectedDetails.join("; ")})` : ""}` +
    `${normal.length ? `; the other ${normal.length}: ${normalDetails.join("; ")}` : ""}` +
    `, mailbox ${unreadTotal} unread.` +
    " Suspected wake failure = the subagent result is on disk but the coordinator was never woken to take it over: take over via mailbox(read) first," +
    ' disposal auto-acks via answer/close; to defer use board(action="ack", mission_id=..., note="deferred by user").' +
    " disposal rules: see /orch.";
  const clipped = text.length > MAX_OUTPUT_CHARS ? truncateStr(text, MAX_OUTPUT_CHARS - 3) + "..." : text;
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
