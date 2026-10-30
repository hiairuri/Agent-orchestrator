#!/usr/bin/env node
// @module twin-lock
/*!
 * suites/twin-lock.mjs —— v1.2 M2-1：五文件 twin 函数行为矩阵锁 + VALUE_TWINS 异名值 twin 值锁 + 负例腿
 * 断言组：A-v0120-TW（impl-plan v2 §批1 M2-1；计数恒为台账非门禁）
 *
 * 被锁五文件（twin 分布段，2026-10-27 实测行号——不作跨版引用，锁面一律按函数名重锚）：
 *   mcp/server.mjs          RESULT_STATUSES:1681  missionAck:1683  lastResultAt:1687  wakeFailureInfo:1708  fmtAge:1725
 *   hooks/session-start.mjs RESULT_STATUSES:52    missionAck:119   lastResultAt:123   wakeFailureInfo:140   fmtAge:157
 *   hooks/stop-check.mjs    RESULT_STATUSES:33    missionAck:599   lastResultAt:603   wakeFailureInfo:620   fmtAge:636
 *   hooks/bg-sentinel.mjs   RESULT_STATUSES:103   missionAck:269   lastResultAt:273   wakeFailureInfo:284   fmtAge:333
 *   watcher/poller.mjs      RESULT_STATUSES:21(export) missionAck:25  lastResultAt:29(export)  wakeFailureInfo:40(export)
 * VALUE_TWINS 三 site（异名值 twin，均 90000）：mcp/server.mjs:3474 SENTINEL_HEARTBEAT_STALE_MS /
 *   hooks/bg-sentinel.mjs:105 HEARTBEAT_STALE_MS / hooks/bg-gate.mjs:37 HEARTBEAT_STALE_MS（B3：心跳龄 >90s 视为不在岗）。
 * VALUE_TWINS v1.2.2 扩围 +4（尾块滞回 20/10 异名值 twin，design v1.2.2 §4 TWN 行）：
 *   mcp/server.mjs DISPATCH_TRACE_TRIM_AT/TO × hooks/stop-check.mjs COORD_TAIL_LOG_TRIM_AT/TO
 *   （读写两侧漂移即语义分叉：写侧 21 块裁回 10 ↔ 读侧 >20 取尾 10）。
 * STRING_TWINS v1.2.2 首例非数值 twin（G-3 顺手项）：DISPATCH_TAIL_MARK/CLOSE（server）
 *   × COORD_TAIL_MARK/CLOSE（stop-check）——协议行字符串字面，引号捕获转义留意（QA-R1 L-5）。
 * TW-CT v1.2.2 转投契约腿（QA-R1 M-5/G-3）：buildPackMarkdown 包节头字面（## LESSONS（…）
 *   × 解析器前缀（^## LESSONS）双 site 同文件在位锁——节头改名而无解析随改=转投静默吞教训，
 *   CT 红即检出；负例腿（前缀盲改副本）红证内建。
 *
 * §0 偏差台账（l-20261022-8fa733：偏差留痕断言文件 §0）：
 *   D1 poller 无 fmtAge 副本（TWIN_SPEC 按文件声明，poller 只锁 3 函数 + 1 常量）。
 *   D2 stop-check.mjs wakeFailureInfo 曾缺 B7 负龄钳制（Math.max(0,…)）——预存真实分叉已清账：
 *      v1.2 发版收尾（m-20261028-062442-5808，2026-10-28）补齐钳制，五文件语义统一（负龄输入统一钳 0），
 *      TW-B7-LEDGER 行已同步更新为已修语义（本条留痕历史分叉，不改判真值）。
 *   D3 机制=行为锁非文本锁：变量名差（entry vs e）、fmtAge 取整形态差（裸 min vs Math.floor，M0-1
 *      fmtAge 统一已落，2026-10-27 工作树实测四文件均裸 min 形态）不碎锁——锁的是同输入同输出。
 *   D4 实例化机制=抽取源码→系统临时目录临时文件→pathToFileURL import（crv2-pack pure 区 W4-DISPATCH
 *      先例形态；v1 引注「data URL import」系上游带病引用，impl-plan L-4 已纠偏留痕）。
 *   D5 负例腿（M-4）内建：源码读入内存→篡改副本→对副本跑同一提取/断言链得红证——零源文件触碰、
 *      零仓库写入（临时件全部落 makeTempRoot=%TEMP%，cleanup 兜底），本套件 git status 须干净。
 *
 * 运行方式：node tests/suites/twin-lock.mjs [--root <临时根父目录>]
 * 前置：node >= 20；无网。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGIN_DIR, Checker } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot, parseRootArg } from "../harness/temp-root.mjs";

// ---- TWIN_SPEC 声明表（五文件 twin 分布；fns/consts 按文件实际持有声明） ----
const TWIN_FILES = [
  { label: "server", rel: "mcp/server.mjs", fns: ["missionAck", "lastResultAt", "wakeFailureInfo", "fmtAge"], consts: ["RESULT_STATUSES"] },
  { label: "session-start", rel: "hooks/session-start.mjs", fns: ["missionAck", "lastResultAt", "wakeFailureInfo", "fmtAge"], consts: ["RESULT_STATUSES"] },
  { label: "stop-check", rel: "hooks/stop-check.mjs", fns: ["missionAck", "lastResultAt", "wakeFailureInfo", "fmtAge"], consts: ["RESULT_STATUSES"] },
  { label: "bg-sentinel", rel: "hooks/bg-sentinel.mjs", fns: ["missionAck", "lastResultAt", "wakeFailureInfo", "fmtAge"], consts: ["RESULT_STATUSES"] },
  { label: "poller", rel: "watcher/poller.mjs", fns: ["missionAck", "lastResultAt", "wakeFailureInfo"], consts: ["RESULT_STATUSES"] },
];

// ---- VALUE_TWINS 异名值 twin 表（语义名锚定，逐 site 提取赋值行断言字面值） ----
const VALUE_TWINS = [
  { rel: "mcp/server.mjs", name: "SENTINEL_HEARTBEAT_STALE_MS", expect: "90000" },
  { rel: "hooks/bg-sentinel.mjs", name: "HEARTBEAT_STALE_MS", expect: "90000" },
  { rel: "hooks/bg-gate.mjs", name: "HEARTBEAT_STALE_MS", expect: "90000" },
  // v1.2.2 尾块滞回 20/10 异名值 twin（写侧 stop-check × 读侧 server；漂移即读写语义分叉）
  { rel: "mcp/server.mjs", name: "DISPATCH_TRACE_TRIM_AT", expect: "20" },
  { rel: "mcp/server.mjs", name: "DISPATCH_TRACE_TRIM_TO", expect: "10" },
  { rel: "hooks/stop-check.mjs", name: "COORD_TAIL_LOG_TRIM_AT", expect: "20" },
  { rel: "hooks/stop-check.mjs", name: "COORD_TAIL_LOG_TRIM_TO", expect: "10" },
];

// ---- STRING_TWINS v1.2.2 首例非数值 twin（G-3 顺手项；引号字面捕获，值内无引号/反斜杠前提） ----
const STRING_TWINS = [
  { a: { rel: "mcp/server.mjs", name: "DISPATCH_TAIL_MARK" }, b: { rel: "hooks/stop-check.mjs", name: "COORD_TAIL_MARK" } },
  { a: { rel: "mcp/server.mjs", name: "DISPATCH_TAIL_CLOSE" }, b: { rel: "hooks/stop-check.mjs", name: "COORD_TAIL_CLOSE" } },
];

const RS_PIN = ["done", "failed", "blocked", "question"];

// ---- 提取器（对任意源码文本工作，负例腿复用同一链） ----
const LF = (s) => s.replace(/\r\n/g, "\n");

/** 函数体截取：签名锚计数恰一 + 花括号配平（twin 体无跨行字符串/注释括号失衡面）。 */
function extractFnBody(srcLF, fnName) {
  const sig = "function " + fnName + "(";
  const n = srcLF.split(sig).length - 1;
  if (n !== 1) throw new Error("anchor " + sig + " count=" + n);
  const start = srcLF.indexOf(sig);
  const open = srcLF.indexOf("{", start);
  if (open < 0) throw new Error("no body for " + fnName);
  let depth = 0;
  for (let i = open; i < srcLF.length; i++) {
    const ch = srcLF[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return srcLF.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces for " + fnName);
}

/** 常量行捕获：行首锚计数恰一，返回表达式文本（如 ["done", ...]）。 */
function captureConst(srcLF, constName) {
  const re = new RegExp("(?:^|\\n)(?:export )?const " + constName + " = ([^;\\n]+);", "g");
  const hits = srcLF.match(re) || [];
  if (hits.length !== 1) throw new Error("anchor const " + constName + " count=" + hits.length);
  const m = hits[0].match(new RegExp("const " + constName + " = ([^;\\n]+);"));
  if (!m) throw new Error("capture fail const " + constName);
  return m[1];
}

/** mini-module 组装：consts + 函数体 + export 面（仅本文件声明项）。 */
function assembleModuleText(srcLF, spec) {
  const parts = [];
  for (const c of spec.consts) parts.push("const " + c + " = " + captureConst(srcLF, c) + ";");
  for (const fn of spec.fns) parts.push(extractFnBody(srcLF, fn));
  parts.push("export { " + spec.consts.concat(spec.fns).join(", ") + " };");
  return parts.join("\n\n") + "\n";
}

// ---- harness ----
const ck = new Checker("twin-lock");
const T = makeTempRoot({ prefix: "orch-twin-lock-", root: parseRootArg() || undefined });
let seq = 0;
async function instantiate(label, moduleText) {
  seq++;
  const file = path.join(T.root, "twin-" + label + "-" + seq + ".mjs");
  fs.writeFileSync(file, moduleText);
  return await import(pathToFileURL(file).href + "?v=" + seq);
}
const stable = (v) =>
  JSON.stringify(v, (_k, x) => {
    if (x && typeof x === "object" && !Array.isArray(x)) {
      const o = {};
      for (const k of Object.keys(x).sort()) o[k] = x[k];
      return o;
    }
    return x;
  });
/** 行为矩阵断言：makeCall(mod) 对每文件求值，全文件同钉值方绿；败者逐文件留痕。 */
function twinCase(name, files, makeCall, expect) {
  const bad = [];
  for (const f of files) {
    let out;
    try {
      out = makeCall(f.mod);
    } catch (e) {
      bad.push(f.label + " threw " + String((e && e.message) || e).slice(0, 80));
      continue;
    }
    if (stable(out) !== stable(expect)) bad.push(f.label + "=" + stable(out).slice(0, 140));
  }
  ck.ok(name, bad.length === 0, bad.slice(0, 5));
}

try {
  // ---- 抽取自证（施工首步重锚后的机械校验；锚点唯一性正则计数，l-20261023-31e613） ----
  const SRC = {};
  const anchorProblems = [];
  for (const f of TWIN_FILES) {
    const p = path.join(PLUGIN_DIR, f.rel);
    if (!fs.existsSync(p)) {
      anchorProblems.push(f.rel + ": missing");
      continue;
    }
    const src = LF(fs.readFileSync(p, "utf8"));
    SRC[f.label] = src;
    for (const fn of f.fns) {
      const n = src.split("function " + fn + "(").length - 1;
      if (n !== 1) anchorProblems.push(f.rel + "#function " + fn + "( x" + n);
    }
    for (const c of f.consts) {
      const n = (src.match(new RegExp("(?:^|\\n)(?:export )?const " + c + " = ", "g")) || []).length;
      if (n !== 1) anchorProblems.push(f.rel + "#const " + c + " x" + n);
    }
  }
  ck.ok(
    "TW-EXT-01 五文件读取 + TWIN_SPEC 锚点唯一性（" +
      TWIN_FILES.reduce((a, f) => a + f.fns.length + f.consts.length, 0) + " 锚逐锚恰一）",
    anchorProblems.length === 0,
    anchorProblems.slice(0, 6),
  );

  const mods = [];
  const instProblems = [];
  for (const f of TWIN_FILES) {
    try {
      const mod = await instantiate(f.label, assembleModuleText(SRC[f.label], f));
      const missing = f.consts.concat(f.fns).filter((k) => typeof mod[k] === "undefined");
      if (missing.length) instProblems.push(f.label + " missing exports: " + missing.join(","));
      else mods.push({ label: f.label, spec: f, mod });
    } catch (e) {
      instProblems.push(f.label + ": " + String((e && e.message) || e).slice(0, 120));
    }
  }
  ck.ok(
    "TW-EXT-02 抽取源码→系统临时文件→pathToFileURL import 实例化 " + TWIN_FILES.length + "/" + TWIN_FILES.length + "（导出面齐全）",
    instProblems.length === 0 && mods.length === TWIN_FILES.length,
    instProblems.slice(0, 6),
  );

  // ---- RESULT_STATUSES 常量锁（5 文件逐文件钉值） ----
  mods.forEach((f, i) => {
    ck.ok(
      "TW-CONST-0" + (i + 1) + " RESULT_STATUSES 钉值（" + f.label + "）",
      stable(f.mod.RESULT_STATUSES) === stable(RS_PIN),
      stable(f.mod.RESULT_STATUSES),
    );
  });

  // ---- missionAck 行为矩阵（null m / 无 ack / ack 非对象 / 有 ack 对象） ----
  twinCase("TW-MA-01 missionAck(null) 与 missionAck({}) 同返 null", mods,
    (mod) => [mod.missionAck(null), mod.missionAck({})], [null, null]);
  twinCase("TW-MA-02 missionAck({ack:null}) → null（ack 空值）", mods,
    (mod) => mod.missionAck({ ack: null }), null);
  twinCase("TW-MA-03 missionAck({ack:'str'}) → null（ack 非对象）", mods,
    (mod) => mod.missionAck({ ack: "str" }), null);
  twinCase("TW-MA-04 missionAck({ack:{at:'t1'}}) → 原对象返回", mods,
    (mod) => mod.missionAck({ ack: { at: "t1" } }), { at: "t1" });

  // ---- lastResultAt 行为矩阵（末条 report / 尾部无 at 回落 / updated_at 兜底 / String 强转） ----
  twinCase("TW-LR-01 lastResultAt(null) 与 lastResultAt({}) 同返 null", mods,
    (mod) => [mod.lastResultAt(null), mod.lastResultAt({})], [null, null]);
  twinCase("TW-LR-02 末条 report:at 优先（尾部非 report 事件被跳过）", mods,
    (mod) => mod.lastResultAt({ timeline: [{ event: "x", at: "T2" }, { event: "report:done", at: "T1" }] }), "T1");
  twinCase("TW-LR-03 尾部 report 无 at 跳过，回落前一 report:at", mods,
    (mod) => mod.lastResultAt({ timeline: [{ event: "x", at: "T2" }, { event: "report:failed", at: "T3" }, { event: "report:ok" }] }), "T3");
  twinCase("TW-LR-04 无 report:at 回落 updated_at", mods,
    (mod) => mod.lastResultAt({ timeline: [{ event: "report:ok" }], updated_at: "U9" }), "U9");
  twinCase("TW-LR-05 空 timeline + 数字 updated_at → String 强转", mods,
    (mod) => mod.lastResultAt({ timeline: [], updated_at: 123 }), "123");

  // ---- wakeFailureInfo 行为矩阵（W1-W4 四条件负例全量 + 三正例；Date.now 固定保证确定性） ----
  const T0 = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const mBase = { status: "done", dispatch: { agent_id: "ag1", mode: "agent" } };
  const negShape = { suspected: false, result_at: null, minutes: null };
  const realNow = Date.now;
  try {
    Date.now = () => T0;
    twinCase("TW-WF-01 W1 破（status 非终态 running）→ suspected:false 固定形状", mods,
      (mod) => mod.wakeFailureInfo({ ...mBase, status: "running" }), negShape);
    twinCase("TW-WF-02 W2 破（dispatch.agent_id 缺）→ suspected:false", mods,
      (mod) => mod.wakeFailureInfo({ status: "done", dispatch: {} }), negShape);
    twinCase("TW-WF-03 W3 破（已 ack）→ suspected:false", mods,
      (mod) => mod.wakeFailureInfo({ ...mBase, ack: { at: "x" } }), negShape);
    twinCase("TW-WF-04 W4 破（dispatch.mode=workflow 不参与）→ suspected:false", mods,
      (mod) => mod.wakeFailureInfo({ status: "done", dispatch: { agent_id: "ag1", mode: "workflow" } }), negShape);
    twinCase("TW-WF-05 正例：report:at 90 分钟前 → minutes=90", mods,
      (mod) => mod.wakeFailureInfo({ ...mBase, timeline: [{ event: "report:done", at: iso(T0 - 90 * 60000) }] }),
      { suspected: true, result_at: iso(T0 - 90 * 60000), minutes: 90 });
    twinCase("TW-WF-06 正例：无 report 走 updated_at 5 分钟前 → minutes=5", mods,
      (mod) => mod.wakeFailureInfo({ status: "done", dispatch: { agent_id: "ag1" }, updated_at: iso(T0 - 5 * 60000) }),
      { suspected: true, result_at: iso(T0 - 5 * 60000), minutes: 5 });
    twinCase("TW-WF-07 正例：非法时间串 → minutes=null（result_at 原样透传）", mods,
      (mod) => mod.wakeFailureInfo({ ...mBase, timeline: [{ event: "report:done", at: "not-a-date" }] }),
      { suspected: true, result_at: "not-a-date", minutes: null });

    // B7 台账（§0 D2，已修语义）：负龄输入（时钟回拨）下五文件统一 Math.max(0,…) 钳 0——stop-check
    // 钳制已补（v1.2 发版收尾 m-20261028-062442-5808），预存分叉清账。
    const byLabel = {};
    for (const f of mods) byLabel[f.label] = f.mod.wakeFailureInfo({ ...mBase, timeline: [{ event: "report:done", at: iso(T0 + 10 * 60000) }] }).minutes;
    const clampedAll = ["server", "session-start", "bg-sentinel", "poller", "stop-check"].every((l) => byLabel[l] === 0);
    ck.ok(
      "TW-B7-LEDGER 已修语义：负龄输入 5 文件统一钳 0（stop-check 已补 Math.max(0,…)，分叉清账）",
      clampedAll,
      byLabel,
    );
  } finally {
    Date.now = realNow;
  }

  // ---- fmtAge 行为矩阵（分界值；poller 无 fmtAge 副本，§0 D1） ----
  const FA_FILES = mods.filter((f) => f.spec.fns.includes("fmtAge"));
  twinCase("TW-FA-01 fmtAge(0)/(0.5) → 刚刚（<1 分界）", FA_FILES,
    (mod) => [mod.fmtAge(0), mod.fmtAge(0.5)], ["刚刚", "刚刚"]);
  twinCase("TW-FA-02 fmtAge(59) → 59 分钟前（<60 分界）", FA_FILES,
    (mod) => mod.fmtAge(59), "59 分钟前");
  twinCase("TW-FA-03 fmtAge(60) → 1 小时 0 分钟前（≥60 进位分界）", FA_FILES,
    (mod) => mod.fmtAge(60), "1 小时 0 分钟前");
  twinCase("TW-FA-04 fmtAge(90) → 1 小时 30 分钟前", FA_FILES,
    (mod) => mod.fmtAge(90), "1 小时 30 分钟前");
  twinCase("TW-FA-05 fmtAge(125) → 2 小时 5 分钟前", FA_FILES,
    (mod) => mod.fmtAge(125), "2 小时 5 分钟前");
  twinCase("TW-FA-06 fmtAge(null)/(NaN)/(Infinity) → 空串三连", FA_FILES,
    (mod) => [mod.fmtAge(null), mod.fmtAge(NaN), mod.fmtAge(Infinity)], ["", "", ""]);

  // ---- VALUE_TWINS 七 site 值锁（逐 site 恰一定义 + 字面值；v1.2.2 扩 +4 滞回 20/10） ----
  VALUE_TWINS.forEach((vt, i) => {
    const src = LF(fs.readFileSync(path.join(PLUGIN_DIR, vt.rel), "utf8"));
    const re = new RegExp("(?:^|\\n)const " + vt.name + " = (\\d+);", "g");
    const hits = src.match(re) || [];
    const vals = hits.map((h) => (h.match(new RegExp("const " + vt.name + " = (\\d+);")) || [])[1]);
    ck.ok(
      "TW-VAL-0" + (i + 1) + " " + vt.rel + "#" + vt.name + " 恰一定义且字面值=" + vt.expect,
      hits.length === 1 && vals[0] === vt.expect,
      vals,
    );
  });

  // ---- STRING_TWINS 历史字符串 twin（v1.2.2 首例非数值；G-3 顺手项，QA-R1 L-5） ----
  /** 引号字符串字面捕获：行首锚恰一 + "([^"]*)"（值内无引号/反斜杠前提，mark/close 满足）。 */
  function captureString(srcLF, name) {
    const re = new RegExp('(?:^|\\n)const ' + name + ' = "([^"]*)";', "g");
    const hits = srcLF.match(re) || [];
    if (hits.length !== 1) throw new Error("anchor const " + name + " x" + hits.length);
    return hits[0].match(new RegExp('const ' + name + ' = "([^"]*)";'))[1];
  }
  STRING_TWINS.forEach((st, i) => {
    let va = null;
    let vb = null;
    let detail = "";
    try {
      va = captureString(LF(fs.readFileSync(path.join(PLUGIN_DIR, st.a.rel), "utf8")), st.a.name);
      vb = captureString(LF(fs.readFileSync(path.join(PLUGIN_DIR, st.b.rel), "utf8")), st.b.name);
      detail = va + " vs " + vb;
    } catch (e) {
      detail = String((e && e.message) || e).slice(0, 120);
    }
    ck.ok(
      "TW-STW-0" + (i + 1) + " 历史字符串 twin（v1.2.2 G-3）：" + st.a.rel + "#" + st.a.name + " ≡ " + st.b.rel + "#" + st.b.name,
      va !== null && va === vb && va.length > 0,
      detail,
    );
  });

  // ---- TW-CT 转投契约腿（v1.2.2，QA-R1 M-5/G-3）：包节头字面 × 解析器前缀双 site 同文件在位——
  // 节头改名而无解析随改=转投静默吞教训（RV-3 型），CT 红即检出。负例腿红证内建（零源触碰）。 ----
  {
    const serverLF = LF(fs.readFileSync(path.join(PLUGIN_DIR, "mcp/server.mjs"), "utf8"));
    const ctPackHeader = (serverLF.match(/"## LESSONS（[^"]*"/g) || []).length;
    const ctParserPrefix = (serverLF.match(/\^## LESSONS/g) || []).length;
    ck.ok(
      "TW-CT-01 转投契约双腿在位：buildPackMarkdown 包节头字面（## LESSONS（…）恰 1）× 解析器前缀（^## LESSONS 恰 1）同文件双 site",
      ctPackHeader === 1 && ctParserPrefix === 1,
      { ctPackHeader, ctParserPrefix },
    );
    const ctTam = serverLF.replace("/^## LESSONS/", "/^## LESSONZ/");
    let ctNeg = false;
    let ctNegDetail = "tamper not applied";
    if (ctTam !== serverLF && ctTam.includes("/^## LESSONZ/")) {
      const p2 = (ctTam.match(/\^## LESSONS/g) || []).length;
      ctNeg = p2 === 0; // 解析器盲改后 CT-01 判据在副本上破 → 检出（静默吞教训面红证）
      ctNegDetail = "parser prefix hits after tamper=" + p2;
    }
    ck.ok("TW-CT-NEG 负例腿：解析器前缀盲改副本（内存）被 CT 判据检出（红证成立）", ctNeg, ctNegDetail);
  }

  // ---- 负例腿（M-4 内建红证：内存副本篡改 → 同一提取/断言链检出分叉；零源触碰零仓库写入） ----
  // NEG-1 fmtAge：min<60 分界篡改 → fmtAge(59) 偏离钉值。
  const t1 = SRC.server.replace("if (min < 60)", "if (min < 30)");
  const t1Applied = t1 !== SRC.server && t1.includes("if (min < 30)");
  let neg1 = false;
  let neg1Detail = "tamper not applied";
  if (t1Applied) {
    try {
      const m1 = await instantiate("neg-fmtage", assembleModuleText(t1, TWIN_FILES[0]));
      // 红证判据=偏离 TW-FA-02 钉值（篡改后 59 落小时支路 → "0 小时 59 分钟前"，与钉值分叉即被锁检出）
      neg1 = m1.fmtAge(59) !== "59 分钟前";
      neg1Detail = "tampered fmtAge(59)=" + m1.fmtAge(59);
    } catch (e) {
      neg1Detail = "inst: " + String((e && e.message) || e).slice(0, 80);
    }
  }
  ck.ok("TW-NEG-01 负例腿①：fmtAge 篡改副本（内存）行为分叉被检出（红证成立）", t1Applied && neg1, neg1Detail);

  // NEG-2 wakeFailureInfo：W1 status 门摘除（锚全库唯一 count=1）→ running 终态误判 suspected。
  const t2 = SRC.server.replace("RESULT_STATUSES.includes(m.status)", "true");
  const t2Applied = t2 !== SRC.server;
  let neg2 = false;
  let neg2Detail = "tamper not applied";
  if (t2Applied) {
    try {
      const m2 = await instantiate("neg-wake", assembleModuleText(t2, TWIN_FILES[0]));
      const out2 = m2.wakeFailureInfo({ status: "running", dispatch: { agent_id: "ag1" } });
      neg2 = out2.suspected === true; // 篡改后偏离钉值 negShape → 检出
      neg2Detail = "tampered " + stable(out2);
    } catch (e) {
      neg2Detail = "inst: " + String((e && e.message) || e).slice(0, 80);
    }
  }
  ck.ok("TW-NEG-02 负例腿②：wakeFailureInfo status 门摘除（内存副本）被检出（红证成立）", t2Applied && neg2, neg2Detail);

  // NEG-3 VALUE_TWINS：bg-gate 内存副本 90000→89999 → 值锁提取检出。
  const srcG = LF(fs.readFileSync(path.join(PLUGIN_DIR, "hooks/bg-gate.mjs"), "utf8"));
  const t3 = srcG.replace("const HEARTBEAT_STALE_MS = 90000;", "const HEARTBEAT_STALE_MS = 89999;");
  const t3Applied = t3 !== srcG && t3.includes("const HEARTBEAT_STALE_MS = 89999;");
  let neg3 = false;
  let neg3Detail = "tamper not applied";
  if (t3Applied) {
    const re3 = /(?:^|\n)const HEARTBEAT_STALE_MS = (\d+);/g;
    const hits3 = t3.match(re3) || [];
    const v3 = hits3.length === 1 ? (hits3[0].match(/const HEARTBEAT_STALE_MS = (\d+);/) || [])[1] : null;
    neg3 = hits3.length === 1 && v3 !== "90000"; // 值锁判据在副本上成立检出
    neg3Detail = "captured=" + v3;
  }
  ck.ok("TW-NEG-03 负例腿③：VALUE_TWINS 值篡改副本（内存）被检出（红证成立）", t3Applied && neg3, neg3Detail);
} catch (e) {
  ck.ok("TW-FATAL 未捕获异常", false, String((e && e.stack) || e).slice(0, 300));
} finally {
  T.cleanup();
}
const { pass, fail } = ck.summary();
process.exit(fail ? 1 : 0);
