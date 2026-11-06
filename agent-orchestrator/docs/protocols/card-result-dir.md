# 契约卡④：dispatch result-dir 三件套（分形态两节）

> **v1.6 W-p parked 注记（卡面 -p 语境句）**：本卡所述 result-dir 三件套为 **headless（-p）专属面**——v1.6 W-p 随 -p 通道剥离归档 parked/agent-orchestrator/（LM-05 锚行随迁出删除；恢复=parked README 指引+锚行回植），本卡 headless 面=历史语义存档（§1）；nested 形态零消费 result-dir（板语义 busy 闸，card-board 面）。

- **归属模块**：mcp/tool-dispatch.mjs（headless 面 parked——同步段/捕获/busy 闸=历史语义；nested=组装出口现役）+ hooks/dispatch-runner.mjs（detached 子进程，唯一 result 文件写者〔parked〕）；wake-queue twin=mcp/tool-report.mjs `wakeQueueDirOf`（零共享依赖）
- **脆度评级**（面广度×后果重度双轴）：**低-中**——协议年轻（v1.1.2 新落、v1.2 M3-1 又补三层兜底）、消费方仅 server 的闸/捕获面；但「index 缺失=在飞」的 busy 闸语义一旦失效即双跑或永久锁，后果中重
- **历史事故回链**：R2 静默失败（≤8s 组合捕获消除）、runner 早期失败只写 error=busy 闸永久锁（M3-1 Q2 双入口堵死）、taskkill /F 强杀无 index（O10 超龄豁免兜底）、l-20261026-792cf9（零侧车判据由来）、l-20261027-cc2f89（error.json 侧车价值实锤）
- **锚点声明**：本卡行号系总装时点（v1.2 源码，M3-1 已落）实测，**不作跨版引用**（l-20261022-6a14d6）；函数名/常量名双锚为定位权威

---

## 0. 形态分节声明

result-dir 三件套按拉起形态分面：**headless**（§1，v1.6 W-p 起 -p 通道剥离归档 parked——历史语义存档+锚清单）与 **nested**（§6，v1.2 批 3 M5-1 已落地——组装出口不 spawn、零 result 文件；v1.6 W3a 编号化改写=实码描述）。headless 节原断言=crv6-resilience DSP 组（随 parked 转历史存档），nested 节断言=NST 组（同套件，现役）。

## 1. headless 操作（已 parked at v1.6.0）

-p 通道已剥离归档：parked/agent-orchestrator/（恢复指引=同目录 README 六步）。原 §1-§5 操作细节（文件面布局/index 字段表/读方清单/失效语义/wake-queue 族）随归档迁移，此处保留锚清单：

- **文件族**：`<root>/context/dispatch-results/` 三件——`<mission_id>-<startedMs>.index.json`（busy 闸判据文件名族 `^<id>-\d+\.index\.json$`，正则转义 id）、`<mission_id>-<ISO-stamp>.error.json`（stamp 与 index 不同构：ISO-stamp vs epochMs，diff 扫描两正则互不干扰）、`<sessionId>.json`（信封+mission/exit 元数据）；旁挂=`dispatch-logs/<id>-<stamp>.prompt`+`.runner.log`（「同步段真实跑过」时间锚，O10 判据素材）、`dispatch-model-seed/<mission_id>.json`（env 重定向副本）、`wake-queue/`（result-dir 同级）。写者承诺：三件均 atomicWriteJson（temp+rename）。
- **index 字段（Q3b 死信摘要）**：outcome∈`result`/`error`/`timeout`（wake 事件同字段携带，主控被唤即知死因免开 index，server twin 同文）+`timed_out`/`killed`/`exit_code`/`result_path`/`error_path`/`log_path`/`session_id`（全链=timeout-min-guide.md）；兜底 error 字段=`runner_early_fail: <message>`/`runner_killed: <reason>`。
- **函数/常量锚**：runner 三写点 `finish()`（正常收场）/`fail()`（早期失败补写 index——M3-1 Q2 双入口同堵，旧形态只写 error 致闸锁死已堵）/`writeKilledIndex`（uncaughtException/unhandledRejection/exit handler，killed:true——indexWritten 置位后写败由本腿兜底）；闸 `dispatchHasResultIndex`（任一 index 在场=上轮已收场→放行；缺席盘点侧车 `dispatchMissionSidecars` 全超龄 >ORCH_DISPATCH_BUSY_STALE_MIN 默认 120min 豁免附 warning，taskkill /F 强杀残余面=DP2b Q2 边界；零侧车不豁免=l-20261026-792cf9，crv2 W4-DISPATCH-08 黑盒语义）；捕获 `dispatchCaptureOutcome`（≤8s 组合捕获：rollout diff 优先+results diff，超窗 session_pending:true）+`dispatchScanNewResults`/`errorRe`（只认 pre-spawn 快照后新文件——残留不干扰）+`dispatchFailureSummary`（log_tail 末行 `Error:` 上浮；O8=a hint 分叉）；种子 `dispatchSeedModelConfig`；探活 `ensureSentinelFamily()`（W9 触发面②「无哨兵不派发」，M5-1 组装出口同接）；twin `wakeQueueDirOf`（server 侧=mcp/tool-report.mjs，零共享依赖）。
- **wake-queue 族**：`<wake-queue>/<ms>-<mission_id>.json` wx 独占创建（EEXIST=他人已记，该方认领；字段含 mission_id/worker/session_id/result_path/outcome/timed_out/exit_code/created_at/source）+claim.json（单赢家认领 acquired_at→detached spawn wake-kick→unlink；crash 残留带 acquired_at 可识别，超龄回收归 WB 波裁定）；毒丸容忍=只写己件不读目录既有内容（坏件天然隔离）。

**与 spool 邮箱的分工（互指不合并）**：mission 事件信封主投递/消费面=spool（`card-spool.md`，unread/read/answers 三目录协议；生产者①=server report kind=done 且 mode==="headless"，落箱面归卡② §4）；本卡 wake-queue 仅 headless 完成即唤事件族（生产→认领即 unlink，无消费协议面）——两族零共享依赖，card-spool.md §4 已互指本卡。

## 6. nested 形态（v1.2 批 3 M5-1 已落地；v1.6 W3a 回执编号化改写——本节=实码描述）

> **v1.6 W3a 组装退役注记（C-07 §6 卡面同步）**：组装链整体退役（R1）——`buildDispatchPrompt` 纯区/`BUILD-DISPATCH-PURE` 标记区/审计 prompt 落盘随 `dispatch-prompt.mjs` 整文件退役删除；nested 回执编号化（`prompt`/`prompt_path`/`chars`/`persona` 四字段删除）；审计面由 bg-gate 运行时 CONTRACT 头 presence 检测替代。

`dispatch(mission_id, mode:"nested")` 编号出口（M5-1 落地；v1.6 W3a 编号形制）：

- **不 spawn 进程、零 result 文件、零组装文本**：锁内派发面校验（pack 解析+CONTRACT 三行解析+token 鉴权），返编号回执 `{ok, mode:"nested", mission_id, worker, channel, token, pack_path, lock_hold_ms}`——首条消息由主控按 DP-3 固定指针模板（SKILL §3）机械填充回执字段，worker 自取包（`pack_path` 沙箱场景=绝对路径，供模板「先 Read 任务包」填充）。result-dir 三件套（index/error/result）与 model-seed 对 nested **整体缺席**：无 runner、无播种、无 ≤8s 组合捕获（wrapper 按 `__nested` 标记跳过）。
- **busy 闸按 mode 分叉**：nested 在飞判据=**板语义**（status=dispatched 且 worker 结果未落板——派发凭据已交付主控；running 已被状态闸拦），**不消费 result-dir index**；headless 闸（§3/§4，parked 存档）按 mission.dispatch.mode 判 headless，天然不消费 nested mission。分叉按 mission 侧 mode 判非按请求 mode。恢复路径=board upsert `status:"drafted"`（dispatched→drafted 合法腿）后重派，或等 worker report。
- **内嵌校验（派发纪律靠工具面保证，§8.7——bg-gate 对宿主 Agent 调用系提示面非防线〔PT-5〕；v1.6 W3a 起 bg-gate presence 面=运行时真消息审计）**：①CONTRACT 三行——派发面 `dispatchParseContract` 解析强制，缺三行在此前抛错；②token 鉴权（p2pTokenGate 同语义）——包 CONTRACT token 必须 ≡ mission.dispatch.token，无板 token 且 `--strict-tokens` 拒收（与 report 闸同向）；③scope_paths 预检——yolo 闸两形态同闸（worker 类非空写集）。
- **记账**：`upsertMission` internal 落 `dispatch={mode:"nested", agent_id:null, task_id:null, session_id:null, spawned_by_session}`（W3 归因锚消费面；agent_id 留空→哨兵 classify 要求 agent_id→**nested 默认不盯**，主控在场直收）。审计 prompt 落盘**已退役**。
- **完成通道**：宿主 Agent 返回+worker report 双通道，无 wake-queue 依赖（生产者①限 `mode==="headless"`〔parked 存档〕、生产者②系 runner〔parked〕——nested 零新文件族）。
- **消费面影响清单（M5-1 实测，W3a 复核仍真）**：result-dir 的 server 侧读方全部位于 headless 派发路径内（已 parked），nested 分支在这些点之前返回、天然不消费；bg-sentinel 与 probe 对 dispatch-results **零读**——result-dir 缺席对哨兵/probe 零影响。
- **断言锚**：crv6-resilience NST 组（A-v0120-NST；v1.6 W3a 改写后形态=编号字段集+负向四缺席/busy 分叉三态/内嵌校验两腿/schema·接线静态锁——NST-01b/01c 两腿随 prompt 形状/审计落盘 subject 消失退役）。

## 7. 断言锚

- **crv6-resilience**：DSP 组（v1.2 M3-1，随 -p parked 转历史存档）；**NST 组（A-v0120-NST；v1.6 W3a 改写后形态）——编号字段集+负向四缺席/busy 分叉三态/内嵌校验两腿/schema·接线静态锁（NST-01b/01c 随组装退役删除）**；W4-DISPATCH 组（crv2-pack）busy 闸黑盒语义；WB-SRV 系（wake 队列产事件）。
- **LM-05**（lint-manifest，M1-3 注册）：本卡常量/函数名源码 grep 可见+卡存在非空（v1.6 W-p：headless 捕获面四锚+dispatch-runner 行随 parked 删；v1.6 W3a：dispatch-prompt 锚行 `DISPATCH_DEFAULT_TIMEOUT_MIN` 随文件退役删除——现役锚面=dispatch-core 残余与板语义面）。
- **断言裸区声明**：wake-queue claim.json 残留超龄回收（WB 波遗留）与 error.json log_tail 摘要上浮的端到端断言暂薄——修复波次候选，本卡显式标注。

## 8. 维护规则

- index/error 字段演进：§1 锚清单字段+runner/server twin 双侧同改（Q3b 前例：同文 twin 零共享依赖，改一侧必改另一侧，crv6 对拍腿锁定）。
- 文件名协议（两 stamp 形态）变更：先改 §1 并全读方盘点（闸正则/diff 正则/wake 文件名三面联动）。
- nested 落地（W5-M5-1）：§6 已勘误回写为实码描述（§0 同步转正）；nested 为纯新增分支，-p 链还原即回现状。
