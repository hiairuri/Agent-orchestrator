#!/usr/bin/env node
/**
 * agent-orchestrator wake-kick（完成即唤执行器 · v1.1.1 WB 波消费逻辑落地）。
 *
 * 调用形（WA 波固定；spawn 方=server toolReport done 分支 / dispatch-runner finish /
 * bg-sentinel 滞留 drain 三触发点；生产者认领 claim.json 后 detached spawn）：
 *   in : --root <存储根>
 *
 * 行为（grill#wake 七答全 A + v1.1.1-wake-PLAN-draft §3.2/§4 裁定）：
 *   1) drain <root>/context/wake-queue/ 逐事件单文件；坏 JSON=毒丸 → 移入
 *      quarantine/ 子目录（<名>.bad，哨兵 quarantine 先例同型）+ stderr 一行，
 *      不阻前后事件；
 *   2) 认领串行化：wx 认领 claim.json（source=kick，本进程整个运行期持有）——
 *      他者持有中（kick 在跑=立即让位；生产者毫秒窗=短重试；陈旧/损坏残留=
 *      超龄回收后重认领，WB-SRV-e 残留识别语义的消费面）→ 静默退出；
 *   3) 锚活性前置校验（消费前置双闸）：读 sentinel/coord-session.txt → 形状闸
 *      （sess_ 前缀且非 sess_subagent）→ 活性闸（rollout model-io-<sid>.jsonl 存在
 *      且 mtime 距今 ≤10min，grill#wake Q5）——双闸不过=不注入、事件留队 +
 *      refire gap 告警（同会话同因 10 分钟内只告警一次，沿 bg-sentinel fired 式
 *      先例；标记落 sentinel/wake-kick-alerts/），绝不 b2 自愈；
 *   4) 合并注入：≤12 mission 一次注入（最新事件为签名 mission，其余以计数行
 *      「另有 N 项待处理，详見板」附注）；>12 取最新 12+计数行，余下留队
 *      （哨兵滞留 drain 兜底）；
 *   5) 注入调用=W2 import 直调（watcher.mjs 导出面 createWatcher().runTransaction，
 *      --verdict-window-sec 1 裁剪复活观察窗；锚活性已前置校验故 revivedProbe 不注入，
 *      「注入即成功」口径）。b2 自愈禁用=锚劫持防线（硬要求）：scope 不改 watcher 面，
 *      实现取包内第二口径——注入前后显式校验 coord-session.txt 字节未被改，被改
 *      （=watcher 注入链内 b2 刷新锚发生）即原子还原快照+按失败处置（事件留队+
 *      anchor-rewritten 告警）：kick 路径净效果「锚零改写、绝不认新会话」；
 *      同款快照还原 watcher-signals.jsonl（kick 瞬时 D1/D2 信号不落共享面——防哨兵
 *      W6 消费面把 kick 重试误读为「watcher 在岗」而永久静默 C1 兜底告警，
 *      W-E 验收腿 2「哨兵 C1 回落既有行为不破坏」的前提）；
 *   6) 成功（success/accepted-not-revived/noop-busy）：移除已 drain 事件文件后
 *      重扫队列（补捞事务期间新落事件，闭生产者「写事件-认领-释放」竞态窗，
 *      至多 3 轮）；失败：留队（哨兵兜底）；
 *   7) 自杀护栏：120s 到点强制退出（CLI 形 armed；事件留队，claim 残留带
 *      acquired_at 可识别、超龄可回收）。
 *
 * 依赖注记：本文件是 hooks 家族中唯一 import 插件内模块者（../watcher/* 组合面）——
 * hooks 零依赖纪律的意图是「生命周期钩子经宿主缓存加载须单文件自足」；本执行器由
 * 生产者以插件内绝对路径显式 spawn（kickPath=<插件根>/hooks/wake-kick.mjs），相对
 * import 恒在插件树内解析，纪律意图不破。谓词仍不跨文件共享（isSubagentSessionId
 * 从 inject.mjs import 属 watcher 侧模块内共享，非 hooks twin 面）。
 *
 * 零 npm 依赖；node >= 20。
 */
import fs from "node:fs";
import path from "node:path";

import { createWatcher, resolveRoot, resolveRolloutDir } from "../watcher/watcher.mjs";
import { isSubagentSessionId } from "../watcher/inject.mjs";
import { readBoardSafe, RESULT_STATUSES } from "../watcher/poller.mjs";

/* --- 施工参数（grill#wake Q5 裁定值；模块导出仅供断言消费） --- */
export const WAKE_ANCHOR_FRESH_MS = 10 * 60 * 1000; // 锚活性闸：rollout mtime 距今 ≤10min
export const WAKE_CLAIM_STALE_MS = 120 * 1000;      // 认领残留超龄回收刻度（=哨兵滞留阈值 2 tick）
export const WAKE_KICK_TIMEOUT_MS = 120 * 1000;     // 自杀护栏（CLI 形）
export const WAKE_BATCH_MAX = 12;                   // 单次注入合并 mission 上限
export const WAKE_ALERT_GAP_MS = 10 * 60 * 1000;    // 告警 refire gap（同会话同因；fired 式先例）
export const WAKE_DELIVERED = new Set(["success", "accepted-not-revived", "noop"]); // 「注入即成功」口径（busy=主控在跑）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function argOf(argv, flag, def = "") {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1] ?? def;
    if (argv[i].startsWith(flag + "=")) return argv[i].slice(flag.length + 1);
  }
  return def;
}

/** watcher.cfg.json 读取（watcher.mjs loadCfg 的本地 twin，5 行形；cfg 不导出故照抄）。 */
function loadCfgTwin(rootDir, fsImpl = fs) {
  try {
    const c = JSON.parse(fsImpl.readFileSync(path.join(rootDir, "watcher.cfg.json"), "utf8"));
    return c && typeof c === "object" ? c : {};
  } catch {
    return {};
  }
}

/** 原子写（tmp+rename；inject.mjs atomicWriteFile 同型）。 */
function atomicWrite(file, data, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fsImpl.writeFileSync(tmp, data);
  fsImpl.renameSync(tmp, file);
}

function bufSame(a, b) {
  if (a === null || b === null) return a === b; // 缺失 vs 缺失
  if (!a || !b || a.length !== b.length) return false;
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/* --- 队列扫描与毒丸隔离 --- */

function queueDirOf(rootDir) {
  return path.join(rootDir, "context", "wake-queue");
}

/**
 * 扫描队列：返回 {events:[{name, ev}], poison:[name]}。事件按文件名字典序
 * （<startedMs>-<mission_id>.json 的 ms 前缀保证时序）。坏 JSON/缺 mission_id=毒丸。
 */
export function scanQueue(rootDir, fsImpl = fs) {
  const dir = queueDirOf(rootDir);
  let names = [];
  try {
    names = fsImpl.readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "claim.json").sort();
  } catch {
    return { events: [], poison: [] }; // 队列目录缺失=空
  }
  const events = [];
  const poison = [];
  for (const name of names) {
    let ev = null;
    try {
      ev = JSON.parse(fsImpl.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      ev = null;
    }
    if (ev && typeof ev === "object" && typeof ev.mission_id === "string" && ev.mission_id.trim()) {
      events.push({ name, ev });
    } else {
      poison.push(name);
    }
  }
  return { events, poison };
}

/** 毒丸隔离：移入 quarantine/<名>.bad（跳过语义+卫生：不再被每轮 kick 重解析）。 */
function quarantinePoison(rootDir, names, fsImpl = fs, err = (l) => process.stderr.write(l + "\n")) {
  const dir = queueDirOf(rootDir);
  for (const name of names) {
    try {
      fsImpl.mkdirSync(path.join(dir, "quarantine"), { recursive: true });
      fsImpl.renameSync(path.join(dir, name), path.join(dir, "quarantine", `${name}.bad`));
      err(`[wake-kick] 毒丸跳过：wake-queue/${name} 非 JSON/缺 mission_id，已移入 quarantine/（不阻前后事件）`);
    } catch {
      err(`[wake-kick] 毒丸隔离失败：wake-queue/${name}（留队原处，下一轮再试）`);
    }
  }
}

/* --- 认领串行化 --- */

/**
 * wx 认领 claim.json（kick 整个运行期持有）。返回 {held:true}=他者持有中（静默退出）；
 * {held:false, release()}=认领成功。他者判定：
 *   - source=kick 且新鲜 → kick 在跑，立即让位（不重试——它持有到运行结束）；
 *   - 生产者（server/runner）新鲜 claim → spawn 毫秒窗，短重试等其释放；
 *   - 陈旧（age ≥ WAKE_CLAIM_STALE_MS）或损坏残留 → 超龄回收（unlink 后重认领，
 *     WB-SRV-e「残留可识别」的消费面；损坏无法定龄按残留回收——生产者持有窗仅毫秒，
 *     永久滞留比罕见双 kick 更伤，双 kick 由事件 unlink 幂等+认领重查兜底）。
 */
export async function acquireClaim(rootDir, {
  fsImpl = fs, now = Date.now, sleepFn = sleep,
  claimStaleMs = WAKE_CLAIM_STALE_MS, retries = 10, retryDelayMs = 200,
} = {}) {
  const claimPath = path.join(queueDirOf(rootDir), "claim.json");
  for (let i = 0; ; i++) {
    let existing;
    try {
      existing = JSON.parse(fsImpl.readFileSync(claimPath, "utf8"));
    } catch {
      existing = undefined; // 缺失或损坏
    }
    if (existing && typeof existing === "object") {
      const at = Date.parse(String(existing.acquired_at ?? ""));
      const fresh = Number.isFinite(at) && now() - at < claimStaleMs;
      if (fresh && existing.source === "kick") return { held: true }; // kick 在跑：立即让位
      if (fresh && i < retries) { // 生产者 spawn 毫秒窗：短重试
        await sleepFn(retryDelayMs);
        continue;
      }
      if (!fresh || i >= retries) {
        // 陈旧/损坏残留（或新鲜生产者窗重试耗尽=疑似 crash 残留）：超龄回收
        try { fsImpl.unlinkSync(claimPath); } catch { /* gone：下方 wx 竞争 */ }
      }
    }
    try {
      fsImpl.mkdirSync(path.dirname(claimPath), { recursive: true });
      const mine = { acquired_at: new Date(now()).toISOString(), source: "kick" };
      fsImpl.writeFileSync(claimPath, JSON.stringify(mine, null, 2) + "\n", { flag: "wx" });
      return {
        held: false,
        release: () => {
          try {
            const cur = JSON.parse(fsImpl.readFileSync(claimPath, "utf8"));
            if (cur && cur.source === "kick") fsImpl.unlinkSync(claimPath); // 仅释自己的认领
          } catch {
            /* 已被回收/已缺失 */
          }
        },
      };
    } catch {
      /* EEXIST：他人抢先 → 重查 */
    }
    if (i >= retries) return { held: true };
    await sleepFn(retryDelayMs);
  }
}

/* --- 锚活性前置校验（双闸） --- */

/**
 * 形状闸（sess_ 前缀且非 sess_subagent）+ 活性闸（rollout model-io-<sid>.jsonl 存在
 * 且 mtime 距今 ≤ anchorFreshMs）。返回 {ok, sid, reason}；reason ∈
 * anchor-missing（锚缺失）| anchor-shape（形状不过/子代理劫持形态）|
 * anchor-rollout-missing（rollout 无此会话文件=死锚主形）| anchor-stale（>10min 无写）。
 */
export function anchorGate(rootDir, {
  argv = [], fsImpl = fs, now = Date.now, anchorFreshMs = WAKE_ANCHOR_FRESH_MS, homedir = undefined,
} = {}) {
  let sid = null;
  try {
    sid = fsImpl.readFileSync(path.join(rootDir, "sentinel", "coord-session.txt"), "utf8").trim() || null;
  } catch {
    sid = null;
  }
  if (!sid) return { ok: false, sid: null, reason: "anchor-missing" };
  if (!sid.startsWith("sess_") || isSubagentSessionId(sid)) return { ok: false, sid, reason: "anchor-shape" };
  const rolloutDir = resolveRolloutDir(argv, loadCfgTwin(rootDir, fsImpl), homedir ? { homedir } : {});
  try {
    const st = fsImpl.statSync(path.join(rolloutDir, `model-io-${sid}.jsonl`));
    if (now() - st.mtimeMs <= anchorFreshMs) return { ok: true, sid, reason: null };
    return { ok: false, sid, reason: "anchor-stale" };
  } catch {
    return { ok: false, sid, reason: "anchor-rollout-missing" };
  }
}

/* --- refire gap 告警（fired 式先例） --- */

function alertDirOf(rootDir) {
  return path.join(rootDir, "sentinel", "wake-kick-alerts");
}

function alertKeyOf(sid, cause) {
  const s = String(sid ?? "none").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) || "none";
  return `${cause}--${s}`;
}

/**
 * 同会话同因 10 分钟内只告警一次：标记 wx 落 sentinel/wake-kick-alerts/
 * alert--<cause>--<sid>--<ts>.json；gap 内已告警 → 抑制（stderr 一行简注，不重写标记）。
 * 返回 {alerted:boolean}。
 */
export function emitKickAlert(rootDir, {
  sid, cause, detail, fsImpl = fs, now = Date.now, gapMs = WAKE_ALERT_GAP_MS,
  err = (l) => process.stderr.write(l + "\n"),
} = {}) {
  const dir = alertDirOf(rootDir);
  const key = alertKeyOf(sid, cause);
  const prefix = `alert--${key}--`;
  let latest = 0;
  try {
    for (const n of fsImpl.readdirSync(dir)) {
      if (!n.startsWith(prefix) || !n.endsWith(".json")) continue;
      const at = Date.parse(String((JSON.parse(fsImpl.readFileSync(path.join(dir, n), "utf8")).at) ?? ""));
      if (Number.isFinite(at) && at > latest) latest = at;
    }
  } catch {
    /* 目录缺失=无历史 */
  }
  if (latest && now() - latest < gapMs) {
    err(`[wake-kick] 告警抑制（refire gap 内已告警，${Math.ceil((gapMs - (now() - latest)) / 60000)}min 后恢复）：${detail}`);
    return { alerted: false };
  }
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.writeFileSync(
      path.join(dir, `${prefix}${now()}.json`),
      JSON.stringify({ at: new Date(now()).toISOString(), sid: sid ?? null, cause, detail: String(detail).slice(0, 300) }) + "\n",
      { flag: "wx" },
    );
  } catch {
    /* EEXIST=并发同告警败者：按已告警（抑制）处理；写败不阻断 */
  }
  err(`[wake-kick] 唤醒搁置告警：${detail}（事件留队，哨兵滞留 drain 兜底）`);
  return { alerted: true };
}

/* --- 合并注入 --- */

/**
 * 合并形状：取最新 batchMax 个事件，最新者为签名 mission；计数行
 * 「另有 N 项待处理，详見板」附注（N=本轮全部事件-1，含留队余量——诚实计数）。
 * title/status 从板面取（缺失回退 mission_id/done）；title 先自夹紧再拼计数行，
 * 保证计数行不被 sanitizeSummary 200 字夹紧截断。
 */
export function buildWakeCond(rootDir, events, fsImpl = fs) {
  const batch = events.slice(-WAKE_BATCH_MAX); // 文件名字典序=时序；取最新
  const primary = batch[batch.length - 1];
  const n = events.length - 1;
  const suffix = n > 0 ? `｜另有 ${n} 项待处理，详見板` : "";
  const board = readBoardSafe(rootDir, fsImpl);
  const bm = board && Array.isArray(board.missions)
    ? board.missions.find((m) => m && m.id === primary.ev.mission_id)
    : null;
  const status = bm && RESULT_STATUSES.includes(bm.status) ? bm.status : "done";
  const rawTitle = bm && bm.title != null ? String(bm.title) : String(primary.ev.mission_id);
  const base = rawTitle.replace(/\s+/g, " ").trim().slice(0, Math.max(0, 200 - suffix.length));
  return {
    batch,
    leftover: events.slice(0, Math.max(0, events.length - WAKE_BATCH_MAX)),
    cond: { missionId: String(primary.ev.mission_id).trim(), status, title: base + suffix },
  };
}

/* --- 执行器主体（模块导出面：tests 以 mock transport 全链驱动，CLI 形走 main） --- */

/**
 * 一轮消费：返回 {action, drained, kept, outcome}。
 *   action ∈ idle（队列空）| claim-held | anchor-gate | drained | failed
 * 注入调用=W2 import 直调：createWatcher({rootDir, argv:[--verdict-window-sec 1...]}).
 * runTransaction(syntheticCond)——复活观察窗裁至 1s（弱验证窗，注入即成功口径）；
 * 锚活性已前置校验，revivedProbe 不注入（pack TASK 裁定）。
 * b2 禁用（锚劫持防线，硬要求）：注入前后显式校验 coord-session.txt 字节未变——
 * 被改（=watcher 注入链内 b2 刷新锚）即原子还原快照并按失败处置（事件留队+
 * anchor-rewritten 告警）。watcher-signals.jsonl 同款快照还原：kick 的瞬时降级
 * 信号不落共享面（哨兵 W6 消费面不因 kick 重试误判「watcher 在岗」而静默 C1）。
 */
export async function runKick({
  rootDir,
  argv = [],
  fsImpl = fs,
  now = Date.now,
  sleepFn = sleep,
  createWatcherImpl = createWatcher,
  watcherDeps = {}, // transportFactory/jwtLoader/deviceLoader/now/sleepFn 等 mock 注入面
  anchorFreshMs = WAKE_ANCHOR_FRESH_MS,
  claimStaleMs = WAKE_CLAIM_STALE_MS,
  alertGapMs = WAKE_ALERT_GAP_MS,
  err = (l) => process.stderr.write(l + "\n"),
} = {}) {
  const queueDir = queueDirOf(rootDir);

  // 1) 扫描 + 毒丸隔离
  const scan0 = scanQueue(rootDir, fsImpl);
  if (scan0.poison.length) quarantinePoison(rootDir, scan0.poison, fsImpl, err);
  if (!scan0.events.length) return { action: "idle", drained: 0, kept: 0, outcome: null };

  // 2) 认领串行化（他者持有 → 静默退出；哨兵「认领文件在→跳过」的执行侧对偶）
  const claim = await acquireClaim(rootDir, { fsImpl, now, sleepFn, claimStaleMs });
  if (claim.held) return { action: "claim-held", drained: 0, kept: scan0.events.length, outcome: null };

  // 3..6) 单轮 drain（溢出余量留队=设计语义：>12 取最新 12+计数行，余下经哨兵滞留
  // drain 延迟消费——kick 不做同轮重扫，避免把「延迟跳变可达」的分批确认腿吃掉；
  // 「写事件-认领-释放」竞态窗内新落事件由下一触发点（生产者/哨兵 120s）接住）
  const guardAnchor = path.join(rootDir, "sentinel", "coord-session.txt");
  const guardSignals = path.join(rootDir, "sentinel", "watcher-signals.jsonl");
  let drained = 0;
  let kept = 0;
  let action = "idle";
  let outcome = null;
  try {
    const scan = scanQueue(rootDir, fsImpl);
    if (!scan.events.length) {
      action = "idle";
    } else {

      // 3) 锚活性前置校验（不过=留队+refire gap 告警，绝不 b2）
      const gate = anchorGate(rootDir, { argv, fsImpl, now, anchorFreshMs });
      if (!gate.ok) {
        const detail =
          `锚活性双闸不过（${gate.reason}，anchor=${gate.sid ?? "(缺失)"}）：` +
          `${scan.events.length} 项唤醒事件留队；kick 路径禁用 b2 自愈（锚劫持防线），候锚恢复或哨兵 C1 兜底`;
        const { alerted } = emitKickAlert(rootDir, { sid: gate.sid, cause: gate.reason, detail, fsImpl, now, gapMs: alertGapMs, err });
        kept += scan.events.length;
        action = "anchor-gate";
        outcome = gate.reason;
        void alerted;
      } else {
        // 4) 合并形状（≤12 + 计数行）
        const { batch, cond } = buildWakeCond(rootDir, scan.events, fsImpl);

        // 5) 防线快照（锚 + signals；净效果=两者 kick 路径零改写）
        const snapshot = [
          { file: guardAnchor, bytes: (() => { try { return fsImpl.readFileSync(guardAnchor); } catch { return null; } })() },
          { file: guardSignals, bytes: (() => { try { return fsImpl.readFileSync(guardSignals); } catch { return null; } })() },
        ];

        // 注入调用（W2 import 直调；--verdict-window-sec 1 裁复活窗；argv 透传 --rollout-dir 等）
        let tx = null;
        try {
          const w = createWatcherImpl({
            rootDir,
            argv: [...argv, "--verdict-window-sec", "1"],
            ...watcherDeps,
          });
          tx = await w.runTransaction(cond);
        } catch (e) {
          tx = { outcome: "exception", kind: String((e && e.message) || e).slice(0, 120) };
        }

        // 6) 防线后置校验：锚/signals 被改 → 原子还原快照
        let anchorRewritten = false;
        for (const g of snapshot) {
          let cur = null;
          try { cur = fsImpl.readFileSync(g.file); } catch { cur = null; }
          if (bufSame(cur, g.bytes)) continue;
          if (g.file === guardAnchor) anchorRewritten = true;
          try {
            if (g.bytes === null) fsImpl.unlinkSync(g.file); // 快照缺失 → 还原为缺失
            else atomicWrite(g.file, g.bytes, fsImpl);
          } catch {
            err(`[wake-kick] 防线还原失败：${g.file}（人工核查锚/信号面）`);
          }
        }
        if (anchorRewritten) {
          emitKickAlert(rootDir, {
            sid: gate.sid,
            cause: "anchor-rewritten",
            detail: `注入路径锚被改写（b2 自愈刷新面，已还原快照）：kick 路径锚零改写红线触发，${batch.length} 项事件留队`,
            fsImpl, now, gapMs: alertGapMs, err,
          });
          kept += scan.events.length;
          action = "failed";
          outcome = "anchor-rewritten";
        } else {
          outcome = tx && tx.outcome != null ? tx.outcome : "unknown";
          if (tx && WAKE_DELIVERED.has(tx.outcome)) {
            // 成功：移除已 drain 事件文件（仅本批；逐个 unlink 容 ENOENT）
            for (const it of batch) {
              try { fsImpl.unlinkSync(path.join(queueDir, it.name)); } catch { /* 已被并发消费 */ }
            }
            drained += batch.length;
            kept = scan.events.length - batch.length; // 溢出余量（留队，哨兵滞留 drain 延迟消费）
            action = "drained";
          } else {
            // 失败：留队（哨兵兜底）
            kept += scan.events.length;
            action = "failed";
          }
        }
      }
    }
  } finally {
    claim.release();
  }
  return { action, drained, kept, outcome };
}

/* --- CLI 形（生产者/哨兵 spawn 落点；自杀护栏在此 armed） --- */
export async function main(argv = process.argv.slice(2)) {
  const rootDir = resolveRoot(argv);
  const guard = setTimeout(() => {
    try { process.stderr.write("[wake-kick] 自杀护栏到点（120s），强制退出（事件留队，claim 残留超龄可回收）\n"); } catch { /* stderr 断绝不致命 */ }
    process.exit(3);
  }, WAKE_KICK_TIMEOUT_MS);
  try {
    const r = await runKick({ rootDir, argv });
    process.stdout.write(`[wake-kick] ${JSON.stringify(r)}\n`);
    return r;
  } catch (e) {
    try { process.stderr.write("[wake-kick] 异常退出（事件留队）：" + String((e && e.message) || e).slice(0, 200) + "\n"); } catch { /* 不致命 */ }
    process.exitCode = 1;
    return { action: "exception", drained: 0, kept: 0, outcome: String((e && e.message) || e).slice(0, 120) };
  } finally {
    clearTimeout(guard);
  }
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { process.exitCode = 1; });
}
