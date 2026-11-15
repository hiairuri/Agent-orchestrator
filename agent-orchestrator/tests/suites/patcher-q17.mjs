// @module patcher-q17
/*!
 * suites/patcher-q17.mjs —— Q-17 patcher 资产面四腿（v1.7.1 Q-17 W1 施工波资产，q17w1；
 *   改写自 patcher-q12.mjs〔v1.7.0 W3a 注册波，mission m-20261109-093749-195d〕——v1 台账面
 *   退役至 actions-v1-superseded.json，本套件锁 v2 注册面 + v1 存档链 + 插件面新腿）
 *
 * 权威面：patches/orch-meta-user/{actions.json,actions-v1-superseded.json,manifest.json,
 *   base-snapshot.md} + commands/orch-meta-user-patch.md（授权门指令）；设计基座=
 *   designs/q17-memory-hook/design-r2.md（§5 组装规格/§7.1 span 表/§12 grill#1 裁定：
 *   标记=\u0000OHM: 字符串前缀/帽 16384/槽粘滞/SessionStart 不走钩子）。
 *
 * 覆盖断言组：
 *   Q17-01 锚签名唯一性腿（资产形状+合成夹具 dry-run+底本 bundle dry-run〔SKIP 容错：底本
 *     不可达=异机；sha 漂移=重打流信号〕——V0/S1/S2 锚 expect_count=1 对拍+命名空间预缺席；
 *     活体 v1 态〔a936cd0e〕腿=S1 锚在/S2 锚不在=装机顺序纪律信号；活体 v2 态〔dryrun sha〕
 *     腿=双 payload 在场=已装机幂等态）
 *   Q17-02 补丁幂等/反向腿（v2 apply→node --check→幂等重 apply no-op→reverse→sha256 字节级
 *     复原；夹具腿恒跑；底本腿〔2f753c85 快照〕加锁：span 台账对拍+patched sha==dryrun 登记+
 *     v1 存档台账链〔apply v1→a936cd0e→reverse→base→apply v2→dryrun sha=阶段 B 全链机械预演〕）
 *   Q17-03 三态行为腿（S1 截收+封堵/无前缀透传+粘滞+事件门；S2 挂载/帽 16384 截断标记/空白
 *     fail-soft；journal.mjs 回显面黑盒〔缺席/变更/未变更/重写/超帽/Stop/--mirror off 独立/stamp〕；
 *     session-start.mjs G6 门〔子代理形/托管 worker/主控形三态〕；标记 twin 钉）
 *   Q17-04 授权指令存在性钉（commands/orch-meta-user-patch.md 在册+frontmatter+授权门句+双门+
 *     装机第 0 步+回滚段+重打流 字面钉；资产四件在册对拍；hooks.json description 记忆回显钉；
 *     trio 1.7.1 三点钉；N3 CJK/MH-02 版本标记自合规；CRLF 双行尾自测腿〔l-20261109-81f336〕）
 *
 * 口径：本波零宿主装机（底本/活体腿只读；写面只落 %TEMP% 临时根）；引擎语义=搜索式定位
 *   （锚 count==1→splice；payload 在场=已应用 no-op），reverse=payload→anchor 换回（锚字面即
 *   原字节）。span 单位=utf8 解码串的 string-index（引擎语义，与 revision-1 台账同单位）。
 *
 * 运行方式：node tests/suites/patcher-q17.mjs [--root <临时根父目录>]
 *   底本目标解析（逐候选读 sha 分类）：env ORCH_Q17_BASE > 主仓快照
 *   <PLUGIN_DIR>/../../../../../../.zcode/orchestrator/patches/notirc-w3/zcode.cjs.n4 >
 *   活体 C:/Program Files/ZCode/resources/glm/zcode.cjs；==base.sha256→底本腿全跑；
 *   ==a936cd0e→活体 v1 态腿；==patched_sha256_dryrun→活体 v2 态腿；其他/缺席→[SKIP] 容错
 *   （夹具腿不受影响）。
 * 前置：node >= 20；无网。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { PLUGIN_DIR, Checker } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot } from "../harness/temp-root.mjs";

const ck = new Checker("patcher-q17");
const ASSETS = path.join(PLUGIN_DIR, "patches", "orch-meta-user");
const countOf = (text, needle) => {
  let n = 0, i = 0;
  while ((i = text.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
};
const sha256 = (s) => crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

/* ---------------- assets ---------------- */
let actions = null;
let v1Archive = null;
let manifest = null;
let cmdSrc = "";
let baseSnapshot = "";
let hooksJson = null;
let pluginJson = null;
let marketplaceJson = null;
let serverCoreSrc = "";
let journalSrc = "";
try { actions = JSON.parse(fs.readFileSync(path.join(ASSETS, "actions.json"), "utf8")); } catch { /* 落红于 Q17-04 */ }
try { v1Archive = JSON.parse(fs.readFileSync(path.join(ASSETS, "actions-v1-superseded.json"), "utf8")); } catch { /* 落红于 Q17-04 */ }
try { manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, "manifest.json"), "utf8")); } catch { /* 落红于 Q17-04 */ }
try { cmdSrc = fs.readFileSync(path.join(PLUGIN_DIR, "commands", "orch-meta-user-patch.md"), "utf8"); } catch { /* 落红于 Q17-04 */ }
try { baseSnapshot = fs.readFileSync(path.join(ASSETS, "base-snapshot.md"), "utf8"); } catch { /* 落红于 Q17-04 */ }
try { hooksJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "hooks", "hooks.json"), "utf8")); } catch { /* 落红于 Q17-04 */ }
try { pluginJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, ".zcode-plugin", "plugin.json"), "utf8")); } catch { /* 落红于 Q17-04 */ }
try { marketplaceJson = JSON.parse(fs.readFileSync(path.resolve(PLUGIN_DIR, "..", "marketplace.json"), "utf8")); } catch { /* 落红于 Q17-04 */ }
try { serverCoreSrc = fs.readFileSync(path.join(PLUGIN_DIR, "mcp", "server-core.mjs"), "utf8"); } catch { /* 落红于 Q17-04 */ }
try { journalSrc = fs.readFileSync(path.join(PLUGIN_DIR, "hooks", "journal.mjs"), "utf8"); } catch { /* 落红于 Q17-04 */ }

const A = actions ? Object.fromEntries(actions.map((a) => [a.id, a])) : null;
const BYTE_IDS = actions ? actions.filter((a) => a.apply && a.apply.kind !== "verify-only").map((a) => a.id) : [];
const NAMESPACE_IDS = ["__OHM", "orch_hook_memory", "Hook Memory"];
const MARK_SRC = "\\u0000OHM:"; // 源面转义形（10 字符；运行时=NUL+OHM: 5 字符）
const MARK_RUNTIME = "\u0000OHM:";

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

/* ---------------- shared post-checks (fixture and base-patched buffers alike) ---------------- */
const POST_CHECKS = [
  ["count of 'globalThis.__OHM' == 4 (capture x2 + mount x2)", (t) => countOf(t, "globalThis.__OHM") === 4],
  ["count of the escaped mark literal == 1", (t) => countOf(t, MARK_SRC) === 1],
  ["count of 'i.additionalContexts=_r' == 1", (t) => countOf(t, "i.additionalContexts=_r") === 1],
  ["count of '\"Hook Memory\"' == 1", (t) => countOf(t, '"Hook Memory"') === 1],
  ["count of 'source:\"orch_hook_memory\"' == 1", (t) => countOf(t, 'source:"orch_hook_memory"') === 1],
  ["count of '__OHM.UserPromptSubmit' == 1 (mount read face; the capture setter spells ).UserPromptSubmit)", (t) => countOf(t, "__OHM.UserPromptSubmit") === 1],
  ["count of '_j.length>16384' == 1 (grill G4 cap)", (t) => countOf(t, "_j.length>16384") === 1],
  ["count of 'orch_hook_memory' == 1 (namespace total)", (t) => countOf(t, "orch_hook_memory") === 1],
];

/* ---------------- synthetic fixture (all anchors embedded verbatim, valid script pre- and post-patch) ---------------- */
function makeFixtureText() {
  const L = (id) => A[id].anchor.literal;
  return [
    "var logAllowedToolCall;",
    "const ef=(s)=>Math.ceil(String(s).length/4);",
    'const M9o={join:(...p)=>p.join("/")};',
    "var Nxt=()=>null;",
    "A3a=new Set([\"env_info\",\"model\",\"current_date\"]);",
    "function KDn(e){let t=e.filter(a=>a." + L("q17-V0") + ");return t.length?{source:'context_prefix',content:t.join('\\n\\n')}:null}",
    "function fce(d){return null}",
    "function run(t,n={}){let i={additionalContexts:[]};for(let _h of n.hooks){{i.additionalContexts.push(_h.out)" + L("q17-S1") + ";",
    "function makeBuilder(n,memroot,opts){return{config:{...opts,memoryRoot:memroot},build(){let t=[];" + L("q17-S2") + "let _=fce(this.config.currentDate);_&&t.push(_);return{sections:t,metaUser:KDn(t)}}}}",
    "",
  ].join("\n");
}

/* ================================ Q17-04 assets + authorization command + plugin-face pins (cheap legs first) ================================ */
ck.ok("Q17-04 patches/orch-meta-user/actions.json parses, 3 actions, ids unique, 2 byte actions + 1 verify-only",
  !!actions && actions.length === 3 && new Set(actions.map((a) => a.id)).size === 3 && BYTE_IDS.length === 2,
  { got: actions ? actions.length : null });
ck.ok("Q17-04 every byte action: payload non-empty, payload != anchor, expect_count=1, replace span recorded, base sha pinned",
  !!actions && BYTE_IDS.every((id) => {
    const a = A[id];
    return a.apply.payload && a.apply.payload !== a.anchor.literal && a.anchor.expect_count === 1
      && a.apply.kind === "replace" && Array.isArray(a.span) && a.span.length === 2
      && Number.isFinite(a.span[0]) && a.span[1] === a.span[0] + a.anchor.literal.length
      && a.base_file_sha256 === manifest?.base?.sha256;
  }));
ck.ok("Q17-04 manifest revision 2: registered, 2 patch_spans (q17-S1/S2 in apply order), verify_only=[q17-V0], empty install backfill slot + 64-hex dryrun sha, supersedes block",
  !!manifest && manifest.status === "registered" && manifest.schema_revision === 2
    && manifest.patch_spans.length === 2
    && manifest.patch_spans.map((s) => s.id).join(",") === "q17-S1,q17-S2"
    && JSON.stringify(manifest.verify_only) === JSON.stringify(["q17-V0"])
    && manifest.patched_sha256_registered === ""
    && /^[0-9a-f]{64}$/.test(manifest.patched_sha256_dryrun || "")
    && manifest.supersedes?.actions_archive === "actions-v1-superseded.json"
    && /^[0-9a-f]{64}$/.test(manifest.supersedes?.patched_sha256_registered || "")
    && !!manifest.rollback?.procedure && !!manifest.install_order,
  { status: manifest?.status, rev: manifest?.schema_revision, spans: manifest?.patch_spans?.length });
ck.ok("Q17-04 manifest rollback contract carries the v2 reverse shape (two-span reverse to the base pin + v1 archive replay path)",
  !!manifest && manifest.rollback.procedure.includes("reverse")
    && manifest.rollback.post_rollback_verify.includes("count of '__OHM' == 0")
    && manifest.install_order.includes("reverse v1"));
ck.ok("Q17-04 actions-v1-superseded.json archive: 8 entries q12-m0..m7 (7 byte + 1 verify), retired registry intact",
  !!v1Archive && v1Archive.length === 8
    && v1Archive.map((a) => a.id).join(",") === "q12-m0,q12-m1,q12-m2,q12-m3,q12-m4,q12-m5,q12-m6,q12-m7"
    && v1Archive.filter((a) => a.apply.kind !== "verify-only").length === 7,
  { got: v1Archive ? v1Archive.length : null });
ck.ok("Q17-04 base-snapshot.md on file: base sha pin + zero-host-install statement + v2 reuse section",
  baseSnapshot.includes(manifest?.base?.sha256 || "\u0000") && baseSnapshot.includes("Zero host install in this wave")
    && baseSnapshot.includes("## v2 reuse (Q-17"));
ck.ok("Q17-04 commands/orch-meta-user-patch.md on file non-empty with frontmatter name pin",
  cmdSrc.trim().length > 0 && /^---\r?\n[\s\S]*?\r?\n---/.test(cmdSrc) && cmdSrc.includes("name: orch-meta-user-patch"));
ck.ok("Q17-04 authorization gate sentence pin (issuing the command = explicit user authorization)",
  cmdSrc.includes("Issuing this command IS the explicit user authorization"));
ck.ok("Q17-04 double-gate pin (patcher QA legs renamed to Q17 + never patch in place)",
  cmdSrc.includes("(Q17-01..04 legs) must already have passed") && cmdSrc.includes("never patch in place"));
ck.ok("Q17-04 install pipeline pin (step-0 v1 reverse + temp-copy verify-before-install + never write the live path directly)",
  cmdSrc.includes("verify-before-install") && cmdSrc.includes("Never write the live path directly")
    && cmdSrc.includes("v1 reverse"));
ck.ok("Q17-04 canary pin (orch-meta-user: v1 marker = the brief data face, unchanged) present for the live probe face",
  cmdSrc.includes("orch-meta-user: v1"));
ck.ok("Q17-04 rollback section + re-pin flow pin",
  cmdSrc.includes("## 4. Rollback (one-shot reverse)") && cmdSrc.includes("Re-pin = re-measure every anchor"));
ck.ok("Q17-04 command self-compliance: zero CJK lines (N3 class-4 face) and zero vN.<digit> version markers (MH-02 class-4 face)",
  !/[\u4e00-\u9fff]/.test(cmdSrc) && !/v\d\.\d/.test(cmdSrc));
ck.ok("Q17-04 hooks.json description carries the hook-memory echo delta (design §6.1)",
  String(hooksJson?.description || "").includes("hook-memory echo") && String(hooksJson?.description || "").includes("UserPromptSubmit"));
ck.ok("Q17-04 trio 1.7.1 pins (plugin.json == SERVER_VERSION == marketplace.json, Q-17 release version)",
  pluginJson?.version === "1.7.1" && marketplaceJson?.plugins?.some((p) => p.name === "agent-orchestrator" && p.version === "1.7.1")
    && /const\s+SERVER_VERSION\s*=\s*"1\.7\.1"/.test(serverCoreSrc));

/* ---- CRLF dual line-ending self-test (l-20261109-81f336: every external-file regex pin must hold on the CRLF variant) ---- */
{
  const cmdCrlf = cmdSrc.replace(/\r?\n/g, "\r\n");
  const snapCrlf = baseSnapshot.replace(/\r?\n/g, "\r\n");
  ck.ok("Q17-04 CRLF self-test: frontmatter regex + all includes pins hold on the CRLF twin of the command and snapshot faces",
    /^---\r?\n[\s\S]*?\r?\n---/.test(cmdCrlf) && cmdCrlf.includes("name: orch-meta-user-patch")
      && cmdCrlf.includes("Issuing this command IS the explicit user authorization")
      && cmdCrlf.includes("## 4. Rollback (one-shot reverse)")
      && snapCrlf.includes("## v2 reuse (Q-17") && snapCrlf.includes("Zero host install in this wave"),
    { cmdEol: cmdSrc.includes("\r\n") ? "already-CRLF" : "LF" });
}

/* ---- mark twin pin (design §6.2: the mark literal lives in journal.mjs and the S1 payload, source-plane escaped both) ---- */
ck.ok("Q17-03 mark twin: journal.mjs HOOK_MEM_MARK literal === the S1 payload mark (escaped source form, no raw control bytes)",
  journalSrc.includes('HOOK_MEM_MARK = "' + MARK_SRC + '"')
    && (A ? A["q17-S1"].apply.payload.includes('_p="' + MARK_SRC + '"') : false)
    && !journalSrc.includes(MARK_RUNTIME));

/* ================================ Q17-01 anchor uniqueness ================================ */
ck.ok("Q17-01 fixture shape: all 4 anchor literals (V0 primary+secondary, S1, S2) embedded exactly once pre-patch, payloads and namespace absent",
  (() => {
    try {
      const fx = makeFixtureText();
      const anchors = [A["q17-V0"].anchor.literal, A["q17-V0"].secondary_anchor.literal,
        ...BYTE_IDS.map((id) => A[id].anchor.literal)];
      if (!anchors.every((lit) => countOf(fx, lit) === 1)) return false;
      if (BYTE_IDS.some((id) => countOf(fx, A[id].apply.payload) !== 0)) return false;
      return NAMESPACE_IDS.every((id) => countOf(fx, id) === 0);
    } catch { return false; }
  })());

let candidate = null; // { text, kind: "base" | "v1-live" | "v2-live" | null, note }
{
  const cands = [];
  if (process.env.ORCH_Q17_BASE) cands.push(process.env.ORCH_Q17_BASE);
  cands.push(path.resolve(PLUGIN_DIR, "..", "..", ".zcode", "orchestrator", "patches", "notirc-w3", "zcode.cjs.n4")); // main-repo dev layout
  cands.push(path.resolve(PLUGIN_DIR, "..", "..", "..", "..", "..", "..", ".zcode", "orchestrator", "patches", "notirc-w3", "zcode.cjs.n4")); // sandbox worktree layout
  cands.push("C:/Program Files/ZCode/resources/glm/zcode.cjs");
  const note = [];
  for (const c of cands) {
    try {
      const t = fs.readFileSync(c, "utf8");
      const sha = sha256(t);
      if (sha === manifest?.base?.sha256) { candidate = { text: t, kind: "base", note: c }; break; }
      if (sha === manifest?.supersedes?.patched_sha256_registered) { candidate = { text: t, kind: "v1-live", note: c }; break; }
      if (sha === manifest?.patched_sha256_dryrun) { candidate = { text: t, kind: "v2-live", note: c }; break; }
      note.push(`sha drift (re-pin flow signal): ${c}`);
    } catch { /* next candidate */ }
  }
  if (!candidate) candidate = { text: null, kind: null, note: note.length ? note.join("; ") : "no reachable bundle on this machine" };
}

if (candidate.kind === "base") {
  const anchorOk = [A["q17-V0"].anchor.literal, A["q17-V0"].secondary_anchor.literal,
    ...BYTE_IDS.map((id) => A[id].anchor.literal)].every((lit) => countOf(candidate.text, lit) === 1);
  const absenceOk = NAMESPACE_IDS.every((id) => countOf(candidate.text, id) === 0);
  ck.ok("Q17-01 base-bundle dry-run (pinned 2f753c85 snapshot): all 4 anchor literals count==1 + namespace pre-absent 0/0/0 (expect_count=1)",
    anchorOk && absenceOk, { bytes: candidate.text.length });
} else if (candidate.kind === "v1-live") {
  const s1 = countOf(candidate.text, A["q17-S1"].anchor.literal);
  const s2 = countOf(candidate.text, A["q17-S2"].anchor.literal);
  const v0 = countOf(candidate.text, A["q17-V0"].anchor.literal);
  const ns = NAMESPACE_IDS.every((id) => countOf(candidate.text, id) === 0);
  ck.ok("Q17-01 v1-live dry-run (a936cd0e host): S1 anchor count==1, S2 anchor count==0 (consumed by q12-m6 = install-order discipline signal: reverse v1 first), V0 anchors intact, v2 namespace absent",
    s1 === 1 && s2 === 0 && v0 === 1 && ns, { s1, s2, v0 });
} else if (candidate.kind === "v2-live") {
  const p1 = countOf(candidate.text, A["q17-S1"].apply.payload);
  const p2 = countOf(candidate.text, A["q17-S2"].apply.payload);
  ck.ok("Q17-01 v2-live dry-run (installed state): both payloads present exactly once (already-applied idempotent state)",
    p1 === 1 && p2 === 1, { p1, p2 });
} else {
  ck.ok(`Q17-01 base-bundle dry-run [SKIP: ${candidate.note}; fixture legs carry the mechanical coverage]`, true);
}

/* ================================ Q17-02 apply/reverse idempotency + ledger chain + Q17-03 behavioral legs ================================ */
const T = makeTempRoot({ prefix: "orch-q17-" });
try {
  /* ---- fixture legs (always run) ---- */
  const base = makeFixtureText();
  const baseSha = sha256(base);
  const { buf: patched, applied } = applyAll(actions, base);
  ck.ok("Q17-02 fixture apply: 8 post-checks green on the patched buffer",
    POST_CHECKS.every(([, fn]) => fn(patched)), { failed: POST_CHECKS.filter(([, fn]) => !fn(patched)).map(([n]) => n) });
  const fixCjs = path.join(T.root, "fixture.cjs");
  fs.writeFileSync(fixCjs, patched);
  const chk = nodeCheck(fixCjs);
  ck.ok("Q17-02 fixture apply: node --check passes on the patched script", chk.status === 0,
    chk.stderr ? chk.stderr.slice(0, 200) : undefined);
  const { buf: reapplied } = applyAll(actions, patched);
  ck.ok("Q17-02 fixture idempotent re-apply: no-op (buffer identical)", reapplied === patched);
  const { buf: restored } = reverseAll(actions, patched);
  ck.ok("Q17-02 fixture reverse: sha256 byte-exact restore + anchors back + payload zero-residue",
    sha256(restored) === baseSha
      && BYTE_IDS.every((id) => countOf(restored, A[id].anchor.literal) === 1)
      && BYTE_IDS.every((id) => countOf(restored, A[id].apply.payload) === 0)
      && NAMESPACE_IDS.every((id) => countOf(restored, id) === 0));

  /* ---- base-snapshot legs (SKIP-tolerated when the pinned snapshot is unreachable) ---- */
  if (candidate.kind === "base") {
    const baseText = candidate.text;
    const { buf: basePatched, applied: baseApplied } = applyAll(actions, baseText);
    const baseChecks = POST_CHECKS.every(([, fn]) => fn(basePatched));
    const spansOk = baseApplied.every((x) => {
      const rec = A[x.id];
      return Array.isArray(rec.span) && rec.span[0] === x.span[0] && rec.span[1] === x.span[1];
    });
    const patchedPath = path.join(T.root, "base-patched.cjs");
    fs.writeFileSync(patchedPath, basePatched);
    const baseChk = nodeCheck(patchedPath);
    const patchedSha = sha256(basePatched);
    ck.ok("Q17-02 base apply: post-checks + node --check + patched sha == patched_sha256_dryrun + recorded spans == engine-measured spans (registration ledger)",
      baseChecks && baseChk.status === 0 && patchedSha === manifest.patched_sha256_dryrun && spansOk,
      { bytes: basePatched.length, check: baseChk.status, patchedSha, spansOk });
    const { buf: baseRestored } = reverseAll(actions, basePatched);
    ck.ok("Q17-02 base reverse: sha256 byte-exact restore to the pinned base",
      sha256(baseRestored) === manifest.base.sha256);
    /* v1 archive ledger chain = stage-B full pre-run: reverse v1 from the v1 state -> base -> apply v2 -> dryrun sha */
    const v1Patched = applyAll(v1Archive, baseText).buf;
    const v1ShaOk = sha256(v1Patched) === manifest.supersedes.patched_sha256_registered;
    const v1Back = reverseAll(v1Archive, v1Patched).buf;
    const backOk = sha256(v1Back) === manifest.base.sha256;
    const chainPatched = applyAll(actions, v1Back).buf;
    ck.ok("Q17-02 v1 archive ledger chain (stage-B pre-run): apply v1 on base -> a936cd0e registered sha; reverse -> base; apply v2 -> dryrun sha (byte accounts close end to end)",
      v1ShaOk && backOk && sha256(chainPatched) === manifest.patched_sha256_dryrun,
      { v1ShaOk, backOk });
  } else {
    ck.ok(`Q17-02 base apply/reverse + v1 ledger chain [SKIP: ${candidate.note}; fixture legs carry the mechanical coverage]`, true);
  }

  /* ---- Q17-03 leg A: S1 capture/block/passthrough three states (payload extracted from the assets) ---- */
  {
    const runner = new Function(
      "var logAllowedToolCall;function f(t,i){for(let _q=0;_q<0;_q++){{" +
      A["q17-S1"].apply.payload + ";return f;")();
    try {
      const i1 = { additionalContexts: [MARK_RUNTIME + "alpha", "plain", MARK_RUNTIME + "beta", MARK_RUNTIME + "", 42] };
      const r1 = runner({ hookEventName: "UserPromptSubmit" }, i1);
      ck.ok("Q17-03 S1 three states: marked strings captured (prefix stripped, empty dropped) + blocked downstream (unmarked/non-string pass through verbatim)",
        r1 === i1
          && JSON.stringify(i1.additionalContexts) === JSON.stringify(["plain", 42])
          && JSON.stringify(globalThis.__OHM?.UserPromptSubmit) === JSON.stringify(["alpha", "beta"]));
      const i2 = { additionalContexts: ["x"] };
      runner({ hookEventName: "UserPromptSubmit" }, i2);
      ck.ok("Q17-03 S1 sticky slot (grill G2): an unmarked run leaves the slot untouched (memory stays resident)",
        JSON.stringify(globalThis.__OHM?.UserPromptSubmit) === JSON.stringify(["alpha", "beta"])
          && JSON.stringify(i2.additionalContexts) === JSON.stringify(["x"]));
      const i3 = { additionalContexts: [MARK_RUNTIME + "z"] };
      runner({ hookEventName: "Stop" }, i3);
      ck.ok("Q17-03 S1 event gate (grill G3): non-UserPromptSubmit events are untouched (pass-through intact, slot not fed)",
        i3.additionalContexts.length === 1 && i3.additionalContexts[0] === MARK_RUNTIME + "z"
          && JSON.stringify(globalThis.__OHM?.UserPromptSubmit) === JSON.stringify(["alpha", "beta"]));
    } finally {
      delete globalThis.__OHM;
    }
  }

  /* ---- Q17-03 leg B: S2 mount states (cap 16384 truncation + fail-soft) ---- */
  {
    const build = new Function(
      "var Nxt=()=>null;var ef=(s)=>Math.ceil(String(s).length/4);return function(t){" +
      A["q17-S2"].anchor.literal + A["q17-S2"].apply.payload.slice(A["q17-S2"].anchor.literal.length) + "};")();
    const run1 = () => { const t = []; build.call({ config: {} }, t); return t; };
    try {
      ck.ok("Q17-03 S2 fail-soft: no slot / empty array / whitespace-only -> no section pushed",
        run1().length === 0);
      globalThis.__OHM = { UserPromptSubmit: [] };
      ck.ok("Q17-03 S2 fail-soft (empty slot array)", run1().length === 0);
      globalThis.__OHM = { UserPromptSubmit: ["  \n  "] };
      ck.ok("Q17-03 S2 fail-soft (whitespace-only content)", run1().length === 0);
      globalThis.__OHM = { UserPromptSubmit: ["line1", "line2"] };
      const t1 = run1();
      const s1 = t1[0] || {};
      const joined = "line1\n\nline2";
      ck.ok("Q17-03 S2 mount: eight-field section mirrors Nxt (name/source/injectionTarget/cacheHint/chars/tokens/preview) and joins with a blank line",
        t1.length === 1 && s1.name === "Hook Memory" && s1.source === "orch_hook_memory"
          && s1.injectionTarget === "meta_user" && s1.cacheHint === "dynamic"
          && s1.content === joined && s1.chars === joined.length
          && s1.tokens === Math.ceil(joined.length / 4) && s1.preview === joined.slice(0, 100));
      const big = "x".repeat(16394);
      globalThis.__OHM = { UserPromptSubmit: [big] };
      const t2 = run1();
      const s2 = t2[0] || {};
      ck.ok("Q17-03 S2 cap 16384 (grill G4 lenient tier): over-cap joins truncate to exactly 16384 with the '…[hook memory truncated]' 24-char tail (cut point 16360)",
        t2.length === 1 && s2.content?.length === 16384 && s2.chars === 16384
          && s2.content.endsWith("[hook memory truncated]")
          && s2.content.charCodeAt(16384 - 24) === 0x2026);
    } finally {
      delete globalThis.__OHM;
    }
  }

  /* ---- Q17-03 leg C: journal.mjs echo face (black-box, temp storage root) ---- */
  {
    const proj = path.join(T.root, "g6-proj");
    const rootDir = path.join(proj, ".zcode", "orchestrator");
    fs.mkdirSync(path.join(rootDir, "context"), { recursive: true });
    const brief = path.join(rootDir, "context", "meta-user-brief.md");
    const stamp = path.join(rootDir, "context", ".brief-echo-stamp");
    const runJ = (args, input) => {
      const env = { ...process.env, ZCODE_PROJECT_DIR: proj };
      delete env.ORCH_MANAGED_WORKER;
      const r = spawnSync(process.execPath, [path.join(PLUGIN_DIR, "hooks", "journal.mjs"), ...args], {
        input: JSON.stringify(input), encoding: "utf8", cwd: T.root, env, timeout: 30000,
      });
      return { status: r.status, out: r.stdout };
    };
    const ev = { hook_event_name: "UserPromptSubmit", session_id: "q17j", prompt: "p" };
    const a = runJ([], ev);
    ck.ok("Q17-03 journal echo absent brief: stdout empty, exit 0 (current contract preserved)",
      a.status === 0 && a.out === "");
    fs.writeFileSync(brief, "orch-meta-user: v1\ncanary line A");
    const b = runJ([], ev);
    let parsed = null;
    try { parsed = JSON.parse(b.out); } catch { /* leave null */ }
    ck.ok("Q17-03 journal echo changed brief: single-line strict JSON, additionalContext = mark + full content (runtime mark = NUL + 'OHM:')",
      b.status === 0 && parsed && parsed.additionalContext
        && parsed.additionalContext.charCodeAt(0) === 0 && parsed.additionalContext.slice(1, 5) === "OHM:"
        && parsed.additionalContext.endsWith("canary line A")
        && b.out.split("\n").filter(Boolean).length === 1);
    ck.ok("Q17-03 journal echo stamp written (mtime string)", /^\d+(\.\d+)?\s*$/.test(fs.readFileSync(stamp, "utf8")));
    const c = runJ([], ev);
    ck.ok("Q17-03 journal echo unchanged brief: stdout empty (mtime gate, zero context cost)",
      c.status === 0 && c.out === "");
    fs.writeFileSync(brief, "orch-meta-user: v1\ncanary line B");
    const d = runJ([], ev);
    ck.ok("Q17-03 journal echo rewritten brief: re-echo carries the new content (one-message shape)",
      d.out.includes("canary line B") && !d.out.includes("canary line A"));
    fs.writeFileSync(brief, "x".repeat(20000));
    const e = runJ([], ev);
    let pe = null;
    try { pe = JSON.parse(e.out); } catch { /* leave null */ }
    ck.ok("Q17-03 journal echo over-cap: content truncated at 16384 (read-face cap = mount cap, grill G4)",
      pe && pe.additionalContext.length === 5 + 16384);
    const f = runJ([], { hook_event_name: "Stop", session_id: "q17j", last_assistant_message: "m" });
    ck.ok("Q17-03 journal echo event gate: Stop stays silent (echo is UserPromptSubmit-only, grill G3)",
      f.status === 0 && f.out === "");
    fs.writeFileSync(brief, "orch-meta-user: v1\nmirror-off line");
    const bump = new Date(Date.now() + 5000); // deterministic mtime change (same-ms write race guard)
    fs.utimesSync(brief, bump, bump);
    const g = runJ(["--mirror", "off"], { hook_event_name: "UserPromptSubmit", session_id: "q17m", prompt: "p" });
    ck.ok("Q17-03 journal echo independent of --mirror: mirror off stops the disk mirror only (fresh sid -> no journal file), the memory echo still fires",
      g.out.includes("mirror-off line")
        && !fs.existsSync(path.join(rootDir, "context", "journal-q17m.jsonl")));
  }

  /* ---- Q17-03 leg D: session-start.mjs G6 gate (black-box, grill G6) ---- */
  {
    const proj = path.join(T.root, "ss-proj");
    const rootDir = path.join(proj, ".zcode", "orchestrator");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "board.json"), JSON.stringify({
      version: 2, updated_at: new Date().toISOString(),
      missions: [{ id: "m-run", title: "running-mission", status: "running", original_prompt: "p", dispatch: {} }],
    }));
    const runS = (envExtra, sessionId) => {
      const env = { ...process.env, ZCODE_PROJECT_DIR: proj, ...envExtra };
      if (!envExtra || !("ORCH_MANAGED_WORKER" in envExtra)) delete env.ORCH_MANAGED_WORKER;
      const r = spawnSync(process.execPath, [path.join(PLUGIN_DIR, "hooks", "session-start.mjs")], {
        input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId }),
        encoding: "utf8", cwd: T.root, env, timeout: 30000,
      });
      return { status: r.status, out: r.stdout };
    };
    const g1 = runS({}, "sess_subagent_agent_583ee58a-4b51-46b0-9120-2177449d22a0");
    ck.ok("Q17-03 G6 gate subagent shape: sess_subagent* id -> no additionalContext briefing (exit 0, stdout empty)",
      g1.status === 0 && g1.out.trim() === "");
    const g2 = runS({ ORCH_MANAGED_WORKER: "m-x" }, "sess_0f1e2d3c-4b5a-4697-8c9d-0a1b2c3d4e5f");
    ck.ok("Q17-03 G6 gate managed worker: ORCH_MANAGED_WORKER env -> no briefing",
      g2.status === 0 && g2.out.trim() === "");
    const g3 = runS({}, "sess_0f1e2d3c-4b5a-4697-8c9d-0a1b2c3d4e5f");
    ck.ok("Q17-03 G6 gate coordinator shape: sess_<uuid> without the worker marker still gets the resume briefing (gate does not over-block)",
      g3.status === 0 && g3.out.includes("running-mission"));
  }
} finally {
  T.cleanup();
}

const { pass, fail } = ck.summary();
process.exit(fail ? 1 : 0);
