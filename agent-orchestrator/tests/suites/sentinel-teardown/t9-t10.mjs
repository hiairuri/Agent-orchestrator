// @module sentinel-teardown/t9-t10
/*!
 * suites/sentinel-teardown/t9-t10.mjs —— T9 V7-06（WS-8..9）board list 的 sentinel_health 三态聚合 /
 * T10 W6 WAKE 族（A-v080-WAKE-01..03）哨兵消费 watcher-signals：C1 静默让位 / 缺失过期兜底 / stall 保留
 * （自 sentinel-teardown.mjs 初步切分拆出，v1.3；断言本体逐字搬运零改动）
 */
import fs from "node:fs";
import path from "node:path";
import { startServer } from "../../harness/jsonrpc-client.mjs";

export async function run(ctx) {
  const { ck, BASE, ROOT, SENT_DIR, ECHO, SID, sleep, waitFor, readJson, readText, countLines, slotFile, writeBoard, spawnSentinel, cleanSlots } = ctx;

  // ---- T9 V7-06（WS-8..9）：A3 standby 展示面——board list 的 sentinel_health 三态聚合
  //（server 侧只读聚合 instance-*.json；纯 fixture + MCP RPC，零哨兵进程，黑盒过 server.mjs）
  {
    cleanSlots();
    writeBoard([{ id: "m-closed9", title: "quiet", status: "closed" }]);
    fs.mkdirSync(SENT_DIR, { recursive: true });
    const nowIso = () => new Date().toISOString();
    const s = startServer({ root: ROOT });
    try {
      // WS-8：空 sentinel 目录（零 instance-*.json）→ instances=[] ∧ summary=无哨兵
      const ls8 = await s.call("board", { action: "list" });
      const sh8 = ls8.json && ls8.json.sentinel_health;
      ck.ok(
        "WS-8 空目录 → instances=[] ∧ summary 无哨兵（available:true 不报错）",
        !ls8.isError && sh8 && sh8.available === true && Array.isArray(sh8.instances) && sh8.instances.length === 0
          && sh8.summary && sh8.summary.state === "none" && sh8.summary.on_duty === false
          && String(sh8.summary.text).includes("no sentinel"),
        sh8,
      );

      // WS-9a 混编 fixture：1 fresh standby + 1 stale 死槽 → 逐实例分类正确
      //（pid_alive/state/hb_age_sec/took_over/root/on_duty 全字段形状）
      fs.writeFileSync(
        slotFile(0),
        JSON.stringify({ pid: process.pid, slot: 0, state: "standby", root: ROOT, started_at: nowIso(), heartbeatAt: nowIso() }) + "\n",
      );
      fs.writeFileSync(
        slotFile(1),
        JSON.stringify({ pid: 999999901, slot: 1, state: "active", root: ROOT, started_at: "2020-01-01T00:00:00.000Z", heartbeatAt: "2020-01-01T00:00:00.000Z" }) + "\n",
      );
      const ls9 = await s.call("board", { action: "list" });
      const sh9 = ls9.json && ls9.json.sentinel_health;
      const i0 = sh9 && sh9.instances.find((i) => i.slot === 0);
      const i1 = sh9 && sh9.instances.find((i) => i.slot === 1);
      ck.ok(
        "WS-9a 逐实例分类：fresh standby pid_alive/on_duty ∧ stale 死槽非在岗（V7-06 形状全字段）",
        Boolean(i0) && i0.pid_alive === true && i0.state === "standby" && i0.on_duty === true
          && i0.hb_age_sec <= 5 && i0.took_over === false && typeof i0.root === "string"
          && Boolean(i1) && i1.pid_alive === false && i1.state === "active" && i1.on_duty === false && i1.hb_age_sec > 90,
        { i0, i1 },
      );
      // WS-9b 混编 summary 归在岗待命——可补员=无任何存活实例（含 stale 不误判，pack 规）
      ck.ok(
        "WS-9b 混编 summary=在岗待命（可补员不因含 stale 误判）",
        Boolean(sh9 && sh9.summary) && sh9.summary.state === "standby" && sh9.summary.on_duty === true
          && sh9.summary.on_duty_n === 1 && sh9.summary.total === 2
          && String(sh9.summary.text).includes("standby on duty"),
        sh9 && sh9.summary,
      );

      // WS-9c 全死槽（零存活实例）→ summary=可补员
      fs.rmSync(slotFile(0), { force: true });
      const ls9c = await s.call("board", { action: "list" });
      const sum9c = ls9c.json && ls9c.json.sentinel_health && ls9c.json.sentinel_health.summary;
      ck.ok(
        "WS-9c 无任何存活实例 → summary 槽位 stale（可补员）",
        Boolean(sum9c) && sum9c.state === "reinforce" && sum9c.on_duty === false && sum9c.on_duty_n === 0
          && String(sum9c.text).includes("replenishable"),
        sum9c,
      );

      // WS-9d quarantined 第三态（S2）认得且归在岗语义：fresh quarantined → 隔离值守 on_duty=true
      fs.writeFileSync(
        slotFile(0),
        JSON.stringify({ pid: process.pid, slot: 0, state: "quarantined", root: ROOT, started_at: nowIso(), heartbeatAt: nowIso() }) + "\n",
      );
      fs.rmSync(slotFile(1), { force: true });
      const ls9d = await s.call("board", { action: "list" });
      const sh9d = ls9d.json && ls9d.json.sentinel_health;
      ck.ok(
        "WS-9d quarantined 第三态归在岗：summary 隔离值守 on_duty=true（不误判可补员）",
        Boolean(sh9d && sh9d.summary) && sh9d.summary.state === "quarantined" && sh9d.summary.on_duty === true
          && sh9d.instances.length === 1 && sh9d.instances[0].state === "quarantined" && sh9d.instances[0].on_duty === true,
        { summary: sh9d && sh9d.summary, i0: sh9d && sh9d.instances[0] },
      );

      // WS-9e 板全清且全 fresh standby → summary=在岗待命（W-S WS-9 后半定稿口径）
      fs.writeFileSync(
        slotFile(0),
        JSON.stringify({ pid: process.pid, slot: 0, state: "standby", root: ROOT, started_at: nowIso(), heartbeatAt: nowIso() }) + "\n",
      );
      fs.writeFileSync(
        slotFile(1),
        JSON.stringify({ pid: process.pid, slot: 1, state: "standby", root: ROOT, started_at: nowIso(), heartbeatAt: nowIso() }) + "\n",
      );
      const ls9e = await s.call("board", { action: "list" });
      const sum9e = ls9e.json && ls9e.json.sentinel_health && ls9e.json.sentinel_health.summary;
      ck.ok(
        "WS-9e 全 fresh standby → summary 在岗待命（自动接管新派发）",
        Boolean(sum9e) && sum9e.state === "standby" && sum9e.on_duty === true && sum9e.on_duty_n === 2
          && String(sum9e.text).includes("standby on duty") && String(sum9e.text).includes("auto-takes-over"),
        sum9e,
      );
    } finally {
      try {
        s.close();
      } catch {
        /* already closed */
      }
      cleanSlots();
    }
  }

  // ---- T10 W6 WAKE 族（A-v080-WAKE-01..03）：哨兵消费 watcher-signals——C1 静默让位 /
  // 缺失过期兜底不回归 / stall 职责保留。信号格式实证=watcher/degrade.mjs #writeSignal：
  // {at,cls,mission,reason} 逐行 JSONL，cls ∈ {D1,D2,D3,kicked}（D2=瞬时重试中仍在岗）。
  {
    const SIG = path.join(SENT_DIR, "watcher-signals.jsonl");
    const writeSig = (cls, ageMs) => {
      fs.mkdirSync(SENT_DIR, { recursive: true });
      fs.writeFileSync(
        SIG,
        JSON.stringify({ at: new Date(Date.now() - (ageMs || 0)).toISOString(), cls, mission: "m-wake1", reason: "connect-failed" }) + "\n",
      );
    };
    const firedNames10 = (prefix) => {
      try {
        return fs.readdirSync(path.join(SENT_DIR, "fired")).filter((n) => n.startsWith(prefix));
      } catch {
        return [];
      }
    };
    cleanSlots();

    // WAKE-01：fresh D2（watcher 在岗重试中）→ C1 静默；信号老化出 TTL → 既有兜底恢复。
    // 加速刻度：TTL=0.2min(12s)；C1 锚 -10min（宽限 5min 已熟 + 逃逸口 2×宽限已开——
    // 若未被覆盖必开枪，静默只能来自信号消费）。
    // 观察窗确定性化（v0.8 QA 去偶发）：旧版按 3.2s wall-clock 假设「已跨 ≥3 tick」，
    // 负载下子进程启动/调度抖动使实际 tick 数不可保证 → 偶发 RED。改为按槽位心跳推进
    // 计数实际 tick（touchSlot 每 tick 顶部无条件刷新；active 态每 tick 全量评估=每 tick
    // 恰一次消费判定），实测跨 ≥3 tick 并落定后才下静默结论；观察期任一开枪/回声新增/
    // 退出即 fail-fast 判负——静默结论=「≥3 个已评估 tick 内零开枪」的机械事实。
    fs.writeFileSync(
      path.join(ROOT, "sentinel.cfg.json"),
      JSON.stringify({ watcher_signal_ttl_min: 0.2 }) + "\n",
    );
    writeBoard([
      {
        id: "m-wake1",
        title: "covered-terminal",
        status: "done",
        dispatch: { agent_id: "agent_wake1", mode: "agent", session_id: SID },
        timeline: [],
        updated_at: new Date(Date.now() - 600000).toISOString(),
      },
    ]);
    writeSig("D2", 0);
    // v1.2 M9-1：REV-③ 补告警回声（catchup 类别）是留痕非开枪——静默判定排除该类别行
    //（复活首扫对缺位期已到期升级集中补发一次，与 W6 覆盖让位语义正交）。
    const echoDataW1 = () =>
      readText(ECHO).split("\n").filter((x) => x.trim() && !x.includes('"category":"catchup"')).length;
    const echoBeforeW1 = echoDataW1();
    const bgW1 = spawnSentinel({});
    // 确定性观察窗：心跳推进=tick 事实（需 ≥3 tick）；信号 at 每 5s 顺路保鲜（龄恒 <5s
    // < TTL 12s——观察窗被负载拉长也不破「新鲜」前提，TTL 过期竞态消除；常态 3-4s 窗内
    // 零额外写）。循环出口后落定 300ms 再终判（tick 体同步执行，远小于此）。
    let hbW1 = null;
    let ticksW1 = 0;
    let shotW1 = false;
    let freshAtW1 = Date.now();
    await waitFor(() => {
      if (Date.now() - freshAtW1 >= 5000) {
        writeSig("D2", 0); // 长尾保鲜（仅窗被拉长时触发）
        freshAtW1 = Date.now();
      }
      if (firedNames10("m-wake1--").length > 0 || echoDataW1() !== echoBeforeW1 || bgW1.proc.exitCode !== null) {
        shotW1 = true; // fail-fast：覆盖在位下开枪=回归，静默不成立（断言 RED）
        return true;
      }
      const d = readJson(slotFile(0));
      const h = d && d.heartbeatAt;
      if (h && h !== hbW1) {
        hbW1 = h;
        ticksW1 += 1;
      }
      return ticksW1 >= 3;
    }, 30000, 150);
    await sleep(300); // 落定：第 3 tick 的同步评估体必然已完成
    const silentW1 =
      !shotW1 && ticksW1 >= 3 && bgW1.proc.exitCode === null && firedNames10("m-wake1--").length === 0 && echoDataW1() === echoBeforeW1;
    writeSig("D2", 60000); // 信号龄 60s > TTL 12s → 过期 → 兜底
    const exitedW1 = await waitFor(() => bgW1.proc.exitCode !== null, 30000, 100); // 事件驱动等退出（不假设 wall-clock 上限）
    const rW1 = await Promise.race([bgW1.done, sleep(5000).then(() => null)]);
    ck.ok(
      "WAKE-01 watcher 信号新鲜→C1 类别静默零开枪；信号过期→既有兜底告警恢复（exit 1 + fired 落盘）",
      silentW1 && exitedW1 && Boolean(rW1) && rW1.code === 1 && rW1.stdout.includes("wake failure alert") && firedNames10("m-wake1--unclaimed_terminal--").length >= 1,
      { silentW1, ticksW1, shotW1, rW1: rW1 && { code: rW1.code, wake: rW1.stdout.includes("wake failure alert") }, fired: firedNames10("m-wake1--") },
    );
    try {
      fs.rmSync(path.join(ROOT, "sentinel.cfg.json"), { force: true }); // 卫生：不污染后续
    } catch {
      /* best effort */
    }

    // WAKE-02：信号缺失（文件不存在）→ 既有兜底路径不回归（T2b 同款行为保持）。
    cleanSlots();
    try {
      fs.rmSync(SIG, { force: true });
    } catch {
      /* best effort */
    }
    writeBoard([
      {
        id: "m-wake2",
        title: "fallback-terminal",
        status: "done",
        dispatch: { agent_id: "agent_wake2", mode: "agent", session_id: SID },
        timeline: [],
        updated_at: new Date(Date.now() - 600000).toISOString(),
      },
    ]);
    const bgW2 = spawnSentinel({});
    const rW2 = await Promise.race([bgW2.done, sleep(10000).then(() => null)]);
    ck.ok(
      "WAKE-02 watcher 信号缺失→哨兵兜底路径不回归（既有wake failure alert exit 1 + fired 落盘保持）",
      Boolean(rW2) && rW2.code === 1 && rW2.stdout.includes("wake failure alert") && firedNames10("m-wake2--unclaimed_terminal--").length >= 1,
      rW2 && { code: rW2.code, wake: rW2.stdout.includes("wake failure alert"), fired: firedNames10("m-wake2--") },
    );

    // WAKE-03：stall 死寂检测无条件保留——fresh D2 覆盖在位下 inflight_stall 照旧开枪
    //（watcher 事件中继盲区）。加速刻度：stall=0.1min(6s)、coord-idle=0.01min；锚
    // updated_at -8s 已熟；板 mtime 同步回拨 → coordBusy 兜底档判空闲（门开，T5b 同款）；
    // 空 rollout fixture 防 C3 误触真实面（无心跳 → 无 crash，降级链终端落 C2）。
    const ROLLOUT10 = path.join(BASE.root, "rollout-wake3");
    fs.mkdirSync(ROLLOUT10, { recursive: true });
    fs.writeFileSync(
      path.join(ROOT, "sentinel.cfg.json"),
      JSON.stringify({ stall_grace_min: 0.1, coord_idle_min: 0.01, signals: { rollout_dir: ROLLOUT10 } }) + "\n",
    );
    cleanSlots();
    writeSig("D2", 0); // 覆盖在位（fresh D2）——stall 仍必须开枪
    writeBoard([
      {
        id: "m-wake3",
        title: "stall-kept",
        status: "running",
        dispatch: { agent_id: "agent_wake3", mode: "agent", session_id: SID },
        updated_at: new Date(Date.now() - 8000).toISOString(),
      },
    ]);
    try {
      const bt = new Date(Date.now() - 8000);
      fs.utimesSync(path.join(ROOT, "board.json"), bt, bt); // 板面陈旧 → 门开（T5b 同款）
    } catch {
      /* best effort */
    }
    const bgW3 = spawnSentinel({});
    const rW3 = await Promise.race([bgW3.done, sleep(12000).then(() => null)]);
    ck.ok(
      "WAKE-03 stall 检测职责保留：watcher 覆盖在位（fresh D2）下 inflight_stall 照旧开枪（exit 1 + in-flight age alert，无 crash）",
      Boolean(rW3) && rW3.code === 1 && rW3.stdout.includes("in-flight age alert") && !rW3.stdout.includes("suspected crash alert") && firedNames10("m-wake3--inflight_stall--").length >= 1,
      rW3 && { code: rW3.code, stall: rW3.stdout.includes("in-flight age alert"), crash: rW3.stdout.includes("suspected crash alert"), fired: firedNames10("m-wake3--") },
    );
    try {
      fs.rmSync(path.join(ROOT, "sentinel.cfg.json"), { force: true }); // 卫生
      fs.rmSync(SIG, { force: true });
    } catch {
      /* best effort */
    }
  }
}
