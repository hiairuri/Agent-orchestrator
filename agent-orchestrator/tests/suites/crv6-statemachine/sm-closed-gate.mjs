// @module crv6-statemachine/sm-closed-gate
/*!
 * suites/crv6-statemachine/sm-closed-gate.mjs —— V6-11 closed 双门族断言
 *
 *   SM-08（A1 壳保真，夹具适配 V6-20/V6-11）：closed mission 收改板类 report → 仅存档，
 *     响应机读键齐备（closed/closed_note/ok/spool 落档/board 字节不变）；非 closed 腿
 *     closed===false 键恒在且无 closed_note。
 *   SM-01（V6-11 门 A 采信侧）：无绿档凭证的 closed 上游不解锁下游、claim 依赖门拒绝；
 *     补 qa.pass 后同一板面解锁（marker 生效对照）。
 *   SM-02（V6-11 门 B 写入侧）：直写 closed 需 close_confirmed:true；drafted 禁直达
 *     （带 confirm 也拒）；拒绝时 board 零变更；applied_at marker 腿（sandbox_apply
 *     写入的凭证形态）同样解锁下游。
 *
 * 拆分自 suites/crv6-statemachine.mjs（初步切分批次），断言本体逐字搬运零行为变更。
 */
import fs from "node:fs";
import path from "node:path";
import { blankMission } from "../../harness/temp-root.mjs";

export async function run(ctx) {
  const { ck, s, T, resultText, boardJson, iso, getMission, appendMissions } = ctx;

  // ================================================================
  // SM-08（A1 壳保真，夹具适配 V6-20/V6-11：closed 走 dispatched+close_confirmed
  // 合法迁移；running 走 claim 合法可达）
  // ================================================================
  // ---- SM-08 closed leg：closed mission 收改板类 report → 仅存档，响应机读键齐备
  await s.call("board", { action: "upsert", mission: { id: "m-sm8a", title: "closed 板上使命" } });
  await s.call("board", { action: "upsert", mission: { id: "m-sm8a", status: "dispatched" } });
  await s.call("board", {
    action: "upsert",
    mission: { id: "m-sm8a", status: "closed", close_confirmed: true },
  });
  const before = boardJson().missions.find((m) => m.id === "m-sm8a");
  const r1 = resultText(
    await s.call("report", { mission_id: "m-sm8a", worker: "w#1", kind: "milestone", summary: "closed 后的存档上报" }),
  );
  ck.ok("SM-08a closed mission 响应 closed===true", r1.closed === true, r1.closed);
  ck.ok("SM-08b closed_note 非空", typeof r1.closed_note === "string" && r1.closed_note.length > 0, r1.closed_note);
  ck.ok("SM-08c ok 语义解耦保持 true", r1.ok === true, r1.ok);
  const unreadDir = path.join(T, "spool", "m-sm8a", "unread");
  ck.ok("SM-08d 事件已落 spool unread", fs.existsSync(unreadDir) && fs.readdirSync(unreadDir).some((f) => f.endsWith(".json")));
  const after = boardJson().missions.find((m) => m.id === "m-sm8a");
  ck.ok("SM-08e board 未改（任务板字节级不变）", JSON.stringify(before) === JSON.stringify(after));

  // ---- SM-08 non-closed leg：closed===false 键恒在（机读稳定），closed_note 缺席
  await s.call("board", { action: "upsert", mission: { id: "m-sm8b", title: "running 板上使命" } });
  const cl8 = resultText(await s.call("board", { action: "claim", mission_id: "m-sm8b", worker: "w-sm8" }));
  const r2 = resultText(
    await s.call("report", {
      mission_id: "m-sm8b",
      worker: "w-sm8",
      token: cl8.token,
      kind: "milestone",
      summary: "正常上报",
    }),
  );
  ck.ok(
    "SM-08f 非 closed report closed===false（键恒在）且无 closed_note",
    r2.closed === false && r2.closed_note === undefined,
    { closed: r2.closed, closed_note: r2.closed_note },
  );

  // ================================================================
  // SM-01（V6-11 门 A 采信侧）：无绿档凭证的 closed 上游不解锁下游、claim 依赖门拒绝；
  // 补 qa.pass 后同一板面解锁（marker 生效对照）
  // ================================================================
  {
    await s.call("board", { action: "upsert", mission: { id: "m-sm1u", title: "无凭证 closed 上游" } });
    await s.call("board", { action: "upsert", mission: { id: "m-sm1u", status: "dispatched" } });
    await s.call("board", {
      action: "upsert",
      mission: { id: "m-sm1u", status: "closed", close_confirmed: true },
    });
    await s.call("board", { action: "upsert", mission: { id: "m-sm1d", title: "下游依赖", blockedBy: ["m-sm1u"] } });
    const d1 = await getMission("m-sm1d");
    ck.ok("SM-01a closed 上游无 qa/applied_at → 下游不 unlock（仍 drafted）", d1.status === "drafted", d1.status);
    const c1 = await s.call("board", { action: "claim", mission_id: "m-sm1d", worker: "w-sm1" });
    ck.ok(
      "SM-01b claim 依赖门报 依赖未就绪 并点名上游",
      c1.isError === true && c1.text.includes("dependencies not ready") && c1.text.includes("m-sm1u"),
      c1.text.slice(0, 140),
    );
    // marker 对照：补 A3 qa 结构体的 pass 判据（isGreenClosed 第一腿）→ sweep 即解锁
    await s.call("board", { action: "upsert", mission: { id: "m-sm1u", qa: { verdict: "pass" } } });
    const d2 = await getMission("m-sm1d");
    ck.ok("SM-01c 补 qa.pass 后同一板面解锁（drafted → ready）", d2.status === "ready", d2.status);
  }

  // ================================================================
  // SM-02（V6-11 门 B 写入侧）：直写 closed 需 close_confirmed:true；
  // drafted 禁直达（带 confirm 也拒）；拒绝时 board 零变更；
  // applied_at marker 腿（sandbox_apply 写入的凭证形态）同样解锁下游
  // ================================================================
  {
    const x1 = await s.call("board", { action: "upsert", mission: { id: "m-sm2a", status: "closed" } });
    ck.ok(
      "SM-02a drafted 直达 closed（无 confirm）→ ToolError 含 禁止直达",
      x1.isError === true && x1.text.includes("forbidden directly"),
      x1.text.slice(0, 140),
    );
    const x2 = await s.call("board", {
      action: "upsert",
      mission: { id: "m-sm2a", status: "closed", close_confirmed: true },
    });
    ck.ok(
      "SM-02b 携 close_confirmed 但 drafted 直达仍拒（未派发即归档无意义）",
      x2.isError === true && x2.text.includes("forbidden directly"),
      x2.text.slice(0, 140),
    );
    await s.call("board", { action: "upsert", mission: { id: "m-sm2b", title: "待归档" } });
    await s.call("board", { action: "upsert", mission: { id: "m-sm2b", status: "dispatched" } });
    const x3 = await s.call("board", { action: "upsert", mission: { id: "m-sm2b", status: "closed" } });
    const b3 = await getMission("m-sm2b");
    ck.ok(
      "SM-02c dispatched→closed 缺 close_confirmed → ToolError 且 board 零变更",
      x3.isError === true && x3.text.includes("close_confirmed") && b3.status === "dispatched",
      { err: x3.text.slice(0, 120), status: b3.status },
    );
    const x4 = await s.call("board", {
      action: "upsert",
      mission: { id: "m-sm2b", status: "closed", close_confirmed: true },
    });
    ck.ok("SM-02d 携 close_confirmed:true → 归档成功", !x4.isError && x4.json?.status === "closed", x4.text?.slice(0, 120));
    // applied_at marker 腿：closed + pack.sandbox.applied_at（sandbox_apply 直改产物形态）→ 视作绿
    appendMissions([
      blankMission({
        id: "m-sm2g",
        title: "applied 凭证 closed 上游",
        status: "closed",
        pack: { sandbox: { isolation: "worktree", applied_at: iso(0), applied_commit: "f".repeat(40) } },
      }),
      blankMission({ id: "m-sm2h", title: "applied 凭证下游", blockedBy: ["m-sm2g"] }),
    ]);
    await s.call("board", { action: "upsert", mission: { id: "m-sm2z", title: "sweep 触发" } });
    const h1 = await getMission("m-sm2h");
    ck.ok("SM-02e applied_at marker 腿：closed+applied_at 视作绿 → 下游 unlock", h1.status === "ready", h1.status);
  }
}
