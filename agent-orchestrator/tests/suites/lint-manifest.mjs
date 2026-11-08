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
 *   三条只锁集合全等，套件总数字面数不作门（impl-plan M-5/O6=a 口径）；
 *   规则 4（v1.5 W3-M2 T13，grill#1 G1-1 裁 a）=注册对账扩域两腿：4a 残渣腿（suites/ 全深度
 *   非 .mjs 文件=红，白名单=无）+4b 子目录接线腿（每子目录 .mjs 须在同目录聚合入口
 *   tests/suites/<dir>.mjs 静态 import 闭包内可达，闭包外=红孤儿；聚合口径=run-all 现行
 *   注册语义：REGISTRY 只挂顶层入口，子目录模块经入口 import 接线）——规则 3 锁顶层双向
 *   +规则 4 合成 suites/ 全深度双向对账（沿革 l-20261027-df4725/l-20261027-2300d6：
 *   规则 3 治顶层孤儿，规则 4 治残渣/子目录孤儿；nit-1 扩域=字面量动态 import("…") 形
 *   亦入闭包，非字面量形仍不入=静态锁口径不变）；
 *   LM-06（v1.3 切分 S1，A-v130-SPLIT-*）——族面锁三腿：SCAN（α 读 API×入口字面共现 /
 *   β 入口字面逃逸网，判定域排除两扫描器本体=β 零自指）+ DEP（mcp 族依赖单向四规则+层映射
 *   表双向全等）+ CAP（行数帽双域：软帽域豁免 2 件触发器钉 / 硬帽域 9+52 族面文件 ≤900）
 *   + FAMILIES 登记全景钉（8 族防静默收缩）；文案权威=split-impl-design §10 总表。
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
import { familySource, familyFiles, LAYER_OF, L2_HORIZONTAL_EDGES } from "../harness/source-family.mjs";

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
  // v1.3 切分重基（m-20261101-034720-a7a6）：SERVER_VERSION 随模块迁移（server-core.mjs），
  //   提取面=server 族（入口+模块族，familySource helper；主控裁决 EXTRA-2 口径），锚/真值语义不变。
  const pjv = manifest.version;
  const serverSrc = familySource(PLUGIN_DIR, "mcp/server.mjs");
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
// v1.3 S2 锚迁移（m-20261101-072952-aa35；定位协议与逐 id 归属裁定=designs/…/qa/split-anchor-map.md）：
//   原 12 entry-pinned targets（9×mcp/server.mjs + 3×hooks/bg-sentinel.mjs，111 ids）按模块归属拆行
//   （同模块 ids 合并一行；多命中以 def-shape 定义点消歧；零命中=0）；11 非 server/bg targets
//   （watcher×4/bg-gate×2/session-start/stop-check/journal/dispatch-runner——未拆分单文件）原样归属不动。
const LM05_CARD_ANCHORS = [
  {
    card: "card-state-machine.md",
    targets: [
      { rel: "mcp/server-board.mjs", ids: ["ALLOWED_TRANSITIONS", "MERGEABLE_KEYS", "ONE_LEVEL", "upsertMission", "sweepGraph", "mergeMission"] },
      { rel: "mcp/server-core.mjs", ids: ["STATUSES"] },
    ],
  },
  {
    card: "card-board.md",
    targets: [
      { rel: "mcp/server-board.mjs", ids: ["MERGEABLE_KEYS", "ONE_LEVEL", "loadBoard", "saveBoard", "compactMissionRow"] },
      { rel: "mcp/server-core.mjs", ids: ["BOARD_VERSION", "withRootLock"] },
      { rel: "mcp/server-p2p.mjs", ids: ["p2pTokenGate", "P2P_TERMINAL_STATUSES", "P2P_ASK_PRECONDITION_STATUSES"] },
    ],
  },
  {
    card: "card-sentinel.md",
    targets: [
      // readCfg 锚已退役（主控裁定 2026-11-01，裁①）：bg 入口主循环本地闭包（bg-sentinel.mjs L175 B6
      //   每 tick 重读），模块族零命中无模块级归属；cfg 契约面由 sentinel-teardown T11 A-v090-CLN-05
      //   专锁兜底（全 sparse+零漂移对拍）；卡面锚=hooks/bg-sentinel.mjs 入口（split-anchor-map §4 三态记退役）
      { rel: "hooks/bg-sentinel/core.mjs", ids: ["HEARTBEAT_STALE_MS", "ECHO_MAX_LINES"] },
      { rel: "hooks/bg-sentinel/family.mjs", ids: ["claimSlot", "touchSlot", "releaseSlot", "pruneStaleSlots", "claimTeardown", "claimQuarantine", "readQuarantine"] },
      { rel: "hooks/bg-sentinel/fired.mjs", ids: ["claimShots", "firedEligible", "pruneFired"] },
      { rel: "hooks/bg-sentinel/echo.mjs", ids: ["appendEcho", "pruneEcho"] },
      { rel: "hooks/bg-sentinel/signals.mjs", ids: ["coordSessionId", "watcherCoverage"] },
      // v1.6 W-p：glean-launch 行随模块迁 parked/agent-orchestrator/ 删除（卡面 parked 注记
      //   候裁随批；恢复=parked README 指引+本行回植）
      { rel: "mcp/server-sentinel.mjs", ids: ["sentinelHealth", "SENTINEL_HEARTBEAT_STALE_MS"] },
      { rel: "mcp/server-boot.mjs", ids: ["writeSentinelCfg"] },
      { rel: "hooks/bg-gate.mjs", ids: ["sentinelAlive", "HEARTBEAT_STALE_MS"] },
      { rel: "hooks/session-start.mjs", ids: ["publishWakeAnchor"] },
    ],
  },
  {
    card: "card-root-txt.md",
    targets: [
      { rel: "mcp/server-core.mjs", ids: ["ensureRootId", "rootIdOf", "isTempDirPath", "isTempRoot"] },
      { rel: "hooks/bg-sentinel/core.mjs", ids: ["locateRoot", "rootIdOf"] },
      { rel: "hooks/bg-gate.mjs", ids: ["locateRoot", "rootIdOf"] },
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
      { rel: "mcp/server-stores.mjs", ids: ["missionSpoolDir", "unreadDirOf", "readEventFile", "consumeEventFile", "countUnreadSafe"] },
      { rel: "mcp/server-core.mjs", ids: ["DETAILS_MAX_CHARS"] },
      { rel: "mcp/tool-mailbox.mjs", ids: ["details_path", "details_head", "details_hint"] },
    ],
  },
  {
    card: "card-result-dir.md",
    targets: [
      // v1.5 W2-A T7 裁 a 二拆：单件 rel 拆模块级（条文 7 新锚登记必须模块级）——
      //   dispatch-core=IO/主流程锚（headless 捕获面四锚随 v1.6 W-p -p parked 退役删除：
      //   dispatchHasResultIndex/dispatchScanNewResults/dispatchCaptureOutcome/
      //   ORCH_DISPATCH_BUSY_STALE_MIN）。
      // v1.6 W-p：hooks/dispatch-runner.mjs 行随模块迁 parked 删除（writeKilledIndex 等
      //   runner 面锚随迁；卡面 parked 注记候裁随批）。
      // v1.6 W3a：dispatch-prompt.mjs 锚行（DISPATCH_DEFAULT_TIMEOUT_MIN）随文件整退役
      //   删除（卡面 §7 锚声明同步注记；card-result-dir 现役锚面=dispatch-core 残余）。
    ],
  },
  {
    card: "card-probe.md",
    targets: [
      { rel: "mcp/tool-probe.mjs", ids: ["probeValidateSql", "probeDecodeToken", "probeEnvelope", "probeLooksBinary", "probeCache"] },
      { rel: "mcp/server-core.mjs", ids: ["PROBE_MAX_ROWS", "PROBE_CACHE_MAX_ENTRIES"] },
    ],
  },
  {
    card: "card-memory-views.md",
    targets: [
      // v1.6 W2（裁定 A 扩 scope，2026-11-04）：orchMdAttachment 锚随 ORCH 拆除退役（三态推送
      //   builder 删除，design §2.5；N9 负向钉防回潮）——8 ids→7 ids；parseOrchMdHeader/
      //   ORCH_MD_MAX_LINES 保留锚仍在列（ver 头解析+帽 cfg 缺省源，glean 面 consumption）。
      { rel: "mcp/server-memory.mjs", ids: ["readProjectDigest", "digestSourcesNow", "parseOrchMdHeader", "DIGEST_MAX_LINES", "ORCH_MD_MAX_LINES", "digestGradedStaleReason", "DIGEST_DRIFT_N"] },
      // v1.7.0 W1（双视图波，impl-plan §2.1.H 行）：双视图路径面锚新增登记——server-boot
      //   ORCH_MD_FILE（项目根项目视图）/FLEET_ORCH_MD_FILE（fleet 根全端视图，Q10-02）；
      //   server-memory 既有标识符保留原则不破（上行 7 ids 全保留）。
      { rel: "mcp/server-boot.mjs", ids: ["ORCH_MD_FILE", "FLEET_ORCH_MD_FILE"] },
    ],
  },
  {
    card: "card-sandbox.md",
    targets: [
      { rel: "mcp/server-git.mjs", ids: ["materializeSandbox", "assertMergeTreeSupport", "parseMergeTreeConflicts", "buildSandboxLines", "scopePairConflict"] },
      { rel: "mcp/server-core.mjs", ids: ["coversPath"] },
      { rel: "mcp/tool-sandbox.mjs", ids: ["applyGateAndIntent", "applyGitPipeline", "applySettleBoard", "applyTeardown", "toolSandboxApply", "toolSandboxDiscard", "discardGate", "discardGitTriple", "discardSettleBoard", "applyIntentFresh"] },
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
      { rel: "hooks/bg-sentinel/core.mjs", ids: ["locateRoot", "rootIdOf", "readBoardSafe", "ECHO_MAX_LINES"] },
      { rel: "hooks/bg-sentinel/family.mjs", ids: ["claimSlot", "touchSlot", "releaseSlot", "pruneStaleSlots", "claimQuarantine", "readQuarantine"] },
      { rel: "hooks/bg-sentinel/fired.mjs", ids: ["claimShots", "firedEligible", "pruneFired"] },
      { rel: "hooks/bg-sentinel/echo.mjs", ids: ["appendEcho", "pruneEcho"] },
      { rel: "hooks/bg-sentinel/signals.mjs", ids: ["watcherCoverage"] },
      // v1.6 W-p：glean-launch 行（writeGleanState/readGleanState/clearGleanState/
      //   gleanStampFile 四锚）随模块迁 parked/agent-orchestrator/ 删除（卡面 parked
      //   注记候裁随批；恢复=parked README 指引+本行回植）。
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
// v1.3 切分重基（m-20261101-034720-a7a6）：锚随巨型文件拆分迁入模块——归属源码读面=族
//   （mcp/server.mjs 与 hooks/bg-sentinel.mjs 两入口走 familySource=入口+模块族拼接，
//   其余归属文件未拆分保持单文件读）；grep 可见与恰一语义不变（族拼接≈原单文件+接线行）。
for (const entry of LM05_CARD_ANCHORS) {
  const problems = [];
  let cardSrc = "";
  try { cardSrc = fs.readFileSync(path.join(LM05_PROTOCOLS_DIR, entry.card), "utf8"); } catch { problems.push("卡不可读"); }
  if (cardSrc && !cardSrc.trim()) problems.push("卡空文件");
  if (cardSrc && cardSrc.trim()) {
    for (const t of entry.targets) {
      let tsrc = "";
      try { tsrc = familySource(PLUGIN_DIR, t.rel); } catch { problems.push(t.rel + " 不可读"); continue; }
      for (const id of t.ids) {
        if (!new RegExp("\\b" + id + "\\b").test(tsrc)) problems.push(t.rel + " 缺锚 " + id);
      }
    }
  }
  const nIds = entry.targets.reduce((a, t) => a + t.ids.length, 0);
  ck.ok(`LM-05 ${entry.card} 在册且 ${nIds} 个锚标识符源码 grep 可见（卡≈码同步锁）`,
    problems.length === 0, { problems: problems.slice(0, 12) });
}

// ---- v1.3 S2 锚迁移两钉（m-20261101-072952-aa35；断言文案逐字=split-impl-design §10 总表 S2 段） ----
// ANCHOR-MOD：两族入口 rel 残留=0——12 entry-pinned targets 已按 S2 迁移映射拆为模块级 rel 行
//   （split-anchor-map.md：恰一直接归属/多命中 def-shape 定义点消歧/零命中=0）；11 单文件 targets
//   （watcher×4/bg-gate×2/session-start/stop-check/journal/dispatch-runner）不在判域。
{
  const LM05_ENTRY_RELS = ["mcp/server.mjs", "hooks/bg-sentinel.mjs"];
  const residue = [];
  for (const entry of LM05_CARD_ANCHORS) {
    for (const t of entry.targets) {
      if (LM05_ENTRY_RELS.includes(t.rel)) residue.push(entry.card + " -> " + t.rel + "（" + t.ids.length + " ids：" + t.ids.join(",") + "）");
    }
  }
  ck.ok("LM-05 锚表归属升级核对：两族入口 rel 残留=0（12 targets 全模块级；11 单文件 targets 不在判域）",
    residue.length === 0, { residue });
}
// CARD-DEAD：卡面死行号锚退役核对——四位数以上行号锚模式（:N / :N-M 单值·区间 / LN / LN-M 带文件·L 前缀）
//   +白名单=0；模块头 provenance 首行（「**行号声明（卡头）**」块引行）豁免——行数计量非锚，合法溯源。
//   白名单显式标注「非旧 server/bg 单体坐标」的现役他文件坐标（设计档 §3.3 模式四）。
const LM05_CARD_DEAD_RE = /(?::\d{4,}(?:-\d{4,})?)|(?:\bL\d{4,}(?:-\d{4,})?)/;
const LM05_CARD_DEAD_PROVENANCE_RE = /^\s*>\s*\*\*行号声明/;
const LM05_CARD_DEAD_WHITELIST = [];
{
  const deadHits = [];
  for (const f of lm05Cards) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(LM05_PROTOCOLS_DIR, f), "utf8").split(/\r?\n/); } catch { continue; }
    for (let i = 0; i < lines.length; i++) {
      if (LM05_CARD_DEAD_PROVENANCE_RE.test(lines[i])) continue; // 模块头 provenance 首行豁免
      const m = lines[i].match(new RegExp(LM05_CARD_DEAD_RE.source, "g"));
      if (m && !LM05_CARD_DEAD_WHITELIST.some((w) => w.card === f && w.line === i + 1)) {
        deadHits.push(f + ":" + (i + 1) + "（" + m.slice(0, 3).join(" ") + (m.length > 3 ? " +" + (m.length - 3) : "") + "）");
      }
    }
  }
  ck.ok("卡面死行号锚退役核对：docs/protocols/card-*.md 四位数以上行号锚模式+白名单=0（模块头 provenance 首行豁免）",
    deadHits.length === 0, { hits: deadHits.slice(0, 12), total: deadHits.length, whitelist: LM05_CARD_DEAD_WHITELIST.length });
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

// 规则 4（v1.5 W3-M2 T13，grill#1 G1-1 裁 a）：suites 注册对账扩域两腿——既有 readdir :342-344/
//   规则 1-3 零触碰（impl-plan §6.2），本区只增域不锁总数（字面数不作门口径同规则 1-3）。
//   import 提取面=「from|import+相对字面量」∪「字面量动态 import("…")」三形态并集（side-effect
//   import 与 re-export from 皆入闭包；非字面量动态形不入=静态锁口径，现仓 suites/ 零字面量动态
//   相对导入为既有事实；v1.5 W3-M2 评审 nit-1 顺手修扩域）。
const LM04_R4_IMPORT_RE = /(?:\bfrom\s+|\bimport\b\s*\(?\s*)["'](\.[^"']+)["']/g;
{
  // 全深度文件集（4a/4b 共用收集；域=suites/ 递归全部文件，rules 1-3 顶层 readdir 基建零触碰）
  const r4Files = [];
  (function walkR4(d) {
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of es) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walkR4(p);
      else r4Files.push(p);
    }
  })(LM04_SUITES_DIR);
  const r4Rel = (p) => path.relative(LM04_SUITES_DIR, p).split("\\").join("/");

  // 腿 4a（残渣腿）：suites/ 全深度非 .mjs 文件=红（白名单=无）
  const residue = r4Files.filter((p) => !p.endsWith(".mjs")).map(r4Rel).sort();
  ck.ok("LM-04 规则4a（残渣腿）：suites/ 全深度非 .mjs 文件=0（白名单=无）",
    r4Files.length > 0 && residue.length === 0, { files: r4Files.length, residue: residue.slice(0, 12) });

  // 腿 4b（子目录接线腿）：每子目录 .mjs 全集 ≡ 同目录聚合入口静态 import 闭包
  //   闭包=入口 suites/<dir>.mjs 的相对导入（./<dir>/x.mjs 形态）→其 import 的同目录模块
  //   （./x.mjs 形态）→递归；解析结果落在子目录域外（../ 逃逸/node: 裸名/动态 import）不跟随。
  const r4Problems = [];
  const r4Subdirs = [];
  const r4ClosureStats = {};
  try {
    for (const ent of fs.readdirSync(LM04_SUITES_DIR, { withFileTypes: true }))
      if (ent.isDirectory()) r4Subdirs.push(ent.name);
  } catch { r4Problems.push("tests/suites/ 不可读"); }
  r4Subdirs.sort();
  for (const dir of r4Subdirs) {
    const dirAbs = path.join(LM04_SUITES_DIR, dir);
    const members = r4Files.filter((p) => p.startsWith(dirAbs + path.sep) && p.endsWith(".mjs"));
    const memberKeys = members.map(r4Rel).sort();
    if (memberKeys.length === 0) { r4Problems.push("tests/suites/" + dir + "/ 无 .mjs 成员（空目录）"); r4ClosureStats[dir] = 0; continue; }
    const closure = new Set();
    const queue = [];
    const admit = (resolved) => {
      if (!resolved.startsWith(dirAbs + path.sep) || !resolved.endsWith(".mjs")) return;
      const k = r4Rel(resolved);
      if (!closure.has(k)) { closure.add(k); queue.push(resolved); }
    };
    let entrySrc = "";
    try { entrySrc = fs.readFileSync(path.join(LM04_SUITES_DIR, dir + ".mjs"), "utf8"); }
    catch { r4Problems.push("聚合入口缺席/不可读: tests/suites/" + dir + ".mjs"); r4ClosureStats[dir] = memberKeys.length; continue; }
    for (const m of entrySrc.matchAll(LM04_R4_IMPORT_RE)) admit(path.resolve(LM04_SUITES_DIR, m[1]));
    while (queue.length) {
      const p = queue.pop();
      let modSrc = "";
      try { modSrc = fs.readFileSync(p, "utf8"); } catch { r4Problems.push(r4Rel(p) + " 不可读"); continue; }
      for (const m of modSrc.matchAll(LM04_R4_IMPORT_RE)) admit(path.resolve(path.dirname(p), m[1]));
    }
    const orphans = memberKeys.filter((k) => !closure.has(k));
    if (orphans.length) r4Problems.push("tests/suites/" + dir + "/ 闭包外孤儿: " + orphans.join(","));
    r4ClosureStats[dir] = memberKeys.length;
  }
  ck.ok("LM-04 规则4b（子目录接线腿）：每子目录 .mjs 全集 ≡ 同目录聚合入口静态 import 闭包（闭包外孤儿/入口缺席=红）",
    r4Subdirs.length > 0 && r4Problems.length === 0, { subdirs: r4Subdirs.length, members: r4ClosureStats, problems: r4Problems.slice(0, 12) });
}

// ---- LM-06：v1.3 切分族面锁三腿+登记全景钉（S1 m-20261101-070724-6958；A-v130-SPLIT-*，
//      断言文案逐字=split-impl-design §10 总表 / impl-plan-split §2 S1；计划QA R2 M-1 双补随落） ----
// 机械口径（§2.4）：登记值一律 src.split("\n").length - 1 入册（本仓 .mjs 全尾换行，与 wc -l 等价），
//   F-1 wc -l 值保留为 wcSource 对照注记（S1 步 1③ 实测两口径 ±0）。
/** 机械口径行数（三处消费：CAP 腿 A/腿 B/校准重测） */
const mechLines = (p) => fs.readFileSync(p, "utf8").split("\n").length - 1;

// SCAN 判定域（M-1 补②成文位）：tests/ 递归 *.mjs，**排除两扫描器本体**——
//   tests/harness/source-family.mjs 与 tests/suites/lint-manifest.mjs 两文件自身在册
//   LM06_SCAN_ENTRIES/锚表 rel/族登记键等入口字面（自指面），不入域=β 零自指（S1 波门）。
//   域收窄系实现面细化（§6 处置表「改写 0」口径），断言文案零改动；断言台账 .md 由 *.mjs 收集面天然排除。
const LM06_SCAN_EXCLUDED = ["tests/harness/source-family.mjs", "tests/suites/lint-manifest.mjs"];
const LM06_SCAN_ENTRIES = ["mcp/server.mjs", "hooks/bg-sentinel.mjs"];
// 入口字面正则（动态构造防漂移）：正反斜杠分隔均认（win32 path.join 产反斜杠形态等价）
const LM06_ENTRY_LIT_RE = new RegExp(
  LM06_SCAN_ENTRIES.map((e) => e.replace(/\./g, "\\.").replace(/\//g, "[/\\\\]")).join("|"),
);
const LM06_SCAN_READ_API = /(?:readFileSync|readFileSyncUtf8|readFile|readText|readTextSync|readSync|createReadStream|promises\.readFile|fs\.read(?:File|FileSync)?\s*\()/;
// 判据α：读 API 与入口字面同行/同调用域共现（F-2.1 判据的 multi-API 扩版——覆盖 async/裸 read 变体）
const LM06_SCAN_ALPHA = new RegExp(
  LM06_SCAN_READ_API.source +
  String.raw`[^;]{0,200}?(?:` + LM06_ENTRY_LIT_RE.source + String.raw`)|(?:` + LM06_ENTRY_LIT_RE.source + String.raw`)[^;]{0,200}?` +
  LM06_SCAN_READ_API.source
);
// 判据α族面调用豁免：familySource/familyFiles 实参形态（twin-lock famSrc 包装同豁免，S1 校准增补）
const LM06_SCAN_FAMCALL = new RegExp(
  String.raw`(?:family(?:Source|Files)|famSrc)\s*\([^)]*?(?:` + LM06_ENTRY_LIT_RE.source + String.raw`)`
);
// 判据β合法归类形态集（S1 步 1② 按 F-2.3 九类清单校准落装；实锚与零误报核验记录=tests/assertions/
//   v1.3.0.md §0 S1 小节。红=按校准记录定位误报类增补正则，而非膨胀白名单〔设计档 §2.1 终审口径〕）
const LM06_SCAN_BETA_OK = [
  LM06_SCAN_FAMCALL,                                             // 族面调用（含 famSrc 包装；实锚 twin-lock L334 等）
  /spawn(?:Sync)?\s*\(/,                                          // spawn 执行面（进程启动参数非文件读；现行零字面共线，防御网保留）
  /path\.dirname\s*\(\s*(?:DEFAULT_SERVER|SERVER_PATH)/,          // 路径推导（读第三文件；pack-w2 L77 面）
  /exportFileFromGit|gitShow|git\s+show/,                         // git 历史基线面（condense/pack-materialize/injection 实锚）
  /scope_paths|packPath|resultDir|context_pack|pO1\./,            // 字符串 payload（pack 物化断言域；S1 校准扩 context_pack/pO1.——pack-materialize L122/124/126 实锚）
  /^\s*(?:\/\/|\*|\/\*)/,                                         // 注释行（twin-lock 头注/git-fixture L91 实锚）
  /^\s*ck\.ok\(\s*["'`]/,                                         // 断言文案内提及（F-2.3 文档字面类扩展，trust-root L59 实锚；读面由判据α独立兜底）
  /\brel:\s*["'][^"']*["']/,                                      // 锚表 rel 登记面（twin-lock L55-77 键面实锚；rel 键形态正则兼容 S2 模块级两态）
  /^\s*["'][^"']*["'](?:\s*,\s*["'][^"']*["'])*\s*,?\s*$/,        // 数组元素字面行（M-1 补①：l0-skeleton SCRIPTS L31-32 实锚）
  /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=[^;]*["'][^"']*["']/, // 常量字面定义行（M-1 补①纵深：LM06_SCAN_ENTRIES 同形态；读面共现仍由 α 拦）
  /^\s*["'](?:mcp\/server\.mjs|hooks\/bg-sentinel\.mjs)["']\s*:\s*\{\s*modDir:/, // 族登记表本体（source-family.mjs 排除在域外，域外锚 regex 直测形态验证；防御类）
];
const LM06_SCAN_WHITELIST = [
  { file: "tests/suites/po-static.mjs", why: "bytesOf 披露面：裸 read() 字节计数仅入 ledger 输出行，无源语义断言（F-2.2/S1 白名单终审项）" },
];

// SCAN 域文件收集（tests/ 递归 *.mjs）
const lm06Files = [];
(function walkLm06(d) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) walkLm06(p);
    else if (ent.name.endsWith(".mjs")) lm06Files.push(p);
  }
})(path.join(PLUGIN_DIR, "tests"));
const lm06Rel = (p) => path.relative(PLUGIN_DIR, p).split("\\").join("/");

// 判据α/β 双扫（逐行；域排除两扫描器本体，白名单文件免 α 判定）
{
  const hitsAlpha = [];
  const hitsBeta = [];
  for (const f of lm06Files) {
    const rel = lm06Rel(f);
    if (LM06_SCAN_EXCLUDED.includes(rel)) continue; // M-1 补②：扫描器本体不入判定域
    const wl = LM06_SCAN_WHITELIST.some((w) => w.file === rel);
    let lines = [];
    try { lines = fs.readFileSync(f, "utf8").split("\n"); } catch { continue; }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!LM06_ENTRY_LIT_RE.test(line)) continue;
      const famCall = LM06_SCAN_FAMCALL.test(line);
      if (!wl && !famCall && LM06_SCAN_ALPHA.test(line)) hitsAlpha.push(rel + ":" + (i + 1));
      const classified = famCall || wl || LM06_SCAN_ALPHA.test(line) || LM06_SCAN_BETA_OK.some((re) => re.test(line));
      if (!classified) hitsBeta.push(rel + ":" + (i + 1));
    }
  }
  // 判据α：扫 tests/ 递归 *.mjs（排除断言台账 .md），命中行=α 正则命中且非 FAMCALL 形态且不在白名单
  ck.ok(`LM-06-SCAN 判据α（读 API×两族入口字面共现，族面调用与白名单外）：tests/ 可执行 .mjs 命中=0（白名单 n=${LM06_SCAN_WHITELIST.length}）`,
    hitsAlpha.length === 0, { hits: hitsAlpha.slice(0, 12) });
  // 判据β：全文件入口字面行集合 − (族面调用∪β_OK 归类∪白名单∪判据α命中) = 未归类行
  ck.ok("LM-06-SCAN 判据β（两族入口字面逃逸网）：未归类入口字面行=0",
    hitsBeta.length === 0, { hits: hitsBeta.slice(0, 12), betaOkClasses: "famcall/spawn/dirname/git/payload/comment/ckok-doc/rel-reg/array-const-literal/const-literal/family-reg/whitelist" });
}

// ---- LM-06-DEP：mcp 族依赖单向四规则+层映射表（域=mcp/ 全 22 文件；v2 §3.1 归一版；
//      import 提取=/from\s+["']\.\/([a-z0-9-]+)\.mjs["']/g（相对导入；动态 import 零族内命中
//      =既有事实〔server-core await import("node:sqlite")系 node 内建〕，side-effect import
//      零命中=既有事实，S1 步 1① async 读面扫描零入口源语义读复核随 N2-③一并） ----
{
  const LM06_DEP_IMPORT_RE = /from\s+["']\.\/([a-z0-9-]+)\.mjs["']/g;
  const deps = {}; // { fileName: [importedFileNames] }，域=mcp/ 全 22 文件
  let mcpStems = [];
  try {
    mcpStems = fs.readdirSync(path.join(PLUGIN_DIR, "mcp"))
      .filter((f) => f.endsWith(".mjs")).map((f) => f.replace(/\.mjs$/, "")).sort();
    for (const stem of mcpStems) {
      deps[stem] = [...fs.readFileSync(path.join(PLUGIN_DIR, "mcp", stem + ".mjs"), "utf8")
        .matchAll(LM06_DEP_IMPORT_RE)].map((m) => m[1]);
    }
  } catch { /* mcp/ 缺失=结构性红，四规则与 MAP 全落红 */ }

  // 规则①：模块不 import 入口（入口下行 import memory=合法例外，不在本规则域）
  const r1Offenders = Object.entries(deps)
    .filter(([f]) => f !== "server.mjs").filter(([, ds]) => ds.includes("server.mjs")).map(([f]) => f);
  ck.ok("LM-06-DEP 规则①（禁触入口）：mcp 族 21 模块 import 目标零 ./server.mjs",
    r1Offenders.length === 0, { offenders: r1Offenders.slice(0, 12) });

  // 规则②：判层用 LAYER_OF（键带 .mjs 后缀，§2.0 逐字；查表按 stem+".mjs" 归一）——
  //   上行（b 层 import a 层且 a>b）零容忍；同层=横向，L2 横向仅登记集放行
  const inRegistry = (e) => L2_HORIZONTAL_EDGES.some(([a, b]) => a === e[0] && b === e[1]);
  const layerOf = (stem) => LAYER_OF[stem + ".mjs"];
  const violatesUp = [];
  const horizontalAll = [];
  for (const [f, ds] of Object.entries(deps)) {
    for (const g of ds) {
      const lf = layerOf(f);
      const lg = layerOf(g);
      if (lf === undefined || lg === undefined) continue;
      if (lg > lf) violatesUp.push(f + "->" + g);
      // 同层=横向：仅 L2→L2 受登记集门（L1→L1 互为域内合法=split-design §4 层级模型/F-4.1 实测；
      //   L3 单文件 L4 入口无同层面）
      else if (lf === 2 && lg === 2) horizontalAll.push([f, g]);
    }
  }
  const extraHorizontal = horizontalAll.filter((e) => !inRegistry(e)).map((e) => e[0] + "->" + e[1]);
  ck.ok("LM-06-DEP 规则②（禁上行+横向登记）：L1 零 import L2/L3 且 L2 零 import L3；L2 横向边仅登记集",
    violatesUp.length === 0 && extraHorizontal.length === 0, { violatesUp: violatesUp.slice(0, 12), extraHorizontal: extraHorizontal.slice(0, 12) });

  // 规则③：依赖图拓扑排序可行（Kahn 入度消元，全节点出清=无环）
  const topoSort = (depMap) => {
    const nodes = new Set([...Object.keys(depMap), ...Object.values(depMap).flat()]);
    const indeg = new Map();
    const adj = new Map();
    for (const n of nodes) { indeg.set(n, 0); adj.set(n, []); }
    for (const [f, ds] of Object.entries(depMap)) {
      for (const g of ds) { indeg.set(g, indeg.get(g) + 1); adj.get(f).push(g); }
    }
    const q = [...nodes].filter((n) => indeg.get(n) === 0);
    let popped = 0;
    while (q.length) {
      const n = q.shift();
      popped++;
      for (const g of adj.get(n)) { indeg.set(g, indeg.get(g) - 1); if (indeg.get(g) === 0) q.push(g); }
    }
    return { ok: popped === nodes.size, cycle: popped === nodes.size ? null : [...nodes].filter((n) => indeg.get(n) > 0).slice(0, 12) };
  };
  const topo = topoSort(deps);
  ck.ok("LM-06-DEP 规则③（无环）：mcp 族模块依赖图拓扑排序可行", topo.ok, { cycle: topo.cycle });

  // 规则④：族隔离（bg-sentinel 族 8 子模块+入口 import 目标零 mcp/ 路径；入口随域内加验=加强不弱化）
  const hooksViolations = [];
  const lm06HooksRels = ["hooks/bg-sentinel.mjs",
    ...fs.readdirSync(path.join(PLUGIN_DIR, "hooks", "bg-sentinel"))
      .filter((f) => f.endsWith(".mjs")).map((f) => "hooks/bg-sentinel/" + f)];
  for (const rel of lm06HooksRels) {
    let src = "";
    try { src = fs.readFileSync(path.join(PLUGIN_DIR, rel), "utf8"); } catch { hooksViolations.push(rel + " 不可读"); continue; }
    for (const m of src.matchAll(/(?:from\s+|import\s+)["']([^"']+)["']/g)) {
      if (/(^|\/)mcp\//.test(m[1])) hooksViolations.push(rel + " import " + m[1]);
    }
  }
  ck.ok("LM-06-DEP 规则④（族隔离）：hooks/bg-sentinel/*.mjs import 相对目标零 mcp/ 路径",
    hooksViolations.length === 0, { violations: hooksViolations.slice(0, 12) });

  // MAP：层映射表 ≡ mcp 族文件集（LAYER_OF 25 键与 readdir(mcp/) 递归 stem 双向全等；键带 .mjs 后缀按 stem 归一比对；
  //   v1.5 W2-A 起 mcp/ 含子目录族（tool-dispatch 三模块）→递归收集 bare stem（准入规则②：新模块各登记一行，漏登=红）；
  //   DEP 域（deps builder）维持顶层 22 文件口径不变——子目录族模块不入 DEP 图（bg-sentinel 族规则④先例同构，
  //   族内接线=「入口 import 枚举只作接线核对」域，横向边白名单不受族内边污染）
  const mcpAllStems = [];
  (function walkMcpStems(d) {
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of es) {
      const p2 = path.join(d, ent.name);
      if (ent.isDirectory()) walkMcpStems(p2);
      else if (ent.name.endsWith(".mjs")) mcpAllStems.push(ent.name.replace(/\.mjs$/, ""));
    }
  })(path.join(PLUGIN_DIR, "mcp"));
  mcpAllStems.sort();
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));
  const layerKeys = Object.keys(LAYER_OF);
  const layerStems = layerKeys.map((k) => k.replace(/\.mjs$/, ""));
  ck.ok("LM-06-DEP 层映射表≡mcp 族文件集（LAYER_OF 23 键双向全等〔v1.6 W-p dispatch-model 键随迁出删；v1.6 W3a dispatch-prompt 键随文件退役删〕，含子目录族模块）", sameSet(layerStems, mcpAllStems),
    { missing: mcpAllStems.filter((s) => !layerStems.includes(s)), extra: layerKeys.filter((k) => !mcpAllStems.includes(k.replace(/\.mjs$/, ""))) });
}

// ---- LM-06-CAP：行数帽双域（G-帽裁定 a：软帽域豁免 2 件+触发器+200 / 硬帽域全量 ≤900） ----
const LM06_CAP_SOFT = 900;
const LM06_CAP_EXEMPT = [
  // 登记值=机械口径行数（§2.4，S1 步 1③ 全量重测定格，与 F-1 wc -l 值 ±0）；触发器=+200 量级（split-design OS-4）
  // v1.5 W2-A（T7 裁 a 二拆+OPEN-E 判则 b=G3-3 不等式判则机械承载）：原 mcp/tool-dispatch.mjs 单件登记
  //   （v1.3 S1=1428→v1.4 W3=1646）随拆分注销——薄入口 28 行+组装纯区模块全入帽
  //   （v1.6 W-p：dispatch-model 296 随模块迁 parked/agent-orchestrator/ 注销；v1.6 W3a：
  //   dispatch-prompt 281 随文件整退役注销——帽域登记随 source-family LAYER_OF 同批，本行
  //   dispatch-prompt 半删即 W3a「:686 帽行半删」兑现）
  //   =豁免语义消失；超帽件=dispatch-core（主流程下沉 R1-L3 口径：拆分切面=组装纯区 vs IO 主流程，再下切=
  //   主流程手术另案评估）→准入即族口径登记、仅登记超帽件（OPEN-E 判则 b）。沿革=v1.3 S1 单件 1428→
  //   v1.4 W3 1646→v1.5 W2-A 拆分后 1108 接册→v1.6 W-p headless 迁出 429→v1.6 W3a 组装退役 349 实测重基
  //   （W-p 预注「帽域登记值随实态漂移由 W3a 对拍」兑现；触发器随登记值走=+200）。
  { rel: "mcp/tool-dispatch/dispatch-core.mjs", lines: 349, wcSource: "v1.6-W3a 实测", note: "dispatch IO/主流程模块（组装链退役后=编号出口+哨兵探活+下沉残余承载件；再下切=主流程手术另案，零行为变更 doctrine 红线）；≥549 即红=再评估入口（LM-06-CAP 同源判则）；沿革=v1.3 S1 单件 1428→v1.4 W3 1646→v1.5 W2-A 拆分 1108 接册→v1.6 W-p 429→v1.6 W3a 组装退役 349 重基（旧单件登记同批注销，沿革由本注记承载）" },
  { rel: "mcp/server-lessons.mjs", lines: 932, wcSource: "F-1.1", note: "lessons 域写意图跨三模块（F-4.2）；≥1132 即红同上" },
  // v1.6.4 W1（O-1 豁免登记，Q4③；impl-plan §7 O-1/§2.1 步 7）：server-registry.mjs param desc 填充波
  //   （零描述 67 条 R4 三-way 补齐+存量重写+10 处枚举值语义行）852→921 越 900 软帽——desc 与 schema
  //   同址可读正是本课题目的（调用点自包含、反幻觉），预拆分否决（proposal §6 OPEN-5/grill#1 Q4③）；
  //   登记值=落装后 mechLines 实测（机械口径=split("\n").length-1，F-3 口径；w1-review 修正轮：
  //   首登 914 系 NST-04a 载体修复轮前的实测，终态实测 921 校正）。
  { rel: "mcp/server-registry.mjs", lines: 921, wcSource: "v1.6.4-W1 实测", note: "param desc 唯一域（13 工具 schema 面；工具级 desc 逐字零触）；≥1121 即红=再评估入口（LM-06-CAP 同源判则）；沿革=852（v1.6.3 基线，不在帽域两域任一）→921（v1.6.4 W1 param 面通用语化填充+dispatch.mode 载体修复轮终态，越 900 软帽触发登记；w1-review 修正 914→921）" },
  // v1.4 W3 主控裁决①（m-20261102-043942-9c1a）：glean-launch 硬帽域恰线观察件转豁免登记（与 tool-dispatch 同构），
  //   随豁免域出硬帽域（腿 B 跳过豁免 rel）；登记值=990（wc -l 沙箱实测）。
  // v1.5 W2-A T8 评估回写（impl-plan §5.1 步 3；只评估不实施，零代码零断言改动——腿 A 只读 e.lines 不读 note，
  //   note 改写零红险）：评估完成=留池+理由指针。
  // v1.6 W-p：glean-launch 豁免登记行（v1.4 W3 裁①/v1.5 T8 留池两注记所载行）随
  //   hooks/bg-sentinel/glean-launch.mjs 迁 parked/agent-orchestrator/ 注销——文件已不在域，
  //   腿 A 逐件 mechLines 对缺席件必红故行删；沿革由本注记承载；恢复=parked README 指引+行回植。
];
// 硬帽域口径钉（偏差声明）：设计档 §2.3 草案常量系宽面 glob（hooks/*.mjs、tests/suites/*.mjs），
//   实测会把两件非族面存量拽入域内（hooks/stop-check.mjs=921、tests/suites/glean-launch.mjs=976
//   ——F-1 盘点域与 G-帽裁定均未涉，宽面即日红非裁定意图）。§10 逐字文案钉死的域语义=
//   「hooks 族 9 文件+六套件族 52 文件」=族面文件集，本落装以 7 族 rel 经 familyFiles 取文件集
//   （readdir 动态，新模块自动入域）实现；宽面 glob 草案弃用，偏差随 done 上报主控。
const LM06_CAP_HARD_FAMILIES = ["hooks/bg-sentinel.mjs", "tests/suites/crv8-memory.mjs", "tests/suites/crv6-resilience.mjs",
  "tests/suites/crv6-statemachine.mjs", "tests/suites/crv2-pack.mjs", "tests/suites/watcher-core.mjs",
  "tests/suites/sentinel-teardown.mjs",
  // v1.5 W2-A T7 裁 a：tool-dispatch 族入硬帽域（familyFiles readdir 动态：薄入口+三模块；超帽件
  // dispatch-core 由豁免登记出域——OPEN-E 判则 b 腿 B 跳过语义与 glean-launch 同构）
  "mcp/tool-dispatch.mjs"];
{
  // 腿 A：豁免触发器钉（红=二拆另案评估入口，不拦小步增长）
  const measured = {};
  let exemptOk = true;
  for (const e of LM06_CAP_EXEMPT) {
    let v = null;
    try { v = mechLines(path.join(PLUGIN_DIR, e.rel)); } catch { v = null; }
    measured[e.rel] = v;
    if (!(v !== null && v < e.lines + 200)) exemptOk = false;
  }
  ck.ok("LM-06-CAP 腿 A（豁免触发器钉）：豁免表逐件机械口径行数<登记值+200", exemptOk, { measured });
  // 腿 B：硬帽域 ≤900（恰线观察件转豁免登记后随豁免域出硬帽域——v1.4 W3 主控裁决①：
  //   glean-launch 990 入豁免登记表与 tool-dispatch 同构；域内余件语义不变）
  const exemptRels = new Set(LM06_CAP_EXEMPT.map((e) => e.rel));
  const hardFiles = new Map();
  for (const rel of LM06_CAP_HARD_FAMILIES) for (const p of familyFiles(PLUGIN_DIR, rel)) hardFiles.set(lm06Rel(p), p);
  const hardViolations = [];
  for (const [rel, p] of hardFiles) {
    if (exemptRels.has(rel)) {
      continue;
    }
    let v = null;
    try { v = mechLines(p); } catch { hardViolations.push(rel + " 不可读"); continue; }
    if (v > LM06_CAP_SOFT) hardViolations.push(rel + "=" + v);
  }
  ck.ok("LM-06-CAP 腿 B（硬帽域≤900）：hooks 族+六套件族+dispatch 族实测行数≤900（豁免登记件出域——v1.4 W3 裁① glean-launch〔v1.6 W-p 行随迁出注销〕/v1.5 W2-A dispatch-core 转豁免登记）",
    hardViolations.length === 0, { violations: hardViolations.slice(0, 12), files: hardFiles.size, exempt: [...exemptRels], watch: "glean-launch exempt row retired at v1.6 W-p" });
}

// ---- LM-06 FAMILIES 登记全景钉（OS-2 机械化；防登记面被静默收缩） ----
{
  const famSrcText = fs.readFileSync(path.join(PLUGIN_DIR, "tests", "harness", "source-family.mjs"), "utf8");
  const famKeys = [...famSrcText.matchAll(/"([^"]+)"\s*:\s*\{\s*modDir:/g)].map((m) => m[1]);
  const expected = [...LM06_SCAN_ENTRIES, ...LM06_CAP_HARD_FAMILIES.filter((k) => !LM06_SCAN_ENTRIES.includes(k))];
  ck.ok("LM-06 FAMILIES 登记全景：FAMILIES 键集≡9 族（v1.5 W2-A T7 裁 a：+mcp/tool-dispatch 族）",
    famKeys.length === 9 && expected.every((k) => famKeys.includes(k)) && famKeys.every((k) => expected.includes(k)),
    { got: famKeys });
}

const { pass, fail } = ck.summary();
process.exit(fail ? 1 : 0);
