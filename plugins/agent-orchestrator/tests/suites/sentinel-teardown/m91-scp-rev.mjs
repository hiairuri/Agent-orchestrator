// @module sentinel-teardown/m91-scp-rev
/*!
 * suites/sentinel-teardown/m91-scp-rev.mjs —— v1.2 M9-1 SCP/REV 组（A-v0120-SCP/REV）：
 * SCP-a 他会话零开枪 / SCP-b 空值三段 / REV-③ 补告警 / REV-④ O10 协同 / REV-⑤⑦ 组包尾块
 * 缺席计数 / REV-⑥⑦ 触发面②端到端（stub CLI，零模型事务）
 * （自 sentinel-teardown.mjs 初步切分拆出，v1.3；断言本体逐字搬运零改动）
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startServer } from "../../harness/jsonrpc-client.mjs";
import { familySource } from "../../harness/source-family.mjs";

export async function run(ctx) {
  const { ck, PLUGIN_DIR, BASE, ROOT, SENT_DIR, ECHO, SID, sleep, waitFor, readJson, readText, slotFile, writeAnchor, writeBoard, spawnSentinel } = ctx;

  /* ======== v1.2 M9-1 SCP/REV 组（A-v0120-SCP/REV；impl-plan §批2 M9-1 验收） ========
     SCP-a 他会话零开枪+静默留痕；SCP-b①b 空值三段（无归因零开枪+scoping-skipped 留痕
     +归因补齐自动恢复）；REV-③ 补告警（复活首扫集中补发恰一次）；REV-④ O10 协同
     （首扫以 board timeline 重派事件为活动锚，不误判双跑）；REV-⑤ 组包尾块缺席计数
     （pure 区直测+接线静态锁）；REV-⑥⑦ 触发面②端到端（dispatch 探活补员+计数实装）。 */
  {
    const rmSilent = (p) => {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    };
    const cleanAll = () => {
      for (const n of fs.readdirSync(SENT_DIR).filter((n) => /^instance-\d+\.json$/.test(n))) {
        fs.rmSync(path.join(SENT_DIR, n), { force: true });
      }
      rmSilent(path.join(SENT_DIR, "fired"));
      rmSilent(ECHO);
      rmSilent(path.join(SENT_DIR, "quarantine.json"));
    };
    const firedNamesM = (prefix) => {
      try {
        return fs.readdirSync(path.join(SENT_DIR, "fired")).filter((n) => n.startsWith(prefix));
      } catch {
        return [];
      }
    };
    const absMin = (min) => new Date(Date.now() - min * 60000).toISOString();

    // ---- SCP-a：他会话 mission 零开枪 + 静默留痕（MOD3a-QA 三枪全丢误报靶心）
    cleanAll();
    writeAnchor(SID);
    writeBoard([
      {
        id: "m-scp-a",
        title: "foreign-mission",
        status: "done",
        dispatch: { agent_id: "agent_scp_a", mode: "agent", session_id: "sess_other" },
        timeline: [],
        updated_at: absMin(10),
      },
    ]);
    const bgA91 = spawnSentinel({});
    const tracedA = await waitFor(() => readText(ECHO).includes("scoping-foreign"), 8000);
    await sleep(1500);
    ck.ok(
      "SCP-a 他会话 mission 零开枪+静默留痕：scoping-foreign 回声落盘 ∧ 零 fired ∧ 哨兵存活不退出（他会话完成态照常落板+spool，本哨兵不代开枪）",
      tracedA && firedNamesM("m-scp-a--").length === 0 && bgA91.proc.exitCode === null,
      { tracedA, fired: firedNamesM("m-scp-a--"), alive: bgA91.proc.exitCode === null, echo: readText(ECHO).slice(0, 160) },
    );
    bgA91.kill();
    await bgA91.done;

    // ---- SCP-b：空值三段——无归因零开枪 + scoping-skipped 留痕；归因补齐自动恢复盯守
    cleanAll();
    writeAnchor(SID);
    writeBoard([
      {
        id: "m-scp-b",
        title: "no-attribution",
        status: "done",
        dispatch: { agent_id: "agent_scp_b", mode: "agent" },
        timeline: [],
        updated_at: absMin(10),
      },
    ]);
    const bgB91 = spawnSentinel({});
    const tracedB = await waitFor(() => readText(ECHO).includes("scoping-skipped"), 8000);
    await sleep(1200);
    ck.ok(
      "SCP-b① 无归因 mission 零开枪+scoping-skipped 留痕（缺席回落硬约束=漏报可见，禁静默零开枪；组包尾块计数见 REV-⑤⑦）",
      tracedB && firedNamesM("m-scp-b--").length === 0 && bgB91.proc.exitCode === null,
      { tracedB, fired: firedNamesM("m-scp-b--"), alive: bgB91.proc.exitCode === null, echo: readText(ECHO).slice(0, 160) },
    );
    // 归因补齐（前向归因字段落盘）→ 每 tick 重判自动恢复盯守
    writeBoard([
      {
        id: "m-scp-b",
        title: "no-attribution",
        status: "done",
        dispatch: { agent_id: "agent_scp_b", mode: "agent", session_id: SID },
        timeline: [],
        updated_at: absMin(10),
      },
    ]);
    const rB91 = await Promise.race([bgB91.done, sleep(12000).then(() => null)]);
    ck.ok(
      "SCP-b② 归因补齐自动恢复盯守：同 mission 转 owned 后照旧开枪（exit 1 唤醒失败告警 + fired 落盘）",
      Boolean(rB91) && rB91.code === 1 && rB91.stdout.includes("唤醒失败告警") && firedNamesM("m-scp-b--unclaimed_terminal--").length >= 1,
      rB91 && { code: rB91.code, fired: firedNamesM("m-scp-b--") },
    );

    // ---- REV-③：复活补告警（团灭期错过的升级，复活首扫集中补发恰一次）
    cleanAll();
    writeAnchor(SID);
    writeBoard([
      {
        id: "m-rev-c",
        title: "missed-escalation",
        status: "done",
        dispatch: { agent_id: "agent_rev_c", mode: "agent", session_id: SID },
        timeline: [],
        updated_at: absMin(10),
      },
    ]);
    const bgC91 = spawnSentinel({});
    const rC91 = await Promise.race([bgC91.done, sleep(12000).then(() => null)]);
    const echoC = readText(ECHO);
    const catchupN = (echoC.match(/"category":"catchup"/g) || []).length;
    ck.ok(
      "REV-③ 补告警：复活首扫对缺位期已到期升级集中补告警恰一次（echo catchup ×1 + 计数文案）且正常开枪路径照旧（exit 1 + fired）",
      Boolean(rC91) && rC91.code === 1 && catchupN === 1 && echoC.includes("补告警：哨兵缺位期间到期升级 1 件") && firedNamesM("m-rev-c--unclaimed_terminal--").length >= 1,
      { code: rC91 && rC91.code, catchupN, echo: echoC.slice(0, 200) },
    );

    // ---- REV-④：O10 协同——复活首扫以 board timeline 重派事件为活动锚，不误判双跑
    // 判别器设计：updated_at=90min 前（陈旧）、timeline 末位=2min 前重派 upsert 事件。
    // stall grace 缺省 30min：正确实现（锚=timeline 2min）未熟不开枪；若实现误用
    // updated_at（90min）→ matured 且 escaped（≥2×grace）必开枪 → 本断言即红。
    cleanAll();
    writeAnchor(SID);
    writeBoard([
      {
        id: "m-rev-d",
        title: "redispatched",
        status: "running",
        dispatch: { agent_id: "agent_rev_d", mode: "agent", session_id: SID },
        updated_at: absMin(90),
        timeline: [{ at: absMin(2), event: "upsert", summary: "busy 闸超龄豁免放行重派" }],
      },
    ]);
    const bgD91 = spawnSentinel({});
    await sleep(5000);
    ck.ok(
      "REV-④ O10 协同回归：复活首扫以 board timeline 重派事件为活动锚（2min 前 upsert）——已豁免重派在飞 mission 不误判失联/双跑（零 fired、存活）",
      bgD91.proc.exitCode === null && firedNamesM("m-rev-d--").length === 0,
      { alive: bgD91.proc.exitCode === null, fired: firedNamesM("m-rev-d--") },
    );
    bgD91.kill();
    await bgD91.done;

    // ---- REV-⑤：组包尾块缺席计数（无条件硬约束件）——pure 区抽取直测 + 接线静态锁
    {
      // v1.5 W2-A 重基（T7 裁 a 二拆）：读取面=tool-dispatch 族拼接（薄入口+三模块——BUILD-DISPATCH-PURE
      // 标记区随段迁 mcp/tool-dispatch/dispatch-prompt.mjs 原样保留，族拼接内标记恰一且 BEGIN<END 保序；
      // REV-⑤b 接线钉随主流程下沉 dispatch-core=同源读面），提取方式（标记区→临时 lib 注入 export→
      // 直测 pure 区）与断言期望值零改动。
      const srvSrc = familySource(PLUGIN_DIR, path.join("mcp", "tool-dispatch.mjs"), { lf: true });
      const beginMark = "/* BUILD-DISPATCH-PURE-BEGIN";
      const endMark = "/* BUILD-DISPATCH-PURE-END */";
      const i91 = srvSrc.indexOf(beginMark);
      const j91 = srvSrc.indexOf(endMark);
      let pure91 = null;
      if (i91 >= 0 && j91 > i91) {
        const dir91 = path.join(BASE.root, "m91-pure");
        fs.mkdirSync(dir91, { recursive: true });
        const file91 = path.join(dir91, "pure.mjs");
        fs.writeFileSync(file91, srvSrc.slice(i91, j91 + endMark.length) + "\nexport { buildDispatchPrompt };\n");
        pure91 = await import(pathToFileURL(file91).href + "?v=" + Date.now());
      }
      const mkPack91 = (mid) =>
        [
          `# 任务包：T（${mid}）`,
          "",
          "## CONTRACT（三行契约，也出现在派发 prompt 尾块）",
          `[channel] ${mid}`,
          "[worker] w",
          "[token] 0123456789abcdef0123456789abcdef",
          "",
          "## TASK",
          "- x",
        ].join("\n");
      const mkM91 = (id) => ({ id, pack: { path: `packs/${id}/pack.md` } });
      const built2 = pure91 ? pure91.buildDispatchPrompt(mkM91("mT"), mkPack91("mT"), "", "", null, { absent: 2 }) : null;
      const built0 = pure91 ? pure91.buildDispatchPrompt(mkM91("mT"), mkPack91("mT"), "", "", null) : null;
      const tail91 = built2 && built2.ok ? built2.text.slice(built2.text.indexOf("先 Read 任务包")) : "";
      ck.ok(
        "REV-⑤ 组包尾块缺席计数（无条件）：scoping.absent=2 → 恒在节『…：2 件』；缺省参 → 『…：0 件』；尾块形制保持（指针句→三行 CONTRACT 收尾，W4-PREFIX-02 形制不破）",
        Boolean(built2 && built2.ok && built0 && built0.ok) &&
          built2.text.includes("【哨兵 scoping】归因缺席在盯 mission：2 件") &&
          built0.text.includes("【哨兵 scoping】归因缺席在盯 mission：0 件") &&
          /^先 Read 任务包 [^\n]+\n\[channel\] mT\n\[worker\] w\n\[token\] [0-9a-f]{32}$/.test(tail91),
        { ok2: built2 && built2.ok, ok0: built0 && built0.ok, tail: tail91.slice(0, 80) },
      );
      ck.ok(
        "REV-⑤b 接线静态锁：dispatch 面 buildDispatchPrompt 调用携 absent=dispatchScopingAbsentCount(missionId)；触发面② ensureSentinelFamily() 在同步段在位",
        srvSrc.includes("dispatchScopingAbsentCount(missionId)") && srvSrc.includes("ensureSentinelFamily();") && srvSrc.includes("function dispatchScopingAbsentCount("),
        { wired: srvSrc.includes("dispatchScopingAbsentCount(missionId)"), face2: srvSrc.includes("ensureSentinelFamily();") },
      );
    }

    // ---- REV-⑥⑦：触发面② 端到端（server dispatch 探活补员）+ 尾块计数实装（stub CLI，零模型事务）
    {
      const stubDir91 = path.join(BASE.root, "m91-stub");
      const stubCli91 = path.join(stubDir91, "stub-cli.mjs");
      const rollout91 = path.join(stubDir91, "rollout");
      fs.mkdirSync(rollout91, { recursive: true });
      fs.writeFileSync(
        stubCli91,
        [
          'import fs from "node:fs";',
          'import path from "node:path";',
          'const dir = process.env.ORCH_ROLLOUT_DIR || ".";',
          'fs.mkdirSync(dir, { recursive: true });',
          'fs.writeFileSync(path.join(dir, "model-io-sess_m91-stub.jsonl"), JSON.stringify({ t: 1 }) + "\\n");',
          'console.log(JSON.stringify({ type: "result", sessionId: "sess_m91-stub", traceId: "tr", turnId: "tu", response: "stub-ok", usage: { inputTokens: 1 }, projection: { status: "idle", turnCount: 1 } }));',
        ].join("\n") + "\n",
      );
      cleanAll();
      writeAnchor(SID);
      // v1.2.3 W2（主控裁决授权，仅 env 适配零断言改动）：显式 fake provider 对隔离环境泄漏
      // （harness env 合并 process.env，宿主真配置无可用 dms）——段③「首 api-key 回落」删除后
      // 无 model= 的 e2e dispatch 落 selection_missing 拒绝不 spawn（DS-05 同语义，设计内）；
      // 本套件 REV-⑥⑦ 本意测探活补员/尾块计数非种子失败，补有效 dms 腿恢复 spawn 照旧。
      const seedFixDir91 = path.join(BASE.root, "m91-seed-fixture");
      fs.mkdirSync(seedFixDir91, { recursive: true });
      const seedFakePersonal91 = path.join(seedFixDir91, "provider_config.json");
      fs.writeFileSync(
        seedFakePersonal91,
        JSON.stringify(
          {
            schemaVersion: 1,
            config: {
              providerConfigRules: {
                templateRules: [],
                providerRules: [
                  { providerId: "p-m91", config: { access: { type: "api-key", apiKey: "sk-m91" }, modelOrder: ["M-M91"] } },
                ],
              },
              modelConfigRules: {
                providerModelRules: [
                  { modelId: "M-M91", config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["fast", "slow"] } } }, providerId: "p-m91" },
                ],
              },
              defaultModelSelection: { providerId: "p-m91", modelId: "M-M91", options: { reasoningLevel: "fast" } },
            },
          },
          null,
          2,
        ),
      );
      const seedFakeBuiltin91 = path.join(seedFixDir91, "zcode-builtin.json");
      fs.writeFileSync(seedFakeBuiltin91, JSON.stringify({ schemaVersion: 1, revision: 1, config: { providerConfigRules: { templateRules: [], providerRules: [] }, modelConfigRules: {} } }, null, 2));
      const s91 = startServer({
        root: ROOT,
        env: {
          ZCODE_CLI_PATH: stubCli91,
          ORCH_ROLLOUT_DIR: rollout91,
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: seedFakePersonal91,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: seedFakeBuiltin91,
        },
      });
      try {
        // 预置无归因在飞 mission（watchable：running+agent_id）→ 尾块缺席计数=1。
        // 直写 board（外部 upsert 新建 mission 状态门 drafted→running 拒绝，SM 状态机语义）；
        // server 每操作 loadBoard 读盘，后续 context_pack 落盘时本 mission 随存。
        writeBoard([
          {
            id: "m-absent-e2e",
            title: "absent-inflight",
            status: "running",
            dispatch: { agent_id: "agent_absent", mode: "agent" },
          },
        ]);
        await s91.call("context_pack", {
          mission_id: "m-e2e-m91",
          title: "M9-1 触发面② e2e",
          task: "探活补员端到端验证",
          scope_paths: ["src/"],
          worker_name: "orch-worker#1",
          persona_path: path.join(PLUGIN_DIR, "agents", "orch-worker.md"),
        });
        await s91.call("board", {
          action: "upsert",
          mission: { id: "m-e2e-m91", title: "M9-1 触发面② e2e", status: "drafted", agent_type: "agent-orchestrator:orch-worker" },
        });
        const dr91 = await s91.call("dispatch", { mission_id: "m-e2e-m91" });
        const dj91 = dr91.json || {};
        const slotIn = await waitFor(() => fs.existsSync(slotFile(0)), 12000);
        ck.ok(
          "REV-⑥ 触发面② 派发前探活补员（端到端）：dispatch 同步段家族全灭 → 拉起哨兵（instance 槽位出现）∧ 派发回执正常",
          slotIn && dj91.ok === true && dj91.mission_id === "m-e2e-m91",
          { slotIn, ok: dj91.ok, err: dj91.error, slots: [0, 1, 2].map((k) => Boolean(readJson(slotFile(k)))) },
        );
        const logDir91 = path.join(ROOT, "context", "dispatch-logs");
        let promptTxt91 = "";
        try {
          const prompts = fs.readdirSync(logDir91).filter((n) => n.endsWith(".prompt"));
          if (prompts.length) promptTxt91 = readText(path.join(logDir91, prompts[prompts.length - 1]));
        } catch {
          /* no logs */
        }
        ck.ok(
          "REV-⑦ 组包尾块计数实装（端到端）：prompt 落盘含恒在节『【哨兵 scoping】…：1 件』（预置无归因在飞 1 件；自 mission 有锚不计）",
          promptTxt91.includes("【哨兵 scoping】归因缺席在盯 mission：1 件"),
          { has: promptTxt91.includes("【哨兵 scoping】"), promptLen: promptTxt91.length },
        );
      } finally {
        try {
          s91.close();
        } catch {
          /* best effort */
        }
        // 收尸触发面②拉起的哨兵（读槽位 pid 击杀；家族缺省 3）
        for (let k = 0; k < 5; k++) {
          const doc = readJson(slotFile(k));
          if (doc && Number.isFinite(doc.pid)) {
            try {
              process.kill(doc.pid);
            } catch {
              /* already gone */
            }
          }
        }
        await sleep(500);
      }
    }

    // 卫生：SCP/REV 组后清场（不污染后续/收尾态）
    cleanAll();
    rmSilent(path.join(ROOT, "sentinel.cfg.json"));
    rmSilent(path.join(SENT_DIR, "coord-session.txt"));
  }
}
