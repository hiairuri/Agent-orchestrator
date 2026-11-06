// agent-orchestrator orch server — lessons：memory/lessons.jsonl 库+score/合并/晋升/global 库+lessons 工具（机械拆分自 server.mjs L2327-3238）
// v1.6 W4 (design §2.4)：+lessons 哈希读面（memory/lessons-read-state.json per-reader 基线 map，
//   list action 可选 token 参——无新短答/有新增量/读后基线前滚）+token 写闸（携 token 写 action 一律拒）。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  root, rootId, projectDir, hex, nowIso, truncateStr, escapeDataLine,
  atomicWriteFileSync, withRootLock, ToolError,
} from "./server-core.mjs";
import { memoryRoot, globalLessonsFile } from "./server-boot.mjs";
/* ------------------------------------------------------------------ */
/* lessons store (v0.3 feature A: memory/lessons.jsonl)                */
/* ------------------------------------------------------------------ */

const LESSON_TYPES = ["error-fix", "pitfall", "preference", "env-fact"];
const LESSON_STATUSES = ["candidate", "active", "superseded", "retired"];
const RETIRE_SCORE = 0.1;
const INJECT_TOP_K = 6;
const INJECT_MAX_CHARS = 1200;
// v0.8 (§3.2) inject gate: raw lessonScore below INJECT_MIN_SCORE never enters
// a pack. The gate tests the decayed health score only — LESSON_TYPE_WEIGHT
// below is never multiplied into it (weights order, the gate eliminates; the
// two are orthogonal). Telemetry derivation (recomputable; recheck §17-OPEN-5):
//   INJECT_MIN_SCORE = round(P25(active score distribution) × 0.85, 2),
// clamped to [0.30, 0.50]. v0.9 recheck (C5, 2026-10-22, after the first full
// glean cycle): P25=0.4583 → × 0.85 ≈ 0.3895 → round 0.39 (was 0.40 under the
// 2026-10-21 survey, P25=0.461; merged-library P25 unchanged — robust across
// the library set). Dynamics check: a conf=0.6 / hits=1 entry with no
// reinforcement decays to 0.39 in ≈13 days, so the gate only drops clearly
// aged entries (the whole current shelf, floor 0.4583, passes — zero behavior
// delta on the live library) and keeps a comfortable margin above the
// RETIRE_SCORE decay-retire channel — no "injected-side just filtered,
// retire-side not yet" double-standard band. Structural record (by design,
// not a defect): candidates all carry confidence=0 → score=0, so the promote
// strong branch (score≥0.7 ∧ hits≥3 ∧ age≥7d) is structurally unreachable for
// them — candidate promotion rides the cross-project branch or an
// active-first promote ("store now, judge at distill time").
// Assertion anchor: A-v090-THR-01 (tests/suites/crv8-memory.mjs).
const INJECT_MIN_SCORE = 0.39;
// v0.8 (§3.1) type weighting: ordering-only — NO type is ever filtered out
// (error-fix must rank first and stay eligible; QA F5: a hard type filter
// would cut the most actionable class). Unknown types fall back to the lowest
// weight and stay eligible.
const LESSON_TYPE_WEIGHT = { "error-fix": 1.0, "pitfall": 0.9, "env-fact": 0.8, "preference": 0.7 };

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

/** Shared jsonl row parser: bad lines are skipped (partial writes are not fatal). */
function parseLessonsText(raw) {
  const list = [];
  for (const line of String(raw ?? "").split("\n")) {
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

/** Read the project library lessons.jsonl (scope="project" by library). */
function loadLessons() {
  try {
    return parseLessonsText(fs.readFileSync(lessonsFile(), "utf8"));
  } catch {
    return [];
  }
}

/** v0.8 (§3.5/§6.6): read the global library — read side only in W2; the
 * only future writer is promote target=global (§6.7 / W5). Never written
 * by read paths or housekeep (each library maintains itself, §3.5). */
function loadGlobalLessons() {
  try {
    return parseLessonsText(fs.readFileSync(globalLessonsFile(), "utf8"));
  } catch {
    return [];
  }
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

/**
 * Auto-retire active entries: (a) score decayed below RETIRE_SCORE (the v0.3
 * channel), or (b) v0.8 (§3.4) floor retirement — confidence already bottomed
 * at the same RETIRE_SCORE water level while >= 2 distinct missions
 * counter-referenced the entry (the report lesson_refs feedback loop; note
 * "auto: lesson misses"). Retirement keeps riding the existing maintenance
 * channel — no new delete path.
 */
function housekeepLessons(list) {
  let changed = false;
  const now = Date.now();
  for (const l of list) {
    if (!l || typeof l !== "object" || l.status !== "active") continue;
    const counters = Array.isArray(l.counter_refs)
      ? [...new Set(l.counter_refs.map((x) => String(x)))].filter(Boolean)
      : [];
    // v0.8 (§3.4): floor comparison carries a 1e-9 FP tolerance — the −0.1
    // demotion chain accumulates binary residue (0.6−0.1×5 ≈ 0.10000000000000003),
    // and "已触底" must stay true across that noise.
    if ((Number(l.confidence) || 0) <= RETIRE_SCORE + 1e-9 && counters.length >= 2) {
      l.status = "retired";
      l.note = "auto: lesson misses";
      l.updated_at = nowIso();
      changed = true;
      continue;
    }
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

/** v0.8 (§6.7/W5): atomic write for the global library — same shape as
 * saveLessons, aimed at <memoryRoot>/memory/lessons.jsonl. The designed
 * writer is promote target=global only (§3.5: scope is implied by the
 * target library). Cross-project serialization rides the glean lock in
 * the designed flow (§6.4: one gleaner at a time, lock lives in the
 * memory root) — no second lock machinery is added on this path. */
function saveGlobalLessons(list) {
  fs.mkdirSync(path.dirname(globalLessonsFile()), { recursive: true });
  // v0.9 W3fix (m-20261022-180233-3051): base must be memoryRoot, not the
  // default root — an explicit --memory-root outside the project root (and
  // the production default ~/.zcode/orchestrator-memory) tripped the
  // assertInside gate with "path escapes base directory". Same shape as
  // saveLessons (which already passes memoryRoot).
  atomicWriteFileSync(
    globalLessonsFile(),
    list.map((l) => JSON.stringify(l)).join("\n") + (list.length ? "\n" : ""),
    memoryRoot,
  );
}

/**
 * v0.8 (§6.7/W5): promotion-standard evidence for promote target=global.
 * The standard BINDS THE GLEANER'S JUDGMENT (§6.7「归敛自行判定并在报告列
 * 证据」; §9.5 assigns the cross-project check to the gleaner's read-only
 * pass) — it is NOT a server-side gate: the tool answers with the evidence
 * and the caller decides, the report carries it for post-hoc audit (§15
 * risk table). Two branches, either one qualifies:
 *   1. cross-project reproduction — the merge key (type + normKey
 *      trigger/fix) appears in >= 2 registered project libraries (the
 *      source's own library counts as one sighting; sibling libraries are
 *      read read-only via the §6.6 registry — each row's library_path
 *      (v0.9 C7) is preferred, legacy rows fall back to the default layout
 *      <project_path>/.zcode/orchestrator/memory/lessons.jsonl, any row
 *      status incl. candidate; unreadable/absent siblings count no match);
 *   2. single-library strong row — raw decayed score >= 0.7 ∧ hits >= 3
 *      ∧ age >= 7 days.
 */
function promoteGlobalStandard(entry, now = Date.now()) {
  const tk = normKey(entry.trigger);
  const fk = normKey(entry.fix);
  const matchesKey = (l) =>
    l &&
    typeof l === "object" &&
    l.type === entry.type &&
    normKey(l.trigger) === tk &&
    normKey(l.fix) === fk;
  let rows = [];
  try {
    rows = parseLessonsText(fs.readFileSync(path.join(memoryRoot, "projects.jsonl"), "utf8"));
  } catch {
    /* no/unreadable registry yet: no sibling sightings */
  }
  const others = [];
  for (const r of rows) {
    if (!r || typeof r !== "object" || r.root_id === rootId) continue;
    const p = typeof r.project_path === "string" ? r.project_path : "";
    if (!p) continue;
    // v0.9 (C7): registry rows record the library_path this server instance
    // actually resolved — a sibling that ran with a custom --root is now
    // visible. Legacy rows (pre-0.9, no/invalid library_path) fall back to
    // the default layout (<project>/.zcode/orchestrator).
    const lib =
      typeof r.library_path === "string" &&
      r.library_path.trim() &&
      path.isAbsolute(r.library_path)
        ? r.library_path
        : path.join(p, ".zcode", "orchestrator", "memory", "lessons.jsonl");
    try {
      if (parseLessonsText(fs.readFileSync(lib, "utf8")).some(matchesKey)) others.push(p);
    } catch {
      /* absent/unreadable sibling library: no sighting */
    }
  }
  const crossCount = 1 + others.length; // the source library itself is one sighting
  const score = lessonScore(entry, now);
  const hits = Math.max(0, Number(entry.hits) || 0);
  const ts = Date.parse(String(entry.updated_at || ""));
  const ageDays = Number.isFinite(ts) ? Math.max(0, (now - ts) / 86400000) : 0;
  const crossPass = crossCount >= 2;
  const strongPass = score >= 0.7 && hits >= 3 && ageDays >= 7;
  return {
    branch: crossPass ? "cross-project" : strongPass ? "strong" : null,
    eligible: crossPass || strongPass,
    cross_project: { count: crossCount, others, threshold: 2, pass: crossPass },
    strong: {
      score: Number(score.toFixed(4)),
      hits,
      age_days: Number(ageDays.toFixed(2)),
      threshold: { score: 0.7, hits: 3, age_days: 7 },
      pass: strongPass,
    },
  };
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
  // v0.6 (V6-18): render-side control-char neutralization — v0.6+ rows are
  // escaped at write side already; this also covers rows written before v0.6.
  // v0.8 (§3.3): render the entry id — the anchor for the §3.4 report
  // lesson_refs feedback loop and for glean-report provenance. Costs
  // id.length + 1 ≈ 17B/line against the INJECT_MAX_CHARS budget.
  return `- [${l.type}·${String(l.id ?? "")}] 触发：${escapeDataLine(l.trigger)}\n  修正：${escapeDataLine(l.fix)}`;
}

/**
 * Select active lessons whose trigger/lesson/fix share at least one token with
 * the given text and whose raw decayed score clears INJECT_MIN_SCORE (v0.8
 * §3.2 — the gate tests health only); sorted by (overlap desc, score ×
 * LESSON_TYPE_WEIGHT desc — v0.8 §3.1 weighting re-orders but never filters a
 * type out); rendered two-line entries within the INJECT_TOP_K /
 * INJECT_MAX_CHARS budget.
 *
 * v0.8 (§3.5, INJ-06b): two-library read — global rows are considered before
 * project rows and the normKey dedup (findMergeTarget key: type + normalized
 * trigger/fix) keeps the FIRST sighting, so a global entry shadows its project
 * twin (全端优先 — the promoted distilled row wins the double display).
 * Libraries stay otherwise independent: contradicts supersedes never cross
 * libraries (a contradicts target is resolved within its own library only),
 * and housekeep runs per library on its own write paths — this read never
 * writes either library.
 */
function selectLessonsForText(text) {
  const taskTokens = tokenize(text);
  if (!taskTokens.size) return [];
  const now = Date.now();
  const seenKeys = new Set();
  const merged = [];
  for (const l of [...loadGlobalLessons(), ...loadLessons()]) {
    if (!l || typeof l !== "object" || l.status !== "active") continue;
    const key = `${l.type ?? ""}\u0000${normKey(l.trigger)}\u0000${normKey(l.fix)}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    merged.push(l);
  }
  const scored = [];
  for (const l of merged) {
    const lessonTokens = tokenize(`${l.trigger ?? ""}\n${l.lesson ?? ""}\n${l.fix ?? ""}`);
    let overlap = 0;
    for (const t of lessonTokens) if (taskTokens.has(t)) overlap += 1;
    if (overlap < 1) continue;
    const score = lessonScore(l, now);
    // v0.8 (§3.2): raw-score floor — decayed health only, orthogonal to the
    // type weight (the weight below never rescues a sub-threshold entry).
    if (score < INJECT_MIN_SCORE) continue;
    scored.push({ l, overlap, rank: score * (LESSON_TYPE_WEIGHT[l.type] ?? 0.7) });
  }
  scored.sort((a, b) => b.overlap - a.overlap || b.rank - a.rank);
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

/* ------------------------------------------------------------------ */
/* tool: lessons                                                       */
/* ------------------------------------------------------------------ */

/* --- v1.1 W1 (§5.1): promote machinery shared by promote / promote_batch ---
 * The single-id action stays byte-for-byte compatible (same response shapes);
 * the batch action reuses these plans so N promotions run under the one root
 * lock toolLessons already holds and each touched library is written once. */

/** Resolve + validate a promote target library ("" / absent → fallback). */
function resolvePromoteTarget(raw, fallback = "project") {
  const targetLib = raw == null || raw === "" ? fallback : String(raw);
  if (targetLib !== "project" && targetLib !== "global") {
    throw new ToolError(`invalid target: ${JSON.stringify(raw)}; allowed: project, global`);
  }
  return targetLib;
}

/** Validate one promote item against the project library; mutation-free plan. */
function planProjectPromote(list, id, args) {
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
  return { id, candidate, type, trigger, fix, lesson };
}

/** Apply a project-library promote plan in memory (no write — caller owns the single save). */
function applyProjectPromote(list, plan) {
  // Prospective active view for merge-key matching (candidate itself excluded).
  const others = list.filter((l) => l && l.id !== plan.id);
  const target = findMergeTarget(others, plan);
  if (target) {
    mergeIntoTarget(target, plan.candidate, plan.candidate.mission_id ?? null);
    plan.candidate.status = "retired";
    plan.candidate.note = `auto: merged into ${target.id}`;
    plan.candidate.updated_at = nowIso();
    return {
      merged: true,
      resultId: target.id,
      candidateId: plan.id,
      confidence: Number(target.confidence.toFixed(2)),
      hits: target.hits,
    };
  }
  plan.candidate.status = "active";
  plan.candidate.type = plan.type;
  plan.candidate.trigger = plan.trigger;
  plan.candidate.fix = plan.fix;
  plan.candidate.lesson = plan.lesson;
  plan.candidate.confidence = 0.6;
  plan.candidate.hits = 1;
  plan.candidate.updated_at = nowIso();
  return { merged: false, resultId: plan.id, confidence: 0.6, hits: 1 };
}

/** Validate one promote item against the global-library rules; mutation-free plan. */
function planGlobalPromote(candidate, id, args) {
  // §6.7: both candidates (cross-project reproduction evidence may rest on
  // candidate rows) and active rows (the single-library strong-row branch
  // scores only active entries) are promotable; retired/superseded history is not.
  if (candidate.status !== "candidate" && candidate.status !== "active") {
    throw new ToolError(`not promotable to global (status=${candidate.status}); only candidate/active rows are`);
  }
  // Optional refinement, same shape as the project path — with the v0.6
  // write-side discipline (escape first, then cap) on refined values.
  const type = args.type == null ? candidate.type : args.type;
  if (!LESSON_TYPES.includes(type)) {
    throw new ToolError(`invalid type: ${JSON.stringify(args.type)}; allowed: ${LESSON_TYPES.join(", ")}`);
  }
  const trigger =
    args.trigger == null ? candidate.trigger : truncateStr(escapeDataLine(args.trigger), 120).trim();
  const fix = args.fix == null ? candidate.fix : truncateStr(escapeDataLine(args.fix), 200).trim();
  if (!trigger || !fix) throw new ToolError("refined trigger/fix must stay non-empty");
  const lesson =
    args.lesson == null ? candidate.lesson ?? "" : truncateStr(escapeDataLine(args.lesson), 200);
  return { id, candidate, type, trigger, fix, lesson };
}

/** Apply a global-library promote plan in memory (no write — caller owns the single save). */
function applyGlobalPromote(globalList, plan) {
  // §3.5: housekeep runs per library — the global library keeps itself healthy
  // on this, its only write path; the caller runs it once before the batch.
  // §6.7 provenance backlink: [源条 id, 源项目路径, root_id].
  const backlink = [plan.id, projectDir, rootId];
  const standard = promoteGlobalStandard(plan.candidate);
  // Merge-key resolution runs INSIDE the global library only (§6.7) — a project
  // twin must not intercept the merge.
  const gTarget = findMergeTarget(globalList, plan);
  if (gTarget) {
    // Hit: hits+1 / confidence raised / refs union — mergeIntoTarget carries
    // the score machinery, then the backlink triple unions in.
    mergeIntoTarget(gTarget, plan.candidate, plan.candidate.mission_id ?? null);
    gTarget.refs = Array.isArray(gTarget.refs) ? gTarget.refs : [];
    for (const ref of backlink) {
      if (!gTarget.refs.includes(ref)) gTarget.refs.push(ref);
    }
    return {
      merged: true,
      resultId: gTarget.id,
      sourceId: plan.id,
      confidence: Number(gTarget.confidence.toFixed(2)),
      hits: gTarget.hits,
      refs: gTarget.refs.slice(),
      standard,
    };
  }
  // Miss: new active row — confidence 0.7 / hits 1 / scope="global" (§6.7);
  // refs = the provenance backlink triple; worker records the designed actor
  // (§6.2: promote target=global is the gleaner's move; the server has no caller
  // identity to check — §6.2 boundary note). The PROJECT source row is
  // deliberately never touched: no status flip, no field write, not even
  // updated_at (§6.7 red line — the source stays in place byte-for-byte).
  const at = nowIso();
  const entry = {
    v: 1,
    id: newLessonId(),
    ts: at,
    updated_at: at,
    mission_id: plan.candidate.mission_id ?? null,
    worker: "gleaner",
    type: plan.type,
    trigger: plan.trigger,
    lesson: plan.lesson,
    fix: plan.fix,
    confidence: 0.7,
    hits: 1,
    status: "active",
    refs: backlink.slice(),
    superseded_by: null,
    counter_refs: [],
    note: null,
    scope: "global",
    source: "promote",
  };
  globalList.push(entry);
  return {
    merged: false,
    resultId: entry.id,
    sourceId: plan.id,
    confidence: 0.7,
    hits: 1,
    refs: entry.refs.slice(),
    standard,
  };
}

/** add(contradicts) parity: supersede an active row in the same library. */
function applyContradicts(list, oldId, newId, missionId) {
  const old = list.find((l) => l && l.id === oldId);
  if (!old || old.status !== "active") return; // non-active targets are ignored silently (add parity)
  old.status = "superseded";
  old.superseded_by = newId;
  old.updated_at = nowIso();
  if (missionId) {
    old.counter_refs = Array.isArray(old.counter_refs) ? old.counter_refs : [];
    if (!old.counter_refs.includes(missionId)) old.counter_refs.push(missionId);
  }
}

/* --- v1.6 W4 (design §2.4): lessons 哈希读面 + token 写闸 ---
 * 记账=全局 per-reader map（<存储根>/memory/lessons-read-state.json，键=reader id：
 * worker=派发 token、主控=coord-session id——同走 list 的可选 token 参传入）。
 * server 判定：当前 promoted 集（active，global+project）哈希 H vs reader 基线——
 * 相等→短答「无新增教训（基线 {ts}，在册 {n} 条）」（零写）；不等→增量=updated_at>基线 ts
 * ∧ id∉seen_ids 的条目（id/trigger/lesson/fix 全文，全端优先去重），返回后前滚基线
 * {base_hash, base_ts, seen_ids}（seen_ids 裁剪到现役∪增量，防无界增长）。
 * 首调（无基线）=建立基线+短答（包 §LESSONS 仍为初始知识源，两者正交）。
 * 写闸：携 token 的写 action（add/stage/promote/promote_batch/retire）一律拒（worker 只读面）；
 * 无 token（主控）全功能不变。registry schema 不在本波写集——token 参经 args 直传
 * （宿主 additionalProperties 透传；测试走 handler 直调）。 */
const LESSONS_WRITE_ACTIONS = ["add", "stage", "promote", "promote_batch", "retire"];

const lessonsReadStateFile = () => path.join(root, "memory", "lessons-read-state.json");

function loadLessonsReadState() {
  try {
    const obj = JSON.parse(fs.readFileSync(lessonsReadStateFile(), "utf8"));
    if (obj && typeof obj === "object" && obj.readers && typeof obj.readers === "object" && !Array.isArray(obj.readers)) {
      return { v: 1, readers: obj.readers };
    }
  } catch {
    /* absent/corrupt state = all readers first-call */
  }
  return { v: 1, readers: {} };
}

function saveLessonsReadState(state) {
  fs.mkdirSync(path.dirname(lessonsReadStateFile()), { recursive: true });
  atomicWriteFileSync(lessonsReadStateFile(), JSON.stringify(state, null, 2) + "\n");
}

/** 当前 promoted 集（active，global+project）快照：确定性哈希（id 排序后 {id,updated_at}
 *  投影序列化 sha256——合并/晋升改 updated_at 即变哈希）+ 全文条目引用（增量渲染用，
 *  全端优先 normKey 去重与读端 §3.5 同判据）。 */
function activeLessonsSnapshot() {
  const full = [];
  const seenKeys = new Set();
  for (const l of [...loadGlobalLessons(), ...loadLessons()]) {
    if (!l || typeof l !== "object" || l.status !== "active") continue;
    const key = `${l.type ?? ""}\u0000${normKey(l.trigger)}\u0000${normKey(l.fix)}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    full.push({
      id: String(l.id ?? ""),
      updated_at: String(l.updated_at ?? ""),
      type: l.type,
      trigger: l.trigger,
      lesson: l.lesson,
      fix: l.fix,
      scope: l.scope ?? "project",
    });
  }
  const projection = full
    .map((e) => ({ id: e.id, updated_at: e.updated_at }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const hash = createHash("sha256").update(JSON.stringify(projection)).digest("hex");
  return { hash, entries: full };
}

/** list action 携 token：哈希判定→短答/增量，读后基线前滚（哈希相等=零写快速路径）。 */
function lessonsHashedList(token) {
  const state = loadLessonsReadState();
  const prev = state.readers[token] ?? null;
  const snap = activeLessonsSnapshot();
  const total = snap.entries.length;
  const now = nowIso();
  if (!prev || typeof prev !== "object") {
    // 首调：建立基线 + 短答（包 §LESSONS 仍为初始知识源，两者正交——design §2.4）。
    state.readers[token] = { base_hash: snap.hash, base_ts: now, seen_ids: snap.entries.map((e) => e.id) };
    saveLessonsReadState(state);
    return {
      ok: true,
      mode: "short",
      message: `no new lessons (baseline ${now}, ${total} on record)`,
      total_active: total,
    };
  }
  if (prev.base_hash === snap.hash) {
    // 无变化：短答零写（基线原样——哈希含 updated_at，相等即全域无迁移）。
    return {
      ok: true,
      mode: "short",
      message: `no new lessons (baseline ${prev.base_ts ?? now}, ${total} on record)`,
      total_active: total,
    };
  }
  const baseTs = Date.parse(String(prev.base_ts ?? ""));
  const seen = new Set(Array.isArray(prev.seen_ids) ? prev.seen_ids.filter((id) => snap.entries.some((e) => e.id === id)) : []);
  const fresh = snap.entries.filter((e) => {
    if (seen.has(e.id)) return false;
    const t = Date.parse(e.updated_at);
    return !Number.isFinite(baseTs) || (Number.isFinite(t) && t > baseTs) || !Number.isFinite(t);
  });
  for (const e of fresh) seen.add(e.id);
  state.readers[token] = { base_hash: snap.hash, base_ts: now, seen_ids: [...seen] };
  saveLessonsReadState(state);
  return {
    ok: true,
    mode: "increment",
    message: fresh.length ? `${fresh.length} new lessons` : "library migrated but no new entries (merge/retire face)",
    total_active: total,
    new_lessons: fresh,
  };
}

function toolLessons(args) {
  // v0.3.1 (A4): lessons.jsonl is read-merged-written; the whole tool runs under
  // the root lock so concurrent merges can no longer lose updates.
  return withRootLock(() => toolLessonsInner(args));
}

function toolLessonsInner(args) {
  const action = args.action ?? "list";
  // v1.6 W4 token 写闸（design §2.4）：置顶于 housekeep 前——被拒调用零副作用。
  const token = args.token == null ? null : String(args.token).trim() || null;
  if (token && LESSONS_WRITE_ACTIONS.includes(action)) {
    throw new ToolError(
      "lessons with a token is read-only: write actions (add/stage/promote/promote_batch/retire) are always rejected" +
        " (worker write gate - no bare-unlock window; the coordinator's token-free channel keeps full write function)",
    );
  }
  const list = loadLessons();
  if (housekeepLessons(list)) saveLessons(list);

  if (action === "list") {
    // v1.6 W4 哈希读面：token 存在 → per-reader 基线判定接管响应形（status/type/q/limit
    // 过滤器不参与哈希模式——判定域恒为两库 active 全集，design §2.4 口径）。
    if (token) return lessonsHashedList(token);
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
    // v0.6 (V6-18): escape first, then cap — the library itself stays
    // single-lined (INJ-02), so neither list read-backs nor any renderer can
    // ever see raw control characters.
    const trigger = truncateStr(escapeDataLine(args.trigger), 120).trim();
    const fix = truncateStr(escapeDataLine(args.fix), 200).trim();
    if (!trigger || !fix) throw new ToolError("lessons add requires non-empty trigger and fix");
    const lesson = truncateStr(escapeDataLine(args.lesson ?? ""), 200);
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
      // v0.8 (§3.5): scope is implied by the target library (this project
      // library always writes "project"; a future promote target=global is
      // the only "global" writer) — never a caller parameter. source records
      // the write path ("report" | "add" | "orchestrator" — stage, §5).
      scope: "project",
      source: "add",
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

  // v0.8 (§5): ORCHTEMP staging — the coordinator's quick-capture surface.
  // Writes a source:"orchestrator" candidate (confidence 0 / hits 0) WITHOUT
  // findMergeTarget merging (staged entries stay independent; merging is the
  // gleaner's consumption-time job) and without injection risk (candidates
  // never pass selectLessonsForText, §5). Consumption = lessons retire with a
  // view-pointer reason ("glean: → <视图#位置>", §6.3 red line ①: content is
  // never deleted — the row stays in the jsonl with its trigger/fix intact).
  if (action === "stage") {
    // §5 signature omits type; an explicit one is honored, absent falls back
    // to "pitfall" (the same default the report-candidate path uses). A wrong
    // explicit type is an error — add-grade strictness for a direct call.
    const type = args.type == null ? "pitfall" : args.type;
    if (!LESSON_TYPES.includes(type)) {
      throw new ToolError(
        `invalid type: ${JSON.stringify(args.type)}; allowed: ${LESSON_TYPES.join(", ")}`,
      );
    }
    // v0.6 (V6-18): escape first, then cap (same order as add/report candidates).
    const trigger = truncateStr(escapeDataLine(args.trigger), 120).trim();
    const fix = truncateStr(escapeDataLine(args.fix), 200).trim();
    if (!trigger || !fix) throw new ToolError("lessons stage requires non-empty trigger and fix");
    const lesson = truncateStr(escapeDataLine(args.lesson ?? ""), 200);
    const missionId = args.mission_id == null ? null : String(args.mission_id);
    // note = placement hint for the gleaner (e.g. "pin: AGENTS.md" → land it
    // in the marker section first). Data-line discipline applies to it too.
    const note = args.note == null ? null : truncateStr(escapeDataLine(args.note), 200);
    const at = nowIso();
    const entry = {
      v: 1,
      id: newLessonId(),
      ts: at,
      updated_at: at,
      mission_id: missionId,
      worker: "coordinator",
      type,
      trigger,
      lesson,
      fix,
      confidence: 0,
      hits: 0,
      status: "candidate",
      refs: missionId ? [missionId] : [],
      superseded_by: null,
      counter_refs: [],
      note,
      // v0.8 (§3.5/§5): implied scope + write-path provenance — stage rows
      // carry source:"orchestrator", the ORCHTEMP marker the glean brief's
      // orchtemp_pending filter reads (§9.2).
      scope: "project",
      source: "orchestrator",
    };
    list.push(entry);
    saveLessons(list);
    return { ok: true, id: entry.id, status: "candidate", source: "orchestrator" };
  }

  if (action === "promote") {
    if (args.id == null || !String(args.id).trim()) throw new ToolError('lessons promote requires "id"');
    const id = String(args.id).trim();
    // v0.8 (§6.7/W5): optional target — absent/""/"project" keeps the
    // library-internal promotion byte-for-byte (§8 compat row); "global"
    // copies the row into the global library and leaves the project source
    // row untouched (double display is handled by the read side, §3.5).
    const targetLib = resolvePromoteTarget(args.target);
    const candidate = list.find((l) => l && l.id === id);
    if (!candidate) throw new ToolError(`lesson not found: ${id}`);

    if (targetLib === "global") {
      const plan = planGlobalPromote(candidate, id, args);
      // §3.5: housekeep runs per library — the global library keeps itself
      // healthy on this, its only write path (same function, decay rules;
      // the read side never writes either library).
      const globalList = loadGlobalLessons();
      housekeepLessons(globalList);
      const out = applyGlobalPromote(globalList, plan);
      saveGlobalLessons(globalList);
      return out.merged
        ? {
            ok: true,
            id: out.resultId,
            merged: true,
            target: "global",
            source_id: out.sourceId,
            confidence: out.confidence,
            hits: out.hits,
            refs: out.refs,
            standard: out.standard,
          }
        : {
            ok: true,
            id: out.resultId,
            status: "active",
            merged: false,
            target: "global",
            source_id: out.sourceId,
            confidence: out.confidence,
            hits: out.hits,
            refs: out.refs,
            standard: out.standard,
          };
    }

    const plan = planProjectPromote(list, id, args);
    const out = applyProjectPromote(list, plan);
    saveLessons(list);
    return out.merged
      ? {
          ok: true,
          id: out.resultId,
          merged: true,
          candidate_id: out.candidateId,
          confidence: out.confidence,
          hits: out.hits,
        }
      : { ok: true, id: out.resultId, status: "active", merged: false, confidence: out.confidence, hits: out.hits };
  }

  // v1.1 W1 (§5.1): transactional batch promote — the whole batch runs under
  // the one root lock toolLessons already holds. Every item is validated and
  // applied in memory first; any invalid id/status/refinement rejects the batch
  // with ZERO library writes (no half-state). After all items succeed each
  // touched library is written exactly once (findMergeTarget/escape/merge and
  // the global backlink semantics are the same as the single-id action).
  // Single-file atomicity: a batch mixing project+global items touches two
  // files (global written first, then project) — two files cannot share one
  // atomic rename, so cross-library joint atomicity is explicitly not claimed.
  if (action === "promote_batch") {
    if (!Array.isArray(args.ids) || args.ids.length === 0) {
      throw new ToolError('lessons promote_batch requires a non-empty "ids" array');
    }
    const items = args.ids.map((raw, i) => {
      if (typeof raw === "string") {
        const id = raw.trim();
        if (!id) throw new ToolError(`promote_batch item ${i}: id must be a non-empty string`);
        return { id, args: { target: args.target }, contradicts: null };
      }
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        if (raw.id == null || !String(raw.id).trim()) {
          throw new ToolError(`promote_batch item ${i}: object needs a non-empty "id"`);
        }
        const contradicts = raw.contradicts == null ? null : String(raw.contradicts).trim() || null;
        return {
          id: String(raw.id).trim(),
          args: {
            target: raw.target == null ? args.target : raw.target,
            type: raw.type,
            trigger: raw.trigger,
            lesson: raw.lesson,
            fix: raw.fix,
          },
          contradicts,
        };
      }
      throw new ToolError(`promote_batch item ${i}: expected an id string or an object with "id"`);
    });
    const seen = new Set();
    for (const item of items) {
      if (seen.has(item.id)) throw new ToolError(`promote_batch duplicate id: ${item.id}`);
      seen.add(item.id);
    }
    // Resolve target library per item first — a bad target must reject the
    // whole batch before any in-memory mutation matters (no write either way).
    const targets = items.map((item) => resolvePromoteTarget(item.args.target));
    // The global library is loaded/housekept once for the whole batch (its
    // only write path; a batch failure still leaves the file untouched).
    let globalList = null;
    if (targets.includes("global")) {
      globalList = loadGlobalLessons();
      housekeepLessons(globalList);
    }
    const results = [];
    let projectTouched = false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const targetLib = targets[i];
      const candidate = list.find((l) => l && l.id === item.id);
      if (!candidate) throw new ToolError(`lesson not found: ${item.id}`);
      const plan = targetLib === "global"
        ? planGlobalPromote(candidate, item.id, item.args)
        : planProjectPromote(list, item.id, item.args);
      if (item.contradicts) {
        if (item.contradicts === item.id) {
          throw new ToolError(`promote_batch contradicts cannot target the promoted id: ${item.id}`);
        }
        const lib = targetLib === "global" ? globalList : list;
        if (!lib.find((l) => l && l.id === item.contradicts)) {
          throw new ToolError(`contradicts target not found: ${item.contradicts}`);
        }
      }
      if (targetLib === "global") {
        const out = applyGlobalPromote(globalList, plan);
        if (item.contradicts) {
          applyContradicts(globalList, item.contradicts, out.resultId, candidate.mission_id ?? null);
        }
        results.push({
          id: item.id,
          ok: true,
          target: "global",
          merged: out.merged,
          ...(out.merged ? { merged_into: out.resultId } : { result_id: out.resultId, status: "active" }),
          confidence: out.confidence,
          hits: out.hits,
          ...(item.contradicts ? { contradicts: item.contradicts } : {}),
          standard: out.standard,
        });
      } else {
        const out = applyProjectPromote(list, plan);
        projectTouched = true;
        if (item.contradicts) {
          applyContradicts(list, item.contradicts, out.resultId, candidate.mission_id ?? null);
        }
        results.push({
          id: item.id,
          ok: true,
          target: "project",
          merged: out.merged,
          ...(out.merged ? { merged_into: out.resultId } : { result_id: out.resultId, status: "active" }),
          confidence: out.confidence,
          hits: out.hits,
          ...(item.contradicts ? { contradicts: item.contradicts } : {}),
        });
      }
    }
    if (globalList) saveGlobalLessons(globalList);
    if (projectTouched) saveLessons(list);
    return {
      ok: true,
      count: results.length,
      summary: {
        total: results.length,
        merged: results.filter((r) => r.merged).length,
        activated: results.filter((r) => !r.merged).length,
        contradicting: results.filter((r) => r.contradicts).length,
      },
      results,
    };
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
    `unknown lessons action: ${JSON.stringify(action)} (use list|add|promote|promote_batch|retire|stage)`,
  );
}

export {
  LESSON_TYPES,
  RETIRE_SCORE,
  lessonsFile,
  newLessonId,
  loadLessons,
  saveLessons,
  housekeepLessons,
  selectLessonsForText,
  toolLessons,
};
