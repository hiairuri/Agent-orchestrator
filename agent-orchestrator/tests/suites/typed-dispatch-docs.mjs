#!/usr/bin/env node
// @module typed-dispatch-docs
/*!
 * suites/typed-dispatch-docs.mjs —— v0.6 簇 C 断言套（V6-63 文档在位防回退 + V6-64 到期回收机制载体）
 *
 * 如实声明：纯 Node 断言测不了宿主 typed 派发行为；本 suite 只测文档/配置在位，防回退。
 * 覆盖 27 组断言（W-C §2 表 + v0.8 W4 增例 + v0.9 P2-① HOST-01；v1.4 W1 增 A1-06/07+B3-01/02+C2-03 五腿，
 *   权威 designs/agent-orchestrator-v1.4-planning/design.md §2.1；A-COMPAT-1/A-V080-DOC-01 随 ba92054
 *   双前缀实名基线复位改锚；v1.6 W3b 增 A-V0160-W9-01；v1.6.5 增 A-v0165-PERSONA-FACE
 *   （fork (a) R2 活化看护：单前缀 face 形+roster 在册+disallowed∩tools=∅））：
 *   A-AGENTS-1 / A-SKILL-1..5 / A-DOC-V4P11/V4P12/V4P21/V4P23·24/V4P31/
 *   SIGNALS/FAILOPEN/V4P25 / A-COMPAT-1 / A-ROLE-DISALLOWED / A-PLUGIN-STUB / A-RECYCLE-1 /
 *   A-V080-DOC-01（v1.6 W3b 换血：orch-gleaner persona 件已删除——在册腿退役转缺席负向）/
 *   A-V080-DOC-02（SKILL §10「记忆与现场」在案+标记对逐字串，
 *   权威 designs/agent-orchestrator-v0.8-DESIGN.md §10/§14；静态在位断言）/
 *   A-V090-HOST-01（C6 findings 文件存在+§0 判定串+§1 锚点串在册口径；权威 designs/agent-orchestrator-v0.9-C6-findings.md
 *   §3/§5-2 移交语义 + v0.9-DESIGN §16 HOST-01 行；静态在位断言）。
 * v1.6 W3b 套件换血（impl-plan §2 W3b ⑦/W9；design §3.2 W9）：typed 参数退役（v1.6 W-p）+组装链退役
 *   （v1.6 W3a）后本套 5 腿过渡态红（A1-07/B3-01/B3-02/A-SKILL-4/A-V0140-C2-03——W3a 波首申报，
 *   EXTRA⑥ 计划内）全数收口：改锚 W3a 落装新句逐字（DP-3 固定指针模板护栏/TS-19a 编号出口废止句/
 *   §3 派发头模板/PL-10 W15 换装字面）+typed 调度面旧字面零残留新钉（A-V0160-W9-01）。
 *   套件名波首对拍（2026-11-05）：typed-dispatch-docs 名**保留**——改名涉 run-all REGISTRY 行
 *   +module-index 行（本波清单外），head 注记承载语义（现役=派发文档在位防回退，typed 原语面退役）。
 * 回收机制（W-C §3）：RECYCLE_LIST R-1..R-4 导出常量（宿主修复事件触发的人工维护清单，已收官）。
 *   v1.4 W1（改2-改4/改8，design v1.4 §2.2）：宿主修复事件已判定（typed-probe-20261101 归因翻面
 *   +ba92054 修复）——R-1..R-4 anchor 全部改锚翻面后新字面、recycleAction 记「已于 v1.4.0 翻面执行」。
 *   v1.5 W3-M1（T6 退役）：env ORCH_HOST_FIXED=1 回收双模分支摘除（该模式对已翻面锚语义=历史机制，
 *   见台账 v1.4.0.md W1 节注记），套件改单模式——各 anchor 在位断言保留（防回退）；R-2 永久条款
 *   （「report 全名保留不删」）为永久不变量（A-COMPAT-1 承载），不在回收范围；
 *   E-05/E-06/E-07 条目中「宿主快照缺陷期间」限定语随 R-2 同批复核；E-13/E-14 不回收。
 *   R-5（plugin.json 两键「兼容存根」）已于 2026-10-21 随 E-18 方案乙开关出清册（回收完成）：
 *   V6-24 实现侧（V7-05 numArgOpt 稀疏写）先行落地、桥接语义复邦；A-DOC-V4P12/A-PLUGIN-STUB
 *   同步切换为断言乙稿桥接措辞在位，方案甲存根短语改列 ban（防复发回退）。
 *
 * TODO(issue): 上游 issue 稿（宿主 startup snapshot 缺陷，证据链 designs/dispatch-probe-20261014/）
 *   待 V6-61 定稿提交后回填编号，并同步回填 RECYCLE_LIST 各条 issue 字段。
 *
 * 运行方式：node tests/suites/typed-dispatch-docs.mjs（ORCH_HOST_FIXED=1 回收核对模式已随 v1.5 退役）
 * v1.2.3 W1 守卫（主控扩授裁决 m-20261030-060549-56b4）：AGENTS.md（A-AGENTS-1/A-DOC-V4P25/
 *   R-4）与 designs/（A-V090-HOST-01）缺席（OSS 发布快照 checkout 永不含 AGENTS.md，66757fd
 *   untrack）→ skip 带标记不崩不红；主仓在盘时全量断言不弱化。
 * 前置：node >= 20；零依赖（node:fs + node:assert/strict）。退出码：全绿 0；任一 FAIL 非 0。
 * 失败信息规范：断言 ID + 缺失子串 + 回写指针（designs/agent-orchestrator-v0.6-W-C-findings.md §1 E-xx），
 *   断言红时零查证即可按指针补稿。
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
// v1.6.5 A-v0165-PERSONA-FACE：roster 在册判定走 import TOOLS 运行时计量（po-static W0 复测门同法；
// 非源码语义单文件读——registry 裸名翻面后 TOOLS names 即 13 裸名 roster）。
import { TOOLS } from "../../mcp/server-registry.mjs";

const SUITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(SUITE_DIR, "..", "..");
const REPO_ROOT = path.resolve(PLUGIN_DIR, "..", "..");
const FILES = {
  skill: path.join(PLUGIN_DIR, "skills", "agent-orchestrator", "SKILL.md"),
  agentWorker: path.join(PLUGIN_DIR, "agents", "orch-worker.md"),
  agentScout: path.join(PLUGIN_DIR, "agents", "orch-scout.md"),
  agentReviewer: path.join(PLUGIN_DIR, "agents", "orch-reviewer.md"),
  // v1.6 W3b：agentGleaner 条目随 orch-gleaner.md 删除退役（缺席负向腿 A-V080-DOC-01 内联构造路径）。
  // v1.1.2 I1 双新模板入扫（D2 §6 断言处置表：A-COMPAT-1/A-ROLE-DISALLOWED 扩域——策划/计划
  // frontmatter 形状与四角色同锁：tools 含 report 全名、disallowedTools 含三沙箱面全名）。
  agentPlanner: path.join(PLUGIN_DIR, "agents", "orch-planner.md"),
  agentPlan: path.join(PLUGIN_DIR, "agents", "orch-plan.md"),
  pluginJson: path.join(PLUGIN_DIR, ".zcode-plugin", "plugin.json"),
  agentsMd: path.join(REPO_ROOT, "AGENTS.md"),
  c6Findings: path.join(REPO_ROOT, "designs", "agent-orchestrator-v0.9-C6-findings.md"),
};
const REPORT = "mcp__plugin_agent-orchestrator_orch__report";
// v1.4 W1 基线复位（计划外发现；ba92054 残留）：ba92054（v1.3.0）把 agents/*.md frontmatter
// tools 白名单改宿主注册双前缀实名（单前缀名≠注册名=typed 拒收根因）——frontmatter 面两腿
// （A-COMPAT-1/A-V080-DOC-01）随之改锚双前缀实名；SKILL 正文钉仍用 REPORT 单形不受影响。
// v1.6.5 fork (a) 再翻沿革（leg 2）：server 端内嵌前缀退役（server-registry 裸名注册，宿主在其
// 命名空间前缀上组合短名，面名=mcp__plugin_agent-orchestrator_orch__<short>）——*_TYPED 三常量
// 翻回单前缀 face 形（=REPORT canonical 形）；归因双腿记录落 SKILL RP-6/PT-8；R2 活化面
// （disallowedTools 单前缀条目自本版起开始匹配）由 A-v0165-PERSONA-FACE 新腿看护。
const REPORT_TYPED = "mcp__plugin_agent-orchestrator_orch__report";
const PROBE_TYPED = "mcp__plugin_agent-orchestrator_orch__probe";
const LESSONS_TYPED = "mcp__plugin_agent-orchestrator_orch__lessons";
const SNAPSHOT_ERR = "Required MCP tool is not available in the parent startup snapshot";
const POINTER = "designs/agent-orchestrator-v0.6-W-C-findings.md";
const V08_POINTER = "designs/agent-orchestrator-v0.8-DESIGN.md";
const C6_POINTER = "designs/agent-orchestrator-v0.9-C6-findings.md";

/**
 * RECYCLE_LIST（V6-64 到期回收对象；W-C §3）——宿主修复事件判定后按 recycleAction 逐条回收。
 * trigger 固定 "host-fixed"；issue 为占位，V6-61 上游 issue 提交后回填编号。
 */
export const RECYCLE_LIST = [
  {
    id: "R-1",
    file: FILES.skill,
    // v1.4 W1 改2（design v1.4 §2.2；SKILL RP-1 尾句 v1.4 翻面）：anchor 随新字面。
    anchor: "The primary dispatch form = the nested assembly exit", // v1.6.2 W5 重订=英文现态句（RP-1）
    // v1.5 W3-M1 注记压缩：v1.4 W1 改2 括注（typed 主形态/GP+persona 降级备选表述已落装）随双模退役收编（见头注回收机制段）。
    recycleAction: "已于 v1.4.0 翻面执行",
    trigger: "host-fixed",
    issue: "TODO-V661（上游 issue 编号，V6-61 定稿提交后回填）",
  },
  {
    id: "R-2",
    file: FILES.skill,
    // v1.4 W1 改3：anchor→「GP+persona 注入为降级备选」（按逐字稿）；「保留不删」附属不动。
    anchor: "Protocol (host fallback)", // v1.6.2 W5 重订=英文现态句（RP-3 宿主降级通道头）
    // v1.5 W3-M1 注记压缩：永久不变量语义保留（承载面=A-COMPAT-1+头注回收机制段）。
    recycleAction: "已于 v1.4.0 翻面执行（「report 全名保留不删」为永久不变量，不在回收范围）",
    trigger: "host-fixed",
    issue: "TODO-V661（上游 issue 编号，V6-61 定稿提交后回填）",
  },
  {
    id: "R-3",
    file: FILES.skill,
    // v1.4 W1 改4：R-3 锚实位=SKILL :379 DL-6 行（research R1.1 记 :230 RP-3 系坐标偏差；
    // 波首步 grep 复位——「宿主快照缺陷期间」限定语随 M-5 语义保留取向同批翻面）。
    anchor: "prompt=<archetype body>", // v1.6.2 W5 重订=英文现态句（RP-3 注入形）
    recycleAction: "已于 v1.4.0 翻面执行（池工降级通道限定语已翻面）",
    trigger: "host-fixed",
    issue: "TODO-V661（上游 issue 编号，V6-61 定稿提交后回填）",
  },
  {
    id: "R-4",
    file: FILES.agentsMd,
    // v1.4 W1 改8：活体 AGENTS.md 已于 2026-11-01 翻面（typed-probe-20261101.md）——
    // anchor 改锚活体在盘字面「勿盲降级」（波首步 grep 复核命中=1）；recycleAction 同步。
    anchor: "do not blindly downgrade", // v1.6.2 W5 重订=活体英文字面（域外数据面外部重写，波外事件）
    // v1.5 W3-M1 注记压缩：v1.4 W1 改8 括注（活体归因段已翻面，锚随新字面）随双模退役收编。
    recycleAction: "已于 v1.4.0 翻面执行",
    trigger: "host-fixed",
    issue: "TODO-V661（上游 issue 编号，V6-61 定稿提交后回填）",
  },
];

/** 便捷断言器：输出体例与 harness Checker 一致（PASS/FAIL 行 + SUITE 尾行，run-all 可解析）。 */
class DocChecker {
  constructor(label) { this.label = label; this.pass = 0; this.fails = []; this.lines = []; }
  ok(name, cond, extra) {
    if (cond) { this.pass++; this.lines.push("PASS " + name); }
    else { this.fails.push(name); this.lines.push("FAIL " + name + (extra ? " | got: " + extra : "")); }
  }
  summary() { console.log(this.lines.join("\n")); const tail = `SUITE ${this.label} pass=${this.pass} fail=${this.fails.length}`; console.log(tail); return { pass: this.pass, fail: this.fails.length }; }
}

const readFile = (p) => fs.readFileSync(p, "utf8");
const section = (text, startMark, endMark) => {
  const a = text.indexOf(startMark);
  if (a < 0) return "";
  const b = text.indexOf(endMark, a + startMark.length);
  return b > a ? text.slice(a, b) : text.slice(a);
};
const frontmatterLine = (text, key) => text.split("\n").find((l) => l.startsWith(key + ":")) || "";
const firstMissing = (text, subs) => subs.find((s) => !text.includes(s)) || null;
const firstPresent = (text, subs) => subs.find((s) => text.includes(s)) || null;

/** 子串组断言：need 全部在位且 ban 全部不在位才绿；fail 信息带 ID + 缺失/未清子串 + 回写指针。 */
function subGroup(ck, id, targetLabel, text, { need = [], ban = [] }, editRef) {
  const miss = firstMissing(text, need);
  const stale = firstPresent(text, ban);
  const cond = !miss && !stale;
  const extra = miss
    ? `${id} 缺失子串: ${JSON.stringify(miss)} @ ${targetLabel} —— 回写指针: 见 ${POINTER} §1 ${editRef}`
    : stale
      ? `${id} 应已移除的旧措辞仍在位: ${JSON.stringify(stale)} @ ${targetLabel} —— 回写指针: 见 ${POINTER} §1 ${editRef}`
      : "";
  ck.ok(`${id} @ ${targetLabel}`, cond, extra);
}

function main() {
  const ck = new DocChecker("typed-dispatch-docs");
  const skill = readFile(FILES.skill);
  // v1.2.3 W1 守卫（主控扩授裁决 m-20261030-060549-56b4）：AGENTS.md 与 designs/ 自 66757fd
  // untrack（OSS 发布快照剔除面，AGENTS.md 永不在发布 checkout）——硬读在干净 worktree 必
  // ENOENT 崩溃（基线 stash 复跑实证）。守卫语义=缺席 skip 带标记；主仓在盘时全量断言不弱化
  // （在盘分支与原实现同语义，G1 发版门强度不减）。
  const agentsMdExists = fs.existsSync(FILES.agentsMd);
  const agentsMd = agentsMdExists ? readFile(FILES.agentsMd) : "";
  const skill3 = section(skill, "## 3.", "## 4.");
  const skill4 = section(skill, "## 4.", "## 5.");
  const skill8 = section(skill, "## 8.", "## 9.");
  const skill9 = section(skill, "## 9.", "## 10.");
  const agentFiles = [
    ["orch-worker.md", FILES.agentWorker],
    ["orch-scout.md", FILES.agentScout],
    ["orch-reviewer.md", FILES.agentReviewer],
    ["orch-planner.md", FILES.agentPlanner],
    ["orch-plan.md", FILES.agentPlan],
  ];
  const agentTexts = agentFiles.map(([name, p]) => [name, readFile(p)]);
  const pj = JSON.parse(readFile(FILES.pluginJson));

  // ---- 编辑单落地断言（W-C §2 表；判据列逐条对应）----
  if (agentsMdExists) {
    // v1.4 W1 改5（基线红复位，H-2）：活体 AGENTS.md 已于 2026-11-01 翻面——need 改锚
    // 活体在盘字面（波首步 grep 复核：「归因已翻面终定」:54 命中=1、「勿盲降级」命中=1）；
    // AGENTS.md 正文零写入（活体已翻面，只改锚）。
    // v1.6.2 W6b 4low-4（w6a-review §三 #4 主控裁定 (a)）：「恢复主形态」need 悬于 orch-mem
    // 记忆区（AGENTS.md 归敛代理维护、每轮浓缩可改写=已知脆面）——降级容错断言：该 need 在场=
    // 全量断言不弱化（两 need+ban 照核）；缺席=[SKIP] 带标记容错（gleaning-maintained block
    // rewritten，归敛改写不再红）。硬腿不降级：ban 串（旧措辞「原生角色派发需全新会话」）在场
    // 仍=FAIL；稳定 need（"do not blindly downgrade"）仍硬断言。AGENTS.md 本体零触（域外数据面）。
    const legacyModeNeedPresent = agentsMd.includes("恢复主形态");
    subGroup(
      ck,
      "A-AGENTS-1",
      "AGENTS.md",
      agentsMd,
      legacyModeNeedPresent
        ? { need: ["恢复主形态", "do not blindly downgrade"], ban: ["原生角色派发需全新会话"] }
        : { need: ["do not blindly downgrade"], ban: ["原生角色派发需全新会话"] },
      "E-01",
    ); // v1.6.2 W5 重订：AGENTS.md=域外数据面已外部英化重写（波外事件），锚随活体字面（v1.6.2.md 台账注记）；W6b 4low-4 need 串容错化
    if (!legacyModeNeedPresent) {
      ck.ok("A-AGENTS-1 need[恢复主形态] @ AGENTS.md orch-mem block [SKIP: gleaning-maintained block rewritten - tolerance per v1.6.2 4low-4 ruling (a), w6a-review §3 #4]", true);
    }
  } else {
    ck.ok("A-AGENTS-1 @ AGENTS.md [SKIP: AGENTS.md untracked absent in worktree checkout]", true);
  }
  subGroup(ck, "A-SKILL-1", "SKILL.md §8 (primary dispatch form)", skill8, { need: [REPORT, "Dual channels", "KIND="] }, "E-04"); // v1.6.2 W5 重订=英文 RP-4

  { // A-SKILL-2：「仅终态」与「哨兵联动」须同句（E-04 降级通道缺口声明）
    const sent = skill8.split("\n").find((l) => l.includes("final state only"));
    const cond = Boolean(sent && sent.includes("sentinel linkage"));
    ck.ok("A-SKILL-2 @ SKILL.md §8 same sentence carries final-state-only + sentinel linkage (W5 re-pin English)", cond,
      `A-SKILL-2 缺失同句声明（仅终态+哨兵联动） @ SKILL.md §8 —— 回写指针: 见 ${POINTER} §1 E-04`);
  }

  subGroup(ck, "A-SKILL-3", "SKILL.md §9（坑位清单）", skill9, { need: [SNAPSHOT_ERR, "validation face", "execution face", "fallback", "never retry"] }, "E-05"); // v1.6.2 W5 重订=英文 PT-8 行四锚
  // A-SKILL-4 语义更新（W2 重排裁决，策划档 §4.2）：原钉 §3 模板内「## REPORT（双通道）」示例节；
  // buildPackMarkdown 实际不产出该节（Stage A §0 实测），W2 删幻影示例并改钉「模板同构 + 无幻影节」。
  // v1.1 W3（C 面）：`prompt_template` 回显已从 context_pack 返回删除（回执=包 CONTRACT 单源；
  // N4 白名单锁在 crv2-pack）。
  // v1.1 W4（A1/Q5a）：CONTRACT 三行自派发 prompt 头移尾块——§3 增钉「尾块」措辞与尾块模板。
  // v1.6 W3b 换血改锚（W3a W11 落装新句逐字）：§3=派发头模板（DP-3 固定指针模板双位同文）+
  // RETURN ≤3 行指针态模板行；旧「**派发 prompt 尾块**」粗体锚随组装退役改列 ban（A-SKILL-4
  // 过渡态红收口，台账 v1.6.0.md §W3b）。
  subGroup(ck, "A-SKILL-4", "SKILL.md §3 模板结构", skill3, {
    // v1.6.2 W5 重订=英文双位形（tool-pack 发射串同文）；D2-20 三行+{pack_path} 槽位冻结
    need: ["## CONTRACT (three-line contract; also mirrored at the tail of the dispatch prompt)", "**Dispatch header template**", "the three-line contract's sole authority is the pack CONTRACT", "[channel] {mission_id}", "[worker] {worker 名}", "[token] {token}", "KIND=<kind> | artifacts: <paths> | leftover: <one sentence>"],
    ban: ["## REPORT（双通道）", "**派发 prompt 尾块**"],
  }, "E-06+v1.6.0.md §W3b");
  // v1.4 W1 改1（防御性改锚，design v1.4 §2.2）：SNAPSHOT_ERR 症状格保留+「GP+persona」
  // 保留字样维持；新增 ba92054 翻面锚（:183 处置格新字面）防漂移。
  subGroup(ck, "A-SKILL-5", "SKILL.md §4", skill4, { need: [SNAPSHOT_ERR, "host typed-dispatch defect", "fixed in-repo"] }, "E-07"); // v1.6.2 W5 重订=英文现态句；ba92054 版本字面随 W3 沿革清理由退役（R-D/喂账③裁定）
  subGroup(ck, "A-DOC-V4P11", "SKILL.md", skill, { need: ["2MB cap", "rolling eviction"], ban: ["400 条"] }, "E-08"); // W5 重订英文
  subGroup(ck, "A-DOC-V4P21", "SKILL.md", skill, { need: ["decay time constant"], ban: ["30 天半衰"] }, "E-09"); // W5 重订英文
  subGroup(ck, "A-DOC-V4P12", "SKILL.md", skill, { need: ["bridge keys are reachable", "bridge keys", "minimum gap between two shots"], ban: ["无实际效果", "v0.3 兼容存根"] }, "E-10"); // W5 重订英文 WU-4
  subGroup(ck, "A-DOC-V4P23/24", "SKILL.md", skill, { need: ["[soft: the server does not enforce presence", "schema-declared only"] }, "E-11"); // W5 重订英文 TS-12
  subGroup(ck, "A-DOC-V4P31", "SKILL.md", skill, { need: ["action=upsert/get/list/ack/claim"] }, "E-12"); // W5 重订英文 TS-1
  subGroup(ck, "A-DOC-SIGNALS", "SKILL.md", skill, { need: ["signals", "= the sentinel-side built-in defaults"] }, "E-13"); // W5 重订英文 TS-8
  subGroup(ck, "A-DOC-FAILOPEN", "SKILL.md", skill, { need: ["not a defense line", "timeoutMs=10000"] }, "E-14"); // W5 重订英文 PT-5
  if (agentsMdExists) {
    subGroup(ck, "A-DOC-V4P25", "AGENTS.md", agentsMd, { need: ["never use line count as an anchor"] }, "E-02"); // v1.6.2 W5 重订=活体英文字面
  } else {
    ck.ok("A-DOC-V4P25 @ AGENTS.md [SKIP: AGENTS.md untracked absent in worktree checkout]", true);
  }

  { // A-COMPAT-1：角色模板 tools: 行均含 report 全名（v1.6.5 fork (a) 再翻=单前缀 face 形；v1.4 W1 基线复位→v1.6.5 leg 2 沿革见 consts 注记）+ SKILL §8「保留不删」永久条款（V6-68 不变量守护；v1.1.2 I1 起扫五文件=四角色+planner/plan）
    const bad = [];
    for (const [name, text] of agentTexts) {
      const line = frontmatterLine(text, "tools");
      if (!line.includes(REPORT_TYPED)) bad.push(`${name} tools 行缺 report 全名（单前缀 face 形）`);
    }
    if (!skill8.includes("Keep, do not delete")) bad.push("SKILL.md §8 missing Keep, do not delete (RP-7)"); // v1.6.2 W5 重订=英文 RP-7
    ck.ok("A-COMPAT-1 @ agents/*.md tools 行 + SKILL §8 保留不删", bad.length === 0,
      bad.length ? `A-COMPAT-1 不变量受损: ${bad.join("; ")} —— 回写指针: 见 ${POINTER} §1 E-15` : "");
  }

  { // A-ROLE-DISALLOWED：角色模板 disallowedTools 行均含 sandbox_apply/sandbox_discard/agent_harvest 全名（E-16；v1.1.2 I1 起五文件）
    const tails = ["sandbox_apply", "sandbox_discard", "agent_harvest"].map((t) => `mcp__plugin_agent-orchestrator_orch__${t}`);
    const bad = [];
    for (const [name, text] of agentTexts) {
      const line = frontmatterLine(text, "disallowedTools");
      const miss = firstMissing(line, tails);
      if (miss) bad.push(`${name} disallowedTools 缺 ${miss}`);
    }
    ck.ok("A-ROLE-DISALLOWED @ agents/*.md disallowedTools ×5", bad.length === 0,
      bad.length ? `A-ROLE-DISALLOWED 缺失子串: ${bad.join("; ")} —— 回写指针: 见 ${POINTER} §1 E-16` : "");
  }

  { // A-v0165-PERSONA-FACE（v1.6.5 fork (a) R2 活化看护腿）：五 persona tools:/disallowedTools:
    // MCP 条目全 ≡ mcp__plugin_agent-orchestrator_orch__<short> 且 <short> ∈ registry 裸名 roster
    // （import TOOLS 运行时计量）∧ per-persona disallowed ∩ tools = ∅。双前缀残形（宿主折叠
    // 伪影 mcp_plugin_agent...）不匹配 roster → 红；本腿=disallowedTools 单前缀条目自 v1.6.5
    // 起开始匹配（R2）后的机械护栏。
    const FACE_RE = /^mcp__plugin_agent-orchestrator_orch__([a-z_]+)$/;
    const roster = new Set(TOOLS.map((t) => t.name));
    const mcpEntries = (line) =>
      (line.match(/\[[^\]]*\]/)?.[0] || "")
        .split(",")
        .map((s) => s.trim().replace(/\]+$/, ""))
        .filter((s) => s.startsWith("mcp__"));
    const bad = [];
    for (const [name, text] of agentTexts) {
      const toolsLine = frontmatterLine(text, "tools");
      const disLine = frontmatterLine(text, "disallowedTools");
      const shortsOf = (line, label) => {
        const shorts = [];
        for (const entry of mcpEntries(line)) {
          const m = FACE_RE.exec(entry);
          if (!m) { bad.push(`${name} ${label} MCP 条目非单前缀 face 形: ${entry}`); continue; }
          if (!roster.has(m[1])) bad.push(`${name} ${label} short 不在 registry roster: ${m[1]}`);
          shorts.push(m[1]);
        }
        return shorts;
      };
      const toolShorts = shortsOf(toolsLine, "tools");
      const disShorts = shortsOf(disLine, "disallowedTools");
      const overlap = disShorts.filter((s) => toolShorts.includes(s));
      if (overlap.length) bad.push(`${name} disallowed ∩ tools = [${overlap.join(", ")}]（须空，R2 活化面）`);
    }
    ck.ok("A-v0165-PERSONA-FACE @ agents/*.md tools:/disallowedTools: ×5（单前缀 face 形 + roster 在册 + 交集空）",
      bad.length === 0,
      bad.length ? `A-v0165-PERSONA-FACE 受损: ${bad.join("; ")} —— 回写指针: impl-plan v1.6.5 §2.1 scope 3-7/§6` : "");
  }

  { // A-PLUGIN-STUB：E-18 方案乙开关已执行（2026-10-21，V7-05 实现侧先行落地）——两键 description 断言乙稿桥接语义在位，方案甲存根短语改列 ban（防复发回退）
    const d1 = pj.userConfig?.wake_timeout_min?.description || "";
    const d2 = pj.userConfig?.wake_retries?.description || "";
    const bad = [];
    for (const sub of ["桥接键", "V7-05 起桥接可达"]) {
      if (!d1.includes(sub)) bad.push(`wake_timeout_min.description 缺「${sub}」`);
      if (!d2.includes(sub)) bad.push(`wake_retries.description 缺「${sub}」`);
    }
    if (!d1.includes("--refire-gap-min")) bad.push("wake_timeout_min.description 缺桥接目标 --refire-gap-min");
    if (!d2.includes("--wake-cap")) bad.push("wake_retries.description 缺桥接目标 --wake-cap");
    for (const [k, d] of [["wake_timeout_min", d1], ["wake_retries", d2]]) {
      for (const stale of ["无实际效果", "兼容存根"]) {
        if (d.includes(stale)) bad.push(`${k}.description 残留方案甲旧措辞「${stale}」`);
      }
    }
    ck.ok("A-PLUGIN-STUB @ plugin.json 两键 description", bad.length === 0,
      bad.length ? `A-PLUGIN-STUB 断言未过: ${bad.join("; ")} —— 回写指针: 见 ${POINTER} §1 E-18（乙稿）` : "");
  }

  { // A-RECYCLE-1：RECYCLE_LIST 形状（四字段+host-fixed）+ 单模式断言（anchor 在位=防回退；v1.5 W3-M1 双模退役）
    let shapeErr = "";
    try {
      assert.equal(RECYCLE_LIST.length, 4, "应恰 4 条 R-1..R-4（R-5 已随 E-18 方案乙开关于 2026-10-21 出清册，V7-05 桥接复邦）");
      ["R-1", "R-2", "R-3", "R-4"].forEach((wantId, i) => {
        const e = RECYCLE_LIST[i];
        assert.equal(e.id, wantId, `第 ${i + 1} 条 id 应为 ${wantId}`);
        for (const k of ["file", "anchor", "recycleAction", "trigger", "issue"]) {
          assert.ok(typeof e[k] === "string" && e[k].length > 0, `条目 ${wantId} 缺字段 ${k}`);
        }
        assert.equal(e.trigger, "host-fixed", `条目 ${wantId} trigger 应为 host-fixed`);
      });
    } catch (e) {
      shapeErr = e && e.message ? e.message : String(e);
    }
    let modeErr = "";
    // v1.2.3 W1 守卫（主控扩授裁决）：R-4 file=AGENTS.md untracked 缺席（worktree）时该条
    // 跳过不核、断言名带 [SKIP ...] 标记（缺席≠误删，不计入收集集）；主仓在盘时 R-4 全量照核。
    // v1.5 W3-M1（T6 退役）：ORCH_HOST_FIXED=1 回收反向断言分支摘除（历史机制，recycleAction
    // 已记「已于 v1.4.0 翻面执行」）；单模式=anchor 在位防回退；R-2 永久条款由 A-COMPAT-1 承载。
    const recycleAbsent = RECYCLE_LIST.filter((e) => !fs.existsSync(e.file)).map((e) => e.id);
    const recycleAnchorPresent = (e) => fs.existsSync(e.file) && readFile(e.file).includes(e.anchor);
    if (!shapeErr) {
      // 缺陷期措辞必须在位（删了会让读者误以为 typed 可用）
      const still = RECYCLE_LIST.filter((e) => !recycleAbsent.includes(e.id) && !recycleAnchorPresent(e));
      if (still.length) modeErr = `锚点被误删（宿主缺陷期措辞应在位）: ${still.map((e) => e.id).join(", ")}`;
    }
    const cond = !shapeErr && !modeErr;
    const skipNote = recycleAbsent.length ? ` [SKIP 缺席文件未核: ${recycleAbsent.join(", ")}]` : "";
    ck.ok(`A-RECYCLE-1 RECYCLE_LIST 形状 + 单模式（anchor 在位）${skipNote}`, cond,
      cond ? "" : `A-RECYCLE-1 失败: ${shapeErr || modeErr} —— 回写指针: 见 ${POINTER} §3（回收清单与触发双通道）`);
  }

  // ---- v0.8 W4 增例（静态在位断言，权威 designs/agent-orchestrator-v0.8-DESIGN.md §10.2/§10.3/§14）----
  { // A-V080-DOC-01（v1.6 W3b 换血：orch-gleaner persona 件已删除——design §2.1 gleaner 移除联动；
    //   OPEN-5 dormant：server-memory glean 物化域字面保留 v1.7 清）。原在册腿（tools/disallow 面
    //   锚）subject 消亡退役，转缺席负向：件缺席 ∧ agents/ 枚举恰 5（防回潮=件回植或清单外新增
    //   角色件即红；po-static N1 反向钉② 同判据双套件承载）。
    const gleanerPath = path.join(PLUGIN_DIR, "agents", "orch-gleaner.md");
    const agentFiles = fs
      .readdirSync(path.join(PLUGIN_DIR, "agents"))
      .filter((f) => f.endsWith(".md"))
      .sort();
    const expected = ["orch-plan.md", "orch-planner.md", "orch-reviewer.md", "orch-scout.md", "orch-worker.md"];
    const bad = [];
    if (fs.existsSync(gleanerPath)) bad.push("agents/orch-gleaner.md 应已删除（v1.6 W3b）仍在位");
    if (agentFiles.length !== 5 || expected.some((f, i) => agentFiles[i] !== f)) bad.push(`agents/ 枚举异常: ${agentFiles.join(",")}`);
    ck.ok("A-V080-DOC-01 @ agents/orch-gleaner.md 缺席负向 + agents/ 枚举恰 5（v1.6 W3b 换血形态）", bad.length === 0,
      bad.length ? `A-V080-DOC-01 失败: ${bad.join("; ")} —— 回写指针: v1.6 design §2.1 gleaner 移除联动+${V08_POINTER} §14 DOC-01 沿革` : "");
  }

  { // A-V080-DOC-02：SKILL §10（记忆与现场）存在且标记对逐字串在案（防文档漂移）
    const skill10 = section(skill, "## 10.", "## 11.");
    const markers = [
      "<!-- orch-mem:begin v1（agent-orchestrator 记忆区：对内内容由归敛代理维护，勿手编；删除本对=关闭本功能） -->",
      "<!-- orch-mem:end -->",
    ];
    const miss = firstMissing(skill10, markers);
    ck.ok("A-V080-DOC-02 @ SKILL.md §10 存在 + 标记对逐字串在案", skill10.length > 0 && !miss,
      `A-V080-DOC-02 缺失: ${skill10.length === 0 ? "SKILL.md 无「## 10.」节" : `标记对子串 ${JSON.stringify(miss)}`} —— 回写指针: 见 ${V08_POINTER} §10.2/§14 DOC-02`);
  }

  // ---- v0.9 P2-① 增例（静态在位断言，权威 designs/agent-orchestrator-v0.9-C6-findings.md §3/§5-2 移交语义 +
  //      v0.9-DESIGN §16 HOST-01 行）----
  { // A-V090-HOST-01：C6 findings 在册口径——文件存在 + §0 判定串 + §1 锚点串（轻量 grep，DESIGN §16「文档断言」）
    // v1.2.3 W1 守卫（主控扩授裁决）：designs/ untracked 缺席（worktree）→ skip 带标记
    // （原缺席=FAIL 语义退役——缺席≠断言红，worktree 环境无法核在库文件）；在盘但子串
    // 缺失仍 FAIL（主仓断言不弱化）。
    if (!fs.existsSync(FILES.c6Findings)) {
      ck.ok("A-V090-HOST-01 @ C6-findings [SKIP: designs/ untracked absent in worktree checkout]", true);
    } else {
      const c6 = readFile(FILES.c6Findings);
      const need = [
        "## 0. 结论总表", // §0 判定节在册
        "YES（面存在，默认开、全文非摘要、每源 100KB 截断）", // §0 判定：用户级注入面 YES
        "缺省翻 false（已施工，HOST-01b）", // §0 判定：pack_global_section 缺省翻 false
        "index.ts:237", // §1 锚点：用户级解析面（~/.zcode/AGENTS.md 硬编码）
        "subagent.ts:121-124", // §1 锚点：子代理组装链默认注入
        "injectAgentsMd !== false", // §1 锚点：默认注入谓词
      ];
      const miss = firstMissing(c6, need);
      ck.ok("A-V090-HOST-01 @ C6-findings 在册+§0 判定串+§1 锚点串", !miss,
        miss ? `A-V090-HOST-01 失败: 缺失子串 ${JSON.stringify(miss)} —— 回写指针: 见 ${C6_POINTER} §3/§5-2（HOST-01 移交语义）` : "");
    }
  }

  // ---- v1.4 W1 新腿五条（A1-06/07 + B3-01/02 + C2-03；权威 designs/agent-orchestrator-v1.4-planning/design.md
  //      §1.1/§1.5/§1.7 + §2.1 表；typed 翻面收口防回退钉 + DP-3/TS-19a 护栏 + PL-10 补注/剥离句/v3 标记对）
  //      v1.6 W3b 套件换血（EXTRA⑥ 计划内收口）：W-p/W3a 两波退役落装后本组 4 腿过渡态红
  //      （A-SKILL-4 见上）全数改锚 W3a 落装新句逐字；宿主 typed 直派（subagent_type 面）与 GP
  //      降备语义不受影响（RP-1/RP-3 零触）——调度面 typed 参数字面零残留由 A-V0160-W9-01 承载 ----
  {
    // A1-06：SKILL RP-5/RP-6 翻面字面在位（防回退钉；design §2.1 A1-06 行）——零触（宿主 typed 直派面语义保持）
    subGroup(ck, "A-V0140-A1-06", "SKILL.md §8 RP-5/RP-6", skill8, {
      // v1.6.2 W5 重订=英文现态句（RP-5/RP-6）；ba92054/日期字面随 W3 沿革清理由退役（喂账③裁定）
      need: ["typed dispatch is restored and is the primary form", "fixed in-repo"],
      ban: ["typed 派发当前无法启动", "宿主修复快照数据源"],
    }, "v1.4 design §1.1");
    // A1-07：typed 退役注记（v1.6 W3b 换血改锚：DP-3 半=typed 参数退役注记在位（W-p 落装）；
    //   TS-19a 半=W3a 行区重写落装新句——旧「prompt 即完整首条消息」式护栏句废止句逐字在位；
    //   调度面 typed:true 调用字面双位零残留。原 v1.4 §2.1 A1-07 行沿革由本注记+v1.6.0.md §W3b 承载）
    {
      const dp3 = skill.split("\n").find((l) => l.startsWith("DP-3 ")) || "";
      const ts19a = skill.split("\n").find((l) => l.startsWith("TS-19a ")) || "";
      const bad = [];
      if (dp3.includes("typed 角色发射须在 dispatch 调用显式传 typed:true")) bad.push("DP-3 typed:true 旧句残留（v1.6 W-p 已退役应零残留）");
      if (!dp3.includes("The typed dispatch params are retired")) bad.push("DP-3 missing the W-p typed-params-retired note (W5 re-pin English)");
      if (ts19a.includes("typed:true")) bad.push("TS-19a typed:true 调度面字面残留（v1.6 W3a 行区重写后应零残留）");
      if (!ts19a.includes("the assembly chain is retired")) bad.push("TS-19a missing the W3a assembly-retired sentence (W5 re-pin English)");
      ck.ok("A-V0140-A1-07 @ SKILL.md DP-3 typed 退役注记+TS-19a 护栏废止句（v1.6 W3b 换血形态）", bad.length === 0,
        bad.length ? `A-V0140-A1-07 缺失: ${bad.join("; ")} —— 回写指针: v1.4 design §1.1 G1-3 沿革+v1.6.0.md §W3b` : "");
    }
    // B3-01：DP-3 护栏块（v1.6 W3b 换血改锚：W3a 落装新护栏逐字——模板唯一首条消息形制+
    //   bg-gate CONTRACT 头 presence 检测+三禁句；旧组装链描述面护栏改列 ban）
    {
      const dp3 = skill.split("\n").find((l) => l.startsWith("DP-3 ")) || "";
      const miss = firstMissing(dp3, ["[Guardrail] the template is the only first-message form", "bg-gate runs a CONTRACT-header presence check on host Agent calls", "no expansion, no reading old task packs to hand-replicate, no rewriting the three-line contract"]);
      const stale = dp3.includes("【护栏】本条为组装链描述（描述面）") ? "DP-3 残留旧组装链护栏句" : "";
      ck.ok("A-V0140-B3-01 @ SKILL.md DP-3 护栏块（v1.6 W3a 新句逐字）", !miss && !stale,
        miss ? `A-V0140-B3-01 缺失子串: ${JSON.stringify(miss)} —— 回写指针: v1.6 W3a DP-3 重写（SKILL :73）+v1.6.0.md §W3b`
          : stale ? `A-V0140-B3-01 应退役字面仍在位: ${stale} —— 回写指针: v1.6.0.md §W3b` : "");
    }
    // B3-02：TS-19a 护栏句（v1.6 W3b 换血改锚：编号出口+模板双位同文新句；旧「回执 prompt」
  //   式护栏/typed:true 字面改列 ban——N5 反向钉（po-static）同口径）
    {
      const ts19a = skill.split("\n").find((l) => l.startsWith("TS-19a ")) || "";
      const miss = firstMissing(ts19a, ["nested numbered exit", "the first message = the DP-3 fixed pointer template mechanically filled", "same text at the section 2 DP-3 / section 3 dispatch-header sites"]);
      const stale = firstPresent(ts19a, ["回执 prompt 即完整首条消息", "禁止按链描述手工复刻", "typed:true"]);
      ck.ok("A-V0140-B3-02 @ SKILL.md TS-19a 编号出口护栏（v1.6 W3a 新句逐字）", !miss && !stale,
        miss ? `A-V0140-B3-02 缺失子串: ${JSON.stringify(miss)} —— 回写指针: v1.6 W3a TS-19a 重写（SKILL :439）+v1.6.0.md §W3b`
          : stale ? `A-V0140-B3-02 应退役字面仍在位: ${JSON.stringify(stale)} —— 回写指针: v1.6.0.md §W3b` : "");
    }
    // C2-03：PL-10 补注+剥离句+v3 标记对字面（design §2.1 C2-03 行，与改11b 同源）
    //   v1.6 W3b 换血改锚（W15 换装+W3a PL-10② 换装落装字面）：协议行 `ts:`/`seq:`（server 铸
    //   ——旧「sessionId:」剥离句随协议行 server 铸退役改列 ban）；其余三锚保持。
    {
      const pl10 = skill.split("\n").find((l) => l.startsWith("PL-10 ")) || "";
      const miss = firstMissing(pl10, ["When a multi-root workspace shares coord-tail-log, always declare in full form", "the short-form baseline = the file's newest full block (server-side merge, inherited across sessions)", "the `ts:`/`seq:` protocol lines", "<!-- orch-tail v3"]);
      const stale = firstPresent(pl10, ["orch-tail v2", "`sessionId:`"]);
      ck.ok("A-V0140-C2-03 @ SKILL.md PL-10 补注+剥离句+标记对 v3（v1.6 W15/W3a 换装字面）", !miss && !stale,
        miss ? `A-V0140-C2-03 缺失子串: ${JSON.stringify(miss)} —— 回写指针: v1.4 design §1.7 C2-b 沿革+W15 换装字面（SKILL PL-10）`
          : stale ? `A-V0140-C2-03 应升级字面仍在位: ${JSON.stringify(stale)} —— 回写指针: 见 v1.4 design §2.2 改11b` : "");
    }
  }

  // ---- A-V0160-W9-01（v1.6 W3b 新腿：调度面 typed 参数字面零残留——design §3.2 W9「typed 字面
  //      零残留」钉面；宿主 typed 直派（subagent_type 面）合法保留（RP-1/PT-8 面零触），本钉只锁
  //      dispatch 工具 typed 参数域旧字面：typed:true 调用句/typedRequested/typedPointer 组装残段）----
  subGroup(ck, "A-V0160-W9-01", "SKILL.md 调度面 typed 零残留", skill, {
    need: ["The typed dispatch params are retired"], // v1.6.2 W5 重订=英文 DP-3 退役注记
    ban: ["typed 角色发射", "typed:true", "typedRequested", "typedPointer"],
  }, "v1.6.0.md §W3b W9");

  // ---- 回收提醒面（非 fail，不挡发版门；run-all 注册后即出现在其尾行）----
  // v1.5 W3-M1（T6 退役）：双模日志收编单行（回收于 v1.4.0 翻面执行，双模退役为历史机制）。
  console.log(`recycle: RECYCLE_LIST ${RECYCLE_LIST.length} 条（已于 v1.4.0 翻面执行；ORCH_HOST_FIXED 双模已随 v1.5 退役，anchor 在位断言维持）`);

  const { fail } = ck.summary();
  process.exit(fail ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
