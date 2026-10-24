/*!
 * suites/crv3-present.mjs —— CRV3-01…03（相交转串行）+ CR-V26/27/28（懒迁移/呈现面/mailbox 帽）
 *   + M-03/M-04/M-05/M-06（懒迁移审计/白名单/豁免同源/warn_scope 分键）
 *
 * 覆盖断言组：A-v050-CRV3-01…03、A-v050-M03/M05/M06（M04 在 crv1-scope 亦有）、
 *   CR-V26（0.4.x 旧板懒迁移）、CR-V27（t1_head/artifacts_n/output_files_n/has_question/
 *   question_head/claim 小对象）、CR-V28（mailbox read details 帽 2000+逐字标记+提示句，spool 全文存证）。
 *   转录自 v05-impl-06/acc.mjs。
 *
 * 运行方式：node tests/suites/crv3-present.mjs [--root <临时根>]
 * 前置：node >= 20；无 git 依赖（旧板种子由 fixture-board 姿态工厂构造）。
 */
import fs from "node:fs";
import path from "node:path";
import { startServer, Checker } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot, parseRootArg, blankMission } from "../harness/temp-root.mjs";
import { postures } from "../harness/fixture-board.mjs";

const ck = new Checker("crv3-present");
const T = makeTempRoot({ prefix: "orch-crv3-", root: parseRootArg() || undefined });
const HINT = "details 已截断（帽 2000 字）：长文应写文件走 artifacts，邮箱只传摘要";

// ---- 0.4.x 旧板种子（无 scope/manifest/t1_head 键）
fs.writeFileSync(path.join(T.root, "board.json"), JSON.stringify({
  version: 2,
  updated_at: new Date().toISOString(),
  missions: [postures.legacy04xDone("m-old"), postures.legacy04xDispatched("m-leg")],
}) + "\n");

const s = startServer({ root: T.root, cwd: T.root });
/** 解包：isError 或非 JSON → throw（impl-06 直取 payload 风格） */
const J = (r) => { if (r.isError || r.json === null || r.json === undefined) throw new Error("isError/unparseable: " + r.text.slice(0, 200)); return r.json; };
const board = async (args) => J(await s.call("board", args));
const report = async (args) => J(await s.call("report", args));
const mailbox = async (args) => J(await s.call("mailbox", args));
const resume = async (args) => J(await s.call("resume", args));
const rawBoard = () => JSON.parse(fs.readFileSync(path.join(T.root, "board.json"), "utf8"));
// v0.6 A4 夹具适配（主控批复，见 v0.6.x.md §0）：create-as-running/ready 被 V6-20 迁移
// 白名单合法拒绝（→running 仅 claim 可达、drafted→ready 仅 sweep unlock 可达）——在飞态
// 夹具改直写 board.json 种子（server 每调用 fresh load），断言主句零改动。
const seedMission = (over) => {
  const p = path.join(T.root, "board.json");
  const b = rawBoard();
  // 浅合并 over：blankMission 骨架无 scope_paths 等键，over 携带时以 over 为准
  b.missions.push({ ...blankMission(over), ...over });
  fs.writeFileSync(p, JSON.stringify(b, null, 2) + "\n");
};

try {
  // ---------- CR-V26 懒迁移 ----------
  const gOld = await board({ action: "get", mission_id: "m-old" });
  ck.ok("V26 get ok + t1_head null", gOld.t1_head === null, gOld.t1_head);
  ck.ok("V26 get scope_paths []", Array.isArray(gOld.scope_paths) && gOld.scope_paths.length === 0, gOld.scope_paths);
  ck.ok("V26 get strict_scope false", gOld.strict_scope === false, gOld.strict_scope);
  ck.ok("V26 get 无 scope_violations 键", !("scope_violations" in gOld));
  const ls0 = await board({ action: "list" });
  const oldRow = ls0.missions.find((r) => r.id === "m-old");
  ck.ok("V26 list 行 t1_head null", !!oldRow && oldRow.t1_head === null);
  ck.ok("V26 干净板 list 无 scope_conflicts 键", !("scope_conflicts" in ls0));
  const rv0 = await resume({});
  const oldRv = rv0.missions.find((r) => r.id === "m-old");
  ck.ok("V26 resume 全链 ok + t1_head null", !!oldRv && "t1_head" in oldRv && oldRv.t1_head === null, oldRv && oldRv.t1_head);
  await board({ action: "upsert", mission: { id: "m-new", title: "fresh" } });
  const raw1 = rawBoard();
  const mNew = raw1.missions.find((m) => m.id === "m-new");
  const newKeys = ["scope_paths", "strict_scope", "scope_violations", "manifest", "t1_head"].filter((k) => k in mNew);
  ck.ok("V26 newMission 无新默认键", newKeys.length === 0, newKeys);
  ck.ok("V26 board version 仍 2", raw1.version === 2, raw1.version);

  // ---------- M-03 未登记：预检+审计双跳过 ----------
  seedMission({ id: "m-reg", status: "running" });
  const upReg = await board({ action: "upsert", mission: { id: "m-reg", scope_paths: ["C:/x/"] } });
  ck.ok("M-03 预检跳过未登记（无 scope_warnings）", !("scope_warnings" in upReg));
  const rpLeg = await report({ mission_id: "m-leg", worker: "w0", kind: "milestone", summary: "prog", files_touched: ["C:/anywhere/rogue.txt"] });
  ck.ok("M-03 审计跳过未登记（无 warn_scope）", !("warn_scope" in rpLeg), rpLeg.warn_scope);
  ck.ok("M-03 未登记 mission 不落 scope_violations", !("scope_violations" in rawBoard().missions.find((m) => m.id === "m-leg")));

  // ---------- M-04 未知键 ignored ----------
  const upIgn = await board({ action: "upsert", mission: { id: "m-i", title: "x", bogus: 1 } });
  ck.ok("M-04 未知键 → ignored_keys", Array.isArray(upIgn.ignored_keys) && upIgn.ignored_keys.includes("bogus"), upIgn.ignored_keys);

  // ---------- CRV3 + M-05 ----------
  seedMission({ id: "m1", status: "running", scope_paths: ["C:/proj/src/"] });
  const upM2 = await board({ action: "upsert", mission: { id: "m2", status: "drafted", scope_paths: ["C:/proj/src/app.ts"] } });
  ck.ok("M-05 upsert 相交警告指向 m1", Array.isArray(upM2.scope_warnings) && upM2.scope_warnings.some((w) => w.with_mission_id === "m1"), upM2.scope_warnings);
  ck.ok("M-05 警告形状 {with_mission_id, overlap, hint}", upM2.scope_warnings[0] && Array.isArray(upM2.scope_warnings[0].overlap) && typeof upM2.scope_warnings[0].hint === "string" && upM2.scope_warnings[0].overlap.includes("C:/proj/src/app.ts"), upM2.scope_warnings[0]);
  const ls1 = await board({ action: "list" });
  ck.ok("E7 list 顶层 scope_conflicts", Array.isArray(ls1.scope_conflicts) && ls1.scope_conflicts.some((c) => c.with_mission_id === "m1"), ls1.scope_conflicts);
  ck.ok("M-05 list 条目与 upsert 警告同构", JSON.stringify(Object.keys(ls1.scope_conflicts[0]).sort()) === JSON.stringify(["hint", "overlap", "with_mission_id"]), ls1.scope_conflicts[0]);
  // CRV3-01：blockedBy 遮挡豁免
  await board({ action: "upsert", mission: { id: "m2", blockedBy: ["m1"] } });
  const ls2 = await board({ action: "list" });
  ck.ok("CRV3-01 补 blockedBy → list 无 scope_conflicts", !("scope_conflicts" in ls2), ls2.scope_conflicts);
  const upM2b = await board({ action: "upsert", mission: { id: "m2", scope_paths: ["C:/proj/src/app.ts"] } });
  ck.ok("M-05 转串行后同空（upsert 亦静默）", !("scope_warnings" in upM2b), upM2b.scope_warnings);
  // CRV3-02：sweep 自动解锁
  await board({ action: "upsert", mission: { id: "m1", status: "done" } });
  const g2 = await board({ action: "get", mission_id: "m2" });
  ck.ok("CRV3-02 sweep 解锁 → ready", g2.status === "ready", g2.status);
  ck.ok("CRV3-02 timeline 含 unlock", Array.isArray(g2.timeline) && g2.timeline.some((e) => e.event === "unlock"));
  // CRV3-03：哨兵口径回归（引用 A-v040-D08）
  const rv3 = await resume({});
  const m2Rv = rv3.missions.find((r) => r.id === "m2");
  ck.ok("CRV3-03 ready 行无 wake_failure 告警", !!m2Rv && m2Rv.wake_failure === null, m2Rv && m2Rv.wake_failure);
  ck.ok("CRV3-03 ready 无主仅信息性", Array.isArray(rv3.ready_unclaimed) && rv3.ready_unclaimed.some((r) => r.id === "m2") && !rv3.actions.some((a) => a.priority < 2 && a.action.includes("m2")));
  // P2-1（M10，A-v0110-M10-02）：ready 呈现文案的池工章号防漂——SKILL W2 重排后
  // 池工/DAG 章=第 13 章（旧 §18）；resume 呈现面两条 action 文案逐字锁新章号。
  const poolActs = rv3.actions.filter((a) => typeof a.action === "string" && a.action.includes("派池工"));
  ck.ok("P2-1 ready 呈现文案池工指针=第 13 章（每条含）", poolActs.length >= 1 && poolActs.every((a) => a.action.includes("第 13 章")), poolActs.map((a) => a.action));
  ck.ok("P2-1 resume 呈现面旧章号 第 18 章 零残留", !rv3.actions.some((a) => typeof a.action === "string" && a.action.includes("第 18 章")), rv3.actions.map((a) => a.action));

  // ---------- CR-V27 呈现面 ----------
  seedMission({ id: "m7", status: "running", artifacts: ["p/a.md", "p/b.md"], output_files: ["o.txt"] });
  const S200 = "S".repeat(200);
  await report({ mission_id: "m7", worker: "w7", kind: "done", summary: S200 });
  const g7 = await board({ action: "get", mission_id: "m7" });
  ck.ok("V27 get t1_head = summary 头 160", g7.t1_head === S200.slice(0, 160), g7.t1_head && g7.t1_head.length);
  ck.ok("V27 get artifacts_n/output_files_n", g7.artifacts_n === 2 && g7.output_files_n === 1, [g7.artifacts_n, g7.output_files_n]);
  ck.ok("V27 get has_question false", g7.has_question === false, g7.has_question);
  const ls7 = await board({ action: "list" });
  const r7 = ls7.missions.find((r) => r.id === "m7");
  ck.ok("V27 list 行 t1_head 一致", r7 && r7.t1_head === S200.slice(0, 160) && r7.artifacts_n === 2 && r7.output_files_n === 1);
  const rv7a = await resume({});
  const r7a = rv7a.missions.find((r) => r.id === "m7");
  ck.ok("V27 未签收 done 行 resume 附 t1_head", r7a && "t1_head" in r7a && r7a.t1_head === S200.slice(0, 160));
  await board({ action: "ack", mission_id: "m7", note: "seen" });
  const rv7b = await resume({});
  const r7b = rv7b.missions.find((r) => r.id === "m7");
  ck.ok("V27 已签收 done 行 resume 无 t1_head 键", r7b && !("t1_head" in r7b));
  seedMission({ id: "m-q", status: "running" });
  const Q300 = "Q".repeat(300);
  await report({ mission_id: "m-q", worker: "wq", kind: "question", summary: "need input", question: Q300 });
  const rvq = await resume({});
  const rq = rvq.missions.find((r) => r.id === "m-q");
  ck.ok("V27 question 行 question_head≤160+逐字头", rq && rq.blocked && rq.blocked.question_head === Q300.slice(0, 160), rq && rq.blocked);
  ck.ok("V27 question 行无全量 question 键", rq && rq.blocked && !("question" in rq.blocked));
  seedMission({ id: "m-c", status: "ready" });
  const cl = await board({ action: "claim", mission_id: "m-c", worker: "wc" });
  ck.ok("V27 claim 小对象无 t1_head", cl && !("t1_head" in cl), Object.keys(cl));

  // ---------- CR-V28 mailbox 帽 ----------
  seedMission({ id: "m8", status: "running" });
  const D = "x".repeat(2000) + "y".repeat(3000);
  const rp8 = await report({ mission_id: "m8", worker: "w8", kind: "done", summary: "done m8", details: D });
  const pk = await mailbox({ action: "peek", mission_id: "m8" });
  ck.ok("V28 peek 不含 details", pk.events.length === 1 && !("details" in pk.events[0]), pk.events[0] && Object.keys(pk.events[0]));
  const rd = await mailbox({ action: "read", mission_id: "m8" });
  const ev = rd.events[0];
  // v0.6 (V6-18, INJ-04)：details 帽 DETAILS_MAX_CHARS=4000 正落 spool 写入点——
  // 存储面 5000→截 4000，read 呈现标记随之 [截断于4000字]（主控 2026-10-15 批复授权适配）
  ck.ok("V28 read details=头 2000+标记+提示句逐字", ev.details === D.slice(0, 2000) + "…[截断于4000字]" + HINT, ev.details.slice(1990) + "...");
  const spoolEv = JSON.parse(fs.readFileSync(path.join(T.root, "spool", "m8", "read", rp8.event_id + ".json"), "utf8"));
  ck.ok("V28 spool 事件保存储帽 4000 字（V6-18）", spoolEv.details === D.slice(0, 4000) && spoolEv.details.length === 4000, spoolEv.details.length);
  const rd2 = await mailbox({ action: "read", mission_id: "m8" });
  ck.ok("V28 二次 read consumed=0", rd2.consumed === 0, rd2.consumed);

  // ---------- M-06 warn_scope 分键 ----------
  seedMission({ id: "m6", status: "running", scope_paths: ["C:/proj/src/"] });
  const rp6 = await report({ mission_id: "m6", worker: "w6", kind: "milestone", summary: "prog", files_touched: ["C:/proj/src/ok.ts", "C:/other/rogue.ts"] });
  ck.ok("M-06 warn_scope 独立分键", JSON.stringify(rp6.warn_scope) === JSON.stringify(["C:/other/rogue.ts"]), rp6.warn_scope);
  ck.ok("M-06 warn 合计行仍提及 scope", typeof rp6.warn === "string" && rp6.warn.includes("scope 越界"), rp6.warn);
  ck.ok("M-06 scope_violations 落 mission", JSON.stringify(rawBoard().missions.find((m) => m.id === "m6").scope_violations) === JSON.stringify(["C:/other/rogue.ts"]));
  const g6v = await board({ action: "get", mission_id: "m6" });
  ck.ok("E6 scope_violations 自然透出", JSON.stringify(g6v.scope_violations) === JSON.stringify(["C:/other/rogue.ts"]), g6v.scope_violations);

  // ---------- 不变量 ----------
  const tl = await s.tools();
  ck.ok("invariant tools/list = 11（v0.6 A6 probe 转正口径）", Array.isArray(tl.tools) && tl.tools.length === 11, tl.tools && tl.tools.length);
} catch (e) {
  ck.ok("driver error", false, (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e)));
} finally {
  s.close();
  T.cleanup();
}
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
