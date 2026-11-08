// @module suites/watcher-core/relay-bridge
/*!
 * watcher-core/relay-bridge.mjs —— 中继/桥接面：W-RLY RELAY V2 / W-BRG BRIDGE /
 * W-REG REG 级形状钉 / W-BRG2 wake 链 04D-3 / W-WSA 工作区锚钉。
 * 拆分自 suites/watcher-core.mjs；断言本体零改动。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, sleep, grp } from "./shared.mjs";
import { MockRelay } from "./mock-relay.mjs";
import { buildWatcher, mission, readSignals } from "./fixtures.mjs";
import { RelaySession, connectRelay, mapClose, mapErrorFrame, buildWs2Url, isSignalType } from "../../../watcher/relay.mjs";
import { crc32, encodeRpcFrame, decodeRpcFrames, openBridge, LIMITS, bridgeOf, mapBridgeFailure, BRIDGE_FAILURE_REASONS, workspaceKeyMatches, normalizeWorkspaceKey } from "../../../watcher/bridge.mjs";

export async function run(ctx) {
  const { BASE } = ctx;

  /* ======== W-RLY RELAY V2 ======== */
  {
    ck.ok("W-RLY-01 关断码映射全表（W-W §3 close face）",
      mapClose(4004).cls === "D3" && mapClose(4009).cls === "kicked" && mapClose(4010).cls === "D2" &&
      mapClose(4011).cls === "resign" && mapClose(4012).cls === "D3" && mapClose(4013).cls === "D1" && mapClose(5999).cls === "D2");
    ck.ok("W-RLY-02 带内 error 五枚举映射", mapErrorFrame({ code: "KICKED" }).cls === "kicked" && mapErrorFrame({ code: "AUTH_FAILED" }).cls === "D1" && mapErrorFrame({ code: "DEVICE_OFFLINE" }).cls === "D2" && mapErrorFrame({ code: "WRONG_PARAM" }).cls === "D3" && mapErrorFrame({ code: "INTERNAL" }).cls === "D2");
    const relay = new MockRelay();
    const s1 = await connectRelay({ url: "ws://mock/ws2", deviceSid: "sid", transportFactory: relay.transportFactory, authAckTimeoutMs: 200 });
    ck.ok("W-RLY-03 auth 握手 matched 即桥接可进（auth_init 严格面：无 role 越界字段，L2-findings §4 ④）", s1 && !s1.kicked && relay.received.some((m) => m.type === "auth_init" && m.role === undefined && m.device_sid === "sid" && m.client_ts > 1000000000));
    const waiting = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: new MockRelay({ pairStatus: "waiting" }).transportFactory, authAckTimeoutMs: 200 }).catch((e) => e);
    ck.ok("W-RLY-04 pair_status waiting→auth-not-matched（15s 闸内放弃语义）", waiting.code === "auth-not-matched");
    const timeout = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: new MockRelay({ pairStatus: false }).transportFactory, authAckTimeoutMs: 30 }).catch((e) => e);
    ck.ok("W-RLY-05 auth_ack 15s 闸超时（此处 30ms 加速）", timeout.code === "auth-ack-timeout");
    const rKick = new MockRelay({ mode: "kicked" });
    const sKick = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: rKick.transportFactory, authAckTimeoutMs: 200 });
    await sleep(5);
    ck.ok("W-RLY-06 互踢第一禁令：KICKED 静默 close+kicked 标记，绝不重连（连接数恒 1）", sKick.kicked === true && sKick.closed === true && sKick.closeInfo.cls === "kicked" && rKick.connCount === 1);
    const noiseRelay = new MockRelay();
    const s2 = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: noiseRelay.transportFactory, authAckTimeoutMs: 200 });
    const t = s2.transport;
    t.serverSend({ type: "data", zcode_type: "unknown-push", payloadLen: 580 }); // 非请求推送（EXP-3 F4）
    t.serverSend({ type: "data", zcode_type: "desktop-heartbeat" });
    t.serverSend({ type: "data", payload: { zcode_type: "desktop-heartbeat", seq: 1 } }); // 新形噪声：payload 内层 type 不匹配挂起请求
    ck.ok("W-RLY-07 噪声 data 帧=计数不解析不当错误（顶层裸帧与新形 payload 均按噪声计）", s2.metrics.noiseData === 3 && s2.metrics.parseErrors === 0 && isSignalType("auth_ack") && !isSignalType("data"));
    const respP = s2.awaitData("session-send-response", { timeoutMs: 200, reqId: "r1" });
    t.serverSend({ type: "data", zcode_type: "other-frame" });
    t.serverSend({ type: "data", payload: { zcode_type: "session-send-response", result: { ok: true } } });
    const gotResp = await respP;
    ck.ok("W-RLY-08 awaitData 先挂后发形态：噪声不吞匹配帧且 resolve 上抛 payload 内层", gotResp && gotResp.result && gotResp.result.ok === true && gotResp.type === undefined && gotResp.payload === undefined);
    const ackP = s2.awaitAck(42, 200);
    t.serverSend({ type: "rpc-frame-ack", ackMessageSeq: 41 }); // 不匹配忽略
    t.serverSend({ type: "rpc-frame-ack", ackMessageSeq: 42 });
    ck.ok("W-RLY-09 rpc-frame-ack 按 seq 对上（三证①）", (await ackP).ackMessageSeq === 42);
    const errP = s2.awaitData("never-coming", { timeoutMs: 200 });
    t.serverSend({ type: "error", code: "DEVICE_OFFLINE" });
    const errGot = await errP.catch((e) => e);
    ck.ok("W-RLY-10 error 帧拒挂起请求并携带面分类", errGot.code === "relay-error" && errGot.cls === "D2");
    ck.ok("W-RLY-11 ws2 URL 组装：token 只进 query（日志面恒 urlSafeLabel）", buildWs2Url({ origin: "https://zcode.z.ai/", token: "SECRET", mid: "m1" }).includes("token=SECRET&mid=m1") && "ws2?token=REDACTED" === new RelaySession().urlSafeLabel);
    ck.ok("W-RLY-12 scheme 闸单测钉死（https→wss/http→ws；此前仅 mock 注入绕行未断言，L2-findings §5.3 同类核）",
      buildWs2Url({ origin: "https://zcode.z.ai/", token: "S", mid: "m" }).startsWith("wss://zcode.z.ai/api/v1/remote/ws2?") &&
      buildWs2Url({ origin: "http://x.example", token: "S", mid: "m" }).startsWith("ws://x.example/api/v1/remote/ws2?"));
  }

  /* ======== W-BRG BRIDGE ======== */
  {
    ck.ok("W-BRG-01 crc32 IEEE 反射标准向量（123456789→0xCBF43926）", crc32(Buffer.from("123456789")) === 0xcbf43926);
    /* v0.10 W3 基线修订：04D-3 形状（信封/换名字段/双序/checksum 对象/删 sentAt），W-W §3 世代面退役 */
    const msgBytes = Buffer.from('{"k":"v"}', "utf8");
    const frame = encodeRpcFrame({ bridgeSessionId: "bridge-a", data: msgBytes, physicalSeq: 7, messageSeq: 3 });
    const dec = decodeRpcFrames([frame]);
    ck.ok("W-BRG-02 04D-3 单帧 roundtrip：信封 type=data+payload.zcode_type=rpc-frame+换名字段（seq/messageSeq/fragmentIndex/fragmentCount/messageBytes）+checksum 对象（crc32/8 位小写 hex）",
      frame.type === "data" && frame.payload.zcode_type === "rpc-frame" && dec.ok && dec.seq === 7 && dec.messageSeq === 3 &&
      dec.bytes.equals(msgBytes) && frame.payload.checksum.algorithm === "crc32" &&
      frame.payload.checksum.value === crc32(msgBytes).toString(16).padStart(8, "0"), frame.payload);
    const tampered = [{ ...frame.payload, dataBase64: Buffer.from("tampered").toString("base64") }];
    ck.ok("W-BRG-03 checksum 篡改拒收", decodeRpcFrames(tampered).ok === false && decodeRpcFrames(tampered).error === "checksum-mismatch");
    ck.ok("W-BRG-04 分片断号拒收", decodeRpcFrames([{ ...frame.payload, fragmentIndex: 5 }]).error === "fragment-gap");
    ck.ok("W-BRG-05 超 64 片拒收（W-F3 §2.4 限值）",
      decodeRpcFrames(Array.from({ length: 65 }, (_, i) => ({ ...frame.payload, fragmentIndex: i, fragmentCount: 65 }))).error === "too-many-fragments");
    const EXPECT_KEYS = ["bridgeSessionId", "checksum", "dataBase64", "fragmentCount", "fragmentIndex", "messageBytes", "messageSeq", "seq", "zcode_type"].sort();
    ck.ok("W-BRG-06 04D-3 strict 形状：帧键集合恰等且无 sentAt 残留（.strict() 多余键=直接拒，L2 §7.3「多余且致命」；30s 组装闸属接收端时序非帧字段）",
      JSON.stringify(Object.keys(frame.payload).sort()) === JSON.stringify(EXPECT_KEYS) && frame.payload.sentAt === undefined &&
      frame.payload.identity === undefined && frame.payload.fragment === undefined, Object.keys(frame.payload));
    let idErr = null;
    let idShapeErr = null;
    try { encodeRpcFrame({ bridgeSessionId: "x".repeat(257), data: Buffer.from("1"), physicalSeq: 1, messageSeq: 1 }); } catch (e) { idErr = e; }
    try { encodeRpcFrame({ bridgeSessionId: "bad id!", data: Buffer.from("1"), physicalSeq: 1, messageSeq: 1 }); } catch (e) { idShapeErr = e; }
    ck.ok("W-BRG-07 transportId 双闸：id>256 字符拒收（frame-id-too-long）+regex 越界字符拒收（^[A-Za-z0-9._~-]+$）", idErr && idErr.code === "frame-id-too-long" && idShapeErr && idShapeErr.code === "frame-id-shape");
    ck.ok("W-BRG-08 帧限值常量定案（1MiB/16MiB/64/30s/256）", LIMITS.fragmentMax === 1048576 && LIMITS.msgMax === 16777216 && LIMITS.maxFragments === 64 && LIMITS.assembleTimeoutMs === 30000 && LIMITS.maxIdChars === 256);
    const relay = new MockRelay();
    const s = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relay.transportFactory, authAckTimeoutMs: 200 });
    const bridge = await openBridge({ session: s, allowLegacyFirst: true }); // G5：legacy [0] 需显式 opt-in
    const openFrame9 = relay.received.map((m) => m.payload || {}).find((p) => p.zcode_type === "workspace-bridge-open");
    ck.ok("W-BRG-09 L2 编排（04D-3 深形）：list→派生键→open（bridgeSessionId 终端自造=请求值且 ready 回显相等）→ready 深消费（initialTaskId=ready.bridge.initialTaskId，顶层无此字段；项无 workspaceKey 字段，键由 workspacePath 派生）",
      bridge.workspaceKey === "ws-1" && bridge.bridgeSessionId === openFrame9.bridgeSessionId &&
      /^[A-Za-z0-9._~-]+$/.test(bridge.bridgeSessionId) && bridge.bridgeSessionId.length <= 256 &&
      bridge.initialTaskId === "task-1" && bridgeOf(s) === bridge.rpc, bridge);
    const sEmpty = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: new MockRelay({ emptyWorkspace: true }).transportFactory, authAckTimeoutMs: 200 });
    const emptyErr = await openBridge({ session: sEmpty, allowLegacyFirst: true }).catch((e) => e);
    ck.ok("W-BRG-10 workspace-list 空 → bridge-list-empty（D3 面）", emptyErr.code === "bridge-list-empty");

    /* ---- W-REG REG 级形状钉（v0.9-L2：payload 内层/requestId 字段名/派生消费；workspace-list 过校验面） ---- */
    {
      // REG-01/02/03 出站构帧形状 + 应答内层消费 + L1 出站白名单
      const relayR = new MockRelay();
      const sR = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayR.transportFactory, authAckTimeoutMs: 200 });
      const got = await sR.request({ type: "data", payload: { zcode_type: "workspace-list-request", requestId: "ow-reg" } }, { timeoutMs: 200 });
      const sentData = relayR.received.find((m) => m.type === "data");
      ck.ok("W-REG-01 出站帧 L2 语义装 payload 内层且 requestId 新字段名（顶层无 zcode_type/req_id 漂移残留）",
        sentData && sentData.type === "data" && sentData.payload && sentData.payload.zcode_type === "workspace-list-request" &&
        sentData.payload.requestId === "ow-reg" && sentData.zcode_type === undefined && sentData.req_id === undefined &&
        sentData.workspace_key === undefined, sentData);
      ck.ok("W-REG-02 应答消费 payload 内层（resolve 上抛内层非外层信封；result.workspaces 可达）",
        got && got.requestId === "ow-reg" && got.type === undefined && got.payload === undefined && got.result && Array.isArray(got.result.workspaces), got);
      ck.ok("W-REG-03 本连接出站 type 全落 L1 白名单 [auth_init,pair_status_query,data]（contract.ts:41）",
        relayR.received.length > 0 && relayR.received.every((m) => ["auth_init", "pair_status_query", "data"].includes(m.type)), relayR.received.map((m) => m.type));
      // REG-04 requestId 关联匹配：错配帧计噪声不吞请求，同号帧方达
      const sM = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: new MockRelay().transportFactory, authAckTimeoutMs: 200 });
      const pM = sM.awaitData("workspace-list-response", { timeoutMs: 200, reqId: "ow-a" });
      sM.transport.serverSend({ type: "data", payload: { zcode_type: "workspace-list-response", requestId: "ow-other" } });
      sM.transport.serverSend({ type: "data", payload: { zcode_type: "workspace-list-response", requestId: "ow-a" } });
      const gotM = await pM;
      ck.ok("W-REG-04 requestId 关联匹配：错配帧归噪声不吞请求，同号帧方达", gotM.requestId === "ow-a" && sM.metrics.noiseData === 1, { got: gotM.requestId, noise: sM.metrics.noiseData });
      // REG-05 派生消费：hint 按派生键匹配 + workspaceIdentity.trim 优先于 workspacePath
      const relayI = new MockRelay({ workspaces: [
        { workspacePath: "D:/a", label: "A", kind: "local", workspaceIdentity: "  ident-a  " },
        { workspacePath: "D:/b", label: "B", kind: "local" },
      ] });
      const sI = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayI.transportFactory, authAckTimeoutMs: 200 });
      const bHint = await openBridge({ session: sI, workspaceKeyHint: "ident-a" });
      const openHint = relayI.received.map((m) => m.payload || {}).find((p) => p.zcode_type === "workspace-bridge-open");
      ck.ok("W-REG-05 hint 按派生键匹配且 workspaceIdentity.trim 优先（web-remote-control.ts:744-748 语义）；bridgeSessionId 终端自造且 ready 回显=请求值",
        bHint.workspaceKey === "ident-a" && bHint.bridgeSessionId === openHint.bridgeSessionId &&
        /^[A-Za-z0-9._~-]+$/.test(bHint.bridgeSessionId), bHint);
      const relayNo = new MockRelay();
      const sI2 = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayNo.transportFactory, authAckTimeoutMs: 200 });
      const bNo = await openBridge({ session: sI2, allowLegacyFirst: true });
      const openNo = relayNo.received.map((m) => m.payload || {}).find((p) => p.zcode_type === "workspace-bridge-open");
      ck.ok("W-REG-06 无 hint 取首个并派生（键=workspacePath，不读项上不存在的 workspaceKey）", bNo.workspaceKey === "ws-1" && bNo.bridgeSessionId === openNo.bridgeSessionId, bNo);
      // REG-07 picked 派生为 null 时回退 result.activeWorkspaceKey（findings §4 ③ fallback）
      const relayF = new MockRelay({ workspaces: [{ label: "only", kind: "local" }], activeWorkspaceKey: "act-key" });
      const sF = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayF.transportFactory, authAckTimeoutMs: 200 });
      const bF = await openBridge({ session: sF, allowLegacyFirst: true });
      ck.ok("W-REG-07 picked 派生为空回退 activeWorkspaceKey", bF.workspaceKey === "act-key", bF);
    }
  }

  /* ======== W-BRG2 wake 链 04D-3（openBridge 深形 + ack 回程生死项，DESIGN §4.1/§4.3） ======== */
  {
    grp("W-BRG2 bridge-04d3");
    // 深形：自造 id/回显/identity 透传/initialTaskId 深读 + error 快路径
    const relayErr = new MockRelay({ bridgeError: "session-not-found", bridgeErrorCount: 1 });
    const sErr = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayErr.transportFactory, authAckTimeoutMs: 200 });
    const tFast = Date.now();
    const errFast = await openBridge({ session: sErr, openTimeoutMs: 10000, allowLegacyFirst: true }).catch((e) => e);
    const fastMs = Date.now() - tFast;
    const relayId = new MockRelay({ bridgeGeneration: 2, recoveryId: "rec-9" });
    const sId = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayId.transportFactory, authAckTimeoutMs: 200 });
    const bA = await openBridge({ session: sId, allowLegacyFirst: true });
    const openA = relayId.received.map((m) => m.payload || {}).find((p) => p.zcode_type === "workspace-bridge-open");
    const bB = await openBridge({ session: sId, allowLegacyFirst: true }); // 每次 openBridge 新造（b2 自愈重开语义；旧桥 dispose 顶替）
    const sentId = await bB.rpc.send(Buffer.from("id-echo"), { ackTimeoutMs: 500 });
    const sentPl = relayId.received.map((m) => m.payload || {}).filter((p) => p.zcode_type === "rpc-frame").pop();
    const decId = decodeRpcFrames([sentPl]);
    ck.ok("W-BRG2-01 openBridge 深形：bridgeSessionId 终端自造（≤256∧^[A-Za-z0-9._~-]+$，两次 open 新造不同 id）+ready 回显逐字段相等+identity 三元组透传进帧（bridgeGeneration/recoveryId 与 ready 逐字段相等）+initialTaskId 深读 bridge.initialTaskId+error 快路径即时 reject（reason 携带不白等 10s）",
      bA.bridgeSessionId !== bB.bridgeSessionId &&
      /^[A-Za-z0-9._~-]+$/.test(bA.bridgeSessionId) && bA.bridgeSessionId.length <= 256 &&
      bA.bridgeSessionId === openA.bridgeSessionId && bA.initialTaskId === "task-1" &&
      bB.bridgeGeneration === 2 && bB.recoveryId === "rec-9" &&
      sentPl.bridgeSessionId === bB.bridgeSessionId && sentPl.bridgeGeneration === 2 && sentPl.recoveryId === "rec-9" &&
      decId.ok && decId.identity.bridgeSessionId === bB.bridgeSessionId && decId.identity.bridgeGeneration === 2 && decId.identity.recoveryId === "rec-9" &&
      errFast.code === "bridge-error" && errFast.reason === "session-not-found" && fastMs < 10000 &&
      bridgeOf(sErr) === null, { fastMs, err: errFast.code + ":" + errFast.reason });
    // ack 回程生死项：正常面 ack 释放重放窗；无 ack 面 saturated→replayBufferExceeded→bridge-degraded
    const relayAck = new MockRelay();
    const sAck = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayAck.transportFactory, authAckTimeoutMs: 200 });
    const bAck = await openBridge({ session: sAck, allowLegacyFirst: true });
    const rAck = await bAck.rpc.send(Buffer.from("payload-bytes"), { ackTimeoutMs: 500 });
    const mapAll = BRIDGE_FAILURE_REASONS.map((r) => mapBridgeFailure(r));
    const relaySat = new MockRelay({ mode: "noack" });
    const sSat = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relaySat.transportFactory, authAckTimeoutMs: 200 });
    const bSat = await openBridge({ session: sSat, allowLegacyFirst: true });
    bSat.rpc.highWaterMarkBytes = 4;
    bSat.rpc.replayBufferMaxBytes = 8;
    const e1 = await bSat.rpc.send(Buffer.from("12345678"), { ackTimeoutMs: 30 }).catch((e) => e); // noack→rpc-ack-timeout（窗内 8B>高水位 4B）
    const e2 = await bSat.rpc.send(Buffer.from("9"), { ackTimeoutMs: 30 }).catch((e) => e);        // 9>8 顶→terminal degraded
    const e3 = await bSat.rpc.send(Buffer.from("a"), { ackTimeoutMs: 30 }).catch((e) => e);        // 终态后续发全拒
    ck.ok("W-BRG2-02 ack 回程（生死项）：对岸 ack 释放重放窗（ackMessageSeq 对上+replayBytes 归零）+happy 面 saturated 不触发（mock 对拍）+无 ack 面 unacked>高水位→saturated→超顶→terminal degraded replayBufferExceeded→后续 send 拒+reason 枚举 11 值全表映射降级面",
      rAck.ack.ackMessageSeq === rAck.messageSeq && bAck.rpc.replayBytes === 0 && bAck.rpc.saturated === false && bAck.rpc.degraded === null &&
      e1.code === "rpc-ack-timeout" && bSat.rpc.saturated === true && bSat.rpc.replayBytes === 8 &&
      e2.code === "bridge-degraded" && e2.reason === "replayBufferExceeded" && bSat.rpc.degraded.reason === "replayBufferExceeded" &&
      e3.code === "bridge-degraded" && BRIDGE_FAILURE_REASONS.length === 11 &&
      mapAll.every((m) => ["D1", "D2", "D3", "kicked"].includes(m.cls)), { e1: e1.code, e2: e2.code, e3: e3.code });
  }

  /* ======== W-WSA 工作区锚钉（v0.10 G3 G10；G5 基线修订=无锚/未命中 fail-loud） ======== */
  {
    grp("W-WSA workspace-anchor");
    const WS_PROJ = { workspacePath: "D:/proj", label: "proj", kind: "local" };
    const WS_DRAFT = { workspacePath: "C:/Users/u/.zcode/workspace/draft-x", label: "draft", kind: "local" };
    const openPayloadOf = (relay) => relay.received.map((m) => m.payload || {}).find((p) => p.zcode_type === "workspace-bridge-open");
    // 01（G5 改判言：原「无锚 legacy workspaces[0]+首开记锚」被安全面裁决取代）：无锚 fail-loud——
    // watcher 不开放桥（零 workspace-bridge-open 帧）、不写任何锚文件、事务终态 D3 配置告警
    //（workspace-anchor-missing）。判据=R4 已实证最坏结果（错工作区注入+b2 建会话+锚劫持）；
    // 锚只由互信根面写（server 启动补位/toolResume/SessionStart），watcher 绝不写锚。
    const root1 = path.join(BASE.root, "wsa-01");
    const relay1 = new MockRelay({ workspaces: [WS_PROJ] });
    const w1 = buildWatcher({ root: root1, relay: relay1, now: () => Date.now(), board: [mission("m-wsa", "done", Date.now() - 3600_000)], workspaceAnchor: null });
    const r1 = await w1.tick();
    const open1 = openPayloadOf(relay1);
    const anchorPath = path.join(root1, "sentinel", "coord-workspace.txt");
    const sig1 = readSignals(root1);
    ck.ok("W-WSA-01 G5 无锚 fail-loud（裁决：安全面优先——错工作区注入+锚劫持是 R4 三方实锤的最坏结果；fail-loud 阻断 vs 逐候选容错，取前者：逐候选在全部候选 b1 被拒后仍需无锚选 b2 工作区，语义无法判定且放大桥生命周期成本）：watcher 终态 D3（workspace-anchor-missing）零 workspace-bridge-open/零命令帧、coord-workspace.txt 仍缺失（watcher 不写锚）",
      r1.outcome === "D3" && w1.disabled === "D3" && !open1 && !fs.existsSync(anchorPath) &&
      sig1.some((s) => s.cls === "D3" && s.reason === "workspace-anchor-missing"),
      { r1, open: open1 && open1.workspaceKey, anchorExists: fs.existsSync(anchorPath), sig: sig1 });
    // 01b：直接调用面缺省 fail-loud（openBridge 无 hint）——明确错误码+文案（预置锚指引）
    const relay1b = new MockRelay({ workspaces: [WS_PROJ] });
    const s1b = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relay1b.transportFactory, authAckTimeoutMs: 200 });
    const noAnchorErr = await openBridge({ session: s1b }).catch((e) => e);
    const noAnchorOpen = openPayloadOf(relay1b);
    ck.ok("W-WSA-01b G5 openBridge 无 hint 缺省 fail-loud：code=bridge-anchor-missing（文案含 coord-workspace.txt/allowLegacyFirst 指引）、零 workspace-bridge-open 帧、桥不登记（bridgeOf=null）",
      noAnchorErr && noAnchorErr.code === "bridge-anchor-missing" &&
      String(noAnchorErr.message).includes("coord-workspace.txt") && String(noAnchorErr.message).includes("allowLegacyFirst") &&
      !noAnchorOpen && bridgeOf(s1b) === null,
      { err: noAnchorErr && noAnchorErr.code, open: noAnchorOpen && noAnchorOpen.workspaceKey });
    // 02：workspace-list 顺序漂移（draft 置首）→ 锚命中仍开 D:/proj；已存在锚不被覆盖
    fs.mkdirSync(path.join(root1, "sentinel"), { recursive: true });
    fs.writeFileSync(anchorPath, "D:/proj\n"); // 互信根面预置（判 02 需有锚）
    const relay2 = new MockRelay({ workspaces: [WS_DRAFT, WS_PROJ] });
    const w2 = buildWatcher({ root: root1, relay: relay2, now: () => Date.now(), board: [mission("m-wsa", "done", Date.now() - 3600_000)], workspaceAnchor: "D:/proj" });
    const r2 = await w2.tick();
    const open2 = openPayloadOf(relay2);
    const anchor2 = fs.readFileSync(anchorPath, "utf8");
    ck.ok("W-WSA-02 G10 锚钉抗漂移：workspace-list 顺序漂移（draft 置首，EXP10 R3-5 Txn4 实测形态）后仍按锚开 D:/proj；锚值不被覆盖（watcher 只读锚）",
      r2.outcome === "success" && open2 && open2.workspaceKey === "D:/proj" && anchor2 === "D:/proj\n",
      { r2, open: open2 && open2.workspaceKey, anchor: anchor2 });
    // 03（G5 改判言）：锚未命中 → fail-loud（bridge-anchor-mismatch），不再回退 legacy；旧锚保留；
    // 直接桥面命中面 workspaceHintMatched=true 不变
    const root3 = path.join(BASE.root, "wsa-03");
    fs.mkdirSync(path.join(root3, "sentinel"), { recursive: true });
    const anchor3Path = path.join(root3, "sentinel", "coord-workspace.txt");
    fs.writeFileSync(anchor3Path, "D:/gone\n");
    const relay3 = new MockRelay({ workspaces: [WS_DRAFT, WS_PROJ] });
    const w3 = buildWatcher({ root: root3, relay: relay3, now: () => Date.now(), board: [mission("m-wsa", "done", Date.now() - 3600_000)], workspaceAnchor: "D:/gone" });
    const r3 = await w3.tick();
    const open3 = openPayloadOf(relay3);
    const anchor3 = fs.readFileSync(anchor3Path, "utf8");
    const relay3b = new MockRelay({ workspaces: [WS_DRAFT, WS_PROJ] });
    const s3b = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relay3b.transportFactory, authAckTimeoutMs: 200 });
    const bMiss = await openBridge({ session: s3b, workspaceKeyHint: "D:/gone" }).catch((e) => e);
    const relay3c = new MockRelay({ workspaces: [WS_DRAFT, WS_PROJ] });
    const s3c = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relay3c.transportFactory, authAckTimeoutMs: 200 });
    const bHit = await openBridge({ session: s3c, workspaceKeyHint: "D:/proj" });
    ck.ok("W-WSA-03 G5 锚未命中 fail-loud：watcher 终态 D3（workspace-anchor-mismatch）零 open 帧且旧锚原值保留；直接桥面 code=bridge-anchor-mismatch（不回退 workspaces[0]）；命中面 workspaceHintMatched=true 可观测",
      r3.outcome === "D3" && w3.disabled === "D3" && !open3 && anchor3 === "D:/gone\n" &&
      bMiss && bMiss.code === "bridge-anchor-mismatch" && openPayloadOf(relay3b) === undefined &&
      bHit.workspaceKey === "D:/proj" && bHit.workspaceHintMatched === true,
      { r3: r3.outcome, open: open3 && open3.workspaceKey, anchor: anchor3, miss: bMiss && bMiss.code, hit: bHit.workspaceHintMatched });
    // 04（G5 增）：锚匹配归一——反斜杠/尾斜杠/盘符大小写差异不误判；identity 项可按 path 锚命中
    ck.ok("W-WSA-04 G5 锚匹配归一（互信根三写面字面形态不同）：Windows 反斜杠+尾斜杠+盘符大小写归一后相等（workspaceKeyMatches 纯函数锁）；非同一路径/空键不误判",
      workspaceKeyMatches("D:\\proj\\", "d:/proj") && workspaceKeyMatches("D:\\项目\\Zcode", "D:/项目/Zcode/") &&
      normalizeWorkspaceKey("D:\\proj\\") === "d:/proj" &&
      !workspaceKeyMatches("/a/b", "/a/c") && !workspaceKeyMatches("", "/a"),
      { norm: normalizeWorkspaceKey("D:\\proj\\") });
    const relay4 = new MockRelay({ workspaces: [{ workspacePath: "D:/z", workspaceIdentity: "ident-z", label: "z", kind: "local" }] });
    const s4 = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relay4.transportFactory, authAckTimeoutMs: 200 });
    const b4 = await openBridge({ session: s4, workspaceKeyHint: "d:/z" });
    ck.ok("W-WSA-04b G5 path 锚命中 identity 项：workspaceKey 派生为 identity（ident-z）但 workspaceHintMatched=true（锚按 workspacePath 面命中）",
      b4.workspaceKey === "ident-z" && b4.workspaceHintMatched === true, b4);
    // 05（G5 增）：显式 allowLegacyFirst 逃生口（仅离线/探针）——无 hint 仍取 workspaces[0]，
    // 返回 workspaceHintMatched=false 供调用方识别非锚定面
    const relay5 = new MockRelay({ workspaces: [WS_DRAFT, WS_PROJ] });
    const s5 = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relay5.transportFactory, authAckTimeoutMs: 200 });
    const b5 = await openBridge({ session: s5, allowLegacyFirst: true });
    ck.ok("W-WSA-05 G5 legacy 逃生口显式化：allowLegacyFirst:true 时无 hint 取 workspaces[0]（非生产面；生产 watcher 永不传），workspaceHintMatched=false 可观测",
      b5.workspaceKey === WS_DRAFT.workspacePath && b5.workspaceHintMatched === false, b5);
  }
}
