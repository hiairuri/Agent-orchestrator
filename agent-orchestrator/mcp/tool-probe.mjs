// agent-orchestrator orch server — tool: probe（db.query/file.head/file.grep/bin.inspect+会话读缓存；机械拆分自 server.mjs L8898-9656）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import child_process from "node:child_process";
import {
  ToolError, displayPath, projectDir, truncateStr, PROBE_MAX_ROWS, PROBE_MAX_BYTES,
  PROBE_BIN_HEAD_BYTES, PROBE_DB_MAX_LIMIT, PROBE_DB_PAGE_ROWS,
  PROBE_QUERY_MAX_CHARS, PROBE_PATTERN_MAX_CHARS, PROBE_MAX_LINE_CHARS,
  PROBE_HASH_FULL_MAX, PROBE_SCAN_WINDOW, PROBE_DB_TIMEOUT_MS,
  PROBE_CACHE_MAX_ENTRIES, PROBE_DB_CHILD,
} from "./server-core.mjs";
/* ------------------------------------------------------------------ */
/* tool: probe (v0.6 V6-01)                                            */
/*                                                                     */
/* Structured read probe — context-economy pillar #2. Turns the        */
/* SKILL §15.4 probe discipline (DB 禁 SELECT *、LIMIT ≤100；二进制只回  */
/* 类型/大小/哈希/首 256 字节；日志 tail ≤50 行或 grep -m；单次 ≤50 行    */
/* 或 ≤10KB 超限分页) from "advice to the model" into server-enforced   */
/* caps. Four actions:                                                 */
/*   db.query     restricted read-only SQL over a SQLite file (via the */
/*                node:sqlite child above; bare "SELECT star" and      */
/*                alias-star rejected, COUNT(*) allowed; LIMIT ≤100    */
/*                enforced; SELECT/WITH allowlist — fail closed;       */
/*                50 rows/page)                                        */
/*   file.head    first ≤50 lines (mode tail = log-tail half, no page) */
/*   file.grep    server-side grep -m semantics (max_count ≤50/page)   */
/*   bin.inspect  type / size / sha256 / first 256 bytes only          */
/* Every ok response is ONE summary JSON envelope carrying             */
/* rows_truncated / bytes / hash / page_token — never a raw dump.      */
/* Read-only, dual-side usable (coordinator + subagents), hence NOT in */
/* MCP_DISALLOWED; no board/lock interaction. Paths may point anywhere */
/* readable — probe is about caps, not a sandbox.                      */
/* ------------------------------------------------------------------ */

function probeSha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function probeEncodeToken(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

/** Decode + validate a page_token. Bound to its action so tokens cannot be
 *  replayed across actions; shape failures are ToolErrors, never crashes. */
function probeDecodeToken(tok, action) {
  if (typeof tok !== "string" || !tok.trim()) {
    throw new ToolError("page_token 无效：需为上次 probe 响应原样返回的令牌");
  }
  let obj;
  try {
    obj = JSON.parse(Buffer.from(tok.trim(), "base64url").toString("utf8"));
  } catch {
    throw new ToolError("page_token 无效：解码失败（令牌已损坏）");
  }
  if (!obj || typeof obj !== "object" || obj.v !== 1 || obj.a !== action) {
    throw new ToolError(
      `page_token 无效或与 action 不匹配（期望 ${action} 的令牌）`,
    );
  }
  const o = Math.floor(Number(obj.o));
  if (!Number.isFinite(o) || o < 0) throw new ToolError("page_token 无效：偏移越界");
  const out = { o };
  if (action !== "db.query") {
    const ln = Math.floor(Number(obj.ln));
    if (!Number.isFinite(ln) || ln < 1) throw new ToolError("page_token 无效：行号越界");
    out.ln = ln;
    out.sz = Math.floor(Number(obj.sz));
    if (!Number.isFinite(out.sz) || out.sz < 0) throw new ToolError("page_token 无效：尺寸越界");
  }
  return out;
}

/** page_token payload for text actions: binds to (action, offset, line, size)
 *  so a page-2 call against a changed or wrong file is rejected instead of
 *  silently returning misaligned content. */
function probeTextToken(action, o, ln, size) {
  return probeEncodeToken({ v: 1, a: action, o, ln, sz: size });
}

/** Resolve a probe target (absolute, or relative to the project dir). */
function probeResolvePath(raw) {
  const s = String(raw ?? "").trim();
  if (!s) throw new ToolError("probe 需要 path（绝对路径，或相对项目根的路径）");
  return path.resolve(projectDir, s);
}

function probeStatFile(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new ToolError(`probe 目标不可读：${displayPath(p)}`);
  }
  if (!st.isFile()) throw new ToolError(`probe 目标不是常规文件：${displayPath(p)}`);
  return st;
}

/** NUL byte anywhere in the sampled head reads as binary; text actions refuse
 *  and point at bin.inspect (SKILL §15.4: 二进制只回显类型/大小/哈希/首 256 字节). */
function probeLooksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function probeBinaryHint(p) {
  return `${displayPath(p)} 疑似二进制（含 NUL 字节）——二进制探针用 action=bin.inspect（类型/大小/哈希/首 256 字节）`;
}

/** Decode one line for display: strip CR (CRLF files), BOM on physical line 1,
 *  clip overlong lines so a single minified row cannot eat the 10KB budget. */
function probeDecodeLine(buf, a, b, lineNo) {
  let text = buf.toString("utf8", a, b);
  if (text.endsWith("\r")) text = text.slice(0, -1);
  if (lineNo === 1 && a === 0 && text.startsWith("\uFEFF")) text = text.slice(1);
  if (text.length > PROBE_MAX_LINE_CHARS) {
    text = text.slice(0, PROBE_MAX_LINE_CHARS) + "...[line truncated]";
  }
  return text;
}

/** Uniform summary envelope (rows_truncated / bytes / hash / page_token are the
 *  DESIGN §5.1 named fields; bytes/hash always describe the returned payload —
 *  except bin.inspect where hash is the file hash per §15.4). */
function probeEnvelope(action, p, payload, { rowsTruncated, bytes, hash, pageToken }) {
  return {
    ok: true,
    tool: "probe",
    action,
    path: displayPath(p),
    ...payload,
    rows_truncated: rowsTruncated === true,
    bytes,
    hash,
    page_token: pageToken ?? null,
    caps: {
      max_rows: PROBE_MAX_ROWS,
      max_bytes: PROBE_MAX_BYTES,
      max_line_chars: PROBE_MAX_LINE_CHARS,
    },
  };
}

/* -- probe: db.query ------------------------------------------------- */

/**
 * §15.4 letter, mechanically enforced:
 *  - single statement, no comments (comments would break the wrapper splice);
 *  - SELECT/WITH allowlist (fail closed — no write-keyword blocklist to evade);
 *  - INTO banned (SELECT-INTO shape);
 *  - bare SELECT * / alias.* rejected, COUNT(*) allowed (聚合/COUNT half);
 *  - every LIMIT literal ≤100, absence healed by the pagination wrapper.
 * Execution: child node:sqlite readOnly + 10s timeout; page = LIMIT 50 OFFSET n
 * (a fortiori ≤100), byte cap clips the page, page_token continues.
 */
function probeValidateSql(raw) {
  const sql = String(raw ?? "").trim();
  if (!sql) throw new ToolError("db.query 需要 query（只读 SQL）");
  if (sql.length > PROBE_QUERY_MAX_CHARS) {
    throw new ToolError(
      `query 过长（${sql.length} > ${PROBE_QUERY_MAX_CHARS} 字符）——探针只收小查询`,
    );
  }
  if (sql.includes(";")) {
    throw new ToolError("query 含分号——探针只执行单条语句（禁多语句）");
  }
  if (sql.includes("--") || sql.includes("/*")) {
    throw new ToolError("query 禁含 SQL 注释（-- 或 /*）——注释会破坏服务端强制分页的语句拼装");
  }
  const lead = sql.match(/^[A-Za-z]+/);
  const kw = lead ? lead[0].toUpperCase() : "";
  if (kw !== "SELECT" && kw !== "WITH") {
    throw new ToolError("query 仅允许只读 SELECT / WITH 语句（探针面 fail-closed，非读语句一律拒绝）");
  }
  if (/\bINTO\b/i.test(sql)) {
    throw new ToolError("query 禁含 INTO（防 SELECT-INTO 形态）");
  }
  const stripped = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
  if (stripped.includes("*")) {
    const withoutCountStar = stripped.replace(/\(\s*\*/g, "("); // COUNT( * ) stays legal
    if (withoutCountStar.includes("*")) {
      throw new ToolError(
        "裸 SELECT * 被帽拒绝（SELECT 列表禁 * / 别名.*；COUNT(*) 除外）——请显式列字段或聚合",
      );
    }
  }
  for (const m of stripped.matchAll(/\bLIMIT\s+(\d+)/gi)) {
    if (Number(m[1]) > PROBE_DB_MAX_LIMIT) {
      throw new ToolError(
        `LIMIT ${m[1]} 超帽（≤${PROBE_DB_MAX_LIMIT}）——请调低，或去掉 LIMIT 由服务端分页接管`,
      );
    }
  }
  return sql;
}

function probeDbQuery(args) {
  const p = probeResolvePath(args.path);
  probeStatFile(p);
  const sql = probeValidateSql(args.query);

  const tok = args.page_token
    ? probeDecodeToken(args.page_token, "db.query")
    : { o: 0 };
  const wrapped = `SELECT * FROM (${sql}) LIMIT ${PROBE_DB_PAGE_ROWS} OFFSET ${tok.o}`;

  const r = child_process.spawnSync(
    process.execPath,
    ["--input-type=module", "-e", PROBE_DB_CHILD],
    {
      encoding: "utf8",
      timeout: PROBE_DB_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        ORCH_PROBE_DB: p,
        ORCH_PROBE_SQL: wrapped,
      },
    },
  );
  if (r.error || (r.signal !== undefined && r.signal !== null)) {
    throw new ToolError(
      `db.query 子进程异常${r.signal ? `（${r.signal}，可能超时 ${PROBE_DB_TIMEOUT_MS}ms）` : ""}：${r.error?.message ?? "no detail"}`,
    );
  }
  if (r.status !== 0) {
    const tail = String(r.stderr || "").trim().split("\n").slice(-3).join(" | ").slice(0, 300);
    if (/node:sqlite/i.test(tail)) {
      throw new ToolError(`db.query 不可用：本机 node 缺 node:sqlite 内建（需 Node ≥22.13 / 23.4）｜${tail}`);
    }
    throw new ToolError(`db.query 失败（exit ${r.status}）：${tail || "no stderr"}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new ToolError("db.query 子进程输出不可解析（无有效 JSON）");
  }
  const fetched = Array.isArray(parsed.rows) ? parsed.rows : [];
  const columns = Array.isArray(parsed.columns) ? parsed.columns : [];

  // byte cap clips the page; the next token resumes at the first shown-away row.
  // The cap and the reported `bytes` are measured on the EXACT serialized payload
  // (rows JSON array), so a response can never print more than 10KB of rows.
  let shown = fetched.slice();
  let payloadText = JSON.stringify(shown);
  while (shown.length > 0 && Buffer.byteLength(payloadText, "utf8") > PROBE_MAX_BYTES) {
    shown = shown.slice(0, -1);
    payloadText = JSON.stringify(shown);
  }
  const clipped = shown.length < fetched.length;
  const fullPage = fetched.length === PROBE_DB_PAGE_ROWS && !clipped;
  const truncated = fullPage || clipped;
  const pageToken =
    truncated && shown.length > 0
      ? probeEncodeToken({ v: 1, a: "db.query", o: tok.o + shown.length })
      : null;
  const bytes = Buffer.byteLength(payloadText, "utf8");
  return probeEnvelope(
    "db.query",
    p,
    {
      query: truncateStr(sql, 200),
      query_chars: sql.length,
      wrapped_sql: truncateStr(wrapped, 240),
      page_offset: tok.o,
      columns,
      row_count: shown.length,
      rows: shown,
      ...(shown.length === 0 && truncated
        ? { note: "首行即超 10KB 响应帽——请收窄列或改聚合（行级分页无法再切）" }
        : {}),
    },
    {
      rowsTruncated: truncated,
      bytes,
      hash: probeSha256(payloadText),
      pageToken,
    },
  );
}

/* -- probe: file.head ------------------------------------------------ */

function probeFileHead(args) {
  const p = probeResolvePath(args.path);
  const st = probeStatFile(p);
  const tail = args.tail === true;
  let want = args.lines == null ? PROBE_MAX_ROWS : Math.floor(Number(args.lines));
  if (!Number.isFinite(want) || want < 1) {
    throw new ToolError("lines 需为 ≥1 的数字（帽 50 行/次，超帽自动收敛）");
  }
  want = Math.min(want, PROBE_MAX_ROWS);

  const fd = fs.openSync(p, "r");
  try {
    if (tail) {
      // §15.4: 日志用 tail ≤50 行 —— the tail is terminal by definition:
      // no page_token; walk earlier lines with head mode if ever needed.
      const win = Math.min(st.size, PROBE_SCAN_WINDOW);
      const from = st.size - win;
      const buf = Buffer.alloc(win);
      if (win) fs.readSync(fd, buf, 0, win, from);
      if (probeLooksBinary(buf)) throw new ToolError(probeBinaryHint(p));
      const ranges = [];
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 10) {
          ranges.push([start, i]);
          start = i + 1;
        }
      }
      if (start < buf.length) ranges.push([start, buf.length]); // no trailing \n
      if (from > 0 && ranges.length) ranges.shift(); // window cut mid-line: drop the fragment
      const picked = ranges.slice(Math.max(0, ranges.length - want));
      const pickedBase = ranges.length - picked.length; // absolute index of first picked line
      // byte cap binds from the END (the freshest lines win the budget);
      // separators count toward the cap so `bytes` === Buffer.byteLength(joined)
      const lines = [];
      let bytes = 0;
      let clippedOld = false;
      for (let i = picked.length - 1; i >= 0; i--) {
        const text = probeDecodeLine(buf, picked[i][0], picked[i][1], from === 0 ? pickedBase + i + 1 : 0);
        const b = Buffer.byteLength(text, "utf8");
        const sep = lines.length > 0 ? 1 : 0;
        if (bytes + sep + b > PROBE_MAX_BYTES) {
          if (lines.length === 0) {
            lines.unshift(text); // defensive: newest line alone over cap (clip keeps ≤ ~2K chars)
            bytes += b;
          } else {
            clippedOld = true;
            break;
          }
        } else {
          lines.unshift(text);
          bytes += sep + b;
        }
      }
      const truncated =
        ranges.length > want || clippedOld || from > 0 || picked.length > lines.length;
      const joined = lines.join("\n");
      return probeEnvelope(
        "file.head",
        p,
        {
          mode: "tail",
          lines,
          start_line: from === 0 && lines.length ? pickedBase + 1 : null,
          file_size: st.size,
          window_bytes: win,
          eof: true,
        },
        { rowsTruncated: truncated, bytes, hash: probeSha256(joined), pageToken: null },
      );
    }

    // head mode (with page_token continuation)
    let o = 0;
    let ln = 1;
    if (args.page_token) {
      const t = probeDecodeToken(args.page_token, "file.head");
      if (t.sz !== st.size) {
        throw new ToolError("page_token 与当前文件状态不符（文件已变化）——请从头重探");
      }
      o = Math.min(t.o, st.size);
      ln = t.ln;
    }
    const startLine = ln;
    const lines = [];
    let bytes = 0;
    let truncated = false;
    let eof = false;
    let skippedLong = 0;
    while (lines.length < want && bytes < PROBE_MAX_BYTES) {
      const win = Math.min(PROBE_SCAN_WINDOW, st.size - o);
      if (win <= 0) {
        eof = true;
        break;
      }
      const buf = Buffer.alloc(win);
      fs.readSync(fd, buf, 0, win, o);
      if (o === 0 && probeLooksBinary(buf)) throw new ToolError(probeBinaryHint(p));
      let boundary = win; // EOF window: everything is consumable
      if (o + win < st.size) {
        // mid-file window: cut at the LAST newline (line-boundary continuation)
        let cut = -1;
        for (let i = win - 1; i >= 0; i--) {
          if (buf[i] === 10) {
            cut = i;
            break;
          }
        }
        if (cut < 0) {
          // window sits inside one giant line: show a clipped fragment, skip on
          const text = probeDecodeLine(buf, 0, win, ln);
          const b = Buffer.byteLength(text, "utf8");
          const sep = lines.length > 0 ? 1 : 0;
          if (bytes + sep + b > PROBE_MAX_BYTES) {
            // budget exhausted: skip the giant line's window without showing it
            truncated = true;
            o += win;
            ln += 1;
            skippedLong += 1;
            break;
          }
          lines.push(text);
          bytes += sep + b;
          o += win;
          ln += 1;
          skippedLong += 1;
          truncated = true;
          break;
        }
        boundary = cut + 1;
      }
      let pos = 0;
      let stopped = false;
      while (pos < boundary && lines.length < want) {
        let nl = -1;
        for (let i = pos; i < boundary; i++) {
          if (buf[i] === 10) {
            nl = i;
            break;
          }
        }
        const end = nl === -1 ? boundary : nl;
        const text = probeDecodeLine(buf, pos, end, ln);
        const b = Buffer.byteLength(text, "utf8");
        const sep = lines.length > 0 ? 1 : 0;
        if (bytes + sep + b > PROBE_MAX_BYTES) {
          truncated = true;
          stopped = true;
          break;
        }
        lines.push(text);
        bytes += sep + b;
        ln += 1;
        pos = nl === -1 ? boundary : nl + 1;
      }
      o += pos;
      if (stopped) break;
    }
    if (!eof && o >= st.size) eof = true; // caps filled exactly at the end: no page 2
    const joined = lines.join("\n");
    return probeEnvelope(
      "file.head",
      p,
      {
        mode: "head",
        lines,
        start_line: lines.length ? startLine : null,
        file_size: st.size,
        ...(skippedLong ? { skipped_long_lines: skippedLong } : {}),
        eof,
      },
      {
        // eof is authoritative: caps-bound pages (row/byte/giant-line) exit the
        // scan loop before it, so !eof ⟺ more content remains ⟹ paginate
        rowsTruncated: !eof,
        bytes,
        hash: probeSha256(joined),
        pageToken: eof ? null : probeTextToken("file.head", o, ln, st.size),
      },
    );
  } finally {
    fs.closeSync(fd);
  }
}

/* -- probe: file.grep ------------------------------------------------ */

function probeFileGrep(args) {
  const p = probeResolvePath(args.path);
  const st = probeStatFile(p);
  const pattern = String(args.pattern ?? "");
  if (!pattern.trim()) throw new ToolError("file.grep 需要 pattern（JS 正则）");
  if (pattern.length > PROBE_PATTERN_MAX_CHARS) {
    throw new ToolError(`pattern 过长（> ${PROBE_PATTERN_MAX_CHARS} 字符）`);
  }
  let re;
  try {
    re = new RegExp(pattern, args.ignore_case === true ? "i" : "");
  } catch (e) {
    throw new ToolError(`pattern 不是合法正则：${e.message}`);
  }
  let maxCount =
    args.max_count == null ? PROBE_MAX_ROWS : Math.floor(Number(args.max_count));
  if (!Number.isFinite(maxCount) || maxCount < 1) {
    throw new ToolError("max_count 需为 ≥1（grep -m 语义，帽 50/页）");
  }
  maxCount = Math.min(maxCount, PROBE_MAX_ROWS);

  let o = 0;
  let ln = 1;
  if (args.page_token) {
    const t = probeDecodeToken(args.page_token, "file.grep");
    if (t.sz !== st.size) {
      throw new ToolError("page_token 与当前文件状态不符（文件已变化）——请从头重探");
    }
    o = Math.min(t.o, st.size);
    ln = t.ln;
  }
  const fd = fs.openSync(p, "r");
  try {
    if (o === 0) {
      const sniff = Buffer.alloc(Math.min(4096, st.size));
      if (sniff.length) {
        fs.readSync(fd, sniff, 0, sniff.length, 0);
        if (probeLooksBinary(sniff)) throw new ToolError(probeBinaryHint(p));
      }
    }
    const matches = [];
    let bytes = 0;
    let eof = false;
    let skippedLong = 0;
    while (matches.length < maxCount && bytes < PROBE_MAX_BYTES) {
      const win = Math.min(PROBE_SCAN_WINDOW, st.size - o);
      if (win <= 0) {
        eof = true;
        break;
      }
      const buf = Buffer.alloc(win);
      fs.readSync(fd, buf, 0, win, o);
      let boundary = win; // EOF window
      if (o + win < st.size) {
        let cut = -1;
        for (let i = win - 1; i >= 0; i--) {
          if (buf[i] === 10) {
            cut = i;
            break;
          }
        }
        if (cut < 0) {
          // one line spans the whole window: skip it wholesale (never matches usefully)
          o += win;
          ln += 1;
          skippedLong += 1;
          continue;
        }
        boundary = cut + 1;
      }
      let pos = 0;
      let stopped = false;
      while (pos < boundary && matches.length < maxCount) {
        let nl = -1;
        for (let i = pos; i < boundary; i++) {
          if (buf[i] === 10) {
            nl = i;
            break;
          }
        }
        const end = nl === -1 ? boundary : nl;
        const text = probeDecodeLine(buf, pos, end, ln);
        if (re.test(text)) {
          const b = Buffer.byteLength(text, "utf8");
          const sep = matches.length > 0 ? 1 : 0; // joined with \n in the payload
          if (bytes + sep + b > PROBE_MAX_BYTES) {
            stopped = true; // do not consume: next page resumes at this line
            break;
          }
          matches.push({ line_no: ln, text });
          bytes += sep + b;
        }
        ln += 1;
        pos = nl === -1 ? boundary : nl + 1;
      }
      o += pos;
      if (stopped) break;
    }
    if (!eof && o >= st.size) eof = true; // caps filled exactly at the end: no page 2
    const joined = matches.map((m) => m.text).join("\n");
    return probeEnvelope(
      "file.grep",
      p,
      {
        pattern,
        ignore_case: args.ignore_case === true,
        max_count: maxCount,
        matches,
        match_count: matches.length,
        ...(skippedLong ? { skipped_long_lines: skippedLong } : {}),
        eof,
      },
      {
        rowsTruncated: !eof,
        bytes,
        hash: probeSha256(joined),
        pageToken: eof ? null : probeTextToken("file.grep", o, ln, st.size),
      },
    );
  } finally {
    fs.closeSync(fd);
  }
}

/* -- probe: bin.inspect ---------------------------------------------- */

/** Small magic-byte table; falls back by extension, then to text/octet-stream. */
function probeSniffType(head, p) {
  const a = (n) => head.toString("latin1", 0, Math.min(n, head.length));
  if (a(8) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return ["image/webp", "magic"];
  if (a(4) === "RIFF" && head.toString("latin1", 8, 12) === "WAVE") return ["audio/wav", "magic"];
  if (a(8).startsWith("\x89PNG")) return ["image/png", "magic"];
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ["image/jpeg", "magic"];
  if (a(6) === "GIF87a" || a(6) === "GIF89a") return ["image/gif", "magic"];
  if (a(5) === "%PDF-") return ["application/pdf", "magic"];
  if (a(4) === "PK\x03\x04") return ["application/zip", "magic"];
  if (head[0] === 0x1f && head[1] === 0x8b) return ["application/gzip", "magic"];
  if (a(16) === "SQLite format 3\x00") return ["application/sqlite3", "magic"];
  if (a(4) === "\x7fELF") return ["application/elf", "magic"];
  if (a(2) === "MZ") return ["application/x-pe-executable", "magic"];
  if (a(4) === "\x00asm") return ["application/wasm", "magic"];
  if (a(4) === "\xca\xfe\xba\xbe") return ["application/java-class", "magic"];
  if (a(4) === "OggS") return ["audio/ogg", "magic"];
  if (head.length >= 12 && a(4) === "ftyp") {
    return ["video/mp4", "magic"];
  }
  const ext = path.extname(p).toLowerCase();
  const byExt = {
    ".json": "application/json",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".log": "text/plain",
    ".csv": "text/csv",
    ".xml": "application/xml",
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".cjs": "text/javascript",
    ".ts": "text/typescript",
  };
  if (byExt[ext]) return [byExt[ext], "extension"];
  return ["application/octet-stream", "fallback"];
}

function probeBinInspect(args) {
  const p = probeResolvePath(args.path);
  const st = probeStatFile(p);
  const fd = fs.openSync(p, "r");
  let head;
  let hash;
  let hashScope;
  try {
    const headLen = Math.min(st.size, PROBE_BIN_HEAD_BYTES);
    head = Buffer.alloc(headLen);
    if (headLen) fs.readSync(fd, head, 0, headLen, 0);
    const hashLen = Math.min(st.size, PROBE_HASH_FULL_MAX);
    const hashBuf = Buffer.alloc(hashLen);
    if (hashLen) fs.readSync(fd, hashBuf, 0, hashLen, 0);
    hash = probeSha256(hashBuf);
    hashScope = hashLen === st.size ? "full" : `first_${PROBE_HASH_FULL_MAX}_bytes`;
  } finally {
    fs.closeSync(fd);
  }
  const [type, typeSource] = probeSniffType(head, p);
  const printable = head
    .toString("latin1")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\xff]/g, ".");
  return probeEnvelope(
    "bin.inspect",
    p,
    {
      type,
      type_source: typeSource,
      size_bytes: st.size,
      hash_scope: hashScope,
      head_bytes_returned: head.length,
      head_b64: head.toString("base64"),
      head_ascii: printable,
    },
    {
      // §15.4: 二进制只回显首 256 字节 —— a bigger file is by definition truncated
      rowsTruncated: st.size > PROBE_BIN_HEAD_BYTES,
      bytes: head.length,
      hash, // file hash per §15.4 (类型/大小/哈希/首 256 字节)
      pageToken: null,
    },
  );
}

/* -- probe: dispatch -------------------------------------------------- */

/* -- probe: session read cache (v0.7 A2, V7-01) ------------------------ */

// W-A §2: repeated identical probes fold into a ~100B stub at the single
// dispatch choke point — "don't re-probe" stops being discipline and becomes
// mechanism. Only the file actions are cacheable: db.query reads an externally
// mutable SQLite file whose mtime is not a trustworthy invalidator, so it is
// excluded by construction. Calls carrying page_token never read nor write the
// cache (offset semantics make a stub meaningless; the token's own sz binding
// at probeDecodeToken already guards continuation freshness). Invalidation
// needs no protocol: the key carries mtimeMs+size, so any host write shifts
// the key → miss → full re-read.
const PROBE_CACHE_ACTIONS = new Set(["file.head", "file.grep", "bin.inspect"]);
const probeCache = new Map(); // insertion order = LRU: hit = delete+set touch; evict-oldest past cap

/** Cache key: action + args minus page_token/no_cache (canonical: sorted keys,
 *  undefined dropped) + mtimeMs + size. The mtime+size dual factor IS the write
 *  invalidation — no write-notification protocol, same philosophy as the
 *  page_token sz binding. */
function probeCacheKey(action, args, st) {
  const flat = {};
  for (const k of Object.keys(args).sort()) {
    if (k === "page_token" || k === "no_cache") continue;
    if (args[k] !== undefined) flat[k] = args[k];
  }
  return JSON.stringify([action, flat, st.mtimeMs, st.size]);
}

/** ~100B hit stub: a machine-honest pointer, never the payload (carrying the
 *  payload would erase the byte savings). no_cache:true is the escape hatch
 *  for the residual case where the first full response was already condensed
 *  out of the session context and only the hash pointer remains. */
function probeCacheStub(entry, action, p) {
  return {
    ok: true,
    tool: "probe",
    action,
    path: displayPath(p),
    cached: true,
    cached_at: entry.at,
    prior_hash: entry.hash,
    prior_bytes: entry.bytes,
    note: "本会话上文已含同 hash 完整结果；no_cache:true 可强制重读",
  };
}

function probeDispatchAction(action, args) {
  if (action === "db.query") return probeDbQuery(args);
  if (action === "file.head") return probeFileHead(args);
  if (action === "file.grep") return probeFileGrep(args);
  if (action === "bin.inspect") return probeBinInspect(args);
  throw new ToolError(
    `unknown probe action: ${JSON.stringify(truncateStr(action, 32))} (use db.query|file.head|file.grep|bin.inspect)`,
  );
}

function toolProbe(args) {
  const action = String(args.action ?? "");
  if (PROBE_CACHE_ACTIONS.has(action) && args.page_token == null && args.no_cache !== true) {
    let p = null;
    let st = null;
    try {
      p = probeResolvePath(args.path);
      st = probeStatFile(p); // same ToolError wording as the handler's own checks
    } catch {
      /* unresolvable target: fall through — the handler owns the error */
    }
    if (p && st) {
      const key = probeCacheKey(action, args, st);
      const hit = probeCache.get(key);
      if (hit) {
        probeCache.delete(key);
        probeCache.set(key, hit); // LRU touch
        return probeCacheStub(hit, action, p);
      }
      const res = probeDispatchAction(action, args);
      if (res && res.ok === true && typeof res.hash === "string") {
        probeCache.set(key, { at: new Date().toISOString(), hash: res.hash, bytes: res.bytes });
        while (probeCache.size > PROBE_CACHE_MAX_ENTRIES) {
          probeCache.delete(probeCache.keys().next().value); // evict oldest
        }
      }
      return res;
    }
  }
  return probeDispatchAction(action, args);
}

export {
  toolProbe,
};
