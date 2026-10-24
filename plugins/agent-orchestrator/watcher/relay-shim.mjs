/*!
 * watcher/relay-shim.mjs —— 本地 relay shim（v0.10-DESIGN §2，S1 组件；direct 模式路线 A）
 *
 * 定位（G1 直连 wake 的回环替代面）：单 Node 进程 HTTP+WS 同端口零依赖；把桌面两个 env
 * （relay WS URL / endpoint origin）指回 127.0.0.1 后桌面零代码接入；watcher 侧
 * credentials.mjs 三函数（fetchDevices/issueTerminalToken/httpCall）同形状零改动复用（W2
 * 接线），relay.mjs connectRelay/buildWs2Url 逐字节不变（ws2 URL 对拍面=WS2_PATH）。
 *
 * 形状权威（DESIGN §2.2，contract.ts:96-149 对拍 fixture 内联进 tests/suites/watcher-shim.mjs，
 * 禁依赖 %TEMP%）：
 *   - POST /api/v1/remote/device {device_mid} → {code:0,msg:"",data:{device_sid,device_mid,
 *     online:true,created_at:<unixSec>,meta:{}}}（sid 按 id schema ^[A-Za-z0-9._~-]+$ ≤256 自造，
 *     复注册同 mid 同 sid；持久化 mid→sid 于 <root>/sentinel/relay-shim-state.json 原子写，
 *     桌面缓存 device_sid 跨 shim 重启稳定）。
 *   - GET /api/v1/remote/device（第四端点=watcher fetchDevices 消费面）→
 *     {code:0,msg:"",data:[{device_sid,device_mid,online,meta}...]}——online=该 mid 的 device
 *     ws 连接在位（活体事实源）；空注册表=空数组。
 *   - POST /api/v1/remote/token {role:"device"|"terminal"} → {code:0,msg:"",data:{token:<16B
 *     base64url 22 字符、末字符∈[AQgw]>,expires_in:3600}}；Authorization 头整体忽略（含
 *     Bearer null 容忍——loopback 无 JWT）；role 写进 token→连接类映射表。
 *   - POST /api/v1/remote/device/delete → {code:0,msg:""}（data 省略；幂等）。
 *   - WS /api/v1/remote/ws2?token=&mid=（§2.3，query 语义对齐 relay.mjs:251-254）：token→role
 *     定连接角色；device 角色连接在位=「桌面在线」事实源（GET /device online 由此驱动）；
 *     token 无效/缺参→error 帧 AUTH_FAILED+关断 4013。
 *
 * 配对状态机 v0 最小集（§2.4，Q2 已裁 fake-relay-v2 语义）：
 *   - terminal auth_init{device_sid} → device 在线：回 auth_ack{pair_status:"matched"}（回显
 *     device_sid）；device 离线：关断 4010（DesktopDisconnected，relay.mjs CLOSE_FACES 语义）。
 *   - 二连 terminal：先到者 error 帧 KICKED+关断 4009（互踢第一禁令 shim 侧，relay.mjs
 *     kicked 面同族）；device 角色有效 auth_init{device_sid} → auth_ack matched+回显
 *     （真桌面首帧即 auth_init，活体兼容面，v0.10 G SHIM-02g 裁决）；畸形 auth_init
 *     （缺/空 device_sid）→ error 帧 WRONG_PARAM+关断（参数面对称）。
 *   - 数据面=逐字管道（§2.5）：配对后 TEXT/BINARY 帧双向透传，shim 不解析不改写 payload；
 *     未配对/对岸已灭的帧丢弃不缓冲（§2.7 无重放缓冲）；零心跳（仅 RFC 层 PING→PONG）。
 *
 * 回环硬闸（§2.1）：仅绑定 127.0.0.1；任何非回环 host（含 0.0.0.0/localhost/::1）启动即拒、
 * 退出码 1（SHIM-03）；绑定失败=报错退出，不静默换端口；--port CLI 参（缺省 SHIM_DEFAULT_PORT，
 * OPEN-10.3 W1 落值 47010；cfg loopbackPort 覆写=W2 侧经 --port 传参，shim 只读 CLI 不读
 * watcher.cfg.json）；--root 指状态根。
 *
 * v0 决策（非静默，登记 tests/assertions/v0.10.x.md，供主控/EXP-10 复核）：
 *   - POST /device 响应 online 恒 true（contract 注册确认形状）；活体在线事实源=GET /device。
 *   - token「一次性门票语义」实现为「生存期=shim 进程、连接可复用」（无 TTL §2.7；桌面
 *     relay-unavailable 重连面 Q5 不因单次消费而破坏；歧义已记非单次消费裁定）。
 *   - 鉴权失败关断码 4013（InvalidMobileConnection 凭证面，relay.mjs CLOSE_FACES 同族）；
 *     WRONG_PARAM 对称面关断码 1000；同 mid 二连 device=新连接顶替（旧连接 1000）；
 *     device 离线→已配对 terminal 关断 4010。fake-relay-v2 查无实锤面，差异留 EXP-10 findings §6。
 *
 * 纪律：token 只进 query，shim 不打任何含 token/URL query 的日志（泄漏面=不存在，单事务
 * 生存期口径同 relay.mjs:250 注）；WS 帧层复用 ws.mjs codec（acceptKey/encodeFrame mask:false/
 * FrameParser——DESIGN §0.5 服务面免重写裁决）；零 npm 依赖；node >= 20。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acceptKey, encodeFrame, FrameParser, OP } from "./ws.mjs";

export const LOOPBACK_HOST = "127.0.0.1";
/** OPEN-10.3 W1 落值：127.0.0.1 高位固定端口；cfg 覆写经 W2 托管拉起 --port 传递。 */
export const SHIM_DEFAULT_PORT = 47010;
/** 与 relay.mjs buildWs2Url（:251-254）同路对拍。 */
export const WS2_PATH = "/api/v1/remote/ws2";

const DEVICE_PATH = "/api/v1/remote/device";
const TOKEN_PATH = "/api/v1/remote/token";
const DEVICE_DELETE_PATH = "/api/v1/remote/device/delete";
const ROLES = ["device", "terminal"];
const TOKEN_BYTES = 16;
const TOKEN_EXPIRES_IN = 3600; // contract 形状值（§2.7 无 TTL：实际不做到期校验）
const ID_RE = /^[A-Za-z0-9._~-]+$/;
const BODY_CAP = 64 * 1024;

function nowSec() { return Math.floor(Date.now() / 1000); }
function newDeviceSid() { return "dev-" + crypto.randomBytes(12).toString("base64url"); } // 20 字符，ID_RE 恒满足
function closePayload(code, reason) {
  const r = Buffer.from(String(reason || ""), "utf8");
  const b = Buffer.alloc(2 + r.length);
  b.writeUInt16BE(code & 0xffff, 0);
  if (r.length) r.copy(b, 2);
  return b;
}
function statePathFor(root) { return path.join(root, "sentinel", "relay-shim-state.json"); }
function loadState(root) {
  try {
    const st = JSON.parse(fs.readFileSync(statePathFor(root), "utf8"));
    if (st && Array.isArray(st.devices)) return st;
  } catch { /* 首启/损坏容忍：按空表起 */ }
  return { version: 1, devices: [] };
}
function saveState(root, st) {
  const p = statePathFor(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(st) + "\n");
  fs.renameSync(tmp, p); // 原子写（rename 覆盖语义）
}
function rawHttpReject(socket, status, msg) {
  try {
    socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.end();
  } catch { /* socket 已灭 */ }
  const t = setTimeout(() => { try { socket.destroy(); } catch {} }, 200);
  if (t.unref) t.unref();
}

/** 单条 ws 连接面：feed 解帧→控制面/鉴权闸/配对/逐字透传；kill/finalize 幂等收口。 */
class ShimConn {
  constructor(shim, socket, { token, mid }) {
    this.shim = shim;
    this.socket = socket;
    this.token = token;
    this.mid = mid;
    this.role = null;       // "device" | "terminal"（token 表映射后置位）
    this.authed = false;    // terminal：auth_ack 已发
    this.closed = false;
    this.parser = new FrameParser();
    this.device = null;     // terminal 侧：已配对 device conn
    this.terminal = null;   // device 侧：已配对 terminal conn
  }

  feed(chunk) {
    let frames;
    try { frames = this.parser.push(chunk); } catch { this.kill(1002, "protocol-error"); return; }
    for (const f of frames) {
      if (this.closed) return;
      if (f.tooLarge) { this.kill(1009, "frame-too-large"); return; }
      if (f.opcode === OP.PING) { this.raw(encodeFrame({ opcode: OP.PONG, mask: false, payload: f.payload })); continue; }
      if (f.opcode === OP.PONG) continue;
      if (f.opcode === OP.CLOSE) {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        this.kill(code, "peer-close"); // RFC 回显 CLOSE 后收口
        continue;
      }
      if (f.opcode === OP.TEXT) { this.onText(f.payload); continue; }
      if (f.opcode === OP.BINARY) { this.forward(f.payload, OP.BINARY); continue; }
      this.kill(1002, "bad-opcode");
    }
  }

  raw(buf) { try { this.socket.write(buf); } catch { this.finalize(); } }
  sendJson(obj) { this.raw(encodeFrame({ opcode: OP.TEXT, mask: false, payload: Buffer.from(JSON.stringify(obj), "utf8") })); }
  sendError(code) { this.sendJson({ type: "error", code }); }

  kill(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.end(encodeFrame({ opcode: OP.CLOSE, mask: false, payload: closePayload(code, reason) })); } catch { /* 已断 */ }
    this.finalize();
  }

  /** 幂等收口：摘表+对岸 4010 通知（device 离线→已配对 terminal 关断 4010）。 */
  finalize() {
    this.closed = true;
    this.shim.conns.delete(this);
    if (this.role === "device" && this.mid && this.shim.liveDevices.get(this.mid) === this) this.shim.liveDevices.delete(this.mid);
    if (this.terminal) {
      const t = this.terminal; this.terminal = null; t.device = null;
      if (!t.closed) t.kill(4010, "DesktopDisconnected");
    }
    if (this.device) { const d = this.device; this.device = null; d.terminal = null; }
    try { this.socket.destroy(); } catch { /* 已灭 */ }
  }

  #parseMsg(text) {
    try { const m = JSON.parse(text); return m && typeof m === "object" ? m : null; } catch { return null; }
  }

  onText(text) {
    // pending 角色·判定（Q2 回环信任增补）：优先采信 token 注册角色（/token 签发时已定 device|terminal）；
    // 无注册角色兜底=首帧判定（auth_init 首帧=terminal；其余首帧=device，登记+liveDevices 上线）
    if (this.role === null) {
      const t0 = this.shim.tokens.get(this.token);
      const reg = t0 && ROLES.includes(t0.role) && t0.role !== "pending" ? t0.role : null;
      if (reg) {
        this.role = reg;
      } else {
        const m0 = this.#parseMsg(text);
        this.role = (m0 && m0.type === "auth_init") ? "terminal" : "device";
        if (this.role === "device") {
          if (!this.shim.devices.has(this.mid)) {
            this.shim.devices.set(this.mid, { device_mid: this.mid, device_sid: newDeviceSid(), created_at: nowSec(), meta: {} });
          }
          const old = this.shim.liveDevices.get(this.mid);
          if (old && !old.closed) old.kill(1000, "replaced");
          this.shim.liveDevices.set(this.mid, this);
        }
      }
    }
    // terminal 鉴权闸（§2.4）：auth_init→配对判定；闸内非 auth_init=参数面
    if (this.role === "terminal" && !this.authed) {
      const msg = this.#parseMsg(text);
      if (!msg || msg.type !== "auth_init") { this.sendError("WRONG_PARAM"); this.kill(1000, "WRONG_PARAM"); return; }
      const sid = typeof msg.device_sid === "string" ? msg.device_sid : "";
      const dev = this.shim.findDeviceConn(sid);
      if (!dev) { this.kill(4010, "DesktopDisconnected"); return; } // device 离线（§2.4）
      if (dev.terminal && !dev.terminal.closed) {
        const old = dev.terminal;
        old.sendError("KICKED");
        old.kill(4009, "Conflict"); // 二连 terminal：先到者 KICKED+4009（互踢第一禁令 shim 侧）
      }
      dev.terminal = this;
      this.device = dev;
      this.authed = true;
      this.sendJson({ type: "auth_ack", pair_status: "matched", device_sid: sid }); // 回显 device_sid
      return;
    }
    // device 对称面（EXP-10 活体修正）：真桌面 device 角色首帧即 auth_init{device_sid}，期望
    // auth_ack{pair_status,device_sid} 且 device_sid 须与自身一致（webRemoteControlTransport.ts:200-204
    // device_sid 不符即忽略）→ 回显 sid+matched；并登记 liveDevices（/device online 事实源）。
    // 畸形 auth_init（缺/空 device_sid）=参数面：WRONG_PARAM+关断（与 terminal 鉴权闸前
    // 畸形帧同面；v0.10 G SHIM-02g 裁决——有效帧放行是活体兼容面，畸形帧才拒）。
    if (this.role === "device" && !this.terminal) {
      const msg = this.#parseMsg(text);
      if (msg && msg.type === "auth_init") {
        const sid = typeof msg.device_sid === "string" ? msg.device_sid.trim() : "";
        if (!sid) { this.sendError("WRONG_PARAM"); this.kill(1000, "WRONG_PARAM"); return; }
        this.sendJson({ type: "auth_ack", pair_status: "matched", device_sid: sid });
        if (!this.shim.devices.has(this.mid)) {
          this.shim.devices.set(this.mid, { device_mid: this.mid, device_sid: sid || newDeviceSid(), created_at: nowSec(), meta: (msg && msg.meta) || {} });
        }
        this.shim.liveDevices.set(this.mid, this);
        return; // 握手确认；其后帧经 forward 管道（terminal 缺位时丢弃不缓冲 §2.7）
      }
    }
    // 数据面逐字管道：TEXT 以 utf8 字节原样转发（帧层解码→再编码无损）
    this.forward(Buffer.isBuffer(text) ? text : Buffer.from(String(text), "utf8"), OP.TEXT);
  }

  /** 透传：配对对岸在位才转发；未配对/已灭=丢弃不缓冲（§2.7）。opcode 与原帧一致。 */
  forward(payload, opcode) {
    const peer = this.role === "terminal" ? this.device : this.terminal;
    if (!peer || peer.closed) return false;
    peer.raw(encodeFrame({ opcode, mask: false, payload }));
    return true;
  }
}

/**
 * 拉起 shim（模块面；测试在进程内驱动，CLI 面见 runCli）。
 * 返回 { host, port, close() }；非回环 host / 非法端口 / 绑定失败一律 throw（不静默降级）。
 */
export async function startShim({ host = LOOPBACK_HOST, port = SHIM_DEFAULT_PORT, root = process.cwd() } = {}) {
  if (host !== LOOPBACK_HOST) { // 回环硬闸：仅 127.0.0.1（0.0.0.0 永久禁，DESIGN §2.1/L3 §4.4）
    throw Object.assign(
      new Error(`relay-shim: loopback-only hard gate — refusing bind host=${host} (only ${LOOPBACK_HOST} allowed)`),
      { code: "shim-loopback-gate" },
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw Object.assign(new Error(`relay-shim: invalid port ${port}`), { code: "shim-port-invalid" });
  }
  const shim = {
    root,
    conns: new Set(),
    tokens: new Map(),      // token → {role, issued_at}（内存态，生存期=shim 进程，无 TTL）
    liveDevices: new Map(), // mid → device conn（「桌面在线」事实源）
    devices: new Map(),     // mid → {device_mid, device_sid, created_at, meta}（持久化注册表）
    findDeviceConn(sid) {
      for (const [mid, conn] of this.liveDevices) {
        if (conn.closed) continue;
        const e = this.devices.get(mid);
        if (e && e.device_sid === sid) return conn;
      }
      return null;
    },
  };
  const persisted = loadState(root);
  for (const d of persisted.devices || []) {
    if (d && typeof d.device_mid === "string" && typeof d.device_sid === "string") {
      shim.devices.set(d.device_mid, {
        device_mid: d.device_mid,
        device_sid: d.device_sid,
        created_at: Number(d.created_at) || nowSec(),
        meta: d.meta && typeof d.meta === "object" ? d.meta : {},
      });
    }
  }
  const persist = () => saveState(root, { version: 1, updated_at: new Date().toISOString(), devices: [...shim.devices.values()] });

  const json = (res, status, body) => {
    const buf = Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": buf.length });
    res.end(buf);
  };
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    let size = 0, err = null;
    req.on("data", (c) => { size += c.length; if (size > BODY_CAP) { err = "payload-too-large"; try { req.destroy(); } catch {} return; } chunks.push(c); });
    req.on("end", () => resolve(err ? { err } : { buf: Buffer.concat(chunks) }));
    req.on("error", () => resolve({ err: "body-error" }));
  });
  const registerDevice = (body) => {
    const mid = body && body.device_mid;
    if (typeof mid !== "string" || !mid || mid.length > 256) return { status: 400, body: { code: 1, msg: "invalid-device-mid" } };
    let e = shim.devices.get(mid);
    if (!e) {
      e = { device_mid: mid, device_sid: newDeviceSid(), created_at: nowSec(), meta: {} };
      shim.devices.set(mid, e);
      persist();
    }
    // 复注册=同 sid（桌面缓存 device_sid 稳定语义）；online 恒 true=contract 注册确认形状（v0 决策）
    return { status: 200, body: { code: 0, msg: "", data: { device_sid: e.device_sid, device_mid: e.device_mid, online: true, created_at: e.created_at, meta: e.meta } } };
  };
  const listDevices = () => ({
    status: 200,
    body: {
      code: 0, msg: "",
      data: [...shim.devices.values()]
        .sort((a, b) => a.created_at - b.created_at || (a.device_mid < b.device_mid ? -1 : 1))
        .map((e) => ({ device_sid: e.device_sid, device_mid: e.device_mid, online: shim.liveDevices.has(e.device_mid), meta: e.meta })),
    },
  });
  const issueToken = (body) => {
    const role = body && body.role;
    if (!ROLES.includes(role)) return { status: 400, body: { code: 1, msg: "invalid-role" } };
    const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url"); // 22 字符，末字符∈[AQgw]（16B base64url 形状自然满足）
    shim.tokens.set(token, { role, issued_at: nowSec() });
    return { status: 200, body: { code: 0, msg: "", data: { token, expires_in: TOKEN_EXPIRES_IN } } };
  };
  const deleteDevice = (body) => {
    let mid = body && typeof body.device_mid === "string" ? body.device_mid : null;
    if (!mid && body && typeof body.device_sid === "string") {
      for (const e of shim.devices.values()) if (e.device_sid === body.device_sid) { mid = e.device_mid; break; }
    }
    if (!mid) return { status: 400, body: { code: 1, msg: "invalid-params" } };
    if (shim.devices.has(mid)) { shim.devices.delete(mid); persist(); }
    const dev = shim.liveDevices.get(mid);
    if (dev && !dev.closed) dev.kill(1000, "deleted"); // 已配对 terminal 由 finalize 链关 4010
    return { status: 200, body: { code: 0, msg: "" } }; // 幂等：查无亦 0
  };

  const handleHttp = async (req, res) => {
    let u;
    try { u = new URL(req.url || "/", "http://" + LOOPBACK_HOST); } catch { json(res, 400, { code: 1, msg: "bad-url" }); return; }
    const p = u.pathname;
    const method = String(req.method || "GET").toUpperCase();
    try {
      if (p === DEVICE_PATH || p === TOKEN_PATH || p === DEVICE_DELETE_PATH) {
        if (p === DEVICE_PATH && method === "GET") { const r = listDevices(); json(res, r.status, r.body); return; }
        if (method !== "POST") { json(res, 405, { code: 1, msg: "method-not-allowed" }); return; }
        const rb = await readBody(req);
        if (rb.err === "payload-too-large") { json(res, 413, { code: 1, msg: "payload-too-large" }); return; }
        if (rb.err || !rb.buf.length) { json(res, 400, { code: 1, msg: "bad-body" }); return; }
        let body;
        try { body = JSON.parse(rb.buf.toString("utf8")); } catch { json(res, 400, { code: 1, msg: "bad-json" }); return; }
        if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { code: 1, msg: "bad-json" }); return; }
        // Authorization 头整体忽略（含 Bearer null 容忍——loopback 无 JWT，§2.2）；不打日志
        if (p === DEVICE_PATH) { const r = registerDevice(body); json(res, r.status, r.body); return; }
        if (p === TOKEN_PATH) { const r = issueToken(body); json(res, r.status, r.body); return; }
        const r = deleteDevice(body);
        json(res, r.status, r.body);
        return;
      }
      json(res, 404, { code: 1, msg: "not-found" });
    } catch {
      try { json(res, 500, { code: 1, msg: "internal" }); } catch { /* socket 已灭 */ }
    }
  };

  const onUpgrade = (req, socket, head) => {
    let u;
    try { u = new URL(req.url || "/", "http://" + LOOPBACK_HOST); } catch { socket.destroy(); return; }
    if (u.pathname !== WS2_PATH) { rawHttpReject(socket, 404, "not-found"); return; }
    const key = req.headers["sec-websocket-key"];
    if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") { rawHttpReject(socket, 400, "bad-handshake"); return; }
    try {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n");
    } catch { return; }
    const conn = new ShimConn(shim, socket, { token: u.searchParams.get("token") || "", mid: u.searchParams.get("mid") || "" });
    shim.conns.add(conn);
    socket.on("data", (c) => conn.feed(c));
    socket.on("error", () => conn.finalize());
    socket.on("close", () => conn.finalize());
    if (head && head.length) conn.feed(head); // upgrade 提前到达的帧
    // 鉴权闸（§2.3 + Q2 回环信任增补）：表内 token→映射角色；未表 token→自动注册 pending
    // （角色由首帧判定；回环信任边界=仅绑 127.0.0.1；缺 mid 仍拒——无会话绑定面）
    let t = shim.tokens.get(conn.token);
    if (!t || !ROLES.includes(t.role)) { t = { role: "pending", issued_at: nowSec() }; shim.tokens.set(conn.token, t); }
    if (!conn.mid) {
      conn.sendError("AUTH_FAILED");
      conn.kill(4013, "AUTH_FAILED");
      return;
    }
    conn.role = ROLES.includes(t.role) ? t.role : null; // pending=首帧判定（onText pending 分支）
    if (conn.role === "device") {
      const old = shim.liveDevices.get(conn.mid);
      if (old && !old.closed) old.kill(1000, "replaced"); // 同 mid 二连 device=顶替（v0 决策）
      shim.liveDevices.set(conn.mid, conn); // device 连接在位=「桌面在线」事实源
    }
    // terminal：角色就位，鉴权闸在 onText（等 auth_init）
  };

  const server = http.createServer((req, res) => { void handleHttp(req, res); });
  server.on("upgrade", onUpgrade);
  await new Promise((resolve, reject) => {
    server.once("error", reject); // 绑定失败=启动报错（不静默换端口，§2.1）
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const addr = server.address();
  if (!addr || addr.address !== LOOPBACK_HOST) { // 双保险：实际绑定地址必须回环
    try { server.close(); } catch { /* 已灭 */ }
    throw Object.assign(new Error(`relay-shim: post-bind loopback verify failed (address=${addr && addr.address})`), { code: "shim-loopback-gate" });
  }
  let shut = false;
  return {
    host: addr.address,
    port: addr.port,
    close: async () => {
      if (shut) return;
      shut = true;
      for (const c of [...shim.conns]) { try { c.socket.destroy(); } catch { /* 已灭 */ } }
      await new Promise((r) => server.close(() => r()));
    },
  };
}

/** CLI 参数解析（--host/--port/--root；缺省=回环/OPEN-10.3 落值/cwd）。 */
export function parseShimArgs(argv = []) {
  const o = { host: LOOPBACK_HOST, port: SHIM_DEFAULT_PORT, root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") o.host = String(argv[++i] ?? "");
    else if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--root") o.root = String(argv[++i] ?? "");
  }
  return o;
}

/** CLI 面（watcher W2 托管拉起同款）：非回环 host/绑定失败 → stderr+退出码 1（SHIM-03）。 */
export async function runCli(argv = process.argv.slice(2)) {
  const cfg = parseShimArgs(argv);
  let shim;
  try {
    shim = await startShim(cfg);
  } catch (err) {
    process.stderr.write("[relay-shim] fatal: " + ((err && err.message) || String(err)) + "\n");
    process.exit(1);
  }
  // 日志纪律：本行不含 token/URL query（relay.mjs:250 单事务生存期口径）
  process.stdout.write(`relay-shim listening on ${shim.host}:${shim.port} root=${cfg.root}\n`);
  const bye = () => { process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  return { ok: true, port: shim.port };
}

// ---- 直跑入口：node watcher/relay-shim.mjs [--host 127.0.0.1] [--port 47010] [--root <dir>] ----
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
