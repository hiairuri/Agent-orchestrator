// @module crv6-statemachine/sm-recycle
/*!
 * suites/crv6-statemachine/sm-recycle.mjs —— V6-21 回收扩容族断言
 *
 *   SM-06（V6-21 回收扩容）：有 claim 且租约过期即回收（终态豁免）——
 *     running/dispatched → ready；blocked/question 保状态；owner/claim 清空 +
 *     lease_expired 事件；终态（done/closed）残留过期 claim 不被回收。
 *   SM-07（V6-21 answer 联动）：回收后的 question 得 answer → status=ready、
 *     owner=null，池工可立即 claim（E4/E5 回归）；owner 在场时 answer 仍翻
 *     dispatched（现行为保真）。
 *
 * 拆分自 suites/crv6-statemachine.mjs（初步切分批次），断言本体逐字搬运零行为变更。
 */
import { blankMission } from "../../harness/temp-root.mjs";

export async function run(ctx) {
  const { ck, s, seedBoard, mkClaim, iso, HOURS, getMission, lastEvent, resultText } = ctx;

  // ================================================================
  // SM-06（V6-21 回收扩容）：有 claim 且租约过期即回收（终态豁免）——
  // running/dispatched → ready；blocked/question 保状态；owner/claim 清空 +
  // lease_expired 事件；终态（done/closed）残留过期 claim 不被回收
  // ================================================================
  {
    seedBoard([
      blankMission({ id: "m-sm6r", status: "running", owner: "w6r", claim: mkClaim("w6r", iso(-1 * HOURS), iso(-2 * HOURS)) }),
      blankMission({ id: "m-sm6d", status: "dispatched", owner: "w6d", claim: mkClaim("w6d", iso(-1 * HOURS), iso(-2 * HOURS)) }),
      blankMission({ id: "m-sm6b", status: "blocked", owner: "w6b", claim: mkClaim("w6b", iso(-1 * HOURS), iso(-2 * HOURS)) }),
      blankMission({ id: "m-sm6q", status: "question", owner: "w6q", claim: mkClaim("w6q", iso(-1 * HOURS), iso(-2 * HOURS)) }),
      blankMission({ id: "m-sm6t1", status: "done", owner: "w6t", claim: mkClaim("w6t", iso(-1 * HOURS), iso(-2 * HOURS)) }),
      blankMission({ id: "m-sm6t2", status: "closed", owner: "w6c", claim: mkClaim("w6c", iso(-1 * HOURS), iso(-2 * HOURS)) }),
    ]);
    await s.call("board", { action: "upsert", mission: { id: "m-sm6z", title: "sweep 触发器" } });
    const recycle = async (id, wantStatus, tag) => {
      const m = await getMission(id);
      ck.ok(`SM-06 ${tag} owner/claim 清空`, m.owner === null && m.claim === null, { owner: m.owner, claim: m.claim });
      ck.ok(`SM-06 ${tag} 状态=${wantStatus}`, m.status === wantStatus, m.status);
      ck.ok(`SM-06 ${tag} timeline 末事件 lease_expired`, lastEvent(m)?.event === "lease_expired", lastEvent(m)?.event);
    };
    await recycle("m-sm6r", "ready", "running 腿回 ready");
    await recycle("m-sm6d", "ready", "dispatched 腿回 ready");
    await recycle("m-sm6b", "blocked", "blocked 腿保状态");
    await recycle("m-sm6q", "question", "question 腿保状态");
    const t1 = await getMission("m-sm6t1");
    const t2 = await getMission("m-sm6t2");
    ck.ok(
      "SM-06 终态豁免：done/closed 残留过期 claim 不被回收（owner/claim 原样、无新事件）",
      t1.owner === "w6t" && t1.claim !== null && lastEvent(t1)?.event !== "lease_expired" &&
        t2.owner === "w6c" && t2.claim !== null && lastEvent(t2)?.event !== "lease_expired",
      { done: { owner: t1.owner, last: lastEvent(t1)?.event }, closed: { owner: t2.owner, last: lastEvent(t2)?.event } },
    );
  }

  // ================================================================
  // SM-07（V6-21 answer 联动）：回收后的 question 得 answer → status=ready、
  // owner=null，池工可立即 claim（E4/E5 回归）；owner 在场时 answer 仍翻
  // dispatched（现行为保真）
  // ================================================================
  {
    seedBoard([
      blankMission({
        id: "m-sm7q",
        title: "回收后待答",
        status: "question",
        blocked: { question: "卡住了", asked_at: iso(-2 * HOURS), answered: false, answer: null, answered_at: null },
      }),
      blankMission({
        id: "m-sm7o",
        title: "在场待答",
        status: "blocked",
        owner: "w-live",
        blocked: { question: "需要裁决", asked_at: iso(-2 * HOURS), answered: false, answer: null, answered_at: null },
      }),
    ]);
    const a1 = resultText(await s.call("mailbox", { action: "answer", mission_id: "m-sm7q", answer: "按方案 b 继续" }));
    const q1 = await getMission("m-sm7q");
    ck.ok(
      "SM-07a 无主 question 得 answer → status=ready 且 owner=null",
      a1.status === "ready" && q1.status === "ready" && q1.owner === null,
      { resp: a1.status, board: q1.status, owner: q1.owner },
    );
    const c7 = resultText(await s.call("board", { action: "claim", mission_id: "m-sm7q", worker: "pool#7" }));
    const q2 = await getMission("m-sm7q");
    ck.ok(
      "SM-07b 池工可立即 claim（E4/E5 双卡点消解）",
      c7.isError !== true && c7.ok === true && q2.status === "running" && q2.owner === "pool#7",
      { claim: c7.ok, status: q2.status, owner: q2.owner },
    );
    const a2 = resultText(await s.call("mailbox", { action: "answer", mission_id: "m-sm7o", answer: "在场景继续" }));
    const o1 = await getMission("m-sm7o");
    ck.ok(
      "SM-07c owner 在场时 answer 仍翻 dispatched（现行为保真）",
      a2.status === "dispatched" && o1.status === "dispatched" && o1.owner === "w-live",
      { resp: a2.status, board: o1.status, owner: o1.owner },
    );
  }
}
