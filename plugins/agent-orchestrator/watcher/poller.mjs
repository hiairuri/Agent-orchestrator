/*!
 * watcher/poller.mjs —— POLLER 轮询判据（watcher 触发源分类）
 *
 * 判据形态 verbatim twin 自 hooks/bg-sentinel.mjs `lastResultAt`/`wakeFailureInfo`（W-W §1：
 * 判据复用哨兵 classify 形态；公共化留独立决策，本文件按 twin 先例不动 hooks）。
 *
 * 精简面（W-W §1/§2 明示弃用）：三回声/连枪/双空闲门/ C2 在飞失联 / C3 崩溃实锤全不进来——
 * 推送通道自带送达语义（三证判定在 verdict.mjs），watcher 只管「敲醒」两类未签收终态：
 *   - unclaimed_terminal：done/failed 已出结果但主控未签收（过 terminalGraceMs）
 *   - unclaimed_answer：  blocked/question 在等主控应答（过 answerGraceMs，优先级更高）
 * EXP-2 门 B 已过（级联未发生），默认触发面=全部四态；`--trigger-statuses` 可收窄回保守档
 * （仅 blocked/question，W-W §8.4）。
 *
 * spool 未读高优事件（W-W §2 触发源之二）：spoolUnreadEvents() 只数不改，正文永不读取——
 * 模板壳只带路径指针（隐私最小化，W-W §4）。
 * 零 npm 依赖；node >= 20。
 */
import fs from "node:fs";
import path from "node:path";

export const RESULT_STATUSES = ["done", "failed", "blocked", "question"]; // verbatim twin: bg-sentinel L77

/* --- verbatim twin of bg-sentinel missionAck/lastResultAt/wakeFailureInfo --- */

function missionAck(m) {
  return m && m.ack && typeof m.ack === "object" ? m.ack : null;
}

export function lastResultAt(m) {
  const timeline = m && Array.isArray(m.timeline) ? m.timeline : [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e && typeof e === "object" && typeof e.event === "string" && e.event.startsWith("report:")) {
      if (e.at != null) return String(e.at);
    }
  }
  return m && m.updated_at != null ? String(m.updated_at) : null;
}

export function wakeFailureInfo(m) {
  const suspected = Boolean(
    m &&
      typeof m === "object" &&
      RESULT_STATUSES.includes(m.status) &&
      Boolean(m.dispatch && m.dispatch.agent_id) &&
      missionAck(m) === null &&
      (m.dispatch && m.dispatch.mode) !== "workflow",
  );
  if (!suspected) return { suspected: false, result_at: null, minutes: null };
  const resultAt = lastResultAt(m);
  const ms = resultAt == null ? NaN : Date.parse(resultAt);
  const minutes = Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 60000)) : null;
  return { suspected: true, result_at: resultAt == null ? null : resultAt, minutes };
}

/** B5 备链 twin：last report:* at → updated_at → boardMtimeMs → null（null=立即到期）。 */
export function resultTimeMs(m, boardMtimeMs) {
  const timeline = m && Array.isArray(m.timeline) ? m.timeline : [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e && typeof e === "object" && typeof e.event === "string" && e.event.startsWith("report:")) {
      const t = Date.parse(String(e.at ?? ""));
      if (Number.isFinite(t)) return t;
    }
  }
  const u = Date.parse(String((m && m.updated_at) ?? ""));
  if (Number.isFinite(u)) return u;
  if (Number.isFinite(boardMtimeMs)) return boardMtimeMs;
  return null;
}

/**
 * watcher 版分类（C1 精简：只保留未签收终态两族，无 C2/C3/双空闲门）。
 * 返回 matured 条件按优先级排序：answer 族优先（主控等人应答），族内 anchor 最旧优先。
 */
export function classifyForWatcher(board, { boardMtimeMs = NaN, answerGraceMs = 180000, terminalGraceMs = 300000, triggerStatuses = RESULT_STATUSES, nowMs = Date.now() } = {}) {
  const conds = [];
  const missions = Array.isArray(board?.missions) ? board.missions : [];
  for (const m of missions) {
    if (!m || typeof m !== "object") continue;
    if (!RESULT_STATUSES.includes(m.status)) continue; // 在飞/草稿/跳过/关闭不触发
    if (!triggerStatuses.includes(m.status)) continue; // 保守档收窄开关
    if ((m.dispatch && m.dispatch.mode) === "workflow") continue; // B4：workflow 由宿主通知
    if (missionAck(m) !== null) continue; // 已签收 → 唤醒职责已了
    if (!(m.dispatch && m.dispatch.agent_id)) continue; // 与哨兵同口径：无派发物不催
    const isAnswer = m.status === "blocked" || m.status === "question";
    const graceMs = isAnswer ? answerGraceMs : terminalGraceMs;
    const t = resultTimeMs(m, boardMtimeMs);
    const anchorMs = t == null ? nowMs - graceMs : t; // B5：时间不可考 → 直接到期
    const ageMs = Math.max(0, nowMs - anchorMs);
    if (ageMs < graceMs) continue; // 未过宽限
    conds.push({
      key: String(m.id),
      mission: m,
      missionId: String(m.id),
      title: String(m.title || "(未命名)").replace(/\s+/g, " ").slice(0, 30),
      status: m.status,
      category: isAnswer ? "unclaimed_answer" : "unclaimed_terminal",
      priority: isAnswer ? 0 : 1,
      anchorMs,
      graceMs,
      ageMs,
    });
  }
  conds.sort((a, b) => a.priority - b.priority || a.anchorMs - b.anchorMs);
  return conds;
}

/** 每轮至多一个事务（W-W §2 天然限频）：取排序后首个（已 matured，见上）。 */
export function pickNext(conds) {
  return conds.length ? conds[0] : null;
}

/* --- spool 未读面（只数不改） --- */

/** 数 <root>/spool/<mission_id>/unread/*.json；任何 IO 失败 → 0（信号降级，不误报）。 */
export function spoolUnreadCount(rootDir, missionId, fsImpl = fs) {
  try {
    const dir = path.join(rootDir, "spool", String(missionId), "unread");
    return fsImpl.readdirSync(dir).filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/** 读 board 安全封装 twin：null=本 tick 无正据（缺失/损坏），调用方计连续失败。 */
export function readBoardSafe(rootDir, fsImpl = fs) {
  const file = path.join(rootDir, "board.json");
  try {
    const board = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (!board || typeof board !== "object" || Array.isArray(board)) return null;
    if (!Array.isArray(board.missions)) return null;
    return board;
  } catch {
    return null;
  }
}

/** board mtime（B5 备链锚）。 */
export function boardMtimeMs(rootDir, fsImpl = fs) {
  try {
    return fsImpl.statSync(path.join(rootDir, "board.json")).mtimeMs;
  } catch {
    return NaN;
  }
}
