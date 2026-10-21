#!/usr/bin/env node
/*!
 * watcher/watcher.mjs —— 守护入口（九模块组合根：W-W §1/§2）
 *
 * 生命周期：常驻进程（永不因失败退出，W-W §7）；对中继永短事务（连-发-断，持有 ≤40s）。
 *   standby（轮询中）→ transacting（短事务在飞，每轮至多一个）→ 终态降级 standby
 *   （D1/D3/kicked：停事务面、保心跳，等人工/哨兵接管）。
 *
 * 职责面：
 *   - 参数/cfg 桥接：CLI > <root>/watcher.cfg.json > 内建默认（numArgBridge twin 先例，
 *     V7-05 教训：桥接键勿被默认值遮蔽）
 *   - 定根：--root 优先，默认 <cwd>/.zcode/orchestrator；**从不读 root.txt 指针**
 *     （lessons error-fix：server 定根从不读指针、hooks 盲跟指针曾致全体失明——watcher 站 server 侧）
 *   - 心跳自证：每 60s 写 <root>/sentinel/watcher-heartbeat（mtime 即心跳；哨兵反向监控，
 *     职责互换 W-W §2）
 *   - 主循环：POLLER 分类 → TXN 闸 → 短事务（CREDS→RELAY→BRIDGE→INJECT→VERDICT）→ DEGRADE
 *   - 日志闸：一切出口经 credentials.redact（token 形态/Bearer 归零；token 值零持久化）
 *
 * 启动：node watcher/watcher.mjs --root <存储根> [--origin https://zcode.z.ai]
 *   [--poll-sec 30] [--min-interval-sec 90] [--wake-cap 3] [--hold-max-sec 40]
 *   [--trigger-statuses done,failed,blocked,question] [--once]
 * 常驻运行须用户显式授权（W-G §5.5；停用=进程退出+凭证自然过期，一键可断）。
 * 零 npm 依赖；node >= 20。
 */
import fs from "node:fs";
import path from "node:path";

import { TxnGate, HOLD_MAX_MS, SIGN_CONNECT_MAX_MS, signAndConnect } from "./txn.mjs";
import * as creds from "./credentials.mjs";
import { connectRelay, buildWs2Url } from "./relay.mjs";
import { openBridge } from "./bridge.mjs";
import { buildTemplateShell, sendPrompt } from "./inject.mjs";
import { classifyAccept, finalVerdict, observeRevival, VERDICT_WINDOW_MS } from "./verdict.mjs";
import { DegradeState, classifyFailure, failureFromClose, CLASSES } from "./degrade.mjs";
import { classifyForWatcher, pickNext, readBoardSafe, boardMtimeMs, RESULT_STATUSES } from "./poller.mjs";
import { redact } from "./credentials.mjs";

/* --- 参数解析 twins（bg-sentinel 同款三链：CLI > cfg > 默认） --- */
function parseArg(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1] ?? "";
    if (argv[i].startsWith(flag + "=")) return argv[i].slice(flag.length + 1);
  }
  return undefined;
}
function numArg(argv, flag, cfg, cfgKey, def, min, max) {
  const raw = parseArg(argv, flag);
  const s = raw === undefined ? "" : String(raw).trim();
  if (s && !s.startsWith("${")) {
    const n = Number(s);
    if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
  }
  const c = Number(cfg ? cfg[cfgKey] : NaN);
  if (Number.isFinite(c)) return Math.min(max, Math.max(min, c));
  return def;
}
function strArg(argv, flag, cfg, cfgKey, def) {
  const raw = parseArg(argv, flag);
  const s = raw === undefined ? "" : String(raw).trim();
  if (s && !s.startsWith("${")) return s;
  const c = cfg && cfg[cfgKey] != null ? String(cfg[cfgKey]).trim() : "";
  return c || def;
}

function loadCfg(rootDir, fsImpl = fs) {
  try {
    const c = JSON.parse(fsImpl.readFileSync(path.join(rootDir, "watcher.cfg.json"), "utf8"));
    return c && typeof c === "object" ? c : {};
  } catch {
    return {};
  }
}

export function resolveRoot(argv, { cwd = process.cwd() } = {}) {
  const r = parseArg(argv, "--root");
  const root = r && String(r).trim() ? path.resolve(String(r).trim()) : path.join(cwd, ".zcode", "orchestrator");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Watcher 实例：deps 全可注入（fsImpl/now/fetchImpl/transportFactory/revivedProbe/jwtLoader/
 * sleepFn/deviceLoader/sessionTarget）——tests/suites/watcher-core.mjs 以 mock relay+mock 凭据
 * 全链驱动，零真实触达。
 */
export function createWatcher({
  rootDir,
  argv = [],
  fsImpl = fs,
  now = Date.now,
  fetchImpl = undefined,
  transportFactory = undefined,
  revivedProbe = null,
  jwtLoader = null,
  deviceLoader = null,
  sleepFn = sleep,
} = {}) {
  const cfg = loadCfg(rootDir, fsImpl);
  const pollMs = numArg(argv, "--poll-sec", cfg, "poll_sec", 30, 1, 3600) * 1000;
  const origin = strArg(argv, "--origin", cfg, "origin", "https://zcode.z.ai").replace(/\/+$/, "");
  const heartbeatMs = numArg(argv, "--heartbeat-sec", cfg, "heartbeat_sec", 60, 1, 3600) * 1000;
  const holdMaxMs = numArg(argv, "--hold-max-sec", cfg, "hold_max_sec", HOLD_MAX_MS / 1000, 1, 600) * 1000;
  const signConnectMaxMs = numArg(argv, "--sign-connect-max-sec", cfg, "sign_connect_max_sec", SIGN_CONNECT_MAX_MS / 1000, 1, 60) * 1000;
  const verdictWindowMs = numArg(argv, "--verdict-window-sec", cfg, "verdict_window_sec", VERDICT_WINDOW_MS / 1000, 1, 600) * 1000;
  const triggerStatuses = strArg(argv, "--trigger-statuses", cfg, "trigger_statuses", RESULT_STATUSES.join(",")).split(",").map((s) => s.trim()).filter((s) => RESULT_STATUSES.includes(s));

  const gate = new TxnGate({
    now,
    minIntervalMs: numArg(argv, "--min-interval-sec", cfg, "min_interval_sec", 90, 0, 3600) * 1000,
    cap: Math.round(numArg(argv, "--wake-cap", cfg, "wake_cap", 3, 1, 100)),
    busySilenceMs: numArg(argv, "--busy-silence-min", cfg, "busy_silence_min", 30, 1, 1440) * 60000,
  });
  const degrade = new DegradeState({ rootDir, fsImpl, now, log: (line) => emit(line) });
  const heartbeatFile = path.join(rootDir, "sentinel", "watcher-heartbeat");
  const coordSessionFile = path.join(rootDir, "sentinel", "coord-session.txt");

  const emit = (line) => {
    try { process.stdout.write(redact(line) + "\n"); } catch { /* stdout 断绝不致命 */ }
  };
  const seqRef = { n: Math.floor(now() / 1000) % 100000 };

  const loadJwt = jwtLoader || (() => creds.loadPlatformJwt({ fsImpl }));
  const loadDevice = deviceLoader || (async ({ jwt }) => {
    const f = fetchImpl || globalThis.fetch;
    const listed = await creds.fetchDevices({ fetchImpl: f, origin, jwt });
    if (listed.ok) {
      const local = creds.loadLocalDevice({ fsImpl });
      const picked = creds.pickDesktopDevice(listed.devices, local);
      if (picked.ok) return picked;
    }
    const local = creds.loadLocalDevice({ fsImpl }); // API 败/拣选败 → 本地 setting.json 备链（零网络）
    if (local && local.deviceSid && local.deviceMid) return { ok: true, ...local };
    return { ok: false, kind: listed.ok ? "no-device" : listed.kind };
  });
  const probeRevived = revivedProbe || (() => false); // 内建 rollout 探针见 verdict.rolloutRevivedProbe

  let boardFailTicks = 0;

  function writeHeartbeat(stateLabel) {
    try {
      fsImpl.mkdirSync(path.dirname(heartbeatFile), { recursive: true });
      fsImpl.writeFileSync(heartbeatFile, JSON.stringify({ at: new Date(now()).toISOString(), pid: process.pid, state: stateLabel }) + "\n");
    } catch { /* 心跳写败不致命 */ }
  }

  function sessionTarget() {
    try {
      const v = fsImpl.readFileSync(coordSessionFile, "utf8").trim();
      return v || null;
    } catch {
      return null;
    }
  }

  /** 单个短事务（连-发-断）：返回 outcome 码。全部失败面已归类，绝不抛出。 */
  async function runTransaction(cond) {
    const missionId = cond.missionId;
    let session = null;
    let holdBreached = false;
    let holdTimer = null;
    const t0 = now();
    try {
      // CREDS S0-S1：JWT（零缓存，单事务内存生存期）
      const jwtRes = loadJwt();
      if (!jwtRes.ok) return applyFailure(missionId, { kind: jwtRes.reason.startsWith("jwt-shape") ? "jwt-shape" : jwtRes.reason });
      const jwt = jwtRes.jwt;

      // 目标会话（W-W §4：coord-session.txt 缺失 → D3）
      const targetSession = sessionTarget();
      if (!targetSession) return applyFailure(missionId, { kind: "session-target-missing" });

      // CREDS S2：设备发现（API 主链 + setting.json 备链）
      const dev = await loadDevice({ jwt });
      if (!dev.ok) return applyFailure(missionId, { kind: dev.kind === "auth-required" ? "sign-auth-required" : "device-offline" });

      // CREDS S3 + RELAY：TTL 同事务签-连（≤55s，超窗弃签重签一次）
      let signed;
      try {
        signed = await signAndConnect({
          issueToken: async () => {
            const f = fetchImpl || globalThis.fetch;
            return creds.issueTerminalToken({ fetchImpl: f, origin, jwt });
          },
          connect: (token, { handshakeTimeoutMs }) =>
            connectRelay({
              url: buildWs2Url({ origin, token, mid: dev.deviceMid }),
              deviceSid: dev.deviceSid,
              transportFactory: transportFactory || undefined,
              handshakeTimeoutMs,
            }),
          deadlineMs: signConnectMaxMs,
          nowMs: now,
          sleepFn,
        });
      } catch (err) {
        if (err && err.code === "sign-failed") return applyFailure(missionId, { kind: "sign-" + err.kind });
        if (err && err.code === "ttl-exhausted") return applyFailure(missionId, { kind: "ttl-exhausted" });
        if (err && err.code === "auth-not-matched") return applyFailure(missionId, { kind: "auth-not-matched" });
        if (err && err.code === "relay-closed" && err.closeCode != null) return applyFailure(missionId, { kind: "close-" + String(err.closeCode) });
        return applyFailure(missionId, { kind: "connect-failed" });
      }
      session = signed.session;
      if (session.kicked) return applyFailure(missionId, { kind: "kicked" });

      // 持有帽（EXP-3 §5.1 ≤40s）：到点强制断，占槽礼仪
      holdTimer = setTimeout(() => {
        holdBreached = true;
        try { session.close(1000, "hold-cap"); } catch { /* 已断 */ }
      }, holdMaxMs);

      // RELAY 步骤 2-3：auth_init/ack 已在 connectRelay 内完成（matched 检查）
      // （connectRelay 返回即 auth_ack 已收；waiting/不匹配按 reject 归 connect 面）

      // BRIDGE：L2 编排
      let bridge;
      try {
        bridge = await openBridge({ session });
      } catch (err) {
        if (session.kicked) return applyFailure(missionId, { kind: "kicked" });
        if (String((err && err.code) || "") === "bridge-list-empty") return applyFailure(missionId, { kind: "bridge-list-empty" });
        if (session.closeInfo) return applyFailure(missionId, failureFromClose(session.closeInfo));
        return applyFailure(missionId, { kind: "relay-request-timeout" });
      }
      void bridge;

      // INJECT：模板壳（隐私最小化：id+状态+指针）；②响应先挂起再发（防丢帧竞态）
      seqRef.n += 1;
      const respReqId = "ow-" + seqRef.n;
      const respP = session.awaitData("session-send-response", { timeoutMs: 8000, reqId: respReqId });
      const shell = buildTemplateShell({ missionId, state: cond.status, summary: cond.title, eventId: "latest" });
      let sent;
      try {
        sent = await sendPrompt({ session, seq: seqRef.n, sessionId: targetSession, content: shell });
      } catch (err) {
        if (session.kicked) return applyFailure(missionId, { kind: "kicked" });
        if (holdBreached) return applyFailure(missionId, { kind: "hold-timeout" });
        if (session.closeInfo) return applyFailure(missionId, failureFromClose(session.closeInfo));
        return applyFailure(missionId, { kind: err && err.code === "rpc-ack-timeout" ? "rpc-ack-timeout" : "relay-closed" });
      }
      const ackOk = Boolean(sent && sent.ack);

      // ②受理：session/send 响应（data/session-send-response 形状，活体集成阶段复核）
      let response = null;
      try {
        response = await respP;
      } catch {
        if (session.kicked) return applyFailure(missionId, { kind: "kicked" });
        response = null; // 无响应=①已达②未明：按 no-ack 面（D2）
      }

      // 判定①②毕 → 即断（连-发-断；③免连接观测）
      const holdHit = holdBreached;
      session.close(1000, "txn-done");
      clearTimeout(holdTimer);
      holdTimer = null;
      if (holdHit && !ackOk) return applyFailure(missionId, { kind: "hold-timeout" });

      const acc = classifyAccept(response);
      const transportFace = !ackOk ? "no-ack" : acc.accept === "busy" ? "busy" : acc.accept === "rejected" ? "failed" : "delivered";

      // ②=busy：主控在跑，no-op 成功不计失败（W-W §6）；连发 ≥2 busy 静默 30min 在 gate
      if (transportFace === "busy") {
        gate.recordOutcome(missionId, "busy");
        degrade.record({ cls: CLASSES.NOOP, missionId, reason: "busy-noop" });
        emit(`[watcher] mission=${missionId} verdict=noop（busy=主控在跑，无需唤醒，不计失败）`);
        return { outcome: "noop", missionId };
      }
      // ①/②失败面（no-ack/rejected）→ 降级树归类，不进 ③ 观测
      if (transportFace !== "delivered") {
        return applyFailure(missionId, { kind: transportFace === "no-ack" ? "rpc-ack-timeout" : "internal" });
      }

      // ③复活观测（close 后剩余窗，rollout 心跳/prompt_started 双路任一；免连接不占槽）
      const revived = await observeRevival({
        revivedProbe: probeRevived,
        sessionId: targetSession,
        sinceMs: t0,
        windowMs: verdictWindowMs,
        sleepFn,
        nowMs: now,
      });
      const v = finalVerdict({ transport: "delivered", revived });
      gate.recordOutcome(missionId, v.verdict);
      // accepted-not-revived：按成功受理记录（W-W §6），哨兵照常兜底，不重复注入——仅 emit 不写 signals
      emit(`[watcher] mission=${missionId} verdict=${v.verdict}（${v.note}）`);
      return { outcome: v.verdict, missionId };

      function applyFailure(mid, f) {
        void mid;
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (session && !session.closed && !holdBreached) { try { session.close(1000, "txn-abort"); } catch { /* 已断 */ } }
        let kind = (f && f.kind) || "unknown";
        // close-4011（SessionExpired）再败升 D1（W-G §4：重签一次，再败终态）——零缓存下
        // 「重签」=下轮整事务自然重跑；gate 记账显示本 mission 已是第 ≥2 次尝试即视为再败。
        if (kind === "close-4011") {
          const prev = gate.per.get(missionId);
          if (prev && prev.attempts >= 2) kind = "ttl-exhausted";
        }
        const cls = classifyFailure({ kind });
        gate.recordOutcome(missionId, cls.cls === "D2" ? "d2" : cls.cls === "kicked" ? "kicked" : "d1");
        degrade.record({ cls: cls.cls, missionId, reason: kind });
        emit(`[watcher] mission=${missionId} ${cls.terminal ? "终态" : "瞬时"}降级 ${cls.cls}（${kind}）`);
        return { outcome: cls.cls, missionId, kind };
      }
    } catch (err) {
      // 兜底：任何未预期异常归 D2 瞬时，进程不退出
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (session && !session.closed) { try { session.close(1000, "txn-crash"); } catch { /* 已断 */ } }
      gate.recordOutcome(missionId, "d2");
      degrade.record({ cls: CLASSES.D2, missionId, reason: "exception:" + String((err && err.code) || (err && err.message) || "unknown").slice(0, 80) });
      emit(`[watcher] mission=${missionId} 事务异常归 D2（进程不退出）`);
      return { outcome: "D2", missionId };
    }
  }

  /** 一轮轮询（主循环体；--once 跑一次即返）。返回轮询结果摘要。 */  async function tick() {
    writeHeartbeat(degrade.terminal ? degrade.state.cls : gate.lastAnyStartAt && now() - gate.lastAnyStartAt < holdMaxMs ? "transacting" : "standby");
    if (degrade.terminal) {
      return { state: degrade.state.cls, note: "终态 standby：" + degrade.state.reason };
    }
    const mtime = boardMtimeMs(rootDir, fsImpl);
    const board = readBoardSafe(rootDir, fsImpl);
    if (!board) {
      boardFailTicks++;
      if (boardFailTicks === 3) emit("[watcher] board.json 连续不可读 ×3（缺失/损坏？哨兵照常在岗）");
      return { state: "board-unreadable" };
    }
    boardFailTicks = 0;
    const conds = classifyForWatcher(board, { boardMtimeMs: mtime, triggerStatuses, nowMs: now() });
    const cond = pickNext(conds);
    if (!cond) return { state: "idle", pending: 0 };
    const canRun = gate.canRun(cond.missionId, now());
    if (!canRun.ok) return { state: "gated", reason: canRun.reason, waitMs: canRun.waitMs, missionId: cond.missionId };
    gate.recordStart(cond.missionId, now());
    return { state: "transacting", ...(await runTransaction(cond)) };
  }

  return {
    tick,
    runTransaction,
    gate,
    degrade,
    cfg: { pollMs, origin, holdMaxMs, signConnectMaxMs, verdictWindowMs, triggerStatuses, heartbeatMs, minIntervalMs: gate.minIntervalMs, busySilenceMs: gate.busySilenceMs },
    writeHeartbeat,
    sessionTarget,
    get disabled() { return degrade.terminal ? degrade.state.cls : null; },
  };
}

/** 主循环（守护形态）：tick → sleep(pollMs)；SIGINT/SIGTERM 优雅退出。 */
export async function main(argv = process.argv.slice(2)) {
  const rootDir = resolveRoot(argv);
  const w = createWatcher({ rootDir, argv });
  process.stdout.write(redact(`[watcher] 启动 root=${rootDir} origin=${w.cfg.origin} poll=${w.cfg.pollMs}ms interval≥${w.cfg.minIntervalMs}ms trigger=[${w.cfg.triggerStatuses.join(",")}]\n`) + "\n");
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  if (parseArg(argv, "--once") !== undefined) {
    const r = await w.tick();
    process.stdout.write(redact(JSON.stringify(r)) + "\n");
    return 0;
  }
  for (;;) {
    try {
      await w.tick();
    } catch (err) {
      process.stdout.write(redact(`[watcher] tick 异常（不退出）：${String((err && err.message) || err)}\n`));
    }
    await sleep(w.cfg.pollMs);
  }
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(redact("[watcher] fatal: " + String((err && err.message) || err)) + "\n");
    process.exit(1);
  });
}
