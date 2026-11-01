#!/usr/bin/env node
/*!
 * tests/run-headless-smoke.mjs —— v1.3 W6 F-C6：headless 真跑冒烟（发版门人工执行件）
 *
 * 任务权威：designs/agent-orchestrator-v1.3-planning/qa/waves-finding.md §W6（impl-plan §2 W6 逐字）：
 *   临时根+播种拷贝复用 dispatch-runner 链（--provider-config-seed）→ 真 CLI `-p` 最小 prompt →
 *   ≤120s 断言会话达任一终态（模型类失败=FAIL+hint 文案族复用 tool-dispatch 旧 7755-7767 →
 *   现 mcp/tool-dispatch.mjs 分叉文案族）。对 W5+WG 落定后的终态派发语义做实弹验证。
 *
 * 独立脚本纪律（§6.D 红线）：**不挂 run-all／不挂 REGISTRY**（外部依赖不入回归门）；tests/ 根
 *   落位非 suites/（LM-04 套件集锁不触）。发版门人工执行（AGENTS.md V7-27 步 1b 候主控段落位）。
 *
 * 逃生门：env `ORCH_SKIP_HEADLESS_SMOKE` 非空 → SKIP+留痕 exit 0（U6 强制级：SKIP 仅限外部
 *   依赖不可用+留痕；FAIL=停版）。
 *
 * CLI 路径解析（K6 裁定：对齐 dispatch-runner.mjs:227 实名链，非 impl-plan 原稿自定 ZCODE_CLI）：
 *   `--cli <path>` argv ‖ env `ZCODE_CLI_PATH`；两者缺席 → SKIP+留痕（缺席=skip 承 §6.C 逐字；
 *   runner 自带 DEFAULT_CLI 与 bg-sentinel/glean-launch.mjs GLEAN_CLI_DEFAULT 同路径可对读，
 *   冒烟侧不默认回落——外部依赖缺席属 SKIP 域，防 typo env 静默走真跑）。
 *
 * 用法（Windows Git Bash，插件根 plugins/agent-orchestrator/ 下）：
 *   ZCODE_CLI_PATH="C:\Program Files\ZCode\resources\glm\zcode.cjs" node tests/run-headless-smoke.mjs
 *   可选：--cli <path>（优先于 env）；--keep（PASS 也保留现场；缺省=FAIL 保现场候诊断/PASS·SKIP 清理）
 *
 * 红线：凭据零打印（种子/日志尾出口统一 redact）；临时根外零写入；CLI 二进制只执行不改写
 *   （活体安装面禁触）。每整跑恰 1 次 CLI spawn（真跑预算由操作方控制，本波 ≤5）。
 *
 * 前置：node >= 20；外部依赖=zcode CLI + 模型可用（缺席/不可用 → SKIP 或如实 FAIL，不修饰）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempRoot } from "./harness/temp-root.mjs";

/** dispatch-runner.mjs:227 同款旗标取值（--flag v 与 --flag=v 双形） */
function argOf(argv, flag, def = "") {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1] ?? def;
    if (argv[i].startsWith(flag + "=")) return argv[i].slice(flag.length + 1);
  }
  return def;
}

/** 凭据零打印：出口文本统一过 redact（api key 形态/bearer 形态） */
function redact(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1[REDACTED]");
}

/** dispatchFailureSummary（tool-dispatch.mjs）同款分类白名单：拥塞形态族＋选模型形态 */
const RE_CONGESTED = /1305|429|overloaded|rate.?limit/i;
const RE_SELECT_MODEL = /Select a model/i;

/** hint 文案族复用（tool-dispatch.mjs modelCongested/modelError/提前退出三支骨架；洞按冒烟侧实况填） */
function hintFor(classification, detail) {
  if (classification === "modelCongested") {
    return (
      "headless 子代理死于模型拥塞（上游 1305/429/overloaded/rate limit）。冒烟链本体（runner 播种/" +
      "spawn/index 落盘/分类面）已达终态，失败在模型供给域——核查模型可用性后重跑本冒烟（重派语义同）：" +
      redact(detail).slice(0, 300)
    );
  }
  if (classification === "modelError") {
    return (
      "headless 子代理未启动：CLI 在发消息前要求选模型（该机器 -p 无模型供给）。" +
      "本冒烟经 --provider-config-seed 播种链复用 dispatch-runner 供给；seeded:false 时请先在桌面/交互模式" +
      "打开该项目 /model 选型并保存为默认，或显式传 --cli/env ZCODE_CLI_PATH 后重跑。"
    );
  }
  return (
    "headless 子代理未按终态语义收束（CLI 提前退出/超时/index 未落）。查 runner 日志与 error 侧车定位" +
    "（现场路径见 record.scene）；修复后直接重跑（U6：FAIL=停版，勿带 FAIL 发版）。" +
    (detail ? " 诊断：" + redact(detail).slice(0, 300) : "")
  );
}

function main() {
  const argv = process.argv.slice(2);
  const keepArg = argv.includes("--keep");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const record = {
    script: "tests/run-headless-smoke.mjs",
    wave: "v1.3 W6 F-C6",
    started_at: new Date().toISOString(),
    status: null,
    cli: null,
    cli_source: null,
    seed_seeded: false,
    seed_bytes: null,
    runner_timeout_min: 2,
    assert_window_s: 120,
    spawn_attempts: 0,
    elapsed_ms: null,
    index: null,
    landed_phase: null,
    classification: null,
    scene: null,
  };

  const finish = (status, extra) => {
    record.status = status;
    record.elapsed_ms = Date.now() - Date.parse(record.started_at);
    console.log("SMOKE-RECORD " + JSON.stringify({ ...record, ...(extra || {}) }));
    console.log(
      status === "PASS"
        ? "PASS run-headless-smoke（真跑终态语义收束；留痕本行+record）"
        : status === "SKIP"
          ? "SKIP run-headless-smoke（外部依赖缺席/逃生门——U6 允许域，留痕本行+record）"
          : "FAIL run-headless-smoke（U6：FAIL=停版，勿带 FAIL 发版）",
    );
    process.exit(status === "FAIL" ? 1 : 0);
  };

  // ---- 逃生门（§6.C 步 2 承接：跳过+留痕）
  if (String(process.env.ORCH_SKIP_HEADLESS_SMOKE || "").trim()) {
    console.log("[skip] ORCH_SKIP_HEADLESS_SMOKE 在场——逃生门生效，零 spawn。");
    finish("SKIP", { skip_reason: "escape_hatch_env" });
  }

  // ---- CLI 解析（K6 裁定：对齐 dispatch-runner.mjs:227 实名链；缺席=SKIP+留痕）
  const cliArg = argOf(argv, "--cli");
  const cliEnv = String(process.env.ZCODE_CLI_PATH || "").trim();
  const cliPath = cliArg || cliEnv;
  record.cli = cliPath || null;
  record.cli_source = cliArg ? "argv --cli" : cliEnv ? "env ZCODE_CLI_PATH" : "absent";
  if (!cliPath) {
    console.log("[skip] CLI 路径缺席（--cli 与 ZCODE_CLI_PATH 均空）——缺席=skip+留痕（§6.C 逐字）。");
    finish("SKIP", { skip_reason: "cli_env_absent" });
  }
  if (!fs.existsSync(cliPath)) {
    console.log("[skip] CLI 文件不存在：" + cliPath + "——外部依赖不可用→SKIP（U6 允许域），留痕。");
    finish("SKIP", { skip_reason: "cli_file_missing" });
  }

  // ---- 临时根+播种拷贝（--provider-config-seed 复用 dispatch-runner 链）
  const T = makeTempRoot({ prefix: "orch-headless-smoke-" });
  record.scene = T.root;
  const resultsDir = path.join(T.root, "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const promptFile = path.join(T.root, "prompt.md");
  fs.writeFileSync(promptFile, "[worker] orch-headless-smoke#1\n\nReply with exactly: ok\n", "utf8");
  const logFile = path.join(T.root, "runner.log");

  // 播种拷贝（v1.1.1-FA 语义的最小忠实形：personal config 深拷贝落临时根，经 runner 的
  // ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 重定向喂 CLI——原配置零触碰，内容零打印）。
  // 注：选型改写（两源+拥塞降级）系 server 侧 dispatchSeedModelConfig 域（dispatch-supply 套件
  // 承载），冒烟链按 impl-plan 逐字只验「播种拷贝→runner→CLI→终态」本体。
  let providerConfigSeed = null;
  const personal = String(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || "").trim();
  if (personal) {
    try {
      const doc = JSON.parse(fs.readFileSync(personal, "utf8"));
      if (doc && typeof doc === "object" && doc.config && typeof doc.config === "object") {
        providerConfigSeed = path.join(T.root, "dispatch-model-seed", "smoke-" + stamp + ".json");
        fs.mkdirSync(path.dirname(providerConfigSeed), { recursive: true });
        const payload = JSON.stringify(JSON.parse(JSON.stringify(doc)), null, 2) + "\n";
        fs.writeFileSync(providerConfigSeed, payload, "utf8");
        record.seed_seeded = true;
        record.seed_bytes = Buffer.byteLength(payload, "utf8");
        console.log("[seed] 播种拷贝落临时根（字节=" + record.seed_bytes + "；内容零打印）。");
      } else {
        console.log("[seed] personal config 形状不符（无 config 对象）——零播种直跑（子进程继承父 env）。");
      }
    } catch (err) {
      console.log("[seed] personal config 不可读——零播种直跑（子进程继承父 env）：" + redact(err && err.message));
    }
  } else {
    console.log("[seed] ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 缺席——零播种直跑（子进程继承父 env）。");
  }

  // ---- 复用 dispatch-runner 链（worktree 内相对解析——冒烟对象=本仓 runner，活体安装零触）
  const runnerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "dispatch-runner.mjs");
  if (!fs.existsSync(runnerPath)) {
    console.log("[fail] dispatch-runner.mjs 缺失：" + runnerPath);
    finish("FAIL", { error: "runner_missing" });
  }
  const missionId = "m-smoke-" + stamp;
  const runnerArgs = [
    runnerPath,
    "--mission-id", missionId,
    "--prompt", promptFile,
    "--cwd", T.root,
    "--result-dir", resultsDir,
    "--log", logFile,
    "--timeout-min", String(record.runner_timeout_min),
    ...(providerConfigSeed ? ["--provider-config-seed", providerConfigSeed] : []),
  ];
  console.log("[run] spawn dispatch-runner（CLI=" + cliPath + "；timeout=" + record.runner_timeout_min + "min）");
  record.spawn_attempts = 1;
  const child = spawn(process.execPath, runnerArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let runnerOut = "";
  child.stdout.on("data", (d) => (runnerOut += d));
  child.stderr.on("data", (d) => (runnerOut += d));

  // ---- ≤120s 断言会话达任一终态（轮询 result index；+15s 杀树/落盘宽限，总墙钟 ≤135s）
  const indexGlob = () => {
    try {
      return fs.readdirSync(resultsDir).filter((f) => f.startsWith(missionId) && f.endsWith(".index.json"));
    } catch {
      return [];
    }
  };
  const deadline = Date.now() + (record.assert_window_s + 15) * 1000;
  let indexFile = null;
  while (Date.now() < deadline) {
    const hits = indexGlob();
    if (hits.length) {
      indexFile = path.join(resultsDir, hits[0]);
      record.landed_phase = Date.now() - Date.parse(record.started_at) <= record.assert_window_s * 1000
        ? "within_120s"
        : "grace_window";
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  const killTree = () => {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      /* best effort */
    }
  };
  if (!indexFile) {
    killTree();
    console.log("[fail] " + record.assert_window_s + "s 内 result index 未落（runner 输出尾=" + redact(runnerOut.slice(-400)) + "）");
    finish("FAIL", { classification: "no_terminal_state", hint: hintFor("other", runnerOut.slice(-400)) });
  }

  // ---- 终态分类（index.outcome 三态 result|error|timeout＋killed index；error 侧车分类白名单同 dispatchFailureSummary）
  let idx = null;
  try {
    idx = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  } catch (err) {
    killTree();
    finish("FAIL", { classification: "index_unparsable", hint: hintFor("other", "index 不可读：" + (err && err.message)), index: indexFile });
  }
  record.index = { file: path.basename(indexFile), outcome: idx.outcome ?? null, killed: !!idx.killed, exit_code: idx.exit_code ?? null, session_id: idx.session_id ?? null };

  const tailOf = () => {
    try {
      const side = idx.error_path ? JSON.parse(fs.readFileSync(idx.error_path, "utf8")) : null;
      return String((side && side.log_tail) || side && side.error || idx.error || "");
    } catch {
      return String(idx.error || "");
    }
  };
  const tail = tailOf();
  if (idx.outcome === "result" && idx.session_id && !idx.killed) {
    if (!keepArg) T.cleanup();
    console.log("[ok] 终态=result（session_id=" + idx.session_id + "；exit_code=" + idx.exit_code + "；落窗=" + record.landed_phase + "）");
    finish("PASS");
  }
  const classification = idx.killed
    ? "killed"
    : idx.outcome === "timeout"
      ? "timeout"
      : RE_CONGESTED.test(tail)
        ? "modelCongested"
        : RE_SELECT_MODEL.test(tail)
          ? "modelError"
          : "chainError";
  killTree();
  if (keepArg) console.log("[scene] --keep 在场：临时根现场保留=" + T.root);
  console.log("[fail] 终态=" + record.index.outcome + "/killed=" + record.index.killed + "；分类=" + classification);
  if (tail) console.log("[fail] 诊断尾（redact 后）：" + redact(tail.split(/\r?\n/).filter(Boolean).slice(-3).join(" ⏎ ")).slice(0, 600));
  finish("FAIL", { classification, hint: hintFor(classification === "modelCongested" ? "modelCongested" : classification === "modelError" ? "modelError" : "other", tail) });
}

main();
