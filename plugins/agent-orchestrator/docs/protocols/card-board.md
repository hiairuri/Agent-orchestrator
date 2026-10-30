# 契约卡⑤：board.json + p2p 记录（含 spool 事件信封引用的 board 字段面）

- **归属模块**：mcp/server.mjs（board 全部读写经 server；`card-state-machine.md` 承载状态腿，两卡合起来才是完整写协议）
- **脆度评级**（面广度×后果重度双轴）：**断言最厚=最不易坏；但语义最复杂**——crv6-statemachine+crv5-auth+crv2-pack 三套件锁面；失效后果限单 mission/单编排轮（不同于 root.txt 的全局性），复杂度集中在 merge 白名单/租约/p2p 鉴权三面
- **历史事故回链**：v0.4.1 merge 白名单（QA：upsert 曾把未知键如 timeline_note 原样入库=schema 漂移）、V6-26 板损坏曾整工具面砖死、V6-49 畸形事件文件致 close 假 unread 永挂（QQagent）、v1.1.1 P2P schema 缺口、l-20261019-d38f65/l-20261023-576af5（写法禁区，详见状态机卡 §4）
- **锚点声明**：本卡行号系总装时点（v1.1.2 源码）实测，**不作跨版引用**（l-20261022-6a14d6）；函数名/常量名双锚为定位权威

---

## 1. 文件面与布局

| 项 | 内容 | 锚点 |
|---|---|---|
| 路径 | `<root>/board.json`（root=存储根，root.txt 指针解析；root 协议归卡③） | boardFile :1827 |
| 顶层形状 | `{ version: number, updated_at: ISO, missions: [] }`；version=BOARD_VERSION(2) 仅标记，**读方永不校验** | emptyBoard :1829；saveBoard :1918-1922；BOARD_VERSION :111 |
| 归档 | `archive/board-<ts>.json`（mailbox gc 把 closed mission 整体迁出：先归档后从活板移除；ts 冲突加 -<2hex> 后缀；归档文档=`{archived_at, missions}`） | gc :5130-5148 |
| 根锁 | `.lock/owner.json` `{holder,pid,heartbeatAt}`；**全部 board 读改写临界区跑在 withRootLock 内**（v0.3.1 A1）——包括 git 子进程（沙箱链） | 布局头 :43-44；:1127 |
| 反巨石 | 大 payload（original_prompt 之外的正文/manifest 全文）走文件+指针，**永不入 board.json**（anti-giant-board） | :3678 注释 |

**加载自愈链**（loadBoard :1870-1916，失效语义核心）：

1. 文件"缺失"先重查 3 次（50ms 间隔，A2——防 unlink-then-rename 窗口被误读为空板）；
2. 仍缺 → 找 `board.json.recovered`（原子写最后手段的停车档）→ 恢复；
3. 仍缺 → 空板；
4. 读到 BOM 先剥（V6-27，"记事本另存"曾砖死全部 board 工具）；
5. JSON.parse 失败或非对象 → **隔离不抛**：rename 为 `board.json.corrupt-<ts>`（证据保留永不删），重建空板，置 `boardDegradedFrom`，下一次 board list 响应带 `board_degraded_from:<ts>` 一次性告知主控（V6-26）；两 server 竞争同一损坏文件时败方 rename 失败被容忍（隔离副本恰存一份）。

**保存**：saveBoard 原子写（atomicWriteFileSync），回写前统一刷 version/updated_at（:1918-1922）。

## 2. mission 记录字段表

newMission 默认形状（:1924-1957）+ 懒迁移键。**schema 校验面=merge 白名单**（无 JSON schema 文件）：

| 字段 | 类型/默认 | 写方 | 语义与约束 |
|---|---|---|---|
| id | string | 定位键 | safeSegment 消毒；upsert 缺 id=新建（l-20261023-576af5）；永不合并 |
| title / original_prompt | string（默认 ""） | upsert / context_pack | title 裁的是字段非字符，verbatim 保存 |
| agent_type | string（默认 ""） | upsert | 角色名（orch-worker 等） |
| model | string\|null（默认 null） | upsert | 类型校验 :3890-3896 |
| status | enum 11 态 | 见状态机卡 | 迁移门+枚举校验（:3885-3889） |
| dispatch | object（ONE_LEVEL 单层深合并） | context_pack/dispatch/claim | 子键：mode（headless，W5 落 nested）、token（report/p2p 鉴权依赖）、agent_id/task_id/session_id/spawned_by_session（M3-1 归因）、run_id |
| pack | object（ONE_LEVEL） | context_pack/sandbox | 子键：path/variants/persona/sandbox{branch,base_commit,root,apply_intent_at,applied_at,applied_commit,...} |
| artifacts / output_files | array | report(done) 回写 / upsert | artifacts done 时 append-only 去重回写（:4584-4601）；读侧派生 _n 计数 |
| blocked | object（ONE_LEVEL） | report(blocked/question) 整对象重写（C1） | {question,asked_at,answered,answer,answered_at}；stale answered=true 不得漂白新问题 |
| blockedBy | string[] | upsert | DAG 边；环禁（detectCycle :2306-2324，写前拒）；前向引用合法（缺席引用跨一次写事务，再不落则 dangling_dropped 清理） |
| ack | object\|null（**只读键**） | ack action/自动规则 | upsert 入口剥除（:3875-3884）；跨迁移清空（SM-05）；close 自动 ack；report(blocked/question) 清旧 ack（C1） |
| owner / claim | object\|null（**只读键**） | claim / report 续租 / sweep 回收 | claim={worker,token,claimedAt,leaseUntil}；租约默认 30min；token hex(16) 必换发（V6-14） |
| qa | object\|null（ONE_LEVEL） | reviewer 链/sandbox 闸消费 | qa.verdict==="pass" 是 closed 绿档凭证两腿之一 |
| skippedReason | string\|null | sweep cascade / upsert | cascade 恒写 "upstream_failed"；类型校验 :3897-3901 |
| timeline | event[] | 各写点 append | 事件形态 {at,event,summary}；append-only 惯例（唯一重写例外=echo 截断由 bg-sentinel，非本文件） |
| scope_paths / strict_scope / scope_violations / manifest | **scope 三键+manifest 指针** | 注册=upsert；violations/manifest **唯一合法写者=report close-out** | **whole-replacement 特例**：四者不进 ONE_LEVEL，整替即注册/审计语义（:1982-1993 注释）；scope_paths 入板前 F1 归一化（:3907-3915）；manifest 从 upsert 剥除（:3879） |
| updated_at | ISO | saveBoard/各写点 | 派生读面（lastResultAt/wake_failure）依赖它 |
| danglingRefSince | ISO（瞬态标记） | sweepGraph | 悬挂引用首见标记，次写清理 |
| lease_minutes | number | claim 入参 | 畸形租约兜底计算用（:2201） |

**白名单机制**（v0.4.1 起）：MERGEABLE_KEYS 18 键（:1967-1993）∪ ONE_LEVEL 4 键单层深合并（dispatch/blocked/pack/qa，子键 undefined 跳过，:2034-2038）；未知顶层键**丢弃并在响应 ignoredPatchKeys/ignored_keys 上报**（:1996-1998）——不是报错，是降级合并。

**读侧派生字段**（withComputed :1764-1786，response-only 零新存储）：wake_failure（W1 status∈RESULT_STATUSES[done,failed,blocked,question] ∨ W2 dispatch.agent_id 真值 ∨ W3 未 ack ∨ W4 dispatch.mode!=="workflow"）、t1_head（最新 report 事件 summary 头 160 字符，T1_HEAD_CAP :158）、artifacts_n/output_files_n/has_question/scope 摘要。**board list 紧凑行**（compactMissionRow :1798-1821）白名单=id/title/status/question/unacked/unread/t1_head/artifacts_n/output_files_n/scope_paths/strict_scope（+scope_violations 有值透出）；内部态（claim/dispatch/pack/manifest/wake_failure/ack 对象/timeline/original_prompt）不上 list 面，board get（compact 默认/full 豁免）与 probe 承载明细。

## 3. 写方清单（唯一写方=server 进程，临界区=根锁）

board.json **没有外部进程写方**——hooks/bg-sentinel/watcher 全是读方或别的文件族的写方。server 内写点（状态腿详见状态机卡 §3）：

| 写点 | 写什么 | 锚点 |
|---|---|---|
| board upsert（外部唯一状态门） | 白名单 patch+迁移守卫 | :3861-3960（剥只读/瞬态键 :3875-3884） |
| board ack | m.ack+timeline（不改状态） | :3995-4013 |
| board claim | owner/claim/status=running/dispatch.token 换发 | :4090-4159 |
| report | 状态腿+blocked 重写+artifacts/manifest/scope_violations+续租 | :4438-4645 |
| mailbox answer | blocked.blocked 回填+状态腿+auto-ack | :5040-5057 |
| mailbox gc | closed 迁 archive | :5110-5148 |
| context_pack / dispatch / sandbox:create | pack/scope_paths/dispatch 注册 | :1645-1653；:6350+；:7165-7177 |
| sandbox_apply | 直改 closed+auto-ack+applied 标记 | :7635（补偿 :7416-7418） |
| sweepGraph（每次板写同临界区） | unlock/cascade/租约回收/dangling | :2166-2298 |
| p2p_ask/p2p_answer/gcP2pFiles | 双侧 timeline echo（**仅 append，status/updated_at 零触碰**） | :4235-4238；:4297-4312 |

## 4. spool 事件信封引用的 board 字段面（M6-1 卡②素材）

> 卡②（spool）写事件信封全貌与目录协议；本节只钉**信封生成与消费所读写的 board 字段**——两卡的接缝。report 落箱与改板同临界区（v0.3.1 A1，:4436-4438）。

| 信封行为 | 消费的 board 字段 | 语义 | 锚点 |
|---|---|---|---|
| 鉴权（先于落箱） | `dispatch.token` | fail-closed：expectedToken 存在则必携且精确匹配，missing/empty/mismatch 全拒（V6-09）——**拒绝发生在落箱前=零事件**；--strict-tokens 连无 token mission 也拒（V6-19A） | :4442-4470 |
| 信封字段 `agent_id` | `dispatch.agent_id` | 直拷入信封（缺=null） | :4480 |
| closed 拒改板 | `status` | mission.status==="closed"：事件已落箱存档、board 不动（C5）；lessons 亦不记 | :4495-4507 |
| 成对鉴权 | `claim.worker` | claimHolder≠worker：事件落箱+板零改动+**不续租**+claimWarn（W-A1 方案 a：陌生者不得续租/翻状态） | :4509-4534 |
| blocked/question 重写 | `blocked` | 整对象重写 {question,asked_at,answered:false,answer:null,answered_at:null}——stale answered=true 不得漂白（C1） | :4538-4543 |
| scope 审计 | `scope_paths` | milestone/done 的 files_touched 比对基线；违例=timeline scope_violation 事件+mission.scope_violations 整替重写（clean sweep 清旧发现 :4570-4574） | :4548-4574 |
| done 回写 | `artifacts` + `manifest` | artifacts append-only 去重合并；manifest 指针=closeOutManifest 产物（manifest 唯一合法写者） | :4582-4606 |
| 续租 | `claim`（leaseUntil） | 仅 claim.worker===worker 续（V6-17）；p2p 事件不续租 | :4607-4620；:2138-2140 |
| 完成即唤 | `dispatch.mode` | kind=done 且 mode==="headless" → wakeQueueProduce（队列文件在 result-dir 旁 wake-queue/，非 board） | :4643-4647 |
| timeline append | `timeline` | `report:<kind>` 事件；t1_head/lastResultAt/wake 检查的读源 | :4544-4547 |

反向引用（board 读 spool）：compactMissionRow 的 `unread` 计数=countUnreadSafe（每 mission 一次目录 IO，best-effort，畸形 id 记 0 不炸 list，QA P2-b）；close 类路径的 unread 告警消费同一计数（V6-49 修复面：畸形事件文件 rename `<file>.bad` 隔离防假 unread 永挂，:3368-3398）。

## 5. p2p/ 记录族

| 项 | 内容 | 锚点 |
|---|---|---|
| 布局 | `p2p/p2p-<id>.json`；id=`<15位零填充epochMs>-<4hex>`；文件名正则 `^p2p-([A-Za-z0-9._-]+)\.json$` | :3692-3697 |
| 记录 schema | `{v:1, id, from:{mission_id,worker}, to:{mission_id,worker}, question, status:"open", created_at, answered_at:null, answer:null, expired_at:null, echo:{ask,answer:null}}`；question/answer ≤ DETAILS_MAX_CHARS(4000) 存储侧截断 | :4216-4231；:4178-4179 |
| 状态机 | open → answered（p2p_answer）/ expired（TTL sweep，默认 30min，--p2p-ttl-min 可调；畸形/未来 created_at 读作未到期=保守方向） | :4292-4295；:3786-3834 |
| 写方 | p2p_ask / p2p_answer / TTL sweep（saveP2pRecord 原子写）；**asker 前置态=blocked/question**（P2P_ASK_PRECONDITION_STATUSES，主等待通道 report(question) 恒可用） | :3714-3717；:4188-4193 |
| 鉴权（p2pTokenGate） | expectedToken=mission.dispatch.token：有 token 则必携且匹配（缺/错=硬 ToolError，**无 report 的 archive-anyway 回退——p2p 无板写可扣**）；--strict-tokens 关无 token 面；claim 持有者≠worker 拒（成对鉴权）。**调用携各自 mission 自有 token**（asker 用 from 侧 token，answerer 用 to 侧 token） | :3747-3778 |
| 目标校验（ask） | target 存在、非终态（P2P_TERMINAL_STATUSES=[done,failed,skipped,closed]）、to_worker=target 当前持有者（owner∥claim.worker 在场时强制）——不合法**不建档**（P2P 是优化通道，降级=report(question) 恒可用）；禁止自问自答 | :4194-4214 |
| 边界②（answer 零触碰） | p2p_answer 只写 p2p 记录+双侧 echo；提问方 mission 的 status/字段/租约**零触碰** | :4254-4259 |
| 双侧强制 echo（边界③） | appendP2pEcho 只 append timeline，**不改 status/updated_at**（echo 是审计事实非状态变更；liveness 靠 timeline `at`，哨兵 lastActivityMs 计任意 timeline 事件=echo 自动计入，防 updated_at 语义污染） | :3726-3732；:4234-4236 |
| 消费语义 | **advisory 数据**：读失败/损坏当 absent，无 quarantine（loadP2pRecord 双 catch 返 null）；提问方自行消化答案后经自己的 report 入账——mission 状态演进仍只经 report | :3699-3712 |
| 懒扫面 | gcP2pFiles 骑 startup+p2p_ask/p2p_answer+board list（sweepGraph-on-write 哲学）；countOpenP2p 骑 board list（open_p2p 计数） | :3835；:3838-3853；:4036；:4047 |

## 6. 失效语义（缺文件/损坏/半写/竞态/时钟漂移 × 读方行为）

| 情形 | 行为 | 分类 |
|---|---|---|
| board.json 缺失 | 重查 3×50ms → recovered 档恢复 → 空板 | 自愈 |
| board.json 损坏（parse 失败/非对象） | rename `.corrupt-<ts>` 隔离（证据保留），空板重建，`board_degraded_from` 一次性上报 | 自愈+留痕 |
| board.json 读 IO 错误（非缺失） | ToolError 上抛（不隔离） | fail-loud |
| 半写 | 原子写（temp+rename）杜绝；历史上 unlink-then-rename 窗口由 A2 三重查兜住 | 自愈 |
| 竞态（跨进程写） | 全部读改写在根锁内；隔离 rename 输家容忍；claim CAS 锁内仲裁；answers 冲突序号递增（A3 同族） | 锁内仲裁 |
| 未知键混入 | 丢弃+ignoredPatchKeys 上报（不炸不静默吞） | 降级合并 |
| p2p 记录缺失/损坏 | 当 absent（advisory 数据，无隔离） | 静默降级（设计内） |
| 时钟漂移 | B7：负 elapsed 钳 0（wake_failure 分钟数 max(0,·)）；租约畸形走龄期兜底非裸时钟 | 钳制 |
| board 上的畸形 mission（无 id 等） | 遍历侧 `m &&` 守卫跳过（findIndex/find/filter 全部 falsy-safe） | 静默跳过 |

## 7. 断言锚

- **crv6-statemachine**：SM-01..08（closed 双门/白名单/reopen/清 ack/租约/answer 联动/closed 拒改板）+ A-v070-P2P-01..06（token 边界/零触碰/回放/失效/前置态/活性）+ WB-SRV-a..g（完成即唤队列）+ FA-1..5（dispatch 播种）。
- **crv5-auth**：AUTH-01..08——fail-closed token 门（含"三探针零事件落箱+板面零改动"）、成对鉴权、claim 必换发。
- **crv2-pack**：组包对拍基线（pack 字段面）；**crv1-scope**：scope_paths 注册/审计；**root-contract**：root 定位链（本卡的路径前置）。
- **LM-05**（lint-manifest，M1-3 注册）：本卡常量/函数名（MERGEABLE_KEYS/ONE_LEVEL/p2pTokenGate 等）server.mjs grep 可见+卡存在非空。

## 8. 维护规则

- 本卡唯一写方=协议卡批 mission（W1-M1-2 首写）+ W6-M6-1（卡②引用本节消费素材；若信封字段演进，卡②与 §4 表同波同步）+ 后续 board 字段演进波次随改。
- 新增 mission 字段：先入 MERGEABLE_KEYS（或 ONE_LEVEL/scope 整替组）并过 §2 表补行；**从未**把未知键静默入库当作兼容手段（v0.4.1 QA 前车）。
- p2p 记录 schema 演进：`v` 字段递增+loadP2pRecord 容错策略复核（advisory 语义不许升级成 fail-loud，除非同时给主控加显式信号面）。
