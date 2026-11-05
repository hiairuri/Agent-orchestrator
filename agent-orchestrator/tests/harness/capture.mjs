/*!
 * harness/capture.mjs —— 进程 stdout/exit code 捕获壳（哨兵/hook 用例的标准壳）
 *   runCapture：spawnSync 同步捕获（hook/stdin JSON 驱动，bg-gate 全分支用）
 *   captureBackground：spawn 异步捕获（哨兵长跑/stdout 丢弃类用例，A-v041-V05 同款）
 *
 * 覆盖断言组：A-v020-B01…B07、A-v031-S09、A-v050-M08…M10（bg-gate 全分支）；哨兵 live 组（L2）
 *   的后台捕获壳；l0-skeleton 的 fail-open 探针。
 *
 * 运行方式：作为模块 import；亦可自检直跑：
 *   node tests/harness/capture.mjs
 *   （自检=同步捕获 node -e 与后台捕获各一，打印 PASS/FAIL，exit 0/1）
 *
 * 前置：node >= 20。
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const isNodeExec = (s) => !s || s === "node" || (() => { try { return path.resolve(s) === process.execPath; } catch { return false; } })();

/** 同步捕获：{ code, stdout, stderr, json }（stdout 可解析为 JSON 时 json 非 null） */
export function runCapture({ script, args = [], input, cwd, env = {}, timeoutMs = 30000 }) {
  const isNode = isNodeExec(script);
  const cmd = isNode ? process.execPath : script;
  const r = spawnSync(cmd, isNode ? args : [script, ...args], {
    input: typeof input === "string" ? input : input === undefined ? undefined : JSON.stringify(input),
    cwd, encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: timeoutMs,
  });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { json = null; }
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", json, raw: r.stdout ?? "" };
}

/** node 脚本同步捕获糖：runNode("hooks/bg-gate.mjs", ["--policy","remind"], {input}) */
export function runNode(script, args = [], opts = {}) {
  return runCapture({ script: process.execPath, args: [script, ...args], ...opts });
}

/** hook 输入构型（bg-gate PreToolUse 同款） */
export function dispatchInput(prompt, extra = {}) {
  return { tool_name: "Agent", tool_input: { prompt, subagent_type: "general", ...extra } };
}

/** 后台捕获：立即返回句柄；done 为 Promise<{code, stdout}>；kill() 终止。
 *  script 缺省/"node" → 直接执行 args（如 -e 片段）；否则执行 node script args。 */
export function captureBackground({ script, args = [], cwd, env = {} }) {
  const isNode = isNodeExec(script);
  const argv = isNode ? args : [script, ...args];
  const proc = spawn(process.execPath, argv, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => { out += d; });
  const done = new Promise((resolve) => proc.on("close", (code) => resolve({ code, stdout: out })));
  return { proc, done, kill: () => { try { proc.kill(); } catch {} } };
}

// ---- 自检直跑：node tests/harness/capture.mjs ----
if (process.argv[1] && (await import("node:url")).pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let pass = 0, fail = 0;
  const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (c || x === undefined ? "" : " | " + JSON.stringify(x).slice(0, 200))); c ? pass++ : fail++; };
  const a = runCapture({ args: ["-e", "console.log(JSON.stringify({ok:1}))"] });
  ok("sync capture json", a.code === 0 && a.json?.ok === 1, a.stdout);
  const b = runCapture({ args: ["-e", "const s=fs.readFileSync(0,'utf8');console.log('len='+s.length)"], input: dispatchInput("hi") });
  ok("stdin passed", b.code === 0 && b.stdout.includes("len="), b.stdout);
  const bg = captureBackground({ args: ["-e", "setTimeout(()=>{console.log('bg-done');process.exit(3)},80)"] });
  const r = await bg.done;
  ok("background capture code+stdout", r.code === 3 && r.stdout.includes("bg-done"), r);
  console.log(`SUITE capture.selfcheck pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}
