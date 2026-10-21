/*!
 * watcher/inject.mjs —— INJECT 注入（模板壳构造 + session/send 装帧，W-W §4）
 *
 * 模板壳固定（W-W §4 原案）：`[orch-watch] mission=<id> state=<state> summary=<≤200字>
 * 指引=请消费 spool/<mission_id>/unread/<event_id>.json（路径指针，非正文）`
 *
 * 隐私最小化纪律（W-W §4）：禁内联 worker 原文（提示注入放大器）；正文永远留在 spool 走
 * 既有闸门；watcher 只发 id+状态+指针。中继非零知识（data payload 中继可读明文）——
 * 壳内只含 mission id/状态/指针，把过云暴露面压到最小。
 * 零 npm 依赖；node >= 20。
 */
import { encodeRpcFrame } from "./bridge.mjs";

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

/** 步骤 5 重装体：{method:"session/send", params:{sessionId, content}}（W-W §3）。 */
export function buildSessionSendParams({ sessionId, content }) {
  const sid = String(sessionId ?? "");
  if (!sid) throw Object.assign(new Error("session-id-missing"), { code: "shell-bad-args" });
  return { method: "session/send", params: { sessionId: sid, content: String(content ?? "") } };
}

/**
 * 发送注入：encodeRpcFrame 单帧 → awaitAck（三证①）。
 * 返回 {frame}；ack 超时 throw {code:"rpc-ack-timeout"}（D2 面，调用方归类）。
 */
export async function sendPrompt({ session, seq, sessionId, content, ackTimeoutMs = 10000 }) {
  const payload = buildSessionSendParams({ sessionId, content });
  const [frame] = encodeRpcFrame({ identity: "orch-watch", seq, dataObj: payload });
  const ackP = session.awaitAck(seq, ackTimeoutMs);
  session.send(frame);
  const ack = await ackP;
  return { frame, ack };
}
