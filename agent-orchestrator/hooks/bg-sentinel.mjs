#!/usr/bin/env node
/**
 * agent-orchestrator bg-sentinel v2（直至型错峰冗余哨兵家族）。零依赖，Node >= 18。
 * 实现体拆分于 hooks/bg-sentinel/ 模块（2026-11-01 巨型文件拆分，纯搬运接线零行为
 * 变更）；本文件为薄入口：CLI 参数解析 + 主流程编排，外部引用（hooks.json、bg-gate
 * 提示、测试）按原路径 node bg-sentinel.mjs 拉起零改动兼容。
 *
 * 唯一启动方式：主控以宿主后台任务运行（平台事实：只有宿主后台任务退出才产生完成通知；
 * detached 进程退出无通知；单进程只有一次退出 = 只有一枪——多枪冗余只能靠多实例并存）：
 *   Bash(command="node <插件根>/hooks/bg-sentinel.mjs --once", run_in_background=true)
 * 同命令连发 N 次（默认 3）= 错峰哨兵家族；--once 接受并忽略（0.3.1 肌肉记忆兼容）。
 * 退出 = 完成通知：主控空闲时开新回合、忙时并入当前回合。
 *
 * V7-08/R4 版本偏斜注记：开发期拉起应显式用 repo 路径（或先核插件市场缓存版本与
 * repo 一致）——hooks 家族经宿主市场缓存加载，缓存滞后时旧实例按旧语义行为（历史
 * 「全清自毁」三连唤即 0.5.0 旧实例所为），此类行为不再以「过渡窗口预期」解释。
 *
 * v2 语义（直至型，60s 判定；v2.1 全清转待命不退出）：
 *   - 启动即认领最低空闲槽位 <存储根>/sentinel/instance-<k>.json（wx 原子创建）；
 *     全满且全部新鲜 → exit 0 让位并输出一行明示文案（V7-08/R2，家族拒绝超编——
 *     让位发生在板面读取之前，与在飞与否无关；平台把退出变通知，静默被误读为失明）。
 *   - 错峰：槽位 k 首个 tick 前 sleep k×stagger_sec；此后 poll 周期加 k×5% 抖动。
 *   - 心跳：每 tick 改写自己的槽位文件；接管判定 = pid 死或心跳龄 >90s（B3 沿用）。
 *   - 状态分级条件（每 mission 至多一条，C3 > C1 > C2）：
 *       C1-T done/failed 未签收    宽限 wake_grace_min(2)    refire 5  cap 3
 *       C1-A blocked/question 未签收 宽限 answer_grace_min(3)  refire 5  cap 3
 *       C2  在飞失联（timeline 龄期） 宽限 stall_grace_min(30)  refire 5  cap 3
 *       C3  崩溃实锤（rollout model-io 停更 ≥ crashGrace ∧ tool_usage 实锤无 running 行——
 *             fire-on-dead 双信号合取；佐证缺失/有行（长工具在跑）→ 本 tick 无 C3 落 C2 链）
 *                                   宽限 crash_grace_min(10)  绕过双空闲门  cap 3
 *       C0  board 连续 3 tick 不可读 立即 → V7-04：转观测隔离（聚合告警一条 + quarantined 值守，不退出）
 *   - 双空闲门（C1/C2）：子代理等待中 ∧ 主控信号停滞（tool_usage 主 / rollout 副 /
 *     journal 三 / board 四 / 全缺失按空闲）；逃逸口 = anchor 龄期 ≥ 2×宽限 无视门开枪
 *     ——门只可能推迟开枪，不可能取消开枪。
 *   - 开枪仲裁：共享 fired 日志 + wx 认领（refire_gap_min 内他人已开枪 → 跳过；
 *     cap_window_min 内满 wake_cap 枪 → 封顶；第 cap 枪条目 final:true = abandoned）。
 *   - 回声：本地 echo.jsonl + 平台邮箱信封（六字段 + 写前自校验 + tmp+rename 毒丸规避）
 *     + abandoned 时 OS toast 兜底（fire-and-forget）。
 *   - 全清待命（v2.1，替代旧"全清自毁"）：全清（无在飞非 workflow 且无未签收终态；
 *     含仅剩 workflow 在飞——workflow 由宿主完成通知，无需盯守）不退出。平台事实：
 *     任何后台退出都会变成完成通知（全清三实例三连唤 = 实测缺陷），故槽位写
 *     state=standby 转低频待命——tick 心跳仍按 poll 周期刷新（保 bg-gate/server 的
 *     90s 在岗新鲜度，补员提醒天然抑制），板面读评节流到 standby_poll_sec
 *     （默认 max(poll, 300s)）；板面出现新在飞/未签收 → 自动复活回 active 正常
 *     盯守与告警。待命期板不可读 → 静默续待命（不计数不告警）。常态全清 0 条通知。
 *   - 观测型隔离（V7-04 lite，替代 C0 旧"开枪退出"）：观测异常满 cap → 写
 *     sentinel/quarantine.json（wx 仲裁唯一首告者，含证据快照）+ 既有通道一条聚合
 *     告警 + 槽位转 state=quarantined 低频值守（心跳照旧；不退出、不杀进程、不写
 *     board、不删文件）。家族级告警抑制：标记新鲜期（cap_window 刻度）内
 *     firedEligible 首检 false——三实例并发恰一条告警，超窗自动恢复开枪能力。
 *     恢复：异常消失（板可读）→ unlink 标记回 active/standby；quarantined 与
 *     standby 互斥，复活/解除共享 mtime 门与 standby_poll 节流（同一低频门）。
 *   - watcher-signals 消费（v0.8 W6，§15 裁决：watcher 优先唤醒 + 哨兵降级兜底）：
 *     板面出现 C1 未签收终态条件时才读 <sentinel>/watcher-signals.jsonl（watcher/
 *     degrade.mjs 落盘，{at,cls,mission,reason} 逐行滚动 256 行）——最新有效信号
 *     cls=D2（瞬时重试中 = watcher 在岗）且新鲜（age < watcher_signal_ttl_min，默认
 *     10min）→ 本 tick C1 两族（unclaimed_terminal/unclaimed_answer）静默让位；
 *     cls ∈ {D1,D3,kicked}（watcher standby 终态）、信号缺失、过期、读失败一律按无
 *     信号 → 既有兜底告警不回归。stall 死寂检测（C2）与 crash（C3）系 watcher 事件
 *     中继盲区（无事件不可见），无条件保留、永不静默；纯同步读零阻塞，不改待命制/
 *     家族轮换（standby 判定仍纯由板面决定）。
 *   - 寿命 ≥ max_lifetime_min（默认 24h）→ 家族轮换单赢家选举（v2.1，替代旧
 *     "各自安静退出"三连唤）：认领 sentinel/family-teardown.json（wx 原子创建；
 *     陈旧/损坏标记可夺位；新鲜窗 = 读者自身 lifetimeMs）——赢家 exit 0 退出
 *     （每个寿命周期至多 1 条通知），输家见新鲜标记顺延自身寿命（重置计时）进入
 *     下一轮，家族逐轮递减直至消亡（长驻是预期）。
 *   - 归敛自动拉起（v1.1.1 W23 / A2）已于 v1.6 W-p 随 -p 通道退役：编排分支
 *     （glean-launch.mjs 模块+cfg 五键+主循环调用块）迁 parked/agent-orchestrator/
 *     （glean 编排=主会话级；哨兵本体/唤醒面零触保留）。恢复=parked README 指引。
 *
 * 信号红线：对 board.json / spool 绝对只读；自有落盘全部在 <存储根>/sentinel/ 与
 * 平台邮箱 unread/；db.sqlite 仅 node:sqlite 以只读打开且仅查 tool_usage（动态
 * import 特性探测，Node < 22.5 或打开失败自动降级——绝不因信号缺失而永不叫人）。
 * 纯本地零网络（powershell toast 为 abandoned 最后一级人工兜底，失败静默）。
 *
 * 配置优先级：CLI > <存储根>/sentinel.cfg.json（server 启动时写出，每 tick 重读 B6）
 *   > 0.3.1 桥接键 > 内建默认。桥接：refire_gap_min←wake_timeout_min、wake_cap←wake_retries。
 */
import fs from "node:fs";
import path from "node:path";
import {
  BOARD_BAD_TICKS_LIMIT,
  IN_FLIGHT_STATUSES,
  PRUNE_EVERY_MS,
  boolArg,
  locateRoot,
  numArg,
  numArgBridge,
  parseArg,
  readBoardSafe,
} from "./bg-sentinel/core.mjs";
import {
  WATCHER_COVERED_CATEGORIES,
  WATCHER_SIGNAL_TTL_DEFAULT_MIN,
  signalsOf,
  watcherCoverage,
} from "./bg-sentinel/signals.mjs";
import {
  Q_CLAIM,
  buildQuarantineAlert,
  claimQuarantine,
  claimSlot,
  claimTeardown,
  pruneStaleSlots,
  quarantineFile,
  readQuarantine,
  releaseSlot,
  slotFresh,
  touchSlot,
} from "./bg-sentinel/family.mjs";
import { claimShots, firedEligible, pruneFired } from "./bg-sentinel/fired.mjs";
import {
  appendEcho,
  buildEnvelope,
  mailboxEcho,
  pruneEcho,
  toastAbandon,
  validateEnvelope,
} from "./bg-sentinel/echo.mjs";
import { spawnWakeKick, wakeQueueScan } from "./bg-sentinel/wake-kick.mjs";
import {
  buildSummary,
  classify,
  escaped,
  gateOpen,
  matured,
} from "./bg-sentinel/classify.mjs";
// v1.6 W-p 剥离：./bg-sentinel/glean-launch.mjs 编排模块随 -p 通道迁 parked/agent-orchestrator/
// （maybeLaunchGlean/maybeSuperviseGlean/resolveGleanProjectDir/GLEAN_LAUNCH_* 常量随迁；
// 恢复指引=parked README）。

function main() {
  const argv = process.argv.slice(2);
  const projectDir = process.env.ZCODE_PROJECT_DIR || process.cwd();
  const rootRaw = parseArg(argv, "--root");
  const root =
    rootRaw && !String(rootRaw).startsWith("${") ? path.resolve(String(rootRaw)) : locateRoot(projectDir);
  fs.mkdirSync(root, { recursive: true });

  const cfgPath = path.join(root, "sentinel.cfg.json");
  const legacyLockPath = path.join(root, "sentinel.lock");
  const sentDir = path.join(root, "sentinel");
  const startedAt = Date.now();

  // 隐藏测试缝：信封自校验负例（content 置非字符串）→ 必须拒绝外写。退出码 0。
  if (parseArg(argv, "--self-test-envelope") !== undefined) {
    const bad = { ...buildEnvelope([], "x", "sess_x", 0), content: null };
    const okRejected = !validateEnvelope(JSON.parse(JSON.stringify(bad)));
    const good = buildEnvelope([], "hello", "sess_x", 0);
    const okAccepted = validateEnvelope(JSON.parse(JSON.stringify(good)));
    process.stdout.write(
      JSON.stringify({ bad_rejected: okRejected, good_accepted: okAccepted }) + "\n",
    );
    process.exit(okRejected && okAccepted ? 0 : 1);
  }

  // B6: cfg is re-read every tick (CLI args still win over the file).
  const readCfg = () => {
    try {
      return JSON.parse(fs.readFileSync(cfgPath, "utf8")) || {};
    } catch {
      return {};
    }
  };

  const resolveCfg = () => {
    const c = readCfg();
    const pollMs = numArg(argv, "--poll-sec", c, "wake_poll_sec", 60, 1, 3600) * 1000;
    return {
      raw: c,
      pollMs,
      // v2.1 待命制：全清后板面低频复核周期（默认 ≥300s；心跳不受影响仍按 poll 刷新）
      standbyPollMs:
        numArg(argv, "--standby-poll-sec", c, "standby_poll_sec", Math.max(pollMs / 1000, 300), 1, 3600) * 1000,
      lifetimeMs:
        numArg(argv, "--max-lifetime-min", c, "max_lifetime_min", 1440, 0.01, 43200) * 60000,
      wakeGraceMs: numArgBridge(argv, "--wake-grace-min", c, "wake_grace_min", null, 2, 0.01, 1440) * 60000,
      answerGraceMs: numArgBridge(argv, "--answer-grace-min", c, "answer_grace_min", null, 3, 0.01, 1440) * 60000,
      stallGraceMs: numArgBridge(argv, "--stall-grace-min", c, "stall_grace_min", null, 30, 0.01, 1440) * 60000,
      crashGraceMs: numArgBridge(argv, "--crash-grace-min", c, "crash_grace_min", null, 10, 0.01, 1440) * 60000,
      watcherSignalTtlMs: numArg(argv, "--watcher-signal-ttl-min", c, "watcher_signal_ttl_min", WATCHER_SIGNAL_TTL_DEFAULT_MIN, 0.01, 1440) * 60000, // W6 信号新鲜刻度
      coordIdleMs: numArgBridge(argv, "--coord-idle-min", c, "coord_idle_min", null, 3, 0.01, 1440) * 60000,
      refireGapMs: numArgBridge(argv, "--refire-gap-min", c, "refire_gap_min", "wake_timeout_min", 5, 0.01, 1440) * 60000,
      cap: Math.round(numArgBridge(argv, "--wake-cap", c, "wake_cap", "wake_retries", 3, 1, 100)),
      capWindowMs: numArgBridge(argv, "--cap-window-min", c, "cap_window_min", null, 120, 1, 10080) * 60000,
      familySize: Math.round(numArgBridge(argv, "--family-size", c, "family_size", null, 3, 1, 5)),
      staggerSec: numArgBridge(argv, "--stagger-sec", c, "stagger_sec", null, 20, 0, 600),
      // v1.1.1 W-B 哨兵 drain：队列滞留阈值（grill#wake Q5 裁定 120s=2 tick；测试加速可覆盖）
      wakeQueueStaleMs: numArg(argv, "--wake-queue-stale-sec", c, "wake_queue_stale_sec", 120, 1, 3600) * 1000,
      // v1.6 W-p 剥离：glean_launch_* 五 cfg 键（enabled/cooldown/short-cooldown/grace/timeout）
      // 随编排分支迁 parked——键退役，历史 cfg 值残留无害（无消费面）。
    };
  };

  const finish = (code, summaryOut) => {
    releaseSlot(sentDir, slot);
    if (summaryOut) process.stdout.write(summaryOut + "\n");
    process.exit(code);
  };

  // --- 家族槽位认领：失败（全满且全部新鲜）→ exit 0 让位（V7-08/R2：明示一行） ---
  fs.mkdirSync(sentDir, { recursive: true });
  const first = resolveCfg();
  const staleDocs = pruneStaleSlots(sentDir, first.familySize);
  const claimed = claimSlot(sentDir, first.familySize, startedAt, staleDocs, root);
  const slot = claimed.slot;
  if (slot < 0) {
    // V7-08/R2 让位明示一行：让位退出发生在任何板面读取之前，与 mission 是否在飞
    // 完全无关；平台把任何后台退出都变成完成通知，静默 exit 0 被误读为「失明/故障」
    // （乙机制历史感知来源）。通知不可免，语义自解释——一行文案根除误读。
    let freshN = 0;
    for (let k = 0; k < first.familySize; k++) {
      const f = path.join(sentDir, `instance-${k}.json`);
      let doc = null;
      let mtimeMs = NaN;
      try {
        doc = JSON.parse(fs.readFileSync(f, "utf8"));
        mtimeMs = fs.statSync(f).mtimeMs;
      } catch {
        continue;
      }
      if (slotFresh(doc, mtimeMs)) freshN += 1;
    }
    process.stdout.write(
      `[orch-sentinel] 家族已在岗（fresh ${freshN}/${first.familySize}，standby 亦在岗），本次启动让位退出；新派发由在岗实例自动接管。\n`,
    );
    process.exit(0);
  }
  let tookOverClaim = claimed.tookOver;
  let tookOverPrevClaim = claimed.prev;

  let boardFailTicks = 0;
  let boardFailSince = 0;
  let lastPruneAt = 0;
  let firstTick = true;
  let tickTimer = null;
  let tookOver = tookOverClaim; // 接管痕迹：touch 时保留（V2 可观测性）
  let tookOverPrev = tookOverPrevClaim;
  let standby = false; // v2.1 待命制：全清不退出 → true 转低频待命
  let quarantined = false; // V7-04 lite：观测异常隔离值守（与 standby 互斥，低频门共享）
  const stateLabel = () => (quarantined ? "quarantined" : standby ? "standby" : "active"); // 三态标签（V7-04）
  let lifetimeAnchor = startedAt; // 寿命 cap 锚：轮换输家顺延时重置
  let lastEvalAt = 0; // 最近一次全量板面评估时刻（待命节流用）
  let lastEvalBoardMtime = -1; // V7-08/R1：最近一次全量评估时的 board.json mtime（standby mtime 门基准）
  let catchupDone = false; // v1.2 M9-1 REV③：复活补告警每实例生命周期至多一次

  const tick = () => {
    const cfg = resolveCfg(); // B6
    const signals = signalsOf(cfg.raw);
    const prevLabel = stateLabel(); // V7-04：状态迁移检测以三态标签计

    touchSlot(sentDir, slot, startedAt, tookOver, tookOverPrev, stateLabel(), root);

    if (Date.now() - lifetimeAnchor >= cfg.lifetimeMs) {
      // 寿命 cap（v2.1 家族轮换）：单赢家选举——赢家唯一退出（退出即通知，每寿命
      // 周期至多一枪）；输家见新鲜标记顺延自身寿命进入下一轮（长驻是预期）。
      if (claimTeardown(root, slot, cfg.lifetimeMs)) {
        finish(0, "[orch-sentinel] 家族轮换：本实例寿命到期退出（本轮唯一赢家），其余实例自动顺延；可选补员（后台重发 3 次哨兵命令）。");
        return;
      }
      lifetimeAnchor = Date.now(); // 输家：重置计时进入下一轮
    }

    // prune：首 tick 或每 30 分钟（fired/echo 24h + legacy 锁一次性清理）
    if (firstTick || Date.now() - lastPruneAt >= PRUNE_EVERY_MS) {
      pruneFired(root);
      pruneEcho(root);
      try {
        fs.unlinkSync(legacyLockPath); // 0.3.1 单锁遗产：只删不写
      } catch {
        /* ENOENT */
      }
      lastPruneAt = Date.now();
      firstTick = false;
    }

    // v1.1.1 W-B 哨兵 drain：wake-queue 滞留件（mtime ≥ wake_queue_stale_sec，默认
    // 120s=2 tick）视为 kick 失败遗留 → 补一脚 kick（注入判定面全在 kick 内）。
    // 置于板面逻辑之前：待命/隔离/板不可读期 drain 照跑（队列=未唤备忘，不因板面
    // 状态失能）；门口：队列空/认领持有中 → 静默（零日志零副作用）。
    {
      const wq = wakeQueueScan(root, cfg.wakeQueueStaleMs, Date.now());
      if (wq.total > 0 && wq.stranded > 0 && !wq.claimHeld) {
        spawnWakeKick(root, projectDir, cfg.wakeQueueStaleMs);
      }
    }

    // v1.6 W-p 剥离：归敛自动拉起编排分支（maybeSuperviseGlean 监视+maybeLaunchGlean
    // 拉起调用块）随 -p 通道迁 parked——哨兵主循环其余职能零触保留
    //（镜像/收工清点/唤醒失败检测/wake-queue+kick/watcher-signals 消费面照旧）。

    // v2.1 待命节流（V7-04 起隔离值守同门共享）：active 每 tick 全量评估；
    // standby/quarantined 每 standby_poll_sec 才读板（心跳 touch 不节流，保 90s
    // 在岗新鲜度）。板面出现新在飞/未签收即自动复活。
    // V7-08/R1 standby mtime 门：节流前置一次 board.json mtime 探测（每 poll 周期
    // 1 次 syscall）——server 原子写=改名，mtime 严格递增；mtime 晚于上次全量评估
    // 基准 → 跳过节流立即评估。复活延迟 standby_poll(≤300s) → ≤poll(60s)；mtime
    // 未变维持节流（不退化为全量轮询，防评估放大）。基线 NaN（上次评估时板缺失）
    // + 有限新值 = 板（重）现，必为有新活——V7-04 隔离解除判定同门依赖此分支。
    let boardMtimeProbe = NaN;
    try {
      boardMtimeProbe = fs.statSync(path.join(root, "board.json")).mtimeMs;
    } catch {
      /* 板缺失 → 无可证明的新活，维持节流判定（待命期板不可读分支照旧兜底） */
    }
    const boardTouched =
      Number.isFinite(boardMtimeProbe) &&
      (!Number.isFinite(lastEvalBoardMtime) || boardMtimeProbe > lastEvalBoardMtime);
    if ((standby || quarantined) && !boardTouched && Date.now() - lastEvalAt < cfg.standbyPollMs) {
      tickTimer = setTimeout(tick, cfg.pollMs * (1 + slot * 0.05));
      return;
    }
    lastEvalAt = Date.now();
    lastEvalBoardMtime = boardMtimeProbe; // mtime 门基准随每次全量评估推进

    let boardMtime = NaN;
    try {
      boardMtime = fs.statSync(path.join(root, "board.json")).mtimeMs;
    } catch {
      /* missing board counts as unreadable below */
    }
    const board = readBoardSafe(root);
    if (board === null) {
      if (standby || quarantined) {
        // 待命/隔离期板不可读：无法证明有新活，静默续当前态（不计数不告警——
        // 全清期 0 通知；隔离 episode 的聚合告警已由首告者发出，解除走下方可读分支）
        tickTimer = setTimeout(tick, cfg.pollMs * (1 + slot * 0.05));
        return;
      }
      if (boardFailTicks === 0) boardFailSince = Date.now(); // C0 anchor
      boardFailTicks += 1; // B2
      if (boardFailTicks >= BOARD_BAD_TICKS_LIMIT) {
        // V7-04 lite 观测型隔离：满 cap 不再开枪退出——写 quarantine.json（wx 仲裁
        // 唯一首告者，含证据快照）+ 既有通道一条聚合告警 + 转 quarantined 低频值守
        // （心跳照旧；不杀进程不写 board 不删文件）。家族级抑制：新鲜标记期内其余
        // 实例与新条件由 firedEligible 首检 false 静默挡下（三实例并发恰一条告警）。
        const qReason = `board.json unreadable for ${BOARD_BAD_TICKS_LIMIT} consecutive polls (missing/corrupted)`;
        const qEvidence = { ticks: boardFailTicks, since: new Date(boardFailSince).toISOString() };
        const qFirst = claimQuarantine(root, slot, qReason, qEvidence, cfg.capWindowMs);
        quarantined = true;
        boardFailTicks = 0; // 隔离看护不再重复计数（重隔离 = 新 episode 才再告警）
        if (stateLabel() !== prevLabel) touchSlot(sentDir, slot, startedAt, tookOver, tookOverPrev, stateLabel(), root);
        if (qFirst) {
          const qSummary = buildQuarantineAlert(qReason);
          mailboxEcho(root, [Q_CLAIM], qSummary, cfg.raw, slot);
          appendEcho(root, [Q_CLAIM], qSummary, {});
        }
      }
      tickTimer = setTimeout(tick, cfg.pollMs * (1 + slot * 0.05)); // 无正据不决策，但只容忍有限次数
      return;
    }
    boardFailTicks = 0;

    // V7-04 自愈：隔离实例读到板 = 异常形态消失 → 清标记回正常态（active/standby
    // 由下方常规流程按板面内容定）。读板成功同时顺手清理已超窗的陈旧标记（无抑制
    // 力，仅文件卫生——新鲜标记保留，其抑制窗口未过）。
    if (quarantined) {
      quarantined = false;
      try {
        fs.unlinkSync(quarantineFile(root));
      } catch {
        /* ENOENT best effort */
      }
    } else {
      const qSeen = readQuarantine(root);
      if (qSeen && Date.now() - qSeen.atMs >= cfg.capWindowMs) {
        try {
          fs.unlinkSync(quarantineFile(root));
        } catch {
          /* ENOENT best effort */
        }
      }
    }

    const conds = classify(board, boardMtime, cfg, root, signals);
    const missions = Array.isArray(board.missions) ? board.missions : [];
    const isWorkflow = (m) => (m.dispatch && m.dispatch.mode) === "workflow";
    const inFlightAll = missions.filter((m) => m && IN_FLIGHT_STATUSES.includes(m.status));
    const inFlightNW = inFlightAll.filter((m) => !isWorkflow(m));

    if (!conds.length && !inFlightNW.length) {
      // v2.1 待命制：全清不退出（含仅剩 workflow 在飞——workflow 由宿主完成通知，
      // 无需盯守）。平台事实：任何后台退出都变成完成通知 = 唤醒主控（旧版全清
      // 三实例三连唤属缺陷）；故槽位标 state=standby 转低频待命，板面出现新在飞/
      // 未签收 → 下一轮评估自动复活回 active 正常值守。
      standby = true;
      boardFailTicks = 0;
      if (stateLabel() !== prevLabel) touchSlot(sentDir, slot, startedAt, tookOver, tookOverPrev, stateLabel(), root);
      tickTimer = setTimeout(tick, cfg.pollMs * (1 + slot * 0.05));
      return;
    }
    standby = false; // 有活干（在飞或未签收）→ 恢复 active 值守
    if (stateLabel() !== prevLabel) touchSlot(sentDir, slot, startedAt, tookOver, tookOverPrev, stateLabel(), root);

    // v1.2 M9-1 REV③ 补告警（宽限阈值复核结论：HEARTBEAT_STALE_MS 90s=槽位判死/在岗
    // 判定刻度 ≠ wake 升级阈值 wake/answer/stall/crash_grace——两族常量无 conflation）：
    // 复活/自补员后的首扫，对本实例启动前已到期升级（anchorMs < startedAt 且已 matured）
    // 的条件集中补告警一次，缝合团灭期的告警断档。仅回声留痕——不额外开枪不退出，
    // 正常开枪路径按自身 eligibility/refire/cap 独立进行；每实例生命周期至多一次。
    // O10 协同：条件锚一律取自 board timeline（重派 upsert 事件即最新活动锚），首扫
    // 以板面为据，已豁免重派 mission 不会因复活丢内存态而误判双跑。
    if (!catchupDone) {
      const missed = conds.filter((c) => matured(c) && c.anchorMs < startedAt);
      if (missed.length) {
        catchupDone = true;
        const heads = missed
          .slice(0, 5)
          .map((c) => `${c.key} ${c.category}`)
          .join("、");
        appendEcho(
          root,
          [{ key: "__catchup__", category: "catchup", final: false }],
          `catch-up alerts: ${missed.length} escalations fell due while the sentinel was absent (${heads}${missed.length > 5 ? " etc." : ""}) - sent in one batch on the first scan after revival`,
          {},
        );
      }
    }

    // W6 watcher-signals 消费：watcher 在岗覆盖中的 C1 类别本 tick 静默让位（不重复
    // 开枪）；信号缺失/过期/终态/读失败 → covered=false 走既有兜底（WAKE-02 不回归）。
    // 仅板面出现 C1 条件时才读信号文件（stall/crash 板零额外 IO，且二者永不静默）；
    // standby/家族轮换/仲裁面判定不受影响。
    const needWatcherGate = conds.some((c) => WATCHER_COVERED_CATEGORIES.has(c.category));
    const watcher = needWatcherGate
      ? watcherCoverage(root, Date.now(), cfg.watcherSignalTtlMs)
      : { covered: false, why: "not-needed" };
    const due = conds.filter(
      (c) =>
        (!WATCHER_COVERED_CATEGORIES.has(c.category) || !watcher.covered) && // W6：覆盖中的 C1 静默（stall/crash 永不静默）
        matured(c) && (gateOpen(root, c, signals, boardMtime, cfg) || escaped(c)) && firedEligible(root, c, cfg),
    );
    if (due.length) {
      const claims = claimShots(root, due, cfg, slot);
      if (claims.length) {
        const summary = buildSummary(claims, cfg);
        const finalShot = claims.some((c) => c.final);
        let toastAttempted = false;
        if (finalShot) toastAttempted = toastAbandon(cfg.raw); // 仅 abandoned：OS toast 人工兜底
        mailboxEcho(root, claims, summary, cfg.raw, slot); // 第二通道（毒丸规避）
        appendEcho(root, claims, summary, { toast_attempted: toastAttempted }); // 本地回声（含 toast 记录）
        finish(1, summary); // 开枪 = 退出 = 通知；本实例一条命
        return;
      }
    }

    tickTimer = setTimeout(tick, cfg.pollMs * (1 + slot * 0.05));
  };

  // 错峰：槽位 k 首个 tick 前 sleep k×stagger_sec（认领已在上方完成，可测、可让位）
  const initialDelay = slot * first.staggerSec * 1000;
  if (initialDelay > 0) {
    tickTimer = setTimeout(tick, initialDelay);
  } else {
    tick();
  }
}

try {
  main();
} catch {
  process.exit(0);
}
