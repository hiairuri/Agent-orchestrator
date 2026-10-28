// @module crv4-audit
/*!
 * suites/crv4-audit.mjs —— CRV4-01…05（files_touched 审计）+ CR-V18…V21/V29（manifest 七步管线）
 *
 * 覆盖断言组：A-v050-CRV4-01…05、CR-V18（sidecar 落盘）/V19（形状软丢弃）/V20（帽值执行）/
 *   V21（server 桩 vs 零产物负例）/V29（QA 机械比对）、milestone 不写 manifest 补充、
 *   report schema 不变量（files_touched maxItems=50+description 逐字、manifest_entries maxItems=12）、
 *   QA 修复验收（report(done,artifacts) 写回→T2 桩→下游非 L3：QA-A1…A5）。
 *   转录自 v05-impl-05/acceptance-probe.mjs。
 *
 * 运行方式：node tests/suites/crv4-audit.mjs [--root <临时根>]
 * 前置：node >= 20；无 git 依赖（断言夹具文件建于临时项目目录 P）。
 */
import fs from "node:fs";
import path from "node:path";
import { startServer, Checker } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot, parseRootArg } from "../harness/temp-root.mjs";

const ck = new Checker("crv4-audit");
const BASE = makeTempRoot({ prefix: "orch-crv4-", root: parseRootArg() || undefined });
const P = path.join(BASE.root, "proj"); // 项目目录（断言夹具所在，server cwd）
const T = path.join(BASE.root, "root"); // orchestrator 根
fs.mkdirSync(path.join(P, "tests", "assertions"), { recursive: true });
fs.mkdirSync(T, { recursive: true });
const ASSERT_MAIN = "验收断言 A-V050-T01：report 收口七步管线落盘且软处置。";
fs.writeFileSync(path.join(P, "tests", "assertions", "sample.md"), "# sample\n\n- " + ASSERT_MAIN + "\n");

const s = startServer({ root: T, cwd: P });
const resultText = (r) => r.json ?? { _raw: r.text };
const upsert = (mission) => s.call("board", { action: "upsert", mission });
const get = (mission_id) => s.call("board", { action: "get", mission_id });
const report = (args) => s.call("report", args);

try {
  // ---- setup missions
  await upsert({ id: "m1", title: "manifest 正例" });
  await upsert({ id: "m3", title: "审计正例", scope_paths: ["src/"] });
  await upsert({ id: "m4", title: "界内申报", scope_paths: ["src/"] });
  await upsert({ id: "m5", title: "未登记不审" });
  await upsert({ id: "m6", title: "blocked 存证", scope_paths: ["src/"] });
  await upsert({ id: "m2", title: "server 桩", artifacts: ["out/report.md", "out/data.json"] });
  await upsert({ id: "m3b", title: "零申报零产物" });
  await upsert({ id: "m7", title: "形状软丢弃" });
  await upsert({ id: "m8", title: "帽值执行" });
  await upsert({ id: "m9", title: "assertion 比对" });
  await upsert({ id: "m10", title: "assertion 篡改" });
  await upsert({ id: "m11", title: "assertion 不可读" });
  await upsert({ id: "m12", title: "conclusion 不比对" });

  // ---- invariants
  {
    const tools = (await s.tools()).tools || [];
    ck.ok("INV tools-list=12（v0.6 A6 probe 转正 + v1.1.1 W20 dispatch 口径）", tools.length === 12, String(tools.length));
    const rep = tools.find((t) => t.name.endsWith("report"));
    ck.ok("INV schema files_touched（maxItems=50+description 逐字）", rep.inputSchema.properties.files_touched?.maxItems === 50 &&
      rep.inputSchema.properties.files_touched?.description === "Changed paths; audited against the mission scope for milestone/done only");
    ck.ok("INV schema manifest_entries maxItems=12", rep.inputSchema.properties.manifest_entries?.maxItems === 12);
    ck.ok("INV BOARD_VERSION=2", JSON.parse(fs.readFileSync(path.join(T, "board.json"), "utf8")).version === 2);
  }

  // ---- CRV4-01
  {
    const out = resultText(await report({ mission_id: "m3", worker: "w#1", kind: "done", summary: "s", files_touched: ["src/a.js", "README.md"] }));
    ck.ok("CRV4-01 ok+nonIsError", out.ok === true);
    ck.ok("CRV4-01 warn_scope only-README", Array.isArray(out.warn_scope) && out.warn_scope.includes("README.md") && !out.warn_scope.includes("src/a.js"), out.warn_scope);
    ck.ok("CRV4-01 warn 合计行提及", typeof out.warn === "string" && out.warn.includes("README.md"));
  }
  // ---- CRV4-02
  {
    const dir = path.join(T, "spool", "m3", "unread");
    const f = fs.readdirSync(dir).filter((x) => x.endsWith(".json"))[0];
    const ev = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    ck.ok("CRV4-02 spool 存证两路径全量", Array.isArray(ev.files_touched) && ev.files_touched.includes("src/a.js") && ev.files_touched.includes("README.md"), ev.files_touched);
  }
  // ---- CRV4-03
  {
    const mm = resultText(await s.call("board", { action: "get", mission_id: "m3", view: "full" }));
    ck.ok("CRV4-03 scope_violations 恰 [README.md]", JSON.stringify(mm.scope_violations) === JSON.stringify(["README.md"]), mm.scope_violations);
    ck.ok("CRV4-03 timeline 审计事件", (mm.timeline || []).some((t) => t.event === "scope_violation" && String(t.summary).includes("README.md")));
    const list = resultText(await s.call("board", { action: "list" }));
    const row = (list.missions || []).find((x) => x.id === "m3");
    ck.ok("CRV4-03 board(list) 行可见（G-5）", row && JSON.stringify(row.scope_violations) === JSON.stringify(["README.md"]));
  }
  // ---- CRV4-04
  {
    const r4 = resultText(await report({ mission_id: "m4", worker: "w#1", kind: "done", summary: "s", files_touched: ["src/b.js"] }));
    const M4 = resultText(await get("m4"));
    ck.ok("CRV4-04a 界内申报静默", r4.warn_scope === undefined && !Array.isArray(M4.scope_violations), { ws: r4.warn_scope, sv: M4.scope_violations });
    const r5 = resultText(await report({ mission_id: "m5", worker: "w#1", kind: "done", summary: "s", files_touched: ["anywhere/x.js"] }));
    const M5 = resultText(await get("m5"));
    ck.ok("CRV4-04b 未登记零审计产物", r5.warn_scope === undefined && !Array.isArray(M5.scope_violations));
  }
  // ---- CRV4-05（G-7 存证不审计）
  {
    await report({ mission_id: "m6", worker: "w#1", kind: "blocked", summary: "s", question: "q?", files_touched: ["evil.js"] });
    const dir = path.join(T, "spool", "m6", "unread");
    const f = fs.readdirSync(dir).filter((x) => x.endsWith(".json"))[0];
    const ev = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    ck.ok("CRV4-05a 事件内存证原样", JSON.stringify(ev.files_touched) === JSON.stringify(["evil.js"]), ev.files_touched);
    const M6 = resultText(await get("m6"));
    ck.ok("CRV4-05b scope_violations 不变", !Array.isArray(M6.scope_violations) || M6.scope_violations.length === 0);
  }
  // ---- CR-V18
  {
    const entries = [
      { layer: "T0", type: "directive", title: "目标逐字", text: "必须照办的原话", ref: { path: "packs/m1/pack.md", loc: "TASK" } },
      { layer: "T1", type: "conclusion", title: "关键结论", text: "七步管线已收口", ref: { path: "src/x.js", loc: "L10-L20" } },
      { layer: "T2", type: "anchor", title: "落点指针", ref: { path: "src/y.js" } },
    ];
    const r = resultText(await report({ mission_id: "m1", worker: "w#1", kind: "done", summary: "s", manifest_entries: entries }));
    ck.ok("CR-V18 ok nonIsError", r.ok === true);
    const sc = JSON.parse(fs.readFileSync(path.join(T, "packs", "m1", "manifest.json"), "utf8"));
    ck.ok("CR-V18 sidecar v=1+count+source", sc.v === 1 && sc.mission_id === "m1" && sc.entries.length === 3 && !!sc.generated_at && sc.source === "worker", { v: sc.v, n: sc.entries?.length });
    ck.ok("CR-V18 ids 顺序 c01..c03", sc.entries.map((e) => e.id).join(",") === "c01,c02,c03");
    ck.ok("CR-V18 T2 无 text", sc.entries[2].text === undefined && sc.entries[0].text === "必须照办的原话");
    const mm = resultText(await get("m1"));
    ck.ok("CR-V18 指针三字段", mm.manifest && typeof mm.manifest.path === "string" && mm.manifest.entry_count === 3 && !!mm.manifest.updated_at, mm.manifest);
    ck.ok("CR-V18 帽内无 note/warnings", r.manifest_note === undefined && r.manifest_warnings === undefined);
  }
  // ---- CR-V19
  {
    const entries = [
      { layer: "T3", type: "anchor", title: "bad layer", ref: { path: "a" } },
      { layer: "T1", type: "summary", title: "bad type", text: "x", ref: { path: "b" } },
      { layer: "T1", type: "conclusion", text: "no title", ref: { path: "c" } },
      { layer: "T2", type: "anchor", title: "good", ref: { path: "d" } },
    ];
    const r = resultText(await report({ mission_id: "m7", worker: "w#1", kind: "done", summary: "s", manifest_entries: entries }));
    ck.ok("CR-V19 非 isError", r.ok === true);
    const sc = JSON.parse(fs.readFileSync(path.join(T, "packs", "m7", "manifest.json"), "utf8"));
    ck.ok("CR-V19 违规条不入 sidecar", sc.entries.length === 1 && sc.entries[0].ref.path === "d", sc.entries.length);
    ck.ok("CR-V19 note 列丢弃数+原因", typeof r.manifest_note === "string" && r.manifest_note.includes("3 条") && r.manifest_note.includes("layer") && r.manifest_note.includes("type") && r.manifest_note.includes("title"), r.manifest_note);
  }
  // ---- CR-V20
  {
    const many = Array.from({ length: 13 }, (_, i) => ({ layer: "T1", type: "conclusion", title: `t${i}`, text: "正文" + i, ref: { path: `f${i}` } }));
    const r = resultText(await report({ mission_id: "m8", worker: "w#1", kind: "done", summary: "s", manifest_entries: many }));
    const sc = JSON.parse(fs.readFileSync(path.join(T, "packs", "m8", "manifest.json"), "utf8"));
    ck.ok("CR-V20a 13→12 丢尾+note", sc.entries.length === 12 && typeof r.manifest_note === "string" && r.manifest_note.includes("丢弃尾部 1 条"), r.manifest_note);
  }
  {
    await upsert({ id: "m8c", title: "T0/T1 截断标记" });
    const bigT0 = { layer: "T0", type: "anchor", title: "big", text: "字节".repeat(3000), ref: { path: "big0" } };
    const bigT1 = { layer: "T1", type: "conclusion", title: "bigt1", text: "字".repeat(900), ref: { path: "big1" } };
    await report({ mission_id: "m8c", worker: "w#1", kind: "done", summary: "s", manifest_entries: [bigT0, bigT1] });
    const sc = JSON.parse(fs.readFileSync(path.join(T, "packs", "m8c", "manifest.json"), "utf8"));
    const t0 = sc.entries.find((e) => e.layer === "T0");
    ck.ok("CR-V20b T0 字节截断标记", t0 && Buffer.byteLength(t0.text.replace(/…\[截断于\d+字节\]$/, ""), "utf8") <= 4000 && /…\[截断于\d+字节\]$/.test(t0.text), t0 && t0.text.slice(-14));
    const t1 = sc.entries.find((e) => e.ref.path === "big1");
    ck.ok("CR-V20c T1 字截断标记", t1 && /^[\s\S]{500}…\[截断于500字\]$/.test(t1.text), t1 && t1.text.slice(-12));
  }
  {
    await upsert({ id: "m8b", title: "32KB 总帽" });
    const fat = Array.from({ length: 12 }, (_, i) => ({ layer: "T0", type: "conclusion", title: `fat${i}`, text: "胖".repeat(3000), ref: { path: `fat${i}` } }));
    await report({ mission_id: "m8b", worker: "w#1", kind: "done", summary: "s", manifest_entries: fat });
    const scPath = path.join(T, "packs", "m8b", "manifest.json");
    const sc = JSON.parse(fs.readFileSync(scPath, "utf8"));
    const bytes = fs.statSync(scPath).size;
    ck.ok("CR-V20d 32KB 文件帽丢尾", bytes <= 32 * 1024 && sc.entries.length < 12, `bytes=${bytes} n=${sc.entries.length}`);
  }
  // ---- CR-V21
  {
    const r = resultText(await report({ mission_id: "m2", worker: "w#1", kind: "done", summary: "s" }));
    const sc = JSON.parse(fs.readFileSync(path.join(T, "packs", "m2", "manifest.json"), "utf8"));
    ck.ok("CR-V21a server 桩 source/layer/path", sc.source === "server" && sc.entries.length === 2 && sc.entries.every((e) => e.source === "server" && e.layer === "T2") && sc.entries.map((e) => e.ref.path).join(",") === "out/report.md,out/data.json", sc.entries);
    const mm = resultText(await get("m2"));
    ck.ok("CR-V21a 指针已设", mm.manifest && mm.manifest.entry_count === 2);
    const rb = resultText(await report({ mission_id: "m3b", worker: "w#1", kind: "done", summary: "s" }));
    ck.ok("CR-V21b 零申报零产物：无 sidecar 无指针+note", !fs.existsSync(path.join(T, "packs", "m3b", "manifest.json")) && typeof rb.manifest_note === "string" && rb.manifest_note.includes("manifest 未写入"), rb.manifest_note);
    const M3b = resultText(await get("m3b"));
    ck.ok("CR-V21b 指针缺席", !(M3b.manifest));
  }
  // ---- QA 修复验收（v0.5 未发布）：report(done, artifacts=[…]) 零 manifest_entries
  //   → artifacts 写回任务板 → T2-only server 桩 sidecar + 下游 inputs 牵引非 L3。
  {
    await upsert({ id: "m14", title: "report artifacts 写回" });
    const r = resultText(await report({ mission_id: "m14", worker: "w#1", kind: "done", summary: "s", artifacts: ["out/from-report.md", "out/extra.md"] }));
    ck.ok("QA-A1 report(done,artifacts) 非 isError", r.ok === true, r);
    const sc = JSON.parse(fs.readFileSync(path.join(T, "packs", "m14", "manifest.json"), "utf8"));
    ck.ok("QA-A2 零申报→T2-only server 桩", sc.source === "server" && sc.entries.length === 2 && sc.entries.every((e) => e.layer === "T2" && e.source === "server") && sc.entries.map((e) => e.ref.path).join(",") === "out/from-report.md,out/extra.md", sc.entries);
    const M14 = resultText(await get("m14"));
    ck.ok("QA-A3 artifacts 写回任务板+指针已设", Array.isArray(M14.artifacts) && M14.artifacts.join(",") === "out/from-report.md,out/extra.md" && M14.manifest?.entry_count === 2, { a: M14.artifacts, m: M14.manifest });
    // 追加申报去重：同路径不重复；新路径追加。
    await upsert({ id: "m14", status: "running" });
    await report({ mission_id: "m14", worker: "w#1", kind: "done", summary: "s2", artifacts: ["out/extra.md", "out/late.md"] });
    const M14b = resultText(await get("m14"));
    ck.ok("QA-A5 追加去重合并", M14b.artifacts.join(",") === "out/from-report.md,out/extra.md,out/late.md", M14b.artifacts);
    // 下游非 L3 两证：①sidecar 在 → L1 路由（寻址条目行，非零产出报错）；
    // ②sidecar 删去 → L2 server 桩直接吃任务板上的 report 写回 artifacts。
    await s.call("context_pack", { mission_id: "mR14", title: "下游牵引L1", task: "t", inputs: ["m14"] });
    const p14 = fs.readFileSync(path.join(T, "packs", "mR14", "pack.md"), "utf8");
    ck.ok("QA-A4a 下游牵引非 L3（L1 寻址行在包）", p14.includes("——来自 m14#c01"), p14.split("\n").find((l) => l.includes("——来自 m14")));
    fs.rmSync(path.join(T, "packs", "m14", "manifest.json"));
    await s.call("context_pack", { mission_id: "mR14b", title: "下游牵引L2", task: "t", inputs: ["m14"] });
    const p14b = fs.readFileSync(path.join(T, "packs", "mR14b", "pack.md"), "utf8");
    ck.ok("QA-A4b 无 sidecar 仍非 L3（server 桩吃写回 artifacts）", p14b.includes("out/from-report.md——来自 m14（server 桩）") && p14b.includes("out/late.md——来自 m14（server 桩）"), p14b.split("\n").find((l) => l.includes("server 桩")));
  }
  // ---- CR-V29
  {
    const r1 = resultText(await report({ mission_id: "m9", worker: "w#1", kind: "done", summary: "s", manifest_entries: [{ layer: "T0", type: "assertion", title: "断言", text: ASSERT_MAIN, ref: { path: "tests/assertions/sample.md", loc: "A-V050-T01" } }] }));
    ck.ok("CR-V29a 一致→静默", r1.ok === true && r1.manifest_warnings === undefined, r1.manifest_warnings);
    const tampered = ASSERT_MAIN.slice(0, -3) + "改字。";
    const r2 = resultText(await report({ mission_id: "m10", worker: "w#1", kind: "done", summary: "s", manifest_entries: [{ layer: "T0", type: "assertion", title: "断言", text: tampered, ref: { path: "tests/assertions/sample.md", loc: "A-V050-T01" } }] }));
    ck.ok("CR-V29b 篡改→恰 1 条 warning 非阻断", r2.ok === true && Array.isArray(r2.manifest_warnings) && r2.manifest_warnings.length === 1, r2.manifest_warnings);
    const r3 = resultText(await report({ mission_id: "m11", worker: "w#1", kind: "done", summary: "s", manifest_entries: [{ layer: "T0", type: "assertion", title: "断言", text: ASSERT_MAIN, ref: { path: "tests/assertions/missing.md" } }] }));
    ck.ok("CR-V29c 不可读→未比对警示", Array.isArray(r3.manifest_warnings) && r3.manifest_warnings.length === 1 && r3.manifest_warnings[0].includes("未比对"), r3.manifest_warnings);
    const r4 = resultText(await report({ mission_id: "m12", worker: "w#1", kind: "done", summary: "s", manifest_entries: [
      { layer: "T0", type: "conclusion", title: "c", text: "绝不一致的字串", ref: { path: "tests/assertions/sample.md" } },
      { layer: "T0", type: "directive", title: "d", text: " directives 不比对", ref: { path: "tests/assertions/sample.md" } },
    ] }));
    ck.ok("CR-V29d conclusion/directive 永不比对", r4.manifest_warnings === undefined, r4.manifest_warnings);
  }
  // ---- milestone 不写 manifest + 缺省零新键
  {
    await upsert({ id: "m13", title: "milestone 不写" });
    await report({ mission_id: "m13", worker: "w#1", kind: "milestone", summary: "s", manifest_entries: [{ layer: "T1", type: "conclusion", title: "t", text: "x", ref: { path: "p" } }] });
    ck.ok("EXTRA milestone 无 sidecar 无指针", !fs.existsSync(path.join(T, "packs", "m13", "manifest.json")) && !resultText(await get("m13")).manifest);
    const r = resultText(await report({ mission_id: "m13", worker: "w#1", kind: "milestone", summary: "s2" }));
    ck.ok("EXTRA 缺省 report 无新键", r.warn_scope === undefined && r.manifest_note === undefined && r.manifest_warnings === undefined && r.files_touched === undefined);
  }
} finally {
  s.close();
  BASE.cleanup();
}
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
