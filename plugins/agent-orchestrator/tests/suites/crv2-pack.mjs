/*!
 * suites/crv2-pack.mjs —— CRV2-01…08（物化与合流）+ CR-V22（缺省逐字节回归对拍 0.4.1）
 *   + CR-V23（路由全链+沙箱改写）+ CR-V24（截断保序/去重/撞行）+ CR-V25（回退链）+ E1 门
 *
 * 覆盖断言组：A-v050-CRV2-01…08、CR-V18 组的 manifest 维度缺省回归（V22）、输入牵引全链。
 *   转录自 v05-impl-03/rig.mjs + regress-a.mjs + final-assert.mjs（同参对拍改为同进程内
 *   两阶段：0.4.1 基线 server（git d00f94c 导出）与现行 server 先后跑同一固定路径夹具）。
 *
 * 运行方式：node tests/suites/crv2-pack.mjs [--root <临时根>]
 * 前置：node >= 20；PATH 上有 git（d00f94c 基线导出 + worktree 物化）；无网。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, Checker } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot, parseRootArg, blankMission } from "../harness/temp-root.mjs";
import { makeRepo, repoRoot, exportFileFromGit } from "../harness/git-fixture.mjs";

const ck = new Checker("crv2-pack");
const BASE = makeTempRoot({ prefix: "orch-crv2-", root: parseRootArg() || undefined });
const PROJ = path.join(BASE.root, "proj");
const TROOT = path.join(BASE.root, "troot");
const SCRATCH = path.join(BASE.root, "scratch");

const sectionsOf = (md) => !md ? [] : md.split("\n").filter((l) => l.startsWith("## "))
  .map((l) => l.replace(/^## ([^（(]*)?.*/, "$1").trim()).map((l) => l.split("（")[0].split("(")[0].trim());
const readPack = (rel) => { const p = path.join(TROOT, rel); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; };
// normToken 归一化易变面：token（原）+ 0.6 E-17 胶水行的 artifacts 软约束注记（主控 2026-10-15
// 裁决 A 授权：server.mjs 任务包模板按卡内裁决变字，对拍除该预期增量外仍逐字节，A-v060 见 v0.6.x.md §0）
// + 0.6 A2 V6-18 的 CONTEXT 节头围栏句（主控 2026-10-15 批复授权，A-v060-INJ-03）
// + 0.6 A3 V6-09 熵升级 hex(4)→hex(16)（主控 2026-10-15 批复授权：{4,16}→{4,32}，归一化语义不变）
const normToken = (s) => String(s)
  .replace(/\[token\] [0-9a-f]{4,32}/g, "[token] X")
  .replace(/"token":"[0-9a-f]{4,32}"/g, '"token":"X"')
  .replace(/done 必带 artifacts 路径（软约束：[^）]*）。/g, "done 必带 artifacts 路径。")
  .replace(/## CONTEXT（[^）]*）/g, "## CONTEXT 节头");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const rmRetry = (d) => { for (let i = 0; i < 6; i++) { try { fs.rmSync(d, { recursive: true, force: true }); return; } catch (e) { if (i === 5) throw e; sleep(250); } } };

/** 确定性夹具：proj 仓（src/app.py + docs/a.md，固定日期 → SHA 确定）+ 空根 */
function freshFixture() {
  for (const d of [PROJ, TROOT]) rmRetry(d);
  fs.mkdirSync(PROJ, { recursive: true });
  fs.mkdirSync(TROOT, { recursive: true });
  return makeRepo({ dir: PROJ, files: { "src/app.py": "print('hi')\n", "docs/a.md": "# A doc\n" } });
}

/** 场景 A（缺省回归面）：四种缺省 context_pack，返回 {packs, board 快照字段} */
async function scenarioA(s) {
  const packs = {};
  await s.call("lessons", { action: "add", type: "pitfall", trigger: "改 server.mjs 前先 grep 锚点", fix: "先 grep 再定点读，禁一次全文读入" });
  const upOne = "上游结论一：入口在 handleToolsCall。\n### ENV FACTS（环境事实）\n- 全部可用";
  await s.call("context_pack", { mission_id: "mB1", title: "默认包", task: "做默认回归验证", read_first: ["docs/a.md"], rules: ["规则一"], return_format: "markdown 列表", upstream_context: upOne });
  packs["packs/mB1/pack.md"] = readPack("packs/mB1/pack.md");
  await s.call("context_pack", { mission_id: "mB2", title: "变体包", task: "做变体回归验证", variants: 2, variant_axes: ["风格A", "风格B"], upstream_context: "上游二" });
  packs["packs/mB2/pack-v1.md"] = readPack("packs/mB2/pack-v1.md");
  packs["packs/mB2/pack-v2.md"] = readPack("packs/mB2/pack-v2.md");
  const absDoc = path.join(PROJ, "docs", "a.md");
  await s.call("context_pack", { mission_id: "mS1", title: "沙箱别名包", task: "沙箱回归 " + absDoc, read_first: [absDoc], rules: ["只写 src/"], upstream_context: "上游路径 " + absDoc, isolation: "worktree", oob_allowlist: ["src/", "tests/", "docs/"] });
  packs["packs/mS1/pack.md"] = readPack("packs/mS1/pack.md");
  await s.call("context_pack", { mission_id: "mB3", title: "镜像包", task: "镜像回归", mirror_digest: true });
  packs["packs/mB3/pack.md"] = readPack("packs/mB3/pack.md");
  return packs;
}

/** v0.6 A4 夹具适配（主控批复授权，见 v0.6.x.md §0）：create-as-done 被 V6-20 迁移
 *  白名单合法拒绝（终态无直达）——done mission 夹具统一改直写 board.json 种子
 *  （server 每调用 fresh load），断言主句零改动。 */
function seedDoneBoard(mid, over = {}) {
  const p = path.join(TROOT, "board.json");
  const board = JSON.parse(fs.readFileSync(p, "utf8"));
  board.missions.push(blankMission({ id: mid, title: over.title ?? mid + " 标题", status: "done", ...over }));
  fs.writeFileSync(p, JSON.stringify(board, null, 2) + "\n");
}

/** 种一个三条目 sidecar（T0 directive/T1 conclusion/T2 anchor）+ 对应 done mission */
async function seedSidecar(root, mid, { absPaths = false, PROJ: proj } = {}) {
  fs.mkdirSync(path.join(root, "packs", mid), { recursive: true });
  const absA = path.join(proj, "docs", "a.md");
  const entries = [
    { id: "c01", layer: "T0", type: "directive", title: "任务目标与约束", text: absPaths ? "逐字原文：参见 " + absA + " 的目标节。" : "逐字原文：完成数据面实现，遵守 scope 清单。", ref: absPaths ? { path: absA, loc: "§目标" } : { path: "docs/a.md", loc: "§目标" }, source: "worker" },
    { id: "c02", layer: "T1", type: "conclusion", title: "阶段结论", text: "参数入口与沙箱合流已完成。", ref: { path: "docs/a.md", loc: "L1-L2" }, source: "worker" },
    { id: "c03", layer: "T2", type: "anchor", title: "锚点", ref: absPaths ? { path: path.join(proj, "src", "app.py"), loc: "L1" } : { path: "src/app.py", loc: "L1" }, source: "worker" },
  ];
  fs.writeFileSync(path.join(root, "packs", mid, "manifest.json"),
    JSON.stringify({ v: 1, mission_id: mid, generated_at: "2026-10-13T00:00:00.000Z", source: "worker", entries }, null, 2) + "\n");
  seedDoneBoard(mid);
}

let cur = null;
try {
  // ---- 阶段 1：0.4.1 基线 server（d00f94c 导出）跑场景 A，采集缺省包字节
  let old041 = null;
  try {
    old041 = exportFileFromGit("d00f94c", repoRoot(), "plugins/agent-orchestrator/mcp/server.mjs", SCRATCH);
  } catch (e) {
    ck.ok("0.4.1 baseline export (git d00f94c)", false, String(e));
  }
  let packsOld = null;
  if (old041) {
    const repo = freshFixture();
    const sold = startServer({ serverPath: old041, root: TROOT, cwd: PROJ });
    packsOld = await scenarioA(sold);
    sold.close();
    sleep(400); // Windows 句柄释放窗口，防 freshFixture rmSync EPERM
    repo.cleanup();
    ck.ok("0.4.1 baseline scenario captured", !!packsOld["packs/mB1/pack.md"]);
  }

  // ---- 阶段 2：现行 server 同一固定路径夹具重跑（确定性 SHA → 同沙箱 base_commit）
  const repo = freshFixture();
  cur = startServer({ root: TROOT, cwd: PROJ });
  const tl = await cur.tools();
  ck.ok("tools/list = 11（v0.6 A6 probe 转正口径）", tl.tools?.length === 11, tl.tools?.length);
  const packsNew = await scenarioA(cur);

  // ---- CRV2-05 / CR-V22：缺省包与 0.4.1 逐字节（token 归一化）
  if (packsOld) {
    let diffs = [];
    for (const k of Object.keys(packsOld)) {
      if (normToken(packsOld[k]) !== normToken(packsNew[k])) diffs.push(k);
    }
    ck.ok("CRV2-05/CR-V22 缺省包与 0.4.1 逐字节相等（4 例，token 归一化）", diffs.length === 0, diffs);
    const d = packsNew["packs/mB1/pack.md"];
    ck.ok("CR-V22 缺省包不含 SUMMARY/OWNERSHIP/BUDGET 字样", !d.includes("SUMMARY") && !d.includes("OWNERSHIP") && !d.includes("BUDGET"));
    ck.ok("CRV2-05 节序列恰 CONTRACT/CONTEXT/READ FIRST/TASK/RULES/RETURN",
      JSON.stringify(sectionsOf(d)) === JSON.stringify(["CONTRACT", "CONTEXT", "READ FIRST", "TASK", "RULES", "RETURN"]), sectionsOf(d));
  }

  // ---- CRV2-01/02：OWNERSHIP 物化 + 登记闭环
  await cur.call("context_pack", { mission_id: "mO1", title: "所有权包", task: "验证 OWNERSHIP 物化", scope_paths: ["src/", "mcp/server.mjs"] });
  const pO1 = readPack("packs/mO1/pack.md");
  ck.ok("CRV2-01 pack 含 ## OWNERSHIP 节+两路径逐字+只读句", pO1.includes("## OWNERSHIP（文件所有权）") && pO1.includes("src/") && pO1.includes("mcp/server.mjs") && pO1.includes("清单外路径一律只读"));
  const bO1 = (await cur.call("board", { action: "get", mission_id: "mO1" })).json;
  ck.ok("CRV2-02 board mission.scope_paths 与入参一致", JSON.stringify(bO1.scope_paths) === JSON.stringify(["src/", "mcp/server.mjs"]), bO1.scope_paths);

  // ---- CRV2-03：沙箱合流（存储键名不变）
  await cur.call("context_pack", { mission_id: "mO2", title: "合流包", task: "验证 scope_paths 沙箱合流", isolation: "worktree", scope_paths: ["src/", "tests/"] });
  const bO2 = (await cur.call("board", { action: "get", mission_id: "mO2" })).json;
  const pO2 = readPack("packs/mO2/pack.md");
  ck.ok("CRV2-03 pack 含 ## SANDBOX + oob_allowlist 合流", pO2.includes("## SANDBOX") && JSON.stringify(bO2.pack?.sandbox?.oob_allowlist) === JSON.stringify(["src/", "tests/"]), bO2.pack?.sandbox);
  ck.ok("CRV2-03 mission.scope_paths 同步登记", JSON.stringify(bO2.scope_paths) === JSON.stringify(["src/", "tests/"]), bO2.scope_paths);

  // ---- CRV2-06：两参同传 scope 胜 + 警告；空串负例视为未登记
  const r06 = await cur.call("context_pack", { mission_id: "mO3", title: "两参同传包", task: "验证取代与警告", isolation: "worktree", oob_allowlist: ["everything/"], scope_paths: ["src/"] });
  const bO3 = (await cur.call("board", { action: "get", mission_id: "mO3" })).json;
  ck.ok("CRV2-06 scope_paths 生效（非并集）+ warn 含忽略句", JSON.stringify(bO3.pack?.sandbox?.oob_allowlist) === JSON.stringify(["src/"]) && typeof r06.json?.warn === "string" && r06.json.warn.includes("oob_allowlist 被忽略"), { oob: bO3.pack?.sandbox?.oob_allowlist, warn: r06.json?.warn });
  await cur.call("context_pack", { mission_id: "mO4", title: "空串负例包", task: "验证空串视为未登记", scope_paths: [""] });
  const pO4 = readPack("packs/mO4/pack.md");
  const bO4raw = JSON.parse(fs.readFileSync(path.join(TROOT, "board.json"), "utf8")).missions.find((m) => m.id === "mO4");
  ck.ok("CRV2-06/M-01 空串负例：OWNERSHIP 不出现、board 不落存储键", !pO4.includes("OWNERSHIP") && !("scope_paths" in bO4raw), { hasSection: pO4.includes("OWNERSHIP"), storedKeys: Object.keys(bO4raw).filter((k) => k.includes("scope")) });

  // ---- CRV2-07/08：BUDGET 节
  await cur.call("context_pack", { mission_id: "mG1", title: "预算包", task: "验证 BUDGET 节", budget: "M", scope_paths: ["src/"] });
  const pG1 = readPack("packs/mG1/pack.md");
  ck.ok("CRV2-07 BUDGET 节+档位数字 60", pG1.includes("## BUDGET（预算档位）") && pG1.includes("档位：M（≈60 步上限）"), pG1.split("\n").filter((l) => l.includes("档位"))[0]);
  ck.ok("CRV2-07 静态预告行逐字在", pG1.includes("上下文档位：WARN 120K 提醒 / ACT 150K 决策 / HARD 180K 强制收尾 / ABS 230K 红线（由主控对账判定，worker 无需自测）"));
  await cur.call("context_pack", { mission_id: "mG1b", title: "预算S", task: "t", budget: "S", scope_paths: ["src/"] });
  await cur.call("context_pack", { mission_id: "mG1c", title: "预算L", task: "t", budget: "L", scope_paths: ["src/"] });
  ck.ok("CRV2-07 S=20/L=120 同式", readPack("packs/mG1b/pack.md").includes("档位：S（≈20 步上限）") && readPack("packs/mG1c/pack.md").includes("档位：L（≈120 步上限）"));
  ck.ok("CRV2-07 L 档包内预拆说明（CR-V6②；M 档不带）", readPack("packs/mG1c/pack.md").includes("预拆阶段或转 workflow") && !readPack("packs/mG1/pack.md").includes("预拆阶段"));
  await cur.call("context_pack", { mission_id: "mG2", title: "无预算", task: "t", scope_paths: ["src/"] });
  ck.ok("CRV2-08 不传 budget → BUDGET 节不出现", !readPack("packs/mG2/pack.md").includes("BUDGET"));

  // ---- E1 门：非法档位/超限清单/inputs 门
  const badBudget = await cur.call("context_pack", { mission_id: "mG2b", title: "非法档位", task: "t", budget: "X" });
  ck.ok("E1 budget:X → isError", badBudget.isError === true, badBudget.text.slice(0, 100));
  const over = await cur.call("context_pack", { mission_id: "mG3", title: "超限清单", task: "t", scope_paths: Array.from({ length: 33 }, (_, i) => "p" + i + "/") });
  ck.ok("E1 scope_paths 33 项 → isError（报错拒绝不截断）", over.isError === true, over.text.slice(0, 100));

  // ---- CR-V23：三层路由全链
  await seedSidecar(TROOT, "m1", { PROJ });
  await cur.call("context_pack", { mission_id: "mR1", title: "牵引包", task: "验证三层路由", inputs: ["m1"] });
  const pR1 = readPack("packs/mR1/pack.md");
  ck.ok("CR-V23 T0→CONTEXT 块头逐字", pR1.includes("> 来源 m1#c01 · 任务目标与约束 · docs/a.md（§目标）"), pR1.split("\n").find((l) => l.includes("> 来源")));
  ck.ok("CR-V23 T1→SUMMARY 行逐字", pR1.includes("- m1#c02 阶段结论：参数入口与沙箱合流已完成。"));
  ck.ok("CR-V23 T2→READ FIRST 行逐字", pR1.includes("- src/app.py（L1）——来自 m1#c03"));
  {
    const iC = pR1.indexOf("## CONTEXT"), iS = pR1.indexOf("## SUMMARY"), iR = pR1.indexOf("## READ FIRST");
    ck.ok("CR-V23 节序 CONTEXT→SUMMARY→READ FIRST", iC >= 0 && iC < iS && iS < iR, [iC, iS, iR]);
  }
  const nope = await cur.call("context_pack", { mission_id: "mR2", title: "不存在 id", task: "t", inputs: ["nope-mission"] });
  ck.ok("CR-V23 inputs 不存在 id → isError", nope.isError === true && nope.text.includes("not found"), nope.text.slice(0, 100));
  const five = await cur.call("context_pack", { mission_id: "mR3", title: "五个 id", task: "t", inputs: ["m1", "m1", "m1", "m1", "m1"] });
  ck.ok("CR-V23 第 5 个 id → isError", five.isError === true, five.text.slice(0, 100));
  await cur.call("context_pack", { mission_id: "mR4", title: "变体牵引包", task: "t", inputs: ["m1"], variants: 2, variant_axes: ["甲", "乙"] });
  const v1 = readPack("packs/mR4/pack-v1.md"), v2 = readPack("packs/mR4/pack-v2.md");
  ck.ok("CR-V23 双包各自独立牵引同份内容", v1.includes("m1#c01") && v2.includes("m1#c01"));

  // ---- CR-V23 沙箱改写：牵引文本不指回主根
  await seedSidecar(TROOT, "m1s", { absPaths: true, PROJ });
  await cur.call("context_pack", { mission_id: "mR5", title: "沙箱牵引包", task: "验证牵引文本沙箱改写 " + path.join(PROJ, "docs", "a.md"), inputs: ["m1s"], isolation: "worktree", scope_paths: ["src/"] });
  {
    const p = readPack("packs/mR5/pack.md");
    const ctx = p.slice(p.indexOf("## CONTEXT"), p.indexOf("## TASK"));
    const pulled = ctx.split("\n").filter((l) => l.includes("——来自") || l.includes("> 来源") || l.includes("逐字原文"));
    const bad = pulled.filter((l) => l.includes(path.join(PROJ, "proj") + "\\") || l.includes(PROJ + "\\") || l.includes(PROJ));
    ck.ok("CR-V23 沙箱改写精确（牵引行全部 sandbox 根，n=" + pulled.length + "）", bad.length === 0 && pulled.length >= 3, bad.slice(0, 2));
  }

  // ---- CR-V24：超帽保序降级 + 去重 + 撞行
  {
    const bigText = (bytes) => { const unit = "0123456789".repeat(100); let s = ""; while (Buffer.byteLength(s, "utf8") < bytes) s += unit; return s.slice(0, bytes); };
    for (const mid of ["mA", "mB", "mC"]) {
      fs.mkdirSync(path.join(TROOT, "packs", mid), { recursive: true });
      const entries = [];
      for (const [eid, layer, title, text, ref] of [
        ["c01", "T0", mid + " 目标", bigText(9000), { path: "docs/" + mid + ".md", loc: "§目标" }],
        ["c02", "T0", mid + " 细节", bigText(9000), { path: "docs/" + mid + ".md", loc: "§细节" }],
        ["c03", "T0", mid + " 补充", bigText(9000), { path: "docs/" + mid + ".md", loc: "§补充" }],
        ["c04", "T2", mid + " 锚点", "", { path: "docs/" + mid + ".md", loc: "L9" }],
      ]) entries.push({ id: eid, layer, type: layer === "T0" ? "directive" : "anchor", title, text, ref, source: "worker" });
      fs.writeFileSync(path.join(TROOT, "packs", mid, "manifest.json"),
        JSON.stringify({ v: 1, mission_id: mid, generated_at: "2026-10-13T00:00:00.000Z", source: "worker", entries }, null, 2) + "\n");
      seedDoneBoard(mid);
    }
    const collideLine = "docs/mC.md（§目标）——来自 mC#c01";
    await cur.call("context_pack", { mission_id: "mR6", title: "超帽去重包", task: "t", inputs: ["mA", "mB", "mC", "mB"], read_first: [collideLine] });
    const pR6 = readPack("packs/mR6/pack.md");
    ck.ok("CR-V24 撞帽降级：mC T0 整块降指针+说明行（永不静默丢）", pR6.includes("其 T0 因总量帽未随包，见指针") && pR6.includes("docs/mC.md"));
    ck.ok("CR-V24 去重：重复条目跳过+计数行", pR6.includes("（去重：4 条重复条目已跳过，首次出现胜出）"), pR6.split("\n").find((l) => l.includes("去重")));
    ck.ok("CR-V24 撞行：手动行胜出（该串恰 1 处）", pR6.split(collideLine).length - 1 === 1);
    ck.ok("CR-V24 mA/mB 完整保留", pR6.includes("mA 目标") && pR6.includes("mB 补充"));
  }

  // ---- CR-V25：回退链（L1 server 桩 sidecar / L2 存量无 sidecar / L3 零产物 / 混合 / 损坏侧车）
  seedDoneBoard("m4", { artifacts: ["reports/legacy.md"] });
  await cur.call("report", { mission_id: "m4", worker: "rig", kind: "done", summary: "存量 mission 的最后一次 done 摘要" });
  // m4n：0.4.x 存量形态（有 artifacts、从未 done report → 无 sidecar 无 manifest）→ L2
  seedDoneBoard("m4n", { artifacts: ["reports/legacy.md"] });
  seedDoneBoard("m5");
  await cur.call("report", { mission_id: "m5", worker: "rig", kind: "done", summary: "零产物收尾" });
  fs.mkdirSync(path.join(TROOT, "packs", "m6"), { recursive: true });
  fs.writeFileSync(path.join(TROOT, "packs", "m6", "manifest.json"), "{这不是JSON!!");
  seedDoneBoard("m6", { artifacts: ["reports/m6.md"] });

  await cur.call("context_pack", { mission_id: "mR7", title: "L1 存量牵引", task: "t", inputs: ["m4"] });
  const pR7 = readPack("packs/mR7/pack.md");
  ck.ok("CR-V25 L1：done report 后 server 桩 sidecar 生效（CR-V21a 语义）", pR7.includes("reports/legacy.md——来自 m4#c01"));
  await cur.call("context_pack", { mission_id: "mR7n", title: "L2 存量牵引", task: "t", inputs: ["m4n"] });
  const pR7n = readPack("packs/mR7n/pack.md");
  ck.ok("CR-V25 L2：READ FIRST 桩行带 server 桩标记", pR7n.includes("reports/legacy.md——来自 m4n（server 桩）"));
  const zero = await cur.call("context_pack", { mission_id: "mR8", title: "L3 零产物", task: "t", inputs: ["m5"] });
  ck.ok("CR-V25 L3：全部零产出 → isError+引导语", zero.isError === true && zero.text.includes("inputs 全部零产出"), zero.text.slice(0, 150));
  await cur.call("context_pack", { mission_id: "mR9", title: "混合回退", task: "t", inputs: ["m4n", "m5"] });
  const pR9 = readPack("packs/mR9/pack.md");
  ck.ok("CR-V25 混合：m4n 正常+m5 跳过警示行，不整体失败", pR9.includes("reports/legacy.md——来自 m4n（server 桩）") && pR9.includes("已跳过") && pR9.includes("m5 无 manifest 且零产物"));
  await cur.call("context_pack", { mission_id: "mR10", title: "损坏侧车牵引", task: "t", inputs: ["m6"] });
  const pR10 = readPack("packs/mR10/pack.md");
  ck.ok("CR-V25 损坏侧车视同 L2+警示行", pR10.includes("manifest sidecar 损坏不可解析") && pR10.includes("server 桩"));

  // ---- 不变量：缺省面包 mission（从未 done report）无 manifest 键；version=2
  //（m4 有 artifacts+done report → server 桩合法落指针，属 CR-V21a 语义，不在禁列）
  const bj = JSON.parse(fs.readFileSync(path.join(TROOT, "board.json"), "utf8"));
  const defaultMissions = bj.missions.filter((m) => !["m4", "m5"].includes(m.id));
  ck.ok("缺省面 board.json 无任何 manifest 键", defaultMissions.filter((m) => "manifest" in m).length === 0, defaultMissions.filter((m) => "manifest" in m).map((m) => m.id));
  ck.ok("BOARD_VERSION = 2", bj.version === 2);
} catch (e) {
  ck.ok("driver error", false, (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e)));
} finally {
  try { cur && cur.close(); } catch {}
  BASE.cleanup();
}
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
