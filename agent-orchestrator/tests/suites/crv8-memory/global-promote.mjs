// @module crv8-memory/global-promote
/*!
 * suites/crv8-memory/global-promote.mjs —— 双库与晋升场景（v1.3 W1 拆分，自
 *   crv8-memory.mjs 原样搬运）：INJ-06b 双库读端去重 + HOST-01b + §7.2 全端节开关
 *   （root r-inj6b）/ GLEAN-07/08 promote target=global 两分支 + 双库去重终验（场景13）。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, subRoot, writeJsonl, readJsonl, readPack, normPath, approx2, resultText, startServer, DEFAULT_SERVER, PLUGIN_DIR } from "./shared.mjs";
import { familySource } from "../../harness/source-family.mjs";

/* ============ 场景 12：INJ-06b + HOST-01b + §7.2 全端节（root r-inj6b；原文件本块无标题注释，块序沿用拆前） ============ */
export async function scenInj06bHost() {
  const R10 = subRoot("r-inj6b");
  const MEM10 = path.join(R10, "orchestrator-memory");
  const gLib10 = path.join(MEM10, "memory", "lessons.jsonl");
  const nowIso10 = new Date().toISOString();
  const hotRow = (id, type, trigger, fix, scope) => ({
    v: 1,
    id,
    ts: "2026-01-01T00:00:00.000Z",
    updated_at: nowIso10,
    mission_id: null,
    worker: "t",
    type,
    trigger,
    lesson: "",
    fix,
    confidence: 0.9,
    hits: 5,
    status: "active",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
    scope,
  });
  // 全端库：G1（与项目 P1 同 merge key）+ G2（全端独有）；项目库：P1（G1 孪生）+ P2（独有）
  writeJsonl(gLib10, [
    hotRow("l-20260101-gggg01", "pitfall", "PROBE6B 缓存损坏重建", "重建缓存目录", "global"),
    hotRow("l-20260101-gggg02", "env-fact", "UNIQ6B 全端独有事实", "全端独有修正", "global"),
  ]);
  writeJsonl(path.join(R10, "memory", "lessons.jsonl"), [
    hotRow("l-20260101-pppp01", "pitfall", "PROBE6B 缓存损坏重建", "重建缓存目录", "project"),
    hotRow("l-20260101-pppp02", "pitfall", "OWN6B 项目独有触发", "项目独有修正", "project"),
  ]);
  fs.writeFileSync(path.join(MEM10, "AGENTS.md"), "# GLOBAL MEMORY\n- GLOBALSEC 全端稳定事实行\n");
  const s10 = startServer({ root: R10 });
  try {
    await s10.call("context_pack", {
      mission_id: "m-6b",
      title: "双库去重包",
      task: "PROBE6B 缓存损坏重建 与 OWN6B 项目独有触发 与 UNIQ6B 全端独有事实",
    });
    const pack10 = readPack(R10, "m-6b");
    const bullets = () => (pack10 || "").split("\n").filter((l) => l.startsWith("- ["));
    ck.ok(
      "INJ-06b-1 双库合并选材：全端 G1/G2 与项目独有 P2 同入选",
      Boolean(pack10) && pack10.includes("l-20260101-gggg01") && pack10.includes("l-20260101-gggg02") && pack10.includes("l-20260101-pppp02"),
      bullets(),
    );
    ck.ok(
      "INJ-06b-2 normKey 去重全端优先：同 merge key 的项目孪生 P1 被全端 G1 遮蔽",
      Boolean(pack10) && pack10.includes("l-20260101-gggg01") && !pack10.includes("l-20260101-pppp01"),
      bullets(),
    );
    // 只数 LESSONS 条目行（TASK 回显正文同样含该串，不能整包计数）
    const g1Bullets = (pack10.match(/^- \[pitfall·l-20260101-gggg01\]/gm) || []).length;
    ck.ok("INJ-06b-3 同 merge key 恰渲染一次（无双显，LESSONS 条目行计数）", g1Bullets === 1, { g1Bullets });

    // ---- contradicts 不跨库：全端 id 在项目库寻址失败，全端库字节零变化
    // （trigger/fix 取不匹配键——防 findMergeTarget 先合并短路、到不了 contradicts 臂）
    const gLibBefore = fs.readFileSync(gLib10, "utf8");
    const contra = await s10.call("lessons", {
      action: "add",
      type: "pitfall",
      trigger: "CROSS6B 不匹配键",
      fix: "CROSS6B 修正",
      contradicts: "l-20260101-gggg01",
    });
    ck.ok(
      "INJ-06b-4 contradicts 不跨库：全端 id 项目库寻址失败（target not found），协议面 isError",
      contra.isError === true && String(contra.text).includes("not found"),
      contra.text.slice(0, 140),
    );
    ck.ok("INJ-06b-5 contradicts 不跨库：全端库字节零变化（读端/写端均不触他库）", fs.readFileSync(gLib10, "utf8") === gLibBefore);

  // ---- HOST-01b（v0.9 W3 C6 条件腿）：宿主用户级注入面源码复核结论=存在
  //      （designs/agent-orchestrator-v0.9-C6-findings.md：~/.zcode/AGENTS.md 默认进
  //      子代理上下文组装链，scope="user"）→ pack_global_section 缺省翻 false（v0.9
  //      DESIGN §8 决策规则），全端节改显式 opt-in。m-6b 包即「无 cfg」环境（AGENTS.md
  //      已在位、glean.cfg.json 尚未写出）。
  // v1.3 切分重基（修复轮 C）：server 读取面走族 helper（薄入口+模块族拼接——readGleanCfg 缺省
  // 字面量已迁 mcp/server-memory.mjs），断言与期望值零改动。
  const srvSrc10 = familySource(PLUGIN_DIR, path.join("mcp", "server.mjs"));
  ck.ok(
    "HOST-01b-a 源码锁：readGleanCfg 缺省字面量 pack_global_section:false（cfg 键翻转锁；C6 复核结论=宿主用户级注入面存在，防双通道注入；v1.3 W1 尾字面随 busy_channel_events 键扩位；v1.3 W4 尾字面随 orch_md_max_lines/bytes 帽两键扩位）",
    srvSrc10.includes("lock_stale_hours: 1.5, pack_global_section: false, busy_channel_events: 40, orch_md_max_lines: ORCH_MD_MAX_LINES, orch_md_max_bytes: ORCH_MD_MAX_BYTES }"),
    null,
  );
  ck.ok(
    "HOST-01b-b 缺省关行为腿：无 glean.cfg.json（缺省=false）+ 全端 AGENTS.md 在位 → GLOBAL MEMORY 节整体不出现（LESSONS 命中不受累，CR-04）",
    Boolean(pack10) && !pack10.includes("## GLOBAL MEMORY") && pack10.includes("## LESSONS"),
    pack10 && pack10.split("\n").filter((l) => l.startsWith("## ")),
  );
  // ---- §7.2 全端节：显式 opt-in 注入 + 节序 + 开关
  fs.writeFileSync(path.join(MEM10, "glean.cfg.json"), JSON.stringify({ pack_global_section: true }));
  await s10.call("context_pack", { mission_id: "m-6bon", title: "开关开启包", task: "PROBE6B 缓存损坏重建" });
  const pack10on = readPack(R10, "m-6bon");
  ck.ok(
    "SEC72-a pack_global_section:true 显式开 → 全端 AGENTS.md 注入 GLOBAL MEMORY 节（数据栅栏句 + 正文行）",
    Boolean(pack10on) && pack10on.includes("## GLOBAL MEMORY（全端子代理记忆") && pack10on.includes("GLOBALSEC 全端稳定事实行"),
    pack10on && pack10on.split("\n").filter((l) => l.startsWith("## ")),
  );
  const iL10 = pack10on.indexOf("## LESSONS");
  const iG10 = pack10on.indexOf("## GLOBAL MEMORY");
  const iR10 = pack10on.indexOf("## RETURN");
  ck.ok("SEC72-b 节序：LESSONS < GLOBAL MEMORY < RETURN", iL10 >= 0 && iL10 < iG10 && iG10 > 0 && iG10 < iR10, { iL10, iG10, iR10 });
    fs.writeFileSync(path.join(MEM10, "glean.cfg.json"), JSON.stringify({ pack_global_section: false }));
    await s10.call("context_pack", { mission_id: "m-6bswitch", title: "开关关闭包", task: "PROBE6B 缓存损坏重建" });
    const packSwitch = readPack(R10, "m-6bswitch");
    ck.ok(
      "SEC72-c pack_global_section:false → GLOBAL MEMORY 节整体不出现（LESSONS 命中不受累，CR-04）",
      Boolean(packSwitch) && !packSwitch.includes("## GLOBAL MEMORY") && packSwitch.includes("## LESSONS"),
      packSwitch && packSwitch.split("\n").filter((l) => l.startsWith("## ")),
    );
  } finally {
    s10.close();
  }
}

/* ============ 场景 13：GLEAN-07/08（W5 §6.7 promote target=global + 双库去重终验
 *               + 跨项目 fixture〔项目库+全端库+第二注册项目见证库并存〕，root r-promote） ============ */
export async function scenGlean07_08() {
  const R13 = subRoot("r-promote");
  const MEM13 = path.join(R13, "orchestrator-memory"); // 临时根缺省重定向落点
  const gLib13 = path.join(MEM13, "memory", "lessons.jsonl");
  const lib13 = path.join(R13, "memory", "lessons.jsonl");
  // 跨项目 fixture：第二注册项目 R13B——只在名册挂行 + 见证库放同 normKey candidate，
  // 供晋升标准分支一（跨项目复现≥2）的 server 侧扫描命中（只读见证，永不直写）
  const R13B = subRoot("r-promote-b");
  const lib13B = path.join(R13B, ".zcode", "orchestrator", "memory", "lessons.jsonl");
  const now13 = new Date().toISOString();
  const old13 = new Date(Date.now() - 10 * 86400000).toISOString();
  const seedRow = (over) => ({
    v: 1,
    ts: "2026-01-01T00:00:00.000Z",
    mission_id: null,
    worker: "t",
    lesson: "",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
    ...over,
  });
  // 项目库五源条：PM（合并源·candidate，与全端 GM 同 merge key）/PN（强条源·active，
  // conf 0.9/hits 3/龄 10d → score≈1.35 ≥0.7 过强条阈值）/PC（跨项目源·candidate，
  // R13B 见证库有同键 candidate 孪生）/PW（两分支皆不满足对照）/PDEF（缺省晋升对照）
  writeJsonl(lib13, [
    seedRow({ id: "l-20260101-g5m001", updated_at: now13, type: "pitfall", trigger: "G5MERGE 全端已有键触发", fix: "G5MERGE 全端已有键修正", confidence: 0, hits: 0, status: "candidate" }),
    seedRow({ id: "l-20260101-g5n002", updated_at: old13, type: "pitfall", trigger: "G5STRONG 单库强条触发", fix: "G5STRONG 单库强条修正", confidence: 0.9, hits: 3, status: "active" }),
    seedRow({ id: "l-20260101-g5c003", updated_at: now13, type: "error-fix", trigger: "G5CROSS 跨项目复现触发", fix: "G5CROSS 跨项目复现修正", confidence: 0, hits: 0, status: "candidate" }),
    seedRow({ id: "l-20260101-g5w004", updated_at: now13, type: "preference", trigger: "G5WEAK 无证据触发", fix: "G5WEAK 无证据修正", confidence: 0.3, hits: 1, status: "candidate" }),
    seedRow({ id: "l-20260101-g5d005", updated_at: now13, type: "pitfall", trigger: "G5DEF 缺省晋升触发", fix: "G5DEF 缺省晋升修正", confidence: 0, hits: 0, status: "candidate" }),
  ]);
  // 全端库既有条 GM（与 PM 同 merge key——合并腿靶子，带原 mission ref 验证并集保留）
  writeJsonl(gLib13, [
    seedRow({ id: "l-20260101-g5gm00", updated_at: now13, type: "pitfall", trigger: "G5MERGE 全端已有键触发", fix: "G5MERGE 全端已有键修正", confidence: 0.6, hits: 2, status: "active", refs: ["m-g5orig"], scope: "global" }),
  ]);
  // 见证库：PC 同键 candidate（含 candidate 计入复现，§6.7 分支一）
  writeJsonl(lib13B, [
    seedRow({ id: "l-20260101-g5cb01", updated_at: now13, type: "error-fix", trigger: "G5CROSS 跨项目复现触发", fix: "G5CROSS 跨项目复现修正", confidence: 0, hits: 0, status: "candidate", scope: "project" }),
  ]);
  const s13 = startServer({ root: R13 });
  try {
    await s13.call("lessons", { action: "list" }); // 等启动副作用（名册 upsert 本行）落地
    const rootId13 = fs.readFileSync(path.join(R13, "root-id"), "utf8").trim();
    // 名册追加第二项目行（名册非事件层允许登记面操作；启动只写本行，追加行此后保留）
    fs.appendFileSync(
      path.join(MEM13, "projects.jsonl"),
      JSON.stringify({ root_id: "f0f0f0f0f0f0f0f1", project_path: R13B, first_seen: now13, last_seen: now13, server_version: "0.8.0" }) + "\n",
    );
    const rawLineById = (file, lid) => fs.readFileSync(file, "utf8").split("\n").find((l) => l.includes(`"${lid}"`));
    const rowById = (file, lid) => readJsonl(file).find((l) => l.id === lid);
    const bullets13 = (pack) => (pack || "").split("\n").filter((l) => /^- \[/.test(l));

    // ---- G7-a/b/c：合并腿（全端 findMergeTarget 命中 → hits+1/confidence 提升/refs 并集 + 源条不动）
    const pmBefore = rawLineById(lib13, "l-20260101-g5m001");
    const pm7 = resultText(await s13.call("lessons", { action: "promote", id: "l-20260101-g5m001", target: "global" }));
    ck.ok(
      "G7-a 合并腿响应：merged:true + target=global + source_id + 命中全端条 GM（hits 2→3、conf 0.6→0.7）",
      pm7.ok === true && pm7.merged === true && pm7.target === "global" && pm7.source_id === "l-20260101-g5m001" && pm7.id === "l-20260101-g5gm00" && pm7.hits === 3 && approx2(pm7.confidence) === 0.7,
      pm7,
    );
    const gmAfter = rowById(gLib13, "l-20260101-g5gm00");
    ck.ok(
      "G7-b 合并腿回链并集：GM.refs 保留原 mission 且并入三元组（源条 id/源项目路径/root_id）各恰一次",
      Array.isArray(gmAfter.refs) && gmAfter.refs.includes("m-g5orig") && gmAfter.refs.includes("l-20260101-g5m001") && gmAfter.refs.some((x) => normPath(x) === normPath(R13)) && gmAfter.refs.filter((x) => x === rootId13).length === 1 && gmAfter.refs.filter((x) => x === "l-20260101-g5m001").length === 1,
      gmAfter && gmAfter.refs,
    );
    ck.ok(
      "G7-c 源条原地不动（合并腿）：PM 行逐字节不变且仍 candidate 于项目库",
      rawLineById(lib13, "l-20260101-g5m001") === pmBefore && rowById(lib13, "l-20260101-g5m001").status === "candidate",
      null,
    );

    // ---- G7-d/e/f：强条腿（单库强条证据分支 + 新建 scope=global + 回链三元组）
    const pnBefore = rawLineById(lib13, "l-20260101-g5n002");
    const pn7 = resultText(await s13.call("lessons", { action: "promote", id: "l-20260101-g5n002", target: "global" }));
    ck.ok(
      "G7-d 强条腿证据：branch=strong + eligible + strong.pass（score≥0.7/hits=3/龄≥7d）+ cross_project 不成立（count=1）",
      pn7.ok === true && Boolean(pn7.standard) && pn7.standard.branch === "strong" && pn7.standard.eligible === true && pn7.standard.strong.pass === true && pn7.standard.strong.hits === 3 && pn7.standard.strong.age_days >= 7 && Number(pn7.standard.strong.score) >= 0.7 && pn7.standard.cross_project.count === 1 && pn7.standard.cross_project.pass === false,
      pn7.standard,
    );
    const gn13 = rowById(gLib13, pn7.id);
    ck.ok(
      "G7-e 新建腿形状：scope=global/source=promote/status=active/conf=0.7/hits=1/worker=gleaner + refs 恰为回链三元组",
      Boolean(gn13) && gn13.scope === "global" && gn13.source === "promote" && gn13.status === "active" && gn13.confidence === 0.7 && gn13.hits === 1 && gn13.worker === "gleaner" && Array.isArray(gn13.refs) && gn13.refs.length === 3 && gn13.refs[0] === "l-20260101-g5n002" && normPath(gn13.refs[1]) === normPath(R13) && gn13.refs[2] === rootId13,
      gn13,
    );
    ck.ok(
      "G7-f 源条原地不动（新建腿）：PN 行逐字节不变且仍 active 于项目库",
      rawLineById(lib13, "l-20260101-g5n002") === pnBefore && rowById(lib13, "l-20260101-g5n002").status === "active",
      null,
    );

    // ---- G7-g：跨项目复现分支（名册第二项目库同 normKey candidate 命中 → count=2）
    const pc7 = resultText(await s13.call("lessons", { action: "promote", id: "l-20260101-g5c003", target: "global" }));
    ck.ok(
      "G7-g 跨项目复现分支证据：branch=cross-project + count=2（本库+见证库）+ others 指向 R13B（candidate 行计入）",
      pc7.ok === true && pc7.standard.branch === "cross-project" && pc7.standard.cross_project.count === 2 && pc7.standard.cross_project.pass === true && Array.isArray(pc7.standard.cross_project.others) && pc7.standard.cross_project.others.length === 1 && normPath(pc7.standard.cross_project.others[0]) === normPath(R13B),
      pc7.standard,
    );

    // ---- G7-h：两分支皆不满足 → 证据为否而工具面仍放行（§6.7 判定权在归敛，非 server 门）
    const pw7 = resultText(await s13.call("lessons", { action: "promote", id: "l-20260101-g5w004", target: "global" }));
    ck.ok(
      "G7-h 弱条对照：standard.eligible=false + branch=null（两分支皆不满足）且晋升照常完成（证据非门）",
      pw7.ok === true && Boolean(pw7.standard) && pw7.standard.eligible === false && pw7.standard.branch === null && pw7.standard.cross_project.pass === false && pw7.standard.strong.pass === false,
      pw7.standard,
    );

    // ---- G7-i/j：坏 target 报错 + 缺省 target 行为零变化（§8 兼容行「缺省 project=现行为逐字节一致」）
    const pBad13 = await s13.call("lessons", { action: "promote", id: "l-20260101-g5d005", target: "moon" });
    ck.ok(
      "G7-i 坏 target 严格报错（isError，allowed: project, global）",
      pBad13.isError === true && String(pBad13.text).includes("invalid target"),
      pBad13.text.slice(0, 100),
    );
    const gLibBefore13 = fs.readFileSync(gLib13, "utf8");
    const pd7 = resultText(await s13.call("lessons", { action: "promote", id: "l-20260101-g5d005" }));
    const pdRow13 = rowById(lib13, "l-20260101-g5d005");
    ck.ok(
      "G7-j 缺省 target 现行为零变化：本库 candidate→active、响应无 target/standard 键、全端库字节零变化",
      pd7.ok === true && pd7.status === "active" && pd7.merged === false && !("target" in pd7) && !("standard" in pd7) && pdRow13.status === "active" && fs.readFileSync(gLib13, "utf8") === gLibBefore13,
      pd7,
    );

    // ---- G7-k：schema 面（target 枚举 + promote 描述行跨项目晋升句在案）
    // v1.3 切分重基（修复轮 C）：server 读取面走族 helper（薄入口+模块族拼接——lessons schema
    // 描述行已迁 mcp/server-registry.mjs），断言与期望值零改动。
    const srvSrc13 = familySource(PLUGIN_DIR, path.join("mcp", "server.mjs"));
    ck.ok(
      "G7-k schema：lessons target 枚举 [project, global] + promote 描述行含跨项目晋升与回链句",
      srvSrc13.includes('enum: ["project", "global"]') && srvSrc13.includes('target=\\"global\\" 跨项目晋升全端库') && srvSrc13.includes("refs=[源条 id, 源项目路径, root_id]"),
      null,
    );

    // ---- G8-a/b/c：双库去重终验（晋升场景）+ 晋升后注入全端条可见 + 读端零写
    const libBeforePack13 = fs.readFileSync(lib13, "utf8");
    const gLibBeforePack13 = fs.readFileSync(gLib13, "utf8");
    await s13.call("context_pack", { mission_id: "m-g5pack", title: "晋升去重包", task: "G5STRONG 单库强条触发任务" });
    const pack13 = readPack(R13, "m-g5pack");
    ck.ok(
      "G8-a 晋升后注入可见：pack LESSONS 渲染全端新条（promoted id 在案——scope=global 行经双库合并入选）",
      Boolean(pack13) && pack13.includes("## LESSONS") && pack13.includes(`·${pn7.id}]`),
      bullets13(pack13),
    );
    ck.ok(
      "G8-b 双库去重全端优先（晋升场景终验）：同 normKey 项目源条 PN 被全端新条遮蔽（源 id 不渲染、晋升 id 恰渲染一次）",
      Boolean(pack13) && !pack13.includes("l-20260101-g5n002") && (pack13.match(new RegExp(`^- \\[pitfall·${pn7.id}\\]`, "gm")) || []).length === 1,
      bullets13(pack13),
    );
    ck.ok(
      "G8-c 读端零写：context_pack 后项目库与全端库字节零变化",
      fs.readFileSync(lib13, "utf8") === libBeforePack13 && fs.readFileSync(gLib13, "utf8") === gLibBeforePack13,
      null,
    );
  } finally {
    s13.close();
  }
}
