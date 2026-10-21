/*!
 * watcher/ws.mjs —— 零依赖 RFC6455 WebSocket 客户端（RELAY V2 的传输面）
 *
 * 定位（W-W §3 步骤 1 / EXP-3 §5）：watcher 对 ws2 中继的建连。node 无内建 ws 客户端 API
 * （globalThis.WebSocket 仅 node≥22 且不授自定义 Origin 头），禁 npm 包 → 最小 RFC6455 自研：
 *   - 纯函数 codec（encodeFrame/FrameParser/acceptKey/buildUpgradeRequest/parseUpgradeResponse）
 *     → tests/suites/watcher-core.mjs 全量单测；connectWs 的 socket 面留活体集成阶段复核。
 *   - 零心跳纪律（EXP-3 F2/§5.3）：本文件不写任何应用层 keepalive 循环；仅 RFC 协议层
 *     自动应答服务端 PING→PONG（与 undici 协议层自动应答同语义）。
 *   - 互踢第一禁令在 relay.mjs 层执行，本文件只管帧。
 *
 * 协议要点：客户端帧必须掩码（RFC6455 §5.3）；服务端帧不掩码；支持 7/16/64 位长度；
 * 分片（FIN=0 + CONT）在 FrameParser 内重装；CLOSE 帧回显后关 socket。
 * 零 npm 依赖；node >= 20。
 */
import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** Sec-WebSocket-Accept 期望值：base64(sha1(key + GUID))。 */
export function acceptKey(clientKey) {
  return crypto.createHash("sha1").update(clientKey + WS_GUID).digest("base64");
}

/** 构造 HTTP/1.1 Upgrade 请求头文本（socket 层测试只验形状，不触网）。 */
export function buildUpgradeRequest({ host, port, path: wsPath, key, origin, headers = {} }) {
  const lines = [
    `GET ${wsPath || "/"} HTTP/1.1`,
    `Host: ${host}${port && port !== 80 && port !== 443 ? ":" + port : ""}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
  ];
  if (origin) lines.push(`Origin: ${origin}`);
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  return lines.join("\r\n") + "\r\n\r\n";
}

/** 解析 101 响应：ok=状态行 101 且 Accept 匹配；rest=帧流起始字节（可能已在同 chunk）。 */
export function parseUpgradeResponse(buf, expectKey) {
  const text = buf.toString("latin1");
  const idx = text.indexOf("\r\n\r\n");
  if (idx < 0) return { ok: false, incomplete: true };
  const head = text.slice(0, idx);
  const line1 = head.split("\r\n")[0] || "";
  const m = /^HTTP\/1\.1 (\d{3})(?: (.*))?$/.exec(line1);
  if (!m) return { ok: false, error: "bad-status-line" };
  const status = Number(m[1]);
  if (status !== 101) return { ok: false, status, error: "handshake-rejected" };
  const headers = {};
  for (const l of head.split("\r\n").slice(1)) {
    const c = l.indexOf(":");
    if (c > 0) headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim();
  }
  if (expectKey != null && headers["sec-websocket-accept"] !== acceptKey(expectKey)) {
    return { ok: false, status, error: "accept-mismatch" };
  }
  return { ok: true, status, headers, rest: buf.subarray(idx + 4) };
}

/** 编码一帧。client=true 必须掩码（RFC6455）；maskKey 可注入（测试确定性）。 */
export function encodeFrame({ opcode, payload = Buffer.alloc(0), mask = true, maskKey }) {
  const len = payload.length;
  const mk = mask ? (maskKey && maskKey.length === 4 ? maskKey : crypto.randomBytes(4)) : null;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = mask ? 0x80 | len : len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = mask ? 0x80 | 126 : 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = mask ? 0x80 | 127 : 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f); // 施工面一律 FIN=1 单帧（分片重装只服务入向）
  if (!mk) return Buffer.concat([header, payload]);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mk[i & 3];
  return Buffer.concat([header, mk, masked]);
}

/** 增量帧解析器：push(chunk) → 完整帧数组（TEXT 帧已 utf8 解码为 string；其余给 Buffer）。 */
export class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.fragments = null; // { opcode, chunks: Buffer[] }
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const f = this.#tryFrame();
      if (!f) break;
      if (f.opcode === OP.PING || f.opcode === OP.PONG || f.opcode === OP.CLOSE || f.opcode >= 0x8) {
        if (this.fragments) this.fragments = null; // 控制帧截断乱入：按 RFC 丢弃未完分片（保守）
        out.push(f);
        continue;
      }
      if (f.fin) {
        if (this.fragments) {
          this.fragments.chunks.push(f.payload);
          const opcode = this.fragments.opcode;
          const payload = Buffer.concat(this.fragments.chunks);
          this.fragments = null;
          out.push({ opcode, fin: true, payload: this.#decoded(opcode, payload) });
        } else {
          out.push({ opcode: f.opcode, fin: true, payload: this.#decoded(f.opcode, f.payload) });
        }
      } else {
        if (!this.fragments) this.fragments = { opcode: f.opcode, chunks: [] };
        this.fragments.chunks.push(f.payload);
      }
    }
    return out;
  }
  #decoded(opcode, payload) {
    return opcode === OP.TEXT ? payload.toString("utf8") : payload;
  }
  #tryFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(0x1000000)) return { opcode: OP.CLOSE, fin: true, payload: Buffer.from("frame-too-large"), tooLarge: true };
      len = Number(big);
      off = 10;
    }
    const maskKey = masked ? b.subarray(off, off + 4) : null;
    if (masked) off += 4;
    if (b.length < off + len) return null;
    const raw = Buffer.from(b.subarray(off, off + len));
    if (maskKey) for (let i = 0; i < raw.length; i++) raw[i] ^= maskKey[i & 3];
    this.buf = b.subarray(off + len);
    return { opcode, fin, payload: raw, masked };
  }
}

/**
 * 最小 ws 客户端。socketFactory 可注入（生产默认按 scheme 走 tls/net；测试可给 Duplex 对，
 * 零 socket 零触网）。返回 WsConn：send/close + on{open,message,close,error}。
 */
export async function connectWs(urlStr, { origin, headers = {}, timeoutMs = 15000, socketFactory } = {}) {
  const u = new URL(urlStr);
  if (u.protocol !== "ws:" && u.protocol !== "wss:") throw Object.assign(new Error("bad-scheme"), { code: "ws-bad-scheme" });
  const secure = u.protocol === "wss:";
  const host = u.hostname;
  const port = u.port ? Number(u.port) : secure ? 443 : 80;
  const key = crypto.randomBytes(16).toString("base64");
  const reqText = buildUpgradeRequest({ host, port, path: u.pathname + u.search, key, origin, headers });

  const socket = socketFactory
    ? socketFactory({ host, port, secure })
    : secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });

  const conn = new WsConn(socket);
  return await new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    let sent = false;
    const timer = setTimeout(() => {
      cleanup();
      try { socket.destroy(); } catch {}
      reject(Object.assign(new Error("ws-handshake-timeout"), { code: "ws-handshake-timeout" }));
    }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); socket.off("data", onHandshakeData); socket.off("error", onErr); socket.off("close", onCloseEarly); };
    const writeReq = () => { if (!sent) { sent = true; try { socket.write(reqText); } catch {} } };
    const onHandshakeData = (chunk) => {
      writeReq();
      acc = Buffer.concat([acc, chunk]);
      const r = parseUpgradeResponse(acc, key);
      if (r.incomplete) return;
      cleanup();
      if (!r.ok) {
        try { socket.destroy(); } catch {}
        reject(Object.assign(new Error(r.error || "handshake-failed"), { code: "ws-" + (r.error || "handshake-failed"), status: r.status }));
        return;
      }
      conn.attach(r.rest);
      resolve(conn);
    };
    const onErr = (err) => { cleanup(); reject(Object.assign(err, { code: "ws-socket-error" })); };
    const onCloseEarly = () => { cleanup(); reject(Object.assign(new Error("ws-closed-during-handshake"), { code: "ws-closed-during-handshake" })); };
    socket.on("data", onHandshakeData);
    socket.on("error", onErr);
    socket.on("close", onCloseEarly);
    socket.once(secure ? "secureConnect" : "connect", writeReq);
  });
}

/** 连接面：send(text)/close(code,reason)/事件回调。自动 PING→PONG（协议层唯一自动化）。 */
export class WsConn {
  #socket;
  #parser = new FrameParser();
  #closed = false;
  onopen = null; onmessage = null; onclose = null; onerror = null;
  constructor(socket) { this.#socket = socket; }
  /** 包内私有（connectWs 握手完成后接线）；勿在模块外使用。 */
  attach(rest) {
    const socket = this.#socket;
    if (rest && rest.length) this.#feed(rest);
    socket.on("data", (c) => this.#feed(c));
    socket.on("error", (err) => { if (!this.#closed) { this.#closed = true; this.onerror && this.onerror(err); this.onclose && this.onclose({ code: 1006, reason: "socket-error" }); } });
    socket.on("close", () => { if (!this.#closed) { this.#closed = true; this.onclose && this.onclose({ code: 1006, reason: "socket-closed" }); } });
    this.onopen && this.onopen();
  }
  #feed(chunk) {
    let frames;
    try { frames = this.#parser.push(chunk); } catch (err) { this.onerror && this.onerror(err); return; }
    for (const f of frames) {
      if (f.tooLarge) { this.close(1009, "frame-too-large"); continue; }
      if (f.opcode === OP.TEXT || f.opcode === OP.BINARY) this.onmessage && this.onmessage(f.payload, f.opcode);
      else if (f.opcode === OP.PING) { try { this.#socket.write(encodeFrame({ opcode: OP.PONG, payload: f.payload })); } catch {} }
      else if (f.opcode === OP.CLOSE) {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        const reason = f.payload.length > 2 ? f.payload.subarray(2).toString("utf8") : "";
        if (!this.#closed) { this.#closed = true; try { this.#socket.end(encodeFrame({ opcode: OP.CLOSE, payload: closePayload(code, reason) })); } catch {} this.onclose && this.onclose({ code, reason }); }
      }
    }
  }
  send(text) {
    if (this.#closed) throw Object.assign(new Error("ws-already-closed"), { code: "ws-closed" });
    this.#socket.write(encodeFrame({ opcode: OP.TEXT, payload: Buffer.from(String(text), "utf8") }));
  }
  close(code = 1000, reason = "") {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#socket.end(encodeFrame({ opcode: OP.CLOSE, payload: closePayload(code, reason) })); } catch {}
    try { setTimeout(() => { try { this.#socket.destroy(); } catch {} }, 1000).unref?.(); } catch {}
    this.onclose && this.onclose({ code, reason });
  }
  get closed() { return this.#closed; }
}
function closePayload(code, reason) {
  const r = Buffer.from(String(reason || ""), "utf8");
  const b = Buffer.alloc(2 + r.length);
  b.writeUInt16BE(code & 0xffff, 0);
  r.copy(b, 2);
  return b;
}
