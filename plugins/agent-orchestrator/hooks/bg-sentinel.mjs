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
 *   - 无在飞 mission（dispatched/running/resumed，workflow 模式除外）且无未签收终态
 *       → exit 0；仅剩 workflow 在飞时文案为"workflow 托管中，其余已签收"（B4）
 *   - 未签收结果持续跨越 wake_retries 个 wake_timeout_min 超时窗口
 *       → exit 1 + 醒目告警 summary（叫醒主控）
 *   - 非 workflow 在飞任务龄期（timeline 末事件起算）≥ retries×timeout（B1，含
 *       resumed/running 崩死盲区）→ exit 1 告警
 *   - board 连续 3 tick 不可读（缺失/损坏）→ exit 1 "任务板不可读"（B2）
 *   - 寿命 ≥ max_lifetime（默认 24h）→ exit 0 安静行
 *
 * v0.3.1 修复：B1 在飞龄期告警；B2 坏板 3 tick 告警；B3 锁心跳（每 tick touch，
 *   接管判定=pid 死或心跳龄>90s）；B4 workflow 口径；B5 result_at 回退链
 *   （timeline→updated_at→board mtime→直接告警）；B6 每 tick 重读 sentinel.cfg.json；
 *   B7 时钟跳变 elapsed 负值钳 0。
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
const HEARTBEAT_STALE_MS = 90000; // B3: 心跳龄 >90s 视为不在岗
const BOARD_BAD_TICKS_LIMIT = 3; // B2: 连续不可读 tick 上限

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
  // B7: clock jumps must not produce negative ages.
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

function main() {
  const argv = process.argv.slice(2);
  const projectDir = process.env.ZCODE_PROJECT_DIR || process.cwd();
  const rootRaw = parseArg(argv, "--root");
  const root =
    rootRaw && !String(rootRaw).startsWith("${") ? path.resolve(String(rootRaw)) : locateRoot(projectDir);
  fs.mkdirSync(root, { recursive: true });

  const boardPath = path.join(root, "board.json");
  const cfgPath = path.join(root, "sentinel.cfg.json");
  const lockPath = path.join(root, "sentinel.lock");
  const startedAt = Date.now();

  // B6: cfg is re-read every tick (CLI args still win over the file).
  const readCfg = () => {
    try {
      return JSON.parse(fs.readFileSync(cfgPath, "utf8")) || {};
    } catch {
      return {};
    }
  };

  // --- 锁：wx 原子创建；持锁者存活且心跳新鲜 → 静默让位；pid 死或心跳龄>90s → 接管（B3） ---
  let tookOver = false; // 心跳 touch 时保留接管痕迹（可观测性）
  const lockDoc = () => ({
    pid: process.pid,
    started_at: new Date(startedAt).toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...(tookOver ? { took_over: true } : {}),
  });
  const lockFresh = (doc, mtimeMs) => {
    if (!doc || !Number.isFinite(doc.pid) || !pidAlive(doc.pid)) return false;
    const hb = Date.parse(String(doc.heartbeatAt ?? ""));
    let age = Number.isFinite(hb) ? Date.now() - hb : NaN; // B7
    if (!Number.isFinite(age)) {
      age = Number.isFinite(mtimeMs) ? Date.now() - mtimeMs : Number.POSITIVE_INFINITY;
    }
    return Math.max(0, age) <= HEARTBEAT_STALE_MS;
  };
  try {
    fs.writeFileSync(lockPath, JSON.stringify(lockDoc()) + "\n", { flag: "wx" });
  } catch {
    let holder = null;
    let holderMtime = NaN;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      /* 坏锁 */
    }
    try {
      holderMtime = fs.statSync(lockPath).mtimeMs;
    } catch {
      /* gone */
    }
    if (lockFresh(holder, holderMtime)) process.exit(0);
    try {
      tookOver = true;
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ ...lockDoc(), prev: holder ?? null }) + "\n",
      );
    } catch {
      process.exit(0);
    }
  }

  // B3: heartbeat touch every tick (mtime + heartbeatAt advance together).
  const touchLock = () => {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(lockDoc()) + "\n");
    } catch {
      /* best effort */
    }
  };

  const finish = (code, summary) => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* best effort */
    }
    if (summary) process.stdout.write(summary + "\n");
    process.exit(code);
  };

  let unreadableTicks = 0;

  const tick = () => {
    const cfg = readCfg(); // B6
    const pollMs = numArg(argv, "--poll-sec", cfg, "wake_poll_sec", DEFAULT_POLL_SEC, 1, 3600) * 1000;
    const timeoutMs =
      numArg(argv, "--wake-timeout-min", cfg, "wake_timeout_min", DEFAULT_TIMEOUT_MIN, 0.01, 1440) * 60000;
    const retries = Math.round(numArg(argv, "--wake-retries", cfg, "wake_retries", DEFAULT_RETRIES, 1, 100));
    const lifetimeMs =
      numArg(argv, "--max-lifetime-min", cfg, "max_lifetime_min", DEFAULT_LIFETIME_MIN, 0.01, 43200) * 60000;

    touchLock(); // B3

    if (Date.now() - startedAt >= lifetimeMs) {
      finish(0, "[orch-sentinel] 哨兵达到最大寿命，静默退出。");
      return;
    }

    let boardMtime = NaN;
    try {
      boardMtime = fs.statSync(boardPath).mtimeMs;
    } catch {
      /* missing board counts as unreadable below */
    }
    const board = readBoardSafe(root);
    if (board === null) {
      unreadableTicks += 1; // B2
      if (unreadableTicks >= BOARD_BAD_TICKS_LIMIT) {
        finish(
          1,
          `[orch-sentinel] 任务板不可读告警：连续 ${unreadableTicks} 次轮询读取 board.json 失败` +
            `（缺失/损坏）。请检查存储根 ${root} 下的 board.json；修复前哨兵无法盯守，现退出。`,
        );
        return;
      }
      setTimeout(tick, pollMs); // 无正据不决策，但只容忍有限次数
      return;
    }
    unreadableTicks = 0;

    const missions = Array.isArray(board.missions) ? board.missions : [];
    const isWorkflow = (m) => (m.dispatch && m.dispatch.mode) === "workflow";
    const inFlightAll = missions.filter((m) => m && IN_FLIGHT_STATUSES.includes(m.status));
    const inFlight = inFlightAll.filter((m) => !isWorkflow(m)); // B4: workflow 由宿主通知
    const workflowInFlight = inFlightAll.filter(isWorkflow);
    const suspected = missions.filter((m) => wakeFailureInfo(m).suspected);

    if (!inFlight.length && !suspected.length) {
      if (workflowInFlight.length) {
        // B4: workflow runs are hosted (the platform notifies on completion);
        // never claim "all results claimed" when workflow missions remain.
        finish(0, "[orch-sentinel] workflow 托管中，其余已签收，哨兵自毁。（workflow 由宿主完成通知，无需盯守）");
        return;
      }
      finish(0, "[orch-sentinel] 无在飞任务且结果全部已签收，哨兵自毁。");
      return;
    }

    const windowMs = timeoutMs * retries;

    // 未签收终态：超时窗口计数（B5 回退链；null → 直接告警）。
    let wakeDue = false;
    let oldest = Number.POSITIVE_INFINITY;
    for (const m of suspected) {
      const t = resultTimeMs(m, boardMtime);
      if (t == null) {
        wakeDue = true; // B5: 时间完全不可考 → 直接计告警
        continue;
      }
      const elapsed = Math.max(0, Date.now() - t); // B7
      if (t < oldest) oldest = t;
      if (elapsed >= windowMs) wakeDue = true;
    }

    // B1: 非 workflow 在飞任务龄期告警（崩死在 running/resumed 的盲区）。
    const stuck = [];
    for (const m of inFlight) {
      const t = lastActivityMs(m);
      const ageMs = t == null ? Number.POSITIVE_INFINITY : Math.max(0, Date.now() - t); // B7
      if (ageMs >= windowMs) stuck.push({ m, ageMs });
    }

    if (wakeDue || stuck.length) {
      const rows = suspected.slice(0, 5).map((m) => {
        const w = wakeFailureInfo(m);
        const title = String(m.title || "(未命名)").replace(/\s+/g, " ").slice(0, 30);
        const age = w.result_at ? `｜结果于 ${fmtAge(w.minutes)}` : "";
        return `- [${m.id}] ${title}｜${m.status}${age}｜未签收`;
      });
      let summary = "";
      if (wakeDue) {
        const oldestTxt = Number.isFinite(oldest)
          ? `（每 ${Math.round(timeoutMs / 60000)} 分钟计一次超时，共 ${retries} 次）`
          : "（结果时间不可考，直接告警）";
        summary +=
          "[orch-sentinel] 唤醒失败告警：以下任务结果已落盘但主控迟迟未签收" +
          oldestTxt +
          "。请立即 mailbox(read) 接手并 answer/close（自动签收）；" +
          "处置后可重新以后台任务运行 hooks/bg-sentinel.mjs --once 继续盯守：\n" +
          rows.join("\n");
      }
      if (stuck.length) {
        const stuckRows = stuck.slice(0, 5).map(({ m, ageMs }) => {
          const title = String(m.title || "(未命名)").replace(/\s+/g, " ").slice(0, 30);
          const minutes = Math.floor(ageMs / 60000);
          return `- [${m.id}] ${title}｜${m.status}｜无事件已 ${fmtAge(minutes)}｜在飞`;
        });
        summary +=
          (summary ? "\n\n" : "") +
          `[orch-sentinel] 在飞任务龄期告警：以下任务连续无任何事件` +
          `（龄期 ≥ wake_retries×超时窗 = ${Math.round(windowMs / 60000)} 分钟，进程疑似已死）。` +
          "请 TaskOutput(task_id)/ListWorkflowRuns 核查；确认死亡则 board 改 failed 并重派：\n" +
          stuckRows.join("\n");
      }
      finish(1, summary);
      return;
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
