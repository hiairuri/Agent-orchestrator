// @module crv8-memory/stage
/*!
 * suites/crv8-memory/stage.mjs —— ORCHTEMP 暂存与批晋升场景（v1.3 W1 拆分，自
 *   crv8-memory.mjs 原样搬运）：GLEAN-05 §5 stage 写入形状与候选流转（场景11）/
 *   GLEAN-05l..q v1.1 W1 §5.1 promote_batch 事务化（场景11b）。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, subRoot, writeJsonl, readJsonl, readLessons, readPack, approx2, resultText, startServer, PRE, DEFAULT_SERVER, PLUGIN_DIR } from "./shared.mjs";
import { familySource } from "../../harness/source-family.mjs";

/* ============ 场景 11：GLEAN-05（§5 stage 写入形状与 ORCHTEMP 候选流转，root r-stage1） ============ */
export async function scenGlean05() {
  const R12 = subRoot("r-stage1");
  const MEM12 = path.join(R12, "orchestrator-memory");
  const brief12 = path.join(MEM12, "glean-brief.json");
  fs.mkdirSync(MEM12, { recursive: true });
  // 门槛全开（never gleaned → idle ∞ > 0；new_events=0）→ 任意调用即 due，供 orchtemp_pending 流转观察
  fs.writeFileSync(path.join(MEM12, "glean.cfg.json"), JSON.stringify({ idle_hours: 0, new_events: 0 }));
  const s12 = startServer({ root: R12 });
  try {
    const rawCall = (name, args) => s12.request("tools/call", { name: PRE + name, arguments: args });
    // ---- GLEAN-05a/b/c：写入形状（source=orchestrator/candidate/conf=0/hits=0）
    const st51 = await s12.call("lessons", {
      action: "stage",
      type: "env-fact",
      trigger: "ST5TRIG 触发一\n第二行",
      fix: "ST5FIX 修正一",
      lesson: "ST5 单句教训",
      mission_id: "m-stage5",
      note: "pin: AGENTS.md",
    });
    const st51j = resultText(st51);
    ck.ok(
      "GLEAN-05a stage 响应：ok:true + 新 id + status=candidate + source=orchestrator",
      st51.isError !== true && st51j.ok === true && /^l-\d{8}-[0-9a-f]{6}$/.test(String(st51j.id)) && st51j.status === "candidate" && st51j.source === "orchestrator",
      st51j,
    );
    const row51 = readLessons(R12).find((l) => l.id === st51j.id);
    ck.ok(
      "GLEAN-05b 落库形状：source=orchestrator/status=candidate/confidence=0/hits=0/scope=project/worker=coordinator + note 摆放提示 + refs=[mission]",
      Boolean(row51) && row51.source === "orchestrator" && row51.status === "candidate" && row51.confidence === 0 && row51.hits === 0 && row51.scope === "project" && row51.worker === "coordinator" && row51.note === "pin: AGENTS.md" && Array.isArray(row51.refs) && row51.refs[0] === "m-stage5",
      row51,
    );
    ck.ok(
      "GLEAN-05c escape 先于截断：trigger 换行写为 ␤（写侧纪律，库保持单行性质）",
      Boolean(row51) && row51.trigger.includes("␤") && !row51.trigger.includes("\n"),
      row51 && row51.trigger,
    );

    // ---- GLEAN-05d/e：type 缺省 pitfall（§5 签名无 type，报告候选同款）；坏 type/空 trigger 严格报错
    const st52 = await s12.call("lessons", { action: "stage", trigger: "ST5TRIG2 缺省类型", fix: "ST5FIX2" });
    const row52 = readLessons(R12).find((l) => String(l.trigger || "").includes("ST5TRIG2"));
    ck.ok(
      "GLEAN-05d type 缺省 pitfall（§5 签名无 type，沿报告候选先例）",
      st52.isError !== true && Boolean(row52) && row52.type === "pitfall" && row52.source === "orchestrator",
      row52 && { type: row52.type, source: row52.source },
    );
    const st5Bad = await s12.call("lessons", { action: "stage", type: "nope", trigger: "X5", fix: "Y5" });
    const st5Empty = await s12.call("lessons", { action: "stage", trigger: "   ", fix: "Y5" });
    ck.ok(
      "GLEAN-05e 坏 type / 空 trigger → isError（add 级严格，§5「沿 add 语义」）",
      st5Bad.isError === true && st5Empty.isError === true,
      { bad: st5Bad.text.slice(0, 80), empty: st5Empty.text.slice(0, 80) },
    );

    // ---- GLEAN-05g：不参与注入——纯 stage 库（尚无 active）→ LESSONS 节整体不出现（CR-04 回归性确认，§5）
    await s12.call("context_pack", { mission_id: "m-stage5-pack", title: "纯暂存包", task: "ST5TRIG ST5TRIG2 命中词齐全" });
    const pack52 = readPack(R12, "m-stage5-pack");
    ck.ok(
      "GLEAN-05g candidate 不参与注入：纯 stage 库 pack 无 LESSONS 节（无需额外过滤，整节不出现）",
      Boolean(pack52) && !pack52.includes("## LESSONS"),
      pack52 && pack52.split("\n").filter((l) => l.startsWith("## ")),
    );

    // ---- GLEAN-05f：不做 findMergeTarget——同键 active 在库仍独立成条（归并是归敛消费时的事）
    await s12.call("lessons", { action: "add", type: "pitfall", trigger: "ST5MERGE 合并键触发", fix: "ST5MERGE 合并键修正" });
    const st5Before = readLessons(R12).find((l) => l.status === "active" && String(l.trigger || "").includes("ST5MERGE"));
    const st53 = await s12.call("lessons", { action: "stage", type: "pitfall", trigger: "ST5MERGE 合并键触发", fix: "ST5MERGE 合并键修正" });
    const st5After = readLessons(R12).find((l) => l.status === "active" && String(l.trigger || "").includes("ST5MERGE"));
    const st53Row = readLessons(R12).find((l) => l.id === resultText(st53).id);
    ck.ok(
      "GLEAN-05f 不合并：active 原 hits/confidence 不动 + stage 独立成 candidate 新条（同键不归并）",
      st53.isError !== true && st5After.hits === st5Before.hits && st5After.confidence === st5Before.confidence && Boolean(st53Row) && st53Row.status === "candidate" && st53Row.source === "orchestrator",
      { before: st5Before && { hits: st5Before.hits, conf: st5Before.confidence }, after: st5After && { hits: st5After.hits, conf: st5After.confidence }, staged: st53Row && st53Row.status },
    );
    // token 命中的 staged 条目仍不渲染（active 同键渲染、candidate 兄弟条被排除）
    await s12.call("context_pack", { mission_id: "m-stage5-pack2", title: "同键对照包", task: "ST5MERGE 合并键触发" });
    const pack522 = readPack(R12, "m-stage5-pack2");
    ck.ok(
      "GLEAN-05g2 staged 条不渲染：active 同键入选（LESSONS 节在）而 staged 兄弟条 id 不出现",
      Boolean(pack522) && pack522.includes("## LESSONS") && pack522.includes(String(st5Before.id)) && !pack522.includes(String(resultText(st53).id)) && !pack522.includes(String(st51j.id)),
      pack522 && pack522.split("\n").filter((l) => l.startsWith("- [")),
    );

    // ---- GLEAN-05h：ORCHTEMP 候选流转——due brief orchtemp_pending 收录 stage 条、不含 report 候选
    await s12.call("board", { action: "upsert", mission: { id: "m-stage5-rep", title: "对照上报 mission" } });
    await s12.call("report", {
      mission_id: "m-stage5-rep",
      worker: "w-stage5",
      kind: "done",
      summary: "对照候选上报",
      lessons: [{ type: "pitfall", trigger: "ST5REP 对照候选触发", fix: "ST5REP 修正" }],
    });
    const repRow52 = readLessons(R12).find((l) => String(l.trigger || "").includes("ST5REP"));
    let r52 = await rawCall("lessons", { action: "list" });
    const due52 = r52.result && r52.result.orch_memory && r52.result.orch_memory.glean;
    const brief52 = fs.existsSync(brief12) ? JSON.parse(fs.readFileSync(brief12, "utf8")) : null;
    ck.ok(
      "GLEAN-05h ORCHTEMP 流转：due 放行且 brief.orchtemp_pending 恰含 stage 条（source=orchestrator 专属过滤，report 候选不入）",
      Boolean(due52) && due52.due === true && Boolean(brief52) && Array.isArray(brief52.orchtemp_pending) && brief52.orchtemp_pending.includes(st51j.id) && brief52.orchtemp_pending.includes(resultText(st52).id) && Boolean(repRow52) && !brief52.orchtemp_pending.includes(repRow52.id),
      { due: due52, pending: brief52 && brief52.orchtemp_pending, repRow: repRow52 && repRow52.id },
    );

    // ---- GLEAN-05i/j：retire 消费=置状态，内容不变（红线①），消费后退出 ORCHTEMP
    const st51Before = readLessons(R12).find((l) => l.id === st51j.id);
    const ret52 = await s12.call("lessons", {
      action: "retire",
      id: st51j.id,
      reason: "glean: → 项目视图 ORCH.md §常驻 #3", // v1.7.0 W1 场景注记：双视图域词汇（消费落点=项目视图）
    });
    const st51After = readLessons(R12).find((l) => l.id === st51j.id);
    ck.ok(
      "GLEAN-05i retire 消费=置状态：status=retired + note=视图指针，trigger/fix/lesson/type 逐字节不变（红线①不删内容）",
      ret52.isError !== true && st51After.status === "retired" && st51After.note === "glean: → 项目视图 ORCH.md §常驻 #3" && st51After.trigger === st51Before.trigger && st51After.fix === st51Before.fix && st51After.lesson === st51Before.lesson && st51After.type === st51Before.type,
      { before: st51Before && { trigger: st51Before.trigger, fix: st51Before.fix }, after: st51After && { status: st51After.status, note: st51After.note } },
    );
    r52 = await rawCall("lessons", { action: "list" });
    const brief522 = JSON.parse(fs.readFileSync(brief12, "utf8"));
    ck.ok(
      "GLEAN-05j 消费后流转：orchtemp_pending 退出该 id 且条目仍在库（留存非删除）",
      Array.isArray(brief522.orchtemp_pending) && !brief522.orchtemp_pending.includes(st51j.id) && Boolean(readLessons(R12).find((l) => l.id === st51j.id)),
      brief522.orchtemp_pending,
    );

    // ---- GLEAN-05k：§9.4 工具 schema 描述行逐字在案 + action 枚举含 stage/promote_batch（W3 任务①收口；v1.1 W1 B2 扩 promote_batch）
    //（描述行内 source="orchestrator" 在 server.mjs 字面量中带 \" 转义—— grep 取无反斜杠的
    //  首尾两个逐字片段 + 枚举行，三段同钉）
    // v1.3 切分重基（修复轮 C）：server 读取面走族 helper（薄入口+模块族拼接——schema 描述行与
    // 枚举已迁 mcp/server-registry.mjs），断言与期望值零改动。
    // v1.6.1 P-W1 改判（R1-01，m-20261105-100000-v161w1）：lessons stage 行 CJK 英文化
    //（v1.6.1 design §5.1/OPEN-3 主案 a）——need 串同步改英文新句，与 server-registry 新字面
    // 逐字一致；改判登记 tests/assertions/v0.11.x.md A-v0110-PO-W3-02（§0 2026-11-05 条）+
    // tests/assertions/v1.6.1.md §W1；防漂移互检=A-v0161-N3②（po-static 三方互检）；枚举段零触。
    const srvSrc52 = familySource(PLUGIN_DIR, path.join("mcp", "server.mjs"));
    ck.ok(
      "GLEAN-05k §9.4 逐字稿落 schema（v1.6.1 P-W1 英文化改判）：stage 描述行首尾片段逐字在案 + action 枚举含 stage/promote_batch",
      srvSrc52.includes("stage: coordinator-side staging (write-only staging area; writes source=") &&
        srvSrc52.includes("candidate/confidence=0): no merge, no injection; consumed by the memory-gleaning agent") &&
        srvSrc52.includes("(gleaner). trigger/fix required.") &&
        srvSrc52.includes('["list", "add", "promote", "promote_batch", "retire", "stage"]'),
      null,
    );
  } finally {
    s12.close();
  }
}

/* ============ 场景 11b：GLEAN-05l..q（v1.1 W1 §5.1 promote_batch 事务化，root r-batch1） ============ */
export async function scenPromoteBatch() {
  const R16 = subRoot("r-batch1");
  const lib16 = path.join(R16, "memory", "lessons.jsonl");
  const gLib16 = path.join(R16, "orchestrator-memory", "memory", "lessons.jsonl");
  const now16 = new Date().toISOString();
  const seed16 = (over) => ({
    v: 1,
    ts: "2026-01-01T00:00:00.000Z",
    updated_at: now16,
    mission_id: null,
    worker: "t",
    lesson: "",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
    scope: "project",
    ...over,
  });
  writeJsonl(lib16, [
    seed16({ id: "l-20260101-b7a001", type: "pitfall", trigger: "BATCHA 批内新建触发", fix: "BATCHA 修正", confidence: 0, hits: 0, status: "candidate" }),
    seed16({ id: "l-20260101-b7b002", type: "pitfall", trigger: "BATCHB 矛盾晋升触发", fix: "BATCHB 修正", confidence: 0, hits: 0, status: "candidate" }),
    seed16({ id: "l-20260101-b7m003", type: "error-fix", trigger: "BATCHM 批内合并触发", fix: "BATCHM 修正", confidence: 0.6, hits: 1, status: "active" }),
    seed16({ id: "l-20260101-b7c004", type: "error-fix", trigger: "BATCHM 批内合并触发", fix: "BATCHM 修正", confidence: 0, hits: 0, status: "candidate" }),
    seed16({ id: "l-20260101-b7d005", type: "preference", trigger: "BATCHD 单条兼容触发", fix: "BATCHD 修正", confidence: 0, hits: 0, status: "candidate" }),
    seed16({ id: "l-20260101-b7e006", type: "env-fact", trigger: "BATCHE 矛盾靶触发", fix: "BATCHE 修正", confidence: 0.8, hits: 2, status: "active" }),
    seed16({ id: "l-20260101-b7f007", type: "pitfall", trigger: "BATCHF 全端批触发", fix: "BATCHF 修正", confidence: 0, hits: 0, status: "candidate" }),
  ]);
  const s16 = startServer({ root: R16 });
  try {
    await s16.call("lessons", { action: "list" }); // 启动副作用（名册/目录）落地
    const row16 = (id) => readLessons(R16).find((l) => l.id === id);

    // ---- GLEAN-05l：合法批（A 新建 + C 合并）一次调用全落 + 逐条结果/汇总
    const b1 = resultText(await s16.call("lessons", { action: "promote_batch", ids: ["l-20260101-b7a001", "l-20260101-b7c004"] }));
    const a16 = row16("l-20260101-b7a001");
    const c16 = row16("l-20260101-b7c004");
    const m16 = row16("l-20260101-b7m003");
    ck.ok(
      "GLEAN-05l 合法批全落：A 新建 active + C 合并进 M（行 retired/note 溯源，M hits 1→2 conf 0.6→0.7）+ 响应 count/results/summary",
      b1.ok === true && b1.count === 2 && Array.isArray(b1.results) && b1.results.length === 2 &&
        b1.summary && b1.summary.total === 2 && b1.summary.merged === 1 && b1.summary.activated === 1 &&
        Boolean(a16) && a16.status === "active" && a16.confidence === 0.6 && a16.hits === 1 &&
        Boolean(c16) && c16.status === "retired" && c16.note === "auto: merged into l-20260101-b7m003" &&
        Boolean(m16) && m16.hits === 2 && approx2(m16.confidence) === 0.7 &&
        b1.results.some((r) => r.id === "l-20260101-b7a001" && r.ok === true && r.merged === false && r.target === "project") &&
        b1.results.some((r) => r.id === "l-20260101-b7c004" && r.ok === true && r.merged === true && r.merged_into === "l-20260101-b7m003"),
      { b1, a: a16 && a16.status, c: c16 && c16.status, m: m16 && { hits: m16.hits, conf: m16.confidence } },
    );

    // ---- GLEAN-05m：非法混批 → 整批 isError + 库字节零变更（不存在的 id / 坏 refinement 两腿）
    const beforeBad = fs.readFileSync(lib16, "utf8");
    const badMissing = await s16.call("lessons", { action: "promote_batch", ids: ["l-20260101-b7d005", "l-20260101-missing"] });
    const badRefine = await s16.call("lessons", {
      action: "promote_batch",
      ids: ["l-20260101-b7d005", { id: "l-20260101-b7b002", type: "moon" }],
    });
    ck.ok(
      "GLEAN-05m 中途败整批拒零写入：不存在的 id / 坏 refinement 均 isError 且 lessons.jsonl 逐字节不变（D 仍 candidate，无半态）",
      badMissing.isError === true && String(badMissing.text).includes("missing") &&
        badRefine.isError === true && String(badRefine.text).includes("invalid type") &&
        fs.readFileSync(lib16, "utf8") === beforeBad &&
        row16("l-20260101-b7d005").status === "candidate" &&
        row16("l-20260101-b7b002").status === "candidate",
      { missing: String(badMissing.text).slice(0, 120), refine: String(badRefine.text).slice(0, 120) },
    );

    // ---- GLEAN-05n：单条 promote 并行兼容（响应形状零变化：无 target 键的 project 形）
    const single16 = resultText(await s16.call("lessons", { action: "promote", id: "l-20260101-b7d005" }));
    ck.ok(
      "GLEAN-05n 单条 promote 并行兼容：D candidate→active，响应仍 {ok,id,status,merged,confidence,hits} 且无 target/standard 键",
      single16.ok === true && single16.id === "l-20260101-b7d005" && single16.status === "active" && single16.merged === false &&
        approx2(single16.confidence) === 0.6 && single16.hits === 1 && !("target" in single16) && !("standard" in single16) &&
        row16("l-20260101-b7d005").status === "active",
      single16,
    );

    // ---- GLEAN-05o：批 target=global 腿（B 晋升全端新行；项目源条原地不动）
    const bRaw16 = fs.readFileSync(lib16, "utf8").split("\n").find((l) => l.includes('"l-20260101-b7b002"'));
    const b2 = resultText(await s16.call("lessons", { action: "promote_batch", ids: [{ id: "l-20260101-b7b002", target: "global" }] }));
    const gRow16 = fs.existsSync(gLib16) && b2.results ? readJsonl(gLib16).find((l) => l.id === b2.results[0].result_id) : null;
    ck.ok(
      "GLEAN-05o 批 target=global：逐条覆盖生效（新行 scope=global/source=promote）+ 项目源条逐字节不动 + 单次全端落盘",
      b2.ok === true && b2.results[0].target === "global" && b2.results[0].merged === false &&
        Boolean(gRow16) && gRow16.scope === "global" && gRow16.source === "promote" && gRow16.status === "active" &&
        fs.readFileSync(lib16, "utf8").split("\n").find((l) => l.includes('"l-20260101-b7b002"')) === bRaw16,
      { b2: b2.results, gRow: gRow16 && { id: gRow16.id, scope: gRow16.scope, source: gRow16.source } },
    );

    // ---- GLEAN-05p：contradicts 逐条语义（批内对象覆盖；E 置 superseded 指回 B 的晋升结果）
    const b3 = resultText(await s16.call("lessons", { action: "promote_batch", ids: [{ id: "l-20260101-b7b002", contradicts: "l-20260101-b7e006" }] }));
    const e16 = row16("l-20260101-b7e006");
    ck.ok(
      "GLEAN-05p 批内 contradicts：B 晋升后 E 置 superseded 且 superseded_by=晋升结果 id（content 原样保留）",
      b3.ok === true && b3.results[0].contradicts === "l-20260101-b7e006" && b3.summary.contradicting === 1 &&
        Boolean(e16) && e16.status === "superseded" && e16.superseded_by === b3.results[0].result_id &&
        e16.trigger === "BATCHE 矛盾靶触发" && e16.fix === "BATCHE 修正",
      e16 && { status: e16.status, superseded_by: e16.superseded_by },
    );

    // ---- GLEAN-05q：一次落盘源面钉（批分支内各库恰一次 save；不逐条 save）
    // v1.3 切分重基（修复轮 C）：server 读取面走族 helper（薄入口+模块族拼接——promote_batch/retire
    // 分支对已迁 mcp/server-lessons.mjs 同模块内保序），断言与期望值零改动。
    const srvSrc16 = familySource(PLUGIN_DIR, path.join("mcp", "server.mjs"));
    const batchBranch = srvSrc16.slice(
      srvSrc16.indexOf('if (action === "promote_batch")'),
      srvSrc16.indexOf('if (action === "retire")'),
    );
    ck.ok(
      "GLEAN-05q 一次落盘源面钉：promote_batch 分支 saveLessons(list)×1 ∧ saveGlobalLessons(globalList)×1（循环内零逐条 save）",
      (batchBranch.match(/saveLessons\(list\)/g) || []).length === 1 &&
        (batchBranch.match(/saveGlobalLessons\(globalList\)/g) || []).length === 1 &&
        (batchBranch.match(/saveLessons\(/g) || []).length === 1 &&
        (batchBranch.match(/saveGlobalLessons\(/g) || []).length === 1,
      { len: batchBranch.length },
    );
  } finally {
    s16.close();
  }
}
