# Contract card: the bg-sentinel duty map (M7, the non-decomposition ruling on record)

> **Line-number declaration (card head)**: all line numbers in this document were measured at assembly time (section-comment grep). Line numbers are **not referenced across versions**; cross-version locating relies on section titles + function-name anchors (l-20261022-6a14d6).
>
> - **Home module**: M7 hooks (`hooks/bg-sentinel.mjs`, a single-file independent process)
> - **This card's nature**: **a duty map + ruling record** - not a per-file contract card (that is `card-sentinel.md`'s duty) and not a refactoring task book. For "what is this line/section doing" read this card; for "who writes/reads sentinel/ file X and how it fails" read card-sentinel.md
> - **Brittleness dual-axis rating**: surface breadth = top tier (a single file carrying the wake/alarm/watch/gleaning chains); consequence severity = medium (all self-owned persistence lives in sentinel/ and the board is absolutely read-only; most failures self-heal via family redundancy + takeover)

---

## 0. The G1 declaration (read this first, to prevent misreading)

**This card is a virtual-partition map, not a refactoring mandate.** The coordinator's final ruling G1: hub monoliths like server.mjs and bg-sentinel are **logically partitioned, never physically split** (isomorphic to the K-6 ruling "bg-sentinel is not physically decomposed"). Any "split files / extract modules by section" work based on this card's sections is out of bounds - file-set changes are mechanically caught by the l0 skeleton red line and the LM-04 structure lock (a file-set change is red). This card exists to **make the unsplit monolith navigable**.

## 1. The non-decomposition ruling (on record, three reasons)

Physical decomposition is **explicitly not done** for now, for three reasons (the DP2c duty-decomposition assessment's measured conclusions):

1. **The assertion face would re-pin wholesale**: the black-box suite sentinel-teardown (T1-T10 lifecycle assertions) treats the "single-file black box" as the tested object - a split means re-pinning every assertion; rebuilding the regression safety net costs far more than the benefit.
2. **The hook deployment-form constraint**: hook scripts = single-file self-contained independent processes. Splitting into modules requires a loader or build materialization - both break the hooks' direct deployment form.
3. **The state machine entangles across sections**: the lease wx guard files, slots, quarantine, fired, and cooldown stamps cross-reference into a network; any static cut line lands on a state-machine joint - low benefit, high risk.

**Physical splitting stays an observation item** (governed at the same rhythm as the G1 virtual partition): reconsider only when all three reasons fail one by one (assertion-face rework / deployment-form change / state-machine decoupling), via an explicit task book - opportunistic splitting is forbidden.

## 2. The duty-family map (section-measured anchors)

The section comments navigate themselves; the table below is the full "line anchor -> duty" map (on line-number drift, re-anchor by grep on section titles):

| 行锚 | 分节（分节注释标题） | 职责 | 关键函数/文件锚 |
|---|---|---|---|
| hooks/bg-sentinel/core.mjs `locateRoot` | root-id 契约校验定根 | 存储根定位（五脚本 verbatim twin，server 站 server 侧） | `locateRoot`/`rootIdOf`（root-contract 套件锁） |
| hooks/bg-sentinel/core.mjs `readBoardSafe` | board / wake-failure helpers | 板只读+唤醒失败判据；server 族（入口+模块族）& hooks verbatim twin | `readBoardSafe` 族（twin-lock 五文件矩阵） |
| hooks/bg-sentinel/signals.mjs | 信号模块 | rollout 心跳/tool_usage/双空闲链（主控活性判定） | 信号读取族 |
| hooks/bg-sentinel/signals.mjs `watcherCoverage` | watcher-signals 消费 | watcher 优先唤醒通道的在岗判定面（v0.8 W6 闭环） | `watcherCoverage` |
| hooks/bg-sentinel/family.mjs | 家族槽位 | 槽位 wx 认领/心跳/接管/释放/清理 | `claimSlot`/`touchSlot`/`releaseSlot`/`pruneStaleSlots` |
| hooks/bg-sentinel/family.mjs | 家族轮换选举 | 寿命 cap 单赢家，每寿命周期至多一条通知 | 轮换选举族 |
| hooks/bg-sentinel/family.mjs | 观测型隔离 | quarantine.json 标记+家族级告警抑制（V7-04 lite） | `claimQuarantine`/`readQuarantine` |
| hooks/bg-sentinel/fired.mjs | fired 协议 | 开枪仲裁（错峰防重+封顶+放弃终态） | `claimShots`/`firedEligible`/`pruneFired` |
| hooks/bg-sentinel/echo.mjs | 回声 | 三通道：本地 echo.jsonl+平台邮箱信封+OS toast 兜底 | `appendEcho`/`pruneEcho`/`ECHO_MAX_LINES` |
| hooks/bg-sentinel/wake-kick.mjs | 哨兵 drain | 完成即唤队列滞留消费（滞留两 tick 判定） | drain 族 |
| hooks/bg-sentinel/classify.mjs | 条件分类 classify | 板事件龄期条件分级，C3>C1>C2，每 mission 至多一条 | classify 族 |
| hooks/bg-sentinel/classify.mjs | 告警汇总 | 四类文案分组（含「疑似崩溃」「放弃通告」段） | 告警组族 |
| hooks/bg-sentinel/glean-launch.mjs＋`gleanStampFile`〔v1.6 W-p parked：随 -p 通道迁 parked/agent-orchestrator/，本行组=历史语义（归敛自动拉起/冷却戳长 24h 短 1h/在跑子进程状态文件 `sentinel/glean-launch-state.json`）；恢复=parked README 指引+行回植〕 | 归敛自动拉起族 | 门槛复刻+锁前置+headless 拉起（glean）+冷却戳+状态文件 | `writeGleanState`/`readGleanState`/`clearGleanState`/`gleanStampFile` |
| hooks/bg-sentinel/family.mjs | 租约 wx 守卫 | 「读-比-写」串行化，多实例家族只成一 | 租约守卫族 |
| hooks/bg-sentinel.mjs（入口主循环） | 主循环 | tick 编排（cfg 重读/槽位/分类/开枪/回声/自毁判定） | `main` |

**Duty-family count**: the table above doubles as the multi-family confirmation (families grow and shrink with evolution; the per-section comments are the authority; this card pins no family count - the count is ledger-only, never a gate).

**Per-file protocol contracts**: the writer/reader/field/failure-semantics faces of every own-write face behind the duties in this table (slot family / teardown / fired / echo / quarantine / anchor / signals / glean state / cooldown stamp) live **entirely in `card-sentinel.md`** - the two-card division of labor: this card navigates "row -> duty", card-sentinel owns "file -> contract".

## 3. The twin face (cross-file consistency obligations)

- **Three verbatim twins**: the root-id root location (core.mjs `locateRoot`) and the board/wake-failure helpers (core.mjs `readBoardSafe`) are verbatim same-text across the server family and multiple hook scripts - **changing any copy means changing all five in the same wave**; the behavior matrix is locked by the twin-lock suite (five files: server/session-start/stop-check/bg-sentinel/poller).
- **Different-name, same-value twins**: the heartbeat death threshold lives in this file, the server (SENTINEL_HEARTBEAT_STALE_MS), and bg-gate (HEARTBEAT_STALE_MS) - three sites, different names, same value; the VALUE_TWINS value lock pins each site (three definitions = the deadlock risk point, the P5 consistency lock's primary object).
- **fmtAge**: the fork point has been unified to the server variant's bare `min` form (behaviorally equivalent); new twin functions register in the twin-lock TWIN_SPEC declaration table.

## 4. Operating form (one-line navigation level)

- **Startup**: the only legitimate startup = the coordinator launching multiple instances of the same command as host background Bash tasks (the staggered-redundancy family, userConfig family size); when all slots are full and fresh, it exits silently yielding.
- **Death judgment and takeover**: a slot whose heartbeat age exceeds the threshold with a dead pid = a dead slot; the next-generation instance prunes + claims the takeover.
- **Firing and echo**: graded conditions drive the fired arbitration (de-conflict / cap / give-up), echo via three channels; when all clear, standby with zero notifications, and new in-flight work auto-revives it.
- **The board is absolutely read-only**: zero write face on the board (all self-owned persistence lives in sentinel/); the external-writer forbidden zones are in card-sentinel.md and card-state-machine.md.

## 5. Assertion anchors

- **sentinel-teardown** (black-box lifecycle, driven by accelerated parameters): the slot/takeover/fired/echo/teardown/standby/revival full chain - the primary black-box verification face for this card's §2 sections.
- **bggate** (the bg-gate contract): the sentinel-alive judgment / contract header / remind face.
- **twin-lock**: the five-file behavior matrix + the VALUE_TWINS value lock (this card's §3).
- **root-contract**: the root-locating contract (hooks/bg-sentinel/core.mjs `locateRoot`).
- **Function-name anchors (LM-05 candidate-row material)**: see the §2 table's last column (card-sentinel.md already covers most of them).

## 6. Maintenance rules

- **New duty**: a new section comment (`/* === */` open/close pair) + a §2 row in this card, same wave.
- **Line-number drift**: any edit that skews the line anchors may change only this card's line-number column (the section title + function-name anchors unchanged = not red); cross-version referencing defers to function names.
- **Reconsidering the split**: only via §1's observation-item gate with an explicit task book; the LM-04/l0 mechanical detection of file-set changes is the backstop gate, not a process substitute.
