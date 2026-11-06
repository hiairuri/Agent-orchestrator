// @module sentinel-teardown/t4-t6
/*!
 * suites/sentinel-teardown/t4-t6.mjs —— T4 标记/槽位容错与混跑兼容 / T5 V6-32 板面龄期反证 /
 * T6 V6-54/V6-55 claimShots 同名互斥 + touchSlot pid 归属校验（含黑盒集成幽灵让位）
 * （自 sentinel-teardown.mjs 初步切分拆出，v1.3；断言本体逐字搬运零改动）
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

  // ---- T5 V6-32 板面龄期反证（stall 对照 crash，加速参数驱动）
  {
    // 加速刻度：crash=0.6s（佐证缺失 → 保守档 ×3=1.8s 触发 C3 候选）、stall=6s、coord-idle=0.6s。
    // 统一龄期 8s：≥ crash×3（C3 候选成立）、≥ max(stall, crash×3)（反证可成立）、< 2×stall=12s（C2 逃逸口关闭，
    // T5b 能开枪只能走「双空闲门开」路径——板面陈旧 → coordBusy 兜底档判空闲）。
    const ROLLOUT = path.join(BASE.root, "rollout-fixture");
    fs.mkdirSync(ROLLOUT, { recursive: true });
    fs.writeFileSync(
      path.join(ROOT, "sentinel.cfg.json"),
      JSON.stringify({ stall_grace_min: 0.1, crash_grace_min: 0.01, coord_idle_min: 0.01, signals: { rollout_dir: ROLLOUT } }) + "\n",
    );
    const AGE_MS = 8000;
    const backdate = (f) => {
      const t = new Date(Date.now() - AGE_MS);
      fs.utimesSync(f, t, t);
    };
    const writeHeartbeat = (agentId) => {
      const f = path.join(ROLLOUT, `model-io-sess_subagent_agent_${agentId}.jsonl`);
      fs.writeFileSync(f, JSON.stringify({ completedAt: new Date(Date.now() - AGE_MS).toISOString() }) + "\n");
      backdate(f); // 心跳 = max(mtime, completedAt)，两者都须陈旧
    };
    const firedNames5 = (prefix) => {
      try {
        return fs.readdirSync(path.join(SENT_DIR, "fired")).filter((n) => n.startsWith(prefix));
      } catch {
        return [];
      }
    };

    // T5a 活板真崩溃照旧绕门：板面/任务新鲜 + 心跳停更 ≥ crash×3 → crash 直开（bypass 双空闲门）
    writeHeartbeat("agent_b2a");
    writeBoard([{ id: "m-b2a", title: "live-board-crash", status: "running", dispatch: { agent_id: "agent_b2a", mode: "agent", session_id: SID } }]);
    const bgA5 = spawnSentinel({});
    const rA5 = await Promise.race([bgA5.done, sleep(12000).then(() => null)]);
    ck.ok(
      "T5a 活板真崩溃绕门照旧：crash 告警直开（反证不成立不降级）",
      Boolean(rA5) && rA5.code === 1 && rA5.stdout.includes("suspected crash alert") && firedNames5("m-b2a--crash--").length >= 1,
      rA5 && { code: rA5.code, hasCrash: rA5.stdout.includes("suspected crash alert"), fired: firedNames5("m-b2a--") },
    );

    // T5b 双陈旧降级：lastActivity 与 board mtime 同龄期陈旧 → C3 降级 C2 inflight_stall（受双空闲门），不出 crash
    writeHeartbeat("agent_b2b");
    writeBoard([
      {
        id: "m-b2b",
        title: "stale-board-stall",
        status: "running",
        dispatch: { agent_id: "agent_b2b", mode: "agent", session_id: SID },
        updated_at: new Date(Date.now() - AGE_MS).toISOString(),
      },
    ]);
    backdate(path.join(ROOT, "board.json"));
    const bgB5 = spawnSentinel({});
    const rB5 = await Promise.race([bgB5.done, sleep(12000).then(() => null)]);
    ck.ok(
      "T5b 双陈旧反证成立：C3 降级 C2 stall 受双空闲门（无 crash 告警）",
      Boolean(rB5) && rB5.code === 1 && rB5.stdout.includes("in-flight age alert") && !rB5.stdout.includes("suspected crash alert") && firedNames5("m-b2b--inflight_stall--").length >= 1 && firedNames5("m-b2b--crash--").length === 0,
      rB5 && { code: rB5.code, stall: rB5.stdout.includes("in-flight age alert"), crash: rB5.stdout.includes("suspected crash alert"), fired: firedNames5("m-b2b--") },
    );

    try {
      fs.rmSync(path.join(ROOT, "sentinel.cfg.json"), { force: true }); // 卫生：不污染后续（本块为末块）
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
