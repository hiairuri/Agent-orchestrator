// @module glean-launch
/*!
 * suites/glean-launch.mjs —— v1.1.1 W23/A2 归敛自动拉起（bg-sentinel 黑盒 + 库级桩）
 *
 * 覆盖断言组（用户裁定：锁前置启动器 + 首条消息零任务包读取 + 冷却锚在退出）：
 *   G0 门槛未满足（new_events 高水位）→ 不拉起、零锁零冷却戳
 *   G1 条件满足 + 锁 active（活 PID）→ 不拉起，原锁字节不动
 *   G2 条件满足 + 锁空闲 + 冷却内 → 不拉起（新格式 until_ms / 旧 ISO 形状双fallback）
 *   G3 条件满足 + 锁空闲 + 冷却过 → 拉起（桩 CLI，delay>grace 且 code=0）：
 *      命令形/detached/stdio 日志重定向/首条消息内联世界（含锁纪律与「不要写 board.json」
 *      红线、无「读取任务包」类措辞）/锁前置 active pid=子进程/拉起时不写冷却/
 *      状态文件落盘/退出后长冷却（kind=long，锚=退出时刻）/兜底翻锁 done/状态清除/不二次拉起
 *   G4 桩立即退出非 0/1（黑盒）→ 短冷却（kind=short，1h）+ 锁回退 done 快照 + stderr
 *   G5 库级 spawn 桩：spawn 异常→短冷却+回退；spawn(options) 逐项断言（detached/stdio/
 *      windowsHide/cwd/命令形）；emitter 退出 code=2→短冷却+回退；code=0→长冷却+兜底翻锁
 *   G6 锁获取原子性：两并发进程 acquire 只成一（wx 守卫串行化 + 先比对后写入）
 *   G7 锁 state 非 done 的未知态 → acquire 放弃且原锁零改动
 *   G8 门槛判定表（时间/事件/锁三段）+ temp 根全端目录自包含 carve-out + 冷却戳形状
 *   G9 挂死自愈：存活 ≥ 240min → 击杀进程树 + 翻锁 done + 长冷却 + stderr；
 *      存活 < 超时 → 不动；死子进程超窗 → 兜底翻锁+长冷却；死子进程窗内 → 回退+短冷却
 *
 * 运行方式：node tests/suites/glean-launch.mjs
 * 前置：node >= 20；无 git/网络依赖；不真拉模型（ZCODE_CLI_PATH 指向桩脚本）。
 * 注册纪律：本套件暂不注册 run-all（收尾波一行完成），独立跑不污染既有套件。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { PLUGIN_DIR, Checker } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot, blankMission, writeBoardSeed } from "../harness/temp-root.mjs";

const ck = new Checker("glean-launch");
const SENTINEL = path.join(PLUGIN_DIR, "hooks", "bg-sentinel.mjs");
const BASE = makeTempRoot({ prefix: "orch-gleanlaunch-" });
const KIDS = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600 * 1000;
const readText = (f) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
};
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
async function waitFor(fn, timeoutMs, step = 100) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (fn()) return true;
    } catch {
      /* 仍等 */
    }
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(step);
  }
}

/* 桩 CLI：记录 argv/cwd/pid（一行一次调用）→ stdout 标记 → 按 env 退出码/延迟退出。
   绝不真拉模型；G3 用它验证命令形、锁 pid、状态文件与日志重定向。 */
const STUB_SRC = `import fs from "node:fs";
const rec = { pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2) };
fs.appendFileSync(process.env.GLEAN_STUB_OUT, JSON.stringify(rec) + "\\n");
process.stdout.write("STUB_STDOUT_MARK\\n");
const code = Number(process.env.GLEAN_STUB_EXIT || 0);
const delay = Number(process.env.GLEAN_STUB_DELAY_MS || 0);
setTimeout(() => process.exit(Number.isFinite(code) ? code : 0), Number.isFinite(delay) ? delay : 0);
`;

const LOCK_DONE_OLD =
  JSON.stringify({
    v: 1,
    state: "done",
    pid: null,
    started_at: "2020-01-01T00:00:00.000Z",
    finished_at: "2020-01-01T00:00:00.000Z",
    watermarks: { global_lines: 0, projects: {} },
  }) + "\n";

const CFG = {
  raw: {},
  gleanLaunchEnabled: true,
  gleanLaunchCooldownMs: 24 * HOUR,
  gleanLaunchShortCooldownMs: 1 * HOUR,
  gleanLaunchGraceMs: 2000,
  gleanLaunchTimeoutMs: 240 * 60 * 1000,
};

/** 单例现场：独立项目根 + 全端目录（显式 --glean-memory-root）+ 桩 CLI。 */
function makeCase(name, opts = {}) {
  const base = path.join(BASE.root, name);
  const PROJ = path.join(base, "proj");
  const ROOT = path.join(PROJ, ".zcode", "orchestrator");
  const MEM = path.join(ROOT, "orchestrator-memory");
  fs.mkdirSync(path.join(MEM, "memory"), { recursive: true });
  fs.mkdirSync(path.join(MEM, "digest"), { recursive: true });
  fs.mkdirSync(path.join(MEM, "reports"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "memory"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "sentinel"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "root-id"), "0123456789abcdef\n");
  writeBoardSeed(ROOT, [blankMission({ id: "m-w23", status: "running", dispatch: { agent_id: "a-w23" } })]);
  const gcfg = opts.gcfg || { idle_hours: 0, new_events: 0, lock_stale_hours: 1.5 };
  fs.writeFileSync(path.join(MEM, "glean.cfg.json"), JSON.stringify(gcfg));
  if (opts.projectLessons) fs.writeFileSync(path.join(ROOT, "memory", "lessons.jsonl"), opts.projectLessons);
  if (opts.globalLessons) fs.writeFileSync(path.join(MEM, "memory", "lessons.jsonl"), opts.globalLessons);
  if (opts.lockRaw != null) fs.writeFileSync(path.join(MEM, "glean-lock.json"), opts.lockRaw);
  if (opts.stamp != null) {
    const f = path.join(ROOT, "sentinel", "glean-launch-stamp");
    fs.writeFileSync(f, typeof opts.stamp === "string" ? opts.stamp : JSON.stringify(opts.stamp) + "\n");
    if (opts.stampAgeMs != null) {
      const t = (Date.now() - opts.stampAgeMs) / 1000;
      fs.utimesSync(f, t, t);
    }
  }
  const stub = path.join(base, "stub-cli.mjs");
  fs.writeFileSync(stub, STUB_SRC);
  return {
    base,
    PROJ,
    ROOT,
    MEM,
    stub,
    out: path.join(base, "stub-out.jsonl"),
    lockFile: path.join(MEM, "glean-lock.json"),
    stampFile: path.join(ROOT, "sentinel", "glean-launch-stamp"),
    stateFile: path.join(ROOT, "sentinel", "glean-launch-state.json"),
    guardFile: path.join(ROOT, "sentinel", "glean-launch.lock"),
    ctxDir: path.join(ROOT, "context"),
  };
}

function stubRecords(c) {
  return readText(c.out)
    .split("\n")
    .filter((x) => x.trim())
    .map((x) => {
      try {
        return JSON.parse(x);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function stampOf(c) {
  const raw = readText(c.stampFile);
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { legacy: raw.trim() };
  }
}

function startSentinel(c, opts = {}) {
  const args = [
    SENTINEL,
    "--root",
    c.ROOT,
    "--poll-sec",
    "1",
    "--stagger-sec",
    "0",
    "--standby-poll-sec",
    "2",
    "--glean-memory-root",
    c.MEM,
    "--glean-launch-grace-sec",
    "2",
  ];
  const proc = spawn(process.execPath, args, {
    cwd: c.PROJ,
    env: {
      ...process.env,
      ZCODE_PROJECT_DIR: c.PROJ,
      ZCODE_CLI_PATH: c.stub,
      GLEAN_STUB_OUT: c.out,
      GLEAN_STUB_EXIT: String(opts.stubExit ?? 0),
      GLEAN_STUB_DELAY_MS: String(opts.stubDelayMs ?? 0),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => (stdout += d));
  proc.stderr.on("data", (d) => (stderr += d));
  KIDS.push(proc);
  return {
    proc,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* best effort */
      }
    },
  };
}

const writeState = (c, obj) => fs.writeFileSync(c.stateFile, JSON.stringify(obj) + "\n");
const readState = (c) => readJson(c.stateFile);

let exitCode = 0;
try {
  /* ---- G0 门槛未满足 → 不拉起 ---- */
  {
    const c = makeCase("g0-not-due", { gcfg: { idle_hours: 0, new_events: 999, lock_stale_hours: 1.5 } });
    const s = startSentinel(c);
    await sleep(3500);
    s.kill();
    await sleep(200);
    ck.ok(
      "G0 条件未满足（events 0 < 999）→ 不拉起、无锁、无冷却戳、无状态文件",
      stubRecords(c).length === 0 &&
        !fs.existsSync(c.lockFile) &&
        !fs.existsSync(c.stampFile) &&
        !fs.existsSync(c.stateFile),
      {
        recs: stubRecords(c).length,
        lock: fs.existsSync(c.lockFile),
        stamp: fs.existsSync(c.stampFile),
        state: fs.existsSync(c.stateFile),
      },
    );
  }

  /* ---- G1 条件满足 + 锁 active（活 PID）→ 不拉起且原锁字节不动 ---- */
  {
    const activeRaw =
      JSON.stringify({
        v: 1,
        state: "active",
        pid: process.pid,
        started_at: new Date().toISOString(),
        finished_at: null,
        watermarks: {},
      }) + "\n";
    const c = makeCase("g1-lock-active", { lockRaw: activeRaw });
    const s = startSentinel(c);
    await sleep(3500);
    s.kill();
    await sleep(200);
    ck.ok(
      "G1 条件满足 + 锁 active（活 PID）→ 不拉起，原锁字节不动",
      stubRecords(c).length === 0 && readText(c.lockFile) === activeRaw && !fs.existsSync(c.stampFile),
      { recs: stubRecords(c).length, lockUnchanged: readText(c.lockFile) === activeRaw },
    );
  }

  /* ---- G2 条件满足 + 锁空闲 + 冷却内 → 不拉起（新格式）---- */
  {
    const c = makeCase("g2-cooldown", {
      stamp: {
        v: 1,
        at: new Date(Date.now() - 60000).toISOString(),
        until: new Date(Date.now() + HOUR).toISOString(),
        until_ms: Date.now() + HOUR,
        kind: "long",
      },
    });
    const s = startSentinel(c);
    await sleep(3500);
    s.kill();
    await sleep(200);
    ck.ok(
      "G2 条件满足 + 锁空闲 + 冷却内（until_ms 未到）→ 不拉起",
      stubRecords(c).length === 0 && !fs.existsSync(c.lockFile) && stampOf(c) && stampOf(c).kind === "long",
      { recs: stubRecords(c).length },
    );
  }

  /* ---- G3 条件满足 + 锁空闲 + 冷却过 → 拉起（桩；delay>grace 且 code=0）---- */
  {
    const c = makeCase("g3-launch");
    const s = startSentinel(c, { stubDelayMs: 1500, stubExit: 0 });
    const launched = await waitFor(() => stubRecords(c).length >= 1, 10000);
    ck.ok("G3 条件满足 + 锁空闲 + 冷却过 → 拉起（桩被执行）", launched, { recs: stubRecords(c).length });
    const rec = stubRecords(c)[0] || {};
    const argv = Array.isArray(rec.argv) ? rec.argv : [];
    const msg = String(argv[1] || "");
    ck.ok(
      "G3 命令形：node <CLI> -p <首条消息> --json --mode yolo",
      argv[0] === "-p" && argv.includes("--json") && argv.includes("--mode") && argv[argv.indexOf("--mode") + 1] === "yolo",
      argv.slice(0, 2),
    );
    ck.ok("G3 桩 cwd=项目根（拉起工作目录）", rec.cwd === c.PROJ, rec.cwd);
    ck.ok(
      "G3 首条消息内联世界：全端目录 + 工作区 + persona 关键句",
      msg.includes(c.MEM) && msg.includes(c.ROOT) && msg.includes("orch-gleaner") && msg.includes("GL-12"),
      msg.slice(0, 160),
    );
    ck.ok(
      "G3 首条消息含锁纪律句（启动器持锁 / 完成置 done / 勿他改）",
      msg.includes("锁已由启动器持有（state=active）") &&
        msg.includes("你完成归敛后把锁 state 改为 done") &&
        msg.includes("除此之外不要改锁"),
    );
    ck.ok("G3 首条消息含红线「不要写 board.json」", msg.includes("不要写 board.json"));
    ck.ok(
      "G3 首条消息无「读取任务包」类指令（persona+内联即全部世界）",
      !msg.includes("Read 任务包") && !msg.includes("读取任务包") && !msg.includes("读任务包"),
    );
    const lock = readJson(c.lockFile);
    ck.ok(
      "G3 锁前置：active 且持有者=子进程 pid（spawn 后改记）",
      Boolean(lock) && lock.state === "active" && lock.pid === rec.pid && typeof lock.launch_token === "string",
      lock,
    );
    const st = readState(c);
    ck.ok(
      "G3 拉起成功不写冷却、只落状态文件（pid+started_at+token）",
      !fs.existsSync(c.stampFile) &&
        Boolean(st) &&
        st.pid === rec.pid &&
        typeof st.started_at === "string" &&
        st.launch_token === (lock && lock.launch_token),
      { stamp: fs.existsSync(c.stampFile), state: st },
    );
    // 子进程退出（code=0，超立即退出窗）→ 兜底翻锁 done + 24h 长冷却
    const settled = await waitFor(() => !fs.existsSync(c.stateFile), 8000);
    const stamp = stampOf(c);
    const lockDone = readJson(c.lockFile);
    ck.ok(
      "G3 子进程退出 → 状态文件清除 + 长冷却（kind=long，until≈退出+24h）",
      settled &&
        Boolean(stamp) &&
        stamp.kind === "long" &&
        Number(stamp.until_ms) - Date.now() > 23 * HOUR &&
        Number(stamp.until_ms) - Date.now() <= 24 * HOUR,
      stamp,
    );
    ck.ok(
      "G3 退出兜底翻锁：gleaner 未翻时哨兵翻 done（state=done）+ finished_at 锚退出",
      Boolean(lockDone) && lockDone.state === "done" && typeof lockDone.finished_at === "string" && lockDone.pid === rec.pid,
      lockDone,
    );
    const logs = fs.existsSync(c.ctxDir) ? fs.readdirSync(c.ctxDir).filter((n) => /^glean-launch-.*\.log$/.test(n)) : [];
    const logFile = logs.length ? path.join(c.ctxDir, logs[0]) : "";
    const logText = readText(logFile);
    ck.ok(
      "G3 日志重定向：context/glean-launch-<ts>.log 含启动头 + 桩 stdout JSON 面",
      logs.length === 1 && logText.includes("[bg-sentinel] glean launch at") && logText.includes("STUB_STDOUT_MARK"),
      { logs, head: logText.slice(0, 160) },
    );
    await sleep(2500);
    ck.ok("G3 冷却期内不二次拉起（桩恰一次）", stubRecords(c).length === 1, stubRecords(c).length);
    s.kill();
    await sleep(200);
  }

  /* ---- G4 桩立即退出非 0/1（黑盒）→ 短冷却 + 锁回退 + stderr ---- */
  {
    const c = makeCase("g4-early-exit", { lockRaw: LOCK_DONE_OLD });
    const s = startSentinel(c, { stubExit: 2, stubDelayMs: 10 });
    const launched = await waitFor(() => stubRecords(c).length >= 1, 10000);
    const restored = await waitFor(() => readText(c.lockFile) === LOCK_DONE_OLD, 5000);
    await waitFor(() => s.stderr.includes("glean 自动拉起失败"), 5000);
    const stamp = stampOf(c);
    ck.ok("G4 桩被拉起后立即退出 code=2", launched, { recs: stubRecords(c).length });
    ck.ok("G4 立即退出非 0/1 → 锁回退 done 快照（字节原样）", restored && readText(c.lockFile) === LOCK_DONE_OLD, readText(c.lockFile));
    ck.ok(
      "G4 失败短冷却（kind=short，until≈失败+1h）+ 状态文件清除",
      Boolean(stamp) &&
        stamp.kind === "short" &&
        Number(stamp.until_ms) - Date.now() > 55 * 60 * 1000 &&
        Number(stamp.until_ms) - Date.now() <= 1 * HOUR &&
        !fs.existsSync(c.stateFile),
      stamp,
    );
    ck.ok(
      "G4 stderr 一行（含 early-exit）",
      s.stderr.includes("glean 自动拉起失败") && s.stderr.includes("early-exit"),
      s.stderr.slice(0, 240),
    );
    await sleep(2200);
    ck.ok("G4 失败后短冷却期内不重试（桩恰一次）", stubRecords(c).length === 1, stubRecords(c).length);
    s.kill();
    await sleep(200);
  }

  /* ---- 库级准备：剥入口把 bg-sentinel 当库导入（黑盒测不到 spawn options/竞态/超时）---- */
  const SRC = fs.readFileSync(SENTINEL, "utf8").replace(/\r\n/g, "\n");
  const TAIL = "try {\n  main();\n} catch {\n  process.exit(0);\n}";
  const tailIdx = SRC.lastIndexOf(TAIL);
  ck.ok("G5-pre 哨兵入口可剥（探针结构无漂移）", tailIdx > 0, `tailIdx=${tailIdx}`);
  let lib = null;
  // 库副本放到 <tmp>/lib/hooks/ 并镜像 <tmp>/lib/agents/（persona 解析按 <模块>/../agents 定位），
  // 保证单元腿与生产入口读取同一份 persona，不污染插件目录。
  const LIBDIR = path.join(BASE.root, "lib");
  fs.mkdirSync(path.join(LIBDIR, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(LIBDIR, "agents"), { recursive: true });
  fs.copyFileSync(path.join(PLUGIN_DIR, "agents", "orch-gleaner.md"), path.join(LIBDIR, "agents", "orch-gleaner.md"));
  const LIB = path.join(LIBDIR, "hooks", "sentinel-glean-lib.mjs");
  if (tailIdx > 0) {
    fs.writeFileSync(
      LIB,
      SRC.slice(0, tailIdx) +
        "\nexport { tryLaunchGlean, acquireGleanLock, finishGleanLease, releaseGleanLock, gleanGateCheck, readGleanCfg, gleanMemoryRoot, buildGleanMessage, readGleanerPersona, housekeepGleanLaunch, maybeSuperviseGlean, gleanCooldownState, stampGleanCooldown, writeGleanState, readGleanState, clearGleanState, flipGleanLockDone, restoreGleanSnapshot };\n",
    );
    lib = await import(pathToFileURL(LIB).href);
  }

  if (lib) {
    /* ---- G5a spawn 异常 → 短冷却 + 锁回退 + stderr ---- */
    {
      const c = makeCase("g5a-spawn-error", { lockRaw: LOCK_DONE_OLD });
      let err = "";
      const orig = process.stderr.write;
      process.stderr.write = (chunk) => {
        err += String(chunk);
        return true;
      };
      let r = null;
      try {
        r = lib.tryLaunchGlean({
          rootDir: c.ROOT,
          projectDir: c.PROJ,
          argv: ["--glean-memory-root", c.MEM],
          slot: 0,
          cfg: CFG,
          spawnFn: () => {
            throw new Error("boom");
          },
        });
      } finally {
        process.stderr.write = orig;
      }
      const stamp = stampOf(c);
      ck.ok("G5a spawn 异常 → 失败返回 spawn-error", Boolean(r) && r.launched === false && r.reason === "spawn-error", r);
      ck.ok("G5a 锁回退原 done 快照（字节原样）", readText(c.lockFile) === LOCK_DONE_OLD, readText(c.lockFile));
      ck.ok("G5a 失败短冷却（kind=short）", Boolean(stamp) && stamp.kind === "short", stamp);
      ck.ok("G5a 无状态文件残留", !fs.existsSync(c.stateFile));
      ck.ok("G5a stderr 一行", err.includes("glean 自动拉起失败") && err.includes("spawn-error"), err.slice(0, 200));
      ck.ok("G5a 租约守卫已释放", !fs.existsSync(c.guardFile));
    }

    /* ---- G5b spawn options + 首条消息面 + 退出兜底翻锁（假 spawn 捕获）---- */
    {
      const c = makeCase("g5b-options");
      let cap = null;
      const em = new EventEmitter();
      em.pid = 424242;
      em.unref = () => {};
      const savedCli = process.env.ZCODE_CLI_PATH;
      process.env.ZCODE_CLI_PATH = "C:/fake/zcode.cjs";
      let r = null;
      try {
        r = lib.tryLaunchGlean({
          rootDir: c.ROOT,
          projectDir: c.PROJ,
          argv: ["--glean-memory-root", c.MEM],
          slot: 0,
          cfg: CFG,
          spawnFn: (cmd, args, opts) => {
            cap = { cmd, args, opts };
            return em;
          },
        });
      } finally {
        if (savedCli === undefined) delete process.env.ZCODE_CLI_PATH;
        else process.env.ZCODE_CLI_PATH = savedCli;
      }
      ck.ok("G5b 拉起返回 launched", Boolean(r) && r.launched === true, r);
      ck.ok(
        "G5b detached + stdio 日志重定向（ignore/stdout=stderr=日志 fd）+ windowsHide",
        Boolean(cap) &&
          cap.opts.detached === true &&
          Array.isArray(cap.opts.stdio) &&
          cap.opts.stdio[0] === "ignore" &&
          typeof cap.opts.stdio[1] === "number" &&
          cap.opts.stdio[1] === cap.opts.stdio[2] &&
          cap.opts.windowsHide === true,
        cap && { detached: cap.opts.detached, stdio: cap.opts.stdio, windowsHide: cap.opts.windowsHide },
      );
      ck.ok(
        "G5b 命令形 = node <ZCODE_CLI_PATH> -p <msg> --json --mode yolo",
        Boolean(cap) &&
          cap.cmd === process.execPath &&
          String(cap.args[0]).replace(/\\/g, "/").endsWith("/fake/zcode.cjs") &&
          cap.args[1] === "-p" &&
          cap.args[3] === "--json" &&
          cap.args[4] === "--mode" &&
          cap.args[5] === "yolo",
        cap && cap.args.slice(0, 2),
      );
      const msg = String((cap && cap.args[2]) || "");
      ck.ok("G5b 首条消息含 persona 关键句（记忆归敛代理 + GL 规则）", msg.includes("记忆归敛代理") && msg.includes("GL-12"));
      ck.ok(
        "G5b 首条消息内联关键句：全端/工作区/锁纪律/红线，且无任务包读取指令",
        msg.includes(c.MEM) &&
          msg.includes(c.ROOT) &&
          msg.includes("锁已由启动器持有（state=active）") &&
          msg.includes("不要写 board.json") &&
          !msg.includes("Read 任务包") &&
          !msg.includes("读取任务包"),
      );
      const lock = readJson(c.lockFile);
      const st = readState(c);
      ck.ok(
        "G5b 锁 active 持有者改记子进程 pid + 状态文件落盘 + 无冷却戳",
        Boolean(lock) &&
          lock.state === "active" &&
          lock.pid === 424242 &&
          Boolean(st) &&
          st.pid === 424242 &&
          st.launch_token === lock.launch_token &&
          !fs.existsSync(c.stampFile),
        { lock, st, stamp: fs.existsSync(c.stampFile) },
      );
      em.emit("exit", 0, null); // 模拟正常退出
      await sleep(20);
      const lockDone = readJson(c.lockFile);
      const stamp = stampOf(c);
      ck.ok(
        "G5b 退出兜底翻锁 done + 长冷却 + 状态清除（gleaner 未翻时哨兵翻）",
        Boolean(lockDone) &&
          lockDone.state === "done" &&
          lockDone.pid === 424242 &&
          Boolean(stamp) &&
          stamp.kind === "long" &&
          !fs.existsSync(c.stateFile),
        { lock: lockDone, stamp },
      );
    }

    /* ---- G5c emitter 立即退出 code=2 → 短冷却回退；code=0 → 长冷却容忍 ---- */
    {
      const c = makeCase("g5c-emitter-exit", { lockRaw: LOCK_DONE_OLD });
      const em = new EventEmitter();
      em.pid = 424243;
      em.unref = () => {};
      let err = "";
      const orig = process.stderr.write;
      process.stderr.write = (chunk) => {
        err += String(chunk);
        return true;
      };
      let r = null;
      try {
        r = lib.tryLaunchGlean({
          rootDir: c.ROOT,
          projectDir: c.PROJ,
          argv: ["--glean-memory-root", c.MEM],
          slot: 0,
          cfg: CFG,
          spawnFn: () => em,
        });
        em.emit("exit", 2, null);
      } finally {
        process.stderr.write = orig;
      }
      await sleep(20);
      const stamp = stampOf(c);
      ck.ok("G5c 拉起成功返回 (launched)", Boolean(r) && r.launched === true, r);
      ck.ok("G5c 立即退出 code=2 → 锁回退 done 快照", readText(c.lockFile) === LOCK_DONE_OLD, readText(c.lockFile));
      ck.ok("G5c 立即退出 → 短冷却（kind=short）", Boolean(stamp) && stamp.kind === "short", stamp);
      ck.ok("G5c 状态文件已清除", !fs.existsSync(c.stateFile));
      ck.ok("G5c stderr 含 early-exit", err.includes("early-exit"), err.slice(0, 200));
    }
    {
      const c = makeCase("g5c-exit-zero", { lockRaw: LOCK_DONE_OLD });
      const em = new EventEmitter();
      em.pid = 424244;
      em.unref = () => {};
      let r = null;
      try {
        r = lib.tryLaunchGlean({
          rootDir: c.ROOT,
          projectDir: c.PROJ,
          argv: ["--glean-memory-root", c.MEM],
          slot: 0,
          cfg: CFG,
          spawnFn: () => em,
        });
        em.emit("exit", 0, null);
      } finally {
        /* no-op */
      }
      await sleep(20);
      const lockDone = readJson(c.lockFile);
      const stamp = stampOf(c);
      ck.ok(
        "G5c' 立即退出 code=0 视为正常收工：兜底翻锁 done + 长冷却（不判失败）",
        Boolean(r) &&
          r.launched === true &&
          Boolean(lockDone) &&
          lockDone.state === "done" &&
          lockDone.pid === 424244 &&
          Boolean(stamp) &&
          stamp.kind === "long",
        { lock: lockDone, stamp },
      );
    }

    /* ---- G6 锁获取原子性：两并发进程只成一 ---- */
    {
      const c = makeCase("g6-race");
      const driver = path.join(c.base, "lease-driver.mjs");
      fs.writeFileSync(
        driver,
        `import { acquireGleanLock, finishGleanLease } from ${JSON.stringify(pathToFileURL(LIB).href)};
const [rootDir, memoryRoot] = process.argv.slice(2);
const acq = acquireGleanLock({ rootDir, memoryRoot, slot: 0, gcfg: { idle_hours: 0, new_events: 0, lock_stale_hours: 1.5 } });
process.stdout.write(JSON.stringify({ ok: acq.ok, reason: acq.reason || null }));
if (acq.ok) setTimeout(() => { finishGleanLease(acq); process.exit(0); }, 500); else process.exit(0);
`,
      );
      const run = () =>
        new Promise((resolve) => {
          const p = spawn(process.execPath, [driver, c.ROOT, c.MEM], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          p.stdout.on("data", (d) => (out += d));
          p.on("close", (code) => resolve({ code, out }));
        });
      const [ra, rb] = await Promise.all([run(), run()]);
      const parsed = [ra, rb].map((x) => {
        try {
          return JSON.parse(x.out);
        } catch {
          return null;
        }
      });
      const wins = parsed.filter((x) => x && x.ok === true).length;
      ck.ok("G6 两并发 acquire 只成一（wx 守卫串行化 + 先比对后写入）", wins === 1, { ra: parsed[0], rb: parsed[1] });
      ck.ok(
        "G6 败者让位原因 guard-busy / lock-busy",
        parsed.every(Boolean) &&
          parsed.filter((x) => x.ok === false).every((x) => x.reason === "guard-busy" || x.reason === "lock-busy"),
        parsed,
      );
      const lock = readJson(c.lockFile);
      ck.ok("G6 锁 active 单份（launch_token 在位）", Boolean(lock) && lock.state === "active" && typeof lock.launch_token === "string", lock);
    }

    /* ---- G7 锁 state 非 done 的未知态 → 放弃且原锁零改动 ---- */
    {
      const unknownRaw = JSON.stringify({ v: 1, state: "paused", pid: null }) + "\n";
      const c = makeCase("g7-unknown-state", { lockRaw: unknownRaw });
      const acq = lib.acquireGleanLock({
        rootDir: c.ROOT,
        memoryRoot: c.MEM,
        slot: 0,
        gcfg: { idle_hours: 0, new_events: 0, lock_stale_hours: 1.5 },
      });
      ck.ok("G7 锁 state 非 done（未知态）→ acquire 放弃", Boolean(acq) && acq.ok === false && acq.reason === "lock-busy", acq && acq.reason);
      ck.ok("G7 未知态原锁字节零改动", readText(c.lockFile) === unknownRaw);
      ck.ok("G7 守卫已释放", !fs.existsSync(c.guardFile));
    }

    /* ---- G8 门槛判定表 + temp 根全端目录 carve-out + 冷却戳形状 ---- */
    {
      const c = makeCase("g8-gate-table", { lockRaw: LOCK_DONE_OLD, projectLessons: '{"id":"l1"}\n{"id":"l2"}\n' });
      const recentDone =
        JSON.stringify({
          v: 1,
          state: "done",
          finished_at: new Date().toISOString(),
          watermarks: { global_lines: 0, projects: {} },
        }) + "\n";
      fs.writeFileSync(c.lockFile, recentDone);
      const g1 = lib.gleanGateCheck(c.MEM, c.ROOT, { idle_hours: 48, new_events: 10, lock_stale_hours: 1.5 }, Date.now());
      ck.ok("G8 时间门：刚归敛（idle 0 < 48h）→ stage=time 不 due", g1.due === false && g1.stage === "time", g1);
      fs.writeFileSync(c.lockFile, LOCK_DONE_OLD);
      const g2 = lib.gleanGateCheck(c.MEM, c.ROOT, { idle_hours: 0, new_events: 10, lock_stale_hours: 1.5 }, Date.now());
      ck.ok("G8 事件门：2 events < 10 → stage=events 不 due", g2.due === false && g2.stage === "events" && g2.events === 2, g2);
      const g3 = lib.gleanGateCheck(c.MEM, c.ROOT, { idle_hours: 0, new_events: 2, lock_stale_hours: 1.5 }, Date.now());
      ck.ok("G8 双门槛都过 → due（idle ∞ ∧ events 2）", g3.due === true && g3.events === 2, g3);
      const busyRaw =
        JSON.stringify({
          v: 1,
          state: "active",
          pid: process.pid,
          started_at: new Date().toISOString(),
          finished_at: null,
          watermarks: { global_lines: 2, projects: {} },
        }) + "\n";
      fs.writeFileSync(c.lockFile, busyRaw);
      const g4 = lib.gleanGateCheck(c.MEM, c.ROOT, { idle_hours: 0, new_events: 0, lock_stale_hours: 1.5 }, Date.now());
      ck.ok("G8 锁门：active 活 PID → busy，不 due", g4.due === false && g4.busy === true, { due: g4.due, stage: g4.stage, busy: g4.busy });
      const tempProj = path.join(BASE.root, "g8-carveout", "proj");
      const tempRoot = path.join(tempProj, ".zcode", "orchestrator");
      fs.mkdirSync(tempRoot, { recursive: true });
      ck.ok(
        "G8 temp 根全端目录自包含 <root>/orchestrator-memory（套件不碰真实家目录）",
        lib.gleanMemoryRoot([], {}, tempRoot) === path.join(tempRoot, "orchestrator-memory"),
        lib.gleanMemoryRoot([], {}, tempRoot),
      );
      // 冷却戳形状：新格式 until_ms 优先；旧 ISO 形状按长冷却兜底；过期即自由
      fs.writeFileSync(
        c.stampFile,
        JSON.stringify({ v: 1, at: new Date().toISOString(), until_ms: Date.now() + 2 * HOUR, kind: "short" }) + "\n",
      );
      const cs1 = lib.gleanCooldownState(c.ROOT, 24 * HOUR, Date.now());
      ck.ok("G8 冷却戳新形状：until_ms 生效且 kind=short（两档共用一枚戳）", cs1.active === true && cs1.kind === "short", cs1);
      fs.writeFileSync(c.stampFile, new Date().toISOString() + "\n");
      const cs2 = lib.gleanCooldownState(c.ROOT, 24 * HOUR, Date.now());
      ck.ok("G8 旧 ISO 戳 fallback：按长冷却 24h 生效", cs2.active === true && cs2.kind === "legacy-iso", cs2);
      fs.writeFileSync(
        c.stampFile,
        JSON.stringify({ v: 1, at: new Date().toISOString(), until_ms: Date.now() - 1000, kind: "long" }) + "\n",
      );
      const cs3 = lib.gleanCooldownState(c.ROOT, 24 * HOUR, Date.now());
      ck.ok("G8 冷却过期 → 自由", cs3.active === false, cs3);
    }

    /* ---- G9 挂死自愈 / 跨实例退出结算 ---- */
    {
      const base = Date.now();
      const activeLock = (pid, token) =>
        JSON.stringify({
          v: 1,
          state: "active",
          pid,
          started_at: new Date(base - 300 * 60 * 1000).toISOString(),
          finished_at: null,
          launch_token: token,
          watermarks: { global_lines: 0, projects: {} },
        }) + "\n";
      // G9a 存活 < 超时 → 监视不动作
      {
        const c = makeCase("g9a-running");
        const token = "tok-g9a";
        fs.writeFileSync(c.lockFile, activeLock(process.pid, token));
        writeState(c, {
          v: 1,
          pid: process.pid,
          started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          log_path: path.join(c.ctxDir, "glean-launch-x.log"),
          memory_root: c.MEM,
          root_dir: c.ROOT,
          launch_token: token,
          grace_ms: 2000,
          snapshot: null,
        });
        const before = readText(c.stateFile);
        const hk = lib.housekeepGleanLaunch({ rootDir: c.ROOT, cfg: CFG, killFn: () => true });
        ck.ok(
          "G9a 子进程存活且未到 240min → state=running，不击杀不翻锁无冷却",
          hk.state === "running" && readText(c.stateFile) === before && !fs.existsSync(c.stampFile) && readJson(c.lockFile).state === "active",
          hk,
        );
      }
      // G9b 存活 ≥ 超时 → 击杀进程树 + 翻锁 done + 长冷却 + stderr
      {
        const c = makeCase("g9b-timeout");
        const token = "tok-g9b";
        fs.writeFileSync(c.lockFile, activeLock(process.pid, token));
        writeState(c, {
          v: 1,
          pid: process.pid,
          started_at: new Date(Date.now() - 241 * 60 * 1000).toISOString(),
          log_path: path.join(c.ctxDir, "glean-launch-x.log"),
          memory_root: c.MEM,
          root_dir: c.ROOT,
          launch_token: token,
          grace_ms: 2000,
          snapshot: null,
        });
        let killedPid = null;
        let err = "";
        const orig = process.stderr.write;
        process.stderr.write = (chunk) => {
          err += String(chunk);
          return true;
        };
        let hk = null;
        try {
          hk = lib.housekeepGleanLaunch({
            rootDir: c.ROOT,
            cfg: CFG,
            killFn: (pid) => {
              killedPid = pid;
              return true;
            },
          });
        } finally {
          process.stderr.write = orig;
        }
        const lockDone = readJson(c.lockFile);
        const stamp = stampOf(c);
        ck.ok(
          "G9b 存活 ≥240min → state=timeout-killed 且击杀进程树（pid 逐字）",
          hk.state === "timeout-killed" && killedPid === process.pid,
          { hk, killedPid },
        );
        ck.ok(
          "G9b 击杀后翻锁 done（finished_at 锚击杀时刻）+ 状态文件清除",
          Boolean(lockDone) && lockDone.state === "done" && typeof lockDone.finished_at === "string" && !fs.existsSync(c.stateFile),
          lockDone,
        );
        ck.ok("G9b 长冷却（kind=long，24h）", Boolean(stamp) && stamp.kind === "long", stamp);
        ck.ok("G9b stderr 一行（挂死自愈 + 击杀）", err.includes("挂死自愈") && err.includes("击杀"), err.slice(0, 220));
      }
      // G9b2 存活 ≥ 超时但击杀失败 → 保持状态与锁（单飞不破），下轮重试
      {
        const c = makeCase("g9b2-kill-failed");
        const token = "tok-g9b2";
        fs.writeFileSync(c.lockFile, activeLock(process.pid, token));
        writeState(c, {
          v: 1,
          pid: process.pid,
          started_at: new Date(Date.now() - 241 * 60 * 1000).toISOString(),
          log_path: path.join(c.ctxDir, "glean-launch-x.log"),
          memory_root: c.MEM,
          root_dir: c.ROOT,
          launch_token: token,
          grace_ms: 2000,
          snapshot: null,
        });
        const before = readText(c.stateFile);
        let err = "";
        const orig = process.stderr.write;
        process.stderr.write = (chunk) => {
          err += String(chunk);
          return true;
        };
        let hk = null;
        try {
          hk = lib.housekeepGleanLaunch({ rootDir: c.ROOT, cfg: CFG, killFn: () => false });
        } finally {
          process.stderr.write = orig;
        }
        ck.ok(
          "G9b2 击杀未确认 → state=timeout-kill-failed，状态文件与 active 锁原样保留（单飞不破，下轮重试）",
          hk.state === "timeout-kill-failed" &&
            readText(c.stateFile) === before &&
            readJson(c.lockFile).state === "active" &&
            !fs.existsSync(c.stampFile) &&
            err.includes("击杀未确认"),
          { hk, err: err.slice(0, 120) },
        );
      }
      // G9c 死子进程超立即退出窗 → 兜底翻锁 + 长冷却
      {
        const c = makeCase("g9c-dead-after-grace");
        const token = "tok-g9c";
        fs.writeFileSync(c.lockFile, activeLock(999999901, token));
        writeState(c, {
          v: 1,
          pid: 999999901,
          started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          log_path: path.join(c.ctxDir, "glean-launch-x.log"),
          memory_root: c.MEM,
          root_dir: c.ROOT,
          launch_token: token,
          grace_ms: 2000,
          snapshot: null,
        });
        const hk = lib.housekeepGleanLaunch({ rootDir: c.ROOT, cfg: CFG, killFn: () => true });
        const lockDone = readJson(c.lockFile);
        const stamp = stampOf(c);
        ck.ok(
          "G9c 死子进程（超立即退出窗）→ state=exited + 兜底翻锁 done + 长冷却 + 状态清除",
          hk.state === "exited" &&
            Boolean(lockDone) &&
            lockDone.state === "done" &&
            Boolean(stamp) &&
            stamp.kind === "long" &&
            !fs.existsSync(c.stateFile),
          { hk, lock: lockDone, stamp },
        );
      }
      // G9d 死子进程窗内 → 回退快照 + 短冷却 + stderr
      {
        const c = makeCase("g9d-dead-recent");
        const token = "tok-g9d";
        fs.writeFileSync(c.lockFile, activeLock(999999901, token));
        writeState(c, {
          v: 1,
          pid: 999999901,
          started_at: new Date(Date.now() - 500).toISOString(),
          log_path: path.join(c.ctxDir, "glean-launch-x.log"),
          memory_root: c.MEM,
          root_dir: c.ROOT,
          launch_token: token,
          grace_ms: 2000,
          snapshot: { existed: true, raw: LOCK_DONE_OLD },
        });
        let err = "";
        const orig = process.stderr.write;
        process.stderr.write = (chunk) => {
          err += String(chunk);
          return true;
        };
        let hk = null;
        try {
          hk = lib.housekeepGleanLaunch({ rootDir: c.ROOT, cfg: CFG, killFn: () => true });
        } finally {
          process.stderr.write = orig;
        }
        const stamp = stampOf(c);
        ck.ok(
          "G9d 死子进程（立即退出窗内）→ state=failed + 锁回退快照 + 短冷却 + 状态清除",
          hk.state === "failed" &&
            readText(c.lockFile) === LOCK_DONE_OLD &&
            Boolean(stamp) &&
            stamp.kind === "short" &&
            !fs.existsSync(c.stateFile) &&
            err.includes("early-exit"),
          { hk, lock: readText(c.lockFile).slice(0, 80), stamp, err: err.slice(0, 120) },
        );
      }
    }
  }
} catch (err) {
  ck.ok("SUITE 未捕获异常", false, (err && err.stack) || String(err));
  exitCode = 1;
} finally {
  for (const k of KIDS) {
    try {
      k.kill();
    } catch {
      /* best effort */
    }
  }
  await sleep(300);
  const res = ck.summary();
  try {
    BASE.cleanup();
  } catch {
    /* Windows 句柄滞后：清理失败不判败 */
  }
  process.exit(res.fail ? 1 : exitCode);
}
