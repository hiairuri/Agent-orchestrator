// @module dispatch-supply
/*!
 * suites/dispatch-supply.mjs —— 派发供给面（v1.2.3 W1/M1：P2 信封双通道 PE×6 ＋ miss→error 侧车链静态腿；
 *   v1.2.3 W2/M2：P3 播种面 DS×8 ＋ ST-02 静态锁；v1.2.3 W3/M3：ST-01 静态锁）
 *
 * 覆盖断言组：A-v0123-PE（PE-01..06，impl-plan.md §9 用例名清单逐字）：
 *   PE-01-singleline-channelA-hit：单行旧信封（0.16.x 形）噪声日志中命中、sessionId 提取
 *     正确（通道 A 原样保留回归；谓词 type==="result"||typeof sessionId==="string" 不动）；
 *   PE-02-multiline-650b-channelB-hit：650B 多行信封（附录 A 全文内嵌，来源标注见 F650 注）
 *     通道 B 命中且 sess_9a3adc24-… 正确；字节复核=650（对齐 QA R1/R2 wc -c 双源实测）；
 *   PE-03-noise-mixed-channelB-hit：信封前后 stderr 噪声混布仍命中。R2-08 边界声明：
 *     噪声构造显式不含行首 `{` 行——通道 B 单候选起点（尾向最后一个 `{` 开头行）对
 *     「信封后行首 `{` 噪声行」不免疫（会锁噪声行起步→优雅 miss），多候选扫描增强
 *     defer（impl-plan §8）；本用例噪声 precondition 由 leg 2 机械自检。
 *   PE-04-pure-noise-returns-null：纯噪声/无 JSON（含空串/null/undefined 退化输入）
 *     → 返 null 不抛；
 *   PE-05-truncated-graceful-miss：截断优雅 miss 双腿（头部截断掉信封头两行＋尾部截断
 *     累积不成根）→ 返 null；注释论据=R2-03 订正句：fixture 嵌套 opener（"usage": { 等）
 *     均为行尾 `{`，自其行累积不成合法 JSON 根。leg 3＝miss→error 侧车链静态腿：
 *     runner finish() miss 分支 error 侧车字面在案（"envelope unparsable (no --json
 *     result line)"）——PE-04/05 的 null 即落该分支。
 *   PE-06-production-length-hit：response ≥4000 字符生产长度多行样例命中
 *     （OPEN-4=A 定型腿；旧 4000 窗必截断、现窗富余）。
 *
 * PQA4 残余截断面声明（本套件权威注释位，plan-qa-r1.md PQA4 必吸收）：LOG_TAIL_CHARS
 *   上调 16384 后，>16384 字符信封仍被 readLogTail 窗口截断 → 优雅 miss → error 侧车
 *   兜底（设计内，非缺陷）。PE-06 定型腿钉 ≥4000 字符生产长度，不触及新窗界；tests/
 *   对 LOG_TAIL_CHARS 常量维持零钉点（impl-plan §2 验收口径：上调无断言连带，反向
 *   grep 实测 0 命中）。
 *
 * 驱动形态：PE——parseEnvelope 为纯函数，经 bodyOfText 源码抽取＋轻 eval 驱动
 *   （l0-skeleton L22-27 抽取先例＋contract-sync/sb-normalize new Function 先例同法）。
 *   fixture 以行数组 join("\n") 构造——与本文件自身行尾无关，字节确定（650 复核硬锚）。
 *   DS/ST——harness startServer 黑盒（crv6-resilience DSP-01..04 既有同法：fake
 *   personal config＋即时桩 CLI；impl-plan §3 用例形态裁定——dispatchSeedModelConfig
 *   闭包 root/atomicWriteFileSync 致抽取不可行，黑盒零新模式引入）。不-spawn 观测
 *   双锚=桩标记（ORCH_ROLLOUT_DIR model-io-<sid>.jsonl）缺席＋result/logs dir 零侧车
 *   （DSP stub 机制自选声明，plan-qa-r1 §2/§4 实锤可测）。
 *
 * v1.2.3 W2/M2 增量（P3 播种面）：DS-01..08（impl-plan §9 名清单逐字，验收①-⑧映射）
 *   ＋ST-02（「first enabled」归零静态锁=验收⑩）。播种语义=两源快速失败（显式
 *   model= / 会话真值 dms；段③首 api-key 猜测删除）：选择类拒绝回执 ok:true＋
 *   model_seed{seeded:false, reason, rejected{kind,provider_id?,detail}, guidance[2],
 *   available_apikey_providers≤3}（§12 形态：不 spawn、零侧车、board 留 drafted）；
 *   reason 双写裁定=account 腿保持 model_arg_unusable（FA-3 谓词原样绿）；
 *   no_apikey_model 随段③退役（selection_missing 接管）；非选择类（env 链/写盘/
 *   provider 不存在）boot-then-die 现行为不变、无 rejected 字段（PQA3）。
 *
 * 运行方式：node tests/suites/dispatch-supply.mjs [--root <临时根父目录>]
 *   （PE 段无 temp root、零子进程；DS 段 startServer 子进程开销=既有套件常态）
 * 断言主句权威 = tests/assertions/v1.2.3.md §1（W1/M1=PE×6；W2/M2=DS×8＋ST-02；W3/M3=ST-01）。
 * 设计权威 = designs/v1.2.3-planning/impl-plan.md §2/§3/§9/§12/附录 A ＋
 *   plan-qa-r1.md（PQA2/3/4 吸收）＋ draft.md §P3 映射表。
 */
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_DIR, DEFAULT_SERVER, Checker, startServer } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot, missionOf, parseRootArg } from "../harness/temp-root.mjs";

/** function <name>(<any params>) body — column-0 "}" closes it. LF-normalized input. */
function bodyOfText(sourceLF, fnName) {
  const start = sourceLF.indexOf(`function ${fnName}(`);
  if (start < 0) return "";
  const end = sourceLF.indexOf("\n}\n", start);
  return end < 0 ? sourceLF.slice(start) : sourceLF.slice(start, end + 3);
}

const ck = new Checker("dispatch-supply");

// ---- 源码抽取：hooks/dispatch-runner.mjs → parseEnvelope（通道 A 原样 + 通道 B 新增）
const runnerLF = fs
  .readFileSync(path.join(PLUGIN_DIR, "hooks", "dispatch-runner.mjs"), "utf8")
  .replace(/\r\n/g, "\n");
const parseEnvelope = new Function(bodyOfText(runnerLF, "parseEnvelope") + "\nreturn parseEnvelope;")();

// ---- 650B 信封 fixture（impl-plan.md 附录 A 全文物化；来源=%TEMP%\orch-trial\
//      envelope-test.log 2026-10-30 读得，QA R1 双源 wc -c=650 逐字节一致；LF 无 \r，
//      含尾随换行。行数组 join 构造=字节确定，不随本文件行尾漂移。）
const F650_LINES = [
  "{",
  '  "sessionId": "sess_9a3adc24-6028-4051-8808-fadf80c8b7f2",',
  '  "traceId": "3ed52f16-c275-438c-bb3a-b481b58074e7",',
  '  "turnId": "turn_a360bac6-962f-4abd-b62e-0ea6db97a0ff",',
  '  "response": "通过",',
  '  "usage": {',
  '    "source": "provider",',
  '    "modelRequestCount": 1,',
  '    "inputTokens": 62053,',
  '    "outputTokens": 3,',
  '    "totalTokens": 62056,',
  '    "cacheReadTokens": 62016,',
  '    "cacheWriteTokens": 0,',
  '    "reasoningTokens": 0,',
  '    "webFetchRequests": 0,',
  '    "webSearchRequests": 0',
  "  },",
  '  "eventCount": 11,',
  '  "projection": {',
  '    "status": "idle",',
  '    "turnCount": 1,',
  '    "totalTokenCount": 62056,',
  '    "contextUsed": 62056,',
  '    "contextWindow": 200000',
  "  }",
  "}",
];
const F650 = F650_LINES.join("\n") + "\n";

// ---- stderr 噪声（PE-03/PE-01 共用；显式不含行首 `{` 行——R2-08 边界声明前置条件）
const NOISE_LINES = [
  "[INFO] zcode cli boot (pid 12345)",
  "[dotenv] injecting 12 env vars",
  "[WARN] transient provider hiccup, retrying",
  "  (no action required)",
  "[INFO] exit",
];
const NOISE = NOISE_LINES.join("\n");

// ---- PE-01-singleline-channelA-hit：单行旧信封命中（通道 A 回归），sessionId 提取正确
{
  const singleLine =
    '{"sessionId":"sess_a1111111-1111-4111-8111-111111111111","traceId":"t-01",' +
    '"turnId":"turn_01","response":"ok","usage":{"totalTokens":1}}';
  const log1 = NOISE + "\n" + singleLine + "\n[INFO] exit 0\n";
  const r1 = parseEnvelope(log1);
  ck.ok(
    "PE-01 单行旧信封命中且 sessionId 提取正确（通道 A 原样保留回归）",
    !!r1 && r1.sessionId === "sess_a1111111-1111-4111-8111-111111111111",
    r1,
  );
  ck.ok(
    "PE-01 谓词不变：type/sessionId 之外字段（traceId/usage）原样承载于返回对象",
    !!r1 && r1.traceId === "t-01" && r1.usage && r1.usage.totalTokens === 1,
    r1,
  );
}

// ---- PE-02-multiline-650b-channelB-hit：650B 多行信封通道 B 命中；字节复核=650
{
  ck.ok(
    "PE-02 内嵌 fixture 字节复核=650（LF＋尾随换行，对齐 QA wc -c 双源实测）",
    Buffer.byteLength(F650, "utf8") === 650,
    Buffer.byteLength(F650, "utf8"),
  );
  const r2 = parseEnvelope(F650);
  ck.ok(
    "PE-02 650B 多行信封通道 B 命中且 sessionId=sess_9a3adc24-… 正确",
    !!r2 && r2.sessionId === "sess_9a3adc24-6028-4051-8808-fadf80c8b7f2",
    r2 && r2.sessionId,
  );
  ck.ok(
    "PE-02 嵌套对象（usage/projection）完整解析（R2-03 结构口径：opener 行尾 `{`）",
    !!r2 && r2.usage && r2.usage.totalTokens === 62056 && r2.projection && r2.projection.status === "idle",
    r2 && { usage: r2.usage, projection: r2.projection },
  );
}

// ---- PE-03-noise-mixed-channelB-hit：信封前后噪声混布仍命中；噪声显式不含行首 `{` 行
{
  const log3 = NOISE + "\n" + F650 + NOISE + "\n";
  const r3 = parseEnvelope(log3);
  ck.ok(
    "PE-03 信封前后 stderr 噪声混布仍命中（尾向单候选起点=信封首行 `{`）",
    !!r3 && r3.sessionId === "sess_9a3adc24-6028-4051-8808-fadf80c8b7f2",
    r3 && r3.sessionId,
  );
  ck.ok(
    "PE-03 R2-08 边界 precondition 机械自检：噪声行显式不含行首 `{` 行",
    NOISE_LINES.every((l) => !l.trim().startsWith("{")),
    NOISE_LINES,
  );
}

// ---- PE-04-pure-noise-returns-null：纯噪声/无 JSON → 返 null 不抛
{
  let r4;
  let threw = false;
  try {
    r4 = parseEnvelope(NOISE + "\nplain text log line\n2026-10-30 boot done\n");
  } catch {
    threw = true;
  }
  ck.ok("PE-04 纯噪声/无 JSON → 返 null 且不抛", !threw && r4 === null, { threw, r4 });
  let r4b;
  let threwB = false;
  try {
    r4b = [parseEnvelope(""), parseEnvelope(null), parseEnvelope(undefined)];
  } catch {
    threwB = true;
  }
  ck.ok("PE-04 退化输入（空串/null/undefined）→ 逐一返 null 不抛", !threwB && r4b.every((x) => x === null), {
    threw: threwB,
    r4b,
  });
}

// ---- PE-05-truncated-graceful-miss：截断优雅 miss（双腿）＋miss→error 侧车链静态腿
{
  // 头部截断（readLogTail 窗保留尾部：信封头两行被切掉）。R2-03 订正论据：fixture
  // 嵌套 opener（"usage": { 等）均为行尾 `{`，自其行累积不成合法 JSON 根 → 优雅 miss。
  const headTrunc = F650.split("\n").slice(2).join("\n");
  ck.ok("PE-05 头部截断（信封头两行被切）→ 优雅 miss 返 null", parseEnvelope(headTrunc) === null);
  // 尾部截断（累积永不闭合：起点 `{` 在场、收尾缺失）→ 通道 B 累积至窗全长仍 miss。
  const tailTrunc = F650.split("\n").slice(0, -4).join("\n") + "\n";
  ck.ok("PE-05 尾部截断（累积不成合法 JSON 根）→ 优雅 miss 返 null", parseEnvelope(tailTrunc) === null);
  // miss→error 侧车链静态腿：runner finish() miss 分支 error 侧车字面在案
  // （<result-dir>/<mission_id>-<ts>.error.json；PE-04/05 的 null 即落该分支）。
  ck.ok(
    "PE-05 miss→error 侧车链落点在案（runner error='envelope unparsable (no --json result line)'）",
    runnerLF.includes('error: "envelope unparsable (no --json result line)"'),
  );
}

// ---- PE-06-production-length-hit：response ≥4000 字符生产长度多行样例命中
//      （OPEN-4=A 定型腿；旧 4000 窗必截断、现窗富余。PQA4 残余截断面声明：
//      >16384 字符信封仍截断 → 优雅 miss → error 侧车兜底，设计内非缺陷。）
{
  const resp6 = "通过".repeat(2100); // 4200 chars ≥ 4000（生产长度定型线）
  const F6 = [
    "{",
    '  "sessionId": "sess_bbbb2222-2222-4222-8222-222222222222",',
    '  "response": "' + resp6 + '",',
    '  "usage": { "totalTokens": 62056 }',
    "}",
  ].join("\n") + "\n";
  ck.ok("PE-06 前提自检：response 长度 ≥4000（生产长度定型线，OPEN-4=A）", resp6.length >= 4000, resp6.length);
  const r6 = parseEnvelope(F6);
  ck.ok(
    "PE-06 生产长度多行信封命中且 response 原样往返（4200 字符零截损）",
    !!r6 && r6.sessionId === "sess_bbbb2222-2222-4222-8222-222222222222" && r6.response === resp6,
    r6 && r6.response ? r6.response.length : r6,
  );
}

/* ================= v1.2.3 W2/M2：P3 播种面 DS×8 ＋ ST-02（A-v0123-DS/ST） ================= */

// ---- 拒绝回执的两条固定指引（draft §P3 回执设计逐字；DS-02/04/05/07 字面断言钉）
const GUIDANCE_MODEL_ARG = '显式传 model="<providerId>/<modelId>[@level]"（api-key 型 provider）';
const GUIDANCE_ENABLE_PROVIDER = "请用户在宿主启用目标 api-key provider，使会话 defaultModelSelection 可采信";

{
  const BASE = makeTempRoot({ prefix: "orch-ds-", root: parseRootArg() || undefined });
  const dsPack = path.join(BASE.root, "pack.md");
  const dsPersona = path.join(PLUGIN_DIR, "agents", "orch-worker.md");
  try {
    fs.writeFileSync(
      dsPack,
      "# 任务包：DS 断言组\n\n## CONTRACT（三行契约）\n\n[channel] m-ds-x\n[worker] gp-ds#1\n[token] ds token placeholder\n\n## TASK\n桩 CLI 黑盒。\n",
    );
    /** 即时桩 CLI（同 crv6-resilience dspStub 形）：写 model-io 标记 + result envelope。 */
    const dsStub = (file, sessionId) =>
      fs.writeFileSync(
        file,
        [
          'import fs from "node:fs";',
          'import path from "node:path";',
          'const dir = process.env.ORCH_ROLLOUT_DIR || ".";',
          'fs.mkdirSync(dir, { recursive: true });',
          `fs.writeFileSync(path.join(dir, "model-io-${sessionId}.jsonl"), JSON.stringify({ t: 1 }) + "\\n");`,
          `console.log(JSON.stringify({ type: "result", sessionId: "${sessionId}", response: "stub-ok", usage: {} }));`,
        ].join("\n") + "\n",
      );
    const fakeBuiltinOf = (dir) => {
      const p = path.join(dir, "zcode-builtin.json");
      fs.writeFileSync(p, JSON.stringify({ schemaVersion: 1, revision: 1, config: { providerConfigRules: { templateRules: [], providerRules: [] }, modelConfigRules: {} } }, null, 2));
      return p;
    };
    const dsUpsert = (sX, id) =>
      sX.call("board", {
        action: "upsert",
        mission: { id, title: id, status: "drafted", agent_type: "agent-orchestrator:orch-worker", scope_paths: ["src/"] },
      });
    const subDir = (name) => {
      const dir = path.join(BASE.root, name);
      fs.mkdirSync(path.join(dir, "troot"), { recursive: true });
      fs.mkdirSync(path.join(dir, "rollout"), { recursive: true });
      return dir;
    };
    const rolloutOf = (dir) => path.join(dir, "rollout");
    const trootOf = (dir) => path.join(dir, "troot");
    const resultDirOf = (rt) => path.join(rt, "context", "dispatch-results");
    const logsDirOf = (rt) => path.join(rt, "context", "dispatch-logs");
    const seedFileOf = (rt, mid) => path.join(rt, "context", "dispatch-model-seed", `${mid}.json`);
    const emptyOrAbsent = (p) => !fs.existsSync(p) || fs.readdirSync(p).length === 0;
    /** 不-spawn 三锚：桩标记缺席 ∧ result dir 零侧车 ∧ dispatch-logs 零侧车（§12 零痕迹）。 */
    const noSpawnLeg = (dir, rt, sid) =>
      !fs.existsSync(path.join(rolloutOf(dir), `model-io-${sid}.jsonl`)) &&
      emptyOrAbsent(resultDirOf(rt)) &&
      emptyOrAbsent(logsDirOf(rt));
    const startDs = (dir) =>
      startServer({
        root: trootOf(dir),
        env: {
          ZCODE_CLI_PATH: path.join(dir, "stub.mjs"),
          ORCH_ROLLOUT_DIR: rolloutOf(dir),
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(dir, "provider_config.json"),
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fakeBuiltinOf(dir),
        },
      });
    const seedDmsOf = (r) => {
      try {
        return JSON.parse(fs.readFileSync(r.model_seed.config_path, "utf8")).config.defaultModelSelection;
      } catch {
        return undefined;
      }
    };

    // ---- DS-01-explicit-apikey-seeded-true（验收①）：显式 api-key model= → seeded:true 回归
    //      ＋@level 在值域 → 无 level_warning 子腿
    {
      const dir = subDir("ds01");
      const sid = "sess_ds01";
      dsStub(path.join(dir, "stub.mjs"), sid);
      fs.writeFileSync(
        path.join(dir, "provider_config.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            config: {
              providerConfigRules: {
                providerRules: [
                  { providerId: "p-a", config: { access: { type: "api-key", apiKey: "sk-a" }, modelOrder: ["M-A"] } },
                ],
              },
              modelConfigRules: {
                providerModelRules: [
                  { modelId: "M-A", config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["fast", "slow"] } } }, providerId: "p-a" },
                ],
              },
            },
          },
          null,
          2,
        ),
      );
      const sX = startDs(dir);
      try {
        await dsUpsert(sX, "m-ds01");
        const r = JSON.parse((await sX.call("dispatch", { mission_id: "m-ds01", pack_path: dsPack, persona_path: dsPersona, model: "p-a/M-A@fast" })).text);
        ck.ok(
          "DS-01 显式 api-key model= → seeded:true 回归（验收①）：provider/model/level=显式值、session 捕获",
          r.ok === true && r.session_id === sid && r.model_seed && r.model_seed.seeded === true &&
            r.model_seed.provider_id === "p-a" && r.model_seed.model_id === "M-A" &&
            r.model_seed.reasoning_level === "fast",
          { model_seed: r.model_seed, session_id: r.session_id },
        );
        ck.ok(
          "DS-01 @level 在值域 → 无 level_warning 子腿（提示面仅 ∉ 值域时附）",
          r.model_seed.level_warning === undefined,
          r.model_seed.level_warning,
        );
        ck.ok(
          "DS-01 种子 defaultModelSelection=显式选型（覆写随显式选型，DSP-04 同语义回归）",
          JSON.stringify(seedDmsOf(r)) === JSON.stringify({ providerId: "p-a", modelId: "M-A", options: { reasoningLevel: "fast" } }),
          seedDmsOf(r),
        );
      } finally {
        sX.close();
      }
    }

    // ---- DS-02-explicit-account-rejected-guidance（验收②＋OPEN-1=B）：显式 model= 指
    //      zhipu-account（access.type 识别）→ 快速失败回执三件＋不 spawn＋种子不落＋留 drafted
    {
      const dir = subDir("ds02");
      const sid = "sess_ds02";
      dsStub(path.join(dir, "stub.mjs"), sid);
      const rt = trootOf(dir);
      fs.writeFileSync(
        path.join(dir, "provider_config.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            config: {
              providerConfigRules: {
                providerRules: [
                  ...["p-k1", "p-k2", "p-k3", "p-k4"].map((pid) => ({
                    providerId: pid,
                    config: { access: { type: "api-key", apiKey: "sk-" + pid }, modelOrder: [pid.replace("p-k", "M-K")] },
                  })),
                  { providerId: "p-acct", config: { access: { type: "zhipu-account", accountType: "bigmodel", mode: "individual-coding-plan" } } },
                ],
              },
              modelConfigRules: {
                providerModelRules: ["p-k1", "p-k2", "p-k3", "p-k4"].map((pid) => ({
                  modelId: pid.replace("p-k", "M-K"),
                  config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["a", "b"] } } },
                  providerId: pid,
                })),
              },
            },
          },
          null,
          2,
        ),
      );
      const sX = startDs(dir);
      try {
        await dsUpsert(sX, "m-ds02");
        const r = JSON.parse((await sX.call("dispatch", { mission_id: "m-ds02", pack_path: dsPack, persona_path: dsPersona, model: "p-acct/ACCT-M@low" })).text);
        ck.ok(
          "DS-02 拒绝回执形态（§12＋EXTRA①）：ok:true＋mission_id＋model_seed.seeded=false＋reason=model_arg_unusable（双写裁定，FA-3 谓词同型）",
          r.ok === true && r.mission_id === "m-ds02" && r.model_seed && r.model_seed.seeded === false &&
            r.model_seed.reason === "model_arg_unusable" && r.session_id === undefined && r.session_pending === undefined,
          { ok: r.ok, mission_id: r.mission_id, model_seed: r.model_seed },
        );
        ck.ok(
          "DS-02 rejected.kind=account_not_seedable＋provider_id=p-acct＋detail 实名 access.type（验收②，按 access.type 识别非前缀）",
          r.model_seed.rejected && r.model_seed.rejected.kind === "account_not_seedable" &&
            r.model_seed.rejected.provider_id === "p-acct" &&
            typeof r.model_seed.rejected.detail === "string" && r.model_seed.rejected.detail.includes("zhipu-account"),
          r.model_seed.rejected,
        );
        ck.ok(
          "DS-02 两条 guidance 字面逐字（draft §P3 回执设计）",
          JSON.stringify(r.model_seed.guidance) === JSON.stringify([GUIDANCE_MODEL_ARG, GUIDANCE_ENABLE_PROVIDER]),
          r.model_seed.guidance,
        );
        ck.ok(
          "DS-02 available_apikey_providers=enabled api-key 前 3 条（OPEN-1=B 截断：4 候选截 3，p-k4/p-acct 落选）",
          JSON.stringify(r.model_seed.available_apikey_providers) ===
            JSON.stringify(["p-k1/M-K1", "p-k2/M-K2", "p-k3/M-K3"]),
          r.model_seed.available_apikey_providers,
        );
        ck.ok(
          "DS-02 不 spawn 三锚：桩标记缺席＋result dir 零侧车＋dispatch-logs 零侧车（-p 不触达）",
          noSpawnLeg(dir, rt, sid),
          { marker: fs.existsSync(path.join(rolloutOf(dir), `model-io-${sid}.jsonl`)), results: emptyOrAbsent(resultDirOf(rt)), logs: emptyOrAbsent(logsDirOf(rt)) },
        );
        ck.ok(
          "DS-02 种子文件不落＋mission 留 drafted（拒绝=未派发，可重派，busy 闸零侧车不拦）",
          !fs.existsSync(seedFileOf(rt, "m-ds02")) && missionOf(rt, "m-ds02").status === "drafted",
          { seedExists: fs.existsSync(seedFileOf(rt, "m-ds02")), status: missionOf(rt, "m-ds02").status },
        );
      } finally {
        sX.close();
      }
    }

    // ---- DS-03-dms-apikey-trusted（验收③）：dms 指 api-key+enabled → 采信（fromDms 跳覆写回归）
    {
      const dir = subDir("ds03");
      const sid = "sess_ds03";
      dsStub(path.join(dir, "stub.mjs"), sid);
      const dmsReal = { providerId: "p-d", modelId: "M-D", options: { reasoningLevel: "lo" } };
      fs.writeFileSync(
        path.join(dir, "provider_config.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            config: {
              providerConfigRules: {
                providerRules: [
                  { providerId: "p-d", config: { access: { type: "api-key", apiKey: "sk-d" }, modelOrder: ["M-D"] } },
                ],
              },
              modelConfigRules: {
                providerModelRules: [
                  { modelId: "M-D", config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["lo", "hi"] } } }, providerId: "p-d" },
                ],
              },
              defaultModelSelection: dmsReal,
            },
          },
          null,
          2,
        ),
      );
      const sX = startDs(dir);
      try {
        await dsUpsert(sX, "m-ds03");
        const r = JSON.parse((await sX.call("dispatch", { mission_id: "m-ds03", pack_path: dsPack, persona_path: dsPersona })).text);
        ck.ok(
          "DS-03 dms 指 api-key+enabled → 采信（验收③）：选题=dms 的 provider/model 且 level=lo 原值直通（非 values.at(-1)=hi，O9=a）",
          r.ok === true && r.session_id === sid && r.model_seed && r.model_seed.seeded === true &&
            r.model_seed.provider_id === "p-d" && r.model_seed.model_id === "M-D" &&
            r.model_seed.reasoning_level === "lo",
          { model_seed: r.model_seed },
        );
        ck.ok(
          "DS-03 fromDms 跳覆写：种子 defaultModelSelection 与真实配置逐字节同值（宿主真值不重裁）",
          JSON.stringify(seedDmsOf(r)) === JSON.stringify(dmsReal),
          seedDmsOf(r),
        );
      } finally {
        sX.close();
      }
    }

    // ---- DS-04-dms-invalid-fast-fail（验收④）：三字面三腿——dms→disabled／dms→account／
    //      dms 形态非法 → 各自快速失败＋rejected 同名＋guidance＋不 spawn
    {
      const mkCase = (name, dms, rules, modelRules) => {
        const dir = subDir(name);
        const sid = "sess_" + name;
        dsStub(path.join(dir, "stub.mjs"), sid);
        const rt = trootOf(dir);
        fs.writeFileSync(
          path.join(dir, "provider_config.json"),
          JSON.stringify(
            {
              schemaVersion: 1,
              config: {
                providerConfigRules: { providerRules: rules },
                modelConfigRules: { providerModelRules: modelRules },
                defaultModelSelection: dms,
              },
            },
            null,
            2,
          ),
        );
        return { dir, sid, rt };
      };
      const assertFastFailLegs = (tag, r, dir, rt, sid, kind, providerId, missionId) => {
        ck.ok(
          `${tag} 快速失败：seeded=false＋reason=${kind}＋rejected.kind 同名直通${providerId ? "＋provider_id=" + providerId : "＋provider_id 缺席"}（验收④）`,
          r.ok === true && r.model_seed && r.model_seed.seeded === false && r.model_seed.reason === kind &&
            r.model_seed.rejected && r.model_seed.rejected.kind === kind &&
            (providerId ? r.model_seed.rejected.provider_id === providerId : r.model_seed.rejected.provider_id === undefined),
          { model_seed: r.model_seed },
        );
        ck.ok(
          `${tag} guidance 两条字面＋不 spawn 三锚＋种子文件不落（§12 零痕迹语义）`,
          JSON.stringify(r.model_seed.guidance) === JSON.stringify([GUIDANCE_MODEL_ARG, GUIDANCE_ENABLE_PROVIDER]) &&
            noSpawnLeg(dir, rt, sid) &&
            !fs.existsSync(seedFileOf(rt, missionId)),
          { guidance: r.model_seed.guidance, noSpawn: noSpawnLeg(dir, rt, sid) },
        );
      };
      // 4a dms → disabled provider
      {
        const { dir, sid, rt } = mkCase(
          "m-ds04a",
          { providerId: "p-off", modelId: "M-Off", options: { reasoningLevel: "mid" } },
          [
            { providerId: "p-off", enabled: false, config: { access: { type: "api-key", apiKey: "sk-old" } } },
            { providerId: "p-live", config: { access: { type: "api-key", apiKey: "sk-live" }, modelOrder: ["M-Live"] } },
          ],
          [
            { modelId: "M-Live", config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["a", "b"] } } }, providerId: "p-live" },
          ],
        );
        const sX = startDs(dir);
        try {
          await dsUpsert(sX, "m-ds04a");
          const r = JSON.parse((await sX.call("dispatch", { mission_id: "m-ds04a", pack_path: dsPack, persona_path: dsPersona })).text);
          assertFastFailLegs("DS-04a dms→disabled → dms_provider_disabled", r, dir, rt, sid, "dms_provider_disabled", "p-off");
          ck.ok(
            "DS-04a 不命中回落 provider（p-live 不被播种）＋mission 留 drafted",
            r.model_seed.provider_id === undefined && fs.readFileSync(path.join(rt, "board.json"), "utf8").includes('"drafted"'),
            { provider_id: r.model_seed.provider_id },
          );
        } finally {
          sX.close();
        }
      }
      // 4b dms → account provider
      {
        const { dir, sid, rt } = mkCase(
          "m-ds04b",
          { providerId: "p-acct", modelId: "M-Acct", options: { reasoningLevel: "low" } },
          [
            { providerId: "p-acct", config: { access: { type: "zhipu-account", accountType: "bigmodel" } } },
          ],
          [],
        );
        const sX = startDs(dir);
        try {
          await dsUpsert(sX, "m-ds04b");
          const r = JSON.parse((await sX.call("dispatch", { mission_id: "m-ds04b", pack_path: dsPack, persona_path: dsPersona })).text);
          assertFastFailLegs("DS-04b dms→account → dms_provider_account", r, dir, rt, sid, "dms_provider_account", "p-acct");
        } finally {
          sX.close();
        }
      }
      // 4c dms 形态非法（缺 modelId 的悬空对象）
      {
        const { dir, sid, rt } = mkCase(
          "m-ds04c",
          { providerId: "p-nowhere" },
          [
            { providerId: "p-any", config: { access: { type: "api-key", apiKey: "sk-any" }, modelOrder: ["M-Any"] } },
          ],
          [
            { modelId: "M-Any", config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["a", "b"] } } }, providerId: "p-any" },
          ],
        );
        const sX = startDs(dir);
        try {
          await dsUpsert(sX, "m-ds04c");
          const r = JSON.parse((await sX.call("dispatch", { mission_id: "m-ds04c", pack_path: dsPack, persona_path: dsPersona })).text);
          assertFastFailLegs("DS-04c dms 形态非法 → dms_shape_invalid", r, dir, rt, sid, "dms_shape_invalid", "p-nowhere");
        } finally {
          sX.close();
        }
      }
    }

    // ---- DS-05-no-model-no-dms-selection-missing（验收⑤）：无 model= 无 dms →
    //      selection_missing＋不命中任何 provider（no_apikey_model 退役腿）
    {
      const dir = subDir("ds05");
      const sid = "sess_ds05";
      dsStub(path.join(dir, "stub.mjs"), sid);
      const rt = trootOf(dir);
      fs.writeFileSync(
        path.join(dir, "provider_config.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            config: {
              providerConfigRules: {
                providerRules: [
                  { providerId: "p-any", config: { access: { type: "api-key", apiKey: "sk-any" }, modelOrder: ["M-Any"] } },
                ],
              },
              modelConfigRules: {
                providerModelRules: [
                  { modelId: "M-Any", config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["a", "b"] } } }, providerId: "p-any" },
                ],
              },
            },
          },
          null,
          2,
        ),
      );
      const sX = startDs(dir);
      try {
        await dsUpsert(sX, "m-ds05");
        const r = JSON.parse((await sX.call("dispatch", { mission_id: "m-ds05", pack_path: dsPack, persona_path: dsPersona })).text);
        ck.ok(
          "DS-05 无 model 无 dms → selection_missing 快速失败＋rejected 同名＋provider_id 缺席（不命中任何 provider，验收⑤；no_apikey_model 退役）",
          r.ok === true && r.model_seed && r.model_seed.seeded === false && r.model_seed.reason === "selection_missing" &&
            r.model_seed.rejected && r.model_seed.rejected.kind === "selection_missing" &&
            r.model_seed.rejected.provider_id === undefined && r.model_seed.provider_id === undefined,
          { model_seed: r.model_seed },
        );
        ck.ok(
          "DS-05 guidance 两条字面＋不 spawn 三锚＋种子不落＋留 drafted（fixture 有可用 api-key provider 仍不猜测——禁自动回落实锤）",
          JSON.stringify(r.model_seed.guidance) === JSON.stringify([GUIDANCE_MODEL_ARG, GUIDANCE_ENABLE_PROVIDER]) &&
            noSpawnLeg(dir, rt, sid) && !fs.existsSync(seedFileOf(rt, "m-ds05")) &&
            missionOf(rt, "m-ds05").status === "drafted",
          { noSpawn: noSpawnLeg(dir, rt, sid), status: missionOf(rt, "m-ds05").status },
        );
      } finally {
        sX.close();
      }
    }

    // ---- DS-06-level-omit-regression（验收⑥）：level 缺失 → 种子 omit（CLI 自回落回归）；
    //      显式 level ∉ optionSpecs values → level_warning 附（提示非门禁）
    {
      // 6a omit 腿：无 optionSpecs＋显式 model 无 @level → reasoning_level=null、种子无 dms
      const dirA = subDir("ds06a");
      const sidA = "sess_ds06a";
      dsStub(path.join(dirA, "stub.mjs"), sidA);
      fs.writeFileSync(
        path.join(dirA, "provider_config.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            config: {
              providerConfigRules: {
                providerRules: [
                  { providerId: "p-o", config: { access: { type: "api-key", apiKey: "sk-o" }, modelOrder: ["M-O"] } },
                ],
              },
              modelConfigRules: {
                providerModelRules: [{ modelId: "M-O", config: { enabled: true } , providerId: "p-o" }],
              },
            },
          },
          null,
          2,
        ),
      );
      const sA = startDs(dirA);
      try {
        await dsUpsert(sA, "m-ds06a");
        const r = JSON.parse((await sA.call("dispatch", { mission_id: "m-ds06a", pack_path: dsPack, persona_path: dsPersona, model: "p-o/M-O" })).text);
        ck.ok(
          "DS-06a level 缺失 → seeded:true＋reasoning_level=null＋种子 omit defaultModelSelection（CLI 自回落回归，验收⑥前半）",
          r.ok === true && r.session_id === sidA && r.model_seed && r.model_seed.seeded === true &&
            r.model_seed.reasoning_level == null && seedDmsOf(r) === undefined &&
            r.model_seed.level_warning === undefined,
          { model_seed: r.model_seed, seedDms: seedDmsOf(r) },
        );
      } finally {
        sA.close();
      }
      // 6b level_warning 腿：显式 @zz ∉ values → 仍采信播种（不拦截）＋提示字段附着
      const dirB = subDir("ds06b");
      const sidB = "sess_ds06b";
      dsStub(path.join(dirB, "stub.mjs"), sidB);
      fs.writeFileSync(
        path.join(dirB, "provider_config.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            config: {
              providerConfigRules: {
                providerRules: [
                  { providerId: "p-w", config: { access: { type: "api-key", apiKey: "sk-w" }, modelOrder: ["M-W"] } },
                ],
              },
              modelConfigRules: {
                providerModelRules: [
                  { modelId: "M-W", config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["a", "b"] } } }, providerId: "p-w" },
                ],
              },
            },
          },
          null,
          2,
        ),
      );
      const sB = startDs(dirB);
      try {
        await dsUpsert(sB, "m-ds06b");
        const r = JSON.parse((await sB.call("dispatch", { mission_id: "m-ds06b", pack_path: dsPack, persona_path: dsPersona, model: "p-w/M-W@zz" })).text);
        ck.ok(
          "DS-06b 显式 level ∉ 值域 → 仍采信播种（裁定③显式意志采信，不拦截不猜测，验收⑥后半）",
          r.ok === true && r.session_id === sidB && r.model_seed && r.model_seed.seeded === true &&
            r.model_seed.reasoning_level === "zz",
          { model_seed: r.model_seed },
        );
        ck.ok(
          "DS-06b level_warning 附着且实名越界档位（提示非门禁：仅在 optionSpecs 可查且 ∉ values 时附）",
          typeof r.model_seed.level_warning === "string" && r.model_seed.level_warning.includes("@zz") &&
            r.model_seed.level_warning.includes("M-W"),
          r.model_seed.level_warning,
        );
      } finally {
        sB.close();
      }
    }

    // ---- DS-07-guidance-in-dispatch-text（验收⑦）：dispatch 返回面文本含两条指引字样
    {
      const dir = subDir("ds07");
      dsStub(path.join(dir, "stub.mjs"), "sess_ds07");
      fs.writeFileSync(
        path.join(dir, "provider_config.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            config: {
              providerConfigRules: {
                providerRules: [
                  { providerId: "p-acct7", config: { access: { type: "zhipu-account", accountType: "bigmodel" } } },
                ],
              },
              modelConfigRules: { providerModelRules: [] },
            },
          },
          null,
          2,
        ),
      );
      const sX = startDs(dir);
      try {
        await dsUpsert(sX, "m-ds07");
        const raw = await sX.call("dispatch", { mission_id: "m-ds07", pack_path: dsPack, persona_path: dsPersona, model: "p-acct7/A-M@low" });
        // 返回面文本=回执 JSON 序列化串——含引号的指引字样以 JSON 转义形出现（\"），
        // 无引号的第二条原样出现；两形皆核（机械口径：字样在文本面可被主控读到）。
        const esc = (s) => JSON.stringify(s).slice(1, -1);
        ck.ok(
          "DS-07 dispatch 返回面文本含两条指引字样（工具文本面，主控可直接读，验收⑦；含引号字样按 JSON 转义形核）",
          typeof raw.text === "string" &&
            raw.text.includes(esc(GUIDANCE_MODEL_ARG)) && raw.text.includes(GUIDANCE_ENABLE_PROVIDER),
          typeof raw.text === "string" ? raw.text.slice(0, 200) : raw.text,
        );
      } finally {
        sX.close();
      }
    }

    // ---- DS-08-nonexistent-provider-model-arg-unusable（验收⑧）：显式 model 指向不存在
    //      provider → reason=model_arg_unusable 字面保留＋无 rejected 字段（PQA3 非选择类腿，
    //      boot-then-die 现行为不变：runner 照常启动）
    {
      const dir = subDir("ds08");
      const sid = "sess_ds08";
      dsStub(path.join(dir, "stub.mjs"), sid);
      fs.writeFileSync(
        path.join(dir, "provider_config.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            config: {
              providerConfigRules: {
                providerRules: [
                  { providerId: "p-real", config: { access: { type: "api-key", apiKey: "sk-r" }, modelOrder: ["M-R"] } },
                ],
              },
              modelConfigRules: {
                providerModelRules: [
                  { modelId: "M-R", config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["a", "b"] } } }, providerId: "p-real" },
                ],
              },
            },
          },
          null,
          2,
        ),
      );
      const sX = startDs(dir);
      try {
        await dsUpsert(sX, "m-ds08");
        const r = JSON.parse((await sX.call("dispatch", { mission_id: "m-ds08", pack_path: dsPack, persona_path: dsPersona, model: "p-ghost/Ghost-M@low" })).text);
        ck.ok(
          "DS-08 显式 model 指向不存在 provider → seeded:false＋reason=model_arg_unusable 字面保留＋rejected/guidance 缺席（验收⑧＋PQA3 非选择类腿）",
          r.ok === true && r.model_seed && r.model_seed.seeded === false && r.model_seed.reason === "model_arg_unusable" &&
            r.model_seed.rejected === undefined && r.model_seed.guidance === undefined &&
            r.model_seed.available_apikey_providers === undefined,
          { model_seed: r.model_seed },
        );
        ck.ok(
          "DS-08 非选择类现行为不变：runner 照常启动（桩标记在场=spawn 发生，boot-then-die 面保持）",
          r.session_id === sid && fs.existsSync(path.join(rolloutOf(dir), `model-io-${sid}.jsonl`)),
          { session_id: r.session_id, marker: fs.existsSync(path.join(rolloutOf(dir), `model-io-${sid}.jsonl`)) },
        );
      } finally {
        sX.close();
      }
    }

    // ---- ST-02-first-enabled-erased（验收⑩）：server.mjs「first enabled」字样归零静态锁
    {
      const serverSrc = fs.readFileSync(DEFAULT_SERVER, "utf8");
      ck.ok(
        "ST-02 server.mjs「first enabled」字样归零（段③首 api-key 猜测删除的源码静态锁，P3 验收⑩）",
        !serverSrc.includes("first enabled"),
        serverSrc.includes("first enabled") ? "literal present" : "absent",
      );
    }

    // ---- ST-01-mcpjson-protocolversion-legacy（P1 验收③，impl-plan §9 用例 #15）：.mcp.json
    //      orch 节点 protocolVersion:"legacy" 静态断言（防回退）。R2-01 注记（impl-plan §4
    //      验收）：本断言只锁文件面，生效面归主控 0.16.2 活验段①②——宿主重载/新会话重读
    //      .mcp.json 为前提，不重载则旧进程上照样为真=假阳性。resolveVersionNegotiationMode
    //      遇 "legacy" 直走 legacy 分支、整条 server/discover 探测窗与 ERA 面摘除（survey
    //      §2.5 第 3 条/§2.2-c/§4）。版本三件套三方一致不在本用例重复钉点（LM-03 既有断言面，
    //      impl-plan §4 改动面 3 引用不重复）。
    {
      let mcpCfg = null;
      try {
        mcpCfg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, ".mcp.json"), "utf8"));
        ck.ok("ST-01 .mcp.json JSON parse 通过（P1 静态面）", true, "parsed");
      } catch (e) {
        ck.ok("ST-01 .mcp.json JSON parse 通过（P1 静态面）", false, String(e).slice(0, 200));
      }
      const orch = mcpCfg && mcpCfg.mcpServers && mcpCfg.mcpServers.orch;
      ck.ok(
        "ST-01 .mcp.json orch 节点含 protocolVersion:\"legacy\"（防回退静态锁，P1 验收③）",
        !!orch && orch.protocolVersion === "legacy",
        orch ? `protocolVersion=${JSON.stringify(orch.protocolVersion)}` : "orch node absent",
      );
    }
  } finally {
    BASE.cleanup();
  }
}

ck.summary();
process.exit(ck.fails.length ? 1 : 0);
