// @module crv6-resilience
/*!
 * suites/crv6-resilience.mjs —— v0.6 韧性 suite 薄入口（2026-11-01 巨型文件拆分）
 *
 * 拆分说明：断言体按功能块迁入 crv6-resilience/ 子目录模块——
 *   fixtures.mjs                共享夹具（Checker/临时根/工具函数/spool 种子 + harness 出口）
 *   scenarios-v06.mjs           场景 A–J（v0.6 韧性：A1 SG/SPL + A2 RES/HRV/ATW/GC/INJ）
 *   scenarios-v120-dispatch.mjs 场景 DSP（v1.2 M3-1 dispatch 三缺陷必修）
 *   scenarios-v120-nested.mjs   场景 NST（v1.2 M5-1 dispatch 组装出口 mode=nested）
 *   scenarios-v130-congestion.mjs 场景 CG（v1.3 W5 F-C8 播种拥塞运行时降级十臂）
 * 本文件仅按原顺序聚合执行并收尾（cleanup+summary+exit）；断言本体逐字搬运零改动，
 * run-all 注册与 SUITE 摘要行格式零变更（Checker 名保持 crv6-resilience）。
 *
 * 覆盖断言组：
 *   A-v060-SG-01..04（V6-36 safeSegment Windows 保留名/尾点黑名单，A1）
 *   A-v060-SPL-01..03（V6-49 readEventFile 坏件 .bad 隔离，A1）
 *   A-v060-RES-01..08（V6-26 坏板隔离 corrupt-<ts>+degraded 条件键 / V6-27 BOM 回归 /
 *     V6-28 leaseUntil 畸形兜底回收 lease_invalid）
 *   A-v060-HRV-01..04（V6-50 harvest 末条畸形尾窗回退 + 标量 note）
 *   A-v060-ATW-01..03（V6-48 原子写 prev 一代 + .recovered 回收 + prev 清扫）
 *   A-v060-GC-01..04（V6-51 启动 journal GC 30 天龄期）
 *   A-v060-INJ-02..04（V6-18 escapeDataLine 写入/渲染双侧 + LESSONS/CONTEXT 节头围栏 +
 *     DETAILS_MAX_CHARS=4000 存储帽）。转录自 W-A2 §2 各断言草案；ATW-01 沿 LOCK-03/04
 *   先例以「结构腿+可达行为腿」承接（rename 恒失败黑盒不可达，root-id 目录化探针触发
 *   fallback 路径）。suite 注册行归主控 G 胶水波收口（run-all REGISTRY）。
 *   A-v0120-DSP-01..08（v1.2 M3-1 W3 波：dispatch 三缺陷必修——Q1 播种两源快速失败
 *     model→dms〔O9=a level 原值直通；v1.2.3 W2 段③「首 api-key 回落」删除，
 *     DSP-02/03 改写钉快速失败＋rejected/guidance＋不 spawn，DS-05 钉其缺席〕
 *     +Q2 busy 闸三层兜底〔killed-index/
 *     fail() 补 index/超龄豁免 O10=a+hint 分叉〕+Q3b 死信摘要〔outcome/timed_out/
 *     exit_code〕+spawned_by_session 归因字段）。impl-plan §批1 M3-1 权威。
 *   A-v0120-NST-01..04（v1.2 M5-1 批 3 波：dispatch 组装出口 mode=nested——不 spawn
 *     返 {mission_id, token, prompt, pack_path} 四元组〔组包链复用 context_pack 物化〕+
 *     busy 闸板语义分叉〔nested 在飞=dispatched 无 worker 结果拒二次组装，不消费
 *     result-dir index；恢复=dispatched→drafted 合法腿〕+内嵌校验〔CONTRACT 三行/
 *     token 鉴权 p2pTokenGate 同语义/scope yolo 闸两形态同闸〕+纪律第 11 条自动携带+
 *     触发面② ensureSentinelFamily 接线）。impl-plan §批3 M5-1 权威（M-2 裁死
 *     NST=crv6-resilience 扩展）。-p 链零触碰底线：crv2-pack 字节基线+DSP 组全绿为证。
 *
 * 运行方式：node tests/suites/crv6-resilience.mjs [--root <临时根>]
 * 前置：node >= 20；无 git 依赖。
 */
import { ck, BASE } from "./crv6-resilience/fixtures.mjs";
import { runV06Scenarios } from "./crv6-resilience/scenarios-v06.mjs";
import { runV120DispatchScenarios } from "./crv6-resilience/scenarios-v120-dispatch.mjs";
import { runV120NestedScenarios } from "./crv6-resilience/scenarios-v120-nested.mjs";
import { runV130CongestionScenarios } from "./crv6-resilience/scenarios-v130-congestion.mjs";

await runV06Scenarios();
await runV120DispatchScenarios();
await runV120NestedScenarios();
await runV130CongestionScenarios();

BASE.cleanup();
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
