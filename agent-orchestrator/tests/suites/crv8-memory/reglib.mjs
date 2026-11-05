// @module crv8-memory/reglib
/*!
 * suites/crv8-memory/reglib.mjs —— 项目库登记与根外全端根场景（v1.3 W1 拆分，自
 *   crv8-memory.mjs 原样搬运）：REG-01 v0.9 W3 §9 C7 registry library_path + sibling
 *   扫描两腿（场景14）/ W3FIX saveGlobalLessons base 修复回归（场景15）。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, BASE, subRoot, writeJsonl, readJsonl, normPath, approx2, resultText, startServerX } from "./shared.mjs";

/* ============ 场景 14：REG-01（v0.9 W3 §9 C7 registry library_path + sibling 扫描
 *               两腿，roots r-reglib〔默认布局〕/ r-reglib-c〔自定义 --root sibling〕/
 *               r-reglib-legacy〔无 library_path 存量行 fixture〕） ============ */
export async function scenReg01() {
  const R14 = subRoot("r-reglib");
  // 共享名册/全端库落 R14 内（=临时根缺省重定向同位，显式钉死使两 server 确定性同根）。
  // 注：自定义 --memory-root 置项目根外（生产缺省 ~/.zcode/orchestrator-memory 同位）时
  // promote target=global 会被 atomicWriteFileSync 缺省 base=root 的越界门拒——W5 既有
  // 缺陷候选（saveGlobalLessons 未显式传 base=memoryRoot，名册 upsert 已传），不在本波
  // 断言面，已上报主控仲裁；本场景按 C7 限制原文取自定义 --root（存储根）腿。
  const M14 = path.join(R14, "orchestrator-memory");
  fs.mkdirSync(M14, { recursive: true });
  const reg14 = path.join(M14, "projects.jsonl");
  // 自定义 --root sibling：存储根刻意不在默认布局 <project>/.zcode/orchestrator 下
  // ——旧映射（registry 只有 project_path）对此类 sibling 不可见，正是 C7 要消的限制
  const C14 = subRoot("r-reglib-c");
  const libC14 = path.join(C14, "memory", "lessons.jsonl");
  const now14 = new Date().toISOString();
  const seedRow14 = (over) => ({
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
  // 自定义 root sibling 见证库：与腿 3 源条同 normKey 的 candidate（只读见证，永不直写）
  writeJsonl(libC14, [
    seedRow14({ id: "l-20260101-r1cb01", updated_at: now14, type: "pitfall", trigger: "R1CROSS 自定义根复现触发", fix: "R1CROSS 自定义根复现修正", confidence: 0, hits: 0, status: "candidate", scope: "project" }),
  ]);

  // ---- REG-01a 登记面（C7-a）：默认布局项目启动 → 登记行含 library_path 且=实际解析项目库绝对路径
  const s14a = startServerX({ root: R14, args: ["--memory-root", M14] });
  try {
    await s14a.call("lessons", { action: "list" }); // 等启动副作用（名册 upsert）落地
    const rows14 = readJsonl(reg14);
    const rid14 = fs.readFileSync(path.join(R14, "root-id"), "utf8").trim();
    ck.ok(
      "REG-01a 登记行含 library_path：值=本实例实际解析项目库 <root>/memory/lessons.jsonl（绝对路径、原地更新语义仍一行）",
      rows14.length === 1 && rows14[0].root_id === rid14 && typeof rows14[0].library_path === "string" && path.isAbsolute(rows14[0].library_path) && normPath(rows14[0].library_path) === normPath(path.join(R14, "memory", "lessons.jsonl")),
      rows14,
    );
  } finally {
    s14a.close();
  }

  // ---- REG-01b 自定义 --root sibling 自登记（C7-a 端到端）：library_path 指向自定义根
  //      项目库而非默认布局映射（旧映射下该路径不存在=不可见的实症面）
  const s14b = startServerX({ root: C14, args: ["--memory-root", M14] });
  try {
    await s14b.call("lessons", { action: "list" });
    const rows14b = readJsonl(reg14);
    const rowC14 = rows14b.find((r) => normPath(r.project_path) === normPath(C14));
    ck.ok(
      "REG-01b 自定义 --root sibling 自登记：library_path=<自定义根>/memory/lessons.jsonl 且默认布局路径不存在（旧映射必脱靶）",
      Boolean(rowC14) && normPath(rowC14.library_path) === normPath(libC14) && !fs.existsSync(path.join(C14, ".zcode", "orchestrator", "memory", "lessons.jsonl")),
      rowC14,
    );
  } finally {
    s14b.close();
  }

  // ---- REG-01c 优先腿端到端（C7-b 腿一）：R14 项目库同 normKey candidate → promote
  //      target=global → sibling 扫描经 library_path 命中自定义 root sibling（count=2）
  writeJsonl(path.join(R14, "memory", "lessons.jsonl"), [
    seedRow14({ id: "l-20260101-r1c002", updated_at: now14, type: "pitfall", trigger: "R1CROSS 自定义根复现触发", fix: "R1CROSS 自定义根复现修正", confidence: 0, hits: 0, status: "candidate" }),
  ]);
  const s14c = startServerX({ root: R14, args: ["--memory-root", M14] });
  try {
    await s14c.call("lessons", { action: "list" });
    const pc14 = resultText(await s14c.call("lessons", { action: "promote", id: "l-20260101-r1c002", target: "global" }));
    ck.ok(
      "REG-01c 优先腿：自定义 --root sibling 经 library_path 命中（branch=cross-project、count=2、others 指向其 project_path）",
      pc14.ok === true && pc14.standard.branch === "cross-project" && pc14.standard.cross_project.count === 2 && pc14.standard.cross_project.pass === true && Array.isArray(pc14.standard.cross_project.others) && pc14.standard.cross_project.others.length === 1 && normPath(pc14.standard.cross_project.others[0]) === normPath(C14),
      pc14.standard,
    );
  } finally {
    s14c.close();
  }

  // ---- REG-01d 回退腿（C7-b 腿二）：无 library_path 的 0.8.0 存量行仍按默认布局命中
  const R14L = subRoot("r-reglib-legacy");
  const libL14 = path.join(R14L, ".zcode", "orchestrator", "memory", "lessons.jsonl");
  writeJsonl(libL14, [
    seedRow14({ id: "l-20260101-r1lb03", updated_at: now14, type: "error-fix", trigger: "R1LEG 存量行回退触发", fix: "R1LEG 存量行回退修正", confidence: 0, hits: 0, status: "candidate", scope: "project" }),
  ]);
  writeJsonl(path.join(R14, "memory", "lessons.jsonl"), [
    seedRow14({ id: "l-20260101-r1l004", updated_at: now14, type: "error-fix", trigger: "R1LEG 存量行回退触发", fix: "R1LEG 存量行回退修正", confidence: 0, hits: 0, status: "candidate" }),
  ]);
  fs.appendFileSync(
    reg14,
    JSON.stringify({ root_id: "f0f0f0f0f0f0f0f2", project_path: R14L, first_seen: now14, last_seen: now14, server_version: "0.8.0" }) + "\n",
  );
  const s14d = startServerX({ root: R14, args: ["--memory-root", M14] });
  try {
    await s14d.call("lessons", { action: "list" });
    const rows14d = readJsonl(reg14);
    const pl14 = resultText(await s14d.call("lessons", { action: "promote", id: "l-20260101-r1l004", target: "global" }));
    ck.ok(
      "REG-01d 回退腿（存量行兼容）：无 library_path 的 legacy 行按默认布局命中（count=2、others 指向 legacy 项目路径；自定义根 sibling 因 normKey 不同不计入）",
      rows14d.length === 3 && pl14.ok === true && pl14.standard.cross_project.count === 2 && Array.isArray(pl14.standard.cross_project.others) && pl14.standard.cross_project.others.length === 1 && normPath(pl14.standard.cross_project.others[0]) === normPath(R14L),
      { rows: rows14d.map((r) => [r.root_id, r.library_path || null]), standard: pl14.standard },
    );
  } finally {
    s14d.close();
  }
}

/* ============ 场景 15：W3FIX（saveGlobalLessons base 修复回归——显式 --memory-root
 *               指向项目根外时 promote target=global 端到端成功〔原炸点转绿〕，
 *               roots r-memroot-out〔项目根〕/ mem-outside〔根外全端根，兄弟目录〕） ============ */
export async function scenW3fix() {
  const R15 = subRoot("r-memroot-out");
  // 根外全端根：置于 BASE.root 下与 R15 平级（resolve 后不在项目根 R15 内）——
  // 生产缺省 ~/.zcode/orchestrator-memory 同位。修复前 saveGlobalLessons 未传 base
  // （缺省=存储根 root）→ assertInside 越界门拒写「path escapes base directory」
  // （场景 14 注记所指 W5 缺陷候选，主控仲裁批准本波修复）。
  const MEM15 = path.join(BASE.root, "mem-outside");
  fs.mkdirSync(MEM15, { recursive: true });
  const gLib15 = path.join(MEM15, "memory", "lessons.jsonl");
  const lib15 = path.join(R15, "memory", "lessons.jsonl");
  const now15 = new Date().toISOString();
  const old15 = new Date(Date.now() - 10 * 86400000).toISOString();
  const seedRow15 = (over) => ({
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
  // 项目库两源条：SN（强条 active：conf 0.9/hits 3/龄 10d → 强条分支过）/
  // SC（同 merge key candidate——合并腿复用 saveGlobalLessons 第二调用点）
  writeJsonl(lib15, [
    seedRow15({ id: "l-20260101-w3f001", updated_at: old15, type: "pitfall", trigger: "W3FIX 根外全端根触发", fix: "W3FIX 根外全端根修正", confidence: 0.9, hits: 3, status: "active" }),
    seedRow15({ id: "l-20260101-w3f002", updated_at: now15, type: "pitfall", trigger: "W3FIX 根外全端根触发", fix: "W3FIX 根外全端根修正", confidence: 0, hits: 0, status: "candidate" }),
  ]);
  const s15 = startServerX({ root: R15, args: ["--memory-root", MEM15] });
  try {
    await s15.call("lessons", { action: "list" }); // 等启动副作用（名册 upsert）落地
    const rootId15 = fs.readFileSync(path.join(R15, "root-id"), "utf8").trim();
    const rowById15 = (file, lid) => readJsonl(file).find((l) => l.id === lid);
    const rawLineById15 = (file, lid) => fs.readFileSync(file, "utf8").split("\n").find((l) => l.includes(`"${lid}"`));

    // ---- W3FIX-a：新建腿端到端（原炸点）：promote target=global 成功且全端新行落根外库
    const snBefore = rawLineById15(lib15, "l-20260101-w3f001");
    const pw15 = resultText(await s15.call("lessons", { action: "promote", id: "l-20260101-w3f001", target: "global" }));
    ck.ok(
      "W3FIX-a 显式 --memory-root 根外时 promote target=global 端到端成功：ok/merged=false/target=global + 全端新行落 <根外>/memory/lessons.jsonl（scope=global/source=promote/refs 回链三元组）",
      pw15.ok === true && pw15.merged === false && pw15.target === "global" && pw15.source_id === "l-20260101-w3f001" && fs.existsSync(gLib15) && (() => { const g = rowById15(gLib15, pw15.id); return Boolean(g) && g.scope === "global" && g.source === "promote" && Array.isArray(g.refs) && g.refs.length === 3 && g.refs[0] === "l-20260101-w3f001" && normPath(g.refs[1]) === normPath(R15) && g.refs[2] === rootId15; })(),
      pw15,
    );
    ck.ok(
      "W3FIX-b 源条原地不动：项目库 SN 行逐字节不变（§6.7 红线在根外场景同守）",
      rawLineById15(lib15, "l-20260101-w3f001") === snBefore,
      null,
    );

    // ---- W3FIX-c：合并腿（saveGlobalLessons 第二调用点）：同 merge key candidate → merged/hits+1，落点仍根外
    const pc15 = resultText(await s15.call("lessons", { action: "promote", id: "l-20260101-w3f002", target: "global" }));
    ck.ok(
      "W3FIX-c 合并腿在根外全端根同绿：merged=true + 命中 W3FIX-a 新条（hits 1→2、conf 0.7→0.8）且全端库字节落点仍根外",
      pc15.ok === true && pc15.merged === true && pc15.id === pw15.id && pc15.hits === 2 && approx2(pc15.confidence) === 0.8 && fs.existsSync(gLib15) && rowById15(gLib15, pw15.id).hits === 2,
      pc15,
    );
  } finally {
    s15.close();
  }
}
