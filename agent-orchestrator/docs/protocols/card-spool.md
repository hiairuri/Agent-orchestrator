# Contract card 2: the spool mailbox (event envelopes + the directory protocol)

- **Home module**: mcp/server-stores.mjs (all spool reads/writes go through the server; boxing happens inside the report tool, consumption inside mailbox/resume/gc); the board fields read/written by envelope generation and consumption are in `card-board.md` §4 (the seam between the two cards; field semantics defer to that card)
- **Brittleness rating** (surface-breadth x consequence-severity dual axis): **medium** - broad consumption face (mailbox peek/read/answer/gc, resume counting, board list unread, close warnings, the pack wake chain), but failure consequences are limited to a single mission's message face (unlike root.txt's global reach); bare JSON with no schema validation + rename consumption semantics are the main risk faces
- **Anchor declaration**: all line numbers in this card were measured at assembly time (v1.2 source); **line numbers are not referenced across versions** (l-20261022-6a14d6); function/constant-name dual anchors are the locating authority

---

## 1. File face and layout

| 项 | 内容 | 锚点 |
|---|---|---|
| 根目录 | `<root>/spool/<mission_id>/`——mission_id 经 safeSegment 消毒后作目录名 | `missionSpoolDir`（mcp/server-stores.mjs） |
| 三目录族 | `unread/`（未消费，report 落箱）、`read/`（已消费，rename 目标）、`answers/`（主控答复，mailbox answer 写） | `unreadDirOf`/`readDirOf`（mcp/server-stores.mjs）；answers mkdir（mcp/tool-mailbox.mjs answer） |
| 文件名协议 | `<15位零填充epochMs>-<8hex>.json`——eventId=`String(Date.now()).padStart(15,"0")+"-"+hex(4)`（hex(4)=4 字节→8 字符）；权威注释=文件头布局注释 | eventId（mcp/tool-report.mjs newEvent 段） |
| answers 文件名 | `<4位零填充seq>-answer.json`，seq 从目录内既有最大值 +1 起算 | mcp/tool-mailbox.mjs answer（seq 起算+冲突递增） |
| **「N 文件」口径** | DR1 survey 的「8 文件」口径在本目录族无文可核：实测口径=**3 目录族 × 单一文件名协议**（answers 为 4 位 seq 变体）——本卡即权威口径 | 本卡 §1 |

**目录列举行为**（读方通用，均在 mcp/server-stores.mjs）：`listSpoolMissions` 只取目录条目（stat 非目录跳过，IO 错误返空）；`listUnreadFiles` 只取 `.json` 结尾并按名排序（`.bad` 隔离件天然出列）。

## 2. Writers (single writer = the server process; boxing + board update in the same critical section)

| Write point | What it writes | Anchor |
|---|---|---|
| report (boxing) | the whole event envelope written atomically (atomicWriteFileSync) to `unread/`; **boxing + board update + lessons append in one root-lock critical section** - there is no intermediate state where "the event landed but the board did not move" | mcp/tool-report.mjs toolReport (the boxing critical section) |
| report's two bypasses | closed mission (C5) and failed paired auth (the W-A1 plan a): the event **is already boxed and archived**, the board is untouched, lessons not recorded - boxing precedes both judgments, evidence is never lost | mcp/tool-report.mjs (C5 / paired-auth bypass) |
| mailbox answer | `answers/<seq>-answer.json`, flag:"wx" exclusive creation, colliding seq increments - concurrent writers never overwrite an existing answer; the answer file write + board update share the root-lock critical section | mcp/tool-mailbox.mjs mailbox answer |
| mailbox gc | stale unread archived (unread files with mtime<cutoff moved into read/ via consumeEventFile, counted as archivedUnread); gc archiving **only moves, never deletes unread**; the deletion face is read/ only | mcp/tool-mailbox.mjs mailbox gc |

**Pre-boxing gate** (before boxing; a rejection = zero events): the fail-closed token gate (V6-09: if expectedToken exists it must be carried and match exactly; --strict-tokens rejects even token-less missions, V6-19A) - the seam between auth and the board field face is `card-board.md` §4. summary>200 is truncated storage-side with a truncatedNote; details>DETAILS_MAX_CHARS(4000) is truncated storage-side (V6-18) + the response carries warn_details (INJ-04) - long payloads should go to files via artifacts; no cap on the storage face does not mean unbounded (mcp/tool-report.mjs pre-boxing gate + storage-side truncation).

## 3. The event envelope field table

The newEvent shape (the newEvent block in mcp/tool-report.mjs). **No JSON schema validation = bare JSON** (the schema face = this table + consumer tolerance):

| 字段 | 类型 | 语义 |
|---|---|---|
| v | number（恒 1） | 信封版本标记 |
| id | string | =文件名 stem（`<15位>-<8hex>`）；mailbox 呈现与排序键 |
| at | ISO | 落箱时刻（nowIso()）；eventAgeMs 的读源，负 elapsed 钳 0（B7 同族，mcp/server-stores.mjs `eventAgeMs`） |
| mission_id | string | 经 safeSegment 消毒的定位键 |
| worker | string | report 入参原样（调用方字符串非凭证——凭证是 token） |
| agent_id | string\|null | 直拷自 mission.dispatch.agent_id（缺=null）——接缝字段见 card-board §4 |
| token | string\|null | 回执面带回（expectedToken/token），供主控核对 |
| kind | enum | milestone/blocked/question/done（KINDS 枚举校验先于落箱） |
| summary | string | ≤200 字（存储侧截断） |
| details | string | ≤4000 字（DETAILS_MAX_CHARS 存储侧截断） |
| artifacts | string[] | report 入参逐项 String 化（evidence 原样入箱） |
| files_touched | string[] | F1 归一化（normalizePathList）；**每种 kind 都原样入箱**（G-7：证据永不丢，只有 scope 审计选择跳过） |
| question | string\|null | blocked/question 必带（先于落箱校验） |
| urgent | boolean | 紧急旗标（仅旗标，不改变投递路径） |

## 4. Reader inventory (process x timing x behavior on unreadable/malformed)

| 读方 | 时机 | 读不到/畸形时行为 |
|---|---|---|
| mailbox peek | 主控巡检 | 纯只读（无根锁）；事件缺失/畸形静默跳过（readEventFile 返 null） |
| mailbox read | 主控消费 | rename 消费（unread→read）；目标重名依次试 `-1`、随机 hex 后缀；rename 成功但源仍可见=unresolved 不宣称送达；**ENOENT=已被并发读者消费，当成功跳过**（B9）；unresolved 留待下次 read |
| mailbox answer | 主控答复 blocked/question | 读 board 非 spool；answer 文件名撞车 wx 递增 |
| mailbox gc | 手动清舱 | read/ 陈旧 unlink；unread/ 陈旧归档；目录缺失按空处理 |
| compactMissionRow | board list 每行 | unread 计数走 countUnreadSafe（QA P2-b：畸形 id/IO 异常计 0，best-effort，永不炸 list）——Flag 3 派生字段 |
| toolResume | 主控 resume briefing | unread_total 只数 open mission（C4：closed 残留事件不再虚增告警）；逐 mission unread 计数进 recommendedAction |
| close 类路径 | board ack close 等 | 携 unread 事件/pending question 关闭 → 响应附 warn（C6） |
| V6-49 隔离面 | 任何 readEventFile 调用 | parse 失败/非对象 → rename `<file>.bad` 隔离（字节保留可取证）后返 null；**读 IO 错误（rename 竞态）返 null 但不隔离**；防「永久假 unread」 |
| wake 链（report 内） | kind=done 且 dispatch.mode==="headless" | wakeQueueProduce 落 `<root>/context/wake-queue/<ms>-<mission_id>.json`（wx）+认领 kick——队列在 context/ 不在 spool，接缝见 `card-result-dir.md` |

**消费呈现**（v1.1 W3 A5-E）：mailbox read 的 details 指针化——`details_head`（≤160=T1_HEAD_CAP）+`details_path`（消费后 read/ 文件路径）+`details_hint`；全文证据恒在 spool，DETAILS_MAX_CHARS 存储帽不动（`presentMailboxDetails`（mcp/tool-mailbox.mjs））。peek 从不携 details（字节级不变）。

## 5. Failure semantics (missing file / corruption / partial write / race / clock drift × reader behavior)

| 情形 | 行为 | 分类 |
|---|---|---|
| unread/ 目录缺失（无报告史） | listUnreadFiles 返空——计数 0、消费空转 | 静默降级（设计内） |
| 事件文件畸形（parse 失败/非对象） | readEventFile rename `.bad` 隔离一次（出 `.json` 名单=计数归零），返 null；证据字节保留 | 自愈+留痕（V6-49） |
| 事件文件读 IO 错误（消费竞态窗口） | 返 null 不隔离（文件可能正在被 rename） | 自愈 |
| 半写 | atomicWriteFileSync（temp+rename）杜绝；无部分可见态 | 自愈（结构面） |
| rename 竞态（跨读者） | 根锁内消费+ENOENT 当已消费+unresolved 不宣称（重试候选名/复检源名）——双投递与漏投递都被堵 | 锁内仲裁 |
| answers 并发写 | flag:"wx" 独占 + seq 递增（A3）——永不覆盖 | 锁内仲裁 |
| 时钟漂移 | eventAgeMs 负值钳 0（oldest_age_ms 不出负数） | 钳制（B7 同族） |
| 畸形 mission_id（手编 board/legacy id） | safeSegment 消毒+countUnreadSafe 兜底计 0——不炸 board list（QA P2-b） | 静默降级（best-effort） |
| gc 竞态（归档 vs 并发消费） | 归档走 consumeEventFile（ENOENT 当已消费跳过）；read/ 先扫后归档顺序保证本 pass 刚归档件不被误删 | 锁内仲裁（C4） |

## 6. Assertion anchors

- **crv6-statemachine**: C5 (closed rejects board-mutating reports, events still boxed) + SM-08 (closed machine-readable keys) + the V6-49 quarantine behavior legs + the wake queue WB-SRV series (done x headless produces events).
- **crv5-auth**: AUTH-01..08 - the fail-closed token gate including "three probes, zero events boxed + zero board changes" (the mechanical proof that rejection precedes boxing).
- **crv2-pack**: the pack-materialization comparison baseline (the envelope field face and response key face); **po-static/crv series**: the read presentation pointerization (A5-E) detail legs.
- **LM-05** (lint-manifest, M1-3 registration): this card's constant/function names (missionSpoolDir/unreadDirOf/readEventFile/consumeEventFile/countUnreadSafe/DETAILS_MAX_CHARS etc.) grep-visible in mcp/server-stores.mjs + the card exists and is non-empty.

## 7. Maintenance rules

- Envelope field evolution: increment `v` + add §3 table rows + sync the boxing function; changed in the same wave as `card-board.md` §4 (the envelope<->board seam, as that section's maintenance rules already stipulate).
- Directory family / filename protocol changes: change this card's §1 accounting first (including the "N files" accounting erratum), then touch the consumption face; the `.bad`/`.json` suffix-filter semantics are an implicit consumption-face contract - a change requires an inventory of all readers.
- New readers (future pack/sentinel direct spool reads, say): must go through the readEventFile face (which automatically gains V6-49 quarantine); **raw JSON.parse direct reads of event files are forbidden** - that is the root cause of V6-49.
