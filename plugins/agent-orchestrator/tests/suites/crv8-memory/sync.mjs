// @module crv8-memory/sync
/*!
 * suites/crv8-memory/sync.mjs —— ORCH.md ver 同步捎带面场景（v1.3 W1 拆分，自
 *   crv8-memory.mjs 原样搬运）：SYNC-01..05（场景6，§4 ver 同步捎带，root r-sync，
 *   缺省 temp 重定向）。v1.3 W2 增场景 6b：SYNC-06..09（§3.2 content 面第三
 *   surfacing，root r-sync2，harness call() 通用通道直取）。v1.3 W4 增场景 6c：
 *   SYNC-15..21（§3.4 帽张力 cfg 化 opt-in，root r-caps）。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, subRoot, writeJsonl, startServer, PRE } from "./shared.mjs";

/* ============ 场景 6：SYNC-01..05（§4 ver 同步捎带，root r-sync，缺省 temp 重定向） ============ */
export async function scenSync01to05() {
  const R6 = subRoot("r-sync");
  const orchMd = path.join(R6, "ORCH.md"); // §4.1：<存储根>/ORCH.md
  const s6 = startServer({ root: R6 });
  try {
    // 原始 result 访问通道（orch_memory 挂在 JSON-RPC result 顶层，content 之外）
    const rawCall = (name, args) => s6.request("tools/call", { name: PRE + name, arguments: args });

    // ---- SYNC-01a：文件不存在 → 不附且基线=absent
    let r = await rawCall("lessons", { action: "list" });
    ck.ok(
      "SYNC-01a 进程首次调用且 ORCH.md 不存在 → 响应无 orch_memory 键（基线=absent）",
      r.result && !("orch_memory" in r.result),
      r.result && Object.keys(r.result),
    );

    // ---- SYNC-01b：文件出现 → 首次调用附 initial 全文（ver 从头部解析）
    fs.writeFileSync(
      orchMd,
      "<!-- orch-memory ver=1 updated=2026-10-22T08:00:00.000Z -->\n# ORCH.md — 主控记忆\n## 常驻\n- SYNC1PROBE 初始装载行\n",
    );
    r = await rawCall("lessons", { action: "list" });
    const om1 = r.result && r.result.orch_memory && r.result.orch_memory.orch_md;
    ck.ok(
      "SYNC-01b 出现后首次调用附 orch_md reason=initial + 全文 + truncated:false",
      Boolean(om1) && om1.reason === "initial" && om1.truncated === false && typeof om1.content === "string" && om1.content.includes("SYNC1PROBE 初始装载行") && om1.bytes > 0,
      om1 && { reason: om1.reason, trunc: om1.truncated, bytes: om1.bytes },
    );
    ck.ok(
      "SYNC-01c ver/updated_at 从 orch-memory 头部解析透传（ver=1）",
      Boolean(om1) && om1.ver === 1 && om1.updated_at === "2026-10-22T08:00:00.000Z",
      om1 && { ver: om1.ver, updated_at: om1.updated_at },
    );

    // ---- SYNC-03：stat 未变 → 无 orch_memory 键（零开销路径）
    r = await rawCall("lessons", { action: "list" });
    ck.ok("SYNC-03 stat 未变 → 响应无 orch_memory 键", r.result && !("orch_memory" in r.result), r.result && Object.keys(r.result));

    // ---- SYNC-02：外部改写（bytes 变化，V7-01 双因子）→ changed + ver 递增 + 新全文
    // v0.10 G2 时序余量（CACHE-06a 同族，实红面）：NTFS mtime 时钟粒度本机实测 ~15.6ms，
    // 同尺寸改写若与基线同粒度，server 侧 bytes+mtimeMs 双因子判不出 changed
    //（orchMdAttachment「residual race accepted」注记的实际触发面；直写探针复现
    //  9/15 漏检，加 100ms 后 0/15）。只等 mtime 时钟跨跳，断言主句零改动。
    await new Promise((res) => setTimeout(res, 100));
    fs.writeFileSync(
      orchMd,
      "<!-- orch-memory ver=2 updated=2026-10-22T09:00:00.000Z -->\n# ORCH.md — 主控记忆\n## 常驻\n- SYNC2PROBE 改写后的行\n",
    );
    r = await rawCall("lessons", { action: "list" });
    const om2 = r.result && r.result.orch_memory && r.result.orch_memory.orch_md;
    ck.ok(
      "SYNC-02 外部改写 → reason=changed + ver 递增（=2）+ 新全文替换",
      Boolean(om2) && om2.reason === "changed" && om2.ver === 2 && om2.content.includes("SYNC2PROBE 改写后的行") && !om2.content.includes("SYNC1PROBE"),
      om2 && { reason: om2.reason, ver: om2.ver },
    );

    // ---- SYNC-04：超 120 行 → 截断 + truncated:true + 提示行
    const longDoc = [
      "<!-- orch-memory ver=3 updated=2026-10-22T10:00:00.000Z -->",
      "# ORCH.md",
      ...Array.from({ length: 130 }, (_, i) => `- 行${i + 1} SYNC4PROBE`),
    ].join("\n");
    fs.writeFileSync(orchMd, longDoc + "\n");
    r = await rawCall("lessons", { action: "list" });
    const om4 = r.result && r.result.orch_memory && r.result.orch_memory.orch_md;
    const om4Lines = om4 && om4.content ? om4.content.split("\n") : [];
    ck.ok(
      "SYNC-04 超 120 行 → truncated:true + 内容截到帽内（120 行+提示 ≤121）+ 提示行在案 + 帽外行不出现",
      Boolean(om4) && om4.truncated === true && om4Lines.length <= 121 && om4Lines.some((l) => l.includes("超帽")) && om4.content.includes("行118 SYNC4PROBE") && !om4.content.includes("行130 SYNC4PROBE"),
      om4 && { trunc: om4.truncated, lines: om4Lines.length },
    );

    // ---- SYNC-05：删除 → removed 恰一次，随后安静
    fs.unlinkSync(orchMd);
    r = await rawCall("lessons", { action: "list" });
    const om5 = r.result && r.result.orch_memory && r.result.orch_memory.orch_md;
    ck.ok(
      "SYNC-05a 文件删除 → removed 捎带恰一次（无 content/ver/bytes/truncated 键）",
      Boolean(om5) && om5.reason === "removed" && !("content" in om5) && !("ver" in om5) && !("bytes" in om5) && !("truncated" in om5),
      om5,
    );
    r = await rawCall("lessons", { action: "list" });
    ck.ok("SYNC-05b removed 后归于安静（再调用无 orch_memory）", r.result && !("orch_memory" in r.result));
  } finally {
    s6.close();
  }
}

/* ============ 场景 6b：SYNC-06..09（§3.2 v1.3 W2 content 面第三 surfacing，root r-sync2） ============ */
export async function scenSync06to09() {
  const R6b = subRoot("r-sync2");
  const orchMd = path.join(R6b, "ORCH.md"); // §4.1：<存储根>/ORCH.md
  const s6b = startServer({ root: R6b });
  try {
    // harness call() 通用通道（content[0].text → r.json）——v1.3 W2 起 content 面
    // 断言零特殊通道（design §3.2：顺带消解 l-20261022-718bdd「顶层附件断言须
    // request() 直取」的痛点；顶层兼容腿仍走场景 6 的 rawCall/request() 直取）。
    const call = (name, args) => s6b.call(name, args);

    // ---- SYNC-06：initial → r.json.orch_md.content 全文可达（harness call() 通用通道）
    fs.writeFileSync(
      orchMd,
      "<!-- orch-memory ver=1 updated=2026-11-01T08:00:00.000Z -->\n# ORCH.md — 主控记忆\n## 常驻\n- SYNC6PROBE 初始装载行\n",
    );
    let j = await call("lessons", { action: "list" });
    const cm6 = j.json && j.json.orch_md;
    ck.ok(
      "SYNC-06 initial → r.json.orch_md.content 全文可达（harness call() 通用通道）",
      Boolean(cm6) && cm6.reason === "initial" && cm6.ver === 1 && typeof cm6.content === "string" && cm6.content.includes("SYNC6PROBE 初始装载行"),
      cm6 && { reason: cm6.reason, ver: cm6.ver, bytes: cm6.bytes },
    );

    // ---- SYNC-08：unchanged → r.json 无 orch_md 键（零字节差，K3：不注入即零差）
    j = await call("lessons", { action: "list" });
    ck.ok(
      "SYNC-08 unchanged → r.json 无 orch_md 键（零字节差）",
      j.json && !("orch_md" in j.json),
      j.json && Object.keys(j.json).filter((k) => k.includes("orch")),
    );

    // ---- SYNC-07：changed → r.json.orch_md 新全文 + ver 递增
    // 时序余量 100ms（NTFS mtime 粒度，同尺寸改写双因子判不出 changed——场景 6
    // SYNC-02 注 CACHE-06a 同族；只等时钟跨跳，断言主句零改动）。
    await new Promise((res) => setTimeout(res, 100));
    fs.writeFileSync(
      orchMd,
      "<!-- orch-memory ver=2 updated=2026-11-01T09:00:00.000Z -->\n# ORCH.md — 主控记忆\n## 常驻\n- SYNC7PROBE 改写后的行\n",
    );
    j = await call("lessons", { action: "list" });
    const cm7 = j.json && j.json.orch_md;
    ck.ok(
      "SYNC-07 changed → r.json.orch_md 新全文 + ver 递增（=2）",
      Boolean(cm7) && cm7.reason === "changed" && cm7.ver === 2 && cm7.content.includes("SYNC7PROBE 改写后的行") && !cm7.content.includes("SYNC6PROBE"),
      cm7 && { reason: cm7.reason, ver: cm7.ver },
    );

    // ---- SYNC-09：removed → 单行 {reason:"removed"} 恰一次后安静（content 面）
    fs.unlinkSync(orchMd);
    j = await call("lessons", { action: "list" });
    const cm9 = j.json && j.json.orch_md;
    const singleLineRemoved = Boolean(cm9) && JSON.stringify(cm9) === '{"reason":"removed"}';
    j = await call("lessons", { action: "list" });
    ck.ok(
      'SYNC-09 removed → r.json.orch_md 单行 {"reason":"removed"} 恰一次后归于安静',
      singleLineRemoved && j.json && !("orch_md" in j.json),
      { removed: cm9, quietAfter: Boolean(j.json) && !("orch_md" in j.json) },
    );
  } finally {
    s6b.close();
  }
}

/* ============ 场景 6c：SYNC-15..21（§3.4 v1.3 W4 帽张力 cfg 化 opt-in，root r-caps） ============ */
/*!
 * v1.3 W4 (E, design §3.4)：ORCH.md 截断帽 cfg 化——glean.cfg.json 键
 * orch_md_max_lines〔默认 120〕/orch_md_max_bytes〔默认 10240〕逐键 junk 回落；
 * 常量降为默认值来源（标识符保留，lint-manifest 钉）；截断提示动态化实际帽值；
 * 固定包 RULES 帽值句随 cfg 动态渲染（M-2 功能面）；orchMemoryAttachment 单次
 * cfg 读贯穿两腿（L-9，禁进程级缓存——SYNC-18 即热写即生效的直接验证腿）。
 * 默认路径零行为变更（SYNC-15/17/20 回归腿）。
 */
export async function scenSyncW4Caps() {
  const R6c = subRoot("r-caps");
  const MEM6c = path.join(R6c, "orchestrator-memory"); // 临时根缺省重定向落点
  const cfg6c = path.join(MEM6c, "glean.cfg.json");
  const orchMd = path.join(R6c, "ORCH.md"); // §4.1：<存储根>/ORCH.md
  const s6c = startServer({ root: R6c });
  try {
    const rawCall = (name, args) => s6c.request("tools/call", { name: PRE + name, arguments: args });
    const wait = () => new Promise((res) => setTimeout(res, 100)); // NTFS mtime 粒度余量（SYNC-02 注 CACHE-06a 同族）
    const doc = (tag, n, pad = 0) =>
      [
        "<!-- orch-memory ver=10 updated=2026-11-01T10:00:00.000Z -->",
        "# ORCH.md",
        ...Array.from({ length: n }, (_, i) => `- 行${i + 1} ${tag}${pad ? " " + "x".repeat(pad) : ""}`),
      ].join("\n") + "\n";
    const om = (r) => r.result && r.result.orch_memory && r.result.orch_memory.orch_md;

    // ---- SYNC-15：默认回归腿（无 cfg 文件）——截 120 行 + 提示字面与 W4 前逐字节等价
    fs.writeFileSync(orchMd, doc("W4PROBE-A", 130));
    let r = await rawCall("lessons", { action: "list" });
    const omA = om(r);
    ck.ok(
      "SYNC-15 默认回归（无 cfg）：超 130 行 → 截 120 行 + 提示字面与 W4 前逐字节等价（>120 行/10KB，server 侧截断兜底）",
      Boolean(omA) && omA.truncated === true && omA.content.includes("行118 W4PROBE-A") && !omA.content.includes("行119 W4PROBE-A") && omA.content.endsWith("\nORCH.md 超帽，建议拉起归敛（>120 行/10KB，server 侧截断兜底）。"),
      omA && { trunc: omA.truncated, lines: omA.content.split("\n").length },
    );

    // ---- SYNC-16：帽线键 junk 回落——orch_md_max_lines:"junk" → 内建默认 120 生效
    fs.mkdirSync(MEM6c, { recursive: true }); // spawn 竞态防御（GLEAN-01a 同款）
    fs.writeFileSync(cfg6c, JSON.stringify({ orch_md_max_lines: "junk" }));
    await wait();
    fs.writeFileSync(orchMd, doc("W4PROBE-B", 130, 2)); // 与 A 尺寸异（bytes+mtimeMs 双因子兜底）
    r = await rawCall("lessons", { action: "list" });
    const omB = om(r);
    ck.ok(
      "SYNC-16 帽线键 junk 回落：orch_md_max_lines=junk → 内建默认 120 生效（截 120 行 + 提示 >120 行/10KB）",
      Boolean(omB) && omB.truncated === true && omB.content.includes("行118 W4PROBE-B") && !omB.content.includes("行119 W4PROBE-B") && omB.content.includes("（>120 行/10KB，server 侧截断兜底）"),
      omB && { trunc: omB.truncated },
    );

    // ---- SYNC-17：帽字节键 junk 回落——orch_md_max_bytes:"junk" → 内建默认 10240 生效
    fs.writeFileSync(cfg6c, JSON.stringify({ orch_md_max_bytes: "junk" }));
    await wait();
    fs.writeFileSync(orchMd, doc("W4PROBE-C", 40, 280)); // ~12KB（>10240B）且 ≤120 行 → 字节帽先裁
    r = await rawCall("lessons", { action: "list" });
    const omC = om(r);
    const bodyC = omC && omC.content ? omC.content.split("\nORCH.md 超帽")[0] : "";
    ck.ok(
      "SYNC-17 帽字节键 junk 回落：orch_md_max_bytes=junk → 内建默认 10240 生效（~12KB 文档字节截断，提示前正文 ≤10240B）+ 提示行在案",
      Boolean(omC) && omC.truncated === true && Buffer.byteLength(bodyC, "utf8") <= 10240 && bodyC.length > 0 && omC.content.includes("超帽") && omC.content.includes(">120 行/10KB"),
      omC && { trunc: omC.truncated, bodyBytes: Buffer.byteLength(bodyC, "utf8") },
    );

    // ---- SYNC-18：帽键生效腿——orch_md_max_lines=20 → 25 行文档截到 20 行（非缺省帽；
    //      cfg 写与消费同进程相邻调用=禁进程级缓存〔L-9〕的直接验证腿）
    fs.writeFileSync(cfg6c, JSON.stringify({ orch_md_max_lines: 20 }));
    await wait();
    fs.writeFileSync(orchMd, doc("W4PROBE-D", 23)); // 2 头 + 23 行 = 25 行 → 截 20
    r = await rawCall("lessons", { action: "list" });
    const omD = om(r);
    ck.ok(
      "SYNC-18 帽键生效腿：orch_md_max_lines=20 → 25 行文档截到 20 行（帽键热写即生效非缺省，L-9 禁缓存）+ 提示随帽渲染（>20 行）",
      Boolean(omD) && omD.truncated === true && omD.content.includes("行18 W4PROBE-D") && !omD.content.includes("行19 W4PROBE-D") && omD.content.includes("（>20 行/10KB，server 侧截断兜底）"),
      omD && { trunc: omD.truncated, lines: omD.content.split("\n").length },
    );

    // ---- SYNC-19：截断提示动态字面腿——帽 15 行/2048B → 提示渲染实际帽值「>15 行/2KB」
    fs.writeFileSync(cfg6c, JSON.stringify({ orch_md_max_lines: 15, orch_md_max_bytes: 2048 }));
    await wait();
    fs.writeFileSync(orchMd, doc("W4PROBE-E", 40, 260)); // 双帽均超（行裁后仍 >2048B）
    r = await rawCall("lessons", { action: "list" });
    const omE = om(r);
    ck.ok(
      "SYNC-19 截断提示动态字面腿：帽 15 行/2048B → 提示渲染实际帽值「>15 行/2KB」（动态化实证，非固定字面）",
      Boolean(omE) && omE.truncated === true && omE.content.endsWith("\nORCH.md 超帽，建议拉起归敛（>15 行/2KB，server 侧截断兜底）。"),
      omE && { trunc: omE.truncated, tail: omE.content.split("\n").pop() },
    );

    // ---- SYNC-20：pack 帽值句默认渲染回归——cfg 无帽键 → 固定包 RULES 仍逐字「帽 120 行/10KB」
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
    r = await rawCall("lessons", { action: "list" });
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
