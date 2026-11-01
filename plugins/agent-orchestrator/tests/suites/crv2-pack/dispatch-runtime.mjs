// @module crv2-pack/dispatch-runtime
// suites/crv2-pack 拆分件：W4-DISPATCH-07/08（yolo 闸/busy 闸/在板校验，server 黑盒）+
// W4-DISPATCH-09 端到端（context_pack persona_path → dispatch → stub CLI → result/index
// → board 登记）。原 L871-1035 搬入。
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
    await cur.call("board", {
      action: "upsert",
      mission: {
        id: "mDispBusy",
        title: "busy-headless",
        status: "dispatched",
        agent_type: "agent-orchestrator:orch-scout",
        dispatch: { mode: "headless" },
      },
    });
    const bGate = await cur.call("dispatch", { mission_id: "mDispBusy" });
    ck.ok(
      "W4-DISPATCH-08 busy 闸：dispatch.mode=headless 且结果 index 缺席 → isError 拒双跑",
      bGate.isError === true && /busy 闸/.test(bGate.text) && /index/.test(bGate.text),
      bGate.text.slice(0, 200),
    );
    const noMission = await cur.call("dispatch", { mission_id: "mDispNope" });
    ck.ok(
      "W4-DISPATCH-08b 在板校验：mission 不存在 → isError（派发面前置）",
      noMission.isError === true && /不在板/.test(noMission.text),
      noMission.text.slice(0, 160),
    );
  }
  // ---- W4-DISPATCH-09：端到端（context_pack persona_path → dispatch → stub CLI → result/index） ----
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
      "W4-DISPATCH-09a context_pack persona_path 登记 mission.pack.persona（dispatch persona 解析第 2 级）",
      Boolean(dm && dm.pack && typeof dm.pack.persona === "string" && dm.pack.persona.includes("orch-worker.md")),
      dm && dm.pack,
    );
    const ctxDir = path.join(TROOT, "context");
    fs.mkdirSync(ctxDir, { recursive: true });
    const logBlock = (seq, next) =>
      [
        "<!-- orch-tail v2",
        "ts: 2026-10-25T05:00:00.000Z",
        `seq: ${seq}`,
        "project: v1.1.1 机制波",
        "stage: W20",
        "flying: m-a",
        "ruled: 日志唯一源",
        `next: ${next}`,
        "<!-- orch-tail-end -->",
      ].join("\n");
    fs.writeFileSync(
      path.join(ctxDir, "coord-tail-log.md"),
      logBlock(1, "trace-旧") + "\n\n" + logBlock(2, "trace-新") + "\n",
    );
    const dr = await cur.call("dispatch", { mission_id: "mDispOk" });
    const dj = dr.json || {};
    ck.ok(
      "W4-DISPATCH-09b 秒级回执 {ok,mission_id,worker,session_id,log_path,prompt_path,result_dir}（rollout diff ≤5s 快捕 sessionId）",
      dr.isError !== true &&
        dj.ok === true &&
        dj.mission_id === "mDispOk" &&
        dj.worker === "orch-worker#1" &&
        dj.session_id === "sess_crv2-dispatch" &&
        typeof dj.log_path === "string" &&
        typeof dj.prompt_path === "string" &&
        typeof dj.result_dir === "string",
      dj,
    );
    const promptFile = dj.prompt_path
      ? path.isAbsolute(dj.prompt_path)
        ? dj.prompt_path
        : path.join(PROJ, dj.prompt_path)
      : "";
    const ptxt = promptFile && fs.existsSync(promptFile) ? fs.readFileSync(promptFile, "utf8") : "";
    const pTrace = ptxt.slice(0, ptxt.indexOf("# orch-worker"));
    ck.ok(
      "W4-DISPATCH-09c 审计 prompt 落盘（v1.1.2 四段式）：纪律段置顶 → 轨迹节（v2 块去协议行、旧→新）→ persona 正文 → 指针句+CONTRACT（digest 缺省整节省略）",
      ptxt.startsWith("【纪律（") &&
        ptxt.indexOf("【纪律（") < ptxt.indexOf("【主控尾块轨迹（启动器自动注入") &&
        pTrace.includes("next: trace-旧") &&
        pTrace.indexOf("next: trace-旧") < pTrace.indexOf("next: trace-新") &&
        !/^(ts|seq): /m.test(pTrace) &&
        !ptxt.includes("【项目 digest") &&
        ptxt.includes("先 Read 任务包 ") &&
        /\[channel\] mDispOk\n\[worker\] orch-worker#1\n\[token\] [0-9a-f]{32}$/.test(ptxt),
      { head: ptxt.slice(0, 80) },
    );
    const resultDir = path.join(TROOT, "context", "dispatch-results");
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (
        fs.existsSync(path.join(resultDir, "sess_crv2-dispatch.json")) &&
        fs.existsSync(resultDir) &&
        fs.readdirSync(resultDir).some((n) => n.startsWith("mDispOk-") && n.endsWith(".index.json"))
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    const resultFile = path.join(resultDir, "sess_crv2-dispatch.json");
    const resultJson = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, "utf8")) : null;
    const indexName = fs.existsSync(resultDir)
      ? fs.readdirSync(resultDir).find((n) => n.startsWith("mDispOk-") && n.endsWith(".index.json"))
      : null;
    const indexJson = indexName ? JSON.parse(fs.readFileSync(path.join(resultDir, indexName), "utf8")) : null;
    ck.ok(
      "W4-DISPATCH-09d runner 异步落盘：<sessionId>.json（envelope+mission/worker/exit）+ 侧车 index（mission→result）",
      Boolean(resultJson) &&
        resultJson.mission_id === "mDispOk" &&
        resultJson.worker === "orch-worker#1" &&
        resultJson.session_id === "sess_crv2-dispatch" &&
        resultJson.exit_code === 0 &&
        resultJson.timed_out === false &&
        resultJson.envelope &&
        resultJson.envelope.sessionId === "sess_crv2-dispatch" &&
        Boolean(indexJson) &&
        indexJson.mission_id === "mDispOk" &&
        indexJson.session_id === "sess_crv2-dispatch" &&
        String(indexJson.result_path || "").includes("sess_crv2-dispatch.json"),
      { resultJson, indexJson },
    );
    const board1 = JSON.parse(fs.readFileSync(path.join(TROOT, "board.json"), "utf8"));
    const dm1 = board1.missions.find((m) => m.id === "mDispOk");
    ck.ok(
      "W4-DISPATCH-09e board 登记：status dispatched ∧ dispatch.mode=headless ∧ session_id 快捕回填",
      dm1 &&
        dm1.status === "dispatched" &&
        dm1.dispatch &&
        dm1.dispatch.mode === "headless" &&
        dm1.dispatch.session_id === "sess_crv2-dispatch",
      dm1 && { status: dm1.status, dispatch: dm1.dispatch },
    );
  }
  // v1.1.1 W21：SKILL PL-10/DP-3 的静态锁归 po-static（W21 车道）；本套只保留
  // 启动器/回退形态的行为面（W4-DISPATCH 族 + W4-PREFIX 重写），零文档措辞重复钉。
}
