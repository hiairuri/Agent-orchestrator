// @module crv8-memory/glean-lock
/*!
 * suites/crv8-memory/glean-lock.mjs —— 名册与归敛锁状态机场景（v1.3 W1 拆分，自
 *   crv8-memory.mjs 原样搬运）：GLEAN-06 §6.6 项目名册 + --memory-root 注入（场景9）/
 *   GLEAN-03 §6.4/§9.3 归敛锁状态机全腿（场景10）。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, subRoot, writeJsonl, readJsonl, normPath, gleanAfterWrite, startServer, startServerX, PRE, DEFAULT_SERVER, PLUGIN_DIR } from "./shared.mjs";
import { familySource } from "../../harness/source-family.mjs";

/* ============ 场景 9：GLEAN-06（§6.6 名册 + --memory-root 注入，roots r-reg*） ============ */
export async function scenGlean06() {
  const R9 = subRoot("r-reg");
  const R9b = subRoot("r-reg-b");
  const M9 = subRoot("mem-reg");
  const reg9 = path.join(M9, "projects.jsonl");
  let firstSeen9 = null;
  const s9a = startServerX({ root: R9, args: ["--memory-root", M9] });
  try {
    await s9a.call("lessons", { action: "list" }); // 首调用确认启动侧副作用已落
    ck.ok(
      "GLEAN-06a --memory-root 注入生效：名册写 M、缺省重定向 <root>/orchestrator-memory 不落",
      fs.existsSync(reg9) && !fs.existsSync(path.join(R9, "orchestrator-memory", "projects.jsonl")),
      { reg: fs.existsSync(reg9), deflected: fs.existsSync(path.join(R9, "orchestrator-memory", "projects.jsonl")) },
    );
    const rows9 = readJsonl(reg9);
    const rid9 = fs.readFileSync(path.join(R9, "root-id"), "utf8").trim();
    ck.ok(
      "GLEAN-06b 启动 upsert 恰一行：root_id/project_path/first_seen/last_seen/server_version 齐全",
      rows9.length === 1 && rows9[0].root_id === rid9 && normPath(rows9[0].project_path) === normPath(R9) && typeof rows9[0].first_seen === "string" && rows9[0].last_seen === rows9[0].first_seen && typeof rows9[0].server_version === "string",
      rows9,
    );
    firstSeen9 = rows9.length === 1 ? rows9[0].first_seen : null;
  } finally {
    s9a.close();
  }
  const s9b = startServerX({ root: R9, args: ["--memory-root", M9] });
  try {
    await s9b.call("lessons", { action: "list" });
    const rows92 = readJsonl(reg9);
    ck.ok(
      "GLEAN-06c 复见原地更新：仍一行（不重复追加）、first_seen 保留、last_seen 不早于首见",
      rows92.length === 1 && rows92[0].first_seen === firstSeen9 && String(rows92[0].last_seen) >= String(firstSeen9),
      rows92,
    );
  } finally {
    s9b.close();
  }
  const s9c = startServerX({ root: R9b, args: ["--memory-root", M9] });
  try {
    await s9c.call("lessons", { action: "list" });
    const rows93 = readJsonl(reg9);
    ck.ok(
      "GLEAN-06d 异 project 新 root → 追加一行（每 root_id 恰一行，16hex 稳定键）",
      rows93.length === 2 && rows93.every((x) => typeof x.root_id === "string" && /^[0-9a-f]{16}$/.test(x.root_id)) && rows93[0].root_id !== rows93[1].root_id,
      rows93.map((x) => x.root_id),
    );
  } finally {
    s9c.close();
  }
  // 带锁源码序断言 + 活 PID 占锁行为腿（best-effort 跳过，不阻塞启动）
  // v1.3 切分重基（修复轮 C）：server 读取面走族 helper（薄入口+模块族拼接——名册锁已迁
  // mcp/server-boot.mjs），断言与期望值零改动。
  const srvSrc9 = familySource(PLUGIN_DIR, path.join("mcp", "server.mjs"));
  ck.ok(
    "GLEAN-06e 名册带锁（源码面）：withRegistryLock(upsertProjectRegistry) 启动调用 + .registry.lock + pidAlive 陈旧接管在案",
    srvSrc9.includes("withRegistryLock(upsertProjectRegistry)") && srvSrc9.includes('.registry.lock"') && /function registryLockStale[\s\S]{0,900}?pidAlive/.test(srvSrc9),
    null,
  );
  const busyDir9 = path.join(M9, ".registry.lock");
  fs.mkdirSync(busyDir9, { recursive: true });
  fs.writeFileSync(
    path.join(busyDir9, "owner.json"),
    JSON.stringify({ holder: `pid:${process.pid}`, pid: process.pid, heartbeatAt: new Date().toISOString() }) + "\n",
  );
  const regBefore9 = fs.readFileSync(reg9, "utf8");
  const s9d = startServerX({ root: R9b, args: ["--memory-root", M9] });
  try {
    await s9d.call("lessons", { action: "list" }); // 启动不被锁阻塞，upsert 让空
    ck.ok(
      "GLEAN-06f 锁被活 PID 占有 → 名册零变化（best-effort 跳过）且 server 正常应答",
      fs.readFileSync(reg9, "utf8") === regBefore9,
      null,
    );
  } finally {
    s9d.close();
    fs.rmSync(busyDir9, { recursive: true, force: true });
  }
}

/* ============ 场景 10：GLEAN-03（§6.4/§9.3 归敛锁状态机全腿，root r-glean3） ============ */
export async function scenGlean03() {
  const R11 = subRoot("r-glean3");
  const MEM11 = path.join(R11, "orchestrator-memory"); // 临时根缺省重定向落点
  const lock11 = path.join(MEM11, "glean-lock.json");
  const cfg11 = path.join(MEM11, "glean.cfg.json");
  const brief11 = path.join(MEM11, "glean-brief.json");
  const lib11 = path.join(R11, "memory", "lessons.jsonl");
  // 12 行 active（fresh updated_at 防 housekeep 扰动）：缺省 new_events=10 时事件门可过
  const g3Row = (i) => ({
    v: 1,
    id: `l-20260101-g3${String(i).padStart(2, "0")}`,
    ts: "2026-01-01T00:00:00.000Z",
    updated_at: new Date().toISOString(),
    mission_id: null,
    worker: "t",
    type: "pitfall",
    trigger: `G3PROBE 触发${i}`,
    lesson: "",
    fix: `G3PROBE 修正${i}`,
    confidence: 0.9,
    hits: 5,
    status: "active",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
  });
  fs.mkdirSync(MEM11, { recursive: true }); // spawn 竞态防御：不依赖 server 启动侧先建目录
  writeJsonl(lib11, Array.from({ length: 12 }, (_, i) => g3Row(i + 1)));
  const activeLock11 = (pid, startedAtIso) =>
    JSON.stringify({
      v: 1,
      state: "active",
      pid,
      host: "suite",
      root_id: "r11",
      started_at: startedAtIso,
      finished_at: null,
      watermarks: { global_lines: 0, projects: {} },
    });
  const s11 = startServer({ root: R11 });
  try {
    const rawCall = (name, args) => s11.request("tools/call", { name: PRE + name, arguments: args });
    const gleanOf = (r) => r.result && r.result.orch_memory && r.result.orch_memory.glean;
    fs.writeFileSync(cfg11, JSON.stringify({ idle_hours: 0, new_events: 0 }));

    // ---- GLEAN-03a：wx 抢锁原子（§9.3 抢锁第一步；EEXIST=原子互斥，busy 即退的协议面）
    const doc11 = activeLock11(process.pid, new Date().toISOString());
    fs.writeFileSync(lock11, doc11, { flag: "wx" }); // 无锁 → wx 创建成功（gleaner 抢锁）
    let wxThrew = null;
    try {
      fs.writeFileSync(lock11, doc11, { flag: "wx" });
    } catch (e) {
      wxThrew = e && e.code === "EEXIST" ? "EEXIST" : String(e && e.code);
    }
    ck.ok(
      "GLEAN-03a wx 抢锁原子：无锁 wx 创建成功、再抢 EEXIST 拒绝且原锁内容未被破坏",
      fs.readFileSync(lock11, "utf8") === doc11 && wxThrew === "EEXIST",
      { wxThrew },
    );

    // ---- GLEAN-03b：活 PID 占用拒接管（busy 即退——信号抑制，绝不阻塞等待）
    // v0.10 G2：03b..03d2 均为直写锁后的首读，统一走读回屏障（glean 键可见再断言；
    // ENV-06c 配方）。r 自 03e 起复用（03e/03e2/03g 的缺省/句柄面不走屏障）。
    let r;
    const gb3 = await gleanAfterWrite(rawCall);
    ck.ok(
      "GLEAN-03b 活 PID 占用拒接管：锁 active+活 PID → 只附 lock_state=busy 无 due（不拉起第二归敛）",
      Boolean(gb3) && gb3.lock_state === "busy" && !("due" in gb3) && !("brief_path" in gb3),
      gb3,
    );

    // ---- GLEAN-03c：死 PID 回收（active+死 PID → 可接管，gate 放行 due）
    fs.writeFileSync(lock11, activeLock11(999999901, new Date().toISOString())); // 跨平台必死 PID（WS-9 先例值）
    const gc3 = await gleanAfterWrite(rawCall);
    ck.ok(
      "GLEAN-03c 死 PID 回收：active+死 PID → 可接管（lock_state=idle + due 放行）",
      Boolean(gc3) && gc3.lock_state === "idle" && gc3.due === true,
      gc3,
    );

    // ---- GLEAN-03d：绝对过期 1.5h 回收 + cfg.lock_stale_hours 接线
    fs.writeFileSync(lock11, activeLock11(process.pid, new Date(Date.now() - 2 * 3600000).toISOString()));
    const gd3 = await gleanAfterWrite(rawCall);
    ck.ok(
      "GLEAN-03d 绝对过期回收：活 PID ∧ 龄期 2h > 缺省 1.5h → 可接管（due 放行）",
      Boolean(gd3) && gd3.lock_state === "idle" && gd3.due === true,
      gd3,
    );
    fs.writeFileSync(cfg11, JSON.stringify({ idle_hours: 0, new_events: 0, lock_stale_hours: 9999 }));
    const gd32 = await gleanAfterWrite(rawCall);
    ck.ok(
      "GLEAN-03d2 cfg.lock_stale_hours 接线：9999 → 同一把活 PID 锁翻回 busy（阈值可调生效）",
      Boolean(gd32) && gd32.lock_state === "busy" && !("due" in gd32),
      gd32,
    );
    fs.writeFileSync(cfg11, JSON.stringify({ idle_hours: 50, new_events: 0 }));

    // ---- GLEAN-03e：done 态保留且 mtime 双用（finished_at 优先、mtime 兜底）
    const past11 = new Date(Date.now() - 3 * 86400000);
    fs.writeFileSync(
      lock11,
      JSON.stringify({
        v: 1, state: "done", pid: process.pid, host: "suite", root_id: "r11",
        started_at: past11.toISOString(), finished_at: new Date().toISOString(),
        watermarks: { global_lines: 0, projects: {} },
      }),
    );
    fs.utimesSync(lock11, past11, past11); // 文件 mtime 压到 3 天前（先写后压，勿被写回冲掉）
    r = await rawCall("lessons", { action: "list" });
    ck.ok(
      "GLEAN-03e done 态门①读 finished_at（优先于 mtime）：mtime 3 天前但 finished_at=当下 → idle≈0 < 50h 不放行",
      r.result && !("orch_memory" in r.result),
      { respKeys: r.result && Object.keys(r.result) },
    );
    fs.writeFileSync(
      lock11,
      JSON.stringify({
        v: 1, state: "done", pid: process.pid, host: "suite", root_id: "r11",
        started_at: past11.toISOString(), finished_at: null,
        watermarks: { global_lines: 0, projects: {} },
      }),
    );
    fs.utimesSync(lock11, past11, past11);
    r = await rawCall("lessons", { action: "list" });
    const ge32 = gleanOf(r);
    ck.ok(
      "GLEAN-03e2 mtime 兜底（mtime 双用）：done 无 finished_at → mtime 即上次归敛（3 天前 > 50h → due 放行）",
      Boolean(ge32) && ge32.due === true && ge32.lock_state === "idle",
      ge32,
    );
    ck.ok(
      "GLEAN-03e3 done 态保留：server 全程不删不改锁文件（消费=置状态，§6.3/锁红线）",
      fs.existsSync(lock11) && JSON.parse(fs.readFileSync(lock11, "utf8")).state === "done",
      null,
    );

    // ---- GLEAN-03f：两锁不互嵌（§6.4 W3 收口，源码面机械断言）——server 对归敛锁只读
    // 判锁（busy 即退零阻塞）、名册锁短临界区不触归敛锁：异文件异持有者、无锁序环。
    // v1.3 切分重基（修复轮 C）：server 读取面走族 helper（薄入口+模块族拼接；判锁段 readGleanCfg
    // 已迁 mcp/server-memory.mjs、旧 end 锚 send(msg) 留在入口=族拼接序首位，旧「判锁段→send」
    // 区间序在族面上倒置，故判锁段提取改函数体边界（start→首个 "\n}\n"，dispatch-supply 同款先例）；
    // regSlice 两锚同迁 mcp/server-boot.mjs 保序不动。断言与期望值零改动。
    const srvSrc11 = familySource(PLUGIN_DIR, path.join("mcp", "server.mjs"), { lf: true });
    const gStart11 = srvSrc11.indexOf("function readGleanCfg");
    const gEnd11 = srvSrc11.indexOf("\n}\n", gStart11);
    const gleanSlice11 = srvSrc11.slice(gStart11, gEnd11);
    const regSlice11 = srvSrc11.slice(
      srvSrc11.indexOf("function withRegistryLock"),
      srvSrc11.indexOf("/** One registry row per root_id"),
    );
    ck.ok(
      "GLEAN-03f 两锁不互嵌（源码面）：glean 判锁段零 withRootLock/withRegistryLock 调用 + withRegistryLock 函数体零 glean-lock 触碰",
      gStart11 >= 0 && gEnd11 > gStart11 && !gleanSlice11.includes("withRootLock(") && !gleanSlice11.includes("withRegistryLock(") && regSlice11.includes("function withRegistryLock") && !regSlice11.includes("glean-lock"),
      { gStart11, gEnd11 },
    );

    // ---- GLEAN-03g：cfg junk 逐键兜底（W3 任务③ 默认值兜底，经 brief.cfg 端到端观察；
    //      pack_global_section 缺省自 v0.9 W3 C6/HOST-01b 起为 false——用户级注入面复核
    //      结论=存在，全端节改显式 opt-in，junk 回落值随缺省翻转；v1.3 W1 扩 busy_channel_events
    //      junk 回落臂：junk/负值→40，0=合法关断不回落）
    fs.writeFileSync(
      cfg11,
      JSON.stringify({ idle_hours: "abc", new_events: -5, lock_stale_hours: 0, pack_global_section: "nope", busy_channel_events: "junk" }),
    );
    r = await rawCall("lessons", { action: "list" });
    const gg3 = gleanOf(r);
    const briefG3 = fs.existsSync(brief11) ? JSON.parse(fs.readFileSync(brief11, "utf8")) : null;
    ck.ok(
      "GLEAN-03g cfg junk 逐键兜底：idle_hours/new_events/lock_stale_hours/pack_global_section/busy_channel_events 全回落内建默认（48/10/1.5/false〔v0.9 C6 翻转〕/40〔v1.3 W1〕）",
      Boolean(gg3) && gg3.due === true && Boolean(briefG3) && briefG3.cfg.idle_hours === 48 && briefG3.cfg.new_events === 10 && briefG3.cfg.lock_stale_hours === 1.5 && briefG3.cfg.pack_global_section === false && briefG3.cfg.busy_channel_events === 40,
      briefG3 && briefG3.cfg,
    );
  } finally {
    s11.close();
  }
}
