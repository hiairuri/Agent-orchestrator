// provenance: v1.6 W3b 新建（impl-plan §2 W3b 件⑥/design §2.1「dev 同步助手形制」/OPEN-6 裁 a）——
// canonical=agents/orch-worker.md 纪律节播其余四件；幂等+diff 输出；非运行时零构建（纯 dev 助手，
// 不入 run-all REGISTRY、不产断言腿——N1 六源锁由 po-static 承载，本助手只负责人工编辑后的机械播种）。
/*!
 * tests/harness/sync-discipline.mjs —— 全角色纪律块 dev 同步助手（v1.6 W3b）
 *
 * 用途：五件 persona（orch-worker/scout/reviewer/planner/plan）正文的「全角色通用编排纪律」节
 *   （14 条逐字+P2P 补注四行）以 orch-worker.md 为 canonical，机械播散至其余四件——
 *   逐字互等由 po-static N1 六源锁断言（tests/suites/po-static.mjs），本助手是落装工具面。
 *
 * 用法：
 *   node tests/harness/sync-discipline.mjs          # 播散（有漂移则覆写并输出 diff 摘要）
 *   node tests/harness/sync-discipline.mjs --check  # 只核不写：全等退出 0，有漂移列出并退出 1
 *
 * 形制（design §2.1）：canonical 纪律节=「## 全角色通用编排纪律（已随你的角色预设载入，此刻生效）」
 *   行起、至五件 persona 正文 H1（`# orch-` 行）前的空行为止；四件目标同位替换（无纪律节则
 *   在 frontmatter 终线与 H1 之间插入）。幂等：重复运行零 diff 零写入。
 * 前置：node >= 20；零依赖（node:fs + node:path）。退出码：全等/成功 0；--check 漂移或错误非 0。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HARNESS_DIR, "..", "..");
const HEAD_MARK = "## 全角色通用编排纪律（已随你的角色预设载入，此刻生效）";
const PERSONAS = ["orch-worker", "orch-scout", "orch-reviewer", "orch-planner", "orch-plan"];
const CANONICAL = "orch-worker";
const TARGETS = PERSONAS.filter((p) => p !== CANONICAL);

const personaPath = (name) => path.join(PLUGIN_DIR, "agents", `${name}.md`);

/** 读面归一（CRLF 工作区惯例：读时归一为 \n 处理，写时按原文件换行形还原——幂等零噪音）。 */
function readPersona(p) {
  const raw = fs.readFileSync(p, "utf8");
  return { crlf: raw.includes("\r\n"), lines: raw.replace(/\r\n/g, "\n").split("\n") };
}
const writePersona = (p, lines, crlf) => fs.writeFileSync(p, lines.join(crlf ? "\r\n" : "\n"), "utf8");

/** 纪律节行集（含节内全部行+节尾一个空行；不含 H1）。返回 {lines, start} 或 null。 */
function extractBlock(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === HEAD_MARK);
  if (start < 0) return null;
  const h1 = lines.findIndex((l) => /^# orch-/.test(l));
  if (h1 < 0 || h1 <= start) return null;
  // 节体到 H1 前；规范化：剥离体尾多余空行后补恰一个空行（幂等形）
  const body = lines.slice(start, h1);
  while (body.length && body[body.length - 1].trim() === "") body.pop();
  body.push("");
  return { lines: body, start };
}

/** 四件目标写面定位：纪律节起点（有则替换）或插入点（frontmatter 终线之后、H1 之前）。 */
function targetSpan(text) {
  const lines = text.split("\n");
  const h1 = lines.findIndex((l) => /^# orch-/.test(l));
  if (h1 < 0) return null;
  const start = lines.findIndex((l) => l === HEAD_MARK);
  if (start >= 0) return { start, end: h1 }; // 替换 [start, h1)
  // 插入：H1 前原空行之后（块尾空行提供 H1 前分隔——与 canonical 布局逐字同构：
  // frontmatter 终线/空行/纪律节…P2P 末行/空行/H1）；无 frontmatter 布局亦收敛同形。
  return { start: h1, end: h1 };
}

/** 轻量行级 diff 摘要（幂等输出面）：删除行/新增行逐条 ± 前缀，超 40 行截断计数。 */
function diffLines(before, after) {
  const b = before.split("\n");
  const a = after.split("\n");
  const out = [];
  let i = 0;
  let j = 0;
  while (i < b.length && j < a.length && b[i] === a[j]) {
    i++;
    j++;
  }
  let bi = b.length - 1;
  let ai = a.length - 1;
  while (bi >= i && ai >= j && b[bi] === a[ai]) {
    bi--;
    ai--;
  }
  for (let k = i; k <= bi; k++) out.push(`- ${b[k]}`);
  for (let k = j; k <= ai; k++) out.push(`+ ${a[k]}`);
  if (out.length > 40) return [...out.slice(0, 40), `…（共 ${out.length} 行变更，截断）`];
  return out;
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const canonical = readPersona(personaPath(CANONICAL));
  const block = extractBlock(canonical.lines.join("\n"));
  if (!block) {
    console.error(`FAIL canonical ${CANONICAL}.md 无纪律节（HEAD_MARK 未命中或 H1 缺席）`);
    process.exit(1);
  }
  const blockLines = block.lines;
  let drift = 0;
  for (const name of TARGETS) {
    const p = personaPath(name);
    const doc = readPersona(p);
    const span = targetSpan(doc.lines.join("\n"));
    if (!span) {
      console.error(`FAIL ${name}.md 定位失败（H1 缺席）`);
      drift++;
      continue;
    }
    const before = doc.lines.slice(span.start, span.end).join("\n");
    const after = blockLines.join("\n");
    if (before === after) {
      console.log(`OK ${name}.md 纪律节逐字等（幂等零写）`);
      continue;
    }
    if (checkOnly) {
      console.log(`DRIFT ${name}.md 纪律节漂移（--check 不写）`);
      for (const l of diffLines(before, after)) console.log(`  ${l}`);
      drift++;
      continue;
    }
    const lines = [...doc.lines];
    lines.splice(span.start, span.end - span.start, ...blockLines);
    writePersona(p, lines, doc.crlf);
    console.log(`SYNC ${name}.md 纪律节已播种（${span.end - span.start} → ${blockLines.length} 行）`);
    for (const l of diffLines(before, after)) console.log(`  ${l}`);
  }
  if (drift > 0 && checkOnly) {
    console.log(`SUITE sync-discipline --check drift=${drift}`);
    process.exit(1);
  }
  console.log(`SUITE sync-discipline ok canonical=${CANONICAL} targets=${TARGETS.length} drift=${drift}${checkOnly ? " (check)" : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
