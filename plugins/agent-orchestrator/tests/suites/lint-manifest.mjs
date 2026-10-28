// @module lint-manifest
/*!
 * suites/lint-manifest.mjs —— L0 发版 lint（V7-12）：manifest 约定路径防复发 + 引用存在性 + 版本三方一致
 *   + 文档卡同步锁（v1.2 M1-3）+ 套件结构锁（v1.2 M7-2：@module 恰一/module-index≡suites/REGISTRY≡suites）。
 *
 * 覆盖断言组：LM-01（W-F4 防复发精确对位）——manifest 若声明 `hooks` 字段，任一条目 realpath
 *   不得等于宿主约定路径 <插件根>/hooks/hooks.json（宿主对约定路径「先行+去重」，重复声明即
 *   双重加载；FAIL 提示删字段或改非约定路径，见 designs W-F4 §1/§3.2 与 v0.7-W-T-findings §2）；
 *   LM-02——manifest skills/commands/mcpServers/agents（及 hooks 若声明）指向路径存在且非空；
 *   LM-03——plugin.json version == SERVER_VERSION（mcp/server.mjs 常量）== plugins/marketplace.json
 *   version，防「发版忘改一处」三方漂移；
 *   LM-05（v1.2 M1-3，A-v0120-CARD 同族）——文档卡同步锁：①契约卡存在非空（glob
 *   docs/protocols/card-*.md 全量，后续落盘卡自动纳入覆盖）②每张在册卡的锚标识符
 *   （卡内常量/函数名）在归属源码文件 grep 可见——卡≈码同步锁，卡改码不改/码改卡不改均红
 *   （impl-plan §4.3「卡 grep×卡数+存在非空」；卡≈码语义级对拍归 contract-sync.mjs L1）；
 *   LM-04（v1.2 M7-2）——套件结构锁三条：规则 1 = suites/*.mjs 每文件文件头恰一行
 *   `// @module <name>` 标签且 <name> ≡ 文件词干（孤儿套件机械检出：无标签/双标签/名称失配即红）；
 *   规则 2 = tests/module-index.md 表行 ≡ suites/*.mjs 文件集（双向全等+无重复）；
 *   规则 3 = run-all.mjs REGISTRY 条目名单 ≡ suites/*.mjs 文件集（双向全等+无重复）。
 *   三条只锁集合全等，套件总数字面数不作门（impl-plan M-5/O6=a 口径）。
 *
 * 口径：L0 纯静态读文件，零网络零临时根（--root 参数接受但忽略，兼容 run-all 透传）。
 *   hooks.json 事件集内容已由 l0-skeleton 静态断言覆盖，本套不重复断言事件集（findings §5 遗留 3）。
 *
 * 运行方式：node tests/suites/lint-manifest.mjs [--root <忽略>]
 * 前置：node >= 20；无网、无 git。
 */
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_DIR, DEFAULT_SERVER, Checker } from "../harness/jsonrpc-client.mjs";

const ck = new Checker("lint-manifest");

const MANIFEST_PATH = path.join(PLUGIN_DIR, ".zcode-plugin", "plugin.json");
const MARKETPLACE_PATH = path.resolve(PLUGIN_DIR, "..", "marketplace.json");
const CONVENTIONAL_HOOKS = path.join(PLUGIN_DIR, "hooks", "hooks.json");

/** 归一化路径比较键：存在则 realpath，否则 lexical normalize；Windows 大小写不敏感。 */
function pathKey(p) {
  let resolved = path.resolve(p);
  try { resolved = fs.realpathSync(resolved); } catch { /* 不存在的引用按词法比较 */ }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 从 manifest hooks 字段收集所有可解释为路径的字符串（string / 数组条目 / {path|file|hooks}）。 */
function hookEntryPaths(field) {
  const out = [];
  if (typeof field === "string") out.push(field);
  else if (Array.isArray(field)) {
    for (const e of field) {
      if (typeof e === "string") out.push(e);
      else if (e && typeof e === "object") for (const k of ["path", "file", "hooks"]) if (typeof e[k] === "string") out.push(e[k]);
    }
  } else if (field && typeof field === "object") {
    for (const k of ["path", "file", "hooks"]) if (typeof field[k] === "string") out.push(field[k]);
  }
  return out;
}

/** 引用指向存在且非空：目录须有条目，文件须 size>0。 */
function refExistsNonEmpty(rel) {
  const abs = path.resolve(PLUGIN_DIR, rel);
  let st;
  try { st = fs.statSync(abs); } catch { return { ok: false, detail: abs + " 不存在" }; }
  if (st.isDirectory()) {
    const n = fs.readdirSync(abs).length;
    return n > 0 ? { ok: true } : { ok: false, detail: abs + " 空目录" };
  }
  return st.size > 0 ? { ok: true } : { ok: false, detail: abs + " 空文件" };
}

// ---- 前置：manifest 可解析（LM 系全部断言的输入）
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  ck.ok("LM-01 manifest 可解析（.zcode-plugin/plugin.json）", !!manifest && typeof manifest === "object");
} catch (e) {
  ck.ok("LM-01 manifest 可解析（.zcode-plugin/plugin.json）", false, String(e).slice(0, 200));
}

if (manifest) {
  // ---- LM-01：hooks 声明不与约定路径 realpath 重复（W-F4 防复发钉）
  if (manifest.hooks === undefined) {
    ck.ok("LM-01 hooks 字段未声明（约定路径重复无从发生；W-F4 根治态保持）", true);
  } else {
    const declared = hookEntryPaths(manifest.hooks).map((p) => path.resolve(PLUGIN_DIR, p));
    const dup = declared.filter((p) => pathKey(p) === pathKey(CONVENTIONAL_HOOKS));
    ck.ok("LM-01 hooks 声明条目 realpath 不等于约定路径 hooks/hooks.json（重复=FAIL：删字段或改非约定路径）",
      dup.length === 0, { declared, conventional: CONVENTIONAL_HOOKS, dup });
  }

  // ---- LM-02：引用存在性且非空（固定四键 + hooks 若声明）
  const refKeys = ["skills", "commands", "mcpServers", "agents"];
  if (manifest.hooks !== undefined) refKeys.push("hooks");
  for (const k of refKeys) {
    const v = manifest[k];
    if (typeof v !== "string" || !v.trim()) {
      ck.ok(`LM-02 ${k} 指向存在且非空`, false, { got: v, want: "相对插件根的路径字符串" });
      continue;
    }
    const r = refExistsNonEmpty(v);
    ck.ok(`LM-02 ${k} -> ${v} 存在且非空`, r.ok, r.detail);
  }

  // ---- LM-03：版本三方一致（plugin.json == server.mjs SERVER_VERSION == marketplace.json）
  const pjv = manifest.version;
  const serverSrc = fs.readFileSync(DEFAULT_SERVER, "utf8");
  const sm = serverSrc.match(/const\s+SERVER_VERSION\s*=\s*["']([^"']+)["']/);
  ck.ok("LM-03 SERVER_VERSION 常量可从 server.mjs 提取", !!(sm && sm[1]), sm && sm[1]);

  let mpEntry = null;
  try {
    const mp = JSON.parse(fs.readFileSync(MARKETPLACE_PATH, "utf8"));
    mpEntry = (mp.plugins || []).find((p) => p.name === manifest.name) || null;
    ck.ok("LM-03 marketplace.json 可解析且含本插件条目", !!mpEntry, mpEntry?.version);
  } catch (e) {
    ck.ok("LM-03 marketplace.json 可解析且含本插件条目", false, String(e).slice(0, 200));
  }

  const three = { plugin: pjv, server: sm && sm[1], marketplace: mpEntry && mpEntry.version };
  ck.ok("LM-03 版本三方一致（plugin.json == SERVER_VERSION == marketplace.json）",
    typeof pjv === "string" && !!sm && !!mpEntry && pjv === sm[1] && pjv === mpEntry.version, three);
}

// ---- LM-05：文档卡同步锁（v1.2 M1-3，A-v0120-CARD 同族；impl-plan §4.3「卡 grep×卡数+存在非空」）
// 两腿：
//   ①卡存在非空——glob docs/protocols/card-*.md 全量（M6-1/M7-1 后续落盘卡自动纳入覆盖；
//     下限 4=首批在册口径，防卡族整体缺席/目录误删时 glob 退化为空集假绿）；
//   ②锚标识符 grep——LM05_CARD_ANCHORS 每行钉一张卡所声明的常量/函数名及其归属源码文件，
//     逐锚 grep 可见（先注册后生效，全锚注册前已逐个 grep 实证≥1 命中）。
// 新卡落盘后由持 lint-manifest 写面的波次补一行表（v1.2 内已由 M7-2 汇聚兜底补齐：
//   M6-1 四卡 card-spool/result-dir/probe/memory-views + M7-1 三卡 card-sandbox/watcher/bg-sentinel-map，
//   现锚表 11 卡全量；卡改名/换锚 → 表行失配即红=提醒同步）。卡≈码语义级对拍（ALLOWED_TRANSITIONS 逐腿）归 contract-sync.mjs。
const LM05_PROTOCOLS_DIR = path.join(PLUGIN_DIR, "docs", "protocols");
const LM05_CARD_ANCHORS = [
  {
    card: "card-state-machine.md",
    targets: [
      { rel: "mcp/server.mjs", ids: ["ALLOWED_TRANSITIONS", "MERGEABLE_KEYS", "ONE_LEVEL", "STATUSES", "upsertMission", "sweepGraph", "mergeMission"] },
    ],
  },
  {
    card: "card-board.md",
    targets: [
      { rel: "mcp/server.mjs", ids: ["MERGEABLE_KEYS", "ONE_LEVEL", "p2pTokenGate", "BOARD_VERSION", "loadBoard", "saveBoard", "withRootLock", "compactMissionRow", "P2P_TERMINAL_STATUSES", "P2P_ASK_PRECONDITION_STATUSES"] },
    ],
  },
  {
    card: "card-sentinel.md",
    targets: [
      { rel: "hooks/bg-sentinel.mjs", ids: ["HEARTBEAT_STALE_MS", "claimSlot", "touchSlot", "releaseSlot", "pruneStaleSlots", "claimTeardown", "readCfg", "claimShots", "firedEligible", "pruneFired", "claimQuarantine", "readQuarantine", "appendEcho", "pruneEcho", "ECHO_MAX_LINES", "coordSessionId", "watcherCoverage", "writeGleanState", "readGleanState", "clearGleanState"] },
      { rel: "mcp/server.mjs", ids: ["sentinelHealth", "SENTINEL_HEARTBEAT_STALE_MS", "writeSentinelCfg"] },
      { rel: "hooks/bg-gate.mjs", ids: ["sentinelAlive", "HEARTBEAT_STALE_MS"] },
      { rel: "hooks/session-start.mjs", ids: ["publishWakeAnchor"] },
    ],
  },
  {
    card: "card-root-txt.md",
    targets: [
      { rel: "mcp/server.mjs", ids: ["ensureRootId", "rootIdOf", "isTempDirPath", "isTempRoot"] },
      { rel: "hooks/bg-gate.mjs", ids: ["locateRoot", "rootIdOf"] },
      { rel: "hooks/bg-sentinel.mjs", ids: ["locateRoot", "rootIdOf"] },
      { rel: "hooks/journal.mjs", ids: ["locateRoot", "rootIdOf"] },
      { rel: "hooks/session-start.mjs", ids: ["locateRoot", "rootIdOf"] },
      { rel: "hooks/stop-check.mjs", ids: ["locateRoot", "rootIdOf"] },
    ],
  },
  // ---- v1.2 M7-2 汇聚兜底补行（L-2 时点口径兑现：M6-1 四新卡 + M7-1 三新卡；
  //      各行锚集=卡内「断言锚」节自声明素材，注册前逐个 grep 实证 ≥1 命中，2026-10-28）
  {
    card: "card-spool.md",
    targets: [
      { rel: "mcp/server.mjs", ids: ["missionSpoolDir", "unreadDirOf", "readEventFile", "consumeEventFile", "countUnreadSafe", "DETAILS_MAX_CHARS", "details_path", "details_head", "details_hint"] },
    ],
  },
  {
    card: "card-result-dir.md",
    targets: [
      { rel: "mcp/server.mjs", ids: ["dispatchHasResultIndex", "dispatchScanNewResults", "dispatchCaptureOutcome", "DISPATCH_DEFAULT_TIMEOUT_MIN", "ORCH_DISPATCH_BUSY_STALE_MIN"] },
      { rel: "hooks/dispatch-runner.mjs", ids: ["writeKilledIndex", "runner_early_fail", "outcome", "timed_out", "exit_code", "killed"] },
    ],
  },
  {
    card: "card-probe.md",
    targets: [
      { rel: "mcp/server.mjs", ids: ["probeValidateSql", "probeDecodeToken", "probeEnvelope", "probeLooksBinary", "PROBE_MAX_ROWS", "PROBE_CACHE_MAX_ENTRIES", "probeCache"] },
    ],
  },
  {
    card: "card-memory-views.md",
    targets: [
      { rel: "mcp/server.mjs", ids: ["readProjectDigest", "digestSourcesNow", "parseOrchMdHeader", "orchMdAttachment", "DIGEST_MAX_LINES", "ORCH_MD_MAX_LINES", "digestGradedStaleReason", "DIGEST_DRIFT_N"] },
    ],
  },
  {
    card: "card-sandbox.md",
    targets: [
      { rel: "mcp/server.mjs", ids: ["materializeSandbox", "applyGateAndIntent", "applyGitPipeline", "applySettleBoard", "applyTeardown", "toolSandboxApply", "toolSandboxDiscard", "discardGate", "discardGitTriple", "discardSettleBoard", "assertMergeTreeSupport", "parseMergeTreeConflicts", "applyIntentFresh", "buildSandboxLines", "coversPath", "scopePairConflict"] },
    ],
  },
  {
    card: "card-watcher.md",
    targets: [
      { rel: "watcher/watcher.mjs", ids: ["wakeCoordSession", "workspaceIdentity", "workspaceKeyHint", "redact", "CLASSES", "record"] },
      { rel: "watcher/degrade.mjs", ids: ["CLASSES", "TERMINAL_CLASSES", "D1_GUIDANCE", "LOOPBACK_ENV_RELAY_WS_URL", "LOOPBACK_ENV_ENDPOINT_ORIGIN", "record"] },
      { rel: "watcher/poller.mjs", ids: ["classify"] },
      { rel: "watcher/credentials.mjs", ids: ["redact"] },
    ],
  },
  {
    card: "card-bg-sentinel-map.md",
    targets: [
      { rel: "hooks/bg-sentinel.mjs", ids: ["locateRoot", "rootIdOf", "readBoardSafe", "watcherCoverage", "claimSlot", "touchSlot", "releaseSlot", "pruneStaleSlots", "claimQuarantine", "readQuarantine", "claimShots", "firedEligible", "pruneFired", "appendEcho", "pruneEcho", "ECHO_MAX_LINES", "writeGleanState", "readGleanState", "clearGleanState", "gleanStampFile"] },
    ],
  },
];

// 腿①：卡族在册（glob 全量存在非空）
let lm05Cards = [];
try {
  lm05Cards = fs.readdirSync(LM05_PROTOCOLS_DIR).filter((f) => /^card-.+\.md$/.test(f)).sort();
} catch { /* 目录缺失=卡族整体缺席，落入断言红 */ }
for (const f of lm05Cards) {
  let size = 0;
  try { size = fs.statSync(path.join(LM05_PROTOCOLS_DIR, f)).size; } catch { /* 统计失败=红 */ }
  ck.ok(`LM-05 契约卡存在非空：docs/protocols/${f}`, size > 0, { size });
}
ck.ok("LM-05 契约卡族在册下限（card-*.md ≥11 张=v1.2 M7-2 汇聚时点全量在册口径；后续落盘卡自动纳入本腿覆盖）",
  lm05Cards.length >= 11, { got: lm05Cards });

// 腿②：逐卡「存在非空 + 锚标识符源码 grep 可见」（聚合断言，缺锚清单进 extra）
for (const entry of LM05_CARD_ANCHORS) {
  const problems = [];
  let cardSrc = "";
  try { cardSrc = fs.readFileSync(path.join(LM05_PROTOCOLS_DIR, entry.card), "utf8"); } catch { problems.push("卡不可读"); }
  if (cardSrc && !cardSrc.trim()) problems.push("卡空文件");
  if (cardSrc && cardSrc.trim()) {
    for (const t of entry.targets) {
      let tsrc = "";
      try { tsrc = fs.readFileSync(path.join(PLUGIN_DIR, t.rel), "utf8"); } catch { problems.push(t.rel + " 不可读"); continue; }
      for (const id of t.ids) {
        if (!new RegExp("\\b" + id + "\\b").test(tsrc)) problems.push(t.rel + " 缺锚 " + id);
      }
    }
  }
  const nIds = entry.targets.reduce((a, t) => a + t.ids.length, 0);
  ck.ok(`LM-05 ${entry.card} 在册且 ${nIds} 个锚标识符源码 grep 可见（卡≈码同步锁）`,
    problems.length === 0, { problems: problems.slice(0, 12) });
}

// ---- LM-04：套件结构锁（v1.2 M7-2，三条；impl-plan §批2 M7-2「@module 恰一/module-index≡suites 文件集/REGISTRY≡suites 名单」）
// 规则 1 @module 恰一：tests/suites/*.mjs 每文件恰一行行首 `//` + `@module <name>` 标签（文件头 8 行内），
//   且 <name> ≡ 文件名词干——孤儿套件机械检出：无标签/双标签/标签不在文件头/名称与文件失配均红；
//   标签形状=行首 `//` 紧跟空格加保留 token（块注释内提述该 token 不匹配，不算标签）。
// 规则 2 module-index ≡ suites 文件集：tests/module-index.md 花名册表行（首列反引号模块名、
//   次列 `<name>.mjs`）与 suites/*.mjs 词干集双向全等、无重复行——新增套件漏登 index/幻影行均红。
// 规则 3 REGISTRY ≡ suites 名单：tests/run-all.mjs REGISTRY 条目（`{ name: "x", layer: "..." }` 形状）
//   与 suites/*.mjs 词干集双向全等、无重复条目——未注册孤儿/注册悬空双向红。
// 字面数不作门（impl-plan M-5/O6=a 口径）：三条只锁集合全等与形状，不锁套件总数。
const LM04_SUITES_DIR = path.join(PLUGIN_DIR, "tests", "suites");
const LM04_INDEX_PATH = path.join(PLUGIN_DIR, "tests", "module-index.md");
const LM04_RUNALL_PATH = path.join(PLUGIN_DIR, "tests", "run-all.mjs");
const LM04_TAG_LINE_RE = /^\/\/ @module (\S+)\s*$/;
const LM04_HEAD_WINDOW = 8;

let lm04Stems = [];
try {
  lm04Stems = fs.readdirSync(LM04_SUITES_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => f.replace(/\.mjs$/, ""))
    .sort();
} catch { /* suites/ 目录缺失=结构性红，三规则全落红 */ }

// 规则 1：@module 恰一（逐文件聚合断言，问题清单进 extra）
{
  const problems = [];
  for (const stem of lm04Stems) {
    const rel = "tests/suites/" + stem + ".mjs";
    let lines = [];
    try { lines = fs.readFileSync(path.join(LM04_SUITES_DIR, stem + ".mjs"), "utf8").split(/\r?\n/); }
    catch { problems.push(rel + " 不可读"); continue; }
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(LM04_TAG_LINE_RE);
      if (m) hits.push({ line: i + 1, name: m[1] });
    }
    if (hits.length === 0) problems.push(rel + " 缺标签");
    else if (hits.length > 1) problems.push(rel + " 标签 ×" + hits.length + "（行 " + hits.map((h) => h.line).join(",") + "）");
    else {
      if (hits[0].line > LM04_HEAD_WINDOW) problems.push(rel + " 标签不在文件头（行 " + hits[0].line + " > " + LM04_HEAD_WINDOW + "）");
      if (hits[0].name !== stem) problems.push(rel + " 标签名失配（got " + hits[0].name + " want " + stem + "）");
    }
  }
  ck.ok("LM-04 规则1（@module 恰一）：suites/*.mjs 每文件文件头恰一行标签且名称≡文件词干",
    lm04Stems.length > 0 && problems.length === 0, { suites: lm04Stems.length, problems: problems.slice(0, 12) });
}

// 规则 2：module-index.md ≡ suites 文件集
{
  const problems = [];
  const indexRows = [];
  try {
    const idxSrc = fs.readFileSync(LM04_INDEX_PATH, "utf8");
    if (!idxSrc.trim()) problems.push("tests/module-index.md 空文件");
    for (const line of idxSrc.split(/\r?\n/)) {
      const m = line.match(/^\| `([a-z0-9][a-z0-9-]*)` \| (\S+) \|/);
      if (m) indexRows.push({ name: m[1], file: m[2] });
    }
    if (indexRows.length === 0) problems.push("module-index 无可解析花名册表行（首列反引号模块名形状）");
  } catch { problems.push("tests/module-index.md 不可读/不存在"); }
  const names = indexRows.map((r) => r.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) problems.push("module-index 重复行: " + dup.join(","));
  const stemsSet = new Set(lm04Stems);
  for (const n of new Set(names)) if (!stemsSet.has(n)) problems.push("module-index 幻影行: " + n + "（suites/ 无对应文件）");
  const namesSet = new Set(names);
  for (const s of lm04Stems) if (!namesSet.has(s)) problems.push("module-index 缺行: " + s);
  for (const r of indexRows) if (r.file !== r.name + ".mjs") problems.push("module-index " + r.name + " 次列失配（got " + r.file + " want " + r.name + ".mjs）");
  ck.ok("LM-04 规则2（module-index≡suites 文件集）：tests/module-index.md 花名册 ≡ suites/*.mjs 双向全等",
    lm04Stems.length > 0 && indexRows.length > 0 && problems.length === 0, { suites: lm04Stems.length, rows: indexRows.length, problems: problems.slice(0, 12) });
}

// 规则 3：REGISTRY ≡ suites 名单
{
  const problems = [];
  let regNames = [];
  try {
    const src = fs.readFileSync(LM04_RUNALL_PATH, "utf8");
    regNames = [...src.matchAll(/\{\s*name:\s*"([^"]+)",\s*layer:\s*"[^"]*"\s*\}/g)].map((m) => m[1]);
    if (regNames.length === 0) problems.push("run-all.mjs 未解析到任何 REGISTRY 条目（{ name, layer } 形状）");
  } catch { problems.push("tests/run-all.mjs 不可读/不存在"); }
  const dup = regNames.filter((n, i) => regNames.indexOf(n) !== i);
  if (dup.length) problems.push("REGISTRY 重复条目: " + dup.join(","));
  const stemsSet = new Set(lm04Stems);
  for (const n of new Set(regNames)) if (!stemsSet.has(n)) problems.push("REGISTRY 悬空条目: " + n + "（suites/ 无对应文件）");
  const regSet = new Set(regNames);
  for (const s of lm04Stems) if (!regSet.has(s)) problems.push("REGISTRY 缺注册: " + s);
  ck.ok("LM-04 规则3（REGISTRY≡suites 名单）：run-all.mjs REGISTRY ≡ suites/*.mjs 双向全等",
    lm04Stems.length > 0 && regNames.length > 0 && problems.length === 0, { suites: lm04Stems.length, registry: regNames.length, problems: problems.slice(0, 12) });
}

const { pass, fail } = ck.summary();
process.exit(fail ? 1 : 0);
