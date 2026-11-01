// @module crv2-pack/routing
// suites/crv2-pack 拆分件：CR-V23 三层路由全链 + 沙箱改写 + CR-V24 超帽保序降级/去重/撞行
// + CR-V25 回退链（L1/L2/L3/混合/损坏侧车）+ board.json 不变量（无 manifest 键/version=2）。
// 原 L276-362 搬入。
import fs from "node:fs";
import path from "node:path";
import { ck, PROJ, TROOT, readPack } from "./setup.mjs";
import { seedSidecar, seedDoneBoard } from "./fixtures.mjs";

export async function runRouting(cur) {
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
}
