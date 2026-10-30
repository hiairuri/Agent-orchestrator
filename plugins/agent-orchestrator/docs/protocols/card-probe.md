# 契约卡⑥：probe 分区（四动作只读探针）

- **归属模块**：mcp/server.mjs probe 分区（分区注释锚 :8418-8435；四动作处理器+统一信封+page_token 机制+会话缓存挂点）；db.query 经进程外 node:sqlite 子进程（server 头注释 :10-12 的第三类 subprocess 用途）；会话缓存机制分立 `cache-policy.md`（G1 虚拟分区：probe 不物理拆，文档分立非拆面）
- **脆度评级**（面广度×后果重度双轴）：**低**——纯只读（零 board/lock 交互、零写面）、caps 全部 server 端机械强制（SKILL §15.4 语义从「对模型的劝告」转为「server 强制帽」，V6-01）；残余风险=SQL 门前瞻绕过与二进制误读，均有 fail-closed 设计
- **历史事故回链**：V6-01（caps 从纪律变机制）、V7-01（会话读缓存=LRR64，细节归 cache-policy.md）、SKILL §15.4（cap 语义权威源）
- **锚点声明**：本卡行号系总装时点（v1.2 源码）实测，**不作跨版引用**（l-20261022-6a14d6）；函数名/常量名双锚为定位权威

---

## 1. 分区定位与工具面

| 项 | 内容 | 锚点 |
|---|---|---|
| 工具名 | `probe`（全名 `mcp__plugin_agent-orchestrator_orch__probe`，12 工具序列第 11 位——dispatch 追加末位以保持旧十工具前缀零漂移） | :17-21；:9900-9903 注释 |
| 双端可用 | **不在 MCP_DISALLOWED**：主控与子代理同面（只读所以不设权限差） | :8432-8433 |
| 读面边界 | 路径=任意可读文件（绝对或项目相对）——**probe 是 caps 不是沙箱**；零 board/lock 交互 | probeResolvePath :8483-8487；:8433-8434 |
| 二进制防线 | 文本动作头部采样（≤4096B）含 NUL 字节即拒并指 bin.inspect（probeLooksBinary/probeBinaryHint） | :8500-8510；:8708/:8786/:8913 |

## 2. 四动作契约

### 2.1 db.query（受限只读 SQL）

SQL 门 probeValidateSql（:8558-8599，**fail-closed 白名单非黑名单**）：

| 门 | 规则 | 锚点 |
|---|---|---|
| 单语句 | 含 `;` 拒（禁多语句） | :8566-8568 |
| 禁注释 | `--`/`/*` 拒（注释破坏服务端 wrapper 拼装） | :8569-8571 |
| 只读白名单 | 首关键字 ∈ {SELECT, WITH}，其余一律拒 | :8572-8576 |
| 禁 INTO | `\bINTO\b` 拒（SELECT-INTO 形态） | :8577-8579 |
| 禁裸 * | 字符串字面量剥除后仍见 `*` 拒；`COUNT(*)`/`( * )` 豁免 | :8580-8590 |
| LIMIT 帽 | 每个 LIMIT 字面量 ≤100（PROBE_DB_MAX_LIMIT）；缺省由分页 wrapper 兜住 | :8591-8597 |
| 长度帽 | query ≤4000 字符（PROBE_QUERY_MAX_CHARS） | :8561-8565 |

执行面：wrapper=`SELECT * FROM (<sql>) LIMIT 50 OFFSET n`（页 50 行 a fortiori ≤100）——:8609；子进程 `node --input-type=module -e` readOnly 打开（校验漏网也写不了）+10s 超时+16MB maxBuffer（:8611-8635）；node 缺 node:sqlite（需 ≥22.13/23.4）显式 ToolError（:8632-8634）。字节帽逐行裁剪到 ≤10KB（exact serialized payload 计量），满页/裁剪出 page_token（offset 步进 shown.length）——:8646-8661。

### 2.2 file.head（首/尾 ≤50 行）

- 行数帽 50（PROBE_MAX_ROWS），lines 传参超帽收敛、非法拒——:8693-8697。
- **tail=true**：日志尾语义，**终态无 page_token**；1MB 扫描窗（PROBE_SCAN_WINDOW）内取末 N 行，字节帽从**尾部**绑（最新行优先拿预算）；窗口切进行内丢首残片——:8701-8758。
- **head 模式**：page_token 续页（token 绑 offset/行号/**文件 size**——文件已变拒绝续页）；中窗切最后换行（行界续页）；单行吞窗→裁剪展示或跳过（skippedLong）；eof 权威（!eof ⟺ 有后续 ⟹ 分页）——:8761-8868。
- 行级防护：CRLF 剥除、BOM 剥除（物理行 1）、单行裁剪 2000 字符（PROBE_MAX_LINE_CHARS——防一行压缩 JSON 吃光 10KB 预算）——probeDecodeLine :8512-8522。

### 2.3 file.grep（server 端 grep -m）

JS 正则（≤500 字符，ignore_case 旗标）；max_count 1-50/页（默认 50）；行界扫描+字节帽超限停在被拒行前（下一页从该行续——**不消费**）；满页/超限出 page_token；单行吞窗整行跳过不计匹配——:8876-8997。

### 2.4 bin.inspect（类型/大小/哈希/首 256 字节）

magic 字节表（PNG/JPEG/GIF/PDF/ZIP/gzip/SQLite/ELF/PE/wasm/class/ogg/mp4…）→扩展名回退→octet-stream 兜底（probeSniffType :9003-9038）；head_b64+head_ascii 各 ≤256B（PROBE_BIN_HEAD_BYTES）；sha256 全文件 ≤32MB（PROBE_HASH_FULL_MAX），超出 hash_scope=first_N_bytes（防探针变多 GB 读）——:9040-9082。

## 3. 统一信封与 page_token

**每个 ok 响应=一份摘要 JSON 信封，从不裸 dump**（probeEnvelope :8524-8540）：

| 字段 | 语义 |
|---|---|
| ok/tool/action/path | 定位面 |
| （动作 payload） | lines/matches/rows/type 等——已按帽裁剪后的内容 |
| rows_truncated | boolean（各动作的截断语义：db=满页或裁剪；head/grep=!eof；bin=文件>256B） |
| bytes / hash | **返回 payload** 的字节与 sha256（bin.inspect 例外：hash=文件哈希，per §15.4） |
| page_token | base64url(JSON {v:1, a:action, o, ln?, sz?})——绑定 action（跨 action 重放拒）+文件 size（续页时文件已变拒）；db.query 无 ln/sz 腿 |
| caps | max_rows/max_bytes 等自描述帽面 |

token 校验（probeDecodeToken :8445-8473）：形状失败=ToolError 永不崩 server；与 action 不匹配、偏移/行号/尺寸越界全拒。

## 4. 失效语义

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

## 5. 断言锚

- **probe-caps**（在册套件，v1.2 不变名单 §4.2）：PROBE 系（caps 语义/二进制拒/eof 分页）+ CACHE-01..06 专组（缓存折存根/no_cache/page_token 不读写缓存——缓存机制断言面，细节见 cache-policy.md §5）。
- **LM-05**（lint-manifest，M1-3 注册）：本卡常量/函数名（probeValidateSql/probeDecodeToken/probeEnvelope/probeLooksBinary/PROBE_MAX_ROWS 等）server.mjs grep 可见+卡存在非空。
- **SKILL §15.4**：cap 语义的文档权威源——本卡与彼节若漂移，以源码实码为仲裁再同步两文档。

## 6. 维护规则

- 新增动作：probeDispatchAction 分发表+信封兼容（rows_truncated/bytes/hash/page_token 五字段强制）+page_token 绑定形状+probe-caps 断言组，五件齐落；缓存准入门决策（可缓存与否）同步 `cache-policy.md` §2。
- caps 数值调整：PROBE 系常量（:179-198）与本卡 §2 同波改；SKILL §15.4 若引数值同波核。
- SQL 门只放白名单：**新增关键字=显式裁决面**（黑名单思维回潮即防线洞开）；`*` 豁免面只认 COUNT/聚合括号形态。
