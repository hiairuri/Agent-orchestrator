# 三视图契约：lessons 库的派生视图（digest / ORCH.md ver 头与帽消费〔v1.6 起 pull-only〕/ AGENTS.md orch-mem 标记区）

- **归属模块**：mcp/server-memory.mjs（digest 读校验组包面 + ORCH.md ver 头解析/帽 cfg 消费面〔v1.6 W2 起 ver-sync piggyback 附带面拆除〕+ 三视图闸/信号面）+ agents/orch-gleaner.md（归敛代理=三视图的唯一写者，GL 系规则）+ server 物化 glean-pack（digest 职责烘焙规则）；三视图同属 lessons 库（memory/lessons.jsonl）的**派生视图**，同步机制与失效语义是同一契约面的三个投影（DP2a R-4 教训），故三视图合一卡
- **脆度评级**（面广度×后果重度双轴）：**中**——三视图均为只读投影（lessons 事件行才是源），坏视图不坏源；但三视图失效语义不对称（digest 有五级判定、ORCH.md pull-only 无 freshness 面〔v1.6 W2 拆除〕、**orch-mem 标记区零检测**——本卡 §4.3 即补齐声明）
- **历史事故回链**：DP2a R-3（STALE=fail-safe，缺恢复路径/分级/指纹粒度）、V7-01/CACHE-06（双因子教训）、v1.1 W6 QA P2-a（GL-32 帽判 body 非 all 行）、O2=N5 终裁（分级渲染，M8-1 落地）
- **锚点声明**：本卡行号系总装时点（v1.2 源码）实测，**不作跨版引用**（l-20261022-6a14d6）；函数名/常量名双锚为定位权威

---

## 0. 共同面（三视图共享的契约）

| 面 | 内容 |
|---|---|
| 源 | `<memoryRoot>/memory/lessons.jsonl`（事件行 append-only 源）+ 全端/项目两级派生库——**lessons 事件行永不直写**，一切增删经 lessons 工具（归敛 GL 视图层边界） |
| 写者 | 唯一写者=归敛轮（orch-gleaner，server 物化固定包 glean3 + brief.digest 权威指针）；server 对三视图**只读**（ORCH.md 纯读面——v1.6 W2 起 ver-sync 附带呈现已拆除） |
| 权威指针 | 路径一律取 brief 字段（brief.digest.path/sidecar_path）——「权威指针勿手写」（template incident ① root cure） |
| brief views 块 | **brief 五字段只读视图快照**（v1.3 W3 D 信号腿）：`{orch_md_exists, orch_md_ver, global_agents_md_exists, global_lib_lines, agents_md_marker_exists}`，随 glean-brief.json 每轮 gate-due 重物化（失效语义=物化即最新快照，无独立失效面；全只读零写）；`agents_md_marker_exists` 钉死=**项目根** AGENTS.md orch-mem 标记对存在性（L-8——标记对只在项目根存在，全端 AGENTS.md 整文件归 gleaner 管无标记对）；`global_lib_lines`=全端库 memory/lessons.jsonl 非空行数；动作腿同波双载体同句=GL-20 与 glean-pack 烘焙 RULES（全端 AGENTS.md 或全端库 memory/ 目录缺席=先创建，有 content 首建才落笔不落空壳），server 兜底 mkdir 只建 `<memoryRoot>/memory/` 目录不建空壳文件（空壳 mtime 入 digest 指纹=假信号） |
| 归敛闸 | glean_due 信号（gate：idle_hours/new_events/busy_channel_events 三键实测〔v1.3 常忙腿：时间门不过 ∧ 新增 ≥busy_channel_events 兜底触发，0=关断〕；glean.cfg.json 可调，junk 回落）——随 board list 透出，主控决定是否拉起归敛（server 不能 spawn） |
| M7-1 尾补记落点 | M6 选项 B 考古（lessons.jsonl 更新形态）结论已由 M7-1 落本卡 §6——选项 B 销项 |

## 1. 视图一：digest（md + json sidecar）

| 面 | 内容 | 锚点 |
|---|---|---|
| 物理形态 | `<memoryRoot>/digest/pack-tail-digest.md`：首行 `generated_at: <ISO8601>` + 正文 ≤12 行/≤1200B（DIGEST_MAX_LINES/BYTES）；sidecar `pack-tail-digest.json`：`{generated_at, sources:{lessons_lines, lessons_mtime_ms, agents_md_mtime_ms, journal_tail_seq}, bytes}` | mcp/server-memory.mjs digest 物化面；GL-32 |
| 写方 | 归敛轮整文件覆盖写（两件原子覆盖，历史 digest 不另存）；正文=态势面（项目现状一句话+在飞 mission 摘要）+时间面（近期裁决/关键事件 3-5 条）；禁任务相关检索内容 | glean-pack RULES（server 烘焙）；GL-32/33 |
| 读方① | context_pack 组包：readProjectDigest→buildDigestSection——**仅当两 legacy 段至少一段会渲染时才替换**（默认包字节不变）；正文按 G4 帽钳制渲染 | mcp/server-memory.mjs `readProjectDigest`→`buildDigestSection` |
| 读方② | dispatch 组包：dispatchDigestRead——digest 是可选节，读失败永不阻塞 dispatch | `dispatchDigestRead`（mcp/tool-dispatch.mjs） |
| 读方③ | glean_due 信号消费面（同判定链） | mcp/server-memory.mjs glean_due 消费注释 |

**五级判定链**（`readProjectDigest`（mcp/server-memory.mjs），fail-safe 契约=DESIGN §3.2/3.3）：判 body 而非 all 行（QA P2-a）——

1. 文件缺失 → `missing`（读方回退两 legacy 段，不造 STALE 噪音）；
2. 首行缺 `generated_at` → stale；
3. 正文超帽（>12 行/1200B）→ stale；
4. 正文空 → stale；
5. sidecar 缺失/不可解析 → stale；指纹比对**有序短路**：`lessons_lines` 不匹配 → `lessons_mtime_ms` → `agents_md_mtime_ms`（条件参与：sidecar 记了才比）。

**stale≠阻塞**：stale 正文仍渲染，注入头显式带 `STALE：<stale_reason>`（如 `lessons_lines 58 ≠ 79`）——组装永不因视图旧而失败；missing 才回退 legacy。**STALE 出现后零自动恢复**：唯一刷新路径=下一轮归敛；两次归敛间 lessons 的任何 append（promote 直晋/glean 消费/lessons add）都使 digest 永久 STALE——分级渲染（何时值得信/何时该归敛）归 M8-1（O2=N5 绝对数终裁），见 §5。

## 2. 视图二：ORCH.md（主控记忆——v1.6 W2 拆除后 pull-only）

> **v1.6 W2 拆除注记（指令①，design §2.5；2026-11-04）**：v1.3 起 piggyback 三 surfacing（顶层 `orch_memory.orch_md` 附件键+result JSON 顶层 `orch_md` 键的三态推送/bytes+mtimeMs 双因子基线/决策表/超帽截断附带面）已**整体退役**：`orchMdAttachment` 函数与进程内 baseline 删除（orch_md 恒缺席）；防回潮=A-V0160-N9 负向钉（crv8-memory 场景 6：任何工具成功响应不含顶层 orch_memory 键∧content 不含 orch_md 键）。本节现载契约面=ver 头解析＋帽 cfg 消费（design §2.5 显式保留清单）。

| 面 | 内容 | 锚点 |
|---|---|---|
| 物理形态 | `<root>/ORCH.md`（ORCH_MD_FILE）；头 `<!-- orch-memory ver=<N> updated=<ISO8601> -->`（ver 缺失按 0 读） | ORCH_MD_FILE；`parseOrchMdHeader`（mcp/server-memory.mjs） |
| 同步机制 | **无推送（pull-only，v1.6 W2 起）**：server 不向任何工具成功响应附 ORCH.md 内容/状态；主控消费=会话启动 /manual 双件阻塞并读（commands/manual.md 第 2 步：SKILL 全文+ORCH.md 全文帽内）＋会话中按需 `probe file.head ORCH.md` 对账（SKILL OV-9/MM-19）；error 结果与 tools/list 本就永不附 | 拆除说明（mcp/server-memory.mjs orchMdRead 后注记块）；N9（tests/suites/crv8-memory/sync.mjs 场景 6）；manual.md 第 2 步（po-static C1-06 双件钉） |
| ver 头消费 | ver/updated_at 解析仅入 glean-brief 快照（brief.orch_md.ver/views.orch_md_ver）——归敛轮重写 ORCH.md ver+1（GL-20），消费方以 brief 字段为权威快照 | materializeGleanBrief（mcp/server-memory.mjs）；GL-20 |
| 帽 | cfg 化 opt-in（v1.3 W4）：`<全端目录>/glean.cfg.json` 键 `orch_md_max_lines`〔默认 120〕/`orch_md_max_bytes`〔默认 10240〕逐键 junk 回落，缺省=ORCH_MD_MAX_LINES/BYTES 常量（标识符保留，lint-manifest 钉）——**v1.6 拆除后消费面=归敛写帽**：固定包 RULES 帽值句随 cfg 动态渲染（SYNC-20/21 零触保留）＋GL-20 取 brief.cfg 作 ORCH.md 重写帽（不同步则上调被静默打回）；server 侧截断附带面已随拆除退役（不再有 truncated:true 推送） | mcp/server-memory.mjs 帽面（readGleanCfg 帽两键 junk 回落/materializeGleanPack RULES 句）；orchMemoryAttachment 单次 cfg 读（L-9，禁进程级缓存） |

**失效语义（pull-only）**：消费方读到的是读取时点实态——无基线、无补发、无 removed 通知；陈旧风险由消费纪律承接（OV-9 probe 对账＋brief.views.orch_md_* 快照随 gate-due 刷新）。与 probe 的接缝（互指不合并）：probe（`card-probe.md`）只保证「读到的是文件实态字节」（帽/缓存/信封归彼卡与 `cache-policy.md`）；视图语义（freshness/STALE/快照权威）以本卡为准。

## 3. 视图三：AGENTS.md orch-mem 标记区

| 面 | 内容 | 锚点 |
|---|---|---|
| 物理形态 | 项目 AGENTS.md 内 `<!-- orch-mem:begin v1 … -->` / `<!-- orch-mem:end -->` 标记对之间的区段（区内内容=归敛浓缩的项目记忆视图） | GL-20；本仓库 AGENTS.md 在例 |
| 写方 | 归敛代理（GL-20）：只在标记对内增删改，**标记对外字节零触碰**，编辑后复读校验对外 diff 为零 | GL-20 |
| 功能开关语义 | **标记对缺失=该项目记忆功能关闭**：归敛跳过、报告记录、不重建、不补写、不提示重建（GL-21）——删除标记对即关闸，无灰度 | GL-21 |
| 读方 | **无 server 消费面**——AGENTS.md 由宿主（ZCode）按 workspace 注入机制进 agent 上下文，不经 server 工具面读取；三视图中唯一「读方在系统外」者 | 本卡 §4.3 声明 |
| 溯源 | 区内内容逐条可溯源（归敛报告 `<ts>-glean.md` 带 lessons id；报告=交付物） | GL-11/GL-22 |

## 4. 失效语义总表（含 R-4 补齐声明）

**R-4 缺口补齐（本卡核心增量）**：三视图中 digest 有五级判定（ORCH.md ver-sync 的双因子基线随 v1.6 W2 拆除退役，ORCH.md 现为 pull-only 无 freshness 面）、**orch-mem 标记区是唯一无失效语义者**——以下即其失效语义声明（消费方与维护方共同遵循）：

| 情形 | digest（§1） | ORCH.md（§2，v1.6 起 pull-only） | **AGENTS.md orch-mem 标记区（§3）** |
|---|---|---|---|
| 内容陈旧（源已动视图未更） | 五级判定链→STALE 标签仍渲染（永不阻塞）；恢复=下轮归敛；分级归 M8-1 | 无推送无 freshness 面——消费纪律同 §2（OV-9 probe 对账＋brief 快照随 gate-due 刷新） | **零自动检测——无 freshness 面**。消费方纪律：标记区内容按「归敛时点快照」采信，**不承诺新鲜**；态势判断须与 digest（有 STALE 判定）交叉核对；「该归敛了」的信号以 glean_due/digest STALE 为准，标记区沉默不等于库静止 |
| 视图文件缺失 | missing→回退两 legacy 段 | 无通知面——读取/probe 自然落空（file not found 即实态）；主控按「空记忆」消费（manual 第 2 步缺席句） | 标记对缺失=**功能关闭语义**（非缺失故障）：归敛跳过不重建（GL-21）；宿主注入面自然无该区内容 |
| 视图损坏/半写 | 判定链逐级降级（超帽钳制渲染） | server 不再截断附带（v1.6 拆除）——帽裁归归敛重写面（GL-20 写帽） | **无校验、无隔离、无自愈**——手动编辑标记区（区外字节零触碰承诺只约束归敛）产生的漂移由下一轮归敛覆盖式重写收编；区外字节被误动=归敛复读校验（GL-20）当轮发现并如实报告 |
| 多写方竞态 | 单写者（归敛）+原子覆盖 | 单写者（归敛）；server 纯读（附带面已拆） | 单写者（归敛）+标记对边界+复读校验；**用户手工编辑标记区内容与归敛互不知情**——语义=用户输入，下轮归敛可整合可覆盖（溯源链报告里记录出处） |
| 超帽 | 正文钳制（G4） | **无 server 截断（v1.6 拆除）**——帽=归敛重写面消费（GL-20 取 brief.cfg；固定包 RULES 帽值句随 cfg 渲染）；主控侧爆半径由 /manual「帽内全量」读取语义承接 | **无 server 帽**——区段大小由归敛自律（报告计数）+宿主注入面承受；无机械强制（与 digest 的不对称点，扩面时先补本行） |

## 5. 消费面与下游（M8-1 预留接线）

- **STALE 分级渲染**（v1.2 M8-1，O2=N5 绝对数终裁）：stale_reason 结构化 {field, want, now, drift}，注入头按 drift 分级文案（轻微=态势面大概率仍有效/显著=建议触发归敛）——本卡 §1 判定链输出的 stale_reason 即其输入契约；M8-1 落地后本节同步实码措辞。
- **指纹粒度修正**（DP2a 选项 B）：考古已落，结论见 §6——**选项 B 销项不立项**。
- **恢复路径自动化**（选项 C）：禁止单独上线（正文旧+指纹新=伪装新鲜）；与分级渲染捆绑后归 W 波裁决。

## 6. 尾补记（M7-1 考古结论——已落，2026-10-28）

**题目**（M6 选项 B 前置考古）：lessons.jsonl 更新是 append-only 还是整文件重写？对指纹语义修正（选项 B）的影响裁定。

**结论一：lessons.jsonl 更新形态=整文件读-合并-原子重写（read-merge-rewrite），非 IO append-only。** 代码证据（2026-10-28 实测）：唯一写出口=`saveLessons`（mcp/server-lessons.mjs，全量列表 JSON 序列化 join→`atomicWriteFileSync` 整文件覆盖），无第二条写路径；全文件零 `appendFileSync`（grep=0，lessons 库不存在追加式写入）；写路径全部走 load→mutate→saveLessons（add/stage 的 list.push、report(done, lessons) 候选补员、promote `findMergeTarget` 原地合并、retire/衰汰与 `housekeepLessons` 原地翻状态）；v0.3.1 A4 起全部 lessons 写在根锁内。口径澄清：DESIGN 旧增量章「只增不重排、原子重写」是**列表语义**（条目只追加队尾、不重排、退役/衰汰只翻 status 行内字段），非 IO append 语义。

**结论二：双因子指纹（lessons_lines＋lessons_mtime_ms）在本写形态下无盲区，选项 B（指纹粒度修正）销项不立项。** 结构性增减（add/stage/候选补员）→行数变且 mtime 变；原地变更（promote 合并、retire 翻状态、置信度与 updated_at 改写）→行数不变而 mtime 必变（整文件重写必触 mtime）——不存在「内容已变而双稳」的第三类变更；更细粒度（内容 hash/逐行 seq）成本对收益不成比例（STALE 已由五级判定链+分级渲染承接）；§1 有序短路（lines 先行→mtime 条件参与）恰按「结构性先判、原地后判」排序，与写形态自洽。「区分结构/原地变更」诉求由 STALE 分级渲染承接（M8-1，O2=N5 终裁）——呈现层方案，不动指纹层。

**裁定记录**：选项 B 状态=「销项（考古否定其前提）」；本节即 DP2a §4.2 B 线的唯一权威结论载体。后续写形态演进（真引入 append 日志或分片）须先改 saveLessons 写出口并回写本节重开考古，禁止跳过本节直接改指纹。

## 7. 断言锚

- **crv8-memory**：digest 判定链/帽/钳制、ORCH 拆除面（A-V0160-N9 负向钉+SYNC-20/21 pack 帽值句零触保留）、归敛闸——M8-1 落 STL 组（分级文案+digest 注入头样例断言，A-v0120-STL）扩展本卡 §5 消费面。
- **po-static/crv 系**：GLOBAL MEMORY 段帽面（50 行/2KB，escapeDataBlock 行结构保持）——组包侧控制字符防线。
- **LM-05**（lint-manifest，M1-3 注册）：本卡常量/函数名（readProjectDigest/digestSourcesNow/parseOrchMdHeader/DIGEST_MAX_LINES/ORCH_MD_MAX_LINES 等）mcp/server-memory.mjs grep 可见+卡存在非空——orchMdAttachment 锚随 v1.6 W2 ORCH 拆除退役（8→7 ids，裁定 A 2026-11-04）。

## 8. 维护规则

- 三视图任一投影的判定链/帽/键演进：本卡对应节+crv8/po-static 断言+归敛 GL 规则（orch-gleaner.md）三处同波改——GL 系与 server 烘焙 RULES 是同一契约的双源执行面（与 M6-2 第 11 条双源同纪律）。
- 新增第四视图：须先答三问（写方是谁/失效语义三分类落在哪/是否进 glean-pack 烘焙 RULES）再入本卡——R-4 教训：缺失效语义的视图不得上线。
- 标记区格式（`orch-mem:begin v1` 版本号）演进：v 递增+GL-20/21 同步+宿主注入面兼容窗声明；标记对外零触碰承诺不随版本变。
