# 三视图契约：lessons 库的派生视图（digest / ORCH.md ver-sync / AGENTS.md orch-mem 标记区）

- **归属模块**：mcp/server.mjs（digest 读校验组包面 + ORCH.md ver-sync 附带面 + 三视图闸/信号面）+ agents/orch-gleaner.md（归敛代理=三视图的唯一写者，GL 系规则）+ server 物化 glean-pack（digest 职责烘焙规则）；三视图同属 lessons 库（memory/lessons.jsonl）的**派生视图**，同步机制与失效语义是同一契约面的三个投影——分开写会重演「digest 有 STALE 检测而 ver-sync 无对应物」的口径漂移（DP2a R-4），故三视图合一卡
- **脆度评级**（面广度×后果重度双轴）：**中**——三视图均为只读投影（lessons 事件行才是源），坏视图不坏源；但三视图失效语义不对称（digest 有五级判定、ver-sync 有双因子基线、**orch-mem 标记区零检测**——本卡 §4.3 即补齐声明），消费方按「哪层坏了怎么降级」读本卡
- **历史事故回链**：DP2a R-3（STALE 非缺陷是 fail-safe：缺的是恢复路径/分级/指纹粒度）、V7-01/CACHE-06（双因子教训）、v1.1 W6 QA P2-a（GL-32 帽判 body 非 all 行）、O2=N5 终裁（STALE 分级渲染，M8-1 落地——本卡 §5 预留消费面）
- **锚点声明**：本卡行号系总装时点（v1.2 源码）实测，**不作跨版引用**（l-20261022-6a14d6）；函数名/常量名双锚为定位权威

---

## 0. 共同面（三视图共享的契约）

| 面 | 内容 |
|---|---|
| 源 | `<memoryRoot>/memory/lessons.jsonl`（事件行 append-only 源）+ 全端/项目两级派生库——**lessons 事件行永不直写**，一切增删经 lessons 工具（归敛 GL 视图层边界） |
| 写者 | 唯一写者=归敛轮（orch-gleaner，server 物化固定包 glean3 + brief.digest 权威指针）；server 对三视图**只读**（ver-sync 附带面是读后呈现非写） |
| 权威指针 | 路径一律取 brief 字段（brief.digest.path/sidecar_path）——「权威指针勿手写」（template incident ① root cure） |
| 归敛闸 | glean_due 信号（gate：idle_hours/new_events 实测；glean.cfg.json 可调，junk 回落）——随 board list 与 orch_memory 附带面透出，主控决定是否拉起归敛（server 不能 spawn） |
| M7-1 尾补记落点 | M6 选项 B 考古（lessons.jsonl 更新形态：append-only or 整文件重写）结论由 M7-1 入本卡尾补记（本卡 §6 预留）——该结论决定指纹粒度修正（选项 B）有无实证价值 |

## 1. 视图一：digest（md + json sidecar）

| 面 | 内容 | 锚点 |
|---|---|---|
| 物理形态 | `<memoryRoot>/digest/pack-tail-digest.md`：首行 `generated_at: <ISO8601>` + 正文 ≤12 行/≤1200B（DIGEST_MAX_LINES/BYTES）；sidecar `pack-tail-digest.json`：`{generated_at, sources:{lessons_lines, lessons_mtime_ms, agents_md_mtime_ms, journal_tail_seq}, bytes}` | :9988-9989；:9991-9999；GL-32 |
| 写方 | 归敛轮整文件覆盖写（两件原子覆盖，历史 digest 不另存）；正文=态势面（项目现状一句话+在飞 mission 摘要）+时间面（近期裁决/关键事件 3-5 条）；禁任务相关检索内容 | glean-pack RULES（server 烘焙，:10441）；GL-32/33 |
| 读方① | context_pack 组包：readProjectDigest→buildDigestSection——**仅当两 legacy 段至少一段会渲染时才替换**（默认包字节不变）；正文按 G4 帽钳制渲染 | :10083-10098 |
| 读方② | dispatch 组包：dispatchDigestRead——digest 是可选节，读失败永不阻塞 dispatch | :6580-6586 |
| 读方③ | glean_due 信号消费面（同判定链） | :9984-9985 注释 |

**五级判定链**（readProjectDigest :10019-10081，fail-safe 契约=DESIGN §3.2/3.3）：判 body 而非 all 行（QA P2-a）——

1. 文件缺失 → `missing`（读方回退两 legacy 段，不造 STALE 噪音）；
2. 首行缺 `generated_at` → stale；
3. 正文超帽（>12 行/1200B）→ stale；
4. 正文空 → stale；
5. sidecar 缺失/不可解析 → stale；指纹比对**有序短路**：`lessons_lines` 不匹配 → `lessons_mtime_ms` → `agents_md_mtime_ms`（条件参与：sidecar 记了才比）。

**stale≠阻塞**：stale 正文仍渲染，注入头显式带 `STALE：<stale_reason>`（如 `lessons_lines 58 ≠ 79`）——组装永不因视图旧而失败；missing 才回退 legacy。**STALE 出现后零自动恢复**：唯一刷新路径=下一轮归敛；两次归敛间 lessons 的任何 append（promote 直晋/glean 消费/lessons add）都使 digest 永久 STALE——分级渲染（何时值得信/何时该归敛）归 M8-1（O2=N5 绝对数终裁），见 §5。

## 2. 视图二：ORCH.md ver-sync piggyback

| 面 | 内容 | 锚点 |
|---|---|---|
| 物理形态 | `<root>/ORCH.md`（ORCH_MD_FILE）；头 `<!-- orch-memory ver=<N> updated=<ISO8601> -->`（ver 缺失按 0 读） | :748；parseOrchMdHeader :10117-10123 |
| 同步机制 | **piggyback**：每次**成功** tools/call 结果顶层附可选 `orch_memory.orch_md` 键（与 glean_due 同壳）；error 结果与 tools/list 永不附 | :10100-10108；接线 :10557-10566；orchMemoryAttachment :10511-10523 |
| 基线 | 进程内存 baseline（session-scoped——stdio server 一进程一会话惯例；进程复用至多晚一拍收敛）；比对=bytes+mtimeMs 双因子（同毫秒写教训） | :10113-10115；:10142-10150 |
| 决策表 | 未变→零附带（一次 stat 成本）；文件缺席：首见=静默建 absent 基线，曾发过=附 `{reason:"removed"}` 恰一次；stat/read 竞态=保持旧视图下次重评 | :10146-10167 |
| 附带内容 | `{reason: initial\|changed\|removed, ver, updated_at, bytes, truncated?, content}`；reason=initial（会话首次）或 changed | :10169-10190 |
| 帽 | 120 行/10KB（ORCH_MD_MAX_LINES/BYTES）先到先裁；超帽 truncated:true+尾行提示「建议拉起归敛」——**server 只限爆半径，收缩权归归敛**（不自动删内容） | :10111-10112；:10177-10188 |

**失效语义**：视图旧（进程内基线已发、文件后变）→ 下一次成功 tool call 补发（至多晚一拍，自愈）；文件消失→removed 恰一次告知（不重复刷屏）；头 ver 缺失→ver:0 照常附带（内容面无损）；stat 与 read 之间的消失竞态→保持旧视图（保守，下一拍重评）。

## 3. 视图三：AGENTS.md orch-mem 标记区

| 面 | 内容 | 锚点 |
|---|---|---|
| 物理形态 | 项目 AGENTS.md 内 `<!-- orch-mem:begin v1 … -->` / `<!-- orch-mem:end -->` 标记对之间的区段（区内内容=归敛浓缩的项目记忆视图） | GL-20；本仓库 AGENTS.md 在例 |
| 写方 | 归敛代理（GL-20）：只在标记对内增删改，**标记对外字节零触碰**，编辑后复读校验对外 diff 为零 | GL-20 |
| 功能开关语义 | **标记对缺失=该项目记忆功能关闭**：归敛跳过、报告记录、不重建、不补写、不提示重建（GL-21）——删除标记对即关闸，无灰度 | GL-21 |
| 读方 | **无 server 消费面**——AGENTS.md 由宿主（ZCode）按 workspace 注入机制进 agent 上下文，不经 server 工具面读取；三视图中唯一「读方在系统外」者 | 本卡 §4.3 声明 |
| 溯源 | 区内内容逐条可溯源（归敛报告 `<ts>-glean.md` 带 lessons id；报告=交付物） | GL-11/GL-22 |

## 4. 失效语义总表（含 R-4 补齐声明）

**R-4 缺口补齐（本卡核心增量）**：三视图中 digest 有五级判定、ORCH.md 有双因子基线，**orch-mem 标记区是唯一无失效语义者**——以下即其失效语义声明（消费方与维护方共同遵循）：

| 情形 | digest（§1） | ORCH.md ver-sync（§2） | **AGENTS.md orch-mem 标记区（§3）** |
|---|---|---|---|
| 内容陈旧（源已动视图未更） | 五级判定链→STALE 标签仍渲染（永不阻塞）；恢复=下轮归敛；分级归 M8-1 | 双因子基线→下一成功 call 补发 changed | **零自动检测——无 freshness 面**。消费方纪律：标记区内容按「归敛时点快照」采信，**不承诺新鲜**；态势判断须与 digest（有 STALE 判定）交叉核对；「该归敛了」的信号以 glean_due/digest STALE 为准，标记区沉默不等于库静止 |
| 视图文件缺失 | missing→回退两 legacy 段 | absent/removed 语义（首次静默/曾发则 removed 恰一次） | 标记对缺失=**功能关闭语义**（非缺失故障）：归敛跳过不重建（GL-21）；宿主注入面自然无该区内容 |
| 视图损坏/半写 | 判定链逐级降级（超帽钳制渲染） | truncated 裁剪+提示 | **无校验、无隔离、无自愈**——手动编辑标记区（区外字节零触碰承诺只约束归敛）产生的漂移由下一轮归敛覆盖式重写收编；区外字节被误动=归敛复读校验（GL-20）当轮发现并如实报告 |
| 多写方竞态 | 单写者（归敛）+原子覆盖 | 单写者+只读附带 | 单写者（归敛）+标记对边界+复读校验；**用户手工编辑标记区内容与归敛互不知情**——语义=用户输入，下轮归敛可整合可覆盖（溯源链报告里记录出处） |
| 超帽 | 正文钳制（G4） | server 截断（限爆半径） | **无 server 帽**——区段大小由归敛自律（报告计数）+宿主注入面承受；无机械强制（与 digest/ver-sync 的不对称点，扩面时先补本行） |

## 5. 消费面与下游（M8-1 预留接线）

- **STALE 分级渲染**（v1.2 M8-1，O2=N5 绝对数终裁）：stale_reason 结构化 {field, want, now, drift}，注入头按 drift 分级文案（轻微=态势面大概率仍有效/显著=建议触发归敛）——本卡 §1 判定链输出的 stale_reason 即其输入契约；M8-1 落地后本节同步实码措辞。
- **指纹粒度修正**（DP2a 选项 B）：前置考古=lessons.jsonl 更新形态（append-only 则 mtime 与行数恒同步、粒度修正无意义）——**考古已落，结论见 §6：选项 B 销项不立项**。
- **恢复路径自动化**（选项 C）：禁止单独上线（正文旧+指纹新=伪装新鲜）；与分级渲染捆绑后归 W 波裁决。

## 6. 尾补记（M7-1 考古结论——已落，2026-10-28）

**题目**（M6 选项 B 前置考古）：lessons.jsonl 更新是 append-only 还是整文件重写？对指纹语义修正（选项 B）的影响裁定。

**结论一：lessons.jsonl 更新形态=整文件读-合并-原子重写（read-merge-rewrite），非 IO append-only。**

代码证据（server.mjs，2026-10-28 实测行号，不作跨版引用）：

1. **唯一写出口=saveLessons（~L2415）**：接收全量列表→逐条 JSON 序列化 join→`atomicWriteFileSync` 整文件原子覆盖写。没有第二条写路径。
2. **全文件零 `appendFileSync`**：server.mjs grep 计数=0—— lessons 库不存在任何追加式写入。
3. **写路径全部走「load→mutate→saveLessons」**：add/stage 的 list.push（~L2978/3036）、report(done, lessons) 候选补员（~L4696）、promote 的 findMergeTarget 原地合并（hits/updated_at/置信度改写）、retire/衰汰与 housekeepLessons 的原地翻状态——都是数组变更后整文件重写。
4. **锁纪律**：v0.3.1 A4 起全部 lessons 写在根锁内（源注 ~L2848 原话「lessons.jsonl is read-merged-written; the whole tool runs under [root lock]」）。
5. **口径澄清**：DESIGN 旧增量章的「只增不重排、原子重写」是**列表语义**（条目只追加到队尾、不重排、物理不删除——退役/衰汰只翻 status 行内字段），**不是 IO append 语义**；物理形态每次都是整文件重写。

**结论二：双因子指纹（lessons_lines＋lessons_mtime_ms）在本写形态下有真实区分度，选项 B（指纹粒度修正）无实证价值——销项，不立项。**

推理链：

- 若 append-only 成立（考古前的备择假设），mtime 与行数恒同步，双因子冗余，粒度修正才有讨论空间——**该假设被结论一否定**。
- 实际形态下两类变更可分离：**结构性增减**（add/stage/候选补员）→ 行数变且 mtime 变；**原地变更**（promote 合并、retire 翻状态、置信度与 updated_at 改写）→ **行数不变而 mtime 必变**（整文件重写必触 mtime）。不存在「内容已变而行数与 mtime 双稳」的第三类变更——任何内容变更都经过整文件重写。
- 因此现指纹已无盲区；更细粒度（内容 hash/逐行 seq）的成本（每次读校验全文件算 hash）对收益（STALE 已被五级判定链+分级渲染承接）不成比例。
- 与判定链自洽性旁证：§1 五级指纹比对的有序短路（`lessons_lines` 先行→`lessons_mtime_ms` 条件参与）恰好按「结构性变化先判、原地变化后判」排序，与本写形态匹配，无需调整。
- 「区分结构/原地变更」的原始诉求由 STALE 分级渲染承接（M8-1，O2=N5 绝对数终裁，按 drift 分级文案）——呈现层方案，不动指纹层。

**裁定记录**：选项 B 状态由「待考古」改为「销项（考古否定其前提）」；本节即 DP2a §4.2 B 线的唯一权威结论载体。后续若写形态演进（如真引入 append 日志或分片），须先改 saveLessons 写出口并回写本节重开考古，禁止跳过本节直接改指纹。

## 7. 断言锚

- **crv8-memory**：digest 判定链/帽/钳制、ver-sync 决策表、归敛闸——M8-1 落 STL 组（分级文案+digest 注入头样例断言，A-v0120-STL）扩展本卡 §5 消费面。
- **po-static/crv 系**：GLOBAL MEMORY 段帽面（50 行/2KB，escapeDataBlock 行结构保持）——组包侧控制字符防线。
- **LM-05**（lint-manifest，M1-3 注册）：本卡常量/函数名（readProjectDigest/digestSourcesNow/parseOrchMdHeader/orchMdAttachment/DIGEST_MAX_LINES/ORCH_MD_MAX_LINES 等）server.mjs grep 可见+卡存在非空。

## 8. 维护规则

- 三视图任一投影的判定链/帽/键演进：本卡对应节+crv8/po-static 断言+归敛 GL 规则（orch-gleaner.md）三处同波改——GL 系与 server 烘焙 RULES 是同一契约的双源执行面（与 M6-2 第 11 条双源同纪律）。
- 新增第四视图：须先答三问（写方是谁/失效语义三分类落在哪/是否进 glean-pack 烘焙 RULES）再入本卡——R-4 教训：缺失效语义的视图不得上线。
- 标记区格式（`orch-mem:begin v1` 版本号）演进：v 递增+GL-20/21 同步+宿主注入面兼容窗声明；标记对外零触碰承诺不随版本变。
