// agent-orchestrator orch server — core：常量/小工具/root lock/存储根解析与 root.txt 桥（机械拆分自 server.mjs L95-723、L1289-1319；m-20261101-025258-fddf）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline";
import child_process from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "agent-orchestrator-orch";
const SERVER_VERSION = "1.6.2";
// v0.4.1: display path of the sentinel script (server suggests the refill
// command; forward slashes for copy-paste into Bash on Windows).
const SENTINEL_SCRIPT_DISPLAY = path
  .join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "bg-sentinel.mjs")
  .split(path.sep)
  .join("/");
const BOARD_VERSION = 2; // marker only; readers never validate this value
const PROTOCOL_VERSION_FALLBACK = "2024-11-05";
const PREFIX = "mcp__plugin_agent-orchestrator_orch__";
const REPORT = PREFIX + "report";
const KINDS = ["milestone", "blocked", "question", "done"];
const STATUSES = [
  "drafted",
  "dispatched",
  "running",
  "blocked",
  "question",
  "done",
  "failed",
  "skipped",
  "ready",
  "resumed",
  "closed",
];
// Dependency-graph semantics: closed counts as satisfied, skipped counts as a
// failure signal (cascades), everything else is pending.
const DEP_GREEN_STATUSES = ["done", "skipped", "closed"];

// v0.6 (V6-11, SM-01): green-closed marker — a `closed` upstream only counts as
// a satisfied dependency when the archive is backed by evidence: a passing
// review (the A3 qa struct {verdict:"pass", reviewed_by, reviewed_at}) or a
// sandbox apply marker (pack.sandbox.applied_at, written by sandbox_apply's
// direct board transaction). A bare closed upsert no longer acts as a universal
// green. This is the ACCEPTANCE side of the closed double gate; the WRITE side
// (close_confirmed + drafted禁直达) lives in the upsert transition gate.
function isGreenClosed(m) {
  if (!m || typeof m !== "object") return false;
  if (m.qa && typeof m.qa === "object" && m.qa.verdict === "pass") return true;
  const sb = m.pack && typeof m.pack === "object" ? m.pack.sandbox : null;
  return Boolean(sb && typeof sb === "object" && sb.applied_at);
}

// v0.6 (V6-11): single "is this upstream satisfied" predicate for both
// consumers of DEP_GREEN_STATUSES (sweepGraph unlock + claim dependency gate).
// done/skipped stay green as before; only closed demands the marker. A closed
// mission without one is still NOT failed (no cascade skip) — just pending.
function depSatisfied(d) {
  if (!d || !d.status || !DEP_GREEN_STATUSES.includes(d.status)) return false;
  return d.status !== "closed" || isGreenClosed(d);
}
// v0.5 §9.1 presentation caps (constants single-source): t1_head / question_head
// (board + resume). v1.1 W3: the mailbox read response presents details as a
// ≤160-char head + spool pointer (no cached long body; presentation cap retired).
const T1_HEAD_CAP = 160;
// v0.6 (V6-18, §2.7 single source): storage-side cap for report details —
// lands on the spool WRITE (the "no cap on the storage face" hole; the v0.5
// read-response presentation cap above stays). Over-cap writes are truncated
// and the response carries a truncation warn.
const DETAILS_MAX_CHARS = 4000;
// v0.6 (V6-08, §2.7 single source): apply intent freshness window (10min).
// A sandbox_apply whose pack.sandbox.apply_intent_at is younger than this and
// whose merge has not landed yet returns the structured busy response
// {ok:true, apply_in_progress:true} instead of double-running; the same window
// is the discard↔apply mutual exclusion (discard on a fresh intent is
// rejected). A window value must outlive the longest legal merge (60s git cap)
// plus board re-entry latency; 10min per DESIGN §2.7. A malformed/future
// intent timestamp reads as stale (the safe direction: gates re-run).
const APPLY_INTENT_FRESH_MS = 10 * 60 * 1000;
// v0.6 (V6-01, §2.7 single source): probe caps — SKILL §15.4 semantics verbatim,
// enforced server-side so the discipline stops depending on model goodwill.
// Single response: ≤50 rows AND ≤10KB of payload, paginate via page_token;
// binaries expose type/size/hash/first 256 bytes only; db queries carry
// LIMIT ≤100 (user clauses above the cap are rejected, pagination wraps at 50
// rows/page which satisfies ≤100 a fortiori).
const PROBE_MAX_ROWS = 50;
const PROBE_MAX_BYTES = 10 * 1024;
const PROBE_BIN_HEAD_BYTES = 256;
const PROBE_DB_MAX_LIMIT = 100;
const PROBE_DB_PAGE_ROWS = 50; // per-page engine LIMIT (≤ PROBE_DB_MAX_LIMIT)
const PROBE_QUERY_MAX_CHARS = 4000;
const PROBE_PATTERN_MAX_CHARS = 500;
const PROBE_MAX_LINE_CHARS = 2000; // per-line clip so one minified line cannot eat the 10KB budget alone
// sha256 covers the whole file up to this size; beyond it only the leading slice
// is hashed and hash_scope says so (unbounded whole-file hashing would turn a
// "probe" into a multi-GB read).
const PROBE_HASH_FULL_MAX = 32 * 1024 * 1024;
// text actions never load more than this much of a file per page (scan window);
// page_token continues past the window. Windows always cut at a line boundary.
const PROBE_SCAN_WINDOW = 1024 * 1024;
const PROBE_DB_TIMEOUT_MS = 10000;
// v0.7 (V7-01, W-A §2): session-level read cache for the file actions. Each
// cached envelope is already ≤10KB by the probe's own caps, so 64 entries
// bound the whole cache at ≤640KB — no second byte cap needed.
const PROBE_CACHE_MAX_ENTRIES = 64;
// v0.6 (V6-01): out-of-process SQLite reader for probe db.query. Runs as
// `node --input-type=module -e <script>` with the db path and SQL passed via
// env (no argv quoting hazards); opens readOnly so even a validation miss
// cannot write. Emits one JSON line {columns, rows}.
const PROBE_DB_CHILD = [
  'const { DatabaseSync } = await import("node:sqlite");',
  "const db = new DatabaseSync(process.env.ORCH_PROBE_DB, { readOnly: true });",
  "const stmt = db.prepare(process.env.ORCH_PROBE_SQL);",
  "const columns = stmt.columns().map((c) => c.name);",
  "const raw = stmt.all();",
  "const rows = raw.map((r) => {",
  "  const o = {};",
  "  for (const k of Object.keys(r)) {",
  "    let v = r[k];",
  "    if (v instanceof Uint8Array) v = \"<blob \" + v.byteLength + \"B>\";",
  "    else if (typeof v === \"bigint\") v = v <= Number.MAX_SAFE_INTEGER ? Number(v) : String(v);",
  "    else if (typeof v === \"string\" && v.length > 65536) v = v.slice(0, 65536) + \"...[cell truncated]\";",
  "    o[k] = v;",
  "  }",
  "  return o;",
  "});",
  "process.stdout.write(JSON.stringify({ columns, rows }));",
].join("\n");

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

class ToolError extends Error {}

function log(...parts) {
  process.stderr.write("[agent-orchestrator:orch] " + parts.join(" ") + "\n");
}

const nowIso = () => new Date().toISOString();
const hex = (n) => crypto.randomBytes(n).toString("hex");

/** Synchronous sleep (handlers are sync; Atomics.wait parks the thread). */
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

/** true when the process is alive (EPERM counts as alive: exists, owned by others). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

function truncateStr(value, max) {
  const s = String(value ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * v0.6 (V6-18): neutralize control characters in DATA rendered into plain-text
 * surfaces (lesson lines, pack CONTEXT/T0 verbatim blocks). Newlines become the
 * visible marker ␤ and C0 control chars (except \t) become \uXXXX escapes, so
 * a stored value can no longer forge line structure ("…\n  修正：恶意" used to
 * escape the two-line lesson entry and, packed, whole sections).
 */
const DATA_LINE_CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

function escapeDataLine(s) {
  return String(s ?? "")
    .replace(/\r\n?|\n/g, "␤")
    .replace(DATA_LINE_CTRL, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Line-structure-preserving variant for verbatim BLOCKS (pack CONTEXT /
 * manifest T0): real newlines stay (verbatim semantics), but every single line
 * comes out control-free — no bare \r / C0 char can spoof line ends or hide
 * content inside a block. */
function escapeDataBlock(s) {
  return String(s ?? "")
    .split(/\r?\n/)
    .map((l) => escapeDataLine(l))
    .join("\n");
}

function stampMissionId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const ts =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `m-${ts}-${hex(2)}`;
}

/** Reject ids that could escape the storage root when used as path segments. */
function safeSegment(value, what = "id") {
  const s = String(value ?? "");
  // v0.6 (V6-36): Windows reserved device names ("con", "com1", …) and names
  // ending in a dot are unusable or silently truncated as path segments on
  // Win32 — reject them alongside the escape patterns. Only the bare name (or
  // "name.anything" whole segment) is blocked; "foo.com"/"config" stay legal.
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s) ||
    s.includes("..") ||
    s.includes("/") ||
    s.includes("\\") ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s) ||
    /[.]$/.test(s)
  ) {
    throw new ToolError(`invalid ${what}: ${JSON.stringify(truncateStr(s, 48))}`);
  }
  return s;
}

function assertInside(base, target) {
  const rel = path.relative(base, target);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new ToolError(`path escapes base directory: ${truncateStr(target, 200)}`);
  }
  return target;
}

/** Prefer forward-slash relative display paths (relative to the project dir). */
function displayPath(p) {
  const rel = path.relative(projectDir, p);
  if (rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join("/");
  }
  return String(p);
}

/**
 * Atomic write: temp file + rename.
 *
 * v0.3.1 (A2): on Windows a rename over an existing or momentarily locked target
 * (a concurrent reader holding the file open) can fail. Failures are retried with
 * rename-only attempts first, so the "target missing" window basically never opens.
 * Only after >=3 failed renames do we unlink the target; the unlink is followed
 * immediately by a rename and a second-existence check, so an aborted sequence can
 * never silently leave no file behind.
 *
 * v0.6 (V6-48): the last-resort window ("old unlinked, new rename fails") used to
 * lose both generations. Now:
 *  - before dropping the target in the fallback, the current bytes are renamed
 *    to <target>.prev-<ts> (one generation kept, swept on the next write);
 *  - if even the final rename fails, tmp is NOT deleted — it is parked as
 *    <target>.recovered and the error is thrown; loadBoard restores a
 *    board.json.recovered before falling back to an empty board (V5-P2-5:
 *    "next access silently zeroes the board" is closed).
 */
function atomicWriteFileSync(target, data, base = root) {
  if (base) assertInside(base, target);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  // V6-48: sweep the previous fallback generation — this target exists and is
  // about to be replaced, so a retained <target>.prev-<ts> is stale. At most
  // one generation is ever kept. (Skipped when the target doesn't exist yet —
  // a prev can only exist if a previous target did.)
  if (fs.existsSync(target)) {
    try {
      const stem = path.basename(target);
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(stem + ".prev-")) {
          try {
            fs.rmSync(path.join(dir, f), { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        }
      }
    } catch {
      /* best effort */
    }
  }
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${hex(4)}.tmp`,
  );
  fs.writeFileSync(tmp, data);
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 4) sleepMs(20 * (attempt + 1));
    }
  }
  try {
    // V6-48: preserve one generation of the current target before dropping it.
    try {
      fs.renameSync(target, `${target}.prev-${Date.now()}`);
    } catch {
      /* target may already be gone — nothing to preserve */
    }
    try {
      fs.unlinkSync(target);
    } catch {
      /* target may already be gone */
    }
    fs.renameSync(tmp, target);
    if (!fs.existsSync(target)) {
      throw new Error(`atomic write lost target: ${target}`);
    }
  } catch (retryErr) {
    // V6-48: never silently drop the new bytes — park tmp as <target>.recovered
    // (loadBoard consumes it) instead of deleting it.
    try {
      fs.renameSync(tmp, target + ".recovered");
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing more we can do */
      }
    }
    throw retryErr ?? lastErr;
  }
}

/* ------------------------------------------------------------------ */
/* root lock (v0.3.1 A1)                                               */
/*                                                                     */
/* Every cross-process board/answers/lessons read-modify-write runs    */
/* inside withRootLock(). The lock is an mkdir: atomic on all OSes.    */
/* Holder info ({holder,pid,heartbeatAt}) lives in .lock/owner.json.   */
/* Normal holds are <2s; waits retry with 50-200ms backoff for ~2s and */
/* then fail with "存储忙，请重试". A lock whose pid is dead or whose    */
/* age exceeds 30s is treated as dead and taken over.                  */
/* ------------------------------------------------------------------ */

const ROOT_LOCK_STALE_MS = 30000;
const ROOT_LOCK_TIMEOUT_MS = 2000;
let rootLockDepth = 0;

const rootLockDir = () => path.join(root, ".lock");

function readLockOwner(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** A lock is stale when its holder pid is dead or its age exceeds 30s. */
function rootLockStale(dir) {
  const owner = readLockOwner(dir);
  if (owner && Number.isFinite(owner.pid) && pidAlive(owner.pid)) {
    const hb = Date.parse(String(owner.heartbeatAt ?? ""));
    let ageMs = Number.isFinite(hb) ? Date.now() - hb : NaN;
    if (!Number.isFinite(ageMs)) {
      try {
        ageMs = Date.now() - fs.statSync(path.join(dir, "owner.json")).mtimeMs;
      } catch {
        ageMs = Number.POSITIVE_INFINITY;
      }
    }
    return Math.max(0, ageMs) > ROOT_LOCK_STALE_MS; // B7: negative elapsed clamps to 0
  }
  if (owner) return true; // owner doc present but pid dead/invalid
  // No owner doc yet (writer crashed between mkdir and write, or mid-create):
  // treat as stale only when the directory itself is old.
  try {
    return Date.now() - fs.statSync(dir).mtimeMs > ROOT_LOCK_STALE_MS;
  } catch {
    return true; // dir vanished between mkdir and here: retry as free
  }
}

function acquireRootLock() {
  if (rootLockDepth > 0) {
    rootLockDepth += 1; // same-process re-entry (sync handlers only)
    return;
  }
  const dir = rootLockDir();
  const deadline = Date.now() + ROOT_LOCK_TIMEOUT_MS;
  let backoff = 50;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      // v0.6 (V6-33): a swallowed owner-doc write failure used to leave a
      // docless lock that was still claimed ("the mkdir is still ours"),
      // degrading staleness detection to raw directory age. Retry the wx
      // write 3x; if it still fails, undo THIS mkdir and go around the loop
      // as a failed acquire. We never claim a lock we cannot describe.
      const ownerDoc =
        JSON.stringify({ holder: `pid:${process.pid}`, pid: process.pid, heartbeatAt: nowIso() }) + "\n";
      let ownerWritten = false;
      for (let wxAttempt = 0; wxAttempt < 3; wxAttempt++) {
        try {
          fs.writeFileSync(path.join(dir, "owner.json"), ownerDoc, { flag: "wx" });
          ownerWritten = true;
          break;
        } catch {
          if (wxAttempt < 2) sleepMs(20);
        }
      }
      if (!ownerWritten) {
        try {
          fs.rmSync(dir, { recursive: true, force: true }); // undo our mkdir only
        } catch {
          /* best effort */
        }
        if (Date.now() >= deadline) {
          throw new ToolError("storage busy, please retry (root lock wait timed out)");
        }
        sleepMs(backoff + Math.floor(Math.random() * 50));
        backoff = Math.min(200, backoff + 50);
        continue;
      }
      rootLockDepth = 1;
      return;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      if (rootLockStale(dir)) {
        // Take over via rename: only one contender can win the rename, so two
        // simultaneous takers cannot both end up holding the fresh lock.
        const trash = `${dir}.stale.${process.pid}.${hex(4)}`;
        try {
          fs.renameSync(dir, trash);
        } catch {
          continue; // someone else took it first; re-evaluate
        }
        try {
          fs.mkdirSync(dir);
          fs.writeFileSync(
            path.join(dir, "owner.json"),
            JSON.stringify({
              holder: `pid:${process.pid}`,
              pid: process.pid,
              heartbeatAt: nowIso(),
              took_over: true,
            }) + "\n",
          );
        } catch {
          /* mkdir race: loop and re-evaluate */
        }
        try {
          fs.rmSync(trash, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        if (rootLockDepth === 0) {
          // Only count the lock as ours when our mkdir actually won the dir.
          const ours = readLockOwner(dir);
          if (ours && ours.pid === process.pid) {
            rootLockDepth = 1;
            return;
          }
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ToolError("storage busy, please retry (root lock wait timed out)");
      }
      sleepMs(backoff + Math.floor(Math.random() * 50));
      backoff = Math.min(200, backoff + 50);
    }
  }
}

function releaseRootLock() {
  if (rootLockDepth > 1) {
    rootLockDepth -= 1;
    return;
  }
  if (rootLockDepth <= 0) return;
  rootLockDepth = 0;
  const dir = rootLockDir();
  // v0.6 (V6-15): if another process stale-took-over our lock while we still
  // held depth (long git section), the on-disk owner doc now names THAT pid.
  // Deleting the directory would drop a live holder's lock — skip and warn.
  // A missing/unreadable owner doc keeps the legacy delete (conservative:
  // never leave lock residue behind, V6-33 guarantees fresh claims have docs).
  const owner = readLockOwner(dir);
  if (owner && Number.isFinite(owner.pid) && owner.pid !== process.pid) {
    console.error(
      `[orch] root lock now held by pid ${owner.pid}; release skipped (not owner)`,
    );
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Run fn() while holding the root lock (re-entrant within this process). */
function withRootLock(fn) {
  acquireRootLock();
  try {
    return fn();
  } finally {
    releaseRootLock();
  }
}

/* ------------------------------------------------------------------ */
/* storage root resolution                                             */
/* ------------------------------------------------------------------ */

const projectDir = process.cwd();
const defaultRoot = path.join(projectDir, ".zcode", "orchestrator");

function parseArgValue(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1] ?? "";
    if (argv[i].startsWith(flag + "=")) return argv[i].slice(flag.length + 1);
  }
  return undefined;
}

function resolveRoot() {
  let raw = parseArgValue(process.argv.slice(2), "--root");
  if (raw === undefined) raw = "";
  raw = String(raw).trim();
  // Empty / missing / unresolved template placeholders mean "not set".
  if (!raw || raw.startsWith("${")) return defaultRoot;
  return path.resolve(projectDir, raw);
}

const root = resolveRoot();
fs.mkdirSync(root, { recursive: true });

/* root-id identity + root.txt bridge (v0.6 V6-12 publish side; contract:
 *   DESIGN §3.1). The storage root carries a bare `root-id` file (16 hex +
 *   newline, persistent and stable — written once, never rotated). Custom
 *   roots (non-default, non-temp) publish a v2 two-line pointer in the
 *   default root (L1 = target path, L2 = root-id; unconditional rewrite).
 *   Running on the default root self-heals stale pointers instead:
 *   dangling / temp / missing target root-id / v2 id mismatch -> delete the
 *   pointer; a v1 pointer whose target DOES have a root-id is kept (that
 *   legacy server will upgrade the format on its own next start).
 *   Hooks validate pointers with the same contract (cluster B, root-contract
 *   matrix); the server itself never reads the pointer to locate its root. */
function isTempDirPath(p) {
  const tmp = path.resolve(os.tmpdir());
  const r = path.resolve(p);
  const rel = path.relative(tmp, r);
  return rel !== "" && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

function rootIdOf(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, "root-id"), "utf8");
    return /^[0-9a-f]{16}$/.test(raw.trim()) ? raw.trim() : null;
  } catch {
    return null;
  }
}

function ensureRootId() {
  const existing = rootIdOf(root);
  if (existing) return existing;
  const id = hex(8); // 16 hex chars
  atomicWriteFileSync(path.join(root, "root-id"), id + "\n", root);
  return id;
}
const rootId = ensureRootId();

const isTempRoot = isTempDirPath(root);
if (!isTempRoot && path.resolve(root) !== path.resolve(defaultRoot)) {
  fs.mkdirSync(defaultRoot, { recursive: true });
  // v2 pointer: L1 = target path, L2 = root-id. Rewritten unconditionally so
  // the id always matches the root that last ran here.
  atomicWriteFileSync(
    path.join(defaultRoot, "root.txt"),
    root + "\n" + rootId + "\n",
    defaultRoot,
  );
}
if (path.resolve(root) === path.resolve(defaultRoot)) {
  try {
    const pointer = path.join(defaultRoot, "root.txt");
    if (fs.existsSync(pointer)) {
      const lines = fs
        .readFileSync(pointer, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const target = lines[0] ?? "";
      const ptrId = lines.length > 1 ? lines[1] : null; // null = v1 format
      let remove = false;
      if (!target || !fs.existsSync(target)) remove = true; // dangling → self-heal
      else if (isTempDirPath(target)) remove = true; // test root must not stick
      else if (ptrId === null) remove = rootIdOf(target) === null; // v1: keep only when target upgraded
      else remove = rootIdOf(target) !== ptrId; // v2 id mismatch (or unreadable) → stale
      // v1.4 F1 删除腿（G1-4：默认根 server 与自定义根 server 混配=误配置非支持面，本根
      // 优先）：目标自洽≠目标合法——上面四腿全过（指针完好指向自定义根）而默认根
      // board.json 在 → 删指针（回归本根；钩子侧腿 B 同波把根解析输入修向默认根）。
      // 自愈语义从「指针完整性校验」升「根唯一性仲裁」。删除腿不触发=现行为。
      if (
        !remove &&
        target &&
        path.resolve(target) !== path.resolve(defaultRoot) &&
        fs.existsSync(path.join(defaultRoot, "board.json"))
      ) {
        remove = true;
      }
      if (remove) fs.unlinkSync(pointer);
    }
  } catch {
    /* best effort */
  }
}

/* v0.10 G5 (anchor trust-root trigger, server-start face): publish the
 * workspace half of the wake anchor when absent. EXP10-findings R4 showed the
 * file missing after an app restart (resume-only dual-write never ran in the
 * new process) which drove the watcher into the legacy workspaces[0] fallback
 * and ultimately let b2 self-heal hijack coord-session.txt. The server knows
 * projectDir (= cwd, .mcp.json pins it to ${ZCODE_PROJECT_DIR}) but not the
 * caller session id, so it fills only the workspace side. Never overwrites:
 * toolResume / SessionStart are the authoritative refresh faces; this is a
 * startup filler for the missing-file window. Only fills inside an EXISTING
 * sentinel/ dir — never creates that dir, so sentinel_health's "available"
 * signal (dir presence) keeps its exact pre-G5 semantics (l0 V13). Best
 * effort. */
try {
  if (fs.existsSync(path.join(root, "sentinel"))) {
    const anchorFile = path.join(root, "sentinel", "coord-workspace.txt");
    if (!fs.existsSync(anchorFile)) {
      atomicWriteFileSync(anchorFile, path.resolve(projectDir) + "\n", root);
    }
  }
} catch {
  /* best effort: anchor filler must never block server startup */
}
/**
 * F1 normalizePathList (v0.5): canonical form for path allowlists, shared by
 * all three call sites (sandbox write / context_pack parse / apply compare).
 * Array guard (non-array -> []) -> per-item String -> trim -> backslashes
 * unified to "/" -> post-trim empty entries dropped -> order preserved. No
 * dedup (prefix matching is idempotent) and no length cap (callers enforce
 * their own limits). Superset of the previous inline forms: it adds trim and
 * separator unification, and the empty-string filter now also covers the
 * write side (an empty entry would otherwise act as a match-all prefix).
 */
function normalizePathList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim().split("\\").join("/"))
    .filter((s) => s.length > 0);
}

/**
 * v0.6 (V6-10) single-source prefix cover predicate: entry covers p iff they
 * are identical or p lives under entry (separator-aware). The entry is
 * trailing-separator-normalized here (NOT in normalizePathList — the stored
 * scope form is pinned by A-v050 assertions M-02/CRV2-01/03/06), so "src/"
 * and "src" behave identically at every gate. The empty entry means
 * allow-all, explicitly: "" covers every path (documented SCOPE-04 semantics;
 * normalizePathList drops empty entries on write, so this only fires for
 * callers that bypass normalization). v1.3 WG G-c (O16): a trailing "/**"
 * glob suffix is absorbed as a registration convention — "<dir>/**" behaves
 * identically to the bare "<dir>" entry, and bare "**" is allow-all; the
 * bare-prefix relation itself is unchanged (V6-10 counter-example stays
 * green).
 */
function coversPath(entry, p) {
  let e = String(entry).replace(/\/+$/, "");
  // v1.3 WG G-c (O16 evidence-fixed): glob-suffix registration convention. A
  // scope entry ending in "/**" is read as its directory prefix — "<dir>/**"
  // covers exactly what the equivalent bare "<dir>" entry covers, because the
  // pure-prefix predicate could never absorb a glob suffix (gifted sample:
  // planning mission m-20261030-130452-0f17 registered
  // "designs/agent-orchestrator-v1.3-planning/**" and its own impl-plan.md
  // touch was flagged — both sides already pass F1, so the separators were
  // absorbed and the suffix was the root cause). The bare-prefix semantics is
  // NOT relaxed (V6-10 counter-example stays green: "designs" — and now also
  // "designs/**" — never covers "designs-evil/x", since the glob leg only
  // adds the subtree of <dir> itself). The bare "**" entry maps onto the
  // documented SCOPE-04 allow-all intent instead of silently covering
  // nothing.
  if (e === "**") return true;
  if (e.endsWith("/**")) e = e.slice(0, -3);
  return e === p || (e !== "" && p.startsWith(e + "/"));
}

export {
  SERVER_NAME,
  SERVER_VERSION,
  BOARD_VERSION,
  PROTOCOL_VERSION_FALLBACK,
  PREFIX,
  REPORT,
  KINDS,
  STATUSES,
  T1_HEAD_CAP,
  DETAILS_MAX_CHARS,
  APPLY_INTENT_FRESH_MS,
  ROOT_LOCK_STALE_MS,
  ROOT_LOCK_TIMEOUT_MS,
  SENTINEL_SCRIPT_DISPLAY,
  PROBE_MAX_ROWS,
  PROBE_MAX_BYTES,
  PROBE_BIN_HEAD_BYTES,
  PROBE_DB_MAX_LIMIT,
  PROBE_DB_PAGE_ROWS,
  PROBE_QUERY_MAX_CHARS,
  PROBE_PATTERN_MAX_CHARS,
  PROBE_MAX_LINE_CHARS,
  PROBE_HASH_FULL_MAX,
  PROBE_SCAN_WINDOW,
  PROBE_DB_TIMEOUT_MS,
  PROBE_CACHE_MAX_ENTRIES,
  PROBE_DB_CHILD,
  depSatisfied,
  ToolError,
  log,
  nowIso,
  hex,
  sleepMs,
  pidAlive,
  truncateStr,
  escapeDataLine,
  escapeDataBlock,
  stampMissionId,
  safeSegment,
  assertInside,
  displayPath,
  atomicWriteFileSync,
  withRootLock,
  parseArgValue,
  projectDir,
  root,
  rootId,
  isTempRoot,
  normalizePathList,
  coversPath,
};
