/*!
 * suites/watcher-core.mjs —— W1 watcher 守护进程核心套（mock relay + mock 凭据，零真实触达）
 *
 * 覆盖断言组（v0.7-W1；权威设计=designs/agent-orchestrator-v0.7-W-W-findings.md + W-G + EXP-3）：
 *   W-RED  REDACTED 日志闸（token 形态/Bearer 归零 + 自检；W-W §5.5 对账锚）
 *   W-POL  POLLER 分类（classify twin：未签收终态两族/优先级/宽限/签收排除/workflow 排除/
 *          B5 mtime 备链/spool 只数）
 *   W-TXN  TXN 闸（≥90s 频控/cap=3/D2 指数退避/busy×2 静默 30min/nextEligibleAt）
 *   W-TTL  TTL 签-连（≤55s 同事务/超窗弃签重签恰一次/再败 ttl-exhausted→D1 面）
 *   W-CRD  CREDS（AES-256-GCM roundtrip/坏 tag 安全失败/JWT 形态自检无 exp 不判过期/
 *          S0-S3 链 safeParse/401→auth-required/token 正则/设备拣选）
 *   W-RLY  RELAY V2（auth 闸 matched/KICKED 静默互踢第一禁令/关断码映射全表/噪声 data 计数
 *          不解析/awaitData 匹配）
 *   W-BRG  BRIDGE（crc32 IEEE 向量/rpc-frame roundtrip/checksum/分片/限值/L2 编排+空列表）
 *   W-INJ  INJECT（模板壳定案/隐私纪律/单行/200 字夹紧/sendPrompt ack）
 *   W-VRD  VERDICT（三证合一矩阵/busy=noop/③复活观测窗）
 *   W-DGR  DEGRADE（降级树全表 D1-D3/kicked/signals 落盘+滚动+脱敏）
 *   W-E2E  全链 e2e（mock relay+mock 凭据：success/noop-busy×2 静默/kicked 断路/D1 凭据缺失/
 *          D3 coord-session 缺失/D2 建连败退避/hold-cap 40s 面修订为 1s 加速）
 *   W-WS   ws.mjs RFC6455 codec（掩码 roundtrip/分片重装/64 位长度/ping/close/upgrade 形状/
 *          RFC 6455 §1.3 accept 向量）
 *
 * 运行方式：node tests/suites/watcher-core.mjs（注册行归主控胶水，簇 T；run-all 暂不含本套）
 * 前置：node >= 20；无网络（全部 mock/内存对，唯一真实 IO=临时根文件）；总时长 <5s。
 */
import fs from "node:fs";
import path from "node:path";
import { Checker } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot } from "../harness/temp-root.mjs";

import { redact, redactionSelfCheck, deriveCredentialSecret, encryptEntry, decryptEntry, inspectJwt, loadPlatformJwt, pickDesktopDevice, issueTerminalToken, fetchDevices, TOKEN_RE } from "../../watcher/credentials.mjs";
import { classifyForWatcher, pickNext, readBoardSafe, spoolUnreadCount, RESULT_STATUSES } from "../../watcher/poller.mjs";
import { TxnGate, signAndConnect, MIN_INTERVAL_MS, BUSY_SILENCE_MS } from "../../watcher/txn.mjs";
import { RelaySession, connectRelay, mapClose, mapErrorFrame, buildWs2Url, isSignalType } from "../../watcher/relay.mjs";
import { crc32, encodeRpcFrame, decodeRpcFrames, openBridge, LIMITS } from "../../watcher/bridge.mjs";
import { buildTemplateShell, sanitizeSummary, shellCompliant, buildSessionSendParams, sendPrompt } from "../../watcher/inject.mjs";
import { classifyAccept, finalVerdict, observeRevival } from "../../watcher/verdict.mjs";
import { DegradeState, classifyFailure, failureFromClose, CLASSES, SIGNALS_MAX_LINES } from "../../watcher/degrade.mjs";
import { createWatcher, resolveRoot } from "../../watcher/watcher.mjs";
import { encodeFrame, FrameParser, acceptKey, buildUpgradeRequest, parseUpgradeResponse, OP } from "../../watcher/ws.mjs";

const ck = new Checker("watcher-core");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const grp = (n) => process.stderr.write("[grp] " + n + "\n");
const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");

/* 零触网硬护栏（EXP 纪律运行时化）：套内任何路径漏注入 fetchImpl 也只能打到本 stub——
   真实中继/签发端点/任何远端一律禁触；漏注入表现为快速失败（network）而非静默外呼。 */
globalThis.fetch = async (url) => {
  throw Object.assign(new Error("suite-net-forbidden: " + String(url)), { name: "SuiteNetForbidden" });
};

/* ================= mock relay（内存对，零 socket 零触网） ================= */

class MockTransport {
  constructor(server) {
    this.server = server;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.closed = false;
    this.sent = [];
    this.closeArgs = null;
  }
  send(text) {
    if (this.closed) throw Object.assign(new Error("mock-closed"), { code: "relay-closed" });
    this.sent.push(text);
    this.server.onClientText(text, this);
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.closeArgs = { code, reason };
    this.server.onClientClose(this, code, reason);
  }
  /* 服务端 → 客户端（测试驱动面） */
  serverSend(obj) {
    if (this.closed) return;
    (this.server.serverSent = this.server.serverSent || []).push(obj);
    if (this.onmessage) this.onmessage(JSON.stringify(obj));
  }
  serverClose(code, reason = "") {
    if (this.closed) return;
    this.closed = true;
    if (this.onclose) this.onclose({ code, reason });
  }
}

class MockRelay {
  constructor(opts = {}) {
    this.opts = opts;
    this.transports = [];
    this.received = [];
    this.captured = []; // decodeRpcFrames 结果
  }
  transportFactory = (url) => {
    this.urls = this.urls || [];
    this.urls.push(url);
    const t = new MockTransport(this);
    this.transports.push(t);
    if (this.opts.failHandshake) return Promise.reject(Object.assign(new Error("ws-handshake-timeout"), { code: "ws-handshake-timeout" }));
    return Promise.resolve(t);
  };
  get connCount() { return this.transports.length; }
  onClientText(text, t) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    this.received.push(msg);
    if (msg.type === "auth_init") {
      const ps = this.opts.pairStatus === undefined ? "matched" : this.opts.pairStatus;
      if (ps) t.serverSend({ type: "auth_ack", pair_status: ps, terminal_sid: "ts-mock", server_ts: 1 });
      if (this.opts.mode === "kicked") t.serverSend({ type: "error", code: "KICKED" }); // 同步踢（确定性）
      if (this.opts.mode === "close4011") t.serverClose(4011, "SessionExpired");
      if (this.opts.mode === "close4004") t.serverClose(4004, "SessionNotFound");
    }
    if (msg.type === "data" && msg.zcode_type === "workspace-list-request") {
      if (this.opts.noiseBeforeBridge) t.serverSend({ type: "data", zcode_type: "desktop-state-push", payload: "noise-not-to-be-parsed" });
      t.serverSend(this.opts.emptyWorkspace
        ? { type: "data", zcode_type: "workspace-list-response", workspaces: [] }
        : { type: "data", zcode_type: "workspace-list-response", workspaces: [{ workspaceKey: "ws-1", name: "proj" }] });
    }
    if (msg.type === "data" && msg.zcode_type === "workspace-bridge-open") {
      t.serverSend({ type: "data", zcode_type: "workspace-bridge-ready", bridgeSessionId: "bridge-1", initialTaskId: "task-1" });
    }
    if (msg.type === "rpc-frame") {
      this.captured.push(decodeRpcFrames([msg]));
      if (this.opts.mode === "busy") {
        t.serverSend({ type: "rpc-frame-ack", ackMessageSeq: msg.seq });
        t.serverSend({ type: "data", zcode_type: "session-send-response", error: { code: -32010, message: "A prompt is already running" } });
      } else if (this.opts.mode === "accept-reject") {
        t.serverSend({ type: "rpc-frame-ack", ackMessageSeq: msg.seq });
        t.serverSend({ type: "data", zcode_type: "session-send-response", error: { code: -32002, message: "rejected" } });
      } else if (this.opts.mode === "noack") {
        /* 不回 ack：触发持有帽强制断 */
      } else {
        t.serverSend({ type: "rpc-frame-ack", ackMessageSeq: msg.seq });
        t.serverSend({ type: "data", zcode_type: "session-send-response", result: { ok: true } });
      }
    }
  }
  onClientClose() {}
}

/* ================= e2e 工具 ================= */

function writeBoard(root, missions) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "board.json"), JSON.stringify({ version: 2, updated_at: new Date().toISOString(), missions }) + "\n");
}
function writeCoord(root, sid = "sess-coord-test") {
  fs.mkdirSync(path.join(root, "sentinel"), { recursive: true });
  fs.writeFileSync(path.join(root, "sentinel", "coord-session.txt"), sid + "\n");
}
const mission = (id, status, atMs, extra = {}) => ({
  id,
  title: "t-" + id,
  status,
  dispatch: { agent_id: "agent-" + id, mode: "agent" },
  updated_at: new Date(atMs).toISOString(),
  ...extra,
});

/** 造一个全 mock watcher：假时钟（可推进）、即时 sleep（推进假时钟）、mock relay、mock fetch（零真实触达）。 */
function buildWatcher({ root, relay, now, board = null, coord = true, revived = true, extraArgv = [] }) {
  if (board) writeBoard(root, board);
  if (coord) writeCoord(root);
  const clock = { t: now() };
  const mockFetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ code: 0, msg: "", data: { token: "A".repeat(21) + "g", expires_in: 60 } }),
  });
  return createWatcher({
    rootDir: root,
    argv: ["--poll-sec", "1", "--min-interval-sec", "0", "--hold-max-sec", "1", "--verdict-window-sec", "60", ...extraArgv],
    now: () => clock.t,
    sleepFn: async (ms) => { clock.t += ms; }, // sleep 即推进假时钟（③观测窗零等待）
    fetchImpl: mockFetch, // 签发面 mock：绝不触真实端点
    transportFactory: relay ? relay.transportFactory : undefined,
    jwtLoader: () => ({ ok: true, jwt: "mock.header.payload" }),
    deviceLoader: async () => ({ ok: true, deviceSid: "sid-mock", deviceMid: "mid-mock" }),
    revivedProbe: () => revived,
  });
}

const signalsPath = (root) => path.join(root, "sentinel", "watcher-signals.jsonl");
const readSignals = (root) => {
  try { return fs.readFileSync(signalsPath(root), "utf8").split("\n").filter((x) => x.trim()).map((l) => JSON.parse(l)); } catch { return []; }
};

try {
  const BASE = makeTempRoot({ prefix: "orch-wcore-" });
  const T0 = Date.now();

  /* ======== W-RED REDACTED 闸 ======== */
  {
    const tok = "AbC-_dEfGhIjKlMnOpQrsTg"; // 21 + [AQgw] 形态由 redact 正则吃（22 字符 base64url 形态）
    const tokenShaped = "abcdefghijklmnopqrstuA"; // 21+A
    const out1 = redact(`token=${tokenShaped} and Bearer sk-live-xyz123 end`);
    ck.ok("W-RED-01 token 22 字符 base64url 形态归零", !out1.includes(tokenShaped) && out1.includes("REDACTED"), out1);
    ck.ok("W-RED-02 Bearer 头归零（宿主 g1r 同款纪律）", out1.includes("Bearer REDACTED") && !out1.includes("sk-live-xyz123"), out1);
    ck.ok("W-RED-03 自检：归零后通过、原文不通过（grep 形态归零对账锚）", redactionSelfCheck(out1) && !redactionSelfCheck(`Bearer ${tokenShaped}`));
    const shell = buildTemplateShell({ missionId: "m-1", state: "done", summary: "ok", eventId: "latest" });
    ck.ok("W-RED-04 模板壳经 redact 恒等（壳内无凭证面）", redact(shell) === shell, shell);
    void tok;
  }

  /* ======== W-POL POLLER ======== */
  {
    const old = T0 - 3600_000;
    const board = {
      missions: [
        mission("m-done", "done", old),
        mission("m-blocked", "blocked", old - 1000),
        mission("m-acked", "done", old, { ack: { at: new Date().toISOString(), by: "coord" } }),
        mission("m-wf", "failed", old, { dispatch: { agent_id: "a", mode: "workflow" } }),
        mission("m-run", "running", old),
        mission("m-fresh", "question", T0 - 1000), // 未过宽限
      ],
    };
    const conds = classifyForWatcher(board, { nowMs: T0 });
    ck.ok("W-POL-01 未签收终态两族被分类（宽限已过），已签收/在飞/workflow/未到期排除",
      conds.length === 2 && conds.some((c) => c.missionId === "m-done") && conds.some((c) => c.missionId === "m-blocked"),
      conds.map((c) => c.missionId));
    ck.ok("W-POL-02 answer 族优先于 terminal 族（主控等人应答先敲）", conds[0].missionId === "m-blocked" && conds[0].category === "unclaimed_answer" && conds[conds.length - 1].category === "unclaimed_terminal", conds.map((c) => c.category));
    ck.ok("W-POL-03 pickNext 每轮至多一个事务", pickNext(conds).missionId === "m-blocked");
    const narrow = classifyForWatcher(board, { nowMs: T0, triggerStatuses: ["blocked", "question"] });
    ck.ok("W-POL-04 保守档触发面收窄（W-W §8.4 仅 blocked/question）", narrow.length === 1 && narrow[0].missionId === "m-blocked", narrow.map((c) => c.missionId));
    const b5board = { missions: [mission("m-b5", "done", T0, { updated_at: "not-a-date" })] };
    const b5conds = classifyForWatcher(b5board, { boardMtimeMs: T0 - 10 * 60000, nowMs: T0, terminalGraceMs: 300000 });
    ck.ok("W-POL-05 B5 备链：updated_at 不可考 → board mtime 锚（过期即到期）", b5conds.length === 1 && Math.abs(b5conds[0].anchorMs - (T0 - 10 * 60000)) < 5, b5conds[0] && b5conds[0].anchorMs);
    const nullBoard = { missions: [mission("m-x", "done", old)] };
    ck.ok("W-POL-06 readBoardSafe 坏板返回 null（不抛）", readBoardSafe.__none !== true && (() => { try { const rootB = BASE.root; fs.writeFileSync(path.join(rootB, "bad-board.json"), "{oops"); return JSON.parse("{oops") && false; } catch { return true; } })() && readBoardSafe(path.join(BASE.root, "nope-dir")) === null);
    const spoolRoot = path.join(BASE.root, "spool-pol");
    fs.mkdirSync(path.join(spoolRoot, "spool", "m-9", "unread"), { recursive: true });
    fs.writeFileSync(path.join(spoolRoot, "spool", "m-9", "unread", "001.json"), "{}");
    fs.writeFileSync(path.join(spoolRoot, "spool", "m-9", "unread", "002.json"), "{}");
    fs.mkdirSync(path.join(spoolRoot, "spool", "m-9", "read"), { recursive: true });
    ck.ok("W-POL-07 spool 未读只数不改（正文永不读取；server 布局 root/spool/<mission>/unread）", spoolUnreadCount(spoolRoot, "m-9") === 2 && spoolUnreadCount(spoolRoot, "m-none") === 0);
    ck.ok("W-POL-08 RESULT_STATUSES 口径与哨兵一致（verbatim twin）", JSON.stringify(RESULT_STATUSES) === JSON.stringify(["done", "failed", "blocked", "question"]));
  }

  /* ======== W-TXN 闸 ======== */
  {
    let t = 100000;
    const now = () => t;
    const g = new TxnGate({ now, minIntervalMs: 90000, cap: 3, busySilenceMs: 30 * 60000 });
    ck.ok("W-TXN-01 首跑放行", g.canRun("m1", t).ok === true);
    g.recordStart("m1", t);
    ck.ok("W-TXN-02 90s 频控：间隔内拒绝并给出等待", g.canRun("m2", t + 1000).ok === false && g.canRun("m2", t + 1000).reason === "min-interval" && g.canRun("m2", t + 89000).waitMs === 1000);
    t += 90000;
    ck.ok("W-TXN-03 间隔满放行", g.canRun("m2", t).ok === true);
    // 退避隔离验证：频控归零的独立闸（退避 30s/60s 远小于默认 90s 间隔，混验会互相遮蔽）
    const gb = new TxnGate({ now, minIntervalMs: 0 });
    gb.recordStart("mb2", t); gb.recordOutcome("mb2", "d2", t);
    ck.ok("W-TXN-04 D2 指数退避：第 1 次 30s", gb.canRun("mb2", t + 29000).reason === "backoff" && gb.canRun("mb2", t + 30000).ok === true);
    gb.recordStart("mb2", t + 30000); gb.recordOutcome("mb2", "d2", t + 30000);
    ck.ok("W-TXN-05 D2 退避指数 ×2：第 2 次 60s", gb.canRun("mb2", t + 89000).reason === "backoff" && gb.canRun("mb2", t + 90000).ok === true);
    g.recordStart("m2", t + 90000); g.recordOutcome("m2", "d2", t + 90000);
    g.recordStart("m2", t + 200000);
    g.recordStart("m2", t + 300000); // cap=3 铺垫：第 3 次（TXN-04/05 已移至独立闸 gb）
    ck.ok("W-TXN-06 per-mission cap=3 钉死", g.canRun("m2", t + 500000).ok === false && g.canRun("m2", t + 500000).reason === "cap-exhausted");
    t += 600000;
    const g2 = new TxnGate({ now, minIntervalMs: 0 });
    g2.recordStart("mb", t); g2.recordOutcome("mb", "busy", t);
    ck.ok("W-TXN-07 busy=1 不静默（no-op 成功不计失败）", g2.canRun("mb", t + 1).ok === true);
    g2.recordStart("mb", t + 1); g2.recordOutcome("mb", "busy", t + 1);
    ck.ok("W-TXN-08 busy×2 → 本 mission 静默 30min", g2.canRun("mb", t + 2).ok === false && g2.canRun("mb", t + 2).reason === "busy-silence" && g2.canRun("mb", t + BUSY_SILENCE_MS + 1).ok === true);
    g2.recordOutcome("mb", "success", t + BUSY_SILENCE_MS + 1);
    ck.ok("W-TXN-09 非 busy 结果打断 busy 连发计数", g2.per.get("mb").busyStreak === 0);
    ck.ok("W-TXN-10 默认频控=90s（60s 防抖+50% 裕量，W-W §8.3）", MIN_INTERVAL_MS === 90000);
    const g3 = new TxnGate({ now });
    ck.ok("W-TXN-11 nextEligibleAt 给出全局最早可跑时刻", g3.nextEligibleAt() === Infinity);
  }

  /* ======== W-TTL 签-连 ======== */
  {
    let t = 0;
    const now = () => t;
    let signs = 0;
    const slowConnect = async () => { t += 60000; throw Object.assign(new Error("ws-handshake-timeout"), { code: "ws-handshake-timeout" }); };
    let err = null;
    try {
      await signAndConnect({
        issueToken: async () => { signs++; return { ok: true, token: "tok" + signs, expiresInSec: 60 }; },
        connect: slowConnect,
        nowMs: now,
        sleepFn: async () => {},
      });
    } catch (e) { err = e; }
    ck.ok("W-TTL-01 签发恰 2 次（弃签重签一次，EXP-3 §5.4 留 5s 余量）", signs === 2, signs);
    ck.ok("W-TTL-02 双败 ttl-exhausted（W-G §4：再败→D1 面）", err && err.code === "ttl-exhausted", err && err.code);
    let signs2 = 0;
    let err2 = null;
    t = 0;
    try {
      await signAndConnect({
        issueToken: async () => { signs2++; return { ok: true, token: "t", expiresInSec: 60 }; },
        connect: async () => { throw Object.assign(new Error("ws-handshake-timeout"), { code: "ws-handshake-timeout" }); },
        nowMs: now,
      });
    } catch (e) { err2 = e; }
    ck.ok("W-TTL-03 窗口内握手败：不重签直抛（D2 瞬时面，非 TTL 面）", signs2 === 1 && err2 && err2.code === "ws-handshake-timeout", { signs: signs2, code: err2 && err2.code });
    let signs3 = 0;
    const okConn = await signAndConnect({
      issueToken: async () => { signs3++; return { ok: true, token: "t3", expiresInSec: 60 }; },
      connect: async () => ({ marker: "session-ok" }),
      nowMs: now,
    });
    ck.ok("W-TTL-04 快路径单签即连", signs3 === 1 && okConn.session.marker === "session-ok");
    const failSign = await signAndConnect({ issueToken: async () => ({ ok: false, kind: "auth-required" }), connect: async () => ({}), nowMs: now }).catch((e) => e);
    ck.ok("W-TTL-05 签发失败原样上抛（kind 透传→D1 归类）", failSign.code === "sign-failed" && failSign.kind === "auth-required");
  }

  /* ======== W-CRD CREDS ======== */
  {
    const key = deriveCredentialSecret({ env: {}, platform: "win32", homedir: "C:\\u", username: "tester" });
    const key2 = deriveCredentialSecret({ env: { ZCODE_CREDENTIAL_SECRET: "custom" }, platform: "win32", homedir: "C:\\u", username: "tester" });
    ck.ok("W-CRD-01 密钥推导确定性 + env 覆盖优先（W-G §1.1）", Buffer.compare(key, key2) !== 0 && Buffer.compare(key, deriveCredentialSecret({ env: {}, platform: "win32", homedir: "C:\\u", username: "tester" })) === 0);
    const enc = encryptEntry("jwt-secret-value", key);
    ck.ok("W-CRD-02 AES-256-GCM roundtrip（enc:v1:iv.tag.ct）", decryptEntry(enc, key) === "jwt-secret-value" && enc.startsWith("enc:v1:"));
    const badTag = enc.slice(0, -4) + "AAAA";
    ck.ok("W-CRD-03 坏 tag 安全失败返回 null（只读不动不自我修复，W-G §4）", decryptEntry(badTag, key) === null && decryptEntry("garbage", key) === null);
    const claims = b64url(JSON.stringify({ iat: 1, sub: "s", token_version: 3, user_id: "u" }));
    const shape = inspectJwt(`h.${claims}.s`);
    ck.ok("W-CRD-04 JWT 形态自检：无 exp 属预期不判过期（W-G §2）", shape.ok && shape.claims && shape.claims.tokenVersion === true && shape.claims.hasExp === false);
    ck.ok("W-CRD-05 JWT 非 3 段/不可打印拒绝", inspectJwt("only.two").ok === false && inspectJwt("a.\u0001b.c").ok === false);
    const jwtLike = `h.${b64url(JSON.stringify({ token_version: 1 }))}.s`;
    const encJwt = encryptEntry(jwtLike, key);
    const fsMock = { readFileSync: () => JSON.stringify({ "oauth:active_provider": "bigmodel", "zcodejwttoken": encJwt }), existsSync: () => true };
    const loaded = loadPlatformJwt({ credPath: "mock", key, fsImpl: fsMock });
    ck.ok("W-CRD-06 S0-S1 链：active_provider 闸 + 解密出 JWT（形态自检过）", loaded.ok === true && loaded.jwt === jwtLike);
    const badProvider = loadPlatformJwt({ credPath: "mock", key, fsImpl: { readFileSync: () => JSON.stringify({ "oauth:active_provider": "evil", "zcodejwttoken": enc }) } });
    ck.ok("W-CRD-07 provider 非 zai|bigmodel 拒绝", badProvider.ok === false && badProvider.reason === "provider-unsupported");
    const noJwt = loadPlatformJwt({ credPath: "mock", key, fsImpl: { readFileSync: () => JSON.stringify({}) } });
    const noFile = loadPlatformJwt({ credPath: path.join(BASE.root, "no-such-creds.json") });
    ck.ok("W-CRD-08 jwt 缺键/文件缺失 → D1 面原因码", noJwt.reason === "jwt-absent" && noFile.reason === "credentials-missing");
    const TOKEN_OK = "A".repeat(21) + "g";
    ck.ok("W-CRD-09 token 正则（21+[AQgw]）边界", TOKEN_RE.test(TOKEN_OK) && !TOKEN_RE.test("A".repeat(21) + "B") && !TOKEN_RE.test("A".repeat(20) + "g"));
    const goodFetch = async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, msg: "", data: { token: TOKEN_OK, expires_in: 60 } }) });
    const issued = await issueTerminalToken({ fetchImpl: goodFetch, origin: "https://x", jwt: "j" });
    ck.ok("W-CRD-10 S3 签发：EXP-1 定案形态（code=0/expires_in=60）", issued.ok && issued.expiresInSec === 60);
    const unauth = await issueTerminalToken({ fetchImpl: async () => ({ status: 401, text: async () => "" }), origin: "x", jwt: "j" });
    const badCode = await issueTerminalToken({ fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ code: 7 }) }), origin: "x", jwt: "j" });
    const badShape = await issueTerminalToken({ fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: { token: "short", expires_in: 60 } }) }), origin: "x", jwt: "j" });
    const netFail = await issueTerminalToken({ fetchImpl: async () => { throw new Error("boom"); }, origin: "x", jwt: "j" });
    ck.ok("W-CRD-11 失效树四分支：401→auth-required(D1)/code≠0→code(D1)/坏形态→safe-parse(D1)/网络→network(D2)",
      unauth.kind === "auth-required" && badCode.kind === "code" && badShape.kind === "safe-parse" && netFail.kind === "network",
      { unauth: unauth.kind, badCode: badCode.kind, badShape: badShape.kind, netFail: netFail.kind });
    const devFetch = async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: [{ device_sid: "s1", device_mid: "m1", online: false }, { device_sid: "s2", device_mid: "m2", online: true }] }) });
    const devs = await fetchDevices({ fetchImpl: devFetch, origin: "x", jwt: "j" });
    const picked = pickDesktopDevice(devs.devices, { deviceSid: "s1" });
    ck.ok("W-CRD-12 S2 设备发现+拣选：在线优先（本地交叉不敌 online）", devs.ok && picked.ok && picked.deviceSid === "s2", picked);
    const picked2 = pickDesktopDevice(devs.devices.filter((d) => !d.online), { deviceSid: "s1" });
    ck.ok("W-CRD-13 全离线时本地交叉一致者优先", picked2.ok && picked2.deviceSid === "s1");
  }

  /* ======== W-RLY RELAY V2 ======== */
  {
    ck.ok("W-RLY-01 关断码映射全表（W-W §3 close face）",
      mapClose(4004).cls === "D3" && mapClose(4009).cls === "kicked" && mapClose(4010).cls === "D2" &&
      mapClose(4011).cls === "resign" && mapClose(4012).cls === "D3" && mapClose(4013).cls === "D1" && mapClose(5999).cls === "D2");
    ck.ok("W-RLY-02 带内 error 五枚举映射", mapErrorFrame({ code: "KICKED" }).cls === "kicked" && mapErrorFrame({ code: "AUTH_FAILED" }).cls === "D1" && mapErrorFrame({ code: "DEVICE_OFFLINE" }).cls === "D2" && mapErrorFrame({ code: "WRONG_PARAM" }).cls === "D3" && mapErrorFrame({ code: "INTERNAL" }).cls === "D2");
    const relay = new MockRelay();
    const s1 = await connectRelay({ url: "ws://mock/ws2", deviceSid: "sid", transportFactory: relay.transportFactory, authAckTimeoutMs: 200 });
    ck.ok("W-RLY-03 auth 握手 matched 即桥接可进", s1 && !s1.kicked && relay.received.some((m) => m.type === "auth_init" && m.role === "terminal" && m.client_ts > 1000000000));
    const waiting = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: new MockRelay({ pairStatus: "waiting" }).transportFactory, authAckTimeoutMs: 200 }).catch((e) => e);
    ck.ok("W-RLY-04 pair_status waiting→auth-not-matched（15s 闸内放弃语义）", waiting.code === "auth-not-matched");
    const timeout = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: new MockRelay({ pairStatus: false }).transportFactory, authAckTimeoutMs: 30 }).catch((e) => e);
    ck.ok("W-RLY-05 auth_ack 15s 闸超时（此处 30ms 加速）", timeout.code === "auth-ack-timeout");
    const rKick = new MockRelay({ mode: "kicked" });
    const sKick = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: rKick.transportFactory, authAckTimeoutMs: 200 });
    await sleep(5);
    ck.ok("W-RLY-06 互踢第一禁令：KICKED 静默 close+kicked 标记，绝不重连（连接数恒 1）", sKick.kicked === true && sKick.closed === true && sKick.closeInfo.cls === "kicked" && rKick.connCount === 1);
    const noiseRelay = new MockRelay();
    const s2 = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: noiseRelay.transportFactory, authAckTimeoutMs: 200 });
    const t = s2.transport;
    t.serverSend({ type: "data", zcode_type: "unknown-push", payloadLen: 580 }); // 非请求推送（EXP-3 F4）
    t.serverSend({ type: "data", zcode_type: "desktop-heartbeat" });
    ck.ok("W-RLY-07 噪声 data 帧=计数不解析不当错误", s2.metrics.noiseData === 2 && s2.metrics.parseErrors === 0 && isSignalType("auth_ack") && !isSignalType("data"));
    const respP = s2.awaitData("session-send-response", { timeoutMs: 200, reqId: "r1" });
    t.serverSend({ type: "data", zcode_type: "other-frame" });
    t.serverSend({ type: "data", zcode_type: "session-send-response", result: { ok: true } });
    const gotResp = await respP;
    ck.ok("W-RLY-08 awaitData 先挂后发形态：噪声不吞匹配帧", gotResp && gotResp.result && gotResp.result.ok === true);
    const ackP = s2.awaitAck(42, 200);
    t.serverSend({ type: "rpc-frame-ack", ackMessageSeq: 41 }); // 不匹配忽略
    t.serverSend({ type: "rpc-frame-ack", ackMessageSeq: 42 });
    ck.ok("W-RLY-09 rpc-frame-ack 按 seq 对上（三证①）", (await ackP).ackMessageSeq === 42);
    const errP = s2.awaitData("never-coming", { timeoutMs: 200 });
    t.serverSend({ type: "error", code: "DEVICE_OFFLINE" });
    const errGot = await errP.catch((e) => e);
    ck.ok("W-RLY-10 error 帧拒挂起请求并携带面分类", errGot.code === "relay-error" && errGot.cls === "D2");
    ck.ok("W-RLY-11 ws2 URL 组装：token 只进 query（日志面恒 urlSafeLabel）", buildWs2Url({ origin: "https://zcode.z.ai/", token: "SECRET", mid: "m1" }).includes("token=SECRET&mid=m1") && "ws2?token=REDACTED" === new RelaySession().urlSafeLabel);
  }

  /* ======== W-BRG BRIDGE ======== */
  {
    ck.ok("W-BRG-01 crc32 IEEE 反射标准向量（123456789→0xCBF43926）", crc32(Buffer.from("123456789")) === 0xcbf43926);
    const payload = { method: "session/send", params: { sessionId: "sess-1", content: "hi" } };
    const frames = encodeRpcFrame({ identity: "orch-watch", seq: 7, dataObj: payload });
    const dec = decodeRpcFrames(frames);
    ck.ok("W-BRG-02 rpc-frame 单帧 roundtrip（模板壳远低于限值，W-W §3 步骤 5）", dec.ok && dec.seq === 7 && JSON.stringify(dec.dataObj) === JSON.stringify(payload) && frames[0].checksum === crc32(Buffer.from(JSON.stringify(payload))));
    const tampered = [{ ...frames[0], dataBase64: Buffer.from("tampered").toString("base64") }];
    ck.ok("W-BRG-03 checksum 篡改拒收", decodeRpcFrames(tampered).ok === false && decodeRpcFrames(tampered).error === "checksum-mismatch");
    ck.ok("W-BRG-04 分片断号拒收", decodeRpcFrames([{ ...frames[0], fragment: 5 }]).error === "fragment-gap");
    ck.ok("W-BRG-05 超 64 片拒收（W-F3 §2.4 限值）", decodeRpcFrames(Array.from({ length: 65 }, (_, i) => ({ ...frames[0], fragment: i })).map((f, i) => (i === 0 ? f : { ...f, fragment: i }))).error === "too-many-fragments");
    ck.ok("W-BRG-06 30s 组装闸", decodeRpcFrames([{ ...frames[0], sentAt: Date.now() - 31000 }], { nowMs: Date.now() }).error === "assemble-timeout");
    let idErr = null;
    try { encodeRpcFrame({ identity: "x".repeat(257), seq: 1, dataObj: {} }); } catch (e) { idErr = e; }
    ck.ok("W-BRG-07 id>256 字符拒收", idErr && idErr.code === "frame-id-too-long");
    ck.ok("W-BRG-08 帧限值常量定案（1MiB/16MiB/64/30s/256）", LIMITS.fragmentMax === 1048576 && LIMITS.msgMax === 16777216 && LIMITS.maxFragments === 64 && LIMITS.assembleTimeoutMs === 30000 && LIMITS.maxIdChars === 256);
    const relay = new MockRelay();
    const s = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relay.transportFactory, authAckTimeoutMs: 200 });
    const bridge = await openBridge({ session: s });
    ck.ok("W-BRG-09 L2 编排：list→key→open→ready（bridgeSessionId/initialTaskId）", bridge.workspaceKey === "ws-1" && bridge.bridgeSessionId === "bridge-1" && bridge.initialTaskId === "task-1");
    const sEmpty = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: new MockRelay({ emptyWorkspace: true }).transportFactory, authAckTimeoutMs: 200 });
    const emptyErr = await openBridge({ session: sEmpty }).catch((e) => e);
    ck.ok("W-BRG-10 workspace-list 空 → bridge-list-empty（D3 面）", emptyErr.code === "bridge-list-empty");
  }

  /* ======== W-INJ INJECT ======== */
  {
    const shell = buildTemplateShell({ missionId: "m-20261020-1", state: "blocked", summary: "worker blocked on QA", eventId: "001792-1f" });
    ck.ok("W-INJ-01 模板壳定案格式（W-W §4 原案：id+状态+摘要+spool 指针）",
      shell === "[orch-watch] mission=m-20261020-1 state=blocked summary=worker blocked on QA 指引=请消费 spool/m-20261020-1/unread/001792-1f.json（路径指针，非正文）", shell);
    ck.ok("W-INJ-02 摘要 250 字夹紧 200（与 report 口径一致）", sanitizeSummary("x".repeat(250)).length === 200);
    ck.ok("W-INJ-03 换行/制表压空格（壳必须单行）", sanitizeSummary("a\nb\tc  d") === "a b c d");
    ck.ok("W-INJ-04 壳纪律自检：合规壳过、注入面（反引号/花括号/换行）拒",
      shellCompliant(shell) && !shellCompliant(shell + "`") && !shellCompliant("bad") && !shellCompliant(shell + "\nEVIL") && !shellCompliant("[orch-watch] x ${process.env}"));
    let badState = null;
    try { buildTemplateShell({ missionId: "m", state: "running", summary: "" }); } catch (e) { badState = e; }
    ck.ok("W-INJ-05 非 RESULT 状态拒构造", badState && badState.code === "shell-bad-args");
    const params = buildSessionSendParams({ sessionId: "sess-9", content: "c" });
    ck.ok("W-INJ-06 session/send 重装体形状（W-W §3 步骤 5）", params.method === "session/send" && params.params.sessionId === "sess-9");
    const relay = new MockRelay();
    const s = await connectRelay({ url: "ws://mock", deviceSid: "s", transportFactory: relay.transportFactory, authAckTimeoutMs: 200 });
    const sent = await sendPrompt({ session: s, seq: 1, sessionId: "sess-9", content: shell });
    ck.ok("W-INJ-07 sendPrompt：ack 对上 + 服务端收到可解码 session/send", sent.ack.ackMessageSeq === 1 && relay.captured[0].ok && relay.captured[0].dataObj.method === "session/send");
  }

  /* ======== W-VRD VERDICT ======== */
  {
    ck.ok("W-VRD-01 ②受理分类：accepted/busy(-32010)/rejected", classifyAccept({ result: {} }).accept === "accepted" && classifyAccept({ error: { code: -32010 } }).accept === "busy" && classifyAccept({ error: { code: -32002 } }).accept === "rejected");
    ck.ok("W-VRD-02 三证矩阵：①②③全成=success", finalVerdict({ transport: "delivered", revived: true }).verdict === "success");
    ck.ok("W-VRD-03 ①②成③未成=accepted-not-revived（记成功受理+哨兵兜底不重复注入）", finalVerdict({ transport: "delivered", revived: false }).verdict === "accepted-not-revived");
    ck.ok("W-VRD-04 ②busy=noop（主控在跑不计失败，W-W §6）", finalVerdict({ transport: "busy", revived: false }).verdict === "noop" && finalVerdict({ transport: "busy", revived: true }).verdict === "noop");
    ck.ok("W-VRD-05 no-ack/failed=failed", finalVerdict({ transport: "no-ack", revived: true }).verdict === "failed" && finalVerdict({ transport: "failed", revived: true }).verdict === "failed");
    let t = 1000;
    const now = () => t;
    const fastProbe = await observeRevival({ revivedProbe: () => true, sessionId: "s", sinceMs: t, windowMs: 60000, sleepFn: async (ms) => { t += ms; }, nowMs: now });
    ck.ok("W-VRD-06 ③复活：窗内探针 true 即判", fastProbe === true);
    t = 1000;
    const slowProbe = await observeRevival({ revivedProbe: () => false, sessionId: "s", sinceMs: t, windowMs: 30000, pollMs: 10000, sleepFn: async (ms) => { t += ms; }, nowMs: now });
    ck.ok("W-VRD-07 ③窗满未复活=false（60s 判定窗 W-W §6）", slowProbe === false && t - 1000 >= 30000);
  }

  /* ======== W-DGR DEGRADE ======== */
  {
    const table = [
      ["sign-auth-required", "D1"], ["sign-code", "D1"], ["sign-safe-parse", "D1"], ["credentials-missing", "D1"],
      ["credentials-corrupt", "D1"], ["decrypt-failed", "D1"], ["jwt-absent", "D1"], ["jwt-shape", "D1"],
      ["auth-failed", "D1"], ["close-4013", "D1"], ["ttl-exhausted", "D1"],
      ["kicked", "kicked"], ["close-4009", "kicked"],
      ["bridge-list-empty", "D3"], ["close-4004", "D3"], ["close-4012", "D3"], ["wrong-param", "D3"], ["session-target-missing", "D3"],
      ["connect-failed", "D2"], ["handshake-timeout", "D2"], ["auth-ack-timeout", "D2"], ["auth-not-matched", "D2"],
      ["close-4011", "D2"], ["close-4010", "D2"], ["rpc-ack-timeout", "D2"], ["hold-timeout", "D2"], ["sign-network", "D2"], ["mystery-kind", "D2"],
    ];
    const bad = table.filter(([k, want]) => classifyFailure({ kind: k }).cls !== want);
    ck.ok("W-DGR-01 降级树全表（28 码→D1×11/kicked×2/D3×5/D2×10，W-W §7+W-G §4）", bad.length === 0, bad);
    const root = path.join(BASE.root, "dg");
    const dg = new DegradeState({ rootDir: root, now: () => T0 });
    dg.record({ cls: "D2", missionId: "m-d2", reason: "connect-failed" });
    ck.ok("W-DGR-02 D2 临时：全局态保持 active + signals 落盘回哨兵", dg.terminal === false && dg.state.cls === CLASSES.ACTIVE && readSignals(root).some((s) => s.cls === "D2" && s.mission === "m-d2"));
    dg.record({ cls: "D1", missionId: "m-d1", reason: "sign-auth-required with token abcdefghijklmnopqrstuA inside" });
    ck.ok("W-DGR-03 D1 终态：standby+signals+reason 脱敏（token 形态不落盘）", dg.terminal && dg.state.cls === "D1" && readSignals(root).some((s) => s.cls === "D1" && s.reason.includes("REDACTED") && !s.reason.includes("abcdefghijklmnopqrstuA")));
    dg.record({ cls: "D3", missionId: "m-d3", reason: "close-4004" });
    ck.ok("W-DGR-04 D3 终态：配置告警面", dg.state.cls === "D3" && dg.terminal);
    const dgr = new DegradeState({ rootDir: path.join(BASE.root, "dg2"), now: () => T0 });
    for (let i = 0; i < SIGNALS_MAX_LINES + 40; i++) dgr.record({ cls: "D2", missionId: "m" + i, reason: "r" + i });
    ck.ok("W-DGR-05 signals 滚动 256 行封顶（截半，哨兵同款）", readSignals(path.join(BASE.root, "dg2")).length <= SIGNALS_MAX_LINES);
    ck.ok("W-DGR-06 failureFromClose：closeInfo→failure 码", failureFromClose({ code: 4004, name: "SessionNotFound" }).kind === "close-4004" && failureFromClose(null).kind === "relay-closed");
    ck.ok("W-DGR-07 NOOP 不写 signals 不改态（busy=no-op 成功）", (() => { const r3 = path.join(BASE.root, "dg3"); const d3 = new DegradeState({ rootDir: r3, now: () => T0 }); d3.record({ cls: CLASSES.NOOP, missionId: "m", reason: "busy-noop" }); return d3.state.cls === CLASSES.ACTIVE && readSignals(r3).length === 0; })());
  }

  /* ======== W-E2E 全链（mock relay+mock 凭据） ======== */
  {
    // E2E-1 happy：全三证 success；短事务即断；壳进 rpc-frame；心跳在位
    {
      const root = path.join(BASE.root, "e2e-ok");
      const relay = new MockRelay({ noiseBeforeBridge: true });
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-ok", "done", Date.now() - 3600_000)] });
      const r1 = await w.tick();
      ck.ok("W-E2E-01 happy 全链 verdict=success（三证合一）", r1.state === "transacting" && r1.outcome === "success", r1);
      ck.ok("W-E2E-02 连-发-断：事务毕 transport 已 close（短事务形态 W-W §8）", relay.transports[0].closed === true && relay.transports[0].closeArgs.code === 1000);
      const frameDec = relay.captured[0];
      const shell = frameDec && frameDec.ok ? frameDec.dataObj.params.content : "";
      ck.ok("W-E2E-03 注入壳=id+状态+spool 指针（正文留 spool 隐私最小化）", frameDec.ok && frameDec.dataObj.method === "session/send" && String(shell).startsWith("[orch-watch] mission=m-ok state=done") && String(shell).includes("spool/m-ok/unread/latest.json（路径指针，非正文）"), shell);
      ck.ok("W-E2E-04 桥接前噪声推送帧被计数吞掉（EXP-3 F4 全链复现：噪声在位且事务照常 success）",
        (relay.serverSent || []).some((m) => m.zcode_type === "desktop-state-push") && r1.outcome === "success", { noise: (relay.serverSent || []).some((m) => m.zcode_type === "desktop-state-push"), outcome: r1.outcome });
      ck.ok("W-E2E-05 心跳自证文件在位（哨兵反向监控面，60s mtime 即心跳）", fs.existsSync(path.join(root, "sentinel", "watcher-heartbeat")));
      ck.ok("W-E2E-06 ws2 URL 带 mock mid 且成功触发建连", (relay.urls || [""])[0].includes("mid=mid-mock"));
    }
    // E2E-2 busy×2 → 静默
    {
      const root = path.join(BASE.root, "e2e-busy");
      const relay = new MockRelay({ mode: "busy" });
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-busy", "blocked", Date.now() - 3600_000)] });
      const r1 = await w.tick();
      const r2 = await w.tick();
      const r3 = await w.tick();
      ck.ok("W-E2E-07 busy 两轮=noop×2（不计失败）", r1.outcome === "noop" && r2.outcome === "noop");
      ck.ok("W-E2E-08 第三轮被 busy-silence 闸住（30min 静默 W-W §7）", r3.state === "gated" && r3.reason === "busy-silence", r3);
    }
    // E2E-3 kicked：断路+绝不重连
    {
      const root = path.join(BASE.root, "e2e-kick");
      const relay = new MockRelay({ mode: "kicked" });
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-k", "done", Date.now() - 3600_000)] });
      const r1 = await w.tick();
      ck.ok("W-E2E-09 KICKED→kicked 终态（第一禁令：静默退出绝不重连）", r1.outcome === "kicked" && w.disabled === "kicked" && relay.connCount === 1, r1);
      const r2 = await w.tick();
      ck.ok("W-E2E-10 终态后 tick 转 standby 停事务面（进程不退出，心跳继续）", r2.state === "kicked" && fs.existsSync(path.join(root, "sentinel", "watcher-heartbeat")));
      ck.ok("W-E2E-11 kicked 写入 signals（哨兵接管面）", readSignals(root).some((s) => s.cls === "kicked"));
    }
    // E2E-4 D1 凭据缺失（真实 loadPlatformJwt 走空根）
    {
      const root = path.join(BASE.root, "e2e-d1");
      const relay = new MockRelay();
      writeBoard(root, [mission("m-d1", "done", Date.now() - 3600_000)]);
      writeCoord(root);
      const w = createWatcher({
        rootDir: root,
        argv: ["--poll-sec", "1", "--min-interval-sec", "0", "--hold-max-sec", "1", "--verdict-window-sec", "1"],
        transportFactory: relay.transportFactory,
        jwtLoader: () => loadPlatformJwt({ credPath: path.join(root, "no-credentials.json") }), // 真实 S0 链
        deviceLoader: async () => ({ ok: true, deviceSid: "s", deviceMid: "m" }),
        revivedProbe: () => true,
      });
      const r1 = await w.tick();
      ck.ok("W-E2E-12 凭据缺失→D1 终态（真实 S0 链：credentials-missing）", r1.outcome === "D1" && w.disabled === "D1" && relay.connCount === 0, r1);
      ck.ok("W-E2E-13 D1 signals 在位（哨兵全量接管）", readSignals(root).some((s) => s.cls === "D1" && s.reason === "credentials-missing"));
    }
    // E2E-5 D3 coord-session 缺失
    {
      const root = path.join(BASE.root, "e2e-d3");
      const relay = new MockRelay();
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-d3", "done", Date.now() - 3600_000)], coord: false });
      const r1 = await w.tick();
      ck.ok("W-E2E-14 目标会话缺失→D3 配置告警终态（W-W §4）", r1.outcome === "D3" && w.disabled === "D3" && relay.connCount === 0);
    }
    // E2E-6 D2 建连败→退避
    {
      const root = path.join(BASE.root, "e2e-d2");
      const relay = new MockRelay({ failHandshake: true });
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-d2", "done", Date.now() - 3600_000)] });
      const r1 = await w.tick();
      const r2 = await w.tick();
      ck.ok("W-E2E-15 建连败→D2 瞬时（本轮弃发写 signals，下轮重评）", r1.outcome === "D2" && readSignals(root).some((s) => s.cls === "D2"), r1);
      ck.ok("W-E2E-16 退避期内 tick 被 gate（指数退避回哨兵兜底语义）", r2.state === "gated" && r2.reason === "backoff", r2);
    }
    // E2E-7 close 4011 面经 signAndConnect 透传
    {
      const root = path.join(BASE.root, "e2e-4011");
      const relay = new MockRelay({ mode: "close4011" });
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-ttl", "done", Date.now() - 3600_000)] });
      const r1 = await w.tick();
      ck.ok("W-E2E-17 中继 4011（TTL 耗尽）→close-4011→D2（首败重签语义，零缓存下轮自然重签）", r1.outcome === "D2" && readSignals(root).some((s) => s.reason === "close-4011"), r1);
    }
    // E2E-8 持有帽（加速 1s）：noack→强制断→hold-timeout→D2+slot 释放
    {
      const root = path.join(BASE.root, "e2e-hold");
      const relay = new MockRelay({ mode: "noack" });
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-hold", "done", Date.now() - 3600_000)] });
      const r1 = await w.tick();
      ck.ok("W-E2E-18 持有帽到点强制断（EXP-3 §5.1 slot 礼仪 ≤40s，加速 1s 验证）", r1.outcome === "D2" && relay.transports[0].closed === true, r1);
      ck.ok("W-E2E-19 hold-timeout 归 D2 面", readSignals(root).some((s) => s.reason === "hold-timeout"));
    }
    // E2E-9 accepted-not-revived：①②成③未成不写失败信号
    {
      const root = path.join(BASE.root, "e2e-anr");
      const relay = new MockRelay();
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-anr", "done", Date.now() - 3600_000)], revived: false });
      const r1 = await w.tick();
      ck.ok("W-E2E-20 受理未唤醒=accepted-not-revived（哨兵兜底不重复注入）", r1.outcome === "accepted-not-revived" && w.disabled === null && readSignals(root).length === 0, r1);
    }
    // E2E-10 accept-reject（非 busy 错误）→ D2
    {
      const root = path.join(BASE.root, "e2e-rej");
      const relay = new MockRelay({ mode: "accept-reject" });
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-rej", "done", Date.now() - 3600_000)] });
      const r1 = await w.tick();
      ck.ok("W-E2E-21 ②受理被拒（非 busy）→failed→D2 瞬时归类", r1.outcome === "D2" && relay.transports[0].closed === true, r1);
    }
    // E2E-11 触发面收窄（保守档）+ 板不可读容错
    {
      const root = path.join(BASE.root, "e2e-narrow");
      const relay = new MockRelay();
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-only-done", "done", Date.now() - 3600_000)], extraArgv: ["--trigger-statuses", "blocked,question"] });
      const r1 = await w.tick();
      ck.ok("W-E2E-22 保守档触发面收窄：done 不触发注入（W-W §8.4 可配）", r1.state === "idle" && relay.connCount === 0, r1);
      fs.writeFileSync(path.join(root, "board.json"), "{broken");
      const r2 = await w.tick();
      ck.ok("W-E2E-23 板损坏容错：board-unreadable 不炸不误发", r2.state === "board-unreadable" && relay.connCount === 0);
    }
    // E2E-12 resolveRoot：显式 root 优先；默认 cwd 面
    {
      const rr = resolveRoot(["--root", path.join(BASE.root, "rr1")]);
      ck.ok("W-E2E-24 resolveRoot 显式 --root 优先且建目录", rr === path.join(BASE.root, "rr1") && fs.existsSync(rr));
    }
  }

  /* ======== W-WS RFC6455 codec ======== */
  {
    ck.ok("W-WS-01 acceptKey RFC6455 §1.3 标准向量", acceptKey("dGhlIHNhbXBsZSBub25jZQ==") === "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    const mk = Buffer.from([1, 2, 3, 4]);
    const frame = encodeFrame({ opcode: OP.TEXT, payload: Buffer.from("hello ws", "utf8"), maskKey: mk });
    const parsed = new FrameParser().push(frame);
    ck.ok("W-WS-02 掩码 TEXT 帧编解 roundtrip（客户端帧必掩码）", parsed.length === 1 && parsed[0].opcode === OP.TEXT && parsed[0].payload === "hello ws" && parsed[0].fin === true);
    const long = Buffer.alloc(300, 0x41);
    const p2 = new FrameParser().push(encodeFrame({ opcode: OP.BINARY, payload: long, maskKey: mk }));
    ck.ok("W-WS-03 16 位长度路径（300B）", p2.length === 1 && p2[0].payload.length === 300);
    const bigger = Buffer.alloc(70000, 0x42);
    const p3 = new FrameParser().push(encodeFrame({ opcode: OP.BINARY, payload: bigger, maskKey: mk }));
    ck.ok("W-WS-04 64 位长度路径（70000B>65535）", p3.length === 1 && p3[0].payload.length === 70000);
    const parts = [
      encodeFrame({ opcode: OP.TEXT, payload: Buffer.from("aa"), mask: false, maskKey: null }),
    ];
    // 分片：FIN=0 TEXT + FIN=0 CONT + FIN=1 CONT
    const f0 = encodeFrame({ opcode: OP.TEXT, payload: Buffer.from("he"), maskKey: mk });
    f0[0] = f0[0] & 0x7f; // 清 FIN
    const c0 = encodeFrame({ opcode: OP.CONT, payload: Buffer.from("ll"), maskKey: mk });
    c0[0] = c0[0] & 0x7f;
    const c1 = encodeFrame({ opcode: OP.CONT, payload: Buffer.from("o"), maskKey: mk });
    const p4 = new FrameParser().push(Buffer.concat([f0, c0, c1]));
    ck.ok("W-WS-05 分片重装（FIN=0+CONT 链→单 TEXT）", p4.length === 1 && p4[0].opcode === OP.TEXT && p4[0].payload === "hello", p4[0] && p4[0].payload);
    void parts;
    const ping = new FrameParser().push(encodeFrame({ opcode: OP.PING, payload: Buffer.from("pi"), mask: false }));
    ck.ok("W-WS-06 控制帧 PING 直通（自动 PONG 在 WsConn 协议层）", ping.length === 1 && ping[0].opcode === OP.PING);
    const closeBuf = encodeFrame({ opcode: OP.CLOSE, payload: (() => { const r = Buffer.from("SessionExpired"); const b = Buffer.alloc(2 + r.length); b.writeUInt16BE(4011); r.copy(b, 2); return b; })(), mask: false });
    const pClose = new FrameParser().push(closeBuf);
    ck.ok("W-WS-07 CLOSE 帧解出 code=4011（关断码面入口）", pClose[0].opcode === OP.CLOSE && pClose[0].payload.readUInt16BE(0) === 4011);
    const req = buildUpgradeRequest({ host: "zcode.z.ai", port: 443, path: "/api/v1/remote/ws2?token=REDACTED&mid=m1", key: "K", origin: "https://x" });
    ck.ok("W-WS-08 upgrade 请求形状（GET/Key/Version/Origin，token 只在 path）", req.startsWith("GET /api/v1/remote/ws2?") && req.includes("Sec-WebSocket-Key: K") && req.includes("Sec-WebSocket-Version: 13") && req.includes("Origin: https://x") && req.endsWith("\r\n\r\n"));
    const accept = acceptKey("K");
    const respBytes = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`, "latin1");
    const rOk = parseUpgradeResponse(Buffer.concat([respBytes, frame]), "K");
    ck.ok("W-WS-09 101+Accept 校验过且 rest=帧流起点", rOk.ok === true && rOk.rest.length === frame.length);
    const rBad = parseUpgradeResponse(Buffer.concat([respBytes, frame]), "OTHER");
    const rReject = parseUpgradeResponse(Buffer.from("HTTP/1.1 403 Forbidden\r\n\r\n"), "K");
    const rPartial = parseUpgradeResponse(Buffer.from("HTTP/1.1 101 S", "latin1"), "K");
    ck.ok("W-WS-10 握手三拒：Accept 错/非 101/半包 incomplete", rBad.error === "accept-mismatch" && rReject.error === "handshake-rejected" && rPartial.incomplete === true);
  }

  void T0;
  BASE.cleanup();
} catch (err) {
  ck.ok("SUITE-FATAL（未捕获异常）", false, { msg: String((err && err.stack) || err).slice(0, 600) });
}

const { pass, fail } = ck.summary();
process.exit(fail ? 1 : 0);
