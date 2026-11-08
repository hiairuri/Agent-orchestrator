// @module sentinel-teardown/t4-t6
/*!
 * suites/sentinel-teardown/t4-t6.mjs —— T4 标记/槽位容错与混跑兼容 / T5 v1.6.5 fire-on-dead
 * （FOD-dead/-running/-uncorr 三腿+O-2 降级刻度+O-1 coordinator fast path 双臂+GRACE-COPY；db 夹具+SKIP 守卫）/
 * T6 V6-54/V6-55 claimShots 同名互斥 + touchSlot pid 归属校验（含黑盒集成幽灵让位）
 * （自 sentinel-teardown.mjs 初步切分拆出，v1.3；T5 于 v1.6.5 按 grill#1 ruling 3 重写）
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function run(ctx) {
  const { ck, PLUGIN_DIR, SENTINEL, BASE, ROOT, SENT_DIR, MARKER, ECHO, SID, sleep, waitFor, readJson, countLines, slotFile, writeBoard, spawnSentinel, writeMarker } = ctx;

  // ---- T4 标记/槽位容错与混跑兼容
  {
    // T4a 陈旧标记 → 夺位成为唯一赢家
    writeMarker(Date.now() - 60000);
    const bgA = spawnSentinel({ lifetimeMin: 0.02 });
    const rA = await Promise.race([bgA.done, sleep(10000).then(() => null)]);
    const mA = readJson(MARKER);
    ck.ok("T4a 陈旧标记夺位：唯一赢家退出", Boolean(rA) && rA.code === 0 && rA.stdout.includes("轮换") && mA && mA.pid === bgA.proc.pid, { code: rA && rA.code, marker: mA });
  }
  {
    // T4b 损坏标记 → 修复并认领
    fs.mkdirSync(SENT_DIR, { recursive: true });
    fs.writeFileSync(MARKER, "not-json{{{");
    const bgB = spawnSentinel({ lifetimeMin: 0.02 });
    const rB = await Promise.race([bgB.done, sleep(10000).then(() => null)]);
    const mB = readJson(MARKER);
    ck.ok("T4b 损坏标记修复且赢家退出", Boolean(rB) && rB.code === 0 && mB && mB.pid === bgB.proc.pid, { code: rB && rB.code, marker: mB });
  }
  {
    // T4c 新鲜标记 → 输家顺延（过原寿命仍存活），下轮成为赢家退出
    writeMarker(Date.now());
    const bgC = spawnSentinel({ lifetimeMin: 0.07 }); // 4.2s
    await sleep(2500);
    writeMarker(Date.now()); // 到期前刷新标记（模拟同轮其他赢家刚轮换过）
    await sleep(3600); // t≈6.1s > 寿命 4.2s
    const aliveAfterLifetime = bgC.proc.exitCode === null;
    const rC = await Promise.race([bgC.done, sleep(12000).then(() => null)]);
    ck.ok(
      "T4c 新鲜标记顺延（过原寿命仍存活）且下轮赢家退出",
      aliveAfterLifetime && Boolean(rC) && rC.code === 0 && rC.stdout.includes("轮换"),
      { aliveAfterLifetime, code: rC && rC.code },
    );
  }
  {
    // T4d/T4e 旧格式槽位（无 state 字段）共存：不接管不 fatal，新实例认领下一槽位
    writeBoard([{ id: "m-closed4", title: "quiet", status: "closed" }]);
    fs.mkdirSync(SENT_DIR, { recursive: true });
    fs.writeFileSync(
      slotFile(0),
      JSON.stringify({ pid: process.pid, slot: 0, started_at: new Date().toISOString(), heartbeatAt: new Date().toISOString() }) + "\n",
    );
    const bgD = spawnSentinel({});
    const claimed = await waitFor(() => fs.existsSync(slotFile(1)), 6000);
    const mine = readJson(slotFile(1));
    const old0 = readJson(slotFile(0));
    ck.ok(
      "T4d 旧格式新鲜槽位不接管，新实例认领下一槽位",
      claimed && mine && mine.pid === bgD.proc.pid && old0 && !("state" in old0) && old0.pid === process.pid,
      { mine, old0Keys: old0 && Object.keys(old0) },
    );
    ck.ok("T4e 新槽位带 state 字段（active/standby 容错写入）", Boolean(mine) && (mine.state === "active" || mine.state === "standby"), mine);
    bgD.kill();
    await bgD.done;
  }

  // ---- T5 v1.6.5 fire-on-dead（grill#1 ruling 3：旧保守档整拆）+ O-1 coordinator fast path +
  //      O-2 降级刻度重推导 + copy 成真化（A-v0165-FOD-dead/-uncorr/-running/-DEMOTE/-COORD-FAST/-GRACE-COPY）
  {
    // 加速刻度（每子腿自写 cfg）：crash=0.01(0.6s) 或 0.02(1.2s)、stall=0.1(6s)、coord-idle=0.01(0.6s)。
    // tool_usage 夹具库（node:sqlite 写夹具——哨兵侧只读红线不涉，夹具造库属测试面写；
    // journal_mode=DELETE 防 WAL 尾巴）。SKIP 守卫：node:sqlite 缺席（Node <22.5）→ db 腿
    // 计账 SKIP（断言名带 [SKIP] 标记容错先例=v1.6.2 四腿缺席容错）；非 db 腿照跑。
    const ROLLOUT = path.join(BASE.root, "rollout-fixture");
    fs.mkdirSync(ROLLOUT, { recursive: true });
    const DB_PATH = path.join(ROOT, "toolusage-fixture.sqlite");
    const DB_ABSENT = path.join(ROOT, "toolusage-absent.sqlite");
    let DatabaseSync = null;
    try {
      DatabaseSync = (await import("node:sqlite")).DatabaseSync;
    } catch {
      /* node:sqlite 不可用 → db 腿 SKIP 计账 */
    }
    const makeDb = (rows) => {
      try {
        fs.rmSync(DB_PATH, { force: true });
        const db = new DatabaseSync(DB_PATH);
        db.exec("CREATE TABLE tool_usage (id INTEGER PRIMARY KEY, session_id TEXT, status TEXT, started_at INTEGER)");
        db.exec("PRAGMA journal_mode = DELETE");
        for (const r of rows) {
          db.prepare("INSERT INTO tool_usage (session_id, status, started_at) VALUES (?, ?, ?)").run(r.sid, r.status, r.startedAt);
        }
        db.close();
        return true;
      } catch {
        return false;
      }
    };
    const writeCfg5 = (over = {}) => {
      fs.writeFileSync(
        path.join(ROOT, "sentinel.cfg.json"),
        JSON.stringify({
          stall_grace_min: 0.1,
          crash_grace_min: 0.01,
          coord_idle_min: 0.01,
          signals: { rollout_dir: ROLLOUT, tool_usage_db: DB_PATH },
          ...over,
        }) + "\n",
      );
    };
    const backdate = (f, ms) => {
      const t = new Date(Date.now() - ms);
      fs.utimesSync(f, t, t);
    };
    const writeHeartbeat = (sessionId, ageMs) => {
      const f = path.join(ROLLOUT, `model-io-${sessionId}.jsonl`);
      fs.writeFileSync(f, JSON.stringify({ completedAt: new Date(Date.now() - ageMs).toISOString() }) + "\n");
      backdate(f, ageMs); // 心跳 = max(mtime, completedAt)，两者都须陈旧
    };
    const firedNames5 = (prefix) => {
      try {
        return fs.readdirSync(path.join(SENT_DIR, "fired")).filter((n) => n.startsWith(prefix));
      } catch {
        return [];
      }
    };
    const agentRow = (id, extra = {}) => ({
      id: `m-${id.slice("agent_".length) || id}`,
      title: "t5-fixture",
      status: "running",
      dispatch: { agent_id: id, mode: "agent", session_id: SID },
      ...extra,
    });
    // 会话键形=classify 消费模板 `sess_subagent_agent_${agentId}`（agentId 本身带 agent_ 前缀 →
    // 键出现双 agent 段=sentinel-teardown 既有夹具同形，旧 T5 writeHeartbeat 模板同款）。
    const agentKey = (id) => `sess_subagent_agent_${id}`;

    // T5a A-v0165-FOD-dead 正腿（黑盒）：双信号合取成立（心跳停更 8s ≥ crash 0.6s ∧ db 实锤无
    // running 行）→ crash 直开（bypass 双空闲门；板面新鲜反证不成立不降级；crashGrace 刻度）。
    if (DatabaseSync && makeDb([])) {
      writeCfg5();
      writeHeartbeat(agentKey("agent_b2a"), 8000);
      writeBoard([agentRow("agent_b2a")]);
      const bgA5 = spawnSentinel({});
      const rA5 = await Promise.race([bgA5.done, sleep(12000).then(() => null)]);
      ck.ok(
        "T5a A-v0165-FOD-dead fire-on-dead positive: heartbeat stale >= crashGrace AND no running row -> crash alert fires at crashGrace scale (bypasses the dual-idle gate; fresh board, no demotion)",
        Boolean(rA5) && rA5.code === 1 && rA5.stdout.includes("suspected crash alert") && firedNames5("m-b2a--crash--").length >= 1,
        rA5 && { code: rA5.code, hasCrash: rA5.stdout.includes("suspected crash alert"), fired: firedNames5("m-b2a--") },
      );
    } else {
      ck.ok("T5a A-v0165-FOD-dead [SKIP: node:sqlite unavailable on this node (db fixture legs accounted; v1.6.2 absent-tolerance precedent)]", true);
    }

    // T5b A-v0165-FOD-running 守卫腿（黑盒）：db 有 running 行（长工具在跑）→ 无 crash
    //（fire-on-dead 死亡证据不成立；本 tick 无 C3；板面/任务新鲜 → 零告警轮换退出）。
    if (DatabaseSync && makeDb([{ sid: agentKey("agent_b2r"), status: "running", startedAt: Date.now() - 1000 }])) {
      writeCfg5();
      writeHeartbeat(agentKey("agent_b2r"), 8000);
      writeBoard([agentRow("agent_b2r")]);
      const bgB5r = spawnSentinel({ lifetimeMin: 0.02 });
      const rB5r = await Promise.race([bgB5r.done, sleep(12000).then(() => null)]);
      ck.ok(
        "T5b A-v0165-FOD-running guard: running row present (long tool call) -> NO crash alert (death evidence requires both signals)",
        Boolean(rB5r) && rB5r.code === 0 && !rB5r.stdout.includes("suspected crash alert") && firedNames5("m-b2r--crash--").length === 0,
        rB5r && { code: rB5r.code, hasCrash: rB5r.stdout.includes("suspected crash alert"), fired: firedNames5("m-b2r--") },
      );
    } else {
      ck.ok("T5b A-v0165-FOD-running [SKIP: node:sqlite unavailable on this node (db fixture legs accounted; v1.6.2 absent-tolerance precedent)]", true);
    }

    // T5c A-v0165-FOD-uncorr 守卫腿（黑盒；无 db 依赖，SQLITE 缺席环境同判）：佐证不可用
    //（db 路径不存在 → open 失败 → null）→ 无 crash（旧语义=无佐证走保守档仍开枪，本腿=语义
    // 反转自证；落 C2 链承接，板面新鲜 → 零告警轮换退出）。
    writeCfg5({ signals: { rollout_dir: ROLLOUT, tool_usage_db: DB_ABSENT } });
    writeHeartbeat(agentKey("agent_b2u"), 8000);
    writeBoard([agentRow("agent_b2u")]);
    const bgB5u = spawnSentinel({ lifetimeMin: 0.02 });
    const rB5u = await Promise.race([bgB5u.done, sleep(12000).then(() => null)]);
    ck.ok(
      "T5c A-v0165-FOD-uncorr guard: corroboration unavailable (db absent -> null) -> NO crash alert (old x3-uncorroborated tier removed; falls to the C2 chain)",
      Boolean(rB5u) && rB5u.code === 0 && !rB5u.stdout.includes("suspected crash alert") && firedNames5("m-b2u--crash--").length === 0,
      rB5u && { code: rB5u.code, hasCrash: rB5u.stdout.includes("suspected crash alert"), fired: firedNames5("m-b2u--") },
    );

    // T5d A-v0165-DEMOTE（黑盒）：C3 条件成立但 lastActivity 与 board mtime 双陈旧（8s ≥ 降级刻度
    // laStale=max(stall 6s, crash 0.6s)、boardStale=stall 6s——O-2 重推导默认 30/30 行为不变的
    // 加速投影）→ C3 降级 C2 inflight_stall 受双空闲门（板面陈旧 → 门开），不出 crash。
    if (DatabaseSync && makeDb([])) {
      writeCfg5();
      writeHeartbeat(agentKey("agent_b2b"), 8000);
      writeBoard([agentRow("agent_b2b", { updated_at: new Date(Date.now() - 8000).toISOString() })]);
      backdate(path.join(ROOT, "board.json"), 8000);
      const bgB5 = spawnSentinel({});
      const rB5 = await Promise.race([bgB5.done, sleep(12000).then(() => null)]);
      ck.ok(
        "T5d A-v0165-DEMOTE: double-stale (lastActivity AND board mtime past the re-derived scales max(stall,crash)/stall) -> C3 demotes to C2 inflight_stall behind the dual-idle gate, no crash (O-2 behavior pin)",
        Boolean(rB5) && rB5.code === 1 && rB5.stdout.includes("in-flight age alert") && !rB5.stdout.includes("suspected crash alert") && firedNames5("m-b2b--inflight_stall--").length >= 1 && firedNames5("m-b2b--crash--").length === 0,
        rB5 && { code: rB5.code, stall: rB5.stdout.includes("in-flight age alert"), crash: rB5.stdout.includes("suspected crash alert"), fired: firedNames5("m-b2b--") },
      );
    } else {
      ck.ok("T5d A-v0165-DEMOTE [SKIP: node:sqlite unavailable on this node (db fixture legs accounted; v1.6.2 absent-tolerance precedent)]", true);
    }

    // T5e A-v0165-COORD-FAST 正臂（黑盒；双臂核验 r2 F6）：主控死亡三证（主控心跳停更 3s ∧
    // 无 running 行 ∧ MAX(started_at) 停更 3s，全 ≥ crash 1.2s）→ C2 以 crashGrace 刻度开枪
    //（anchor=死亡证据时刻；板面行新鲜——「不管板面行多新鲜」）。判别式：无 fast path 时该
    // 配置最早开枪时点 = stall(6s)−0 ≈ 6s+，4s 竞速界把两臂分开；worker 心跳缺席 → 无 C3。
    if (DatabaseSync && makeDb([{ sid: "sess_coord", status: "done", startedAt: Date.now() - 3000 }])) {
      writeCfg5({ crash_grace_min: 0.02 });
      writeHeartbeat("sess_coord", 3000);
      writeBoard([agentRow("agent_cf", { title: "coord-fast-fresh-board" })]);
      const bgC5 = spawnSentinel({});
      const rC5 = await Promise.race([bgC5.done, sleep(4000).then(() => null)]);
      ck.ok(
        "T5e A-v0165-COORD-FAST death-evidence arm: coordinator three-evidence -> inflight_stall fires at crashGrace scale (anchor=death evidence; escape effective at 2x10=20 min equivalent) even with a fresh board row, no crash leg",
        Boolean(rC5) && rC5.code === 1 && rC5.stdout.includes("in-flight age alert") && !rC5.stdout.includes("suspected crash alert") && firedNames5("m-cf--inflight_stall--").length >= 1,
        rC5 && { code: rC5.code, stall: rC5.stdout.includes("in-flight age alert"), crash: rC5.stdout.includes("suspected crash alert"), fired: firedNames5("m-cf--") },
      );
    } else {
      ck.ok("T5e A-v0165-COORD-FAST [SKIP: node:sqlite unavailable on this node (db fixture legs accounted; v1.6.2 absent-tolerance precedent)]", true);
    }

    // T5f A-v0165-COORD-FAST 单元双臂 + A-v0165-GRACE-COPY（镜像直导入=T6-pre 同法；
    // buildSummary 直跑腿）：正臂=三证 → cond.graceMs===crashGraceMs ∧ anchorMs===max(心跳,started_at)
    // （死亡证据 anchor）；负臂=started_at 新鲜（三证缺一）→ graceMs===stallGraceMs（30 刻度照旧，
    // r2 F6 无三证臂 2×30=60 不变）；copy=done/blocked-question 宽限渲染 cfg 值 ∧ stall grace 渲染
    // 条件实际值（fast path 臂=crash 刻度）∧ crash copy 无 x3 句。
    if (DatabaseSync && makeDb([])) {
      const MODDIR = path.join(PLUGIN_DIR, "hooks", "bg-sentinel");
      const LIBDIR = path.join(BASE.root, "lib5", "hooks", "bg-sentinel");
      let lib5 = null;
      try {
        fs.mkdirSync(LIBDIR, { recursive: true });
        for (const f of fs.readdirSync(MODDIR).sort()) {
          if (f.endsWith(".mjs")) fs.copyFileSync(path.join(MODDIR, f), path.join(LIBDIR, f));
        }
        lib5 = await import(pathToFileURL(path.join(LIBDIR, "classify.mjs")).href);
      } catch {
        lib5 = null;
      }
      ck.ok("T5f-pre 哨兵族模块镜像可剥（classify 直导入，T6-pre 同法）", lib5 != null, lib5 ? "classify mirror import ok" : "classify mirror import failed");
      if (lib5) {
        const UROOT = path.join(BASE.root, "unit5-root");
        const HB_MS = Date.now() - 3000;
        const MX_MS = Date.now() - 3000;
        const mission5 = () => ({
          id: "m-u5",
          title: "unit-coord-fast",
          status: "running",
          dispatch: { agent_id: "agent_u5", mode: "agent", session_id: SID },
        });
        const cfg5 = {
          wakeGraceMs: 120000,
          answerGraceMs: 180000,
          stallGraceMs: 6000,
          crashGraceMs: 1200,
          coordIdleMs: 600,
          cap: 3,
        };
        const run5 = () => {
          try {
            fs.mkdirSync(path.join(UROOT, "sentinel"), { recursive: true });
            fs.writeFileSync(path.join(UROOT, "sentinel", "coord-session.txt"), SID + "\n");
            return lib5.classify(
              { missions: [mission5()] },
              Date.now(), // board mtime 新鲜
              cfg5,
              UROOT,
              // signals 形=sentinel-teardown 夹具惯用直构面；coordSessionFile 必载（coordSessionId
              // 消费面硬依赖——缺键 TypeError 会整套崩，T6-pre 镜像导入惯例无此键因不触该函数）
              { rolloutDir: ROLLOUT, toolUsageDb: DB_PATH, coordSessionFile: "sentinel/coord-session.txt" },
            );
          } catch (e) {
            return [{ category: "__fixture_error__", error: String((e && e.stack) || e) }];
          }
        };
        // 正臂：三证齐（心跳 3s 陈旧 + 无 running + started_at 3s 陈旧，全 ≥ crash 1.2s）
        makeDb([{ sid: SID, status: "done", startedAt: MX_MS }]);
        const posConds = run5();
        const posStall = posConds.find((c) => c.category === "inflight_stall");
        ck.ok(
          "T5f A-v0165-COORD-FAST unit positive: three-evidence -> inflight_stall graceMs === crashGraceMs AND anchorMs === max(heartbeat, started_at) (death-evidence anchor)",
          Boolean(posStall) && posStall.graceMs === cfg5.crashGraceMs && posStall.anchorMs === Math.max(HB_MS, MX_MS),
          posStall ? { graceMs: posStall.graceMs, anchorDelta: posStall.anchorMs - Math.max(HB_MS, MX_MS) } : posConds.map((c) => c.category),
        );
        // 负臂：started_at 新鲜（三证缺一）→ fast path 关 → stallGrace 刻度照旧
        makeDb([{ sid: SID, status: "done", startedAt: Date.now() - 100 }]);
        const negConds = run5();
        const negStall = negConds.find((c) => c.category === "inflight_stall");
        ck.ok(
          "T5f A-v0165-COORD-FAST unit negative: three-evidence incomplete (fresh started_at) -> graceMs === stallGraceMs (30-min chain unchanged; escape stays 2x30 equivalent)",
          Boolean(negStall) && negStall.graceMs === cfg5.stallGraceMs,
          negStall ? { graceMs: negStall.graceMs } : negConds.map((c) => c.category),
        );
        // A-v0165-GRACE-COPY：buildSummary 直跑（copy 成真化四面）
        const sumCfg = { wakeGraceMs: 120000, answerGraceMs: 180000, stallGraceMs: 1800000, crashGraceMs: 600000, cap: 3 };
        const sumDone = lib5.buildSummary(
          [{ category: "unclaimed_terminal", key: "m1", title: "t", status: "done", resultAt: "2026-11-08T00:00:00Z", resultAgeMin: 5, anchorMs: 0, graceMs: 120000, bypassGate: false }],
          sumCfg,
        );
        const sumStallFast = lib5.buildSummary(
          [{ category: "inflight_stall", key: "m2", title: "t", status: "running", stallAgeMin: 12, anchorMs: 0, graceMs: 600000, bypassGate: false }],
          sumCfg,
        );
        const sumStallNorm = lib5.buildSummary(
          [{ category: "inflight_stall", key: "m3", title: "t", status: "running", stallAgeMin: 31, anchorMs: 0, graceMs: 1800000, bypassGate: false }],
          sumCfg,
        );
        const sumCrash = lib5.buildSummary(
          [{ category: "crash", key: "m4", title: "t", status: "running", ageMs: 700000, anchorMs: 0, graceMs: 600000, bypassGate: true }],
          sumCfg,
        );
        const sumDoneOverride = lib5.buildSummary(
          [{ category: "unclaimed_terminal", key: "m1", title: "t", status: "done", resultAt: "2026-11-08T00:00:00Z", resultAgeMin: 5, anchorMs: 0, graceMs: 300000, bypassGate: false }],
          { ...sumCfg, wakeGraceMs: 300000 },
        );
        ck.ok(
          "A-v0165-GRACE-COPY summary truthing: done/blocked-question graces rendered from cfg (default 2/3) ∧ CLI override reflected (5) ∧ stall grace renders the conditional actual grace (fast-path arm 10, normal arm 30) ∧ crash copy carries no x3-conservative phrase",
          sumDone.includes("done 2 min / blocked-question 3 min") &&
            sumDoneOverride.includes("done 5 min") &&
            sumStallFast.includes("grace 10 min") &&
            sumStallNorm.includes("grace 30 min") &&
            !sumCrash.includes("x3 conservative"),
          { done: sumDone.includes("done 2 min / blocked-question 3 min"), ovr: sumDoneOverride.includes("done 5 min"), fast: sumStallFast.includes("grace 10 min"), norm: sumStallNorm.includes("grace 30 min"), x3: sumCrash.includes("x3 conservative") },
        );
      }
    } else {
      ck.ok("T5f A-v0165-COORD-FAST unit + A-v0165-GRACE-COPY [SKIP: node:sqlite unavailable on this node (db fixture legs accounted; v1.6.2 absent-tolerance precedent)]", true);
    }

    try {
      fs.rmSync(path.join(ROOT, "sentinel.cfg.json"), { force: true }); // 卫生：不污染后续（本块为末块）
      fs.rmSync(DB_PATH, { force: true });
    } catch {
      /* best effort */
    }
  }

  // ---- T6 V6-54/V6-55（B4 末波）：claimShots 去 pid 同名互斥 + touchSlot pid 归属校验
  {
    // 单元层准备：族模块镜像直导入（v1.3 切分重基，glean-launch G5-pre 同款——薄入口化后旧
    // 「剥入口 try{main()}catch 尾+手工补 export」失效：相对 import 临时目录不可解析+函数体
    // 已迁子模块；claimShots=fired.mjs / touchSlot=family.mjs 均正式导出，子模块 import 面
    // 全在族目录内+node 内建，整目录镜像即解析完备；黑盒测不到的函数级行为照旧）。
    const MODDIR = path.join(PLUGIN_DIR, "hooks", "bg-sentinel");
    const LIBDIR = path.join(BASE.root, "lib", "hooks", "bg-sentinel");
    let lib = null;
    try {
      fs.mkdirSync(LIBDIR, { recursive: true });
      for (const f of fs.readdirSync(MODDIR).sort()) {
        if (f.endsWith(".mjs")) fs.copyFileSync(path.join(MODDIR, f), path.join(LIBDIR, f));
      }
      lib = {
        ...(await import(pathToFileURL(path.join(LIBDIR, "fired.mjs")).href)),
        ...(await import(pathToFileURL(path.join(LIBDIR, "family.mjs")).href)),
      };
    } catch {
      lib = null;
    }
    ck.ok("T6-pre 哨兵入口结构可剥（无漂移）", lib != null, lib ? "family mirror import ok" : "family mirror import failed");
    if (lib) {

      // T6a V6-55：touchSlot 前 pid 归属校验——他人槽位让位（不覆盖心跳），自己槽位照常保鲜
      const UROOT = path.join(BASE.root, "unit-root");
      const USENT = path.join(UROOT, "sentinel");
      fs.mkdirSync(USENT, { recursive: true });
      const uslot = path.join(USENT, "instance-0.json");
      fs.writeFileSync(uslot, JSON.stringify({ pid: 999999901, slot: 0, heartbeatAt: "2020-01-01T00:00:00.000Z" }) + "\n");
      lib.touchSlot(USENT, 0, Date.now(), false, null, "active", UROOT);
      const ghost = readJson(uslot);
      ck.ok(
        "T6a 他人槽位让位：touch 不覆盖（被接管者退为无槽幽灵的前提）",
        ghost && ghost.pid === 999999901 && ghost.heartbeatAt === "2020-01-01T00:00:00.000Z",
        ghost,
      );
      fs.writeFileSync(uslot, JSON.stringify({ pid: process.pid, slot: 0, heartbeatAt: "2020-01-01T00:00:00.000Z" }) + "\n");
      lib.touchSlot(USENT, 0, Date.now(), false, null, "standby", UROOT);
      const mine = readJson(uslot);
      ck.ok(
        "T6a 自己槽位照常保鲜（心跳刷新 + state 写入，待命制零冲突）",
        mine && mine.pid === process.pid && mine.state === "standby" && mine.heartbeatAt !== "2020-01-01T00:00:00.000Z",
        mine,
      );

      // T6b V6-54：claimShots 同名互斥（固定时钟——文件名不再含 pid，同名预占 → wx EEXIST 恰一成功）
      const FROOT = path.join(BASE.root, "fired-root");
      const UFIRED = path.join(FROOT, "sentinel", "fired");
      const FIXED = 1700000000000;
      const UCFG = { refireGapMs: 300000, capWindowMs: 3600000, cap: 3, stallGraceMs: 60000, crashGraceMs: 60000 };
      const realNow = Date.now;
      Date.now = () => FIXED;
      try {
        // 正例：空 fired 目录 → 恰认领 1 条；文件名 = key--category--ms.json（无 pid 段）
        const claims = lib.claimShots(FROOT, [{ key: "m-u1", category: "unclaimed_terminal", title: "t", status: "done" }], UCFG, 7);
        const expectName = `m-u1--unclaimed_terminal--${FIXED}.json`;
        ck.ok(
          "T6b 去 pid 文件名（同毫秒同条件 → 同名，互斥前提成立）",
          claims.length === 1 && fs.existsSync(path.join(UFIRED, expectName)),
          { claims: claims.length, expectName, got: fs.existsSync(UFIRED) ? fs.readdirSync(UFIRED) : null },
        );
        // 反例：同名预占（at 陈旧出 refireGap → 仲裁放行）→ 第二写同名 EEXIST → 0 认领、文件仍 1 条
        fs.writeFileSync(
          path.join(UFIRED, `m-u2--unclaimed_terminal--${FIXED}.json`),
          JSON.stringify({ at: new Date(FIXED - 600000).toISOString(), key: "m-u2", category: "unclaimed_terminal" }) + "\n",
        );
        const claims2 = lib.claimShots(FROOT, [{ key: "m-u2", category: "unclaimed_terminal", title: "t", status: "done" }], UCFG, 7);
        const left = fs.readdirSync(UFIRED).filter((n) => n.startsWith("m-u2--"));
        ck.ok(
          "T6b 同名预占第二写失败（wx「恰一成功」互斥恢复，双开枪 TOCTOU 窗消除）",
          claims2.length === 0 && left.length === 1,
          { claims2: claims2.length, left },
        );
      } finally {
        Date.now = realNow;
      }
    }

    // T6c 黑盒集成：实例 A 待命后槽位被他人接管（新鲜心跳+异 pid）→ A 每 tick 让位，
    // 槽位 pid/心跳保持接管者；A 不退不闹（幽灵只损失观测在岗性，仲裁防双开枪兜底）。
    // 卫生：清掉前序块遗留槽位（保证 bg6 认领 slot 0）；告警面用前后快照（ECHO/fired
    // 自 T2 起就存在，不能断言"不存在"）。
    for (const n of fs.readdirSync(SENT_DIR).filter((n) => /^instance-\d+\.json$/.test(n))) {
      fs.rmSync(path.join(SENT_DIR, n), { force: true });
    }
    const echoBefore6 = countLines(ECHO);
    const firedBefore6 = (() => {
      try {
        return fs.readdirSync(path.join(SENT_DIR, "fired")).length;
      } catch {
        return 0;
      }
    })();
    writeBoard([{ id: "m-closed6", title: "quiet", status: "closed" }]);
    const bg6 = spawnSentinel({ standbyPollSec: 1 });
    const claimed6 = await waitFor(() => {
      const d = readJson(slotFile(0));
      return d && d.pid === bg6.proc.pid;
    }, 8000);
    const TAKEOVER = {
      pid: process.pid,
      slot: 0,
      state: "active",
      started_at: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    fs.writeFileSync(slotFile(0), JSON.stringify(TAKEOVER) + "\n");
    await sleep(3200); // ≥3 个 tick（心跳 touch 每 tick 尝试，均应让位）
    const after6 = readJson(slotFile(0));
    const firedAfter6 = (() => {
      try {
        return fs.readdirSync(path.join(SENT_DIR, "fired")).length;
      } catch {
        return 0;
      }
    })();
    ck.ok(
      "T6c 接管后被接管者持续让位（槽位 pid/心跳保持接管者）",
      Boolean(claimed6) && after6 && after6.pid === process.pid && after6.heartbeatAt === TAKEOVER.heartbeatAt,
      { claimed6, after6 },
    );
    ck.ok(
      "T6c 幽灵不退不闹（存活 + 回声/fired 零新增）",
      bg6.proc.exitCode === null && countLines(ECHO) === echoBefore6 && firedAfter6 === firedBefore6,
      { alive: bg6.proc.exitCode === null, echoBefore6, echoAfter6: countLines(ECHO), firedBefore6, firedAfter6 },
    );
    bg6.kill();
    await bg6.done;
  }
}
