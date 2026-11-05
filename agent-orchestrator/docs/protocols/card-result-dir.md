# 契约卡④：dispatch result-dir 三件套（分形态两节）

> **v1.6 W-p parked 注记（卡面 -p 语境句）**：本卡所述 result-dir 三件套为 **headless（-p）专属面**——v1.6 W-p 随 -p 通道剥离归档 parked/agent-orchestrator/（hooks/dispatch-runner.mjs 迁出、dispatch-core headless 分支拆除、mode enum 收窄 nested），本卡全节=历史语义存档（C-07 §6 卡面同步改写随 W3a 波接手；LM-05 锚行随迁出删除——dispatch-core 捕获面四锚+dispatch-runner 行；恢复=parked README 指引+锚行回植）。nested 形态零消费 result-dir（板语义 busy 闸，card-board 面）。

- **归属模块**：mcp/tool-dispatch.mjs（dispatch 同步段+组合捕获+busy 闸）+ hooks/dispatch-runner.mjs（detached 子进程，唯一 result 文件写者）；wake-queue 旁挂目录归本卡（runner 同文 twin 在 mcp/tool-report.mjs `wakeQueueDirOf` 一份，零共享依赖纪律）
- **脆度评级**（面广度×后果重度双轴）：**低-中**——协议年轻（v1.1.2 新落、v1.2 M3-1 又补三层兜底）、消费方仅 server 的闸/捕获面；但「index 缺失=在飞」的 busy 闸语义一旦失效即双跑或永久锁，后果中重
- **历史事故回链**：R2 静默失败（ok:true+pending 掩盖快死→≤8s 组合捕获消除）、runner 早期失败只写 error 不写 index=busy 闸永久锁（v1.2 M3-1 Q2 双入口堵死）、taskkill /F 强杀无 index（O10 超龄豁免兜底）、l-20261026-792cf9（手写 mode=headless 零侧车形态——判据不取「侧车全无」腿的由来）、l-20261027-cc2f89（PROVIDER_BUSINESS_ERROR 1302 死亡实锤 error.json 侧车价值）
- **锚点声明**：本卡行号系总装时点（v1.2 源码，M3-1 已落）实测，**不作跨版引用**（l-20261022-6a14d6）；函数名/常量名双锚为定位权威

---

## 0. 形态分节声明

result-dir 三件套按拉起形态分两节：**headless**（§1-§5，runner 写者、index 判据、wake-queue 族）与 **nested**（§6，v1.2 批 3 M5-1 已落地——组装出口不 spawn、零 result 文件）。§6 原系 W6-M6-1 按设计稿预写的契约节，M5-1 落地后已勘误回写为实码描述（出入点：回执字段全集/记账细节/审计 prompt 仍落盘——预写未提）；headless 节全部断言可跑（crv6-resilience DSP 组），nested 节断言=NST 组（同套件）。

## 1. 文件面与布局（headless）

| 项 | 内容 | 锚点 |
|---|---|---|
| 结果目录 | `<root>/context/dispatch-results/`（server 与 runner `--result-dir` 双方共识） | mcp/tool-dispatch.mjs results 目录共识 |
| **index.json** | `<mission_id>-<startedMs>.index.json`（startedMs=epochMs）；mission→结果的寻址 sidecar，**busy 闸的唯一判据文件名族**（`^<id>-\d+\.index\.json$`，正则转义 id） | 写：runner finish()/writeKilledIndex/fail()；闸：`dispatchHasResultIndex`（mcp/tool-dispatch.mjs） |
| **error.json** | `<mission_id>-<ISO-stamp>.error.json`（stamp=startedAt 去冒号点）——注意与 index 的 stamp **不同构**（ISO-stamp vs epochMs）：diff 扫描两正则各自匹配，互不干扰 | fail() :266；finish() :378（hooks/dispatch-runner.mjs）；errorRe（mcp/tool-dispatch.mjs `dispatchScanNewResults`） |
| **result.json** | `<sessionId>.json`——信封+mission/exit 元数据（有 sessionId 才写） | finish() :366-376 |
| 日志旁挂 | `<root>/context/dispatch-logs/<id>-<stamp>.prompt`（server 同步段先写）+ `.runner.log`（runner 起手即写）——**「dispatch 同步段真实跑过」的时间锚**（O10 判据素材） | mcp/tool-dispatch.mjs 同步段先写；runner :318-325 |
| 模型种子旁挂 | `<root>/context/dispatch-model-seed/<mission_id>.json`（env 重定向副本，原配置零触碰） | `dispatchSeedModelConfig`（mcp/tool-dispatch.mjs） |
| wake-queue 旁挂 | `<root>/context/wake-queue/`（=result-dir 同级 `path.dirname(resultDir)+/wake-queue`）——完成即唤事件族，归本卡 §5 | `wakeQueueDirOf` runner :63-65；server twin（mcp/tool-report.mjs） |

写者承诺：三件均 atomicWriteJson（temp+rename）；目录 mkdir recursive 自建。

## 2. index.json 字段表（Q3b 死信摘要已落）

| 字段 | 类型/值域 | 语义 |
|---|---|---|
| mission_id / worker / session_id | string\|null | worker 取 prompt 尾 [worker] 行；session_id 仅信封可解析时非空 |
| result_path / error_path / log_path | string\|null | 三向指针（result 与 error 互斥单侧非空常态） |
| exit_code | number\|null | CLI 进程 close 码；杀树路径 null |
| timed_out | boolean | 超时杀树旗标（timeout-min-guide.md 承载全链） |
| outcome | enum | **Q3b 死信摘要**：`result`（信封落盘）/`error`（信封不可解析或 runner 早期失败）/`timeout`（杀树）——wake 事件同字段携带，主控被唤即知死因免开 index（runner :390-407；server twin 同文） |
| killed | boolean（仅 writeKilledIndex 路径） | runner 进程自身死亡兜底标记，error 字段=`runner_killed: <reason>` |
| error | string（兜底路径） | `runner_early_fail: <message>`（fail() 补写腿）或 `runner_killed: …` |
| started_at / exit_at | ISO | 时间账 |

写点三态（v1.2 M3-1 Q2 双入口同堵后的全集）：
1. **正常收场**（finish）：信封可解析→result+index（outcome=result）；不可解析→error.json+index（outcome=error）——:356-407；
2. **早期失败**（fail）：error.json+**补写 index**（error=runner_early_fail，outcome=error）——spawn 失败/参数缺失/prompt 不可读路径，旧形态只写 error 致闸锁死已堵——:263-300；
3. **进程自身死亡**（writeKilledIndex）：uncaughtException/unhandledRejection/exit handler 补写 index（killed:true，outcome=error）——:203-261；indexWritten 置位于 index 写入成功后；写败=置位未发生，writeKilledIndex 兜底接手（killed:true outcome=error）。

## 3. 读方清单（全部在 server 侧）

| 读方 | 时机 | 行为 |
|---|---|---|
| busy 闸（toolDispatchInner） | dispatch 前 | dispatchHasResultIndex：该 mission 任一 index 在场=上轮已收场→放行；缺席→盘点侧车（dispatchMissionSidecars：results∪logs 两目录 `<id>-` 前缀 mtime）全超龄（>ORCH_DISPATCH_BUSY_STALE_MIN，默认 120min）→豁免放行附 warning；否则拒双跑——mcp/tool-dispatch.mjs busy 闸 |
| ≤8s 组合捕获（dispatchCaptureOutcome） | dispatch 后（锁外） | 100ms tick 双面轮询：rollout diff（新 model-io 文件 stem=已 boot）优先；results diff（dispatchScanNewResults）读新 index/error——index 携 session_id→成功回执；否则 failed+error 摘要；超窗→session_pending:true（真慢启动契约）——mcp/tool-dispatch.mjs `dispatchCaptureOutcome` |
| diff 扫描防残留（dispatchScanNewResults） | 捕获内 | 只认 pre-spawn 快照（resultsBefore，锁内采集）之后新出现的文件——上轮残留侧车不干扰本轮判定——mcp/tool-dispatch.mjs `dispatchScanNewResults` |
| hint 分叉（toolDispatch failed 分支） | 快死回执 | index 已落→「直接重派（busy 闸不拦）」；index 未落（强杀残余/历史存量）→如实说明+删侧车或等超龄豁免——O8=a 迷路面消除——mcp/tool-dispatch.mjs hint 分叉 |
| failure 摘要（dispatchFailureSummary） | failed 回执 | error.json 的 log_tail（≤4000 字符）末行 `Error:` 原样上浮（≤300 字符）；`/Select a model/i` 命中→modelError 分支 hint（播种面指引）——mcp/tool-dispatch.mjs `dispatchFailureSummary` |
| W9 触发面②（已落） | dispatch 派发钩子 | M9-1 落 headless 同步段 `ensureSentinelFamily()`（「无哨兵不派发」探活）；M5-1 组装出口（nested 分支）同接同函数——探活复用，两形态一致 |

## 4. 失效语义（headless）

| 情形 | 行为 | 分类 |
|---|---|---|
| index 缺失（正常在飞） | busy 闸拒双跑——「index 存在=上轮已收场」的对偶语义 | 设计内 |
| runner 早期失败（spawn 前后即死） | fail() 双写 error+index → 闸解锁、捕获面 ok:false+hint | 自愈（Q2 入口②） |
| runner 进程自身崩溃 | exit/uncaught handler 补写 killed index → 闸解锁 | 自愈（Q2 入口①） |
| **taskkill /F 强杀先于全部 handler** | OS 不保证 exit handler：无 index 残留 → 闸持锁至**超龄豁免**（默认 120min，ORCH_DISPATCH_BUSY_STALE_MIN 可调）或手动删该 mission 侧车 | 显式兜底（残余面如实文档化，DP2b Q2 边界） |
| 上轮侧车残留干扰本轮 | diff 扫描只认快照后新文件 | 结构免疫 |
| 判据陷阱：零侧车（手写 mode=headless 的板记录） | **不豁免**——零侧车=同步段从未跑过=never-dispatched≠孤儿，维持拒双跑（l-20261026-792cf9） | 判据边界（crv2 W4-DISPATCH-08 黑盒语义保持） |
| error.json 缺失+无 index | 捕获 failed 分支降级文案（exit_code 无侧车）——不再静默 | fail-loud（R2 消除） |
| result.json 侧车缺失（index 有 session_id 但 result 未落） | index 仍是寻址权威；result 属诊断面增强非闸判据 | 降级可用 |
| 时钟/_mtime 漂移 | 豁免判据纯 mtime 侧车龄期——时钟跳变下误豁免方向=放行重派（可见 warning），不误锁 | 保守方向声明 |

## 5. wake-queue 旁挂族（headless 完成即唤）

| 项 | 内容 | 锚点 |
|---|---|---|
| 事件文件 | `<wake-queue>/<ms>-<mission_id>.json` wx 独占创建（EEXIST=他人已记，该方认领）；字段含 mission_id/worker/session_id/result_path/**outcome/timed_out/exit_code（Q3b）**/created_at/source | runner :67-95 |
| claim.json | 单赢家认领（wx，acquired_at）；认领者 detached spawn wake-kick 后 unlink；认领后 spawn 前 crash 残留带 acquired_at 可识别（超龄回收归 WB 波裁定） | runner :96-125 |
| 生产者① | server report（kind=done 且 mode==="headless"）——mcp/tool-report.mjs toolReport |  |
| 生产者② | runner finish()（收场即产，无论信封成败）——:412-425 |  |
| 毒丸容忍 | 只 wx 写自己的文件、不读目录既有内容——坏件天然隔离 | runner :62 注释 |

## 6. nested 形态（v1.2 批 3 M5-1 已落地；v1.6 W3a 回执编号化改写——本节=实码描述）

> **v1.6 W3a 组装退役注记（C-07 §6 卡面同步）**：组装链整体退役（R1）——`buildDispatchPrompt` 纯区/`BUILD-DISPATCH-PURE` 标记区/审计 prompt 落盘（`<root>/context/dispatch-logs/` nested 半族）随 `mcp/tool-dispatch/dispatch-prompt.mjs` 整文件退役删除；nested 回执编号化，`prompt`/`prompt_path`/`chars`/`persona` 四字段删除。审计面由 bg-gate 运行时 CONTRACT 头 presence 检测替代（检测对象=主控实发的宿主 Agent prompt 真消息）。headless 节（§1-§5）=parked 历史语义存档不变。

`dispatch(mission_id, mode:"nested")` 编号出口（v1.2 M5-1 落地；v1.6 W3a 编号形制）：

- **不 spawn 进程、零 result 文件、零组装文本**：锁内派发面校验（pack 解析+CONTRACT 三行解析+token 鉴权），返编号回执 `{ok, mode:"nested", mission_id, worker, channel, token, pack_path, lock_hold_ms}`——首条消息由主控按 DP-3 固定指针模板（SKILL §3）机械填充回执字段，worker 自取包（`pack_path` 沙箱场景=绝对路径，供模板「先 Read 任务包」填充）。result-dir 三件套（index/error/result）与 model-seed 对 nested **整体缺席**：无 runner、无播种、无 ≤8s 组合捕获（wrapper 按 `__nested` 标记跳过）。
- **busy 闸按 mode 分叉**：nested 在飞判据=**板语义**（status=dispatched 且 worker 结果未落板——派发凭据已交付主控；running 已被状态闸拦），**不消费 result-dir index**；headless 闸（§3/§4，parked 存档）按 mission.dispatch.mode 判 headless，天然不消费 nested mission。分叉按 mission 侧 mode 判非按请求 mode。恢复路径=board upsert `status:"drafted"`（dispatched→drafted 合法腿）后重派，或等 worker report。
- **内嵌校验（派发纪律靠工具面保证，§8.7——bg-gate 对宿主 Agent 调用系提示面非防线〔PT-5〕且不知 mission scope；v1.6 W3a 起 bg-gate presence 面=运行时真消息审计）**：①CONTRACT 三行——派发面 `dispatchParseContract`（下沉件，自 `dispatch-prompt.mjs` 逐字搬运）解析强制，缺三行在此前抛错；②token 鉴权（p2pTokenGate 同语义）——包 CONTRACT token 必须 ≡ mission.dispatch.token，无板 token 且 `--strict-tokens` 拒收（与 report 闸同向）；③scope_paths 预检——yolo 闸两形态同闸（worker 类非空写集）。
- **记账**：`upsertMission` internal 落 `dispatch={mode:"nested", agent_id:null, task_id:null, session_id:null, spawned_by_session}`（W3 归因锚消费面；agent_id 留空→哨兵 classify 要求 agent_id→**nested 默认不盯**，主控在场直收）。审计 prompt 落盘**已退役**（v1.6 W3a）——派发事实时间锚=板 timeline dispatch 事件+bg-gate 运行时 presence 检测。
- **完成通道**：宿主 Agent 返回+worker report 双通道，无 wake-queue 依赖（生产者①限 `mode==="headless"`〔parked 存档〕、生产者②系 runner〔parked〕——nested 零新文件族）。
- **消费面影响清单（§9.7 首步盘点结论，M5-1 实测；v1.6 W3a 复核仍真）**：result-dir 的 server 侧读方全部位于 headless 派发路径内（已 parked），nested 分支在这些点之前返回、天然不消费；bg-sentinel 与 probe 对 dispatch-results **零读**——result-dir 缺席对哨兵/probe 零影响。
- **断言锚**：crv6-resilience NST 组（A-v0120-NST；v1.6 W3a 改写后形态=编号字段集+负向四缺席/busy 分叉三态/内嵌校验两腿/schema·接线静态锁——NST-01b/01c 两腿随 prompt 形状/审计落盘 subject 消失退役）。

## 7. 断言锚

- **crv6-resilience**：DSP 组（v1.2 M3-1，随 -p parked 转历史存档）；**NST 组（A-v0120-NST；v1.6 W3a 改写后形态）——编号字段集+负向四缺席/busy 分叉三态/内嵌校验两腿/schema·接线静态锁（NST-01b/01c 随组装退役删除）**；W4-DISPATCH 组（crv2-pack）busy 闸黑盒语义；WB-SRV 系（wake 队列产事件）。
- **LM-05**（lint-manifest，M1-3 注册）：本卡常量/函数名源码 grep 可见+卡存在非空（v1.6 W-p：headless 捕获面四锚+dispatch-runner 行随 parked 删；v1.6 W3a：dispatch-prompt 锚行 `DISPATCH_DEFAULT_TIMEOUT_MIN` 随文件退役删除——现役锚面=dispatch-core 残余与板语义面）。
- **断言裸区声明**：wake-queue claim.json 残留超龄回收（WB 波遗留）与 error.json log_tail 摘要上浮的端到端断言暂薄——修复波次候选，本卡显式标注。

## 8. 维护规则

- index/error 字段演进：§2 表补行+runner/server twin 双侧同改（Q3b 前例：同文 twin 零共享依赖，改一侧必改另一侧，crv6 对拍腿锁定）。
- 文件名协议（两 stamp 形态）变更：先改 §1 并全读方盘点（闸正则/diff 正则/wake 文件名三面联动）。
- nested 落地（W5-M5-1，2026-10-28 勘误完成）：§6 节已由 M5-1 勘误回写为实码描述（§0 声明同步转正）；headless 协议面零触碰承诺兑现——nested 为纯新增分支，-p 链还原即回现状（crv2-pack 字节基线 82/82 为证）。
