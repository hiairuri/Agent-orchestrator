// @module crv2-pack/dispatch-pure
// suites/crv2-pack 拆分件：v1.1.1 W20 W4-DISPATCH 纯函数族（buildDispatchPrompt 直测）——
// BUILD-DISPATCH-PURE 区抽取 + 组装序/去协议行/旧→新/滞回（LSN-01..04/TRC-01..05）+
// W4-PREFIX（fallback 前缀锚/尾块形制/跨窗口/静态锁）+ W4-DISPATCH-10..14（纪律段字面锁）。
// 原 L433-870 搬入，自含（无 cur 依赖）。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGIN_DIR } from "../../harness/jsonrpc-client.mjs";
import { familySource } from "../../harness/source-family.mjs";
import { ck, BASE } from "./setup.mjs";

export async function runDispatchPure() {
  // ---- v1.1.1 W20：W4-DISPATCH 族（buildDispatchPrompt 纯函数直测，DESIGN §1.2/§6.1） ----
  // server.mjs 的 BUILD-DISPATCH-PURE 区间零 fs 依赖，抽成临时模块直测——组装序/去协议行/
  // 旧→新/≤10 块/字节确定性/30000 拒。夹具一律 v2 双标签形制（grill#3 G3-5）。
  let dispatchPure = null;
  {
    // v1.3 切分重基（修复轮 D）：BUILD-DISPATCH-PURE 标记区已迁 mcp/tool-dispatch.mjs（拆分布局
    // 原样保留），抽取读面由 server.mjs 单文件读改模块文件直读——纯区自含零外部标识符，
    // 抽取机制（标记对切片+临时模块导入）与断言零改动。
    const src = fs
      .readFileSync(path.join(PLUGIN_DIR, "mcp", "tool-dispatch.mjs"), "utf8")
      .replace(/\r\n/g, "\n");
    const beginMark = "/* BUILD-DISPATCH-PURE-BEGIN";
    const endMark = "/* BUILD-DISPATCH-PURE-END */";
    const i = src.indexOf(beginMark);
    const j = src.indexOf(endMark);
    if (i >= 0 && j > i) {
      const dir = path.join(BASE.root, "dispatch-pure");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "pure.mjs");
      fs.writeFileSync(
        file,
        src.slice(i, j + endMark.length) +
          "\nexport { buildDispatchPrompt, DISPATCH_DISCIPLINE_FENCE, DISPATCH_DISCIPLINE_BODY, DISPATCH_LESSONS_FENCE };\n",
      );
      dispatchPure = await import(pathToFileURL(file).href + "?v=" + Date.now());
    }
    ck.ok(
      "W4-DISPATCH-00 buildDispatchPrompt 纯区可抽取（BUILD-DISPATCH-PURE 标记对在位，零 fs 依赖区）",
      Boolean(dispatchPure && dispatchPure.buildDispatchPrompt),
      { i, j },
    );
  }
  if (dispatchPure) {
    const buildDispatchPrompt = dispatchPure.buildDispatchPrompt;
    const mkMission = (id, packPath) => ({ id, pack: { path: packPath } });
    const mkPack = (mid, worker, token) =>
      [
        `# 任务包：T（${mid}）`,
        "",
        "## CONTRACT（三行契约，也出现在派发 prompt 尾块）",
        `[channel] ${mid}`,
        `[worker] ${worker}`,
        `[token] ${token}`,
        "",
        "## TASK",
        "- 做一件事",
      ].join("\n");
    const v2 = (seq, over = {}) =>
      [
        "<!-- orch-tail v2",
        `ts: ${over.ts || "2026-10-25T05:00:00.000Z"}`,
        `seq: ${seq}`,
        `project: ${over.project || "v1.1.1 机制波"}`,
        `stage: ${over.stage || "W20"}`,
        `flying: ${over.flying || "m-a"}`,
        `ruled: ${over.ruled || "日志唯一源"}`,
        `next: ${over.next || "next-" + String(seq).padStart(2, "0")}`,
        "<!-- orch-tail-end -->",
      ].join("\n");
    const personaFixture = "# persona 原型\n\nbody line 1\nbody line 2";
    const digestFixture = {
      status: "fresh",
      generated_at: "2026-10-25T00:00:00.000Z",
      lines: ["- digest 行一", "- digest 行二"],
    };
    const packFixture = mkPack("mD", "orch-worker#1", "0123456789abcdef0123456789abcdef");
    const logFixture = v2(1, { next: "old-01" }) + "\n\n" + v2(2, { next: "old-02" });
    const built = buildDispatchPrompt(
      mkMission("mD", "packs/mD/pack.md"),
      packFixture,
      logFixture,
      personaFixture,
      digestFixture,
    );
    const text = built.ok ? built.text : "";
    const disciplineStart = text.indexOf("【纪律（");
    const traceStart = text.indexOf("【主控尾块轨迹");
    const digestStart = text.indexOf("【项目 digest");
    const lessonsStart = text.indexOf("【相关教训（");
    const scopingStart = text.indexOf("【哨兵 scoping");
    const personaStart = text.indexOf("# persona 原型");
    const pointerStart = text.indexOf("先 Read 任务包 packs/mD/pack.md");
    const traceSection = traceStart >= 0 && digestStart > traceStart ? text.slice(traceStart, digestStart) : "";
    ck.ok(
      "W4-DISPATCH-01 组装序（v1.1.2 四段式+v1.2.2 教训节；本夹具无 LESSONS 节=六锚）：纪律段置顶（offset 0）→ 轨迹节 → digest 条件节 → scoping 恒在行 → persona 正文 → 指针句+CONTRACT 三行（六锚 discipline<trace<digest<scoping<persona<pointer；lessons 位次由 LSN-03 七锚钉）",
      built.ok === true &&
        built.blocks === 2 &&
        disciplineStart === 0 &&
        disciplineStart < traceStart &&
        traceStart < digestStart &&
        digestStart < scopingStart &&
        scopingStart < personaStart &&
        personaStart < pointerStart &&
        lessonsStart === -1 &&
        text.slice(pointerStart).startsWith(
          "先 Read 任务包 packs/mD/pack.md，按包内 TASK/RULES 执行；用 mcp__plugin_agent-orchestrator_orch__report 汇报（三行契约唯一权威=包 CONTRACT 节）。\n[channel] mD\n[worker] orch-worker#1\n[token] 0123456789abcdef0123456789abcdef",
        ) &&
        built.worker === "orch-worker#1" &&
        built.channel === "mD",
      { order: [disciplineStart, traceStart, digestStart, scopingStart, personaStart, pointerStart], blocks: built.blocks },
    );
    ck.ok(
      "W4-DISPATCH-02 去协议行：轨迹节无 ts:/seq: 行，五业务字段逐字在位",
      traceSection.length > 0 &&
        !/^(ts|seq): /m.test(traceSection) &&
        traceSection.includes("project: v1.1.1 机制波") &&
        traceSection.includes("stage: W20") &&
        traceSection.includes("flying: m-a") &&
        traceSection.includes("ruled: 日志唯一源") &&
        traceSection.includes("next: old-02"),
      { hasTs: /^ts: /m.test(traceSection), hasSeq: /^seq: /m.test(traceSection) },
    );
    ck.ok(
      "W4-DISPATCH-03 旧→新：块序按日志顺序（最旧在前，最新在尾）",
      traceStart >= 0 &&
        text.indexOf("next: old-01") > 0 &&
        text.indexOf("next: old-01") < text.indexOf("next: old-02"),
      { i1: text.indexOf("next: old-01"), i2: text.indexOf("next: old-02") },
    );
    const many = Array.from({ length: 12 }, (_, k) => v2(k + 1)).join("\n\n");
    const capped = buildDispatchPrompt(mkMission("mD", "packs/mD/pack.md"), packFixture, many, personaFixture, null);
    const cappedTrace = capped.ok ? capped.text.slice(0, capped.text.indexOf("# persona 原型")) : "";
    const openCount = (cappedTrace.match(/<!-- orch-tail v2/g) || []).length;
    ck.ok(
      "W4-DISPATCH-04 轨迹滞回（v1.2.2 自「12 块取尾 10」改写）：12 块日志 ≤20 → 全量 12 块注入（无出队，最旧两块在位；>20 尾 10 腿由 TRC-02/05 钉）",
      capped.ok === true &&
        capped.blocks === 12 &&
        openCount === 12 &&
        cappedTrace.includes("next: next-01") &&
        cappedTrace.includes("next: next-02") &&
        cappedTrace.includes("next: next-12") &&
        !cappedTrace.includes("【项目 digest"),
      { blocks: capped.blocks, openCount },
    );
    const again = buildDispatchPrompt(
      mkMission("mD", "packs/mD/pack.md"),
      packFixture,
      logFixture,
      personaFixture,
      digestFixture,
    );
    ck.ok(
      "W4-DISPATCH-05 字节确定性：同输入两次组装逐字节相等；digest 缺失整节省略；空日志=纪律段→persona 衔接起头（纪律恒在 offset 0，v1.1.2 四段式）",
      built.ok === true &&
        again.ok === true &&
        built.text === again.text &&
        text.split("【项目 digest").length - 1 === 1 &&        (() => {
          const empty = buildDispatchPrompt(
            mkMission("mD", "packs/mD/pack.md"),
            packFixture,
            "",
            personaFixture,
            null,
          );
          return (
            empty.ok === true &&
            empty.text.startsWith("【纪律（") &&
            !empty.text.includes("【主控尾块轨迹") &&
            !empty.text.includes("【项目 digest") &&
            empty.text.indexOf(personaFixture) > 0 &&
            empty.text.slice(empty.text.indexOf(personaFixture)).startsWith(personaFixture)
          );
        })(),
      { deterministic: built.ok && again.ok && built.text === again.text, digestSections: text.split("【项目 digest").length - 1 },
    );
    const oversized = buildDispatchPrompt(
      mkMission("mD", "packs/mD/pack.md"),
      packFixture,
      logFixture,
      "x".repeat(30000),
      null,
    );
    ck.ok(
      "W4-DISPATCH-06 字节预算闸：组装结果 >30000 字符 → ok:false（32767 CreateProcess 硬限前置）",
      oversized.ok === false && /超预算/.test(oversized.error) && /30000/.test(oversized.error),
      oversized.error,
    );
    // ---- v1.4 W1 A1 免烘机制五腿（A1-01..05；design v1.4 §1.1+§2.1，落点=dispatch-pure）----
    // typed 第 7 可缺省参（缺省 false=现行为全烘字节一致）；typed∧nested（scoping.mode 传位）→
    // persona 段=两行指针行（personaText 传位改为 resolveDispatchPersona 返回的绝对路径）；
    // typed∧headless → 恒全文；回执 persona 旗标（"pointer"|"full"）恒在。
    {
      const missionTyped = { id: "mD", agent_type: "orch-worker", pack: { path: "packs/mD/pack.md" } };
      // A1-01：typed 缺省=false=现行为字节一致（W4-DISPATCH-05 夹具基回归）
      const defA = buildDispatchPrompt(mkMission("mD", "packs/mD/pack.md"), packFixture, logFixture, personaFixture, digestFixture);
      const defB = buildDispatchPrompt(mkMission("mD", "packs/mD/pack.md"), packFixture, logFixture, personaFixture, digestFixture, null, false);
      ck.ok(
        "A-V0140-A1-01 typed 缺省 false=现行为字节一致：六参调用与显式 typed:false 逐字节相等、persona 段全烘（W4-DISPATCH-05 夹具基）、回执旗标=full",
        defA.ok === true && defB.ok === true &&
          defA.text === defB.text &&
          defA.text === built.text &&
          defA.text.includes(personaFixture) &&
          !defA.text.includes("已随 subagent_type 加载") &&
          defA.persona === "full" && defB.persona === "full",
        { same: defA.ok && defB.ok && defA.text === defB.text && defA.text === built.text, persona: defA.persona },
      );
      // A1-02：typed:true+nested → 两行指针行（subagent_type/Read 字面+绝对路径+role 名；角色正文零烘入）
      const absFixture = path.resolve(BASE.root, "agents", "orch-worker.md");
      const ptr = buildDispatchPrompt(missionTyped, packFixture, logFixture, absFixture, digestFixture, { absent: 0, mode: "nested" }, true);
      const ptrExpect =
        `【职责】本 mission 角色=orch-worker；角色定义已随 subagent_type 加载（定义文件=${absFixture}）。\n` +
        "若本会话未加载角色定义（GP 通道降级面），先 Read 上列定义文件再继续。";
      const ptrIdx = ptr.ok ? ptr.text.indexOf("【职责】本 mission 角色=") : -1;
      const ptrSection = ptr.ok && ptrIdx >= 0 ? ptr.text.slice(ptrIdx, ptr.text.indexOf("先 Read 任务包")).trim() : "";
      ck.ok(
        "A-V0140-A1-02 typed:true+nested 指针行：persona 段=两行指针逐字（subagent_type/Read 字面+绝对路径+role 名）；角色正文首行零烘入；旗标=pointer",
        ptr.ok === true &&
          path.isAbsolute(absFixture) &&
          ptrSection === ptrExpect &&
          !ptr.text.includes(personaFixture) &&
          ptr.persona === "pointer",
        { okFlag: ptr.ok, sectionHead: ptrSection.slice(0, 60), persona: ptr.persona },
      );
      // A1-03：typed:true+headless → persona 恒全文（-p 无 subagent_type 加载面，语义不变）
      const hl = buildDispatchPrompt(missionTyped, packFixture, logFixture, personaFixture, digestFixture, { absent: 0, mode: "headless" }, true);
      ck.ok(
        "A-V0140-A1-03 typed:true+headless 恒 full：persona 全文烘入（headless 语义不变）、指针行零出现、旗标=full",
        hl.ok === true &&
          hl.persona === "full" &&
          hl.text.includes(personaFixture) &&
          !hl.text.includes("已随 subagent_type 加载"),
        { persona: hl.persona, baked: hl.ok && hl.text.includes(personaFixture) },
      );
      // A1-04：回执 persona 旗标恒在，且与实际形态一致（缺省=full）
      const dfltNested = buildDispatchPrompt(mkMission("mD", "packs/mD/pack.md"), packFixture, logFixture, personaFixture, digestFixture, { absent: 0, mode: "nested" });
      ck.ok(
        "A-V0140-A1-04 回执 persona 旗标恒在：缺省调用=full、typed∧nested=pointer、typed∧headless=full（三态与实际组装形态一致）",
        dfltNested.ok === true && dfltNested.persona === "full" &&
          ptr.persona === "pointer" && hl.persona === "full" &&
          defA.persona === "full",
        { dflt: dfltNested.persona, ptr: ptr.persona, hl: hl.persona },
      );
      // A1-05：指针行路径同源=resolveDispatchPersona 返回值（role 腿=安装根绝对路径）；
      // 接线静态钉=tool-dispatch 调用点 personaPointerMode ? personaFile : personaText（同源传位）。
      const roleLegPath = path.join(PLUGIN_DIR, "agents", "orch-worker.md");
      const tdSrc = fs.readFileSync(path.join(PLUGIN_DIR, "mcp", "tool-dispatch.mjs"), "utf8").replace(/\r\n/g, "\n");
      const wired = tdSrc.includes("personaPointerMode ? personaFile : personaText");
      const ptrSrc = buildDispatchPrompt(missionTyped, packFixture, logFixture, roleLegPath, digestFixture, { absent: 0, mode: "nested" }, true);
      ck.ok(
        "A-V0140-A1-05 指针行路径同源：role 腿=resolveDispatchPersona 安装根绝对路径（<插件根>/agents/<role>.md）逐字嵌入指针行；≠ projectDir 相对拼接（路径以 resolveDispatchPersona 返回值传位，接线静态钉在位）",
        path.isAbsolute(roleLegPath) && fs.existsSync(roleLegPath) &&
          ptrSrc.ok === true &&
          ptrSrc.text.includes(`定义文件=${roleLegPath}）`) &&
          !tdSrc.includes('path.resolve(projectDir, "agents"') &&
          wired,
        { roleLeg: roleLegPath, wired, embedded: ptrSrc.ok && ptrSrc.text.includes(`定义文件=${roleLegPath}）`) },
      );
    }
    // ---- v1.2.2 LSN（教训转投节）+ TRC（滞回读侧）：design v2 §4。LSN fixture 节头
    // 自 server.mjs 源码提取 buildPackMarkdown 真实渲染字面（CT 契约纵深，QA-R1 M-5）；
    // mkPack 本体不加节（W4-PREFIX-01 head 恒同面免查项，QA-R1 L-3）。
    {
      // v1.3 切分重基（修复轮 D）：LESSONS 节头渲染字面已迁 mcp/tool-pack.mjs，读取面走
      // server 族 helper（入口+模块族拼接，lf 归一），正则与期望值零改动。
      const srvSrc = familySource(PLUGIN_DIR, path.join("mcp", "server.mjs"), { lf: true });
      const lessonsHeaderReal = (srvSrc.match(/"(## LESSONS（[^"]*)"/) || [])[1] || "";
      const lessonsBody = [
        "- [pitfall·l-lsn] 触发：教训条目一（LSN-01 fixture）",
        "  修正：缩进续行逐字保留",
        "- [error-fix·l-lsn2] 触发：教训条目二",
        "  修正：条目二修正行",
        "ts: 教训内协议形状行不被剥离（LSN-04 纯度）",
      ].join("\n");
      const lessonsPackText = packFixture + "\n\n" + lessonsHeaderReal + "\n" + lessonsBody + "\n";
      const lessonsFence = dispatchPure.DISPATCH_LESSONS_FENCE || "【相关教训（";
      const builtL = buildDispatchPrompt(
        mkMission("mD", "packs/mD/pack.md"),
        lessonsPackText,
        logFixture,
        personaFixture,
        digestFixture,
      );
      const tL = builtL.ok ? builtL.text : "";
      const expectedLessons = [lessonsFence, ...lessonsBody.split("\n"), ""].join("\n");
      ck.ok(
        "LSN-01 有节包：教训转投 fence 在位，节体与包 LESSONS 节逐字等值（含 id 行+缩进续行）；fixture 节头=buildPackMarkdown 真实渲染字面（CT 纵深）",
        builtL.ok === true &&
          lessonsHeaderReal.startsWith("## LESSONS（") &&
          tL.includes(lessonsFence) &&
          tL.includes(expectedLessons),
        { headerFromServer: lessonsHeaderReal.slice(0, 24), fenceHit: tL.includes(lessonsFence) },
      );
      {
        const none = buildDispatchPrompt(mkMission("mD", "packs/mD/pack.md"), packFixture, logFixture, personaFixture, null);
        const blank = buildDispatchPrompt(
          mkMission("mD", "packs/mD/pack.md"),
          packFixture + "\n\n" + lessonsHeaderReal + "\n\n",
          logFixture,
          personaFixture,
          null,
        );
        ck.ok(
          "LSN-02 无节/空节包：整节省略（CR-04）——无节包与「节头+空行」空节包均不渲染教训节",
          none.ok === true &&
            !none.text.includes(lessonsFence) &&
            blank.ok === true &&
            !blank.text.includes(lessonsFence),
          { noneOk: none.ok, blankOk: blank.ok },
        );
      }
      const oL = ["【纪律（", "【主控尾块轨迹", "【项目 digest", "【相关教训（", "【哨兵 scoping", "# persona 原型", "先 Read 任务包 packs/mD/pack.md"].map((s) => tL.indexOf(s));
      ck.ok(
        "LSN-03 位次锚（七锚序）：纪律<trace<digest<lessons<scoping<persona<pointer（教训节=digest 后、scoping 恒在行前，design §2-②）",
        builtL.ok === true &&
          oL[0] === 0 &&
          oL.every((v) => v >= 0) &&
          oL.every((v, k) => k === 0 || v > oL[k - 1]),
        { order: oL },
      );
      ck.ok(
        "LSN-04 转投纯度：节体零加工——协议形状行（ts: …）原样保留+缩进续行逐字在位（字节等值由 LSN-01 expectedLessons 承载）",
        tL.includes("ts: 教训内协议形状行不被剥离（LSN-04 纯度）") &&
          tL.includes("  修正：缩进续行逐字保留"),
        { tsShaped: tL.includes("ts: 教训内协议形状行不被剥离（LSN-04 纯度）") },
      );
      const mkMany = (n) => Array.from({ length: n }, (_, k) => v2(k + 1)).join("\n\n");
      const t15 = buildDispatchPrompt(mkMission("mD", "packs/mD/pack.md"), packFixture, mkMany(15), personaFixture, null);
      ck.ok(
        "TRC-01 15 块日志 → 全量 15（≤20 全量腿）",
        t15.ok === true && t15.blocks === 15 && t15.text.includes("next: next-01") && t15.text.includes("next: next-15"),
        { blocks: t15.blocks },
      );
      const t25 = buildDispatchPrompt(mkMission("mD", "packs/mD/pack.md"), packFixture, mkMany(25), personaFixture, null);
      const tr25 = t25.ok ? t25.text.slice(0, t25.text.indexOf("# persona 原型")) : "";
      ck.ok(
        "TRC-02 25 块日志 → 尾 10 且第 16 块在位（防 slice(-9) 假绿）",
        t25.ok === true &&
          t25.blocks === 10 &&
          tr25.includes("next: next-16") &&
          tr25.includes("next: next-25") &&
          !tr25.includes("next: next-15") &&
          !tr25.includes("next: next-01"),
        { blocks: t25.blocks },
      );
      const t20 = buildDispatchPrompt(mkMission("mD", "packs/mD/pack.md"), packFixture, mkMany(20), personaFixture, null);
      ck.ok(
        "TRC-04 恰 20 块 → 全量 20（≤ 边界腿，严格大于语义）",
        t20.ok === true && t20.blocks === 20 && t20.text.includes("next: next-01") && t20.text.includes("next: next-20"),
        { blocks: t20.blocks },
      );
      const t21 = buildDispatchPrompt(mkMission("mD", "packs/mD/pack.md"), packFixture, mkMany(21), personaFixture, null);
      const tr21 = t21.ok ? t21.text.slice(0, t21.text.indexOf("# persona 原型")) : "";
      ck.ok(
        "TRC-05 恰 21 块 → 尾 10（> 边界+尾部保真腿：第 12 块在位、第 11 块不现）",
        t21.ok === true &&
          t21.blocks === 10 &&
          tr21.includes("next: next-12") &&
          tr21.includes("next: next-21") &&
          !tr21.includes("next: next-11") &&
          !tr21.includes("next: next-01"),
        { blocks: t21.blocks },
      );
      const oversizedT = buildDispatchPrompt(mkMission("mD", "packs/mD/pack.md"), packFixture, logFixture, "x".repeat(30000), null);
      ck.ok(
        "TRC-03 超预算错误文案含滞回新措辞「滞回 20/裁 10」（编号全稿唯一，QA-R1 L-1）",
        oversizedT.ok === false && /滞回 20\/裁 10/.test(oversizedT.error),
        oversizedT.error,
      );
    }
    // ---- W4-PREFIX（v1.1.1 W21 重写→v1.1.2 I1 四段式改写）：fallback 前缀锚=纪律段 + 组装确定性（夹具 v2 形） ----
    // 宿主 Agent 降级通道（RP-3）不再有共享头/粘贴面：无日志无 digest 时首条消息=纪律段（offset 0 恒同）+
    // persona 段 + 指针句 + CONTRACT 三行；同窗口内纪律段恒同，任务面随 pack/worker 变化。
    const personaReal = fs
      .readFileSync(path.join(PLUGIN_DIR, "agents", "orch-worker.md"), "utf8")
      .replace(/\r\n/g, "\n")
      .trimEnd();
    const pf1 = buildDispatchPrompt(
      mkMission("mB2", "packs/mB2/pack-v1.md"),
      mkPack("mB2", "swarm#7-v1", "0123456789abcdef0123456789abcdef"),
      "",
      personaReal,
      null,
    );
    const pf2 = buildDispatchPrompt(
      mkMission("mB2", "packs/mB2/pack-v2.md"),
      mkPack("mB2", "swarm#7-v2", "0123456789abcdef0123456789abcdef"),
      "",
      personaReal,
      null,
    );
    // v1.1.2 I1（四段式重组）：恒同面前移——fallback 前缀锚=纪律段（offset 0 恒在，全角色同文），
    // persona 起为职责段；无日志无 digest 时首条消息=纪律段 + persona + 指针句 + CONTRACT 三行。
    const personaAt1 = pf1.ok ? pf1.text.indexOf(personaReal) : -1;
    const head1 = pf1.ok ? pf1.text.slice(0, personaAt1) : "";
    const head2 = pf2.ok ? pf2.text.slice(0, pf2.text.indexOf(personaReal)) : "";
    const tailRegex = /^先 Read 任务包 [^\n]+\n\[channel\] mB2\n\[worker\] [^\n]+\n\[token\] [0-9a-f]{32}$/;
    ck.ok(
      "W4-PREFIX-01 fallback 前缀锚=纪律段（v1.1.2 offset 0 恒同面前移）：两派发（不同 pack/worker）纪律段前缀逐字节相等，任务面尾部各异",
      pf1.ok === true &&
        pf2.ok === true &&
        head1.startsWith("【纪律（") &&
        head1 === head2 &&
        pf1.text.slice(personaAt1).startsWith(personaReal) &&
        pf1.text !== pf2.text,
      { headLen: head1.length, t1: pf1.ok ? pf1.text.slice(0, 40) : pf1.error },
    );
    ck.ok(
      "W4-PREFIX-02 fallback 尾块形制：指针句先行、[channel] 紧随、[worker]/[token] 收尾（CONTRACT 三行自包解析；persona 段后随行，形制不变）",
      pf1.ok === true &&
        personaAt1 >= 0 &&
        tailRegex.test(pf1.text.slice(personaAt1 + personaReal.length + 2)),
      { tail: pf1.ok ? pf1.text.slice(personaAt1 + personaReal.length + 2).split("\n").slice(0, 2) : pf1.error },
    );
    const logNext = v2(7, { ts: "2026-10-26T04:00:00.000Z", next: "跑三基线+run-all 收口" });
    const logPrev = v2(6, { ts: "2026-10-25T04:00:00.000Z", next: "跑三基线+run-all 收口" });
    const w1 = buildDispatchPrompt(mkMission("mB2", "packs/mB2/pack-v1.md"), mkPack("mB2", "swarm#7-v1", "0123456789abcdef0123456789abcdef"), logPrev, personaReal, null);
    const w2 = buildDispatchPrompt(mkMission("mB2", "packs/mB2/pack-v1.md"), mkPack("mB2", "swarm#7-v1", "0123456789abcdef0123456789abcdef"), logNext, personaReal, null);
    ck.ok(
      "W4-PREFIX-03 跨窗口（仅 ts/seq 协议行变）：首条消息逐字节不变（协议字段不入注入面）→ 前缀命中",
      w1.ok === true && w2.ok === true && w1.text === w2.text && !/^(ts|seq): /m.test(w1.text.slice(0, w1.text.indexOf(personaReal))),
      { same: w1.ok && w2.ok && w1.text === w2.text },
    );
    const w3 = buildDispatchPrompt(
      mkMission("mB2", "packs/mB2/pack-v1.md"),
      mkPack("mB2", "swarm#7-v1", "0123456789abcdef0123456789abcdef"),
      v2(8, { next: "下一波施工" }),
      personaReal,
      null,
    );
    const discFace = (s) => s.indexOf("【主控尾块轨迹");
    ck.ok(
      "W4-PREFIX-03b 跨窗口（业务字段 next 变）：恒同面=纪律段前缀（v1.1.2 offset 0，轨迹起各派发分叉属预期非错误）",
      w3.ok === true &&
        w3.text !== w1.text &&
        w1.text.slice(0, discFace(w1.text)) === w3.text.slice(0, discFace(w3.text)) &&
        w1.text.slice(0, discFace(w1.text)).startsWith("【纪律（") &&
        w3.text.slice(discFace(w3.text)) !== w1.text.slice(discFace(w1.text)),
      { diff: w3.ok && w3.text !== w1.text, discLen: discFace(w1.text) },
    );
    {
      // v1.3 切分重基（修复轮 D）：标记区已迁 mcp/tool-dispatch.mjs，扫描读面随迁（模块文件直读）。
      const src = fs.readFileSync(path.join(PLUGIN_DIR, "mcp", "tool-dispatch.mjs"), "utf8");
      const i = src.indexOf("/* BUILD-DISPATCH-PURE-BEGIN");
      const j = src.indexOf("/* BUILD-DISPATCH-PURE-END */");
      const region = i >= 0 && j > i ? src.slice(i, j) : "";
      ck.ok(
        "W4-PREFIX-04 组装确定性静态锁：纯区内零 Date/Date.now/随机源（同输入必同字节；W21 SKILL 静态面归 po-static）",
        region.length > 0 && !/new Date\(|Date\.now\(|Math\.random\(/.test(region),
        { regionBytes: region.length, hasDate: /new Date\(|Date\.now\(/.test(region) },
      );
    }
    // ---- v1.1.2 I1 新增三腿（D2 §6 断言处置表 v2：新增-1/2/3，防漂移锁） ----
    {
      const fence = dispatchPure.DISPATCH_DISCIPLINE_FENCE || "";
      const body = dispatchPure.DISPATCH_DISCIPLINE_BODY || "";
      const rows = body.match(/^\| [1-9] \| /gm) || [];
      const row10 = body.includes("\n| 10 | ");
      const row11 = body.includes("\n| 11 | 尾块态上报");
      const row12 = body.includes("\n| 12 | 编辑效率");
      ck.ok(
        "W4-DISPATCH-10 纪律段章号锁（新增-1，沿 C1-09 型制；v1.2 M6-2 扩 11 行；v1.2.1 第 9 条改写+主控追加第 12 条）：fence 置顶常量在位，表格 12 行齐（| 1 |..| 12 |），每行携 SKILL 章号权威，第 9 条=P2P 默认工作通道，第 11 条=尾块态上报，第 12 条=编辑效率",
        fence.startsWith("【纪律（") &&
          fence.includes("与包 RULES 冲突时以包 RULES 为准") &&
          rows.length === 9 &&
          row10 &&
          row11 &&
          row12 &&
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].every((n) => body.includes(`\n| ${n} | `)) &&
          (body.match(/SKILL 第 \d+/g) || []).length >= 12 &&
          body.includes("| 9 | P2P 是默认工作通道之一"),
        { rows: rows.length, row10, row11, row12, fenceHead: fence.slice(0, 20) },
      );
      const noDigest = buildDispatchPrompt(
        mkMission("mD", "packs/mD/pack.md"),
        packFixture,
        logFixture,
        personaFixture,
        null,
      );
      const nd = noDigest.ok ? noDigest.text : "";
      ck.ok(
        "W4-DISPATCH-11 衔接序锁（新增-2）：digest 缺省且日志在=纪律→轨迹两段衔接（offset 0=纪律 fence，无 digest 节）",
        noDigest.ok === true &&
          nd.startsWith(fence) &&
          nd.indexOf("【主控尾块轨迹") > 0 &&
          nd.indexOf("【主控尾块轨迹") < nd.indexOf("# persona 原型") &&
          !nd.includes("【项目 digest"),
        { discipline: nd.startsWith(fence), traceAt: nd.indexOf("【主控尾块轨迹") },
      );
      ck.ok(
        "W4-DISPATCH-12 P2P 条字面锁（新增-3，裁定 4 防漂移）：纪律段含「p2p_ask/p2p_answer」与「blocked/question」字面+补注回退句",
        body.includes("p2p_ask/p2p_answer") &&
          body.includes("blocked/question") &&
          body.includes("P2P 补注：") &&
          body.includes("stdio 直连"),
        { hasAsk: body.includes("p2p_ask/p2p_answer"), hasBq: body.includes("blocked/question") },
      );
      ck.ok(
        "W4-DISPATCH-13 循环形态条字面锁（v1.2.1 按 aggregated §4.4④ 升格改写，前值=迭代闭环条 2026-10-26 MaimaiBOT R3）：第 10 条在位——配对循环默认形态/milestone 保持 running/意见吸收后 done/done=退出/回落开新轮",
        body.includes("以下 12 条纪律") &&
          body.includes("配对循环是默认工作形态") &&
          body.includes("report(kind=milestone) 保持 running") &&
          body.includes("全部意见吸收并通过自验后 report(kind=done)") &&
          body.includes("done=退出循环") &&
          body.includes("后续 p2p 将无人应答") &&
          body.includes("回落=等主控开新轮 mission"),
        { has12: body.includes("以下 12 条纪律"), hasLoop: body.includes("配对循环是默认工作形态") },
      );
      ck.ok(
        "W4-DISPATCH-14 尾块态上报条字面锁（v1.2 M6-2，O13=a 执行面拷贝）：第 11 条携三要素（结论/计数/产物指针）+文件直投/邮箱两形态+不塞 details+主控只转指针+done 缺产物指针=无效上报，权威=SKILL 第 17 章（主控信息面）",
        body.includes("尾块态上报：子代理→主控的 report 只载尾块态（结论/计数/产物指针）") &&
          body.includes("经文件直投（对接方按指针自取）或邮箱传递") &&
          body.includes("不塞 details") &&
          body.includes("主控 steer/转发只转指针") &&
          body.includes("done 缺产物指针=无效上报") &&
          body.includes("SKILL 第 17 章（主控信息面）"),
        {
          triad: body.includes("尾块态上报：子代理→主控的 report 只载尾块态（结论/计数/产物指针）"),
          direct: body.includes("经文件直投（对接方按指针自取）或邮箱传递"),
          noDetails: body.includes("不塞 details"),
          ptrOnly: body.includes("主控 steer/转发只转指针"),
          noPtrInvalid: body.includes("done 缺产物指针=无效上报"),
          auth: body.includes("SKILL 第 17 章（主控信息面）"),
        },
      );
    }
  }
}
