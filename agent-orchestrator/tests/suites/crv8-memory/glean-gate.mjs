// @module crv8-memory/glean-gate
/*!
 * suites/crv8-memory/glean-gate.mjs —— 归敛门槛与 due 信号面场景（v1.3 W1 拆分，自
 *   crv8-memory.mjs 原样搬运）：GLEAN-01 门槛真值表/成本排序/常忙腿（场景7）/
 *   GLEAN-02+04 due 信号与 brief 形状 + G12 board/list 信号 + G13 固定包（场景8）。
 *   v1.6 W-p（裁定 A 候选③）：v1.3 W1 双侧对称腿 GLEAN-01e 退役（sentinel 镜像源
 *   glean-launch.mjs 迁 parked；server 侧门槛面保留）。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, subRoot, writeJsonl, normPath, gleanAfterWrite, startServer, PRE, DEFAULT_SERVER, PLUGIN_DIR } from "./shared.mjs";
import { familySource } from "../../harness/source-family.mjs";

/* ============ 场景 7：GLEAN-01（§6.1 门槛真值表+成本排序，root r-glean1） ============ */
export async function scenGlean01() {
  const R7 = subRoot("r-glean1");
  const MEM7 = path.join(R7, "orchestrator-memory"); // 临时根缺省重定向落点
  const cfg7 = path.join(MEM7, "glean.cfg.json");
  const lib7 = path.join(R7, "memory", "lessons.jsonl");
  const lock7 = path.join(MEM7, "glean-lock.json");
  const brief7 = path.join(MEM7, "glean-brief.json");
  const pack7 = path.join(MEM7, "glean-pack.md");
  const g1Row = (i) => ({
    v: 1,
    id: `l-20260101-g1${String(i).padStart(2, "0")}`,
    ts: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    mission_id: null,
    worker: "t",
    type: "pitfall",
    trigger: `G1PROBE 触发${i}`,
    lesson: "",
    fix: `G1PROBE 修正${i}`,
    confidence: 0.9,
    hits: 5,
    status: "active",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
  });
  const s7 = startServer({ root: R7 });
  try {
    const rawCall = (name, args) => s7.request("tools/call", { name: PRE + name, arguments: args });
    // 臂 1（M-4 换血）：时间门不过（done 锁 finished_at=now，idle_hours=9999）∧ 常忙腿关断
    // （busy_channel_events=0 显式钉回退语义，防夹具演进出隐性红）∧ 事件足（new_events=0）→ 不附不物化
    fs.mkdirSync(MEM7, { recursive: true }); // spawn 竞态防御：不依赖 server 启动侧先建目录
    writeJsonl(lib7, [g1Row(1)]);
    fs.writeFileSync(
      lock7,
      JSON.stringify({ v: 1, state: "done", pid: 1, finished_at: new Date().toISOString(), watermarks: { global_lines: 0, projects: {} } }),
    );
    fs.writeFileSync(cfg7, JSON.stringify({ idle_hours: 9999, new_events: 0, busy_channel_events: 0 }));
    let r = await rawCall("lessons", { action: "list" });
    ck.ok(
      "GLEAN-01a 时间门不过∧常忙腿不过（busy=0 钉回退）→ 无 glean 信号且不物化 brief（事件条件已满足也不放行）",
      r.result && !("orch_memory" in r.result) && !fs.existsSync(brief7),
      { respKeys: r.result && Object.keys(r.result), brief: fs.existsSync(brief7) },
    );
    // G12（M10，A-v0110-M10-01）：无 due → board/list 无 glean_due 键（零字节差缺省，
    // P9-01 后半句同体例）
    const bl17 = await s7.call("board", { action: "list" });
    ck.ok("G12-c 时间门不过 → board/list 无 glean_due 键", bl17.json && !("glean_due" in bl17.json), bl17.json && Object.keys(bl17.json));
    // 臂 2（M-4 换血）：时间门过（idle_hours=0）∧ 事件门不过（1 < 99）→ 不附不物化
    // （busy=0 同钉：夹具演进时事件门腿不被常忙腿隐性翻转）
    fs.writeFileSync(cfg7, JSON.stringify({ idle_hours: 0, new_events: 99, busy_channel_events: 0 }));
    r = await rawCall("lessons", { action: "list" });
    ck.ok(
      "GLEAN-01b 事件门不过 → 无 glean 信号且不物化 brief",
      r.result && !("orch_memory" in r.result) && !fs.existsSync(brief7),
      { respKeys: r.result && Object.keys(r.result), brief: fs.existsSync(brief7) },
    );
    const bl27 = await s7.call("board", { action: "list" });
    ck.ok("G12-d 事件门不过 → board/list 无 glean_due 键", bl27.json && !("glean_due" in bl27.json), bl27.json && Object.keys(bl27.json));
    // glean3（A-v0110-GLEAN3-01）：无 due（时间门/事件门两腿均未放行）→ pack 同样不物化
    // （零字节差缺省，P9-01 体例；GLEAN-01a/01b 已证 brief 不落盘，本条补 pack 面）
    ck.ok("G13-h 无 due（时间门/事件门两腿）→ 不物化 glean-pack.md（零字节差缺省）", !fs.existsSync(pack7), fs.existsSync(pack7));
    // 成本排序（决议 D4：先查时间→数事件→抢锁）——源码序机械断言
    // （锚点取语句级：解构行含裸 lockBusy/countEvents 标识符，不能用裸名匹配）
    // v1.3 W1 保序改造（三锚字面全保，改写后仍绿）：常忙腿 cfg 前置落 iTime 与 iEvents 序位之间
    // v1.3 切分重基（修复轮 C）：server 读取面走族 helper（薄入口+模块族拼接——
    // evaluateGleanGate/materializeGleanBrief 定义对已迁 mcp/server-memory.mjs），断言与期望值零改动。
    const srvSrc7 = familySource(PLUGIN_DIR, path.join("mcp", "server.mjs"));
    const gateSrc = srvSrc7.slice(srvSrc7.indexOf("function evaluateGleanGate"), srvSrc7.indexOf("function materializeGleanBrief"));
    const iTime = gateSrc.indexOf("if (!(idleH > Number(cfg.idle_hours)))");
    const iBusyPre = gateSrc.indexOf("if (!(busyN > 0))");
    const iEvents = gateSrc.indexOf("const events = countEvents()");
    const iLock = gateSrc.indexOf('if (lockBusy) return');
    ck.ok(
      "GLEAN-01c 门槛纯函数成本排序（源码序）：时间比较 < 常忙腿前置 < 事件计数 < 锁仲裁",
      iTime >= 0 && iBusyPre > iTime && iEvents > iBusyPre && iLock > iEvents,
      { iTime, iBusyPre, iEvents, iLock },
    );
    // ---- v1.3 W1 G12 新臂①：时间门不过 + events≥busy_channel_events → due（常忙腿，新 reason 形态）
    fs.writeFileSync(cfg7, JSON.stringify({ idle_hours: 9999, new_events: 99, busy_channel_events: 1 }));
    r = await rawCall("lessons", { action: "list" });
    const gbusy = r.result && r.result.orch_memory && r.result.orch_memory.glean;
    ck.ok(
      "G12-e 时间门不过+events≥busy → due:true 常忙腿（reason 含 busy-channel+threshold 词根，lock_state=idle）",
      Boolean(gbusy) && gbusy.due === true && typeof gbusy.reason === "string" && gbusy.reason.includes("busy-channel") && gbusy.reason.includes("threshold") && gbusy.lock_state === "idle",
      gbusy,
    );
    const bl37 = await s7.call("board", { action: "list" });
    ck.ok("G12-f 常忙腿 due → board/list 附 glean_due 键（M10 同机制位）", bl37.json && "glean_due" in bl37.json, bl37.json && Object.keys(bl37.json));
    const briefBusy = fs.existsSync(brief7) ? JSON.parse(fs.readFileSync(brief7, "utf8")) : null;
    ck.ok(
      "G12-g 常忙腿 due → brief.gate.busy_channel_events 键+measured 同步（L-12 常忙臂）",
      Boolean(briefBusy) && briefBusy.gate && briefBusy.gate.busy_channel_events === 1 && briefBusy.gate.measured && briefBusy.gate.measured.new_events === 1,
      briefBusy && briefBusy.gate,
    );
    // ---- G12 新臂②：busy_channel_events=0 → 恒走旧双门（回退语义；events 1≥0 也不放行——0 是关断非阈值零）
    if (fs.existsSync(brief7)) fs.unlinkSync(brief7);
    if (fs.existsSync(pack7)) fs.unlinkSync(pack7);
    fs.writeFileSync(cfg7, JSON.stringify({ idle_hours: 9999, new_events: 99, busy_channel_events: 0 }));
    r = await rawCall("lessons", { action: "list" });
    ck.ok(
      "G12-h busy_channel_events=0 → 常忙腿关断（events≥0 仍无信号）→ 不附不物化（回退语义）",
      r.result && !("orch_memory" in r.result) && !fs.existsSync(brief7) && !fs.existsSync(pack7),
      { respKeys: r.result && Object.keys(r.result), brief: fs.existsSync(brief7), pack: fs.existsSync(pack7) },
    );
    // v1.6 W-p 剥离（裁定 A 候选③）：v1.3 W1 双侧对称腿（GLEAN-01e，server evaluateGleanGate ↔
    // sentinel gleanGateCheck 真值表逐格一致）退役——sentinel 侧镜像源 hooks/bg-sentinel/glean-launch.mjs
    // 随 -p 通道迁 parked/agent-orchestrator/（glean 编排=主会话级）；server 侧 evaluateGleanGate
    // 门槛面保留（GLEAN-01a..d 全绿承载）。恢复=parked README 指引+本腿回植。台账 v1.6.0.md §W-p。
  } finally {
    s7.close();
  }
}

/* ============ 场景 8：GLEAN-02 + GLEAN-04（due 信号与 brief 形状 + busy 臂，root r-glean2） ============ */
export async function scenGlean02_04() {
  const R8 = subRoot("r-glean2");
  const MEM8 = path.join(R8, "orchestrator-memory");
  const brief8 = path.join(MEM8, "glean-brief.json");
  const pack8 = path.join(MEM8, "glean-pack.md");
  const lock8 = path.join(MEM8, "glean-lock.json");
  fs.mkdirSync(MEM8, { recursive: true });
  fs.writeFileSync(path.join(MEM8, "glean.cfg.json"), JSON.stringify({ idle_hours: 0, new_events: 1 }));
  writeJsonl(path.join(R8, "memory", "lessons.jsonl"), [
    {
      v: 1,
      id: "l-20260101-g2a001",
      ts: "2026-01-01T00:00:00.000Z",
      // updated_at 取当下：防 housekeep 衰减退役把行转 retired、扰动 brief counts 断言
      updated_at: new Date().toISOString(),
      mission_id: null,
      worker: "t",
      type: "pitfall",
      trigger: "G2PROBE 触发行",
      lesson: "",
      fix: "G2PROBE 修正行",
      confidence: 0.9,
      hits: 5,
      status: "active",
      refs: [],
      superseded_by: null,
      counter_refs: [],
      note: null,
    },
  ]);
  const s8 = startServer({ root: R8 });
  try {
    const rawCall = (name, args) => s8.request("tools/call", { name: PRE + name, arguments: args });
    // ---- GLEAN-02a：双门过 → due 信号
    let r = await rawCall("lessons", { action: "list" });
    const g2 = r.result && r.result.orch_memory && r.result.orch_memory.glean;
    ck.ok(
      "GLEAN-02a 双门过 → due:true + reason（含 threshold）+ brief_path + lock_state=idle",
      Boolean(g2) && g2.due === true && typeof g2.reason === "string" && g2.reason.includes("threshold") && typeof g2.brief_path === "string" && g2.brief_path.endsWith("glean-brief.json") && g2.lock_state === "idle",
      g2,
    );

    // glean3（A-v0110-GLEAN3-01）：due 信号增 pack_path + 固定包同调用点物化
    ck.ok(
      "G13-a due 信号增 pack_path（endsWith glean-pack.md，glean3 主控零组装面）",
      Boolean(g2) && typeof g2.pack_path === "string" && g2.pack_path.endsWith("glean-pack.md"),
      g2 && g2.pack_path,
    );
    ck.ok("G13-b due 调用后固定包已物化于 pack_path", fs.existsSync(pack8), pack8);

    // G12（M10，A-v0110-M10-01）：due → 信号入 board/list 响应 JSON 内部（G12 修复：
    // 顶层 orch_memory 附件被宿主丢弃，result-content 键可达——P9 duplicate_warning
    // 同机制位；orch_memory 顶层附件保留不拆，GLEAN-02a 即其证明）
    const bl28 = await s8.call("board", { action: "list" });
    const gd2 = bl28.json && bl28.json.glean_due;
    ck.ok(
      "G12-a gate due → board/list 顶层 glean_due {idle_h,events,brief_path}",
      Boolean(gd2) && (gd2.idle_h === null || typeof gd2.idle_h === "number") && Number.isFinite(gd2.events) && gd2.events >= 1 && typeof gd2.brief_path === "string" && gd2.brief_path.endsWith("glean-brief.json"),
      gd2,
    );
    // glean3（A-v0110-GLEAN3-01）：board/list glean_due 同信号面增 pack_path
    ck.ok(
      "G13-c board/list glean_due 增 pack_path（endsWith glean-pack.md）",
      Boolean(gd2) && typeof gd2.pack_path === "string" && gd2.pack_path.endsWith("glean-pack.md"),
      gd2 && gd2.pack_path,
    );
    // 物化保证：删 brief 后仅跑 board/list——同调用的 orch_memory 附件须重新落盘
    fs.rmSync(brief8, { force: true });
    const bl28b = await s8.call("board", { action: "list" });
    const gd2b = bl28b.json && bl28b.json.glean_due;
    ck.ok("G12-b brief 删除后 board/list 重建之（同调用 orch_memory 附件落盘，brief_path 可读）", Boolean(gd2b) && fs.existsSync(brief8), gd2b && gd2b.brief_path);
    // glean3：pack 与 brief 同命运——删除后 board/list 单调用双重建（brief 物化后组合）
    fs.rmSync(pack8, { force: true });
    const bl28c = await s8.call("board", { action: "list" });
    const gd2c = bl28c.json && bl28c.json.glean_due;
    ck.ok(
      "G13-d pack 删除后 board/list 单调用重建（与 brief 同调用点再生，glean_due.pack_path 可读）",
      Boolean(gd2c) && fs.existsSync(pack8) && fs.existsSync(brief8),
      gd2c && gd2c.pack_path,
    );

    // ---- GLEAN-04：brief 物化字段齐全（§9.2 形状）
    const briefOk = fs.existsSync(brief8);
    ck.ok("GLEAN-04a brief 已物化于 brief_path", briefOk, brief8);
    const brief = briefOk ? JSON.parse(fs.readFileSync(brief8, "utf8")) : null;
    const rid8 = fs.readFileSync(path.join(R8, "root-id"), "utf8").trim();
    ck.ok(
      "GLEAN-04b brief 顶层 v/generated_at/root_id/project_path + gate（阈值+measured 实测）",
      Boolean(brief) && brief.v === 1 && typeof brief.generated_at === "string" && brief.root_id === rid8 && normPath(brief.project_path) === normPath(R8) && brief.gate && brief.gate.idle_hours === 0 && brief.gate.new_events === 1 && brief.gate.busy_channel_events === 40 && brief.gate.measured && brief.gate.measured.new_events === 1 && brief.gate.measured.idle_h === null,
      brief && { gate: brief.gate, root_id: brief.root_id },
    );
    ck.ok(
      "GLEAN-04b-2 brief.gate 新键 busy_channel_events（缺省 40 经 cfg 全键表落 brief，L-12 扩臂）+ cfg 写面同键",
      Boolean(brief) && brief.gate && brief.gate.busy_channel_events === 40 && brief.cfg && Number(brief.cfg.busy_channel_events) === 40,
      brief && { gate: brief.gate, cfg: brief.cfg },
    );
    ck.ok(
      "GLEAN-04c brief watermarks（0/1 实测行数）+ orchtemp_pending + counts",
      Boolean(brief) && brief.watermarks && brief.watermarks.global_lines === 0 && brief.watermarks.project_lines === 1 && Array.isArray(brief.orchtemp_pending) && brief.orchtemp_pending.length === 0 && brief.counts && brief.counts.active === 1 && brief.counts.candidate === 0,
      brief && { wm: brief.watermarks, counts: brief.counts },
    );
    ck.ok(
      "GLEAN-04d brief projects（含启动登记本行）/orch_md/cfg 字段齐全",
      Boolean(brief) && Array.isArray(brief.projects) && brief.projects.length === 1 && brief.projects[0].root_id === rid8 && brief.orch_md && brief.orch_md.exists === false && brief.cfg && Number(brief.cfg.idle_hours) === 0,
      brief && { projects: brief.projects, orch_md: brief.orch_md },
    );

    // ---- v1.3 W3 GLEAN-04d 扩臂：brief.views 块三态（design §3.3 信号腿，五字段全只读；
    //      marker 字段=项目根 AGENTS.md orch-mem 标记对存在性——L-8 语义钉死）。
    //      brief 重建走 G12-b 既有通道（删除后 board/list 同调用重物化）。
    fs.rmSync(path.join(R8, "AGENTS.md"), { force: true }); // 态1 前置清扫：项目根标记对缺席（防夹具演进隐性翻转）
    fs.rmSync(brief8, { force: true });
    await s8.call("board", { action: "list" });
    const bv1 = fs.existsSync(brief8) ? JSON.parse(fs.readFileSync(brief8, "utf8")) : null;
    ck.ok(
      "GLEAN-04d-1 views 全缺：orch_md_exists=false/orch_md_ver=null/global_agents_md_exists=false/global_lib_lines=0/agents_md_marker_exists=false",
      Boolean(bv1 && bv1.views) && bv1.views.orch_md_exists === false && bv1.views.orch_md_ver === null && bv1.views.global_agents_md_exists === false && bv1.views.global_lib_lines === 0 && bv1.views.agents_md_marker_exists === false,
      bv1 && bv1.views,
    );
    // 态2 半缺：全端 AGENTS.md 在场（有 content），ORCH.md/全端库/项目根标记对仍缺
    fs.writeFileSync(path.join(MEM8, "AGENTS.md"), "# 全端记忆（GLEAN04DPROBE）\n- GLEAN04D 全端行\n");
    fs.rmSync(brief8, { force: true });
    await s8.call("board", { action: "list" });
    const bv2 = fs.existsSync(brief8) ? JSON.parse(fs.readFileSync(brief8, "utf8")) : null;
    ck.ok(
      "GLEAN-04d-2 views 半缺：global_agents_md_exists=true 而 orch_md_exists=false/orch_md_ver=null/global_lib_lines=0/agents_md_marker_exists=false",
      Boolean(bv2 && bv2.views) && bv2.views.global_agents_md_exists === true && bv2.views.orch_md_exists === false && bv2.views.orch_md_ver === null && bv2.views.global_lib_lines === 0 && bv2.views.agents_md_marker_exists === false,
      bv2 && bv2.views,
    );
    // 态3 全在：ORCH.md（ver=7 头）+全端库 2 非空行+项目根标记对 全部在场
    fs.writeFileSync(path.join(R8, "ORCH.md"), "<!-- orch-memory ver=7 updated=2026-11-01T00:00:00.000Z -->\n# ORCH.md — 主控记忆\n## 常驻\n- GLEAN04DPROBE 行\n");
    fs.mkdirSync(path.join(MEM8, "memory"), { recursive: true });
    fs.writeFileSync(path.join(MEM8, "memory", "lessons.jsonl"), '{"id":"g04d-a"}\n\n{"id":"g04d-b"}\n'); // 2 非空行（空行不计）
    fs.writeFileSync(
      path.join(R8, "AGENTS.md"),
      "# 测试项目\n\n<!-- orch-mem:begin v1（GLEAN04D 标记区） -->\n- GLEAN04D 标记区行\n<!-- orch-mem:end -->\n",
    );
    fs.rmSync(brief8, { force: true });
    await s8.call("board", { action: "list" });
    const bv3 = fs.existsSync(brief8) ? JSON.parse(fs.readFileSync(brief8, "utf8")) : null;
    ck.ok(
      "GLEAN-04d-3 views 全在：五字段全真且计数正确（orch_md_ver=7/global_lib_lines=2），marker 字段=项目根标记对语义钉死",
      Boolean(bv3 && bv3.views) && bv3.views.orch_md_exists === true && bv3.views.orch_md_ver === 7 && bv3.views.global_agents_md_exists === true && bv3.views.global_lib_lines === 2 && bv3.views.agents_md_marker_exists === true,
      bv3 && bv3.views,
    );

    // ---- glean3（A-v0110-GLEAN3-01）：固定包模板锚 + brief 逐字内嵌
    const packRaw = fs.readFileSync(pack8, "utf8");
    const briefRaw = fs.readFileSync(brief8, "utf8");
    const G13_PINS = [
      "fixed template direct handoff", // 固定物化定性（v1.4 W2 改6 改锚：主控零组装→固定模板直投——server-memory :612 B1 中性化）
      "agents/orch-gleaner.md", // persona 路径（READ FIRST）
      "the three-line contract is governed by the dispatch prompt tail block", // CONTRACT：server 预物化、token 不入包（v1.1 W4 Q5a）
      "glean-brief embedded verbatim", // CONTEXT 节定性
      "authoritative pointer - never hand-write it", // 锁纪律：lock 位置=brief.lock_path（模板事故① 根治口径）
      "Four-state rule", // 候选处置：晋升/合并/退役/保留
      "promote/promote_batch merge semantics via the server", // v1.1 W1 B2：GL-30 括注同步（批入口在案）
      "View-layer boundary", // ORCH.md/标记区/全端 AGENTS.md 写面
      "Report discipline", // 报告=reports/<ts>-glean.md
      "-glean.md", // 报告命名形
      "<= 3-line pointer discipline", // Return 面定性
      "KIND=done + the report path", // Return 行 1
      "report(kind=blocked, question=what the main session must decide).", // 阻塞处置（WK-8 形；v1.4 W2 改7 改锚——server-memory :633 B1 中性化）
    ];
    const g13Misses = G13_PINS.filter((n) => !packRaw.includes(n));
    ck.ok("G13-e 固定包模板锚齐全（persona 路径/锁权威指针/四态/视图层/日志/Return ≤3 行 13 钉）", g13Misses.length === 0, g13Misses);
    ck.ok(
      "G13-f brief 逐字内嵌：brief 文件字节 ⊂ pack 字节（brief 物化后组合，read-back 保真）",
      packRaw.includes(briefRaw),
      { briefLen: briefRaw.length, packLen: packRaw.length },
    );
    const g13CtxAt = packRaw.indexOf("## CONTEXT");
    const g13RfAt = packRaw.indexOf("## READ FIRST");
    let g13LockStray = -1;
    for (let scan = 0; ; ) {
      const i = packRaw.indexOf("glean-lock.json", scan);
      if (i < 0) break;
      if (!(i > g13CtxAt && i < g13RfAt)) {
        g13LockStray = i; // 模板行手写锁路径（应只经 brief.lock_path 内嵌出现）
        break;
      }
      scan = i + 1;
    }
    ck.ok(
      "G13-g 包内锁路径只经 CONTEXT brief 内嵌出现（模板行无手写 glean-lock.json，权威指针勿手写）",
      g13CtxAt >= 0 && g13RfAt > g13CtxAt && g13LockStray < 0,
      { ctxAt: g13CtxAt, rfAt: g13RfAt, strayAt: g13LockStray },
    );

    // ---- v1.4 B1-04：固定包模板零主控语汇（A-V0140-B1-04）——server-memory.mjs pack
    // 模板区（const pack = [ … ].join）grep「主控」=0（B1 白名单中性化落装核验，禁扩大化）。 ----
    const memSrc = fs.readFileSync(path.join(PLUGIN_DIR, "mcp", "server-memory.mjs"), "utf8");
    const tplAt = memSrc.indexOf("const pack = [");
    const tplEnd = tplAt >= 0 ? memSrc.indexOf('].join("\\n");', tplAt) : -1;
    const tplRegion = tplAt >= 0 && tplEnd > tplAt ? memSrc.slice(tplAt, tplEnd) : "";
    const tplHits = (tplRegion.match(/主控/g) || []).length;
    ck.ok(
      "B1-04 固定包模板区零主控语汇（server-memory.mjs pack 模板 grep「主控」=0；B1 中性化=主会话/固定模板直投）",
      tplRegion.length > 0 && tplHits === 0,
      { tplFound: tplAt >= 0 && tplEnd > tplAt, hits: tplHits },
    );

    // ---- GLEAN-02b/c：锁 active+活 PID → 只附 lock_state=busy、无 due 键、不重写 brief
    const briefMtime = fs.statSync(brief8).mtimeMs;
    const packMtime = fs.statSync(pack8).mtimeMs;
    fs.writeFileSync(
      lock8,
      JSON.stringify({ v: 1, state: "active", pid: process.pid, started_at: new Date(Date.now() - 5000).toISOString(), finished_at: null, watermarks: { global_lines: 0, projects: {} } }),
    );
    // v0.10 G2：直写锁后经读回屏障取观测（glean 键可见=server 侧已过 mtime/Date.now 时间门）
    const gb = await gleanAfterWrite(rawCall);
    ck.ok(
      "GLEAN-02b 锁 active 活 PID → 只附 lock_state=busy（无 due/brief_path 键）",
      Boolean(gb) && gb.lock_state === "busy" && !("due" in gb) && !("brief_path" in gb),
      gb,
    );
    ck.ok("GLEAN-02c busy 不物化 brief（brief mtime 未被重写）", fs.statSync(brief8).mtimeMs === briefMtime);
    // glean3：busy 零写面同样覆盖 pack（busy 即退，pack 不重写）
    ck.ok("G13-i busy 锁 → pack 不重写（pack mtime 未被重写，零写面）", fs.statSync(pack8).mtimeMs === packMtime, { packMtime, now: fs.statSync(pack8).mtimeMs });
    const bl2b = await s8.call("board", { action: "list" });
    ck.ok("G12-e busy 锁 → board/list 无 glean_due 键（busy 即退）", bl2b.json && !("glean_due" in bl2b.json), bl2b.json && Object.keys(bl2b.json));
  } finally {
    s8.close();
  }
}
