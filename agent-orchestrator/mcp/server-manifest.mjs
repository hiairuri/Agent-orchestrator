// agent-orchestrator orch server — manifest：v0.5 S2/S5 常量+context_pack 参数解析+OWNERSHIP/BUDGET 节+done 收口管线（机械拆分自 server.mjs L5588-5917）
import fs from "node:fs";
import path from "node:path";
import {
  root, projectDir, ToolError, displayPath, truncateStr, atomicWriteFileSync,
  normalizePathList,
} from "./server-core.mjs";
/* ------------------------------------------------------------------ */
/* v0.5 S2/S5 constants + context_pack argument parsers                */
/* (design §9.1/§9.2 — single source of truth for caps and tiers)      */
/* ------------------------------------------------------------------ */

const SCOPE_PATHS_MAX = 32; // report error beyond, never silent-truncate (§9.1)
const INPUTS_MAX = 4; // mission ids per context_pack call (§9.1)
const PULL_T0_ENTRY_BYTES = 4000; // per-entry cap at routing time (§9.1)
const PULL_T0_LAYER_BYTES = 24 * 1024; // T0 total across all inputs (§9.1)
const PULL_T1_LAYER_BYTES = 4 * 1024; // SUMMARY total (§9.1)
const PULL_T2_MAX = 20; // READ FIRST appended pointer lines (§9.1)
const BUDGET_TIER_STEPS = { S: 20, M: 60, L: 120 }; // §9.2 (shared with W2/W3)

// v0.5 T2 (S1) manifest close-out caps — single source of truth §9.1. Every
// cap is enforced SOFTLY at report time: over-cap drops/truncates + a
// manifest_note, never an isError (§1.4).
const MANIFEST_MAX_ENTRIES = 12; // entries per manifest; overflow drops tail + note
const MANIFEST_T0_ENTRY_BYTES = 4000; // per-entry T0 text cap in UTF-8 bytes, keep head
const MANIFEST_T0_MAX = 8; // T0 entry count; overflow drops tail + note
const MANIFEST_T1_ENTRY_CHARS = 500; // per-entry T1 text cap in characters, keep head
const MANIFEST_TITLE_CHARS = 60; // per-entry title cap in characters, truncate
const MANIFEST_FILE_BYTES = 32 * 1024; // whole-sidecar cap; overflow drops tail + note
// Closed five-value type enum (§1.2; "summary" is deliberately illegal — CR-V19).
const MANIFEST_TYPES = ["assertion", "env_fact", "anchor", "conclusion", "directive"];
const MANIFEST_LAYERS = ["T0", "T1", "T2"];

/** scope_paths argument: array guard -> F1 -> over-cap rejects (design E1②). */
function parseScopePathsArg(value) {
  if (value == null) return [];
  const list = normalizePathList(value);
  if (list.length > SCOPE_PATHS_MAX) {
    throw new ToolError(
      `scope_paths 超限：${list.length} 项（帽 ${SCOPE_PATHS_MAX} 项，报错拒绝而非静默截断）`,
    );
  }
  return list;
}

/** budget argument: enum S/M/L guard; null when absent (design G-1). */
function parseBudgetArg(value) {
  if (value == null) return null;
  const tier = String(value).trim();
  if (tier !== "S" && tier !== "M" && tier !== "L") {
    throw new ToolError(
      'context_pack budget 必须是 "S"、"M" 或 "L"（S≈20/M≈60/L≈120 步），非法值报错拒绝',
    );
  }
  return tier;
}

/** inputs argument: string array, ≤4 mission ids; 5th id rejects (§2.1). */
function parseInputsArg(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new ToolError("context_pack inputs 必须是 mission id 字符串数组");
  }
  const ids = value.map((x) => String(x).trim()).filter((s) => s.length > 0);
  if (ids.length > INPUTS_MAX) {
    throw new ToolError(
      `inputs 超限：${ids.length} 个 mission id（帽 ${INPUTS_MAX} 个，报错拒绝而非静默截断）`,
    );
  }
  return ids;
}

/**
 * v0.5 E3: OWNERSHIP section lines (registry row 7; only when scope_paths is
 * non-empty). Wording verbatim from cost-rules §7.2 (via DESIGN §7.2①).
 */
function buildOwnershipLines(scopePaths) {
  if (!scopePaths || !scopePaths.length) return null;
  return [
    "## OWNERSHIP（文件所有权）",
    "允许写（scope_paths，越界 = 验收 fail 信号）：",
    ...scopePaths.map((p) => `- ${p}`),
    // W4 (PO 案 A): "会" filler dropped — wording aligned with the SKILL §3 sample.
    "清单外路径一律只读。done 的 files_touched 按此清单比对。",
  ];
}

/**
 * v0.5 E3: BUDGET section lines (registry row 8; only when budget is given).
 * Wording verbatim from cost-rules §7.2 + the static token-tier preview line
 * (§5.5/§9.2, DA4-5). Tier numbers {20|60|120} render from the given tier.
 * v0.5 QA (CR-V6②): L-tier packs additionally carry the pre-split doctrine
 * sentence (cost-rules §12 / CR-09) — "包内可见预拆阶段说明".
 */
function buildBudgetLines(tier) {
  if (!tier) return null;
  // W4 (PO 案 A, RL-1): one rule per line; "请/主动" attitude fillers dropped;
  // "(派发前就拆)" coordinator-facing meta dropped (worker-side rule kept).
  const lines = [
    "## BUDGET（预算档位）",
    `档位：${tier}（≈${BUDGET_TIER_STEPS[tier]} 步上限）。`,
    "milestone report 附进度与剩余步数估计。",
    "逼近上限收尾：完成当前阶段、report(done) 附遗留清单。",
  ];
  if (tier === "L") {
    lines.push("L 档附加：任务应已预拆阶段或转 workflow——你只负责当前阶段，逼近上限即按上行收尾交接。");
  }
  lines.push("上下文档位：WARN 120K 提醒 / ACT 150K 决策 / HARD 180K 强制收尾 / ABS 230K 红线（由主控对账判定，worker 无需自测）");
  return lines;
}

/** UTF-8 byte-capped truncation that never splits a code point. */
function truncateUtf8Bytes(str, cap) {
  let s = String(str);
  if (Buffer.byteLength(s, "utf8") <= cap) return s;
  while (Buffer.byteLength(s, "utf8") > cap) s = s.slice(0, -1);
  return s;
}

/**
 * v0.5 T2 (S1): manifest close-out — the report "done" branch's seven steps
 * (§2.2), executed inside the caller's root lock. milestone never writes a
 * manifest; a condensation worker's done walks this same pipeline.
 *
 * 1) read manifest_entries (optional; a non-array value ignores the whole
 *    field + note)
 * 2) shape check: layer enum T0/T1/T2, the closed five-value type enum
 *    ("summary" is illegal), required title/ref — invalid entries dropped
 *    and counted
 * 3) caps: entries ≤12 (overflow drops tail+note), T0 text ≤4000B per entry
 *    with ≤8 T0 entries, T1 text ≤500 chars, title ≤60 chars, whole sidecar
 *    ≤32KB (overflow drops tail+note); truncation keeps the head with the
 *    verbatim markers "…[截断于N字节]" (T0) / "…[截断于N字]" (T1)
 * 4) T2 auto-stub: zero valid declarations but the mission has
 *    artifacts/output_files/pack.path -> server generates source:"server"
 *    T2-only stubs (one entry per path) — invariant: a done mission with
 *    outputs always has a minimal pullable manifest
 * 5) write the sidecar <root>/packs/<mission_id>/manifest.json (atomic;
 *    fields v=1/mission_id/generated_at/source/entries; all-empty writes
 *    no file and sets no pointer)
 * 6) mission.manifest pointer {path, entry_count, updated_at} (whole
 *    replacement via the merge whitelist — done by the caller's patch)
 * 7) mechanical comparison of assertion entries: trigger = type=assertion
 *    && ref.path hits the tests/assertions/ convention (no mission
 *    classification); server reads the assertion file — exists and contains
 *    the entry text -> consistent (silent); mismatch or unreadable file ->
 *    manifest_warnings (read-only, non-blocking)
 *
 * Returns { pointer, note, warnings }: pointer null when nothing was
 * written; note null when there is nothing to flag. Over-cap and shape
 * violations are all soft — a report never fails on declaration quality.
 */
function closeOutManifest(mission, rawEntries, at) {
  const notes = [];
  const warnings = [];

  // 1) read + non-array guard (whole field ignored + note).
  const declared = Array.isArray(rawEntries)
    ? rawEntries
    : rawEntries == null
      ? null
      : (notes.push("manifest_entries 非数组，整字段已忽略"), null);

  // 2) shape validation: drop-and-count, reasons recorded for the note.
  const valid = [];
  if (declared) {
    const reasons = [];
    let dropped = 0;
    for (let i = 0; i < declared.length; i++) {
      const e = declared[i];
      const why =
        !e || typeof e !== "object" || Array.isArray(e)
          ? `第${i + 1}条非对象`
          : (() => {
              const layer = String(e.layer ?? "").trim();
              const type = String(e.type ?? "").trim();
              const title = String(e.title ?? "").trim();
              const ref = e.ref && typeof e.ref === "object" && !Array.isArray(e.ref) ? e.ref : null;
              const refPath = ref ? String(ref.path ?? "").trim() : "";
              if (!MANIFEST_LAYERS.includes(layer)) return `第${i + 1}条 layer 非法（${truncateStr(layer || "空", 16)}）`;
              if (!MANIFEST_TYPES.includes(type)) return `第${i + 1}条 type 非法（${truncateStr(type || "空", 16)}）`;
              if (!title) return `第${i + 1}条缺 title`;
              if (!refPath) return `第${i + 1}条缺 ref.path`;
              return null;
            })();
      if (why) {
        dropped += 1;
        reasons.push(why);
        continue;
      }
      const ref = e.ref;
      const refPath = String(ref.path ?? "").trim();
      const refLoc = String(ref.loc ?? "").trim();
      valid.push({
        layer: String(e.layer).trim(),
        type: String(e.type).trim(),
        title: String(e.title).trim(),
        text: String(e.layer).trim() === "T2" ? undefined : String(e.text ?? ""),
        ref: refLoc ? { path: refPath, loc: refLoc } : { path: refPath },
      });
    }
    if (dropped) {
      notes.push(`manifest 条目形状违规丢弃 ${dropped} 条：${reasons.join("、")}`);
    }
  }

  // 3) caps — entry count first, then the T0 count, then per-entry truncation.
  let entries = valid.slice();
  if (entries.length > MANIFEST_MAX_ENTRIES) {
    notes.push(
      `manifest 条目超帽（≤${MANIFEST_MAX_ENTRIES} 条），丢弃尾部 ${entries.length - MANIFEST_MAX_ENTRIES} 条`,
    );
    entries = entries.slice(0, MANIFEST_MAX_ENTRIES);
  }
  let t0Seen = 0;
  const t0Kept = [];
  for (const e of entries) {
    if (e.layer === "T0") {
      t0Seen += 1;
      if (t0Seen > MANIFEST_T0_MAX) continue;
    }
    t0Kept.push(e);
  }
  if (entries.length - t0Kept.length > 0) {
    notes.push(`T0 条目超帽（≤${MANIFEST_T0_MAX} 条），丢弃尾部 ${entries.length - t0Kept.length} 条`);
  }
  entries = t0Kept;
  for (const e of entries) {
    if (e.title.length > MANIFEST_TITLE_CHARS) e.title = e.title.slice(0, MANIFEST_TITLE_CHARS);
    if (e.layer === "T0" && Buffer.byteLength(e.text ?? "", "utf8") > MANIFEST_T0_ENTRY_BYTES) {
      const head = truncateUtf8Bytes(e.text, MANIFEST_T0_ENTRY_BYTES);
      e.text = `${head}…[截断于${Buffer.byteLength(head, "utf8")}字节]`;
    } else if (e.layer === "T1" && (e.text ?? "").length > MANIFEST_T1_ENTRY_CHARS) {
      const head = e.text.slice(0, MANIFEST_T1_ENTRY_CHARS);
      e.text = `${head}…[截断于${head.length}字]`;
    }
  }

  // 4) T2 auto-stub: only when the worker declared nothing valid but the
  // mission carries outputs (artifacts / output_files / pack.path).
  let stubbed = false;
  if (!entries.length) {
    const arts = Array.isArray(mission.artifacts) ? mission.artifacts.map(String) : [];
    const outs = Array.isArray(mission.output_files) ? mission.output_files.map(String) : [];
    const packPath = mission.pack && mission.pack.path ? String(mission.pack.path) : null;
    const paths = [...arts, ...outs, ...(packPath ? [packPath] : [])].filter(Boolean);
    if (paths.length) {
      stubbed = true;
      entries = paths.map((p) => ({
        layer: "T2",
        type: "anchor",
        title: "产物指针（server 桩）",
        text: undefined,
        ref: { path: p },
      }));
      if (entries.length > MANIFEST_MAX_ENTRIES) {
        notes.push(
          `server 桩条目超帽（≤${MANIFEST_MAX_ENTRIES} 条），丢弃尾部 ${entries.length - MANIFEST_MAX_ENTRIES} 条`,
        );
        entries = entries.slice(0, MANIFEST_MAX_ENTRIES);
      }
    }
  }

  // Canonical seven-field entries with sequential ids c01..c12 (order = the
  // two-digit semantic; the server renumbers, the worker supplies content).
  const assemble = (list, src) =>
    list.map((e, i) => {
      const out = {
        id: `c${String(i + 1).padStart(2, "0")}`,
        layer: e.layer,
        type: e.type,
        title: e.title,
      };
      if (e.text !== undefined && e.text !== "") out.text = e.text;
      out.ref = e.ref;
      out.source = src;
      return out;
    });

  if (!entries.length) {
    // 5b) all-empty: no file, no pointer — the note explains why (CR-V21).
    notes.push("manifest 未写入：零有效条目且零产物物料（不落 sidecar、不设指针）");
    return { pointer: null, note: notes.join("；"), warnings };
  }

  // 5) write the sidecar (atomic), enforcing the 32KB whole-file cap by
  // dropping tail entries until it fits.
  const source = stubbed ? "server" : "worker";
  let payload = { v: 1, mission_id: mission.id, generated_at: at, source, entries: assemble(entries, source) };
  let fileDropped = 0;
  while (
    entries.length &&
    Buffer.byteLength(JSON.stringify(payload, null, 2) + "\n", "utf8") > MANIFEST_FILE_BYTES
  ) {
    entries.pop();
    fileDropped += 1;
    payload = { v: 1, mission_id: mission.id, generated_at: at, source, entries: assemble(entries, source) };
  }
  if (fileDropped) notes.push(`manifest 文件超 32KB 总帽，丢弃尾部 ${fileDropped} 条`);
  if (!entries.length) {
    notes.push("manifest 未写入：零有效条目且零产物物料（不落 sidecar、不设指针）");
    return { pointer: null, note: notes.join("；"), warnings };
  }
  const sidecarPath = path.join(root, "packs", mission.id, "manifest.json");
  atomicWriteFileSync(sidecarPath, JSON.stringify(payload, null, 2) + "\n");

  // 6) board pointer (whole replacement by the caller's patch).
  const pointer = {
    path: displayPath(sidecarPath),
    entry_count: entries.length,
    updated_at: at,
  };

  // 7) assertion mechanical comparison — entry-level trigger predicate:
  // type=assertion && ref.path hits tests/assertions/ (no mission classing).
  // Read-only, non-blocking; mismatch/unreadable -> manifest_warnings.
  for (const e of payload.entries) {
    if (e.type !== "assertion") continue;
    const refPath = String((e.ref && e.ref.path) ?? "");
    if (!refPath.includes("tests/assertions/")) continue;
    let fileText = null;
    try {
      const abs = path.isAbsolute(refPath) ? refPath : path.join(projectDir, refPath);
      fileText = fs.readFileSync(abs, "utf8");
    } catch {
      fileText = null;
    }
    if (fileText == null) {
      warnings.push(`assertion 未比对：断言文件不可读（${refPath}）`);
    } else if (!fileText.includes(e.text ?? "")) {
      warnings.push(`assertion 比对不一致：${refPath} 未包含条目 ${e.id} 的内联文本`);
    }
  }

  return { pointer, note: notes.length ? notes.join("；") : null, warnings };
}

export {
  PULL_T0_ENTRY_BYTES,
  PULL_T0_LAYER_BYTES,
  PULL_T1_LAYER_BYTES,
  PULL_T2_MAX,
  parseScopePathsArg,
  parseBudgetArg,
  parseInputsArg,
  buildOwnershipLines,
  buildBudgetLines,
  truncateUtf8Bytes,
  closeOutManifest,
};
