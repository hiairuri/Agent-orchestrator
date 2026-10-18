/*!
 * suites/condense.mjs —— CR-V9（tail=0 探测零回显+元数据逐位）/ CR-V10（≥1MB 大末行+中途重写）
 *   + CR-V16（①缺失不 throw 不动板 ②0.4.1 逐字节回归双进程对拍）+ 工具清单不变量
 *
 * 覆盖断言组：浓缩组 CR-V9/V10/V16①②（步级定义 D2 §7）；工具名集合与 0.4.1 兼容
 *   （旧十名依序保留为前缀、唯一新增 probe 尾接——v0.6 A6 口径）。
 *   转录自 v05-impl-07/acc.mjs（ORCH_ROLLOUT_DIR 测试缝注入夹具）。
 *   CR-V16③（浓缩 mission 无申报的后继 L2 回退）由 suites/crv2-pack 的 CR-V25 覆盖。
 *
 * 运行方式：node tests/suites/condense.mjs [--root <临时根>]
 * 前置：node >= 20；PATH 上有 git（d00f94c 基线导出）；无网。
 */
import fs from "node:fs";
import path from "node:path";
import { startServer, Checker } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot, parseRootArg, blankMission, boardSeed } from "../harness/temp-root.mjs";
import { repoRoot, exportFileFromGit } from "../harness/git-fixture.mjs";

const ck = new Checker("condense");
const BASE = makeTempRoot({ prefix: "orch-cond-", root: parseRootArg() || undefined });
const FIX = path.join(BASE.root, "fix");
const T1 = path.join(BASE.root, "T-cur");
const T2 = path.join(BASE.root, "T-old");
fs.mkdirSync(FIX, { recursive: true });

// ---- 夹具（已知值；jsonl，尾随换行）----
const rec = (messages, kind, usage, extra = {}) =>
  JSON.stringify({ completedAt: "2026-10-13T10:00:00.000Z", model: { modelId: "glm-test" }, request: { messages, messagesKind: kind }, response: { modelId: "glm-test", usage }, ...extra });
const M = (role, text) => ({ role, content: text });
const writeJsonl = (name, lines) => fs.writeFileSync(path.join(FIX, name), lines.join("\n") + "\n");
writeJsonl("model-io-sess_probe.jsonl", [
  rec([M("user", "older")], "full", { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 900 }),
  rec([M("user", "mid")], "delta", { inputTokens: 2000, outputTokens: 20, cacheReadTokens: 1900 }),
  rec([M("user", "PROBE_SECRET_USER_LINE"), M("assistant", "PROBE_SECRET_ASSISTANT_LINE")], "tail", { inputTokens: 123456, outputTokens: 789, cacheReadTokens: 120000 }),
]);
const pad = "PADPADPAD".repeat(120000); // ~1.08MB → 末行 ≥1MB
writeJsonl("model-io-sess_big.jsonl", [
  rec([M("user", "d1")], "delta", { inputTokens: 500, outputTokens: 5, cacheReadTokens: 400 }),
  rec([M("user", "d2")], "tail", { inputTokens: 600, outputTokens: 6, cacheReadTokens: 500 }),
  rec([M("user", pad), M("assistant", "big-last")], "tail", { inputTokens: 42, outputTokens: 7, cacheReadTokens: 40 }),
]);
writeJsonl("model-io-sess_rw.jsonl", [
  rec([M("user", "r1")], "full", { inputTokens: 100, outputTokens: 1, cacheReadTokens: 90 }),
  rec([M("user", "r2")], "delta", { inputTokens: 200, outputTokens: 2, cacheReadTokens: 190 }),
  rec([M("user", "r3")], "tail", { inputTokens: 111111, outputTokens: 3, cacheReadTokens: 110000 }),
]);
writeJsonl("model-io-sess_subagent_agent_dead01.jsonl", [
  rec([M("user", "dead mission last words")], "tail", { inputTokens: 7777, outputTokens: 88, cacheReadTokens: 7000 }),
]);

// ---- 双根同种 board（mission 寻址目标 m-dead）
fs.mkdirSync(T1, { recursive: true });
fs.mkdirSync(T2, { recursive: true });
const seed = boardSeed([blankMission({ id: "m-dead", title: "dead mission", status: "done", dispatch: { agent_id: "dead01" } })]);
fs.writeFileSync(path.join(T1, "board.json"), seed);
fs.writeFileSync(path.join(T2, "board.json"), seed);
const board1Before = fs.readFileSync(path.join(T1, "board.json"));

// ---- 双进程：现行 + 0.4.1（git d00f94c）
const H = "agent_harvest";
let cur = null, old = null;
const strip = (r) => { const c = { ...r }; delete c.usage; delete c.file_bytes; delete c.messages_kind; return c; };
const last2k = (f) => {
  const st = fs.statSync(f); const n = Math.min(2048, st.size);
  const fd = fs.openSync(f, "r"); const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, st.size - n); fs.closeSync(fd);
  const m = [...b.toString("utf8").matchAll(/"inputTokens"\s*:\s*(\d+)/g)];
  return m.length ? Number(m[m.length - 1][1]) : null;
};

try {
  cur = startServer({ root: T1, env: { ORCH_ROLLOUT_DIR: FIX } });
  let oldPath = null;
  try { oldPath = exportFileFromGit("d00f94c", repoRoot(), "plugins/agent-orchestrator/mcp/server.mjs", path.join(BASE.root, "scratch")); } catch (e) { ck.ok("0.4.1 baseline export", false, String(e)); }
  if (oldPath) old = startServer({ serverPath: oldPath, root: T2, env: { ORCH_ROLLOUT_DIR: FIX } });

  /** 成功调用解包（impl-07 直取 payload 风格）；错误路径用 cur.call 原始 wrapper */
  const HJ = async (args, srv = cur) => {
    const r = await srv.call(H, args);
    if (r.isError || r.json === null || r.json === undefined) throw new Error("isError/unparseable: " + r.text.slice(0, 200));
    return r.json;
  };

  // ---------- CR-V9 ----------
  const p0 = await HJ({ session_id: "sess_probe", tail: 0 });
  ck.ok("V9 ok:true", p0.ok === true);
  ck.ok("V9 零回显 transcript===''", p0.transcript === "", p0.transcript);
  ck.ok("V9 零回显 rendered_messages===0", p0.rendered_messages === 0, p0.rendered_messages);
  ck.ok("V9 无夹具密语泄漏", !String(p0.transcript).includes("PROBE_SECRET"));
  ck.ok("V9 usage.input_tokens 逐位 123456", p0.usage && p0.usage.input_tokens === 123456, p0.usage);
  ck.ok("V9 usage.output_tokens 789", p0.usage.output_tokens === 789, p0.usage);
  ck.ok("V9 usage.cache_read_tokens 120000", p0.usage.cache_read_tokens === 120000, p0.usage);
  ck.ok("V9 file_bytes === statSync", p0.file_bytes === fs.statSync(path.join(FIX, "model-io-sess_probe.jsonl")).size, p0.file_bytes);
  ck.ok("V9 messages_kind==='tail'", p0.messages_kind === "tail", p0.messages_kind);
  ck.ok("V9 既有键原值保留", p0.message_count === 2 && p0.completed_at === "2026-10-13T10:00:00.000Z" && p0.model_id === "glm-test" && p0.session_id === "sess_probe", p0);
  const pm = await HJ({ mission_id: "m-dead", tail: 0 });
  ck.ok("V9 mission 寻址 + usage", pm.mission_id === "m-dead" && pm.usage.input_tokens === 7777 && pm.messages_kind === "tail", pm.usage);

  // ---------- CR-V10 ----------
  const big = await HJ({ session_id: "sess_big", tail: 0 });
  ck.ok("V10a ≥1MB 末行 → 末条真值 42", big.usage.input_tokens === 42, big.usage);
  ck.ok("V10a file_bytes 匹配 ≥1MB 文件", big.file_bytes === fs.statSync(path.join(FIX, "model-io-sess_big.jsonl")).size && big.file_bytes > 1000000, big.file_bytes);
  ck.ok("V10a messages_kind tail", big.messages_kind === "tail");
  const rw1 = await HJ({ session_id: "sess_rw", tail: 0 });
  ck.ok("V10b 重写前 111111", rw1.usage.input_tokens === 111111, rw1.usage);
  writeJsonl("model-io-sess_rw.jsonl", [
    rec([M("user", "r2")], "delta", { inputTokens: 200, outputTokens: 2, cacheReadTokens: 190 }),
    rec([M("user", "r3w")], "tail", { inputTokens: 222222, outputTokens: 9, cacheReadTokens: 220000 }),
  ]);
  const rw2 = await HJ({ session_id: "sess_rw", tail: 0 });
  ck.ok("V10b 中途重写 → 222222", rw2.usage.input_tokens === 222222, rw2.usage);
  ck.ok("V10b file_bytes 跟随重写", rw2.file_bytes === fs.statSync(path.join(FIX, "model-io-sess_rw.jsonl")).size);
  ck.ok("2KB 正则互证 probe", last2k(path.join(FIX, "model-io-sess_probe.jsonl")) === p0.usage.input_tokens);
  ck.ok("2KB 正则互证 big", last2k(path.join(FIX, "model-io-sess_big.jsonl")) === big.usage.input_tokens);

  // ---------- CR-V16① ----------
  const g1 = await cur.call(H, { session_id: "sess_ghost", tail: 0 });
  ck.ok("V16a 缺失 → isError 含未找到转录", g1.isError === true && String(g1.json?.error || g1.text || "").includes("未找到转录"), g1.json || g1.text.slice(0, 120));
  const alive = await HJ({ session_id: "sess_probe", tail: 0 });
  ck.ok("V16a not-found 后 server 存活", alive.usage.input_tokens === 123456);
  ck.ok("V16a harvest 不动 board", fs.readFileSync(path.join(T1, "board.json")).equals(board1Before));
  ck.ok("V16a board version 仍 2", JSON.parse(fs.readFileSync(path.join(T1, "board.json"), "utf8")).version === 2);

  // ---------- CR-V16② 双进程逐字节对拍（剥离 v0.5 三新键后比较） ----------
  if (old) {
    for (const args of [{ session_id: "sess_probe" }, { session_id: "sess_probe", tail: 1 }, { session_id: "sess_probe", tail: 3, include_tools: false }]) {
      const a = (await old.call(H, args)).json;
      const b = strip((await cur.call(H, args)).json);
      ck.ok("V16b 剥离新键后与 0.4.1 逐字节 " + JSON.stringify(args), JSON.stringify(b) === JSON.stringify(a), JSON.stringify(b).slice(0, 100) + " VS " + JSON.stringify(a).slice(0, 100));
    }
    const ge = await old.call(H, { session_id: "sess_ghost", tail: 0 });
    const gc = await cur.call(H, { session_id: "sess_ghost", tail: 0 });
    ck.ok("V16b 缺失文件错误文案逐字节一致", gc.isError === ge.isError && gc.text === ge.text, gc.text.slice(0, 120));
  }

  // ---------- 不变量 ----------
  const tl = await cur.tools();
  const names = tl.tools.map((t) => t.name);
  ck.ok("tools/list = 11（v0.6 A6 probe 转正口径）", names.length === 11, names.length);
  if (old) {
    const tlOld = await old.tools();
    const legacy = tlOld.tools.map((t) => t.name);
    // v0.6 A6：兼容不变量同步——0.4.1 旧十名依序保留为前缀，唯一新增 probe 尾接
    //（既有工具名与顺序零漂移的语义不变，仅为设计内第 11 号工具放行）。
    ck.ok("工具名集合与 0.4.1 兼容：旧十名依序为前缀 + probe 尾接",
      names.length === legacy.length + 1 &&
      JSON.stringify(names.slice(0, legacy.length)) === JSON.stringify(legacy) &&
      names[names.length - 1].endsWith("__probe"),
      { last: names[names.length - 1] });
  }
} catch (e) {
  ck.ok("driver error", false, (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e)));
} finally {
  try { cur && cur.close(); } catch {}
  try { old && old.close(); } catch {}
  BASE.cleanup();
}
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
