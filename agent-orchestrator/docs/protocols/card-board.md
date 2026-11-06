# Contract card 5: board.json + the p2p record family (the board-field face referenced by spool event envelopes)

- **Home module**: mcp/server-board.mjs (all board reads/writes go through the server; `card-state-machine.md` carries the status legs - the two cards together form the complete write protocol)
- **Brittleness rating** (surface-breadth x consequence-severity dual axis): **thickest assertions = least likely to break; but the most complex semantics** - locked by crv6-statemachine + crv5-auth + crv2-pack; failure consequences limited to a single mission/one orchestration round; complexity concentrates in the merge allowlist/lease/p2p auth trio
- **Anchor declaration**: all line numbers in this card were measured at assembly time (v1.1.2 source); **line numbers are not referenced across versions** (l-20261022-6a14d6); function/constant-name dual anchors are the locating authority

---

## Reading guide

| Section | Content | Quick anchor |
|---|---|---|
| §1 | board.json file face, layout, the load self-healing chain, atomic save | `loadBoard`/`saveBoard` (mcp/server-board.mjs) |
| §2 | mission record field table + merge allowlist mechanism + read-side derived fields | `MERGEABLE_KEYS`/`ONE_LEVEL`/`mergeMission` (mcp/server-board.mjs) |
| §3 | Writer inventory (single writer = the server process, critical section = root lock) | `withRootLock` (mcp/server-core.mjs) |
| §4 | board fields referenced by the spool event envelope (seam with the spool card) | `card-spool.md` §2-§4 |
| §5 | the p2p/ record family (ask/answer protocol + token auth) | `p2pTokenGate`/`appendP2pEcho` (mcp/server-p2p.mjs) |
| §6 | invalidity semantics master table (missing/corrupt/race/clock-drift x reader behavior) | self-contained |
| §7/§8 | assertion anchors + maintenance rules | crv6-statemachine/crv5-auth/crv2-pack |

Status legs (the 11-state transition gate + external-writer forbidden zones) live in `card-state-machine.md`; storage-root locating lives in `card-root-txt.md`.

## 1. File face and layout

| Item | Content | Anchor |
|---|---|---|
| Path | `<root>/board.json` (root = storage root, resolved via the root.txt pointer; the root protocol belongs to the root-txt card) | boardFile (mcp/server-board.mjs) |
| Top-level shape | `{ version: number, updated_at: ISO, missions: [] }`; version = BOARD_VERSION(2) is a marker only, **readers never validate it** | emptyBoard/saveBoard (mcp/server-board.mjs); BOARD_VERSION (mcp/server-core.mjs) |
| Archive | `archive/board-<ts>.json` (mailbox gc moves closed missions out wholesale: archive first, then remove from the live board; a ts collision gets a -<2hex> suffix; archive document = `{archived_at, missions}`) | mcp/tool-mailbox.mjs mailbox gc |
| Root lock | `.lock/owner.json` `{holder,pid,heartbeatAt}`; **all board read-modify-write critical sections run inside withRootLock** - including git subprocesses (the sandbox chain) | `withRootLock` (mcp/server-core.mjs) |
| Anti-monolith | large payloads (bodies other than original_prompt / full manifests) go file+pointer, **never into board.json** (anti-giant-board) | mcp/server-p2p.mjs anti-giant-board comment |

**Load self-healing chain** (`loadBoard` (mcp/server-board.mjs), the core of invalidity semantics):

1. A "missing" file is re-checked 3 times first (50ms interval - guards the unlink-then-rename window being misread as an empty board);
2. still missing -> look for `board.json.recovered` (the parking spot of last-resort atomic writes) -> restore;
3. still missing -> empty board;
4. strip a BOM if read (V6-27 - a "Notepad save-as" once bricked all board tools);
5. JSON.parse failure or non-object -> **quarantine without throwing**: rename to `board.json.corrupt-<ts>` (evidence kept forever), rebuild an empty board, set `boardDegradedFrom`, and the next board list response carries `board_degraded_from:<ts>` to inform the coordinator once (V6-26; the race loser tolerates rename failure - see the §6 race row).

**Save**: saveBoard atomic write (atomicWriteFileSync), refreshing version/updated_at uniformly before write-back (mcp/server-board.mjs `saveBoard`).

## 2. The mission record field table

The newMission default shape (mcp/server-board.mjs) + lazy-migration keys. **The schema validation face = the merge whitelist** (no JSON schema file):

| 字段 | 类型/默认 | 写方 | 语义与约束 |
|---|---|---|---|
| id | string | 定位键 | safeSegment 消毒；upsert 缺 id=新建（l-20261023-576af5）；永不合并 |
| title / original_prompt | string（默认 ""） | upsert / context_pack | title 裁的是字段非字符，verbatim 保存 |
| agent_type | string（默认 ""） | upsert | 角色名（orch-worker 等） |
| model | string\|null（默认 null） | upsert | 类型校验（mcp/tool-board.mjs board upsert） |
| status | enum 11 态 | 见状态机卡 | 迁移门+枚举校验（mcp/tool-board.mjs） |
| dispatch | object（ONE_LEVEL 单层深合并） | context_pack/dispatch/claim | 子键：mode（headless，W5 落 nested）、token（report/p2p 鉴权依赖）、agent_id/task_id/session_id/spawned_by_session（M3-1 归因）、run_id |
| pack | object（ONE_LEVEL） | context_pack/sandbox | 子键：path/variants/persona/sandbox{branch,base_commit,root,apply_intent_at,applied_at,applied_commit,...} |
| artifacts / output_files | array | report(done) 回写 / upsert | artifacts done 时 append-only 去重回写（mcp/tool-report.mjs toolReport）；读侧派生 _n 计数 |
| blocked | object（ONE_LEVEL） | report(blocked/question) 整对象重写（C1） | {question,asked_at,answered,answer,answered_at}；stale answered=true 不得漂白新问题 |
| blockedBy | string[] | upsert | DAG 边；环禁（`detectCycle`（mcp/server-board.mjs），写前拒）；前向引用合法（缺席引用跨一次写事务，再不落则 dangling_dropped 清理） |
| ack | object\|null（**只读键**） | ack action/自动规则 | upsert 入口剥除（mcp/tool-board.mjs board upsert）；跨迁移清空（SM-05）；close 自动 ack；report(blocked/question) 清旧 ack（C1） |
| owner / claim | object\|null（**只读键**） | claim / report 续租 / sweep 回收 | claim={worker,token,claimedAt,leaseUntil}；租约默认 30min；token hex(16) 必换发（V6-14） |
| qa | object\|null（ONE_LEVEL） | reviewer 链/sandbox 闸消费 | qa.verdict==="pass" 是 closed 绿档凭证两腿之一 |
| skippedReason | string\|null | sweep cascade / upsert | cascade 恒写 "upstream_failed"；类型校验（mcp/tool-board.mjs） |
| timeline | event[] | 各写点 append | 事件形态 {at,event,summary}；append-only 惯例（唯一重写例外=echo 截断由 bg-sentinel，非本文件） |
| scope_paths / strict_scope / scope_violations / manifest | **scope 三键+manifest 指针** | 注册=upsert；violations/manifest **唯一合法写者=report close-out** | **whole-replacement 特例**：四者不进 ONE_LEVEL，整替即注册/审计语义（mcp/server-board.mjs `MERGEABLE_KEYS` whole-replacement 注释）；scope_paths 入板前 F1 归一化（mcp/tool-board.mjs）；manifest 从 upsert 剥除（mcp/tool-board.mjs） |
| updated_at | ISO | saveBoard/各写点 | 派生读面（lastResultAt/wake_failure）依赖它 |
| danglingRefSince | ISO（瞬态标记） | sweepGraph | 悬挂引用首见标记，次写清理 |
| lease_minutes | number | claim 入参 | 畸形租约兜底计算用（mcp/server-board.mjs `sweepGraph` 回收） |

**白名单机制**（v0.4.1 起）：MERGEABLE_KEYS 18 键（mcp/server-board.mjs）∪ ONE_LEVEL 4 键单层深合并（dispatch/blocked/pack/qa，子键 undefined 跳过，mcp/server-board.mjs）；未知顶层键**丢弃并在响应 ignoredPatchKeys/ignored_keys 上报**（mcp/server-board.mjs `mergeMission`）——不是报错，是降级合并。

**读侧派生字段**（`withComputed`（mcp/server-board.mjs），response-only 零新存储）：wake_failure（W1 status∈RESULT_STATUSES[done,failed,blocked,question] ∨ W2 dispatch.agent_id 真值 ∨ W3 未 ack ∨ W4 dispatch.mode!=="workflow"）、t1_head（最新 report 事件 summary 头 160 字符，T1_HEAD_CAP :158）、artifacts_n/output_files_n/has_question/scope 摘要。**board list 紧凑行**（`compactMissionRow`（mcp/server-board.mjs））白名单=id/title/status/question/unacked/unread/t1_head/artifacts_n/output_files_n/scope_paths/strict_scope（+scope_violations 有值透出）；内部态（claim/dispatch/pack/manifest/wake_failure/ack 对象/timeline/original_prompt）不上 list 面，board get（compact 默认/full 豁免）与 probe 承载明细。

## 3. Writer inventory (single writer = the server process; critical section = the root lock)

board.json **has no external-process writers** - hooks/bg-sentinel/watcher are all readers or writers of other file families. Server-internal write points (status legs: the state-machine card §3):

| Write point | What it writes | Anchor |
|---|---|---|
| board upsert (the sole external status gate) | allowlist patch + transition guard | mcp/tool-board.mjs board upsert (strips read-only/transient keys) |
| board ack | m.ack + timeline (no status change) | mcp/tool-board.mjs board ack |
| board claim | owner/claim/status=running/dispatch.token rotation | mcp/tool-board.mjs board claim |
| report | status legs + blocked rewrite + artifacts/manifest/scope_violations + lease renewal | mcp/tool-report.mjs toolReport |
| mailbox answer | blocked.blocked backfill + status legs + auto-ack | mcp/tool-mailbox.mjs mailbox answer |
| mailbox gc | closed -> archive | mcp/tool-mailbox.mjs mailbox gc |
| context_pack / dispatch / sandbox:create | pack/scope_paths/dispatch registration | mcp/tool-pack.mjs (pack registration) + mcp/tool-dispatch.mjs (dispatch registration) |
| sandbox_apply | direct write to closed + auto-ack + applied markers | mcp/tool-sandbox.mjs `toolSandboxApply` (main path/compensation branch) |
| sweepGraph (same critical section as every board write) | unlock/cascade/lease reclaim/dangling | mcp/server-board.mjs `sweepGraph` |
| p2p_ask/p2p_answer/gcP2pFiles | two-sided timeline echo (**append only; status/updated_at zero-touch**) | mcp/server-p2p.mjs `appendP2pEcho` |

## 4. The board field face referenced by the spool event envelope (card-2 material, M6-1)

> Card 2 (spool) documents the event envelope in full and the directory protocol (the boxing-face authority; mechanism details = card 2 §2/§4); this section only pins **the board fields the envelope generation and consumption read and write** - the seam between the two cards. report boxes the event and mutates the board inside the same critical section (v0.3.1 A1, mcp/tool-report.mjs toolReport).

| 信封行为 | board 字段 | 语义 | 锚点 |
|---|---|---|---|
| 鉴权（先于落箱） | `dispatch.token` | fail-closed 精确匹配（V6-09）——**拒绝发生在落箱前=零事件**；--strict-tokens 连无 token mission 也拒（V6-19A） | mcp/tool-report.mjs token 门 |
| 信封字段 `agent_id` | `dispatch.agent_id` | 直拷入信封（缺=null） | mcp/tool-report.mjs 信封组包 |
| closed 拒改板 | `status` | closed：事件已落箱存档、board 不动（C5）；lessons 亦不记 | mcp/tool-report.mjs（C5） |
| 成对鉴权 | `claim.worker` | claimHolder≠worker：事件落箱+板零改动+**不续租**+claimWarn（W-A1） | mcp/tool-report.mjs 成对鉴权 |
| blocked/question 重写 | `blocked` | 整对象重写（C1；stale 语义同 §2 blocked 行） | mcp/tool-report.mjs blocked 重写 |
| scope 审计 | `scope_paths` | milestone/done 的 files_touched 比对基线；违例=timeline scope_violation 事件+mission.scope_violations 整替重写（clean sweep 清旧发现） | mcp/tool-report.mjs scope 审计 |
| done 回写 | `artifacts` + `manifest` | artifacts append-only 去重合并；manifest 指针=closeOutManifest 产物（manifest 唯一合法写者） | mcp/tool-report.mjs done 回写 |
| 续租 | `claim`（leaseUntil） | 仅 claim.worker===worker 续（V6-17）；p2p 事件不续租 | mcp/tool-report.mjs 续租；mcp/server-board.mjs `upsertMission` 续租段 |
| 完成即唤 | `dispatch.mode` | kind=done 且 mode==="headless" → wakeQueueProduce（队列在 result-dir 旁 wake-queue/，非 board；协议见 `card-result-dir.md` §1） | mcp/tool-report.mjs `wakeQueueDirOf` |
| timeline append | `timeline` | `report:<kind>` 事件；t1_head/lastResultAt/wake 检查的读源 | mcp/tool-report.mjs timeline append |

反向引用（board 读 spool）：compactMissionRow 的 `unread` 计数=countUnreadSafe（每 mission 一次目录 IO，best-effort，畸形 id 记 0 不炸 list，QA P2-b）；close 类路径的 unread 告警消费同一计数（V6-49：畸形事件文件 rename `<file>.bad` 隔离防假 unread 永挂，mcp/server-stores.mjs `readEventFile`）。

## 5. The p2p/ record family

| Item | Content | Anchor |
|---|---|---|
| Layout | `p2p/p2p-<id>.json`; id=`<15-digit zero-padded epochMs>-<4hex>` | mcp/server-p2p.mjs p2p record family layout |
| Record schema | `{v:1, id, from:{mission_id,worker}, to:{mission_id,worker}, question, status:"open", created_at, answered_at:null, answer:null, expired_at:null, echo:{ask,answer:null}}`; question/answer <= DETAILS_MAX_CHARS(4000) storage-side truncation | mcp/server-p2p.mjs record schema |
| State machine | open -> answered (p2p_answer) / expired (TTL sweep, default 30min, --p2p-ttl-min adjustable; malformed/future created_at reads as not-yet-expired = the conservative direction) | mcp/server-p2p.mjs state machine |
| Writers | p2p_ask / p2p_answer / TTL sweep (saveP2pRecord atomic write); **asker precondition state = blocked/question** (P2P_ASK_PRECONDITION_STATUSES; the primary waiting channel report(question) is always available) | mcp/server-p2p.mjs `saveP2pRecord` |
| Auth (p2pTokenGate) | expectedToken = mission.dispatch.token: if a token exists it must be carried and match (missing/wrong = hard ToolError; **no report-style archive-anyway fallback - p2p has no board write to withhold**); --strict-tokens/paired-auth semantics follow the §4 token gate direction; **each call carries its own mission's token** (asker uses the from side, answerer the to side) | mcp/server-p2p.mjs `p2pTokenGate` |
| Target validation (ask) | target exists, non-terminal (P2P_TERMINAL_STATUSES=[done,failed,skipped,closed]), to_worker = the target's current holder (enforced when owner or claim.worker is present) - invalid targets **create no record** (P2P is an optimization channel; degradation = report(question), always available) | mcp/tool-board.mjs p2p_ask target validation |
| Boundary (2) (answer zero-touch) | p2p_answer writes only the p2p record + two-sided echo; the asker mission's status/fields/lease are **zero-touch** | mcp/tool-board.mjs p2p_answer zero-touch |
| Mandatory two-sided echo (boundary (3)) | appendP2pEcho appends timeline only, **never touches status/updated_at** (echo is an audit fact, not a state change; liveness rides the timeline `at` - the sentinel lastActivityMs counts any timeline event, so echo is automatically counted, protecting updated_at semantics from pollution) | mcp/server-p2p.mjs `appendP2pEcho` |
| Consumption semantics | **advisory data**: read failure/corruption counts as absent, no quarantine (loadP2pRecord double-catch returns null); the asker digests the answer itself and books it via its own report - mission status evolution still goes only through report | mcp/server-p2p.mjs `loadP2pRecord` |
| Lazy scan face | gcP2pFiles rides startup + p2p_ask/p2p_answer + board list; countOpenP2p rides board list (the open_p2p count) | mcp/server-p2p.mjs `gcP2pFiles`/`countOpenP2p` (startup piggyback = mcp/server-boot.mjs) |

## 6. Failure semantics (missing file / corruption / partial write / race / clock drift × reader behavior)

| 情形 | 行为 | 分类 |
|---|---|---|
| board.json 缺失 | §1 加载自愈链步 1-3（重查 3×50ms → recovered 档 → 空板） | 自愈 |
| board.json 损坏（parse 失败/非对象） | §1 步 5（rename `.corrupt-<ts>` 隔离留证，空板重建，`board_degraded_from` 一次性上报） | 自愈+留痕 |
| board.json 读 IO 错误（非缺失） | ToolError 上抛（不隔离） | fail-loud |
| 半写 | 原子写（temp+rename）杜绝；历史上 unlink-then-rename 窗口由 A2 三重查兜住 | 自愈 |
| 竞态（跨进程写） | 全部读改写在根锁内；隔离 rename 输家容忍；claim CAS 锁内仲裁；answers 冲突序号递增（A3 同族） | 锁内仲裁 |
| 未知键混入 | 丢弃+ignoredPatchKeys 上报（不炸不静默吞） | 降级合并 |
| p2p 记录缺失/损坏 | 当 absent（advisory 数据，无隔离） | 静默降级（设计内） |
| 时钟漂移 | B7：负 elapsed 钳 0（wake_failure 分钟数 max(0,·)）；租约畸形走龄期兜底非裸时钟 | 钳制 |
| board 上的畸形 mission（无 id 等） | 遍历侧 `m &&` 守卫跳过（findIndex/find/filter 全部 falsy-safe） | 静默跳过 |

## 7. Assertion anchors

- **crv6-statemachine**: SM-01..08 (the closed dual gates / allowlist / reopen / ack clearing / lease / answer interplay / closed rejects board-mutating reports) + A-v070-P2P-01..06 (token boundaries / zero-touch / replay / invalidation / precondition states / liveness) + WB-SRV-a..g (the done-and-wake queue) + FA-1..5 (dispatch seeding).
- **crv5-auth**: AUTH-01..08 - the fail-closed token gate (including "three probes, zero events boxed, zero board changes"), paired authentication, claim must rotate the token.
- **crv2-pack**: the pack-materialization comparison baseline (the pack field face); **crv1-scope**: scope_paths registration/audit; **root-contract**: the root locating chain (this card's path prerequisite).
- **LM-05** (lint-manifest, M1-3 registration): this card's constant/function names (MERGEABLE_KEYS/ONE_LEVEL/p2pTokenGate etc.) grep-visible in mcp/server-board.mjs + the card exists and is non-empty.

## 8. Maintenance rules

- This card's only writers = the protocol-card batch mission (first written in W1-M1-2) + W6-M6-1 (the spool card consumed this section's material; if envelope fields evolve, the spool card and the §4 table sync in the same wave) + subsequent board-field evolution waves.
- Adding a mission field: enter MERGEABLE_KEYS first (or the ONE_LEVEL/scope whole-replacement group) and add a §2 table row; **never** silently admitting unknown keys as a compatibility measure.
- p2p record schema evolution: increment `v` + re-audit the loadP2pRecord fault-tolerance policy (advisory semantics must not be upgraded to fail-loud unless the coordinator simultaneously gains an explicit signal face).
