// @module suites/watcher-core/units
/*!
 * watcher-core/units.mjs —— 单元面：W-RED REDACTED 闸 / W-POL POLLER 分类 / W-TXN TXN 闸 /
 * W-TTL 签-连 / W-CRD CREDS。拆分自 suites/watcher-core.mjs；断言本体零改动。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, b64url } from "./shared.mjs";
import { mission } from "./fixtures.mjs";
import { redact, redactionSelfCheck, deriveCredentialSecret, encryptEntry, decryptEntry, inspectJwt, loadPlatformJwt, pickDesktopDevice, issueTerminalToken, fetchDevices, TOKEN_RE } from "../../../watcher/credentials.mjs";
import { classifyForWatcher, pickNext, readBoardSafe, spoolUnreadCount, latestUnreadEventId, truncateTitleClosed, RESULT_STATUSES } from "../../../watcher/poller.mjs";
import { TxnGate, signAndConnect, MIN_INTERVAL_MS, BUSY_SILENCE_MS } from "../../../watcher/txn.mjs";
import { buildTemplateShell } from "../../../watcher/inject.mjs";

export async function run(ctx) {
  const { BASE, T0 } = ctx;

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
    // v1.1 W1（C3）：title 截断闭合化——30 码点安全（代理对不切破）+未闭合括号剥离（R5-4）
    ck.ok("W-POL-09 title 截断码点安全（Array.from 取 30 码点：40 emoji→恰 30 码点，不切破代理对）",
      truncateTitleClosed("😀".repeat(40)) === "😀".repeat(30) && Array.from(truncateTitleClosed("😀".repeat(40))).length === 30,
      Array.from(truncateTitleClosed("😀".repeat(40))).length);
    const titleConds = classifyForWatcher(
      { missions: [mission("m-title", "blocked", old, { title: "前置说明（direct 后续超长内容需要截断更多字符" })] },
      { nowMs: T0 },
    );
    ck.ok("W-POL-10 title 未闭合括号闭合化（R5-4「（direct」：最早未闭合开括号起截、闭合对保留、全括号兜底「(未命名)」）",
      titleConds.length === 1 && titleConds[0].title === "前置说明" &&
        truncateTitleClosed("A（B）C（D") === "A（B）C" &&
        truncateTitleClosed("（direct") === "" &&
        classifyForWatcher({ missions: [mission("m-title2", "done", old, { title: "（direct" })] }, { nowMs: T0 })[0].title === "(未命名)",
      titleConds[0] && titleConds[0].title);
    // v1.1 W1（C3）：事件解析上移调用面——真实最新 eventId（文件名零填充 epochMs 降序，正文不读）
    const spoolLatest = path.join(BASE.root, "spool-latest");
    fs.mkdirSync(path.join(spoolLatest, "spool", "m-10", "unread"), { recursive: true });
    fs.writeFileSync(path.join(spoolLatest, "spool", "m-10", "unread", "000000000000001-aaaaaaaa.json"), "{not-json（正文不读）");
    fs.writeFileSync(path.join(spoolLatest, "spool", "m-10", "unread", "000000000000002-bbbbbbbb.json"), "{}");
    ck.ok("W-POL-11 latestUnreadEventId 取真实最新事件 id（文件名降序；正文不读；无未读/目录缺失→null）",
      latestUnreadEventId(spoolLatest, "m-10") === "000000000000002-bbbbbbbb" &&
        latestUnreadEventId(spoolLatest, "m-none") === null,
      latestUnreadEventId(spoolLatest, "m-10"));
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
}
