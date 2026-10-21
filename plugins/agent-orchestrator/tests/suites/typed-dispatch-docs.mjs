#!/usr/bin/env node
/*!
 * suites/typed-dispatch-docs.mjs —— v0.6 簇 C 断言套（V6-63 文档在位防回退 + V6-64 到期回收机制载体）
 *
 * 如实声明：纯 Node 断言测不了宿主 typed 派发行为；本 suite 只测文档/配置在位，防回退。
 * 覆盖 18 组断言（W-C §2 表）：A-AGENTS-1 / A-SKILL-1..5 / A-DOC-V4P11/V4P12/V4P21/V4P23·24/V4P31/
 *   SIGNALS/FAILOPEN/V4P25 / A-COMPAT-1 / A-ROLE-DISALLOWED / A-PLUGIN-STUB / A-RECYCLE-1。
 * 回收机制（W-C §3）：RECYCLE_LIST R-1..R-4 导出常量（宿主修复事件触发的人工维护清单）；
 *   默认模式断言各 anchor 在位（防缺陷期被误删）；env ORCH_HOST_FIXED=1 反向断言各 anchor 已回收，
 *   并断言 R-2 永久条款（「report 全名保留不删」）仍在位——该条款为永久不变量，不在回收范围。
 *   E-05/E-06/E-07 条目中「宿主快照缺陷期间」限定语随 R-2 同批复核；E-13/E-14 不回收。
 *   R-5（plugin.json 两键「兼容存根」）已于 2026-10-21 随 E-18 方案乙开关出清册（回收完成）：
 *   V6-24 实现侧（V7-05 numArgOpt 稀疏写）先行落地、桥接语义复邦；A-DOC-V4P12/A-PLUGIN-STUB
 *   同步切换为断言乙稿桥接措辞在位，方案甲存根短语改列 ban（防复发回退）。
 *
 * TODO(issue): 上游 issue 稿（宿主 startup snapshot 缺陷，证据链 designs/dispatch-probe-20261014/）
 *   待 V6-61 定稿提交后回填编号，并同步回填 RECYCLE_LIST 各条 issue 字段。
 *
 * 运行方式：node tests/suites/typed-dispatch-docs.mjs（回收核对：ORCH_HOST_FIXED=1 node …）
 * 前置：node >= 20；零依赖（node:fs + node:assert/strict）。退出码：全绿 0；任一 FAIL 非 0。
 * 失败信息规范：断言 ID + 缺失子串 + 回写指针（designs/agent-orchestrator-v0.6-W-C-findings.md §1 E-xx），
 *   断言红时零查证即可按指针补稿。
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const SUITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(SUITE_DIR, "..", "..");
const REPO_ROOT = path.resolve(PLUGIN_DIR, "..", "..");
const FILES = {
  skill: path.join(PLUGIN_DIR, "skills", "agent-orchestrator", "SKILL.md"),
  agentWorker: path.join(PLUGIN_DIR, "agents", "orch-worker.md"),
  agentScout: path.join(PLUGIN_DIR, "agents", "orch-scout.md"),
  agentReviewer: path.join(PLUGIN_DIR, "agents", "orch-reviewer.md"),
  pluginJson: path.join(PLUGIN_DIR, ".zcode-plugin", "plugin.json"),
  agentsMd: path.join(REPO_ROOT, "AGENTS.md"),
};
const REPORT = "mcp__plugin_agent-orchestrator_orch__report";
const SNAPSHOT_ERR = "Required MCP tool is not available in the parent startup snapshot";
const POINTER = "designs/agent-orchestrator-v0.6-W-C-findings.md";

/**
 * RECYCLE_LIST（V6-64 到期回收对象；W-C §3）——宿主修复事件判定后按 recycleAction 逐条回收。
 * trigger 固定 "host-fixed"；issue 为占位，V6-61 上游 issue 提交后回填编号。
 */
export const RECYCLE_LIST = [
  {
    id: "R-1",
    file: FILES.skill,
    anchor: "宿主快照缺陷期间一律走第 10 章主形态",
    recycleAction: "恢复 typed 为默认派发形态表述，GP+persona 降为备选注记",
    trigger: "host-fixed",
    issue: "TODO-V661（上游 issue 编号，V6-61 定稿提交后回填）",
  },
  {
    id: "R-2",
    file: FILES.skill,
    anchor: "宿主快照缺陷存在期间所有插件角色派发一律用它",
    recycleAction: "改写为「快照缺陷已修复（<宿主版本>），typed 与 GP 双形态并存」；「report 全名保留不删」为永久不变量条款，不在回收范围",
    trigger: "host-fixed",
    issue: "TODO-V661（上游 issue 编号，V6-61 定稿提交后回填）",
  },
  {
    id: "R-3",
    file: FILES.skill,
    anchor: "宿主快照缺陷期间池工一律经 `Agent(prompt=原型正文+system_prompt)` 注入派发",
    recycleAction: "恢复 typed 池工表述",
    trigger: "host-fixed",
    issue: "TODO-V661（上游 issue 编号，V6-61 定稿提交后回填）",
  },
  {
    id: "R-4",
    file: FILES.agentsMd,
    anchor: "勿重试同一角色",
    recycleAction: "改写为历史注记（保留 designs/dispatch-probe-20261014/ 链接），删「勿重试」禁令",
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
  const agentsMd = readFile(FILES.agentsMd);
  const skill3 = section(skill, "## 3.", "## 4.");
  const skill4 = section(skill, "## 4.", "## 5.");
  const skill10 = section(skill, "## 10.", "## 11.");
  const skill12 = section(skill, "## 12.", "## 13.");
  const agentFiles = [
    ["orch-worker.md", FILES.agentWorker],
    ["orch-scout.md", FILES.agentScout],
    ["orch-reviewer.md", FILES.agentReviewer],
  ];
  const agentTexts = agentFiles.map(([name, p]) => [name, readFile(p)]);
  const pj = JSON.parse(readFile(FILES.pluginJson));
  const hostFixed = process.env.ORCH_HOST_FIXED === "1";

  // ---- 编辑单落地断言（W-C §2 表；判据列逐条对应）----
  subGroup(ck, "A-AGENTS-1", "AGENTS.md", agentsMd, { need: ["startup snapshot 校验数据源分叉", "勿重试"], ban: ["原生角色派发需全新会话"] }, "E-01");
  subGroup(ck, "A-SKILL-1", "SKILL.md §10", skill10, { need: [REPORT, "双通道", "KIND="] }, "E-04");

  { // A-SKILL-2：「仅终态」与「哨兵联动」须同句（E-04 降级通道缺口声明）
    const sent = skill10.split("。").find((s) => s.includes("仅终态"));
    const cond = Boolean(sent && sent.includes("哨兵联动"));
    ck.ok("A-SKILL-2 @ SKILL.md §10 同句含「仅终态」+「哨兵联动」", cond,
      `A-SKILL-2 缺失同句声明（仅终态+哨兵联动） @ SKILL.md §10 —— 回写指针: 见 ${POINTER} §1 E-04`);
  }

  subGroup(ck, "A-SKILL-3", "SKILL.md §12", skill12, { need: [SNAPSHOT_ERR, "校验面", "执行面", "回退", "勿重试"] }, "E-05");
  subGroup(ck, "A-SKILL-4", "SKILL.md §3", skill3, { need: ["## REPORT（双通道）"] }, "E-06");
  subGroup(ck, "A-SKILL-5", "SKILL.md §4", skill4, { need: [SNAPSHOT_ERR, "GP+persona"] }, "E-07");
  subGroup(ck, "A-DOC-V4P11", "SKILL.md", skill, { need: ["2MB 字节帽", "整文件轮转"], ban: ["400 条"] }, "E-08");
  subGroup(ck, "A-DOC-V4P21", "SKILL.md", skill, { need: ["时间常数"], ban: ["30 天半衰"] }, "E-09");
  subGroup(ck, "A-DOC-V4P12", "SKILL.md", skill, { need: ["V7-05 起桥接可达", "桥接键", "两枪最小间隔"], ban: ["无实际效果", "v0.3 兼容存根"] }, "E-10");
  subGroup(ck, "A-DOC-V4P23/24", "SKILL.md", skill, { need: ["软约束", "仅 schema 声明"] }, "E-11");
  subGroup(ck, "A-DOC-V4P31", "SKILL.md", skill, { need: ["action ∈ upsert/get/list/ack/claim"] }, "E-12");
  subGroup(ck, "A-DOC-SIGNALS", "SKILL.md", skill, { need: ["signals", "空串语义 = 哨兵侧内建默认"] }, "E-13");
  subGroup(ck, "A-DOC-FAILOPEN", "SKILL.md", skill, { need: ["闸门是提示面不是防线", "timeoutMs=10000"] }, "E-14");
  subGroup(ck, "A-DOC-V4P25", "AGENTS.md", agentsMd, { need: ["勿以行数作锚点", "7162"] }, "E-02");

  { // A-COMPAT-1：三角色 tools: 行均含 report 全名 + SKILL §10「保留不删」永久条款（V6-68 不变量守护）
    const bad = [];
    for (const [name, text] of agentTexts) {
      const line = frontmatterLine(text, "tools");
      if (!line.includes(REPORT)) bad.push(`${name} tools 行缺 report 全名`);
    }
    if (!skill10.includes("保留不删")) bad.push("SKILL.md §10 缺「保留不删」");
    ck.ok("A-COMPAT-1 @ agents/*.md tools 行 + SKILL §10 保留不删", bad.length === 0,
      bad.length ? `A-COMPAT-1 不变量受损: ${bad.join("; ")} —— 回写指针: 见 ${POINTER} §1 E-15` : "");
  }

  { // A-ROLE-DISALLOWED：三角色 disallowedTools 行均含 sandbox_apply/sandbox_discard/agent_harvest 全名（E-16）
    const tails = ["sandbox_apply", "sandbox_discard", "agent_harvest"].map((t) => `mcp__plugin_agent-orchestrator_orch__${t}`);
    const bad = [];
    for (const [name, text] of agentTexts) {
      const line = frontmatterLine(text, "disallowedTools");
      const miss = firstMissing(line, tails);
      if (miss) bad.push(`${name} disallowedTools 缺 ${miss}`);
    }
    ck.ok("A-ROLE-DISALLOWED @ agents/*.md disallowedTools ×3", bad.length === 0,
      bad.length ? `A-ROLE-DISALLOWED 缺失子串: ${bad.join("; ")} —— 回写指针: 见 ${POINTER} §1 E-16` : "");
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

  { // A-RECYCLE-1：RECYCLE_LIST 形状（四字段+host-fixed）+ 双模断言（默认在位 / ORCH_HOST_FIXED=1 已回收）
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
    if (!shapeErr) {
      if (!hostFixed) {
        // 默认模式：缺陷期措辞必须在位（删了会让读者误以为 typed 可用）
        const still = RECYCLE_LIST.filter((e) => !readFile(e.file).includes(e.anchor));
        if (still.length) modeErr = `锚点被误删（宿主缺陷期措辞应在位）: ${still.map((e) => e.id).join(", ")}`;
      } else {
        // 回收模式（ORCH_HOST_FIXED=1）：各 anchor 应已回收；R-2 永久条款仍在位
        const left = RECYCLE_LIST.filter((e) => readFile(e.file).includes(e.anchor));
        if (left.length) modeErr = `回收未完成: ${left.map((e) => e.id).join(", ")}`;
        const skillNow = readFile(FILES.skill);
        const perm10 = section(skillNow, "## 10.", "## 11.");
        if (!perm10.includes("保留不删") || !perm10.includes(REPORT)) {
          modeErr += `${modeErr ? "; " : ""}R-2 永久条款受损：「report 全名保留不删」不得随回收删除`;
        }
      }
    }
    const cond = !shapeErr && !modeErr;
    const modeLabel = hostFixed ? "回收模式 ORCH_HOST_FIXED=1" : "默认模式（anchor 在位）";
    ck.ok(`A-RECYCLE-1 RECYCLE_LIST 形状 + ${modeLabel}`, cond,
      cond ? "" : `A-RECYCLE-1 失败: ${shapeErr || modeErr} —— 回写指针: 见 ${POINTER} §3（回收清单与触发双通道）`);
  }

  // ---- 回收提醒面（非 fail，不挡发版门；run-all 注册后即出现在其尾行）----
  if (hostFixed) {
    console.log(`recycle: RECYCLE_LIST ${RECYCLE_LIST.length} 条（ORCH_HOST_FIXED=1 反向断言已执行；R-2 永久条款另测）`);
  } else {
    console.log(`recycle-pending: ${RECYCLE_LIST.length} 条（宿主修复事件未判定）`);
  }

  const { fail } = ck.summary();
  process.exit(fail ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
