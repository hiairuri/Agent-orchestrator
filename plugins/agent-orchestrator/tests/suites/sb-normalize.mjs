/*!
 * suites/sb-normalize.mjs —— SB01/SB02/SB05（沙箱 materialize/越界检出/discard 零损伤）
 *   + M-01/M-02（F1 归一化黑盒面：空串丢弃、trim+反斜杠、归一化前缀放行）+ F1 单元抽取断言
 *
 * 覆盖断言组：A-v040-SB01/SB02/SB05、A-v050-M01/M02（写入侧+比对侧）、U 组单元面。
 *   转录自 v05-impl-02/verify.mjs（0.4.1 回归组 SB 面的 v0.5 复核）。
 *
 * 运行方式：node tests/suites/sb-normalize.mjs [--root <临时根>]
 * 前置：node >= 20；PATH 上有 git（worktree materialize/apply/discard 全链）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, Checker, DEFAULT_SERVER } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot, parseRootArg, blankMission } from "../harness/temp-root.mjs";
import { makeRepo, makeOobChange } from "../harness/git-fixture.mjs";

const ck = new Checker("sb-normalize");
const T = makeTempRoot({ prefix: "orch-sb-", root: parseRootArg() || undefined });
const fwd = (p) => String(p).split(path.sep).join("/");
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const server = DEFAULT_SERVER || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.mjs");

// ---------- U 组：从 server.mjs 源码抽取 F1 本体做单元断言（M-01/M-02 单元面）
const src = fs.readFileSync(server, "utf8");
const mF1 = src.match(/function normalizePathList\(value\) \{[\s\S]*?\n\}/);
if (!mF1) { ck.ok("U0 未找到 normalizePathList", false); ck.summary(); process.exit(1); }
const normalizePathList = new Function(`return (${mF1[0]});`)();
ck.ok("U1 非数组守卫返回[]", eq(normalizePathList("src/"), []) && eq(normalizePathList(null), []) && eq(normalizePathList(undefined), []) && eq(normalizePathList({ 0: "a" }), []));
ck.ok("U2 M-02 trim+反斜杠统一", eq(normalizePathList([" src/", "src\\b"]), ["src/", "src/b"]));
ck.ok("U3 M-01 空串丢弃+保序", eq(normalizePathList(["", "src/", "   ", "tests/", "\t"]), ["src/", "tests/"]));
ck.ok("U4 不去重", eq(normalizePathList(["src/", "src/"]), ["src/", "src/"]));
ck.ok("U5 逐项String化", eq(normalizePathList([123, true]), ["123", "true"]));

const G = makeRepo({ dir: path.join(T.root, "repoG") });
const s = startServer({ root: T.root, cwd: G.dir });
const boardFile = () => JSON.parse(fs.readFileSync(path.join(T.root, "board.json"), "utf8"));
const mission = (id) => boardFile().missions.find((x) => x && x.id === id);
const toDone = async (mid, token) => {
  // 0.6 A3 契约适配（主控 2026-10-15 批复授权，见 v0.6.x.md §0）：V6-09 fail-closed 后
  // 携 token mission 的 report 必须带派发 token；V6-42 起 apply 门槛 qa 为评审链结构体
  // （建 mid-rev reviewer mission 互指目标，再回写目标 qa）。
  await s.call("report", { mission_id: mid, worker: "orch-worker#1", kind: "done", summary: "verify done", token });
  // 0.6 A4 夹具适配（主控 2026-10-15 批复授权，见 v0.6.x.md §0）：reviewer mission 的
  // create-as-done 被 V6-20 迁移白名单合法拒绝（终态无直达）——改直写板种子。
  const bf = boardFile();
  bf.missions.push(
    blankMission({
      id: mid + "-rev",
      agent_type: "agent-orchestrator:orch-reviewer",
      status: "done",
      qa: { verdict: "pass", mission_id: mid },
    }),
  );
  fs.writeFileSync(path.join(T.root, "board.json"), JSON.stringify(bf, null, 2) + "\n");
  await s.call("board", {
    action: "upsert",
    mission: { id: mid, status: "done", qa: { verdict: "pass", reviewed_by: mid + "-rev", reviewed_at: new Date().toISOString() } },
  });
};
const wtCommit = (wt, msg) => { G.git(["add", "-A"], wt); G.git(["commit", "-m", msg], wt); };
const newMission = async (title) => {
  await s.call("board", { action: "upsert", mission: { title } });
  const ids = boardFile().missions.filter((x) => x && x.title === title).map((x) => x.id);
  return ids[ids.length - 1];
};

try {
  // ---------- SB1 materialize 全链 ----------
  const m1 = await newMission("SB1");
  const a = await s.call("context_pack", { mission_id: m1, title: "SB1", task: "请读 " + fwd(G.dir) + "/src/a.txt 并总结", isolation: "worktree", oob_allowlist: ["src/"] });
  const wt1 = path.join(T.root, "sandboxes", m1);
  ck.ok("SB1 出包+沙箱信息", !a.isError && !!m1 && a.json?.sandbox?.branch === "orch/" + m1, a.text.slice(0, 150));
  ck.ok("SB1 worktree list 含沙箱路径与分支", G.git(["worktree", "list"]).toLowerCase().includes(fwd(wt1).toLowerCase()) && G.git(["worktree", "list"]).includes("orch/" + m1));
  ck.ok("SB1 分支存在", G.git(["branch", "--list", "orch/" + m1]).trim() !== "");
  const sb1 = mission(m1)?.pack?.sandbox;
  ck.ok("SB1 board pack.sandbox 形状", sb1 && sb1.branch === "orch/" + m1 && typeof sb1.base_commit === "string" && typeof sb1.junction_shared === "boolean" && eq(sb1.oob_allowlist, ["src/"]), sb1);
  const pack1 = fs.readFileSync(path.join(T.root, "packs", m1, "pack.md"), "utf8");
  ck.ok("SB1 pack 含 SANDBOX 节与改写路径", pack1.includes("## SANDBOX") && pack1.includes(fwd(wt1) + "/src/a.txt"));
  ck.ok("SB1 pack 不含未改写 projectDir 前缀", !pack1.includes(fwd(G.dir) + "/src/a.txt"));

  // ---------- SB2 越界检出 ----------
  await toDone(m1, a.json?.token);
  makeOobChange(wt1, "README.md");
  wtCommit(wt1, "oob change");
  const ap1 = await s.call("sandbox_apply", { mission_id: m1 });
  ck.ok("SB2 apply isError 含越界改动+README.md", ap1.isError && ap1.text.includes("越界改动") && ap1.text.includes("README.md"), ap1.text.slice(0, 120));
  ck.ok("SB2 board 未变仍 done", mission(m1)?.status === "done");

  // ---------- SB5 discard 零损伤 ----------
  const headBefore = G.head();
  const porBefore = G.porcelain();
  const dis = await s.call("sandbox_discard", { mission_id: m1 });
  ck.ok("SB5 discard ok", !dis.isError && dis.json?.ok === true, dis.text.slice(0, 120));
  ck.ok("SB5 分支删除+worktree 消失", G.git(["branch", "--list", "orch/" + m1]).trim() === "" && !fs.existsSync(wt1) && !G.git(["worktree", "list"]).toLowerCase().includes(fwd(wt1).toLowerCase()));
  ck.ok("SB5 主仓 HEAD/status 字节级不变", G.head() === headBefore && G.porcelain() === porBefore);
  ck.ok("SB5 mission 仍 done", mission(m1)?.status === "done");
  const dis2 = await s.call("sandbox_discard", { mission_id: m1 });
  ck.ok("SB5 重复 discard 幂等", !dis2.isError && dis2.json?.worktree_removed === false && dis2.json?.branch_deleted === false, dis2.json);

  // ---------- M-01 空串条目（黑盒·写入侧） ----------
  const m2 = await newMission("M01");
  const b = await s.call("context_pack", { mission_id: m2, title: "M01", task: "t", isolation: "worktree", oob_allowlist: ["src/", "", "   "] });
  ck.ok("M-01 空串归一化丢弃永不落存储", !b.isError && eq(mission(m2)?.pack?.sandbox?.oob_allowlist, ["src/"]), mission(m2)?.pack?.sandbox?.oob_allowlist);

  // ---------- M-02 归一化后前缀判定生效（黑盒·比对侧） ----------
  const m3 = await newMission("M02");
  const c = await s.call("context_pack", { mission_id: m3, title: "M02", task: "t", isolation: "worktree", oob_allowlist: [" src/", "src\\b"] });
  const wt3 = path.join(T.root, "sandboxes", m3);
  ck.ok("M-02 存储为归一化列表", !c.isError && eq(mission(m3)?.pack?.sandbox?.oob_allowlist, ["src/", "src/b"]), mission(m3)?.pack?.sandbox?.oob_allowlist);
  await toDone(m3, c.json?.token);
  fs.mkdirSync(path.join(wt3, "src"), { recursive: true });
  fs.writeFileSync(path.join(wt3, "src", "b.txt"), "b\n");
  wtCommit(wt3, "feat b");
  const ap3 = await s.call("sandbox_apply", { mission_id: m3 });
  ck.ok("M-02 apply 按归一化前缀放行+合并落地", !ap3.isError && ap3.json?.ok === true && mission(m3)?.status === "closed" && G.git(["log", "--oneline", "-1"]).includes("orch: apply"), ap3.text.slice(0, 120));
} catch (e) {
  ck.ok("driver error", false, (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e)));
} finally {
  try { s.close(); } catch {}
  T.cleanup();
}
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
