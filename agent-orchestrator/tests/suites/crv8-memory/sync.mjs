// @module crv8-memory/sync
/*!
 * suites/crv8-memory/sync.mjs —— ORCH.md ver 同步捎带面场景（v1.3 W1 拆分自
 *   crv8-memory.mjs；v1.6 W2 ORCH 拆除波重整，design §2.5）。SYNC-01a..09/15..19
 *   共 17 腿随 server piggyback 注入拆除**退役**（三态推送+content 键+顶层
 *   orch_memory.orch_md 附件键全停）；本文件现载三块——
 *   场景 6 = N9 负向钉（1 腿双支：任何工具成功响应不含顶层 orch_memory 键 ∧
 *   content 不含 orch_md 键；ORCH.md create/modify/delete 三态生命周期全覆盖，
 *   防回潮；函数名 scenSync01to05 保留=入口 crv8-memory.mjs 接线零触）；
 *   场景 6b = 退役空壳（SYNC-06..09 原域；函数保留=入口接线零触）；
 *   场景 6c = SYNC-20/21 零触保留（pack 帽值句渲染=固定包 RULES 消费面，随
 *   cfg 动态；帽 cfg 两键 readGleanCfg 保留面，r-caps）。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, subRoot, writeJsonl, startServer, PRE } from "./shared.mjs";

/* ============ 场景 6（v1.6 W2 起）：N9 负向钉（ORCH 拆除防回潮，root r-sync） ============ */
/*!
 * v1.6 W2 (N9, design §2.5/§3.3)：server 不再向任何工具成功响应推送 orch_md——
 * 顶层 `orch_memory` 附件键（v1.3 W2 前的 ver-sync 捎带壳）与 content 面 result
 * 顶层 `orch_md` 键（v1.3 W2 第三 surfacing）双 surfacing 全停。本腿在 ORCH.md
 * 三态生命周期（出现/改写/删除）上采样成功响应（lessons list + board list 两工具），
 * 每响应同时验证双支：①JSON-RPC result 顶层无 orch_memory 键；②content[0].text
 * 解析 JSON 无 orch_md 键。任一支回潮（旧 piggyback 复活）即红。
 * 1 腿双支口径（impl-plan §2 W2）：单 ck.ok，条件=双支 && ×四响应全清。
 */
export async function scenSync01to05() {
  const R6 = subRoot("r-sync");
  const orchMd = path.join(R6, "ORCH.md"); // §4.1：<存储根>/ORCH.md
  const s6 = startServer({ root: R6 });
  try {
    // JSON-RPC result 直取通道（双支同源：顶层附件面 + content 文本解析面）
    const rawCall = (name, args) => s6.request("tools/call", { name: PRE + name, arguments: args });
    // N9 双支判据：一响应同时无顶层 orch_memory 键 ∧ content JSON 无 orch_md 键
    const noPush = (r) => {
      const res = r && r.result;
      const noTop = Boolean(res) && !("orch_memory" in res);
      let noContent = false;
      try {
        noContent =
          Boolean(res) &&
          Array.isArray(res.content) &&
          res.content[0] &&
          typeof res.content[0].text === "string" &&
          !("orch_md" in JSON.parse(res.content[0].text));
      } catch {
        /* content 不可解析=视同脏（双支不成立） */
      }
      return { ok: noTop && noContent, noTop, noContent };
    };

    // ---- 三态生命周期采样：出现 → 改写（bytes+mtimeMs 双因子越过）→ 删除
    fs.writeFileSync(
      orchMd,
      "<!-- orch-memory ver=1 updated=2026-10-22T08:00:00.000Z -->\n# ORCH.md — 主控记忆\n## 常驻\n- N9PROBE 初始装载行\n",
    );
    const a1 = noPush(await rawCall("lessons", { action: "list" }));
    await new Promise((res) => setTimeout(res, 100)); // NTFS mtime 粒度余量（CACHE-06a 同族口径）
    fs.writeFileSync(
      orchMd,
      "<!-- orch-memory ver=2 updated=2026-10-22T09:00:00.000Z -->\n# ORCH.md — 主控记忆\n## 常驻\n- N9PROBE 改写后的行\n",
    );
    const a2 = noPush(await rawCall("lessons", { action: "list" }));
    fs.unlinkSync(orchMd);
    const a3 = noPush(await rawCall("lessons", { action: "list" }));
    const a4 = noPush(await rawCall("board", { action: "list" })); // 第二工具采样（旧 piggyback 对全部成功工具附着）
    ck.ok(
      "N9 ORCH 拆除负向钉（防回潮）：ORCH.md 出现/改写/删除三态生命周期 + lessons/board 两工具的成功响应——顶层无 orch_memory 键 ∧ content 无 orch_md 键（1 腿双支）",
      a1.ok && a2.ok && a3.ok && a4.ok,
      { initial: a1, changed: a2, removed: a3, boardList: a4 },
    );
  } finally {
    s6.close();
  }
}

/* ============ 场景 6b（v1.6 W2 退役空壳）：SYNC-06..09 原域 ============ */
/*!
 * v1.3 W2 曾在此载 SYNC-06..09（content 面第三 surfacing 四腿）——v1.6 W2 随
 * content 键注入拆除**退役**（design §2.5；N9 负向钉承接防回潮职能）。函数体
 * 保留空壳=入口 crv8-memory.mjs import/调用接线零触（入口不在本波 scope）。
 */
export async function scenSync06to09() {
  /* 退役空壳：无腿。 */
}

/* ============ 场景 6c：SYNC-20/21 零触保留（pack 帽值句渲染，root r-caps） ============ */
/*!
 * v1.3 W4 (E) 曾在此载 SYNC-15..19（ORCH.md 注入帽截断面五腿）——v1.6 W2 随
 * piggyback 注入拆除**退役**；SYNC-20/21 **零触保留**（design §2.5：固定包 RULES
 * 帽值句渲染=保留消费面）。帽两键经 readGleanCfg（junk 回落+缺省常量源）进
 * materializeGleanPack 渲染——glean 面零触预判的 server 侧承载（M-2 功能面；
 * GL-20 同源消费 brief.cfg）。cfg 读贯穿（L-9 禁进程级缓存）语义不变。
 * 默认路径回归由 SYNC-20 承载（cfg 无帽键 → 逐字「帽 120 行/10KB」）。
 */
export async function scenSyncW4Caps() {
  const R6c = subRoot("r-caps");
  const MEM6c = path.join(R6c, "orchestrator-memory"); // 临时根缺省重定向落点
  const cfg6c = path.join(MEM6c, "glean.cfg.json");
  const s6c = startServer({ root: R6c });
  try {
    const rawCall = (name, args) => s6c.request("tools/call", { name: PRE + name, arguments: args });

    // ---- SYNC-20：pack 帽值句默认渲染回归——cfg 无帽键 → 固定包 RULES 仍逐字「帽 120 行/10KB」
    fs.mkdirSync(MEM6c, { recursive: true }); // spawn 竞态防御（GLEAN-01a 同款）
    fs.writeFileSync(cfg6c, JSON.stringify({ idle_hours: 0, new_events: 1 }));
    writeJsonl(path.join(R6c, "memory", "lessons.jsonl"), [
      {
        v: 1,
        id: "l-20261101-w4a001",
        ts: "2026-01-01T00:00:00.000Z",
        // updated_at 取当下：防 housekeep 衰减退役把行转 retired、扰动 due 真值（G2 前例）
        updated_at: new Date().toISOString(),
        mission_id: null,
        worker: "t",
        type: "pitfall",
        trigger: "W4PROBE 触发行",
        lesson: "",
        fix: "W4PROBE 修正行",
        confidence: 0.9,
        hits: 5,
        status: "active",
        refs: [],
        superseded_by: null,
        counter_refs: [],
        note: null,
      },
    ]);
    const pack6c = path.join(MEM6c, "glean-pack.md");
    let r = await rawCall("lessons", { action: "list" });
    const dueA = r.result && r.result.orch_memory && r.result.orch_memory.glean;
    const packRawA = fs.existsSync(pack6c) ? fs.readFileSync(pack6c, "utf8") : "";
    ck.ok(
      "SYNC-20 pack 帽值句默认渲染回归：cfg 无帽键 → due 物化固定包 RULES 逐字「帽 120 行/10KB」（与 W4 前字节等价）",
      Boolean(dueA) && dueA.due === true && packRawA.includes("帽 120 行/10KB"),
      { due: Boolean(dueA) && dueA.due, packLen: packRawA.length },
    );

    // ---- SYNC-21：pack 帽值句随 cfg 渲染（M-2 机械验证腿）——写 cfg 上调 → 重物化 pack
    //      → 断言新帽值入 RULES 文本且缺省句消失（不同步此处=opt-in 上调被静默打回）
    fs.rmSync(pack6c, { force: true });
    fs.writeFileSync(cfg6c, JSON.stringify({ idle_hours: 0, new_events: 1, orch_md_max_lines: 30, orch_md_max_bytes: 20480 }));
    r = await rawCall("lessons", { action: "list" });
    const dueB = r.result && r.result.orch_memory && r.result.orch_memory.glean;
    const packRawB = fs.existsSync(pack6c) ? fs.readFileSync(pack6c, "utf8") : "";
    ck.ok(
      "SYNC-21 pack 帽值句随 cfg 渲染：cfg 上调 30 行/20480B → 重物化固定包 RULES「帽 30 行/20KB」且缺省句消失（M-2 机械验证腿）",
      Boolean(dueB) && dueB.due === true && packRawB.includes("帽 30 行/20KB") && !packRawB.includes("帽 120 行/10KB"),
      { due: Boolean(dueB) && dueB.due, packLen: packRawB.length },
    );
  } finally {
    s6c.close();
  }
}
