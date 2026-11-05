// @module crv6-statemachine/ctx
/*!
 * suites/crv6-statemachine/ctx.mjs —— crv6-statemachine suite 共享上下文工厂
 *
 * Checker（suite 名与 SUITE 摘要行）、临时根 BASE/T、主 server 实例 s 及全部夹具助手
 * （resultText/boardJson/sleep/iso/HOURS/mkClaim/seedBoard/getMission/lastEvent/appendMissions）
 * 由薄入口 crv6-statemachine.mjs 调 createCtx() 构造一次，各断言模块 run(ctx) 消费。
 * mkClaim 闭包的 claimSeq 有态计数与拆前单文件语义一致（模块级单例）。
 * 拆分自原单文件 suites/crv6-statemachine.mjs 顶部初始化段，逐字搬运零行为变更。
 */
import fs from "node:fs";
import path from "node:path";
import { startServer, Checker } from "../../harness/jsonrpc-client.mjs";
import { makeTempRoot, parseRootArg, writeBoardSeed, readBoard } from "../../harness/temp-root.mjs";

export function createCtx() {
  const ck = new Checker("crv6-statemachine");
  const BASE = makeTempRoot({ prefix: "orch-crv6sm-", root: parseRootArg() || undefined });
  const T = BASE.root;
  const s = startServer({ root: T });
  const resultText = (r) => r.json ?? { _raw: r.text };
  const boardJson = () => JSON.parse(fs.readFileSync(path.join(T, "board.json"), "utf8"));
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  const HOURS = 60 * 60 * 1000;
  let claimSeq = 0;
  const mkClaim = (worker, leaseUntil, claimedAt) => ({
    worker,
    token: "seedtok" + ++claimSeq + "0000000000",
    claimedAt,
    leaseUntil,
  });
  const seedBoard = (missions) => writeBoardSeed(T, missions);
  const getMission = async (id) => resultText(await s.call("board", { action: "get", mission_id: id, view: "full" }));
  const lastEvent = (m) => (Array.isArray(m.timeline) ? m.timeline[m.timeline.length - 1] : null);
  /** 追加 mission 到现存板（直写 board.json——server 每次调用 fresh load）。 */
  const appendMissions = (missions) => {
    const board = readBoard(T);
    board.missions.push(...missions);
    fs.writeFileSync(path.join(T, "board.json"), JSON.stringify(board, null, 2) + "\n");
  };
  return { ck, s, T, BASE, resultText, boardJson, sleep, iso, HOURS, mkClaim, seedBoard, getMission, lastEvent, appendMissions };
}
