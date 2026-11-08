// @module sentinel-teardown/m91-scp-rev
/*!
 * suites/sentinel-teardown/m91-scp-rev.mjs —— v1.2 M9-1 SCP/REV 组（A-v0120-SCP/REV）：
 * SCP-a 他会话零开枪 / SCP-b 空值三段 / REV-③ 补告警 / REV-④ O10 协同 / REV-⑤⑦ 组包尾块
 * 缺席计数 / REV-⑥⑦ 触发面②端到端（stub CLI，零模型事务）
 * （自 sentinel-teardown.mjs 初步切分拆出，v1.3；断言本体逐字搬运零改动）
 */
import fs from "node:fs";
import path from "node:path";
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
      "SCP-b② 归因补齐自动恢复盯守：同 mission 转 owned 后照旧开枪（exit 1 wake failure alert + fired 落盘）",
      Boolean(rB91) && rB91.code === 1 && rB91.stdout.includes("wake failure alert") && firedNamesM("m-scp-b--unclaimed_terminal--").length >= 1,
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
      Boolean(rC91) && rC91.code === 1 && catchupN === 1 && echoC.includes("catch-up alerts: 1 escalations fell due while the sentinel was absent") && firedNamesM("m-rev-c--unclaimed_terminal--").length >= 1,
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

    // ---- REV-⑤：组包尾块缺席计数（无条件硬约束件）—— v1.6 W3a 退役+改写（C-04 对拍） ----
    // v1.1.1 W20→v1.5 W2-A：REV-⑤=BUILD-DISPATCH-PURE 纯区抽取直测（标记恰一+保序+恒在节断言）、
    // REV-⑤b=接线静态锁（dispatch 面 absent=dispatchScopingAbsentCount(missionId) 调用+定义同族）。
    // v1.6 W3a（m-20261104-053000-w16-3a，design §3.1 R1 连带②/§2.7）：REV-⑤ 退役——subject 随
    // mcp/tool-dispatch/dispatch-prompt.mjs 整文件退役消亡（BUILD-DISPATCH-PURE 标记区/纯区抽取面消失，
    // 消息面 scoping 恒在节随组装退役）；REV-⑤b 改写为迁移后双面形态——dispatchScopingAbsentCount
    // 谓词下行迁 server-board.mjs（板域谓词，恰一定义），消费换装=tool-pack buildStateSection STATE 节
    // scoping 行（context_pack 物化时点快照，design §2.7 推翻③）；触发面② ensureSentinelFamily() 保留
    // dispatch-core nested 分支（「无哨兵不派发」零迁）。台账 v1.6.0.md §W3a 逐腿沿革。
    {
      const srvSrc = familySource(PLUGIN_DIR, path.join("mcp", "tool-dispatch.mjs"), { lf: true });
      const boardSrc = familySource(PLUGIN_DIR, path.join("mcp", "server-board.mjs"), { lf: true });
      const packSrc = familySource(PLUGIN_DIR, path.join("mcp", "tool-pack.mjs"), { lf: true });
      ck.ok(
        "REV-⑤b 接线静态锁（v1.6 W3a 改写：谓词下行迁 server-board+消费换装 STATE 入包）：dispatchScopingAbsentCount 恰一定义在 server-board（板域谓词）∧ tool-pack buildStateSection 调用点在位（STATE 节 scoping 行，context_pack 物化）∧ 触发面② ensureSentinelFamily() 在 dispatch-core nested 分支在位（零迁）",
        (boardSrc.match(/function dispatchScopingAbsentCount\(/g) || []).length === 1 &&
          packSrc.includes("dispatchScopingAbsentCount(missionId)") &&
          packSrc.includes("[Sentinel scoping] watched missions missing dispatch attribution") &&
          srvSrc.includes("ensureSentinelFamily();"),
        { boardDef: (boardSrc.match(/function dispatchScopingAbsentCount\(/g) || []).length, packWired: packSrc.includes("dispatchScopingAbsentCount(missionId)"), face2: srvSrc.includes("ensureSentinelFamily();") },
      );
      ck.ok(
        "REV-⑤ 组装面退役反向腿（v1.6 W3a）：tool-dispatch 族内 BUILD-DISPATCH-PURE 标记对（BEGIN 注释形态）零残留 ∧ buildDispatchPrompt 活体定义零残留（纯区抽取面/组装纯区随 dispatch-prompt.mjs 整文件退役——残段即 R-1 静默残留红检；注释级 provenance 墓碑注记合法不涉）",
        srvSrc.includes("BUILD-DISPATCH-PURE-BEGIN") === false &&
          /function buildDispatchPrompt\(/.test(srvSrc) === false,
        { markLeft: srvSrc.includes("BUILD-DISPATCH-PURE-BEGIN"), fnLeft: /function buildDispatchPrompt\(/.test(srvSrc) },
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
        let promptCount91 = -1;
        try {
          promptCount91 = fs.readdirSync(logDir91).filter((n) => n.endsWith(".prompt")).length;
        } catch {
          /* no logs dir */
        }
        // v1.6 W3a：REV-⑦ 随 R1 组装退役（波首清点漏盘补报——C-04 文件级盘点口径，l-20261028-15c9e8
        //   同型第二犯如实记）：subject=审计 prompt 落盘文本含 scoping 恒在节——审计 prompt 落盘面随
        //   dispatch-prompt.mjs 整文件退役删除（R1），组装文本（恒在节）消失。改写为负向腿=dispatch
        //   编号出口零审计落盘（dispatch-logs 无新增 .prompt 件——新 .prompt 计数=0）；scoping 呈现面
        //   换装=STATE 节 scoping 行（context_pack 物化，tool-pack 承载——m91 REV-⑤b 改写腿+crv2-pack
        //   N2 行为腿对拍）。台账 v1.6.0.md §W3a 逐腿沿革。
        ck.ok(
          "REV-⑦ 审计落盘退役负向腿（v1.6 W3a 改写，原「prompt 落盘含 scoping 恒在节」随组装退役）：dispatch 编号出口零审计 prompt 落盘（dispatch-logs .prompt 新增计数=0——审计面=bg-gate 运行时 CONTRACT 头 presence 检测）",
          promptCount91 <= 0, // 目录缺席（-1）=更强负向形态，同绿
          { promptFiles: promptCount91 },
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
