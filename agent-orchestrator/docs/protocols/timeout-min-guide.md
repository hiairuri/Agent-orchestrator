# timeout_min 使用指引（headless dispatch 超时全链）

- **定位**：dispatch 工具 `timeout_min` 参数的使用指引（schema 唯一权威=工具 description「Runner timeout in minutes (default 240; on timeout the process tree is killed and timed_out:true is recorded)」；本文补全链语义、选型与易混淆面辨析）。协议本体归 `card-result-dir.md`（收场标记三件套）与 `card-board.md`（租约面）
- **锚点声明**：本卡行号系总装时点（v1.2 源码）实测，**不作跨版引用**（l-20261022-6a14d6）；函数名/常量名双锚为定位权威

---

## 1. 参数语义与全链（runner 侧已 parked at v1.6.0——操作细节随归档迁移，锚清单在此）

-p 通道已剥离归档：parked/agent-orchestrator/（恢复指引=同目录 README 六步）。锚清单：

- **参数语义**：`Number(timeout_min)` 有限且 >0 → `Math.floor`；0/负/NaN/缺省 → 回落默认 **240**（`DISPATCH_DEFAULT_TIMEOUT_MIN`，server/runner 双源同值 twin——改默认须两处同波）；无上限钳制。
- **全链锚**：runner argv `--timeout-min <N>` 直传；计时起点=runner spawn CLI 子进程后 `setTimeout(timeoutMin*60000)`（计 runner 侧进程树存活时长，非 board 派发时刻起算）；超时动作 `killTree`（Windows `taskkill /PID <pid> /T /F` 杀整树含 detached 孙进程；POSIX `kill(-pid, SIGKILL)`；5s 后备 finish 兜 stuck handle）；收场标记 index.json `timed_out:true, outcome:"timeout"`（Q3b；error/result 侧车按信封可解析性照常落，wake 事件同携 outcome/timed_out/exit_code）。
- **毒性**：超时收场后 index 已落 → busy 闸解锁可重派；**超时跑完的 mission 无自动置败**——置败走 worker report 或主控处置（result-dir 是诊断面非状态面，runner 不触 board）。

## 2. 与其它「分钟/超时」面的辨析（同名不同物，勿混调）

| 面 | 值/默认 | 管什么 | 与 timeout_min 的关系 |
|---|---|---|---|
| board claim 租约 lease_minutes | 默认 30（--claim-lease-min 可调 1-1440）；report 续租 | **board 所有权**：租约超时 sweep 回收 mission 回 ready | **两套独立时钟，无联动**：会话可活得比租约久也可死得比租约早。长 timeout_min ≠ 长租约，需要长跑请加大 lease_minutes 并让 worker 定期 report 续租 |
| sentinel cfg.wake_timeout_min（桥键） | sparse 写（V7-05）→sentinel 内桥接 refire_gap_min | **哨兵重发间隔**（唤醒失败后的 refire 节奏） | 与 runner 超时无关——管的是「派发后多久没动静再催」，非「进程多久强制杀」 |
| ORCH_DISPATCH_CAPTURE_MS | 默认 8000ms（上限 30s） | dispatch 返回前等回执/快死的组合捕获窗（parked） | 与 timeout_min 无关；调大它不延长会话寿命 |
| ORCH_DISPATCH_BUSY_STALE_MIN | 默认 120min | busy 闸**超龄豁免**阈值（无 index 残留侧车放行线，parked） | 正常超时收场走 index 解锁，用不到豁免；仅强杀残余面靠它兜底 |
| probe db.query 超时 | 10s | SQL 子进程 | 无关（probe 卡 §2.1） |
| sandbox git 阶段帽 | 60s 量级 | apply 各 phase git 子进程 | 无关（sandbox 卡，W7 落） |
| APPLY_INTENT_FRESH_MS | 10min | apply↔discard 意图互斥窗 | 无关 |

## 3. 选型指引（headless 参数已 parked——历史选型经验随归档迁移）

- 超时线是**兜底不是目标**；长跑需同时核对 claim `lease_minutes` ≥ 会话预期（或 worker 周期 report 续租）与 ORCH_DISPATCH_BUSY_STALE_MIN 的相对关系（租约面协议=`card-board.md`）。
- 传 0/负数不是「立即超时」而是回落默认 240；**超时被杀的会话不会有 report**，主控按 wake 事件 outcome="timeout" 处置（收场标记见 §1）。

## 4. 断言锚与维护

- **crv6-resilience DSP 组**（v1.2 M3-1）：播种/收场/兜底链相关断言；超时杀树与 timed_out 标记腿见 dispatch-runner 契约注释与 WB-SRV 系（wake 事件字段）。
- **LM-05**（lint-manifest，M1-3 注册）：DISPATCH_DEFAULT_TIMEOUT_MIN/killTree 等名源码 grep 可见+本文存在非空。
- 维护：默认值 240 双源（server/runner）改一必改二；新增同名「timeout」面（如未来 nested）先入 §2 辨析表再落实现——本表存在的意义就是防同名混淆（wake_timeout_min 桥键 V7-05 前车）。
