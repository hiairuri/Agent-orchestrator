// @module crv8-memory/digest
/*!
 * suites/crv8-memory/digest.mjs —— digest 消费面场景（v1.3 W1 拆分，自 crv8-memory.mjs
 *   原样搬运）：v1.1 W3 Q11 pack-tail digest 回落/新鲜/STALE/信号 + W6 帽边界 + v1.2
 *   M8-1 STL 组 stale_reason 结构化分级渲染（场景16）。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, subRoot, writeJsonl, readPack, startServer } from "./shared.mjs";

/* ============ 场景 16：v1.1 W3 Q11 digest 消费面（回落/新鲜/STALE/信号） ============ */
export async function scenDigestStl() {
  const R16 = subRoot("r-digest");
  const MEM16 = path.join(R16, "orchestrator-memory");
  const lib16 = path.join(R16, "memory", "lessons.jsonl");
  const digestDir = path.join(MEM16, "digest");
  const digestMd = path.join(digestDir, "pack-tail-digest.md");
  const digestJson = path.join(digestDir, "pack-tail-digest.json");
  fs.mkdirSync(MEM16, { recursive: true });
  // GLOBAL MEMORY 显式开启（digest 只在「至少一节旧记忆节将渲染」时替代渲染）+ gate due。
  fs.writeFileSync(path.join(MEM16, "glean.cfg.json"), JSON.stringify({ idle_hours: 0, new_events: 0, pack_global_section: true }));
  fs.writeFileSync(path.join(MEM16, "AGENTS.md"), "# GLOBAL\n- DIGSEC 全端稳定事实行\n");
  writeJsonl(lib16, [
    {
      v: 1,
      id: "l-20260101-dg0001",
      ts: "2026-01-01T00:00:00.000Z",
      updated_at: new Date().toISOString(),
      mission_id: null,
      worker: "t",
      type: "pitfall",
      trigger: "DIGPROBE 触发行",
      lesson: "",
      fix: "DIGPROBE 修正行",
      confidence: 0.9,
      hits: 5,
      status: "active",
      refs: [],
      superseded_by: null,
      counter_refs: [],
      note: null,
    },
  ]);
  const s16d = startServer({ root: R16 });
  try {
    const packOf = async (mid) => {
      await s16d.call("context_pack", { mission_id: mid, title: "digest 探针", task: "DIGPROBE 任务" });
      return readPack(R16, mid);
    };
    const listDigest = async () => {
      const r = await s16d.call("board", { action: "list" });
      return r.json && r.json.glean_due ? r.json.glean_due.digest : null;
    };

    // ---- 腿 1：digest 缺失 → 旧两节回落（零字节差语义：GLOBAL MEMORY 原样在位） + 信号 missing
    const pMiss = await packOf("m-dg-miss");
    ck.ok("W3-DG-01 digest 缺失 → 回落 GLOBAL MEMORY 且无 PROJECT DIGEST（缺省行为不变）",
      Boolean(pMiss) && pMiss.includes("## GLOBAL MEMORY") && !pMiss.includes("## PROJECT DIGEST"),
      pMiss && pMiss.split("\n").filter((l) => l.startsWith("## ")));
    const dMiss = await listDigest();
    ck.ok("W3-DG-02 glean_due.digest 三态信号 status=missing（gate due 时出现）",
      Boolean(dMiss) && dMiss.status === "missing" && dMiss.generated_at === null, dMiss);

    // ---- 腿 2：digest 在位 + 指纹合 → 单节 PROJECT DIGEST 替代两旧节 + 信号 fresh
    const genAt = new Date().toISOString();
    fs.mkdirSync(digestDir, { recursive: true });
    fs.writeFileSync(
      digestMd,
      `generated_at: ${genAt}\n- DIGEST 项目现状行\n- DIGEST 在飞 m-digest\n- DIGEST 近期裁决 2026-10-25 W3\n`,
    );
    const libStat = fs.statSync(lib16);
    fs.writeFileSync(
      digestJson,
      JSON.stringify({
        generated_at: genAt,
        sources: { lessons_lines: 1, lessons_mtime_ms: libStat.mtimeMs },
        bytes: Buffer.byteLength(fs.readFileSync(digestMd, "utf8"), "utf8"),
      }),
    );
    const pFresh = await packOf("m-dg-fresh");
    ck.ok("W3-DG-03 digest 指纹合 → 单节 PROJECT DIGEST 替代 GLOBAL MEMORY（节头 ts=generated_at）",
      Boolean(pFresh) && pFresh.includes(`## PROJECT DIGEST（归敛物化，ts:${genAt}）`) &&
        !pFresh.includes("## GLOBAL MEMORY") && pFresh.includes("DIGEST 项目现状行"),
      pFresh && pFresh.split("\n").filter((l) => l.startsWith("## ")));
    const dFresh = await listDigest();
    ck.ok("W3-DG-04 glean_due.digest status=fresh + generated_at 透出",
      Boolean(dFresh) && dFresh.status === "fresh" && dFresh.generated_at === genAt, dFresh);

    // ---- 腿 2b：帽边界（v1.1 W6 QA P2-a）——口径=正文（GL-32「正文 ≤12 行/≤1200B」，
    // generated_at 首行不占正文预算）。修复前 12 行正文即 STALE（off-by-one）。
    const writeDigestBody = (bodyLines) => {
      const md = `generated_at: ${genAt}\n${bodyLines.join("\n")}\n`;
      fs.writeFileSync(digestMd, md);
      fs.writeFileSync(
        digestJson,
        JSON.stringify({
          generated_at: genAt,
          sources: { lessons_lines: 1, lessons_mtime_ms: libStat.mtimeMs },
          bytes: Buffer.byteLength(md, "utf8"),
        }),
      );
      return md;
    };
    // 正文恰 12 行（短行）→ fresh（12 行是上限内，不得误判 STALE）
    const body12 = Array.from({ length: 12 }, (_, i) => `- BOUNDARY12-${String(i + 1).padStart(2, "0")}`);
    writeDigestBody(body12);
    const pCap12 = await packOf("m-dg-cap12");
    ck.ok("W6-P2a 正文恰 12 行 → 不 STALE（fresh；12 行为上限内）",
      Boolean(pCap12) && pCap12.includes(`## PROJECT DIGEST（归敛物化，ts:${genAt}）`) &&
        !pCap12.includes("；STALE：") && pCap12.includes("BOUNDARY12-12"),
      pCap12 && pCap12.split("\n").find((l) => l.startsWith("## PROJECT DIGEST")));
    const dCap12 = await listDigest();
    ck.ok("W6-P2a 正文 12 行 glean_due.digest status=fresh", Boolean(dCap12) && dCap12.status === "fresh", dCap12);
    // 正文 13 行 → STALE（正文口径理由）+ 渲染 clamp 到 12 行（第 13 行不泄）
    writeDigestBody(body12.concat("- BOUNDARY13-13"));
    const pCap13 = await packOf("m-dg-cap13");
    ck.ok("W6-P2a 正文 13 行 → STALE（超帽理由按正文计）+ 渲染 clamp 12 行（13 行不泄）",
      Boolean(pCap13) && pCap13.includes("；STALE：digest 超帽（正文 13 行/") &&
        pCap13.includes("BOUNDARY12-12") && !pCap13.includes("BOUNDARY13-13"),
      pCap13 && pCap13.split("\n").find((l) => l.startsWith("## PROJECT DIGEST")));
    // 字节帽边界（正文口径）：12 行恰 1200B → fresh；1201B → STALE（首行字节不占正文预算）
    // 11 行×99 字符 + 1 行×100 字符 = 1189B 文本 + 11×"\n" = 1200B
    const byteLines = [
      ...Array.from({ length: 11 }, (_, i) => `${String(i + 1).padStart(2, "0")}${"a".repeat(97)}`),
      `12${"b".repeat(98)}`,
    ];
    writeDigestBody(byteLines);
    const pByteOk = await packOf("m-dg-bytes-ok");
    ck.ok("W6-P2a 正文恰 1200B → 不 STALE（字节帽=正文口径）",
      Boolean(pByteOk) && !pByteOk.includes("；STALE：") && pByteOk.includes(`12${"b".repeat(98)}`),
      pByteOk && pByteOk.split("\n").find((l) => l.startsWith("## PROJECT DIGEST")));
    writeDigestBody([...byteLines.slice(0, 11), `12${"b".repeat(99)}`]);
    const pByteOver = await packOf("m-dg-bytes-over");
    ck.ok("W6-P2a 正文 1201B → STALE（字节超帽仍检出）",
      Boolean(pByteOver) && pByteOver.includes("；STALE：digest 超帽（正文 12 行/1201B"),
      pByteOver && pByteOver.split("\n").find((l) => l.startsWith("## PROJECT DIGEST")));
    // 边界腿收尾：恢复腿 2 的三行正文（供腿 3/4 的指纹不合/侧车缺失腿使用）
    writeDigestBody(["- DIGEST 项目现状行", "- DIGEST 在飞 m-digest", "- DIGEST 近期裁决 2026-10-25 W3"]);

    // ---- 腿 3：指纹不合（lessons_lines 漂移）→ 标 STALE 不阻断组包 + 信号 stale
    fs.writeFileSync(
      digestJson,
      JSON.stringify({ generated_at: genAt, sources: { lessons_lines: 999, lessons_mtime_ms: libStat.mtimeMs } }),
    );
    const pStale = await packOf("m-dg-stale");
    ck.ok("W3-DG-05 指纹不合 → digest 节标 STALE（仍渲染、不阻断组包）",
      Boolean(pStale) && pStale.includes("## PROJECT DIGEST（归敛物化，") && pStale.includes("；STALE：") &&
        pStale.includes("DIGEST 项目现状行") && !pStale.includes("## GLOBAL MEMORY"),
      pStale && pStale.split("\n").find((l) => l.startsWith("## PROJECT DIGEST")));
    const dStale = await listDigest();
    ck.ok("W3-DG-06 glean_due.digest status=stale", Boolean(dStale) && dStale.status === "stale", dStale);

    // ---- STL 组（v1.2 M8-1，A-v0120-STL）：stale_reason 结构化 {field,want,now,drift}＋按 drift
    // 分级渲染（O2=N=5 绝对数终裁：drift≤5 轻微=态势面大概率仍有效；>5 显著=建议触发归敛；
    // 无数值漂移→显著）。断言面=注入头（PROJECT DIGEST 节头）逐字样例＋N5 边界两侧分级文案。
    const digestHeaderOf = (pack) =>
      String(pack || "").split("\n").find((l) => l.startsWith("## PROJECT DIGEST")) || "";
    // STL-01 漂移 5（≤N5 边界内侧）→ 轻微样例：态势面大概率仍有效
    fs.writeFileSync(
      digestJson,
      JSON.stringify({ generated_at: genAt, sources: { lessons_lines: 6, lessons_mtime_ms: libStat.mtimeMs } }),
    );
    const pStlMinor = await packOf("m-stl-minor");
    ck.ok("STL-01 漂移 5≤N5 → 注入头轻微样例（lessons_lines 6 ≠ 1（漂移 5≤5，轻微——态势面大概率仍有效））",
      digestHeaderOf(pStlMinor).includes("；STALE：lessons_lines 6 ≠ 1（漂移 5≤5，轻微——态势面大概率仍有效）"),
      digestHeaderOf(pStlMinor));
    // STL-02 漂移 7（>N5 边界外侧）→ 显著文案；分级互斥（轻微不出现）
    fs.writeFileSync(
      digestJson,
      JSON.stringify({ generated_at: genAt, sources: { lessons_lines: 8, lessons_mtime_ms: libStat.mtimeMs } }),
    );
    const pStlMajor = await packOf("m-stl-major");
    const hStlMajor = digestHeaderOf(pStlMajor);
    ck.ok("STL-02 漂移 7>N5 → 显著分级文案（建议触发归敛），轻微不出现",
      hStlMajor.includes("（漂移 7>5，显著——建议触发归敛）") && !hStlMajor.includes("轻微"),
      hStlMajor);
    // STL-03 大漂移注入头样例（旧文案前缀兼容：`lessons_lines 999 ≠ 1` 仍可检索）
    fs.writeFileSync(
      digestJson,
      JSON.stringify({ generated_at: genAt, sources: { lessons_lines: 999, lessons_mtime_ms: libStat.mtimeMs } }),
    );
    const pStlBig = await packOf("m-stl-big");
    ck.ok("STL-03 大漂移注入头样例（lessons_lines 999 ≠ 1（漂移 998>5，显著——建议触发归敛））",
      digestHeaderOf(pStlBig).includes("；STALE：lessons_lines 999 ≠ 1（漂移 998>5，显著——建议触发归敛）"),
      digestHeaderOf(pStlBig));
    // STL-04 mtime 单独不匹配（无数值漂移）→ drift 未知 → 显著（fail-safe 侧）
    fs.writeFileSync(
      digestJson,
      JSON.stringify({ generated_at: genAt, sources: { lessons_lines: 1, lessons_mtime_ms: libStat.mtimeMs + 12345 } }),
    );
    const pStlMtime = await packOf("m-stl-mtime");
    ck.ok("STL-04 mtime 漂移未知 → 注入头显著样例（lessons_mtime_ms 不匹配（漂移未知，显著——建议触发归敛））",
      digestHeaderOf(pStlMtime).includes("；STALE：lessons_mtime_ms 不匹配（漂移未知，显著——建议触发归敛）"),
      digestHeaderOf(pStlMtime));

    // ---- 腿 4：指纹侧车缺失 → STALE（fail-safe，不回落旧节——digest 仍在位）
    fs.rmSync(digestJson, { force: true });
    const pNoSide = await packOf("m-dg-noside");
    ck.ok("W3-DG-07 指纹侧车缺失 → STALE（不阻断）",
      Boolean(pNoSide) && pNoSide.includes("；STALE：") && pNoSide.includes("DIGEST 项目现状行"),
      pNoSide && pNoSide.split("\n").find((l) => l.startsWith("## PROJECT DIGEST")));

    // ---- 腿 5：digest md 删除 → 回到旧两节渲染 + missing 信号
    fs.rmSync(digestMd, { force: true });
    const pBack = await packOf("m-dg-back");
    ck.ok("W3-DG-08 digest 删除 → 回退旧两节渲染（GLOBAL MEMORY 复位）",
      Boolean(pBack) && pBack.includes("## GLOBAL MEMORY") && !pBack.includes("## PROJECT DIGEST"),
      pBack && pBack.split("\n").filter((l) => l.startsWith("## ")));
    const dBack = await listDigest();
    ck.ok("W3-DG-09 删除后信号回 missing", Boolean(dBack) && dBack.status === "missing", dBack);

    // ---- 腿 6：brief 暴露 digest 权威路径（gleaner 物化面：路径不手写）
    const brief16 = JSON.parse(fs.readFileSync(path.join(MEM16, "glean-brief.json"), "utf8"));
    ck.ok("W3-DG-10 brief.digest 权威路径（path/sidecar_path 双指针）",
      Boolean(brief16.digest) && brief16.digest.path === digestMd && brief16.digest.sidecar_path === digestJson,
      brief16.digest);
  } finally {
    s16d.close();
  }
}
