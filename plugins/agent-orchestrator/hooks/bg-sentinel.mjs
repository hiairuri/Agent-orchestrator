#!/usr/bin/env node
/**
 * agent-orchestrator bg-sentinel（签收驱动的唤醒哨兵）。零依赖单文件，Node >= 18。
 *
 * 唯一启动方式：主控以宿主后台任务运行（rev.b：无 detached 看门狗模式——平台事实：
 * detached 进程不是宿主任务，退出不产生通知，无法唤醒）：
 *   Bash(command="node <插件根>/hooks/bg-sentinel.mjs --once", run_in_background=true)
 * 退出 = 完成通知：主控空闲时开新回合、忙时并入当前回合。
 *
 * 语义："完成后激活轮询，设超时；超时且主控未签收，则尝试叫醒主控；达重试次数后放弃并报错。"
 *
 * 退出条件：
 *   - 无在飞 mission（dispatched/running/resumed）且无未签收终态（W1–W4）
 *       → exit 0，"[orch-sentinel] 无在飞任务且结果全部已签收，哨兵自毁。"（安静通知，无害）
 *   - 未签收结果持续跨越 wake_retries 个 wake_timeout_min 超时窗口
 *       → exit 1 + 醒目告警 summary（叫醒主控）
 *   - 寿命 ≥ max_lifetime（默认 24h）→ exit 0 安静行；持锁者存活 → exit 0 让位
 *
 * 配置优先级：CLI > <存储根>/sentinel.cfg.json（server 启动时从 userConfig 写出）> 内建默认。
 * 对 board.json/spool 只读；落盘只写 sentinel.lock。
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_POLL_SEC = 60;
const DEFAULT_TIMEOUT_MIN = 10;
const DEFAULT_RETRIES = 3;
const DEFAULT_LIFETIME_MIN = 1440; // 24h 自限，防孤儿
const RESULT_STATUSES = ["done", "failed", "blocked", "question"];
const IN_FLIGHT_STATUSES = ["dispatched", "running", "resumed"];

function parseArg(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1] ?? "";
    if (argv[i].startsWith(flag + "=")) return argv[i].slice(flag.length + 1);
  }
  return undefined;
}

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

function locateRoot(projectDir) {
  const defaultRoot = path.join(projectDir, ".zcode", "orchestrator");
  try {
    const pointer = path.join(defaultRoot, "root.txt");
    if (fs.existsSync(pointer)) {
      const custom = fs.readFileSync(pointer, "utf8").trim();
      if (custom) return custom;
    }
  } catch {
    /* fall through */
  }
  return defaultRoot;
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
  const minutes = Number.isFinite(ms) ? Math.floor((Date.now() - ms) / 60000) : null;
  return { suspected: true, result_at: resultAt == null ? null : resultAt, minutes };
}

function fmtAge(min) {
  if (min == null || !Number.isFinite(min)) return "";
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟前`;
}

/** 读 board：null = 本 tick 无正据（文件缺失/读取/解析失败）——跳过本 tick，绝不据此退出。 */
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

function main() {
  const argv = process.argv.slice(2);
  const projectDir = process.env.ZCODE_PROJECT_DIR || process.cwd();
  const rootRaw = parseArg(argv, "--root");
  const root =
    rootRaw && !String(rootRaw).startsWith("${") ? path.resolve(String(rootRaw)) : locateRoot(projectDir);
  fs.mkdirSync(root, { recursive: true });

  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(root, "sentinel.cfg.json"), "utf8")) || {};
  } catch {
    cfg = {};
  }

  // --once 接受并忽略：当前唯一模式即"单轮盯守、全清自毁"。
  const pollMs = numArg(argv, "--poll-sec", cfg, "wake_poll_sec", DEFAULT_POLL_SEC, 1, 3600) * 1000;
  const timeoutMs =
    numArg(argv, "--wake-timeout-min", cfg, "wake_timeout_min", DEFAULT_TIMEOUT_MIN, 0.01, 1440) * 60000;
  const retries = Math.round(numArg(argv, "--wake-retries", cfg, "wake_retries", DEFAULT_RETRIES, 1, 100));
  const lifetimeMs =
    numArg(argv, "--max-lifetime-min", cfg, "max_lifetime_min", DEFAULT_LIFETIME_MIN, 0.01, 43200) * 60000;
  const lockPath = path.join(root, "sentinel.lock");
  const startedAt = Date.now();

  // --- 锁：wx 原子创建；持锁者存活 → 静默让位；死锁/坏锁 → 接管 ---
  const lockDoc = { pid: process.pid, started_at: new Date(startedAt).toISOString() };
  try {
    fs.writeFileSync(lockPath, JSON.stringify(lockDoc) + "\n", { flag: "wx" });
  } catch {
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      /* 坏锁 */
    }
    if (holder && Number.isFinite(holder.pid) && pidAlive(holder.pid)) process.exit(0);
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ ...lockDoc, took_over: true }) + "\n");
    } catch {
      process.exit(0);
    }
  }

  const finish = (code, summary) => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* best effort */
    }
    if (summary) process.stdout.write(summary + "\n");
    process.exit(code);
  };

  const tick = () => {
    if (Date.now() - startedAt >= lifetimeMs) {
      finish(0, "[orch-sentinel] 哨兵达到最大寿命，静默退出。");
      return;
    }
    const board = readBoardSafe(root);
    if (board === null) {
      setTimeout(tick, pollMs); // 无正据不决策
      return;
    }
    const missions = Array.isArray(board.missions) ? board.missions : [];
    const inFlight = missions.filter((m) => m && IN_FLIGHT_STATUSES.includes(m.status));
    const suspected = missions.filter((m) => wakeFailureInfo(m).suspected);
    if (!inFlight.length && !suspected.length) {
      finish(0, "[orch-sentinel] 无在飞任务且结果全部已签收，哨兵自毁。");
      return;
    }
    if (suspected.length) {
      const times = suspected
        .map((m) => Date.parse(wakeFailureInfo(m).result_at ?? ""))
        .filter((t) => Number.isFinite(t));
      if (times.length) {
        const oldest = Math.min(...times);
        const due = Math.floor((Date.now() - oldest) / timeoutMs);
        if (due >= retries) {
          const rows = suspected.slice(0, 5).map((m) => {
            const w = wakeFailureInfo(m);
            const title = String(m.title || "(未命名)").replace(/\s+/g, " ").slice(0, 30);
            const age = w.result_at ? `｜结果于 ${fmtAge(w.minutes)}` : "";
            return `- [${m.id}] ${title}｜${m.status}${age}｜未签收`;
          });
          const summary =
            "[orch-sentinel] 唤醒失败告警：以下任务结果已落盘但主控迟迟未签收" +
            `（每 ${Math.round(timeoutMs / 60000)} 分钟计一次超时，共 ${retries} 次）。` +
            "请立即 mailbox(read) 接手并 answer/close（自动签收）；" +
            "处置后可重新以后台任务运行 hooks/bg-sentinel.mjs --once 继续盯守：\n" +
            rows.join("\n");
          finish(1, summary);
          return;
        }
      }
    }
    setTimeout(tick, pollMs);
  };

  tick();
}

try {
  main();
} catch {
  process.exit(0);
}
