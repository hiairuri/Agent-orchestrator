// @module crv8-memory
/*!
 * suites/crv8-memory.mjs —— v0.8 记忆子系统 suite（W1 bootstrap：P0 分发端补门 INJ 族；
 *   W2 增例：两级库与捎带面 SYNC/GLEAN/INJ-06b 族；W3 增例：ORCHTEMP 与锁 GLEAN-03/05 族）
 *
 * 覆盖断言组（断言主句权威 = tests/assertions/v0.8.x.md；v0.9 增例权威 =
 *   tests/assertions/v0.9.x.md；设计权威 = v0.8-DESIGN §3/§4/§5/§6/§7/§14 +
 *   v0.9-DESIGN §10 C5/§15 W1）：
 *   A-v080-INJ-01（§3.1 type 加权不滤除：error-fix 单类命中入选 + 同 overlap 等分时
 *     error-fix 以 LESSON_TYPE_WEIGHT 排在 pitfall 前，任何 type 不被滤除）
 *   A-v080-INJ-02（§3.2 INJECT_MIN_SCORE=0.40 阈值门：原始衰减持 score<0.40 不入选
 *     〔同 overlap 对照 fixture，排除面只归阈值〕；常量默认值锁定——server.mjs 子串 +
 *     断言登记文件双文件 grep 防漂移，沿 CFG-05 先例）
 *   A-v080-INJ-03（§3.3 id 渲染：lessonLine 含 [type·id] 段且每行增量 ≤24B；
 *     无命中/空库整节不出现性质回归 = CR-04「参数缺省时节整体不出现」）
 *   A-v080-INJ-04（§3.4 lesson_refs 降权闭环：report(blocked, lesson_refs) →
 *     confidence −0.1 下限 0.1 + counter_refs 记 mission（去重）+ 未知 id 跳过带注；
 *     触底（confidence=0.1）且 ≥2 个 mission 回引 → housekeep 置 retired
 *     note="auto: lesson misses"）
 *   A-v080-INJ-05（§3.4 兼容守卫：无 lesson_refs / 非数组 / 无意义 kind（done）携带 →
 *     整体忽略，库零变化，旧 worker 零变化）
 *   A-v080-INJ-06a（§3.5 scope+source 字段：add 写 scope="project"/source="add"、
 *     report 候选写 source="report"；读端容忍——缺 scope 存量行照常入选（缺省 project
 *     语义）、未知字段不炸）
 *   A-v080-INJ-06b（W2，§3.5 双库读端：双库合并选材 + normKey 去重全端优先（同
 *     merge key 的项目孪生被全端条目遮蔽、恰渲染一次）+ contradicts 不跨库（全端 id
 *     项目库寻址失败、全端库字节零变化）；场景内附 §7.2 全端节三腿（注入/节序/
 *     pack_global_section 开关，无独立 §14 ID，随本场景施工））
 *   A-v080-INJ-07（§3.6 死码清理：server.mjs grep topLessonsBrief/BRIEF_TOP_K/
 *     BRIEF_MAX_CHARS 零命中；session-start lessons digest 注释无悬空「twin of
 *     server.mjs」字样且本地副本实现仍在）
 *   A-v080-INJ-08（CR-04 性质锁：无全端库+无 ORCH.md 临时根下 context_pack 输出与
 *     0.7.1 基线（git f0142a8）逐字节一致；含 LESSONS 命中场景时唯一预期增量=id 段
 *     （归一化后逐字节）。W2 起 0.8 侧随 --memory-root 注入空全端目录环境重跑）
 *   A-v080-SYNC-01..05（W2，§4 ver 同步捎带族：首读 initial 全文（文件不存在时不附
 *     基线=absent）/外部改写 changed+ver 递增/stat 未变零开销无键/超 120 行截断
 *     truncated:true+提示行/删除 removed 恰一次后安静）
 *   A-v080-GLEAN-01（W2，§6.1 门槛纯函数：双门槛真值表（时间门必要+事件门必要）
 *     +成本排序（源码序断言：时间比较先于事件计数、事件计数先于锁仲裁））
 *   A-v080-GLEAN-02（W2，§6.1/§9.2 到期信号：双门过 → due:true+reason+brief_path+
 *     lock_state=idle；锁 active 活 PID → 只附 lock_state=busy 无 due 键且不物化 brief）
 *   A-v080-GLEAN-04（W2，§9.2 glean-brief.json 物化字段齐全：v/generated_at/root_id/
 *     project_path/gate（含 measured）/watermarks/orchtemp_pending/counts/projects/
 *     orch_md/cfg）
 *   A-v080-GLEAN-06（W2，§6.6 项目名册：启动 upsert 恰一行（五字段齐全）/复见原地
 *     更新 last_seen 不重复行且 first_seen 保留/异 root 追加/带锁（源码序 + 活 PID
 *     占锁时 best-effort 零变化行为腿）/--memory-root 注入生效（不落缺省重定向））
 *   A-v080-GLEAN-03（W3，§6.4/§9.3 归敛锁状态机全腿：wx 抢锁原子（EEXIST 互斥）/
 *     活 PID 占用拒接管（busy 即退零阻塞）/死 PID 回收/绝对过期 1.5h 回收 +
 *     cfg.lock_stale_hours 覆盖接线/done 态保留且 finished_at 优先、mtime 兜底
 *     （mtime 双用）/两锁不互嵌源码面（server 对归敛锁只读判锁）/cfg junk 逐键兜底）
 *   A-v0110-M10-01（M10 G12，board/list glean_due 信号入 result JSON 内部：due →
 *     顶层 glean_due {idle_h,events,brief_path} 且同调用内 brief 物化可达/时间门·
 *     事件门·busy 三无 due 腿键整体缺省（零字节差缺省，P9-01 体例）；顶层 orch_memory
 *     附件保留不拆。设计权威 designs/agent-orchestrator-prompt-opt-20261024.md + G12
 *     双实证（主控+gleaner）；断言主句权威 tests/assertions/v0.11.x.md §1）
 *   A-v0110-GLEAN3-01（glean3 微波，m-20261025-012000-glean3：server 物化固定
 *     glean-pack.md 主控零组装——gate due 同调用点随 brief 再生（brief 物化后组合）；
 *     due 信号两 surfacing 均增 pack_path（orch_memory.glean + board/list glean_due）；
 *     固定模板锚（persona 路径 agents/orch-gleaner.md/锁权威指针勿手写/四态口径/视图层
 *     边界/日志纪律 reports/<ts>-glean.md/Return ≤3 行指针纪律）+ brief 逐字内嵌
 *     （brief 文件字节 ⊂ pack 字节）；brief+pack 删除后 board/list 单调用双重建；
 *     busy 不重写 pack（零写面）；无 due 不物化 pack（零字节差缺省，P9-01 体例）。
 *     断言主句权威 tests/assertions/v0.11.x.md §1）
 *   A-v080-GLEAN-05（W3，§5 stage 写入形状与 ORCHTEMP 候选流转：source=
 *     orchestrator/candidate/conf=0/hits=0 + note 摆放提示 + escape 先于截断 +
 *     type 缺省 pitfall/坏 type 空 trigger 严格报错/不做 findMergeTarget 合并/
 *     candidate 不参与注入（纯 stage 库 LESSONS 整节不出现）/brief.orchtemp_pending
 *     恰含 stage 条（report 候选不入）/retire 消费置状态内容逐字节不变/§9.4 schema
 *     描述行逐字在案）
 *   A-v080-GLEAN-07（W5，§6.7 promote target=global：晋升标准两分支证据随响应
 *     （跨项目复现≥2〔名册 sibling 库同 normKey 含 candidate〕/单库强条
 *     score≥0.7∧hits≥3∧龄≥7d）+ 全端 findMergeTarget 合并/新建两腿（scope=global/
 *     source=promote/conf 0.7/hits 1）+ refs 回链三元组〔源条 id, 源项目路径,
 *     root_id〕+ 项目库源条逐字节原地不动 + 缺省 target=project 现行为零变化 +
 *     坏 target 严格报错 + schema 枚举在案；标准证据非 server 门——判定权在归敛
 *     〔§6.7「归敛自行判定并在报告列证据」，偏差声明见断言文件 §0 W5 条〕）
 *   A-v080-GLEAN-08（W5，§3.5/§6.7 双库去重终验（晋升场景）：promote 后同 normKey
 *     项目源条被全端新条遮蔽（源 id 不渲染、晋升 id 恰渲染一次）+ 晋升后注入可见
 *     （pack LESSONS 渲染全端新条）+ 读端零写（两库字节零变化））
 *
 *   A-v090-THR-01（v0.9 W1，C5 阈值落值：INJECT_MIN_SCORE 0.40→0.39——新值行为生效
 *     对照〔判别行 score≈0.395∈[0.39,0.40) 入选，0.40 口径下必被排除〕+ 落门/入选
 *     对照更新（OLD≈0.158<0.39 落门、FRESH 0.60 入选）+ 推导注记 v0.9 复算版在案
 *     （P25=0.4583 ×0.85 圆整 0.39、界 [0.30,0.50]）；断言主句权威 = v0.9.x.md。
 *     INJ-02 常量锁登记面随之改钉 v0.9.x.md（0.39 口径；v0.8.x.md 为 0.8 期历史
 *     记录，不在本波写集））
 *   A-v090-REG-01（v0.9 W3，C7 registry library_path + sibling 扫描两腿：登记行含
 *     library_path=本实例实际解析项目库绝对路径/自定义 --root sibling 自登记可见且
 *     经 library_path 优先腿端到端命中 cross-project count=2（默认布局映射下不可见）/
 *     无 library_path 存量行回退默认布局命中（回退腿，兼容守卫）；断言主句权威 =
 *     v0.9.x.md；设计权威 = v0.9-DESIGN §9 C7）
 *   A-v090-HOST-01b（v0.9 W3 条件腿，C6 双注入证实触发：宿主用户级注入面源码复核
 *     结论=存在〔~/.zcode/AGENTS.md，scope="user"，designs/agent-orchestrator-v0.9-C6-
 *     findings.md〕→ readGleanCfg 缺省 pack_global_section false（cfg 键翻转锁：源码
 *     字面量 grep + 无 cfg 缺省关行为腿）；全端节 SEC72-a 改显式 opt-in（cfg true），
 *     GLEAN-03g junk 回落值随缺省翻转为 false；设计权威 = v0.9-DESIGN §8/§16）
 *   A-v090-W3FIX（v0.9 W3fix，m-20261022-180233-3051：saveGlobalLessons base 修复
 *     回归——显式 --memory-root 指向项目根外（生产缺省 ~/.zcode/orchestrator-memory
 *     同位）时 promote target=global 端到端成功〔原炸点「path escapes base directory」
 *     转绿：新建/合并两写腿〕+ 源条原地不动红线在根外场景同守；断言主句权威 =
 *     v0.9.x.md〔登记归主控补，不在本波写集〕；设计权威 = v0.8-DESIGN §6.7）
 *
 * W2 落位注记：全端库缺省 ~/.zcode/orchestrator-memory；suite 临时根（os.tmpdir() 下）
 *   的缺省重定向=<临时根>/orchestrator-memory（root.txt「test root must not stick」同族
 *   刻出，防套件污染真实家目录）——SYNC/GLEAN-01/02/04/INJ-06b 场景即用该缺省落点布景，
 *   GLEAN-06 场景经 --memory-root 显式注入另测。
 *
 * v0.10 G2 稳定化（m-20261024-032310-bf22）：GLEAN-02b/03b/03c/03d 直写 glean 锁后
 *   加 server 侧读回屏障（glean 键对 server 可见再断言）——NTFS mtime 可略超前
 *   Date.now()（本机实测 -10ms 量级），idle_hours=0 的严格 `idleH > 0` 时间门首读
 *   偶落空（与 ENV-06a「直写 now 被判未来」同族）；SYNC-02 两次同尺寸改写间加 100ms
 *   时序余量（mtime 时钟粒度 ~15.6ms，同跳则双因子判不出 changed，CACHE-06a 同族）。
 *   两处均只改观测时序，断言主句零改动（只增屏障代码，不增删断言）。
 *
 * 运行方式：node tests/suites/crv8-memory.mjs [--root <临时根父目录>]
 * 前置：node >= 20；PATH 上有 git（INJ-08 基线导出）；无网。suite 注册行归主控
 *   G 胶水波收口（run-all REGISTRY，§13.2）——本套未注册前 run-all 不含其断言属预期。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { startServer, Checker, DEFAULT_SERVER, PLUGIN_DIR, TESTS_DIR, PRE } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot, parseRootArg, blankMission, writeBoardSeed } from "../harness/temp-root.mjs";
import { exportFileFromGit, repoRoot } from "../harness/git-fixture.mjs";

const ck = new Checker("crv8-memory");
const BASE = makeTempRoot({ prefix: "orch-crv8-", root: parseRootArg() || undefined });
const HOOKS_SRC = path.join(PLUGIN_DIR, "hooks", "session-start.mjs");
// v0.9 W1（C5 落值 0.40→0.39）起，INJ-02 常量锁「防漂移第二文件」改钉 v0.9.x.md
// （v0.8.x.md 保留 0.8 期历史记录，不在本波写集；现行值锁面=INJECT_MIN_SCORE=0.39）。
const ASSERT_DOC = path.join(TESTS_DIR, "assertions", "v0.9.x.md");

const resultText = (r) => r.json ?? { _raw: r.text };
const subRoot = (name) => {
  const dir = path.join(BASE.root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const readPack = (rootDir, mid, file = "pack.md") => {
  const p = path.join(rootDir, "packs", mid, file);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
};
const readLessons = (rootDir) =>
  fs
    .readFileSync(path.join(rootDir, "memory", "lessons.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
const approx2 = (x) => Number(Number(x).toFixed(2));
const writeJsonl = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
const readJsonl = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
const normPath = (p) => path.resolve(String(p)).toLowerCase();

/**
 * v0.10 G2 直写→server 读回屏障（照 ENV-06c 配方，勿发明新机制）：glean 锁由测试
 * 进程直写后，server 侧以锁文件 mtimeMs 作 lastGleanMs 与自身 Date.now() 求差。NTFS
 * mtime 时钟粒度/时钟源偏移下 mtime 可略「未来」于 Date.now()（本机直写探针实测
 * -10ms 量级、40/40 例），idle_hours=0 的严格 `idleH > 0` 时间门首读会落空（响应无
 * orch_memory.glean 键）——与 ENV-06a「直写 now 被判未来」同族。轮询同一读面直到
 * 锁状态对 server 可见（glean 键出现）再断言；语义不变：真回归时轮询窗内恒不可见，
 * 末次响应照常判红（与 ENV-06c board get 读回屏障同构）。
 */
const gleanAfterWrite = async (rawCall, tries = 60, stepMs = 50) => {
  let glean = null;
  for (let i = 0; i < tries; i++) {
    const r = await rawCall("lessons", { action: "list" });
    glean = (r.result && r.result.orch_memory && r.result.orch_memory.glean) || null;
    if (glean) return glean;
    await new Promise((res) => setTimeout(res, stepMs));
  }
  return glean;
};

/**
 * W2 rig：harness startServer 的扩展参数孪生（--memory-root 注入用）。jsonrpc-client.mjs
 * 不在本波写集内，故本套自带 spawn——按行 JSON-RPC 协议与 harness 逐字同款。
 */
function startServerX({ serverPath = DEFAULT_SERVER, root, args = [], timeoutMs = 20000 } = {}) {
  const child = spawn(process.execPath, [serverPath, "--root", root, ...args], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
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
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("timeout " + method));
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
    });
  const call = async (name, args2) => {
    const r = await request("tools/call", { name: PRE + name, arguments: args2 });
    const result = r.result || {};
    const text = (result.content ?? []).map((c) => c.text).join("\n");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 文本（错误文案） */
    }
    return { isError: result.isError === true, text, json };
  };
  const close = () => {
    try {
      child.stdin.end();
    } catch {}
    try {
      child.kill();
    } catch {}
  };
  return { request, call, close };
}

/* ============ 场景 1：INJ-01 / INJ-03 / INJ-06a（root r-inj01） ============ */
{
  const R1 = subRoot("r-inj01");
  const s1 = startServer({ root: R1 });
  try {
    // ---- INJ-03c（CR-04 性质）：空库 → LESSONS 节整体不出现
    await s1.call("context_pack", { mission_id: "m-empty", title: "空库包", task: "空库回归任务" });
    const packEmpty = readPack(R1, "m-empty");
    ck.ok("INJ-03c 空库 pack 无 LESSONS 节（CR-04 节整体不出现）", Boolean(packEmpty) && !packEmpty.includes("## LESSONS"), packEmpty && packEmpty.split("\n").filter((l) => l.startsWith("## ")));

    // 无命中填充条目在库 → 无 token 交集同样整节不出现
    await s1.call("lessons", { action: "add", type: "env-fact", trigger: "无关触发词XYZQQ", fix: "无关修正" });
    await s1.call("context_pack", { mission_id: "m-nomatch", title: "无命中包", task: "完全不相关任务码" });
    const packNoMatch = readPack(R1, "m-nomatch");
    ck.ok("INJ-03c 无 token 交集 pack 无 LESSONS 节（性质回归）", Boolean(packNoMatch) && !packNoMatch.includes("## LESSONS"), packNoMatch && packNoMatch.split("\n").filter((l) => l.startsWith("## ")));

    // ---- INJ-01a：error-fix 单类命中 → 入选不滤除
    const addEf = await s1.call("lessons", {
      action: "add",
      type: "error-fix",
      trigger: "AP1PROBE 构建失败排查",
      fix: "清理缓存后重跑构建",
    });
    const efId = resultText(addEf).id;
    ck.ok("INJ-01a 前置 lessons add ok（error-fix）", addEf.isError !== true && Boolean(efId), addEf.text.slice(0, 80));
    const taskEf = "AP1PROBE 构建失败排查任务";
    await s1.call("context_pack", { mission_id: "m-ef", title: "单类命中包", task: taskEf });
    const packEf = readPack(R1, "m-ef");
    const efLine = (packEf || "").split("\n").find((l) => l.startsWith("- [error-fix·"));
    ck.ok("INJ-01a 仅 error-fix 命中 → 入选不被滤除", Boolean(efLine), packEf && packEf.split("\n").filter((l) => l.startsWith("## LESSONS") || l.startsWith("- [")));

    // ---- INJ-03a/b：id 段渲染 + 每行增量 ≤24B
    ck.ok(
      "INJ-03a lessonLine 含 [type·id] 段（l-YYYYMMDD-6hex）",
      Boolean(efLine) && /^- \[error-fix·l-\d{8}-[0-9a-f]{6}\] 触发：.+\n  修正：/.test(packEf.slice(packEf.indexOf(efLine))),
      efLine,
    );
    const efBase = efLine.replace(/·l-\d{8}-[0-9a-f]{6}/, "");
    const incBytes = efLine.length - efBase.length;
    ck.ok("INJ-03b id 段每行增量 ≤24B（实测 " + incBytes + "B）", incBytes >= 1 && incBytes <= 24, { incBytes, efLine });
    ck.ok("INJ-03b id 与库内条目一致（回引锚可达）", Boolean(efLine) && efLine.includes(`·${efId}]`), { efId, efLine });

    // ---- INJ-01b：同 overlap 等分 → 权重排序 error-fix 在 pitfall 前；两 type 均在（不滤除）
    await s1.call("lessons", { action: "add", type: "pitfall", trigger: "AP1PROBE 构建失败排查", fix: "清理缓存后重跑构建" });
    await s1.call("context_pack", { mission_id: "m-both", title: "双类命中包", task: taskEf });
    const packBoth = readPack(R1, "m-both");
    const iEf = (packBoth || "").indexOf("- [error-fix·");
    const iPf = (packBoth || "").indexOf("- [pitfall·");
    ck.ok("INJ-01b 两 type 均入选（加权不滤除）", iEf >= 0 && iPf >= 0, packBoth && packBoth.split("\n").filter((l) => l.startsWith("- [")));
    ck.ok("INJ-01b 等 overlap 等分时 error-fix（权重 1.0）排在 pitfall（0.9）前", iEf >= 0 && iPf >= 0 && iEf < iPf, { iEf, iPf });

    // ---- INJ-06a：scope/source 写入形状
    const rows1 = readLessons(R1);
    const toolRows = rows1.filter((l) => l.id === efId || l.type === "pitfall");
    ck.ok(
      "INJ-06a add 写 scope=project + source=add",
      toolRows.length >= 2 && toolRows.every((l) => l.scope === "project" && l.source === "add"),
      toolRows.map((l) => ({ id: l.id, scope: l.scope, source: l.source })),
    );
    // report(done, lessons) 候选行 → source=report（board upsert mission 无派发
    // token，避开 V6-09 fail-closed token 门；context_pack 铸发的 m-* 带 token）
    await s1.call("board", { action: "upsert", mission: { id: "m-cand", title: "候选上报 mission" } });
    const repDone = await s1.call("report", {
      mission_id: "m-cand",
      worker: "w-cand",
      kind: "done",
      summary: "候选教训上报",
      lessons: [{ type: "error-fix", trigger: "CANDPROBE 候选教训触发", fix: "候选教训修正" }],
    });
    const candRow = readLessons(R1).find((l) => String(l.trigger || "").includes("CANDPROBE"));
    ck.ok(
      "INJ-06a report 候选写 source=report + scope=project（status=candidate）",
      repDone.isError !== true && Boolean(candRow) && candRow.source === "report" && candRow.scope === "project" && candRow.status === "candidate",
      candRow && { source: candRow.source, scope: candRow.scope, status: candRow.status },
    );

    // ---- INJ-06a：读端容忍——存量行缺 scope/source 照常入选（缺省 project）+ 未知字段不炸
    const tolRow = {
      v: 1,
      id: "l-20260101-ffffff",
      ts: "2026-01-01T00:00:00.000Z",
      updated_at: new Date().toISOString(),
      mission_id: null,
      worker: "legacy",
      type: "env-fact",
      trigger: "TOLPROBE 未知字段容忍",
      lesson: "",
      fix: "容忍未知字段",
      confidence: 0.9,
      hits: 9,
      status: "active",
      refs: [],
      superseded_by: null,
      counter_refs: [],
      note: null,
      future_field: { unknown: true },
    };
    fs.appendFileSync(path.join(R1, "memory", "lessons.jsonl"), JSON.stringify(tolRow) + "\n");
    const listTol = resultText(await s1.call("lessons", { action: "list", status: "all", q: "TOLPROBE" }));
    ck.ok("INJ-06a 缺 scope 存量行 + 未知字段 → lessons list 不炸", (listTol.lessons || []).length === 1, listTol.lessons);
    await s1.call("context_pack", { mission_id: "m-tol", title: "容忍包", task: "TOLPROBE 未知字段容忍" });
    const packTol = readPack(R1, "m-tol");
    ck.ok(
      "INJ-06a 缺 scope 行照常入选（缺省 project 语义）",
      Boolean(packTol) && packTol.includes("- [env-fact·l-20260101-ffffff]"),
      packTol && packTol.split("\n").filter((l) => l.startsWith("- [")),
    );
  } finally {
    s1.close();
  }
}

/* ============ 场景 2：INJ-02（root r-inj02，手写库对照 fixture + 常量锁） ============ */
{
  const R2 = subRoot("r-inj02");
  const nowIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - 40 * 86400000).toISOString();
  const baseRow = {
    v: 1,
    ts: nowIso,
    mission_id: null,
    worker: "t",
    type: "pitfall",
    trigger: "INJ2TOKEN 构建缓存损坏检测",
    lesson: "",
    fix: "INJ2TOKEN 重建缓存目录",
    confidence: 0.6,
    hits: 1,
    status: "active",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
  };
  // 同 trigger 同 overlap 同 type：唯一差异 = updated_at（score 衰减）。
  // FRESH score=0.6 ≥0.39 入选；OLD score=0.6×exp(-40/30)≈0.158 <0.39 落门
  // （v0.9 C5 落值 0.40→0.39 口径；判别行对照见 THR-01 场景）。
  const rows2 = [
    { ...baseRow, id: "l-20260101-aaa001", updated_at: nowIso },
    { ...baseRow, id: "l-20260101-aaa002", updated_at: oldIso },
  ];
  fs.mkdirSync(path.join(R2, "memory"), { recursive: true });
  fs.writeFileSync(path.join(R2, "memory", "lessons.jsonl"), rows2.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const s2 = startServer({ root: R2 });
  try {
    await s2.call("context_pack", { mission_id: "m-gate", title: "阈值门包", task: "INJ2TOKEN 阈值门回归验证" });
    const packGate = readPack(R2, "m-gate");
    ck.ok(
      "INJ-02 score<0.39 不入选（OLD≈0.158 落门）而达标行（0.60）入选；同 overlap 排除面只归阈值",
      Boolean(packGate) && packGate.includes("l-20260101-aaa001") && !packGate.includes("l-20260101-aaa002") && packGate.includes("## LESSONS"),
      packGate && packGate.split("\n").filter((l) => l.startsWith("- [")),
    );

    // 常量默认值锁定（双文件子串，沿 CFG-05 先例）：server.mjs 常量 + 断言登记文件
    const srvSrc = fs.readFileSync(DEFAULT_SERVER, "utf8");
    const docSrc = fs.existsSync(ASSERT_DOC) ? fs.readFileSync(ASSERT_DOC, "utf8") : "";
    ck.ok("INJ-02 常量锁 server.mjs：INJECT_MIN_SCORE = 0.39 在位（v0.9 C5 落值）", /const INJECT_MIN_SCORE = 0\.39;/.test(srvSrc));
    ck.ok(
      "INJ-02 常量锁 server.mjs：LESSON_TYPE_WEIGHT 四值在位（error-fix 1.0 / pitfall 0.9 / env-fact 0.8 / preference 0.7）",
      srvSrc.includes('const LESSON_TYPE_WEIGHT = { "error-fix": 1.0, "pitfall": 0.9, "env-fact": 0.8, "preference": 0.7 };'),
    );
    ck.ok("INJ-02 常量锁登记面：v0.9.x.md 登记 INJECT_MIN_SCORE=0.39（防漂移第二文件，v0.9 W1 起改钉）", docSrc.includes("INJECT_MIN_SCORE=0.39"), ASSERT_DOC);
  } finally {
    s2.close();
  }
}

/* ============ 场景 2b：THR-01（v0.9 W1，root r-thr01，C5 阈值落值 0.40→0.39 三行对照） ============ */
{
  const R2b = subRoot("r-thr01");
  const nowIso2b = new Date().toISOString();
  // MID 判别行：score≈0.395 ∈ [0.39, 0.40) —— 0.39 口径下入选，0.40 口径下必被排除
  //（新值生效的行为判别行）。score=0.6×exp(-days/30)=0.395 → days=30×ln(0.6/0.395)≈12.56。
  const midDays2b = 30 * Math.log(0.6 / 0.395);
  const midIso2b = new Date(Date.now() - midDays2b * 86400000).toISOString();
  const oldIso2b = new Date(Date.now() - 40 * 86400000).toISOString();
  const baseRow2b = {
    v: 1,
    ts: nowIso2b,
    mission_id: null,
    worker: "t",
    type: "pitfall",
    trigger: "",
    lesson: "",
    fix: "",
    confidence: 0.6,
    hits: 1,
    status: "active",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
  };
  // 三行 normKey 互异（trigger/fix 各带专属 token）：排除面只归阈值，与 normKey 去重正交。
  const rows2b = [
    { ...baseRow2b, id: "l-20260101-thr001", trigger: "THRFRESH 阈值新鲜行", fix: "THRFRESH 新鲜修正", updated_at: nowIso2b },
    { ...baseRow2b, id: "l-20260101-thr002", trigger: "THRMID 阈值判别行", fix: "THRMID 判别修正", updated_at: midIso2b },
    { ...baseRow2b, id: "l-20260101-thr003", trigger: "THROLD 阈值衰老行", fix: "THROLD 衰老修正", updated_at: oldIso2b },
  ];
  fs.mkdirSync(path.join(R2b, "memory"), { recursive: true });
  fs.writeFileSync(path.join(R2b, "memory", "lessons.jsonl"), rows2b.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const s2b = startServer({ root: R2b });
  try {
    await s2b.call("context_pack", { mission_id: "m-thr01", title: "C5 落值包", task: "THRFRESH THRMID THROLD 阈值落值对照验证" });
    const packThr = readPack(R2b, "m-thr01");
    ck.ok(
      "THR-01a 新值生效判别行：score≈0.395∈[0.39,0.40) 的 MID 行入选（0.40 口径下必被排除——A-v090-THR-01 行为对照）",
      Boolean(packThr) && packThr.includes("## LESSONS") && packThr.includes("l-20260101-thr002"),
      packThr && packThr.split("\n").filter((l) => l.startsWith("- [")),
    );
    ck.ok(
      "THR-01b 落门/入选对照更新（0.39 口径）：FRESH 0.60 入选、OLD≈0.158<0.39 落门不渲染",
      Boolean(packThr) && packThr.includes("l-20260101-thr001") && !packThr.includes("l-20260101-thr003"),
      packThr && packThr.split("\n").filter((l) => l.startsWith("- [")),
    );
    // 推导注记 v0.9 复算版在案（server.mjs 常量区注释：P25=0.4583 → ×0.85 ≈0.3895 → 圆整 0.39，界 [0.30,0.50]）
    const srvSrc2b = fs.readFileSync(DEFAULT_SERVER, "utf8");
    ck.ok(
      "THR-01c 推导注记 v0.9 复算版在案：P25=0.4583 + ×0.85 + 圆整 0.39 + 界 [0.30, 0.50] + v0.9 recheck 锚",
      srvSrc2b.includes("P25=0.4583") && srvSrc2b.includes("× 0.85") && srvSrc2b.includes("round 0.39") && srvSrc2b.includes("[0.30, 0.50]") && /v0\.9 recheck/i.test(srvSrc2b),
      null,
    );
  } finally {
    s2b.close();
  }
}

/* ============ 场景 3：INJ-04 / INJ-05（root r-inj04，board 预种 mission） ============ */
{
  const R3 = subRoot("r-inj04");
  const mids = ["m-d1", "m-d2", "m-d3", "m-d4", "m-d5", "m-d6", "m-n1", "m-n2", "m-n3"];
  writeBoardSeed(R3, mids.map((id) => blankMission({ id, title: "INJ04 " + id })));
  const s3 = startServer({ root: R3 });
  try {
    const addX = await s3.call("lessons", { action: "add", type: "pitfall", trigger: "MISSPROBE 误导教训", fix: "不要照做" });
    const xid = resultText(addX).id;
    const rowOf = () => readLessons(R3).find((l) => l.id === xid);

    // ---- INJ-05：守卫兼容（无 lesson_refs / 非数组 / 无意义 kind）→ 整体忽略零变化；
    //      响应面按 CR-04 条件键纪律——零降权时 lessons_demoted 等键整体不出现
    const rNone = resultText(await s3.call("report", { mission_id: "m-n1", worker: "w5", kind: "blocked", question: "q?", summary: "无 refs" }));
    let row = rowOf();
    ck.ok(
      "INJ-05a 无 lesson_refs 的 blocked report → 零降权零变化（条件键不出现）",
      !("lessons_demoted" in rNone) && !("lessons_refs_retired" in rNone) && !("lessons_refs_note" in rNone) && approx2(row.confidence) === 0.6 && Array.isArray(row.counter_refs) && row.counter_refs.length === 0,
      { respKeys: Object.keys(rNone), row: row && { conf: row.confidence, cr: row.counter_refs } },
    );
    const rBad = resultText(await s3.call("report", { mission_id: "m-n2", worker: "w5", kind: "blocked", question: "q?", summary: "非数组 refs", lesson_refs: xid }));
    row = rowOf();
    ck.ok(
      "INJ-05b lesson_refs 非数组（Array.isArray 守卫）→ 整体忽略",
      !("lessons_demoted" in rBad) && approx2(row.confidence) === 0.6 && row.counter_refs.length === 0,
      { respKeys: Object.keys(rBad), row: row && { conf: row.confidence, cr: row.counter_refs } },
    );
    const rDone = resultText(await s3.call("report", { mission_id: "m-n3", worker: "w5", kind: "done", summary: "done 携带无意义", lesson_refs: [xid] }));
    row = rowOf();
    ck.ok(
      "INJ-05c done 携带 lesson_refs（仅 blocked/question 有意义）→ 忽略",
      !("lessons_demoted" in rDone) && approx2(row.confidence) === 0.6 && row.counter_refs.length === 0,
      { respKeys: Object.keys(rDone), row: row && { conf: row.confidence, cr: row.counter_refs } },
    );

    // ---- INJ-04：blocked 回引降权闭环（5 个 mission 逐次 −0.1 至触底 → housekeep 退役）
    const expectConf = [0.5, 0.4, 0.3, 0.2];
    for (let i = 1; i <= 4; i++) {
      const r = resultText(await s3.call("report", { mission_id: `m-d${i}`, worker: "w4", kind: "blocked", question: "q?", summary: `回引 ${i}`, lesson_refs: [xid] }));
      row = rowOf();
      ck.ok(
        `INJ-04a 第 ${i} 次回引：confidence −0.1（=${expectConf[i - 1]}）+ counter_refs 记 mission m-d${i}`,
        r.lessons_demoted === 1 && row.status === "active" && approx2(row.confidence) === expectConf[i - 1] && row.counter_refs.includes(`m-d${i}`) && row.counter_refs.length === i,
        { resp: r.lessons_demoted, row: row && { conf: row.confidence, cr: row.counter_refs, st: row.status } },
      );
    }
    const r5 = resultText(await s3.call("report", { mission_id: "m-d5", worker: "w4", kind: "blocked", question: "q?", summary: "回引触底", lesson_refs: [xid] }));
    row = rowOf();
    ck.ok(
      "INJ-04b 触底（confidence=0.1 下限）+ ≥2 mission 回引 → housekeep 置 retired note=auto: lesson misses",
      r5.lessons_demoted === 1 && r5.lessons_refs_retired === 1 && row.status === "retired" && row.note === "auto: lesson misses" && approx2(row.confidence) === 0.1 && row.counter_refs.length === 5,
      { resp: { d: r5.lessons_demoted, ret: r5.lessons_retired }, row: row && { conf: row.confidence, cr: row.counter_refs, st: row.status, note: row.note } },
    );

    // ---- INJ-04 补腿：未知 id 跳过带注（不炸 blocked report）；已触底条目 floor 不再下探
    const rUk = resultText(
      await s3.call("report", { mission_id: "m-d6", worker: "w4", kind: "blocked", question: "q?", summary: "含未知 id", lesson_refs: [xid, "l-19700101-000000"] }),
    );
    row = rowOf();
    ck.ok(
      "INJ-04c 未知 id 跳过并回注（lessons_refs_note），其余照常降权",
      rUk.lessons_demoted === 1 && !("lessons_refs_retired" in rUk) && typeof rUk.lessons_refs_note === "string" && rUk.lessons_refs_note.includes("l-19700101-000000"),
      { resp: { d: rUk.lessons_demoted, note: rUk.lessons_refs_note } },
    );
    ck.ok(
      "INJ-04d 触底条目再回引：confidence 停在下限 0.1（floor），counter_refs 去重记 m-d6",
      approx2(row.confidence) === 0.1 && row.counter_refs.includes("m-d6"),
      row && { conf: row.confidence, cr: row.counter_refs },
    );
  } finally {
    s3.close();
  }
}

/* ============ 场景 4：INJ-07（死码清理源码静态面，无 server） ============ */
{
  const srvSrc = fs.readFileSync(DEFAULT_SERVER, "utf8");
  const hookSrc = fs.readFileSync(HOOKS_SRC, "utf8");
  ck.ok("INJ-07a server.mjs topLessonsBrief 零命中（死码已删）", !srvSrc.includes("topLessonsBrief"));
  ck.ok("INJ-07b server.mjs BRIEF_TOP_K/BRIEF_MAX_CHARS 零命中（随死码删）", !srvSrc.includes("BRIEF_TOP_K") && !srvSrc.includes("BRIEF_MAX_CHARS"));
  const digestLine = hookSrc.split("\n").find((l) => l.includes("lessons digest"));
  ck.ok("INJ-07c session-start lessons digest 注释无悬空「twin of server.mjs」", Boolean(digestLine) && !digestLine.includes("twin of server.mjs"), digestLine);
  ck.ok("INJ-07d session-start 本地 topLessonsBrief 唯一副本实现仍在（top-3 初始装载不变）", hookSrc.includes("function topLessonsBrief") && hookSrc.includes("const BRIEF_TOP_K = 3"));
}

/* ============ 场景 5：INJ-08（CR-04 性质锁：与 0.7.1 基线逐字节对拍） ============ */
{
  const SCRATCH = subRoot("scratch-baseline");
  let baseline = null;
  try {
    baseline = exportFileFromGit("f0142a8", repoRoot(), "plugins/agent-orchestrator/mcp/server.mjs", SCRATCH);
    ck.ok("INJ-08a 0.7.1 基线导出（git f0142a8）", Boolean(baseline), baseline);
  } catch (e) {
    ck.ok("INJ-08a 0.7.1 基线导出（git f0142a8）", false, String(e));
  }
  if (baseline) {
    // 前置（W2 重跑口径）：0.8 侧随 --memory-root 注入空全端目录环境（无全端库、
    // 无 ORCH.md 临时根）；0.7.1 基线不识别该旗标（parseArgValue 只寻 --root，忽略）。
    const T71 = subRoot("t71");
    const T80 = subRoot("t80");
    const MEM80 = subRoot("mem80-empty");
    // 归一化：token（两代 server 各自随机）+ lessonLine id 段（v0.8 唯一预期增量，
    // 替换为空串后与 0.7.1 的 `[type]` 形状逐字节对齐——增量本体由 INJ-08c 钉死）
    // + W4 PO 案 A 激进重建（2026-10-24，A-v0110-PO-W4，先例 v0.6 裁决 A）：缺省模板
    //   CONTRACT 规则块/围栏节头/阻塞处置句变字——新旧两形各自归一为规范形（预期增量掩码；
    //   理由逐条见 v0.11.x.md §0；新文案本体由 A-v0110-PO-W4-01/02 静态钉）。
    // + v1.1 W4（A1/Q5a，A-v110-W4-A1-06）：CONTRACT 节头括注「派发 prompt 头部→尾块」
    //   措辞级字节变更——同型掩码先行（DESIGN §6.1/§6.2）。
    const norm = (s) =>
      String(s)
        .replace(/\[token\] [0-9a-f]{4,32}/g, "[token] X")
        .replace(/·l-\d{8}-[0-9a-f]{6}/g, "")
        .replace(/进度与结果一律用 (mcp__plugin_agent-orchestrator_orch__report) 上报[；。]/g, "REPORT-CHANNEL $1")
        .replace(/kind ∈ \{milestone, blocked, question, done\}。\nsummary ≤ 200 字。\nkind=done 必带 artifacts 路径。/g, "REPORT-KIND summary artifacts")
        .replace(/kind ∈ \{milestone, blocked, question, done\}；summary ≤ 200 字；done 必带 artifacts 路径[^\n]*/g, "REPORT-KIND summary artifacts")
        .replace(/受阻\/目标矛盾\/必败门禁：立即 report\(kind=blocked, question=…\)[^\n]*/g, "RULES-BLOCKED")
        .replace(/也出现在派发 prompt (?:头部|尾块)/g, "也出现在派发 prompt 尾块")
        .replace(/## CONTEXT（[^）]*）/g, "## CONTEXT 节头")
        .replace(/## LESSONS（[^）]*）/g, "## LESSONS 节头");
    const s71 = startServer({ serverPath: baseline, root: T71 });
    const s80 = startServerX({ root: T80, args: ["--memory-root", MEM80] });
    try {
      // —— 子例 A：空库（无 LESSONS 节）逐字节
      const argsA = { mission_id: "m-byte", title: "字节对拍", task: "字节对拍回归任务", read_first: ["docs/a.md"], rules: ["R1"], upstream_context: "上游对拍行" };
      await s71.call("context_pack", argsA);
      await s80.call("context_pack", argsA);
      const pA71 = readPack(T71, "m-byte");
      const pA80 = readPack(T80, "m-byte");
      ck.ok("INJ-08b 空库 context_pack 与 0.7.1 逐字节一致（token 归一化）", Boolean(pA71) && Boolean(pA80) && norm(pA71) === norm(pA80));

      // —— 子例 B：单条命中 lesson——唯一预期增量 = lessonLine id 段
      const addB = { action: "add", type: "pitfall", trigger: "BYTEPROBE 对拍触发词", fix: "对拍修正动作" };
      await s71.call("lessons", addB);
      await s80.call("lessons", addB);
      const argsB = { mission_id: "m-byte2", title: "字节对拍二", task: "BYTEPROBE 对拍任务" };
      await s71.call("context_pack", argsB);
      await s80.call("context_pack", argsB);
      const pB71 = readPack(T71, "m-byte2");
      const pB80 = readPack(T80, "m-byte2");
      ck.ok(
        "INJ-08c 命中场景：0.7.1 渲染无 id 段、v0.8 渲染含 id 段（预期增量恰为 id）",
        Boolean(pB71) && Boolean(pB80) && pB71.includes("- [pitfall] 触发：") && !pB71.includes("·l-") && pB80.includes("- [pitfall·l-"),
      );
      ck.ok("INJ-08d 命中场景归一化 id 段后与 0.7.1 逐字节一致（CR-04 性质锁）", Boolean(pB71) && Boolean(pB80) && norm(pB71) === norm(pB80));
    } finally {
      s71.close();
      s80.close();
    }
  }
}

/* ============ 场景 6：SYNC-01..05（§4 ver 同步捎带，root r-sync，缺省 temp 重定向） ============ */
{
  const R6 = subRoot("r-sync");
  const orchMd = path.join(R6, "ORCH.md"); // §4.1：<存储根>/ORCH.md
  const s6 = startServer({ root: R6 });
  try {
    // 原始 result 访问通道（orch_memory 挂在 JSON-RPC result 顶层，content 之外）
    const rawCall = (name, args) => s6.request("tools/call", { name: PRE + name, arguments: args });

    // ---- SYNC-01a：文件不存在 → 不附且基线=absent
    let r = await rawCall("lessons", { action: "list" });
    ck.ok(
      "SYNC-01a 进程首次调用且 ORCH.md 不存在 → 响应无 orch_memory 键（基线=absent）",
      r.result && !("orch_memory" in r.result),
      r.result && Object.keys(r.result),
    );

    // ---- SYNC-01b：文件出现 → 首次调用附 initial 全文（ver 从头部解析）
    fs.writeFileSync(
      orchMd,
      "<!-- orch-memory ver=1 updated=2026-10-22T08:00:00.000Z -->\n# ORCH.md — 主控记忆\n## 常驻\n- SYNC1PROBE 初始装载行\n",
    );
    r = await rawCall("lessons", { action: "list" });
    const om1 = r.result && r.result.orch_memory && r.result.orch_memory.orch_md;
    ck.ok(
      "SYNC-01b 出现后首次调用附 orch_md reason=initial + 全文 + truncated:false",
      Boolean(om1) && om1.reason === "initial" && om1.truncated === false && typeof om1.content === "string" && om1.content.includes("SYNC1PROBE 初始装载行") && om1.bytes > 0,
      om1 && { reason: om1.reason, trunc: om1.truncated, bytes: om1.bytes },
    );
    ck.ok(
      "SYNC-01c ver/updated_at 从 orch-memory 头部解析透传（ver=1）",
      Boolean(om1) && om1.ver === 1 && om1.updated_at === "2026-10-22T08:00:00.000Z",
      om1 && { ver: om1.ver, updated_at: om1.updated_at },
    );

    // ---- SYNC-03：stat 未变 → 无 orch_memory 键（零开销路径）
    r = await rawCall("lessons", { action: "list" });
    ck.ok("SYNC-03 stat 未变 → 响应无 orch_memory 键", r.result && !("orch_memory" in r.result), r.result && Object.keys(r.result));

    // ---- SYNC-02：外部改写（bytes 变化，V7-01 双因子）→ changed + ver 递增 + 新全文
    // v0.10 G2 时序余量（CACHE-06a 同族，实红面）：NTFS mtime 时钟粒度本机实测 ~15.6ms，
    // 同尺寸改写若与基线同粒度，server 侧 bytes+mtimeMs 双因子判不出 changed
    //（orchMdAttachment「residual race accepted」注记的实际触发面；直写探针复现
    //  9/15 漏检，加 100ms 后 0/15）。只等 mtime 时钟跨跳，断言主句零改动。
    await new Promise((res) => setTimeout(res, 100));
    fs.writeFileSync(
      orchMd,
      "<!-- orch-memory ver=2 updated=2026-10-22T09:00:00.000Z -->\n# ORCH.md — 主控记忆\n## 常驻\n- SYNC2PROBE 改写后的行\n",
    );
    r = await rawCall("lessons", { action: "list" });
    const om2 = r.result && r.result.orch_memory && r.result.orch_memory.orch_md;
    ck.ok(
      "SYNC-02 外部改写 → reason=changed + ver 递增（=2）+ 新全文替换",
      Boolean(om2) && om2.reason === "changed" && om2.ver === 2 && om2.content.includes("SYNC2PROBE 改写后的行") && !om2.content.includes("SYNC1PROBE"),
      om2 && { reason: om2.reason, ver: om2.ver },
    );

    // ---- SYNC-04：超 120 行 → 截断 + truncated:true + 提示行
    const longDoc = [
      "<!-- orch-memory ver=3 updated=2026-10-22T10:00:00.000Z -->",
      "# ORCH.md",
      ...Array.from({ length: 130 }, (_, i) => `- 行${i + 1} SYNC4PROBE`),
    ].join("\n");
    fs.writeFileSync(orchMd, longDoc + "\n");
    r = await rawCall("lessons", { action: "list" });
    const om4 = r.result && r.result.orch_memory && r.result.orch_memory.orch_md;
    const om4Lines = om4 && om4.content ? om4.content.split("\n") : [];
    ck.ok(
      "SYNC-04 超 120 行 → truncated:true + 内容截到帽内（120 行+提示 ≤121）+ 提示行在案 + 帽外行不出现",
      Boolean(om4) && om4.truncated === true && om4Lines.length <= 121 && om4Lines.some((l) => l.includes("超帽")) && om4.content.includes("行118 SYNC4PROBE") && !om4.content.includes("行130 SYNC4PROBE"),
      om4 && { trunc: om4.truncated, lines: om4Lines.length },
    );

    // ---- SYNC-05：删除 → removed 恰一次，随后安静
    fs.unlinkSync(orchMd);
    r = await rawCall("lessons", { action: "list" });
    const om5 = r.result && r.result.orch_memory && r.result.orch_memory.orch_md;
    ck.ok(
      "SYNC-05a 文件删除 → removed 捎带恰一次（无 content/ver/bytes/truncated 键）",
      Boolean(om5) && om5.reason === "removed" && !("content" in om5) && !("ver" in om5) && !("bytes" in om5) && !("truncated" in om5),
      om5,
    );
    r = await rawCall("lessons", { action: "list" });
    ck.ok("SYNC-05b removed 后归于安静（再调用无 orch_memory）", r.result && !("orch_memory" in r.result));
  } finally {
    s6.close();
  }
}

/* ============ 场景 7：GLEAN-01（§6.1 门槛真值表+成本排序，root r-glean1） ============ */
{
  const R7 = subRoot("r-glean1");
  const MEM7 = path.join(R7, "orchestrator-memory"); // 临时根缺省重定向落点
  const cfg7 = path.join(MEM7, "glean.cfg.json");
  const lib7 = path.join(R7, "memory", "lessons.jsonl");
  const lock7 = path.join(MEM7, "glean-lock.json");
  const brief7 = path.join(MEM7, "glean-brief.json");
  const pack7 = path.join(MEM7, "glean-pack.md");
  const g1Row = (i) => ({
    v: 1,
    id: `l-20260101-g1${String(i).padStart(2, "0")}`,
    ts: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    mission_id: null,
    worker: "t",
    type: "pitfall",
    trigger: `G1PROBE 触发${i}`,
    lesson: "",
    fix: `G1PROBE 修正${i}`,
    confidence: 0.9,
    hits: 5,
    status: "active",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
  });
  const s7 = startServer({ root: R7 });
  try {
    const rawCall = (name, args) => s7.request("tools/call", { name: PRE + name, arguments: args });
    // 臂 1：时间门不过（done 锁 finished_at=now，idle_hours=9999）∧ 事件足（new_events=0）→ 不附不物化
    fs.mkdirSync(MEM7, { recursive: true }); // spawn 竞态防御：不依赖 server 启动侧先建目录
    writeJsonl(lib7, [g1Row(1)]);
    fs.writeFileSync(
      lock7,
      JSON.stringify({ v: 1, state: "done", pid: 1, finished_at: new Date().toISOString(), watermarks: { global_lines: 0, projects: {} } }),
    );
    fs.writeFileSync(cfg7, JSON.stringify({ idle_hours: 9999, new_events: 0 }));
    let r = await rawCall("lessons", { action: "list" });
    ck.ok(
      "GLEAN-01a 时间门不过 → 无 glean 信号且不物化 brief（事件条件已满足也不放行）",
      r.result && !("orch_memory" in r.result) && !fs.existsSync(brief7),
      { respKeys: r.result && Object.keys(r.result), brief: fs.existsSync(brief7) },
    );
    // G12（M10，A-v0110-M10-01）：无 due → board/list 无 glean_due 键（零字节差缺省，
    // P9-01 后半句同体例）
    const bl17 = await s7.call("board", { action: "list" });
    ck.ok("G12-c 时间门不过 → board/list 无 glean_due 键", bl17.json && !("glean_due" in bl17.json), bl17.json && Object.keys(bl17.json));
    // 臂 2：时间门过（idle_hours=0）∧ 事件门不过（1 < 99）→ 不附不物化
    fs.writeFileSync(cfg7, JSON.stringify({ idle_hours: 0, new_events: 99 }));
    r = await rawCall("lessons", { action: "list" });
    ck.ok(
      "GLEAN-01b 事件门不过 → 无 glean 信号且不物化 brief",
      r.result && !("orch_memory" in r.result) && !fs.existsSync(brief7),
      { respKeys: r.result && Object.keys(r.result), brief: fs.existsSync(brief7) },
    );
    const bl27 = await s7.call("board", { action: "list" });
    ck.ok("G12-d 事件门不过 → board/list 无 glean_due 键", bl27.json && !("glean_due" in bl27.json), bl27.json && Object.keys(bl27.json));
    // glean3（A-v0110-GLEAN3-01）：无 due（时间门/事件门两腿均未放行）→ pack 同样不物化
    // （零字节差缺省，P9-01 体例；GLEAN-01a/01b 已证 brief 不落盘，本条补 pack 面）
    ck.ok("G13-h 无 due（时间门/事件门两腿）→ 不物化 glean-pack.md（零字节差缺省）", !fs.existsSync(pack7), fs.existsSync(pack7));
    // 成本排序（决议 D4：先查时间→数事件→抢锁）——源码序机械断言
    // （锚点取语句级：解构行含裸 lockBusy/countEvents 标识符，不能用裸名匹配）
    const srvSrc7 = fs.readFileSync(DEFAULT_SERVER, "utf8");
    const gateSrc = srvSrc7.slice(srvSrc7.indexOf("function evaluateGleanGate"), srvSrc7.indexOf("function materializeGleanBrief"));
    const iTime = gateSrc.indexOf("if (!(idleH > Number(cfg.idle_hours)))");
    const iEvents = gateSrc.indexOf("const events = countEvents()");
    const iLock = gateSrc.indexOf('if (lockBusy) return');
    ck.ok(
      "GLEAN-01c 门槛纯函数成本排序（源码序）：时间比较 < 事件计数 < 锁仲裁",
      iTime >= 0 && iEvents > iTime && iLock > iEvents,
      { iTime, iEvents, iLock },
    );
  } finally {
    s7.close();
  }
}

/* ============ 场景 8：GLEAN-02 + GLEAN-04（due 信号与 brief 形状 + busy 臂，root r-glean2） ============ */
{
  const R8 = subRoot("r-glean2");
  const MEM8 = path.join(R8, "orchestrator-memory");
  const brief8 = path.join(MEM8, "glean-brief.json");
  const pack8 = path.join(MEM8, "glean-pack.md");
  const lock8 = path.join(MEM8, "glean-lock.json");
  fs.mkdirSync(MEM8, { recursive: true });
  fs.writeFileSync(path.join(MEM8, "glean.cfg.json"), JSON.stringify({ idle_hours: 0, new_events: 1 }));
  writeJsonl(path.join(R8, "memory", "lessons.jsonl"), [
    {
      v: 1,
      id: "l-20260101-g2a001",
      ts: "2026-01-01T00:00:00.000Z",
      // updated_at 取当下：防 housekeep 衰减退役把行转 retired、扰动 brief counts 断言
      updated_at: new Date().toISOString(),
      mission_id: null,
      worker: "t",
      type: "pitfall",
      trigger: "G2PROBE 触发行",
      lesson: "",
      fix: "G2PROBE 修正行",
      confidence: 0.9,
      hits: 5,
      status: "active",
      refs: [],
      superseded_by: null,
      counter_refs: [],
      note: null,
    },
  ]);
  const s8 = startServer({ root: R8 });
  try {
    const rawCall = (name, args) => s8.request("tools/call", { name: PRE + name, arguments: args });
    // ---- GLEAN-02a：双门过 → due 信号
    let r = await rawCall("lessons", { action: "list" });
    const g2 = r.result && r.result.orch_memory && r.result.orch_memory.glean;
    ck.ok(
      "GLEAN-02a 双门过 → due:true + reason（含 threshold）+ brief_path + lock_state=idle",
      Boolean(g2) && g2.due === true && typeof g2.reason === "string" && g2.reason.includes("threshold") && typeof g2.brief_path === "string" && g2.brief_path.endsWith("glean-brief.json") && g2.lock_state === "idle",
      g2,
    );

    // glean3（A-v0110-GLEAN3-01）：due 信号增 pack_path + 固定包同调用点物化
    ck.ok(
      "G13-a due 信号增 pack_path（endsWith glean-pack.md，glean3 主控零组装面）",
      Boolean(g2) && typeof g2.pack_path === "string" && g2.pack_path.endsWith("glean-pack.md"),
      g2 && g2.pack_path,
    );
    ck.ok("G13-b due 调用后固定包已物化于 pack_path", fs.existsSync(pack8), pack8);

    // G12（M10，A-v0110-M10-01）：due → 信号入 board/list 响应 JSON 内部（G12 修复：
    // 顶层 orch_memory 附件被宿主丢弃，result-content 键可达——P9 duplicate_warning
    // 同机制位；orch_memory 顶层附件保留不拆，GLEAN-02a 即其证明）
    const bl28 = await s8.call("board", { action: "list" });
    const gd2 = bl28.json && bl28.json.glean_due;
    ck.ok(
      "G12-a gate due → board/list 顶层 glean_due {idle_h,events,brief_path}",
      Boolean(gd2) && (gd2.idle_h === null || typeof gd2.idle_h === "number") && Number.isFinite(gd2.events) && gd2.events >= 1 && typeof gd2.brief_path === "string" && gd2.brief_path.endsWith("glean-brief.json"),
      gd2,
    );
    // glean3（A-v0110-GLEAN3-01）：board/list glean_due 同信号面增 pack_path
    ck.ok(
      "G13-c board/list glean_due 增 pack_path（endsWith glean-pack.md）",
      Boolean(gd2) && typeof gd2.pack_path === "string" && gd2.pack_path.endsWith("glean-pack.md"),
      gd2 && gd2.pack_path,
    );
    // 物化保证：删 brief 后仅跑 board/list——同调用的 orch_memory 附件须重新落盘
    fs.rmSync(brief8, { force: true });
    const bl28b = await s8.call("board", { action: "list" });
    const gd2b = bl28b.json && bl28b.json.glean_due;
    ck.ok("G12-b brief 删除后 board/list 重建之（同调用 orch_memory 附件落盘，brief_path 可读）", Boolean(gd2b) && fs.existsSync(brief8), gd2b && gd2b.brief_path);
    // glean3：pack 与 brief 同命运——删除后 board/list 单调用双重建（brief 物化后组合）
    fs.rmSync(pack8, { force: true });
    const bl28c = await s8.call("board", { action: "list" });
    const gd2c = bl28c.json && bl28c.json.glean_due;
    ck.ok(
      "G13-d pack 删除后 board/list 单调用重建（与 brief 同调用点再生，glean_due.pack_path 可读）",
      Boolean(gd2c) && fs.existsSync(pack8) && fs.existsSync(brief8),
      gd2c && gd2c.pack_path,
    );

    // ---- GLEAN-04：brief 物化字段齐全（§9.2 形状）
    const briefOk = fs.existsSync(brief8);
    ck.ok("GLEAN-04a brief 已物化于 brief_path", briefOk, brief8);
    const brief = briefOk ? JSON.parse(fs.readFileSync(brief8, "utf8")) : null;
    const rid8 = fs.readFileSync(path.join(R8, "root-id"), "utf8").trim();
    ck.ok(
      "GLEAN-04b brief 顶层 v/generated_at/root_id/project_path + gate（阈值+measured 实测）",
      Boolean(brief) && brief.v === 1 && typeof brief.generated_at === "string" && brief.root_id === rid8 && normPath(brief.project_path) === normPath(R8) && brief.gate && brief.gate.idle_hours === 0 && brief.gate.new_events === 1 && brief.gate.measured && brief.gate.measured.new_events === 1 && brief.gate.measured.idle_h === null,
      brief && { gate: brief.gate, root_id: brief.root_id },
    );
    ck.ok(
      "GLEAN-04c brief watermarks（0/1 实测行数）+ orchtemp_pending + counts",
      Boolean(brief) && brief.watermarks && brief.watermarks.global_lines === 0 && brief.watermarks.project_lines === 1 && Array.isArray(brief.orchtemp_pending) && brief.orchtemp_pending.length === 0 && brief.counts && brief.counts.active === 1 && brief.counts.candidate === 0,
      brief && { wm: brief.watermarks, counts: brief.counts },
    );
    ck.ok(
      "GLEAN-04d brief projects（含启动登记本行）/orch_md/cfg 字段齐全",
      Boolean(brief) && Array.isArray(brief.projects) && brief.projects.length === 1 && brief.projects[0].root_id === rid8 && brief.orch_md && brief.orch_md.exists === false && brief.cfg && Number(brief.cfg.idle_hours) === 0,
      brief && { projects: brief.projects, orch_md: brief.orch_md },
    );

    // ---- glean3（A-v0110-GLEAN3-01）：固定包模板锚 + brief 逐字内嵌
    const packRaw = fs.readFileSync(pack8, "utf8");
    const briefRaw = fs.readFileSync(brief8, "utf8");
    const G13_PINS = [
      "主控零组装", // 固定物化定性
      "agents/orch-gleaner.md", // persona 路径（READ FIRST）
      "三行契约以派发 prompt 尾块为准", // CONTRACT：server 预物化、token 不入包（v1.1 W4 Q5a）
      "glean-brief 逐字内嵌", // CONTEXT 节定性
      "权威指针勿手写", // 锁纪律：lock 位置=brief.lock_path（模板事故① 根治口径）
      "四态口径", // 候选处置：晋升/合并/退役/保留
      "promote/promote_batch 合并语义走 server", // v1.1 W1 B2：GL-30 括注同步（批入口在案）
      "视图层边界", // ORCH.md/标记区/全端 AGENTS.md 写面
      "日志纪律", // 报告=reports/<ts>-glean.md
      "-glean.md", // 报告命名形
      "≤3 行指针纪律", // Return 面定性
      "KIND=done + 报告路径", // Return 行 1
      "report(kind=blocked, question=需要主控决策的事项)。", // 阻塞处置（WK-8 形）
    ];
    const g13Misses = G13_PINS.filter((n) => !packRaw.includes(n));
    ck.ok("G13-e 固定包模板锚齐全（persona 路径/锁权威指针/四态/视图层/日志/Return ≤3 行 13 钉）", g13Misses.length === 0, g13Misses);
    ck.ok(
      "G13-f brief 逐字内嵌：brief 文件字节 ⊂ pack 字节（brief 物化后组合，read-back 保真）",
      packRaw.includes(briefRaw),
      { briefLen: briefRaw.length, packLen: packRaw.length },
    );
    const g13CtxAt = packRaw.indexOf("## CONTEXT");
    const g13RfAt = packRaw.indexOf("## READ FIRST");
    let g13LockStray = -1;
    for (let scan = 0; ; ) {
      const i = packRaw.indexOf("glean-lock.json", scan);
      if (i < 0) break;
      if (!(i > g13CtxAt && i < g13RfAt)) {
        g13LockStray = i; // 模板行手写锁路径（应只经 brief.lock_path 内嵌出现）
        break;
      }
      scan = i + 1;
    }
    ck.ok(
      "G13-g 包内锁路径只经 CONTEXT brief 内嵌出现（模板行无手写 glean-lock.json，权威指针勿手写）",
      g13CtxAt >= 0 && g13RfAt > g13CtxAt && g13LockStray < 0,
      { ctxAt: g13CtxAt, rfAt: g13RfAt, strayAt: g13LockStray },
    );

    // ---- GLEAN-02b/c：锁 active+活 PID → 只附 lock_state=busy、无 due 键、不重写 brief
    const briefMtime = fs.statSync(brief8).mtimeMs;
    const packMtime = fs.statSync(pack8).mtimeMs;
    fs.writeFileSync(
      lock8,
      JSON.stringify({ v: 1, state: "active", pid: process.pid, started_at: new Date(Date.now() - 5000).toISOString(), finished_at: null, watermarks: { global_lines: 0, projects: {} } }),
    );
    // v0.10 G2：直写锁后经读回屏障取观测（glean 键可见=server 侧已过 mtime/Date.now 时间门）
    const gb = await gleanAfterWrite(rawCall);
    ck.ok(
      "GLEAN-02b 锁 active 活 PID → 只附 lock_state=busy（无 due/brief_path 键）",
      Boolean(gb) && gb.lock_state === "busy" && !("due" in gb) && !("brief_path" in gb),
      gb,
    );
    ck.ok("GLEAN-02c busy 不物化 brief（brief mtime 未被重写）", fs.statSync(brief8).mtimeMs === briefMtime);
    // glean3：busy 零写面同样覆盖 pack（busy 即退，pack 不重写）
    ck.ok("G13-i busy 锁 → pack 不重写（pack mtime 未被重写，零写面）", fs.statSync(pack8).mtimeMs === packMtime, { packMtime, now: fs.statSync(pack8).mtimeMs });
    const bl2b = await s8.call("board", { action: "list" });
    ck.ok("G12-e busy 锁 → board/list 无 glean_due 键（busy 即退）", bl2b.json && !("glean_due" in bl2b.json), bl2b.json && Object.keys(bl2b.json));
  } finally {
    s8.close();
  }
}

/* ============ 场景 9：GLEAN-06（§6.6 名册 + --memory-root 注入，roots r-reg*） ============ */
{
  const R9 = subRoot("r-reg");
  const R9b = subRoot("r-reg-b");
  const M9 = subRoot("mem-reg");
  const reg9 = path.join(M9, "projects.jsonl");
  let firstSeen9 = null;
  const s9a = startServerX({ root: R9, args: ["--memory-root", M9] });
  try {
    await s9a.call("lessons", { action: "list" }); // 首调用确认启动侧副作用已落
    ck.ok(
      "GLEAN-06a --memory-root 注入生效：名册写 M、缺省重定向 <root>/orchestrator-memory 不落",
      fs.existsSync(reg9) && !fs.existsSync(path.join(R9, "orchestrator-memory", "projects.jsonl")),
      { reg: fs.existsSync(reg9), deflected: fs.existsSync(path.join(R9, "orchestrator-memory", "projects.jsonl")) },
    );
    const rows9 = readJsonl(reg9);
    const rid9 = fs.readFileSync(path.join(R9, "root-id"), "utf8").trim();
    ck.ok(
      "GLEAN-06b 启动 upsert 恰一行：root_id/project_path/first_seen/last_seen/server_version 齐全",
      rows9.length === 1 && rows9[0].root_id === rid9 && normPath(rows9[0].project_path) === normPath(R9) && typeof rows9[0].first_seen === "string" && rows9[0].last_seen === rows9[0].first_seen && typeof rows9[0].server_version === "string",
      rows9,
    );
    firstSeen9 = rows9.length === 1 ? rows9[0].first_seen : null;
  } finally {
    s9a.close();
  }
  const s9b = startServerX({ root: R9, args: ["--memory-root", M9] });
  try {
    await s9b.call("lessons", { action: "list" });
    const rows92 = readJsonl(reg9);
    ck.ok(
      "GLEAN-06c 复见原地更新：仍一行（不重复追加）、first_seen 保留、last_seen 不早于首见",
      rows92.length === 1 && rows92[0].first_seen === firstSeen9 && String(rows92[0].last_seen) >= String(firstSeen9),
      rows92,
    );
  } finally {
    s9b.close();
  }
  const s9c = startServerX({ root: R9b, args: ["--memory-root", M9] });
  try {
    await s9c.call("lessons", { action: "list" });
    const rows93 = readJsonl(reg9);
    ck.ok(
      "GLEAN-06d 异 project 新 root → 追加一行（每 root_id 恰一行，16hex 稳定键）",
      rows93.length === 2 && rows93.every((x) => typeof x.root_id === "string" && /^[0-9a-f]{16}$/.test(x.root_id)) && rows93[0].root_id !== rows93[1].root_id,
      rows93.map((x) => x.root_id),
    );
  } finally {
    s9c.close();
  }
  // 带锁源码序断言 + 活 PID 占锁行为腿（best-effort 跳过，不阻塞启动）
  const srvSrc9 = fs.readFileSync(DEFAULT_SERVER, "utf8");
  ck.ok(
    "GLEAN-06e 名册带锁（源码面）：withRegistryLock(upsertProjectRegistry) 启动调用 + .registry.lock + pidAlive 陈旧接管在案",
    srvSrc9.includes("withRegistryLock(upsertProjectRegistry)") && srvSrc9.includes('.registry.lock"') && /function registryLockStale[\s\S]{0,900}?pidAlive/.test(srvSrc9),
    null,
  );
  const busyDir9 = path.join(M9, ".registry.lock");
  fs.mkdirSync(busyDir9, { recursive: true });
  fs.writeFileSync(
    path.join(busyDir9, "owner.json"),
    JSON.stringify({ holder: `pid:${process.pid}`, pid: process.pid, heartbeatAt: new Date().toISOString() }) + "\n",
  );
  const regBefore9 = fs.readFileSync(reg9, "utf8");
  const s9d = startServerX({ root: R9b, args: ["--memory-root", M9] });
  try {
    await s9d.call("lessons", { action: "list" }); // 启动不被锁阻塞，upsert 让空
    ck.ok(
      "GLEAN-06f 锁被活 PID 占有 → 名册零变化（best-effort 跳过）且 server 正常应答",
      fs.readFileSync(reg9, "utf8") === regBefore9,
      null,
    );
  } finally {
    s9d.close();
    fs.rmSync(busyDir9, { recursive: true, force: true });
  }
}

/* ============ 场景 10：GLEAN-03（§6.4/§9.3 归敛锁状态机全腿，root r-glean3） ============ */
{
  const R11 = subRoot("r-glean3");
  const MEM11 = path.join(R11, "orchestrator-memory"); // 临时根缺省重定向落点
  const lock11 = path.join(MEM11, "glean-lock.json");
  const cfg11 = path.join(MEM11, "glean.cfg.json");
  const brief11 = path.join(MEM11, "glean-brief.json");
  const lib11 = path.join(R11, "memory", "lessons.jsonl");
  // 12 行 active（fresh updated_at 防 housekeep 扰动）：缺省 new_events=10 时事件门可过
  const g3Row = (i) => ({
    v: 1,
    id: `l-20260101-g3${String(i).padStart(2, "0")}`,
    ts: "2026-01-01T00:00:00.000Z",
    updated_at: new Date().toISOString(),
    mission_id: null,
    worker: "t",
    type: "pitfall",
    trigger: `G3PROBE 触发${i}`,
    lesson: "",
    fix: `G3PROBE 修正${i}`,
    confidence: 0.9,
    hits: 5,
    status: "active",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
  });
  fs.mkdirSync(MEM11, { recursive: true }); // spawn 竞态防御：不依赖 server 启动侧先建目录
  writeJsonl(lib11, Array.from({ length: 12 }, (_, i) => g3Row(i + 1)));
  const activeLock11 = (pid, startedAtIso) =>
    JSON.stringify({
      v: 1,
      state: "active",
      pid,
      host: "suite",
      root_id: "r11",
      started_at: startedAtIso,
      finished_at: null,
      watermarks: { global_lines: 0, projects: {} },
    });
  const s11 = startServer({ root: R11 });
  try {
    const rawCall = (name, args) => s11.request("tools/call", { name: PRE + name, arguments: args });
    const gleanOf = (r) => r.result && r.result.orch_memory && r.result.orch_memory.glean;
    fs.writeFileSync(cfg11, JSON.stringify({ idle_hours: 0, new_events: 0 }));

    // ---- GLEAN-03a：wx 抢锁原子（§9.3 抢锁第一步；EEXIST=原子互斥，busy 即退的协议面）
    const doc11 = activeLock11(process.pid, new Date().toISOString());
    fs.writeFileSync(lock11, doc11, { flag: "wx" }); // 无锁 → wx 创建成功（gleaner 抢锁）
    let wxThrew = null;
    try {
      fs.writeFileSync(lock11, doc11, { flag: "wx" });
    } catch (e) {
      wxThrew = e && e.code === "EEXIST" ? "EEXIST" : String(e && e.code);
    }
    ck.ok(
      "GLEAN-03a wx 抢锁原子：无锁 wx 创建成功、再抢 EEXIST 拒绝且原锁内容未被破坏",
      fs.readFileSync(lock11, "utf8") === doc11 && wxThrew === "EEXIST",
      { wxThrew },
    );

    // ---- GLEAN-03b：活 PID 占用拒接管（busy 即退——信号抑制，绝不阻塞等待）
    // v0.10 G2：03b..03d2 均为直写锁后的首读，统一走读回屏障（glean 键可见再断言；
    // ENV-06c 配方）。r 自 03e 起复用（03e/03e2/03g 的缺省/句柄面不走屏障）。
    let r;
    const gb3 = await gleanAfterWrite(rawCall);
    ck.ok(
      "GLEAN-03b 活 PID 占用拒接管：锁 active+活 PID → 只附 lock_state=busy 无 due（不拉起第二归敛）",
      Boolean(gb3) && gb3.lock_state === "busy" && !("due" in gb3) && !("brief_path" in gb3),
      gb3,
    );

    // ---- GLEAN-03c：死 PID 回收（active+死 PID → 可接管，gate 放行 due）
    fs.writeFileSync(lock11, activeLock11(999999901, new Date().toISOString())); // 跨平台必死 PID（WS-9 先例值）
    const gc3 = await gleanAfterWrite(rawCall);
    ck.ok(
      "GLEAN-03c 死 PID 回收：active+死 PID → 可接管（lock_state=idle + due 放行）",
      Boolean(gc3) && gc3.lock_state === "idle" && gc3.due === true,
      gc3,
    );

    // ---- GLEAN-03d：绝对过期 1.5h 回收 + cfg.lock_stale_hours 接线
    fs.writeFileSync(lock11, activeLock11(process.pid, new Date(Date.now() - 2 * 3600000).toISOString()));
    const gd3 = await gleanAfterWrite(rawCall);
    ck.ok(
      "GLEAN-03d 绝对过期回收：活 PID ∧ 龄期 2h > 缺省 1.5h → 可接管（due 放行）",
      Boolean(gd3) && gd3.lock_state === "idle" && gd3.due === true,
      gd3,
    );
    fs.writeFileSync(cfg11, JSON.stringify({ idle_hours: 0, new_events: 0, lock_stale_hours: 9999 }));
    const gd32 = await gleanAfterWrite(rawCall);
    ck.ok(
      "GLEAN-03d2 cfg.lock_stale_hours 接线：9999 → 同一把活 PID 锁翻回 busy（阈值可调生效）",
      Boolean(gd32) && gd32.lock_state === "busy" && !("due" in gd32),
      gd32,
    );
    fs.writeFileSync(cfg11, JSON.stringify({ idle_hours: 50, new_events: 0 }));

    // ---- GLEAN-03e：done 态保留且 mtime 双用（finished_at 优先、mtime 兜底）
    const past11 = new Date(Date.now() - 3 * 86400000);
    fs.writeFileSync(
      lock11,
      JSON.stringify({
        v: 1, state: "done", pid: process.pid, host: "suite", root_id: "r11",
        started_at: past11.toISOString(), finished_at: new Date().toISOString(),
        watermarks: { global_lines: 0, projects: {} },
      }),
    );
    fs.utimesSync(lock11, past11, past11); // 文件 mtime 压到 3 天前（先写后压，勿被写回冲掉）
    r = await rawCall("lessons", { action: "list" });
    ck.ok(
      "GLEAN-03e done 态门①读 finished_at（优先于 mtime）：mtime 3 天前但 finished_at=当下 → idle≈0 < 50h 不放行",
      r.result && !("orch_memory" in r.result),
      { respKeys: r.result && Object.keys(r.result) },
    );
    fs.writeFileSync(
      lock11,
      JSON.stringify({
        v: 1, state: "done", pid: process.pid, host: "suite", root_id: "r11",
        started_at: past11.toISOString(), finished_at: null,
        watermarks: { global_lines: 0, projects: {} },
      }),
    );
    fs.utimesSync(lock11, past11, past11);
    r = await rawCall("lessons", { action: "list" });
    const ge32 = gleanOf(r);
    ck.ok(
      "GLEAN-03e2 mtime 兜底（mtime 双用）：done 无 finished_at → mtime 即上次归敛（3 天前 > 50h → due 放行）",
      Boolean(ge32) && ge32.due === true && ge32.lock_state === "idle",
      ge32,
    );
    ck.ok(
      "GLEAN-03e3 done 态保留：server 全程不删不改锁文件（消费=置状态，§6.3/锁红线）",
      fs.existsSync(lock11) && JSON.parse(fs.readFileSync(lock11, "utf8")).state === "done",
      null,
    );

    // ---- GLEAN-03f：两锁不互嵌（§6.4 W3 收口，源码面机械断言）——server 对归敛锁只读
    // 判锁（busy 即退零阻塞）、名册锁短临界区不触归敛锁：异文件异持有者、无锁序环。
    const srvSrc11 = fs.readFileSync(DEFAULT_SERVER, "utf8");
    const gStart11 = srvSrc11.indexOf("function readGleanCfg");
    const gEnd11 = srvSrc11.indexOf("function send(msg)");
    const gleanSlice11 = srvSrc11.slice(gStart11, gEnd11);
    const regSlice11 = srvSrc11.slice(
      srvSrc11.indexOf("function withRegistryLock"),
      srvSrc11.indexOf("/** One registry row per root_id"),
    );
    ck.ok(
      "GLEAN-03f 两锁不互嵌（源码面）：glean 判锁段零 withRootLock/withRegistryLock 调用 + withRegistryLock 函数体零 glean-lock 触碰",
      gStart11 >= 0 && gEnd11 > gStart11 && !gleanSlice11.includes("withRootLock(") && !gleanSlice11.includes("withRegistryLock(") && regSlice11.includes("function withRegistryLock") && !regSlice11.includes("glean-lock"),
      { gStart11, gEnd11 },
    );

    // ---- GLEAN-03g：cfg junk 逐键兜底（W3 任务③ 默认值兜底，经 brief.cfg 端到端观察；
    //      pack_global_section 缺省自 v0.9 W3 C6/HOST-01b 起为 false——用户级注入面复核
    //      结论=存在，全端节改显式 opt-in，junk 回落值随缺省翻转）
    fs.writeFileSync(
      cfg11,
      JSON.stringify({ idle_hours: "abc", new_events: -5, lock_stale_hours: 0, pack_global_section: "nope" }),
    );
    r = await rawCall("lessons", { action: "list" });
    const gg3 = gleanOf(r);
    const briefG3 = fs.existsSync(brief11) ? JSON.parse(fs.readFileSync(brief11, "utf8")) : null;
    ck.ok(
      "GLEAN-03g cfg junk 逐键兜底：idle_hours/new_events/lock_stale_hours/pack_global_section 全回落内建默认（48/10/1.5/false〔v0.9 C6 翻转〕）",
      Boolean(gg3) && gg3.due === true && Boolean(briefG3) && briefG3.cfg.idle_hours === 48 && briefG3.cfg.new_events === 10 && briefG3.cfg.lock_stale_hours === 1.5 && briefG3.cfg.pack_global_section === false,
      briefG3 && briefG3.cfg,
    );
  } finally {
    s11.close();
  }
}

/* ============ 场景 11：GLEAN-05（§5 stage 写入形状与 ORCHTEMP 候选流转，root r-stage1） ============ */
{
  const R12 = subRoot("r-stage1");
  const MEM12 = path.join(R12, "orchestrator-memory");
  const brief12 = path.join(MEM12, "glean-brief.json");
  fs.mkdirSync(MEM12, { recursive: true });
  // 门槛全开（never gleaned → idle ∞ > 0；new_events=0）→ 任意调用即 due，供 orchtemp_pending 流转观察
  fs.writeFileSync(path.join(MEM12, "glean.cfg.json"), JSON.stringify({ idle_hours: 0, new_events: 0 }));
  const s12 = startServer({ root: R12 });
  try {
    const rawCall = (name, args) => s12.request("tools/call", { name: PRE + name, arguments: args });
    // ---- GLEAN-05a/b/c：写入形状（source=orchestrator/candidate/conf=0/hits=0）
    const st51 = await s12.call("lessons", {
      action: "stage",
      type: "env-fact",
      trigger: "ST5TRIG 触发一\n第二行",
      fix: "ST5FIX 修正一",
      lesson: "ST5 单句教训",
      mission_id: "m-stage5",
      note: "pin: AGENTS.md",
    });
    const st51j = resultText(st51);
    ck.ok(
      "GLEAN-05a stage 响应：ok:true + 新 id + status=candidate + source=orchestrator",
      st51.isError !== true && st51j.ok === true && /^l-\d{8}-[0-9a-f]{6}$/.test(String(st51j.id)) && st51j.status === "candidate" && st51j.source === "orchestrator",
      st51j,
    );
    const row51 = readLessons(R12).find((l) => l.id === st51j.id);
    ck.ok(
      "GLEAN-05b 落库形状：source=orchestrator/status=candidate/confidence=0/hits=0/scope=project/worker=coordinator + note 摆放提示 + refs=[mission]",
      Boolean(row51) && row51.source === "orchestrator" && row51.status === "candidate" && row51.confidence === 0 && row51.hits === 0 && row51.scope === "project" && row51.worker === "coordinator" && row51.note === "pin: AGENTS.md" && Array.isArray(row51.refs) && row51.refs[0] === "m-stage5",
      row51,
    );
    ck.ok(
      "GLEAN-05c escape 先于截断：trigger 换行写为 ␤（写侧纪律，库保持单行性质）",
      Boolean(row51) && row51.trigger.includes("␤") && !row51.trigger.includes("\n"),
      row51 && row51.trigger,
    );

    // ---- GLEAN-05d/e：type 缺省 pitfall（§5 签名无 type，报告候选同款）；坏 type/空 trigger 严格报错
    const st52 = await s12.call("lessons", { action: "stage", trigger: "ST5TRIG2 缺省类型", fix: "ST5FIX2" });
    const row52 = readLessons(R12).find((l) => String(l.trigger || "").includes("ST5TRIG2"));
    ck.ok(
      "GLEAN-05d type 缺省 pitfall（§5 签名无 type，沿报告候选先例）",
      st52.isError !== true && Boolean(row52) && row52.type === "pitfall" && row52.source === "orchestrator",
      row52 && { type: row52.type, source: row52.source },
    );
    const st5Bad = await s12.call("lessons", { action: "stage", type: "nope", trigger: "X5", fix: "Y5" });
    const st5Empty = await s12.call("lessons", { action: "stage", trigger: "   ", fix: "Y5" });
    ck.ok(
      "GLEAN-05e 坏 type / 空 trigger → isError（add 级严格，§5「沿 add 语义」）",
      st5Bad.isError === true && st5Empty.isError === true,
      { bad: st5Bad.text.slice(0, 80), empty: st5Empty.text.slice(0, 80) },
    );

    // ---- GLEAN-05g：不参与注入——纯 stage 库（尚无 active）→ LESSONS 节整体不出现（CR-04 回归性确认，§5）
    await s12.call("context_pack", { mission_id: "m-stage5-pack", title: "纯暂存包", task: "ST5TRIG ST5TRIG2 命中词齐全" });
    const pack52 = readPack(R12, "m-stage5-pack");
    ck.ok(
      "GLEAN-05g candidate 不参与注入：纯 stage 库 pack 无 LESSONS 节（无需额外过滤，整节不出现）",
      Boolean(pack52) && !pack52.includes("## LESSONS"),
      pack52 && pack52.split("\n").filter((l) => l.startsWith("## ")),
    );

    // ---- GLEAN-05f：不做 findMergeTarget——同键 active 在库仍独立成条（归并是归敛消费时的事）
    await s12.call("lessons", { action: "add", type: "pitfall", trigger: "ST5MERGE 合并键触发", fix: "ST5MERGE 合并键修正" });
    const st5Before = readLessons(R12).find((l) => l.status === "active" && String(l.trigger || "").includes("ST5MERGE"));
    const st53 = await s12.call("lessons", { action: "stage", type: "pitfall", trigger: "ST5MERGE 合并键触发", fix: "ST5MERGE 合并键修正" });
    const st5After = readLessons(R12).find((l) => l.status === "active" && String(l.trigger || "").includes("ST5MERGE"));
    const st53Row = readLessons(R12).find((l) => l.id === resultText(st53).id);
    ck.ok(
      "GLEAN-05f 不合并：active 原 hits/confidence 不动 + stage 独立成 candidate 新条（同键不归并）",
      st53.isError !== true && st5After.hits === st5Before.hits && st5After.confidence === st5Before.confidence && Boolean(st53Row) && st53Row.status === "candidate" && st53Row.source === "orchestrator",
      { before: st5Before && { hits: st5Before.hits, conf: st5Before.confidence }, after: st5After && { hits: st5After.hits, conf: st5After.confidence }, staged: st53Row && st53Row.status },
    );
    // token 命中的 staged 条目仍不渲染（active 同键渲染、candidate 兄弟条被排除）
    await s12.call("context_pack", { mission_id: "m-stage5-pack2", title: "同键对照包", task: "ST5MERGE 合并键触发" });
    const pack522 = readPack(R12, "m-stage5-pack2");
    ck.ok(
      "GLEAN-05g2 staged 条不渲染：active 同键入选（LESSONS 节在）而 staged 兄弟条 id 不出现",
      Boolean(pack522) && pack522.includes("## LESSONS") && pack522.includes(String(st5Before.id)) && !pack522.includes(String(resultText(st53).id)) && !pack522.includes(String(st51j.id)),
      pack522 && pack522.split("\n").filter((l) => l.startsWith("- [")),
    );

    // ---- GLEAN-05h：ORCHTEMP 候选流转——due brief orchtemp_pending 收录 stage 条、不含 report 候选
    await s12.call("board", { action: "upsert", mission: { id: "m-stage5-rep", title: "对照上报 mission" } });
    await s12.call("report", {
      mission_id: "m-stage5-rep",
      worker: "w-stage5",
      kind: "done",
      summary: "对照候选上报",
      lessons: [{ type: "pitfall", trigger: "ST5REP 对照候选触发", fix: "ST5REP 修正" }],
    });
    const repRow52 = readLessons(R12).find((l) => String(l.trigger || "").includes("ST5REP"));
    let r52 = await rawCall("lessons", { action: "list" });
    const due52 = r52.result && r52.result.orch_memory && r52.result.orch_memory.glean;
    const brief52 = fs.existsSync(brief12) ? JSON.parse(fs.readFileSync(brief12, "utf8")) : null;
    ck.ok(
      "GLEAN-05h ORCHTEMP 流转：due 放行且 brief.orchtemp_pending 恰含 stage 条（source=orchestrator 专属过滤，report 候选不入）",
      Boolean(due52) && due52.due === true && Boolean(brief52) && Array.isArray(brief52.orchtemp_pending) && brief52.orchtemp_pending.includes(st51j.id) && brief52.orchtemp_pending.includes(resultText(st52).id) && Boolean(repRow52) && !brief52.orchtemp_pending.includes(repRow52.id),
      { due: due52, pending: brief52 && brief52.orchtemp_pending, repRow: repRow52 && repRow52.id },
    );

    // ---- GLEAN-05i/j：retire 消费=置状态，内容不变（红线①），消费后退出 ORCHTEMP
    const st51Before = readLessons(R12).find((l) => l.id === st51j.id);
    const ret52 = await s12.call("lessons", {
      action: "retire",
      id: st51j.id,
      reason: "glean: → ORCH.md §常驻 #3",
    });
    const st51After = readLessons(R12).find((l) => l.id === st51j.id);
    ck.ok(
      "GLEAN-05i retire 消费=置状态：status=retired + note=视图指针，trigger/fix/lesson/type 逐字节不变（红线①不删内容）",
      ret52.isError !== true && st51After.status === "retired" && st51After.note === "glean: → ORCH.md §常驻 #3" && st51After.trigger === st51Before.trigger && st51After.fix === st51Before.fix && st51After.lesson === st51Before.lesson && st51After.type === st51Before.type,
      { before: st51Before && { trigger: st51Before.trigger, fix: st51Before.fix }, after: st51After && { status: st51After.status, note: st51After.note } },
    );
    r52 = await rawCall("lessons", { action: "list" });
    const brief522 = JSON.parse(fs.readFileSync(brief12, "utf8"));
    ck.ok(
      "GLEAN-05j 消费后流转：orchtemp_pending 退出该 id 且条目仍在库（留存非删除）",
      Array.isArray(brief522.orchtemp_pending) && !brief522.orchtemp_pending.includes(st51j.id) && Boolean(readLessons(R12).find((l) => l.id === st51j.id)),
      brief522.orchtemp_pending,
    );

    // ---- GLEAN-05k：§9.4 工具 schema 描述行逐字在案 + action 枚举含 stage/promote_batch（W3 任务①收口；v1.1 W1 B2 扩 promote_batch）
    //（描述行内 source="orchestrator" 在 server.mjs 字面量中带 \" 转义—— grep 取无反斜杠的
    //  首尾两个逐字片段 + 枚举行，三段同钉）
    const srvSrc52 = fs.readFileSync(DEFAULT_SERVER, "utf8");
    ck.ok(
      "GLEAN-05k §9.4 逐字稿落 schema：stage 描述行首尾片段逐字在案 + action 枚举含 stage/promote_batch",
      srvSrc52.includes("stage: 主控随手暂存（ORCHTEMP）。写 source=") &&
        srvSrc52.includes("；不合并不注入；由归敛代理消费（置 retired+视图层落笔）。trigger/fix 必填。") &&
        srvSrc52.includes('["list", "add", "promote", "promote_batch", "retire", "stage"]'),
      null,
    );
  } finally {
    s12.close();
  }
}

/* ============ 场景 11b：GLEAN-05l..q（v1.1 W1 §5.1 promote_batch 事务化，root r-batch1） ============ */
{
  const R16 = subRoot("r-batch1");
  const lib16 = path.join(R16, "memory", "lessons.jsonl");
  const gLib16 = path.join(R16, "orchestrator-memory", "memory", "lessons.jsonl");
  const now16 = new Date().toISOString();
  const seed16 = (over) => ({
    v: 1,
    ts: "2026-01-01T00:00:00.000Z",
    updated_at: now16,
    mission_id: null,
    worker: "t",
    lesson: "",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
    scope: "project",
    ...over,
  });
  writeJsonl(lib16, [
    seed16({ id: "l-20260101-b7a001", type: "pitfall", trigger: "BATCHA 批内新建触发", fix: "BATCHA 修正", confidence: 0, hits: 0, status: "candidate" }),
    seed16({ id: "l-20260101-b7b002", type: "pitfall", trigger: "BATCHB 矛盾晋升触发", fix: "BATCHB 修正", confidence: 0, hits: 0, status: "candidate" }),
    seed16({ id: "l-20260101-b7m003", type: "error-fix", trigger: "BATCHM 批内合并触发", fix: "BATCHM 修正", confidence: 0.6, hits: 1, status: "active" }),
    seed16({ id: "l-20260101-b7c004", type: "error-fix", trigger: "BATCHM 批内合并触发", fix: "BATCHM 修正", confidence: 0, hits: 0, status: "candidate" }),
    seed16({ id: "l-20260101-b7d005", type: "preference", trigger: "BATCHD 单条兼容触发", fix: "BATCHD 修正", confidence: 0, hits: 0, status: "candidate" }),
    seed16({ id: "l-20260101-b7e006", type: "env-fact", trigger: "BATCHE 矛盾靶触发", fix: "BATCHE 修正", confidence: 0.8, hits: 2, status: "active" }),
    seed16({ id: "l-20260101-b7f007", type: "pitfall", trigger: "BATCHF 全端批触发", fix: "BATCHF 修正", confidence: 0, hits: 0, status: "candidate" }),
  ]);
  const s16 = startServer({ root: R16 });
  try {
    await s16.call("lessons", { action: "list" }); // 启动副作用（名册/目录）落地
    const row16 = (id) => readLessons(R16).find((l) => l.id === id);

    // ---- GLEAN-05l：合法批（A 新建 + C 合并）一次调用全落 + 逐条结果/汇总
    const b1 = resultText(await s16.call("lessons", { action: "promote_batch", ids: ["l-20260101-b7a001", "l-20260101-b7c004"] }));
    const a16 = row16("l-20260101-b7a001");
    const c16 = row16("l-20260101-b7c004");
    const m16 = row16("l-20260101-b7m003");
    ck.ok(
      "GLEAN-05l 合法批全落：A 新建 active + C 合并进 M（行 retired/note 溯源，M hits 1→2 conf 0.6→0.7）+ 响应 count/results/summary",
      b1.ok === true && b1.count === 2 && Array.isArray(b1.results) && b1.results.length === 2 &&
        b1.summary && b1.summary.total === 2 && b1.summary.merged === 1 && b1.summary.activated === 1 &&
        Boolean(a16) && a16.status === "active" && a16.confidence === 0.6 && a16.hits === 1 &&
        Boolean(c16) && c16.status === "retired" && c16.note === "auto: merged into l-20260101-b7m003" &&
        Boolean(m16) && m16.hits === 2 && approx2(m16.confidence) === 0.7 &&
        b1.results.some((r) => r.id === "l-20260101-b7a001" && r.ok === true && r.merged === false && r.target === "project") &&
        b1.results.some((r) => r.id === "l-20260101-b7c004" && r.ok === true && r.merged === true && r.merged_into === "l-20260101-b7m003"),
      { b1, a: a16 && a16.status, c: c16 && c16.status, m: m16 && { hits: m16.hits, conf: m16.confidence } },
    );

    // ---- GLEAN-05m：非法混批 → 整批 isError + 库字节零变更（不存在的 id / 坏 refinement 两腿）
    const beforeBad = fs.readFileSync(lib16, "utf8");
    const badMissing = await s16.call("lessons", { action: "promote_batch", ids: ["l-20260101-b7d005", "l-20260101-missing"] });
    const badRefine = await s16.call("lessons", {
      action: "promote_batch",
      ids: ["l-20260101-b7d005", { id: "l-20260101-b7b002", type: "moon" }],
    });
    ck.ok(
      "GLEAN-05m 中途败整批拒零写入：不存在的 id / 坏 refinement 均 isError 且 lessons.jsonl 逐字节不变（D 仍 candidate，无半态）",
      badMissing.isError === true && String(badMissing.text).includes("missing") &&
        badRefine.isError === true && String(badRefine.text).includes("invalid type") &&
        fs.readFileSync(lib16, "utf8") === beforeBad &&
        row16("l-20260101-b7d005").status === "candidate" &&
        row16("l-20260101-b7b002").status === "candidate",
      { missing: String(badMissing.text).slice(0, 120), refine: String(badRefine.text).slice(0, 120) },
    );

    // ---- GLEAN-05n：单条 promote 并行兼容（响应形状零变化：无 target 键的 project 形）
    const single16 = resultText(await s16.call("lessons", { action: "promote", id: "l-20260101-b7d005" }));
    ck.ok(
      "GLEAN-05n 单条 promote 并行兼容：D candidate→active，响应仍 {ok,id,status,merged,confidence,hits} 且无 target/standard 键",
      single16.ok === true && single16.id === "l-20260101-b7d005" && single16.status === "active" && single16.merged === false &&
        approx2(single16.confidence) === 0.6 && single16.hits === 1 && !("target" in single16) && !("standard" in single16) &&
        row16("l-20260101-b7d005").status === "active",
      single16,
    );

    // ---- GLEAN-05o：批 target=global 腿（B 晋升全端新行；项目源条原地不动）
    const bRaw16 = fs.readFileSync(lib16, "utf8").split("\n").find((l) => l.includes('"l-20260101-b7b002"'));
    const b2 = resultText(await s16.call("lessons", { action: "promote_batch", ids: [{ id: "l-20260101-b7b002", target: "global" }] }));
    const gRow16 = fs.existsSync(gLib16) && b2.results ? readJsonl(gLib16).find((l) => l.id === b2.results[0].result_id) : null;
    ck.ok(
      "GLEAN-05o 批 target=global：逐条覆盖生效（新行 scope=global/source=promote）+ 项目源条逐字节不动 + 单次全端落盘",
      b2.ok === true && b2.results[0].target === "global" && b2.results[0].merged === false &&
        Boolean(gRow16) && gRow16.scope === "global" && gRow16.source === "promote" && gRow16.status === "active" &&
        fs.readFileSync(lib16, "utf8").split("\n").find((l) => l.includes('"l-20260101-b7b002"')) === bRaw16,
      { b2: b2.results, gRow: gRow16 && { id: gRow16.id, scope: gRow16.scope, source: gRow16.source } },
    );

    // ---- GLEAN-05p：contradicts 逐条语义（批内对象覆盖；E 置 superseded 指回 B 的晋升结果）
    const b3 = resultText(await s16.call("lessons", { action: "promote_batch", ids: [{ id: "l-20260101-b7b002", contradicts: "l-20260101-b7e006" }] }));
    const e16 = row16("l-20260101-b7e006");
    ck.ok(
      "GLEAN-05p 批内 contradicts：B 晋升后 E 置 superseded 且 superseded_by=晋升结果 id（content 原样保留）",
      b3.ok === true && b3.results[0].contradicts === "l-20260101-b7e006" && b3.summary.contradicting === 1 &&
        Boolean(e16) && e16.status === "superseded" && e16.superseded_by === b3.results[0].result_id &&
        e16.trigger === "BATCHE 矛盾靶触发" && e16.fix === "BATCHE 修正",
      e16 && { status: e16.status, superseded_by: e16.superseded_by },
    );

    // ---- GLEAN-05q：一次落盘源面钉（批分支内各库恰一次 save；不逐条 save）
    const srvSrc16 = fs.readFileSync(DEFAULT_SERVER, "utf8");
    const batchBranch = srvSrc16.slice(
      srvSrc16.indexOf('if (action === "promote_batch")'),
      srvSrc16.indexOf('if (action === "retire")'),
    );
    ck.ok(
      "GLEAN-05q 一次落盘源面钉：promote_batch 分支 saveLessons(list)×1 ∧ saveGlobalLessons(globalList)×1（循环内零逐条 save）",
      (batchBranch.match(/saveLessons\(list\)/g) || []).length === 1 &&
        (batchBranch.match(/saveGlobalLessons\(globalList\)/g) || []).length === 1 &&
        (batchBranch.match(/saveLessons\(/g) || []).length === 1 &&
        (batchBranch.match(/saveGlobalLessons\(/g) || []).length === 1,
      { len: batchBranch.length },
    );
  } finally {
    s16.close();
  }
}


{
  const R10 = subRoot("r-inj6b");
  const MEM10 = path.join(R10, "orchestrator-memory");
  const gLib10 = path.join(MEM10, "memory", "lessons.jsonl");
  const nowIso10 = new Date().toISOString();
  const hotRow = (id, type, trigger, fix, scope) => ({
    v: 1,
    id,
    ts: "2026-01-01T00:00:00.000Z",
    updated_at: nowIso10,
    mission_id: null,
    worker: "t",
    type,
    trigger,
    lesson: "",
    fix,
    confidence: 0.9,
    hits: 5,
    status: "active",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
    scope,
  });
  // 全端库：G1（与项目 P1 同 merge key）+ G2（全端独有）；项目库：P1（G1 孪生）+ P2（独有）
  writeJsonl(gLib10, [
    hotRow("l-20260101-gggg01", "pitfall", "PROBE6B 缓存损坏重建", "重建缓存目录", "global"),
    hotRow("l-20260101-gggg02", "env-fact", "UNIQ6B 全端独有事实", "全端独有修正", "global"),
  ]);
  writeJsonl(path.join(R10, "memory", "lessons.jsonl"), [
    hotRow("l-20260101-pppp01", "pitfall", "PROBE6B 缓存损坏重建", "重建缓存目录", "project"),
    hotRow("l-20260101-pppp02", "pitfall", "OWN6B 项目独有触发", "项目独有修正", "project"),
  ]);
  fs.writeFileSync(path.join(MEM10, "AGENTS.md"), "# GLOBAL MEMORY\n- GLOBALSEC 全端稳定事实行\n");
  const s10 = startServer({ root: R10 });
  try {
    await s10.call("context_pack", {
      mission_id: "m-6b",
      title: "双库去重包",
      task: "PROBE6B 缓存损坏重建 与 OWN6B 项目独有触发 与 UNIQ6B 全端独有事实",
    });
    const pack10 = readPack(R10, "m-6b");
    const bullets = () => (pack10 || "").split("\n").filter((l) => l.startsWith("- ["));
    ck.ok(
      "INJ-06b-1 双库合并选材：全端 G1/G2 与项目独有 P2 同入选",
      Boolean(pack10) && pack10.includes("l-20260101-gggg01") && pack10.includes("l-20260101-gggg02") && pack10.includes("l-20260101-pppp02"),
      bullets(),
    );
    ck.ok(
      "INJ-06b-2 normKey 去重全端优先：同 merge key 的项目孪生 P1 被全端 G1 遮蔽",
      Boolean(pack10) && pack10.includes("l-20260101-gggg01") && !pack10.includes("l-20260101-pppp01"),
      bullets(),
    );
    // 只数 LESSONS 条目行（TASK 回显正文同样含该串，不能整包计数）
    const g1Bullets = (pack10.match(/^- \[pitfall·l-20260101-gggg01\]/gm) || []).length;
    ck.ok("INJ-06b-3 同 merge key 恰渲染一次（无双显，LESSONS 条目行计数）", g1Bullets === 1, { g1Bullets });

    // ---- contradicts 不跨库：全端 id 在项目库寻址失败，全端库字节零变化
    // （trigger/fix 取不匹配键——防 findMergeTarget 先合并短路、到不了 contradicts 臂）
    const gLibBefore = fs.readFileSync(gLib10, "utf8");
    const contra = await s10.call("lessons", {
      action: "add",
      type: "pitfall",
      trigger: "CROSS6B 不匹配键",
      fix: "CROSS6B 修正",
      contradicts: "l-20260101-gggg01",
    });
    ck.ok(
      "INJ-06b-4 contradicts 不跨库：全端 id 项目库寻址失败（target not found），协议面 isError",
      contra.isError === true && String(contra.text).includes("not found"),
      contra.text.slice(0, 140),
    );
    ck.ok("INJ-06b-5 contradicts 不跨库：全端库字节零变化（读端/写端均不触他库）", fs.readFileSync(gLib10, "utf8") === gLibBefore);

  // ---- HOST-01b（v0.9 W3 C6 条件腿）：宿主用户级注入面源码复核结论=存在
  //      （designs/agent-orchestrator-v0.9-C6-findings.md：~/.zcode/AGENTS.md 默认进
  //      子代理上下文组装链，scope="user"）→ pack_global_section 缺省翻 false（v0.9
  //      DESIGN §8 决策规则），全端节改显式 opt-in。m-6b 包即「无 cfg」环境（AGENTS.md
  //      已在位、glean.cfg.json 尚未写出）。
  const srvSrc10 = fs.readFileSync(DEFAULT_SERVER, "utf8");
  ck.ok(
    "HOST-01b-a 源码锁：readGleanCfg 缺省字面量 pack_global_section:false（cfg 键翻转锁；C6 复核结论=宿主用户级注入面存在，防双通道注入）",
    srvSrc10.includes("lock_stale_hours: 1.5, pack_global_section: false }"),
    null,
  );
  ck.ok(
    "HOST-01b-b 缺省关行为腿：无 glean.cfg.json（缺省=false）+ 全端 AGENTS.md 在位 → GLOBAL MEMORY 节整体不出现（LESSONS 命中不受累，CR-04）",
    Boolean(pack10) && !pack10.includes("## GLOBAL MEMORY") && pack10.includes("## LESSONS"),
    pack10 && pack10.split("\n").filter((l) => l.startsWith("## ")),
  );
  // ---- §7.2 全端节：显式 opt-in 注入 + 节序 + 开关
  fs.writeFileSync(path.join(MEM10, "glean.cfg.json"), JSON.stringify({ pack_global_section: true }));
  await s10.call("context_pack", { mission_id: "m-6bon", title: "开关开启包", task: "PROBE6B 缓存损坏重建" });
  const pack10on = readPack(R10, "m-6bon");
  ck.ok(
    "SEC72-a pack_global_section:true 显式开 → 全端 AGENTS.md 注入 GLOBAL MEMORY 节（数据栅栏句 + 正文行）",
    Boolean(pack10on) && pack10on.includes("## GLOBAL MEMORY（全端子代理记忆") && pack10on.includes("GLOBALSEC 全端稳定事实行"),
    pack10on && pack10on.split("\n").filter((l) => l.startsWith("## ")),
  );
  const iL10 = pack10on.indexOf("## LESSONS");
  const iG10 = pack10on.indexOf("## GLOBAL MEMORY");
  const iR10 = pack10on.indexOf("## RETURN");
  ck.ok("SEC72-b 节序：LESSONS < GLOBAL MEMORY < RETURN", iL10 >= 0 && iL10 < iG10 && iG10 > 0 && iG10 < iR10, { iL10, iG10, iR10 });
    fs.writeFileSync(path.join(MEM10, "glean.cfg.json"), JSON.stringify({ pack_global_section: false }));
    await s10.call("context_pack", { mission_id: "m-6bswitch", title: "开关关闭包", task: "PROBE6B 缓存损坏重建" });
    const packSwitch = readPack(R10, "m-6bswitch");
    ck.ok(
      "SEC72-c pack_global_section:false → GLOBAL MEMORY 节整体不出现（LESSONS 命中不受累，CR-04）",
      Boolean(packSwitch) && !packSwitch.includes("## GLOBAL MEMORY") && packSwitch.includes("## LESSONS"),
      packSwitch && packSwitch.split("\n").filter((l) => l.startsWith("## ")),
    );
  } finally {
    s10.close();
  }
}

/* ============ 场景 13：GLEAN-07/08（W5 §6.7 promote target=global + 双库去重终验
 *               + 跨项目 fixture〔项目库+全端库+第二注册项目见证库并存〕，root r-promote） ============ */
{
  const R13 = subRoot("r-promote");
  const MEM13 = path.join(R13, "orchestrator-memory"); // 临时根缺省重定向落点
  const gLib13 = path.join(MEM13, "memory", "lessons.jsonl");
  const lib13 = path.join(R13, "memory", "lessons.jsonl");
  // 跨项目 fixture：第二注册项目 R13B——只在名册挂行 + 见证库放同 normKey candidate，
  // 供晋升标准分支一（跨项目复现≥2）的 server 侧扫描命中（只读见证，永不直写）
  const R13B = subRoot("r-promote-b");
  const lib13B = path.join(R13B, ".zcode", "orchestrator", "memory", "lessons.jsonl");
  const now13 = new Date().toISOString();
  const old13 = new Date(Date.now() - 10 * 86400000).toISOString();
  const seedRow = (over) => ({
    v: 1,
    ts: "2026-01-01T00:00:00.000Z",
    mission_id: null,
    worker: "t",
    lesson: "",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
    ...over,
  });
  // 项目库五源条：PM（合并源·candidate，与全端 GM 同 merge key）/PN（强条源·active，
  // conf 0.9/hits 3/龄 10d → score≈1.35 ≥0.7 过强条阈值）/PC（跨项目源·candidate，
  // R13B 见证库有同键 candidate 孪生）/PW（两分支皆不满足对照）/PDEF（缺省晋升对照）
  writeJsonl(lib13, [
    seedRow({ id: "l-20260101-g5m001", updated_at: now13, type: "pitfall", trigger: "G5MERGE 全端已有键触发", fix: "G5MERGE 全端已有键修正", confidence: 0, hits: 0, status: "candidate" }),
    seedRow({ id: "l-20260101-g5n002", updated_at: old13, type: "pitfall", trigger: "G5STRONG 单库强条触发", fix: "G5STRONG 单库强条修正", confidence: 0.9, hits: 3, status: "active" }),
    seedRow({ id: "l-20260101-g5c003", updated_at: now13, type: "error-fix", trigger: "G5CROSS 跨项目复现触发", fix: "G5CROSS 跨项目复现修正", confidence: 0, hits: 0, status: "candidate" }),
    seedRow({ id: "l-20260101-g5w004", updated_at: now13, type: "preference", trigger: "G5WEAK 无证据触发", fix: "G5WEAK 无证据修正", confidence: 0.3, hits: 1, status: "candidate" }),
    seedRow({ id: "l-20260101-g5d005", updated_at: now13, type: "pitfall", trigger: "G5DEF 缺省晋升触发", fix: "G5DEF 缺省晋升修正", confidence: 0, hits: 0, status: "candidate" }),
  ]);
  // 全端库既有条 GM（与 PM 同 merge key——合并腿靶子，带原 mission ref 验证并集保留）
  writeJsonl(gLib13, [
    seedRow({ id: "l-20260101-g5gm00", updated_at: now13, type: "pitfall", trigger: "G5MERGE 全端已有键触发", fix: "G5MERGE 全端已有键修正", confidence: 0.6, hits: 2, status: "active", refs: ["m-g5orig"], scope: "global" }),
  ]);
  // 见证库：PC 同键 candidate（含 candidate 计入复现，§6.7 分支一）
  writeJsonl(lib13B, [
    seedRow({ id: "l-20260101-g5cb01", updated_at: now13, type: "error-fix", trigger: "G5CROSS 跨项目复现触发", fix: "G5CROSS 跨项目复现修正", confidence: 0, hits: 0, status: "candidate", scope: "project" }),
  ]);
  const s13 = startServer({ root: R13 });
  try {
    await s13.call("lessons", { action: "list" }); // 等启动副作用（名册 upsert 本行）落地
    const rootId13 = fs.readFileSync(path.join(R13, "root-id"), "utf8").trim();
    // 名册追加第二项目行（名册非事件层允许登记面操作；启动只写本行，追加行此后保留）
    fs.appendFileSync(
      path.join(MEM13, "projects.jsonl"),
      JSON.stringify({ root_id: "f0f0f0f0f0f0f0f1", project_path: R13B, first_seen: now13, last_seen: now13, server_version: "0.8.0" }) + "\n",
    );
    const rawLineById = (file, lid) => fs.readFileSync(file, "utf8").split("\n").find((l) => l.includes(`"${lid}"`));
    const rowById = (file, lid) => readJsonl(file).find((l) => l.id === lid);
    const bullets13 = (pack) => (pack || "").split("\n").filter((l) => /^- \[/.test(l));

    // ---- G7-a/b/c：合并腿（全端 findMergeTarget 命中 → hits+1/confidence 提升/refs 并集 + 源条不动）
    const pmBefore = rawLineById(lib13, "l-20260101-g5m001");
    const pm7 = resultText(await s13.call("lessons", { action: "promote", id: "l-20260101-g5m001", target: "global" }));
    ck.ok(
      "G7-a 合并腿响应：merged:true + target=global + source_id + 命中全端条 GM（hits 2→3、conf 0.6→0.7）",
      pm7.ok === true && pm7.merged === true && pm7.target === "global" && pm7.source_id === "l-20260101-g5m001" && pm7.id === "l-20260101-g5gm00" && pm7.hits === 3 && approx2(pm7.confidence) === 0.7,
      pm7,
    );
    const gmAfter = rowById(gLib13, "l-20260101-g5gm00");
    ck.ok(
      "G7-b 合并腿回链并集：GM.refs 保留原 mission 且并入三元组（源条 id/源项目路径/root_id）各恰一次",
      Array.isArray(gmAfter.refs) && gmAfter.refs.includes("m-g5orig") && gmAfter.refs.includes("l-20260101-g5m001") && gmAfter.refs.some((x) => normPath(x) === normPath(R13)) && gmAfter.refs.filter((x) => x === rootId13).length === 1 && gmAfter.refs.filter((x) => x === "l-20260101-g5m001").length === 1,
      gmAfter && gmAfter.refs,
    );
    ck.ok(
      "G7-c 源条原地不动（合并腿）：PM 行逐字节不变且仍 candidate 于项目库",
      rawLineById(lib13, "l-20260101-g5m001") === pmBefore && rowById(lib13, "l-20260101-g5m001").status === "candidate",
      null,
    );

    // ---- G7-d/e/f：强条腿（单库强条证据分支 + 新建 scope=global + 回链三元组）
    const pnBefore = rawLineById(lib13, "l-20260101-g5n002");
    const pn7 = resultText(await s13.call("lessons", { action: "promote", id: "l-20260101-g5n002", target: "global" }));
    ck.ok(
      "G7-d 强条腿证据：branch=strong + eligible + strong.pass（score≥0.7/hits=3/龄≥7d）+ cross_project 不成立（count=1）",
      pn7.ok === true && Boolean(pn7.standard) && pn7.standard.branch === "strong" && pn7.standard.eligible === true && pn7.standard.strong.pass === true && pn7.standard.strong.hits === 3 && pn7.standard.strong.age_days >= 7 && Number(pn7.standard.strong.score) >= 0.7 && pn7.standard.cross_project.count === 1 && pn7.standard.cross_project.pass === false,
      pn7.standard,
    );
    const gn13 = rowById(gLib13, pn7.id);
    ck.ok(
      "G7-e 新建腿形状：scope=global/source=promote/status=active/conf=0.7/hits=1/worker=gleaner + refs 恰为回链三元组",
      Boolean(gn13) && gn13.scope === "global" && gn13.source === "promote" && gn13.status === "active" && gn13.confidence === 0.7 && gn13.hits === 1 && gn13.worker === "gleaner" && Array.isArray(gn13.refs) && gn13.refs.length === 3 && gn13.refs[0] === "l-20260101-g5n002" && normPath(gn13.refs[1]) === normPath(R13) && gn13.refs[2] === rootId13,
      gn13,
    );
    ck.ok(
      "G7-f 源条原地不动（新建腿）：PN 行逐字节不变且仍 active 于项目库",
      rawLineById(lib13, "l-20260101-g5n002") === pnBefore && rowById(lib13, "l-20260101-g5n002").status === "active",
      null,
    );

    // ---- G7-g：跨项目复现分支（名册第二项目库同 normKey candidate 命中 → count=2）
    const pc7 = resultText(await s13.call("lessons", { action: "promote", id: "l-20260101-g5c003", target: "global" }));
    ck.ok(
      "G7-g 跨项目复现分支证据：branch=cross-project + count=2（本库+见证库）+ others 指向 R13B（candidate 行计入）",
      pc7.ok === true && pc7.standard.branch === "cross-project" && pc7.standard.cross_project.count === 2 && pc7.standard.cross_project.pass === true && Array.isArray(pc7.standard.cross_project.others) && pc7.standard.cross_project.others.length === 1 && normPath(pc7.standard.cross_project.others[0]) === normPath(R13B),
      pc7.standard,
    );

    // ---- G7-h：两分支皆不满足 → 证据为否而工具面仍放行（§6.7 判定权在归敛，非 server 门）
    const pw7 = resultText(await s13.call("lessons", { action: "promote", id: "l-20260101-g5w004", target: "global" }));
    ck.ok(
      "G7-h 弱条对照：standard.eligible=false + branch=null（两分支皆不满足）且晋升照常完成（证据非门）",
      pw7.ok === true && Boolean(pw7.standard) && pw7.standard.eligible === false && pw7.standard.branch === null && pw7.standard.cross_project.pass === false && pw7.standard.strong.pass === false,
      pw7.standard,
    );

    // ---- G7-i/j：坏 target 报错 + 缺省 target 行为零变化（§8 兼容行「缺省 project=现行为逐字节一致」）
    const pBad13 = await s13.call("lessons", { action: "promote", id: "l-20260101-g5d005", target: "moon" });
    ck.ok(
      "G7-i 坏 target 严格报错（isError，allowed: project, global）",
      pBad13.isError === true && String(pBad13.text).includes("invalid target"),
      pBad13.text.slice(0, 100),
    );
    const gLibBefore13 = fs.readFileSync(gLib13, "utf8");
    const pd7 = resultText(await s13.call("lessons", { action: "promote", id: "l-20260101-g5d005" }));
    const pdRow13 = rowById(lib13, "l-20260101-g5d005");
    ck.ok(
      "G7-j 缺省 target 现行为零变化：本库 candidate→active、响应无 target/standard 键、全端库字节零变化",
      pd7.ok === true && pd7.status === "active" && pd7.merged === false && !("target" in pd7) && !("standard" in pd7) && pdRow13.status === "active" && fs.readFileSync(gLib13, "utf8") === gLibBefore13,
      pd7,
    );

    // ---- G7-k：schema 面（target 枚举 + promote 描述行跨项目晋升句在案）
    const srvSrc13 = fs.readFileSync(DEFAULT_SERVER, "utf8");
    ck.ok(
      "G7-k schema：lessons target 枚举 [project, global] + promote 描述行含跨项目晋升与回链句",
      srvSrc13.includes('enum: ["project", "global"]') && srvSrc13.includes('target=\\"global\\" 跨项目晋升全端库') && srvSrc13.includes("refs=[源条 id, 源项目路径, root_id]"),
      null,
    );

    // ---- G8-a/b/c：双库去重终验（晋升场景）+ 晋升后注入全端条可见 + 读端零写
    const libBeforePack13 = fs.readFileSync(lib13, "utf8");
    const gLibBeforePack13 = fs.readFileSync(gLib13, "utf8");
    await s13.call("context_pack", { mission_id: "m-g5pack", title: "晋升去重包", task: "G5STRONG 单库强条触发任务" });
    const pack13 = readPack(R13, "m-g5pack");
    ck.ok(
      "G8-a 晋升后注入可见：pack LESSONS 渲染全端新条（promoted id 在案——scope=global 行经双库合并入选）",
      Boolean(pack13) && pack13.includes("## LESSONS") && pack13.includes(`·${pn7.id}]`),
      bullets13(pack13),
    );
    ck.ok(
      "G8-b 双库去重全端优先（晋升场景终验）：同 normKey 项目源条 PN 被全端新条遮蔽（源 id 不渲染、晋升 id 恰渲染一次）",
      Boolean(pack13) && !pack13.includes("l-20260101-g5n002") && (pack13.match(new RegExp(`^- \\[pitfall·${pn7.id}\\]`, "gm")) || []).length === 1,
      bullets13(pack13),
    );
    ck.ok(
      "G8-c 读端零写：context_pack 后项目库与全端库字节零变化",
      fs.readFileSync(lib13, "utf8") === libBeforePack13 && fs.readFileSync(gLib13, "utf8") === gLibBeforePack13,
      null,
    );
  } finally {
    s13.close();
  }
}

/* ============ 场景 14：REG-01（v0.9 W3 §9 C7 registry library_path + sibling 扫描
 *               两腿，roots r-reglib〔默认布局〕/ r-reglib-c〔自定义 --root sibling〕/
 *               r-reglib-legacy〔无 library_path 存量行 fixture〕） ============ */
{
  const R14 = subRoot("r-reglib");
  // 共享名册/全端库落 R14 内（=临时根缺省重定向同位，显式钉死使两 server 确定性同根）。
  // 注：自定义 --memory-root 置项目根外（生产缺省 ~/.zcode/orchestrator-memory 同位）时
  // promote target=global 会被 atomicWriteFileSync 缺省 base=root 的越界门拒——W5 既有
  // 缺陷候选（saveGlobalLessons 未显式传 base=memoryRoot，名册 upsert 已传），不在本波
  // 断言面，已上报主控仲裁；本场景按 C7 限制原文取自定义 --root（存储根）腿。
  const M14 = path.join(R14, "orchestrator-memory");
  fs.mkdirSync(M14, { recursive: true });
  const reg14 = path.join(M14, "projects.jsonl");
  // 自定义 --root sibling：存储根刻意不在默认布局 <project>/.zcode/orchestrator 下
  // ——旧映射（registry 只有 project_path）对此类 sibling 不可见，正是 C7 要消的限制
  const C14 = subRoot("r-reglib-c");
  const libC14 = path.join(C14, "memory", "lessons.jsonl");
  const now14 = new Date().toISOString();
  const seedRow14 = (over) => ({
    v: 1,
    ts: "2026-01-01T00:00:00.000Z",
    mission_id: null,
    worker: "t",
    lesson: "",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
    ...over,
  });
  // 自定义 root sibling 见证库：与腿 3 源条同 normKey 的 candidate（只读见证，永不直写）
  writeJsonl(libC14, [
    seedRow14({ id: "l-20260101-r1cb01", updated_at: now14, type: "pitfall", trigger: "R1CROSS 自定义根复现触发", fix: "R1CROSS 自定义根复现修正", confidence: 0, hits: 0, status: "candidate", scope: "project" }),
  ]);

  // ---- REG-01a 登记面（C7-a）：默认布局项目启动 → 登记行含 library_path 且=实际解析项目库绝对路径
  const s14a = startServerX({ root: R14, args: ["--memory-root", M14] });
  try {
    await s14a.call("lessons", { action: "list" }); // 等启动副作用（名册 upsert）落地
    const rows14 = readJsonl(reg14);
    const rid14 = fs.readFileSync(path.join(R14, "root-id"), "utf8").trim();
    ck.ok(
      "REG-01a 登记行含 library_path：值=本实例实际解析项目库 <root>/memory/lessons.jsonl（绝对路径、原地更新语义仍一行）",
      rows14.length === 1 && rows14[0].root_id === rid14 && typeof rows14[0].library_path === "string" && path.isAbsolute(rows14[0].library_path) && normPath(rows14[0].library_path) === normPath(path.join(R14, "memory", "lessons.jsonl")),
      rows14,
    );
  } finally {
    s14a.close();
  }

  // ---- REG-01b 自定义 --root sibling 自登记（C7-a 端到端）：library_path 指向自定义根
  //      项目库而非默认布局映射（旧映射下该路径不存在=不可见的实症面）
  const s14b = startServerX({ root: C14, args: ["--memory-root", M14] });
  try {
    await s14b.call("lessons", { action: "list" });
    const rows14b = readJsonl(reg14);
    const rowC14 = rows14b.find((r) => normPath(r.project_path) === normPath(C14));
    ck.ok(
      "REG-01b 自定义 --root sibling 自登记：library_path=<自定义根>/memory/lessons.jsonl 且默认布局路径不存在（旧映射必脱靶）",
      Boolean(rowC14) && normPath(rowC14.library_path) === normPath(libC14) && !fs.existsSync(path.join(C14, ".zcode", "orchestrator", "memory", "lessons.jsonl")),
      rowC14,
    );
  } finally {
    s14b.close();
  }

  // ---- REG-01c 优先腿端到端（C7-b 腿一）：R14 项目库同 normKey candidate → promote
  //      target=global → sibling 扫描经 library_path 命中自定义 root sibling（count=2）
  writeJsonl(path.join(R14, "memory", "lessons.jsonl"), [
    seedRow14({ id: "l-20260101-r1c002", updated_at: now14, type: "pitfall", trigger: "R1CROSS 自定义根复现触发", fix: "R1CROSS 自定义根复现修正", confidence: 0, hits: 0, status: "candidate" }),
  ]);
  const s14c = startServerX({ root: R14, args: ["--memory-root", M14] });
  try {
    await s14c.call("lessons", { action: "list" });
    const pc14 = resultText(await s14c.call("lessons", { action: "promote", id: "l-20260101-r1c002", target: "global" }));
    ck.ok(
      "REG-01c 优先腿：自定义 --root sibling 经 library_path 命中（branch=cross-project、count=2、others 指向其 project_path）",
      pc14.ok === true && pc14.standard.branch === "cross-project" && pc14.standard.cross_project.count === 2 && pc14.standard.cross_project.pass === true && Array.isArray(pc14.standard.cross_project.others) && pc14.standard.cross_project.others.length === 1 && normPath(pc14.standard.cross_project.others[0]) === normPath(C14),
      pc14.standard,
    );
  } finally {
    s14c.close();
  }

  // ---- REG-01d 回退腿（C7-b 腿二）：无 library_path 的 0.8.0 存量行仍按默认布局命中
  const R14L = subRoot("r-reglib-legacy");
  const libL14 = path.join(R14L, ".zcode", "orchestrator", "memory", "lessons.jsonl");
  writeJsonl(libL14, [
    seedRow14({ id: "l-20260101-r1lb03", updated_at: now14, type: "error-fix", trigger: "R1LEG 存量行回退触发", fix: "R1LEG 存量行回退修正", confidence: 0, hits: 0, status: "candidate", scope: "project" }),
  ]);
  writeJsonl(path.join(R14, "memory", "lessons.jsonl"), [
    seedRow14({ id: "l-20260101-r1l004", updated_at: now14, type: "error-fix", trigger: "R1LEG 存量行回退触发", fix: "R1LEG 存量行回退修正", confidence: 0, hits: 0, status: "candidate" }),
  ]);
  fs.appendFileSync(
    reg14,
    JSON.stringify({ root_id: "f0f0f0f0f0f0f0f2", project_path: R14L, first_seen: now14, last_seen: now14, server_version: "0.8.0" }) + "\n",
  );
  const s14d = startServerX({ root: R14, args: ["--memory-root", M14] });
  try {
    await s14d.call("lessons", { action: "list" });
    const rows14d = readJsonl(reg14);
    const pl14 = resultText(await s14d.call("lessons", { action: "promote", id: "l-20260101-r1l004", target: "global" }));
    ck.ok(
      "REG-01d 回退腿（存量行兼容）：无 library_path 的 legacy 行按默认布局命中（count=2、others 指向 legacy 项目路径；自定义根 sibling 因 normKey 不同不计入）",
      rows14d.length === 3 && pl14.ok === true && pl14.standard.cross_project.count === 2 && Array.isArray(pl14.standard.cross_project.others) && pl14.standard.cross_project.others.length === 1 && normPath(pl14.standard.cross_project.others[0]) === normPath(R14L),
      { rows: rows14d.map((r) => [r.root_id, r.library_path || null]), standard: pl14.standard },
    );
  } finally {
    s14d.close();
  }
}

/* ============ 场景 15：W3FIX（saveGlobalLessons base 修复回归——显式 --memory-root
 *               指向项目根外时 promote target=global 端到端成功〔原炸点转绿〕，
 *               roots r-memroot-out〔项目根〕/ mem-outside〔根外全端根，兄弟目录〕） ============ */
{
  const R15 = subRoot("r-memroot-out");
  // 根外全端根：置于 BASE.root 下与 R15 平级（resolve 后不在项目根 R15 内）——
  // 生产缺省 ~/.zcode/orchestrator-memory 同位。修复前 saveGlobalLessons 未传 base
  // （缺省=存储根 root）→ assertInside 越界门拒写「path escapes base directory」
  // （场景 14 注记所指 W5 缺陷候选，主控仲裁批准本波修复）。
  const MEM15 = path.join(BASE.root, "mem-outside");
  fs.mkdirSync(MEM15, { recursive: true });
  const gLib15 = path.join(MEM15, "memory", "lessons.jsonl");
  const lib15 = path.join(R15, "memory", "lessons.jsonl");
  const now15 = new Date().toISOString();
  const old15 = new Date(Date.now() - 10 * 86400000).toISOString();
  const seedRow15 = (over) => ({
    v: 1,
    ts: "2026-01-01T00:00:00.000Z",
    mission_id: null,
    worker: "t",
    lesson: "",
    refs: [],
    superseded_by: null,
    counter_refs: [],
    note: null,
    ...over,
  });
  // 项目库两源条：SN（强条 active：conf 0.9/hits 3/龄 10d → 强条分支过）/
  // SC（同 merge key candidate——合并腿复用 saveGlobalLessons 第二调用点）
  writeJsonl(lib15, [
    seedRow15({ id: "l-20260101-w3f001", updated_at: old15, type: "pitfall", trigger: "W3FIX 根外全端根触发", fix: "W3FIX 根外全端根修正", confidence: 0.9, hits: 3, status: "active" }),
    seedRow15({ id: "l-20260101-w3f002", updated_at: now15, type: "pitfall", trigger: "W3FIX 根外全端根触发", fix: "W3FIX 根外全端根修正", confidence: 0, hits: 0, status: "candidate" }),
  ]);
  const s15 = startServerX({ root: R15, args: ["--memory-root", MEM15] });
  try {
    await s15.call("lessons", { action: "list" }); // 等启动副作用（名册 upsert）落地
    const rootId15 = fs.readFileSync(path.join(R15, "root-id"), "utf8").trim();
    const rowById15 = (file, lid) => readJsonl(file).find((l) => l.id === lid);
    const rawLineById15 = (file, lid) => fs.readFileSync(file, "utf8").split("\n").find((l) => l.includes(`"${lid}"`));

    // ---- W3FIX-a：新建腿端到端（原炸点）：promote target=global 成功且全端新行落根外库
    const snBefore = rawLineById15(lib15, "l-20260101-w3f001");
    const pw15 = resultText(await s15.call("lessons", { action: "promote", id: "l-20260101-w3f001", target: "global" }));
    ck.ok(
      "W3FIX-a 显式 --memory-root 根外时 promote target=global 端到端成功：ok/merged=false/target=global + 全端新行落 <根外>/memory/lessons.jsonl（scope=global/source=promote/refs 回链三元组）",
      pw15.ok === true && pw15.merged === false && pw15.target === "global" && pw15.source_id === "l-20260101-w3f001" && fs.existsSync(gLib15) && (() => { const g = rowById15(gLib15, pw15.id); return Boolean(g) && g.scope === "global" && g.source === "promote" && Array.isArray(g.refs) && g.refs.length === 3 && g.refs[0] === "l-20260101-w3f001" && normPath(g.refs[1]) === normPath(R15) && g.refs[2] === rootId15; })(),
      pw15,
    );
    ck.ok(
      "W3FIX-b 源条原地不动：项目库 SN 行逐字节不变（§6.7 红线在根外场景同守）",
      rawLineById15(lib15, "l-20260101-w3f001") === snBefore,
      null,
    );

    // ---- W3FIX-c：合并腿（saveGlobalLessons 第二调用点）：同 merge key candidate → merged/hits+1，落点仍根外
    const pc15 = resultText(await s15.call("lessons", { action: "promote", id: "l-20260101-w3f002", target: "global" }));
    ck.ok(
      "W3FIX-c 合并腿在根外全端根同绿：merged=true + 命中 W3FIX-a 新条（hits 1→2、conf 0.7→0.8）且全端库字节落点仍根外",
      pc15.ok === true && pc15.merged === true && pc15.id === pw15.id && pc15.hits === 2 && approx2(pc15.confidence) === 0.8 && fs.existsSync(gLib15) && rowById15(gLib15, pw15.id).hits === 2,
      pc15,
    );
  } finally {
    s15.close();
  }
}

/* ============ 场景 16：v1.1 W3 Q11 digest 消费面（回落/新鲜/STALE/信号） ============ */
{
  const R16 = subRoot("r-digest");
  const MEM16 = path.join(R16, "orchestrator-memory");
  const lib16 = path.join(R16, "memory", "lessons.jsonl");
  const digestDir = path.join(MEM16, "digest");
  const digestMd = path.join(digestDir, "pack-tail-digest.md");
  const digestJson = path.join(digestDir, "pack-tail-digest.json");
  fs.mkdirSync(MEM16, { recursive: true });
  // GLOBAL MEMORY 显式开启（digest 只在「至少一节旧记忆节将渲染」时替代渲染）+ gate due。
  fs.writeFileSync(path.join(MEM16, "glean.cfg.json"), JSON.stringify({ idle_hours: 0, new_events: 0, pack_global_section: true }));
  fs.writeFileSync(path.join(MEM16, "AGENTS.md"), "# GLOBAL\n- DIGSEC 全端稳定事实行\n");
  writeJsonl(lib16, [
    {
      v: 1,
      id: "l-20260101-dg0001",
      ts: "2026-01-01T00:00:00.000Z",
      updated_at: new Date().toISOString(),
      mission_id: null,
      worker: "t",
      type: "pitfall",
      trigger: "DIGPROBE 触发行",
      lesson: "",
      fix: "DIGPROBE 修正行",
      confidence: 0.9,
      hits: 5,
      status: "active",
      refs: [],
      superseded_by: null,
      counter_refs: [],
      note: null,
    },
  ]);
  const s16d = startServer({ root: R16 });
  try {
    const packOf = async (mid) => {
      await s16d.call("context_pack", { mission_id: mid, title: "digest 探针", task: "DIGPROBE 任务" });
      return readPack(R16, mid);
    };
    const listDigest = async () => {
      const r = await s16d.call("board", { action: "list" });
      return r.json && r.json.glean_due ? r.json.glean_due.digest : null;
    };

    // ---- 腿 1：digest 缺失 → 旧两节回落（零字节差语义：GLOBAL MEMORY 原样在位） + 信号 missing
    const pMiss = await packOf("m-dg-miss");
    ck.ok("W3-DG-01 digest 缺失 → 回落 GLOBAL MEMORY 且无 PROJECT DIGEST（缺省行为不变）",
      Boolean(pMiss) && pMiss.includes("## GLOBAL MEMORY") && !pMiss.includes("## PROJECT DIGEST"),
      pMiss && pMiss.split("\n").filter((l) => l.startsWith("## ")));
    const dMiss = await listDigest();
    ck.ok("W3-DG-02 glean_due.digest 三态信号 status=missing（gate due 时出现）",
      Boolean(dMiss) && dMiss.status === "missing" && dMiss.generated_at === null, dMiss);

    // ---- 腿 2：digest 在位 + 指纹合 → 单节 PROJECT DIGEST 替代两旧节 + 信号 fresh
    const genAt = new Date().toISOString();
    fs.mkdirSync(digestDir, { recursive: true });
    fs.writeFileSync(
      digestMd,
      `generated_at: ${genAt}\n- DIGEST 项目现状行\n- DIGEST 在飞 m-digest\n- DIGEST 近期裁决 2026-10-25 W3\n`,
    );
    const libStat = fs.statSync(lib16);
    fs.writeFileSync(
      digestJson,
      JSON.stringify({
        generated_at: genAt,
        sources: { lessons_lines: 1, lessons_mtime_ms: libStat.mtimeMs },
        bytes: Buffer.byteLength(fs.readFileSync(digestMd, "utf8"), "utf8"),
      }),
    );
    const pFresh = await packOf("m-dg-fresh");
    ck.ok("W3-DG-03 digest 指纹合 → 单节 PROJECT DIGEST 替代 GLOBAL MEMORY（节头 ts=generated_at）",
      Boolean(pFresh) && pFresh.includes(`## PROJECT DIGEST（归敛物化，ts:${genAt}）`) &&
        !pFresh.includes("## GLOBAL MEMORY") && pFresh.includes("DIGEST 项目现状行"),
      pFresh && pFresh.split("\n").filter((l) => l.startsWith("## ")));
    const dFresh = await listDigest();
    ck.ok("W3-DG-04 glean_due.digest status=fresh + generated_at 透出",
      Boolean(dFresh) && dFresh.status === "fresh" && dFresh.generated_at === genAt, dFresh);

    // ---- 腿 2b：帽边界（v1.1 W6 QA P2-a）——口径=正文（GL-32「正文 ≤12 行/≤1200B」，
    // generated_at 首行不占正文预算）。修复前 12 行正文即 STALE（off-by-one）。
    const writeDigestBody = (bodyLines) => {
      const md = `generated_at: ${genAt}\n${bodyLines.join("\n")}\n`;
      fs.writeFileSync(digestMd, md);
      fs.writeFileSync(
        digestJson,
        JSON.stringify({
          generated_at: genAt,
          sources: { lessons_lines: 1, lessons_mtime_ms: libStat.mtimeMs },
          bytes: Buffer.byteLength(md, "utf8"),
        }),
      );
      return md;
    };
    // 正文恰 12 行（短行）→ fresh（12 行是上限内，不得误判 STALE）
    const body12 = Array.from({ length: 12 }, (_, i) => `- BOUNDARY12-${String(i + 1).padStart(2, "0")}`);
    writeDigestBody(body12);
    const pCap12 = await packOf("m-dg-cap12");
    ck.ok("W6-P2a 正文恰 12 行 → 不 STALE（fresh；12 行为上限内）",
      Boolean(pCap12) && pCap12.includes(`## PROJECT DIGEST（归敛物化，ts:${genAt}）`) &&
        !pCap12.includes("；STALE：") && pCap12.includes("BOUNDARY12-12"),
      pCap12 && pCap12.split("\n").find((l) => l.startsWith("## PROJECT DIGEST")));
    const dCap12 = await listDigest();
    ck.ok("W6-P2a 正文 12 行 glean_due.digest status=fresh", Boolean(dCap12) && dCap12.status === "fresh", dCap12);
    // 正文 13 行 → STALE（正文口径理由）+ 渲染 clamp 到 12 行（第 13 行不泄）
    writeDigestBody(body12.concat("- BOUNDARY13-13"));
    const pCap13 = await packOf("m-dg-cap13");
    ck.ok("W6-P2a 正文 13 行 → STALE（超帽理由按正文计）+ 渲染 clamp 12 行（13 行不泄）",
      Boolean(pCap13) && pCap13.includes("；STALE：digest 超帽（正文 13 行/") &&
        pCap13.includes("BOUNDARY12-12") && !pCap13.includes("BOUNDARY13-13"),
      pCap13 && pCap13.split("\n").find((l) => l.startsWith("## PROJECT DIGEST")));
    // 字节帽边界（正文口径）：12 行恰 1200B → fresh；1201B → STALE（首行字节不占正文预算）
    // 11 行×99 字符 + 1 行×100 字符 = 1189B 文本 + 11×"\n" = 1200B
    const byteLines = [
      ...Array.from({ length: 11 }, (_, i) => `${String(i + 1).padStart(2, "0")}${"a".repeat(97)}`),
      `12${"b".repeat(98)}`,
    ];
    writeDigestBody(byteLines);
    const pByteOk = await packOf("m-dg-bytes-ok");
    ck.ok("W6-P2a 正文恰 1200B → 不 STALE（字节帽=正文口径）",
      Boolean(pByteOk) && !pByteOk.includes("；STALE：") && pByteOk.includes(`12${"b".repeat(98)}`),
      pByteOk && pByteOk.split("\n").find((l) => l.startsWith("## PROJECT DIGEST")));
    writeDigestBody([...byteLines.slice(0, 11), `12${"b".repeat(99)}`]);
    const pByteOver = await packOf("m-dg-bytes-over");
    ck.ok("W6-P2a 正文 1201B → STALE（字节超帽仍检出）",
      Boolean(pByteOver) && pByteOver.includes("；STALE：digest 超帽（正文 12 行/1201B"),
      pByteOver && pByteOver.split("\n").find((l) => l.startsWith("## PROJECT DIGEST")));
    // 边界腿收尾：恢复腿 2 的三行正文（供腿 3/4 的指纹不合/侧车缺失腿使用）
    writeDigestBody(["- DIGEST 项目现状行", "- DIGEST 在飞 m-digest", "- DIGEST 近期裁决 2026-10-25 W3"]);

    // ---- 腿 3：指纹不合（lessons_lines 漂移）→ 标 STALE 不阻断组包 + 信号 stale
    fs.writeFileSync(
      digestJson,
      JSON.stringify({ generated_at: genAt, sources: { lessons_lines: 999, lessons_mtime_ms: libStat.mtimeMs } }),
    );
    const pStale = await packOf("m-dg-stale");
    ck.ok("W3-DG-05 指纹不合 → digest 节标 STALE（仍渲染、不阻断组包）",
      Boolean(pStale) && pStale.includes("## PROJECT DIGEST（归敛物化，") && pStale.includes("；STALE：") &&
        pStale.includes("DIGEST 项目现状行") && !pStale.includes("## GLOBAL MEMORY"),
      pStale && pStale.split("\n").find((l) => l.startsWith("## PROJECT DIGEST")));
    const dStale = await listDigest();
    ck.ok("W3-DG-06 glean_due.digest status=stale", Boolean(dStale) && dStale.status === "stale", dStale);

    // ---- STL 组（v1.2 M8-1，A-v0120-STL）：stale_reason 结构化 {field,want,now,drift}＋按 drift
    // 分级渲染（O2=N=5 绝对数终裁：drift≤5 轻微=态势面大概率仍有效；>5 显著=建议触发归敛；
    // 无数值漂移→显著）。断言面=注入头（PROJECT DIGEST 节头）逐字样例＋N5 边界两侧分级文案。
    const digestHeaderOf = (pack) =>
      String(pack || "").split("\n").find((l) => l.startsWith("## PROJECT DIGEST")) || "";
    // STL-01 漂移 5（≤N5 边界内侧）→ 轻微样例：态势面大概率仍有效
    fs.writeFileSync(
      digestJson,
      JSON.stringify({ generated_at: genAt, sources: { lessons_lines: 6, lessons_mtime_ms: libStat.mtimeMs } }),
    );
    const pStlMinor = await packOf("m-stl-minor");
    ck.ok("STL-01 漂移 5≤N5 → 注入头轻微样例（lessons_lines 6 ≠ 1（漂移 5≤5，轻微——态势面大概率仍有效））",
      digestHeaderOf(pStlMinor).includes("；STALE：lessons_lines 6 ≠ 1（漂移 5≤5，轻微——态势面大概率仍有效）"),
      digestHeaderOf(pStlMinor));
    // STL-02 漂移 7（>N5 边界外侧）→ 显著文案；分级互斥（轻微不出现）
    fs.writeFileSync(
      digestJson,
      JSON.stringify({ generated_at: genAt, sources: { lessons_lines: 8, lessons_mtime_ms: libStat.mtimeMs } }),
    );
    const pStlMajor = await packOf("m-stl-major");
    const hStlMajor = digestHeaderOf(pStlMajor);
    ck.ok("STL-02 漂移 7>N5 → 显著分级文案（建议触发归敛），轻微不出现",
      hStlMajor.includes("（漂移 7>5，显著——建议触发归敛）") && !hStlMajor.includes("轻微"),
      hStlMajor);
    // STL-03 大漂移注入头样例（旧文案前缀兼容：`lessons_lines 999 ≠ 1` 仍可检索）
    fs.writeFileSync(
      digestJson,
      JSON.stringify({ generated_at: genAt, sources: { lessons_lines: 999, lessons_mtime_ms: libStat.mtimeMs } }),
    );
    const pStlBig = await packOf("m-stl-big");
    ck.ok("STL-03 大漂移注入头样例（lessons_lines 999 ≠ 1（漂移 998>5，显著——建议触发归敛））",
      digestHeaderOf(pStlBig).includes("；STALE：lessons_lines 999 ≠ 1（漂移 998>5，显著——建议触发归敛）"),
      digestHeaderOf(pStlBig));
    // STL-04 mtime 单独不匹配（无数值漂移）→ drift 未知 → 显著（fail-safe 侧）
    fs.writeFileSync(
      digestJson,
      JSON.stringify({ generated_at: genAt, sources: { lessons_lines: 1, lessons_mtime_ms: libStat.mtimeMs + 12345 } }),
    );
    const pStlMtime = await packOf("m-stl-mtime");
    ck.ok("STL-04 mtime 漂移未知 → 注入头显著样例（lessons_mtime_ms 不匹配（漂移未知，显著——建议触发归敛））",
      digestHeaderOf(pStlMtime).includes("；STALE：lessons_mtime_ms 不匹配（漂移未知，显著——建议触发归敛）"),
      digestHeaderOf(pStlMtime));

    // ---- 腿 4：指纹侧车缺失 → STALE（fail-safe，不回落旧节——digest 仍在位）
    fs.rmSync(digestJson, { force: true });
    const pNoSide = await packOf("m-dg-noside");
    ck.ok("W3-DG-07 指纹侧车缺失 → STALE（不阻断）",
      Boolean(pNoSide) && pNoSide.includes("；STALE：") && pNoSide.includes("DIGEST 项目现状行"),
      pNoSide && pNoSide.split("\n").find((l) => l.startsWith("## PROJECT DIGEST")));

    // ---- 腿 5：digest md 删除 → 回到旧两节渲染 + missing 信号
    fs.rmSync(digestMd, { force: true });
    const pBack = await packOf("m-dg-back");
    ck.ok("W3-DG-08 digest 删除 → 回退旧两节渲染（GLOBAL MEMORY 复位）",
      Boolean(pBack) && pBack.includes("## GLOBAL MEMORY") && !pBack.includes("## PROJECT DIGEST"),
      pBack && pBack.split("\n").filter((l) => l.startsWith("## ")));
    const dBack = await listDigest();
    ck.ok("W3-DG-09 删除后信号回 missing", Boolean(dBack) && dBack.status === "missing", dBack);

    // ---- 腿 6：brief 暴露 digest 权威路径（gleaner 物化面：路径不手写）
    const brief16 = JSON.parse(fs.readFileSync(path.join(MEM16, "glean-brief.json"), "utf8"));
    ck.ok("W3-DG-10 brief.digest 权威路径（path/sidecar_path 双指针）",
      Boolean(brief16.digest) && brief16.digest.path === digestMd && brief16.digest.sidecar_path === digestJson,
      brief16.digest);
  } finally {
    s16d.close();
  }
}

BASE.cleanup();
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
