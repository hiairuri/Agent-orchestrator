// @module sentinel-teardown
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
 *   T11 CLN-05（v0.9 C8）：writeSentinelCfg 全 sparse cfg 形状——无 argv 启动 cfg 仅含
 *      signals 块（v2 十键+桥四键全缺省）、显式单键仅该键+signals（黑盒 spawn server
 *      两腿）+零漂移对拍锁（server 十键 numArgOpt 无 numArg 遗留 ∧ 哨兵内建默认字面量
 *      表逐条在位 ∧ 对拍表登记 v0.9.x.md）
 *   T12 W4 A1（v1.1；v1.1.1 W20 日志化重构）：stop-check coord-tail 追加日志黑盒——
 *      v2 双标签（`<!-- orch-tail v2` + `<!-- orch-tail-end -->`，成对/最后一组完整对/
 *      尾锚定）→ `<存储根>/context/coord-tail-log.md` 逐字追加（含 ts:/seq:，块间空行，
 *      无文件头）。T12-a..k 改靶保留（无标记零写/全形追加/短形 delta/飞名单边界/超帽/
 *      未知字段/subagent 前缀/缺基线/多块取末）；T12-w/x 锁 v1 块零触发与尾锚定；
 *      T12-o/p 变化即追加+同内容幂等（stop_hook_active 重入）；T12-q 封顶改写为滞回裁剪腿
 *      （v1.2.2 20/10：第 21 块触发原子重写留最新 10）+ HYS-01 累积腿/HYS-02 单写触发腿；
 *      T12-r 旧 v1 seed 幂等+三遗留清理；T12-s 跨会话追加无冻结（append 无判旧正面锁）；
 *      T12-t 坏条目容错；T12-u 写失败 fail-safe；T12-v/v2 祖先回退命中与默认根合法性优先。
 *      （T12-h 判旧腿与 T12-n ts 时刻守卫腿随「append 无判旧」结构性删除；T12-l/m 改造并入
 *      T12-s/T12-r。）
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
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PLUGIN_DIR, Checker, startServer } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot } from "../harness/temp-root.mjs";
import { captureBackground, runCapture } from "../harness/capture.mjs";

const ck = new Checker("sentinel-teardown");
const SENTINEL = path.join(PLUGIN_DIR, "hooks", "bg-sentinel.mjs");
const STOP_CHECK = path.join(PLUGIN_DIR, "hooks", "stop-check.mjs");
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
// v1.2 M9-1 scoping：本套件夹具的「本哨兵锚」会话 id——期望开枪的 mission 一律
// dispatch.session_id=SID（归属等值判定正例）；SCP 组负例用他值/缺省。
const SID = "sess_coord";
const writeAnchor = (sid = SID) => {
  fs.mkdirSync(SENT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SENT_DIR, "coord-session.txt"), sid + "\n");
};
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
  writeAnchor(); // v1.2 M9-1：夹具恒布锚（scoping 等值判定本侧；无锚=全部 mission 被 scoping 跳过）
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
        dispatch: { agent_id: "agent_b2b", mode: "agent", session_id: SID },
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
        dispatch: { agent_id: "agent_x", mode: "agent", session_id: SID },
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
        dispatch: { agent_id: "agent_wake2", mode: "agent", session_id: SID },
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

  /* ---- T11 CLN-05（v0.9 C8）：writeSentinelCfg 全 sparse cfg 形状 ----
     server 模块加载副作用写 <root>/sentinel.cfg.json；全 sparse 转正后 cfg 仅含
     显式传入键 + signals block 恒在（v0.9-DESIGN §5 / §16 CLN-05）。独立临时根
     裸 spawn server（本套件首次直起 server——黑盒哨兵套件不经 MCP 面，裸进程即
     模块加载；crv5-auth 场景 D spawnForCfg 同款）。零漂移对拍=双文件常量锁
     （server 十键全 numArgOpt 条件写且 numArg 零遗留 ∧ 哨兵内建默认字面量表逐条
     在位=转正前 server 默认）+登记面锁（零漂移对拍表在 v0.9.x.md）。 */
  {
    const SERVER = path.join(PLUGIN_DIR, "mcp", "server.mjs");
    const srvSrc = readText(SERVER);
    const sentSrc = readText(SENTINEL);
    const v09x = readText(path.join(PLUGIN_DIR, "tests", "assertions", "v0.9.x.md"));
    const spawnForCfg = (extraArgs, rootDir) => {
      fs.mkdirSync(rootDir, { recursive: true });
      const child = spawn(process.execPath, [SERVER, "--root", rootDir, ...extraArgs], {
        cwd: rootDir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      kids.push(child);
      return child;
    };
    const waitCfg = async (rootDir) => {
      const p = path.join(rootDir, "sentinel.cfg.json");
      const ok = await waitFor(() => fs.existsSync(p), 15000, 50);
      if (!ok) throw new Error("sentinel.cfg.json not written: " + p);
      return readJson(p);
    };
    const V2_KEYS = [
      "wake_poll_sec", "wake_grace_min", "answer_grace_min", "stall_grace_min", "crash_grace_min",
      "coord_idle_min", "cap_window_min", "family_size", "stagger_sec", "max_lifetime_min",
    ];
    const ALL_CFG_KEYS = [...V2_KEYS, "wake_timeout_min", "wake_retries", "refire_gap_min", "wake_cap"];
    const SPARSE_FLAGS = [
      ["--poll-sec", 1, 3600], ["--sentinel-grace-min", 0.01, 1440], ["--answer-grace-min", 0.01, 1440],
      ["--stall-grace-min", 0.01, 1440], ["--crash-grace-min", 0.01, 1440], ["--coord-idle-min", 0.01, 1440],
      ["--cap-window-min", 1, 10080], ["--sentinel-family", 1, 5], ["--stagger-sec", 0, 600],
      ["--max-lifetime-min", 0.01, 43200],
    ];

    // CLN-05a：无 argv 启动 → cfg 恰含 signals 块（十键+桥四键全缺省）
    {
      const R = path.join(BASE.root, "cln5-a");
      spawnForCfg([], R);
      const cfg = await waitCfg(R);
      const present = ALL_CFG_KEYS.filter((k) => k in cfg);
      ck.ok(
        "CLN-05a 全 sparse：无 argv 启动 → cfg 仅含 signals 块（v2 十键+桥四键全缺省，键缺失非占位）",
        present.length === 0 && cfg.signals && typeof cfg.signals === "object" && cfg.signals.toast_on_abandon === true,
        { present, keys: Object.keys(cfg) },
      );
    }
    // CLN-05b：显式单键 → 仅该键+signals（仅显式传入键出现）
    {
      const R = path.join(BASE.root, "cln5-b");
      spawnForCfg(["--stall-grace-min", "7"], R);
      const cfg = await waitCfg(R);
      const others = ALL_CFG_KEYS.filter((k) => k in cfg && k !== "stall_grace_min");
      ck.ok(
        "CLN-05b 全 sparse：显式 --stall-grace-min 7 → cfg 恰为 {stall_grace_min:7}+signals（仅显式传入键出现）",
        cfg.stall_grace_min === 7 && others.length === 0 && cfg.signals && typeof cfg.signals === "object",
        { stall: cfg.stall_grace_min, others },
      );
    }
    // CLN-05c：零漂移对拍锁（双文件常量锁+登记面锁）
    const srvSparse = SPARSE_FLAGS.map(([f]) => ({
      f,
      opt: srvSrc.includes(`numArgOpt(argv, "${f}", `),
      noLegacy: !srvSrc.includes(`numArg(argv, "${f}"`),
    }));
    const srvSparseAll = srvSparse.every((x) => x.opt && x.noLegacy);
    // 哨兵侧内建默认字面量表（逐键=转正前 server 默认，bg-sentinel 源码行转录）
    const sentDefaults = [
      '"wake_poll_sec", 60, 1, 3600', '"max_lifetime_min", 1440, 0.01, 43200',
      '"wake_grace_min", null, 5, 0.01, 1440', '"answer_grace_min", null, 3, 0.01, 1440',
      '"stall_grace_min", null, 30, 0.01, 1440', '"crash_grace_min", null, 10, 0.01, 1440',
      '"coord_idle_min", null, 3, 0.01, 1440', '"cap_window_min", null, 120, 1, 10080',
      '"family_size", null, 3, 1, 5', '"stagger_sec", null, 20, 0, 600',
    ].map((s) => ({ s, hit: sentSrc.includes(s) }));
    const sentDefaultsAll = sentDefaults.every((x) => x.hit);
    const registered = v09x.includes("A-v090-CLN-05") && v09x.includes("零漂移对拍表");
    ck.ok(
      "CLN-05c 零漂移对拍锁：server 十键全 numArgOpt 条件写（numArg 零遗留）∧ 哨兵内建默认字面量表逐条在位（=转正前 server 默认，二次 shadow 消除）∧ 零漂移对拍表登记在 v0.9.x.md",
      srvSparseAll && sentDefaultsAll && registered,
      { srvSparse: srvSparse.filter((x) => !(x.opt && x.noLegacy)), sentDefaults: sentDefaults.filter((x) => !x.hit).map((x) => x.s), registered },
    );
  }

  /* ---- T12 v1.1.1 W20：coord-tail 追加日志（stop-check 黑盒，ORT-1..8 + v2 双标签） ----
     grill#3 G3-5 形制：开标签 `<!-- orch-tail v2` + 闭标签 `<!-- orch-tail-end -->`；
     成对闭合 / 只取消息最后一组完整对 / 尾锚定（闭标签=消息末非空行，尾随空白容忍）。
     日志 `<root>/context/coord-tail-log.md`：条目=发射全形块逐字（含 ts/seq 协议行），
     块间空行、无文件头；变化即追加（剥协议行等值跳过）；v1.2.2 滞回 20/10（累积至 20
     不滑动最上不丢，第 21 块 → 读-裁留最新 10-整文件原子重写）；坏条目跳过向前找基线。
     旧 v1 文件仅 seed 源（幂等），日志本轮写成功后三遗留（compact/stale/v1）静默清理。 */
  {
    const SCP = path.join(BASE.root, "stopcheck");
    const SCR = path.join(SCP, ".zcode", "orchestrator");
    const CTX = path.join(SCR, "context");
    const LOG = path.join(CTX, "coord-tail-log.md");
    const LEGACY = path.join(CTX, "coord-tail.md");
    const LEGACY_COMPACT = path.join(CTX, "coord-tail.compact.md");
    const LEGACY_STALE = path.join(CTX, "coord-tail.compact.stale");
    const resetSC = () => {
      fs.rmSync(SCP, { recursive: true, force: true });
      fs.mkdirSync(SCR, { recursive: true });
      fs.writeFileSync(path.join(SCR, "board.json"), JSON.stringify({ version: 2, missions: [] }) + "\n");
    };
    const fullBlock = (over = {}) =>
      [
        "<!-- orch-tail v2",
        `ts: ${over.ts ?? "2026-10-25T05:00:00.000Z"}`,
        `seq: ${over.seq ?? 1}`,
        `project: ${over.project ?? "v1.1.1 施工中"}`,
        `stage: ${over.stage ?? "W20"}`,
        `flying: ${over.flying ?? "m-a"}`,
        `ruled: ${over.ruled ?? "日志唯一源"}`,
        `next: ${over.next ?? "机制波"}`,
        "<!-- orch-tail-end -->",
      ].join("\n");
    const shortBlock = (over = {}) =>
      [
        "<!-- orch-tail v2",
        `ts: ${over.ts ?? "2026-10-25T05:01:00.000Z"}`,
        `seq: ${over.seq ?? 2}`,
        `flying: ${over.flying ?? "m-b"}`,
        `next: ${over.next ?? "收口"}`,
        "<!-- orch-tail-end -->",
      ].join("\n");
    const legacyV1Block = (over = {}) =>
      [
        "<!-- orch-tail v1",
        `ts: ${over.ts ?? "2026-10-25T05:00:00.000Z"}`,
        `seq: ${over.seq ?? 1}`,
        `project: ${over.project ?? "v1.1.1 施工中"}`,
        `stage: ${over.stage ?? "W20"}`,
        `flying: ${over.flying ?? "m-a"}`,
        `ruled: ${over.ruled ?? "日志唯一源"}`,
        `next: ${over.next ?? "机制波"}`,
        "-->",
      ].join("\n");
    const runStop = (msg, { session_id = "sess_main-1", stop_hook_active = false, cwd = SCP, envProject = SCP } = {}) =>
      runCapture({
        script: process.execPath,
        args: [STOP_CHECK, "--mirror", "off"],
        input: JSON.stringify({ session_id, stop_hook_active, last_assistant_message: msg }),
        cwd,
        env: { ZCODE_PROJECT_DIR: envProject },
      });
    const readLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : null);
    const scanBlocks = (text) => {
      const lines = String(text ?? "").split(/\r?\n/);
      const out = [];
      let open = -1;
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t === "<!-- orch-tail v2") open = i;
        else if (t === "<!-- orch-tail-end -->" && open >= 0) {
          out.push(lines.slice(open, i + 1).join("\n"));
          open = -1;
        }
      }
      return out;
    };
    const logBlocks = () => scanBlocks(readLog());
    const stripProto = (blockText) =>
      blockText.split("\n").filter((line) => !/^(ts|seq): /.test(line)).join("\n");

    resetSC();
    {
      const r = runStop("本轮无契约块，只有正文。");
      ck.ok(
        "T12-a 无标记轮次零写：日志不产生（context 目录亦不建）+ exit 0 静默",
        r.code === 0 && !fs.existsSync(LOG) && !fs.existsSync(CTX) && !r.stderr.trim(),
        { code: r.code, stderr: r.stderr, exists: fs.existsSync(LOG) },
      );
    }
    {
      const r = runStop(fullBlock());
      const got = readLog();
      ck.ok(
        "T12-b 全形块 → 日志首条逐字追加（v2 标签对/字段序/含 ts:seq: 协议行/exit 0）",
        r.code === 0 && got === fullBlock() + "\n" && logBlocks().length === 1 && !r.stderr.trim(),
        { got, stderr: r.stderr },
      );
    }
    {
      const before = readLog();
      const r = runStop(shortBlock({ flying: "+m-b,-m-a" }));
      const got = logBlocks();
      const want = fullBlock({ ts: "2026-10-25T05:01:00.000Z", seq: 2, flying: "m-b", next: "收口" });
      ck.ok(
        "T12-c 短形 delta 合并后追加全形条目（基线=日志末条；project/stage/ruled 保留、flying +/-、ts/seq 换新）",
        r.code === 0 && got.length === 2 && got[1] === want && readLog() !== before && !r.stderr.trim(),
        { last: got[1], want, stderr: r.stderr },
      );
    }
    {
      const r = runStop(shortBlock({ seq: 3, flying: "-m-z,+m-b,+m-c" }));
      const got = logBlocks();
      ck.ok(
        "T12-d 短形 flying 边界：-不存在 id 忽略、+已存在 id 不重复（合并后 ≤3）→ 新条目 flying: m-b, m-c",
        r.code === 0 && got.length === 3 && got[2].includes("flying: m-b, m-c") && got[2].includes("seq: 3") && !r.stderr.trim(),
        { last: got[2], stderr: r.stderr },
      );
      const before4 = readLog();
      const r4 = runStop(shortBlock({ seq: 4, flying: "+m-d,+m-e" }));
      ck.ok(
        "T12-e 短形 flying 合并超 3 条 → 整轮丢弃（日志逐字节不动 + stderr）",
        r4.code === 0 && readLog() === before4 && r4.stderr.includes("flying"),
        { stderr: r4.stderr, changed: readLog() !== before4 },
      );
    }
    {
      const before = readLog();
      const r = runStop(fullBlock({ seq: 9, project: "x".repeat(950) }));
      ck.ok(
        "T12-f 全形超帽（>900B）→ 拒追加 + stderr「超帽」，日志逐字节保留",
        r.code === 0 && readLog() === before && r.stderr.includes("超帽"),
        { stderr: r.stderr, changed: readLog() !== before },
      );
    }
    {
      const before = readLog();
      const r = runStop(fullBlock({ seq: 10 }).replace("next: 机制波", "owner: 未知字段\nnext: 机制波"));
      ck.ok(
        "T12-g 未知字段（白名单外）→ 整块拒绝 + stderr，日志逐字节保留",
        r.code === 0 && readLog() === before && r.stderr.includes("未知字段"),
        { stderr: r.stderr, changed: readLog() !== before },
      );
    }
    {
      const before = readLog();
      const r = runStop(fullBlock({ seq: 99 }), { session_id: "sess_subagent_agent_abc" });
      ck.ok(
        "T12-i 子代理会话（sess_subagent_ 前缀）→ 跳过抽取，零写零告警",
        r.code === 0 && readLog() === before && !r.stderr.trim(),
        { stderr: r.stderr, changed: readLog() !== before },
      );
    }
    {
      resetSC();
      const r = runStop(shortBlock({ seq: 1, flying: "+m-b" }));
      ck.ok(
        "T12-j 短形无全形基线 → 不立日志 + stderr「缺全形基线」",
        r.code === 0 && !fs.existsSync(LOG) && r.stderr.includes("缺全形基线"),
        { stderr: r.stderr, exists: fs.existsSync(LOG) },
      );
    }
    {
      resetSC();
      const msg =
        "正文引用旧块：\n" + fullBlock({ seq: 1, project: "旧" }) + "\n正文尾巴\n" + fullBlock({ seq: 2, project: "新" });
      const r = runStop(msg);
      const got = logBlocks();
      ck.ok(
        "T12-k 多块取最后一块（只取消息最后一组完整对）：日志=seq 2 块",
        r.code === 0 && got.length === 1 && got[0] === fullBlock({ seq: 2, project: "新" }),
        { got },
      );
    }
    {
      // v1 块出现在消息里 = 无 v2 标记 → 零写零告警（形制切换的正面锁）。
      resetSC();
      const r = runStop("旧格式正文：\n" + legacyV1Block());
      ck.ok(
        "T12-w v1 块不触发 v2 抽取（无 v2 标记）：零写零告警 + context 目录不建",
        r.code === 0 && !fs.existsSync(LOG) && !fs.existsSync(CTX) && !r.stderr.trim(),
        { stderr: r.stderr, exists: fs.existsSync(LOG) },
      );
    }
    {
      // 尾锚定：闭标签必须是消息末非空行；尾随空白容忍。
      resetSC();
      const noAnchor = runStop(fullBlock({ seq: 1 }) + "\n正文尾巴");
      ck.ok(
        "T12-x 尾锚定：块后仍有正文 → 零写零告警（中段引述/回声不合格）",
        noAnchor.code === 0 && !fs.existsSync(LOG) && !noAnchor.stderr.trim(),
        { stderr: noAnchor.stderr, exists: fs.existsSync(LOG) },
      );
      const trailing = runStop(fullBlock({ seq: 1 }) + "   \n\t ");
      ck.ok(
        "T12-x2 尾锚定容忍尾随空白：闭标签后仅空白 → 正常追加",
        trailing.code === 0 && readLog() === fullBlock({ seq: 1 }) + "\n" && !trailing.stderr.trim(),
        { stderr: trailing.stderr, got: readLog() },
      );
    }
    {
      // 变化即追加：业务字段变 → 新条目（旧条目保留，append-only）。
      resetSC();
      const r0 = runStop(fullBlock({ seq: 1, next: "一" }));
      const r1 = runStop(fullBlock({ seq: 2, ts: "2026-10-25T05:02:00.000Z", next: "二" }));
      const got = logBlocks();
      ck.ok(
        "T12-o 变化即追加：业务字段（next）变 → 日志新增一条全形条目（旧条目保留，块间空行）",
        r0.code === 0 &&
          r1.code === 0 &&
          got.length === 2 &&
          got[0].includes("next: 一") &&
          got[1].includes("next: 二") &&
          readLog().includes("<!-- orch-tail-end -->\n\n<!-- orch-tail v2") &&
          !r1.stderr.trim(),
        { count: got.length, stderr: r1.stderr },
      );
    }
    {
      // 同内容幂等：只有 ts/seq 协议行变 → 剥后相等 → 零追加；stop_hook_active 重入仍一条。
      resetSC();
      const msg1 = fullBlock({ seq: 1, next: "同内容" });
      runStop(msg1);
      const before = readLog();
      const r2 = runStop(fullBlock({ seq: 2, ts: "2026-10-25T05:09:00.000Z", next: "同内容" }));
      const r3 = runStop(msg1, { stop_hook_active: true });
      ck.ok(
        "T12-p 同内容幂等：仅 ts/seq 变 → 零追加；stop_hook_active 重入双 Stop → 仍一条（日志逐字节不动）",
        r2.code === 0 && r3.code === 0 && readLog() === before && logBlocks().length === 1 && !r2.stderr.trim() && !r3.stderr.trim(),
        { count: logBlocks().length, stderr: r2.stderr },
      );
    }
    {
      // v1.2.2 滞回（原 T12-q「封顶 K=10 第 11 块触发」改写）：连续 21 轮 → 第 21 块
      // 触发原子重写，保留最新 10（seq12..21），seq1..11 全出队。
      resetSC();
      for (let i = 1; i <= 21; i++) {
        runStop(
          fullBlock({
            seq: i,
            ts: `2026-10-25T06:${String(i).padStart(2, "0")}:00.000Z`,
            next: "n" + i,
          }),
        );
      }
      const got = logBlocks();
      ck.ok(
        "T12-q 滞回裁剪腿（v1.2.2 自「封顶 K=10 第 11 块触发」改写）：第 21 块触发原子重写（seq1..11 出队，保留最新 10，末块最新）",
        got.length === 10 &&
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].every((n) => !readLog().includes(`seq: ${n}\n`)) &&
          got[0] === fullBlock({ seq: 12, ts: "2026-10-25T06:12:00.000Z", next: "n12" }) &&
          got[9] === fullBlock({ seq: 21, ts: "2026-10-25T06:21:00.000Z", next: "n21" }),
        { count: got.length, first: got[0] && got[0].split("\n")[2], last: got[9] && got[9].split("\n")[2] },
      );
      // HYS-01 累积腿：20 块 ≤ TRIM_AT → 全程 plain append，最上不丢（seq1 在位）。
      resetSC();
      for (let i = 1; i <= 20; i++) {
        runStop(
          fullBlock({
            seq: i,
            ts: `2026-10-25T07:${String(i).padStart(2, "0")}:00.000Z`,
            next: "h" + i,
          }),
        );
      }
      const gotH1 = logBlocks();
      ck.ok(
        "HYS-01 累积腿（v1.2.2 滞回）：20 块不滑动（无裁剪，最上不丢）——恰 20 全在位，seq1..20 逐块等值",
        gotH1.length === 20 &&
          gotH1[0] === fullBlock({ seq: 1, ts: "2026-10-25T07:01:00.000Z", next: "h1" }) &&
          gotH1[19] === fullBlock({ seq: 20, ts: "2026-10-25T07:20:00.000Z", next: "h20" }),
        { count: gotH1.length, first: gotH1[0] && gotH1[0].split("\n")[2], last: gotH1[19] && gotH1[19].split("\n")[2] },
      );
      // HYS-02 单写触发腿：恰 20 块日志（直投种子）追加第 21 块 → 一步裁回 10
      // （keep 末 9=seq12..20 + 新块 21；seq11 消失=被裁边界，seq12 在位=保住边界）。
      resetSC();
      fs.mkdirSync(CTX, { recursive: true });
      const seed20 = Array.from({ length: 20 }, (_, k) =>
        fullBlock({
          seq: k + 1,
          ts: `2026-10-25T08:${String(k + 1).padStart(2, "0")}:00.000Z`,
          next: "s" + (k + 1),
        }),
      ).join("\n\n");
      fs.writeFileSync(LOG, seed20 + "\n");
      const rH2 = runStop(fullBlock({ seq: 21, ts: "2026-10-25T08:21:00.000Z", next: "s21" }));
      const gotH2 = logBlocks();
      ck.ok(
        "HYS-02 裁剪腿（v1.2.2 滞回）：恰 20 块 + 第 21 块 → 原子重写保留最新 10（含新块，seq11 消失、seq12..21 在位）",
        rH2.code === 0 &&
          gotH2.length === 10 &&
          !readLog().includes("seq: 11\n") &&
          gotH2[0] === fullBlock({ seq: 12, ts: "2026-10-25T08:12:00.000Z", next: "s12" }) &&
          gotH2[8] === fullBlock({ seq: 20, ts: "2026-10-25T08:20:00.000Z", next: "s20" }) &&
          gotH2[9] === fullBlock({ seq: 21, ts: "2026-10-25T08:21:00.000Z", next: "s21" }),
        { count: gotH2.length, first: gotH2[0] && gotH2[0].split("\n")[2], stderr: rH2.stderr },
      );
    }
    {
      // seed（Q7=a）：日志缺失 + 旧 v1 全形可解析 → 转 v2 渲染为首条；本轮写成功后三遗留全删。
      resetSC();
      fs.mkdirSync(CTX, { recursive: true });
      fs.writeFileSync(LEGACY, legacyV1Block());
      fs.writeFileSync(LEGACY_COMPACT, "<!-- orch-tail-compact v1 seq=9\np: 旧派生件\n-->\n");
      fs.writeFileSync(LEGACY_STALE, "at: 2026-10-25T04:00:00.000Z\nreason: OLD\n");
      const r = runStop(fullBlock());
      const got = logBlocks();
      ck.ok(
        "T12-r seed 幂等 + 三遗留清理：v1 全形 → 日志首条 v2 渲染（等值轮零追加）+ 旧文件/compact/stale 全删",
        r.code === 0 &&
          got.length === 1 &&
          got[0] === fullBlock() &&
          !readLog().includes("orch-tail v1") &&
          !fs.existsSync(LEGACY) &&
          !fs.existsSync(LEGACY_COMPACT) &&
          !fs.existsSync(LEGACY_STALE) &&
          !r.stderr.trim(),
        { count: got.length, stderr: r.stderr, legacy: fs.existsSync(LEGACY), compact: fs.existsSync(LEGACY_COMPACT), stale: fs.existsSync(LEGACY_STALE) },
      );
      // 日志在位 → 永不再 seed（重建旧文件，其内容不得被吸收）
      fs.writeFileSync(LEGACY, legacyV1Block({ project: "重种子应拒绝" }));
      const r2 = runStop(fullBlock({ seq: 2, ts: "2026-10-25T05:02:00.000Z", next: "第二轮" }));
      const got2 = logBlocks();
      ck.ok(
        "T12-r2 日志在位不 seed：旧文件内容不入日志（seed 仅首轮），新块照常追加 + 旧文件再清理",
        r2.code === 0 && got2.length === 2 && !readLog().includes("重种子应拒绝") && got2[1].includes("next: 第二轮") && !fs.existsSync(LEGACY),
        { count: got2.length, stderr: r2.stderr, legacy: fs.existsSync(LEGACY) },
      );
    }
    {
      // 跨会话追加无冻结（append 无判旧的正面锁）：seq 40 → 1 两块均入日志。
      resetSC();
      const r0 = runStop(
        fullBlock({
          seq: 40,
          ts: "2026-10-25T04:00:00.000Z",
          project: "旧会话项目",
          stage: "旧阶段",
          flying: "m-old",
          next: "旧下一步",
        }),
        { session_id: "sess_old-session" },
      );
      const r1 = runStop(
        fullBlock({
          seq: 1,
          ts: "2026-10-25T05:00:00.000Z",
          project: "新会话项目",
          stage: "新阶段",
          flying: "m-new",
          next: "新下一步",
        }),
        { session_id: "sess_new-session" },
      );
      const got = logBlocks();
      ck.ok(
        "T12-s 跨会话追加无冻结：seq 40 → 1 两块均入日志、零拒（判旧守卫复活必红）",
        r0.code === 0 &&
          r1.code === 0 &&
          got.length === 2 &&
          got[0].includes("project: 旧会话项目") &&
          got[1].includes("project: 新会话项目") &&
          !r1.stderr.trim(),
        { count: got.length, stderr: r1.stderr },
      );
    }
    {
      // 坏条目容错：撕裂块跳过向前找基线；追加不产不可解析态。
      resetSC();
      runStop(fullBlock({ seq: 1, flying: "m-s", next: "一" }));
      fs.appendFileSync(LOG, "\n\n<!-- orch-tail v2\nts: 2026-10-25T06:00:00.000Z\nseq: 2\n");
      const r2 = runStop(fullBlock({ seq: 3, ts: "2026-10-25T07:00:00.000Z", flying: "m-t", next: "三" }));
      const r3 = runStop(shortBlock({ seq: 4, ts: "2026-10-25T08:00:00.000Z", flying: "+m-x", next: "四" }));
      const got = logBlocks();
      ck.ok(
        "T12-t 坏条目容错：撕裂块跳过向前找基线；前后块可读（短形合并自 seq3 全形）且撕裂原文未被改写",
        r2.code === 0 &&
          r3.code === 0 &&
          got.length === 3 &&
          got[2].includes("seq: 4") &&
          got[2].includes("flying: m-t, m-x") &&
          readLog().includes("\nts: 2026-10-25T06:00:00.000Z\nseq: 2\n") &&
          !r3.stderr.trim(),
        { count: got.length, last: got[2], stderr: r3.stderr },
      );
    }
    {
      // 写失败 fail-safe：日志路径被目录占据 → appendFileSync EISDIR；恢复源绝不删。
      resetSC();
      fs.mkdirSync(CTX, { recursive: true });
      fs.mkdirSync(LOG);
      fs.writeFileSync(LEGACY, legacyV1Block());
      const r = runStop(fullBlock({ seq: 5 }));
      ck.ok(
        "T12-u 写失败 fail-safe：stderr 一行含「写入失败」+ exit 0 + 恢复源 coord-tail.md 不删",
        r.code === 0 && r.stderr.includes("写入失败") && fs.existsSync(LEGACY) && fs.statSync(LOG).isDirectory(),
        { stderr: r.stderr, legacy: fs.existsSync(LEGACY), logIsDir: fs.statSync(LOG).isDirectory() },
      );
    }
    {
      // 祖先回退（v1.1.1 W20；五处 twin 同文）：cwd=子目录、板在根 → 定根命中祖先。
      const ANC = path.join(BASE.root, "anc-stopcheck");
      const ANC_ROOT = path.join(ANC, ".zcode", "orchestrator");
      const ANC_LOG = path.join(ANC_ROOT, "context", "coord-tail-log.md");
      fs.mkdirSync(ANC_ROOT, { recursive: true });
      fs.writeFileSync(path.join(ANC_ROOT, "board.json"), JSON.stringify({ version: 2, missions: [] }) + "\n");
      fs.writeFileSync(path.join(ANC_ROOT, "root-id"), "0123456789abcdef\n");
      const DEEP = path.join(ANC, "sub", "deep");
      fs.mkdirSync(DEEP, { recursive: true });
      const r = runStop(fullBlock({ seq: 7, next: "祖先" }), { cwd: DEEP, envProject: DEEP });
      ck.ok(
        "T12-v 祖先回退：cwd=子目录且默认根无板无 root-id → 定根命中祖先根（日志落祖先根 + stderr 定根回退一行 + 子目录零 .zcode）",
        r.code === 0 &&
          fs.existsSync(ANC_LOG) &&
          fs.readFileSync(ANC_LOG, "utf8") === fullBlock({ seq: 7, next: "祖先" }) + "\n" &&
          !fs.existsSync(path.join(DEEP, ".zcode")) &&
          r.stderr.includes("定根回退") &&
          r.stderr.includes(ANC_ROOT),
        { stderr: r.stderr.slice(0, 200), exists: fs.existsSync(ANC_LOG) },
      );
      // 反证：默认根合法（有 board.json）→ 不向祖先回退。
      fs.mkdirSync(path.join(DEEP, ".zcode", "orchestrator"), { recursive: true });
      fs.writeFileSync(
        path.join(DEEP, ".zcode", "orchestrator", "board.json"),
        JSON.stringify({ version: 2, missions: [] }) + "\n",
      );
      const r2 = runStop(fullBlock({ seq: 8, next: "默认根" }), { cwd: DEEP, envProject: DEEP });
      const deepLog = path.join(DEEP, ".zcode", "orchestrator", "context", "coord-tail-log.md");
      ck.ok(
        "T12-v2 默认根合法性优先：默认根有 board.json → 不向祖先回退（日志落默认根、无定根回退告警）",
        r2.code === 0 && fs.existsSync(deepLog) && !r2.stderr.includes("定根回退"),
        { stderr: r2.stderr.slice(0, 200), exists: fs.existsSync(deepLog) },
      );
    }
  }

  /* ======== v1.2 M9-1 SCP/REV 组（A-v0120-SCP/REV；impl-plan §批2 M9-1 验收） ========
     SCP-a 他会话零开枪+静默留痕；SCP-b①b 空值三段（无归因零开枪+scoping-skipped 留痕
     +归因补齐自动恢复）；REV-③ 补告警（复活首扫集中补发恰一次）；REV-④ O10 协同
     （首扫以 board timeline 重派事件为活动锚，不误判双跑）；REV-⑤ 组包尾块缺席计数
     （pure 区直测+接线静态锁）；REV-⑥⑦ 触发面②端到端（dispatch 探活补员+计数实装）。 */
  {
    const rmSilent = (p) => {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    };
    const cleanAll = () => {
      for (const n of fs.readdirSync(SENT_DIR).filter((n) => /^instance-\d+\.json$/.test(n))) {
        fs.rmSync(path.join(SENT_DIR, n), { force: true });
      }
      rmSilent(path.join(SENT_DIR, "fired"));
      rmSilent(ECHO);
      rmSilent(path.join(SENT_DIR, "quarantine.json"));
    };
    const firedNamesM = (prefix) => {
      try {
        return fs.readdirSync(path.join(SENT_DIR, "fired")).filter((n) => n.startsWith(prefix));
      } catch {
        return [];
      }
    };
    const absMin = (min) => new Date(Date.now() - min * 60000).toISOString();

    // ---- SCP-a：他会话 mission 零开枪 + 静默留痕（MOD3a-QA 三枪全丢误报靶心）
    cleanAll();
    writeAnchor(SID);
    writeBoard([
      {
        id: "m-scp-a",
        title: "foreign-mission",
        status: "done",
        dispatch: { agent_id: "agent_scp_a", mode: "agent", session_id: "sess_other" },
        timeline: [],
        updated_at: absMin(10),
      },
    ]);
    const bgA91 = spawnSentinel({});
    const tracedA = await waitFor(() => readText(ECHO).includes("scoping-foreign"), 8000);
    await sleep(1500);
    ck.ok(
      "SCP-a 他会话 mission 零开枪+静默留痕：scoping-foreign 回声落盘 ∧ 零 fired ∧ 哨兵存活不退出（他会话完成态照常落板+spool，本哨兵不代开枪）",
      tracedA && firedNamesM("m-scp-a--").length === 0 && bgA91.proc.exitCode === null,
      { tracedA, fired: firedNamesM("m-scp-a--"), alive: bgA91.proc.exitCode === null, echo: readText(ECHO).slice(0, 160) },
    );
    bgA91.kill();
    await bgA91.done;

    // ---- SCP-b：空值三段——无归因零开枪 + scoping-skipped 留痕；归因补齐自动恢复盯守
    cleanAll();
    writeAnchor(SID);
    writeBoard([
      {
        id: "m-scp-b",
        title: "no-attribution",
        status: "done",
        dispatch: { agent_id: "agent_scp_b", mode: "agent" },
        timeline: [],
        updated_at: absMin(10),
      },
    ]);
    const bgB91 = spawnSentinel({});
    const tracedB = await waitFor(() => readText(ECHO).includes("scoping-skipped"), 8000);
    await sleep(1200);
    ck.ok(
      "SCP-b① 无归因 mission 零开枪+scoping-skipped 留痕（缺席回落硬约束=漏报可见，禁静默零开枪；组包尾块计数见 REV-⑤⑦）",
      tracedB && firedNamesM("m-scp-b--").length === 0 && bgB91.proc.exitCode === null,
      { tracedB, fired: firedNamesM("m-scp-b--"), alive: bgB91.proc.exitCode === null, echo: readText(ECHO).slice(0, 160) },
    );
    // 归因补齐（前向归因字段落盘）→ 每 tick 重判自动恢复盯守
    writeBoard([
      {
        id: "m-scp-b",
        title: "no-attribution",
        status: "done",
        dispatch: { agent_id: "agent_scp_b", mode: "agent", session_id: SID },
        timeline: [],
        updated_at: absMin(10),
      },
    ]);
    const rB91 = await Promise.race([bgB91.done, sleep(12000).then(() => null)]);
    ck.ok(
      "SCP-b② 归因补齐自动恢复盯守：同 mission 转 owned 后照旧开枪（exit 1 唤醒失败告警 + fired 落盘）",
      Boolean(rB91) && rB91.code === 1 && rB91.stdout.includes("唤醒失败告警") && firedNamesM("m-scp-b--unclaimed_terminal--").length >= 1,
      rB91 && { code: rB91.code, fired: firedNamesM("m-scp-b--") },
    );

    // ---- REV-③：复活补告警（团灭期错过的升级，复活首扫集中补发恰一次）
    cleanAll();
    writeAnchor(SID);
    writeBoard([
      {
        id: "m-rev-c",
        title: "missed-escalation",
        status: "done",
        dispatch: { agent_id: "agent_rev_c", mode: "agent", session_id: SID },
        timeline: [],
        updated_at: absMin(10),
      },
    ]);
    const bgC91 = spawnSentinel({});
    const rC91 = await Promise.race([bgC91.done, sleep(12000).then(() => null)]);
    const echoC = readText(ECHO);
    const catchupN = (echoC.match(/"category":"catchup"/g) || []).length;
    ck.ok(
      "REV-③ 补告警：复活首扫对缺位期已到期升级集中补告警恰一次（echo catchup ×1 + 计数文案）且正常开枪路径照旧（exit 1 + fired）",
      Boolean(rC91) && rC91.code === 1 && catchupN === 1 && echoC.includes("补告警：哨兵缺位期间到期升级 1 件") && firedNamesM("m-rev-c--unclaimed_terminal--").length >= 1,
      { code: rC91 && rC91.code, catchupN, echo: echoC.slice(0, 200) },
    );

    // ---- REV-④：O10 协同——复活首扫以 board timeline 重派事件为活动锚，不误判双跑
    // 判别器设计：updated_at=90min 前（陈旧）、timeline 末位=2min 前重派 upsert 事件。
    // stall grace 缺省 30min：正确实现（锚=timeline 2min）未熟不开枪；若实现误用
    // updated_at（90min）→ matured 且 escaped（≥2×grace）必开枪 → 本断言即红。
    cleanAll();
    writeAnchor(SID);
    writeBoard([
      {
        id: "m-rev-d",
        title: "redispatched",
        status: "running",
        dispatch: { agent_id: "agent_rev_d", mode: "agent", session_id: SID },
        updated_at: absMin(90),
        timeline: [{ at: absMin(2), event: "upsert", summary: "busy 闸超龄豁免放行重派" }],
      },
    ]);
    const bgD91 = spawnSentinel({});
    await sleep(5000);
    ck.ok(
      "REV-④ O10 协同回归：复活首扫以 board timeline 重派事件为活动锚（2min 前 upsert）——已豁免重派在飞 mission 不误判失联/双跑（零 fired、存活）",
      bgD91.proc.exitCode === null && firedNamesM("m-rev-d--").length === 0,
      { alive: bgD91.proc.exitCode === null, fired: firedNamesM("m-rev-d--") },
    );
    bgD91.kill();
    await bgD91.done;

    // ---- REV-⑤：组包尾块缺席计数（无条件硬约束件）——pure 区抽取直测 + 接线静态锁
    {
      const srvSrc = fs.readFileSync(path.join(PLUGIN_DIR, "mcp", "server.mjs"), "utf8").replace(/\r\n/g, "\n");
      const beginMark = "/* BUILD-DISPATCH-PURE-BEGIN";
      const endMark = "/* BUILD-DISPATCH-PURE-END */";
      const i91 = srvSrc.indexOf(beginMark);
      const j91 = srvSrc.indexOf(endMark);
      let pure91 = null;
      if (i91 >= 0 && j91 > i91) {
        const dir91 = path.join(BASE.root, "m91-pure");
        fs.mkdirSync(dir91, { recursive: true });
        const file91 = path.join(dir91, "pure.mjs");
        fs.writeFileSync(file91, srvSrc.slice(i91, j91 + endMark.length) + "\nexport { buildDispatchPrompt };\n");
        pure91 = await import(pathToFileURL(file91).href + "?v=" + Date.now());
      }
      const mkPack91 = (mid) =>
        [
          `# 任务包：T（${mid}）`,
          "",
          "## CONTRACT（三行契约，也出现在派发 prompt 尾块）",
          `[channel] ${mid}`,
          "[worker] w",
          "[token] 0123456789abcdef0123456789abcdef",
          "",
          "## TASK",
          "- x",
        ].join("\n");
      const mkM91 = (id) => ({ id, pack: { path: `packs/${id}/pack.md` } });
      const built2 = pure91 ? pure91.buildDispatchPrompt(mkM91("mT"), mkPack91("mT"), "", "", null, { absent: 2 }) : null;
      const built0 = pure91 ? pure91.buildDispatchPrompt(mkM91("mT"), mkPack91("mT"), "", "", null) : null;
      const tail91 = built2 && built2.ok ? built2.text.slice(built2.text.indexOf("先 Read 任务包")) : "";
      ck.ok(
        "REV-⑤ 组包尾块缺席计数（无条件）：scoping.absent=2 → 恒在节『…：2 件』；缺省参 → 『…：0 件』；尾块形制保持（指针句→三行 CONTRACT 收尾，W4-PREFIX-02 形制不破）",
        Boolean(built2 && built2.ok && built0 && built0.ok) &&
          built2.text.includes("【哨兵 scoping】归因缺席在盯 mission：2 件") &&
          built0.text.includes("【哨兵 scoping】归因缺席在盯 mission：0 件") &&
          /^先 Read 任务包 [^\n]+\n\[channel\] mT\n\[worker\] w\n\[token\] [0-9a-f]{32}$/.test(tail91),
        { ok2: built2 && built2.ok, ok0: built0 && built0.ok, tail: tail91.slice(0, 80) },
      );
      ck.ok(
        "REV-⑤b 接线静态锁：dispatch 面 buildDispatchPrompt 调用携 absent=dispatchScopingAbsentCount(missionId)；触发面② ensureSentinelFamily() 在同步段在位",
        srvSrc.includes("dispatchScopingAbsentCount(missionId)") && srvSrc.includes("ensureSentinelFamily();") && srvSrc.includes("function dispatchScopingAbsentCount("),
        { wired: srvSrc.includes("dispatchScopingAbsentCount(missionId)"), face2: srvSrc.includes("ensureSentinelFamily();") },
      );
    }

    // ---- REV-⑥⑦：触发面② 端到端（server dispatch 探活补员）+ 尾块计数实装（stub CLI，零模型事务）
    {
      const stubDir91 = path.join(BASE.root, "m91-stub");
      const stubCli91 = path.join(stubDir91, "stub-cli.mjs");
      const rollout91 = path.join(stubDir91, "rollout");
      fs.mkdirSync(rollout91, { recursive: true });
      fs.writeFileSync(
        stubCli91,
        [
          'import fs from "node:fs";',
          'import path from "node:path";',
          'const dir = process.env.ORCH_ROLLOUT_DIR || ".";',
          'fs.mkdirSync(dir, { recursive: true });',
          'fs.writeFileSync(path.join(dir, "model-io-sess_m91-stub.jsonl"), JSON.stringify({ t: 1 }) + "\\n");',
          'console.log(JSON.stringify({ type: "result", sessionId: "sess_m91-stub", traceId: "tr", turnId: "tu", response: "stub-ok", usage: { inputTokens: 1 }, projection: { status: "idle", turnCount: 1 } }));',
        ].join("\n") + "\n",
      );
      cleanAll();
      writeAnchor(SID);
      // v1.2.3 W2（主控裁决授权，仅 env 适配零断言改动）：显式 fake provider 对隔离环境泄漏
      // （harness env 合并 process.env，宿主真配置无可用 dms）——段③「首 api-key 回落」删除后
      // 无 model= 的 e2e dispatch 落 selection_missing 拒绝不 spawn（DS-05 同语义，设计内）；
      // 本套件 REV-⑥⑦ 本意测探活补员/尾块计数非种子失败，补有效 dms 腿恢复 spawn 照旧。
      const seedFixDir91 = path.join(BASE.root, "m91-seed-fixture");
      fs.mkdirSync(seedFixDir91, { recursive: true });
      const seedFakePersonal91 = path.join(seedFixDir91, "provider_config.json");
      fs.writeFileSync(
        seedFakePersonal91,
        JSON.stringify(
          {
            schemaVersion: 1,
            config: {
              providerConfigRules: {
                templateRules: [],
                providerRules: [
                  { providerId: "p-m91", config: { access: { type: "api-key", apiKey: "sk-m91" }, modelOrder: ["M-M91"] } },
                ],
              },
              modelConfigRules: {
                providerModelRules: [
                  { modelId: "M-M91", config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["fast", "slow"] } } }, providerId: "p-m91" },
                ],
              },
              defaultModelSelection: { providerId: "p-m91", modelId: "M-M91", options: { reasoningLevel: "fast" } },
            },
          },
          null,
          2,
        ),
      );
      const seedFakeBuiltin91 = path.join(seedFixDir91, "zcode-builtin.json");
      fs.writeFileSync(seedFakeBuiltin91, JSON.stringify({ schemaVersion: 1, revision: 1, config: { providerConfigRules: { templateRules: [], providerRules: [] }, modelConfigRules: {} } }, null, 2));
      const s91 = startServer({
        root: ROOT,
        env: {
          ZCODE_CLI_PATH: stubCli91,
          ORCH_ROLLOUT_DIR: rollout91,
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: seedFakePersonal91,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: seedFakeBuiltin91,
        },
      });
      try {
        // 预置无归因在飞 mission（watchable：running+agent_id）→ 尾块缺席计数=1。
        // 直写 board（外部 upsert 新建 mission 状态门 drafted→running 拒绝，SM 状态机语义）；
        // server 每操作 loadBoard 读盘，后续 context_pack 落盘时本 mission 随存。
        writeBoard([
          {
            id: "m-absent-e2e",
            title: "absent-inflight",
            status: "running",
            dispatch: { agent_id: "agent_absent", mode: "agent" },
          },
        ]);
        await s91.call("context_pack", {
          mission_id: "m-e2e-m91",
          title: "M9-1 触发面② e2e",
          task: "探活补员端到端验证",
          scope_paths: ["src/"],
          worker_name: "orch-worker#1",
          persona_path: path.join(PLUGIN_DIR, "agents", "orch-worker.md"),
        });
        await s91.call("board", {
          action: "upsert",
          mission: { id: "m-e2e-m91", title: "M9-1 触发面② e2e", status: "drafted", agent_type: "agent-orchestrator:orch-worker" },
        });
        const dr91 = await s91.call("dispatch", { mission_id: "m-e2e-m91" });
        const dj91 = dr91.json || {};
        const slotIn = await waitFor(() => fs.existsSync(slotFile(0)), 12000);
        ck.ok(
          "REV-⑥ 触发面② 派发前探活补员（端到端）：dispatch 同步段家族全灭 → 拉起哨兵（instance 槽位出现）∧ 派发回执正常",
          slotIn && dj91.ok === true && dj91.mission_id === "m-e2e-m91",
          { slotIn, ok: dj91.ok, err: dj91.error, slots: [0, 1, 2].map((k) => Boolean(readJson(slotFile(k)))) },
        );
        const logDir91 = path.join(ROOT, "context", "dispatch-logs");
        let promptTxt91 = "";
        try {
          const prompts = fs.readdirSync(logDir91).filter((n) => n.endsWith(".prompt"));
          if (prompts.length) promptTxt91 = readText(path.join(logDir91, prompts[prompts.length - 1]));
        } catch {
          /* no logs */
        }
        ck.ok(
          "REV-⑦ 组包尾块计数实装（端到端）：prompt 落盘含恒在节『【哨兵 scoping】…：1 件』（预置无归因在飞 1 件；自 mission 有锚不计）",
          promptTxt91.includes("【哨兵 scoping】归因缺席在盯 mission：1 件"),
          { has: promptTxt91.includes("【哨兵 scoping】"), promptLen: promptTxt91.length },
        );
      } finally {
        try {
          s91.close();
        } catch {
          /* best effort */
        }
        // 收尸触发面②拉起的哨兵（读槽位 pid 击杀；家族缺省 3）
        for (let k = 0; k < 5; k++) {
          const doc = readJson(slotFile(k));
          if (doc && Number.isFinite(doc.pid)) {
            try {
              process.kill(doc.pid);
            } catch {
              /* already gone */
            }
          }
        }
        await sleep(500);
      }
    }

    // 卫生：SCP/REV 组后清场（不污染后续/收尾态）
    cleanAll();
    rmSilent(path.join(ROOT, "sentinel.cfg.json"));
    rmSilent(path.join(SENT_DIR, "coord-session.txt"));
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
