# 契约卡① sentinel/ 目录族（10 文件，A-D 四组）

> **行号声明（卡头）**：本文全部行号系 **2026-10-28 总装时点实测**（grep + 实码逐行核对，worker v12-m11，plugin v1.1.2：bg-sentinel.mjs 2517 行 / server.mjs 10657 行 / session-start.mjs 449 行 / bg-gate.mjs 526 行）。行号**不作跨版引用**；跨版定位以函数名/文件名锚为准（l-20261022-6a14d6）。
>
> - 归属模块：hooks/bg-sentinel.mjs（直至型哨兵，单文件 2517 行）＋消费端 hooks/{session-start,bg-gate,wake-kick}、watcher/、mcp/server.mjs
> - 脆度双轴评级：**面广度=第一梯队**（10 文件 × 6 进程读写 × 跨进程时钟判死）；**后果重度=第一梯队（并列卡③）**（失效面横跨唤醒链/告警链/盯守链，但单文件失效多可自愈或降级，无 root.txt 型"全体失明"全局后果）
> - 历史事故回链：锚劫持 2026-10-25 sess_7ac10f4b（-p 探针抢锚，W-A0 修复）；EXP10-findings R4（coord-workspace 缺失→watcher 盲取 workspaces[0]→b2 自愈劫持，G5 修复）；EXP10-findings R6（sess_subagent 前缀劫持，G14 修复）；V7-04（板不可读误报三连枪，观测型隔离）；l-20261019-d38f65（外部写者踩坑族）
> - 断言锚总表：见文末 §5（含断言裸区实测标注）；本文 schema 为 impl-plan §9.3 债务的逐字段补全

**失效语义三分类记法**：`fail-loud`（显式报错/告警，行为可见）／`自愈`（自动恢复到正确态）／`静默降级`（按安全缺省继续，不留痕或留痕有限）。

---

## 0. 目录面与卡外邻接件

`<存储根>/sentinel/` 目录由 bg-sentinel 启动时 `mkdirSync(recursive)` 创建（bg-sentinel.mjs L2277）；server 恒不创建该目录（G5 filler 仅在目录**已存在**时补写 coord-workspace.txt，L714-723——保 sentinel_health `available` 信号语义=l0 V13）。

本卡 10 文件族（DP2a R-5 计数实测维持）：`instance-<k>.json`、`family-teardown.json`、`sentinel.cfg.json`（注：在存储根**本级**，不在 sentinel/ 内，随 A 组收录）、`fired/<name>.json`、`quarantine.json`、`echo.jsonl`、`coord-session.txt`、`coord-workspace.txt`、`watcher-signals.jsonl`、`glean-launch-state.json`。

**卡外邻接件**（实测同目录在册、不属本卡协议面，仅注记防误认）：
- `wake-kick-alerts/`＋`wake-kick-last-spawn`——hooks/wake-kick.mjs 告警去重戳（L237 wx 标记）
- `watcher-heartbeat`——watcher/watcher.mjs 60s 心跳自证（L166，bg-sentinel 反向监控消费面）
- `sentinel.lock`（存储根本级，legacy ≤0.3.1）——bg-gate L235 升级窗口内仍认（freshHeartbeat）
- `.mimosa`——外部工具残留，非本插件写面

---

## A 组·哨兵存活面（槽位/轮换/配置）

### A1 `instance-<k>.json`（k=0..family_size-1）

| 栏 | 内容 |
|---|---|
| **写方** | bg-sentinel 独占（单写方，wx/覆盖写双形态）：启动认领 wx 原子创建（claimSlot L626-661，`{flag:"wx"}` EEXIST=竞争败者让位）；接管改写（pid 死或心跳龄 >90s，L645 覆盖写＋记录 prev）；心跳续写 touchSlot（L663-683，**touch 前重读校验 pid 归属** V6-55，被接管实例苏醒后让位成无槽幽灵）；退出/轮换释放 unlink（releaseSlot L685-691）。**k=实例序数（0..family_size-1），非会话 id**——见下方 scoping 缺口标注 |
| **读方** | ①bg-sentinel 自身：pruneStaleSlots（L597-623，启动清理"心跳过期 ∧ pid 死"槽位）、claimSlot、touchSlot 让位校验；②bg-gate sentinelAlive（L219-240，任一 fresh instance-<k>.json → 哨兵在岗，bg-gate 误报防护主信号）；③server sentinelHealth（L3507-3531，逐槽渲染 {slot,pid_alive,state,hb_age_sec,took_over,root,on_duty}） |
| **字段** | slotDoc 全字段（L573-584，§9.3 补全）：`pid:int`（必选，判活主键）／`slot:int`（必选，=k）／`state:"active"\|"standby"\|"quarantined"`（必选三态；**旧版文件无此字段=active 归一**，server L3516 与 bg-sentinel L577 同规）／`root:string\|null`（必选，V6-56 槽位自证解析根）／`started_at:ISO8601`（必选）／`heartbeatAt:ISO8601`（必选，判死主键）／`took_over?:true`（可选，接管痕迹）／`prev?:slotDoc\|null`（可选，被接管者快照）。文件尾 `\n`。无 schema 校验=裸 JSON |
| **失效语义** | 心跳龄 >90s（HEARTBEAT_STALE_MS=90000，bg-sentinel L105／bg-gate L37／server L3474 **三处 twin 定义=死锁风险点，P5 twin-lock 锁定**）判死；`自愈`：死槽由下一代启动 prune+认领接管（prev 留痕）；坏文件/缺文件=该槽位视为空闲走 wx 认领（`静默降级`）；wx 竞态=认领失败让位下一槽位（`静默降级`，恰一成功）；全满全 fresh → 让位退出 exit 0＋一行 stdout（V7-08/R2 `fail-loud`）；幽灵实例（被接管后仍活）只损失观测在岗性，仲裁面防双开枪（`静默降级`） |

**⚠ scoping 缺口标注（M9-1 已修订落地，2026-10-28，v1.2 W9 阶段 a）**：槽位族以 **k=实例序数** 为键（0..family_size-1），作用于**整个存储根**——家族任一实例盯守该根下全部 mission；归属 scoping 已由 M9-1 在**开枪判定面**（classify）落地，槽位键本身保持实例序数不变（k 与会话 id 仍无关联，见下方机制）。现行归属 scoping 语义：
- **归属判定**：mission 归因 = `dispatch.session_id` ∥ `dispatch.spawned_by_session`（W3 M3-1 前向归因字段，dispatch/ONE_LEVEL 子键）；本哨兵所守会话 = coord-session 锚（`coordSessionId`，sess_subagent 前缀锚按既有消费端闸忽略）。开枪前等值判定（bg-sentinel `classify` 内 `missionAttributionId` 闸）。
- **空值三段规则**（R3 中-1）：①前向归因=W3 落地的 `spawned_by_session`（headless 派发同步段写 `dispatchCoordSessionId()`，缺锚=null 不造值）；②有归因按等值判定；③**缺席回落硬约束=漏报可见**——无归因（或锚缺失无法比对）mission **零开枪**，落 `scoping-skipped` 回声留痕（echo.jsonl，每 mission×类别去重）+ **server 组包尾块携带缺席计数**（`buildDispatchPrompt` 恒在节 `【哨兵 scoping】归因缺席在盯 mission：N 件`，`dispatchScopingAbsentCount` 镜像 classify 条件集统计）；fail-open（缺席全员盯守→他会话回 MOD3a 误枪）与纯 fail-closed（静默跳过→主线流量漏报不可见）均已否决。**归因补齐后每 tick 重判自动恢复盯守**（闸内 owned 即清留痕去重键）。
- **他会话（等值不成立）**：零开枪转**静默留痕**（echo `scoping-foreign`）；完成态照常落板+spool（worker/server 行为不变），回归补报走 session-start 简报 unread 计数（平台假设=R3 低-6：依赖回归触发 SessionStart 简报；降级路径=用户自查 spool unread 面，机制不依赖注入——注入唤醒线已随 U3 废弃）。
- **复活/自补员（触发面①②组合，W9 阶段 b）**：①SessionStart（session-start `reviveSentinelFamily`：锚发布后探活，家族全灭才拉起 cfg family_size 个实例；四闸=ORCH_MANAGED_WORKER/sess_subagent 前缀/board 在场/sentinel.cfg.json 在场）；②headless dispatch 派发前探活（server `ensureSentinelFamily`，「无哨兵不派发」；W5 组装出口后续接同探活）。实锚 T0：SessionStart 对宿主重启后非交互首会话触发（M0-2 findings §2/§5：-p 会话 hook input 实采 source:"startup"），故 ①+② 组合按推荐落地、无需豁免。
- **补告警（REV③）**：复活实例首扫对「本实例启动前已到期升级」（anchorMs < startedAt 且 matured）条件集中补告警一次（echo `catchup`，每实例生命周期至多一次）；宽限阈值复核结论：`HEARTBEAT_STALE_MS` 90s=槽位判死/在岗刻度，**≠** wake/answer/stall/crash_grace 升级阈值，两族常量无 conflation。
- **O10 协同**：条件锚一律取自 board timeline（重派 upsert 事件即最新活动锚，`lastActivityMs` 语义），复活首扫以板面为据、无跨 tick 内存态——已豁免重派 mission 不因复活丢态而误判双跑。

### A2 `family-teardown.json`

| 栏 | 内容 |
|---|---|
| **写方** | bg-sentinel 寿命到期单赢家认领（claimTeardown L709-745，`{flag:"wx"}` 原子创建）；陈旧/损坏标记复核后 unlink 夺位重写（L739）。单写方多实例仲裁 |
| **读方** | 仅 bg-sentinel 同进程（readAt L712-719，读 `at` 判新鲜）。无跨进程读方 |
| **字段** | `{at:ISO8601, pid:int, slot:int}`＋`\n`（L722-725）。无 schema 校验 |
| **失效语义** | 新鲜标记（age < freshMs）→ 其余实例输家顺延（`静默降级`）；进程死亡残留 → 下一代可认领（文件不主动清，夺位语义兜底，`自愈`）；坏 at 字段 → 视为最老可夺位（`自愈`）；并发竞争 wx 串行化，3 轮尝试败 → 本轮放弃下轮再选，**绝不双赢家双退出**（`静默降级`）；旧版实例不识标记照旧自退出（混跑兼容，非 fatal） |

### A3 `sentinel.cfg.json`（存储根本级）

| 栏 | 内容 |
|---|---|
| **写方** | **server 独占**：启动写出 writeSentinelCfg（L1026-1085，v0.9 C8 全 sparse——signals 块无条件写，v2 十键+桥四键仅显式 argv 传入才写，键缺失=哨兵内建默认生效，server 永不 shadow 哨兵侧默认变更）；server 只写不读自身（单写方） |
| **读方** | ①bg-sentinel 每 tick 重读（readCfg L2225-2231，B6；CLI 参数恒优先于文件）；②server sentinelHealth 读 family_size 渲染家族规模（L3496-3502，读失败保默认 3） |
| **字段** | signals 块（无条件）：`rollout_dir/tool_usage_db/mailbox_root`（空串=哨兵侧默认）、`coord_session_file`（默认 "sentinel/coord-session.txt"，L1040）、`toast_on_abandon:bool`；v2 稀疏键：`wake_poll_sec/wake_grace_min/answer_grace_min/stall_grace_min/crash_grace_min/coord_idle_min/cap_window_min/family_size/stagger_sec/max_lifetime_min`＋桥键 `wake_timeout_min/wake_retries/refire_gap_min/wake_cap`（仅显式传入时出现；实测生产样例含 wake_poll_sec:60/wake_grace_min:5/family_size:3/wake_timeout_min:10/wake_retries:3）。无 schema 校验=裸 JSON |
| **失效语义** | 文件缺失/坏 JSON → readCfg 返回 {}，全键走内建默认（`静默降级`，绝不让哨兵哑火）；server 写失败仅 log 一行跳过（L1081-1083，`静默降级`）；键缺失=默认生效（sparse 语义即失效语义）；断言 A-v090-CLN-05 在册（sentinel-teardown T11，全 sparse 形状+零漂移对拍） |

---

## B 组·告警与回声面

### B1 `fired/<key>--<category>--<ms>.json`

| 栏 | 内容 |
|---|---|
| **写方** | bg-sentinel 开枪前 wx 认领（claimShots L866-899，`{flag:"wx"}` EEXIST=双实例同 tick 竞争恰一成功）；清理 unlink（pruneFired L902-920，>24h 由任意实例启动/每 30 分钟）。文件名 v0.6 V6-54 去 pid——同 key+category+同毫秒双实例同名文件 wx 恢复互斥（旧名带 pid 有双开枪 TOCTOU 窗） |
| **读方** | ①bg-sentinel firedEntries（L822-844，按 `<key>--<category>--` 前缀过滤+按 at 新→旧排序）→ firedEligible 仲裁（L848-856：隔离新鲜期 false／refireGap 内他人已开枪 false／cap 窗满 false）＋claimShots 写前数窗；②server sentinelHealth fired 24h 窗聚合（L3557-3560）+ abandoned 判定（hasFinal ∧ isSuspicious） |
| **字段** | 条目 schema（L877-886，§9.3 补全）：`key:string`（条件键；`"__board__"`=板级条件）／`category:string`（unclaimed_terminal/unclaimed_answer/inflight_stall/crash/quarantine 族）／`mission_id?:string`（**key!=="__board__" 时必有**，L880 条件展开）／`at:ISO8601`／`by_pid:int`／`slot:int`／`final:bool`（本次=第 cap 枪的放弃标记，不再另写文件）／`summary_head:string≤200`（空白归一）。无 schema 校验=裸 JSON |
| **失效语义** | 超 cap_window 自动恢复开枪能力（`自愈`，条目按 mtime 24h 物理清理）；wx 竞态=首告者唯一后到者静默跳过（`静默降级`）；坏条目跳过不致命（L838 `静默降级`）；**条目唯一清理条款=24h prune**，无其他删除方 |

**断言裸区标注（实测校正，候选三文件之一）**：文件名协议与数量有锁（sentinel-teardown T2d 条目落盘、T5 前缀过滤 `m-<id>--<category>--`、L389 文件名=key--category--ms 无 pid 段），但**条目内容字段（key/category/mission_id/at/by_pid/slot/final/summary_head）零字段级断言**——套件仅按文件名/计数断言，无任何测试 JSON.parse fired 条目校验字段（grep 实测 0 命中）。字段级=断言裸区，LM-05 注册后补断言的优先候选。

### B2 `quarantine.json`

| 栏 | 内容 |
|---|---|
| **写方** | bg-sentinel 观测型隔离首告 wx 认领（claimQuarantine L780-803：EEXIST 时新鲜标记→false 加入，陈旧/损坏→unlink 夺位重写）；恢复 unlink（L798；主循环 L2436-2447 板恢复可读即删） |
| **读方** | 仅 bg-sentinel（readQuarantine L758-767／quarantineFresh L770-773，age < capWindowMs=新鲜期内全家族告警挂起 firedEligible 首检 false）。**bg-gate 不读本文件（grep 实测 0 命中——DP2a 卡表"bg-gate"读方记载未证实，以本实测为准）**；server sentinelHealth 亦不读 |
| **字段** | `{at:ISO8601, pid:int, slot:int, reason:string, evidence:object\|null}`＋`\n`（L786，§9.3 补全；evidence 实测含 `{ticks:int≥3}` 等 C0 观测证据快照）。无 schema 校验=裸 JSON |
| **失效语义** | 隔离语义=观察型不阻断：哨兵转 quarantined 低频值守（心跳照旧、不退出、不杀进程、不写 board）；恢复即删（`自愈`）；损坏时按"无隔离"处理 readQuarantine 返回 null（`静默降级`，认领方夺位重写兜底）；新鲜期内新条件 firedEligible 首检 false——三实例并发恰一条聚合告警（V7-04 家族级抑制） |

**断言裸区标注（实测校正，候选三文件之一）**：半裸区——`reason`/`evidence.ticks` 有字段断言（sentinel-teardown WS-5 块 L586：qdoc.reason 含"不可读" ∧ evidence.ticks≥3 ∧ echo quarantine 类别恰 1 条），但 `at/pid/slot` 字段与"陈旧标记夺位重写"竞争语义无直接断言。字段覆盖不完整=修复波次候选。

### B3 `echo.jsonl`

| 栏 | 内容 |
|---|---|
| **写方** | bg-sentinel 回声写（appendEcho L931-957）：**读入→追加→截半→整文件重写**（非 append 语义！>256 行滚动截半 ECHO_MAX_LINES L107）；pruneEcho（L959-979，24h 外行清理，同样整文件重写）。单写方 |
| **读方** | ①bg-sentinel 自身（appendEcho 读改写）；②server sentinelHealth echo_tail（L3632-3651，末 3 行 summary_head ≤160 逆序渲染） |
| **字段** | 行 schema（L935-943，§9.3 补全）：`at:ISO8601`／`key:string`（claims 并逗号）／`category:string`（claims 并逗号）／`final:bool`（任一 claim final 即 true）／`toast_attempted?:true`（可选）／`summary_head:string≤300`（空白归一）。JSONL，无 schema 校验 |
| **失效语义** | 回声绝不弄挂开枪路径（appendEcho 全 catch `静默降级`）；坏行跳过留待滚动淘汰（pruneEcho L972 `静默降级`）；行数帽内保留、超帽截半（`自愈`）。**重写而非追加=与 spool 的 append 语义相反**，协议客户端勿按 JSONL append 直觉消费 |

**断言裸区标注（实测校正，候选三文件之一）**：半裸区——行存在性/类别计数/行数增减有锁（T1c 零回声、T2c 落盘含 unclaimed_terminal、T6c/T8 行数快照、WS-5 category quarantine 恰 1），但**字段级（at/key/final/summary_head/toast_attempted）零断言**且 **256 行滚动截半帽无直接断言**（fired 侧同样）。字段级+滚动帽=断言裸区候选。

---

## C 组·唤醒锚对（P1 修复所在面；W4-M4-1 前置素材）

> 本组=成对锚（session+workspace 两文件，同源同刻发布保互信根一致）。**已修面坐标以 2026-10-28 实测口径写入，仅作回归腿描述，已修面不重修**；W4-M4-1 已消费 M0-2 findings：三证皆空 → **分支 B**（判别闸不落，两道兜底升格正式防线，补记见 C2 后）。

### C1 `coord-session.txt`

| 栏 | 内容 |
|---|---|
| **写方** | **多写方=锚劫持攻击面，三重守卫为卡核心失效语义**：①server toolResume 通道（L7984-7992，原子写 sessionId+"\n"；前置拒绝 sess_subagent 前缀 L7965-7971 fail-loud 零锚写）；②session-start publishWakeAnchor（L334-362：**闸1 env 守卫 L341** `ORCH_MANAGED_WORKER` 在即 return（W-A0，headless 托管 worker 不抢锚）；**闸2 子代理前缀过滤 L351** `sess_subagent` 前缀 return（G14）；过闸后 **L352 无条件双写** coord-session.txt——手工裸 -p 会话无 env 拦不住（W-A0 注释明示残留挂账，M0-2 三证实测未命中低成本判别面，兜底见下）；session id 经 safeSessionId 消毒 L319-321）；③watcher/inject.mjs C11 回读刷新（L572-674：b2 自愈新建会话后以应答回读活体 id 原子刷新，tmp+rename；前置锚字节守卫+b2 禁用语义） |
| **读方** | ①bg-sentinel coordSessionId（L466-483，双空闲门主信号来源+邮箱回声 toSessionId；**消费端形状校验**：命中 sess_subagent 前缀即忽略该锚+stderr 一行 fail-loud 定因 L472-477，EXP10 R6）；②server dispatchCoordSessionId（L6695-6701，v1.2 M3-1 Q2 归因字段 spawned_by_session 值源，缺文件/空 → null 不造值）；③wake-kick 锚活性前置校验（L218 读锚）+**注入前后字节守卫**（L320/L352：锚字节被改即放弃注入——O4=b 两道兜底之一）；④watcher/inject（唤醒目标+subagentRefusal 源面） |
| **字段** | 单行 session id＋`\n`（无第二行；空文件=无锚）。无 schema 校验=裸 txt |
| **失效语义** | 缺失=唤醒链断点（bg-sentinel 按无主控会话兜底 coordBusy 全信号缺失→门常开 `静默降级`；watcher 无锚 fail-loud 拒注入 `fail-loud`）；**多写方竞态=锚劫持**（历史活体 2026-10-25 实证），三重守卫（闸1 env/闸2 前缀/消费端前缀忽略）+两道兜底（wake-kick 字节校验／inject 回读活体 id 刷新）构成纵深（回归腿，已修面）；子代理锚被消费端前缀闸拦截（`fail-loud` 留痕）；G5 场景（app 重启后锚对缺失）由 SessionStart 无条件重发布自愈（`自愈`） |

### C2 `coord-workspace.txt`

| 栏 | 内容 |
|---|---|
| **写方** | ①session-start publishWakeAnchor 成对写（L361；W24 L353-361 工作区锚提升：约定形存储根取 resolveRoot 上两级=真实项目根，防 cwd 漂移写子目录）；②server toolResume 双写（L7988）；③server 启动 filler G5（L702-723：**仅当 sentinel/ 目录已存在且本文件缺失时补写** projectDir——只填缺不覆盖，**server 启动面不写 coord-session.txt**（DP2a 卡表"启动 filler"表述以本实测为准）；永不创建 sentinel/ 目录保 l0 V13 语义） |
| **读方** | ①watcher.mjs G10 工作区锚钉（L168/L213，读锚作 workspaceKeyHint）；②watcher/bridge.mjs openBridge（L386-425：hint 缺失 throw bridge-anchor-missing／no-workspace-anchor **拒绝盲取 workspaces[0]**——R4 锚劫持因果链的读端防线）；③watcher/inject L674 workspace-anchor-missing 拒绝 |
| **字段** | 单行绝对路径＋`\n`。无 schema 校验=裸 txt |
| **失效语义** | 缺失/为空 → watcher 拒绝盲取 fail-loud（`fail-loud`，不再回退 workspaces[0]——EXP10 R4 修复后语义）；锚指向未打开工作区 → bridge-anchor-mismatch（`fail-loud`，文案引导删除锚后由 /orch-resume 或 SessionStart 重写）；漂移（写入了子目录路径）→ watcher 精确匹配失败（W24 修复面）；G5 filler 只在缺失窗补位（`自愈`，授权面=server 启动/session-start/toolResume 三写方，watcher 恒不写锚 watcher.mjs L307） |

---

### C 组补记（M4-1 分支 B · 2026-10-28）：P1 判别闸不落，两道兜底升格为正式防线

> **分支终裁（M0-2 findings 消费完毕）**：判别面三证实测**三证皆空**——证1 env：CLI 无 -p 特征变量注入点（bundle 内 `process.env.*=` 赋值仅 5 处，均非模式标记）；证2 hook input：字段集由单一构造器产出（两表面同构），值差异仅旗标派生量 `permission_mode`（双向假信号）；证3 transcript 形态：`transcript_path` 恒为 temp 合成件（bundle 单赋值点，交互侧同构）。→ **O4=b 终裁：不落判别闸**；两道消费端兜底自本补记起为**正式防线**（非临时缓解），与写面三重守卫（闸1 env／闸2 前缀／消费端前缀忽略）共同构成锚劫持纵深防御。三证方法与原始证据＝`designs/agent-orchestrator-v1.2-planning/dp2c/p1-discrimination-findings.md`（判定矩阵与落闸建议 §0，三证 §1-§3，锚劫持活体复现 §5）。本节行号同卡头声明口径（2026-10-28 时点实测，不作跨版引用）。
>
> **判别面负面结论（防误用，钉死）**：会话 id 前缀（`session_*` vs `sess_*`）**不可作判别闸**——前缀语义=派生面（桌面 app-server vs CLI 生成）而非交互性，且历史已漂移（v0.10 G14 注释时点交互主控曾为 `sess_*`；现状 coordinator=`session_*`，CLI 全会话含终端 TUI 主控=`sess_*`，findings §4-FA）。据此落闸将误杀终端 TUI 主控（唤醒链断，违背不对称原则）；「闸2 扩展为前缀过滤」类捷径同此否证。后续判别闸提案须先推翻该实测再议。

**防线一·消费端字节校验（hooks/wake-kick.mjs；kick 路径净效果=「锚零改写、绝不认新会话」，注释 L27-32）**：注入前对 `coord-session.txt`＋`watcher-signals.jsonl` 双文件取字节快照（guardAnchor/guardSignals L352-353，快照 L381-382）；注入后逐文件重读比对（L398-410），字节被改（=watcher 注入链内 b2 刷新锚发生）即**原子还原快照**（快照缺失→还原为缺失）并按失败处置——事件留队＋`anchor-rewritten` 告警（L412-421）。signals 同款快照还原=kick 瞬时 D1/D2 信号不落共享面（防哨兵 W6 消费面把 kick 重试误读为「watcher 在岗」而静默 C1 兜底告警）。失效语义：劫持在注入窗内被即时还原＋告警可见（`自愈`＋`fail-loud`），兜住 W-A0 残留面（手工裸 -p 会话抢锚）最后一道闸。

**防线二·活体回读刷新（watcher/inject.mjs C11 节 L572+；b2 stale 目标自愈面）**：b1 活体目标=零重写；b2 stale（死路）目标→以 createSession 应答回读活体会话 id（`resolveLiveSessionId` L594；应答无 sessionId 字段→只建会话不刷新，OPEN-10.4；回读缺省窗 `RESP_TIMEOUT_MS=25000` L643，超窗不刷新）**tmp+rename 原子刷新** coord-session.txt（L622-623）。刷新过四重闸（`workspaceVerified` L732-747，任一不过即保持原锚＋`b2-refresh-blocked:*` warnings 落告警面）：①目标仍为子代理形状拒绝（subagent-session-target）；②无工作区锚拒绝（no-workspace-anchor）；③应答工作区与锚不一致拒绝（response-workspace-mismatch）；④本次桥工作区与锚不一致拒绝（bridge-workspace-mismatch）；回读活体 id 仍为子代理形状绝不写锚（L741-742，与 G14 写锚过滤/G4-04 工作区守卫并列，三者任一不过即拦截刷新）；子代理目标在入口即拒（L681-688，不建桥不发帧不刷新锚）。best-effort 永不 fatal（`自愈`）。

**防线分工与互斥语义**：防线一保「锚被劫持→kick 注入窗内还原＋告警」（向后还原），防线二保「锚指向死会话→常规唤醒链内自动追活」（向前刷新），方向相反互补成环。**kick 复活路径内 b2 刷新被显式禁用**（wake-kick 注释 L27-32「b2 自愈禁用=锚劫持防线（硬要求）」）：kick 窗内若 b2 刷新锚发生即被防线一还原并按失败处置——该互斥系设计意图，非竞争缺陷。

---

## D 组·信号与状态面

### D1 `watcher-signals.jsonl`

| 栏 | 内容 |
|---|---|
| **写方** | watcher 进程独占：watcher/degrade.mjs DegradeState#writeSignal（L133-142，读入→追加→截半→整文件重写，SIGNALS_MAX_LINES=256 滚动截半 L28/L139）；仅 D1/D2/D3/kicked 四类事件写（record L127），成功交付（success/noop/accepted）不写=静默。**信号语义=「watcher 在岗/失能」状态面而非逐单回执面** |
| **读方** | 仅 bg-sentinel watcherCoverage（L544-567，**lazy 消费**：仅板面出现 C1 未签收终态条件才读；取最新有效条目按 at 判新，坏行跳过） |
| **字段** | 行 schema（L138，§9.3 补全）：`at:ISO8601`／`cls:"D1"\|"D2"\|"D3"\|"kicked"`（D2=瞬时重试中仍在岗；D1/D3/kicked=终态 standby）／`mission:string\|null`／`reason:string`（redact 脱敏）。JSONL，无 schema 校验 |
| **失效语义** | watcher 未运行=文件缺失=无信号走既有兜底（`静默降级`，设计内）；读失败/坏行/无有效条目 → 不覆盖走兜底（`静默降级`，绝不因信号面故障哑火或误哑）；信号新鲜刻度 TTL（默认 10min，cfg watcher_signal_ttl_min）过期 → 兜底；C2 stall/C3 crash 为 watcher 事件中继盲区，哨兵无条件保留永不静默（§15 裁决） |

### D2 `glean-launch-state.json`

| 栏 | 内容 |
|---|---|
| **写方** | bg-sentinel 归敛自动拉起面（writeGleanState L1719-1721，atomicWriteRaw tmp+rename 原子写；成功 spawn 后写 L2081-2091）；清除 unlink（clearGleanState L1724-1733，**launch_token 不匹配=他人轮次不删**） |
| **读方** | 仅 bg-sentinel 自身（readGleanState L1710-1717）——轮换后新实例接管监视的唯一锚点（「长冷却锚在退出」与「挂死自愈」面；锁本体只承载单飞不承载监视） |
| **字段** | `{v:1, pid:int, started_at:ISO8601, log_path:string, memory_root:string, root_dir:string, launch_token:string, grace_ms:int, snapshot:object}`＋`\n`（L2081-2091，§9.3 补全）。无 schema 校验=裸 JSON |
| **失效语义** | 自愈型状态文件：残留无全局后果（`静默降级`）；坏文件 → readGleanState 返回 null 视为无在跑状态（`静默降级`）；token 仲裁防跨轮误删（`自愈`）；子进程退出/超时/失败即清 |

---

## §5 断言锚总表（含裸区实测标注）

| 文件 | 断言面（实测） | 裸区结论 |
|---|---|---|
| instance-<k>.json | sentinel-teardown T1/T2/T5/T6/WS-9d（state 三态/on_duty/took_over/root/心跳）；root-contract V6-56 root 字段；l0 V13（缺 sentinel/ → available:false）；server sentinelHealth 形状经 WS-9d | **非裸区**（prev 字段无直接断言=残余注记） |
| family-teardown.json | sentinel-teardown T3（T3d 标记随最后赢家更新） | **非裸区** |
| sentinel.cfg.json | sentinel-teardown T11（A-v090-CLN-05 全 sparse 形状+零漂移对拍，tests/assertions/v0.9.x.md §16 在册）；crv5-auth CFG 组联动 | **非裸区** |
| fired/ | sentinel-teardown T2d/T5/T10（文件名协议+计数+前缀过滤） | **裸区（字段级）**：条目 8 字段零 JSON.parse 断言 |
| quarantine.json | sentinel-teardown T8/WS-5（reason/evidence.ticks/echo 类别计数） | **半裸区**：at/pid/slot 与夺位竞争语义无断言 |
| echo.jsonl | sentinel-teardown T1c/T2c/T6c/T8（存在性/类别计数/行数快照） | **半裸区**：字段级+256 行滚动帽无断言 |
| coord-session.txt | watcher-core（G14-b 存量锚零触碰、C11 双分支刷新、W2-02 形状闸）；crv6-resilience DSP-08（server 归因值源）；bg-sentinel coordSessionId 前缀闸经 watcher-core L1915 源文本锁（静态形态锁非行为断言） | C 组主断言面在 watcher-core/crv6（**非裸区**；bg-sentinel 消费端闸为静态锁=弱覆盖注记） |
| coord-workspace.txt | watcher-core（C11/G4/G5 守卫、workspace-anchor-missing）；root-contract fixture 面 | **非裸区** |
| watcher-signals.jsonl | watcher-core W-DGR-05（256 行滚动帽）+WB-KICK-f1（kick 瞬时失败零落地）；sentinel-teardown T10（W6 消费让位） | **非裸区** |
| glean-launch-state.json | glean-launch.mjs 套件（在跑状态/接管/清理全链） | **非裸区** |

**脆度依据（双轴第一梯队定性）**：裸 txt/JSON 无 schema 校验 × 多写方 wx 竞态（C 组多写方=锚劫持攻击面）× 跨进程时钟判死（HEARTBEAT_STALE_MS 三处 twin 常量，P5 twin-lock 已锁字面值 90000）× 成对锚多写方多消费面 × 直至型进程常驻（残留文件跨代存活）。对照卡③ root.txt：本族面最广但后果多为可自愈/可降级；root.txt 后果全局性最重。

**M9-1 协同注记（E10 修订腿·已落地 2026-10-28）**：M9-1 已落 scoping（A 组缺口标注已按现行机制改写，见 A1 ⚠ 块）+复活补员（触发面①②）+补告警（REV③）+O10 协同；断言组=A-v0120-SCP/REV（sentinel-teardown SCP/REV 组+bggate REV 组）。LM-05 文档卡同步锁在册（lint-manifest LM05_CARD_ANCHORS 26 锚 grep 兜底）。
