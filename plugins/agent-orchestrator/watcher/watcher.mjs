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
 *   - 工作区锚钉（G10，v0.10 G3/G5）：`sentinel/coord-workspace.txt` 与 coord-session.txt 同级
 *     （单行派生键=workspaceIdentity.trim||workspacePath）。有锚→openBridge workspaceKeyHint
 *     （工作区列表顺序随桌面会话/草稿漂移时不选错工作区）；**无锚/锚未命中=fail-loud
 *     （workspace-anchor-missing / workspace-anchor-mismatch → D3 配置告警），绝不盲取
 *     workspaces[0]**（EXP10 R4：错工作区注入+b2 建会话+回读刷新劫持 coord-session 锚）。
 *     watcher 只读锚不写锚；锚的写面=互信根三触发（server 启动补位 / toolResume / SessionStart）。
 *   - INJECT b2 生产接线（v0.10 G4/G5）：主路径统一走 wakeCoordSession（openBridge+b1/b2 自愈+
 *     应答回读+b2 工作区守卫+coord-session 刷新一体）；b2 刷新仅当桥/应答工作区与锚一致，
 *     否则保持原锚并把 warning 落日志（防锚劫持重现）。
 *   - 日志闸：一切出口经 credentials.redact（token 形态/Bearer 归零；token 值零持久化）
 *
 * 启动：node watcher/watcher.mjs --root <存储根> [--origin https://zcode.z.ai]
 *   [--poll-sec 30] [--min-interval-sec 90] [--wake-cap 3] [--hold-max-sec 40]
 *   [--trigger-statuses done,failed,blocked,question] [--transport cloud|loopback]
 *   [--loopback-origin http://127.0.0.1:<p>] [--loopback-port N] [--rollout-dir <dir>] [--once]
 * 常驻运行须用户显式授权（W-G §5.5；停用=进程退出+凭证自然过期，一键可断）。
 * 零 npm 依赖；node >= 20。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TxnGate, HOLD_MAX_MS, SIGN_CONNECT_MAX_MS, signAndConnect } from "./txn.mjs";
import * as creds from "./credentials.mjs";
import { connectRelay, buildWs2Url } from "./relay.mjs";
import { buildTemplateShell, wakeCoordSession } from "./inject.mjs";
import { classifyAccept, finalVerdict, observeRevival, rolloutRevivedProbe, VERDICT_WINDOW_MS } from "./verdict.mjs";
import { DegradeState, classifyFailure, failureFromClose, CLASSES, loopbackD2Hint } from "./degrade.mjs";
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

/**
 * G11：③ 复活探针的 rollout 目录解析（CLI --rollout-dir > cfg rollout_dir > 缺省
 * ~/.zcode/cli/rollout，与 hooks/bg-sentinel.mjs signalsOf 缺省同源）。沿用 strArg
 * 「argv 优先、cfg 兜底、def 缺省」三段式；空串/未展开占位符落下一链。
 */
export function resolveRolloutDir(argv = [], cfg = {}, { homedir = os.homedir() } = {}) {
  return strArg(argv, "--rollout-dir", cfg, "rollout_dir", path.join(homedir, ".zcode", "cli", "rollout"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 挂起响应守卫（v0.10 G respP 潜伏面）：对可能无人 await 的挂起响应 promise 先挂消费
 * catch，使 rejection 恒被处理（不再以 unhandledRejection 崩 watcher 进程）；原 promise
 * 仍向显式 await 方透传拒绝，语义不变。导出仅供断言消费（watcher-core 体例）。
 */
export function guardPendingResponse(p) {
  p.catch(() => {});
  return p;
}

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

  /* W2 transport 面（v0.10 §3.1-§3.2）：cfg/CLI 三键 transport/loopback_origin|loopbackOrigin/loopback_port|loopbackPort。
   * 白名单 cloud|loopback（lan 不预留枚举，Q1）；非法值启动即拒（W-TRN-02）；loopbackOrigin host 非回环启动即拒
   * （与 SHIM-03 同轴，防配置面绕过硬闸）。cloud/缺省路径零新增分支行为（CR-04 锁，W-TRN-01）。 */
  const transportRaw = strArg(argv, "--transport", cfg, "transport", "");
  const transport = transportRaw === "" ? "cloud" : transportRaw;
  if (transport !== "cloud" && transport !== "loopback") {
    throw new Error(`watcher: transport 非法值 "${transportRaw}"（白名单 cloud|loopback；lan 不预留枚举，Q1）`);
  }
  const loopbackPort = numArg(argv, "--loopback-port", cfg, "loopback_port", Number.isFinite(Number(cfg && cfg.loopbackPort)) ? Number(cfg.loopbackPort) : NaN, 1, 65535);
  const loopbackOriginCfg = strArg(argv, "--loopback-origin", cfg, "loopback_origin", "") || (cfg && cfg.loopbackOrigin != null ? String(cfg.loopbackOrigin).trim() : "");
  let loopbackOrigin = "";
  if (transport === "loopback") {
    const o = loopbackOriginCfg || (Number.isFinite(loopbackPort) ? `http://127.0.0.1:${loopbackPort}` : "");
    let u = null;
    try { u = new URL(o); } catch { u = null; }
    if (!o || !u || u.protocol !== "http:") throw new Error(`watcher: transport=loopback 需要合法 --loopback-origin（http://127.0.0.1:<p>）或 --loopback-port，得到 "${o || "(空)"}"`);
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new Error(`watcher: loopbackOrigin host 非回环 "${u.hostname}"（仅 127.0.0.1/localhost，SHIM-03 同轴硬闸）`);
    loopbackOrigin = o.replace(/\/+$/, "");
  }
  const effOrigin = transport === "loopback" ? loopbackOrigin : origin; // W-TRN-01：cloud/缺省=origin 原值（逐字节锁）

  const gate = new TxnGate({
    now,
    minIntervalMs: numArg(argv, "--min-interval-sec", cfg, "min_interval_sec", 90, 0, 3600) * 1000,
    cap: Math.round(numArg(argv, "--wake-cap", cfg, "wake_cap", 3, 1, 100)),
    busySilenceMs: numArg(argv, "--busy-silence-min", cfg, "busy_silence_min", 30, 1, 1440) * 60000,
  });
  const degrade = new DegradeState({ rootDir, fsImpl, now, log: (line) => emit(line) });
  const heartbeatFile = path.join(rootDir, "sentinel", "watcher-heartbeat");
  const coordSessionFile = path.join(rootDir, "sentinel", "coord-session.txt");
  const coordWorkspaceFile = path.join(rootDir, "sentinel", "coord-workspace.txt"); // G10 工作区锚（与 coord-session 同级，独立文件不破既有 reader）

  const emit = (line) => {
    try { process.stdout.write(redact(line) + "\n"); } catch { /* stdout 断绝不致命 */ }
  };
  const seqRef = { n: Math.floor(now() / 1000) % 100000 };

  const loadJwt = jwtLoader || (() => creds.loadPlatformJwt({ fsImpl }));
  const loadDevice = deviceLoader || (async ({ jwt }) => {
    const f = fetchImpl || globalThis.fetch;
    const listed = await creds.fetchDevices({ fetchImpl: f, origin: effOrigin, jwt }); // W2：origin 按 transport 分派（cloud=原值，CR-04 锁）
    if (listed.ok) {
      const local = creds.loadLocalDevice({ fsImpl });
      const picked = creds.pickDesktopDevice(listed.devices, local);
      if (picked.ok) return picked;
    }
    if (transport === "loopback") return { ok: false, kind: listed.ok ? "no-device" : listed.kind }; // loopback：空表=桌面 env 未生效→D2（不落 setting.json 备链，§3.2）
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

  /** G10/G5 工作区锚读取：缺失/空=null（G5 起=生产 fail-loud——openBridge 不再盲取
   * workspaces[0]；锚只由互信根面写：server 启动补位 / toolResume / SessionStart）。 */
  function sessionWorkspaceKey() {
    try {
      const v = fsImpl.readFileSync(coordWorkspaceFile, "utf8").trim();
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
      // CREDS S0-S1：JWT（零缓存，单事务内存生存期）；transport=loopback 时跳过（shim 免 JWT，零出站不触凭据解密面，§3.2）
      const jwtRes = transport === "loopback" ? { ok: true, jwt: null } : loadJwt();
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
            return creds.issueTerminalToken({ fetchImpl: f, origin: effOrigin, jwt }); // W2：loopback→shim 端点（Authorization 头被 shim 忽略）
          },
          connect: (token, { handshakeTimeoutMs }) =>
            connectRelay({
              url: buildWs2Url({ origin: effOrigin, token, mid: dev.deviceMid }), // W2：loopback→ws://127.0.0.1（relay.mjs 组装零改动）
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

      // BRIDGE + INJECT（v0.10 G4 b2 生产接线 + G5 锚守卫）：主路径统一走 wakeCoordSession——
      // openBridge（G10：coord 锚旁工作区键=显式 workspaceKeyHint；**无锚 fail-loud，禁止盲取
      // workspaces[0]**）→ sendPrompt（b1 sendText；b2 createSession+firstInput 自愈恰一次）→
      // 应答回读（RESP_TIMEOUT_MS 冷启覆盖）→工作区守卫通过才原子刷新 coord-session.txt，
      // 全在其内部完成（禁改内部行为）；sendPrompt 导出面保留（mock/离线断言引用）。
      seqRef.n += 1;
      const shell = buildTemplateShell({ missionId, state: cond.status, summary: cond.title, eventId: "latest" });
      const workspaceKeyHint = sessionWorkspaceKey();
      // 潜伏面修复（v0.10 G，W3s 遗留注记）+ G4 分工：V1 session-send-response legacy 面仍先
      // 挂起再发（防丢帧竞态）并经 guardPendingResponse 挂消费 catch（失败路径无裸挂起
      // promise）；权威 ② 面=wakeCoordSession 内频道 [201] callP 回读（wake.response），
      // respP 仅在其为空时兜底（时序见下注）。
      const respReqId = "ow-" + seqRef.n;
      const respP = guardPendingResponse(session.awaitData("session-send-response", { timeoutMs: 8000, reqId: respReqId }));
      // G5：watcher 绝不写工作区锚（R4 锚劫持的写入者正是「首个成功开桥即记锚」——b2 在新会话
      // 建好后把错工作区固化进 coord-workspace.txt）。锚的写面只留互信根：server 启动补位 /
      // toolResume 双写 / SessionStart 双写；watcher 只读。
      let wake;
      try {
        wake = await wakeCoordSession({
          session,
          coordSessionPath: coordSessionFile,
          content: shell,
          workspaceKeyHint,
          fsImpl,
        });
      } catch (err) {
        if (session.kicked) return applyFailure(missionId, { kind: "kicked" });
        if (holdBreached) return applyFailure(missionId, { kind: "hold-timeout" });
        if (session.closeInfo) return applyFailure(missionId, failureFromClose(session.closeInfo));
        const code = String((err && err.code) || "");
        if (code === "bridge-list-empty") return applyFailure(missionId, { kind: "bridge-list-empty" });
        if (code === "workspace-anchor-missing" || code === "bridge-anchor-missing") {
          return applyFailure(missionId, { kind: "workspace-anchor-missing" });
        }
        if (code === "bridge-anchor-mismatch") return applyFailure(missionId, { kind: "workspace-anchor-mismatch" });
        if (code === "rpc-ack-timeout") return applyFailure(missionId, { kind: "rpc-ack-timeout" });
        if (code === "relay-closed") return applyFailure(missionId, { kind: "relay-closed" });
        return applyFailure(missionId, { kind: "relay-request-timeout" });
      }
      // G5 工作区守卫告警入日志（b2 刷新被拦截时：新会话已在错/未验证工作区建立，锚保持原值）
      if (wake && Array.isArray(wake.warnings) && wake.warnings.length) {
        emit(`[watcher] mission=${missionId} warn=${wake.warnings.join(",")}`);
      }
      const ackOk = Boolean(wake && wake.ack);

      // ②受理：权威面=频道 [201] 回读（wake.response）；为空时才拾取 V1 legacy 面。注意
      // awaitData 的挂起槽会被 wakeCoordSession 内 openBridge 的 L2 请求顶替，故 legacy 面在
      // 新路径上不再可能命中（只会按 8s 窗到期）；此时其 timer 早已到期，兜底零额外等待。
      let response = wake ? wake.response : null;
      if (response == null) {
        try {
          response = await respP;
        } catch {
          if (session.kicked) return applyFailure(missionId, { kind: "kicked" });
          response = null; // 无响应=①已达②未明：按 no-ack 面（D2）
        }
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
      // b2 自愈后探针对象=新建的活体会话（wake.sessionId），否则维持 coord 目标。
      const revivalSessionId = wake && wake.selfHealed && wake.sessionId ? wake.sessionId : targetSession;
      const revived = await observeRevival({
        revivedProbe: probeRevived,
        sessionId: revivalSessionId,
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
        const hint = cls.cls === CLASSES.D2 && transport === "loopback" ? loopbackD2Hint({ origin: loopbackOrigin }) : null; // W-DGR2-01：loopback 断连提示必含桌面双 env 名
        degrade.record({ cls: cls.cls, missionId, reason: kind, hint });
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
    cfg: { pollMs, origin, transport, loopbackOrigin, holdMaxMs, signConnectMaxMs, verdictWindowMs, triggerStatuses, heartbeatMs, minIntervalMs: gate.minIntervalMs, busySilenceMs: gate.busySilenceMs },
    writeHeartbeat,
    sessionTarget,
    sessionWorkspaceKey, // G10 测试/观测面：锚读取（缺省 null）
    get disabled() { return degrade.terminal ? degrade.state.cls : null; },
  };
}

/** 主循环（守护形态）：tick → sleep(pollMs)；SIGINT/SIGTERM 优雅退出。 */
export async function main(argv = process.argv.slice(2)) {
  const rootDir = resolveRoot(argv);
  // G11：③ 复活观测接线（EXP10 R4-3）——rollout 心跳探针此前只导出未注入，生产直跑
  // 恒落空探针 → verdict 系统性失真为 accepted-not-revived。rolloutDir 缺省与
  // bg-sentinel.mjs signalsOf 同源（~/.zcode/cli/rollout），CLI/cfg 可覆盖。
  const rolloutDir = resolveRolloutDir(argv, loadCfg(rootDir));
  const w = createWatcher({ rootDir, argv, revivedProbe: rolloutRevivedProbe({ rolloutDir }) });
  process.stdout.write(redact(`[watcher] 启动 root=${rootDir} origin=${w.cfg.origin} poll=${w.cfg.pollMs}ms interval≥${w.cfg.minIntervalMs}ms trigger=[${w.cfg.triggerStatuses.join(",")}]` + (w.cfg.transport === "loopback" ? ` transport=loopback endpoint=${w.cfg.loopbackOrigin}` : "") + ` rollout=${rolloutDir}` + "\n") + "\n");
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
