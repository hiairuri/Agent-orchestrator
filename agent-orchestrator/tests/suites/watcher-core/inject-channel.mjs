// @module suites/watcher-core/inject-channel
/*!
 * watcher-core/inject-channel.mjs —— 注入/频道面：W-INJ INJECT / W-INJ2 内层编码器
 * （VQL 字节向量锁 + Initialize 闸 + 时序闸）/ W-RESP watcher respP 守卫。
 * 拆分自 suites/watcher-core.mjs；断言本体零改动（源面读取 new URL 相对深度按新落位接线）。
 */
import fs from "node:fs";
import { ck, sleep, grp } from "./shared.mjs";
import { MockRelay } from "./mock-relay.mjs";
import { connectRelay } from "../../../watcher/relay.mjs";
import { openBridge, bridgeOf } from "../../../watcher/bridge.mjs";
import { buildTemplateShell, sanitizeSummary, shellCompliant, sendPrompt, vqlEncode, vqlDecode, ChannelClient, attachChannelClient, buildConversationCommandParams, buildCreateSessionParams, buildSendPromptParams, buildClientHello, ensureChannelHandshake, V4_WIRE_PROTOCOL_VERSION, uuidv7 } from "../../../watcher/inject.mjs";
import { guardPendingResponse } from "../../../watcher/watcher.mjs";

export async function run(ctx) {
  void ctx;

  /* ======== W-INJ INJECT ======== */
  {
    const shell = buildTemplateShell({ missionId: "m-20261020-1", state: "blocked", summary: "worker blocked on QA", eventId: "001792-1f" });
    ck.ok("W-INJ-01 模板壳定案格式（W-W §4 原案：id+状态+摘要+spool 指针）",
      shell === "[orch-watch] mission=m-20261020-1 state=blocked summary=worker blocked on QA 指引=请消费 spool/m-20261020-1/unread/001792-1f.json（路径指针，非正文）", shell);
    ck.ok("W-INJ-02 摘要 250 字夹紧 200（与 report 口径一致）", sanitizeSummary("x".repeat(250)).length === 200);
    ck.ok("W-INJ-03 换行/制表压空格（壳必须单行）", sanitizeSummary("a\nb\tc  d") === "a b c d");
    ck.ok("W-INJ-04 壳纪律自检：合规壳过、注入面（反引号/花括号/换行）拒",
      shellCompliant(shell) && !shellCompliant(shell + "`") && !shellCompliant("bad") && !shellCompliant(shell + "\nEVIL") && !shellCompliant("[orch-watch] x ${process.env}"));
    let badState = null;
    try { buildTemplateShell({ missionId: "m", state: "running", summary: "" }); } catch (e) { badState = e; }
    ck.ok("W-INJ-05 非 RESULT 状态拒构造", badState && badState.code === "shell-bad-args");
    // v1.1 W1（C3）：eventId 悬空显式化——必填（撤 "latest" 缺省）+ null→显式无事件句
    const shellNoEvent = buildTemplateShell({ missionId: "m-20261020-2", state: "question", summary: "worker asks", eventId: null });
    ck.ok("W-INJ-09 eventId=null 显式无事件形态（不产 unread/latest.json 假路径，含 mailbox read 指引；shellCompliant 放行两形）",
      shellNoEvent === "[orch-watch] mission=m-20261020-2 state=question summary=worker asks 指引=(无未读事件：question 待答，走 mailbox read)" &&
        !shellNoEvent.includes("spool/") && shellCompliant(shellNoEvent),
      shellNoEvent);
    let missingEvent = null;
    try { buildTemplateShell({ missionId: "m", state: "blocked", summary: "" }); } catch (e) { missingEvent = e; }
    ck.ok("W-INJ-10 eventId 必填（撤 latest 缺省）：缺省→shell-bad-args；显式 eventId 仍出真实指针形",
      Boolean(missingEvent) && missingEvent.code === "shell-bad-args" &&
        buildTemplateShell({ missionId: "m", state: "done", summary: "", eventId: "000000000000003-cccccccc" })
          .includes("spool/m/unread/000000000000003-cccccccc.json"),
      missingEvent && missingEvent.code);
    /* v0.10 W3 基线修订：V1 buildSessionSendParams（裸 JSON {method:"session/send"}）退役——
       内层换代 VQL/ChannelClient（L3 §1.4：裸 JSON 会被 host ChannelServer deserialize 读出垃圾） */
    const p1 = buildConversationCommandParams({ bridge: { workspaceKey: "ws-f", workspace: { workspacePath: "D:/a", workspaceIdentity: " ident " } }, sessionId: "sess-9", content: "c", nowMs: 1700000000000, commandId: "018f0000-0000-7000-8000-000000000000" });
    const pNull = buildConversationCommandParams({ bridge: { workspaceKey: "k" }, sessionId: null, content: "x" });
    const uv = uuidv7();
    ck.ok("W-INJ-06 wake 注入参数双候选（候选 1 缺省装配 sendConversationCommandV4：workspacePath/Identity+envelope.sessionId 可 null=新建语义；L4 W3r 定案——payload 直传形状无 sendText 包裹层（G2：host sendText.parse(envelope.payload) 直检 text 必填，包裹层必炸）+issuedAt=unix ms 数字（G1：core.ts:19 z.number()，ISO 会被 CLI safeParse 拒）+heldQueueDisposition=keepQueueAndSend（G3：adapter replayable 同款）；候选 2 sendPrompt 备选在册；uuidv7 形状）",
      p1.workspacePath === "D:/a" && p1.workspaceIdentity === "ident" && p1.envelope.sessionId === "sess-9" &&
      p1.envelope.commandId === "018f0000-0000-7000-8000-000000000000" && p1.envelope.type === "sendText" &&
      p1.envelope.payload.text === "c" && p1.envelope.payload.sendText === undefined &&
      p1.envelope.payload.requestedDelivery === "startNow" && p1.envelope.payload.heldQueueDisposition === "keepQueueAndSend" &&
      p1.envelope.payload.inputOrigin === "desktop" && p1.envelope.issuedAt === 1700000000000 && Number.isInteger(p1.envelope.issuedAt) &&
      pNull.envelope.sessionId === null && pNull.envelope.issuedAt > 0 && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uv) &&
      buildSendPromptParams({ taskId: "t1", content: "z" }).clientMode === "web-remote-replayable" &&
      (() => { try { buildSendPromptParams({ content: "z" }); return false; } catch (e) { return e.code === "shell-bad-args"; } })(), p1);
    /* W3r 增补：b2 新建会话命令面构建器（G6）——createSession+firstInput 建会话+首发一体 */
    const pcA = buildCreateSessionParams({ bridge: { workspaceKey: "ws-f", workspace: { workspacePath: "D:/a", workspaceIdentity: " ident " } }, content: "wake", nowMs: 1700000000000 });
    const pcB = buildCreateSessionParams({ bridge: { workspaceKey: "k", workspace: { workspacePath: "D:/b" } }, content: "w" });
    ck.ok("W-INJ-08 b2 新建会话命令面构建器（L4 G6 定案，L4 §3.2）：envelope.type=createSession+sessionId=null（command.ts:347「createSession 时为 null」）+payload={workspaceId:identity||path 与 host resolveWorkspaceKey 同口径, firstInput:{text}}+issuedAt=unix ms 数字（createSession ack result 带 sessionId=command.ts:391-399，resolveLiveSessionId 现行已兼容）",
      pcA.envelope.type === "createSession" && pcA.envelope.sessionId === null && pcA.envelope.issuedAt === 1700000000000 &&
      pcA.envelope.payload.workspaceId === "ident" && pcA.envelope.payload.firstInput.text === "wake" &&
      pcA.workspacePath === "D:/a" && pcA.workspaceIdentity === "ident" &&
      pcB.envelope.payload.workspaceId === "D:/b" && pcB.envelope.sessionId === null && pcB.envelope.issuedAt > 0, pcA);
    const relay = new MockRelay();
    const s = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relay.transportFactory, authAckTimeoutMs: 200 });
    const brg = await openBridge({ session: s, allowLegacyFirst: true });
    const sent = await sendPrompt({ session: s, seq: 1, sessionId: "sess-9", content: shell });
    const injCmd = relay.captured.find((c) => c.header && c.header[3] === "sendConversationCommandV4"); // W3s：G8 握手两帧先于命令，命令帧按方法名寻址
    const injArg = injCmd && Array.isArray(injCmd.body) && injCmd.body.length === 1 ? injCmd.body[0] : null; // G9：位置参数组
    ck.ok("W-INJ-07 sendPrompt（v2 频道调用面）：对岸 ack 对上 messageSeq 且重放窗释放 + 服务端收到 VQL 频道调用 [100,id,zcode-agent,sendConversationCommandV4] 装载模板壳（L4 W3r：payload 直传无包裹层+issuedAt 线上数字；W3s 基线修订：G8 握手两帧先于命令占频道 id 0/1，命令帧=频道 id 2，按方法名寻址；G3 基线修订：命令 body=位置参数组 [params]，envelope 在 body[0]）",
      sent.ack && sent.ack.ackMessageSeq === sent.messageSeq && brg.rpc.replayBytes === 0 &&
      injCmd && injCmd.header[0] === 100 && injCmd.header[1] === 2 &&
      injCmd.header[2] === "zcode-agent" && injCmd.header[3] === "sendConversationCommandV4" &&
      Array.isArray(injCmd.body) && injCmd.body.length === 1 &&
      injArg.envelope.sessionId === "sess-9" && injArg.envelope.payload.text === shell &&
      injArg.envelope.payload.sendText === undefined &&
      typeof injArg.envelope.issuedAt === "number", injCmd && injCmd.header);
  }

  /* ======== W-INJ2 内层编码器（VQL 字节向量锁 + Initialize 闸 + 时序闸，DESIGN §4.4） ======== */
  {
    grp("W-INJ2 inject-vql");
    // 字节向量锁（L3 §1.3 wake 注入字节示例：serialize([100,reqId,"zcode-task","sendPrompt"]) 逐字节）
    const hdr = vqlEncode([100, 1, "zcode-task", "sendPrompt"]);
    const ZT = Buffer.from("zcode-task", "utf8").toString("hex");
    const SP = Buffer.from("sendPrompt", "utf8").toString("hex");
    const emitted = [];
    let gateSettled = false;
    const gateClient = new ChannelClient({ emit: (b) => emitted.push(Buffer.from(b)) });
    const gateCall = gateClient.call("zcode-task", "sendPrompt", { a: 1 });
    gateCall.then(() => { gateSettled = true; }, () => { gateSettled = true; });
    await sleep(5);
    const gatedHeld = emitted.length === 0 && gateClient.state === "uninitialized"; // 未收 [200] 不发请求（挂起）
    gateClient.feed(Buffer.concat([vqlEncode([200]), vqlEncode(undefined)])); // Initialize 到达→排队请求按序冲刷
    const flushed = emitted.length === 1 && gateClient.initialized && gateClient.state === "initialized" && emitted[0].toString("hex").endsWith("05077b2261223a317d");
    gateClient.feed(Buffer.concat([vqlEncode([201, 0]), vqlEncode({ ok: 42 })])); // PromiseSuccess=[201,id]→resolve
    await sleep(5);
    const ok2 = new ChannelClient({ emit: () => {} });
    ok2.feed(Buffer.concat([vqlEncode([200]), vqlEncode(undefined)]));
    let rejected = null;
    ok2.call("zcode-agent", "sendConversationCommandV4", { x: 1 }).catch((e) => { rejected = e; });
    ok2.feed(Buffer.concat([vqlEncode([202, 0]), vqlEncode({ message: "boom", name: "Error" })])); // PromiseError=[202,id]→reject
    await sleep(5);
    ck.ok("W-INJ2-01 VQL/ChannelClient 编码器：请求头字节向量逐字节=L3 §1.3 实测值（04 04|06 64|06 01|01 0A 频道|01 0A 方法）+Int varint 三向量（0/127/128）+Object 体 tag5+VQL 长度+JSON+Initialize [200] 闸（未收不发、收后冲刷）+请求 id 匹配（[201] resolve/[202] reject）",
      hdr.toString("hex") === "0404" + "0664" + "0601" + "01" + "0a" + ZT + "01" + "0a" + SP &&
      vqlEncode(0).toString("hex") === "0600" && vqlEncode(127).toString("hex") === "067f" && vqlEncode(128).toString("hex") === "068001" &&
      vqlEncode({ a: 1 }).toString("hex") === "05" + "07" + Buffer.from('{"a":1}', "utf8").toString("hex") &&
      gatedHeld && flushed && gateSettled === true && rejected && rejected.message === "boom", { hdr: hdr.toString("hex"), gatedHeld, flushed, rejected: rejected && rejected.message });
    // 时序闸：ready 前不发任何 rpc-frame（manager:1166-1174 ready 前不开闸）
    const relayGate = new MockRelay();
    const sGate = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayGate.transportFactory, authAckTimeoutMs: 200 });
    const eGate = await sendPrompt({ session: sGate, seq: 1, sessionId: "sess-g", content: "x", ackTimeoutMs: 100 }).catch((e) => e);
    const rpcBefore = relayGate.received.filter((m) => m.payload && m.payload.zcode_type === "rpc-frame").length;
    const brgGate = await openBridge({ session: sGate, allowLegacyFirst: true });
    await sendPrompt({ session: sGate, seq: 1, sessionId: "sess-g", content: "x" });
    // Initialize 帧走服务→客户端方向（mock serverSent）；注入请求帧走客户端→服务方向（received）
    const srvPayloads = (relayGate.serverSent || []).filter((m) => m.payload && m.payload.zcode_type === "rpc-frame").map((m) => m.payload);
    const initIdx = srvPayloads.findIndex((p) => Buffer.from(p.dataBase64, "base64").toString("hex").startsWith("040106c8")); // VQL [200]+undefined
    const payloadsGate = relayGate.received.filter((m) => m.payload && m.payload.zcode_type === "rpc-frame").map((m) => m.payload);
    const callIdx = payloadsGate.findIndex((p) => { try { const h = vqlDecode(Buffer.from(p.dataBase64, "base64"), { i: 0 }); return Array.isArray(h) && h[0] === 100; } catch { return false; } });
    ck.ok("W-INJ2-02 时序闸：ready 前不发任何 rpc-frame（无 bridge 即拒发 bridge-not-open+线上零 rpc 帧）+Initialize 帧先于注入请求帧到位（首事务先等 [200]）+bridge 登记 BRIDGES",
      eGate.code === "bridge-not-open" && rpcBefore === 0 && initIdx >= 0 && callIdx >= 0 && bridgeOf(sGate) === brgGate.rpc, { eGate: eGate.code, initIdx, callIdx });
    /* W3r 增补（G4）：Int 值域硬约束注释级的断言面——负数/浮点拒、上界 roundtrip、大数走 Object JSON */
    const throwCode = (fn) => { try { fn(); return null; } catch (e) { return e.code || "(none)"; } };
    const rangeHi = vqlEncode(2 ** 31 - 1);
    const bigEnc = vqlEncode({ issuedAt: 1700000000000 });
    ck.ok("W-INJ2-03 G4 Int 值域硬约束（注释级，L4 §1.1/§4.2-G4：tag6=上游 32 位语义，Int∈[0,2^31-1]；≥2^31 上游落 Object JSON fallback、按 Int 编码会被上游 32 位 << 截断读垃圾——wake 路径 Int 仅 100+请求 id 恒在界内）：负数拒/浮点拒（vql-bad-int）+上界 2^31-1 Int tag roundtrip+unix ms 大数（issuedAt）在参数 Object 走 tag5 JSON 全精度不经 Int 面",
      throwCode(() => vqlEncode(-1)) === "vql-bad-int" && throwCode(() => vqlEncode(1.5)) === "vql-bad-int" &&
      rangeHi[0] === 6 && vqlDecode(rangeHi) === 2 ** 31 - 1 &&
      bigEnc[0] === 5 && vqlDecode(bigEnc).issuedAt === 1700000000000,
      { neg: throwCode(() => vqlEncode(-1)), float: throwCode(() => vqlEncode(1.5)) });
    /* W3r 增补（G5）：ChannelClient dispose fail-closed（上游 channelClient.ts:250-275 对齐） */
    const dClient = new ChannelClient({ emit: () => {} });
    const dQ1 = dClient.call("zcode-agent", "sendConversationCommandV4", { q: 1 }); // 未初始化→排队
    dClient.feed(Buffer.concat([vqlEncode([200]), vqlEncode(undefined)])); // Initialize→排队请求冲刷→在飞
    const dQ2 = dClient.call("zcode-agent", "sendConversationCommandV4", { q: 2 }); // 在飞
    dClient.dispose("bridge-dead"); // 桥死 fail-closed：排队+在飞全 reject
    const dQ3 = dClient.call("zcode-agent", "sendConversationCommandV4", { q: 3 }); // dispose 后新请求立即拒
    const settled = await Promise.all([dQ1, dQ2, dQ3].map((p) => p.then(() => "resolved", (e) => e)));
    ck.ok("W-INJ2-04 G5 ChannelClient dispose fail-closed（channelClient.ts:250-275 对齐，勿过度设计）：排队（Initialize 后冲刷）+在飞+dispose 后新 call 全部 reject（name=ConnectionClosed/code=connection-closed+自定义 reason 透传），上层 in-flight 不永挂；dispose 幂等",
      settled.length === 3 && settled.every((e) => e && e.name === "ConnectionClosed" && e.code === "connection-closed") &&
      settled[0].message === "bridge-dead" && settled[2].message === "bridge-dead" &&
      dClient.state === "disposed" && (dClient.dispose("again"), true), settled.map((e) => e && e.message));
    /* W3s 增补（G8）：连接握手序列/恰一次/失败面/超时面（EXP10-findings R2-6 上游锚 @3c5b2276；
       纯代码波零活体——全部离线 mock 面验证握手序列） */
    // 序列+形状：sendPrompt 前置 hello（无参）→ initialize（clientHello strict 四键恰等）→ 命令殿后
    const relayHs = new MockRelay();
    const sHs = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayHs.transportFactory, authAckTimeoutMs: 200 });
    const bHs = await openBridge({ session: sHs, allowLegacyFirst: true });
    await sendPrompt({ session: sHs, seq: 1, sessionId: "sess-hs", content: "x" });
    const hsC = relayHs.captured;
    const helloArgs = hsC[0] && Array.isArray(hsC[0].body) ? hsC[0].body : null;
    const initArgs = hsC[1] && Array.isArray(hsC[1].body) && hsC[1].body.length === 1 ? hsC[1].body[0] : null;
    const helloOk = hsC[0] && hsC[0].header && hsC[0].header[0] === 100 && hsC[0].header[1] === 0 &&
      hsC[0].header[2] === "zcode-agent" && hsC[0].header[3] === "helloConversationV4" &&
      helloArgs && helloArgs.length === 0;
    const initOk = hsC[1] && hsC[1].header && hsC[1].header[0] === 100 && hsC[1].header[1] === 1 &&
      hsC[1].header[2] === "zcode-agent" && hsC[1].header[3] === "initializeConversationV4" &&
      initArgs && JSON.stringify(Object.keys(initArgs).sort()) === JSON.stringify(["appVersion", "clientId", "kind", "protocolVersion"]) &&
      initArgs.kind === "clientHello" && initArgs.protocolVersion === 3 &&
      initArgs.clientId === "orch-watch" && initArgs.appVersion === "orch-watch/0.1" &&
      initArgs.capabilities === undefined;
    const cmdOk = hsC[2] && hsC[2].header && hsC[2].header[1] === 2 && hsC[2].header[3] === "sendConversationCommandV4";
    ck.ok("W-INJ2-05 G8 两步连接握手序列与 clientHello strict 形状（EXP10-findings R2-6 @3c5b2276：helloConversationV4 空位置参数组 → initializeConversationV4{kind:clientHello,protocolVersion:3,clientId:orch-watch,appVersion:orch-watch/0.1} 四键恰等零 capabilities——strict schema 未知键即拒、capabilities 仅许 host hello 见 workflowRunDeltas:true 后回声明；V4_WIRE_PROTOCOL_VERSION=3 常量锁）→ 命令帧殿后（频道 id 0/1/2 递增）；G3 基线修订：G9 后 body 均为位置参数组（hello=[]，initialize=[clientHello]，对象在组内）",
      helloOk && initOk && cmdOk && V4_WIRE_PROTOCOL_VERSION === 3 &&
      JSON.stringify(buildClientHello()) === JSON.stringify({ kind: "clientHello", protocolVersion: 3, clientId: "orch-watch", appVersion: "orch-watch/0.1" }),
      { h0: hsC[0] && hsC[0].header, h1: hsC[1] && hsC[1].body, h2: hsC[2] && hsC[2].header });
    /* G3 增补（G9）：三处 call 的位置参数组形态单锁（EXP10-findings R3-5 根因面） */
    const cmdArg9 = hsC[2] && Array.isArray(hsC[2].body) && hsC[2].body.length === 1 ? hsC[2].body[0] : null;
    ck.ok("W-INJ2-09 G9 位置参数组锁（EXP10-findings R3-5 根因：proxy-channel.ts:104-111 target.apply(handler, args || [])+toService :132-137 把实参包成数组→channelClient serialize(argsArray)；裸对象 length=undefined 被当 0 参→对岸收 undefined，Txn1 initializeConversationV4 ZodError 实锤）：本连接三帧 body 全为位置参数组——hello=[]（空组）/initialize=[clientHello]（恰一元素）/命令=[params]（恰一元素且 envelope 直传，非裸对象）",
      helloOk && initOk && cmdArg9 && cmdArg9.envelope && cmdArg9.envelope.type === "sendText" &&
      hsC.every((c) => Array.isArray(c.body)), { bodies: hsC.map((c) => Array.isArray(c.body) ? "array:" + c.body.length : typeof c.body) });
    // 恰一次：同桥二发零新增握手帧（handshakeP 去重）；新桥=新客户端=握手随新连接重来
    const hsCount = (m) => relayHs.captured.filter((c) => c.header && c.header[3] === m).length;
    await sendPrompt({ session: sHs, seq: 2, sessionId: "sess-hs", content: "y" });
    const onceOk = hsCount("helloConversationV4") === 1 && hsCount("initializeConversationV4") === 1;
    const bHs2 = await openBridge({ session: sHs, allowLegacyFirst: true }); // 重桥=新 RpcBridge=新 ChannelClient
    await sendPrompt({ session: sHs, seq: 3, sessionId: "sess-hs", content: "z" });
    const redoOk = hsCount("helloConversationV4") === 2 && hsCount("initializeConversationV4") === 2 &&
      bHs2.bridgeSessionId !== bHs.bridgeSessionId;
    ck.ok("W-INJ2-06 G8 握手恰一次随连接生命周期：同一 ChannelClient（同桥）二次 sendPrompt 零新增握手帧（ensureChannelHandshake 按 handshakeP 去重，任何命令前恰一次）；重桥后握手随新连接重来（新 bridgeSessionId+hello/initialize 计数 2）",
      onceOk && redoOk, { onceOk, redoOk, hello: hsCount("helloConversationV4"), init: hsCount("initializeConversationV4") });
    // 失败面：initialize 被 [202] 拒（helloRequired 族）→ sendPrompt 原样上抛+命令帧零发出+同桥快速同败
    const relayHf = new MockRelay({ handshakeReject: true });
    const sHf = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayHf.transportFactory, authAckTimeoutMs: 200 });
    await openBridge({ session: sHf, allowLegacyFirst: true });
    const eHf1 = await sendPrompt({ session: sHf, seq: 1, sessionId: "sess-f", content: "x", ackTimeoutMs: 500 }).catch((e) => e);
    const cmdCount = (r) => r.captured.filter((c) => c.header && c.header[3] === "sendConversationCommandV4").length;
    const eHf2 = await sendPrompt({ session: sHf, seq: 2, sessionId: "sess-f", content: "y", ackTimeoutMs: 500 }).catch((e) => e);
    // 超时面：Initialize 恒不达（skipInit）→ 握手请求排队不上槽 → 竞速超时按 rpc-ack-timeout 族（D2 归类不变）+零帧
    const relayHt = new MockRelay({ skipInit: true });
    const sHt = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayHt.transportFactory, authAckTimeoutMs: 200 });
    await openBridge({ session: sHt, allowLegacyFirst: true });
    const eHt = await sendPrompt({ session: sHt, seq: 1, sessionId: "sess-t", content: "x", ackTimeoutMs: 120 }).catch((e) => e);
    ck.ok("W-INJ2-07 G8 握手失败面/超时面：initialize 被 [202] 拒（fault.connection.helloRequired 字样 passthrough）→ sendPrompt 原样上抛且命令帧零发出（握手先于命令=对齐 host assertReady 连接闸）+同桥再发快速同败零新命令帧（失败亦随 handshakeP 去重，重试=新连接语义）；Initialize 恒不达（skipInit）→ 握手请求挂起不上槽 → 竞速超时 code=rpc-ack-timeout（失败码族/降级归类不变）且零 rpc 帧",
      eHf1 && String(eHf1.message || "").indexOf("helloRequired") >= 0 && cmdCount(relayHf) === 0 &&
      eHf2 && String(eHf2.message || "").indexOf("helloRequired") >= 0 && cmdCount(relayHf) === 0 &&
      eHt && eHt.code === "rpc-ack-timeout" && relayHt.captured.length === 0,
      { eHf1: eHf1 && eHf1.message, eHf2: eHf2 && eHf2.message, eHt: eHt && (eHt.code + ":" + eHt.message), htFrames: relayHt.captured.length });
    // 隐蔽面治理（Txn1，EXP10-findings R2-1）：握手成功后命令被 [202] 拒且无人 await callP → 拒因留痕 client.lastRejection
    const relayLr = new MockRelay({ rejectSessionFirstN: 1, liveSessionId: "sess-live-9" });
    const sLr = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relayLr.transportFactory, authAckTimeoutMs: 200 });
    await openBridge({ session: sLr, allowLegacyFirst: true });
    const sentLr = await sendPrompt({ session: sLr, seq: 1, sessionId: "sess-x", content: "x" }); // callP 不 await（watcher 生产路径同型）
    void sentLr.callP;
    await sleep(20);
    const clientLr = bridgeOf(sLr) && bridgeOf(sLr).client;
    ck.ok("W-INJ2-08 隐蔽面治理（Txn1）：callP 无人 await 时拒因不再纯吞——client.lastRejection 留痕可观测（PromiseError [202] passthrough 原样），unhandledRejection 防护不变（Txn1 的 handshakeRequired 拒对 verdict 不可见问题：连接层部分随 W-INJ2-05 握手 await 可见，命令层部分由本留痕面承接）",
      clientLr && clientLr.lastRejection && String(clientLr.lastRejection.message || "").indexOf("Session not found") >= 0 &&
      sentLr.ack && sentLr.ack.ackMessageSeq === sentLr.messageSeq, clientLr && clientLr.lastRejection);
  }

  /* ======== W-RESP watcher respP 守卫（v0.10 G2 平移自 watcher-shim，主句零改动） ======== */
  {
    grp("W-RESP resp-guard");
    // a 拒绝被守卫消费：30ms 窗内对同一错误零 unhandledRejection（按消息过滤他案噪声）
    let hits = 0;
    const onUn = (e) => { if (e && e.message === "resp-boom") hits++; };
    process.on("unhandledRejection", onUn);
    const p = guardPendingResponse(Promise.reject(new Error("resp-boom")));
    await sleep(30);
    process.off("unhandledRejection", onUn);
    ck.ok("W-RESP-01 守卫消费拒绝：挂起响应无人 await 时零 unhandledRejection（进程不崩）", hits === 0, { hits });
    // b 显式 await 仍收拒绝（守卫只加消费方、不改 promise 语义）
    const err = await p.catch((e) => e);
    ck.ok("W-RESP-02 显式 await 方仍收拒绝（守卫不改语义）", err && err.message === "resp-boom", err && err.message);
    // c 成功值原样透传
    const v = await guardPendingResponse(Promise.resolve(42));
    ck.ok("W-RESP-03 成功值原样透传", v === 42, v);
    // d 源面接线锁：sendPrompt 失败路径的 respP 必须经守卫创建（防回退成裸挂起 promise）
    const wsrc = fs.readFileSync(new URL("../../../watcher/watcher.mjs", import.meta.url), "utf8");
    ck.ok("W-RESP-04 源面锁：respP 由 guardPendingResponse 创建（sendPrompt 失败路径不留裸挂起 promise）",
      wsrc.includes('guardPendingResponse(session.awaitData("session-send-response"'), "");
  }
}
