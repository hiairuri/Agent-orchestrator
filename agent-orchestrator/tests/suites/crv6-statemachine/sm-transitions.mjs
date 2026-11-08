// @module crv6-statemachine/sm-transitions
/*!
 * suites/crv6-statemachine/sm-transitions.mjs —— V6-20 迁移矩阵族断言
 *
 *   SM-03（V6-20 白名单矩阵）：表内迁移逐对全通；→running 仅 claim 可达（F3c 封堵）；
 *     表外四连（closed→running / done→drafted / failed→running / skipped→ready）
 *     无 reopen 时一律 ToolError 且 board 零变更。
 *   SM-04（V6-20 显式 reopen）：终态复活腿需 reopen:true+note 且 timeline 记
 *     reopen 事件；缺 note → ToolError；closed 携 reopen → 仍拒。
 *   SM-05（V6-20 跨迁移清 ack）：任何跨状态迁移 ack 不残留（close 自动签收
 *     不跨迁移带到复活后状态）；外部 close 的 auto-ack（by=close）仍落地。
 *
 * 拆分自 suites/crv6-statemachine.mjs（初步切分批次），断言本体逐字搬运零行为变更。
 */
import { blankMission } from "../../harness/temp-root.mjs";

export async function run(ctx) {
  const { ck, s, seedBoard, iso, HOURS, getMission } = ctx;

  // ================================================================
  // SM-03（V6-20 白名单矩阵）：表内迁移逐对全通；表外四连（closed→running /
  // done→drafted / failed→running / skipped→ready）无 reopen 时一律 ToolError
  // 且 board 零变更
  // ================================================================
  const MATRIX = [
    ["drafted", "dispatched"],
    ["drafted", "skipped"],
    ["dispatched", "drafted"],
    ["dispatched", "ready"],
    ["dispatched", "closed"],
    ["ready", "dispatched"],
    ["ready", "skipped"],
    ["ready", "closed"],
    ["running", "done"],
    ["running", "blocked"],
    ["running", "question"],
    ["running", "failed"],
    ["running", "dispatched"],
    ["blocked", "dispatched"],
    ["blocked", "ready"],
    ["blocked", "closed"],
    ["question", "dispatched"],
    ["question", "ready"],
    ["question", "closed"],
    ["done", "closed"],
    ["failed", "closed"],
    ["failed", "drafted", "reopen"],
    ["skipped", "closed"],
    ["skipped", "drafted", "reopen"],
    ["resumed", "dispatched"],
  ];
  {
    seedBoard(MATRIX.map(([from], i) => blankMission({ id: `m-mx${i}`, title: `矩阵 ${from}`, status: from })));
    for (let i = 0; i < MATRIX.length; i++) {
      const [from, to, reopen] = MATRIX[i];
      const patch = { id: `m-mx${i}`, status: to };
      if (to === "closed") patch.close_confirmed = true; // V6-11 门 B：外部归档一次性确认
      if (reopen) {
        patch.reopen = true;
        patch.note = "矩阵重开原因";
      }
      const r = await s.call("board", { action: "upsert", mission: patch });
      const m = await getMission(`m-mx${i}`);
      ck.ok(
        `SM-03a 表内迁移 ${from}→${to}${reopen ? "（reopen）" : ""} 全通`,
        !r.isError && m.status === to,
        { err: r.text?.slice(0, 100), status: m.status },
      );
    }
    // →running 仅 claim 可达：任意外部直写 running 一律拒绝（F3c 封堵）
    const nr = await s.call("board", { action: "upsert", mission: { id: "m-mx0", status: "running" } });
    ck.ok(
      "SM-03b upsert 直写 running → ToolError（→running 仅 claim 可达）",
      nr.isError === true && nr.text.includes("running"),
      nr.text.slice(0, 140),
    );
  }
  {
    seedBoard([
      blankMission({ id: "m-ng1", title: "负例 closed", status: "closed" }),
      blankMission({ id: "m-ng2", title: "负例 done", status: "done" }),
      blankMission({ id: "m-ng3", title: "负例 failed", status: "failed" }),
      blankMission({ id: "m-ng4", title: "负例 skipped", status: "skipped" }),
    ]);
    const NEG = [
      ["m-ng1", "closed", "running", "closed→running"],
      ["m-ng2", "done", "drafted", "done→drafted"],
      ["m-ng3", "failed", "running", "failed→running"],
      ["m-ng4", "skipped", "ready", "skipped→ready"],
    ];
    for (const [id, from, to, tag] of NEG) {
      const r = await s.call("board", { action: "upsert", mission: { id, status: to } });
      const m = await getMission(id);
      ck.ok(
        `SM-03c 表外迁移 ${tag}（无 reopen）→ ToolError 且 board 零变更`,
        r.isError === true && r.text.includes("illegal state transition") && m.status === from,
        { err: r.text?.slice(0, 100), status: m.status },
      );
    }
  }

  // ================================================================
  // SM-04（V6-20 显式 reopen）：终态复活腿需 reopen:true+note 且 timeline 记
  // reopen 事件；缺 note → ToolError；closed 携 reopen → 仍拒
  // ================================================================
  {
    seedBoard([
      blankMission({ id: "m-sm4a", title: "failed 复活", status: "failed" }),
      blankMission({ id: "m-sm4b", title: "skipped 复活缺 note", status: "skipped" }),
      blankMission({ id: "m-sm4c", title: "closed 无 reopen", status: "closed" }),
      blankMission({ id: "m-sm4d", title: "done 归档携 reopen", status: "done" }),
    ]);
    const r4a = await s.call("board", {
      action: "upsert",
      mission: { id: "m-sm4a", status: "drafted", reopen: true, note: "上游修复后重做" },
    });
    const m4a = await getMission("m-sm4a");
    ck.ok(
      "SM-04a failed→drafted 携 reopen:true+note → 通且 timeline 含 reopen 事件（note 入 summary）",
      !r4a.isError && m4a.status === "drafted" &&
        m4a.timeline.some((e) => e.event === "reopen" && String(e.summary).includes("上游修复后重做")),
      { status: m4a.status, tl: JSON.stringify(m4a.timeline?.slice(-2))?.slice(0, 160) },
    );
    const r4b = await s.call("board", {
      action: "upsert",
      mission: { id: "m-sm4b", status: "drafted", reopen: true },
    });
    const m4b = await getMission("m-sm4b");
    ck.ok(
      "SM-04b skipped→drafted 携 reopen 缺 note → ToolError 且状态不变",
      r4b.isError === true && r4b.text.includes("note") && m4b.status === "skipped",
      { err: r4b.text?.slice(0, 120), status: m4b.status },
    );
    const r4c = await s.call("board", {
      action: "upsert",
      mission: { id: "m-sm4c", status: "drafted", reopen: true, note: "试图复活 closed" },
    });
    const m4c = await getMission("m-sm4c");
    ck.ok(
      "SM-04c closed 携 reopen → 仍拒（closed 无离开路径，重开=新建 mission）",
      r4c.isError === true && m4c.status === "closed",
      { err: r4c.text?.slice(0, 120), status: m4c.status },
    );
    const r4d = await s.call("board", {
      action: "upsert",
      mission: { id: "m-sm4d", status: "closed", close_confirmed: true, reopen: true, note: "评审后归档并记 reopen" },
    });
    const m4d = await getMission("m-sm4d");
    ck.ok(
      "SM-04d done→closed 携 reopen:true+note → 通且 timeline 含 reopen 事件",
      !r4d.isError && m4d.status === "closed" && m4d.timeline.some((e) => e.event === "reopen"),
      { status: m4d.status },
    );
  }

  // ================================================================
  // SM-05（V6-20 跨迁移清 ack）：任何跨状态迁移 ack 不残留（close 自动签收
  // 不跨迁移带到复活后状态）；外部 close 的 auto-ack（by=close）仍落地
  // ================================================================
  {
    seedBoard([
      blankMission({
        id: "m-sm5a",
        title: "failed 带 ack 复活",
        status: "failed",
        ack: { at: iso(-1 * HOURS), by: "coordinator", note: "旧签收" },
      }),
      blankMission({
        id: "m-sm5b",
        title: "dispatched 归档带旧 ack",
        status: "dispatched",
        ack: { at: iso(-1 * HOURS), by: "coordinator", note: "旧签收" },
      }),
    ]);
    await s.call("board", {
      action: "upsert",
      mission: { id: "m-sm5a", status: "drafted", reopen: true, note: "复活清 ack" },
    });
    const m5a = await getMission("m-sm5a");
    ck.ok(
      "SM-05a 跨状态迁移后 ack 为空（残留签收不跨迁移）",
      m5a.status === "drafted" && (m5a.ack === null || m5a.ack === undefined),
      { status: m5a.status, ack: m5a.ack },
    );
    await s.call("board", {
      action: "upsert",
      mission: { id: "m-sm5b", status: "closed", close_confirmed: true },
    });
    const m5b = await getMission("m-sm5b");
    ck.ok(
      "SM-05b 外部 close 的自动签收仍落地（清 ack 在 auto-ack 之前，by=close）",
      m5b.status === "closed" && m5b.ack && m5b.ack.by === "close",
      { ack: m5b.ack },
    );
  }
}
