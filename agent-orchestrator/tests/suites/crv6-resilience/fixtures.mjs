// @module crv6-resilience/fixtures
/*!
 * suites/crv6-resilience/fixtures.mjs —— crv6-resilience suite 共享夹具
 * （2026-11-01 拆分自 crv6-resilience.mjs 头部：Checker/临时根/工具函数/spool 种子。
 * 场景模块统一经本模块取夹具与 harness 出口；夹具实现零改动，仅加 export 接线。
 * 临时根在本模块加载时创建（与拆前入口文件顶部同时序），入口按原顺序聚合场景。）
 */
import fs from "node:fs";
import path from "node:path";
import { startServer, Checker, DEFAULT_SERVER, PLUGIN_DIR } from "../../harness/jsonrpc-client.mjs";
import { runNode } from "../../harness/capture.mjs";
import { makeTempRoot, parseRootArg, blankMission, writeBoardSeed, readBoard } from "../../harness/temp-root.mjs";

const ck = new Checker("crv6-resilience");
const BASE = makeTempRoot({ prefix: "orch-crv6res-", root: parseRootArg() || undefined });
const T = BASE.root;
const resultText = (r) => r.json ?? { _raw: r.text };
const unreadDirOf = (mid) => path.join(T, "spool", mid, "unread");
const jsonFiles = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const HOURS = 3600 * 1000;
const subRoot = (name) => {
  const dir = path.join(T, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
/** root 下 board.json.corrupt-* / .prev-* / .recovered 族文件列举 */
const rootVariants = (root, suffix) =>
  fs.existsSync(root) ? fs.readdirSync(root).filter((f) => f.includes(suffix)) : [];

/** 手工种一个 spool 事件文件（与 report 写面同 shape） */
function seedEvent(mid, id, text) {
  const dir = unreadDirOf(mid);
  fs.mkdirSync(dir, { recursive: true });
  const ev = {
    v: 1,
    id,
    at: new Date().toISOString(),
    mission_id: mid,
    worker: "w#1",
    kind: "milestone",
    summary: "seeded " + id,
    details: "",
    artifacts: [],
    files_touched: [],
    question: null,
    urgent: false,
  };
  fs.writeFileSync(
    path.join(dir, id + ".json"),
    text !== undefined ? text : JSON.stringify(ev, null, 2) + "\n",
  );
  return path.join(dir, id + ".json");
}

export {
  ck,
  BASE,
  T,
  resultText,
  unreadDirOf,
  jsonFiles,
  sleep,
  iso,
  HOURS,
  subRoot,
  rootVariants,
  seedEvent,
  startServer,
  DEFAULT_SERVER,
  PLUGIN_DIR,
  runNode,
  blankMission,
  writeBoardSeed,
  readBoard,
};
