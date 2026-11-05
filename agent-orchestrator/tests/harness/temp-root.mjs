/*!
 * harness/temp-root.mjs —— 临时根 T 构造（Windows %TEMP%）、board.json 手工构造助手、清理
 *
 * 覆盖断言组：全部用例的隔离根（CRV1..4/CR-V/M/SB/B 组、L0 骨架）；CR-V26（0.4.x 旧板种子）、
 *   CR-V16①（seed m-dead mission 供 agent_harvest mission 寻址）由 seedPostures/blankMission 承接。
 *
 * 运行方式：作为模块 import；亦可自检直跑：
 *   node tests/harness/temp-root.mjs [--root <临时根>]
 *   （自检=建根、写种子板、回读校验、清理，打印 PASS/FAIL，exit 0/1）
 *
 * 前置：node >= 20；可写 os.tmpdir()（或 --root 指定父目录不存在时回落 %TEMP%）。
 * 红线：只在 %TEMP%/--root 下写；只读插件源码。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 解析 --root <path>（缺省 null → makeTempRoot 用 mkdtemp） */
export function parseRootArg(argv = process.argv) {
  const i = argv.indexOf("--root");
  return i >= 0 ? argv[i + 1] : null;
}

/** 建临时根：给 root 则 mkdir 复用，否则 %TEMP% 下 mkdtemp。返回 { root, cleanup }。
 *  cleanup 带重试（Windows 句柄滞后释放的 EPERM 容忍，最多 5 次 × 200ms） */
export function makeTempRoot({ prefix = "orch-t-", root } = {}) {
  const dir = root ? (fs.mkdirSync(root, { recursive: true }), path.resolve(root)) : fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const rmRetry = () => {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch (e) {
        if (i === 4) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
    }
  };
  return { root: dir, cleanup: () => { try { rmRetry(); } catch {} } };
}

/** mission 骨架（v0.5 板全键；blankMission() 无任何 v0.5 新默认键——懒迁移断言的对照面） */
export function blankMission(over = {}) {
  const now = new Date().toISOString();
  return {
    id: over.id, title: over.title ?? "untitled", original_prompt: over.original_prompt ?? "",
    agent_type: over.agent_type ?? "", model: over.model ?? null,
    status: over.status ?? "drafted", dispatch: over.dispatch ?? {}, pack: over.pack ?? {},
    artifacts: over.artifacts ?? [], output_files: over.output_files ?? [],
    blocked: over.blocked ?? { question: null, asked_at: null, answered: false, answer: null, answered_at: null },
    ack: over.ack ?? null, blockedBy: over.blockedBy ?? [], owner: over.owner ?? null,
    claim: over.claim ?? null, qa: over.qa ?? null, skippedReason: over.skippedReason ?? null,
    timeline: over.timeline ?? [{ at: now, event: "upsert", summary: `created (status ${over.status ?? "drafted"})` }],
    updated_at: now,
  };
}

/** 构造 board.json 内容（version=2） */
export function boardSeed(missions = [], { version = 2 } = {}) {
  return JSON.stringify({ version, updated_at: new Date().toISOString(), missions }) + "\n";
}

export function writeBoardSeed(root, missions, opts) {
  const p = path.join(root, "board.json");
  fs.writeFileSync(p, typeof missions === "string" ? missions : boardSeed(missions, opts));
  return p;
}

export function readBoard(root) { return JSON.parse(fs.readFileSync(path.join(root, "board.json"), "utf8")); }
export function missionOf(root, id) { return readBoard(root).missions.find((m) => m && m.id === id); }

// ---- 自检直跑：node tests/harness/temp-root.mjs [--root <临时根>] ----
if (process.argv[1] && (await import("node:url")).pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let pass = 0, fail = 0;
  const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (c || x === undefined ? "" : " | " + JSON.stringify(x))); c ? pass++ : fail++; };
  const argRoot = parseRootArg();
  const t = makeTempRoot({ prefix: "orch-temproot-selfcheck-", root: argRoot || undefined });
  ok("root exists", fs.existsSync(t.root), t.root);
  writeBoardSeed(t.root, [blankMission({ id: "m1", status: "running" })]);
  const b = readBoard(t.root);
  ok("seed readback v2 + mission", b.version === 2 && b.missions[0].id === "m1" && !("scope_paths" in b.missions[0]));
  ok("missionOf", missionOf(t.root, "m1")?.status === "running");
  t.cleanup();
  ok("cleanup removed", !fs.existsSync(t.root));
  console.log(`SUITE temp-root.selfcheck pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}
