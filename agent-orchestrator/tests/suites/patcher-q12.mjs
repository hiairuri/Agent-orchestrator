// @module patcher-q12
/*!
 * suites/patcher-q12.mjs —— Q-12 patcher 资产面四腿（v1.7.0 W3a 施工波；tests/assertions/v1.7.0.md §W3）
 *
 * 权威面：patches/orch-meta-user/{actions.json,manifest.json,base-snapshot.md} +
 *   commands/orch-meta-user-patch.md（授权门指令）；设计基座=designs/agent-orchestrator-v1.7.0-planning/
 *   proposal.md §3（五锚 A1-A5 DR-02 实测）+goal-card.md+impl-plan §2.3；notirc-w3 家族同构
 *   （.zcode/orchestrator/patches/notirc-w3 先例：基底快照+actions+manifest+rollback 段）。
 *
 * 覆盖断言组：
 *   Q12-01 锚签名唯一性腿（资产形状+合成夹具 dry-run+活体 bundle dry-run〔SKIP 容错：
 *     缺席=异机；sha 漂移=重打流信号〕——expect_count=1 全锚对拍）
 *   Q12-02 补丁幂等/反向腿（apply→node --check→幂等重 apply no-op→reverse→sha256 字节级复原；
 *     夹具腿恒跑+活体腿 SKIP 容错同上）
 *   Q12-03 brief 读面三态 fail-soft 腿（Xqb 读面单测：缺席/在场/mtime 缓存/mtime 变更/超帽截断/
 *     门控跳过 六态；applied-fixture 端到端：init 单读→每请求 meta_user 携带→mtime 变更一请求滞后
 *     传播→缺席保持 fail-soft）
 *   Q12-04 授权指令存在性钉（commands/orch-meta-user-patch.md 在册+frontmatter+授权门句+双门+
 *     装机管线+回滚段+重打流 字面钉；资产三件在册对拍；N3 CJK/MH-02 版本标记自合规）
 *
 * 口径：本波零宿主装机（活体腿只读；写面只落 %TEMP% 临时根）；引擎语义=搜索式定位
 *   （锚 count==1→splice；payload 在场=已应用 no-op），reverse=payload→anchor 换回（锚字面即原字节）。
 *
 * 运行方式：node tests/suites/patcher-q12.mjs [--root <临时根父目录>]
 *   活体目标解析：env ORCH_Q12_BUNDLE > C:/Program Files/ZCode/resources/glm/zcode.cjs；
 *   缺席或 sha256 与 manifest.base.sha256 失配 → 活体腿 [SKIP: ...] 容错（夹具腿不受影响）。
 * 前置：node >= 20；无网。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PLUGIN_DIR, Checker } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot } from "../harness/temp-root.mjs";

const ck = new Checker("patcher-q12");
const ASSETS = path.join(PLUGIN_DIR, "patches", "orch-meta-user");
const countOf = (text, needle) => {
  let n = 0, i = 0;
  while ((i = text.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
};
const sha256 = (s) => crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

/* ---------------- assets ---------------- */
let actions = null;
let manifest = null;
let cmdSrc = "";
let baseSnapshot = "";
try { actions = JSON.parse(fs.readFileSync(path.join(ASSETS, "actions.json"), "utf8")); } catch { /* 落红于 Q12-04 */ }
try { manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, "manifest.json"), "utf8")); } catch { /* 落红于 Q12-04 */ }
try { cmdSrc = fs.readFileSync(path.join(PLUGIN_DIR, "commands", "orch-meta-user-patch.md"), "utf8"); } catch { /* 落红于 Q12-04 */ }
try { baseSnapshot = fs.readFileSync(path.join(ASSETS, "base-snapshot.md"), "utf8"); } catch { /* 落红于 Q12-04 */ }

const A = actions ? Object.fromEntries(actions.map((a) => [a.id, a])) : null;
const BYTE_IDS = actions ? actions.filter((a) => a.apply && a.apply.kind !== "verify-only").map((a) => a.id) : [];

/* ---------------- engine (mirror of the registration dry-run semantics; keep in sync) ---------------- */
function applyAll(actionsList, base) {
  let buf = base;
  const applied = [];
  for (const a of actionsList) {
    if (a.apply.kind === "verify-only") continue;
    const cA = countOf(buf, a.anchor.literal);
    const cP = countOf(buf, a.apply.payload);
    if (cP === 0) {
      if (cA !== 1) throw new Error(`apply ${a.id}: payload absent but anchor count=${cA}`);
      const at = buf.indexOf(a.anchor.literal);
      const end = a.apply.kind === "insert" ? at : at + a.anchor.literal.length;
      buf = buf.slice(0, at) + a.apply.payload + buf.slice(end);
      applied.push({ id: a.id, span: [at, end], kind: a.apply.kind });
    } else if (cP === 1) {
      applied.push({ id: a.id, span: null, kind: "already-applied" });
    } else {
      throw new Error(`apply ${a.id}: anchor=${cA} payload=${cP} - ambiguous state`);
    }
  }
  return { buf, applied };
}
function reverseAll(actionsList, buf) {
  const byteActions = actionsList.filter((a) => a.apply.kind !== "verify-only");
  let out = buf;
  const reversed = [];
  for (const a of [...byteActions].reverse()) {
    const cP = countOf(out, a.apply.payload);
    if (cP !== 1) throw new Error(`reverse ${a.id}: payload count=${cP}`);
    const at = out.indexOf(a.apply.payload);
    const replacement = a.apply.kind === "insert" ? "" : a.anchor.literal;
    out = out.slice(0, at) + replacement + out.slice(at + a.apply.payload.length);
    reversed.push(a.id);
  }
  return { buf: out, reversed };
}
const nodeCheck = (file) =>
  spawnSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 120000 });

/* ---------------- shared post-checks (fixture and live-patched buffers alike) ---------------- */
const POST_CHECKS = [
  ["count of 'function Yqb(e)' == 1", (t) => countOf(t, "function Yqb(e)") === 1],
  ["count of 'async function Xqb(e)' == 1", (t) => countOf(t, "async function Xqb(e)") === 1],
  ["count of '\"Orch Memory\"' == 1", (t) => countOf(t, '"Orch Memory"') === 1],
  ["count of 'source:\"orch_meta_brief\"' == 1", (t) => countOf(t, 'source:"orch_meta_brief"') === 1],
  ["count of 'await Xqb(this)' == 1", (t) => countOf(t, "await Xqb(this)") === 1],
  ["count of 'orchMetaBrief:this.orchMetaBrief' == 1", (t) => countOf(t, "orchMetaBrief:this.orchMetaBrief") === 1],
  ["count of 'orchMetaBrief:e.orchMetaBrief' == 2", (t) => countOf(t, "orchMetaBrief:e.orchMetaBrief") === 2],
  ["count of 'orchMetaBrief:n.orchMetaBrief' == 1", (t) => countOf(t, "orchMetaBrief:n.orchMetaBrief") === 1],
  ["count of 'Yqb(this.config.orchMetaBrief)' == 1", (t) => countOf(t, "Yqb(this.config.orchMetaBrief)") === 1],
  ["count of 'Xqb(e),e.contextBuilder=' == 1", (t) => countOf(t, "Xqb(e),e.contextBuilder=") === 1],
  ["count of 'orchMetaBriefStamp' == 2", (t) => countOf(t, "orchMetaBriefStamp") === 2],
  ["count of 'meta-user-brief.md' == 1", (t) => countOf(t, "meta-user-brief.md") === 1],
];
const NEW_IDS = ["Xqb", "Yqb", "orchMetaBrief", "orchMetaBriefStamp", "orch_meta_brief", "Orch Memory", "meta-user-brief"];

/* ---------------- synthetic fixture (all anchors embedded verbatim, valid script pre- and post-patch) ---------------- */
function makeFixtureText() {
  const L = (id) => A[id].anchor.literal;
  return [
    "const ef=(s)=>Math.ceil(String(s).length/4);",
    'const M9o={join:(...p)=>p.join("/")};',
    "var A3a;" + A["q12-m0"].secondary_anchor.literal + ";",
    'function Fxt(e){return e.map(t=>t.content).join("\\n\\n")}',
    "function fce(d){return null}",
    "async function D9o(x){}",
    "function KDn(e){let t=e.filter(a=>a." + L("q12-m0") + ");return t.length?{source:'context_prefix',content:Fxt(t)}:null}",
    "function h3a(e){return null}",
    L("q12-m1"),
    L("q12-m7") + 'let i=M9o.join(t,"MEMORY.md");try{let a=await o.readTextFile({path:i});return a.content}catch{return}}',
    "function makeBuilder(n,memroot,opts){return{config:{...opts,memoryRoot:memroot},build(){let t=[];" + L("q12-m6") + "let _=fce(this.config.currentDate);_&&t.push(_);return{sections:t,metaUser:KDn(t)}}}}",
    'async function sessionInit(){let i={workingDirectory:"/w"},t={model:"x"};this.memoryRoot="m";this.memoryIndexContent="idx";' + L("q12-m2") + ";this.contextInitialized=!0;return this.contextBuilder}",
    'function qTmain(e,t={}){if(!e.contextBuilder||!e.contextInitialized)return e.contextBuilder&&(e.contextBuilder=e.createContextBuilderFromSnapshot(e.createConfigOnlyContextSnapshot(e.workingDirectory),e.memoryRoot,' + L("q12-m3") + ')),t.turnRequestEntries??e.messageHistory.borrowReadOnlyRuntimeEntries();let n=e.contextSourceSnapshot??e.createConfigOnlyContextSnapshot(e.workingDirectory);' + L("q12-m4") + ";return o.metaUser}",
    'function F9o(e,t,nn={}){let cfg={workingDirectory:e.workingDirectory,' + L("q12-m5") + '};return cfg}',
    "",
  ].join("\n");
}

/* ---------------- fake port (mirrors the adapter contract: stat->{kind,mtimeMs}, readTextFile maxBytes truncate) ---------------- */
function makePort(files) {
  const state = { statCalls: 0, reads: 0 };
  return {
    state,
    async stat({ path: p }) {
      state.statCalls++;
      const f = files.get(p);
      if (!f) throw Object.assign(new Error("ENOENT: " + p), { code: "ENOENT" });
      return { kind: "file", path: p, sizeBytes: f.content.length, mtimeMs: f.mtimeMs };
    },
    async readTextFile({ path: p, maxBytes }) {
      state.reads++;
      const f = files.get(p);
      if (!f) throw Object.assign(new Error("ENOENT: " + p), { code: "ENOENT" });
      let c = f.content;
      if (maxBytes !== undefined && c.length > maxBytes) c = c.slice(0, maxBytes);
      return { content: c, revision: { mtimeMs: f.mtimeMs } };
    },
  };
}
const flushTicks = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

/* ================================ Q12-04 assets + authorization command pins (cheap legs first) ================================ */
ck.ok("Q12-04 patches/orch-meta-user/actions.json parses, 8 actions, ids unique, 7 byte actions + 1 verify-only",
  !!actions && actions.length === 8 && new Set(actions.map((a) => a.id)).size === 8 && BYTE_IDS.length === 7,
  { got: actions ? actions.length : null });
ck.ok("Q12-04 every byte action: payload non-empty, payload != anchor, expect_count=1, span recorded",
  !!actions && BYTE_IDS.every((id) => {
    const a = A[id];
    return a.apply.payload && a.apply.payload !== a.anchor.literal && a.anchor.expect_count === 1
      && Array.isArray(a.span) && a.base_file_sha256 === manifest?.base?.sha256;
  }));
ck.ok("Q12-04 manifest registered: status=registered, patch_spans=7, rollback contract, registered patched sha 64-hex",
  !!manifest && manifest.status === "registered" && manifest.patch_spans.length === 7
  && !!manifest.rollback?.procedure && /^[0-9a-f]{64}$/.test(manifest.patched_sha256_registered || ""),
  { status: manifest?.status, spans: manifest?.patch_spans?.length });
ck.ok("Q12-04 base-snapshot.md on file with the pinned base sha and zero-host-install statement",
  baseSnapshot.includes(manifest?.base?.sha256 || "\u0000") && baseSnapshot.includes("Zero host install in this wave"));
ck.ok("Q12-04 commands/orch-meta-user-patch.md on file non-empty with frontmatter name pin",
  cmdSrc.trim().length > 0 && /^---\r?\n[\s\S]*?\r?\n---/.test(cmdSrc) && cmdSrc.includes("name: orch-meta-user-patch"));
ck.ok("Q12-04 authorization gate sentence pin (issuing the command = explicit user authorization)",
  cmdSrc.includes("Issuing this command IS the explicit user authorization"));
ck.ok("Q12-04 double-gate pin (patcher QA legs passed + never patch in place)",
  cmdSrc.includes("(Q12-01..04 legs) must already have passed") && cmdSrc.includes("never patch in place"));
ck.ok("Q12-04 install pipeline pin (temp-copy verify-before-install; never write the live path directly)",
  cmdSrc.includes("verify-before-install") && cmdSrc.includes("Never write the live path directly"));
ck.ok("Q12-04 canary pin (orch-meta-user: v1 marker) present for the live probe face",
  cmdSrc.includes("orch-meta-user: v1"));
ck.ok("Q12-04 rollback section + re-pin flow pin",
  cmdSrc.includes("## 4. Rollback (one-shot reverse)") && cmdSrc.includes("Re-pin = re-measure every anchor"));
ck.ok("Q12-04 command self-compliance: zero CJK lines (N3 class-4 face) and zero v1.<n> version markers (MH-02 class-4 face)",
  !/[\u4e00-\u9fff]/.test(cmdSrc) && !/v1\.\d/.test(cmdSrc));

/* ================================ Q12-01 anchor uniqueness ================================ */
ck.ok("Q12-01 fixture shape: all 8 anchor literals embedded exactly once pre-patch, new identifiers absent",
  (() => {
    try {
      const fx = makeFixtureText();
      const anchors = [A["q12-m0"].anchor.literal, A["q12-m0"].secondary_anchor.literal,
        ...BYTE_IDS.map((id) => A[id].anchor.literal)];
      if (!anchors.every((lit) => countOf(fx, lit) === 1)) return false;
      if (BYTE_IDS.some((id) => countOf(fx, A[id].apply.payload) !== 0)) return false;
      return NEW_IDS.every((id) => countOf(fx, id) === 0);
    } catch { return false; }
  })());

let liveText = null;
let liveSkip = "";
{
  const candidates = [];
  if (process.env.ORCH_Q12_BUNDLE) candidates.push(process.env.ORCH_Q12_BUNDLE);
  candidates.push("C:/Program Files/ZCode/resources/glm/zcode.cjs");
  for (const c of candidates) {
    try {
      const t = fs.readFileSync(c, "utf8");
      if (sha256(t) === manifest?.base?.sha256) { liveText = t; break; }
      liveSkip = `host bundle found but sha256 drifted off the pin (re-pin flow signal): ${c}`;
    } catch { liveSkip = `host bundle not reachable on this machine: ${candidates[0]}`; }
  }
}
if (liveText !== null) {
  const anchorOk = [A["q12-m0"].anchor.literal, A["q12-m0"].secondary_anchor.literal,
    ...BYTE_IDS.map((id) => A[id].anchor.literal)].every((lit) => countOf(liveText, lit) === 1);
  const absenceOk = NEW_IDS.every((id) => countOf(liveText, id) === 0);
  ck.ok("Q12-01 live-bundle dry-run: all 8 anchor literals count==1 on the pinned base + new identifiers absent (expect_count=1)",
    anchorOk && absenceOk, { bytes: liveText.length, drift: false });
} else {
  ck.ok(`Q12-01 live-bundle dry-run [SKIP: ${liveSkip}; fixture leg carries the mechanical coverage]`, true);
}

/* ================================ Q12-02 apply/reverse idempotency + Q12-03 fixture end-to-end ================================ */
const T = makeTempRoot({ prefix: "orch-q12-" });
try {
  // ---- fixture legs (always run) ----
  const base = makeFixtureText();
  const baseSha = sha256(base);
  const { buf: patched } = applyAll(actions, base);
  ck.ok("Q12-02 fixture apply: 12 post-checks green on the patched buffer",
    POST_CHECKS.every(([name, fn]) => fn(patched)), { failed: POST_CHECKS.filter(([, fn]) => !fn(patched)).map(([n]) => n) });
  const fixCjs = path.join(T.root, "fixture.cjs");
  fs.writeFileSync(fixCjs, patched);
  const chk = nodeCheck(fixCjs);
  ck.ok("Q12-02 fixture apply: node --check passes on the patched script", chk.status === 0,
    chk.stderr ? chk.stderr.slice(0, 200) : undefined);
  const { buf: reapplied } = applyAll(actions, patched);
  ck.ok("Q12-02 fixture idempotent re-apply: no-op (buffer identical)", reapplied === patched);
  const { buf: restored } = reverseAll(actions, patched);
  ck.ok("Q12-02 fixture reverse: sha256 byte-exact restore + anchors back + payload zero-residue",
    sha256(restored) === baseSha
    && BYTE_IDS.every((id) => countOf(restored, A[id].anchor.literal) === 1)
    && BYTE_IDS.every((id) => countOf(restored, A[id].apply.payload) === 0));

  // ---- Q12-03 leg A: Xqb reader unit (payload extracted from the assets) ----
  const Xqb = new Function("M9o", A["q12-m7"].apply.payload + "\nreturn Xqb;")({ join: (...p) => p.join("/") });
  {
    const files = new Map();
    const port = makePort(files);
    const s = { fileSystemPort: port, memoryRoot: "m", workspaceRoot: T.root, orchMetaBrief: undefined, orchMetaBriefStamp: undefined };
    await Xqb(s); // absent: stat throws -> fail-soft, no block, no throw
    ck.ok("Q12-03 absent brief: resolves with no content and no stamp (fail-soft, no block)",
      s.orchMetaBrief === undefined && s.orchMetaBriefStamp === undefined && port.state.statCalls === 1);
    const briefPath = T.root + "/.zcode/orchestrator/context/meta-user-brief.md";
    files.set(briefPath, { content: "orch-meta-user: v1\ncanary line A", mtimeMs: 1000 });
    await Xqb(s);
    ck.ok("Q12-03 present brief: content loaded, stamp = mtime",
      s.orchMetaBrief === "orch-meta-user: v1\ncanary line A" && s.orchMetaBriefStamp === 1000);
    await Xqb(s);
    ck.ok("Q12-03 mtime unchanged: cached (zero re-read)",
      s.orchMetaBrief === "orch-meta-user: v1\ncanary line A" && port.state.reads === 1);
    files.set(briefPath, { content: "orch-meta-user: v1\ncanary line B", mtimeMs: 2000 });
    await Xqb(s);
    ck.ok("Q12-03 mtime changed: re-read + content swapped",
      s.orchMetaBrief === "orch-meta-user: v1\ncanary line B" && port.state.reads === 2 && s.orchMetaBriefStamp === 2000);
    files.set(briefPath, { content: "x".repeat(20000), mtimeMs: 3000 });
    await Xqb(s);
    ck.ok("Q12-03 over-cap brief: truncated at the 8192-byte cap (fail-soft)",
      typeof s.orchMetaBrief === "string" && s.orchMetaBrief.length === 8192);
    const s2 = { fileSystemPort: port, memoryRoot: undefined, workspaceRoot: T.root };
    await Xqb(s2);
    ck.ok("Q12-03 gate: memoryRoot absent (native task-type gate mirror) -> no stat at all",
      port.state.statCalls === 5, { statCalls: port.state.statCalls });
  }

  // ---- Q12-03 leg B: applied-fixture end-to-end (init single read -> per-request meta_user -> mtime reread -> absent fail-soft) ----
  {
    const fixMjs = path.join(T.root, "fixture-behavior.mjs");
    fs.writeFileSync(fixMjs, patched + "\nexport { sessionInit, qTmain, makeBuilder };\n");
    const mod = await import(pathToFileURL(fixMjs).href);
    const files = new Map();
    const port = makePort(files);
    const briefPath = T.root + "/.zcode/orchestrator/context/meta-user-brief.md";
    const mkSession = () => ({
      workspaceRoot: T.root,
      memoryRoot: "m",
      memoryIndexContent: "idx",
      workingDirectory: T.root,
      contextSourceSnapshot: null,
      contextBuilder: undefined,
      contextInitialized: false,
      orchMetaBrief: undefined,
      orchMetaBriefStamp: undefined,
      fileSystemPort: port,
      messageHistory: { borrowReadOnlyRuntimeEntries: () => [] },
      createConfigOnlyContextSnapshot: (d) => ({ workingDirectory: d }),
      createContextBuilderFromSnapshot: mod.makeBuilder,
    });
    // absent at init: no block, no crash
    const sAbsent = mkSession();
    await mod.sessionInit.call(sAbsent);
    const metaAbsent = mod.qTmain(sAbsent, {});
    ck.ok("Q12-03 end-to-end absent brief: init + request survive, meta_user has no orch section",
      sAbsent.orchMetaBrief === undefined && (metaAbsent === null || !String(metaAbsent.content || "").includes("orch-meta-user")));
    // present at init: single read then per-request carry
    files.set(briefPath, { content: "orch-meta-user: v1\ncanary line A", mtimeMs: 1000 });
    const sess = mkSession();
    await mod.sessionInit.call(sess);
    ck.ok("Q12-03 end-to-end init single read: orchMetaBrief cached once at init", sess.orchMetaBrief === "orch-meta-user: v1\ncanary line A");
    const m1 = mod.qTmain(sess, {});
    const contentOf = (x) => (x && x.content) || "";
    ck.ok("Q12-03 end-to-end per-request: meta_user carries the orch brief section",
      contentOf(m1).includes("canary line A") && contentOf(m1).includes("orch-meta-user: v1"));
    const readsAfterFirst = port.state.reads;
    mod.qTmain(sess, {});
    ck.ok("Q12-03 end-to-end steady state: per-request guard stats but does not re-read (mtime unchanged)",
      port.state.reads === readsAfterFirst);
    // mtime change: one-request lag propagation
    files.set(briefPath, { content: "orch-meta-user: v1\ncanary line B", mtimeMs: 2000 });
    const mLag = mod.qTmain(sess, {});
    await flushTicks();
    const mNew = mod.qTmain(sess, {});
    ck.ok("Q12-03 end-to-end mtime reread: change propagates within one request (documented lag shape)",
      contentOf(mLag).includes("canary line A") && contentOf(mNew).includes("canary line B"));
    // mid-session deletion: keep-last fail-soft
    files.delete(briefPath);
    mod.qTmain(sess, {});
    await flushTicks();
    const mKeep = mod.qTmain(sess, {});
    ck.ok("Q12-03 end-to-end mid-session deletion: keeps the last known brief (fail-soft, no crash)",
      contentOf(mKeep).includes("canary line B"));
  }

  // ---- live legs (SKIP-tolerated) ----
  if (liveText !== null) {
    const tmpLive = path.join(T.root, "live");
    fs.mkdirSync(tmpLive, { recursive: true });
    const copyPath = path.join(tmpLive, "zcode.cjs");
    fs.writeFileSync(copyPath, liveText);
    const { buf: livePatched } = applyAll(actions, liveText);
    const liveChecks = POST_CHECKS.every(([name, fn]) => fn(livePatched));
    const patchedPath = path.join(tmpLive, "zcode-patched.cjs");
    fs.writeFileSync(patchedPath, livePatched);
    const liveChk = nodeCheck(patchedPath);
    const patchedSha = sha256(livePatched);
    ck.ok("Q12-02 live apply: post-checks green + node --check pass + patched sha equals the registered registration dry-run sha",
      liveChecks && liveChk.status === 0 && patchedSha === manifest.patched_sha256_registered,
      { bytes: livePatched.length, check: liveChk.status, patchedSha });
    const { buf: liveRestored } = reverseAll(actions, livePatched);
    ck.ok("Q12-02 live reverse: sha256 byte-exact restore to the pinned base",
      sha256(liveRestored) === manifest.base.sha256);
  } else {
    ck.ok(`Q12-02 live apply/reverse [SKIP: ${liveSkip}; fixture legs carry the mechanical coverage]`, true);
  }
} finally {
  T.cleanup();
}

const { pass, fail } = ck.summary();
process.exit(fail ? 1 : 0);
