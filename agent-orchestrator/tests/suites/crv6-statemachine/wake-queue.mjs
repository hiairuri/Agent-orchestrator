// @module crv6-statemachine/wake-queue
/*!
 * suites/crv6-statemachine/wake-queue.mjs —— v1.1.1 W-B 完成即唤队列断言
 *
 *   WB-SRV-a..g（server 生产者① headless 闸 + 队列形三钉 + lock-hold 量测；grill#wake
 *   Q1-Q5 裁定：闸=dispatch.mode==="headless" 零新字段；逐事件单文件 wx/毒丸跳过/
 *   认领残留含 acquired_at；lock-hold <2000ms=2s 锁预算）：
 *     a headless done → 事件恰一落（内容形状锁）；b 非 headless（agent/无 dispatch 键）
 *     done → 零事件；c headless mission 的 milestone → 零事件；d 毒丸容忍（坏件+坏认领
 *     在场生产面不受染）；e 认领残留可识别（acquired_at 可解析）；f 并发双写两事件两文件
 *     （wx 原子建）；g dispatch 同步段锁持时 <2000ms（lock_hold_ms 黑盒量测）。
 *   （v1.2.3 W1 竞态隔离：d/e 腿独立 server 实例 sWb2+独立根，主控扩授裁决 m-20261030-060549-56b4。）
 *
 * 拆分自 suites/crv6-statemachine.mjs（初步切分批次），断言本体逐字搬运零行为变更。
 */
import fs from "node:fs";
import path from "node:path";
import { startServer, PLUGIN_DIR } from "../../harness/jsonrpc-client.mjs";

export async function run(ctx) {
  const { ck, s, T, BASE, resultText, boardJson } = ctx;

  {
    const qdir = path.join(T, "context", "wake-queue");
    // v1.2.3 W1 竞态隔离（主控二次扩授裁决 m-20261030-060549-56b4）：d/e 腿（claim 态受控腿）
    // 改用独立 server 实例 sWb2+独立根——a 腿 detached wake-kick 绑旧根 T，其 acquireClaim
    // 超龄回收消费面（WAKE_CLAIM_STALE_MS=120s，v1.1.1 52c081b 引入）会在共享根上与
    // 「残留字节级原样」断言竞跑（基线 stash 3/3 同红实证；红率 9/10）。sWb2 根零 K 污染
    // （d/e 腿 claim 全程在场=生产者 EEXIST 静默零 spawn）；生产者 EEXIST 静默面照钉零
    // 弱化；a/b/c/f/g 腿留原实例（主控裁决）。根=BASE 下 wb2 子目录，收尾由 BASE.cleanup()
    // 统一清（既有惯例，零新清理面）。
    const wb2Root = path.join(BASE.root, "wb2-root");
    fs.mkdirSync(wb2Root, { recursive: true });
    const sWb2 = startServer({ root: wb2Root });
    const qdir2 = path.join(wb2Root, "context", "wake-queue");
    const qevents2 = () =>
      fs.existsSync(qdir2)
        ? fs.readdirSync(qdir2).filter((f) => f.endsWith(".json") && f !== "claim.json").sort()
        : [];
    const qread2 = (f) => JSON.parse(fs.readFileSync(path.join(qdir2, f), "utf8"));
    const qclaimText2 = () => {
      try {
        return fs.readFileSync(path.join(qdir2, "claim.json"), "utf8");
      } catch {
        return null;
      }
    };
    const seedHeadless2 = (id, sessionId) =>
      sWb2.call("board", {
        action: "upsert",
        mission: {
          id,
          title: "wb-" + id,
          status: "dispatched",
          dispatch: { mode: "headless", agent_id: null, task_id: null, session_id: sessionId },
        },
      });
    const doneReport2 = (id, worker = "gp-wb#1") =>
      sWb2.call("report", { mission_id: id, worker, kind: "done", summary: "wb 收口" });
    const qevents = () =>
      fs.existsSync(qdir)
        ? fs.readdirSync(qdir).filter((f) => f.endsWith(".json") && f !== "claim.json").sort()
        : [];
    const qread = (f) => JSON.parse(fs.readFileSync(path.join(qdir, f), "utf8"));
    const qclaimText = () => {
      try {
        return fs.readFileSync(path.join(qdir, "claim.json"), "utf8");
      } catch {
        return null;
      }
    };
    const upsertWb = (mission) => s.call("board", { action: "upsert", mission });
    const seedHeadless = (id, sessionId) =>
      upsertWb({
        id,
        title: "wb-" + id,
        status: "dispatched",
        dispatch: { mode: "headless", agent_id: null, task_id: null, session_id: sessionId },
      });
    const doneReport = (id, worker = "gp-wb#1") =>
      s.call("report", { mission_id: id, worker, kind: "done", summary: "wb 收口" });

    // ---- WB-SRV-a：headless done → 事件恰一落（内容形状锁）----
    await seedHeadless("m-wb-head", "sess_wb_head");
    const beforeA = qevents();
    const rdA = resultText(await doneReport("m-wb-head"));
    const freshA = qevents().filter((f) => !beforeA.includes(f));
    const evA = freshA.length === 1 ? qread(freshA[0]) : null;
    ck.ok(
      "WB-SRV-a headless done → wake-queue 事件恰一落：文件名 <ms>-<mission_id>.json（逐事件单文件形），" +
        "内容 {mission_id,worker,session_id(=dispatch.session_id),result_path(null=server 源),created_at ISO,source=server}；" +
        "认领文件 spawn 后已释放；板 status=done",
      rdA.ok === true && rdA.status === "done" &&
        freshA.length === 1 && /^\d+-m-wb-head\.json$/.test(freshA[0]) &&
        evA && evA.mission_id === "m-wb-head" && evA.worker === "gp-wb#1" &&
        evA.session_id === "sess_wb_head" && evA.result_path === null &&
        Number.isFinite(Date.parse(evA.created_at)) && evA.source === "server" &&
        qclaimText() === null &&
        boardJson().missions.find((m) => m.id === "m-wb-head").status === "done",
      { rd: { ok: rdA.ok, status: rdA.status }, fresh: freshA, ev: evA, claim: qclaimText() },
    );

    // ---- WB-SRV-b：非 headless done → 零事件（宿主托管形态有平台通知，防双唤噪声）----
    await upsertWb({
      id: "m-wb-agent",
      title: "wb-agent",
      status: "dispatched",
      dispatch: { mode: "agent", agent_id: "a-wb" },
    });
    await upsertWb({ id: "m-wb-nodisp", title: "wb-nodisp", status: "dispatched" });
    const beforeB = qevents();
    const rdB1 = resultText(await doneReport("m-wb-agent", "gp-wb#2"));
    const rdB2 = resultText(await doneReport("m-wb-nodisp", "gp-wb#3"));
    ck.ok(
      "WB-SRV-b 非 headless（mode=agent / 无 dispatch 键）done → 零事件落（闸面负例，grill#wake Q3 headless 标记判定）",
      rdB1.ok === true && rdB2.ok === true && qevents().length === beforeB.length,
      { before: beforeB.length, after: qevents().length },
    );

    // ---- WB-SRV-c：headless 但 kind≠done（milestone）→ 零事件 ----
    const beforeC = qevents();
    const rdC = resultText(
      await s.call("report", { mission_id: "m-wb-head", worker: "gp-wb#1", kind: "milestone", summary: "wb 里程碑" }),
    );
    ck.ok(
      "WB-SRV-c headless mission 的 milestone → 零事件落（done 分支闸，:4467 区域挂点语义）",
      rdC.ok === true && qevents().length === beforeC.length,
      { before: beforeC.length, after: qevents().length },
    );

    // ---- WB-SRV-d：毒丸容忍——坏事件文件+坏认领文件在场，生产面不受染（认领 EEXIST=静默
    //      跳过、claim 字节不动、新事件照落、report 主流程 ok）。
    //      v1.2.3 W1 竞态隔离（主控扩授裁决）：本腿起搬入 sWb2 隔离面（qdir2），断言主句与
    //      判据逐字保留（claim 态受控腿脱离旧根 K 消费面）。
    try {
      fs.mkdirSync(qdir2, { recursive: true });
      fs.writeFileSync(path.join(qdir2, "garbage.json"), "{corrupt 毒丸坏件");
      const poisonClaim = "{corrupt claim 毒丸";
      fs.writeFileSync(path.join(qdir2, "claim.json"), poisonClaim);
      await seedHeadless2("m-wb-poison", "sess_wb_poison");
      const beforeD = qevents2();
      const rdD = resultText(await doneReport2("m-wb-poison", "gp-wb#4"));
      const freshD = qevents2().filter((f) => !beforeD.includes(f));
      ck.ok(
        "WB-SRV-d 毒丸容忍（三钉之二）：坏件 garbage.json+坏 claim.json 在场 → 新事件照落恰一、" +
          "坏 claim 字节级不动（生产者不读既有内容只 wx 写自己文件=天然隔离）、report 主流程 ok 不受阻",
        rdD.ok === true && freshD.length === 1 && qread2(freshD[0]).mission_id === "m-wb-poison" &&
          qclaimText2() === poisonClaim,
        { fresh: freshD, claimIntact: qclaimText2() === poisonClaim, ok: rdD.ok },
      );

    // ---- WB-SRV-e：认领残留可识别——合法 claim.json（含 acquired_at）在场=他者持有中 →
    //      静默不夺不删不 spawn，残留原样保留（认领后 crash 的残留超龄回收=WB 波，本波钉可识别面）。
    //      v1.2.3 W1 竞态隔离（主控扩授裁决）：本腿在 sWb2 隔离面（qdir2）上运行——旧根 K 的
    //      超龄回收消费面不再与本断言竞跑；断言主句与判据逐字保留零弱化。
    const residueClaim =
      JSON.stringify({ acquired_at: new Date(Date.now() - 3600000).toISOString(), source: "test-residue" }, null, 2) + "\n";
    try {
      fs.unlinkSync(path.join(qdir2, "claim.json"));
    } catch { /* 前腿坏 claim 换合法残留 */ }
    fs.writeFileSync(path.join(qdir2, "claim.json"), residueClaim);
    await seedHeadless2("m-wb-residue", "sess_wb_residue");
    const rdE = resultText(await doneReport2("m-wb-residue", "gp-wb#5"));
    const claimAfter = qclaimText2();
    let residueFresh = false;
    try {
      residueFresh = Number.isFinite(Date.parse(JSON.parse(claimAfter).acquired_at));
    } catch { /* keep false */ }
    ck.ok(
      "WB-SRV-e 认领残留可识别（三钉之三）：他者 claim（含 acquired_at）在场 → 事件照落、" +
        "claim 字节级原样保留+acquired_at 可解析（残留识别面；超龄回收归 WB 波）、report ok",
      rdE.ok === true && claimAfter === residueClaim && residueFresh,
      { claimIntact: claimAfter === residueClaim, parseable: residueFresh },
    );
    } finally {
      sWb2.close();
    }

    // ---- WB-SRV-f：并发双写 → 两事件两文件（wx 原子建，禁共享单 jsonl 追加）----
    await seedHeadless("m-wb-c1", "sess_wb_c1");
    await seedHeadless("m-wb-c2", "sess_wb_c2");
    const beforeF = qevents();
    const [rf1, rf2] = await Promise.all([
      resultText(await doneReport("m-wb-c1", "gp-c1#1")),
      resultText(await doneReport("m-wb-c2", "gp-c2#1")),
    ]);
    const freshF = qevents().filter((f) => !beforeF.includes(f));
    const freshIds = freshF.map((f) => { try { return qread(f).mission_id; } catch { return null; } }).sort();
    ck.ok(
      "WB-SRV-f 并发双写 → 两事件两文件（每文件恰一 mission、逐事件 wx 独占创建、无共享追加形）",
      rf1.ok === true && rf2.ok === true && freshF.length === 2 &&
        JSON.stringify(freshIds) === JSON.stringify(["m-wb-c1", "m-wb-c2"]),
      {
        fresh: freshF, ids: freshIds,
        r1: { ok: rf1.ok, err: rf1.ok ? null : String(rf1._raw ?? rf1.error ?? "").slice(0, 160) },
        r2: { ok: rf2.ok, err: rf2.ok ? null : String(rf2._raw ?? rf2.error ?? "").slice(0, 160) },
      },
    );

    // ---- WB-SRV-g：dispatch 同步段锁持时 <2000ms（grill#wake Q5 lock-hold-time 断言；
    //      黑盒量测面=dispatch 响应 lock_hold_ms；stub CLI+隔离 rollout 零模型事务）----
    const lockBase = path.join(BASE.root, "wb-lock");
    const lockRoot = path.join(lockBase, "troot");
    const lockRollout = path.join(lockBase, "rollout");
    fs.mkdirSync(lockRoot, { recursive: true });
    fs.mkdirSync(lockRollout, { recursive: true });
    const lockStub = path.join(lockBase, "stub-cli.mjs");
    fs.writeFileSync(
      lockStub,
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        'const dir = process.env.ORCH_ROLLOUT_DIR || ".";',
        'fs.mkdirSync(dir, { recursive: true });',
        'fs.writeFileSync(path.join(dir, "model-io-sess_wb_lock.jsonl"), JSON.stringify({ t: 1 }) + "\\n");',
        'console.log(JSON.stringify({ type: "result", sessionId: "sess_wb_lock", response: "stub-ok", usage: {} }));',
      ].join("\n") + "\n",
    );
    const lockPack = path.join(lockBase, "pack.md");
    fs.writeFileSync(
      lockPack,
      "# 任务包：lock-hold 量测\n\n## CONTRACT（三行契约）\n\n[channel] m-wb-lock\n[worker] gp-lock#1\n[token] 0123456789abcdef0123456789abcdef\n\n## TASK\n量测 dispatch 同步段锁持时。\n",
    );
    const s2 = startServer({
      root: lockRoot,
      cwd: lockRoot,
      env: { ZCODE_CLI_PATH: lockStub, ORCH_ROLLOUT_DIR: lockRollout },
    });
    try {
      await s2.call("board", {
        action: "upsert",
        mission: {
          id: "m-wb-lock",
          title: "lock-hold 量测",
          status: "drafted",
          agent_type: "agent-orchestrator:orch-worker",
          scope_paths: ["src/"],
        },
      });
      const dr = resultText(
        await s2.call("dispatch", {
          mission_id: "m-wb-lock",
          pack_path: lockPack,
          persona_path: path.join(PLUGIN_DIR, "agents", "orch-worker.md"),
        }),
      );
      ck.ok(
        "WB-SRV-g dispatch 同步段（withRootLock 内 gates+board+spawn）持时 <2000ms（2s 锁预算；" +
          "响应 lock_hold_ms 黑盒量测；detached spawn 非阻塞构造性质=dispatch 出货先例）",
        dr.ok === true && Number.isFinite(dr.lock_hold_ms) && dr.lock_hold_ms >= 0 && dr.lock_hold_ms < 2000,
        { lock_hold_ms: dr.lock_hold_ms, ok: dr.ok, session_id: dr.session_id },
      );
    } finally {
      s2.close();
    }
  }
}
