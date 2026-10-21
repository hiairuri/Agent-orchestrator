/*!
 * watcher/bridge.mjs —— BRIDGE 桥接（L2 编排）+ rpc-frame 编解码（W-W §3 步骤 4/5）
 *
 * 帧常量定案（W-F3 §2.4，无需运行时探测）：单帧 ≤1MiB、消息 ≤16MiB、≤64 分片、
 * 30s 组装闸、id ≤256 字符——模板壳远低于限值，单帧即达（W-W §3 步骤 5）。
 * checksum=crc32 IEEE 反射；dataBase64 承载 reassembled JSON（method=session/send）。
 *
 * L2 流程：workspace-list-request → response 取 workspaceKey → workspace-bridge-open
 * → ready 取 bridgeSessionId/initialTaskId。消息形状按 W-W §3 表实现，活体集成阶段
 * 如与实测出入以实弹修订本文件 SHAPES 注释为准（W-W §11.5 同纪律）。
 * 零 npm 依赖；node >= 20。
 */
import { RelaySession } from "./relay.mjs"; // 仅类型锚（request/awaitAck 挂在 session 上）；运行时零依赖

export const LIMITS = {
  fragmentMax: 1048576,    // 1MiB/帧
  msgMax: 16777216,        // 16MiB/消息
  maxFragments: 64,        // 64 片
  assembleTimeoutMs: 30000, // 30s 组装闸
  maxIdChars: 256,         // identity/req_id 上限
};

/* --- crc32 IEEE 反射（标准多项式 0xEDB88320） --- */
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

/** dataObj → rpc-frame 帧数组（单帧为主；超限才分片，二分由调用方预算）。 */
export function encodeRpcFrame({ identity, seq, dataObj, nowMs = Date.now() } = {}) {
  const idStr = String(identity ?? "");
  if (idStr.length > LIMITS.maxIdChars) throw Object.assign(new Error("id-too-long"), { code: "frame-id-too-long" });
  const data = Buffer.from(JSON.stringify(dataObj), "utf8");
  if (data.length > LIMITS.msgMax) throw Object.assign(new Error("msg-too-large"), { code: "frame-msg-too-large" });
  const checksum = crc32(data);
  const dataBase64 = data.toString("base64");
  const frame = { type: "rpc-frame", identity: idStr || "orch-watch", seq, fragment: 0, fragments: 1, checksum, dataBase64, sentAt: nowMs };
  return [frame];
}

/** 帧数组 → 重装 dataObj；checksum/限值/30s 组装闸校验不过 → {ok:false, error}。 */
export function decodeRpcFrames(frames, { nowMs = Date.now() } = {}) {
  try {
    if (!Array.isArray(frames) || !frames.length) return { ok: false, error: "no-frames" };
    if (frames.length > LIMITS.maxFragments) return { ok: false, error: "too-many-fragments" };
    const sorted = [...frames].sort((a, b) => (a.fragment ?? 0) - (b.fragment ?? 0));
    for (let i = 0; i < sorted.length; i++) {
      if ((sorted[i].fragment ?? i) !== i) return { ok: false, error: "fragment-gap" };
      if (typeof sorted[i].dataBase64 !== "string") return { ok: false, error: "missing-data" };
      if (Buffer.from(sorted[i].dataBase64, "base64").length > LIMITS.fragmentMax) return { ok: false, error: "fragment-too-large" };
    }
    const identity = sorted[0].identity;
    if (typeof identity !== "string" || identity.length > LIMITS.maxIdChars) return { ok: false, error: "bad-identity" };
    const first = sorted[0];
    if (first.sentAt != null && nowMs - Number(first.sentAt) > LIMITS.assembleTimeoutMs) return { ok: false, error: "assemble-timeout" };
    const data = Buffer.concat(sorted.map((f) => Buffer.from(f.dataBase64, "base64")));
    if (data.length > LIMITS.msgMax) return { ok: false, error: "msg-too-large" };
    const checksum = crc32(data);
    for (const f of sorted) if (f.checksum !== checksum) return { ok: false, error: "checksum-mismatch" };
    const dataObj = JSON.parse(data.toString("utf8"));
    return { ok: true, identity, seq: first.seq, dataObj };
  } catch (err) {
    return { ok: false, error: "decode:" + ((err && err.message) || "unknown") };
  }
}

/**
 * 步骤 4：L2 桥接编排。session = RelaySession（connectRelay 产物）。
 * 返回 {workspaceKey, bridgeSessionId, initialTaskId}；超时/空列表 throw {code:"bridge-*"}。
 */
export async function openBridge({ session, workspaceKeyHint = null, listTimeoutMs = 10000, openTimeoutMs = 10000, reqIdBase = "ow" } = {}) {
  if (!(session instanceof RelaySession)) throw Object.assign(new Error("bad-session"), { code: "bridge-bad-session" });
  const reqId = `${reqIdBase}-${Date.now().toString(36)}`;
  // workspace-list → 取 workspaceKey（多工作区时 hint 优先，否则首个）
  const list = await session.request({ type: "data", zcode_type: "workspace-list-request", req_id: reqId }, { timeoutMs: listTimeoutMs });
  const workspaces = Array.isArray(list && list.workspaces) ? list.workspaces : [];
  if (!workspaces.length) throw Object.assign(new Error("workspace-list-empty"), { code: "bridge-list-empty" });
  const picked = (workspaceKeyHint && workspaces.find((w) => w && w.workspaceKey === workspaceKeyHint)) || workspaces[0];
  const workspaceKey = picked && picked.workspaceKey;
  if (typeof workspaceKey !== "string" || !workspaceKey) throw Object.assign(new Error("workspace-key-missing"), { code: "bridge-key-missing" });
  // bridge-open → ready（bridgeSessionId/initialTaskId；recoveryId 透传）
  const ready = await session.request({ type: "data", zcode_type: "workspace-bridge-open", workspace_key: workspaceKey, req_id: reqId }, { timeoutMs: openTimeoutMs });
  const bridgeSessionId = ready && typeof ready.bridgeSessionId === "string" ? ready.bridgeSessionId : null;
  if (!bridgeSessionId) throw Object.assign(new Error("bridge-ready-missing"), { code: "bridge-ready-missing" });
  return { workspaceKey, bridgeSessionId, initialTaskId: ready.initialTaskId ?? null, recoveryId: ready.recoveryId ?? null };
}
