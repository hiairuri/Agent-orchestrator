/**
 * bg-sentinel/signals.mjs —— 信号模块（rollout 心跳 / tool_usage / 双空闲链）
 * + watcher-signals 消费面（v0.8 W6）。
 * 自 bg-sentinel.mjs 机械拆分（纯搬运 + import/export 接线，零行为变更）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FIRED_TAIL_BYTES, SQLITE } from "./core.mjs";

/* ================================================================== */
/* 信号模块（rev.b 定案）：rollout 心跳 / tool_usage / 双空闲链           */
/* ================================================================== */

export function signalsOf(cfg) {
  const s = cfg && cfg.signals && typeof cfg.signals === "object" ? cfg.signals : {};
  return {
    rolloutDir: String(s.rollout_dir || "") || path.join(os.homedir(), ".zcode", "cli", "rollout"),
    toolUsageDb: String(s.tool_usage_db || "") || path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite"),
    coordSessionFile: String(s.coord_session_file || "") || path.join("sentinel", "coord-session.txt"),
    mailboxRoot: String(s.mailbox_root || "") || process.env.ZCODE_MAILBOX_ROOT || path.join(os.homedir(), ".zcode", "mailbox"),
    toastOnAbandon: s.toast_on_abandon !== false,
  };
}

/** node:sqlite 只读查询；返回行数组，任何失败 → null（= 信号不可用，降级）。
 *  红线：mode 只读、仅 tool_usage 表、参数化、禁一切写。 */
export function toolUsageQuery(dbPath, sql, param) {
  if (!SQLITE) return null;
  let db = null;
  try {
    db = new SQLITE.DatabaseSync(dbPath, { readOnly: true });
    return db.prepare(sql).all(param);
  } catch {
    return null;
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* best effort */
    }
  }
}

/** 佐证信号：该子会话是否存在 status='running' 行。true/false；null=不可用。 */
export function toolUsageHasRunning(dbPath, sessionId) {
  const rows = toolUsageQuery(
    dbPath,
    "SELECT 1 FROM tool_usage WHERE session_id = ? AND status = 'running' LIMIT 1",
    sessionId,
  );
  return rows === null ? null : rows.length > 0;
}

/** 主控活跃主信号：MAX(started_at)（epoch ms）；无行 → null（无信号）。 */
export function toolUsageLastStartedAt(dbPath, sessionId) {
  const rows = toolUsageQuery(
    dbPath,
    "SELECT MAX(started_at) AS mx FROM tool_usage WHERE session_id = ?",
    sessionId,
  );
  if (rows === null) return null;
  const mx = rows.length ? Number(rows[0] && rows[0].mx) : NaN;
  return Number.isFinite(mx) ? mx : null;
}

/**
 * 活体心跳（C3 主信号）：rollout model-io-<sessionId>.jsonl 的 max(mtime, 末行 completedAt)。
 * 文件缺失/读取失败 → null（降级：本 tick 无 C3，C2 独立评估——绝不告警"找不到心跳文件"，
 * modelIOReset 重写窗口的瞬时异常同样落在这里，天然跳过）。
 */
export function rolloutHeartbeatMs(rolloutDir, sessionId) {
  const file = path.join(rolloutDir, `model-io-${sessionId}.jsonl`);
  let mtimeMs = NaN;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  let completedMs = NaN;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(FIRED_TAIL_BYTES, size);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, len, size - len);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString("utf8").split("\n").filter((x) => x.trim());
    if (lines.length) {
      try {
        const last = JSON.parse(lines[lines.length - 1]);
        const c = Date.parse(String((last && last.completedAt) ?? ""));
        if (Number.isFinite(c)) completedMs = c;
      } catch {
        /* 末行截断/坏行 → 回退 mtime */
      }
    }
  } catch {
    /* 读尾失败 → 回退 mtime */
  }
  const ms = Math.max(Number.isFinite(mtimeMs) ? mtimeMs : 0, Number.isFinite(completedMs) ? completedMs : 0);
  return ms > 0 ? ms : null;
}

/** 主会话 id：<root>/sentinel/coord-session.txt（server resume 通道刷新）。
 * v1.1 W3 rider（B1① 同型守卫，W2 遗留）：消费面前置形状校验——子代理会话
 * id（sess_subagent_agent_<agentId>，EXP10-findings R6 锚劫持形态）绝不作为
 * 唤醒/门控目标。前缀形覆盖未来 sess_subagent_* 变体；判中即忽略该锚并落
 * 一行 stderr（fail-loud 定因），由 coordBusy 后续档兜底（hooks 零依赖纪律，
 * 谓词与 watcher/inject.mjs isSubagentSessionId / session-start G14 同语义）。 */
export function coordSessionId(rootDir, signals) {
  const f = path.isAbsolute(signals.coordSessionFile)
    ? signals.coordSessionFile
    : path.join(rootDir, signals.coordSessionFile);
  try {
    const v = fs.readFileSync(f, "utf8").trim();
    if (v.startsWith("sess_subagent")) {
      process.stderr.write(
        `[bg-sentinel] coord-session 命中 sess_subagent 前缀（子代理短寿命会话，EXP10-findings R6）——` +
          `已忽略该锚，按无主控会话兜底判定（零唤醒目标）\n`,
      );
      return null;
    }
    return v || null;
  } catch {
    return null;
  }
}

/**
 * 双空闲门（§4.2 主/副/三/四/降级链）：true = 主控活跃（门关），false = 空闲（门开）。
 * 全信号缺失 → 按空闲（false）——绝不让哨兵因信号缺失而永不叫人。
 */
export function coordBusy(rootDir, signals, boardMtimeMs, idleMs) {
  const sid = coordSessionId(rootDir, signals);
  const now = Date.now();
  // 主：tool_usage —— 有 running 行 = 活跃；无行且 MAX(started_at) 龄期 ≥ idle = 空闲
  if (sid && SQLITE) {
    if (toolUsageHasRunning(signals.toolUsageDb, sid) === true) return true;
    const mx = toolUsageLastStartedAt(signals.toolUsageDb, sid);
    if (mx != null) return Math.max(0, now - mx) < idleMs; // B7
  }
  // 副：rollout 主会话 model-io mtime/completedAt
  if (sid) {
    const hb = rolloutHeartbeatMs(signals.rolloutDir, sid);
    if (hb != null) return Math.max(0, now - hb) < idleMs;
  }
  // 三：journal mtime（插件自有镜像）
  if (sid) {
    try {
      const jm = fs.statSync(path.join(rootDir, "context", `journal-${sid}.jsonl`)).mtimeMs;
      return Math.max(0, now - jm) < idleMs;
    } catch {
      /* 缺失 → 下一级 */
    }
  }
  // 四（保守代理）：board mtime 距今 < idle 视为"可能活跃"
  if (Number.isFinite(boardMtimeMs)) {
    return Math.max(0, now - boardMtimeMs) < idleMs;
  }
  // 降级：全不可用 → 按空闲（门常开）
  return false;
}

/* --- watcher-signals 消费（v0.8 W6）：watcher 优先唤醒通道的在岗判定面 ---
   格式实证=watcher/degrade.mjs #writeSignal：{at,cls,mission,reason} 逐行 JSONL，
   cls ∈ {D1,D2,D3,kicked}（D2=瞬时重试中仍在岗；D1/D3/kicked=终态 standby），
   滚动 256 行封顶；watcher 成功交付不写信号（success/noop/accepted 均静默）——
   信号语义=「watcher 在岗/失能」状态面而非逐单回执面。消费语义（§15 裁决）：
   watcher 在岗重试中 → 哨兵对 C1（未签收终态两族）静默让位；信号缺失/过期/终态/
   读失败 → 按无信号走既有兜底。C2 stall 死寂检测与 C3 crash 为 watcher 事件中继
   盲区（无事件不可见），无条件保留、永不静默。 */

export const WATCHER_SIGNAL_TTL_DEFAULT_MIN = 10; // 信号新鲜刻度（cfg watcher_signal_ttl_min / CLI --watcher-signal-ttl-min 可覆盖）
export const WATCHER_TERMINAL_CLS = new Set(["D1", "D3", "kicked"]); // watcher 终态（standby）→ 立即兜底
export const WATCHER_COVERED_CATEGORIES = new Set(["unclaimed_terminal", "unclaimed_answer"]); // C1 族=事件中继覆盖面（stall/crash 永不静默）

export function watcherSignalsFile(rootDir) {
  return path.join(rootDir, "sentinel", "watcher-signals.jsonl");
}

/**
 * W6 消费判定：watcher 是否正在岗覆盖 C1。判据=signals 最新有效条目（按 at 取新，
 * 坏行跳过）：cls=D2 且新鲜（age < ttlMs）→ covered（哨兵 C1 静默）；D1/D3/kicked /
 * 过期 / 缺失 / 读失败 / 无有效条目 → 不覆盖（走既有兜底告警，绝不因信号面故障
 * 哑火或误哑）。纯同步读、零阻塞、零写（红线：直至型进程不引入等待；失败按无
 * 信号处理）。
 */
export function watcherCoverage(rootDir, nowMs, ttlMs) {
  let raw = "";
  try {
    raw = fs.readFileSync(watcherSignalsFile(rootDir), "utf8");
  } catch {
    return { covered: false, why: "no-signals" }; // 缺失/读失败 ≈ 无信号（兜底）
  }
  let latest = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const t = Date.parse(String((e && e.at) ?? ""));
      if (!Number.isFinite(t)) continue; // 坏 at 行跳过
      if (!latest || t > latest.atMs) latest = { atMs: t, cls: String((e && e.cls) ?? "") };
    } catch {
      /* 坏行跳过（滚动截半窗口内残行不致命） */
    }
  }
  if (!latest) return { covered: false, why: "no-valid-entry" };
  if (nowMs - latest.atMs >= ttlMs) return { covered: false, why: "expired" }; // 过期 → 兜底
  if (WATCHER_TERMINAL_CLS.has(latest.cls)) return { covered: false, why: "terminal:" + latest.cls }; // watcher standby → 兜底
  return { covered: true, why: "active:" + latest.cls }; // D2 在岗重试中 → C1 静默让位
}
