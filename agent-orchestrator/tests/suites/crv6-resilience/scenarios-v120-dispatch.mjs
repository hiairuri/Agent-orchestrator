// @module crv6-resilience/scenarios-v120-dispatch
/*!
 * suites/crv6-resilience/scenarios-v120-dispatch.mjs —— v1.2 M3-1 dispatch 场景 DSP
 * （2026-11-01 拆分自 crv6-resilience.mjs：A-v0120-DSP-01..08。断言体逐字搬运零改动，
 * 仅外包 async 函数供入口按序聚合。）
 * v1.5.0 W2-B 增补：DSP-09（T10-a 窄窗竞态 2 腿——indexWritten 置位序手术行为面，
 * l-20261028-2e0c91；A-V0150-T10-a-1/-2。）
 * v1.6 W-p 剥离波大裁：DSP-01..07+DSP-09×2 全腿退役（Q1 播种/busy 闸 index 半区/死信
 * 摘要/T10 竞态——subject=dispatchSeedModelConfig+runner+组合捕获区，随 -p 通道迁
 * parked/agent-orchestrator/）；残存=归因三面 08a/08b/08c（08b 改写 mode==="nested"，
 * W9 scoping 前向归因面 nested 保留）+组收尾 grp。退役台账=v1.6.0.md §W-p。
 */
import fs from "node:fs";
import path from "node:path";
import { runCapture } from "../../harness/capture.mjs";
import {
  ck,
  resultText,
  subRoot,
  startServer,
  PLUGIN_DIR,
  runNode,
  readBoard,
} from "./fixtures.mjs";

export async function runV120DispatchScenarios() {
/* ================= 场景 DSP：v1.2 M3-1 dispatch 三缺陷必修（A-v0120-DSP） ================= */
/* Q1 播种两源快速失败（model→dms，缺失快速失败——v1.2.3 W2 段③「首 api-key 回落」删除，
   dms 命中跳覆写；DSP-02/03 改写钉快速失败＋rejected/guidance＋不 spawn）＋Q2 busy 闸三层兜底
   （killed-index / fail() 补 index / O10=a 超龄豁免＋hint 分叉）＋Q3b 死信摘要
   （outcome/timed_out/exit_code）＋spawned_by_session 归因字段。 */
{
  const grp = (t) => ck.ok(t, true, "");
  const dspBase = subRoot("dsp");
  const dspPack = path.join(dspBase, "pack.md");
  fs.writeFileSync(
    dspPack,
    "# 任务包：DSP 断言组\n\n## CONTRACT（三行契约）\n\n[channel] m-dsp-x\n[worker] gp-dsp#1\n[token] dsp token placeholder\n\n## TASK\n桩 CLI 黑盒。\n",
  );
  const dspPersona = path.join(PLUGIN_DIR, "agents", "orch-worker.md");
  /** 即时桩 CLI（同 crv6-statemachine FA 形）：写 model-io + result envelope。 */
  const dspStub = (file, sessionId) =>
    fs.writeFileSync(
      file,
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        'const dir = process.env.ORCH_ROLLOUT_DIR || ".";',
        'fs.mkdirSync(dir, { recursive: true });',
        `fs.writeFileSync(path.join(dir, "model-io-${sessionId}.jsonl"), JSON.stringify({ t: 1 }) + "\\n");`,
        `console.log(JSON.stringify({ type: "result", sessionId: "${sessionId}", response: "stub-ok", usage: {} }));`,
      ].join("\n") + "\n",
    );
  const fakeBuiltinOf = (dir) => {
    const p = path.join(dir, "zcode-builtin.json");
    fs.writeFileSync(p, JSON.stringify({ schemaVersion: 1, revision: 1, config: { providerConfigRules: { templateRules: [], providerRules: [] }, modelConfigRules: {} } }, null, 2));
    return p;
  };
  const dspUpsert = (sX, id) =>
    sX.call("board", {
      action: "upsert",
      mission: { id, title: id, status: "drafted", agent_type: "agent-orchestrator:orch-worker", scope_paths: ["src/"] },
    });
  const resultDirOf = (rt) => path.join(rt, "context", "dispatch-results");
  const wakeDirOf = (rt) => path.join(rt, "context", "wake-queue");
  // v1.2.3 W2：播种拒绝回执的固定指引（draft §P3 逐字；DSP-02/03 字面断言钉，
  // 与 dispatch-supply.mjs GUIDANCE_* 同源）。
  // v1.4 W3 增补（EXTRA ③-A，W1 随行③候裁落地）：D3 背书两句入列——与 dispatch-supply
  // GUIDANCE_FULL 四元素同文（W1 已落装，沙箱内现版为锚源；:205/:282 两腿全等钉随行改锚）。
  const DSP_GUIDANCE = [
    '显式传 model="<providerId>/<modelId>[@level]"（api-key 型 provider）',
    "请用户在宿主启用目标 api-key provider，使会话 defaultModelSelection 可采信",
    "（实证背书 2026-11-02）CLI 选型层已证账号型目标不可选：defaultModelSelection 指向账号型被无视/过滤（α「Select a model」零请求死、β 静默回落 api-key；见 v1.4 qa/d1-finding.md）——解除禁种在 CLI 层无技术意义。",
    "账号型需求走 nested 主形态（宿主按 subagent_type 加载角色定义；嵌套转发 prompt 系模型逐字转录）；CLI 选型层改造候选已记 patcher 项目 backlog。",
  ];

  // v1.6 W-p 剥离：DSP-01..07 全腿退役（Q1 播种两源快速失败/busy 闸 index 半区+O10=a
  // 超龄豁免/死信摘要/fail() 补 index——subject=headless 播种面+runner+捕获区，随 -p 通道
  // 迁 parked/agent-orchestrator/；台账 v1.6.0.md §W-p）。

  // ---- DSP-08（Q2 spawned_by_session 归因字段：写入面+声明面+外写面）----
  {
    // 08a 锚在场：dispatch 写 spawned_by_session=coord-session.txt 值
    const dir = path.join(dspBase, "dsp8");
    const rt = path.join(dir, "troot");
    fs.mkdirSync(path.join(rt, "sentinel"), { recursive: true });
    fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
    fs.writeFileSync(path.join(rt, "sentinel", "coord-session.txt"), "sess_coord_dsp\n");
    const stub = path.join(dir, "stub.mjs");
    dspStub(stub, "sess_dsp8");
    const sX = startServer({
      root: rt,
      env: {
        ZCODE_CLI_PATH: stub,
        ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "",
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "",
      },
    });
    try {
      await dspUpsert(sX, "m-dsp8");
      const r = resultText(await sX.call("dispatch", { mission_id: "m-dsp8", pack_path: dspPack, persona_path: dspPersona }));
      const board = JSON.parse(fs.readFileSync(path.join(rt, "board.json"), "utf8"));
      const dm = board.missions.find((m) => m.id === "m-dsp8");
      ck.ok(
        "DSP-08a Q2 归因写入面：coord-session.txt 锚在场 → dispatch 落 dispatch.spawned_by_session=锚值" +
          "（W9 scoping 前向归因消费面）",
        r.ok === true && dm && dm.dispatch && dm.dispatch.spawned_by_session === "sess_coord_dsp",
        { dispatch: dm && dm.dispatch },
      );
    } finally {
      sX.close();
    }
    // 08b 锚缺席 → null（前向归因缺席回落，不造值）
    const rtB = path.join(dir, "troot-b");
    fs.mkdirSync(rtB, { recursive: true });
    fs.mkdirSync(path.join(dir, "rollout-b"), { recursive: true });
    const sB = startServer({
      root: rtB,
      env: {
        ZCODE_CLI_PATH: stub,
        ORCH_ROLLOUT_DIR: path.join(dir, "rollout-b"),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "",
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "",
      },
    });
    try {
      await dspUpsert(sB, "m-dsp8b");
      await sB.call("dispatch", { mission_id: "m-dsp8b", pack_path: dspPack, persona_path: dspPersona });
      const board = JSON.parse(fs.readFileSync(path.join(rtB, "board.json"), "utf8"));
      const dm = board.missions.find((m) => m.id === "m-dsp8b");
      ck.ok(
        // v1.6 W-p 改写：缺省 mode 由 headless 变 nested（-p parked）——板记录 mode 断言随行
        "DSP-08b Q2 归因锚缺席 → spawned_by_session=null（best-effort 不造值，W9 空值三段回落；v1.6 W-p 起缺省 mode=nested）",
        dm && dm.dispatch && dm.dispatch.mode === "nested" && dm.dispatch.spawned_by_session === null,
        { dispatch: dm && dm.dispatch },
      );
      // 08c 声明面+外写面：board upsert 携 spawned_by_session 过 schema 且 ONE_LEVEL 合并存活
      const up = await sB.call("board", {
        action: "upsert",
        mission: { id: "m-dsp8c", title: "外写探针", dispatch: { mode: "agent", spawned_by_session: "sess_ext" } },
      });
      const board2 = JSON.parse(fs.readFileSync(path.join(rtB, "board.json"), "utf8"));
      const dm2 = board2.missions.find((m) => m.id === "m-dsp8c");
      ck.ok(
        "DSP-08c Q2 归因声明面：board 工具 schema 增 spawned_by_session（宿主不再拒）且外部 upsert 经" +
          "dispatch/ONE_LEVEL 子键合并存活（R4 低-3 白名单陷阱处置=子键方案，MERGEABLE_KEYS 零改动）",
        up.isError !== true && dm2 && dm2.dispatch && dm2.dispatch.spawned_by_session === "sess_ext",
        { up: up.isError, dispatch: dm2 && dm2.dispatch },
      );
    } finally {
      sB.close();
    }
    }

  grp("DSP 组收尾（v1.6 W-p 大裁后 4 断言：归因三面 08a/08b/08c+组收尾 grp；01..07/09 随 -p parked 退役）");
  }
}
