# Contract card: the watcher client (M8)

> **Line-number declaration (card head)**: all line numbers in this document were measured at assembly time (grep + source verification). Line numbers are **not referenced across versions**; cross-version locating relies on module/function-name anchors (l-20261022-6a14d6).
>
> - **Home module**: M8 watcher (the `watcher/` directory: entry `watcher.mjs` + modules `ws/relay/relay-shim/txn/bridge/inject/verdict/poller/credentials/degrade`); protocol-client positioning (M2 table: M7/M8 = protocol clients)
> - **Brittleness dual-axis rating**: surface breadth = medium (a single daemon + a configuration face); consequence severity = medium - every failure terminal degrades to standby, stopping the transaction face while keeping the heartbeat, and **wake-up is taken over by the sentinel family** (duty swap), so there is no root.txt-style global blindness; but the credential face (token decryption/redaction) and the platform-coupling faces (desktop remote control, mutual-kick boundary) are historically incident-prone
> - **Resident-authorization red line**: resident watcher operation **requires explicit user authorization**; deactivation = process exit + credentials expiring naturally. This card is a protocol record and does not constitute authorization for resident operation

---

## 0. The U3 deprecation ruling (this card's highest-priority declaration, user final ruling)

**The injection wake-up line is deprecated wholesale**: measurement showed injection wake-up has no accuracy advantage over the sentinel and higher maintenance cost (both the MOD3a-QA false alarms and the overnight-no-wake findings are on record). Accordingly:

- the watcher **injection channel** (the bridge/inject/relay-shim passthrough faces) is **no longer a wake-up enhancement target** - wake-up enhancement work lands on the bg-sentinel side (sentinel reliability hardening: scoping that does not fire for other sessions + liveness revival/replenishment);
- **the sentinel (the bg-sentinel family) is the sole wake-up exit**; the standby takeover relation is in §4;
- this card records the **current protocol face** (modules / degrade tree / anchor pins / heartbeat / signals consumption) with zero enhancement initiatives; the watcher-shim suite is on the assertion-invariance list (no enhancement); the old "wake routing three-way / anchor mode marking / inject precondition validation" designs are void and closed out - archaeology goes through the designs/ design chain.

## 1. Module face (entry + ten-module composition root)

| 文件 | 职责一句话 | 关键锚 |
|---|---|---|
| `watcher.mjs` | 守护入口/组合根：参数 cfg 桥接（CLI > `<root>/watcher.cfg.json` > 内建默认）、定根、心跳自证、主循环编排（POLLER 分类→TXN 闸→短事务 CREDS→RELAY→BRIDGE→INJECT→VERDICT→DEGRADE） | `main`；CLI：`--root/--origin/--poll-sec/--min-interval-sec/--wake-cap/--hold-max-sec/--trigger-statuses/--transport` |
| `poller.mjs` | 轮询分类：board 终态事件→待办事务队列 | `classify` |
| `txn.mjs` | 事务闸：每轮至多一个短事务在飞 | txn 闸 |
| `credentials.mjs` | 凭证面：读取/解密/重签；日志脱敏闸 | `redact`（一切出口经此；token 形态/Bearer 归零，token 值零持久化） |
| `relay.mjs` | 云中继 ws 客户端（transport=cloud） | relay |
| `relay-shim.mjs` | 本机回环 shim（transport=loopback，直连模式）：桌面 env 两键指向 shim ws | relay-shim |
| `bridge.mjs` | 桌面桥接：workspace 列表/会话桥 | `workspaceKeyHint`、`workspaceIdentity` |
| `inject.mjs` | 注入面（U3 废弃口径下仅记现状）：唤醒注入一体链 | `wakeCoordSession`（openBridge+b1/b2 自愈+应答回读一体——b2 闸语义=card-sentinel.md 补记 防线二） |
| `verdict.mjs` | 事务结果判读 | verdict |
| `degrade.mjs` | 降级树：分类/终态集/告警文案/signals 记录 | `CLASSES`、`TERMINAL_CLASSES`、`D1_GUIDANCE`、`LOOPBACK_ENV_RELAY_WS_URL`、`LOOPBACK_ENV_ENDPOINT_ORIGIN`、`record` |
| `ws.mjs` | websocket 层（套件内全 mock） | ws |

## 2. Process lifecycle and the state machine

- **常驻进程**：永不因失败退出（任何异常降级 standby 继续，进程退出仅限用户停用）。
- **事务形态**：对中继**永短事务**（连-发-断，持有 ≤40s，`--hold-max-sec` 默认 40）——无长连状态。
- **三态机**：`standby`（轮询中）→ `transacting`（短事务在飞，每轮至多一个）→ 终态降级回 standby（D1/D3/kicked：停事务面、**保心跳**，等人工/哨兵接管）。
- **频控**：`--min-interval-sec` 默认 90（EXP-2 边界实测后保守频控 ≥90s 维持：对手终端面不可观测，级联未发生但不可证明）；`--wake-cap` 默认 3（每周期通知帽）。
- **transport 双模**：`cloud`（平台中继 ws）／`loopback`（本机回环直连，relay-shim 中转；断连/空设备表/超时归 D2 瞬时降级，恢复自愈）。

## 3. The degradation tree (degrade.mjs, D1/D2/D3/kicked)

| 类别 | 触发族 | 语义 |
|---|---|---|
| **D1 凭证终态** | 签发 401/code≠0/safeParse 败/凭据缺失/解密败/AUTH_FAILED/4013/4011 重签再败 | 停事务面保心跳；`D1_GUIDANCE` 文案指引用户桌面端重登；唤醒由哨兵接管（`fail-loud`——告警必达） |
| **D2 临时** | 传输抖动/loopback 桌面链路未通/bridge-error 重试一次仍败 | 本轮弃发，写 signals 回哨兵，下轮 POLLER 自动恢复（`自愈`） |
| **D3 配置终态** | workspace-list 空/4004/4012/**工作区锚缺失或不匹配**（G5 fail-loud）等配置面错误 | 停事务面保心跳；配置告警（`fail-loud`） |
| **kicked** | 互踢 | 停事务面保心跳，等接管 |
| 成功面 | noop/success/accepted-not-revived | 零降级 |

**工作区锚钉（G10，EXP10 R4 根治）**：`sentinel/coord-workspace.txt` 与 coord-session.txt 同级，单行派生键=`workspaceIdentity.trim||workspacePath`。有锚→openBridge 携 workspaceKeyHint；**无锚/锚未命中=fail-loud**（workspace-anchor-missing / workspace-anchor-mismatch → D3），**绝不盲取 workspaces[0]**。watcher 只读锚不写锚；锚写面=互信根三触发、b2 刷新闸与防劫持语义=card-sentinel.md C2/C 组补记（互指不合并）。

## 4. Duty swap with the sentinel (the consumption-face contract)

| 面 | watcher 侧 | 哨兵侧（bg-sentinel） |
|---|---|---|
| 心跳自证 | 每 60s 写 `sentinel/watcher-heartbeat`（mtime 即心跳） | 反向监控消费（watcher-signals 消费面同函数族；心跳在岗判定） |
| 降级事件 | D1/D2/D3/kicked 逐条追加 `sentinel/watcher-signals.jsonl` | 消费 watcher-signals：**信号已覆盖类别静默、缺失走既有兜底**；stall 检测职责保留（事件中继无死寂可见性） |
| 唤醒出口 | **非出口**（U3 废弃注入唤醒线；本行是 U3 后的唯一合法口径） | **唯一唤醒出口**（直至型错峰冗余家族） |
| 定根 | `--root` 优先，默认 `<cwd>/.zcode/orchestrator`；**从不读 root.txt 指针**（站 server 侧惯例——hooks 盲跟指针曾致全体失明） | hooks 侧经 root.txt+root-id 分代门（card-root-txt.md） |

## 5. Security face

- **Credential prohibitions + the log redaction gate**: every outlet goes through `credentials.redact` (token shapes/Bearer zeroed; token values never persisted); credential read/decrypt failures go to the degrade tree D1, with no unbounded retries.
- **Zero network bypass**: the network face is only the relay/relay-shim pair; the ws layer is fully mocked inside the suite (no suite connects to the production relay).
- **Resident authorization**: the red line (card head); watcher.cfg.json on disk contains no plaintext credentials.

## 6. Measured gates (historical rulings, archaeology index)

- **EXP-1 credential compliance**: credential acquisition/redaction/log gate all passed in measurement; **EXP-2 mutual kick + boundaries**: no cascade occurred but the counterpart's terminal face is unobservable - the conservative rate limit >=90s stays as the standing default; **EXP-3 long-connection ruling**: zero anomalies over a single very long connection (the current form has switched to always-short transactions; historical archive).

## 7. Assertion anchors

- **the watcher-core suite**: degrade-tree classification / terminal sets / alert copy, the credential redaction gate, the txn gate, poller classification, verdict reading, the heartbeat face - ws fully mocked.
- **the watcher-shim suite**: the shim protocol face (loopback mode).
- **twin-lock**: the five-file behavior matrix does **not** include watcher (watcher functions are not on the lock face); watcher.mjs numArgBridge bridging is a twin-precedent reference.
- **Function-name anchors (LM-05 candidate-row material)**: `watcher.mjs`: `wakeCoordSession`/`workspaceIdentity`/`workspaceKeyHint`/`redact`/`CLASSES`/`record`; `degrade.mjs`: `CLASSES`/`TERMINAL_CLASSES`/`D1_GUIDANCE`/`LOOPBACK_ENV_RELAY_WS_URL`/`LOOPBACK_ENV_ENDPOINT_ORIGIN`/`record`; `poller.mjs`: `classify`; `credentials.mjs`: `redact`.

## 8. Maintenance rules

- Adding a degrade-tree class/trigger family: degrade.mjs `CLASSES`/`TERMINAL_CLASSES` + this card's §3 + watcher-core assertions, three places in the same wave.
- Default changes to transport/short-transaction parameters: inventory the watcher-core assertion face first, then change.
- **The U3 ruling holds**: any proposal to re-initiate the inject/bridge/relay-shim faces as "wake-up enhancement" conflicts with the user's final ruling - go report(blocked) and wait; the injection wake-up line must not be revived through the maintenance channel. Sentinel-side enhancement work lands in bg-sentinel (card-bg-sentinel-map.md) and its wave task book.
