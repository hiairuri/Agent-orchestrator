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

/* --- v1.1 W4 (A1): orch-tail extraction → <root>/context/coord-tail.md (ORT-1..8) ---
   The coordinator emits a tail contract block at the end of its last assistant
   message each turn. Stop is the only hook that sees that message text, so the
   merged full state lives here (recovery source after compaction). Two shapes:
   full (all five business fields) and short (delta: flying +/-). The block is
   validated before any write; every rejection keeps the old file (fail-safe)
   and prints one stderr line (fail-loud). Sessions without a marker are a
   zero-write no-op (ORT-7). */
const COORD_TAIL_MARK = "<!-- orch-tail v1";
const COORD_TAIL_CLOSE = "-->";
const COORD_TAIL_FIELDS = ["ts", "seq", "project", "stage", "flying", "ruled", "next"];
const COORD_TAIL_FIELD_SET = new Set(COORD_TAIL_FIELDS);
const COORD_TAIL_CAPS = {
  full: { lines: 10, bytes: 900 },
  short: { lines: 6, bytes: 400 },
};

function coordTailWarn(msg) {
  try {
    process.stderr.write("[agent-orchestrator] coord-tail: " + msg + "\n");
  } catch {
    /* stderr 不可写也不阻塞 */
  }
}

/** Last complete block in the message (later quotes/echoes win, ORT-1). */
function coordTailLastBlock(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trimEnd() !== COORD_TAIL_MARK) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === COORD_TAIL_CLOSE) return { lines: lines.slice(i, j + 1) };
    }
    return { unterminated: true };
  }
  return null;
}

/** flying 值 → 条目数组（「无」/空 = 零条目；全形整表与短形 delta 共用）。 */
function coordTailFlyingItems(value) {
  const s = String(value ?? "").trim();
  if (!s || s === "无" || s === "（无）" || s === "-") return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function coordTailCapError(block, form) {
  const cap = COORD_TAIL_CAPS[form];
  const lines = block.lines.length;
  const bytes = Buffer.byteLength(block.lines.join("\n"), "utf8");
  if (lines > cap.lines) return `块超帽（${lines} 行 > ${cap.lines} 行），本轮不更新`;
  if (bytes > cap.bytes) return `块超帽（${bytes}B > ${cap.bytes}B），本轮不更新`;
  return null;
}

/** Parse one full/short block. Unknown/missing/duplicate fields reject the whole block. */
function coordTailParse(block) {
  if (!block || block.unterminated) return { error: "标记未闭合" };
  const body = block.lines.slice(1, -1);
  const fields = Object.create(null);
  for (const line of body) {
    const m = /^([a-z]+): (.+)$/.exec(line);
    if (!m) return { error: `坏行（须 field: value）：${String(line).slice(0, 40)}` };
    if (!COORD_TAIL_FIELD_SET.has(m[1])) return { error: `未知字段：${m[1]}（整块拒绝）` };
    if (Object.prototype.hasOwnProperty.call(fields, m[1])) return { error: `重复字段：${m[1]}` };
    fields[m[1]] = m[2].trim();
  }
  const hasFull = ["project", "stage", "ruled"].some((k) => Object.prototype.hasOwnProperty.call(fields, k));
  const required = hasFull ? COORD_TAIL_FIELDS : ["ts", "seq", "flying", "next"];
  for (const k of required) {
    if (!Object.prototype.hasOwnProperty.call(fields, k) || fields[k] === "") return { error: `缺字段：${k}` };
  }
  const seq = Number(fields.seq);
  if (!/^\d+$/.test(fields.seq) || !Number.isSafeInteger(seq)) return { error: `seq 非整数：${fields.seq}` };
  if (!Number.isFinite(Date.parse(fields.ts))) return { error: `ts 非 ISO8601：${fields.ts}` };
  const flyingItems = coordTailFlyingItems(fields.flying);
  if (flyingItems.length > 3) return { error: "flying 超过 3 条" };
  if (hasFull) {
    if (flyingItems.some((x) => /^[+-]/.test(x))) return { error: "全形 flying 必须是整表（禁 +/- 前缀）" };
    return { form: "full", fields, seq, flyingItems };
  }
  for (const token of flyingItems) {
    if (!/^[+-]\S+$/.test(token)) return { error: `短形 flying 必须 +id/-id：${token}` };
  }
  return { form: "short", fields, seq, flyingItems };
}

/** Old file is the merged full state (already canonical); corrupt/missing → null. */
function coordTailRead(file) {
  try {
    const parsed = coordTailParse(coordTailLastBlock(fs.readFileSync(file, "utf8")));
    if (parsed.error || parsed.form !== "full") return null;
    return parsed;
  } catch {
    return null;
  }
}

function coordTailRender(state) {
  return [
    COORD_TAIL_MARK,
    `ts: ${state.ts}`,
    `seq: ${state.seq}`,
    `project: ${state.project}`,
    `stage: ${state.stage}`,
    `flying: ${state.flying}`,
    `ruled: ${state.ruled}`,
    `next: ${state.next}`,
    COORD_TAIL_CLOSE,
  ].join("\n");
}

function coordTailMerge(prev, parsed) {
  if (!prev && parsed.form === "short") return { error: "缺全形基线，短形不立文件" };
  const prevSeq = prev ? Number(prev.fields.seq) : -1;
  if (prev && parsed.seq <= prevSeq) return { error: `seq 非递增（${parsed.seq} ≤ ${prevSeq}），本轮丢弃` };
  let state;
  if (parsed.form === "full") {
    state = {
      ts: parsed.fields.ts,
      seq: String(parsed.seq),
      project: parsed.fields.project,
      stage: parsed.fields.stage,
      flying: parsed.flyingItems.join(", ") || "无",
      ruled: parsed.fields.ruled,
      next: parsed.fields.next,
    };
  } else {
    // ORT-3/4:缺省字段=不变; flying 只应用 +/- 增删（-不存在的 id 忽略）。
    const flying = coordTailFlyingItems(prev.fields.flying);
    for (const token of parsed.flyingItems) {
      const id = token.slice(1);
      if (token[0] === "-") {
        const i = flying.indexOf(id);
        if (i >= 0) flying.splice(i, 1);
      } else if (!flying.includes(id)) {
        flying.push(id);
      }
    }
    if (flying.length > 3) return { error: "flying 合并后超过 3 条，本轮丢弃" };
    state = {
      ts: parsed.fields.ts,
      seq: String(parsed.seq),
      project: prev.fields.project,
      stage: prev.fields.stage,
      flying: flying.join(", ") || "无",
      ruled: prev.fields.ruled,
      next: parsed.fields.next,
    };
  }
  const text = coordTailRender(state);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > COORD_TAIL_CAPS.full.bytes) {
    return { error: `合并结果超帽（${bytes}B > ${COORD_TAIL_CAPS.full.bytes}B），本轮丢弃` };
  }
  return { text };
}

/** Atomic replace with mirrorRecord's best-effort retry shape (no lock). */
function coordTailWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.coord-tail-${process.pid}.tmp`);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(tmp, text, "utf8");
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      const end = Date.now() + 20;
      while (Date.now() < end) {
        /* 20ms spin（同 mirrorRecord 重试语义） */
      }
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* best effort */
  }
  throw lastErr;
}

/** Extract from Stop stdin; subagent sessions are skipped (B1③ same-type defense). */
function recordCoordTailIfEnabled(input) {
  try {
    if (String(input.session_id || "").startsWith("sess_subagent_")) return;
    const raw = input.last_assistant_message ?? input.last_message ?? input.assistant_message;
    if (typeof raw !== "string" || !raw.includes(COORD_TAIL_MARK)) return; // ORT-7 zero write
    const block = coordTailLastBlock(raw);
    if (!block) return;
    const parsed = coordTailParse(block);
    if (parsed.error) {
      coordTailWarn(`解析失败（${parsed.error}），本轮不更新`);
      return;
    }
    const capError = coordTailCapError(block, parsed.form);
    if (capError) {
      coordTailWarn(capError);
      return;
    }
    const projectDir = process.env.ZCODE_PROJECT_DIR || process.cwd();
    const rootDir = locateRoot(projectDir);
    const file = path.join(rootDir, "context", "coord-tail.md");
    const merged = coordTailMerge(coordTailRead(file), parsed);
    if (merged.error) {
      coordTailWarn(merged.error);
      return;
    }
    coordTailWrite(file, merged.text);
  } catch (err) {
    coordTailWarn(`写入失败（${err && err.message ? err.message : String(err)}），本轮不更新`);
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

/* --- root-id 契约校验定根（v0.6；verbatim twin：五脚本同文，行为由 tests/suites/root-contract.mjs
     矩阵锁定，零代码共享）---
   分代门：temp 拒绝（两代通用）→ v2 强校验（root-id 比对）/ v1 弱校验（存在即采信 + stderr 提示）
   → 任一失败回退默认根 + stderr 告警一行。hooks 不删指针（删除职责全归 server 自愈）。
   主清点与镜像记录两条路径共用本函数（第六处内联副本已收敛至此）。 */
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
  // v1.1 W4 (A1): coord-tail extraction follows the same pre-short-circuit order
  // (every Stop carries a last assistant message; no marker = zero write).
  recordCoordTailIfEnabled(input);
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
    "处置规则详见 /orch。";
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
