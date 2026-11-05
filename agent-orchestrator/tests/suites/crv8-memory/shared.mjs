// @module crv8-memory/shared
/*!
 * suites/crv8-memory/shared.mjs —— crv8-memory suite 共享夹具/工具（v1.3 W1 巨型文件拆分，
 *   自 crv8-memory.mjs 原样搬运，断言主体见同目录各场景模块）。
 *
 * ck/BASE 为 suite 级单例：全部场景模块 import 本模块共享同一 Checker（SUITE 摘要行
 *   "crv8-memory" 口径不变）与同一临时根（BASE.cleanup() 仍由薄入口在全部场景后调用）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { startServer, Checker, DEFAULT_SERVER, PLUGIN_DIR, TESTS_DIR, PRE } from "../../harness/jsonrpc-client.mjs";
import { makeTempRoot, parseRootArg, blankMission, writeBoardSeed } from "../../harness/temp-root.mjs";
import { exportFileFromGit, repoRoot } from "../../harness/git-fixture.mjs";

const ck = new Checker("crv8-memory");
const BASE = makeTempRoot({ prefix: "orch-crv8-", root: parseRootArg() || undefined });
const HOOKS_SRC = path.join(PLUGIN_DIR, "hooks", "session-start.mjs");
// v0.9 W1（C5 落值 0.40→0.39）起，INJ-02 常量锁「防漂移第二文件」改钉 v0.9.x.md
// （v0.8.x.md 保留 0.8 期历史记录，不在本波写集；现行值锁面=INJECT_MIN_SCORE=0.39）。
const ASSERT_DOC = path.join(TESTS_DIR, "assertions", "v0.9.x.md");

const resultText = (r) => r.json ?? { _raw: r.text };
const subRoot = (name) => {
  const dir = path.join(BASE.root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const readPack = (rootDir, mid, file = "pack.md") => {
  const p = path.join(rootDir, "packs", mid, file);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
};
const readLessons = (rootDir) =>
  fs
    .readFileSync(path.join(rootDir, "memory", "lessons.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
const approx2 = (x) => Number(Number(x).toFixed(2));
const writeJsonl = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
const readJsonl = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
const normPath = (p) => path.resolve(String(p)).toLowerCase();

/**
 * v0.10 G2 直写→server 读回屏障（照 ENV-06c 配方，勿发明新机制）：glean 锁由测试
 * 进程直写后，server 侧以锁文件 mtimeMs 作 lastGleanMs 与自身 Date.now() 求差。NTFS
 * mtime 时钟粒度/时钟源偏移下 mtime 可略「未来」于 Date.now()（本机直写探针实测
 * -10ms 量级、40/40 例），idle_hours=0 的严格 `idleH > 0` 时间门首读会落空（响应无
 * orch_memory.glean 键）——与 ENV-06a「直写 now 被判未来」同族。轮询同一读面直到
 * 锁状态对 server 可见（glean 键出现）再断言；语义不变：真回归时轮询窗内恒不可见，
 * 末次响应照常判红（与 ENV-06c board get 读回屏障同构）。
 */
const gleanAfterWrite = async (rawCall, tries = 60, stepMs = 50) => {
  let glean = null;
  for (let i = 0; i < tries; i++) {
    const r = await rawCall("lessons", { action: "list" });
    glean = (r.result && r.result.orch_memory && r.result.orch_memory.glean) || null;
    if (glean) return glean;
    await new Promise((res) => setTimeout(res, stepMs));
  }
  return glean;
};

/**
 * W2 rig：harness startServer 的扩展参数孪生（--memory-root 注入用）。jsonrpc-client.mjs
 * 不在本波写集内，故本套自带 spawn——按行 JSON-RPC 协议与 harness 逐字同款。
 */
function startServerX({ serverPath = DEFAULT_SERVER, root, args = [], timeoutMs = 20000 } = {}) {
  const child = spawn(process.execPath, [serverPath, "--root", root, ...args], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("timeout " + method));
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
    });
  const call = async (name, args2) => {
    const r = await request("tools/call", { name: PRE + name, arguments: args2 });
    const result = r.result || {};
    const text = (result.content ?? []).map((c) => c.text).join("\n");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 文本（错误文案） */
    }
    return { isError: result.isError === true, text, json };
  };
  const close = () => {
    try {
      child.stdin.end();
    } catch {}
    try {
      child.kill();
    } catch {}
  };
  return { request, call, close };
}

export {
  startServer,
  DEFAULT_SERVER,
  PLUGIN_DIR,
  TESTS_DIR,
  PRE,
  blankMission,
  writeBoardSeed,
  exportFileFromGit,
  repoRoot,
  ck,
  BASE,
  HOOKS_SRC,
  ASSERT_DOC,
  resultText,
  subRoot,
  readPack,
  readLessons,
  approx2,
  writeJsonl,
  readJsonl,
  normPath,
  gleanAfterWrite,
  startServerX,
};
