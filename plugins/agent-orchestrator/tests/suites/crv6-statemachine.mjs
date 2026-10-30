// @module crv6-statemachine
/*!
 * suites/crv6-statemachine.mjs —— v0.6 状态机 suite（A1 bootstrap：SM-08；A4 波增例 SM-01..07/P2P-01）
 *
 * 覆盖断言组：
 *   A-v060-SM-01/02（V6-11 closed 双门：采信侧 isGreenClosed = qa.verdict==="pass"（A3 qa 结构体对齐）
 *     ∨ pack.sandbox.applied_at；写入侧 close_confirmed:true 且 drafted 禁直达；sandbox_apply 直改不受限）
 *   A-v060-SM-03/04/05（V6-20 ALLOWED_TRANSITIONS 白名单矩阵回归、终态复活 reopen:true+note、
 *     跨迁移清 ack、→running 仅 claim 可达、内部写者 opts.internal 旁路）
 *   A-v060-SM-06/07（V6-21 回收扩容：有 claim 且租约过期即回收（终态豁免）；running/dispatched→ready、
 *     blocked/question 保状态；answer 对 owner=null 翻 ready，池工可立即再领取）
 *   A-v060-SM-08（V6-22 closed 拒改板 report 响应机读语义——A1 壳六检查点保真，夹具改走合法迁移）
 *   A-v060-P2P-01（token-P2P 契约基线引用：行为面由 crv5-auth AUTH-04/05/06 全绿承载，此处静态锚）
 *   A-v070-P2P-01..06（v0.7 V7-02 施工，W-A findings §3 断言草案为底，DESIGN §4.4 三裁决定案）：
 *     01 边界一（错/缺 token 拒+档内与响应无 token 字样）；02 边界二（非 to 侧拒+提问方 mission
 *     除 timeline echo 外逐字段不变）；03 边界三（双方 timeline 回放+档全文可溯）；04 失效面
 *     （target 不存在/终态/非持有者即错不建档+TTL 过期 expired+双 echo）；05 ask 前置态限
 *     blocked/question；06 哨兵活性语义不回归（lastActivityMs 计任意 timeline 事件，echo 自动计入）。
 *   WB-SRV-a..g（v1.1.1 W-B 完成即唤队列：headless done→事件恰一落内容形状锁/非 headless 与
 *     milestone 零事件/毒丸容忍/认领残留 acquired_at 可识别/并发双写两事件两文件/dispatch
 *     lock_hold_ms<2000ms；权威=v1.1.1-wake-PLAN-draft + grill#wake 七答）
 *   FA-1..5（v1.1.1-FA dispatch headless 修复：无 env 对不播种+即时桩现形 session_id/
 *     播种副本落盘+defaultModelSelection 形状锁+复制体 enabled 翻转+真实配置字节不动/
 *     model 入参非 api-key 负例不静默换模/秒死注入→ok:false+error+hint/慢启动→
 *     session_pending 契约保持；权威=v1.1.1-dispatch-bug-findings + bundle 考古锚）
 *   转录自 W-A1 §1 各断言草案；suite 注册行归主控 G 胶水波收口（run-all REGISTRY）。
 *
 * 运行方式：node tests/suites/crv6-statemachine.mjs [--root <临时根>]
 * 前置：node >= 20；无 git 依赖。
 */
import fs from "node:fs";
import path from "node:path";
import { startServer, Checker, DEFAULT_SERVER, PLUGIN_DIR } from "../harness/jsonrpc-client.mjs";
import {
  makeTempRoot,
  parseRootArg,
  blankMission,
  writeBoardSeed,
  readBoard,
} from "../harness/temp-root.mjs";

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

try {
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
      c1.isError === true && c1.text.includes("依赖未就绪") && c1.text.includes("m-sm1u"),
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
      x1.isError === true && x1.text.includes("禁止直达"),
      x1.text.slice(0, 140),
    );
    const x2 = await s.call("board", {
      action: "upsert",
      mission: { id: "m-sm2a", status: "closed", close_confirmed: true },
    });
    ck.ok(
      "SM-02b 携 close_confirmed 但 drafted 直达仍拒（未派发即归档无意义）",
      x2.isError === true && x2.text.includes("禁止直达"),
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
        r.isError === true && r.text.includes("非法状态迁移") && m.status === from,
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

  // ================================================================
  // P2P-01（token-P2P 契约基线引用）：基线两条——「跨 mission 写路径为零、
  // 单代凭据」的行为面由 crv5-auth AUTH-04/05/06 全绿承载（A3 已绿 27 检查点）；
  // 此处以 server 源静态锚钉住三处机械面防回退。
  // ================================================================
  {
    const src = fs.readFileSync(DEFAULT_SERVER, "utf8");
    ck.ok(
      "P2P-01a claim 必换发（const token = hex(16) 单源铸点，单代凭据基线）",
      src.includes("const token = hex(16);"),
      "claim 铸点",
    );
    ck.ok(
      "P2P-01b 成对鉴权（report 续租以 claim.worker === worker 为门，跨 mission 写路径为零的机械面）",
      src.includes("mission.claim.worker === worker"),
      "成对鉴权门",
    );
    ck.ok(
      "P2P-01c report 门 fail-closed（expectedToken != null 即强制携带）",
      src.includes("if (expectedToken != null) {"),
      "fail-closed 门",
    );
  }
  // ================================================================
  // A-v070-P2P-01..06（v0.7 V7-02 施工）：P2P 直通仲裁全量——board 双 action
  // （不增第 12 号工具）+ server 强制双向 echo + ask 前置态限 blocked/question +
  // token 三边界机制化 + 租约定案（p2p 事件不续租但 echo 计活性，哨兵零改动）。
  // ================================================================
  {
    // ---- 夹具：asker=blocked+token；answerer=running+token；终态目标；TTL echo 靶 ----
    await s.call("board", { action: "upsert", mission: { id: "m-p2p-a", title: "P2P asker" } });
    const cka = resultText(await s.call("board", { action: "claim", mission_id: "m-p2p-a", worker: "w-pa" }));
    await s.call("report", {
      mission_id: "m-p2p-a",
      worker: "w-pa",
      token: cka.token,
      kind: "blocked",
      question: "P2PMARKQ 需要 peer 对方案甲乙的意见",
      summary: "blocked 等 peer 意见",
    });
    await s.call("board", { action: "upsert", mission: { id: "m-p2p-b", title: "P2P answerer" } });
    const ckb = resultText(await s.call("board", { action: "claim", mission_id: "m-p2p-b", worker: "w-pb" }));
    appendMissions([
      blankMission({ id: "m-p2p-t", title: "终态目标", status: "done" }),
      blankMission({ id: "m-p2p-e1", title: "TTL echo 靶·asker 侧", status: "question" }),
      blankMission({ id: "m-p2p-e2", title: "TTL echo 靶·to 侧", status: "running" }),
    ]);
    const p2pDirPath = path.join(T, "p2p");
    const p2pFiles = () => {
      try {
        return fs.readdirSync(p2pDirPath).filter((f) => /^p2p-.+\.json$/.test(f));
      } catch {
        return [];
      }
    };
    const readStoredMission = (id) =>
      JSON.parse(fs.readFileSync(path.join(T, "board.json"), "utf8")).missions.find((m) => m && m.id === id);
    const readRec = (id) => JSON.parse(fs.readFileSync(path.join(p2pDirPath, `p2p-${id}.json`), "utf8"));
    const p2pEchoes = (m) => (Array.isArray(m.timeline) ? m.timeline.filter((e) => String(e.event || "").startsWith("p2p:")) : []);

    // ---- P2P-01（边界一·无凭据过手）：错/缺 token 拒；合法 ask 建档且档内与响应无 token 字样 ----
    const e1 = await s.call("board", {
      action: "p2p_ask",
      mission_id: "m-p2p-a",
      worker: "w-pa",
      token: "wrong" + "0".repeat(28),
      to_mission_id: "m-p2p-b",
      to_worker: "w-pb",
      question: "不该被受理的提问",
    });
    ck.ok(
      "P2P-v01a 错 token ask → ToolError（token mismatch）",
      e1.isError === true && e1.text.includes("token mismatch"),
      e1.text.slice(0, 120),
    );
    const e2 = await s.call("board", {
      action: "p2p_ask",
      mission_id: "m-p2p-a",
      worker: "w-pa",
      to_mission_id: "m-p2p-b",
      to_worker: "w-pb",
      question: "不带 token 的提问",
    });
    ck.ok(
      "P2P-v01b 缺 token ask → ToolError（missing token，fail-closed 与 report 门同族）",
      e2.isError === true && e2.text.includes("missing token"),
      e2.text.slice(0, 120),
    );
    ck.ok(
      "P2P-v01c 拒绝路径零建档（p2p/ 目录无记录文件）",
      p2pFiles().length === 0,
      p2pFiles(),
    );
    const a1 = resultText(
      await s.call("board", {
        action: "p2p_ask",
        mission_id: "m-p2p-a",
        worker: "w-pa",
        token: cka.token,
        to_mission_id: "m-p2p-b",
        to_worker: "w-pb",
        question: "P2PMARKQ 需要 peer 对方案甲乙的意见（正文很长很长很长）",
      }),
    );
    const recText = a1.p2p_id ? fs.readFileSync(path.join(p2pDirPath, `p2p-${a1.p2p_id}.json`), "utf8") : "";
    ck.ok(
      "P2P-v01d 合法 ask → 建档 ok+status=open",
      a1.ok === true && a1.status === "open" && recText.length > 0,
      { ok: a1.ok, status: a1.status, rec: recText.length },
    );
    ck.ok(
      "P2P-v01e 边界一：档内与响应 grep 均无 asker token 字样（token 不入档不回显）",
      !recText.includes(cka.token) && !JSON.stringify(a1).includes(cka.token),
      "token 泄露扫描",
    );
    const ls1 = resultText(await s.call("board", { action: "list" }));
    ck.ok("P2P-v01f board list 附 open_p2p=1（open 档计数在位）", ls1.open_p2p === 1, ls1.open_p2p);

    // ---- P2P-06 动态腿（ask 后立即验活性回声，answer 之前）：末事件=p2p:ask 且 at 可解析 ----
    const afterAsk = readStoredMission("m-p2p-a");
    const askEcho = lastEvent(afterAsk);
    ck.ok(
      "P2P-v06a ask 后 asker 末 timeline 事件=p2p:ask（echo 即哨兵 B1 活性输入）",
      askEcho?.event === "p2p:ask" && Number.isFinite(Date.parse(String(askEcho?.at))),
      { event: askEcho?.event, at: askEcho?.at },
    );
    ck.ok(
      "P2P-v06b echo 不触碰 blocked 字段（哨兵 question 告警判据 answered===false 不回归）",
      afterAsk.blocked && afterAsk.blocked.answered === false && Boolean(afterAsk.blocked.question),
      afterAsk.blocked,
    );

    // ---- P2P-02（边界二·只答不写）：非 to 侧拒；合法答后提问方 mission 除 timeline echo 外逐字段不变 ----
    const e3 = await s.call("board", {
      action: "p2p_answer",
      mission_id: "m-p2p-a",
      worker: "w-pa",
      token: cka.token,
      p2p_id: a1.p2p_id,
      answer: "asker 冒充应答",
    });
    ck.ok(
      "P2P-v02a 非 to 侧（asker 本人）answer → ToolError（仅限记录 to 侧）",
      e3.isError === true && e3.text.includes("to 侧"),
      e3.text.slice(0, 120),
    );
    const e4 = await s.call("board", {
      action: "p2p_answer",
      mission_id: "m-p2p-b",
      worker: "w-pb",
      token: "wrong" + "0".repeat(28),
      p2p_id: a1.p2p_id,
      answer: "token 错的应答",
    });
    ck.ok(
      "P2P-v02b to 侧 worker 但错 token → ToolError（token mismatch）",
      e4.isError === true && e4.text.includes("token mismatch"),
      e4.text.slice(0, 120),
    );
    const beforeAnswer = readStoredMission("m-p2p-a");
    const a2 = resultText(
      await s.call("board", {
        action: "p2p_answer",
        mission_id: "m-p2p-b",
        worker: "w-pb",
        token: ckb.token,
        p2p_id: a1.p2p_id,
        answer: "P2PMARKA 建议采方案乙：桥接键稀疏语义先落地",
      }),
    );
    ck.ok(
      "P2P-v02c 合法 answer → ok+status=answered",
      a2.ok === true && a2.status === "answered",
      { ok: a2.ok, status: a2.status },
    );
    const afterAnswer = readStoredMission("m-p2p-a");
    const diffKeys = Object.keys({ ...beforeAnswer, ...afterAnswer }).filter(
      (k) => k !== "timeline" && JSON.stringify(beforeAnswer[k]) !== JSON.stringify(afterAnswer[k]),
    );
    ck.ok(
      "P2P-v02d 边界二：提问方 mission 除 timeline 外逐字段不变（状态/租约/blocked 零触碰）",
      diffKeys.length === 0 && afterAnswer.status === "blocked",
      { diffs: diffKeys, status: afterAnswer.status },
    );
    ck.ok(
      "P2P-v02e 提问方 timeline 恰 +1 且新事件=p2p:answer（server 强制 echo，非应答方写权）",
      afterAnswer.timeline.length === beforeAnswer.timeline.length + 1 &&
        lastEvent(afterAnswer)?.event === "p2p:answer",
      { n: afterAnswer.timeline.length - beforeAnswer.timeline.length, ev: lastEvent(afterAnswer)?.event },
    );
    const rec2 = readRec(a1.p2p_id);
    ck.ok(
      "P2P-v02f 档翻 answered+answered_at/answer 在位且仍无 token 字样",
      rec2.status === "answered" && Boolean(rec2.answered_at) &&
        String(rec2.answer).includes("P2PMARKA") && !JSON.stringify(rec2).includes(ckb.token),
      { status: rec2.status, answered_at: rec2.answered_at },
    );

    // ---- P2P-03（边界三·审计回声）：双方 board get 均见 ask+answer echo；档全文可溯；open_p2p 归零 ----
    const ga = await getMission("m-p2p-a");
    const gb = await getMission("m-p2p-b");
    ck.ok(
      "P2P-v03a 提问方 timeline 回放含 p2p:ask+p2p:answer",
      p2pEchoes(ga).map((e) => e.event).join(",") === "p2p:ask,p2p:answer",
      p2pEchoes(ga).map((e) => e.event),
    );
    ck.ok(
      "P2P-v03b 应答方 timeline 回放含 p2p:ask+p2p:answer（双方强制 echo）",
      p2pEchoes(gb).map((e) => e.event).join(",") === "p2p:ask,p2p:answer",
      p2pEchoes(gb).map((e) => e.event),
    );
    ck.ok(
      "P2P-v03c 档全文可溯（question/answer 原文含 MARKER；echo 摘要携 p2p id 指针）",
      rec2.question.includes("P2PMARKQ") && rec2.answer.includes("P2PMARKA") &&
        String(lastEvent(afterAnswer)?.summary).includes(a1.p2p_id),
      "全文+指针",
    );
    const ls2 = resultText(await s.call("board", { action: "list" }));
    ck.ok("P2P-v03d 答后 open_p2p 归零（answered 不计 open）", ls2.open_p2p === 0, ls2.open_p2p);

    // ---- P2P-05（前置态裁决定案）：非 blocked/question 态 ask → 拒 ----
    const e5 = await s.call("board", {
      action: "p2p_ask",
      mission_id: "m-p2p-b",
      worker: "w-pb",
      token: ckb.token,
      to_mission_id: "m-p2p-a",
      to_worker: "w-pa",
      question: "running 态不该能问",
    });
    ck.ok(
      "P2P-v05 running 态 ask → ToolError（前置态不满足；主通道 report(question) 恒可用）",
      e5.isError === true && e5.text.includes("前置态不满足"),
      e5.text.slice(0, 120),
    );

    // ---- P2P-04（失效面）：target 不存在/终态/非持有者 → 即刻报错不建档；TTL 过期 → expired+双 echo ----
    const filesBefore = p2pFiles().length;
    const e6 = await s.call("board", {
      action: "p2p_ask",
      mission_id: "m-p2p-a",
      worker: "w-pa",
      token: cka.token,
      to_mission_id: "m-p2p-nope",
      to_worker: "w-x",
      question: "目标不存在",
    });
    const e7 = await s.call("board", {
      action: "p2p_ask",
      mission_id: "m-p2p-a",
      worker: "w-pa",
      token: cka.token,
      to_mission_id: "m-p2p-t",
      to_worker: "w-t",
      question: "目标已终态",
    });
    const e8 = await s.call("board", {
      action: "p2p_ask",
      mission_id: "m-p2p-a",
      worker: "w-pa",
      token: cka.token,
      to_mission_id: "m-p2p-b",
      to_worker: "w-someone-else",
      question: "非当前持有者",
    });
    ck.ok(
      "P2P-v04a target 不存在 → 即刻报错（不建档）",
      e6.isError === true && e6.text.includes("不存在"),
      e6.text.slice(0, 100),
    );
    ck.ok(
      "P2P-v04b target 终态（done）→ 即刻报错（不建档）",
      e7.isError === true && e7.text.includes("终态"),
      e7.text.slice(0, 100),
    );
    ck.ok(
      "P2P-v04c to_worker 非目标当前持有者 → 拒（否则无人能合法应答）",
      e8.isError === true && e8.text.includes("持有者"),
      e8.text.slice(0, 100),
    );
    ck.ok(
      "P2P-v04d 三连失效面零建档（p2p/ 文件数不变）",
      p2pFiles().length === filesBefore,
      { before: filesBefore, after: p2pFiles().length },
    );
    const ttlId = "000000000000099-dead";
    const ttlCreated = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    fs.mkdirSync(p2pDirPath, { recursive: true });
    fs.writeFileSync(
      path.join(p2pDirPath, `p2p-${ttlId}.json`),
      JSON.stringify(
        {
          v: 1,
          id: ttlId,
          from: { mission_id: "m-p2p-e1", worker: "w-e1" },
          to: { mission_id: "m-p2p-e2", worker: "w-e2" },
          question: "TTL 到期档问题",
          status: "open",
          created_at: ttlCreated,
          answered_at: null,
          answer: null,
          expired_at: null,
          echo: { ask: ttlCreated, answer: null },
        },
        null,
        2,
      ) + "\n",
    );
    const ls3 = resultText(await s.call("board", { action: "list" })); // list 骑载 gc 扫描
    const ttlRec = readRec(ttlId);
    const ge1 = await getMission("m-p2p-e1");
    const ge2 = await getMission("m-p2p-e2");
    ck.ok(
      "P2P-v04e 过期档经 gc 翻 expired+expired_at 在位（TTL 默认 30min，--p2p-ttl-min 可调）",
      ttlRec.status === "expired" && Boolean(ttlRec.expired_at),
      { status: ttlRec.status, expired_at: ttlRec.expired_at },
    );
    ck.ok(
      "P2P-v04f TTL 过期双 echo：两侧 timeline 各得 p2p:expired",
      lastEvent(ge1)?.event === "p2p:expired" && lastEvent(ge2)?.event === "p2p:expired",
      { e1: lastEvent(ge1)?.event, e2: lastEvent(ge2)?.event },
    );
    ck.ok(
      "P2P-v04g gc 后 open_p2p 仍为 0（expired 不计 open）",
      ls3.open_p2p === 0,
      ls3.open_p2p,
    );

    // ---- P2P-06（哨兵活性语义不回归）：静态锚（哨兵零改动=契约）+ 新 ask/answer 轮再确认 ----
    const sentinelSrc = fs.readFileSync(
      path.join(path.dirname(DEFAULT_SERVER), "..", "hooks", "bg-sentinel.mjs"),
      "utf8",
    );
    ck.ok(
      "P2P-v06c 哨兵 B1 静态锚：lastActivityMs 计任意 timeline 事件（p2p echo 自动计入活性，哨兵零改动）",
      sentinelSrc.includes("function lastActivityMs") && sentinelSrc.includes("any timeline event at"),
      "bg-sentinel lastActivityMs",
    );
    const a3 = resultText(
      await s.call("board", {
        action: "p2p_ask",
        mission_id: "m-p2p-a",
        worker: "w-pa",
        token: cka.token,
        to_mission_id: "m-p2p-b",
        to_worker: "w-pb",
        question: "第二轮活性确认问",
      }),
    );
    const a4 = resultText(
      await s.call("board", {
        action: "p2p_answer",
        mission_id: "m-p2p-b",
        worker: "w-pb",
        token: ckb.token,
        p2p_id: a3.p2p_id,
        answer: "第二轮活性确认答",
      }),
    );
    const finalAsker = readStoredMission("m-p2p-a");
    ck.ok(
      "P2P-v06d 第二轮 ask/answer 通且提问方状态仍 blocked（等待语义不被 p2p 翻转，宽限/告警面不回归）",
      a3.ok === true && a4.ok === true && finalAsker.status === "blocked" &&
        finalAsker.blocked.answered === false,
      { ask: a3.ok, ans: a4.ok, status: finalAsker.status },
    );
  }
  // ================================================================
  // v1.1.1 W-B：完成即唤队列（server 生产者① headless 闸 + 队列形三钉 + lock-hold 量测；
  // grill#wake Q1-Q5 裁定：闸=dispatch.mode==="headless" 零新字段；逐事件单文件 wx/毒丸
  // 跳过/认领残留含 acquired_at；lock-hold <2000ms=2s 锁预算）
  // ================================================================
  {
    const qdir = path.join(T, "context", "wake-queue");
    // v1.2.3 W1 竞态隔离（主控二次扩授裁决 m-20261030-060549-56b4）：d/e 腿（claim 态受控腿）
    // 改用独立 server 实例 sWb2+独立根——a 腿 detached wake-kick 绑旧根 T，其 acquireClaim
    // 超龄回收消费面（WAKE_CLAIM_STALE_MS=120s，v1.1.1 52c081b 引入）会在共享根上与
    // 「残留字节级原样」断言竞跑（基线 stash 3/3 同红实证；红率 9/10）。sWb2 根零 K 污染
    // （d/e 腿 claim 全程在场=生产者 EEXIST 静默零 spawn）；生产者 EEXIST 静默面照钉零
    // 弱化；a/b/c/f/g 腿留原实例（主控裁决）。根=BASE 下 wb2 子目录，收尾由 BASE.cleanup()
    // 统一清（既有惯例，零新清理面）。
    const wb2Root = path.join(BASE.root, "wb2-root");
    fs.mkdirSync(wb2Root, { recursive: true });
    const sWb2 = startServer({ root: wb2Root });
    const qdir2 = path.join(wb2Root, "context", "wake-queue");
    const qevents2 = () =>
      fs.existsSync(qdir2)
        ? fs.readdirSync(qdir2).filter((f) => f.endsWith(".json") && f !== "claim.json").sort()
        : [];
    const qread2 = (f) => JSON.parse(fs.readFileSync(path.join(qdir2, f), "utf8"));
    const qclaimText2 = () => {
      try {
        return fs.readFileSync(path.join(qdir2, "claim.json"), "utf8");
      } catch {
        return null;
      }
    };
    const seedHeadless2 = (id, sessionId) =>
      sWb2.call("board", {
        action: "upsert",
        mission: {
          id,
          title: "wb-" + id,
          status: "dispatched",
          dispatch: { mode: "headless", agent_id: null, task_id: null, session_id: sessionId },
        },
      });
    const doneReport2 = (id, worker = "gp-wb#1") =>
      sWb2.call("report", { mission_id: id, worker, kind: "done", summary: "wb 收口" });
    const qevents = () =>
      fs.existsSync(qdir)
        ? fs.readdirSync(qdir).filter((f) => f.endsWith(".json") && f !== "claim.json").sort()
        : [];
    const qread = (f) => JSON.parse(fs.readFileSync(path.join(qdir, f), "utf8"));
    const qclaimText = () => {
      try {
        return fs.readFileSync(path.join(qdir, "claim.json"), "utf8");
      } catch {
        return null;
      }
    };
    const upsertWb = (mission) => s.call("board", { action: "upsert", mission });
    const seedHeadless = (id, sessionId) =>
      upsertWb({
        id,
        title: "wb-" + id,
        status: "dispatched",
        dispatch: { mode: "headless", agent_id: null, task_id: null, session_id: sessionId },
      });
    const doneReport = (id, worker = "gp-wb#1") =>
      s.call("report", { mission_id: id, worker, kind: "done", summary: "wb 收口" });

    // ---- WB-SRV-a：headless done → 事件恰一落（内容形状锁）----
    await seedHeadless("m-wb-head", "sess_wb_head");
    const beforeA = qevents();
    const rdA = resultText(await doneReport("m-wb-head"));
    const freshA = qevents().filter((f) => !beforeA.includes(f));
    const evA = freshA.length === 1 ? qread(freshA[0]) : null;
    ck.ok(
      "WB-SRV-a headless done → wake-queue 事件恰一落：文件名 <ms>-<mission_id>.json（逐事件单文件形），" +
        "内容 {mission_id,worker,session_id(=dispatch.session_id),result_path(null=server 源),created_at ISO,source=server}；" +
        "认领文件 spawn 后已释放；板 status=done",
      rdA.ok === true && rdA.status === "done" &&
        freshA.length === 1 && /^\d+-m-wb-head\.json$/.test(freshA[0]) &&
        evA && evA.mission_id === "m-wb-head" && evA.worker === "gp-wb#1" &&
        evA.session_id === "sess_wb_head" && evA.result_path === null &&
        Number.isFinite(Date.parse(evA.created_at)) && evA.source === "server" &&
        qclaimText() === null &&
        boardJson().missions.find((m) => m.id === "m-wb-head").status === "done",
      { rd: { ok: rdA.ok, status: rdA.status }, fresh: freshA, ev: evA, claim: qclaimText() },
    );

    // ---- WB-SRV-b：非 headless done → 零事件（宿主托管形态有平台通知，防双唤噪声）----
    await upsertWb({
      id: "m-wb-agent",
      title: "wb-agent",
      status: "dispatched",
      dispatch: { mode: "agent", agent_id: "a-wb" },
    });
    await upsertWb({ id: "m-wb-nodisp", title: "wb-nodisp", status: "dispatched" });
    const beforeB = qevents();
    const rdB1 = resultText(await doneReport("m-wb-agent", "gp-wb#2"));
    const rdB2 = resultText(await doneReport("m-wb-nodisp", "gp-wb#3"));
    ck.ok(
      "WB-SRV-b 非 headless（mode=agent / 无 dispatch 键）done → 零事件落（闸面负例，grill#wake Q3 headless 标记判定）",
      rdB1.ok === true && rdB2.ok === true && qevents().length === beforeB.length,
      { before: beforeB.length, after: qevents().length },
    );

    // ---- WB-SRV-c：headless 但 kind≠done（milestone）→ 零事件 ----
    const beforeC = qevents();
    const rdC = resultText(
      await s.call("report", { mission_id: "m-wb-head", worker: "gp-wb#1", kind: "milestone", summary: "wb 里程碑" }),
    );
    ck.ok(
      "WB-SRV-c headless mission 的 milestone → 零事件落（done 分支闸，:4467 区域挂点语义）",
      rdC.ok === true && qevents().length === beforeC.length,
      { before: beforeC.length, after: qevents().length },
    );

    // ---- WB-SRV-d：毒丸容忍——坏事件文件+坏认领文件在场，生产面不受染（认领 EEXIST=静默
    //      跳过、claim 字节不动、新事件照落、report 主流程 ok）。
    //      v1.2.3 W1 竞态隔离（主控扩授裁决）：本腿起搬入 sWb2 隔离面（qdir2），断言主句与
    //      判据逐字保留（claim 态受控腿脱离旧根 K 消费面）。
    try {
      fs.mkdirSync(qdir2, { recursive: true });
      fs.writeFileSync(path.join(qdir2, "garbage.json"), "{corrupt 毒丸坏件");
      const poisonClaim = "{corrupt claim 毒丸";
      fs.writeFileSync(path.join(qdir2, "claim.json"), poisonClaim);
      await seedHeadless2("m-wb-poison", "sess_wb_poison");
      const beforeD = qevents2();
      const rdD = resultText(await doneReport2("m-wb-poison", "gp-wb#4"));
      const freshD = qevents2().filter((f) => !beforeD.includes(f));
      ck.ok(
        "WB-SRV-d 毒丸容忍（三钉之二）：坏件 garbage.json+坏 claim.json 在场 → 新事件照落恰一、" +
          "坏 claim 字节级不动（生产者不读既有内容只 wx 写自己文件=天然隔离）、report 主流程 ok 不受阻",
        rdD.ok === true && freshD.length === 1 && qread2(freshD[0]).mission_id === "m-wb-poison" &&
          qclaimText2() === poisonClaim,
        { fresh: freshD, claimIntact: qclaimText2() === poisonClaim, ok: rdD.ok },
      );

    // ---- WB-SRV-e：认领残留可识别——合法 claim.json（含 acquired_at）在场=他者持有中 →
    //      静默不夺不删不 spawn，残留原样保留（认领后 crash 的残留超龄回收=WB 波，本波钉可识别面）。
    //      v1.2.3 W1 竞态隔离（主控扩授裁决）：本腿在 sWb2 隔离面（qdir2）上运行——旧根 K 的
    //      超龄回收消费面不再与本断言竞跑；断言主句与判据逐字保留零弱化。
    const residueClaim =
      JSON.stringify({ acquired_at: new Date(Date.now() - 3600000).toISOString(), source: "test-residue" }, null, 2) + "\n";
    try {
      fs.unlinkSync(path.join(qdir2, "claim.json"));
    } catch { /* 前腿坏 claim 换合法残留 */ }
    fs.writeFileSync(path.join(qdir2, "claim.json"), residueClaim);
    await seedHeadless2("m-wb-residue", "sess_wb_residue");
    const rdE = resultText(await doneReport2("m-wb-residue", "gp-wb#5"));
    const claimAfter = qclaimText2();
    let residueFresh = false;
    try {
      residueFresh = Number.isFinite(Date.parse(JSON.parse(claimAfter).acquired_at));
    } catch { /* keep false */ }
    ck.ok(
      "WB-SRV-e 认领残留可识别（三钉之三）：他者 claim（含 acquired_at）在场 → 事件照落、" +
        "claim 字节级原样保留+acquired_at 可解析（残留识别面；超龄回收归 WB 波）、report ok",
      rdE.ok === true && claimAfter === residueClaim && residueFresh,
      { claimIntact: claimAfter === residueClaim, parseable: residueFresh },
    );
    } finally {
      sWb2.close();
    }

    // ---- WB-SRV-f：并发双写 → 两事件两文件（wx 原子建，禁共享单 jsonl 追加）----
    await seedHeadless("m-wb-c1", "sess_wb_c1");
    await seedHeadless("m-wb-c2", "sess_wb_c2");
    const beforeF = qevents();
    const [rf1, rf2] = await Promise.all([
      resultText(await doneReport("m-wb-c1", "gp-c1#1")),
      resultText(await doneReport("m-wb-c2", "gp-c2#1")),
    ]);
    const freshF = qevents().filter((f) => !beforeF.includes(f));
    const freshIds = freshF.map((f) => { try { return qread(f).mission_id; } catch { return null; } }).sort();
    ck.ok(
      "WB-SRV-f 并发双写 → 两事件两文件（每文件恰一 mission、逐事件 wx 独占创建、无共享追加形）",
      rf1.ok === true && rf2.ok === true && freshF.length === 2 &&
        JSON.stringify(freshIds) === JSON.stringify(["m-wb-c1", "m-wb-c2"]),
      {
        fresh: freshF, ids: freshIds,
        r1: { ok: rf1.ok, err: rf1.ok ? null : String(rf1._raw ?? rf1.error ?? "").slice(0, 160) },
        r2: { ok: rf2.ok, err: rf2.ok ? null : String(rf2._raw ?? rf2.error ?? "").slice(0, 160) },
      },
    );

    // ---- WB-SRV-g：dispatch 同步段锁持时 <2000ms（grill#wake Q5 lock-hold-time 断言；
    //      黑盒量测面=dispatch 响应 lock_hold_ms；stub CLI+隔离 rollout 零模型事务）----
    const lockBase = path.join(BASE.root, "wb-lock");
    const lockRoot = path.join(lockBase, "troot");
    const lockRollout = path.join(lockBase, "rollout");
    fs.mkdirSync(lockRoot, { recursive: true });
    fs.mkdirSync(lockRollout, { recursive: true });
    const lockStub = path.join(lockBase, "stub-cli.mjs");
    fs.writeFileSync(
      lockStub,
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        'const dir = process.env.ORCH_ROLLOUT_DIR || ".";',
        'fs.mkdirSync(dir, { recursive: true });',
        'fs.writeFileSync(path.join(dir, "model-io-sess_wb_lock.jsonl"), JSON.stringify({ t: 1 }) + "\\n");',
        'console.log(JSON.stringify({ type: "result", sessionId: "sess_wb_lock", response: "stub-ok", usage: {} }));',
      ].join("\n") + "\n",
    );
    const lockPack = path.join(lockBase, "pack.md");
    fs.writeFileSync(
      lockPack,
      "# 任务包：lock-hold 量测\n\n## CONTRACT（三行契约）\n\n[channel] m-wb-lock\n[worker] gp-lock#1\n[token] 0123456789abcdef0123456789abcdef\n\n## TASK\n量测 dispatch 同步段锁持时。\n",
    );
    const s2 = startServer({
      root: lockRoot,
      cwd: lockRoot,
      env: { ZCODE_CLI_PATH: lockStub, ORCH_ROLLOUT_DIR: lockRollout },
    });
    try {
      await s2.call("board", {
        action: "upsert",
        mission: {
          id: "m-wb-lock",
          title: "lock-hold 量测",
          status: "drafted",
          agent_type: "agent-orchestrator:orch-worker",
          scope_paths: ["src/"],
        },
      });
      const dr = resultText(
        await s2.call("dispatch", {
          mission_id: "m-wb-lock",
          pack_path: lockPack,
          persona_path: path.join(PLUGIN_DIR, "agents", "orch-worker.md"),
        }),
      );
      ck.ok(
        "WB-SRV-g dispatch 同步段（withRootLock 内 gates+board+spawn）持时 <2000ms（2s 锁预算；" +
          "响应 lock_hold_ms 黑盒量测；detached spawn 非阻塞构造性质=dispatch 出货先例）",
        dr.ok === true && Number.isFinite(dr.lock_hold_ms) && dr.lock_hold_ms >= 0 && dr.lock_hold_ms < 2000,
        { lock_hold_ms: dr.lock_hold_ms, ok: dr.ok, session_id: dr.session_id },
      );
    } finally {
      s2.close();
    }

    // ================================================================
    // v1.1.1-FA：dispatch headless 修复波（模型供给播种 + 失败显式化）。
    // 根因权威=designs/agent-orchestrator-v1.1.1-dispatch-bug-findings.md（R2）+
    // bundle 考古锚（server.mjs dispatchSeedModelConfig 注释块全录）。
    // ================================================================
    const faBase = path.join(BASE.root, "fa");
    fs.mkdirSync(faBase, { recursive: true });
    const faPack = path.join(faBase, "pack.md");
    fs.writeFileSync(
      faPack,
      "# 任务包：FA 修复波\n\n## CONTRACT（三行契约）\n\n[channel] m-fa-x\n[worker] gp-fa#1\n[token] fa token placeholder\n\n## TASK\n桩 CLI 黑盒。\n",
    );
    const faPersona = path.join(PLUGIN_DIR, "agents", "orch-worker.md");
    /** 即时桩 CLI：写 model-io + result envelope（=正常拉起）。 */
    const writeInstantStub = (file, sessionId) =>
      fs.writeFileSync(
        file,
        [
          'import fs from "node:fs";',
          'import path from "node:path";',
          'const dir = process.env.ORCH_ROLLOUT_DIR || ".";',
          'fs.mkdirSync(dir, { recursive: true });',
          `fs.writeFileSync(path.join(dir, "model-io-${sessionId}.jsonl"), JSON.stringify({ t: 1 }) + "\\n");`,
          `console.log(JSON.stringify({ type: "result", sessionId: "${sessionId}", response: "stub-ok", usage: {} }));`,
        ].join("\n") + "\n",
      );
    const faUpsert = async (sX, id) =>
      sX.call("board", {
        action: "upsert",
        mission: { id, title: id, status: "drafted", agent_type: "agent-orchestrator:orch-worker", scope_paths: ["src/"] },
      });

    // ---- FA-1 基线腿（无 env 对 → 不播种；即时桩 → 现形 session_id，无 pending）----
    {
      const dir = path.join(faBase, "fa1");
      const stub = path.join(dir, "stub.mjs");
      fs.mkdirSync(path.join(dir, "troot"), { recursive: true });
      fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
      writeInstantStub(stub, "sess_fa1");
      const sX = startServer({
        root: path.join(dir, "troot"),
        cwd: path.join(dir, "troot"),
        env: {
          ZCODE_CLI_PATH: stub,
          ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "",
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "",
        },
      });
      try {
        await faUpsert(sX, "m-fa1");
        const r = resultText(await sX.call("dispatch", { mission_id: "m-fa1", pack_path: faPack, persona_path: faPersona }));
        ck.ok(
          "FA-1 即时桩基线：无 env 对 → model_seed.seeded=false(reason=env_pair_missing)，" +
            "dispatch 仍 ok:true 且现形 session_id（≤8s 组合捕获的 rollout 面），无 session_pending",
          r.ok === true && r.session_id === "sess_fa1" && r.session_pending === undefined &&
            r.model_seed && r.model_seed.seeded === false && r.model_seed.reason === "env_pair_missing",
          { ok: r.ok, session_id: r.session_id, model_seed: r.model_seed, pending: r.session_pending },
        );
      } finally {
        sX.close();
      }
    }

    // ---- FA-2 播种写盘腿：env 对在场 → 副本落盘 + defaultModelSelection 形状锁 +
    //      复制体翻转 enabled、真实配置字节不动 ----
    {
      const dir = path.join(faBase, "fa2");
      fs.mkdirSync(path.join(dir, "troot"), { recursive: true });
      fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
      const stub = path.join(dir, "stub.mjs");
      writeInstantStub(stub, "sess_fa2");
      const fakeBuiltin = path.join(dir, "zcode-builtin.json");
      fs.writeFileSync(fakeBuiltin, JSON.stringify({ schemaVersion: 1, revision: 1, config: { providerConfigRules: { templateRules: [], providerRules: [] }, modelConfigRules: {} } }, null, 2));
      const fakePersonal = path.join(dir, "provider_config.json");
      const personalOriginal = JSON.stringify(
        {
          schemaVersion: 1,
          config: {
            providerOrder: ["fa-provider"],
            providerConfigRules: {
              providerRules: [
                {
                  providerId: "fa-provider",
                  providerName: "FA Seed Provider",
                  config: {
                    group: "standard-personal",
                    access: { type: "api-key", apiKey: "sk-fa-seed" },
                    api: { type: "openai-chat-completions", baseUrl: "https://example.invalid/v1" },
                    personalModelIds: ["FA-Model"],
                    modelOrder: ["FA-Model"],
                  },
                },
              ],
            },
            modelConfigRules: {
              providerModelRules: [{
                modelId: "FA-Model",
                config: { enabled: false, optionSpecs: { reasoningLevel: { values: ["disabled", "enabled"] } } },
                providerId: "fa-provider",
              }],
            },
          },
        },
        null,
        2,
      );
      fs.writeFileSync(fakePersonal, personalOriginal);
      const sX = startServer({
        root: path.join(dir, "troot"),
        cwd: path.join(dir, "troot"),
        env: {
          ZCODE_CLI_PATH: stub,
          ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: fakePersonal,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fakeBuiltin,
        },
      });
      try {
        await faUpsert(sX, "m-fa2");
        // v1.2.3 W2：显式 model 入参补一枚——FA-2 原驱动（无 model= 无 dms）即被删除的
        // 段③「首 api-key」场景（selection_missing 接管，DS-05 钉其缺席）；断言本体
        // （播种写盘/复制体翻转/dms 形状/原件不动）逐字保留，选型来源改走段①显式腿，
        // reasoning_level=values.at(-1) 的 gQi 镜像语义经 levelOf 不变（impl-plan §9
        // FA-2「保留绿」意图=断言不改；驱动线为段③删除的必要连带，done 偏差声明备案）。
        const r = resultText(
          await sX.call("dispatch", { mission_id: "m-fa2", pack_path: faPack, persona_path: faPersona, model: "fa-provider/FA-Model" }),
        );
        const seedPath = r.model_seed && r.model_seed.config_path;
        let seedDoc = null;
        try {
          seedDoc = JSON.parse(fs.readFileSync(seedPath, "utf8"));
        } catch {
          seedDoc = null;
        }
        const sel = seedDoc && seedDoc.config && seedDoc.config.defaultModelSelection;
        const copiedRule = seedDoc && seedDoc.config.providerConfigRules.providerRules.find((x) => x.providerId === "fa-provider");
        const copiedModel = seedDoc.config.modelConfigRules.providerModelRules.find(
          (x) => x.providerId === "fa-provider" && x.modelId === "FA-Model",
        );
        ck.ok(
          "FA-2 播种写盘：model_seed.seeded=true + 使命戳副本存在 + 复制体 enabled 翻转；" +
            "模型自带 optionSpecs → dms={providerId,modelId,options.reasoningLevel=values.at(-1)}" +
            "（gQi 镜像）且不注 optionSpecs（注入即整份配置恢复空，FA bisect 实证）；真实配置字节级不动",
          r.ok === true && r.model_seed && r.model_seed.seeded === true &&
            r.model_seed.provider_id === "fa-provider" && r.model_seed.model_id === "FA-Model" &&
            r.model_seed.reasoning_level === "enabled" && seedDoc !== null &&
            JSON.stringify(sel) === JSON.stringify({ providerId: "fa-provider", modelId: "FA-Model", options: { reasoningLevel: "enabled" } }) &&
            copiedModel && copiedModel.config.enabled === true &&
            JSON.stringify(copiedModel.config.optionSpecs) === JSON.stringify({ reasoningLevel: { values: ["disabled", "enabled"] } }) &&
            fs.readFileSync(fakePersonal, "utf8") === personalOriginal,
          {
            model_seed: r.model_seed, sel, copiedEnabled: copiedModel && copiedModel.config && copiedModel.config.enabled,
            copiedSpecs: copiedModel && copiedModel.config && copiedModel.config.optionSpecs,
            personalIntact: fs.readFileSync(fakePersonal, "utf8") === personalOriginal,
          },
        );
      } finally {
        sX.close();
      }
    }

    // ---- FA-3 model 入参负例：不可用（非 api-key provider）→ seeded:false+reason，不静默换模 ----
    {
      const dir = path.join(faBase, "fa3");
      fs.mkdirSync(path.join(dir, "troot"), { recursive: true });
      fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
      const stub = path.join(dir, "stub.mjs");
      writeInstantStub(stub, "sess_fa3");
      const fakeBuiltin = path.join(dir, "zcode-builtin.json");
      fs.writeFileSync(fakeBuiltin, JSON.stringify({ schemaVersion: 1, revision: 1, config: { providerConfigRules: { templateRules: [], providerRules: [] }, modelConfigRules: {} } }, null, 2));
      const fakePersonal = path.join(dir, "provider_config.json");
      fs.writeFileSync(
        fakePersonal,
        JSON.stringify(
          {
            schemaVersion: 1,
            config: {
              providerConfigRules: {
                providerRules: [
                  {
                    providerId: "fa-acct",
                    config: { access: { type: "zhipu-account", accountType: "bigmodel", mode: "individual-coding-plan" } },
                  },
                ],
              },
              modelConfigRules: { providerModelRules: [] },
            },
          },
          null,
          2,
        ),
      );
      const sX = startServer({
        root: path.join(dir, "troot"),
        cwd: path.join(dir, "troot"),
        env: {
          ZCODE_CLI_PATH: stub,
          ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: fakePersonal,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fakeBuiltin,
        },
      });
      try {
        await faUpsert(sX, "m-fa3");
        const r = resultText(
          await sX.call("dispatch", { mission_id: "m-fa3", pack_path: faPack, persona_path: faPersona, model: "fa-acct/GLM-X@low" }),
        );
        ck.ok(
          "FA-3 model 入参负例：显式 model 指向非 api-key provider → model_seed.seeded=false" +
            "(reason=model_arg_unusable) 且不静默回退别的模型（显式优先原则）",
          r.ok === true && r.model_seed && r.model_seed.seeded === false && r.model_seed.reason === "model_arg_unusable",
          { model_seed: r.model_seed },
        );
      } finally {
        sX.close();
      }
    }

    // ---- FA-4 秒死注入：桩 CLI exit 1 +「Select a model」stderr → ok:false+error+hint ----
    {
      const dir = path.join(faBase, "fa4");
      fs.mkdirSync(path.join(dir, "troot"), { recursive: true });
      fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
      const stub = path.join(dir, "stub.mjs");
      fs.writeFileSync(
        stub,
        [
          'process.stderr.write("Error: Select a model before sending a message (traceId: fa4-stub)\\n");',
          "process.exit(1);",
        ].join("\n") + "\n",
      );
      const sX = startServer({
        root: path.join(dir, "troot"),
        cwd: path.join(dir, "troot"),
        env: {
          ZCODE_CLI_PATH: stub,
          ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
          ORCH_DISPATCH_CAPTURE_MS: "1500",
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "",
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "",
        },
      });
      try {
        await faUpsert(sX, "m-fa4");
        const r = resultText(await sX.call("dispatch", { mission_id: "m-fa4", pack_path: faPack, persona_path: faPersona }));
        const relErr = String(r.error_path || "");
        const errorPath = path.isAbsolute(relErr) ? relErr : path.join(dir, "troot", relErr);
        let sidecarExists = false;
        try {
          sidecarExists = Boolean(errorPath && fs.statSync(errorPath).isFile());
        } catch {
          sidecarExists = false;
        }
        ck.ok(
          "FA-4 秒死显式化（R2 静默面消灭）：桩 CLI exit 1 → dispatch 返回 ok:false + " +
            "error 摘要含「Select a model」+ hint 人话指引（模型供给方向）+ error_path 指向侧车 + 无 session_pending",
          r.ok === false && /Select a model/.test(String(r.error)) &&
            String(r.hint).includes("模型") && r.session_pending === undefined && sidecarExists && r.exit_code === 1,
          { ok: r.ok, error: r.error, hint: r.hint, error_path: r.error_path, sidecarExists, exit_code: r.exit_code },
        );
      } finally {
        sX.close();
      }
    }

    // ---- FA-5 慢启动：桩 CLI 超捕获窗 → ok:true+session_pending（真慢启动契约保持）----
    {
      const dir = path.join(faBase, "fa5");
      fs.mkdirSync(path.join(dir, "troot"), { recursive: true });
      fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
      const stub = path.join(dir, "stub.mjs");
      fs.writeFileSync(
        stub,
        [
          'import fs from "node:fs";',
          'import path from "node:path";',
          'await new Promise((res) => setTimeout(res, 2200));',
          'const dir = process.env.ORCH_ROLLOUT_DIR || ".";',
          'fs.mkdirSync(dir, { recursive: true });',
          'fs.writeFileSync(path.join(dir, "model-io-sess_fa5.jsonl"), JSON.stringify({ t: 1 }) + "\\n");',
          'console.log(JSON.stringify({ type: "result", sessionId: "sess_fa5", response: "stub-slow", usage: {} }));',
        ].join("\n") + "\n",
      );
      const sX = startServer({
        root: path.join(dir, "troot"),
        cwd: path.join(dir, "troot"),
        env: {
          ZCODE_CLI_PATH: stub,
          ORCH_ROLLOUT_DIR: path.join(dir, "rollout"),
          ORCH_DISPATCH_CAPTURE_MS: "1200",
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "",
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "",
        },
      });
      try {
        await faUpsert(sX, "m-fa5");
        const r = resultText(await sX.call("dispatch", { mission_id: "m-fa5", pack_path: faPack, persona_path: faPersona }));
        ck.ok(
          "FA-5 慢启动契约保持：桩 CLI 超捕获窗（1.2s<2.2s）→ ok:true + session_pending:true（真慢启动场景）",
          r.ok === true && r.session_pending === true && r.session_id === undefined,
          { ok: r.ok, pending: r.session_pending, session_id: r.session_id },
        );
        await sleep(2400); // 桩退出窗，防 clean up 撞在跑的子进程（win32 句柄）
      } finally {
        sX.close();
      }
    }
  }
  await sleep(0); // 事件落盘窗口兜底（与既有 suite 惯例一致）
} finally {
  s.close();
  BASE.cleanup();
}
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
