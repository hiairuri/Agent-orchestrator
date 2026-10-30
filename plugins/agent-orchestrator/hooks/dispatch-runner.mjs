#!/usr/bin/env node
/**
 * agent-orchestrator dispatch runner (v1.1.1 W20).
 *
 * Detached child of the MCP `dispatch` tool (zero deps, Node builtins only).
 * Contract:
 *   in : --mission-id <id> --prompt <promptFile> --cwd <worktree|project>
 *        --result-dir <dir> --log <runnerLog> [--timeout-min N] [--cli <bundle>]
 *        [--provider-config-seed <file>] (v1.1.1-FA: env-redirected provider
 *        config copy — the CLI child gets ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
 *        pointed at it so headless -p resolves a model selection; the real
 *        config is never touched. Only set when the server saw the
 *        ZCODE_BUILTIN/PERSONAL env pair — H1r requires both or neither.)
 *   out: <result-dir>/<sessionId>.json            (envelope + mission/exit meta)
 *        <result-dir>/<mission_id>-<ms>.index.json (mission → result sidecar;
 *        v1.2 M3-1: also written by the fail() path (error=runner_early_fail)
 *        and by the death handlers (killed:true) — the busy gate unblocks)
 *        <result-dir>/<mission_id>-<ts>.error.json (envelope unparsable: log tail)
 *   log: child stdout+stderr merged, appended verbatim.
 *
 * The CLI runs `node <zcode bundle> -p <first message> --json --mode yolo` with
 * cwd = workspace/worktree (args array straight to CreateProcess, no shell). The
 * CLI child carries ORCH_MANAGED_WORKER=<mission_id> in its environment (v1.1.1
 * W-A0: the -p session's SessionStart then skips publishWakeAnchor — managed
 * workers never hijack the coordinator wake anchor). The
 * runner never touches board.json — the server owns the root lock; the result
 * files are the post-mortem diagnostic face, completion arrives via report.
 * v1.1.1 W-B: on collecting the result (finish) the runner also appends a
 * wake-queue event (<root>/context/wake-queue/<ms>-<mission_id>.json, wx) and
 * claim-spawns the wake-kick executor if it wins the claim.json acquire —
 * producers only write files/claim; waking authority stays single-source.
 * Timeout (default 240 min) kills the process tree (`taskkill /PID <pid> /T /F`).
 */
import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";

const DEFAULT_CLI = "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs";
const DEFAULT_TIMEOUT_MIN = 240;
const LOG_TAIL_CHARS = 16384; // v1.2.3 W1: 4000 -> 16384 (OPEN-4=A; 0.17.x multi-line envelopes are KB-scale)

function argOf(argv, flag, def = "") {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1] ?? def;
    if (argv[i].startsWith(flag + "=")) return argv[i].slice(flag.length + 1);
  }
  return def;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + `.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/* --- v1.1.1 W-B wake-queue（完成即唤队列；mcp/server.mjs 同文 twin，零共享依赖纪律） ---
   队列形：<root>/context/wake-queue/ 逐事件单文件 <startedMs>-<mission_id>.json，wx 独占
   创建（EEXIST=他人已记，该方负责认领）；claim.json 认领/acquire 同 wx（含 acquired_at；
   detached spawn 执行器后删除；认领后 spawn 前 crash 的残留带 acquired_at 可识别，超龄回收
   裁定并入 WB 波）。执行器调用形 = node hooks/wake-kick.mjs --root <root>（本波空壳桩）。
   毒丸容忍：只 wx 写自己的文件、不读目录内既有内容，坏件天然隔离（消费面跳过归 WB 波）。 */
function wakeQueueDirOf(resultDirPath) {
  return path.join(path.dirname(path.resolve(resultDirPath)), "wake-queue");
}

function wakeQueueProduce(opts) {
  const queueDir = opts.queueDir;
  fs.mkdirSync(queueDir, { recursive: true });
  try {
    fs.writeFileSync(
      path.join(queueDir, `${Date.now()}-${opts.missionId}.json`),
      JSON.stringify(
        {
          mission_id: opts.missionId,
          worker: opts.worker ?? null,
          session_id: opts.sessionId ?? null,
          result_path: opts.resultPath ?? null,
          // Q3b 死信摘要（v1.2 M3-1）：与 mcp/server.mjs twin 同文加字段——
          // outcome=result|error|timeout，主控被唤时即知死因免开 index。
          outcome: opts.outcome ?? null,
          timed_out: opts.timedOut ?? null,
          exit_code: opts.exitCode ?? null,
          created_at: new Date().toISOString(),
          source: opts.source,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  } catch (err) {
    if (err && err.code === "EEXIST") return false; // 他人已记（同毫秒同 mission），该方认领
    throw err;
  }
  let acquired = false;
  try {
    fs.writeFileSync(
      path.join(queueDir, "claim.json"),
      JSON.stringify({ acquired_at: new Date().toISOString(), source: opts.source }, null, 2) + "\n",
      { flag: "wx" },
    );
    acquired = true;
  } catch {
    acquired = false; // EEXIST=他者刚认领（静默，他者负责）或其他失败（保守不 spawn）
  }
  if (!acquired) return true;
  try {
    const kick = child_process.spawn(
      process.execPath,
      [opts.kickPath, "--root", path.dirname(path.dirname(queueDir))],
      { detached: true, stdio: "ignore", windowsHide: true, cwd: opts.cwdDir },
    );
    kick.on("error", () => {});
    kick.unref();
  } catch {
    /* spawn 构造失败罕见：finally 仍释放认领，事件留队待下一触发点 */
  } finally {
    try {
      fs.unlinkSync(path.join(queueDir, "claim.json"));
    } catch {
      /* 残留带 acquired_at 可识别，WB 波超龄回收 */
    }
  }
  return true;
}

/** Last JSON object that looks like the --json result envelope. Two channels:
 *  - Channel A (0.16.x, unchanged): single-line envelope — backward scan, one
 *    JSON.parse per `{`-opening line, same predicate.
 *  - Channel B (0.17.x, v1.2.3 W1/M1): pretty-printed multi-line envelope — only
 *    when channel A finds nothing: take the LAST `{`-opening line as the single
 *    candidate start, accumulate lines forward trying JSON.parse after each
 *    append; success + same predicate => return. Accumulation bound = the whole
 *    tail window (natural boundary, no new constant).
 *  Declared residual surfaces (design-internal; the error sidecar is the fallback):
 *  - a `{`-opening noise line AFTER the envelope latches the single candidate
 *    start => graceful miss (R2-08 multi-candidate scan deferred, impl-plan §8);
 *  - envelopes longer than LOG_TAIL_CHARS truncate at the window head => graceful
 *    miss (PQA4/impl-plan §11: >16KB envelope still misses -> error sidecar). */
function parseEnvelope(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj && typeof obj === "object" && (obj.type === "result" || typeof obj.sessionId === "string")) return obj;
  }
  // Channel B: multi-line pretty JSON (0.17.x). Single candidate start = the last
  // `{`-opening line; accumulate forward, parse after each append (impl-plan §2 M1).
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith("{")) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let acc = "";
  for (let i = start; i < lines.length; i++) {
    acc += (i > start ? "\n" : "") + lines[i];
    let obj;
    try {
      obj = JSON.parse(acc);
    } catch {
      continue;
    }
    if (obj && typeof obj === "object" && (obj.type === "result" || typeof obj.sessionId === "string")) return obj;
  }
  return null;
}

/** Tail of OUR run only: bytes from `start` on (a reused/rotated log path must
 *  never contribute a previous run's envelope). */
function readLogTail(logFile, start = 0) {
  let fd;
  try {
    fd = fs.openSync(logFile, "r");
    const size = fs.fstatSync(fd).size;
    const from = Math.max(start, size - LOG_TAIL_CHARS);
    const len = Math.max(0, size - from);
    if (!len) return "";
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}

function killTree(pid) {
  try {
    if (process.platform === "win32") {
      child_process.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  const missionId = argOf(argv, "--mission-id");
  const promptFile = argOf(argv, "--prompt");
  const cwd = argOf(argv, "--cwd") || process.cwd();
  const resultDir = argOf(argv, "--result-dir");
  const logFile = argOf(argv, "--log");
  const cliPath = argOf(argv, "--cli") || process.env.ZCODE_CLI_PATH || DEFAULT_CLI;
  const providerConfigSeed = argOf(argv, "--provider-config-seed");
  const timeoutMinRaw = Number(argOf(argv, "--timeout-min"));
  const timeoutMin =
    Number.isFinite(timeoutMinRaw) && timeoutMinRaw > 0 ? timeoutMinRaw : DEFAULT_TIMEOUT_MIN;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const stamp = startedAt.replace(/[:.]/g, "-");

  // Q2 兜底①（v1.2 M3-1）：runner 进程自身死亡（uncaughtException / unhandledRejection /
  // exit 时 index 仍未落）→ 补写 killed index。落真 index 文件名
  // (<missionId>-<startedMs>.index.json, killed:true) —— busy 闸（dispatchHasResultIndex）
  // 与 ≤8s 组合捕获直读，无需 server 侧正则扩面。indexWritten 由 fail()/finish() 置位，
  // 正常路径 exit handler 不覆盖既有 index。边界如实（DP2b Q2）：taskkill /F 强杀时
  // OS 不保证 exit handler 执行——该残余面由 server 侧 O10 超龄豁免兜底。
  let indexWritten = false;
  const writeKilledIndex = (reason, errText) => {
    if (!missionId || !resultDir || indexWritten) return;
    try {
      indexWritten = true;
      atomicWriteJson(path.join(resultDir, `${missionId}-${startedMs}.index.json`), {
        mission_id: missionId,
        worker: null,
        session_id: null,
        result_path: null,
        error_path: null,
        exit_code: null,
        timed_out: false,
        outcome: "error",
        killed: true,
        error: `runner_killed: ${reason}${errText ? ": " + String(errText).slice(0, 200) : ""}`,
        started_at: startedAt,
        exit_at: new Date().toISOString(),
        log_path: logFile,
      });
    } catch {
      /* best effort: diagnostic face only */
    }
  };
  process.on("uncaughtException", (err) => {
    writeKilledIndex("uncaughtException", err && err.message ? err.message : err);
    try {
      process.stderr.write(
        "[agent-orchestrator] dispatch-runner uncaughtException: " +
          (err && err.message ? err.message : err) +
          "\n",
      );
    } catch {
      /* silence */
    }
    process.exitCode = 1;
  });
  process.on("unhandledRejection", (err) => {
    writeKilledIndex("unhandledRejection", err && err.message ? err.message : String(err));
    try {
      process.stderr.write(
        "[agent-orchestrator] dispatch-runner unhandledRejection: " +
          (err && err.message ? err.message : String(err)) +
          "\n",
      );
    } catch {
      /* silence */
    }
    process.exitCode = 1;
  });
  process.on("exit", () => {
    writeKilledIndex("exit", null);
  });

  const fail = (message) => {
    try {
      if (resultDir) {
        const errorPath = path.join(resultDir, `${missionId}-${stamp}.error.json`);
        atomicWriteJson(errorPath, {
          mission_id: missionId,
          worker: null,
          started_at: startedAt,
          exit_at: new Date().toISOString(),
          exit_code: null,
          timed_out: false,
          error: String(message),
          log_tail: logFile ? readLogTail(logFile) : "",
        });
        // Q2 双入口同堵·入口②（v1.2 M3-1）：早期失败补写 index（error=runner_early_fail）
        // ——旧形态只写 error 侧车不写 index，spawn 失败路径 busy 闸永久锁死
        // （server.mjs 旧注释「A spawn failure lands as a missing result index」自认面）。
        indexWritten = true;
        atomicWriteJson(path.join(resultDir, `${missionId}-${startedMs}.index.json`), {
          mission_id: missionId,
          worker: null,
          session_id: null,
          result_path: null,
          error_path: errorPath,
          exit_code: null,
          timed_out: false,
          outcome: "error",
          error: "runner_early_fail: " + String(message),
          started_at: startedAt,
          exit_at: new Date().toISOString(),
          log_path: logFile,
        });
      }
    } catch {
      /* diagnostic face only */
    }
    process.exitCode = 1;
  };

  if (!missionId || !promptFile || !resultDir || !logFile) {
    return fail("missing --mission-id/--prompt/--result-dir/--log");
  }
  fs.mkdirSync(resultDir, { recursive: true });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  let prompt;
  try {
    prompt = fs.readFileSync(promptFile, "utf8");
  } catch (err) {
    return fail("prompt unreadable: " + (err && err.message ? err.message : err));
  }
  const workerLine = prompt.split(/\r?\n/).find((line) => line.startsWith("[worker] ")) || "";
  const worker = workerLine ? workerLine.slice("[worker] ".length).trim() : null;

  // Everything after this offset belongs to THIS run (envelope parsing is confined
  // to it, so a reused log path can never surface a previous run's result).
  let startOffset = 0;
  try {
    startOffset = fs.statSync(logFile).size;
  } catch {
    startOffset = 0;
  }

  const logFd = fs.openSync(logFile, "a");
  let child;
  try {
    child = child_process.spawn(
      process.execPath,
      [cliPath, "-p", prompt, "--json", "--mode", "yolo"],
      {
        cwd,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
        // v1.1.1 W-A0 统一身份原语：-p worker 会话的 SessionStart 见之跳过
        // publishWakeAnchor（headless 托管 worker 不抢主控锚；其余环境透传）。
        // v1.1.1-FA：模型供给播种——CLI 子进程的 personal provider config 重定向到
        // 使命戳副本（bundle 锚：DAt@14470771→H1r@1154821 env 对→config.defaultModelSelection
        // @619452；真实配置零触碰）。server 只在 env 对齐时才传本参数。
        env: {
          ...process.env,
          ORCH_MANAGED_WORKER: missionId,
          ...(providerConfigSeed ? { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerConfigSeed } : {}),
        },
      },
    );
  } catch (err) {
    fs.closeSync(logFd);
    return fail("cli spawn failed: " + (err && err.message ? err.message : err));
  }
  fs.closeSync(logFd); // the child holds its own duplicated handle

  let timedOut = false;
  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    const exitAt = new Date().toISOString();
    const tail = readLogTail(logFile, startOffset);
    const envelope = parseEnvelope(tail);
    const sessionId = envelope && typeof envelope.sessionId === "string" ? envelope.sessionId : null;
    let resultPath = null;
    let errorPath = null;
    if (envelope && sessionId) {
      resultPath = path.join(resultDir, `${sessionId}.json`);
      atomicWriteJson(resultPath, {
        mission_id: missionId,
        worker,
        session_id: sessionId,
        exit_code: code,
        timed_out: timedOut,
        started_at: startedAt,
        exit_at: exitAt,
        envelope,
      });
    } else {
      errorPath = path.join(resultDir, `${missionId}-${stamp}.error.json`);
      atomicWriteJson(errorPath, {
        mission_id: missionId,
        worker,
        started_at: startedAt,
        exit_at: exitAt,
        exit_code: code,
        timed_out: timedOut,
        error: "envelope unparsable (no --json result line)",
        log_tail: tail,
      });
    }
    // Q3b 死信摘要（v1.2 M3-1）：outcome=result|error|timeout——超时杀树、信封缺失、
    // 正常收 result 三态一目了然；index 原有 timed_out/exit_code 保留，wake 事件
    // 同步携带三字段（主控被唤即知死因，免开 index）。
    const outcome = timedOut ? "timeout" : resultPath ? "result" : "error";
    indexWritten = true;
    atomicWriteJson(path.join(resultDir, `${missionId}-${startedMs}.index.json`), {
      mission_id: missionId,
      worker,
      session_id: sessionId,
      result_path: resultPath,
      error_path: errorPath,
      exit_code: code,
      timed_out: timedOut,
      outcome,
      started_at: startedAt,
      exit_at: exitAt,
      log_path: logFile,
    });
    // v1.1.1 W-B（生产者②）：runner 收 result 出口同样落完成即唤队列事件 + 认领 kick
    // （runner 无 server 自写文件；含 sessionId；result 落盘后触发，无论 envelope 成败——
    // runner 退出即无 worker 进程在飞，主控宜早知道）。整段 best-effort：失败仅 stderr 一行，
    // 不影响上方诊断文件已落盘的事实。
    try {
      wakeQueueProduce({
        queueDir: wakeQueueDirOf(resultDir),
        kickPath: path.join(path.dirname(path.resolve(process.argv[1])), "wake-kick.mjs"),
        cwdDir: cwd,
        source: "runner",
        missionId,
        worker,
        sessionId,
        resultPath: resultPath || errorPath,
        outcome,
        timedOut,
        exitCode: code,
      });
    } catch (err) {
      try {
        process.stderr.write("[agent-orchestrator] wake-queue: " + (err && err.message ? err.message : err) + "\n");
      } catch {
        /* silence */
      }
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid);
    // The close event normally follows; this guard covers a stuck handle.
    setTimeout(() => finish(null), 5000).unref?.();
  }, timeoutMin * 60000);
  timer.unref?.();

  child.on("error", () => finish(null));
  child.on("close", (code) => {
    clearTimeout(timer);
    finish(code);
  });
}

try {
  main();
} catch (err) {
  try {
    process.stderr.write("[agent-orchestrator] dispatch-runner: " + (err && err.message ? err.message : err) + "\n");
  } catch {
    /* silence */
  }
  process.exitCode = 1;
}
