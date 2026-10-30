# 契约卡：bg-sentinel 职责地图（M7，不分解裁定存证）

> **行号声明（卡头）**：本文行号系 **2026-10-28 总装时点实测**（分节注释 grep，worker v12-m71；bg-sentinel.mjs 恰 2517 行）。行号**不作跨版引用**；跨版定位以分节标题+函数名锚为准（l-20261022-6a14d6）。
>
> - **归属模块**：M7 hooks（`hooks/bg-sentinel.mjs`，单文件独立进程）
> - **本卡性质**：**职责地图＋裁定存证**——不是逐文件契约卡（那是 `card-sentinel.md` 的职责），也不是重构任务书。读者要「某行某节在干什么」读本卡；要「sentinel/ 某文件谁写谁读怎么失效」读 card-sentinel.md
> - **脆度双轴评级**：面广度=第一梯队（单文件承载唤醒/告警/盯守/归敛四链）；后果重度=中（自有落盘全在 sentinel/，board 绝对只读；失效多可由家族冗余+接管自愈）
> - **历史事故回链**：V7-04（板不可读误报三连枪→观测型隔离 lite）；MOD3a-QA（他会话误枪，M9 波 scoping 靶心）；DP2×3 隔夜无唤醒（宿主重启团灭无复活，M9 波存活轴靶心）

---

## 0. G1 声明（先读这个，防误读）

**本卡是虚拟分区地图，不是重构 mandate。**主控终裁 G1：server.mjs 与 bg-sentinel 这类枢纽巨石**逻辑分区、物理不拆**（与 K-6 裁定「bg-sentinel 不物理分解」同构）。任何以本卡分节为依据的「按节拆文件/抽模块」施工都是越界——文件集变化会被 l0 骨架红线与 LM-04 结构锁机械检出（文件集变化即红）。本卡的存在目的恰是：**让不拆的巨石可导航**，从而消除「因为读不懂所以想拆」的拆分动机。

## 1. 不分解裁定（2026-10-28 存证，三理由）

物理分解在当期**明确不做**，理由（DP2c 职责分解评估节实测结论，2026-10-27）：

1. **断言面全量重钉**：黑盒套件 sentinel-teardown（T1-T10 加速参数驱动的生命周期断言，超千行量级）以「单文件黑盒」为被测对象——拆分即全部断言重钉，回归安全网重建成本远超收益；
2. **hook 部署形态约束**：hook 脚本=独立进程单文件自包含（与 server.mjs 零依赖单文件同构约束）。拆模块必须引入加载器或构建物化，两者都破坏 hooks 的直接部署形态；
3. **状态机跨节纠缠**：租约 wx 守卫文件、槽位、quarantine、fired、冷却戳互相引用成网，静态切分线切在状态机关节上——拆分收益低、风险高。

**物理拆分列观察项**（与 G1 虚拟分区同治理节奏）：仅当上述三理由逐一失效（断言面改造/部署形态变化/状态机解耦）时重议，走任务书显式立项，禁止顺手拆。

## 2. 职责族地图（分节实测锚，2026-10-28）

分节注释自带导航；下表为「行锚→职责」全图（行号漂移时按分节标题 grep 重锚）：

| 行锚 | 分节（分节注释标题） | 职责 | 关键函数/文件锚 |
|---|---|---|---|
| L148 | root-id 契约校验定根 | 存储根定位（五脚本 verbatim twin，server 站 server 侧） | `locateRoot`/`rootIdOf`（root-contract 套件锁） |
| L267 | board / wake-failure helpers | 板只读+唤醒失败判据；server.mjs & hooks verbatim twin | `readBoardSafe` 族（twin-lock 五文件矩阵） |
| L363 | 信号模块 | rollout 心跳/tool_usage/双空闲链（主控活性判定） | 信号读取族 |
| L520 | watcher-signals 消费 | watcher 优先唤醒通道的在岗判定面（v0.8 W6 闭环） | `watcherCoverage` |
| L569 | 家族槽位 | 槽位 wx 认领/心跳/接管/释放/清理 | `claimSlot`/`touchSlot`/`releaseSlot`/`pruneStaleSlots` |
| L693 | 家族轮换选举 | 寿命 cap 单赢家，每寿命周期至多一条通知 | 轮换选举族 |
| L747 | 观测型隔离 | quarantine.json 标记+家族级告警抑制（V7-04 lite） | `claimQuarantine`/`readQuarantine` |
| L814 | fired 协议 | 开枪仲裁（错峰防重+封顶+放弃终态） | `claimShots`/`firedEligible`/`pruneFired` |
| L922 | 回声 | 三通道：本地 echo.jsonl+平台邮箱信封+OS toast 兜底 | `appendEcho`/`pruneEcho`/`ECHO_MAX_LINES` |
| L1059 | 哨兵 drain | 完成即唤队列滞留消费（滞留两 tick 判定） | drain 族 |
| L1130 | 条件分类 classify | 板事件龄期条件分级，C3>C1>C2，每 mission 至多一条 | classify 族 |
| L1240 | 告警汇总 | 四类文案分组（含「疑似崩溃」「放弃通告」段） | 告警组族 |
| L1311 | 归敛自动拉起 | 门槛复刻+锁前置+headless 拉起（glean） | `writeGleanState`/`readGleanState`/`clearGleanState` |
| L1460 | 冷却戳 | JSON 冷却戳（时刻+TTL+种类；长冷却 24h/短冷却 1h 两档，用户裁定） | `gleanStampFile` |
| L1536 | 租约 wx 守卫 | 「读-比-写」串行化，多实例家族只成一 | 租约守卫族 |
| L1702 | 在跑子进程状态文件 | `sentinel/glean-launch-state.json`（在飞 glean 子进程状态） | glean-launch-state 读写族 |
| L2195 | 主循环 | tick 编排（cfg 重读/槽位/分类/开枪/回声/自毁判定） | `main` |

**职责族计数**：上表即多族确认（DP1「多职责族」判断成立；族数随演进增减，以分节注释为准——本卡不钉族数，计数恒为台账非门禁）。

**逐文件协议契约**：本表全部职责的自有落盘（槽位族/teardown/fired/echo/quarantine/锚/信号/归敛状态/冷却戳）的写方/读方/字段/失效语义，**全部在 `card-sentinel.md`**——两卡分工：本卡管「行→职责」导航，card-sentinel 管「文件→契约」。

## 3. twin 面（跨文件一致性义务）

- **verbatim twin 三处**：root-id 定根（L148）与 board/wake-failure helpers（L267）系 server.mjs 与 hooks 多脚本 verbatim 同文——**改任一副本必须五处同波改**，行为矩阵由 twin-lock 套件锁定（五文件：server/session-start/stop-check/bg-sentinel/poller）。
- **异名值 twin**：心跳判死阈值在本文件、server（SENTINEL_HEARTBEAT_STALE_MS）、bg-gate（HEARTBEAT_STALE_MS）三处异名同值——VALUE_TWINS 值锁逐 site 锁定（三处定义=死锁风险点，P5 一致性锁首要对象）。
- **fmtAge**：分叉点已统一到 server 版裸 `min` 形态（行为等价，W0 速赢落定）；后续新增 twin 函数走 twin-lock TWIN_SPEC 声明表登记。

## 4. 运行形态（导航用一句话级）

- **启动**：唯一合法启动方式=主控以宿主后台 Bash 任务运行同命令连发多实例（错峰冗余家族，userConfig 家族规模）；全满全 fresh 静默让位退出。
- **判死与接管**：槽位心跳龄超阈值且 pid 死=死槽，下一代实例 prune+认领接管。
- **开枪与回声**：条件分级驱动 fired 仲裁（防重/封顶/放弃），回声三通道，全清 standby 零通知、新在飞自动复活。
- **board 绝对只读**：对本板零写面（自有落盘全在 sentinel/），外部写者禁区见 card-sentinel.md 与 card-state-machine.md。

## 5. 断言锚

- **sentinel-teardown**（黑盒生命周期，T1-T10 加速参数驱动）：槽位/接管/fired/回声/teardown/standby/复活全链——本卡 §2 各节的黑盒验证主面。
- **bggate**（bg-gate 契约）：哨兵在岗判定/契约头/remind 面（M4-1 GATE 组落此）。
- **twin-lock**：五文件行为矩阵+VALUE_TWINS 值锁（本卡 §3）。
- **root-contract**：L148 定根契约。
- **函数名锚（LM-05 候选行素材）**：见 §2 表末列（均 bg-sentinel.mjs，2026-10-28 grep 实证可见；card-sentinel.md 已在册覆盖大半）。

## 6. 维护规则

- **新增职责**：新分节注释（`/* === */` 头尾对）＋本卡 §2 补行，同波落。
- **行号漂移**：任何编辑使行锚失真，允许只改本卡行号列（分节标题+函数名锚不变即不红）；跨版引用以函数名为准。
- **重议拆分**：仅按 §1 观察项门走显式立项；LM-04/l0 对文件集变化机械检出是兜底闸，不是流程替代。
- 与 M9 波（哨兵可靠性强化：scoping/存活复活）的关系：M9 落本文件域的施工由其任务书承载；M9 落地后本卡 §2 表与 card-sentinel.md 同波修订（scoping 相关分节职责面会扩）。
