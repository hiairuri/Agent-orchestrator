// agent-orchestrator orch server — git 子进程/scope 谓词/沙箱物化（机械拆分自 server.mjs L1117-1287、L1321-1674；REMOTE argv 禁令注释随段保留）
import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import {
  root, projectDir, nowIso, ToolError, displayPath, assertInside, STATUSES,
  normalizePathList, coversPath,
} from "./server-core.mjs";
import { findMission, upsertMission } from "./server-board.mjs";
/* ------------------------------------------------------------------ */
/* git subprocess block (v0.4 sandbox dispatch)                        */
/*                                                                     */
/* child_process is used EXCLUSIVELY for the local git CLI. Every git  */
/* operation below is a local object-database operation (branch /      */
/* worktree / merge-tree / merge / diff / status). REMOTE OPERATIONS   */
/* ARE FORBIDDEN: the argv words push/pull/fetch/clone/remote/submodule*/
/* must never appear in this file (statically asserted by SB9).        */
/* Git sections always run inside the caller's withRootLock critical   */
/* section UNLESS a caller explicitly documents otherwise: since v0.6   */
/* (V6-08 plan b) sandbox_apply/sandbox_discard run their git pipeline */
/* OUTSIDE the root lock (phase-2) so no git subprocess — capped at 60s */
/* — can ever hold the lock past the 2s busy window or the 30s stale    */
/* takeover window.                                                     */
/* ------------------------------------------------------------------ */

const GIT_TIMEOUT_MS = 60000;
// merge-tree --write-tree was introduced in git 2.38; older git cannot precheck.
const GIT_MIN_MINOR_FOR_MERGE_TREE = 38;
let gitMergeTreeSupported = null; // process-level probe cache

/** The ONLY git exit in this codebase (sync, UTF-8, hard timeout). */
function gitRun(cwd, args, timeoutMs = GIT_TIMEOUT_MS) {
  // v0.6 (V6-29): core.quotepath=false keeps non-ASCII paths literal UTF-8 in
  // diff output, so the out-of-bounds prefix gate and the files audit compare
  // real paths instead of quoted "\346\226\207..." octal escapes (Chinese-named
  // projects are first-class). Accepted by every git subcommand used here.
  return child_process.execFileSync(
    "git",
    ["-c", "core.quotepath=false", ...args],
    { cwd, encoding: "utf8", timeout: timeoutMs },
  );
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

/**
 * True when <branch> is already an ancestor of HEAD (i.e. merged into the
 * mainline). v0.6 (V6-08 plan b): the crash-recovery oracle for a dangling
 * apply intent — `git merge-base --is-ancestor <branch> HEAD` exits 0 when
 * merged, 1 when not. ANY other failure (deleted branch, corrupt repo) also
 * reads as "not merged": the safe direction, since the caller then falls back
 * to full gate re-validation instead of a blind settle.
 */
function branchMergedIntoHead(cwd, branch) {
  try {
    gitRun(cwd, ["merge-base", "--is-ancestor", branch, "HEAD"]);
    return true;
  } catch {
    return false;
  }
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
/**
 * F2 scopeOverlap (v0.5): lexical prefix intersection of two path lists.
 * Entry a covers entry b iff a === b or b starts with a (same startsWith
 * semantics as the sandbox apply out-of-scope check — v0.6: both go through
 * the single coversPath predicate, V6-10). Purely lexical: no fs
 * resolution, no case folding, no "./" stripping. Returns the covered
 * entries of both sides (first-occurrence order, deduped) — the shared set
 * under the cover relation, so a broader incoming scope still collides with
 * a narrower registered one and vice versa.
 */
function scopeOverlap(aPaths, bPaths) {
  const covers = coversPath;
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  for (const a of aPaths) {
    for (const b of bPaths) {
      if (covers(a, b)) push(b);
    }
  }
  for (const b of bPaths) {
    for (const a of aPaths) {
      if (covers(b, a)) push(a);
    }
  }
  return out;
}

/**
 * G-3 occlusion predicate (v0.5, function-level single point shared by the
 * upsert preflight below and the board list view): a pair is deliberately
 * serialized when EITHER side's blockedBy references the other. Such pairs
 * are never reported as scope conflicts — "转串行" is the sanctioned
 * resolution, so both views must fall silent at once (CRV3-01 / M-05).
 */
function scopePairOccluded(a, b) {
  const depsOf = (m) => (Array.isArray(m && m.blockedBy) ? m.blockedBy.map(String) : []);
  return depsOf(a).includes(b.id) || depsOf(b).includes(a.id);
}

/**
 * G-3 single-source pair judgment (v0.5): the ONLY place that decides whether
 * two missions' scopes conflict, consumed by both the upsert preflight (F3)
 * and the board list view (E7). Returns the scope_warnings-shaped entry
 * {with_mission_id, overlap, hint} for the pair (a reported against b), or
 * null when the pair is clean: either side unregistered (empty scope never
 * participates), no lexical overlap under the F2 prefix relation, or the pair
 * is occluded via blockedBy (deliberate serialization is never reported).
 * Inputs may hold raw path values — normalization is idempotent.
 */
function scopePairConflict(a, b) {
  const aPaths = normalizePathList(a.scope_paths);
  const bPaths = normalizePathList(b.scope_paths);
  if (!aPaths.length || !bPaths.length) return null;
  if (scopePairOccluded(a, b)) return null;
  const overlap = scopeOverlap(aPaths, bPaths);
  if (!overlap.length) return null;
  const overlapText = overlap.join("、");
  return {
    with_mission_id: b.id,
    overlap,
    hint: `scope 与 ${b.id} 相交：${overlapText}。三选一：给本 mission 加 blockedBy=[${b.id}] 转串行；改沙箱分叉各自 apply；重切把相交文件归一边独占。`,
  };
}

/**
 * F3 checkScopeConflicts (v0.5, CR-05 preflight): compare the incoming
 * patch's scope_paths against every live mission's registered scope. Live
 * = STATUSES minus done/failed/skipped/closed (CR-05 enum, verbatim). The
 * patch's own mission is skipped (G-2: re-registering the same scope must
 * not self-alarm). An empty/absent patch scope (unregistered) never
 * participates. Pair judgment (overlap + occlusion) is the G-3 single-source
 * scopePairConflict — the occlusion exemption reads the EFFECTIVE dependency
 * edges of the incoming side: an explicit patch.blockedBy wins, otherwise the
 * stored self mission's edges carry over (re-registering scope after
 * serializing via blockedBy must not self-alarm, M-05 转串行后同空). Default
 * tier returns [{with_mission_id, overlap, hint}] for the caller's
 * scope_warnings; strict tier (patch.strict_scope === true) throws ToolError
 * on the first conflict — board untouched ("reject before write", same
 * pattern as the cycle gate).
 */
function checkScopeConflicts(board, patch) {
  const patchPaths = normalizePathList(patch.scope_paths);
  if (!patchPaths.length) return [];
  const live = STATUSES.filter(
    (s) => !["done", "failed", "skipped", "closed"].includes(s),
  );
  const self =
    patch.id != null
      ? (Array.isArray(board.missions) ? board.missions : []).find(
          (m) => m && typeof m === "object" && m.id === patch.id,
        )
      : null;
  const patchView = {
    id: patch.id ?? null,
    blockedBy: patch.blockedBy !== undefined ? patch.blockedBy : self && self.blockedBy,
    scope_paths: patch.scope_paths,
  };
  const conflicts = [];
  for (const m of Array.isArray(board.missions) ? board.missions : []) {
    if (!m || typeof m !== "object") continue;
    if (patchView.id != null && m.id === patchView.id) continue; // G-2: no self-alarm
    if (!live.includes(m.status)) continue;
    if (patch.strict_scope === true) {
      const hit = scopePairConflict(patchView, m);
      if (hit) {
        throw new ToolError(
          `strict_scope 拒绝登记：scope 与 ${hit.with_mission_id} 相交：${hit.overlap.join("、")}（board 未改动）`,
        );
      }
    } else {
      const entry = scopePairConflict(patchView, m);
      if (entry) conflicts.push(entry);
    }
  }
  return conflicts;
}

/**
 * E7 (v0.5): board list top-level scope_conflicts — the pairwise conflict
 * view over the CURRENT in-flight layout (the upsert preflight is the same
 * judgment at write-transaction time; the rules differ only in trigger
 * timing, never in outcome — M-05 钉同源). Live missions only, both sides
 * registered, G-3 occlusion exemption via the same scopePairConflict
 * predicate. Presentation cap ≤10 entries (sentinel_health 体例); the key is
 * omitted entirely when clean (conditional-key precedent).
 */
function collectScopeConflicts(board) {
  const live = STATUSES.filter(
    (s) => !["done", "failed", "skipped", "closed"].includes(s),
  );
  const ms = (Array.isArray(board.missions) ? board.missions : []).filter(
    (m) => m && typeof m === "object" && live.includes(m.status),
  );
  const conflicts = [];
  for (let i = 0; i < ms.length; i++) {
    for (let j = i + 1; j < ms.length; j++) {
      // Report the pair from the later-registered side (board order is
      // first-registration order): with_mission_id names the EARLIER mission,
      // so the hint's "给本 mission 加 blockedBy=[<earlier>]" reads exactly as
      // the CR-05 doctrine "后写者 blockedBy=[前写者] 转串行" and matches the
      // upsert view entry for the same situation (M-05 同源).
      const entry = scopePairConflict(ms[j], ms[i]);
      if (entry) conflicts.push(entry);
    }
  }
  return conflicts.slice(0, 10);
}

/**
 * P9 (v0.10 §6.1): duplicate-mission warning — a stale drafted corpse left on
 * the board next to a live dispatch of the same work (流程研究 §2 环节 E).
 * Pair trigger, all three conditions:
 *   1. same title after normalization (trim + lowercase) OR scope_paths
 *      intersect under the G-3 single-source pair judgment
 *      (scopePairConflict — the scope_warnings mechanism family, including its
 *      blockedBy occlusion exemption);
 *   2. statuses straddle {drafted} / {dispatched, running}: exactly one side
 *      drafted, the other dispatched or running;
 *   3. different mission id (re-upserting a mission never self-alarms).
 * The incoming side is the POST-MERGE view (explicit patch fields win,
 * otherwise the stored mission's fields, else the new-mission defaults:
 * status drafted / empty title). Empty titles never participate — same
 * "unregistered never participates" stance as empty scope. Callers omit the
 * response key entirely when the result is empty (zero-byte-diff default).
 */
function checkDuplicateMissions(board, patch) {
  const self =
    patch.id != null ? findMission(board, patch.id) : null;
  const incoming = {
    id: patch.id ?? null,
    title: patch.title !== undefined ? patch.title : self ? self.title : "",
    status:
      patch.status !== undefined ? patch.status : self ? self.status : "drafted",
    scope_paths:
      patch.scope_paths !== undefined
        ? patch.scope_paths
        : self
          ? self.scope_paths
          : undefined,
    blockedBy:
      patch.blockedBy !== undefined
        ? patch.blockedBy
        : self
          ? self.blockedBy
          : undefined,
  };
  const isDrafted = (s) => s === "drafted";
  const isLive = (s) => s === "dispatched" || s === "running";
  if (!isDrafted(incoming.status) && !isLive(incoming.status)) return [];
  const normTitle = (t) =>
    String(t == null ? "" : t).trim().toLowerCase();
  const incomingTitle = normTitle(incoming.title);
  const warnings = [];
  for (const m of Array.isArray(board.missions) ? board.missions : []) {
    if (!m || typeof m !== "object") continue;
    if (incoming.id != null && m.id === incoming.id) continue; // no self-alarm
    const straddles =
      (isDrafted(incoming.status) && isLive(m.status)) ||
      (isLive(incoming.status) && isDrafted(m.status));
    if (!straddles) continue;
    const titleHit =
      Boolean(incomingTitle) && normTitle(m.title) === incomingTitle;
    const scopeHit = scopePairConflict(incoming, m);
    if (!titleHit && !scopeHit) continue;
    const reason = titleHit && scopeHit ? "title+scope" : titleHit ? "title" : "scope";
    const what = titleHit
      ? scopeHit
        ? `title 归一化后相等且 scope 相交：${scopeHit.overlap.join("、")}`
        : "title 归一化后相等（trim+小写）"
      : `scope 相交：${scopeHit.overlap.join("、")}`;
    const archiveHint = isDrafted(m.status)
      ? `建议归档旧 mission ${m.id}（drafted → skipped → closed）`
      : `建议确认本 mission 是否为在飞 ${m.id} 的重复尸体；是则归档本 mission（drafted → skipped → closed）`;
    const entry = {
      with_mission_id: m.id,
      reason,
      hint: `疑似重复 mission：与 ${m.id} ${what}。${archiveHint}；确需并存请改 title/scope。`,
    };
    if (scopeHit) entry.overlap = scopeHit.overlap;
    warnings.push(entry);
  }
  return warnings;
}

/**
 * F4 checkScopeAudit (v0.5, files_touched out-of-scope audit): a mission
 * with no registered scope_paths has no baseline -> never audited
 * ("登记什么就审什么", same single-source semantics as the F3 preflight).
 * Otherwise a touched file is a violation iff no scope entry covers it under
 * the F2 prefix relation (v0.6: via the coversPath single source, V6-10 —
 * "designs" no longer swallows "designs-evil/x"). Purely lexical, read-only
 * over the declaration; the returned violations keep declaration order.
 */
function checkScopeAudit(mission, files) {
  const scope = normalizePathList(mission && mission.scope_paths);
  if (!scope.length) return [];
  return (Array.isArray(files) ? files : []).filter((f) => !scope.some((s) => coversPath(s, f)));
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
    oob_allowlist: normalizePathList(oobAllowlist),
    created_at: at,
    apply_intent_at: null, // v0.6 (V6-08): phase-1 intent marker (two-phase apply)
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

export {
  gitRun,
  assertMergeTreeSupport,
  branchMergedIntoHead,
  worktreeListPaths,
  porcelainStatus,
  listDiffNames,
  parseMergeTreeConflicts,
  rewritePathStrings,
  isInstallLikeTask,
  checkScopeConflicts,
  collectScopeConflicts,
  checkDuplicateMissions,
  checkScopeAudit,
  materializeSandbox,
  buildSandboxLines,
  removeJunctionLink,
};
