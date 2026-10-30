/*!
 * watcher/txn.mjs —— TXN 短事务队列/闸（W-W §8 互踢短事务形态全收编）
 *
 * 纪律（EXP-2/EXP-3 实测参数）：
 *   - 连-发-断：单事务覆盖建连→注入→判定①②→close；持有帽 40s（EXP-3 §5.1 slot 礼仪）
 *   - 频控 ≥90s（60s 防抖窗+50% 裕量，W-W §8.3；EXP-2 门 B 通过维持保守默认，cfg 可调）
 *   - per-mission cap=3（沿哨兵 cap 语义）；D2 退避指数（×3 次后本轮弃发，下轮 POLLER 再评）
 *   - busy ≥2 连发 → 本 mission 静默 30min（W-W §6/§7）
 *   - TTL 同事务签-连 ≤55s（60s TTL 留 5s 余量，EXP-3 §5.4；超时即弃签重签一次，
 *     再败整事务失败归 D1——W-G §4 失效树）
 * 每轮 POLLER 至多出队一个事务（watcher.mjs 主循环保证，天然限频）。
 * 零 npm 依赖；node >= 20。
 */

export const MIN_INTERVAL_MS = 90000;
export const CAP_DEFAULT = 3;
export const BUSY_SILENCE_MS = 30 * 60000;
export const SIGN_CONNECT_MAX_MS = 55000; // 60s TTL - 5s 余量
export const HOLD_MAX_MS = 40000;         // EXP-3 §5.1 持有帽

/**
 * 事务闸：canRun/recordStart/recordOutcome。时钟可注入（测试确定性推进）。
 * 闸不管全局终态（D1/D3/kicked 由 watcher 层断路）——只管频控/cap/退避/静默。
 */
export class TxnGate {
  constructor({ now = Date.now, minIntervalMs = MIN_INTERVAL_MS, cap = CAP_DEFAULT, busySilenceMs = BUSY_SILENCE_MS, backoffBaseMs = 30000, backoffMaxMs = 20 * 60000 } = {}) {
    this.now = now;
    this.minIntervalMs = minIntervalMs;
    this.cap = cap;
    this.busySilenceMs = busySilenceMs;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.per = new Map(); // missionId → {attempts, lastStartAt, busyStreak, silentUntil, backoffUntil, d2Streak}
    this.lastAnyStartAt = 0;
  }
  #rec(id) {
    let r = this.per.get(id);
    if (!r) { r = { attempts: 0, lastStartAt: 0, busyStreak: 0, silentUntil: 0, backoffUntil: 0, d2Streak: 0 }; this.per.set(id, r); }
    return r;
  }
  canRun(missionId, atMs = this.now()) {
    const r = this.#rec(missionId);
    if (atMs < r.silentUntil) return { ok: false, reason: "busy-silence", waitMs: r.silentUntil - atMs };
    if (r.attempts >= this.cap) return { ok: false, reason: "cap-exhausted", waitMs: Infinity };
    if (atMs < r.backoffUntil) return { ok: false, reason: "backoff", waitMs: r.backoffUntil - atMs };
    const sinceLast = atMs - Math.max(this.lastAnyStartAt, r.lastStartAt);
    if (sinceLast < this.minIntervalMs) return { ok: false, reason: "min-interval", waitMs: this.minIntervalMs - sinceLast };
    return { ok: true, reason: "ok", waitMs: 0 };
  }
  recordStart(missionId, atMs = this.now()) {
    const r = this.#rec(missionId);
    r.lastStartAt = atMs;
    r.attempts += 1;
    this.lastAnyStartAt = atMs;
  }
  /** outcome ∈ success|accepted-not-revived|noop|busy|d2|d1|d3|kicked|ttl|hold-timeout */
  recordOutcome(missionId, outcome, atMs = this.now()) {
    const r = this.#rec(missionId);
    if (outcome === "busy") {
      r.busyStreak += 1;
      if (r.busyStreak >= 2) r.silentUntil = atMs + this.busySilenceMs;
      return;
    }
    if (outcome === "noop" || outcome === "success" || outcome === "accepted-not-revived") {
      r.busyStreak = 0; // 非 busy 出现即打断 busy 连发计数
    }
    if (outcome === "d2" || outcome === "hold-timeout") {
      r.d2Streak += 1;
      const backoff = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (r.d2Streak - 1));
      r.backoffUntil = atMs + backoff;
    } else if (outcome !== "backoff-none") {
      r.d2Streak = 0;
      r.backoffUntil = 0;
    }
  }
  /** 全局最早可跑时刻（主循环可 sleep 到点；Infinity=全被 cap 钉死）。 */
  nextEligibleAt(atMs = this.now()) {
    let min = Infinity;
    for (const r of this.per.values()) {
      if (r.attempts >= this.cap) continue;
      min = Math.min(min, r.silentUntil, r.backoffUntil, Math.max(r.lastStartAt, this.lastAnyStartAt) + this.minIntervalMs);
    }
    return min;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * TTL 签-连（pack 规则）：issueToken() → connect() 必须在 deadlineMs(55s) 内完成；
 * 超窗/握手失败即弃签重签，最多 1+maxResign 次签发；全部失败 throw
 * {code:"ttl-exhausted"}（归 D1，W-G §4）。已签未用的 token 计入 discardedTokens
 * （用后即弃语义——数组只在事务内存生存期，事务毕即失引用，零持久化）。
 */
export async function signAndConnect({ issueToken, connect, deadlineMs = SIGN_CONNECT_MAX_MS, maxResign = 1, sleepFn = sleep, nowMs = Date.now } = {}) {
  const t0 = nowMs();
  const discardedTokens = [];
  let lastErr = null;
  for (let attempt = 0; attempt <= maxResign; attempt++) {
    const issued = await issueToken();
    if (!issued.ok) throw Object.assign(new Error("sign-failed:" + issued.kind), { code: "sign-failed", kind: issued.kind });
    const elapsed = nowMs() - t0;
    const remain = deadlineMs - elapsed;
    if (remain <= 0) {
      discardedTokens.push(issued.token);
      lastErr = Object.assign(new Error("ttl-window-breached"), { code: "ttl-exhausted" });
      continue; // 弃签重签（窗口已尽，最后一次也立即失败 → 循环自然终止）
    }
    try {
      const session = await connect(issued.token, { handshakeTimeoutMs: Math.min(15000, remain) });
      return { session, discardedTokens, attempts: attempt + 1, elapsedMs: nowMs() - t0 };
    } catch (err) {
      discardedTokens.push(issued.token); // 签了没连上=已耗用，弃
      lastErr = err;
      if (err && (err.code === "auth-ack-timeout" || err.code === "ws-handshake-timeout")) {
        // 握手/ack 超时且窗口将尽 → 重签；窗口仍足 → 上抛归 D2（connect 面瞬时故障）
        if (nowMs() - t0 >= deadlineMs) continue;
      }
      throw err;
    }
  }
  throw lastErr || Object.assign(new Error("ttl-exhausted"), { code: "ttl-exhausted" });
}
