/*!
 * watcher/inject.mjs —— INJECT 注入（模板壳 + VQL/ChannelClient 内层编码器 + wake 链 b2 自愈，
 * v0.10 W3 wake 链 04D-3）
 *
 * 模板壳固定（W-W §4 原案）：`[orch-watch] mission=<id> state=<state> summary=<≤200字>
 * 指引=请消费 spool/<mission_id>/unread/<event_id>.json（路径指针，非正文）`
 *
 * 隐私最小化纪律（W-W §4）：禁内联 worker 原文（提示注入放大器）；正文永远留在 spool 走
 * 既有闸门；watcher 只发 id+状态+指针。中继非零知识（data payload 中继可读明文）——
 * 壳内只含 mission id/状态/指针，把过云暴露面压到最小。模板壳纪律原样保留（SHELL_PREFIX/
 * 单行/指针纪律/隐私最小化），只有装载层换代（DESIGN §4.4）。
 *
 * 内层编码器（L3 §1.2/§1.3 字节级；V1 世代裸 JSON `{method:"session/send"}` 退役）：
 *   - VQL 最小集（@zcode/rpc serialization.ts:109-117/152-190）：
 *     Undefined=tag0 单字节；String=tag1+VQL 长度+UTF8；Buffer=tag2+长度+raw；
 *     Array=tag4+长度+逐元素；Int=tag6+VQL 变长（7bit 组小端，续传高位；0→[0x00]、
 *     127→[0x7F]、128→[0x80,0x01]）；Object=tag5+长度+JSON.stringify。
 *   - ChannelClient 请求字节（channelClient.ts:179-190）= serialize([100,id,channel,method])
 *     + serialize(argsArray)；id 从 0 递增（:27,:89）；与帧层 physicalSeq/messageSeq 计数独立
 *     （频道面 vs transport 面，两套计数器不混用）。
 *   - **G9 铁律（EXP10-findings R3-5 根因，v0.10 G3）**：service 频道第三参必须是「位置参数
 *     数组」——上游 ProxyChannel.fromService.call 执行 target.apply(handler, args || [])
 *     （proxy-channel.ts:104-111），toService 把调用实参包成数组（:132-137）；
 *     channelClient.sendRequest 原样 serialize(argsArray)。裸对象会被 apply 按
 *     length=undefined 视作 0 参 → 对岸收 undefined（Txn1 initializeConversationV4
 *     ZodError 实锤）。本文件三处 call 一律传数组：hello=[]、initialize=[clientHello]、
 *     命令=[params]（b1/b2 同点）。
 *   - Initialize 闸（channelServer.ts:28-36 + channelClient.ts:107-110）：收 [200]+undefined
 *     前不发任何请求；未初始化期请求挂起（排队），Initialize 到达后按序冲刷。
 *   - 请求 id 匹配：PromiseSuccess=[201,id]+data → resolve；PromiseError=[202,id,…] →
 *     reject（data 形状 channels.shared.ts:33-47）。
 *   - 连接握手（G8，W3s；EXP10-findings R2-6 上游锚 @3c5b2276）：zcode-agent 频道连接作用域
 *     要求任何命令前完成两步握手 helloConversationV4→initializeConversationV4（缺 hello 即
 *     fault.connection.handshakeRequired——Txn1「verdict=delivered 但未复活」的实底；hello 后
 *     未 initialize 才报 helloRequired）。ensureChannelHandshake 每桥恰一次（ChannelClient 每
 *     桥一实例，重连/重桥=新客户端=握手随新连接重来）；与 Initialize 闸是两层勿混淆（闸=
 *     initialized 标志，收 [200] 方发帧；握手=连接作用域的 hello/initialize 命令面，其请求
 *     同样过闸排队）。clientHello 是 strict schema（transport.ts :74-92 多余键即拒），参数
 *     形状照上游逐字段不增删；capabilities 仅许 host hello 见 workflowRunDeltas:true 后回
 *     声明——本客户端不声明。
 *
 * wake 链调用面（候选双编码，DESIGN §4.5；定案由 EXP-10 实证择一记 findings）：
 *   候选 1（缺省装配）：zcode-agent/sendConversationCommandV4（zcodeAgent.ts:937）；
 *   候选 2（replayable 手机语义，未定案备选）：zcode-task/sendPrompt（zcodeTaskServiceAdapter.ts:2080-2102）。
 *
 * C11 b2 自愈（DESIGN §5 + L4 §3.2/§4.2-G6 定案）：stale 目标双触发面——transport 面
 * bridge-error reason∈{session-not-found,session-expired}（SELF_HEAL_REASONS 既有）；CLI 面
 * callP rejection/ack rejected 且字样命中 session（sessionErrorHit 宽匹配，命令面无
 * reasonCode 枚举承诺，L4 §5 查无实锤）→ createSession+firstInput 重试恰一次（envelope
 * sessionId=null、payload={workspaceId:identity||path,firstInput:{text}}，建会话+首发一体；
 * createSession ack result 带 sessionId=command.ts:391-399，取代旧 sendText+sessionId:null
 * 死路——inputAccepted 无 sessionId）→ 以应答回读的活体会话 id 原子刷新 coord-session.txt
 * （best-effort 永不 fatal；b1 活体目标零重写）。server.mjs toolResume 权威通道 #1 语义不动
 * （v0.4.1 零改——watcher 侧通道足用，本文件即 DESIGN §5 的新增刷新触发落点）。
 * **v0.10 G5 守卫**：无 workspaceKeyHint 生产缺省 fail-loud（workspace-anchor-missing），
 * 刷新仅当本次桥/应答工作区与锚一致（workspaceVerified），否则保持原锚 + warnings——R4
 * 锚劫持（错工作区 b2→回读改写 coord-session）的防线。
 * 零 npm 依赖；node >= 20。
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { openBridge, bridgeOf, workspaceKeyMatches } from "./bridge.mjs";

export const SHELL_PREFIX = "[orch-watch]";
export const SUMMARY_MAX = 200; // 与 report summary ≤200 字口径一致

/** 单行化 + 夹紧：换行/回车压空格（壳必须单行），summary ≤200 字符。 */
export function sanitizeSummary(summary) {
  return String(summary ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SUMMARY_MAX);
}

/**
 * 模板壳构造。state ∈ done|failed|blocked|question（RESULT_STATUSES）。
 * eventId 缺省用 "latest"（消费侧取 unread/ 最新一条）。
 */
export function buildTemplateShell({ missionId, state, summary, eventId = "latest" } = {}) {
  const id = String(missionId ?? "");
  const st = String(state ?? "");
  if (!id || !["done", "failed", "blocked", "question"].includes(st)) {
    throw Object.assign(new Error("shell-bad-args"), { code: "shell-bad-args" });
  }
  const s = sanitizeSummary(summary);
  const ptr = `spool/${id}/unread/${eventId}.json`;
  return `${SHELL_PREFIX} mission=${id} state=${st} summary=${s || "(无摘要)"} 指引=请消费 ${ptr}（路径指针，非正文）`;
}

/** 壳纪律自检：单行、含前缀、含指针、不含反引号/花括号注入面。 */
export function shellCompliant(shell) {
  const s = String(shell ?? "");
  return (
    s.startsWith(SHELL_PREFIX) &&
    !/[\r\n]/.test(s) &&
    s.includes("指引=请消费 spool/") &&
    s.includes("（路径指针，非正文）") &&
    !/[`{}$]/.test(s) &&
    s.length <= 1000
  );
}

/* ================= VQL 最小集（serialization.ts:109-117/152-190；L3 §1.2） ================= */

export const VQL_TAG = { Undefined: 0, String: 1, Buffer: 2, VSBuffer: 3, Array: 4, Object: 5, Int: 6 };

const byte1 = (n) => Buffer.from([n & 0xff]);

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** VQL 变长整数：7bit 组小端，最高位=续传标志（write :84-104）。 */
export function vqlVarint(n) {
  n = Number(n);
  if (!Number.isInteger(n) || n < 0) throw Object.assign(new Error("vql-negative-int"), { code: "vql-bad-int" });
  const out = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

/** serialize 对称面：Undefined/String/Buffer/Array/Int/Object（嵌套 Uint8Array 标记 v0 不做——
 * 候选 1/2 参数面全 JSON-able，无二进制参数）。 */
export function vqlEncode(value) {
  const chunks = [];
  const enc = (v) => {
    if (v === undefined) { chunks.push(byte1(VQL_TAG.Undefined)); return; }
    if (typeof v === "string") {
      const raw = Buffer.from(v, "utf8");
      chunks.push(byte1(VQL_TAG.String), vqlVarint(raw.length), raw);
      return;
    }
    if (Buffer.isBuffer(v)) { chunks.push(byte1(VQL_TAG.Buffer), vqlVarint(v.length), v); return; }
    if (Array.isArray(v)) {
      chunks.push(byte1(VQL_TAG.Array), vqlVarint(v.length));
      for (const e of v) enc(e);
      return;
    }
    if (typeof v === "number") {
      // G4 Int 值域硬约束（注释级，L4 §1.1/§4.2-G4）：tag6 上游是 32 位语义——(data|0)===data
      // 才落 Int（负数走 32 位补码 varint），≥2^31 上游落 Object JSON fallback；若按 Int 编码
      // 越界值，上游解码器按 32 位 << 截断读出负垃圾。本编码器 Int 值域硬约束=[0, 2^31-1]：
      // 负数/浮点一律拒（vql-bad-int）；≥2^31 禁止调用方走 Int 面（需大数时放进 Object 走
      // tag5 JSON 序列化，如 issuedAt=unix ms）。wake 路径 Int 仅请求头 [100,id,channel,method]
      // 的 100 与请求 id，恒在界内。
      if (!Number.isInteger(v)) throw Object.assign(new Error("vql-float-int"), { code: "vql-bad-int" });
      chunks.push(byte1(VQL_TAG.Int), vqlVarint(v));
      return;
    }
    if (typeof v === "bigint") {
      if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw Object.assign(new Error("vql-bigint-overflow"), { code: "vql-bad-int" });
      chunks.push(byte1(VQL_TAG.Int), vqlVarint(Number(v)));
      return;
    }
    const json = Buffer.from(JSON.stringify(v), "utf8");
    chunks.push(byte1(VQL_TAG.Object), vqlVarint(json.length), json);
  };
  enc(value);
  return Buffer.concat(chunks);
}

/** deserialize 对称面（:193-224）：Buffer/VSBuffer 解为切片 Buffer，Object 走 JSON.parse。 */
export function vqlDecode(buf, cursor = { i: 0 }) {
  const tag = buf[cursor.i++];
  if (tag === VQL_TAG.Undefined) return undefined;
  const readLen = () => {
    let n = 0;
    let shift = 0;
    for (;;) {
      const b = buf[cursor.i++];
      n += (b & 0x7f) * Math.pow(2, shift);
      if (!(b & 0x80)) return n;
      shift += 7;
    }
  };
  if (tag === VQL_TAG.String) { const len = readLen(); const s = buf.subarray(cursor.i, cursor.i + len).toString("utf8"); cursor.i += len; return s; }
  if (tag === VQL_TAG.Buffer || tag === VQL_TAG.VSBuffer) { const len = readLen(); const s = buf.subarray(cursor.i, cursor.i + len); cursor.i += len; return s; }
  if (tag === VQL_TAG.Array) {
    const len = readLen();
    const arr = [];
    for (let k = 0; k < len; k++) arr.push(vqlDecode(buf, cursor));
    return arr;
  }
  if (tag === VQL_TAG.Int) {
    let n = 0;
    let shift = 0;
    for (;;) {
      const b = buf[cursor.i++];
      n += (b & 0x7f) * Math.pow(2, shift);
      if (!(b & 0x80)) return n;
      shift += 7;
    }
  }
  if (tag === VQL_TAG.Object) { const len = readLen(); const s = buf.subarray(cursor.i, cursor.i + len).toString("utf8"); cursor.i += len; return JSON.parse(s); }
  throw Object.assign(new Error("vql-tag:" + tag), { code: "vql-bad-tag" });
}

/* ================= ChannelClient（channelClient.ts:27/:89/:107-110/:179-190） ================= */

export const CHANNEL_REQUEST = { Promise: 100, PromiseCancel: 101, EventListen: 102, EventDispose: 103 };
export const CHANNEL_RESPONSE = { Initialize: 200, PromiseSuccess: 201, PromiseError: 202, PromiseErrorObj: 203, EventFire: 204 };

/**
 * 频道客户端（V1 世代裸 JSON 的换代件）：
 *   - call(channel,method,argsArray) 构字节 serialize([100,id,channel,method])+
 *     serialize(argsArray)（G9：service 频道第三参=位置参数数组，见文件头注记），经 emit(fn) 上槽；
 *   - Initialize 闸：未收 [200] 前请求排队（channelClient.ts:107-110 挂起语义），[200] 到达
 *     置 initialized 并按序冲刷——未收 Initialize 不发任何请求（W-INJ2-01 前半句）；
 *   - 请求 id 匹配：[201,id] resolve / [202,id]|[203,id] reject（channels.shared.ts:33-47 形状
 *     原样上抛，不深解释）。
 * emit=字节上槽回调（bridge 层经 RpcBridge.send 装帧）；feed(bytes)=入站消息字节入口。
 */
export class ChannelClient {
  #queue = [];
  #pending = new Map();
  #disposed = false;
  #disposeReason = null;

  constructor({ emit } = {}) {
    this.emit = typeof emit === "function" ? emit : () => {};
    this.lastRequestId = 0; // id 从 0 递增（channelClient.ts:27）
    this.initialized = false;
    // G8 连接握手状态（W3s）：handshakeP=进行中/已定的握手 promise（恰一次去重锚）；
    // handshakeDone=成功置位；lastRejection=callP 无人 await 时的拒因留痕（隐蔽面治理，Txn1）。
    this.handshakeP = null;
    this.handshakeDone = false;
    this.lastRejection = null;
  }

  get state() { return this.#disposed ? "disposed" : this.initialized ? "initialized" : "uninitialized"; }

  call(channelName, methodName, argsArray) {
    const id = this.lastRequestId++;
    const frameBytes = Buffer.concat([
      vqlEncode([CHANNEL_REQUEST.Promise, id, String(channelName), String(methodName)]),
      vqlEncode(argsArray === undefined ? undefined : argsArray),
    ]);
    return new Promise((resolve, reject) => {
      if (this.#disposed) { reject(this.#closedError(this.#disposeReason)); return; } // dispose 后新请求立即拒（上游 doRequest isDisposed 二次闸同型；reason 与 dispose 面同源）
      if (!this.initialized) { this.#queue.push({ id, frameBytes, resolve, reject }); return; } // 挂起待 Initialize
      this.#pending.set(id, { resolve, reject });
      this.emit(frameBytes);
    });
  }

  feed(bytes) {
    const c = { i: 0 };
    const header = vqlDecode(bytes, c);
    const body = c.i < bytes.length ? vqlDecode(bytes, c) : undefined;
    const [type, id] = Array.isArray(header) ? header : [];
    if (type === CHANNEL_RESPONSE.Initialize) {
      this.initialized = true;
      const q = this.#queue.splice(0);
      for (const item of q) { this.#pending.set(item.id, { resolve: item.resolve, reject: item.reject }); this.emit(item.frameBytes); } // 按序冲刷
      return { type };
    }
    if (type === CHANNEL_RESPONSE.PromiseSuccess) {
      const p = this.#pending.get(id);
      if (p) { this.#pending.delete(id); p.resolve(body); }
      return { type, id };
    }
    if (type === CHANNEL_RESPONSE.PromiseError || type === CHANNEL_RESPONSE.PromiseErrorObj) {
      const p = this.#pending.get(id);
      if (p) { this.#pending.delete(id); p.reject(body); }
      return { type, id };
    }
    return { type, id }; // EventFire 等 v0 不消费
  }

  /** G5 dispose fail-closed（channelClient.ts:250-275 语义对齐，勿过度设计）：传输终结时
   * 全部排队+在飞请求以 ConnectionClosed reject（不 fail-closed 会令上层 in-flight 去重
   * Promise 永挂）；dispose 后本客户端不再受理新请求（无自动重连——重连=新桥=新
   * ChannelClient=新 Initialize，上游同款）。 */
  dispose(reason) {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposeReason = reason || null;
    for (const item of this.#queue.splice(0)) item.reject(this.#closedError(reason));
    for (const p of this.#pending.values()) p.reject(this.#closedError(reason));
    this.#pending.clear();
  }

  #closedError(reason) {
    return Object.assign(new Error(reason || "ConnectionClosed"), { name: "ConnectionClosed", code: "connection-closed" });
  }
}

/* ================= G8 连接握手（W3s；EXP10-findings R2-6 上游锚 @3c5b2276） ================= */

/** V4 线协议版本（core.ts :7 V4_WIRE_PROTOCOL_VERSION=3；clientHello.protocolVersion 取值）。 */
export const V4_WIRE_PROTOCOL_VERSION = 3;

const HANDSHAKE_CHANNEL = "zcode-agent";
const HANDSHAKE_HELLO = "helloConversationV4"; // 步骤 1：取 host hello（zcodeAgentConnectionScope.ts :208-228 createHello）
const HANDSHAKE_INITIALIZE = "initializeConversationV4"; // 步骤 2：clientHello（:675-690 置位 handshakeComplete+clientId 绑定）

/**
 * clientHello 参数（clientHelloSchema strict，transport.ts :74-92——多余键即拒，形状照上游
 * 逐字段勿增删）：kind/protocolVersion/clientId/appVersion 四键恰等；capabilities 仅许 host
 * hello 见 workflowRunDeltas:true 后回声明——本客户端不声明（capabilities 缺省即不声明面）。
 * clientId 与 wake 命令面 buildConversationCommandParams 缺省同源（"orch-watch"）。
 */
export function buildClientHello({ clientId = "orch-watch", appVersion = "orch-watch/0.1", protocolVersion = V4_WIRE_PROTOCOL_VERSION } = {}) {
  return { kind: "clientHello", protocolVersion, clientId, appVersion };
}

/**
 * G8 两步连接握手，每连接（每桥）恰一次：helloConversationV4（无参，位置参数组 []）→
 * initializeConversationV4（clientHello，位置参数组 [clientHello]）。
 * 恰一次语义=handshakeP 按 ChannelClient 实例去重（并发/后续调用共享同一
 * promise，成功失败皆不重做——重试语义=新桥新客户端随新连接重来）；与 Initialize 闸两层勿
 * 混淆：握手请求本身过闸（[200] 前排队不发）。timeoutMs 只约束本调用方等待（竞速超时按
 * rpc-ack-timeout 族上抛，失败码族/降级归类不变），不动摇去重 promise——闸后续开握手仍可完成。
 * 失败面：对岸 [202] 拒（如 helloRequired/handshakeRequired）原样上抛，命令帧绝不发出。
 */
export function ensureChannelHandshake(client, { timeoutMs = 10000 } = {}) {
  if (!client || typeof client.call !== "function") {
    throw Object.assign(new Error("handshake-bad-client"), { code: "shell-bad-args" });
  }
  if (!client.handshakeP) {
    client.handshakeP = (async () => {
      // G9（R3-5）：第三参=位置参数数组。hello 无参传 []（显式空组，杜绝裸 undefined/对象
      // 形态回归）；对岸 apply(handler, args||[]) 语义下 [] 与 undefined 等价。
      await client.call(HANDSHAKE_CHANNEL, HANDSHAKE_HELLO, []); // 步骤 1（无参 → 空位置参数组）
      await client.call(HANDSHAKE_CHANNEL, HANDSHAKE_INITIALIZE, [buildClientHello()]); // 步骤 2（位置参数组包裹）
      client.handshakeDone = true;
    })();
    client.handshakeP.catch(() => {}); // 去重 promise 自身防 unhandledRejection（每个等待方自行消费）
  }
  const timeoutP = sleepMs(Math.max(0, timeoutMs)).then(() => {
    throw Object.assign(new Error("rpc-handshake-timeout（连接握手未决：Initialize 闸未开或对岸无应答）"), { code: "rpc-ack-timeout" });
  });
  timeoutP.catch(() => {}); // 竞速输方防 unhandledRejection
  return Promise.race([client.handshakeP, timeoutP]);
}

/* ================= 候选参数双编码（DESIGN §4.5；定案归 EXP-10） ================= */

/** uuidv7（零依赖，RFC 9562：48bit ms + ver7 + variant10）。 */
export function uuidv7(ms = Date.now(), rand = randomBytes(10)) {
  const tb = Buffer.alloc(8);
  tb.writeBigUInt64BE(BigInt(Math.floor(ms)) & 0xffffffffffffn, 0);
  const b = Buffer.alloc(16);
  tb.copy(b, 0, 2, 8); // ts48 → b[0..5]
  b[6] = 0x70 | (rand[0] & 0x0f);
  b[7] = rand[1];
  b[8] = 0x80 | (rand[2] & 0x3f);
  rand.copy(b, 9, 3, 10);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * 候选 1（缺省装配）：zcode-agent/sendConversationCommandV4 参数
 * {workspacePath, workspaceIdentity?, envelope:CommandEnvelope}（zcodeAgent.ts:937 +
 * command.ts:343-357 信封/sendText payload=command.ts:95-150）。
 * L4 定案（§4.2 G1/G2/G3，2026-10-23）：issuedAt=unix ms 数字（core.ts:19 z.number()，
 * UI 工厂 Date.now() 同款 commandFactory.ts:70；ISO 字符串会被 CLI parseCommandEnvelope
 * safeParse 拒）；payload=未包裹 per-type 对象直传（host 侧 sendText.parse(envelope.payload)
 * 双 parse 点 zcodeAgentService.ts:6168/:3804，{sendText:{…}} 包裹层会因 text 缺失必炸）；
 * heldQueueDisposition="keepQueueAndSend"（adapter replayable 同款 :455-461「等价老语义：
 * 立即发送、不动队列」）。inputOrigin="desktop" 会被 host 在 web-remote-replayable 面覆盖为
 * "mobile"（:6168-6172，无缺陷仅记录=L4 G7）。
 */
export function buildConversationCommandParams({ bridge, sessionId, content, clientId = "orch-watch", nowMs = Date.now(), commandId } = {}) {
  if (!bridge || !bridge.workspaceKey) throw Object.assign(new Error("bridge-context-missing"), { code: "shell-bad-args" });
  const ws = bridge.workspace || {};
  const workspacePath = typeof ws.workspacePath === "string" && ws.workspacePath ? ws.workspacePath : bridge.workspaceKey;
  const workspaceIdentity = typeof ws.workspaceIdentity === "string" && ws.workspaceIdentity.trim() ? ws.workspaceIdentity.trim() : undefined;
  return {
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    envelope: {
      commandId: commandId || uuidv7(nowMs),
      clientId,
      sessionId: sessionId || null,
      type: "sendText",
      payload: { text: String(content ?? ""), requestedDelivery: "startNow", heldQueueDisposition: "keepQueueAndSend", inputOrigin: "desktop" },
      issuedAt: nowMs,
    },
  };
}

/**
 * b2 自愈新建会话命令面（G6，L4 §3.2/§4.2-G6 定案）：createSession+firstInput 建会话+首发
 * 一体（command.ts:54-73「firstInput 携带 → 直接 turnHeader+userInput rows」；UI 先例
 * useSavedWorkflowLauncher.ts:158-183）。envelope.sessionId=null（信封注释「createSession 时
 * 为 null」command.ts:347）；payload={workspaceId:<identity||path>, firstInput:{text}}——
 * workspaceId 与 host getClient 的 workspaceKey 口径一致（resolveWorkspaceKey=
 * workspaceIdentity||workspacePath，useSavedWorkflowLauncher.ts:69-71）。createSession ack
 * result 带 sessionId（command.ts:391-399）→ resolveLiveSessionId 现行 resp.result.sessionId
 * 已兼容（禁改），b2 成功即回读活体 id（旧 sendText+sessionId:null 的 ack=inputAccepted 无
 * sessionId，coord-session.txt 永不刷新=OPEN-10.4 实底，故废弃该死路面）。
 */
export function buildCreateSessionParams({ bridge, content, clientId = "orch-watch", nowMs = Date.now(), commandId } = {}) {
  if (!bridge || !bridge.workspaceKey) throw Object.assign(new Error("bridge-context-missing"), { code: "shell-bad-args" });
  const ws = bridge.workspace || {};
  const workspacePath = typeof ws.workspacePath === "string" && ws.workspacePath ? ws.workspacePath : bridge.workspaceKey;
  const workspaceIdentity = typeof ws.workspaceIdentity === "string" && ws.workspaceIdentity.trim() ? ws.workspaceIdentity.trim() : undefined;
  return {
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    envelope: {
      commandId: commandId || uuidv7(nowMs),
      clientId,
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: workspaceIdentity || workspacePath, firstInput: { text: String(content ?? "") } },
      issuedAt: nowMs,
    },
  };
}

/**
 * 候选 2（replayable 手机语义，未定案备选）：zcode-task/sendPrompt 参数
 * {taskId,traceId,queryId,messageId,content,clientId,clientMode:"web-remote-replayable",…}
 * （zcodeTaskServiceAdapter.ts:2080-2102）。taskId/queryId watcher 侧无天然来源（DESIGN §4.5
 * 装配注记）——调用方显式供给；保留代码+离线断言，活体定案前不装配。
 */
export function buildSendPromptParams({ taskId, traceId = null, queryId = null, messageId = null, content, clientId = "orch-watch", clientMode = "web-remote-replayable" } = {}) {
  if (!taskId) throw Object.assign(new Error("task-id-missing"), { code: "shell-bad-args" });
  return { taskId: String(taskId), traceId, queryId, messageId, content: String(content ?? ""), clientId, clientMode };
}

/* G5/G8 传输终结接线（W3s 泄露补）：ChannelClient.dispose（fail-closed）此前无终止触发面
 * ——传输死而频道调用不拒，握手 promise 永挂（G5 注记「不 fail-closed 会令上层 in-flight
 * 去重 Promise 永挂」的实锤面；EXP-10 Txn1 同型）。registry 按 transport 恰包装一次：
 * 本地关（RelaySession.close→transport.close）与远端关（socket close/error→transport.onclose）
 * 双路都过 fire；fire 时 dispose 全部在册客户端（重桥场景新旧客户端各得其死，b2 自愈新桥
 * 新客户端同注册互不干扰）。transport 已死后再 attach → 立即 fail-closed（dispose 当场拒）。 */
const TRANSPORT_CLIENTS = new WeakMap();

function wireTransportDeath(transport, client) {
  if (!transport || typeof transport !== "object") return;
  let reg = TRANSPORT_CLIENTS.get(transport);
  if (!reg) {
    reg = { clients: new Set(), fired: false };
    TRANSPORT_CLIENTS.set(transport, reg);
    const fire = () => {
      if (reg.fired) return;
      reg.fired = true;
      for (const c of reg.clients) { try { c.dispose("relay-closed"); } catch { /* 已 dispose */ } }
      reg.clients.clear();
    };
    if (typeof transport.close === "function") {
      const prevClose = transport.close.bind(transport); // Relayed 关断路径（本地关）
      transport.close = (code, reason) => { fire(); try { prevClose(code, reason); } catch { /* 已断 */ } };
    }
    if (typeof transport.onclose === "function") {
      const prevOnClose = transport.onclose; // relay wireTransport 已挂的远端关路径
      transport.onclose = (info) => { fire(); try { prevOnClose(info); } catch { /* 上层异常不阻断 */ } };
    }
  }
  if (reg.fired) { try { client.dispose("relay-closed"); } catch { /* 已 dispose */ } }
  else reg.clients.add(client);
}

/**
 * 桥上频道客户端挂载：ChannelClient emit→RpcBridge.send（transport 面装帧+ack 等待），
 * RpcBridge 入站消息→client.feed（Initialize/响应消费）。每桥一实例（缓存于 bridge.client）。
 * G5 传输终结接线（W3s）：本桥客户端登记入 transport 终止 registry——桥死（本地关/远端关）
 * 即 dispose（排队+在飞频道调用全拒 ConnectionClosed），握手 promise 不再永挂。
 */
export function attachChannelClient(bridge) {
  if (!bridge || typeof bridge.send !== "function") throw Object.assign(new Error("bad-bridge"), { code: "shell-bad-args" });
  if (bridge.client) return bridge.client;
  let sendP = null; // call() 同步 emit 时捕获本次发送 promise（sendPrompt await 面）
  const client = new ChannelClient({
    // G8（W3s）起每次 sendPrompt 前置握手两帧：emit 多帧面下中间帧的发送 promise 会被后续
    // emit 覆盖而无人 await——此处对每条发送登记 rejection 已处理（消费方 await sendP 照常
    // 收拒因；被覆盖的中间帧不再悬空炸 unhandledRejection，noack/hold-cap 断连面实测）。
    emit: (bytes) => { sendP = bridge.send(bytes); sendP.catch(() => {}); },
  });
  const unsub = bridge.onRpcMessage((bytes) => { try { client.feed(bytes); } catch { /* 坏字节不阻断 */ } });
  wireTransportDeath(bridge.session && bridge.session.transport, client); // G5 终结接线（W3s）
  client.sendPromise = () => sendP; // 最近一次 call 的发送/ack promise（未发出=null）
  client.unsub = unsub; // 桥面退订（G5 起 ChannelClient.dispose=频道面 fail-closed，与桥退订分工；原 client.dispose 属性更名 unsub，无外部调用方）
  bridge.client = client;
  return client;
}

/**
 * 发送注入（v2）：候选 1 缺省装配 → G8 连接握手（每桥恰一次，任何命令前）→ ChannelClient.call
 * （Initialize 闸/请求 id 匹配）→ RpcBridge.send（04D-3 装帧+重放窗+await 对岸 ack，三证①）。
 * seq 参数保留兼容 watcher.mjs 旧签名但不再使用（transport 面计数归 RpcBridge 双计数器，
 * 频道面 id 归 ChannelClient，两套计数器不混用）。
 * 返回 {frames, messageSeq, ack, callP}；ack 超时/握手未决 throw {code:"rpc-ack-timeout"}、断连
 * throw {code:"relay-closed"}（调用方归类不变）；握手被拒（如 fault.connection.*）原样上抛且
 * 命令帧绝不发出；无 bridge（ready 前不发言）throw {code:"bridge-not-open"}。
 * 隐蔽面治理（Txn1，EXP10-findings R2-1）：callP 拒因留痕 client.lastRejection——无人 await
 * 时不再纯吞（watcher 生产路径不 await callP，Txn1 的 handshakeRequired 拒曾因此对 verdict
 * 不可见；连接层失败现已随握手 await 可见，命令层拒因留痕可观测）。
 */
export async function sendPrompt({
  session, seq, sessionId, content, bridge = null, ackTimeoutMs = 10000, kind = "sendText",
} = {}) {
  void seq; // 兼容占位：见上注
  const bRaw = bridge || bridgeOf(session);
  // 规范化：openBridge 返回面（{...,rpc}）与 RpcBridge 本体双形态都收
  const b = bRaw && typeof bRaw.send === "function" ? bRaw : bRaw && bRaw.rpc ? bRaw.rpc : bRaw;
  if (!b) throw Object.assign(new Error("bridge-not-open（时序闸：ready 前不发任何 rpc-frame）"), { code: "bridge-not-open" });
  const client = attachChannelClient(b);
  // G8 连接握手（W3s）：任何 zcode-agent 命令前 hello→initialize 两步，每桥恰一次（重连/重桥=
  // 新客户端=握手随新连接重来）；握手请求过 Initialize 闸排队，闸开方上槽（两层闸勿混淆）。
  await ensureChannelHandshake(client, { timeoutMs: ackTimeoutMs });
  // kind 面分派（G6）：sendText=b1 活体注入；createSession=b2 自愈新建会话（同频道同方法，
  // 仅 envelope 命令面不同——commandId 每次新造，频道请求 id 由 ChannelClient 自增）
  const params = kind === "createSession"
    ? buildCreateSessionParams({ bridge: b, content })
    : buildConversationCommandParams({ bridge: b, sessionId, content });
  // G9（R3-5）：service 频道位置参数组——b1/b2 同点，命令参数对象必须包进数组，
  // 否则对岸 apply(handler, args||[]) 按 0 参执行（命令 envelope 收 undefined）。
  const callP = client.call("zcode-agent", "sendConversationCommandV4", [params]);
  callP.catch((e) => { client.lastRejection = e; }); // 拒因留痕（隐蔽面治理，Txn1）+防 unhandledRejection
  // Initialize 闸已随握手开启：命令 call 同步上槽（sendPromise=最近一次 emit 的发送/ack promise）
  const sp = client.sendPromise();
  if (!sp) throw Object.assign(new Error("rpc-send-slot-missing（握手后命令未上槽）"), { code: "rpc-ack-timeout" });
  const { frames, messageSeq, ack } = await sp;
  return { frames, messageSeq, ack, callP };
}

/* ================= C11：coord-session 指针自愈（DESIGN §5 b1/b2） ================= */

/** b2 触发面（transport 层）：bridge-error reason ∈ 此表 → 新建会话重试恰一次。
 * CLI 层触发面（callP rejection/ack rejected）见 sessionErrorHit（G6 宽匹配，L4 §4.2-G6）。 */
export const SELF_HEAL_REASONS = ["session-not-found", "session-expired"];

/**
 * G6 触发面宽匹配（L4 §2.4/§4.2-G6，措辞保守）：CLI 会话过期的失败形状是 PromiseError
 * passthrough（message/code/name）或 ack rejected（reasonCode/message）——zcode 命令面无
 * reasonCode 枚举承诺（L4 §5-2 查无实锤），只做「session 相关字样」大小写不敏感宽匹配，
 * 不发明枚举；非 session 拒因（如 busy「A prompt is already running」）不命中不重试。
 */
export function sessionErrorHit(...parts) {
  const s = parts
    .filter((p) => p !== null && p !== undefined && p !== "")
    .map((p) => String(p))
    .join(" ")
    .toLowerCase();
  return s.includes("session");
}

/** 应答 → 活体会话 id 回读（shapes 未定案，OPEN-10.4：无 sessionId 字段→null→只建会话不刷新）。 */
export function resolveLiveSessionId(resp) {
  if (!resp || typeof resp !== "object") return null;
  const direct = resp.sessionId != null ? resp.sessionId
    : resp.result && resp.result.sessionId != null ? resp.result.sessionId
    : resp.data && resp.data.sessionId != null ? resp.data.sessionId
    : resp.envelope && resp.envelope.sessionId != null ? resp.envelope.sessionId
    : null;
  return typeof direct === "string" && direct ? direct : null;
}

/**
 * G5 b2 刷新守卫（防锚劫持，EXP10-findings R4 因果链）：createSession 应答若携带工作区键
 * （shapes 未承诺，四路宽读；缺省=null 不参与判定），用于核对新会话落在锚/提示工作区。
 * 不发明字段枚举：只认顶层/result/data/envelope 内的 workspaceKey|workspacePath 字符串。
 */
export function resolveResponseWorkspaceKey(resp) {
  if (!resp || typeof resp !== "object") return null;
  const bags = [resp, resp.result, resp.data, resp.envelope].filter((b) => b && typeof b === "object");
  for (const bag of bags) {
    for (const key of ["workspaceKey", "workspacePath"]) {
      if (typeof bag[key] === "string" && bag[key].trim()) return bag[key].trim();
    }
  }
  return null;
}

function atomicWriteFile(file, data, fsImpl) {
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  fsImpl.writeFileSync(tmp, data);
  fsImpl.renameSync(tmp, file); // 原子刷新（哨兵/唤醒双消费面同一事实源，DESIGN §5 语义对齐）
}

/**
 * wake 链（C11 双分支 + G6 触发面扩展）：b1 活体目标=零重写（指针本就正确）；b2 stale 目标
 * 双触发面——transport 面 openBridge bridge-error reason∈SELF_HEAL_REASONS（既有）；CLI 面
 * b1 应答窗内 callP rejection（PromiseError passthrough）或 ack rejected 字样命中 session
 * （sessionErrorHit 宽匹配）→ createSession+firstInput（kind="createSession"）重试恰一次 →
 * 以应答回读活体会话 id 原子刷新 coord-session.txt（best-effort 永不 fatal；应答无 sessionId
 * 字段时只建会话不刷新——OPEN-10.4）。非 session 拒因/超窗维持原行为不重试。
 * 返回 {attempts, selfHealed, sessionId, refreshed, ack, response}。
 */

/**
 * b1/b2 应答回读缺省窗（v0.10 G3，EXP10-findings R3-4/R3-7 实测）：createSession 冷启
 * 19.2s（MCP 池初始化主导）、warm 0.5-0.8s；旧缺省 2000ms 只覆盖 warm——冷启时 b2 ack
 * 在窗后到达 → resolveLiveSessionId=null → 刷新不落地。25000ms 对冷启实测值留 ~5.8s 裕量。
 * 两段式替代（先建会话不带 firstInput → 异步回读 sessionId → 再首发）需拆分命令面协议，
 * 改动面大于提值方案，不在微修波（R3-4 建议①取提值）。
 */
export const RESP_TIMEOUT_MS = 25000;

/** 默认告警出口（G5）：b2 刷新守卫拦截时落 stderr（watcher 侧另有 verdict/日志消费面——
 * 返回值 warnings 由调用方 emit；watch 进程未接时 stderr 仍可观测）。 */
function defaultWarn(line) {
  try { process.stderr.write(`[orch-watch] ${line}\n`); } catch { /* stderr 不可写不致命 */ }
}

/**
 * wake 链（C11 双分支 + G6 触发面扩展 + G5 工作区守卫/无锚 fail-loud）：
 *   - b1 活体目标=零重写（指针本就正确）；
 *   - 无 workspaceKeyHint 且未显式 allowLegacyFirst → throw workspace-anchor-missing（**生产缺省
 *     fail-loud**：R4 实锤无锚盲取 workspaces[0]→b2 错工作区建会话→回读刷新劫持 coord-session 锚；
 *     安全面优先于可用面——错误工作区注入比晚一拍的配置告警严重得多，故拒绝容错选择）；
 *   - b2 stale 目标双触发面（transport bridge-error∈SELF_HEAL_REASONS / CLI 面 sessionErrorHit）
 *     → createSession+firstInput 重试恰一次；
 *   - **G5 b2 刷新守卫**：仅当本次 createSession/handshake 桥打开的工作区与锚一致
 *     （workspaceHintMatched 或归一键相等），且应答未报告不同工作区时，才把回读的活体 id
 *     原子刷新进 coord-session.txt；否则保持原锚 + warnings（b2-refresh-blocked:*）落告警面。
 *     b1 活体目标零重写不变。
 * 返回 {attempts, selfHealed, sessionId, refreshed, workspaceVerified, warnings, ack, response}。
 */
export async function wakeCoordSession({
  session, coordSessionPath, content, workspaceKeyHint = null,
  fsImpl = fs, ackTimeoutMs = 10000, respTimeoutMs = RESP_TIMEOUT_MS, openTimeoutMs = 10000, listTimeoutMs = 10000,
  allowLegacyFirst = false, warn = defaultWarn,
} = {}) {
  const anchor = typeof workspaceKeyHint === "string" ? workspaceKeyHint.trim() : "";
  if (!anchor && !allowLegacyFirst) {
    // 生产缺省 fail-loud（见上）：在建立任何桥/发任何帧之前拒绝，避免把错工作区注入留给下游。
    throw Object.assign(
      new Error("workspace-anchor-missing: sentinel/coord-workspace.txt 缺失/为空，拒绝盲取 workspaces[0]（R4 锚劫持因果链）；请先由 /orch-resume 或 SessionStart 写入工作区锚"),
      { code: "workspace-anchor-missing" },
    );
  }
  let target = null;
  try { target = fsImpl.readFileSync(coordSessionPath, "utf8").trim() || null; } catch { target = null; }
  let attempts = 0;
  let sent = null;
  let selfHealed = false;
  let lastBridge = null;
  const attempt = async (sessionId, kind = "sendText") => {
    attempts++;
    const bridge = await openBridge({ session, workspaceKeyHint: anchor || null, allowLegacyFirst, listTimeoutMs, openTimeoutMs });
    lastBridge = bridge;
    return sendPrompt({ session, bridge, sessionId, content, ackTimeoutMs, kind });
  };
  let response = null;
  try {
    sent = await attempt(target);
  } catch (e) {
    if (!e || e.code !== "bridge-error" || !SELF_HEAL_REASONS.includes(e.reason)) throw e;
    sent = await attempt(null, "createSession"); // b2：createSession+firstInput（重试计入既有 cap=3/≥90s 护栏，DESIGN §5）
    selfHealed = true;
  }
  if (!selfHealed) {
    // b1 应答窗（G6 CLI 层触发面）：callP rejection 命中 session 字样（PromiseError
    // passthrough）或 ack rejected 命中（CommandAck status=rejected+reasonCode/message）
    // → b2 createSession；其余（busy/超窗/非 session 拒因）不重试，rejection 不刷新
    let resp1 = null;
    try { resp1 = await Promise.race([sent.callP, sleepMs(respTimeoutMs).then(() => null)]); } catch (e1) { resp1 = { __rejected: e1 }; }
    const callRejectHit = Boolean(resp1 && resp1.__rejected &&
      sessionErrorHit(resp1.__rejected.message, resp1.__rejected.code, resp1.__rejected.name));
    const ackRejectHit = Boolean(resp1 && !resp1.__rejected && typeof resp1 === "object" &&
      resp1.status === "rejected" && sessionErrorHit(resp1.reasonCode, resp1.message));
    if (callRejectHit || ackRejectHit) {
      sent = await attempt(null, "createSession");
      selfHealed = true;
    } else {
      response = resp1 && resp1.__rejected ? null : resp1; // rejection 但非 session 拒因：不重试不刷新
    }
  }
  if (selfHealed) {
    // b2 应答回读活体 id（createSession ack result.sessionId；响应窗短；超窗=null→不刷新）
    response = null;
    try { response = await Promise.race([sent.callP, sleepMs(respTimeoutMs).then(() => null)]); } catch { response = null; }
  }
  const liveId = resolveLiveSessionId(response);
  // G5 工作区守卫（防锚劫持）：判定面=本次桥打开的工作区是否锚定命中（workspaceHintMatched 或
  // 归一键相等）+ 应答未携带不同工作区。任一面不符=刷新拦截（保持原锚），warning 落告警面。
  let workspaceVerified = false;
  const warnings = [];
  if (selfHealed) {
    const bridgeWs = lastBridge && lastBridge.workspaceKey;
    const respWs = resolveResponseWorkspaceKey(response);
    const bridgeOk = Boolean(lastBridge && (lastBridge.workspaceHintMatched === true || workspaceKeyMatches(bridgeWs, anchor)));
    const respOk = !respWs || workspaceKeyMatches(respWs, anchor) ||
      Boolean(lastBridge && lastBridge.workspace && [lastBridge.workspace.workspacePath, lastBridge.workspace.workspaceIdentity]
        .some((v) => workspaceKeyMatches(v, respWs)));
    if (!anchor) warnings.push("b2-refresh-blocked:no-workspace-anchor");
    else if (!respOk) warnings.push(`b2-refresh-blocked:response-workspace-mismatch(${respWs}!=${anchor})`);
    else if (!bridgeOk) warnings.push(`b2-refresh-blocked:bridge-workspace-mismatch(${bridgeWs || "(none)"}!=${anchor})`);
    else workspaceVerified = true;
    for (const w of warnings) { try { warn(w); } catch { /* 告警面失败不阻断 */ } }
  }
  let refreshed = false;
  if (selfHealed && liveId && coordSessionPath && workspaceVerified) {
    try {
      fsImpl.mkdirSync(path.dirname(coordSessionPath), { recursive: true });
      atomicWriteFile(coordSessionPath, liveId + "\n", fsImpl);
      refreshed = true;
    } catch { /* best-effort 永不 fatal */ }
  }
  return { attempts, selfHealed, sessionId: liveId, refreshed, workspaceVerified, warnings, ack: sent.ack, response };
}
