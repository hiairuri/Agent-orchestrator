// agent-orchestrator orch server — memory attachments：global memory 节/digest/orch_md ver-sync/glean 门与固定包（机械拆分自 server.mjs L10432-11081）
import fs from "node:fs";
import path from "node:path";
import {
  rootId, projectDir, nowIso, atomicWriteFileSync, log, escapeDataBlock, pidAlive,
} from "./server-core.mjs";
import { memoryRoot, ORCH_MD_FILE, globalLessonsFile } from "./server-boot.mjs";
import { loadLessons, lessonsFile } from "./server-lessons.mjs";
/* ------------------------------------------------------------------ */
/* v0.8 §7.2: global memory pack section (cap 50 lines / 2KB)          */
/* ------------------------------------------------------------------ */

const GLOBAL_MEM_MAX_LINES = 50;
const GLOBAL_MEM_MAX_BYTES = 2 * 1024;

/** Byte-cap a UTF-8 string keeping the head, without splitting a code point. */
function byteSliceUtf8(s, maxBytes) {
  let out = String(s ?? "");
  while (out.length > 0 && Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
  return out;
}

/** §7.2 conditional GLOBAL MEMORY section lines, or [] when absent (CR-04):
 * no <memoryRoot>/AGENTS.md, an empty one, or the pack_global_section switch
 * set false in glean.cfg.json (the §17-OPEN-2 anti-double-injection switch;
 * v0.9 C6/HOST-01b: defaults to false — opt-in, see readGleanCfg). The body
 * renders line-structure-preserving control-free (escapeDataBlock —
 * experience data must not forge pack line structure). */
function buildGlobalMemoryLines() {
  const cfg = readGleanCfg();
  if (cfg.pack_global_section === false) return [];
  let raw;
  try {
    raw = fs.readFileSync(path.join(memoryRoot, "AGENTS.md"), "utf8");
  } catch {
    return []; // no global memory file → whole section absent (CR-04)
  }
  const body = String(raw).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!body.trim()) return [];
  const allLines = body.split("\n");
  let truncated = allLines.length > GLOBAL_MEM_MAX_LINES;
  let text = escapeDataBlock(allLines.slice(0, GLOBAL_MEM_MAX_LINES).join("\n"));
  if (Buffer.byteLength(text, "utf8") > GLOBAL_MEM_MAX_BYTES) {
    text = byteSliceUtf8(text, GLOBAL_MEM_MAX_BYTES);
    truncated = true;
  }
  if (truncated) text += `\n... (truncated; full text at ${path.join(memoryRoot, "AGENTS.md")})`;
  return text.split("\n");
}

/* ------------------------------------------------------------------ */
/* v1.1 W3 §3 (Q11 B+C): project digest read face — v1.6 W3a 起消费面=   */
/* board/list glean_due.digest 新鲜度子键（tool-board 只读）+ gleaner     */
/* brief.digest 路径物化（dormant 保留面，OPEN-5）；pack 渲染面已退役      */
/* （R6，buildDigestSection 墓碑见下），写面=orch-gleaner 不变。          */
/* Caps G4: 12 lines / 1200B.                                           */
/* ------------------------------------------------------------------ */

const DIGEST_MAX_LINES = 12;
const DIGEST_MAX_BYTES = 1200;

/** Digest md file (<memoryRoot>/digest/<rootId>/pack-tail-digest.md; DESIGN §3.1;
 * v1.4 C1 甲分键：rootId 段隔离跨项目串味（memoryRoot 全局单例下各根各键）。
 * 旧单例 digest/pack-tail-digest.md 零迁移（M-3：读侧只读新分键，缺席=missing
 * fail-safe；旧物列 W4 E2 盘点候删）。 */
function digestMdFile() {
  return path.join(memoryRoot, "digest", rootId, "pack-tail-digest.md");
}

/** Digest sidecar with the generation-time source fingerprint (DESIGN §3.1; v1.4 C1 同构分键). */
function digestJsonFile() {
  return path.join(memoryRoot, "digest", rootId, "pack-tail-digest.json");
}

/** Current source fingerprint for digest freshness (pack RULES: lessons.jsonl
 * mtime + non-empty line count; AGENTS.md mtime participates when the digest
 * sidecar recorded it). */
function digestSourcesNow() {
  const src = { lessons_lines: lessonsLineCount(lessonsFile()), lessons_mtime_ms: null };
  try {
    src.lessons_mtime_ms = fs.statSync(lessonsFile()).mtimeMs;
  } catch {
    /* no project lessons library → count 0 / mtime null */
  }
  try {
    src.agents_md_mtime_ms = fs.statSync(path.join(memoryRoot, "AGENTS.md")).mtimeMs;
  } catch {
    src.agents_md_mtime_ms = null;
  }
  return src;
}

// v1.2 M8-1 (A-v0120-STL; O2 终裁): STALE 分级渲染 — drift 按 N=5 绝对数分级
// （≤5 轻微=态势面大概率仍有效；>5 显著=建议触发归敛；mtime 类无数值漂移或
// NaN → drift:null → 显著，fail-safe 侧：无法担保新鲜即按显著处理）。分级文案
// 烘入 stale_reason 渲染串（两注入头模板零改携带分级：context_pack 节头 + 纯区
// dispatch 前缀），结构化契约 {field,want,now,drift} 随 stale_detail 输出
// （card-memory-views.md §5 消费面；旧文案 `lessons_lines W ≠ N` 为新文案前缀，
// 考古兼容）。
const DIGEST_DRIFT_N = 5;
function digestGradedStaleReason(field, want, now) {
  const nWant = Number(want);
  const nNow = Number(now);
  const drift =
    field === "lessons_lines" && Number.isFinite(nWant) && Number.isFinite(nNow)
      ? Math.abs(nNow - nWant)
      : null;
  const minor = drift !== null && drift <= DIGEST_DRIFT_N;
  const head = field === "lessons_lines" ? `${field} ${want} != ${now}` : `${field} mismatch`;
  const tail = drift !== null ? `drift ${drift}${minor ? "<=" : ">"}${DIGEST_DRIFT_N}` : "drift unknown";
  const grade = minor ? "minor - the situation face is most likely still valid" : "significant - suggest triggering a gleaning round";
  return { text: `${head}（${tail}，${grade}）`, detail: { field, want, now, drift } };
}

/**
 * Read + validate the digest. Returns
 *   {status:"missing"|"fresh"|"stale", generated_at, lines, stale_reason, stale_detail}
 * fail-safe contract (DESIGN §3.2/§3.3 + pack RULES):
 *  - missing → the caller falls back to the two legacy memory sections
 *    (default packs stay byte-identical);
 *  - stale (fingerprint mismatch / sidecar unusable / over-cap) → the body is
 *    still renderable, tagged STALE — assembly is never blocked; fingerprint
 *    mismatches are graded by drift (M8-1, O2=N5 absolute): stale_reason keeps
 *    its render-string form (both injection-face templates consume it
 *    unchanged) and stale_detail carries {field,want,now,drift};
 *  - body lines are clamped to the G4 caps so an oversized file can never
 *    inflate the pack (clamping only affects invalid inputs).
 */
function readProjectDigest() {
  const missing = { status: "missing", generated_at: null, lines: [], stale_reason: null, stale_detail: null };
  let raw;
  try {
    raw = fs.readFileSync(digestMdFile(), "utf8");
  } catch {
    return missing;
  }
  const text = String(raw).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!text) return { ...missing, status: "stale", stale_reason: "digest file is empty" };
  const all = text.split("\n");
  const head = /^generated_at:\s*(.+?)\s*$/.exec(all[0] || "");
  const generatedAt = head ? head[1] : null;
  const body = head ? all.slice(1) : all;
  // v1.1 W6 (QA P2-a): GL-32 caps the digest BODY (正文 ≤12 行/≤1200B), so the
  // first `generated_at` line must not consume the line/byte budget. Judging by
  // all.length made a spec-conforming 12-line body permanently STALE.
  const bodyBytes = Buffer.byteLength(body.join("\n"), "utf8");
  let staleReason = head ? null : "digest first line missing generated_at";
  if (!staleReason && (body.length > DIGEST_MAX_LINES || bodyBytes > DIGEST_MAX_BYTES)) {
    staleReason = `digest over cap (body ${body.length} lines/${bodyBytes}B > ${DIGEST_MAX_LINES} lines/${DIGEST_MAX_BYTES}B)`;
  }
  // Clamp to the body caps (never render an unbounded section).
  let lines = body.length > DIGEST_MAX_LINES ? body.slice(0, DIGEST_MAX_LINES) : body;
  let joined = lines.join("\n");
  if (Buffer.byteLength(joined, "utf8") > DIGEST_MAX_BYTES) joined = byteSliceUtf8(joined, DIGEST_MAX_BYTES);
  lines = joined ? joined.split("\n") : [];
  if (!staleReason && !lines.length) staleReason = "digest body is empty";
  // Source fingerprint (generation-time vs current). Mismatch reasons are
  // graded in place (M8-1, O2=N5): stale_reason stays the render string, the
  // structured {field,want,now,drift} rides stale_detail (card §5 contract).
  let staleDetail = null;
  if (!staleReason) {
    let side = null;
    try {
      side = JSON.parse(fs.readFileSync(digestJsonFile(), "utf8"));
    } catch {
      side = null;
    }
    const want = side && side.sources && typeof side.sources === "object" ? side.sources : null;
    // v1.4 C1 乙（侧车加固）：rootId 指纹失配 → 按 missing 处理（fail-safe 契约，见上
    // missing 语义注记）——跨项目侧车互不采信；旧单例侧车无 rootId 字段同失配（零迁移读侧）。
    // 侧车整体缺失/不可解析（side=null）维持既有 STALE 契约（W3-DG-07），不入本腿。
    if (side && String(side.rootId) !== String(rootId)) {
      return missing;
    }
    const now = digestSourcesNow();
    if (!want) staleReason = "digest fingerprint sidecar missing/unparsable";
    else if (Number(want.lessons_lines) !== now.lessons_lines) {
      const g = digestGradedStaleReason("lessons_lines", want.lessons_lines, now.lessons_lines);
      staleReason = g.text;
      staleDetail = g.detail;
    } else if ((want.lessons_mtime_ms ?? null) !== now.lessons_mtime_ms) {
      const g = digestGradedStaleReason("lessons_mtime_ms", want.lessons_mtime_ms, now.lessons_mtime_ms);
      staleReason = g.text;
      staleDetail = g.detail;
    } else if (
      Object.prototype.hasOwnProperty.call(want, "agents_md_mtime_ms") &&
      (want.agents_md_mtime_ms ?? null) !== now.agents_md_mtime_ms
    ) {
      const g = digestGradedStaleReason("agents_md_mtime_ms", want.agents_md_mtime_ms, now.agents_md_mtime_ms);
      staleReason = g.text;
      staleDetail = g.detail;
    }
  }
  return {
    status: staleReason ? "stale" : "fresh",
    generated_at: generatedAt,
    lines,
    stale_reason: staleReason,
    stale_detail: staleDetail,
  };
}

/** §3.2 consumption: only replace the two legacy memory sections when at least
 * one of them would render (default packs stay byte-identical). Digest body is
 * rendered line-structure-preserving control-free (same discipline as GLOBAL
 * MEMORY); a stale digest renders with an explicit STALE tag (never blocks).
 * v1.6 W3a RETIRED (design §3.1 R6, C-01 订正): the pack-face PROJECT DIGEST
 * renderer and its consumption chain (tool-pack import/call/replace-block/
 * plumb + the dispatch message face, R1) are retired — buildPackMarkdown
 * falls back to the two legacy memory sections (pre-digest baseline behavior).
 * readProjectDigest itself is RETAINED: its remaining consumers are the
 * board-list glean_due.digest freshness subkey (tool-board, dormant glean
 * signal face — same retention discipline as the W2 cap-cfg keys) and the
 * gleaner brief.digest path materialization (OPEN-5 dormant, v1.7 audit wave).
 * 墓碑注记随批：digest.mjs 套件（pack 面+due.digest 信号腿 subject）同波退役。 */

/* ------------------------------------------------------------------ */
/* v0.8 §4: ORCH.md ver-sync piggyback (§4.2). Attached to every       */
/* SUCCESSFUL tools/call result — never to error results, never to     */
/* tools/list (§4.2②). Process-memory baseline; a stdio server is one  */
/* process per session by convention, so the baseline is session-      */
/* scoped (§4.2①); even a reused process converges (at most one call   */
/* late). Cap: 120 lines / 10KB, first reached (§4.1); over-cap the    */
/* server truncates and flags truncated:true + a hint line — gleaning  */
/* owns the shrink, the server only bounds the blast radius.           */
/* v1.3 W4 (E): caps are cfg-driven opt-in via glean.cfg.json keys     */
/* orch_md_max_lines / orch_md_max_bytes (per-key junk fallback, same  */
/* contract as the gate numerics). The constants below are demoted to  */
/* the DEFAULT SOURCES — identifiers retained (lint-manifest pin);     */
/* defaults keep the pre-W4 behavior byte-identical. No process-level  */
/* cache: cfg is re-read per call (G12/cap assertions rely on hot cfg  */
/* writes taking effect on the very next call).                        */
/* ------------------------------------------------------------------ */

const ORCH_MD_MAX_LINES = 120;
const ORCH_MD_MAX_BYTES = 10 * 1024;

/** v1.3 W4 (E): cap-bytes rendering for the truncation hint and the baked
 * pack RULES sentence — 1024 multiples render as "NKB" (default 10240 →
 * "10KB", byte-identical to the pre-W4 literal), other values as raw bytes. */
const fmtCapBytes = (b) => (b % 1024 === 0 ? `${b / 1024}KB` : `${b}B`);

/** Parse the `<!-- orch-memory ver=<N> updated=<ISO8601> -->` header (§4.1). */
function parseOrchMdHeader(text) {
  const m = /<!--\s*orch-memory\s+ver=(\d+)\s+updated=([^>]*?)\s*-->/.exec(
    String(text ?? "").slice(0, 512),
  );
  return m ? { ver: Number(m[1]) || 0, updated_at: m[2] } : null;
}

function orchMdStat() {
  try {
    const st = fs.statSync(ORCH_MD_FILE());
    return { bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function orchMdRead() {
  try {
    return fs.readFileSync(ORCH_MD_FILE(), "utf8");
  } catch {
    return null;
  }
}

/* v1.6 W2 (指令①, design §2.5): the ver-sync piggyback attachment builder
 * (orchMdAttachment — initial/changed/removed three-state push, both
 * surfacings) is REMOVED here. ORCH.md is no longer pushed to tool
 * results: no top-level `orch_memory.orch_md` attachment key and no
 * content-plane `orch_md` key (the central injection in server.mjs
 * handleToolsCall goes permanently dormant — orch_md is never present).
 * Coordinator consumption is pull-only: /manual full re-read + on-demand
 * probe file.head ORCH.md (SKILL OV-9/MM-19, commands/manual.md step 2).
 * RETAINED on purpose (removal whitelist, design §2.5): ver-header
 * parsing (parseOrchMdHeader), orchMdStat/orchMdRead (glean-brief
 * materialization fields), the two cap cfg keys orch_md_max_lines/_bytes
 * (readGleanCfg junk fallback + ORCH_MD_MAX_LINES/_BYTES default sources)
 * consumed by the glean-pack RULES cap sentence (SYNC-20/21) and GL-20
 * view maintenance — none of these push anything anywhere. */

/* ------------------------------------------------------------------ */
/* v0.8 §6.1: glean gate + due signal (signal-chain, same pattern as   */
/* the condense signal; server cannot spawn — a due gate only          */
/* materializes glean-brief.json + the fixed glean-pack.md (glean3)    */
/* and piggybacks the signal; the coordinator decides whether to       */
/* launch orch-gleaner).                                                */
/* ------------------------------------------------------------------ */

/** §6.1/§17: built-in defaults, file-overridable via <memoryRoot>/glean.cfg.json
 * (all caps concentrate here; W3 landed the full file face — cfg→gate wiring
 * with per-key junk fallback). Junk values fall back. */
function readGleanCfg() {
  // v0.9 (C6/HOST-01b): pack_global_section default flips true→false. The host
  // user-level injection face is source-verified (designs/
  // agent-orchestrator-v0.9-C6-findings.md — ~/.zcode/AGENTS.md enters the
  // subagent context chain by default, scope "user"), so the pack GLOBAL
  // MEMORY section becomes opt-in to avoid double-channel injection
  // (v0.9-DESIGN §8 decision rule; §17-OPEN-2 closure).
  // v1.3 (W1, A 题 O7=a): busy_channel_events 默认 40（≈2 天增速实测校准）；0=合法关断值
  // （仅 junk/负值回落 40）——零代码回滚通道=cfg 写 busy_channel_events:0。
  // v1.3 (W4, E): ORCH.md 帽两键 opt-in——ORCH_MD_MAX_LINES/_BYTES 常量降为默认值来源
  // （标识符保留，lint-manifest 钉）；缺省键=缺省帽（零行为变更），junk/负值逐键回落同法。
  const defaults = { idle_hours: 48, new_events: 10, lock_stale_hours: 1.5, pack_global_section: false, busy_channel_events: 40, orch_md_max_lines: ORCH_MD_MAX_LINES, orch_md_max_bytes: ORCH_MD_MAX_BYTES };
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(memoryRoot, "glean.cfg.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const cfg = { ...defaults, ...parsed };
      if (!Number.isFinite(Number(cfg.idle_hours)) || Number(cfg.idle_hours) < 0)
        cfg.idle_hours = defaults.idle_hours;
      if (!Number.isFinite(Number(cfg.new_events)) || Number(cfg.new_events) < 0)
        cfg.new_events = defaults.new_events;
      if (!Number.isFinite(Number(cfg.busy_channel_events)) || Number(cfg.busy_channel_events) < 0)
        cfg.busy_channel_events = defaults.busy_channel_events; // v1.3 W1: 0 合法关断不回落
      // v1.3 W4 (E): cap keys — junk/negative fall back per-key (same contract
      // as the gate numerics; 0 stays a legal degenerate opt-in cap).
      if (!Number.isFinite(Number(cfg.orch_md_max_lines)) || Number(cfg.orch_md_max_lines) < 0)
        cfg.orch_md_max_lines = defaults.orch_md_max_lines;
      if (!Number.isFinite(Number(cfg.orch_md_max_bytes)) || Number(cfg.orch_md_max_bytes) < 0)
        cfg.orch_md_max_bytes = defaults.orch_md_max_bytes;
      if (!Number.isFinite(Number(cfg.lock_stale_hours)) || Number(cfg.lock_stale_hours) <= 0)
        cfg.lock_stale_hours = defaults.lock_stale_hours;
      // v0.8 (W3): the §7.2 switch normalizes too — boolean and boolean-like
      // string pass, junk falls back to the default (v0.9 C6: false). The §7.2
      // consumer tests `=== false`, so an unnormalized junk value (e.g. "no", 0
      // as a string) would silently keep the section on despite the operator's
      // intent — same per-key fallback contract as the three numerics above.
      if (cfg.pack_global_section === true || cfg.pack_global_section === "true") {
        cfg.pack_global_section = true;
      } else if (cfg.pack_global_section === false || cfg.pack_global_section === "false") {
        cfg.pack_global_section = false;
      } else {
        cfg.pack_global_section = defaults.pack_global_section;
      }
      return cfg;
    }
  } catch {
    /* no/malformed cfg file → built-in defaults */
  }
  return defaults;
}

/** Non-empty line count of a lessons.jsonl (missing file = 0). */
function lessonsLineCount(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/** §9.2/§6.4 (v0.9 C3-b): single authority for the glean lock location —
 * gleanLockInfo and the brief's lock_path field both derive from this one
 * function, so glean-pack annotations reference brief.lock_path instead of
 * hand-written path copies (template incident ①, DESIGN §0.2-1). */
const gleanLockPath = () => path.join(memoryRoot, "glean-lock.json");

/** §6.4 lock reading for the signal path: {busy, lastGleanMs, lock}. A done
 * lock is the "last glean" reading (finished_at, mtime fallback — mtime dual
 * use,决议 D4). An active lock with a LIVE pid inside the stale window is
 * busy; a dead pid or an absolutely expired lock (lock_stale_hours) is
 * reclaimable → not busy (the gleaner takes over on its attempt).
 *
 * Two-lock contract (v0.8 W3, §6.4): this is a READ-ONLY judgment — the
 * server never TAKES the glean lock (no wait path anywhere: busy just
 * suppresses the due signal, "busy 即退") and never deletes/rewrites the
 * file (state transitions active→done and reclaim rewrites belong to the
 * orch-gleaner agent per §9.3; consumption never removes the lock file). */
function gleanLockInfo(cfg, now = Date.now()) {
  const file = gleanLockPath();
  let lock = null;
  let mtimeMs = 0;
  try {
    const st = fs.statSync(file);
    mtimeMs = st.mtimeMs;
    lock = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { present: false, busy: false, lastGleanMs: 0, lock: null }; // never gleaned
  }
  if (!lock || typeof lock !== "object") {
    return { present: true, busy: false, lastGleanMs: mtimeMs, lock: null };
  }
  const finished = Date.parse(String(lock.finished_at ?? ""));
  const lastGleanMs = Number.isFinite(finished) ? finished : mtimeMs;
  if (lock.state !== "active") return { present: true, busy: false, lastGleanMs, lock };
  const pid = Number(lock.pid);
  if (!Number.isFinite(pid) || !pidAlive(pid)) {
    return { present: true, busy: false, lastGleanMs, lock }; // dead pid → reclaimable
  }
  const started = Date.parse(String(lock.started_at ?? ""));
  const ageMs = Number.isFinite(started) ? now - started : now - mtimeMs;
  if (Math.max(0, ageMs) > Number(cfg.lock_stale_hours) * 3600000) {
    return { present: true, busy: false, lastGleanMs, lock }; // absolutely expired → reclaimable
  }
  return { present: true, busy: true, lastGleanMs, lock };
}

/**
 * §6.1 PURE gate — true table over (time, events, lock) + the v1.3 W1 busy leg
 * (design A 题 O7=a): due ⇔ 闲时腿 ∨ 常忙腿, where
 *   闲时腿 = idleH > idle_hours ∧ events ≥ new_events
 *   常忙腿 = busy_channel_events > 0 ∧ events ≥ busy_channel_events （仅时间门不过时可达）
 * Cost order (决议 D4): time first (one stat read), 常忙腿 cfg 前置（纯键检查）先于事件
 * 计数，两腿分支互斥——事件每评估至多读一次（惰性共享），lock arbitration last.
 * lastGleanMs <= 0 means "never gleaned" (idle ∞). busy_channel_events=0（缺省键缺失
 * → NaN 同效）= legal off → 恒走旧双门（回退语义）。
 *
 * @param {object} p {now, cfg, lastGleanMs, lockBusy, countEvents: () => number}
 * @returns {due:true, idleH, events, via?: "busy"}
 *        | {due:false, stage:"time"|"events"}
 *        | {due:false, stage:"lock", busy:true}
 */
function evaluateGleanGate(p) {
  const { now, cfg, lastGleanMs, lockBusy, countEvents } = p;
  const idleMs = lastGleanMs > 0 ? Math.max(0, now - lastGleanMs) : Number.POSITIVE_INFINITY;
  const idleH = idleMs / 3600000;
  const busyN = Number(cfg.busy_channel_events); // v1.3 W1 A: 常忙腿阈值（0=合法关断）
  if (!(idleH > Number(cfg.idle_hours))) {
    // 常忙腿（v1.3 W1 A）：cfg 前置 → 事件计数（惰性单读）→ 锁仲裁，与闲时腿同成本序。
    if (!(busyN > 0)) return { due: false, stage: "time" };
    const events = countEvents();
    if (!(events >= busyN)) return { due: false, stage: "time" };
    if (lockBusy) return { due: false, stage: "lock", busy: true };
    return { due: true, idleH, events, via: "busy" };
  }
  const events = countEvents(); // cost-ordered: never reached when time failed
  if (!(events >= Number(cfg.new_events))) return { due: false, stage: "events" };
  if (lockBusy) return { due: false, stage: "lock", busy: true };
  return { due: true, idleH, events };
}

/** v1.3 W3 (D, L-8): 项目根 AGENTS.md 的 orch-mem 标记对存在性（只读，零写）——标记对
 * 只在项目根存在；全端 AGENTS.md 整文件归 gleaner 管、无标记对（防施工歧义钉死路径）。
 * 缺失=false（功能关闭语义 GL-21；本函数只读不重建）。 */
function projectAgentsMdMarkerExists() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(projectDir, "AGENTS.md"), "utf8");
  } catch {
    return false;
  }
  return raw.includes("<!-- orch-mem:begin") && raw.includes("<!-- orch-mem:end -->");
}

/** §9.2 glean-brief.json — the field snapshot the gleaner pack CONTEXT is
 * built from (coordinator pastes it verbatim into the pack). */
function materializeGleanBrief(gate, cfg, lock) {
  const list = loadLessons();
  const pending = list
    .filter((l) => l && l.status === "candidate" && l.source === "orchestrator")
      .map((l) => l.id); // §5 ORCHTEMP = source:"orchestrator" candidates (lessons stage, §5)
  let projects = [];
  try {
    projects = fs
      .readFileSync(path.join(memoryRoot, "projects.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          const r = JSON.parse(l);
          return r && r.root_id
            ? { root_id: r.root_id, path: r.project_path ?? r.path ?? null, last_seen: r.last_seen ?? null }
            : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    /* empty registry */
  }
  const orchStat = orchMdStat();
  const orchHead = orchStat ? parseOrchMdHeader(orchMdRead() ?? "") : null;
  const brief = {
    v: 1,
    generated_at: nowIso(),
    root_id: rootId,
    project_path: projectDir,
    // v0.9 (C3-b): authoritative lock pointer — glean packs annotate the
    // lock position as "<brief.lock_path>" (权威指针勿手写), never a
    // hand-written path copy (template incident ① root cure).
    lock_path: gleanLockPath(),
    // v1.1 W3 (Q11 digest B+C): authoritative digest paths — the gleaner
    // writes both files (md = ≤12 lines/1200B summary, json = source
    // fingerprint sidecar); server only reads/validates.
    digest: {
      path: digestMdFile(),
      sidecar_path: digestJsonFile(),
    },
    gate: {
      idle_hours: Number(cfg.idle_hours),
      new_events: Number(cfg.new_events),
      busy_channel_events: Number(cfg.busy_channel_events), // v1.3 W1 (L-12): 新键与 measured 同落
      measured: {
        idle_h: gate.idleH === Number.POSITIVE_INFINITY ? null : Number(gate.idleH.toFixed(1)),
        new_events: gate.events,
      },
    },
    watermarks: {
      global_lines: lessonsLineCount(globalLessonsFile()),
      project_lines: lessonsLineCount(lessonsFile()),
    },
    orchtemp_pending: pending,
    counts: {
      active: list.filter((l) => l && l.status === "active").length,
      candidate: list.filter((l) => l && l.status === "candidate").length,
    },
    projects,
    orch_md: {
      exists: Boolean(orchStat),
      ver: orchHead ? orchHead.ver : orchStat ? 0 : null,
      bytes: orchStat ? orchStat.bytes : null,
    },
    // v1.3 W3 (D, design §3.3 信号腿): 全端视图五字段只读快照——零写零重建；marker
    // 字段钉死=项目根 AGENTS.md orch-mem 标记对存在性（L-8）。
    views: {
      orch_md_exists: Boolean(orchStat),
      orch_md_ver: orchHead ? orchHead.ver : orchStat ? 0 : null,
      global_agents_md_exists: fs.existsSync(path.join(memoryRoot, "AGENTS.md")),
      global_lib_lines: lessonsLineCount(globalLessonsFile()),
      agents_md_marker_exists: projectAgentsMdMarkerExists(),
    },
    cfg,
  };
  const briefPath = path.join(memoryRoot, "glean-brief.json");
  fs.mkdirSync(memoryRoot, { recursive: true });
  // v1.3 W3 (D 兜底): 全端库 memory/ 目录顺带兜底（对照 promote mkdir 语义）——只建
  // 目录不建空壳文件（空文件与缺席在 readGlobalMemory 同为空节，但 mtime 参与 digest
  // 指纹→空壳=指纹面假信号；首建落笔权在 gleaner，有 content 才写）。
  fs.mkdirSync(path.join(memoryRoot, "memory"), { recursive: true });
  atomicWriteFileSync(briefPath, JSON.stringify(brief, null, 2) + "\n", memoryRoot);
  return briefPath;
}

/**
 * glean3 (v0.11, m-20261025-012000-glean3): the FIXED coordinator pack — zero
 * assembly. Materialized at the same gate-due call site as the brief ("brief
 * 物化后组合"): embeds the brief file verbatim (read-back of the bytes just
 * written by materializeGleanBrief, so pack ⊇ brief is byte-exact) and bakes
 * the RL rules (lock discipline / four-state disposition / view-layer boundary
 * / log discipline) + the ≤3-line pointer Return contract. The coordinator
 * dispatches with a one-line prompt pointing at this path (SKILL §10 MM-29) —
 * no hand-assembled pack, and the gleaner's final Return carries pointers only
 * (the report file reports/<ts>-glean.md is the deliverable, zero report
 * occupation of the coordinator context). No-due/busy → never written
 * (zero-byte-diff default, P9-01). CONTRACT note: the pack is materialized
 * BEFORE the mission exists, so the three-line contract ([channel]/[worker]/
 * [token]) lives in the dispatch prompt tail block, not in the pack. Lock position
 * is annotated as the brief.lock_path field (权威指针勿手写 — template
 * incident ① root cure, same rule as the brief itself). */
function materializeGleanPack(sharedCfg) {
  // v1.3 W4 (E, M-2 功能面): the RULES cap sentence renders from the actual cfg
  // (shared single read threaded from orchMemoryAttachment; solo callers read
  // their own). Not rendering here would let the server truncate at the new cap
  // while the gleaner keeps trimming at the old one — a raised cap would be
  // silently defeated (opt-in 静默打回).
  const cfg = sharedCfg || readGleanCfg();
  const capLines = Number(cfg.orch_md_max_lines);
  const capBytes = Number(cfg.orch_md_max_bytes);
  const packPath = path.join(memoryRoot, "glean-pack.md");
  let briefJson = "";
  try {
    briefJson = fs.readFileSync(path.join(memoryRoot, "glean-brief.json"), "utf8");
  } catch {
    /* read-back failure → CONTEXT 留空；brief 物化刚在本调用点同步完成，此路径常态不可达 */
  }
  const pack = [
    "# Task pack: memory gleaning (server-fixed materialized glean-pack, fixed template direct handoff - zero assembly, no standing assembler)",
    "",
    "## CONTRACT (the three-line contract is governed by the dispatch prompt tail block)",
    "[channel]/[worker]/[token]: the dispatch prompt tail block is the sole authority for the three lines and field semantics (traceability: PC-1); this pack is server-prematerialized and the token never enters the pack.",
    "kind ∈ {milestone, blocked, question, done}; summary <= 200 chars; done requires artifacts=[gleaning report path].",
    "",
    "## CONTEXT (glean-brief embedded verbatim; the snapshot is authoritative; where it conflicts with live state, live state wins and the deviation is noted in the report)",
    briefJson,
    "## READ FIRST",
    "- agents/orch-gleaner.md (persona archetype; GL-series rules follow the archetype)",
    "- always take the lock file location from the CONTEXT brief's lock_path field (authoritative pointer - never hand-write it)",
    "",
    "## TASK",
    "One memory-gleaning round: grab the lock -> consume ORCHTEMP (brief.orchtemp_pending) -> inspect candidates with four-state dispositions -> maintain the view layer (ORCH.md ver+1 / root AGENTS.md marker zone / fleet-wide AGENTS.md / fleet-wide library memory/ directory) -> write the digest (brief.digest.path + sidecar_path, cap 12 lines/1200B + source fingerprint) -> set the lock to done + watermarks -> write the gleaning report.",
    "",
    "## RULES (server-baked fixed rules, equivalent to the persona GL series)",
    "- Lock discipline (§9.3): grab the lock first (brief.lock_path, wx atomic write in the active state) before consuming; lock occupied (live PID and unexpired) -> report(kind=done, summary=\"lock occupied, skipping\") and wrap up immediately; on completion set done + finished_at + watermarks (fleet-wide line counts + per-scanned-project line-count baselines); on failure exit leaving active in place for forensics",
    "- Four-state rule: exactly one disposition per candidate - promote (promote/promote_batch merge semantics via the server, evidence in the report) / merge (same trigger+fix normalized; hits/confidence merged) / retire (retire sets the state, content kept verbatim; contradictions go through add(contradicts=<old id>) marking the old entry superseded) / retain (insufficient evidence stays candidate with the reason written in the report)",
    `- View-layer boundary: write only the view layer (ORCH.md rewritten ver+1, cap ${capLines} lines/${fmtCapBytes(capBytes)}; the root AGENTS.md is touched only inside the orch-mem marker pair, zero byte touches outside it; fleet-wide AGENTS.md cap 50 lines/2KB; a missing fleet-wide AGENTS.md or fleet-wide memory/ directory = create first (mkdir -p, first write only with content, never an empty shell; first-creation events listed in a dedicated report section)); lessons.jsonl event lines are never written directly (all changes go through the lessons tool); active lessons are never hard-deleted (retire is advisory only); a missing marker zone = the memory feature is off for that project, skip and report, never rebuild`,
    "- digest duty (keyed split per rootId): each round overwrites brief.digest.path in full (keyed path digest/<rootId>/..., each project reads its own key; first line generated_at: <ISO8601>, body <= 12 lines/<= 1200B: situation face = one sentence of project state + in-flight mission summary, time face = 3-5 recent rulings/key events; task-related search content forbidden) and brief.digest.sidecar_path ({generated_at, rootId, sources:{lessons_lines, lessons_mtime_ms, agents_md_mtime_ms, journal_tail_seq}, bytes}, rootId = brief.root_id verbatim); sources record measured values at production time; the pack side judges freshness from them",
    "- Report discipline: gleaning report = reports/<YYYYMMDD-HHmmss>-glean.md (cap 150 lines; view changes/promotions/ORCHTEMP consumption each itemized with lessons-id provenance); the report is the deliverable, and the main session reads only the report and the Return pointers",
    "- Blocked / goal conflict / unwinnable gate -> immediately report(kind=blocked, question=what the main session must decide).",
    "",
    "## RETURN (<= 3-line pointer discipline)",
    "- The final reply is at most 3 lines, pointers only, never copying report content (zero-report overhead):",
    "- Line 1: KIND=done + the report path (reports/<ts>-glean.md)",
    "- Line 2: view-change counts (file x action) + four-state counts (promote/merge/retire/retain)",
    "- Line 3: unhandled/leftover (write none if none)",
    "",
  ].join("\n");
  fs.mkdirSync(memoryRoot, { recursive: true });
  atomicWriteFileSync(packPath, pack, memoryRoot);
  return packPath;
}

/** M10 (G12, v0.11): shared gate read for BOTH signal surfaces — the orch_memory
 * attachment below and the board/list `glean_due` field (toolBoard). Pure read
 * (cfg + lock state + gate truth table over the standard event counters);
 * never writes. Extraction is behavior-preserving: gleanAttachment's local
 * computation moved verbatim (GLEAN-01..04 unchanged). */
function gleanGateRead(sharedCfg) {
  // v1.3 W4 (L-9): shared cfg passthrough from the single top-level read; solo
  // callers (tool-board glean_due surface) keep reading their own — zero change.
  const cfg = sharedCfg || readGleanCfg();
  const lock = gleanLockInfo(cfg, Date.now());
  const wmProject = Number(lock.lock && lock.lock.watermarks && lock.lock.watermarks.projects
    ? lock.lock.watermarks.projects[rootId]
    : 0) || 0;
  const wmGlobal = Number(lock.lock && lock.lock.watermarks
    ? lock.lock.watermarks.global_lines
    : 0) || 0;
  const gate = evaluateGleanGate({
    now: Date.now(),
    cfg,
    lastGleanMs: lock.lastGleanMs,
    lockBusy: lock.busy,
    countEvents: () =>
      Math.max(0, lessonsLineCount(lessonsFile()) - wmProject) +
      Math.max(0, lessonsLineCount(globalLessonsFile()) - wmGlobal),
  });
  return { gate, cfg, lock };
}

/** §6.1/§9.2: evaluate the gate; on due materialize the brief and the fixed
 * glean-pack (glean3: brief 物化后组合，zero coordinator assembly) and return
 * the signal. Busy locks short-circuit BEFORE materialization and attach only
 * {lock_state:"busy"} — no due key, no brief/pack write (CR-04: no zero-value
 * keys; the signal is re-evaluated on the next call, ignoring it is free).
 * v1.3 W4 (L-9): sharedCfg is the single top-level cfg read threaded from
 * orchMemoryAttachment (each leg previously read the file on its own). */
function gleanAttachment(sharedCfg) {
  const { gate, cfg, lock } = gleanGateRead(sharedCfg);
  if (!gate.due) {
    if (gate.busy) return { glean: { lock_state: "busy" } };
    return null;
  }
  const briefPath = materializeGleanBrief(gate, cfg, lock);
  const packPath = materializeGleanPack(cfg);
  const fmtIdle = gate.idleH === Number.POSITIVE_INFINITY ? "never-gleaned" : gate.idleH.toFixed(1);
  // v1.3 W1 A: 常忙形态 reason 保留 "threshold" 词根（GLEAN-02a :834 includes 保绿）
  const reason =
    gate.via === "busy"
      ? `busy-channel +${gate.events} events (threshold ${Number(cfg.busy_channel_events)}, idle ${fmtIdle}h < ${Number(cfg.idle_hours)}h)`
      : `idle ${fmtIdle}h ∧ +${gate.events} events (threshold ${Number(cfg.idle_hours)}h/${Number(cfg.new_events)})`;
  return {
    glean: {
      due: true,
      reason,
      brief_path: briefPath,
      pack_path: packPath,
      lock_state: "idle",
    },
  };
}

/** §8: the top-level optional `orch_memory` result key — {glean} only since
 * v1.6 W2 (指令①): the orch_md leg is REMOVED (design §2.5 — no ver-sync
 * piggyback push of any state; N9 negative nail pins both surfacings absent),
 * so the attachment now carries the glean due signal alone and is null when
 * the gate has nothing to say. Attachment failures are logged and swallowed:
 * memory piggybacking must never fail a tool result.
 * v1.3 W4 (E, L-9): ONE cfg read at the top, threaded into the glean gate /
 * pack cap-sentence rendering (L-9 禁缓存 still holds — hot glean.cfg.json
 * writes take effect on the very next call). The cfg read itself is retained
 * because the cap keys feed the fixed-pack RULES rendering (SYNC-20/21). */
function orchMemoryAttachment() {
  const out = {};
  let cfg = null;
  try {
    cfg = readGleanCfg();
  } catch (err) {
    log("glean cfg read failed (non-fatal):", (err && err.message) || String(err));
  }
  try {
    const glean = gleanAttachment(cfg);
    if (glean) Object.assign(out, glean);
  } catch (err) {
    log("glean attachment failed (non-fatal):", (err && err.message) || String(err));
  }
  return Object.keys(out).length ? out : null;
}

export {
  buildGlobalMemoryLines,
  readProjectDigest,
  // v1.6 W3a：buildDigestSection 随 R6 pack 面退役删除（墓碑注记见其原定义区）
  gleanGateRead,
  orchMemoryAttachment,
};
