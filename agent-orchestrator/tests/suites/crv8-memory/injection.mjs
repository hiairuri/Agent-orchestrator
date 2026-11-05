// @module crv8-memory/injection
/*!
 * suites/crv8-memory/injection.mjs —— 注入选材面场景（v1.3 W1 拆分，自 crv8-memory.mjs
 *   原样搬运）：INJ-01/03/06a（场景1）/ INJ-02 常量锁（场景2）/ THR-01 阈值落值
 *   （场景2b）/ INJ-04/05 降权闭环（场景3）/ INJ-07 死码清理（场景4）/ INJ-08 基线对拍（场景5）。
 */
import fs from "node:fs";
import path from "node:path";
import {
  ck,
  subRoot,
  readPack,
  readLessons,
  approx2,
  resultText,
  startServer,
  startServerX,
  DEFAULT_SERVER,
  HOOKS_SRC,
  ASSERT_DOC,
  blankMission,
  writeBoardSeed,
  exportFileFromGit,
  repoRoot,
  PLUGIN_DIR,
} from "./shared.mjs";
import { familySource } from "../../harness/source-family.mjs";

/* ============ 场景 1：INJ-01 / INJ-03 / INJ-06a（root r-inj01） ============ */
export async function scenInj01to06a() {
  const R1 = subRoot("r-inj01");
  const s1 = startServer({ root: R1 });
  try {
    // ---- INJ-03c（CR-04 性质）：空库 → LESSONS 节整体不出现
    await s1.call("context_pack", { mission_id: "m-empty", title: "空库包", task: "空库回归任务" });
    const packEmpty = readPack(R1, "m-empty");
    ck.ok("INJ-03c 空库 pack 无 LESSONS 节（CR-04 节整体不出现）", Boolean(packEmpty) && !packEmpty.includes("## LESSONS"), packEmpty && packEmpty.split("\n").filter((l) => l.startsWith("## ")));

    // 无命中填充条目在库 → 无 token 交集同样整节不出现
    await s1.call("lessons", { action: "add", type: "env-fact", trigger: "无关触发词XYZQQ", fix: "无关修正" });
    await s1.call("context_pack", { mission_id: "m-nomatch", title: "无命中包", task: "完全不相关任务码" });
    const packNoMatch = readPack(R1, "m-nomatch");
    ck.ok("INJ-03c 无 token 交集 pack 无 LESSONS 节（性质回归）", Boolean(packNoMatch) && !packNoMatch.includes("## LESSONS"), packNoMatch && packNoMatch.split("\n").filter((l) => l.startsWith("## ")));

    // ---- INJ-01a：error-fix 单类命中 → 入选不滤除
    const addEf = await s1.call("lessons", {
      action: "add",
      type: "error-fix",
      trigger: "AP1PROBE 构建失败排查",
      fix: "清理缓存后重跑构建",
    });
    const efId = resultText(addEf).id;
    ck.ok("INJ-01a 前置 lessons add ok（error-fix）", addEf.isError !== true && Boolean(efId), addEf.text.slice(0, 80));
    const taskEf = "AP1PROBE 构建失败排查任务";
    await s1.call("context_pack", { mission_id: "m-ef", title: "单类命中包", task: taskEf });
    const packEf = readPack(R1, "m-ef");
    const efLine = (packEf || "").split("\n").find((l) => l.startsWith("- [error-fix·"));
    ck.ok("INJ-01a 仅 error-fix 命中 → 入选不被滤除", Boolean(efLine), packEf && packEf.split("\n").filter((l) => l.startsWith("## LESSONS") || l.startsWith("- [")));

    // ---- INJ-03a/b：id 段渲染 + 每行增量 ≤24B
    ck.ok(
      "INJ-03a lessonLine 含 [type·id] 段（l-YYYYMMDD-6hex）",
      Boolean(efLine) && /^- \[error-fix·l-\d{8}-[0-9a-f]{6}\] 触发：.+\n  修正：/.test(packEf.slice(packEf.indexOf(efLine))),
      efLine,
    );
    const efBase = efLine.replace(/·l-\d{8}-[0-9a-f]{6}/, "");
    const incBytes = efLine.length - efBase.length;
    ck.ok("INJ-03b id 段每行增量 ≤24B（实测 " + incBytes + "B）", incBytes >= 1 && incBytes <= 24, { incBytes, efLine });
    ck.ok("INJ-03b id 与库内条目一致（回引锚可达）", Boolean(efLine) && efLine.includes(`·${efId}]`), { efId, efLine });

    // ---- INJ-01b：同 overlap 等分 → 权重排序 error-fix 在 pitfall 前；两 type 均在（不滤除）
    await s1.call("lessons", { action: "add", type: "pitfall", trigger: "AP1PROBE 构建失败排查", fix: "清理缓存后重跑构建" });
    await s1.call("context_pack", { mission_id: "m-both", title: "双类命中包", task: taskEf });
    const packBoth = readPack(R1, "m-both");
    const iEf = (packBoth || "").indexOf("- [error-fix·");
    const iPf = (packBoth || "").indexOf("- [pitfall·");
    ck.ok("INJ-01b 两 type 均入选（加权不滤除）", iEf >= 0 && iPf >= 0, packBoth && packBoth.split("\n").filter((l) => l.startsWith("- [")));
    ck.ok("INJ-01b 等 overlap 等分时 error-fix（权重 1.0）排在 pitfall（0.9）前", iEf >= 0 && iPf >= 0 && iEf < iPf, { iEf, iPf });

    // ---- INJ-06a：scope/source 写入形状
    const rows1 = readLessons(R1);
    const toolRows = rows1.filter((l) => l.id === efId || l.type === "pitfall");
    ck.ok(
      "INJ-06a add 写 scope=project + source=add",
      toolRows.length >= 2 && toolRows.every((l) => l.scope === "project" && l.source === "add"),
      toolRows.map((l) => ({ id: l.id, scope: l.scope, source: l.source })),
    );
    // report(done, lessons) 候选行 → source=report（board upsert mission 无派发
    // token，避开 V6-09 fail-closed token 门；context_pack 铸发的 m-* 带 token）
    await s1.call("board", { action: "upsert", mission: { id: "m-cand", title: "候选上报 mission" } });
    const repDone = await s1.call("report", {
      mission_id: "m-cand",
      worker: "w-cand",
      kind: "done",
      summary: "候选教训上报",
      lessons: [{ type: "error-fix", trigger: "CANDPROBE 候选教训触发", fix: "候选教训修正" }],
    });
    const candRow = readLessons(R1).find((l) => String(l.trigger || "").includes("CANDPROBE"));
    ck.ok(
      "INJ-06a report 候选写 source=report + scope=project（status=candidate）",
      repDone.isError !== true && Boolean(candRow) && candRow.source === "report" && candRow.scope === "project" && candRow.status === "candidate",
      candRow && { source: candRow.source, scope: candRow.scope, status: candRow.status },
    );

    // ---- INJ-06a：读端容忍——存量行缺 scope/source 照常入选（缺省 project）+ 未知字段不炸
    const tolRow = {
      v: 1,
      id: "l-20260101-ffffff",
      ts: "2026-01-01T00:00:00.000Z",
      updated_at: new Date().toISOString(),
      mission_id: null,
      worker: "legacy",
      type: "env-fact",
      trigger: "TOLPROBE 未知字段容忍",
      lesson: "",
      fix: "容忍未知字段",
      confidence: 0.9,
      hits: 9,
      status: "active",
      refs: [],
      superseded_by: null,
      counter_refs: [],
      note: null,
      future_field: { unknown: true },
    };
    fs.appendFileSync(path.join(R1, "memory", "lessons.jsonl"), JSON.stringify(tolRow) + "\n");
    const listTol = resultText(await s1.call("lessons", { action: "list", status: "all", q: "TOLPROBE" }));
    ck.ok("INJ-06a 缺 scope 存量行 + 未知字段 → lessons list 不炸", (listTol.lessons || []).length === 1, listTol.lessons);
    await s1.call("context_pack", { mission_id: "m-tol", title: "容忍包", task: "TOLPROBE 未知字段容忍" });
    const packTol = readPack(R1, "m-tol");
    ck.ok(
      "INJ-06a 缺 scope 行照常入选（缺省 project 语义）",
      Boolean(packTol) && packTol.includes("- [env-fact·l-20260101-ffffff]"),
      packTol && packTol.split("\n").filter((l) => l.startsWith("- [")),
    );
  } finally {
    s1.close();
  }
}

/* ============ 场景 2：INJ-02（root r-inj02，手写库对照 fixture + 常量锁） ============ */
export async function scenInj02() {
  const R2 = subRoot("r-inj02");
  const nowIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - 40 * 86400000).toISOString();
  const baseRow = {
    v: 1,
    ts: nowIso,
    mission_id: null,
    worker: "t",
    type: "pitfall",
    trigger: "INJ2TOKEN 构建缓存损坏检测",
    lesson: "",
    fix: "INJ2TOKEN 重建缓存目录",
    confidence: 0.6,
    hits: 1,
    status: "active",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
  };
  // 同 trigger 同 overlap 同 type：唯一差异 = updated_at（score 衰减）。
  // FRESH score=0.6 ≥0.39 入选；OLD score=0.6×exp(-40/30)≈0.158 <0.39 落门
  // （v0.9 C5 落值 0.40→0.39 口径；判别行对照见 THR-01 场景）。
  const rows2 = [
    { ...baseRow, id: "l-20260101-aaa001", updated_at: nowIso },
    { ...baseRow, id: "l-20260101-aaa002", updated_at: oldIso },
  ];
  fs.mkdirSync(path.join(R2, "memory"), { recursive: true });
  fs.writeFileSync(path.join(R2, "memory", "lessons.jsonl"), rows2.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const s2 = startServer({ root: R2 });
  try {
    await s2.call("context_pack", { mission_id: "m-gate", title: "阈值门包", task: "INJ2TOKEN 阈值门回归验证" });
    const packGate = readPack(R2, "m-gate");
    ck.ok(
      "INJ-02 score<0.39 不入选（OLD≈0.158 落门）而达标行（0.60）入选；同 overlap 排除面只归阈值",
      Boolean(packGate) && packGate.includes("l-20260101-aaa001") && !packGate.includes("l-20260101-aaa002") && packGate.includes("## LESSONS"),
      packGate && packGate.split("\n").filter((l) => l.startsWith("- [")),
    );

    // 常量默认值锁定（双文件子串，沿 CFG-05 先例）：server.mjs 常量 + 断言登记文件
    // v1.3 切分重基（修复轮 C）：server 读取面走族 helper（薄入口+模块族拼接——常量已迁
    // mcp/server-lessons.mjs），断言与期望值零改动。
    const srvSrc = familySource(PLUGIN_DIR, path.join("mcp", "server.mjs"));
    const docSrc = fs.existsSync(ASSERT_DOC) ? fs.readFileSync(ASSERT_DOC, "utf8") : "";
    ck.ok("INJ-02 常量锁 server.mjs：INJECT_MIN_SCORE = 0.39 在位（v0.9 C5 落值）", /const INJECT_MIN_SCORE = 0\.39;/.test(srvSrc));
    ck.ok(
      "INJ-02 常量锁 server.mjs：LESSON_TYPE_WEIGHT 四值在位（error-fix 1.0 / pitfall 0.9 / env-fact 0.8 / preference 0.7）",
      srvSrc.includes('const LESSON_TYPE_WEIGHT = { "error-fix": 1.0, "pitfall": 0.9, "env-fact": 0.8, "preference": 0.7 };'),
    );
    ck.ok("INJ-02 常量锁登记面：v0.9.x.md 登记 INJECT_MIN_SCORE=0.39（防漂移第二文件，v0.9 W1 起改钉）", docSrc.includes("INJECT_MIN_SCORE=0.39"), ASSERT_DOC);
  } finally {
    s2.close();
  }
}

/* ============ 场景 2b：THR-01（v0.9 W1，root r-thr01，C5 阈值落值 0.40→0.39 三行对照） ============ */
export async function scenThr01() {
  const R2b = subRoot("r-thr01");
  const nowIso2b = new Date().toISOString();
  // MID 判别行：score≈0.395 ∈ [0.39, 0.40) —— 0.39 口径下入选，0.40 口径下必被排除
  //（新值生效的行为判别行）。score=0.6×exp(-days/30)=0.395 → days=30×ln(0.6/0.395)≈12.56。
  const midDays2b = 30 * Math.log(0.6 / 0.395);
  const midIso2b = new Date(Date.now() - midDays2b * 86400000).toISOString();
  const oldIso2b = new Date(Date.now() - 40 * 86400000).toISOString();
  const baseRow2b = {
    v: 1,
    ts: nowIso2b,
    mission_id: null,
    worker: "t",
    type: "pitfall",
    trigger: "",
    lesson: "",
    fix: "",
    confidence: 0.6,
    hits: 1,
    status: "active",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
  };
  // 三行 normKey 互异（trigger/fix 各带专属 token）：排除面只归阈值，与 normKey 去重正交。
  const rows2b = [
    { ...baseRow2b, id: "l-20260101-thr001", trigger: "THRFRESH 阈值新鲜行", fix: "THRFRESH 新鲜修正", updated_at: nowIso2b },
    { ...baseRow2b, id: "l-20260101-thr002", trigger: "THRMID 阈值判别行", fix: "THRMID 判别修正", updated_at: midIso2b },
    { ...baseRow2b, id: "l-20260101-thr003", trigger: "THROLD 阈值衰老行", fix: "THROLD 衰老修正", updated_at: oldIso2b },
  ];
  fs.mkdirSync(path.join(R2b, "memory"), { recursive: true });
  fs.writeFileSync(path.join(R2b, "memory", "lessons.jsonl"), rows2b.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const s2b = startServer({ root: R2b });
  try {
    await s2b.call("context_pack", { mission_id: "m-thr01", title: "C5 落值包", task: "THRFRESH THRMID THROLD 阈值落值对照验证" });
    const packThr = readPack(R2b, "m-thr01");
    ck.ok(
      "THR-01a 新值生效判别行：score≈0.395∈[0.39,0.40) 的 MID 行入选（0.40 口径下必被排除——A-v090-THR-01 行为对照）",
      Boolean(packThr) && packThr.includes("## LESSONS") && packThr.includes("l-20260101-thr002"),
      packThr && packThr.split("\n").filter((l) => l.startsWith("- [")),
    );
    ck.ok(
      "THR-01b 落门/入选对照更新（0.39 口径）：FRESH 0.60 入选、OLD≈0.158<0.39 落门不渲染",
      Boolean(packThr) && packThr.includes("l-20260101-thr001") && !packThr.includes("l-20260101-thr003"),
      packThr && packThr.split("\n").filter((l) => l.startsWith("- [")),
    );
    // 推导注记 v0.9 复算版在案（server.mjs 常量区注释：P25=0.4583 → ×0.85 ≈0.3895 → 圆整 0.39，界 [0.30,0.50]）
    // v1.3 切分重基（修复轮 C）：server 读取面走族 helper（薄入口+模块族拼接——推导注记随常量迁
    // mcp/server-lessons.mjs），断言与期望值零改动。
    const srvSrc2b = familySource(PLUGIN_DIR, path.join("mcp", "server.mjs"));
    ck.ok(
      "THR-01c 推导注记 v0.9 复算版在案：P25=0.4583 + ×0.85 + 圆整 0.39 + 界 [0.30, 0.50] + v0.9 recheck 锚",
      srvSrc2b.includes("P25=0.4583") && srvSrc2b.includes("× 0.85") && srvSrc2b.includes("round 0.39") && srvSrc2b.includes("[0.30, 0.50]") && /v0\.9 recheck/i.test(srvSrc2b),
      null,
    );
  } finally {
    s2b.close();
  }
}

/* ============ 场景 3：INJ-04 / INJ-05（root r-inj04，board 预种 mission） ============ */
export async function scenInj04_05() {
  const R3 = subRoot("r-inj04");
  const mids = ["m-d1", "m-d2", "m-d3", "m-d4", "m-d5", "m-d6", "m-n1", "m-n2", "m-n3"];
  writeBoardSeed(R3, mids.map((id) => blankMission({ id, title: "INJ04 " + id })));
  const s3 = startServer({ root: R3 });
  try {
    const addX = await s3.call("lessons", { action: "add", type: "pitfall", trigger: "MISSPROBE 误导教训", fix: "不要照做" });
    const xid = resultText(addX).id;
    const rowOf = () => readLessons(R3).find((l) => l.id === xid);

    // ---- INJ-05：守卫兼容（无 lesson_refs / 非数组 / 无意义 kind）→ 整体忽略零变化；
    //      响应面按 CR-04 条件键纪律——零降权时 lessons_demoted 等键整体不出现
    const rNone = resultText(await s3.call("report", { mission_id: "m-n1", worker: "w5", kind: "blocked", question: "q?", summary: "无 refs" }));
    let row = rowOf();
    ck.ok(
      "INJ-05a 无 lesson_refs 的 blocked report → 零降权零变化（条件键不出现）",
      !("lessons_demoted" in rNone) && !("lessons_refs_retired" in rNone) && !("lessons_refs_note" in rNone) && approx2(row.confidence) === 0.6 && Array.isArray(row.counter_refs) && row.counter_refs.length === 0,
      { respKeys: Object.keys(rNone), row: row && { conf: row.confidence, cr: row.counter_refs } },
    );
    const rBad = resultText(await s3.call("report", { mission_id: "m-n2", worker: "w5", kind: "blocked", question: "q?", summary: "非数组 refs", lesson_refs: xid }));
    row = rowOf();
    ck.ok(
      "INJ-05b lesson_refs 非数组（Array.isArray 守卫）→ 整体忽略",
      !("lessons_demoted" in rBad) && approx2(row.confidence) === 0.6 && row.counter_refs.length === 0,
      { respKeys: Object.keys(rBad), row: row && { conf: row.confidence, cr: row.counter_refs } },
    );
    const rDone = resultText(await s3.call("report", { mission_id: "m-n3", worker: "w5", kind: "done", summary: "done 携带无意义", lesson_refs: [xid] }));
    row = rowOf();
    ck.ok(
      "INJ-05c done 携带 lesson_refs（仅 blocked/question 有意义）→ 忽略",
      !("lessons_demoted" in rDone) && approx2(row.confidence) === 0.6 && row.counter_refs.length === 0,
      { respKeys: Object.keys(rDone), row: row && { conf: row.confidence, cr: row.counter_refs } },
    );

    // ---- INJ-04：blocked 回引降权闭环（5 个 mission 逐次 −0.1 至触底 → housekeep 退役）
    const expectConf = [0.5, 0.4, 0.3, 0.2];
    for (let i = 1; i <= 4; i++) {
      const r = resultText(await s3.call("report", { mission_id: `m-d${i}`, worker: "w4", kind: "blocked", question: "q?", summary: `回引 ${i}`, lesson_refs: [xid] }));
      row = rowOf();
      ck.ok(
        `INJ-04a 第 ${i} 次回引：confidence −0.1（=${expectConf[i - 1]}）+ counter_refs 记 mission m-d${i}`,
        r.lessons_demoted === 1 && row.status === "active" && approx2(row.confidence) === expectConf[i - 1] && row.counter_refs.includes(`m-d${i}`) && row.counter_refs.length === i,
        { resp: r.lessons_demoted, row: row && { conf: row.confidence, cr: row.counter_refs, st: row.status } },
      );
    }
    const r5 = resultText(await s3.call("report", { mission_id: "m-d5", worker: "w4", kind: "blocked", question: "q?", summary: "回引触底", lesson_refs: [xid] }));
    row = rowOf();
    ck.ok(
      "INJ-04b 触底（confidence=0.1 下限）+ ≥2 mission 回引 → housekeep 置 retired note=auto: lesson misses",
      r5.lessons_demoted === 1 && r5.lessons_refs_retired === 1 && row.status === "retired" && row.note === "auto: lesson misses" && approx2(row.confidence) === 0.1 && row.counter_refs.length === 5,
      { resp: { d: r5.lessons_demoted, ret: r5.lessons_retired }, row: row && { conf: row.confidence, cr: row.counter_refs, st: row.status, note: row.note } },
    );

    // ---- INJ-04 补腿：未知 id 跳过带注（不炸 blocked report）；已触底条目 floor 不再下探
    const rUk = resultText(
      await s3.call("report", { mission_id: "m-d6", worker: "w4", kind: "blocked", question: "q?", summary: "含未知 id", lesson_refs: [xid, "l-19700101-000000"] }),
    );
    row = rowOf();
    ck.ok(
      "INJ-04c 未知 id 跳过并回注（lessons_refs_note），其余照常降权",
      rUk.lessons_demoted === 1 && !("lessons_refs_retired" in rUk) && typeof rUk.lessons_refs_note === "string" && rUk.lessons_refs_note.includes("l-19700101-000000"),
      { resp: { d: rUk.lessons_demoted, note: rUk.lessons_refs_note } },
    );
    ck.ok(
      "INJ-04d 触底条目再回引：confidence 停在下限 0.1（floor），counter_refs 去重记 m-d6",
      approx2(row.confidence) === 0.1 && row.counter_refs.includes("m-d6"),
      row && { conf: row.confidence, cr: row.counter_refs },
    );
  } finally {
    s3.close();
  }
}

/* ============ 场景 4：INJ-07（死码清理源码静态面，无 server） ============ */
export async function scenInj07() {
  // v1.3 切分重基（修复轮 C）：server 读取面走族 helper（薄入口+模块族拼接），负向死码扫描面=族全文本。
  const srvSrc = familySource(PLUGIN_DIR, path.join("mcp", "server.mjs"));
  const hookSrc = fs.readFileSync(HOOKS_SRC, "utf8");
  ck.ok("INJ-07a server.mjs topLessonsBrief 零命中（死码已删）", !srvSrc.includes("topLessonsBrief"));
  ck.ok("INJ-07b server.mjs BRIEF_TOP_K/BRIEF_MAX_CHARS 零命中（随死码删）", !srvSrc.includes("BRIEF_TOP_K") && !srvSrc.includes("BRIEF_MAX_CHARS"));
  const digestLine = hookSrc.split("\n").find((l) => l.includes("lessons digest"));
  ck.ok("INJ-07c session-start lessons digest 注释无悬空「twin of server.mjs」", Boolean(digestLine) && !digestLine.includes("twin of server.mjs"), digestLine);
  ck.ok("INJ-07d session-start 本地 topLessonsBrief 唯一副本实现仍在（top-3 初始装载不变）", hookSrc.includes("function topLessonsBrief") && hookSrc.includes("const BRIEF_TOP_K = 3"));
}

/* ============ 场景 5：INJ-08（CR-04 性质锁：与 0.7.1 基线逐字节对拍） ============ */
export async function scenInj08() {
  const SCRATCH = subRoot("scratch-baseline");
  let baseline = null;
  try {
    baseline = exportFileFromGit("f0142a8", repoRoot(), "plugins/agent-orchestrator/mcp/server.mjs", SCRATCH);
    ck.ok("INJ-08a 0.7.1 基线导出（git f0142a8）", Boolean(baseline), baseline);
  } catch (e) {
    ck.ok("INJ-08a 0.7.1 基线导出（git f0142a8）", false, String(e));
  }
  if (baseline) {
    // 前置（W2 重跑口径）：0.8 侧随 --memory-root 注入空全端目录环境（无全端库、
    // 无 ORCH.md 临时根）；0.7.1 基线不识别该旗标（parseArgValue 只寻 --root，忽略）。
    const T71 = subRoot("t71");
    const T80 = subRoot("t80");
    const MEM80 = subRoot("mem80-empty");
    // 归一化：token（两代 server 各自随机）+ lessonLine id 段（v0.8 唯一预期增量，
    // 替换为空串后与 0.7.1 的 `[type]` 形状逐字节对齐——增量本体由 INJ-08c 钉死）
    // + W4 PO 案 A 激进重建（2026-10-24，A-v0110-PO-W4，先例 v0.6 裁决 A）：缺省模板
    //   CONTRACT 规则块/围栏节头/阻塞处置句变字——新旧两形各自归一为规范形（预期增量掩码；
    //   理由逐条见 v0.11.x.md §0；新文案本体由 A-v0110-PO-W4-01/02 静态钉）。
    // + v1.1 W4（A1/Q5a，A-v110-W4-A1-06）：CONTRACT 节头括注「派发 prompt 头部→尾块」
    //   措辞级字节变更——同型掩码先行（DESIGN §6.1/§6.2）。
    // v1.6 W3a（裁定 A 扩 scope +1，m-20261104-053000-w16-3a；主控 mailbox answer 同文）：
    //   INJ-08b/08d/08f 三腿 normState 重基——STATE 恒在节+RETURN 指针态文案两预期增量掩码
    //   （pack-materialize W3 F3 先例同形）：STATE 节剥至规范形（含前导空行归一，两侧对齐——
    //   0.7.1 基线无 STATE 节、现行包节恒在）+RETURN 节规范形；重基沿革=0.7.1 f0142a8 基线
    //   对拍语义保持（其余仍逐字节），STATE 节本体与 RETURN 新文案由 po-static N2/W4 静态钉+
    //   crv2-pack N2 行为腿承载；scoping 计数动态值随掩码剥除。台账 v1.6.0.md §W3a-4 逐腿沿革
    //   +组包漏誊注记（design §3.2 W3 本预判基线重基，impl-plan W3a scope 漏誊本独立场景文件）。
    const norm = (s) =>
      String(s)
        .replace(/\[token\] [0-9a-f]{4,32}/g, "[token] X")
        .replace(/·l-\d{8}-[0-9a-f]{6}/g, "")
        .replace(/进度与结果一律用 (mcp__plugin_agent-orchestrator_orch__report) 上报[；。]/g, "REPORT-CHANNEL $1")
        .replace(/kind ∈ \{milestone, blocked, question, done\}。\nsummary ≤ 200 字。\nkind=done 必带 artifacts 路径。/g, "REPORT-KIND summary artifacts")
        .replace(/kind ∈ \{milestone, blocked, question, done\}；summary ≤ 200 字；done 必带 artifacts 路径[^\n]*/g, "REPORT-KIND summary artifacts")
        .replace(/受阻\/目标矛盾\/必败门禁：立即 report\(kind=blocked, question=…\)[^\n]*/g, "RULES-BLOCKED")
        .replace(/也出现在派发 prompt (?:头部|尾块)/g, "也出现在派发 prompt 尾块")
        .replace(/## CONTEXT（[^）]*）/g, "## CONTEXT 节头")
        .replace(/## LESSONS（[^）]*）/g, "## LESSONS 节头")
        .replace(/\n*## STATE（态势面[\s\S]*?(?=\n## )/, "\n")
        .replace(/## RETURN[\s\S]*$/, "## RETURN-SECTION（v1.6 W3a 指针态文案掩码）");
    const s71 = startServer({ serverPath: baseline, root: T71 });
    const s80 = startServerX({ root: T80, args: ["--memory-root", MEM80] });
    try {
      // —— 子例 A：空库（无 LESSONS 节）逐字节
      const argsA = { mission_id: "m-byte", title: "字节对拍", task: "字节对拍回归任务", read_first: ["docs/a.md"], rules: ["R1"], upstream_context: "上游对拍行" };
      await s71.call("context_pack", argsA);
      await s80.call("context_pack", argsA);
      const pA71 = readPack(T71, "m-byte");
      const pA80 = readPack(T80, "m-byte");
      ck.ok("INJ-08b 空库 context_pack 与 0.7.1 逐字节一致（token 归一化）", Boolean(pA71) && Boolean(pA80) && norm(pA71) === norm(pA80));

      // —— 子例 B：单条命中 lesson——唯一预期增量 = lessonLine id 段
      const addB = { action: "add", type: "pitfall", trigger: "BYTEPROBE 对拍触发词", fix: "对拍修正动作" };
      await s71.call("lessons", addB);
      await s80.call("lessons", addB);
      const argsB = { mission_id: "m-byte2", title: "字节对拍二", task: "BYTEPROBE 对拍任务" };
      await s71.call("context_pack", argsB);
      await s80.call("context_pack", argsB);
      const pB71 = readPack(T71, "m-byte2");
      const pB80 = readPack(T80, "m-byte2");
      ck.ok(
        "INJ-08c 命中场景：0.7.1 渲染无 id 段、v0.8 渲染含 id 段（预期增量恰为 id）",
        Boolean(pB71) && Boolean(pB80) && pB71.includes("- [pitfall] 触发：") && !pB71.includes("·l-") && pB80.includes("- [pitfall·l-"),
      );
      ck.ok("INJ-08d 命中场景归一化 id 段后与 0.7.1 逐字节一致（CR-04 性质锁）", Boolean(pB71) && Boolean(pB80) && norm(pB71) === norm(pB80));

      // —— 子例 C（v1.3 W3 INJ-08 负判据新验证腿）：无全端库 + gate due 物化（views 块+
      //    mkdir 兜底）之后——①mkdir 只建目录不建文件（无 AGENTS.md 空壳/无全端
      //    lessons.jsonl：空壳 mtime 入 digest 指纹=假信号，design §3.3 不建空壳机理）；
      //    ②注入面仍与 0.7.1 基线字节等价（mkdir/views 不入注入面）。
      fs.writeFileSync(path.join(MEM80, "glean.cfg.json"), JSON.stringify({ idle_hours: 0, new_events: 0, busy_channel_events: 0 }));
      await s80.call("lessons", { action: "list" }); // due → materializeGleanBrief（views 块 + mkdir memory/ 兜底）
      const memLibC = path.join(MEM80, "memory");
      ck.ok(
        "INJ-08e due 物化 mkdir 兜底：只建 memory/ 目录不建文件（无全端 AGENTS.md 空壳/无全端 lessons.jsonl）",
        fs.existsSync(memLibC) && !fs.existsSync(path.join(MEM80, "AGENTS.md")) && !fs.existsSync(path.join(memLibC, "lessons.jsonl")),
        { memDir: fs.existsSync(memLibC), agentsMd: fs.existsSync(path.join(MEM80, "AGENTS.md")), lib: fs.existsSync(path.join(memLibC, "lessons.jsonl")) },
      );
      const argsC = { mission_id: "m-byte3", title: "字节对拍三", task: "字节对拍回归任务三" };
      await s71.call("context_pack", argsC);
      await s80.call("context_pack", argsC);
      const pC71 = readPack(T71, "m-byte3");
      const pC80 = readPack(T80, "m-byte3");
      ck.ok(
        "INJ-08f 无全端库 due 物化后 context_pack 仍与 0.7.1 字节等价（归一化；mkdir/views 零入注入面）",
        Boolean(pC71) && Boolean(pC80) && norm(pC71) === norm(pC80),
      );
    } finally {
      s71.close();
      s80.close();
    }
  }
}
