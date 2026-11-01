// @module suites/watcher-core/mock-relay
/*!
 * watcher-core/mock-relay.mjs —— mock relay（内存对，零 socket 零触网）。
 * 拆分自 suites/watcher-core.mjs；MockTransport/MockRelay 类体零改动。
 */
import { encodeRpcFrame } from "../../../watcher/bridge.mjs";
import { vqlEncode, vqlDecode } from "../../../watcher/inject.mjs";

/* ================= mock relay（内存对，零 socket 零触网） ================= */

export class MockTransport {
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

export class MockRelay {
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
