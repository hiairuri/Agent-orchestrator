#!/usr/bin/env node
/**
 * agent-orchestrator context mirror journal（UserPromptSubmit 侧）。
 * stdin : {hook_event_name, session_id, prompt, ...}；args: --mirror on|off, --max-chars "2000,4000"
 * stdout: 恒无输出；exit 恒 0。任何失败静默——绝不阻塞对话。
 */
import fs from "node:fs";
import path from "node:path";

const MAX_ENTRIES = 400;
const KEEP_AFTER_COMPACT = 300;
const MAX_BYTES = 2000000;

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

function parseArg(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1] ?? "";
    if (argv[i].startsWith(flag + "=")) return argv[i].slice(flag.length + 1);
  }
  return "";
}

function onOff(raw, def) {
  const s = String(raw ?? "").trim();
  if (!s || s.startsWith("${")) return def;
  return s === "off" ? false : s === "on" ? true : def;
}

function maxCharsPair(raw, defU, defA) {
  const parts = String(raw ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .map((n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0));
  const u = parts[0] || defU;
  const a = parts[1] || parts[0] || defA;
  return { user: u, assistant: a };
}

function record(rootDir, sid, kind, text, cap) {
  const dir = path.join(rootDir, "context");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `journal-${sid}.jsonl`);
  let rows = [];
  try {
    rows = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    rows = [];
  }
  let seq = rows.length ? Math.max(...rows.map((r) => Number(r.seq) || 0)) : 0;
  rows.push({ ts: new Date().toISOString(), session_id: sid, kind, text: text.slice(0, cap), seq: seq + 1 });
  const bytes = rows.reduce((n, r) => n + JSON.stringify(r).length + 1, 0);
  if (rows.length > MAX_ENTRIES || bytes > MAX_BYTES) rows = rows.slice(-KEEP_AFTER_COMPACT);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* best effort */
  }
  fs.renameSync(tmp, file);
}

function main() {
  const argv = process.argv.slice(2);
  if (!onOff(parseArg(argv, "--mirror"), true)) return; // off：零写入
  const input = readStdinJson();
  const event = String(input.hook_event_name || "");
  const isUser = event === "UserPromptSubmit";
  const isStop = event === "Stop";
  if (!isUser && !isStop) return;
  const raw = isUser
    ? input.prompt ?? input.user_prompt ?? input.message
    : input.last_assistant_message ?? input.last_message ?? input.assistant_message;
  if (typeof raw !== "string" || !raw.trim()) return;
  const caps = maxCharsPair(parseArg(argv, "--max-chars"), 2000, 4000);
  const sid = String(input.session_id || "anon").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const rootDir = locateRoot(process.env.ZCODE_PROJECT_DIR || process.cwd());
  record(rootDir, sid, isUser ? "user" : "assistant", raw, isUser ? caps.user : caps.assistant);
}

try {
  main();
} catch {
  /* 静默 */
}
process.exit(0);
