// @module crv2-pack/setup
// suites/crv2-pack 拆分件（v1.3 W1 初步切分批次）：共享上下文 + 纯辅助函数。
// 自单文件 suites/crv2-pack.mjs 按功能块拆入 ./crv2-pack/，断言本体零改动，行为门=run-all。
// 本文件承载模块级夹具副作用：Checker/临时根创建 + dispatch stub CLI 落盘（原 L28-49）。
import fs from "node:fs";
import path from "node:path";
import { Checker } from "../../harness/jsonrpc-client.mjs";
import { makeTempRoot, parseRootArg } from "../../harness/temp-root.mjs";

export const ck = new Checker("crv2-pack");
export const BASE = makeTempRoot({ prefix: "orch-crv2-", root: parseRootArg() || undefined });
export const PROJ = path.join(BASE.root, "proj");
export const TROOT = path.join(BASE.root, "troot");
export const SCRATCH = path.join(BASE.root, "scratch");

// 现行 server 句柄共享槽：入口 finally 据此关闭（接线语义=拆前模块级 let cur，异常路径
// 起服后任何 throw 仍会走 finally 关服，与拆前逐点等价）
export const proc = { cur: null };

// ---- v1.1.1 W20：dispatch 端到端夹具（stub CLI + 隔离 rollout 目录，零模型事务） ----
const STUB_DIR = path.join(BASE.root, "dispatch-stub");
export const STUB_CLI = path.join(STUB_DIR, "stub-cli.mjs");
export const ROLLOUT_DIR = path.join(STUB_DIR, "rollout");
fs.mkdirSync(ROLLOUT_DIR, { recursive: true });
fs.writeFileSync(
  STUB_CLI,
  [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'const dir = process.env.ORCH_ROLLOUT_DIR || ".";',
    'fs.mkdirSync(dir, { recursive: true });',
    'fs.writeFileSync(path.join(dir, "model-io-sess_crv2-dispatch.jsonl"), JSON.stringify({ t: 1 }) + "\\n");',
    'console.log(JSON.stringify({ type: "result", sessionId: "sess_crv2-dispatch", traceId: "tr", turnId: "tu", response: "stub-ok", usage: { inputTokens: 1 }, projection: { status: "idle", turnCount: 1 } }));',
  ].join("\n") + "\n",
);

export const sectionsOf = (md) => !md ? [] : md.split("\n").filter((l) => l.startsWith("## "))
  .map((l) => l.replace(/^## ([^（(]*)?.*/, "$1").trim()).map((l) => l.split("（")[0].split("(")[0].trim());
export const readPack = (rel) => { const p = path.join(TROOT, rel); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; };
// normToken 归一化易变面：token（原）+ 0.6 E-17 胶水行的 artifacts 软约束注记（主控 2026-10-15
// 裁决 A 授权：server.mjs 任务包模板按卡内裁决变字，对拍除该预期增量外仍逐字节，A-v060 见 v0.6.x.md §0）
// + 0.6 A2 V6-18 的 CONTEXT 节头围栏句（主控 2026-10-15 批复授权，A-v060-INJ-03）
// + 0.6 A3 V6-09 熵升级 hex(4)→hex(16)（主控 2026-10-15 批复授权：{4,16}→{4,32}，归一化语义不变）
// + W4 PO 案 A 激进重建（2026-10-24，A-v0110-PO-W4，先例 v0.6 裁决 A）：CONTRACT 规则块
//   （上报句+kind/summary/artifacts 行）与 RULES 阻塞处置句按裁决变字——新旧两形各自归一为
//   规范形（预期增量掩码；新文案本体由 A-v0110-PO-W4-01/02 静态钉，理由逐条见 v0.11.x.md §0）。
// + v1.1 W4（A1/Q5a，A-v110-W4-A1-06）：CONTRACT 节头括注「派发 prompt 头部→尾块」措辞级
//   字节变更——掩码先行（DESIGN §6.1/§6.2；新文案本体由 po-static W4 静态钉）。
export const normToken = (s) => String(s)
  .replace(/\[token\] [0-9a-f]{4,32}/g, "[token] X")
  .replace(/"token":"[0-9a-f]{4,32}"/g, '"token":"X"')
  .replace(/done 必带 artifacts 路径（软约束：[^）]*）。/g, "done 必带 artifacts 路径。")
  .replace(/进度与结果一律用 (mcp__plugin_agent-orchestrator_orch__report) 上报[；。]/g, "REPORT-CHANNEL $1")
  .replace(/kind ∈ \{milestone, blocked, question, done\}。\nsummary ≤ 200 字。\nkind=done 必带 artifacts 路径。/g, "REPORT-KIND summary artifacts")
  .replace(/kind ∈ \{milestone, blocked, question, done\}；summary ≤ 200 字；done 必带 artifacts 路径[^\n]*/g, "REPORT-KIND summary artifacts")
  .replace(/受阻\/目标矛盾\/必败门禁：立即 report\(kind=blocked, question=…\)[^\n]*/g, "RULES-BLOCKED")
  .replace(/也出现在派发 prompt (?:头部|尾块)/g, "也出现在派发 prompt 尾块")
  .replace(/## CONTEXT（[^）]*）/g, "## CONTEXT 节头");
export const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const rmRetry = (d) => { for (let i = 0; i < 6; i++) { try { fs.rmSync(d, { recursive: true, force: true }); return; } catch (e) { if (i === 5) throw e; sleep(250); } } };
