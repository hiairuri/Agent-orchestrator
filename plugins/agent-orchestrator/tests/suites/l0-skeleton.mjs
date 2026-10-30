// @module l0-skeleton
/*!
 * suites/l0-skeleton.mjs —— L0 骨架组（0.4.1 回归组 R01 口径的 v0.5 复核 + M-07/SB09 + B07）
 *
 * 覆盖断言组：A-v041-R01（node --check 全脚本 / 无 require / db 只读静态 grep / hooks.json 4 事件
 *   且 bg-gate args 含 --contract 传参 / tools/list=12 复核口径〔v0.6 A6 probe 转正 + v1.1.1 W20 dispatch〕）、
 *   A-v030-R03 与 A-v040-I03（工具数口径）、
 *   A-v040-SB09 + A-v050-M07（server.mjs 无 git transfer argv 静态红线）、A-v041-V13（sentinel_health
 *   形状机械项）、A-v020-B07（bg-gate fail-open）、BOARD_VERSION=2、plugin.json 可解析。
 *
 * 运行方式：node tests/suites/l0-skeleton.mjs [--root <临时根>]
 * 前置：node >= 20；无网。（v0.5 QA：hooks.json 逐字节对拍已由传参接线断言取代，本组零 git 依赖。）
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PLUGIN_DIR, DEFAULT_SERVER, PRE, startServer, Checker } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot, parseRootArg } from "../harness/temp-root.mjs";
import { runCapture } from "../harness/capture.mjs";

/** function <name>(<any params>) body — column-0 "}" closes it. LF-normalized input. */
function bodyOfText(sourceLF, fnName) {
  const start = sourceLF.indexOf(`function ${fnName}(`);
  if (start < 0) return "";
  const end = sourceLF.indexOf("\n}\n", start);
  return end < 0 ? sourceLF.slice(start) : sourceLF.slice(start, end + 3);
}

const SCRIPTS = [
  "mcp/server.mjs",
  "hooks/bg-gate.mjs", "hooks/bg-sentinel.mjs", "hooks/journal.mjs",
  "hooks/session-start.mjs", "hooks/stop-check.mjs",
  // v1.1.1 W20: the headless launcher is spawned detached by the dispatch tool;
  // it must pass the same syntax gate as every other executable script.
  "hooks/dispatch-runner.mjs",
];

const ck = new Checker("l0-skeleton");
const T = makeTempRoot({ prefix: "orch-l0-", root: parseRootArg() || undefined });
try {
  // ---- node --check 全部脚本（R01/M-07）
  for (const rel of SCRIPTS) {
    const p = path.join(PLUGIN_DIR, rel);
    ck.ok("node --check " + rel, fs.existsSync(p) && spawnSync(process.execPath, ["--check", p]).status === 0);
  }

  // ---- 静态红线：SB09/M-07 server.mjs 无 git transfer argv（注释剥离后扫描）
  const src = fs.readFileSync(DEFAULT_SERVER, "utf8");
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const lines = noBlock.split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"));
  const badArgv = [];
  const badCmd = [];
  for (const [i, l] of lines.entries()) {
    for (const m of l.matchAll(/["'](push|pull|fetch|clone|remote|submodule)["']/g)) badArgv.push({ line: i + 1, t: m[1] });
    if (/git\s+(push|pull|fetch|clone|remote|submodule)\b/.test(l)) badCmd.push({ line: i + 1 });
  }
  ck.ok("SB09/M-07 no git transfer argv literals", badArgv.length === 0, badArgv.slice(0, 3));
  ck.ok("SB09/M-07 no git transfer command text", badCmd.length === 0, badCmd.slice(0, 3));

  // ---- R01 静态：无 require( ；db 只读（禁写 SQL 关键词）
  const sentSrc = fs.readFileSync(path.join(PLUGIN_DIR, "hooks", "bg-sentinel.mjs"), "utf8");
  ck.ok("R01 no require( in server/sentinel", !/require\s*\(/.test(src) && !/require\s*\(/.test(sentSrc));
  const writeSql = [src, sentSrc].map((s) => s.match(/INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+\S+\s+SET/i)).filter(Boolean);
  ck.ok("R01 db read-only (no write SQL)", writeSql.length === 0, writeSql);

  // ---- hooks.json：事件集不变（4 事件）+ bg-gate args 含 --contract 传参
  // （v0.5 QA：hooks.json 自 0.4.1 起有了首处合法变更——bg-gate 增 --contract，
  //   故不再与 d00f94c 逐字节对拍，改钉"事件集不变 + 传参接线"两个绿点。）
  const hooksPath = path.join(PLUGIN_DIR, "hooks", "hooks.json");
  const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  const events = Object.keys(hooks.hooks || {});
  ck.ok("hooks.json 4 events", events.length === 4 && ["SessionStart", "UserPromptSubmit", "Stop", "PreToolUse"].every((e) => events.includes(e)), events);
  const gateArgs = (hooks.hooks.PreToolUse || []).flatMap((m) => m.hooks || []).find((h) => (h.args || []).some((a) => String(a).includes("bg-gate.mjs")))?.args || [];
  const ci = gateArgs.indexOf("--contract");
  ck.ok("hooks.json bg-gate args carry --contract -> ${user_config.dispatch_contract}",
    ci >= 0 && gateArgs[ci + 1] === "${user_config.dispatch_contract}", gateArgs);

  // ---- plugin.json：可解析 + v0.5 userConfig 键
  const pj = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, ".zcode-plugin", "plugin.json"), "utf8"));
  ck.ok("plugin.json parse + version string", typeof pj.version === "string");
  ck.ok("plugin.json dispatch_contract default remind", pj.userConfig?.dispatch_contract?.default === "remind", pj.userConfig?.dispatch_contract);

  // ---- server 黑盒：tools/list=12、board 回环、version=2、sentinel_health 形状
  const s = startServer({ root: T.root });
  const tl = await s.tools();
  const names = (tl.tools || []).map((t) => t.name);
  ck.ok("tools/list = 12（v0.6 A6 probe 转正 + v1.1.1 W20 dispatch 第 12 号）", names.length === 12, names.length);
  ck.ok("tools all orchestrator-prefixed, no unregistered feature-track tool（probe 已于 A6 入版；condense/usage 仍未立项）",
    names.every((n) => n.startsWith("mcp__plugin_agent-orchestrator_orch__")) && !names.some((n) => /condense|usage/i.test(n)),
    names);

  // ---- v1.1.1 W20 DP 热修：schema 声明面 ⊇ handler 读取面（DP 双代理线活体实锤：
  // board 的 p2p 鉴权读 args.token 而 schema 未声明 → 宿主 MCP 客户端按 schema 剥离
  // 未声明参数 → 子代理 p2p 调用恒无 token 被拒。本组把「声明=读取」钉成机械不变量。）
  {
    const srcLF = src.replace(/\r\n/g, "\n");
    const toolsList = tl.tools || [];
    const byName = new Map(toolsList.map((t) => [t.name, t]));
    const propsOf = (toolName) => Object.keys(byName.get(PRE + toolName)?.inputSchema?.properties || {});
    const boardSchema = byName.get(PRE + "board")?.inputSchema?.properties || {};
    const missionProps = Object.keys(boardSchema.mission?.properties || {});
    ck.ok(
      "DP-01 board inputSchema 声明 p2p 鉴权 token（顶层，string）+ mission 传递门键（reopen/note/close_confirmed）与 scope 登记键（scope_paths/strict_scope）——schema 剥离面零缺口",
      propsOf("board").includes("token") &&
        boardSchema.token?.type === "string" &&
        ["reopen", "note", "close_confirmed", "scope_paths", "strict_scope"].every((k) => missionProps.includes(k)),
      { top: propsOf("board"), mission: missionProps },
    );
    const boardBody = bodyOfText(srcLF, "toolBoard");
    // 每一处 = `const token = args.token == null ? null : String(args.token)`（写法含两次 args.token），
    // p2p_ask + p2p_answer 各一处 → 恰 2 处读取语句。
    const p2pTokenReads = (boardBody.match(/const token = args\.token == null/g) || []).length;
    ck.ok(
      "DP-01b board handler 的 p2p token 读取面在位（p2p_ask + p2p_answer 各一处 = 恰 2 处读取语句）",
      p2pTokenReads === 2,
      p2pTokenReads,
    );
    // 全工具同类清扫：handler 读取的每个顶层 args.X 都必须在 inputSchema.properties 中声明。
    // 委托面对照表（wrapper → 实际读参函数）；新增委托须登记于此，漏登记会以缺口形式暴露。
    const DELEGATES = {
      toolContextPack: ["toolContextPackInner"],
      toolDispatch: ["toolDispatchInner"],
      toolLessons: ["toolLessonsInner"],
      toolProbe: ["probeDispatchAction", "probeDbQuery", "probeFileHead", "probeFileGrep", "probeBinInspect"],
    };
    const mapStart = srcLF.indexOf("const TOOL_HANDLERS = {");
    const mapSrc = srcLF.slice(mapStart, srcLF.indexOf("\n};", mapStart));
    const handlers = new Map(
      [...mapSrc.matchAll(/\[PREFIX \+ "([a-z_]+)"\]: (tool[A-Za-z]+),/g)].map((m) => [m[1], m[2]]),
    );
    const readsOf = (handler) => {
      const keys = new Set();
      const seen = new Set();
      const walk = (fn) => {
        if (!fn || seen.has(fn)) return;
        seen.add(fn);
        for (const m of bodyOfText(srcLF, fn).matchAll(/\bargs\.([A-Za-z_][A-Za-z0-9_]*)/g)) keys.add(m[1]);
        for (const d of DELEGATES[fn] || []) walk(d);
      };
      walk(handler);
      return keys;
    };
    const gaps = [];
    const unparsed = [];
    for (const [toolName, handler] of handlers) {
      const declared = new Set(propsOf(toolName));
      if (!declared.size) unparsed.push(toolName);
      const read = readsOf(handler);
      if (!read.size) unparsed.push(toolName + ":" + handler);
      for (const key of read) if (!declared.has(key)) gaps.push(`${toolName}.${key}`);
    }
    ck.ok(
      "DP-02 全 12 工具：handler 读取面 ⊆ inputSchema 声明面（args.X ⇒ schema.properties.X；同型剥离缺口零残留）",
      handlers.size === 12 && unparsed.length === 0 && gaps.length === 0,
      { handlers: handlers.size, unparsed, gaps },
    );
  }
  const up = await s.call("board", { action: "upsert", mission: { title: "l0" } });
  ck.ok("board upsert ok", !up.isError && up.json?.ok === true, up.text.slice(0, 120));
  const bj = JSON.parse(fs.readFileSync(path.join(T.root, "board.json"), "utf8"));
  ck.ok("BOARD_VERSION = 2", bj.version === 2, bj.version);
  const ls = await s.call("board", { action: "list" });
  ck.ok("V13 sentinel_health shape（缺 sentinel/ → available:false 不报错）",
    ls.json?.sentinel_health && ls.json.sentinel_health.available === false && !ls.isError, ls.json?.sentinel_health);
  s.close();

  // ---- B07 fail-open：stdin 非 JSON → exit 0 无输出（与生产链路同参：ZCODE_PROJECT_DIR 指向临时根）
  const gate = path.join(PLUGIN_DIR, "hooks", "bg-gate.mjs");
  const r = runCapture({ script: process.execPath, args: [gate], input: "not json", cwd: T.root, env: { ZCODE_PROJECT_DIR: T.root } });
  ck.ok("B07 fail-open exit 0 silent", r.code === 0 && !r.raw.trim(), r.code + "|" + r.raw.slice(0, 80) + "|" + r.stderr.slice(0, 120));
} finally {
  T.cleanup();
}
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
