#!/usr/bin/env node
/**
 * agent-orchestrator bg-sentinel v2（直至型错峰冗余哨兵家族）。零依赖单文件，Node >= 18。
 *
 * 唯一启动方式：主控以宿主后台任务运行（平台事实：只有宿主后台任务退出才产生完成通知；
 * detached 进程退出无通知；单进程只有一次退出 = 只有一枪——多枪冗余只能靠多实例并存）：
 *   Bash(command="node <插件根>/hooks/bg-sentinel.mjs --once", run_in_background=true)
 * 同命令连发 N 次（默认 3）= 错峰哨兵家族；--once 接受并忽略（0.3.1 肌肉记忆兼容）。
 * 退出 = 完成通知：主控空闲时开新回合、忙时并入当前回合。
 *
 * V7-08/R4 版本偏斜注记：开发期拉起应显式用 repo 路径（或先核插件市场缓存版本与
 * repo 一致）——hooks 家族经宿主市场缓存加载，缓存滞后时旧实例按旧语义行为（历史
 * 「全清自毁」三连唤即 0.5.0 旧实例所为），此类行为不再以「过渡窗口预期」解释。
 *
 * v2 语义（直至型，60s 判定；v2.1 全清转待命不退出）：
 *   - 启动即认领最低空闲槽位 <存储根>/sentinel/instance-<k>.json（wx 原子创建）；
 *     全满且全部新鲜 → exit 0 让位并输出一行明示文案（V7-08/R2，家族拒绝超编——
 *     让位发生在板面读取之前，与在飞与否无关；平台把退出变通知，静默被误读为失明）。
 *   - 错峰：槽位 k 首个 tick 前 sleep k×stagger_sec；此后 poll 周期加 k×5% 抖动。
 *   - 心跳：每 tick 改写自己的槽位文件；接管判定 = pid 死或心跳龄 >90s（B3 沿用）。
 *   - 状态分级条件（每 mission 至多一条，C3 > C1 > C2）：
 *       C1-T done/failed 未签收    宽限 wake_grace_min(5)    refire 5  cap 3
 *       C1-A blocked/question 未签收 宽限 answer_grace_min(3)  refire 5  cap 3
 *       C2  在飞失联（timeline 龄期） 宽限 stall_grace_min(30)  refire 5  cap 3
 *       C3  崩溃实锤（rollout model-io 停更 + tool_usage 佐证/无佐证 ×3 保守档）
 *                                   宽限 crash_grace_min(10)  绕过双空闲门  cap 3
 *       C0  board 连续 3 tick 不可读 立即 → V7-04：转观测隔离（聚合告警一条 + quarantined 值守，不退出）
 *   - 双空闲门（C1/C2）：子代理等待中 ∧ 主控信号停滞（tool_usage 主 / rollout 副 /
 *     journal 三 / board 四 / 全缺失按空闲）；逃逸口 = anchor 龄期 ≥ 2×宽限 无视门开枪
 *     ——门只可能推迟开枪，不可能取消开枪。
 *   - 开枪仲裁：共享 fired 日志 + wx 认领（refire_gap_min 内他人已开枪 → 跳过；
 *     cap_window_min 内满 wake_cap 枪 → 封顶；第 cap 枪条目 final:true = abandoned）。
 *   - 回声：本地 echo.jsonl + 平台邮箱信封（六字段 + 写前自校验 + tmp+rename 毒丸规避）
 *     + abandoned 时 OS toast 兜底（fire-and-forget）。
 *   - 全清待命（v2.1，替代旧"全清自毁"）：全清（无在飞非 workflow 且无未签收终态；
 *     含仅剩 workflow 在飞——workflow 由宿主完成通知，无需盯守）不退出。平台事实：
 *     任何后台退出都会变成完成通知（全清三实例三连唤 = 实测缺陷），故槽位写
 *     state=standby 转低频待命——tick 心跳仍按 poll 周期刷新（保 bg-gate/server 的
 *     90s 在岗新鲜度，补员提醒天然抑制），板面读评节流到 standby_poll_sec
 *     （默认 max(poll, 300s)）；板面出现新在飞/未签收 → 自动复活回 active 正常
 *     盯守与告警。待命期板不可读 → 静默续待命（不计数不告警）。常态全清 0 条通知。
 *   - 观测型隔离（V7-04 lite，替代 C0 旧"开枪退出"）：观测异常满 cap → 写
 *     sentinel/quarantine.json（wx 仲裁唯一首告者，含证据快照）+ 既有通道一条聚合
 *     告警 + 槽位转 state=quarantined 低频值守（心跳照旧；不退出、不杀进程、不写
 *     board、不删文件）。家族级告警抑制：标记新鲜期（cap_window 刻度）内
 *     firedEligible 首检 false——三实例并发恰一条告警，超窗自动恢复开枪能力。
 *     恢复：异常消失（板可读）→ unlink 标记回 active/standby；quarantined 与
 *     standby 互斥，复活/解除共享 mtime 门与 standby_poll 节流（同一低频门）。
 *   - watcher-signals 消费（v0.8 W6，§15 裁决：watcher 优先唤醒 + 哨兵降级兜底）：
 *     板面出现 C1 未签收终态条件时才读 <sentinel>/watcher-signals.jsonl（watcher/
 *     degrade.mjs 落盘，{at,cls,mission,reason} 逐行滚动 256 行）——最新有效信号
 *     cls=D2（瞬时重试中 = watcher 在岗）且新鲜（age < watcher_signal_ttl_min，默认
 *     10min）→ 本 tick C1 两族（unclaimed_terminal/unclaimed_answer）静默让位；
 *     cls ∈ {D1,D3,kicked}（watcher standby 终态）、信号缺失、过期、读失败一律按无
 *     信号 → 既有兜底告警不回归。stall 死寂检测（C2）与 crash（C3）系 watcher 事件
 *     中继盲区（无事件不可见），无条件保留、永不静默；纯同步读零阻塞，不改待命制/
 *     家族轮换（standby 判定仍纯由板面决定）。
 *   - 寿命 ≥ max_lifetime_min（默认 24h）→ 家族轮换单赢家选举（v2.1，替代旧
 *     "各自安静退出"三连唤）：认领 sentinel/family-teardown.json（wx 原子创建；
 *     陈旧/损坏标记可夺位；新鲜窗 = 读者自身 lifetimeMs）——赢家 exit 0 退出
 *     （每个寿命周期至多 1 条通知），输家见新鲜标记顺延自身寿命（重置计时）进入
 *     下一轮，家族逐轮递减直至消亡（长驻是预期）。
 *
 * 信号红线：对 board.json / spool 绝对只读；自有落盘全部在 <存储根>/sentinel/ 与
 * 平台邮箱 unread/；db.sqlite 仅 node:sqlite 以只读打开且仅查 tool_usage（动态
 * import 特性探测，Node < 22.5 或打开失败自动降级——绝不因信号缺失而永不叫人）。
 * 纯本地零网络（powershell toast 为 abandoned 最后一级人工兜底，失败静默）。
 *
 * 配置优先级：CLI > <存储根>/sentinel.cfg.json（server 启动时写出，每 tick 重读 B6）
 *   > 0.3.1 桥接键 > 内建默认。桥接：refire_gap_min←wake_timeout_min、wake_cap←wake_retries。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";

/* node:sqlite 动态探测（Node < 22.5 无此模块属预期路径；失败 → 全部 db 信号降级） */
let SQLITE = null;
try {
  const m = await import("node:sqlite");
  if (m && typeof m.DatabaseSync === "function") SQLITE = m;
} catch {
  SQLITE = null; // 降级链：rollout 单信号 + 门常开，绝不让哨兵哑火
}

const RESULT_STATUSES = ["done", "failed", "blocked", "question"];
const IN_FLIGHT_STATUSES = ["dispatched", "running", "resumed"];
const HEARTBEAT_STALE_MS = 90000; // B3: 心跳龄 >90s 视为不在岗
const BOARD_BAD_TICKS_LIMIT = 3; // B2/C0: 连续不可读 tick 上限
const ECHO_MAX_LINES = 256; // >256 行滚动截半
const PRUNE_AGE_MS = 24 * 3600 * 1000; // fired/echo 条目 24h 物理清理
const PRUNE_EVERY_MS = 30 * 60 * 1000; // 每 30 分钟 prune 一次
const FIRED_TAIL_BYTES = 4096; // rollout 末行读取窗口

function parseArg(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1] ?? "";
    if (argv[i].startsWith(flag + "=")) return argv[i].slice(flag.length + 1);
  }
  return undefined;
}

/** CLI > cfg[key] > 内建默认（clamp）。 */
function numArg(argv, flag, cfg, cfgKey, def, min, max) {
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
function numArgBridge(argv, flag, cfg, cfgKey, bridgeKey, def, min, max) {
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

/* --- root-id 契约校验定根（v0.6；verbatim twin：五脚本同文，行为由 tests/suites/root-contract.mjs
     矩阵锁定，零代码共享）---
   分代门：temp 拒绝（两代通用）→ v2 强校验（root-id 比对）/ v1 弱校验（存在即采信 + stderr 提示）
   → 任一失败回退默认根 + stderr 告警一行。hooks 不删指针（删除职责全归 server 自愈）。 */
function isTempLikeDir(p) {
  try {
    const tmp = path.resolve(os.tmpdir());
    const r = path.resolve(p);
    const rel = path.relative(tmp, r);
    return rel !== "" && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function rootIdOf(rootPath) {
  try {
    return fs.readFileSync(path.join(rootPath, "root-id"), "utf8").trim();
  } catch {
    return ""; // 无 root-id（≤v0.4.0 旧版 server 根 / 非存储目录）
  }
}

function rootContractStderr(msg) {
  try {
    process.stderr.write("[agent-orchestrator] " + msg + "\n");
  } catch {
    /* stderr 不可写也不阻塞 */
  }
}

/** 存储根发现：root.txt 指针优先，采信前过分代门；无指针（或空指针）→ 默认根静默；
 *  任一校验失败 → 回退默认根 + stderr 告警。不删指针。--root 显式指定时仍直通不校验。 */
function locateRoot(projectDir) {
  const defaultRoot = path.join(projectDir, ".zcode", "orchestrator");
  try {
    const pointer = path.join(defaultRoot, "root.txt");
    if (!fs.existsSync(pointer)) return defaultRoot;
    const lines = fs
      .readFileSync(pointer, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) return defaultRoot; // 空指针 ≈ 无指针（静默）
    const target = lines[0];
    if (isTempLikeDir(target)) {
      rootContractStderr("root.txt 指针未通过归属校验（目标位于临时目录），已回退默认根");
      return defaultRoot;
    }
    let live = false;
    try {
      live = fs.statSync(target).isDirectory();
    } catch {
      live = false; // 悬空指针
    }
    if (!live) {
      rootContractStderr("root.txt 指针未通过归属校验（指针目标不存在或不是目录），已回退默认根");
      return defaultRoot;
    }
    const rid = rootIdOf(target);
    if (lines.length >= 2) {
      // v2 强校验：目标存活 ∧ root-id 存在 ∧ 内容 === 指针内嵌 id
      if (!rid) {
        rootContractStderr("root.txt 指针未通过归属校验（目标根缺少 root-id），已回退默认根");
        return defaultRoot;
      }
      if (rid !== lines[1]) {
        rootContractStderr("root.txt 指针未通过归属校验（root-id 与指针内嵌 id 失配），已回退默认根");
        return defaultRoot;
      }
      return target;
    }
    // v1 弱校验（v0.4.1–v0.5.1 旧格式兼容）：目标存活 ∧ root-id 存在即采信（值不比对）
    if (!rid) {
      rootContractStderr("root.txt 指针未通过归属校验（旧格式指针且目标根无 root-id），已回退默认根");
      return defaultRoot;
    }
    rootContractStderr("root.txt 为旧格式指针（v1 弱校验已采信），重启 server 后自动升级");
    return target;
  } catch {
    return defaultRoot; // 任何意外 → 默认根（fail-open，不阻塞）
  }
}

/* --- board / wake-failure helpers: verbatim twin of server.mjs & hooks --- */

function missionAck(m) {
  return m && m.ack && typeof m.ack === "object" ? m.ack : null;
}

function lastResultAt(m) {
  const timeline = m && Array.isArray(m.timeline) ? m.timeline : [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e && typeof e === "object" && typeof e.event === "string" && e.event.startsWith("report:")) {
      if (e.at != null) return String(e.at);
    }
  }
  return m && m.updated_at != null ? String(m.updated_at) : null;
}

function wakeFailureInfo(m) {
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

/**
 * B5: result time fallback chain — last report:* timeline at → updated_at →
 * board.json mtime → null (caller alerts immediately on null).
 */
function resultTimeMs(m, boardMtimeMs) {
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
function lastActivityMs(m) {
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

function fmtAge(min) {
  if (min == null || !Number.isFinite(min)) return "";
  if (min < 1) return "刚刚";
  if (min < 60) return `${Math.floor(min)} 分钟前`;
  return `${Math.floor(min / 60)} 小时 ${Math.floor(min % 60)} 分钟前`;
}

/** 读 board：null = 本 tick 无正据（文件缺失/读取/解析失败）——计数并连续跟踪。 */
function readBoardSafe(rootDir) {
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

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

/* ================================================================== */
/* 信号模块（rev.b 定案）：rollout 心跳 / tool_usage / 双空闲链           */
/* ================================================================== */

function signalsOf(cfg) {
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
function toolUsageQuery(dbPath, sql, param) {
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
function toolUsageHasRunning(dbPath, sessionId) {
  const rows = toolUsageQuery(
    dbPath,
    "SELECT 1 FROM tool_usage WHERE session_id = ? AND status = 'running' LIMIT 1",
    sessionId,
  );
  return rows === null ? null : rows.length > 0;
}

/** 主控活跃主信号：MAX(started_at)（epoch ms）；无行 → null（无信号）。 */
function toolUsageLastStartedAt(dbPath, sessionId) {
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
function rolloutHeartbeatMs(rolloutDir, sessionId) {
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

/** 主会话 id：<root>/sentinel/coord-session.txt（server resume 通道刷新）。 */
function coordSessionId(rootDir, signals) {
  const f = path.isAbsolute(signals.coordSessionFile)
    ? signals.coordSessionFile
    : path.join(rootDir, signals.coordSessionFile);
  try {
    const v = fs.readFileSync(f, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * 双空闲门（§4.2 主/副/三/四/降级链）：true = 主控活跃（门关），false = 空闲（门开）。
 * 全信号缺失 → 按空闲（false）——绝不让哨兵因信号缺失而永不叫人。
 */
function coordBusy(rootDir, signals, boardMtimeMs, idleMs) {
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

const WATCHER_SIGNAL_TTL_DEFAULT_MIN = 10; // 信号新鲜刻度（cfg watcher_signal_ttl_min / CLI --watcher-signal-ttl-min 可覆盖）
const WATCHER_TERMINAL_CLS = new Set(["D1", "D3", "kicked"]); // watcher 终态（standby）→ 立即兜底
const WATCHER_COVERED_CATEGORIES = new Set(["unclaimed_terminal", "unclaimed_answer"]); // C1 族=事件中继覆盖面（stall/crash 永不静默）

function watcherSignalsFile(rootDir) {
  return path.join(rootDir, "sentinel", "watcher-signals.jsonl");
}

/**
 * W6 消费判定：watcher 是否正在岗覆盖 C1。判据=signals 最新有效条目（按 at 取新，
 * 坏行跳过）：cls=D2 且新鲜（age < ttlMs）→ covered（哨兵 C1 静默）；D1/D3/kicked /
 * 过期 / 缺失 / 读失败 / 无有效条目 → 不覆盖（走既有兜底告警，绝不因信号面故障
 * 哑火或误哑）。纯同步读、零阻塞、零写（红线：直至型进程不引入等待；失败按无
 * 信号处理）。
 */
function watcherCoverage(rootDir, nowMs, ttlMs) {
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

/* ================================================================== */
/* 家族槽位                                                             */
/* ================================================================== */

function slotDoc(startedAt, slot, tookOver, prev, state, rootDir) {
  return {
    pid: process.pid,
    slot,
    state: state === "standby" ? "standby" : state === "quarantined" ? "quarantined" : "active", // v2.1 待命制 + V7-04 隔离；旧版文件无此字段 = active
    root: rootDir ?? null, // V6-56 观测性：槽位自证解析根（root-id 契约下排障用）
    started_at: new Date(startedAt).toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...(tookOver ? { took_over: true } : {}),
    ...(tookOver ? { prev: prev ?? null } : {}),
  };
}

function slotFresh(doc, mtimeMs) {
  if (!doc || !Number.isFinite(doc.pid) || !pidAlive(doc.pid)) return false;
  const hb = Date.parse(String(doc.heartbeatAt ?? ""));
  let age = Number.isFinite(hb) ? Date.now() - hb : NaN; // B7
  if (!Number.isFinite(age)) {
    age = Number.isFinite(mtimeMs) ? Date.now() - mtimeMs : Number.POSITIVE_INFINITY;
  }
  return Math.max(0, age) <= HEARTBEAT_STALE_MS;
}

/** 启动清理：把心跳过期且 pid 已死的槽位文件删除（供认领；返回被删文档供 prev 记录）。 */
function pruneStaleSlots(sentDir, familySize) {
  const stale = new Map();
  for (let k = 0; k < familySize; k++) {
    const f = path.join(sentDir, `instance-${k}.json`);
    let doc = null;
    let mtimeMs = NaN;
    try {
      doc = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    try {
      mtimeMs = fs.statSync(f).mtimeMs;
    } catch {
      continue;
    }
    if (!slotFresh(doc, mtimeMs) && !pidAlive(doc.pid)) {
      try {
        fs.unlinkSync(f);
        stale.set(k, doc);
      } catch {
        /* ENOENT/EPERM best effort */
      }
    }
  }
  return stale;
}

/** 认领最低空闲槽位；返回 {slot, tookOver, prev}；全满且全部新鲜 → slot=-1（静默让位）。 */
function claimSlot(sentDir, familySize, startedAt, staleDocs, rootDir) {
  for (let k = 0; k < familySize; k++) {
    const f = path.join(sentDir, `instance-${k}.json`);
    let doc = null;
    try {
      doc = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      doc = null; // 不存在或坏文件 → 走 wx 创建
    }
    if (doc) {
      let mtimeMs = NaN;
      try {
        mtimeMs = fs.statSync(f).mtimeMs;
      } catch {
        /* gone between read and stat → wx below */
      }
      if (slotFresh(doc, mtimeMs)) continue; // 他人新鲜在岗 → 下一槽位
      // 接管（pid 死或心跳龄 >90s）：改写并记录 prev
      try {
        fs.writeFileSync(f, JSON.stringify(slotDoc(startedAt, k, true, doc, undefined, rootDir)) + "\n");
        return { slot: k, tookOver: true, prev: doc };
      } catch {
        continue;
      }
    }
    const prev = staleDocs && staleDocs.has(k) ? staleDocs.get(k) : null;
    const tookOver = Boolean(prev);
    try {
      fs.writeFileSync(f, JSON.stringify(slotDoc(startedAt, k, tookOver, prev, undefined, rootDir)) + "\n", { flag: "wx" });
      return { slot: k, tookOver, prev };
    } catch {
      /* EEXIST：竞争败者 → 下一槽位 */
    }
  }
  return { slot: -1, tookOver: false, prev: null };
}

function touchSlot(sentDir, slot, startedAt, tookOver, prev, state, rootDir) {
  try {
    const f = path.join(sentDir, `instance-${slot}.json`);
    // v0.6 (V6-55)：touch 前重读槽位校验 pid 归属——被接管实例苏醒后让位（不覆盖
    // 他人心跳），退为无槽幽灵（firedEligible/claimShots 仲裁本就防双开枪，幽灵只
    // 损失观测在岗性）；后续 tick 持续让位。不改 slotDoc 结构，待命制零冲突。
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      if (cur && Number.isFinite(cur.pid) && cur.pid !== process.pid) return;
    } catch {
      /* 缺失/坏文件 → 无法证明他人所有，照常 touch（心跳保鲜优先） */
    }
    // 心跳 touch 保留接管痕迹（可观测性，B3 同款）；state 反映当前待命/值守（v2.1）
    fs.writeFileSync(
      f,
      JSON.stringify(slotDoc(startedAt, slot, tookOver, prev, state, rootDir)) + "\n",
    );
  } catch {
    /* best effort */
  }
}

function releaseSlot(sentDir, slot) {
  try {
    fs.unlinkSync(path.join(sentDir, `instance-${slot}.json`));
  } catch {
    /* ENOENT best effort */
  }
}

/* ================================================================== */
/* 家族轮换选举（v2.1：寿命 cap 单赢家，每寿命周期至多 1 条通知）           */
/* ================================================================== */

function teardownFile(rootDir) {
  return path.join(rootDir, "sentinel", "family-teardown.json");
}

/**
 * 寿命到期时的单赢家选举：认领 <sentinel>/family-teardown.json（wx 原子创建）。
 * 返回 true = 本实例是本轮唯一赢家（可退出——退出即通知，赢家仅此一枪）；
 * 返回 false = 输家（见新鲜标记 / 竞争失败），调用方顺延自身寿命进入下一轮。
 * 仲裁：新鲜标记（age < freshMs）→ 输家；无标记 → 认领；陈旧/损坏标记 → 夺位
 * （复核后 unlink 再 wx）；并发竞争由 wx 串行化，3 轮尝试后仍败 → 本轮顺延，
 * 绝不出现双赢家双退出。旧版实例不识此标记照旧自退出（混跑兼容，非 fatal）。
 */
function claimTeardown(rootDir, slot, freshMs) {
  const f = teardownFile(rootDir);
  const now = Date.now();
  const readAt = () => {
    try {
      const t = Date.parse(String(JSON.parse(fs.readFileSync(f, "utf8")).at ?? ""));
      return Number.isFinite(t) ? t : 0; // 坏 at 字段 → 视为最老（可夺位）
    } catch {
      return null; // 缺失或整文件损坏
    }
  };
  const write = () => {
    try {
      fs.writeFileSync(
        f,
        JSON.stringify({ at: new Date(now).toISOString(), pid: process.pid, slot }) + "\n",
        { flag: "wx" },
      );
      return true;
    } catch {
      return false; // EEXIST：他人先到（并发赢家或待夺位的旧标记）
    }
  };
  for (let i = 0; i < 3; i++) {
    const at = readAt();
    if (at !== null && now - at < freshMs) return false; // 新鲜标记 → 输家顺延
    if (write()) return true; // 无标记（或上轮已夺位删除）→ 赢家
    const at2 = readAt(); // EEXIST → 复核：并发赢家刚写入？
    if (at2 !== null && now - at2 < freshMs) return false;
    try {
      fs.unlinkSync(f); // 陈旧/损坏标记 → 夺位后重试
    } catch {
      /* gone：下轮 wx 直接认领 */
    }
  }
  return false; // 极端竞争：本轮放弃（顺延），下轮再选
}

/* ================================================================== */
/* 观测型隔离（V7-04 lite）：quarantine.json 标记 + 家族级告警抑制        */
/* ================================================================== */

const Q_CLAIM = { key: "__quarantine__", category: "quarantine", final: false };

function quarantineFile(rootDir) {
  return path.join(rootDir, "sentinel", "quarantine.json");
}

/** 读隔离标记；null = 无标记/损坏（损坏标记由认领方夺位重写，不在此处理）。 */
function readQuarantine(rootDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(quarantineFile(rootDir), "utf8"));
    if (!doc || typeof doc !== "object") return null;
    const at = Date.parse(String(doc.at ?? ""));
    return { doc, atMs: Number.isFinite(at) ? at : 0 };
  } catch {
    return null;
  }
}

/** 标记新鲜 = age < capWindowMs（与 fired 封顶窗同刻度）；新鲜期内全家族告警挂起。 */
function quarantineFresh(rootDir, cfg) {
  const q = readQuarantine(rootDir);
  return q !== null && Date.now() - q.atMs < cfg.capWindowMs;
}

/**
 * 认领隔离标记（wx 原子创建；返回 true = 本实例是本 episode 唯一首告者）。
 * EEXIST 时：新鲜标记 → false（他人已隔离，静默加入——三实例恰一条告警的仲裁点）；
 * 陈旧/损坏标记 → unlink 夺位重写（true，超窗 episode 的合理再提醒）。
 */
function claimQuarantine(rootDir, slot, reason, evidence, freshMs) {
  const write = () => {
    try {
      fs.mkdirSync(path.dirname(quarantineFile(rootDir)), { recursive: true });
      fs.writeFileSync(
        quarantineFile(rootDir),
        JSON.stringify({ at: new Date().toISOString(), pid: process.pid, slot, reason, evidence: evidence ?? null }) + "\n",
        { flag: "wx" },
      );
      return true;
    } catch {
      return false;
    }
  };
  if (write()) return true;
  const q = readQuarantine(rootDir);
  if (q && Date.now() - q.atMs < freshMs) return false;
  try {
    fs.unlinkSync(quarantineFile(rootDir));
  } catch {
    /* gone：下方 write 直接认领 */
  }
  return write();
}

/** 隔离聚合告警文案（既有通道一条：平台邮箱 + 本地回声；不退出、无 toast）。 */
function buildQuarantineAlert(reason) {
  return (
    `[orch-sentinel] 观测异常隔离告警：${reason}。哨兵实例转 quarantined 低频值守` +
    `（不退出不杀进程不写 board；异常解除自动恢复 active/standby）。隔离期内全家族告警挂起` +
    `（新条件不触发 fired，超 cap_window 自动恢复），证据快照见 sentinel/quarantine.json。`
  );
}

/* ================================================================== */
/* fired 协议（开枪仲裁 + 封顶放弃）                                     */
/* ================================================================== */

function firedDir(rootDir) {
  return path.join(rootDir, "sentinel", "fired");
}

function firedEntries(rootDir, key, category) {
  const dir = firedDir(rootDir);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const prefix = `${key}--${category}--`;
  const out = [];
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      const at = Date.parse(String((doc && doc.at) ?? ""));
      out.push({ file: n, doc, atMs: Number.isFinite(at) ? at : 0 });
    } catch {
      /* 坏条目跳过 */
    }
  }
  out.sort((a, b) => b.atMs - a.atMs); // 新 → 旧
  return out;
}

/** 仲裁：隔离标记新鲜期内 → false（V7-04 家族级告警抑制：聚合告警已由首告者发出）；
 *  Δ 内他人已开枪 → false；cap 窗口内满额 → false；否则 true。 */
function firedEligible(rootDir, cond, cfg) {
  if (quarantineFresh(rootDir, cfg)) return false; // V7-04：隔离期告警挂起（超 cap_window 自动恢复）
  const entries = firedEntries(rootDir, cond.key, cond.category);
  const now = Date.now();
  if (entries.length && now - entries[0].atMs < cfg.refireGapMs) return false;
  const inWindow = entries.filter((e) => now - e.atMs < cfg.capWindowMs).length;
  if (inWindow >= condCap(cond, cfg)) return false;
  return true;
}

function condCap(cond, cfg) {
  return cond.cap || cfg.cap;
}

/**
 * wx 认领一枪；返回认领成功的条目数组（失败者剔除）。写前数一遍现存条目，
 * 本次是第 cap 枪 → 条目带 final:true（放弃标记，不再另写文件）。
 */
function claimShots(rootDir, due, cfg, slot) {
  const dir = firedDir(rootDir);
  const claimed = [];
  for (const c of due) {
    const entries = firedEntries(rootDir, c.key, c.category);
    const now = Date.now();
    if (entries.length && now - entries[0].atMs < cfg.refireGapMs) continue;
    const inWindow = entries.filter((e) => now - e.atMs < cfg.capWindowMs).length;
    const cap = condCap(c, cfg);
    if (inWindow >= cap) continue;
    const isFinal = inWindow + 1 >= cap;
    const doc = {
      key: c.key,
      category: c.category,
      ...(c.key === "__board__" ? {} : { mission_id: c.key }),
      at: new Date(now).toISOString(),
      by_pid: process.pid,
      slot,
      final: isFinal,
      summary_head: buildSummary([c], cfg).replace(/\s+/g, " ").slice(0, 200),
    };
    // v0.6 (V6-54)：文件名去 pid——同 key+category+同毫秒的双实例写同名文件，
    // wx 恢复「恰一成功」互斥（旧名带 pid 各写各名，读-写间隙留下双开枪 TOCTOU 窗）。
    const name = `${c.key}--${c.category}--${now}.json`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), JSON.stringify(doc) + "\n", { flag: "wx" });
      claimed.push({ ...c, final: isFinal });
    } catch {
      /* EEXIST：双实例同 tick 竞争，恰一成功；败者本轮放弃 */
    }
  }
  return claimed;
}

/** fired 条目唯一清理条款：>24h 由任意实例启动/每 30 分钟 unlink（catch ENOENT）。 */
function pruneFired(rootDir) {
  const dir = firedDir(rootDir);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return;
  }
  const now = Date.now();
  for (const n of names) {
    try {
      const f = path.join(dir, n);
      const st = fs.statSync(f);
      if (now - st.mtimeMs > PRUNE_AGE_MS) fs.unlinkSync(f);
    } catch {
      /* best effort */
    }
  }
}

/* ================================================================== */
/* 回声（本地 + 平台邮箱 + OS toast 兜底）                                */
/* ================================================================== */

function echoFile(rootDir) {
  return path.join(rootDir, "sentinel", "echo.jsonl");
}

/** 本地回声：退出路径追加一行；>256 行滚动截半；坏行跳过。 */
function appendEcho(rootDir, claims, summary, extra) {
  const f = echoFile(rootDir);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const line =
      JSON.stringify({
        at: new Date().toISOString(),
        key: claims.map((c) => c.key).join(","),
        category: claims.map((c) => c.category).join(","),
        final: claims.some((c) => c.final),
        ...(extra && extra.toast_attempted ? { toast_attempted: true } : {}),
        summary_head: String(summary).replace(/\s+/g, " ").slice(0, 300),
      }) + "\n";
    let raw = "";
    try {
      raw = fs.readFileSync(f, "utf8");
    } catch {
      /* 首行 */
    }
    let lines = raw.split("\n").filter((x) => x.trim());
    lines.push(line.trim());
    if (lines.length > ECHO_MAX_LINES) lines = lines.slice(lines.length - Math.floor(ECHO_MAX_LINES / 2));
    fs.writeFileSync(f, lines.join("\n") + "\n");
  } catch {
    /* 回声绝不弄挂开枪路径 */
  }
}

function pruneEcho(rootDir) {
  const f = echoFile(rootDir);
  try {
    const raw = fs.readFileSync(f, "utf8");
    const cutoff = Date.now() - PRUNE_AGE_MS;
    const kept = raw
      .split("\n")
      .filter((x) => x.trim())
      .filter((x) => {
        try {
          const t = Date.parse(String(JSON.parse(x).at));
          return Number.isFinite(t) ? t >= cutoff : true;
        } catch {
          return true; // 坏行留待滚动淘汰
        }
      });
    fs.writeFileSync(f, kept.join("\n") + (kept.length ? "\n" : ""));
  } catch {
    /* best effort */
  }
}

/**
 * 平台邮箱回声信封（六字段缺一不可）+ 写前自校验 + tmp+rename 原子落盘。
 * 平台 drain 对坏文件会阻塞整次消费（毒丸）——校验失败放弃外写（本地回声仍在）；
 * 任何 fs 失败静默——回声是保底通道，绝不允许它把开枪路径搞挂。
 */
function buildEnvelope(claims, summary, coordId, slot) {
  const name = `orch-sentinel-${Date.now()}-${process.pid}`;
  return {
    version: 1, // number，必须严格 === 1
    messageId: name,
    fromSessionId: `orch-sentinel-slot${slot}`,
    toSessionId: coordId,
    content: String(summary).replace(/\s+/g, " ").slice(0, 500),
    createdAt: new Date().toISOString(),
  };
}

function validateEnvelope(env) {
  if (!env || typeof env !== "object") return false;
  if (env.version !== 1 || typeof env.version !== "number") return false;
  for (const k of ["messageId", "fromSessionId", "toSessionId", "content", "createdAt"]) {
    if (typeof env[k] !== "string" || !env[k]) return false;
  }
  return true;
}

function mailboxEcho(rootDir, claims, summary, cfg, slot) {
  try {
    const signals = signalsOf(cfg);
    const coordId = coordSessionId(rootDir, signals);
    if (!coordId) return false; // 无主会话 id → 只留本地回声
    const env = buildEnvelope(claims, summary, coordId, slot);
    const serialized = JSON.stringify(env, null, 2) + "\n";
    let roundtrip = null;
    try {
      roundtrip = JSON.parse(serialized);
    } catch {
      return false;
    }
    if (!validateEnvelope(roundtrip)) return false; // 自校验失败 → 弃写
    const dir = path.join(signals.mailboxRoot, coordId, "unread");
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${env.messageId}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, serialized);
    fs.renameSync(tmp, path.join(dir, `${env.messageId}.json`));
    return true;
  } catch {
    return false; // 静默：保底通道故障不追责
  }
}

/** OS toast（第三通道，仅 abandoned final 枪）：powershell WinRT，fire-and-forget。 */
function toastAbandon(cfg) {
  try {
    const signals = signalsOf(cfg);
    if (!signals.toastOnAbandon) return false;
    const ps = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '$x=$t.GetElementsByTagName("text")',
      '$x.Item(0).AppendChild($t.CreateTextNode("agent-orchestrator 哨兵")) | Out-Null',
      '$x.Item(1).AppendChild($t.CreateTextNode("有任务连续告警未获处置（abandoned），请接手任务板")) | Out-Null',
      '$n=[Windows.UI.Notifications.ToastNotification]::new($t)',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("agent-orchestrator").Show($n)',
    ].join("; ");
    child_process
      .spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], {
        detached: true,
        stdio: "ignore",
      })
      .on("error", () => {})
      .unref();
    return true; // 尝试记录（可测）；弹窗成败不承责
  } catch {
    return false;
  }
}

/* ================================================================== */
/* 条件分类 classify（§4.1：每 mission 至多一条，C3 > C1 > C2）           */
/* ================================================================== */

function classify(board, boardMtimeMs, cfg, rootDir, signals) {
  const conds = [];
  const missions = Array.isArray(board.missions) ? board.missions : [];
  const isWorkflow = (m) => (m.dispatch && m.dispatch.mode) === "workflow";
  const now = Date.now();
  for (const m of missions) {
    if (!m || typeof m !== "object") continue;
    if (!IN_FLIGHT_STATUSES.includes(m.status) && !RESULT_STATUSES.includes(m.status)) continue; // ready/drafted/skipped/closed 不产生条件
    if (isWorkflow(m)) continue; // B4：workflow 由宿主通知
    const agentId = (m.dispatch && m.dispatch.agent_id) || null;
    const inFlight = IN_FLIGHT_STATUSES.includes(m.status);
    const title = String(m.title || "(未命名)").replace(/\s+/g, " ").slice(0, 30);

    // C3 崩溃实锤（仅 agent 模式在飞；绕过双空闲门）
    if (inFlight && agentId) {
      const hb = rolloutHeartbeatMs(signals.rolloutDir, `sess_subagent_agent_${agentId}`);
      if (hb != null) {
        const ageMs = Math.max(0, now - hb); // B7
        const running = SQLITE ? toolUsageHasRunning(signals.toolUsageDb, `sess_subagent_agent_${agentId}`) : null;
        // 佐证无 running 行 → 实锤宽限；有行（可能长工具）或佐证不可用 → 保守档 ×3
        const thresholdMs = running === false ? cfg.crashGraceMs : cfg.crashGraceMs * 3;
        if (ageMs >= thresholdMs) {
          // V6-32 板面龄期反证：lastActivity 与 board mtime 双陈旧（板面全死）时
          // C3 降级 C2 受双空闲门，避免对整块陈旧板面绕门开枪；活板真崩溃照旧绕门。
          // 与 v2.1 待命制正交（待命制管全清、本条管有在飞但全陈旧）。
          let la = lastActivityMs(m);
          if (la == null && Number.isFinite(boardMtimeMs)) la = boardMtimeMs; // 与 C2 同备链
          const laStale = la != null && Math.max(0, now - la) >= Math.max(cfg.stallGraceMs, cfg.crashGraceMs * 3);
          const boardStale = Number.isFinite(boardMtimeMs) && Math.max(0, now - boardMtimeMs) >= cfg.crashGraceMs * 3;
          if (!(laStale && boardStale)) {
            conds.push({
              key: String(m.id),
              category: "crash",
              mission: m,
              title,
              status: m.status,
              anchorMs: hb,
              graceMs: cfg.crashGraceMs,
              ageMs,
              bypassGate: true,
            });
            continue; // 一 mission 一条件（取最严）
          }
          // 反证成立 → 不在此开枪，落下方 C2 inflight_stall（受双空闲门）
        }
      }
      // rollout 缺失/未到期/反证成立 → 本 mission 落 C2（降级链终端，绝不告警"找不到心跳文件"）
    }

    // C1 未签收终态（board 正据，沿用 wakeFailureInfo 口径）
    const wake = wakeFailureInfo(m);
    if (wake.suspected) {
      const isAnswer = m.status === "blocked" || m.status === "question";
      const graceMs = isAnswer ? cfg.answerGraceMs : cfg.wakeGraceMs;
      const t = resultTimeMs(m, boardMtimeMs);
      // B5：null（时间完全不可考）→ 直接到期
      const anchorMs = t == null ? now - graceMs : t;
      conds.push({
        key: String(m.id),
        category: isAnswer ? "unclaimed_answer" : "unclaimed_terminal",
        mission: m,
        title,
        status: m.status,
        anchorMs,
        graceMs,
        resultAt: wake.result_at,
        resultAgeMin: Number.isFinite(anchorMs) ? Math.floor((now - anchorMs) / 60000) : null,
        bypassGate: false,
      });
      continue;
    }

    // C2 在飞失联（仅 agent 模式；池工无 dispatch 的兜底是租约回收）
    if (inFlight && agentId) {
      let la = lastActivityMs(m);
      if (la == null && Number.isFinite(boardMtimeMs)) la = boardMtimeMs; // 备：board mtime
      if (la == null) continue; // 均无 → 不判（不误报）
      conds.push({
        key: String(m.id),
        category: "inflight_stall",
        mission: m,
        title,
        status: m.status,
        anchorMs: la,
        graceMs: cfg.stallGraceMs,
        stallAgeMin: Math.floor(Math.max(0, now - la) / 60000),
        bypassGate: false,
      });
    }
  }
  return conds;
}

function matured(c) {
  return Math.max(0, Date.now() - c.anchorMs) >= c.graceMs; // B7
}

function gateOpen(rootDir, c, signals, boardMtimeMs, cfg) {
  if (c.bypassGate) return true; // C3/C0 恒 true
  return !coordBusy(rootDir, signals, boardMtimeMs, cfg.coordIdleMs);
}

function escaped(c) {
  return Math.max(0, Date.now() - c.anchorMs) >= 2 * c.graceMs; // 无条件开枪的逃逸口
}

/* ================================================================== */
/* 告警汇总（四类文案分组；v0.3.1 骨架沿用 + "疑似崩溃"/"放弃通告" 两段）  */
/* ================================================================== */

function buildSummary(claims, cfg) {
  let summary = "";
  const rowsOf = (cat) =>
    claims
      .filter((c) => c.category === cat)
      .slice(0, 5)
      .map((c) => `- [${c.key}] ${c.title}｜${c.status}${c.resultAt ? `｜结果于 ${fmtAge(c.resultAgeMin)}` : ""}｜未签收`);

  const terminalRows = [...rowsOf("unclaimed_terminal"), ...rowsOf("unclaimed_answer")];
  if (terminalRows.length) {
    summary +=
      "[orch-sentinel] 唤醒失败告警：以下任务结果已落盘但主控未签收" +
      "（分级宽限已超：done 5 分钟 / blocked-question 3 分钟）。" +
      "请立即 mailbox(read) 接手并 answer/close（自动签收）；" +
      "补员命令与盯守规则见 SKILL 第 11 章：\n" +
      terminalRows.join("\n");
  }

  const stallRows = claims
    .filter((c) => c.category === "inflight_stall")
    .slice(0, 5)
    .map(
      (c) =>
        `- [${c.key}] ${c.title}｜${c.status}｜无事件已 ${fmtAge(c.stallAgeMin)}｜在飞`,
    );
  if (stallRows.length) {
    summary +=
      (summary ? "\n\n" : "") +
      `[orch-sentinel] 在飞任务龄期告警：以下任务连续无任何事件` +
      `（无事件已 ≥ stall_grace_min=${Math.round(cfg.stallGraceMs / 60000)} 分钟，worker 任何 report 即续期）。` +
      "请 TaskOutput(task_id)/ListWorkflowRuns 核查；确认死亡则 board 改 failed 并重派：\n" +
      stallRows.join("\n");
  }

  const crashRows = claims
    .filter((c) => c.category === "crash")
    .slice(0, 5)
    .map(
      (c) =>
        `- [${c.key}] ${c.title}｜${c.status}｜心跳停更 ${fmtAge(Math.floor(c.ageMs / 60000))}｜在飞`,
    );
  if (crashRows.length) {
    summary +=
      (summary ? "\n\n" : "") +
      `[orch-sentinel] 疑似崩溃告警：以下在飞任务的 rollout 心跳已停更` +
      `（model-io ≥ ${Math.round(cfg.crashGraceMs / 60000)} 分钟无 API 调用；tool_usage 佐证缺失时按 ×3 保守档），` +
      "子代理进程疑似已死。请 TaskOutput(task_id)/ListWorkflowRuns 核查；确认死亡则 board 改 failed 并重派：\n" +
      crashRows.join("\n");
  }

  const boardRows = claims.filter((c) => c.category === "board_unreadable");
  if (boardRows.length) {
    summary +=
      (summary ? "\n\n" : "") +
      `[orch-sentinel] 任务板不可读告警：连续 ${BOARD_BAD_TICKS_LIMIT} 次轮询读取 board.json 失败` +
      `（缺失/损坏）。请检查存储根下的 board.json；修复前哨兵无法盯守。`;
  }

  if (claims.some((c) => c.final)) {
    summary +=
      (summary ? "\n\n" : "") +
      `[orch-sentinel] 放弃通告：以上条件已连续 ${cfg.cap} 枪仍未获处置，哨兵停止再叫（abandoned，见 board list 的 sentinel_health）。` +
      "3 枪全丢大概率是平台完成通知异常——请检查通知链路，并按疑似唤醒失败接手所有未签收项。";
  }
  return summary;
}

/* ================================================================== */
/* 主循环                                                               */
/* ================================================================== */

function main() {
  const argv = process.argv.slice(2);
  const projectDir = process.env.ZCODE_PROJECT_DIR || process.cwd();
  const rootRaw = parseArg(argv, "--root");
  const root =
    rootRaw && !String(rootRaw).startsWith("${") ? path.resolve(String(rootRaw)) : locateRoot(projectDir);
  fs.mkdirSync(root, { recursive: true });

  const cfgPath = path.join(root, "sentinel.cfg.json");
  const legacyLockPath = path.join(root, "sentinel.lock");
  const sentDir = path.join(root, "sentinel");
  const startedAt = Date.now();

  // 隐藏测试缝：信封自校验负例（content 置非字符串）→ 必须拒绝外写。退出码 0。
  if (parseArg(argv, "--self-test-envelope") !== undefined) {
    const bad = { ...buildEnvelope([], "x", "sess_x", 0), content: null };
    const okRejected = !validateEnvelope(JSON.parse(JSON.stringify(bad)));
    const good = buildEnvelope([], "hello", "sess_x", 0);
    const okAccepted = validateEnvelope(JSON.parse(JSON.stringify(good)));
    process.stdout.write(
      JSON.stringify({ bad_rejected: okRejected, good_accepted: okAccepted }) + "\n",
    );
    process.exit(okRejected && okAccepted ? 0 : 1);
  }

  // B6: cfg is re-read every tick (CLI args still win over the file).
  const readCfg = () => {
    try {
      return JSON.parse(fs.readFileSync(cfgPath, "utf8")) || {};
    } catch {
      return {};
    }
  };

  const resolveCfg = () => {
    const c = readCfg();
    const pollMs = numArg(argv, "--poll-sec", c, "wake_poll_sec", 60, 1, 3600) * 1000;
    return {
      raw: c,
      pollMs,
      // v2.1 待命制：全清后板面低频复核周期（默认 ≥300s；心跳不受影响仍按 poll 刷新）
      standbyPollMs:
        numArg(argv, "--standby-poll-sec", c, "standby_poll_sec", Math.max(pollMs / 1000, 300), 1, 3600) * 1000,
      lifetimeMs:
        numArg(argv, "--max-lifetime-min", c, "max_lifetime_min", 1440, 0.01, 43200) * 60000,
      wakeGraceMs: numArgBridge(argv, "--wake-grace-min", c, "wake_grace_min", null, 5, 0.01, 1440) * 60000,
      answerGraceMs: numArgBridge(argv, "--answer-grace-min", c, "answer_grace_min", null, 3, 0.01, 1440) * 60000,
      stallGraceMs: numArgBridge(argv, "--stall-grace-min", c, "stall_grace_min", null, 30, 0.01, 1440) * 60000,
      crashGraceMs: numArgBridge(argv, "--crash-grace-min", c, "crash_grace_min", null, 10, 0.01, 1440) * 60000,
      watcherSignalTtlMs: numArg(argv, "--watcher-signal-ttl-min", c, "watcher_signal_ttl_min", WATCHER_SIGNAL_TTL_DEFAULT_MIN, 0.01, 1440) * 60000, // W6 信号新鲜刻度
      coordIdleMs: numArgBridge(argv, "--coord-idle-min", c, "coord_idle_min", null, 3, 0.01, 1440) * 60000,
      refireGapMs: numArgBridge(argv, "--refire-gap-min", c, "refire_gap_min", "wake_timeout_min", 5, 0.01, 1440) * 60000,
      cap: Math.round(numArgBridge(argv, "--wake-cap", c, "wake_cap", "wake_retries", 3, 1, 100)),
      capWindowMs: numArgBridge(argv, "--cap-window-min", c, "cap_window_min", null, 120, 1, 10080) * 60000,
      familySize: Math.round(numArgBridge(argv, "--family-size", c, "family_size", null, 3, 1, 5)),
      staggerSec: numArgBridge(argv, "--stagger-sec", c, "stagger_sec", null, 20, 0, 600),
    };
  };

  const finish = (code, summaryOut) => {
    releaseSlot(sentDir, slot);
    if (summaryOut) process.stdout.write(summaryOut + "\n");
    process.exit(code);
  };

  // --- 家族槽位认领：失败（全满且全部新鲜）→ exit 0 让位（V7-08/R2：明示一行） ---
  fs.mkdirSync(sentDir, { recursive: true });
  const first = resolveCfg();
  const staleDocs = pruneStaleSlots(sentDir, first.familySize);
  const claimed = claimSlot(sentDir, first.familySize, startedAt, staleDocs, root);
  const slot = claimed.slot;
  if (slot < 0) {
    // V7-08/R2 让位明示一行：让位退出发生在任何板面读取之前，与 mission 是否在飞
    // 完全无关；平台把任何后台退出都变成完成通知，静默 exit 0 被误读为「失明/故障」
    // （乙机制历史感知来源）。通知不可免，语义自解释——一行文案根除误读。
    let freshN = 0;
    for (let k = 0; k < first.familySize; k++) {
      const f = path.join(sentDir, `instance-${k}.json`);
      let doc = null;
      let mtimeMs = NaN;
      try {
        doc = JSON.parse(fs.readFileSync(f, "utf8"));
        mtimeMs = fs.statSync(f).mtimeMs;
      } catch {
        continue;
      }
      if (slotFresh(doc, mtimeMs)) freshN += 1;
    }
    process.stdout.write(
      `[orch-sentinel] 家族已在岗（fresh ${freshN}/${first.familySize}，standby 亦在岗），本次启动让位退出；新派发由在岗实例自动接管。\n`,
    );
    process.exit(0);
  }
  let tookOverClaim = claimed.tookOver;
  let tookOverPrevClaim = claimed.prev;

  let boardFailTicks = 0;
  let boardFailSince = 0;
  let lastPruneAt = 0;
  let firstTick = true;
  let tickTimer = null;
  let tookOver = tookOverClaim; // 接管痕迹：touch 时保留（V2 可观测性）
  let tookOverPrev = tookOverPrevClaim;
  let standby = false; // v2.1 待命制：全清不退出 → true 转低频待命
  let quarantined = false; // V7-04 lite：观测异常隔离值守（与 standby 互斥，低频门共享）
  const stateLabel = () => (quarantined ? "quarantined" : standby ? "standby" : "active"); // 三态标签（V7-04）
  let lifetimeAnchor = startedAt; // 寿命 cap 锚：轮换输家顺延时重置
  let lastEvalAt = 0; // 最近一次全量板面评估时刻（待命节流用）
  let lastEvalBoardMtime = -1; // V7-08/R1：最近一次全量评估时的 board.json mtime（standby mtime 门基准）

  const tick = () => {
    const cfg = resolveCfg(); // B6
    const signals = signalsOf(cfg.raw);
    const prevLabel = stateLabel(); // V7-04：状态迁移检测以三态标签计

    touchSlot(sentDir, slot, startedAt, tookOver, tookOverPrev, stateLabel(), root);

    if (Date.now() - lifetimeAnchor >= cfg.lifetimeMs) {
      // 寿命 cap（v2.1 家族轮换）：单赢家选举——赢家唯一退出（退出即通知，每寿命
      // 周期至多一枪）；输家见新鲜标记顺延自身寿命进入下一轮（长驻是预期）。
      if (claimTeardown(root, slot, cfg.lifetimeMs)) {
        finish(0, "[orch-sentinel] 家族轮换：本实例寿命到期退出（本轮唯一赢家），其余实例自动顺延；可选补员（后台重发 3 次哨兵命令）。");
        return;
      }
      lifetimeAnchor = Date.now(); // 输家：重置计时进入下一轮
    }

    // prune：首 tick 或每 30 分钟（fired/echo 24h + legacy 锁一次性清理）
    if (firstTick || Date.now() - lastPruneAt >= PRUNE_EVERY_MS) {
      pruneFired(root);
      pruneEcho(root);
      try {
        fs.unlinkSync(legacyLockPath); // 0.3.1 单锁遗产：只删不写
      } catch {
        /* ENOENT */
      }
      lastPruneAt = Date.now();
      firstTick = false;
    }

    // v2.1 待命节流（V7-04 起隔离值守同门共享）：active 每 tick 全量评估；
    // standby/quarantined 每 standby_poll_sec 才读板（心跳 touch 不节流，保 90s
    // 在岗新鲜度）。板面出现新在飞/未签收即自动复活。
    // V7-08/R1 standby mtime 门：节流前置一次 board.json mtime 探测（每 poll 周期
    // 1 次 syscall）——server 原子写=改名，mtime 严格递增；mtime 晚于上次全量评估
    // 基准 → 跳过节流立即评估。复活延迟 standby_poll(≤300s) → ≤poll(60s)；mtime
    // 未变维持节流（不退化为全量轮询，防评估放大）。基线 NaN（上次评估时板缺失）
    // + 有限新值 = 板（重）现，必为有新活——V7-04 隔离解除判定同门依赖此分支。
    let boardMtimeProbe = NaN;
    try {
      boardMtimeProbe = fs.statSync(path.join(root, "board.json")).mtimeMs;
    } catch {
      /* 板缺失 → 无可证明的新活，维持节流判定（待命期板不可读分支照旧兜底） */
    }
    const boardTouched =
      Number.isFinite(boardMtimeProbe) &&
      (!Number.isFinite(lastEvalBoardMtime) || boardMtimeProbe > lastEvalBoardMtime);
    if ((standby || quarantined) && !boardTouched && Date.now() - lastEvalAt < cfg.standbyPollMs) {
      tickTimer = setTimeout(tick, cfg.pollMs * (1 + slot * 0.05));
      return;
    }
    lastEvalAt = Date.now();
    lastEvalBoardMtime = boardMtimeProbe; // mtime 门基准随每次全量评估推进

    let boardMtime = NaN;
    try {
      boardMtime = fs.statSync(path.join(root, "board.json")).mtimeMs;
    } catch {
      /* missing board counts as unreadable below */
    }
    const board = readBoardSafe(root);
    if (board === null) {
      if (standby || quarantined) {
        // 待命/隔离期板不可读：无法证明有新活，静默续当前态（不计数不告警——
        // 全清期 0 通知；隔离 episode 的聚合告警已由首告者发出，解除走下方可读分支）
        tickTimer = setTimeout(tick, cfg.pollMs * (1 + slot * 0.05));
        return;
      }
      if (boardFailTicks === 0) boardFailSince = Date.now(); // C0 anchor
      boardFailTicks += 1; // B2
      if (boardFailTicks >= BOARD_BAD_TICKS_LIMIT) {
        // V7-04 lite 观测型隔离：满 cap 不再开枪退出——写 quarantine.json（wx 仲裁
        // 唯一首告者，含证据快照）+ 既有通道一条聚合告警 + 转 quarantined 低频值守
        // （心跳照旧；不杀进程不写 board 不删文件）。家族级抑制：新鲜标记期内其余
        // 实例与新条件由 firedEligible 首检 false 静默挡下（三实例并发恰一条告警）。
        const qReason = `board.json 连续 ${BOARD_BAD_TICKS_LIMIT} 次轮询不可读（缺失/损坏）`;
        const qEvidence = { ticks: boardFailTicks, since: new Date(boardFailSince).toISOString() };
        const qFirst = claimQuarantine(root, slot, qReason, qEvidence, cfg.capWindowMs);
        quarantined = true;
        boardFailTicks = 0; // 隔离看护不再重复计数（重隔离 = 新 episode 才再告警）
        if (stateLabel() !== prevLabel) touchSlot(sentDir, slot, startedAt, tookOver, tookOverPrev, stateLabel(), root);
        if (qFirst) {
          const qSummary = buildQuarantineAlert(qReason);
          mailboxEcho(root, [Q_CLAIM], qSummary, cfg.raw, slot);
          appendEcho(root, [Q_CLAIM], qSummary, {});
        }
      }
      tickTimer = setTimeout(tick, cfg.pollMs * (1 + slot * 0.05)); // 无正据不决策，但只容忍有限次数
      return;
    }
    boardFailTicks = 0;

    // V7-04 自愈：隔离实例读到板 = 异常形态消失 → 清标记回正常态（active/standby
    // 由下方常规流程按板面内容定）。读板成功同时顺手清理已超窗的陈旧标记（无抑制
    // 力，仅文件卫生——新鲜标记保留，其抑制窗口未过）。
    if (quarantined) {
      quarantined = false;
      try {
        fs.unlinkSync(quarantineFile(root));
      } catch {
        /* ENOENT best effort */
      }
    } else {
      const qSeen = readQuarantine(root);
      if (qSeen && Date.now() - qSeen.atMs >= cfg.capWindowMs) {
        try {
          fs.unlinkSync(quarantineFile(root));
        } catch {
          /* ENOENT best effort */
        }
      }
    }

    const conds = classify(board, boardMtime, cfg, root, signals);
    const missions = Array.isArray(board.missions) ? board.missions : [];
    const isWorkflow = (m) => (m.dispatch && m.dispatch.mode) === "workflow";
    const inFlightAll = missions.filter((m) => m && IN_FLIGHT_STATUSES.includes(m.status));
    const inFlightNW = inFlightAll.filter((m) => !isWorkflow(m));

    if (!conds.length && !inFlightNW.length) {
      // v2.1 待命制：全清不退出（含仅剩 workflow 在飞——workflow 由宿主完成通知，
      // 无需盯守）。平台事实：任何后台退出都变成完成通知 = 唤醒主控（旧版全清
      // 三实例三连唤属缺陷）；故槽位标 state=standby 转低频待命，板面出现新在飞/
      // 未签收 → 下一轮评估自动复活回 active 正常值守。
      standby = true;
      boardFailTicks = 0;
      if (stateLabel() !== prevLabel) touchSlot(sentDir, slot, startedAt, tookOver, tookOverPrev, stateLabel(), root);
      tickTimer = setTimeout(tick, cfg.pollMs * (1 + slot * 0.05));
      return;
    }
    standby = false; // 有活干（在飞或未签收）→ 恢复 active 值守
    if (stateLabel() !== prevLabel) touchSlot(sentDir, slot, startedAt, tookOver, tookOverPrev, stateLabel(), root);

    // W6 watcher-signals 消费：watcher 在岗覆盖中的 C1 类别本 tick 静默让位（不重复
    // 开枪）；信号缺失/过期/终态/读失败 → covered=false 走既有兜底（WAKE-02 不回归）。
    // 仅板面出现 C1 条件时才读信号文件（stall/crash 板零额外 IO，且二者永不静默）；
    // standby/家族轮换/仲裁面判定不受影响。
    const needWatcherGate = conds.some((c) => WATCHER_COVERED_CATEGORIES.has(c.category));
    const watcher = needWatcherGate
      ? watcherCoverage(root, Date.now(), cfg.watcherSignalTtlMs)
      : { covered: false, why: "not-needed" };
    const due = conds.filter(
      (c) =>
        (!WATCHER_COVERED_CATEGORIES.has(c.category) || !watcher.covered) && // W6：覆盖中的 C1 静默（stall/crash 永不静默）
        matured(c) && (gateOpen(root, c, signals, boardMtime, cfg) || escaped(c)) && firedEligible(root, c, cfg),
    );
    if (due.length) {
      const claims = claimShots(root, due, cfg, slot);
      if (claims.length) {
        const summary = buildSummary(claims, cfg);
        const finalShot = claims.some((c) => c.final);
        let toastAttempted = false;
        if (finalShot) toastAttempted = toastAbandon(cfg.raw); // 仅 abandoned：OS toast 人工兜底
        mailboxEcho(root, claims, summary, cfg.raw, slot); // 第二通道（毒丸规避）
        appendEcho(root, claims, summary, { toast_attempted: toastAttempted }); // 本地回声（含 toast 记录）
        finish(1, summary); // 开枪 = 退出 = 通知；本实例一条命
        return;
      }
    }

    tickTimer = setTimeout(tick, cfg.pollMs * (1 + slot * 0.05));
  };

  // 错峰：槽位 k 首个 tick 前 sleep k×stagger_sec（认领已在上方完成，可测、可让位）
  const initialDelay = slot * first.staggerSec * 1000;
  if (initialDelay > 0) {
    tickTimer = setTimeout(tick, initialDelay);
  } else {
    tick();
  }
}

try {
  main();
} catch {
  process.exit(0);
}
