// @module crv6-statemachine
/*!
 * suites/crv6-statemachine.mjs —— v0.6 状态机 suite（A1 bootstrap：SM-08；A4 波增例 SM-01..07/P2P-01）
 * （薄入口：断言实现体已拆入 ./crv6-statemachine/ 子目录模块，本文件只做共享上下文构造与
 *   按序调度；run-all 注册、SUITE 摘要行格式与断言总数契约不变。）
 *
 * 覆盖断言组：
 *   A-v060-SM-01/02（V6-11 closed 双门：采信侧 isGreenClosed = qa.verdict==="pass"（A3 qa 结构体对齐）
 *     ∨ pack.sandbox.applied_at；写入侧 close_confirmed:true 且 drafted 禁直达；sandbox_apply 直改不受限）
 *   A-v060-SM-03/04/05（V6-20 ALLOWED_TRANSITIONS 白名单矩阵回归、终态复活 reopen:true+note、
 *     跨迁移清 ack、→running 仅 claim 可达、内部写者 opts.internal 旁路）
 *   A-v060-SM-06/07（V6-21 回收扩容：有 claim 且租约过期即回收（终态豁免）；running/dispatched→ready、
 *     blocked/question 保状态；answer 对 owner=null 翻 ready，池工可立即再领取）
 *   A-v060-SM-08（V6-22 closed 拒改板 report 响应机读语义——A1 壳六检查点保真，夹具改走合法迁移）
 *   A-v060-P2P-01（token-P2P 契约基线引用：行为面由 crv5-auth AUTH-04/05/06 全绿承载，此处静态锚）
 *   A-v070-P2P-01..06（v0.7 V7-02 施工，W-A findings §3 断言草案为底，DESIGN §4.4 三裁决定案）：
 *     01 边界一（错/缺 token 拒+档内与响应无 token 字样）；02 边界二（非 to 侧拒+提问方 mission
 *     除 timeline echo 外逐字段不变）；03 边界三（双方 timeline 回放+档全文可溯）；04 失效面
 *     （target 不存在/终态/非持有者即错不建档+TTL 过期 expired+双 echo）；05 ask 前置态限
 *     blocked/question；06 哨兵活性语义不回归（lastActivityMs 计任意 timeline 事件，echo 自动计入）。
 *   WB-SRV-a..g（v1.1.1 W-B 完成即唤队列：headless done→事件恰一落内容形状锁/非 headless 与
 *     milestone 零事件/毒丸容忍/认领残留 acquired_at 可识别/并发双写两事件两文件/dispatch
 *     lock_hold_ms<2000ms；权威=v1.1.1-wake-PLAN-draft + grill#wake 七答）
 *   FA-1..5（v1.1.1-FA dispatch headless 修复：无 env 对不播种+即时桩现形 session_id/
 *     播种副本落盘+defaultModelSelection 形状锁+复制体 enabled 翻转+真实配置字节不动/
 *     model 入参非 api-key 负例不静默换模/秒死注入→ok:false+error+hint/慢启动→
 *     session_pending 契约保持；权威=v1.1.1-dispatch-bug-findings + bundle 考古锚）
 *   转录自 W-A1 §1 各断言草案；suite 注册行归主控 G 胶水波收口（run-all REGISTRY）。
 *
 * 运行方式：node tests/suites/crv6-statemachine.mjs [--root <临时根>]
 * 前置：node >= 20；无 git 依赖。
 *
 * 模块布局（断言族 → ./crv6-statemachine/；执行顺序=下方 await 顺序，与拆前单文件顺序一致）：
 *   ctx.mjs            共享上下文工厂（Checker/临时根/主 server/夹具助手，mkClaim claimSeq 有态）
 *   sm-closed-gate.mjs SM-08 + SM-01 + SM-02（V6-11 closed 双门族）
 *   sm-recycle.mjs     SM-06 + SM-07（V6-21 回收扩容族）
 *   sm-transitions.mjs SM-03 + SM-04 + SM-05（V6-20 迁移矩阵族）
 *   sm-dispatch-gate.mjs GA-1..3（v1.3 WG G-a：dispatch 状态闸收 ready——解锁直派/回归臂/仍拒臂）
 *   p2p.mjs            P2P-01 静态锚 + A-v070-P2P-01..06（P2P 直通仲裁）
 *   wake-queue.mjs     WB-SRV-a..g（v1.1.1 W-B 完成即唤队列；含 sWb2 隔离实例）
 *   dispatch-fa.mjs    FA-1..5（v1.1.1-FA dispatch headless 修复）+ 尾置 sleep(0) 兜底
 */
import { createCtx } from "./crv6-statemachine/ctx.mjs";
import { run as runSmClosedGate } from "./crv6-statemachine/sm-closed-gate.mjs";
import { run as runSmRecycle } from "./crv6-statemachine/sm-recycle.mjs";
import { run as runSmTransitions } from "./crv6-statemachine/sm-transitions.mjs";
import { run as runSmDispatchGate } from "./crv6-statemachine/sm-dispatch-gate.mjs";
import { run as runP2p } from "./crv6-statemachine/p2p.mjs";
import { run as runWakeQueue } from "./crv6-statemachine/wake-queue.mjs";
import { run as runDispatchFa } from "./crv6-statemachine/dispatch-fa.mjs";

const ctx = createCtx();
const { ck, s, BASE } = ctx;

try {
  await runSmClosedGate(ctx); // SM-08 + SM-01 + SM-02（V6-11 closed 双门族）
  await runSmRecycle(ctx); // SM-06 + SM-07（V6-21 回收扩容族）
  await runSmTransitions(ctx); // SM-03 + SM-04 + SM-05（V6-20 迁移矩阵族）
  await runSmDispatchGate(ctx); // GA-1..3（v1.3 WG G-a：dispatch 状态闸收 ready）
  await runP2p(ctx); // P2P-01 静态锚 + A-v070-P2P-01..06（P2P 直通仲裁）
  await runWakeQueue(ctx); // WB-SRV-a..g（v1.1.1 W-B 完成即唤队列）
  await runDispatchFa(ctx); // FA-1..5（v1.1.1-FA dispatch headless 修复）+ sleep(0) 兜底
} finally {
  s.close();
  BASE.cleanup();
}
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
