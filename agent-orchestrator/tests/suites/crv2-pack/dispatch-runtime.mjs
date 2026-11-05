// @module crv2-pack/dispatch-runtime
// suites/crv2-pack 拆分件：W4-DISPATCH-07/08（yolo 闸/busy 闸，server 黑盒；v1.6 W-p 起
// 08=mode enum 收窄负向腿）+ W4-DISPATCH-09a（board pack.persona 登记独立面；09b-e 随
// -p parked 退役——runner/快捕/headless 登记面迁 parked/agent-orchestrator/）。
// 原 L871-1035 搬入。v1.6 W-p 见各腿注记与 v1.6.0.md §W-p 台账。
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_DIR } from "../../harness/jsonrpc-client.mjs";
import { ck, PROJ, TROOT } from "./setup.mjs";

export async function runDispatchRuntime(cur) {
  // ---- W4-DISPATCH-07/08：yolo 闸 / busy 闸（server 黑盒，闸门拒绝先于任何 spawn） ----
  {
    await cur.call("board", {
      action: "upsert",
      mission: { id: "mDispW", title: "yolo-worker", status: "drafted", agent_type: "agent-orchestrator:orch-worker" },
    });
    const wGate = await cur.call("dispatch", { mission_id: "mDispW" });
    ck.ok(
      "W4-DISPATCH-07a yolo 闸：worker 类 scope_paths 空 → isError（headless=--mode yolo 全放行，引导登记写集）",
      wGate.isError === true && /yolo 闸/.test(wGate.text) && /scope_paths/.test(wGate.text),
      wGate.text.slice(0, 200),
    );
    await cur.call("board", {
      action: "upsert",
      mission: { id: "mDispS", title: "scout-exempt", status: "drafted", agent_type: "agent-orchestrator:orch-scout" },
    });
    const sGate = await cur.call("dispatch", { mission_id: "mDispS" });
    ck.ok(
      "W4-DISPATCH-07b scout 豁免 yolo 闸：越过闸门后按包解析失败（错误非 yolo，闸门语义正向可证）",
      sGate.isError === true && !/yolo 闸/.test(sGate.text) && /任务包/.test(sGate.text),
      sGate.text.slice(0, 200),
    );
    // v1.6 W-p 改写（预判外显形）：headless busy 闸随 -p 迁 parked 后，原「mode=headless
    // 板记录+无 index → 拒双跑」驱动腿失 subject——改写为 enum 收窄负向腿（显式传
    // mode:"headless" → isError mode 非法，行为面恰证 schema/handler 双面收窄）。
    await cur.call("board", {
      action: "upsert",
      mission: {
        id: "mDispBusy",
        title: "busy-headless-parked",
        status: "dispatched",
        agent_type: "agent-orchestrator:orch-scout",
        dispatch: { mode: "headless" }, // 板记录走 board enum 保留面（历史 mission）
      },
    });
    const bGate = await cur.call("dispatch", { mission_id: "mDispBusy", mode: "headless" });
    ck.ok(
      "W4-DISPATCH-08 mode enum 收窄负向腿（v1.6 W-p）：显式 mode:\"headless\" → isError mode 非法" +
        "（enum: nested——headless 通道 parked at v1.6 W-p；板记录保留面不涉派发）",
      bGate.isError === true && /mode 非法/.test(bGate.text) && /parked/.test(bGate.text),
      bGate.text.slice(0, 200),
    );
    const noMission = await cur.call("dispatch", { mission_id: "mDispNope" });
    ck.ok(
      "W4-DISPATCH-08b 在板校验：mission 不存在 → isError（派发面前置）",
      noMission.isError === true && /不在板/.test(noMission.text),
      noMission.text.slice(0, 160),
    );
  }
  // ---- W4-DISPATCH-09：端到端（v1.6 W-p 大裁后形态）——09a 保留（board pack.persona
  //      登记独立面）；09b/09d/09e 迁 parked（headless 快捕/runner 落盘/board mode=headless
  //      登记——subject 随 -p 通道迁 parked/agent-orchestrator/）；09c 退役（headless 四段式
  //      审计面；nested 组装面由 scenarios-v120-nested NST 系承载）。台账 v1.6.0.md §W-p。
  {
    await cur.call("context_pack", {
      mission_id: "mDispOk",
      title: "dispatch 端到端",
      task: "验证回执与 result 侧车",
      scope_paths: ["src/"],
      worker_name: "orch-worker#1",
      persona_path: path.join(PLUGIN_DIR, "agents", "orch-worker.md"),
    });
    await cur.call("board", {
      action: "upsert",
      mission: { id: "mDispOk", title: "dispatch 端到端", status: "drafted", agent_type: "agent-orchestrator:orch-worker" },
    });
    const board0 = JSON.parse(fs.readFileSync(path.join(TROOT, "board.json"), "utf8"));
    const dm = board0.missions.find((m) => m.id === "mDispOk");
    ck.ok(
      "W4-DISPATCH-09a context_pack persona_path 登记 mission.pack.persona（dispatch persona 解析第 2 级；v1.6 W-p 起独立成腿）",
      Boolean(dm && dm.pack && typeof dm.pack.persona === "string" && dm.pack.persona.includes("orch-worker.md")),
      dm && dm.pack,
    );
  }
  // v1.1.1 W21：SKILL PL-10/DP-3 的静态锁归 po-static（W21 车道）；本套只保留
  // 启动器/回退形态的行为面（W4-DISPATCH 族 + W4-PREFIX 重写），零文档措辞重复钉。
}
