// @module suites/watcher-core/transport-ws
/*!
 * watcher-core/transport-ws.mjs —— 传输层：W-TRN/W-DGR2 transport 层（cloud|loopback 切换 +
 * D2 双 env 提示）/ W-WS RFC6455 codec。拆分自 suites/watcher-core.mjs；断言本体零改动。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, grp } from "./shared.mjs";
import { MockRelay } from "./mock-relay.mjs";
import { writeBoard, writeCoord, mission, readSignals } from "./fixtures.mjs";
import { createWatcher } from "../../../watcher/watcher.mjs";
import { DegradeState, CLASSES, loopbackD2Hint } from "../../../watcher/degrade.mjs";
import { encodeFrame, FrameParser, acceptKey, buildUpgradeRequest, parseUpgradeResponse, OP } from "../../../watcher/ws.mjs";

export async function run(ctx) {
  const { BASE } = ctx;

  /* ======== W-TRN/W-DGR2 transport 层（v0.10 W2：cloud|loopback 切换 + D2 双 env 提示） ======== */
  {
    grp("W-TRN transport");
    /* 记账 mock fetch：按 URL 返回 device/token 同构形状（shim 与 cloud 零协议分支，同函数同形状）。 */
    const makeRecFetch = () => {
      const rec = { urls: [], methods: [] };
      const fn = async (url, opts) => {
        rec.urls.push(String(url));
        rec.methods.push((opts && opts.method) || "GET");
        const body = String(url).indexOf("/remote/token") >= 0
          ? { code: 0, msg: "", data: { token: "A".repeat(21) + "g", expires_in: 60 } }
          : { code: 0, msg: "", data: [{ device_sid: "sid-shim", device_mid: "mid-shim", online: true, meta: {} }] };
        return { status: 200, text: async () => JSON.stringify(body) };
      };
      fn.rec = rec;
      return fn;
    };
    /* W-TRN-01a loopback 切换：端点/token 落 loopbackOrigin + JWT 跳过（S0 免，零出站）。 */
    {
      const root = path.join(BASE.root, "trn-lb");
      const relay = new MockRelay();
      const f = makeRecFetch();
      let jwtCalls = 0;
      writeBoard(root, [mission("m-lb", "done", Date.now() - 3600_000)]);
      writeCoord(root);
      const w = createWatcher({
        rootDir: root,
        argv: ["--poll-sec", "1", "--min-interval-sec", "0", "--hold-max-sec", "1", "--verdict-window-sec", "60",
          "--transport", "loopback", "--loopback-origin", "http://127.0.0.1:7897"],
        now: () => Date.now(),
        sleepFn: async () => {},
        fetchImpl: f,
        transportFactory: relay.transportFactory,
        jwtLoader: () => { jwtCalls++; return { ok: true, jwt: "must-not-load" }; },
        revivedProbe: () => true,
      });
      const r1 = await w.tick();
      ck.ok("W-TRN-01a loopback 切换：device/token 端点全落 loopbackOrigin 且 JWT 跳过（S0 免，零出站）",
        f.rec.urls.length === 2 && f.rec.urls[0].indexOf("http://127.0.0.1:7897/api/v1/remote/device") === 0 &&
        f.rec.urls[1].indexOf("http://127.0.0.1:7897/api/v1/remote/token") === 0 && jwtCalls === 0, { urls: f.rec.urls, jwtCalls });
      ck.ok("W-TRN-01b loopback ws URL 取 loopbackOrigin（buildWs2Url 零改动，http→ws 闸）",
        (relay.urls[0] || "").indexOf("ws://127.0.0.1:7897/api/v1/remote/ws2?") === 0 && (relay.urls[0] || "").indexOf("mid=mid-shim") >= 0, relay.urls);
      ck.ok("W-TRN-01c 零协议分支：loopback 全链事务 success（同函数同形状，relay.mjs/credentials.mjs 零改动复用）",
        r1.outcome === "success", r1);
    }
    /* W-TRN-01d cloud 缺省逐字节锁（CR-04）。 */
    {
      const root = path.join(BASE.root, "trn-cloud");
      const relay = new MockRelay();
      const f = makeRecFetch();
      let jwtCalls = 0;
      writeBoard(root, [mission("m-cloud", "done", Date.now() - 3600_000)]);
      writeCoord(root);
      const w = createWatcher({
        rootDir: root,
        argv: ["--poll-sec", "1", "--min-interval-sec", "0", "--hold-max-sec", "1", "--verdict-window-sec", "60"],
        now: () => Date.now(),
        sleepFn: async () => {},
        fetchImpl: f,
        transportFactory: relay.transportFactory,
        jwtLoader: () => { jwtCalls++; return { ok: true, jwt: "mock.header.payload" }; },
        revivedProbe: () => true,
      });
      const r1 = await w.tick();
      ck.ok("W-TRN-01d cloud 缺省逐字节锁（CR-04）：端点与 ws URL 全落缺省 origin 且 JWT 恰一次",
        f.rec.urls.length === 2 && f.rec.urls[0].indexOf("https://zcode.z.ai/api/v1/remote/device") === 0 &&
        f.rec.urls[1].indexOf("https://zcode.z.ai/api/v1/remote/token") === 0 &&
        (relay.urls[0] || "").indexOf("wss://zcode.z.ai/api/v1/remote/ws2?") === 0 && jwtCalls === 1 && r1.outcome === "success",
        { urls: f.rec.urls, ws: relay.urls, jwtCalls, outcome: r1.outcome });
    }
    /* W-TRN-01e cfg 三键落位（snake/camel 双拼等效 + port 派生 + CLI>cfg + 缺省=cloud）。 */
    {
      const mkRoot = (name, cfgObj) => {
        const r = path.join(BASE.root, name);
        fs.mkdirSync(r, { recursive: true });
        if (cfgObj) fs.writeFileSync(path.join(r, "watcher.cfg.json"), JSON.stringify(cfgObj));
        return r;
      };
      const wa = createWatcher({ rootDir: mkRoot("trn-cfg-snake", { transport: "loopback", loopback_origin: "http://127.0.0.1:7901/" }), argv: [], fsImpl: fs });
      const rb = mkRoot("trn-cfg-camel", { transport: "loopback", loopbackOrigin: "http://localhost:7902", loopbackPort: 7903 });
      const wb = createWatcher({ rootDir: rb, argv: [], fsImpl: fs });
      const wc = createWatcher({ rootDir: rb, argv: ["--transport", "cloud"], fsImpl: fs });
      const wd = createWatcher({ rootDir: mkRoot("trn-cfg-empty", null), argv: [], fsImpl: fs });
      ck.ok("W-TRN-01e cfg 三键落位：snake/camel 双拼等效（尾斜杠归一）+loopbackPort 派生+CLI>cfg+缺省=cloud",
        wa.cfg.transport === "loopback" && wa.cfg.loopbackOrigin === "http://127.0.0.1:7901" &&
        wb.cfg.loopbackOrigin === "http://localhost:7902" && wc.cfg.transport === "cloud" && wc.cfg.loopbackOrigin === "" &&
        wd.cfg.transport === "cloud" && wd.cfg.loopbackOrigin === "", { a: wa.cfg.loopbackOrigin, b: wb.cfg.loopbackOrigin });
    }
    /* W-TRN-02 非法值/非回环 host/缺端点 → 启动即拒。 */
    {
      const mk = (name, argv, cfgObj) => {
        const r = path.join(BASE.root, name);
        fs.mkdirSync(r, { recursive: true });
        if (cfgObj) fs.writeFileSync(path.join(r, "watcher.cfg.json"), JSON.stringify(cfgObj));
        try { createWatcher({ rootDir: r, argv, fsImpl: fs }); return false; } catch (e) { return String((e && e.message) || e); }
      };
      const rLan = mk("trn-bad-lan", ["--transport", "lan"]);
      const rCase = mk("trn-bad-case", ["--transport", "LoopBack"]);
      const rCfg = mk("trn-bad-cfg", [], { transport: "ssh" });
      const rHost = mk("trn-bad-host", ["--transport", "loopback", "--loopback-origin", "http://192.168.1.9:8080"]);
      const rAllBind = mk("trn-bad-allbind", ["--transport", "loopback", "--loopback-origin", "http://0.0.0.0:8080"]);
      const rHttps = mk("trn-bad-https", ["--transport", "loopback", "--loopback-origin", "https://zcode.z.ai"]);
      const rMissing = mk("trn-bad-missing", ["--transport", "loopback"]);
      ck.ok("W-TRN-02 非法 transport 启动即拒：lan 不预留枚举/大小写敏感/cfg 路径同拒",
        typeof rLan === "string" && rLan.indexOf("lan") >= 0 && typeof rCase === "string" && typeof rCfg === "string", { rLan, rCase, rCfg });
      ck.ok("W-TRN-02b loopbackOrigin 非回环 host 启动即拒（SHIM-03 同轴：内网 host/0.0.0.0/https 面全拒）+缺端点拒",
        typeof rHost === "string" && rHost.indexOf("192.168.1.9") >= 0 && typeof rAllBind === "string" &&
        typeof rHttps === "string" && typeof rMissing === "string", { rHost, rAllBind, rHttps, rMissing });
      ck.ok("W-TRN-02c --loopback-port 合法派生 origin（托管拉起 --port 契约面）",
        createWatcher({ rootDir: path.join(BASE.root, "trn-bad-missing"), argv: ["--transport", "loopback", "--loopback-port", "7899"], fsImpl: fs }).cfg.loopbackOrigin === "http://127.0.0.1:7899");
    }
    /* W-DGR2-01 loopback 断连/空设备表 → D2 提示含桌面双 env 名。 */
    {
      const root = path.join(BASE.root, "dgr2-lb");
      const rec = { urls: [] };
      const emptyFetch = async (url) => { rec.urls.push(String(url)); return { status: 200, text: async () => JSON.stringify({ code: 0, msg: "", data: [] }) }; };
      writeBoard(root, [mission("m-dgr2", "done", Date.now() - 3600_000)]);
      writeCoord(root);
      const w = createWatcher({
        rootDir: root,
        argv: ["--poll-sec", "1", "--min-interval-sec", "0", "--hold-max-sec", "1", "--verdict-window-sec", "60",
          "--transport", "loopback", "--loopback-origin", "http://127.0.0.1:7897"],
        now: () => Date.now(),
        sleepFn: async () => {},
        fetchImpl: emptyFetch,
        transportFactory: new MockRelay().transportFactory,
        jwtLoader: () => { throw new Error("loopback-must-not-load-jwt"); },
        revivedProbe: () => true,
      });
      const lines = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s) => { lines.push(String(s)); return true; };
      let r1;
      try { r1 = await w.tick(); } finally { process.stdout.write = origWrite; }
      const all = lines.join("");
      ck.ok("W-DGR2-01 loopback 空设备表→D2 瞬时且提示词含桌面双 env 名与端点 origin（RELAY_WS_URL+ENDPOINT_ORIGIN）",
        r1.outcome === "D2" && all.indexOf("ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL") >= 0 &&
        all.indexOf("ZCODE_ENDPOINT_ORIGIN") >= 0 && all.indexOf("http://127.0.0.1:7897") >= 0,
        { outcome: r1.outcome, hit: lines.filter((l) => l.indexOf("loopback") >= 0).join(" | ").slice(0, 300) });
      ck.ok("W-DGR2-01b D2 写 signals 回哨兵且不落 setting.json 备链（空表=桌面 env 未生效语义，S1 后即断）",
        readSignals(root).some((s) => s.cls === "D2" && s.mission === "m-dgr2") && rec.urls.length === 1, rec);
      const cap = [];
      const dg = new DegradeState({ rootDir: path.join(BASE.root, "dgr2-unit"), now: () => Date.now(), log: (l) => cap.push(l) });
      dg.record({ cls: CLASSES.D2, missionId: "m-h", reason: "connect-failed", hint: loopbackD2Hint({ origin: "http://127.0.0.1:7897" }) });
      const cap2 = [];
      const dg2 = new DegradeState({ rootDir: path.join(BASE.root, "dgr2-unit2"), now: () => Date.now(), log: (l) => cap2.push(l) });
      dg2.record({ cls: CLASSES.D2, missionId: "m", reason: "connect-failed" });
      const hintUnit = cap.join("");
      ck.ok("W-DGR2-01c degrade hint 参数：loopback 提示含双 env 名；cloud 不传=零输出（CR-04 面）",
        hintUnit.indexOf("ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL") >= 0 && hintUnit.indexOf("ZCODE_ENDPOINT_ORIGIN") >= 0 &&
        cap2.length === 0, hintUnit);
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
}
