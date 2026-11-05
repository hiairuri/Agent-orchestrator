# agent-orchestrator 设计总纲（DESIGN.md）

> **【指向性声明（重写后权威）】**本文以**本头声明为权威**，正文与头声明冲突处以本声明为准。本文=**机制总纲+入口指针**：读者定位是「读完建立系统认知，再按指针取版本态事实」，**不是**编码照写规范。本文**不记录**版本号、行号、文件数、工具数等任何会随版本漂移的计数——版本态事实一律外指（§1 权威分工表）；确需指涉版本时一律写「见 plugin.json」。本文由 `tests/suites/po-static.mjs` 的 DESBAN 组机械守护（版本号字面／计数句法／独占权威声明三禁＋协议卡索引双向覆盖）。行为契约与本文冲突时以 SKILL 为准；协议物契约与本文冲突时以契约卡为准。

总装重写时点：2026-10-28（W7-M7-1；历史正文含全部版本增量章节整体退役至 git 历史与 workspace `designs/` 设计链——考古走 git log 与 designs，不走本文）。

一句话使命：让 ZCode 主控 agent 成为真正的任务指挥官——能派发、能并行、能分叉、能被提问并作答后让子代理继续、能恢复中断（同会话与跨会话），且在它想收工时被 hook 拉回来清点未竟事项。

---

## 1. 读者定位与权威分工（总纲+指针）

本文只写**不随版本漂移的稳定机制**。任何数量、清单、行号、版本号都属于版本态快照，本文一律不载，按下表外指：

| 想知道什么 | 权威指针 |
|---|---|
| 插件版本、工具/角色/命令/hooks 事件注册面 | `.zcode-plugin/plugin.json`（注册字段）＋ `mcp/server.mjs` 工具注册表 |
| 行为契约与主控操作手册 | `skills/agent-orchestrator/SKILL.md`（本文引用章号均经 DESBAN 校验真实） |
| 回归面与断言权威 | `tests/run-all.mjs` 实时输出＋ `tests/assertions/` 版本权威档＋ `tests/module-index.md` |
| 演进决策链与实测记录 | workspace `designs/` 目录（总装稿与 findings 系列） |
| 协议物契约（文件/字段/失效语义） | `docs/protocols/` 契约卡族（§3 索引） |

**显式非目标声明**（本文不做的事）：

- 不记录版本计数、行号、文件数、工具数——任何数字以 plugin.json 与 run-all 实时输出为准（字面量锁恒为台账非门禁；机制常量由归属套件的钉族承载，不入本文）；
- 不复述任务包模板与工具 schema——逐字权威在 SKILL 第 3 章、第 14 章与 server 注册表；
- 不做编码照写规范——旧角色「编码子代理可据此直接照写代码」已随重写退役；
- 不做独占权威声明——权威分工见上表：行为面冲突以 SKILL 优先，协议物面冲突以契约卡优先，本文内部冲突以头声明为准。

## 2. 六子系统机制总纲

### 任务板与状态机（board）

`board.json` 是唯一持久任务账本（单写者=server 进程；读-改-原子写＋根锁串行化跨进程写者）。mission 记录携带 original_prompt（跨会话恢复的种子）、dispatch 归因（mode/agent_id/task_id/session_id/token）、pack/artifacts/blocked/qa/manifest 指针与 timeline 事件流水。状态机=白名单迁移（drafted→dispatched→running/blocked/question/ready/done/failed/skipped/resumed→closed），守卫三件：close_confirmed 一次性确认、reopen 显式复活、closed 拒收改板类 report。字段合并走 MERGEABLE_KEYS/ONE_LEVEL 白名单＋scope 三键整替，未知顶层键剥离并在回执 `ignored_keys` 回显。依赖图 blockedBy 在每次板写事务内 sweepGraph 定点扫描 fixpoint 求解（解锁 ready／级联 skipped／租约回收／悬挂清理）；claim=根锁内 CAS 自领取＋租约（report 自动续租，超时回 ready）；p2p 问答经 server 仲裁中转落板（配对授权制，星型拓扑例外）。契约与失效语义：`docs/protocols/card-board.md`、`docs/protocols/card-state-machine.md`（含「每腿×内部写者」正面矩阵与外部写者禁区）。

### 文件邮箱（spool）

report 事件文件落 `<mission_id>/unread/`（文件名=15 位零填充时间戳＋8hex，字典序=时间序），主控 mailbox read 以 rename 原子消费至 `read/`，answer 留痕 `answers/`。kind 四值（milestone/blocked/question/done）联动板状态；Windows 幻影 rename 以「移动后源消失校验」防双投递；closed mission 事件仍入 spool 但板不动。契约：`docs/protocols/card-spool.md`。

### 派发与组包（dispatch）

context_pack 把上游上下文逐字物化为 pack.md——**任务包是子代理的唯一世界**（CONTRACT 三行含 token、CONTEXT 逐字注入、READ FIRST、TASK/RULES、OWNERSHIP 写面清单、BUDGET 档位、LESSONS/GLOBAL MEMORY/RECENT CONTEXT/SUMMARY 条件节、VARIANT 变体、SANDBOX 沙箱节）。拉起双形态：后台 Agent（GP+persona 注入）与 headless dispatch（runner 进程＋result-dir 三件套＋完成即唤 wake-kick＋coord-tail 尾块轨迹注入）；busy 闸按 result-dir index 判在飞、侧车超龄豁免防任务级锁死。模板逐字权威=SKILL 第 3 章；result-dir 契约=`docs/protocols/card-result-dir.md`；timeout_min 用法=`docs/protocols/timeout-min-guide.md`；主控信息面（尾块契约）=SKILL 第 17 章。

### 沙箱派发（sandbox）

isolation=worktree 在存储根 `sandboxes/<mission_id>/` 下物化 git worktree（分支 `orch/<mission_id>`；node_modules junction 可共享，跨卷等失败静默降级；非 git 项目/空仓/缺 git/merge-tree 不支持均派发即拒），SANDBOX 节声明写面红线并改写包内项目路径。收口走 sandbox_apply：三阶段（锁内门禁+intent 写入→无锁 git 管线→锁内结算）×幂等三态收敛（已应用→补偿关闭；intent+已合入→按 merge-base 收口；intent 新鲜未合入→结构化 busy；intent 过期→清后重走门）；qa 四查链（verdict=pass、评审 mission 存在且 done/closed、角色含 reviewer、与目标 mission 互指——自审自批被机械拦截）；merge-tree 内存预检冲突即拒并附合并代理四件套指引；主仓 porcelain 巡检（allow_dirty 为唯一人工逃生）、越界 diff 机械检出。sandbox_discard 幂等弃置、与新鲜 apply intent 互斥。生命周期逐阶段契约=`docs/protocols/card-sandbox.md`（M4 不立项增强）；操作面=SKILL 第 12 章。

### 哨兵家族（sentinel）

直至型错峰冗余：同命令连发多实例互为冗余，槽位文件 wx 认领＋心跳判死＋死槽接管；板事件龄期条件分级（C3>C1>C2）驱动开枪仲裁（fired 错峰防重＋封顶放弃）与三回声（本地 echo／平台邮箱信封／OS toast 兜底）；全清转 standby 零通知、新在飞自动复活、寿命 cap 单赢家轮换选举；观测型隔离 quarantine 抑制误报；drain 消费完成即唤队列滞留；消费 watcher-signals（watcher 降级 standby 时唤醒由哨兵接管）；归敛自动拉起（双门槛＋冷却戳＋wx 租约）。哨兵对本板绝对只读，自有落盘全在 sentinel/ 目录。逐文件契约=`docs/protocols/card-sentinel.md`；分节职责地图与不分解裁定=`docs/protocols/card-bg-sentinel-map.md`；操作面=SKILL 第 11 章。

### 记忆与上下文经济（memory/observe）

lessons 两级库（项目/全端）只经 lessons 工具增删（事件行永不直写），检索注入带分数门与类型加权；归敛代理（orch-gleaner）按双门槛拉起，产出三视图派生物——digest（md＋sidecar 五级判定链）、ORCH.md ver-sync piggyback、AGENTS.md orch-mem 标记区——三视图失效语义不对称，契约=`docs/protocols/card-memory-views.md`；STALE 分级渲染把「视图多旧」变成可读信号。读侧经济：probe 四 action 统一帽＋分页＋读缓存（`docs/protocols/card-probe.md`、`docs/protocols/cache-policy.md`）、agent_harvest 转录收割与一次性浓缩、manifest 三层清单与 inputs 机械牵引（组包侧）。操作面=SKILL 第 10 章、第 15 章（成本纪律）。

## 3. 协议面：契约卡索引与运行时落盘布局

### 契约卡族索引（docs/protocols/）

| 卡 | 归属模块 | 一句话 |
|---|---|---|
| `docs/protocols/card-board.md` | board | board.json 字段/合并白名单/p2p 记录/回执形状契约 |
| `docs/protocols/card-state-machine.md` | board | 状态机白名单迁移+每腿×内部写者正面矩阵+外部写者禁区 |
| `docs/protocols/card-spool.md` | spool | 事件文件命名/三目录消费语义/防双投递契约 |
| `docs/protocols/card-result-dir.md` | dispatch | dispatch result-dir 三件套分形态契约（headless 在/nested 缺） |
| `docs/protocols/card-sandbox.md` | sandbox | worktree 生命周期+apply/discard 收口门禁+scope 冲突语义 |
| `docs/protocols/card-sentinel.md` | sentinel | sentinel/ 目录族逐文件契约（槽位/fired/echo/quarantine/锚） |
| `docs/protocols/card-bg-sentinel-map.md` | sentinel | bg-sentinel 分节职责地图+不分解裁定存证（非重构 mandate） |
| `docs/protocols/card-watcher.md` | watcher | watcher 客户端模块面+降级树+U3 注入唤醒废弃口径 |
| `docs/protocols/card-memory-views.md` | memory | lessons 三视图（digest/ver-sync/orch-mem）物契约+失效语义总表 |
| `docs/protocols/card-probe.md` | observe | probe 四 action 帽/分页/缓存门契约 |
| `docs/protocols/card-root-txt.md` | 横切 | root.txt 指针+root-id 分代契约（server 定根不读指针） |
| `docs/protocols/cache-policy.md` | observe | 会话级读缓存 LRU 与 SQL 门策略 |
| `docs/protocols/timeout-min-guide.md` | dispatch | headless 超时参数使用指引 |

卡头均带「总装时点实测行号不作跨版引用」声明；卡≈码同步由 lint-manifest 的文档卡同步锁与 contract-sync 对拍承载。

### 运行时落盘布局（存储根）

默认 `<项目>/.zcode/orchestrator`，可被 userConfig 存储根与 root.txt 指针改向（见 card-root-txt）：

```
<存储根>/
  root.txt / root-id            # 可选指针与分代契约（card-root-txt.md）
  board.json                    # 任务板（card-board.md / card-state-machine.md）
  packs/<mission_id>/           # pack.md 与 manifest.json sidecar
  spool/<mission_id>/           # unread/ read/ answers/（card-spool.md）
  archive/                      # gc 归档的 closed missions
  sentinel/                     # 哨兵自有落盘（card-sentinel.md 全量契约）：
                                #   槽位族/teardown/fired/echo.jsonl/quarantine/
                                #   coord-session.txt coord-workspace.txt/
                                #   watcher-signals.jsonl watcher-heartbeat/
                                #   归敛拉起状态与冷却戳
  sentinel.cfg.json             # server 发布的哨兵配置（存储根本级）
  sandboxes/<mission_id>/       # git worktree 沙箱（card-sandbox.md）
  memory/                       # lessons 两级库+归敛名册+归敛锁与配置
  digest/                       # pack-tail-digest md+json sidecar（card-memory-views.md）
  context/                      # 会话镜像 journal 与 coord-tail 日志
  .lock/owner.json              # 根锁（holder/pid/heartbeat，死锁接管）
  watcher.cfg.json              # watcher 桥接配置（card-watcher.md）
```

### 横切契约：存储根定位（root-id）

存储根定位是全体进程的横切契约：server 定根**从不读指针**；hooks 经 root.txt 指针发现自定义根并以 root-id 分代门防悬空/防劫持；定根函数族为五脚本 verbatim twin（行为由 root-contract 套件与 twin-lock 双锁）。契约：`docs/protocols/card-root-txt.md`。

## 4. 平台事实与文档治理

### 平台事实（宿主约束，与插件版本无关）

- 平台 hooks 事件全集以 hooks.json 注册面与宿主文档为准；无 SubagentStop 类子代理生命周期事件；Stop 提醒受 stop_hook_active 放行语义约束。
- Agent 工具无 model 参数；同一消息多条 Agent 调用=并发，上限≈8。
- 普通子代理无 SendMessage 与邮箱消费工具；上行=report（文件邮箱）与终态返回；RespondToCoordinator 仅在主控曾发过消息时出现。
- SendMessage(to=agent_<uuid>, summary≤200 字, message≤20000 字)：终态=后台恢复续聊（可反复），运行中=steer 注入。
- TaskOutput 偶发 "No task found"——兜底=完成通知中的输出文件路径与 GetWorkflowRun/ListWorkflowRuns；TaskStop 收敛失控任务。
- workflow：AmendWorkflow 任何状态可改（旧完成工作导入缓存；脚本内模型名为编译期字面量或 ModelRef）；ResumeWorkflowRun 仅 stopped；子代理 escalate 每 ask 限次；dwfq 提问无超时，不能搁置不答。
- 服务器零 npm 依赖、禁一切网络请求（无 fetch/net/http import；诊断只写 stderr）。
- Windows：跨进程 rename 同源路径可幻影成功（消费必须校验源消失）；node_modules junction 跨卷失败静默降级；沙箱 merge-tree 预检要求较新 git（不支持即 apply 拒绝，见 card-sandbox.md）。

### 文档治理（本文如何演进）

- 本文由 po-static 的 DESBAN 组守护：①版本号字面零残留（钉自证——该断言绿即「DESIGN 零版本号字面」验收成立）；②「N 个工具/角色/命令」计数句法零残留；③独占权威声明零残留；④协议卡索引双向覆盖（引用必存在、在册卡必被索引）；⑤引用 SKILL 章号必真实。
- 改本文流程：改机制事实→跑 `node tests/suites/po-static.mjs`（DESBAN 绿）与 lint-manifest（LM-02/03 不破）→随波全量 run-all 绿后收口。新增契约卡=docs/protocols/ 落盘＋§3 索引补行（漏补即反向覆盖断言红）。
- 字面量锁口径：计数恒为台账非门禁（数字锁必腐，结构锁不腐）；本文被 ban 的数字一律由归属机制套件（sentinel-teardown/watcher-core/crv 系等）按钉族承载。
