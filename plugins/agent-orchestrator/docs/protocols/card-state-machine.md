# 契约卡：M1 mission 状态机（ALLOWED_TRANSITIONS）

- **归属模块**：mcp/server.mjs（board 写路径的迁移门 + 各内部写点）；配套字段/merge 语义见 `card-board.md`（卡⑤）
- **脆度评级**（面广度×后果重度双轴）：**后果重度=第一梯队**——crv6-statemachine 厚锁面（代码冻结，改动高危）；白名单写错一条腿=要么死锁（腿缺失）要么假归档/双跑（腿放水）。面广度中等（单文件单表）
- **历史事故回链**：l-20261019-d38f65（外部 upsert 直写 running 被拒——只有负面清单没有正面矩阵的踩坑根源）、l-20261023-576af5（upsert 缺 mission.id 误新建）、V6-11/V6-20/V6-21/V6-28 设计裁定（W-A1 §1 表文逐条）
- **锚点声明**：本卡行号系总装时点（v1.1.2 源码）实测，**不作跨版引用**（l-20261022-6a14d6）；函数名/常量名双锚为定位权威。实测基线：`ALLOWED_TRANSITIONS` server.mjs:2015-2027、守卫 `upsertMission`:2046-2143、`sweepGraph`:2166-2298

---

## 1. 状态全集（STATUSES）

`STATUSES`（server.mjs:116-128）11 态，`board upsert` 对 status 做枚举校验（非法值直接 ToolError，:3885-3889）：

```
drafted, dispatched, ready, running, blocked, question, done, failed, skipped, resumed, closed
```

语义速览：

| 状态 | 语义 | 谁通常放进去 |
|---|---|---|
| drafted | 已登记未派发/未解锁 | board upsert（新建默认态） |
| dispatched | 已派发待开工 | dispatch 登记（internal）、外部 upsert |
| ready | blockedBy 全绿可领取 | sweepGraph unlock、answer、外部 upsert |
| running | 已被 claim 在飞 | board claim（唯一合法生产者） |
| blocked | worker 上报受阻 | report(kind=blocked) |
| question | worker 上报提问 | report(kind=question) |
| done | 完成终态 | report(kind=done) |
| failed | 失败终态 | 外部 upsert（主控裁定；**无 report kind 对应**——report 四 kind=milestone/blocked/question/done） |
| skipped | 跳过终态 | sweepGraph cascade（upstream_failed）或外部 upsert |
| resumed | **枚举在册、当前零生产写者**（历史形态；白名单保留离开腿 resumed→dispatched） | 无 |
| closed | 归档终态 | 外部 upsert（close_confirmed）、sandbox_apply 直改 |

## 2. ALLOWED_TRANSITIONS 全表（对拍锚）

源码原文（server.mjs:2015-2027，逐字节对拍基线——M1-3 contract-sync 从源码抽取本表与卡对拍）：

```js
const ALLOWED_TRANSITIONS = {
  drafted: { dispatched: {}, skipped: {} },
  dispatched: { drafted: {}, ready: {}, closed: {} },
  ready: { dispatched: {}, skipped: {}, closed: {} },
  running: { done: {}, blocked: {}, question: {}, failed: {}, dispatched: {} },
  blocked: { dispatched: {}, ready: {}, closed: {} },
  question: { dispatched: {}, ready: {}, closed: {} },
  done: { closed: {} },
  failed: { closed: {}, drafted: { reopen: true } },
  skipped: { closed: {}, drafted: { reopen: true } },
  resumed: { dispatched: {} },
  closed: {}, // 无离开路径（重开=新建 mission）
};
```

人读矩阵（列=to；空格=禁止；**本表是外部 upsert 可请求的腿**，内部写者经 `opts.internal` 绕表——见 §4）：

| from \ to | drafted | dispatched | ready | running | done | blocked | question | failed | skipped | closed |
|---|---|---|---|---|---|---|---|---|---|---|
| drafted | — | ✓ | | | | | | | ✓ | ✗禁 |
| dispatched | ✓ | | ✓ | | | | | | | ✓¹ |
| ready | | ✓ | | | | | | | ✓ | ✓¹ |
| running | | ✓ | | | ✓ | ✓ | ✓ | ✓ | | |
| blocked | | ✓ | ✓ | | | | | | | ✓¹ |
| question | | ✓ | ✓ | | | | | | | ✓¹ |
| done | | | | | | | | | | ✓ |
| failed | ✓² | | | | | | | | | ✓ |
| skipped | ✓² | | | | | | | | | ✓ |
| resumed | | ✓ | | | | | | | | |
| closed | （无离开路径；重开=新建 mission） | | | | | | | | | |

**全局守卫注记**（对每腿适用）：

- **✗禁**：`drafted→closed` 直达禁止（V6-11 门 B half 1，:2070-2074）——未派发即归档是假归档，先 `dispatched` 再 `closed`，或走删除/废弃语义。
- **✓¹**：任何 →`closed` 的外部请求需 `close_confirmed:true` 一次性确认（V6-11 门 B half 2，:2089-2093）；确认键是 transient 键，消费后不落盘。
- **✓²**：终态复活腿（failed/skipped→drafted）需 `reopen:true` + `note` 写明原因（SM-04，:2097-2105），通过后追加 `reopen` timeline 事件；`reopen`/`note`/`close_confirmed` 三者均为 transient 门键（upsert 入口剥除，:3872-3884）。
- **违规 hint 三分支**（:2077-2082）：from=closed →「closed 无离开路径：重开请新建 mission」；from∈{done,failed,skipped} →「终态复活腿仅 failed/skipped → drafted（需 reopen:true+note）；归档走 closed」；其余 →「→running 仅 board claim 可达；在飞回收/解锁由 sweep 内部执行」。
- **拒绝先于变更**（SM-03）：迁移门在任何板写之前 throw（:2062-2065），被拒的 upsert 让 board 保持字节不变。

**内部专属腿刻意缺席于白名单**（:2005-2008 注释原文语义）：`*→running`（claim 专属）、`drafted→ready`（sweep unlock 专属）、`running→ready`（sweep 租约回收专属）——这些腿的唯一写者绕过门，白名单不收。

## 3. 每腿×内部写者正面矩阵（O3 裁定=含）

> l-20261019-d38f65 类踩坑的根源就是只有负面印象没有正面矩阵。内部写者经 `opts.internal:true` 绕过 §2 白名单（:2061 注释：sweep/claim/report/answer/sandbox_apply 各写点是白名单设计里的合法内部写者），但**各写点自身的准入前置**如下表——演进者先查本表再动键盘。

| 内部写点 | 机制 | 实际产生的腿 | 准入前置（各自的"门"） | 锚点 |
|---|---|---|---|---|
| **sweepGraph**（依赖图扫荡，随每次板写同临界区跑，无独立调用方） | 直改 mission 对象 | drafted→ready（unlock）；drafted/ready→skipped（cascade，skippedReason=upstream_failed）；running→ready、dispatched→ready（租约回收，owner/claim 清空）；blocked/question **保状态**仅清 owner/claim；终态（done/failed/skipped/closed）豁免回收；dangling blockedBy 两次写事务后清理 | unlock 需 blockedBy 全绿且上游 depSatisfied（closed 上游须有绿档凭证 qa.verdict=pass ∨ sandbox.applied_at，V6-11 门 A）；cascade 需上游 failed/skipped；回收需租约到期（畸形 leaseUntil 走 claimedAt+4×lease 或 24h updated_at 硬帽兜底，V6-28，事件 lease_invalid ≠ lease_expired） | :2166-2298；回收 :2192-2235；cascade :2266-2283；unlock :2284-2294 |
| **board claim**（action=claim） | 直改（不走 upsertMission、不走白名单） | drafted→running；ready→running | CAS：owner===null 且 status∈{drafted,ready} 且 blockedBy 全绿；成功写 claim{worker,token,claimedAt,leaseUntil} 并 **V6-14 token 必换发**（旧 token 即刻作废）；默认租约 30min（--claim-lease-min 可调） | :4090-4159（翻 running :4135，换发 :4128-4131） |
| **report**（toolReport） | upsertMission(opts.internal=true) 绕表 | *→done（kind=done；from=drafted 直收 done 保留 W-A1 警告）；*→blocked / *→question（kind 对应；同时整对象重写 mission.blocked 并清 stale ack，C1） | token fail-closed（dispatch.token 存在则必携且精确匹配，V6-09，:4443-4470，拒绝发生在落箱之前=零事件）；成对鉴权 claim.worker===worker（不匹配=事件落箱+板零改动+不续租，:4516-4534）；mission closed 则事件落箱板不动（C5，:4495-4507）；附带：milestone/done 走 files_touched scope 审计（基线=mission.scope_paths）、done 走 artifacts append-only 回写+manifest close-out+headless 完成即唤队列（dispatch.mode==="headless"，:4643） | :4438-4645（upsert 调用 :4626-4635） |
| **report 续租**（renewClaim，report 附带效果） | upsertMission opts.renewClaim 写 claim.leaseUntil | 无状态腿（租约字段写） | 仅 claim.worker===worker 续（V6-17 成对续租，:4607-4620）；p2p 事件**不续租**（V6-17 不稀释） | :2138-2140 |
| **mailbox answer**（blocked/question 应答） | upsertMission(opts.internal=true, opts.ack) | blocked→dispatched（owner 在场）；blocked→ready（owner 已被回收）；question→dispatched / question→ready 同理 | C3：仅 blocked/question 可翻状态，终态 answer 回 isError；自动 ack {by:"answer"}（:5056） | :5040-5057 |
| **dispatch 登记**（toolDispatch，board-first） | upsertMission(opts.internal=true) | drafted→dispatched（status 缺省或 drafted 时写 dispatched） | 派发路径自身（token 铸造在 context_pack；本写点把 mode=headless+spawned_by_session 归因写入 dispatch 子键） | :7165-7177 |
| **dispatch 回填**（spawn 后 session_id 补写） | upsertMission(opts.internal=true) | 无状态腿（dispatch.session_id 写） | best-effort，失败不阻塞（runner result index 仍可映射） | :7299-7301 |
| **sandbox_apply**（gated merge-back） | 直改（不走 upsertMission） | （done）→closed；crash 恢复补偿分支 applied_at 存在且 status≠closed → closed | done + qa.verdict=pass + 主仓干净 + merge-tree 预检过门后落锁直改；auto-ack {by:"sandbox_apply"}；写 pack.sandbox.applied_at/applied_commit | 主路 :7635；补偿 :7416-7418 |
| **context_pack 登记 / sandbox:create**（pack 侧写点） | 外部形态 upsert（无 internal 标志） | **零状态腿**（只写 title/scope_paths/pack/timeline；from===merged.status 不触发迁移门） | 循环门（detectCycle）+scope 冲突预检（CR-05）+重复 mission 预检（P9），均先于板写 | :1645-1653；:6350+ |

读法示例：想把 mission 弄成 running，唯一写点=board claim（第 2 行）；想让 blocked mission 回到可领取，写点=answer（owner 缺席时→ready）或 sweep 租约回收，外部 upsert 走白名单腿 blocked→ready 亦可。

## 4. 外部写者禁区三条（error-fix 教训的文档化收口）

> 权威=本卡+源码；口口相传到此为止。教训回链：l-20261019-d38f65、l-20261023-576af5。

1. **`→running` 仅 board claim 可达**。租约语义归 claim：leaseUntil 由 report 续期、超时由 sweep 回收。外部 upsert 直写 running 必被拒（hint 原文：→running 仅 board claim 可达；在飞回收/解锁由 sweep 内部执行，:2082）。需要 running 语义时用 board(claim)——注意 V6-14 会换发 token，新 token 须转告 worker。
2. **drafted→running 对外部写者整体关闭**：主控登记派发一律 `status:"dispatched"`（dispatch 工具内部写点同此，:7168）；worker 首个 report 经 opts.internal 旁路自行演进状态。**禁止**用外部 upsert 把 drafted 顶成 running（l-20261019-d38f65 正身）。
3. **upsert 定位键是 mission.id 字段**：更新既有 mission 必须在 mission 对象内带 `id`；顶层 mission_id 参数仅供 get/list/ack 等动作用，upsert 缺 `mission.id` 一律新建（l-20261023-576af5 正身，:2048 定位逻辑）。

**附则（禁区的外延）**：

- opts.internal 旁路白名单=内部写者全集（§3 表 9 个写点；跨迁移时 ack 强制清空 SM-05 :2119，blocked/question 新报告清旧 ack C1 :2124-2126，close 自动 ack :2121-2123）。外部调用者没有也不该有 internal 通道。
- 每次板写=同临界区 sweepGraph（unlock/cascade skip/租约回收/dangling 清理，:2133-2136）——外部写者无需也**不应**自行解锁下游，写完状态即完事。
- 新建 mission 的 status 进门约定：外部 upsert 新建时 from 按 "drafted" 起（:2066），所以新建即写 closed/done 等一律按白名单腿判——`drafted→closed` 直接 ✗禁。

## 5. 与 merge 语义的接口（状态如何进板）

状态字段经 `mergeMission`（:2029-2044）进板，周边契约（细节归卡⑤）：

- `status` ∈ MERGEABLE_KEYS（白名单 18 键，:1967-1993）；白名单外键被丢弃并在响应 ignoredPatchKeys/ignored_keys 上报，不落盘（:1996-1998）。
- `id` 永不合并（:2032 continue）——定位键兼不可变键。
- 读侧 owned 键 `ack`/`owner`/`claim`/`manifest` 在 upsert 入口剥除（:3875-3884）：ack 归 ack action/自动规则，owner/claim 归 claim/report/sweep，manifest 唯一合法写者=report close-out。
- 跨迁移清 ack：`prevStatus !== merged.status` → `merged.ack = null`（SM-05，:2119）——旧签收不得漂白迁移后的状态。

## 6. 失效语义（状态机视角）

| 情形 | 行为 | 分类 |
|---|---|---|
| 白名单外腿请求 | ToolError+hint 三分支，board 字节不变（SM-03） | fail-loud |
| drafted→closed 直达 | ToolError 专属文案（:2070-2074） | fail-loud |
| close 缺 close_confirmed | ToolError（:2089-2093） | fail-loud |
| 终态复活缺 reopen/note | ToolError（:2097-2105） | fail-loud |
| 非法 status 枚举值 | ToolError（:3885-3889） | fail-loud |
| 租约畸形（leaseUntil 不可解析） | 不永久卡死：claimedAt+4×lease → 24h updated_at 硬帽兜底回收，事件 lease_invalid（V6-28，:2186-2235） | 自愈 |
| 内部写者绕表滥用（理论面） | 准入前置各自把门（token/成对鉴权/绿档/qa verdict）；绕表本身无第二道表锁——新增内部写点必须先入 §3 矩阵并补 crv6 断言 | 防波堤约定 |

## 7. 断言锚

- **crv6-statemachine**（tests/suites/crv6-statemachine.mjs，主锁）：A-v060-SM-01/02（closed 双门：采信侧 isGreenClosed=qa.verdict==="pass" ∨ pack.sandbox.applied_at；写入侧 close_confirmed+drafted 禁直达+sandbox_apply 直改不受限）；SM-03/04/05（白名单矩阵回归、reopen:true+note、跨迁移清 ack、→running 仅 claim、opts.internal 旁路）；SM-06/07（租约回收扩容+终态豁免；running/dispatched→ready、blocked/question 保状态；answer 对 owner=null 翻 ready）；SM-08（closed 拒改板 report 机读语义）；A-v070-P2P-01..06（p2p 边界/失效/前置态/活性）。
- **crv5-auth**（tests/suites/crv5-auth.mjs）：A-v060-AUTH-01..08——fail-closed token 门、成对鉴权、claim 必换发（V6-14）。
- **crv6-resilience / crv1-scope / crv2-pack**：派发链路、scope 审计、组包对拍面（板写外围）。
- **M1-3 对拍（本卡的设计消费方）**：contract-sync.mjs 从 server.mjs 抽取 §2 源码表体与本卡对拍（卡≈码，漂移即红）；lint-manifest LM-05=卡内常量名（ALLOWED_TRANSITIONS/MERGEABLE_KEYS/ONE_LEVEL）在 server.mjs grep 可见+卡存在非空。

## 8. 维护规则（本卡的写方）

- 本卡唯一写方=协议卡批 mission（W1-M1-2 首写；后续状态机改动波次随改）。**代码先改卡后改或卡先改码后改均须同 mission 内闭环**，M1-3 对拍红=两源漂移信号。
- 新增内部写点（新 opts.internal 调用方）时：§3 矩阵加行 + crv6-statemachine 补断言 + 本卡锚点重测，三件套缺一即失真。
- `resumed` 态处置：白名单保留离开腿（resumed→dispatched）但无生产写者——若未来启用，先补 §1 表"谁通常放进去"列与断言，不得静默复活。
