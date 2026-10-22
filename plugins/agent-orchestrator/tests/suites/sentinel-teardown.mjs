/*!
 * suites/sentinel-teardown.mjs —— 哨兵 v2.1 待命制 + 寿命轮换选举（bg-sentinel.mjs 黑盒，加速参数驱动）
 *
 * 覆盖断言组（v0.5.1 全清零唤醒改造：平台把任何后台退出都变成完成通知，全清三实例三连唤属缺陷）：
 *   T1 全清待命不退（观察窗存活 + state=standby + 心跳续刷 + 零回声零 fired + 待命期板不可读静默续待命）
 *   T2 板面复活（新在飞 → state=active；未签收 → 复活后告警照旧 exit 1 + echo/fired + 槽位释放）
 *   T3 寿命 cap 单赢家选举（3 实例：到期前零退出；退出全 0 带轮换文案；相邻退出间隔 ≥ 寿命刻度；
 *      family-teardown 标记随最后赢家更新；轮换零告警副作用）
 *   T4 标记/槽位容错与混跑兼容（陈旧标记夺位、损坏标记修复、新鲜标记顺延、旧格式槽位共存）
 *   T5 V6-32 板面龄期反证（C3 开枪前双陈旧反证：活板真崩溃照旧绕门 crash；
 *      lastActivity 与 board mtime 双陈旧 → 降级 C2 受双空闲门 stall，加速参数驱动）
 *   T6 V6-54/V6-55（B4 末波）：claimShots 文件名去 pid 恢复同名 wx 互斥（固定时钟
 *      单元级，剥入口导入）+ touchSlot 前 pid 归属校验（他人槽位让位；黑盒集成：
 *      被接管实例持续让位退为无槽幽灵）
 *   T7 V7-08（WS-1..3）：R1 standby mtime 门（板写 ≤3s 复活 active，修前需 ~300s；
 *      mtime 未变 10×poll 维持 standby 且 fired/echo 零新增防评估放大）+ R2 让位
 *      明示一行（满编 + running → 第 4 实例 exit 0 ∧ stdout 含「让位」「自动接管」）
 *   T8 V7-04 lite（WS-5..6）：观测型隔离——C0 板不可读满 cap 三实例转 quarantined
 *      零退出、quarantine.json 恰一份（wx 仲裁）+ 聚合告警恰一条（家族级抑制）；
 *      板恢复可读 → 共享 mtime 门 ≤3s 自愈（标记被清回 standby/active）+ 告警面
 *      恢复（未签收条件照旧开枪恰 1 实例）；新鲜标记期内新条件不触发 fired、
 *      超 cap_window 后抑制解除照旧开枪 + 陈旧标记被清
 *   T9 V7-06（WS-8..9，v0.7-A3）：board list 的 sentinel_health 三态聚合——空目录=无哨兵；
 *      混编（fresh standby + stale）逐实例分类正确且 summary 归在岗待命（可补员=无任何
 *      存活实例，含 stale 不误判）；全死槽=可补员；quarantined 第三态认得且归在岗
 *      （隔离值守）；板全清全 fresh standby=在岗待命（自动接管新派发）
 *   T10 W6 WAKE 族（v0.8-DESIGN §13.1 W6 / §14 A-v080-WAKE-01..03）：bg-sentinel 消费
 *      <sentinel>/watcher-signals.jsonl（格式实证=watcher/degrade.mjs #writeSignal）——
 *      WAKE-01 最新有效信号 cls=D2 且新鲜 → C1 两族静默零开枪，信号过期 → 既有兜底
 *      恢复；WAKE-02 信号缺失 → 兜底路径不回归（既有唤醒失败告警保持）；WAKE-03
 *      stall 死寂检测无条件保留（fresh D2 覆盖在位下 inflight_stall 照旧开枪——watcher
 *      事件中继看不见无事件死寂，C2 面不随降级关闭，2026-10-22 用户裁决）
 *
 * live 行为无法自动化的部分（手动验收步骤）：
 *   - 平台通知面：全清后主控 0 唤醒（旧版实测三实例三连唤）——需宿主后台任务真跑 3 实例
 *     （node hooks/bg-sentinel.mjs --once × 3, run_in_background=true）观察完成通知数量为 0。
 *   - 真实 24h 寿命轮换节奏（每 24h 至多 1 条轮换通知）——--max-lifetime-min 1440 观察 24h+，
 *     确认只收到 1 条"家族轮换"通知且其余实例仍在岗（槽位 state=standby/active）。
 *   - bg-gate 补员提醒在 standby 家族常驻时的抑制——直核：家族 standby 后发一次后台派发，
 *     确认 bg-gate 输出无"拉起哨兵"句（本套件以 T1b 心跳新鲜度间接覆盖在岗判定）。
 *
 * 运行方式：node tests/suites/sentinel-teardown.mjs
 * 前置：node >= 20；无 git/网络依赖；总时长 ~110s（全部加速参数驱动， Windows/linux 均可）。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGIN_DIR, Checker, startServer } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot } from "../harness/temp-root.mjs";
import { captureBackground } from "../harness/capture.mjs";

const ck = new Checker("sentinel-teardown");
const SENTINEL = path.join(PLUGIN_DIR, "hooks", "bg-sentinel.mjs");
const BASE = makeTempRoot({ prefix: "orch-sentd-" });
const PROJ = path.join(BASE.root, "proj");
const ROOT = path.join(PROJ, ".zcode", "orchestrator");
const SENT_DIR = path.join(ROOT, "sentinel");
const MARKER = path.join(SENT_DIR, "family-teardown.json");
const ECHO = path.join(SENT_DIR, "echo.jsonl");

const kids = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, step = 120) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(step);
  }
}
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const readText = (f) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
};
const countLines = (f) => readText(f).split("\n").filter((x) => x.trim()).length;
const slotFile = (k) => path.join(SENT_DIR, `instance-${k}.json`);
const writeBoard = (missions) => {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "board.json"),
    JSON.stringify({ version: 2, updated_at: new Date().toISOString(), missions }) + "\n",
  );
};
/** 拉起一个哨兵实例（后台捕获；加速参数：1s poll / 0 stagger / 2s 待命复核） */
const spawnSentinel = ({ missions, lifetimeMin = null, standbyPollSec = 2 } = {}) => {
  if (missions) writeBoard(missions);
  const args = [SENTINEL, "--root", ROOT, "--poll-sec", "1", "--stagger-sec", "0", "--standby-poll-sec", String(standbyPollSec)];
  if (lifetimeMin != null) args.push("--max-lifetime-min", String(lifetimeMin));
  const bg = captureBackground({ script: process.execPath, args, cwd: PROJ, env: { ZCODE_PROJECT_DIR: PROJ } });
  kids.push(bg);
  return bg;
};
const writeMarker = (atMs, pid = 1, slot = 0) => {
  fs.mkdirSync(SENT_DIR, { recursive: true });
  fs.writeFileSync(MARKER, JSON.stringify({ at: new Date(atMs).toISOString(), pid, slot }) + "\n");
};

try {
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
    writeBoard([{ id: "m-t2a", title: "live", status: "running", dispatch: {} }]);
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
        dispatch: { agent_id: "agent_x", mode: "agent" },
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
    writeBoard([{ id: "m-b2a", title: "live-board-crash", status: "running", dispatch: { agent_id: "agent_b2a", mode: "agent" } }]);
    const bgA5 = spawnSentinel({});
    const rA5 = await Promise.race([bgA5.done, sleep(12000).then(() => null)]);
    ck.ok(
      "T5a 活板真崩溃绕门照旧：crash 告警直开（反证不成立不降级）",
      Boolean(rA5) && rA5.code === 1 && rA5.stdout.includes("疑似崩溃告警") && firedNames5("m-b2a--crash--").length >= 1,
      rA5 && { code: rA5.code, hasCrash: rA5.stdout.includes("疑似崩溃告警"), fired: firedNames5("m-b2a--") },
    );

    // T5b 双陈旧降级：lastActivity 与 board mtime 同龄期陈旧 → C3 降级 C2 inflight_stall（受双空闲门），不出 crash
    writeHeartbeat("agent_b2b");
    writeBoard([
      {
        id: "m-b2b",
        title: "stale-board-stall",
        status: "running",
        dispatch: { agent_id: "agent_b2b", mode: "agent" },
        updated_at: new Date(Date.now() - AGE_MS).toISOString(),
      },
    ]);
    backdate(path.join(ROOT, "board.json"));
    const bgB5 = spawnSentinel({});
    const rB5 = await Promise.race([bgB5.done, sleep(12000).then(() => null)]);
    ck.ok(
      "T5b 双陈旧反证成立：C3 降级 C2 stall 受双空闲门（无 crash 告警）",
      Boolean(rB5) && rB5.code === 1 && rB5.stdout.includes("在飞任务龄期告警") && !rB5.stdout.includes("疑似崩溃告警") && firedNames5("m-b2b--inflight_stall--").length >= 1 && firedNames5("m-b2b--crash--").length === 0,
      rB5 && { code: rB5.code, stall: rB5.stdout.includes("在飞任务龄期告警"), crash: rB5.stdout.includes("疑似崩溃告警"), fired: firedNames5("m-b2b--") },
    );

    try {
      fs.rmSync(path.join(ROOT, "sentinel.cfg.json"), { force: true }); // 卫生：不污染后续（本块为末块）
    } catch {
      /* best effort */
    }
  }

  // ---- T6 V6-54/V6-55（B4 末波）：claimShots 去 pid 同名互斥 + touchSlot pid 归属校验
  {
    // 单元层准备：剥掉入口 try{main()} 把 bg-sentinel 当库导入（黑盒测不到的函数级行为；
    // 模块唯一其余顶层副作用是 node:sqlite 特性探测，自带 try/catch 无泄漏句柄）。
    const SRC = fs.readFileSync(SENTINEL, "utf8").replace(/\r\n/g, "\n");
    const TAIL = "try {\n  main();\n} catch {\n  process.exit(0);\n}";
    const idx = SRC.lastIndexOf(TAIL);
    ck.ok("T6-pre 哨兵入口结构可剥（无漂移）", idx > 0, `tailIdx=${idx}`);
    if (idx > 0) {
      const LIB = path.join(BASE.root, "sentinel-lib.mjs");
      fs.writeFileSync(LIB, SRC.slice(0, idx) + "\nexport { claimShots, touchSlot };\n");
      const lib = await import(pathToFileURL(LIB).href);

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

  // ---- T7 V7-08（WS-1..3）：R1 standby mtime 门 + R2 让位明示一行
  const cleanSlots = () => {
    for (const n of fs.readdirSync(SENT_DIR).filter((n) => /^instance-\d+\.json$/.test(n))) {
      fs.rmSync(path.join(SENT_DIR, n), { force: true });
    }
  };
  const firedCount = () => {
    try {
      return fs.readdirSync(path.join(SENT_DIR, "fired")).length;
    } catch {
      return 0;
    }
  };
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
    writeBoard([{ id: "m-ws1", title: "live", status: "running", dispatch: {} }]);
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
    writeBoard([{ id: "m-ws3", title: "live", status: "running", dispatch: {} }]);
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
    // WS-5a/b 隔离进入 + 家族级抑制：板缺失（不可读）×3 tick（standby_poll 强置 300，
    // 证明进入路径不受待命节流影响）→ 三实例全转 quarantined 零退出、quarantine.json
    // 恰一份（wx 仲裁唯一首告者，含证据快照）、聚合告警恰一条（echo 类别计数 + 总行数
    // 恰 +1）、fired 零新增。
    cleanSlots();
    fs.rmSync(path.join(ROOT, "board.json"), { force: true });
    const echoBeforeT8 = countLines(ECHO);
    const firedBeforeT8 = firedCount();
    const fam8 = [];
    for (let i = 0; i < 3; i++) fam8.push(spawnSentinel({ standbyPollSec: 300 }));
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
      Boolean(qdoc) && String(qdoc.reason || "").includes("不可读") && Boolean(qdoc.evidence) && Number(qdoc.evidence && qdoc.evidence.ticks) >= 3 && echoQCount() === 1 && countLines(ECHO) === echoBeforeT8 + 1 && firedCount() === firedBeforeT8,
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
    // → 照旧开枪：恰 1 实例 exit 1 唤醒失败告警，其余实例 refire_gap 内不再开枪。
    writeBoard([
      {
        id: "m-ws5d",
        title: "finished",
        status: "done",
        dispatch: { agent_id: "agent_x", mode: "agent" },
        timeline: [],
        updated_at: new Date(Date.now() - 600000).toISOString(),
      },
    ]);
    const exits8d = [];
    fam8.forEach((f) => f.done.then((r) => exits8d.push({ pid: f.proc.pid, code: r.code, out: r.stdout })));
    const woke8d = await waitFor(() => exits8d.some((e) => e.code === 1 && e.out.includes("唤醒失败告警")), 10000);
    await sleep(2500); // refire_gap（默认 5min）内其余实例不得再开枪
    ck.ok(
      "WS-5d 告警面恢复：隔离解除后未签收条件照旧开枪（恰 1 实例 exit 1）",
      Boolean(woke8d) && exits8d.length === 1 && exits8d[0].code === 1 && exits8d[0].out.includes("唤醒失败告警"),
      { woke8d, exits: exits8d.map((e) => ({ code: e.code, wake: e.out.includes("唤醒失败告警") })) },
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
        dispatch: { agent_id: "agent_y", mode: "agent" },
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
      Boolean(r9) && r9.code === 1 && r9.stdout.includes("唤醒失败告警") && firedWs6().length >= 1 && !fs.existsSync(QMARK),
      r9 && { code: r9.code, fired: firedWs6(), markerGone: !fs.existsSync(QMARK) },
    );
    try {
      fs.rmSync(path.join(ROOT, "sentinel.cfg.json"), { force: true }); // 卫生：不污染后续
    } catch {
      /* best effort */
    }
  }

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
          && String(sh8.summary.text).includes("无哨兵"),
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
          && String(sh9.summary.text).includes("在岗待命"),
        sh9 && sh9.summary,
      );

      // WS-9c 全死槽（零存活实例）→ summary=可补员
      fs.rmSync(slotFile(0), { force: true });
      const ls9c = await s.call("board", { action: "list" });
      const sum9c = ls9c.json && ls9c.json.sentinel_health && ls9c.json.sentinel_health.summary;
      ck.ok(
        "WS-9c 无任何存活实例 → summary 槽位 stale（可补员）",
        Boolean(sum9c) && sum9c.state === "reinforce" && sum9c.on_duty === false && sum9c.on_duty_n === 0
          && String(sum9c.text).includes("可补员"),
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
          && String(sum9e.text).includes("在岗待命") && String(sum9e.text).includes("自动接管"),
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
        dispatch: { agent_id: "agent_wake1", mode: "agent" },
        timeline: [],
        updated_at: new Date(Date.now() - 600000).toISOString(),
      },
    ]);
    writeSig("D2", 0);
    const echoBeforeW1 = countLines(ECHO);
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
      if (firedNames10("m-wake1--").length > 0 || countLines(ECHO) !== echoBeforeW1 || bgW1.proc.exitCode !== null) {
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
      !shotW1 && ticksW1 >= 3 && bgW1.proc.exitCode === null && firedNames10("m-wake1--").length === 0 && countLines(ECHO) === echoBeforeW1;
    writeSig("D2", 60000); // 信号龄 60s > TTL 12s → 过期 → 兜底
    const exitedW1 = await waitFor(() => bgW1.proc.exitCode !== null, 30000, 100); // 事件驱动等退出（不假设 wall-clock 上限）
    const rW1 = await Promise.race([bgW1.done, sleep(5000).then(() => null)]);
    ck.ok(
      "WAKE-01 watcher 信号新鲜→C1 类别静默零开枪；信号过期→既有兜底告警恢复（exit 1 + fired 落盘）",
      silentW1 && exitedW1 && Boolean(rW1) && rW1.code === 1 && rW1.stdout.includes("唤醒失败告警") && firedNames10("m-wake1--unclaimed_terminal--").length >= 1,
      { silentW1, ticksW1, shotW1, rW1: rW1 && { code: rW1.code, wake: rW1.stdout.includes("唤醒失败告警") }, fired: firedNames10("m-wake1--") },
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
        dispatch: { agent_id: "agent_wake2", mode: "agent" },
        timeline: [],
        updated_at: new Date(Date.now() - 600000).toISOString(),
      },
    ]);
    const bgW2 = spawnSentinel({});
    const rW2 = await Promise.race([bgW2.done, sleep(10000).then(() => null)]);
    ck.ok(
      "WAKE-02 watcher 信号缺失→哨兵兜底路径不回归（既有唤醒失败告警 exit 1 + fired 落盘保持）",
      Boolean(rW2) && rW2.code === 1 && rW2.stdout.includes("唤醒失败告警") && firedNames10("m-wake2--unclaimed_terminal--").length >= 1,
      rW2 && { code: rW2.code, wake: rW2.stdout.includes("唤醒失败告警"), fired: firedNames10("m-wake2--") },
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
        dispatch: { agent_id: "agent_wake3", mode: "agent" },
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
      "WAKE-03 stall 检测职责保留：watcher 覆盖在位（fresh D2）下 inflight_stall 照旧开枪（exit 1 + 在飞任务龄期告警，无 crash）",
      Boolean(rW3) && rW3.code === 1 && rW3.stdout.includes("在飞任务龄期告警") && !rW3.stdout.includes("疑似崩溃告警") && firedNames10("m-wake3--inflight_stall--").length >= 1,
      rW3 && { code: rW3.code, stall: rW3.stdout.includes("在飞任务龄期告警"), crash: rW3.stdout.includes("疑似崩溃告警"), fired: firedNames10("m-wake3--") },
    );
    try {
      fs.rmSync(path.join(ROOT, "sentinel.cfg.json"), { force: true }); // 卫生
      fs.rmSync(SIG, { force: true });
    } catch {
      /* best effort */
    }
  }
} finally {
  for (const k of kids) {
    try {
      k.kill();
    } catch {
      /* already gone */
    }
  }
  await sleep(400);
  BASE.cleanup();
}
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
