/*!
 * watcher/bridge.mjs —— BRIDGE 桥接（L2 编排）+ rpc-frame 04D-3 编解码（v0.10 W3 wake 链）
 *
 * 04D-3 全 schema（v0.9-L2 findings §7，上游 web-remote-control-rpc-transport.ts 对拍）：
 *   - L1 信封 {type:"data", payload:frame|ack} .strict()——rpc 帧整体装 data.payload 内层，
 *     顶层 type 只有 auth_init/pair_status_query/data 白名单（W-REG-03 同轴）。
 *   - 帧字段：zcode_type:"rpc-frame" / bridgeSessionId（id：≤256 ∧ ^[A-Za-z0-9._~-]+$）/
 *     bridgeGeneration? int≥0 / recoveryId? / seq（物理帧序，从 1 逐帧 +1）/ messageSeq（逻辑
 *     消息序，从 1 逐消息 +1）/ fragmentIndex（0-based ≤63）/ fragmentCount（1..64 且 ≤
 *     messageBytes）/ messageBytes（整消息字节数，每片携带）/ checksum:{algorithm:"crc32",
 *     value:8 位小写 hex}（0xEDB88320 反射，算法与 V1 同一只换编码）/ dataBase64（canonical，
 *     Node Buffer.toString("base64") 天然 canonical）。**无 sentAt**（.strict() 下多余键=直接拒）。
 *   - ack 帧：{zcode_type:"rpc-frame-ack", ...identity, ackMessageSeq}——组装 complete 后对端
 *     回发；发送方收 ack 释放重放窗（生死项：不 ack→对岸 replay buffer 涨满→terminal degraded
 *     replayBufferExceeded→bridge-degraded 桥灭，acknowledgedRelayProtocol.ts:150-157/176-180）。
 *   - LIMITS 数值与上游完全一致（1MiB/16MiB/64 片/30s/256 字符），仅形状漂移（L2 §7.0.2）。
 *
 * bridgeSessionId 终端自造（L2 §7.1：桌面不生成、只回显与绑定）：每次 openBridge 新造
 * `${reqIdBase}-${Date.now().toString(36)}-${randomBytes(6).hex}`，regex/限长恒满足；rpc 帧
 * identity 三元组与 ready 逐字段相等（assembler sameIdentity 含 undefined 精确比对）。
 *
 * error 快路径（DESIGN §4.1.3）：L2 图纸原案改 relay.mjs request() L2R 表；W3 scope 冻结
 * relay.mjs（W8 面）→ 实现落 bridge 层 sessionTap（transport.onmessage 旁路探针）：relay data
 * 分支把非 pendingReq 帧计噪声后吞掉（订阅面 on() 看不到 data 内层），tap 是冻结面内唯一
 * data 可见面。workspace-bridge-error/app-error 即时 reject，不白等 10s。
 *
 * 完整接收方语义（双序连续性/canonical/duplicate 指纹四类闸）v0 不做——EXP-10 场景 watcher
 * 是纯发送方（DESIGN §4.3），decode 只补 ack 消费面所需（identity 三元组+checksum+分片连续），
 * 完整语义挂 0.11+（DESIGN §11）。
 * 零 npm 依赖；node >= 20。
 */
import { randomBytes } from "node:crypto";
import { RelaySession } from "./relay.mjs"; // 类型锚 + instanceof 闸；运行时零依赖

export const LIMITS = {
  fragmentMax: 1048576,     // 1MiB/帧（maxPhysicalFrameBytes）
  msgMax: 16777216,         // 16MiB/消息（maxMessageBytes）
  maxFragments: 64,         // 64 片
  assembleTimeoutMs: 30000, // 30s 组装闸（上游 assembler 值；watcher 同步 decode 不用）
  maxIdChars: 256,          // transportId 上限
  highWaterMarkBytes: 8388608,    // 8MiB 重放窗高水位（saturated 面；上游值未考古，EXP-10 校准）
  replayBufferMaxBytes: 16777216, // 16MiB 重放窗顶（超=terminal degraded replayBufferExceeded）
};

/** transportId 规则（validation.ts:79-81 同式）：非空 ≤256 ∧ 限定字符集。 */
export const TRANSPORT_ID_RE = /^[A-Za-z0-9._~-]+$/;
export function transportIdOk(s) {
  return typeof s === "string" && s.length >= 1 && s.length <= LIMITS.maxIdChars && TRANSPORT_ID_RE.test(s);
}

/* --- crc32 IEEE 反射（标准多项式 0xEDB88320；wire-binary.ts:10-19 同一算法） --- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 04D-3 checksum 编码：uint32 → 8 位小写 hex 补零（wire-binary.ts:10-19 输出面）。 */
export function checksumHex(buf) {
  return crc32(buf).toString(16).padStart(8, "0");
}

/** workspace-bridge-error reason 枚举 11 值（validation.ts:117-129 failureReason 全集）。 */
export const BRIDGE_FAILURE_REASONS = [
  "session-not-found", "session-expired", "session-conflict", "workspace-closed",
  "desktop-disconnected", "invalid-mobile-connection", "desktop-bootstrap-timeout",
  "connection-recovery-timeout", "relay-unavailable", "unsupported-action", "unexpected-error",
];

/** reason → {name, cls}（watcher 侧降级面对齐 mapClose 语义：D3 配置/会话失效面、
 * D2 瞬时、kicked 冲突族；session-expired 同 close-4011 归 D2 重试面）。 */
export function mapBridgeFailure(reason) {
  switch (reason) {
    case "session-not-found": return { name: reason, cls: "D3" };
    case "session-expired": return { name: reason, cls: "D2" };
    case "session-conflict": return { name: reason, cls: "kicked" };
    case "workspace-closed": return { name: reason, cls: "D3" };
    case "desktop-disconnected": return { name: reason, cls: "D2" };
    case "invalid-mobile-connection": return { name: reason, cls: "D1" };
    case "desktop-bootstrap-timeout": return { name: reason, cls: "D2" };
    case "connection-recovery-timeout": return { name: reason, cls: "D2" };
    case "relay-unavailable": return { name: reason, cls: "D2" };
    case "unsupported-action": return { name: reason, cls: "D3" };
    case "unexpected-error": return { name: reason, cls: "D2" };
    default: return { name: String(reason || "unknown"), cls: "D2" };
  }
}

/**
 * 单片解码字节预算：上游按「外壳精确计量+二分」保证整封 ≤maxPhysicalFrameBytes
 * （rpc-transport.ts:316-345）；watcher 取保守固定预算——(1MiB − 信封固定字节余量 512B)
 * 折算 base64 4/3 膨胀，单片解码字节恒低于 1MiB 帽。
 */
export const FRAGMENT_BUDGET_BYTES = Math.floor(((LIMITS.fragmentMax - 512) * 3) / 4);

const err = (msg, code, extra = {}) => Object.assign(new Error(msg), { code, ...extra });

/**
 * 单帧编码（04D-3，纯函数；分片编排归 RpcBridge.send）。data=本片字节 Buffer。
 * 返回 L1 信封 {type:"data", payload:frame}；校验不过 throw {code:"frame-*"}。
 */
export function encodeRpcFrame({
  bridgeSessionId, bridgeGeneration, recoveryId,
  data, physicalSeq, messageSeq,
  fragmentIndex = 0, fragmentCount = 1, messageBytes,
} = {}) {
  if (!transportIdOk(bridgeSessionId)) {
    if (typeof bridgeSessionId === "string" && bridgeSessionId.length > LIMITS.maxIdChars) throw err("id-too-long", "frame-id-too-long");
    throw err("id-shape", "frame-id-shape");
  }
  if (!Number.isSafeInteger(physicalSeq) || physicalSeq < 1) throw err("seq-invalid", "frame-seq-invalid");
  if (!Number.isSafeInteger(messageSeq) || messageSeq < 1) throw err("seq-invalid", "frame-seq-invalid");
  if (!Buffer.isBuffer(data) || data.length < 1) throw err("empty-message", "frame-empty-message");
  if (data.length > FRAGMENT_BUDGET_BYTES) throw err("fragment-too-large", "frame-fragment-too-large");
  const mb = messageBytes ?? data.length; // 整消息字节数，每片携带
  if (!Number.isSafeInteger(mb) || mb < 1 || mb > LIMITS.msgMax) throw err("msg-too-large", "frame-msg-too-large");
  if (!Number.isSafeInteger(fragmentIndex) || fragmentIndex < 0 || fragmentIndex >= LIMITS.maxFragments) throw err("fragment-index", "frame-fragment-index");
  if (!Number.isSafeInteger(fragmentCount) || fragmentCount < 1 || fragmentCount > LIMITS.maxFragments || fragmentCount > mb) throw err("fragment-count", "frame-fragment-count");
  if (fragmentIndex >= fragmentCount) throw err("fragment-index", "frame-fragment-index");
  const payload = {
    zcode_type: "rpc-frame",
    bridgeSessionId,
    seq: physicalSeq,
    messageSeq,
    fragmentIndex,
    fragmentCount,
    messageBytes: mb,
    checksum: { algorithm: "crc32", value: checksumHex(data) },
    dataBase64: data.toString("base64"), // Node 输出恒 canonical（L2 §7.3 判定列）
  };
  if (bridgeGeneration !== undefined && bridgeGeneration !== null) payload.bridgeGeneration = bridgeGeneration;
  if (recoveryId !== undefined && recoveryId !== null && recoveryId !== "") payload.recoveryId = recoveryId;
  return { type: "data", payload };
}

/**
 * 帧数组 → 重装消息字节（最小接收面：identity 三元组解析 + 逐片 checksum + 分片连续；
 * 完整四类闸 v0.11+）。入参元素可为 L1 信封（自动解 payload）或裸 payload 帧。
 * 返回 {ok, identity:{bridgeSessionId,bridgeGeneration,recoveryId}, seq, messageSeq, bytes}；
 * 校验不过 → {ok:false, error}。
 */
export function decodeRpcFrames(frames) {
  try {
    if (!Array.isArray(frames) || !frames.length) return { ok: false, error: "no-frames" };
    if (frames.length > LIMITS.maxFragments) return { ok: false, error: "too-many-fragments" };
    const unwrap = (f) => (f && f.type === "data" && f.payload && typeof f.payload === "object" ? f.payload : f);
    const sorted = frames.map(unwrap).sort((a, b) => (a.fragmentIndex ?? 0) - (b.fragmentIndex ?? 0));
    for (let i = 0; i < sorted.length; i++) {
      const f = sorted[i];
      if ((f.fragmentIndex ?? i) !== i) return { ok: false, error: "fragment-gap" };
      if (typeof f.dataBase64 !== "string") return { ok: false, error: "missing-data" };
      const raw = Buffer.from(f.dataBase64, "base64");
      if (raw.length === 0 || raw.length > LIMITS.fragmentMax) return { ok: false, error: "fragment-too-large" };
      const cks = f.checksum;
      if (!cks || cks.algorithm !== "crc32" || !/^[0-9a-f]{8}$/.test(String(cks.value))) return { ok: false, error: "checksum-shape" };
      if (cks.value !== checksumHex(raw)) return { ok: false, error: "checksum-mismatch" };
    }
    const id0 = sorted[0].bridgeSessionId;
    if (!transportIdOk(id0)) return { ok: false, error: "bad-identity" };
    const identity = { bridgeSessionId: id0, bridgeGeneration: sorted[0].bridgeGeneration, recoveryId: sorted[0].recoveryId };
    for (const f of sorted) {
      if (f.bridgeSessionId !== id0 || f.bridgeGeneration !== identity.bridgeGeneration || f.recoveryId !== identity.recoveryId) {
        return { ok: false, error: "identity-mismatch" };
      }
    }
    const mb = sorted[0].messageBytes;
    for (const f of sorted) if (f.messageBytes !== mb || f.messageSeq !== sorted[0].messageSeq) return { ok: false, error: "metadata-mismatch" };
    const bytes = Buffer.concat(sorted.map((f) => Buffer.from(f.dataBase64, "base64")));
    if (bytes.length > LIMITS.msgMax) return { ok: false, error: "msg-too-large" };
    return { ok: true, identity, seq: sorted[0].seq, messageSeq: sorted[0].messageSeq, bytes };
  } catch (e) {
    return { ok: false, error: "decode:" + ((e && e.message) || "unknown") };
  }
}

function sameIdentity(a, b) {
  return a.bridgeSessionId === b.bridgeSessionId
    && (a.bridgeGeneration ?? undefined) === (b.bridgeGeneration ?? undefined)
    && (a.recoveryId ?? undefined) === (b.recoveryId ?? undefined);
}

/* --- sessionTap：冻结 relay.mjs 面内的 data 内层唯一可见通道（见文件头注记） --- */
const TAPS = new WeakMap();
export function sessionTap(session) {
  let tap = TAPS.get(session);
  if (tap) return tap;
  const transport = session && session.transport;
  if (!transport || typeof transport.onmessage !== "function") throw err("tap-no-transport", "tap-no-transport");
  const prev = transport.onmessage;
  const subs = new Set();
  transport.onmessage = (data) => {
    try {
      const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      const msg = JSON.parse(text);
      if (msg && msg.type === "data" && msg.payload && typeof msg.payload === "object") {
        for (const fn of subs) { try { fn(msg.payload, msg); } catch { /* 订阅者异常不阻断 */ } }
      }
    } catch { /* 非 JSON——原样交回 relay */ }
    prev(data); // relay #dispatch 照常：匹配 pendingReq 或计噪声
  };
  tap = {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    dispose() { try { transport.onmessage = prev; } catch { /* 已断 */ } TAPS.delete(session); },
  };
  TAPS.set(session, tap);
  return tap;
}

/* --- RpcBridge：per-bridge 会话态（identity 三元组 + 双计数器 + 重放窗/ack 回程） --- */
const BRIDGES = new WeakMap();
export function bridgeOf(session) { return (session && BRIDGES.get(session)) || null; }

export class RpcBridge {
  constructor({
    session, tap, identity, workspaceKey = null, workspace = null,
    highWaterMarkBytes = LIMITS.highWaterMarkBytes, replayBufferMaxBytes = LIMITS.replayBufferMaxBytes,
  } = {}) {
    if (!identity || !transportIdOk(identity.bridgeSessionId)) throw err("bad-identity", "bridge-bad-identity");
    this.session = session;
    this.identity = { bridgeSessionId: identity.bridgeSessionId, bridgeGeneration: identity.bridgeGeneration, recoveryId: identity.recoveryId };
    this.workspaceKey = workspaceKey;
    this.workspace = workspace; // workspace-list 选中项（候选 1 参数 workspacePath/workspaceIdentity 来源）
    this.physicalSeq = 1;       // 双计数器 per-bridge：每片 +1（L2 §7.4 L2-b.2）
    this.messageSeq = 1;        //                 每消息 +1
    this.replay = new Map();    // messageSeq → {bytes, resolve}
    this.replayBytes = 0;
    this.saturated = false;     // >highWaterMark（背压标记）
    this.degraded = null;       // >replayBufferMax → {reason:"replayBufferExceeded", ...}（terminal）
    this.client = null;         // attachChannelClient（inject 层）挂载点
    this.#msgSubs = new Set();
    this.#unsub = tap.subscribe((payload) => this.#onPayload(payload));
  }

  #msgSubs;
  #unsub;
  #msgQueue = [];        // 订阅者挂载前的入站消息缓冲（Initialize 可早于 ChannelClient attach 到达）
  static #MSG_QUEUE_MAX = 64;

  /** 入站 rpc 消息字节订阅（ChannelClient feed 面）；挂载即冲刷缓冲。返回退订函数。 */
  onRpcMessage(fn) {
    this.#msgSubs.add(fn);
    const q = this.#msgQueue.splice(0);
    for (const bytes of q) { try { fn(bytes); } catch { /* 订阅者异常不阻断 */ } }
    return () => this.#msgSubs.delete(fn);
  }

  #onPayload(payload) {
    const zt = payload && payload.zcode_type;
    if (zt === "rpc-frame-ack") return this.#processAck(payload);
    if (zt === "rpc-frame") {
      const dec = decodeRpcFrames([payload]);
      if (!dec.ok) return; // 最小面：解析败/片缺失丢弃（完整闸 v0.11+，DESIGN §4.2）
      if (!sameIdentity(dec.identity, this.identity)) return; // foreign identity 非终端，丢弃即可
      if (this.#msgSubs.size) {
        for (const fn of this.#msgSubs) { try { fn(dec.bytes, dec); } catch { /* 订阅者异常不阻断 */ } }
      } else {
        this.#msgQueue.push(dec.bytes); // 早到消息（Initialize 等）缓冲待挂载
        if (this.#msgQueue.length > RpcBridge.#MSG_QUEUE_MAX) this.#msgQueue.shift();
      }
      return;
    }
    if (zt === "bridge-degraded" && !this.degraded) {
      this.degraded = { reason: payload.reason || "bridge-degraded", expectedSeq: payload.expectedSeq, droppedCount: payload.droppedCount };
    }
  }

  /** 收对岸 ack：释放重放窗（重复/迟到 ack 幂等忽略，对岸 duplicate-ack 语义对齐）。 */
  #processAck(payload) {
    const seq = payload && payload.ackMessageSeq;
    const entry = this.replay.get(seq);
    if (!entry) return;
    this.replay.delete(seq);
    this.replayBytes = Math.max(0, this.replayBytes - entry.bytes);
    if (this.replayBytes <= this.highWaterMarkBytes) this.saturated = false;
    try { entry.resolve(payload); } catch { /* 已断 */ }
  }

  /**
   * 发送一条消息（自动分片）：双计数器推进，入重放窗，await 对岸 ack。
   * 返回 {frames, messageSeq, physicalSeqFirst, ack}；ack 超时/断连经 relay awaitAck 载体
   * reject（rpc-ack-timeout / relay-closed——与 V1 注入面同一失败码族，watcher.mjs 映射不变）。
   */
  async send(bytes, { ackTimeoutMs = 10000 } = {}) {
    if (this.degraded) throw err("bridge-degraded", "bridge-degraded", { reason: this.degraded.reason });
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (buf.length < 1) throw err("empty-message", "frame-empty-message");
    if (buf.length > LIMITS.msgMax) throw err("msg-too-large", "frame-msg-too-large");
    const count = Math.max(1, Math.ceil(buf.length / FRAGMENT_BUDGET_BYTES));
    if (count > LIMITS.maxFragments) throw err("msg-too-large", "frame-msg-too-large");
    // 重放窗记账（先记账后查顶：本消息字节计入 unacknowledged 面再判饱和/终态）
    this.replayBytes += buf.length;
    if (this.replayBytes > this.replayBufferMaxBytes) {
      this.replayBytes -= buf.length;
      this.degraded = { reason: "replayBufferExceeded", unacknowledgedBytes: this.replayBytes + buf.length };
      throw err("replay-buffer-exceeded", "bridge-degraded", { reason: "replayBufferExceeded" });
    }
    if (this.replayBytes > this.highWaterMarkBytes) this.saturated = true;
    const messageSeq = this.messageSeq++;
    let resolveAck;
    const ackP = new Promise((resolve) => { resolveAck = resolve; });
    this.replay.set(messageSeq, { bytes: buf.length, resolve: resolveAck });
    // close/超时失败面载体：relay.awaitAck 永不匹配 04D-3 data 信封 ack，但 close（relay-closed）
    // 与超时（rpc-ack-timeout）两路 reject 与 V1 注入面同码族；ack 快路径由本类 ackP 承担。
    const legacyAckP = this.session.awaitAck(this.physicalSeq, ackTimeoutMs);
    legacyAckP.catch(() => {}); // 输者拒绝兜面（ack 先到时防 unhandledRejection）
    const physicalSeqFirst = this.physicalSeq;
    const frames = [];
    for (let i = 0; i < count; i++) {
      frames.push(encodeRpcFrame({
        ...this.identity,
        data: buf.subarray(i * FRAGMENT_BUDGET_BYTES, (i + 1) * FRAGMENT_BUDGET_BYTES),
        physicalSeq: this.physicalSeq++,
        messageSeq,
        fragmentIndex: i,
        fragmentCount: count,
        messageBytes: buf.length,
      }));
    }
    for (const f of frames) this.session.send(f);
    const ack = await Promise.race([ackP, legacyAckP]);
    return { frames, messageSeq, physicalSeqFirst, ack };
  }

  dispose() { try { this.#unsub(); } catch { /* 已断 */ } }
}

/* --- G10/G5 工作区键归一比较（互信根匹配面，v0.10 G5） -----------------------
 * 锚文件的值有三个可能来源：server/SessionStart 的 path.resolve(projectDir)（Windows 反斜杠）、
 * 桌面 workspace-list 的 workspacePath（可能是正斜杠/尾斜杠/大小写不同）、或 workspaceIdentity
 * （非路径标识）。三者都指同一工作区时不应因字面形态差异判成 mismatch（否则 fail-loud 会把
 * 正常配置判死）。归一：去首尾空白、反斜杠→正斜杠、去尾部斜杠；盘符形态（Windows 路径）大小写
 * 不敏感，其余保持大小写敏感（POSIX 语义）。
 */
export function normalizeWorkspaceKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const forward = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!forward) return null;
  return /^[A-Za-z]:\//.test(forward) ? forward.toLowerCase() : forward;
}

/** 两键是否同一工作区（归一比较；任一侧空 → false）。 */
export function workspaceKeyMatches(a, b) {
  const na = normalizeWorkspaceKey(a);
  const nb = normalizeWorkspaceKey(b);
  return Boolean(na && nb && na === nb);
}

/** workspace-list 项对 hint 的匹配判定（派生键/workspacePath/workspaceIdentity 三面任一命中）。
 * G5：允许 path 形态锚命中带 workspaceIdentity 的项（server/SessionStart 无 identity 面）。
 * 项级派生键与 openBridge 的 resolveKey 同口径（workspaceIdentity.trim() || workspacePath）。 */
export function workspaceItemMatchesHint(item, hint) {
  if (!item || typeof item !== "object") return false;
  const identity = typeof item.workspaceIdentity === "string" && item.workspaceIdentity.trim()
    ? item.workspaceIdentity.trim()
    : null;
  const derived = identity || (typeof item.workspacePath === "string" ? item.workspacePath : null);
  return [derived, item.workspacePath, identity].some((v) => workspaceKeyMatches(v, hint));
}

/**
 * 步骤 4：L2 桥接编排（04D-3 深形）。session = RelaySession（connectRelay 产物）。
 * 流程：workspace-list-request（request/L2R 面，list 无 error 快路径要求）→ payload 内层
 * result 取 workspaceKey（派生消费不变）→ workspace-bridge-open（bridgeSessionId 终端自造）
 * → ready|error|app-error（tap 快路径即时分辨，不白等超时）。
 * 返回 {workspaceKey, workspaceHintMatched, bridgeSessionId, initialTaskId, bridgeGeneration,
 * recoveryId, bridge, rpc:RpcBridge}；bridge 实例同时登记 BRIDGES（inject.sendPrompt 经
 * bridgeOf 取用——时序闸：ready 前不发任何 rpc-frame，无 bridge 即拒发，W-INJ2-02）。
 * 超时/空列表/error throw {code:"bridge-*"|"bridge-error"|"bridge-app-error"}。
 *
 * G10/G5 工作区锚（发版门阻断修复，EXP10-findings R4 三方实锤）：
 *   - 有 hint：按三面归一匹配；**未命中→throw bridge-anchor-mismatch，绝不回退 workspaces[0]**
 *     （R4 因果链：hint 缺失→盲取[0]→跨工作区 b1→b2 在错工作区建会话→回读刷新劫持
 *     coord-session 锚。锚指向的工作区消失是配置事件，不是「换一个工作区发」的理由）。
 *   - 无 hint：缺省 **throw bridge-anchor-missing**（文案提示预置 sentinel/coord-workspace.txt /
 *     /orch-resume / SessionStart 自动写入），禁止盲取 workspaces[0]——桌面 workspace 列表顺序
 *     在 R2/R3/R4 三次观测三个取值（漂移无单调性），[0] 不可作为信任根。
 *   - allowLegacyFirst:true 是**离线断言/探针逃生口**（显式声明风险；生产 watcher 永不传）。
 *     该模式下无 hint 取 workspaces[0]（v0.10 G3 前 legacy 行为），调用方须自行承担错工作区语义。
 */
export async function openBridge({
  session, workspaceKeyHint = null, allowLegacyFirst = false,
  listTimeoutMs = 10000, openTimeoutMs = 10000, reqIdBase = "ow",
} = {}) {
  if (!(session instanceof RelaySession)) throw err("bad-session", "bridge-bad-session");
  const tap = sessionTap(session);
  const reqId = `${reqIdBase}-${Date.now().toString(36)}`;
  // workspace-list → 取 workspaceKey（G10/G5：有 hint 归一匹配锚定；无 hint/未命中=fail-loud，见函数头注）
  const list = await session.request({ type: "data", payload: { zcode_type: "workspace-list-request", requestId: reqId } }, { timeoutMs: listTimeoutMs });
  const result = list && list.result;
  const workspaces = Array.isArray(result && result.workspaces) ? result.workspaces : [];
  if (!workspaces.length) throw err("workspace-list-empty", "bridge-list-empty");
  // workspaceKey 派生消费（上游 resolveWebRemoteControlWorkspaceKey 语义，web-remote-control.ts:744-748：
  // workspaceIdentity?.trim() || workspacePath；WorkspaceTarget 项无 workspaceKey 字段）
  const resolveKey = (w) => (w && (typeof w.workspaceIdentity === "string" && w.workspaceIdentity.trim() ? w.workspaceIdentity.trim() : w.workspacePath)) || null;
  // G10/G5 工作区锚（见函数头注）：hint 命中=显式锚定（生产 watcher 从 sentinel/coord-workspace.txt
  // 读取）；未命中 fail-loud（不回退）；无 hint 缺省 fail-loud（allowLegacyFirst 才走 legacy [0]）。
  const hint = typeof workspaceKeyHint === "string" ? workspaceKeyHint.trim() : "";
  const candidateKeys = workspaces.map((w) => resolveKey(w)).filter((k) => typeof k === "string" && k);
  let hintMatch = null;
  if (hint) {
    hintMatch = workspaces.find((w) => workspaceItemMatchesHint(w, hint)) || null;
    if (!hintMatch) {
      throw err(
        `bridge-anchor-mismatch: 工作区锚 "${hint}" 不在桌面 workspace-list（候选=[${candidateKeys.join(", ")}]）；` +
          "拒绝回退 workspaces[0]（R4 锚劫持面：错工作区注入→b2 建会话→coord-session 被改写的已实证最坏结果）。" +
          "请确认锚指向的工作区已在桌面打开，或删除 sentinel/coord-workspace.txt 后由 /orch-resume / SessionStart 重写。",
        "bridge-anchor-mismatch",
        { anchor: hint, candidates: candidateKeys },
      );
    }
  } else if (!allowLegacyFirst) {
    throw err(
      "no-workspace-anchor: sentinel/coord-workspace.txt 缺失/为空，拒绝盲取 workspaces[0]（桌面工作区顺序会漂移，R4 已实证错工作区注入+锚劫持）。" +
        "请先由 /orch-resume 或 SessionStart 写入工作区锚；仅离线断言/探针可显式传 allowLegacyFirst:true。",
      "bridge-anchor-missing",
      { candidates: candidateKeys },
    );
  }
  const picked = hintMatch || workspaces[0];
  const workspaceKey = resolveKey(picked) || (result && typeof result.activeWorkspaceKey === "string" ? result.activeWorkspaceKey : null);
  if (typeof workspaceKey !== "string" || !workspaceKey) throw err("workspace-key-missing", "bridge-key-missing");
  // bridgeSessionId 终端自造（L2 §7.1：桌面不生成只回显绑定；每次 openBridge 新造）
  const bridgeSessionId = `${reqIdBase}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  if (!transportIdOk(bridgeSessionId)) throw err("bridge-id-shape", "bridge-id-shape"); // 构造恒过；防御自检
  // open → ready|error|app-error（tap 快路径；requestId 缺省帧按匹配收——上游 app-error requestId optional）。
  // 桌面在 open→ready 期间已建 assembler（identity=请求三元组，manager:1166-1174 ready 前不开闸）——
  // watcher 同构：RpcBridge 先于 open 发送创建（identity=请求三元组），ready 后按透传修订；时序闸保证
  // ready 前零帧发送，修订无竞态。Initialize 等早到入站帧经 RpcBridge 消息缓冲待 ChannelClient 挂载。
  const prevBridge = BRIDGES.get(session);
  if (prevBridge && typeof prevBridge.dispose === "function") prevBridge.dispose(); // 重开（b2 自愈）顶替旧桥
  const rpc = new RpcBridge({ session, tap, identity: { bridgeSessionId }, workspaceKey, workspace: picked });
  BRIDGES.set(session, rpc);
  const abortOpen = (e) => { rpc.dispose(); BRIDGES.delete(session); throw e; }; // open 败=桥未成立（无状态残留）
  const ready = await new Promise((resolve, reject) => {
    const unsubs = [];
    const timer = setTimeout(() => { for (const u of unsubs) u(); reject(err("bridge-ready-timeout", "bridge-ready-timeout")); }, openTimeoutMs);
    const done = (fn) => { clearTimeout(timer); for (const u of unsubs) u(); fn(); };
    unsubs.push(tap.subscribe((payload) => {
      if (!payload || (payload.requestId != null && payload.requestId !== reqId)) return;
      const zt = payload.zcode_type;
      if (zt === "workspace-bridge-ready") done(() => resolve(payload));
      else if (zt === "workspace-bridge-error") done(() => reject(err("bridge-error:" + String(payload.reason), "bridge-error", { reason: payload.reason, bridgeMessage: payload.error, face: mapBridgeFailure(payload.reason) })));
      else if (zt === "app-error") done(() => reject(err("bridge-app-error", "bridge-app-error", { bridgeMessage: typeof payload.error === "string" ? payload.error : (payload.error && payload.error.message) })));
    }));
    session.send({ type: "data", payload: { zcode_type: "workspace-bridge-open", requestId: reqId, bridgeSessionId, workspaceKey } });
  }).catch((e) => abortOpen(e));
  // ready 深消费：顶层 bridgeSessionId=回显校验；bridge 对象 discriminatedUnion local/remote
  // （validation.ts:131-154）——initialTaskId 只在 bridge.initialTaskId（顶层无此字段）
  if (typeof ready.bridgeSessionId === "string" && ready.bridgeSessionId !== bridgeSessionId) {
    throw err("bridge-echo-mismatch", "bridge-echo-mismatch");
  }
  const bridgeObj = ready.bridge && typeof ready.bridge === "object" ? ready.bridge : null;
  const initialTaskId = bridgeObj && typeof bridgeObj.initialTaskId === "string" ? bridgeObj.initialTaskId : null;
  const bridgeGeneration = ready.bridgeGeneration !== undefined ? ready.bridgeGeneration : (bridgeObj && bridgeObj.bridgeGeneration);
  const recoveryId = ready.recoveryId !== undefined ? ready.recoveryId : (bridgeObj && bridgeObj.recoveryId);
  // identity 三元组与 ready 逐字段相等（undefined 精确比对；帧上仅非空才携带）
  rpc.identity = {
    bridgeSessionId,
    bridgeGeneration: bridgeGeneration === undefined ? undefined : bridgeGeneration,
    recoveryId: recoveryId === undefined ? undefined : recoveryId,
  };
  return {
    workspaceKey,
    workspaceHintMatched: Boolean(hintMatch), // G10：hint 是否真实命中（未传/未命中=false）
    bridgeSessionId,
    initialTaskId,
    bridgeGeneration: rpc.identity.bridgeGeneration ?? null,
    recoveryId: rpc.identity.recoveryId ?? null,
    bridge: bridgeObj,
    rpc,
  };
}
