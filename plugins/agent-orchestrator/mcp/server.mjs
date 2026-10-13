#!/usr/bin/env node
/**
 * agent-orchestrator MCP server ("orch").
 *
 * Transport: stdio, newline-delimited JSON-RPC 2.0 (one request/response per line).
 * Dependencies: none — Node.js >= 18 builtins only (fs / path / crypto / readline /
 * child_process). child_process (v0.4) is used EXCLUSIVELY to invoke the local git
 * CLI; every git operation is a local object-database operation and NO remote
 * argv (push/pull/fetch/clone/remote/submodule) may ever appear in this file.
 * Network: this process performs no network I/O of any kind; storage is local files.
 *
 * Session tool full names are prefixed with: mcp__plugin_agent-orchestrator_orch__
 *   board | report | mailbox | spawn_agent | context_pack | resume | lessons |
 *   sandbox_apply | sandbox_discard            (v0.4: 9 tools total)
 *
 * Storage layout (under the resolved root, default <project>/.zcode/orchestrator):
 *   board.json
 *   root.txt                     (pointer to a custom root, written for hook scripts)
 *   spool/<mission_id>/unread/<15-digit-zero-padded-epochMs>-<8hex>.json
 *   spool/<mission_id>/read/     (same names; consumed via rename)
 *   spool/<mission_id>/answers/<seq>-answer.json
 *   packs/<mission_id>/pack.md | pack-v1.md .. pack-vN.md
 *   sandboxes/<mission_id>/      (v0.4 git worktree sandboxes; removed by
 *                                 sandbox_apply / sandbox_discard only)
 *   archive/board-<ts>.json      (closed missions moved here by mailbox gc)
 *   memory/lessons.jsonl         (v0.3 learning memory: one lesson per line)
 *   context/journal-<sessionId>.jsonl  (v0.3 context mirror, written by hooks)
 *   sentinel.cfg.json            (v0.3 wake-sentinel config bridge, read-only here)
 *   sentinel.lock                (v0.3 sentinel lock, owned by bg-sentinel.mjs)
 *   .lock/owner.json             (v0.3.1 root lock: {holder,pid,heartbeatAt}; all
 *                                 board read-modify-write sections run under it)
 *
 * v0.3.1 hotfix (red-team findings):
 *   A1 mkdir-type root lock around every board/answers/lessons read-modify-write.
 *   A2 loadBoard re-reads a "missing" board 3x before accepting empty; save uses a
 *      rename-only retry loop (unlink only after >=3 failures, then rename + verify).
 *   A3 answers written with flag:"wx"; on conflict the sequence number increments.
 *   A4 lessons.jsonl merge writes run under the same root lock.
 *   B7 negative elapsed (clock jumps) clamps to 0.
 *   B9 mailbox(read) treats rename ENOENT as "already consumed".
 *   C1 report(blocked/question) resets blocked.answered/answer and clears stale ack.
 *   C3 answer: only blocked/question may flip status to dispatched; terminal states
 *      answer back isError.
 *   C4 gc archives stale unread events too; resume unread_total excludes closed.
 *   C5 report to a closed mission stores the event but leaves the board untouched.
 *   C6 closing with unread events / a pending question adds a warn to the response.
 *
 * v0.4.0 (sandbox dispatch / dependency graph / parallel-iteration playbook):
 *   - context_pack gains isolation/oob_allowlist/share_node_modules; isolation=
 *     "worktree" materializes a git worktree sandbox under <root>/sandboxes/<id>
 *     (branch orch/<mission_id>, pack path rewriting, SANDBOX section, optional
 *     node_modules junction) — git subprocesses run inside the root lock.
 *   - New tools sandbox_apply / sandbox_discard: gated merge-back (done + qa.
 *     verdict=pass + clean main repo + allowlist + merge-tree precheck) and
 *     zero-damage discard. Subagents see neither (MCP_DISALLOWED).
 *   - Dependency graph: mission.blockedBy/owner/claim/skippedReason, statuses
 *     "ready"/"skipped", fixpoint sweepGraph on every board write (unlock,
 *     cascade skip, lease回收, dangling cleanup), board action=claim (in-lock
 *     CAS + lease), report renews the lease and hints ready_to_claim.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import child_process from "node:child_process";

const SERVER_NAME = "agent-orchestrator-orch";
const SERVER_VERSION = "0.4.0";
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
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s) ||
    s.includes("..") ||
    s.includes("/") ||
    s.includes("\\")
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
 */
function atomicWriteFileSync(target, data, base = root) {
  if (base) assertInside(base, target);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
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
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
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
      try {
        fs.writeFileSync(
          path.join(dir, "owner.json"),
          JSON.stringify({ holder: `pid:${process.pid}`, pid: process.pid, heartbeatAt: nowIso() }) + "\n",
          { flag: "wx" },
        );
      } catch {
        /* owner doc raced; the mkdir is still ours */
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
        throw new ToolError("存储忙，请重试（root lock 等待超时）");
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
  try {
    fs.rmSync(rootLockDir(), { recursive: true, force: true });
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

// When an explicit custom root differs from the default, publish a pointer file
// under the default root so hook scripts can find the same storage.
if (path.resolve(root) !== path.resolve(defaultRoot)) {
  fs.mkdirSync(defaultRoot, { recursive: true });
  atomicWriteFileSync(path.join(defaultRoot, "root.txt"), root + "\n", defaultRoot);
}

/* ------------------------------------------------------------------ */
/* sentinel config bridge (v0.3 feature B)                             */
/* ------------------------------------------------------------------ */

/** Numeric argv option: empty / "${" template / invalid -> default, clamped. */
function numArg(argv, flag, def, min, max) {
  const raw = parseArgValue(argv, flag);
  const s = raw === undefined ? "" : String(raw).trim();
  if (s && !s.startsWith("${")) {
    const n = Number(s);
    if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
  }
  return def;
}

/**
 * v0.3: the server never spawns the sentinel; it only publishes the user's
 * wake-sentinel settings to <root>/sentinel.cfg.json so the separately started
 * bg-sentinel.mjs (host background Bash task) can pick them up. CLI > cfg file
 * > builtin defaults, resolved inside the sentinel itself.
 */
function writeSentinelCfg() {
  try {
    const argv = process.argv.slice(2);
    const cfg = {
      wake_timeout_min: numArg(argv, "--wake-timeout-min", 10, 1, 1440),
      wake_retries: Math.round(numArg(argv, "--wake-retries", 3, 1, 100)),
      wake_poll_sec: numArg(argv, "--poll-sec", 60, 1, 3600),
    };
    atomicWriteFileSync(path.join(root, "sentinel.cfg.json"), JSON.stringify(cfg, null, 2) + "\n");
  } catch (err) {
    log("sentinel.cfg.json write skipped: " + (err && err.message ? err.message : err));
  }
}
writeSentinelCfg();

/* ------------------------------------------------------------------ */
/* v0.4 startup parameters: sandbox default isolation + claim lease    */
/* ------------------------------------------------------------------ */

/** String argv option: empty / "${" template / unknown -> default. */
function strArg(argv, flag, def) {
  const raw = parseArgValue(argv, flag);
  const s = raw === undefined ? "" : String(raw).trim();
  if (!s || s.startsWith("${")) return def;
  return s;
}

// Only "worktree" opts in; everything else (${/empty/invalid) falls back to none.
const sandboxDefaultArg =
  strArg(process.argv.slice(2), "--sandbox-default", "none") === "worktree" ? "worktree" : "none";
// Lease minutes for board action=claim; report renewals use the same value.
const claimLeaseMinDefault = numArg(process.argv.slice(2), "--claim-lease-min", 30, 1, 1440);

/* ------------------------------------------------------------------ */
/* git subprocess block (v0.4 sandbox dispatch)                        */
/*                                                                     */
/* child_process is used EXCLUSIVELY for the local git CLI. Every git  */
/* operation below is a local object-database operation (branch /      */
/* worktree / merge-tree / merge / diff / status). REMOTE OPERATIONS   */
/* ARE FORBIDDEN: the argv words push/pull/fetch/clone/remote/submodule*/
/* must never appear in this file (statically asserted by SB9).        */
/* Git sections always run inside the caller's withRootLock critical   */
/* section (same lock as the board writes around them); the git call   */
/* itself is capped at 60s.                                            */
/* ------------------------------------------------------------------ */

const GIT_TIMEOUT_MS = 60000;
// merge-tree --write-tree was introduced in git 2.38; older git cannot precheck.
const GIT_MIN_MINOR_FOR_MERGE_TREE = 38;
let gitMergeTreeSupported = null; // process-level probe cache

/** The ONLY git exit in this codebase (sync, UTF-8, hard timeout). */
function gitRun(cwd, args, timeoutMs = GIT_TIMEOUT_MS) {
  return child_process.execFileSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs });
}

/** True when git exits 0 (output discarded). */
function gitOk(cwd, args) {
  try {
    gitRun(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** merge-tree precheck support probe (git >= 2.38), cached for the process. */
function assertMergeTreeSupport(cwd) {
  if (gitMergeTreeSupported != null) {
    if (!gitMergeTreeSupported) throwMergeTreeUnsupported();
    return;
  }
  let version = "";
  try {
    version = String(gitRun(cwd, ["--version"]));
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new ToolError("git 不可用：沙箱派发需要本机 git");
    }
    throw new ToolError("git --version 探测失败：" + (err && err.message ? err.message : err));
  }
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  gitMergeTreeSupported = Boolean(
    m &&
      (Number(m[1]) > 2 ||
        (Number(m[1]) === 2 && Number(m[2] || 0) >= GIT_MIN_MINOR_FOR_MERGE_TREE)),
  );
  if (!gitMergeTreeSupported) throwMergeTreeUnsupported(version.trim());
}

function throwMergeTreeUnsupported(version = "") {
  throw new ToolError(
    `git 版本过低${version ? "（" + version + "）" : ""}：merge-tree 冲突预检需要 git ≥ 2.38，` +
      "请升级本机 git 后再使用沙箱派发（其余特性不受影响）",
  );
}

function branchExists(cwd, branch) {
  return gitOk(cwd, ["rev-parse", "--verify", "--quiet", "refs/heads/" + branch]);
}

/** Parse `git worktree list --porcelain` into absolute path strings. */
function worktreeListPaths(cwd) {
  let out = "";
  try {
    out = String(gitRun(cwd, ["worktree", "list", "--porcelain"]));
  } catch {
    return [];
  }
  const paths = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(path.resolve(line.slice("worktree ".length).trim()));
  }
  return paths;
}

/** `git status --porcelain` output ("" when clean). */
function porcelainStatus(cwd) {
  return String(gitRun(cwd, ["status", "--porcelain"]));
}

/** `git diff --name-only <from>..<to>` as a trimmed line list. */
function listDiffNames(cwd, from, to) {
  return String(gitRun(cwd, ["diff", "--name-only", from + ".." + to]))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Extract the conflicted file list from `merge-tree --write-tree` output:
 * the first line is the tree oid; conflict messages follow
 * ("CONFLICT (content): Merge conflict in <path>"). Falls back to all
 * non-oid lines when nothing parses.
 */
function parseMergeTreeConflicts(output) {
  const lines = String(output ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const files = [];
  for (const line of lines.slice(1)) {
    const m = /^CONFLICT \([^)]*\):\s*.*?\s+in\s+(.+)$/.exec(line);
    if (m) files.push(m[1]);
  }
  if (!files.length) {
    for (const line of lines.slice(1)) if (!/^[0-9a-f]{40,64}$/.test(line)) files.push(line);
  }
  return [...new Set(files)];
}

/**
 * Prefix replacement rewrite: every occurrence of projectDir (backslash and
 * forward-slash forms) becomes the sandbox root in the matching form. Applied
 * to task/read_first/upstream_context/rules strings of sandboxed packs.
 */
function rewritePathStrings(value, projectDir, sandboxRoot) {
  let out = String(value ?? "");
  if (!out) return out;
  const projBk = path.resolve(projectDir);
  const projFw = projBk.split(path.sep).join("/");
  const sandBk = path.resolve(sandboxRoot);
  const sandFw = sandBk.split(path.sep).join("/");
  if (projBk !== sandBk) {
    out = out.split(projBk).join(sandBk);
    out = out.split(projFw).join(sandFw);
  }
  return out;
}

/** install-like heuristic (node_modules junction must NOT be shared then). */
function isInstallLikeTask(text) {
  return /npm\s+(install|i|ci)|pnpm\s+(add|install)|yarn\s+(add|install)|安装依赖|装依赖|node_modules/i.test(
    String(text ?? ""),
  );
}

const sandboxesRoot = () => path.join(root, "sandboxes");

/**
 * Materialize a git worktree sandbox for a mission (idempotent re-pack safe):
 * branch orch/<mission_id> at HEAD, worktree at <root>/sandboxes/<mission_id>,
 * optional node_modules junction, then the caller rewrites pack paths.
 * Runs inside the caller's root lock. Throws ToolError on every gate failure
 * (non-git project / empty repo / git missing / git too old).
 */
function materializeSandbox({ missionId, oobAllowlist, junctionShared: junctionDecision }) {
  assertMergeTreeSupport(projectDir);
  let inside = "";
  try {
    inside = String(gitRun(projectDir, ["rev-parse", "--is-inside-work-tree"])).trim();
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new ToolError("git 不可用：沙箱派发需要本机 git");
    }
    throw new ToolError('非 git 项目：写型隔离需要 git，请先 git init 并完成首次提交，或改用 isolation="none"');
  }
  if (inside !== "true") {
    throw new ToolError('非 git 项目：写型隔离需要 git，请先 git init 并完成首次提交，或改用 isolation="none"');
  }
  let baseCommit;
  try {
    baseCommit = String(gitRun(projectDir, ["rev-parse", "HEAD"])).trim();
  } catch {
    throw new ToolError("空仓库（无提交）：先 commit 再用沙箱派发");
  }
  try {
    gitRun(projectDir, ["worktree", "prune"]); // self-heal stale metadata before dispatch
  } catch {
    /* best effort */
  }
  const branch = "orch/" + missionId;
  const wtDir = path.join(sandboxesRoot(), missionId);
  assertInside(root, wtDir);
  fs.mkdirSync(path.dirname(wtDir), { recursive: true });
  const registered = worktreeListPaths(projectDir).includes(path.resolve(wtDir));
  if (branchExists(projectDir, branch) && registered) {
    // reuse: re-pack idempotency
  } else if (branchExists(projectDir, branch)) {
    gitRun(projectDir, ["worktree", "add", wtDir, branch]); // attach to existing branch
  } else {
    gitRun(projectDir, ["worktree", "add", "-b", branch, wtDir, baseCommit]);
  }
  // node_modules junction: same-directory second entry; never copied. Any
  // failure (e.g. cross-volume) silently degrades to junction_shared:false.
  let junctionShared = false;
  if (junctionDecision) {
    const projectNm = path.join(projectDir, "node_modules");
    const wtNm = path.join(wtDir, "node_modules");
    if (fs.existsSync(projectNm)) {
      if (fs.existsSync(wtNm)) {
        junctionShared = true; // already linked (re-pack)
      } else {
        try {
          fs.symlinkSync(projectNm, wtNm, "junction");
          junctionShared = true;
        } catch {
          junctionShared = false; // degrade, never fail the dispatch
        }
      }
    }
  }
  const at = nowIso();
  const sandbox = {
    isolation: "worktree",
    root: wtDir,
    branch,
    base_commit: baseCommit,
    junction_shared: junctionShared,
    oob_allowlist: Array.isArray(oobAllowlist) ? oobAllowlist.map(String) : [],
    created_at: at,
    applied_at: null,
    applied_commit: null,
    discarded_at: null,
  };
  upsertMission({
    id: missionId,
    pack: { sandbox },
    timeline: [
      { at, event: "sandbox:create", summary: `worktree ${displayPath(wtDir)}（分支 ${branch}，基于 ${baseCommit.slice(0, 10)}）` },
    ],
  });
  return sandbox;
}

/** SANDBOX section lines for buildPackMarkdown (design §1.3 step 9, verbatim). */
function buildSandboxLines({ sandboxRoot, branch, baseCommit, junctionShared }) {
  return [
    "## SANDBOX（沙箱环境——你的可写工作区）",
    `- 工作区：${sandboxRoot}（git worktree，分支 ${branch}，基于 ${baseCommit}）`,
    "- 本包 READ FIRST / CONTEXT / TASK 中出现的项目路径已改写为本工作区路径；若仍有未改写的原仓路径，到工作区内相同相对路径读取",
    `- 红线：绝不写原项目路径（${projectDir}）——写穿主仓会被主仓 status 巡检与 reviewer 越界审查检出，整单丢弃（sandbox_discard）`,
    `- node_modules：${junctionShared ? "junction 共享——只读使用，禁止 install/upgrade/delete（会写穿主仓）；需装依赖先删除该链接独立安装并在报告注明" : "未提供（本工作区无 node_modules）"}`,
    `- done 上报必附：git diff --stat ${baseCommit} 与 git diff --name-only ${baseCommit} 的输出各存一个文件，路径进 artifacts`,
  ];
}

/** Best-effort removal of a leftover node_modules junction (link only). */
function removeJunctionLink(wtDir) {
  try {
    fs.rmSync(path.join(wtDir, "node_modules"), { force: true, recursive: true });
  } catch {
    /* best effort */
  }
}

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
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟前`;
}

/** Decorated read-only view: ack/wake_failure are computed, never written back. */
function withComputed(m) {
  const w = wakeFailureInfo(m);
  return {
    ...m,
    ack: missionAck(m), // P2-1: 旧记录缺失 ack（undefined）归一为 null，JSON 序列化不丢键
    wake_failure: w.suspected ? { result_at: w.result_at, minutes: w.minutes } : null,
  };
}

/* ------------------------------------------------------------------ */
/* board.json                                                          */
/* ------------------------------------------------------------------ */

const boardFile = () => path.join(root, "board.json");

/**
 * v0.3.1 (A2): a "missing" board.json is re-checked 3 more times (50ms apart)
 * before an empty board is accepted. During the old unlink-then-rename fallback
 * there was a window where the file did not exist; a reader that mistook that
 * window for "no board yet" would later save an empty board over the real one.
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
  if (missing) return { version: 1, updated_at: nowIso(), missions: [] };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new ToolError("board.json unreadable: " + err.message);
  }
  if (!raw.trim()) return { version: 1, updated_at: nowIso(), missions: [] };
  let board;
  try {
    board = JSON.parse(raw);
  } catch (err) {
    throw new ToolError("board.json corrupted: " + err.message);
  }
  if (!board || typeof board !== "object" || Array.isArray(board)) {
    throw new ToolError("board.json corrupted: not an object");
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

function mergeMission(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "id") continue;
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
  merged.timeline = Array.isArray(merged.timeline) ? merged.timeline : [];
  const statusNote = prevStatus
    ? prevStatus === merged.status
      ? `status ${merged.status} (unchanged)`
      : `status ${prevStatus} → ${merged.status}`
    : `created (status ${merged.status})`;
  merged.timeline.push({ at: merged.updated_at, event: "upsert", summary: statusNote });
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
 * {unlocked, skipped, leaseExpired} for observability.
 *   - unlock: drafted + blockedBy all done/skipped/closed -> ready
 *   - cascade skip: drafted/ready + any upstream failed/skipped -> skipped
 *   - lease回收: running + claim.leaseUntil in the past -> ready (owner/claim cleared)
 *   - dangling: blockedBy entries pointing at missing missions are dropped once
 */
function sweepGraph(board, at) {
  const unlocked = [];
  const skipped = [];
  const leaseExpired = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of board.missions) {
      if (!m) continue;
      // 租约回收: an expired lease returns the mission to ready (no timer needed —
      // every write path sweeps, so the next touch after expiry recycles it).
      // Applies to every claimed running mission, blockedBy or not.
      if (m.status === "running" && m.claim && typeof m.claim === "object") {
        const until = Date.parse(String(m.claim.leaseUntil ?? ""));
        if (Number.isFinite(until) && until < Date.now()) {
          m.owner = null;
          m.claim = null;
          m.status = "ready";
          m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
          m.timeline.push({ at, event: "lease_expired", summary: "租约超时未续 → 回 ready 可再领取" });
          leaseExpired.push(m.id);
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
          m.blockedBy = m.blockedBy.filter((dep) => board.missions.some((x) => x && x.id === dep));
          delete m.danglingRefSince;
          m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
          m.timeline.push({ at, event: "dangling_dropped", summary: `清理悬挂依赖引用（${before - m.blockedBy.length} 项不存在）` });
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
          summary: "上游 " + failedDeps.map((d) => d.id).join(","),
        });
        skipped.push(m.id);
        changed = true;
        continue;
      }
      if (
        m.status === "drafted" &&
        deps.length &&
        deps.every((d) => d && DEP_GREEN_STATUSES.includes(d.status))
      ) {
        m.status = "ready";
        m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
        m.timeline.push({ at, event: "unlock", summary: "blockedBy 全绿 → ready 可领取" });
        unlocked.push(m.id);
        changed = true;
      }
    }
  }
  return { unlocked, skipped, leaseExpired };
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

/* ------------------------------------------------------------------ */
/* lessons store (v0.3 feature A: memory/lessons.jsonl)                */
/* ------------------------------------------------------------------ */

const LESSON_TYPES = ["error-fix", "pitfall", "preference", "env-fact"];
const LESSON_STATUSES = ["candidate", "active", "superseded", "retired"];
const RETIRE_SCORE = 0.1;
const INJECT_TOP_K = 6;
const INJECT_MAX_CHARS = 1200;
const BRIEF_TOP_K = 3;
const BRIEF_MAX_CHARS = 300;

const lessonsFile = () => path.join(root, "memory", "lessons.jsonl");

function newLessonId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  return `l-${day}-${hex(3)}`;
}

/** Merge-key normalization: case/whitespace/punctuation-insensitive. */
function normKey(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。，、；：！？"'（）[\]{}.,;:!?`]/g, "");
}

/** Read lessons.jsonl; bad lines are skipped (partial writes are not fatal). */
function loadLessons() {
  let raw;
  try {
    raw = fs.readFileSync(lessonsFile(), "utf8");
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

function saveLessons(list) {
  fs.mkdirSync(path.dirname(lessonsFile()), { recursive: true });
  atomicWriteFileSync(
    lessonsFile(),
    list.map((l) => JSON.stringify(l)).join("\n") + (list.length ? "\n" : ""),
  );
}

/**
 * score = confidence × (1 + ln(max(1, hits))) × exp(-days / 30); days since
 * updated_at. Invalid confidence/hits values are clamped defensively.
 */
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

/** Auto-retire active entries whose score decayed below RETIRE_SCORE. */
function housekeepLessons(list) {
  let changed = false;
  const now = Date.now();
  for (const l of list) {
    if (!l || typeof l !== "object" || l.status !== "active") continue;
    if (lessonScore(l, now) < RETIRE_SCORE) {
      l.status = "retired";
      l.note = "auto: low score";
      l.updated_at = nowIso();
      changed = true;
    }
  }
  return changed;
}

/** The active entry sharing entry's merge key (type + normalized trigger/fix). */
function findMergeTarget(list, entry) {
  const tk = normKey(entry.trigger);
  const fk = normKey(entry.fix);
  return list.find(
    (l) =>
      l &&
      typeof l === "object" &&
      l.status === "active" &&
      l.type === entry.type &&
      normKey(l.trigger) === tk &&
      normKey(l.fix) === fk,
  );
}

/** Merge an incoming lesson into an existing active entry (dedup by design). */
function mergeIntoTarget(target, sourceEntry, missionId) {
  target.hits = (Number(target.hits) || 0) + 1;
  target.confidence = Math.min(0.95, (Number(target.confidence) || 0) + 0.1);
  target.updated_at = nowIso();
  if (missionId && Array.isArray(target.refs) && !target.refs.includes(missionId)) {
    target.refs.push(missionId);
  } else if (missionId && !Array.isArray(target.refs)) {
    target.refs = [missionId];
  }
  void sourceEntry;
}

/* --- lesson text matching for context_pack injection (§2.3/§2.5) --- */

/** Lowercase tokens: ASCII words + CJK 2-gram sliding windows (single CJK char kept). */
function tokenize(text) {
  const s = String(text ?? "").toLowerCase();
  const out = new Set();
  for (const m of s.matchAll(/[a-z0-9_][a-z0-9_-]+/g)) out.add(m[0]);
  for (const m of s.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff]+/g)) {
    const seg = m[0];
    if (seg.length === 1) {
      out.add(seg);
      continue;
    }
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  }
  return out;
}

function lessonLine(l) {
  return `- [${l.type}] 触发：${l.trigger}\n  修正：${l.fix}`;
}

/**
 * Select active lessons whose trigger/lesson/fix share at least one token with
 * the given text; sorted by (overlap desc, score desc); rendered two-line
 * entries within the INJECT_TOP_K / INJECT_MAX_CHARS budget.
 */
function selectLessonsForText(text) {
  const taskTokens = tokenize(text);
  if (!taskTokens.size) return [];
  const now = Date.now();
  const list = loadLessons().filter((l) => l && l.status === "active");
  const scored = [];
  for (const l of list) {
    const lessonTokens = tokenize(`${l.trigger ?? ""}\n${l.lesson ?? ""}\n${l.fix ?? ""}`);
    let overlap = 0;
    for (const t of lessonTokens) if (taskTokens.has(t)) overlap += 1;
    if (overlap >= 1) scored.push({ l, overlap, score: lessonScore(l, now) });
  }
  scored.sort((a, b) => b.overlap - a.overlap || b.score - a.score);
  const lines = [];
  let used = 0;
  for (const { l } of scored.slice(0, INJECT_TOP_K)) {
    const entry = lessonLine(l);
    if (lines.length && used + entry.length + 1 > INJECT_MAX_CHARS) break;
    lines.push(entry);
    used += entry.length + 1;
  }
  return lines;
}

/** SessionStart briefing line: global score top-3, single line, <= 300 chars. */
function topLessonsBrief() {
  const now = Date.now();
  const list = loadLessons()
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

/* ------------------------------------------------------------------ */
/* tool: lessons                                                       */
/* ------------------------------------------------------------------ */

function toolLessons(args) {
  // v0.3.1 (A4): lessons.jsonl is read-merged-written; the whole tool runs under
  // the root lock so concurrent merges can no longer lose updates.
  return withRootLock(() => toolLessonsInner(args));
}

function toolLessonsInner(args) {
  const list = loadLessons();
  if (housekeepLessons(list)) saveLessons(list);

  const action = args.action ?? "list";

  if (action === "list") {
    let status = args.status == null ? "active" : String(args.status);
    let rows;
    if (status === "all") {
      rows = list.slice();
    } else {
      if (!LESSON_STATUSES.includes(status)) {
        throw new ToolError(
          `invalid status: ${JSON.stringify(status)}; allowed: ${LESSON_STATUSES.join(", ")}, all`,
        );
      }
      rows = list.filter((l) => l && l.status === status);
    }
    if (args.type != null) {
      if (!LESSON_TYPES.includes(args.type)) {
        throw new ToolError(
          `invalid type: ${JSON.stringify(args.type)}; allowed: ${LESSON_TYPES.join(", ")}`,
        );
      }
      rows = rows.filter((l) => l && l.type === args.type);
    }
    if (args.q != null && String(args.q).trim()) {
      const q = String(args.q).toLowerCase();
      rows = rows.filter(
        (l) =>
          l &&
          [l.trigger, l.lesson, l.fix].some(
            (f) => typeof f === "string" && f.toLowerCase().includes(q),
          ),
      );
    }
    const now = Date.now();
    const enriched = rows.map((l) => ({
      ...l,
      score: Number(lessonScore(l, now).toFixed(4)),
      age_days: Number(
        (Math.max(0, now - (Date.parse(String(l.updated_at || "")) || now)) / 86400000).toFixed(1),
      ),
    }));
    enriched.sort((a, b) => b.score - a.score);
    let limit = args.limit == null ? 8 : Math.floor(Number(args.limit));
    if (!Number.isFinite(limit) || limit < 1) limit = 1;
    return { total: enriched.length, lessons: enriched.slice(0, limit) };
  }

  if (action === "add") {
    if (args.type == null || !LESSON_TYPES.includes(args.type)) {
      throw new ToolError(
        `lessons add requires a valid type; allowed: ${LESSON_TYPES.join(", ")}`,
      );
    }
    const trigger = truncateStr(args.trigger, 120).trim();
    const fix = truncateStr(args.fix, 200).trim();
    if (!trigger || !fix) throw new ToolError("lessons add requires non-empty trigger and fix");
    const lesson = truncateStr(args.lesson ?? "", 200);
    const missionId = args.mission_id == null ? null : String(args.mission_id);

    const target = findMergeTarget(list, { type: args.type, trigger, fix });
    if (target) {
      mergeIntoTarget(target, null, missionId);
      saveLessons(list);
      return {
        ok: true,
        id: target.id,
        merged: true,
        confidence: Number(target.confidence.toFixed(2)),
        hits: target.hits,
      };
    }

    let supersededId = null;
    if (args.contradicts != null && String(args.contradicts).trim()) {
      const cid = String(args.contradicts).trim();
      const old = list.find((l) => l && l.id === cid);
      if (!old) throw new ToolError(`contradicts target not found: ${cid}`);
      if (old.status === "active") supersededId = cid;
      // contradicts on an already superseded/retired entry: ignored silently.
    }

    const at = nowIso();
    const entry = {
      v: 1,
      id: newLessonId(),
      ts: at,
      updated_at: at,
      mission_id: missionId,
      worker: "coordinator",
      type: args.type,
      trigger,
      lesson,
      fix,
      confidence: 0.6,
      hits: 1,
      status: "active",
      refs: missionId ? [missionId] : [],
      superseded_by: null,
      counter_refs: [],
      note: null,
    };
    if (supersededId) {
      const old = list.find((l) => l && l.id === supersededId);
      const at2 = nowIso();
      old.status = "superseded";
      old.superseded_by = entry.id;
      old.updated_at = at2;
      if (missionId) {
        old.counter_refs = Array.isArray(old.counter_refs) ? old.counter_refs : [];
        if (!old.counter_refs.includes(missionId)) old.counter_refs.push(missionId);
      }
    }
    list.push(entry);
    saveLessons(list);
    return supersededId
      ? { ok: true, id: entry.id, status: "active", merged: false, superseded: supersededId }
      : { ok: true, id: entry.id, status: "active", merged: false };
  }

  if (action === "promote") {
    if (args.id == null || !String(args.id).trim()) throw new ToolError('lessons promote requires "id"');
    const id = String(args.id).trim();
    const candidate = list.find((l) => l && l.id === id);
    if (!candidate) throw new ToolError(`lesson not found: ${id}`);
    if (candidate.status !== "candidate") {
      throw new ToolError(`not a candidate (status=${candidate.status})`);
    }
    // Optional refinement, same validation/truncation as add.
    const type = args.type == null ? candidate.type : args.type;
    if (!LESSON_TYPES.includes(type)) {
      throw new ToolError(`invalid type: ${JSON.stringify(args.type)}; allowed: ${LESSON_TYPES.join(", ")}`);
    }
    const trigger = args.trigger == null ? candidate.trigger : truncateStr(args.trigger, 120).trim();
    const fix = args.fix == null ? candidate.fix : truncateStr(args.fix, 200).trim();
    if (!trigger || !fix) throw new ToolError("refined trigger/fix must stay non-empty");
    const lesson = args.lesson == null ? candidate.lesson ?? "" : truncateStr(args.lesson, 200);
    // Prospective active view for merge-key matching (candidate itself excluded).
    const others = list.filter((l) => l && l.id !== id);
    const target = findMergeTarget(others, { type, trigger, fix });
    if (target) {
      mergeIntoTarget(target, candidate, candidate.mission_id ?? null);
      candidate.status = "retired";
      candidate.note = `auto: merged into ${target.id}`;
      candidate.updated_at = nowIso();
      saveLessons(list);
      return {
        ok: true,
        id: target.id,
        merged: true,
        candidate_id: id,
        confidence: Number(target.confidence.toFixed(2)),
        hits: target.hits,
      };
    }
    candidate.status = "active";
    candidate.type = type;
    candidate.trigger = trigger;
    candidate.fix = fix;
    candidate.lesson = lesson;
    candidate.confidence = 0.6;
    candidate.hits = 1;
    candidate.updated_at = nowIso();
    saveLessons(list);
    return { ok: true, id, status: "active", merged: false, confidence: 0.6, hits: 1 };
  }

  if (action === "retire") {
    if (args.id == null || !String(args.id).trim()) throw new ToolError('lessons retire requires "id"');
    const id = String(args.id).trim();
    const entry = list.find((l) => l && l.id === id);
    if (!entry) throw new ToolError(`lesson not found: ${id}`);
    entry.status = "retired";
    entry.note = args.reason == null ? null : truncateStr(args.reason, 200);
    entry.updated_at = nowIso();
    saveLessons(list);
    return { ok: true, id, status: "retired" };
  }

  throw new ToolError(
    `unknown lessons action: ${JSON.stringify(action)} (use list|add|promote|retire)`,
  );
}

/* ------------------------------------------------------------------ */
/* context mirror store (v0.3 feature C: context/journal-*.jsonl)      */
/* read-only here: the journal files are written by hooks/journal.mjs  */
/* and the Stop side of hooks/stop-check.mjs                           */
/* ------------------------------------------------------------------ */

const contextDir = () => path.join(root, "context");

/** [{file, session_id, mtimeMs}] sorted by mtime descending. */
function listJournalFiles() {
  let entries = [];
  try {
    entries = fs.readdirSync(contextDir());
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!/^journal-.+\.jsonl$/.test(name)) continue;
    const file = path.join(contextDir(), name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      out.push({
        file,
        session_id: name.slice("journal-".length, name.length - ".jsonl".length),
        mtimeMs: st.mtimeMs,
      });
    } catch {
      /* best effort */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Parse a journal file line by line; bad lines are skipped. */
function readJournalRows(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) rows.push(obj);
    } catch {
      /* skip bad line */
    }
  }
  return rows;
}

/** Last n entries of a journal file as {kind, excerpt<=160 single-line}. */
function readJournalTail(file, n) {
  return readJournalRows(file)
    .slice(-n)
    .map((r) => ({
      kind: typeof r.kind === "string" ? r.kind : "unknown",
      excerpt: truncateStr(String(r.text ?? "").replace(/\s+/g, " ").trim(), 160),
    }));
}

/**
 * RECENT CONTEXT digest lines from the given journal files (most recent first):
 * at most maxLines entries and maxChars total; caller renders verbatim.
 */
function buildMirrorDigest({ files, maxLines, maxChars }) {
  const lines = [];
  let used = 0;
  for (const f of files) {
    for (const tail of readJournalTail(f.file, maxLines)) {
      if (lines.length >= maxLines) return lines;
      const line = `- [${tail.kind}] ${tail.excerpt}`;
      if (!line.trim() || line === `- [${tail.kind}]`) continue;
      if (lines.length && used + line.length + 1 > maxChars) return lines;
      lines.push(line);
      used += line.length + 1;
    }
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* spool                                                               */
/* ------------------------------------------------------------------ */

function missionSpoolDir(missionId) {
  return path.join(root, "spool", safeSegment(missionId, "mission_id"));
}
const unreadDirOf = (missionId) => path.join(missionSpoolDir(missionId), "unread");
const readDirOf = (missionId) => path.join(missionSpoolDir(missionId), "read");

function listSpoolMissions() {
  const spool = path.join(root, "spool");
  let entries = [];
  try {
    entries = fs.readdirSync(spool);
  } catch {
    return [];
  }
  return entries.filter((name) => {
    try {
      return fs.statSync(path.join(spool, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

function listUnreadFiles(missionId) {
  const dir = unreadDirOf(missionId);
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(dir, f));
}

function readEventFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function countUnread(missionId) {
  return listUnreadFiles(missionId).length;
}

function eventAgeMs(payload) {
  const at = Date.parse(payload && payload.at ? String(payload.at) : "");
  if (Number.isFinite(at)) return Math.max(0, Date.now() - at);
  return 0;
}

/**
 * Consume one unread event via rename(unread -> read). If the destination name
 * is taken (Windows rename-onto-existing), retry with a "-1" suffix, then with
 * a random hex suffix.
 *
 * v0.3.1: a rename can report success while the source name is still visible
 * (cross-process metadata lag with concurrently open handles) — the move is
 * verified by re-checking the source afterwards; while it persists the same
 * destination is retried, and an event that cannot be moved verifiably is
 * reported via err.unresolved so the caller leaves it for the next read
 * instead of double-delivering it.
 */
function consumeEventFile(srcFile, missionId) {
  const dstDir = readDirOf(missionId);
  fs.mkdirSync(dstDir, { recursive: true });
  const base = path.basename(srcFile);
  const stem = base.replace(/\.json$/i, "");
  const candidates = [
    path.join(dstDir, base),
    path.join(dstDir, `${stem}-1.json`),
    path.join(dstDir, `${stem}-${hex(4)}.json`),
  ];
  let lastErr = null;
  for (const dst of candidates) {
    let moved = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.renameSync(srcFile, dst);
        moved = true;
        if (!fs.existsSync(srcFile)) return dst; // verifiably moved
      } catch (err) {
        lastErr = err;
        moved = false;
        break; // destination likely taken → next candidate
      }
    }
    if (moved) {
      // "Successful" renames yet the source is still visible: do not claim it.
      const err = new Error(`consume unresolved (src still visible): ${srcFile}`);
      err.unresolved = true;
      lastErr = err;
      continue;
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ */
/* tool: board                                                         */
/* ------------------------------------------------------------------ */

function toolBoard(args) {
  const action = args.action ?? "list";
  if (action === "upsert") {
    const patchRaw =
      args.mission && typeof args.mission === "object" && !Array.isArray(args.mission)
        ? args.mission
        : null;
    if (!patchRaw) throw new ToolError('board upsert requires "mission" object');
    // ack/owner/claim are read-only: ack is written by the ack action or the
    // auto-ack rules; owner/claim are owned by board claim / report renewal /
    // lease回收 (v0.4). All three are stripped from caller patches.
    const { ack: _ignored, owner: _ownerIgnored, claim: _claimIgnored, ...patch } = patchRaw;
    if (patch.status !== undefined && !STATUSES.includes(patch.status)) {
      throw new ToolError(
        `invalid status: ${JSON.stringify(patch.status)}; allowed: ${STATUSES.join(", ")}`,
      );
    }
    if (
      patch.model !== undefined &&
      patch.model !== null &&
      typeof patch.model !== "string"
    ) {
      throw new ToolError("mission.model must be a string or null");
    }
    if (patch.skippedReason !== undefined && patch.skippedReason !== null) {
      if (typeof patch.skippedReason !== "string") {
        throw new ToolError("mission.skippedReason must be a string or null");
      }
    }
    const mission = withRootLock(() => {
      // v0.4 (D3): reject dependency cycles BEFORE touching the board. An empty
      // array is an explicit clear and cannot cycle; a new mission with an
      // auto-generated id cannot reference itself either.
      if (patch.blockedBy !== undefined) {
        if (
          !Array.isArray(patch.blockedBy) ||
          patch.blockedBy.some((d) => typeof d !== "string" || !d.trim())
        ) {
          throw new ToolError("mission.blockedBy must be an array of mission ids");
        }
        if (patch.id != null) {
          const targetId = safeSegment(patch.id, "mission id");
          const cycle = detectCycle(loadBoard(), targetId, patch.blockedBy.map(String));
          if (cycle) {
            throw new ToolError(
              `blockedBy 构成环：<${[targetId, ...cycle].join(" → ")}>；依赖必须是 DAG（board 未改动）`,
            );
          }
        }
      }
      return upsertMission(patch); // v0.3.1 A1
    });
    const out = { ok: true, mission: withComputed(mission) };
    // v0.3.1 (C6): closing over an unread mailbox / pending question does not
    // block, but the coordinator must see it.
    if (mission.status === "closed") {
      const unreadLeft = countUnread(mission.id);
      const pendingQ = Boolean(
        mission.blocked && mission.blocked.answered === false && mission.blocked.question,
      );
      if (unreadLeft > 0 || pendingQ) {
        const parts = [];
        if (unreadLeft > 0) parts.push(`仍有 ${unreadLeft} 条未读事件`);
        if (pendingQ) parts.push("存在未答问题");
        out.warn = `关闭时${parts.join("且")}——已按关闭处理（不阻止）；如需处置先 mailbox(read, mission_id="${mission.id}")`;
      }
    }
    return out;
  }
  if (action === "ack") {
    if (args.mission_id == null) throw new ToolError('board ack requires "mission_id"');
    const id = safeSegment(args.mission_id, "mission_id");
    const note = args.note ? String(args.note).slice(0, 200) : null;
    const at = nowIso();
    const mission = withRootLock(() => {
      // v0.3.1 A1: the whole load→mutate→save section holds the root lock.
      const board = loadBoard();
      const m = findMission(board, id);
      if (!m) throw new ToolError(`mission not found: ${id}`);
      m.ack = { at, by: "coordinator", note };
      m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
      m.timeline.push({ at, event: "ack", summary: note || "ack" });
      m.updated_at = at;
      saveBoard(board);
      return m;
    });
    return withComputed(mission);
  }
  if (action === "get") {
    if (args.mission_id == null) throw new ToolError('board get requires "mission_id"');
    const id = safeSegment(args.mission_id, "mission_id");
    const mission = findMission(loadBoard(), id);
    if (!mission) throw new ToolError(`mission not found: ${id}`);
    return withComputed(mission);
  }
  if (action === "list") {
    const filter = Array.isArray(args.filter_status) ? args.filter_status.map(String) : null;
    let missions = loadBoard().missions.slice();
    if (filter) missions = missions.filter((m) => m && filter.includes(m.status));
    else missions = missions.filter((m) => m && m.status !== "closed");
    missions.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return { missions: missions.map(withComputed) };
  }
  if (action === "claim") {
    // v0.4 self-claiming (CAS): a pool worker claims a ready/drafted mission.
    // Conditions: owner===null (or missing) && status ∈ {drafted, ready} &&
    // blockedBy all green. Success flips to running + writes the lease. The
    // whole CAS runs inside the root lock, so cross-process races resolve to
    // exactly one winner.
    if (args.mission_id == null) throw new ToolError('board claim requires "mission_id"');
    const id = safeSegment(args.mission_id, "mission_id");
    const worker = String(args.worker ?? "").trim();
    if (!worker) throw new ToolError('board claim requires "worker"');
    let leaseMinutes = claimLeaseMinDefault;
    if (args.lease_minutes != null) {
      const n = Math.floor(Number(args.lease_minutes));
      if (!Number.isFinite(n) || n < 1) throw new ToolError("lease_minutes must be a number >= 1");
      leaseMinutes = n;
    }
    return withRootLock(() => {
      const board = loadBoard();
      sweepGraph(board, nowIso()); // recycle expired leases before the CAS reads state
      const m = findMission(board, id);
      if (!m) throw new ToolError(`mission not found: ${id}`);
      if (m.owner) {
        throw new ToolError(`已被领取（owner=${m.owner}）：不可重复领取`);
      }
      if (m.status !== "drafted" && m.status !== "ready") {
        throw new ToolError(`状态不可领取（status=${m.status}）：仅 drafted/ready 可 claim`);
      }
      const deps = Array.isArray(m.blockedBy) ? m.blockedBy : [];
      const pending = deps.filter((d) => {
        const dm = findMission(board, d);
        return !dm || !dm.status || !DEP_GREEN_STATUSES.includes(dm.status);
      });
      if (pending.length) {
        throw new ToolError(`依赖未就绪：blockedBy 未绿项 ${pending.join(", ")}`);
      }
      const at = nowIso();
      const token =
        m.dispatch && m.dispatch.token ? String(m.dispatch.token) : hex(4);
      const leaseUntil = new Date(Date.parse(at) + leaseMinutes * 60000).toISOString();
      m.owner = worker;
      m.claim = { worker, token, claimedAt: at, leaseUntil };
      m.status = "running";
      m.dispatch = m.dispatch && typeof m.dispatch === "object" ? m.dispatch : {};
      if (!m.dispatch.token) m.dispatch.token = token; // report 校验依赖它
      m.updated_at = at;
      m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
      m.timeline.push({ at, event: "claim", summary: `${worker} 领取（租约至 ${leaseUntil}）` });
      saveBoard(board);
      return {
        ok: true,
        mission_id: id,
        worker,
        token,
        pack_path: m.pack && m.pack.path ? m.pack.path : null,
        lease_until: leaseUntil,
        task: { title: m.title || "" },
        next_hint:
          "先 Read 任务包按 TASK/RULES 执行；期间每完成一步 report（自动续租）；完成后 report(kind=done)。",
      };
    });
  }
  throw new ToolError(`unknown board action: ${JSON.stringify(action)} (use upsert|get|list|ack|claim)`);
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

  // v0.3.1 (A1): spool write + board update + lessons append are one critical
  // section under the root lock.
  const outcome = withRootLock(() => {
    const board = loadBoard();
    const mission = findMission(board, missionId);
    if (!mission) throw new ToolError(`mission not found: ${missionId}`);
    const token = args.token == null ? null : String(args.token);
    const expectedToken =
      mission.dispatch && mission.dispatch.token ? String(mission.dispatch.token) : null;
    if (expectedToken && token && token !== expectedToken) {
      throw new ToolError(
        `report token mismatch for mission ${missionId}: refusing to record ` +
          `(check the [token] line of your dispatch prompt)`,
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
      details: args.details == null ? "" : String(args.details),
      artifacts: Array.isArray(args.artifacts) ? args.artifacts.map(String) : [],
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
        note: "mission 已 closed：事件已入邮箱存档，任务板未改动（closed 拒收改板类 report）",
        lessonsRecorded: 0,
        lessonsNote: "mission 已 closed，随附 lessons 未记录",
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
    // v0.4: any report from the (lease-holding) worker renews the claim lease
    // in the same critical section. A foreign worker still renews (design) but
    // gets a warn naming the actual holder.
    let claimWarn = null;
    const renewOpts = {};
    if (mission.claim && typeof mission.claim === "object") {
      renewOpts.renewClaim = {
        leaseUntil: new Date(Date.parse(at) + claimLeaseMinDefault * 60000).toISOString(),
      };
      if (mission.claim.worker && mission.claim.worker !== worker) {
        claimWarn = `该 mission 租约属于 ${mission.claim.worker}，请确认自己领的是这一项`;
      }
    }
    const updated = upsertMission(
      patch,
      kind === "blocked" || kind === "question" ? { clearAck: true, ...renewOpts } : renewOpts,
    );

    // v0.4: surface claimable work to pool workers (n>0 only).
    const readyToClaim = loadBoard().missions.filter(
      (x) => x && x.status === "ready" && !x.owner,
    ).length;

    // v0.3.1 (C5): a done report straight out of "drafted" is allowed but odd
    // enough to flag.
    const draftedWarn =
      mission.status === "drafted" && kind === "done"
        ? "drafted 状态直接收到 done（此前未见 dispatch 记录），请主控核对派发链路"
        : null;

    // lessons candidates: kind=done only; cap 3; entries missing trigger/fix skipped.
    let lessonsRecorded = 0;
    let lessonsNote = null;
    if (kind === "done" && Array.isArray(args.lessons) && args.lessons.length) {
      if (args.lessons.length > 3) lessonsNote = "lessons 超过 3 条，仅记录前 3 条";
      const list = loadLessons();
      for (const raw of args.lessons.slice(0, 3)) {
        if (!raw || typeof raw !== "object") continue;
        const trigger = truncateStr(raw.trigger, 120).trim();
        const fix = truncateStr(raw.fix, 200).trim();
        if (!trigger || !fix) {
          lessonsNote = lessonsNote ?? "存在缺少 trigger/fix 的 lesson，已跳过";
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
          lesson: truncateStr(raw.lesson ?? "", 200),
          fix,
          confidence: 0,
          hits: 0,
          status: "candidate",
          refs: [eventId],
          superseded_by: null,
          counter_refs: [],
          note: null,
        });
        lessonsRecorded += 1;
      }
      if (lessonsRecorded) saveLessons(list); // v0.3.1 (A4): under the root lock
    }

    return {
      closed: false,
      eventId,
      spoolPath,
      status: updated.status,
      draftedWarn,
      lessonsRecorded,
      lessonsNote,
      expectedToken,
      token,
      readyToClaim,
      claimWarn,
    };
  });

  const readyToClaimExtras =
    outcome.readyToClaim > 0
      ? {
          ready_to_claim: outcome.readyToClaim,
          hint_claim: `任务板有 ${outcome.readyToClaim} 项 ready 可领取：board(action="claim", mission_id=…, worker="<你的名字>")`,
        }
      : {};
  return {
    ok: true,
    event_id: outcome.eventId,
    spool_path: displayPath(outcome.spoolPath),
    status: outcome.status,
    hint:
      "主控会轮询邮箱消费本事件；只有紧急四情形（验收标准要变/继续无意义/需不可逆操作/阻塞超10分钟）" +
      "且 RespondToCoordinator 工具可用时才直达主控。",
    lessons_recorded: outcome.lessonsRecorded,
    ...(truncatedNote ? { note: truncatedNote } : {}),
    ...(outcome.closed && outcome.note && !truncatedNote ? { note: outcome.note } : {}),
    ...(outcome.lessonsNote ? { lessons_note: outcome.lessonsNote } : {}),
    ...(outcome.draftedWarn ? { warn: outcome.draftedWarn } : {}),
    ...(outcome.claimWarn ? { warn: outcome.claimWarn } : {}),
    ...(outcome.expectedToken && !outcome.token
      ? { warn: "未携带 token；下次上报请带上派发 prompt 的 [token] 行" }
      : {}),
    ...readyToClaimExtras,
  };
}

/* ------------------------------------------------------------------ */
/* tool: mailbox                                                       */
/* ------------------------------------------------------------------ */

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
          try {
            consumeEventFile(file, mid);
          } catch (err) {
            // v0.3.1 (B9): ENOENT on rename means a concurrent reader consumed
            // the event first — treat as consumed and move on instead of
            // erroring. "Unresolved" moves stay for the next read.
            if (err && (err.code === "ENOENT" || err.unresolved)) continue;
            throw err;
          }
          payloads.push(payload);
          if (payloads.length >= limit) break outer;
        }
      }
      payloads.sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
      return { consumed: payloads.length, events: payloads };
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
          `mission ${missionFilter} 已是终态（${mission.status}）：answer 拒绝执行（终态结果不可洗成在飞）。` +
            `请改用 board(action="ack", mission_id="${missionFilter}") 暂缓签收，或保持终态直接处置`,
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
      const updated = upsertMission(
        {
          id: missionFilter,
          ...(wasBlocked ? { status: "dispatched" } : {}), // C3: only blocked/question flip status
          blocked: { answer, answered: true, answered_at: at },
          timeline: [
            ...(Array.isArray(mission.timeline) ? mission.timeline : []),
            { at, event: "answer", summary: truncateStr(answer, 200) },
          ],
        },
        { ack: { by: "answer", note: "auto: answered" } },
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
            "\n\n请按以上答复继续执行任务包中的 TASK/RULES；完成后继续用 " +
            REPORT +
            " 汇报（kind=milestone/done；done 必带 artifacts 路径）。" +
            "若该答复引出新阻塞，再次 report(kind=blocked, question=…)。",
        },
        note:
          "运行中=steer；已终态=后台恢复续聊；跨会话/无 agentId=用 context_pack 重建后重新派发",
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

/* ------------------------------------------------------------------ */
/* tool: spawn_agent                                                   */
/* ------------------------------------------------------------------ */

const MCP_DISALLOWED = [
  PREFIX + "mailbox",
  PREFIX + "board",
  PREFIX + "spawn_agent",
  PREFIX + "context_pack",
  PREFIX + "resume",
  PREFIX + "lessons",
  PREFIX + "sandbox_apply",
  PREFIX + "sandbox_discard",
];

const ARCHETYPES = {
  worker: {
    color: "cyan",
    label: "执行型",
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", REPORT],
    extraDisallowed: [],
    duties: [
      "## 开工协议",
      "",
      "1. 先 Read 派发 prompt 指向的任务包文件；缺包/读不到 → 立即 report(kind=blocked, question=\"任务包缺失：<路径>\")，不要凭猜开工。",
      "2. 包内 READ FIRST 列出的文件先读；CONTEXT 节是上游产物逐字内容，视作既定事实。",
      "",
      "## 紧急四情形",
      "",
      "验收标准要变 / 继续做已无意义 / 需不可逆操作 / 阻塞超 10 分钟——且主控曾发来消息（RespondToCoordinator 工具出现时）→ 用 RespondToCoordinator 直达主控；否则一律走 report。",
    ].join("\n"),
  },
  scout: {
    color: "blue",
    label: "只读调研型",
    tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", REPORT],
    extraDisallowed: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"],
    duties: [
      "## 调研纪律",
      "",
      "- 结论必须带证据引用（path:line 或原文引用）；不跑命令（需要跑命令的调研请主控改派 worker 变体）。",
      "- 不修改任何文件；中期发现发 report(kind=milestone)，最终报告发 report(kind=done, details=结论全文, artifacts=引用清单或落盘报告路径)。",
    ].join("\n"),
  },
  reviewer: {
    color: "yellow",
    label: "评审型",
    tools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", REPORT],
    extraDisallowed: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
    duties: [
      "## 评审纪律",
      "",
      "- 逐条问题格式：{where, what, evidence, severity(low|medium|high)}；最后给总体 verdict。",
      "- 要求审批的评审要找\"会坏什么\"，不是问\"好不好\"；能跑的确定性检查必须真跑（Bash），没跑的标 unverified。",
      "- 绝不修改文件。",
    ].join("\n"),
  },
};

function escapeYamlDouble(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s*\n\s*/g, " ");
}

function renderPersonaFile({ name, description, archetypeKey, model, maxTurns, tools, disallowed, systemPrompt }) {
  const a = ARCHETYPES[archetypeKey];
  const fm = ["---"];
  fm.push(`name: ${name}`);
  fm.push(`description: "${escapeYamlDouble(description)}"`);
  fm.push(`color: ${a.color}`);
  if (model) fm.push(`model: ${model}`);
  if (Number.isFinite(maxTurns) && maxTurns > 0) fm.push(`maxTurns: ${Math.floor(maxTurns)}`);
  fm.push(`tools: [${tools.join(", ")}]`);
  fm.push(`disallowedTools: [${disallowed.join(", ")}]`);
  fm.push("---");

  const body = [];
  body.push(`# ${name}（${a.label}子代理）`);
  body.push("");
  body.push(
    `你是 ZCode 主控 agent 派发的${a.label}子代理。工作上下文来自主控派发的任务包；` +
      `上报一律走 ${REPORT} 工具。禁止与其他子代理互调（星型拓扑：只与主控通信）。`,
  );
  body.push("");
  body.push("## 协议（三行契约，出现在派发 prompt 头部与任务包 CONTRACT 节）");
  body.push("");
  body.push("```");
  body.push("[channel] <mission_id>");
  body.push(`[worker] <worker 名，如 ${name}#1>`);
  body.push("[token] <token>");
  body.push("```");
  body.push("");
  body.push(
    `进度与结果一律用 ${REPORT} 上报；kind ∈ {milestone, blocked, question, done}；` +
      "summary ≤ 200 字；done 必带 artifacts 路径（kind=blocked/question 时 question 必填）。",
  );
  body.push(
    "done 时如有可复用的踩坑/修复经验，可附 lessons（≤3 条，每条 {trigger, fix}），由主控签收时提炼晋升。",
  );
  body.push("");
  body.push("## 上报边界");
  body.push("");
  body.push("超出能力范围 / 目标矛盾 / 必败门禁 → 立即 report(kind=blocked, question=需要主控决策什么)，不硬扛不造假。");
  body.push("每完成一个可验收单元 → report(kind=milestone)；全部完成 → report(kind=done, artifacts=[产物路径...])。");
  body.push("");
  body.push(a.duties);
  body.push("");
  body.push("## 禁止");
  body.push("");
  body.push(`- Task / Skill / AskUserQuestion；邮箱消费类工具（${MCP_DISALLOWED.join("、")}）。`);
  body.push("- 与其他子代理互调；修改任务包范围外的文件。");
  body.push("");
  body.push("## Return（最终回复格式）");
  body.push("");
  body.push("- 做了什么（3–6 条）");
  body.push("- 产物/输出文件路径");
  body.push("- 遗留问题与建议");
  if (systemPrompt && systemPrompt.trim()) {
    body.push("");
    body.push("## 角色专述");
    body.push("");
    body.push(String(systemPrompt).trim());
  }
  return fm.join("\n") + "\n\n" + body.join("\n") + "\n";
}

function toolSpawnAgent(args) {
  const name = String(args.name ?? "");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new ToolError("spawn_agent name must match ^[a-z0-9][a-z0-9-]{0,63}$");
  }
  const description = String(args.description ?? "").trim();
  if (description.length < 10) {
    throw new ToolError("spawn_agent description must be at least 10 characters");
  }
  const archetypeKey = args.archetype == null ? "worker" : String(args.archetype);
  if (!ARCHETYPES[archetypeKey]) {
    throw new ToolError(
      `unknown archetype: ${JSON.stringify(archetypeKey)}; allowed: ${Object.keys(ARCHETYPES).join(", ")}`,
    );
  }
  // Sanitize: the model string is written verbatim into YAML frontmatter, so
  // newlines or colons could inject arbitrary keys. Reject anything outside the
  // plain-id shape instead of trying to escape it.
  let model = null;
  if (args.model != null && String(args.model).trim() !== "") {
    model = String(args.model).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._$\/-]*$/.test(model)) {
      throw new ToolError(
        `invalid model: ${JSON.stringify(truncateStr(model, 48))}; ` +
          `expected a plain model id like "my-provider/my-model" (optionally with a "$reasoningLevel" suffix, e.g. "GLM-5.3$high"); ` +
          `resolve the exact id via ListModels first`,
      );
    }
  }
  const maxTurns = args.max_turns == null ? null : Number(args.max_turns);

  const notes = [];
  let tools;
  if (Array.isArray(args.tools) && args.tools.length) {
    tools = args.tools.map(String);
    if (!tools.includes(REPORT)) {
      tools.push(REPORT);
      notes.push(`tools 已自动补上 ${REPORT}（上报通道必须保留）`);
    }
  } else {
    tools = ARCHETYPES[archetypeKey].tools.slice();
  }
  const disallowed = [
    "Task",
    "Skill",
    "AskUserQuestion",
    ...MCP_DISALLOWED,
    ...ARCHETYPES[archetypeKey].extraDisallowed,
  ].filter((t) => !tools.includes(t));

  const content = renderPersonaFile({
    name,
    description,
    archetypeKey,
    model,
    maxTurns,
    tools,
    disallowed,
    systemPrompt: args.system_prompt == null ? "" : String(args.system_prompt),
  });
  const target = path.join(projectDir, ".zcode", "agents", `${name}.md`);
  assertInside(projectDir, target);
  if (fs.existsSync(target) && !args.overwrite) {
    throw new ToolError(
      `${displayPath(target)} already exists; pass overwrite=true to replace it`,
    );
  }
  atomicWriteFileSync(target, content, projectDir);
  notes.push("项目级 agent 在新会话注册；当前会话请用 Agent(prompt=原型正文+system_prompt) 注入 persona 替代");
  return {
    path: displayPath(target),
    registered_as: name,
    archetype: archetypeKey,
    ...(model ? { model } : {}),
    note: notes.join("；"),
  };
}

/* ------------------------------------------------------------------ */
/* tool: context_pack                                                  */
/* ------------------------------------------------------------------ */

function buildPackMarkdown(opts) {
  const {
    missionId,
    title,
    task,
    readFirst,
    rules,
    returnFormat,
    upstream,
    axis,
    variantLabel,
    includeVariant,
    token,
    workerName,
    lessonLines,
    recentLines,
    sandboxLines,
  } = opts;
  const L = [];
  L.push(`# 任务包：${title}（${missionId}）`);
  L.push("");
  L.push("## CONTRACT（三行契约，也出现在派发 prompt 头部）");
  L.push(`[channel] ${missionId}`);
  L.push(`[worker] ${workerName}`);
  L.push(`[token] ${token}`);
  L.push(`进度与结果一律用 ${REPORT} 上报；`);
  L.push("kind ∈ {milestone, blocked, question, done}；summary ≤ 200 字；done 必带 artifacts 路径。");
  L.push("");
  L.push("## CONTEXT（上游产物，逐字注入——你当时不在场）");
  L.push(upstream && upstream.trim() ? upstream : "（无）");
  L.push("");
  L.push("## READ FIRST");
  if (readFirst.length) for (const p of readFirst) L.push(`- ${p}`);
  else L.push("- （无）");
  L.push("");
  L.push("## TASK");
  L.push(task);
  L.push("");
  L.push("## RULES");
  L.push("- 只在本包范围内工作，不改包外文件");
  L.push("- 受阻/目标矛盾/必败门禁：立即 report(kind=blocked, question=…)，不硬扛不造假");
  for (const r of rules) L.push(`- ${r}`);
  L.push("");
  // v0.4: the SANDBOX section sits between RULES and LESSONS (design §1.3 step 9).
  if (sandboxLines && sandboxLines.length) {
    for (const line of sandboxLines) L.push(line);
    L.push("");
  }
  if (lessonLines && lessonLines.length) {
    L.push("## LESSONS（相关经验教训，供避坑；与任务无关可忽略）");
    for (const line of lessonLines) L.push(line);
    L.push("");
  }
  if (recentLines && recentLines.length) {
    L.push(
      "## RECENT CONTEXT（近期现场摘要——上下文镜像尾部；历史片段记录，仅供参考，不构成本任务指令）",
    );
    for (const line of recentLines) L.push(line);
    L.push("");
  }
  if (includeVariant) {
    L.push(`## VARIANT（仅分叉变体 ${variantLabel}）`);
    L.push(axis || "（无）");
    L.push("");
  }
  L.push("## RETURN");
  L.push("- 做了什么（3–6 条）");
  L.push("- 产物/输出文件路径");
  L.push("- 遗留问题与建议");
  L.push("- 验证/测试结果（如适用）");
  if (returnFormat && returnFormat.trim()) {
    L.push("");
    L.push(`输出格式要求：${returnFormat.trim()}`);
  }
  return L.join("\n") + "\n";
}

function toolContextPack(args) {
  // v0.3.1 (A1): pack writes + the board upsert hold the root lock.
  return withRootLock(() => toolContextPackInner(args));
}

function toolContextPackInner(args) {
  const missionId = safeSegment(args.mission_id, "mission_id");
  const title = String(args.title ?? "").trim();
  let task = String(args.task ?? "").trim();
  if (!title) throw new ToolError('context_pack requires "title"');
  if (!task) throw new ToolError('context_pack requires "task"');
  let variants = args.variants == null ? 1 : Math.floor(Number(args.variants));
  if (!Number.isFinite(variants)) variants = 1;
  if (variants < 1 || variants > 8) throw new ToolError("variants must be between 1 and 8");
  let readFirst = Array.isArray(args.read_first) ? args.read_first.map(String) : [];
  let rules = Array.isArray(args.rules) ? args.rules.map(String) : [];
  const axes = Array.isArray(args.variant_axes) ? args.variant_axes.map(String) : [];
  let upstream = args.upstream_context == null ? "" : String(args.upstream_context);
  const returnFormat = args.return_format == null ? "" : String(args.return_format);

  // v0.4 sandbox dispatch parameters.
  const isolation =
    args.isolation != null ? String(args.isolation) : sandboxDefaultArg === "worktree" ? "worktree" : "none";
  if (isolation !== "worktree" && isolation !== "none") {
    throw new ToolError(
      'context_pack isolation must be "worktree" or "none" (缺省取 userConfig sandbox_default)',
    );
  }
  const oobAllowlist = Array.isArray(args.oob_allowlist)
    ? args.oob_allowlist.map(String).filter((s) => s.trim())
    : [];
  let sandboxInfo = null;
  let sandboxLines = null;
  let sandboxWarn = null;
  if (isolation === "worktree") {
    const installLike = isInstallLikeTask(title + "\n" + task);
    let junctionDecision;
    if (args.share_node_modules === true) {
      junctionDecision = true;
      if (installLike) {
        sandboxWarn = "安装类任务共享 junction 会写穿主仓 node_modules，已按你的要求创建，风险自担";
      }
    } else if (args.share_node_modules === false) {
      junctionDecision = false;
    } else {
      // auto: share only when the main repo has node_modules and the task does
      // not look like a dependency-install task (install would write through).
      junctionDecision =
        fs.existsSync(path.join(projectDir, "node_modules")) && !installLike;
    }
    sandboxInfo = materializeSandbox({ missionId, oobAllowlist, junctionShared: junctionDecision });
    // Path rewriting: project root -> sandbox root, both slash forms.
    const rewrite = (s) => rewritePathStrings(s, projectDir, sandboxInfo.root);
    task = rewrite(task);
    readFirst = readFirst.map(rewrite);
    rules = rules.map(rewrite);
    upstream = rewrite(upstream);
    sandboxLines = buildSandboxLines({
      sandboxRoot: sandboxInfo.root,
      branch: sandboxInfo.branch,
      baseCommit: sandboxInfo.base_commit,
      junctionShared: sandboxInfo.junction_shared,
    });
  }

  const existing = findMission(loadBoard(), missionId);
  const token =
    existing && existing.dispatch && existing.dispatch.token
      ? String(existing.dispatch.token)
      : hex(4);
  const workerBare =
    existing && typeof existing.agent_type === "string" && existing.agent_type.includes(":")
      ? existing.agent_type.split(":").pop()
      : "orch-worker";

  // v0.3 injections: keyword-matched lessons + optional mirror digest. Both are
  // computed once and shared across variant packs.
  const lessonLines = selectLessonsForText([title, task, ...readFirst].join("\n"));
  let recentLines = [];
  if (args.mirror_digest === true) {
    recentLines = buildMirrorDigest({
      files: listJournalFiles().slice(0, 2),
      maxLines: 6,
      maxChars: 1200,
    });
  }

  const packDir = path.join(root, "packs", missionId);
  assertInside(root, packDir);
  const packPaths = [];
  if (variants === 1) {
    const file = path.join(packDir, "pack.md");
    atomicWriteFileSync(
      file,
      buildPackMarkdown({
        missionId,
        title,
        task,
        readFirst,
        rules,
        returnFormat,
        upstream,
        axis: "",
        variantLabel: "",
        includeVariant: false,
        token,
        workerName: `${workerBare}#1`,
        lessonLines,
        recentLines,
        sandboxLines,
      }),
    );
    packPaths.push(file);
  } else {
    for (let k = 1; k <= variants; k++) {
      const file = path.join(packDir, `pack-v${k}.md`);
      atomicWriteFileSync(
        file,
        buildPackMarkdown({
          missionId,
          title,
          task,
          readFirst,
          rules,
          returnFormat,
          upstream,
          axis: axes[k - 1] || "（无）",
          variantLabel: `v${k}`,
          includeVariant: true,
          token,
          workerName: `${workerBare}#${k}`,
          lessonLines,
          recentLines,
          sandboxLines,
        }),
      );
      packPaths.push(file);
    }
  }

  upsertMission({
    id: missionId,
    ...(existing && existing.title ? {} : { title }),
    pack: { path: displayPath(packPaths[0]), variants: packPaths.map(displayPath) },
    dispatch: { token },
  });

  const promptFor = (packPath, workerName) =>
    [
      `[channel] ${missionId}`,
      `[worker] ${workerName}`,
      `[token] ${token}`,
      `You are working on: ${title}. 先 Read 任务包 ${displayPath(packPath)}，按包内 TASK/RULES 执行；` +
        `用 ${REPORT} 汇报（kind ∈ milestone/blocked/question/done）。Return：做了什么+产物路径+遗留问题。`,
    ].join("\n");

  const result = {
    pack_paths: packPaths.map(displayPath),
    token,
    channel: missionId,
    prompt_template: promptFor(packPaths[0], `${workerBare}#1`),
  };
  if (variants > 1) {
    result.prompt_templates = packPaths.map((p, i) => promptFor(p, `${workerBare}#${i + 1}`));
  }
  if (sandboxInfo) {
    result.sandbox = {
      root: displayPath(sandboxInfo.root),
      branch: sandboxInfo.branch,
      base_commit: sandboxInfo.base_commit,
      junction_shared: sandboxInfo.junction_shared,
    };
    if (sandboxWarn) result.warn = sandboxWarn;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* tools: sandbox_apply / sandbox_discard (v0.4)                       */
/*                                                                     */
/* Both run ENTIRELY inside withRootLock: the board reads/writes and   */
/* the git subprocess sections share one critical section (design      */
/* §1.4/§1.5). Git segments are capped at 60s; the root-lock stale     */
/* window (30s) is covered by single-coordinator + idempotent re-entry. */
/* ------------------------------------------------------------------ */

function toolSandboxApply(args) {
  return withRootLock(() => toolSandboxApplyInner(args));
}

function toolSandboxApplyInner(args) {
  const missionId = safeSegment(args.mission_id, "mission_id");
  const allowDirty = args.allow_dirty === true;
  const board = loadBoard();
  const m = findMission(board, missionId);
  if (!m) throw new ToolError(`mission not found: ${missionId}`);
  // 1. gates (single loadBoard).
  if (m.status !== "done") {
    throw new ToolError(`仅 done 状态可 apply，当前 ${m.status}`);
  }
  if (!(m.qa && typeof m.qa === "object" && m.qa.verdict === "pass")) {
    throw new ToolError(
      '缺少 pass 评审：先派 orch-reviewer 审 diff，再 board(upsert, mission={id, qa:{verdict:"pass",…}})',
    );
  }
  const sb = m.pack && m.pack.sandbox;
  if (!sb || sb.isolation !== "worktree") {
    throw new ToolError("该 mission 非沙箱派发");
  }
  if (sb.applied_at) {
    // Idempotent re-entry + compensation: a crash after the merge must still
    // end with the board closed.
    if (m.status !== "closed") {
      const at = nowIso();
      m.status = "closed";
      if (!missionAck(m)) m.ack = { at, by: "sandbox_apply", note: "auto: applied" };
      m.updated_at = at;
      saveBoard(board);
    }
    return {
      ok: true,
      already_applied: true,
      mission_id: missionId,
      applied_commit: sb.applied_commit ?? null,
      branch: sb.branch,
      status: m.status,
    };
  }
  assertMergeTreeSupport(projectDir);
  const wtDir = path.resolve(String(sb.root));
  const branch = String(sb.branch);
  const baseCommit = String(sb.base_commit ?? "");
  // 2. main-repo pollution gate (porcelain survey). allow_dirty is the manual
  // escape hatch; the qa gate has NO escape hatch.
  const porcelain = porcelainStatus(projectDir);
  if (porcelain.trim() && !allowDirty) {
    throw new ToolError(
      "主仓工作树不干净：可能是 worker 写穿污染（git checkout -- <paths> 可还原），" +
        "也可能是你自己的未提交改动——确认后 stash/提交/还原，或确认为己方改动时传 allow_dirty=true 重试\n" +
        porcelain.trim(),
    );
  }
  // 3. mechanical out-of-bounds detection (allowlist prefix match; empty =
  // everything allowed).
  const allow = Array.isArray(sb.oob_allowlist)
    ? sb.oob_allowlist.map(String).filter((s) => s.trim())
    : [];
  const changed = listDiffNames(projectDir, baseCommit, branch);
  const violations = allow.length
    ? changed.filter((p) => !allow.some((pre) => p === pre || p.startsWith(pre)))
    : [];
  if (violations.length) {
    throw new ToolError(
      `越界改动 ${violations.length} 项（不在 allowlist）：\n` +
        violations.join("\n") +
        "\n评审 verdict 应改为 fail（走 sandbox_discard 整单弃），或修订 oob_allowlist 后重审再 apply",
    );
  }
  // 4. conflict precheck: in-memory merge, never touches the working tree.
  try {
    gitRun(projectDir, ["merge-tree", "--write-tree", "HEAD", branch]);
  } catch (err) {
    if (err && err.status === 1) {
      const out = String(err.stdout || "");
      const conflictFiles = parseMergeTreeConflicts(out);
      throw new ToolError(
        "合并存在冲突，未触主仓。派合并代理 mission 处理：context_pack(mission_id=<新id>, task=\"把 " +
          branch +
          " 合入主线并解决冲突\", isolation=\"worktree\", read_first=[四件套文件…])；" +
          "四件套=merge-base(git merge-base HEAD <branch>) + 主线侧 diff(git diff <merge-base>..HEAD) + " +
          "分支侧 diff(git diff <merge-base>..<branch>) + 冲突文件内容(git show <rev>:<path> 两侧)。" +
          "解决后复审再 apply。\nconflict_files: " +
          JSON.stringify(conflictFiles),
      );
    }
    throw new ToolError(
      "merge-tree 冲突预检失败：" + (err && err.message ? err.message : err),
    );
  }
  // 5. clean merge (no-ff, fixed message) and capture the applied commit.
  gitRun(projectDir, ["merge", "--no-ff", "--no-edit", "-m", `orch: apply ${missionId}`, branch]);
  const appliedCommit = String(gitRun(projectDir, ["rev-parse", "HEAD"])).trim();
  // 6. worktree teardown (junction removed first so nothing can write through
  // it mid-teardown; rmSync on a junction unlinks the link, never the target).
  let worktreeRemoved = true;
  removeJunctionLink(wtDir);
  try {
    gitRun(projectDir, ["worktree", "remove", wtDir]);
  } catch {
    // git refuses to delete a dirty worktree (uncommitted leftovers) — never
    // --force here: unreviewed content must not be silently destroyed.
    worktreeRemoved = false;
    throw new ToolError(
      "沙箱内有未提交残留：内容不在任何 diff/commit 中，reviewer 未审；" +
        "确认不要则 sandbox_discard 强弃，或先在沙箱内提交并重走评审",
    );
  }
  removeJunctionLink(wtDir); // 补刀 in case worktree remove left the link
  // 7. board transaction (direct object mutation, same lock, not mergeMission):
  // closed + auto-ack + applied markers + timeline.
  const at = nowIso();
  m.status = "closed";
  m.ack = { at, by: "sandbox_apply", note: "auto: applied" };
  sb.applied_at = at;
  sb.applied_commit = appliedCommit;
  m.updated_at = at;
  m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
  m.timeline.push({
    at,
    event: "sandbox:apply",
    summary: `applied ${appliedCommit.slice(0, 10)}（merge ${branch} → 主线，worktree 已移除）`,
  });
  saveBoard(board);
  // 8. response.
  return {
    ok: true,
    mission_id: missionId,
    applied_commit: appliedCommit,
    branch,
    worktree_removed: worktreeRemoved,
    status: "closed",
    ack: m.ack,
  };
}

function toolSandboxDiscard(args) {
  return withRootLock(() => toolSandboxDiscardInner(args));
}

function toolSandboxDiscardInner(args) {
  const missionId = safeSegment(args.mission_id, "mission_id");
  const board = loadBoard();
  const m = findMission(board, missionId);
  if (!m) throw new ToolError(`mission not found: ${missionId}`);
  // 1. gate: sandbox record present (non-sandbox missions are never touched).
  const sb = m.pack && m.pack.sandbox;
  if (!sb || sb.isolation !== "worktree") {
    throw new ToolError("该 mission 无沙箱记录");
  }
  const wtDir = path.resolve(String(sb.root));
  const branch = String(sb.branch);
  assertMergeTreeSupport(projectDir);
  // 2. self-heal stale metadata, then force-remove the registered worktree
  // (discard semantics = abandon; --force here and ONLY here — the main repo
  // is untouched either way).
  try {
    gitRun(projectDir, ["worktree", "prune"]);
  } catch {
    /* best effort */
  }
  let worktreeRemoved = false;
  removeJunctionLink(wtDir);
  if (worktreeListPaths(projectDir).includes(wtDir)) {
    gitRun(projectDir, ["worktree", "remove", "--force", wtDir]);
    worktreeRemoved = true;
  } else if (fs.existsSync(wtDir)) {
    // Unregistered leftover directory: still sandbox-only storage.
    fs.rmSync(wtDir, { recursive: true, force: true });
    worktreeRemoved = true;
  }
  removeJunctionLink(wtDir);
  // 3. branch -D (missing branch is fine — idempotent).
  let branchDeleted = false;
  try {
    gitRun(projectDir, ["branch", "-D", branch]);
    branchDeleted = true;
  } catch {
    /* already gone */
  }
  // 4. board: discarded marker + timeline; status untouched (done stays done —
  // the coordinator decides close vs re-dispatch).
  const at = nowIso();
  sb.discarded_at = at;
  m.updated_at = at;
  m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
  m.timeline.push({ at, event: "sandbox:discard", summary: `弃 ${branch} 与 worktree（主仓零改动）` });
  saveBoard(board);
  // 5. response (idempotent: second call succeeds with false flags).
  return {
    ok: true,
    mission_id: missionId,
    branch_deleted: branchDeleted,
    worktree_removed: worktreeRemoved,
    note: "主仓零改动；mission 状态未变，可重派或 close",
  };
}



/* ------------------------------------------------------------------ */
/* tool: resume                                                        */
/* ------------------------------------------------------------------ */

function recommendedAction(m, unread, sessionId) {
  const d = m.dispatch || {};
  const out = [];
  const wake = wakeFailureInfo(m);
  if (wake.suspected) {
    // Must come first: an unclaimed terminal result outranks every other step.
    out.push({
      priority: 0,
      action:
        `疑似唤醒失败：mailbox(read, mission_id="${m.id}") 接手结果 → 处置（answer/close 自动签收）` +
        `或 board(action="ack", mission_id="${m.id}", note="deferred by user")`,
    });
  }
  const blockedOpen = m.blocked && m.blocked.answered === false && m.blocked.question;
  if (blockedOpen) {
    out.push({
      priority: 0,
      action:
        `mailbox(read, mission_id="${m.id}") → mailbox(answer) → ` +
        `SendMessage(to=${d.agent_id || "新派发"})；跨会话/无 agentId 则 context_pack 重建后重派`,
    });
  }
  if (unread > 0) {
    out.push({
      priority: 1,
      action: `mailbox(read, mission_id="${m.id}") 消费 ${unread} 条未读事件`,
    });
  }
  if (m.status === "done") {
    out.push({
      priority: 1,
      action: `聚合产物 → board(upsert, mission={id:"${m.id}", status:"closed"})`,
    });
  }
  if (d.mode === "workflow" && d.run_id) {
    const state = m.workflow_state || (m.status === "failed" ? "errored" : "");
    if (state === "stopped") {
      out.push({ priority: 2, action: `ResumeWorkflowRun(run_id="${d.run_id}")` });
    } else if (state === "errored") {
      out.push({
        priority: 2,
        action: `AmendWorkflow(run_id="${d.run_id}", path=<由 GetWorkflowRun 得到的脚本文件路径>)，勿 CreateWorkflow 重写`,
      });
    } else {
      out.push({
        priority: 4,
        action: `GetWorkflowRun(run_id="${d.run_id}") 查询状态与 pendingQuestions`,
      });
    }
  } else if (d.mode === "agent") {
    const terminal = m.status === "done" || m.status === "failed";
    const sameSession = Boolean(d.session_id && sessionId && d.session_id === sessionId);
    if (terminal && sameSession && d.agent_id) {
      out.push({
        priority: 3,
        action: `SendMessage(to="${d.agent_id}", summary=…, message=…) 恢复续聊`,
      });
    } else if (terminal) {
      out.push({
        priority: 2,
        action: "跨会话恢复：context_pack 重建上下文 + 同类型角色重新派发（agentId 跨会话无效）",
      });
    } else if (sameSession) {
      out.push({
        priority: 5,
        action: d.agent_id
          ? `任务在飞：等完成通知；最老事件 >15 分钟则 SendMessage(to="${d.agent_id}") 询问进度`
          : "任务在飞：等待完成通知；若从未收到，用 TaskOutput(task_id) 或 ListWorkflowRuns 兜底",
      });
    } else {
      // In-flight but dispatched from another (or unknown) session: that task
      // died with its session, so rebuild and re-dispatch instead of waiting.
      out.push({
        priority: 2,
        action: "跨会话恢复：context_pack 重建上下文 + 同类型角色重新派发（agentId/后台任务跨会话无效）",
      });
    }
  } else if (m.status === "drafted") {
    out.push({
      priority: 2,
      action: `drafted 未派发：context_pack 生成任务包后 Agent(run_in_background=true) 派发，再 board(upsert) 记 dispatch`,
    });
  }
  // v0.4 dependency-graph branches: an unclaimed ready mission is nobody's
  // emergency (pool semantics); skipped is a terminal cascade outcome.
  if (m.status === "ready" && !m.owner) {
    out.push({
      priority: 9,
      action: "等待自领取或手动派发（第 18 章）：派池工 board(action=\"claim\")，或 board(upsert status=\"dispatched\") 走普通派发",
    });
  }
  if (m.status === "skipped") {
    out.push({
      priority: 2,
      action: `上游失败被跳过：复核后 board(upsert, mission={id:"${m.id}", status:"closed"}) 归档，或修订 blockedBy 后重置为 drafted 重规划`,
    });
  }
  if (!out.length) out.push({ priority: 9, action: "无需动作" });
  out.sort((a, b) => a.priority - b.priority);
  return { primary: out[0].action, actions: out };
}

function toolResume(args) {
  const sessionId = String(args.session_id ?? "");
  const board = loadBoard();
  const openMissions = board.missions.filter((m) => m && m.status !== "closed");
  const missionsOut = [];
  const actions = [];
  for (const m of openMissions) {
    const unread = countUnread(m.id);
    const rec = recommendedAction(m, unread, sessionId);
    const wake = wakeFailureInfo(m);
    missionsOut.push({
      id: m.id,
      title: m.title || "",
      status: m.status,
      agent_type: m.agent_type || "",
      model: m.model ?? null,
      mode: (m.dispatch && m.dispatch.mode) || null,
      agent_id: (m.dispatch && m.dispatch.agent_id) || null,
      run_id: (m.dispatch && m.dispatch.run_id) || null,
      session_id: (m.dispatch && m.dispatch.session_id) || null,
      unread,
      ack: missionAck(m),
      wake_failure: wake.suspected ? { result_at: wake.result_at, minutes: wake.minutes } : null,
      blocked: m.blocked
        ? {
            question: m.blocked.question ?? null,
            answered: m.blocked.answered === true,
            answer: m.blocked.answer ?? null,
          }
        : null,
      updated_at: m.updated_at || null,
      recommended_action: rec.primary,
    });
    for (const a of rec.actions) actions.push({ mission_id: m.id, priority: a.priority, action: a.action });
  }
  // v0.4: pool missions waiting for a claim are surfaced here (not in the Stop
  // checklist / sentinel — ready is deliberately outside their open sets).
  const readyUnclaimedAll = openMissions.filter((m) => m.status === "ready" && !m.owner);
  if (readyUnclaimedAll.length) {
    actions.push({
      mission_id: null,
      priority: 2,
      action: `任务板有 ${readyUnclaimedAll.length} 项 ready 待领取：派池工自领取（第 18 章）或手动 board(upsert status=dispatched) 走普通派发`,
    });
  }
  actions.sort((a, b) => a.priority - b.priority);

  // v0.3: recent-session context from the mirror journal (read-only tails).
  const prevSessions = listJournalFiles()
    .filter((f) => !sessionId || f.session_id !== sessionId)
    .slice(0, 3)
    .map((f) => {
      const rows = readJournalRows(f.file);
      return {
        session_id: f.session_id,
        entries: rows.length,
        last_at: rows.length && typeof rows[rows.length - 1].ts === "string" ? rows[rows.length - 1].ts : null,
        tail: readJournalTail(f.file, 5),
      };
    });
  const contextHint = prevSessions.length
    ? "附近现场摘要已内联在 prev_sessions.tail（上下文镜像，截断记录）；" +
      '要还原上一会话现场先读 tail，深挖再平台 ReadSessionContext(sessionId="…", strategy="handoff")。' +
      "不要要求全量转储。"
    : null;

  return {
    generated_at: nowIso(),
    session_id: sessionId || null,
    missions: missionsOut,
    // v0.3.1 (C4): same counting basis as the Stop hook — only open (non-closed)
    // missions count, so a closed mission's leftover events no longer inflate.
    unread_total: openMissions.reduce((n, m) => n + countUnread(m.id), 0),
    actions_top3: actions.slice(0, 3),
    // v0.4: ready missions with no owner (≤8 listed), count first.
    ready_unclaimed: readyUnclaimedAll.slice(0, 8).map((m) => ({
      id: m.id,
      title: m.title || "",
      blocked_by: Array.isArray(m.blockedBy) ? m.blockedBy : [],
    })),
    ready_unclaimed_count: readyUnclaimedAll.length,
    prev_sessions: prevSessions,
    context_hint: contextHint,
  };
}

/* ------------------------------------------------------------------ */
/* tool registry                                                       */
/* ------------------------------------------------------------------ */

const TOOL_HANDLERS = {
  [PREFIX + "board"]: toolBoard,
  [PREFIX + "report"]: toolReport,
  [PREFIX + "mailbox"]: toolMailbox,
  [PREFIX + "spawn_agent"]: toolSpawnAgent,
  [PREFIX + "context_pack"]: toolContextPack,
  [PREFIX + "resume"]: toolResume,
  [PREFIX + "lessons"]: toolLessons,
  [PREFIX + "sandbox_apply"]: toolSandboxApply,
  [PREFIX + "sandbox_discard"]: toolSandboxDiscard,
};

const TOOLS = [
  {
    name: PREFIX + "board",
    description:
      "持久任务板的增查与签收（upsert=创建或按字段合并更新；get=按 id 取单条；list=按状态过滤列出，默认排除 closed；" +
      "ack=主控签收——已知悉结果、暂缓处置时打标，避免再被列为疑似唤醒失败）。" +
      "跨会话恢复的数据源。Persistent mission board: upsert/get/list/ack; the data source for cross-session resume.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          enum: ["upsert", "get", "list", "ack", "claim"],
          description:
            "upsert=创建或按字段合并更新；get=按 id 取单条；list=按状态过滤列出；" +
            "ack=主控签收（已知悉该 mission 的结果、暂缓处置时打标，避免再被列为疑似唤醒失败）；" +
            "claim=池工自领取（CAS）：worker 领取 ready 任务并写租约，领取即 running",
        },
        mission: {
          type: "object",
          description:
            "upsert 时的字段包，浅合并到既有记录（dispatch/blocked/pack 深一层合并）",
          properties: {
            id: {
              type: "string",
              description: "缺省自动生成 m-<YYYYMMDD-HHmmss>-<4hex>",
            },
            title: { type: "string" },
            original_prompt: {
              type: "string",
              description: "派发任务原文，跨会话恢复的关键",
            },
            agent_type: {
              type: "string",
              description: "如 agent-orchestrator:orch-worker",
            },
            model: { type: ["string", "null"] },
            status: {
              enum: [
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
              ],
            },
            blockedBy: {
              type: "array",
              items: { type: "string" },
              description:
                "上游 mission_id 列表（DAG）：全部 done/skipped/closed 后本 mission 解锁为 ready；任一上游 failed/skipped 则级联 skipped(upstream_failed)。允许前向引用；成环会被拒绝",
            },
            skippedReason: {
              type: ["string", "null"],
              description: "skipped 终态原因（当前仅 upstream_failed，级联自动写）",
            },
            qa: {
              type: "object",
              properties: {
                verdict: { enum: ["pass", "fail"] },
                by: { type: "string" },
                mission_id: { type: "string", description: "评审 mission（可追溯）" },
                at: { type: "string" },
                note: { type: "string" },
              },
              description:
                "评审结论（sandbox_apply 的门禁）：评审 mission done 后由主控抄录到目标 mission 上",
            },
            owner: {
              type: ["string", "null"],
              description: "只读：当前领取者，由 board claim 动作维护；upsert 传入被忽略",
            },
            claim: {
              type: ["object", "null"],
              description:
                "只读：{worker, token, claimedAt, leaseUntil} 租约；由 claim/report 续期/超时回收维护；upsert 传入被忽略",
            },
            dispatch: {
              type: "object",
              properties: {
                mode: { enum: ["agent", "workflow"] },
                agent_id: {
                  type: ["string", "null"],
                  description: "agent_<uuid>",
                },
                task_id: {
                  type: ["string", "null"],
                  description: "后台任务 id",
                },
                run_id: {
                  type: ["string", "null"],
                  description: "workflow run id",
                },
                run_in_background: { type: "boolean" },
                session_id: {
                  type: ["string", "null"],
                  description: "派发会话 id（来自 SessionStart 注入）",
                },
                token: { type: "string", description: "8hex 派发令牌" },
              },
            },
            pack: {
              type: "object",
              properties: {
                path: { type: "string" },
                variants: { type: "array", items: { type: "string" } },
              },
            },
            artifacts: {
              type: "array",
              items: {
                type: "object",
                properties: { path: { type: "string" }, note: { type: "string" } },
              },
            },
            output_files: {
              type: "array",
              items: { type: "string" },
              description: "完成通知给出的输出文件路径（TaskOutput 失效时的兜底）",
            },
            blocked: {
              type: "object",
              properties: {
                question: { type: ["string", "null"] },
                asked_at: { type: ["string", "null"] },
                answered: { type: "boolean" },
                answer: { type: ["string", "null"] },
                answered_at: { type: ["string", "null"] },
              },
            },
            ack: {
              type: ["object", "null"],
              description:
                "只读：签收标记 {at, by, note}，由 board ack 动作或 mailbox answer / close 自动维护；upsert 中传入会被忽略",
            },
          },
        },
        mission_id: { type: "string" },
        worker: {
          type: "string",
          description: "action=claim 必填：领取者名（如 orch-pool#1）",
        },
        lease_minutes: {
          type: "number",
          description:
            "action=claim 租约分钟数（≥1，缺省取 claim_lease_min=30）；report 自动续租，超时回 ready",
        },
        note: {
          type: "string",
          maxLength: 200,
          description: 'action=ack 时的附注，如 "deferred by user"',
        },
        filter_status: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: PREFIX + "report",
    description:
      "子代理专用上报：把进度/阻塞/提问/完成事件写入主控邮箱（spool），并联动任务板状态。" +
      "Subagent-only reporting: milestone/blocked/question/done events into the coordinator mailbox.",
    inputSchema: {
      type: "object",
      required: ["mission_id", "worker", "kind", "summary"],
      properties: {
        mission_id: { type: "string" },
        worker: { type: "string", description: "worker 名，如 orch-worker#2" },
        token: { type: "string", description: "派发包里的三行契约令牌" },
        kind: { enum: ["milestone", "blocked", "question", "done"] },
        summary: { type: "string", maxLength: 200 },
        details: { type: "string", description: "可选长文/结论" },
        artifacts: { type: "array", items: { type: "string" } },
        question: {
          type: "string",
          description: "kind=blocked/question 时必填的提问",
        },
        urgent: {
          type: "boolean",
          description: "仅标记，直答仍走 SendMessage/RespondToCoordinator",
        },
        lessons: {
          type: "array",
          maxItems: 3,
          description:
            "kind=done 时可选：候选教训（只填 trigger/fix，主控签收时提炼晋升）。仅 kind=done 生效；其他 kind 携带会被忽略",
          items: {
            type: "object",
            required: ["trigger", "fix"],
            properties: {
              type: { enum: ["error-fix", "pitfall", "preference", "env-fact"], description: "缺省 pitfall" },
              trigger: { type: "string", maxLength: 120, description: "什么情境下踩坑（触发条件）" },
              fix: { type: "string", maxLength: 200, description: "下次遇到该怎么办（可执行动作）" },
              lesson: {
                type: "string",
                maxLength: 200,
                description: "可选单句教训；缺省由主控晋升时提炼",
              },
            },
          },
        },
      },
    },
  },
  {
    name: PREFIX + "mailbox",
    description:
      "主控邮箱：peek=不消费地查看未读事件；read=原子消费；answer=记录答案并给出 SendMessage 建议调用；gc=清理与归档。" +
      "Coordinator mailbox: peek/read (consume via rename), answer (log + recommended SendMessage), gc (cleanup + archive).",
    inputSchema: {
      type: "object",
      properties: {
        action: { enum: ["peek", "read", "answer", "gc"] },
        mission_id: { type: "string" },
        kind: { enum: ["milestone", "blocked", "question", "done"] },
        limit: { type: "number", default: 20 },
        answer: { type: "string", description: "action=answer 时必填" },
        keep_days: { type: "number", default: 14, description: "gc 阈值" },
      },
    },
  },
  {
    name: PREFIX + "spawn_agent",
    description:
      "运行时创建自定义子代理角色，写入 <项目>/.zcode/agents/<name>.md（内嵌 archetype 模板；新会话注册生效）。" +
      "Create a custom subagent persona at runtime (takes effect in new sessions).",
    inputSchema: {
      type: "object",
      required: ["name", "description"],
      properties: {
        name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
        description: { type: "string", minLength: 10 },
        archetype: { enum: ["worker", "scout", "reviewer"], default: "worker" },
        model: {
          type: "string",
          description: "providerId/modelId；缺省=继承会话模型",
        },
        max_turns: { type: "number" },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "覆盖原型工具面；必须保留 report 全名",
        },
        system_prompt: { type: "string", description: "追加在原型正文后的角色专述" },
        overwrite: { type: "boolean", default: false },
      },
    },
  },
  {
    name: PREFIX + "context_pack",
    description:
      "物化上下文包/分叉：把上游上下文逐字写成任务包文件，支持 1–8 个变体，返回三行契约派发头与 token。" +
      "Materialize a verbatim context pack (with 1-8 variants) and return the three-line dispatch header + token.",
    inputSchema: {
      type: "object",
      required: ["mission_id", "title", "task"],
      properties: {
        mission_id: { type: "string" },
        title: { type: "string" },
        task: { type: "string" },
        read_first: { type: "array", items: { type: "string" } },
        rules: { type: "array", items: { type: "string" } },
        return_format: { type: "string" },
        upstream_context: {
          type: "string",
          description: "上游产物逐字注入（子代理当时不在场）",
        },
        variants: { type: "number", minimum: 1, maximum: 8, default: 1 },
        variant_axes: {
          type: "array",
          items: { type: "string" },
          description: "每个变体的差异维度，长度建议=variants",
        },
        isolation: {
          enum: ["worktree", "none"],
          description:
            "写型隔离：worktree=为该 mission 建 git worktree 沙箱（分支 orch/<mission_id>，任务包内路径改写+红线声明）；none=不隔离（默认，取 userConfig sandbox_default）。copy 降级不做：非 git 项目直接拒绝并引导 git init",
        },
        oob_allowlist: {
          type: "array",
          items: { type: "string" },
          description:
            '仓库相对路径前缀白名单（如 ["src/","tests/"]）；sandbox_apply 据此机械检出越界改动。缺省/空=允许全部路径。仅 isolation=worktree 生效',
        },
        share_node_modules: {
          type: "boolean",
          description:
            "是否把主仓 node_modules 以 junction 共享进沙箱。缺省自动：主仓存在 node_modules 且任务不像安装类（不含 npm/pnpm/yarn install|add、安装依赖等）→ true；显式 true 但任务像安装类 → 照建并在返回中警告",
        },
        extra: { type: "string" },
        mirror_digest: {
          type: "boolean",
          default: false,
          description: "附加\"近期现场摘要\"（上下文镜像尾部，跨会话续接参考）",
        },
      },
    },
  },
  {
    name: PREFIX + "resume",
    description:
      "恢复简报：读任务板+邮箱，为每个未闭环 mission 给出 recommended_action（同会话续聊/workflow 续跑/跨会话重建重派）。" +
      "Resume briefing: per-mission recommended actions for same-session chat resume, workflow resume, or cross-session re-dispatch.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "当前会话 id，用于区分同会话/跨会话",
        },
      },
    },
  },
  {
    name: PREFIX + "lessons",
    description:
      "编排教训库：list=按 score 检索（默认 status=active）；add=主控直接添加（失败反思/环境事实/钉住对话要点，可带 contradicts 记反例并 supersede 旧条）；" +
      "promote=把候选提炼晋升为 active（同 trigger+fix 自动合并 hits/confidence，矛盾走 add 的 contradicts）；retire=手工退役。" +
      "候选由子代理 report(kind=done, lessons=[…]) 产生。Learning memory for orchestration lessons: list/add/promote/retire.",
    inputSchema: {
      type: "object",
      properties: {
        action: { enum: ["list", "add", "promote", "retire"] },
        id: { type: "string", description: "promote/retire 目标条目 id（l-…）" },
        status: {
          type: "string",
          description: "list 过滤：active|candidate|superseded|retired|all，默认 active",
        },
        type: {
          enum: ["error-fix", "pitfall", "preference", "env-fact"],
          description: "add 必填；list 可选过滤",
        },
        q: {
          type: "string",
          description: "list 关键词过滤（对 trigger/lesson/fix 做不区分大小写子串匹配）",
        },
        trigger: { type: "string", maxLength: 120, description: "add 必填；promote 可选精修" },
        lesson: { type: "string", maxLength: 200, description: "add/promote 可选：单句教训" },
        fix: { type: "string", maxLength: 200, description: "add 必填；promote 可选精修" },
        mission_id: {
          type: "string",
          description: "add 可选：来源 mission（进 refs/counter_refs）",
        },
        contradicts: {
          type: "string",
          description: "add 可选：被本条证伪的旧条目 id，将被置 superseded 并记反例",
        },
        reason: { type: "string", maxLength: 200, description: "retire 附注" },
        limit: { type: "number", default: 8, description: "list 返回上限" },
      },
    },
  },
  {
    name: PREFIX + "sandbox_apply",
    description:
      "沙箱收尾（门禁工具）：把沙箱分支合并回主仓并销毁 worktree。门禁=mission done 且 qa.verdict=pass；" +
      "流程=主仓 status 巡检→越界 allowlist 检出→merge-tree 冲突预检→干净 merge+commit→worktree remove→board closed+自动签收。" +
      "冲突时 isError 并给冲突清单与合并代理四件套指引（不触主仓）。Apply a sandboxed worktree branch back into the main repo.",
    inputSchema: {
      type: "object",
      required: ["mission_id"],
      properties: {
        mission_id: { type: "string" },
        allow_dirty: {
          type: "boolean",
          default: false,
          description:
            "主仓 porcelain 非空时的人工确认逃生门（确认非 worker 污染而是自己未提交的改动）。qa 门禁不可绕过",
        },
      },
    },
  },
  {
    name: PREFIX + "sandbox_discard",
    description:
      "沙箱弃单（零损伤）：删除沙箱分支与 worktree，主仓零改动；mission 状态不动（可重派或 close）。" +
      "用于 verdict=fail、worker 写穿、任务作废。幂等：分支/worktree 已不存在时照常成功。Discard a sandbox worktree and branch.",
    inputSchema: {
      type: "object",
      required: ["mission_id"],
      properties: { mission_id: { type: "string" } },
    },
  },
];

/* ------------------------------------------------------------------ */
/* JSON-RPC plumbing                                                   */
/* ------------------------------------------------------------------ */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handleToolsCall(id, params) {
  const name = params && typeof params === "object" ? params.name : undefined;
  const args =
    params && typeof params === "object" && params.arguments && typeof params.arguments === "object"
      ? params.arguments
      : {};
  const handler = typeof name === "string" ? TOOL_HANDLERS[name] : undefined;
  if (!handler) {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify({ error: `unknown tool: ${String(name)}` }) }],
        isError: true,
      },
    });
    return;
  }
  try {
    const result = handler(args);
    send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(result) }] },
    });
  } catch (err) {
    const message = err instanceof ToolError ? err.message : `${err && err.message ? err.message : err}`;
    if (!(err instanceof ToolError)) {
      log("tools/call internal error:", (err && err.stack) || String(err));
    }
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      },
    });
  }
}

function dispatch(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") {
    // The line parsed as JSON but is not a request object: treat like a bad line.
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const { id, method, params } = msg;
  if (typeof method === "string" && method.startsWith("notifications/")) {
    return; // notifications never get a reply
  }
  if (method === "initialize") {
    const requested =
      params && typeof params === "object" ? params.protocolVersion : undefined;
    const protocolVersion =
      typeof requested === "string" && requested.trim() ? requested : PROTOCOL_VERSION_FALLBACK;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    handleToolsCall(id, params);
    return;
  }
  send({
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: { code: -32601, message: "Method not found" },
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  try {
    dispatch(msg);
  } catch (err) {
    log("dispatch error:", (err && err.stack) || String(err));
    const id = msg && typeof msg === "object" && msg.id !== undefined ? msg.id : null;
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
  }
});
rl.on("close", () => process.exit(0));
rl.on("error", () => process.exit(0));
process.on("uncaughtException", (err) => {
  // All tool errors are already funneled into isError results; anything here is
  // logged without killing the stdio loop (state is reloaded from disk per call).
  log("uncaughtException:", (err && err.stack) || String(err));
});

log(`stdio JSON-RPC ready; project=${projectDir}; root=${root}`);
