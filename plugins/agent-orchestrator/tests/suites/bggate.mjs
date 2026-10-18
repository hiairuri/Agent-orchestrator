/*!
 * suites/bggate.mjs —— M-08/M-09/M-10（bg-gate C4/C7/strict=ask 收尾）+ A-v020-B01…B07
 *   + A-v031-S09 扩展（两代哨兵在岗都认/前台叠加句/冷却静默等九分支）
 *   + v0.6 B3（V6-53 契约头正则统一 CONTRACT_HEAD + V6-57 截断代理对回退）
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
import { runCapture, runNode, dispatchInput } from "../harness/capture.mjs";

const ck = new Checker("bggate");
const GATE = path.join(PLUGIN_DIR, "hooks", "bg-gate.mjs");
const SESSION_START = path.join(PLUGIN_DIR, "hooks", "session-start.mjs");
const STOP_CHECK = path.join(PLUGIN_DIR, "hooks", "stop-check.mjs");
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

  // ---- v0.6 B3 / V6-53：契约头正则统一（CONTRACT_HEAD 三处同源；全角不放宽）
  resetFixture();
  {
    // V6-53a：短 prompt + 前导空白契约头（<600 字符，占位 channel 不升级 ask）→
    //   长任务理由是统一正则的真实命中「含派发契约头 [channel]」（修前窄正则漏配 → 只剩 fallback 文案）。
    const r = run(["--policy", "ask"], disp(`\n  [channel] <mission_id>\n[token] ${TOK_BAD}\n`));
    allOutputs.push(r.raw);
    ck.ok("V6-53a 前导空白契约头命中统一正则", decision(r) === "ask" && reason(r).includes("含派发契约头 [channel]"), r.raw);
  }
  {
    // V6-53b：≥600 前导空白契约头（token 合法、契约无扰）→ 理由含「含派发契约头」
    //   而非字符数理由（修前 /^\[channel\]\s?/m 对前导空白漏配 → 落 "prompt N 字符 ≥ 600"）。
    const r = run(["--policy", "ask"], disp(" ".repeat(600) + `\n[channel] ${MID}\n[token] ${TOK_OK}\n`));
    allOutputs.push(r.raw);
    ck.ok("V6-53b 长任务理由含派发契约头", decision(r) === "ask" && reason(r).includes("疑似长任务（含派发契约头 [channel]）") && !reason(r).includes("字符 ≥"), r.raw);
  }

  // ---- v0.6 B4 / V6-52：板不可读明示放行（fail-open 保留 + 提示一句；永不升级 ask）
  resetFixture();
  fs.rmSync(path.join(ROOT, "board.json"), { force: true });
  {
    // V6-52a：板不可读 + 背景派发带契约头 → allow +「契约校验跳过」一句（修前完全静默）。
    //   cool() 压掉哨兵补员句，隔离观察明示放行提示本身。
    cool();
    const r = run(["--policy", "remind"], disp(`[channel] ${MID}\n[token] ${TOK_BAD}\n`, { run_in_background: true }));
    allOutputs.push(r.raw);
    ck.ok("V6-52a 板不可读明示放行（allow + 契约校验跳过句）", decision(r) === "allow" && ctx(r).includes("契约校验跳过") && ctx(r).includes("板不可读") && ctx(r).includes("fail-open"), r.raw);
  }
  {
    // V6-52b：板不可读时 strict=ask 也不升级（contractAsk 与跳过提示互斥）——
    //   高置信 MID + 坏 token，修前本例是静默 allow；修后 allow + 跳过句，绝不是 ask。
    const r = run(["--policy", "remind", "--contract", "ask"], disp(`[channel] ${MID}\n[token] ${TOK_BAD}\n`, { run_in_background: true }));
    allOutputs.push(r.raw);
    ck.ok("V6-52b 板不可读不升级 ask（fail-open 不变量）", decision(r) === "allow" && ctx(r).includes("契约校验跳过"), r.raw);
  }

  // ---- v0.6 B3 / V6-57：截断代理对回退（session-start truncateStr + stop-check 末尾裁剪）
  resetFixture();
  fs.mkdirSync(path.join(ROOT, "memory"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "memory", "lessons.jsonl"),
    JSON.stringify({ status: "active", type: "error-fix", trigger: "a".repeat(39) + "😀", fix: "b".repeat(59) + "😀" }) + "\n",
  );
  fs.writeFileSync(path.join(ROOT, "board.json"), JSON.stringify({
    version: 2,
    missions: [{ id: "m-b3", title: "b3", status: "running", dispatch: {} }],
  }));
  {
    // V6-57a：教训行 40/60 帽切在 emoji 高位代理上 → 回退一位消孤立代理。
    //   trigger 41 单位（39 ASCII + emoji）→ 帽 40 切半 → 回退后恰 39 个 a；fix 同理 59 个 b。
    const r = runNode(SESSION_START, [], {
      cwd: PROJ, env: { ZCODE_PROJECT_DIR: PROJ },
      input: { hook_event_name: "SessionStart", session_id: "s-b3" },
    });
    const out = r.json && r.json.additionalContext ? r.json.additionalContext : "";
    ck.ok("V6-57a 教训行代理对回退（39a→59b，无孤立代理）",
      out.includes(`[error-fix] ${"a".repeat(39)}→${"b".repeat(59)}。`) &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out) && !out.includes("\uFFFD"),
      { out: out.slice(0, 160), raw: r.raw.slice(0, 160) });
  }
  {
    // V6-57b：stop-check 全文 >1500 帽、切点落在 emoji 高位代理上 → 尾部无孤立代理。
    //   依模板复刻计算切位：帽 1497 保 0..1496，emoji 连跑 20 对跨切点（左右各 ≥10 单位余量）。
    const HEAD = "[agent-orchestrator] 收工前清点：任务板尚有 1 项未竟；其余 1 项：[";
    const TAIL =
      "] running，邮箱 0 条未读。" +
      "疑似唤醒失败=子代理结果已落盘但主控未被唤醒接手：先 mailbox(read) 接手，" +
      '处置时 answer/close 自动签收；暂缓用 board(action="ack", mission_id=…, note="deferred by user")。' +
      "能答的答、能关的关。详见 /orch。";
    const cutIdx = 1500 - 3 - 1; // slice(0,1497) 保留末位下标
    const runLen = "😀".repeat(20).length; // 40 单位
    const k = cutIdx - 10 - HEAD.length; // 高位代理恰在切点（偶偏移）
    const longId = "p".repeat(k) + "😀".repeat(20);
    fs.writeFileSync(path.join(ROOT, "board.json"), JSON.stringify({
      version: 2,
      missions: [{ id: longId, title: "b3-stop", status: "running" }],
    }));
    const r = runNode(STOP_CHECK, ["--mirror", "off"], {
      cwd: PROJ, env: { ZCODE_PROJECT_DIR: PROJ },
      input: { hook_event_name: "Stop", session_id: "s-b3", stop_hook_active: false },
    });
    const out = r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext ? r.json.hookSpecificOutput.additionalContext : "";
    const replica = HEAD + longId + TAIL;
    ck.ok("V6-57b 全文裁剪代理对回退（尾部无孤立代理）",
      replica.length > 1500 && out.endsWith("...") && out.includes("；其余 1 项：") &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out) && !out.includes("\uFFFD"),
      { replicaLen: replica.length, outTail: out.slice(-40), raw: r.raw.slice(0, 120) });
  }

  // ---- 静态项
  ck.ok("deny never（全输出）", allOutputs.every((o) => !o.toLowerCase().includes("deny")));
  {
    // V6-52c（静态）：顶层 catch 具备明示放行兜底（黑盒不可达路径，源级断言看护）
    const src = fs.readFileSync(GATE, "utf8");
    ck.ok("V6-52c 顶层 catch 明示放行兜底（静态）", src.includes("契约校验跳过：bg-gate 内部异常"), "gate source missing fail-open note");
  }
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
