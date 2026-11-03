// @module crv6-resilience/scenarios-v120-dispatch
/*!
 * suites/crv6-resilience/scenarios-v120-dispatch.mjs —— v1.2 M3-1 dispatch 场景 DSP
 * （2026-11-01 拆分自 crv6-resilience.mjs：A-v0120-DSP-01..08。断言体逐字搬运零改动，
 * 仅外包 async 函数供入口按序聚合。）
 * v1.5.0 W2-B 增补：DSP-09（T10-a 窄窗竞态 2 腿——indexWritten 置位序手术行为面，
 * l-20261028-2e0c91；A-V0150-T10-a-1/-2。）
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

  // ---- DSP-01（Q1①④）：dms 命中 → 选题=dms、level=dms 原值（非 values.at(-1)）、
  //      种子 defaultModelSelection 与真实配置逐字节同值（跳覆写）、真实配置不动 ----
  {
    const dir = path.join(dspBase, "dsp1");
    fs.mkdirSync(path.join(dir, "troot"), { recursive: true });
    fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
    const stub = path.join(dir, "stub.mjs");
    dspStub(stub, "sess_dsp1");
    const fakeBuiltin = fakeBuiltinOf(dir);
    const fakePersonal = path.join(dir, "provider_config.json");
    const dmsReal = { providerId: "p-dsp", modelId: "DSP-Model", options: { reasoningLevel: "fast" } };
    const personalOriginal = JSON.stringify(
      {
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "p-dsp",
                config: {
                  access: { type: "api-key", apiKey: "sk-dsp" },
                  personalModelIds: ["DSP-Model"],
                  modelOrder: ["DSP-Model"],
                },
              },
            ],
          },
          modelConfigRules: {
            providerModelRules: [
              {
                modelId: "DSP-Model",
                config: { enabled: false, optionSpecs: { reasoningLevel: { values: ["fast", "slow"] } } },
                providerId: "p-dsp",
              },
            ],
          },
          defaultModelSelection: dmsReal,
        },
      },
      null,
      2,
    );
    fs.writeFileSync(fakePersonal, personalOriginal);
    const sX = startServer({
      root: path.join(dir, "troot"),
      env: {
        ZCODE_CLI_PATH: stub,
        ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: fakePersonal,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fakeBuiltin,
      },
    });
    try {
      await dspUpsert(sX, "m-dsp1");
      const r = resultText(await sX.call("dispatch", { mission_id: "m-dsp1", pack_path: dspPack, persona_path: dspPersona }));
      let seedDms = null;
      try {
        seedDms = JSON.parse(fs.readFileSync(r.model_seed.config_path, "utf8")).config.defaultModelSelection;
      } catch {
        seedDms = null;
      }
      ck.ok(
        "DSP-01 Q1①④ dms 命中：选题=dms 的 provider/model 且 reasoning_level=dms 原值 fast" +
          "（optionSpecs at(-1)=slow 未被采用——O9=a 原值直通实锤）；种子 defaultModelSelection 与真实配置同值" +
          "（跳覆写）；真实配置字节级不动",
        r.ok === true && r.model_seed && r.model_seed.seeded === true &&
          r.model_seed.provider_id === "p-dsp" && r.model_seed.model_id === "DSP-Model" &&
          r.model_seed.reasoning_level === "fast" &&
          JSON.stringify(seedDms) === JSON.stringify(dmsReal) &&
          fs.readFileSync(fakePersonal, "utf8") === personalOriginal,
        { model_seed: r.model_seed, seedDms },
      );
    } finally {
      sX.close();
    }
  }

  // ---- DSP-02（Q1② v1.2.3 W2 改写）：dms 指向 disabled provider → 快速失败
  //      dms_provider_disabled（rejected 同名＋provider_id=p-stale＋guidance＋不 spawn；
  //      「回落首 api-key＋覆写自愈」旧行为随段③删除退役，DS-05 钉其缺席）----
  {
    const dir = path.join(dspBase, "dsp2");
    fs.mkdirSync(path.join(dir, "troot"), { recursive: true });
    fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
    const stub = path.join(dir, "stub.mjs");
    dspStub(stub, "sess_dsp2");
    const fakeBuiltin = fakeBuiltinOf(dir);
    const fakePersonal = path.join(dir, "provider_config.json");
    fs.writeFileSync(
      fakePersonal,
      JSON.stringify(
        {
          schemaVersion: 1,
          config: {
            providerConfigRules: {
              providerRules: [
                { providerId: "p-stale", enabled: false, config: { access: { type: "api-key", apiKey: "sk-old" } } },
                {
                  providerId: "p-live",
                  config: { access: { type: "api-key", apiKey: "sk-live" }, modelOrder: ["DSP-New"] },
                },
              ],
            },
            modelConfigRules: {
              providerModelRules: [
                {
                  modelId: "DSP-New",
                  config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["a", "b"] } } },
                  providerId: "p-live",
                },
              ],
            },
            defaultModelSelection: { providerId: "p-stale", modelId: "DSP-Old", options: { reasoningLevel: "mid" } },
          },
        },
        null,
        2,
      ),
    );
    const sX = startServer({
      root: path.join(dir, "troot"),
      env: {
        ZCODE_CLI_PATH: stub,
        ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: fakePersonal,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fakeBuiltin,
      },
    });
    try {
      await dspUpsert(sX, "m-dsp2");
      const r = resultText(await sX.call("dispatch", { mission_id: "m-dsp2", pack_path: dspPack, persona_path: dspPersona }));
      const rt = path.join(dir, "troot");
      ck.ok(
        "DSP-02 Q1② dms 指向 disabled provider → 快速失败 dms_provider_disabled（v1.2.3 W2：reason=rejected.kind " +
          "同名直通＋provider_id=p-stale＋guidance 两条字面；不再回落首 api-key p-live——禁自动回落，impl-plan §9 处置表）",
        r.ok === true && r.model_seed && r.model_seed.seeded === false &&
          r.model_seed.reason === "dms_provider_disabled" &&
          r.model_seed.rejected && r.model_seed.rejected.kind === "dms_provider_disabled" &&
          r.model_seed.rejected.provider_id === "p-stale" &&
          JSON.stringify(r.model_seed.guidance) === JSON.stringify(DSP_GUIDANCE),
        { model_seed: r.model_seed },
      );
      ck.ok(
        "DSP-02 不 spawn＋种子文件不落＋board 留 drafted（§12 拒绝=未派发：桩标记缺席＋result dir 零侧车，" +
          "p-live 模型不被播种——busy 闸零侧车不拦重派）",
        !fs.existsSync(path.join(dir, "rollout", "model-io-sess_dsp2.jsonl")) &&
          (!fs.existsSync(resultDirOf(rt)) || fs.readdirSync(resultDirOf(rt)).length === 0) &&
          !fs.existsSync(path.join(rt, "context", "dispatch-model-seed", "m-dsp2.json")) &&
          readBoard(rt).missions.find((m) => m && m.id === "m-dsp2").status === "drafted",
        {
          marker: fs.existsSync(path.join(dir, "rollout", "model-io-sess_dsp2.jsonl")),
          seedWritten: fs.existsSync(path.join(rt, "context", "dispatch-model-seed", "m-dsp2.json")),
        },
      );
    } finally {
      sX.close();
    }
  }

  // ---- DSP-03（Q1③ v1.2.3 W2 改写）：无 dms → 快速失败 selection_missing（rejected 同名＋
  //      provider_id 缺席=不命中任何 provider＋guidance＋不 spawn；「回落首 api-key」回归锁随
  //      段③删除退役，DS-05 同语义套件腿）----
  {
    const dir = path.join(dspBase, "dsp3");
    fs.mkdirSync(path.join(dir, "troot"), { recursive: true });
    fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
    const stub = path.join(dir, "stub.mjs");
    dspStub(stub, "sess_dsp3");
    const fakeBuiltin = fakeBuiltinOf(dir);
    const fakePersonal = path.join(dir, "provider_config.json");
    fs.writeFileSync(
      fakePersonal,
      JSON.stringify(
        {
          schemaVersion: 1,
          config: {
            providerConfigRules: {
              providerRules: [
                { providerId: "p-only", config: { access: { type: "api-key", apiKey: "sk-x" }, modelOrder: ["M-Only"] } },
              ],
            },
            modelConfigRules: {
              providerModelRules: [
                {
                  modelId: "M-Only",
                  config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["x", "y"] } } },
                  providerId: "p-only",
                },
              ],
            },
          },
        },
        null,
        2,
      ),
    );
    const sX = startServer({
      root: path.join(dir, "troot"),
      env: {
        ZCODE_CLI_PATH: stub,
        ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: fakePersonal,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fakeBuiltin,
      },
    });
    try {
      await dspUpsert(sX, "m-dsp3");
      const r = resultText(await sX.call("dispatch", { mission_id: "m-dsp3", pack_path: dspPack, persona_path: dspPersona }));
      const rt = path.join(dir, "troot");
      ck.ok(
        "DSP-03 Q1③ 无 dms → 快速失败 selection_missing（v1.2.3 W2 段③退役：reason=rejected.kind 同名直通＋" +
          "provider_id 缺席=不命中任何 provider（p-only 不被播种）＋guidance 两条字面）",
        r.ok === true && r.model_seed && r.model_seed.seeded === false &&
          r.model_seed.reason === "selection_missing" &&
          r.model_seed.rejected && r.model_seed.rejected.kind === "selection_missing" &&
          r.model_seed.rejected.provider_id === undefined && r.model_seed.provider_id === undefined &&
          JSON.stringify(r.model_seed.guidance) === JSON.stringify(DSP_GUIDANCE),
        { model_seed: r.model_seed },
      );
      ck.ok(
        "DSP-03 不 spawn＋种子文件不落＋board 留 drafted（§12 拒绝=未派发：桩标记缺席＋result dir 零侧车）",
        !fs.existsSync(path.join(dir, "rollout", "model-io-sess_dsp3.jsonl")) &&
          (!fs.existsSync(resultDirOf(rt)) || fs.readdirSync(resultDirOf(rt)).length === 0) &&
          !fs.existsSync(path.join(rt, "context", "dispatch-model-seed", "m-dsp3.json")) &&
          readBoard(rt).missions.find((m) => m && m.id === "m-dsp3").status === "drafted",
        {
          marker: fs.existsSync(path.join(dir, "rollout", "model-io-sess_dsp3.jsonl")),
          seedWritten: fs.existsSync(path.join(rt, "context", "dispatch-model-seed", "m-dsp3.json")),
        },
      );
    } finally {
      sX.close();
    }
  }

  // ---- DSP-04（Q1⑤）：显式 model 参数优先级最高（dms 在场仍让位），覆写随显式选型 ----
  {
    const dir = path.join(dspBase, "dsp4");
    fs.mkdirSync(path.join(dir, "troot"), { recursive: true });
    fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
    const stub = path.join(dir, "stub.mjs");
    dspStub(stub, "sess_dsp4");
    const fakeBuiltin = fakeBuiltinOf(dir);
    const fakePersonal = path.join(dir, "provider_config.json");
    fs.writeFileSync(
      fakePersonal,
      JSON.stringify(
        {
          schemaVersion: 1,
          config: {
            providerConfigRules: {
              providerRules: [
                {
                  providerId: "p-dsp",
                  config: { access: { type: "api-key", apiKey: "sk-d" }, modelOrder: ["DSP-Model"] },
                },
                {
                  providerId: "p-other",
                  config: { access: { type: "api-key", apiKey: "sk-o" }, modelOrder: ["Other-Model"] },
                },
              ],
            },
            modelConfigRules: {
              providerModelRules: [
                {
                  modelId: "DSP-Model",
                  config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["fast", "slow"] } } },
                  providerId: "p-dsp",
                },
                {
                  modelId: "Other-Model",
                  config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["lo", "hi"] } } },
                  providerId: "p-other",
                },
              ],
            },
            defaultModelSelection: { providerId: "p-dsp", modelId: "DSP-Model", options: { reasoningLevel: "fast" } },
          },
        },
        null,
        2,
      ),
    );
    const sX = startServer({
      root: path.join(dir, "troot"),
      env: {
        ZCODE_CLI_PATH: stub,
        ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: fakePersonal,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fakeBuiltin,
      },
    });
    try {
      await dspUpsert(sX, "m-dsp4");
      const r = resultText(
        await sX.call("dispatch", {
          mission_id: "m-dsp4",
          pack_path: dspPack,
          persona_path: dspPersona,
          model: "p-other/Other-Model@hi",
        }),
      );
      let seedDms = null;
      try {
        seedDms = JSON.parse(fs.readFileSync(r.model_seed.config_path, "utf8")).config.defaultModelSelection;
      } catch {
        seedDms = null;
      }
      ck.ok(
        "DSP-04 Q1⑤ 显式 model 最高优先：dms 在场仍采用 p-other/Other-Model@hi（显式 @level 直通），" +
          "种子 dms 覆写为显式选型（非 fromDms → 覆写分支生效）",
        r.ok === true && r.model_seed && r.model_seed.seeded === true &&
          r.model_seed.provider_id === "p-other" && r.model_seed.model_id === "Other-Model" &&
          r.model_seed.reasoning_level === "hi" &&
          JSON.stringify(seedDms) ===
            JSON.stringify({ providerId: "p-other", modelId: "Other-Model", options: { reasoningLevel: "hi" } }),
        { model_seed: r.model_seed, seedDms },
      );
    } finally {
      sX.close();
    }
  }

  // ---- DSP-05（Q2 busy 闸三态＋O10=a 超龄豁免）----
  {
    const dir = path.join(dspBase, "dsp5");
    const rt = path.join(dir, "troot");
    fs.mkdirSync(path.join(rt, "context", "dispatch-results"), { recursive: true });
    fs.mkdirSync(path.join(rt, "context", "dispatch-logs"), { recursive: true });
    fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
    const stub = path.join(dir, "stub.mjs");
    dspStub(stub, "sess_dsp5");
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
      // 05a kill/spawn-fail 模拟放行：runner 死亡兜底/早期失败补写的 index 在场 → 闸放行
      //（模拟 runner_killed / runner_early_fail 落盘形态——文件名族与真 index 同）
      await dspUpsert(sX, "m-dsp5a");
      await sX.call("board", {
        action: "upsert",
        mission: { id: "m-dsp5a", status: "dispatched", dispatch: { mode: "headless" } },
      });
      fs.writeFileSync(
        path.join(resultDirOf(rt), "m-dsp5a-1700000000000.index.json"),
        JSON.stringify({ mission_id: "m-dsp5a", killed: true, outcome: "error", error: "runner_killed: exit" }) + "\n",
      );
      const ra = resultText(await sX.call("dispatch", { mission_id: "m-dsp5a", pack_path: dspPack, persona_path: dspPersona }));
      ck.ok(
        "DSP-05a Q2 kill/spawn-fail 模拟放行：killed/early-fail index 在场（无新鲜侧车门槛）→ busy 闸放行，" +
          "重派 e2e ok 且现形 session（双入口补 index 的闸解锁语义）",
        ra.ok === true && ra.session_id === "sess_dsp5" && ra.warning === undefined,
        { ok: ra.ok, session_id: ra.session_id, err: ra.error },
      );
      // 05b 真在飞不误放：无 index + 新鲜侧车 → 拒双跑
      await dspUpsert(sX, "m-dsp5b");
      await sX.call("board", {
        action: "upsert",
        mission: { id: "m-dsp5b", status: "dispatched", dispatch: { mode: "headless" } },
      });
      const freshLog = path.join(rt, "context", "dispatch-logs", "m-dsp5b-now.runner.log");
      fs.writeFileSync(freshLog, "flying\n");
      const rb = await sX.call("dispatch", { mission_id: "m-dsp5b", pack_path: dspPack, persona_path: dspPersona });
      ck.ok(
        "DSP-05b Q2 真在飞不误放：无 index + 侧车新鲜 → busy 闸拒双跑（isError 文案含 busy 闸/index）",
        rb.isError === true && /busy 闸/.test(rb.text) && /index/.test(rb.text),
        rb.text.slice(0, 120),
      );
      // 05c O10=a 超龄豁免：无 index + 侧车全超龄（3h 前，>默认 120min）→ 放行 + warning
      await dspUpsert(sX, "m-dsp5c");
      await sX.call("board", {
        action: "upsert",
        mission: { id: "m-dsp5c", status: "dispatched", dispatch: { mode: "headless" } },
      });
      const stalePrompt = path.join(rt, "context", "dispatch-logs", "m-dsp5c-old.prompt");
      fs.writeFileSync(stalePrompt, "stale\n");
      const staleMs = (Date.now() - 3 * 3600 * 1000) / 1000;
      fs.utimesSync(stalePrompt, staleMs, staleMs);
      const rc = resultText(await sX.call("dispatch", { mission_id: "m-dsp5c", pack_path: dspPack, persona_path: dspPersona }));
      ck.ok(
        "DSP-05c Q2 O10=a 超龄豁免：无 index + 侧车全超龄（3h>120min 默认阈值）→ 放行重派 ok + " +
          "warning 含超龄豁免与孤儿风险提示 + e2e 现形 session",
        rc.ok === true && rc.session_id === "sess_dsp5" && typeof rc.warning === "string" &&
          /超龄豁免/.test(rc.warning) && /孤儿/.test(rc.warning),
        { ok: rc.ok, session_id: rc.session_id, warning: rc.warning },
      );
      // 05d 侧车全无维持拒（never-dispatched ≠ 孤儿；crv2 W4-DISPATCH-08 黑盒同语义）
      await dspUpsert(sX, "m-dsp5d");
      await sX.call("board", {
        action: "upsert",
        mission: { id: "m-dsp5d", status: "dispatched", dispatch: { mode: "headless" } },
      });
      const rd = await sX.call("dispatch", { mission_id: "m-dsp5d", pack_path: dspPack, persona_path: dspPersona });
      ck.ok(
        "DSP-05d Q2 判据边界：无 index 且零侧车（dispatch 同步段从未跑过）→ 维持拒双跑" +
          "（偏差声明：DP2b「侧车全无→豁免」腿收敛为拒，防手写 mode=headless 记录误放行，crv2-08 语义保持）",
        rd.isError === true && /busy 闸/.test(rd.text),
        rd.text.slice(0, 120),
      );
      // 05e 阈值 env 生效：ORCH_DISPATCH_BUSY_STALE_MIN=1 → 2min 侧车即超龄 → 豁免放行
      const dirE = path.join(dspBase, "dsp5e");
      const rtE = path.join(dirE, "troot");
      fs.mkdirSync(path.join(rtE, "context", "dispatch-logs"), { recursive: true });
      fs.mkdirSync(path.join(dirE, "rollout"), { recursive: true });
      dspStub(path.join(dirE, "stub.mjs"), "sess_dsp5e");
      const sE = startServer({
        root: rtE,
        env: {
          ZCODE_CLI_PATH: path.join(dirE, "stub.mjs"),
          ORCH_ROLLOUT_DIR: path.join(dirE, "rollout"),
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "",
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "",
          ORCH_DISPATCH_BUSY_STALE_MIN: "1",
        },
      });
      try {
        await dspUpsert(sE, "m-dsp5e");
        await sE.call("board", {
          action: "upsert",
          mission: { id: "m-dsp5e", status: "dispatched", dispatch: { mode: "headless" } },
        });
        const twoMinOld = path.join(rtE, "context", "dispatch-logs", "m-dsp5e-old.prompt");
        fs.writeFileSync(twoMinOld, "old\n");
        const oldMs = (Date.now() - 2 * 60 * 1000) / 1000;
        fs.utimesSync(twoMinOld, oldMs, oldMs);
        const re = resultText(await sE.call("dispatch", { mission_id: "m-dsp5e", pack_path: dspPack, persona_path: dspPersona }));
        ck.ok(
          "DSP-05e Q2 阈值 env 可调：ORCH_DISPATCH_BUSY_STALE_MIN=1 → 2min 侧车超龄 → 豁免放行",
          re.ok === true && typeof re.warning === "string" && re.warning.includes(">1min"),
          { ok: re.ok, warning: re.warning },
        );
      } finally {
        sE.close();
      }
    } finally {
      sX.close();
    }
  }

  // ---- DSP-06/07（Q3b 死信摘要＋Q2 fail() 补 index：runner 黑盒直跑）----
  {
    const dir = path.join(dspBase, "dsp6");
    const rt = path.join(dir, "root");
    const resDir = path.join(rt, "context", "dispatch-results");
    fs.mkdirSync(resDir, { recursive: true });
    const runnerPath = path.join(PLUGIN_DIR, "hooks", "dispatch-runner.mjs");
    // 06a 失败腿：桩 exit 1 且无信封 → finish() error 路径 index outcome=error + wake 三字段
    const stubFail = path.join(dir, "stub-fail.mjs");
    fs.writeFileSync(stubFail, 'process.exit(1);\n');
    fs.writeFileSync(path.join(dir, "prompt.txt"), "[worker] gp-dsp#1\nTASK stub\n");
    const runFail = runNode(runnerPath, [
      "--mission-id", "m-dsp6a",
      "--prompt", path.join(dir, "prompt.txt"),
      "--cwd", rt,
      "--result-dir", resDir,
      "--log", path.join(rt, "context", "dispatch-logs", "m-dsp6a.log"),
      "--cli", stubFail,
    ], { cwd: rt });
    const idxA = (() => {
      try {
        const name = fs.readdirSync(resDir).find((n) => /^m-dsp6a-\d+\.index\.json$/.test(n));
        return name ? JSON.parse(fs.readFileSync(path.join(resDir, name), "utf8")) : null;
      } catch {
        return null;
      }
    })();
    const evA = (() => {
      try {
        const qdir = wakeDirOf(rt);
        const name = fs.readdirSync(qdir).find((n) => /^m-dsp6a\.json$/.test(n) || /^\d+-m-dsp6a\.json$/.test(n));
        return name ? JSON.parse(fs.readFileSync(path.join(qdir, name), "utf8")) : null;
      } catch {
        return null;
      }
    })();
    ck.ok(
      "DSP-06a Q3b 死信摘要（失败腿）：桩 exit 1 无信封 → index {outcome:error, timed_out:false, exit_code:1}，" +
        "wake 事件携 outcome/timed_out/exit_code 三字段（主控被唤即知死因）",
      runFail.code === 0 && idxA && idxA.outcome === "error" && idxA.timed_out === false && idxA.exit_code === 1 &&
        evA && evA.outcome === "error" && evA.timed_out === false && evA.exit_code === 1,
      { code: runFail.code, idxA, evA },
    );
    // 06b 正常腿：即时桩 → index outcome=result + wake 三字段
    const rtB = path.join(dir, "root-b");
    const resDirB = path.join(rtB, "context", "dispatch-results");
    fs.mkdirSync(resDirB, { recursive: true });
    const stubOk = path.join(dir, "stub-ok.mjs");
    dspStub(stubOk, "sess_dsp6b");
    const runOk = runNode(runnerPath, [
      "--mission-id", "m-dsp6b",
      "--prompt", path.join(dir, "prompt.txt"),
      "--cwd", rtB,
      "--result-dir", resDirB,
      "--log", path.join(rtB, "context", "dispatch-logs", "m-dsp6b.log"),
      "--cli", stubOk,
    ], { cwd: rtB });
    const idxB = (() => {
      try {
        const name = fs.readdirSync(resDirB).find((n) => /^m-dsp6b-\d+\.index\.json$/.test(n));
        return name ? JSON.parse(fs.readFileSync(path.join(resDirB, name), "utf8")) : null;
      } catch {
        return null;
      }
    })();
    const evB = (() => {
      try {
        const qdir = wakeDirOf(rtB);
        const name = fs.readdirSync(qdir).find((n) => /^\d+-m-dsp6b\.json$/.test(n));
        return name ? JSON.parse(fs.readFileSync(path.join(qdir, name), "utf8")) : null;
      } catch {
        return null;
      }
    })();
    ck.ok(
      "DSP-06b Q3b 死信摘要（正常腿）：收 result → index {outcome:result, timed_out:false, exit_code:0}，" +
        "wake 事件三字段同值（timeout 腿以源钉承接：runner 源含 timedOut?\"timeout\" 映射，分钟粒度不实弹）",
      runOk.code === 0 && idxB && idxB.outcome === "result" && idxB.timed_out === false && idxB.exit_code === 0 &&
        evB && evB.outcome === "result" && evB.timed_out === false && evB.exit_code === 0 &&
        /\? "timeout" : /.test(fs.readFileSync(runnerPath, "utf8")),
      { code: runOk.code, idxB, evB },
    );
    // 07 fail() 早期失败补 index（error=runner_early_fail）——缺 --prompt 实弹
    const rtC = path.join(dir, "root-c");
    const resDirC = path.join(rtC, "context", "dispatch-results");
    fs.mkdirSync(resDirC, { recursive: true });
    const runC = runNode(runnerPath, [
      "--mission-id", "m-dsp7",
      "--cwd", rtC,
      "--result-dir", resDirC,
      "--log", path.join(rtC, "context", "dispatch-logs", "m-dsp7.log"),
      "--cli", stubOk,
    ], { cwd: rtC });
    const idxC = (() => {
      try {
        const name = fs.readdirSync(resDirC).find((n) => /^m-dsp7-\d+\.index\.json$/.test(n));
        return name ? JSON.parse(fs.readFileSync(path.join(resDirC, name), "utf8")) : null;
      } catch {
        return null;
      }
    })();
    const errC = fs.existsSync(resDirC)
      ? fs.readdirSync(resDirC).some((n) => /^m-dsp7-.+\.error\.json$/.test(n))
      : false;
    ck.ok(
      "DSP-07 Q2 入口② fail() 补 index：缺 --prompt → runner exitCode=1 且 index 在场" +
        "（error=runner_early_fail 前缀、session_id/result_path=null、error_path 指向 error 侧车）" +
        "——spawn 失败路径不再零 index，busy 闸解锁",
      runC.code === 1 && idxC && typeof idxC.error === "string" && idxC.error.startsWith("runner_early_fail") &&
        idxC.session_id === null && idxC.result_path === null && typeof idxC.error_path === "string" && errC,
      { code: runC.code, idxC, errC },
    );
  }

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
        "DSP-08b Q2 归因锚缺席 → spawned_by_session=null（best-effort 不造值，W9 空值三段回落）",
        dm && dm.dispatch && dm.dispatch.mode === "headless" && dm.dispatch.spawned_by_session === null,
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
  grp("DSP 组收尾（A-v0120-DSP 15 断言：Q1 五腿/忙碌闸三态+env 阈值/死信两腿+fail 补 index/归因三面）");
  // ---- DSP-09（v1.5.0 W2-B T10-a：indexWritten 置位序窄窗竞态——复现腿+修复后行为腿）----
  //  T10 手术（dispatch-runner fail/finish 两段 indexWritten=true 后移至真实 index 写入成功之后；
  //  :246-247 兜底自身不在手术面）的行为腿。故障桩（--require 预载；首个 .index.json renameSync
  //  抛错一次后放行=窄窗写入抛错注入；marker 文件证故障咬合）×两形态 runner：
  //  ①修复前形态副本（两处置位逆位移回写入点之前，字面锚+恰 1 计数守卫防漂移；副本物化于
  //  测试临时目录，插件树零写）→ 置位已发生→exit handler killed 兜底跳过→无 index=busy 闸维持
  //  （缺陷档案 l-20261028-2e0c91 复现）；②现 runner（修复后）→ 置位未发生→兜底落 killed:true
  //  index=busy 闸解锁（card-result-dir :44 语义句行为面承载）。fail 段实弹（--prompt 缺文件
  //  =prompt unreadable 路径，零 CLI spawn）；finish 段镜像腿不另设（impl-plan §5.2「视首腿形
  //  裁量」采不设，finish 直跑行为由 DSP-06a/06b 既有腿承载）。
  {
    const grp9 = (t) => ck.ok(t, true, "");
    const dir = subRoot("dsp9");
    fs.mkdirSync(dir, { recursive: true });
    const runnerPath = path.join(PLUGIN_DIR, "hooks", "dispatch-runner.mjs");
    const faultStub = path.join(dir, "throw-once.cjs");
    fs.writeFileSync(
      faultStub,
      [
        "// T10-a 故障桩（测试夹具非运行面）：首个 .index.json renameSync 抛错一次后放行",
        'const fs = require("node:fs");',
        "const orig = fs.renameSync;",
        "let thrown = false;",
        "fs.renameSync = function (from, to) {",
        '  if (!thrown && String(to).endsWith(".index.json")) {',
        "    thrown = true;",
        '    if (process.env.ORCH_T10A_FAULT_MARKER) { try { fs.writeFileSync(process.env.ORCH_T10A_FAULT_MARKER, "thrown"); } catch {} }',
        '    throw new Error("T10-a fault: index write failure injected");',
        "  }",
        "  return orig.call(fs, from, to);",
        "};",
      ].join("\n") + "\n",
    );
    const runFaulted = (runnerFile, id) =>
      runCapture({
        script: process.execPath,
        args: [
          "--require", faultStub, runnerFile,
          "--mission-id", id,
          "--prompt", path.join(dir, "absent-prompt.txt"),
          "--cwd", dir,
          "--result-dir", path.join(dir, id, "results"),
          "--log", path.join(dir, id + ".runner.log"),
        ],
        env: { ORCH_T10A_FAULT_MARKER: path.join(dir, id + ".fault.marker") },
        timeoutMs: 30000,
      });
    const indexOf = (id, resDir) => {
      try {
        const name = fs.readdirSync(resDir).find((n) => new RegExp("^" + id + "-\\d+\\.index\\.json$").test(n));
        return name ? JSON.parse(fs.readFileSync(path.join(resDir, name), "utf8")) : null;
      } catch {
        return null;
      }
    };
    // T10-a-1 复现腿：修复前形态副本（置位逆位移×2；源码 CRLF 先归一 LF，锚带行首 \n 钉位防
    // 短缩进前缀误计；锚漂移=swapOk 响红不静默）
    const FLAG_A_POST = "\n        });\n        indexWritten = true;\n      }";
    const CALL_A = "\n        atomicWriteJson(path.join(resultDir, `${missionId}-${startedMs}.index.json`), {";
    const FLAG_B_POST = "\n    });\n    indexWritten = true;\n    // v1.1.1 W-B（生产者②）";
    const CALL_B = "\n    atomicWriteJson(path.join(resultDir, `${missionId}-${startedMs}.index.json`), {";
    let prefixSrc = fs.readFileSync(runnerPath, "utf8").replace(/\r\n/g, "\n");
    let swapOk = true;
    for (const [post, postTo, call, callTo] of [
      [FLAG_A_POST, "\n        });\n      }", CALL_A, "\n        indexWritten = true;" + CALL_A],
      [FLAG_B_POST, "\n    });\n    // v1.1.1 W-B（生产者②）", CALL_B, "\n    indexWritten = true;" + CALL_B],
    ]) {
      if (prefixSrc.split(post).length - 1 !== 1 || prefixSrc.split(call).length - 1 !== 1) { swapOk = false; break; }
      prefixSrc = prefixSrc.replace(post, postTo).replace(call, callTo);
    }
    fs.writeFileSync(path.join(dir, "runner-prefix.mjs"), prefixSrc);
    const resA = path.join(dir, "m-dsp9a", "results");
    const runA = runFaulted(path.join(dir, "runner-prefix.mjs"), "m-dsp9a");
    const idxA = indexOf("m-dsp9a", resA);
    const errA = fs.existsSync(resA) && fs.readdirSync(resA).some((n) => /^m-dsp9a-.+\.error\.json$/.test(n));
    const faultA = fs.existsSync(path.join(dir, "m-dsp9a.fault.marker"));
    ck.ok(
      "T10-a-1 窄窗复现腿（v1.5.0 W2-B，l-20261028-2e0c91 缺陷档）：修复前形态副本（置位先于真实 index 写入）" +
        "+故障注入 → fail 段 index 写入抛错→置位已发生→exit handler killed 兜底跳过→无 index" +
        "（busy 闸维持至超龄豁免档复现；error 侧车在场+fault marker 证故障咬合）",
      runA.code === 1 && swapOk && faultA && errA && !idxA,
      { code: runA.code, swapOk, faultA, errA, idxA },
    );
    // T10-a-2 修复后行为腿：现 runner（置位于写入成功之后）同故障 → 兜底接手落 killed index
    const resB = path.join(dir, "m-dsp9b", "results");
    const runB = runFaulted(runnerPath, "m-dsp9b");
    const idxB = indexOf("m-dsp9b", resB);
    const faultB = fs.existsSync(path.join(dir, "m-dsp9b.fault.marker"));
    ck.ok(
      "T10-a-2 修复后行为腿：现 runner fail 段置位后移（indexWritten 置位于 index 写入成功之后）同故障注入 → " +
        "置位未发生→writeKilledIndex 兜底接手→index 在场（killed:true、outcome:error、error=runner_killed: exit、" +
        "session_id/result_path=null）=busy 闸解锁",
      runB.code === 1 && faultB && idxB && idxB.killed === true && idxB.outcome === "error" &&
        idxB.error === "runner_killed: exit" && idxB.session_id === null && idxB.result_path === null,
      { code: runB.code, faultB, idxB },
    );
    grp9("T10-a 组收尾（v1.5.0 W2-B 窄窗竞态 2 腿：复现腿+修复后行为腿；DSP-05a :421 夹具腿方向不变由聚合承载）");
  }
}
}