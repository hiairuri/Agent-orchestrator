// @module suites/watcher-core/verdict-degrade
/*!
 * watcher-core/verdict-degrade.mjs —— verdict/降级面：W-VRD VERDICT + G11 rollout 探针接线 /
 * W-DGR DEGRADE。拆分自 suites/watcher-core.mjs；断言本体零改动
 * （源面读取 new URL 相对深度按新落位接线）。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, grp } from "./shared.mjs";
import { PLUGIN_DIR } from "../../harness/jsonrpc-client.mjs";
import { runNode } from "../../harness/capture.mjs";
import { classifyAccept, finalVerdict, observeRevival, rolloutRevivedProbe } from "../../../watcher/verdict.mjs";
import { DegradeState, classifyFailure, failureFromClose, CLASSES, SIGNALS_MAX_LINES } from "../../../watcher/degrade.mjs";
import { resolveRolloutDir } from "../../../watcher/watcher.mjs";
import { readSignals } from "./fixtures.mjs";

export async function run(ctx) {
  const { BASE, T0 } = ctx;

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

  /* ======== G11 rollout 探针接线（EXP10 R4-3：verdict 系统性失真修复） ======== */
  {
    grp("G11 rollout-probe");
    // 01 探针语义：文件名形态 model-io-<sessionId>.jsonl，mtime > sinceMs 方判复活；缺失/异常归否
    const probeDir = path.join(BASE.root, "g11-rollout");
    fs.mkdirSync(probeDir, { recursive: true });
    const probeFile = path.join(probeDir, "model-io-sess-g11.jsonl");
    fs.writeFileSync(probeFile, "{}\n");
    const probeMtime = fs.statSync(probeFile).mtimeMs;
    const probe = rolloutRevivedProbe({ rolloutDir: probeDir });
    ck.ok("W-VRD-08 rolloutRevivedProbe 语义（G11）：model-io-<sessionId>.jsonl mtime>sinceMs→true、mtime≤sinceMs→false、无对应文件→false、目录缺失→false（catch 归否不抛）——与 bg-sentinel rolloutHeartbeatMs 同形态",
      probe({ sessionId: "sess-g11", sinceMs: probeMtime - 1000 }) === true &&
      probe({ sessionId: "sess-g11", sinceMs: probeMtime + 1000 }) === false &&
      probe({ sessionId: "sess-absent", sinceMs: 0 }) === false &&
      rolloutRevivedProbe({ rolloutDir: path.join(BASE.root, "g11-no-dir") })({ sessionId: "s", sinceMs: 0 }) === false,
      { mtime: probeMtime });

    // 02 目录解析三链：argv 优先（空格/= 两形）> cfg rollout_dir > 缺省 ~/.zcode/cli/rollout（bg-sentinel 同源）
    const homeMock = path.join("C:", "home", "u");
    ck.ok("G11-01 resolveRolloutDir 三链（bg-sentinel.mjs signalsOf 同源缺省）：--rollout-dir <v> 与 --rollout-dir=<v> 均压过 cfg rollout_dir；无 CLI 时 cfg 兜底；双缺省=path.join(homedir,'.zcode','cli','rollout')；空串/未展开 ${} 占位符回落 cfg",
      resolveRolloutDir(["--rollout-dir", "D:/r1"], { rollout_dir: "D:/cfg" }, { homedir: homeMock }) === "D:/r1" &&
      resolveRolloutDir(["--rollout-dir=D:/r2"], {}, { homedir: homeMock }) === "D:/r2" &&
      resolveRolloutDir([], { rollout_dir: "D:/cfg" }, { homedir: homeMock }) === "D:/cfg" &&
      resolveRolloutDir([], {}, { homedir: homeMock }) === path.join(homeMock, ".zcode", "cli", "rollout") &&
      resolveRolloutDir(["--rollout-dir", "${ZCODE_ROLLOUT_DIR}"], { rollout_dir: "D:/cfg" }, { homedir: homeMock }) === "D:/cfg",
      { emptyArgv: resolveRolloutDir([], {}, { homedir: homeMock }) });

    // 03 main() 组装面源面锁：解析→构造探针→传入 createWatcher→启动行观测字段（防回退成恒否探针）
    const wsrcG11 = fs.readFileSync(new URL("../../../watcher/watcher.mjs", import.meta.url), "utf8");
    ck.ok("G11-02 main() 组装面接线源面锁（EXP10 R4-3 根因：rolloutRevivedProbe 导出存在但 main 从未传 revivedProbe→③观测恒否）：resolveRolloutDir(argv, loadCfg(rootDir))→createWatcher({…, revivedProbe: rolloutRevivedProbe({ rolloutDir })})，启动行含 rollout=<dir> 观测字段",
      wsrcG11.includes("const rolloutDir = resolveRolloutDir(argv, loadCfg(rootDir));") &&
      wsrcG11.includes("revivedProbe: rolloutRevivedProbe({ rolloutDir })") &&
      wsrcG11.includes("rollout=${rolloutDir}"),
      { resolve: wsrcG11.includes("resolveRolloutDir(argv, loadCfg(rootDir))"), probe: wsrcG11.includes("rolloutRevivedProbe({ rolloutDir })") });

    // 04 --once 真进程启动行（空板=board-unreadable 零事务）：rollout 段观测值=传入目录
    const g11Root = path.join(BASE.root, "g11-main-root");
    const g11Rollout = path.join(BASE.root, "g11-main-rollout");
    const g11Run = runNode(path.join(PLUGIN_DIR, "watcher", "watcher.mjs"), ["--root", g11Root, "--rollout-dir", g11Rollout, "--once"], { timeoutMs: 20000 });
    const g11Line = String(g11Run.stdout).split("\n").find((l) => l.includes("[watcher] 启动")) || "";
    ck.ok("G11-03 main --once 启动行 rollout 观测字段：rollout=<--rollout-dir 值> 在位且进程 exit 0（空板首轮 board-unreadable 即返，零事务零网络）",
      g11Run.code === 0 && g11Line.includes("rollout=" + g11Rollout) &&
      String(g11Run.stdout).includes('"state":"board-unreadable"'),
      { code: g11Run.code, line: g11Line, out: String(g11Run.stdout).slice(0, 300) });
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
}
