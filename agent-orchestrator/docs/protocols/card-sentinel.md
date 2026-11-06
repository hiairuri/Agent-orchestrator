# Contract card (1): the sentinel/ directory family (11 files, five groups A-E)

> **Line-number declaration (card head)**: all line numbers in this document were measured at assembly time (grep + line-by-line source verification). Line numbers are **not referenced across versions**; cross-version locating relies on function/file-name anchors (l-20261022-6a14d6).
>
> - Home module: hooks/bg-sentinel.mjs (the until-type sentinel entry) + the consumers hooks/{session-start,bg-gate,wake-kick}, watcher/, and the mcp/server.mjs entry + mcp/ module family
> - Cross-reference: the line->duty navigation map = `card-bg-sentinel-map.md` (the two cards' division: that card governs "line -> duty", this card governs "file -> contract" - cross-referenced, not merged)
> - Brittleness dual-axis rating: **surface breadth = top tier** (10 files x 6 processes reading/writing x cross-process clock death judgments); **consequence severity = top tier (tied with the root-txt card)** (failure faces span the wake/alarm/watch chains, but a single-file failure mostly self-heals or degrades - no root.txt-style "everyone blind" global consequence)
> - Assertion anchor master table: see §5 at the end (with bare-zone notes)

**Invalidity semantics, three classes of notation**: `fail-loud` (explicit error/alarm, behavior visible) / `self-healing` (automatically restores to the correct state) / `silent degradation` (continues on the safe default, no or limited traces).

---

## Reading guide

| Group/section | Content | Quick anchor |
|---|---|---|
| §0 | the sentinel/ directory face + out-of-card neighbors + the parked count notes | the bg-sentinel entry startup section (mkdirSync recursive) |
| Group A | sentinel liveness face: the slot family / teardown / cfg trio | `claimSlot`/`touchSlot` (hooks/bg-sentinel/family.mjs); `writeSentinelCfg` (mcp/server-boot.mjs) |
| Group B | alarm and echo face: fired/quarantine/echo trio | `claimShots` (hooks/bg-sentinel/fired.mjs); `appendEcho` (hooks/bg-sentinel/echo.mjs) |
| Group C | the wake anchor pair coord-session/coord-workspace + the anchor-hijack defense-in-depth (addendum) | `publishWakeAnchor` (hooks/session-start.mjs) |
| Group D | signal and state face: watcher-signals (D1) + glean-launch-state (D2, parked) | `watcherCoverage` (hooks/bg-sentinel/signals.mjs) |
| Group E | dispatch congestion degradation face (E1, parked archive) | recovery = the parked/agent-orchestrator/README guide |
| §5 | assertion anchor master table (per file + bare-zone conclusion column) | sentinel-teardown/watcher-core/twin-lock suites |

The watcher client protocol face belongs to `card-watcher.md` (duty swap: its §4).

## 0. Directory face and out-of-card neighbors

The `<storage root>/sentinel/` directory is created by bg-sentinel at startup with `mkdirSync(recursive)` (the hooks/bg-sentinel.mjs entry startup section); the server never creates it (the G5 filler only backfills coord-workspace.txt when the directory already exists - detail C2 writer (3); this preserves the sentinel_health `available` signal semantics = l0 V13).

This card's 11-file family (**D2/E1 moved to parked/agent-orchestrator/ with the -p channel = historical semantics**; see each section's notes and the §5 table; the other nine files + the sentinel body stay zero-touch) - the five groups A-E, file by file, below (`sentinel.cfg.json` note: it sits at the storage root **itself**, not inside sentinel/, cataloged with group A).

**Out-of-card neighbors** (measured present in the same directory, not part of this card's protocol face, noted only to prevent misreading):
- `wake-kick-alerts/` + `wake-kick-last-spawn` - hooks/wake-kick.mjs alert de-duplication stamps
- `watcher-heartbeat` - watcher/watcher.mjs 60s heartbeat self-attestation (consumed by bg-sentinel's reverse monitoring)
- `sentinel.lock` (storage root level, legacy <=0.3.1) - still honored inside the bg-gate upgrade window (freshHeartbeat)
- `.mimosa` - external tool residue, not this plugin's write face

---

## Group A - sentinel liveness face (slots/rotation/config)

### A1 `instance-<k>.json`（k=0..family_size-1）

| 栏 | 内容 |
|---|---|
| **写方** | bg-sentinel 独占（单写方，wx/覆盖写双形态）：启动认领 wx 原子创建（`claimSlot`（hooks/bg-sentinel/family.mjs），`{flag:"wx"}` EEXIST=竞争败者让位）；接管改写（pid 死或心跳龄 >90s，family.mjs 覆盖写＋记录 prev）；心跳续写 `touchSlot`（family.mjs，**touch 前重读校验 pid 归属** V6-55，被接管实例苏醒后让位成无槽幽灵）；退出/轮换释放 unlink（`releaseSlot`（family.mjs）。**k=实例序数（0..family_size-1），非会话 id**——见下方 scoping 缺口标注 |
| **读方** | ①bg-sentinel 自身：`pruneStaleSlots`（family.mjs，启动清理"心跳过期 ∧ pid 死"槽位）、`claimSlot`、`touchSlot` 让位校验；②bg-gate sentinelAlive（任一 fresh instance-<k>.json → 哨兵在岗，bg-gate 误报防护主信号）；③server sentinelHealth（mcp/server-sentinel.mjs，逐槽渲染 {slot,pid_alive,state,hb_age_sec,took_over,root,on_duty}） |
| **字段** | slotDoc 全字段（family.mjs，§9.3 补全）：`pid:int`（必选，判活主键）／`slot:int`（必选，=k）／`state:"active"\|"standby"\|"quarantined"`（必选三态；**旧版文件无此字段=active 归一**，mcp/server-sentinel.mjs 与 bg-sentinel family.mjs 同规）／`root:string\|null`（必选，V6-56 槽位自证解析根）／`started_at:ISO8601`（必选）／`heartbeatAt:ISO8601`（必选，判死主键）／`took_over?:true`（可选，接管痕迹）／`prev?:slotDoc\|null`（可选，被接管者快照）。文件尾 `\n`。无 schema 校验=裸 JSON |
| **失效语义** | 心跳龄 >90s（HEARTBEAT_STALE_MS=90000，hooks/bg-sentinel/core.mjs／bg-gate L37／mcp/server-sentinel.mjs `SENTINEL_HEARTBEAT_STALE_MS` **三处 twin 定义=死锁风险点，P5 twin-lock 锁定**）判死；`自愈`：死槽由下一代启动 prune+认领接管（prev 留痕）；坏文件/缺文件=该槽位视为空闲走 wx 认领（`静默降级`）；wx 竞态=认领失败让位下一槽位（`静默降级`，恰一成功）；全满全 fresh → 让位退出 exit 0＋一行 stdout（V7-08/R2 `fail-loud`）；幽灵实例（被接管后仍活）只损失观测在岗性，仲裁面防双开枪（`静默降级`） |

**⚠ scoping 缺口标注（M9-1 已修订落地，2026-10-28，v1.2 W9 阶段 a）**：槽位族以 **k=实例序数** 为键（0..family_size-1），作用于**整个存储根**——家族任一实例盯守该根下全部 mission；归属 scoping 已由 M9-1 在**开枪判定面**（classify）落地，槽位键本身保持实例序数不变（k 与会话 id 仍无关联，见下方机制）。现行归属 scoping 语义：
- **归属判定**：mission 归因 = `dispatch.session_id` ∥ `dispatch.spawned_by_session`（W3 M3-1 前向归因字段，dispatch/ONE_LEVEL 子键）；本哨兵所守会话 = coord-session 锚（`coordSessionId`，sess_subagent 前缀锚按既有消费端闸忽略）。开枪前等值判定（bg-sentinel `classify` 内 `missionAttributionId` 闸）。
- **空值三段规则**（R3 中-1）：①前向归因=W3 落地的 `spawned_by_session`（headless 派发同步段写 `dispatchCoordSessionId()`，缺锚=null 不造值）；②有归因按等值判定；③**缺席回落硬约束=漏报可见**——无归因（或锚缺失无法比对）mission **零开枪**，落 `scoping-skipped` 回声留痕（echo.jsonl，每 mission×类别去重）+ **server 组包尾块携带缺席计数**（`buildDispatchPrompt` 恒在节 `【哨兵 scoping】归因缺席在盯 mission：N 件`，`dispatchScopingAbsentCount` 镜像 classify 条件集统计）；fail-open（缺席全员盯守→他会话回 MOD3a 误枪）与纯 fail-closed（静默跳过→主线流量漏报不可见）均已否决。**归因补齐后每 tick 重判自动恢复盯守**（闸内 owned 即清留痕去重键）。
- **他会话（等值不成立）**：零开枪转**静默留痕**（echo `scoping-foreign`）；完成态照常落板+spool（worker/server 行为不变），回归补报走 session-start 简报 unread 计数（平台假设=R3 低-6：依赖回归触发 SessionStart 简报；降级=自查 spool unread；注入线已随 U3 废弃）。
- **复活/自补员（触发面①②组合，W9 阶段 b）**：①SessionStart（session-start `reviveSentinelFamily`：锚发布后探活，家族全灭才拉起 cfg family_size 个实例；四闸=ORCH_MANAGED_WORKER/sess_subagent 前缀/board 在场/sentinel.cfg.json 在场）；②headless dispatch 派发前探活（server `ensureSentinelFamily`，「无哨兵不派发」）。实锚 T0：SessionStart 对宿主重启后非交互首会话触发（M0-2 findings 实采），①+② 组合按推荐落地、无需豁免。
- **补告警（REV③）**：复活实例首扫对「本实例启动前已到期升级」（anchorMs < startedAt 且 matured）条件集中补告警一次（echo `catchup`，每实例生命周期至多一次）；宽限阈值复核结论：`HEARTBEAT_STALE_MS` 90s=槽位判死/在岗刻度，**≠** wake/answer/stall/crash_grace 升级阈值，两族常量无 conflation。
- **O10 协同**：条件锚一律取自 board timeline（重派 upsert 事件即最新活动锚，`lastActivityMs` 语义），复活首扫以板面为据、无跨 tick 内存态——已豁免重派 mission 不因复活丢态而误判双跑。

### A2 `family-teardown.json`

| 栏 | 内容 |
|---|---|
| **写方** | bg-sentinel 寿命到期单赢家认领（`claimTeardown`（family.mjs），`{flag:"wx"}` 原子创建）；陈旧/损坏标记复核后 unlink 夺位重写（family.mjs）。单写方多实例仲裁 |
| **读方** | 仅 bg-sentinel 同进程（`readAt`（family.mjs），读 `at` 判新鲜）。无跨进程读方 |
| **字段** | `{at:ISO8601, pid:int, slot:int}`＋`\n`（family.mjs）。无 schema 校验 |
| **失效语义** | 新鲜标记（age < freshMs）→ 其余实例输家顺延（`静默降级`）；进程死亡残留 → 下一代可认领（文件不主动清，夺位语义兜底，`自愈`）；坏 at 字段 → 视为最老可夺位（`自愈`）；并发竞争 wx 串行化，3 轮尝试败 → 本轮放弃下轮再选，**绝不双赢家双退出**（`静默降级`）；旧版实例不识标记照旧自退出（混跑兼容，非 fatal） |

### A3 `sentinel.cfg.json`（存储根本级）

| 栏 | 内容 |
|---|---|
| **写方** | **server 独占**：启动写出 `writeSentinelCfg`（mcp/server-boot.mjs，v0.9 C8 全 sparse——signals 块无条件写，v2 十键+桥四键仅显式 argv 传入才写，键缺失=哨兵内建默认生效，server 永不 shadow 哨兵侧默认变更）；server 只写不读自身（单写方） |
| **读方** | ①bg-sentinel 每 tick 重读（`readCfg`，hooks/bg-sentinel.mjs 入口主循环 B6；CLI 参数恒优先于文件；该锚已随主控裁定 2026-11-01 从 LM-05 锚表退役，cfg 契约面由 sentinel-teardown T11 A-v090-CLN-05 专锁兜底）；②server sentinelHealth 读 family_size 渲染家族规模（mcp/server-sentinel.mjs，读失败保默认 3） |
| **字段** | signals 块（无条件）：`rollout_dir/tool_usage_db/mailbox_root`（空串=哨兵侧默认）、`coord_session_file`（默认 "sentinel/coord-session.txt"，mcp/server-boot.mjs 写出面）、`toast_on_abandon:bool`；v2 稀疏键：`wake_poll_sec/wake_grace_min/answer_grace_min/stall_grace_min/crash_grace_min/coord_idle_min/cap_window_min/family_size/stagger_sec/max_lifetime_min`＋桥键 `wake_timeout_min/wake_retries/refire_gap_min/wake_cap`（仅显式传入时出现）。无 schema 校验=裸 JSON |
| **失效语义** | 文件缺失/坏 JSON → readCfg 返回 {}，全键走内建默认（`静默降级`，绝不让哨兵哑火）；server 写失败仅 log 一行跳过（mcp/server-boot.mjs `writeSentinelCfg`，`静默降级`）；键缺失=默认生效（sparse 语义即失效语义）；断言 A-v090-CLN-05 在册（sentinel-teardown T11，全 sparse 形状+零漂移对拍） |

---

## Group B - alarm and echo face

### B1 `fired/<key>--<category>--<ms>.json`

| 栏 | 内容 |
|---|---|
| **写方** | bg-sentinel 开枪前 wx 认领（`claimShots`（hooks/bg-sentinel/fired.mjs），`{flag:"wx"}` EEXIST=双实例同 tick 竞争恰一成功）；清理 unlink（`pruneFired`（fired.mjs），>24h 由任意实例启动/每 30 分钟）。文件名 v0.6 V6-54 去 pid——同 key+category+同毫秒双实例同名文件 wx 恢复互斥 |
| **读方** | ①bg-sentinel `firedEntries`（fired.mjs，按 `<key>--<category>--` 前缀过滤+按 at 新→旧排序）→ `firedEligible` 仲裁（fired.mjs：隔离新鲜期 false／refireGap 内他人已开枪 false／cap 窗满 false）＋claimShots 写前数窗；②server sentinelHealth fired 24h 窗聚合（mcp/server-sentinel.mjs）+ abandoned 判定（hasFinal ∧ isSuspicious） |
| **字段** | 条目 schema（fired.mjs，§9.3 补全）：`key:string`（条件键；`"__board__"`=板级条件）／`category:string`（unclaimed_terminal/unclaimed_answer/inflight_stall/crash/quarantine 族）／`mission_id?:string`（**key!=="__board__" 时必有**，fired.mjs 条件展开）／`at:ISO8601`／`by_pid:int`／`slot:int`／`final:bool`（本次=第 cap 枪的放弃标记，不再另写文件）／`summary_head:string≤200`（空白归一）。无 schema 校验=裸 JSON |
| **失效语义** | 超 cap_window 自动恢复开枪能力（`自愈`，条目按 mtime 24h 物理清理）；wx 竞态=首告者唯一后到者静默跳过（`静默降级`）；坏条目跳过不致命（fired.mjs `静默降级`）；**条目唯一清理条款=24h prune**，无其他删除方 |

### B2 `quarantine.json`

| 栏 | 内容 |
|---|---|
| **写方** | bg-sentinel 观测型隔离首告 wx 认领（`claimQuarantine`（family.mjs）：EEXIST 时新鲜标记→false 加入，陈旧/损坏→unlink 夺位重写）；恢复 unlink（family.mjs；主循环 hooks/bg-sentinel.mjs 板恢复可读即删） |
| **读方** | 仅 bg-sentinel（`readQuarantine`／`quarantineFresh`（family.mjs），age < capWindowMs=新鲜期内全家族告警挂起 firedEligible 首检 false）。**bg-gate 不读本文件（grep 实测 0 命中——DP2a 卡表"bg-gate"读方记载未证实，以本实测为准）**；server sentinelHealth 亦不读 |
| **字段** | `{at:ISO8601, pid:int, slot:int, reason:string, evidence:object\|null}`＋`\n`（family.mjs，§9.3 补全；evidence 实测含 `{ticks:int≥3}` 等 C0 观测证据快照）。无 schema 校验=裸 JSON |
| **失效语义** | 隔离语义=观察型不阻断：哨兵转 quarantined 低频值守（心跳照旧、不退出、不杀进程、不写 board）；恢复即删（`自愈`）；损坏时按"无隔离"处理 readQuarantine 返回 null（`静默降级`，认领方夺位重写兜底）；新鲜期内新条件 firedEligible 首检 false——三实例并发恰一条聚合告警（V7-04 家族级抑制） |

### B3 `echo.jsonl`

| 栏 | 内容 |
|---|---|
| **写方** | bg-sentinel 回声写（`appendEcho`（hooks/bg-sentinel/echo.mjs））：**读入→追加→截半→整文件重写**（非 append 语义！>256 行滚动截半 `ECHO_MAX_LINES`（hooks/bg-sentinel/core.mjs））；`pruneEcho`（echo.mjs，24h 外行清理，同样整文件重写）。单写方 |
| **读方** | ①bg-sentinel 自身（appendEcho 读改写）；②server sentinelHealth echo_tail（mcp/server-sentinel.mjs，末 3 行 summary_head ≤160 逆序渲染） |
| **字段** | 行 schema（echo.mjs，§9.3 补全）：`at:ISO8601`／`key:string`（claims 并逗号）／`category:string`（claims 并逗号）／`final:bool`（任一 claim final 即 true）／`toast_attempted?:true`（可选）／`summary_head:string≤300`（空白归一）。JSONL，无 schema 校验 |
| **失效语义** | 回声绝不弄挂开枪路径（appendEcho 全 catch `静默降级`）；坏行跳过留待滚动淘汰（`pruneEcho`（echo.mjs）`静默降级`）；行数帽内保留、超帽截半（`自愈`）。**重写而非追加=与 spool 的 append 语义相反**，协议客户端勿按 JSONL append 直觉消费 |

---

## Group C - the wake anchor pair (the P1-fix face)

> This group = the paired anchors (session + workspace, two files published by the same source at the same moment to keep the trust root consistent); the fixed-face coordinates are written per the measured accounting (regression-leg descriptions; fixed faces are not re-fixed); the final rulings and defense-in-depth are in the group C addendum below.

### C1 `coord-session.txt`

| 栏 | 内容 |
|---|---|
| **写方** | **多写方=锚劫持攻击面，三重守卫为卡核心失效语义**：①server toolResume 通道（mcp/tool-resume.mjs，原子写 sessionId+"\n"；前置拒绝 sess_subagent 前缀 fail-loud 零锚写）；②session-start `publishWakeAnchor`：**闸1 env 守卫** `ORCH_MANAGED_WORKER` 在即 return（W-A0，headless 托管 worker 不抢锚）；**闸2 子代理前缀过滤** `sess_subagent` 前缀 return（G14）；过闸后无条件双写 coord-session.txt——手工裸 -p 会话无 env 拦不住（W-A0 注释明示残留挂账，M0-2 三证实测未命中低成本判别面，兜底见补记）；session id 经 safeSessionId 消毒；③watcher/inject.mjs C11 回读刷新（b2 自愈活体 id 原子刷新——详 C 组补记 防线二） |
| **读方** | ①bg-sentinel `coordSessionId`（hooks/bg-sentinel/signals.mjs，双空闲门主信号来源+邮箱回声 toSessionId；**消费端形状校验**：命中 sess_subagent 前缀即忽略该锚+stderr 一行 fail-loud 定因，EXP10 R6）；②server `dispatchCoordSessionId`（mcp/tool-dispatch.mjs，M3-1 归因字段 spawned_by_session 值源，缺文件/空 → null 不造值）；③wake-kick 锚活性前置校验+**注入前后字节守卫**（锚字节被改即放弃注入——O4=b 两道兜底之一）；④watcher/inject（唤醒目标+subagentRefusal 源面） |
| **字段** | 单行 session id＋`\n`（无第二行；空文件=无锚）。无 schema 校验=裸 txt |
| **失效语义** | 缺失=唤醒链断点（bg-sentinel 按无主控会话兜底 coordBusy 全信号缺失→门常开 `静默降级`；watcher 无锚 fail-loud 拒注入 `fail-loud`）；**多写方竞态=锚劫持**（历史活体 2026-10-25 实证），三重守卫+两道兜底构成纵深（写方栏+C 组补记；回归腿，已修面）；子代理锚被消费端前缀闸拦截（`fail-loud` 留痕）；G5 场景（app 重启后锚对缺失）由 SessionStart 无条件重发布自愈（`自愈`） |

### C2 `coord-workspace.txt`

| 栏 | 内容 |
|---|---|
| **写方** | ①session-start publishWakeAnchor 成对写（W24 工作区锚提升：约定形存储根取 resolveRoot 上两级=真实项目根，防 cwd 漂移写子目录）；②server toolResume 双写（mcp/tool-resume.mjs）；③server 启动 filler G5（mcp/server-core.mjs：**仅当 sentinel/ 目录已存在且本文件缺失时补写** projectDir——只填缺不覆盖，**server 启动面不写 coord-session.txt**（DP2a 卡表"启动 filler"表述以本实测为准）；永不创建 sentinel/ 目录保 l0 V13 语义） |
| **读方** | ①watcher.mjs G10 工作区锚钉（读锚作 workspaceKeyHint）；②watcher/bridge.mjs openBridge（hint 缺失 throw bridge-anchor-missing／no-workspace-anchor **拒绝盲取 workspaces[0]**——R4 锚劫持因果链的读端防线）；③watcher/inject workspace-anchor-missing 拒绝 |
| **字段** | 单行绝对路径＋`\n`。无 schema 校验=裸 txt |
| **失效语义** | 缺失/为空 → watcher 拒绝盲取 fail-loud（不再回退 workspaces[0]——EXP10 R4 修复后语义）；锚指向未打开工作区 → bridge-anchor-mismatch（`fail-loud`，文案引导删除锚后由 /orch-resume 或 SessionStart 重写）；漂移（写入子目录路径）→ watcher 精确匹配失败（W24 修复面）；G5 filler 只在缺失窗补位（`自愈`，授权面=server 启动/session-start/toolResume 三写方，watcher 恒不写锚） |

---

### Group C addendum - the P1 discrimination gate did not land; the two fallbacks are promoted to formal defenses

> **Branch final ruling**: the discrimination face's three proofs (env injection point / hook input field construction / transcript shape) all measured **empty** - the CLI has no -p characteristic-variable injection point; the hook input field set is produced by a single constructor (the two surfaces isomorphic, value differences only flag-derived); `transcript_path` is always a temp synthetic file. -> **Final ruling: no discrimination gate lands**; the two consumer-side fallbacks are **formal defenses** from this addendum onward (not temporary mitigations), forming the anchor-hijack defense-in-depth together with the write-side triple guards (gate 1 env / gate 2 prefix / consumer-side prefix ignore). The three-proof method and original evidence = `designs/agent-orchestrator-v1.2-planning/dp2c/p1-discrimination-findings.md` (the ruling matrix / three proofs / live reproduction sections). This section's line numbers follow the card-head declaration accounting (not referenced across versions).
>
> **The discrimination face's negative conclusion (pinned, to prevent misuse)**: session id prefixes (`session_*` vs `sess_*`) **must not be a discrimination gate** - the prefix semantics mark the derivation face (desktop app-server vs CLI generation), not interactivity, and the prefixes have drifted historically. A gate would mis-kill terminal TUI coordinators (breaking the wake chain); shortcuts like "extend gate 2 into prefix filtering" are refuted the same way. Any future discrimination-gate proposal must first overturn this measurement.

**Defense 1 - consumer-side byte verification (hooks/wake-kick.mjs; the kick's net effect = "the anchor is never rewritten, a new session is never recognized")**: before injection, take byte snapshots of `coord-session.txt` + `watcher-signals.jsonl` (`guardAnchor`/`guardSignals`); after injection, re-read and compare each file - if bytes changed (= the b2 anchor refresh fired inside the watcher injection chain), **atomically restore the snapshot** (missing snapshot -> restore to missing) and handle as a failure - the event stays queued + an `anchor-rewritten` alarm. The signals-side restoration is the same: the kick's transient D1/D2 signals never land on the shared face (preventing the sentinel's W6 consumer from misreading kick retries as "watcher on duty" and silently falling to the C1 backstop alarm). Invalidity semantics: hijacking inside the injection window is restored immediately + the alarm is visible (`self-healing` + `fail-loud`) - the last gate covering the residual face (manual bare -p sessions grabbing the anchor).

**Defense 2 - live read-back refresh (watcher/inject.mjs section C11; the b2 stale-target self-healing face)**: a b1 live target = zero rewrite; a b2 stale (dead-end) target -> read back the live session id from the createSession answer (`resolveLiveSessionId`; an answer without a sessionId field -> create the session only, no refresh; a read-back default window `RESP_TIMEOUT_MS=25000`, no refresh past the window) - **tmp+rename atomic refresh** of coord-session.txt. The refresh passes four gates (`workspaceVerified`; failing any keeps the original anchor + `b2-refresh-blocked:*` warnings onto the alarm face): (1) subagent-shape rejection (subagent-session-target); (2) no workspace anchor rejection (no-workspace-anchor); (3) answer workspace vs anchor mismatch rejection (response-workspace-mismatch); (4) this bridge's workspace vs anchor mismatch rejection (bridge-workspace-mismatch); a read-back live id still in subagent shape never writes the anchor; subagent targets are rejected at the entrance (no bridge, no frames, no anchor refresh). best-effort, never fatal (`self-healing`).

**Defense division and mutual-exclusion semantics**: Defense 1 guarantees "anchor hijacked -> restored inside the kick injection window + alarmed" (restoring backward); Defense 2 guarantees "anchor points to a dead session -> auto re-tracking of the live session within the regular wake chain" (refreshing forward) - opposite directions, complementary into a loop. **The b2 refresh is explicitly disabled inside the kick revival path** (per the wake-kick comment "b2 self-heal disabled = anchor-hijack defense (hard requirement)"): if a b2 anchor refresh fires inside the kick window, Defense 1 restores it and handles it as a failure - this mutual exclusion is design intent, not a race defect.

---

## Group D - signal and state face

### D1 `watcher-signals.jsonl`

| 栏 | 内容 |
|---|---|
| **写方** | watcher 进程独占：watcher/degrade.mjs DegradeState#writeSignal（读入→追加→截半→整文件重写，SIGNALS_MAX_LINES=256 滚动截半）；仅 D1/D2/D3/kicked 四类事件写（record），成功交付（success/noop/accepted）不写=静默。**信号语义=「watcher 在岗/失能」状态面而非逐单回执面** |
| **读方** | 仅 bg-sentinel `watcherCoverage`（hooks/bg-sentinel/signals.mjs，**lazy 消费**：仅板面出现 C1 未签收终态条件才读；取最新有效条目按 at 判新，坏行跳过） |
| **字段** | 行 schema（§9.3 补全）：`at:ISO8601`／`cls:"D1"\|"D2"\|"D3"\|"kicked"`（D2=瞬时重试中仍在岗；D1/D3/kicked=终态 standby）／`mission:string\|null`／`reason:string`（redact 脱敏）。JSONL，无 schema 校验 |
| **失效语义** | watcher 未运行=文件缺失=无信号走既有兜底（`静默降级`，设计内）；读失败/坏行/无有效条目 → 不覆盖走兜底（`静默降级`，绝不因信号面故障哑火或误哑）；信号新鲜刻度 TTL（默认 10min，cfg watcher_signal_ttl_min）过期 → 兜底；C2 stall/C3 crash 为 watcher 事件中继盲区，哨兵无条件保留永不静默（§15 裁决） |

### D2 `glean-launch-state.json` [parked note: the gleaning auto-launch face described here (the writer/reader/field rows - the whole glean-launch.mjs module) moved to parked/agent-orchestrator/ with the -p channel; the file face is retired to historical semantics; the sentinel body and the other sentinel/ files stay zero-touch. The LM-05 anchor row was removed with the migration (recovery = the parked README guide + replanting the row)]

---

## Group E - dispatch congestion degradation face (server side)

### E1 `dispatch-congestion.json` [parked: moved to parked/agent-orchestrator/ with the -p channel; this section = historical-semantics archive]

The headless seeding congestion degradation stamp domain (written/read on both sides by mcp/tool-dispatch.mjs): a headless dispatch failure receipt hitting the congestion allowlist regex (`/1305|429|overloaded|rate.?limit/i`) with the seeding pair present writes the stamp `{providerId/modelId: untilMs}` (TTL 30min; lazily cleared on read; the preferred seeding pair stamped -> skip to the other-source candidate, all stamped -> keep the preferred + a `congestion_skipped_all` warning; no auto re-dispatch = the N-3 red line). Anchor list: `ORCH_DISPATCH_CONGESTION_TTL_MIN`/`ORCH_DISPATCH_CONGESTION_OFF`/`congestion_skipped[]`/`downgraded_to`/the assertion group crv6-resilience CG ten arms A-v0130-W5-CG-01..10 + DS-09 - the full details moved to parked with the -p channel (recovery = the parked/agent-orchestrator/README guide). **The server never creates the sentinel/ directory** (the §0 invariant, l0 V13): directory absent = the stamp write silently skips; atomic write.

---

## §5 Assertion anchor master table (with bare-zone notes)

| File | Assertion face (measured) | Bare-zone conclusion |
|---|---|---|
| instance-<k>.json | sentinel-teardown T1/T2/T5/T6/WS-9d (state three-way / on_duty / took_over / root / heartbeat); root-contract V6-56 root field; l0 V13 (missing sentinel/ -> available:false); the server sentinelHealth shape via WS-9d | **not bare** (the prev field has no direct assertion = residual note) |
| family-teardown.json | sentinel-teardown T3 (the T3d stamp updates with the last winner) | **not bare** |
| sentinel.cfg.json | sentinel-teardown T11 (A-v090-CLN-05 all-sparse shape + zero-drift comparison, in tests/assertions/v0.9.x.md §16); the crv5-auth CFG group interplay | **not bare** |
| fired/ | sentinel-teardown T2d/T5/T10 (filename protocol + counts + prefix filtering) | **bare (field level)**: the entry's 8 fields have zero JSON.parse assertions |
| quarantine.json | sentinel-teardown T8/WS-5 (reason / evidence.ticks / echo category counts) | **half-bare**: at/pid/slot and the seize-race semantics have no assertions |
| echo.jsonl | sentinel-teardown T1c/T2c/T6c/T8 (existence / category counts / line-count snapshots) | **half-bare**: field level + the 256-line rolling cap have no assertions |
| coord-session.txt | watcher-core (G14-b existing anchors zero-touch, C11 dual-branch refresh, the W2-02 shape gate); crv6-resilience DSP-08 (the server attribution value source); the bg-sentinel coordSessionId prefix gate via the watcher-core suite family's source-text lock (a static shape lock, not a behavioral assertion) | group C's main assertion face is in watcher-core/crv6 (**not bare**; the bg-sentinel consumer gate is a static lock = weak-coverage note) |
| coord-workspace.txt | watcher-core (the C11/G4/G5 guards, workspace-anchor-missing); the root-contract fixture face | **not bare** |
| watcher-signals.jsonl | watcher-core W-DGR-05 (the 256-line rolling cap) + WB-KICK-f1 (a kick transient failure lands nothing); sentinel-teardown T10 (the W6 consumer yields) | **not bare** |
| glean-launch-state.json | [parked] the glean-launch.mjs suite was retired to parked (the original running-state/takeover/cleanup assertion domain is gone; recovery = the parked README guide) | **not bare -> retired** |
| dispatch-congestion.json | [parked] the crv6-resilience CG ten arms (A-v0130-W5-CG-01..10) + dispatch-supply DS-09 retired to parked with the -p channel (the scenario file retired as an empty shell; recovery = the parked README guide) | **not bare -> retired** |

**Brittleness basis (the dual-axis top-tier qualification)**: bare txt/JSON with no schema validation x multi-writer wx races (group C's multi-writer = the anchor-hijack attack face) x cross-process clock death judgments (the HEARTBEAT_STALE_MS three-site twin constants, P5 twin-lock pins the literal 90000) x paired anchors with many writers and consumers x a resident until-type process (residual files survive across generations); compared with the root.txt card: this family has the broadest face but consequences mostly self-heal/degrade - root.txt is the most global.

**M9-1 interop note (landed)**: M9-1 landed scoping (group A's gap annotation rewritten per the current mechanism - the A1 warning block) + revival replenishment (trigger faces (1)(2)) + catch-up alarms (REV (3)) + the O10 interop; the assertion groups = A-v0120-SCP/REV (sentinel-teardown SCP/REV + the bggate REV group). The LM-05 card sync lock is registered (lint-manifest LM05_CARD_ANCHORS grep backstop).
