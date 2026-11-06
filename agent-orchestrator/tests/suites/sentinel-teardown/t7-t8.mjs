// @module sentinel-teardown/t7-t8
/*!
 * suites/sentinel-teardown/t7-t8.mjs —— T7 V7-08（WS-1..3）R1 standby mtime 门 + R2 让位明示一行 /
 * T8 V7-04 lite（WS-5/WS-6）观测型隔离：进入/家族抑制/自愈/告警面恢复/抑制窗口
 * （自 sentinel-teardown.mjs 初步切分拆出，v1.3；断言本体逐字搬运零改动。
 *   原 T7 前定义的共享辅助 cleanSlots/firedCount 已上移 fixtures.mjs，零行为变更。）
 */
import fs from "node:fs";
import path from "node:path";

export async function run(ctx) {
  const { ck, ROOT, SENT_DIR, ECHO, SID, sleep, waitFor, readJson, readText, countLines, slotFile, writeBoard, spawnSentinel, cleanSlots, firedCount } = ctx;

  // ---- T7 V7-08（WS-1..3）：R1 standby mtime 门 + R2 让位明示一行
  //（cleanSlots/firedCount 共享辅助上移 fixtures.mjs——T8/T9/T10 亦复用，零行为变更）
  {
    // WS-1：standby 实例（standby_poll_sec 强置 300、poll=1s）注入 running mission
    // → mtime 门探测到板写 → ≤3s 内 state 变 active（修前需 ~300s 待命节流后才评估）。
    cleanSlots();
    writeBoard([{ id: "m-closed7", title: "quiet", status: "closed" }]);
    const bg7 = spawnSentinel({ standbyPollSec: 300 });
    const standby7 = await waitFor(() => {
      const d = readJson(slotFile(0));
      return Boolean(d) && d.state === "standby" && d.pid === bg7.proc.pid;
    }, 8000);
    await sleep(2500); // 跨过数个被节流 tick（mtime 未变 → 维持节流不评估）
    const t1 = Date.now();
    writeBoard([{ id: "m-ws1", title: "live", status: "running", dispatch: { session_id: SID } }]);
    const wake1 = await waitFor(() => {
      const d = readJson(slotFile(0));
      return Boolean(d) && d.state === "active";
    }, 3000, 100);
    ck.ok(
      "WS-1 standby mtime 门：板写后 ≤3s 复活 active（修前需 ~300s）",
      Boolean(standby7) && Boolean(wake1) && bg7.proc.exitCode === null,
      { standby7, wakeMs: Date.now() - t1, doc: readJson(slotFile(0)) },
    );
    bg7.kill();
    await bg7.done;
  }
  {
    // WS-2：mtime 未变 → 10×poll 内保持 standby 且 fired/echo 零新增（防评估放大）。
    cleanSlots();
    writeBoard([{ id: "m-closed8", title: "quiet", status: "closed" }]);
    const bg8 = spawnSentinel({ standbyPollSec: 300 });
    const standby8 = await waitFor(() => {
      const d = readJson(slotFile(0));
      return Boolean(d) && d.state === "standby" && d.pid === bg8.proc.pid;
    }, 8000);
    const echoBefore8 = countLines(ECHO);
    const firedBefore8 = firedCount();
    await sleep(10000); // 10×poll（poll=1s）
    const d8 = readJson(slotFile(0));
    ck.ok(
      "WS-2 mtime 未变维持节流：10×poll 保持 standby 且 fired/echo 零新增",
      Boolean(standby8) && bg8.proc.exitCode === null && Boolean(d8) && d8.state === "standby" && countLines(ECHO) === echoBefore8 && firedCount() === firedBefore8,
      { standby8, state: d8 && d8.state, echo: [echoBefore8, countLines(ECHO)], fired: [firedBefore8, firedCount()] },
    );
    bg8.kill();
    await bg8.done;
  }
  {
    // WS-3（E4 场景回归化）：满编 fixture + running mission → 第 4 实例 exit 0 ∧
    // stdout 含「让位」（R2 明示一行；修前此处 stdout 为空 = 乙机制误读源）。
    cleanSlots();
    writeBoard([{ id: "m-ws3", title: "live", status: "running", dispatch: { session_id: SID } }]);
    const fam3 = [];
    for (let i = 0; i < 3; i++) fam3.push(spawnSentinel({}));
    const full3 = await waitFor(() => fs.existsSync(slotFile(2)), 8000);
    ck.ok("WS-3a 三实例满编认领 slot0..2", Boolean(full3), fs.readdirSync(SENT_DIR).filter((n) => n.startsWith("instance-")));
    const bg4 = spawnSentinel({});
    const r4 = await Promise.race([bg4.done, sleep(8000).then(() => null)]);
    ck.ok(
      "WS-3 让位明示一行：第 4 实例 exit 0 ∧ stdout 含「让位」「自动接管」",
      Boolean(r4) && r4.code === 0 && r4.stdout.includes("让位") && r4.stdout.includes("自动接管"),
      r4 && { code: r4.code, out: r4.stdout.slice(0, 160) },
    );
    fam3.forEach((b) => b.kill());
    bg4.kill();
    await Promise.allSettled([...fam3.map((b) => b.done), bg4.done]);
  }

  // ---- T8 V7-04 lite（观测型隔离）：隔离进入/家族抑制/自愈/告警面恢复/抑制窗口
  const QMARK = path.join(SENT_DIR, "quarantine.json");
  const echoQCount = () => readText(ECHO).split("\n").filter((x) => x.includes('"category":"quarantine"')).length;
  {
    // WS-5a/b 隔离进入 + 家族级抑制：板缺失（不可读）×3 tick → 三实例全转 quarantined
    // 零退出、quarantine.json 恰一份（wx 仲裁唯一首告者，含证据快照）、聚合告警恰一条
    // （echo 类别计数 + 总行数恰 +1）、fired 零新增。
    // 时序余量（v0.10 G 满载 flake 修复）：先以 running mission 保持三实例 active 态就绪
    // （slot 文件 = 首 tick 已开跑），再等 settle 让各实例首 tick 的 pruneEcho（echo.jsonl
    // 全文件 RMW 重写）全部完成，最后才制造板不可读——消除「晚启实例首 tick prune 与
    // 隔离首告者 appendEcho 同窗 RMW 互踩致旧行丢失」的竞态（run-all 满载实测 WS-5b 偶红）。
    // standby_poll 强置 300 保留（与既有口径一致）。
    cleanSlots();
    writeBoard([{ id: "m-ws5prep", title: "live", status: "running", dispatch: { session_id: SID } }]);
    const fam8 = [];
    for (let i = 0; i < 3; i++) fam8.push(spawnSentinel({ standbyPollSec: 300 }));
    await waitFor(() => {
      return [0, 1, 2].every((k) => {
        const d = readJson(slotFile(k));
        return Boolean(d) && Number.isInteger(d.pid);
      });
    }, 10000);
    await sleep(1200); // settle：跨 ≥1 poll，确保三实例首 tick（含 pruneEcho 重写）收卷
    const echoBeforeT8 = countLines(ECHO);
    const firedBeforeT8 = firedCount();
    fs.rmSync(path.join(ROOT, "board.json"), { force: true });
    const qAll = await waitFor(() => {
      return [0, 1, 2].every((k) => {
        const d = readJson(slotFile(k));
        return Boolean(d) && d.state === "quarantined";
      });
    }, 10000);
    const qdoc = readJson(QMARK);
    ck.ok(
      "WS-5a 隔离进入：C0 满 cap 三实例转 quarantined 且零退出（不杀进程）",
      Boolean(qAll) && fam8.every((b) => b.proc.exitCode === null),
      { qAll, exited: fam8.filter((b) => b.proc.exitCode !== null).length, slots: [0, 1, 2].map((k) => readJson(slotFile(k))) },
    );
    ck.ok(
      "WS-5b 聚合告警恰一条 + 标记含证据快照（wx 仲裁唯一首告者，家族级抑制）",
      Boolean(qdoc) && String(qdoc.reason || "").includes("unreadable") && Boolean(qdoc.evidence) && Number(qdoc.evidence && qdoc.evidence.ticks) >= 3 && echoQCount() === 1 && countLines(ECHO) === echoBeforeT8 + 1 && firedCount() === firedBeforeT8,
      { reason: qdoc && qdoc.reason, evidence: qdoc && qdoc.evidence, qEcho: echoQCount(), echoDelta: countLines(ECHO) - echoBeforeT8, firedDelta: firedCount() - firedBeforeT8 },
    );

    // WS-5c 自愈：板恢复可读 → mtime 门（NaN 基线 + 有限新值 = 板重现即有新活）
    // ≤3s 解除：标记被清、回正常态（全清板 → standby），三实例仍存活。
    writeBoard([{ id: "m-closed8c", title: "quiet", status: "closed" }]);
    const healed = await waitFor(() => {
      if (fs.existsSync(QMARK)) return false;
      return [0, 1, 2].every((k) => {
        const d = readJson(slotFile(k));
        return Boolean(d) && (d.state === "standby" || d.state === "active");
      });
    }, 6000);
    ck.ok(
      "WS-5c 自愈：板可读 → 标记被清回 standby/active（共享 mtime 门 ≤3s），零退出",
      Boolean(healed) && fam8.every((b) => b.proc.exitCode === null),
      { healed, slots: [0, 1, 2].map((k) => readJson(slotFile(k))) },
    );

    // WS-5d 告警面恢复：解除后注入未签收终态（updated_at -10min，逃逸口开，T2b 同款）
    // → 照旧开枪：恰 1 实例 exit 1 wake failure alert，其余实例 refire_gap 内不再开枪。
    writeBoard([
      {
        id: "m-ws5d",
        title: "finished",
        status: "done",
        dispatch: { agent_id: "agent_x", mode: "agent", session_id: SID },
        timeline: [],
        updated_at: new Date(Date.now() - 600000).toISOString(),
      },
    ]);
    const exits8d = [];
    fam8.forEach((f) => f.done.then((r) => exits8d.push({ pid: f.proc.pid, code: r.code, out: r.stdout })));
    const woke8d = await waitFor(() => exits8d.some((e) => e.code === 1 && e.out.includes("wake failure alert")), 10000);
    await sleep(2500); // refire_gap（默认 5min）内其余实例不得再开枪
    ck.ok(
      "WS-5d 告警面恢复：隔离解除后未签收条件照旧开枪（恰 1 实例 exit 1）",
      Boolean(woke8d) && exits8d.length === 1 && exits8d[0].code === 1 && exits8d[0].out.includes("wake failure alert"),
      { woke8d, exits: exits8d.map((e) => ({ code: e.code, wake: e.out.includes("wake failure alert") })) },
    );
    fam8.forEach((f) => f.kill());
    await Promise.allSettled(fam8.map((f) => f.done));
  }
  {
    // WS-6 告警抑制窗口：新鲜标记期内新条件不触发 fired；超 cap_window 后恢复。
    // 刻度注：cap_window_min 有 1min clamp 下限（加速不可低于此）→ 取下限 1min；
    // 两相位覆盖：相位 1 新鲜标记（at=now，窗内）抑制；相位 2 标记 at 回拨 -2min
    //（> 1min 窗）→ 下一 tick 抑制解除照旧开枪 + 陈旧标记被顺手清理（hygiene）。
    cleanSlots();
    fs.mkdirSync(SENT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(ROOT, "sentinel.cfg.json"),
      JSON.stringify({ cap_window_min: 1, wake_grace_min: 0.01, coord_idle_min: 0.01 }) + "\n",
    );
    writeBoard([
      {
        id: "m-ws6",
        title: "finished",
        status: "done",
        dispatch: { agent_id: "agent_y", mode: "agent", session_id: SID },
        timeline: [],
        updated_at: new Date(Date.now() - 600000).toISOString(),
      },
    ]);
    fs.writeFileSync(
      QMARK,
      JSON.stringify({ at: new Date().toISOString(), pid: 1, slot: 0, reason: "fixture-fresh", evidence: null }) + "\n",
    );
    const firedWs6 = () => {
      try {
        return fs.readdirSync(path.join(SENT_DIR, "fired")).filter((n) => n.startsWith("m-ws6--"));
      } catch {
        return [];
      }
    };
    const bg9 = spawnSentinel({});
    await sleep(1600); // 跨 1-2 个 tick：标记新鲜（cap_window ≥1min）→ 新条件被抑制
    ck.ok(
      "WS-6a 新鲜标记期内新条件不触发 fired（家族告警挂起，实例不退出）",
      bg9.proc.exitCode === null && firedWs6().length === 0,
      { alive: bg9.proc.exitCode === null, fired: firedWs6() },
    );
    // 相位 2：标记回拨超窗（-2min > cap_window 1min 下限）→ 抑制解除
    fs.writeFileSync(
      QMARK,
      JSON.stringify({ at: new Date(Date.now() - 120000).toISOString(), pid: 1, slot: 0, reason: "fixture-stale", evidence: null }) + "\n",
    );
    const r9 = await Promise.race([bg9.done, sleep(10000).then(() => null)]);
    ck.ok(
      "WS-6b 超 cap_window 恢复：抑制解除照旧开枪 exit 1 + fired 落盘 + 陈旧标记被清",
      Boolean(r9) && r9.code === 1 && r9.stdout.includes("wake failure alert") && firedWs6().length >= 1 && !fs.existsSync(QMARK),
      r9 && { code: r9.code, fired: firedWs6(), markerGone: !fs.existsSync(QMARK) },
    );
    try {
      fs.rmSync(path.join(ROOT, "sentinel.cfg.json"), { force: true }); // 卫生：不污染后续
    } catch {
      /* best effort */
    }
  }
}
