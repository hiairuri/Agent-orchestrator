/**
 * bg-sentinel/glean-launch.mjs —— 归敛自动拉起（v1.1.1 W23 / A2）：
 * 门槛复刻 + 锁前置 + 冷却双档 + 挂死自愈 + headless spawn。
 * 自 bg-sentinel.mjs 机械拆分（纯搬运 + import/export 接线，零行为变更）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";
import { fileURLToPath } from "node:url";
import { isTempLikeDir, parseArg, pidAlive } from "./core.mjs";

/* ================================================================== */
/* 归敛自动拉起（v1.1.1 W23 / A2）：门槛复刻 + 锁前置 + headless 拉起    */
/* ================================================================== */

/* 门槛口径逐字复刻 server.mjs 的 glean_due（readGleanCfg / gleanLockInfo /
   evaluateGleanGate / countEvents），只读、不写 board、不改 server。锁与冷却
   是哨兵自有产物（<root>/sentinel/），全端目录默认 ~/.zcode/orchestrator-memory
   （temp 根自包含 <root>/orchestrator-memory，与 server 的测试 carve-out 同款）。
   v1.3 W1：busy_channel_events 同键同值（默认 40，0=合法关断）随本复刻面同步。 */
export const GLEAN_CFG_DEFAULTS = { idle_hours: 48, new_events: 10, lock_stale_hours: 1.5, busy_channel_events: 40 };
export const GLEAN_LAUNCH_COOLDOWN_H_DEFAULT = 24; // 成功拉起→子进程退出后的长冷却（锚=退出时刻）
export const GLEAN_LAUNCH_SHORT_COOLDOWN_H_DEFAULT = 1; // 拉起失败（spawn 异常/立即秒退）短冷却（锚=失败时刻）
export const GLEAN_LAUNCH_GRACE_SEC_DEFAULT = 15; // 立即退出判定窗（秒）
export const GLEAN_LAUNCH_TIMEOUT_MIN_DEFAULT = 240; // 子进程存活上限（分钟）→ 击杀进程树 + 释放锁 + 长冷却
export const GLEAN_GUARD_STALE_MS = 60 * 1000; // 获取租约守卫文件陈旧窗（进程崩溃后的夺位条件）
export const GLEAN_CLI_DEFAULT = "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs";

/** 全端记忆目录：CLI > cfg > env ZCODE_ORCH_MEMORY > temp 根自包含 > ~/.zcode/orchestrator-memory。
 *  temp 根自包含与 server resolveMemoryRoot 的测试 carve-out 同语义——套件绝不碰真实家目录。 */
export function gleanMemoryRoot(argv, rawCfg, rootDir) {
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
export function readGleanCfg(memoryRoot) {
  const defaults = { ...GLEAN_CFG_DEFAULTS };
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(memoryRoot, "glean.cfg.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const cfg = { ...defaults, ...parsed };
      if (!Number.isFinite(Number(cfg.idle_hours)) || Number(cfg.idle_hours) < 0) cfg.idle_hours = defaults.idle_hours;
      if (!Number.isFinite(Number(cfg.new_events)) || Number(cfg.new_events) < 0) cfg.new_events = defaults.new_events;
      // v1.3 W1: 0=合法关断值不回落（仅 junk/负值回落 40），与 server readGleanCfg 同口径
      if (!Number.isFinite(Number(cfg.busy_channel_events)) || Number(cfg.busy_channel_events) < 0)
        cfg.busy_channel_events = defaults.busy_channel_events;
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
export function lessonsLineCount(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/** 项目存储根 root-id（server 恒写 16 hex；缺失 → "" = 水位数按 0 计）。 */
export function gleanRootId(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, "root-id"), "utf8").trim();
    return /^[0-9a-f]{16}$/.test(raw) ? raw : "";
  } catch {
    return "";
  }
}

export function gleanLockFile(memoryRoot) {
  return path.join(memoryRoot, "glean-lock.json");
}

/** 只读锁快照（缺失 = 从未归敛）。 */
export function readGleanLock(memoryRoot) {
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
export function gleanLockBusy(doc, mtimeMs, gcfg, nowMs) {
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
export function gleanLockFreeForLaunch(doc, mtimeMs, gcfg, nowMs) {
  if (!doc || typeof doc !== "object") return true;
  if (doc.state === "done") return true;
  if (doc.state !== "active") return false;
  return !gleanLockBusy(doc, mtimeMs, gcfg, nowMs);
}

/**
 * gate 真值表（复刻 server evaluateGleanGate，成本序：时间 → 常忙腿 cfg 前置 → 事件数 → 锁）：
 * lastGleanMs = finished_at 优先、mtime 兜底；从未归敛 = idle ∞。
 * 事件数 = max(0, 项目 lessons 行数 - wmProjects[rootId]) + max(0, 全端行数 - wmGlobal)。
 * v1.3 W1 A：due ⇔ 闲时腿 ∨ 常忙腿（busy_channel_events>0 ∧ events≥busy，仅时间门不过时
 * 可达；0=合法关断恒走旧双门）；两腿分支互斥，事件计数惰性单读。
 */
export function gleanGateCheck(memoryRoot, rootDir, gcfg, nowMs) {
  const lock = readGleanLock(memoryRoot);
  const finished = lock.doc ? Date.parse(String(lock.doc.finished_at ?? "")) : NaN;
  const lastGleanMs = Number.isFinite(finished) ? finished : lock.present ? lock.mtimeMs : 0;
  const idleMs = lastGleanMs > 0 ? Math.max(0, nowMs - lastGleanMs) : Number.POSITIVE_INFINITY;
  const idleH = idleMs / 3600000;
  const busy = gleanLockBusy(lock.doc, lock.mtimeMs, gcfg, nowMs);
  const countEvents = () => {
    const rootId = gleanRootId(rootDir);
    const wm = lock.doc && lock.doc.watermarks && typeof lock.doc.watermarks === "object" ? lock.doc.watermarks : {};
    const wmProject = Number(wm.projects && wm.projects[rootId]) || 0;
    const wmGlobal = Number(wm.global_lines) || 0;
    return (
      Math.max(0, lessonsLineCount(path.join(rootDir, "memory", "lessons.jsonl")) - wmProject) +
      Math.max(0, lessonsLineCount(path.join(memoryRoot, "memory", "lessons.jsonl")) - wmGlobal)
    );
  };
  if (!(idleH > Number(gcfg.idle_hours))) {
    // 常忙腿（v1.3 W1 A，与 server evaluateGleanGate 同口径）：cfg 前置 → 事件计数 → 锁仲裁
    const busyN = Number(gcfg.busy_channel_events);
    if (!(busyN > 0)) return { due: false, stage: "time", idleH, events: null, busy, lock, rootId: null };
    const rootId = gleanRootId(rootDir);
    const events = countEvents();
    if (!(events >= busyN)) return { due: false, stage: "time", idleH, events, busy, lock, rootId };
    if (busy) return { due: false, stage: "lock", idleH, events, busy: true, lock, rootId };
    return { due: true, idleH, events, busy: false, lock, rootId, via: "busy" };
  }
  const rootId = gleanRootId(rootDir);
  const events = countEvents();
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
export function gleanStampFile(rootDir) {
  return path.join(rootDir, "sentinel", "glean-launch-stamp");
}

/** 冷却状态 {active, untilMs, kind}；坏内容/mtime-only 按长冷却兜底。 */
export function gleanCooldownState(rootDir, fallbackLongMs, nowMs = Date.now()) {
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

export function gleanCooldownActive(rootDir, fallbackLongMs, nowMs = Date.now()) {
  return gleanCooldownState(rootDir, fallbackLongMs, nowMs).active;
}

/** 写冷却戳（覆盖写；原子 tmp+rename）。kind ∈ {long, short}。 */
export function stampGleanCooldown(rootDir, ms, kind, nowMs = Date.now()) {
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
export function gleanGuardFile(rootDir) {
  return path.join(rootDir, "sentinel", "glean-launch.lock");
}

export function acquireGleanGuard(rootDir, slot) {
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

export function releaseGleanGuard(guard) {
  if (!guard || !guard.ok) return;
  try {
    fs.unlinkSync(guard.path);
  } catch {
    /* best effort */
  }
}

export function atomicWriteRaw(file, raw) {
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
export function acquireGleanLock({ rootDir, memoryRoot, slot, gcfg, nowMs = Date.now() }) {
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
export function releaseGleanLock(lease) {
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
export function commitGleanLockPid(lease, pid) {
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

export function finishGleanLease(lease) {
  releaseGleanGuard(lease && lease.guard);
}

/* --- 在跑子进程状态文件（sentinel/glean-launch-state.json）--------------
   成功 spawn 后写：pid + started_at + 日志 + 锁快照 + launch_token。哨兵轮换/退出
   后由新实例接管监视；退出/超时/失败时清除。它是「长冷却锚在退出」与「挂死自愈」
   的唯一锚点（锁本体只承载单飞，不承载监视）。 */
export function gleanStateFile(rootDir) {
  return path.join(rootDir, "sentinel", "glean-launch-state.json");
}

export function readGleanState(rootDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(gleanStateFile(rootDir), "utf8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

export function writeGleanState(rootDir, doc) {
  atomicWriteRaw(gleanStateFile(rootDir), JSON.stringify(doc) + "\n");
}

/** 清除状态文件（token 不匹配 = 他人轮次，不删）。 */
export function clearGleanState(rootDir, token) {
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
export function flipGleanLockDone({ memoryRoot, token, atMs }) {
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
export function restoreGleanSnapshot({ memoryRoot, token, snapshot }) {
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
export function killGleanTree(pid) {
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
export function housekeepGleanLaunch({ rootDir, cfg, nowMs = Date.now(), killFn = killGleanTree }) {
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
export function maybeSuperviseGlean({ rootDir, cfg, nowMs = Date.now() }) {
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
export function readGleanerPersona() {
  try {
    // 拆分接线：本模块位于 hooks/bg-sentinel/ 下，回退两级到插件根（原单文件在 hooks/ 下只回退一级）
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents", "orch-gleaner.md");
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
export function buildGleanMessage({ persona, memoryRoot, rootDir, projectDir, rootId, gate }) {
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

export function gleanTsCompact(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function appendLogLine(file, line) {
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
export function tryLaunchGlean({ rootDir, projectDir, argv, cfg, slot, spawnFn = child_process.spawn, nowMs = Date.now() }) {
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
export function maybeLaunchGlean(p) {
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
