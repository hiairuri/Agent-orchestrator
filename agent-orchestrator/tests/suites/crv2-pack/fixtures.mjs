// @module crv2-pack/fixtures
// suites/crv2-pack 拆分件：确定性夹具构建器（proj 仓 / 缺省包场景 A / board done 种子 /
// 三条目 sidecar 种子）。原 L76-124 搬入，函数体零改动，仅加 export 接线。
import fs from "node:fs";
import path from "node:path";
import { blankMission } from "../../harness/temp-root.mjs";
import { makeRepo } from "../../harness/git-fixture.mjs";
import { PROJ, TROOT, rmRetry, readPack } from "./setup.mjs";

/** 确定性夹具：proj 仓（src/app.py + docs/a.md，固定日期 → SHA 确定）+ 空根 */
export function freshFixture() {
  for (const d of [PROJ, TROOT]) rmRetry(d);
  fs.mkdirSync(PROJ, { recursive: true });
  fs.mkdirSync(TROOT, { recursive: true });
  return makeRepo({ dir: PROJ, files: { "src/app.py": "print('hi')\n", "docs/a.md": "# A doc\n" } });
}

/** 场景 A（缺省回归面）：四种缺省 context_pack，返回 {packs, board 快照字段}。
 *  v1.6.5 fork (a) 适配：本场景被三代 server 共用（0.4.1/0.8.0 基线=内嵌前缀注册名；
 *  现行=裸名注册）——按 tools/list 首名形探测各代注册前缀，调用名随代适配
 *  （harness PRE="" 后裸名直发，基线 server 拒收裸名=unknown tool）。 */
export async function scenarioA(s) {
  const packs = {};
  const tl = await s.request("tools/list", {});
  const firstName = ((tl.result || {}).tools || [])[0]?.name || "";
  const P = firstName.startsWith("mcp__") ? firstName.replace(/board$/, "") : ""; // 基线代=内嵌前缀形；现行代=裸名
  await s.call(P + "lessons", { action: "add", type: "pitfall", trigger: "改 server.mjs 前先 grep 锚点", fix: "先 grep 再定点读，禁一次全文读入" });
  const upOne = "上游结论一：入口在 handleToolsCall。\n### ENV FACTS（环境事实）\n- 全部可用";
  await s.call(P + "context_pack", { mission_id: "mB1", title: "默认包", task: "做默认回归验证", read_first: ["docs/a.md"], rules: ["规则一"], return_format: "markdown 列表", upstream_context: upOne });
  packs["packs/mB1/pack.md"] = readPack("packs/mB1/pack.md");
  await s.call(P + "context_pack", { mission_id: "mB2", title: "变体包", task: "做变体回归验证", variants: 2, variant_axes: ["风格A", "风格B"], upstream_context: "上游二" });
  packs["packs/mB2/pack-v1.md"] = readPack("packs/mB2/pack-v1.md");
  packs["packs/mB2/pack-v2.md"] = readPack("packs/mB2/pack-v2.md");
  const absDoc = path.join(PROJ, "docs", "a.md");
  await s.call(P + "context_pack", { mission_id: "mS1", title: "沙箱别名包", task: "沙箱回归 " + absDoc, read_first: [absDoc], rules: ["只写 src/"], upstream_context: "上游路径 " + absDoc, isolation: "worktree", oob_allowlist: ["src/", "tests/", "docs/"] });
  packs["packs/mS1/pack.md"] = readPack("packs/mS1/pack.md");
  await s.call(P + "context_pack", { mission_id: "mB3", title: "镜像包", task: "镜像回归", mirror_digest: true });
  packs["packs/mB3/pack.md"] = readPack("packs/mB3/pack.md");
  return packs;
}

/** v0.6 A4 夹具适配（主控批复授权，见 v0.6.x.md §0）：create-as-done 被 V6-20 迁移
 *  白名单合法拒绝（终态无直达）——done mission 夹具统一改直写 board.json 种子
 *  （server 每调用 fresh load），断言主句零改动。 */
export function seedDoneBoard(mid, over = {}) {
  const p = path.join(TROOT, "board.json");
  const board = JSON.parse(fs.readFileSync(p, "utf8"));
  board.missions.push(blankMission({ id: mid, title: over.title ?? mid + " 标题", status: "done", ...over }));
  fs.writeFileSync(p, JSON.stringify(board, null, 2) + "\n");
}

/** 种一个三条目 sidecar（T0 directive/T1 conclusion/T2 anchor）+ 对应 done mission */
export async function seedSidecar(root, mid, { absPaths = false, PROJ: proj } = {}) {
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
