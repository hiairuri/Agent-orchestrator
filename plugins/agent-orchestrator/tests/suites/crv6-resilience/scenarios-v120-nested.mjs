// @module crv6-resilience/scenarios-v120-nested
/*!
 * suites/crv6-resilience/scenarios-v120-nested.mjs —— v1.2 M5-1 dispatch 组装出口场景 NST
 * （2026-11-01 拆分自 crv6-resilience.mjs：A-v0120-NST-01..04。断言体逐字搬运零改动，
 * 仅外包 async 函数供入口按序聚合。）
 */
import fs from "node:fs";
import path from "node:path";
import {
  ck,
  resultText,
  subRoot,
  startServer,
  PLUGIN_DIR,
} from "./fixtures.mjs";
import { familySource } from "../../harness/source-family.mjs";

export async function runV120NestedScenarios() {
/* ============ 场景 NST：v1.2 M5-1 dispatch 组装出口 mode=nested（A-v0120-NST） ============ */
/* 不 spawn 进程、返四元组（组包链复用）；busy 闸板语义分叉；内嵌校验；纪律第 11 条
   自动携带；触发面②接线。nested 分支测试免哨兵进程噪声：预种活槽位（pid=测试进程
   +新鲜心跳）使 ensureSentinelFamily 探活 no-op。 */
{
  const grp = (t) => ck.ok(t, true, "");
  const nstBase = subRoot("nst");
  const nstPersona = path.join(PLUGIN_DIR, "agents", "orch-worker.md");
  /** 手写包（NST-03 token 失配/缺 CONTRACT 形态用——绕开 context_pack 铸发链）。 */
  const nstHandPack = (channel, token, withContract) =>
    [
      `# 任务包：NST 手写包（${channel}）`,
      "",
      ...(withContract
        ? ["## CONTRACT（三行契约）", "", `[channel] ${channel}`, "[worker] gp-nst#1", `[token] ${token}`, ""]
        : []),
      "## TASK",
      "nested 组装出口断言桩包。",
      "",
    ].join("\n");
  const nstUpsert = (sX, id) =>
    sX.call("board", {
      action: "upsert",
      mission: { id, title: id, status: "drafted", agent_type: "agent-orchestrator:orch-worker", scope_paths: ["src/"] },
    });
  const seedLiveSlot = (rt) => {
    fs.mkdirSync(path.join(rt, "sentinel"), { recursive: true });
    fs.writeFileSync(
      path.join(rt, "sentinel", "instance-0.json"),
      JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }) + "\n",
    );
  };

  // ---- NST-01 组装出口 e2e：组包链复用+四元组+记账+纪律携带+零 spawn ----
  {
    const dir = path.join(nstBase, "nst1");
    const rt = path.join(dir, "troot");
    seedLiveSlot(rt); // 先建 sentinel/ 目录（coord-session 锚同目录）
    fs.writeFileSync(path.join(rt, "sentinel", "coord-session.txt"), "sess_coord_nst\n");
    const rollout = path.join(dir, "rollout");
    fs.mkdirSync(rollout, { recursive: true });
    const sX = startServer({ root: rt, env: { ORCH_ROLLOUT_DIR: rollout } });
    try {
      await nstUpsert(sX, "m-nst1");
      const packed = resultText(
        await sX.call("context_pack", { mission_id: "m-nst1", title: "nst 组装出口探针", task: "nested 组装链复用验证" }),
      );
      const r = resultText(await sX.call("dispatch", { mission_id: "m-nst1", mode: "nested" }));
      const absOf = (p) => (path.isAbsolute(String(p)) ? String(p) : path.join(rt, String(p))); // displayPath 根相对
      ck.ok(
        "NST-01a 组装出口四元组+组包链复用：ok/mode=nested/mission_id 齐备，token ≡ context_pack 铸发值" +
          "（包 CONTRACT 同源；pack_path=mission.pack.path 解析，pack.md 唯一世界零新协议）",
        r.ok === true && r.mode === "nested" && r.mission_id === "m-nst1" &&
          r.token === packed.token && typeof r.prompt === "string" && r.prompt.length > 0 &&
          typeof r.pack_path === "string" && fs.existsSync(absOf(r.pack_path)),
        { ok: r.ok, mode: r.mode, token: r.token, packed: packed.token, pack_path: r.pack_path },
      );
      ck.ok(
        "NST-01b prompt 形状（内嵌 CONTRACT 三行+指针句+纪律段含第 11 条）：组装出口纪律注入段自动携带" +
          "（消费 M6-2 DISPATCH_DISCIPLINE_BODY，11 条随 prompt 进 worker 上下文）",
        r.prompt.includes("[channel] m-nst1") && r.prompt.includes(`[token] ${packed.token}`) &&
          r.prompt.includes("先 Read 任务包") && r.prompt.includes("【纪律（全角色通用编排纪律") &&
          r.prompt.includes("尾块态上报"),
        { head: String(r.prompt).slice(0, 80), tail: String(r.prompt).slice(-120) },
      );
      ck.ok(
        "NST-01c 审计 prompt 落盘与回执同文（dispatch-logs 同命名族——组装事实时间锚）",
        typeof r.prompt_path === "string" && fs.existsSync(absOf(r.prompt_path)) &&
          fs.readFileSync(absOf(r.prompt_path), "utf8") === r.prompt,
        r.prompt_path,
      );
      const board = JSON.parse(fs.readFileSync(path.join(rt, "board.json"), "utf8"));
      const dm = board.missions.find((m) => m.id === "m-nst1");
      ck.ok(
        "NST-01d 记账：drafted→dispatched 自动 + dispatch.mode=nested + spawned_by_session=coord 锚" +
          "（W3 归因消费面）+ agent_id 留空（主控在场直收，哨兵默认不盯 §5.2.4）",
        dm && dm.status === "dispatched" && dm.dispatch && dm.dispatch.mode === "nested" &&
          dm.dispatch.spawned_by_session === "sess_coord_nst" && dm.dispatch.agent_id === null,
        { status: dm && dm.status, dispatch: dm && dm.dispatch },
      );
      const rolloutFiles = fs.existsSync(rollout) ? fs.readdirSync(rollout) : [];
      const resDir = path.join(rt, "context", "dispatch-results");
      ck.ok(
        "NST-01e 零 spawn 实锤：无 model-io（rollout 净空）、无 dispatch-results 目录、" +
          "回执无 session_id/model_seed/result_dir（-p 专属字段整体缺席）",
        rolloutFiles.length === 0 && !fs.existsSync(resDir) &&
          r.session_id === undefined && r.model_seed === undefined && r.result_dir === undefined,
        { rolloutFiles, resDirExists: fs.existsSync(resDir), keys: Object.keys(r) },
      );
    } finally {
      sX.close();
    }
  }

  // ---- NST-02 busy 闸分叉（板语义，不消费 result-dir index）----
  {
    const dir = path.join(nstBase, "nst2");
    const rt = path.join(dir, "troot");
    seedLiveSlot(rt);
    const sX = startServer({ root: rt, env: {} });
    try {
      await nstUpsert(sX, "m-nst2");
      await sX.call("context_pack", { mission_id: "m-nst2", title: "nst busy 分叉探针", task: "busy 闸板语义" });
      const r1 = resultText(await sX.call("dispatch", { mission_id: "m-nst2", mode: "nested" }));
      const rb = await sX.call("dispatch", { mission_id: "m-nst2", mode: "nested" });
      ck.ok(
        "NST-02a nested 在飞拒二次组装：dispatched+nested（worker 结果未落板）→ isError，文案含 nested busy 闸" +
          "与恢复指引（板语义在飞=凭据已交付主控）",
        r1.ok === true && rb.isError === true && /busy 闸（nested）/.test(rb.text) && /drafted/.test(rb.text),
        { ok: r1.ok, err: rb.text.slice(0, 140) },
      );
      const rd = await sX.call("dispatch", { mission_id: "m-nst2" }); // 缺省 mode=headless 同拒
      ck.ok(
        "NST-02b 分叉按 mission.mode 判非按请求 mode：nested 在飞 mission 用缺省 headless 重派同拒" +
          "（防绕道 -p 双发）",
        rd.isError === true && /busy 闸（nested）/.test(rd.text),
        rd.text.slice(0, 140),
      );
      const rec = await sX.call("board", { action: "upsert", mission: { id: "m-nst2", status: "drafted" } });
      const r2 = resultText(await sX.call("dispatch", { mission_id: "m-nst2", mode: "nested" }));
      const resDir = path.join(rt, "context", "dispatch-results");
      ck.ok(
        "NST-02c 不消费 result-dir index+恢复路径：dispatched→drafted（合法腿）后重派 nested 成功——" +
          "全程零 index 零 dispatch-results（同形态 headless 被 DSP-05d 拒，nested 走板语义）",
        rec.isError !== true && r2.ok === true && r2.mode === "nested" && !fs.existsSync(resDir),
        { rec: rec.isError, ok: r2.ok, resDir: fs.existsSync(resDir) },
      );
    } finally {
      sX.close();
    }
  }

  // ---- NST-03 内嵌校验（token 鉴权 p2pTokenGate 同语义 + CONTRACT 三行强制）----
  {
    const dir = path.join(nstBase, "nst3");
    const rt = path.join(dir, "troot");
    seedLiveSlot(rt);
    const sX = startServer({ root: rt, env: {} });
    try {
      // 03a token 失配：context_pack 铸板 token 后包文件被陈旧化（token 异源）→ 组装出口拒。
      // 注：resolveDispatchPack 以 mission.pack.path 为首级——陈旧化就地对 mission.pack.path
      // 指向的包文件覆写（真实陈旧包形态），不走低优先级 pack_path。
      await nstUpsert(sX, "m-nst3");
      const packed3 = resultText(
        await sX.call("context_pack", { mission_id: "m-nst3", title: "nst token 闸探针", task: "token 鉴权" }),
      );
      const stalePack = path.join(rt, "packs", "m-nst3", "pack.md");
      fs.writeFileSync(stalePack, nstHandPack("m-nst3", "nst-stale-token-0001", true));
      const ra = await sX.call("dispatch", { mission_id: "m-nst3", mode: "nested" });
      ck.ok(
        "NST-03a token 鉴权内嵌：包 CONTRACT token ≠ mission.dispatch.token → isError（陈旧包/异源包" +
          "在组装面即拒——worker report/p2p 闸 expected token 前置一致）",
        ra.isError === true && /token 鉴权不过/.test(ra.text),
        { err: ra.text.slice(0, 140), packed: packed3.token },
      );
      // 03b CONTRACT 缺三行：无 context_pack 的 mission（无 mission.pack.path）→ 显式 pack_path
      // 生效 → buildDispatchPrompt 契约解析失败经组装出口浮出（无板 token 且非 strict → 走到组包闸）。
      await nstUpsert(sX, "m-nst3b");
      const barePack = path.join(dir, "pack-bare.md");
      fs.writeFileSync(barePack, nstHandPack("m-nst3b", "", false));
      const rb = await sX.call("dispatch", { mission_id: "m-nst3b", mode: "nested", pack_path: barePack });
      ck.ok(
        "NST-03b CONTRACT 三行内嵌强制：包缺 [channel]/[worker]/[token] 三行 → isError" +
          "（组装出口不产无契约凭据的 prompt——派发纪律工具面保证 §8.7）",
        rb.isError === true && /CONTRACT 三行解析失败/.test(rb.text),
        rb.text.slice(0, 140),
      );
    } finally {
      sX.close();
    }
  }

  // ---- NST-04 schema/枚举/接线静态锁（活体 strict-tokens 面不可达——harness 不支持
  //      server 额外 CLI 旗标，以源码钉承接；strictTokens 拒收分支与 report/p2p 闸同款）----
  // v1.3 切分重基（修复轮 D）：schema 双面迁 mcp/server-registry.mjs、nested 接线+strict 拒收
  // 分支迁 mcp/tool-dispatch.mjs，读取面走 server 族 helper（族拼接恰 2 计数=拆分前单文件同值）。
  {
    const src = familySource(PLUGIN_DIR, path.join("mcp", "server.mjs"));
    ck.ok(
      "NST-04a schema 两面：board 工具 dispatch.mode 枚举加 nested（W3 headless 不动）+" +
        "dispatch 工具 inputSchema mode enum [headless, nested]",
      src.includes('mode: { enum: ["agent", "workflow", "headless", "nested"] }') &&
        /mode:\s*\{[\s\S]{0,80}enum:\s*\["headless", "nested"\]/.test(src),
      "",
    );
    ck.ok(
      "NST-04b 触发面②接线：nested 分支内 ensureSentinelFamily() 调用在源（「无哨兵不派发」" +
        "组装出口同探活，M9-1 既有实现复用）+ strictTokens 拒收分支在组装出口在源",
      /if \(dispatchMode === "nested"\) \{[\s\S]*?ensureSentinelFamily\(\);/.test(src) &&
        /strict-tokens 模式下不接受无派发 token 的组装/.test(src),
      "",
    );
    ck.ok(
      "NST-04c -p 链零触碰结构锁：headless 分支 mode 写点唯一（mode: \"headless\" 字面恰 2 处——" +
        "同步段记账+session 回填，nested 未染指）",
      (src.match(/mode: "headless"/g) || []).length === 2,
      (src.match(/mode: "headless"/g) || []).length,
    );
  }
  grp("NST 组收尾（A-v0120-NST 14 断言：组装出口 e2e 五面/busy 分叉三态/内嵌校验两腿/静态锁三钉）");
}
}
