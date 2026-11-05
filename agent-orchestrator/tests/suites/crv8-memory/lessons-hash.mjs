// @module crv8-memory/lessons-hash
/*!
 * suites/crv8-memory/lessons-hash.mjs —— lessons 哈希读面+token 写闸场景（v1.6 W4 新建，design §2.4/§3.3 N4；
 *   proposal P7 同波微机制之一）。本场景承载 N4 全腿组：
 *   ①哈希三腿：无新短答（LH-01b/02）/有新增量全文（LH-03）/基线前滚幂等（LH-04/05）；
 *   ②写闸负向双支：携 token 五写 action（add/stage/promote/promote_batch/retire）一律拒（LH-06 双支）；
 *   ③反向钉伴腿：无 token 全功能不变（legacy 响应形零漂，LH-07）/首调建基线+state 落位
 *   `<存储根>/memory/lessons-read-state.json`（LH-01a）/第二 reader 独立基线（LH-08）。
 *   读面契约：list 增可选 token 参（键=reader id：worker=派发 token/主控=coord-session id）；
 *   判定域=两库 active 全集（promoted 集——候选 stage 不进集即零哈希迁移，LH-02 承载）；
 *   增量=updated_at>基线 ts ∧ id∉seen_ids（id/type/trigger/lesson/fix/scope 全文，全端优先去重）；
 *   哈希=id 排序 {id,updated_at} 投影 sha256（合并/晋升改 updated_at 即变哈希）；
 *   哈希相等=短答零写快速路径；registry schema 不在本波写集——token 经 args 直传（handler 直调）。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, subRoot, startServerX } from "./shared.mjs";

export async function scenLessonsHash() {
  const R = subRoot("r-lhash");
  const STATE = path.join(R, "memory", "lessons-read-state.json");
  const s = startServerX({ root: R });
  try {
    const call = (args) => s.call("lessons", args);

    // ---- LH-01a：首调（无基线）=建立基线+短答；state 文件落位存储根 memory/
    await call({ action: "add", type: "pitfall", trigger: "基线种子", fix: "首调前置", lesson: "种子正文" });
    const r1 = await call({ action: "list", token: "tokA" });
    ck.ok(
      "LH-01a 首调建基线：短答（mode:short∧message「无新增教训（基线 <ts>，在册 1 条）」）∧ 基线 state 落位 <存储根>/memory/lessons-read-state.json（v:1/readers[tokA]={base_hash,base_ts,seen_ids} 三键）",
      r1.isError === false && r1.json && r1.json.mode === "short" &&
        /^无新增教训（基线 \d{4}-\d{2}-\d{2}T.+，在册 1 条）$/.test(r1.json.message ?? "") &&
        fs.existsSync(STATE),
      { json: r1.json, exists: fs.existsSync(STATE) },
    );
    const st1 = fs.readFileSync(STATE, "utf8");
    const stObj = JSON.parse(st1);
    ck.ok(
      "LH-01a-baseline state 结构：{v:1, readers:{tokA:{base_hash(64hex), base_ts(ISO), seen_ids:[1 条 id]}}}",
      stObj.v === 1 && stObj.readers && typeof stObj.readers.tokA?.base_hash === "string" &&
        stObj.readers.tokA.base_hash.length === 64 && Array.isArray(stObj.readers.tokA.seen_ids) &&
        stObj.readers.tokA.seen_ids.length === 1,
      { keys: Object.keys(stObj.readers.tokA ?? {}) },
    );

    // ---- LH-01b：无新复读=短答零写（state 字节不动——哈希相等快速路径）
    const r2 = await call({ action: "list", token: "tokA" });
    const st2 = fs.readFileSync(STATE, "utf8");
    ck.ok(
      "LH-01b 无新短答：复读 mode:short∧同 message（基线 ts 不变）∧ state 字节零写（哈希相等快速路径）",
      r2.json?.mode === "short" && r2.json?.message === r1.json.message && st1 === st2,
      { message: r2.json?.message, zeroWrite: st1 === st2 },
    );

    // ---- LH-02：stage 候选零哈希迁移（候选不进 promoted 集）→ 复读仍短答零写
    await call({ action: "stage", trigger: "ORCHTEMP 随手记", fix: "候选不进集", note: "pin: none" });
    const r3 = await call({ action: "list", token: "tokA" });
    const st3 = fs.readFileSync(STATE, "utf8");
    ck.ok(
      "LH-02 stage 零哈希迁移：stage（candidate, conf=0）不改 promoted 集 → 复读 mode:short∧state 零写（判定域=active 全集口径腿）",
      r3.json?.mode === "short" && st2 === st3,
      { mode: r3.json?.mode, zeroWrite: st2 === st3 },
    );

    // ---- LH-03：有新增量全文（无 token add → 携 token 读见增量；id/type/trigger/lesson/fix/scope 全文域）
    await call({ action: "add", type: "error-fix", trigger: "增量腿触发", fix: "增量腿修正", lesson: "增量腿正文" });
    const r4 = await call({ action: "list", token: "tokA" });
    const inc = r4.json?.new_lessons ?? [];
    ck.ok(
      "LH-03 有新增量：mode:increment∧new_lessons 恰 1∧全文域齐全（id/type/trigger/lesson/fix/scope=project）∧message「新增教训 1 条」",
      r4.json?.mode === "increment" && inc.length === 1 &&
        typeof inc[0].id === "string" && inc[0].type === "error-fix" &&
        inc[0].trigger === "增量腿触发" && inc[0].fix === "增量腿修正" &&
        inc[0].lesson === "增量腿正文" && inc[0].scope === "project" &&
        r4.json?.message === "新增教训 1 条",
      { message: r4.json?.message, got: inc[0] },
    );

    // ---- LH-04：基线前滚幂等（增量读后复读=短答）
    const r5 = await call({ action: "list", token: "tokA" });
    ck.ok(
      "LH-04 基线前滚幂等：增量读后复读 mode:short（{base_hash,base_ts,seen_ids} 前滚——N4 反向钉第一腿）",
      r5.json?.mode === "short",
      { message: r5.json?.message },
    );

    // ---- LH-05：promote 晋升（active 集迁移：候选转正 updated_at 刷新）→ 增量恰 1 恰晋升 id
    const cand = (await call({ action: "list", status: "candidate" })).json?.lessons?.[0]?.id;
    const rp = await call({ action: "promote", id: cand });
    const r6 = await call({ action: "list", token: "tokA" });
    ck.ok(
      "LH-05 promote 进集增量：promote ok∧携 token 复读 mode:increment∧恰 1 恰晋升 id（stage→promote 流转端到端）",
      rp.json?.ok === true && r6.json?.mode === "increment" &&
        (r6.json?.new_lessons ?? []).some((l) => l.id === rp.json?.id),
      { promoted: rp.json?.id, got: (r6.json?.new_lessons ?? []).map((l) => l.id) },
    );

    // ---- LH-06：写闸负向双支（携 token 五写 action 一律拒；双支=add/stage 一支+promote/promote_batch/retire 一支）
    const gateMsg = "携 token 只读";
    const gA1 = await call({ action: "add", token: "tokA", type: "pitfall", trigger: "t", fix: "f" });
    const gA2 = await call({ action: "stage", token: "tokA", trigger: "t", fix: "f" });
    const gB1 = await call({ action: "promote", token: "tokA", id: "whatever" });
    const gB2 = await call({ action: "promote_batch", token: "tokA", ids: ["x"] });
    const gB3 = await call({ action: "retire", token: "tokA", id: "whatever" });
    ck.ok(
      "LH-06a 写闸负向支 A：携 token add/stage isError∧报错含「携 token 只读」（add 带合法载荷也被拒——闸在参数校验前）",
      gA1.isError === true && gA2.isError === true &&
        (gA1.text ?? "").includes(gateMsg) && (gA2.text ?? "").includes(gateMsg),
      { e1: (gA1.text ?? "").slice(0, 40), e2: (gA2.text ?? "").slice(0, 40) },
    );
    ck.ok(
      "LH-06b 写闸负向支 B：携 token promote/promote_batch/retire isError∧同报错字面（五写 action 全覆盖——闸先于 id/target 校验）",
      gB1.isError === true && gB2.isError === true && gB3.isError === true &&
        (gB1.text ?? "").includes(gateMsg) && (gB2.text ?? "").includes(gateMsg) &&
        (gB3.text ?? "").includes(gateMsg),
      { e1: (gB1.text ?? "").slice(0, 40), e2: (gB2.text ?? "").slice(0, 40), e3: (gB3.text ?? "").slice(0, 40) },
    );

    // ---- LH-07：无 token 全功能不变（legacy 响应形零漂+写 action 正常——对照腿）
    const rLegacy = await call({ action: "list", status: "all" });
    const rAddOk = await call({ action: "add", type: "preference", trigger: "无token对照", fix: "全功能不变" });
    ck.ok(
      "LH-07 无 token 全功能不变：legacy list 形零漂（{total,lessons} 两键在∧无 mode/new_lessons 键）∧无 token add ok（主控通道）",
      rLegacy.json && "total" in rLegacy.json && "lessons" in rLegacy.json &&
        !("mode" in rLegacy.json) && !("new_lessons" in rLegacy.json) &&
        rAddOk.json?.ok === true,
      { keys: Object.keys(rLegacy.json ?? {}) },
    );

    // ---- LH-08：第二 reader 独立基线（per-reader map 键=reader id）
    const r8 = await call({ action: "list", token: "tokB" });
    const stObj8 = JSON.parse(fs.readFileSync(STATE, "utf8"));
    ck.ok(
      "LH-08 第二 reader 独立基线：tokB 首调 mode:short（tokA 基线不串扰）∧readers 双键在册",
      r8.json?.mode === "short" && stObj8.readers.tokA && stObj8.readers.tokB,
      { readers: Object.keys(stObj8.readers ?? {}) },
    );
  } finally {
    s.close();
  }
}
