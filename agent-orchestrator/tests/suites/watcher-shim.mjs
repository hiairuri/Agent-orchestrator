// @module watcher-shim
/*!
 * suites/watcher-shim.mjs —— v0.10 W1 relay shim 套（SHIM-01..04；设计=designs/agent-orchestrator-v0.10-DESIGN.md §2/§9.2）
 *
 * 覆盖断言组（登记表=tests/assertions/v0.10.x.md，前缀 A-v0100-）：
 *   SHIM-01  HTTP 四端点形状对拍（POST/GET /device、/token 16B base64url 末字符∈[AQgw]、
 *            /device/delete；contract 形状以常量内联进本套，禁依赖 %TEMP%；mid→sid 持久化
 *            跨 shim 重启稳定=<root>/sentinel/relay-shim-state.json）
 *   SHIM-02  ws2 鉴权/配对面：无效 token/缺 mid→AUTH_FAILED+4013；terminal auth_init→device
 *            在线 auth_ack matched 回显 device_sid；device 离线关断 4010；二连 terminal
 *            先到者 KICKED+4009（互踢第一禁令 shim 侧）；device 有效 auth_init→auth_ack
 *            matched 回显（活体兼容面，v0.10 G SHIM-02g 裁决），畸形（缺 device_sid）
 *            →WRONG_PARAM+1000 参数面对称
 *   SHIM-03  回环硬闸：绑定非 127.0.0.1（0.0.0.0/localhost）启动即拒（模块面 throw+CLI 面
 *            退出码 1）；CLI 正常拉起面；SHIM_DEFAULT_PORT/WS2_PATH 常量锁（OPEN-10.3）
 *   SHIM-04  数据面 device↔terminal 双向逐字透传（TEXT 字符串逐字相等/BINARY 字节相等含
 *            非 UTF8 与 >64KiB 长度路径；未配对帧丢弃不缓冲 §2.7）
 *   （W-RESP-01..04 已在 v0.10 G2 平移入 watcher-core——寄位撤销，主句随套迁出，
 *     本套不再含该断言组）
 *
 * 运行方式：node tests/suites/watcher-shim.mjs（v0.10 G 已入 run-all REGISTRY L1）
 * 前置：node >= 20；仅 127.0.0.1 回环 IO（零出站云，EXP10-ZC-01 同口径；套内无 fetch 调用）；
 *       WS 帧构造复用 watcher/ws.mjs codec；ws2 URL 组装复用 relay.mjs buildWs2Url（对拍面）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Checker } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot } from "../harness/temp-root.mjs";
import { startShim, parseShimArgs, LOOPBACK_HOST, SHIM_DEFAULT_PORT, WS2_PATH } from "../../watcher/relay-shim.mjs";
import { buildWs2Url } from "../../watcher/relay.mjs";
import { buildUpgradeRequest, encodeFrame, FrameParser, OP, parseUpgradeResponse } from "../../watcher/ws.mjs";

const SHIM_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "watcher", "relay-shim.mjs");
const ck = new Checker("watcher-shim");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tryJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
const sortedKeys = (o) => (o && typeof o === "object" ? Object.keys(o).sort() : []);

/* SHIM-01 对拍 fixture（contract.ts:96-149 形状内联；上游克隆在 %TEMP% 短寿命，禁依赖） */
const FIX = {
  shell: ["code", "data", "msg"],                                  // {code,msg,data} 响应壳
  devicePostData: ["created_at", "device_mid", "device_sid", "meta", "online"],
  deviceGetRow: ["device_mid", "device_sid", "meta", "online"],
  tokenData: ["expires_in", "token"],
  tokenRe: /^[A-Za-z0-9_-]{22}$/,                                  // 16B base64url=22 字符
  tokenTail: /[AQgw]$/,                                            // 末字符∈[AQgw]（16B 形状自然满足）
  sidRe: /^[A-Za-z0-9._~-]+$/,                                     // id schema
  ws2Path: WS2_PATH,
};

const roots = [];
const shims = [];
const clients = [];
const children = [];
const httpJson = (port, method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
  const req = http.request(
    { host: LOOPBACK_HOST, port, method, path: p, headers: { ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers } },
    (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, text, json: tryJson(text) });
      });
    },
  );
  req.on("error", reject);
  if (data) req.write(data);
  req.end();
});
const originOf = (port) => `http://${LOOPBACK_HOST}:${port}`;
const ws2 = (port, token, mid) => buildWs2Url({ origin: originOf(port), token, mid });

/** ws 测试客户端：手工握手（裸 socket+codec 直控）。收件箱先于 resolve 建立并在同一 data
 *  事件内吃进 101 之后的早期帧——回环上 shim 常把 101+error 帧+CLOSE 同 tick 连发，
 *  事后挂 onmessage 会静默丢帧（wait-frame-timeout 根因），故不使用 connectWs。 */
function wsClosePayload(code, reason) {
  const r = Buffer.from(String(reason || ""), "utf8");
  const b = Buffer.alloc(2 + r.length);
  b.writeUInt16BE(code & 0xffff, 0);
  if (r.length) r.copy(b, 2);
  return b;
}
class WsTestClient {
  static open(url) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const port = Number(u.port || 80);
      const key = crypto.randomBytes(16).toString("base64");
      const sock = net.connect({ host: u.hostname, port });
      const c = new WsTestClient(sock);
      const parser = new FrameParser();
      let buf = Buffer.alloc(0);
      let upgraded = false;
      let settled = false;
      sock.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
      sock.on("connect", () => {
        sock.write(buildUpgradeRequest({ host: u.hostname, port, path: u.pathname + u.search, key }));
      });
      sock.on("data", (d) => {
        if (!upgraded) {
          buf = Buffer.concat([buf, d]);
          const r = parseUpgradeResponse(buf, key);
          if (r.incomplete) return;
          upgraded = true;
          if (!r.ok) { if (!settled) { settled = true; reject(new Error("handshake-failed:" + (r.error || r.status))); } return; }
          if (!settled) { settled = true; resolve(c); } // resolve 后同步喂早期帧（收件箱先于消费面就绪）
          if (r.rest && r.rest.length) c.feed(r.rest, parser);
          return;
        }
        c.feed(d, parser);
      });
      sock.on("close", () => { if (!c.closes.length) c.closes.push({ code: 1006, reason: "socket-closed" }); });
    });
  }
  constructor(sock) { this.sock = sock; this.inbox = []; this.closes = []; }
  feed(chunk, parser) {
    let frames;
    try { frames = parser.push(chunk); } catch { return; }
    for (const f of frames) {
      if (f.opcode === OP.CLOSE) {
        const code = f.payload && f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        const reason = f.payload && f.payload.length > 2 ? f.payload.subarray(2).toString("utf8") : "";
        this.closes.push({ code, reason });
        try { this.sock.end(encodeFrame({ opcode: OP.CLOSE, payload: wsClosePayload(1000, ""), mask: true })); } catch { /* 已断 */ } // RFC 回显
        continue;
      }
      if (f.opcode === OP.PING) { try { this.sock.write(encodeFrame({ opcode: OP.PONG, payload: f.payload, mask: true })); } catch { /* 已断 */ } continue; }
      if (f.opcode === OP.TEXT || f.opcode === OP.BINARY) this.inbox.push({ payload: f.payload, opcode: f.opcode });
    }
  }
  sendText(t) { this.sock.write(encodeFrame({ opcode: OP.TEXT, payload: Buffer.from(String(t), "utf8"), mask: true })); }
  sendBinary(buf) { this.sock.write(encodeFrame({ opcode: OP.BINARY, payload: buf, mask: true })); }
  async waitFrame(ms = 5000) {
    const t0 = Date.now();
    for (;;) {
      if (this.inbox.length) return this.inbox.shift();
      if (Date.now() - t0 > ms) throw new Error("wait-frame-timeout");
      await sleep(10);
    }
  }
  async waitClose(ms = 5000) {
    const t0 = Date.now();
    for (;;) {
      if (this.closes.length) return this.closes.shift();
      if (Date.now() - t0 > ms) throw new Error("wait-close-timeout");
      await sleep(10);
    }
  }
  async quiesced(ms = 200) { const n = this.inbox.length; await sleep(ms); return this.inbox.length === n; }
  close(code = 1000, reason = "") {
    try { this.sock.end(encodeFrame({ opcode: OP.CLOSE, payload: wsClosePayload(code, reason), mask: true })); } catch { /* 已断 */ }
    try { this.sock.destroy(); } catch { /* 已灭 */ }
  }
}

const spawnExit = (args) => new Promise((resolve) => {
  const ch = spawn(process.execPath, [SHIM_FILE, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(ch);
  let out = "", errOut = "";
  ch.stdout.on("data", (d) => { out += String(d); });
  ch.stderr.on("data", (d) => { errOut += String(d); });
  ch.on("close", (code) => resolve({ code, stdout: out, stderr: errOut }));
});
const waitListening = (ch, ms = 8000) => new Promise((resolve, reject) => {
  let acc = "";
  const t0 = Date.now();
  const onData = (d) => {
    acc += String(d);
    const m = /relay-shim listening on 127\.0\.0\.1:(\d+)/.exec(acc);
    if (m) { cleanup(); resolve(Number(m[1])); }
  };
  const timer = setInterval(() => { if (Date.now() - t0 > ms) { cleanup(); reject(new Error("boot-timeout")); } }, 100);
  const cleanup = () => { ch.stdout.off("data", onData); clearInterval(timer); };
  ch.stdout.on("data", onData);
});

/* ============================ SHIM-01 HTTP 四端点形状对拍 ============================ */
async function shim01() {
  const T = makeTempRoot({ prefix: "orch-shim01-" }); roots.push(T);
  const s = await startShim({ root: T.root, port: 0 }); shims.push(s);
  let r = await httpJson(s.port, "GET", "/api/v1/remote/device");
  ck.ok("SHIM-01a GET 空注册表=data 空数组", r.status === 200 && r.json?.code === 0 && Array.isArray(r.json?.data) && r.json.data.length === 0, r.json);
  ck.ok("SHIM-01a2 响应壳键集={code,msg,data}", JSON.stringify(sortedKeys(r.json)) === JSON.stringify(FIX.shell), sortedKeys(r.json));

  r = await httpJson(s.port, "POST", "/api/v1/remote/device", { device_mid: "mid-A" });
  const d = r.json?.data;
  ck.ok("SHIM-01b POST /device 200 {code:0,msg:\"\"}", r.status === 200 && r.json?.code === 0 && r.json?.msg === "", r.json);
  ck.ok("SHIM-01b2 data 键集=contract 五键（形状钉）", JSON.stringify(sortedKeys(d)) === JSON.stringify(FIX.devicePostData), sortedKeys(d));
  ck.ok("SHIM-01b3 online:true + created_at 整数秒 + meta:{}", d?.online === true && Number.isInteger(d?.created_at) && d.created_at <= Date.now() / 1000 + 5 && JSON.stringify(d?.meta) === "{}", d);
  const sidA = d?.device_sid;
  ck.ok("SHIM-01c device_sid 形状 ^[A-Za-z0-9._~-]+$ ≤256", typeof sidA === "string" && FIX.sidRe.test(sidA) && sidA.length <= 256, sidA);
  r = await httpJson(s.port, "POST", "/api/v1/remote/device", { device_mid: "mid-A" });
  ck.ok("SHIM-01d 复注册同 mid 同 sid（跨注册稳定）", r.json?.data?.device_sid === sidA, r.json?.data);

  r = await httpJson(s.port, "GET", "/api/v1/remote/device");
  const row = r.json?.data?.[0];
  ck.ok("SHIM-01e GET 行键集=四键+值回显+online:false（无 device ws）", row
    && JSON.stringify(sortedKeys(row)) === JSON.stringify(FIX.deviceGetRow)
    && row.device_sid === sidA && row.device_mid === "mid-A" && row.online === false && JSON.stringify(row.meta) === "{}", row);

  r = await httpJson(s.port, "POST", "/api/v1/remote/token", { role: "device" });
  const tk = r.json?.data?.token;
  ck.ok("SHIM-01f token 22 字符 base64url+末字符∈[AQgw]+expires_in 3600", r.json?.code === 0 && typeof tk === "string"
    && FIX.tokenRe.test(tk) && FIX.tokenTail.test(tk) && r.json?.data?.expires_in === 3600, { tk, data: r.json?.data });
  ck.ok("SHIM-01f2 token data 键集=二键（形状钉）", JSON.stringify(sortedKeys(r.json?.data)) === JSON.stringify(FIX.tokenData), sortedKeys(r.json?.data));
  r = await httpJson(s.port, "POST", "/api/v1/remote/token", { role: "terminal" }, { authorization: "Bearer null" });
  ck.ok("SHIM-01g Bearer null 容忍（Authorization 头忽略）", r.status === 200 && r.json?.code === 0 && FIX.tokenRe.test(r.json?.data?.token || ""), r.json);
  r = await httpJson(s.port, "POST", "/api/v1/remote/token", { role: "admin" });
  ck.ok("SHIM-01h 非法 role→400 {code:1}", r.status === 400 && r.json?.code === 1, r.json);

  r = await httpJson(s.port, "POST", "/api/v1/remote/device/delete", { device_mid: "mid-A" });
  ck.ok("SHIM-01i delete→{code:0,msg:\"\"}（data 省略）", r.status === 200 && r.json?.code === 0 && r.json?.msg === "", r.json);
  r = await httpJson(s.port, "GET", "/api/v1/remote/device");
  ck.ok("SHIM-01i2 delete 后空表", r.json?.data?.length === 0, r.json?.data);
  r = await httpJson(s.port, "POST", "/api/v1/remote/device/delete", { device_mid: "mid-ghost" });
  ck.ok("SHIM-01i3 delete 幂等（查无亦 0）", r.status === 200 && r.json?.code === 0, r.json);
  r = await httpJson(s.port, "POST", "/api/v1/remote/device/delete", {});
  ck.ok("SHIM-01i4 delete 无标识→400", r.status === 400 && r.json?.code === 1, r.json);

  r = await httpJson(s.port, "POST", "/api/v1/remote/device", { device_mid: "mid-B" });
  const sidB = r.json?.data?.device_sid;
  const stateFile = path.join(T.root, "sentinel", "relay-shim-state.json");
  ck.ok("SHIM-01j 状态文件落 <root>/sentinel/relay-shim-state.json", typeof sidB === "string" && fs.existsSync(stateFile), stateFile);
  await s.close();
  const s2 = await startShim({ root: T.root, port: 0 }); shims.push(s2);
  r = await httpJson(s2.port, "GET", "/api/v1/remote/device");
  const rowB = (r.json?.data || []).find((x) => x.device_mid === "mid-B");
  ck.ok("SHIM-01j2 跨重启 mid-B 同 sid（桌面缓存 device_sid 稳定）", !!rowB && rowB.device_sid === sidB && rowB.online === false, rowB);
}

/* ============================ SHIM-02 ws2 鉴权/配对面 ============================ */
async function shim02() {
  const T = makeTempRoot({ prefix: "orch-shim02-" }); roots.push(T);
  const s = await startShim({ root: T.root, port: 0 }); shims.push(s);
  await httpJson(s.port, "POST", "/api/v1/remote/device", { device_mid: "mid-D" });
  let g = await httpJson(s.port, "GET", "/api/v1/remote/device");
  const sidD = g.json.data[0].device_sid;
  const tok = async (role) => (await httpJson(s.port, "POST", "/api/v1/remote/token", { role })).json.data.token;
  const tkD = await tok("device");
  const tkT1 = await tok("terminal");
  const tkT2 = await tok("terminal");
  const tkT3 = await tok("terminal");
  const tkT9 = await tok("terminal");

  // a 未表 token → 自动注册 pending 收纳（Q2 回环信任增补：无 error 帧且连接存活；角色由首帧判定）
  let c = await WsTestClient.open(ws2(s.port, "deadbeefdeadbeefdeadbeef", "mid-D")); clients.push(c);
  const noise = await Promise.race([c.waitFrame().then(() => "frame"), sleep(300).then(() => "timeout")]);
  ck.ok("SHIM-02a 未表 token→自动注册收纳（无 error 帧且连接存活）", noise === "timeout" && c.closes.length === 0, noise);
  // b 缺 mid → 同面（query 缺参）
  c = await WsTestClient.open(`ws://${LOOPBACK_HOST}:${s.port}${FIX.ws2Path}?token=${encodeURIComponent(tkT1)}`);
  clients.push(c);
  const f = await c.waitFrame();
  const msg = tryJson(String(f.payload));
  ck.ok("SHIM-02b 缺 mid→AUTH_FAILED", msg?.type === "error" && msg?.code === "AUTH_FAILED", f.payload);
  ck.ok("SHIM-02b2 关断码 4013", (await c.waitClose()).code === 4013, c.closes[0]);

  // c device 连入 → 「桌面在线」事实源驱动 GET /device online
  const dev = await WsTestClient.open(ws2(s.port, tkD, "mid-D")); clients.push(dev);
  await sleep(80);
  g = await httpJson(s.port, "GET", "/api/v1/remote/device");
  ck.ok("SHIM-02c device ws 在位→GET online:true", (g.json.data[0] || {}).online === true, g.json.data);

  // d terminal auth_init→device 在线：auth_ack matched 回显 device_sid（§2.4）
  const t1 = await WsTestClient.open(ws2(s.port, tkT1, "mid-D")); clients.push(t1);
  t1.sendText(JSON.stringify({ type: "auth_init", device_sid: sidD, meta: { platform: "orch-watch" }, client_ts: Math.floor(Date.now() / 1000) }));
  const ack = tryJson(String((await t1.waitFrame()).payload));
  ck.ok("SHIM-02d auth_ack matched 回显 sid+键集三键", ack?.type === "auth_ack" && ack?.pair_status === "matched"
    && ack?.device_sid === sidD && JSON.stringify(sortedKeys(ack)) === JSON.stringify(["device_sid", "pair_status", "type"]), ack);

  // e device 离线（未知 sid）→ 关断 4010 DesktopDisconnected，无 auth_ack 泄漏
  const t2 = await WsTestClient.open(ws2(s.port, tkT2, "mid-D")); clients.push(t2);
  t2.sendText(JSON.stringify({ type: "auth_init", device_sid: "dev-nonexistent-sid", client_ts: 1 }));
  const cl2 = await t2.waitClose();
  ck.ok("SHIM-02e device 离线→4010 DesktopDisconnected", cl2.code === 4010 && cl2.reason === "DesktopDisconnected", cl2);
  ck.ok("SHIM-02e2 无 auth_ack 泄漏", t2.inbox.length === 0, t2.inbox);

  // f 二连 terminal：先到者 error KICKED+4009（互踢第一禁令 shim 侧），新 terminal 配对成功
  const t3 = await WsTestClient.open(ws2(s.port, tkT3, "mid-D")); clients.push(t3);
  t3.sendText(JSON.stringify({ type: "auth_init", device_sid: sidD, client_ts: 2 }));
  const ack3 = tryJson(String((await t3.waitFrame()).payload));
  ck.ok("SHIM-02f 二连 terminal 配对成功", ack3?.type === "auth_ack" && ack3?.pair_status === "matched", ack3);
  const kf = tryJson(String((await t1.waitFrame()).payload));
  ck.ok("SHIM-02f2 先到者 error 帧 KICKED", kf?.type === "error" && kf?.code === "KICKED", kf);
  ck.ok("SHIM-02f3 先到者关断 4009 Conflict", (await t1.waitClose()).code === 4009, t1.closes[0]);
  g = await httpJson(s.port, "GET", "/api/v1/remote/device");
  ck.ok("SHIM-02f4 踢后桌面仍在线", (g.json.data[0] || {}).online === true, g.json.data);

  // g device 角色发 auth_init——v0.10 G 裁决（理由入 tests/assertions/v0.10.x.md）：
  // 真桌面 device 角色 ws open 即 setState("authenticating")+send auth_init{device_sid}，
  // 且只认 device_sid 匹配的 auth_ack（webRemoteControlTransport.ts:200；app.asar 实测同形）
  // → 有效 auth_init 是活体兼容面，必须回 auth_ack matched+回显；vendor fake-relay-v2 的
  // 「device auth_init→WRONG_PARAM」只是参考实现语义，被活体证据取代。畸形（缺 device_sid）
  // 才走参数面 WRONG_PARAM+1000（与 terminal 鉴权闸前畸形帧同面）。
  await httpJson(s.port, "POST", "/api/v1/remote/device", { device_mid: "mid-W" });
  g = await httpJson(s.port, "GET", "/api/v1/remote/device");
  const sidW = g.json.data.find((x) => x.device_mid === "mid-W").device_sid;
  const tkWD = await tok("device");
  const dw = await WsTestClient.open(ws2(s.port, tkWD, "mid-W")); clients.push(dw);
  dw.sendText(JSON.stringify({ type: "auth_init", device_sid: sidW, client_ts: 3 }));
  const wf = tryJson(String((await dw.waitFrame()).payload));
  ck.ok("SHIM-02g device 有效 auth_init→auth_ack matched 回显 device_sid（活体兼容面）",
    wf?.type === "auth_ack" && wf?.pair_status === "matched" && wf?.device_sid === sidW, wf);
  await sleep(120);
  ck.ok("SHIM-02g2 有效面连接保持（不误杀真桌面）", dw.closes.length === 0, dw.closes[0]);
  // 畸形面：device auth_init 缺 device_sid → WRONG_PARAM+1000（参数面对称）
  const tkWD2 = await tok("device");
  const dw2 = await WsTestClient.open(ws2(s.port, tkWD2, "mid-W2")); clients.push(dw2);
  dw2.sendText(JSON.stringify({ type: "auth_init", client_ts: 4 }));
  const wf2 = tryJson(String((await dw2.waitFrame()).payload));
  ck.ok("SHIM-02g3 device auth_init 缺 device_sid→error WRONG_PARAM（畸形对称面）", wf2?.type === "error" && wf2?.code === "WRONG_PARAM", wf2);
  ck.ok("SHIM-02g4 畸形面关断（1000）", (await dw2.waitClose()).code === 1000, dw2.closes[0]);

  // 供 SHIM-04 复用的活跃配对留在此 shim：dev+新 terminal
  const tkT4 = await tok("terminal");
  const t4 = await WsTestClient.open(ws2(s.port, tkT4, "mid-D")); clients.push(t4);
  t4.sendText(JSON.stringify({ type: "auth_init", device_sid: sidD, client_ts: 4 }));
  ck.ok("SHIM-02h 踢后新 terminal 再配对成功", tryJson(String((await t4.waitFrame()).payload))?.pair_status === "matched", t4.inbox);
  return { shim: s, dev, t4, tkT9 };
}

/* ============================ SHIM-03 回环硬闸 ============================ */
async function shim03() {
  const T = makeTempRoot({ prefix: "orch-shim03-" }); roots.push(T);
  let err = null;
  try { await startShim({ host: "0.0.0.0", root: T.root, port: 0 }); } catch (e) { err = e; }
  ck.ok("SHIM-03a 0.0.0.0 绑定启动即拒（模块面）", !!err && err.code === "shim-loopback-gate" && String(err.message).includes("127.0.0.1"), err && err.message);
  err = null;
  try { await startShim({ host: "localhost", root: T.root, port: 0 }); } catch (e) { err = e; }
  ck.ok("SHIM-03b localhost 亦拒（仅 127.0.0.1 白名单）", !!err && err.code === "shim-loopback-gate", err && err.message);

  const rc = await spawnExit(["--host", "0.0.0.0", "--port", "0", "--root", T.root]);
  ck.ok("SHIM-03c CLI 非回环 host→退出码 1+stderr 说明", rc.code === 1 && /loopback|127\.0\.0\.1/i.test(rc.stderr), { code: rc.code, stderr: rc.stderr.slice(0, 160) });
  const ch = spawn(process.execPath, [SHIM_FILE, "--host", LOOPBACK_HOST, "--port", "0", "--root", T.root], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(ch);
  const port = await waitListening(ch);
  ck.ok("SHIM-03d CLI 127.0.0.1 正常拉起", Number.isInteger(port) && port > 0, port);
  const r = await httpJson(port, "GET", "/api/v1/remote/device");
  ck.ok("SHIM-03d2 CLI 面 GET /device 200 空表", r.status === 200 && r.json?.code === 0 && Array.isArray(r.json?.data), r.json);
  ch.kill();
  await new Promise((res) => ch.on("close", () => res()));

  ck.ok("SHIM-03e SHIM_DEFAULT_PORT=47010（OPEN-10.3 落值锁）", SHIM_DEFAULT_PORT === 47010, SHIM_DEFAULT_PORT);
  ck.ok("SHIM-03f WS2_PATH 与 relay.mjs buildWs2Url 同路对拍", buildWs2Url({ origin: "http://127.0.0.1:1", token: "t", mid: "m" }).includes(FIX.ws2Path + "?token=t&mid=m"), buildWs2Url({ origin: "http://127.0.0.1:1", token: "t", mid: "m" }));
  ck.ok("SHIM-03g parseShimArgs 缺省=回环/47010", (() => { const a = parseShimArgs([]); return a.host === "127.0.0.1" && a.port === 47010; })(), parseShimArgs([]));
}

/* ============================ SHIM-04 数据面双向逐字透传 ============================ */
async function shim04(ctx) {
  const { shim: s, dev, t4, tkT9 } = ctx;
  // a terminal→device TEXT 逐字相等（opcode 保持 TEXT）
  const s1 = JSON.stringify({ type: "data", payload: { zcode_type: "rpc-frame", bridgeSessionId: "bs-1", seq: 1, messageSeq: 1, fragmentIndex: 0, fragmentCount: 1, messageBytes: 16, checksum: { algorithm: "crc32", value: "1a2b3c4d" }, dataBase64: "QUJDRA==" } });
  t4.sendText(s1);
  const fa = await dev.waitFrame();
  ck.ok("SHIM-04a terminal→device TEXT 逐字相等", fa.opcode === OP.TEXT && fa.payload === s1, typeof fa.payload === "string" ? fa.payload.slice(0, 80) : fa.payload);
  // b device→terminal TEXT 逐字相等
  const s2 = JSON.stringify({ type: "data", payload: { zcode_type: "workspace-list-response", requestId: "req-9", result: { workspaces: [{ workspacePath: "D:/x", activeWorkspaceKey: "k" }] } } });
  dev.sendText(s2);
  const fb = await t4.waitFrame();
  ck.ok("SHIM-04b device→terminal TEXT 逐字相等", fb.opcode === OP.TEXT && fb.payload === s2, typeof fb.payload === "string" ? fb.payload.slice(0, 80) : fb.payload);
  // c terminal→device BINARY 非 UTF8 字节相等（证明无 utf8 roundtrip 改写）
  const b1 = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01, 0x7f, 0x61]);
  t4.sendBinary(b1);
  const fc = await dev.waitFrame();
  ck.ok("SHIM-04c terminal→device BINARY 字节相等（非 UTF8 面）", fc.opcode === OP.BINARY && Buffer.isBuffer(fc.payload) && fc.payload.equals(b1), fc.payload && fc.payload.toString("hex"));
  // d device→terminal 大帧（>65536：64 位长度路径）逐字节
  const b2 = crypto.randomBytes(200000);
  dev.sendBinary(b2);
  const fd = await t4.waitFrame();
  ck.ok("SHIM-04d 200KB BINARY 逐字节（64 位长度路径）", fd.opcode === OP.BINARY && Buffer.isBuffer(fd.payload) && fd.payload.equals(b2), fd.payload && fd.payload.length);
  // e 未配对帧丢弃不缓冲（§2.7）：pre-auth terminal 发数据帧→对岸零新增+本连接 WRONG_PARAM 断
  const t9 = await WsTestClient.open(ws2(s.port, tkT9, "mid-D")); clients.push(t9);
  t9.sendText(JSON.stringify({ type: "data", payload: { zcode_type: "noise" } }));
  ck.ok("SHIM-04e 未配对帧丢弃不缓冲（对岸零新增）", (await dev.quiesced(200)) === true, dev.inbox.length);
  const ef = tryJson(String((await t9.waitFrame()).payload));
  ck.ok("SHIM-04e2 pre-auth 数据帧→WRONG_PARAM 面", ef?.type === "error" && ef?.code === "WRONG_PARAM", ef);
}

/* ================================== 主流程 ================================== */
let ctx02 = null;
try {
  await shim01();
  ctx02 = await shim02();
  await shim03();
  await shim04(ctx02);
} catch (err) {
  process.stderr.write("[watcher-shim] FATAL: " + ((err && err.stack) || String(err)) + "\n");
  ck.fails.push("suite-fatal: " + ((err && err.message) || String(err)));
} finally {
  for (const c of clients) c.close();
  for (const ch of children) { try { ch.kill(); } catch { /* 已退 */ } }
  for (const s of shims) await s.close();
  for (const t of roots) t.cleanup();
}
const { pass, fail } = ck.summary();
process.exit(fail ? 1 : 0);
