/*!
 * suites/lint-manifest.mjs —— L0 发版 lint（V7-12）：manifest 约定路径防复发 + 引用存在性 + 版本三方一致。
 *
 * 覆盖断言组：LM-01（W-F4 防复发精确对位）——manifest 若声明 `hooks` 字段，任一条目 realpath
 *   不得等于宿主约定路径 <插件根>/hooks/hooks.json（宿主对约定路径「先行+去重」，重复声明即
 *   双重加载；FAIL 提示删字段或改非约定路径，见 designs W-F4 §1/§3.2 与 v0.7-W-T-findings §2）；
 *   LM-02——manifest skills/commands/mcpServers/agents（及 hooks 若声明）指向路径存在且非空；
 *   LM-03——plugin.json version == SERVER_VERSION（mcp/server.mjs 常量）== plugins/marketplace.json
 *   version，防「发版忘改一处」三方漂移。
 *
 * 口径：L0 纯静态读文件，零网络零临时根（--root 参数接受但忽略，兼容 run-all 透传）。
 *   hooks.json 事件集内容已由 l0-skeleton 静态断言覆盖，本套不重复断言事件集（findings §5 遗留 3）。
 *
 * 运行方式：node tests/suites/lint-manifest.mjs [--root <忽略>]
 * 前置：node >= 20；无网、无 git。
 */
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_DIR, DEFAULT_SERVER, Checker } from "../harness/jsonrpc-client.mjs";

const ck = new Checker("lint-manifest");

const MANIFEST_PATH = path.join(PLUGIN_DIR, ".zcode-plugin", "plugin.json");
const MARKETPLACE_PATH = path.resolve(PLUGIN_DIR, "..", "marketplace.json");
const CONVENTIONAL_HOOKS = path.join(PLUGIN_DIR, "hooks", "hooks.json");

/** 归一化路径比较键：存在则 realpath，否则 lexical normalize；Windows 大小写不敏感。 */
function pathKey(p) {
  let resolved = path.resolve(p);
  try { resolved = fs.realpathSync(resolved); } catch { /* 不存在的引用按词法比较 */ }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 从 manifest hooks 字段收集所有可解释为路径的字符串（string / 数组条目 / {path|file|hooks}）。 */
function hookEntryPaths(field) {
  const out = [];
  if (typeof field === "string") out.push(field);
  else if (Array.isArray(field)) {
    for (const e of field) {
      if (typeof e === "string") out.push(e);
      else if (e && typeof e === "object") for (const k of ["path", "file", "hooks"]) if (typeof e[k] === "string") out.push(e[k]);
    }
  } else if (field && typeof field === "object") {
    for (const k of ["path", "file", "hooks"]) if (typeof field[k] === "string") out.push(field[k]);
  }
  return out;
}

/** 引用指向存在且非空：目录须有条目，文件须 size>0。 */
function refExistsNonEmpty(rel) {
  const abs = path.resolve(PLUGIN_DIR, rel);
  let st;
  try { st = fs.statSync(abs); } catch { return { ok: false, detail: abs + " 不存在" }; }
  if (st.isDirectory()) {
    const n = fs.readdirSync(abs).length;
    return n > 0 ? { ok: true } : { ok: false, detail: abs + " 空目录" };
  }
  return st.size > 0 ? { ok: true } : { ok: false, detail: abs + " 空文件" };
}

// ---- 前置：manifest 可解析（LM 系全部断言的输入）
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  ck.ok("LM-01 manifest 可解析（.zcode-plugin/plugin.json）", !!manifest && typeof manifest === "object");
} catch (e) {
  ck.ok("LM-01 manifest 可解析（.zcode-plugin/plugin.json）", false, String(e).slice(0, 200));
}

if (manifest) {
  // ---- LM-01：hooks 声明不与约定路径 realpath 重复（W-F4 防复发钉）
  if (manifest.hooks === undefined) {
    ck.ok("LM-01 hooks 字段未声明（约定路径重复无从发生；W-F4 根治态保持）", true);
  } else {
    const declared = hookEntryPaths(manifest.hooks).map((p) => path.resolve(PLUGIN_DIR, p));
    const dup = declared.filter((p) => pathKey(p) === pathKey(CONVENTIONAL_HOOKS));
    ck.ok("LM-01 hooks 声明条目 realpath 不等于约定路径 hooks/hooks.json（重复=FAIL：删字段或改非约定路径）",
      dup.length === 0, { declared, conventional: CONVENTIONAL_HOOKS, dup });
  }

  // ---- LM-02：引用存在性且非空（固定四键 + hooks 若声明）
  const refKeys = ["skills", "commands", "mcpServers", "agents"];
  if (manifest.hooks !== undefined) refKeys.push("hooks");
  for (const k of refKeys) {
    const v = manifest[k];
    if (typeof v !== "string" || !v.trim()) {
      ck.ok(`LM-02 ${k} 指向存在且非空`, false, { got: v, want: "相对插件根的路径字符串" });
      continue;
    }
    const r = refExistsNonEmpty(v);
    ck.ok(`LM-02 ${k} -> ${v} 存在且非空`, r.ok, r.detail);
  }

  // ---- LM-03：版本三方一致（plugin.json == server.mjs SERVER_VERSION == marketplace.json）
  const pjv = manifest.version;
  const serverSrc = fs.readFileSync(DEFAULT_SERVER, "utf8");
  const sm = serverSrc.match(/const\s+SERVER_VERSION\s*=\s*["']([^"']+)["']/);
  ck.ok("LM-03 SERVER_VERSION 常量可从 server.mjs 提取", !!(sm && sm[1]), sm && sm[1]);

  let mpEntry = null;
  try {
    const mp = JSON.parse(fs.readFileSync(MARKETPLACE_PATH, "utf8"));
    mpEntry = (mp.plugins || []).find((p) => p.name === manifest.name) || null;
    ck.ok("LM-03 marketplace.json 可解析且含本插件条目", !!mpEntry, mpEntry?.version);
  } catch (e) {
    ck.ok("LM-03 marketplace.json 可解析且含本插件条目", false, String(e).slice(0, 200));
  }

  const three = { plugin: pjv, server: sm && sm[1], marketplace: mpEntry && mpEntry.version };
  ck.ok("LM-03 版本三方一致（plugin.json == SERVER_VERSION == marketplace.json）",
    typeof pjv === "string" && !!sm && !!mpEntry && pjv === sm[1] && pjv === mpEntry.version, three);
}

const { pass, fail } = ck.summary();
process.exit(fail ? 1 : 0);
