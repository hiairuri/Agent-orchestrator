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
 *   转录自 W-A1 §1 各断言草案；suite 注册行归主控 G 胶水波收口（run-all REGISTRY）。
 *
 * 运行方式：node tests/suites/crv6-statemachine.mjs [--root <临时根>]
 * 前置：node >= 20；无 git 依赖。
 */
import fs from "node:fs";
import path from "node:path";
import { startServer, Checker, DEFAULT_SERVER } from "../harness/jsonrpc-client.mjs";
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
const getMission = async (id) => resultText(await s.call("board", { action: "get", mission_id: id }));
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
    ck.ok("SM-02d 携 close_confirmed:true → 归档成功", !x4.isError && x4.json?.mission?.status === "closed", x4.text?.slice(0, 120));
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
  await sleep(0); // 事件落盘窗口兜底（与既有 suite 惯例一致）
} finally {
  s.close();
  BASE.cleanup();
}
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
