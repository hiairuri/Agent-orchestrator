/*!
 * suites/bggate.mjs —— M-08/M-09/M-10（bg-gate C4/C7/strict=ask 收尾）+ A-v020-B01…B07
 *   + A-v031-S09 扩展（两代哨兵在岗都认/前台叠加句/冷却静默等九分支）
 *
 * 覆盖断言组：A-v050-M08…M10、A-v020-B01…B07（L1 直接层，hook 同步捕获）、S09 扩展分支；
 *   plugin.json userConfig dispatch_contract 形状（version 字段存在性断言，容忍阶段 8 版本号推进）。
 *   转录自 v05-impl-08/acceptance.mjs。
 *
 * 运行方式：node tests/suites/bggate.mjs
 * 前置：node >= 20；无 git/网络依赖（bg-gate 黑盒 spawnSync，stdin JSON 驱动）。
 */
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_DIR, Checker } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot } from "../harness/temp-root.mjs";
import { runCapture, dispatchInput } from "../harness/capture.mjs";

const ck = new Checker("bggate");
const GATE = path.join(PLUGIN_DIR, "hooks", "bg-gate.mjs");
const PLUGIN_JSON = path.join(PLUGIN_DIR, ".zcode-plugin", "plugin.json");
const BASE = makeTempRoot({ prefix: "orch-bggate-" });
const PROJ = path.join(BASE.root, "proj");
const ROOT = path.join(PROJ, ".zcode", "orchestrator");
const MID = "m-20261013-120000-ab12"; // 高置信形状 mission id
const TOK_OK = "beef01"; // 在册 token（属 MID）
const TOK_BAD = "dead99"; // 未登记 token
const LONG = "x".repeat(700);

function resetFixture() {
  fs.rmSync(PROJ, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, "board.json"), JSON.stringify({
    version: 2,
    missions: [{ id: MID, title: "fixture", status: "running", dispatch: { token: TOK_OK } }],
  }));
}
const cool = () => fs.writeFileSync(path.join(ROOT, "sentinel-hint-stamp"), new Date().toISOString());
const sentinelOnDuty = () => {
  fs.mkdirSync(path.join(ROOT, "sentinel"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "sentinel", "instance-1.json"), JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }));
};
const legacyLock = () => fs.writeFileSync(path.join(ROOT, "sentinel.lock"), JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }));

const run = (args, stdinObj, extraEnv = {}) => runCapture({
  script: process.execPath, args: [GATE, ...args],
  input: typeof stdinObj === "string" ? stdinObj : JSON.stringify(stdinObj),
  cwd: PROJ, env: { ZCODE_PROJECT_DIR: PROJ, ...extraEnv },
});
const ctx = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || "";
const reason = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecisionReason) || "";
const decision = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision) || "";
const silent = (r) => r.code === 0 && !r.raw.trim() && r.json === null;
const disp = (prompt, extra = {}) => dispatchInput(prompt, extra);
const allOutputs = [];

try {
  // ---- M-08：token 在册但 prompt 无 [channel] 行 → C4 提醒句逐字在
  resetFixture();
  {
    const r = run(["--policy", "remind"], disp(`[token] ${TOK_OK}\n` + LONG, { run_in_background: true }));
    allOutputs.push(r.raw);
    ck.ok("M-08 提醒句逐字在", ctx(r).includes(`该 token 属 mission ${MID}——若这是新 mission 请先 context_pack 建 mission 记新 token`), ctx(r));
    ck.ok("M-08 allow", decision(r) === "allow" && r.code === 0);
  }
  // ---- M-09：background_gate=off 时契约 remind 仍生效；dispatch_contract=off 才静默
  {
    const r = run(["--policy", "off"], disp(`[channel] ${MID}\n[token] ${TOK_BAD}\n`, { run_in_background: true }));
    allOutputs.push(r.raw);
    ck.ok("M-09a gate=off 契约 remind 存活", decision(r) === "allow" && ctx(r).includes("未匹配任何在册 mission"), r.raw);
    ck.ok("M-09a 无闸门文案无哨兵句", !ctx(r).includes("疑似长任务") && !ctx(r).includes("哨兵"));
  }
  {
    const r = run(["--policy", "off", "--contract", "off"], disp(`[channel] ${MID}\n[token] ${TOK_BAD}\n`, { run_in_background: true }));
    allOutputs.push(r.raw);
    ck.ok("M-09b contract=off 完全静默", silent(r), r.raw);
  }
  {
    const r = run(["--policy", "remind", "--contract", "off"], disp(LONG + "\n[channel] " + MID + "\n[token] " + TOK_BAD + "\n"));
    allOutputs.push(r.raw);
    ck.ok("M-09c contract=off 闸门照常", decision(r) === "allow" && ctx(r).includes("疑似长任务") && !ctx(r).includes("未匹配任何在册 mission"), r.raw);
  }
  // ---- M-10：strict=ask
  {
    const r = run(["--policy", "remind", "--contract", "ask"], disp(`[channel] ${MID}\n[token] ${TOK_BAD}\n`));
    allOutputs.push(r.raw);
    ck.ok("M-10a 高置信形状失败 → ask", decision(r) === "ask" && reason(r).includes("派发契约校验未通过"), r.raw);
  }
  {
    const r = run(["--policy", "remind", "--contract", "ask"], disp(`[channel] ${MID}\n[token] ${TOK_BAD}\n`, { run_in_background: true }));
    allOutputs.push(r.raw);
    ck.ok("M-10d 后台高置信 ask", decision(r) === "ask", r.raw);
  }
  {
    const r = run(["--policy", "remind", "--contract", "ask"], disp(`[channel] <mission_id>\n[token] ${TOK_BAD}\n` + LONG));
    allOutputs.push(r.raw);
    ck.ok("M-10b 占位符不升级", decision(r) === "allow" && ctx(r).includes("未匹配任何在册 mission"), r.raw);
  }
  {
    const r = run(["--policy", "off", "--contract", "ask"], disp(`[channel] ${MID}\n[token] ${TOK_BAD}\n`));
    allOutputs.push(r.raw);
    ck.ok("M-10e gate=off 下 ask 仍可达", decision(r) === "ask", r.raw);
  }
  ck.ok("M-10c deny 永不出现", allOutputs.every((o) => !o.includes('"deny"')));

  // ---- A-v020-B01..B07
  resetFixture();
  {
    const r = run(["--policy", "remind"], disp(LONG));
    allOutputs.push(r.raw);
    ck.ok("B01 allow+长任务提醒", decision(r) === "allow" && ctx(r).includes("疑似长任务") && ctx(r).includes("run_in_background=true"), r.raw);
  }
  {
    cool();
    const r = run(["--policy", "remind"], disp(LONG, { run_in_background: true }));
    allOutputs.push(r.raw);
    ck.ok("B02 bg 无输出", silent(r), r.raw);
  }
  {
    const r = run(["--policy", "ask"], disp(LONG));
    allOutputs.push(r.raw);
    ck.ok("B03 ask 疑似长任务", decision(r) === "ask" && reason(r).includes("疑似长任务"), r.raw);
  }
  {
    const r = run(["--policy", "remind", "--exempt", "judge"], disp(LONG, { subagent_type: "x-judge" }));
    allOutputs.push(r.raw);
    ck.ok("B04 豁免静默", silent(r), r.raw);
    const r2 = run(["--policy", "remind"], disp(LONG, { subagent_type: "x-judge" }));
    allOutputs.push(r2.raw);
    ck.ok("B04 清豁免出提醒", decision(r2) === "allow" && ctx(r2).includes("疑似长任务"), r2.raw);
  }
  {
    const r = run(["--policy", "off"], disp(LONG));
    allOutputs.push(r.raw);
    ck.ok("B05 off 静默", silent(r), r.raw);
    const r2 = run(["--policy", "${user_config.background_gate}"], disp(LONG));
    allOutputs.push(r2.raw);
    ck.ok("B05 policy 模板字面量按 remind 降级", decision(r2) === "allow" && ctx(r2).includes("疑似长任务"), r2.raw);
    const r3 = run(["--contract", "${user_config.dispatch_contract}"], disp(`[channel] ${MID}\n[token] ${TOK_BAD}\n`, { run_in_background: true }));
    allOutputs.push(r3.raw);
    ck.ok("B05 contract 模板字面量按 remind 降级", decision(r3) === "allow" && ctx(r3).includes("未匹配任何在册 mission"), r3.raw);
  }
  {
    const r = run(["--policy", "remind"], disp("hi"));
    allOutputs.push(r.raw);
    ck.ok("B06 短 prompt 无头静默", silent(r), r.raw);
  }
  {
    const a = run([], "not json");
    const b = run([], "");
    const c = run([], { tool_name: "Agent" });
    allOutputs.push(a.raw, b.raw, c.raw);
    ck.ok("B07 fail-open 三态", silent(a) && silent(b) && silent(c), `${a.raw}|${b.raw}|${c.raw}`);
  }

  // ---- A-v031-S09 扩展
  resetFixture();
  {
    const r = run(["--policy", "remind"], disp(LONG, { run_in_background: true }));
    allOutputs.push(r.raw);
    ck.ok("S09 allow+哨兵句", decision(r) === "allow" && ctx(r).includes("拉起哨兵"), r.raw);
  }
  {
    cool();
    const r = run(["--policy", "remind"], disp(LONG, { run_in_background: true }));
    ck.ok("S09 冷却静默", silent(r), r.raw);
  }
  {
    sentinelOnDuty();
    const r = run(["--policy", "remind"], disp(LONG, { run_in_background: true }));
    ck.ok("S09 在岗静默（v2 槽位）", silent(r), r.raw);
  }
  {
    fs.rmSync(path.join(ROOT, "sentinel"), { recursive: true, force: true });
    legacyLock();
    const r = run(["--policy", "remind"], disp(LONG, { run_in_background: true }));
    ck.ok("S09 两代哨兵都认（legacy lock）", silent(r), r.raw);
  }
  resetFixture();
  cool();
  {
    const r = run(["--policy", "remind"], disp(LONG + `\n[token] ${TOK_BAD}\n`));
    allOutputs.push(r.raw);
    ck.ok("S09 前台叠加句", ctx(r).includes("疑似长任务") && ctx(r).includes("派发契约头未匹配"), r.raw);
  }
  {
    const r = run(["--policy", "remind"], disp(`[channel] ${MID}\n[token] ${TOK_OK}\n`, { run_in_background: true }));
    ck.ok("C1 合法契约静默", silent(r), r.raw);
  }

  // ---- 静态项
  ck.ok("deny never（全输出）", allOutputs.every((o) => !o.toLowerCase().includes("deny")));
  {
    const p = JSON.parse(fs.readFileSync(PLUGIN_JSON, "utf8"));
    ck.ok("plugin.json dispatch_contract default=remind", p.userConfig?.dispatch_contract?.default === "remind", p.userConfig?.dispatch_contract);
    ck.ok("plugin.json version 字符串（容忍阶段8版本推进）", typeof p.version === "string");
  }
} finally {
  BASE.cleanup();
}
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
