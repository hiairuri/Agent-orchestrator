/*!
 * suites/watcher-core.mjs —— W1 watcher 守护进程核心套（mock relay + mock 凭据，零真实触达）
 *
 * 覆盖断言组（v0.7-W1；权威设计=(internal design docs, not published) + W-G + EXP-3）：
 *   W-RED  REDACTED 日志闸（token 形态/Bearer 归零 + 自检；W-W §5.5 对账锚）
 *   W-POL  POLLER 分类（classify twin：未签收终态两族/优先级/宽限/签收排除/workflow 排除/
 *          B5 mtime 备链/spool 只数）
 *   W-TXN  TXN 闸（≥90s 频控/cap=3/D2 指数退避/busy×2 静默 30min/nextEligibleAt）
 *   W-TTL  TTL 签-连（≤55s 同事务/超窗弃签重签恰一次/再败 ttl-exhausted→D1 面）
 *   W-CRD  CREDS（AES-256-GCM roundtrip/坏 tag 安全失败/JWT 形态自检无 exp 不判过期/
 *          S0-S3 链 safeParse/401→auth-required/token 正则/设备拣选）
 *   W-RLY  RELAY V2（auth 闸 matched/KICKED 静默互踢第一禁令/关断码映射全表/噪声 data 计数
 *          不解析/awaitData 匹配）
 *   W-BRG  BRIDGE（crc32 IEEE 向量/04D-3 rpc-frame roundtrip/checksum/分片/限值/L2 编排+空列表；
 *          v0.10 W3 基线修订：04D-3 形状+bridgeSessionId 终端自造+ready 深消费）
 *   W-REG  REG 级形状钉（v0.9-L2：L2 语义装 data.payload 内层/requestId 字段名/
 *          workspaceKey 派生消费=workspaceIdentity.trim||workspacePath+activeWorkspaceKey 兜底/
 *          出站 type 白名单/scheme 闸）
 *   W-BRG2 wake 链 04D-3（v0.10 W3：openBridge 深形——自造 id/回显/identity 透传/initialTaskId
 *          深读/error 快路径；ack 回程生死项——重放窗释放/saturated/replayBufferExceeded→
 *          bridge-degraded/reason 枚举全表）
 *   W-INJ  INJECT（模板壳定案/隐私纪律/单行/200 字夹紧/sendPrompt 频道调用面；W3r：参数
 *          schema L4 定案——payload 直传/issuedAt 数字/keepQueueAndSend/b2 createSession 构建器）
 *   W-INJ2 内层编码器（v0.10 W3：VQL 字节向量锁/ChannelClient Initialize [200] 闸/请求 id
 *          匹配/ready 前零 rpc 帧；W3r：G4 Int 值域/G5 dispose fail-closed；W3s：G8 连接握手
 *          序列/clientHello strict 形状/恰一次随连接生命周期/失败面/超时面/lastRejection 留痕；
 *          G3：G9 位置参数组锁——三处 call 第三参=数组（hello=[]/initialize=[clientHello]/命令=[params]））
 *   W-WSA  工作区锚钉（v0.10 G3 G10；G5 基线修订：无锚 bridge-anchor-missing / 锚未命中
 *          bridge-anchor-mismatch 均 fail-loud，禁止盲取 workspaces[0]；锚匹配三面归一；
 *          allowLegacyFirst 显式逃生口；watcher 只读锚不写锚）
 *   W-RESP watcher respP 潜伏面（v0.10 G2 平移自 watcher-shim，主句零改动）：guardPendingResponse
 *          对拒绝 promise 恒消费（零 unhandledRejection）+ 显式 await 仍收拒绝 + 成功值透传 +
 *          watcher.mjs 源面接线锁（sendPrompt 失败路径不留裸挂起 promise）
 *   C11    coord-session 自愈（v0.10 W3：b2 stale→新建会话重试恰一次→原子刷新；b1 活体零重写；
 *          OPEN-10.4 无 sessionId 不刷新；W3r：b2=createSession+firstInput 线上形状+CLI 层
 *          触发面宽匹配 callP rejection/ack rejected+负控制；G3：workspaceKeyHint 透传+
 *          RESP_TIMEOUT_MS 冷启覆盖常量锁；G5：刷新前工作区守卫）
 *   G4     b2 生产接线+锚互信根（v0.10 G4：watcher 主路径切 wakeCoordSession——mock 全链
 *          b2 自愈+coord-session 刷新+锚保持；源面调用锁；toolResume 双写 coord-workspace 锚；
 *          G5：server 启动补位 + b2 刷新工作区守卫（错/未验证工作区不刷新、warning 落日志））
 *   G5    锚互信根触发（v0.10 G5：SessionStart 无条件成对重发布 session+workspace 锚（R4
 *          重启后 coord-workspace 缺失的根因修复）+session_id 消毒+三触发面源锁+D3 归类）
 *   G14   锚重发布子代理过滤（v0.10 G14：子代理会话 id → publishWakeAnchor 入口跳过，
 *          锚零写+存量锚零触碰；主控 id 成对写不误伤；EXP10-findings R6 重启恢复实锤）
 *   W-VRD  VERDICT（三证合一矩阵/busy=noop/③复活观测窗）
 *   W-DGR  DEGRADE（降级树全表 D1-D3/kicked/signals 落盘+滚动+脱敏）
 *   W-E2E  全链 e2e（mock relay+mock 凭据：success/noop-busy×2 静默/kicked 断路/D1 凭据缺失/
 *          D3 coord-session 缺失/D2 建连败退避/hold-cap 40s 面修订为 1s 加速）
 *   W-WS   ws.mjs RFC6455 codec（掩码 roundtrip/分片重装/64 位长度/ping/close/upgrade 形状/
 *          RFC 6455 §1.3 accept 向量）
 *
 * 运行方式：node tests/suites/watcher-core.mjs（注册行归主控胶水，簇 T；run-all 暂不含本套）
 * 前置：node >= 20；无网络（全部 mock/内存对，唯一真实 IO=临时根文件）；总时长 <5s。
 */
import fs from "node:fs";
import path from "node:path";
import { Checker, startServer, PLUGIN_DIR } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot } from "../harness/temp-root.mjs";
import { runNode } from "../harness/capture.mjs";

import { redact, redactionSelfCheck, deriveCredentialSecret, encryptEntry, decryptEntry, inspectJwt, loadPlatformJwt, pickDesktopDevice, issueTerminalToken, fetchDevices, TOKEN_RE } from "../../watcher/credentials.mjs";
import { classifyForWatcher, pickNext, readBoardSafe, spoolUnreadCount, RESULT_STATUSES } from "../../watcher/poller.mjs";
import { TxnGate, signAndConnect, MIN_INTERVAL_MS, BUSY_SILENCE_MS } from "../../watcher/txn.mjs";
import { RelaySession, connectRelay, mapClose, mapErrorFrame, buildWs2Url, isSignalType } from "../../watcher/relay.mjs";
import { crc32, encodeRpcFrame, decodeRpcFrames, openBridge, LIMITS, bridgeOf, mapBridgeFailure, BRIDGE_FAILURE_REASONS, workspaceKeyMatches, normalizeWorkspaceKey } from "../../watcher/bridge.mjs";
import { buildTemplateShell, sanitizeSummary, shellCompliant, sendPrompt, vqlEncode, vqlDecode, ChannelClient, attachChannelClient, buildConversationCommandParams, buildCreateSessionParams, buildSendPromptParams, buildClientHello, ensureChannelHandshake, V4_WIRE_PROTOCOL_VERSION, uuidv7, wakeCoordSession, sessionErrorHit, resolveResponseWorkspaceKey, RESP_TIMEOUT_MS } from "../../watcher/inject.mjs";
import { classifyAccept, finalVerdict, observeRevival, rolloutRevivedProbe } from "../../watcher/verdict.mjs";
import { DegradeState, classifyFailure, failureFromClose, CLASSES, SIGNALS_MAX_LINES, loopbackD2Hint } from "../../watcher/degrade.mjs";
import { createWatcher, resolveRoot, resolveRolloutDir, guardPendingResponse } from "../../watcher/watcher.mjs";
import { encodeFrame, FrameParser, acceptKey, buildUpgradeRequest, parseUpgradeResponse, OP } from "../../watcher/ws.mjs";

const ck = new Checker("watcher-core");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const grp = (n) => process.stderr.write("[grp] " + n + "\n");
const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");

/* 零触网硬护栏（EXP 纪律运行时化）：套内任何路径漏注入 fetchImpl 也只能打到本 stub——
   真实中继/签发端点/任何远端一律禁触；漏注入表现为快速失败（network）而非静默外呼。 */
globalThis.fetch = async (url) => {
  throw Object.assign(new Error("suite-net-forbidden: " + String(url)), { name: "SuiteNetForbidden" });
};

/* ================= mock relay（内存对，零 socket 零触网） ================= */

class MockTransport {
  constructor(server) {
    this.server = server;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.closed = false;
    this.sent = [];
    this.closeArgs = null;
  }
  send(text) {
    if (this.closed) throw Object.assign(new Error("mock-closed"), { code: "relay-closed" });
    this.sent.push(text);
    this.server.onClientText(text, this);
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.closeArgs = { code, reason };
    this.server.onClientClose(this, code, reason);
  }
  /* 服务端 → 客户端（测试驱动面） */
  serverSend(obj) {
    if (this.closed) return;
    (this.server.serverSent = this.server.serverSent || []).push(obj);
    if (this.onmessage) this.onmessage(JSON.stringify(obj));
  }
  serverClose(code, reason = "") {
    if (this.closed) return;
    this.closed = true;
    if (this.onclose) this.onclose({ code, reason });
  }
}

class MockRelay {
  constructor(opts = {}) {
    this.opts = opts;
    this.transports = [];
    this.received = [];
    this.captured = []; // decodeRpcFrames 结果
  }
  transportFactory = (url) => {
    this.urls = this.urls || [];
    this.urls.push(url);
    const t = new MockTransport(this);
    this.transports.push(t);
    if (this.opts.failHandshake) return Promise.reject(Object.assign(new Error("ws-handshake-timeout"), { code: "ws-handshake-timeout" }));
    return Promise.resolve(t);
  };
  get connCount() { return this.transports.length; }
  /* 服务侧 04D-3 组帧（对岸桌面视图：Initialize/[201] 响应经 rpc-frame 下发） */
  frame4d(bytes, bridgeSessionId) {
    this._srvSeq = (this._srvSeq || 0) + 1;
    this._srvMsg = (this._srvMsg || 0) + 1;
    return encodeRpcFrame({ bridgeSessionId, data: bytes, physicalSeq: this._srvSeq, messageSeq: this._srvMsg, fragmentIndex: 0, fragmentCount: 1, messageBytes: bytes.length }).payload;
  }
  onClientText(text, t) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    this.received.push(msg);
    if (msg.type === "auth_init") {
      const ps = this.opts.pairStatus === undefined ? "matched" : this.opts.pairStatus;
      if (ps) t.serverSend({ type: "auth_ack", pair_status: ps, terminal_sid: "ts-mock", server_ts: 1 });
      if (this.opts.mode === "kicked") t.serverSend({ type: "error", code: "KICKED" }); // 同步踢（确定性）
      if (this.opts.mode === "close4011") t.serverClose(4011, "SessionExpired");
      if (this.opts.mode === "close4004") t.serverClose(4004, "SessionNotFound");
    }
    if (msg.type === "data" && msg.payload && msg.payload.zcode_type === "workspace-list-request") {
      // L2 应答走 payload 内层 + requestId 字段名（v0.9-L2 契约）；工作区项无 workspaceKey 字段
      // （WorkspaceTarget=workspacePath/label/kind/workspaceIdentity，键由 resolve 派生）
      if (this.opts.noiseBeforeBridge) t.serverSend({ type: "data", payload: { zcode_type: "desktop-state-push", note: "noise-not-to-be-parsed" } });
      const rid = msg.payload.requestId;
      const items = this.opts.workspaces || [{ workspacePath: "ws-1", label: "proj", kind: "local" }];
      t.serverSend(this.opts.emptyWorkspace
        ? { type: "data", payload: { zcode_type: "workspace-list-response", requestId: rid, success: true, result: { workspaces: [] } } }
        : { type: "data", payload: { zcode_type: "workspace-list-response", requestId: rid, success: true, result: { workspaces: items, activeWorkspaceKey: this.opts.activeWorkspaceKey ?? null } } });
    }
    if (msg.type === "data" && msg.payload && msg.payload.zcode_type === "workspace-bridge-open") {
      const rid = msg.payload.requestId;
      const bid = msg.payload.bridgeSessionId;
      this._openN = (this._openN || 0) + 1;
      const errN = this.opts.bridgeErrorCount || 0;
      if (this.opts.bridgeError && this._openN <= errN) {
        // W-BRG2-01/C11-01 面：workspace-bridge-error 快路径应答（validation.ts:295-303 形状）
        t.serverSend({ type: "data", payload: { zcode_type: "workspace-bridge-error", requestId: rid, bridgeSessionId: bid, reason: this.opts.bridgeError, error: "mock:" + this.opts.bridgeError } });
      } else {
        // 04D-3 深形 ready（validation.ts:287-294）：顶层回显+bridge 对象（initialTaskId 只在 bridge 内，顶层无此字段）
        const readyPayload = { zcode_type: "workspace-bridge-ready", requestId: rid, bridgeSessionId: bid };
        if (this.opts.bridgeGeneration !== undefined) readyPayload.bridgeGeneration = this.opts.bridgeGeneration;
        if (this.opts.recoveryId !== undefined) readyPayload.recoveryId = this.opts.recoveryId;
        readyPayload.bridge = { kind: "local", bridgeSessionId: bid, workspaceKey: "ws-1", workspacePath: "ws-1", initialTaskId: "task-1" };
        t.serverSend({ type: "data", payload: readyPayload });
        // host ChannelServer Initialize（deferInit ready 后即发，channelServer.ts:28-36；VQL [200]+undefined）
        // skipInit（W3s 失败面）：不发 Initialize → 握手请求恒挂起 → 超时面
        if (!this.opts.skipInit) t.serverSend({ type: "data", payload: this.frame4d(Buffer.concat([vqlEncode([200]), vqlEncode(undefined)]), bid) });
      }
    }
    if (msg.type === "data" && msg.payload && msg.payload.zcode_type === "rpc-frame") {
      // 04D-3：rpc 帧整体装 data.payload 内层（V1 顶层裸 rpc-frame 形已废，L2 §7.2/§7.3）
      const pl = msg.payload;
      const raw = Buffer.from(pl.dataBase64, "base64");
      const c = { i: 0 };
      let header = null;
      let body;
      try { header = vqlDecode(raw, c); body = c.i < raw.length ? vqlDecode(raw, c) : undefined; } catch { /* 非 VQL 帧：captured 留痕 */ }
      this.captured.push({ payload: pl, header, body });
      if (this.opts.mode === "noack") return; // 不回 ack：触发持有帽强制断（ack 回程生死项负面；握手帧同面）
      const reqId = Array.isArray(header) ? header[1] : 0;
      const method = Array.isArray(header) ? header[3] : "";
      const sendAck = () => t.serverSend({ type: "data", payload: { zcode_type: "rpc-frame-ack", bridgeSessionId: pl.bridgeSessionId, ackMessageSeq: pl.messageSeq } });
      // G8 握手服务面（W3s）：hello/initialize 常驻应答——不占 CLI 命令计数（_callN）、不进
      // mode 错误面（busy/accept-reject/rejectSessionFirstN/ackRejectFirstN 只对命令帧生效，
      // W3r 触发面语义保持「首个命令」而非「首个频道帧」）、不夹带 V1 session-send-response
      // 双面（②面与命令帧 1:1）。handshakeReject=initialize 回 [202]（helloRequired 族失败面）。
      if (method === "helloConversationV4") {
        sendAck();
        t.serverSend({ type: "data", payload: this.frame4d(Buffer.concat([vqlEncode([201, reqId]), vqlEncode({ kind: "serverHello", protocolVersion: 3, capabilities: {} })]), pl.bridgeSessionId) });
        return;
      }
      if (method === "initializeConversationV4") {
        sendAck();
        t.serverSend({ type: "data", payload: this.frame4d(this.opts.handshakeReject
          ? Buffer.concat([vqlEncode([202, reqId]), vqlEncode({ name: "Error", message: this.opts.handshakeRejectMessage || "fault.connection.helloRequired" })])
          : Buffer.concat([vqlEncode([201, reqId]), vqlEncode({ ok: true })]), pl.bridgeSessionId) });
        return;
      }
      this._callN = (this._callN || 0) + 1; // 频道命令调用计数（跨桥累计；握手帧不计，G6 CLI 层触发面 mock 用）
      const chanResp = this.opts.mode === "busy" ? { error: { code: -32010, message: "A prompt is already running" } }
        : this.opts.mode === "accept-reject" ? { error: { code: -32002, message: "rejected" } }
        : { sessionId: this.opts.liveSessionId !== undefined ? this.opts.liveSessionId : "sess-live", accepted: true };
      // G5 守卫面：可选让 createSession/命令应答携带 workspaceKey（对岸 shapes 未承诺，宽读面断言用）
      if (this.opts.chanWorkspaceKey && chanResp.sessionId !== undefined) chanResp.workspaceKey = this.opts.chanWorkspaceKey;
      // G6 CLI 层触发面 mock（L4 §4.2-G6 失败形状）：前 N 次调用回 PromiseError=[202]（CLI 会话
      // 过期 passthrough 形状）或 ack rejected=[201]+CommandAck(status=rejected)，其后回活体成功
      let chanFrame;
      if (this.opts.rejectSessionFirstN && this._callN <= this.opts.rejectSessionFirstN) {
        chanFrame = Buffer.concat([vqlEncode([202, reqId]), vqlEncode({ name: "Error", code: this.opts.rejectCode || "session_not_found", message: this.opts.rejectMessage || "Session not found: sess-stale" })]);
      } else if (this.opts.ackRejectFirstN && this._callN <= this.opts.ackRejectFirstN) {
        chanFrame = Buffer.concat([vqlEncode([201, reqId]), vqlEncode({ commandId: "cmd-mock", status: "rejected", reasonCode: "session-not-found", message: this.opts.rejectMessage || "session expired", revisionAtDecision: 1 })]);
      } else {
        chanFrame = Buffer.concat([vqlEncode([201, reqId]), vqlEncode(chanResp)]);
      }
      // ①ack（组装 complete 后对端回发，acknowledgedRelayProtocol.ts:203-218；整体装 data.payload 内层）
      sendAck();
      // ②频道响应 PromiseSuccess=[201,id]+data（channelServer.ts:53-67；watcher 作纯发送方也消费对岸 rpc 帧）
      t.serverSend({ type: "data", payload: this.frame4d(chanFrame, pl.bridgeSessionId) });
      // V1 mock 双面：session-send-response data payload（watcher.mjs ② awaitData 面保留；活体为频道 [201] 面——W4/W5 接线项）
      t.serverSend({ type: "data", payload: { zcode_type: "session-send-response", ...(this.opts.mode === "busy" ? { error: { code: -32010, message: "A prompt is already running" } } : this.opts.mode === "accept-reject" ? { error: { code: -32002, message: "rejected" } } : { result: { ok: true } }) } });
    }
  }
  onClientClose() {}
}

/* ================= e2e 工具 ================= */

function writeBoard(root, missions) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "board.json"), JSON.stringify({ version: 2, updated_at: new Date().toISOString(), missions }) + "\n");
}
function writeCoord(root, sid = "sess-coord-test", workspaceKey = "ws-1") {
  fs.mkdirSync(path.join(root, "sentinel"), { recursive: true });
  fs.writeFileSync(path.join(root, "sentinel", "coord-session.txt"), sid + "\n");
  // G5：生产 watcher 无锚 fail-loud，mock 全链默认预置与 MockRelay 缺省工作区一致的锚；
  // 已有锚不覆盖（W-WSA-02 漂移场景的锚先于 buildWatcher 写入）；workspaceKey=null → 不写
  // （W-WSA-01 无锚 fail-loud 场景）。
  const anchorPath = path.join(root, "sentinel", "coord-workspace.txt");
  if (workspaceKey && !fs.existsSync(anchorPath)) fs.writeFileSync(anchorPath, workspaceKey + "\n");
}
const mission = (id, status, atMs, extra = {}) => ({
  id,
  title: "t-" + id,
  status,
  dispatch: { agent_id: "agent-" + id, mode: "agent" },
  updated_at: new Date(atMs).toISOString(),
  ...extra,
});

/** 造一个全 mock watcher：假时钟（可推进）、即时 sleep（推进假时钟）、mock relay、mock fetch（零真实触达）。 */
function buildWatcher({ root, relay, now, board = null, coord = true, revived = true, extraArgv = [], workspaceAnchor = "ws-1" }) {
  if (board) writeBoard(root, board);
  if (coord) writeCoord(root, "sess-coord-test", workspaceAnchor);
  const clock = { t: now() };
  const mockFetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ code: 0, msg: "", data: { token: "A".repeat(21) + "g", expires_in: 60 } }),
  });
  return createWatcher({
    rootDir: root,
    argv: ["--poll-sec", "1", "--min-interval-sec", "0", "--hold-max-sec", "1", "--verdict-window-sec", "60", ...extraArgv],
    now: () => clock.t,
    sleepFn: async (ms) => { clock.t += ms; }, // sleep 即推进假时钟（③观测窗零等待）
    fetchImpl: mockFetch, // 签发面 mock：绝不触真实端点
    transportFactory: relay ? relay.transportFactory : undefined,
    jwtLoader: () => ({ ok: true, jwt: "mock.header.payload" }),
    deviceLoader: async () => ({ ok: true, deviceSid: "sid-mock", deviceMid: "mid-mock" }),
    revivedProbe: () => revived,
  });
}

const signalsPath = (root) => path.join(root, "sentinel", "watcher-signals.jsonl");
const readSignals = (root) => {
  try { return fs.readFileSync(signalsPath(root), "utf8").split("\n").filter((x) => x.trim()).map((l) => JSON.parse(l)); } catch { return []; }
};

try {
  const BASE = makeTempRoot({ prefix: "orch-wcore-" });
  const T0 = Date.now();

  /* coord 指针根件（C11/G4/G5 守卫共用）：coord-session.txt 预置 + 计数写面 fsImpl。 */
  const mkC11 = (name, opts) => {
    const root = path.join(BASE.root, name);
    fs.mkdirSync(path.join(root, "sentinel"), { recursive: true });
    const coordPath = path.join(root, "sentinel", "coord-session.txt");
    fs.writeFileSync(coordPath, opts.coord + "\n");
    let writes = 0;
    const fsImpl = {
      readFileSync: (p, e) => fs.readFileSync(p, e),
      writeFileSync: (p, d) => { if (String(p) === coordPath || String(p).indexOf(coordPath + ".tmp-") === 0) writes++; fs.writeFileSync(p, d); },
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      renameSync: (a, b) => fs.renameSync(a, b),
    };
    return { root, coordPath, fsImpl, writesRef: () => writes };
  };

  /* ======== W-RED REDACTED 闸 ======== */
  {
    const tok = "AbC-_dEfGhIjKlMnOpQrsTg"; // 21 + [AQgw] 形态由 redact 正则吃（22 字符 base64url 形态）
    const tokenShaped = "abcdefghijklmnopqrstuA"; // 21+A
    const out1 = redact(`token=${tokenShaped} and Bearer sk-live-xyz123 end`);
    ck.ok("W-RED-01 token 22 字符 base64url 形态归零", !out1.includes(tokenShaped) && out1.includes("REDACTED"), out1);
    ck.ok("W-RED-02 Bearer 头归零（宿主 g1r 同款纪律）", out1.includes("Bearer REDACTED") && !out1.includes("sk-live-xyz123"), out1);
    ck.ok("W-RED-03 自检：归零后通过、原文不通过（grep 形态归零对账锚）", redactionSelfCheck(out1) && !redactionSelfCheck(`Bearer ${tokenShaped}`));
    const shell = buildTemplateShell({ missionId: "m-1", state: "done", summary: "ok", eventId: "latest" });
    ck.ok("W-RED-04 模板壳经 redact 恒等（壳内无凭证面）", redact(shell) === shell, shell);
    void tok;
  }

  /* ======== W-POL POLLER ======== */
  {
    const old = T0 - 3600_000;
    const board = {
      missions: [
        mission("m-done", "done", old),
        mission("m-blocked", "blocked", old - 1000),
        mission("m-acked", "done", old, { ack: { at: new Date().toISOString(), by: "coord" } }),
        mission("m-wf", "failed", old, { dispatch: { agent_id: "a", mode: "workflow" } }),
        mission("m-run", "running", old),
        mission("m-fresh", "question", T0 - 1000), // 未过宽限
      ],
    };
    const conds = classifyForWatcher(board, { nowMs: T0 });
    ck.ok("W-POL-01 未签收终态两族被分类（宽限已过），已签收/在飞/workflow/未到期排除",
      conds.length === 2 && conds.some((c) => c.missionId === "m-done") && conds.some((c) => c.missionId === "m-blocked"),
      conds.map((c) => c.missionId));
    ck.ok("W-POL-02 answer 族优先于 terminal 族（主控等人应答先敲）", conds[0].missionId === "m-blocked" && conds[0].category === "unclaimed_answer" && conds[conds.length - 1].category === "unclaimed_terminal", conds.map((c) => c.category));
    ck.ok("W-POL-03 pickNext 每轮至多一个事务", pickNext(conds).missionId === "m-blocked");
    const narrow = classifyForWatcher(board, { nowMs: T0, triggerStatuses: ["blocked", "question"] });
    ck.ok("W-POL-04 保守档触发面收窄（W-W §8.4 仅 blocked/question）", narrow.length === 1 && narrow[0].missionId === "m-blocked", narrow.map((c) => c.missionId));
    const b5board = { missions: [mission("m-b5", "done", T0, { updated_at: "not-a-date" })] };
    const b5conds = classifyForWatcher(b5board, { boardMtimeMs: T0 - 10 * 60000, nowMs: T0, terminalGraceMs: 300000 });
    ck.ok("W-POL-05 B5 备链：updated_at 不可考 → board mtime 锚（过期即到期）", b5conds.length === 1 && Math.abs(b5conds[0].anchorMs - (T0 - 10 * 60000)) < 5, b5conds[0] && b5conds[0].anchorMs);
    const nullBoard = { missions: [mission("m-x", "done", old)] };
    ck.ok("W-POL-06 readBoardSafe 坏板返回 null（不抛）", readBoardSafe.__none !== true && (() => { try { const rootB = BASE.root; fs.writeFileSync(path.join(rootB, "bad-board.json"), "{oops"); return JSON.parse("{oops") && false; } catch { return true; } })() && readBoardSafe(path.join(BASE.root, "nope-dir")) === null);
    const spoolRoot = path.join(BASE.root, "spool-pol");
    fs.mkdirSync(path.join(spoolRoot, "spool", "m-9", "unread"), { recursive: true });
    fs.writeFileSync(path.join(spoolRoot, "spool", "m-9", "unread", "001.json"), "{}");
    fs.writeFileSync(path.join(spoolRoot, "spool", "m-9", "unread", "002.json"), "{}");
    fs.mkdirSync(path.join(spoolRoot, "spool", "m-9", "read"), { recursive: true });
    ck.ok("W-POL-07 spool 未读只数不改（正文永不读取；server 布局 root/spool/<mission>/unread）", spoolUnreadCount(spoolRoot, "m-9") === 2 && spoolUnreadCount(spoolRoot, "m-none") === 0);
    ck.ok("W-POL-08 RESULT_STATUSES 口径与哨兵一致（verbatim twin）", JSON.stringify(RESULT_STATUSES) === JSON.stringify(["done", "failed", "blocked", "question"]));
  }

  /* ======== W-TXN 闸 ======== */
  {
    let t = 100000;
    const now = () => t;
    const g = new TxnGate({ now, minIntervalMs: 90000, cap: 3, busySilenceMs: 30 * 60000 });
    ck.ok("W-TXN-01 首跑放行", g.canRun("m1", t).ok === true);
    g.recordStart("m1", t);
    ck.ok("W-TXN-02 90s 频控：间隔内拒绝并给出等待", g.canRun("m2", t + 1000).ok === false && g.canRun("m2", t + 1000).reason === "min-interval" && g.canRun("m2", t + 89000).waitMs === 1000);
    t += 90000;
    ck.ok("W-TXN-03 间隔满放行", g.canRun("m2", t).ok === true);
    // 退避隔离验证：频控归零的独立闸（退避 30s/60s 远小于默认 90s 间隔，混验会互相遮蔽）
    const gb = new TxnGate({ now, minIntervalMs: 0 });
    gb.recordStart("mb2", t); gb.recordOutcome("mb2", "d2", t);
    ck.ok("W-TXN-04 D2 指数退避：第 1 次 30s", gb.canRun("mb2", t + 29000).reason === "backoff" && gb.canRun("mb2", t + 30000).ok === true);
    gb.recordStart("mb2", t + 30000); gb.recordOutcome("mb2", "d2", t + 30000);
    ck.ok("W-TXN-05 D2 退避指数 ×2：第 2 次 60s", gb.canRun("mb2", t + 89000).reason === "backoff" && gb.canRun("mb2", t + 90000).ok === true);
    g.recordStart("m2", t + 90000); g.recordOutcome("m2", "d2", t + 90000);
    g.recordStart("m2", t + 200000);
    g.recordStart("m2", t + 300000); // cap=3 铺垫：第 3 次（TXN-04/05 已移至独立闸 gb）
    ck.ok("W-TXN-06 per-mission cap=3 钉死", g.canRun("m2", t + 500000).ok === false && g.canRun("m2", t + 500000).reason === "cap-exhausted");
    t += 600000;
    const g2 = new TxnGate({ now, minIntervalMs: 0 });
    g2.recordStart("mb", t); g2.recordOutcome("mb", "busy", t);
    ck.ok("W-TXN-07 busy=1 不静默（no-op 成功不计失败）", g2.canRun("mb", t + 1).ok === true);
    g2.recordStart("mb", t + 1); g2.recordOutcome("mb", "busy", t + 1);
    ck.ok("W-TXN-08 busy×2 → 本 mission 静默 30min", g2.canRun("mb", t + 2).ok === false && g2.canRun("mb", t + 2).reason === "busy-silence" && g2.canRun("mb", t + BUSY_SILENCE_MS + 1).ok === true);
    g2.recordOutcome("mb", "success", t + BUSY_SILENCE_MS + 1);
    ck.ok("W-TXN-09 非 busy 结果打断 busy 连发计数", g2.per.get("mb").busyStreak === 0);
    ck.ok("W-TXN-10 默认频控=90s（60s 防抖+50% 裕量，W-W §8.3）", MIN_INTERVAL_MS === 90000);
    const g3 = new TxnGate({ now });
    ck.ok("W-TXN-11 nextEligibleAt 给出全局最早可跑时刻", g3.nextEligibleAt() === Infinity);
  }

  /* ======== W-TTL 签-连 ======== */
  {
    let t = 0;
    const now = () => t;
    let signs = 0;
    const slowConnect = async () => { t += 60000; throw Object.assign(new Error("ws-handshake-timeout"), { code: "ws-handshake-timeout" }); };
    let err = null;
    try {
      await signAndConnect({
        issueToken: async () => { signs++; return { ok: true, token: "tok" + signs, expiresInSec: 60 }; },
        connect: slowConnect,
        nowMs: now,
        sleepFn: async () => {},
      });
    } catch (e) { err = e; }
    ck.ok("W-TTL-01 签发恰 2 次（弃签重签一次，EXP-3 §5.4 留 5s 余量）", signs === 2, signs);
    ck.ok("W-TTL-02 双败 ttl-exhausted（W-G §4：再败→D1 面）", err && err.code === "ttl-exhausted", err && err.code);
    let signs2 = 0;
    let err2 = null;
    t = 0;
    try {
      await signAndConnect({
        issueToken: async () => { signs2++; return { ok: true, token: "t", expiresInSec: 60 }; },
        connect: async () => { throw Object.assign(new Error("ws-handshake-timeout"), { code: "ws-handshake-timeout" }); },
        nowMs: now,
      });
    } catch (e) { err2 = e; }
    ck.ok("W-TTL-03 窗口内握手败：不重签直抛（D2 瞬时面，非 TTL 面）", signs2 === 1 && err2 && err2.code === "ws-handshake-timeout", { signs: signs2, code: err2 && err2.code });
    let signs3 = 0;
    const okConn = await signAndConnect({
      issueToken: async () => { signs3++; return { ok: true, token: "t3", expiresInSec: 60 }; },
      connect: async () => ({ marker: "session-ok" }),
      nowMs: now,
    });
    ck.ok("W-TTL-04 快路径单签即连", signs3 === 1 && okConn.session.marker === "session-ok");
    const failSign = await signAndConnect({ issueToken: async () => ({ ok: false, kind: "auth-required" }), connect: async () => ({}), nowMs: now }).catch((e) => e);
    ck.ok("W-TTL-05 签发失败原样上抛（kind 透传→D1 归类）", failSign.code === "sign-failed" && failSign.kind === "auth-required");
  }

  /* ======== W-CRD CREDS ======== */
  {
    const key = deriveCredentialSecret({ env: {}, platform: "win32", homedir: "C:\\u", username: "tester" });
    const key2 = deriveCredentialSecret({ env: { ZCODE_CREDENTIAL_SECRET: "custom" }, platform: "win32", homedir: "C:\\u", username: "tester" });
    ck.ok("W-CRD-01 密钥推导确定性 + env 覆盖优先（W-G §1.1）", Buffer.compare(key, key2) !== 0 && Buffer.compare(key, deriveCredentialSecret({ env: {}, platform: "win32", homedir: "C:\\u", username: "tester" })) === 0);
    const enc = encryptEntry("jwt-secret-value", key);
    ck.ok("W-CRD-02 AES-256-GCM roundtrip（enc:v1:iv.tag.ct）", decryptEntry(enc, key) === "jwt-secret-value" && enc.startsWith("enc:v1:"));
    const badTag = enc.slice(0, -4) + "AAAA";
    ck.ok("W-CRD-03 坏 tag 安全失败返回 null（只读不动不自我修复，W-G §4）", decryptEntry(badTag, key) === null && decryptEntry("garbage", key) === null);
    const claims = b64url(JSON.stringify({ iat: 1, sub: "s", token_version: 3, user_id: "u" }));
    const shape = inspectJwt(`h.${claims}.s`);
    ck.ok("W-CRD-04 JWT 形态自检：无 exp 属预期不判过期（W-G §2）", shape.ok && shape.claims && shape.claims.tokenVersion === true && shape.claims.hasExp === false);
    ck.ok("W-CRD-05 JWT 非 3 段/不可打印拒绝", inspectJwt("only.two").ok === false && inspectJwt("a.\u0001b.c").ok === false);
    const jwtLike = `h.${b64url(JSON.stringify({ token_version: 1 }))}.s`;
    const encJwt = encryptEntry(jwtLike, key);
    const fsMock = { readFileSync: () => JSON.stringify({ "oauth:active_provider": "bigmodel", "zcodejwttoken": encJwt }), existsSync: () => true };
    const loaded = loadPlatformJwt({ credPath: "mock", key, fsImpl: fsMock });
    ck.ok("W-CRD-06 S0-S1 链：active_provider 闸 + 解密出 JWT（形态自检过）", loaded.ok === true && loaded.jwt === jwtLike);
    const badProvider = loadPlatformJwt({ credPath: "mock", key, fsImpl: { readFileSync: () => JSON.stringify({ "oauth:active_provider": "evil", "zcodejwttoken": enc }) } });
    ck.ok("W-CRD-07 provider 非 zai|bigmodel 拒绝", badProvider.ok === false && badProvider.reason === "provider-unsupported");
    const noJwt = loadPlatformJwt({ credPath: "mock", key, fsImpl: { readFileSync: () => JSON.stringify({}) } });
    const noFile = loadPlatformJwt({ credPath: path.join(BASE.root, "no-such-creds.json") });
    ck.ok("W-CRD-08 jwt 缺键/文件缺失 → D1 面原因码", noJwt.reason === "jwt-absent" && noFile.reason === "credentials-missing");
    const TOKEN_OK = "A".repeat(21) + "g";
    ck.ok("W-CRD-09 token 正则（21+[AQgw]）边界", TOKEN_RE.test(TOKEN_OK) && !TOKEN_RE.test("A".repeat(21) + "B") && !TOKEN_RE.test("A".repeat(20) + "g"));
    const goodFetch = async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, msg: "", data: { token: TOKEN_OK, expires_in: 60 } }) });
    const issued = await issueTerminalToken({ fetchImpl: goodFetch, origin: "https://x", jwt: "j" });
    ck.ok("W-CRD-10 S3 签发：EXP-1 定案形态（code=0/expires_in=60）", issued.ok && issued.expiresInSec === 60);
    const unauth = await issueTerminalToken({ fetchImpl: async () => ({ status: 401, text: async () => "" }), origin: "x", jwt: "j" });
    const badCode = await issueTerminalToken({ fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ code: 7 }) }), origin: "x", jwt: "j" });
    const badShape = await issueTerminalToken({ fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: { token: "short", expires_in: 60 } }) }), origin: "x", jwt: "j" });
    const netFail = await issueTerminalToken({ fetchImpl: async () => { throw new Error("boom"); }, origin: "x", jwt: "j" });
    ck.ok("W-CRD-11 失效树四分支：401→auth-required(D1)/code≠0→code(D1)/坏形态→safe-parse(D1)/网络→network(D2)",
      unauth.kind === "auth-required" && badCode.kind === "code" && badShape.kind === "safe-parse" && netFail.kind === "network",
      { unauth: unauth.kind, badCode: badCode.kind, badShape: badShape.kind, netFail: netFail.kind });
    const devFetch = async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: [{ device_sid: "s1", device_mid: "m1", online: false }, { device_sid: "s2", device_mid: "m2", online: true }] }) });
    const devs = await fetchDevices({ fetchImpl: devFetch, origin: "x", jwt: "j" });
    const picked = pickDesktopDevice(devs.devices, { deviceSid: "s1" });
    ck.ok("W-CRD-12 S2 设备发现+拣选：在线优先（本地交叉不敌 online）", devs.ok && picked.ok && picked.deviceSid === "s2", picked);
    const picked2 = pickDesktopDevice(devs.devices.filter((d) => !d.online), { deviceSid: "s1" });
    ck.ok("W-CRD-13 全离线时本地交叉一致者优先", picked2.ok && picked2.deviceSid === "s1");
  }

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
    const wsrc = fs.readFileSync(new URL("../../watcher/watcher.mjs", import.meta.url), "utf8");
    ck.ok("W-RESP-04 源面锁：respP 由 guardPendingResponse 创建（sendPrompt 失败路径不留裸挂起 promise）",
      wsrc.includes('guardPendingResponse(session.awaitData("session-send-response"'), "");
  }

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
    const injSrcC11 = fs.readFileSync(new URL("../../watcher/inject.mjs", import.meta.url), "utf8");
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
    const wsrcG4 = fs.readFileSync(new URL("../../watcher/watcher.mjs", import.meta.url), "utf8");
    const injSrcG4 = fs.readFileSync(new URL("../../watcher/inject.mjs", import.meta.url), "utf8");
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
    const srvSrc = fs.readFileSync(path.join(PLUGIN_DIR, "mcp", "server.mjs"), "utf8");
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

  /* ======== W-VRD VERDICT ======== */
  {
    ck.ok("W-VRD-01 ②受理分类：accepted/busy(-32010)/rejected", classifyAccept({ result: {} }).accept === "accepted" && classifyAccept({ error: { code: -32010 } }).accept === "busy" && classifyAccept({ error: { code: -32002 } }).accept === "rejected");
    ck.ok("W-VRD-02 三证矩阵：①②③全成=success", finalVerdict({ transport: "delivered", revived: true }).verdict === "success");
    ck.ok("W-VRD-03 ①②成③未成=accepted-not-revived（记成功受理+哨兵兜底不重复注入）", finalVerdict({ transport: "delivered", revived: false }).verdict === "accepted-not-revived");
    ck.ok("W-VRD-04 ②busy=noop（主控在跑不计失败，W-W §6）", finalVerdict({ transport: "busy", revived: false }).verdict === "noop" && finalVerdict({ transport: "busy", revived: true }).verdict === "noop");
    ck.ok("W-VRD-05 no-ack/failed=failed", finalVerdict({ transport: "no-ack", revived: true }).verdict === "failed" && finalVerdict({ transport: "failed", revived: true }).verdict === "failed");
    let t = 1000;
    const now = () => t;
    const fastProbe = await observeRevival({ revivedProbe: () => true, sessionId: "s", sinceMs: t, windowMs: 60000, sleepFn: async (ms) => { t += ms; }, nowMs: now });
    ck.ok("W-VRD-06 ③复活：窗内探针 true 即判", fastProbe === true);
    t = 1000;
    const slowProbe = await observeRevival({ revivedProbe: () => false, sessionId: "s", sinceMs: t, windowMs: 30000, pollMs: 10000, sleepFn: async (ms) => { t += ms; }, nowMs: now });
    ck.ok("W-VRD-07 ③窗满未复活=false（60s 判定窗 W-W §6）", slowProbe === false && t - 1000 >= 30000);
  }

  /* ======== G11 rollout 探针接线（EXP10 R4-3：verdict 系统性失真修复） ======== */
  {
    grp("G11 rollout-probe");
    // 01 探针语义：文件名形态 model-io-<sessionId>.jsonl，mtime > sinceMs 方判复活；缺失/异常归否
    const probeDir = path.join(BASE.root, "g11-rollout");
    fs.mkdirSync(probeDir, { recursive: true });
    const probeFile = path.join(probeDir, "model-io-sess-g11.jsonl");
    fs.writeFileSync(probeFile, "{}\n");
    const probeMtime = fs.statSync(probeFile).mtimeMs;
    const probe = rolloutRevivedProbe({ rolloutDir: probeDir });
    ck.ok("W-VRD-08 rolloutRevivedProbe 语义（G11）：model-io-<sessionId>.jsonl mtime>sinceMs→true、mtime≤sinceMs→false、无对应文件→false、目录缺失→false（catch 归否不抛）——与 bg-sentinel rolloutHeartbeatMs 同形态",
      probe({ sessionId: "sess-g11", sinceMs: probeMtime - 1000 }) === true &&
      probe({ sessionId: "sess-g11", sinceMs: probeMtime + 1000 }) === false &&
      probe({ sessionId: "sess-absent", sinceMs: 0 }) === false &&
      rolloutRevivedProbe({ rolloutDir: path.join(BASE.root, "g11-no-dir") })({ sessionId: "s", sinceMs: 0 }) === false,
      { mtime: probeMtime });

    // 02 目录解析三链：argv 优先（空格/= 两形）> cfg rollout_dir > 缺省 ~/.zcode/cli/rollout（bg-sentinel 同源）
    const homeMock = path.join("C:", "home", "u");
    ck.ok("G11-01 resolveRolloutDir 三链（bg-sentinel.mjs signalsOf 同源缺省）：--rollout-dir <v> 与 --rollout-dir=<v> 均压过 cfg rollout_dir；无 CLI 时 cfg 兜底；双缺省=path.join(homedir,'.zcode','cli','rollout')；空串/未展开 ${} 占位符回落 cfg",
      resolveRolloutDir(["--rollout-dir", "D:/r1"], { rollout_dir: "D:/cfg" }, { homedir: homeMock }) === "D:/r1" &&
      resolveRolloutDir(["--rollout-dir=D:/r2"], {}, { homedir: homeMock }) === "D:/r2" &&
      resolveRolloutDir([], { rollout_dir: "D:/cfg" }, { homedir: homeMock }) === "D:/cfg" &&
      resolveRolloutDir([], {}, { homedir: homeMock }) === path.join(homeMock, ".zcode", "cli", "rollout") &&
      resolveRolloutDir(["--rollout-dir", "${ZCODE_ROLLOUT_DIR}"], { rollout_dir: "D:/cfg" }, { homedir: homeMock }) === "D:/cfg",
      { emptyArgv: resolveRolloutDir([], {}, { homedir: homeMock }) });

    // 03 main() 组装面源面锁：解析→构造探针→传入 createWatcher→启动行观测字段（防回退成恒否探针）
    const wsrcG11 = fs.readFileSync(new URL("../../watcher/watcher.mjs", import.meta.url), "utf8");
    ck.ok("G11-02 main() 组装面接线源面锁（EXP10 R4-3 根因：rolloutRevivedProbe 导出存在但 main 从未传 revivedProbe→③观测恒否）：resolveRolloutDir(argv, loadCfg(rootDir))→createWatcher({…, revivedProbe: rolloutRevivedProbe({ rolloutDir })})，启动行含 rollout=<dir> 观测字段",
      wsrcG11.includes("const rolloutDir = resolveRolloutDir(argv, loadCfg(rootDir));") &&
      wsrcG11.includes("revivedProbe: rolloutRevivedProbe({ rolloutDir })") &&
      wsrcG11.includes("rollout=${rolloutDir}"),
      { resolve: wsrcG11.includes("resolveRolloutDir(argv, loadCfg(rootDir))"), probe: wsrcG11.includes("rolloutRevivedProbe({ rolloutDir })") });

    // 04 --once 真进程启动行（空板=board-unreadable 零事务）：rollout 段观测值=传入目录
    const g11Root = path.join(BASE.root, "g11-main-root");
    const g11Rollout = path.join(BASE.root, "g11-main-rollout");
    const g11Run = runNode(path.join(PLUGIN_DIR, "watcher", "watcher.mjs"), ["--root", g11Root, "--rollout-dir", g11Rollout, "--once"], { timeoutMs: 20000 });
    const g11Line = String(g11Run.stdout).split("\n").find((l) => l.includes("[watcher] 启动")) || "";
    ck.ok("G11-03 main --once 启动行 rollout 观测字段：rollout=<--rollout-dir 值> 在位且进程 exit 0（空板首轮 board-unreadable 即返，零事务零网络）",
      g11Run.code === 0 && g11Line.includes("rollout=" + g11Rollout) &&
      String(g11Run.stdout).includes('"state":"board-unreadable"'),
      { code: g11Run.code, line: g11Line, out: String(g11Run.stdout).slice(0, 300) });
  }

  /* ======== W-DGR DEGRADE ======== */
  {
    const table = [
      ["sign-auth-required", "D1"], ["sign-code", "D1"], ["sign-safe-parse", "D1"], ["credentials-missing", "D1"],
      ["credentials-corrupt", "D1"], ["decrypt-failed", "D1"], ["jwt-absent", "D1"], ["jwt-shape", "D1"],
      ["auth-failed", "D1"], ["close-4013", "D1"], ["ttl-exhausted", "D1"],
      ["kicked", "kicked"], ["close-4009", "kicked"],
      ["bridge-list-empty", "D3"], ["close-4004", "D3"], ["close-4012", "D3"], ["wrong-param", "D3"], ["session-target-missing", "D3"],
      ["connect-failed", "D2"], ["handshake-timeout", "D2"], ["auth-ack-timeout", "D2"], ["auth-not-matched", "D2"],
      ["close-4011", "D2"], ["close-4010", "D2"], ["rpc-ack-timeout", "D2"], ["hold-timeout", "D2"], ["sign-network", "D2"], ["mystery-kind", "D2"],
    ];
    const bad = table.filter(([k, want]) => classifyFailure({ kind: k }).cls !== want);
    ck.ok("W-DGR-01 降级树全表（28 码→D1×11/kicked×2/D3×5/D2×10，W-W §7+W-G §4）", bad.length === 0, bad);
    const root = path.join(BASE.root, "dg");
    const dg = new DegradeState({ rootDir: root, now: () => T0 });
    dg.record({ cls: "D2", missionId: "m-d2", reason: "connect-failed" });
    ck.ok("W-DGR-02 D2 临时：全局态保持 active + signals 落盘回哨兵", dg.terminal === false && dg.state.cls === CLASSES.ACTIVE && readSignals(root).some((s) => s.cls === "D2" && s.mission === "m-d2"));
    dg.record({ cls: "D1", missionId: "m-d1", reason: "sign-auth-required with token abcdefghijklmnopqrstuA inside" });
    ck.ok("W-DGR-03 D1 终态：standby+signals+reason 脱敏（token 形态不落盘）", dg.terminal && dg.state.cls === "D1" && readSignals(root).some((s) => s.cls === "D1" && s.reason.includes("REDACTED") && !s.reason.includes("abcdefghijklmnopqrstuA")));
    dg.record({ cls: "D3", missionId: "m-d3", reason: "close-4004" });
    ck.ok("W-DGR-04 D3 终态：配置告警面", dg.state.cls === "D3" && dg.terminal);
    const dgr = new DegradeState({ rootDir: path.join(BASE.root, "dg2"), now: () => T0 });
    for (let i = 0; i < SIGNALS_MAX_LINES + 40; i++) dgr.record({ cls: "D2", missionId: "m" + i, reason: "r" + i });
    ck.ok("W-DGR-05 signals 滚动 256 行封顶（截半，哨兵同款）", readSignals(path.join(BASE.root, "dg2")).length <= SIGNALS_MAX_LINES);
    ck.ok("W-DGR-06 failureFromClose：closeInfo→failure 码", failureFromClose({ code: 4004, name: "SessionNotFound" }).kind === "close-4004" && failureFromClose(null).kind === "relay-closed");
    ck.ok("W-DGR-07 NOOP 不写 signals 不改态（busy=no-op 成功）", (() => { const r3 = path.join(BASE.root, "dg3"); const d3 = new DegradeState({ rootDir: r3, now: () => T0 }); d3.record({ cls: CLASSES.NOOP, missionId: "m", reason: "busy-noop" }); return d3.state.cls === CLASSES.ACTIVE && readSignals(r3).length === 0; })());
  }

  /* ======== W-E2E 全链（mock relay+mock 凭据） ======== */
  {
    // E2E-1 happy：全三证 success；短事务即断；壳进 rpc-frame；心跳在位
    {
      const root = path.join(BASE.root, "e2e-ok");
      const relay = new MockRelay({ noiseBeforeBridge: true });
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-ok", "done", Date.now() - 3600_000)] });
      const r1 = await w.tick();
      ck.ok("W-E2E-01 happy 全链 verdict=success（三证合一）", r1.state === "transacting" && r1.outcome === "success", r1);
      ck.ok("W-E2E-02 连-发-断：事务毕 transport 已 close（短事务形态 W-W §8）", relay.transports[0].closed === true && relay.transports[0].closeArgs.code === 1000);
      const frameDec = relay.captured.find((c) => c.header && c.header[3] === "sendConversationCommandV4"); // W3s：G8 握手两帧先于命令，命令帧按方法名寻址
      const frameArgs = frameDec && Array.isArray(frameDec.body) && frameDec.body.length === 1 ? frameDec.body[0] : null; // G9：位置参数组
      const shellText = frameArgs && frameArgs.envelope ? frameArgs.envelope.payload.text : "";
      ck.ok("W-E2E-03 注入壳=id+状态+spool 指针（正文留 spool 隐私最小化；内层=VQL 频道调用 [100,id,zcode-agent,sendConversationCommandV4]，sessionId=coord 目标；L4 W3r payload 直传；W3s 基线修订：命令帧前置 G8 握手两帧按方法名寻址；G3 基线修订：命令 body=位置参数组 [params]，envelope 在 body[0]）",
        frameDec && Array.isArray(frameDec.header) && frameDec.header[0] === 100 && frameDec.header[2] === "zcode-agent" &&
        frameDec.header[3] === "sendConversationCommandV4" && Array.isArray(frameDec.body) && frameArgs.envelope.sessionId === "sess-coord-test" &&
        String(shellText).startsWith("[orch-watch] mission=m-ok state=done") && String(shellText).includes("spool/m-ok/unread/latest.json（路径指针，非正文）"), shellText);
      ck.ok("W-E2E-04 桥接前噪声推送帧被计数吞掉（EXP-3 F4 全链复现：新形 payload 噪声在位且事务照常 success）",
        (relay.serverSent || []).some((m) => m.payload && m.payload.zcode_type === "desktop-state-push") && r1.outcome === "success", { noise: (relay.serverSent || []).some((m) => m.payload && m.payload.zcode_type === "desktop-state-push"), outcome: r1.outcome });
      ck.ok("W-E2E-05 心跳自证文件在位（哨兵反向监控面，60s mtime 即心跳）", fs.existsSync(path.join(root, "sentinel", "watcher-heartbeat")));
      ck.ok("W-E2E-06 ws2 URL 带 mock mid 且成功触发建连", (relay.urls || [""])[0].includes("mid=mid-mock"));
    }
    // E2E-2 busy×2 → 静默
    {
      const root = path.join(BASE.root, "e2e-busy");
      const relay = new MockRelay({ mode: "busy" });
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-busy", "blocked", Date.now() - 3600_000)] });
      const r1 = await w.tick();
      const r2 = await w.tick();
      const r3 = await w.tick();
      ck.ok("W-E2E-07 busy 两轮=noop×2（不计失败）", r1.outcome === "noop" && r2.outcome === "noop");
      ck.ok("W-E2E-08 第三轮被 busy-silence 闸住（30min 静默 W-W §7）", r3.state === "gated" && r3.reason === "busy-silence", r3);
    }
    // E2E-3 kicked：断路+绝不重连
    {
      const root = path.join(BASE.root, "e2e-kick");
      const relay = new MockRelay({ mode: "kicked" });
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-k", "done", Date.now() - 3600_000)] });
      const r1 = await w.tick();
      ck.ok("W-E2E-09 KICKED→kicked 终态（第一禁令：静默退出绝不重连）", r1.outcome === "kicked" && w.disabled === "kicked" && relay.connCount === 1, r1);
      const r2 = await w.tick();
      ck.ok("W-E2E-10 终态后 tick 转 standby 停事务面（进程不退出，心跳继续）", r2.state === "kicked" && fs.existsSync(path.join(root, "sentinel", "watcher-heartbeat")));
      ck.ok("W-E2E-11 kicked 写入 signals（哨兵接管面）", readSignals(root).some((s) => s.cls === "kicked"));
    }
    // E2E-4 D1 凭据缺失（真实 loadPlatformJwt 走空根）
    {
      const root = path.join(BASE.root, "e2e-d1");
      const relay = new MockRelay();
      writeBoard(root, [mission("m-d1", "done", Date.now() - 3600_000)]);
      writeCoord(root);
      const w = createWatcher({
        rootDir: root,
        argv: ["--poll-sec", "1", "--min-interval-sec", "0", "--hold-max-sec", "1", "--verdict-window-sec", "1"],
        transportFactory: relay.transportFactory,
        jwtLoader: () => loadPlatformJwt({ credPath: path.join(root, "no-credentials.json") }), // 真实 S0 链
        deviceLoader: async () => ({ ok: true, deviceSid: "s", deviceMid: "m" }),
        revivedProbe: () => true,
      });
      const r1 = await w.tick();
      ck.ok("W-E2E-12 凭据缺失→D1 终态（真实 S0 链：credentials-missing）", r1.outcome === "D1" && w.disabled === "D1" && relay.connCount === 0, r1);
      ck.ok("W-E2E-13 D1 signals 在位（哨兵全量接管）", readSignals(root).some((s) => s.cls === "D1" && s.reason === "credentials-missing"));
    }
    // E2E-5 D3 coord-session 缺失
    {
      const root = path.join(BASE.root, "e2e-d3");
      const relay = new MockRelay();
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-d3", "done", Date.now() - 3600_000)], coord: false });
      const r1 = await w.tick();
      ck.ok("W-E2E-14 目标会话缺失→D3 配置告警终态（W-W §4）", r1.outcome === "D3" && w.disabled === "D3" && relay.connCount === 0);
    }
    // E2E-6 D2 建连败→退避
    {
      const root = path.join(BASE.root, "e2e-d2");
      const relay = new MockRelay({ failHandshake: true });
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-d2", "done", Date.now() - 3600_000)] });
      const r1 = await w.tick();
      const r2 = await w.tick();
      ck.ok("W-E2E-15 建连败→D2 瞬时（本轮弃发写 signals，下轮重评）", r1.outcome === "D2" && readSignals(root).some((s) => s.cls === "D2"), r1);
      ck.ok("W-E2E-16 退避期内 tick 被 gate（指数退避回哨兵兜底语义）", r2.state === "gated" && r2.reason === "backoff", r2);
    }
    // E2E-7 close 4011 面经 signAndConnect 透传
    {
      const root = path.join(BASE.root, "e2e-4011");
      const relay = new MockRelay({ mode: "close4011" });
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-ttl", "done", Date.now() - 3600_000)] });
      const r1 = await w.tick();
      ck.ok("W-E2E-17 中继 4011（TTL 耗尽）→close-4011→D2（首败重签语义，零缓存下轮自然重签）", r1.outcome === "D2" && readSignals(root).some((s) => s.reason === "close-4011"), r1);
    }
    // E2E-8 持有帽（加速 1s）：noack→强制断→hold-timeout→D2+slot 释放
    {
      const root = path.join(BASE.root, "e2e-hold");
      const relay = new MockRelay({ mode: "noack" });
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-hold", "done", Date.now() - 3600_000)] });
      const r1 = await w.tick();
      ck.ok("W-E2E-18 持有帽到点强制断（EXP-3 §5.1 slot 礼仪 ≤40s，加速 1s 验证）", r1.outcome === "D2" && relay.transports[0].closed === true, r1);
      ck.ok("W-E2E-19 hold-timeout 归 D2 面", readSignals(root).some((s) => s.reason === "hold-timeout"));
    }
    // E2E-9 accepted-not-revived：①②成③未成不写失败信号
    {
      const root = path.join(BASE.root, "e2e-anr");
      const relay = new MockRelay();
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-anr", "done", Date.now() - 3600_000)], revived: false });
      const r1 = await w.tick();
      ck.ok("W-E2E-20 受理未唤醒=accepted-not-revived（哨兵兜底不重复注入）", r1.outcome === "accepted-not-revived" && w.disabled === null && readSignals(root).length === 0, r1);
    }
    // E2E-10 accept-reject（非 busy 错误）→ D2
    {
      const root = path.join(BASE.root, "e2e-rej");
      const relay = new MockRelay({ mode: "accept-reject" });
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-rej", "done", Date.now() - 3600_000)] });
      const r1 = await w.tick();
      ck.ok("W-E2E-21 ②受理被拒（非 busy）→failed→D2 瞬时归类", r1.outcome === "D2" && relay.transports[0].closed === true, r1);
    }
    // E2E-11 触发面收窄（保守档）+ 板不可读容错
    {
      const root = path.join(BASE.root, "e2e-narrow");
      const relay = new MockRelay();
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-only-done", "done", Date.now() - 3600_000)], extraArgv: ["--trigger-statuses", "blocked,question"] });
      const r1 = await w.tick();
      ck.ok("W-E2E-22 保守档触发面收窄：done 不触发注入（W-W §8.4 可配）", r1.state === "idle" && relay.connCount === 0, r1);
      fs.writeFileSync(path.join(root, "board.json"), "{broken");
      const r2 = await w.tick();
      ck.ok("W-E2E-23 板损坏容错：board-unreadable 不炸不误发", r2.state === "board-unreadable" && relay.connCount === 0);
    }
    // E2E-12 resolveRoot：显式 root 优先；默认 cwd 面
    {
      const rr = resolveRoot(["--root", path.join(BASE.root, "rr1")]);
      ck.ok("W-E2E-24 resolveRoot 显式 --root 优先且建目录", rr === path.join(BASE.root, "rr1") && fs.existsSync(rr));
    }
  }

  /* ======== W-TRN/W-DGR2 transport 层（v0.10 W2：cloud|loopback 切换 + D2 双 env 提示） ======== */
  {
    grp("W-TRN transport");
    /* 记账 mock fetch：按 URL 返回 device/token 同构形状（shim 与 cloud 零协议分支，同函数同形状）。 */
    const makeRecFetch = () => {
      const rec = { urls: [], methods: [] };
      const fn = async (url, opts) => {
        rec.urls.push(String(url));
        rec.methods.push((opts && opts.method) || "GET");
        const body = String(url).indexOf("/remote/token") >= 0
          ? { code: 0, msg: "", data: { token: "A".repeat(21) + "g", expires_in: 60 } }
          : { code: 0, msg: "", data: [{ device_sid: "sid-shim", device_mid: "mid-shim", online: true, meta: {} }] };
        return { status: 200, text: async () => JSON.stringify(body) };
      };
      fn.rec = rec;
      return fn;
    };
    /* W-TRN-01a loopback 切换：端点/token 落 loopbackOrigin + JWT 跳过（S0 免，零出站）。 */
    {
      const root = path.join(BASE.root, "trn-lb");
      const relay = new MockRelay();
      const f = makeRecFetch();
      let jwtCalls = 0;
      writeBoard(root, [mission("m-lb", "done", Date.now() - 3600_000)]);
      writeCoord(root);
      const w = createWatcher({
        rootDir: root,
        argv: ["--poll-sec", "1", "--min-interval-sec", "0", "--hold-max-sec", "1", "--verdict-window-sec", "60",
          "--transport", "loopback", "--loopback-origin", "http://127.0.0.1:7897"],
        now: () => Date.now(),
        sleepFn: async () => {},
        fetchImpl: f,
        transportFactory: relay.transportFactory,
        jwtLoader: () => { jwtCalls++; return { ok: true, jwt: "must-not-load" }; },
        revivedProbe: () => true,
      });
      const r1 = await w.tick();
      ck.ok("W-TRN-01a loopback 切换：device/token 端点全落 loopbackOrigin 且 JWT 跳过（S0 免，零出站）",
        f.rec.urls.length === 2 && f.rec.urls[0].indexOf("http://127.0.0.1:7897/api/v1/remote/device") === 0 &&
        f.rec.urls[1].indexOf("http://127.0.0.1:7897/api/v1/remote/token") === 0 && jwtCalls === 0, { urls: f.rec.urls, jwtCalls });
      ck.ok("W-TRN-01b loopback ws URL 取 loopbackOrigin（buildWs2Url 零改动，http→ws 闸）",
        (relay.urls[0] || "").indexOf("ws://127.0.0.1:7897/api/v1/remote/ws2?") === 0 && (relay.urls[0] || "").indexOf("mid=mid-shim") >= 0, relay.urls);
      ck.ok("W-TRN-01c 零协议分支：loopback 全链事务 success（同函数同形状，relay.mjs/credentials.mjs 零改动复用）",
        r1.outcome === "success", r1);
    }
    /* W-TRN-01d cloud 缺省逐字节锁（CR-04）。 */
    {
      const root = path.join(BASE.root, "trn-cloud");
      const relay = new MockRelay();
      const f = makeRecFetch();
      let jwtCalls = 0;
      writeBoard(root, [mission("m-cloud", "done", Date.now() - 3600_000)]);
      writeCoord(root);
      const w = createWatcher({
        rootDir: root,
        argv: ["--poll-sec", "1", "--min-interval-sec", "0", "--hold-max-sec", "1", "--verdict-window-sec", "60"],
        now: () => Date.now(),
        sleepFn: async () => {},
        fetchImpl: f,
        transportFactory: relay.transportFactory,
        jwtLoader: () => { jwtCalls++; return { ok: true, jwt: "mock.header.payload" }; },
        revivedProbe: () => true,
      });
      const r1 = await w.tick();
      ck.ok("W-TRN-01d cloud 缺省逐字节锁（CR-04）：端点与 ws URL 全落缺省 origin 且 JWT 恰一次",
        f.rec.urls.length === 2 && f.rec.urls[0].indexOf("https://zcode.z.ai/api/v1/remote/device") === 0 &&
        f.rec.urls[1].indexOf("https://zcode.z.ai/api/v1/remote/token") === 0 &&
        (relay.urls[0] || "").indexOf("wss://zcode.z.ai/api/v1/remote/ws2?") === 0 && jwtCalls === 1 && r1.outcome === "success",
        { urls: f.rec.urls, ws: relay.urls, jwtCalls, outcome: r1.outcome });
    }
    /* W-TRN-01e cfg 三键落位（snake/camel 双拼等效 + port 派生 + CLI>cfg + 缺省=cloud）。 */
    {
      const mkRoot = (name, cfgObj) => {
        const r = path.join(BASE.root, name);
        fs.mkdirSync(r, { recursive: true });
        if (cfgObj) fs.writeFileSync(path.join(r, "watcher.cfg.json"), JSON.stringify(cfgObj));
        return r;
      };
      const wa = createWatcher({ rootDir: mkRoot("trn-cfg-snake", { transport: "loopback", loopback_origin: "http://127.0.0.1:7901/" }), argv: [], fsImpl: fs });
      const rb = mkRoot("trn-cfg-camel", { transport: "loopback", loopbackOrigin: "http://localhost:7902", loopbackPort: 7903 });
      const wb = createWatcher({ rootDir: rb, argv: [], fsImpl: fs });
      const wc = createWatcher({ rootDir: rb, argv: ["--transport", "cloud"], fsImpl: fs });
      const wd = createWatcher({ rootDir: mkRoot("trn-cfg-empty", null), argv: [], fsImpl: fs });
      ck.ok("W-TRN-01e cfg 三键落位：snake/camel 双拼等效（尾斜杠归一）+loopbackPort 派生+CLI>cfg+缺省=cloud",
        wa.cfg.transport === "loopback" && wa.cfg.loopbackOrigin === "http://127.0.0.1:7901" &&
        wb.cfg.loopbackOrigin === "http://localhost:7902" && wc.cfg.transport === "cloud" && wc.cfg.loopbackOrigin === "" &&
        wd.cfg.transport === "cloud" && wd.cfg.loopbackOrigin === "", { a: wa.cfg.loopbackOrigin, b: wb.cfg.loopbackOrigin });
    }
    /* W-TRN-02 非法值/非回环 host/缺端点 → 启动即拒。 */
    {
      const mk = (name, argv, cfgObj) => {
        const r = path.join(BASE.root, name);
        fs.mkdirSync(r, { recursive: true });
        if (cfgObj) fs.writeFileSync(path.join(r, "watcher.cfg.json"), JSON.stringify(cfgObj));
        try { createWatcher({ rootDir: r, argv, fsImpl: fs }); return false; } catch (e) { return String((e && e.message) || e); }
      };
      const rLan = mk("trn-bad-lan", ["--transport", "lan"]);
      const rCase = mk("trn-bad-case", ["--transport", "LoopBack"]);
      const rCfg = mk("trn-bad-cfg", [], { transport: "ssh" });
      const rHost = mk("trn-bad-host", ["--transport", "loopback", "--loopback-origin", "http://192.168.1.9:8080"]);
      const rAllBind = mk("trn-bad-allbind", ["--transport", "loopback", "--loopback-origin", "http://0.0.0.0:8080"]);
      const rHttps = mk("trn-bad-https", ["--transport", "loopback", "--loopback-origin", "https://zcode.z.ai"]);
      const rMissing = mk("trn-bad-missing", ["--transport", "loopback"]);
      ck.ok("W-TRN-02 非法 transport 启动即拒：lan 不预留枚举/大小写敏感/cfg 路径同拒",
        typeof rLan === "string" && rLan.indexOf("lan") >= 0 && typeof rCase === "string" && typeof rCfg === "string", { rLan, rCase, rCfg });
      ck.ok("W-TRN-02b loopbackOrigin 非回环 host 启动即拒（SHIM-03 同轴：内网 host/0.0.0.0/https 面全拒）+缺端点拒",
        typeof rHost === "string" && rHost.indexOf("192.168.1.9") >= 0 && typeof rAllBind === "string" &&
        typeof rHttps === "string" && typeof rMissing === "string", { rHost, rAllBind, rHttps, rMissing });
      ck.ok("W-TRN-02c --loopback-port 合法派生 origin（托管拉起 --port 契约面）",
        createWatcher({ rootDir: path.join(BASE.root, "trn-bad-missing"), argv: ["--transport", "loopback", "--loopback-port", "7899"], fsImpl: fs }).cfg.loopbackOrigin === "http://127.0.0.1:7899");
    }
    /* W-DGR2-01 loopback 断连/空设备表 → D2 提示含桌面双 env 名。 */
    {
      const root = path.join(BASE.root, "dgr2-lb");
      const rec = { urls: [] };
      const emptyFetch = async (url) => { rec.urls.push(String(url)); return { status: 200, text: async () => JSON.stringify({ code: 0, msg: "", data: [] }) }; };
      writeBoard(root, [mission("m-dgr2", "done", Date.now() - 3600_000)]);
      writeCoord(root);
      const w = createWatcher({
        rootDir: root,
        argv: ["--poll-sec", "1", "--min-interval-sec", "0", "--hold-max-sec", "1", "--verdict-window-sec", "60",
          "--transport", "loopback", "--loopback-origin", "http://127.0.0.1:7897"],
        now: () => Date.now(),
        sleepFn: async () => {},
        fetchImpl: emptyFetch,
        transportFactory: new MockRelay().transportFactory,
        jwtLoader: () => { throw new Error("loopback-must-not-load-jwt"); },
        revivedProbe: () => true,
      });
      const lines = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s) => { lines.push(String(s)); return true; };
      let r1;
      try { r1 = await w.tick(); } finally { process.stdout.write = origWrite; }
      const all = lines.join("");
      ck.ok("W-DGR2-01 loopback 空设备表→D2 瞬时且提示词含桌面双 env 名与端点 origin（RELAY_WS_URL+ENDPOINT_ORIGIN）",
        r1.outcome === "D2" && all.indexOf("ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL") >= 0 &&
        all.indexOf("ZCODE_ENDPOINT_ORIGIN") >= 0 && all.indexOf("http://127.0.0.1:7897") >= 0,
        { outcome: r1.outcome, hit: lines.filter((l) => l.indexOf("loopback") >= 0).join(" | ").slice(0, 300) });
      ck.ok("W-DGR2-01b D2 写 signals 回哨兵且不落 setting.json 备链（空表=桌面 env 未生效语义，S1 后即断）",
        readSignals(root).some((s) => s.cls === "D2" && s.mission === "m-dgr2") && rec.urls.length === 1, rec);
      const cap = [];
      const dg = new DegradeState({ rootDir: path.join(BASE.root, "dgr2-unit"), now: () => Date.now(), log: (l) => cap.push(l) });
      dg.record({ cls: CLASSES.D2, missionId: "m-h", reason: "connect-failed", hint: loopbackD2Hint({ origin: "http://127.0.0.1:7897" }) });
      const cap2 = [];
      const dg2 = new DegradeState({ rootDir: path.join(BASE.root, "dgr2-unit2"), now: () => Date.now(), log: (l) => cap2.push(l) });
      dg2.record({ cls: CLASSES.D2, missionId: "m", reason: "connect-failed" });
      const hintUnit = cap.join("");
      ck.ok("W-DGR2-01c degrade hint 参数：loopback 提示含双 env 名；cloud 不传=零输出（CR-04 面）",
        hintUnit.indexOf("ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL") >= 0 && hintUnit.indexOf("ZCODE_ENDPOINT_ORIGIN") >= 0 &&
        cap2.length === 0, hintUnit);
    }
  }

  /* ======== W-WS RFC6455 codec ======== */
  {
    ck.ok("W-WS-01 acceptKey RFC6455 §1.3 标准向量", acceptKey("dGhlIHNhbXBsZSBub25jZQ==") === "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    const mk = Buffer.from([1, 2, 3, 4]);
    const frame = encodeFrame({ opcode: OP.TEXT, payload: Buffer.from("hello ws", "utf8"), maskKey: mk });
    const parsed = new FrameParser().push(frame);
    ck.ok("W-WS-02 掩码 TEXT 帧编解 roundtrip（客户端帧必掩码）", parsed.length === 1 && parsed[0].opcode === OP.TEXT && parsed[0].payload === "hello ws" && parsed[0].fin === true);
    const long = Buffer.alloc(300, 0x41);
    const p2 = new FrameParser().push(encodeFrame({ opcode: OP.BINARY, payload: long, maskKey: mk }));
    ck.ok("W-WS-03 16 位长度路径（300B）", p2.length === 1 && p2[0].payload.length === 300);
    const bigger = Buffer.alloc(70000, 0x42);
    const p3 = new FrameParser().push(encodeFrame({ opcode: OP.BINARY, payload: bigger, maskKey: mk }));
    ck.ok("W-WS-04 64 位长度路径（70000B>65535）", p3.length === 1 && p3[0].payload.length === 70000);
    const parts = [
      encodeFrame({ opcode: OP.TEXT, payload: Buffer.from("aa"), mask: false, maskKey: null }),
    ];
    // 分片：FIN=0 TEXT + FIN=0 CONT + FIN=1 CONT
    const f0 = encodeFrame({ opcode: OP.TEXT, payload: Buffer.from("he"), maskKey: mk });
    f0[0] = f0[0] & 0x7f; // 清 FIN
    const c0 = encodeFrame({ opcode: OP.CONT, payload: Buffer.from("ll"), maskKey: mk });
    c0[0] = c0[0] & 0x7f;
    const c1 = encodeFrame({ opcode: OP.CONT, payload: Buffer.from("o"), maskKey: mk });
    const p4 = new FrameParser().push(Buffer.concat([f0, c0, c1]));
    ck.ok("W-WS-05 分片重装（FIN=0+CONT 链→单 TEXT）", p4.length === 1 && p4[0].opcode === OP.TEXT && p4[0].payload === "hello", p4[0] && p4[0].payload);
    void parts;
    const ping = new FrameParser().push(encodeFrame({ opcode: OP.PING, payload: Buffer.from("pi"), mask: false }));
    ck.ok("W-WS-06 控制帧 PING 直通（自动 PONG 在 WsConn 协议层）", ping.length === 1 && ping[0].opcode === OP.PING);
    const closeBuf = encodeFrame({ opcode: OP.CLOSE, payload: (() => { const r = Buffer.from("SessionExpired"); const b = Buffer.alloc(2 + r.length); b.writeUInt16BE(4011); r.copy(b, 2); return b; })(), mask: false });
    const pClose = new FrameParser().push(closeBuf);
    ck.ok("W-WS-07 CLOSE 帧解出 code=4011（关断码面入口）", pClose[0].opcode === OP.CLOSE && pClose[0].payload.readUInt16BE(0) === 4011);
    const req = buildUpgradeRequest({ host: "zcode.z.ai", port: 443, path: "/api/v1/remote/ws2?token=REDACTED&mid=m1", key: "K", origin: "https://x" });
    ck.ok("W-WS-08 upgrade 请求形状（GET/Key/Version/Origin，token 只在 path）", req.startsWith("GET /api/v1/remote/ws2?") && req.includes("Sec-WebSocket-Key: K") && req.includes("Sec-WebSocket-Version: 13") && req.includes("Origin: https://x") && req.endsWith("\r\n\r\n"));
    const accept = acceptKey("K");
    const respBytes = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`, "latin1");
    const rOk = parseUpgradeResponse(Buffer.concat([respBytes, frame]), "K");
    ck.ok("W-WS-09 101+Accept 校验过且 rest=帧流起点", rOk.ok === true && rOk.rest.length === frame.length);
    const rBad = parseUpgradeResponse(Buffer.concat([respBytes, frame]), "OTHER");
    const rReject = parseUpgradeResponse(Buffer.from("HTTP/1.1 403 Forbidden\r\n\r\n"), "K");
    const rPartial = parseUpgradeResponse(Buffer.from("HTTP/1.1 101 S", "latin1"), "K");
    ck.ok("W-WS-10 握手三拒：Accept 错/非 101/半包 incomplete", rBad.error === "accept-mismatch" && rReject.error === "handshake-rejected" && rPartial.incomplete === true);
  }

  void T0;
  BASE.cleanup();
} catch (err) {
  ck.ok("SUITE-FATAL（未捕获异常）", false, { msg: String((err && err.stack) || err).slice(0, 600) });
}

const { pass, fail } = ck.summary();
process.exit(fail ? 1 : 0);
