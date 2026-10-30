#!/usr/bin/env node
/*!
 * tests/run-smoke.mjs —— 骨架冒烟入口（=日常）。≤60s 全绿才放行日常迭代。
 *
 * 覆盖断言组：L0 骨架全套（l0-skeleton：node --check/tools=12〔v0.6 A6 probe 转正 + v1.1.1 W20 dispatch〕/BOARD_VERSION=2/hooks.json
 *   4 事件+bg-gate args 含 --contract/SB09+M07 静态红线/sentinel_health 形状/B07 fail-open）
 *   + 板面回环（board upsert/get/list/claim 快速冒烟，CRV1 首步口径）。
 *
 * 运行方式：node tests/run-smoke.mjs [--root <临时根>]
 * 前置：node >= 20；无网（hooks.json 对拍已由传参接线断言取代）。
 * 退出码：全绿且 ≤60s → 0；否则 1。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const argRoot = (() => { const i = process.argv.indexOf("--root"); return i >= 0 ? process.argv[i + 1] : null; })();
const t0 = Date.now();
let fail = 0;
const ok = (name, cond, extra) => {
  if (!cond) fail++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond || extra === undefined ? "" : " | " + String(extra).slice(0, 200)}`);
};

// ---- 1) L0 骨架 suite（独立子进程，自带临时根）
const p = spawnSync(process.execPath, [path.join(TESTS_DIR, "suites", "l0-skeleton.mjs")], { encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
const l0Lines = (p.stdout || "").split("\n");
const l0Summary = l0Lines.filter((l) => l.startsWith("SUITE ")).pop() || "";
const l0Fail = Number((l0Summary.match(/fail=(\d+)/) || [])[1] ?? 1);
ok("L0 l0-skeleton（" + l0Summary.trim() + "）", p.status === 0 && l0Fail === 0, (p.stdout || "").split("\n").filter((l) => l.startsWith("FAIL")).join(" ; ") || p.stderr?.slice(-300));

// ---- 2) 板面回环冒烟（独立临时根 + 黑盒四连；进程内 import）
{
  const { startServer } = await import("./harness/jsonrpc-client.mjs");
  const T = path.join(argRoot || os.tmpdir(), "orch-smoke-" + Date.now());
  fs.mkdirSync(T, { recursive: true });
  const s = startServer({ root: T });
  try {
    const up = await s.call("board", { action: "upsert", mission: { id: "smoke-1", title: "smoke", status: "drafted" } });
    ok("板面 upsert", !up.isError && up.json?.ok === true, up.text.slice(0, 120));
    const got = await s.call("board", { action: "get", mission_id: "smoke-1" });
    ok("板面 get（t1_head 懒迁移 null）", got.json?.id === "smoke-1" && got.json?.t1_head === null, got.text.slice(0, 120));
    const cl = await s.call("board", { action: "claim", mission_id: "smoke-1", worker: "smoke" });
    ok("板面 claim", cl.json?.ok === true, cl.text.slice(0, 120));
    const ls = await s.call("board", { action: "list" });
    ok("板面 list", Array.isArray(ls.json?.missions) && ls.json.missions.length === 1, ls.text.slice(0, 120));
  } catch (e) {
    ok("板面回环驱动", false, String(e).slice(0, 200));
  } finally {
    s.close();
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  }
}

const secs = (Date.now() - t0) / 1000;
console.log(`\nrun-smoke: ${fail === 0 ? "ALL GREEN" : "FAILED " + fail} in ${secs.toFixed(1)}s（门限 ≤60s）`);
process.exit(fail === 0 && secs <= 60 ? 0 : 1);
