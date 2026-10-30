#!/usr/bin/env node
// @module contract-sync
/*!
 * suites/contract-sync.mjs —— v1.2 M1-3：契约卡对拍套件（卡≈码，漂移即红）
 * 断言组：A-v0120-CARD（impl-plan v2 §批2 W1 M1-3；计数恒为台账非门禁，规模锚=随状态机腿数）
 *
 * 对拍对象（本套唯一对拍面）= docs/protocols/card-state-machine.md vs mcp/server.mjs 源实现：
 *   ①ALLOWED_TRANSITIONS：卡 §2 fenced js 逐字块 vs server.mjs 源码声明（卡头实测基线 :2015-2027，
 *     行号不作跨版引用——本套定位一律按 `const ALLOWED_TRANSITIONS =` 常量名锚）。
 *     对拍口径=语义级（from 态全集/逐腿存在性/reopen 旗标），注释/空白/键序等格式化差异不碎锁；
 *     腿级漂移（加腿/删腿/改腿/改 reopen）必红。crv6-statemachine 是行为级厚锁（主锁），本套补
 *     「卡文档 vs 源码」静态对拍腿——两源漂移在行为锁触及前先被本套机械红检出（卡 §7/§8 消费约定）。
 *   ②人读矩阵：卡 §2 表格 ✓/✗ 记法与 fenced 白名单逐行对拍（卡内自洽：矩阵 ≡ fenced 块）。
 *   ③STATUSES 11 态：卡 §1 状态列表 vs server.mjs 源码数组（集合比较，序不判）；
 *     并断言白名单 from 态全集 ≡ STATUSES（每态必有显式白名单行，含空行 closed）。
 *   ④M1-2 建议纳入断言面的两条卡面行为主张（源码侧语义锚 grep + 卡侧稳定措辞）：
 *     外部 upsert 新建 mission 按 drafted 起判（卡 §4 附则，server.mjs :2066 实锚）；
 *     status 枚举校验（卡 §1，server.mjs :3885 实锚 `!STATUSES.includes(patch.status)`）。
 *   ⑤负例腿（内建自证，内存副本零仓库写入）：对源码白名单副本删一腿 → 对拍器必须报漂移——
 *     防提取/比较链退化为恒绿（twin-lock 负例腿同族先例，M-4 同型机制不扩 scope）。
 *
 * LM-05 文档卡同步锁（卡存在非空+锚标识符源码 grep 可见，全契约卡适用）注册在
 * suites/lint-manifest.mjs（L0），本套不重复其职责；两套合起来=M1-3 全部验收面。
 *
 * 口径：L1 纯静态读文件（--root 参数接受但忽略，兼容 run-all 透传），零网络、零临时根、零仓库写入。
 * 运行方式：node tests/suites/contract-sync.mjs [--root <忽略>]
 * 前置：node >= 20；无网、无 git。
 */
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_DIR, DEFAULT_SERVER, Checker } from "../harness/jsonrpc-client.mjs";

const ck = new Checker("contract-sync");

const CARD_PATH = path.join(PLUGIN_DIR, "docs", "protocols", "card-state-machine.md");

// ---------- 通用提取器（l-20261023-31e613：锚点唯一性先计数，勿信渲染文本回读） ----------
const LF = (s) => s.replace(/\r\n/g, "\n");
const anchorCount = (srcLF, anchor) => srcLF.split(anchor).length - 1;

/** 从 `const NAME = {` 锚后做花括号配平截取对象字面量文本（跳过行注释与字符串字面量，防御性）。 */
function extractObjLiteral(srcLF, declAnchor) {
  const n = anchorCount(srcLF, declAnchor);
  if (n !== 1) throw new Error("anchor count=" + n + " for " + JSON.stringify(declAnchor));
  const eq = srcLF.indexOf(declAnchor) + declAnchor.length;
  const open = srcLF.indexOf("{", eq);
  if (open < 0) throw new Error("no opening brace after anchor");
  let depth = 0;
  for (let i = open; i < srcLF.length; i++) {
    const ch = srcLF[i];
    if (ch === "/" && srcLF[i + 1] === "/") {
      while (i < srcLF.length && srcLF[i] !== "\n") i++; // 行注释跳到行尾
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < srcLF.length && srcLF[i] !== q) { if (srcLF[i] === "\\") i++; i++; } // 字符串字面量跳过
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return srcLF.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced braces after anchor");
}

/** 从 `const NAME =` 锚后第一个 `[` 做方括号配平截取数组字面量文本（锚不含 `[`——含 `[` 会跳过真开括号误捕下一个数组）。 */
function extractArrLiteral(srcLF, declAnchor) {
  const n = anchorCount(srcLF, declAnchor);
  if (n !== 1) throw new Error("anchor count=" + n + " for " + JSON.stringify(declAnchor));
  const open = srcLF.indexOf("[", srcLF.indexOf(declAnchor) + declAnchor.length);
  if (open < 0) throw new Error("no opening bracket after anchor");
  let depth = 0;
  for (let i = open; i < srcLF.length; i++) {
    const ch = srcLF[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < srcLF.length && srcLF[i] !== q) { if (srcLF[i] === "\\") i++; i++; }
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return srcLF.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced brackets after anchor");
}

const evalLiteral = (text) => new Function("return (" + text + ")")();

/** markdown 取标题节（标题正则定位，取到下一个 `## ` 或文末；找不到返回 null）。 */
function cardSection(cardLF, headingRe) {
  const lines = cardLF.split("\n");
  const start = lines.findIndex((l) => /^##\s/.test(l) && headingRe.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join("\n");
}

/** 一节内全部 fenced 块 [{info, body}]。 */
function fencedBlocks(sectionText) {
  const out = [];
  const lines = sectionText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^```(.*)$/);
    if (!m) continue;
    const info = m[1].trim();
    const body = [];
    i++;
    while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
    out.push({ info, body: body.join("\n") });
  }
  return out;
}

/** 递归键序稳定序列化（语义对拍比较键；腿对象键序不敏感）。 */
const stable = (v) =>
  JSON.stringify(v, (_k, x) => {
    if (x && typeof x === "object" && !Array.isArray(x)) {
      const o = {};
      for (const k of Object.keys(x).sort()) o[k] = x[k];
      return o;
    }
    return x;
  });

/** 白名单表 → 腿清单 [{from,to,reopen}]。 */
function legsOf(table) {
  const legs = [];
  for (const from of Object.keys(table)) {
    const row = table[from] && typeof table[from] === "object" ? table[from] : {};
    for (const to of Object.keys(row)) legs.push({ from, to, reopen: row[to] && row[to].reopen === true });
  }
  return legs;
}

/** tryOk：fn 正常=绿（返回值），抛错=红（message 进 extra）。 */
function tryOk(name, fn) {
  try {
    const v = fn();
    ck.ok(name, true);
    return v;
  } catch (e) {
    ck.ok(name, false, String((e && e.message) || e).slice(0, 300));
    return null;
  }
}

// ---- 前置：两源可读
let cardLF = tryOk("CARD-00 状态机卡可读且非空（docs/protocols/card-state-machine.md）", () => {
  const s = LF(fs.readFileSync(CARD_PATH, "utf8"));
  if (!s.trim()) throw new Error("卡空文件");
  return s;
});
let serverLF = tryOk("CARD-00 server.mjs 可读且非空", () => {
  const s = LF(fs.readFileSync(DEFAULT_SERVER, "utf8"));
  if (!s.trim()) throw new Error("server.mjs 空文件");
  return s;
});

if (cardLF && serverLF) {
  const DECL = "const ALLOWED_TRANSITIONS =";

  // ---- ① 两源白名单提取
  const cardTable = tryOk("CARD-01 卡 §2 ALLOWED_TRANSITIONS fenced 逐字块抽取成功且可求值", () => {
    const sec = cardSection(cardLF, /ALLOWED_TRANSITIONS 全表/);
    if (!sec) throw new Error("卡内未找到「ALLOWED_TRANSITIONS 全表」标题节");
    const blk = fencedBlocks(sec).find((b) => b.body.includes(DECL));
    if (!blk) throw new Error("卡 §2 无含声明锚的 fenced 块");
    const t = evalLiteral(extractObjLiteral(blk.body, DECL));
    if (!t || typeof t !== "object") throw new Error("求值结果非对象");
    return t;
  });
  const srcTable = tryOk("CARD-02 server.mjs 源码声明锚计数恰一且对象字面量可求值", () => {
    const t = evalLiteral(extractObjLiteral(serverLF, DECL));
    if (!t || typeof t !== "object") throw new Error("求值结果非对象");
    return t;
  });

  if (cardTable && srcTable) {
    const cardLegs = legsOf(cardTable);
    const srcLegs = legsOf(srcTable);
    const legKey = (l) => l.from + "→" + l.to;

    // ---- 语义对拍：from 态全集 / 腿总数 / 逐腿
    const cardKeys = Object.keys(cardTable).sort();
    const srcKeys = Object.keys(srcTable).sort();
    ck.ok("CARD-03 白名单 from 态全集两侧一致（" + srcKeys.length + " 态）",
      stable(cardKeys) === stable(srcKeys), { card: cardKeys, src: srcKeys });
    ck.ok("CARD-04 腿总数两侧一致（" + srcLegs.length + " 腿）",
      cardLegs.length === srcLegs.length, { card: cardLegs.length, src: srcLegs.length });

    const union = [...new Set([...cardLegs.map(legKey), ...srcLegs.map(legKey)])].sort();
    for (const key of union) {
      const [from, to] = key.split("→");
      const cLeg = cardTable[from] && cardTable[from][to];
      const sLeg = srcTable[from] && srcTable[from][to];
      const cHas = cLeg !== undefined;
      const sHas = sLeg !== undefined;
      const cReopen = cLeg && cLeg.reopen === true;
      const sReopen = sLeg && sLeg.reopen === true;
      ck.ok("CARD-05 腿 " + key + "：存在性与 reopen 旗标两侧一致",
        cHas === sHas && cReopen === sReopen,
        { card: cHas ? (cReopen ? "reopen" : "plain") : "absent", src: sHas ? (sReopen ? "reopen" : "plain") : "absent" });
    }

    // ---- 负例腿（内建自证）：内存副本删一腿 → 对拍器必须报漂移（零仓库写入）
    tryOk("CARD-06 负例自证：删一腿的副本对拍必报漂移（比较链非恒绿）", () => {
      const negSrc = structuredClone(srcTable);
      const from = Object.keys(negSrc).find((k) => negSrc[k] && Object.keys(negSrc[k]).length > 0);
      if (!from) throw new Error("源白名单无任何腿，负例无从构造");
      const to = Object.keys(negSrc[from])[0];
      delete negSrc[from][to];
      if (stable(negSrc) === stable(cardTable)) throw new Error("删腿 " + from + "→" + to + " 后对拍仍相等=比较链退化");
      return "deleted " + from + "→" + to;
    });

    // ---- ② 人读矩阵对拍（卡内自洽：矩阵 ≡ fenced 白名单）
    const m = tryOk("CARD-07 卡 §2 人读矩阵结构完整（列头≡to 态并集；行标签≡from 态全集）", () => {
      const sec = cardSection(cardLF, /ALLOWED_TRANSITIONS 全表/);
      const lines = sec.split("\n");
      const hIdx = lines.findIndex((l) => /^\|\s*from\s*\\\s*to\s*\|/.test(l));
      if (hIdx < 0) throw new Error("未找到「| from \\ to |」列头行");
      const cols = lines[hIdx].split("|").slice(2).map((s) => s.trim()).filter(Boolean);
      // 期望列 = to 腿并集 ∪ running（→running 系 claim 专属腿，刻意缺席白名单但矩阵保留该禁行列，
      // 卡 §2「内部专属腿刻意缺席于白名单」注记；新增内部专属目标列时本断言红=提醒补表）。
      const INTERNAL_ONLY_TARGETS = ["running"];
      const wantCols = [...new Set([...srcLegs.map((l) => l.to), ...INTERNAL_ONLY_TARGETS])].sort();
      if (stable(cols.slice().sort()) !== stable(wantCols)) throw new Error("列头 " + JSON.stringify(cols) + " ≠ to 态并集 " + JSON.stringify(wantCols));
      const rows = [];
      for (let i = hIdx + 1; i < lines.length; i++) {
        if (!/^\|/.test(lines[i])) continue;
        if (/^\|[-\s|]+$/.test(lines[i])) continue; // 分隔行 |---|
        const cells = lines[i].split("|").map((s) => s.trim());
        rows.push({ label: cells[1], cells: cells.slice(2, 2 + cols.length) });
      }
      const labels = rows.map((r) => r.label).sort();
      if (stable(labels) !== stable(srcKeys)) throw new Error("行标签 " + JSON.stringify(labels) + " ≠ from 态全集 " + JSON.stringify(srcKeys));
      for (const r of rows) {
        if (r.cells.length !== cols.length) throw new Error("行 " + r.label + " 值格数 " + r.cells.length + " ≠ 列数 " + cols.length);
      }
      return { cols, rows };
    });
    if (m) {
      const problems = [];
      for (const r of m.rows) {
        const want = new Set(srcLegs.filter((l) => l.from === r.label).map((l) => l.to));
        const got = new Set(m.cols.filter((_c, i) => (r.cells[i] || "").startsWith("✓")));
        for (const to of want) if (!got.has(to)) problems.push(r.label + "→" + to + " 缺✓");
        for (const to of got) if (!want.has(to)) problems.push(r.label + "→" + to + " 多✓");
      }
      ck.ok("CARD-08 人读矩阵逐行腿集 ≡ fenced 白名单（✓/✗记法对拍，" + m.rows.length + " 行）",
        problems.length === 0, { problems: problems.slice(0, 12) });
    }

    // ---- ③ STATUSES 11 态对拍（卡 §1 列表 vs server.mjs 数组；集合比较序不判）
    tryOk("CARD-09 STATUSES：卡 §1 状态列表 ≡ server.mjs 源码数组（集合一致）", () => {
      const arr = evalLiteral(extractArrLiteral(serverLF, "const STATUSES ="));
      if (!Array.isArray(arr) || !arr.length) throw new Error("源码 STATUSES 提取退化");
      const sec = cardSection(cardLF, /状态全集/);
      if (!sec) throw new Error("卡内未找到「状态全集」标题节");
      const blk = fencedBlocks(sec).find((b) => /^[a-z_,\s]+$/.test(b.body) && b.body.includes("drafted"));
      if (!blk) throw new Error("卡 §1 无状态列表 fenced 块");
      const cardStatuses = blk.body.split(",").map((s) => s.trim()).filter(Boolean);
      if (stable(cardStatuses.slice().sort()) !== stable(arr.slice().sort())) {
        throw new Error("卡 " + JSON.stringify(cardStatuses) + " ≠ 源码 " + JSON.stringify(arr));
      }
      return arr.length + " 态";
    });
    tryOk("CARD-10 白名单 from 态全集 ≡ STATUSES（每态必有显式白名单行，含空行 closed）", () => {
      const arr = evalLiteral(extractArrLiteral(serverLF, "const STATUSES ="));
      if (!Array.isArray(arr) || !arr.length) throw new Error("源码 STATUSES 提取退化");
      if (stable(srcKeys) !== stable(arr.slice().sort())) {
        throw new Error("白名单键 " + JSON.stringify(srcKeys) + " ≠ STATUSES " + JSON.stringify(arr));
      }
      return arr.length + " 态";
    });

    // ---- ④ M1-2 建议纳入断言面的两条行为主张（源码语义锚 + 卡面稳定措辞）
    tryOk("CARD-11 外部 upsert 新建按 drafted 起判实锚（server.mjs upsertMission 迁移门 from 起判语义锚恰一）", () => {
      const re = /idx\s*>=\s*0\s*\?\s*prevStatus\s*:\s*"drafted"/;
      const n = (serverLF.match(re) || []).length;
      if (n !== 1) throw new Error("语义锚计数=" + n);
      return "1 hit";
    });
    tryOk("CARD-12 status 枚举校验实锚（server.mjs board upsert !STATUSES.includes 门恰一）", () => {
      const re = /patch\.status\s*!==\s*undefined\s*&&\s*!STATUSES\.includes\(patch\.status\)/;
      const n = (serverLF.match(re) || []).length;
      if (n !== 1) throw new Error("语义锚计数=" + n);
      return "1 hit";
    });
    tryOk("CARD-13 卡面两条行为主张在位（§1 枚举校验措辞 + §4 新建按 drafted 起判措辞）", () => {
      if (!/对 status 做枚举校验/.test(cardLF)) throw new Error("卡缺枚举校验主张");
      if (!/新建 mission 的 status 进门约定/.test(cardLF)) throw new Error("卡缺 drafted 起判主张");
      return "2 hits";
    });
  }
}

const { pass, fail } = ck.summary();
process.exit(fail ? 1 : 0);
