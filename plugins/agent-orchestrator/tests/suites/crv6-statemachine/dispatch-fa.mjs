// @module crv6-statemachine/dispatch-fa
/*!
 * suites/crv6-statemachine/dispatch-fa.mjs —— v1.1.1-FA dispatch headless 修复波断言
 *
 *   根因权威=designs/agent-orchestrator-v1.1.1-dispatch-bug-findings.md（R2）+
 *   bundle 考古锚（server.mjs dispatchSeedModelConfig 注释块全录）。
 *   FA-1 基线腿：无 env 对 → 不播种（env_pair_missing），即时桩现形 session_id、无 pending；
 *   FA-2 播种写盘腿：env 对在场 → 副本落盘 + defaultModelSelection 形状锁 + 复制体翻转
 *     enabled、真实配置字节不动；
 *   FA-3 model 入参负例：不可用（非 api-key provider）→ seeded:false+reason，不静默换模；
 *   FA-4 秒死注入：桩 CLI exit 1 +「Select a model」stderr → ok:false+error+hint；
 *   FA-5 慢启动：桩 CLI 超捕获窗 → ok:true+session_pending（真慢启动契约保持）。
 *   尾置 await sleep(0) 事件落盘窗口兜底（原单文件 try 尾句随本模块收尾搬运）。
 *
 * 拆分自 suites/crv6-statemachine.mjs（初步切分批次），断言本体逐字搬运零行为变更。
 */
import fs from "node:fs";
import path from "node:path";
import { startServer, PLUGIN_DIR } from "../../harness/jsonrpc-client.mjs";

export async function run(ctx) {
  const { ck, BASE, resultText, sleep } = ctx;

    // ================================================================
    // v1.1.1-FA：dispatch headless 修复波（模型供给播种 + 失败显式化）。
    // 根因权威=designs/agent-orchestrator-v1.1.1-dispatch-bug-findings.md（R2）+
    // bundle 考古锚（server.mjs dispatchSeedModelConfig 注释块全录）。
    // ================================================================
    const faBase = path.join(BASE.root, "fa");
    fs.mkdirSync(faBase, { recursive: true });
    const faPack = path.join(faBase, "pack.md");
    fs.writeFileSync(
      faPack,
      "# 任务包：FA 修复波\n\n## CONTRACT（三行契约）\n\n[channel] m-fa-x\n[worker] gp-fa#1\n[token] fa token placeholder\n\n## TASK\n桩 CLI 黑盒。\n",
    );
    const faPersona = path.join(PLUGIN_DIR, "agents", "orch-worker.md");
    /** 即时桩 CLI：写 model-io + result envelope（=正常拉起）。 */
    const writeInstantStub = (file, sessionId) =>
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
    const faUpsert = async (sX, id) =>
      sX.call("board", {
        action: "upsert",
        mission: { id, title: id, status: "drafted", agent_type: "agent-orchestrator:orch-worker", scope_paths: ["src/"] },
      });

    // ---- FA-1 基线腿（无 env 对 → 不播种；即时桩 → 现形 session_id，无 pending）----
    {
      const dir = path.join(faBase, "fa1");
      const stub = path.join(dir, "stub.mjs");
      fs.mkdirSync(path.join(dir, "troot"), { recursive: true });
      fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
      writeInstantStub(stub, "sess_fa1");
      const sX = startServer({
        root: path.join(dir, "troot"),
        cwd: path.join(dir, "troot"),
        env: {
          ZCODE_CLI_PATH: stub,
          ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "",
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "",
        },
      });
      try {
        await faUpsert(sX, "m-fa1");
        const r = resultText(await sX.call("dispatch", { mission_id: "m-fa1", pack_path: faPack, persona_path: faPersona }));
        ck.ok(
          "FA-1 即时桩基线：无 env 对 → model_seed.seeded=false(reason=env_pair_missing)，" +
            "dispatch 仍 ok:true 且现形 session_id（≤8s 组合捕获的 rollout 面），无 session_pending",
          r.ok === true && r.session_id === "sess_fa1" && r.session_pending === undefined &&
            r.model_seed && r.model_seed.seeded === false && r.model_seed.reason === "env_pair_missing",
          { ok: r.ok, session_id: r.session_id, model_seed: r.model_seed, pending: r.session_pending },
        );
      } finally {
        sX.close();
      }
    }

    // ---- FA-2 播种写盘腿：env 对在场 → 副本落盘 + defaultModelSelection 形状锁 +
    //      复制体翻转 enabled、真实配置字节不动 ----
    {
      const dir = path.join(faBase, "fa2");
      fs.mkdirSync(path.join(dir, "troot"), { recursive: true });
      fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
      const stub = path.join(dir, "stub.mjs");
      writeInstantStub(stub, "sess_fa2");
      const fakeBuiltin = path.join(dir, "zcode-builtin.json");
      fs.writeFileSync(fakeBuiltin, JSON.stringify({ schemaVersion: 1, revision: 1, config: { providerConfigRules: { templateRules: [], providerRules: [] }, modelConfigRules: {} } }, null, 2));
      const fakePersonal = path.join(dir, "provider_config.json");
      const personalOriginal = JSON.stringify(
        {
          schemaVersion: 1,
          config: {
            providerOrder: ["fa-provider"],
            providerConfigRules: {
              providerRules: [
                {
                  providerId: "fa-provider",
                  providerName: "FA Seed Provider",
                  config: {
                    group: "standard-personal",
                    access: { type: "api-key", apiKey: "sk-fa-seed" },
                    api: { type: "openai-chat-completions", baseUrl: "https://example.invalid/v1" },
                    personalModelIds: ["FA-Model"],
                    modelOrder: ["FA-Model"],
                  },
                },
              ],
            },
            modelConfigRules: {
              providerModelRules: [{
                modelId: "FA-Model",
                config: { enabled: false, optionSpecs: { reasoningLevel: { values: ["disabled", "enabled"] } } },
                providerId: "fa-provider",
              }],
            },
          },
        },
        null,
        2,
      );
      fs.writeFileSync(fakePersonal, personalOriginal);
      const sX = startServer({
        root: path.join(dir, "troot"),
        cwd: path.join(dir, "troot"),
        env: {
          ZCODE_CLI_PATH: stub,
          ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: fakePersonal,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fakeBuiltin,
        },
      });
      try {
        await faUpsert(sX, "m-fa2");
        // v1.2.3 W2：显式 model 入参补一枚——FA-2 原驱动（无 model= 无 dms）即被删除的
        // 段③「首 api-key」场景（selection_missing 接管，DS-05 钉其缺席）；断言本体
        // （播种写盘/复制体翻转/dms 形状/原件不动）逐字保留，选型来源改走段①显式腿，
        // reasoning_level=values.at(-1) 的 gQi 镜像语义经 levelOf 不变（impl-plan §9
        // FA-2「保留绿」意图=断言不改；驱动线为段③删除的必要连带，done 偏差声明备案）。
        const r = resultText(
          await sX.call("dispatch", { mission_id: "m-fa2", pack_path: faPack, persona_path: faPersona, model: "fa-provider/FA-Model" }),
        );
        const seedPath = r.model_seed && r.model_seed.config_path;
        let seedDoc = null;
        try {
          seedDoc = JSON.parse(fs.readFileSync(seedPath, "utf8"));
        } catch {
          seedDoc = null;
        }
        const sel = seedDoc && seedDoc.config && seedDoc.config.defaultModelSelection;
        const copiedRule = seedDoc && seedDoc.config.providerConfigRules.providerRules.find((x) => x.providerId === "fa-provider");
        const copiedModel = seedDoc.config.modelConfigRules.providerModelRules.find(
          (x) => x.providerId === "fa-provider" && x.modelId === "FA-Model",
        );
        ck.ok(
          "FA-2 播种写盘：model_seed.seeded=true + 使命戳副本存在 + 复制体 enabled 翻转；" +
            "模型自带 optionSpecs → dms={providerId,modelId,options.reasoningLevel=values.at(-1)}" +
            "（gQi 镜像）且不注 optionSpecs（注入即整份配置恢复空，FA bisect 实证）；真实配置字节级不动",
          r.ok === true && r.model_seed && r.model_seed.seeded === true &&
            r.model_seed.provider_id === "fa-provider" && r.model_seed.model_id === "FA-Model" &&
            r.model_seed.reasoning_level === "enabled" && seedDoc !== null &&
            JSON.stringify(sel) === JSON.stringify({ providerId: "fa-provider", modelId: "FA-Model", options: { reasoningLevel: "enabled" } }) &&
            copiedModel && copiedModel.config.enabled === true &&
            JSON.stringify(copiedModel.config.optionSpecs) === JSON.stringify({ reasoningLevel: { values: ["disabled", "enabled"] } }) &&
            fs.readFileSync(fakePersonal, "utf8") === personalOriginal,
          {
            model_seed: r.model_seed, sel, copiedEnabled: copiedModel && copiedModel.config && copiedModel.config.enabled,
            copiedSpecs: copiedModel && copiedModel.config && copiedModel.config.optionSpecs,
            personalIntact: fs.readFileSync(fakePersonal, "utf8") === personalOriginal,
          },
        );
      } finally {
        sX.close();
      }
    }

    // ---- FA-3 model 入参负例：不可用（非 api-key provider）→ seeded:false+reason，不静默换模 ----
    {
      const dir = path.join(faBase, "fa3");
      fs.mkdirSync(path.join(dir, "troot"), { recursive: true });
      fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
      const stub = path.join(dir, "stub.mjs");
      writeInstantStub(stub, "sess_fa3");
      const fakeBuiltin = path.join(dir, "zcode-builtin.json");
      fs.writeFileSync(fakeBuiltin, JSON.stringify({ schemaVersion: 1, revision: 1, config: { providerConfigRules: { templateRules: [], providerRules: [] }, modelConfigRules: {} } }, null, 2));
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
                    providerId: "fa-acct",
                    config: { access: { type: "zhipu-account", accountType: "bigmodel", mode: "individual-coding-plan" } },
                  },
                ],
              },
              modelConfigRules: { providerModelRules: [] },
            },
          },
          null,
          2,
        ),
      );
      const sX = startServer({
        root: path.join(dir, "troot"),
        cwd: path.join(dir, "troot"),
        env: {
          ZCODE_CLI_PATH: stub,
          ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: fakePersonal,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fakeBuiltin,
        },
      });
      try {
        await faUpsert(sX, "m-fa3");
        const r = resultText(
          await sX.call("dispatch", { mission_id: "m-fa3", pack_path: faPack, persona_path: faPersona, model: "fa-acct/GLM-X@low" }),
        );
        ck.ok(
          "FA-3 model 入参负例：显式 model 指向非 api-key provider → model_seed.seeded=false" +
            "(reason=model_arg_unusable) 且不静默回退别的模型（显式优先原则）",
          r.ok === true && r.model_seed && r.model_seed.seeded === false && r.model_seed.reason === "model_arg_unusable",
          { model_seed: r.model_seed },
        );
      } finally {
        sX.close();
      }
    }

    // ---- FA-4 秒死注入：桩 CLI exit 1 +「Select a model」stderr → ok:false+error+hint ----
    {
      const dir = path.join(faBase, "fa4");
      fs.mkdirSync(path.join(dir, "troot"), { recursive: true });
      fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
      const stub = path.join(dir, "stub.mjs");
      fs.writeFileSync(
        stub,
        [
          'process.stderr.write("Error: Select a model before sending a message (traceId: fa4-stub)\\n");',
          "process.exit(1);",
        ].join("\n") + "\n",
      );
      const sX = startServer({
        root: path.join(dir, "troot"),
        cwd: path.join(dir, "troot"),
        env: {
          ZCODE_CLI_PATH: stub,
          ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
          ORCH_DISPATCH_CAPTURE_MS: "1500",
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "",
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "",
        },
      });
      try {
        await faUpsert(sX, "m-fa4");
        const r = resultText(await sX.call("dispatch", { mission_id: "m-fa4", pack_path: faPack, persona_path: faPersona }));
        const relErr = String(r.error_path || "");
        const errorPath = path.isAbsolute(relErr) ? relErr : path.join(dir, "troot", relErr);
        let sidecarExists = false;
        try {
          sidecarExists = Boolean(errorPath && fs.statSync(errorPath).isFile());
        } catch {
          sidecarExists = false;
        }
        ck.ok(
          "FA-4 秒死显式化（R2 静默面消灭）：桩 CLI exit 1 → dispatch 返回 ok:false + " +
            "error 摘要含「Select a model」+ hint 人话指引（模型供给方向）+ error_path 指向侧车 + 无 session_pending",
          r.ok === false && /Select a model/.test(String(r.error)) &&
            String(r.hint).includes("模型") && r.session_pending === undefined && sidecarExists && r.exit_code === 1,
          { ok: r.ok, error: r.error, hint: r.hint, error_path: r.error_path, sidecarExists, exit_code: r.exit_code },
        );
      } finally {
        sX.close();
      }
    }

    // ---- FA-5 慢启动：桩 CLI 超捕获窗 → ok:true+session_pending（真慢启动契约保持）----
    {
      const dir = path.join(faBase, "fa5");
      fs.mkdirSync(path.join(dir, "troot"), { recursive: true });
      fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
      const stub = path.join(dir, "stub.mjs");
      fs.writeFileSync(
        stub,
        [
          'import fs from "node:fs";',
          'import path from "node:path";',
          'await new Promise((res) => setTimeout(res, 2200));',
          'const dir = process.env.ORCH_ROLLOUT_DIR || ".";',
          'fs.mkdirSync(dir, { recursive: true });',
          'fs.writeFileSync(path.join(dir, "model-io-sess_fa5.jsonl"), JSON.stringify({ t: 1 }) + "\\n");',
          'console.log(JSON.stringify({ type: "result", sessionId: "sess_fa5", response: "stub-slow", usage: {} }));',
        ].join("\n") + "\n",
      );
      const sX = startServer({
        root: path.join(dir, "troot"),
        cwd: path.join(dir, "troot"),
        env: {
          ZCODE_CLI_PATH: stub,
          ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
          ORCH_DISPATCH_CAPTURE_MS: "1200",
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "",
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "",
        },
      });
      try {
        await faUpsert(sX, "m-fa5");
        const r = resultText(await sX.call("dispatch", { mission_id: "m-fa5", pack_path: faPack, persona_path: faPersona }));
        ck.ok(
          "FA-5 慢启动契约保持：桩 CLI 超捕获窗（1.2s<2.2s）→ ok:true + session_pending:true（真慢启动场景）",
          r.ok === true && r.session_pending === true && r.session_id === undefined,
          { ok: r.ok, pending: r.session_pending, session_id: r.session_id },
        );
        await sleep(2400); // 桩退出窗，防 clean up 撞在跑的子进程（win32 句柄）
      } finally {
        sX.close();
      }
    }
  await sleep(0); // 事件落盘窗口兜底（与既有 suite 惯例一致）
}
