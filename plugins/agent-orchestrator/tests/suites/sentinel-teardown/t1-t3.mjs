// @module sentinel-teardown/t1-t3
/*!
 * suites/sentinel-teardown/t1-t3.mjs —— T1 全清待命 / T2 板面复活 / T3 寿命轮换选举
 * （自 sentinel-teardown.mjs 初步切分拆出，v1.3；断言本体逐字搬运零改动）
 */
import fs from "node:fs";
import path from "node:path";

export async function run(ctx) {
  const { ck, ROOT, SENT_DIR, MARKER, ECHO, SID, sleep, waitFor, readJson, readText, countLines, slotFile, writeBoard, spawnSentinel } = ctx;

  // ---- T1 全清待命不退（常态 0 通知）
  {
    writeBoard([{ id: "m-closed", title: "closed-work", status: "closed" }]);
    const bg = spawnSentinel({});
    await sleep(2500);
    const doc = readJson(slotFile(0));
    ck.ok("T1a 全清观察窗存活且 state=standby", bg.proc.exitCode === null && doc && doc.state === "standby", {
      alive: bg.proc.exitCode === null,
      doc,
    });
    const hb1 = doc ? doc.heartbeatAt : null;
    await sleep(1700);
    const doc2 = readJson(slotFile(0));
    ck.ok(
      "T1b 待命心跳持续刷新（90s 在岗新鲜度，bg-gate 缺员判断天然抑制）",
      bg.proc.exitCode === null && doc2 && hb1 && String(doc2.heartbeatAt) > String(hb1),
      { hb1, hb2: doc2 && doc2.heartbeatAt },
    );
    ck.ok("T1c 全清零回声零 fired", !fs.existsSync(ECHO) && !fs.existsSync(path.join(SENT_DIR, "fired")));
    // 待命期板不可读 → 静默续待命（不计数不告警）
    fs.rmSync(path.join(ROOT, "board.json"), { force: true });
    await sleep(2200);
    ck.ok(
      "T1d 待命期板不可读静默续待命（不告警不退出）",
      bg.proc.exitCode === null && !fs.existsSync(ECHO) && !fs.existsSync(path.join(SENT_DIR, "fired")),
    );
    bg.kill();
    await bg.done;
  }

  // ---- T2 板面复活 + 告警路径照旧
  {
    writeBoard([{ id: "m-t2a", title: "live", status: "running", dispatch: { session_id: SID } }]);
    const bg = spawnSentinel({});
    const revived = await waitFor(() => {
      const d = readJson(slotFile(0));
      return d && d.state === "active";
    }, 8000);
    ck.ok("T2a 新在飞复活 state=active（回正常 poll 频率）", revived && bg.proc.exitCode === null, readJson(slotFile(0)));
    // 改未签收 done（宽限 0.01min=600ms；anchor=updated_at-10min，逃逸口早已开）→ 告警照旧 exit 1
    writeBoard([
      {
        id: "m-t2b",
        title: "finished",
        status: "done",
        dispatch: { agent_id: "agent_x", mode: "agent", session_id: SID },
        timeline: [],
        updated_at: new Date(Date.now() - 600000).toISOString(),
      },
    ]);
    const r = await Promise.race([bg.done, sleep(10000).then(() => null)]);
    ck.ok("T2b 复活后告警照旧 exit 1", Boolean(r) && r.code === 1 && r.stdout.includes("唤醒失败告警"), r && { code: r.code, out: r.stdout.slice(0, 100) });
    ck.ok("T2c 本地回声落盘（unclaimed_terminal）", readText(ECHO).includes("unclaimed_terminal"), readText(ECHO).slice(0, 120));
    let firedNames = [];
    try {
      firedNames = fs.readdirSync(path.join(SENT_DIR, "fired")).filter((n) => n.startsWith("m-t2b--"));
    } catch {
      /* no fired dir */
    }
    ck.ok("T2d fired 条目落盘", firedNames.length >= 1, firedNames);
    ck.ok("T2e 开枪后槽位释放", !fs.existsSync(slotFile(0)));
  }

  // ---- T3 寿命 cap 单赢家选举（3 实例，lifetime=3s，全清板 → standby 中轮换）
  {
    const echoBefore = countLines(ECHO);
    writeBoard([{ id: "m-closed3", title: "quiet", status: "closed" }]);
    const fam = [];
    for (let i = 0; i < 3; i++) {
      const bg = spawnSentinel({ lifetimeMin: 0.05, standbyPollSec: 1 });
      fam.push({ bg, pid: bg.proc.pid });
    }
    const exits = [];
    fam.forEach((f) => f.bg.done.then((r) => exits.push({ pid: f.pid, code: r.code, at: Date.now(), out: r.stdout })));
    await sleep(2200);
    ck.ok(
      "T3a 寿命到期前零退出（旧版全清语义此处已三连退）",
      exits.length === 0 && fam.every((f) => f.bg.proc.exitCode === null),
      exits.length,
    );
    const allDone = await waitFor(() => exits.length === 3, 25000, 200);
    ck.ok(
      "T3b 三实例全部轮换退出且 code 0 带轮换文案",
      allDone && exits.every((e) => e.code === 0 && e.out.includes("轮换")),
      exits.map((e) => ({ code: e.code, rot: e.out.includes("轮换") })),
    );
    const times = exits.map((e) => e.at).sort((a, b) => a - b);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    ck.ok("T3c 退出串行：相邻间隔 ≥1.8s（每寿命周期至多 1 条通知）", gaps.length === 2 && gaps.every((g) => g >= 1800), gaps);
    const lastExit = exits.find((e) => e.at === times[times.length - 1]);
    const marker = readJson(MARKER);
    ck.ok(
      "T3d family-teardown 标记随最后赢家更新",
      marker && lastExit && marker.pid === lastExit.pid && Date.now() - Date.parse(marker.at) < 8000,
      { marker, lastPid: lastExit && lastExit.pid },
    );
    ck.ok("T3e 轮换零告警副作用（echo 行数不增）", countLines(ECHO) === echoBefore, { before: echoBefore, after: countLines(ECHO) });
  }
}
