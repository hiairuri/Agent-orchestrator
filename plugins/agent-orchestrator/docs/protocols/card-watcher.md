# 契约卡：watcher 客户端（M8）

> **行号声明（卡头）**：本文行号系 **2026-10-28 总装时点实测**（grep+实码核对，worker v12-m71）。行号**不作跨版引用**；跨版定位以模块名/函数名锚为准（l-20261022-6a14d6）。
>
> - **归属模块**：M8 watcher（`watcher/` 目录：入口 `watcher.mjs`＋模块 `ws/relay/relay-shim/txn/bridge/inject/verdict/poller/credentials/degrade`）；协议客户端定位（M2 表：M7/M8=协议客户端）
> - **脆度双轴评级**：面广度=中（单守护进程＋配置面）；后果重度=中——失效终态一律降级 standby 停事务面保心跳，**唤醒由哨兵家族接管**（职责互换），无 root.txt 型全局失明后果；但凭证面（token 解密/脱敏）与平台耦合面（桌面远控、互踢边界）是历史事故高发区
> - **历史事故回链**：EXP10-findings R4（coord-workspace 缺失→盲取 workspaces[0]→错工作区注入＋b2 回读劫持锚，G5/G10 修复：锚钉+fail-loud）；EXP10-findings R6（sess_subagent 前缀劫持，G14 修复）；V7-05（cfg 桥接键被默认值遮蔽，numArgBridge twin 先例）；watcher 双缺陷（凭证解密/ws-scheme）已修复随版出货（AGENTS.md 遗留台账）
> - **常驻授权红线**：watcher 常驻运行**须用户显式授权**（W-G §5 条件 C1）；停用=进程退出＋凭证自然过期。本卡是协议记录，不构成常驻运行的授权

---

## 0. ⚠ U3 废弃口径（本卡最优先声明，2026-10-27 用户终裁）

**注入唤醒整线废弃**：实测注入唤醒较哨兵无准确率优势且维护成本更高（MOD3a-QA 误报与隔夜无唤醒双实锤入册）。据此：

- watcher **注入通道**（bridge/inject/relay-shim 直通面）**不再作为唤醒增强对象**——v1.2 及以后的唤醒增强施工一律落 bg-sentinel 侧（哨兵可靠性强化：scoping 不为他会话开枪＋存活复活补员）；
- **哨兵（bg-sentinel 家族）为唯一唤醒出口**；watcher 降级 standby 时唤醒接管关系见 §4；
- 本卡只记**现状协议面**（模块/降级树/锚钉/心跳/signals 消费），零增强立项；watcher-shim 套件列入断言不变清单（不增强）；旧「唤醒分流三分类/锚模式标记/inject 前置校验」设计已作废销项——本文不再展开其设计细节，考古走 designs/ 设计链。

## 1. 模块面（入口＋十模块组合根）

| 文件 | 职责一句话 | 关键锚 |
|---|---|---|
| `watcher.mjs` | 守护入口/组合根：参数 cfg 桥接（CLI > `<root>/watcher.cfg.json` > 内建默认）、定根、心跳自证、主循环编排（POLLER 分类→TXN 闸→短事务 CREDS→RELAY→BRIDGE→INJECT→VERDICT→DEGRADE） | `main`；CLI：`--root/--origin/--poll-sec/--min-interval-sec/--wake-cap/--hold-max-sec/--trigger-statuses/--transport` |
| `poller.mjs` | 轮询分类：board 终态事件→待办事务队列 | `classify` |
| `txn.mjs` | 事务闸：每轮至多一个短事务在飞 | txn 闸 |
| `credentials.mjs` | 凭证面：读取/解密/重签；日志脱敏闸 | `redact`（一切出口经此；token 形态/Bearer 归零，token 值零持久化） |
| `relay.mjs` | 云中继 ws 客户端（transport=cloud） | relay |
| `relay-shim.mjs` | 本机回环 shim（transport=loopback，直连模式）：桌面 env 两键指向 shim ws | relay-shim |
| `bridge.mjs` | 桌面桥接：workspace 列表/会话桥 | `workspaceKeyHint`、`workspaceIdentity` |
| `inject.mjs` | 注入面（U3 废弃口径下仅记现状）：唤醒注入一体链 | `wakeCoordSession`（openBridge＋b1/b2 自愈＋应答回读＋b2 工作区守卫＋coord-session 刷新一体） |
| `verdict.mjs` | 事务结果判读 | verdict |
| `degrade.mjs` | 降级树：分类/终态集/告警文案/signals 记录 | `CLASSES`、`TERMINAL_CLASSES`、`D1_GUIDANCE`、`LOOPBACK_ENV_RELAY_WS_URL`、`LOOPBACK_ENV_ENDPOINT_ORIGIN`、`record` |
| `ws.mjs` | websocket 层（套件内全 mock） | ws |

## 2. 进程生命周期与状态机

- **常驻进程**：永不因失败退出（任何异常降级 standby 继续，进程退出仅限用户停用）。
- **事务形态**：对中继**永短事务**（连-发-断，持有 ≤40s，`--hold-max-sec` 默认 40）——无长连状态。
- **三态机**：`standby`（轮询中）→ `transacting`（短事务在飞，每轮至多一个）→ 终态降级回 standby（D1/D3/kicked：停事务面、**保心跳**，等人工/哨兵接管）。
- **频控**：`--min-interval-sec` 默认 90（EXP-2 边界实测后保守频控 ≥90s 维持：对手终端面不可观测，级联未发生但不可证明）；`--wake-cap` 默认 3（每周期通知帽）。
- **transport 双模**：`cloud`（平台中继 ws）／`loopback`（本机回环直连，relay-shim 中转；断连/空设备表/超时归 D2 瞬时降级，恢复自愈）。

## 3. 降级树（degrade.mjs，D1/D2/D3/kicked）

| 类别 | 触发族 | 语义 |
|---|---|---|
| **D1 凭证终态** | 签发 401/code≠0/safeParse 败/凭据缺失/解密败/AUTH_FAILED/4013/4011 重签再败 | 停事务面保心跳；`D1_GUIDANCE` 文案指引用户桌面端重登；唤醒由哨兵接管（`fail-loud`——告警必达） |
| **D2 临时** | 传输抖动/loopback 桌面链路未通/bridge-error 重试一次仍败 | 本轮弃发，写 signals 回哨兵，下轮 POLLER 自动恢复（`自愈`） |
| **D3 配置终态** | workspace-list 空/4004/4012/**工作区锚缺失或不匹配**（G5 fail-loud）等配置面错误 | 停事务面保心跳；配置告警（`fail-loud`） |
| **kicked** | 互踢 | 停事务面保心跳，等接管 |
| 成功面 | noop/success/accepted-not-revived | 零降级 |

**工作区锚钉（G10，EXP10 R4 根治）**：`sentinel/coord-workspace.txt` 与 coord-session.txt 同级，单行派生键=`workspaceIdentity.trim||workspacePath`。有锚→openBridge 携 workspaceKeyHint；**无锚/锚未命中=fail-loud**（workspace-anchor-missing / workspace-anchor-mismatch → D3），**绝不盲取 workspaces[0]**。watcher 只读锚不写锚；锚的写面=互信根三触发（server 启动补位 / toolResume / SessionStart）。b2 刷新仅当桥/应答工作区与锚一致，否则保持原锚并把 warning 落日志（防锚劫持重现）。

## 4. 与哨兵的职责互换（消费面契约）

| 面 | watcher 侧 | 哨兵侧（bg-sentinel） |
|---|---|---|
| 心跳自证 | 每 60s 写 `sentinel/watcher-heartbeat`（mtime 即心跳） | 反向监控消费（watcher-signals 消费面同函数族；心跳在岗判定） |
| 降级事件 | D1/D2/D3/kicked 逐条追加 `sentinel/watcher-signals.jsonl` | 消费 watcher-signals：**信号已覆盖类别静默、缺失走既有兜底**；stall 检测职责保留（事件中继无死寂可见性） |
| 唤醒出口 | **非出口**（U3 废弃注入唤醒线；本行是 U3 后的唯一合法口径） | **唯一唤醒出口**（直至型错峰冗余家族） |
| 定根 | `--root` 优先，默认 `<cwd>/.zcode/orchestrator`；**从不读 root.txt 指针**（站 server 侧惯例——hooks 盲跟指针曾致全体失明） | hooks 侧经 root.txt+root-id 分代门（card-root-txt.md） |

## 5. 安全面

- **凭证五禁＋日志脱敏闸**：一切出口经 `credentials.redact`（token 形态/Bearer 归零；token 值零持久化）；凭证读取/解密失败走降级树 D1，不重试无限。
- **零网络旁路**：网络面仅 relay/relay-shim 两模块；ws 层在套件内全 mock（任何 suite 不连生产中继）。
- **常驻授权**：C1 红线（卡头）；watcher.cfg.json 落盘不含凭证明文。

## 6. 实测门（历史定案，考古索引）

- **EXP-1 凭证合规**：凭证获取/脱敏/日志闸实测全过。
- **EXP-2 互踢＋边界条件**：级联未发生但对手终端面不可观测——保守频控 ≥90s 维持为常设缺省。
- **EXP-3 长连定案**：token TTL 短只是握手门票非硬切，单连超长时零异常（现形态已改永短事务，本结论为历史定案存档）。

## 7. 断言锚

- **watcher-core 套件**：降级树分类/终态集/告警文案、凭证脱敏闸、txn 闸、poller 分类、verdict 判读、心跳面——ws 全 mock。
- **watcher-shim 套件**：shim 协议面（loopback 模式）。
- **twin-lock**：五文件行为矩阵**不含** watcher（watcher 函数不在锁面）；watcher.mjs numArgBridge 桥接为 twin 先例引用方。
- **函数名锚（LM-05 候选行素材）**：`watcher.mjs`：`wakeCoordSession`/`workspaceIdentity`/`workspaceKeyHint`/`redact`/`CLASSES`/`record`；`degrade.mjs`：`CLASSES`/`TERMINAL_CLASSES`/`D1_GUIDANCE`/`LOOPBACK_ENV_RELAY_WS_URL`/`LOOPBACK_ENV_ENDPOINT_ORIGIN`/`record`；`poller.mjs`：`classify`；`credentials.mjs`：`redact`（2026-10-28 grep 实证可见）。

## 8. 维护规则

- 降级树新增类别/触发族：degrade.mjs `CLASSES`/`TERMINAL_CLASSES`＋本卡 §3＋watcher-core 断言三处同波改。
- transport/短事务参数缺省调整：watcher-core 断言面先盘点（l-20261022-5564ee）再动。
- **U3 口径守恒**：任何把 inject/bridge/relay-shim 面重新立项为「唤醒增强」的提案均与用户终裁冲突——走 report(blocked) 待裁，不得借维护通道复活注入唤醒线。哨兵侧增强施工落 bg-sentinel（card-bg-sentinel-map.md）与 M9 波任务书。
