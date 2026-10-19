/*!
 * suites/crv5-apply-envelope.mjs —— v0.6 apply 包络 suite（A1 bootstrap：QUOT/LOCK；A5 波增例 ENV-01..07）
 *
 * 覆盖断言组：A-v060-QUOT-01..03（V6-29 gitRun 注入 -c core.quotepath=false——中文文件名
 *   在册前缀不误杀、真越界仍拒且报错非八进制转义、静态防回退）、
 *   A-v060-LOCK-01..04（V6-15 releaseRootLock pid 归属校验 + V6-33 owner.json wx 重试/
 *   撤销 mkdir——接管后原持有者不删他人锁、正常释放回归、docless 旧锁接管、wx 重试与
 *   无文档不宣布持锁的结构保证）、
 *   A-v060-ENV-01..07（v0.6 A5 方案 b：两阶段 apply_intent_at + git 管线出根锁 + 幂等三态——
 *   慢 merge 期间并发写零忙双存、crash-after-merge 恢复收口、applied_at 幂等补偿、
 *   intent 过期重跑、新鲜窗 busy、teardown 失败降级 worktree_removed:false、
 *   discard×intent 互斥与 applied 胜出、巨板零硬错；V6-08/13/35 一波三案）。
 *   转录自 W-A2 §1/§2 断言草案；suite 注册行归主控 G 胶水波收口（run-all REGISTRY）。
 *
 * 运行方式：node tests/suites/crv5-apply-envelope.mjs [--root <临时根>]
 * 前置：node >= 20；PATH 上有 git（QUOT 沙箱 worktree 物化与 apply 合流；ENV 慢 merge 注入
 *   依赖 pre-merge-commit 钩子，git ≥ 2.11）；无网。ENV-01/07 含 sleep 注入（6s/4s）。
 * v0.6.1 稳定化：ENV-01/07 两慢 merge 场景套内失败重试一次（withRetryOnce——全新临时根+
 *   新 server 重跑，断言集与语义不变，重试整组替换首跑入账；QA m-20261019-042917-43c1
 *   首跑 1 条抖动收编）+ marker 轮询窗 12s→30s（纯轮询容差）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { startServer, Checker, DEFAULT_SERVER } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot, parseRootArg, blankMission } from "../harness/temp-root.mjs";
import { makeRepo } from "../harness/git-fixture.mjs";

const ck = new Checker("crv5-apply-envelope");
const BASE = makeTempRoot({ prefix: "orch-crv5env-", root: parseRootArg() || undefined });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const resultText = (r) => r.json ?? { _raw: r.text };

/* ================= 场景 A：QUOT（中文路径 × 越界门） ================= */
{
  const PROJ = path.join(BASE.root, "proj-quot");
  const T1 = path.join(BASE.root, "root-quot");
  makeRepo({ dir: PROJ, files: { "README.md": "readme\n", "src/a.txt": "a\n", "docs/a.md": "# A\n" } });
  const s = startServer({ root: T1, cwd: PROJ });
  const gitIn = (cwd, args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + (r.stderr || r.stdout));
    return r.stdout;
  };
  const sandboxApplyFlow = async (mid, files) => {
    const pack = await s.call("context_pack", {
      mission_id: mid,
      title: mid + " quotepath 探针",
      task: "验证 gitRun quotepath 修复",
      isolation: "worktree",
      oob_allowlist: ["src"],
    });
    if (pack.isError) throw new Error("context_pack failed: " + pack.text);
    const wt = path.join(T1, "sandboxes", mid);
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.join(wt, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(wt, rel), content);
    }
    gitIn(wt, ["add", "-A"]);
    gitIn(wt, ["commit", "-m", "probe " + mid]);
    // 0.6 A3 契约适配（主控 2026-10-15 批复授权，见 v0.6.x.md §0）：V6-42 起 apply 门槛
    // qa 为评审链结构体——建 mid-rev reviewer mission 互指目标，再回写目标 qa。
    // 0.6 A4 夹具适配（主控批复口径，见 v0.6.x.md §0）：create-as-done / drafted→done
    // 直写被 V6-20 白名单合法拒绝——评审链夹具改直写板种子，断言主句零改动。
    const bp = path.join(T1, "board.json");
    const bf = JSON.parse(fs.readFileSync(bp, "utf8"));
    bf.missions.push(
      blankMission({
        id: mid + "-rev",
        agent_type: "agent-orchestrator:orch-reviewer",
        status: "done",
        qa: { verdict: "pass", mission_id: mid },
      }),
    );
    const fm = bf.missions.find((x) => x && x.id === mid);
    fm.status = "done";
    fm.qa = { verdict: "pass", reviewed_by: mid + "-rev", reviewed_at: new Date().toISOString() };
    fs.writeFileSync(bp, JSON.stringify(bf, null, 2) + "\n");
    return s.call("sandbox_apply", { mission_id: mid });
  };
  try {
    // ---- QUOT-01：在册前缀内的中文文件名 → 不误杀（quotepath=false 使 diff 字面 UTF-8）
    const r1 = await sandboxApplyFlow("m-qt1", { "src/中文新增模块.js": "export const 一 = 1;\n" });
    ck.ok("QUOT-01 src/ 下中文新增文件在册放行（apply ok）", r1.isError !== true && resultText(r1).ok === true, r1.text.slice(0, 160));
    // ---- QUOT-02：真越界中文文件仍拒，且报错文本为字面路径（非 \346 八进制转义）
    const r2 = await sandboxApplyFlow("m-qt2", { "docs/越界中文文档.js": "evil\n" });
    ck.ok("QUOT-02a 越界中文文件仍拒合", r2.isError === true && r2.text.includes("越界"), r2.text.slice(0, 120));
    ck.ok(
      "QUOT-02b 报错文本字面 UTF-8（无八进制转义）",
      r2.text.includes("越界中文文档.js") && !r2.text.includes("\\346"),
      r2.text.split("\n").find((l) => l.includes("docs/")),
    );
    // ---- QUOT-03：静态防回退——gitRun 唯一出口注入 quotepath=false
    const src = fs.readFileSync(DEFAULT_SERVER, "utf8");
    ck.ok("QUOT-03 静态：gitRun 源码含 -c core.quotepath=false", src.includes('"-c", "core.quotepath=false"'), "");
  } finally {
    s.close();
  }
}

/* ================= 场景 B：LOCK（根锁生命周期） ================= */
{
  const T2 = path.join(BASE.root, "root-lock");
  const lockDir = path.join(T2, ".lock");
  // 胖板种子（先于 server 启动落盘）：拉长持锁窗口，给接管/偷锁探针留出确定性竞速余量
  const FAT = "x".repeat(16 * 1024 * 1024);
  fs.mkdirSync(T2, { recursive: true });
  fs.writeFileSync(
    path.join(T2, "board.json"),
    JSON.stringify({ version: 2, updated_at: new Date().toISOString(), missions: [blankMission({ id: "m-fat", original_prompt: FAT })] }) + "\n",
  );
  const s = startServer({ root: T2, cwd: T2 });
  try {
    // ---- LOCK-03（行为面）：docless 陈旧锁（历史 wx 失败遗留形态）→ 接管成功，收尾无残锁
    {
      fs.mkdirSync(lockDir);
      const past = new Date(Date.now() - 60000);
      fs.utimesSync(lockDir, past, past);
      const r = await s.call("board", { action: "upsert", mission: { id: "m-lk3", title: "docless 接管探针" } });
      ck.ok("LOCK-03a docless 陈旧锁被接管、操作成功（不进入临界区死锁）", r.isError !== true && resultText(r).ok === true, r.text.slice(0, 100));
      let gone = false;
      for (let i = 0; i < 100 && !gone; i++) { gone = !fs.existsSync(lockDir); if (!gone) sleep(20); }
      ck.ok("LOCK-03b 接管释放后无残锁", gone);
    }
    // ---- LOCK-01：stale 接管后「原持有者」release 不删接管者的锁
    {
      let done = false;
      for (let attempt = 0; attempt < 3 && !done; attempt++) {
        const staged = path.join(T2, `.lock.steal-${attempt}`);
        fs.mkdirSync(staged);
        fs.writeFileSync(
          path.join(staged, "owner.json"),
          JSON.stringify({ holder: `pid:${process.pid}`, pid: process.pid, heartbeatAt: new Date().toISOString() }) + "\n",
        );
        const op = s.call("board", { action: "upsert", mission: { id: `m-lk1-${attempt}`, title: "偷锁探针" } });
        // 等到 server 已建锁并写下 owner 文档，再把预置的「接管者」目录换入
        let saw = false;
        for (let i = 0; i < 5000 && !saw; i++) { saw = fs.existsSync(path.join(lockDir, "owner.json")); if (!saw) sleep(2); }
        if (!saw) { await op; fs.rmSync(staged, { recursive: true, force: true }); continue; }
        try {
          const victim = path.join(T2, `.lock.victim-${attempt}`);
          fs.renameSync(lockDir, victim);
          fs.renameSync(staged, lockDir); // 接管者落位
          const r = await op; // server 释放时应读到外来 owner → 跳过删除
          ck.ok(`LOCK-01 操作仍成功（attempt ${attempt}）`, r.isError !== true && resultText(r).ok === true, r.text.slice(0, 100));
          const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
          ck.ok("LOCK-01a 原持有者 release 后 .lock 仍在且 owner 为接管者", owner.pid === process.pid, owner.pid);
          ck.ok("LOCK-01b server stderr 提示 skip release", s.stderrTail.join("\n").includes("release skipped (not owner)"), s.stderrTail.slice(-3).join(" | "));
          done = true;
          fs.rmSync(lockDir, { recursive: true, force: true });
          fs.rmSync(victim, { recursive: true, force: true });
        } catch {
          try { await op; } catch { /* already awaited */ }
          fs.rmSync(staged, { recursive: true, force: true });
        }
      }
      ck.ok("LOCK-01 偷锁探针在 3 次尝试内完成", done);
    }
    // ---- LOCK-02：正常持有者 release → 锁清除（回归）
    {
      const r = await s.call("board", { action: "upsert", mission: { id: "m-lk2", title: "正常释放回归" } });
      ck.ok("LOCK-02a 正常路径操作成功", r.isError !== true && resultText(r).ok === true, r.text.slice(0, 100));
      let gone = !fs.existsSync(lockDir);
      for (let i = 0; i < 100 && !gone; i++) { gone = !fs.existsSync(lockDir); if (!gone) sleep(20); }
      ck.ok("LOCK-02b 正常持有者 release 后锁清除", gone);
    }
    // ---- LOCK-03/04（结构面）：wx 重试与「无 owner 文档不宣布持锁」的服务端保证
    {
      const src = fs.readFileSync(DEFAULT_SERVER, "utf8");
      ck.ok("LOCK-04a 结构：owner 文档 wx 写失败重试 3 次", /for \(let wxAttempt = 0; wxAttempt < 3/.test(src), "");
      ck.ok("LOCK-04b 结构：wx 仍失败撤销本次 mkdir（undo our mkdir only）", src.includes("undo our mkdir only"), "");
      ck.ok("LOCK-03c 结构：撤销分支遵守 deadline 并抛存储忙", /ownerWritten[\s\S]{0,600}存储忙，请重试（root lock 等待超时）/.test(src), "");
      ck.ok("LOCK-03d 结构：release 非己锁跳过删除", src.includes("release skipped (not owner)"), "");
    }
  } finally {
    s.close();
  }
}

/* ================= 场景 C..H：ENV（apply 包络波，A5 方案 b 增例） ================= */
{
  const gitC = (cwd, args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + (r.stderr || r.stdout));
    return r.stdout;
  };
  const readT = (T) => JSON.parse(fs.readFileSync(path.join(T, "board.json"), "utf8"));
  const missionIn = (T, mid) => readT(T).missions.find((x) => x && x.id === mid);
  const sbOf = (T, mid) => missionIn(T, mid).pack.sandbox;
  const iso = (offsetMin) => new Date(Date.now() - offsetMin * 60 * 1000).toISOString();
  const waitFor = async (cond, timeoutMs = 12000, step = 50) => {
    const t0 = Date.now();
    for (;;) {
      if (cond()) return true;
      if (Date.now() - t0 > timeoutMs) return false;
      await sleep(step);
    }
  };
  /** done+qa 评审链直写板种子（A3/A4 夹具口径，同场景 A sandboxApplyFlow）。 */
  const seedApplyChain = (T, mid) => {
    const bp = path.join(T, "board.json");
    const bf = JSON.parse(fs.readFileSync(bp, "utf8"));
    bf.missions.push(
      blankMission({
        id: mid + "-rev",
        agent_type: "agent-orchestrator:orch-reviewer",
        status: "done",
        qa: { verdict: "pass", mission_id: mid },
      }),
    );
    const fm = bf.missions.find((x) => x && x.id === mid);
    fm.status = "done";
    fm.qa = { verdict: "pass", reviewed_by: mid + "-rev", reviewed_at: new Date().toISOString() };
    fs.writeFileSync(bp, JSON.stringify(bf, null, 2) + "\n");
  };
  /** 沙箱 mission 备料：context_pack 建 worktree + worker 侧提交改动。 */
  const prepareSandbox = async (s, T, mid, files, oob = ["src"]) => {
    const pack = await s.call("context_pack", {
      mission_id: mid,
      title: mid + " envelope 探针",
      task: "apply envelope probe",
      isolation: "worktree",
      oob_allowlist: oob,
    });
    if (pack.isError) throw new Error("context_pack failed: " + pack.text);
    const wt = path.join(T, "sandboxes", mid);
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.join(wt, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(wt, rel), content);
    }
    gitC(wt, ["add", "-A"]);
    gitC(wt, ["commit", "-m", "probe " + mid]);
    return wt;
  };
  /** 慢 merge 确定性注入：pre-merge-commit 钩子（apply 的 merge --no-ff 必经
   *  merge-commit 创建，即恰落在 phase-2 锁外窗口内）——落 marker 后 sleep。 */
  const slowMergeHook = (projDir, markerPath, seconds) => {
    const hooks = path.join(projDir, ".git", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    const markerSh = markerPath.split(path.sep).join("/");
    fs.writeFileSync(
      path.join(hooks, "pre-merge-commit"),
      '#!/bin/sh\nprintf started > "' + markerSh + '"\nsleep ' + seconds + "\n",
    );
  };

  /* ---- v0.6.1 稳定化（QA m-20261019-042917-43c1 收编：慢 merge 场景高负载时序抖动） ----
   * 场景级失败重试一次：首跑有 fail（或异常）时以全新临时根+新 server 重跑一次，重试结果
   * 整组替换首跑入账（断言集与语义不变，绿时套总数仍 44）；二跑仍红/仍抛=真回归，照常失败。
   * 非 slow-merge 场景不参与（确定性夹具，重试反掩真回归）。marker 轮询窗另放宽 12s→30s
   * （纯轮询容差：断言只认「marker 落盘=phase-2 在飞」，不含时限语义）。 */
  const withRetryOnce = async (label, run) => {
    let attempt;
    try {
      attempt = await run("a");
    } catch (e) {
      attempt = { pass: 0, fails: [label + " 首跑异常"], lines: ["FAIL " + label + " 首跑异常: " + String((e && e.message) || e)] };
    }
    if (attempt.fails.length > 0) {
      console.log("RETRY " + label + " 首跑 " + attempt.fails.length + " fail（时序抖动收编：全新临时根重跑一次）");
      attempt = await run("b"); // 二跑异常照常抛出（真故障须浮出）
    }
    ck.pass += attempt.pass;
    ck.fails.push(...attempt.fails);
    ck.lines.push(...attempt.lines);
  };

  /* ---- 场景 C：ENV-01 慢 merge 期间并发写排队（零 busy / 零接管 / 终板双存） ---- */
  {
    const runEnv01 = async (tag) => {
      const lck = new Checker("crv5-apply-envelope:ENV-01/" + tag);
      const T1 = path.join(BASE.root, "root-env1-" + tag);
      const PROJ1 = path.join(BASE.root, "proj-env1-" + tag);
      const MARKER1 = path.join(BASE.root, "marker-env1-" + tag + ".txt");
      makeRepo({ dir: PROJ1, files: { "README.md": "readme\n", "src/a.txt": "a\n" } });
      slowMergeHook(PROJ1, MARKER1, 6);
      const sA = startServer({ root: T1, cwd: PROJ1 });
      try {
        await prepareSandbox(sA, T1, "m-env1", { "src/env1.js": "export const v = 1;\n" });
        seedApplyChain(T1, "m-env1");
        const sB = startServer({ root: T1, cwd: PROJ1 }); // 第二 server 进程=跨进程并发写者
        try {
          const pA = sA.call("sandbox_apply", { mission_id: "m-env1" }); // 不 await：进入 phase-2
          const markerSeen = await waitFor(() => fs.existsSync(MARKER1), 30000);
          lck.ok("ENV-01a 慢 merge 注入生效（pre-merge-commit marker 落盘=phase-2 在飞）", markerSeen);
          const tB0 = Date.now();
          const rB = await sB.call("board", { action: "upsert", mission: { id: "m-conc1", title: "merge 窗口并发写" } });
          lck.ok(
            "ENV-01b merge 期间第二进程 upsert 成功且零存储忙（旧管线此处 2s 后必忙）",
            rB.isError !== true && !rB.text.includes("存储忙"),
            rB.text.slice(0, 140),
          );
          const midMerge = missionIn(T1, "m-env1");
          lck.ok(
            "ENV-01c 并发写落在 merge 窗口内（apply 尚未收口，m-env1 仍 done）",
            midMerge && midMerge.status === "done" && midMerge.pack.sandbox.apply_intent_at,
            midMerge ? midMerge.status : "missing",
          );
          const rA = await pA;
          lck.ok(
            `ENV-01d apply 收口 ok closed（耗时 ${Date.now() - tB0}ms 量级含 6s merge）`,
            rA.isError !== true && resultText(rA).ok === true && resultText(rA).status === "closed",
            rA.text.slice(0, 140),
          );
          const b1 = readT(T1);
          const conc = b1.missions.find((x) => x && x.id === "m-conc1");
          const applied = b1.missions.find((x) => x && x.id === "m-env1");
          lck.ok(
            "ENV-01e 终板双存：m-conc1 与 m-env1(closed+applied_at) 同板共存（零丢更新=零接管对象）",
            Boolean(conc) && applied && applied.status === "closed" && Boolean(applied.pack.sandbox.applied_at),
            `conc=${Boolean(conc)} applied=${applied && applied.status}`,
          );
        } finally {
          sB.close();
        }
      } finally {
        sA.close();
      }
      return lck;
    };
    await withRetryOnce("ENV-01", runEnv01);
  }

  /* ---- 场景 D：ENV-02 crash 重入两腿 + ENV-03 intent 过期重跑 + ENV-05 新鲜窗 busy ---- */
  {
    const T2 = path.join(BASE.root, "root-env2");
    const PROJ2 = path.join(BASE.root, "proj-env2");
    makeRepo({ dir: PROJ2, files: { "README.md": "readme\n", "src/a.txt": "a\n" } });
    const s = startServer({ root: T2, cwd: PROJ2 });
    try {
      // ---- ENV-02 腿1：intent 后 merge 后 crash（intent 在、分支已合入）→ merge-base 判定直接收口
      await prepareSandbox(s, T2, "m-env2", { "src/env2.js": "export const v = 2;\n" });
      seedApplyChain(T2, "m-env2");
      gitC(PROJ2, ["merge", "--no-ff", "--no-edit", "-m", "orch: apply m-env2", "orch/m-env2"]); // 模拟 crash 前的 merge
      const headBefore = gitC(PROJ2, ["rev-parse", "HEAD"]).trim();
      const bf2 = JSON.parse(fs.readFileSync(path.join(T2, "board.json"), "utf8"));
      bf2.missions.find((x) => x.id === "m-env2").pack.sandbox.apply_intent_at = iso(0); // crash 残留 intent（新鲜）
      fs.writeFileSync(path.join(T2, "board.json"), JSON.stringify(bf2, null, 2) + "\n");
      const r2 = await s.call("sandbox_apply", { mission_id: "m-env2" });
      const j2 = resultText(r2);
      ck.ok(
        "ENV-02a crash-after-merge（intent+已合入）→ merge-base 判定 recovered 收口 closed",
        r2.isError !== true && j2.recovered === true && j2.status === "closed",
        r2.text.slice(0, 160),
      );
      ck.ok("ENV-02b applied_commit 取收口时 HEAD", j2.applied_commit === headBefore, `${j2.applied_commit} vs ${headBefore}`);
      ck.ok("ENV-02c applied_at 已落板（board 与主线收敛）", Boolean(sbOf(T2, "m-env2").applied_at), "");
      // ---- ENV-02 腿2：applied_at 幂等补偿（再次 apply → already_applied，不重跑管线）
      const r2b = await s.call("sandbox_apply", { mission_id: "m-env2" });
      ck.ok(
        "ENV-02d applied_at 幂等补偿：再 apply → already_applied:true ok",
        r2b.isError !== true && resultText(r2b).already_applied === true && resultText(r2b).ok === true,
        r2b.text.slice(0, 120),
      );
      // ---- ENV-02 腿3：applied_at 在而 status 未 closed（旧版崩溃形态种子）→ 补偿关闭
      const bf2c = JSON.parse(fs.readFileSync(path.join(T2, "board.json"), "utf8"));
      bf2c.missions.push(
        blankMission({
          id: "m-env2b",
          status: "done",
          pack: {
            sandbox: {
              isolation: "worktree",
              root: path.join(T2, "sandboxes", "m-env2b"),
              branch: "orch/m-env2b",
              base_commit: "0".repeat(40),
              oob_allowlist: [],
              created_at: iso(1),
              apply_intent_at: null,
              applied_at: iso(0),
              applied_commit: headBefore,
              discarded_at: null,
            },
          },
        }),
      );
      fs.writeFileSync(path.join(T2, "board.json"), JSON.stringify(bf2c, null, 2) + "\n");
      const r2c = await s.call("sandbox_apply", { mission_id: "m-env2b" });
      const j2c = resultText(r2c);
      ck.ok(
        "ENV-02e applied_at 在而未 closed → 补偿关闭（already_applied + status closed 落板）",
        r2c.isError !== true && j2c.already_applied === true && missionIn(T2, "m-env2b").status === "closed",
        r2c.text.slice(0, 120),
      );
      // ---- ENV-03：intent 后 merge 前 crash（intent 过期、分支未合入）→ 清 intent 重走 gates 重跑
      await prepareSandbox(s, T2, "m-env3", { "src/env3.js": "export const v = 3;\n" });
      seedApplyChain(T2, "m-env3");
      const bf3 = JSON.parse(fs.readFileSync(path.join(T2, "board.json"), "utf8"));
      bf3.missions.find((x) => x.id === "m-env3").pack.sandbox.apply_intent_at = iso(11); // 11min 前=过期
      fs.writeFileSync(path.join(T2, "board.json"), JSON.stringify(bf3, null, 2) + "\n");
      const r3 = await s.call("sandbox_apply", { mission_id: "m-env3" });
      const j3 = resultText(r3);
      ck.ok(
        "ENV-03a intent 过期未合入 → 非 busy、重跑 gates 后全新收口（无 apply_in_progress/recovered）",
        r3.isError !== true && j3.apply_in_progress !== true && j3.recovered !== true && j3.status === "closed",
        r3.text.slice(0, 140),
      );
      ck.ok(
        "ENV-03b 重跑后 applied_at 落板且 merge 真实发生（m-env3 分支已合入 HEAD）",
        Boolean(sbOf(T2, "m-env3").applied_at) &&
          spawnSync("git", ["merge-base", "--is-ancestor", "orch/m-env3", "HEAD"], { cwd: PROJ2 }).status === 0,
        "",
      );
      // ---- ENV-05：intent 新鲜窗内第二 apply → 结构化 busy，不双跑
      await prepareSandbox(s, T2, "m-env5", { "src/env5.js": "export const v = 5;\n" });
      seedApplyChain(T2, "m-env5");
      const bf5 = JSON.parse(fs.readFileSync(path.join(T2, "board.json"), "utf8"));
      bf5.missions.find((x) => x.id === "m-env5").pack.sandbox.apply_intent_at = iso(0); // 新鲜
      fs.writeFileSync(path.join(T2, "board.json"), JSON.stringify(bf5, null, 2) + "\n");
      const r5 = await s.call("sandbox_apply", { mission_id: "m-env5" });
      const j5 = resultText(r5);
      const m5 = missionIn(T2, "m-env5");
      const stillUnmerged =
        spawnSync("git", ["merge-base", "--is-ancestor", "orch/m-env5", "HEAD"], { cwd: PROJ2 }).status !== 0;
      ck.ok(
        "ENV-05a 新鲜 intent → 结构化 busy（ok:true + apply_in_progress:true，非 isError）",
        r5.isError !== true && j5.apply_in_progress === true,
        r5.text.slice(0, 140),
      );
      ck.ok("ENV-05b 不双跑：分支未被第二调用合入（仍非 ancestor）", stillUnmerged, "");
      ck.ok(
        "ENV-05c 板面未被第二调用改动（仍 done、intent 原样）",
        m5.status === "done" && m5.pack.sandbox.apply_intent_at === bf5.missions.find((x) => x.id === "m-env5").pack.sandbox.apply_intent_at,
        m5.status,
      );
    } finally {
      s.close();
    }
  }

  /* ---- 场景 E：ENV-04 teardown 失败降级（V6-35：merge 后先落板再 teardown） ---- */
  {
    const T4 = path.join(BASE.root, "root-env4");
    const PROJ4 = path.join(BASE.root, "proj-env4");
    makeRepo({ dir: PROJ4, files: { "README.md": "readme\n", "src/a.txt": "a\n" } });
    const s = startServer({ root: T4, cwd: PROJ4 });
    try {
      const wt = await prepareSandbox(s, T4, "m-env4", { "src/env4.js": "export const v = 4;\n" });
      seedApplyChain(T4, "m-env4");
      fs.writeFileSync(path.join(wt, "uncommitted-leftover.txt"), "unreviewed leftover\n"); // 未提交残留→worktree remove 必拒
      const r4 = await s.call("sandbox_apply", { mission_id: "m-env4" });
      const j4 = resultText(r4);
      ck.ok(
        "ENV-04a teardown 失败 → ok:true 且 worktree_removed:false（不再 throw 过已落 merge）",
        r4.isError !== true && j4.ok === true && j4.worktree_removed === false,
        r4.text.slice(0, 160),
      );
      ck.ok("ENV-04b 响应 warning 含残留指引（sandbox_discard 强弃/重走评审）", typeof j4.warning === "string" && j4.warning.includes("残留"), j4.warning?.slice(0, 100));
      ck.ok("ENV-04c applied_at 已落板（V6-35：板事务先于 teardown，merge 不被拖死）", Boolean(sbOf(T4, "m-env4").applied_at) && missionIn(T4, "m-env4").status === "closed", "");
      ck.ok("ENV-04d worktree 目录确仍在（真降级非假成功）", fs.existsSync(wt), "");
      const rd = await s.call("sandbox_discard", { mission_id: "m-env4" }); // 残留可 discard 清理
      const jd = resultText(rd);
      ck.ok(
        "ENV-04e 残留经 discard 强弃清理（ok + worktree_removed:true + discarded_at 落板）",
        rd.isError !== true && jd.worktree_removed === true && Boolean(sbOf(T4, "m-env4").discarded_at),
        rd.text.slice(0, 120),
      );
    } finally {
      s.close();
    }
  }

  /* ---- 场景 F：ENV-06 discard×intent（新鲜拒 / 过期放行 / applied 胜出仲裁） ---- */
  {
    const T6 = path.join(BASE.root, "root-env6");
    const PROJ6 = path.join(BASE.root, "proj-env6");
    makeRepo({ dir: PROJ6, files: { "README.md": "readme\n", "src/a.txt": "a\n" } });
    const s = startServer({ root: T6, cwd: PROJ6 });
    try {
      // ---- ENV-06a：新鲜 intent → discard 拒绝（apply↔discard 互斥）
      await prepareSandbox(s, T6, "m-env6a", { "src/env6a.js": "export const v = 1;\n" });
      const b6a = JSON.parse(fs.readFileSync(path.join(T6, "board.json"), "utf8"));
      b6a.missions.find((x) => x.id === "m-env6a").pack.sandbox.apply_intent_at = iso(0);
      fs.writeFileSync(path.join(T6, "board.json"), JSON.stringify(b6a, null, 2) + "\n");
      const r6a = await s.call("sandbox_discard", { mission_id: "m-env6a" });
      ck.ok(
        "ENV-06a discard 撞新鲜 intent → isError 拒绝（apply 在飞互斥），沙箱未被清理",
        r6a.isError === true && r6a.text.includes("apply 在飞") && fs.existsSync(path.join(T6, "sandboxes", "m-env6a")),
        r6a.text.slice(0, 140),
      );
      // ---- ENV-06b：过期 intent → discard 放行（出锁 git 三连回归）
      await prepareSandbox(s, T6, "m-env6b", { "src/env6b.js": "export const v = 2;\n" });
      const b6b = JSON.parse(fs.readFileSync(path.join(T6, "board.json"), "utf8"));
      b6b.missions.find((x) => x.id === "m-env6b").pack.sandbox.apply_intent_at = iso(11);
      fs.writeFileSync(path.join(T6, "board.json"), JSON.stringify(b6b, null, 2) + "\n");
      const r6b = await s.call("sandbox_discard", { mission_id: "m-env6b" });
      const j6b = resultText(r6b);
      ck.ok(
        "ENV-06b intent 过期 → discard 放行（worktree+branch 清理、discarded_at 落板）",
        r6b.isError !== true && j6b.worktree_removed === true && j6b.branch_deleted === true && Boolean(sbOf(T6, "m-env6b").discarded_at),
        r6b.text.slice(0, 140),
      );
      // ---- ENV-06c：applied 在先的 discard = 残留清理路径（V6-35）——放行且双戳并存；
      //      真并发竞态分支（phase-1 无 applied_at → phase-3 有）黑盒不可达，以结构断言承接
      //      （A1 LOCK-03/04 注记②先例）。
      await prepareSandbox(s, T6, "m-env6c", { "src/env6c.js": "export const v = 3;\n" });
      const b6c = JSON.parse(fs.readFileSync(path.join(T6, "board.json"), "utf8"));
      const sb6c = b6c.missions.find((x) => x.id === "m-env6c").pack.sandbox;
      sb6c.apply_intent_at = iso(0);
      sb6c.applied_at = iso(0);
      sb6c.applied_commit = gitC(PROJ6, ["rev-parse", "HEAD"]).trim();
      fs.writeFileSync(path.join(T6, "board.json"), JSON.stringify(b6c, null, 2) + "\n");
      const r6c = await s.call("sandbox_discard", { mission_id: "m-env6c" });
      const j6c = resultText(r6c);
      const sb6cAfter = sbOf(T6, "m-env6c");
      ck.ok(
        "ENV-06c applied 在先的 discard 放行（残留清理路径）：ok 且 applied_at/discarded_at 双戳并存",
        r6c.isError !== true && j6c.worktree_removed === true && Boolean(sb6cAfter.applied_at) && Boolean(sb6cAfter.discarded_at),
        r6c.text.slice(0, 140),
      );
      const src6 = fs.readFileSync(DEFAULT_SERVER, "utf8");
      ck.ok(
        "ENV-06d 结构：真竞态仲裁在源（applied_at 新现 → discard 中止，!p1.sawApplied 守卫 + 「discard 中止」报错）",
        src6.includes("!p1.sawApplied") && src6.includes("discard 中止：mission 已被并发 apply 收口"),
        "",
      );
    } finally {
      s.close();
    }
  }

  /* ---- 场景 G：ENV-07 巨板（6000 mission 形态）慢 merge 期间双写者零硬错 ----
   * 与场景 C 同受 v0.6.1 稳定化保护（withRetryOnce：首跑抖动重跑一次，断言集与语义不变）。 */
  {
    const runEnv07 = async (tag) => {
      const lck = new Checker("crv5-apply-envelope:ENV-07/" + tag);
      const T7 = path.join(BASE.root, "root-env7-" + tag);
      const PROJ7 = path.join(BASE.root, "proj-env7-" + tag);
      const MARKER7 = path.join(BASE.root, "marker-env7-" + tag + ".txt");
      makeRepo({ dir: PROJ7, files: { "README.md": "readme\n", "src/a.txt": "a\n" } });
      slowMergeHook(PROJ7, MARKER7, 4);
      fs.mkdirSync(T7, { recursive: true });
      const bulk = Array.from({ length: 6000 }, (_, i) => blankMission({ id: "m-bulk-" + i, title: "bulk " + i }));
      fs.writeFileSync(
        path.join(T7, "board.json"),
        JSON.stringify({ version: 2, updated_at: new Date().toISOString(), missions: bulk }) + "\n",
      );
      const sA = startServer({ root: T7, cwd: PROJ7 });
      try {
        await prepareSandbox(sA, T7, "m-env7", { "src/env7.js": "export const v = 7;\n" });
        seedApplyChain(T7, "m-env7");
        const sB = startServer({ root: T7, cwd: PROJ7 });
        try {
          const pA = sA.call("sandbox_apply", { mission_id: "m-env7" });
          const markerSeen = await waitFor(() => fs.existsSync(MARKER7), 30000);
          lck.ok("ENV-07a 巨板 phase-1 过后慢 merge 在飞（marker 落盘）", markerSeen);
          const rB = await sB.call("board", { action: "upsert", mission: { id: "m-conc7", title: "巨板 merge 窗口并发写" } });
          lck.ok(
            "ENV-07b 巨板 merge 期间并发 upsert 零存储忙零硬错",
            rB.isError !== true && !rB.text.includes("存储忙"),
            rB.text.slice(0, 140),
          );
          const rA = await pA;
          lck.ok(
            "ENV-07c 巨板 apply 收口 closed（phase-3 fresh 重读 <2s 纪律内完成）",
            rA.isError !== true && resultText(rA).status === "closed",
            rA.text.slice(0, 140),
          );
          const b7 = readT(T7);
          const conc = b7.missions.find((x) => x && x.id === "m-conc7");
          const applied = b7.missions.find((x) => x && x.id === "m-env7");
          const bulkTail = b7.missions.find((x) => x && x.id === "m-bulk-5999");
          lck.ok(
            "ENV-07d 终板三存（并发写+applied closed+巨板完好）——零丢更新零硬错",
            Boolean(conc) && applied && applied.status === "closed" && Boolean(applied.pack.sandbox.applied_at) && Boolean(bulkTail) && b7.missions.length === 6003,
            `n=${b7.missions.length} conc=${Boolean(conc)} bulkTail=${Boolean(bulkTail)}`,
          );
        } finally {
          sB.close();
        }
      } finally {
        sA.close();
      }
      return lck;
    };
    await withRetryOnce("ENV-07", runEnv07);
  }
}

BASE.cleanup();
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
