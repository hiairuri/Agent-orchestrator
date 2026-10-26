/*!
 * harness/jsonrpc-client.mjs —— server 黑盒客户端（子进程按行 JSON-RPC，历轮"通用准备"同款）
 *
 * 覆盖断言组：全部 server 用例（A-v050-CRV1..4、CR-V9/10/16、CR-V18..V29、SB/D、M 组）与
 *   L0 骨架组的 tools/list 口径。转录自 v05-impl-02/verify.mjs、v05-impl-03/rig.mjs、
 *   v05-impl-04/crv1-test.mjs、v05-impl-05/acceptance-probe.mjs、v05-impl-06/acc.mjs、
 *   v05-impl-07/acc.mjs 的同款 spawn+按行解析模式。
 *
 * 运行方式：作为模块 import（run-all/suites 用）；亦可自检直跑：
 *   node tests/harness/jsonrpc-client.mjs [--root <临时根>]
 *   （自检=起 server、initialize、tools/call board upsert/get 回环，打印 PASS/FAIL，exit 0/1）
 *
 * 前置：node >= 20（含 --root 参数的 server.mjs）；无其他依赖。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TESTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_DIR = path.resolve(TESTS_DIR, "..");
export const DEFAULT_SERVER = path.join(PLUGIN_DIR, "mcp", "server.mjs");
export const PRE = "mcp__plugin_agent-orchestrator_orch__";

/**
 * 启动 server 子进程并返回按行 JSON-RPC 客户端。
 * @param {object} opts { serverPath, root(必填，orchestrator 根), cwd, env, timeoutMs }
 */
export function startServer({ serverPath = DEFAULT_SERVER, root, cwd = root, env = {}, timeoutMs = 20000 } = {}) {
  if (!root) throw new Error("startServer: root is required");
  const child = spawn(process.execPath, [serverPath, "--root", root], {
    cwd, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const stderrTail = [];
  child.stderr.on("data", (d) => { stderrTail.push(String(d)); if (stderrTail.length > 20) stderrTail.shift(); });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer); pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("timeout " + method)); }, timeoutMs);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
  });
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  /** tools/call：永不因 isError 抛错，返回 { isError, text, json } */
  const call = async (name, args) => {
    const r = await request("tools/call", { name: name.startsWith("mcp__") ? name : PRE + name, arguments: args });
    const result = r.result || {};
    const text = (result.content ?? []).map((c) => c.text).join("\n");
    let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON 文本（错误文案） */ }
    return { isError: result.isError === true, text, json };
  };
  /** tools/list 原始应答 */
  const tools = async () => (await request("tools/list", {})).result;
  const close = () => { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} };
  return { child, request, notify, call, tools, close, stderrTail };
}

/** 便捷断言器：suites 共用。new Checker(name) → ck.ok(name, cond, extra) / ck.summary() */
export class Checker {
  constructor(label = "") { this.label = label; this.pass = 0; this.fails = []; this.lines = []; }
  ok(name, cond, extra) {
    if (cond) { this.pass++; this.lines.push("PASS " + name); }
    else { this.fails.push(name); this.lines.push("FAIL " + name + (extra !== undefined ? " | got: " + JSON.stringify(extra).slice(0, 300) : "")); }
  }
  summary() {
    console.log(this.lines.join("\n"));
    const tail = `SUITE ${this.label} pass=${this.pass} fail=${this.fails.length}`;
    console.log(tail);
    return { pass: this.pass, fail: this.fails.length, tail };
  }
}

// ---- 自检直跑：node tests/harness/jsonrpc-client.mjs [--root <临时根>] ----
if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(path.resolve(process.argv[1])).href) {
  const { makeTempRoot } = await import("./temp-root.mjs");
  const T = makeTempRoot({ prefix: "orch-jsonrpc-selfcheck-" });
  const ck = new Checker("jsonrpc-client.selfcheck");
  const s = startServer({ root: T.root });
  await s.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "selfcheck", version: "0.0.1" } });
  s.notify("notifications/initialized");
  const tl = await s.tools();
  ck.ok("tools/list = 12（v0.6 A6 probe 转正 + v1.1.1 W20 dispatch 第 12 号；与 l0 DP-02 口径对齐）", tl.tools?.length === 12, tl.tools?.length);
  const up = await s.call("board", { action: "upsert", mission: { title: "selfcheck" } });
  ck.ok("board upsert ok", up.json?.ok === true && !up.isError, up.text.slice(0, 120));
  const id = up.json?.mission?.id || up.json?.id;
  const got = await s.call("board", { action: "get", mission_id: id });
  ck.ok("board get roundtrip", !got.isError && got.json?.id === id, got.text.slice(0, 120));
  s.close(); T.cleanup();
  const { pass, fail } = ck.summary();
  process.exit(fail ? 1 : 0);
}
