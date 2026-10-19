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
 * 前置：node >= 20；无 git/网络依赖；总时长 ~60s（全部加速参数驱动， Windows/linux 均可）。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGIN_DIR, Checker } from "../harness/jsonrpc-client.mjs";
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
