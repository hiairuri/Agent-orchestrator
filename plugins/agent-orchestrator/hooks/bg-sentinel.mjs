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
 *   - 归敛自动拉起（v1.1.1 W23 / A2，默认启用，可 cfg/CLI 关闭）：每 tick
 *     低成本检查一次（状态文件 / 冷却戳 stat 先行；条件复刻 server glean_due
 *     口径——锁 finished_at 起 idle_hours ∧ lessons 新事件 ≥ new_events）。满足则
 *     「锁前置」获取 <全端目录>/glean-lock.json（sentinel/glean-launch.lock 守卫
 *     wx 串行化 + 读比对后 write-tmp+rename 提交；state 非 done 一律让位），再
 *     detached spawn `node <ZCODE_CLI_PATH||zcode.cjs> -p <persona+内联指令>
 *     --json --mode yolo`，stdio 重定向 <root>/context/glean-launch-<ts>.log。
 *     冷却双档（用户裁定）：成功 spawn 只写状态文件（pid+start），子进程退出
 *     （无论成败，立即秒退除外）→ 释放/兜底翻锁 + 24h 长冷却（锚=退出时刻）；
 *     spawn 异常/立即秒退非 0/1 → 1h 短冷却（锚=失败时刻）+ stderr 一行。
 *     挂死自愈：状态文件中子进程存活超 240 分钟 → taskkill /T /F 进程树 + 翻锁
 *     done + 长冷却（破解「gleaner 挂死 → 锁永远 active → 单飞永久阻塞」）。
 *     锁双重保险：gleaner 自行翻 done；哨兵检测子进程已退出而锁仍 active → 兜底
 *     翻 done（token 匹配才写，两处同值冲突无害）。
 *     边界：拉起的是独立 -p 会话（非宿主 Agent 子代理）；gleaner 的交付以报告
 *     文件 + 锁 state=done 为准，本模块不耦合 board、不保证其调用 report。
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
import { fileURLToPath } from "node:url";

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
// v1.2 M9-1 scoping（W9 阶段 a）：归属判定留痕去重（每 mission×category 至多一条回声，
// FIFO 帽防跨代累积）。归因补齐/锚恢复 → owned 时移除键，此后再缺席可重留痕。
const SCOPING_TRACE_CAP = 400;
const scopingTraced = new Map();

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
   → 任一失败回退默认根 + stderr 告警一行。hooks 不删指针（删除职责全归 server 自愈）。
   本函数为各脚本内定根唯一副本（stop-check 主清点与镜像记录两条路径共用）。
   v1.1.1 (W20/W22) 祖先回退：默认根既无 board.json 也无 root-id（无指针/空指针/校验失败回退）时，
   自 projectDir 向上逐级找最近祖先目录，其 .zcode/orchestrator 同时存在 board.json 与 root-id
   即采用（stderr 一行告知解析根）；找不到则静默默认根。root.txt 指针优先级不变。 */
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

/** 祖先回退判定（v1.1.1 W20/W22；五处 twin 同文）：默认根自身合法（board.json 或 root-id 任一存在）
 *  → 默认根；否则自 projectDir 向上找最近祖先的 .zcode/orchestrator（须同时有 board.json 与
 *  root-id）。命中 → stderr 一行（含解析根路径）后采用；未命中 → 默认根（静默）。cwd 漂移防护。 */
function ancestorRoot(projectDir, defaultRoot) {
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

/** 存储根发现：root.txt 指针优先，采信前过分代门；无指针（或空指针）→ 默认根（先做祖先
 *  回退判定）；任一校验失败 → 回退默认根 + stderr 告警（同样做祖先回退判定）。不删指针。 */
function locateRoot(projectDir) {
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

/** v1.2 M9-1 scoping：mission 归因 id（dispatch.session_id 优先，其次
 * dispatch.spawned_by_session——W3 M3-1 前向归因字段，board schema 寄 dispatch/ONE_LEVEL
 * 子键）。任一在即「有归因」；均缺 → null（空值三段第 3 段：缺席回落=漏报可见）。 */
function missionAttributionId(m) {
  const d = m && m.dispatch && typeof m.dispatch === "object" ? m.dispatch : {};
  const sid = typeof d.session_id === "string" ? d.session_id.trim() : "";
  if (sid) return sid;
  const spawned = typeof d.spawned_by_session === "string" ? d.spawned_by_session.trim() : "";
  return spawned || null;
}

/** v1.2 M9-1 scoping 留痕（echo.jsonl 单写方，复用 appendEcho；非开枪——final 恒
 * false、零 fired 零退出零 board 写）。每 mission×category 去重（内存 Map+FIFO 帽），
 * 留痕失败绝不拖垮判定（appendEcho 内部全 catch，此处再兜一层）。 */
function scopingSkipTrace(rootDir, missionId, category, summary) {
  const key = String(missionId);
  if (scopingTraced.get(key) === category) return;
  if (scopingTraced.size >= SCOPING_TRACE_CAP) {
    const first = scopingTraced.keys().next().value;
    if (first !== undefined) scopingTraced.delete(first);
  }
  scopingTraced.set(key, category);
  try {
    appendEcho(rootDir, [{ key, category, final: false }], summary, {});
  } catch {
    /* 留痕失败不影响主路径 */
  }
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
  if (min < 60) return `${min} 分钟前`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟前`;
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

/** 主会话 id：<root>/sentinel/coord-session.txt（server resume 通道刷新）。
 * v1.1 W3 rider（B1① 同型守卫，W2 遗留）：消费面前置形状校验——子代理会话
 * id（sess_subagent_agent_<agentId>，EXP10-findings R6 锚劫持形态）绝不作为
 * 唤醒/门控目标。前缀形覆盖未来 sess_subagent_* 变体；判中即忽略该锚并落
 * 一行 stderr（fail-loud 定因），由 coordBusy 后续档兜底（hooks 零依赖纪律，
 * 谓词与 watcher/inject.mjs isSubagentSessionId / session-start G14 同语义）。 */
function coordSessionId(rootDir, signals) {
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
/* v1.1.1 W-B 哨兵 drain（完成即唤队列滞留消费；grill#wake Q5：滞留 120s=2 tick） */
/* ================================================================== */

/* kick 失败遗留的队列事件由哨兵补一脚：spawn node hooks/wake-kick.mjs --root <root>
 * （注入判定/锚活性双闸/b2 禁用/认领串行化全在 kick 内——本侧零注入零网络，spawn 为
 * 本地子进程，「纯本地零网络」红线不破；kick 自带 120s 自杀护栏）。门口：队列空 /
 * 认领持有中（kick 在跑或生产者毫秒窗，claim.json 可解析且新鲜 <staleMs）→ 静默；
 * 陈旧/损坏认领=不持有（kick 侧超龄回收，WB-SRV-e 残留识别语义的消费面）。
 * 家族级 spawn 节流：sentinel/wake-kick-last-spawn mtime ≥ staleMs 才再 spawn
 * （3 实例错峰下家族 ≤1 次/staleMs，锚死重试风暴面收口；标记写败不阻 spawn）。 */
function wakeQueueDir(rootDir) {
  return path.join(rootDir, "context", "wake-queue");
}

function wakeQueueScan(rootDir, staleMs, nowMs) {
  const out = { total: 0, stranded: 0, claimHeld: false };
  const dir = wakeQueueDir(rootDir);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "claim.json");
  } catch {
    return out; // 队列目录缺失=空 → 静默
  }
  out.total = names.length;
  for (const n of names) {
    try {
      if (nowMs - fs.statSync(path.join(dir, n)).mtimeMs >= staleMs) out.stranded += 1;
    } catch {
      /* gone between read and stat */
    }
  }
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "claim.json"), "utf8"));
    const at = Date.parse(String((doc && doc.acquired_at) ?? ""));
    out.claimHeld = !Number.isFinite(at) || nowMs - at < staleMs; // 损坏/陈旧=不持有（kick 回收）；可解析且新鲜=持有中
  } catch {
    out.claimHeld = false; // 缺失=不持有
  }
  return out;
}

function spawnWakeKick(rootDir, projectDir, staleMs) {
  try {
    const marker = path.join(rootDir, "sentinel", "wake-kick-last-spawn");
    try {
      if (Date.now() - fs.statSync(marker).mtimeMs < staleMs) return false; // 家族级节流窗内
    } catch {
      /* 无标记=可 spawn */
    }
    try {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString() }) + "\n");
    } catch {
      /* 节流标记失败不阻 spawn（最坏=多一脚，kick 认领串行化兜底） */
    }
    const kickPath = path.join(path.dirname(process.argv[1] || ""), "wake-kick.mjs");
    const kid = child_process.spawn(process.execPath, [kickPath, "--root", rootDir], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: projectDir,
    });
    kid.on("error", () => {}); // spawn 失败静默：事件留队，下 tick 再试（C1 板面告警回落既有行为）
    kid.unref();
    return true;
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
  // v1.2 M9-1 scoping：本哨兵所守会话锚（coord-session.txt），归属等值判定的本侧。
  const ownId = coordSessionId(rootDir, signals);
  for (const m of missions) {
    if (!m || typeof m !== "object") continue;
    if (!IN_FLIGHT_STATUSES.includes(m.status) && !RESULT_STATUSES.includes(m.status)) continue; // ready/drafted/skipped/closed 不产生条件
    if (isWorkflow(m)) continue; // B4：workflow 由宿主通知
    // v1.2 M9-1 scoping 闸（MOD3a-QA 三枪全丢误报靶心）：开枪前判 mission 归属——
    // 有归因（dispatch.session_id / spawned_by_session 任一在）按与本哨兵锚等值判定；
    // 等值不成立（他会话）或无法成立（归因缺席/锚缺失）一律零开枪，转留痕可见
    // （空值三段第 3 段=漏报可见硬约束：scoping-skipped 留痕 + server 组包尾块缺席
    // 计数；fail-open 与纯 fail-closed 均已否决）。本闸每 tick 重判——归因补齐即自动
    // 恢复盯守。不对称原则：误判他会话=静默留痕低害，漏枪由 session-start 回归简报兜住。
    const mid = String(m.id);
    const attr = missionAttributionId(m);
    if (!attr || ownId == null || attr !== ownId) {
      const foreign = Boolean(attr) && ownId != null;
      scopingSkipTrace(
        rootDir,
        mid,
        foreign ? "scoping-foreign" : "scoping-skipped",
        foreign
          ? `scoping-foreign：mission ${mid} 归属 ${attr} ≠ 本哨兵锚——零开枪静默留痕（他会话完成态照常落板+spool，回归由 session-start 简报补报）`
          : !attr
            ? `scoping-skipped：mission ${mid} 无归因（dispatch.session_id/spawned_by_session 均缺席）——补齐前不盯守（组包尾块缺席计数可见，补齐自动恢复）`
            : `scoping-skipped：mission ${mid} 归因 ${attr} 无法比对（本哨兵锚缺失）——锚重发布前不盯守`,
      );
      continue;
    }
    scopingTraced.delete(mid); // 恢复盯守：清留痕去重键（此后再缺席/转他会话可重留痕）
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
/* 归敛自动拉起（v1.1.1 W23 / A2）：门槛复刻 + 锁前置 + headless 拉起    */
/* ================================================================== */

/* 门槛口径逐字复刻 server.mjs 的 glean_due（readGleanCfg / gleanLockInfo /
   evaluateGleanGate / countEvents），只读、不写 board、不改 server。锁与冷却
   是哨兵自有产物（<root>/sentinel/），全端目录默认 ~/.zcode/orchestrator-memory
   （temp 根自包含 <root>/orchestrator-memory，与 server 的测试 carve-out 同款）。 */
const GLEAN_CFG_DEFAULTS = { idle_hours: 48, new_events: 10, lock_stale_hours: 1.5 };
const GLEAN_LAUNCH_COOLDOWN_H_DEFAULT = 24; // 成功拉起→子进程退出后的长冷却（锚=退出时刻）
const GLEAN_LAUNCH_SHORT_COOLDOWN_H_DEFAULT = 1; // 拉起失败（spawn 异常/立即秒退）短冷却（锚=失败时刻）
const GLEAN_LAUNCH_GRACE_SEC_DEFAULT = 15; // 立即退出判定窗（秒）
const GLEAN_LAUNCH_TIMEOUT_MIN_DEFAULT = 240; // 子进程存活上限（分钟）→ 击杀进程树 + 释放锁 + 长冷却
const GLEAN_GUARD_STALE_MS = 60 * 1000; // 获取租约守卫文件陈旧窗（进程崩溃后的夺位条件）
const GLEAN_CLI_DEFAULT = "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs";

/** CLI > cfg > 内建默认（布尔；junk 回落默认）。 */
function boolArg(argv, flag, cfg, cfgKey, def) {
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

/** 全端记忆目录：CLI > cfg > env ZCODE_ORCH_MEMORY > temp 根自包含 > ~/.zcode/orchestrator-memory。
 *  temp 根自包含与 server resolveMemoryRoot 的测试 carve-out 同语义——套件绝不碰真实家目录。 */
function gleanMemoryRoot(argv, rawCfg, rootDir) {
  const cli = parseArg(argv, "--glean-memory-root");
  const s = cli === undefined ? "" : String(cli).trim();
  if (s && !s.startsWith("${")) return path.resolve(s);
  const c = rawCfg && typeof rawCfg.glean_memory_root === "string" ? rawCfg.glean_memory_root.trim() : "";
  if (c && !c.startsWith("${")) return path.resolve(c);
  const env = String(process.env.ZCODE_ORCH_MEMORY || "").trim();
  if (env && !env.startsWith("${")) return path.resolve(env);
  if (isTempLikeDir(rootDir)) return path.join(rootDir, "orchestrator-memory");
  return path.join(os.homedir(), ".zcode", "orchestrator-memory");
}

/** glean.cfg.json 读取 + 逐键 junk 回落（与 server readGleanCfg 同口径）。 */
function readGleanCfg(memoryRoot) {
  const defaults = { ...GLEAN_CFG_DEFAULTS };
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(memoryRoot, "glean.cfg.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const cfg = { ...defaults, ...parsed };
      if (!Number.isFinite(Number(cfg.idle_hours)) || Number(cfg.idle_hours) < 0) cfg.idle_hours = defaults.idle_hours;
      if (!Number.isFinite(Number(cfg.new_events)) || Number(cfg.new_events) < 0) cfg.new_events = defaults.new_events;
      if (!Number.isFinite(Number(cfg.lock_stale_hours)) || Number(cfg.lock_stale_hours) <= 0)
        cfg.lock_stale_hours = defaults.lock_stale_hours;
      return cfg;
    }
  } catch {
    /* 缺失/坏 cfg → 内建默认 */
  }
  return defaults;
}

/** 非空行数（与 server lessonsLineCount 同口径）。 */
function lessonsLineCount(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/** 项目存储根 root-id（server 恒写 16 hex；缺失 → "" = 水位数按 0 计）。 */
function gleanRootId(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, "root-id"), "utf8").trim();
    return /^[0-9a-f]{16}$/.test(raw) ? raw : "";
  } catch {
    return "";
  }
}

function gleanLockFile(memoryRoot) {
  return path.join(memoryRoot, "glean-lock.json");
}

/** 只读锁快照（缺失 = 从未归敛）。 */
function readGleanLock(memoryRoot) {
  const file = gleanLockFile(memoryRoot);
  try {
    const mtimeMs = fs.statSync(file).mtimeMs;
    let doc = null;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      doc = null; // 坏文件 ≈ 无锁文档（server 同口径：present + mtime 兜底）
    }
    return { file, present: true, doc, mtimeMs };
  } catch {
    return { file, present: false, doc: null, mtimeMs: 0 };
  }
}

/** 锁占用判定（server gleanLockInfo 同口径）：仅 active ∧ 活 PID ∧ 龄期 ≤ lock_stale_hours 为忙。 */
function gleanLockBusy(doc, mtimeMs, gcfg, nowMs) {
  if (!doc || typeof doc !== "object") return false;
  if (doc.state !== "active") return false;
  const pid = Number(doc.pid);
  if (!Number.isFinite(pid) || !pidAlive(pid)) return false; // 死 PID → 可回收
  const started = Date.parse(String(doc.started_at ?? ""));
  const ageMs = Number.isFinite(started) ? nowMs - started : nowMs - mtimeMs;
  return Math.max(0, ageMs) <= Number(gcfg.lock_stale_hours) * 3600000;
}

/** 启动器抢锁前的自由判定：缺失/坏文件/done = 自由；active 且可回收 = 自由；
 *  其余非 done 态（未知态）一律不抢（用户裁定「state 非 done 则放弃」）。 */
function gleanLockFreeForLaunch(doc, mtimeMs, gcfg, nowMs) {
  if (!doc || typeof doc !== "object") return true;
  if (doc.state === "done") return true;
  if (doc.state !== "active") return false;
  return !gleanLockBusy(doc, mtimeMs, gcfg, nowMs);
}

/**
 * gate 真值表（复刻 server evaluateGleanGate，成本序：时间 → 事件数 → 锁）：
 * lastGleanMs = finished_at 优先、mtime 兜底；从未归敛 = idle ∞。
 * 事件数 = max(0, 项目 lessons 行数 - wmProjects[rootId]) + max(0, 全端行数 - wmGlobal)。
 */
function gleanGateCheck(memoryRoot, rootDir, gcfg, nowMs) {
  const lock = readGleanLock(memoryRoot);
  const finished = lock.doc ? Date.parse(String(lock.doc.finished_at ?? "")) : NaN;
  const lastGleanMs = Number.isFinite(finished) ? finished : lock.present ? lock.mtimeMs : 0;
  const idleMs = lastGleanMs > 0 ? Math.max(0, nowMs - lastGleanMs) : Number.POSITIVE_INFINITY;
  const idleH = idleMs / 3600000;
  const busy = gleanLockBusy(lock.doc, lock.mtimeMs, gcfg, nowMs);
  if (!(idleH > Number(gcfg.idle_hours))) {
    return { due: false, stage: "time", idleH, events: null, busy, lock, rootId: null };
  }
  const rootId = gleanRootId(rootDir);
  const wm = lock.doc && lock.doc.watermarks && typeof lock.doc.watermarks === "object" ? lock.doc.watermarks : {};
  const wmProject = Number(wm.projects && wm.projects[rootId]) || 0;
  const wmGlobal = Number(wm.global_lines) || 0;
  const events =
    Math.max(0, lessonsLineCount(path.join(rootDir, "memory", "lessons.jsonl")) - wmProject) +
    Math.max(0, lessonsLineCount(path.join(memoryRoot, "memory", "lessons.jsonl")) - wmGlobal);
  if (!(events >= Number(gcfg.new_events))) {
    return { due: false, stage: "events", idleH, events, busy, lock, rootId };
  }
  if (busy) return { due: false, stage: "lock", idleH, events, busy: true, lock, rootId };
  return { due: true, idleH, events, busy: false, lock, rootId };
}

/* 冷却戳（沿 bg-gate sentinel-hint-stamp 先例：单文件；本模块用 JSON 承载
   「时刻+TTL+种类」，兼容旧的裸 ISO/mtime 形状。两档冷却（用户裁定）：
   - 长冷却：子进程退出（无论成败，除立即秒退外）→ 24h，锚=退出时刻；
   - 短冷却：spawn 异常 / 立即秒退（非 0/1）→ 1h，锚=失败时刻（防周期风暴）。 */
function gleanStampFile(rootDir) {
  return path.join(rootDir, "sentinel", "glean-launch-stamp");
}

/** 冷却状态 {active, untilMs, kind}；坏内容/mtime-only 按长冷却兜底。 */
function gleanCooldownState(rootDir, fallbackLongMs, nowMs = Date.now()) {
  let st = null;
  try {
    st = fs.statSync(gleanStampFile(rootDir));
  } catch {
    return { active: false, untilMs: 0, kind: null };
  }
  let raw = "";
  try {
    raw = fs.readFileSync(gleanStampFile(rootDir), "utf8").trim();
  } catch {
    /* 读失败 → mtime 兜底 */
  }
  let untilMs = NaN;
  let kind = null;
  try {
    const doc = JSON.parse(raw);
    const u = Number(doc && doc.until_ms);
    if (Number.isFinite(u)) {
      untilMs = u;
      kind = String((doc && doc.kind) || "") || null;
    } else {
      const at = Date.parse(String((doc && doc.at) ?? ""));
      if (Number.isFinite(at)) {
        untilMs = at + fallbackLongMs;
        kind = "legacy-json";
      }
    }
  } catch {
    const at = Date.parse(raw); // 旧形状：裸 ISO 时刻
    if (Number.isFinite(at)) {
      untilMs = at + fallbackLongMs;
      kind = "legacy-iso";
    }
  }
  if (!Number.isFinite(untilMs)) {
    untilMs = st.mtimeMs + fallbackLongMs; // 裸文件/坏内容 → mtime + 长冷却
    kind = "mtime";
  }
  return { active: nowMs < untilMs, untilMs, kind };
}

function gleanCooldownActive(rootDir, fallbackLongMs, nowMs = Date.now()) {
  return gleanCooldownState(rootDir, fallbackLongMs, nowMs).active;
}

/** 写冷却戳（覆盖写；原子 tmp+rename）。kind ∈ {long, short}。 */
function stampGleanCooldown(rootDir, ms, kind, nowMs = Date.now()) {
  try {
    atomicWriteRaw(
      gleanStampFile(rootDir),
      JSON.stringify({
        v: 1,
        at: new Date(nowMs).toISOString(),
        until: new Date(nowMs + ms).toISOString(),
        until_ms: nowMs + ms,
        kind,
      }) + "\n",
    );
  } catch {
    /* best effort：冷却戳写失败不阻塞拉起路径 */
  }
}

/* --- 获取租约：wx 守卫文件串行化「读-比-写」，三实例家族只成一 ---
   守卫只覆盖抢锁到 spawn 提交的毫秒级窗口；锁本体（glean-lock.json）一旦提交为
   active 即成为单飞主闸。守卫自带陈旧夺位（pid 死 / 龄期 > 60s），进程崩溃不留死锁。 */
function gleanGuardFile(rootDir) {
  return path.join(rootDir, "sentinel", "glean-launch.lock");
}

function acquireGleanGuard(rootDir, slot) {
  const f = gleanGuardFile(rootDir);
  const nowMs = Date.now();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(f, JSON.stringify({ pid: process.pid, slot, at: new Date(nowMs).toISOString() }) + "\n", {
        flag: "wx",
      });
      return { ok: true, path: f };
    } catch {
      /* EEXIST / 写失败 → 判陈旧后重试 */
    }
    let doc = null;
    let mtimeMs = NaN;
    try {
      doc = JSON.parse(fs.readFileSync(f, "utf8"));
      mtimeMs = fs.statSync(f).mtimeMs;
    } catch {
      /* 文件已消失或不可读 → 下轮 wx 直接认领 */
    }
    if (!Number.isFinite(mtimeMs) && !fs.existsSync(f)) continue; // 刚消失：重试 wx（不误判他人占用）
    let stale = false;
    if (doc && Number.isFinite(Number(doc.pid))) {
      stale =
        !pidAlive(Number(doc.pid)) ||
        (Number.isFinite(mtimeMs) && Date.now() - mtimeMs > GLEAN_GUARD_STALE_MS);
    } else if (Number.isFinite(mtimeMs)) {
      stale = Date.now() - mtimeMs > GLEAN_GUARD_STALE_MS;
    } else if (fs.existsSync(f)) {
      stale = true; // 存在但完全不可读且无 mtime：按损坏守卫夺位
    }
    if (!stale) return { ok: false, reason: "guard-busy" };
    try {
      fs.unlinkSync(f); // 陈旧/损坏守卫 → 夺位后重试
    } catch {
      /* gone：下轮直接认领 */
    }
  }
  return { ok: false, reason: "guard-busy" };
}

function releaseGleanGuard(guard) {
  if (!guard || !guard.ok) return;
  try {
    fs.unlinkSync(guard.path);
  } catch {
    /* best effort */
  }
}

function atomicWriteRaw(file, raw) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`,
  );
  fs.writeFileSync(tmp, raw);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/**
 * 锁前置获取（先比对后写入）：
 *  1) wx 守卫串行化（并发只有一实例进入）；
 *  2) 复读锁：非 done/占用 → 让位；
 *  3) 保存旧锁快照（失败回退用）→ 原子写 active（pid 先记启动器，spawn 后改记子进程）。
 * 返回 {ok:true, guard, snapshot, token, file, memory_root, root_dir, doc} 或 {ok:false, reason}。
 */
function acquireGleanLock({ rootDir, memoryRoot, slot, gcfg, nowMs = Date.now() }) {
  const guard = acquireGleanGuard(rootDir, slot);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  try {
    const cur = readGleanLock(memoryRoot);
    const cfg = gcfg || readGleanCfg(memoryRoot);
    if (!gleanLockFreeForLaunch(cur.doc, cur.mtimeMs, cfg, nowMs)) {
      releaseGleanGuard(guard);
      return { ok: false, reason: "lock-busy" };
    }
    let raw = null;
    if (cur.present) {
      try {
        raw = fs.readFileSync(cur.file, "utf8");
      } catch {
        raw = null;
      }
    }
    const snapshot = { existed: cur.present, raw };
    const token = `${process.pid}-${nowMs}-${Math.random().toString(16).slice(2)}`;
    const doc = {
      v: 1,
      state: "active",
      pid: process.pid, // 启动器先持锁；spawn 成功后 commit 子进程 pid
      host: os.hostname(),
      root_id: gleanRootId(rootDir) || null,
      started_at: new Date(nowMs).toISOString(),
      finished_at: null,
      launcher: { pid: process.pid, slot },
      launch_token: token,
      watermarks: (cur.doc && typeof cur.doc.watermarks === "object" && cur.doc.watermarks) || {},
    };
    atomicWriteRaw(cur.file, JSON.stringify(doc) + "\n");
    return { ok: true, guard, snapshot, token, file: cur.file, memory_root: memoryRoot, root_dir: rootDir, doc };
  } catch (err) {
    releaseGleanGuard(guard);
    return { ok: false, reason: "lock-write-error", error: (err && err.message) || String(err) };
  }
}

/** 失败释放：仅当锁仍是我们这次 active（token 匹配）才回退旧快照（done/缺失原样）；
 *  gleaner 已改写 done 或他方接管 → 不覆盖。 */
function releaseGleanLock(lease) {
  if (!lease || !lease.ok) return false;
  const cur = readGleanLock(lease.memory_root);
  const ours = Boolean(cur.doc && cur.doc.state === "active" && cur.doc.launch_token === lease.token);
  if (!ours) return false;
  try {
    if (lease.snapshot && lease.snapshot.existed && lease.snapshot.raw != null) {
      atomicWriteRaw(lease.file, lease.snapshot.raw); // 回原快照（通常是 done + 旧 watermarks）
    } else {
      fs.unlinkSync(lease.file); // 原本无锁 → 回到"从未归敛"（非 busy）
    }
    return true;
  } catch {
    return false;
  }
}

/** spawn 成功后把锁持有者改记为子进程 pid（若锁仍归本次租约；gleaner 已完成则跳过）。 */
function commitGleanLockPid(lease, pid) {
  if (!lease || !lease.ok || !Number.isFinite(Number(pid))) return false;
  const cur = readGleanLock(lease.memory_root);
  if (!cur.doc || cur.doc.state !== "active" || cur.doc.launch_token !== lease.token) return false;
  try {
    const slot = cur.doc.launcher && cur.doc.launcher.slot != null ? cur.doc.launcher.slot : null;
    const next = {
      ...cur.doc,
      pid: Number(pid),
      launcher: { pid: process.pid, slot },
    };
    atomicWriteRaw(lease.file, JSON.stringify(next) + "\n");
    return true;
  } catch {
    return false; // 改记失败不影响单飞（启动器 pid 仍活）
  }
}

function finishGleanLease(lease) {
  releaseGleanGuard(lease && lease.guard);
}

/* --- 在跑子进程状态文件（sentinel/glean-launch-state.json）--------------
   成功 spawn 后写：pid + started_at + 日志 + 锁快照 + launch_token。哨兵轮换/退出
   后由新实例接管监视；退出/超时/失败时清除。它是「长冷却锚在退出」与「挂死自愈」
   的唯一锚点（锁本体只承载单飞，不承载监视）。 */
function gleanStateFile(rootDir) {
  return path.join(rootDir, "sentinel", "glean-launch-state.json");
}

function readGleanState(rootDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(gleanStateFile(rootDir), "utf8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

function writeGleanState(rootDir, doc) {
  atomicWriteRaw(gleanStateFile(rootDir), JSON.stringify(doc) + "\n");
}

/** 清除状态文件（token 不匹配 = 他人轮次，不删）。 */
function clearGleanState(rootDir, token) {
  const cur = readGleanState(rootDir);
  if (cur && token && String(cur.launch_token || "") !== String(token)) return false;
  try {
    fs.unlinkSync(gleanStateFile(rootDir));
    return true;
  } catch {
    return false;
  }
}

/** 兜底翻锁 done（锁双重保险）：仅当锁仍 active 且归本次租约（token 匹配）时写；
 *  gleaner 已自行翻 done / 他方接管 → 不动（用户裁定：两处写冲突无害，同值）。
 *  finished_at = 子进程退出/击杀时刻（下次门槛 idle 从此刻起算）。 */
function flipGleanLockDone({ memoryRoot, token, atMs }) {
  const cur = readGleanLock(memoryRoot);
  if (!cur.doc || cur.doc.state !== "active") return false;
  if (token && String(cur.doc.launch_token || "") !== String(token)) return false;
  try {
    const next = { ...cur.doc, state: "done", finished_at: new Date(atMs).toISOString() };
    atomicWriteRaw(cur.file, JSON.stringify(next) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** 失败回退旧快照（仅锁仍是我们这次 active/token 匹配时）；gleaner 已动锁则不覆盖。 */
function restoreGleanSnapshot({ memoryRoot, token, snapshot }) {
  const cur = readGleanLock(memoryRoot);
  if (!cur.doc || cur.doc.state !== "active") return false;
  if (token && String(cur.doc.launch_token || "") !== String(token)) return false;
  try {
    if (snapshot && snapshot.existed && snapshot.raw != null) {
      atomicWriteRaw(cur.file, snapshot.raw); // 回原快照（通常是 done + 旧 watermarks）
    } else {
      fs.unlinkSync(cur.file); // 原本无锁 → 回到"从未归敛"（非 busy）
    }
    return true;
  } catch {
    return false;
  }
}

/** 进程树击杀（挂死自愈）：Windows taskkill /T /F；POSIX 先杀进程组再补单进程。 */
function killGleanTree(pid) {
  if (!Number.isFinite(Number(pid))) return false;
  const p = Number(pid);
  try {
    if (process.platform === "win32") {
      const r = child_process.spawnSync("taskkill", ["/PID", String(p), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      if (r && r.status === 0) return true;
    }
  } catch {
    /* 回退到 kill 族 */
  }
  try {
    process.kill(-p, "SIGKILL"); // detached 子进程 = 独立进程组
    return true;
  } catch {
    /* 无进程组或已死 → 单进程 */
  }
  try {
    process.kill(p, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/**
 * 在跑子进程监视（每 tick 调用；与拉起判定解耦——隔离/待命期照常自愈）：
 *   - 状态文件缺失 → {state:"none"}
 *   - pid 活且龄期 < timeout → {state:"running"}
 *   - pid 活且龄期 ≥ timeout → 击杀进程树 + 翻锁 done + 长冷却 + 清状态 + stderr
 *   - pid 死且在立即退出窗内 → 失败路径：回退快照 + 短冷却 + stderr
 *   - pid 死且超过立即退出窗 → 完成路径：兜底翻锁 done + 长冷却（锚=检测时刻）
 * 任何 fs 异常都被内部 catch 吸收（返回 {state:"error"}），绝不拖垮哨兵主循环。
 */
function housekeepGleanLaunch({ rootDir, cfg, nowMs = Date.now(), killFn = killGleanTree }) {
  const st = readGleanState(rootDir);
  if (!st) return { state: "none" };
  const conf = cfg || {};
  const longCooldownMs = Number.isFinite(Number(conf.gleanLaunchCooldownMs))
    ? Number(conf.gleanLaunchCooldownMs)
    : GLEAN_LAUNCH_COOLDOWN_H_DEFAULT * 3600000;
  const shortCooldownMs = Number.isFinite(Number(conf.gleanLaunchShortCooldownMs))
    ? Number(conf.gleanLaunchShortCooldownMs)
    : GLEAN_LAUNCH_SHORT_COOLDOWN_H_DEFAULT * 3600000;
  const timeoutMs = Number.isFinite(Number(conf.gleanLaunchTimeoutMs))
    ? Number(conf.gleanLaunchTimeoutMs)
    : GLEAN_LAUNCH_TIMEOUT_MIN_DEFAULT * 60000;
  const defaultGraceMs = Number.isFinite(Number(conf.gleanLaunchGraceMs))
    ? Number(conf.gleanLaunchGraceMs)
    : GLEAN_LAUNCH_GRACE_SEC_DEFAULT * 1000;
  const token = String(st.launch_token || "");
  const pid = Number(st.pid);
  const startedMs = Date.parse(String(st.started_at ?? ""));
  const memoryRoot = String(st.memory_root || "") || gleanMemoryRoot([], conf.raw, rootDir);
  const snapshot = st.snapshot && typeof st.snapshot === "object" ? st.snapshot : null;
  const graceMs = Number.isFinite(Number(st.grace_ms)) ? Number(st.grace_ms) : defaultGraceMs;
  const logPath = String(st.log_path || "") || "";
  const longH = Math.round((longCooldownMs / 3600000) * 100) / 100;
  const shortH = Math.round((shortCooldownMs / 3600000) * 100) / 100;
  try {
    if (Number.isFinite(pid) && pidAlive(pid)) {
      const ageMs = Number.isFinite(startedMs) ? nowMs - startedMs : 0;
      if (ageMs < timeoutMs) {
        return { state: "running", pid, age_ms: Math.max(0, ageMs), log_path: logPath || null };
      }
      const killed = Boolean(killFn(pid));
      if (!killed) {
        // 击杀未确认：保持状态文件与锁（单飞不破），下一 tick 重试击杀
        try {
          process.stderr.write(
            `[bg-sentinel] glean 子进程存活超 ${Math.round(timeoutMs / 60000)} 分钟但击杀未确认（pid=${pid}）——` +
              `保持锁与状态，下轮重试\n`,
          );
        } catch {
          /* best effort */
        }
        appendLogLine(logPath, `[bg-sentinel] glean child timeout kill FAILED pid=${pid}\n`);
        return { state: "timeout-kill-failed", pid };
      }
      flipGleanLockDone({ memoryRoot, token, atMs: nowMs });
      stampGleanCooldown(rootDir, longCooldownMs, "long", nowMs);
      clearGleanState(rootDir, token);
      const mins = Math.round(timeoutMs / 60000);
      try {
        process.stderr.write(
          `[bg-sentinel] glean 子进程存活超 ${mins} 分钟（挂死自愈）——` +
            `已击杀进程树 pid=${pid}，锁已翻 done，${longH}h 内不重试\n`,
        );
      } catch {
        /* best effort */
      }
      appendLogLine(logPath, `[bg-sentinel] glean child timeout-killed pid=${pid}\n`);
      return { state: "timeout-killed", pid };
    }
    const recent = Number.isFinite(startedMs) && nowMs - startedMs <= graceMs;
    if (recent) {
      // 立即秒退（跨实例视角，无退出码）：按失败处理——回退旧快照 + 短冷却
      restoreGleanSnapshot({ memoryRoot, token, snapshot });
      stampGleanCooldown(rootDir, shortCooldownMs, "short", nowMs);
      clearGleanState(rootDir, token);
      try {
        process.stderr.write(
          `[bg-sentinel] glean 自动拉起失败（early-exit：pid=${pid} 在立即退出窗内已退出）——` +
            `锁已回退，${shortH}h 内不重试\n`,
        );
      } catch {
        /* best effort */
      }
      appendLogLine(logPath, `[bg-sentinel] launch failed: early-exit pid=${pid}\n`);
      return { state: "failed", pid };
    }
    // 正常结束（或被中途杀掉）：兜底翻锁 done + 长冷却（锚=检测到退出的时刻）
    flipGleanLockDone({ memoryRoot, token, atMs: nowMs });
    stampGleanCooldown(rootDir, longCooldownMs, "long", nowMs);
    clearGleanState(rootDir, token);
    appendLogLine(logPath, `[bg-sentinel] glean child exited pid=${pid}; lock flipped done; long cooldown\n`);
    return { state: "exited", pid };
  } catch (err) {
    return { state: "error", error: (err && err.message) || String(err) };
  }
}

/** 监视安全壳：任何异常只 stderr 一行。 */
function maybeSuperviseGlean({ rootDir, cfg, nowMs = Date.now() }) {
  try {
    return housekeepGleanLaunch({ rootDir, cfg, nowMs });
  } catch (err) {
    try {
      process.stderr.write(`[bg-sentinel] glean 监视异常（忽略）：${(err && err.message) || String(err)}\n`);
    } catch {
      /* best effort */
    }
    return { state: "error" };
  }
}

/** persona 原型（agents/orch-gleaner.md 去 frontmatter；缺失 → ""，调用方按失败处理）。 */
function readGleanerPersona() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents", "orch-gleaner.md");
    const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const m = /^---\n[\s\S]*?\n---\n+/.exec(raw);
    return (m ? raw.slice(m[0].length) : raw).trim();
  } catch {
    return "";
  }
}

/**
 * 首条消息 = persona（去 frontmatter）+ 全内联指令（用户裁定：零任务包文件读取）。
 * 锁纪律句、报告/digest/视图层/红线全部内联；不含任何"读取任务包"类指令。
 */
function buildGleanMessage({ persona, memoryRoot, rootDir, projectDir, rootId, gate }) {
  const idle = gate && gate.idleH === Number.POSITIVE_INFINITY ? "never-gleaned" : gate ? Number(gate.idleH).toFixed(1) : "?";
  const events = gate ? gate.events : "?";
  const reportPath = path.join(memoryRoot, "reports", "<YYYYMMDD-HHmmss>-glean.md");
  return [
    "你是 orch-gleaner（记忆归敛代理），由 agent-orchestrator 哨兵在后台自动拉起：独立 -p 会话，没有 board mission，也没有在线派发方。",
    `触发口径：idle ${idle}h ∧ +${events} events（glean gate due）。`,
    "",
    "【本次作业说明——persona + 本消息即全部世界，按下面内联指令执行】",
    `- 全端记忆目录：${memoryRoot}`,
    `- 项目存储根（工作区）：${rootDir}`,
    `- 项目根目录：${projectDir}`,
    "",
    "任务：执行一轮记忆归敛（与 persona 中涉及任务包/brief 的旧表述冲突时，以本内联指令为准）：",
    "1) 锁：锁已由启动器持有（state=active）；你完成归敛后把锁 state 改为 done；除此之外不要改锁。",
    `   锁文件：${gleanLockFile(memoryRoot)}`,
    `   收尾写入：state=\"done\"、finished_at=<ISO8601>、watermarks={global_lines:<全端 lessons 非空行数>, projects:{${rootId || "<root-id>"}:<项目 lessons 非空行数>}}。`,
    "2) 消费 ORCHTEMP：全端库 memory/lessons.jsonl 中 source=\"orchestrator\" 且 status=\"candidate\" 的条目逐条研判；通过则视图层落笔（带 id 溯源）后 lessons(action=\"retire\", id, reason=\"glean: → <视图文件#位置>\")；不通过留 candidate 并在报告写理由。",
    "3) 候选巡检四态处置：每条候选恰一处置——晋升（promote/promote_batch，合并语义走 server）/合并/退役/保留（证据不足留 candidate 并写理由）。",
    `4) 视图层维护：${path.join(rootDir, "ORCH.md")}（重写 ver+1，帽 120 行/10KB）；项目根 AGENTS.md 只动 orch-mem 标记对内部、区外字节零触碰（标记对缺失=该项目记忆功能关闭，跳过不重建）；${path.join(memoryRoot, "AGENTS.md")} 整文件（帽 50 行/2KB）。`,
    `5) digest（整文件原子覆盖）：${path.join(memoryRoot, "digest", "pack-tail-digest.md")}（首行 generated_at: <ISO8601>，正文 ≤12 行/1200B）与 ${path.join(memoryRoot, "digest", "pack-tail-digest.json")}（sources 源指纹）。`,
    `6) 归敛报告：${reportPath}（帽 150 行；视图变更/晋升/ORCHTEMP 消费逐条带 lessons id 溯源）。`,
    "7) 红线：不要写 board.json（哨兵与归敛对任务板只读）；lessons.jsonl 事件行永不直写（改动一律经 lessons 工具）；active 教训不硬删（只给建议）；不与其他子代理互调。",
    "8) 完成：锁置 done + 报告落盘即完成，随后自然结束；最终回复恰 ≤3 行指针（KIND=done + 报告路径 / 视图变更与四态计数 / 未处理）。",
    "",
    persona ? "【persona：agents/orch-gleaner.md（已去 frontmatter）】" : "",
    persona || "",
  ].join("\n");
}

function gleanTsCompact(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function appendLogLine(file, line) {
  if (!file) return;
  try {
    fs.appendFileSync(file, line);
  } catch {
    /* 日志绝不拖垮拉起路径 */
  }
}

/**
 * 归敛自动拉起主路径（同步决策 + 异步子进程监视）。返回：
 *   {launched:true, pid, log_path, memory_root, gate}
 * | {launched:false, reason, stage?}
 * 护栏（用户裁定）：
 *   - 单飞：锁前置获取（wx 守卫 + 先比对后写入），state 非 done 一律让位；
 *   - 成功 spawn 不写冷却，只写状态文件（pid+start+日志+锁快照）；子进程退出
 *     （无论成败，立即秒退除外）→ 释放/兜底翻锁 + 24h 长冷却（锚=退出时刻）；
 *   - spawn 异常/立即秒退（非 0/1）→ 1h 短冷却（锚=失败时刻）+ stderr；
 *   - 存活超 240 分钟 → 击杀进程树 + 翻锁 done + 24h 长冷却（挂死自愈）。
 * 拉起后哨兵继续值守（不退出、不产生完成通知）；gleaner 的 done 由文件+锁自然可见。
 */
function tryLaunchGlean({ rootDir, projectDir, argv, cfg, slot, spawnFn = child_process.spawn, nowMs = Date.now() }) {
  if (!cfg || cfg.gleanLaunchEnabled === false) return { launched: false, reason: "disabled" };
  // 1) 在跑子进程监视前置（挂死自愈 / 退出结算）；有在跑轮次即不进入拉起路径
  const hk = housekeepGleanLaunch({ rootDir, cfg, nowMs });
  if (hk.state === "running" || hk.state === "timeout-kill-failed") return { launched: false, reason: "running", pid: hk.pid };
  if (hk.state === "timeout-killed") return { launched: false, reason: "timeout-killed" };
  if (hk.state === "failed" || hk.state === "exited") return { launched: false, reason: "child-settled" };
  if (hk.state === "error") return { launched: false, reason: "state-error" };
  // 2) 冷却（长短两档共用一枚戳，until_ms 为准）
  if (gleanCooldownActive(rootDir, cfg.gleanLaunchCooldownMs, nowMs)) return { launched: false, reason: "cooldown" };
  const memoryRoot = gleanMemoryRoot(argv, cfg.raw, rootDir);
  const gcfg = readGleanCfg(memoryRoot);
  const gate = gleanGateCheck(memoryRoot, rootDir, gcfg, nowMs);
  if (gate.busy) return { launched: false, reason: "lock-busy" };
  if (!gate.due) return { launched: false, reason: "not-due", stage: gate.stage };

  const lease = acquireGleanLock({ rootDir, memoryRoot, slot, gcfg, nowMs });
  if (!lease.ok) return { launched: false, reason: lease.reason };
  const shortH = Math.round((cfg.gleanLaunchShortCooldownMs / 3600000) * 100) / 100;
  const fail = (reason, detail, logPath) => {
    const restored = releaseGleanLock(lease);
    stampGleanCooldown(rootDir, cfg.gleanLaunchShortCooldownMs, "short", Date.now());
    try {
      process.stderr.write(
        `[bg-sentinel] glean 自动拉起失败（${reason}${detail ? "：" + detail : ""}）——` +
          `${restored ? "锁已回退" : "锁未回退"}，${shortH}h 内不重试\n`,
      );
    } catch {
      /* stderr 不可写不阻塞 */
    }
    appendLogLine(logPath, `[bg-sentinel] launch failed: ${reason}${detail ? " " + detail : ""}\n`);
    return { launched: false, reason };
  };
  let logPath = "";
  try {
    // 租约内复检冷却（防御：兄弟实例刚拉起/刚失败落戳后本实例才进入）
    if (gleanCooldownActive(rootDir, cfg.gleanLaunchCooldownMs, Date.now())) {
      releaseGleanLock(lease);
      return { launched: false, reason: "cooldown" };
    }
    const persona = readGleanerPersona();
    if (!persona) return fail("persona-missing", "agents/orch-gleaner.md 不可读", logPath);
    const message = buildGleanMessage({
      persona,
      memoryRoot,
      rootDir,
      projectDir,
      rootId: gate.rootId || gleanRootId(rootDir),
      gate,
    });
    const cliRaw = String(process.env.ZCODE_CLI_PATH || "").trim();
    const cliPath =
      cliRaw && !cliRaw.startsWith("${") ? path.resolve(projectDir, cliRaw) : GLEAN_CLI_DEFAULT;
    const ctxDir = path.join(rootDir, "context");
    fs.mkdirSync(ctxDir, { recursive: true });
    logPath = path.join(ctxDir, `glean-launch-${gleanTsCompact()}.log`);
    let child = null;
    let fd = null;
    try {
      fd = fs.openSync(logPath, "a");
      appendLogLine(
        logPath,
        `[bg-sentinel] glean launch at ${new Date(nowMs).toISOString()} slot=${slot} cli=${cliPath} ` +
          `idle=${gate.idleH === Number.POSITIVE_INFINITY ? "never" : gate.idleH.toFixed(1)}h events=${gate.events}\n`,
      );
      try {
        child = spawnFn(process.execPath, [cliPath, "-p", message, "--json", "--mode", "yolo"], {
          detached: true, // 独立会话；哨兵退出/轮换不连带
          stdio: ["ignore", fd, fd], // stdout JSON + stderr → 日志（死后诊断）
          windowsHide: true,
          cwd: projectDir,
          env: process.env,
        });
      } finally {
        try {
          if (fd != null) fs.closeSync(fd);
        } catch {
          /* best effort */
        }
        fd = null;
      }
    } catch (err) {
      try {
        if (fd != null) fs.closeSync(fd);
      } catch {
        /* best effort */
      }
      return fail("spawn-error", (err && err.message) || String(err), logPath);
    }
    if (!child || !Number.isFinite(Number(child.pid))) {
      try {
        if (child && typeof child.kill === "function") child.kill();
      } catch {
        /* best effort */
      }
      return fail("spawn-error", "spawn 未返回 pid", logPath);
    }
    const pid = Number(child.pid);
    commitGleanLockPid(lease, pid); // 锁持有者改记子进程（死亡即可回收）
    // 成功 spawn：不写冷却，只落状态文件（pid+start+日志+锁快照）供监视/跨实例接管
    try {
      writeGleanState(rootDir, {
        v: 1,
        pid,
        started_at: new Date(Date.now()).toISOString(),
        log_path: logPath,
        memory_root: memoryRoot,
        root_dir: rootDir,
        launch_token: lease.token,
        grace_ms: cfg.gleanLaunchGraceMs,
        snapshot: lease.snapshot,
      });
    } catch (err) {
      try {
        if (typeof child.kill === "function") child.kill();
      } catch {
        /* best effort */
      }
      return fail("state-write-error", (err && err.message) || String(err), logPath);
    }
    const spawnTickMs = Date.now();
    // 冷却时长走同一默认兜底（外部调用注入稀疏 cfg 时也安全）
    const longCooldownMs = Number.isFinite(Number(cfg.gleanLaunchCooldownMs))
      ? Number(cfg.gleanLaunchCooldownMs)
      : GLEAN_LAUNCH_COOLDOWN_H_DEFAULT * 3600000;
    const shortCooldownMs = Number.isFinite(Number(cfg.gleanLaunchShortCooldownMs))
      ? Number(cfg.gleanLaunchShortCooldownMs)
      : GLEAN_LAUNCH_SHORT_COOLDOWN_H_DEFAULT * 3600000;
    let settled = false;
    /** 子进程结算（幂等）：失败 → 回退快照 + 短冷却；正常 → 兜底翻锁 done + 长冷却。
     *  若监视路径（超时/跨实例）已结算（状态文件消失/token 不符）→ 不重复写。 */
    const settleChild = (outcome, reason, detail) => {
      if (settled) return;
      const curState = readGleanState(rootDir);
      if (!curState || String(curState.launch_token || "") !== String(lease.token)) return; // 已被监视路径结算
      settled = true;
      const atMs = Date.now();
      if (outcome === "fail") {
        const restored = restoreGleanSnapshot({ memoryRoot, token: lease.token, snapshot: lease.snapshot });
        stampGleanCooldown(rootDir, shortCooldownMs, "short", atMs);
        try {
          process.stderr.write(
            `[bg-sentinel] glean 自动拉起失败（${reason}${detail ? "：" + detail : ""}）——` +
              `${restored ? "锁已回退" : "锁未回退"}，${shortH}h 内不重试\n`,
          );
        } catch {
          /* best effort */
        }
        appendLogLine(logPath, `[bg-sentinel] launch failed: ${reason}${detail ? " " + detail : ""}\n`);
      } else {
        const flipped = flipGleanLockDone({ memoryRoot, token: lease.token, atMs }); // gleaner 已翻 done → no-op
        const longH = Math.round((longCooldownMs / 3600000) * 100) / 100;
        stampGleanCooldown(rootDir, longCooldownMs, "long", atMs);
        appendLogLine(
          logPath,
          `[bg-sentinel] glean child exited (${reason}${detail ? " " + detail : ""}); lock_flipped=${flipped}; ${longH}h cooldown\n`,
        );
      }
      clearGleanState(rootDir, lease.token);
    };
    try {
      child.on("error", (err) => settleChild("fail", "spawn-error", (err && err.message) || String(err)));
    } catch {
      /* 桩/异常实现无 on → 交由返回值判定 */
    }
    try {
      child.on("exit", (code, signal) => {
        appendLogLine(
          logPath,
          `[bg-sentinel] glean child exit code=${code} signal=${signal || "-"} after ${Date.now() - spawnTickMs}ms\n`,
        );
        // 立即秒退非 0/1 = 启动失败（短冷却）；0/1 与超窗退出按正常结算（长冷却）
        const graceMs = Number.isFinite(Number(cfg.gleanLaunchGraceMs))
          ? Number(cfg.gleanLaunchGraceMs)
          : GLEAN_LAUNCH_GRACE_SEC_DEFAULT * 1000;
        if (Date.now() - spawnTickMs <= graceMs && !(code === 0 || code === 1)) {
          settleChild("fail", "early-exit", `code=${code}${signal ? " signal=" + signal : ""}`);
        } else {
          settleChild("ok", "exited", `code=${code}${signal ? " signal=" + signal : ""}`);
        }
      });
    } catch {
      /* best effort */
    }
    try {
      if (typeof child.unref === "function") child.unref();
    } catch {
      /* best effort */
    }
    return {
      launched: true,
      pid,
      log_path: logPath,
      memory_root: memoryRoot,
      gate: { idle_h: gate.idleH === Number.POSITIVE_INFINITY ? null : gate.idleH, events: gate.events },
    };
  } finally {
    finishGleanLease(lease);
  }
}

/** tick 内安全壳：任何异常只 stderr 一行，绝不拖垮哨兵主循环。 */
function maybeLaunchGlean(p) {
  try {
    return tryLaunchGlean(p);
  } catch (err) {
    try {
      process.stderr.write(`[bg-sentinel] glean 自动拉起检查异常（忽略）：${(err && err.message) || String(err)}\n`);
    } catch {
      /* best effort */
    }
    return { launched: false, reason: "exception" };
  }
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
      // v1.1.1 W-B 哨兵 drain：队列滞留阈值（grill#wake Q5 裁定 120s=2 tick；测试加速可覆盖）
      wakeQueueStaleMs: numArg(argv, "--wake-queue-stale-sec", c, "wake_queue_stale_sec", 120, 1, 3600) * 1000,
      // v1.1.1 W23/A2 归敛自动拉起（默认启用；长/短冷却、立即退出窗、挂死超时均可调）
      gleanLaunchEnabled: boolArg(argv, "--glean-launch-enabled", c, "glean_launch_enabled", true),
      gleanLaunchCooldownMs:
        numArg(argv, "--glean-launch-cooldown-hours", c, "glean_launch_cooldown_hours", GLEAN_LAUNCH_COOLDOWN_H_DEFAULT, 0.01, 8760) * 3600000,
      gleanLaunchShortCooldownMs:
        numArg(argv, "--glean-launch-short-cooldown-hours", c, "glean_launch_short_cooldown_hours", GLEAN_LAUNCH_SHORT_COOLDOWN_H_DEFAULT, 0.01, 8760) * 3600000,
      gleanLaunchGraceMs:
        numArg(argv, "--glean-launch-grace-sec", c, "glean_launch_grace_sec", GLEAN_LAUNCH_GRACE_SEC_DEFAULT, 0, 600) * 1000,
      gleanLaunchTimeoutMs:
        numArg(argv, "--glean-launch-timeout-min", c, "glean_launch_timeout_min", GLEAN_LAUNCH_TIMEOUT_MIN_DEFAULT, 0.01, 43200) * 60000,
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
  let catchupDone = false; // v1.2 M9-1 REV③：复活补告警每实例生命周期至多一次

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

    // v1.1.1 W-B 哨兵 drain：wake-queue 滞留件（mtime ≥ wake_queue_stale_sec，默认
    // 120s=2 tick）视为 kick 失败遗留 → 补一脚 kick（注入判定面全在 kick 内）。
    // 置于板面逻辑之前：待命/隔离/板不可读期 drain 照跑（队列=未唤备忘，不因板面
    // 状态失能）；门口：队列空/认领持有中 → 静默（零日志零副作用）。
    {
      const wq = wakeQueueScan(root, cfg.wakeQueueStaleMs, Date.now());
      if (wq.total > 0 && wq.stranded > 0 && !wq.claimHeld) {
        spawnWakeKick(root, projectDir, cfg.wakeQueueStaleMs);
      }
    }

    // v1.1.1 W23/A2：归敛自动拉起（每 tick 一次；监视前置，冷却戳 stat 先行）。
    // 监视（在跑子进程/挂死自愈）无条件执行；拉起判定在隔离值守期跳过（板面异常
    // 时不做新动作）。任何异常只 stderr 一行，绝不拖垮哨兵主循环。
    // 位置在 standby 节流之前：待命期也持续满足「伴随即拉起」的用户口径。
    maybeSuperviseGlean({ rootDir: root, cfg });
    if (!quarantined) {
      maybeLaunchGlean({ rootDir: root, projectDir, argv, cfg, slot });
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

    // v1.2 M9-1 REV③ 补告警（宽限阈值复核结论：HEARTBEAT_STALE_MS 90s=槽位判死/在岗
    // 判定刻度 ≠ wake 升级阈值 wake/answer/stall/crash_grace——两族常量无 conflation）：
    // 复活/自补员后的首扫，对本实例启动前已到期升级（anchorMs < startedAt 且已 matured）
    // 的条件集中补告警一次，缝合团灭期的告警断档。仅回声留痕——不额外开枪不退出，
    // 正常开枪路径按自身 eligibility/refire/cap 独立进行；每实例生命周期至多一次。
    // O10 协同：条件锚一律取自 board timeline（重派 upsert 事件即最新活动锚），首扫
    // 以板面为据，已豁免重派 mission 不会因复活丢内存态而误判双跑。
    if (!catchupDone) {
      const missed = conds.filter((c) => matured(c) && c.anchorMs < startedAt);
      if (missed.length) {
        catchupDone = true;
        const heads = missed
          .slice(0, 5)
          .map((c) => `${c.key} ${c.category}`)
          .join("、");
        appendEcho(
          root,
          [{ key: "__catchup__", category: "catchup", final: false }],
          `补告警：哨兵缺位期间到期升级 ${missed.length} 件（${heads}${missed.length > 5 ? " 等" : ""}）——复活首扫集中补发一次`,
          {},
        );
      }
    }

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
