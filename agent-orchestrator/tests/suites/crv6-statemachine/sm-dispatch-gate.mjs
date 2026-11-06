// @module crv6-statemachine/sm-dispatch-gate
/*!
 * suites/crv6-statemachine/sm-dispatch-gate.mjs —— v1.3 WG G-a：dispatch 状态闸收 ready（O13-a）
 *
 *   GA-1（前向 DAG 解锁→ready→dispatch 直派成功＋下游 blockedBy 消解）：下游 drafted 携
 *     前向 blockedBy，上游 report(done) → sweepGraph unlock → ready（timeline unlock 事件
 *     =blockedBy 全绿消解），随后 dispatch(mode=nested) 直派成功（状态闸认 ready）。
 *   GA-2（drafted/dispatched 回归臂）：drafted 派发照常（板上记账 drafted→dispatched）；
 *     seeded dispatched（无 dispatch.mode）照常过状态闸组装成功。
 *   GA-3（其余状态仍拒臂）：running/done/blocked/question 四态 dispatch → ToolError
 *     「不可派发」且文案=新接受集 drafted/dispatched/ready（负臂钉放宽边界）。
 *
 * 权威=designs/agent-orchestrator-v1.3-planning/qa/waves-finding.md §WG（impl-plan §2 WG
 * 施工步 G-a 逐字）；转换表与 claim 面**零改**由 SM-03 迁移矩阵与 claim 既有臂承载。
 * 派发形态取 mode=nested 组装出口（无进程无播种，M5-1 主形态——断言只闸状态面）。
 */
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_DIR } from "../../harness/jsonrpc-client.mjs";
import { blankMission } from "../../harness/temp-root.mjs";

export async function run(ctx) {
  const { ck, s, T, seedBoard, getMission, resultText } = ctx;

  const gaPack = path.join(T, "ga-pack.md");
  fs.writeFileSync(
    gaPack,
    "# 任务包：G-a 闸收 ready\n\n## CONTRACT（三行契约）\n\n[channel] m-ga-x\n[worker] gp-ga#1\n[token] ga token placeholder\n\n## TASK\n状态闸黑盒探针。\n",
  );
  const gaPersona = path.join(PLUGIN_DIR, "agents", "orch-worker.md");
  const dispatchNested = (id) =>
    s.call("dispatch", { mission_id: id, mode: "nested", pack_path: gaPack, persona_path: gaPersona });

  // ================================================================
  // GA-1：前向 DAG 解锁 → ready → dispatch 直派成功＋下游 blockedBy 消解
  // ================================================================
  {
    seedBoard([
      {
        ...blankMission({ id: "m-ga-dn", title: "下游待解锁", status: "drafted", blockedBy: ["m-ga-up"] }),
        agent_type: "agent-orchestrator:orch-worker",
        scope_paths: ["src/"],
      },
    ]);
    // 前向引用：上游缺席建板（跨一次写事务落地），随即 report(done) 触发 sweepGraph
    await s.call("board", { action: "upsert", mission: { id: "m-ga-up", title: "上游", status: "drafted" } });
    const doneUp = resultText(
      await s.call("report", { mission_id: "m-ga-up", worker: "w#ga", kind: "done", summary: "上游完成" }),
    );
    const dn = await getMission("m-ga-dn");
    ck.ok(
      "GA-1a 上游 done → sweepGraph unlock：下游 drafted→ready 且 timeline 记 unlock（blockedBy 全绿消解）",
      doneUp.ok === true && dn.status === "ready" && (dn.timeline || []).some((e) => e.event === "unlock"),
      { ok: doneUp.ok, status: dn.status, tl: JSON.stringify((dn.timeline || []).slice(-1)) },
    );
    const disp = resultText(await dispatchNested("m-ga-dn"));
    ck.ok(
      "GA-1b ready mission dispatch(mode=nested) 直派成功（状态闸认 ready；旧闸此处抛不可派发）＋编号回执负向四缺席" +
        "（v1.6 W3c O-3 修补档·裁定 A：旧 promptLen>0 回执腿照 NST-01a 编号化新形改写——prompt/prompt_path/chars/persona " +
        "均 undefined；W3a 组装退役后回执=编号八字段无 prompt 全文，四缺席任一复现即红防回潮）",
      disp.ok === true && disp.mode === "nested" &&
        disp.prompt === undefined && disp.prompt_path === undefined &&
        disp.chars === undefined && disp.persona === undefined,
      { ok: disp.ok, mode: disp.mode, keys: Object.keys(disp), err: disp._raw },
    );
  }

  // ================================================================
  // GA-2：drafted/dispatched 回归臂（既有接受集零回归）
  // ================================================================
  {
    seedBoard([
      {
        ...blankMission({ id: "m-ga-reg", title: "drafted 回归", status: "drafted" }),
        agent_type: "agent-orchestrator:orch-worker",
        scope_paths: ["src/"],
      },
      {
        ...blankMission({ id: "m-ga-d2", title: "dispatched 回归", status: "dispatched" }),
        agent_type: "agent-orchestrator:orch-worker",
        scope_paths: ["src/"],
      },
    ]);
    const r1 = resultText(await dispatchNested("m-ga-reg"));
    const reg = await getMission("m-ga-reg");
    ck.ok(
      "GA-2a drafted 回归臂：dispatch 照常 ok 且板上记账 drafted→dispatched",
      r1.ok === true && reg.status === "dispatched",
      { ok: r1.ok, status: reg.status },
    );
    const r2 = resultText(await dispatchNested("m-ga-d2"));
    ck.ok(
      "GA-2b dispatched 回归臂：seeded dispatched（无 dispatch.mode）照常过状态闸组装成功",
      r2.ok === true && r2.mode === "nested",
      { ok: r2.ok, err: r2._raw },
    );
  }

  // ================================================================
  // GA-3：其余状态仍拒臂（负臂钉放宽边界：非 ready/drafted/dispatched 仍拒）
  // ================================================================
  {
    seedBoard([
      blankMission({ id: "m-ga-ng1", title: "running 拒", status: "running" }),
      blankMission({ id: "m-ga-ng2", title: "done 拒", status: "done" }),
      blankMission({ id: "m-ga-ng3", title: "blocked 拒", status: "blocked" }),
      blankMission({ id: "m-ga-ng4", title: "question 拒", status: "question" }),
    ]);
    const NEG = [
      ["m-ga-ng1", "running"],
      ["m-ga-ng2", "done"],
      ["m-ga-ng3", "blocked"],
      ["m-ga-ng4", "question"],
    ];
    const hits = {};
    let all = true;
    for (const [id, st] of NEG) {
      const r = await dispatchNested(id);
      hits[st] = r.isError === true && r.text.includes("not dispatchable") && r.text.includes("drafted/dispatched/ready");
      all = all && hits[st];
    }
    ck.ok(
      "GA-3 running/done/blocked/question 四态 dispatch → ToolError 不可派发（文案=新接受集 drafted/dispatched/ready）",
      all,
      hits,
    );
  }
}
