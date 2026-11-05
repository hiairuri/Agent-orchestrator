/*!
 * harness/git-fixture.mjs —— 临时仓 G（init+两文件 commit）、冲突构造（同行情改）、
 *   越界改动构造、node_modules 摆设
 *
 * 覆盖断言组：A-v040-SB 组（SB01–SB08）、A-v050-CRV2（仓 G 前置）、M-02（apply 归一化前缀放行）。
 *   固定 GIT_AUTHOR/COMMITER_DATE → 确定性 commit SHA（CRV2-05/CR-V22 逐字节对拍依赖）。
 *
 * 运行方式：作为模块 import；亦可自检直跑：
 *   node tests/harness/git-fixture.mjs
 *   （自检=建仓/提交/越界改/冲突克隆/node_modules 摆设，打印 PASS/FAIL，exit 0/1）
 *
 * 前置：PATH 上有 git；可写 os.tmpdir()。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FIXED_DATE_ENV = {
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00+0000",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00+0000",
};

/** 默认两文件：README.md + src/a.txt（历轮 SB 用例同款） */
export function makeRepo({ prefix = "orch-g-", dir, files = { "README.md": "readme\n", "src/a.txt": "a\n" }, fixedDate = true } = {}) {
  const G = dir ? (fs.mkdirSync(dir, { recursive: true }), path.resolve(dir)) : fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (args, cwd = G) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...(fixedDate ? FIXED_DATE_ENV : {}) } });
    if (r.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + (r.stderr || r.stdout));
    return r.stdout;
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(G, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(G, rel), content);
  }
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  const commitAll = (msg, cwd = G) => { git(["add", "-A"], cwd); git(["commit", "-m", msg], cwd); };
  return {
    dir: G, git, commitAll,
    head: () => git(["rev-parse", "HEAD"]).trim(),
    porcelain: () => git(["status", "--porcelain"]),
    cleanup: () => { try { fs.rmSync(G, { recursive: true, force: true }); } catch {} },
  };
}

/** 越界改动构造：向仓内 relPath 追加一行并提交（worktree 侧传 wt 目录） */
export function makeOobChange(repoRoot, relPath, cwd = repoRoot, marker = "oob\n") {
  const p = path.join(repoRoot, relPath);
  fs.appendFileSync(p, marker);
  return p;
}

/** 冲突构造（SB04）：克隆仓 → 同一行改不同内容并提交 → 返回克隆句柄 */
export function cloneWithConflictingEdit(repo, relPath = "README.md", newLine = "conflicting line\n") {
  const C = fs.mkdtempSync(path.join(os.tmpdir(), "orch-clone-"));
  repo.git(["clone", "--no-hardlinks", repo.dir, C], path.dirname(repo.dir) /* cwd 任意外部目录 */);
  const p = path.join(C, relPath);
  fs.writeFileSync(p, newLine);
  const gitC = (args) => {
    const r = spawnSync("git", args, { cwd: C, encoding: "utf8", env: { ...process.env, ...FIXED_DATE_ENV } });
    if (r.status !== 0) throw new Error("git(clone) " + args.join(" ") + ": " + (r.stderr || r.stdout));
    return r.stdout;
  };
  gitC(["config", "user.email", "t@example.com"]);
  gitC(["config", "user.name", "t"]);
  gitC(["add", "-A"]); gitC(["commit", "-m", "conflict edit"]);
  return { dir: C, git: gitC, cleanup: () => { try { fs.rmSync(C, { recursive: true, force: true }); } catch {} } };
}

/** node_modules 摆设（SB08 junction 断言的前置） */
export function placeNodeModules(dir, marker = "junction-probe") {
  const nm = path.join(dir, "node_modules");
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, ".orch-fixture"), marker + "\n");
  return nm;
}

/** 仓库根发现：默认从插件目录（tests/harness/../..）向 git 询问（对拍 0.4.1 基线用） */
export function repoRoot(fromDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")) {
  const r = spawnSync("git", ["-C", fromDir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("repoRoot: not a git work tree from " + fromDir);
  return r.stdout.trim();
}

/** 从 git 历史导出基线文件到临时目录（CRV2-05/CR-V22/CR-V16② 的 0.4.1 server 对拍）：
 *  exportFileFromGit("d00f94c", root, "plugins/agent-orchestrator/mcp/server.mjs", scratchDir) → outPath */
export function exportFileFromGit(ref, repoTop, relPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, path.basename(relPath).replace(/\.mjs$/, "." + ref + ".mjs"));
  const r = spawnSync("git", ["-C", repoTop, "show", `${ref}:${relPath}`], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("git show " + ref + ":" + relPath + " failed: " + Buffer.from(r.stderr).toString("utf8").slice(0, 200));
  fs.writeFileSync(outPath, Buffer.from(r.stdout));
  return outPath;
}

// ---- 自检直跑：node tests/harness/git-fixture.mjs ----
if (process.argv[1] && (await import("node:url")).pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let pass = 0, fail = 0;
  const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (c || x === undefined ? "" : " | " + String(x).slice(0, 200))); c ? pass++ : fail++; };
  const r1 = makeRepo({});
  const h1 = r1.head();
  ok("repo init+commit", h1.length === 40);
  makeOobChange(r1.dir, "README.md");
  r1.commitAll("oob");
  ok("oob committed", r1.porcelain() === "");
  const c1 = cloneWithConflictingEdit(r1);
  ok("clone committed conflict edit", fs.readFileSync(path.join(c1.dir, "README.md"), "utf8") === "conflicting line\n");
  const nm = placeNodeModules(r1.dir);
  ok("node_modules placed", fs.existsSync(path.join(nm, ".orch-fixture")));
  const r2 = makeRepo({});
  ok("deterministic SHA across identical repos", h1 === r2.head(), h1 + " vs " + r2.head());
  c1.cleanup(); r1.cleanup(); r2.cleanup();
  console.log(`SUITE git-fixture.selfcheck pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}
