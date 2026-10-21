/*!
 * suites/crv1-scope.mjs —— CRV1-01…08（冲突预检八步，验 CR-05）+ E4 形状门 + M-04
 *
 * 覆盖断言组：A-v050-CRV1-01…08、A-v050-M04（未知键 ignored_keys）、E4（scope_paths/strict_scope
 *   形状拒绝、manifest 派生键静默剥离）、M-01/M-02（upsert 准入归一化存储面）。
 *   转录自 v05-impl-04/crv1-test.mjs（场景 A/B 双临时根）。
 *
 * 运行方式：node tests/suites/crv1-scope.mjs [--root <临时根>]（缺省自建 %TEMP% 双根）
 * 前置：node >= 20；无 git 依赖。
 */
import path from "node:path";
import { startServer, Checker } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot, parseRootArg } from "../harness/temp-root.mjs";

const ck = new Checker("crv1-scope");
const argRoot = parseRootArg();
const TA = makeTempRoot({ prefix: "orch-crv1-a-", root: argRoot ? path.join(argRoot, "a") : undefined });
const TB = makeTempRoot({ prefix: "orch-crv1-b-", root: argRoot ? path.join(argRoot, "b") : undefined });
const noWarn = (r) => r.json && r.json.ok === true && !("scope_warnings" in r.json);

try {
  // ---------- 场景 A ----------
  {
    const s = startServer({ root: TA.root });
    // v0.6 A4 夹具适配：→running 仅 claim 可达（V6-20 白名单），建板后走合法 claim
    await s.call("board", { action: "upsert", mission: { id: "m1", title: "m1", scope_paths: ["src/"] } });
    let r = await s.call("board", { action: "claim", mission_id: "m1", worker: "w-crv1" });
    ck.ok("CRV1-01 m1 upsert ok, no scope_warnings", noWarn(r), r.text);
    r = await s.call("board", { action: "upsert", mission: { id: "m2", title: "m2", status: "drafted", scope_paths: ["src/a.js", "docs/"] } });
    const w = r.json?.scope_warnings;
    ck.ok("CRV1-02 exactly 1 warning with_mission_id=m1", Array.isArray(w) && w.length === 1 && w[0].with_mission_id === "m1", r.json?.scope_warnings);
    ck.ok("CRV1-03 overlap === [src/a.js]", !!w && JSON.stringify(w[0].overlap) === JSON.stringify(["src/a.js"]), w && w[0].overlap);
    const hint = w && w[0].hint;
    ck.ok("CRV1-04 hint keywords（m1+blockedBy+沙箱+独占）", typeof hint === "string" && hint.includes("m1") && hint.includes("blockedBy") && hint.includes("沙箱") && hint.includes("独占"), hint);
    // CRV1-07（G-2）：对 m1 自身重复 upsert 同 scope_paths（title 变化触发写事务）→ 无自指警告
    r = await s.call("board", { action: "upsert", mission: { id: "m1", title: "m1-retitle", scope_paths: ["src/"] } });
    const w7 = r.json?.scope_warnings || [];
    ck.ok("CRV1-07 no self-alarm on re-upsert", r.json?.ok === true && !w7.some((x) => x.with_mission_id === "m1"), r.text);
    // CRV1-08：m1 done（非 closed）→ 相交 upsert 无警告
    await s.call("board", { action: "upsert", mission: { id: "m1", status: "done" } });
    r = await s.call("board", { action: "upsert", mission: { id: "m3", title: "m3", status: "drafted", scope_paths: ["src/b.js"] } });
    ck.ok("CRV1-08 done not live", noWarn(r), r.text);
    // CRV1-06：m1 closed → 终态释放（v0.6 A4：外部归档需 close_confirmed 一次性确认）
    await s.call("board", { action: "upsert", mission: { id: "m1", status: "closed", close_confirmed: true } });
    r = await s.call("board", { action: "upsert", mission: { id: "m4", title: "m4", status: "drafted", scope_paths: ["src/x.js"] } });
    ck.ok("CRV1-06 closed releases", noWarn(r), r.text);
    s.close();
  }
  // ---------- 场景 B ----------
  {
    const s = startServer({ root: TB.root });
    // v0.6 A4 夹具适配：→running 仅 claim 可达（V6-20 白名单），建板后走合法 claim
    await s.call("board", { action: "upsert", mission: { id: "m1", title: "m1", scope_paths: ["src/"] } });
    await s.call("board", { action: "claim", mission_id: "m1", worker: "w-crv1" });
    let r = await s.call("board", { action: "upsert", mission: { id: "m2", title: "m2", status: "drafted", strict_scope: true, scope_paths: ["src/a.js"] } });
    ck.ok("CRV1-05a strict upsert isError", r.isError === true, r.text);
    ck.ok("CRV1-05b error mentions m1 + overlap path", r.isError && r.text.includes("m1") && r.text.includes("src/a.js"), r.text);
    r = await s.call("board", { action: "get", mission_id: "m2" });
    ck.ok("CRV1-05c m2 not found", r.isError === true && r.text.includes("not found"), r.text);
    r = await s.call("board", { action: "get", mission_id: "m1" });
    ck.ok("CRV1-05d m1 untouched", r.json?.status === "running" && JSON.stringify(r.json?.scope_paths) === JSON.stringify(["src/"]), r.text);
    // v0.6 A4 夹具适配：running→closed 非法（白名单），经 done 合法到站再归档
    await s.call("board", { action: "upsert", mission: { id: "m1", status: "done" } });
    await s.call("board", { action: "upsert", mission: { id: "m1", status: "closed", close_confirmed: true } });
    // E4 形状门
    r = await s.call("board", { action: "upsert", mission: { id: "m9", scope_paths: "src/" } });
    ck.ok("E4 scope_paths non-array rejected", r.isError && r.text.includes("scope_paths must be an array of strings"), r.text);
    r = await s.call("board", { action: "upsert", mission: { id: "m9", scope_paths: [123] } });
    ck.ok("E4 scope_paths non-string item rejected", r.isError && r.text.includes("scope_paths must be an array of strings"), r.text);
    r = await s.call("board", { action: "upsert", mission: { id: "m9", strict_scope: "yes" } });
    ck.ok("E4 strict_scope non-boolean rejected", r.isError && r.text.includes("strict_scope must be a boolean"), r.text);
    // M-04：未知键仍 ignored_keys
    r = await s.call("board", { action: "upsert", mission: { id: "m9", title: "m9", status: "drafted", strict_scope: true, scope_paths: [], foo: "bar" } });
    ck.ok("M-04 unknown key ignored_keys", r.json?.ok === true && Array.isArray(r.json?.ignored_keys) && r.json.ignored_keys.includes("foo"), r.json?.ignored_keys);
    // E4④：manifest 派生键静默剥离（不入 ignored_keys）
    r = await s.call("board", { action: "upsert", mission: { id: "m9", manifest: { path: "packs/m9/manifest.json" } } });
    ck.ok("E4 manifest not in ignored_keys", r.json?.ok === true && !("ignored_keys" in r.json), r.json);
    r = await s.call("board", { action: "get", mission_id: "m9" });
    ck.ok("E4 manifest absent + strict_scope stored", r.json?.manifest === undefined && r.json?.strict_scope === true, r.text);
    // F1 准入归一化（M-01/M-02 存储面）
    r = await s.call("board", { action: "upsert", mission: { id: "m10", title: "m10", status: "drafted", scope_paths: [" src/ ", "src\\b", ""] } });
    ck.ok("M-01/02 m10 upsert ok, no warnings after m1 closed", noWarn(r), r.text);
    r = await s.call("board", { action: "get", mission_id: "m10" });
    ck.ok("M-02 stored normalized [src/, src/b]", JSON.stringify(r.json?.scope_paths) === JSON.stringify(["src/", "src/b"]), r.json?.scope_paths);
    r = await s.call("board", { action: "upsert", mission: { id: "m11", title: "m11", status: "drafted", scope_paths: ["", "   "] } });
    ck.ok("M-01 m11 empty entries upsert ok", noWarn(r), r.text);
    r = await s.call("board", { action: "get", mission_id: "m11" });
    ck.ok("M-01 empty entries dropped, stored []", JSON.stringify(r.json?.scope_paths) === JSON.stringify([]), r.json?.scope_paths);
    s.close();
  }
} finally {
  TA.cleanup(); TB.cleanup();
}
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
