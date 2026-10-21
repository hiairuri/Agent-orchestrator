#!/usr/bin/env node
/**
 * agent-orchestrator PreToolUse gate: nudge foreground Agent dispatches that
 * look like long tasks toward run_in_background=true.
 * stdin : {tool_name, tool_input, ...}; args: --policy remind|ask|off, --exempt csv,
 *         --sentinel-hint on|off (from ${user_config.wake_sentinel}),
 *         --contract remind|ask|off (from ${user_config.dispatch_contract};
 *         absent or unresolved template -> remind)
 * stdout: strict JSON hookSpecificOutput only when intervening; silence = allow.
 * Fail-open: any error exits 0 with no output. Never denies in v0.2–v0.4.1.
 *
 * v0.3: background dispatches additionally carry a "launch the wake sentinel"
 * nudge (once, when no sentinel is on duty and the 10-minute cooldown has
 * elapsed); foreground remind/ask append the same nudge when no sentinel runs.
 * --policy off stays fully silent; --exempt path unchanged.
 * v0.3.1: on-duty detection requires a fresh lock heartbeat (B3, anti PID-reuse);
 * the foreground nudge is gated by --sentinel-hint too (B8).
 * v0.4.1: on-duty detection reads the sentinel v2 family directory (fresh
 * instance-<k>.json slots; the legacy sentinel.lock still counts during the
 * upgrade window). Dispatch-contract check: a background dispatch whose prompt
 * [token] lines is matched against the board — an unregistered
 * or mismatched contract gets a remind-only warning (worker reports would be
 * rejected), never a denial.
 * v0.6 (B4/V6-52): fail-open 保留但「静默放行」降为「明示放行」——板不可读与顶层
 * 异常时输出「契约校验跳过」一句（allow 不变，永不拦派发；10s 超时层不动）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_PROMPT_CHARS = 600;
// v0.3.1 (B3): a live pid alone no longer proves the sentinel is on duty —
// PID reuse can fake liveness. Same heartbeat rule as bg-sentinel's takeover:
// alive = holder pid alive AND heartbeat (heartbeatAt, fallback mtime)
// no older than 90s.
const HEARTBEAT_STALE_MS = 90000;

const SENTINEL_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "bg-sentinel.mjs");
const HINT_COOLDOWN_MS = 10 * 60 * 1000;

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseArg(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1] ?? "";
    if (argv[i].startsWith(flag + "=")) return argv[i].slice(flag.length + 1);
  }
  return "";
}

function normalizePolicy(raw) {
  const v = String(raw ?? "").trim();
  if (!v || v.startsWith("${")) return "remind"; // unresolved template -> default
  return v === "ask" || v === "off" ? v : "remind";
}

// --sentinel-hint 来自 ${user_config.wake_sentinel}；${/空/非法 → on（off 之外一律 on）
function onOffHint(raw) {
  return String(raw ?? "").trim() !== "off";
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
 *  任一校验失败 → 回退默认根 + stderr 告警。不删指针。 */
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

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

function freshHeartbeat(doc, file) {
  if (!doc || !Number.isFinite(doc.pid) || !pidAlive(doc.pid)) return false;
  const hb = Date.parse(String(doc.heartbeatAt ?? ""));
  let age = Number.isFinite(hb) ? Date.now() - hb : NaN; // B7 clamp below
  if (!Number.isFinite(age)) {
    try {
      age = Date.now() - fs.statSync(file).mtimeMs;
    } catch {
      return false;
    }
  }
  return Math.max(0, age) <= HEARTBEAT_STALE_MS;
}

/**
 * v0.4.1: sentinel v2 family on-duty = any fresh instance-<k>.json slot under
 * <root>/sentinel/. Upgrade window: a fresh legacy sentinel.lock also counts
 * (0.3.1 sentinel still running). Absolute read-only against the board.
 */
function sentinelAlive(rootDir) {
  try {
    const sentDir = path.join(rootDir, "sentinel");
    const names = fs.readdirSync(sentDir).filter((n) => /^instance-\d+\.json$/.test(n));
    for (const n of names) {
      const f = path.join(sentDir, n);
      try {
        if (freshHeartbeat(JSON.parse(fs.readFileSync(f, "utf8")), f)) return true;
      } catch {
        /* bad slot file → next */
      }
    }
  } catch {
    /* no sentinel dir → legacy check below */
  }
  try {
    const lockPath = path.join(rootDir, "sentinel.lock");
    return freshHeartbeat(JSON.parse(fs.readFileSync(lockPath, "utf8")), lockPath);
  } catch {
    return false;
  }
}

function hintDue(rootDir) {
  // 冷却：提示戳 mtime 距今 >= 10 分钟才再提示
  try {
    const ms = fs.statSync(path.join(rootDir, "sentinel-hint-stamp")).mtimeMs;
    if (Date.now() - ms < HINT_COOLDOWN_MS) return false;
  } catch {
    /* 无戳 → 到期 */
  }
  return true;
}

function markHint(rootDir) {
  try {
    fs.writeFileSync(path.join(rootDir, "sentinel-hint-stamp"), new Date().toISOString() + "\n");
  } catch {
    /* best effort */
  }
}

function sentinelHintText() {
  const p = SENTINEL_SCRIPT.split(path.sep).join("/");
  return `派发完成 → 仅当无存活家族时才后台拉起哨兵（board list 的 sentinel_health 可查；建议 3 实例错峰冗余，防完成通知丢失）：Bash(command="node ${p} --once", run_in_background=true) 连发 3 次即可；家族已在岗（standby 亦在岗）勿重复连发——新派发由待命实例自动接管盯守。全部签收后哨兵转待命静默值守（常态 0 通知）；未签收会分级告警（blocked/question 3 分钟、done 5 分钟、在飞失联 30 分钟、崩溃实锤 10 分钟）。`;
}

/**
 * v0.4.1 dispatch-contract registration check (remind-only, fail-open).
 * Returns "" when fine, else a short warning sentence. Rules:
 *   - prompt has neither [channel] nor [token] → "" (not a contract dispatch).
 *   - [token] absent but [channel] present → nudge to include the token.
 *   - [token] not registered on any non-closed mission → warn (reports rejected).
 *   - token registered but its mission id ≠ [channel] → mismatch warn.
 *   - v0.5 (C4): token registered but no [channel] line → reminder naming the
 *     owning mission (verbatim DESIGN §7.4), no longer a silent pass.
 * Board read-only; any error → "" (never block dispatch).
 */
/**
 * v0.5 (strict=ask, M-10): high-confidence real dispatch = the [channel] value
 * matches the generated mission-id shape. Placeholder/template text (C10) can
 * never match, so it never triggers an escalation.
 */
const MISSION_ID_SHAPE = /^m-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/;
// v0.6 (V6-52): 板不可读的明示放行信号——contractWarn 读板失败时置位，main 据此把
// 「静默放行」降为「明示放行」（fail-open 产品不变量保留：闸门永不拦派发）。
let boardUnreadable = false;
// v0.6 (V6-53): 契约头正则单一来源——missionIdShaped / contractWarn / longTaskWhy
// 三处同源引用，消除旧 longTaskWhy 窄正则（无前导空白容忍）的分叉。
// 只认半角方括号：context_pack 模板只产半角，全角不放宽（避免扩大触发面）。
const CONTRACT_HEAD = /^\s*\[channel\]\s*(\S+)/m;
function missionIdShaped(prompt) {
  const ch = CONTRACT_HEAD.exec(typeof prompt === "string" ? prompt : "");
  return Boolean(ch && MISSION_ID_SHAPE.test(String(ch[1])));
}

function contractWarn(prompt, rootDir) {
  try {
    const text = typeof prompt === "string" ? prompt : "";
    if (!text) return "";
    const ch = CONTRACT_HEAD.exec(text);
    const tk = /^\s*\[token\]\s*(\S+)/m.exec(text);
    if (!ch && !tk) return "";
    const channel = ch ? String(ch[1]) : "";
    const token = tk ? String(tk[1]) : "";
    if (!token) {
      return `派发契约头缺 [token] 行（channel=${channel || "?"}）：worker 上报会被拒收，请补 context_pack 返回的 token。`;
    }
    let board = null;
    try {
      board = JSON.parse(fs.readFileSync(path.join(rootDir, "board.json"), "utf8"));
    } catch {
      boardUnreadable = true; // V6-52：明示放行信号
      return ""; // board missing/unreadable → 不拦不猜（fail-open）
    }
    const missions = board && Array.isArray(board.missions) ? board.missions : [];
    const hit = missions.find(
      (m) =>
        m &&
        m.dispatch &&
        typeof m.dispatch === "object" &&
        String(m.dispatch.token || "") === token &&
        m.status !== "closed",
    );
    if (!hit) {
      return `派发契约头未匹配任何在册 mission（token=${token} 未登记或已 closed）：worker 的 report 将被 isError 拒收。请先 context_pack 建 mission 记 dispatch，或核对 token 后再派发。`;
    }
    if (channel && String(hit.id) !== channel) {
      return `派发契约头不匹配：token=${token} 属于 mission ${hit.id}，而 [channel] 写的是 ${channel}——worker 的 report 会对不上频道，请修正后重发。`;
    }
    // v0.5 (C4): token 在册但 prompt 无 [channel] 行——旧包重派或新建漏登记，
    // 不再静默通过；追加一句提醒（DESIGN §7.4 逐字），区分旧 mission 与新 mission。
    if (!channel) {
      return `该 token 属 mission ${hit.id}——若这是新 mission 请先 context_pack 建 mission 记新 token`;
    }
    return "";
  } catch {
    return "";
  }
}

function longTaskWhy(ti) {
  const prompt = typeof ti.prompt === "string" ? ti.prompt : "";
  if (CONTRACT_HEAD.test(prompt)) return "含派发契约头 [channel]";
  if (prompt.length >= MIN_PROMPT_CHARS) {
    return `prompt ${prompt.length} 字符 ≥ ${MIN_PROMPT_CHARS}`;
  }
  return null;
}

/** 统一出口：契约校验失败的 ask 升级（仅此一处会产生 ask；deny 永不采用）。 */
function emitContractAsk(contractMsg) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason:
          "bg-gate：派发契约校验未通过——" + contractMsg +
          " 请核对 context_pack 返回的 [channel]/[token] 后确认或修正重发。",
      },
    }),
  );
}

function main() {
  const input = readStdinJson();
  const toolName = String(input.tool_name || "");
  if (toolName !== "Agent" && toolName !== "Task") return;
  const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const prompt = typeof ti.prompt === "string" ? ti.prompt : "";

  const argv = process.argv.slice(2);
  const policy = normalizePolicy(parseArg(argv, "--policy"));
  // v0.5 (C7 解耦): --contract 来自新 userConfig 键 dispatch_contract
  // （remind|ask|off，默认 remind），独立于 --policy（background_gate）——
  // background_gate=off 不再连坐关闭契约检查；只有 dispatch_contract=off 才静默。
  const contract = normalizePolicy(parseArg(argv, "--contract"));
  const hintEnabled = onOffHint(parseArg(argv, "--sentinel-hint")); // off 之外一律 on
  const projectDir = process.env.ZCODE_PROJECT_DIR || process.cwd();
  const rootDir = locateRoot(projectDir);
  const sentinelOnDuty = sentinelAlive(rootDir);
  // v0.4.1: contract registration check runs for every dispatch that carries a
  // contract head. v0.5: gated by --contract (default remind), NOT by --policy.
  const contractMsg = contract === "off" ? "" : contractWarn(prompt, rootDir);
  // v0.5 (strict=ask): 仅高置信真派发升级——[channel] 值匹配 mission id 生成形状
  // 且 token 校验失败；占位符文本天然不匹配不升级（C10）；deny 永不采用。
  const contractAsk =
    Boolean(contractMsg) && contract === "ask" && missionIdShaped(prompt);
  // v0.6 (V6-52): 明示放行——板不可读时 fail-open 保留，追加一句「契约校验跳过」。
  // 与 contractAsk 互斥（后者要求 contractMsg 非空）：跳过提示永不升级 ask。
  const contractSkip =
    !contractMsg && boardUnreadable
      ? "契约校验跳过：板不可读（fail-open），本次派发未做契约核验。"
      : "";

  if (policy === "off") {
    // v0.5 (C7): 闸门完全静默（含哨兵提示），但契约检查独立存活——
    // dispatch_contract=remind/ask 且确有契约问题时仍要出口。
    if (contractMsg || contractSkip) {
      if (contractAsk) {
        emitContractAsk(contractMsg);
      } else {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              permissionDecisionReason: "bg-gate: dispatch contract",
              additionalContext: "[agent-orchestrator] " + (contractMsg || contractSkip),
            },
          }),
        );
      }
    }
    return;
  }

  if (ti.run_in_background === true) {
    if (contractAsk) {
      emitContractAsk(contractMsg);
      return;
    }
    const extras = [];
    if (contractMsg) extras.push("[agent-orchestrator] " + contractMsg);
    if (contractSkip) extras.push("[agent-orchestrator] " + contractSkip);
    if (hintEnabled && !sentinelOnDuty && hintDue(rootDir)) {
      markHint(rootDir);
      extras.push("[agent-orchestrator] " + sentinelHintText());
    }
    if (!extras.length) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "bg-gate: dispatch contract / sentinel hint",
          additionalContext: extras.join(" "),
        },
      }),
    );
    return;
  }

  const subagentType = String(ti.subagent_type || "").toLowerCase();
  const exempt = String(parseArg(argv, "--exempt") || "");
  const tokens = exempt
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((t) => !t.startsWith("${"));
  if (tokens.some((t) => subagentType.includes(t))) return;

  const why = longTaskWhy(ti);
  if (!why && !contractMsg && !contractSkip) return;

  // v0.5 (strict=ask): 契约升级优先于长任务提醒——高置信真派发且校验失败才到这。
  if (contractAsk) {
    emitContractAsk(contractMsg);
    return;
  }

  // v0.3.1 (B8): the sentinel nudge in the remind/ask paths is governed by the
  // same --sentinel-hint switch as the background path — wake_sentinel=off must
  // strip the nudge from every path.
  const sentinelSuffix =
    hintEnabled && !sentinelOnDuty ? " " + sentinelHintText() : "";
  const contractSuffix =
    contractMsg || contractSkip
      ? " [agent-orchestrator] " + (contractMsg || contractSkip)
      : "";

  if (policy === "ask") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason:
            `bg-gate：前台子代理派发疑似长任务（${why || "含派发契约头"}）。后台运行可避免占用主控回合、` +
            `避免被用户消息取消整回合连带取消子代理；确认是短任务可直接放行。` +
            contractSuffix,
          ...(sentinelSuffix ? { additionalContext: sentinelSuffix } : {}),
        },
      }),
    );
    return;
  }
  // remind (default)
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "bg-gate: remind",
        additionalContext:
          "[agent-orchestrator] 该前台子代理派发疑似长任务。前台会占住主控回合，且用户一条消息会取消" +
          "整回合、连带取消子代理——长任务建议 run_in_background=true。确认是快查可忽略本提醒。" +
          contractSuffix +
          sentinelSuffix,
      },
    }),
  );
}

try {
  main();
} catch {
  // v0.6 (V6-52): fail-open 保留——尽力把静默放行降为明示放行（输出失败仍 exit 0，
  // 不新增失败面）。所有写出口都紧邻各分支 return，走到此处即未产出过输出。
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "bg-gate: fail-open",
          additionalContext: "[agent-orchestrator] 契约校验跳过：bg-gate 内部异常（fail-open），本次检查未执行。",
        },
      }),
    );
  } catch {
    /* 输出失败不阻塞 */
  }
}
process.exit(0);
