/*!
 * watcher/verdict.mjs —— VERDICT 成功判定（三证合一，W-W §6；EXP-3 §5 精化）
 *
 * 三证：① rpc-frame-ack（传输送达，seq 对上）② session/send 受理（无 -32010 busy）
 * ③ 真实唤醒（判定窗 60s 内 rollout 心跳复活 / prompt_started 事件，双路任一）。
 *
 * 判定语义（W-W §6 全收编）：
 *   - ①②成③不成：受理但未唤醒 → 记 accepted-not-revived（按成功受理记录，哨兵照常兜底，
 *     不重复注入——防三连唤复辟）
 *   - ②=busy：主控本就在跑 → no-op 成功，不计失败（避免对活跃会话连枪）；
 *     连续 ≥2 轮 busy → 本 mission 静默 30min（txn 层执行）
 *   - 连接持有 ≤40s（EXP-3 §5.1 slot 占用礼仪）：①②在持有帽内判，③在 close 后的
 *     剩余窗内免连接观测（rollout 心跳不占 slot）。
 *
 * 复活探测：revivedProbe({sessionId, sinceMs}) 可注入；内建默认=rollout model-io 心跳
 * mtime 推进（bg-sentinel rolloutHeartbeatMs 同源形态，live 集成阶段复核）。
 * 零 npm 依赖；node >= 20。
 */
import fs from "node:fs";
import path from "node:path";

export const VERDICT_WINDOW_MS = 60000;      // ③判定窗（W-W §6）
export const BUSY_CODE = -32010;             // "A prompt is already running"

/** ②受理分类：response 无 error → accepted；-32010 → busy；其他 error → rejected。 */
export function classifyAccept(response) {
  if (response && response.error) {
    const code = response.error.code;
    if (code === BUSY_CODE) return { accept: "busy", code };
    return { accept: "rejected", code };
  }
  return { accept: "accepted", code: null };
}

/** 三证合成（纯函数）：transport ∈ delivered|busy|failed|no-ack；revived=③结果。 */
export function finalVerdict({ transport, revived }) {
  switch (transport) {
    case "busy":
      return { verdict: "noop", terminal: false, note: "busy=主控在跑，无需唤醒（不计失败）" };
    case "delivered":
      return revived
        ? { verdict: "success", terminal: false, note: "三证合一" }
        : { verdict: "accepted-not-revived", terminal: false, note: "①②成③未成：受理未唤醒，哨兵兜底不重复注入" };
    case "no-ack":
    case "failed":
    default:
      return { verdict: "failed", terminal: false, note: "传输/受理失败（降级树归类在 degrade）" };
  }
}

/** rollout 心跳 mtime 探针（bg-sentinel rolloutHeartbeatMs 简化 twin）：文件 mtime > sinceMs。 */
export function rolloutRevivedProbe({ rolloutDir }) {
  return ({ sessionId, sinceMs }) => {
    try {
      const st = fs.statSync(path.join(rolloutDir, `model-io-${sessionId}.jsonl`));
      return st.mtimeMs > sinceMs;
    } catch {
      return false;
    }
  };
}

/** 恒否探针（测试/无 rollout 面）：③不可观测 → 判定窗满后落 accepted-not-revived 语义。 */
export const nullRevivedProbe = () => () => false;

/**
 * ③观测循环：sendAtMs 起 60s 窗内轮询 revivedProbe；窗满返回最终 revived 值。
 * sleepFn/nowMs 可注入（测试瞬时推进/假时钟；生产默认真钟真睡）。
 */
export async function observeRevival({ revivedProbe, sessionId, sinceMs, windowMs = VERDICT_WINDOW_MS, pollMs = 5000, sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)), nowMs = Date.now }) {
  const deadline = sinceMs + windowMs;
  let revived = false;
  while (nowMs() < deadline) {
    try { revived = revivedProbe({ sessionId, sinceMs }) === true; } catch { revived = false; }
    if (revived) break;
    const wait = Math.min(pollMs, Math.max(0, deadline - nowMs()));
    if (wait > 0) await sleepFn(wait);
  }
  return revived;
}
