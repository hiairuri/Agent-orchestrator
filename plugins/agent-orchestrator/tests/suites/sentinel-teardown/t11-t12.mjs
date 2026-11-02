// @module sentinel-teardown/t11-t12
/*!
 * suites/sentinel-teardown/t11-t12.mjs —— T11 CLN-05（v0.9 C8）writeSentinelCfg 全 sparse cfg 形状 /
 * T12 v1.1.1 W20 coord-tail 追加日志黑盒（stop-check，ORT-1..8 + v2 双标签 + 滞回裁剪）
 * （自 sentinel-teardown.mjs 初步切分拆出，v1.3；断言本体逐字搬运零改动）
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runCapture } from "../../harness/capture.mjs";
import { familySource } from "../../harness/source-family.mjs";

export async function run(ctx) {
  const { ck, PLUGIN_DIR, SENTINEL, STOP_CHECK, BASE, kids, readJson, readText, waitFor } = ctx;

  /* ---- T11 CLN-05（v0.9 C8）：writeSentinelCfg 全 sparse cfg 形状 ----
     server 模块加载副作用写 <root>/sentinel.cfg.json；全 sparse 转正后 cfg 仅含
     显式传入键 + signals block 恒在（v0.9-DESIGN §5 / §16 CLN-05）。独立临时根
     裸 spawn server（本套件首次直起 server——黑盒哨兵套件不经 MCP 面，裸进程即
     模块加载；crv5-auth 场景 D spawnForCfg 同款）。零漂移对拍=双文件常量锁
     （server 十键全 numArgOpt 条件写且 numArg 零遗留 ∧ 哨兵内建默认字面量表逐条
     在位=转正前 server 默认）+登记面锁（零漂移对拍表在 v0.9.x.md）。 */
  {
    const SERVER = path.join(PLUGIN_DIR, "mcp", "server.mjs");
    // v1.3 切分重基（修复轮 C）：server 读取面走族 helper（薄入口+模块族拼接——十键 numArgOpt
    // 条件写已迁 mcp/server-boot.mjs），断言与期望值零改动。
    const srvSrc = familySource(PLUGIN_DIR, path.join("mcp", "server.mjs"));
    // v1.3 切分 S1（m-20261101-070724-6958）：sentinel 侧读面改族面（split-impl-design §2.1 处置①，
    //   server 侧 famSrc 同款先例）——哨兵内建默认字面量表实测在入口 bg-sentinel.mjs L185-210，
    //   族拼接含入口，字面量表断言命中语义不变（F-2.2 残余单文件源语义读收口，LM-06-SCAN 白名单免登记）。
    const sentSrc = familySource(PLUGIN_DIR, "hooks/bg-sentinel.mjs");
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
    // v1.4 C2-a 改13：scanBlocks 升 v3 主标识别（双标识别——历史 v2 块照常计数，C2-05 载体）。
    const scanBlocks = (text) => {
      const lines = String(text ?? "").split(/\r?\n/);
      const out = [];
      let open = -1;
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t === "<!-- orch-tail v3" || t === "<!-- orch-tail v2") open = i;
        else if (t === "<!-- orch-tail-end -->" && open >= 0) {
          out.push(lines.slice(open, i + 1).join("\n"));
          open = -1;
        }
      }
      return out;
    };
    const logBlocks = () => scanBlocks(readLog());
    const stripProto = (blockText) =>
      blockText.split("\n").filter((line) => !/^(ts|seq|sessionId): /.test(line)).join("\n");
    // v1.4 C2-a 改13（期望值侧）：写面归一化落写形态=v3 主标记+sessionId 协议行（EXTRA ⑧；
    // 输入夹具 fullBlock/shortBlock 维持 v2 原样=改13 收窄——既有 v2 夹具=C2-05 识别腿载体）。
    // sessionId: null → 不落行（seed 恢复源会话不可知形）。
    const normBlock = (over = {}) => {
      const lines = [
        "<!-- orch-tail v3",
        `ts: ${over.ts ?? "2026-10-25T05:00:00.000Z"}`,
        `seq: ${over.seq ?? 1}`,
      ];
      if (over.sessionId !== null) lines.push(`sessionId: ${over.sessionId ?? "sess_main-1"}`);
      lines.push(
        `project: ${over.project ?? "v1.1.1 施工中"}`,
        `stage: ${over.stage ?? "W20"}`,
        `flying: ${over.flying ?? "m-a"}`,
        `ruled: ${over.ruled ?? "日志唯一源"}`,
        `next: ${over.next ?? "机制波"}`,
        "<!-- orch-tail-end -->",
      );
      return lines.join("\n");
    };

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
        "T12-b 全形块 → 日志首条追加（改13 期望值侧：v2 输入归一化落写=v3 主标记+sessionId 协议行；字段序/ts:seq: 协议行保留/exit 0）",
        r.code === 0 && got === normBlock() + "\n" && logBlocks().length === 1 && !r.stderr.trim(),
        { got, stderr: r.stderr },
      );
    }
    {
      const before = readLog();
      const r = runStop(shortBlock({ flying: "+m-b,-m-a" }));
      const got = logBlocks();
      const want = normBlock({ ts: "2026-10-25T05:01:00.000Z", seq: 2, flying: "m-b", next: "收口" });
      ck.ok(
        "T12-c 短形 delta 合并后追加全形条目（v1.4 C2-a：基线=同会话链末条；project/stage/ruled 保留、flying +/-、ts/seq 换新、sessionId 协议行在位）",
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
        "T12-j 短形无同会话链全形基线 → 不立日志 + stderr「缺全形基线」（v1.4 C2-a：同会话链为界）",
        r.code === 0 && !fs.existsSync(LOG) && r.stderr.includes("缺全形基线") && r.stderr.includes("同会话"),
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
        "T12-k 多块取最后一块（只取消息最后一组完整对）：日志=seq 2 块（归一化 v3 落写）",
        r.code === 0 && got.length === 1 && got[0] === normBlock({ seq: 2, project: "新" }),
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
        "T12-x2 尾锚定容忍尾随空白：闭标签后仅空白 → 正常追加（归一化 v3 落写）",
        trailing.code === 0 && readLog() === normBlock({ seq: 1 }) + "\n" && !trailing.stderr.trim(),
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
        "T12-o 变化即追加：业务字段（next）变 → 日志新增一条全形条目（旧条目保留，块间空行；改13：追加块=v3 主标记）",
        r0.code === 0 &&
          r1.code === 0 &&
          got.length === 2 &&
          got[0].includes("next: 一") &&
          got[1].includes("next: 二") &&
          readLog().includes("<!-- orch-tail-end -->\n\n<!-- orch-tail v3") &&
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
        "T12-q 滞回裁剪腿（v1.2.2 自「封顶 K=10 第 11 块触发」改写）：第 21 块触发原子重写（seq1..11 出队，保留最新 10，末块最新；改13：落写=v3+sessionId 形）",
        got.length === 10 &&
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].every((n) => !readLog().includes(`seq: ${n}\n`)) &&
          got[0] === normBlock({ seq: 12, ts: "2026-10-25T06:12:00.000Z", next: "n12" }) &&
          got[9] === normBlock({ seq: 21, ts: "2026-10-25T06:21:00.000Z", next: "n21" }),
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
        "HYS-01 累积腿（v1.2.2 滞回）：20 块不滑动（无裁剪，最上不丢）——恰 20 全在位，seq1..20 逐块等值（改13：v3+sessionId 形）",
        gotH1.length === 20 &&
          gotH1[0] === normBlock({ seq: 1, ts: "2026-10-25T07:01:00.000Z", next: "h1" }) &&
          gotH1[19] === normBlock({ seq: 20, ts: "2026-10-25T07:20:00.000Z", next: "h20" }),
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
        "HYS-02 裁剪腿（v1.2.2 滞回）：恰 20 块 + 第 21 块 → 原子重写保留最新 10（含新块，seq11 消失、seq12..21 在位；改13：种子 v2 块原样保留不回写、新落写块=v3+sessionId 形——C2-05 存量保留同源证据）",
        rH2.code === 0 &&
          gotH2.length === 10 &&
          !readLog().includes("seq: 11\n") &&
          gotH2[0] === fullBlock({ seq: 12, ts: "2026-10-25T08:12:00.000Z", next: "s12" }) &&
          gotH2[8] === fullBlock({ seq: 20, ts: "2026-10-25T08:20:00.000Z", next: "s20" }) &&
          gotH2[9] === normBlock({ seq: 21, ts: "2026-10-25T08:21:00.000Z", next: "s21" }),
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
        "T12-r seed 幂等 + 三遗留清理：v1 全形 → 日志首条 v3 渲染（改13：恢复源会话不可知 → 不带 sessionId 行；等值轮零追加）+ 旧文件/compact/stale 全删",
        r.code === 0 &&
          got.length === 1 &&
          got[0] === normBlock({ sessionId: null }) &&
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
        "T12-s 跨会话追加无冻结：seq 40 → 1 两块均入日志、零拒（判旧守卫复活必红；全形块不受同会话链约束——拒写面只对短形）",
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
      // v1.4 C2-a C2-01（绿腿）：同会话链补全——短形补全只取同 sessionId 链全形，
      // 落写带 sessionId 协议行（会话归属可审计）。
      resetSC();
      const rf = runStop(
        fullBlock({ seq: 10, project: "会话X板", stage: "SX", flying: "m-x1", next: "x1" }),
        { session_id: "sess_chain-x" },
      );
      const rs = runStop(
        shortBlock({ seq: 11, ts: "2026-10-25T05:11:00.000Z", flying: "+m-x2", next: "x2" }),
        { session_id: "sess_chain-x" },
      );
      const got = logBlocks();
      ck.ok(
        "C2-01 同会话链补全：同会话短形补全自同 sessionId 链全形（project/stage/ruled 保留自本会话全形 ∧ 落写=v3 主标记+sessionId 协议行 ∧ flying 增量合并）",
        rf.code === 0 &&
          rs.code === 0 &&
          got.length === 2 &&
          got[1].startsWith("<!-- orch-tail v3") &&
          got[1].includes("sessionId: sess_chain-x") &&
          got[1].includes("project: 会话X板") &&
          got[1].includes("stage: SX") &&
          got[1].includes("flying: m-x1, m-x2") &&
          got[1].includes("next: x2") &&
          !rs.stderr.trim(),
        { last: got[1], stderr: rs.stderr },
      );
    }
    {
      // v1.4 C2-a C2-02（红转绿）：日志上一块属他会话 ∧ 本块短形 → 拒写+stderr 要求全形
      // （跨会话字段不继承——缺陷本体=字段继承的会话域错配，串味域缩至同会话链）。
      // v2 遗留短形无 sessionId 行 → 同会话链不可判 → 同一拒写（安全向，不猜不继承）。
      resetSC();
      const rf = runStop(
        fullBlock({ seq: 20, project: "旧会话板", stage: "OLD", flying: "m-old", next: "old" }),
        { session_id: "sess_cross-old" },
      );
      const before = readLog();
      const rs = runStop(
        shortBlock({ seq: 21, ts: "2026-10-25T05:21:00.000Z", flying: "+m-new", next: "new" }),
        { session_id: "sess_cross-new" },
      );
      const got = logBlocks();
      ck.ok(
        "C2-02 跨会话拒写（红转绿）：短形块同会话链无全形基线（上一块属他会话）→ 拒写+stderr 要求全形，日志逐字节不动（跨会话字段不继承）",
        rf.code === 0 &&
          rs.code === 0 &&
          readLog() === before &&
          got.length === 1 &&
          rs.stderr.includes("缺全形基线") &&
          rs.stderr.includes("同会话"),
        { count: got.length, last: got[0] && got[0].split("\n")[2], stderr: rs.stderr, changed: readLog() !== before },
      );
      const rv2 = runStop(
        shortBlock({ seq: 22, ts: "2026-10-25T05:22:00.000Z", flying: "+m-v2", next: "v2" }),
        { session_id: "sess_cross-new" },
      );
      ck.ok(
        "C2-02b v2 遗留短形同拒：v2 短形（无 sessionId 行）在无同会话链全形时同一拒写语义（安全向）",
        rv2.code === 0 && readLog() === before && rv2.stderr.includes("缺全形基线"),
        { stderr: rv2.stderr, changed: readLog() !== before },
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
        "T12-v 祖先回退：cwd=子目录且默认根无板无 root-id → 定根命中祖先根（日志落祖先根〔改13：归一化 v3 落写〕+ stderr 定根回退一行 + 子目录零 .zcode）",
        r.code === 0 &&
          fs.existsSync(ANC_LOG) &&
          fs.readFileSync(ANC_LOG, "utf8") === normBlock({ seq: 7, next: "祖先" }) + "\n" &&
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
    {
      // v1.4 C2-a C2-04/C2-05（注入面）：剥离清单 ts:/seq:/sessionId: 生效 + v2 历史全形块
      // 照常渲染识别腿。载体=纯区脚手架形只读 import 被测组装模块（BUILD-DISPATCH-PURE 标记区
      // 抽取，crv2-pack/dispatch-pure 同形；断言文件恒落 W3 写面——被测模块只读 import 不构成
      // 写面，R-16 回退点=root-contract 追加节备用）。日志夹具：直投 v2 全形块（存量形态原样）
      // + 写面 v3 块（带 sessionId 行）。
      let dispatchPure = null;
      {
        const src = fs
          .readFileSync(path.join(PLUGIN_DIR, "mcp", "tool-dispatch.mjs"), "utf8")
          .replace(/\r\n/g, "\n");
        const beginMark = "/* BUILD-DISPATCH-PURE-BEGIN";
        const endMark = "/* BUILD-DISPATCH-PURE-END */";
        const i = src.indexOf(beginMark);
        const j = src.indexOf(endMark);
        if (i >= 0 && j > i) {
          const dir = path.join(BASE.root, "t12-dispatch-pure");
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, "pure.mjs");
          fs.writeFileSync(
            file,
            src.slice(i, j + endMark.length) +
              "\nexport { buildDispatchPrompt, dispatchTailBlocks, dispatchStripProtocol, DISPATCH_TAIL_MARK, DISPATCH_TAIL_MARK_V2 };\n",
          );
          dispatchPure = await import(pathToFileURL(file).href + "?v=" + Date.now());
        }
        ck.ok(
          "C2-04a 注入面纯区可抽取（BUILD-DISPATCH-PURE 标记对在位；v3 主标记+V2 legacy 识别常量双出）",
          Boolean(
            dispatchPure &&
              dispatchPure.buildDispatchPrompt &&
              dispatchPure.DISPATCH_TAIL_MARK === "<!-- orch-tail v3" &&
              dispatchPure.DISPATCH_TAIL_MARK_V2 === "<!-- orch-tail v2",
          ),
          { extracted: Boolean(dispatchPure) },
        );
      }
      if (dispatchPure) {
        const mkMission = (id, packPath) => ({ id, pack: { path: packPath } });
        const mkPack = (mid, worker, token) =>
          [
            `# 任务包：T（${mid}）`,
            "",
            "## CONTRACT（三行契约，也出现在派发 prompt 尾块）",
            `[channel] ${mid}`,
            `[worker] ${worker}`,
            `[token] ${token}`,
            "",
            "## TASK",
            "- 做一件事",
          ].join("\n");
        const { buildDispatchPrompt, dispatchStripProtocol } = dispatchPure;
        // 剥离清单直测：ts:/seq:/sessionId: 三协议行全剥，业务行保留。
        const stripped = dispatchStripProtocol(["ts: t", "seq: 1", "sessionId: s", "project: p"]);
        ck.ok(
          "C2-04b 剥离清单生效：dispatchStripProtocol 剥 ts:/seq:/sessionId: 三协议行（sessionId 与 ts:/seq: 同列）、业务行保留",
          stripped.length === 1 && stripped[0] === "project: p",
          { stripped },
        );
        // 日志=存量 v2 全形块（直投原样）+ 写面 v3 块（sessionId 行在位）。
        resetSC();
        fs.mkdirSync(CTX, { recursive: true });
        fs.writeFileSync(LOG, fullBlock({ seq: 30, project: "存量v2板", next: "v2next" }) + "\n");
        const rw = runStop(fullBlock({ seq: 31, ts: "2026-10-25T05:31:00.000Z", project: "新v3板", next: "v3next" }));
        const gotLog = logBlocks();
        ck.ok(
          "C2-05 v2 历史全形块照常渲染（识别腿）：存量 v2 块原样保留不回写 ∧ 写面新块=v3 归一化落写 ∧ 日志双标计数两块",
          rw.code === 0 &&
            gotLog.length === 2 &&
            gotLog[0] === fullBlock({ seq: 30, project: "存量v2板", next: "v2next" }) &&
            gotLog[1] === normBlock({ seq: 31, ts: "2026-10-25T05:31:00.000Z", project: "新v3板", next: "v3next" }),
          { count: gotLog.length, stderr: rw.stderr },
        );
        const built = buildDispatchPrompt(
          mkMission("m-c204", "packs/m-c204/pack.md"),
          mkPack("m-c204", "orch-w3#1", "0".repeat(32)),
          readLog(),
          "persona 正文",
          null,
          { absent: 2 },
        );
        ck.ok(
          "C2-04 注入面剥离生效：拼装 prompt 轨迹节不含 sessionId: 行（剥离清单 ts:/seq:/sessionId: 生效）∧ v3 主标记在位 ∧ v2 历史块字段渲染完整（信息零丢失）∧ 双标计数两块",
          built.ok === true &&
            built.blocks === 2 &&
            built.text.includes("<!-- orch-tail v3") &&
            !built.text.includes("sessionId:") &&
            built.text.includes("project: 存量v2板") &&
            built.text.includes("next: v2next") &&
            built.text.includes("next: v3next"),
          { ok: built.ok, blocks: built.blocks, hasSessionId: built.text.includes("sessionId:") },
        );
      }
    }
  }
}
