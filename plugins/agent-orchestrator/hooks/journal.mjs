#!/usr/bin/env node
/**
 * agent-orchestrator context mirror journal（UserPromptSubmit 侧）。
 * stdin : {hook_event_name, session_id, prompt, ...}；args: --mirror on|off, --max-chars "2000,4000",
 *         --max-bytes <n>（滚动阈值，默认 2000000；测试可调小）
 * stdout: 恒无输出；exit 恒 0。任何失败静默——绝不阻塞对话。
 *
 * v0.3.1 (A5): 追加式写入。旧实现整文件读→改→rename 覆盖，并发丢行且留下无文件窗口；
 * 现改为 fs.appendFileSync 单行追加（每行一个 JSON），seq 只读文件尾部 8KB 求最大值；
 * 滚动淘汰改为"超限时把旧文件 rename 为 .old 后开新文件"（rotate 与 append 的竞态可容忍），
 * 不再整文件读改写。
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 2000000;

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
      if (custom) {
        // v0.4.1: a dangling pointer (deleted test root / moved storage) must not
        // drag hook writes onto a nonexistent path — fall back to the default.
        try {
          if (fs.statSync(custom).isDirectory()) return custom;
        } catch {
          /* dangling → fall through to default root */
        }
      }
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

/** Last seq via a bounded tail read (never a full-file read). */
function lastSeqOf(file) {
  return lastSeqWindow(file, 8192);
}

/** Tail search with a growing window — handles lines longer than 8KB. */
function lastSeqDeep(file) {
  let size = 0;
  try {
    size = fs.fstatSync(fs.openSync(file, "r")).size;
  } catch {
    return 0;
  }
  let window = 8192;
  for (;;) {
    const seq = lastSeqWindow(file, window);
    if (seq > 0) return seq;
    if (window >= size) return 0;
    window = Math.min(window * 8, size);
  }
}

function lastSeqWindow(file, window) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return 0;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const chunk = Math.min(window, size);
    if (chunk <= 0) return 0;
    const buf = Buffer.alloc(chunk);
    fs.readSync(fd, buf, 0, chunk, size - chunk);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const seq = Number(JSON.parse(lines[i]).seq);
        if (Number.isFinite(seq)) return seq;
      } catch {
        /* skip bad tail line */
      }
    }
    return 0;
  } catch {
    return 0;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best effort */
    }
  }
}

function record(rootDir, sid, kind, text, cap, maxBytes = DEFAULT_MAX_BYTES) {
  const dir = path.join(rootDir, "context");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `journal-${sid}.jsonl`);
  // Rotation decision first (approximate line size), so seq can be derived from
  // whichever file ends up holding the previous entries.
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* new file */
  }
  const roughLine = Buffer.byteLength(String(text ?? "").slice(0, cap), "utf8") + 200;
  const overLimit = size + roughLine > maxBytes;
  let prevSeq;
  if (overLimit && size > 0) {
    // Rotation: rename the over-limit file to .old; the deep tail read at this
    // (rare) moment keeps seq continuous across generations. A rotate racing a
    // concurrent append is tolerated (a line may land in .old).
    try {
      fs.renameSync(file, `${file}.old`);
    } catch {
      /* raced or gone; append still proceeds */
    }
    prevSeq = lastSeqDeep(`${file}.old`);
  } else {
    prevSeq = lastSeqOf(file);
    if (prevSeq === 0 && size > 0) prevSeq = lastSeqDeep(file); // oversized lines
  }
  const entry = { ts: new Date().toISOString(), session_id: sid, kind, text: text.slice(0, cap), seq: prevSeq + 1 };
  const line = JSON.stringify(entry) + "\n";
  // v0.3.1 (A5): single-line append; brief retry for transient Windows locks.
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.appendFileSync(file, line);
      return;
    } catch (err) {
      lastErr = err;
      const end = Date.now() + 20;
      while (Date.now() < end) {
        /* 20ms spin */
      }
    }
  }
  throw lastErr;
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
  const maxBytesRaw = Number(String(parseArg(argv, "--max-bytes") || "").trim());
  const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? Math.floor(maxBytesRaw) : DEFAULT_MAX_BYTES;
  const sid = String(input.session_id || "anon").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const rootDir = locateRoot(process.env.ZCODE_PROJECT_DIR || process.cwd());
  record(rootDir, sid, isUser ? "user" : "assistant", raw, isUser ? caps.user : caps.assistant, maxBytes);
}

try {
  main();
} catch {
  /* 静默 */
}
process.exit(0);
