#!/usr/bin/env node
/**
 * agent-orchestrator PreToolUse gate: nudge foreground Agent dispatches that
 * look like long tasks toward run_in_background=true.
 * stdin : {tool_name, tool_input, ...}; args: --policy remind|ask|off, --exempt csv,
 *         --sentinel-hint on|off (from ${user_config.wake_sentinel})
 * stdout: strict JSON hookSpecificOutput only when intervening; silence = allow.
 * Fail-open: any error exits 0 with no output. Never denies in v0.2/v0.3.
 *
 * v0.3: background dispatches additionally carry a "launch the wake sentinel"
 * nudge (once, when no sentinel is on duty and the 10-minute cooldown has
 * elapsed); foreground remind/ask append the same nudge when no sentinel runs.
 * --policy off stays fully silent; --exempt path unchanged.
 * v0.3.1: on-duty detection requires a fresh lock heartbeat (B3, anti PID-reuse);
 * the foreground nudge is gated by --sentinel-hint too (B8).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_PROMPT_CHARS = 600;
// v0.3.1 (B3): a live pid alone no longer proves the sentinel is on duty —
// PID reuse can fake liveness. Same heartbeat rule as bg-sentinel's takeover:
// alive = holder pid alive AND lock heartbeat (heartbeatAt, fallback mtime)
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

function locateRoot(projectDir) {
  const defaultRoot = path.join(projectDir, ".zcode", "orchestrator");
  try {
    const pointer = path.join(defaultRoot, "root.txt");
    if (fs.existsSync(pointer)) {
      const custom = fs.readFileSync(pointer, "utf8").trim();
      if (custom) return custom;
    }
  } catch {
    /* fall through to default */
  }
  return defaultRoot;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

function sentinelAlive(rootDir) {
  try {
    const lockPath = path.join(rootDir, "sentinel.lock");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (!lock || !Number.isFinite(lock.pid) || !pidAlive(lock.pid)) return false;
    const hb = Date.parse(String(lock.heartbeatAt ?? ""));
    let age = Number.isFinite(hb) ? Date.now() - hb : NaN; // B7 clamp below
    if (!Number.isFinite(age)) {
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        return false;
      }
    }
    return Math.max(0, age) <= HEARTBEAT_STALE_MS;
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
  return (
    `派发完成 → 记得在同一回合后台拉起唤醒哨兵：Bash(command="node ${p} --once", run_in_background=true)。` +
    "全部结果签收后它静默自毁；超时仍未签收会以告警叫醒你。"
  );
}

function longTaskWhy(ti) {
  const prompt = typeof ti.prompt === "string" ? ti.prompt : "";
  if (/^\[channel\]\s?/m.test(prompt)) return "含派发契约头 [channel]";
  if (prompt.length >= MIN_PROMPT_CHARS) {
    return `prompt ${prompt.length} 字符 ≥ ${MIN_PROMPT_CHARS}`;
  }
  return null;
}

function main() {
  const input = readStdinJson();
  const toolName = String(input.tool_name || "");
  if (toolName !== "Agent" && toolName !== "Task") return;
  const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};

  const policy = normalizePolicy(parseArg(process.argv.slice(2), "--policy"));
  if (policy === "off") return; // 完全静默（含哨兵提示）

  const argv = process.argv.slice(2);
  const hintEnabled = onOffHint(parseArg(argv, "--sentinel-hint")); // off 之外一律 on
  const projectDir = process.env.ZCODE_PROJECT_DIR || process.cwd();
  const rootDir = locateRoot(projectDir);
  const sentinelOnDuty = sentinelAlive(rootDir);

  if (ti.run_in_background === true) {
    if (!hintEnabled) return;
    if (sentinelOnDuty) return; // 哨兵在岗：不打扰
    if (!hintDue(rootDir)) return; // 冷却期内：不打扰
    markHint(rootDir);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "bg-gate: sentinel hint",
          additionalContext: "[agent-orchestrator] " + sentinelHintText(),
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
  if (!why) return;

  // v0.3.1 (B8): the sentinel nudge in the remind/ask paths is governed by the
  // same --sentinel-hint switch as the background path — wake_sentinel=off must
  // strip the nudge from every path.
  const sentinelSuffix =
    hintEnabled && !sentinelOnDuty ? " " + sentinelHintText() : "";

  if (policy === "ask") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason:
            `bg-gate：前台子代理派发疑似长任务（${why}）。后台运行可避免占用主控回合、` +
            `避免被用户消息取消整回合连带取消子代理；确认是短任务可直接放行。`,
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
          sentinelSuffix,
      },
    }),
  );
}

try {
  main();
} catch {
  /* fail-open */
}
process.exit(0);
