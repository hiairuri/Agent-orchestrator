# tests/module-index.md —— 套件模块花名册（v1.2 M7-2 建立）

> 本文件是 tests/suites/ 套件文件集的索引面（impl-plan §批2 M7-2「tests/module-index.md 建立（≡suites 文件集）」）。
>
> **结构锁（LM-04，v1.2 M7-2 注册于 tests/suites/lint-manifest.mjs）**：
> - 规则 1（@module 恰一）：每个 `tests/suites/*.mjs` 文件头恰一行 `//` 行注释标签，标签名 ≡ 文件名词干
>   （孤儿套件=无标签/双标签/名称失配，LM-04 规则 1 机械红）；
> - 规则 2（本表 ≡ suites 文件集）：下表花名册行（首列反引号模块名、次列 `<名>.mjs`）与
>   `tests/suites/*.mjs` 词干集双向全等、无重复行；
> - 规则 3（REGISTRY ≡ suites 名单）：`tests/run-all.mjs` REGISTRY 条目名单 ≡ 同一文件集
>   （未注册孤儿/注册悬空双向红）。
>
> 三条只锁集合全等与形状，套件总数字面数不作门（impl-plan M-5/O6=a：预期 24 自校、非门禁）。
> **新增套件四件套**（缺一即 LM-04 红）：suites/`<名>`.mjs（含文件头标签）→ 本表一行 →
> run-all REGISTRY 一行 → 断言登记（对应版本断言档）。
>
> 「断言组」列为套件自报组名速览，主句权威=tests/assertions/ 对应版本档（v0.4.x 起逐版累积，
> v1.2 组见 v1.2.x.md §1）。「层」=run-all 分层（L0 骨架 / L1 直接层；L2 邻接与 L3 手工项不入册）。

| module | suite 文件 | 层 | 一句话职责 | 断言组速览 |
|---|---|---|---|---|
| `bggate` | bggate.mjs | L1 | bg-gate 后台闸黑盒（契约头/截断代理对回退/前台叠加句等；v1.2 M9-1 增哨兵复活六腿） | M-08..10 / A-v020-B / A-v031-S09 / A-v0120-REV |
| `condense` | condense.mjs | L1 | 归敛 tail=0 探测零回显 + 大末行中途重写 + 0.4.1 逐字节回归 + 工具清单不变量 | CR-V9 / CR-V10 / CR-V16 |
| `contract-sync` | contract-sync.mjs | L1 | 契约卡对拍：状态机卡 ALLOWED_TRANSITIONS fenced 块 vs crv6-statemachine 源实现（卡≈码漂移即红） | A-v0120-CARD |
| `crv1-scope` | crv1-scope.mjs | L1 | scope 冲突预检八步 + 形状门 + 未知键 ignored_keys | A-v050-CRV1 / E4 / M04 |
| `crv2-pack` | crv2-pack.mjs | L1 | pack 物化与合流 + 缺省包逐字节基线 + dispatch 纯区锁（纪律段/prefix/W4-DISPATCH） | CRV2 / CR-V22..25 / W4-PREFIX / W4-DISPATCH |
| `crv3-present` | crv3-present.mjs | L1 | 相交转串行 + 懒迁移审计/白名单/豁免 + 呈现面与 mailbox 帽 | CRV3 / CR-V26..28 / M03..06 |
| `crv4-audit` | crv4-audit.mjs | L1 | files_touched 审计 + manifest 七步管线（sidecar/形状软丢弃/帽值） | A-v050-CRV4 / CR-V18..21 / V29 |
| `crv5-apply-envelope` | crv5-apply-envelope.mjs | L1 | apply 包络（gitRun quotepath 注入 / 锁 / env 增例） | A-v060-QUOT / LOCK / ENV |
| `crv5-auth` | crv5-auth.mjs | L1 | 鉴权与注入防护（AUTH/SCOPE/INJ-01） | A-v060-AUTH / SCOPE / INJ |
| `crv6-resilience` | crv6-resilience.mjs | L1 | 韧性族（哨兵/拼接/恢复/心跳/看门狗/GC/注入）+ v1.2 M3-1 dispatch 播种/busy 闸/死信摘要 | A-v060-SG..INJ / A-v0120-DSP |
| `crv6-statemachine` | crv6-statemachine.mjs | L1 | board 状态机语义（迁移/合并/p2p）+ FA 模型供给播种 | A-v060-SM / P2P / FA |
| `crv8-memory` | crv8-memory.mjs | L1 | 记忆子系统（分发端补门/两级库捎带/ORCHTEMP 锁）+ v1.2 M8-1 STALE 分级渲染 | INJ / SYNC / GLEAN / A-v0120-STL |
| `dispatch-supply` | dispatch-supply.mjs | L1 | 派发供给面（v1.2.3 W1/M1：P2 信封双通道 parseEnvelope PE×6——单行通道A回归/650B 多行通道B/噪声混布/截断优雅 miss/生产长度定型＋miss→error 侧车静态腿） | A-v0123-PE（权威=assertions/v1.2.3.md §1） |
| `glean-launch` | glean-launch.mjs | L1 | 归敛自动拉起（bg-sentinel 黑盒：锁前置启动器/首条消息零包读/冷却锚退出） | 归敛拉起三锁面 |
| `l0-skeleton` | l0-skeleton.mjs | L0 | L0 骨架静态锁（node --check 全脚本 / 工具面 / hooks.json 事件集 / 版本桩） | A-v041-R01 / M-07 / SB09 / B07 |
| `lint-manifest` | lint-manifest.mjs | L0 | 发版 lint：manifest 约定路径/引用存在/版本三方一致 + 文档卡同步锁 + 套件结构锁 | LM-01..05 |
| `po-static` | po-static.mjs | L1 | PO 提示词工程不变量静态锁（章号/掩码补偿/尾块钉）+ v1.2 D11 与 DESBAN 钉组 | A-v0110-M10 / W4 族 / A-v0120-D11 / A-v0120-DESBAN |
| `probe-caps` | probe-caps.mjs | L1 | probe 四动作帽语义机制化（第 11 号工具，上下文经济第二支柱） | A-v060-PROBE |
| `root-contract` | root-contract.mjs | L1 | root-id 契约行为矩阵（五脚本 verbatim twin + stop-check 镜像 + 祖先回退） | P1..P10 / S1..S5 / W24-RC |
| `sb-normalize` | sb-normalize.mjs | L1 | 沙箱 materialize/越界检出/discard 零损伤 + F1 归一化黑盒 | SB01 / SB02 / SB05 / M01 / M02 |
| `sentinel-teardown` | sentinel-teardown.mjs | L1 | 哨兵 v2.1 待命制 + 寿命轮换选举（黑盒加速参数驱动）+ v1.2 M9-1 scoping/复活九腿 | T1..T4 / T12 / A-v0120-SCP·REV |
| `twin-lock` | twin-lock.mjs | L1 | 五文件 twin 函数行为矩阵锁 + VALUE_TWINS 异名值 twin 值锁 + 内存副本负例腿 | A-v0120-TW |
| `typed-dispatch-docs` | typed-dispatch-docs.mjs | L1 | typed 派发文档在位防回退 + 到期回收机制载体 + 角色面扩域 | V6-63 / V6-64 / A-COMPAT / A-ROLE |
| `watcher-core` | watcher-core.mjs | L1 | watcher 守护进程纯逻辑（模板/分类/降级树/频控/脱敏自检；ws 层全 mock 零生产中继） | v0.7 W1 族（W/WB/WS/WAKE） |
| `watcher-shim` | watcher-shim.mjs | L1 | relay shim（SHIM-01..04 + W-RESP；直连面回归） | A-v0100-SHIM / W-RESP |
