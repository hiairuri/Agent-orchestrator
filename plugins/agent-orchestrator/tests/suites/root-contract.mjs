// @module root-contract
/*!
 * suites/root-contract.mjs —— root-id 契约行为矩阵（v0.6 B1；W-B findings §1 为契约权威）
 *
 * 被测六处实现（五脚本 verbatim twin + stop-check 镜像路径，行为锁定、零代码共享）：
 *   bg-gate / bg-sentinel / journal / session-start 各自 locateRoot
 *   + stop-check 主清点与镜像记录两条路径（第六处原内联副本已收敛至同文件 locateRoot）
 *   v1.1.1 W22 增祖先回退矩阵端口；W24 ③a/③b 增五处 twin 一致性锁与 stop-check 祖先回退腿。
 * 另含 server 发布/自愈侧行（V6-12 归簇 A）：行为探测后才启用——A1 并行施工未落地时
 *   该组整体挂起为一条非阻塞断言，落地后自动转为真实断言（impl-plan §5.3 G 门前回扫）。
 *
 * 契约要点（W-B §1 + DESIGN §3.1 冻结文本）：
 *   - 无指针（或空指针）→ 默认根，静默；
 *   - temp 拒绝（两代通用，isTempRoot 同款 relative 判定）→ 拒；
 *   - v2 强校验（指针 2 行）：目标存活 ∧ root-id 存在 ∧ 内容 === 内嵌 id → 采信；
 *   - v1 弱校验（指针 1 行，v0.4.1–v0.5.1 兼容）：目标存活 ∧ root-id 存在即采信 + stderr 旧格式提示；
 *     目标无 root-id → 拒（≤v0.4.0 旧版劫持 V6-30 天然中和）；
 *   - 任一失败 → 回退默认根 + stderr 告警一行；hooks 不删指针。
 *
 * 测试机制注记：
 *   - fixture 全部在 %TEMP%（makeTempRoot 红线内）。指针目标的 temp 判定以「子进程眼中的
 *     os.tmpdir()」为准：采信/失配/悬空等场景给子进程注入 TMPDIR/TMP/TEMP=TMPFAKE（BASE 下
 *     子目录，使 CUSTOM 等目标逃出 temp 判定，结构与生产「自定义根在 temp 外」同构）；
 *     temp 拒绝场景（P6）用真实 os.tmpdir() 原样判定（真实毒根形态，双重覆盖）。
 *   - 哨兵用 captureBackground 惯例（sentinel-teardown 同款），断言 V6-56 槽位 root 字段。
 *
 * 运行方式：node tests/suites/root-contract.mjs（run-all 注册行由主控 G 卡统一收口）
 * 前置：node >= 20；无 git/网络依赖；总时长 ~15s；Windows/linux 均可。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_DIR, Checker, startServer } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot } from "../harness/temp-root.mjs";
import { captureBackground, runNode } from "../harness/capture.mjs";

const ck = new Checker("root-contract");
const HOOKS = path.join(PLUGIN_DIR, "hooks");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, step = 100) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(step);
  }
}
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const rmrf = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};

/* ---------------- fixtures ---------------- */
const BASE = makeTempRoot({ prefix: "orch-rootct-" });
const PROJ = path.join(BASE.root, "proj");
const DEF = path.join(PROJ, ".zcode", "orchestrator"); // 默认根（回退面）
const CUSTOM = path.join(PROJ, "custom-root"); // 采信目标（含 root-id 的自定义根）
const NOID = path.join(PROJ, "noid-root"); // 存活但无 root-id（v1 拒 / 旧版劫持）
const PLAIN = path.join(BASE.root, "plain-dir"); // 项目外普通存活目录（非存储根）
const GONE = path.join(BASE.root, "gone-root"); // 悬空目标（永不创建）
const TMPFAKE = path.join(BASE.root, "tmpfake"); // 子进程眼中的 os.tmpdir()（不必存在）
const RID = "0123456789abcdef";
const BADID = "ffffffffffffffff";
const POINTER = path.join(DEF, "root.txt");

const ENV_PROJ = { ZCODE_PROJECT_DIR: PROJ };
const ENV_FAKETMP = { ZCODE_PROJECT_DIR: PROJ, TMPDIR: TMPFAKE, TMP: TMPFAKE, TEMP: TMPFAKE };

fs.mkdirSync(DEF, { recursive: true });
fs.mkdirSync(CUSTOM, { recursive: true });
fs.mkdirSync(NOID, { recursive: true });
fs.mkdirSync(PLAIN, { recursive: true });
fs.writeFileSync(path.join(CUSTOM, "root-id"), RID + "\n");
// 采信根预置板面（session-start / stop-check 主流程的可分辨观测面）；默认根恒无板。
fs.writeFileSync(
  path.join(CUSTOM, "board.json"),
  JSON.stringify({
    version: 2,
    updated_at: new Date().toISOString(),
    missions: [
      { id: "m-ct", title: "contract-target", status: "running", original_prompt: "ct-prompt", dispatch: {} },
      { id: "m-open", title: "open-item", status: "running", original_prompt: "open-prompt", dispatch: {} },
    ],
  }) + "\n",
);
fs.mkdirSync(path.join(CUSTOM, "spool", "m-open", "unread"), { recursive: true });
fs.writeFileSync(path.join(CUSTOM, "spool", "m-open", "unread", "e1.json"), JSON.stringify({ at: new Date().toISOString() }) + "\n");

const writePointer = (...lines) =>
  fs.writeFileSync(POINTER, lines.length ? lines.join("\n") + "\n" : "");
const clearPointer = () => rmrf(POINTER);
const writeRootId = (dir, id) => fs.writeFileSync(path.join(dir, "root-id"), id + "\n");
/** 每例前清理两根的观测产物（防上一例残留造成假阳性） */
const cleanArtifacts = () => {
  for (const root of [DEF, CUSTOM]) {
    rmrf(path.join(root, "context"));
    rmrf(path.join(root, "sentinel"));
    rmrf(path.join(root, "sentinel-hint-stamp"));
  }
};

/* ---- v1.1.1 W22 祖先回退夹具（cwd 漂移防护；独立树，不扰动 P1..P10 的 DEF/CUSTOM） ----
 *   ANC_PROJ：合法祖先项目根（board.json + root-id）；ANC_SUB：被宿主同步进子目录后的 cwd；
 *   ANC_TOP：子目录默认根（无板无 root-id → 触发祖先回退）。
 *   ANC_NOID：仅 board.json 无 root-id 的祖先（不命中条件的反证）；ANC_NOID_SUB：其深层子目录。 */
const ANC_PROJ = path.join(BASE.root, "anc", "proj");
const ANC_ROOT = path.join(ANC_PROJ, ".zcode", "orchestrator");
const ANC_SUB = path.join(ANC_PROJ, "plugins", "x");
const ANC_TOP = path.join(ANC_SUB, ".zcode", "orchestrator");
const ANC_NOID = path.join(BASE.root, "anc-noid");
const ANC_NOID_ROOT = path.join(ANC_NOID, ".zcode", "orchestrator");
const ANC_NOID_SUB = path.join(ANC_NOID, "proj", "deep", "sub");
const ANC_NOID_TOP = path.join(ANC_NOID_SUB, ".zcode", "orchestrator");
const ENV_ANC = { ZCODE_PROJECT_DIR: ANC_SUB }; // env 态（宿主注入子目录）
const ENV_ANC_CWD = { ZCODE_PROJECT_DIR: "" }; // 仅 cwd 态（遮蔽外部 env，走 process.cwd()）
fs.mkdirSync(ANC_ROOT, { recursive: true });
fs.mkdirSync(ANC_SUB, { recursive: true });
fs.writeFileSync(path.join(ANC_ROOT, "root-id"), RID + "\n");
fs.writeFileSync(
  path.join(ANC_ROOT, "board.json"),
  JSON.stringify({
    version: 2,
    updated_at: new Date().toISOString(),
    missions: [{ id: "m-anc", title: "ancestor-root", status: "running", original_prompt: "anc-prompt", dispatch: {} }],
  }) + "\n",
);
fs.mkdirSync(ANC_NOID_ROOT, { recursive: true });
fs.writeFileSync(path.join(ANC_NOID_ROOT, "board.json"), JSON.stringify({ version: 2, missions: [] }) + "\n");
fs.mkdirSync(ANC_NOID_SUB, { recursive: true });
/** 祖先树观测产物清理（root-id/board.json 不动） */
const cleanAnc = () => {
  for (const root of [ANC_ROOT, ANC_TOP, ANC_NOID_ROOT, ANC_NOID_TOP]) {
    rmrf(path.join(root, "context"));
    rmrf(path.join(root, "sentinel"));
    rmrf(path.join(root, "sentinel-hint-stamp"));
  }
};

/* ---------------- runners（hook 黑盒） ---------------- */
const journalAt = (root) => fs.existsSync(path.join(root, "context", "journal-s-j.jsonl"));
const mirrorAt = (root) => fs.existsSync(path.join(root, "context", "journal-s-m.jsonl"));
const stampAt = (root) => fs.existsSync(path.join(root, "sentinel-hint-stamp"));
const runJournal = (env, cwd = PROJ) =>
  runNode(path.join(HOOKS, "journal.mjs"), [], {
    cwd,
    env,
    input: { hook_event_name: "UserPromptSubmit", session_id: "s-j", prompt: "contract-probe" },
  });
const runGate = (env) =>
  runNode(
    path.join(HOOKS, "bg-gate.mjs"),
    ["--policy", "remind", "--contract", "off", "--sentinel-hint", "on"],
    {
      cwd: PROJ,
      env,
      input: { tool_name: "Agent", tool_input: { prompt: "x".repeat(700), run_in_background: true } },
    },
  );
const runSession = (env, cwd = PROJ) =>
  runNode(path.join(HOOKS, "session-start.mjs"), [], {
    cwd,
    env,
    input: { hook_event_name: "SessionStart", session_id: "s-ss" },
  });
const runStopMirror = (env, cwd = PROJ) =>
  runNode(path.join(HOOKS, "stop-check.mjs"), ["--mirror", "on"], {
    cwd,
    env,
    input: { hook_event_name: "Stop", session_id: "s-m", stop_hook_active: true, last_assistant_message: "mirror-probe" },
  });
const runStopMain = (env, cwd = PROJ) =>
  runNode(path.join(HOOKS, "stop-check.mjs"), ["--mirror", "off"], {
    cwd,
    env,
    input: { hook_event_name: "Stop", session_id: "s-x", stop_hook_active: false },
  });
/** 拉起哨兵（无 --root，走 locateRoot）→ 等待预期根出现槽位 → 读槽位 doc → 收尸 */
async function runSentinel(env, waitRoot, cwd = PROJ) {
  const bg = captureBackground({
    script: process.execPath,
    args: [path.join(HOOKS, "bg-sentinel.mjs"), "--poll-sec", "1", "--stagger-sec", "0"],
    cwd,
    env,
  });
  try {
    const slotFile = path.join(waitRoot, "sentinel", "instance-0.json");
    const ok = await waitFor(() => fs.existsSync(slotFile), 8000);
    return ok ? readJson(slotFile) : null;
  } finally {
    bg.kill();
    await bg.done;
  }
}

/* ================================================================== */
/* P1 无指针 → 默认根（静默基线）                                       */
/* ================================================================== */
{
  clearPointer();
  cleanArtifacts();
  const r = runJournal(ENV_PROJ);
  ck.ok("P1a 无指针：journal 落默认根", journalAt(DEF) && !journalAt(CUSTOM), { stderr: r.stderr.slice(0, 120) });
  ck.ok("P1b 无指针：静默（stderr 无 root.txt 告警）", !r.stderr.includes("root.txt"), r.stderr.slice(0, 120));
  cleanArtifacts();
  const g = runGate(ENV_PROJ);
  ck.ok("P1c 无指针：bg-gate 落默认根（哨兵提示戳在 DEF）", stampAt(DEF) && !stampAt(CUSTOM) && g.stdout.includes("拉起哨兵"), { stderr: g.stderr.slice(0, 120) });
}

/* ================================================================== */
/* P2 v2 匹配 → 采信目标根（五实现全过）                                */
/* ================================================================== */
{
  writePointer(CUSTOM, RID);
  cleanArtifacts();
  const r = runJournal(ENV_FAKETMP);
  ck.ok("P2a v2 匹配：journal 采信 CUSTOM", journalAt(CUSTOM) && !journalAt(DEF), { stderr: r.stderr.slice(0, 120) });
  ck.ok("P2b v2 匹配：采信无告警", !r.stderr.includes("已回退") && !r.stderr.includes("root.txt"), r.stderr.slice(0, 120));
  cleanArtifacts();
  const g = runGate(ENV_FAKETMP);
  ck.ok("P2c v2 匹配：bg-gate 采信 CUSTOM（提示戳落 CUSTOM）", stampAt(CUSTOM) && !stampAt(DEF), { stderr: g.stderr.slice(0, 120) });
  cleanArtifacts();
  const s = runSession(ENV_FAKETMP);
  ck.ok("P2d v2 匹配：session-start 读 CUSTOM 板（简报含 m-ct）", s.stdout.includes("m-ct"), { out: s.stdout.slice(0, 120), stderr: s.stderr.slice(0, 120) });
  cleanArtifacts();
  const m = runStopMirror(ENV_FAKETMP);
  ck.ok("P2e v2 匹配：stop-check 镜像采信 CUSTOM（第六处路径）", mirrorAt(CUSTOM) && !mirrorAt(DEF), { stderr: m.stderr.slice(0, 120) });
  cleanArtifacts();
  const doc = await runSentinel(ENV_FAKETMP, CUSTOM);
  ck.ok("P2f v2 匹配：哨兵槽位落 CUSTOM 且 root 字段=解析根（V6-56）", doc && doc.root === CUSTOM && doc.slot === 0, { doc });
}

/* ================================================================== */
/* P3 v2 失配 → 回退默认根 + stderr 告警（五实现全过；哨兵=毒指针落真根） */
/* ================================================================== */
{
  writePointer(CUSTOM, BADID); // 目标 root-id=RID ≠ 内嵌 BADID
  cleanArtifacts();
  const r = runJournal(ENV_FAKETMP);
  ck.ok("P3a v2 失配：journal 回退默认根", journalAt(DEF) && !journalAt(CUSTOM), { stderr: r.stderr.slice(0, 120) });
  ck.ok("P3b v2 失配：stderr 告警含回退语与 root-id 原因", r.stderr.includes("已回退默认根") && r.stderr.includes("root-id"), r.stderr.slice(0, 160));
  cleanArtifacts();
  const g = runGate(ENV_FAKETMP);
  ck.ok("P3c v2 失配：bg-gate 回退默认根", stampAt(DEF) && !stampAt(CUSTOM) && g.stderr.includes("已回退默认根"), { stderr: g.stderr.slice(0, 160) });
  cleanArtifacts();
  const s = runSession(ENV_FAKETMP);
  ck.ok("P3d v2 失配：session-start 回退（默认根无板 → 零简报）", s.stdout.trim() === "" && s.stderr.includes("已回退默认根"), { out: s.stdout.slice(0, 80), stderr: s.stderr.slice(0, 160) });
  cleanArtifacts();
  const m = runStopMirror(ENV_FAKETMP);
  ck.ok("P3e v2 失配：stop-check 镜像回退默认根", mirrorAt(DEF) && !mirrorAt(CUSTOM) && m.stderr.includes("已回退默认根"), { stderr: m.stderr.slice(0, 160) });
  cleanArtifacts();
  const doc = await runSentinel(ENV_FAKETMP, DEF);
  ck.ok(
    "P3f 毒指针下哨兵落真根：槽位在 DEF、root 字段=DEF、CUSTOM 零 sentinel/",
    doc && doc.root === DEF && !fs.existsSync(path.join(CUSTOM, "sentinel")),
    { doc },
  );
}

/* ================================================================== */
/* P4 v1 弱校验（旧格式兼容）：目标有 root-id → 采信 + stderr 提示       */
/* ================================================================== */
{
  writePointer(CUSTOM); // 单行 = v1 格式
  cleanArtifacts();
  const r = runJournal(ENV_FAKETMP);
  ck.ok("P4a v1+root-id：journal 采信 CUSTOM", journalAt(CUSTOM) && !journalAt(DEF), { stderr: r.stderr.slice(0, 160) });
  ck.ok(
    "P4b v1+root-id：stderr 旧格式提示（采信不回退）",
    r.stderr.includes("旧格式") && r.stderr.includes("自动升级") && !r.stderr.includes("已回退默认根"),
    r.stderr.slice(0, 160),
  );
  cleanArtifacts();
  const m = runStopMirror(ENV_FAKETMP);
  ck.ok("P4c v1+root-id：stop-check 镜像采信 CUSTOM", mirrorAt(CUSTOM) && !mirrorAt(DEF), { stderr: m.stderr.slice(0, 160) });
}

/* ================================================================== */
/* P5 v1 + 目标无 root-id（≤v0.4.0 旧版劫持 V6-30 中和）→ 拒            */
/* ================================================================== */
{
  writePointer(NOID);
  cleanArtifacts();
  const r = runJournal(ENV_FAKETMP);
  ck.ok("P5a v1 无 root-id：journal 拒绝回退默认根", journalAt(DEF) && !journalAt(CUSTOM), { stderr: r.stderr.slice(0, 160) });
  ck.ok("P5b v1 无 root-id：stderr 告警含 root-id 原因", r.stderr.includes("已回退默认根") && r.stderr.includes("root-id"), r.stderr.slice(0, 160));
  cleanArtifacts();
  const g = runGate(ENV_FAKETMP);
  ck.ok("P5c v1 无 root-id：bg-gate 拒绝回退默认根", stampAt(DEF) && !stampAt(CUSTOM), { stderr: g.stderr.slice(0, 160) });
}

/* ================================================================== */
/* P6 temp 目标（真实 os.tmpdir，两代通用毒根类）→ 拒                   */
/* ================================================================== */
{
  const poisonTmp = path.join(os.tmpdir(), "orch-rootct-poison-" + process.pid); // 不创建亦可：temp 判定先于存活
  writePointer(poisonTmp, RID);
  cleanArtifacts();
  const r = runJournal(ENV_PROJ); // 真实 tmpdir 判定
  ck.ok("P6a temp 目标：journal 拒绝回退默认根", journalAt(DEF) && !journalAt(CUSTOM), { stderr: r.stderr.slice(0, 160) });
  ck.ok("P6b temp 目标：stderr 告警含临时目录原因", r.stderr.includes("已回退默认根") && r.stderr.includes("临时目录"), r.stderr.slice(0, 160));
}

/* ================================================================== */
/* P7 悬空指针 → 回退 + 告警（v0.4.1 行为保留）                         */
/* ================================================================== */
{
  writePointer(GONE);
  cleanArtifacts();
  const r = runJournal(ENV_FAKETMP);
  ck.ok("P7a 悬空指针：journal 回退默认根", journalAt(DEF) && !journalAt(CUSTOM), { stderr: r.stderr.slice(0, 160) });
  ck.ok("P7b 悬空指针：stderr 告警含不存在原因", r.stderr.includes("已回退默认根") && (r.stderr.includes("不存在") || r.stderr.includes("不是目录")), r.stderr.slice(0, 160));
}

/* ================================================================== */
/* P8 项目外普通存活目录（非 temp 非存储根，V6-31 专属）→ v2 缺 id 拒   */
/* ================================================================== */
{
  writePointer(PLAIN, BADID);
  cleanArtifacts();
  const g = runGate(ENV_FAKETMP);
  ck.ok("P8 项目外存活目录：bg-gate 拒绝回退默认根（缺 root-id）", stampAt(DEF) && !stampAt(CUSTOM) && g.stderr.includes("root-id") && g.stderr.includes("已回退默认根"), { stderr: g.stderr.slice(0, 160) });
}

/* ================================================================== */
/* P9 空指针 → 视同无指针（静默默认根）                                 */
/* ================================================================== */
{
  writePointer("");
  cleanArtifacts();
  const r = runJournal(ENV_PROJ);
  ck.ok("P9 空指针：静默落默认根（stderr 无告警）", journalAt(DEF) && !r.stderr.includes("root.txt"), { stderr: r.stderr.slice(0, 120) });
}

/* ================================================================== */
/* P10 stop-check 主流程（非镜像路径）：采信根清点 / 拒绝根静默          */
/* ================================================================== */
{
  writePointer(CUSTOM, RID);
  cleanArtifacts();
  const ok = runStopMain(ENV_FAKETMP);
  ck.ok("P10a v2 匹配：stop-check 主清点读 CUSTOM 板", ok.stdout.includes("收工前清点") && ok.stdout.includes("m-open"), { out: ok.stdout.slice(0, 120) });
  writePointer(CUSTOM, BADID);
  cleanArtifacts();
  const bad = runStopMain(ENV_FAKETMP);
  ck.ok("P10b v2 失配：stop-check 主清点回退后静默（默认根无板）", bad.stdout.trim() === "" && bad.stderr.includes("已回退默认根"), { stderr: bad.stderr.slice(0, 160) });
}

/* ================================================================== */
/* W22 祖先回退（v1.1.1）：默认根无板无 root-id → 取最近合法祖先根        */
/* 覆盖：env 态 / cwd 态双态命中、journal/session-start/bg-sentinel 三处、 */
/*      祖先缺 root-id 不命中、默认根有 root-id 不回退、空指针回退同走祖先 */
/* ================================================================== */
{
  // RC1 env 态（ZCODE_PROJECT_DIR 指向子目录 + cwd=子目录）：journal 落祖先根
  cleanAnc();
  const r1 = runJournal(ENV_ANC, ANC_SUB);
  ck.ok("W22-RC1a env 态：祖先回退命中（journal 落祖先根，子目录默认根零写）", journalAt(ANC_ROOT) && !journalAt(ANC_TOP), { stderr: r1.stderr.slice(0, 160) });
  ck.ok("W22-RC1b 祖先回退 stderr 一行告警且携解析根路径", r1.stderr.includes("定根回退") && r1.stderr.includes(ANC_ROOT), r1.stderr.slice(0, 200));
  // RC2 仅 cwd 态（ZCODE_PROJECT_DIR 未注入 → process.cwd() = 子目录）
  cleanAnc();
  const r2 = runJournal(ENV_ANC_CWD, ANC_SUB);
  ck.ok("W22-RC2a cwd 态：祖先回退命中（journal 落祖先根）", journalAt(ANC_ROOT) && !journalAt(ANC_TOP), { stderr: r2.stderr.slice(0, 160) });
  // RC3 session-start 同规范
  cleanAnc();
  const s3 = runSession(ENV_ANC, ANC_SUB);
  ck.ok("W22-RC3a session-start：读祖先根板（简报含 m-anc）", s3.stdout.includes("m-anc"), { out: s3.stdout.slice(0, 120), stderr: s3.stderr.slice(0, 160) });
  // RC3b（v1.1.1 W24 ③c）：工作区锚提升——祖先回退命中后 coord-workspace.txt=祖先项目根，
  // 不再是 cwd 子目录（否则 watcher 精确匹配 workspace-list 时 bridge-anchor-mismatch）
  const ws3 = fs.readFileSync(path.join(ANC_ROOT, "sentinel", "coord-workspace.txt"), "utf8");
  ck.ok("W24-RC3b session-start 工作区锚提升：祖先回退命中后 coord-workspace.txt=祖先项目根（非 cwd 子目录）",
    ws3 === path.resolve(ANC_PROJ) + "\n" && ws3 !== path.resolve(ANC_SUB) + "\n",
    { ws: ws3, stderr: s3.stderr.slice(0, 160) });
  // RC4 bg-sentinel 同规范（无 --root 走 locateRoot）
  cleanAnc();
  const doc = await runSentinel(ENV_ANC, ANC_ROOT, ANC_SUB);
  ck.ok("W22-RC4a bg-sentinel：槽位落祖先根且 root 字段=祖先根", doc && doc.root === ANC_ROOT && doc.slot === 0, { doc });
  // RC5（v1.1.1 W24 ③b）stop-check 两条路径同规范祖先回退：主清点（env/cwd 双态）+ 镜像记录
  cleanAnc();
  const r5a = runStopMain(ENV_ANC, ANC_SUB);
  ck.ok("W24-RC5a stop-check 主清点 env 态：祖先回退命中（读祖先根板 m-anc，子目录默认根零写）",
    r5a.stdout.includes("收工前清点") && r5a.stdout.includes("m-anc") && !fs.existsSync(ANC_TOP),
    { out: r5a.stdout.slice(0, 160), stderr: r5a.stderr.slice(0, 160) });
  cleanAnc();
  const r5b = runStopMain(ENV_ANC_CWD, ANC_SUB);
  ck.ok("W24-RC5b stop-check 主清点 cwd 态：祖先回退命中（读祖先根板 m-anc）",
    r5b.stdout.includes("m-anc") && !fs.existsSync(ANC_TOP), { out: r5b.stdout.slice(0, 160), stderr: r5b.stderr.slice(0, 160) });
  cleanAnc();
  const r5c = runStopMirror(ENV_ANC, ANC_SUB);
  ck.ok("W24-RC5c stop-check 镜像记录路径：祖先回退命中（journal 落祖先根，子目录零写）",
    mirrorAt(ANC_ROOT) && !mirrorAt(ANC_TOP), { stderr: r5c.stderr.slice(0, 160) });
  // RC6 祖先缺 root-id → 不命中（防误判条件实证；静默默认根）
  const r6 = runJournal({ ZCODE_PROJECT_DIR: ANC_NOID_SUB }, ANC_NOID_SUB);
  ck.ok("W22-RC6a 祖先缺 root-id：不命中（journal 落子目录默认根）", journalAt(ANC_NOID_TOP) && !journalAt(ANC_NOID_ROOT), { stderr: r6.stderr.slice(0, 160) });
  ck.ok("W22-RC6b 祖先缺 root-id：无回退告警（静默默认根）", !r6.stderr.includes("定根回退"), r6.stderr.slice(0, 160));
  // RC7 默认根有 root-id（新项目还没板）→ 不回退（防把新项目误判到父项目）
  fs.mkdirSync(ANC_TOP, { recursive: true });
  fs.writeFileSync(path.join(ANC_TOP, "root-id"), RID + "\n");
  cleanAnc();
  const r7 = runJournal(ENV_ANC, ANC_SUB);
  ck.ok("W22-RC7a 默认根有 root-id（无板）：不回退（journal 落默认根）", journalAt(ANC_TOP) && !journalAt(ANC_ROOT), { stderr: r7.stderr.slice(0, 160) });
  rmrf(ANC_TOP);
  // RC8 空指针（≈无指针）回退同样走祖先回退
  fs.mkdirSync(ANC_TOP, { recursive: true });
  fs.writeFileSync(path.join(ANC_TOP, "root.txt"), "");
  cleanAnc();
  const r8 = runJournal(ENV_ANC, ANC_SUB);
  ck.ok("W22-RC8a 空指针回退：亦采用祖先根（journal 落祖先根 + 告警）", journalAt(ANC_ROOT) && !journalAt(ANC_TOP) && r8.stderr.includes("定根回退"), { stderr: r8.stderr.slice(0, 160) });
  rmrf(ANC_TOP);
  cleanAnc();
}

/* ================================================================== */
/* W24 ③a 五处 root 块 twin 一致性（v1.1.1 CONS 收尾波）                */
/* 硬标准=可执行代码逐字一致；注释面同波统一（祖先回退块整段同文）        */
/* ================================================================== */
{
  const HOOK_NAMES = ["bg-gate", "bg-sentinel", "journal", "session-start", "stop-check"];
  const extractRootBlock = (src) => {
    const start = src.indexOf("/* --- root-id 契约校验定根");
    const lr = src.indexOf("function locateRoot(", start);
    if (start < 0 || lr < 0) return null;
    let i = src.indexOf("{", lr);
    let depth = 0;
    let end = -1;
    for (; i >= 0 && i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    return end > 0 ? src.slice(start, end) : null;
  };
  // 可执行代码口径：去块注释/行注释 + 行首尾空白与空行归一（CRLF 已在读入时归一）
  const execOnly = (s) =>
    s
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
  const rawByHook = {};
  const execHash = {};
  for (const name of HOOK_NAMES) {
    const src = fs.readFileSync(path.join(HOOKS, name + ".mjs"), "utf8").replace(/\r\n/g, "\n");
    const block = extractRootBlock(src);
    rawByHook[name] = block;
    execHash[name] =
      block == null ? "MISSING" : crypto.createHash("sha256").update(execOnly(block)).digest("hex");
  }
  const execUniq = new Set(Object.values(execHash));
  ck.ok(
    "W24-TWIN-01 五处 root 块可执行代码逐字一致（去注释+去空行归一后 sha256 全同）",
    execUniq.size === 1 && !Object.values(execHash).includes("MISSING"),
    execHash,
  );
  const rawUniq = new Set(Object.values(rawByHook));
  ck.ok(
    "W24-TWIN-02 五处 twin 注释统一：祖先回退块整段（注释+代码）逐字同文，CRLF 归一后逐字节相等",
    rawUniq.size === 1 && !Object.values(rawByHook).includes(null),
    { sizes: Object.fromEntries(HOOK_NAMES.map((n) => [n, rawByHook[n] == null ? "MISSING" : Buffer.byteLength(rawByHook[n])])) },
  );
}

/* ================================================================== */
/* S server 发布/自愈侧行（V6-12 归簇 A/A1 并行施工中）                  */
/* 行为探测：对全新根（无任何 fixture 预置文件）启动 server，看是否签发  */
/* root-id。未落地 → 挂起一条非阻塞断言（G 发版门前按 impl-plan 回扫）； */
/* 落地 → 全套真实断言。                                                */
/* ================================================================== */
{
  const SVROOT = path.join(BASE.root, "sv-root"); // 全新干净根：探测不带预置 root-id
  clearPointer();
  // boot(root, env)：initialize 仅作就绪栅栏。env 语义与 hooks 侧一致——
  // 真实 tmpdir env 用于 temp guard 行（S2/S3），TMPFAKE env 用于让 CUSTOM
  // （fixture 目标根，BASE 下、TMPFAKE 外）被视为非 temp 的自愈行（S4/S5）。
  const boot = async (root, env = ENV_PROJ) => {
    const s = startServer({ root, cwd: PROJ, env });
    try {
      await s.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "root-contract", version: "0.0.1" },
      });
    } catch {
      /* initialize 仅作就绪栅栏，失败不中断（文件断言在 close 后进行） */
    } finally {
      s.close();
      await sleep(200);
    }
  };
  let detected = false;
  try {
    await boot(SVROOT);
    detected = fs.existsSync(path.join(SVROOT, "root-id"));
  } finally {
    clearPointer();
  }
  if (!detected) {
    ck.ok(
      "S0 server 发布/自愈侧行挂起（A1 未落地，非阻塞——G 发版门前须回扫本套启用 S1..S5）",
      true,
      "awaiting A1: server root-id publish not present at current HEAD",
    );
  } else {
    // S1 root-id 格式：16 hex + 换行
    const raw = fs.readFileSync(path.join(SVROOT, "root-id"), "utf8");
    ck.ok("S1 server 签发 root-id 格式（16 hex + 换行）", /^[0-9a-f]{16}\n?$/.test(raw), { raw: JSON.stringify(raw) });
    // S2 temp 自定义根不发布指针（temp guard 对称；真实 tmpdir 判定，SVROOT 在其中）
    clearPointer();
    await boot(SVROOT);
    ck.ok("S2 server temp 根不发布指针（temp guard）", !fs.existsSync(POINTER), undefined);
    // S3 root-id 持久稳定：重启不变
    const id1 = fs.readFileSync(path.join(SVROOT, "root-id"), "utf8").trim();
    await boot(SVROOT);
    const id2 = fs.readFileSync(path.join(SVROOT, "root-id"), "utf8").trim();
    ck.ok("S3 server root-id 持久稳定（重启沿用）", id1 === id2 && id1.length === 16, { id1, id2 });
    // S4 自愈强清理：默认根运行 + 遗留 v2 失配指针 → 删除（CUSTOM 带真 root-id=RID）
    writePointer(CUSTOM, BADID);
    await boot(DEF, ENV_FAKETMP);
    ck.ok("S4 server 自愈强清理：v2 失配遗留指针被删", !fs.existsSync(POINTER), undefined);
    // S5 自愈保留：v1 格式且目标含 root-id → 保留待重启升级
    writePointer(CUSTOM);
    await boot(DEF, ENV_FAKETMP);
    ck.ok("S5 server 自愈保留：v1+目标含 root-id 指针不删（待重启升级）", fs.existsSync(POINTER), undefined);
  }
  clearPointer();
}

/* ---------------- 收尾 ---------------- */
clearPointer();
BASE.cleanup();
const { fail, pass } = ck.summary();
process.exit(fail ? 1 : 0);
