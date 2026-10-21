/*!
 * watcher/relay.mjs —— RELAY V2 ws2 连接器（W-W §3 六步协议面 + EXP-3 §5 实测精化）
 *
 * 协议形态（V2，challenge/proof 已消解，W-F3 §2.2）：token 签发（HTTP，credentials.mjs）
 * → 建连 ws2?token&mid → auth_init(client_ts 秒制) → auth_ack(pair_status) → L2 桥接
 * → rpc-frame session/send → 判定即断。
 *
 * EXP-3 实测收编：
 *   - 零心跳（F2/§5.3）：本文件无任何应用层 ping/pong/keepalive 代码路径；传输层（ws.mjs）
 *     仅协议级自动应答。握手闸 15s 维持。
 *   - TTL=握手门票非连接租约（F1/§5.4）：本文件不管 TTL 时钟（txn.signAndConnect 管）。
 *   - 非请求 data 帧=噪声（F4/§5.5）：解析面只认 auth_ack / pair_status_* / error 信号类，
 *     data 帧计入 metrics.noise 后按订阅分发（bridge 订阅 L2 响应），永不当作错误。
 *   - 互踢第一禁令（W-W §8.2）：error 帧 KICKED → session.kicked=true 静默 close，
 *     绝不重连（重连策略不存在于本文件；上层看到 kicked 也必须放弃）。
 *
 * 关断码面（W-W §3 / Xds@1045338）：4004 SessionNotFound / 4009 Conflict / 4010
 * DesktopDisconnected / 4011 SessionExpired / 4012 WorkspaceClosed / 4013
 * InvalidMobileConnection → mapClose() 归入降级树四类（degrade.mjs 消费）。
 * 帧形状按 W-W §3 表实现（type 信封 + data.zcode_type L2）；活体集成阶段若与实测有出入，
 * 以实弹修订 SHAPES 注释为准（W-W §11.5 同纪律）。
 * 零 npm 依赖；node >= 20。
 */
import { connectWs } from "./ws.mjs";

export const CLOSE_FACES = {
  4004: "SessionNotFound",
  4009: "Conflict",
  4010: "DesktopDisconnected",
  4011: "SessionExpired",
  4012: "WorkspaceClosed",
  4013: "InvalidMobileConnection",
};

export const ERROR_FACES = ["KICKED", "DEVICE_OFFLINE", "AUTH_FAILED", "WRONG_PARAM", "INTERNAL"];

/** 关断码 → {name, cls}；cls ∈ degrade.CLASSES。 */
export function mapClose(code) {
  switch (code) {
    case 4004: return { name: CLOSE_FACES[4004], cls: "D3" };        // 目标会话不存在=coord-session 失效面
    case 4009: return { name: CLOSE_FACES[4009], cls: "kicked" };    // 冲突=互踢族，第一禁令静默
    case 4010: return { name: CLOSE_FACES[4010], cls: "D2" };        // 桌面断连=瞬时，退避重试
    case 4011: return { name: CLOSE_FACES[4011], cls: "resign" };    // TTL 耗尽=弃签重签一次（txn 层）
    case 4012: return { name: CLOSE_FACES[4012], cls: "D3" };        // workspace 关闭=配置面
    case 4013: return { name: CLOSE_FACES[4013], cls: "D1" };        // 终端连接被拒=凭证/终端面
    default:   return { name: "Close" + Number(code), cls: "D2" };   // 未知码保守归瞬时
  }
}

/** 带内 error{code} → {name, cls}。 */
export function mapErrorFrame(errObj) {
  const name = errObj && typeof errObj.code === "string" ? errObj.code : "INTERNAL";
  switch (name) {
    case "KICKED": return { name, cls: "kicked" };
    case "DEVICE_OFFLINE": return { name, cls: "D2" };
    case "AUTH_FAILED": return { name, cls: "D1" };
    case "WRONG_PARAM": return { name, cls: "D3" }; // 模板/参数面=配置告警
    default: return { name, cls: "D2" };            // INTERNAL 等保守归瞬时
  }
}

/** 观测面口径（EXP-3 §5.5）：信号类=auth_ack / pair_status_* 族 / error，其余 type 皆噪声。 */
export function isSignalType(type) {
  return type === "auth_ack" || (typeof type === "string" && type.startsWith("pair_status_")) || type === "error" || type === "rpc-frame" || type === "rpc-frame-ack";
}

/**
 * 建连+auth 握手。transportFactory(url, opts) 可注入（测试给内存对；生产默认 ws.mjs connectWs）。
 * 返回 RelaySession；失败 throw {code:"ws-*"}（调用方归 D2）。
 */
export async function connectRelay({
  url,                       // 完整 ws2 URL（含 ?token=&mid=；token 生命周期=单事务，禁入日志）
  deviceSid,
  meta = { platform: "orch-watch" },
  transportFactory = (u, o) => connectWs(u, o),
  handshakeTimeoutMs = 15000,
  authAckTimeoutMs = 15000,
  clientTsSec = Math.floor(Date.now() / 1000),
} = {}) {
  const session = new RelaySession();
  session.transport = await transportFactory(url, { timeoutMs: handshakeTimeoutMs, origin: null });
  session.wireTransport(session.transport); // 先接线再发 auth_init（ack 可在发送后任意时刻到达）
  session.openedAtMs = Date.now();
  const opened = session.beginAuthGate(authAckTimeoutMs);
  // 步骤 2：auth_init（client_ts 秒制，schema 上限 253402300799；W-W §3）
  session.send({ type: "auth_init", role: "terminal", device_sid: deviceSid, meta, client_ts: clientTsSec });
  const ack = await opened;
  if (!ack || ack.pair_status !== "matched") {
    try { session.close(1000, "auth-not-matched"); } catch { /* 已断 */ }
    throw Object.assign(new Error("auth-not-matched:" + ((ack && ack.pair_status) || "none")), { code: "auth-not-matched" });
  }
  return session;
}

/**
 * 中继会话：send(obj) / request(obj,{timeoutMs,zcodeType}) / on(fn) / close()；
 * metrics：{noiseData, parseErrors, bytesIn, framesIn}（非请求帧只计数不解析，EXP-3 F4）。
 */
export class RelaySession {
  transport = null;
  openedAtMs = NaN;
  closed = false;
  closeInfo = null;      // {code, reason, face, cls}
  kicked = false;        // 第一禁令标记：置位后上层绝不允许再连
  metrics = { noiseData: 0, parseErrors: 0, bytesIn: 0, framesIn: 0, errors: [] };
  #subs = new Set();
  #pendingAuth = null;
  #pendingReq = null;    // {reqId, zcodeType, resolve, reject, timer}
  #pendingAck = null;    // {seq, resolve, reject, timer}

  /** 订阅消息（bypass 噪声过滤的原始分发；bridge/inject 用）。返回退订函数。 */
  on(fn) { this.#subs.add(fn); return () => this.#subs.delete(fn); }

  /** auth 握手闸（connectRelay 用）：auth_ack 15s 内到达，否则 reject auth-ack-timeout。 */
  beginAuthGate(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pendingAuth = null; reject(Object.assign(new Error("auth-ack-timeout"), { code: "auth-ack-timeout" })); }, timeoutMs);
      this.#pendingAuth = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
    });
  }

  get urlSafeLabel() { return "ws2?token=REDACTED"; } // 日志面永远用这个，绝不拼真实 URL

  send(obj) {
    if (this.closed) throw Object.assign(new Error("relay-closed"), { code: "relay-closed" });
    this.transport.send(JSON.stringify(obj));
  }

  /** 带关联请求：默认等下一个匹配 type/zcode_type 的 data 帧或 error 帧。 */
  request(obj, { timeoutMs = 10000 } = {}) {
    const reqId = obj && obj.req_id != null ? obj.req_id : null;
    const L2R = { "workspace-list-request": "workspace-list-response", "workspace-bridge-open": "workspace-bridge-ready" };
    const wantType = obj && obj.type === "data" ? (L2R[obj.zcode_type] || obj.zcode_type + "-response") : obj && obj.type;
    const p = this.#awaitMatch(wantType, reqId, timeoutMs);
    this.send(obj);
    return p;
  }

  /** 先挂起后发送形态：等下一个匹配 zcode_type 的 data 帧（session/send 响应用，发前注册防丢帧）。 */
  awaitData(zcodeType, { timeoutMs = 10000, reqId = null } = {}) {
    return this.#awaitMatch(zcodeType, reqId, timeoutMs);
  }

  #awaitMatch(wantType, reqId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.#pendingReq && this.#pendingReq.wantType === wantType) this.#pendingReq = null; reject(Object.assign(new Error("relay-request-timeout:" + wantType), { code: "relay-request-timeout", wantType })); }, timeoutMs);
      this.#pendingReq = { reqId, wantType, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
    });
  }

  /** 等 rpc-frame-ack（inject 用）：seq 对上即达（三证①）。 */
  awaitAck(seq, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pendingAck = null; reject(Object.assign(new Error("rpc-ack-timeout"), { code: "rpc-ack-timeout" })); }, timeoutMs);
      this.#pendingAck = { seq, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
    });
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.#failPending("relay-closed-local");
    const face = mapClose(code);
    this.closeInfo = { code, reason, name: face.name, cls: face.cls };
    try { this.transport.close(code, reason); } catch { /* 已断 */ }
  }

  #failPending(why, extra = null) {
    const err = Object.assign(new Error(why), { code: why.startsWith("relay-closed") ? "relay-closed" : why, ...(extra || {}) });
    if (this.#pendingAuth) { const p = this.#pendingAuth; this.#pendingAuth = null; p.reject(err); }
    if (this.#pendingReq) { const p = this.#pendingReq; this.#pendingReq = null; p.reject(err); }
    if (this.#pendingAck) { const p = this.#pendingAck; this.#pendingAck = null; p.reject(err); }
  }

  #dispatch(msgText) {
    this.metrics.framesIn++;
    this.metrics.bytesIn += msgText.length;
    let msg;
    try { msg = JSON.parse(msgText); } catch { this.metrics.parseErrors++; return; }
    const type = msg && msg.type;
    if (type === "error") {
      const face = mapErrorFrame(msg);
      this.metrics.errors.push(face.name);
      if (face.name === "KICKED") {
        // 互踢第一禁令（W-W §8.2）：静默 close，绝不重连；上层见 kicked 只能放弃
        this.kicked = true;
        this.#failPending("kicked");
        this.closed = true;
        this.closeInfo = { code: 4009, reason: "KICKED", name: "KICKED", cls: "kicked" };
        try { this.transport.close(1000, ""); } catch {}
        return;
      }
      const err = Object.assign(new Error("relay-error:" + face.name), { code: "relay-error", face: face.name, cls: face.cls });
      if (this.#pendingReq) { const p = this.#pendingReq; this.#pendingReq = null; p.reject(err); }
      if (this.#pendingAck) { const p = this.#pendingAck; this.#pendingAck = null; p.reject(err); }
    }
    if (type === "auth_ack" && this.#pendingAuth) {
      const p = this.#pendingAuth; this.#pendingAuth = null;
      p.resolve(msg);
      return;
    }
    if (type === "data") {
      // 非请求推送=噪声（EXP-3 F4）：计入 metrics；有挂起 L2 请求且 zcode_type 匹配则分发
      const zt = msg && msg.zcode_type;
      const pend = this.#pendingReq;
      if (pend && pend.wantType === zt && (pend.reqId == null || msg.req_id == null || msg.req_id === pend.reqId)) {
        this.#pendingReq = null;
        pend.resolve(msg);
        return;
      }
      this.metrics.noiseData++;
      return;
    }
    if (type === "rpc-frame-ack" && this.#pendingAck) {
      const want = this.#pendingAck.seq;
      if (msg.ackMessageSeq === want || msg.seq === want) {
        const p = this.#pendingAck; this.#pendingAck = null;
        p.resolve(msg);
      }
      return;
    }
    if (!isSignalType(type)) this.metrics.noiseData++;
    for (const fn of this.#subs) { try { fn(msg); } catch { /* 订阅者异常不阻断 */ } }
  }

  /** 由 transportFactory 的宿主接线（生产=ws.mjs；测试=内存对）。 */
  wireTransport(transport) {
    this.transport = transport;
    transport.onmessage = (data) => this.#dispatch(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    transport.onclose = (info) => {
      if (this.closed) return;
      this.closed = true;
      const code = info && info.code;
      const face = mapClose(code);
      this.closeInfo = { code, reason: (info && info.reason) || "", name: face.name, cls: face.cls };
      if (code === 4009) this.kicked = true; // Conflict 关断同踢族
      this.#failPending("relay-closed:" + (face.name || code), { closeCode: code, closeCls: face.cls });
    };
    transport.onerror = (err) => { this.metrics.errors.push("transport:" + ((err && err.code) || "error")); };
  }
}

/** ws2 URL 组装（token 只进 query/TLS，禁入任何日志——调用方持 url 的生存期=单事务）。 */
export function buildWs2Url({ origin, token, mid }) {
  const o = String(origin || "https://zcode.z.ai").replace(/\/+$/, "");
  return `${o}/api/v1/remote/ws2?token=${encodeURIComponent(token)}&mid=${encodeURIComponent(mid)}`;
}
