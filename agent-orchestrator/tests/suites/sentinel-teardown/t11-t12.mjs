// @module sentinel-teardown/t11-t12
/*!
 * suites/sentinel-teardown/t11-t12.mjs —— T11 CLN-05（v0.9 C8）writeSentinelCfg 全 sparse cfg 形状 /
 * T12 v1.1.1 W20 coord-tail 追加日志黑盒——v1.6 W-t 写依赖腿随 stop-check 写段拆除（R7）全数退役；
 * v1.6 W3a（m-20261104-053000-w16-3a）：残存 C2-04a/b 注入面两腿随 R1 组装链退役（C-04 对拍终裁=
 * 退役——subject=dispatch-prompt.mjs BUILD-DISPATCH-PURE 标记区随文件整退役 ENOENT 消亡；台账
 * v1.6.0.md §W3a）。本件现役=T11 CLN-05 三腿（writeSentinelCfg 全 sparse 形状）。
 * （自 sentinel-teardown.mjs 初步切分拆出，v1.3；断言本体逐字搬运零改动）
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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
      '"wake_grace_min", null, 2, 0.01, 1440', '"answer_grace_min", null, 3, 0.01, 1440',
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

  /* ---- T12 coord-tail 追加日志黑盒（stop-check）—— v1.6 W-t 写依赖腿全数退役（C5 扩圈：C-04 文件级盘点）；
     v1.6 W3a 残存 C2-04a/b 注入面两腿亦随 R1 组装链退役（C-04 对拍终裁=退役） ----
     v1.1.1 W20 建组（ORT-1..8 + v2 双标签 + 滞回裁剪全谱行为腿 T12-a..v2/C2-01/02/05/HYS-01/02）。
     v1.6 W-t（m-20261104-033000-w16-t）：R7 stop-check 轨迹写段整体拆除——写触发段消亡后本组写依赖腿
     全部失 subject 退役。
     v1.6 W3a（m-20261104-053000-w16-3a）：C2-04a（BUILD-DISPATCH-PURE 纯区可抽取）与 C2-04b
     （dispatchStripProtocol 剥离清单）两腿退役——subject 随 mcp/tool-dispatch/dispatch-prompt.mjs
     整文件退役消亡（impl-plan 设计锚 ":633-639 readFileSync 纯区抽取"系拆分前旧行区，实态 :121-160 区；
     design §3.1 R1 连带②/C-04 口径；台账 v1.6.0.md §W3a 逐腿沿革）。防回潮职能=po-static N15 反向钉；
     ORT 读面零迁=trajectory 读面纪律（PL-10③/STATE 指针行）。 */
}
