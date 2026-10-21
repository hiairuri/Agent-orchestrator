/*!
 * watcher/degrade.mjs —— DEGRADE 降级树状态机（W-W §7 全树落码 + W-G §4 失效树收编）
 *
 * 树（终态=D1/D3/kicked；临时=D2；成功面=noop/success/accepted）：
 *   凭证面：签发 401/code≠0/safeParse/凭据缺失/解密败/AUTH_FAILED/4013/4011 重签再败 → [D1 终态]
 *           standby + 重登录指引；绝不重试轰炸（W-G §4：与桌面同源凭证，重试无新信息）
 *   连接面：ws 建连败/15s 握手超时/auth_ack 超时/rpc 无 ack/组装超时/4010 → 指数退避 ×3
 *           → [D2 临时] 本轮弃发写 signals 回哨兵，下轮 POLLER 恢复
 *   桥接面：bridge-error/bridge-degraded 重试 1 次 → [D2]；workspace-list 空/4004/4012
 *           → [D3 终态] 配置告警（coord-session 失效或桌面未开远控）
 *   注入面：-32010 busy → no-op 成功；WRONG_PARAM → [D3]
 *   互踢：  KICKED/4009 → [kicked 终态] 静默 standby，绝不重连（第一禁令）
 *
 * signals 面：<root>/sentinel/watcher-signals.jsonl（D1/D2/D3/kicked 逐条事件，
 * 滚动 256 行封顶——哨兵 v2.1 兜底唤醒消费面；条目只含 id/类/原因，零敏感值）。
 * 零 npm 依赖；node >= 20。
 */
import fs from "node:fs";
import path from "node:path";
import { redact } from "./credentials.mjs";

export const CLASSES = { ACTIVE: "active", NOOP: "noop", SUCCESS: "success", ACCEPTED: "accepted-not-revived", D1: "D1", D2: "D2", D3: "D3", KICKED: "kicked" };
export const TERMINAL_CLASSES = new Set(["D1", "D3", "kicked"]);
export const SIGNALS_MAX_LINES = 256;

export const D1_GUIDANCE = "[orch-watch] D1 凭证终态：请打开 ZCode 桌面端重新登录（token 已吊销或凭据不可读）；watcher 转 standby，唤醒由哨兵接管；处理完重启 watcher。";

/**
 * 失败分类（纯函数）：输入 degradeFailure 的 kind 码 → {cls, terminal, reason}。
 * kind 与 relay.mapClose/mapErrorFrame、credentials 各 kind、txn ttl 对齐。
 */
export function classifyFailure(f = {}) {
  const kind = String(f.kind || "");
  switch (kind) {
    // 凭证面（D1 终态）
    case "sign-auth-required":
    case "sign-code":
    case "sign-safe-parse":
    case "credentials-missing":
    case "credentials-corrupt":
    case "provider-unsupported":
    case "jwt-absent":
    case "decrypt-failed":
    case "jwt-shape":
    case "auth-failed":
    case "close-4013":
    case "ttl-exhausted":
      return { cls: "D1", terminal: true, reason: kind };
    // 互踢（终态·静默）
    case "kicked":
    case "close-4009":
      return { cls: "kicked", terminal: true, reason: kind };
    // 桥接/配置面（D3 终态）
    case "bridge-list-empty":
    case "close-4004":
    case "close-4012":
    case "wrong-param":
    case "session-target-missing":
      return { cls: "D3", terminal: true, reason: kind };
    // 连接/瞬时面（D2 临时）
    case "sign-relay-unavailable":
    case "sign-timeout":
    case "sign-network":
    case "connect-failed":
    case "handshake-timeout":
    case "auth-ack-timeout":
    case "auth-not-matched":
    case "close-4011": // SessionExpired：零缓存下下轮整事务天然重签（W-G S3 重签语义）；连续再败升 D1（watcher 层规则）
    case "rpc-ack-timeout":
    case "relay-request-timeout":
    case "relay-closed":
    case "close-4010":
    case "device-offline":
    case "internal":
    case "hold-timeout":
    case "sign-shape-safe-parse":
      return { cls: "D2", terminal: false, reason: kind };
    default:
      return { cls: "D2", terminal: false, reason: "unknown:" + (kind || "none") }; // 未知保守归瞬时
  }
}

/** 由 relay 会话终态（closeInfo）产 failure 码。 */
export function failureFromClose(closeInfo) {
  if (!closeInfo) return { kind: "relay-closed" };
  if (closeInfo.name === "KICKED") return { kind: "kicked" };
  return { kind: "close-" + String(closeInfo.code) };
}

/**
 * 降级状态机+signals 落盘。fsImpl/now 可注入；process 不因任何失败退出（W-W §7：
 * 「永不因失败退出」），终态只停事务面、保心跳与 standby。
 */
export class DegradeState {
  constructor({ rootDir, fsImpl = fs, now = Date.now, signalsFile = null, log = () => {} } = {}) {
    this.rootDir = rootDir;
    this.fsImpl = fsImpl;
    this.now = now;
    this.signalsFile = signalsFile || path.join(rootDir, "sentinel", "watcher-signals.jsonl");
    this.state = { cls: CLASSES.ACTIVE, at: null, missionId: null, reason: null };
    this.log = log;
  }
  get terminal() { return TERMINAL_CLASSES.has(this.state.cls); }

  /** 记录一次事务结果；D1/D2/D3/kicked 写 signals；返回 state 快照。 */
  record({ cls, missionId = null, reason = "" }) {
    const at = new Date(this.now()).toISOString();
    if (TERMINAL_CLASSES.has(cls)) {
      this.state = { cls, at, missionId, reason };
    } else if (cls === CLASSES.D2 && !this.terminal) {
      this.state = { cls: CLASSES.ACTIVE, at, missionId, reason: "d2-transient:" + reason }; // D2 不改全局态
    }
    if ([CLASSES.D1, CLASSES.D2, CLASSES.D3, CLASSES.KICKED].includes(cls)) this.#writeSignal({ at, cls, missionId, reason });
    if (cls === CLASSES.D1) this.log(D1_GUIDANCE);
    return { ...this.state };
  }

  #writeSignal(entry) {
    try {
      this.fsImpl.mkdirSync(path.dirname(this.signalsFile), { recursive: true });
      let lines = [];
      try { lines = this.fsImpl.readFileSync(this.signalsFile, "utf8").split("\n").filter((x) => x.trim()); } catch { /* 新文件 */ }
      lines.push(JSON.stringify({ at: entry.at, cls: entry.cls, mission: entry.missionId, reason: redact(String(entry.reason || "")) }));
      if (lines.length > SIGNALS_MAX_LINES) lines = lines.slice(lines.length - Math.floor(SIGNALS_MAX_LINES / 2)); // 滚动截半（哨兵同款）
      this.fsImpl.writeFileSync(this.signalsFile, lines.join("\n") + "\n");
    } catch { /* signals 面失败绝不阻断主流程 */ }
  }
}
