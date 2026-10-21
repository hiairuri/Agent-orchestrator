/*!
 * suites/probe-caps.mjs —— v0.6 A6 probe 帽 suite（第 11 号工具，上下文经济第二支柱）
 *
 * 覆盖断言组：A-v060-PROBE-01..10（DESIGN §5.1 / SKILL §20.4 帽语义机制化，施工 ID 定稿）——
 *   PROBE-01 工具面 11 与注册形态（tools/list 含 probe、schema 四 action 枚举、双面可用不入 MCP_DISALLOWED）
 *   PROBE-02 envelope 统一形态（rows_truncated/bytes/hash/page_token/caps；bytes ≤10KB；hash=返回内容 sha256）
 *   PROBE-03 行帽 ≤50 + 分页续传（file.head 200 行 → 50 行/页 + page_token 走到 eof；行数超帽收敛）
 *   PROBE-04 字节帽 ≤10KB 与单行截断（big.log 字节帽先绑；minified 行截断标记）
 *   PROBE-05 日志 tail ≤50 行（尾窗语义：start_line/eof/无 page_token；CRLF 剥 \r；BOM 剥除）
 *   PROBE-06 二进制只回类型/大小/哈希/首 256 字节 + 文本面拒二进制（NUL 启发）
 *   PROBE-07 grep -m 服务端语义（max_count ≤50/页 + 续页 + ignore_case + 非法正则拒绝）
 *   PROBE-08 db.query 只读门（SELECT/WITH 白名单 fail-closed、禁裸 SELECT *（COUNT(*) 例外）、
 *           LIMIT ≤100、禁注释/多语句/INTO、写语句拒绝、缺文件明确报错、blob 不裸吐）
 *   PROBE-09 db 分页（50 行/页包装走到尽、行字节帽、COUNT 聚合）
 *   PROBE-10 page_token 完整性（垃圾令牌/跨 action 令牌/文件变化后令牌一律拒绝；未知 action 明确报错）
 *   CACHE-01 写后读不回吐（改写文件 mtime/size 变 → 同参重探返回新内容非存根）
 *   CACHE-02 同参重复 probe 折算存根（cached:true+prior_hash+精确键面；db.query 显式排除；bin.inspect 亦可缓存）
 *   CACHE-03 no_cache:true 恒全量且不写缓存（首个 no_cache 调用零残留）+ schema 增参
 *   CACHE-04 page_token 续页不读不写缓存（续页不折存根；续页误写会被首页存根 prior_hash 当场抓获）
 *   CACHE-05 LRU 帽 64：第 65 个不同文件入帽逐最老（#1 被逐全量、末位仍存根）
 *   CACHE-06 环境探针：同进程连续两次 rename 原子写 mtimeMs 必不同（env-fact 留档）+
 *           同尺寸改写仅凭 mtime 因子完成写失效（size 因子失效时的兜底实证）
 *
 * 运行方式：node tests/suites/probe-caps.mjs [--root <临时根>]
 * 前置：node >= 20（db 用例需 node:sqlite 内建，Node ≥22.13/23.4——缺失时 db 族降级为跳过注记）；无网。
 * suite 注册行归主控 G 胶水波收口（run-all REGISTRY）；l0-skeleton tools=10 同步亦归 G。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { startServer, Checker, DEFAULT_SERVER, PRE } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot, parseRootArg } from "../harness/temp-root.mjs";

const ck = new Checker("probe-caps");
const BASE = makeTempRoot({ prefix: "orch-probe-", root: parseRootArg() || undefined });
const PROJ = path.join(BASE.root, "proj");
const T = path.join(BASE.root, "root");
fs.mkdirSync(PROJ, { recursive: true });

// ---- fixtures（proj/ 下，server cwd=proj → 相对路径可解析）----
const mkLines = (n, pad) =>
  Array.from({ length: n }, (_, i) => `line-${String(i + 1).padStart(pad, "0")} payload-abcdefghijklmnop`);
fs.writeFileSync(path.join(PROJ, "sample.log"), mkLines(200, 3).join("\n") + "\n"); // 200 行小行
fs.writeFileSync(path.join(PROJ, "exact50.log"), mkLines(50, 3).join("\n") + "\n"); // 恰 50 行
fs.writeFileSync(
  path.join(PROJ, "big.log"),
  Array.from({ length: 60 }, (_, i) => "x".repeat(480) + `-line-${i + 1}`).join("\n") + "\n",
); // ~29KB，字节帽先绑
fs.writeFileSync(path.join(PROJ, "minified.json"), JSON.stringify({ blob: "y".repeat(100000) })); // 单行 100KB
fs.writeFileSync(path.join(PROJ, "crlf.log"), mkLines(10, 2).join("\r\n") + "\r\n"); // CRLF
fs.writeFileSync(path.join(PROJ, "bom.md"), "\uFEFF" + mkLines(5, 2).join("\n") + "\n"); // BOM
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]), // NUL 参与 → 二进制启发命中
  Buffer.alloc(300, 7),
]);
const pngHash = crypto.createHash("sha256").update(png).digest("hex");
fs.writeFileSync(path.join(PROJ, "img.png"), png);
fs.writeFileSync(path.join(PROJ, "raw.bin"), Buffer.alloc(512, 0)); // 无 magic 的零块
const BLOB_BYTES = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

let sqliteOk = true;
try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(PROJ, "test.db"));
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
  const ins = db.prepare("INSERT INTO t(name) VALUES (?)");
  for (let i = 1; i <= 250; i++) ins.run("row-" + i);
  db.exec("CREATE TABLE b(data BLOB)");
  db.prepare("INSERT INTO b(data) VALUES (?)").run(BLOB_BYTES);
  db.close();
} catch (e) {
  sqliteOk = false;
}

const s = startServer({ root: T, cwd: PROJ });
const probe = (args) => s.call("probe", args);
const J = (r) => r.json;
const sha256 = (t) => crypto.createHash("sha256").update(t).digest("hex");
const ENVELOPE_KEYS = ["rows_truncated", "bytes", "hash", "page_token", "caps"];

try {
  // ---- PROBE-01 工具面 11 与注册形态
  {
    const tl = await s.tools();
    const names = (tl.tools || []).map((t) => t.name);
    const pr = (tl.tools || []).find((t) => t.name === PRE + "probe");
    ck.ok("PROBE-01a tools/list = 11 且含 probe（v0.6 口径）",
      names.length === 11 && !!pr, { n: names.length, has: !!pr });
    const acts = pr?.inputSchema?.properties?.action?.enum;
    ck.ok("PROBE-01b probe schema 四 action 枚举 + required",
      JSON.stringify(acts) === JSON.stringify(["db.query", "file.head", "file.grep", "bin.inspect"]) &&
      Array.isArray(pr.inputSchema.required) && pr.inputSchema.required.includes("action"), acts);
    ck.ok("PROBE-01c probe 双面可用：不入 MCP_DISALLOWED（语义复核机械钉）", (() => {
      const src = fs.readFileSync(DEFAULT_SERVER, "utf8");
      const m = src.match(/const MCP_DISALLOWED = \[([\s\S]*?)\];/);
      return !!m && !m[1].includes('"probe"') && !m[1].includes("probe");
    })());
  }

  // ---- PROBE-02 envelope 统一形态
  {
    const r = J(await probe({ action: "file.head", path: "exact50.log" }));
    const keysOk = ENVELOPE_KEYS.every((k) => k in r) && r.ok === true && r.tool === "probe" && r.action === "file.head";
    ck.ok("PROBE-02a envelope 必备键齐备（rows_truncated/bytes/hash/page_token/caps）", keysOk, Object.keys(r));
    const expect = mkLines(50, 3).join("\n");
    ck.ok("PROBE-02b hash=返回内容 sha256 且 bytes 一致",
      r.hash === sha256(expect) && r.bytes === Buffer.byteLength(expect, "utf8"), { hash: r.hash, bytes: r.bytes });
    ck.ok("PROBE-02c caps 回显（50 行/10240B）",
      r.caps?.max_rows === 50 && r.caps?.max_bytes === 10240 && r.caps?.max_line_chars === 2000, r.caps);
  }

  // ---- PROBE-03 行帽 ≤50 + 分页续传
  {
    const p1 = J(await probe({ action: "file.head", path: "sample.log" }));
    ck.ok("PROBE-03a 200 行文件默认页 ≤50 行且 rows_truncated+page_token",
      p1.lines.length === 50 && p1.rows_truncated === true && typeof p1.page_token === "string",
      { n: p1.lines.length, t: p1.page_token?.slice(0, 12) });
    const p2 = J(await probe({ action: "file.head", path: "sample.log", page_token: p1.page_token }));
    ck.ok("PROBE-03b 续页从 51 行起且 start_line 断言",
      p2.lines[0] === "line-051 payload-abcdefghijklmnop" && p2.start_line === 51,
      { first: p2.lines[0], start: p2.start_line });
    // 走到 eof：4 页收干 200 行
    let tok = p2.page_token;
    let total = p1.lines.length + p2.lines.length;
    let pages = 2;
    while (tok && pages < 10) {
      const pg = J(await probe({ action: "file.head", path: "sample.log", page_token: tok }));
      total += pg.lines.length;
      pages += 1;
      if (pg.eof) {
        ck.ok("PROBE-03c 分页走收：4 页尽 200 行、末页 eof+rows_truncated=false+无 token",
          total === 200 && pg.rows_truncated === false && pg.page_token === null && pg.eof === true,
          { total, pages, eof: pg.eof });
        tok = null;
      } else {
        tok = pg.page_token;
      }
    }
    const over = J(await probe({ action: "file.head", path: "sample.log", lines: 500 }));
    ck.ok("PROBE-03d lines 超帽请求收敛到 50（帽强制不拒客）", over.lines.length === 50, over.lines.length);
    // v0.7 A2：PROBE-02 已同参探过 exact50.log → 会命中读缓存存根；本断言验证的是
    // eof 语义而非缓存，故 no_cache:true 绕开（缓存行为归 CACHE-01..06 专组）。
    const exact = J(await probe({ action: "file.head", path: "exact50.log", no_cache: true }));
    ck.ok("PROBE-03e 恰 50 行文件：eof 直达不空翻页",
      exact.lines.length === 50 && exact.eof === true && exact.rows_truncated === false && exact.page_token === null,
      { eof: exact.eof, t: exact.rows_truncated });
  }

  // ---- PROBE-04 字节帽 ≤10KB 与单行截断
  {
    const big = J(await probe({ action: "file.head", path: "big.log" }));
    const joined = big.lines.join("\n");
    ck.ok("PROBE-04a 字节帽先绑：返回 <60 行、payload ≤10KB、rows_truncated+token",
      big.lines.length < 60 && big.bytes <= 10240 && big.bytes === Buffer.byteLength(joined, "utf8") &&
      big.rows_truncated === true && typeof big.page_token === "string",
      { n: big.lines.length, bytes: big.bytes });
    const mini = J(await probe({ action: "file.head", path: "minified.json" }));
    ck.ok("PROBE-04b 超长单行按 max_line_chars 截断并带标记",
      mini.lines.length === 1 && mini.lines[0].endsWith("...[line truncated]") &&
      mini.lines[0].length === 2000 + "...[line truncated]".length,
      { n: mini.lines.length, len: mini.lines[0].length });
  }

  // ---- PROBE-05 日志 tail ≤50 行（+CRLF/BOM）
  {
    const tail = J(await probe({ action: "file.head", path: "sample.log", tail: true }));
    ck.ok("PROBE-05a tail 取末 50 行、start_line=151、终态无 token",
      tail.lines.length === 50 && tail.lines[0] === "line-151 payload-abcdefghijklmnop" &&
      tail.lines.at(-1) === "line-200 payload-abcdefghijklmnop" && tail.start_line === 151 &&
      tail.eof === true && tail.page_token === null && tail.rows_truncated === true,
      { start: tail.start_line, tok: tail.page_token });
    const tail50 = J(await probe({ action: "file.head", path: "exact50.log", tail: true }));
    ck.ok("PROBE-05b tail 恰好全量时 rows_truncated=false", tail50.rows_truncated === false && tail50.start_line === 1, tail50.rows_truncated);
    const crlf = J(await probe({ action: "file.head", path: "crlf.log" }));
    ck.ok("PROBE-05c CRLF 行尾 \\r 被剥除", crlf.lines.length === 10 && crlf.lines.every((l) => !l.includes("\r")), crlf.lines[0]);
    const bom = J(await probe({ action: "file.head", path: "bom.md" }));
    ck.ok("PROBE-05d BOM 首行剥除", bom.lines[0] === "line-01 payload-abcdefghijklmnop", bom.lines[0]);
  }

  // ---- PROBE-06 二进制：bin.inspect 摘要 + 文本面拒绝
  {
    const refused = await probe({ action: "file.head", path: "img.png" });
    const refused2 = await probe({ action: "file.grep", path: "img.png", pattern: "x" });
    ck.ok("PROBE-06a 文本面拒二进制（NUL 启发）并指路 bin.inspect",
      refused.isError && refused2.isError && refused.text.includes("bin.inspect"), refused.text.slice(0, 120));
    const bin = J(await probe({ action: "bin.inspect", path: "img.png" }));
    ck.ok("PROBE-06b bin.inspect：magic 定型 image/png、size/hash 精确",
      bin.type === "image/png" && bin.type_source === "magic" && bin.size_bytes === png.length && bin.hash === pngHash,
      { type: bin.type, size: bin.size_bytes });
    const headDec = Buffer.from(bin.head_b64, "base64");
    ck.ok("PROBE-06c 只回首 256 字节（rows_truncated=true、无分页、head 可复原）",
      bin.head_bytes_returned === 256 && bin.rows_truncated === true && bin.page_token === null &&
      bin.hash_scope === "full" && headDec.equals(png.subarray(0, 256)), { n: bin.head_bytes_returned });
    const raw = J(await probe({ action: "bin.inspect", path: "raw.bin" }));
    const mini = J(await probe({ action: "bin.inspect", path: "minified.json" }));
    ck.ok("PROBE-06d 类型回退链：无 magic→octet-stream(fallback)、.json→application/json(extension)",
      raw.type === "application/octet-stream" && raw.type_source === "fallback" &&
      mini.type === "application/json" && mini.type_source === "extension",
      { raw: raw.type, mini: mini.type });
  }

  // ---- PROBE-07 grep -m 服务端语义
  {
    const m3 = J(await probe({ action: "file.grep", path: "sample.log", pattern: "line-", max_count: 3 }));
    ck.ok("PROBE-07a max_count=3 恰 3 匹配、rows_truncated+token（-m 语义）",
      m3.match_count === 3 && m3.matches.length === 3 && m3.matches[0].line_no === 1 &&
      m3.rows_truncated === true && typeof m3.page_token === "string", m3.match_count);
    const m3b = J(await probe({ action: "file.grep", path: "sample.log", pattern: "line-", max_count: 3, page_token: m3.page_token }));
    ck.ok("PROBE-07b grep 续页接续行号（4-6）",
      m3b.matches[0].line_no === 4 && m3b.matches.at(-1).line_no === 6, m3b.matches.map((m) => m.line_no));
    const ic = J(await probe({ action: "file.grep", path: "sample.log", pattern: "LINE-007", ignore_case: true }));
    ck.ok("PROBE-07c ignore_case 命中（grep -i）", ic.match_count === 1 && ic.matches[0].line_no === 7, ic.match_count);
    const badRe = await probe({ action: "file.grep", path: "sample.log", pattern: "([unclosed" });
    ck.ok("PROBE-07d 非法正则明确拒绝", badRe.isError && badRe.text.includes("正则"), badRe.text.slice(0, 100));
    let all = 0;
    let tok = (J(await probe({ action: "file.grep", path: "sample.log", pattern: "line-\\d+" }))).page_token;
    all += 50;
    let guard = 0;
    let lastEof = false;
    while (tok && guard < 10) {
      const pg = J(await probe({ action: "file.grep", path: "sample.log", pattern: "line-\\d+", page_token: tok }));
      all += pg.match_count;
      lastEof = pg.eof;
      tok = pg.page_token;
      guard += 1;
    }
    ck.ok("PROBE-07e grep 分页走收：200 匹配 4 页尽、末页 eof",
      all === 200 && lastEof && tok === null, { all, lastEof });
  }

  // ---- PROBE-08 db.query 只读门
  {
    if (!sqliteOk) {
      ck.ok("PROBE-08 (skip) node:sqlite 不可用，db 族降级注记", true, "node:sqlite unavailable");
    } else {
      const star = await probe({ action: "db.query", path: "test.db", query: "SELECT * FROM t" });
      const astar = await probe({ action: "db.query", path: "test.db", query: "SELECT t.* FROM t t" });
      ck.ok("PROBE-08a 禁裸 SELECT *（含别名.*），COUNT(*) 例外放行",
        star.isError && star.text.includes("SELECT *") && astar.isError &&
        (J(await probe({ action: "db.query", path: "test.db", query: "SELECT COUNT(*) AS n FROM t" })).row_count === 1),
        star.text.slice(0, 80));
      const lim = await probe({ action: "db.query", path: "test.db", query: "SELECT id FROM t LIMIT 101" });
      const limOk = await probe({ action: "db.query", path: "test.db", query: "SELECT id FROM t LIMIT 100" });
      ck.ok("PROBE-08b LIMIT ≤100：101 拒 / 100 收",
        lim.isError && lim.text.includes("100") && !limOk.isError, { lim: lim.text.slice(0, 80) });
      const w1 = await probe({ action: "db.query", path: "test.db", query: "DELETE FROM t" });
      const w2 = await probe({ action: "db.query", path: "test.db", query: "INSERT INTO t(name) VALUES ('x')" });
      const w3 = await probe({ action: "db.query", path: "test.db", query: "SELECT id INTO y FROM t" });
      ck.ok("PROBE-08c 写语句/INTO fail-closed 拒绝（白名单语义）",
        w1.isError && w2.isError && w3.isError && w1.text.includes("SELECT"), w1.text.slice(0, 80));
      const c1 = await probe({ action: "db.query", path: "test.db", query: "SELECT id FROM t; DROP TABLE t" });
      const c2 = await probe({ action: "db.query", path: "test.db", query: "SELECT id -- hidden" });
      ck.ok("PROBE-08d 多语句与注释拒绝（保分页拼装可判定）",
        c1.isError && c1.text.includes("分号") && c2.isError && c2.text.includes("注释"),
        { c1: c1.text.slice(0, 60), c2: c2.text.slice(0, 60) });
      const miss = await probe({ action: "db.query", path: "nope.db", query: "SELECT 1 AS x" });
      ck.ok("PROBE-08e 缺库文件明确报错不抛栈", miss.isError && miss.text.includes("nope.db"), miss.text.slice(0, 100));
      const blob = J(await probe({ action: "db.query", path: "test.db", query: "SELECT data FROM b" }));
      ck.ok("PROBE-08f blob 不裸吐（占位符 <blob NB>）",
        blob.row_count === 1 && blob.rows[0].data === "<blob 8B>", blob.rows?.[0]);
    }
  }

  // ---- PROBE-09 db 分页与聚合
  if (sqliteOk) {
    const p1 = J(await probe({ action: "db.query", path: "test.db", query: "SELECT id, name FROM t" }));
    ck.ok("PROBE-09a db 50 行/页包装：首页 50 行、wrapped_sql 可见、token 在",
      p1.row_count === 50 && p1.columns.join(",") === "id,name" &&
      /LIMIT 50 OFFSET 0/.test(p1.wrapped_sql) && typeof p1.page_token === "string" && p1.rows_truncated === true,
      { n: p1.row_count, w: p1.wrapped_sql });
    let tok = p1.page_token;
    let total = p1.row_count;
    let pages = 1;
    let lastTok = p1.page_token;
    while (tok && pages < 10) {
      const pg = J(await probe({ action: "db.query", path: "test.db", query: "SELECT id, name FROM t", page_token: tok }));
      total += pg.row_count;
      pages += 1;
      lastTok = pg.page_token;
      if (pg.row_count === 0 && pg.page_token === null) {
        ck.ok("PROBE-09b db 分页走收：250 行 5 页 + 空页终结（token 尽）",
          total === 250 && pages === 6 && pg.rows_truncated === false, { total, pages });
        tok = null;
      } else {
        tok = pg.page_token;
      }
    }
    const cnt = J(await probe({ action: "db.query", path: "test.db", query: "SELECT COUNT(*) AS n FROM t" }));
    ck.ok("PROBE-09c 聚合行 1 页尽：rows_truncated=false 无 token",
      cnt.row_count === 1 && cnt.rows[0].n === 250 && cnt.rows_truncated === false && cnt.page_token === null,
      cnt.rows?.[0]);
    const withLimit = J(await probe({ action: "db.query", path: "test.db", query: "SELECT id FROM t LIMIT 3" }));
    ck.ok("PROBE-09d 用户自带 LIMIT 3 为权威界：3 行尽、rows_truncated=false、无 token（不空翻页）",
      withLimit.row_count === 3 && withLimit.rows_truncated === false && withLimit.page_token === null,
      { n: withLimit.row_count, t: withLimit.rows_truncated, tok: withLimit.page_token });
  }

  // ---- PROBE-10 page_token 完整性与 action 面
  {
    // no_cache:true：PROBE-07a 已同参探过 → 不绕存根就拿不到 page_token（缓存归 CACHE 组管）
    const g = J(await probe({ action: "file.grep", path: "sample.log", pattern: "line-", max_count: 3, no_cache: true }));
    const misuse = await probe({ action: "file.head", path: "sample.log", page_token: g.page_token });
    ck.ok("PROBE-10a 跨 action 令牌拒绝", misuse.isError && misuse.text.includes("不匹配"), misuse.text.slice(0, 90));
    const garbage = await probe({ action: "file.head", path: "sample.log", page_token: "not-a-token" });
    ck.ok("PROBE-10b 垃圾令牌拒绝不抛栈", garbage.isError && garbage.text.includes("page_token"), garbage.text.slice(0, 90));
    fs.appendFileSync(path.join(PROJ, "sample.log"), "line-201 appended\n");
    const stale = await probe({ action: "file.grep", path: "sample.log", pattern: "line-", page_token: g.page_token });
    ck.ok("PROBE-10c 文件变化后旧令牌拒绝（sz 失配）", stale.isError && stale.text.includes("变化"), stale.text.slice(0, 90));
    const unk = await probe({ action: "sqlite.exec", path: "x" });
    ck.ok("PROBE-10d 未知 action 明确报错并列出四 action",
      unk.isError && ["db.query", "file.head", "file.grep", "bin.inspect"].every((a) => unk.text.includes(a)),
      unk.text.slice(0, 110));
    const noPath = await probe({ action: "file.head" });
    ck.ok("PROBE-10e 缺 path 明确报错", noPath.isError && noPath.text.includes("path"), noPath.text.slice(0, 90));
  }

  // ---- CACHE-01..06 会话级读缓存（v0.7 A2, V7-01：W-A findings §2.4 断言草案定稿）
  {
    // CACHE-01 写后读不回吐（survey 点名验收）
    fs.writeFileSync(path.join(PROJ, "cache01.txt"), "alpha-content-AAAA\n");
    const r1 = J(await probe({ action: "file.head", path: "cache01.txt" }));
    ck.ok("CACHE-01a 首探全量：无 cached 字段、内容=A",
      r1.cached === undefined && r1.lines[0] === "alpha-content-AAAA", { cached: r1.cached, line: r1.lines?.[0] });
    fs.writeFileSync(path.join(PROJ, "cache01.txt"), "beta-content-BBBBBBBB\n"); // mtime+size 双变
    const r2 = J(await probe({ action: "file.head", path: "cache01.txt" }));
    ck.ok("CACHE-01b 写后读不回吐：key 失效返回 B 非 A、非存根",
      r2.cached === undefined && r2.lines[0] === "beta-content-BBBBBBBB", { cached: r2.cached, line: r2.lines?.[0] });
    const r3 = J(await probe({ action: "file.head", path: "cache01.txt" }));
    ck.ok("CACHE-01c 同参重探 → 存根：cached:true 且 prior_hash=首次(B) hash、不含 payload",
      r3.cached === true && r3.prior_hash === r2.hash && r3.lines === undefined,
      { cached: r3.cached, h: r3.prior_hash });

    // CACHE-02 存根形态 + db.query 显式排除 + bin.inspect 可缓存
    fs.writeFileSync(path.join(PROJ, "cache02.log"), mkLines(30, 3).join("\n") + "\n");
    const a1 = J(await probe({ action: "file.head", path: "cache02.log" }));
    const a2 = J(await probe({ action: "file.head", path: "cache02.log" }));
    const STUB_KEYS = ["action", "cached", "cached_at", "note", "ok", "path", "prior_bytes", "prior_hash", "tool"]; // 预排序（对比 Object.keys().sort()）
    ck.ok("CACHE-02a 存根：cached:true、prior_hash/prior_bytes=首次值、键面恰 9 键无 payload、字节远小于首次",
      a2.cached === true && a2.prior_hash === a1.hash && a2.prior_bytes === a1.bytes &&
      JSON.stringify(Object.keys(a2).sort()) === JSON.stringify(STUB_KEYS) &&
      JSON.stringify(a2).length < JSON.stringify(a1).length / 2,
      { stubB: JSON.stringify(a2).length, fullB: JSON.stringify(a1).length, keys: Object.keys(a2),
        a1cached: a1.cached, h1: a1.hash, h2: a2.prior_hash, b1: a1.bytes, b2: a2.prior_bytes });
    if (sqliteOk) {
      const d1 = J(await probe({ action: "db.query", path: "test.db", query: "SELECT COUNT(*) AS n FROM t" }));
      const d2 = J(await probe({ action: "db.query", path: "test.db", query: "SELECT COUNT(*) AS n FROM t" }));
      ck.ok("CACHE-02b db.query 显式排除：同参重探恒全量非存根（SQLite 外部可变，mtime 不可靠）",
        d1.cached === undefined && d2.cached === undefined && d2.row_count === 1,
        { d2cached: d2.cached });
    } else {
      ck.ok("CACHE-02b (skip) node:sqlite 不可用，db 排除降级注记", true, "node:sqlite unavailable");
    }
    // bin.inspect 目标须全新（img.png/raw.bin/minified.json 已在 PROBE-06 被探入缓存）
    const binBuf = Buffer.from([0x42, 0x4d, 0, 0, 9, 9, 0, 0]);
    const binHash06 = crypto.createHash("sha256").update(binBuf).digest("hex");
    fs.writeFileSync(path.join(PROJ, "cache02.bin"), binBuf);
    const b1 = J(await probe({ action: "bin.inspect", path: "cache02.bin" }));
    const b2 = J(await probe({ action: "bin.inspect", path: "cache02.bin" }));
    ck.ok("CACHE-02c bin.inspect 亦可缓存：重探存根 prior_hash=文件全量 hash、无 head_b64",
      b1.cached === undefined && b2.cached === true && b2.prior_hash === binHash06 && b2.head_b64 === undefined,
      { b1cached: b1.cached, cached: b2.cached, h: b2.prior_hash, expect: binHash06 });

    // CACHE-03 no_cache:true 恒全量且不写缓存 + schema 增参
    fs.writeFileSync(path.join(PROJ, "cache03.txt"), "nc-v1\n");
    const n1 = J(await probe({ action: "file.head", path: "cache03.txt", no_cache: true }));
    const n2 = J(await probe({ action: "file.head", path: "cache03.txt" }));
    ck.ok("CACHE-03a no_cache 首探恒全量且零残留（随后的普通探针仍 miss 全量）",
      n1.cached === undefined && n1.lines[0] === "nc-v1" && n2.cached === undefined && n2.lines[0] === "nc-v1",
      { n1cached: n1.cached, n2cached: n2.cached });
    const n3 = J(await probe({ action: "file.head", path: "cache03.txt" }));
    const n4 = J(await probe({ action: "file.head", path: "cache03.txt", no_cache: true }));
    ck.ok("CACHE-03b 缓存在位：普通探针得存根；no_cache 命中在旁亦恒全量不回吐存根",
      n3.cached === true && n3.prior_hash === n2.hash &&
      n4.cached === undefined && n4.lines[0] === "nc-v1",
      { n3cached: n3.cached, n4cached: n4.cached });
    const prProps = (await s.tools()).tools.find((t) => t.name === PRE + "probe").inputSchema.properties;
    ck.ok("CACHE-03c schema 增 no_cache:boolean 可选参数", prProps.no_cache?.type === "boolean", prProps.no_cache);

    // CACHE-04 续页不读不写缓存（行为与 0.6 逐字节一致的回归由 PROBE-03/07 覆盖）
    fs.writeFileSync(path.join(PROJ, "cache04.log"), mkLines(120, 3).join("\n") + "\n");
    const c1 = J(await probe({ action: "file.head", path: "cache04.log" })); // 首页：miss → 存
    const c2 = J(await probe({ action: "file.head", path: "cache04.log", page_token: c1.page_token }));
    ck.ok("CACHE-04a 续页永不折存根：全量第 2 页、无 cached 字段",
      c2.cached === undefined && c2.start_line === 51 && c2.lines.length === 50,
      { cached: c2.cached, start: c2.start_line });
    const c3 = J(await probe({ action: "file.head", path: "cache04.log" }));
    ck.ok("CACHE-04b 续页未污染缓存：首页存根 prior_hash=首页 hash（续页若误写会同 key 覆盖为页2 hash 而当场抓获）",
      c3.cached === true && c3.prior_hash === c1.hash, { h: c3.prior_hash, expect: c1.hash });

    // CACHE-05 LRU 帽 64：第 65 个不同文件入帽逐最老
    const nm = (i) => `cache05-${String(i).padStart(2, "0")}.txt`;
    for (let i = 1; i <= 65; i++) fs.writeFileSync(path.join(PROJ, nm(i)), `f${i}\n`);
    let full65 = null;
    for (let i = 1; i <= 65; i++) {
      const r = J(await probe({ action: "file.head", path: nm(i) }));
      if (i === 65) full65 = r;
    }
    const e1 = J(await probe({ action: "file.head", path: nm(1) }));
    const e65 = J(await probe({ action: "file.head", path: nm(65) }));
    ck.ok("CACHE-05 帽 64 逐最老：#1 被逐（全量非存根）、#65 最新在位（存根 prior_hash=#65 首探 hash）",
      e1.cached === undefined && e1.lines[0] === "f1" &&
      e65.cached === true && e65.prior_hash === full65.hash,
      { e1cached: e1.cached, e65cached: e65.cached, h: e65.prior_hash });

    // CACHE-06 环境探针（W-A §2.4：Windows rename 原子写 mtime 精度 env-fact）+ 同尺寸改写
    const f06 = path.join(PROJ, "cache06.txt");
    const atomicWrite = (p, s2) => {
      const tmp = p + ".tmp";
      fs.writeFileSync(tmp, s2);
      fs.renameSync(tmp, p);
    };
    atomicWrite(f06, "same-length-A\n");
    const st1 = fs.statSync(f06);
    await probe({ action: "file.head", path: "cache06.txt" }); // 入缓存
    atomicWrite(f06, "same-length-B\n"); // 同尺寸（14B=14B）：size 因子失效，唯 mtime 可辨
    const st2 = fs.statSync(f06);
    const p06 = J(await probe({ action: "file.head", path: "cache06.txt" }));
    ck.ok("CACHE-06a 环境探针：同进程连续两次 rename 原子写 statSync mtimeMs 必不同（env-fact 实证）",
      st2.mtimeMs !== st1.mtimeMs, { t1: st1.mtimeMs, t2: st2.mtimeMs });
    ck.ok("CACHE-06b 同尺寸改写不回吐：mtime 因子单独完成写失效（返回 B 非 A、非存根）",
      p06.cached === undefined && p06.lines[0] === "same-length-B",
      { cached: p06.cached, line: p06.lines?.[0] });
  }
} finally {
  s.close();
  BASE.cleanup();
}
const { pass, fail, tail } = ck.summary();
process.exit(fail ? 1 : 0);
