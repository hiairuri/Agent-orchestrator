# 契约卡②：spool 邮箱（事件信封 + 目录协议）

- **归属模块**：mcp/server.mjs（spool 全部读写经 server；落箱在 report 工具内，消费在 mailbox/resume/gc 工具内）；事件信封生成与消费所读写的 board 字段见 `card-board.md` §4（两卡接缝，字段语义以彼卡为准）
- **脆度评级**（面广度×后果重度双轴）：**中**——消费面广（mailbox peek/read/answer/gc、resume 计数、board list unread、close 告警、组包 wake 链），但失效后果限单 mission 的消息面（不同于 root.txt 的全局性）；裸 JSON 无 schema 校验 + rename 消费语义是主要风险面
- **历史事故回链**：v0.3.1 A1/A3/B9（根锁/answers wx/ENOENT 已消费）、C4/C5（gc 归档/closed 拒改板）、V6-18 details 存储侧截断、V6-49 畸形事件文件致 close 假 unread 永挂（QQagent 实锤）、v1.1 W6 QA P2-b（畸形 id 炸 board list）、v1.1 W3 A5-E（read 呈现指针化）、v1.1.1 W-B（完成即唤队列骑落箱面）
- **锚点声明**：本卡行号系总装时点（v1.2 源码）实测，**不作跨版引用**（l-20261022-6a14d6）；函数名/常量名双锚为定位权威

---

## 1. 文件面与布局

| 项 | 内容 | 锚点 |
|---|---|---|
| 根目录 | `<root>/spool/<mission_id>/`——mission_id 经 safeSegment 消毒后作目录名 | missionSpoolDir :3331 |
| 三目录族 | `unread/`（未消费，report 落箱）、`read/`（已消费，rename 目标）、`answers/`（主控答复，mailbox answer 写） | unreadDirOf/readDirOf :3334-3335；answers mkdir :5006 |
| 文件名协议 | `<15位零填充epochMs>-<8hex>.json`——eventId=`String(Date.now()).padStart(15,"0")+"-"+hex(4)`（hex(4)=4 字节→8 字符）；权威注释=文件头布局注释 | :28-30；eventId :4473 |
| answers 文件名 | `<4位零填充seq>-answer.json`，seq 从目录内既有最大值 +1 起算 | :5008-5011；:5025 |
| **「N 文件」口径** | DR1 survey 的「8 文件」口径在本目录族无文可核（grep 零命中，DP2a 证据缺口②）：实测口径=**3 目录族 × 单一文件名协议**（answers 为 4 位 seq 变体）——本卡即权威口径 | 本卡 §1 |

**目录列举行为**（读方通用）：listSpoolMissions 只取目录条目（stat 非目录跳过，IO 错误返空——:3337-3352）；listUnreadFiles 只取 `.json` 结尾并按名排序（`.bad` 隔离件天然出列，:3354-3366）。

## 2. 写方（唯一写方=server 进程，落箱+改板同临界区）

| 写点 | 写什么 | 锚点 |
|---|---|---|
| report（落箱） | 事件信封整文件 atomicWriteFileSync 到 `unread/`；**落箱+board 更新+lessons append 一个根锁临界区**（v0.3.1 A1）——不存在「事件落了板没动」的中间态 | :4436-4440；:4490-4491 |
| report 的两个旁路 | closed mission（C5）与成对鉴权不过（W-A1 方案 a）：事件**已落箱存档**、board 零改动、lessons 不记——落箱先于两判定，证据永不丢 | :4493-4507；:4509-4534 |
| mailbox answer | `answers/<seq>-answer.json`，flag:"wx" 独占创建，冲突 seq 递增（A3）——并发写者永不覆盖既有答复；answer 文件写+板更新同根锁临界区 | :4994-5037 |
| mailbox gc | 陈旧 unread 归档（mtime<cutff 的 unread 件经 consumeEventFile 移入 read/，计数 archivedUnread）；gc 归档**只移动不删 unread**，删除面仅 read/ | :5081-5128 |

**落箱前置门**（先于落箱，拒绝=零事件）：fail-closed token 门（V6-09：expectedToken 存在则必携且精确匹配；--strict-tokens 连无 token mission 也拒，V6-19A）——鉴权与 board 字段面的接缝见 `card-board.md` §4。summary>200 存储侧截断并附 truncatedNote；details>DETAILS_MAX_CHARS(4000) 存储侧截断（V6-18）+响应 warn_details（INJ-04）——长 payload 应写文件走 artifacts，storage face 无帽不等于无界（:4412-4434；:4817-4819）。

## 3. 事件信封字段表

newEvent 形状（:4474-4489）。**无 JSON schema 校验=裸 JSON**（schema 面=本表+消费方容错）：

| 字段 | 类型 | 语义 |
|---|---|---|
| v | number（恒 1） | 信封版本标记 |
| id | string | =文件名 stem（`<15位>-<8hex>`）；mailbox 呈现与排序键 |
| at | ISO | 落箱时刻（nowIso()）；eventAgeMs 的读源，负 elapsed 钳 0（B7 同族，:3417-3421） |
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

## 4. 读方清单（进程×时机×读不到时的行为）

| 读方 | 时机 | 读不到/畸形时行为 |
|---|---|---|
| mailbox peek | 主控巡检 | 纯只读（无根锁）；事件缺失/畸形静默跳过（readEventFile 返 null） |
| mailbox read | 主控消费 | rename 消费（unread→read）；目标重名依次试 `-1`、随机 hex 后缀；rename 成功但源仍可见=unresolved 不宣称送达（防跨进程元数据迟滞双投递）；**ENOENT=已被并发读者消费，当成功跳过**（B9）；unresolved 留待下次 read |
| mailbox answer | 主控答复 blocked/question | 读 board 非 spool；answer 文件名撞车 wx 递增 |
| mailbox gc | 手动清舱 | read/ 陈旧 unlink；unread/ 陈旧归档；目录缺失按空处理 |
| compactMissionRow | board list 每行 | unread 计数走 countUnreadSafe（QA P2-b：畸形 id/IO 异常计 0，best-effort，永不炸 list）——Flag 3 派生字段 |
| toolResume | 主控 resume briefing | unread_total 只数 open mission（C4：closed 残留事件不再虚增告警）；逐 mission unread 计数进 recommendedAction |
| close 类路径 | board ack close 等 | 携 unread 事件/pending question 关闭 → 响应附 warn（C6） |
| V6-49 隔离面 | 任何 readEventFile 调用 | parse 失败/非对象 → rename `<file>.bad` 隔离（字节保留可取证）后返 null；**读 IO 错误（rename 竞态）返 null 但不隔离**；防「永久假 unread」 |
| wake 链（report 内） | kind=done 且 dispatch.mode==="headless" | wakeQueueProduce 落 `<root>/context/wake-queue/<ms>-<mission_id>.json`（wx）+认领 kick——队列在 context/ 不在 spool，接缝见 `card-result-dir.md` |

**消费呈现**（v1.1 W3 A5-E）：mailbox read 的 details 指针化——`details_head`（≤160=T1_HEAD_CAP）+`details_path`（消费后 read/ 文件路径）+`details_hint`；全文证据恒在 spool，DETAILS_MAX_CHARS 存储帽不动（presentMailboxDetails :4879-4897）。peek 从不携 details（字节级不变）。

## 5. 失效语义（缺文件/损坏/半写/竞态/时钟漂移 × 读方行为）

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
| gc 竞态（归档 vs 并发消费） | 归档走 consumeEventFile，ENOENT 当已消费跳过；read/ 先扫后归档的顺序保证本 pass 刚归档件不被误删 | 锁内仲裁（C4） |

## 6. 断言锚

- **crv6-statemachine**：C5（closed 拒改板、事件入箱）+ SM-08（closed 机器可读键）+ V6-49 隔离行为腿 + wake 队列 WB-SRV 系（done×headless 产事件）。
- **crv5-auth**：AUTH-01..08——fail-closed token 门含「三探针零事件落箱+板面零改动」（拒绝先于落箱的机械证明）。
- **crv2-pack**：组包对拍基线（信封字段面与响应键面）；**po-static/crv 系**：read 呈现指针化（A5-E）细节腿。
- **LM-05**（lint-manifest，M1-3 注册）：本卡常量/函数名（missionSpoolDir/unreadDirOf/readEventFile/consumeEventFile/countUnreadSafe/DETAILS_MAX_CHARS 等）server.mjs grep 可见+卡存在非空。

## 7. 维护规则

- 信封字段演进：`v` 递增+本表 §3 补行+落箱函数同步；与 `card-board.md` §4（信封↔board 接缝）同波改（该节维护规则已约定）。
- 目录族/文件名协议变更：先改本卡 §1 口径（含「N 文件」口径勘误），再动消费面；`.bad`/`.json` 后缀过滤语义是消费面隐式契约，变更需全读方盘点。
- 新增读方（如未来组包/哨兵直读 spool）：必须走 readEventFile 面（自动获得 V6-49 隔离），**禁止**裸 JSON.parse 直读事件文件——那是 V6-49 的病根。
