// @module suites/watcher-core/coord-session
/*!
 * watcher-core/coord-session.mjs —— coord-session 自愈与生产接线面：C11 双分支自愈 /
 * G4 b2 生产接线+锚互信根。拆分自 suites/watcher-core.mjs；断言本体零改动
 * （源面读取 new URL 相对深度按新落位接线）。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, sleep, grp } from "./shared.mjs";
import { MockRelay } from "./mock-relay.mjs";
import { startServer } from "../../harness/jsonrpc-client.mjs";
import { connectRelay } from "../../../watcher/relay.mjs";
import { wakeCoordSession, sessionErrorHit, resolveResponseWorkspaceKey, RESP_TIMEOUT_MS } from "../../../watcher/inject.mjs";
import { buildWatcher, mission } from "./fixtures.mjs";

export async function run(ctx) {
  const { BASE, mkC11 } = ctx;

  /* ======== C11 coord-session 自愈（b1/b2 双分支，DESIGN §5） ======== */
  {
    grp("C11 coord-session");
    // b2：stale 目标 → bridge-error(session-not-found) → 新建会话语义重试恰一次 → 应答 sessionId 原子刷新
    const heal = mkC11("c11-heal", { coord: "sess-stale" });
    const relayH = new MockRelay({ bridgeError: "session-not-found", bridgeErrorCount: 1, liveSessionId: "sess-live" });
    const sH = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayH.transportFactory, authAckTimeoutMs: 200 });
    const rH = await wakeCoordSession({ session: sH, workspaceKeyHint: "ws-1", coordSessionPath: heal.coordPath, content: "shell-c11", fsImpl: heal.fsImpl, ackTimeoutMs: 500, respTimeoutMs: 500 });
    const healedOk = rH.selfHealed === true && rH.attempts === 2 && rH.refreshed === true && rH.sessionId === "sess-live" &&
      fs.readFileSync(heal.coordPath, "utf8") === "sess-live\n" && heal.writesRef() === 1;
    // b1：活体目标 → 零重写（指针本就正确）
    const live = mkC11("c11-live", { coord: "sess-live" });
    const relayL = new MockRelay({ liveSessionId: "sess-live" });
    const sL = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayL.transportFactory, authAckTimeoutMs: 200 });
    const rL = await wakeCoordSession({ session: sL, workspaceKeyHint: "ws-1", coordSessionPath: live.coordPath, content: "shell-c11", fsImpl: live.fsImpl, ackTimeoutMs: 500, respTimeoutMs: 500 });
    const liveOk = rL.attempts === 1 && rL.selfHealed === false && rL.refreshed === false &&
      fs.readFileSync(live.coordPath, "utf8") === "sess-live\n" && live.writesRef() === 0;
    // OPEN-10.4：应答无 sessionId 字段 → b2 只建会话不刷新
    const noSid = mkC11("c11-nosid", { coord: "sess-stale" });
    const relayN = new MockRelay({ bridgeError: "session-expired", bridgeErrorCount: 1, liveSessionId: null });
    const sN = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayN.transportFactory, authAckTimeoutMs: 200 });
    const rN = await wakeCoordSession({ session: sN, workspaceKeyHint: "ws-1", coordSessionPath: noSid.coordPath, content: "shell-c11", fsImpl: noSid.fsImpl, ackTimeoutMs: 500, respTimeoutMs: 500 });
    const noSidOk = rN.selfHealed === true && rN.attempts === 2 && rN.refreshed === false && rN.sessionId === null &&
      fs.readFileSync(noSid.coordPath, "utf8") === "sess-stale\n" && noSid.writesRef() === 0;
    // b2 线上形状（L4 G6 定案）：b1 在 openBridge 即败未上线，唯一命令帧即 b2 的 createSession
    //（W3s 基线修订：命令帧前置 G8 握手两帧，按方法名寻址不再锚 captured[0]）
    const b2cmd = relayH.captured.find((c) => c.header && c.header[3] === "sendConversationCommandV4");
    const b2args = b2cmd && Array.isArray(b2cmd.body) && b2cmd.body.length === 1 ? b2cmd.body[0] : null; // G9：位置参数组
    const b2env = b2args && b2args.envelope ? b2args.envelope : null;
    ck.ok("C11-01 C11 双分支：b2 stale 目标→bridge-error(session-not-found/expired)→createSession+firstInput 命令面重试恰一次（L4 G6：envelope sessionId=null+type=createSession+payload={workspaceId:identity||path,firstInput:{text}}+issuedAt 数字，取代旧 sendText+sessionId:null 死路——inputAccepted 无 sessionId）→应答 sessionId 原子刷新 coord-session.txt（tmp+rename）；b1 活体目标零重写；应答无 sessionId 字段只建会话不刷新（OPEN-10.4）",
      healedOk && liveOk && noSidOk &&
      b2env && b2env.type === "createSession" && b2env.sessionId === null &&
      b2env.payload.workspaceId === "ws-1" && b2env.payload.firstInput.text === "shell-c11" &&
      typeof b2env.issuedAt === "number" && b2env.payload.sendText === undefined &&
      b2cmd.header[2] === "zcode-agent" && b2cmd.header[3] === "sendConversationCommandV4",
      { rH, rL, rN, b2: b2env });
    // C11-02 G6 触发面扩展（CLI 层·callP rejection）：b1 受理后 CLI 回 PromiseError 字样命中 session → b2 createSession 刷活体 id
    const rejHit = mkC11("c11-rej", { coord: "sess-stale" });
    const relayRj = new MockRelay({ rejectSessionFirstN: 1, liveSessionId: "sess-live-2" });
    const sRj = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayRj.transportFactory, authAckTimeoutMs: 200 });
    const rRj = await wakeCoordSession({ session: sRj, workspaceKeyHint: "ws-1", coordSessionPath: rejHit.coordPath, content: "shell-c11", fsImpl: rejHit.fsImpl, ackTimeoutMs: 500, respTimeoutMs: 500 });
    const cmdRj = relayRj.captured.filter((c) => c.header && c.header[3] === "sendConversationCommandV4"); // W3s：握手帧穿插，命令帧按方法名寻址
    const rjArg = (i) => (cmdRj[i] && Array.isArray(cmdRj[i].body) && cmdRj[i].body.length === 1 ? cmdRj[i].body[0] : null); // G9：位置参数组
    const b2rej = cmdRj.length === 2 && rjArg(1) ? rjArg(1).envelope : null;
    ck.ok("C11-02 G6 CLI 层触发面（callP rejection 宽匹配）：b1 sendText 应答窗内 PromiseError(message/code 命中 session 字样)→createSession+firstInput 重试恰一次（b1 帧 type=sendText 带 stale sessionId、b2 帧 type=createSession sessionId=null；W3s 基线修订：b1/b2 各前置 G8 握手两帧，命令帧按方法名寻址；G3 基线修订：命令 body=位置参数组 [params]）→应答 result.sessionId 原子刷新",
      rRj.selfHealed === true && rRj.attempts === 2 && rRj.refreshed === true && rRj.sessionId === "sess-live-2" &&
      fs.readFileSync(rejHit.coordPath, "utf8") === "sess-live-2\n" &&
      rjArg(0) && rjArg(0).envelope.type === "sendText" && rjArg(0).envelope.sessionId === "sess-stale" &&
      b2rej && b2rej.type === "createSession" && b2rej.sessionId === null, { rRj });
    // C11-03 G6 触发面扩展（CLI 层·ack rejected）：CommandAck status=rejected+reasonCode 命中 → b2
    const ackRej = mkC11("c11-ackrej", { coord: "sess-stale" });
    const relayAr = new MockRelay({ ackRejectFirstN: 1, liveSessionId: "sess-live-3" });
    const sAr = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayAr.transportFactory, authAckTimeoutMs: 200 });
    const rAr = await wakeCoordSession({ session: sAr, workspaceKeyHint: "ws-1", coordSessionPath: ackRej.coordPath, content: "shell-c11", fsImpl: ackRej.fsImpl, ackTimeoutMs: 500, respTimeoutMs: 500 });
    ck.ok("C11-03 G6 CLI 层触发面（ack rejected 宽匹配）：b1 应答窗内 CommandAck{status:rejected, reasonCode/message 命中 session}→createSession 重试恰一次→活体 id 刷新（不发明 reasonCode 枚举，仅字样宽匹配 L4 §5-2）",
      rAr.selfHealed === true && rAr.attempts === 2 && rAr.refreshed === true && rAr.sessionId === "sess-live-3" &&
      fs.readFileSync(ackRej.coordPath, "utf8") === "sess-live-3\n", { rAr });
    // C11-04 宽匹配负控制：非 session 拒因（busy 族）不触发 b2 不重试不刷新
    const noHit = mkC11("c11-nohit", { coord: "sess-keep" });
    const relayNh = new MockRelay({ rejectSessionFirstN: 1, rejectMessage: "A prompt is already running", rejectCode: "prompt-busy", liveSessionId: "sess-live-4" });
    const sNh = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayNh.transportFactory, authAckTimeoutMs: 200 });
    const rNh = await wakeCoordSession({ session: sNh, workspaceKeyHint: "ws-1", coordSessionPath: noHit.coordPath, content: "shell-c11", fsImpl: noHit.fsImpl, ackTimeoutMs: 500, respTimeoutMs: 500 });
    ck.ok("C11-04 G6 宽匹配负控制+helper 单测：非 session 拒因（A prompt is already running）不触发 b2（attempts=1 不重试不刷新指针）+sessionErrorHit 面（Session not found/session_not_found 命中、busy 文案/空参不命中，大小写不敏感）",
      rNh.selfHealed === false && rNh.attempts === 1 && rNh.refreshed === false && rNh.sessionId === null &&
      fs.readFileSync(noHit.coordPath, "utf8") === "sess-keep\n" &&
      sessionErrorHit("Session not found") === true && sessionErrorHit("session_not_found", "Error") === true &&
      sessionErrorHit("SESSION-EXPIRED") === true && sessionErrorHit("A prompt is already running") === false &&
      sessionErrorHit(null, undefined, "") === false, { rNh });
    // C11-05 G10 b2 自愈路径锚透传：wakeCoordSession(workspaceKeyHint) → openBridge 选中锚定工作区
    //（漂移面下 b2 createSession 不再建到 workspaces[0] 的 draft；hint 来源=watcher 的
    // sentinel/coord-workspace.txt，生产接线归会话级调用方）
    const wsHint = mkC11("c11-wshint", { coord: "sess-live" });
    const relayWh = new MockRelay({ workspaces: [{ workspacePath: "ws-first" }, { workspacePath: "ws-pinned" }], liveSessionId: "sess-live" });
    const sWh = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayWh.transportFactory, authAckTimeoutMs: 200 });
    const rWh = await wakeCoordSession({ session: sWh, coordSessionPath: wsHint.coordPath, content: "shell-c11", fsImpl: wsHint.fsImpl, workspaceKeyHint: "ws-pinned", ackTimeoutMs: 500, respTimeoutMs: 500 });
    const openWh = relayWh.received.map((m) => m.payload || {}).find((p) => p.zcode_type === "workspace-bridge-open");
    ck.ok("C11-05 G10 b2 自愈路径锚透传：wakeCoordSession(workspaceKeyHint)→openBridge 选中锚定工作区 ws-pinned（非 workspaces[0]=ws-first）——防 b2 createSession 建到漂移 draft 工作区（EXP10 R3-5 Txn4 实锤）",
      rWh.attempts === 1 && rWh.selfHealed === false && openWh && openWh.workspaceKey === "ws-pinned", { rWh, open: openWh && openWh.workspaceKey });
    // C11-06 respTimeoutMs 冷启覆盖（R3-3/R3-4 实测：createSession 冷启 19.2s、warm 0.5-0.8s；
    // 旧 2000ms 只覆盖 warm）——缺省窗常量≥25000ms 且 wakeCoordSession 缺省参数引用该常量。
    const injSrcC11 = fs.readFileSync(new URL("../../../watcher/inject.mjs", import.meta.url), "utf8");
    ck.ok("C11-06 respTimeoutMs 冷启覆盖常量锁（EXP10 R3-4 建议①）：RESP_TIMEOUT_MS≥25000ms（覆盖冷启 19.2s 实测、warm 0.5-0.8s）且 wakeCoordSession 缺省 respTimeoutMs 引用该常量（两段式异步回读改动面大不取）",
      RESP_TIMEOUT_MS >= 25000 && injSrcC11.includes("respTimeoutMs = RESP_TIMEOUT_MS"), { RESP_TIMEOUT_MS });
  }

  /* ======== G4 b2 生产接线 + 锚互信根（v0.10 G4：主路径切 wakeCoordSession） ======== */
  {
    grp("G4 b2-production");
    // 01：mock 主路径全链——coord 目标 stale → wakeCoordSession 内 b2 createSession 自愈恰一次
    // → coord-session.txt 原子刷新为活体 id（G5 守卫通过：锚 ws-1 命中）+ 锚保持原值 + verdict success
    const rootG4 = path.join(BASE.root, "g4-b2-prod");
    const relayG4 = new MockRelay({ bridgeError: "session-not-found", bridgeErrorCount: 1, liveSessionId: "sess-live-g4" });
    const wG4 = buildWatcher({ root: rootG4, relay: relayG4, now: () => Date.now(), board: [mission("m-g4", "done", Date.now() - 3600_000)] });
    const coordG4Path = path.join(rootG4, "sentinel", "coord-session.txt");
    fs.writeFileSync(coordG4Path, "sess-stale\n"); // buildWatcher 已写默认目标，这里改成 stale
    const rG4 = await wG4.tick();
    const coordG4 = fs.readFileSync(coordG4Path, "utf8");
    const anchorG4Path = path.join(rootG4, "sentinel", "coord-workspace.txt");
    const anchorG4 = fs.existsSync(anchorG4Path) ? fs.readFileSync(anchorG4Path, "utf8") : "";
    const cmdsG4 = relayG4.captured.filter((c) => c.header && c.header[3] === "sendConversationCommandV4");
    const b2envG4 = cmdsG4.length === 1 && Array.isArray(cmdsG4[0].body) && cmdsG4[0].body.length === 1 ? cmdsG4[0].body[0].envelope : null;
    const opensG4 = relayG4.received.filter((m) => m.payload && m.payload.zcode_type === "workspace-bridge-open").length;
    ck.ok("G4-01 主路径 b2 生产接线（mock 全链）：coord 目标 stale 经 wakeCoordSession 内 bridge-error(session-not-found)→createSession+firstInput 自愈恰一次→coord-session.txt 原子刷新为活体 id→verdict=success；G5 基线修订=锚由互信根预置（buildWatcher 写 ws-1，non-null hint 命中）且刷新后锚值不被覆盖；b1 未上线（openBridge 即败）故仅一帧 createSession",
      rG4.state === "transacting" && rG4.outcome === "success" && opensG4 === 2 &&
      coordG4 === "sess-live-g4\n" && anchorG4 === "ws-1\n" &&
      cmdsG4.length === 1 && b2envG4 && b2envG4.type === "createSession" && b2envG4.sessionId === null &&
      b2envG4.payload.workspaceId === "ws-1" &&
      String(b2envG4.payload.firstInput.text).startsWith("[orch-watch] mission=m-g4 state=done"),
      { rG4, coord: coordG4, anchor: anchorG4, opens: opensG4, cmds: cmdsG4.length, b2: b2envG4 });

    // 02：源面锁——主路径调用点=wakeCoordSession（无直调 sendPrompt）+sendPrompt 导出面保留
    // + respP guard 面不回退（W-RESP-04 同锁；G4 起 respP=V1 legacy 兜底）
    const wsrcG4 = fs.readFileSync(new URL("../../../watcher/watcher.mjs", import.meta.url), "utf8");
    const injSrcG4 = fs.readFileSync(new URL("../../../watcher/inject.mjs", import.meta.url), "utf8");
    ck.ok("G4-02 主路径接线源面锁：watcher.mjs 主路径调用 await wakeCoordSession({coordSessionPath:…,workspaceKeyHint…}) 且无直调 await sendPrompt；inject.mjs sendPrompt 导出面保留（兼容 mock/离线断言）；respP 仍由 guardPendingResponse 创建（W-RESP-04 面不回退）",
      wsrcG4.includes("await wakeCoordSession({") && wsrcG4.includes("coordSessionPath: coordSessionFile") &&
      wsrcG4.includes("workspaceKeyHint,") && !wsrcG4.includes("await sendPrompt({") &&
      injSrcG4.includes("export async function sendPrompt") &&
      wsrcG4.includes('guardPendingResponse(session.awaitData("session-send-response"'),
      { wake: wsrcG4.includes("await wakeCoordSession({"), send: wsrcG4.includes("await sendPrompt({") });

    // 03：toolResume 双写锁（锚互信根）——server 黑盒 resume 后双文件在位：coord-session.txt
    // 单行 session id + coord-workspace.txt 单行 root 同源派生键（projectDir=cwd）。响应照常。
    const srvRootG4 = path.join(BASE.root, "g4-resume-root");
    const projDirG4 = path.join(BASE.root, "g4-project");
    fs.mkdirSync(projDirG4, { recursive: true });
    // G5：启动补位只在既有 sentinel/ 目录内写（不新建目录——sentinel_health 的 available
    // 判据=l0 V13「缺 sentinel/ → available:false」语义零改）；R4 场景即 sentinel 在而锚缺。
    fs.mkdirSync(path.join(srvRootG4, "sentinel"), { recursive: true });
    const srvG4 = startServer({ root: srvRootG4, cwd: projDirG4 });
    // G5：server 启动补位（仅缺失时写）——resume 前锚应已在位（app 重启后 resume-only 双写的窗口修复）
    const startupAnchorPath = path.join(srvRootG4, "sentinel", "coord-workspace.txt");
    for (let i = 0; i < 60 && !fs.existsSync(startupAnchorPath); i++) await sleep(50);
    const startupAnchorG4 = fs.existsSync(startupAnchorPath) ? fs.readFileSync(startupAnchorPath, "utf8") : "";
    let rvG4;
    try {
      rvG4 = await srvG4.call("resume", { session_id: "sess-g4-anchor" });
    } finally {
      srvG4.close();
    }
    const csG4 = fs.readFileSync(path.join(srvRootG4, "sentinel", "coord-session.txt"), "utf8");
    const cwG4 = fs.readFileSync(path.join(srvRootG4, "sentinel", "coord-workspace.txt"), "utf8");
    ck.ok("G4-03 toolResume 双写锁（锚互信根，server 黑盒）：resume(session_id) 同点原子写 sentinel/coord-session.txt 与 sentinel/coord-workspace.txt（单行 workspace 键=root 同源派生 projectDir；默认 root=<projectDir>/.zcode/orchestrator 口径），两文件各独立原子写、resume 响应照常；G5 增补=server 启动补位先于 resume 已在位（仅既有 sentinel/ 目录内、仅缺失时写；不新建目录，resume 同值覆盖）",
      !rvG4.isError && rvG4.json !== null && csG4 === "sess-g4-anchor\n" && cwG4 === path.resolve(projDirG4) + "\n" &&
      startupAnchorG4 === path.resolve(projDirG4) + "\n",
      { isError: rvG4.isError, coord: csG4, anchor: cwG4, startupAnchor: startupAnchorG4 });

    // 04（G5 增）：b2 刷新工作区守卫（防锚劫持）——三面：
    //   a) 无锚 legacy 逃生口（allowLegacyFirst）b2 成功但工作区未验证 → 不刷新、warning 落告警面；
    //   b) 锚命中但 createSession 应答报告不同工作区 → 不刷新、response-mismatch warning；
    //   c) 锚命中+应答无工作区字段（宽读缺省）→ 刷新放行（C11-01/G4-01 已覆盖正控）
    const guardA = mkC11("g5-guard-a", { coord: "sess-stale" });
    const relayGA = new MockRelay({ bridgeError: "session-not-found", bridgeErrorCount: 1, liveSessionId: "sess-live-ga" });
    const sGA = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayGA.transportFactory, authAckTimeoutMs: 200 });
    const warnA = [];
    const rGA = await wakeCoordSession({ session: sGA, coordSessionPath: guardA.coordPath, content: "shell-g5", fsImpl: guardA.fsImpl, allowLegacyFirst: true, ackTimeoutMs: 500, respTimeoutMs: 500, warn: (w) => warnA.push(w) });
    const guardB = mkC11("g5-guard-b", { coord: "sess-stale" });
    const relayGB = new MockRelay({ bridgeError: "session-not-found", bridgeErrorCount: 1, liveSessionId: "sess-live-gb", chanWorkspaceKey: "ws-evil" });
    const sGB = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayGB.transportFactory, authAckTimeoutMs: 200 });
    const warnB = [];
    const rGB = await wakeCoordSession({ session: sGB, workspaceKeyHint: "ws-1", coordSessionPath: guardB.coordPath, content: "shell-g5", fsImpl: guardB.fsImpl, ackTimeoutMs: 500, respTimeoutMs: 500, warn: (w) => warnB.push(w) });
    ck.ok("G4-04 G5 b2 刷新工作区守卫（防锚劫持）：a) 无锚 legacy 逃生口下 b2 自愈成功（selfHealed=true/sessionId 回读）但 workspaceVerified=false→coord-session.txt 零重写（保持原 stale 锚）+warning b2-refresh-blocked:no-workspace-anchor；b) 锚命中但应答 workspaceKey=ws-evil≠锚 → 不刷新+warning response-workspace-mismatch（应答工作区宽读 resolveResponseWorkspaceKey）；存量锚永不被错工作区覆盖",
      rGA.selfHealed === true && rGA.refreshed === false && rGA.workspaceVerified === false &&
      fs.readFileSync(guardA.coordPath, "utf8") === "sess-stale\n" && guardA.writesRef() === 0 &&
      warnA.some((w) => w.includes("no-workspace-anchor")) &&
      rGB.selfHealed === true && rGB.refreshed === false && rGB.workspaceVerified === false &&
      fs.readFileSync(guardB.coordPath, "utf8") === "sess-stale\n" && guardB.writesRef() === 0 &&
      warnB.some((w) => w.includes("response-workspace-mismatch")) &&
      resolveResponseWorkspaceKey({ result: { workspacePath: "ws-1" } }) === "ws-1" &&
      resolveResponseWorkspaceKey({ accepted: true }) === null,
      { a: rGA, wa: warnA, b: rGB, wb: warnB });
  }
}
