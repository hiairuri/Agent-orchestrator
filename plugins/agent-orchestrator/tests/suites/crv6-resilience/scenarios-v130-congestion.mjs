// @module crv6-resilience/scenarios-v130-congestion
/*!
 * suites/crv6-resilience/scenarios-v130-congestion.mjs —— v1.3 W5 F-C8 播种拥塞
 * 运行时降级场景 CG（2026-11-01 新建，m-20261101-094222-64a2；impl-plan §2 W5 验收
 * 清单逐字十臂 A-v0130-W5-CG-01..10：分类正则三例〔1305/429/非模型错〕＋戳写/过期/
 * 跳过三态＋fallback 序〔首选在戳→次选命中〕＋全戳满→照旧+警示＋kill switch→零行为差
 * ＋零戳→零行为差回归基线。识别面三臂归 dispatch-supply DS-02〔臂 b 保绿〕/DS-08
 * 〔臂 c 保绿〕/DS-09〔臂 a 新增〕——M-1 主裁落位，本文件零涉识别面。）
 *
 * 拥塞戳=`<root>/sentinel/dispatch-congestion.json`（card-sentinel.md E1 登记）：
 * {providerId/modelId: untilMs}；TTL 默认 30min（ORCH_DISPATCH_CONGESTION_TTL_MIN）；
 * kill switch=ORCH_DISPATCH_CONGESTION_OFF。server 恒不创建 sentinel/ 目录（l0 V13
 * available 信号语义）——测试根显式预建该目录使写戳可观测（生产面由 bg-sentinel
 * 启动 mkdir＋dispatch 派发前 ensureSentinelFamily 保证在场）。
 *
 * 驱动形态：DSP 既有同法（startServer 黑盒＋即时桩 CLI；impl-plan §3 用例形态裁定
 * ——dispatchSeedModelConfig 闭包 root 致抽取不可行，黑盒零新模式引入）。失败腿桩=
 * console.error("Error: …")＋exit 1（runner 无信封 → error 侧车 log_tail 携错误行，
 * dispatchFailureSummary 白名单正则分类）；降级腿桩=成功信封（播种对经 model_seed
 * 回执直接观测，无需真死一次）。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, resultText, subRoot, startServer, PLUGIN_DIR } from "./fixtures.mjs";

export async function runV130CongestionScenarios() {
  const cgBase = subRoot("cg");
  const cgPack = path.join(cgBase, "pack.md");
  fs.writeFileSync(
    cgPack,
    "# 任务包：CG 断言组\n\n## CONTRACT（三行契约）\n\n[channel] m-cg-x\n[worker] gp-cg#1\n[token] cg token placeholder\n\n## TASK\n桩 CLI 黑盒。\n",
  );
  const cgPersona = path.join(PLUGIN_DIR, "agents", "orch-worker.md");
  /** 成功桩（同 dspStub 形）：写 model-io 标记 + result envelope。 */
  const cgStubOk = (file, sessionId) =>
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
  /** 失败桩：stderr 错误行 + exit 1（无信封 → error 侧车 log_tail 携该行）。 */
  const cgStubFail = (file, errLine) =>
    fs.writeFileSync(
      file,
      [`console.error(${JSON.stringify(errLine)});`, "process.exit(1);"].join("\n") + "\n",
    );
  const cgBuiltin = (dir) => {
    const p = path.join(dir, "zcode-builtin.json");
    fs.writeFileSync(
      p,
      JSON.stringify({ schemaVersion: 1, revision: 1, config: { providerConfigRules: { templateRules: [], providerRules: [] }, modelConfigRules: {} } }, null, 2),
    );
    return p;
  };
  /** 测试根：sentinel/ 显式预建（server 恒不创建该目录——l0 V13 语义，写戳可观测前提）。 */
  const cgRoot = (name) => {
    const dir = path.join(cgBase, name);
    fs.mkdirSync(path.join(dir, "troot", "sentinel"), { recursive: true });
    fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
    return dir;
  };
  const cgStart = (dir, extraEnv = {}) =>
    startServer({
      root: path.join(dir, "troot"),
      env: {
        ZCODE_CLI_PATH: path.join(dir, "stub.mjs"),
        ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(dir, "provider_config.json"),
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: cgBuiltin(dir),
        ...extraEnv,
      },
    });
  const cgUpsert = (sX, id) =>
    sX.call("board", {
      action: "upsert",
      mission: { id, title: id, status: "drafted", agent_type: "agent-orchestrator:orch-worker", scope_paths: ["src/"] },
    });
  /** 单 provider（p-a/M-A，api-key enabled）personal 配置——首选对确定的基形。 */
  const cgSimplePersonal = (dir) =>
    fs.writeFileSync(
      path.join(dir, "provider_config.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          config: {
            providerConfigRules: {
              providerRules: [
                { providerId: "p-a", config: { access: { type: "api-key", apiKey: "sk-a" }, modelOrder: ["M-A"] } },
              ],
            },
            modelConfigRules: {
              providerModelRules: [
                { modelId: "M-A", config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["a", "b"] } } }, providerId: "p-a" },
              ],
            },
          },
        },
        null,
        2,
      ),
    );
  /** 三 provider（序列 p-z→p-m→p-b）＋dms=p-b/M-B——fallback 序判别形：两源形态次选
   *  =dms 源（p-b），段③「api-key 序列下一位」（p-m）不复活。 */
  const cgThreePersonal = (dir) =>
    fs.writeFileSync(
      path.join(dir, "provider_config.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          config: {
            providerConfigRules: {
              providerRules: ["p-z", "p-m", "p-b"].map((pid) => ({
                providerId: pid,
                config: { access: { type: "api-key", apiKey: "sk-" + pid }, modelOrder: ["M-" + pid.slice(2).toUpperCase()] },
              })),
            },
            modelConfigRules: {
              providerModelRules: ["p-z", "p-m", "p-b"].map((pid, i) => ({
                modelId: "M-" + pid.slice(2).toUpperCase(),
                config: { enabled: true, optionSpecs: { reasoningLevel: { values: i === 2 ? ["lo", "hi"] : ["f", "s"] } } },
                providerId: pid,
              })),
            },
            defaultModelSelection: { providerId: "p-b", modelId: "M-B", options: { reasoningLevel: "lo" } },
          },
        },
        null,
        2,
      ),
    );
  const stampPathOf = (dir) => path.join(dir, "troot", "sentinel", "dispatch-congestion.json");
  const writeStamp = (dir, obj) => fs.writeFileSync(stampPathOf(dir), JSON.stringify(obj, null, 2) + "\n");
  const readStamp = (dir) => {
    try {
      return JSON.parse(fs.readFileSync(stampPathOf(dir), "utf8"));
    } catch {
      return null;
    }
  };
  const MIN = 60000;
  const noCongestionFields = (ms) =>
    ms.congestion_skipped === undefined && ms.downgraded_to === undefined && ms.congestion_skipped_all === undefined;

  // ---- CG-01（分类-1305）：拥塞码 1305 死亡 → ok:false＋hint 拥塞分支（含「已自动
  //      降级重选，重派即可」指引）----
  {
    const dir = cgRoot("cg1");
    cgSimplePersonal(dir);
    cgStubFail(path.join(dir, "stub.mjs"), "Error: 1305 upstream model congested, retry later");
    const sX = cgStart(dir);
    try {
      await cgUpsert(sX, "m-cg1");
      const r = resultText(await sX.call("dispatch", { mission_id: "m-cg1", pack_path: cgPack, persona_path: cgPersona, model: "p-a/M-A" }));
      ck.ok(
        "CG-01 分类-1305：拥塞死亡 → ok:false＋error 实名 1305＋hint 拥塞分支含「已自动降级重选，重派即可」指引",
        r.ok === false && String(r.error || "").includes("1305") && typeof r.hint === "string" &&
          r.hint.includes("模型拥塞") && r.hint.includes("已自动降级重选，重派即可"),
        { ok: r.ok, error: r.error, hint: r.hint },
      );
    } finally {
      sX.close();
    }
  }

  // ---- CG-02（分类-429）：429/rate limit 形态死亡 → 拥塞分支（白名单第二形态族；
  //      真实样本校准=m-20261027-182625-fb8d 侧车 responseStatus: 429 同族）----
  {
    const dir = cgRoot("cg2");
    cgSimplePersonal(dir);
    cgStubFail(path.join(dir, "stub.mjs"), "Error: 429 Too Many Requests (rate limit exceeded), please retry later");
    const sX = cgStart(dir);
    try {
      await cgUpsert(sX, "m-cg2");
      const r = resultText(await sX.call("dispatch", { mission_id: "m-cg2", pack_path: cgPack, persona_path: cgPersona, model: "p-a/M-A" }));
      ck.ok(
        "CG-02 分类-429：限流死亡 → ok:false＋hint 拥塞分支（429/rate limit 白名单形态族命中，与 1305 并列）",
        r.ok === false && String(r.error || "").includes("429") && typeof r.hint === "string" &&
          r.hint.includes("模型拥塞") && r.hint.includes("已将 p-a/M-A 写入拥塞戳"),
        { ok: r.ok, error: r.error, hint: r.hint },
      );
    } finally {
      sX.close();
    }
  }

  // ---- CG-03（分类-非模型错）：非模型错（ENOENT）死亡 → 通用提前退出分支＋零戳写
  //      （分类面白名单负例：非拥塞形态不误写戳）----
  {
    const dir = cgRoot("cg3");
    cgSimplePersonal(dir);
    cgStubFail(path.join(dir, "stub.mjs"), "Error: ENOENT: no such file or directory, open 'nonexistent.bin'");
    const sX = cgStart(dir);
    try {
      await cgUpsert(sX, "m-cg3");
      const r = resultText(await sX.call("dispatch", { mission_id: "m-cg3", pack_path: cgPack, persona_path: cgPersona, model: "p-a/M-A" }));
      ck.ok(
        "CG-03 分类-非模型错：ENOENT 死亡 → ok:false＋hint 走通用提前退出分支（无拥塞文案）＋拥塞戳零写入（白名单负例）",
        r.ok === false && typeof r.hint === "string" && r.hint.includes("CLI 提前退出") &&
          !r.hint.includes("模型拥塞") && readStamp(dir) === null,
        { ok: r.ok, hint: r.hint, stamp: readStamp(dir) },
      );
    } finally {
      sX.close();
    }
  }

  // ---- CG-04（戳写态）：拥塞失败 → 戳文件形状 {providerId/modelId: untilMs}＋TTL
  //      默认 30min 界（until-now ∈ [29min,31min]）----
  {
    const dir = cgRoot("cg4");
    cgSimplePersonal(dir);
    cgStubFail(path.join(dir, "stub.mjs"), "Error: 1305 congested");
    const sX = cgStart(dir);
    try {
      await cgUpsert(sX, "m-cg4");
      const r = resultText(await sX.call("dispatch", { mission_id: "m-cg4", pack_path: cgPack, persona_path: cgPersona, model: "p-a/M-A" }));
      const stamp = readStamp(dir);
      const until = stamp && Number(stamp["p-a/M-A"]);
      const drift = Number.isFinite(until) ? until - Date.now() : NaN;
      ck.ok(
        "CG-04 戳写态：拥塞失败 → 戳文件 {p-a/M-A: untilMs} 恰一键＋until 存活＋TTL 默认 30min 界（29-31min 窗）＋写戳对=本次播种对",
        r.ok === false && stamp !== null && Object.keys(stamp).length === 1 && Number.isFinite(until) &&
          until > Date.now() && drift >= 29 * MIN && drift <= 31 * MIN && r.model_seed &&
          r.model_seed.provider_id === "p-a" && r.model_seed.model_id === "M-A",
        { ok: r.ok, stamp, driftMin: Number.isFinite(drift) ? drift / MIN : drift },
      );
    } finally {
      sX.close();
    }
  }

  // ---- CG-05（戳过期态）：预写过期戳（untilMs 已过）→ 视为不在戳（首选照旧播种、
  //      零拥塞字段）＋过期条目读时懒清除（TTL 过期即删）----
  {
    const dir = cgRoot("cg5");
    cgSimplePersonal(dir);
    cgStubOk(path.join(dir, "stub.mjs"), "sess_cg5");
    writeStamp(dir, { "p-a/M-A": Date.now() - 1000 });
    const sX = cgStart(dir);
    try {
      await cgUpsert(sX, "m-cg5");
      const r = resultText(await sX.call("dispatch", { mission_id: "m-cg5", pack_path: cgPack, persona_path: cgPersona, model: "p-a/M-A" }));
      const stamp = readStamp(dir);
      ck.ok(
        "CG-05 戳过期态：过期 untilMs 视为不在戳 → 首选 p-a/M-A 照旧播种＋零拥塞字段＋过期条目读时懒清除（TTL 过期即删）",
        r.ok === true && r.session_id === "sess_cg5" && r.model_seed && r.model_seed.seeded === true &&
          r.model_seed.provider_id === "p-a" && r.model_seed.model_id === "M-A" &&
          noCongestionFields(r.model_seed) && stamp !== null && !("p-a/M-A" in stamp),
        { model_seed: r.model_seed, stamp },
      );
    } finally {
      sX.close();
    }
  }

  // ---- CG-06/CG-07（戳跳过态＋fallback 序，同跑双臂）：首选（显式 model p-z/M-Z）
  //      在戳 → 次选=dms 源 p-b/M-B 命中降级；序列下一位 p-m 不被选（段③形态不复活）
  //      ＋dms 原值直通＋种子 dms 保会话真值（fromDms 跳覆写）----
  {
    const dir = cgRoot("cg6");
    cgThreePersonal(dir);
    cgStubOk(path.join(dir, "stub.mjs"), "sess_cg6");
    writeStamp(dir, { "p-z/M-Z": Date.now() + 20 * MIN });
    const sX = cgStart(dir);
    try {
      await cgUpsert(sX, "m-cg6");
      const r = resultText(await sX.call("dispatch", { mission_id: "m-cg6", pack_path: cgPack, persona_path: cgPersona, model: "p-z/M-Z" }));
      const ms = r.model_seed || {};
      ck.ok(
        "CG-06 戳跳过态：首选 p-z/M-Z 在戳 → 降级播种 dms 源 p-b/M-B＋congestion_skipped=[首选]＋downgraded_to=次选（回执字段全透明）",
        r.ok === true && r.session_id === "sess_cg6" && ms.seeded === true && ms.provider_id === "p-b" &&
          ms.model_id === "M-B" && JSON.stringify(ms.congestion_skipped) === JSON.stringify(["p-z/M-Z"]) &&
          ms.downgraded_to === "p-b/M-B" && ms.congestion_skipped_all === undefined,
        { model_seed: ms },
      );
      let seedDms = null;
      try {
        seedDms = JSON.parse(fs.readFileSync(ms.config_path, "utf8")).config.defaultModelSelection;
      } catch {
        seedDms = null;
      }
      ck.ok(
        "CG-07 fallback 序=两源形态：次选=dms 源 p-b/M-B 而非 api-key 序列下一位 p-m/M-M（段③形态不复活实证）＋level=dms 原值 lo 直通＋种子 dms 会话真值不覆写（fromDms）",
        ms.provider_id === "p-b" && ms.reasoning_level === "lo" &&
          JSON.stringify(seedDms) === JSON.stringify({ providerId: "p-b", modelId: "M-B", options: { reasoningLevel: "lo" } }),
        { seeded: ms.provider_id + "/" + ms.model_id, seedDms },
      );
    } finally {
      sX.close();
    }
  }

  // ---- CG-08（全戳满→照旧+警示）：首选与次选两对全在戳 → 照旧首选播种＋
  //      congestion_skipped_all 警示字段（无 downgraded_to）----
  {
    const dir = cgRoot("cg7");
    cgThreePersonal(dir);
    cgStubOk(path.join(dir, "stub.mjs"), "sess_cg7");
    writeStamp(dir, { "p-z/M-Z": Date.now() + 20 * MIN, "p-b/M-B": Date.now() + 20 * MIN });
    const sX = cgStart(dir);
    try {
      await cgUpsert(sX, "m-cg7");
      const r = resultText(await sX.call("dispatch", { mission_id: "m-cg7", pack_path: cgPack, persona_path: cgPersona, model: "p-z/M-Z" }));
      const ms = r.model_seed || {};
      ck.ok(
        "CG-08 全戳满→照旧+警示：两源候选全在戳 → 照旧首选 p-z/M-Z 播种（spawn 照旧发生）＋congestion_skipped_all=true＋congestion_skipped=[首选,次选]＋无 downgraded_to",
        r.ok === true && r.session_id === "sess_cg7" && ms.seeded === true && ms.provider_id === "p-z" &&
          ms.model_id === "M-Z" && ms.congestion_skipped_all === true &&
          JSON.stringify(ms.congestion_skipped) === JSON.stringify(["p-z/M-Z", "p-b/M-B"]) &&
          ms.downgraded_to === undefined,
        { model_seed: ms },
      );
    } finally {
      sX.close();
    }
  }

  // ---- CG-09（kill switch→零行为差，双面）：ORCH_DISPATCH_CONGESTION_OFF=1 →
  //      跳选停用（在戳首选照旧播种＋零拥塞字段）＋写戳停用（拥塞失败后戳文件字节不变）----
  {
    const dir = cgRoot("cg8");
    cgSimplePersonal(dir);
    cgStubOk(path.join(dir, "stub.mjs"), "sess_cg9a");
    const failStub = path.join(dir, "stub-fail.mjs");
    cgStubFail(failStub, "Error: 1305 congested");
    writeStamp(dir, { "p-a/M-A": Date.now() + 20 * MIN });
    const stampBefore = fs.readFileSync(stampPathOf(dir), "utf8");
    // 第一腿：跳选停用——在戳首选照旧播种（成功桩）
    const sX = cgStart(dir, { ORCH_DISPATCH_CONGESTION_OFF: "1" });
    let r1;
    try {
      await cgUpsert(sX, "m-cg9a");
      r1 = resultText(await sX.call("dispatch", { mission_id: "m-cg9a", pack_path: cgPack, persona_path: cgPersona, model: "p-a/M-A" }));
    } finally {
      sX.close();
    }
    // 第二腿：写戳停用——拥塞失败后戳文件字节不变（换失败桩重启 server 面）
    const sY = startServer({
      root: path.join(dir, "troot"),
      env: {
        ZCODE_CLI_PATH: failStub,
        ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(dir, "provider_config.json"),
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: cgBuiltin(dir),
        ORCH_DISPATCH_CONGESTION_OFF: "1",
      },
    });
    let r2;
    try {
      await cgUpsert(sY, "m-cg9b");
      r2 = resultText(await sY.call("dispatch", { mission_id: "m-cg9b", pack_path: cgPack, persona_path: cgPersona, model: "p-a/M-A" }));
    } finally {
      sY.close();
    }
    const stampAfter = fs.readFileSync(stampPathOf(dir), "utf8");
    const ms1 = (r1 && r1.model_seed) || {};
    ck.ok(
      "CG-09 kill switch→零行为差（双面）：OFF=1 → 在戳首选照旧播种零拥塞字段（跳选停用，spawn 照旧）＋拥塞失败 hint 如实声明未写拥塞戳＋戳文件字节不变（写戳停用）",
      r1 && r1.ok === true && r1.session_id === "sess_cg9a" && ms1.seeded === true && ms1.provider_id === "p-a" &&
        noCongestionFields(ms1) && r2 && r2.ok === false && typeof r2.hint === "string" &&
        r2.hint.includes("kill switch") && r2.hint.includes("未写拥塞戳") && stampAfter === stampBefore,
      { model_seed: ms1, hint: r2 && r2.hint, stampUnchanged: stampAfter === stampBefore },
    );
  }

  // ---- CG-10（零戳→零行为差，回归基线）：无戳文件 → 首选照旧播种＋零拥塞字段＋
  //      成功路径零写戳（writer 只在拥塞失败面）----
  {
    const dir = cgRoot("cg9");
    cgSimplePersonal(dir);
    cgStubOk(path.join(dir, "stub.mjs"), "sess_cg10");
    const sX = cgStart(dir);
    try {
      await cgUpsert(sX, "m-cg10");
      const r = resultText(await sX.call("dispatch", { mission_id: "m-cg10", pack_path: cgPack, persona_path: cgPersona, model: "p-a/M-A" }));
      ck.ok(
        "CG-10 零戳→零行为差（回归基线）：无戳文件 → 首选 p-a/M-A 照旧播种＋零拥塞字段＋成功路径零写戳（writer 只在拥塞失败面）",
        r.ok === true && r.session_id === "sess_cg10" && r.model_seed && r.model_seed.seeded === true &&
          r.model_seed.provider_id === "p-a" && noCongestionFields(r.model_seed) && readStamp(dir) === null,
        { model_seed: r.model_seed, stamp: readStamp(dir) },
      );
    } finally {
      sX.close();
    }
  }
}
