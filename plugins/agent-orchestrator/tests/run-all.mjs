#!/usr/bin/env node
/*!
 * tests/run-all.mjs —— 全量回归入口（=发版门）。按 CR-15 分层跑断言 ID 子集对应的 suites。
 *
 * 覆盖断言组：L0 骨架（l0-skeleton：A-v041-R01 静态子集/tools=11〔v0.6 A6 probe 转正〕/BOARD_VERSION/hooks.json/SB09+M07/B07
 *   + lint-manifest：V7-12 发版 lint LM-01 约定路径防复发〔W-F4 钉〕/LM-02 manifest 引用存在/LM-03 版本三方一致）
 *   + L1 直接层全跑（sb-normalize=SB01/02/05+M01/02；crv1-scope=CRV1-01..08+E4+M04；
 *   crv2-pack=CRV2-01..08+CR-V22/23/24/25；crv4-audit=CRV4-01..05+CR-V18..V21/V29；
 *   crv3-present=CRV3-01..03+CR-V26/27/28+M03/05/06；condense=CR-V9/10/16；bggate=M08..M10+B01..07+S09；sentinel-teardown=哨兵 v2.1 待命/轮换 T1..T4）。
 *   v0.6 新增七套（G 胶水波入册）：crv5-auth=A-v060-AUTH/SCOPE/INJ-01；crv6-statemachine=SM/P2P-01；
 *   crv5-apply-envelope=QUOT/LOCK/ENV；crv6-resilience=SG/SPL/RES/HRV/ATW/GC/INJ-02..04；
 *   root-contract=root-id 契约矩阵（P1..P10+S1..S5）；typed-dispatch-docs=文档在位 18 断言+RECYCLE_LIST；
 *   probe-caps=PROBE-01..10。断言主句权威见 tests/assertions/v0.6.x.md。
 *   v0.7.1 新增一套：watcher-core=W1 watcher 守护进程纯逻辑 117 断言（模板/分类/降级树/频控/脱敏自检，
 *   ws 层全 mock 零生产中继；设计权威 (internal design docs, not published) + EXP-1/2/3 findings；
 *   套注册行归主控胶水先例）。断言主句权威见 tests/assertions/v0.7.x.md 与 watcher-core.mjs 头注。
 *   L2 邻接层（哨兵 live V 组、lessons/journal/stop-check）与 L3 手工/文档项不在本入口自动化——
 *   执行载体见 tests/assertions/v0.4.x.md §3 映射表与 §10 总表。
 *
 * 运行方式：node tests/run-all.mjs [--layer L0|L1|all] [--ids <suite 名,逗号分隔>] [--root <临时根父目录>]
 *   每个 suite 在干净临时根（%TEMP% 下新 mkdtemp，或 --root 指向的父目录）中独立运行，互不串扰。
 * 前置：node >= 20；PATH 上有 git（sandbox 用例/0.4.1 基线导出）；无网。
 * 退出码：全绿 0；任一 FAIL 非 0。发版门口径：--layer all 全绿（当前=L0+L1）。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SUITES_DIR = path.join(TESTS_DIR, "suites");

const REGISTRY = [
  { name: "l0-skeleton", layer: "L0" },
  { name: "lint-manifest", layer: "L0" },
  { name: "sb-normalize", layer: "L1" },
  { name: "crv1-scope", layer: "L1" },
  { name: "crv2-pack", layer: "L1" },
  { name: "crv4-audit", layer: "L1" },
  { name: "crv3-present", layer: "L1" },
  { name: "condense", layer: "L1" },
  { name: "bggate", layer: "L1" },
  { name: "sentinel-teardown", layer: "L1" },
  { name: "crv5-auth", layer: "L1" },
  { name: "crv6-statemachine", layer: "L1" },
  { name: "crv5-apply-envelope", layer: "L1" },
  { name: "crv6-resilience", layer: "L1" },
  { name: "root-contract", layer: "L1" },
  { name: "typed-dispatch-docs", layer: "L1" },
  { name: "probe-caps", layer: "L1" },
  { name: "watcher-core", layer: "L1" },
  { name: "crv8-memory", layer: "L1" },
];

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}
const layer = (argOf("--layer") || "all").toLowerCase();
const ids = (argOf("--ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
const root = argOf("--root");

let selected = REGISTRY.filter((r) => layer === "all" || r.layer.toLowerCase() === layer);
if (ids.length) selected = selected.filter((r) => ids.includes(r.name));
if (!selected.length) {
  console.error("run-all: no suite selected（--layer " + layer + (ids.length ? " --ids " + ids.join(",") : "") + "）");
  console.error("可用 suites：", REGISTRY.map((r) => r.name + "(" + r.layer + ")").join(", "));
  process.exit(2);
}

const t0 = Date.now();
console.log(`== run-all layer=${layer} suites=[${selected.map((r) => r.name).join(", ")}] ==`);
const results = [];
for (const r of selected) {
  const suite = path.join(SUITES_DIR, r.name + ".mjs");
  const args = [suite];
  if (root) args.push("--root", root);
  const tS = Date.now();
  const p = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  const secs = ((Date.now() - tS) / 1000).toFixed(1);
  const out = (p.stdout || "") + (p.stderr ? "\n[stderr]\n" + p.stderr.slice(-800) : "");
  const tailLine = (p.stdout || "").split("\n").filter((l) => l.startsWith("SUITE ")).pop() || `SUITE ${r.name} (no summary line)`;
  const green = p.status === 0;
  results.push({ name: r.name, layer: r.layer, green, secs, tailLine });
  console.log(`\n---- ${r.name} [${r.layer}] ${green ? "GREEN" : "RED"} (${secs}s) ----`);
  console.log(out.trim().split("\n").slice(-60).join("\n"));
}

console.log("\n== SUMMARY ==");
for (const r of results) console.log(`${r.green ? "GREEN" : "RED  "}  ${r.layer}  ${r.name.padEnd(14)} ${r.secs + "s"}  ${r.tailLine}`);
const reds = results.filter((r) => !r.green);
console.log(`\nrun-all: ${results.length - reds.length}/${results.length} suites green, total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(reds.length ? "FAILED: " + reds.map((r) => r.name).join(", ") : "ALL GREEN（发版门口径：L0+L1 全绿；L2/L3 手工项见断言文件映射表）");
process.exit(reds.length ? 1 : 0);
