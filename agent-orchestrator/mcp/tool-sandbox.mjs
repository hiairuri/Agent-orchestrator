// agent-orchestrator orch server — tools: sandbox_apply / sandbox_discard（三相 git 管线+收口事务；机械拆分自 server.mjs L7802-8332）
import fs from "node:fs";
import path from "node:path";
import {
  root, projectDir, nowIso, safeSegment, withRootLock, ToolError, displayPath,
  normalizePathList, coversPath, APPLY_INTENT_FRESH_MS,
} from "./server-core.mjs";
import {
  gitRun, branchMergedIntoHead, worktreeListPaths, porcelainStatus,
  listDiffNames, parseMergeTreeConflicts, assertMergeTreeSupport, removeJunctionLink,
} from "./server-git.mjs";
import { loadBoard, findMission, saveBoard, missionAck } from "./server-board.mjs";
/* ------------------------------------------------------------------ */
/* tools: sandbox_apply / sandbox_discard (v0.4; v0.6 A5 envelope)     */
/*                                                                     */
/* v0.6 (V6-08/13/35, plan b — W-A2 §1): the git pipeline moved OUT of */
/* the root lock. apply runs in three phases:                          */
/*   phase-1 (in lock, <2s): loadBoard + gates (identity/sandbox/      */
/*     done/qa/merge-tree precheck) + three-state idempotent branch +  */
/*     write pack.sandbox.apply_intent_at → saveBoard → unlock.        */
/*   phase-2 (NO lock): porcelain survey, oob diff gate, merge,        */
/*     rev-parse. No git subprocess ever holds the lock past the 2s    */
/*     busy window or the 30s stale-takeover window — the V6-13        */
/*     hard-error storm and the live-takeover lost-update lose their   */
/*     target (nothing to take over while the merge runs).             */
/*   phase-3 (in lock, <2s): FRESH loadBoard (the t0 lost-update       */
/*     window is gone by construction — plan c's re-read-replay,       */
/*     instantiated at its only legitimate caller), re-locate by id,   */
/*     hard identity check (branch/base_commit), applied-wins board    */
/*     transaction (status/qa drift is NOT rolled back — R7).          */
/*   teardown (NO lock, AFTER phase-3 — V6-35): worktree removal       */
/*     failure degrades to worktree_removed:false + warning instead of */
/*     throwing past a landed merge.                                   */
/* Idempotent branch, three states (V6-08):                            */
/*   applied_at present              → compensate-close (v0.4.1 fix).  */
/*   intent present + branch merged  → settle via merge-base           */
/*     --is-ancestor (crash-after-merge coverage).                     */
/*   intent present + unmerged +     → structured busy                 */
/*   intent fresh (10min)              {ok:true,apply_in_progress:true}*/
/*   intent present + unmerged +     → stale: clear intent, re-run     */
/*   intent stale                      phase-1 gates.                  */
/* discard: a fresh apply intent rejects the discard (apply↔discard    */
/* mutual exclusion); its git triple (prune/remove/branch -D) also     */
/* leaves the lock, and phase-3 arbitrates "applied wins".             */
/* ------------------------------------------------------------------ */

function toolSandboxApply(args) {
  const missionId = safeSegment(args.mission_id, "mission_id");
  const allowDirty = args.allow_dirty === true;

  // phase-1 (in lock): gates + intent write.
  const p1 = withRootLock(() => applyGateAndIntent(missionId, allowDirty));
  if (p1.kind === "compensated" || p1.kind === "busy") return p1.response;

  // phase-2 (NO lock): porcelain + oob + merge + rev-parse. A tool-visible
  // failure clears the intent so a retry does not sit on the 10min busy
  // window; only a process death leaves it dangling (self-healed by the
  // merge-base three-state path on re-entry).
  let p2;
  if (p1.kind === "settled") {
    p2 = { appliedCommit: p1.appliedCommit, recovered: true };
  } else {
    try {
      p2 = applyGitPipeline(missionId, p1);
    } catch (err) {
      clearApplyIntentBestEffort(missionId);
      throw err;
    }
  }

  // phase-3 (in lock): fresh board, applied-wins settle transaction.
  const p3 = withRootLock(() => applySettleBoard(missionId, p1, p2));

  // teardown (NO lock, AFTER the board txn — V6-35): degrade, never throw.
  const t = applyTeardown(p1.wtDir, missionId);
  const response = { ...p3.response, worktree_removed: t.removed };
  const warns = [...p3.warns, ...t.warns];
  if (warns.length) response.warning = warns.join("；");
  return response;
}

/**
 * phase-1 of sandbox_apply (runs INSIDE withRootLock): the board gates and
 * the intent write. No step here runs a long git subprocess (merge-tree is an
 * in-memory merge; rev-parse/merge-base are ref operations) — the <2s lock
 * discipline holds. Returns {kind, ...}:
 *   compensated — sb.applied_at was present; board closed, response ready.
 *   busy        — fresh intent + unmerged; structured busy response ready.
 *   settled     — intent present AND branch already merged (crash recovery);
 *                 appliedCommit = current HEAD; straight to phase-3.
 *   intent      — gates passed, intent written; proceed to phase-2.
 */
function applyGateAndIntent(missionId, allowDirty) {
  const board = loadBoard();
  const m = findMission(board, missionId);
  if (!m) throw new ToolError(`mission not found: ${missionId}`);
  const sb = m.pack && m.pack.sandbox;
  if (!sb || sb.isolation !== "worktree") {
    throw new ToolError("该 mission 非沙箱派发");
  }
  const branch = String(sb.branch);
  const baseCommit = String(sb.base_commit ?? "");
  const wtDir = path.resolve(String(sb.root));
  const at = nowIso();
  // v0.4.1 QA fix (kept): the idempotent branch runs BEFORE the done/qa
  // gates. Once applied_at exists the merge already happened — finishing the
  // board transaction is always correct. v0.6 (V6-08 plan b): three states.
  if (sb.applied_at) {
    // State 1 — applied: idempotent re-entry + compensation. A crash after
    // the merge must still end with the board closed.
    if (m.status !== "closed") {
      m.status = "closed";
      if (!missionAck(m)) m.ack = { at, by: "sandbox_apply", note: "auto: applied" };
      m.updated_at = at;
      saveBoard(board);
    }
    return {
      kind: "compensated",
      wtDir,
      branch,
      response: {
        ok: true,
        already_applied: true,
        mission_id: missionId,
        applied_commit: sb.applied_commit ?? null,
        branch,
        status: m.status,
      },
    };
  }
  if (sb.apply_intent_at) {
    if (branchMergedIntoHead(projectDir, branch)) {
      // State 2a — intent present and the branch is ALREADY in the mainline:
      // the previous holder died between merge and settle. The merge is
      // irreversible, so converge the board onto it (phase-3 directly).
      return {
        kind: "settled",
        wtDir,
        branch,
        baseCommit,
        appliedCommit: String(gitRun(projectDir, ["rev-parse", "HEAD"])).trim(),
      };
    }
    if (applyIntentFresh(sb.apply_intent_at)) {
      // State 2b — fresh intent, nothing merged: an apply is genuinely in
      // flight (cross-process). Structured busy — never a double merge; the
      // same window is the discard↔apply mutual exclusion.
      return {
        kind: "busy",
        wtDir,
        branch,
        response: {
          ok: true,
          apply_in_progress: true,
          mission_id: missionId,
          branch,
          intent_at: sb.apply_intent_at,
          note: "apply 在飞（apply_intent_at 在 10min 新鲜窗内且分支未合入）：勿重复合并；等待其收口，或 intent 过期后重跑 apply（将自动收口或重试）",
        },
      };
    }
    // State 2c — stale intent, nothing merged: the previous holder died
    // before the merge. Clear the intent and fall through — the gates below
    // re-validate everything (qa may have changed, sandbox may be rebuilt).
    delete sb.apply_intent_at;
  }
  // 1. gates (single loadBoard).
  if (m.status !== "done") {
    throw new ToolError(`仅 done 状态可 apply，当前 ${m.status}`);
  }
  // v0.6 (V6-42, AUTH-08): the bare `qa.verdict==="pass"` gate was paper —
  // anyone with board write could self-approve then apply. The gate is now a
  // four-check chain over the structured qa form
  // {verdict:"pass", reviewed_by:<评审 mission_id>, reviewed_at}:
  //   ① verdict=pass; ② reviewed_by resolves to a done/closed mission;
  //   ③ that mission's agent_type contains "reviewer";
  //   ④ it cross-references this mission (its qa.mission_id, or artifacts).
  // Legacy bare qa gets an explicit error naming the missing item — no silent
  // downgrade (0.6 is the debt-release; there is no legacy production board).
  if (!(m.qa && typeof m.qa === "object" && m.qa.verdict === "pass")) {
    throw new ToolError(
      '缺少 pass 评审：先派 orch-reviewer 审 diff，再 board(upsert, mission={id, qa:{verdict:"pass", reviewed_by:<评审 mission_id>, reviewed_at}})',
    );
  }
  const reviewedBy = typeof m.qa.reviewed_by === "string" ? m.qa.reviewed_by.trim() : "";
  if (!reviewedBy) {
    throw new ToolError(
      "qa 缺少 reviewed_by：apply 需要 qa 结构体 {verdict:\"pass\", reviewed_by:<评审 mission_id>, reviewed_at}" +
        "（先派评审 mission 复核，再回写本 mission 的 qa）",
    );
  }
  const review = findMission(board, reviewedBy);
  if (!review || !(review.status === "done" || review.status === "closed")) {
    throw new ToolError(
      `qa.reviewed_by 指向的评审 mission（${reviewedBy}）不存在或未完成` +
        `（需 done/closed，当前 ${review ? review.status : "不存在"}）`,
    );
  }
  const reviewType = typeof review.agent_type === "string" ? review.agent_type : "";
  if (!reviewType.includes("reviewer")) {
    throw new ToolError(
      `qa.reviewed_by 指向的评审 mission（${reviewedBy}）agent_type（${reviewType || "空"}）不含 reviewer` +
        "：评审须由 orch-reviewer 角色执行（自审自批被此查拦截）",
    );
  }
  const reviewRefsThis =
    (review.qa && typeof review.qa === "object" && review.qa.mission_id === missionId) ||
    (Array.isArray(review.artifacts) &&
      review.artifacts.some((a) =>
        (a && typeof a === "object" ? String(a.path ?? "") : String(a ?? "")).includes(missionId),
      ));
  if (!reviewRefsThis) {
    throw new ToolError(
      `评审 mission（${reviewedBy}）未互指本 mission（${missionId}）：` +
        `评审 mission 需 qa.mission_id=${missionId} 或 artifacts 引用本 mission`,
    );
  }
  assertMergeTreeSupport(projectDir);
  // conflict precheck: in-memory merge, never touches the working tree. Kept
  // in phase-1 by design (W-A2 §1.2 five gates); it is a fast in-memory op.
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
  // phase-1 commit point: the intent lands BEFORE any working-tree git work.
  // From here the caller may hold NO root lock while git runs.
  sb.apply_intent_at = nowIso();
  saveBoard(board);
  return {
    kind: "intent",
    wtDir,
    branch,
    baseCommit,
    allowDirty,
    oobAllowlist: sb.oob_allowlist,
  };
}

/**
 * phase-2 of sandbox_apply (runs OUTSIDE the root lock): the working-tree
 * git pipeline. Throwing here is safe — the caller clears the intent; the
 * main repo is only mutated by the merge itself (the last step).
 */
function applyGitPipeline(missionId, p1) {
  // main-repo pollution gate (porcelain survey). allow_dirty is the manual
  // escape hatch; the qa gate has NO escape hatch.
  const porcelain = porcelainStatus(projectDir);
  if (porcelain.trim() && !p1.allowDirty) {
    throw new ToolError(
      "主仓工作树不干净：可能是 worker 写穿污染（git checkout -- <paths> 可还原），" +
        "也可能是你自己的未提交改动——确认后 stash/提交/还原，或确认为己方改动时传 allow_dirty=true 重试\n" +
        porcelain.trim(),
    );
  }
  // v1.6 W4 (proposal P7) sandbox dirty gate — 修订轮 F-2（主控裁定 a）收窄：
  // ONLY modified/unstaged TRACKED content blocks the merge — that is the
  // "worker finished without committing deliverables" case the merge would
  // silently drop (l-20261103-58ff9d). Untracked-only dirt PASSES: merge
  // consumes branch commits only, untracked files can never be merged in, and
  // a content-less landing still surfaces through the no_op_merge explicit
  // signal (second line of defense). This restores the V6-35
  // teardown-degradation scenario reachability (crv5-apply-envelope ENV-04a/b/c:
  // leftover untracked state is the fixture). No allow_dirty escape on the
  // tracked-dirty leg (unreviewed tracked content must never merge); recovery:
  // commit inside the sandbox, then re-apply — never discard (l-20261104-c00f1a).
  let untrackedLeft = 0;
  if (fs.existsSync(p1.wtDir)) {
    const wtPorcelain = porcelainStatus(p1.wtDir);
    const trackedDirty = wtPorcelain
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("??"));
    if (trackedDirty.length) {
      throw new ToolError(
        "沙箱工作树存在未提交 tracked 改动（worker 未 commit 交付物场景）：apply 只合并分支提交，" +
          "不自动提交脏工作树（同哈希空转先例 l-20261103-58ff9d；修订轮 F-2a——tracked 脏=拒，untracked-only=放行）。\n" +
          "恢复路径：入沙箱补提交后重 apply（禁 discard——毁交付）；未提交 tracked 改动清单：\n" +
          trackedDirty.join("\n"),
      );
    }
    untrackedLeft = wtPorcelain.split("\n").filter((l) => l.trim().startsWith("??")).length;
  }
  // mechanical out-of-bounds detection (allowlist prefix match via the
  // coversPath single source, V6-10; empty allowlist = everything allowed).
  // Out of the lock since v0.6 (the diff is a phase-2 git read; V6-29's
  // quotepath injection applies unchanged).
  // v1.3 WG G-b (O14-a): the allow source is the UNION of the pack-frozen
  // oob_allowlist and the CURRENT board scope_paths, read fresh here (board
  // upsert on the top-level MERGEABLE scope_paths key is the
  // authorization-supplement channel — R2-4). The pack side stays verbatim
  // (the server-git materialize point is untouched — freeze semantics kept);
  // deep-patching pack.sandbox is a ONE_LEVEL whole-object replace
  // (destructive) and is NOT a supplement channel. Missions without board
  // scope_paths behave exactly as before (union with an empty set — the
  // regression arm pins this).
  const allowPack = normalizePathList(p1.oobAllowlist);
  const missionNow = findMission(loadBoard(), missionId);
  const allowBoard = normalizePathList(missionNow && missionNow.scope_paths);
  const allow = [...allowPack];
  for (const entry of allowBoard) if (!allow.includes(entry)) allow.push(entry);
  const changed = listDiffNames(projectDir, p1.baseCommit, p1.branch);
  const violations = allow.length ? changed.filter((p) => !allow.some((pre) => coversPath(pre, p))) : [];
  if (violations.length) {
    throw new ToolError(
      `越界改动 ${violations.length} 项（不在 allowlist：pack ${allowPack.length} 项 + board scope_paths 增补 ${allow.length - allowPack.length} 项）：\n` +
        violations.join("\n") +
        "\n评审 verdict 应改为 fail（走 sandbox_discard 整单弃），或 board upsert 修订 mission.scope_paths 增补授权后重审再 apply",
    );
  }
  // clean merge (no-ff, fixed message) and capture the applied commit.
  // v1.6 W4 (proposal P7): same-hash no-op explicit signal — capture the
  // pre-merge tree; an unchanged tree after the merge = the branch brought
  // nothing (worker finished without committing, or empty delta). The merge
  // still settles (applied wins); the response carries the explicit signal
  // so a silent no-op can no longer read as success.
  const preTree = String(gitRun(projectDir, ["rev-parse", "HEAD^{tree}"])).trim();
  gitRun(projectDir, ["merge", "--no-ff", "--no-edit", "-m", `orch: apply ${missionId}`, p1.branch]);
  const appliedCommit = String(gitRun(projectDir, ["rev-parse", "HEAD"])).trim();
  const postTree = String(gitRun(projectDir, ["rev-parse", "HEAD^{tree}"])).trim();
  const noopMerge = preTree === postTree;
  // v1.3 WG G-b: the receipt names the actual allow origin (pack-frozen vs
  // board-supplemented) so a dual-source authorization can't silently pass
  // for pack-only.
  return {
    appliedCommit,
    noopMerge,
    untrackedLeft,
    allowSources: {
      pack_oob_allowlist: allowPack.length,
      board_scope_paths_added: allow.length - allowPack.length,
    },
  };
}

/**
 * phase-3 of sandbox_apply (runs INSIDE withRootLock): the settle
 * transaction on a FRESH board snapshot — the re-read kills the t0
 * lost-update window (V6-08): anything written during phase-2 is in this
 * snapshot and survives the settle. Identity (id+branch+base_commit) is
 * hard-checked; status/qa drift is NOT rolled back — applied wins, surfaced
 * as response warnings (R7; strategy sentence lives in SKILL §12, C-ADD-4).
 */
function applySettleBoard(missionId, p1, p2) {
  const board = loadBoard();
  const m = findMission(board, missionId);
  if (!m) {
    throw new ToolError(
      `apply 收口失败：mission ${missionId} 已不在板上，但 merge ${p2.appliedCommit.slice(0, 10)} 已落主线——请以 git log 为准人工核对`,
    );
  }
  const sb = m.pack && m.pack.sandbox;
  if (!sb || sb.isolation !== "worktree") {
    throw new ToolError("该 mission 非沙箱派发（merge 已落主线，请人工核对）");
  }
  const at = nowIso();
  const warns = [];
  // Hard identity check: only branch/base_commit drift changes WHAT was
  // merged. Still not rolled back (git history is irreversible) — warned.
  if (String(sb.branch ?? "") !== p1.branch) {
    warns.push(`branch 漂移（intent 时 ${p1.branch}，收口时 ${String(sb.branch ?? "")}）——applied 胜出，未回滚`);
  }
  if (String(sb.base_commit ?? "") !== p1.baseCommit) {
    warns.push("base_commit 漂移——applied 胜出，未回滚");
  }
  // status/qa drift during phase-2: never a rollback (R7 applied 胜出).
  if (m.status !== "done" && m.status !== "closed") {
    warns.push(`phase-2 期间 status 漂移为 ${m.status}——applied 胜出，仍收口`);
  }
  if (m.qa && typeof m.qa === "object" && m.qa.verdict && m.qa.verdict !== "pass") {
    warns.push(`phase-2 期间 qa 漂移为 ${m.qa.verdict}——applied 胜出，仍收口`);
  }
  // v1.6 W4 (P7): same-hash no-op explicit signal — the merge settled but
  // brought zero tree change. Applied markers still land (idempotent re-entry
  // stays correct); the coordinator reads the signal and routes a real
  // content landing through a NEW porting mission (幂等重试不补合, §5.3).
  if (p2.noopMerge) {
    warns.push(
      "同哈希空转：merge 未带入任何变更（树哈希合并前后相同）——worker 完工未提交或分支零变更" +
        "（l-20261103-58ff9d 口径）；已记 applied，内容补合走新移植 mission（幂等重试不补合）",
    );
  }
  // 修订轮 F-2a：untracked-only 放行注记（tracked 脏=拒的另一态）。
  if (p2.untrackedLeft) {
    warns.push(
      `沙箱仅余未提交 untracked 残留（${p2.untrackedLeft} 项）：放行（修订轮 F-2a 注记）——merge 只吃分支提交，` +
        "untracked 不可能被合入；若本应提交的交付物在此，请入沙箱补提交后走移植 mission",
    );
  }
  // board transaction (direct object mutation, same lock, not mergeMission):
  // closed + auto-ack + applied markers + timeline.
  m.status = "closed";
  if (!missionAck(m)) m.ack = { at, by: "sandbox_apply", note: "auto: applied" };
  sb.applied_at = at;
  sb.applied_commit = p2.appliedCommit;
  m.updated_at = at;
  m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
  m.timeline.push({
    at,
    event: "sandbox:apply",
    summary: p2.recovered
      ? `applied ${p2.appliedCommit.slice(0, 10)}（crash 恢复收口：${p1.branch} 已在主线，applied_commit 取收口时 HEAD）`
      : `applied ${p2.appliedCommit.slice(0, 10)}（merge ${p1.branch} → 主线）`,
  });
  saveBoard(board);
  return {
    response: {
      ok: true,
      mission_id: missionId,
      applied_commit: p2.appliedCommit,
      branch: p1.branch,
      status: "closed",
      ack: m.ack,
      // v1.3 WG G-b: allow origin receipt (absent on the crash-recovery
      // "settled" path, which skips phase-2 and its gate entirely).
      ...(p2.allowSources ? { allow_sources: p2.allowSources } : {}),
      // v1.6 W4 (P7): 同哈希空转显式信号（树哈希合并前后相同=分支零带入）。
      ...(p2.noopMerge ? { no_op_merge: true } : {}),
      ...(p2.recovered
        ? { recovered: true, note: "intent 残留但分支已合入：crash-after-merge 恢复收口（merge-base --is-ancestor 判定）" }
        : {}),
    },
    warns,
  };
}

/**
 * teardown of sandbox_apply (runs OUTSIDE the root lock, AFTER the phase-3
 * board transaction — V6-35): a failed worktree removal can no longer throw
 * past a landed merge; it degrades to worktree_removed:false + warning, and
 * the leftovers stay discardable (sandbox_discard force path).
 */
function applyTeardown(wtDir, missionId) {
  const warns = [];
  let removed = true;
  // junction removed first so nothing can write through it mid-teardown;
  // rmSync on a junction unlinks the link, never the target.
  removeJunctionLink(wtDir);
  if (!fs.existsSync(wtDir) && !worktreeListPaths(projectDir).includes(wtDir)) {
    return { removed: true, warns }; // crash-recovery: the dead run already tore it down
  }
  try {
    gitRun(projectDir, ["worktree", "remove", wtDir]);
  } catch {
    // git refuses to delete a dirty worktree (uncommitted leftovers) — never
    // --force here: unreviewed content must not be silently destroyed.
    removed = false;
    warns.push(
      "沙箱内有未提交残留：内容不在任何 diff/commit 中，reviewer 未审，worktree 未移除（applied 已落板）；确认不要则 sandbox_discard 强弃，或先在沙箱内提交并重走评审",
    );
    try {
      withRootLock(() => {
        const board = loadBoard();
        const m = findMission(board, missionId);
        if (m) {
          m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
          m.timeline.push({
            at: nowIso(),
            event: "sandbox:worktree_left",
            summary: `worktree 残留未移除：${displayPath(wtDir)}（applied 已落板，残留可 sandbox_discard 强弃）`,
          });
          saveBoard(board);
        }
      });
    } catch {
      /* best effort — the response warning already carries the signal */
    }
  }
  removeJunctionLink(wtDir); // 补刀 in case worktree remove left the link
  return { removed, warns };
}

/** Best-effort intent cleanup after a tool-visible phase-2 failure. Only a
 *  process death may leave a dangling intent (the merge-base three-state
 *  path self-heals it on re-entry); a thrown error must not occupy the 10min
 *  busy window. The applied_at guard keeps a completed apply's audit trail. */
function clearApplyIntentBestEffort(missionId) {
  try {
    withRootLock(() => {
      const board = loadBoard();
      const m = findMission(board, missionId);
      const sb = m && m.pack && m.pack.sandbox;
      if (sb && sb.apply_intent_at && !sb.applied_at) {
        delete sb.apply_intent_at;
        saveBoard(board);
      }
    });
  } catch {
    /* best effort — worst case the stale intent takes the merge-base path */
  }
}

/** v0.6 (V6-08, §2.7): intent freshness — the 10min window. Malformed or
 *  future timestamps read as stale (gates re-run; the worst case is a
 *  harmless converging double merge, "Already up to date"). */
function applyIntentFresh(intentAt) {
  const t = Date.parse(String(intentAt ?? ""));
  if (!Number.isFinite(t)) return false;
  const age = Date.now() - t;
  return age >= 0 && age < APPLY_INTENT_FRESH_MS;
}

function toolSandboxDiscard(args) {
  const missionId = safeSegment(args.mission_id, "mission_id");
  // phase-1 (in lock): sandbox gate + fresh-intent mutual exclusion.
  const p1 = withRootLock(() => discardGate(missionId));
  // phase-2 (NO lock): the git triple (prune / force-remove / branch -D).
  const p2 = discardGitTriple(p1);
  // phase-3 (in lock): fresh board, applied-wins arbitration, discard marker.
  return withRootLock(() => discardSettleBoard(missionId, p1, p2));
}

/**
 * phase-1 of sandbox_discard (runs INSIDE withRootLock): gates only, no
 * board write. A fresh apply intent rejects the discard — apply 与 discard
 * 互斥（V6-08）: deleting the branch under a running merge would break the
 * apply mid-pipeline. A stale (or absent, or consumed) intent falls through.
 */
function discardGate(missionId) {
  const board = loadBoard();
  const m = findMission(board, missionId);
  if (!m) throw new ToolError(`mission not found: ${missionId}`);
  // gate: sandbox record present (non-sandbox missions are never touched).
  const sb = m.pack && m.pack.sandbox;
  if (!sb || sb.isolation !== "worktree") {
    throw new ToolError("该 mission 无沙箱记录");
  }
  if (sb.apply_intent_at && !sb.applied_at && applyIntentFresh(sb.apply_intent_at)) {
    throw new ToolError(
      "apply 在飞（apply_intent_at 在 10min 新鲜窗内且未 applied）：discard 与 apply 互斥；" +
        "等 apply 收口后再 discard，或 intent 过期后重试强弃",
    );
  }
  // Whether the archive was ALREADY applied when the discard started: a
  // post-apply leftover cleanup (V6-35's worktree_removed:false path) is a
  // legitimate discard and must proceed; only an apply that RACES us
  // (absent at phase-1, present at phase-3) wins the arbitration.
  return { wtDir: path.resolve(String(sb.root)), branch: String(sb.branch), sawApplied: Boolean(sb.applied_at) };
}

/**
 * phase-2 of sandbox_discard (runs OUTSIDE the root lock): self-heal stale
 * metadata, then force-remove the registered worktree (discard semantics =
 * abandon; --force here and ONLY here — the main repo is untouched either
 * way), then branch -D (missing branch is fine — idempotent).
 */
function discardGitTriple(p1) {
  try {
    gitRun(projectDir, ["worktree", "prune"]);
  } catch {
    /* best effort */
  }
  let worktreeRemoved = false;
  removeJunctionLink(p1.wtDir);
  if (worktreeListPaths(projectDir).includes(p1.wtDir)) {
    gitRun(projectDir, ["worktree", "remove", "--force", p1.wtDir]);
    worktreeRemoved = true;
  } else if (fs.existsSync(p1.wtDir)) {
    // Unregistered leftover directory: still sandbox-only storage.
    fs.rmSync(p1.wtDir, { recursive: true, force: true });
    worktreeRemoved = true;
  }
  removeJunctionLink(p1.wtDir);
  let branchDeleted = false;
  try {
    gitRun(projectDir, ["branch", "-D", p1.branch]);
    branchDeleted = true;
  } catch {
    /* already gone */
  }
  return { worktreeRemoved, branchDeleted };
}

/**
 * phase-3 of sandbox_discard (runs INSIDE withRootLock): the board marker on
 * a FRESH snapshot. status untouched (done stays done — the coordinator
 * decides close vs re-dispatch). If an apply RACED us past phase-1 (applied_at
 * absent there, present here) its markers outrank a discard stamp — abort
 * loudly. An archive that was already applied BEFORE the discard started is
 * the legitimate leftover-cleanup path (V6-35) and proceeds normally.
 */
function discardSettleBoard(missionId, p1, p2) {
  const board = loadBoard();
  const m = findMission(board, missionId);
  if (!m) throw new ToolError(`mission not found: ${missionId}`);
  const sb = m.pack && m.pack.sandbox;
  if (!sb || sb.isolation !== "worktree") {
    throw new ToolError("该 mission 无沙箱记录");
  }
  if (sb.applied_at && !p1.sawApplied) {
    throw new ToolError(
      `discard 中止：mission 已被并发 apply 收口（applied_at=${sb.applied_at}）。` +
        "worktree/branch 清理已执行、板面未标记 discarded——请以 applied 事实为准核对面板",
    );
  }
  const at = nowIso();
  sb.discarded_at = at;
  m.updated_at = at;
  m.timeline = Array.isArray(m.timeline) ? m.timeline : [];
  m.timeline.push({ at, event: "sandbox:discard", summary: `弃 ${String(sb.branch)} 与 worktree（主仓零改动）` });
  saveBoard(board);
  // response (idempotent: second call succeeds with false flags).
  return {
    ok: true,
    mission_id: missionId,
    branch_deleted: p2.branchDeleted,
    worktree_removed: p2.worktreeRemoved,
    note: "主仓零改动；mission 状态未变，可重派或 close",
  };
}

export {
  toolSandboxApply,
  toolSandboxDiscard,
};
