/*!
 * harness/fixture-board.mjs —— mission 姿态工厂：done-未签收 / blocked-未答 / running-在飞 /
 *   workflow / ready-无主 / done-带 qa / 0.4.x 旧板（无 v0.5 新键）等
 *
 * 覆盖断言组：A-v020-A 组（哨兵姿态）、A-v031-S/A-v041-V（哨兵 live 的板面姿态）、
 *   A-v040-D 组（依赖链/租约）、A-v050-CRV3/CRV4、CR-V16①（m-deed mission 寻址夹具）、
 *   CR-V26（0.4.x 旧板种子）。哨兵 live 用例（L2）取姿态后仍需 accelerate 参数表驱动。
 *
 * 运行方式：作为模块 import；亦可自检直跑：
 *   node tests/harness/fixture-board.mjs [--root <临时根>]
 *   （自检=种全姿态板→起 server→board list 回环，打印 PASS/FAIL，exit 0/1）
 *
 * 前置：node >= 20；同 temp-root。
 */
import fs from "node:fs";
import path from "node:path";
import { blankMission, boardSeed, writeBoardSeed } from "./temp-root.mjs";

export const postures = {
  /** done 且未签收（Stop/哨兵疑似面） */
  doneUnacked: (id, over = {}) => blankMission({ id, title: over.title ?? id + " done-unacked", status: "done", ...over }),
  /** done 且已 qa 过（sandbox_apply 门禁前置态） */
  doneWithQa: (id, over = {}) => blankMission({ id, title: over.title ?? id + " done-qa", status: "done", qa: { verdict: "pass", note: "auto" }, ...over }),
  /** blocked 且未答 */
  blockedUnanswered: (id, over = {}) => blankMission({
    id, title: over.title ?? id + " blocked", status: "blocked",
    blocked: { question: over.question ?? "等待答复", asked_at: new Date().toISOString(), answered: false, answer: null, answered_at: null }, ...over,
  }),
  /** running 在飞（可带 dispatch.agent_id/token） */
  runningInFlight: (id, over = {}) => blankMission({ id, title: over.title ?? id + " running", status: "running", dispatch: over.dispatch ?? { agent_id: "agent_" + id }, ...over }),
  /** workflow 模式（agent_id 空） */
  workflowDone: (id, over = {}) => blankMission({ id, title: over.title ?? id + " wf", status: "done", dispatch: { mode: "workflow", run_id: over.run_id ?? "wf-1" }, ...over }),
  /** ready 无主（哨兵 D8 口径：不告警） */
  readyUnclaimed: (id, over = {}) => blankMission({ id, title: over.title ?? id + " ready", status: "ready", ...over }),
  /** 0.4.x 旧板 done（无 v0.5 新键——blankMission 本身即无新键，显式命名便于阅读） */
  legacy04xDone: (id, over = {}) => blankMission({ id, title: over.title ?? id + " legacy done", status: "done", artifacts: over.artifacts ?? ["a.txt"], ...over }),
  /** 0.4.x 旧板 dispatched 在飞 */
  legacy04xDispatched: (id, over = {}) => blankMission({ id, title: over.title ?? id + " legacy live", status: "dispatched", ...over }),
};

/** 按姿态名单种板：seedPostures(root, ["doneUnacked:m1", "runningInFlight:m2", ...], overMap?) */
export function seedPostures(root, entries, overMap = {}) {
  const missions = entries.map((e) => {
    const [name, id] = e.split(":");
    if (!postures[name]) throw new Error("unknown posture: " + name);
    return postures[name](id, overMap[e] ?? overMap[id] ?? {});
  });
  return writeBoardSeed(root, missions);
}

/** 与 jsonrpc-client 串接：种板后起 server（convenience） */
export async function bootWithPostures({ entries, overMap, startServer, root, env }) {
  seedPostures(root, entries, overMap);
  return startServer({ root, env });
}

// ---- 自检直跑：node tests/harness/fixture-board.mjs [--root <临时根>] ----
if (process.argv[1] && (await import("node:url")).pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { makeTempRoot, readBoard } = await import("./temp-root.mjs");
  const { startServer, Checker } = await import("./jsonrpc-client.mjs");
  const t = makeTempRoot({ prefix: "orch-fixture-selfcheck-" });
  const ck = new Checker("fixture-board.selfcheck");
  seedPostures(t.root, ["doneUnacked:m1", "blockedUnanswered:m2", "runningInFlight:m3", "workflowDone:m4", "readyUnclaimed:m5", "doneWithQa:m6", "legacy04xDone:m7", "legacy04xDispatched:m8"]);
  const b = readBoard(t.root);
  ck.ok("8 postures seeded, no v0.5 keys", b.missions.length === 8 && b.missions.every((m) => !("scope_paths" in m || "t1_head" in m)));
  const s = startServer({ root: t.root });
  const ls = await s.call("board", { action: "list" });
  ck.ok("board list roundtrip over postures", !ls.isError && Array.isArray(ls.json?.missions) && ls.json.missions.length === 8, ls.text.slice(0, 120));
  ck.ok("sentinel_health present on list", ls.json && ("sentinel_health" in ls.json), Object.keys(ls.json || {}));
  s.close(); t.cleanup();
  ck.summary();
  process.exit(ck.fails.length ? 1 : 0);
}
