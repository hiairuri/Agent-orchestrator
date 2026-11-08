// @module suites/watcher-core/fixtures
/*!
 * watcher-core/fixtures.mjs —— e2e 工具夹具：板/coord 指针/mission 工厂/全 mock watcher/
 * signals 读取/mkC11 工厂。拆分自 suites/watcher-core.mjs；夹具体零改动
 * （mkC11 由 try 内闭包 BASE 改为参数化工厂 createMkC11，入口在 BASE 创建后调用）。
 */
import fs from "node:fs";
import path from "node:path";
import { createWatcher } from "../../../watcher/watcher.mjs";

/* ================= e2e 工具 ================= */

export function writeBoard(root, missions) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "board.json"), JSON.stringify({ version: 2, updated_at: new Date().toISOString(), missions }) + "\n");
}
export function writeCoord(root, sid = "sess-coord-test", workspaceKey = "ws-1") {
  fs.mkdirSync(path.join(root, "sentinel"), { recursive: true });
  fs.writeFileSync(path.join(root, "sentinel", "coord-session.txt"), sid + "\n");
  // G5：生产 watcher 无锚 fail-loud，mock 全链默认预置与 MockRelay 缺省工作区一致的锚；
  // 已有锚不覆盖（W-WSA-02 漂移场景的锚先于 buildWatcher 写入）；workspaceKey=null → 不写
  // （W-WSA-01 无锚 fail-loud 场景）。
  const anchorPath = path.join(root, "sentinel", "coord-workspace.txt");
  if (workspaceKey && !fs.existsSync(anchorPath)) fs.writeFileSync(anchorPath, workspaceKey + "\n");
}
export const mission = (id, status, atMs, extra = {}) => ({
  id,
  title: "t-" + id,
  status,
  dispatch: { agent_id: "agent-" + id, mode: "agent" },
  updated_at: new Date(atMs).toISOString(),
  ...extra,
});

/** 造一个全 mock watcher：假时钟（可推进）、即时 sleep（推进假时钟）、mock relay、mock fetch（零真实触达）。 */
export function buildWatcher({ root, relay, now, board = null, coord = true, revived = true, extraArgv = [], workspaceAnchor = "ws-1" }) {
  if (board) writeBoard(root, board);
  if (coord) writeCoord(root, "sess-coord-test", workspaceAnchor);
  const clock = { t: now() };
  const mockFetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ code: 0, msg: "", data: { token: "A".repeat(21) + "g", expires_in: 60 } }),
  });
  return createWatcher({
    rootDir: root,
    argv: ["--poll-sec", "1", "--min-interval-sec", "0", "--hold-max-sec", "1", "--verdict-window-sec", "60", ...extraArgv],
    now: () => clock.t,
    sleepFn: async (ms) => { clock.t += ms; }, // sleep 即推进假时钟（③观测窗零等待）
    fetchImpl: mockFetch, // 签发面 mock：绝不触真实端点
    transportFactory: relay ? relay.transportFactory : undefined,
    jwtLoader: () => ({ ok: true, jwt: "mock.header.payload" }),
    deviceLoader: async () => ({ ok: true, deviceSid: "sid-mock", deviceMid: "mid-mock" }),
    revivedProbe: () => revived,
  });
}

export const signalsPath = (root) => path.join(root, "sentinel", "watcher-signals.jsonl");
export const readSignals = (root) => {
  try { return fs.readFileSync(signalsPath(root), "utf8").split("\n").filter((x) => x.trim()).map((l) => JSON.parse(l)); } catch { return []; }
};

/** coord 指针根件（C11/G4/G5 守卫共用）：coord-session.txt 预置 + 计数写面 fsImpl。 */
export const createMkC11 = (BASE) => (name, opts) => {
  const root = path.join(BASE.root, name);
  fs.mkdirSync(path.join(root, "sentinel"), { recursive: true });
  const coordPath = path.join(root, "sentinel", "coord-session.txt");
  fs.writeFileSync(coordPath, opts.coord + "\n");
  let writes = 0;
  const fsImpl = {
    readFileSync: (p, e) => fs.readFileSync(p, e),
    writeFileSync: (p, d) => { if (String(p) === coordPath || String(p).indexOf(coordPath + ".tmp-") === 0) writes++; fs.writeFileSync(p, d); },
    mkdirSync: (p, o) => fs.mkdirSync(p, o),
    renameSync: (a, b) => fs.renameSync(a, b),
  };
  return { root, coordPath, fsImpl, writesRef: () => writes };
};
