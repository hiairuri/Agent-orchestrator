/**
 * bg-sentinel/core.mjs —— 常量 / CLI 参数解析 / root-id 定根 / 板面与 mission 基元。
 * 自 bg-sentinel.mjs 机械拆分（纯搬运 + import/export 接线，零行为变更）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/* node:sqlite 动态探测（Node < 22.5 无此模块属预期路径；失败 → 全部 db 信号降级） */
export let SQLITE = null;
try {
  const m = await import("node:sqlite");
  if (m && typeof m.DatabaseSync === "function") SQLITE = m;
} catch {
  SQLITE = null; // 降级链：rollout 单信号 + 门常开，绝不让哨兵哑火
}

export const RESULT_STATUSES = ["done", "failed", "blocked", "question"];
export const IN_FLIGHT_STATUSES = ["dispatched", "running", "resumed"];
export const HEARTBEAT_STALE_MS = 90000; // B3: 心跳龄 >90s 视为不在岗
export const BOARD_BAD_TICKS_LIMIT = 3; // B2/C0: 连续不可读 tick 上限
export const ECHO_MAX_LINES = 256; // >256 行滚动截半
export const PRUNE_AGE_MS = 24 * 3600 * 1000; // fired/echo 条目 24h 物理清理
export const PRUNE_EVERY_MS = 30 * 60 * 1000; // 每 30 分钟 prune 一次
export const FIRED_TAIL_BYTES = 4096; // rollout 末行读取窗口

export function parseArg(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1] ?? "";
    if (argv[i].startsWith(flag + "=")) return argv[i].slice(flag.length + 1);
  }
  return undefined;
}

/** CLI > cfg[key] > 内建默认（clamp）。 */
export function numArg(argv, flag, cfg, cfgKey, def, min, max) {
  const raw = parseArg(argv, flag);
  const s = raw === undefined ? "" : String(raw).trim();
  if (s && !s.startsWith("${")) {
    const n = Number(s);
    if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
  }
  const c = Number(cfg ? cfg[cfgKey] : NaN); // cfg 次之
  if (Number.isFinite(c)) return Math.min(max, Math.max(min, c));
  return def; // 内建默认兜底
}

/** CLI > cfg[新键] > cfg[桥接键]（0.3.1 参数桥）> 内建默认。 */
export function numArgBridge(argv, flag, cfg, cfgKey, bridgeKey, def, min, max) {
  const raw = parseArg(argv, flag);
  const s = raw === undefined ? "" : String(raw).trim();
  if (s && !s.startsWith("${")) {
    const n = Number(s);
    if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
  }
  const c = Number(cfg ? cfg[cfgKey] : NaN);
  if (Number.isFinite(c)) return Math.min(max, Math.max(min, c));
  const b = bridgeKey ? Number(cfg ? cfg[bridgeKey] : NaN) : NaN;
  if (Number.isFinite(b)) return Math.min(max, Math.max(min, b));
  return def;
}

/** CLI > cfg > 内建默认（布尔；junk 回落默认）。 */
export function boolArg(argv, flag, cfg, cfgKey, def) {
  const raw = parseArg(argv, flag);
  const s = raw === undefined ? "" : String(raw).trim().toLowerCase();
  if (s && !s.startsWith("${")) {
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
  }
  const v = cfg ? cfg[cfgKey] : undefined;
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  return def;
}

/* --- root-id 契约校验定根（v0.6；verbatim twin：五脚本同文，行为由 tests/suites/root-contract.mjs
     矩阵锁定，零代码共享）---
   分代门：temp 拒绝（两代通用）→ v2 强校验（root-id 比对）/ v1 弱校验（存在即采信 + stderr 提示）
   → 任一失败回退默认根 + stderr 告警一行。hooks 不删指针（删除职责全归 server 自愈）。
   本函数为各脚本内定根唯一副本（stop-check 主清点与镜像记录两条路径共用）。
   v1.1.1 (W20/W22) 祖先回退：默认根既无 board.json 也无 root-id（无指针/空指针/校验失败回退）时，
   自 projectDir 向上逐级找最近祖先目录，其 .zcode/orchestrator 同时存在 board.json 与 root-id
   即采用（stderr 一行告知解析根）；找不到则静默默认根。root.txt 指针优先级不变。
   v1.4 (F1 腿 B) board.json 存在性校验：指针目标自洽≠目标合法——采信前先验目标 board.json，
   目标缺而默认根有 → 回退默认根 + stderr 告警一行（混配=误配置 G1-4，本根优先）；默认根
   亦无 → 现行为不变（祖先回退链 W22-RC1..RC8 不动）。删除面对称腿=server 自愈（server-core）。 */
export function isTempLikeDir(p) {
  try {
    const tmp = path.resolve(os.tmpdir());
    const r = path.resolve(p);
    const rel = path.relative(tmp, r);
    return rel !== "" && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

export function rootIdOf(rootPath) {
  try {
    return fs.readFileSync(path.join(rootPath, "root-id"), "utf8").trim();
  } catch {
    return ""; // 无 root-id（≤v0.4.0 旧版 server 根 / 非存储目录）
  }
}

export function rootContractStderr(msg) {
  try {
    process.stderr.write("[agent-orchestrator] " + msg + "\n");
  } catch {
    /* stderr 不可写也不阻塞 */
  }
}

/** 祖先回退判定（v1.1.1 W20/W22；五处 twin 同文）：默认根自身合法（board.json 或 root-id 任一存在）
 *  → 默认根；否则自 projectDir 向上找最近祖先的 .zcode/orchestrator（须同时有 board.json 与
 *  root-id）。命中 → stderr 一行（含解析根路径）后采用；未命中 → 默认根（静默）。cwd 漂移防护。 */
export function ancestorRoot(projectDir, defaultRoot) {
  try {
    if (
      fs.existsSync(path.join(defaultRoot, "board.json")) ||
      fs.existsSync(path.join(defaultRoot, "root-id"))
    ) {
      return defaultRoot; // 默认根合法（新项目即便还没板，只要有 root-id 也不回退）
    }
    let dir = path.dirname(path.resolve(projectDir));
    for (;;) {
      const candidate = path.join(dir, ".zcode", "orchestrator");
      if (
        fs.existsSync(path.join(candidate, "board.json")) &&
        fs.existsSync(path.join(candidate, "root-id"))
      ) {
        rootContractStderr("定根回退：采用祖先根 " + candidate);
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return defaultRoot; // 已到文件系统根仍无命中
      dir = parent;
    }
  } catch {
    return defaultRoot; // 任何意外 → 默认根（fail-open，不阻塞）
  }
}

/** 存储根发现：root.txt 指针优先，采信前过分代门 + board.json 存在性校验（F1 腿 B：目标
 *  缺板而默认根有板 → 回退默认根 + 告警）；无指针（或空指针）→ 默认根（先做祖先
 *  回退判定）；任一校验失败 → 回退默认根 + stderr 告警（同样做祖先回退判定）。不删指针。 */
export function locateRoot(projectDir) {
  const defaultRoot = path.join(projectDir, ".zcode", "orchestrator");
  const fallbackRoot = () => ancestorRoot(projectDir, defaultRoot);
  try {
    const pointer = path.join(defaultRoot, "root.txt");
    if (!fs.existsSync(pointer)) return fallbackRoot();
    const lines = fs
      .readFileSync(pointer, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) return fallbackRoot(); // 空指针 ≈ 无指针
    const target = lines[0];
    if (isTempLikeDir(target)) {
      rootContractStderr("root.txt 指针未通过归属校验（目标位于临时目录），已回退默认根");
      return fallbackRoot();
    }
    let live = false;
    try {
      live = fs.statSync(target).isDirectory();
    } catch {
      live = false; // 悬空指针
    }
    if (!live) {
      rootContractStderr("root.txt 指针未通过归属校验（指针目标不存在或不是目录），已回退默认根");
      return fallbackRoot();
    }
    // v1.4 F1 腿 B（五处 twin 同文）：board.json 存在性校验——目标自洽≠目标合法（根唯一性
    // 仲裁删除面归 server 自愈腿，钩子侧只修根解析输入）。指针目标缺 board.json ∧ 默认根有
    // board.json → 回退默认根 + stderr 告警一行（劈叉失明面补告警；G1-4 混配=误配置非支持
    // 面，本根优先）。默认根亦无 board.json → 现行为（祖先回退链 W22-RC1..RC8 不动）。
    if (
      !fs.existsSync(path.join(target, "board.json")) &&
      fs.existsSync(path.join(defaultRoot, "board.json"))
    ) {
      rootContractStderr("[orch-root-contract] root.txt target lacks board.json; falling back to default root");
      return fallbackRoot();
    }
    const rid = rootIdOf(target);
    if (lines.length >= 2) {
      // v2 强校验：目标存活 ∧ root-id 存在 ∧ 内容 === 指针内嵌 id
      if (!rid) {
        rootContractStderr("root.txt 指针未通过归属校验（目标根缺少 root-id），已回退默认根");
        return fallbackRoot();
      }
      if (rid !== lines[1]) {
        rootContractStderr("root.txt 指针未通过归属校验（root-id 与指针内嵌 id 失配），已回退默认根");
        return fallbackRoot();
      }
      return target;
    }
    // v1 弱校验（v0.4.1–v0.5.1 旧格式兼容）：目标存活 ∧ root-id 存在即采信（值不比对）
    if (!rid) {
      rootContractStderr("root.txt 指针未通过归属校验（旧格式指针且目标根无 root-id），已回退默认根");
      return fallbackRoot();
    }
    rootContractStderr("root.txt 为旧格式指针（v1 弱校验已采信），重启 server 后自动升级");
    return target;
  } catch {
    return fallbackRoot(); // 任何意外 → 默认根（fail-open，不阻塞）
  }
}

/* --- board / wake-failure helpers: verbatim twin of server.mjs & hooks --- */

export function missionAck(m) {
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

/** v1.2 M9-1 scoping：mission 归因 id（dispatch.session_id 优先，其次
 * dispatch.spawned_by_session——W3 M3-1 前向归因字段，board schema 寄 dispatch/ONE_LEVEL
 * 子键）。任一在即「有归因」；均缺 → null（空值三段第 3 段：缺席回落=漏报可见）。 */
export function missionAttributionId(m) {
  const d = m && m.dispatch && typeof m.dispatch === "object" ? m.dispatch : {};
  const sid = typeof d.session_id === "string" ? d.session_id.trim() : "";
  if (sid) return sid;
  const spawned = typeof d.spawned_by_session === "string" ? d.spawned_by_session.trim() : "";
  return spawned || null;
}

/**
 * B5: result time fallback chain — last report:* timeline at → updated_at →
 * board.json mtime → null (caller alerts immediately on null).
 */
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

/** B1: last sign of life — any timeline event at, else updated_at, else null. */
export function lastActivityMs(m) {
  const timeline = m && Array.isArray(m.timeline) ? m.timeline : [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e && typeof e === "object" && e.at != null) {
      const t = Date.parse(String(e.at));
      if (Number.isFinite(t)) return t;
    }
  }
  const u = Date.parse(String((m && m.updated_at) ?? ""));
  return Number.isFinite(u) ? u : null;
}

export function fmtAge(min) {
  if (min == null || !Number.isFinite(min)) return "";
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)}h ${min % 60}m ago`;
}

/** 读 board：null = 本 tick 无正据（文件缺失/读取/解析失败）——计数并连续跟踪。 */
export function readBoardSafe(rootDir) {
  const file = path.join(rootDir, "board.json");
  if (!fs.existsSync(file)) return null;
  try {
    const board = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!board || typeof board !== "object" || Array.isArray(board)) return null;
    if (!Array.isArray(board.missions)) return null;
    return board;
  } catch {
    return null;
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}
