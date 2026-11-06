// @module suites/watcher-core/wake-kick
/*!
 * watcher-core/wake-kick.mjs —— 完成即唤消费面：W3-RIDER bg-sentinel coord-session 消费面
 * 同型守卫（源码静态锚）+ unhandledRejection fail-loud 面（已知潜伏孤儿放行留痕）+
 * WB-KICK wake-kick 消费逻辑 + WB-SENT 哨兵 drain（滞留消费黑盒）。
 * 拆分自 suites/watcher-core.mjs；断言本体零改动；unhandledRejection 处理器注册时序
 * 保持原位（前置各组完成后、WB-KICK 组开跑前——run() 入口处注册）。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, grp } from "./shared.mjs";
import { MockRelay } from "./mock-relay.mjs";
import { PLUGIN_DIR } from "../../harness/jsonrpc-client.mjs";
import { familySource } from "../../harness/source-family.mjs";
import { runNode, captureBackground } from "../../harness/capture.mjs";
import { runKick, scanQueue, WAKE_BATCH_MAX } from "../../../hooks/wake-kick.mjs";
import { shellCompliant } from "../../../watcher/inject.mjs";

export async function run(ctx) {
  const { BASE } = ctx;

  /* ======== v1.1 W3 rider：bg-sentinel coord-session 消费面同型守卫（源码静态锚） ======== */
  {
    // v1.3 切分重基（修复轮 C）：读取面走族 helper（薄入口+模块族拼接——coordSessionId/
    // coordBusy 定义对已迁 hooks/bg-sentinel/signals.mjs，族拼接内模块序不变），断言与期望值零改动。
    const sentinelSrc = familySource(PLUGIN_DIR, path.join("hooks", "bg-sentinel.mjs"));
    const fnSrc = sentinelSrc.slice(sentinelSrc.indexOf("function coordSessionId"), sentinelSrc.indexOf("function coordBusy"));
    ck.ok("W3-RIDER bg-sentinel coord-session 消费面前置形状守卫（sess_subagent→忽略锚+stderr 定因；与 W2 inject/session-start 同语义、不引共享模块）",
      fnSrc.includes('v.startsWith("sess_subagent")') && fnSrc.includes("已忽略该锚") && fnSrc.includes("[bg-sentinel]"),
      { hasFn: fnSrc.length > 0 });
  }

  /* ======== v1.1.1 W-B 二波：wake-kick 消费逻辑（WB-KICK）+ 哨兵 drain（WB-SENT） ======== */
  /* 已知潜伏面（上游 relay.mjs，本波 scope 外）：RelaySession.request() 先建 #awaitMatch
   * promise 再 this.send()——send 于已关闭 transport 抛出时（E2E-7 close4011 面：4011
   * close 落在 respP awaitData 与 openBridge list 之间）该 promise 被遗弃，10s 超时拒绝
   * 无人消费=unhandledRejection。基线 suite 依赖 process.exit 先于计时器触发从未暴露；
   * WB-SENT 组延长运行期后浮出（strict 模式杀套件）。修复归属 relay.mjs（上游车，本波
   * 上报主控复核）；此处对已知签名告警放行留痕，其余拒绝保持 fail-loud（exit 2）。 */
  const KNOWN_ORPHAN_SIG = "relay-request-timeout:workspace-list-response";
  process.on("unhandledRejection", (e) => {
    if (String((e && e.message) || "").includes(KNOWN_ORPHAN_SIG)) {
      process.stderr.write("[known-latent-leak] relay.mjs request() 孤儿 promise（send-on-closed 遗弃；上游修复归 relay.mjs，v1.1.1 WB 波上报）\n");
      return;
    }
    process.stderr.write("[unhandledRejection fail-loud] " + String((e && e.stack) || e) + "\n");
    process.exit(2);
  });
  {
    grp("WB-KICK wake-kick-consumer");
    const ANCHOR = "sess_wb0123456789-test-anchor"; // 真实锚形状（sess_ 前缀；watcher-core 既有 mock id sess-coord-test 不满足 kick 形状闸，本组用真实形）
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, timeoutMs, step = 120) => {
      const t0 = Date.now();
      for (;;) {
        if (fn()) return true;
        if (Date.now() - t0 > timeoutMs) return false;
        await sleepMs(step);
      }
    };
    const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
    const qdirOf = (root) => path.join(root, "context", "wake-queue");
    const qeventsOf = (root) => {
      try { return fs.readdirSync(qdirOf(root)).filter((n) => n.endsWith(".json") && n !== "claim.json").sort(); } catch { return []; }
    };
    const writeQ = (root, missionId, offsetMs = 0) => {
      fs.mkdirSync(qdirOf(root), { recursive: true });
      fs.writeFileSync(
        path.join(qdirOf(root), `${String(1700000000000 + offsetMs)}-${missionId}.json`),
        JSON.stringify({ mission_id: missionId, worker: "gp-wb#1", session_id: null, result_path: null, created_at: new Date().toISOString(), source: "server" }) + "\n",
      );
    };
    /** kick 测试根：锚成对（真实 sess_ 形状 id/ws-1，MockRelay 缺省工作区命中）+ 新鲜 rollout 桩。 */
    const mkKickRoot = (name, { anchor = ANCHOR, workspace = "ws-1" } = {}) => {
      const root = path.join(BASE.root, "wb-kick", name);
      fs.mkdirSync(path.join(root, "sentinel"), { recursive: true });
      if (anchor !== null) fs.writeFileSync(path.join(root, "sentinel", "coord-session.txt"), anchor + "\n");
      if (workspace !== null) fs.writeFileSync(path.join(root, "sentinel", "coord-workspace.txt"), workspace + "\n");
      const rolloutDir = path.join(root, "rollout");
      fs.mkdirSync(rolloutDir, { recursive: true });
      const rf = path.join(rolloutDir, `model-io-${anchor === null ? ANCHOR : anchor}.jsonl`);
      fs.writeFileSync(rf, JSON.stringify({ t: 1 }) + "\n");
      fs.utimesSync(rf, new Date(), new Date()); // mtime=now：活性闸通过
      return { root, rolloutDir };
    };
    const kickDeps = (relay) => ({
      transportFactory: relay.transportFactory,
      jwtLoader: () => ({ ok: true, jwt: "mock.header.payload" }),
      deviceLoader: async () => ({ ok: true, deviceSid: "sid-mock", deviceMid: "mid-mock" }),
      // 签发面 mock（buildWatcher 同款）：createWatcher 内 issueTerminalToken/device 发现走
      // fetchImpl || globalThis.fetch，漏注入即打套件零触网 stub（sign-network 假败）。
      fetchImpl: async () => ({
        status: 200,
        text: async () => JSON.stringify({ code: 0, msg: "", data: { token: "A".repeat(21) + "g", expires_in: 60 } }),
      }),
      sleepFn: async () => {},
    });
    const shellTextOf = (relay) => {
      const dec = relay.captured.find((c) => c.header && c.header[3] === "sendConversationCommandV4");
      const args = dec && Array.isArray(dec.body) && dec.body.length === 1 ? dec.body[0] : null;
      return { dec, env: args && args.envelope ? args.envelope : null, text: args && args.envelope ? String(args.envelope.payload.text) : "" };
    };

    // ---- WB-KICK-a：3 事件 → 恰一次合并注入 → 队列清空；锚字节零改写 ----
    {
      const { root, rolloutDir } = mkKickRoot("kb-a");
      writeQ(root, "m-kb1", 0);
      writeQ(root, "m-kb2", 1000);
      writeQ(root, "m-kb3", 2000); // 最新=签名 mission
      fs.mkdirSync(path.join(root, "spool", "m-kb3", "unread"), { recursive: true });
      fs.writeFileSync(path.join(root, "spool", "m-kb3", "unread", "000000000000001-abcdef12.json"), "{}\n");
      const anchorPath = path.join(root, "sentinel", "coord-session.txt");
      const anchorBefore = fs.readFileSync(anchorPath);
      const relay = new MockRelay();
      const r = await runKick({ rootDir: root, argv: ["--rollout-dir", rolloutDir], watcherDeps: kickDeps(relay), err: () => {} });
      const sh = shellTextOf(relay);
      const cmds = relay.captured.filter((c) => c.header && c.header[3] === "sendConversationCommandV4");
      ck.ok("WB-KICK-a1 3 事件→恰一次注入合并：单一 conversation 命令帧；壳=最新事件签名 mission（m-kb3 state=done）+计数行「+2 more pending - see the board」+真实 spool 指针；注入目标=锚会话；壳合规（单行/≤1000/指针形）",
        r.action === "drained" && cmds.length === 1 && sh.env && sh.env.sessionId === ANCHOR &&
        sh.text.startsWith("[orch-watch] mission=m-kb3 state=done") && sh.text.includes("+2 more pending - see the board") &&
        sh.text.includes("spool/m-kb3/unread/000000000000001-abcdef12.json（路径指针，非正文）") && shellCompliant(sh.text),
        { r, cmds: cmds.length, text: sh.text.slice(0, 160) });
      ck.ok("WB-KICK-a2 成功面清队+认领释放+锚零改写：3 事件文件全移除（队列零 .json 事件）、claim.json 不在（kick 释自己的认领）、coord-session.txt 字节不变（b1 happy 无 b2 无刷新）",
        qeventsOf(root).length === 0 && r.drained === 3 && r.kept === 0 && readText(path.join(qdirOf(root), "claim.json")) === null &&
        Buffer.compare(fs.readFileSync(anchorPath), anchorBefore) === 0,
        { left: qeventsOf(root), drained: r.drained, anchorSame: Buffer.compare(fs.readFileSync(anchorPath), anchorBefore) === 0 });
    }

    // ---- WB-KICK-b：毒丸跳过（quarantine 隔离）不阻前后 ----
    {
      const { root, rolloutDir } = mkKickRoot("kb-b");
      writeQ(root, "m-kb-ok1", 0);
      fs.mkdirSync(qdirOf(root), { recursive: true });
      fs.writeFileSync(path.join(qdirOf(root), "garbage1.json"), "{corrupt 毒丸坏件");
      fs.writeFileSync(path.join(qdirOf(root), "garbage2.json"), JSON.stringify({ worker: "no-mission-id" }) + "\n");
      writeQ(root, "m-kb-ok2", 5000);
      const relay = new MockRelay();
      const r = await runKick({ rootDir: root, argv: ["--rollout-dir", rolloutDir], watcherDeps: kickDeps(relay), err: () => {} });
      const quar = (() => { try { return fs.readdirSync(path.join(qdirOf(root), "quarantine")).sort(); } catch { return []; } })();
      ck.ok("WB-KICK-b1 毒丸跳过（bg-sentinel quarantine 先例同型）：坏 JSON+缺 mission_id 两形 → 移入 quarantine/<名>.bad（不再被每轮重解析）、好事件两件照常 drain（不阻前后）、kick 不炸",
        r.action === "drained" && r.drained === 2 && quar.join(",") === "garbage1.json.bad,garbage2.json.bad" && qeventsOf(root).length === 0,
        { r, quar });
    }

    // ---- WB-KICK-c：锚活性双闸 + refire gap 抑制 ----
    {
      // c1 锚缺失
      const a = mkKickRoot("kb-c1", { anchor: null, workspace: "ws-1" });
      writeQ(a.root, "m-kb-c1", 0);
      const relayA = new MockRelay();
      const ra = await runKick({ rootDir: a.root, argv: ["--rollout-dir", a.rolloutDir], watcherDeps: kickDeps(relayA), err: () => {} });
      const marksA = (() => { try { return fs.readdirSync(path.join(a.root, "sentinel", "wake-kick-alerts")).filter((n) => n.endsWith(".json")); } catch { return []; } })();
      ck.ok("WB-KICK-c1 形状/活性闸前桩·锚缺失：coord-session 缺失 → 不注入（零建连）、事件留队、refire gap 告警标记落地（sentinel/wake-kick-alerts/alert--anchor-missing--*）",
        ra.action === "anchor-gate" && ra.outcome === "anchor-missing" && ra.kept === 1 && relayA.connCount === 0 && marksA.length === 1 && marksA[0].includes("anchor-missing"),
        { ra, marks: marksA });
      // c2 形状闸：子代理前缀 + 非 sess_ 前缀
      const b = mkKickRoot("kb-c2", { anchor: "sess_subagent_agent_21d1cb0e" });
      writeQ(b.root, "m-kb-c2", 0);
      const relayB = new MockRelay();
      const rb = await runKick({ rootDir: b.root, argv: ["--rollout-dir", b.rolloutDir], watcherDeps: kickDeps(relayB), err: () => {} });
      const c2b = mkKickRoot("kb-c2b", { anchor: "worker-not-a-session" });
      writeQ(c2b.root, "m-kb-c2b", 0);
      const rc2b = await runKick({ rootDir: c2b.root, argv: ["--rollout-dir", c2b.rolloutDir], watcherDeps: kickDeps(new MockRelay()), err: () => {} });
      ck.ok("WB-KICK-c2 形状闸：sess_subagent 前缀（EXP10 R6 锚劫持形态）与非 sess_ 前缀 → anchor-shape 拒注入、事件留队（宁可不唤醒不进子代理短寿命会话）",
        rb.action === "anchor-gate" && rb.outcome === "anchor-shape" && rb.kept === 1 && relayB.connCount === 0 &&
        rc2b.outcome === "anchor-shape" && rc2b.kept === 1,
        { rb, rc2b });
      // c3 活性闸：rollout 缺失 + mtime 超 10min
      const c = mkKickRoot("kb-c3");
      writeQ(c.root, "m-kb-c3", 0);
      const rc = await runKick({ rootDir: c.root, argv: [], watcherDeps: kickDeps(new MockRelay()), err: () => {} }); // 无 --rollout-dir → 缺省目录无此会话文件
      const stale = mkKickRoot("kb-c3s");
      writeQ(stale.root, "m-kb-c3s", 0);
      fs.utimesSync(path.join(stale.rolloutDir, `model-io-${ANCHOR}.jsonl`), new Date(Date.now() - 11 * 60 * 1000), new Date(Date.now() - 11 * 60 * 1000));
      const rs = await runKick({ rootDir: stale.root, argv: ["--rollout-dir", stale.rolloutDir], watcherDeps: kickDeps(new MockRelay()), err: () => {} });
      ck.ok("WB-KICK-c3 活性闸（grill#wake Q5 mtime>10min 疑）：rollout 无 model-io 文件（死锚主形）→anchor-rollout-missing、mtime 11min→anchor-stale；均不注入事件留队",
        rc.outcome === "anchor-rollout-missing" && rc.kept === 1 && rs.outcome === "anchor-stale" && rs.kept === 1,
        { rc: rc.outcome, rs: rs.outcome });
      // c4 refire gap：同根同因二次运行 → 抑制（标记数恒 1）
      const d = mkKickRoot("kb-c4", { anchor: null });
      writeQ(d.root, "m-kb-c4", 0);
      const rd1 = await runKick({ rootDir: d.root, argv: [], watcherDeps: kickDeps(new MockRelay()), err: () => {} });
      const rd2 = await runKick({ rootDir: d.root, argv: [], watcherDeps: kickDeps(new MockRelay()), err: () => {} });
      const marksD = (() => { try { return fs.readdirSync(path.join(d.root, "sentinel", "wake-kick-alerts")).filter((n) => n.endsWith(".json")); } catch { return []; } })();
      ck.ok("WB-KICK-c4 告警 refire gap 抑制（fired 式先例；grill#wake Q5）：同会话同因 10min 内二次搁置 → 只告警一次（标记数恒 1、二次 suppressed 不重写）、事件两轮均留队",
        rd1.action === "anchor-gate" && rd2.action === "anchor-gate" && marksD.length === 1 && qeventsOf(d.root).length === 1,
        { marks: marksD.length, first: rd1.action, second: rd2.action });
    }

    // ---- WB-KICK-d：>12 溢出分批（W-E 验收腿 1） ----
    {
      const { root, rolloutDir } = mkKickRoot("kb-d");
      for (let i = 1; i <= 14; i++) writeQ(root, "m-kd" + String(i).padStart(2, "0"), i * 1000);
      const argv = ["--rollout-dir", rolloutDir];
      const relay1 = new MockRelay();
      const r1 = await runKick({ rootDir: root, argv, watcherDeps: kickDeps(relay1), err: () => {} });
      const sh1 = shellTextOf(relay1);
      const left1 = qeventsOf(root);
      const relay2 = new MockRelay();
      const r2 = await runKick({ rootDir: root, argv, watcherDeps: kickDeps(relay2), err: () => {} });
      const sh2 = shellTextOf(relay2);
      ck.ok("WB-KICK-d1 溢出分批（W-E 腿 1）：14 事件 > WAKE_BATCH_MAX(12) → 取最新 12 一次注入（签名=最新 m-kd14、计数行「+13 more pending - see the board」诚实计数含留队余量）、最旧 2 件留队",
        r1.drained === 12 && r1.kept === 2 && left1.length === 2 && left1[0].endsWith("m-kd01.json") && left1[1].endsWith("m-kd02.json") &&
        sh1.text.includes("mission=m-kd14") && sh1.text.includes("+13 more pending - see the board"),
        { drained: r1.drained, kept: r1.kept, left: left1, text: sh1.text.slice(0, 140) });
      ck.ok("WB-KICK-d2 留队余量经下一轮消费（延迟跳变可达确认腿：哨兵滞留 drain 补脚同形）：二次 kick → 最旧 2 件 drain（签名 m-kd02、另有 1 项）→ 队列空",
        r2.drained === 2 && r2.kept === 0 && qeventsOf(root).length === 0 && sh2.text.includes("mission=m-kd02") && sh2.text.includes("+1 more pending - see the board"),
        { drained: r2.drained, text: sh2.text.slice(0, 140) });
    }

    // ---- WB-KICK-e：b2 后置防线（锚劫持防线，硬要求） ----
    {
      const { root, rolloutDir } = mkKickRoot("kb-e");
      writeQ(root, "m-kb-e", 0);
      fs.writeFileSync(path.join(root, "sentinel", "coord-session.txt"), ANCHOR + "\n"); // 门面新鲜（活性闸过）
      const anchorPath = path.join(root, "sentinel", "coord-session.txt");
      const anchorBefore = fs.readFileSync(anchorPath);
      // mock：b1 目标 bridge-error(session-not-found) → wakeCoordSession 内 b2 createSession 自愈恰一次
      // → 活体 sess-live-kb + G5 工作区守卫通过（ws-1 命中）→ 锚被刷新（kick 无防线时的形态）
      const relay = new MockRelay({ bridgeError: "session-not-found", bridgeErrorCount: 1, liveSessionId: "sess-live-kb" });
      const r = await runKick({ rootDir: root, argv: ["--rollout-dir", rolloutDir], watcherDeps: kickDeps(relay), err: () => {} });
      const marksE = (() => { try { return fs.readdirSync(path.join(root, "sentinel", "wake-kick-alerts")).filter((n) => n.includes("anchor-rewritten")); } catch { return []; } })();
      ck.ok("WB-KICK-e1 b2 禁用后置防线（变异靶）：注入路径锚被改写（b2 自愈刷新发生）→ 快照原子还原（coord-session.txt 字节=原值真实形锚 id）、按失败处置（事件留队）、anchor-rewritten 告警标记落地——kick 路径净效果「锚零改写、绝不认新会话」",
        r.action === "failed" && r.outcome === "anchor-rewritten" && r.kept === 1 && qeventsOf(root).length === 1 &&
        Buffer.compare(fs.readFileSync(anchorPath), anchorBefore) === 0 && marksE.length === 1,
        { r, anchorSame: Buffer.compare(fs.readFileSync(anchorPath), anchorBefore) === 0, marks: marksE.length });
      const kickSrc = fs.readFileSync(path.join(PLUGIN_DIR, "hooks", "wake-kick.mjs"), "utf8");
      ck.ok("WB-KICK-e2 源面结构钉「绝不 b2」：wake-kick.mjs 源码零 wakeCoordSession 引用（b2 自愈面只在 watcher runTransaction 内部，kick 不经旗标不绕开——防线=注入前后锚快照后置校验+还原，scope 不改 watcher 面的包内第二口径）",
        !kickSrc.includes("wakeCoordSession") && kickSrc.includes("anchor-rewritten") && kickSrc.includes("coord-session.txt"),
        { hasWakeCoord: kickSrc.includes("wakeCoordSession") });
    }

    // ---- WB-KICK-f：signals 快照还原（W-E 腿 2 的前提：kick 失败不掩盖哨兵 C1） ----
    {
      const { root, rolloutDir } = mkKickRoot("kb-f");
      writeQ(root, "m-kb-f", 0);
      const relay = new MockRelay({ failHandshake: true }); // 建连败 → D2 瞬时（degrade.record 写 signals）
      const r = await runKick({ rootDir: root, argv: ["--rollout-dir", rolloutDir], watcherDeps: kickDeps(relay), err: () => {} });
      ck.ok("WB-KICK-f1 signals 非掩盖（W-E 腿 2 前提）：kick 瞬时失败（D2 信号面在事务内发生）→ 快照还原后 sentinel/watcher-signals.jsonl 零落地（哨兵 W6 消费面不误读「watcher 在岗」而静默 C1）、事件留队走滞留兜底",
        r.action === "failed" && r.kept === 1 && !fs.existsSync(path.join(root, "sentinel", "watcher-signals.jsonl")),
        { r, signalsAbsent: !fs.existsSync(path.join(root, "sentinel", "watcher-signals.jsonl")) });
    }

    // ---- WB-KICK-g：认领串行化（让位/生产者窗重试/陈旧残留回收） ----
    {
      const g1 = mkKickRoot("kb-g1");
      writeQ(g1.root, "m-kb-g1", 0);
      const claimG1 = path.join(qdirOf(g1.root), "claim.json");
      const kickClaim = JSON.stringify({ acquired_at: new Date().toISOString(), source: "kick" }, null, 2) + "\n";
      fs.writeFileSync(claimG1, kickClaim);
      const relayG1 = new MockRelay();
      const rg1 = await runKick({ rootDir: g1.root, argv: ["--rollout-dir", g1.rolloutDir], watcherDeps: kickDeps(relayG1), err: () => {} });
      ck.ok("WB-KICK-g1 认领串行化·kick 在跑让位：source=kick 新鲜认领在场 → 立即让位（claim-held，零重试零注入）、事件留队、他者认领字节不动（哨兵「认领文件在→跳过」的执行侧对偶）",
        rg1.action === "claim-held" && rg1.kept === 1 && relayG1.connCount === 0 && fs.readFileSync(claimG1, "utf8") === kickClaim,
        { rg1 });
      const g2 = mkKickRoot("kb-g2");
      writeQ(g2.root, "m-kb-g2", 0);
      const claimG2 = path.join(qdirOf(g2.root), "claim.json");
      fs.writeFileSync(claimG2, JSON.stringify({ acquired_at: new Date().toISOString(), source: "server" }, null, 2) + "\n");
      let retryN = 0;
      const relayG2 = new MockRelay();
      const rg2 = await runKick({
        rootDir: g2.root, argv: ["--rollout-dir", g2.rolloutDir], watcherDeps: kickDeps(relayG2), err: () => {},
        sleepFn: async () => { retryN++; if (retryN === 3) fs.unlinkSync(claimG2); }, // 生产者 spawn 毫秒窗：第 3 次重试前释放
      });
      ck.ok("WB-KICK-g2 认领串行化·生产者毫秒窗：fresh 生产者 claim（server）→ 短重试等待；窗内释放 → kick 接手 drain（事件移除+认领释放）——完成即唤不被自家认领竞态拖到 120s",
        rg2.action === "drained" && rg2.drained === 1 && retryN >= 3 && readText(claimG2) === null,
        { rg2, retryN });
      const g3 = mkKickRoot("kb-g3");
      writeQ(g3.root, "m-kb-g3", 0);
      fs.mkdirSync(qdirOf(g3.root), { recursive: true });
      fs.writeFileSync(path.join(qdirOf(g3.root), "claim.json"), JSON.stringify({ acquired_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), source: "server" }, null, 2) + "\n");
      const relayG3 = new MockRelay();
      const rg3 = await runKick({ rootDir: g3.root, argv: ["--rollout-dir", g3.rolloutDir], watcherDeps: kickDeps(relayG3), err: () => {} });
      ck.ok("WB-KICK-g3 认领残留超龄回收（WB-SRV-e 残留识别的消费面）：acquired_at 2h 前的 crash 残留 → 回收重认领 → 照常 drain、运行毕认领释放（claim.json 不在）",
        rg3.action === "drained" && rg3.drained === 1 && readText(path.join(qdirOf(g3.root), "claim.json")) === null,
        { rg3 });
    }

    // ---- WB-KICK-h：CLI 黑盒（spawn 形；生产者/哨兵调用形） ----
    {
      const { root } = mkKickRoot("kb-h", { anchor: null });
      writeQ(root, "m-kb-h", 0);
      const h1 = runNode(path.join(PLUGIN_DIR, "hooks", "wake-kick.mjs"), ["--root", root], { timeoutMs: 30000 });
      ck.ok("WB-KICK-h1 CLI 黑盒·锚闸不过：spawn node hooks/wake-kick.mjs --root <root> → exit 0、stdout action=anchor-gate、stderr 唤醒搁置告警行、事件留队（不真发注入，真实注入留生产首单）",
        h1.code === 0 && String(h1.stdout).includes('"action":"anchor-gate"') && String(h1.stderr).includes("唤醒搁置告警") && qeventsOf(root).length === 1,
        { code: h1.code, out: String(h1.stdout).slice(0, 120), errHead: String(h1.stderr).slice(0, 120) });
      const gRoot = mkKickRoot("kb-h2").root;
      const h3 = runNode(path.join(PLUGIN_DIR, "hooks", "wake-kick.mjs"), ["--root", gRoot], { timeoutMs: 30000 });
      ck.ok("WB-KICK-h2 CLI 黑盒·空队列：exit 0、stdout action=idle（门口静默，零副作用零目录创建风暴）",
        h3.code === 0 && String(h3.stdout).includes('"action":"idle"'), { code: h3.code, out: String(h3.stdout).slice(0, 120) });
    }

    // ---- WB-SENT：哨兵 drain（bg-sentinel 滞留消费黑盒，加速参数驱动） ----
    grp("WB-SENT sentinel-drain");
    const SENT = path.join(PLUGIN_DIR, "hooks", "bg-sentinel.mjs");
    const sentKids = [];
    const mkSentRoot = (name) => {
      const proj = path.join(BASE.root, "wb-sent", name, "proj");
      const root = path.join(proj, ".zcode", "orchestrator");
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "board.json"), JSON.stringify({ version: 2, updated_at: new Date().toISOString(), missions: [{ id: "m-closed", title: "closed", status: "closed" }] }) + "\n");
      return { proj, root, sentDir: path.join(root, "sentinel") };
    };
    const spawnSent = (s, staleSec = 1, extraArgs = []) => {
      const bg = captureBackground({
        script: process.execPath,
        args: [SENT, "--root", s.root, "--poll-sec", "1", "--stagger-sec", "0", "--wake-queue-stale-sec", String(staleSec), ...extraArgs],
        cwd: s.proj,
        env: { ZCODE_PROJECT_DIR: s.proj },
      });
      sentKids.push(bg);
      return bg;
    };
    const ageEvent = (root, missionId, ageMs) => {
      writeQ(root, missionId, 0);
      const f = path.join(qdirOf(root), fs.readdirSync(qdirOf(root)).find((n) => n.endsWith(`-${missionId}.json`)));
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(f, t, t); // mtime 后拨：滞留判定（≥ staleMs）即时成立
      return f;
    };
    try {
      // a：滞留件 + 无认领 + 无锚 → spawn kick（last-spawn 标记）→ kick 锚闸告警落地
      // （断言收齐即杀实例：stale-sec=1 加速刻度下哨兵每 tick 会再补一脚 kick，早杀
      //   收敛真实 node 子进程总量——run-all 300s 帽内的时长纪律）
      const sa = mkSentRoot("sa");
      ageEvent(sa.root, "m-sa", 10 * 1000);
      const bgA = spawnSent(sa);
      const spawnMarker = path.join(sa.sentDir, "wake-kick-last-spawn");
      const okA = await waitFor(() => fs.existsSync(spawnMarker) &&
        (() => { try { return fs.readdirSync(path.join(sa.sentDir, "wake-kick-alerts")).some((n) => n.includes("anchor-missing")); } catch { return false; } })(), 12000);
      try { bgA.kill(); } catch { /* 已退 */ }
      ck.ok("WB-SENT-a1 哨兵 drain 链路（滞留件被哨兵 drain）：wake-queue 滞留件（mtime ≥ wake_queue_stale_sec）+无认领 → 哨兵 spawn node hooks/wake-kick.mjs（sentinel/wake-kick-last-spawn 标记在位）→ kick 锚闸不过（无锚）落地 anchor-missing 告警标记——spawn 链与 kick 判定面全程实证",
        okA && qeventsOf(sa.root).length === 1,
        { okA, marker: fs.existsSync(spawnMarker), left: qeventsOf(sa.root).length });
      // b：认领新鲜持有中 → 哨兵跳过（零 spawn；claim 字节不动）
      // （stale-sec 30：认领新鲜窗=同刻度 30s，事件后拨 60s 恒滞留——3.2s 观窗内
      //   claim 恒新鲜，跳过判定 determinate，不受 1s 加速刻度的时间边界影响）
      const sb = mkSentRoot("sb");
      ageEvent(sb.root, "m-sb", 60 * 1000);
      const claimSb = path.join(qdirOf(sb.root), "claim.json");
      const claimSbBytes = JSON.stringify({ acquired_at: new Date().toISOString(), source: "server" }, null, 2) + "\n";
      fs.writeFileSync(claimSb, claimSbBytes);
      const bgB = spawnSent(sb, 30);
      await sleepMs(3200);
      try { bgB.kill(); } catch { /* 已退 */ }
      const spawnMarkerB = path.join(sb.sentDir, "wake-kick-last-spawn");
      const claimNow = readText(claimSb);
      ck.ok("WB-SENT-b1 kick 活着时哨兵不抢（认领文件在→跳过）：fresh claim（生产者/kick 持有中）在场 → 哨兵零 spawn（无 last-spawn 标记）、claim 字节级不动、事件留队（门口静默）",
        !fs.existsSync(spawnMarkerB) && claimNow === claimSbBytes && qeventsOf(sb.root).length === 1,
        { marker: fs.existsSync(spawnMarkerB), claimIntact: claimNow === claimSbBytes });
      // c：陈旧残留 claim → 哨兵 spawn → kick 超龄回收（claim 消失）+ 锚闸告警
      const sc = mkSentRoot("sc");
      ageEvent(sc.root, "m-sc", 10 * 1000);
      fs.mkdirSync(qdirOf(sc.root), { recursive: true });
      fs.writeFileSync(path.join(qdirOf(sc.root), "claim.json"), JSON.stringify({ acquired_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), source: "server" }, null, 2) + "\n");
      const bgC = spawnSent(sc);
      const spawnMarkerC = path.join(sc.sentDir, "wake-kick-last-spawn");
      const okC = await waitFor(() => fs.existsSync(spawnMarkerC) && !fs.existsSync(path.join(qdirOf(sc.root), "claim.json")), 12000);
      try { bgC.kill(); } catch { /* 已退 */ }
      ck.ok("WB-SENT-c1 陈旧残留认领不挡兜底：crash 残留（2h）不算持有 → 哨兵 spawn kick → kick 超龄回收重认领（运行毕 claim.json 消失）+ 锚闸告警标记落地",
        okC && (() => { try { return fs.readdirSync(path.join(sc.sentDir, "wake-kick-alerts")).some((n) => n.includes("anchor-missing")); } catch { return false; } })(),
        { okC, claimGone: !fs.existsSync(path.join(qdirOf(sc.root), "claim.json")) });
      // d：W-E 腿 2——kick 失败遗留不破坏哨兵 C1 板面告警回落（同 tick 双效应）
      // v1.2 M9-1（主控 2026-10-28 裁决 A 扩 scope，仅此夹具族两行对齐）：scoping 新契约下
      // 无归因 mission=零开枪（空值三段第 3 段）——夹具补锚+归因（与 sentinel-teardown
      // T2b/WS-5d 同形），被测行为面（kick 失败遗留不破坏 C1 回落）不变。
      const sd = mkSentRoot("sd");
      fs.mkdirSync(sd.sentDir, { recursive: true });
      fs.writeFileSync(path.join(sd.sentDir, "coord-session.txt"), "sess_wb_sent_d\n");
      ageEvent(sd.root, "m-sd", 10 * 1000);
      fs.writeFileSync(path.join(sd.root, "board.json"), JSON.stringify({
        version: 2,
        updated_at: new Date().toISOString(),
        missions: [{ id: "m-sd", title: "sd-unclaimed", status: "done", dispatch: { agent_id: "a-sd", mode: "headless", session_id: "sess_wb_sent_d" }, updated_at: new Date(Date.now() - 10 * 1000).toISOString() }],
      }) + "\n");
      // --wake-grace-min 0.01：宽限 0.6s → 逃逸口（anchor 龄期 ≥2×宽限=1.2s）秒级开枪；
      //   缺省 5min 宽限会让 C1 等 5 分钟（suite 时长纪律：run-all 300s 帽内）
      const bgD = spawnSent(sd, 1, ["--wake-grace-min", "0.01"]);
      const rD = await bgD.done;
      const echoD = readText(path.join(sd.sentDir, "echo.jsonl")) || "";
      const spawnMarkerD = path.join(sd.sentDir, "wake-kick-last-spawn");
      const firedD = (() => { try { return fs.readdirSync(path.join(sd.sentDir, "fired")).filter((n) => n.startsWith("m-sd--")).length; } catch { return 0; } })();
      ck.ok("WB-SENT-d1 W-E 腿 2·C1 兜底不破坏（kick spawn 失败/失败遗留回落既有行为）：滞留件+未签收 done 到期 → 哨兵同 tick 双效应——drain 补脚照跑（last-spawn 标记在位）∧ C1 wake failure alert照旧开枪（fired m-sd--* 认领+echo 告警+exit 1）",
        rD.code === 1 && echoD.includes("wake failure alert") && firedD >= 1 && fs.existsSync(spawnMarkerD),
        { code: rD.code, echoHasC1: echoD.includes("wake failure alert"), fired: firedD, marker: fs.existsSync(spawnMarkerD) });
    } finally {
      for (const k of sentKids) { try { k.kill(); } catch { /* 已退 */ } }
    }
  }
}
