// @module crv6-statemachine/p2p
/*!
 * suites/crv6-statemachine/p2p.mjs —— P2P 直通仲裁断言
 *
 *   P2P-01（token-P2P 契约基线引用）：基线两条——「跨 mission 写路径为零、单代凭据」的
 *     行为面由 crv5-auth AUTH-04/05/06 全绿承载；此处以 server 源静态锚钉住三处机械面防回退
 *     （claim 必换发/成对鉴权/report 门 fail-closed）。
 *   A-v070-P2P-01..06（v0.7 V7-02 施工）：board 双 action（不增第 12 号工具）+ server 强制
 *     双向 echo + ask 前置态限 blocked/question + token 三边界机制化 + 租约定案（p2p 事件
 *     不续租但 echo 计活性，哨兵零改动）：
 *     01 边界一（错/缺 token 拒+档内与响应无 token 字样）；02 边界二（非 to 侧拒+提问方
 *     mission 除 timeline echo 外逐字段不变）；03 边界三（双方 timeline 回放+档全文可溯）；
 *     04 失效面（target 不存在/终态/非持有者即错不建档+TTL 过期 expired+双 echo）；
 *     05 ask 前置态限 blocked/question；06 哨兵活性语义不回归。
 *
 * 拆分自 suites/crv6-statemachine.mjs（初步切分批次），断言本体逐字搬运零行为变更。
 */
import fs from "node:fs";
import path from "node:path";
import { blankMission } from "../../harness/temp-root.mjs";
import { PLUGIN_DIR } from "../../harness/jsonrpc-client.mjs";
import { familySource } from "../../harness/source-family.mjs";

export async function run(ctx) {
  const { ck, s, T, resultText, getMission, lastEvent, appendMissions } = ctx;

  // ================================================================
  // P2P-01（token-P2P 契约基线引用）：基线两条——「跨 mission 写路径为零、
  // 单代凭据」的行为面由 crv5-auth AUTH-04/05/06 全绿承载（A3 已绿 27 检查点）；
  // 此处以 server 源静态锚钉住三处机械面防回退。
  // ================================================================
  {
    // v1.3 切分重基（修复轮 D）：三锚分属 tool-board/tool-report/server-p2p/tool-pack 模块，
    // 读取面走 server 族 helper（入口+模块族拼接），字面锁与期望值零改动。
    const src = familySource(PLUGIN_DIR, path.join("mcp", "server.mjs"));
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
      e3.isError === true && e3.text.includes("to side"),
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
      e5.isError === true && e5.text.includes("precondition not met"),
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
      e6.isError === true && e6.text.includes("does not exist"),
      e6.text.slice(0, 100),
    );
    ck.ok(
      "P2P-v04b target 终态（done）→ 即刻报错（不建档）",
      e7.isError === true && e7.text.includes("terminal"),
      e7.text.slice(0, 100),
    );
    ck.ok(
      "P2P-v04c to_worker 非目标当前持有者 → 拒（否则无人能合法应答）",
      e8.isError === true && e8.text.includes("current holder"),
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
    // v1.3 切分重基（修复轮 D）：lastActivityMs 已迁 hooks/bg-sentinel/core.mjs，读取面走
    // bg-sentinel 族 helper（入口+模块族拼接），字面锁与期望值零改动。
    const sentinelSrc = familySource(PLUGIN_DIR, path.join("hooks", "bg-sentinel.mjs"));
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
}
