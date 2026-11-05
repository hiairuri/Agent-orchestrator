// @module dispatch-supply
/*!
 * suites/dispatch-supply.mjs —— 派发供给面静态残存腿（v1.6 W-p 剥离波大裁后形态）
 *
 * v1.6 W-p 退役账（波首逐腿对拍，台账 v1.6.0.md §W-p）：原 PE×6（parseEnvelope 双通道
 *   源码抽取驱动）＋DS-01..08＋DS-09×3（播种两源快速失败/拒绝回执/不 spawn 三锚）全部
 *   退役——subject=hooks/dispatch-runner.mjs（已 git rm 迁 parked）与 dispatch-core
 *   模型供给播种面（dispatchSeedModelConfig，随 headless 分支拆除），嵌套形态无消费面。
 *   预留回植面=parked/agent-orchestrator/README.md 恢复指引。
 *
 * 残存两腿（静态、零外呼、与 -p 无涉）：
 *   ST-01 .mcp.json JSON parse + orch 节点 protocolVersion:"legacy"（P1 验收③防回退
 *     静态锁——MCP 配置文件面，nested/宿主通道同面消费，非 headless 专属）；
 *   ST-02 server 族「first enabled」字样归零（P3 段③删除的源码静态锁——负面防回潮，
 *     播种面退役后判据恒真性由负向钉语义承载，保留防回潮价值）。
 *
 * 运行方式：node tests/suites/dispatch-supply.mjs（零子进程零 temp root）
 * 断言主句权威 = tests/assertions/v1.2.3.md §1（ST-01/ST-02 沿革）+v1.6.0.md §W-p（退役账）。
 */
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_DIR, Checker } from "../harness/jsonrpc-client.mjs";
import { familySource } from "../harness/source-family.mjs";

const ck = new Checker("dispatch-supply");

// ---- ST-02-first-enabled-erased（验收⑩）：server 族「first enabled」字样归零静态锁
// v1.3 切分重基（m-20261101-034720-a7a6）：零残留 ban 读面=server 族（薄入口单读=假绿弱化）
// v1.6 W-p 注记：播种面（dispatch-model.mjs+dispatchSeedModelConfig）已迁 parked，本腿转为
// 纯负向防回潮钉（字样回归=回潮信号即红，与判据恒真性并存）。
{
  const serverSrc = familySource(PLUGIN_DIR, "mcp/server.mjs");
  ck.ok(
    "ST-02 server.mjs「first enabled」字样归零（段③首 api-key 猜测删除的源码静态锁，P3 验收⑩）",
    !serverSrc.includes("first enabled"),
    serverSrc.includes("first enabled") ? "literal present" : "absent",
  );
}

// ---- ST-01-mcpjson-protocolversion-legacy（P1 验收③，impl-plan §9 用例 #15）：.mcp.json
//      orch 节点 protocolVersion:"legacy" 静态断言（防回退）。R2-01 注记（impl-plan §4
//      验收）：本断言只锁文件面，生效面归主控 0.16.2 活验段①②——宿主重载/新会话重读
//      .mcp.json 为前提，不重载则旧进程上照样为真=假阳性。resolveVersionNegotiationMode
//      遇 "legacy" 直走 legacy 分支、整条 server/discover 探测窗与 ERA 面摘除（survey
//      §2.5 第 3 条/§2.2-c/§4）。版本三件套三方一致不在本用例重复钉点（LM-03 既有断言面）。
{
  let mcpCfg = null;
  try {
    mcpCfg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, ".mcp.json"), "utf8"));
    ck.ok("ST-01 .mcp.json JSON parse 通过（P1 静态面）", true, "parsed");
  } catch (e) {
    ck.ok("ST-01 .mcp.json JSON parse 通过（P1 静态面）", false, String(e).slice(0, 200));
  }
  const orch = mcpCfg && mcpCfg.mcpServers && mcpCfg.mcpServers.orch;
  ck.ok(
    "ST-01 .mcp.json orch 节点含 protocolVersion:\"legacy\"（防回退静态锁，P1 验收③）",
    !!orch && orch.protocolVersion === "legacy",
    orch ? `protocolVersion=${JSON.stringify(orch.protocolVersion)}` : "orch node absent",
  );
}

ck.summary();
process.exit(ck.fails.length ? 1 : 0);
