/*!
 * suites/sentinel-teardown.mjs —— 哨兵 v2.1 待命制 + 寿命轮换选举（bg-sentinel.mjs 黑盒，加速参数驱动）
 *
 * 覆盖断言组（v0.5.1 全清零唤醒改造：平台把任何后台退出都变成完成通知，全清三实例三连唤属缺陷）：
 *   T1 全清待命不退（观察窗存活 + state=standby + 心跳续刷 + 零回声零 fired + 待命期板不可读静默续待命）
 *   T2 板面复活（新在飞 → state=active；未签收 → 复活后告警照旧 exit 1 + echo/fired + 槽位释放）
 *   T3 寿命 cap 单赢家选举（3 实例：到期前零退出；退出全 0 带轮换文案；相邻退出间隔 ≥ 寿命刻度；
 *      family-teardown 标记随最后赢家更新；轮换零告警副作用）
 *   T4 标记/槽位容错与混跑兼容（陈旧标记夺位、损坏标记修复、新鲜标记顺延、旧格式槽位共存）
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
