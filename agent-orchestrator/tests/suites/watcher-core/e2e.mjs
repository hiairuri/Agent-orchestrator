// @module suites/watcher-core/e2e
/*!
 * watcher-core/e2e.mjs —— W-E2E 全链（mock relay+mock 凭据）：success/noop-busy×2 静默/
 * kicked 断路/D1 凭据缺失/D3 coord-session 缺失/D2 建连败退避/hold-cap 加速面等 24 断言。
 * 拆分自 suites/watcher-core.mjs；断言本体零改动。
 */
import fs from "node:fs";
import path from "node:path";
import { ck } from "./shared.mjs";
import { MockRelay } from "./mock-relay.mjs";
import { writeBoard, writeCoord, mission, buildWatcher, readSignals } from "./fixtures.mjs";
import { createWatcher, resolveRoot } from "../../../watcher/watcher.mjs";
import { loadPlatformJwt } from "../../../watcher/credentials.mjs";

export async function run(ctx) {
  const { BASE } = ctx;

  /* ======== W-E2E 全链（mock relay+mock 凭据） ======== */
  {
    // E2E-1 happy：全三证 success；短事务即断；壳进 rpc-frame；心跳在位
    {
      const root = path.join(BASE.root, "e2e-ok");
      const relay = new MockRelay({ noiseBeforeBridge: true });
      // v1.1 W2 (C3-rider)：事件解析上移调用面后，生产壳取真实最新未读事件 id——预置一条
      // 未读事件（文件名=<15 位 epochMs>-<8hex>.json），W-E2E-03 锁「不再恒写 latest」。
      const e2eEventId = "000000000000001-abcdef12";
      fs.mkdirSync(path.join(root, "spool", "m-ok", "unread"), { recursive: true });
      fs.writeFileSync(path.join(root, "spool", "m-ok", "unread", e2eEventId + ".json"), "{}\n");
      const w = buildWatcher({ root, relay, now: () => Date.now(), board: [mission("m-ok", "done", Date.now() - 3600_000)] });
      const r1 = await w.tick();
      ck.ok("W-E2E-01 happy 全链 verdict=success（三证合一）", r1.state === "transacting" && r1.outcome === "success", r1);
      ck.ok("W-E2E-02 连-发-断：事务毕 transport 已 close（短事务形态 W-W §8）", relay.transports[0].closed === true && relay.transports[0].closeArgs.code === 1000);
      const frameDec = relay.captured.find((c) => c.header && c.header[3] === "sendConversationCommandV4"); // W3s：G8 握手两帧先于命令，命令帧按方法名寻址
      const frameArgs = frameDec && Array.isArray(frameDec.body) && frameDec.body.length === 1 ? frameDec.body[0] : null; // G9：位置参数组
      const shellText = frameArgs && frameArgs.envelope ? frameArgs.envelope.payload.text : "";
      ck.ok("W-E2E-03 注入壳=id+状态+spool 指针（正文留 spool 隐私最小化；内层=VQL 频道调用 [100,id,zcode-agent,sendConversationCommandV4]，sessionId=coord 目标；L4 W3r payload 直传；W3s 基线修订：命令帧前置 G8 握手两帧按方法名寻址；G3 基线修订：命令 body=位置参数组 [params]；v1.1 W2 rider 修订：指针=latestUnreadEventId 解析的真实事件 id，不再恒写 latest）",
        frameDec && Array.isArray(frameDec.header) && frameDec.header[0] === 100 && frameDec.header[2] === "zcode-agent" &&
        frameDec.header[3] === "sendConversationCommandV4" && Array.isArray(frameDec.body) && frameArgs.envelope.sessionId === "sess-coord-test" &&
        String(shellText).startsWith("[orch-watch] mission=m-ok state=done") && String(shellText).includes(`spool/m-ok/unread/${e2eEventId}.json（路径指针，非正文）`), shellText);
      ck.ok("W-E2E-04 桥接前噪声推送帧被计数吞掉（EXP-3 F4 全链复现：新形 payload 噪声在位且事务照常 success）",
        (relay.serverSent || []).some((m) => m.payload && m.payload.zcode_type === "desktop-state-push") && r1.outcome === "success", { noise: (relay.serverSent || []).some((m) => m.payload && m.payload.zcode_type === "desktop-state-push"), outcome: r1.outcome });
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
}
