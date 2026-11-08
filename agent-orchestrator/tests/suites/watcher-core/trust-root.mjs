// @module suites/watcher-core/trust-root
/*!
 * watcher-core/trust-root.mjs —— 锚互信根触发/鉴别面：G5 锚互信根触发 / G14 子代理过滤 /
 * WA0 托管 worker 锚写面身份鉴别 / WB runner 生产者 / W2 B1 锚自愈三面 + C3 rider。
 * 拆分自 suites/watcher-core.mjs；断言本体零改动（源面读取 new URL 相对深度按新落位接线）。
 * 修复轮 C（m-20261101-040930-3488）：G5-03 srv 读面族 helper 重基（server.mjs 薄入口化失锚）
 * + 补 connectRelay import（套件拆分漏接）。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, grp } from "./shared.mjs";
import { MockRelay } from "./mock-relay.mjs";
import { PLUGIN_DIR, startServer } from "../../harness/jsonrpc-client.mjs";
import { runNode } from "../../harness/capture.mjs";
import { familySource } from "../../harness/source-family.mjs";
import { wakeCoordSession, isSubagentSessionId } from "../../../watcher/inject.mjs";
import { classifyFailure } from "../../../watcher/degrade.mjs";
import { connectRelay } from "../../../watcher/relay.mjs";
import { buildWatcher, mission, writeCoord, readSignals } from "./fixtures.mjs";

export async function run(ctx) {
  const { BASE, mkC11 } = ctx;

  /* ======== G5 锚互信根触发（SessionStart/启动面；EXP10-findings R4 缺失文件根因） ======== */
  {
    grp("G5 trust-root");
    // 01：SessionStart 无条件重发布成对锚——无板也要写（stdout 契约不变：无可恢复任务=静默）
    const ssProj = path.join(BASE.root, "g5-ss-proj");
    fs.mkdirSync(ssProj, { recursive: true });
    const ssRoot = path.join(ssProj, ".zcode", "orchestrator");
    const ssRun = runNode(path.join(PLUGIN_DIR, "hooks", "session-start.mjs"), [], {
      cwd: ssProj,
      env: { ZCODE_PROJECT_DIR: ssProj },
      input: { hook_event_name: "SessionStart", session_id: "sess-g5-ss" },
    });
    const ssSessionPath = path.join(ssRoot, "sentinel", "coord-session.txt");
    const ssWsPath = path.join(ssRoot, "sentinel", "coord-workspace.txt");
    const ssSession = fs.existsSync(ssSessionPath) ? fs.readFileSync(ssSessionPath, "utf8") : "";
    const ssWs = fs.existsSync(ssWsPath) ? fs.readFileSync(ssWsPath, "utf8") : "";
    ck.ok("G5-01 SessionStart 锚互信根触发（R4 根因：resume-only 双写在 app 重启后未跑→coord-workspace.txt 缺失→watcher 盲取 workspaces[0]）：hook 无条件原子写成对锚 coord-session.txt=session_id、coord-workspace.txt=path.resolve(ZCODE_PROJECT_DIR)，无板也写（锚先于板面）；stdout 契约不变（无板=零简报）、exit 0",
      ssRun.code === 0 && ssRun.stdout.trim() === "" && ssSession === "sess-g5-ss\n" &&
      ssWs === path.resolve(ssProj) + "\n",
      { code: ssRun.code, out: ssRun.stdout.slice(0, 120), session: ssSession, workspace: ssWs });
    // 02：session_id 消毒（防路径/换行注入锚文件；单行纪律）
    const ssRun2 = runNode(path.join(PLUGIN_DIR, "hooks", "session-start.mjs"), [], {
      cwd: ssProj,
      env: { ZCODE_PROJECT_DIR: ssProj },
      input: { hook_event_name: "SessionStart", session_id: "../evil\nINJECT" },
    });
    const ssSession2 = fs.readFileSync(ssSessionPath, "utf8");
    ck.ok("G5-02 SessionStart session_id 消毒（journal.mjs 同款字符集）：非法字符→_、不产生换行/路径段（锚文件恒单行）、hook 照常 exit 0",
      ssRun2.code === 0 && ssSession2 === ".._evil_INJECT\n" && ssSession2.split("\n").filter(Boolean).length === 1,
      { session: ssSession2 });
    // 03：源面锁——三触发面都在位（SessionStart publishWakeAnchor / server 启动补位 / toolResume 双写）
    const ssSrc = fs.readFileSync(path.join(PLUGIN_DIR, "hooks", "session-start.mjs"), "utf8");
    // v1.3 切分重基（修复轮 C）：srv 读取面走族 helper（薄入口+模块族拼接——启动补位已迁
    // mcp/server-core.mjs、toolResume 双写已迁 mcp/tool-resume.mjs），断言与期望值零改动。
    const srvSrc = familySource(PLUGIN_DIR, path.join("mcp", "server.mjs"));
    ck.ok("G5-03 锚互信根三触发面源面锁：hooks/session-start.mjs 含 publishWakeAnchor 且写 coord-session.txt+coord-workspace.txt；mcp/server.mjs 启动补位写 coord-workspace.txt（仅缺失、残留可见）；toolResume 双写块仍在（coord-session.txt+coord-workspace.txt 同点）",
      ssSrc.includes("function publishWakeAnchor") && ssSrc.includes('"coord-session.txt"') && ssSrc.includes('"coord-workspace.txt"') &&
      srvSrc.includes("anchor trust-root trigger, server-start face") &&
      srvSrc.includes('const anchorFile = path.join(root, "sentinel", "coord-workspace.txt")') &&
      srvSrc.includes('path.join(root, "sentinel", "coord-session.txt"), sessionId + "\\n"'),
      { ss: ssSrc.includes("publishWakeAnchor"), srv: srvSrc.includes("anchor trust-root trigger, server-start face") });
    // 04：新失败码 D3 终态归类（配置告警面，不落 D2 重试轰炸）
    ck.ok("G5-04 workspace-anchor-missing/mismatch 归 D3 终态配置告警（classifyFailure 全表；与 bridge-list-empty/session-target-missing 同族），不会落入 unknown:D2 瞬时重试",
      classifyFailure({ kind: "workspace-anchor-missing" }).cls === "D3" &&
      classifyFailure({ kind: "workspace-anchor-mismatch" }).cls === "D3" &&
      classifyFailure({ kind: "workspace-anchor-missing" }).terminal === true &&
      classifyFailure({ kind: "workspace-anchor-mismatch" }).reason === "workspace-anchor-mismatch",
      { a: classifyFailure({ kind: "workspace-anchor-missing" }), b: classifyFailure({ kind: "workspace-anchor-mismatch" }) });
  }

  /* ======== G14 锚重发布子代理过滤（EXP10-findings R6：重启恢复时宿主对子代理会话
     也发 SessionStart → G5 无条件重发布把锚改指子代理会话=唤醒目标劫持） ======== */
  {
    grp("G14 subagent-anchor-filter");
    const g14SubagentId = "sess_subagent_agent_583ee58a-4b51-46b0-9120-2177449d22a0"; // R6 实证同形状
    const g14CoordId = "sess_0f1e2d3c-4b5a-4697-8c9d-0a1b2c3d4e5f";
    // 01：子代理会话 id → 锚零写（新根零创建，不写任何锚文件）
    const g14Proj = path.join(BASE.root, "g14-subagent-proj");
    fs.mkdirSync(g14Proj, { recursive: true });
    const g14Root = path.join(g14Proj, ".zcode", "orchestrator");
    const g14Run = runNode(path.join(PLUGIN_DIR, "hooks", "session-start.mjs"), [], {
      cwd: g14Proj,
      env: { ZCODE_PROJECT_DIR: g14Proj },
      input: { hook_event_name: "SessionStart", session_id: g14SubagentId },
    });
    ck.ok("G14-a 子代理会话锚零写（R6 实锤：重启恢复时宿主对子代理会话也发 SessionStart→publishWakeAnchor 照写→coord-session.txt 被改指 sess_subagent_agent_<id>=唤醒目标劫持）：session_id=sess_subagent_agent_<agentId> → sentinel/ 目录零创建、coord-session.txt/coord-workspace.txt 零写、hook exit 0 stdout 静默（stdin/stdout/exit 契约零改）",
      g14Run.code === 0 && g14Run.stdout.trim() === "" &&
      !fs.existsSync(path.join(g14Root, "sentinel", "coord-session.txt")) &&
      !fs.existsSync(path.join(g14Root, "sentinel", "coord-workspace.txt")) &&
      !fs.existsSync(path.join(g14Root, "sentinel")),
      { code: g14Run.code, out: g14Run.stdout.slice(0, 120), sentinelDir: fs.existsSync(path.join(g14Root, "sentinel")) });
    // 02：子代理会话 id → 存量锚零触碰（内容+mtime 均不动）
    const g14SeedSentinel = path.join(BASE.root, "g14-seed-proj", ".zcode", "orchestrator", "sentinel");
    fs.mkdirSync(g14SeedSentinel, { recursive: true });
    const g14SeedSession = path.join(g14SeedSentinel, "coord-session.txt");
    const g14SeedWs = path.join(g14SeedSentinel, "coord-workspace.txt");
    fs.writeFileSync(g14SeedSession, g14CoordId + "\n");
    fs.writeFileSync(g14SeedWs, path.join(BASE.root, "g14-ws") + "\n");
    const seedSessionMtime = fs.statSync(g14SeedSession).mtimeMs;
    const seedWsMtime = fs.statSync(g14SeedWs).mtimeMs;
    const g14Run2 = runNode(path.join(PLUGIN_DIR, "hooks", "session-start.mjs"), [], {
      cwd: path.join(BASE.root, "g14-seed-proj"),
      env: { ZCODE_PROJECT_DIR: path.join(BASE.root, "g14-seed-proj") },
      input: { hook_event_name: "SessionStart", session_id: "sess_subagent_agent_g14seed0001" },
    });
    ck.ok("G14-b 子代理会话存量锚零触碰：锚已在位时 sess_subagent 前缀 id 触发的 SessionStart 不改写不重命名（coord-session/coord-workspace 内容+mtime 逐字不动；回归即劫持复现）",
      g14Run2.code === 0 &&
      fs.readFileSync(g14SeedSession, "utf8") === g14CoordId + "\n" &&
      fs.readFileSync(g14SeedWs, "utf8") === path.join(BASE.root, "g14-ws") + "\n" &&
      fs.statSync(g14SeedSession).mtimeMs === seedSessionMtime &&
      fs.statSync(g14SeedWs).mtimeMs === seedWsMtime,
      { code: g14Run2.code, sessionMtime: fs.statSync(g14SeedSession).mtimeMs, seedSessionMtime, wsMtime: fs.statSync(g14SeedWs).mtimeMs, seedWsMtime });
    // 03：主控会话 id（sess_<uuid>，无 subagent 段）→ 成对原子写不误伤（G5-01 正控复验）
    const g14MainProj = path.join(BASE.root, "g14-main-proj");
    fs.mkdirSync(g14MainProj, { recursive: true });
    const g14MainRoot = path.join(g14MainProj, ".zcode", "orchestrator");
    const g14Run3 = runNode(path.join(PLUGIN_DIR, "hooks", "session-start.mjs"), [], {
      cwd: g14MainProj,
      env: { ZCODE_PROJECT_DIR: g14MainProj },
      input: { hook_event_name: "SessionStart", session_id: g14CoordId },
    });
    ck.ok("G14-c 主控会话 id 不误伤（G5-01 正控复验）：sess_<uuid>（无 subagent 段）照旧无条件成对原子写 coord-session.txt=session_id、coord-workspace.txt=path.resolve(ZCODE_PROJECT_DIR)，过滤零波及",
      g14Run3.code === 0 &&
      fs.readFileSync(path.join(g14MainRoot, "sentinel", "coord-session.txt"), "utf8") === g14CoordId + "\n" &&
      fs.readFileSync(path.join(g14MainRoot, "sentinel", "coord-workspace.txt"), "utf8") === path.resolve(g14MainProj) + "\n",
      { code: g14Run3.code });
    // 04：源面钉——过滤守卫在 publishWakeAnchor 函数体内、先于锚写调用（防守卫被移出/后置）
    const g14Src = fs.readFileSync(path.join(PLUGIN_DIR, "hooks", "session-start.mjs"), "utf8");
    const g14Fn = g14Src.slice(g14Src.indexOf("function publishWakeAnchor"), g14Src.indexOf("function countUnread"));
    ck.ok("G14-d 过滤源面钉：publishWakeAnchor 函数体内含 sess_subagent startsWith 守卫（前缀形覆盖未来 sess_subagent_* 变体）且守卫先于第一处 atomicWriteBestEffort 锚写调用（入口跳过语义，非写后回滚）",
      g14Fn.includes("startsWith") && g14Fn.includes("sess_subagent") &&
      g14Fn.indexOf("startsWith") > -1 && g14Fn.indexOf("startsWith") < g14Fn.indexOf("atomicWriteBestEffort"),
      { inFn: g14Fn.includes("sess_subagent"), guardFirst: g14Fn.indexOf("startsWith") < g14Fn.indexOf("atomicWriteBestEffort") });
  }

  /* ======== v1.1.1 WA0 托管 worker 锚写面身份鉴别（wake-PLAN W-A0：锚劫持活体实证
     2026-10-25，-p 探针会话 sess_<uuid> 形状经 G5 无条件发布抢占 coord-session——
     G14 只滤 sess_subagent_* 前缀；runner spawn CLI 落 ORCH_MANAGED_WORKER env，
     publishWakeAnchor 见之入口跳过） ======== */
  {
    grp("WA0 managed-worker-anchor-skip");
    const wa0CoordId = "sess_0f1e2d3c-4b5a-4697-8c9d-0a1b2c3d4e5f"; // 主控形状（-p worker 即此形状，G14 拦不住的正是它）
    // 01：带 env → 零写零副作用（新根 sentinel/ 目录都不建；exit 0 stdout 静默契约零改）
    const wa0Proj = path.join(BASE.root, "wa0-env-proj");
    fs.mkdirSync(wa0Proj, { recursive: true });
    const wa0Root = path.join(wa0Proj, ".zcode", "orchestrator");
    const wa0Run = runNode(path.join(PLUGIN_DIR, "hooks", "session-start.mjs"), [], {
      cwd: wa0Proj,
      env: { ZCODE_PROJECT_DIR: wa0Proj, ORCH_MANAGED_WORKER: "m-wa0-probe" },
      input: { hook_event_name: "SessionStart", session_id: wa0CoordId },
    });
    ck.ok("WA0-a env 鉴别跳过发布（W-A0 结构修复：W20 上量后锚=最后启动的 worker 的劫持面）：ORCH_MANAGED_WORKER 在场 → sentinel/ 目录零创建、coord-session/coord-workspace 双锚零写、hook exit 0 stdout 静默（stdin/stdout/exit 契约零改）",
      wa0Run.code === 0 && wa0Run.stdout.trim() === "" && !fs.existsSync(path.join(wa0Root, "sentinel")),
      { code: wa0Run.code, out: wa0Run.stdout.slice(0, 120), sentinelDir: fs.existsSync(path.join(wa0Root, "sentinel")) });
    // 02：存量锚零触碰（内容+mtime 均不动）——同 G14-b 纪律，env 闸不得借道重写
    const wa0SeedSentinel = path.join(BASE.root, "wa0-seed-proj", ".zcode", "orchestrator", "sentinel");
    fs.mkdirSync(wa0SeedSentinel, { recursive: true });
    const wa0SeedSession = path.join(wa0SeedSentinel, "coord-session.txt");
    const wa0SeedWs = path.join(wa0SeedSentinel, "coord-workspace.txt");
    fs.writeFileSync(wa0SeedSession, wa0CoordId + "\n");
    fs.writeFileSync(wa0SeedWs, "D:\\wa0-ws\n");
    const wa0SeedSessionMtime = fs.statSync(wa0SeedSession).mtimeMs;
    const wa0SeedWsMtime = fs.statSync(wa0SeedWs).mtimeMs;
    const wa0Run2 = runNode(path.join(PLUGIN_DIR, "hooks", "session-start.mjs"), [], {
      cwd: path.join(BASE.root, "wa0-seed-proj"),
      env: { ZCODE_PROJECT_DIR: path.join(BASE.root, "wa0-seed-proj"), ORCH_MANAGED_WORKER: "m-wa0-probe" },
      input: { hook_event_name: "SessionStart", session_id: "sess_wa0_worker_9999" },
    });
    ck.ok("WA0-b 带 env 存量锚零触碰：内容+mtime 逐字不动（回归即 worker 重发布复现）",
      wa0Run2.code === 0 &&
        fs.readFileSync(wa0SeedSession, "utf8") === wa0CoordId + "\n" &&
        fs.readFileSync(wa0SeedWs, "utf8") === "D:\\wa0-ws\n" &&
        fs.statSync(wa0SeedSession).mtimeMs === wa0SeedSessionMtime &&
        fs.statSync(wa0SeedWs).mtimeMs === wa0SeedWsMtime,
      { code: wa0Run2.code });
    // 03：无 env → 照常发布（A/B 同形对照：同形状主控 id，仅 env 差异，行为分叉即鉴别成立）
    const wa0Run3 = runNode(path.join(PLUGIN_DIR, "hooks", "session-start.mjs"), [], {
      cwd: wa0Proj,
      env: { ZCODE_PROJECT_DIR: wa0Proj },
      input: { hook_event_name: "SessionStart", session_id: wa0CoordId },
    });
    ck.ok("WA0-c 无 env 照常发布（既有 G5-01 行为零弱化，A/B 对照=同 id 同根仅 env 差异）：成对锚 coord-session.txt=session_id、coord-workspace.txt=path.resolve(ZCODE_PROJECT_DIR)",
      wa0Run3.code === 0 &&
        fs.readFileSync(path.join(wa0Root, "sentinel", "coord-session.txt"), "utf8") === wa0CoordId + "\n" &&
        fs.readFileSync(path.join(wa0Root, "sentinel", "coord-workspace.txt"), "utf8") === path.resolve(wa0Proj) + "\n",
      { code: wa0Run3.code });
    // 04：源面钉——env 守卫在 publishWakeAnchor 函数体内、先于第一处锚写调用，注释带 W-A0 标记
    const wa0Src = fs.readFileSync(path.join(PLUGIN_DIR, "hooks", "session-start.mjs"), "utf8");
    const wa0Fn = wa0Src.slice(wa0Src.indexOf("function publishWakeAnchor"), wa0Src.indexOf("function countUnread"));
    ck.ok("WA0-d 过滤源面钉：publishWakeAnchor 函数体内含 ORCH_MANAGED_WORKER 入口守卫（先于第一处 atomicWriteBestEffort=入口跳过语义非写后回滚）且注释记明 W-A0 锚鉴别",
      wa0Fn.includes("ORCH_MANAGED_WORKER") &&
        wa0Fn.indexOf("ORCH_MANAGED_WORKER") < wa0Fn.indexOf("atomicWriteBestEffort") &&
        wa0Fn.includes("W-A0"),
      { inFn: wa0Fn.includes("ORCH_MANAGED_WORKER"), guardFirst: wa0Fn.indexOf("ORCH_MANAGED_WORKER") < wa0Fn.indexOf("atomicWriteBestEffort") });
  }

  /* ======== v1.6 W-p 剥离：WB-RUN-a..d 四腿退役（runner spawn CLI env 黑盒/wake-queue
     事件落/认领释放/源面钉——subject=hooks/dispatch-runner.mjs，随 -p 通道迁 parked/
     agent-orchestrator/；wake-queue 生产者①=tool-report board 面保留由 crv6-statemachine
     WB-SRV-a..g 承载；台账 v1.6.0.md §W-p）。 ======== */

  /* ======== W2 B1 锚自愈三面 + C3 rider（v1.1 W2：DESIGN §5.4） ======== */
  {
    grp("W2 anchor-selfheal");
    const w2SubagentId = "sess_subagent_agent_583ee58a-4b51-46b0-9120-2177449d22a0"; // R6 实证同形状
    const w2MainId = "sess_0f1e2d3c-4b5a-4697-8c9d-0a1b2c3d4e5f";

    // 01：① 锚消费面前置形状校验——coord-session 锚=子代理 id → wakeCoordSession 入口
    // fail-loud 拒用（不建桥/不发帧/不写锚）；allowLegacyFirst 逃生口只免工作区锚缺失面，
    // 不豁免本形状闸（劫持态宁可不唤醒）。
    const w2Hijack = mkC11("w2-hijack", { coord: w2SubagentId });
    const w2Relay = new MockRelay({ liveSessionId: "sess-live-w2" });
    const w2Session = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: w2Relay.transportFactory, authAckTimeoutMs: 200 });
    const w2Warns = [];
    let w2Err = null;
    try {
      await wakeCoordSession({ session: w2Session, workspaceKeyHint: "ws-1", coordSessionPath: w2Hijack.coordPath, content: "shell-w2", fsImpl: w2Hijack.fsImpl, ackTimeoutMs: 500, respTimeoutMs: 500, warn: (w) => w2Warns.push(w) });
    } catch (e) { w2Err = e; }
    let w2LegacyErr = null;
    try {
      await wakeCoordSession({ session: w2Session, coordSessionPath: w2Hijack.coordPath, content: "shell-w2", fsImpl: w2Hijack.fsImpl, allowLegacyFirst: true, ackTimeoutMs: 500, respTimeoutMs: 500, warn: (w) => w2Warns.push(w) });
    } catch (e) { w2LegacyErr = e; }
    const w2Opens = w2Relay.received.filter((m) => m.payload && m.payload.zcode_type === "workspace-bridge-open").length;
    ck.ok("W2-01 B1① 锚消费面前置形状校验：coord-session.txt=sess_subagent_agent_<id> → wakeCoordSession 前置 fail-loud 拒用（code=coord-anchor-subagent，错误串含 sess_subagent/拒绝消费；warn 面同串），不建桥（workspace-bridge-open=0）不发帧不写锚（存量锚逐字不动）；allowLegacyFirst:true 逃生口不豁免形状闸（同误拒）",
      w2Err && w2Err.code === "coord-anchor-subagent" &&
      String(w2Err.message).includes("sess_subagent") && String(w2Err.message).includes("refusing to consume") &&
      w2Warns.some((w) => w.includes("coord-anchor-subagent") && w.includes("sess_subagent")) &&
      w2Opens === 0 && w2Hijack.writesRef() === 0 &&
      fs.readFileSync(w2Hijack.coordPath, "utf8") === w2SubagentId + "\n" &&
      w2LegacyErr && w2LegacyErr.code === "coord-anchor-subagent",
      { err: w2Err && w2Err.code, legacy: w2LegacyErr && w2LegacyErr.code, opens: w2Opens, warns: w2Warns });

    // 02：② 主控形状不误伤——前缀判别只吃 sess_subagent_*（含裸前缀），sess_<uuid> 恒 false；
    // 主控锚照常唤醒（attempts=1、活体零重写），不做额外 rollout 探活（G11 面不重复建设）。
    const w2Main = mkC11("w2-main", { coord: w2MainId });
    const w2RelayMain = new MockRelay({ liveSessionId: w2MainId });
    const w2SessionMain = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: w2RelayMain.transportFactory, authAckTimeoutMs: 200 });
    const w2RMain = await wakeCoordSession({ session: w2SessionMain, workspaceKeyHint: "ws-1", coordSessionPath: w2Main.coordPath, content: "shell-w2", fsImpl: w2Main.fsImpl, ackTimeoutMs: 500, respTimeoutMs: 500 });
    ck.ok("W2-02 B1② 主控形状不误伤：sess_subagent 前缀判别只吃子代理形状（sess_subagent_agent_<id>/裸前缀→true；sess_<uuid>→false），主控锚照常唤醒（attempts=1、活体零重写、不误判非主控），且不做额外 rollout 探活（G11 探测面不重复建设）",
      isSubagentSessionId(w2SubagentId) && isSubagentSessionId("sess_subagent") &&
      !isSubagentSessionId(w2MainId) && !isSubagentSessionId("sess") && !isSubagentSessionId("") &&
      w2RMain.attempts === 1 && w2RMain.selfHealed === false &&
      fs.readFileSync(w2Main.coordPath, "utf8") === w2MainId + "\n" && w2Main.writesRef() === 0,
      { pred: [isSubagentSessionId(w2SubagentId), isSubagentSessionId(w2MainId)], r: w2RMain });

    // 03：③ toolResume 过滤守卫（server 黑盒）——子代理 id 前置拒绝，双锚内容+mtime 零触碰。
    const w2SrvRoot = path.join(BASE.root, "w2-resume-root");
    const w2Proj = path.join(BASE.root, "w2-resume-proj");
    fs.mkdirSync(path.join(w2SrvRoot, "sentinel"), { recursive: true });
    fs.mkdirSync(w2Proj, { recursive: true });
    const w2Cs = path.join(w2SrvRoot, "sentinel", "coord-session.txt");
    const w2Cw = path.join(w2SrvRoot, "sentinel", "coord-workspace.txt");
    fs.writeFileSync(w2Cs, w2MainId + "\n");
    fs.writeFileSync(w2Cw, "D:/keep-workspace\n");
    const w2CsMtime = fs.statSync(w2Cs).mtimeMs;
    const w2CwMtime = fs.statSync(w2Cw).mtimeMs;
    const w2Srv = startServer({ root: w2SrvRoot, cwd: w2Proj });
    let w2Rv = null;
    try { w2Rv = await w2Srv.call("resume", { session_id: w2SubagentId }); } finally { w2Srv.close(); }
    ck.ok("W2-03 B1③ toolResume 子代理 id 零写（server 黑盒）：resume(session_id=sess_subagent_agent_<id>) → ToolError 前置拒绝（isError + 错误串含 sess_subagent 与 report/mailbox 指引），coord-session.txt/coord-workspace.txt 内容+mtime 逐字不动（G4-03 主控双写正控不受影响）",
      w2Rv && w2Rv.isError === true && w2Rv.json &&
      String(w2Rv.json.error || "").includes("sess_subagent") && String(w2Rv.json.error || "").includes("report/mailbox") &&
      fs.readFileSync(w2Cs, "utf8") === w2MainId + "\n" &&
      fs.readFileSync(w2Cw, "utf8") === "D:/keep-workspace\n" &&
      fs.statSync(w2Cs).mtimeMs === w2CsMtime && fs.statSync(w2Cw).mtimeMs === w2CwMtime,
      { isError: w2Rv && w2Rv.isError, err: w2Rv && w2Rv.json && String(w2Rv.json.error || "").slice(0, 140), cs: fs.readFileSync(w2Cs, "utf8"), cw: fs.readFileSync(w2Cw, "utf8") });

    // 04：C3 rider 接线面钉——生产壳 eventId=真实最新未读事件 id（或 null 显式态），
    // 「latest」悬空缺省零残留（W1 偏差 (a) 清账）。
    const w2WatcherSrc = fs.readFileSync(new URL("../../../watcher/watcher.mjs", import.meta.url), "utf8");
    ck.ok("W2-04 C3 rider 生产接线源面钉：watcher.mjs 主路径 `latestUnreadEventId(rootDir, missionId, fsImpl)` 解析真实事件 id（无未读→null 显式无事件句），壳构造不再含 eventId:\"latest\"（W1 偏差 (a) 已接线）",
      /latestUnreadEventId\(rootDir, missionId, fsImpl\)/.test(w2WatcherSrc) &&
      w2WatcherSrc.includes("buildTemplateShell({ missionId, state: cond.status, summary: cond.title, eventId })") &&
      !w2WatcherSrc.includes('eventId: "latest"'),
      { wiring: w2WatcherSrc.includes("latestUnreadEventId(rootDir, missionId, fsImpl)"), old: w2WatcherSrc.includes('eventId: "latest"') });

    // 05：② 生产面存活性判别——唤醒前即拒（连-发前零建连），D3 配置告警终态落 signals，
    // reason 保留真实 kind（分类映射 workspace-anchor-missing 同族 D3，degrade 表在波外）。
    const w2RootWatch = path.join(BASE.root, "w2-watcher-hijack");
    writeCoord(w2RootWatch, w2SubagentId, "ws-1");
    const w2RelayWatch = new MockRelay();
    const w2W = buildWatcher({ root: w2RootWatch, relay: w2RelayWatch, now: () => Date.now(), board: [mission("m-w2", "done", Date.now() - 3600_000)], coord: false });
    const w2R = await w2W.tick();
    ck.ok("W2-05 B1② 唤醒前存活性判别（watcher 生产面）：锚=sess_subagent 形状 → 判非主控，与 inject ① 同款拒用（不建连/零桥帧/零唤醒），按 D3 配置告警终态落 signals（reason=coord-anchor-subagent 保留真实 kind，分类输入映射 workspace-anchor-missing 同族 D3、不落 unknown:D2 重试）",
      w2R.outcome === "D3" && w2W.disabled === "D3" && w2R.kind === "coord-anchor-subagent" &&
      w2RelayWatch.connCount === 0 &&
      readSignals(w2RootWatch).some((s) => s.cls === "D3" && s.reason === "coord-anchor-subagent"),
      { r: w2R, disabled: w2W.disabled, conn: w2RelayWatch.connCount, sig: readSignals(w2RootWatch) });
  }
}
