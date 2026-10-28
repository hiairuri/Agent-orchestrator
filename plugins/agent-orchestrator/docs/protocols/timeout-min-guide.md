# timeout_min 使用指引（headless dispatch 超时全链）

- **定位**：dispatch 工具 `timeout_min` 参数的使用指引（schema 唯一权威=工具 description「Runner timeout in minutes (default 240; on timeout the process tree is killed and timed_out:true is recorded)」；本文补全链语义、选型与易混淆面辨析）。协议本体归 `card-result-dir.md`（收场标记三件套）与 `card-board.md`（租约面）
- **锚点声明**：本卡行号系总装时点（v1.2 源码）实测，**不作跨版引用**（l-20261022-6a14d6）；函数名/常量名双锚为定位权威

---

## 1. 参数语义与全链

| 环节 | 行为 | 锚点 |
|---|---|---|
| 入参校验（server） | `Number(timeout_min)` 有限且 >0 → `Math.floor`（分钟粒度取整）；0/负/NaN/缺省 → 回落默认 **240**（DISPATCH_DEFAULT_TIMEOUT_MIN）。无上限钳制（大值=自愿长跑） | :7154-7158；:6573 |
| 传递 | runner argv `--timeout-min <N>`（字符串直传） | :7204 |
| 兜底（runner） | runner 自身同规则二次校验，缺省 DEFAULT_TIMEOUT_MIN=240（双源默认值相等；**改默认须两处同波**——twin 纪律同 Q3b） | runner :39；:196-198 |
| 计时起点 | runner spawn CLI 子进程后 setTimeout(timeoutMin*60000)——**计的是 runner 侧 CLI 进程树存活时长**，非 board 派发时刻起算（prompt 组装/播种耗时不在内） | runner :435-441 |
| 超时动作 | `timedOut=true` → killTree：Windows `taskkill /PID <pid> /T /F`（杀整树含 detached 孙进程）；POSIX `kill(-pid, SIGKILL)`；5s 后备 finish 兜 stuck handle | killTree :171-185；:435-441 |
| 收场标记 | close/finish 走正常收场路径：index.json `timed_out:true, outcome:"timeout"`；error/result 侧车按信封可解析性照常落（超时≠无信封——CLI 可能已产出部分结果）；wake 事件同携三字段（outcome/timed_out/exit_code），主控被唤即知死因 | runner :356-407（Q3b） |
| 毒性 | 超时收场后 index 已落 → busy 闸解锁可重派；**超时跑完的 mission 无自动置败**——置败走 worker report 或主控处置（result-dir 是诊断面非状态面，runner 不触 board） | runner 头注释 :26-27 |

## 2. 与其它「分钟/超时」面的辨析（同名不同物，勿混调）

| 面 | 值/默认 | 管什么 | 与 timeout_min 的关系 |
|---|---|---|---|
| board claim 租约 lease_minutes | 默认 30（--claim-lease-min 可调 1-1440）；report 续租 | **board 所有权**：租约超时 sweep 回收 mission 回 ready | **两套独立时钟，无联动**：CLI 会话可活得比租约久（worker 停 report 即超租）也可死得比租约早（killed 后租约自然到期回收）。长 timeout_min ≠ 长租约，需要长跑请加大 lease_minutes 并让 worker 定期 report 续租 | 
| sentinel cfg.wake_timeout_min（桥键） | sparse 写（V7-05）→sentinel 内桥接 refire_gap_min | **哨兵重发间隔**（唤醒失败后的 refire 节奏） | 与 runner 超时无关——管的是「派发后多久没动静再催」，非「进程多久强制杀」 |
| ORCH_DISPATCH_CAPTURE_MS | 默认 8000ms（上限 30s） | dispatch 返回前等回执/快死的组合捕获窗 | 与 timeout_min 无关（快死 4.8s 实测落在窗内=R2 依据）；调大它不延长会话寿命 |
| ORCH_DISPATCH_BUSY_STALE_MIN | 默认 120min | busy 闸**超龄豁免**阈值（无 index 残留侧车放行线） | 正常超时收场走 index 解锁，用不到豁免；仅 taskkill /F 强杀先于 handler 的残余面靠它兜底。timeout_min 调大后请保证 ≥ 该豁免线不先到期（120min < 240min 默认链成立） |
| probe db.query 超时 | 10s | SQL 子进程 | 无关（probe 卡 §2.1） |
| sandbox git 阶段帽 | 60s 量级 | apply 各 phase git 子进程 | 无关（sandbox 卡，W7 落） |
| APPLY_INTENT_FRESH_MS | 10min | apply↔discard 意图互斥窗 | 无关 |

## 3. 选型指引

- **默认 240min 适配常规施工 mission**（测试+文档+中等代码面）。预算档位 M（≈60 步）的 mission 实际远短于此——超时线是**兜底不是目标**，勿把任务往线上排。
- **长跑场景**（全量回归+发版收口、大批量多套件）：timeout_min 调大（如 360-480）的同时**必须**核对：①claim lease_minutes ≥ 会话预期（或确保 worker 周期 report 续租——正常施工 worker 本就周期 report）；②ORCH_DISPATCH_BUSY_STALE_MIN（120）与 timeout_min 的相对关系在重派语义下成立。
- **短探测场景**（探活一发/最小复现）：调小到 5-15min——快失败快暴露；注意与捕获窗（8s）无关，短 timeout 只影响「活着不出结果」的进程何时被杀。
- **回执行为不变式**：timeout_min 只决定「何时杀」，不改变回执形态——捕获窗内可能拿到 session_id（已 boot）或 ok:false（快死），真慢启动 session_pending:true 后 completion 仍走 worker report / wake 队列，**超时被杀的会话不会有 report**，主控按 wake 事件 outcome="timeout" 处置。
- **单位与粒度**：分钟、Math.floor 取整；传 0/负数不是「立即超时」而是回落默认 240——「想短跑请传小正数」。

## 4. 断言锚与维护

- **crv6-resilience DSP 组**（v1.2 M3-1）：播种/收场/兜底链相关断言；超时杀树与 timed_out 标记腿见 dispatch-runner 契约注释与 WB-SRV 系（wake 事件字段）。
- **LM-05**（lint-manifest，M1-3 注册）：DISPATCH_DEFAULT_TIMEOUT_MIN/killTree 等名源码 grep 可见+本文存在非空。
- 维护：默认值 240 双源（server/runner）改一必改二；新增同名「timeout」面（如未来 nested）先入 §2 辨析表再落实现——本表存在的意义就是防同名混淆（wake_timeout_min 桥键 V7-05 前车）。
