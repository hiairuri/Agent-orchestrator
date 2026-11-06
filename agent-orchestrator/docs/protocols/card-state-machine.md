# Contract card: the M1 mission state machine (ALLOWED_TRANSITIONS)

- **Home module**: mcp/server-board.mjs (the transition gate on the board write path + the internal write points); companion field/merge semantics live in `card-board.md`
- **Brittleness rating** (surface-breadth x consequence-severity dual axis): **consequence severity = top tier** - a thick crv6-statemachine lock face (code frozen, changes high-risk); one wrong whitelist leg = either deadlock (missing leg) or fake-archive/double-run (leg leak). Surface breadth medium (single file, single table)
- **Anchor declaration**: all line numbers in this card were measured at assembly time (v1.1.2 source); **line numbers are not referenced across versions** (l-20261022-6a14d6); function/constant-name dual anchors are the locating authority. Measured baseline: `ALLOWED_TRANSITIONS` (mcp/server-board.mjs), guard `upsertMission` (mcp/server-board.mjs), `sweepGraph` (mcp/server-board.mjs)

---

## 1. 状态全集（STATUSES）

`STATUSES`（mcp/server-core.mjs）11 态，`board upsert` 对 status 做枚举校验（非法值直接 ToolError，mcp/tool-board.mjs 枚举门）：

```
drafted, dispatched, ready, running, blocked, question, done, failed, skipped, resumed, closed
```

Semantics at a glance:

| 状态 | 语义 | 谁通常放进去 |
|---|---|---|
| drafted | 已登记未派发/未解锁 | board upsert（新建默认态） |
| dispatched | 已派发待开工 | dispatch 登记（internal）、外部 upsert、ready 直派（v1.3 WG G-a 闸收 ready：dispatch 直派与 claim 领取双消费通道并存，O13-a） |
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

Source excerpt (mcp/server-board.mjs `ALLOWED_TRANSITIONS`, the byte-exact comparison baseline - M1-3 contract-sync extracts this table from the source and compares it against the card):

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

Human-readable matrix (columns = to; blank = forbidden; **this table = the legs external upsert may request**; internal writers bypass the table via `opts.internal` - see §4):

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

**Global guard notes** (apply to every leg):

- **✗禁**：`drafted→closed` 直达禁止（V6-11 门 B half 1，mcp/server-board.mjs `upsertMission`）——未派发即归档是假归档，先 `dispatched` 再 `closed`，或走删除/废弃语义。
- **✓¹**：任何 →`closed` 的外部请求需 `close_confirmed:true` 一次性确认（V6-11 门 B half 2，mcp/server-board.mjs `upsertMission`）；确认键是 transient 键，消费后不落盘。
- **✓²**：终态复活腿（failed/skipped→drafted）需 `reopen:true` + `note` 写明原因（SM-04，mcp/server-board.mjs `upsertMission` 复活腿），通过后追加 `reopen` timeline 事件；`reopen`/`note`/`close_confirmed` 三者均为 transient 门键（upsert 入口剥除，mcp/tool-board.mjs board upsert）。
- **违规 hint 三分支**（mcp/server-board.mjs `upsertMission`）：from=closed →「closed 无离开路径：重开请新建 mission」；终态复活越腿 →「仅 failed/skipped → drafted（需 reopen:true+note）」；其余 →「→running 仅 board claim 可达」（要点=§4 禁区三条）。
- **拒绝先于变更**（SM-03）：迁移门在任何板写之前 throw（mcp/server-board.mjs `upsertMission`），被拒的 upsert 让 board 保持字节不变。

**内部专属腿刻意缺席于白名单**（mcp/server-board.mjs `ALLOWED_TRANSITIONS` 头注原文语义）：`*→running`（claim 专属）、`drafted→ready`（sweep unlock 专属）、`running→ready`（sweep 租约回收专属）——这些腿的唯一写者绕过门，白名单不收。

## 3. The per-leg × internal-writer positive matrix (O3 ruling = included)

> l-20261019-d38f65 类踩坑的根源就是只有负面清单没有正面矩阵。内部写者经 `opts.internal:true` 绕过 §2 白名单（mcp/server-board.mjs `upsertMission` 注释：sweep/claim/report/answer/sandbox_apply 各写点是白名单设计里的合法内部写者），但**各写点自身的准入前置**如下表——演进者先查本表。

| 内部写点 | 机制 | 实际产生的腿 | 准入前置（各自的"门"） | 锚点 |
|---|---|---|---|---|
| **sweepGraph**（依赖图扫荡，随每次板写同临界区跑，无独立调用方） | 直改 mission 对象 | drafted→ready（unlock）；drafted/ready→skipped（cascade，skippedReason=upstream_failed）；running→ready、dispatched→ready（租约回收，owner/claim 清空）；blocked/question **保状态**仅清 owner/claim；终态（done/failed/skipped/closed）豁免回收；dangling blockedBy 两次写事务后清理 | unlock 需 blockedBy 全绿且上游 depSatisfied（closed 上游须有绿档凭证 qa.verdict=pass ∨ sandbox.applied_at，V6-11 门 A）；cascade 需上游 failed/skipped；回收需租约到期（畸形 leaseUntil 走 claimedAt+4×lease 或 24h updated_at 硬帽兜底，V6-28，事件 lease_invalid ≠ lease_expired） | mcp/server-board.mjs `sweepGraph`（回收/cascade/unlock 段） |
| **board claim**（action=claim） | 直改（不走 upsertMission、不走白名单） | drafted→running；ready→running | CAS：owner===null 且 status∈{drafted,ready} 且 blockedBy 全绿；成功写 claim{worker,token,claimedAt,leaseUntil} 并 **V6-14 token 必换发**（旧 token 即刻作废）；默认租约 30min（--claim-lease-min 可调） | mcp/tool-board.mjs board claim（翻 running/V6-14 换发段） |
| **report**（toolReport） | upsertMission(opts.internal=true) 绕表 | *→done（kind=done；from=drafted 直收 done 保留 W-A1 警告）；*→blocked / *→question（kind 对应；同时整对象重写 mission.blocked 并清 stale ack，C1） | token fail-closed（dispatch.token 存在则必携且精确匹配，V6-09，mcp/tool-report.mjs token 门，拒绝发生在落箱之前=零事件）；成对鉴权 claim.worker===worker（不匹配=事件落箱+板零改动+不续租，mcp/tool-report.mjs）；mission closed 则事件落箱板不动（C5，mcp/tool-report.mjs）；附带面（scope 审计/artifacts append-only 回写+manifest close-out/完成即唤）字段细则归卡⑤ §4 表 | mcp/tool-report.mjs toolReport（upsert 调用段） |
| **report 续租**（renewClaim，report 附带效果） | upsertMission opts.renewClaim 写 claim.leaseUntil | 无状态腿（租约字段写） | 仅 claim.worker===worker 续（V6-17 成对续租，mcp/tool-report.mjs）；p2p 事件**不续租**（V6-17 不稀释） | mcp/server-board.mjs `upsertMission` 续租段 |
| **mailbox answer**（blocked/question 应答） | upsertMission(opts.internal=true, opts.ack) | blocked→dispatched（owner 在场）；blocked→ready（owner 已被回收）；question→dispatched / question→ready 同理 | C3：仅 blocked/question 可翻状态，终态 answer 回 isError；自动 ack {by:"answer"}（mcp/tool-mailbox.mjs answer） | mcp/tool-mailbox.mjs mailbox answer |
| **dispatch 登记**（toolDispatch，board-first） | upsertMission(opts.internal=true) | drafted→dispatched（status 缺省或 drafted 时写 dispatched） | 派发路径自身（token 铸造在 context_pack；本写点把 mode=headless+spawned_by_session 归因写入 dispatch 子键） | mcp/tool-dispatch.mjs toolDispatch 登记 |
| **dispatch 回填**（spawn 后 session_id 补写） | upsertMission(opts.internal=true) | 无状态腿（dispatch.session_id 写） | best-effort，失败不阻塞（runner result index 仍可映射） | mcp/tool-dispatch.mjs session_id 补写 |
| **sandbox_apply**（gated merge-back） | 直改（不走 upsertMission） | （done）→closed；crash 恢复补偿分支 applied_at 存在且 status≠closed → closed | done + qa.verdict=pass + 主仓干净 + merge-tree 预检过门后落锁直改；auto-ack {by:"sandbox_apply"}；写 pack.sandbox.applied_at/applied_commit | mcp/tool-sandbox.mjs `toolSandboxApply`（主路/补偿分支） |
| **context_pack 登记 / sandbox:create**（pack 侧写点） | 外部形态 upsert（无 internal 标志） | **零状态腿**（只写 title/scope_paths/pack/timeline；from===merged.status 不触发迁移门） | 循环门（`detectCycle`）+scope 冲突预检（CR-05）+重复 mission 预检（P9），均先于板写 | mcp/tool-pack.mjs |

Reading example: to get a mission to running, the only write point = board claim (row 2); to return a blocked mission to claimable, the write points = answer (owner absent -> ready) or the sweep lease reclaim, and external upsert via the whitelist leg blocked->ready also works.

## 4. Three external-writer forbidden zones (the documented close-out of error-fix lessons)

> Authority = this card + source.

1. **`->running` is reachable only via board claim**. Lease semantics belong to claim: leaseUntil is renewed by report, reclaimed by sweep on timeout. An external upsert writing running directly is always rejected (hint = the §2 three branches, mcp/server-board.mjs `upsertMission`). When you need running semantics, use board(claim) - note V6-14 rotates the token; the new token must be relayed to the worker.
2. **drafted->running is closed to external writers entirely**: the coordinator registers dispatches with `status:"dispatched"` (the dispatch tool's internal write point does the same, mcp/tool-dispatch.mjs); the worker's first report evolves the state itself via the opts.internal bypass. **Never** push drafted to running with an external upsert.
3. **The upsert locating key is the mission.id field**: updating an existing mission requires `id` inside the mission object; the top-level mission_id parameter serves get/list/ack actions only - an upsert without `mission.id` always creates new (mcp/server-board.mjs `upsertMission` locating logic).

**Addendum (extensions of the forbidden zones)**:

- The opts.internal bypass allowlist = the full internal-writer set (§3 table, 9 write points; ack forcibly cleared on cross-transition SM-05, a new blocked/question report clears the stale ack C1, close auto-acks - all in mcp/server-board.mjs `upsertMission`). External callers have - and should have - no internal channel.
- Every board write = a sweepGraph in the same critical section (unlock/cascade skip/lease reclaim/dangling cleanup, mcp/server-board.mjs `sweepGraph`) - external writers need not, and **must not**, unlock downstream themselves; writing the state is the whole job.
- 新建 mission 的 status 进门约定：外部 upsert 新建时 from 按 "drafted" 起（mcp/server-board.mjs `upsertMission`），所以新建即写 closed/done 等一律按白名单腿判——`drafted→closed` 直接 ✗禁。

## 5. Interface with merge semantics (how status enters the board)

The status field enters the board via `mergeMission` (mcp/server-board.mjs); the merge-mechanism authority = the card-board §2 field table (cross-referenced, not merged). This section pins only the four status-related points:

- `status` ∈ `MERGEABLE_KEYS` (allowlist of 18 keys); keys outside the allowlist are dropped and reported via ignoredPatchKeys without landing.
- `id` is never merged - the locating key doubles as an immutable key.
- Read-side owned keys `ack`/`owner`/`claim`/`manifest` are stripped at the upsert entrance (mcp/tool-board.mjs) - ownership details in card-board §2.
- Cross-transition ack clearing: `prevStatus !== merged.status` -> `merged.ack = null` (SM-05) - a stale ack must not whitewash the post-transition state.

## 6. Failure semantics (state-machine view)

| 情形 | 行为 | 分类 |
|---|---|---|
| 白名单外腿请求 | ToolError+hint 三分支，board 字节不变（SM-03） | fail-loud |
| drafted→closed 直达 | ToolError 专属文案（mcp/server-board.mjs `upsertMission`） | fail-loud |
| close 缺 close_confirmed | ToolError（mcp/server-board.mjs `upsertMission`） | fail-loud |
| 终态复活缺 reopen/note | ToolError（mcp/server-board.mjs `upsertMission`） | fail-loud |
| 非法 status 枚举值 | ToolError（mcp/tool-board.mjs 枚举门） | fail-loud |
| 租约畸形（leaseUntil 不可解析） | 不永久卡死：claimedAt+4×lease → 24h updated_at 硬帽兜底回收，事件 lease_invalid（V6-28，mcp/server-board.mjs `sweepGraph` 回收） | 自愈 |
| 内部写者绕表滥用（理论面） | 准入前置各自把门（token/成对鉴权/绿档/qa verdict）；绕表本身无第二道表锁——新增内部写点必须先入 §3 矩阵并补 crv6 断言 | 防波堤约定 |

## 7. Assertion anchors

- **crv6-statemachine** (tests/suites/crv6-statemachine.mjs, primary lock): A-v060-SM-01/02 (the closed dual gates: acceptance side isGreenClosed=qa.verdict==="pass" OR pack.sandbox.applied_at; write side close_confirmed + drafted no-direct-path + sandbox_apply direct-write unrestricted); SM-03/04/05 (whitelist matrix regression, reopen:true+note, cross-transition ack clearing, ->running claim-only, opts.internal bypass); SM-06/07 (lease-reclaim extensions + terminal-state exemption; running/dispatched->ready, blocked/question state-preserving; answer flips owner=null to ready); SM-08 (closed rejects board-mutating reports, machine-readable semantics); A-v070-P2P-01..06 (p2p boundaries/invalidation/preconditions/liveness).
- **crv5-auth** (tests/suites/crv5-auth.mjs): A-v060-AUTH-01..08 - fail-closed token gate, paired authentication, claim must rotate the token (V6-14).
- **crv6-resilience / crv1-scope / crv2-pack**: the dispatch chain, scope audit, and pack-materialization comparison faces (periphery of board writes).
- **M1-3 comparison (this card's design consumer)**: contract-sync.mjs extracts the §2 source table body via module-family source concatenation (server.mjs entry + the mcp/ set, familySource) and compares it against this card (card ~= code; drift is red); lint-manifest LM-05 = this card's constant names (ALLOWED_TRANSITIONS/MERGEABLE_KEYS/ONE_LEVEL) visible in the server-board/server-core module families + the card exists and is non-empty.

## 8. Maintenance rules (who writes this card)

- This card's only writer = the protocol-card batch mission (first written in W1-M1-2; later state-machine change waves update it alongside). **Code first/card second or card first/code second must both close within the same mission**; an M1-3 comparison red = two-source drift signal.
- When adding an internal write point (a new opts.internal caller): add a §3 matrix row + a crv6-statemachine assertion + re-measure this card's anchors - all three or the card drifts.
- Disposition of `resumed`: the whitelist keeps the outgoing leg (resumed->dispatched) with no production writer - if ever activated, first fill the §1 table's "who usually puts it there" column and add assertions; never revive silently.
