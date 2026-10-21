/*!
 * suites/crv5-auth.mjs —— v0.6 鉴权 suite（A1 bootstrap：SCOPE/INJ-01；A2 波 INJ-02..04 归
 *   crv6-resilience；A3 波增例 AUTH-01..08）
 *
 * 覆盖断言组：A-v060-SCOPE-01..04（V6-10 coversPath 单函数收敛——apply 越界门
 *   src-evil 形态拒合、files_touched 审计同语义、scopeOverlap 收敛、空串全放行显式化）、
 *   A-v060-INJ-01（V6-16 harvest session_id/agent_id safeSegment+assertInside 双保险）、
 *   A-v060-AUTH-01..08（V6-09 fail-closed token 门+熵 hex(16)+成对鉴权 / V6-14 claim 必换发 /
 *   V6-17 外来续租拒绝 / V6-42 qa 四查 / V6-19A --strict-tokens 默认 off）。
 *   转录自 W-A1 §1 各断言草案；suite 注册行归主控 G 胶水波收口（run-all REGISTRY）。
 *
 * 运行方式：node tests/suites/crv5-auth.mjs [--root <临时根>]
 * 前置：node >= 20；PATH 上有 git（SCOPE-01/AUTH-08 沙箱 worktree 物化与 apply）；无网。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer, Checker, DEFAULT_SERVER, PRE } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot, parseRootArg, blankMission } from "../harness/temp-root.mjs";
import { makeRepo } from "../harness/git-fixture.mjs";

const ck = new Checker("crv5-auth");
const BASE = makeTempRoot({ prefix: "orch-crv5auth-", root: parseRootArg() || undefined });
const PROJ = path.join(BASE.root, "proj");
const T = path.join(BASE.root, "root");
const ROLL = path.join(BASE.root, "rollout"); // ORCH_ROLLOUT_DIR 测试缝
fs.mkdirSync(ROLL, { recursive: true });
makeRepo({ dir: PROJ, files: { "README.md": "readme\n", "src/a.txt": "a\n", "docs/a.md": "# A\n" } });
const s = startServer({ root: T, cwd: PROJ, env: { ORCH_ROLLOUT_DIR: ROLL } });
const resultText = (r) => r.json ?? { _raw: r.text };
const gitIn = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + (r.stderr || r.stdout));
  return r.stdout;
};
/** 沙箱派发 → 沙箱内提交改动 → done+qa pass → apply（返回响应）。
 *  V6-42 起 qa 须为结构体评审链（{verdict,reviewed_by,reviewed_at}+reviewer mission 互指），
 *  裸 {verdict:"pass"} 被 apply 四查门明确拒绝——helper 据此建链。 */
/** v0.6 A4 夹具适配（主控批复口径，见 v0.6.x.md §0）：create-as-done / drafted→done 的
 *  外部直写被 V6-20 迁移白名单合法拒绝（终态无直达、→done 仅 report/内部可达）——
 *  评审链夹具改直写板种子（server 每调用 fresh load），断言主句零改动。 */
const seedBoardWrite = (fn) => {
  const p = path.join(T, "board.json");
  const bf = JSON.parse(fs.readFileSync(p, "utf8"));
  fn(bf);
  fs.writeFileSync(p, JSON.stringify(bf, null, 2) + "\n");
};
async function approveWithReview(mid) {
  const rev = mid + "-rev";
  seedBoardWrite((bf) => {
    bf.missions.push(
      blankMission({
        id: rev,
        agent_type: "agent-orchestrator:orch-reviewer",
        status: "done",
        qa: { verdict: "pass", mission_id: mid },
      }),
    );
    const m = bf.missions.find((x) => x && x.id === mid);
    m.status = "done";
    m.qa = { verdict: "pass", reviewed_by: rev, reviewed_at: new Date().toISOString() };
  });
}
async function sandboxApplyFlow(mid, { oob, files }) {
  const pack = await s.call("context_pack", {
    mission_id: mid,
    title: mid + " 越界门探针",
    task: "验证 coversPath 越界门",
    isolation: "worktree",
    ...(oob === undefined ? {} : { oob_allowlist: oob }),
  });
  if (pack.isError) throw new Error("context_pack failed: " + pack.text);
  const wt = path.join(T, "sandboxes", mid);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(wt, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(wt, rel), content);
  }
  gitIn(wt, ["add", "-A"]);
  gitIn(wt, ["commit", "-m", "probe " + mid]);
  await approveWithReview(mid);
  return s.call("sandbox_apply", { mission_id: mid });
}
/** AUTH 通用：pack 一个 mission（铸 token）并返回响应（不落沙箱不提交） */
async function packOnly(mid, title = mid + " auth 探针") {
  const r = await s.call("context_pack", { mission_id: mid, title, task: "token 铸发探针" });
  if (r.isError) throw new Error("context_pack failed: " + r.text);
  return r.json;
}

try {
  // ---- SCOPE-01：apply 越界门——["src"] 拒 src-evil/evil.js（75232b0 形态回归）；["src/"] 行为一致
  {
    const r1 = await sandboxApplyFlow("m-sc1", { oob: ["src"], files: { "src-evil/evil.js": "evil\n" } });
    ck.ok("SCOPE-01a oob=[src] 时 src-evil/evil.js 判越界拒合", r1.isError === true && r1.text.includes("越界") && r1.text.includes("src-evil/evil.js"), r1.text.slice(0, 120));
    const r2 = await sandboxApplyFlow("m-sc2", { oob: ["src/"], files: { "src-evil/evil2.js": "evil\n" } });
    ck.ok("SCOPE-01b oob=[src/]（带尾分隔符）与 [src] 行为一致", r2.isError === true && r2.text.includes("src-evil/evil2.js"), r2.text.slice(0, 120));
  }
  // ---- SCOPE-04：空串 entry/空列表 = 全放行（显式文档化，非行为变更）
  {
    const r = await sandboxApplyFlow("m-sc4", { oob: [""], files: { "docs/extra.md": "free\n" } });
    ck.ok("SCOPE-04a oob=[\"\"] 空串全放行 → apply ok", r.isError !== true && resultText(r).ok === true, r.text.slice(0, 120));
    const src = fs.readFileSync(DEFAULT_SERVER, "utf8");
    ck.ok("SCOPE-04b 空串全放行语义已在 coversPath JSDoc 显式文档化", src.includes("allow-all"), "");
  }
  // ---- SCOPE-02：checkScopeAudit 同语义——designs-evil 不再被 designs 吞掉
  {
    await s.call("board", { action: "upsert", mission: { id: "m-sc5", title: "审计同语义探针", scope_paths: ["designs"] } });
    const r = resultText(await s.call("report", {
      mission_id: "m-sc5", worker: "w#1", kind: "done", summary: "s",
      files_touched: ["designs-evil/evil.md", "designs/ok.md"],
    }));
    ck.ok(
      "SCOPE-02 scope_paths=[designs] 时 designs-evil/evil.md 记入 warn_scope、designs/ok.md 不误伤",
      Array.isArray(r.warn_scope) && r.warn_scope.includes("designs-evil/evil.md") && !r.warn_scope.includes("designs/ok.md"),
      r.warn_scope,
    );
  }
  // ---- SCOPE-03：scopeOverlap 收敛——[src] 与 [src-evil] 不再判相交；真覆盖不误伤
  {
    // v0.6 A4 夹具适配：create-as-running 被白名单拒（→running 仅 claim）——直写种子
    seedBoardWrite((bf) => {
      bf.missions.push({ ...blankMission({ id: "m-scA", title: "在飞", status: "running" }), scope_paths: ["src"] });
    });
    const rEvil = await s.call("board", { action: "upsert", mission: { id: "m-scB", title: "近名不相交", status: "drafted", scope_paths: ["src-evil"] } });
    ck.ok("SCOPE-03a [src]×[src-evil] 无相交警告", rEvil.isError !== true && rEvil.json?.scope_warnings === undefined, rEvil.json?.scope_warnings);
    const rReal = await s.call("board", { action: "upsert", mission: { id: "m-scC", title: "真覆盖", status: "drafted", scope_paths: ["src/a.mjs"] } });
    const w = rReal.json?.scope_warnings;
    ck.ok("SCOPE-03b [src]×[src/a.mjs] 仍判相交（真覆盖不受误伤）", Array.isArray(w) && w.length === 1 && JSON.stringify(w[0].overlap) === JSON.stringify(["src/a.mjs"]), w);
  }

  // ---- INJ-01：harvest session_id/agent_id 路径穿越 → ToolError；合法三定位回归
  {
    const SESS = "sess_12345678-90ab-4cde-8f01-234567890abc";
    const AGENT = "agent_11111111-2222-4333-8444-555555555555";
    const line = JSON.stringify({
      completedAt: "2026-10-15T00:00:00.000Z",
      request: { messages: [{ role: "user", content: "hi" }], messagesKind: "full" },
      response: { modelId: "fixture-model", usage: { inputTokens: 5 } },
    }) + "\n";
    fs.writeFileSync(path.join(ROLL, `model-io-${SESS}.jsonl`), line);
    fs.writeFileSync(path.join(ROLL, `model-io-sess_subagent_agent_${AGENT}.jsonl`), line);
    await s.call("board", { action: "upsert", mission: { id: "m-inj1", title: "harvest 寻址", dispatch: { agent_id: AGENT } } });
    await s.call("board", { action: "upsert", mission: { id: "m-inj2", title: "无 agent_id" } });

    const e1 = await s.call("agent_harvest", { session_id: "x/../../../decoy" });
    ck.ok("INJ-01a session_id 正斜杠穿越 → ToolError invalid session_id", e1.isError === true && e1.text.includes("invalid session_id"), e1.text.slice(0, 100));
    const e2 = await s.call("agent_harvest", { session_id: "..\\decoy" });
    ck.ok("INJ-01b session_id 反斜杠穿越 → ToolError invalid session_id", e2.isError === true && e2.text.includes("invalid session_id"), e2.text.slice(0, 100));
    const ok1 = resultText(await s.call("agent_harvest", { session_id: SESS }));
    ck.ok("INJ-01c 合法 sess_ 定位回归不误伤", ok1.ok === true && ok1.session_id === SESS, ok1.session_id);
    const ok2 = resultText(await s.call("agent_harvest", { agent_id: AGENT }));
    ck.ok("INJ-01d 合法 agent_ 定位回归（映射 sess_subagent_agent_）", ok2.ok === true && ok2.session_id === `sess_subagent_agent_${AGENT}`, ok2.session_id);
    const ok3 = resultText(await s.call("agent_harvest", { mission_id: "m-inj1" }));
    ck.ok("INJ-01e mission_id 定位回归（经板面解析 agent_id）", ok3.ok === true && ok3.mission_id === "m-inj1" && ok3.session_id === `sess_subagent_agent_${AGENT}`, ok3.session_id);
    const e3 = await s.call("agent_harvest", { mission_id: "m-inj2" });
    ck.ok("INJ-01f 无 agent_id mission 保留既定报错（不误伤）", e3.isError === true && e3.text.includes("无 dispatch.agent_id"), e3.text.slice(0, 100));
  }

  // ================= 场景 B：AUTH-01..06/08（A3 鉴权波增例） =================
  const unreadOf = (mid) => path.join(T, "spool", mid, "unread");
  const unreadCount = (mid) => (fs.existsSync(unreadOf(mid)) ? fs.readdirSync(unreadOf(mid)).filter((f) => f.endsWith(".json")).length : 0);
  const missionOf = async (mid) => resultText(await s.call("board", { action: "get", mission_id: mid }));
  const HEX32 = /^[0-9a-f]{32}$/;

  // ---- AUTH-01：fail-closed token 门——expectedToken 存在则缺失/空串/错值全拒（V6-09）
  {
    const pack = await packOnly("m-au1");
    const tok = String(pack.token);
    ck.ok("AUTH-02a context_pack 铸点 token 匹配 hex(16)（32 hex）", HEX32.test(tok), tok);
    const up = (token) =>
      s.call("report", { mission_id: "m-au1", worker: "w#1", kind: "milestone", summary: "s", ...(token === undefined ? {} : { token }) });
    const e1 = await up(); // 不传
    const e2 = await up(""); // 空串
    const e3 = await up("ffffffffffffffffffffffffffffffff"); // 错值
    ck.ok("AUTH-01a 不传 token → ToolError（missing token）", e1.isError === true && e1.text.includes("missing token"), e1.text.slice(0, 100));
    ck.ok("AUTH-01b token 空串 → ToolError（missing token，旧 falsy 双短路已封）", e2.isError === true && e2.text.includes("missing token"), e2.text.slice(0, 100));
    ck.ok("AUTH-01c token 错值 → ToolError（token mismatch）", e3.isError === true && e3.text.includes("token mismatch"), e3.text.slice(0, 100));
    const m1 = await missionOf("m-au1");
    ck.ok(
      "AUTH-01d 三探针零事件落箱+板面零改动（spool=0、status 仍 drafted）",
      unreadCount("m-au1") === 0 && m1 && m1.status === "drafted",
      { spool: unreadCount("m-au1"), status: m1 && m1.status },
    );
    const ok1 = resultText(await up(tok));
    ck.ok(
      "AUTH-01e 正确 token milestone → ok、事件落箱、milestone 不改状态",
      ok1.ok === true && unreadCount("m-au1") === 1 && m1.status === "drafted",
      { ok: ok1.ok, spool: unreadCount("m-au1") },
    );
  }
  // ---- AUTH-02b/d：claim 铸点熵与旧格式换发（V6-09 熵 + V6-14 必换发）
  {
    await s.call("board", { action: "upsert", mission: { id: "m-au2b", title: "claim 铸点探针" } });
    const c1 = resultText(await s.call("board", { action: "claim", mission_id: "m-au2b", worker: "w2b" }));
    const m2b = await missionOf("m-au2b");
    ck.ok(
      "AUTH-02b claim 铸点 token 匹配 hex(16) 且 board dispatch.token 已写",
      HEX32.test(String(c1.token)) && m2b && m2b.dispatch && m2b.dispatch.token === c1.token,
      c1.token,
    );
    await s.call("board", { action: "upsert", mission: { id: "m-au2c", title: "旧 8hex pack 换发探针", dispatch: { token: "0123abcd" } } });
    const p2c = await packOnly("m-au2c");
    const m2c = await missionOf("m-au2c");
    ck.ok(
      "AUTH-02c 旧 8hex token 经 context_pack 被换发（沿用分支已删：≠旧值、32hex、板覆盖）",
      p2c.token !== "0123abcd" && HEX32.test(String(p2c.token)) && m2c && m2c.dispatch && m2c.dispatch.token === p2c.token,
      { new: p2c.token, board: m2c && m2c.dispatch && m2c.dispatch.token },
    );
    await s.call("board", { action: "upsert", mission: { id: "m-au2d", title: "旧 8hex claim 换发探针", dispatch: { token: "456789ab" } } });
    const c2d = resultText(await s.call("board", { action: "claim", mission_id: "m-au2d", worker: "w2d" }));
    const m2d = await missionOf("m-au2d");
    ck.ok(
      "AUTH-02d 旧 8hex token 经 claim 被换发（≠旧值、32hex、板覆盖）",
      c2d.token !== "456789ab" && HEX32.test(String(c2d.token)) && m2d && m2d.dispatch && m2d.dispatch.token === c2d.token,
      { new: c2d.token, board: m2d && m2d.dispatch && m2d.dispatch.token },
    );
  }
  // ---- AUTH-03：expectedToken=null（drafted 未派发）默认行为与 v0.5.1 一致（保底回归）
  {
    await s.call("board", { action: "upsert", mission: { id: "m-au3", title: "无 token 保底回归" } });
    const r = resultText(
      await s.call("report", { mission_id: "m-au3", worker: "w#3", kind: "milestone", summary: "no-token baseline" }),
    );
    const m3 = await missionOf("m-au3");
    ck.ok(
      "AUTH-03 无派发 token mission report（strict off）→ ok、事件落箱、状态保持 drafted（不误伤 manual 流）",
      r.ok === true && unreadCount("m-au3") === 1 && m3 && m3.status === "drafted",
      { ok: r.ok, spool: unreadCount("m-au3"), status: m3 && m3.status },
    );
  }
  // ---- AUTH-04：claim 必换发——pack token 被 claim 覆盖，旧 token 即死（V6-14）
  {
    const pack = await packOnly("m-au4");
    const t1 = String(pack.token);
    const c = resultText(await s.call("board", { action: "claim", mission_id: "m-au4", worker: "wA4" }));
    const t2 = String(c.token);
    const m4 = await missionOf("m-au4");
    ck.ok(
      "AUTH-04a claim 响应 token ≠ 旧 pack token 且 board dispatch.token 已覆盖",
      t2 !== t1 && m4 && m4.dispatch && m4.dispatch.token === t2,
      { old: t1.slice(0, 8), neu: t2.slice(0, 8) },
    );
    const eOld = await s.call("report", { mission_id: "m-au4", worker: "wA4", kind: "milestone", summary: "old", token: t1 });
    const okNew = resultText(
      await s.call("report", { mission_id: "m-au4", worker: "wA4", kind: "milestone", summary: "new", token: t2 }),
    );
    ck.ok(
      "AUTH-04b 旧 token report → ToolError；新 token report → ok（单代凭据）",
      eOld.isError === true && eOld.text.includes("token mismatch") && okNew.ok === true,
      { oldErr: eOld.text.slice(0, 80), newOk: okNew.ok },
    );
  }
  // ---- AUTH-05：租约回收→二次 claim 换发→旧 worker 双 owner 窗关闭（V6-14）
  {
    const pack = await packOnly("m-au5");
    const t1 = String(pack.token);
    const c1 = resultText(await s.call("board", { action: "claim", mission_id: "m-au5", worker: "wA5", lease_minutes: 1 }));
    const t2 = String(c1.token);
    // 手拨租约过期（board.json 直写；每次工具调用 fresh load，无缓存）
    const boardFile = path.join(T, "board.json");
    const bd = JSON.parse(fs.readFileSync(boardFile, "utf8"));
    const m5 = bd.missions.find((x) => x && x.id === "m-au5");
    m5.claim.leaseUntil = new Date(Date.now() - 60000).toISOString();
    fs.writeFileSync(boardFile, JSON.stringify(bd, null, 2) + "\n");
    await s.call("board", { action: "upsert", mission: { id: "m-au5" } }); // 触发 sweep 回收
    const afterSweep = await missionOf("m-au5");
    ck.ok(
      "AUTH-05a 租约过期 sweep 回收：owner/claim 清空、status ready（dispatch.token 保留待换发）",
      afterSweep.owner === null && afterSweep.claim === null && afterSweep.status === "ready" && afterSweep.dispatch && !!afterSweep.dispatch.token,
      { owner: afterSweep.owner, status: afterSweep.status },
    );
    const c2 = resultText(await s.call("board", { action: "claim", mission_id: "m-au5", worker: "wB5" }));
    const t3 = String(c2.token);
    const m5b = await missionOf("m-au5");
    ck.ok(
      "AUTH-05b 二次 claim 换发新 token（≠旧、≠初铸、板覆盖）",
      t3 !== t2 && t3 !== t1 && m5b && m5b.dispatch && m5b.dispatch.token === t3,
      { t2: t2.slice(0, 8), t3: t3.slice(0, 8) },
    );
    const leaseBefore = m5b.claim.leaseUntil;
    const eOld = await s.call("report", { mission_id: "m-au5", worker: "wA5", kind: "done", summary: "旧持有者翻板", token: t2 });
    const m5c = await missionOf("m-au5");
    ck.ok(
      "AUTH-05c 原 worker 持旧 token report(done) → ToolError 且租约/状态不变（双 owner 窗关闭）",
      eOld.isError === true && eOld.text.includes("token mismatch") && m5c.status === "running" && m5c.claim.leaseUntil === leaseBefore && m5c.claim.worker === "wB5",
      { err: eOld.text.slice(0, 80), status: m5c.status },
    );
    const okNew = resultText(
      await s.call("report", { mission_id: "m-au5", worker: "wB5", kind: "milestone", summary: "续租", token: t3 }),
    );
    const m5d = await missionOf("m-au5");
    ck.ok(
      "AUTH-05d 新持有者本人 report → ok 且 leaseUntil 前移（续租不误伤）",
      okNew.ok === true && m5d.claim.leaseUntil > leaseBefore,
      { renewed: m5d.claim.leaseUntil, before: leaseBefore },
    );
  }
  // ---- AUTH-06：成对鉴权——外来者携正确 token 只落事件不续租不改板（V6-09 改动三+V6-17）
  {
    await packOnly("m-au6");
    // claim 必换发（V6-14）：当前有效凭据=claim token（pack token 已死）
    const c = resultText(await s.call("board", { action: "claim", mission_id: "m-au6", worker: "wA6" }));
    const tok = String(c.token);
    const before = await missionOf("m-au6");
    const lease0 = before.claim.leaseUntil;
    const tl0 = Array.isArray(before.timeline) ? before.timeline.length : 0;
    const spool0 = unreadCount("m-au6");
    const foreign = resultText(
      await s.call("report", { mission_id: "m-au6", worker: "wB6", kind: "milestone", summary: "外来者", token: tok }),
    );
    const after = await missionOf("m-au6");
    ck.ok(
      "AUTH-06a 外来者携正确 token report → 事件落箱、warn_claim 存在、foreign_claim=true",
      foreign.ok === true && unreadCount("m-au6") === spool0 + 1 && foreign.warn_claim && foreign.foreign_claim === true,
      { ok: foreign.ok, spool: unreadCount("m-au6"), warn: foreign.warn_claim, fc: foreign.foreign_claim },
    );
    ck.ok(
      "AUTH-06b 外来者不改板：status/claim.leaseUntil/timeline 均不变（不续租不改板）",
      after.status === "running" && after.claim.leaseUntil === lease0 && (after.timeline?.length ?? 0) === tl0 && after.claim.worker === "wA6",
      { status: after.status, lease: after.claim.leaseUntil === lease0, tl: after.timeline?.length },
    );
    const own = resultText(
      await s.call("report", { mission_id: "m-au6", worker: "wA6", kind: "milestone", summary: "本人续租", token: tok }),
    );
    const after2 = await missionOf("m-au6");
    ck.ok(
      "AUTH-06c 持有者本人 report → ok 且 leaseUntil 前移 claimLeaseMinDefault（续租保留）",
      own.ok === true && after2.claim.leaseUntil > lease0,
      { lease: after2.claim.leaseUntil, before: lease0 },
    );
  }
  // ---- AUTH-08：apply qa 四查（V6-42）——负例五连各含缺项名，正例评审链通过
  {
    const pack8 = await s.call("context_pack", {
      mission_id: "m-au8",
      title: "m-au8 qa 四查探针",
      task: "qa 结构体验证",
      isolation: "worktree",
      oob_allowlist: ["src"],
    });
    if (pack8.isError) throw new Error("context_pack failed: " + pack8.text);
    const wt = path.join(T, "sandboxes", "m-au8");
    fs.mkdirSync(path.join(wt, "src"), { recursive: true });
    fs.writeFileSync(path.join(wt, "src", "au8.txt"), "au8\n");
    gitIn(wt, ["add", "-A"]);
    gitIn(wt, ["commit", "-m", "probe m-au8"]);
    const apply = () => s.call("sandbox_apply", { mission_id: "m-au8" });
    // 负例1：裸 {verdict:"pass"}（无 reviewed_by）——老板不静默降级
    // （v0.6 A4 夹具适配：drafted→done 直写被白名单拒——done 态直写板种子，qa 走原 upsert 语义）
    seedBoardWrite((bf) => {
      const m = bf.missions.find((x) => x && x.id === "m-au8");
      m.status = "done";
      m.qa = { verdict: "pass" };
    });
    const n1 = await apply();
    // 负例2：reviewed_by 指向不存在 mission
    await s.call("board", { action: "upsert", mission: { id: "m-au8", qa: { verdict: "pass", reviewed_by: "m-au8-nope", reviewed_at: "2026-10-15T00:00:00.000Z" } } });
    const n2 = await apply();
    // 负例3：评审 mission 存在但未完成（drafted）
    await s.call("board", {
      action: "upsert",
      mission: { id: "m-au8-rev", agent_type: "agent-orchestrator:orch-reviewer", status: "drafted", qa: { verdict: "pass", mission_id: "m-au8" } },
    });
    await s.call("board", { action: "upsert", mission: { id: "m-au8", qa: { verdict: "pass", reviewed_by: "m-au8-rev", reviewed_at: "2026-10-15T00:00:00.000Z" } } });
    const n3 = await apply();
    // 负例4：评审 mission done 但 agent_type 不含 reviewer（自审自批拦查）
    // （v0.6 A4 夹具适配：drafted→done 直写被白名单拒——直接改写种子态）
    seedBoardWrite((bf) => {
      const rev = bf.missions.find((x) => x && x.id === "m-au8-rev");
      rev.agent_type = "agent-orchestrator:orch-worker";
      rev.status = "done";
    });
    const n4 = await apply();
    // 负例5：评审 mission 是 reviewer 且 done，但未互指本 mission
    // （qa 是 ONE_LEVEL 合并：须显式 mission_id:null 才能剥掉负例3 种下的互指）
    await s.call("board", {
      action: "upsert",
      mission: { id: "m-au8-rev", agent_type: "agent-orchestrator:orch-reviewer", qa: { verdict: "pass", mission_id: null } },
    });
    const n5 = await apply();
    const m8neg = await missionOf("m-au8");
    ck.ok(
      "AUTH-08a..e 四查负例五连各自 ToolError 且含缺项名（reviewed_by/不存在或未完成/reviewer/互指）",
      n1.isError === true && n1.text.includes("reviewed_by") &&
        n2.isError === true && n2.text.includes("不存在或未完成") &&
        n3.isError === true && n3.text.includes("done/closed") &&
        n4.isError === true && n4.text.includes("reviewer") &&
        n5.isError === true && n5.text.includes("互指"),
      [n1, n2, n3, n4, n5].map((r) => r.text.slice(0, 60)),
    );
    ck.ok("AUTH-08neg 负例全程板面零改动（status 仍 done、未 closed）", m8neg.status === "done", m8neg.status);
    // 正例：补齐互指（review mission qa.mission_id=m-au8）→ 通过进入后续门并合流
    await s.call("board", {
      action: "upsert",
      mission: { id: "m-au8-rev", qa: { verdict: "pass", mission_id: "m-au8" } },
    });
    const pos = await apply();
    const m8pos = await missionOf("m-au8");
    ck.ok(
      "AUTH-08f 正例（done 的 reviewer mission 互指）→ apply 通过、mission closed",
      pos.isError !== true && pos.json?.ok === true && m8pos.status === "closed",
      pos.text.slice(0, 120),
    );
  }
} finally {
  s.close();
}

// ================= 场景 C：AUTH-07（V6-19A --strict-tokens，默认 off） =================
// harness startServer 不收额外 argv，这里本地起一个带旗标的 server 变体（协议同款）。
/** AUTH-07 专用：带额外 argv 的 server（按行 JSON-RPC，harness/jsonrpc-client 同款协议） */
function startStrictServer(extraArgs, { root, env = {} }) {
  const child = spawn(process.execPath, [DEFAULT_SERVER, "--root", root, ...extraArgs], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  let nextId = 1;
  const call = (name, args) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("timeout " + name)); }, 20000);
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: PRE + name, arguments: args } }) + "\n");
    }).then((r) => {
      const result = r.result || {};
      const text = (result.content ?? []).map((c) => c.text).join("\n");
      let json = null;
      try { json = JSON.parse(text); } catch { /* 错误文案非 JSON */ }
      return { isError: result.isError === true, text, json };
    });
  const close = () => { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} };
  return { call, close };
}
{
  const T7 = path.join(BASE.root, "root-strict");
  fs.mkdirSync(T7, { recursive: true });
  const ss = startStrictServer(["--strict-tokens"], { root: T7, env: { ORCH_ROLLOUT_DIR: ROLL } });
  try {
    // 07a：expectedToken=null 的 report 一律拒（B4 面收口；off 时=AUTH-03 保底行为）
    await ss.call("board", { action: "upsert", mission: { id: "m-au7", title: "strict 无 token 探针" } });
    const e7 = await ss.call("report", { mission_id: "m-au7", worker: "w#7", kind: "milestone", summary: "s" });
    ck.ok(
      "AUTH-07a strict on：expectedToken=null 的 report → ToolError（含 strict-tokens 提示）",
      e7.isError === true && e7.text.includes("--strict-tokens"),
      e7.text.slice(0, 100),
    );
    // 07b：harvest 直传 session_id/agent_id → ToolError 提示改用 mission_id
    const SESS = "sess_12345678-90ab-4cde-8f01-234567890abc";
    const AGENT = "agent_11111111-2222-4333-8444-555555555555";
    const h1 = await ss.call("agent_harvest", { session_id: SESS });
    const h2 = await ss.call("agent_harvest", { agent_id: AGENT });
    ck.ok(
      "AUTH-07b strict on：harvest 直传 session_id/agent_id → ToolError 提示 mission_id",
      h1.isError === true && h1.text.includes("mission_id") && h2.isError === true && h2.text.includes("mission_id"),
      h1.text.slice(0, 100),
    );
    // 07c：经 mission_id 解析路径照常（板面 dispatch.agent_id → 转录定位）
    await ss.call("board", { action: "upsert", mission: { id: "m-au7h", title: "strict harvest 探针", dispatch: { agent_id: AGENT } } });
    const h3 = resultText(await ss.call("agent_harvest", { mission_id: "m-au7h" }));
    ck.ok(
      "AUTH-07c strict on：harvest 经 mission_id 解析路径照常",
      h3.ok === true && h3.mission_id === "m-au7h" && h3.session_id === `sess_subagent_agent_${AGENT}`,
      h3.session_id,
    );
    // 07d：strict on 不伤正常链路——pack 铸 token 后携 token report 照常
    const p7 = await ss.call("context_pack", { mission_id: "m-au7t", title: "strict 正常链路", task: "t" });
    const r7 = resultText(
      await ss.call("report", { mission_id: "m-au7t", worker: "w#7", kind: "milestone", summary: "s", token: p7.json?.token }),
    );
    ck.ok("AUTH-07d strict on：带 token 的正常 report 照常（窄口径不误伤）", r7.ok === true, r7.ok);
  } finally {
    ss.close();
  }
  // 07e：默认 off 的静态锚——源码含旗标字面量（默认值由上方全部主 server 探针行为承载）
  const src = fs.readFileSync(DEFAULT_SERVER, "utf8");
  ck.ok("AUTH-07e 静态：--strict-tokens 旗标已注册（默认 off 由既有探针零变更承载）", src.includes('"--strict-tokens"'), "");
}

// ================= 场景 D：CFG-01..05（v0.7 V7-05 桥接四键稀疏语义） =================
// writeSentinelCfg 在 server 模块加载时同步写 <root>/sentinel.cfg.json（W-A findings §1：
// 旧实现四桥接键恒写默认值 → 哨兵 numArgBridge 桥接分支永不被咨询）。每例独立临时根 +
// 独立 argv 起 server，轮询 cfg 落盘（原子写，读到即全文）后即收进程；哨兵侧解析行为用
// numArgBridge 同款语义的表驱动复刻器锁定（CLI 层探针不给哨兵旗标 → 恒落空）。
{
  const srvSrc = fs.readFileSync(DEFAULT_SERVER, "utf8");
  const sentSrc = fs.readFileSync(path.join(path.dirname(DEFAULT_SERVER), "..", "hooks", "bg-sentinel.mjs"), "utf8");
  const spawnForCfg = (extraArgs, rootDir) => {
    fs.mkdirSync(rootDir, { recursive: true });
    return spawn(process.execPath, [DEFAULT_SERVER, "--root", rootDir, ...extraArgs], {
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ORCH_ROLLOUT_DIR: ROLL },
    });
  };
  const waitCfg = (rootDir) => {
    const p = path.join(rootDir, "sentinel.cfg.json");
    const t0 = Date.now();
    while (!fs.existsSync(p)) {
      if (Date.now() - t0 > 15000) throw new Error("sentinel.cfg.json not written: " + p);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // 同步睡 50ms
    }
    return JSON.parse(fs.readFileSync(p, "utf8"));
  };
  const killChild = (child) => { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} };
  // bg-sentinel numArgBridge 复刻（L96-108 同款语义；CLI 层恒空 → cfg[新键]>cfg[桥接键]>内建）
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const bridgeReplica = (cfg, cfgKey, bridgeKey, def, min, max) => {
    const c = Number(cfg ? cfg[cfgKey] : NaN);
    if (Number.isFinite(c)) return clamp(c, min, max);
    const b = bridgeKey ? Number(cfg ? cfg[bridgeKey] : NaN) : NaN;
    if (Number.isFinite(b)) return clamp(b, min, max);
    return def;
  };
  // 桥接表（bg-sentinel L1091-1092 逐参数转录：refire←wake_timeout_min 内建 5、cap←wake_retries 内建 3）
  const BRIDGE_TABLE = [
    { key: "refire_gap_min", bridge: "wake_timeout_min", def: 5, min: 0.01, max: 1440 },
    { key: "wake_cap", bridge: "wake_retries", def: 3, min: 1, max: 100 },
  ];
  const BRIDGE_KEYS = ["wake_timeout_min", "wake_retries", "refire_gap_min", "wake_cap"];
  const V2_DEFAULTS = {
    wake_poll_sec: 60, wake_grace_min: 5, answer_grace_min: 3, stall_grace_min: 30,
    crash_grace_min: 10, coord_idle_min: 3, cap_window_min: 120, family_size: 3,
    stagger_sec: 20, max_lifetime_min: 1440,
  };

  // ---- CFG-01：无 argv 启动 → 桥接四键全省略；其余 v2 键在位且=现行默认 ----
  {
    const R = path.join(BASE.root, "root-cfg1");
    const child = spawnForCfg([], R);
    const cfg = waitCfg(R);
    killChild(child);
    const hit = BRIDGE_KEYS.filter((k) => k in cfg);
    ck.ok(
      "CFG-01a 无 argv 启动 → sentinel.cfg.json 无桥接四键（键缺失，非 null 占位）",
      hit.length === 0,
      { hit, head: JSON.stringify(cfg).slice(0, 100) },
    );
    const drift = Object.entries(V2_DEFAULTS).filter(([k, v]) => cfg[k] !== v).map(([k]) => k);
    ck.ok(
      "CFG-01b 其余 v2 键在位且=现行默认（恒写不回归）+ signals 块在位",
      drift.length === 0 && cfg.signals && typeof cfg.signals === "object" && typeof cfg.signals.rollout_dir === "string",
      { drift, hasSignals: !!cfg.signals },
    );
  }
  // ---- CFG-02：--wake-timeout-min 30 → 直写 30、refire 键省略；桥接复刻解析 refire=30 ----
  {
    const R = path.join(BASE.root, "root-cfg2");
    const child = spawnForCfg(["--wake-timeout-min", "30"], R);
    const cfg = waitCfg(R);
    killChild(child);
    ck.ok(
      "CFG-02a --wake-timeout-min 30 → cfg.wake_timeout_min=30 且 refire_gap_min 键省略",
      cfg.wake_timeout_min === 30 && !("refire_gap_min" in cfg),
      { wtm: cfg.wake_timeout_min, hasRefire: "refire_gap_min" in cfg },
    );
    const resolved = BRIDGE_TABLE.map((row) => ({ k: row.key, v: bridgeReplica(cfg, row.key, row.bridge, row.def, row.min, row.max) }));
    ck.ok(
      "CFG-02b numArgBridge 三层复刻（CLI 层空）：refire 解析=30（桥接生效，用户旗标可达两枪间隔）、cap=内建 3",
      resolved[0].v === 30 && resolved[1].v === 3,
      resolved,
    );
  }
  // ---- CFG-03：--refire-gap-min 8 显式直写生效，优先于桥接（CLI>cfg[新键]>cfg[桥接键]>内建 层序回归） ----
  {
    const R = path.join(BASE.root, "root-cfg3");
    const child = spawnForCfg(["--refire-gap-min", "8"], R);
    const cfg = waitCfg(R);
    killChild(child);
    const replica = bridgeReplica(cfg, "refire_gap_min", "wake_timeout_min", 5, 0.01, 1440);
    ck.ok(
      "CFG-03 --refire-gap-min 8 → cfg 直写 8、wake_timeout_min 键省略、复刻解析=8（直读优先于桥接）",
      cfg.refire_gap_min === 8 && !("wake_timeout_min" in cfg) && replica === 8,
      { rg: cfg.refire_gap_min, hasWtm: "wake_timeout_min" in cfg, replica },
    );
  }
  // ---- CFG-04：${…} 模板/空串/非法值 → 视同未传（键省略），不写垃圾值 ----
  {
    const R = path.join(BASE.root, "root-cfg4");
    const child = spawnForCfg(
      ["--wake-timeout-min", "${WAKE_TIMEOUT_MIN}", "--wake-retries", "", "--refire-gap-min", "abc", "--wake-cap", "3x"],
      R,
    );
    const cfg = waitCfg(R);
    killChild(child);
    const hit = BRIDGE_KEYS.filter((k) => k in cfg);
    ck.ok(
      "CFG-04 ${…}/空串/非法值/尾随垃圾 → 四键全省略（numArgOpt 判空面完备）；其余 v2 键不受染",
      hit.length === 0 && cfg.wake_poll_sec === 60 && cfg.max_lifetime_min === 1440,
      { hit, poll: cfg.wake_poll_sec },
    );
  }
  // ---- CFG-05（默认值漂移锁）：四键缺省时哨兵解析结果=bg-sentinel 内建默认（5/3）；
  //      双文件常量子串断言——防未来任一侧改默认复活 shadow（W-A findings §1.4）。 ----
  {
    const R = path.join(BASE.root, "root-cfg5");
    const child = spawnForCfg([], R);
    const cfg = waitCfg(R);
    killChild(child);
    const resolved = BRIDGE_TABLE.map((row) => bridgeReplica(cfg, row.key, row.bridge, row.def, row.min, row.max));
    ck.ok(
      "CFG-05a 四键缺省 → 复刻解析 refire=5、cap=3（与今日哨兵内建默认零漂移）",
      resolved[0] === 5 && resolved[1] === 3,
      resolved,
    );
    // server 面：桥接四键必须走 numArgOpt 条件写（无条件默认写无法回潮）
    const srvHasOpt = [
      'numArgOpt(argv, "--wake-timeout-min", 1, 1440)',
      'numArgOpt(argv, "--wake-retries", 1, 100)',
      'numArgOpt(argv, "--refire-gap-min", 0.01, 1440)',
      'numArgOpt(argv, "--wake-cap", 1, 100)',
    ].every((s) => srvSrc.includes(s));
    const srvNoLegacy = [
      "--wake-timeout-min", "--wake-retries", "--refire-gap-min", "--wake-cap",
    ].every((f) => !srvSrc.includes(`numArg(argv, "${f}"`));
    // 哨兵面：桥接连线与内建默认（5/3）原样在位（哨兵侧零改动锚）
    const sentBridge = sentSrc.includes('"refire_gap_min", "wake_timeout_min", 5,') &&
      sentSrc.includes('"wake_cap", "wake_retries", 3,');
    ck.ok(
      "CFG-05b 双文件常量锁：server 四键全为 numArgOpt 条件写（numArg 无遗留）、哨兵桥接连线+内建 5/3 在位",
      srvHasOpt && srvNoLegacy && sentBridge,
      { srvHasOpt, srvNoLegacy, sentBridge },
    );
  }
}

BASE.cleanup();
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
