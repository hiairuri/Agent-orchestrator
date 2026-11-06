# Contract card 6: the probe partition (a four-action read-only probe)

- **Home module**: the probe partition (mcp/tool-probe.mjs: the four action handlers + the unified envelope + the page_token mechanism + the session-cache hook); db.query runs through an out-of-process node:sqlite subprocess; the session-cache mechanism is documented separately in `cache-policy.md` (G1 virtual partitioning: probe is not physically split - separate documents, not a split face)
- **Brittleness rating** (surface-breadth x consequence-severity dual axis): **low** - purely read-only (zero board/lock interaction, zero write face), all caps mechanically enforced server-side (the SKILL §15.4 semantics turned from "advice to the model" into "server-enforced caps"); residual risks = SQL-gate forward-looking bypass and binary misreading, both fail-closed by design
- **Anchor declaration**: all line numbers in this card were measured at assembly time (v1.2 source); **line numbers are not referenced across versions** (l-20261022-6a14d6); function/constant-name dual anchors are the locating authority

---

## 1. Partition positioning and tool face

| Item | Content | Anchor |
|---|---|---|
| Tool name | `probe` (full name `mcp__plugin_agent-orchestrator_orch__probe`, 11th of the 12-tool sequence - dispatch appended at the end; the first ten tools' prefix zero-drift) | mcp/server-registry.mjs tool roster; mcp/tool-probe.mjs probeDispatchAction comment |
| Available to both ends | **not in MCP_DISALLOWED**: coordinator and subagents share the same face (read-only, so no permission differential) | mcp/server-registry.mjs MCP_DISALLOWED |
| Read-face boundary | path = any readable file (absolute or project-relative) - **probe is caps, not a sandbox**; zero board/lock interaction | `probeResolvePath` (mcp/tool-probe.mjs) |
| Binary defense | a text action's head sample (<=4096B) containing a NUL byte is rejected and pointed to bin.inspect (probeLooksBinary/probeBinaryHint) | `probeLooksBinary`/`probeBinaryHint` (mcp/tool-probe.mjs) |

Memory-face cross-reference: ORCH.md/digest/lessons.jsonl and other derived view files are all probe-readable objects, but their freshness/STALE/snapshot-authority semantics belong to `card-memory-views.md` (the three-view pull-only contract; cross-referenced, not merged) - this card governs only the probe semantics of "reading the actual bytes".

## 2. The four-action contract

### 2.1 db.query (restricted read-only SQL)

The SQL gate `probeValidateSql` (mcp/tool-probe.mjs, **fail-closed whitelist, not a blacklist**):

| 门 | 规则 | 锚点 |
|---|---|---|
| 单语句 | 含 `;` 拒（禁多语句） | 单语句门 |
| 禁注释 | `--`/`/*` 拒（注释破坏服务端 wrapper 拼装） | 禁注释门 |
| 只读白名单 | 首关键字 ∈ {SELECT, WITH}，其余一律拒 | 白名单门 |
| 禁 INTO | `\bINTO\b` 拒（SELECT-INTO 形态） | 禁 INTO 门 |
| 禁裸 * | 字符串字面量剥除后仍见 `*` 拒；`COUNT(*)`/`( * )` 豁免 | 禁裸 * 门 |
| LIMIT 帽 | 每个 LIMIT 字面量 ≤100（PROBE_DB_MAX_LIMIT）；缺省由分页 wrapper 兜住 | LIMIT 帽 |
| 长度帽 | query ≤4000 字符（PROBE_QUERY_MAX_CHARS） | 长度帽 |

执行面（均在 mcp/tool-probe.mjs）：分页 wrapper=`SELECT * FROM (<sql>) LIMIT 50 OFFSET n`（页 50 行 a fortiori ≤100）；子进程 `node --input-type=module -e` readOnly 打开（校验漏网也写不了）+10s 超时+16MB maxBuffer；node 缺 node:sqlite（需 ≥22.13/23.4）显式 ToolError（版本指引）。字节帽逐行裁剪到 ≤10KB（exact serialized payload 计量），满页/裁剪出 page_token（offset 步进 shown.length）。

### 2.2 file.head (first/last <= 50 lines)

- 行数帽 50（PROBE_MAX_ROWS），lines 传参超帽收敛、非法拒。
- **tail=true**：日志尾语义，**终态无 page_token**；1MB 扫描窗（PROBE_SCAN_WINDOW）内取末 N 行，字节帽从**尾部**绑（最新行优先拿预算）；窗口切进行内丢首残片。
- **head 模式**：page_token 续页（token 绑 offset/行号/**文件 size**——文件已变拒绝续页）；中窗切最后换行（行界续页）；单行吞窗→裁剪展示或跳过（skippedLong）；eof 权威（!eof ⟺ 有后续 ⟹ 分页）。
- 行级防护：CRLF 剥除、BOM 剥除（物理行 1）、单行裁剪 2000 字符（PROBE_MAX_LINE_CHARS——防单行吃光 10KB 预算）——`probeDecodeLine`（mcp/tool-probe.mjs）。

### 2.3 file.grep (server-side grep -m)

JS 正则（≤500 字符，ignore_case 旗标）；max_count 1-50/页（默认 50）；行界扫描+字节帽超限停在被拒行前（下一页从该行续——**不消费**）；满页/超限出 page_token；单行吞窗整行跳过不计匹配。

### 2.4 bin.inspect (type/size/hash/first 256 bytes)

magic 字节表（PNG/JPEG/GIF/PDF/ZIP/gzip/SQLite/ELF/PE/wasm/class/ogg/mp4…）→扩展名回退→octet-stream 兜底（`probeSniffType`（mcp/tool-probe.mjs））；head_b64+head_ascii 各 ≤256B（PROBE_BIN_HEAD_BYTES）；sha256 全文件 ≤32MB（PROBE_HASH_FULL_MAX），超出 hash_scope=first_N_bytes（防探针变多 GB 读）——mcp/tool-probe.mjs bin.inspect 帽面。

## 3. The unified envelope and page_token

**Every ok response = one summary JSON envelope, never a bare dump** (`probeEnvelope` (mcp/tool-probe.mjs)):

| 字段 | 语义 |
|---|---|
| ok/tool/action/path | 定位面 |
| （动作 payload） | lines/matches/rows/type 等——已按帽裁剪后的内容 |
| rows_truncated | boolean（各动作的截断语义：db=满页或裁剪；head/grep=!eof；bin=文件>256B） |
| bytes / hash | **返回 payload** 的字节与 sha256（bin.inspect 例外：hash=文件哈希，per §15.4） |
| page_token | base64url(JSON {v:1, a:action, o, ln?, sz?})——绑定 action（跨 action 重放拒）+文件 size（续页时文件已变拒）；db.query 无 ln/sz 腿 |
| caps | max_rows/max_bytes 等自描述帽面 |

token 校验（`probeDecodeToken`（mcp/tool-probe.mjs））：形状失败=ToolError 永不崩 server；与 action 不匹配、偏移/行号/尺寸越界全拒。

## 4. Failure semantics

| 情形 | 行为 | 分类 |
|---|---|---|
| path 不可读/非文件 | ToolError（probe 目标不可读/不是常规文件） | fail-loud |
| 二进制喂给文本动作 | NUL 采样拒+指向 bin.inspect | fail-loud（指路） |
| SQL 门违规 | ToolError 逐条措辞（单语句/注释/白名单/INTO/* /LIMIT） | fail-closed |
| 续页时文件已变 | page_token sz 不匹配→拒绝并要求从头重探 | fail-loud（防错位内容） |
| node:sqlite 缺失 | 显式 ToolError（版本指引） | fail-loud（指路） |
| 子进程异常/超时 | ToolError（signal/timeout 提示） | fail-loud |
| 满页恰在 EOF | eof=true、无 page_token——不多出空页 | 设计内 |
| 单行 >2000 字符 | 裁剪+`...[line truncated]`（内容可见但预算受控） | 钳制 |
| 会话缓存命中 | ~100B 存根（cached:true+prior_hash）——机制契约见 `cache-policy.md` | 降级呈现（设计内） |

## 5. Assertion anchors

- **probe-caps** (registered suite): the PROBE series (caps semantics / binary rejection / eof pagination) + the CACHE-01..06 dedicated group (cache folds to a stub / no_cache / page_token never reads or writes the cache - the cache-mechanism assertion face; details in cache-policy.md §5).
- **LM-05** (lint-manifest, M1-3 registration): this card's constant/function names (probeValidateSql/probeDecodeToken/probeEnvelope/probeLooksBinary/PROBE_MAX_ROWS etc.) grep-visible in mcp/tool-probe.mjs + the card exists and is non-empty.
- **SKILL §15.4**: the documentation authority for cap semantics - if this card and that section drift, the source code arbitrates and both documents re-sync.

## 6. Maintenance rules

- New action: the probeDispatchAction dispatch table + envelope compatibility (the five mandatory fields rows_truncated/bytes/hash/page_token among them) + the page_token binding shape + the probe-caps assertion group - all five land together; the cache admission-gate decision (cacheable or not) syncs `cache-policy.md` §2.
- Cap value adjustments: the PROBE series constants (the mcp/server-core.mjs constants section) and this card's §2 change in the same wave; if SKILL §15.4 cites the values, verify it in the same wave.
- The SQL gate admits only the allowlist: **a new keyword = an explicit ruling face** (a blacklist-mindset relapse opens the defense); the `*` exemption face recognizes only the COUNT/aggregate-parenthesis forms.
